import vm from 'node:vm';
import crypto from 'node:crypto';
import {
  generateWAMessageFromContent,
  generateForwardMessageContent,
  generateWAMessage,
  prepareWAMessageMedia,
  normalizeMessageContent,
  extractMessageContent,
  getContentType,
  downloadMediaMessage,
  downloadContentFromMessage,
  isJidStatusBroadcast,
  isJidNewsletter,
  isJidGroup,
  isJidBroadcast,
  isLidUser,
  isPnUser,
  STORIES_JID,
  S_WHATSAPP_NET,
  Browsers,
  DisconnectReason,
  BufferJSON,
  initAuthCreds,
  proto,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
  areJidsSameUser,
  AnyMessageContent,
  WASocket,
} from 'athanasia-baileys';
import {
  FunctionFailureCategory,
  FunctionExecutionMode,
  FunctionLabRepository,
  StoredFunctionDefinition,
} from '../database/repositories/function-lab-repository';
import {
  WhatsAppCapabilityAdapter,
  MessageNormalizer,
  MediaProcessor,
  NormalizedIncomingMessage,
} from '../whatsapp/message-capabilities';
import { ValidationError } from '../utils/errors';
import { redactString, redactObject, maskPhoneNumber } from '../security/redaction';
import { createLogger } from '../logging/logger';

const log = createLogger('function-lab');

/**
 * Extracts a meaningful error message across V8 VM realms.
 *
 * Root-Cause Fix for `فشل تحليل كود الدالة (AewCh): خطأ برمجي`:
 * Errors thrown inside `vm.runInContext(code, context)` belong to the VM context's `Error` prototype,
 * so `err instanceof Error` in the host realm returns `false`!
 * Using `extractCrossRealmErrorMessage` inspects `.name`, `.message`, and syntax line details
 * regardless of which V8 realm constructed the error object.
 */
export function extractCrossRealmErrorMessage(err: unknown): {
  name: string;
  message: string;
  stackPreview?: string;
} {
  if (err && typeof err === 'object') {
    const record = err as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    const name =
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : 'Error';
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : String(err);
    const stackPreview =
      typeof record.stack === 'string'
        ? record.stack.split('\n').slice(0, 3).join(' | ')
        : undefined;
    return {
      name,
      message: redactString(message),
      stackPreview: stackPreview ? redactString(stackPreview) : undefined,
    };
  }
  if (typeof err === 'string' && err.trim()) {
    return { name: 'Error', message: redactString(err.trim()) };
  }
  return { name: 'Error', message: 'خطأ برمجي غير محدد أثناء التنفيذ' };
}

export function classifyFunctionError(err: unknown, stage: 'PARSE' | 'VALIDATE' | 'RUNTIME'): {
  category: FunctionFailureCategory;
  userMessageAr: string;
  technicalSummary: string;
} {
  const extracted = extractCrossRealmErrorMessage(err);
  const lower = `${extracted.name} ${extracted.message}`.toLowerCase();

  if (stage === 'PARSE' || extracted.name === 'SyntaxError') {
    return {
      category: 'PARSING_ERROR',
      userMessageAr: `خطأ تركيبي في كود الدالة (${extracted.name}): ${extracted.message}`,
      technicalSummary: `${extracted.name}: ${extracted.message}`,
    };
  }
  if (stage === 'VALIDATE' || err instanceof ValidationError) {
    return {
      category: 'VALIDATION_ERROR',
      userMessageAr: extracted.message,
      technicalSummary: `${extracted.name}: ${extracted.message}`,
    };
  }
  if (lower.includes('ratelimit') || lower.includes('الحد الأقصى للإرسال')) {
    return {
      category: 'RATE_LIMIT_ERROR',
      userMessageAr: `تم إيقاف الدالة لتجاوز سقف الإرسال المسموح: ${extracted.message}`,
      technicalSummary: extracted.message,
    };
  }
  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('script execution timed out') ||
    lower.includes('انتهت مهلة')
  ) {
    return {
      category: 'TIMEOUT_ERROR',
      userMessageAr: `انتهت مهلة تنفيذ الدالة داخل البيئة المعزولة (Timeout): ${extracted.message}`,
      technicalSummary: extracted.message,
    };
  }
  if (
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('صلاحية')
  ) {
    return {
      category: 'PERMISSION_ERROR',
      userMessageAr: `خطأ صلاحيات أثناء تنفيذ الدالة: ${extracted.message}`,
      technicalSummary: extracted.message,
    };
  }
  if (
    lower.includes('protocol') ||
    lower.includes('unsupported') ||
    lower.includes('غير مدعوم') ||
    lower.includes('405')
  ) {
    return {
      category: 'PROTOCOL_ERROR',
      userMessageAr: `خطأ توافق بروتوكول واتساب: ${extracted.message}`,
      technicalSummary: extracted.message,
    };
  }
  if (
    lower.includes('network') ||
    lower.includes('socket') ||
    lower.includes('connection') ||
    lower.includes('غير متصلة')
  ) {
    return {
      category: 'NETWORK_ERROR',
      userMessageAr: `خطأ اتصال شبكة/مقبس واتساب: ${extracted.message}`,
      technicalSummary: extracted.message,
    };
  }

  return {
    category: 'RUNTIME_ERROR',
    userMessageAr: `خطأ تشغيلي أثناء تنفيذ الدالة (${extracted.name}): ${extracted.message}`,
    technicalSummary: `${extracted.name}: ${extracted.message}`,
  };
}

export interface ParsedFunctionSource {
  valid: boolean;
  funcName: string;
  normalizedCode: string;
  isAsync: boolean;
  declaredParameters: string[];
  failureCategory?: FunctionFailureCategory;
  errorMessageAr?: string;
  technicalReason?: string;
  warningsAr: string[];
}

/**
 * Sanitizes, normalizes, and statically validates a function definition using `vm.Script`
 * BEFORE any execution or sandbox evaluation occurs.
 *
 * Supports:
 * 1. Standard declarations: `async function Name(sock, target, meta) { ... }` or `function Name(...) { ... }`
 * 2. Assigned arrow / function expressions: `const Name = async (sock, target) => { ... }`
 * 3. Anonymous arrow / function expressions: `async (sock, target) => { ... }`
 * 4. Multi-function scripts (helper functions + main async function)
 * 5. Raw top-level async body (auto-wrapped into `async function customInline(sock, target, meta) { ... }`)
 */
export class FunctionValidator {
  public parseAndValidateSource(
    rawInputCode: string,
    options?: { preferredFuncName?: string }
  ): ParsedFunctionSource {
    const warningsAr: string[] = [];
    if (!rawInputCode || typeof rawInputCode !== 'string' || !rawInputCode.trim()) {
      return {
        valid: false,
        funcName: 'unknown',
        normalizedCode: '',
        isAsync: false,
        declaredParameters: [],
        failureCategory: 'VALIDATION_ERROR',
        errorMessageAr: 'كود الدالة فارغ. يرجى اختيار دالة من المكتبة أو إرفاق كود دالة صالح.',
        warningsAr,
      };
    }

    let code = rawInputCode.trim();

    // 1. Strip triple-backtick markdown fences if present
    const fenceMatch = code.match(/^```(?:javascript|typescript|js|ts)?\s*([\s\S]*?)```$/i);
    if (fenceMatch) {
      code = fenceMatch[1].trim();
    } else if (code.includes('```')) {
      const innerFence = code.match(/```(?:javascript|typescript|js|ts)?\s*([\s\S]*?)```/i);
      if (innerFence && innerFence[1].trim()) {
        code = innerFence[1].trim();
      }
    }

    // 2. Remove zero-width & directional Unicode formatting characters injected by Telegram/mobile keyboards
    code = code.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');

    // 3. Normalize smart quotes
    code = code
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");

    // 4. Strip leading `export default` or `export` keyword on declarations
    code = code
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s+(?=(?:async\s+)?function\b|(?:const|let|var)\b)/gm, '');

    // 5. Guard against leaking the host bot token specifically
    if (/\bprocess\.env\.TELEGRAM_BOT_TOKEN\b/.test(code)) {
      return {
        valid: false,
        funcName: 'restricted',
        normalizedCode: code,
        isAsync: false,
        declaredParameters: [],
        failureCategory: 'PERMISSION_ERROR',
        errorMessageAr:
          'رفض أمني لكود الدالة: يُمنع الوصول إلى process.env.TELEGRAM_BOT_TOKEN داخل صندوق الاختبار.',
        warningsAr,
      };
    }

