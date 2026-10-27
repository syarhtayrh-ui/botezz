import { SessionManager } from '../../whatsapp/session-manager';
import {
  buildSessionManagementKeyboard,
  buildSessionDetailKeyboard,
  formatSessionStatusArabic,
} from '../keyboards/session-menu';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';

export class SessionsHandler {
  constructor(private readonly sessionManager: SessionManager) {}

  public renderSessionsList(page = 1): BotViewResponse {
    const sessions = this.sessionManager.listSessions();
    const { rows, currentPage, totalPages } = buildSessionManagementKeyboard({
      sessions,
      page,
    });

    if (sessions.length === 0) {
      return {
        text:
          `📋 *إدارة الجلسات*\n\n` +
          `لا توجد أي جلسات واتساب مرتبطة حالياً. اضغط على "ربط جلسة جديدة" للبدء.`,
        keyboard: rows,
      };
    }

    return {
      text:
        `📋 *إدارة الجلسات المرتبطة* (صفحة ${currentPage} من ${totalPages})\n` +
        `إجمالي الجلسات: *${sessions.length}*\n\n` +
        `اختر جلسة لعرض تفاصيلها أو إدارتها:`,
      keyboard: rows,
    };
  }

  public renderSessionDetail(sessionId: string): BotViewResponse {
    const sess = this.sessionManager.getSession(sessionId);
    if (!sess) {
      return {
        text: '⚠️ لم يتم العثور على الجلسة المطلوبة.',
        keyboard: [[{ text: '🔙 رجوع لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }]],
      };
    }

    return {
      text:
        `📱 *تفاصيل الجلسة:* ${sess.label}\n\n` +
        `🆔 المعرف الداخلي: \`${sess.id}\`\n` +
        `📞 رقم الهاتف المقنع: \`${sess.masked_phone || 'غير مقترن بعد'}\`\n` +
        `📡 حالة الاتصال: ${formatSessionStatusArabic(sess.status)}\n` +
        `🕒 آخر تحديث للحالة: \`${sess.last_status_at}\`\n` +
        `🔁 محاولات إعادة الاتصال: ${sess.reconnect_attempts}\n` +
        `${sess.last_error ? `⚠️ آخر ملاحظة/خطأ: ${sess.last_error}\n` : ''}\n` +
        `_بيانات المصادقة محفوظة في مجلد معزول ومحمية ولا تُعرض في تيليجرام._`,
      keyboard: buildSessionDetailKeyboard(sess),
    };
  }

  public async handleReconnect(
    sessionId: string,
    adminId: number
  ): Promise<BotViewResponse> {
    try {
      await this.sessionManager.reconnectSession(sessionId, adminId);
      return this.renderSessionDetail(sessionId);
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *فشلت إعادة الاتصال:*\n${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 رجوع لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }]],
      };
    }
  }

  public async handleDisconnect(
    sessionId: string,
    adminId: number
  ): Promise<BotViewResponse> {
    try {
      await this.sessionManager.disconnectSession(sessionId, adminId);
      return this.renderSessionDetail(sessionId);
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *فشل قطع الاتصال:*\n${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 رجوع لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }]],
      };
    }
  }

  public renderConfirmRemove(sessionId: string): BotViewResponse {
    const sess = this.sessionManager.getSession(sessionId);
    if (!sess) {
      return this.renderSessionsList(1);
    }

    return {
      text:
        `⚠️ *تأكيد حذف الجلسة نهائياً*\n\n` +
        `هل أنت متأكد من حذف الجلسة *${sess.label}* (\`${sess.id}\`)؟\n` +
        `سيتم تسجيل الخروج وحذف مجلد المصادقة المحلي الخاص بها نهائياً.`,
      keyboard: [
        [
          { text: '✅ نعم، احذف الجلسة نهائياً', callbackData: `sess:remove:${sess.id}` },
          { text: '❌ إلغاء', callbackData: `sess:view:${sess.id}` },
        ],
      ],
    };
  }

  public async handleRemove(
    sessionId: string,
    adminId: number
  ): Promise<BotViewResponse> {
    try {
      await this.sessionManager.removeSession(sessionId, adminId);
      return {
        text: `🗑️ تم حذف الجلسة (\`${sessionId}\`) وإزالة ملفات المصادقة الخاصة بها بأمان.`,
        keyboard: [[{ text: '📋 العودة لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }]],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ ${safeErr.userMessage}`,
        keyboard: [[{ text: '📋 العودة لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }]],
      };
    }
  }
}
