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
import {
  MIGRATION_005_ID,
  MIGRATION_005_UP_SQL,
  MIGRATION_005_DOWN_SQL,
} from './migrations/005_multi_tenant_isolation';
import {
  MIGRATION_006_ID,
  MIGRATION_006_UP_SQL,
  MIGRATION_006_DOWN_SQL,
} from './migrations/006_inbox_statuses_and_native_calls';
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
      this.sqlite.exec('PRAGMA busy_timeout = 5000;');
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

    const existing005 = checkStmt.get(MIGRATION_005_ID) as { id: string } | undefined;
    if (!existing005) {
      this.runInTransaction(() => {
        this.ensureMultiTenantColumns();
        this.sqlite.exec(MIGRATION_005_UP_SQL);
        const insertStmt = this.sqlite.prepare(
          'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)'
        );
        insertStmt.run(MIGRATION_005_ID, new Date().toISOString());
      });
      log.info('Database migration applied', { migrationId: MIGRATION_005_ID });
    } else {
      this.ensureMultiTenantColumns();
    }

    const existing006 = checkStmt.get(MIGRATION_006_ID) as { id: string } | undefined;
    if (!existing006) {
      this.runInTransaction(() => {
        this.sqlite.exec(MIGRATION_006_UP_SQL);
        const insertStmt = this.sqlite.prepare(
          'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)'
        );
        insertStmt.run(MIGRATION_006_ID, new Date().toISOString());
      });
      log.info('Database migration applied', { migrationId: MIGRATION_006_ID });
    }

    this.ensureDeepArchivingColumns();
  }

  private ensureDeepArchivingColumns(): void {
    const inCols = this.sqlite
      .prepare('PRAGMA table_info(incoming_messages)')
      .all() as Array<{ name: string }>;
    const inColNames = new Set(inCols.map((c) => c.name));
    if (!inColNames.has('is_edited')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN is_edited INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!inColNames.has('original_text')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN original_text TEXT'
      );
    }
    if (!inColNames.has('raw_payload')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN raw_payload TEXT'
      );
    }
    if (!inColNames.has('sender_device_type')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN sender_device_type TEXT'
      );
    }
    if (!inColNames.has('sender_ip')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN sender_ip TEXT'
      );
    }
    if (!inColNames.has('sender_country')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN sender_country TEXT'
      );
    }
    if (!inColNames.has('sender_device_id')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN sender_device_id INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!inColNames.has('file_sha256')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN file_sha256 TEXT'
      );
    }
    if (!inColNames.has('forwarding_score')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN forwarding_score INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!inColNames.has('quoted_message_summary')) {
      this.sqlite.exec(
        'ALTER TABLE incoming_messages ADD COLUMN quoted_message_summary TEXT'
      );
    }

    const statCols = this.sqlite
      .prepare('PRAGMA table_info(captured_statuses)')
      .all() as Array<{ name: string }>;
    const statColNames = new Set(statCols.map((c) => c.name));
    if (!statColNames.has('raw_payload')) {
      this.sqlite.exec(
        'ALTER TABLE captured_statuses ADD COLUMN raw_payload TEXT'
      );
    }
    if (!statColNames.has('archive_format')) {
      this.sqlite.exec(
        "ALTER TABLE captured_statuses ADD COLUMN archive_format TEXT NOT NULL DEFAULT 'direct'"
      );
    }

    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS anonymous_relay_sessions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_telegram_id INTEGER NOT NULL DEFAULT 0,
        sender_jid TEXT NOT NULL,
        sender_lid_jid TEXT,
        receiver_jid TEXT NOT NULL,
        receiver_lid_jid TEXT,
        sender_alias TEXT NOT NULL DEFAULT 'Anonymous Sender',
        mask_phone_presentation INTEGER NOT NULL DEFAULT 1,
        prefer_lid_delivery INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        messages_relayed_count INTEGER NOT NULL DEFAULT 0,
        replies_relayed_count INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_anon_relay_sessions_session_state
        ON anonymous_relay_sessions(session_id, state);
      CREATE INDEX IF NOT EXISTS idx_anon_relay_sessions_sender
        ON anonymous_relay_sessions(session_id, sender_jid, state);
      CREATE INDEX IF NOT EXISTS idx_anon_relay_sessions_receiver
        ON anonymous_relay_sessions(session_id, receiver_jid, state);

      CREATE TABLE IF NOT EXISTS anonymous_relay_messages (
        relayed_wa_message_id TEXT PRIMARY KEY,
        anon_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        media_kind TEXT NOT NULL DEFAULT 'text',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_anon_relay_messages_anon_session
        ON anonymous_relay_messages(anon_session_id);
    `);
  }

  private ensureMultiTenantColumns(): void {
    const sessCols = this.sqlite
      .prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;
    const sessColNames = new Set(sessCols.map((c) => c.name));
    if (!sessColNames.has('owner_telegram_id')) {
      this.sqlite.exec(
        'ALTER TABLE sessions ADD COLUMN owner_telegram_id INTEGER NOT NULL DEFAULT 0'
      );
    }

    const taskCols = this.sqlite
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;
    const taskColNames = new Set(taskCols.map((c) => c.name));
    if (!taskColNames.has('owner_telegram_id')) {
      this.sqlite.exec(
        'ALTER TABLE tasks ADD COLUMN owner_telegram_id INTEGER NOT NULL DEFAULT 0'
      );
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
   * Safely rolls back a reversible migration (003, 004, 005, or 006)
   * without losing core session or settings rows.
   */
  public rollbackMigration(migrationId: string): boolean {
    if (
      migrationId !== MIGRATION_003_ID &&
      migrationId !== MIGRATION_004_ID &&
      migrationId !== MIGRATION_005_ID &&
      migrationId !== MIGRATION_006_ID
    ) {
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
      migrationId === MIGRATION_006_ID
        ? MIGRATION_006_DOWN_SQL
        : migrationId === MIGRATION_005_ID
          ? MIGRATION_005_DOWN_SQL
          : migrationId === MIGRATION_004_ID
            ? MIGRATION_004_DOWN_SQL
            : MIGRATION_003_DOWN_SQL;

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
