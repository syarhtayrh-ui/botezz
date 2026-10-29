import { SessionRecord } from '../../database/repositories/session-repository';
import {
  InlineKeyboardRows,
  InlineButtonSpec,
  buildAppNavigationRow,
} from './main-menu';

const STATUS_BADGE_ARABIC: Record<SessionRecord['status'], string> = {
  CREATED: '🆕 منشأة حديثاً',
  INITIALIZING: '🟡 قيد التهيئة',
  CONNECTING: '🟡 جاري الاتصال',
  WAITING_FOR_PAIRING: '🟡 جاهز لإصدار رمز الربط',
  PAIRING_PENDING: '🟡 بانتظار رمز الربط',
  AUTHENTICATING: '🔵 جاري التوثيق',
  AUTHENTICATED: '🟢 موثق',
  CONNECTED: '🟢 متصل',
  RECOVERING: '🟠 جاري استعادة الجلسة',
  RECONNECTING: '🟠 يعيد الاتصال',
  DISCONNECTED: '🔴 غير متصل',
  LOGGED_OUT: '⚪ تم تسجيل الخروج',
  REQUIRES_REPAIR: '🛠️ يتطلب إعادة ربط',
  STOPPING: '⏹️ جاري الإيقاف',
  STOPPED: '⏹️ متوقف',
  FAILED: '❌ فشل الاتصال',
};

export function formatSessionStatusArabic(status: SessionRecord['status']): string {
  return STATUS_BADGE_ARABIC[status] || status;
}

/**
 * Builds the Session Management Submenu with pagination and consistent navigation.
 */
export function buildSessionManagementKeyboard(params: {
  sessions: SessionRecord[];
  page: number;
  pageSize?: number;
}): {
  rows: InlineKeyboardRows;
  totalPages: number;
  currentPage: number;
} {
  const pageSize = params.pageSize ?? 5;
  const totalPages = Math.max(1, Math.ceil(params.sessions.length / pageSize));
  const currentPage = Math.min(Math.max(1, params.page), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const pageItems = params.sessions.slice(startIdx, startIdx + pageSize);

  const rows: InlineKeyboardRows = [];

  for (const sess of pageItems) {
    const phonePart = sess.masked_phone || 'بدون رقم';
    rows.push([
      {
        text: `${formatSessionStatusArabic(sess.status)} | ${sess.label} (${phonePart})`,
        callbackData: `sess:view:${sess.id}`,
      },
    ]);
  }

  if (totalPages > 1) {
    const navRow: InlineButtonSpec[] = [];
    if (currentPage > 1) {
      navRow.push({
        text: '⬅️ السابق',
        callbackData: `menu:sessions:page:${currentPage - 1}`,
      });
    }
    navRow.push({
      text: `صفحة ${currentPage}/${totalPages}`,
      callbackData: `menu:sessions:page:${currentPage}`,
    });
    if (currentPage < totalPages) {
      navRow.push({
        text: 'التالي ➡️',
        callbackData: `menu:sessions:page:${currentPage + 1}`,
      });
    }
    rows.push(navRow);
  }

  rows.push([
    { text: '📲 ربط جلسة جديدة', callbackData: 'menu:link_account' },
    { text: '📡 ملخص حالة الجلسات', callbackData: 'menu:session_status' },
  ]);

  rows.push([
    { text: '☑️ تحديد عدة جلسات لعملية', callbackData: 'menu:send_text' },
    { text: '🧹 تنظيف غير المتصل', callbackData: 'sess:confirm_purge_inactive' },
  ]);

  rows.push(
    buildAppNavigationRow({
      backCallback: 'nav:back',
      refreshCallback: `sess:refresh:${currentPage}`,
    })
  );

  return { rows, totalPages, currentPage };
}

/**
 * Builds the individual session details action keyboard (reconnect, disconnect, rename, remove, groups).
 */
export function buildSessionDetailKeyboard(session: SessionRecord): InlineKeyboardRows {
  const rows: InlineKeyboardRows = [];

  if (session.status === 'CONNECTED' || session.status === 'AUTHENTICATED') {
    rows.push([
      { text: '🔌 قطع اتصال الجلسة', callbackData: `sess:disconnect:${session.id}` },
      { text: '👥 مجموعات هذه الجلسة', callbackData: `grp:list:${session.id}` },
    ]);
  } else {
    rows.push([
      { text: '🔄 إعادة اتصال الجلسة', callbackData: `sess:reconnect:${session.id}` },
      { text: '📲 إعادة الربط برقم هاتف', callbackData: `sess:repair:${session.id}` },
    ]);
  }

  rows.push([
    { text: '✏️ تغيير اسم الجلسة', callbackData: `sess:prompt_rename:${session.id}` },
    { text: '🗑️ حذف الجلسة نهائياً', callbackData: `sess:confirm_remove:${session.id}` },
  ]);

  rows.push(
    buildAppNavigationRow({
      backCallback: 'menu:sessions:page:1',
      refreshCallback: `sess:view:${session.id}`,
    })
  );
  return rows;
}

/**
 * Builds an interactive multi-session checklist keyboard for workflows.
 */
export function buildMultiSessionSelectorKeyboard(params: {
  sessions: SessionRecord[];
  selectedIds: string[];
  workflowPrefix: string;
}): InlineKeyboardRows {
  const selectedSet = new Set(params.selectedIds);
  const rows: InlineKeyboardRows = [];

  for (const sess of params.sessions) {
    const isSelected = selectedSet.has(sess.id);
    const checkIcon = isSelected ? '✅' : '⬜';
    const phonePart = sess.masked_phone || 'بدون رقم';
    rows.push([
      {
        text: `${checkIcon} ${sess.label} (${phonePart}) - ${formatSessionStatusArabic(sess.status)}`,
        callbackData: `${params.workflowPrefix}:toggle_sess:${sess.id}`,
      },
    ]);
  }

  rows.push([
    {
      text: '☑️ تحديد كل المتصل',
      callbackData: `${params.workflowPrefix}:select_all`,
    },
    {
      text: '⬜ إلغاء تحديد الكل',
      callbackData: `${params.workflowPrefix}:clear_all`,
    },
  ]);

  rows.push([
    {
      text: `➡️ متابعة للملخص (${params.selectedIds.length} محددة)`,
      callbackData: `${params.workflowPrefix}:proceed_confirm`,
    },
  ]);

  rows.push([
    { text: '🔙 رجوع', callbackData: 'nav:back' },
    { text: '🏠 الرئيسية', callbackData: 'menu:main' },
    { text: '❌ إلغاء العملية', callbackData: 'workflow:cancel' },
  ]);

  return rows;
}
