import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_MIGRATION_ID, INITIAL_MIGRATION_SQL } from './migrations/001_initial';
import { MIGRATION_002_ID, MIGRATION_002_SQL } from './migrations/002_session_lifecycle';
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
