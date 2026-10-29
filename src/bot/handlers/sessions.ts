import { SessionManager } from '../../whatsapp/session-manager';
import {
  buildSessionManagementKeyboard,
  buildSessionDetailKeyboard,
  formatSessionStatusArabic,
} from '../keyboards/session-menu';
import { buildAppNavigationRow, InlineKeyboardRows } from '../keyboards/main-menu';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';

export class SessionsHandler {
  constructor(private readonly sessionManager: SessionManager) {}

  public renderSessionsList(page = 1, actorUserId?: number): BotViewResponse {
    const sessions = this.sessionManager.listSessions(actorUserId);
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
        toastText: '📋 لا توجد جلسات مرتبطة حالياً',
        route: `menu:sessions:page:${currentPage}`,
      };
    }

    return {
      text:
        `📋 *إدارة الجلسات المرتبطة* (صفحة ${currentPage} من ${totalPages})\n` +
        `إجمالي الجلسات: *${sessions.length}*\n\n` +
        `اختر جلسة لعرض تفاصيلها أو إدارتها:`,
      keyboard: rows,
      toastText: `📋 قائمة الجلسات (صفحة ${currentPage}/${totalPages})`,
      route: `menu:sessions:page:${currentPage}`,
    };
  }

  /**
   * Dedicated Session Status Overview screen (`menu:session_status`).
   * Displays clear status indicators for Active, Connecting/Pairing, Disconnected, and Failed sessions.
   */
  public renderSessionStatusOverview(
    actorUserId?: number,
    isAdmin = true
  ): BotViewResponse {
    const sessions = this.sessionManager.listSessions(actorUserId);
    const active = sessions.filter(
      (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
    );
    const connecting = sessions.filter(
      (s) =>
        s.status === 'CREATED' ||
        s.status === 'INITIALIZING' ||
        s.status === 'CONNECTING' ||
        s.status === 'WAITING_FOR_PAIRING' ||
        s.status === 'PAIRING_PENDING' ||
        s.status === 'AUTHENTICATING' ||
        s.status === 'RECOVERING' ||
        s.status === 'RECONNECTING'
    );
    const inactive = sessions.filter(
      (s) =>
        s.status === 'DISCONNECTED' ||
        s.status === 'STOPPING' ||
        s.status === 'STOPPED' ||
        s.status === 'LOGGED_OUT'
    );
    const failed = sessions.filter(
      (s) => s.status === 'FAILED' || s.status === 'REQUIRES_REPAIR'
    );

    const statusLines =
      sessions.length === 0
        ? '_لا توجد جلسات مسجلة حالياً._'
        : sessions
            .slice(0, 8)
            .map(
              (s) =>
                `• ${formatSessionStatusArabic(s.status)} — *${s.label}* (\`${s.masked_phone || s.id}\`)`
            )
            .join('\n');

    const rows: InlineKeyboardRows = [];
    for (const sess of sessions.slice(0, 5)) {
      rows.push([
        {
          text: `${formatSessionStatusArabic(sess.status)} | ${sess.label}`,
          callbackData: `sess:view:${sess.id}`,
        },
      ]);
    }

    rows.push([
      { text: '📋 كل الجلسات (صفحات)', callbackData: 'menu:sessions:page:1' },
      { text: '📲 ربط جلسة جديدة', callbackData: 'menu:link_account' },
    ]);

    if (isAdmin && inactive.length + failed.length > 0) {
      rows.push([
        {
          text: `🧹 تنظيف غير المتصل (${inactive.length + failed.length})`,
          callbackData: 'sess:confirm_purge_inactive',
        },
      ]);
    }

    rows.push(
      buildAppNavigationRow({
        backCallback: 'nav:back',
        refreshCallback: 'menu:session_status',
      })
    );

    return {
      text:
        `📡 *لوحة حالة الجلسات الحية (Session Status Overview)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🟢 *متصلة ونشطة (Active):* \`${active.length}\`\n` +
        `🟡 *قيد الربط / إعادة الاتصال (Connecting):* \`${connecting.length}\`\n` +
        `🔴 *غير متصلة (Inactive):* \`${inactive.length}\`\n` +
        `❌ *فشل / يتطلب إصلاح (Failed/Repair):* \`${failed.length}\`\n` +
        `📊 *إجمالي الجلسات:* \`${sessions.length}\`\n\n` +
        `*تفصيل الحالات:*\n${statusLines}`,
      keyboard: rows,
      toastText: '📡 تم تحديث حالة الجلسات',
      route: 'menu:session_status',
    };
  }

  public renderSessionDetail(sessionId: string, actorUserId?: number): BotViewResponse {
    const verification = this.sessionManager.getLiveVerification(
      sessionId,
      actorUserId
    );
    if (!verification) {
      return {
        text: '⚠️ لم يتم العثور على الجلسة المطلوبة أو غير مصرح لك بالوصول إليها.',
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: 'menu:sessions:page:1',
          }),
        ],
        toastText: '⚠️ الجلسة غير موجودة أو غير مصرح بها',
      };
    }

    const {
      session: sess,
      socketDiagnostics,
      credentialInfo,
      connectionGeneration,
      health,
    } = verification;
    const liveSocketLabel = socketDiagnostics.socketActive
      ? '🟢 نشط ومفتوح'
      : '🔴 مغلق / غير نشط';
    const authStatusLabel = credentialInfo.registered
      ? credentialInfo.backupExists
        ? '✅ موثقة ومحمية بنسخة احتياطية'
        : '✅ موثقة ومكتملة'
      : credentialInfo.corrupted
        ? '❌ تالفة'
        : '⏳ غير مكتملة (بانتظار إتمام الربط)';
    const healthLabel =
      health.status === 'HEALTHY'
        ? `🟢 سليمة (${health.score}/100)`
        : health.status === 'DEGRADED'
          ? `🟠 متدهورة (${health.score}/100)`
          : health.status === 'UNHEALTHY'
            ? `🔴 غير سليمة (${health.score}/100)`
            : `⚪ غير محددة (${health.score}/100)`;

    return {
      text:
        `📱 *تفاصيل الجلسة:* ${sess.label}\n\n` +
        `🆔 المعرف الداخلي: \`${sess.id}\`\n` +
        `📞 رقم الهاتف المقنع: \`${sess.masked_phone || 'غير مقترن بعد'}\`\n` +
        `📡 حالة الاتصال: ${formatSessionStatusArabic(sess.status)}\n` +
        `🩺 صحة الجلسة: ${healthLabel}\n` +
        `🔌 حالة المقبس الحي (WebSocket): ${liveSocketLabel}\n` +
        `🔐 حالة بيانات المصادقة: ${authStatusLabel}\n` +
        `🔢 جيل الاتصال (Epoch): \`#${connectionGeneration}\`\n` +
        `🕒 آخر تحديث للحالة: \`${sess.last_status_at}\`\n` +
        `🔁 محاولات إعادة الاتصال: ${sess.reconnect_attempts}\n` +
        `${sess.last_disconnect_code ? `📟 آخر كود انقطاع: \`${sess.last_disconnect_code}\` (${sess.last_disconnect_reason || 'غير محدد'})\n` : ''}` +
        `${sess.last_error ? `⚠️ آخر ملاحظة/خطأ: ${sess.last_error}\n` : ''}\n` +
        `_بيانات المصادقة محفوظة في مجلد معزول ومحمية ولا تُعرض في تيليجرام._`,
      keyboard: buildSessionDetailKeyboard(sess),
      toastText: `📱 ${sess.label}`,
      route: `sess:view:${sess.id}`,
    };
  }

  public async handleReconnect(
    sessionId: string,
    adminId: number
  ): Promise<BotViewResponse> {
    try {
      await this.sessionManager.reconnectSession(sessionId, adminId);
      const view = this.renderSessionDetail(sessionId, adminId);
      return {
        ...view,
        toastText: '🔄 تمت إعادة اتصال الجلسة بنجاح',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *فشلت إعادة الاتصال:*\n${safeErr.userMessage}`,
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: `sess:view:${sessionId}`,
          }),
        ],
        toastText: safeErr.userMessage,
        showAlert: true,
      };
    }
  }

  public async handleDisconnect(
    sessionId: string,
    adminId: number
  ): Promise<BotViewResponse> {
    try {
      await this.sessionManager.disconnectSession(sessionId, adminId);
      const view = this.renderSessionDetail(sessionId, adminId);
      return {
        ...view,
        toastText: '🔌 تم قطع اتصال الجلسة',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *فشل قطع الاتصال:*\n${safeErr.userMessage}`,
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: `sess:view:${sessionId}`,
          }),
        ],
        toastText: safeErr.userMessage,
        showAlert: true,
      };
    }
  }

  public renderConfirmRemove(
    sessionId: string,
    actorUserId?: number
  ): BotViewResponse {
    const sess = this.sessionManager.getSession(sessionId, actorUserId);
    if (!sess) {
      return this.renderSessionsList(1, actorUserId);
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
        buildAppNavigationRow({
          backCallback: `sess:view:${sess.id}`,
          refreshCallback: `sess:confirm_remove:${sess.id}`,
        }),
      ],
      toastText: '⚠️ يرجى تأكيد حذف الجلسة',
      route: `sess:confirm_remove:${sess.id}`,
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
        keyboard: [
          [{ text: '📋 العودة لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }],
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: 'menu:sessions:page:1',
          }),
        ],
        toastText: '🗑️ تم حذف الجلسة نهائياً',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ ${safeErr.userMessage}`,
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: 'menu:sessions:page:1',
          }),
        ],
        toastText: safeErr.userMessage,
        showAlert: true,
      };
    }
  }

  public renderConfirmPurgeInactive(actorUserId?: number): BotViewResponse {
    const allSessions = this.sessionManager.listSessions(actorUserId);
    const inactive = allSessions.filter(
      (s) => s.status !== 'CONNECTED' && s.status !== 'AUTHENTICATED'
    );

    if (inactive.length === 0) {
      return {
        text: `ℹ️ *لا توجد جلسات غير متصلة للحذف*\nجميع الجلسات المسجلة (${allSessions.length}) متصلة ونشطة حالياً.`,
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: 'menu:session_status',
          }),
        ],
        toastText: 'ℹ️ جميع الجلسات متصلة ونشطة',
      };
    }

    return {
      text:
        `⚠️ *تأكيد تنظيف وحذف الجلسات غير المتصلة*\n\n` +
        `سيتم حذف *${inactive.length}* جلسة غير متصلة/فاشلة وإزالة مجلدات المصادقة الخاصة بها دون المساس بالجلسات المتصلة:\n` +
        inactive
          .slice(0, 6)
          .map((s) => `• *${s.label}* (\`${s.id}\` - ${formatSessionStatusArabic(s.status)})`)
          .join('\n') +
        `\n\nهل تؤكد الحذف النهائي؟`,
      keyboard: [
        [
          {
            text: `✅ نعم، احذف (${inactive.length}) جلسة غير متصلة`,
            callbackData: 'sess:purge_inactive',
          },
          { text: '❌ إلغاء', callbackData: 'menu:sessions:page:1' },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:sessions:page:1',
          refreshCallback: 'sess:confirm_purge_inactive',
        }),
      ],
      toastText: '⚠️ يرجى تأكيد تنظيف الجلسات غير المتصلة',
    };
  }

  public async handlePurgeInactive(adminId: number): Promise<BotViewResponse> {
    const allSessions = this.sessionManager.listSessions(adminId);
    const inactive = allSessions.filter(
      (s) => s.status !== 'CONNECTED' && s.status !== 'AUTHENTICATED'
    );
    for (const sess of inactive) {
      await this.sessionManager.removeSession(sess.id, adminId);
    }
    return {
      text:
        inactive.length > 0
          ? `✅ *تم تنظيف وإعادة تعيين ${inactive.length} جلسة غير متصلة بنجاح دون إيقاف الخادم.*`
          : `ℹ️ جميع الجلسات الحالية (${allSessions.length}) متصلة ونشطة.`,
      keyboard: [
        [{ text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' }],
        buildAppNavigationRow({
          backCallback: 'menu:sessions:page:1',
          refreshCallback: 'menu:sessions:page:1',
        }),
      ],
      toastText: `🧹 تم تنظيف ${inactive.length} جلسة`,
    };
  }
}
