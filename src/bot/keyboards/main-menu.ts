import { InlineKeyboard } from 'grammy';

export interface InlineButtonSpec {
  text: string;
  callbackData: string;
}

export type InlineKeyboardRows = InlineButtonSpec[][];

export const MAX_TELEGRAM_CALLBACK_DATA_BYTES = 64;

export function toGrammyInlineKeyboard(rows: InlineKeyboardRows): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, rowIdx) => {
    row.forEach((btn) => {
      const byteLen = Buffer.byteLength(btn.callbackData, 'utf8');
      if (byteLen > MAX_TELEGRAM_CALLBACK_DATA_BYTES) {
        throw new Error(
          `Telegram callback_data exceeds 64-byte limit (${byteLen} bytes): ${btn.callbackData}`
        );
      }
      kb.text(btn.text, btn.callbackData);
    });
    if (rowIdx < rows.length - 1) {
      kb.row();
    }
  });
  return kb;
}

export interface MainMenuKeyboardOptions {
  /** Whether the user is an authorized system administrator (defaults to true) */
  isAdmin?: boolean;
}

/**
 * Builds the Application Main Menu with role-aware visibility.
 * Covers all required application sections:
 * - WhatsApp Sessions, Add/Pair Session, Session Status, Sender Management,
 *   Group Management, Premium & Subscription Management, Admin Controls,
 *   Settings, Help & About, and Tools.
 */
