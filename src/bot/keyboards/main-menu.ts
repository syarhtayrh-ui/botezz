import { InlineKeyboard } from 'grammy';

export interface InlineButtonSpec {
  text: string;
  callbackData: string;
}

export type InlineKeyboardRows = InlineButtonSpec[][];

export function toGrammyInlineKeyboard(rows: InlineKeyboardRows): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, rowIdx) => {
    row.forEach((btn) => {
      kb.text(btn.text, btn.callbackData);
    });
    if (rowIdx < rows.length - 1) {
      kb.row();
    }
  });
  return kb;
}

/**
 * Builds the 11-item Arabic Main Menu specified in Section 3.
 */
export function buildMainMenuKeyboard(): InlineKeyboardRows {
  return [
    [
      { text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' },
      { text: '➕ إضافة حساب آخر', callbackData: 'menu:add_account' },
    ],
    [{ text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' }],
    [
      { text: '✉️ إرسال رسالة نصية', callbackData: 'menu:send_text' },
      { text: '📎 إرسال وسائط أو ملف', callbackData: 'menu:send_media' },
    ],
    [
      { text: '👥 إدارة المجموعات', callbackData: 'menu:groups' },
      { text: '🔗 الانضمام إلى مجموعة', callbackData: 'menu:join_group' },
    ],
    [
      { text: '📊 مراقبة المهام', callbackData: 'menu:tasks:page:1' },
      { text: '📜 سجل النشاط', callbackData: 'menu:audit:page:1' },
    ],
    [
      { text: '⚙️ الإعدادات', callbackData: 'menu:settings' },
      { text: 'ℹ️ المساعدة وحالة النظام', callbackData: 'menu:help_status' },
    ],
    [
      {
        text: '🛠️ الأدوات وفحص القنوات والشبكة',
        callbackData: 'menu:tools',
      },
    ],
  ];
}

export function buildBackCancelRow(backCallback = 'menu:main'): InlineButtonSpec[] {
  return [
    { text: '🔙 رجوع', callbackData: backCallback },
    { text: '❌ إلغاء', callbackData: 'workflow:cancel' },
  ];
}
