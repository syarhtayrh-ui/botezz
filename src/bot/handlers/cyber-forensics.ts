import fs from 'node:fs';
import path from 'node:path';
import {
  buildAppNavigationRow,
  buildBackCancelRow,
  buildCyberForensicsMenuKeyboard,
  InlineKeyboardRows,
} from '../keyboards/main-menu';
import { BotViewResponse, TelegramMediaAttachment } from '../workflows/pairing-workflow';
import {
  CyberForensicsOsintEngine,
  PhoneForensicReport,
  parseAndNormalizePhoneInput,
} from '../../security/cyber-forensics-osint-engine';
import { AuditRepository } from '../../database/repositories/audit-repository';

export type CyberForensicsInputStep =
  | 'IDLE'
  | 'AWAITING_PHONE_LOOKUP'
  | 'AWAITING_SOCIAL_LOOKUP'
  | 'AWAITING_FULL_SCAN'
  | 'AWAITING_TRUECALLER_LOGIN_PHONE'
  | 'AWAITING_TRUECALLER_OTP'
  | 'AWAITING_TRUECALLER_TOKEN_MANUAL'
  | 'AWAITING_EYECON_AUTH'
  | 'AWAITING_NUMVERIFY_KEY';

export class CyberForensicsHandler {
  private readonly inputStepByAdmin = new Map<number, CyberForensicsInputStep>();
  private readonly lastReportByPhone = new Map<string, PhoneForensicReport>();

  constructor(
    public readonly engine: CyberForensicsOsintEngine,
    private readonly auditRepo: AuditRepository
  ) {}

  public getInputStep(adminId: number): CyberForensicsInputStep {
    return this.inputStepByAdmin.get(adminId) || 'IDLE';
  }

  public setInputStep(adminId: number, step: CyberForensicsInputStep): void {
    if (step === 'IDLE') {
      this.inputStepByAdmin.delete(adminId);
    } else {
      this.inputStepByAdmin.set(adminId, step);
    }
  }

  public cancelWorkflow(adminId: number): void {
    this.inputStepByAdmin.delete(adminId);
  }

  public renderDashboard(): BotViewResponse {
    const tcConfigured = Boolean(this.engine.getTruecallerInstallationId());
    const eyeconConfigured = Boolean(this.engine.getEyeconCredentials().eAuth);
    const numverifyConfigured = Boolean(this.engine.getNumverifyApiKey());
    const historyCount = this.engine.getRecentForensicHistory().length;

    const text =
      `🕵️‍♂️ *قسم التحليل الجنائي السيبراني واستخبارات الأرقام (Cyber OSINT)*\n` +
      `────────────────────────\n` +
      `🔬 *المحركات المربوطة والجاهزة للعمل:*\n` +
      `• 📞 *Truecaller Directory API:* ${tcConfigured ? '🟢 متصل ومفعّل' : '🟡 يحتاج تسجيل دخول OTP أو مفتاح'}\n` +
      `• 👁️ *Eyecon Caller-ID + FB Graph:* ${eyeconConfigured ? '🟢 متصل ومفعّل' : '🟡 اختياري (إعداد مفتاح e-auth)'}\n` +
      `• 🟢 *WhatsApp USync & Business Inspector:* 🟢 مدمج مع جلسات البوت\n` +
      `• 📸 *Ignorant / Yocial Social Probes:* 🟢 مفعّل (Instagram / Snapchat / Amazon / WhatsApp)\n` +
      `• 🌐 *PhoneInfoga Dork & Web Scraper:* 🟢 مفعّل (${numverifyConfigured ? 'مع Numverify API' : 'وضع الفحص المباشر'})\n` +
      `• 🗂️ *عدد الفحوصات المحفوظة في السجل:* \`${historyCount}\`\n` +
      `────────────────────────\n` +
      `اختر القسم المطلوب للبدء:`;

    return {
      text,
      keyboard: buildCyberForensicsMenuKeyboard(),
      toastText: '🕵️‍♂️ قسم التحليل الجنائي السيبراني',
      route: 'menu:cyber_forensics',
    };
  }

