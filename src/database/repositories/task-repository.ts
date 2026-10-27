import crypto from 'node:crypto';
import { AppDatabase } from '../database';

export type TaskOperationType =
  | 'SEND_TEXT'
  | 'SEND_MEDIA'
  | 'JOIN_GROUP'
  | 'GROUP_ACTION';

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type PerSessionResultStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface TaskRecord {
  id: string;
  operation_type: TaskOperationType;
  target_summary: string;
  selected_session_ids_json: string;
  status: TaskStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  error_summary: string | null;
}

export interface TaskResultRecord {
  id: string;
  task_id: string;
  session_id: string;
  status: PerSessionResultStatus;
  result_summary: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskWithResults extends TaskRecord {
  selectedSessionIds: string[];
  results: TaskResultRecord[];
}

export class TaskRepository {
  constructor(private readonly db: AppDatabase) {}

  public createTaskWithPendingResults(params: {
    id: string;
    operationType: TaskOperationType;
    targetSummary: string;
    selectedSessionIds: string[];
  }): TaskWithResults {
    const now = new Date().toISOString();

    this.db.runInTransaction(() => {
      const insertTask = this.db.sqlite.prepare(`
        INSERT INTO tasks (
          id, operation_type, target_summary, selected_session_ids_json,
          status, created_at, started_at, completed_at, cancelled_at, error_summary
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, NULL, NULL, NULL, NULL)
      `);

      insertTask.run(
        params.id,
        params.operationType,
        params.targetSummary,
        JSON.stringify(params.selectedSessionIds),
        now
      );

      const insertResult = this.db.sqlite.prepare(`
        INSERT INTO task_results (
          id, task_id, session_id, status, result_summary, error_message, started_at, completed_at
        ) VALUES (?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL)
      `);

      for (const sessionId of params.selectedSessionIds) {
        insertResult.run(`tr_${crypto.randomUUID().slice(0, 8)}`, params.id, sessionId);
      }
    });

    const created = this.findByIdWithResults(params.id);
    if (!created) {
      throw new Error(`Failed to retrieve created task ${params.id}`);
    }
    return created;
  }

  public markTaskRunning(taskId: string): void {
    const now = new Date().toISOString();
    this.db.sqlite
      .prepare(`UPDATE tasks SET status = 'RUNNING', started_at = ? WHERE id = ?`)
      .run(now, taskId);
  }

  public updateSessionResult(params: {
    taskId: string;
    sessionId: string;
    status: PerSessionResultStatus;
    resultSummary?: string | null;
    errorMessage?: string | null;
  }): void {
    const now = new Date().toISOString();
    if (params.status === 'RUNNING') {
      this.db.sqlite
        .prepare(`
          UPDATE task_results
          SET status = 'RUNNING', started_at = ?
          WHERE task_id = ? AND session_id = ?
        `)
        .run(now, params.taskId, params.sessionId);
      return;
    }

    this.db.sqlite
      .prepare(`
        UPDATE task_results
        SET status = ?,
            result_summary = ?,
            error_message = ?,
            completed_at = ?
        WHERE task_id = ? AND session_id = ?
      `)
      .run(
        params.status,
        params.resultSummary ?? null,
        params.errorMessage ?? null,
        now,
        params.taskId,
        params.sessionId
      );
  }

  public finalizeTask(params: {
    taskId: string;
    status: TaskStatus;
    errorSummary?: string | null;
  }): TaskWithResults | undefined {
    const now = new Date().toISOString();
    const cancelledAt = params.status === 'CANCELLED' ? now : null;
    this.db.sqlite
      .prepare(`
        UPDATE tasks
        SET status = ?,
            completed_at = ?,
            cancelled_at = COALESCE(?, cancelled_at),
            error_summary = ?
        WHERE id = ?
      `)
      .run(params.status, now, cancelledAt, params.errorSummary ?? null, params.taskId);

    return this.findByIdWithResults(params.taskId);
  }

  public findByIdWithResults(taskId: string): TaskWithResults | undefined {
    const task = this.db.sqlite
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(taskId) as TaskRecord | undefined;
    if (!task) return undefined;

    const results = this.db.sqlite
      .prepare('SELECT * FROM task_results WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as unknown as TaskResultRecord[];

    let selectedSessionIds: string[] = [];
    try {
      selectedSessionIds = JSON.parse(task.selected_session_ids_json);
    } catch {
      selectedSessionIds = [];
    }

    return {
      ...task,
      selectedSessionIds,
      results,
    };
  }

  public listRecent(limit = 20): TaskWithResults[] {
    const tasks = this.db.sqlite
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as TaskRecord[];

    return tasks
      .map((t) => this.findByIdWithResults(t.id))
      .filter((t): t is TaskWithResults => Boolean(t));
  }

  /**
   * Recovers any tasks left in RUNNING state due to an unexpected process crash on previous run.
   */
  public recoverInterruptedTasksOnStartup(): number {
    const now = new Date().toISOString();
    return this.db.runInTransaction(() => {
      this.db.sqlite
        .prepare(`
          UPDATE task_results
          SET status = 'UNKNOWN',
              error_message = 'توقفت العملية بسبب إعادة تشغيل الخادم قبل تأكيد النتيجة النهائية.',
              completed_at = ?
          WHERE status IN ('PENDING', 'RUNNING')
            AND task_id IN (SELECT id FROM tasks WHERE status = 'RUNNING')
        `)
        .run(now);

      const res = this.db.sqlite
        .prepare(`
          UPDATE tasks
          SET status = 'FAILED',
              completed_at = ?,
              error_summary = 'تم إيقاف المهمة بسبب إعادة تشغيل التطبيق أثناء التنفيذ.'
          WHERE status = 'RUNNING'
        `)
        .run(now);

      return Number(res.changes);
    });
  }
}
