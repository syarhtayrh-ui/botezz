import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_MIGRATION_ID, INITIAL_MIGRATION_SQL } from './migrations/001_initial';
import { MIGRATION_002_ID, MIGRATION_002_SQL } from './migrations/002_session_lifecycle';
import {
  MIGRATION_003_ID,
  MIGRATION_003_UP_SQL,
  MIGRATION_003_DOWN_SQL,
} from './migrations/003_function_lab_and_message_capabilities';
import {
  MIGRATION_004_ID,
  MIGRATION_004_UP_SQL,
  MIGRATION_004_DOWN_SQL,
} from './migrations/004_session_lifecycle_hardening';
import { DatabaseError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('database');

export class AppDatabase {
  public readonly sqlite: DatabaseSync;
  public readonly dbPath: string;
  private closed = false;

  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }

    try {
      this.sqlite = new DatabaseSync(dbPath);
      this.sqlite.exec('PRAGMA foreign_keys = ON;');
      if (dbPath !== ':memory:') {
        this.sqlite.exec('PRAGMA journal_mode = WAL;');
      }
      this.runMigrations();
    } catch (err) {
      throw new DatabaseError(
        'تعذر تهيئة قاعدة البيانات المحلية SQLite.',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  public runMigrations(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const checkStmt = this.sqlite.prepare(
      'SELECT id FROM schema_migrations WHERE id = ?'
    );
    const existing = checkStmt.get(INITIAL_MIGRATION_ID) as { id: string } | undefined;

    if (!existing) {
      this.runInTransaction(() => {
        this.sqlite.exec(INITIAL_MIGRATION_SQL);
        const insertStmt = this.sqlite.prepare(
          'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)'
        );
        insertStmt.run(INITIAL_MIGRATION_ID, new Date().toISOString());
      });
      log.info('Database migration applied', { migrationId: INITIAL_MIGRATION_ID });
    }

    const existing002 = checkStmt.get(MIGRATION_002_ID) as { id: string } | undefined;
    if (!existing002) {
      this.sqlite.exec('PRAGMA foreign_keys = OFF;');
      try {
        this.runInTransaction(() => {
          this.sqlite.exec(MIGRATION_002_SQL);
          const insertStmt = this.sqlite.prepare(
            'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)'
          );
          insertStmt.run(MIGRATION_002_ID, new Date().toISOString());
        });
        log.info('Database migration applied', { migrationId: MIGRATION_002_ID });
      } finally {
        this.sqlite.exec('PRAGMA foreign_keys = ON;');
      }
    }

    const existing003 = checkStmt.get(MIGRATION_003_ID) as { id: string } | undefined;
    if (!existing003) {
      this.runInTransaction(() => {
        this.sqlite.exec(MIGRATION_003_UP_SQL);
        const insertStmt = this.sqlite.prepare(
          'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)'
        );
        insertStmt.run(MIGRATION_003_ID, new Date().toISOString());
      });
      log.info('Database migration applied', { migrationId: MIGRATION_003_ID });
    }

    const existing004 = checkStmt.get(MIGRATION_004_ID) as { id: string } | undefined;
    if (!existing004) {
      this.sqlite.exec('PRAGMA foreign_keys = OFF;');
      try {
        this.runInTransaction(() => {
          this.sqlite.exec(MIGRATION_004_UP_SQL);
          const insertStmt = this.sqlite.prepare(
            'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)'
          );
          insertStmt.run(MIGRATION_004_ID, new Date().toISOString());
        });
        log.info('Database migration applied', { migrationId: MIGRATION_004_ID });
      } finally {
        this.sqlite.exec('PRAGMA foreign_keys = ON;');
      }
    }
  }

  public hasMigration(migrationId: string): boolean {
    const checkStmt = this.sqlite.prepare(
      'SELECT id FROM schema_migrations WHERE id = ?'
    );
    const existing = checkStmt.get(migrationId) as { id: string } | undefined;
    return Boolean(existing);
  }

  /**
   * Safely rolls back a reversible migration (003 or 004)
   * without losing core session or settings rows.
   */
  public rollbackMigration(migrationId: string): boolean {
    if (migrationId !== MIGRATION_003_ID && migrationId !== MIGRATION_004_ID) {
      throw new DatabaseError(
        `الترحيل (${migrationId}) غير قابل للتراجع التلقائي حفاظاً على الجلسات الأساسية.`
      );
    }
    const checkStmt = this.sqlite.prepare(
      'SELECT id FROM schema_migrations WHERE id = ?'
    );
    const existing = checkStmt.get(migrationId) as { id: string } | undefined;
    if (!existing) return false;

    const downSql =
      migrationId === MIGRATION_004_ID ? MIGRATION_004_DOWN_SQL : MIGRATION_003_DOWN_SQL;

    this.sqlite.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.runInTransaction(() => {
        this.sqlite.exec(downSql);
        const delStmt = this.sqlite.prepare(
          'DELETE FROM schema_migrations WHERE id = ?'
        );
        delStmt.run(migrationId);
      });
    } finally {
      this.sqlite.exec('PRAGMA foreign_keys = ON;');
    }
    log.info('Database migration rolled back', { migrationId });
    return true;
  }

  /**
   * Executes multiple synchronous database operations atomically inside a SQLite transaction.
   * Rolls back automatically if any error is thrown.
   */
  public runInTransaction<T>(fn: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const result = fn();
      this.sqlite.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.sqlite.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error if transaction already aborted
      }
      throw err;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sqlite.close();
      log.info('Database connection closed');
    } catch (err) {
      log.error('Error closing database', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