  public promptPhoneLookup(adminId: number): BotViewResponse {
    this.setInputStep(adminId, 'AWAITING_PHONE_LOOKUP');
    return {
      text:
        `🔎 *قسم البحث عن رقم الهاتف وكشف الأسماء المرتبطة*\n` +
        `────────────────────────\n` +
        `أرسل الآن رقم الهاتف المراد فحصه بالصيغة الدولية أو المحلية (مثال: \`+967775224395\` أو \`+966501234567\`):\n\n` +
        `⚡ *سيقوم المحرك بالبحث المتوازي في:*\n` +
        `1. قاعدة بيانات Truecaller وEyecon لكشف جميع الأسماء المسجلة\n` +
        `2. بروتوكول واتساب الحي (الاسم الظاهر، نشاط الأعمال، النبذة، الأجهزة المرتبطة، والصورة الشخصية)\n` +
        `3. تحليل شركة الاتصالات ونوع الخط والفهرس الجغرافي\n` +
        `4. الأدلة العامة المنشورة وسجل الأسماء التاريخي في قاعدة البيانات`,
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      toastText: '🔎 أدخل رقم الهاتف للبحث عن الأسماء',
      route: 'cyber:phone_lookup',
    };
  }

  public promptSocialLookup(adminId: number): BotViewResponse {
    this.setInputStep(adminId, 'AWAITING_SOCIAL_LOOKUP');
    return {
      text:
        `🌐 *قسم كشف حسابات التواصل الاجتماعي المرتبطة برقم الهاتف*\n` +
        `────────────────────────\n` +
        `أرسل الآن رقم الهاتف المراد فحص الحسابات المرتبطة به (مثال: \`+967775224395\`):\n\n` +
        `⚡ *الأدوات المدمجة في الفحص:*\n` +
        `• فحص **WhatsApp** و**Telegram** واستخراج الروابط المباشرة\n` +
        `• فحص **Instagram** و**Snapchat** و**Amazon** عبر محرك \`megadose/ignorant\` و\`yocial\` بدون إرسال أي إشعار للهدف\n` +
        `• كشف حساب **Facebook** المرتبط عبر \`Eyecon Graph\`\n` +
        `• التتبع العكسي للمعرّفات (\`@username\`) عبر X/Twitter وTikTok وFacebook وGitHub\n` +
        `• توليد وفحص روابط البحث المتقدم \`PhoneInfoga OSINT Dorks\``,
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      toastText: '🌐 أدخل رقم الهاتف لكشف الحسابات المرتبطة',
      route: 'cyber:social_lookup',
    };
  }

  public promptFullScan(adminId: number): BotViewResponse {
    this.setInputStep(adminId, 'AWAITING_FULL_SCAN');
    return {
      text:
        `⚡ *الفحص الجنائي الشامل لرقم الهاتف (الأسماء + الحسابات المرتبطة + التقرير الكامل)*\n` +
        `────────────────────────\n` +
        `أرسل الآن رقم الهاتف المراد إجراء الفحص الجنائي الشامل عليه:`,
      keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      toastText: '⚡ أدخل رقم الهاتف للفحص الشامل',
      route: 'cyber:full_scan',
    };
  }

  public renderSettingsMenu(notice?: string): BotViewResponse {
    const tcToken = this.engine.getTruecallerInstallationId();
    const eyecon = this.engine.getEyeconCredentials();
    const numverify = this.engine.getNumverifyApiKey();

    const mask = (v: string) =>
      v ? `${v.slice(0, 6)}...${v.slice(-4)} (مفعّل ✅)` : 'غير مضبوط ⚠️';

    const text =
      (notice ? `${notice}\n────────────────────────\n` : '') +
      `🔑 *إعدادات مصادر ومفاتيح البحث الجنائي (OSINT Providers)*\n` +
      `────────────────────────\n` +
      `• 📞 *Truecaller Installation ID:* \`${mask(tcToken)}\`\n` +
      `• 👁️ *Eyecon Auth (e-auth):* \`${mask(eyecon.eAuth)}\`\n` +
      `• 📡 *Numverify API Key:* \`${mask(numverify)}\`\n\n` +
      `💡 *ملاحظة:* يمكنك تسجيل الدخول مباشرةً في Truecaller عبر رقم الهاتف ورمز OTP من الزر أدناه (بنفس بروتوكول مكتبة \`truecallerjs\`) أو لصق مفتاح \`installationId\` يدوياً:`;

    const keyboard: InlineKeyboardRows = [
      [
        {
          text: '📲 تسجيل دخول Truecaller عبر رمز OTP',
          callbackData: 'cyber:tc_login_otp',
        },
      ],
      [
        {
          text: '🔑 إدخال مفتاح Truecaller يدوياً',
          callbackData: 'cyber:tc_set_token',
        },
        {
          text: '👁️ إعداد مفتاح Eyecon',
          callbackData: 'cyber:eyecon_set',
        },
      ],
      [
        {
          text: '📡 إعداد مفتاح Numverify API',
          callbackData: 'cyber:numverify_set',
        },
      ],
      buildAppNavigationRow({
        backCallback: 'menu:cyber_forensics',
        refreshCallback: 'cyber:settings',
      }),
    ];

    return {
      text,
      keyboard,
      toastText: '🔑 إعدادات مصادر البحث الجنائي',
      route: 'cyber:settings',
    };
  }

