import crypto from 'node:crypto';
import { BotViewResponse } from '../workflows/pairing-workflow';
import {
  CyberForensicsOsintEngine,
  ForensicInvestigationMode,
  PhoneForensicReport,
  parseAndNormalizePhoneInput,
} from '../../security/cyber-forensics-osint-engine';
import {
  extractTikTokVideoTimestamp,
  probeUsernameMultiPlatform,
} from '../../security/osint-modules/username-social-osint';
import {
  generateAndProbeEmailPermutations,
  runFullEmailForensicDossier,
} from '../../security/osint-modules/email-breach-osint';
import { runFullDomainOrIpForensicDossier } from '../../security/osint-modules/domain-ip-threat-osint';
import {
  extractMediaForensicMetadata,
  sanitizeImageMetadata,
} from '../../security/osint-modules/media-exif-forensics';
import {
  buildGeoSatelliteAndStreetMapMatrix,
  lookupAviationOsint,
  lookupMaritimeVesselOsint,
} from '../../security/osint-modules/geo-aviation-maritime-osint';
import {
  inspectCryptoWalletOsint,
  searchCorporateAndSanctionsOsint,
} from '../../security/osint-modules/corporate-crypto-sanctions-osint';
import {
  buildPeopleAndDorkDossier,
  inspectWebArchiveSnapshots,
} from '../../security/osint-modules/archive-dorks-people-osint';
import { getPaginatedOsintCatalog } from '../../security/osint-modules/osint-catalog';
import {
  InlineButtonSpec,
  buildAppNavigationRow,
  buildBackCancelRow,
  buildCyberForensicsMenuKeyboard,
} from '../keyboards/main-menu';

export type BotViewPayload = BotViewResponse;
export type TelegramInlineButton = InlineButtonSpec;

export type CyberForensicsInputStep =
  | 'IDLE'
  | 'AWAITING_SMART_SCAN_INPUT'
  | 'AWAITING_PHONE_FOR_NAMES'
  | 'AWAITING_PHONE_FOR_SOCIAL'
  | 'AWAITING_PHONE_FOR_BREACHES'
  | 'AWAITING_PHONE_FOR_TEN_ENGINES'
  | 'AWAITING_HANDLE_OR_EMAIL_PIVOT'
  | 'AWAITING_PHONE_FOR_FULL_DOSSIER'
  | 'AWAITING_USERNAME_MODULE'
  | 'AWAITING_EMAIL_MODULE'
  | 'AWAITING_DOMAIN_IP_MODULE'
  | 'AWAITING_MEDIA_EXIF_UPLOAD'
  | 'AWAITING_GEO_TRANSPORT_MODULE'
  | 'AWAITING_CORP_CRYPTO_MODULE'
  | 'AWAITING_ARCHIVE_DORKS_MODULE'
  | 'AWAITING_TRUECALLER_LOGIN_PHONE'
  | 'AWAITING_TRUECALLER_LOGIN_OTP'
  | 'AWAITING_TRUECALLER_TOKEN_MANUAL'
  | 'AWAITING_EYECON_AUTH'
  | 'AWAITING_NUMVERIFY_KEY'
  | 'AWAITING_LEAKCHECK_KEY';

/**
 * Escapes characters that break Telegram legacy `Markdown` (`_`, `*`, `` ` ``, `[`, `]`)
 * inside dynamic text values so `bot.ts` NEVER strips formatting or falls back to plain text!
 */