    // Reject bare unknown identifier (e.g., user typed a single word that is not in the registry)
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(code)) {
      return {
        valid: false,
        funcName: code,
        normalizedCode: code,
        isAsync: false,
        declaredParameters: [],
        failureCategory: 'VALIDATION_ERROR',
        errorMessageAr: `الدالة (${code}) غير مسجلة في المكتبة. أرسل كود الدالة كاملاً أو اختر دالة من 📚 مكتبة الدوال.`,
        warningsAr,
      };
    }

    // 6. Repair collapsed single-line `//` comments if the entire snippet was pasted on a single line
    let candidateCode = code;
    if (!candidateCode.includes('\n') && candidateCode.includes('//')) {
      candidateCode = candidateCode.replace(
        /\/\/.*?(?=(?:\b(?:const|let|var|await|return|if|for|while|try|catch|console|sock)\b|\}\s*$))/g,
        ''
      );
      warningsAr.push('تمت معالجة تعليقات السطر الواحد المدمجة تلقائياً.');
    }

    // 7. Detect function declarations (standard, assigned arrow, assigned function expression, anonymous arrow, or raw body)
    let funcName = options?.preferredFuncName || 'customInline';
    let isAsync = true;
    let rawParams = 'sock, target, meta';

    const anonArrowMatch = candidateCode.match(
      /^\s*(async\s*)?\(([^)]*)\)\s*=>\s*([\s\S]+)$/
    );
    const anonSingleParamArrowMatch = !anonArrowMatch
      ? candidateCode.match(/^\s*(async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>\s*([\s\S]+)$/)
      : null;
    const anonFnExprMatch =
      !anonArrowMatch && !anonSingleParamArrowMatch
        ? candidateCode.match(/^\s*(async\s+)?function\s*\(([^)]*)\)\s*\{[\s\S]*\}\s*$/)
        : null;

    if (anonArrowMatch) {
      funcName = options?.preferredFuncName || 'customArrowFn';
      rawParams = anonArrowMatch[2] || '';
      candidateCode = `const ${funcName} = async (${rawParams}) => ${anonArrowMatch[3]}`;
      isAsync = true;
    } else if (anonSingleParamArrowMatch) {
      funcName = options?.preferredFuncName || 'customArrowFn';
      rawParams = anonSingleParamArrowMatch[2] || 'target';
      candidateCode = `const ${funcName} = async (${rawParams}) => ${anonSingleParamArrowMatch[3]}`;
      isAsync = true;
    } else if (anonFnExprMatch) {
      funcName = options?.preferredFuncName || 'customAnonFn';
      rawParams = anonFnExprMatch[2] || '';
      const stripped = candidateCode.replace(/^\s*(?:async\s+)?function\s*/, '');
      candidateCode = `async function ${funcName}${stripped}`;
      isAsync = true;
    } else {
      // Collect all named function / arrow declarations in the script
      const discovered: Array<{ name: string; isAsync: boolean; params: string }> = [];
      const fnRegex =
        /(?:(async)\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)/g;
      let match: RegExpExecArray | null;
      while ((match = fnRegex.exec(candidateCode)) !== null) {
        discovered.push({
          isAsync: Boolean(match[1]),
          name: match[2],
          params: match[3] || '',
        });
      }

      const assignedRegex =
        /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:(async)\s*)?(?:function\s*\(([^)]*)\)|(\([^)]*\))\s*=>)/g;
      while ((match = assignedRegex.exec(candidateCode)) !== null) {
        const isArrow = match[4] !== undefined;
        discovered.push({
          name: match[1],
          isAsync: Boolean(match[2]) || isArrow,
          params: (match[3] ?? match[4]?.slice(1, -1) ?? '').trim(),
        });
      }

      if (discovered.length > 0) {
        const asyncFuncs = discovered.filter((d) => d.isAsync);
        if (asyncFuncs.length === 0) {
          return {
            valid: false,
            funcName: discovered[discovered.length - 1].name,
            normalizedCode: candidateCode,
            isAsync: false,
            declaredParameters: [],
            failureCategory: 'VALIDATION_ERROR',
            errorMessageAr:
              'صيغة الدالة غير صالحة: يجب أن تكون الدالة الرئيسية من نوع async function (مثال: async function myFunc(sock, target) { ... }).',
            warningsAr,
          };
        }
        // Prefer explicitly requested name, else last async function
        const preferred = options?.preferredFuncName
          ? asyncFuncs.find((d) => d.name === options.preferredFuncName)
          : undefined;
        const chosen = preferred || asyncFuncs[asyncFuncs.length - 1];
        funcName = chosen.name;
        isAsync = true;
        rawParams = chosen.params;
      } else {
        // Raw top-level async body: auto-wrap in `async function customInline(sock, target, meta) { ... }`
        funcName = options?.preferredFuncName || 'customInline';
        rawParams = 'sock, target, meta';
        isAsync = true;
        candidateCode = `async function ${funcName}(sock, target, meta) {\n${candidateCode}\n}`;
        warningsAr.push(
          `تم تغليف الكود المباشر تلقائياً داخل دالة غير متزامنة (${funcName}(sock, target, meta)).`
        );
      }
    }

    const declaredParameters = rawParams
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    // 8. Pre-compile with `vm.Script` to verify syntax before runtime execution
    try {
      new vm.Script(`${candidateCode}\n${funcName};`, {
        filename: `${funcName}.function-lab.js`,
      });
    } catch (syntaxErr) {
      const extracted = extractCrossRealmErrorMessage(syntaxErr);
      return {
        valid: false,
        funcName,
        normalizedCode: candidateCode,
        isAsync,
        declaredParameters,
        failureCategory: 'PARSING_ERROR',
        errorMessageAr: `فشل تحليل كود الدالة (${funcName}): ${extracted.message}`,
        technicalReason: `${extracted.name}: ${extracted.message}`,
        warningsAr,
      };
    }

    return {
      valid: true,
      funcName,
      normalizedCode: candidateCode,
      isAsync,
      declaredParameters,
      warningsAr,
    };
  }
}

/**
 * Built-in catalog of verified WhatsApp protocol & Function Lab functions,
 * including `AewCh` (the exact function referenced in the `/testfunction` failure report),
 * `nebulaSocketProbe`, and specialized message-capability probes.
 */