  public renderHistoryPage(page = 1): BotViewResponse {
    const history = this.engine.getRecentForensicHistory();
    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(history.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = history.slice((safePage - 1) * pageSize, safePage * pageSize);

    let text =
      `🗂️ *سجل الفحوصات الجنائية للأرقام (${history.length}) — صفحة ${safePage}/${totalPages}*\n` +
      `────────────────────────\n`;

    const rows: InlineKeyboardRows = [];

    if (slice.length === 0) {
      text += `لا توجد عمليات فحص مسجلة حتى الآن.`;
    } else {
      slice.forEach((item, idx) => {
        const digits = item.phoneE164.replace(/\D/g, '');
        text +=
          `*${(safePage - 1) * pageSize + idx + 1}.* \`${item.phoneE164}\` (${item.countryAr})\n` +
          `   └ 👤 الاسم الأبرز: *${item.topName}*\n` +
          `   └ 🏢 الشبكة: ${item.carrier} | الأسماء: ${item.namesCount} | الحسابات: ${item.socialCount}\n\n`;
        rows.push([
          {
            text: `🔎 ${item.phoneE164} (${item.topName.slice(0, 18)})`,
            callbackData: `cyber:rescan:${digits}`,
          },
        ]);
      });
    }

    if (totalPages > 1) {
      const navRow = [];
      if (safePage > 1) {
        navRow.push({
          text: '⬅️ السابق',
          callbackData: `cyber:history:page:${safePage - 1}`,
        });
      }
      if (safePage < totalPages) {
        navRow.push({
          text: 'التالي ➡️',
          callbackData: `cyber:history:page:${safePage + 1}`,
        });
      }
      if (navRow.length > 0) rows.push(navRow);
    }

    rows.push(
      buildAppNavigationRow({
        backCallback: 'menu:cyber_forensics',
        refreshCallback: `cyber:history:page:${safePage}`,
      })
    );

    return {
      text,
      keyboard: rows,
      toastText: '🗂️ سجل الفحوصات الجنائية',
      route: `cyber:history:page:${safePage}`,
    };
  }

  public async executeInvestigationAndFormatView(
    adminId: number,
    rawPhoneInput: string,
    mode: 'PHONE_NAMES_ONLY' | 'SOCIAL_ONLY' | 'FULL_DOSSIER'
  ): Promise<BotViewResponse> {
    const normalized = parseAndNormalizePhoneInput(rawPhoneInput);
    if (!normalized.isValidLength) {
      return {
        text:
          `⚠️ *رقم الهاتف المدخل غير صالح:* \`${rawPhoneInput}\`\n` +
          `يرجى إدخال رقم هاتف صحيح مع مفتاح الدولة (مثال: \`+967775224395\` أو \`+966501234567\`).`,
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    this.setInputStep(adminId, 'IDLE');
    const report = await this.engine.runFullForensicInvestigation(rawPhoneInput, mode);
    this.lastReportByPhone.set(report.phone.digitsOnly, report);

    this.auditRepo.record({
      actorTelegramId: adminId,
      action: `CYBER_FORENSIC_${mode}`,
      targetId: report.phone.e164,
      outcome: 'SUCCESS',
      metadata: {
        reportId: report.reportId,
        discoveredNamesCount: report.discoveredNames.length,
        confirmedSocialCount: report.socialAccounts.filter((s) => s.exists).length,
      },
    });

    const lines: string[] = [];
    lines.push(
      `🕵️‍♂️ *التقرير الجنائي السيبراني للرقم:* \`${report.phone.e164}\`\n` +
        `────────────────────────\n` +
        `📌 *1. البيانات الاتصالية والجغرافية:*\n` +
        `• الصيغة الدولية: \`${report.phone.internationalFormatted}\`\n` +
        `• الصيغة المحلية: \`${report.phone.localWithZero}\`\n` +
        `• الدولة: *${report.phone.countryNameArabic}* (\`${report.phone.isoCountry2}\`)\n` +
        `• المشغل / الشبكة: *${report.phone.inferredCarrier}*\n` +
        `• نوع الخط: \`${report.phone.lineType}\`` +
        (report.isDisposableBurner
          ? `\n• 🚨 *تحذير أمني:* الرقم مرصود ضمن أرقام الاستقبال المؤقتة (${report.disposableMatchedDomains.join(', ')})`
          : '')
    );

    if (mode === 'PHONE_NAMES_ONLY' || mode === 'FULL_DOSSIER') {
      lines.push(
        `\n────────────────────────\n👤 *2. جميع الأسماء والهويات المرتبطة بالرقم (${report.discoveredNames.length}):*`
      );
      if (report.discoveredNames.length === 0) {
        lines.push(`• لم يتم العثور على اسم مسجل في الأدلة الحالية لهذا الرقم.`);
      } else {
        report.discoveredNames.slice(0, 12).forEach((item, idx) => {
          const badge =
            item.confidence === 'HIGH' ? '🟢' : item.confidence === 'MEDIUM' ? '🟡' : '⚪';
          lines.push(
            `${idx + 1}. ${badge} *${item.name}* — _(${item.source})_${
              item.extraInfo ? ` [${item.extraInfo}]` : ''
            }`
          );
        });
      }

      if (report.truecallerData?.queried) {
        if (report.truecallerData.found) {
          lines.push(
            `\n📞 *تفاصيل دليل Truecaller:*\n` +
              `• الاسم الأساسي: *${report.truecallerData.name || '-'}*\n` +
              (report.truecallerData.altName
                ? `• الاسم البديل: *${report.truecallerData.altName}*\n`
                : '') +
              (report.truecallerData.email
                ? `• البريد الإلكتروني: \`${report.truecallerData.email}\`\n`
                : '') +
              (report.truecallerData.city
                ? `• المدينة: ${report.truecallerData.city}\n`
                : '') +
              (report.truecallerData.spamScore
                ? `• مؤشر الإزعاج (Spam Score): \`${report.truecallerData.spamScore}\``
                : '')
          );
        } else if (report.truecallerData.error) {
          lines.push(`\nℹ️ *ملاحظة Truecaller:* ${report.truecallerData.error}`);
        }
      }

      const wa = report.whatsappFootprint;
      lines.push(
        `\n🟢 *بصمة بروتوكول واتساب (WhatsApp Intelligence):*\n` +
          `• حالة التسجيل: ${wa.registered ? '✅ مسجل ونشط' : wa.checked ? '❌ غير مسجل' : '⚪ لم يتم التحقق المباشر'}\n` +
          (wa.jid ? `• معرّف JID: \`${wa.jid}\`\n` : '') +
          (wa.lid ? `• معرّف الخصوصية LID: \`${wa.lid}\`\n` : '') +
          (wa.linkedDevices.length > 0
            ? `• الأجهزة المرتبطة (${wa.linkedDevices.length}): \`${wa.linkedDevices
                .map((d) => (d === 0 ? ':0 هاتف أساسي' : `:${d} جهاز مرافق`))
                .join(', ')}\`\n`
            : '') +
          (wa.verifiedBusinessName
            ? `• اسم النشاط التجاري: *${wa.verifiedBusinessName}*${
                wa.businessCategory ? ` (${wa.businessCategory})` : ''
              }\n`
            : '') +
          (wa.statusBio
            ? `• النبذة (Bio): _${wa.statusBio}_${wa.statusSetAt ? ` (${wa.statusSetAt})` : ''}\n`
            : '') +
          `• رابط المحادثة المباشر: [فتح في واتساب](${wa.directChatUrl})`
      );
    }

    if (mode === 'SOCIAL_ONLY' || mode === 'FULL_DOSSIER') {
      lines.push(`\n────────────────────────\n🌐 *3. الحسابات والمنصات المرتبطة بالرقم:*`);
      for (const acc of report.socialAccounts) {
        const statusIcon =
          acc.status === 'CONFIRMED'
            ? '✅'
            : acc.status === 'LIKELY'
              ? '🔗'
              : acc.status === 'NOT_FOUND'
                ? '❌'
                : '🔎';
        lines.push(
          `• ${acc.icon} *${acc.platform}:* ${statusIcon} ${acc.details}\n` +
            `   └ 🔗 [فتح الرابط المباشر](${acc.url})`
        );
      }

      lines.push(`\n🔎 *روابط البحث الجنائي العميق (PhoneInfoga OSINT Dorks):*`);
      const socialDorks = report.osintDorks.filter(
        (d) => d.category === 'SOCIAL_MEDIA' || d.category === 'CALLER_DIRECTORY'
      );
      for (const d of socialDorks.slice(0, 8)) {
        lines.push(`• [${d.title}](${d.googleUrl}) | [DuckDuckGo](${d.duckDuckGoUrl})`);
      }

      if (report.liveWebMentions.length > 0) {
        lines.push(
          `\n📄 *نتائج الويب والأدلة الحية المرصودة (${report.liveWebMentions.length}):*`
        );
        for (const hit of report.liveWebMentions.slice(0, 4)) {
          lines.push(`• [${hit.title.slice(0, 50)}](${hit.url}) — _${hit.sourceDomain}_`);
        }
      }
    }

    const digits = report.phone.digitsOnly;
    const keyboard: InlineKeyboardRows = [
      [
        {
          text: '🔎 فحص الأسماء فقط',
          callbackData: `cyber:run_phone:${digits}`,
        },
        {
          text: '🌐 فحص الحسابات المرتبطة',
          callbackData: `cyber:run_social:${digits}`,
        },
      ],
      [
        {
          text: '⚡ الفحص الجنائي الشامل',
          callbackData: `cyber:rescan:${digits}`,
        },
        {
          text: '📥 تصدير التقرير JSON',
          callbackData: `cyber:export:${digits}`,
        },
      ],
      [
        {
          text: '🔎 فحص رقم جديد',
          callbackData:
            mode === 'SOCIAL_ONLY' ? 'cyber:social_lookup' : 'cyber:phone_lookup',
        },
        {
          text: '🔑 إعدادات المفاتيح',
          callbackData: 'cyber:settings',
        },
      ],
      buildAppNavigationRow({
        backCallback: 'menu:cyber_forensics',
        refreshCallback: `cyber:rescan:${digits}`,
      }),
    ];

    const mediaAttachments: TelegramMediaAttachment[] = [];
    if (report.whatsappFootprint.profilePictureBuffer) {
      const tmpDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
      fs.mkdirSync(tmpDir, { recursive: true });
      const avatarPath = path.join(tmpDir, `forensic_avatar_${digits}.jpg`);
      try {
        fs.writeFileSync(avatarPath, report.whatsappFootprint.profilePictureBuffer);
        mediaAttachments.push({
          kind: 'photo',
          filePath: avatarPath,
          fileName: `whatsapp_avatar_${digits}.jpg`,
          mimeType: 'image/jpeg',
          caption: `🖼️ الصورة الشخصية على واتساب للرقم ${report.phone.e164}`,
        });
      } catch {
        // Ignore avatar write error
      }
    }

    return {
      text: lines.join('\n'),
      keyboard,
      mediaAttachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
      toastText: `✅ اكتمل الفحص الجنائي للرقم ${report.phone.e164}`,
      route: 'menu:cyber_forensics',
    };
  }

  public exportReportJsonAttachment(digitsInput: string): BotViewResponse {
    const digits = digitsInput.replace(/\D/g, '');
    const report = this.lastReportByPhone.get(digits);
    if (!report) {
      return {
        text: '⚠️ لم يتم العثور على التقرير في الذاكرة المؤقتة. أعد تشغيل الفحص أولاً.',
        keyboard: [buildBackCancelRow('menu:cyber_forensics')],
      };
    }

    const tmpDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = `forensic_report_${digits}_${Date.now()}.json`;
    const filePath = path.join(tmpDir, fileName);

    const serializable = {
      ...report,
      whatsappFootprint: {
        ...report.whatsappFootprint,
        profilePictureBuffer: undefined,
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf8');

    return {
      text: `📥 *تم تصدير التقرير الجنائي الكامل للرقم* \`${report.phone.e164}\` *بصيغة JSON.*`,
      keyboard: [
        [
          {
            text: '🔙 العودة لنتيجة الفحص',
            callbackData: `cyber:rescan:${digits}`,
          },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:cyber_forensics',
          refreshCallback: 'menu:cyber_forensics',
        }),
      ],
      mediaAttachments: [
        {
          kind: 'document',
          filePath,
          fileName,
          mimeType: 'application/json',
          caption: `🕵️‍♂️ التقرير الجنائي السيبراني الكامل للرقم ${report.phone.e164}`,
        },
      ],
    };
  }

  public async handleTextInput(
    adminId: number,
    text: string
  ): Promise<BotViewResponse> {
    const step = this.getInputStep(adminId);
    const trimmed = text.trim();

    if (step === 'AWAITING_PHONE_LOOKUP') {
      return this.executeInvestigationAndFormatView(
        adminId,
        trimmed,
        'PHONE_NAMES_ONLY'
      );
    }
    if (step === 'AWAITING_SOCIAL_LOOKUP') {
      return this.executeInvestigationAndFormatView(
        adminId,
        trimmed,
        'SOCIAL_ONLY'
      );
    }
    if (step === 'AWAITING_FULL_SCAN') {
      return this.executeInvestigationAndFormatView(
        adminId,
        trimmed,
        'FULL_DOSSIER'
      );
    }

    if (step === 'AWAITING_TRUECALLER_LOGIN_PHONE') {
      const res = await this.engine.initiateTruecallerLoginOtp(adminId, trimmed);
      if (res.ok) {
        this.setInputStep(adminId, 'AWAITING_TRUECALLER_OTP');
        return {
          text: `📲 *${res.message}*`,
          keyboard: [buildBackCancelRow('cyber:settings')],
        };
      }
      return {
        text: `⚠️ *${res.message}*`,
        keyboard: [buildBackCancelRow('cyber:settings')],
      };
    }

    if (step === 'AWAITING_TRUECALLER_OTP') {
      const res = await this.engine.verifyTruecallerLoginOtp(adminId, trimmed);
      if (res.ok) {
        this.setInputStep(adminId, 'IDLE');
        return this.renderSettingsMenu(res.message);
      }
      return {
        text: `⚠️ *${res.message}*`,
        keyboard: [buildBackCancelRow('cyber:settings')],
      };
    }

    if (step === 'AWAITING_TRUECALLER_TOKEN_MANUAL') {
      this.engine.setTruecallerInstallationId(trimmed);
      this.setInputStep(adminId, 'IDLE');
      return this.renderSettingsMenu('✅ تم حفظ مفتاح Truecaller (installationId) بنجاح.');
    }

    if (step === 'AWAITING_EYECON_AUTH') {
      const parts = trimmed.split(/\s+/);
      this.engine.setEyeconCredentials(parts[0] || '', parts[1] || 'e1', parts[2] || '40');
      this.setInputStep(adminId, 'IDLE');
      return this.renderSettingsMenu('✅ تم حفظ بيانات مصادقة Eyecon بنجاح.');
    }

    if (step === 'AWAITING_NUMVERIFY_KEY') {
      this.engine.setNumverifyApiKey(trimmed);
      this.setInputStep(adminId, 'IDLE');
      return this.renderSettingsMenu('✅ تم حفظ مفتاح Numverify API بنجاح.');
    }

    return this.executeInvestigationAndFormatView(adminId, trimmed, 'FULL_DOSSIER');
  }
}
