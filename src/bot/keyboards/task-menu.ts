import { TaskWithResults } from '../../database/repositories/task-repository';
import { InlineKeyboardRows, InlineButtonSpec } from './main-menu';

const TASK_STATUS_ARABIC: Record<TaskWithResults['status'], string> = {
  PENDING: '⏳ قيد الانتظار',
  RUNNING: '🔄 قيد التنفيذ المتزامن',
  COMPLETED: '✅ مكتملة بنجاح',
  PARTIALLY_COMPLETED: '⚠️ مكتملة جزئياً',
  FAILED: '❌ فشلت',
  CANCELLED: '🚫 ملغاة',
};

const OPERATION_ARABIC: Record<TaskWithResults['operation_type'], string> = {
  SEND_TEXT: '✉️ إرسال رسالة نصية',
  SEND_MEDIA: '📎 إرسال وسائط/ملف',
  JOIN_GROUP: '🔗 انضمام لمجموعة',
  GROUP_ACTION: '👥 إدارة مجموعة',
};

export function formatTaskStatusArabic(status: TaskWithResults['status']): string {
  return TASK_STATUS_ARABIC[status] || status;
}

export function formatOperationTypeArabic(op: TaskWithResults['operation_type']): string {
  return OPERATION_ARABIC[op] || op;
}

export function buildTaskListKeyboard(params: {
  tasks: TaskWithResults[];
  page: number;
  pageSize?: number;
}): { rows: InlineKeyboardRows; currentPage: number; totalPages: number } {
  const pageSize = params.pageSize ?? 5;
  const totalPages = Math.max(1, Math.ceil(params.tasks.length / pageSize));
  const currentPage = Math.min(Math.max(1, params.page), totalPages);
  const startIdx = (currentPage - 1) * pageSize;
  const slice = params.tasks.slice(startIdx, startIdx + pageSize);

  const rows: InlineKeyboardRows = [];

  for (const t of slice) {
    rows.push([
      {
        text: `${formatTaskStatusArabic(t.status)} | ${formatOperationTypeArabic(t.operation_type)} (${t.selectedSessionIds.length} جلسات)`,
        callbackData: `task:view:${t.id}`,
      },
    ]);
  }

  if (totalPages > 1) {
    const navRow: InlineButtonSpec[] = [];
    if (currentPage > 1) {
      navRow.push({
        text: '⬅️ السابق',
        callbackData: `menu:tasks:page:${currentPage - 1}`,
      });
    }
    navRow.push({
      text: `صفحة ${currentPage}/${totalPages}`,
      callbackData: `menu:tasks:page:${currentPage}`,
    });
    if (currentPage < totalPages) {
      navRow.push({
        text: 'التالي ➡️',
        callbackData: `menu:tasks:page:${currentPage + 1}`,
      });
    }
    rows.push(navRow);
  }

  rows.push([
    { text: '🔄 تحديث المهام', callbackData: `menu:tasks:page:${currentPage}` },
    { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
  ]);

  return { rows, currentPage, totalPages };
}

export function buildTaskDetailKeyboard(task: TaskWithResults): InlineKeyboardRows {
  const rows: InlineKeyboardRows = [];
  if (task.status === 'PENDING' || task.status === 'RUNNING') {
    rows.push([
      { text: '🛑 طلب إلغاء المهمة', callbackData: `task:cancel:${task.id}` },
    ]);
  }
  rows.push([
    { text: '🔄 تحديث النتيجة', callbackData: `task:view:${task.id}` },
    { text: '🔙 رجوع لقائمة المهام', callbackData: 'menu:tasks:page:1' },
  ]);
  return rows;
}