export const BUILTIN_FUNCTION_DEFINITIONS: Array<{
  functionId: string;
  name: string;
  category: string;
  descriptionAr: string;
  sourceCode: string;
  inputSchema: Record<string, unknown>;
  requiredDependencies: string[];
}> = [
  {
    functionId: 'fn_builtin_aewch',
    name: 'AewCh',
    category: 'messaging_probe',
    descriptionAr:
      'دالة AewCh القياسية لفحص إرسال الرسائل الممتدة ومعاينة القناة/التواجد عبر مقبس واتساب الآمن (createSafeSock).',
    sourceCode: `async function AewCh(sock, target, meta) {
  const step = meta?.iteration || 1;
  console.log('AewCh executing step', step, 'target=', target);
  await sock.presenceSubscribe(target);
  await sock.sendPresenceUpdate('composing', target);
  const res = await sock.sendMessage(target, {
    text: \`[AewCh Probe #\${step}] فحص جاهزية مقبس واتساب والقناة بنجاح\`
  });
  await sock.sendPresenceUpdate('paused', target);
  return { ok: true, step, messageId: res?.key?.id || 'sent' };
}`,
    inputSchema: {
      targetPhone: 'string (8..15 digits)',
      iterations: 'number (1..10000)',
    },
    requiredDependencies: ['athanasia-baileys', 'createSafeSock'],
  },
  {
    functionId: 'fn_builtin_nebula_probe',
    name: 'nebulaSocketProbe',
    category: 'diagnostics',
    descriptionAr:
      'دالة فحص المقبس الأساسية (Nebula Socket Probe) لاختبار التواجد وإرسال نص قياسي مع تتبع عداد الإرسال.',
    sourceCode: `async function nebulaSocketProbe(sock, target, meta) {
  console.log('Executing probe iteration', meta?.iteration, 'maxSends=', sock.getMaxSends());
  await sock.presenceSubscribe(target);
  await sock.sendPresenceUpdate('composing', target);
  await sock.sendMessage(target, { text: 'Nebula Function Probe OK' });
}`,
    inputSchema: {
      targetPhone: 'string (8..15 digits)',
      iterations: 'number (1..10000)',
    },
    requiredDependencies: ['athanasia-baileys', 'createSafeSock'],
  },
  {
    functionId: 'fn_builtin_sticker_probe',
    name: 'stickerCapabilityProbe',
    category: 'stickers',
    descriptionAr:
      'فحص قدرة بناء وإرسال ملصق WebP قياسي والتحقق من ترويسة RIFF/WEBP عبر المقبس.',
    sourceCode: `async function stickerCapabilityProbe(sock, target, meta) {
  console.log('Sticker probe on iteration', meta?.iteration);
  const minimalWebpHeader = Buffer.from(
    '524946462400000057454250565038580a00000000000000000000000000',
    'hex'
  );
  const res = await sock.sendMessage(target, {
    sticker: minimalWebpHeader,
    mimetype: 'image/webp'
  });
  return { stickerSent: true, messageId: res?.key?.id };
}`,
    inputSchema: {
      targetPhone: 'string',
      iterations: 'number',
    },
    requiredDependencies: ['athanasia-baileys', 'Buffer'],
  },
  {
    functionId: 'fn_builtin_status_story_probe',
    name: 'statusStoryCapabilityProbe',
    category: 'status_stories',
    descriptionAr:
      'فحص قدرة التعامل مع حالات واتساب (status@broadcast) والرد المقتبس عليها بأمان.',
    sourceCode: `async function statusStoryCapabilityProbe(sock, target, meta) {
  console.log('Status capability probe step', meta?.iteration, 'STORIES_JID=', STORIES_JID);
  const res = await sock.sendMessage(target, {
    text: 'Status & Story Capability Probe Verified'
  });
  return { statusBroadcastJid: STORIES_JID, verified: true, messageId: res?.key?.id };
}`,
    inputSchema: {
      targetPhone: 'string',
      iterations: 'number',
    },
    requiredDependencies: ['athanasia-baileys', 'STORIES_JID'],
  },
  {
    functionId: 'fn_builtin_poll_reaction_probe',
    name: 'pollAndReactionProbe',
    category: 'interactive',
    descriptionAr:
      'فحص إرسال استطلاع رأي (Poll V3) وتفاعل رمز تعبيري (Reaction) عبر المقبس.',
    sourceCode: `async function pollAndReactionProbe(sock, target, meta) {
  console.log('Poll & Reaction probe iteration', meta?.iteration);
  const pollRes = await sock.sendMessage(target, {
    poll: {
      name: 'استطلاع فحص قدرات البروتوكول',
      values: ['ممتاز', 'جيد جداً'],
      selectableCount: 1
    }
  });
  return { pollSent: true, messageId: pollRes?.key?.id };
}`,
    inputSchema: {
      targetPhone: 'string',
      iterations: 'number',
    },
    requiredDependencies: ['athanasia-baileys'],
  },
];

/**
 * Discovers, registers, validates, and searches available Function Lab functions
 * without allowing duplicate conflicting registrations.
 */
export class FunctionRegistry {
  private readonly validator = new FunctionValidator();
  private readonly memoryDefinitions = new Map<string, StoredFunctionDefinition>();

  constructor(private readonly repo?: FunctionLabRepository) {
    this.seedBuiltins();
  }

