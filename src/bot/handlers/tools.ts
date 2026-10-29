import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';
import { SettingsRepository } from '../../database/repositories/settings-repository';
import { AuditRepository } from '../../database/repositories/audit-repository';
import {
  FunctionLabRepository,
  FunctionExecutionMode,
} from '../../database/repositories/function-lab-repository';
import {
  FunctionRegistry,
  FunctionValidator,
  FunctionExecutor,
  TestRunner,
  SessionResolver,
  DiagnosticLogger,
  classifyFunctionError,
} from '../../function-lab';
import { WhatsAppCapabilityAdapter } from '../../whatsapp/message-capabilities';
import { BotViewResponse } from '../workflows/pairing-workflow';
import {
  buildBackCancelRow,
  buildAppNavigationRow,
  InlineKeyboardRows,
  InlineButtonSpec,
} from '../keyboards/main-menu';
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
  | 'AWAITING_TF_DELAY'
  | 'AWAITING_SAVE_FUNCTION_NAME';

export const DEFAULT_SAMPLE_TEST_FUNCTION = `async function nebulaSocketProbe(sock, target, meta) {
  console.log('Executing probe iteration', meta?.iteration, 'maxSends=', sock.getMaxSends());
  await sock.presenceSubscribe(target);
  await sock.sendPresenceUpdate('composing', target);
  await sock.sendMessage(target, { text: 'Nebula Function Probe OK' });
}`;

