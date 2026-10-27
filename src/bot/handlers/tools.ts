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
  | 'AWAITING_SHORTLINK';

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
    return {
      text:
        `🛠️ *الأدوات والفحص المتقدم (Tools & Diagnostics)*\n\n` +
        `اختر الأداة المطلوبة من الأزرار التفاعلية أدناه أو استخدم الأوامر السريعة مباشرة:\n` +
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
            text: '📡 فحص قناة واتساب (/cekidch)',
            callbackData: 'tools:prompt_channel',
          },
          {
            text: '📱 فحص مقابس الإرسال (/ceksender)',
            callbackData: 'tools:ceksender',
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
            text: '📊 التقرير الشامل (/cekall)',
            callbackData: 'tools:cekall',
          },
          {
            text: '🪪 بطاقة الحساب (/info)',
            callbackData: 'tools:info',
          },
        ],
        [
          {
            text: '🌋 رصد الزلازل (/gempa)',
            callbackData: 'tools:gempa',
          },
          {
            text: '⭐ إدارة الاشتراكات',
            callbackData: 'settings:view_access',
          },
        ],
        [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
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

  public async handleGuidedInput(
    adminId: number,
    rawText: string
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
    return this.renderToolsMenu();
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
