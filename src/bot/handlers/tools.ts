import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';
import { SettingsRepository } from '../../database/repositories/settings-repository';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { buildBackCancelRow } from '../keyboards/main-menu';
import { formatSessionStatusArabic } from '../keyboards/session-menu';
import { formatRuntime, formatMemory } from './start';
import {
  validateWhatsAppChannelLink,
  validateIpAddress,
  validateShortlinkTargetUrl,
} from '../../security/validation';
import { toSafeArabicError } from '../../utils/errors';

export type ToolsInputStep =
  | 'NONE'
  | 'AWAITING_CHANNEL_LINK'
  | 'AWAITING_IP'
  | 'AWAITING_SHORTLINK'
  | 'AWAITING_TESTFUNCTION'
  | 'AWAITING_TF_MAX_SENDS'
  | 'AWAITING_TF_DELAY';

export const DEFAULT_SAMPLE_TEST_FUNCTION = `async function nebulaSocketProbe(sock, target, meta) {
  console.log('Executing probe iteration', meta?.iteration, 'maxSends=', sock.getMaxSends());
  await sock.presenceSubscribe(target);
  await sock.sendPresenceUpdate('composing', target);
  await sock.sendMessage(target, { text: 'Nebula Function Probe OK' });
}`;

export class ToolsHandler {
  private readonly inputStates = new Map<number, ToolsInputStep>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager,
    private readonly settingsRepo: SettingsRepository,
    private readonly auditRepo: AuditRepository
  ) {}

  public getStep(adminId: number): ToolsInputStep {
    return this.inputStates.get(adminId) || 'NONE';
  }

  public cancel(adminId: number): void {
    this.inputStates.delete(adminId);
  }

  public renderToolsMenu(): BotViewResponse {
    const tfCfg = this.settingsRepo.getTestFunctionConfig();
    const maxLabel = tfCfg.maxSends === 0 ? 'غير محدود (∞)' : `${tfCfg.maxSends}`;
    return {
      text:
        `🛠️ *الأدوات والفحص المتقدم (Tools & Diagnostics)*\n\n` +
        `اختر الأداة المطلوبة من الأزرار التفاعلية أدناه أو استخدم الأوامر السريعة مباشرة:\n` +
        `• \`/testfunction <phone> <count> [--max=N] [--delay=MS] [--session=ALL]\` — تشغيل واختبار دالة غير متزامنة (\`async function\`) مع تحكم كامل بحد الإرسال (\`الحالي: ${maxLabel}\`)\n` +
        `• \`/settfmax <N|0>\` — تحديد الحد الأقصى للإرسال يدوياً (أو \`0\` لبلا حد)\n` +
        `• \`/settfdelay <ms>\` — تحديد الفاصل الزمني بين التكرارات يدوياً\n` +
        `• \`/cekidch <link>\` — فحص قناة واتساب واستخراج معرفها وعدد المتابعين\n` +
        `• \`/ceksender\` — فحص مقابس جلسات واتساب والذاكرة المؤقتة (InMemoryStore)\n` +
        `• \`/cekall\` — تقرير شامل (المسؤول + الاشتراكات + الجلسات + موارد الخادم)\n` +
        `• \`/trackip <ip>\` — تتبع الموقع الجغرافي ومزود الخدمة لعنوان IPv4/IPv6\n` +
        `• \`/shortlink <url>\` — اختصار الروابط الطويلة عبر TinyURL\n` +
        `• \`/gempa\` — آخر نشرة رصد زلزالي (BMKG)\n` +
        `• \`/info\` — بطاقة معلومات الحساب والصلاحيات`,
      keyboard: [
        [
          {
            text: '🧪 مختبر الدوال المتقدم (/testfunction)',
            callbackData: 'tools:prompt_testfunction',
          },
          {
            text: '📡 فحص قناة واتساب (/cekidch)',
            callbackData: 'tools:prompt_channel',
          },
        ],
        [
          {
            text: '📱 فحص مقابس الإرسال (/ceksender)',
            callbackData: 'tools:ceksender',
          },
          {
            text: '📊 التقرير الشامل (/cekall)',
            callbackData: 'tools:cekall',
          },
        ],
        [
          {
            text: '🌍 تتبع عنوان IP (/trackip)',
            callbackData: 'tools:prompt_ip',
          },
          {
            text: '🔗 اختصار رابط (/shortlink)',
            callbackData: 'tools:prompt_shortlink',
          },
        ],
        [
          {
            text: '🪪 بطاقة الحساب (/info)',
            callbackData: 'tools:info',
          },
          {
            text: '🌋 رصد الزلازل (/gempa)',
            callbackData: 'tools:gempa',
          },
        ],
        [
          {
            text: '⭐ إدارة الاشتراكات',
            callbackData: 'settings:view_access',
          },
          { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
        ],
      ],
    };
  }

  public promptChannelLookup(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_CHANNEL_LINK');
    return {
      text:
        `📡 *فحص بيانات قناة واتساب (WhatsApp Channel Inspector)*\n\n` +
        `الرجاء إرسال رابط قناة واتساب المراد فحصها (مثال: \`https://whatsapp.com/channel/0029Va...\`):`,
      keyboard: [buildBackCancelRow('menu:tools')],
    };
  }

  public promptIpLookup(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_IP');
    return {
      text:
        `🌍 *تتبع وفحص عنوان IP (IPv4 / IPv6 Tracker)*\n\n` +
        `الرجاء إرسال عنوان IP المراد فحصه (مثال: \`8.8.8.8\` أو \`1.1.1.1\`):`,
      keyboard: [buildBackCancelRow('menu:tools')],
    };
  }

  public promptShortlink(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_SHORTLINK');
    return {
      text:
        `🔗 *اختصار الروابط الطويلة (URL Shortener)*\n\n` +
        `الرجاء إرسال الرابط الكامل الذي يبدأ بـ \`https://\` أو \`http://\`:`,
      keyboard: [buildBackCancelRow('menu:tools')],
    };
  }

  public promptTestFunction(adminId: number, noticeBanner?: string): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_TESTFUNCTION');
    const cfg = this.settingsRepo.getTestFunctionConfig();
    const maxSendsLabel =
      cfg.maxSends === 0
        ? 'غير محدود (∞ بلا سقف)'
        : `${cfg.maxSends.toLocaleString('en-US')} عملية`;
    const scopeLabel =
      cfg.sessionScope === 'ALL'
        ? 'جميع الجلسات المتصلة بالتوازي (ALL)'
        : cfg.sessionScope === 'FIRST'
          ? 'الجلسة المتصلة الأولى (FIRST)'
          : `جلسة محددة (${cfg.sessionScope})`;
    const errorPolicyLabel = cfg.stopOnError
      ? '🛑 إيقاف فوري عند أول خطأ (Stop on Error)'
      : '🔄 الاستمرار وتجاوز الأخطاء (Continue on Error)';

    return {
      text:
        (noticeBanner ? `${noticeBanner}\n━━━━━━━━━━━━━━━━━━\n` : '') +
        `🧪 *لوحة التحكم العميق في مختبر الدوال (/testfunction)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *إعدادات التنفيذ الحالية (قابلة للتعديل الفوري):*\n` +
        `• 📤 *الحد الأقصى للإرسال (Max Sends):* \`${maxSendsLabel}\`\n` +
        `• ⏱️ *التأخير بين التكرارات (Loop Delay):* \`${cfg.delayMs}ms\`\n` +
        `• 📡 *نطاق الجلسات (Session Scope):* \`${scopeLabel}\`\n` +
        `• 🛡️ *سياسة الأخطاء (Error Policy):* ${errorPolicyLabel}\n` +
        `• ⌛ *مهلة Sandbox VM:* \`${cfg.vmTimeoutMs}ms\` | *التقاط Console:* \`${cfg.captureConsole ? 'مفعل' : 'معطل'}\`\n\n` +
        `📌 *طرق التشغيل والتحكم المتقدم:*\n` +
        `1️⃣ *بالرد على رسالة كود أو إرسال سطر واحد:*\n` +
        `\`/testfunction +966501234567 5\`\n` +
        `2️⃣ *مع خيارات تحكم فورية (Inline Flags) تتجاوز الإعدادات الافتراضية:*\n` +
        `\`/testfunction +966501234567 10 --max=2500 --delay=100 --session=ALL --stop-on-error\`\n` +
        `3️⃣ *التحكم من داخل كود الدالة نفسها عبر \`sock\`:*\n` +
        `يمكن للدالة استدعاء \`sock.setMaxSends(5000)\` أو \`sock.setMaxSends(0)\` (بلا حد) أو \`console.log(...)\` أثناء التشغيل!`,
      keyboard: [
        [
          {
            text: '⚡ تشغيل دالة فحص تجريبية جاهزة',
            callbackData: 'tools:run_sample_testfunction',
          },
          {
            text: '🔢 تحديد حد الإرسال يدوياً',
            callbackData: 'tools:tf_prompt_max',
          },
        ],
        [
          {
            text: cfg.maxSends === 100 ? '✅ حد: 100' : 'حد: 100',
            callbackData: 'tools:tf_set_max:100',
          },
          {
            text: cfg.maxSends === 500 ? '✅ حد: 500' : 'حد: 500',
            callbackData: 'tools:tf_set_max:500',
          },
          {
            text: cfg.maxSends === 2000 ? '✅ حد: 2000' : 'حد: 2000',
            callbackData: 'tools:tf_set_max:2000',
          },
          {
            text: cfg.maxSends === 0 ? '✅ حد: ∞ مفتوح' : 'حد: ∞ مفتوح',
            callbackData: 'tools:tf_set_max:0',
          },
        ],
        [
          {
            text: cfg.delayMs === 0 ? '✅ تأخير: 0ms' : 'تأخير: 0ms',
            callbackData: 'tools:tf_set_delay:0',
          },
          {
            text: cfg.delayMs === 200 ? '✅ تأخير: 200ms' : 'تأخير: 200ms',
            callbackData: 'tools:tf_set_delay:200',
          },
          {
            text: cfg.delayMs === 1000 ? '✅ تأخير: 1000ms' : 'تأخير: 1000ms',
            callbackData: 'tools:tf_set_delay:1000',
          },
          {
            text: '⏱️ تأخير يدوي',
            callbackData: 'tools:tf_prompt_delay',
          },
        ],
        [
          {
            text:
              cfg.sessionScope === 'ALL'
                ? '📡 النطاق: كل الجلسات (ALL)'
                : '📡 النطاق: جلسة واحدة (FIRST)',
            callbackData: 'tools:tf_toggle_scope',
          },
          {
            text: cfg.stopOnError
              ? '🛑 عند الخطأ: إيقاف فوري'
              : '🔄 عند الخطأ: استمرار',
            callbackData: 'tools:tf_toggle_stop_on_error',
          },
        ],
        buildBackCancelRow('menu:tools'),
      ],
    };
  }

  public promptCustomMaxSends(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_TF_MAX_SENDS');
    const current = this.settingsRepo.getTestFunctionConfig().maxSends;
    return {
      text:
        `🔢 *تحديد الحد الأقصى لعمليات الإرسال يدوياً (Manual Max Sends)*\n\n` +
        `الحد الحالي: \`${current === 0 ? 'غير محدود (0)' : current}\`\n\n` +
        `أرسل الآن الرقم المطلوب للحد الأقصى لعمليات المقبس (\`sendMessage\` / \`relayMessage\`) في كل تشغيل:\n` +
        `• أرسل أي رقم بين \`1\` و \`100000\` (مثلاً: \`1500\` أو \`5000\`)\n` +
        `• أو أرسل \`0\` لإلغاء الحد الأقصى نهائياً (غير محدود ∞):`,
      keyboard: [buildBackCancelRow('tools:prompt_testfunction')],
    };
  }

  public promptCustomDelay(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_TF_DELAY');
    const current = this.settingsRepo.getTestFunctionConfig().delayMs;
    return {
      text:
        `⏱️ *تحديد مهلة التأخير بين التكرارات يدوياً (Iteration Delay)*\n\n` +
        `التأخير الحالي: \`${current}ms\`\n\n` +
        `أرسل الآن قيمة التأخير بالمللي ثانية بين \`0\` و \`60000\` (مثلاً: \`0\` للتنفيذ الفوري أو \`500\` لنصف ثانية):`,
      keyboard: [buildBackCancelRow('tools:prompt_testfunction')],
    };
  }

  public setMaxSendsConfig(adminId: number, rawValue: string): BotViewResponse {
    try {
      const clean = rawValue.trim().toLowerCase();
      const numeric =
        clean === 'unlimited' || clean === 'inf' || clean === 'infinity' || clean === '0'
          ? 0
          : Number(clean);
      const updated = this.settingsRepo.updateTestFunctionConfig({
        maxSends: numeric,
      });
      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'TESTFUNCTION_CONFIG_UPDATED',
        targetId: 'maxSends',
        outcome: 'SUCCESS',
        metadata: { maxSends: updated.maxSends },
      });
      const label =
        updated.maxSends === 0
          ? 'غير محدود (∞ بلا سقف)'
          : `${updated.maxSends.toLocaleString('en-US')} عملية`;
      return this.promptTestFunction(
        adminId,
        `✅ *تم تحديث الحد الأقصى للإرسال (Max Sends) إلى:* \`${label}\``
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return this.promptTestFunction(adminId, `⚠️ ${safeErr.userMessage}`);
    }
  }

  public setDelayConfig(adminId: number, rawValue: string): BotViewResponse {
    try {
      const numeric = Number(rawValue.trim().replace(/ms$/i, ''));
      const updated = this.settingsRepo.updateTestFunctionConfig({
        delayMs: numeric,
      });
      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'TESTFUNCTION_CONFIG_UPDATED',
        targetId: 'delayMs',
        outcome: 'SUCCESS',
        metadata: { delayMs: updated.delayMs },
      });
      return this.promptTestFunction(
        adminId,
        `✅ *تم تحديث التأخير بين التكرارات (Delay) إلى:* \`${updated.delayMs}ms\``
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return this.promptTestFunction(adminId, `⚠️ ${safeErr.userMessage}`);
    }
  }

  public setScopeConfig(adminId: number, rawScope: string): BotViewResponse {
    const clean = rawScope.trim();
    const normalized =
      clean.toUpperCase() === 'ALL'
        ? 'ALL'
        : clean.toUpperCase() === 'FIRST'
          ? 'FIRST'
          : clean;
    const updated = this.settingsRepo.updateTestFunctionConfig({
      sessionScope: normalized,
    });
    return this.promptTestFunction(
      adminId,
      `✅ *تم ضبط نطاق جلسات التنفيذ على:* \`${updated.sessionScope}\``
    );
  }

  public toggleScopeConfig(adminId: number): BotViewResponse {
    const current = this.settingsRepo.getTestFunctionConfig();
    const nextScope = current.sessionScope === 'ALL' ? 'FIRST' : 'ALL';
    this.settingsRepo.updateTestFunctionConfig({ sessionScope: nextScope });
    return this.promptTestFunction(
      adminId,
      `✅ *تم تبديل نطاق التنفيذ إلى:* \`${nextScope === 'ALL' ? 'جميع الجلسات المتصلة بالتوازي (ALL)' : 'الجلسة الأولى فقط (FIRST)'}\``
    );
  }

  public toggleStopOnErrorConfig(adminId: number): BotViewResponse {
    const current = this.settingsRepo.getTestFunctionConfig();
    const nextVal = !current.stopOnError;
    this.settingsRepo.updateTestFunctionConfig({ stopOnError: nextVal });
    return this.promptTestFunction(
      adminId,
      `✅ *تم تحديث سياسة الأخطاء إلى:* ${nextVal ? '🛑 إيقاف فوري عند أول خطأ' : '🔄 الاستمرار وتجاوز الأخطاء'}`
    );
  }

  public async handleGuidedInput(
    adminId: number,
    rawText: string,
    repliedText?: string
  ): Promise<BotViewResponse> {
    const step = this.getStep(adminId);
    if (step === 'AWAITING_CHANNEL_LINK') {
      this.cancel(adminId);
      return this.executeChannelLookup(adminId, rawText);
    }
    if (step === 'AWAITING_IP') {
      this.cancel(adminId);
      return this.executeIpLookup(adminId, rawText);
    }
    if (step === 'AWAITING_SHORTLINK') {
      this.cancel(adminId);
      return this.executeShortlink(adminId, rawText);
    }
    if (step === 'AWAITING_TF_MAX_SENDS') {
      this.cancel(adminId);
      return this.setMaxSendsConfig(adminId, rawText);
    }
    if (step === 'AWAITING_TF_DELAY') {
      this.cancel(adminId);
      return this.setDelayConfig(adminId, rawText);
    }
    if (step === 'AWAITING_TESTFUNCTION') {
      this.cancel(adminId);
      return this.executeTestFunction(adminId, rawText, repliedText);
    }
    return this.renderToolsMenu();
  }

  /**
   * Implements `/testfunction <phone> <count> [--max=N] [--delay=MS] [--timeout=MS] [--session=ALL|FIRST|id] [--stop-on-error]`
   * (with reply to `async function` or inline `async function`).
   * Supports manual/configurable `maxSends`, custom iteration delay, VM timeout, stop-on-error, console capture,
   * and single-session or multi-session parallel execution.
   */
  public async executeTestFunction(
    adminId: number,
    rawInput: string,
    repliedText?: string
  ): Promise<BotViewResponse> {
    try {
      const trimmed = rawInput.trim();
      const asyncIndex = trimmed.search(/async\s+function\s+/);

      let headerPart = trimmed;
      let inlineFuncCode = '';
      if (asyncIndex !== -1) {
        headerPart = trimmed.slice(0, asyncIndex).trim();
        inlineFuncCode = trimmed.slice(asyncIndex).trim();
      }

      const rawTokens = headerPart.split(/\s+/).filter(Boolean);
      const positionalTokens: string[] = [];
      const savedConfig = this.settingsRepo.getTestFunctionConfig();

      let effectiveMaxSends = savedConfig.maxSends;
      let effectiveDelayMs = savedConfig.delayMs;
      let effectiveVmTimeoutMs = savedConfig.vmTimeoutMs;
      let effectiveScope = savedConfig.sessionScope;
      let effectiveStopOnError = savedConfig.stopOnError;

      for (const tok of rawTokens) {
        if (tok.startsWith('--max=') || tok.startsWith('--max-sends=')) {
          const valRaw = tok.split('=')[1]?.trim().toLowerCase() || '';
          if (valRaw === '0' || valRaw === 'unlimited' || valRaw === 'inf') {
            effectiveMaxSends = 0;
          } else {
            const parsedMax = parseInt(valRaw, 10);
            if (!Number.isNaN(parsedMax) && parsedMax >= 0) {
              effectiveMaxSends = Math.min(100000, parsedMax);
            }
          }
        } else if (tok.startsWith('--delay=')) {
          const parsedDelay = parseInt(tok.split('=')[1] || '', 10);
          if (!Number.isNaN(parsedDelay) && parsedDelay >= 0) {
            effectiveDelayMs = Math.min(60000, parsedDelay);
          }
        } else if (tok.startsWith('--timeout=')) {
          const parsedTimeout = parseInt(tok.split('=')[1] || '', 10);
          if (!Number.isNaN(parsedTimeout) && parsedTimeout >= 500) {
            effectiveVmTimeoutMs = Math.min(60000, parsedTimeout);
          }
        } else if (tok.startsWith('--session=') || tok.startsWith('--scope=')) {
          const scopeVal = (tok.split('=')[1] || '').trim();
          if (scopeVal) {
            effectiveScope =
              scopeVal.toUpperCase() === 'ALL'
                ? 'ALL'
                : scopeVal.toUpperCase() === 'FIRST'
                  ? 'FIRST'
                  : scopeVal;
          }
        } else if (tok === '--stop-on-error') {
          effectiveStopOnError = true;
        } else if (tok === '--continue-on-error') {
          effectiveStopOnError = false;
        } else {
          positionalTokens.push(tok);
        }
      }

      if (positionalTokens.length < 2) {
        return {
          text:
            `🪧 *صيغة الأمر غير مكتملة (/testfunction)*\n\n` +
            `الصيغة المطلوبة:\n` +
            `\`/testfunction 966501234567 5\` (مع الرد على رسالة الدالة \`async function\`)\n` +
            `أو مع خيارات التحكم المتقدم:\n` +
            `\`/testfunction 966501234567 10 --max=2000 --delay=100 --session=ALL async function myFunc(sock, target) { ... }\``,
          keyboard: [
            [
              {
                text: '⚡ تشغيل دالة فحص تجريبية',
                callbackData: 'tools:run_sample_testfunction',
              },
              {
                text: '⚙️ لوحة إعدادات /testfunction',
                callbackData: 'tools:prompt_testfunction',
              },
            ],
            [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
          ],
        };
      }

      const targetRaw = positionalTokens[0];
      const parsedCount = parseInt(positionalTokens[1], 10);
      if (Number.isNaN(parsedCount) || parsedCount <= 0) {
        return {
          text: `❌ *عدد مرات التكرار (Jumlah) يجب أن يكون رقماً صحيحاً أكبر من الصفر.*`,
          keyboard: [
            [
              {
                text: '🔄 إعادة المحاولة',
                callbackData: 'tools:prompt_testfunction',
              },
              { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
            ],
          ],
        };
      }

      const iterations = Math.max(1, Math.min(parsedCount, 10000));
      const funcCode = (repliedText?.trim() || inlineFuncCode).trim();

      if (!funcCode) {
        return {
          text:
            `❌ *لم يتم العثور على كود الدالة (Reply dengan function)*\n\n` +
            `يرجى الرد (Reply) على رسالة تحتوي على \`async function name(sock, target) { ... }\` أو كتابة كود الدالة مباشرة بعد الرقم وعدد التكرارات.`,
          keyboard: [
            [
              {
                text: '⚡ تشغيل دالة فحص تجريبية',
                callbackData: 'tools:run_sample_testfunction',
              },
              {
                text: '🧪 لوحة إعدادات /testfunction',
                callbackData: 'tools:prompt_testfunction',
              },
            ],
          ],
        };
      }

      const connectedSessions = this.sessionManager.listConnectedSessions();
      if (connectedSessions.length === 0) {
        return {
          text:
            `⚠️ *لا توجد جلسة واتساب متصلة حالياً*\n` +
            `يتطلب تشغيل \`/testfunction\` وجود جلسة واتساب متصلة واحدة على الأقل لتمرير \`createSafeSock(sock)\`.`,
          keyboard: [
            [
              { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
              { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
            ],
          ],
        };
      }

      // Resolve target sessions according to effectiveScope ('FIRST' | 'ALL' | specific sessionId)
      const targetSessions =
        effectiveScope === 'ALL'
          ? connectedSessions
          : effectiveScope === 'FIRST'
            ? [connectedSessions[0]]
            : connectedSessions.filter((s) => s.id === effectiveScope);

      if (targetSessions.length === 0) {
        return {
          text:
            `⚠️ *الجلسة المحددة (\`${effectiveScope}\`) غير متصلة أو غير موجودة.*\n` +
            `الجلسات المتصلة المتاحة حالياً: ${connectedSessions.map((s) => `\`${s.id}\``).join('، ')}`,
          keyboard: [
            [
              {
                text: '⚙️ تعديل إعدادات /testfunction',
                callbackData: 'tools:prompt_testfunction',
              },
              { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
            ],
          ],
        };
      }

      const overallStart = Date.now();
      const results = await Promise.all(
        targetSessions.map(async (sess) => {
          const driver = this.sessionManager.getDriver(sess.id);
          const res = await driver.executeTestFunction({
            targetPhone: targetRaw,
            iterations,
            funcCode,
            maxSends: effectiveMaxSends,
            delayMs: effectiveDelayMs,
            vmTimeoutMs: effectiveVmTimeoutMs,
            stopOnError: effectiveStopOnError,
            captureConsole: savedConfig.captureConsole,
          });
          return { session: sess, res };
        })
      );
      const overallDurationMs = Date.now() - overallStart;

      const primary = results[0].res;
      const totalSucceeded = results.reduce(
        (acc, r) => acc + r.res.iterationsSucceeded,
        0
      );
      const totalRequested = results.reduce(
        (acc, r) => acc + r.res.iterationsRequested,
        0
      );
      const totalFailed = results.reduce((acc, r) => acc + r.res.iterationsFailed, 0);
      const totalSends = results.reduce((acc, r) => acc + r.res.sendCount, 0);
      const totalSendMsg = results.reduce(
        (acc, r) => acc + r.res.sendMessageCount,
        0
      );
      const totalRelayMsg = results.reduce(
        (acc, r) => acc + r.res.relayMessageCount,
        0
      );
      const totalPresence = results.reduce(
        (acc, r) => acc + r.res.presenceCount,
        0
      );
      const combinedLogs = results
        .flatMap((r) =>
          r.res.consoleLogs.map((line) =>
            results.length > 1 ? `[${r.session.id}] ${line}` : line
          )
        )
        .slice(0, 10);
      const lastError = results.find((r) => r.res.lastError)?.res.lastError;

      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'TOOL_TEST_FUNCTION',
        targetId: primary.targetJid,
        outcome: totalSucceeded > 0 ? 'SUCCESS' : 'FAILURE',
        metadata: {
          sessionScope: effectiveScope,
          sessionsCount: results.length,
          funcName: primary.funcName,
          arity: primary.arity,
          maxSendsLimit: primary.maxSendsLimit,
          delayMs: effectiveDelayMs,
          stopOnError: effectiveStopOnError,
          iterationsRequested: totalRequested,
          iterationsSucceeded: totalSucceeded,
          iterationsFailed: totalFailed,
          sendCount: totalSends,
          durationMs: overallDurationMs,
        },
      });

      const statusLabel =
        totalFailed === 0
          ? '✅ مكتمل بنجاح (Success)'
          : totalSucceeded > 0
            ? '⚠️ مكتمل جزئياً (Partial)'
            : '❌ فشل التنفيذ (Failed)';

      const maxLimitDisplay =
        primary.maxSendsLimit === 0
          ? 'غير محدود (∞)'
          : `${primary.maxSendsLimit.toLocaleString('en-US')} عملية`;

      const sessionBreakdownText =
        results.length > 1
          ? `\n📡 *تفصيل الجلسات المشاركة (${results.length} جلسات بالتوازي):*\n` +
            results
              .map(
                (r) =>
                  `• \`${r.session.id}\`: تكرارات ${r.res.iterationsSucceeded}/${r.res.iterationsRequested} | إرسال=${r.res.sendCount}`
              )
              .join('\n')
          : `\n📱 *الجلسة المنفذة:* \`${results[0].session.id}\` (${results[0].session.label})`;

      const consoleLogsText =
        combinedLogs.length > 0
          ? `\n📝 *مخرجات Sandbox Console (${combinedLogs.length}):*\n` +
            combinedLogs.map((l) => `\`${l}\``).join('\n')
          : '';

      return {
        text:
          `🧪 *تقرير تنفيذ الدالة المخصصة (/testfunction)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🎯 *الهدف (Target JID):* \`${primary.targetJid}\`\n` +
          `⚙️ *اسم الدالة (Function):* \`${primary.funcName}\` (المعاملات: \`${primary.arity}\`)\n` +
          `🔁 *التكرارات المنفذة:* *${totalSucceeded}/${totalRequested}* (فشل: *${totalFailed}*)\n` +
          `📤 *إجمالي عمليات الإرسال:* *${totalSends}* (الحد الأقصى: \`${maxLimitDisplay}\`)\n` +
          `   └ \`sendMessage\`: *${totalSendMsg}* | \`relayMessage\`: *${totalRelayMsg}* | \`presence\`: *${totalPresence}*\n` +
          `⏱️ *زمن التنفيذ:* \`${overallDurationMs}ms\` (تأخير التكرار: \`${effectiveDelayMs}ms\`)\n` +
          `📊 *الحالة النهائية:* ${statusLabel}` +
          sessionBreakdownText +
          consoleLogsText +
          `\n🔗 *فحص الهدف:* \`https://wa.me/${primary.targetDigits}\`` +
          (lastError ? `\n⚠️ *آخر خطأ مسجل:* \`${lastError}\`` : ''),
        keyboard: [
          [
            {
              text: '⚙️ تعديل حد الإرسال والإعدادات',
              callbackData: 'tools:prompt_testfunction',
            },
            {
              text: '🔢 تغيير الحد الأقصى يدوياً',
              callbackData: 'tools:tf_prompt_max',
            },
          ],
          [
            {
              text: '📱 فحص المقابس (/ceksender)',
              callbackData: 'tools:ceksender',
            },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *تعذر تنفيذ /testfunction:*\n${safeErr.userMessage}`,
        keyboard: [
          [
            {
              text: '🔄 إعادة المحاولة',
              callbackData: 'tools:prompt_testfunction',
            },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    }
  }

  /**
   * Implements `/cekidch <channel_link>` using `athanasia-baileys` `newsletterMetadata`.
   */
  public async executeChannelLookup(
    adminId: number,
    rawLink: string
  ): Promise<BotViewResponse> {
    try {
      const { inviteCode, normalizedUrl } = validateWhatsAppChannelLink(rawLink);
      const connectedSessions = this.sessionManager.listConnectedSessions();
      if (connectedSessions.length === 0) {
        return {
          text:
            `⚠️ *لا توجد جلسة واتساب متصلة حالياً*\n` +
            `يتطلب فحص قنوات واتساب وجود جلسة واحدة متصلة على الأقل لاستعلام \`newsletterMetadata\`.`,
          keyboard: [
            [
              { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
              { text: '🔙 العودة للأدوات', callbackData: 'menu:tools' },
            ],
          ],
        };
      }

      const activeSession = connectedSessions[0];
      const driver = this.sessionManager.getDriver(activeSession.id);
      const meta = await driver.getChannelMetadata(inviteCode);

      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'CHANNEL_METADATA_LOOKUP',
        targetId: meta.id,
        outcome: 'SUCCESS',
        metadata: { sessionId: activeSession.id, inviteCode },
      });

      return {
        text:
          `📡 *بيانات قناة واتساب (WhatsApp Channel Metadata)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🆔 *معرف القناة (JID):* \`${meta.id}\`\n` +
          `📛 *اسم القناة:* ${meta.name}\n` +
          `👥 *عدد المتابعين:* ${meta.subscribers.toLocaleString('en-US')}\n` +
          `📊 *الحالة:* \`${meta.state}\`\n` +
          `✅ *التوثيق:* ${meta.verified ? 'موثقة (VERIFIED)' : 'غير موثقة'}\n` +
          `🔗 *الرابط:* \`${normalizedUrl}\`\n` +
          `📱 *تم الاستعلام عبر الجلسة:* \`${activeSession.id}\`` +
          (meta.description ? `\n📝 *الوصف:* ${meta.description.slice(0, 200)}` : ''),
        keyboard: [
          [
            { text: '📡 فحص قناة أخرى', callbackData: 'tools:prompt_channel' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *تعذر فحص قناة واتساب:*\n${safeErr.userMessage}`,
        keyboard: [
          [
            { text: '🔄 إعادة المحاولة', callbackData: 'tools:prompt_channel' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    }
  }

  /**
   * Implements `/ceksender` — detailed inspection of all sessions, sockets, and InMemoryStore stats.
   */
  public renderSenderDiagnostics(): BotViewResponse {
    const sessions = this.sessionManager.listSessions();
    if (sessions.length === 0) {
      return {
        text:
          `📱 *فحص مقابس وجلسات الإرسال (/ceksender)*\n\n` +
          `لا توجد جلسات مسجلة حالياً. استخدم زر **📲 ربط حساب واتساب** أو الأمر \`/requestpair +966501234567\` لإضافة جلسة.`,
        keyboard: [
          [
            { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    }

    const lines = sessions.map((sess, idx) => {
      let socketSummary = '⚪ المقبس غير نشط في الذاكرة';
      try {
        const drv = this.sessionManager.getDriver(sess.id);
        const diag = drv.getSocketDiagnostics();
        socketSummary =
          `🔌 المقبس: ${diag.socketActive ? '✅ نشط' : '❌ متوقف'} | مسجل: ${diag.registered ? 'نعم' : 'لا'}\n` +
          `   💻 المنصة: \`${diag.platform}\` (${diag.device})\n` +
          `   🗂️ الذاكرة (Store): محادثات=${diag.chatsCount} | جهات=${diag.contactsCount} | رسائل=${diag.cachedMessagesCount}`;
      } catch {
        // Driver not instantiated yet
      }

      return (
        `${idx + 1}. *${sess.label}* (\`${sess.id}\`)\n` +
        `   📌 الحالة: ${formatSessionStatusArabic(sess.status)}\n` +
        `   📱 الرقم المقنع: \`${sess.masked_phone || 'غير مقترن'}\`\n` +
        `   ${socketSummary}`
      );
    });

    return {
      text:
        `📱 *تقرير فحص جلسات ومقابس واتساب (/ceksender)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${lines.join('\n\n')}`,
      keyboard: [
        [
          { text: '🔄 تحديث الفحص', callbackData: 'tools:ceksender' },
          { text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' },
        ],
        [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
      ],
    };
  }

  /**
   * Implements `/cekall` — unified report combining User, Premium status, Sender sessions, and System runtime/memory.
   */
  public renderCheckAllReport(actorUserId: number): BotViewResponse {
    const sessions = this.sessionManager.listSessions();
    const connected = sessions.filter(
      (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
    );
    const prem = this.settingsRepo.getPremiumStatus(actorUserId);
    const cooldownSec = this.settingsRepo.getCooldownSeconds();
    const runnerStats = this.taskManager.getRunnerStats();

    return {
      text:
        `📊 *التقرير الشامل للنظام والجلسات (/cekall)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 *بيانات المسؤول (USER):*\n` +
        `• المعرف الرقمي: \`${actorUserId}\`\n` +
        `• الصلاحية: مسؤول معتمد (Admin Allowlist)\n\n` +
        `⭐ *حالة الاشتراك (PREMIUM):*\n` +
        `• الحالة: ${prem.isPremium ? '✅ مفعل (Premium)' : '🛡️ صلاحية مسؤول النظام الكاملة'}\n` +
        `• تاريخ الانتهاء: \`${prem.formattedExpiry}\` (${prem.remainingDays > 0 ? `${prem.remainingDays} يوم` : 'دائم للمسؤول'})\n\n` +
        `📱 *حالة جلسات واتساب (SENDERS):*\n` +
        `• الجلسات المتصلة: *${connected.length}* من أصل *${sessions.length}*\n` +
        `• المهام النشطة: *${runnerStats.active}/${runnerStats.max}* (الطابور: *${runnerStats.queued}*)\n\n` +
        `🖥️ *موارد الخادم (SYSTEM):*\n` +
        `• مدة التشغيل (Runtime): \`${formatRuntime()}\`\n` +
        `• استهلاك الذاكرة (Memory RSS): \`${formatMemory()}\`\n` +
        `• مهلة التهدئة (Cooldown): \`${cooldownSec}s\`\n` +
        `• محرك البروتوكول: \`athanasia-baileys@1.0.0\``,
      keyboard: [
        [
          { text: '📱 تفاصيل المقابس (/ceksender)', callbackData: 'tools:ceksender' },
          { text: '🔄 تحديث التقرير', callbackData: 'tools:cekall' },
        ],
        [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
      ],
    };
  }

  /**
   * Implements `/info` — displays Telegram profile & subscription card.
   */
  public renderUserInfo(actorUserId: number): BotViewResponse {
    const prem = this.settingsRepo.getPremiumStatus(actorUserId);
    const cooldownSec = this.settingsRepo.getCooldownSeconds();

    return {
      text:
        `🪪 *بطاقة معلومات الحساب (/info & /cekprem)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🆔 *المعرف الرقمي (Telegram ID):* \`${actorUserId}\`\n` +
        `🛡️ *مستوى الوصول:* مسؤول النظام المعتمد (Authorized Admin)\n` +
        `⭐ *حالة الاشتراك الإضافي:* ${prem.isPremium ? `✅ مفعل (متبقي ${prem.remainingDays} يوم)` : 'مسؤول رئيسي (صلاحية كاملة)'}\n` +
        `📅 *تاريخ انتهاء الاشتراك:* \`${prem.formattedExpiry}\`\n` +
        `⏳ *مهلة التهدئة الحالية:* \`${cooldownSec} ثانية\``,
      keyboard: [
        [
          { text: '📊 التقرير الشامل (/cekall)', callbackData: 'tools:cekall' },
          { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
        ],
      ],
    };
  }

  /**
   * Implements `/trackip <ip>` — validates IPv4/IPv6 and queries geolocation/ISP metadata.
   */
  public async executeIpLookup(
    adminId: number,
    rawIp: string
  ): Promise<BotViewResponse> {
    try {
      const ip = validateIpAddress(rawIp);

      let data: Record<string, unknown> | null = null;
      try {
        const res = await fetch(
          `https://ipwhois.app/json/${encodeURIComponent(ip)}`,
          {
            signal: AbortSignal.timeout(7000),
          }
        );
        if (res.ok) {
          data = (await res.json()) as Record<string, unknown>;
        }
      } catch {
        // Fallback when external lookup is unreachable in isolated network environments
      }

      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'TOOL_TRACK_IP',
        targetId: ip,
        outcome: 'SUCCESS',
      });

      if (!data || data.success === false) {
        return {
          text:
            `🌍 *نتيجة فحص عنوان IP:* \`${ip}\`\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ *صيغة العنوان:* صحيحة (${ip.includes(':') ? 'IPv6' : 'IPv4'})\n` +
            `ℹ️ *ملاحظة:* تعذر الوصول إلى خدمة الجغرافيا الخارجية (\`ipwhois.app\`) من بيئة الشبكة الحالية أو أن العنوان خاص/محجوز.`,
          keyboard: [
            [
              { text: '🌍 فحص عنوان آخر', callbackData: 'tools:prompt_ip' },
              { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
            ],
          ],
        };
      }

      const lat = String(data.latitude ?? '');
      const lon = String(data.longitude ?? '');
      const mapsUrl =
        lat && lon
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`
          : null;

      return {
        text:
          `🌍 *تقرير تتبع عنوان IP (/trackip)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `⫹⫺ *IP:* \`${String(data.ip || ip)}\`\n` +
          `⫹⫺ *الدولة:* ${String(data.country || '—')} ${data.country_code ? `(${String(data.country_code)})` : ''}\n` +
          `⫹⫺ *المنطقة / المدينة:* ${String(data.region || '—')} / ${String(data.city || '—')}\n` +
          `⫹⫺ *المنطقة الزمنية:* \`${String(data.timezone_gmt || '—')}\`\n` +
          `⫹⫺ *مزود الخدمة (ISP):* ${String(data.isp || '—')}\n` +
          `⫹⫺ *المؤسسة (Org):* ${String(data.org || '—')}\n` +
          `⫹⫺ *ASN:* \`${String(data.asn || '—')}\`\n` +
          `⫹⫺ *الإحداثيات:* \`${lat || '—'}, ${lon || '—'}\`` +
          (mapsUrl ? `\n📍 *خريطة الموقع:* ${mapsUrl}` : ''),
        keyboard: [
          [
            { text: '🌍 فحص عنوان آخر', callbackData: 'tools:prompt_ip' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *خطأ في فحص عنوان IP:*\n${safeErr.userMessage}`,
        keyboard: [
          [
            { text: '🔄 إعادة المحاولة', callbackData: 'tools:prompt_ip' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    }
  }

  /**
   * Implements `/shortlink <url>` — validates URL and shortens via TinyURL API.
   */
  public async executeShortlink(
    adminId: number,
    rawUrl: string
  ): Promise<BotViewResponse> {
    try {
      const validUrl = validateShortlinkTargetUrl(rawUrl);
      let shortUrl = '';

      try {
        const res = await fetch(
          `https://tinyurl.com/api-create.php?url=${encodeURIComponent(validUrl)}`,
          { signal: AbortSignal.timeout(7000) }
        );
        if (res.ok) {
          const text = (await res.text()).trim();
          if (text.startsWith('http')) {
            shortUrl = text;
          }
        }
      } catch {
        // Network fallback handled below
      }

      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'TOOL_SHORTLINK',
        targetId: validUrl.slice(0, 80),
        outcome: 'SUCCESS',
      });

      if (!shortUrl) {
        return {
          text:
            `🔗 *فحص الرابط:* \`${validUrl}\`\n\n` +
            `✅ الرابط صالح، ولكن تعذر الوصول إلى خدمة \`tinyurl.com\` الخارجية من بيئة الشبكة الحالية.`,
          keyboard: [
            [
              { text: '🔗 اختصار رابط آخر', callbackData: 'tools:prompt_shortlink' },
              { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
            ],
          ],
        };
      }

      return {
        text:
          `✅ *تم اختصار الرابط بنجاح!*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔹 *الرابط الأصلي:* \`${validUrl}\`\n` +
          `🔹 *الرابط المختصر:* \`${shortUrl}\``,
        keyboard: [
          [
            { text: '🔗 اختصار رابط آخر', callbackData: 'tools:prompt_shortlink' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *تعذر اختصار الرابط:*\n${safeErr.userMessage}`,
        keyboard: [
          [
            { text: '🔄 إعادة المحاولة', callbackData: 'tools:prompt_shortlink' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    }
  }

  /**
   * Implements `/gempa` — fetches latest earthquake bulletin from BMKG API.
   */
  public async executeEarthquakeCheck(): Promise<BotViewResponse> {
    try {
      const res = await fetch(
        'https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json',
        { signal: AbortSignal.timeout(7000) }
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        Infogempa?: {
          gempa?: {
            Tanggal?: string;
            Jam?: string;
            Wilayah?: string;
            Magnitude?: string;
            Kedalaman?: string;
            Potensi?: string;
            Coordinates?: string;
            Dirasakan?: string;
          };
        };
      };
      const g = data?.Infogempa?.gempa;
      if (!g) {
        throw new Error('Empty earthquake payload');
      }

      return {
        text:
          `🌋 *آخر نشرة رصد زلزالي (BMKG Seismic Monitor)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📅 *التاريخ:* ${g.Tanggal || '—'}\n` +
          `🕒 *الوقت:* ${g.Jam || '—'}\n` +
          `📍 *المنطقة:* ${g.Wilayah || '—'}\n` +
          `📊 *القوة (Magnitude):* \`${g.Magnitude || '—'}\`\n` +
          `📌 *العمق:* ${g.Kedalaman || '—'}\n` +
          `🌊 *الاحتمالية:* ${g.Potensi || '—'}\n` +
          `🧭 *الإحداثيات:* \`${g.Coordinates || '—'}\`\n` +
          `🗺️ *الشعور بالهزة:* ${g.Dirasakan || '—'}`,
        keyboard: [
          [
            { text: '🔄 تحديث الرصد', callbackData: 'tools:gempa' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    } catch {
      return {
        text:
          `🌋 *نشرة الرصد الزلزالي (/gempa)*\n\n` +
          `⚠️ تعذر جلب البيانات الآنية من خادم \`data.bmkg.go.id\` في اللحظة الحالية. الرجاء المحاولة لاحقاً.`,
        keyboard: [
          [
            { text: '🔄 إعادة المحاولة', callbackData: 'tools:gempa' },
            { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
          ],
        ],
      };
    }
  }
}