export class ToolsHandler {
  private readonly inputStates = new Map<number, ToolsInputStep>();
  private readonly selectedFunctionByAdmin = new Map<number, string>();
  private readonly selectedModeByAdmin = new Map<number, FunctionExecutionMode>();
  private readonly lastCustomFunctionByAdmin = new Map<
    number,
    { funcName: string; sourceCode: string }
  >();
  private readonly activeExecutionAbortByAdmin = new Map<number, AbortController>();
  public readonly functionLabRepo: FunctionLabRepository;
  public readonly functionRegistry: FunctionRegistry;
  public readonly functionValidator: FunctionValidator;
  public readonly functionExecutor: FunctionExecutor;
  public readonly testRunner: TestRunner;
  public readonly sessionResolver: SessionResolver;
  public readonly diagnosticLogger: DiagnosticLogger;
  public readonly capabilityAdapter: WhatsAppCapabilityAdapter;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager,
    private readonly settingsRepo: SettingsRepository,
    private readonly auditRepo: AuditRepository
  ) {
    this.functionLabRepo = new FunctionLabRepository(this.settingsRepo.db);
    this.functionRegistry = new FunctionRegistry(this.functionLabRepo);
    this.functionValidator = new FunctionValidator();
    this.functionExecutor = new FunctionExecutor(this.functionRegistry);
    this.diagnosticLogger = new DiagnosticLogger();
    this.sessionResolver = new SessionResolver();
    this.capabilityAdapter = new WhatsAppCapabilityAdapter();
    this.testRunner = new TestRunner(
      this.functionRegistry,
      this.functionExecutor,
      this.diagnosticLogger,
      this.functionLabRepo
    );
  }

  public getStep(adminId: number): ToolsInputStep {
    return this.inputStates.get(adminId) || 'NONE';
  }

  public cancel(adminId: number): void {
    this.inputStates.delete(adminId);
  }

  public getSelectedFunction(adminId: number): string | undefined {
    return this.selectedFunctionByAdmin.get(adminId);
  }

  public selectFunctionForAdmin(adminId: number, funcName: string): BotViewResponse {
    const resolved = this.functionRegistry.resolveFunction(funcName);
    if (!resolved) {
      return this.promptTestFunction(
        adminId,
        `⚠️ الدالة المطلوبة (\`${funcName}\`) غير مسجلة في مكتبة الدوال.`
      );
    }
    this.selectedFunctionByAdmin.set(adminId, resolved.name);
    return this.promptTestFunction(
      adminId,
      `✅ *تم اختيار الدالة النشطة:* \`${resolved.name}\` (الإصدار \`v${resolved.version}\` — الفئة: \`${resolved.category}\`)\n📝 *الوصف:* ${resolved.descriptionAr}`
    );
  }

  public setExecutionModeForAdmin(
    adminId: number,
    mode: FunctionExecutionMode
  ): BotViewResponse {
    this.selectedModeByAdmin.set(adminId, mode);
    const modeLabel =
      mode === 'DRY_RUN'
        ? '🧪 فحص جاف بدون إرسال شبكي (DRY_RUN)'
        : mode === 'SIMULATION'
          ? '🔬 محاكاة معزولة آمنة (SIMULATION)'
          : '📡 تنفيذ حي عبر الجلسة المتصلة (LIVE)';
    return this.promptTestFunction(
      adminId,
      `✅ *تم ضبط وضع تشغيل مختبر الدوال على:* ${modeLabel}`
    );
  }

  public renderFunctionCatalog(adminId: number, categoryFilter?: string): BotViewResponse {
    const functions = this.functionRegistry.listFunctions({
      category: categoryFilter,
      onlyEnabled: true,
    });
    const currentSelected = this.selectedFunctionByAdmin.get(adminId) || 'AewCh';
    const recentExecs = this.functionLabRepo.listRecentExecutions({ limit: 5 });

    const fnLines = functions.map((fn, idx) => {
      const isSelected = fn.name.toLowerCase() === currentSelected.toLowerCase();
      return (
        `${idx + 1}. ${isSelected ? '🟢' : '🔹'} *${fn.name}* (\`v${fn.version}\` | \`${fn.category}\`)\n` +
        `   📝 ${fn.descriptionAr}\n` +
        `   📦 الاعتماديات: \`${fn.requiredDependencies.join(', ') || 'قياسي'}\``
      );
    });

    const historyLines =
      recentExecs.length > 0
        ? `\n\n📜 *آخر عمليات التشغيل المسجلة (${recentExecs.length}):*\n` +
          recentExecs
            .map(
              (ex) =>
                `• \`${ex.functionName}\` [${ex.executionMode}] — *${ex.status}* (${ex.durationMs}ms) | المرجع: \`${ex.correlationId}\``
            )
            .join('\n')
        : '';

    const rows: InlineKeyboardRows = [];
    for (const fn of functions.slice(0, 6)) {
      const isSelected = fn.name.toLowerCase() === currentSelected.toLowerCase();
      rows.push([
        {
          text: `${isSelected ? '✅ مختارة: ' : '📌 اختيار: '}${fn.name} (${fn.category})`,
          callbackData: `tools:flab_select:${fn.name}`,
        },
        {
          text: `🧪 فحص جاف (${fn.name})`,
          callbackData: `tools:flab_dryrun:${fn.name}`,
        },
      ]);
    }

    rows.push([
      {
        text: '🧬 تشغيل سيناريوهات الاختبار (13 سيناريو)',
        callbackData: 'tools:flab_run_scenarios',
      },
      {
        text: '📋 مصفوفة قدرات واتساب',
        callbackData: 'tools:flab_capabilities',
      },
    ]);
    rows.push([
      {
        text: '🔙 العودة للوحة /testfunction',
        callbackData: 'tools:prompt_testfunction',
      },
    ]);

    return {
      text:
        `📚 *مكتبة وسجل دوال الاختبار (Function Lab Registry)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `الدالة المختارة حالياً: \`${currentSelected}\`\n` +
        `إجمالي الدوال المسجلة والصالحة: *${functions.length}*\n\n` +
        fnLines.join('\n\n') +
        historyLines,
      keyboard: rows,
      toastText: '📚 مكتبة دوال المختبر',
      route: 'tools:flab_catalog',
    };
  }

  public async renderScenarioSuiteReport(adminId: number): Promise<BotViewResponse> {
    const report = await this.testRunner.runAllScenarios();
    this.auditRepo.record({
      actorTelegramId: adminId,
      action: 'FUNCTION_LAB_SCENARIOS_RUN',
      targetId: 'all_scenarios',
      outcome: report.failed === 0 ? 'SUCCESS' : 'FAILURE',
      metadata: {
        total: report.total,
        passed: report.passed,
        failed: report.failed,
        durationMs: report.durationMs,
      },
    });

    const lines = report.results.map(
      (r) =>
        `${r.passed ? '✅' : '❌'} *${r.titleAr}* (\`${r.durationMs}ms\`)\n   └ ${r.summaryAr}`
    );

    return {
      text:
        `🧬 *تقرير سيناريوهات الفحص الشامل (Function Lab & Message Capabilities)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 *النتيجة الإجمالية:* نجح *${report.passed}* من *${report.total}* (فشل: *${report.failed}*) | الزمن: \`${report.durationMs}ms\`\n\n` +
        lines.join('\n\n'),
      keyboard: [
        [
          {
            text: '🔄 إعادة تشغيل السيناريوهات',
            callbackData: 'tools:flab_run_scenarios',
          },
          {
            text: '📚 مكتبة الدوال',
            callbackData: 'tools:flab_catalog',
          },
        ],
        [
          {
            text: '🔙 لوحة /testfunction',
            callbackData: 'tools:prompt_testfunction',
          },
        ],
      ],
      toastText: `✅ اكتمل فحص ${report.passed}/${report.total} سيناريو`,
      route: 'tools:flab_scenarios',
    };
  }

  public renderCapabilitiesMatrix(): BotViewResponse {
    const matrix = this.capabilityAdapter.getCapabilityMatrix();
    return {
      text:
        `📋 *مصفوفة قدرات بروتوكول واتساب الموحدة (${matrix.libraryName}@${matrix.libraryVersion})*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `• 💬 *النصوص والرسائل الممتدة:* ${matrix.textAndExtendedText.supported ? '✅ مدعوم' : '❌ غير مدعوم'}\n` +
        `  └ ${matrix.textAndExtendedText.notesAr}\n` +
        `• 💬 *الاقتباس والردود (Quoted):* ${matrix.quotedMessages.supported ? '✅ مدعوم' : '❌ غير مدعوم'}\n` +
        `  └ ${matrix.quotedMessages.notesAr}\n` +
        `• 🖼️ *الوسائط (صور/فيديو/صوت/PTT/مستندات/GIF):* ✅ مدعوم\n` +
        `  └ ${matrix.mediaMessages.notesAr}\n` +
        `• 🎨 *الملصقات وحزم الملصقات (WebP & Sticker Packs):* ✅ مدعوم\n` +
        `  └ ${matrix.stickers.notesAr}\n` +
        `• 📍 *جهات الاتصال والمواقع والاستطلاعات والتفاعلات:* ✅ مدعوم\n` +
        `  └ ${matrix.pollsAndReactions.notesAr}\n` +
        `• ⏳ *الرسائل المؤقتة والعرض لمرة واحدة (Ephemeral & View-Once):* ✅ مدعوم مع حماية الخصوصية\n` +
        `  └ ${matrix.ephemeralAndViewOnce.notesAr}\n` +
        `• ⭕ *حالات وقصص واتساب (status@broadcast):* ✅ مدعوم\n` +
        `  └ ${matrix.statusAndStories.notesAr}`,
      keyboard: [
        [
          {
            text: '🧬 تشغيل فحص السيناريوهات (13)',
            callbackData: 'tools:flab_run_scenarios',
          },
          {
            text: '📚 مكتبة الدوال',
            callbackData: 'tools:flab_catalog',
          },
        ],
        [
          {
            text: '🔙 لوحة /testfunction',
            callbackData: 'tools:prompt_testfunction',
          },
        ],
      ],
      toastText: '📋 مصفوفة قدرات واتساب',
      route: 'tools:flab_capabilities',
    };
  }

  public renderToolsMenu(): BotViewResponse {
    const tfCfg = this.settingsRepo.getTestFunctionConfig();
    const maxLabel = tfCfg.maxSends === 0 ? 'غير محدود (∞)' : `${tfCfg.maxSends}`;
    return {
      text:
        `🛠️ *الأدوات والفحص المتقدم (Tools & Diagnostics)*\n\n` +
        `اختر الأداة المطلوبة من الأزرار التفاعلية أدناه أو استخدم الأوامر السريعة مباشرة:\n` +
        `• \`/testfunction <phone> <count> [funcName] [--max=N] [--delay=MS] [--dry-run|--sim]\` — تشغيل واختبار دالة غير متزامنة (\`async function\`) مع تحكم كامل بحد الإرسال (\`الحالي: ${maxLabel}\`)\n` +
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
            text: '📚 مكتبة الدوال والسيناريوهات',
            callbackData: 'tools:flab_catalog',
          },
        ],
        [
          {
            text: '🧬 فحص قدرات الرسائل (13 سيناريو)',
            callbackData: 'tools:flab_run_scenarios',
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
            callbackData: 'menu:subscriptions:page:1',
          },
          {
            text: '🛡️ لوحة تحكم المشرف',
            callbackData: 'menu:admin',
          },
        ],
        buildAppNavigationRow({
          backCallback: 'nav:back',
          refreshCallback: 'menu:tools',
        }),
      ],
      toastText: '🛠️ قائمة الأدوات والفحص المتقدم',
      route: 'menu:tools',
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
    const selectedFn = this.selectedFunctionByAdmin.get(adminId);
    const selectedMode = this.selectedModeByAdmin.get(adminId) || 'LIVE';
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
    const modeLabel =
      selectedMode === 'DRY_RUN'
        ? '🧪 فحص جاف (DRY_RUN)'
        : selectedMode === 'SIMULATION'
          ? '🔬 محاكاة معزولة (SIMULATION)'
          : '📡 تنفيذ حي (LIVE)';

    return {
      text:
        (noticeBanner ? `${noticeBanner}\n━━━━━━━━━━━━━━━━━━\n` : '') +
        `🧪 *لوحة التحكم العميق في مختبر الدوال (/testfunction)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *إعدادات التنفيذ الحالية (قابلة للتعديل الفوري):*\n` +
        `• 🧩 *الدالة المختارة من المكتبة:* \`${selectedFn || 'تلقائي (بالرد أو بالاسم مثل AewCh)'}\`\n` +
        `• 🎛️ *وضع التشغيل (Execution Mode):* ${modeLabel}\n` +
        `• 📤 *الحد الأقصى للإرسال (Max Sends):* \`${maxSendsLabel}\`\n` +
        `• ⏱️ *التأخير بين التكرارات (Loop Delay):* \`${cfg.delayMs}ms\`\n` +
        `• 📡 *نطاق الجلسات (Session Scope):* \`${scopeLabel}\`\n` +
        `• 🛡️ *سياسة الأخطاء (Error Policy):* ${errorPolicyLabel}\n` +
        `• ⌛ *مهلة Sandbox VM:* \`${cfg.vmTimeoutMs}ms\` | *التقاط Console:* \`${cfg.captureConsole ? 'مفعل' : 'معطل'}\`\n\n` +
        `📌 *طرق التشغيل والتحكم المتقدم:*\n` +
        `1️⃣ *بتحديد اسم الدالة المسجلة مباشرة (مثل \`AewCh\`):*\n` +
        `\`/testfunction +966501234567 5 AewCh\`\n` +
        `2️⃣ *بالرد على رسالة كود أو إرسال كود أو رفع ملف (\`.js\` / \`.txt\`):*\n` +
        `\`/testfunction +966501234567 10 --max=2500 --delay=100 --session=ALL --stop-on-error\`\n` +
        `3️⃣ *لحفظ دالة مخصصة في المكتبة أو إيقاف دالة جارية:*\n` +
        `\`/savefunction MyFunc\` (بالرد على الكود) | \`/stopfunction\`\n` +
        `4️⃣ *وضع الفحص الجاف أو المحاكاة بدون إرسال حقيقي:*\n` +
        `\`/testfunction +966501234567 3 AewCh --dry-run\` أو \`--sim\``,
      keyboard: [
        [
          {
            text: '⚡ تشغيل دالة فحص تجريبية جاهزة',
            callbackData: 'tools:run_sample_testfunction',
          },
          {
            text: '🚀 فحص دالة AewCh (Dry-Run)',
            callbackData: 'tools:flab_dryrun:AewCh',
          },
        ],
        [
          {
            text: '📚 مكتبة الدوال المسجلة (Catalog)',
            callbackData: 'tools:flab_catalog',
          },
          {
            text: '🔢 تحديد حد الإرسال يدوياً',
            callbackData: 'tools:tf_prompt_max',
          },
        ],
        [
          {
            text: '💾 حفظ آخر دالة في المكتبة',
            callbackData: 'tools:flab_prompt_save',
          },
          {
            text: '🛑 إيقاف الدالة الجارية',
            callbackData: 'tools:flab_stop',
          },
        ],
        [
          {
            text: selectedMode === 'LIVE' ? '✅ وضع: LIVE' : 'وضع: LIVE',
            callbackData: 'tools:flab_mode:LIVE',
          },
          {
            text: selectedMode === 'DRY_RUN' ? '✅ وضع: DRY_RUN' : 'وضع: DRY_RUN',
            callbackData: 'tools:flab_mode:DRY_RUN',
          },
          {
            text: selectedMode === 'SIMULATION' ? '✅ وضع: SIM' : 'وضع: SIM',
            callbackData: 'tools:flab_mode:SIMULATION',
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
    if (step === 'AWAITING_SAVE_FUNCTION_NAME') {
      this.cancel(adminId);
      return this.saveCustomFunction(adminId, rawText, repliedText);
    }
    if (step === 'AWAITING_TESTFUNCTION') {
      this.cancel(adminId);
      return this.executeTestFunction(adminId, rawText, repliedText);
    }
    return this.renderToolsMenu();
  }

  public promptSaveLastFunction(adminId: number): BotViewResponse {
    const lastFn = this.lastCustomFunctionByAdmin.get(adminId);
    this.inputStates.set(adminId, 'AWAITING_SAVE_FUNCTION_NAME');
    return {
      text:
        `💾 *حفظ دالة مخصصة في مكتبة الدوال (Save Function to Registry)*\n\n` +
        (lastFn
          ? `الدالة الجاهزة للحفظ من آخر تشغيل: \`${lastFn.funcName}\`\n` +
            `أرسل الآن **الاسم المطلوب** لحفظها به في قاعدة البيانات (أو أرسل \`${lastFn.funcName}\` للاحتفاظ بنفس الاسم)، أو قم بالرد على أي كود دالة باسم جديد:`
          : `أرسل الآن اسم الدالة متبوعاً بكود الدالة (أو بالرد على رسالة تحتوي على كود الدالة) لحفظها في المكتبة الدائمة:`),
      keyboard: [buildBackCancelRow('tools:prompt_testfunction')],
    };
  }

  public saveCustomFunction(
    adminId: number,
    rawInput: string,
    repliedText?: string
  ): BotViewResponse {
    try {
      const trimmed = rawInput.trim();
      const lastFn = this.lastCustomFunctionByAdmin.get(adminId);

      // Extract optional name and optional inline code
      let requestedName = '';
      let codeSource = (repliedText || '').trim();

      const asyncIdx = trimmed.search(/(?:export\s+)?(?:async\s+)?function\s+|=>|\{/);
      if (asyncIdx > 0 && !codeSource) {
        requestedName = trimmed.slice(0, asyncIdx).trim().split(/\s+/)[0] || '';
        codeSource = trimmed.slice(asyncIdx).trim();
      } else if (asyncIdx === 0 && !codeSource) {
        codeSource = trimmed;
      } else {
        requestedName = trimmed.split(/\s+/)[0] || '';
      }

      if (!codeSource && lastFn) {
        codeSource = lastFn.sourceCode;
      }

      if (!codeSource) {
        return {
          text:
            `⚠️ *لم يتم العثور على كود دالة لحفظه.*\n` +
            `يرجى تشغيل دالة أولاً عبر \`/testfunction\` ثم الضغط على **💾 حفظ هذه الدالة في المكتبة**، أو استخدام \`/savefunction <name>\` بالرد على رسالة تحتوي على كود الدالة.`,
          keyboard: [buildBackCancelRow('tools:prompt_testfunction')],
        };
      }

      const parsed = this.functionValidator.parseAndValidateSource(codeSource);
      if (!parsed.valid) {
        return {
          text: `⚠️ *تعذر حفظ الدالة في المكتبة:*\n${parsed.errorMessageAr || 'خطأ تركيبي في الكود'}`,
          keyboard: [buildBackCancelRow('tools:prompt_testfunction')],
        };
      }

      const finalName =
        requestedName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(requestedName)
          ? requestedName
          : parsed.funcName;

      // Replace function declaration name if custom valid name was provided
      const finalSource =
        finalName !== parsed.funcName
          ? parsed.normalizedCode.replace(
              new RegExp(`function\\s+${parsed.funcName}\\b`),
              `function ${finalName}`
            )
          : parsed.normalizedCode;

      const saved = this.functionRegistry.registerFunction({
        name: finalName,
        descriptionAr: `دالة مخصصة محفوظة بواسطة المسؤول (${finalName})`,
        category: 'custom',
        sourceCode: finalSource,
        createdBy: adminId,
      });

      this.selectedFunctionByAdmin.set(adminId, saved.name);
      this.lastCustomFunctionByAdmin.set(adminId, {
        funcName: saved.name,
        sourceCode: saved.sourceCode,
      });

      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'FUNCTION_LAB_CUSTOM_SAVED',
        targetId: saved.name,
        outcome: 'SUCCESS',
        metadata: { functionId: saved.functionId, version: saved.version },
      });

      return {
        text:
          `✅ *تم حفظ الدالة المخصصة في مكتبة الدوال بنجاح!*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🧩 *اسم الدالة:* \`${saved.name}\` (الإصدار \`v${saved.version}\`)\n` +
          `🆔 *المعرف:* \`${saved.functionId}\`\n` +
          `📌 تم تعيين \`${saved.name}\` كدالة نشطة حالياً. يمكنك تشغيلها مباشرة عبر:\n` +
          `\`/testfunction +966501234567 1 ${saved.name}\``,
        keyboard: [
          [
            {
              text: `🧪 فحص جاف (${saved.name})`,
              callbackData: `tools:flab_dryrun:${saved.name}`,
            },
            {
              text: '📚 فتح مكتبة الدوال',
              callbackData: 'tools:flab_catalog',
            },
          ],
          [
            {
              text: '🔙 لوحة /testfunction',
              callbackData: 'tools:prompt_testfunction',
            },
          ],
        ],
        toastText: `💾 تم حفظ الدالة ${saved.name}`,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *تعذر حفظ الدالة:*\n${safeErr.userMessage}`,
        keyboard: [buildBackCancelRow('tools:prompt_testfunction')],
      };
    }
  }

  public stopActiveFunction(adminId: number): BotViewResponse {
    const controller = this.activeExecutionAbortByAdmin.get(adminId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
      this.activeExecutionAbortByAdmin.delete(adminId);
      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'FUNCTION_LAB_STOPPED',
        targetId: String(adminId),
        outcome: 'SUCCESS',
      });
      return this.promptTestFunction(
        adminId,
        '🛑 *تم إرسال إشارة الإيقاف الفوري (AbortSignal) للدالة الجارية بنجاح.*'
      );
    }
    return this.promptTestFunction(
      adminId,
      'ℹ️ *لا توجد دالة قيد التشغيل حالياً لإيقافها.*'
    );
  }

  /**
   * Handles `.js`, `.ts`, or `.txt` code files uploaded directly in Telegram
   * when the admin is in Function Lab (`TOOLS` mode) or provides a `/testfunction` or `/savefunction` caption.
   */
  public async handleCodeFileUpload(
    adminId: number,
    params: {
      fileName: string;
      codeText: string;
      caption?: string;
    }
  ): Promise<BotViewResponse> {
    const caption = (params.caption || '').trim();
    const codeText = params.codeText.trim();

    if (/^\/savefunction\b/i.test(caption)) {
      const nameArg = caption.replace(/^\/savefunction(?:@\w+)?\s*/i, '').trim();
      const fallbackName =
        nameArg ||
        params.fileName
          .replace(/\.[^.]+$/, '')
          .replace(/[^A-Za-z0-9_$]/g, '_');
      return this.saveCustomFunction(adminId, fallbackName, codeText);
    }

    const argsAfterCmd = caption.replace(/^\/testfunction(?:@\w+)?\s*/i, '').trim();
    return this.executeTestFunction(adminId, argsAfterCmd, codeText);
  }

  /**
   * Implements `/testfunction <phone> <count> [funcName] [--max=N] [--delay=MS] [--timeout=MS] [--session=ALL|FIRST|id] [--stop-on-error] [--dry-run|--sim]`
   * (with reply to `async function`, inline `async function`, or registered function name like `AewCh`).
   */
  public async executeTestFunction(
    adminId: number,
    rawInput: string,
    repliedText?: string
  ): Promise<BotViewResponse> {
    const correlationId = this.diagnosticLogger.createCorrelationId('flab');
    const startTime = Date.now();
    try {
      const trimmed = rawInput.trim();

      // Detect inline code start (`async function`, `function`, `export async function`, or markdown fence ```)
      const fenceIdx = trimmed.indexOf('```');
      const asyncIdx = trimmed.search(/(?:export\s+)?(?:async\s+)?function\s+/);
      let codeSplitIdx = -1;
      if (fenceIdx !== -1 && (asyncIdx === -1 || fenceIdx < asyncIdx)) {
        codeSplitIdx = fenceIdx;
      } else if (asyncIdx !== -1) {
        codeSplitIdx = asyncIdx;
      }

      let headerPart = trimmed;
      let inlineFuncCode = '';
      if (codeSplitIdx !== -1) {
        headerPart = trimmed.slice(0, codeSplitIdx).trim();
        inlineFuncCode = trimmed.slice(codeSplitIdx).trim();
      }

      const rawTokens = headerPart.split(/\s+/).filter(Boolean);
      const positionalTokens: string[] = [];
      const savedConfig = this.settingsRepo.getTestFunctionConfig();

      let effectiveMaxSends = savedConfig.maxSends;
      let effectiveDelayMs = savedConfig.delayMs;
      let effectiveVmTimeoutMs = savedConfig.vmTimeoutMs;
      let effectiveScope = savedConfig.sessionScope;
      let effectiveStopOnError = savedConfig.stopOnError;
      let effectiveMode: FunctionExecutionMode =
        this.selectedModeByAdmin.get(adminId) || 'LIVE';

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
        } else if (tok === '--dry-run' || tok === '--dryrun') {
          effectiveMode = 'DRY_RUN';
        } else if (tok === '--sim' || tok === '--simulation') {
          effectiveMode = 'SIMULATION';
        } else if (tok === '--live') {
          effectiveMode = 'LIVE';
        } else if (tok.startsWith('--mode=')) {
          const m = (tok.split('=')[1] || '').trim().toUpperCase();
          if (m === 'DRY_RUN' || m === 'SIMULATION' || m === 'LIVE') {
            effectiveMode = m;
          }
        } else {
          positionalTokens.push(tok);
        }
      }

      // Support single-argument function selection: `/testfunction AewCh`
      if (positionalTokens.length === 1 && !repliedText && !inlineFuncCode) {
        const candidateFn = this.functionRegistry.resolveFunction(positionalTokens[0]);
        if (candidateFn) {
          this.selectedFunctionByAdmin.set(adminId, candidateFn.name);
          const fallbackMode =
            this.sessionManager.listConnectedSessions().length === 0 &&
            effectiveMode === 'LIVE'
              ? 'SIMULATION'
              : effectiveMode;
          return this.executeTestFunction(
            adminId,
            `+966501234567 1 ${candidateFn.name} --mode=${fallbackMode}`,
            candidateFn.sourceCode
          );
        }
      }

      // Support 0-argument execution when user replied to a function, pasted raw `async function ...`, or selected a function in Function Lab
      if (
        positionalTokens.length === 0 &&
        Boolean(
          repliedText?.trim() ||
            inlineFuncCode.trim() ||
            this.selectedFunctionByAdmin.get(adminId)
        )
      ) {
        positionalTokens.push('+966501234567', '1');
        if (
          this.sessionManager.listConnectedSessions().length === 0 &&
          effectiveMode === 'LIVE'
        ) {
          effectiveMode = 'SIMULATION';
        }
      }

      if (positionalTokens.length < 2) {
        return {
          text:
            `🪧 *صيغة الأمر غير مكتملة (/testfunction)*\n\n` +
            `الصيغة المطلوبة:\n` +
            `• \`/testfunction +966501234567 5 AewCh\` (لتشغيل دالة مسجلة بالاسم)\n` +
            `• \`/testfunction 966501234567 5\` (مع الرد على رسالة الدالة \`async function\`)\n` +
            `• أو مع خيارات التحكم المتقدم:\n` +
            `\`/testfunction 966501234567 10 --max=2000 --delay=100 --session=ALL --dry-run async function myFunc(sock, target) { ... }\``,
          keyboard: [
            [
              {
                text: '⚡ تشغيل دالة فحص تجريبية',
                callbackData: 'tools:run_sample_testfunction',
              },
              {
                text: '📚 مكتبة الدوال (AewCh)',
                callbackData: 'tools:flab_catalog',
              },
            ],
            [
              {
                text: '⚙️ لوحة إعدادات /testfunction',
                callbackData: 'tools:prompt_testfunction',
              },
              { text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' },
            ],
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
      const namedFuncToken = positionalTokens[2];
      const adminSelectedFn = this.selectedFunctionByAdmin.get(adminId);

      let funcCode = (repliedText?.trim() || inlineFuncCode).trim();
      let resolvedDef = namedFuncToken
        ? this.functionRegistry.resolveFunction(namedFuncToken)
        : undefined;

      if (!funcCode && resolvedDef) {
        funcCode = resolvedDef.sourceCode;
      } else if (!funcCode && namedFuncToken) {
        // User specified an unknown 3rd token function name
        return {
          text:
            `⚠️ *الدالة المطلوبة (\`${namedFuncToken}\`) غير مسجلة في مكتبة الدوال.*\n` +
            `الدوال الجاهزة المتاحة: ${this.functionRegistry
              .listFunctions()
              .map((f) => `\`${f.name}\``)
              .join('، ')}`,
          keyboard: [
            [
              { text: '📚 فتح مكتبة الدوال', callbackData: 'tools:flab_catalog' },
              {
                text: '🧪 لوحة /testfunction',
                callbackData: 'tools:prompt_testfunction',
              },
            ],
          ],
        };
      } else if (!funcCode && adminSelectedFn) {
        resolvedDef = this.functionRegistry.resolveFunction(adminSelectedFn);
        if (resolvedDef) {
          funcCode = resolvedDef.sourceCode;
        }
      }

      if (!funcCode) {
        return {
          text:
            `❌ *لم يتم العثور على كود الدالة (Reply dengan function)*\n\n` +
            `يرجى الرد (Reply) على رسالة تحتوي على \`async function name(sock, target) { ... }\` أو تمرير اسم دالة مسجلة مثل \`/testfunction +966501234567 3 AewCh\` أو اختيار دالة من مكتبة الدوال.`,
          keyboard: [
            [
              {
                text: '⚡ تشغيل دالة فحص تجريبية',
                callbackData: 'tools:run_sample_testfunction',
              },
              {
                text: '📚 اختيار دالة من المكتبة',
                callbackData: 'tools:flab_catalog',
              },
            ],
            [
              {
                text: '🧪 لوحة إعدادات /testfunction',
                callbackData: 'tools:prompt_testfunction',
              },
            ],
          ],
        };
      }

      // Validate function syntax and structure BEFORE touching any session
      const preValidation = this.functionValidator.parseAndValidateSource(funcCode);
      if (!preValidation.valid) {
        const errText =
          preValidation.errorMessageAr ||
          `فشل تحليل كود الدالة (${preValidation.funcName}): خطأ تركيبي`;
        this.functionLabRepo.recordExecution({
          correlationId,
          functionId: resolvedDef?.functionId || `inline_${preValidation.funcName}`,
          functionName: preValidation.funcName,
          functionVersion: resolvedDef?.version || 1,
          telegramUserId: adminId,
          executionMode: effectiveMode,
          status: 'FAILED',
          failureCategory: preValidation.failureCategory || 'PARSING_ERROR',
          durationMs: Date.now() - startTime,
          argsPreview: { targetRaw, iterations, effectiveScope },
          errorMessageAr: errText,
        });
        return {
          text:
            `⚠️ *تعذر تنفيذ /testfunction:*\n${errText}\n\n` +
            `🔖 *المرجع التشخيصي (Correlation ID):* \`${correlationId}\`\n` +
            `🏷️ *تصنيف الخطأ:* \`${preValidation.failureCategory || 'PARSING_ERROR'}\``,
          keyboard: [
            [
              {
                text: '📚 اختيار دالة جاهزة (AewCh)',
                callbackData: 'tools:flab_catalog',
              },
              {
                text: '🔄 إعادة المحاولة',
                callbackData: 'tools:prompt_testfunction',
              },
            ],
            [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
          ],
        };
      }

      // Resolve target sessions via SessionResolver (supports DRY_RUN / SIMULATION offline safety)
      const connectedSessions = this.sessionManager.listConnectedSessions();
      const sessionResolution = this.sessionResolver.resolveTargetSessions({
        connectedSessions,
        requestedScope: effectiveScope,
        executionMode: effectiveMode,
      });

      if (sessionResolution.sessions.length === 0) {
        if (connectedSessions.length === 0) {
          return {
            text:
              `⚠️ *لا توجد جلسة واتساب متصلة حالياً*\n` +
              `يتطلب تشغيل \`/testfunction\` في الوضع الحي (LIVE) وجود جلسة واتساب متصلة واحدة على الأقل لتمرير \`createSafeSock(sock)\`.\n\n` +
              `💡 *بديل فوري آمن:* يمكنك تجربة الدالة الآن في **وضع الفحص الجاف (Dry-Run)** أو **المحاكاة (Simulation)** دون الحاجة لجلسة متصلة!`,
            keyboard: [
              [
                {
                  text: `🧪 فحص جاف فوري (${preValidation.funcName})`,
                  callbackData: `tools:flab_dryrun:${preValidation.funcName}`,
                },
                { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
              ],
              [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
            ],
          };
        }
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

      this.lastCustomFunctionByAdmin.set(adminId, {
        funcName: preValidation.funcName,
        sourceCode: preValidation.normalizedCode,
      });

      const targetSessions = sessionResolution.sessions;
      const overallStart = Date.now();
      const abortController = new AbortController();
      this.activeExecutionAbortByAdmin.set(adminId, abortController);

      let results;
      try {
        results = await Promise.all(
          targetSessions.map(async (sess) => {
            if (sessionResolution.isSimulatedOfflineSession) {
              const execRes = await this.functionExecutor.execute({
                sessionId: sess.id,
                targetPhone: targetRaw,
                iterations,
                funcCodeOrName: preValidation.normalizedCode,
                executionMode: effectiveMode,
                maxSends: effectiveMaxSends,
                delayMs: effectiveDelayMs,
                vmTimeoutMs: effectiveVmTimeoutMs,
                stopOnError: effectiveStopOnError,
                captureConsole: savedConfig.captureConsole,
                correlationId,
                abortSignal: abortController.signal,
              });
              return { session: sess, res: execRes };
            }

            const driver = this.sessionManager.getDriver(sess.id);
            const res = await driver.executeTestFunction({
              targetPhone: targetRaw,
              iterations,
              funcCode: preValidation.normalizedCode,
              executionMode: effectiveMode,
              maxSends: effectiveMaxSends,
              delayMs: effectiveDelayMs,
              vmTimeoutMs: effectiveVmTimeoutMs,
              stopOnError: effectiveStopOnError,
              captureConsole: savedConfig.captureConsole,
              correlationId,
              abortSignal: abortController.signal,
            });
            return { session: sess, res };
          })
        );
      } finally {
        if (this.activeExecutionAbortByAdmin.get(adminId) === abortController) {
          this.activeExecutionAbortByAdmin.delete(adminId);
        }
      }
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
      const failureCategory = results.find((r) => r.res.failureCategory)?.res
        .failureCategory;

      const finalStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' =
        totalFailed === 0
          ? 'SUCCESS'
          : totalSucceeded > 0
            ? 'PARTIAL'
            : 'FAILED';

      this.functionLabRepo.recordExecution({
        correlationId,
        functionId: resolvedDef?.functionId || `custom_${primary.funcName}`,
        functionName: primary.funcName,
        functionVersion: resolvedDef?.version || 1,
        telegramUserId: adminId,
        sessionId: results.map((r) => r.session.id).join(','),
        executionMode: effectiveMode,
        status: finalStatus,
        failureCategory,
        durationMs: overallDurationMs,
        argsPreview: {
          targetJid: primary.targetJid,
          iterations,
          maxSends: effectiveMaxSends,
          delayMs: effectiveDelayMs,
          scope: effectiveScope,
        },
        resultSummary: `succeeded=${totalSucceeded}/${totalRequested} sends=${totalSends}`,
        errorMessageAr: lastError,
        diagnostics: {
          sendMessageCount: totalSendMsg,
          relayMessageCount: totalRelayMsg,
          presenceCount: totalPresence,
        },
      });

      this.diagnosticLogger.recordDiagnostic({
        correlationId,
        timestamp: new Date().toISOString(),
        functionName: primary.funcName,
        sessionId: results[0].session.id,
        mode: effectiveMode,
        status: finalStatus,
        failureCategory,
        durationMs: overallDurationMs,
        userMessageAr: lastError || 'اكتمل التنفيذ بنجاح',
        sanitizedDetails: {
          iterationsRequested: totalRequested,
          iterationsSucceeded: totalSucceeded,
          sendCount: totalSends,
        },
      });

      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'TOOL_TEST_FUNCTION',
        targetId: primary.targetJid,
        outcome: totalSucceeded > 0 ? 'SUCCESS' : 'FAILURE',
        metadata: {
          correlationId,
          executionMode: effectiveMode,
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

      const modeBadge =
        effectiveMode === 'DRY_RUN'
          ? '🧪 فحص جاف (DRY_RUN — بدون إرسال فعلي)'
          : effectiveMode === 'SIMULATION'
            ? '🔬 محاكاة معزولة (SIMULATION)'
            : '📡 تنفيذ حي (LIVE)';

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
          `🔖 *المرجع التشخيصي (Correlation ID):* \`${correlationId}\`\n` +
          `🎛️ *وضع التشغيل:* ${modeBadge}\n` +
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
          (failureCategory ? `\n🏷️ *فئة الخطأ:* \`${failureCategory}\`` : '') +
          (lastError ? `\n⚠️ *آخر خطأ مسجل:* \`${lastError}\`` : ''),
        keyboard: [
          [
            {
              text: '💾 حفظ هذه الدالة في المكتبة',
              callbackData: 'tools:flab_prompt_save',
            },
            {
              text: '📚 مكتبة الدوال',
              callbackData: 'tools:flab_catalog',
            },
          ],
          [
            {
              text: '⚙️ تعديل حد الإرسال والإعدادات',
              callbackData: 'tools:prompt_testfunction',
            },
            {
              text: '🛑 إيقاف الدالة الجارية',
              callbackData: 'tools:flab_stop',
            },
          ],
          [
            {
              text: '🔢 تغيير الحد الأقصى يدوياً',
              callbackData: 'tools:tf_prompt_max',
            },
            {
              text: '📱 فحص المقابس (/ceksender)',
              callbackData: 'tools:ceksender',
            },
          ],
          [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      const classified = classifyFunctionError(err, 'VALIDATE');
      this.functionLabRepo.recordExecution({
        correlationId,
        functionId: 'unparsed_error',
        functionName: 'unknown',
        telegramUserId: adminId,
        executionMode: this.selectedModeByAdmin.get(adminId) || 'LIVE',
        status: 'FAILED',
        failureCategory: classified.category,
        durationMs: Date.now() - startTime,
        errorMessageAr: safeErr.userMessage,
      });
      return {
        text:
          `⚠️ *تعذر تنفيذ /testfunction:*\n${safeErr.userMessage}\n\n` +
          `🔖 *المرجع التشخيصي:* \`${correlationId}\` (\`${classified.category}\`)`,
        keyboard: [
          [
            {
              text: '📚 اختيار دالة من المكتبة',
              callbackData: 'tools:flab_catalog',
            },
            {
              text: '🔄 إعادة المحاولة',
              callbackData: 'tools:prompt_testfunction',
            },
          ],
          [{ text: '🔙 قائمة الأدوات', callbackData: 'menu:tools' }],
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
   * Implements `/ceksender` & Sender Management (`menu:senders:page:<n>`) —
   * paginated inspection of all sessions, sockets, and InMemoryStore stats.
   */
  public renderSenderDiagnostics(page = 1): BotViewResponse {
    const sessions = this.sessionManager.listSessions();
    if (sessions.length === 0) {
      return {
        text:
          `📱 *إدارة وفحص مقابس وجلسات الإرسال (/ceksender)*\n\n` +
          `لا توجد جلسات مسجلة حالياً. استخدم زر **📲 ربط حساب واتساب** أو الأمر \`/requestpair +966501234567\` لإضافة جلسة.`,
        keyboard: [
          [{ text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' }],
          buildAppNavigationRow({
            backCallback: 'nav:back',
            refreshCallback: 'menu:senders:page:1',
          }),
        ],
        toastText: '📱 لا توجد جلسات مسجلة حالياً',
        route: 'menu:senders:page:1',
      };
    }

    const pageSize = 4;
    const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIdx = (currentPage - 1) * pageSize;
    const slice = sessions.slice(startIdx, startIdx + pageSize);

    const lines = slice.map((sess, idx) => {
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
        `${startIdx + idx + 1}. *${sess.label}* (\`${sess.id}\`)\n` +
        `   📌 الحالة: ${formatSessionStatusArabic(sess.status)}\n` +
        `   📱 الرقم المقنع: \`${sess.masked_phone || 'غير مقترن'}\`\n` +
        `   ${socketSummary}`
      );
    });

    const rows: InlineKeyboardRows = [];
    for (const sess of slice) {
      rows.push([
        {
          text: `⚙️ إدارة المقبس: ${sess.label} (${sess.id})`,
          callbackData: `sess:view:${sess.id}`,
        },
      ]);
    }

    if (totalPages > 1) {
      const navRow: InlineButtonSpec[] = [];
      if (currentPage > 1) {
        navRow.push({
          text: '⬅️ السابق',
          callbackData: `menu:senders:page:${currentPage - 1}`,
        });
      }
      navRow.push({
        text: `صفحة ${currentPage}/${totalPages}`,
        callbackData: `menu:senders:page:${currentPage}`,
      });
      if (currentPage < totalPages) {
        navRow.push({
          text: 'التالي ➡️',
          callbackData: `menu:senders:page:${currentPage + 1}`,
        });
      }
      rows.push(navRow);
    }

    rows.push([
      { text: '➕ ربط مرسل جديد', callbackData: 'menu:link_account' },
      { text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' },
    ]);

    rows.push(
      buildAppNavigationRow({
        backCallback: 'nav:back',
        refreshCallback: `menu:senders:page:${currentPage}`,
      })
    );

    return {
      text:
        `📱 *تقرير فحص جلسات ومقابس واتساب (/ceksender)*\n` +
        `إجمالي المرسلين: *${sessions.length}* (صفحة ${currentPage}/${totalPages})\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${lines.join('\n\n')}`,
      keyboard: rows,
      toastText: `🔌 إدارة المرسلين (صفحة ${currentPage}/${totalPages})`,
      route: `menu:senders:page:${currentPage}`,
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
          { text: '📡 حالة الجلسات', callbackData: 'menu:session_status' },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:tools',
          refreshCallback: 'tools:cekall',
        }),
      ],
      toastText: '📊 التقرير الشامل للنظام',
      route: 'tools:cekall',
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
        [{ text: '📊 التقرير الشامل (/cekall)', callbackData: 'tools:cekall' }],
        buildAppNavigationRow({
          backCallback: 'menu:tools',
          refreshCallback: 'tools:info',
        }),
      ],
      toastText: '🪪 بطاقة معلومات الحساب',
      route: 'tools:info',
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
