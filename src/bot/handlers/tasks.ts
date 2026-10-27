import { TaskManager } from '../../tasks/task-manager';
import { AuditRepository } from '../../database/repositories/audit-repository';
import {
  buildTaskListKeyboard,
  buildTaskDetailKeyboard,
  formatTaskStatusArabic,
  formatOperationTypeArabic,
} from '../keyboards/task-menu';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';

export class TasksHandler {
  constructor(
    private readonly taskManager: TaskManager,
    private readonly auditRepo: AuditRepository
  ) {}

  public renderTaskMonitor(page = 1): BotViewResponse {
    const tasks = this.taskManager.listRecentTasks(30);
    const { rows, currentPage, totalPages } = buildTaskListKeyboard({
      tasks,
      page,
    });

    if (tasks.length === 0) {
      return {
        text:
          `📊 *مراقبة المهام (Task Monitor)*\n\n` +
          `لا توجد مهام مسجلة بعد. عند إرسال رسائل أو الانضمام لمجموعات، ستظهر حالة كل مهمة هنا.`,
        keyboard: rows,
      };
    }

    return {
      text:
        `📊 *مراقبة المهام المتزامنة* (صفحة ${currentPage} من ${totalPages})\n` +
        `إجمالي المهام الأخيرة: *${tasks.length}*\n\n` +
        `اختر مهمة لعرض النتائج التفصيلية لكل جلسة:`,
      keyboard: rows,
    };
  }

  public renderTaskDetail(taskId: string): BotViewResponse {
    const task = this.taskManager.getTask(taskId);
    if (!task) {
      return {
        text: '⚠️ لم يتم العثور على المهمة المطلوبة.',
        keyboard: [[{ text: '🔙 رجوع لقائمة المهام', callbackData: 'menu:tasks:page:1' }]],
      };
    }

    const resultLines = task.results.map((r) => {
      const icon =
        r.status === 'SUCCESS'
          ? '✅'
          : r.status === 'RUNNING'
          ? '🔄'
          : r.status === 'CANCELLED'
          ? '🚫'
          : r.status === 'PENDING'
          ? '⏳'
          : '❌';
      return `${icon} \`${r.session_id}\`: ${
        r.result_summary || r.error_message || r.status
      }`;
    });

    return {
      text:
        `📊 *تفاصيل المهمة:* \`${task.id}\`\n\n` +
        `⚡ نوع العملية: ${formatOperationTypeArabic(task.operation_type)}\n` +
        `🎯 الهدف: \`${task.target_summary}\`\n` +
        `📌 الحالة: ${formatTaskStatusArabic(task.status)}\n` +
        `🕒 وقت الإنشاء: \`${task.created_at}\`\n` +
        `${task.completed_at ? `🏁 وقت الانتهاء: \`${task.completed_at}\`\n` : ''}` +
        `${task.error_summary ? `⚠️ الملخص: ${task.error_summary}\n` : ''}\n` +
        `*النتائج التفصيلية لكل جلسة:*\n${resultLines.join('\n')}`,
      keyboard: buildTaskDetailKeyboard(task),
    };
  }

  public handleCancelTask(taskId: string, adminId: number): BotViewResponse {
    try {
      const res = this.taskManager.cancelTask(taskId, adminId);
      return {
        text: `🛑 *طلب إلغاء المهمة (\`${taskId}\`):*\n${res.messageArabic}`,
        keyboard: [
          [
            { text: '📊 عرض المهمة', callbackData: `task:view:${taskId}` },
            { text: '🔙 قائمة المهام', callbackData: 'menu:tasks:page:1' },
          ],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 قائمة المهام', callbackData: 'menu:tasks:page:1' }]],
      };
    }
  }

  public renderAuditHistory(page = 1): BotViewResponse {
    const logs = this.auditRepo.listRecent(25);
    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(logs.length / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const slice = logs.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    const lines =
      slice.length > 0
        ? slice
            .map((entry) => {
              const badge =
                entry.outcome === 'SUCCESS'
                  ? '🟢'
                  : entry.outcome === 'DENIED'
                  ? '⛔'
                  : '🔴';
              return `${badge} \`${entry.action}\` | الهدف: \`${
                entry.target_id || '-'
              }\` | ${entry.created_at.slice(11, 19)}`;
            })
            .join('\n')
        : 'لا توجد سجلات نشاط بعد.';

    return {
      text:
        `📜 *سجل النشاط والتدقيق الأمني (Audit History)*\n` +
        `(صفحة ${currentPage} من ${totalPages} — خالٍ من محتوى الرسائل والأرقام الكاملة)\n\n` +
        `${lines}`,
      keyboard: [
        [
          ...(currentPage > 1
            ? [
                {
                  text: '⬅️ السابق',
                  callbackData: `menu:audit:page:${currentPage - 1}`,
                },
              ]
            : []),
          ...(currentPage < totalPages
            ? [
                {
                  text: 'التالي ➡️',
                  callbackData: `menu:audit:page:${currentPage + 1}`,
                },
              ]
            : []),
        ],
        [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
      ].filter((r) => r.length > 0),
    };
  }
}
