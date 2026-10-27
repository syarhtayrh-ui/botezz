import { ConcurrencyLimiter, withOperationTimeout } from './concurrency';
import {
  TaskRepository,
  TaskStatus,
  TaskWithResults,
} from '../database/repositories/task-repository';
import { toSafeArabicError } from '../utils/errors';

export type PerSessionExecutor = (sessionId: string) => Promise<string>;

export class TaskRunner {
  private readonly limiter: ConcurrencyLimiter;
  private readonly cancelledTasks = new Set<string>();

  constructor(
    private readonly taskRepo: TaskRepository,
    maxConcurrentTasks = 3,
    private readonly defaultTimeoutMs = 120000
  ) {
    this.limiter = new ConcurrencyLimiter(maxConcurrentTasks);
  }

  public getConcurrencyStats(): { active: number; queued: number; max: number } {
    return {
      active: this.limiter.getActiveCount(),
      queued: this.limiter.getPendingCount(),
      max: this.limiter.maxConcurrent,
    };
  }

  public requestCancel(taskId: string): void {
    this.cancelledTasks.add(taskId);
  }

  public isCancelled(taskId: string): boolean {
    return this.cancelledTasks.has(taskId);
  }

  /**
   * Executes independent per-session operations concurrently up to the configured concurrency limit.
   * Isolates individual session failures and records accurate per-session outcomes.
   */
  public async executeTask(params: {
    taskId: string;
    sessionIds: string[];
    executor: PerSessionExecutor;
    timeoutMs?: number;
    onCompleteCleanup?: () => void;
  }): Promise<TaskWithResults> {
    const {
      taskId,
      sessionIds,
      executor,
      timeoutMs = this.defaultTimeoutMs,
      onCompleteCleanup,
    } = params;

    this.taskRepo.markTaskRunning(taskId);

    try {
      const sessionPromises = sessionIds.map((sessionId) =>
        this.limiter.run(async () => {
          if (this.cancelledTasks.has(taskId)) {
            this.taskRepo.updateSessionResult({
              taskId,
              sessionId,
              status: 'CANCELLED',
              errorMessage: 'تم إلغاء المهمة قبل بدء التنفيذ على هذه الجلسة.',
            });
            return { sessionId, status: 'CANCELLED' as const };
          }

          this.taskRepo.updateSessionResult({
            taskId,
            sessionId,
            status: 'RUNNING',
          });

          try {
            const summary = await withOperationTimeout(
              executor(sessionId),
              timeoutMs
            );
            this.taskRepo.updateSessionResult({
              taskId,
              sessionId,
              status: 'SUCCESS',
              resultSummary: summary,
            });
            return { sessionId, status: 'SUCCESS' as const };
          } catch (err) {
            const safeErr = toSafeArabicError(err);
            this.taskRepo.updateSessionResult({
              taskId,
              sessionId,
              status: 'FAILED',
              errorMessage: safeErr.userMessage,
            });
            return {
              sessionId,
              status: 'FAILED' as const,
              error: safeErr.userMessage,
            };
          }
        })
      );

      const outcomes = await Promise.all(sessionPromises);

      const successCount = outcomes.filter((o) => o.status === 'SUCCESS').length;
      const cancelCount = outcomes.filter((o) => o.status === 'CANCELLED').length;
      const failCount = outcomes.filter((o) => o.status === 'FAILED').length;

      let finalStatus: TaskStatus;
      let errorSummary: string | null = null;

      if (cancelCount === outcomes.length || (this.cancelledTasks.has(taskId) && successCount === 0)) {
        finalStatus = 'CANCELLED';
        errorSummary = 'تم إلغاء المهمة بناءً على طلب المسؤول.';
      } else if (successCount === outcomes.length) {
        finalStatus = 'COMPLETED';
      } else if (successCount > 0 && (failCount > 0 || cancelCount > 0)) {
        finalStatus = 'PARTIALLY_COMPLETED';
        errorSummary = `نجحت ${successCount} من أصل ${outcomes.length} جلسات، وفشلت ${failCount}.`;
      } else {
        finalStatus = 'FAILED';
        errorSummary = `فشلت العملية في جميع الجلسات المحددة (${failCount}).`;
      }

      const finalized = this.taskRepo.finalizeTask({
        taskId,
        status: finalStatus,
        errorSummary,
      });

      return finalized!;
    } finally {
      this.cancelledTasks.delete(taskId);
      if (onCompleteCleanup) {
        onCompleteCleanup();
      }
    }
  }
}