export function buildMainMenuKeyboard(
  options?: MainMenuKeyboardOptions
): InlineKeyboardRows {
  const isAdmin = options?.isAdmin ?? true;

  const rows: InlineKeyboardRows = [
    [
      { text: '📱 قسم أدوات وإدارة واتساب', callbackData: 'menu:whatsapp_tools' },
      {
        text: '🕵️‍♂️ التحليل الجنائي السيبراني (OSINT)',
        callbackData: 'menu:cyber_forensics',
      },
    ],
    [
      { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
      { text: '➕ إضافة حساب آخر', callbackData: 'menu:add_account' },
    ],
    [
      { text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' },
      { text: '📡 حالة الجلسات', callbackData: 'menu:session_status' },
    ],
    [
      { text: '🔌 إدارة المرسلين (Senders)', callbackData: 'menu:senders:page:1' },
      { text: '👥 إدارة المجموعات', callbackData: 'menu:groups' },
    ],
    [
      { text: '✉️ إرسال رسالة نصية', callbackData: 'menu:send_text' },
      { text: '📎 إرسال وسائط أو ملف', callbackData: 'menu:send_media' },
    ],
    [
      { text: '📹 اتصال مرئي ببث مسجل', callbackData: 'menu:video_call' },
      { text: '🔗 الانضمام إلى مجموعة', callbackData: 'menu:join_group' },
    ],
    [
      { text: '📥 قسم استقبال الرسائل', callbackData: 'menu:inbox:page:1' },
      { text: '⭕ تحميلات الحالات', callbackData: 'menu:stories:page:1' },
    ],
    [
      { text: '🕵️ جلسة مجهولة (تواصل مخفي)', callbackData: 'menu:anon_sessions' },
      { text: '🛠️ الأدوات ومختبر الدوال', callbackData: 'menu:tools' },
    ],
  ];

  if (isAdmin) {
    rows.push([
      { text: '🌐 حركة مرور الشبكة والطلبات', callbackData: 'menu:network' },
      { text: '🛡️ المحلل الأمني والجنائي', callbackData: 'menu:sec_analyzer' },
    ]);
    rows.push([
      { text: '⭐ الاشتراكات (Premium)', callbackData: 'menu:subscriptions:page:1' },
      { text: '🛡️ تحكم المشرف (Admin)', callbackData: 'menu:admin' },
    ]);
    rows.push([
      { text: '📊 مراقبة المهام', callbackData: 'menu:tasks:page:1' },
      { text: '📜 سجل النشاط', callbackData: 'menu:audit:page:1' },
    ]);
    rows.push([
      { text: '⚙️ الإعدادات', callbackData: 'menu:settings' },
      { text: 'ℹ️ المساعدة وحول النظام', callbackData: 'menu:help_status' },
    ]);
  } else {
    rows.push([
      { text: '🪪 بطاقة الحساب (/info)', callbackData: 'tools:info' },
      { text: 'ℹ️ المساعدة وحول النظام', callbackData: 'menu:help_status' },
    ]);
  }

  rows.push([{ text: '🔄 تحديث القائمة الرئيسية', callbackData: 'nav:refresh' }]);

  return rows;
}

/**
 * Builds the dedicated WhatsApp Tools & Management Menu (`menu:whatsapp_tools`).
 */
export function buildWhatsAppToolsMenuKeyboard(
  options?: MainMenuKeyboardOptions
): InlineKeyboardRows {
  const isAdmin = options?.isAdmin ?? true;
  const rows: InlineKeyboardRows = [
    [
      { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
      { text: '➕ إضافة حساب آخر', callbackData: 'menu:add_account' },
    ],
    [
      { text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' },
      { text: '📡 حالة الجلسات', callbackData: 'menu:session_status' },
    ],
    [
      { text: '🔌 إدارة المرسلين (Senders)', callbackData: 'menu:senders:page:1' },
      { text: '👥 إدارة المجموعات', callbackData: 'menu:groups' },
    ],
    [
      { text: '✉️ إرسال رسالة نصية', callbackData: 'menu:send_text' },
      { text: '📎 إرسال وسائط أو ملف', callbackData: 'menu:send_media' },
    ],
    [
      { text: '📹 اتصال مرئي ببث مسجل', callbackData: 'menu:video_call' },
      { text: '🔗 الانضمام إلى مجموعة', callbackData: 'menu:join_group' },
    ],
    [
      { text: '📥 قسم استقبال الرسائل', callbackData: 'menu:inbox:page:1' },
      { text: '⭕ تحميلات الحالات', callbackData: 'menu:stories:page:1' },
    ],
    [
      { text: '🕵️ جلسة مجهولة (تواصل مخفي)', callbackData: 'menu:anon_sessions' },
      { text: '🛠️ الأدوات ومختبر الدوال', callbackData: 'menu:tools' },
    ],
  ];

  if (isAdmin) {
    rows.push([
      { text: '🌐 حركة مرور الشبكة والطلبات', callbackData: 'menu:network' },
      { text: '🛡️ المحلل الأمني والجنائي', callbackData: 'menu:sec_analyzer' },
    ]);
  }

  rows.push(
    buildAppNavigationRow({
      backCallback: 'menu:main',
      refreshCallback: 'menu:whatsapp_tools',
    })
  );
  return rows;
}

/**
 * Builds the Cyber Forensics & Phone/Social/Breach OSINT Menu (`menu:cyber_forensics`).
 */
export function buildCyberForensicsMenuKeyboard(): InlineKeyboardRows {
  return [
    [
      {
        text: '🧠 الفحص الجنائي الذكي الشامل (Auto-Detect OSINT)',
        callbackData: 'cyber:smart_scan',
      },
    ],
    [
      {
        text: '🔎 كاشف الأرقام والأسماء وواتساب',
        callbackData: 'cyber:phone_lookup',
      },
      {
        text: '🌐 كاشف الحسابات المرتبطة (15+ منصة)',
        callbackData: 'cyber:social_lookup',
      },
    ],
    [
      {
        text: '🏴‍☠️ فاحص التسريبات والاختراقات (Leaks)',
        callbackData: 'cyber:breach_lookup',
      },
      {
        text: '🕸️ البحث الحي في 10 محركات بحث',
        callbackData: 'cyber:ten_engines_lookup',
      },
    ],
    [
      {
        text: '👤 فحص المعرفات والألعاب + TikTok/Reddit (35+ موقع)',
        callbackData: 'cyber:mod:username',
      },
      {
        text: '📧 فحص البريد + Gravatar + DNS + توليد الصيغ',
        callbackData: 'cyber:mod:email',
      },
    ],
    [
      {
        text: '🌐 النطاقات والـ IP (crt.sh / Shodan / DNS / CMS)',
        callbackData: 'cyber:mod:domain_ip',
      },
      {
        text: '🖼️ جنائيات الصور وEXIF/GPS + تطهير البيانات',
        callbackData: 'cyber:mod:media',
      },
    ],
    [
      {
        text: '✈️ الطيران والسفن والظلال الشمسية (SunCalc / ADS-B)',
        callbackData: 'cyber:mod:geo_transport',
      },
      {
        text: '🏛️ الشركات والعقوبات والعملات الرقمية (OCCRP / BTC)',
        callbackData: 'cyber:mod:corp_crypto',
      },
    ],
    [
      {
        text: '🕰️ الأرشيف التاريخي ودوركس الأشخاص (Wayback / Dorks)',
        callbackData: 'cyber:mod:archive_dorks',
      },
      {
        text: '🕵️ كشف الهوية باليوزر أو الإيميل (Sherlock)',
        callbackData: 'cyber:handle_lookup',
      },
    ],
    [
      {
        text: '⚡ الفحص الجنائي الشامل MAX (الملف الكامل)',
        callbackData: 'cyber:full_scan',
      },
      {
        text: '🧰 دليل 92 أداة استخبارات جنائية معتمدة',
        callbackData: 'cyber:catalog:page:1',
      },
    ],
    [
      {
        text: '📁 سجل الفحوصات الجنائية',
        callbackData: 'cyber:history:page:1',
      },
      {
        text: '🔑 إعدادات الكواشف ومفاتيح API',
        callbackData: 'cyber:settings',
      },
    ],
    buildAppNavigationRow({
      backCallback: 'menu:main',
      refreshCallback: 'menu:cyber_forensics',
    }),
  ];
}

/**
 * Builds a consistent workflow Back + Cancel + Home footer row.
 */
export function buildBackCancelRow(backCallback = 'nav:back'): InlineButtonSpec[] {
  return [
    { text: '🔙 رجوع', callbackData: backCallback },
    { text: '🏠 الرئيسية', callbackData: 'menu:main' },
    { text: '❌ إلغاء', callbackData: 'workflow:cancel' },
  ];
}

/**
 * Builds a consistent application navigation bar (Back, Refresh, Home).
 */
export function buildAppNavigationRow(
  params?:
    | string
    | {
        backCallback?: string;
        refreshCallback?: string;
        includeCancel?: boolean;
      }
): InlineButtonSpec[] {
  const normalized =
    typeof params === 'string'
      ? { backCallback: params, refreshCallback: params }
      : params;
  const row: InlineButtonSpec[] = [
    { text: '🔙 رجوع', callbackData: normalized?.backCallback || 'nav:back' },
    { text: '🔄 تحديث', callbackData: normalized?.refreshCallback || 'nav:refresh' },
    { text: '🏠 الرئيسية', callbackData: 'menu:main' },
  ];
  if (normalized?.includeCancel) {
    row.push({ text: '❌ إلغاء', callbackData: 'workflow:cancel' });
  }
  return row;
}
