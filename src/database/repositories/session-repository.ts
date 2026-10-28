import { AppDatabase } from '../database';

export type SessionStatus =
  | 'INITIALIZING'
  | 'CONNECTING'
  | 'PAIRING_PENDING'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'LOGGED_OUT'
  | 'FAILED'
  | 'STOPPED';

export interface SessionRecord {
  id: string;
  label: string;
  masked_phone: string | null;
  jid: string | null;
  status: SessionStatus;
  auth_dir: string;
  reconnect_attempts: number;
  last_connected_at: string | null;
  last_status_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class SessionRepository {
  constructor(private readonly db: AppDatabase) {}

  public create(params: {
    id: string;
    label: string;
    maskedPhone?: string | null;
    jid?: string | null;
    status: SessionStatus;
    authDir: string;
  }): SessionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.sqlite.prepare(`
      INSERT INTO sessions (
        id, label, masked_phone, jid, status, auth_dir,
        reconnect_attempts, last_connected_at, last_status_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)
    `);

    const lastConnected =
      params.status === 'CONNECTED' || params.status === 'AUTHENTICATED' ? now : null;

    stmt.run(
      params.id,
      params.label,
      params.maskedPhone ?? null,
      params.jid ?? null,
      params.status,
      params.authDir,
      lastConnected,
      now,
      now,
      now
    );

    const created = this.findById(params.id);
    if (!created) {
      throw new Error(`Failed to load created session ${params.id}`);
    }
    return created;
  }

  public findById(id: string): SessionRecord | undefined {
    const stmt = this.db.sqlite.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id) as SessionRecord | undefined;
  }

  public listAll(): SessionRecord[] {
    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM sessions ORDER BY created_at ASC'
    );
    return stmt.all() as unknown as SessionRecord[];
  }

  public listConnected(): SessionRecord[] {
    const stmt = this.db.sqlite.prepare(`
      SELECT * FROM sessions
      WHERE status IN ('CONNECTED', 'AUTHENTICATED')
      ORDER BY created_at ASC
    `);
    return stmt.all() as unknown as SessionRecord[];
  }

  public listRestorable(): SessionRecord[] {
    const stmt = this.db.sqlite.prepare(`
      SELECT * FROM sessions
      WHERE status IN ('AUTHENTICATED', 'CONNECTED', 'DISCONNECTED', 'RECONNECTING')
      ORDER BY created_at ASC
    `);
    return stmt.all() as unknown as SessionRecord[];
  }

  public updateStatus(params: {
    id: string;
    status: SessionStatus;
    maskedPhone?: string | null;
    jid?: string | null;
    lastError?: string | null;
    reconnectAttempts?: number;
  }): SessionRecord | undefined {
    const existing = this.findById(params.id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const lastConnectedAt =
      params.status === 'CONNECTED' || params.status === 'AUTHENTICATED'
        ? now
        : existing.last_connected_at;

    const stmt = this.db.sqlite.prepare(`
      UPDATE sessions
      SET status = ?,
          masked_phone = COALESCE(?, masked_phone),
          jid = COALESCE(?, jid),
          last_error = ?,
          reconnect_attempts = ?,
          last_connected_at = ?,
          last_status_at = ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      params.status,
      params.maskedPhone ?? null,
      params.jid ?? null,
      params.lastError !== undefined ? params.lastError : existing.last_error,
      params.reconnectAttempts !== undefined
        ? params.reconnectAttempts
        : existing.reconnect_attempts,
      lastConnectedAt,
      now,
      now,
      params.id
    );

    return this.findById(params.id);
  }

  public updateLabel(id: string, label: string): SessionRecord | undefined {
    const clean = label.trim();
    if (!clean || clean.length > 64) {
      return undefined;
    }
    const now = new Date().toISOString();
    const stmt = this.db.sqlite.prepare(
      'UPDATE sessions SET label = ?, updated_at = ? WHERE id = ?'
    );
    stmt.run(clean, now, id);
    return this.findById(id);
  }

  public deleteById(id: string): boolean {
    const stmt = this.db.sqlite.prepare('DELETE FROM sessions WHERE id = ?');
    const result = stmt.run(id);
    return Number(result.changes) > 0;
  }
}
