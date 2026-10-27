import crypto from 'node:crypto';
import {
  TaskRepository,
  TaskOperationType,
  TaskWithResults,
} from '../database/repositories/task-repository';
import { AuditRepository } from '../database/repositories/audit-repository';
import { TaskRunner, PerSessionExecutor } from './task-runner';
import { ValidationError } from '../utils/errors';

export class TaskManager {
  private readonly activeTaskFingerprints = new Set<string>();
  private lastSuccessfulOperationAt: string | null = null;

  constructor(
    private readonly taskRepo: TaskRepository,
    private readonly auditRepo: AuditRepository,
    private readonly taskRunner: TaskRunner
  ) {
    this.taskRepo.recoverInterruptedTasksOnStartup();
  }

  /**
   * Schedules and executes an operation across one or multiple selected sessions concurrently.
   * Prevents accidental duplicate concurrent execution of the exact same task.
   */
  public async runMultiSessionTask(params: {
    operationType: TaskOperationType;
    targetSummary: string;
    selectedSessionIds: string[];
    actorTelegramId: number;
    executor: PerSessionExecutor;
    dedupKey?: string;
    timeoutMs?: number;
    onCompleteCleanup?: () => void;
  }): Promise<TaskWithResults> {
    const uniqueSessionIds = Array.from(new Set(params.selectedSessionIds.filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      throw new ValidationError('الرجاء اختيار جلسة واتساب واحدة على الأقل لتنفيذ المهمة.');
    }

    const fingerprint =
      params.dedupKey ||
      `${params.operationType}:${params.targetSummary}:${uniqueSessionIds.sort().join(',')}`;

    if (this.activeTaskFingerprints.has(fingerprint)) {
      throw new ValidationError(
        'هذه المهمة قيد التنفيذ حالياً بالفعل على نفس الجلسات. تم منع التنفيذ المزدوج.'
      );
    }

    this.activeTaskFingerprints.add(fingerprint);
    const taskId = `tsk_${crypto.randomUUID().slice(0, 8)}`;

    try {
      this.taskRepo.createTaskWithPendingResults({
        id: taskId,
        operationType: params.operationType,
        targetSummary: params.targetSummary,
        selectedSessionIds: uniqueSessionIds,
      });

      this.auditRepo.record({
        actorTelegramId: params.actorTelegramId,
        action: `TASK_STARTED_${params.operationType}`,
        targetId: taskId,
        outcome: 'SUCCESS',
        metadata: {
          sessionCount: uniqueSessionIds.length,
          sessionIds: uniqueSessionIds,
        },
      });

      const completedTask = await this.taskRunner.executeTask({
        taskId,
        sessionIds: uniqueSessionIds,
        executor: params.executor,
        timeoutMs: params.timeoutMs,
        onCompleteCleanup: params.onCompleteCleanup,
      });

      if (
        completedTask.status === 'COMPLETED' ||
        completedTask.status === 'PARTIALLY_COMPLETED'
      ) {
        this.lastSuccessfulOperationAt = new Date().toISOString();
      }

      this.auditRepo.record({
        actorTelegramId: params.actorTelegramId,
        action: `TASK_FINISHED_${params.operationType}`,
        targetId: taskId,
        outcome: completedTask.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
        metadata: { finalStatus: completedTask.status },
      });

      return completedTask;
    } finally {
      this.activeTaskFingerprints.delete(fingerprint);
    }
  }

  /**
   * Requests cancellation of a pending or running task.
   * Note: Individual session operations that have already been dispatched to the WhatsApp socket
   * cannot be recalled mid-flight; queued sessions that have not started will be cancelled.
   */
  public cancelTask(taskId: string, actorTelegramId: number): {
    cancelled: boolean;
    messageArabic: string;
  } {
    const task = this.taskRepo.findByIdWithResults(taskId);
    if (!task) {
      throw new ValidationError('المهمة المطلوبة غير موجودة.');
    }

    if (task.status !== 'PENDING' && task.status !== 'RUNNING') {
      return {
        cancelled: false,
        messageArabic: `لا يمكن إلغاء المهمة لأنها انتهت بالفعل بالحالة: ${task.status}.`,
      };
    }

    this.taskRunner.requestCancel(taskId);
    this.auditRepo.record({
      actorTelegramId,
      action: 'TASK_CANCEL_REQUESTED',
      targetId: taskId,
      outcome: 'SUCCESS',
    });

    return {
      cancelled: true,
      messageArabic:
        'تم إرسال طلب الإلغاء. سيتم إيقاف الجلسات المنتظرة في الطابور، بينما العمليات التي أُرسلت للشبكة بالفعل لا يمكن التراجع عنها.',
    };
  }

  public getTask(taskId: string): TaskWithResults | undefined {
    return this.taskRepo.findByIdWithResults(taskId);
  }

  public listRecentTasks(limit = 20): TaskWithResults[] {
    return this.taskRepo.listRecent(limit);
  }

  public getLastSuccessfulOperationAt(): string | null {
    return this.lastSuccessfulOperationAt;
  }

  public getRunnerStats() {
    return this.taskRunner.getConcurrencyStats();
  }
}
