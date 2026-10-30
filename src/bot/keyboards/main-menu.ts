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
      { text: '🛠️ الأدوات ومختبر الدوال', callbackData: 'menu:tools' },
    ],
  ];

  if (isAdmin) {
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
export function buildAppNavigationRow(params?: {
  backCallback?: string;
  refreshCallback?: string;
  includeCancel?: boolean;
}): InlineButtonSpec[] {
  const row: InlineButtonSpec[] = [
    { text: '🔙 رجوع', callbackData: params?.backCallback || 'nav:back' },
    { text: '🔄 تحديث', callbackData: params?.refreshCallback || 'nav:refresh' },
    { text: '🏠 الرئيسية', callbackData: 'menu:main' },
  ];
  if (params?.includeCancel) {
    row.push({ text: '❌ إلغاء', callbackData: 'workflow:cancel' });
  }
  return row;
}