export function escapeTelegramLegacyMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/[_*`[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitizes URLs for Telegram legacy Markdown `[Label](URL)` by percent-encoding
 * parentheses `(` and `)` and spaces so the link parser never breaks or dumps raw URLs.
 */
export function sanitizeMarkdownUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'https://www.google.com';
  }
  return trimmed
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\s+/g, '%20');
}

/**
 * Builds a guaranteed-safe clickable Telegram Markdown hyperlink `[Label](URL)`.
 */
export function mdLink(label: string, rawUrl: string): string {
  const safeLabel = escapeTelegramLegacyMarkdown(label) || 'فتح الرابط';
  const safeUrl = sanitizeMarkdownUrl(rawUrl);
  return `[${safeLabel}](${safeUrl})`;
}

/**
 * Safely truncates a Telegram Markdown report below the 4096-character limit without
 * slicing in the middle of a `[label](url)` link or leaving unclosed `*` / `` ` `` markers.
 */
export function truncateSafeTelegramMarkdown(text: string, maxChars = 3950): string {
  if (text.length <= maxChars) return text;
  const footerLine1 = '────────────────────────';
  const footerLine2 =
    'ℹ️ *تم اختصار العرض لحجم الرسالة؛ اضغط زر (📥 تصدير التقرير الكامل JSON) أدناه.*';
  const reservedChars = footerLine1.length + footerLine2.length + 4;
  const lines = text.split('\n');
  const kept: string[] = [];
  let lengthSoFar = 0;
  for (const line of lines) {
    if (lengthSoFar + line.length + 1 > maxChars - reservedChars) {
      break;
    }
    kept.push(line);
    lengthSoFar += line.length + 1;
  }
  kept.push(footerLine1);
  kept.push(footerLine2);
  return kept.join('\n');
}

export function clampTelegramMessage(text: string, maxLen = 3950): string {
  return truncateSafeTelegramMarkdown(text, maxLen);
}

export class CyberForensicsHandler {
  private readonly stepByAdmin = new Map<number, CyberForensicsInputStep>();
  private readonly lastReportByPhone = new Map<string, PhoneForensicReport>();
  private readonly uploadedMediaCache = new Map<
    string,
    { buffer: Buffer; fileName: string; mimeType?: string }
  >();

  public constructor(
    private readonly engine: CyberForensicsOsintEngine,
    private readonly _auditRepo?: unknown
  ) {}

  public getEngine(): CyberForensicsOsintEngine {
    return this.engine;
  }

  public getInputStep(adminId: number): CyberForensicsInputStep {
    return this.stepByAdmin.get(adminId) ?? 'IDLE';
  }

  public setInputStep(adminId: number, step: CyberForensicsInputStep): void {
    this.stepByAdmin.set(adminId, step);
  }

  public clearState(adminId: number): void {
    this.stepByAdmin.delete(adminId);
  }

  public cancelWorkflow(adminId: number): void {
    this.stepByAdmin.delete(adminId);
  }

  public renderMainMenu(): BotViewPayload {
    const tcConfigured = Boolean(this.engine.getTruecallerInstallationId());
    const eyeconConfigured = Boolean(this.engine.getEyeconCredentials().eAuth);
    const numverifyConfigured = Boolean(this.engine.getNumverifyApiKey());
    const leakcheckConfigured = Boolean(this.engine.getLeakCheckApiKey());
    const recentCount = this.engine.getRecentForensicHistory().length;

    const text = [
      '🕵️‍♂️ *قسم التحليل الجنائي السيبراني واستخبارات الأرقام (Cyber Forensics & OSINT)*',
      '────────────────────────',
      'منصة فحص استخباراتي متكاملة تعمل بـ **8 محركات حية متوازية** لكشف الهوية الرقمية الكاملة لأي رقم هاتف أو معرّف:',
      '',
      '1️⃣ *استخبارات واتساب العميقة (Baileys Full USync + Business + Groups)*:',
      '   • كشف حالة التسجيل، معرّف `@lid` المقنّع، عدد الأجهزة المربوطة، والـ `PushName`.',
      '   • جلب الصورة الشخصية بدقة كاملة، حالة التواجد (`Presence`)، السيرة الذاتية (`Bio`)، والمجموعات المشتركة.',
      '2️⃣ *أدلة كشف الهوية العالمية (Truecaller + Eyecon + Numverify + OVH)*:',
      '   • استخراج الأسماء المسجلة، الوظيفة، البريد الإلكتروني، وصورة وحساب فيسبوك عبر Eyecon Graph.',
      '3️⃣ *فحص الحسابات الاجتماعية الصامت (Instagram Liger/Web + Snapchat + Amazon + Telegram)*:',
      '   • فحص ارتباط الرقم بحسابات Instagram ورموز استرداد Meta والـ Email المقنّع، وفحص `TAKEN_NUMBER` في Snapchat.',
      '4️⃣ *كاشف التسريبات وبرمجيات Infostealer (Hudson Rock + LeakCheck + COMB 3.2B + Pastebin + Git)*:',
      '   • فحص قواعد البيانات المسربة وسجلات الأجهزة المصابة ومستودعات الكود العامة.',
      '5️⃣ *الزاحف المتوازي عبر 10 محركات بحث عالمية (10-Engine Parallel Scraper)*:',
      '   • استعلام حي متزامن في `DuckDuckGo HTML/Lite`, `Brave`, `Bing`, `Yahoo`, `Mojeek`, `Startpage`, `Yandex`, `SearXNG`, `Ahmia`.',
      '────────────────────────',
      `🔑 *Truecaller API*: ${tcConfigured ? '🟢 مفعّل وجاهز' : '⚪ غير مضبوط'} | *Eyecon*: ${
        eyeconConfigured ? '🟢 مفعّل' : '⚪ غير مضبوط'
      }`,
      `📡 *Numverify*: ${numverifyConfigured ? '🟢 مفعّل' : '⚪ محلي/OVH'} | *LeakCheck*: ${
        leakcheckConfigured ? '🟢 Pro/Public' : '🟢 Public API (10B+)'
      } | 🗂️ *السجل*: \`${recentCount}\``,
      '────────────────────────',
      'اختر الأداة المطلوبة من القائمة أدناه:',
    ].join('\n');

    return {
      text,
      keyboard: buildCyberForensicsMenuKeyboard(),
      route: 'menu:cyber_forensics',
    };
  }

  public renderDashboard(): BotViewPayload {
    return this.renderMainMenu();
  }

  public promptPhoneLookup(adminId: number): BotViewPayload {
    return this.promptPhoneNamesLookup(adminId);
  }

  public promptPhoneNamesLookup(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_PHONE_FOR_NAMES');
    return {
      text: [
        '📇 *قسم البحث عن رقم الهاتف وكشف الأسماء المرتبطة (Caller-ID & Identity Lookup)*',
        '────────────────────────',
        'أرسل رقم الهاتف الآن بأي صيغة (دولية مثل `+967775224395` أو محلية مثل `775224395`):',
        '',
        'سيقوم المحرك بفحص:',
        '• **WhatsApp Protocol USync** (`PushName` + `Verified Business Name` + `LID` + `Shared Groups`)',
        '• **Truecaller Global Directory** (الاسم الأساسي والبديل والوظيفة والبريد)',
        '• **Eyecon Caller-ID** (قائمة الأسماء المحفوظة لدى جهات الاتصال + صورة الحساب)',
        '• **Numverify & OVH Telecom** (الشركة المشغلة ونوع الخط والمنطقة الجغرافية)',
        '• **خزنة الأسماء المحلية والمصادر المفتوحة (10 محركات بحث)**',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:phone_lookup',
    };
  }

  public promptSocialLookup(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_PHONE_FOR_SOCIAL');
    return {
      text: [
        '🌐 *كشف الحسابات والمنصات المرتبطة بالرقم (Social Footprint Scanner)*',
        '────────────────────────',
        'أرسل رقم الهاتف المراد فحصه (مثال: `+967775224395`):',
        '',
        'سيقوم المحرك بفحص ارتباط الرقم بالمنصات التالية دون إرسال أي إشعار للهدف:',
        '• **WhatsApp & WhatsApp Business** (مع جلب الصورة الشخصية عالية الدقة)',
        '• **Instagram & Meta Graph** (فحص `users/lookup` + `account_recovery` + `can_wa_reset`)',
        '• **Snapchat** (فحص التسجيل المباشر `TAKEN_NUMBER` عبر `validate_phone_number`)',
        '• **Amazon** (فحص البصمة عبر OpenID Sign-In Probe)',
        '• **Facebook** (استخراج الحساب المباشر عبر Eyecon Graph Redirect)',
        '• **Telegram & GitHub & Reddit & GitLab & Keybase & TikTok & X** (فحص المعرّفات المكتشفة)',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
    };
  }

  public promptBreachLookup(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_PHONE_FOR_BREACHES');
    return {
      text: [
        '🔓 *فحص التسريبات والاختراقات وسجلات Infostealer (Breach & DarkWeb Intelligence)*',
        '────────────────────────',
        'أرسل رقم الهاتف المراد فحصه في قواعد البيانات المسربة (مثال: `+967775224395`):',
        '',
        'يقوم هذا المحرك بفحص الرقم (وأي بريد إلكتروني أو يوزر مرتبط به) عبر **6 قواعد بيانات جنائية حية**:',
        '• **Hudson Rock Cavalier API**: كشف إصابة أجهزة الهدف ببرمجيات سحب الكوكيز وكلمات المرور (`RedLine`, `Raccoon`, `Lumma`).',
        '• **LeakCheck (10+ Billion Records)**: فحص ظهور الرقم أو البريد في تسريبات قواعد البيانات العالمية.',
        '• **ProxyNova COMB (3.2 Billion Credentials)**: البحث في أرشيف بيانات الاعتماد المسربة.',
        '• **XposedOrNot Breach Registry**: سجل حوادث التسريب العالمية الموثقة.',
        '• **PSBDMP Pastebin Dump Archive**: البحث في ملفات Pastebin المسربة.',
        '• **Grep.app Git Code Scanner**: البحث عن الرقم أو البريد داخل مستودعات الكود العامة (`GitHub`/`GitLab`).',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
    };
  }

  public promptTenEnginesLookup(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_PHONE_FOR_TEN_ENGINES');
    return {
      text: [
        '🕸️ *الزحف الاستخباراتي المتوازي عبر 10 محركات بحث (10-Engine Parallel OSINT Scraper)*',
        '────────────────────────',
        'أرسل رقم الهاتف ليتم استعلامه بالتوازي في **10 محركات بحث مستقلة في نفس اللحظة**:',
        '',
        '1. `DuckDuckGo HTML`  |  2. `DuckDuckGo Lite`',
        '3. `Brave Search`     |  4. `Microsoft Bing`',
        '5. `Yahoo Search`     |  6. `Mojeek Index`',
        '7. `Startpage Proxy`  |  8. `Yandex Web`',
        '9. `SearXNG Meta`     |  10. `Ahmia DeepWeb`',
        '',
        'يستخرج الزاحف تلقائياً: الأسماء المنشورة، عناوين البريد الإلكتروني، حسابات التواصل، ويكشف أرقام الـ SMS المؤقتة (`Burner/Disposable`).',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
    };
  }

  public promptHandleOrEmailPivot(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_HANDLE_OR_EMAIL_PIVOT');
    return {
      text: [
        '🧬 *تتبع يوزر أو بريد إلكتروني عبر المنصات والتسريبات (Username & Email OSINT Pivot)*',
        '────────────────────────',
        'أرسل الآن **اسم المستخدم (Username)** مثل `@ahmed_dev` أو **البريد الإلكتروني** مثل `user@domain.com`:',
        '',
        'سيقوم المحرك بالتحقق الفعلي المباشر عبر:',
        '• **المنصات البرمجية والاجتماعية**: `Telegram`, `GitHub`, `Reddit`, `GitLab`, `Keybase`, `X/Twitter`, `TikTok`, `Duolingo`, `Gravatar`.',
        '• **قواعد بيانات التسريبات و Infostealers**: `Hudson Rock Cavalier`, `LeakCheck`, `ProxyNova COMB`, `XposedOrNot`, `PSBDMP Pastebin`, `Grep.app Code`.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
    };
  }

  public promptFullScan(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_PHONE_FOR_FULL_DOSSIER');
    return {
      text: [
        '☢️ *التحقيق الجنائي الشامل للرقم (Full OSINT & Cyber Forensics Dossier)*',
        '────────────────────────',
        'أرسل رقم الهاتف المستهدف الآن لتنفيذ مسح جنائي شامل عبر **جميع المحركات الثمانية بالتوازي**:',
        '1. تحليل البنية الدولية والوطنية والمشغل (`PhoneInfoga` + `Numverify` + `OVH`).',
        '2. استجواب بروتوكول واتساب الحي (`USync` + `LID` + `Business` + `Shared Groups` + `Photo`).',
        '3. استعلام أدلة الهوية العالمية (`Truecaller` + `Eyecon`).',
        '4. الفحص غير المُنبه للمنصات (`Instagram` + `Snapchat` + `Amazon` + `Telegram` + `Facebook`).',
        '5. الزحف المتوازي عبر **10 محركات بحث عالمية** واستخراج الإيميلات واليوزرات.',
        '6. فحص التسريبات وبرمجيات `Infostealer` وأرشيف `Pastebin` و `Git`.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:full_scan',
    };
  }

  public promptSmartAutoScan(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_SMART_SCAN_INPUT');
    return {
      text: [
        '🧠 *الفحص الجنائي الذكي الشامل (Smart Auto-Detect OSINT Router)*',
        '────────────────────────',
        'أرسل الآن **أي معرّف أو هدف رقمي** وسيقوم المحرك بالتعرف على نوعه وتوجيهه تلقائياً:',
        '• 📱 **رقم هاتف** (`+967775224395`) ⬅️ فحص شامل للرقم وواتساب وTruecaller والتسريبات',
        '• 📧 **بريد إلكتروني** (`user@domain.com`) ⬅️ فحص Hudson Rock وGravatar وDNS والتسريبات',
        '• 🌐 **نطاق أو عنوان IP** (`example.com` أو `8.8.8.8`) ⬅️ فحص crt.sh وShodan InternetDB وDNS وCMS',
        '• 🎬 **رابط أو معرف فيديو TikTok** ⬅️ استخراج لحظة الرفع الدقيقة بالثانية (Snowflake UTC)',
        '• ₿ **محفظة عملات رقمية** (`bc1...` أو `0x...`) ⬅️ فحص الرصيد والمعاملات عبر Mempool/Ethplorer',
        '• 👤 **اسم مستخدم** (`@username`) ⬅️ فحص متوازٍ عبر 35+ منصة تقنية واجتماعية وألعاب + Reddit',
        '• 🖼️ **صورة أو مستند PDF** ⬅️ استخراج بصمة EXIF وإحداثيات GPS وحساب زاوية الشمس والظل',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:smart_scan',
    };
  }

  public promptUsernameModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_USERNAME_MODULE');
    return {
      text: [
        '👤 *وحدة استخبارات المعرفات والشبكات والألعاب (35+ منصة + Reddit + TikTok)*',
        '────────────────────────',
        'أرسل الآن أحد المدخلات التالية:',
        '1️⃣ **اسم مستخدم** (مثل `torvalds` أو `@spez`) لفحصه عبر **35+ منصة** بالتوازي مع تحليل حساب **Reddit** (`Redective`) وتوزيع ساعات النشاط.',
        '2️⃣ **رابط أو معرف فيديو TikTok** (مثل `https://www.tiktok.com/@user/video/7123456789012345678`) لاستخراج التاريخ والوقت الدقيق لرفع الفيديو بالثانية (`UTC`) عبر خوارزمية Bellingcat.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:username',
    };
  }

  public promptEmailModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_EMAIL_MODULE');
    return {
      text: [
        '📧 *وحدة استخبارات البريد الإلكتروني والتسريبات وتوليد الصيغ المؤسسية*',
        '────────────────────────',
        'أرسل الآن أحد المدخلات التالية:',
        '1️⃣ **بريد إلكتروني** (مثل `name@company.com`) لفحص:',
        '   • برمجيات سرقة البيانات (`Hudson Rock Cavalier`)',
        '   • الهوية والحسابات الموثقة (`Gravatar MD5`)',
        '   • التسجيل في `GitHub Commits`, `WordPress.com`, `Spotify`, `Duolingo`',
        '   • سجلات أمان البريد `MX`, `SPF`, `DMARC` وكشف البريد المؤقت.',
        '2️⃣ **الاسم الأول والأخير والنطاق** (مثال: `Ahmed Saleh company.com`) لتوليد **12 صيغة بريد مؤسسي** وفحصها حياً.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:email',
    };
  }

  public promptDomainIpModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_DOMAIN_IP_MODULE');
    return {
      text: [
        '🌐 *وحدة استخبارات النطاقات وعناوين IP وفحص المنافذ والثغرات*',
        '────────────────────────',
        'أرسل الآن **اسم نطاق (Domain)** مثل `example.com` أو **عنوان IPv4** مثل `1.1.1.1`:',
        '• **crt.sh Certificate Transparency**: استخراج النطاقات الفرعية وشهادات SSL.',
        '• **Shodan InternetDB**: كشف المنافذ المفتوحة (`Ports`) والخدمات (`CPEs`) والثغرات (`CVEs`).',
        '• **DNS & HostSearch**: تحليل سجلات `A`, `AAAA`, `MX`, `NS`, `TXT` والمضيفين الفرعيين.',
        '• **WhatCMS & WAF Detector**: كشف نظام إدارة المحتوى وجدار الحماية وسمعة الـ IP.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:domain_ip',
    };
  }

  public promptMediaForensicsModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_MEDIA_EXIF_UPLOAD');
    return {
      text: [
        '🖼️ *مختبر الجنائيات الرقمية للصور والوسائط والمستندات (EXIF / GPS / ExifPurge)*',
        '────────────────────────',
        'أرسل الآن **صورة (كمستند أو صورة)** أو **ملف PDF** ليقوم المختبر بـ:',
        '1. حساب البصمات الجنائية المعتمدة (`MD5`, `SHA-1`, `SHA-256`).',
        '2. استخراج بيانات الكاميرا والعدسة والبرنامج وتاريخ الالتقاط الأصلي (`EXIF / TIFF / XMP / PNG Chunks`).',
        '3. استخراج إحداثيات `GPS` الجغرافية وتحويلها إلى درجات عشرية مع حساب **زاوية الشمس واتجاه الظل (`SunCalc`)** لحظة التصوير.',
        '4. إتاحة زر **🧹 تطهير الصورة من بيانات EXIF/GPS (`ExifPurge`)** وإعادة إرسال نسخة نظيفة آمنة.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:media',
    };
  }

  public promptGeoTransportModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_GEO_TRANSPORT_MODULE');
    return {
      text: [
        '✈️ *وحدة استخبارات الطيران والملاحة البحرية والأقمار الصناعية وتحليل الظلال*',
        '────────────────────────',
        'أرسل الآن أحد المدخلات التالية:',
        '• **إحداثيات جغرافية أو اسم مدينة/معلم** (مثال: `15.3694, 44.1910` أو `Sanaa`) لحساب زاوية الشمس واتجاه الظل (`SunCalc` / `ShadeMap`) وتوليد مصفوفة خرائط الأقمار الصناعية (`Google`, `Yandex`, `Bing`, `Satellites.pro`, `Wikimapia`, `GPSJam`).',
        '• **كود طائرة سداسي ICAO24 أو رمز رحلة** (مثال: `icao:896450` أو `flight:SVA123`) لفحص حالة الطيران الحية عبر `OpenSky-Network` وبيانات التسجيل عبر `HexDB` و`ADS-B Exchange`.',
        '• **رقم سفينة بحري MMSI (9 أرقام) أو IMO** (مثال: `mmsi:403123456` أو `imo:9811000`) لتتبع السفينة عبر `MarineTraffic` و`VesselFinder`.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:geo_transport',
    };
  }

  public promptCorpCryptoModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_CORP_CRYPTO_MODULE');
    return {
      text: [
        '🏛️ *وحدة استخبارات الشركات والعقوبات الدولية ومحافظ العملات الرقمية*',
        '────────────────────────',
        'أرسل الآن أحد المدخلات التالية:',
        '1️⃣ **عنوان محفظة عملات رقمية**:',
        '   • **Bitcoin (`1...`, `3...`, `bc1...`)** ⬅️ فحص الرصيد والمعاملات الحية عبر `Mempool.space` و`BitRef`.',
        '   • **Ethereum / EVM (`0x...`)** ⬅️ فحص رصيد ETH والتوكنات عبر `Ethplorer` و`Etherscan`.',
        '   • **TRON (`T...`) أو Monero (`4...`)** ⬅️ روابط الفحص الجنائي للكتل.',
        '2️⃣ **اسم شركة أو شخصية أو كيان تجاري** ⬅️ البحث المباشر في أرشيف `OCCRP Aleph` الاستقصائي مع روابط `OpenCorporates`, `OpenSanctions`, `ICIJ Offshore Leaks`, و`ImportYeti`.',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:corp_crypto',
    };
  }

  public promptArchiveDorksModule(adminId: number): BotViewPayload {
    this.setInputStep(adminId, 'AWAITING_ARCHIVE_DORKS_MODULE');
    return {
      text: [
        '🕰️ *وحدة الأرشيف التاريخي للمواقع (Wayback CDX) ودوركس البحث عن الأشخاص*',
        '────────────────────────',
        'أرسل الآن أحد المدخلات التالية:',
        '1️⃣ **رابط موقع أو نطاق** (مثال: `example.com`) لاستخراج اللقطات التاريخية المحفوظة عبر `Wayback Machine CDX API` و`Archive.today`.',
        '2️⃣ **اسم شخص أو جهة أو مصطلح استقصائي** لتوليد **8 استعلامات Google Advanced Dorks** (ملفات PDF/DOCX، تسريبات Pastebin/GitHub، فهارس مفتوحة، وسجلات الأشخاص والمحاكم `WebMii`, `PeekYou`, `UniCourt`).',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      route: 'cyber:mod:archive_dorks',
    };
  }

  public renderOsintCatalogPage(page = 1): BotViewPayload {
    const cat = getPaginatedOsintCatalog(page, 12);
    const lines: string[] = [
      `🧰 *دليل أدوات الاستخبارات الجنائية المعتمدة (${cat.totalTools} أداة مجانية ومفتوحة)*`,
      `📄 الصفحة \`${cat.page}\` من \`${cat.totalPages}\``,
      '────────────────────────',
    ];

    for (const item of cat.items) {
      const modeBadge =
        item.executionMode === 'NATIVE_ENGINE'
          ? '⚙️ [محرك مدمج]'
          : item.executionMode === 'LIVE_API'
          ? '⚡ [API حي]'
          : '🔗 [رابط عميق]';
      lines.push(
        `*${item.id}.* ${mdLink(item.name, item.url)} ${modeBadge}`,
        `   └ _${escapeTelegramLegacyMarkdown(item.descriptionArabic)}_`
      );
    }

    const navRow: TelegramInlineButton[] = [];
    if (cat.page > 1) {
      navRow.push({
        text: '⬅️ الصفحة السابقة',
        callbackData: `cyber:catalog:page:${cat.page - 1}`,
      });
    }
    if (cat.page < cat.totalPages) {
      navRow.push({
        text: '➡️ الصفحة التالية',
        callbackData: `cyber:catalog:page:${cat.page + 1}`,
      });
    }

    const keyboard: TelegramInlineButton[][] = [];
    if (navRow.length > 0) keyboard.push(navRow);
    keyboard.push(buildAppNavigationRow('menu:cyber_forensics'));

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard,
      route: `cyber:catalog:page:${cat.page}`,
    };
  }

  public renderSettingsMenu(): BotViewPayload {
    const tcToken = this.engine.getTruecallerInstallationId();
    const eyecon = this.engine.getEyeconCredentials();
    const numverify = this.engine.getNumverifyApiKey();
    const leakcheck = this.engine.getLeakCheckApiKey();

    const maskToken = (val: string) =>
      val.length > 10
        ? `${escapeTelegramLegacyMarkdown(val.slice(0, 6))}...${escapeTelegramLegacyMarkdown(
            val.slice(-4)
          )}`
        : val
        ? 'مضبوط'
        : 'غير مضبوط';

    const text = [
      '🔑 *إعدادات مفاتيح ومصادقة محركات الاستخبارات (OSINT API Credentials)*',
      '────────────────────────',
      `1️⃣ *Truecaller Installation ID*: ${
        tcToken ? `🟢 \`${maskToken(tcToken)}\`` : '⚪ غير مضبوط'
      }`,
      `2️⃣ *Eyecon Auth (\`e-auth\`) & (\`e-auth-v\`) & (\`e-auth-c\`)*: ${
        eyecon.eAuth
          ? `🟢 \`${maskToken(eyecon.eAuth)}\` (v=${escapeTelegramLegacyMarkdown(
              eyecon.eAuthV
            )}, c=${escapeTelegramLegacyMarkdown(eyecon.eAuthC)})`
          : '⚪ غير مضبوط'
      }`,
      `3️⃣ *Numverify API Key (Apilayer)*: ${
        numverify ? `🟢 \`${maskToken(numverify)}\`` : '⚪ غير مضبوط'
      }`,
      `4️⃣ *LeakCheck API Key (Optional Pro)*: ${
        leakcheck ? `🟢 \`${maskToken(leakcheck)}\`` : '🟢 يعمل بالوضع العام المجاني (Public API)'
      }`,
      '────────────────────────',
      '💡 *ملاحظة هندسية*: محركات **WhatsApp USync**، **Instagram**، **Snapchat**، **Amazon**، **Hudson Rock Cavalier**، **LeakCheck Public**، **ProxyNova COMB**، **XposedOrNot**، **PSBDMP**، **Grep.app**، و**محركات البحث العشرة** تعمل جميعها فوراً وبدون أي مفاتيح خارجية.',
      'ولإضافة مفاتيح Truecaller أو Eyecon أو Numverify أو LeakCheck، استخدم الأزرار التالية:',
    ].join('\n');

    const keyboard: TelegramInlineButton[][] = [
      [
        {
          text: '📲 تسجيل دخول Truecaller عبر OTP',
          callbackData: 'cyber:tc_login_otp',
        },
      ],
      [
        {
          text: '🔑 إدخال رمز Truecaller يدوياً',
          callbackData: 'cyber:tc_set_token',
        },
        {
          text: '👁️ إعداد مفتاح Eyecon API',
          callbackData: 'cyber:eyecon_set',
        },
      ],
      [
        {
          text: '📡 إعداد مفتاح Numverify',
          callbackData: 'cyber:numverify_set',
        },
        {
          text: '🔓 إعداد مفتاح LeakCheck',
          callbackData: 'cyber:leakcheck_set',
        },
      ],
      buildAppNavigationRow('menu:cyber_forensics'),
    ];

    return { text, keyboard };
  }

  public renderHistoryPage(page = 1): BotViewPayload {
    const history = this.engine.getRecentForensicHistory();
    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(history.length / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const slice = history.slice((safePage - 1) * pageSize, safePage * pageSize);

    const lines: string[] = [
      `🗂️ *سجل التحقيقات الجنائية الرقمية (${history.length} رقم مفحوص)*`,
      `📄 الصفحة \`${safePage}\` من \`${totalPages}\``,
      '────────────────────────',
    ];

    const keyboard: TelegramInlineButton[][] = [];

    if (slice.length === 0) {
      lines.push('لا توجد عمليات فحص مسجلة حتى الآن. ابدأ بفحص أي رقم من القائمة.');
    } else {
      slice.forEach((item, idx) => {
        const numIndex = (safePage - 1) * pageSize + idx + 1;
        const safeName = escapeTelegramLegacyMarkdown(item.topName);
        const safeCountry = escapeTelegramLegacyMarkdown(item.countryAr);
        const safeCarrier = escapeTelegramLegacyMarkdown(item.carrier);
        lines.push(
          `*${numIndex}.* \`${item.phoneE164}\` — *${safeName}*`,
          `   🌍 ${safeCountry} | 📡 ${safeCarrier} | 📇 أسماء: \`${item.namesCount}\` | 🌐 حسابات: \`${item.socialCount}\` | 🔓 تسريبات: \`${item.breachCount ?? 0}\``
        );
        const digits = item.phoneE164.replace(/\D/g, '');
        keyboard.push([
          {
            text: `🔍 إعادة فحص ${item.phoneE164}`,
            callbackData: `cyber:rescan:${digits}`,
          },
        ]);
      });
    }

    const navRow: TelegramInlineButton[] = [];
    if (safePage > 1) {
      navRow.push({
        text: '⬅️ السابق',
        callbackData: `cyber:history:page:${safePage - 1}`,
      });
    }
    if (safePage < totalPages) {
      navRow.push({
        text: '➡️ التالي',
        callbackData: `cyber:history:page:${safePage + 1}`,
      });
    }
    if (navRow.length > 0) keyboard.push(navRow);
    keyboard.push(buildAppNavigationRow('menu:cyber_forensics'));

    return {
      text: lines.join('\n'),
      keyboard,
    };
  }

  public async handleTextInput(
    adminId: number,
    rawText: string
  ): Promise<BotViewPayload> {
    const step = this.getInputStep(adminId);
    if (step === 'IDLE') return this.renderMainMenu();

    const trimmed = rawText.trim();

    if (step === 'AWAITING_TRUECALLER_LOGIN_PHONE') {
      const res = await this.engine.initiateTruecallerLoginOtp(adminId, trimmed);
      if (res.ok) {
        this.setInputStep(adminId, 'AWAITING_TRUECALLER_LOGIN_OTP');
        return {
          text: `📲 *${escapeTelegramLegacyMarkdown(res.message)}*\n\nأرسل الآن رمز الـ OTP المكون من 6 أرقام الذي وصلك على الهاتف:`,
          keyboard: [buildBackCancelRow('cyber:settings')],
        };
      }
      return {
        text: `⚠️ *${escapeTelegramLegacyMarkdown(res.message)}*`,
        keyboard: [buildBackCancelRow('cyber:settings')],
      };
    }

    if (step === 'AWAITING_TRUECALLER_LOGIN_OTP') {
      const res = await this.engine.verifyTruecallerLoginOtp(adminId, trimmed);
      this.setInputStep(adminId, 'IDLE');
      return {
        text: `${res.ok ? '✅' : '⚠️'} *${escapeTelegramLegacyMarkdown(res.message)}*`,
        keyboard: this.renderSettingsMenu().keyboard,
      };
    }

    if (step === 'AWAITING_TRUECALLER_TOKEN_MANUAL') {
      this.engine.setTruecallerInstallationId(trimmed);
      this.setInputStep(adminId, 'IDLE');
      return {
        text: '✅ *تم حفظ مفتاح Truecaller (`installationId`) بنجاح في قاعدة البيانات.*',
        keyboard: this.renderSettingsMenu().keyboard,
      };
    }

    if (step === 'AWAITING_EYECON_AUTH') {
      const parts = trimmed.split(/\s+/);
      const eAuth = parts[0] || '';
      const eAuthV = parts[1] || 'e1';
      const eAuthC = parts[2] || '40';
      this.engine.setEyeconCredentials(eAuth, eAuthV, eAuthC);
      this.setInputStep(adminId, 'IDLE');
      return {
        text: '✅ *تم حفظ بيانات مصادقة Eyecon Caller-ID بنجاح.*',
        keyboard: this.renderSettingsMenu().keyboard,
      };
    }

    if (step === 'AWAITING_NUMVERIFY_KEY') {
      this.engine.setNumverifyApiKey(trimmed);
      this.setInputStep(adminId, 'IDLE');
      return {
        text: '✅ *تم حفظ مفتاح Numverify API بنجاح.*',
        keyboard: this.renderSettingsMenu().keyboard,
      };
    }

    if (step === 'AWAITING_LEAKCHECK_KEY') {
      this.engine.setLeakCheckApiKey(trimmed);
      this.setInputStep(adminId, 'IDLE');
      return {
        text: '✅ *تم حفظ مفتاح LeakCheck API بنجاح.*',
        keyboard: this.renderSettingsMenu().keyboard,
      };
    }

    if (step === 'AWAITING_HANDLE_OR_EMAIL_PIVOT') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeIdentifierInvestigationView(adminId, trimmed);
    }

    if (step === 'AWAITING_SMART_SCAN_INPUT') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeSmartAutoScan(adminId, trimmed);
    }

    if (step === 'AWAITING_USERNAME_MODULE') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeUsernameModuleView(trimmed);
    }

    if (step === 'AWAITING_EMAIL_MODULE') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeEmailModuleView(trimmed);
    }

    if (step === 'AWAITING_DOMAIN_IP_MODULE') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeDomainIpModuleView(trimmed);
    }

    if (step === 'AWAITING_GEO_TRANSPORT_MODULE') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeGeoTransportModuleView(trimmed);
    }

    if (step === 'AWAITING_CORP_CRYPTO_MODULE') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeCorpCryptoModuleView(trimmed);
    }

    if (step === 'AWAITING_ARCHIVE_DORKS_MODULE') {
      this.setInputStep(adminId, 'IDLE');
      return this.executeArchiveDorksModuleView(trimmed);
    }

    if (step === 'AWAITING_MEDIA_EXIF_UPLOAD') {
      return {
        text: '🖼️ *يرجى إرسال ملف صورة (JPEG/PNG/WebP) أو مستند PDF مباشر ليتم استخراج بيانات EXIF/GPS وبصمات الهاش الجنائية منه.*',
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    let mode: ForensicInvestigationMode = 'FULL_DOSSIER';
    if (step === 'AWAITING_PHONE_FOR_NAMES') mode = 'PHONE_NAMES_ONLY';
    if (step === 'AWAITING_PHONE_FOR_SOCIAL') mode = 'SOCIAL_ONLY';
    if (step === 'AWAITING_PHONE_FOR_BREACHES') mode = 'BREACH_LEAKS_ONLY';
    if (step === 'AWAITING_PHONE_FOR_TEN_ENGINES') mode = 'TEN_ENGINES_SCRAPE_ONLY';

    this.setInputStep(adminId, 'IDLE');
    return this.executeInvestigationAndFormatView(adminId, trimmed, mode);
  }

  public async handleAdminTextInput(
    adminId: number,
    rawText: string
  ): Promise<BotViewPayload> {
    return this.handleTextInput(adminId, rawText);
  }

  public async executeSmartAutoScan(
    adminId: number,
    rawInput: string
  ): Promise<BotViewPayload> {
    const trimmed = rawInput.trim();
    if (/tiktok\.com\/.*\/video\/\d{15,22}|\b\d{18,20}\b/i.test(trimmed)) {
      return this.executeUsernameModuleView(trimmed);
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return this.executeEmailModuleView(trimmed);
    }
    if (
      /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,89}|0x[a-fA-F0-9]{40}|T[a-zA-Z0-9]{33})$/.test(
        trimmed
      )
    ) {
      return this.executeCorpCryptoModuleView(trimmed);
    }
    if (
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed) ||
      /^(?:https?:\/\/)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\:\d+)?(?:\/.*)?$/.test(
        trimmed
      )
    ) {
      return this.executeDomainIpModuleView(trimmed);
    }
    if (/^\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(trimmed)) {
      return this.executeGeoTransportModuleView(trimmed);
    }
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (
      /^[\d+\s()-]{8,20}$/.test(trimmed) &&
      digitsOnly.length >= 8 &&
      digitsOnly.length <= 15
    ) {
      return this.executeInvestigationAndFormatView(
        adminId,
        trimmed,
        'FULL_DOSSIER'
      );
    }
    return this.executeUsernameModuleView(trimmed);
  }

  public async executeUsernameModuleView(
    rawInput: string
  ): Promise<BotViewPayload> {
    const trimmed = rawInput.trim();
    if (/tiktok\.com|^\d{17,21}$/i.test(trimmed)) {
      const tt = extractTikTokVideoTimestamp(trimmed);
      const lines = [
        '🎬 *تحليل البصمة الزمنية لفيديو TikTok (Bellingcat Snowflake Extractor)*',
        '────────────────────────',
        `• *المدخل*: \`${escapeTelegramLegacyMarkdown(trimmed.slice(0, 90))}\``,
        `• *معرف الفيديو (Snowflake 64-bit)*: \`${tt.videoId || '—'}\``,
      ];
      if (tt.valid) {
        lines.push(
          `• *تاريخ ووقت الرفع الدقيق (UTC)*: \`${tt.arabicFormattedDate}\``,
          `• *الطابع الزمني (Unix Seconds)*: \`${tt.unixTimestampSeconds}\``,
          `• *ISO-8601*: \`${tt.utcIso}\``
        );
      } else {
        lines.push(`• ⚠️ *النتيجة*: ${escapeTelegramLegacyMarkdown(tt.errorReasonArabic)}`);
      }
      return {
        text: clampTelegramMessage(lines.join('\n')),
        keyboard: [
          [{ text: '👤 فحص معرف أو فيديو آخر', callbackData: 'cyber:mod:username' }],
          buildAppNavigationRow('menu:cyber_forensics'),
        ],
      };
    }

    const report = await probeUsernameMultiPlatform(trimmed);
    const confirmed = report.results.filter((r) => r.status === 'CONFIRMED');
    const lines: string[] = [
      `👤 *تقرير فحص اسم المستخدم الشامل (35+ منصة تقنية واجتماعية وألعاب)*`,
      `🎯 *المعرّف*: \`@${escapeTelegramLegacyMarkdown(report.normalizedUsername)}\``,
      `📊 *الحسابات المؤكدة*: \`${confirmed.length}\` من أصل \`${report.probedCount}\` منصة مفحوصة`,
      '────────────────────────',
    ];

    if (confirmed.length === 0) {
      lines.push('• لم يتم رصد حسابات عامة مؤكدة بنفس المعرف عبر الفحص المباشر.');
    } else {
      lines.push('🟢 *الحسابات المؤكدة المكتشفة:*');
      for (const hit of confirmed.slice(0, 18)) {
        lines.push(
          `• *${escapeTelegramLegacyMarkdown(hit.platform)}*: ${mdLink(
            `@${report.normalizedUsername}`,
            hit.url
          )} — ${escapeTelegramLegacyMarkdown(hit.detailsArabic)}`
        );
      }
    }

    if (report.redditAnalysis?.exists) {
      const rd = report.redditAnalysis;
      lines.push(
        '────────────────────────',
        '👽 *تحليل حساب Reddit العميق (Redective Native):*',
        `• *تاريخ الإنشاء*: \`${rd.createdUtcIso?.slice(0, 10) || '—'}\` (العمر: \`${
          rd.accountAgeDays ?? 0
        }\` يوم)`,
        `• *مجموع الكارما*: \`${rd.totalKarma ?? 0}\` (منشورات: \`${
          rd.linkKarma ?? 0
        }\` | تعليقات: \`${rd.commentKarma ?? 0}\`)`,
        `• *ساعة الذروة الزمنية للنشاط*: \`${
          rd.mostActiveUtcHour !== undefined ? `${rd.mostActiveUtcHour}:00 UTC` : 'غير محدد'
        }\``
      );
      if (rd.topSubreddits.length > 0) {
        lines.push(
          `• *أنشط المجتمعات (Subreddits)*: ${rd.topSubreddits
            .map((s) => `\`r/${escapeTelegramLegacyMarkdown(s.subreddit)}\` (${s.count})`)
            .join(' ، ')}`
        );
      }
    }

    lines.push('────────────────────────', '🔗 *روابط الفحص الاستقصائي المتقدم:*');
    for (const lnk of report.investigativeLinks.slice(0, 6)) {
      lines.push(
        `• ${mdLink(lnk.toolName, lnk.url)}: ${escapeTelegramLegacyMarkdown(
          lnk.descriptionArabic
        )}`
      );
    }

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard: [
        [{ text: '👤 فحص معرف آخر', callbackData: 'cyber:mod:username' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async executeEmailModuleView(rawInput: string): Promise<BotViewPayload> {
    const trimmed = rawInput.trim();
    const parts = trimmed.split(/\s+/);
    if (!trimmed.includes('@') && parts.length >= 3) {
      const domain = parts[parts.length - 1]!;
      const firstName = parts[0]!;
      const lastName = parts.slice(1, -1).join(' ');
      const perms = await generateAndProbeEmailPermutations(
        firstName,
        lastName,
        domain
      );
      const lines = [
        '📧 *توليد وفحص صيغ البريد المؤسسي (Corporate Email Permutator)*',
        `👤 *الاسم*: \`${escapeTelegramLegacyMarkdown(
          `${firstName} ${lastName}`
        )}\` | 🌐 *النطاق*: \`${escapeTelegramLegacyMarkdown(domain)}\``,
        '────────────────────────',
      ];
      for (const p of perms) {
        const flags = [
          p.gravatarFound ? '🟢 Gravatar' : '',
          p.hudsonRockCompromised ? '🔴 HudsonRock Stealer' : '',
        ]
          .filter(Boolean)
          .join(' | ');
        lines.push(
          `• \`${escapeTelegramLegacyMarkdown(p.email)}\` (${
            p.patternDescription
          }) ${flags ? `— *${flags}*` : ''}`
        );
      }
      return {
        text: clampTelegramMessage(lines.join('\n')),
        keyboard: [
          [{ text: '📧 فحص بريد آخر', callbackData: 'cyber:mod:email' }],
          buildAppNavigationRow('menu:cyber_forensics'),
        ],
      };
    }

    const dossier = await runFullEmailForensicDossier(trimmed);
    const lines: string[] = [
      '📧 *تقرير التحقيق الجنائي للبريد الإلكتروني (Email & Breach Dossier)*',
      `🎯 *البريد*: \`${escapeTelegramLegacyMarkdown(dossier.normalizedEmail)}\``,
      `🔑 *بصمة MD5 (Gravatar)*: \`${dossier.gravatar.emailMd5}\``,
      '────────────────────────',
      '🪪 *1. هوية Gravatar والحسابات الموثقة:*',
    ];

    if (dossier.gravatar.exists) {
      lines.push(
        `• 🟢 *حساب Gravatar موجود*: ${escapeTelegramLegacyMarkdown(
          dossier.gravatar.displayName || dossier.gravatar.preferredUsername || 'مفعل'
        )}`,
        `• *صورة الحساب*: ${mdLink('عرض الصورة الرمزية', dossier.gravatar.avatarUrl)}`
      );
      for (const acc of dossier.gravatar.verifiedAccounts) {
        lines.push(`  └ حساب موثق: ${mdLink(acc.domain, acc.url)}`);
      }
    } else {
      lines.push('• ⚪ لا يوجد ملف Gravatar عام مرتبط بهذا البريد.');
    }

    lines.push('────────────────────────', '🦠 *2. فحص برمجيات سرقة البيانات (Hudson Rock Cavalier):*');
    if (dossier.hudsonRock.compromised) {
      lines.push(
        `• 🔴 *تحذير حرج*: تم رصد البريد في \`${dossier.hudsonRock.totalStealers}\` سجل جهاز مخترق ببرمجيات Infostealer!`
      );
      for (const st of dossier.hudsonRock.stealers.slice(0, 4)) {
        lines.push(
          `  └ العائلة: \`${escapeTelegramLegacyMarkdown(
            st.stealerFamily || 'Stealer'
          )}\` | النظام: \`${escapeTelegramLegacyMarkdown(
            st.operatingSystem || '—'
          )}\` | التاريخ: \`${escapeTelegramLegacyMarkdown(
            st.dateCompromised?.slice(0, 10) || '—'
          )}\``
        );
      }
    } else {
      lines.push('• 🟢 لم يتم رصد إصابات Infostealer في قاعدة Hudson Rock.');
    }

    lines.push('────────────────────────', '🌐 *3. فحص التسجيل في المنصات والخدمات:*');
    for (const reg of dossier.registrations) {
      const icon =
        reg.status === 'CONFIRMED' ? '🟢' : reg.status === 'NOT_FOUND' ? '⚪' : '🔎';
      lines.push(
        `• ${icon} *${escapeTelegramLegacyMarkdown(
          reg.service
        )}*: ${escapeTelegramLegacyMarkdown(reg.detailsArabic)}`
      );
    }

    lines.push(
      '────────────────────────',
      '📡 *4. البنية التحتية لنطاق البريد (MX / SPF / DMARC):*',
      `• *المزود البريدي*: \`${escapeTelegramLegacyMarkdown(
        dossier.dnsSecurity.mailProviderName || dossier.domain
      )}\``,
      `• *سجلات MX*: \`${
        dossier.dnsSecurity.mxRecords.map((m) => m.exchange).slice(0, 3).join(', ') ||
        'لا يوجد'
      }\``,
      `• *سياسة SPF*: \`${
        dossier.dnsSecurity.spfRecord ? '🟢 مفعلة' : '⚪ غير مرصودة'
      }\` | *DMARC*: \`${
        dossier.dnsSecurity.dmarcRecord ? '🟢 مفعلة' : '⚪ غير مرصودة'
      }\``,
      `• *فحص البريد المؤقت (Disposable)*: ${
        dossier.dnsSecurity.isDisposableDomain
          ? '🔴 نطاق بريد مؤقت/وهمي!'
          : '🟢 نطاق رسمي/قياسي'
      }`
    );

    lines.push('────────────────────────', '🔗 *روابط الفحص الجنائي للبريد:*');
    for (const lnk of dossier.investigativeLinks) {
      lines.push(`• ${mdLink(lnk.toolName, lnk.url)}`);
    }

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard: [
        [{ text: '📧 فحص بريد آخر', callbackData: 'cyber:mod:email' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async executeDomainIpModuleView(rawInput: string): Promise<BotViewPayload> {
    const d = await runFullDomainOrIpForensicDossier(rawInput);
    const lines: string[] = [
      `🌐 *تقرير استخبارات النطاقات والشبكات والثغرات (${d.targetType})*`,
      `🎯 *الهدف*: \`${escapeTelegramLegacyMarkdown(d.target)}\`${
        d.resolvedIp ? ` (IP: \`${d.resolvedIp}\`)` : ''
      }`,
      '────────────────────────',
    ];

    if (d.ipReputation?.valid) {
      const ip = d.ipReputation;
      lines.push(
        '📍 *1. الموقع الجغرافي وسمعة الشبكة (IP & ASN Intelligence):*',
        `• *الدولة والمدينة*: ${escapeTelegramLegacyMarkdown(
          `${ip.country || '—'} (${ip.countryCode || '—'}) - ${ip.city || '—'}`
        )}`,
        `• *المزود والنظام المستقل (ISP / ASN)*: \`${escapeTelegramLegacyMarkdown(
          `${ip.isp || '—'} | ${ip.asNumber || '—'}`
        )}\``,
        `• *Reverse DNS*: \`${escapeTelegramLegacyMarkdown(ip.reverseDns || '—')}\``,
        `• *تصنيف الاتصال*: ${
          ip.isProxyOrVpn
            ? '🔴 Proxy/VPN'
            : ip.isHostingDatacenter
            ? '🟡 مركز بيانات (Datacenter/Cloud)'
            : '🟢 اتصال قياسي'
        }`
      );
    }

    if (d.shodanInternetDb) {
      const sh = d.shodanInternetDb;
      lines.push(
        '────────────────────────',
        '🛡️ *2. فحص المنافذ والثغرات (Shodan InternetDB):*',
        `• *المنافذ المفتوحة (Ports)*: \`${
          sh.ports.length > 0 ? sh.ports.join(', ') : 'لا توجد منافذ مكشوفة'
        }\``,
        `• *أسماء المضيفين*: \`${
          sh.hostnames.slice(0, 4).join(', ') || '—'
        }\``,
        `• *الثغرات المسجلة (CVEs)*: ${
          sh.vulns.length > 0
            ? `🔴 \`${sh.vulns.slice(0, 8).join(', ')}\``
            : '🟢 لا توجد ثغرات CVE عامة مسجلة'
        }`
      );
    }

    if (d.dnsReport) {
      lines.push(
        '────────────────────────',
        '📡 *3. سجلات DNS والنطاقات الفرعية (crt.sh & HostSearch):*',
        `• *سجلات A (IPv4)*: \`${d.dnsReport.aRecords.slice(0, 4).join(', ') || '—'}\``,
        `• *خوادم الأسماء (NS)*: \`${d.dnsReport.nsRecords.slice(0, 4).join(', ') || '—'}\``,
        `• *النطاقات الفرعية المكتشفة (${d.uniqueSubdomainNames.length})*: \`${
          d.uniqueSubdomainNames.slice(0, 10).join(', ') || '—'
        }\``
      );
    }

    if (d.techFingerprint?.reachable) {
      const tf = d.techFingerprint;
      lines.push(
        '────────────────────────',
        '⚙️ *4. البصمة البرمجية للموقع (WhatCMS & WAF Fingerprint):*',
        `• *الخادم والجدار الناري*: \`${escapeTelegramLegacyMarkdown(
          tf.cdnOrWaf || tf.serverHeader || 'غير معلن'
        )}\``,
        `• *نظام إدارة المحتوى والأطر*: \`${escapeTelegramLegacyMarkdown(
          [tf.detectedCms, ...tf.detectedFrameworks].filter(Boolean).join(' + ') ||
            'Custom Stack'
        )}\``
      );
    }

    lines.push('────────────────────────', '🔗 *روابط الفحص الشبكي العميق:*');
    for (const lnk of d.investigativeLinks.slice(0, 6)) {
      lines.push(`• ${mdLink(lnk.toolName, lnk.url)}`);
    }

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard: [
        [{ text: '🌐 فحص نطاق أو IP آخر', callbackData: 'cyber:mod:domain_ip' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async executeGeoTransportModuleView(
    rawInput: string
  ): Promise<BotViewPayload> {
    const trimmed = rawInput.trim();
    if (/^(?:icao|flight|adsb)\s*:/i.test(trimmed) || /^[0-9A-F]{6}$/i.test(trimmed)) {
      const q = trimmed.replace(/^(?:icao|flight|adsb)\s*:\s*/i, '');
      const av = await lookupAviationOsint(q);
      const lines = [
        '✈️ *تقرير استخبارات الطيران والملاحة الجوية (OpenSky & HexDB & ADS-B)*',
        `🎯 *الاستعلام*: \`${escapeTelegramLegacyMarkdown(av.query)}\``,
        '────────────────────────',
      ];
      if (av.registration || av.aircraftType || av.operatorOwner) {
        lines.push(
          `• *تسجيل الطائرة (Tail Reg)*: \`${escapeTelegramLegacyMarkdown(
            av.registration || '—'
          )}\``,
          `• *الطراز والمصنع*: \`${escapeTelegramLegacyMarkdown(
            `${av.manufacturer || ''} ${av.aircraftType || ''}`.trim() || '—'
          )}\``,
          `• *المشغل / المالك*: *${escapeTelegramLegacyMarkdown(
            av.operatorOwner || '—'
          )}*`
        );
      }
      if (av.foundLiveState) {
        lines.push(
          `• 🟢 *الحالة الحية (OpenSky ADS-B)*: متصلة في الجو/الأرض`,
          `• *نداء الطائرة (Callsign)*: \`${escapeTelegramLegacyMarkdown(
            av.callsign || '—'
          )}\` | *الدولة*: \`${escapeTelegramLegacyMarkdown(av.originCountry || '—')}\``,
          `• *الإحداثيات الحية*: \`${av.latitude ?? '—'}, ${av.longitude ?? '—'}\` | *الارتفاع*: \`${
            av.baroAltitudeMeters ?? 0
          }m\``
        );
      } else {
        lines.push('• ⚪ الطائرة لا تبث إشارة ADS-B حية في هذه اللحظة — استخدم الروابط أدناه لسجل الرحلات.');
      }
      lines.push('────────────────────────', '🔗 *روابط رادارات الطيران:*');
      for (const lnk of av.investigativeLinks) {
        lines.push(`• ${mdLink(lnk.toolName, lnk.url)}`);
      }
      return {
        text: clampTelegramMessage(lines.join('\n')),
        keyboard: [
          [{ text: '✈️ استعلام جوي/بحري/جغرافي جديد', callbackData: 'cyber:mod:geo_transport' }],
          buildAppNavigationRow('menu:cyber_forensics'),
        ],
      };
    }

    if (/^(?:mmsi|imo|ship|vessel)\s*:/i.test(trimmed) || /^\d{9}$/.test(trimmed)) {
      const q = trimmed.replace(/^(?:mmsi|imo|ship|vessel)\s*:\s*/i, '');
      const mar = lookupMaritimeVesselOsint(q);
      const lines = [
        '🚢 *تقرير استخبارات الملاحة البحرية وتتبع السفن (AIS Maritime OSINT)*',
        `🎯 *المعرّف (${mar.queryType})*: \`${escapeTelegramLegacyMarkdown(
          mar.normalizedId
        )}\``,
        ...(mar.midCountryHint
          ? [`• *دولة علم التسجيل البحري (MID)*: *${escapeTelegramLegacyMarkdown(mar.midCountryHint)}*`]
          : []),
        '────────────────────────',
        '🔗 *روابط تتبع السفينة عبر أنظمة AIS:*',
        ...mar.investigativeLinks.map(
          (lnk) =>
            `• ${mdLink(lnk.toolName, lnk.url)}: ${escapeTelegramLegacyMarkdown(
              lnk.descriptionArabic
            )}`
        ),
      ];
      return {
        text: clampTelegramMessage(lines.join('\n')),
        keyboard: [
          [{ text: '🚢 استعلام جديد', callbackData: 'cyber:mod:geo_transport' }],
          buildAppNavigationRow('menu:cyber_forensics'),
        ],
      };
    }

    const geo = await buildGeoSatelliteAndStreetMapMatrix(trimmed);
    const sun = geo.sunShadow;
    const lines = [
      '🌍 *تقرير الاستخبارات الجغرافية وتحليل الظلال والأقمار الصناعية*',
      `📍 *الموقع*: ${escapeTelegramLegacyMarkdown(
        geo.resolvedDisplayName || geo.query
      )}`,
      `🧭 *الإحداثيات*: \`${geo.latitude}, ${geo.longitude}\``,
      '────────────────────────',
      '☀️ *حساب زاوية الشمس والظلال الفلكي (SunCalc / ShadeMap Native):*',
      `• *التوقيت المرجعي*: \`${sun.timestampIso.slice(0, 19).replace('T', ' ')} UTC\``,
      `• *زاوية ارتفاع الشمس (Altitude)*: \`${sun.solarAltitudeDeg}°\` | *السمت (Azimuth)*: \`${sun.solarAzimuthDeg}°\``,
      `• *اتجاه الظل المتوقع*: \`${sun.shadowDirectionDeg}°\` ${
        sun.shadowToHeightRatio
          ? `| *نسبة طول الظل للارتفاع*: \`${sun.shadowToHeightRatio}x\``
          : ''
      }`,
      `• *المرحلة الضوئية*: ${escapeTelegramLegacyMarkdown(sun.solarPhaseArabic)}`,
      `• *شروق الشمس*: \`${sun.sunriseUtcIso?.slice(11, 16) || '—'} UTC\` | *الزوال*: \`${
        sun.solarNoonUtcIso?.slice(11, 16) || '—'
      } UTC\` | *الغروب*: \`${sun.sunsetUtcIso?.slice(11, 16) || '—'} UTC\``,
      '────────────────────────',
      '🛰️ *مصفوفة الأقمار الصناعية والظلال والتشويش الملاحي:*',
      ...geo.mapLinks.map(
        (lnk) =>
          `• ${mdLink(lnk.toolName, lnk.url)} — _${escapeTelegramLegacyMarkdown(
            lnk.descriptionArabic
          )}_`
      ),
    ];

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard: [
        [{ text: '🌍 فحص موقع أو إحداثيات أخرى', callbackData: 'cyber:mod:geo_transport' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async executeCorpCryptoModuleView(
    rawInput: string
  ): Promise<BotViewPayload> {
    const trimmed = rawInput.trim();
    const cryptoCheck = await inspectCryptoWalletOsint(trimmed);
    if (cryptoCheck.validFormat) {
      const lines = [
        `₿ *تقرير التحليل الجنائي لمحفظة العملات الرقمية (${cryptoCheck.chain})*`,
        `🔑 *العنوان*: \`${escapeTelegramLegacyMarkdown(cryptoCheck.query)}\``,
        '────────────────────────',
      ];
      if (cryptoCheck.liveChecked) {
        lines.push(
          `• *الرصيد الحالي*: \`${escapeTelegramLegacyMarkdown(
            cryptoCheck.balanceFormatted || '0'
          )}\``,
          ...(cryptoCheck.totalReceivedFormatted
            ? [
                `• *إجمالي الوارد*: \`${cryptoCheck.totalReceivedFormatted}\` | *الصادر*: \`${
                  cryptoCheck.totalSentFormatted || '0'
                }\``,
              ]
            : []),
          ...(cryptoCheck.txCount !== undefined
            ? [`• *عدد المعاملات المسجلة*: \`${cryptoCheck.txCount}\``]
            : [])
        );
        if (cryptoCheck.topTokens && cryptoCheck.topTokens.length > 0) {
          lines.push(
            `• *أبرز الرموز الذكية (Tokens)*: ${cryptoCheck.topTokens
              .map((t) => `\`${escapeTelegramLegacyMarkdown(t.symbol)}\``)
              .join(' ، ')}`
          );
        }
      }
      lines.push('────────────────────────', '🔗 *روابط مستكشفات الكتل وتتبع التدفقات:*');
      for (const lnk of cryptoCheck.investigativeLinks) {
        lines.push(`• ${mdLink(lnk.toolName, lnk.url)}`);
      }
      return {
        text: clampTelegramMessage(lines.join('\n')),
        keyboard: [
          [{ text: '🏛️ فحص محفظة أو شركة أخرى', callbackData: 'cyber:mod:corp_crypto' }],
          buildAppNavigationRow('menu:cyber_forensics'),
        ],
      };
    }

    const corp = await searchCorporateAndSanctionsOsint(trimmed);
    const lines = [
      '🏛️ *تقرير استخبارات الشركات والعقوبات الدولية وسلاسل التوريد*',
      `🎯 *الكيان / الاسم*: \`${escapeTelegramLegacyMarkdown(corp.query)}\``,
      '────────────────────────',
      `📂 *نتائج أرشيف الجريمة المنظمة والفساد (OCCRP Aleph — إجمالي: ${corp.alephTotalHits}):*`,
    ];

    if (corp.alephEntities.length === 0) {
      lines.push('• لم يتم العثور على تطابق نصي مباشر في الفهرس الفوري لـ Aleph — استخدم روابط العقوبات والسجلات أدناه.');
    } else {
      for (const ent of corp.alephEntities) {
        lines.push(
          `• *${escapeTelegramLegacyMarkdown(ent.name)}* (\`${escapeTelegramLegacyMarkdown(
            ent.schema
          )}\`) — ${mdLink(ent.datasetTitle, ent.url)}`
        );
      }
    }

    lines.push('────────────────────────', '🔗 *قواعد بيانات الشركات والعقوبات والجمارك:*');
    for (const lnk of corp.investigativeLinks) {
      lines.push(
        `• ${mdLink(lnk.toolName, lnk.url)} — _${escapeTelegramLegacyMarkdown(
          lnk.descriptionArabic
        )}_`
      );
    }

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard: [
        [{ text: '🏛️ فحص كيان أو محفظة أخرى', callbackData: 'cyber:mod:corp_crypto' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async executeArchiveDorksModuleView(
    rawInput: string
  ): Promise<BotViewPayload> {
    const trimmed = rawInput.trim();
    const looksLikeDomainOrUrl =
      /^(?:https?:\/\/)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/.*)?$/.test(
        trimmed
      ) && !trimmed.includes(' ');

    if (looksLikeDomainOrUrl) {
      const arch = await inspectWebArchiveSnapshots(trimmed);
      const lines = [
        '🕰️ *تقرير الأرشيف التاريخي للمواقع والصفحات المحذوفة (Wayback Machine CDX)*',
        `🌐 *الهدف*: \`${escapeTelegramLegacyMarkdown(arch.targetUrl)}\``,
        '────────────────────────',
        `• *حالة الأرشفة*: ${
          arch.hasArchivedSnapshots
            ? `🟢 مؤرشف (${arch.totalSampledSnapshots} عينة زمنية مستخرجة)`
            : '⚪ لم يتم العثور على لقطات مباشرة في CDX'
        }`,
        ...(arch.firstSeenUtc
          ? [`• *أقدم لقطة مرصودة*: \`${arch.firstSeenUtc}\` | *أحدث لقطة*: \`${arch.lastSeenUtc || '—'}\``]
          : []),
      ];

      if (arch.snapshots.length > 0) {
        lines.push('────────────────────────', '📸 *أبرز اللقطات التاريخية المحفوظة:*');
        for (const snap of arch.snapshots.slice(0, 8)) {
          lines.push(
            `• \`${snap.formattedDateUtc}\` — ${mdLink(
              `فتح النسخة المؤرشفة (${snap.statusCode})`,
              snap.archiveUrl
            )}`
          );
        }
      }

      lines.push('────────────────────────', '🔗 *محركات الأرشفة البديلة:*');
      for (const lnk of arch.archiveLinks) {
        lines.push(`• ${mdLink(lnk.toolName, lnk.url)}`);
      }

      return {
        text: clampTelegramMessage(lines.join('\n')),
        keyboard: [
          [{ text: '🕰️ فحص موقع أو اسم آخر', callbackData: 'cyber:mod:archive_dorks' }],
          buildAppNavigationRow('menu:cyber_forensics'),
        ],
      };
    }

    const dossier = buildPeopleAndDorkDossier(trimmed);
    const lines = [
      '🔎 *تقرير دوركس البحث المتقدم وسجلات الأشخاص والمحاكم (People & Dorks OSINT)*',
      `🎯 *الهدف*: \`${escapeTelegramLegacyMarkdown(dossier.query)}\``,
      '────────────────────────',
      '⚡ *1. استعلامات Google Advanced Dorks الجاهزة:*',
      ...dossier.googleAdvancedDorks.map(
        (d) => `• ${mdLink(d.titleArabic, d.googleUrl)}`
      ),
      '────────────────────────',
      '📇 *2. أدلة الأشخاص والسجلات المدنية والقضائية:*',
      ...dossier.peopleAndPublicRecordLinks.map(
        (p) =>
          `• ${mdLink(p.toolName, p.url)} — _${escapeTelegramLegacyMarkdown(
            p.descriptionArabic
          )}_`
      ),
    ];

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard: [
        [{ text: '🕰️ بحث جديد في الأرشيف والدوركس', callbackData: 'cyber:mod:archive_dorks' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async handleMediaAttachment(
    adminId: number,
    mediaInput: {
      buffer?: Buffer;
      contentBuffer?: Buffer;
      fileName?: string;
      originalFilename?: string;
      mimeType?: string;
    }
  ): Promise<BotViewPayload> {
    this.setInputStep(adminId, 'IDLE');
    const buf = mediaInput.buffer || mediaInput.contentBuffer;
    const fileName =
      mediaInput.fileName || mediaInput.originalFilename || 'evidence_media.jpg';
    const mimeType = mediaInput.mimeType;

    if (!buf || buf.length === 0) {
      return {
        text: '⚠️ *تعذر قراءة محتوى الملف المرفق. يرجى إعادة إرسال الصورة أو المستند.*',
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    const meta = extractMediaForensicMetadata(buf, fileName, mimeType);
    const mediaId = crypto.randomBytes(4).toString('hex');
    this.uploadedMediaCache.set(mediaId, {
      buffer: buf,
      fileName,
      mimeType: meta.detectedMimeType,
    });
    if (this.uploadedMediaCache.size > 20) {
      const firstKey = this.uploadedMediaCache.keys().next().value;
      if (firstKey) this.uploadedMediaCache.delete(firstKey);
    }

    const lines: string[] = [
      '🖼️ *تقرير المختبر الجنائي للوسائط والصور (Media & EXIF Forensics)*',
      `📄 *الملف*: \`${escapeTelegramLegacyMarkdown(meta.fileName)}\` (\`${meta.detectedFormat}\` — \`${meta.fileSizeBytes} bytes\`)`,
      ...(meta.width && meta.height
        ? [`📐 *الأبعاد*: \`${meta.width}x${meta.height} px\``]
        : []),
      '────────────────────────',
      '🔐 *1. البصمات التشفيرية الجنائية (Cryptographic Hashes):*',
      `• *MD5*: \`${meta.md5}\``,
      `• *SHA-1*: \`${meta.sha1}\``,
      `• *SHA-256*: \`${meta.sha256}\``,
      '────────────────────────',
      '📷 *2. بيانات الكاميرا والإنشاء (EXIF / XMP / Document Metadata):*',
      `• *التقييم الجنائي*: ${escapeTelegramLegacyMarkdown(
        meta.authenticityAssessment.summaryArabic
      )}`,
    ];

    if (meta.cameraMake || meta.cameraModel) {
      lines.push(
        `• *الكاميرا / الجهاز*: *${escapeTelegramLegacyMarkdown(
          `${meta.cameraMake || ''} ${meta.cameraModel || ''}`.trim()
        )}*`
      );
    }
    if (meta.lensModel) {
      lines.push(`• *العدسة*: \`${escapeTelegramLegacyMarkdown(meta.lensModel)}\``);
    }
    if (meta.software) {
      lines.push(
        `• *النظام / البرنامج المعالج*: \`${escapeTelegramLegacyMarkdown(meta.software)}\``
      );
    }
    if (meta.dateTimeOriginal || meta.createDate || meta.modifyDate) {
      lines.push(
        `• *تاريخ الالتقاط الأصلي*: \`${escapeTelegramLegacyMarkdown(
          meta.dateTimeOriginal || meta.createDate || meta.modifyDate
        )}\``
      );
    }
    if (meta.pdfMetadata) {
      const pm = meta.pdfMetadata;
      lines.push(
        `• *بيانات PDF*: المؤلف=\`${escapeTelegramLegacyMarkdown(
          pm.author || '—'
        )}\` | البرنامج=\`${escapeTelegramLegacyMarkdown(
          pm.creator || pm.producer || '—'
        )}\``
      );
    }
    for (const chunk of meta.pngTextChunks.slice(0, 4)) {
      lines.push(
        `• *PNG (${escapeTelegramLegacyMarkdown(
          chunk.keyword
        )})*: \`${escapeTelegramLegacyMarkdown(chunk.value.slice(0, 80))}\``
      );
    }

    if (meta.gps) {
      lines.push(
        '────────────────────────',
        '📍 *3. الإحداثيات الجغرافية المستخرجة من الصورة (EXIF GPS):*',
        `• *الإحداثيات العشرية*: \`${meta.gps.latitude}, ${meta.gps.longitude}\``,
        `• *الصيغة الدرجية (DMS)*: \`${escapeTelegramLegacyMarkdown(
          meta.gps.dmsFormatted
        )}\``,
        ...(meta.gps.altitudeMeters !== undefined
          ? [`• *الارتفاع عن سطح البحر*: \`${meta.gps.altitudeMeters} متر\``]
          : []),
        `• *خريطة الموقع المباشرة*: ${mdLink('فتح على خرائط Google', meta.gps.googleMapsUrl)}`
      );
      if (meta.sunShadowForensics) {
        const sun = meta.sunShadowForensics;
        lines.push(
          `• *زاوية الشمس لحظة التصوير (SunCalc)*: الارتفاع \`${sun.solarAltitudeDeg}°\` | اتجاه الظل \`${sun.shadowDirectionDeg}°\` (${escapeTelegramLegacyMarkdown(
            sun.solarPhaseArabic
          )})`,
          `• *محاكاة الظلال*: ${mdLink('SunCalc', sun.sunCalcUrl)} | ${mdLink(
            'ShadeMap 3D',
            sun.shadeMapUrl
          )}`
        );
      }
    }

    lines.push('────────────────────────', '🔎 *4. محركات البحث البصري العكسي وفحص التلاعب ELA:*');
    for (const lnk of meta.reverseImageLinks) {
      lines.push(`• ${mdLink(lnk.toolName, lnk.url)}`);
    }

    const keyboard: TelegramInlineButton[][] = [];
    if (meta.detectedFormat === 'JPEG' || meta.detectedFormat === 'PNG') {
      keyboard.push([
        {
          text: '🧹 تطهير الصورة وإزالة بيانات EXIF/GPS (ExifPurge)',
          callbackData: `cyber:exif_purge:${mediaId}`,
        },
      ]);
    }
    keyboard.push([
      {
        text: '🖼️ فحص صورة أو ملف آخر',
        callbackData: 'cyber:mod:media',
      },
    ]);
    keyboard.push(buildAppNavigationRow('menu:cyber_forensics'));

    return {
      text: clampTelegramMessage(lines.join('\n')),
      keyboard,
    };
  }

  public purgeMediaExifById(mediaId: string): BotViewPayload {
    const cached = this.uploadedMediaCache.get(mediaId);
    if (!cached) {
      return {
        text: '⚠️ *انتهت صلاحية النسخة المؤقتة للصورة. يرجى إعادة إرسال الصورة لتطهيرها.*',
        keyboard: [buildBackCancelRow('cyber:mod:media')],
      };
    }

    const cleanRes = sanitizeImageMetadata(cached.buffer);
    const cleanName = `sanitized_${cached.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    return {
      text: [
        '🧹 *تم تطهير الصورة وإزالة البيانات الوصفية بنجاح (ExifPurge Complete)*',
        '────────────────────────',
        `• *الحجم الأصلي*: \`${cleanRes.originalSizeBytes} bytes\``,
        `• *الحجم بعد التطهير*: \`${cleanRes.sanitizedSizeBytes} bytes\``,
        `• *البيانات المحذوفة*: \`${cleanRes.bytesRemoved} bytes\` (\`${cleanRes.removedSegmentsCount}\` قطاع EXIF/GPS/XMP)`,
      ].join('\n'),
      keyboard: [
        [{ text: '🖼️ فحص أو تطهير ملف آخر', callbackData: 'cyber:mod:media' }],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
      mediaAttachments: [
        {
          kind: 'document',
          filePath: '',
          fileName: cleanName,
          mimeType: cached.mimeType || 'image/jpeg',
          buffer: cleanRes.sanitizedBuffer,
          caption: `🧹 نسخة مطهرة خالية من بيانات EXIF/GPS (${cleanName})`,
        },
      ],
    };
  }

  public async executeIdentifierInvestigationView(
    adminId: number,
    rawIdentifier: string
  ): Promise<BotViewPayload> {
    const cleanId = String(rawIdentifier || '').trim();
    if (cleanId.length < 3) {
      return {
        text: '⚠️ *يرجى إدخال اسم مستخدم صالح (مثل `@username`) أو بريد إلكتروني صحيح.*',
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    const res = await this.engine.runIdentifierForensicInvestigation(cleanId, adminId);
    const lines: string[] = [
      `🧬 *تقرير التتبع الجنائي للمعرّف (${res.isEmail ? 'بريد إلكتروني' : 'اسم مستخدم'})*`,
      `🎯 الهدف: \`${escapeTelegramLegacyMarkdown(res.identifier)}\``,
      '────────────────────────',
      `🌐 *1. الحسابات المؤكدة عبر المنصات (${res.socialAccounts.length}):*`,
    ];

    if (res.socialAccounts.length === 0) {
      lines.push('   • لم يتم العثور على حسابات عامة مطابقة لهذا المعرّف.');
    } else {
      for (const acc of res.socialAccounts) {
        lines.push(
          `   • ${acc.icon} ${mdLink(acc.platform, acc.url)}: ${escapeTelegramLegacyMarkdown(
            acc.details
          )}`
        );
      }
    }

    lines.push('────────────────────────');
    lines.push(
      `🔓 *2. التسريبات وبرمجيات Infostealer (${res.breachExposures.length}):*`
    );
    if (res.breachExposures.length === 0) {
      lines.push('   • 🟢 سليم: لم يظهر المعرّف في قواعد بيانات التسريبات أو سجلات Infostealer.');
    } else {
      for (const b of res.breachExposures.slice(0, 6)) {
        lines.push(
          `   • 🔴 *[${b.sourceEngine}]* \`${escapeTelegramLegacyMarkdown(
            b.breachOrStealerName
          )}\`: ${escapeTelegramLegacyMarkdown(b.details)}`
        );
        if (b.maskedSamples.length > 0) {
          lines.push(`     └ عينات مقنّعة: \`${escapeTelegramLegacyMarkdown(b.maskedSamples.join(' | '))}\``);
        }
      }
    }

    if (res.pasteAndCodeHits.length > 0) {
      lines.push('────────────────────────');
      lines.push(`📄 *3. ملفات Pastebin ومستودعات الكود (${res.pasteAndCodeHits.length}):*`);
      for (const p of res.pasteAndCodeHits.slice(0, 5)) {
        lines.push(
          `   • ${mdLink(p.titleOrRepo, p.url)} — _${escapeTelegramLegacyMarkdown(
            p.snippet.slice(0, 90)
          )}_`
        );
      }
    }

    return {
      text: truncateSafeTelegramMarkdown(lines.join('\n')),
      keyboard: [
        [
          {
            text: '🧬 فحص معرّف أو بريد آخر',
            callbackData: 'cyber:handle_lookup',
          },
        ],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
    };
  }

  public async executeInvestigationAndFormatView(
    adminId: number,
    rawPhoneInput: string,
    mode: ForensicInvestigationMode = 'FULL_DOSSIER'
  ): Promise<BotViewPayload> {
    const parsedCheck = parseAndNormalizePhoneInput(rawPhoneInput);
    if (!parsedCheck.isValidLength) {
      return {
        text: [
          '⚠️ *رقم الهاتف المدخل غير صالح جغرافياً أو قصير جداً.*',
          'يرجى إدخال الرقم بالصيغة الدولية الكاملة (مثال: `+967775224395` أو `+966501234567`).',
        ].join('\n'),
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    // CRITICAL FIX: Pass adminId (`actorTelegramId`) so inspectWhatsAppProtocolFootprint finds connected sessions!
    const report = await this.engine.runFullForensicInvestigation(
      rawPhoneInput,
      mode,
      adminId
    );
    this.lastReportByPhone.set(report.phone.digitsOnly, report);

    const p = report.phone;
    const wa = report.whatsappFootprint;
    const tc = report.truecallerData;
    const ey = report.eyeconData;

    const lines: string[] = [
      `🕵️‍♂️ *تقرير التحقيق الجنائي الرقمي (Cyber Forensics Dossier)*`,
      `🆔 معرّف التقرير: \`${report.reportId}\``,
      '────────────────────────',
      '📡 *1. البصمة الاتصالية والجغرافية (Telecom & Carrier Footprint):*',
      `• *الرقم الدولي (E.164)*: \`${p.e164}\` (${escapeTelegramLegacyMarkdown(
        p.internationalFormatted
      )})`,
      `• *الرقم المحلي*: \`${p.localWithZero}\` | *النطاق*: \`${p.significantNumber}\``,
      `• *الدولة*: ${escapeTelegramLegacyMarkdown(p.countryNameArabic)} (\`${p.isoCountry2}\` / \`+${p.countryCode}\`)`,
      `• *المشغل ونوع الخط*: *${escapeTelegramLegacyMarkdown(p.inferredCarrier)}* (\`${p.lineType}\`)`,
    ];

    if (report.carrierApiData?.numverify?.queried) {
      const nv = report.carrierApiData.numverify;
      lines.push(
        `• *فحص Numverify*: ${nv.valid ? '🟢 صالح' : '🔴 غير صالح'}${
          nv.location ? ` | الموقع: ${escapeTelegramLegacyMarkdown(nv.location)}` : ''
        }`
      );
    }
    if (report.carrierApiData?.ovhTelecom?.found) {
      const ovh = report.carrierApiData.ovhTelecom;
      lines.push(
        `• *فحص مقسم OVH Telecom*: 🟢 النطاق البريدي: ${escapeTelegramLegacyMarkdown(
          `${ovh.city || ''} ${ovh.zipCode || ''}`
        )}`
      );
    }
    if (report.isDisposableBurner) {
      lines.push(
        `• 🚨 *تحذير أمني*: الرقم مرتبط بمزود رسائل مؤقتة (Burner SMS): \`${escapeTelegramLegacyMarkdown(
          report.disposableMatchedDomains.join(', ')
        )}\``
      );
    }

    // Section 2: Discovered Names
    lines.push('────────────────────────');
    lines.push(
      `📇 *2. الأسماء والهويات المكتشفة للرقم (${report.discoveredNames.length}):*`
    );
    if (report.discoveredNames.length === 0) {
      lines.push('   • لم يتم العثور على اسم علني مفهرس في الأدلة المفتوحة حالياً.');
    } else {
      for (const item of report.discoveredNames.slice(0, 10)) {
        const badge =
          item.confidence === 'HIGH' ? '🟢' : item.confidence === 'MEDIUM' ? '🟡' : '⚪';
        const extra = item.extraInfo
          ? ` — _${escapeTelegramLegacyMarkdown(item.extraInfo.slice(0, 50))}_`
          : '';
        lines.push(
          `   ${badge} *${escapeTelegramLegacyMarkdown(
            item.name
          )}*  ⬅️  \`[${escapeTelegramLegacyMarkdown(item.source)}]\`${extra}`
        );
      }
    }

    if (tc?.found) {
      const tcMeta: string[] = [];
      if (tc.email) tcMeta.push(`📧 البريد: \`${escapeTelegramLegacyMarkdown(tc.email)}\``);
      if (tc.city) tcMeta.push(`🏙️ المدينة: ${escapeTelegramLegacyMarkdown(tc.city)}`);
      if (typeof tc.spamScore === 'number' && tc.spamScore > 0) {
        tcMeta.push(`🚨 مؤشر الإزعاج (Spam): \`${tc.spamScore}\``);
      }
      if (tcMeta.length > 0) {
        lines.push(`   ℹ️ *بيانات Truecaller*: ${tcMeta.join(' | ')}`);
      }
    }

    if (ey?.facebookProfileUrl) {
      lines.push(
        `   📘 *حساب فيسبوك المستخرج عبر Eyecon*: ${mdLink(
          'فتح حساب فيسبوك المرتبط بالرقم',
          ey.facebookProfileUrl
        )}`
      );
    }

    // Section 3: WhatsApp Protocol Intelligence
    lines.push('────────────────────────');
    lines.push('🟢 *3. استخبارات بروتوكول واتساب (WhatsApp USync & Signal Intelligence):*');
    if (!wa.checked) {
      lines.push(
        `• *الحالة*: ⚪ لم يتم الفحص الحي (اربط جلسة واتساب واحدة على الأقل لتفعيل فحص USync) — ${mdLink(
          'فتح محادثة wa.me مباشرة',
          wa.directChatUrl
        )}`
      );
    } else if (!wa.registered) {
      lines.push('• *الحالة*: 🔴 الرقم غير مسجل على شبكة واتساب حالياً');
    } else {
      lines.push(`• *الحالة*: 🟢 مسجل ونشط على شبكة واتساب`);
      lines.push(
        `• *المعرّف القياسي (JID)*: \`${wa.jid}\`${
          wa.lid ? ` | *معرّف الهوية المقنّع (LID)*: \`${wa.lid}\`` : ''
        }`
      );
      if (wa.pushName) {
        lines.push(`• *الاسم الظاهر (PushName)*: *${escapeTelegramLegacyMarkdown(wa.pushName)}*`);
      }
      if (wa.linkedDevices.length > 0) {
        lines.push(
          `• *الأجهزة المربوطة بالحساب (${wa.linkedDevices.length})*: \`[${wa.linkedDevices.join(
            ', '
          )}]\``
        );
      }
      if (wa.presenceState) {
        lines.push(
          `• *حالة التواجد (Presence)*: \`${escapeTelegramLegacyMarkdown(wa.presenceState)}\`${
            wa.lastSeenIso ? ` (آخر ظهور: \`${wa.lastSeenIso}\`)` : ''
          }`
        );
      }
      if (typeof wa.disappearingTimerSeconds === 'number' && wa.disappearingTimerSeconds > 0) {
        lines.push(
          `• *الرسائل المؤقتة الافتراضية*: ⏱️ مفعلة (\`${wa.disappearingTimerSeconds}s\`)`
        );
      }
      if (wa.verifiedBusinessName) {
        lines.push(
          `• *اسم النشاط التجاري*: *${escapeTelegramLegacyMarkdown(wa.verifiedBusinessName)}*${
            wa.businessCategory
              ? ` (${escapeTelegramLegacyMarkdown(wa.businessCategory)})`
              : ''
          }`
        );
      }
      if (wa.businessEmail) {
        lines.push(`• *بريد الأعمال*: \`${escapeTelegramLegacyMarkdown(wa.businessEmail)}\``);
      }
      if (wa.businessAddress) {
        lines.push(`• *عنوان الأعمال*: ${escapeTelegramLegacyMarkdown(wa.businessAddress)}`);
      }
      if (wa.statusBio) {
        lines.push(
          `• *السيرة الذاتية (Bio)*: "${escapeTelegramLegacyMarkdown(wa.statusBio)}"${
            wa.statusSetAt ? ` (بتاريخ \`${wa.statusSetAt}\`)` : ''
          }`
        );
      } else if (wa.aboutPrivacyRestricted) {
        lines.push('• *السيرة الذاتية (Bio)*: 🔒 محمية بإعدادات الخصوصية أو فارغة');
      }
      if (wa.sharedGroupsCount && wa.sharedGroupsCount > 0 && wa.sharedGroupsSample) {
        const grpNames = wa.sharedGroupsSample
          .map((g) => `${escapeTelegramLegacyMarkdown(g.groupName)} (${g.role})`)
          .join(' ، ');
        lines.push(`• *المجموعات المشتركة (${wa.sharedGroupsCount})*: ${grpNames}`);
      }
      lines.push(`• *رابط المراسلة المباشر*: ${mdLink(`wa.me/${p.digitsOnly}`, wa.directChatUrl)}`);
    }

    // Section 4: Social Media Accounts
    if (mode !== 'PHONE_NAMES_ONLY' && mode !== 'BREACH_LEAKS_ONLY') {
      lines.push('────────────────────────');
      lines.push('🌐 *4. الحسابات والمنصات الاجتماعية المرتبطة (Social Media Footprint):*');
      for (const acc of report.socialAccounts.slice(0, 12)) {
        const statusBadge =
          acc.status === 'CONFIRMED'
            ? '🟢 [مؤكد]'
            : acc.status === 'LIKELY'
            ? '🟡 [مرجّح]'
            : acc.status === 'NOT_FOUND'
            ? '⚪ [غير مسجل]'
            : '🔎 [فحص]';
        lines.push(
          `• ${acc.icon} ${statusBadge} ${mdLink(acc.platform, acc.url)}: ${escapeTelegramLegacyMarkdown(
            acc.details
          )}`
        );
      }
    }

    // Section 5: Breaches, Infostealers, Pastes & Code Dumps
    if (mode === 'BREACH_LEAKS_ONLY' || mode === 'FULL_DOSSIER') {
      lines.push('────────────────────────');
      lines.push(
        `🔓 *5. التسريبات وبرمجيات Infostealer وأرشيف الكود (${
          report.breachExposures.length + report.pasteAndCodeHits.length
        }):*`
      );
      if (
        report.breachExposures.length === 0 &&
        report.pasteAndCodeHits.length === 0
      ) {
        lines.push(
          '• 🟢 *سليم*: لم يتم رصد تسريبات لبيانات اعتماد هذا الرقم في `Hudson Rock`, `LeakCheck`, `COMB`, و `Pastebin`.'
        );
      } else {
        for (const b of report.breachExposures.slice(0, 5)) {
          lines.push(
            `• 🔴 *[${b.sourceEngine}]* \`${escapeTelegramLegacyMarkdown(
              b.breachOrStealerName
            )}\`: ${escapeTelegramLegacyMarkdown(b.details)}`
          );
          if (b.maskedSamples.length > 0) {
            lines.push(
              `  └ عينات مقنّعة: \`${escapeTelegramLegacyMarkdown(
                b.maskedSamples.join(' | ')
              )}\``
            );
          }
        }
        for (const paste of report.pasteAndCodeHits.slice(0, 4)) {
          lines.push(
            `• 📄 *[${paste.sourceEngine}]* ${mdLink(
              paste.titleOrRepo,
              paste.url
            )}: _${escapeTelegramLegacyMarkdown(paste.snippet.slice(0, 80))}_`
          );
        }
      }
    }

    // Section 6: 10 Search Engines Parallel Execution Summary & Live Web Mentions
    if (
      mode === 'TEN_ENGINES_SCRAPE_ONLY' ||
      mode === 'FULL_DOSSIER' ||
      report.liveWebMentions.length > 0
    ) {
      lines.push('────────────────────────');
      const okEngines = report.searchEngineStats.filter(
        (s) => s.status === 'OK' || s.status === 'EMPTY'
      ).length;
      lines.push(
        `🕸️ *6. نتائج الزحف عبر 10 محركات بحث (${report.liveWebMentions.length} نتيجة حية | استجاب ${okEngines}/10 محرك):*`
      );
      if (report.searchEngineStats.length > 0 && mode === 'TEN_ENGINES_SCRAPE_ONLY') {
        const statBadges = report.searchEngineStats
          .map(
            (s) =>
              `${s.hitsCount > 0 ? '🟢' : s.status === 'EMPTY' ? '⚪' : '🟡'} ${escapeTelegramLegacyMarkdown(
                s.engineName
              )} (\`${s.hitsCount}\`)`
          )
          .join(' | ');
        lines.push(`• *حالة المحركات العشرة*: ${statBadges}`);
      }
      if (report.liveWebMentions.length === 0) {
        lines.push('• لم يتم رصد صفحات ويب علنية تذكر الرقم نصياً في الفهرس المباشر.');
      } else {
        for (const hit of report.liveWebMentions.slice(0, 6)) {
          lines.push(
            `• [${escapeTelegramLegacyMarkdown(hit.engineSource)}] ${mdLink(
              hit.title.slice(0, 50),
              hit.url
            )} (\`${escapeTelegramLegacyMarkdown(hit.sourceDomain)}\`)`
          );
        }
      }
    }

    // Section 7: PhoneInfoga Targeted OSINT Dorks (Always clean [Label](URL) hyperlinks!)
    if (mode === 'FULL_DOSSIER') {
      lines.push('────────────────────────');
      lines.push('🔎 *7. روابط البحث الجنائي العميق (PhoneInfoga OSINT Dorks):*');
      const dorkLinks = report.osintDorks
        .slice(0, 6)
        .map((d) => `• ${mdLink(d.title, d.googleUrl)}`)
        .join('\n');
      lines.push(dorkLinks);
    }

    const keyboard: TelegramInlineButton[][] = [
      [
        {
          text: '🔄 فحص شامل محدث',
          callbackData: `cyber:rescan:${p.digitsOnly}`,
        },
        {
          text: '📥 تصدير التقرير الكامل (JSON)',
          callbackData: `cyber:export:${p.digitsOnly}`,
        },
      ],
      [
        {
          text: '🔓 فحص التسريبات فقط',
          callbackData: `cyber:run_breach:${p.digitsOnly}`,
        },
        {
          text: '🕸️ فحص 10 محركات بحث',
          callbackData: `cyber:run_engines:${p.digitsOnly}`,
        },
      ],
      [
        {
          text: '🕵️‍♂️ فحص رقم جديد',
          callbackData: 'cyber:full_scan',
        },
      ],
      buildAppNavigationRow('menu:cyber_forensics'),
    ];

    const finalMarkdownText = truncateSafeTelegramMarkdown(lines.join('\n'), 3950);

    // If WhatsApp high-resolution profile picture buffer was captured, attach it!
    if (wa.profilePictureBuffer && wa.profilePictureBuffer.length > 0) {
      return {
        text: finalMarkdownText,
        keyboard,
        photoBuffer: wa.profilePictureBuffer,
        photoFileName: `wa_profile_${p.digitsOnly}.jpg`,
        mediaAttachments: [
          {
            kind: 'photo',
            filePath: '',
            fileName: `wa_profile_${p.digitsOnly}.jpg`,
            mimeType: 'image/jpeg',
            buffer: wa.profilePictureBuffer,
            caption: `📸 الصورة الشخصية عالية الدقة المسحوبة للرقم ${p.e164}\nالاسم: ${
              report.discoveredNames[0]?.name || wa.pushName || 'غير مسجل'
            }`,
          },
        ],
      };
    }

    return {
      text: finalMarkdownText,
      keyboard,
    };
  }

  public exportReportJsonAttachment(digitsOnly: string): BotViewPayload {
    const cleanDigits = String(digitsOnly || '').replace(/\D/g, '');
    const report =
      this.lastReportByPhone.get(cleanDigits) ||
      this.engine.getFullForensicReportFromCache(cleanDigits);
    if (!report) {
      return {
        text: '⚠️ *التقرير غير موجود في الذاكرة المؤقتة. اضغط إعادة الفحص لتوليده.*',
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    const serializable = {
      ...report,
      whatsappFootprint: {
        ...report.whatsappFootprint,
        profilePictureBuffer: report.whatsappFootprint.profilePictureBuffer
          ? `<Buffer ${report.whatsappFootprint.profilePictureBuffer.length} bytes>`
          : undefined,
      },
    };

    const jsonBuffer = Buffer.from(JSON.stringify(serializable, null, 2), 'utf8');

    return {
      text: `📥 *تم تصدير ملف التقرير الجنائي الرقمي الكامل للرقم* \`${report.phone.e164}\` *بصيغة JSON.*`,
      keyboard: [
        [
          {
            text: '🔙 العودة للتقرير',
            callbackData: `cyber:rescan:${digitsOnly}`,
          },
        ],
        buildAppNavigationRow('menu:cyber_forensics'),
      ],
      mediaAttachments: [
        {
          kind: 'document',
          filePath: '',
          fileName: `forensic_dossier_${digitsOnly}.json`,
          mimeType: 'application/json',
          buffer: jsonBuffer,
          caption: `Forensic OSINT Dossier for ${report.phone.e164} (${report.reportId})`,
        },
      ],
    };
  }
}