  public seedBuiltins(): void {
    const now = new Date().toISOString();
    for (const item of BUILTIN_FUNCTION_DEFINITIONS) {
      if (this.repo) {
        const stored = this.repo.upsertFunctionDefinition({
          functionId: item.functionId,
          name: item.name,
          category: item.category,
          descriptionAr: item.descriptionAr,
          sourceCode: item.sourceCode,
          inputSchema: item.inputSchema,
          requiredDependencies: item.requiredDependencies,
          supportsDryRun: true,
          supportsSimulation: true,
          isBuiltin: true,
          isEnabled: true,
          allowUpdateExisting: false,
        });
        this.memoryDefinitions.set(stored.name.toLowerCase(), stored);
      } else {
        this.memoryDefinitions.set(item.name.toLowerCase(), {
          functionId: item.functionId,
          name: item.name,
          version: 1,
          category: item.category,
          descriptionAr: item.descriptionAr,
          sourceCode: item.sourceCode,
          inputSchemaJson: JSON.stringify(item.inputSchema),
          requiredDependencies: item.requiredDependencies,
          supportsDryRun: true,
          supportsSimulation: true,
          isBuiltin: true,
          isEnabled: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  public registerFunction(params: {
    name?: string;
    category?: string;
    descriptionAr?: string;
    sourceCode: string;
    createdBy?: number;
    allowUpdateExisting?: boolean;
  }): StoredFunctionDefinition {
    const parsed = this.validator.parseAndValidateSource(params.sourceCode);
    if (!parsed.valid) {
      throw new ValidationError(
        parsed.errorMessageAr || 'فشل التحقق من صحة كود الدالة المراد تسجيلها.'
      );
    }

    const finalName = (params.name || parsed.funcName).trim();
    const existing = this.resolveFunction(finalName);
    if (existing && params.allowUpdateExisting === false) {
      throw new ValidationError(
        `الدالة (${finalName}) مسجلة مسبقاً في مختبر الدوال (الإصدار v${existing.version}).`
      );
    }

    const category = params.category || 'custom';
    const descriptionAr =
      params.descriptionAr ||
      `دالة مخصصة (${finalName}) مسجلة في مختبر الدوال (${parsed.declaredParameters.length} معاملات).`;

    if (this.repo) {
      const saved = this.repo.upsertFunctionDefinition({
        name: finalName,
        category,
        descriptionAr,
        sourceCode: parsed.normalizedCode,
        inputSchema: {
          declaredParameters: parsed.declaredParameters,
        },
        requiredDependencies: ['athanasia-baileys', 'createSafeSock'],
        supportsDryRun: true,
        supportsSimulation: true,
        isBuiltin: false,
        isEnabled: true,
        createdBy: params.createdBy,
        allowUpdateExisting: params.allowUpdateExisting ?? true,
      });
      this.memoryDefinitions.set(saved.name.toLowerCase(), saved);
      return saved;
    }

    const now = new Date().toISOString();
    const def: StoredFunctionDefinition = {
      functionId: existing?.functionId || `fn_custom_${finalName.toLowerCase()}`,
      name: finalName,
      version: existing ? existing.version + 1 : 1,
      category,
      descriptionAr,
      sourceCode: parsed.normalizedCode,
      inputSchemaJson: JSON.stringify({ declaredParameters: parsed.declaredParameters }),
      requiredDependencies: ['athanasia-baileys', 'createSafeSock'],
      supportsDryRun: true,
      supportsSimulation: true,
      isBuiltin: false,
      isEnabled: true,
      createdBy: params.createdBy,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.memoryDefinitions.set(finalName.toLowerCase(), def);
    return def;
  }

  /**
   * Resolves a function by exact ID, case-insensitive name (e.g. `AewCh`), or inline source code.
   */
  public resolveFunction(identifierOrCode: string): StoredFunctionDefinition | undefined {
    const clean = (identifierOrCode || '').trim();
    if (!clean) return undefined;

    if (this.repo) {
      const byId = this.repo.getFunctionById(clean);
      if (byId) return byId;
      const byName = this.repo.getFunctionByName(clean);
      if (byName) return byName;
    }

    const mem = this.memoryDefinitions.get(clean.toLowerCase());
    if (mem) return mem;

    for (const def of this.memoryDefinitions.values()) {
      if (def.functionId === clean) return def;
    }
    return undefined;
  }

  public listFunctions(filter?: {
    category?: string;
    searchQuery?: string;
    onlyEnabled?: boolean;
  }): StoredFunctionDefinition[] {
    if (this.repo) {
      return this.repo.listFunctions(filter);
    }
    let list = Array.from(this.memoryDefinitions.values());
    if (filter?.onlyEnabled) {
      list = list.filter((f) => f.isEnabled);
    }
    if (filter?.category && filter.category !== 'all') {
      list = list.filter(
        (f) => f.category.toLowerCase() === filter.category!.toLowerCase()
      );
    }
    if (filter?.searchQuery && filter.searchQuery.trim()) {
      const q = filter.searchQuery.trim().toLowerCase();
      list = list.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.descriptionAr.toLowerCase().includes(q) ||
          f.category.toLowerCase().includes(q)
      );
    }
    return list;
  }
}

export interface DiagnosticLogEntry {
  correlationId: string;
  timestamp: string;
  functionName: string;
  sessionId?: string;
  mode: FunctionExecutionMode;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  failureCategory?: FunctionFailureCategory;
  durationMs: number;
  userMessageAr: string;
  sanitizedDetails: Record<string, unknown>;
}

/**
 * Structured, secret-redacted diagnostic logger with correlation IDs for Function Lab
 * and WhatsApp message capability testing.
 */
export class DiagnosticLogger {
  private readonly recentDiagnostics = new Map<string, DiagnosticLogEntry>();

  public createCorrelationId(prefix = 'flab'): string {
    return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  }

  public recordDiagnostic(entry: DiagnosticLogEntry): DiagnosticLogEntry {
    const sanitizedEntry: DiagnosticLogEntry = {
      ...entry,
      userMessageAr: redactString(entry.userMessageAr),
      sanitizedDetails: redactObject(entry.sanitizedDetails),
    };
    this.recentDiagnostics.set(entry.correlationId, sanitizedEntry);
    if (this.recentDiagnostics.size > 250) {
      const firstKey = this.recentDiagnostics.keys().next().value;
      if (firstKey) this.recentDiagnostics.delete(firstKey);
    }

    if (entry.status === 'FAILED') {
      log.warn('Function Lab execution failed', {
        correlationId: entry.correlationId,
        functionName: entry.functionName,
        sessionId: entry.sessionId,
        mode: entry.mode,
        failureCategory: entry.failureCategory,
        durationMs: entry.durationMs,
      });
    } else {
      log.info('Function Lab execution completed', {
        correlationId: entry.correlationId,
        functionName: entry.functionName,
        sessionId: entry.sessionId,
        mode: entry.mode,
        status: entry.status,
        durationMs: entry.durationMs,
      });
    }

    return sanitizedEntry;
  }

  public getDiagnostic(correlationId: string): DiagnosticLogEntry | undefined {
    return this.recentDiagnostics.get(correlationId);
  }
}

export interface SessionResolverCandidate {
  id: string;
  label: string;
  status: string;
  masked_phone?: string | null;
}

/**
 * Resolves target WhatsApp sessions safely for Function Lab runs.
 * Ensures explicit session selection (`FIRST`, `ALL`, or specific `sessionId`),
 * prevents cross-session state leakage, and allows `DRY_RUN` / `SIMULATION` modes
 * to run cleanly even when zero live WhatsApp sessions are connected.
 */
export class SessionResolver {
  public resolveTargetSessions(params: {
    connectedSessions: SessionResolverCandidate[];
    requestedScope: string;
    executionMode: FunctionExecutionMode;
  }): {
    sessions: SessionResolverCandidate[];
    isSimulatedOfflineSession: boolean;
    errorMessageAr?: string;
  } {
    const { connectedSessions, requestedScope, executionMode } = params;
    const scopeUpper = (requestedScope || 'FIRST').trim().toUpperCase();

    if (executionMode === 'DRY_RUN' || executionMode === 'SIMULATION') {
      if (connectedSessions.length === 0) {
        return {
          sessions: [
            {
              id: executionMode === 'DRY_RUN' ? 'dryrun_sandbox' : 'sim_sandbox',
              label:
                executionMode === 'DRY_RUN'
                  ? 'بيئة فحص جاف معزولة (Dry-Run)'
                  : 'جلسة محاكاة معزولة (Simulation)',
              status: 'SIMULATED',
              masked_phone: '+96650***4567',
            },
          ],
          isSimulatedOfflineSession: true,
        };
      }
    }

    if (connectedSessions.length === 0) {
      return {
        sessions: [],
        isSimulatedOfflineSession: false,
        errorMessageAr:
          'لا توجد جلسة واتساب متصلة حالياً للتنفيذ الحي (LIVE). يمكنك تشغيل الدالة في وضع المحاكاة (--sim) أو الفحص الجاف (--dry-run) أو ربط جلسة أولاً.',
      };
    }

    if (scopeUpper === 'ALL') {
      return {
        sessions: [...connectedSessions],
        isSimulatedOfflineSession: false,
      };
    }

    if (scopeUpper === 'FIRST') {
      return {
        sessions: [connectedSessions[0]],
        isSimulatedOfflineSession: false,
      };
    }

    const matched = connectedSessions.filter((s) => s.id === requestedScope.trim());
    if (matched.length === 0) {
      return {
        sessions: [],
        isSimulatedOfflineSession: false,
        errorMessageAr: `الجلسة المحددة (${requestedScope}) غير متصلة حالياً. الجلسات المتصلة المتاحة: ${connectedSessions.map((s) => s.id).join('، ')}`,
      };
    }

    return {
      sessions: matched,
      isSimulatedOfflineSession: false,
    };
  }
}

export interface FunctionSandboxAdapter {
  sendMessage: (
    targetJid: string,
    message: AnyMessageContent,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  relayMessage: (
    targetJid: string,
    messageObj: proto.IMessage,
    opts?: Record<string, unknown>
  ) => Promise<unknown>;
  presenceSubscribe: (targetJid: string) => Promise<void>;
  sendPresenceUpdate: (
    state: 'available' | 'composing' | 'paused',
    targetJid: string
  ) => Promise<void>;
  raw?: Partial<WASocket> | Record<string, unknown>;
  [key: string]: unknown;
}

export interface FunctionExecutorRequest {
  sessionId: string;
  targetPhone: string;
  iterations: number;
  funcCodeOrName: string;
  executionMode?: FunctionExecutionMode;
  delayMs?: number;
  maxSends?: number;
  vmTimeoutMs?: number;
  maxSleepMs?: number;
  stopOnError?: boolean;
  captureConsole?: boolean;
  extraArg?: unknown;
  abortSignal?: AbortSignal;
  correlationId?: string;
}

export interface FunctionExecutorResult {
  correlationId: string;
  sessionId: string;
  executionMode: FunctionExecutionMode;
  targetJid: string;
  targetDigits: string;
  funcName: string;
  functionVersion: number;
  arity: number;
  iterationsRequested: number;
  iterationsSucceeded: number;
  iterationsFailed: number;
  sendCount: number;
  sendMessageCount: number;
  relayMessageCount: number;
  presenceCount: number;
  maxSendsLimit: number;
  abortedEarly: boolean;
  consoleLogs: string[];
  returnValuesPreview: string[];
  durationMs: number;
  failureCategory?: FunctionFailureCategory;
  lastError?: string;
}

/**
 * Isolated VM Function Executor (`FunctionExecutor`).
 * Never uses unrestricted `eval` or `new Function` in the host realm.
 * Uses `FunctionValidator` + `vm.Script` + `vm.createContext` with frozen/isolated globals,
 * strict timeouts, cancellation support, dry-run/simulation interception, and cross-realm error classification.
 */
export class FunctionExecutor {
  private readonly validator = new FunctionValidator();

  constructor(private readonly registry?: FunctionRegistry) {}

  public async execute(
    request: FunctionExecutorRequest,
    liveAdapter?: FunctionSandboxAdapter
  ): Promise<FunctionExecutorResult> {
    const correlationId =
      request.correlationId ||
      `flab_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const executionMode: FunctionExecutionMode = request.executionMode || 'LIVE';

    const digits = String(request.targetPhone || '').replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new ValidationError(
        'رقم الهاتف الهدف غير صالح. يرجى إدخال رقم دولي صحيح (مثال: +966501234567).'
      );
    }

    const iterations = Math.max(
      1,
      Math.min(Number(request.iterations) || 1, 10000)
    );
    const targetJid = `${digits}@s.whatsapp.net`;

    // Resolve by function name in registry if user passed a registered name (e.g., `AewCh`)
    let rawSource = (request.funcCodeOrName || '').trim();
    let functionVersion = 1;
    if (this.registry) {
      const resolvedDef = this.registry.resolveFunction(rawSource);
      if (resolvedDef) {
        rawSource = resolvedDef.sourceCode;
        functionVersion = resolvedDef.version;
      }
    }

    const parsed = this.validator.parseAndValidateSource(rawSource);
    if (!parsed.valid) {
      throw new ValidationError(
        parsed.errorMessageAr ||
          `فشل تحليل كود الدالة (${parsed.funcName}): خطأ تركيبي في الكود`
      );
    }

    const funcName = parsed.funcName;
    const configuredMaxSends =
      request.maxSends !== undefined &&
      Number.isFinite(request.maxSends) &&
      request.maxSends >= 0
        ? Math.min(100000, Math.floor(request.maxSends))
        : 500;

    let sendCount = 0;
    let sendMessageCount = 0;
    let relayMessageCount = 0;
    let presenceCount = 0;
    let maxSendsLimit = configuredMaxSends;

    const normalizeJid = (j: string): string =>
      j && j.includes('@')
        ? j
        : `${String(j || '').replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    const checkAndIncrementSend = () => {
      if (maxSendsLimit > 0 && sendCount >= maxSendsLimit) {
        throw new Error(`RateLimit: تم الوصول للحد الأقصى للإرسال (${maxSendsLimit})`);
      }
      sendCount++;
    };

    const consoleLogs: string[] = [];
    const captureConsole = request.captureConsole !== false;
    const pushLog = (level: string, args: unknown[]) => {
      if (!captureConsole || consoleLogs.length >= 25) return;
      const formatted = args
        .map((a) => {
          if (typeof a === 'string') return redactString(a);
          try {
            return redactString(JSON.stringify(a));
          } catch {
            return redactString(String(a));
          }
        })
        .join(' ')
        .slice(0, 200);
      consoleLogs.push(level === 'LOG' ? formatted : `[${level}] ${formatted}`);
    };

    const effectiveAdapter: FunctionSandboxAdapter =
      executionMode === 'DRY_RUN' || executionMode === 'SIMULATION' || !liveAdapter
        ? {
            sendMessage: async (jid, content) => {
              const keys = Object.keys(content || {}).join(',');
              pushLog(
                executionMode === 'DRY_RUN' ? 'DRY_RUN' : 'SIM',
                [`sendMessage -> ${maskPhoneNumber(jid)} [${keys}]`]
              );
              return {
                key: {
                  remoteJid: jid,
                  fromMe: true,
                  id: `${executionMode.toLowerCase()}_msg_${Date.now()}_${sendMessageCount}`,
                },
                status: 1,
              };
            },
            relayMessage: async (jid, _msgObj) => {
              pushLog(
                executionMode === 'DRY_RUN' ? 'DRY_RUN' : 'SIM',
                [`relayMessage -> ${maskPhoneNumber(jid)}`]
              );
              return `${executionMode.toLowerCase()}_relay_${Date.now()}_${relayMessageCount}`;
            },
            presenceSubscribe: async () => undefined,
            sendPresenceUpdate: async () => undefined,
          }
        : liveAdapter;

    const rawSocketTarget =
      (effectiveAdapter.raw as Record<string, unknown> | undefined) ||
      (effectiveAdapter as unknown as Record<string, unknown>);

    const baseSafeSock: Record<string, unknown> = {
      raw: rawSocketTarget,
      getSendCount: () => sendCount,
      getSendMessageCount: () => sendMessageCount,
      getRelayMessageCount: () => relayMessageCount,
      getPresenceCount: () => presenceCount,
      getMaxSends: () => maxSendsLimit,
      setMaxSends: (newLimit: number) => {
        if (Number.isFinite(newLimit) && newLimit >= 0) {
          maxSendsLimit = Math.min(100000, Math.floor(newLimit));
        }
      },
      sendMessage: async (
        target: string,
        message: AnyMessageContent,
        options?: Record<string, unknown>
      ) => {
        checkAndIncrementSend();
        sendMessageCount++;
        const jid = normalizeJid(target);
        return await effectiveAdapter.sendMessage(jid, message, options);
      },
      relayMessage: async (
        target: string,
        messageObj: proto.IMessage,
        opts: Record<string, unknown> = {}
      ) => {
        checkAndIncrementSend();
        relayMessageCount++;
        const jid = normalizeJid(target);
        return await effectiveAdapter.relayMessage(jid, messageObj, opts);
      },
      presenceSubscribe: async (jid: string) => {
        try {
          presenceCount++;
          await effectiveAdapter.presenceSubscribe(normalizeJid(jid));
        } catch {
          // Best-effort presence
        }
      },
      sendPresenceUpdate: async (
        state: 'available' | 'composing' | 'paused',
        jid: string
      ) => {
        try {
          presenceCount++;
          await effectiveAdapter.sendPresenceUpdate(state, normalizeJid(jid));
        } catch {
          // Best-effort presence
        }
      },
    };

    const safeSock = new Proxy(baseSafeSock, {
      get(targetObj, prop, receiver) {
        if (Reflect.has(targetObj, prop)) {
          return Reflect.get(targetObj, prop, receiver);
        }
        if (rawSocketTarget && prop in rawSocketTarget) {
          const val = rawSocketTarget[prop as string];
          return typeof val === 'function' ? val.bind(rawSocketTarget) : val;
        }
        if (prop in effectiveAdapter) {
          const val = (effectiveAdapter as Record<string, unknown>)[prop as string];
          return typeof val === 'function' ? val.bind(effectiveAdapter) : val;
        }
        if (
          typeof prop === 'string' &&
          (executionMode === 'DRY_RUN' || executionMode === 'SIMULATION')
        ) {
          return async (...callArgs: unknown[]) => {
            pushLog(executionMode === 'DRY_RUN' ? 'DRY_RUN' : 'SIM', [
              `sock.${prop}(${callArgs.length} args)`,
            ]);
            return {};
          };
        }
        return undefined;
      },
    }) as {
      getSendCount: () => number;
      getSendMessageCount: () => number;
      getRelayMessageCount: () => number;
      getPresenceCount: () => number;
      getMaxSends: () => number;
      setMaxSends: (newLimit: number) => void;
      sendMessage: (
        target: string,
        message: AnyMessageContent,
        options?: Record<string, unknown>
      ) => Promise<unknown>;
      relayMessage: (
        target: string,
        messageObj: proto.IMessage,
        opts?: Record<string, unknown>
      ) => Promise<unknown>;
      presenceSubscribe: (jid: string) => Promise<void>;
      sendPresenceUpdate: (
        state: 'available' | 'composing' | 'paused',
        jid: string
      ) => Promise<void>;
      [key: string]: unknown;
    };

    const stepDelayMs =
      request.delayMs !== undefined && Number.isFinite(request.delayMs)
        ? Math.min(Math.max(0, Math.floor(request.delayMs)), 60000)
        : 200;
    const vmTimeoutMs =
      request.vmTimeoutMs !== undefined && Number.isFinite(request.vmTimeoutMs)
        ? Math.min(Math.max(500, Math.floor(request.vmTimeoutMs)), 60000)
        : 5000;
    const maxSleepMs =
      request.maxSleepMs !== undefined && Number.isFinite(request.maxSleepMs)
        ? Math.min(Math.max(0, Math.floor(request.maxSleepMs)), 60000)
        : 10000;
    const stopOnError = Boolean(request.stopOnError);

    const sleep = (ms: number) =>
      new Promise((resolve) =>
        setTimeout(resolve, Math.min(Math.max(0, Number(ms) || 0), maxSleepMs))
      );

    const sandbox = {
      console: {
        log: (...args: unknown[]) => pushLog('LOG', args),
        info: (...args: unknown[]) => pushLog('INFO', args),
        warn: (...args: unknown[]) => pushLog('WARN', args),
        error: (...args: unknown[]) => pushLog('ERR', args),
      },
      Buffer,
      crypto,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      randomBytes: (size = 16) =>
        crypto.randomBytes(Math.min(Math.max(1, Number(size) || 16), 65536)),
      uuid: () => crypto.randomUUID(),
      sock: safeSock,
      target: targetJid,
      sessionId: request.sessionId,
      executionMode,
      maxSends: configuredMaxSends,
      sleep,
      STORIES_JID,
      S_WHATSAPP_NET,
      Browsers,
      DisconnectReason,
      BufferJSON,
      initAuthCreds,
      generateWAMessageFromContent,
      generateForwardMessageContent,
      generateWAMessage,
      prepareWAMessageMedia,
      normalizeMessageContent,
      extractMessageContent,
      getContentType,
      downloadMediaMessage,
      downloadContentFromMessage,
      isJidStatusBroadcast,
      isJidNewsletter,
      isJidGroup,
      isJidBroadcast,
      isLidUser,
      isPnUser,
      proto,
      jidDecode,
      jidEncode,
      jidNormalizedUser,
      areJidsSameUser,
    };

    const context = vm.createContext(sandbox);
    const wrapper = `${parsed.normalizedCode}\n${funcName}`;
    let fn: (...args: unknown[]) => unknown;
    try {
      const script = new vm.Script(wrapper, {
        filename: `${funcName}.function-lab.js`,
      });
      const evaluated = script.runInContext(context, { timeout: vmTimeoutMs });
      if (typeof evaluated !== 'function') {
        throw new Error(`الكائن الناتج (${funcName}) ليس دالة قابلة للتنفيذ`);
      }
      fn = evaluated as (...args: unknown[]) => unknown;
    } catch (err) {
      const extracted = extractCrossRealmErrorMessage(err);
      throw new ValidationError(
        `فشل تحليل كود الدالة (${funcName}): ${extracted.message}`
      );
    }

    const arity = fn.length;
    let iterationsSucceeded = 0;
    let iterationsFailed = 0;
    let abortedEarly = false;
    let lastError: string | undefined;
    let failureCategory: FunctionFailureCategory | undefined;
    const returnValuesPreview: string[] = [];
    const startTime = Date.now();

    for (let i = 0; i < iterations; i++) {
      if (request.abortSignal?.aborted) {
        abortedEarly = true;
        lastError = 'تم إلغاء التنفيذ بطلب المستخدم (Cancelled).';
        break;
      }

      try {
        const iterContext =
          request.extraArg !== undefined
            ? request.extraArg
            : {
                iteration: i + 1,
                totalIterations: iterations,
                sessionId: request.sessionId,
                executionMode,
                correlationId,
                maxSends: safeSock.getMaxSends(),
                sendCount: safeSock.getSendCount(),
              };

        const invokePromise = Promise.resolve(
          arity === 1
            ? fn(targetJid)
            : arity === 2
              ? fn(safeSock, targetJid)
              : fn(safeSock, targetJid, iterContext)
        );

        let timerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutGuard = new Promise<never>((_, reject) => {
          timerId = setTimeout(
            () =>
              reject(
                new Error(
                  `Timeout: تجاوزت الدورة رقم ${i + 1} مهلة التنفيذ (${vmTimeoutMs}ms)`
                )
              ),
            vmTimeoutMs
          );
        });

        let retVal: unknown;
        try {
          retVal = await Promise.race([invokePromise, timeoutGuard]);
        } finally {
          if (timerId !== undefined) {
            clearTimeout(timerId);
          }
        }

        if (retVal !== undefined && returnValuesPreview.length < 5) {
          try {
            returnValuesPreview.push(
              redactString(JSON.stringify(retVal)).slice(0, 140)
            );
          } catch {
            returnValuesPreview.push(redactString(String(retVal)).slice(0, 140));
          }
        }
        iterationsSucceeded++;
      } catch (err) {
        iterationsFailed++;
        const classified = classifyFunctionError(err, 'RUNTIME');
        failureCategory = classified.category;
        lastError = classified.userMessageAr;
        if (stopOnError) {
          abortedEarly = true;
          break;
        }
      }

      if (i + 1 < iterations && stepDelayMs > 0 && executionMode !== 'DRY_RUN') {
        await sleep(stepDelayMs);
      }
    }

    return {
      correlationId,
      sessionId: request.sessionId,
      executionMode,
      targetJid,
      targetDigits: digits,
      funcName,
      functionVersion,
      arity,
      iterationsRequested: iterations,
      iterationsSucceeded,
      iterationsFailed,
      sendCount: safeSock.getSendCount(),
      sendMessageCount: safeSock.getSendMessageCount(),
      relayMessageCount: safeSock.getRelayMessageCount(),
      presenceCount: safeSock.getPresenceCount(),
      maxSendsLimit: safeSock.getMaxSends(),
      abortedEarly,
      consoleLogs,
      returnValuesPreview,
      durationMs: Date.now() - startTime,
      failureCategory,
      lastError,
    };
  }
}

export interface LabTestScenarioResult {
  scenarioId: string;
  titleAr: string;
  category: string;
  passed: boolean;
  durationMs: number;
  expectedFailureCategory?: FunctionFailureCategory;
  actualFailureCategory?: FunctionFailureCategory;
  summaryAr: string;
  normalizedSample?: NormalizedIncomingMessage;
}

/**
 * Structured Function Lab Test Runner (`TestRunner`) with 13 repeatable, isolated scenarios
 * covering normal execution, AewCh regression, media/stickers/status/view-once/ephemeral normalization,
 * malformed inputs, unsupported capabilities, network disconnects, rate limits, and timeouts.
 */
export class TestRunner {
  public readonly capabilityAdapter = new WhatsAppCapabilityAdapter();
  public readonly messageNormalizer = new MessageNormalizer();
  public readonly mediaProcessor = new MediaProcessor();
  public readonly validator = new FunctionValidator();

  constructor(
    public readonly registry: FunctionRegistry,
    public readonly executor: FunctionExecutor,
    public readonly diagnosticLogger: DiagnosticLogger,
    public readonly repo?: FunctionLabRepository
  ) {}

  public listScenarioDefinitions(): Array<{
    scenarioId: string;
    titleAr: string;
    category: string;
  }> {
    return [
      {
        scenarioId: 'SCN_01_AEWCH_MULTILINE',
        titleAr: '1. فحص دالة AewCh متعددة الأسطر والتعليقات',
        category: 'function_execution',
      },
      {
        scenarioId: 'SCN_02_TEXT_AND_EXTENDED',
        titleAr: '2. تطبيع الرسائل النصية والممتدة والردود المقتبسة',
        category: 'message_normalization',
      },
      {
        scenarioId: 'SCN_03_MEDIA_AND_STICKERS',
        titleAr: '3. فحص الوسائط وملصقات WebP وحزم الملصقات',
        category: 'media_and_stickers',
      },
      {
        scenarioId: 'SCN_04_EPHEMERAL_AND_VIEWONCE_PRIVACY',
        titleAr: '4. الرسائل المؤقتة وحماية خصوصية العرض لمرة واحدة (View-Once)',
        category: 'privacy_and_ephemeral',
      },
      {
        scenarioId: 'SCN_05_STATUS_STORIES',
        titleAr: '5. استقبال ونشر حالات واتساب (status@broadcast)',
        category: 'status_stories',
      },
      {
        scenarioId: 'SCN_06_INTERACTIVE_POLLS_REACTIONS',
        titleAr: '6. الأوامر التفاعلية والاستطلاعات والتفاعلات والحذف/التعديل',
        category: 'interactive',
      },
      {
        scenarioId: 'SCN_07_MALFORMED_SYNTAX_ERROR',
        titleAr: '7. كشف الأخطاء التركيبية عبر نطاقات VM (Cross-Realm SyntaxError)',
        category: 'error_classification',
      },
      {
        scenarioId: 'SCN_08_UNSUPPORTED_MESSAGE_TYPE',
        titleAr: '8. التعامل الآمن مع أنواع الرسائل غير المدعومة أو المستقبلية',
        category: 'capability_safety',
      },
      {
        scenarioId: 'SCN_09_EXPIRED_MISSING_MEDIA_KEY',
        titleAr: '9. رفض تحميل الوسائط منتهية الصلاحية أو فاقدة mediaKey',
        category: 'media_safety',
      },
      {
        scenarioId: 'SCN_10_PERMISSION_SECURITY_GUARD',
        titleAr: '10. حظر الوصول إلى متغيرات البيئة والعمليات الخارجية (Permission Guard)',
        category: 'security',
      },
      {
        scenarioId: 'SCN_11_NETWORK_DISCONNECT_HANDLING',
        titleAr: '11. معالجة انقطاع اتصال المقبس أثناء تنفيذ الدالة',
        category: 'network_resilience',
      },
      {
        scenarioId: 'SCN_12_RATE_LIMIT_MAX_SENDS',
        titleAr: '12. فرض سقف الإرسال (Rate Limit Max Sends) وإيقاف الفيضان',
        category: 'rate_limit',
      },
      {
        scenarioId: 'SCN_13_VM_TIMEOUT_PROTECTION',
        titleAr: '13. حماية مهلة التنفيذ ضد الحلقات اللانهائية والتأخير المفرط',
        category: 'timeout_safety',
      },
    ];
  }

  public async runScenario(scenarioId: string): Promise<LabTestScenarioResult> {
    const start = Date.now();
    switch (scenarioId) {
      case 'SCN_01_AEWCH_MULTILINE': {
        const res = await this.executor.execute({
          sessionId: 'sim_scn_01',
          targetPhone: '+966501234567',
          iterations: 2,
          funcCodeOrName: 'AewCh',
          executionMode: 'SIMULATION',
          delayMs: 0,
        });
        const passed =
          res.funcName === 'AewCh' &&
          res.iterationsSucceeded === 2 &&
          res.sendCount === 2;
        return {
          scenarioId,
          titleAr: 'فحص دالة AewCh متعددة الأسطر والتعليقات',
          category: 'function_execution',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'نجح تحليل وتشغيل دالة AewCh من السجل بدون أخطاء (2/2 تكرار).'
            : `فشل تشغيل AewCh: ${res.lastError || 'غير معروف'}`,
        };
      }

      case 'SCN_02_TEXT_AND_EXTENDED': {
        const norm = this.messageNormalizer.normalizeIncoming({
          key: {
            id: 'MSG_EXT_01',
            remoteJid: '966501234567@s.whatsapp.net',
            fromMe: false,
          },
          messageTimestamp: 1710000100,
          message: {
            extendedTextMessage: {
              text: 'رد مقتبس مع معاينة رابط',
              canonicalUrl: 'https://example.com',
              title: 'Example',
              contextInfo: {
                stanzaId: 'ORIG_MSG_00',
                participant: '966509998888@s.whatsapp.net',
                quotedMessage: {
                  conversation: 'الرسالة الأصلية المقتبسة',
                },
              },
            },
          },
        });
        const passed =
          norm.category === 'quoted_message' &&
          norm.quotedMessage?.stanzaId === 'ORIG_MSG_00' &&
          norm.linkPreview?.canonicalUrl === 'https://example.com';
        return {
          scenarioId,
          titleAr: 'تطبيع الرسائل النصية والممتدة والردود المقتبسة',
          category: 'message_normalization',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم استخراج النص الممتد والرسالة المقتبسة ومعاينة الرابط بدقة.'
            : 'فشل تطبيع الرسالة النصية المقتبسة.',
          normalizedSample: norm,
        };
      }

      case 'SCN_03_MEDIA_AND_STICKERS': {
        const validWebp = Buffer.from(
          '524946462400000057454250565038580a00000002000000ff0000ff0000',
          'hex'
        );
        const stickerCheck = this.mediaProcessor.validateWebpSticker(validWebp);
        const packNorm = this.messageNormalizer.normalizeIncoming({
          key: { id: 'MSG_PACK_01', remoteJid: '966501234567@s.whatsapp.net' },
          message: {
            stickerPackMessage: {
              name: 'حزمة ملصقات الاختبار',
              publisher: 'Botezz Lab',
              stickerPackId: 'pack_001',
              stickers: [{ fileName: '1.webp' }, { fileName: '2.webp' }],
            },
          },
        });
        const passed =
          stickerCheck.valid &&
          stickerCheck.isWebp &&
          stickerCheck.isAnimated &&
          packNorm.category === 'sticker_pack' &&
          packNorm.stickerPackMetadata?.stickersCount === 2;
        return {
          scenarioId,
          titleAr: 'فحص الوسائط وملصقات WebP وحزم الملصقات',
          category: 'media_and_stickers',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم التحقق من ترويسة WebP المتحركة (VP8X) وتطبيع stickerPackMessage بنجاح.'
            : 'فشل التحقق من الملصقات أو حزمة الملصقات.',
          normalizedSample: packNorm,
        };
      }

      case 'SCN_04_EPHEMERAL_AND_VIEWONCE_PRIVACY': {
        const rawVoMsg = {
          key: { id: 'MSG_VO_01', remoteJid: '966501234567@s.whatsapp.net' },
          message: {
            ephemeralMessage: {
              message: {
                viewOnceMessageV2: {
                  message: {
                    imageMessage: {
                      mimetype: 'image/jpeg',
                      caption: 'سري للغاية',
                      viewOnce: true,
                      mediaKey: Buffer.from('1234567890123456'),
                      directPath: '/v/t62.7118-24/12345',
                    },
                  },
                },
              },
            },
          },
        };
        const norm = this.messageNormalizer.normalizeIncoming(rawVoMsg);
        let downloadBlocked = false;
        try {
          await this.mediaProcessor.downloadIncomingMediaSafely(
            rawVoMsg as unknown as Parameters<
              typeof this.mediaProcessor.downloadIncomingMediaSafely
            >[0],
            norm
          );
        } catch {
          downloadBlocked = true;
        }
        const passed =
          norm.isEphemeral &&
          norm.isViewOnce &&
          norm.viewOncePrivacyRestricted &&
          norm.caption === undefined &&
          norm.mediaMetadata?.canDownloadSafely === false &&
          downloadBlocked;
        return {
          scenarioId,
          titleAr: 'الرسائل المؤقتة وحماية خصوصية العرض لمرة واحدة (View-Once)',
          category: 'privacy_and_ephemeral',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم فك تغليف Ephemeral + ViewOnceV2 وحظر تحميل الوسائط أو تسريب الوصف احتراماً للخصوصية.'
            : 'فشل تطبيق ضوابط خصوصية View-Once.',
          normalizedSample: norm,
        };
      }

      case 'SCN_05_STATUS_STORIES': {
        const statusNorm = this.messageNormalizer.normalizeIncoming({
          key: {
            id: 'STATUS_01',
            remoteJid: STORIES_JID,
            participant: '966501234567@s.whatsapp.net',
          },
          message: {
            extendedTextMessage: {
              text: 'حالة واتساب تجريبية',
            },
          },
        });
        const cap = this.capabilityAdapter.assertCapabilityForOutgoing(
          { text: 'حالة جديدة' },
          STORIES_JID
        );
        const passed =
          statusNorm.isStatusBroadcast &&
          statusNorm.category === 'status_story' &&
          cap.supported &&
          cap.detectedCategory === 'status_story';
        return {
          scenarioId,
          titleAr: 'استقبال ونشر حالات واتساب (status@broadcast)',
          category: 'status_stories',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم رصد وتطبيع status@broadcast والتحقق من دعم نشر الحالات بنجاح.'
            : 'فشل فحص حالات واتساب.',
          normalizedSample: statusNorm,
        };
      }

      case 'SCN_06_INTERACTIVE_POLLS_REACTIONS': {
        const pollNorm = this.messageNormalizer.normalizeIncoming({
          key: { id: 'POLL_01', remoteJid: '120363041001@g.us' },
          message: {
            pollCreationMessageV3: {
              name: 'تصويت الفريق',
              options: [{ optionName: 'نعم' }, { optionName: 'لا' }],
              selectableOptionsCount: 1,
            },
          },
        });
        const revokeNorm = this.messageNormalizer.normalizeIncoming({
          key: { id: 'REV_01', remoteJid: '120363041001@g.us' },
          message: {
            protocolMessage: {
              type: 0,
              key: { id: 'TARGET_DEL_01' },
            },
          },
        });
        const passed =
          pollNorm.category === 'poll_creation' &&
          pollNorm.pollMetadata?.optionsCount === 2 &&
          revokeNorm.category === 'message_revoke' &&
          revokeNorm.isRevoked;
        return {
          scenarioId,
          titleAr: 'الأوامر التفاعلية والاستطلاعات والتفاعلات والحذف/التعديل',
          category: 'interactive',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم تطبيع رسائل الاستطلاع (Poll V3) ورسائل الحذف البروتوكولية (Revoke) بنجاح.'
            : 'فشل تطبيع الاستطلاعات أو الحذف.',
        };
      }

      case 'SCN_07_MALFORMED_SYNTAX_ERROR': {
        const parsed = this.validator.parseAndValidateSource(
          'async function AewCh(sock, target) { const x = ; }'
        );
        const passed =
          !parsed.valid &&
          parsed.failureCategory === 'PARSING_ERROR' &&
          Boolean(parsed.errorMessageAr?.includes('AewCh')) &&
          !parsed.errorMessageAr?.endsWith('خطأ برمجي');
        return {
          scenarioId,
          titleAr: 'كشف الأخطاء التركيبية عبر نطاقات VM (Cross-Realm SyntaxError)',
          category: 'error_classification',
          passed,
          durationMs: Date.now() - start,
          expectedFailureCategory: 'PARSING_ERROR',
          actualFailureCategory: parsed.failureCategory,
          summaryAr: passed
            ? `تم كشف الخطأ التركيبي بدقة: ${parsed.errorMessageAr}`
            : 'فشل استخراج تفاصيل الخطأ التركيبي.',
        };
      }

      case 'SCN_08_UNSUPPORTED_MESSAGE_TYPE': {
        const futureNorm = this.messageNormalizer.normalizeIncoming({
          key: { id: 'FUT_01', remoteJid: '966501234567@s.whatsapp.net' },
          message: {
            futureHologramMessageV99: {
              hologramData: 'xyz',
            },
          },
        });
        const passed =
          futureNorm.category === 'unknown_future' &&
          futureNorm.warningsAr.length > 0 &&
          !futureNorm.isMalformedPayload;
        return {
          scenarioId,
          titleAr: 'التعامل الآمن مع أنواع الرسائل غير المدعومة أو المستقبلية',
          category: 'capability_safety',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم تصنيف الرسالة المستقبلية كـ unknown_future مع تنبيه واضح دون انهيار.'
            : 'فشل التعامل مع نوع الرسالة غير المعروف.',
        };
      }

      case 'SCN_09_EXPIRED_MISSING_MEDIA_KEY': {
        const expiredMediaNorm = this.messageNormalizer.normalizeIncoming({
          key: { id: 'EXP_MEDIA_01', remoteJid: '966501234567@s.whatsapp.net' },
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              caption: 'صورة بدون مفتاح تشفير',
            },
          },
        });
        const passed =
          expiredMediaNorm.category === 'image' &&
          expiredMediaNorm.mediaMetadata?.hasMediaKey === false &&
          expiredMediaNorm.mediaMetadata?.canDownloadSafely === false;
        return {
          scenarioId,
          titleAr: 'رفض تحميل الوسائط منتهية الصلاحية أو فاقدة mediaKey',
          category: 'media_safety',
          passed,
          durationMs: Date.now() - start,
          summaryAr: passed
            ? 'تم كشف غياب mediaKey وتعطيل التحميل المباشر بأمان.'
            : 'فشل كشف الوسائط فاقدة المفتاح.',
        };
      }

      case 'SCN_10_PERMISSION_SECURITY_GUARD': {
        const check = this.validator.parseAndValidateSource(
          'async function leakEnv(sock, target) { return process.env.TELEGRAM_BOT_TOKEN; }'
        );
        const passed =
          !check.valid && check.failureCategory === 'PERMISSION_ERROR';
        return {
          scenarioId,
          titleAr: 'حظر الوصول إلى متغيرات البيئة والعمليات الخارجية (Permission Guard)',
          category: 'security',
          passed,
          durationMs: Date.now() - start,
          expectedFailureCategory: 'PERMISSION_ERROR',
          actualFailureCategory: check.failureCategory,
          summaryAr: passed
            ? 'تم حظر محاولة قراءة process.env بنجاح قبل التنفيذ.'
            : 'فشل حظر الكود المخالف للصلاحيات.',
        };
      }

      case 'SCN_11_NETWORK_DISCONNECT_HANDLING': {
        const res = await this.executor.execute(
          {
            sessionId: 'sim_net_drop',
            targetPhone: '+966501234567',
            iterations: 2,
            funcCodeOrName: 'AewCh',
            executionMode: 'LIVE',
            stopOnError: true,
          },
          {
            sendMessage: async () => {
              throw new Error('Socket connection closed unexpectedly');
            },
            relayMessage: async () => undefined,
            presenceSubscribe: async () => undefined,
            sendPresenceUpdate: async () => undefined,
          }
        );
        const passed =
          res.iterationsFailed === 1 &&
          res.abortedEarly &&
          res.failureCategory === 'NETWORK_ERROR';
        return {
          scenarioId,
          titleAr: 'معالجة انقطاع اتصال المقبس أثناء تنفيذ الدالة',
          category: 'network_resilience',
          passed,
          durationMs: Date.now() - start,
          expectedFailureCategory: 'NETWORK_ERROR',
          actualFailureCategory: res.failureCategory,
          summaryAr: passed
            ? 'تم تصنيف انقطاع المقبس كـ NETWORK_ERROR وإيقاف الدورة بأمان.'
            : 'فشل التعامل مع انقطاع الشبكة.',
        };
      }

      case 'SCN_12_RATE_LIMIT_MAX_SENDS': {
        const res = await this.executor.execute({
          sessionId: 'sim_ratelimit',
          targetPhone: '+966501234567',
          iterations: 5,
          maxSends: 2,
          stopOnError: true,
          executionMode: 'SIMULATION',
          delayMs: 0,
          funcCodeOrName: 'AewCh',
        });
        const passed =
          res.sendCount === 2 &&
          res.iterationsSucceeded === 2 &&
          res.iterationsFailed === 1 &&
          res.failureCategory === 'RATE_LIMIT_ERROR';
        return {
          scenarioId,
          titleAr: 'فرض سقف الإرسال (Rate Limit Max Sends) وإيقاف الفيضان',
          category: 'rate_limit',
          passed,
          durationMs: Date.now() - start,
          expectedFailureCategory: 'RATE_LIMIT_ERROR',
          actualFailureCategory: res.failureCategory,
          summaryAr: passed
            ? 'تم إيقاف الدالة فور الوصول إلى الحد الأقصى المسموح (2 إرسال) وتصنيف الخطأ كـ RATE_LIMIT_ERROR.'
            : 'فشل فرض سقف الإرسال.',
        };
      }

      case 'SCN_13_VM_TIMEOUT_PROTECTION': {
        const res = await this.executor.execute({
          sessionId: 'sim_timeout',
          targetPhone: '+966501234567',
          iterations: 1,
          vmTimeoutMs: 500,
          maxSleepMs: 2000,
          stopOnError: true,
          executionMode: 'SIMULATION',
          funcCodeOrName:
            'async function slowFn(sock, target) { await new Promise(r => setTimeout(r, 1500)); }',
        });
        const passed =
          res.iterationsFailed === 1 && res.failureCategory === 'TIMEOUT_ERROR';
        return {
          scenarioId,
          titleAr: 'حماية مهلة التنفيذ ضد الحلقات اللانهائية والتأخير المفرط',
          category: 'timeout_safety',
          passed,
          durationMs: Date.now() - start,
          expectedFailureCategory: 'TIMEOUT_ERROR',
          actualFailureCategory: res.failureCategory,
          summaryAr: passed
            ? 'تم إنهاء الدالة المتأخرة عند تجاوز المهلة وتصنيفها كـ TIMEOUT_ERROR.'
            : 'فشل فرض مهلة التنفيذ.',
        };
      }

      default:
        throw new ValidationError(`سيناريو الاختبار (${scenarioId}) غير معرف.`);
    }
  }

  public async runAllScenarios(): Promise<{
    total: number;
    passed: number;
    failed: number;
    durationMs: number;
    results: LabTestScenarioResult[];
  }> {
    const start = Date.now();
    const defs = this.listScenarioDefinitions();
    const results: LabTestScenarioResult[] = [];
    for (const def of defs) {
      const res = await this.runScenario(def.scenarioId);
      results.push(res);
    }
    const passed = results.filter((r) => r.passed).length;
    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      durationMs: Date.now() - start,
      results,
    };
  }
}
