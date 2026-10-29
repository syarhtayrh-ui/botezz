import { AppDatabase } from '../database';

export type SessionStatus =
  | 'CREATED'
  | 'INITIALIZING'
  | 'CONNECTING'
  | 'WAITING_FOR_PAIRING'
  | 'PAIRING_PENDING'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'CONNECTED'
  | 'RECOVERING'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'LOGGED_OUT'
  | 'REQUIRES_REPAIR'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED';

export type SessionHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'STALE' | 'UNKNOWN';

export interface SessionRecord {
  id: string;
  label: string;
  masked_phone: string | null;
  jid: string | null;
  status: SessionStatus;
  auth_dir: string;
  owner_telegram_id?: number;
  reconnect_attempts: number;
  last_connected_at: string | null;
  last_status_at: string;
  last_error: string | null;
  last_disconnect_code?: number | null;
  last_disconnect_reason?: string | null;
  health_status?: SessionHealthStatus;
  last_activity_at?: string | null;
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
    ownerTelegramId?: number;
  }): SessionRecord {
    const now = new Date().toISOString();
    const stmt = this.db.sqlite.prepare(`
      INSERT INTO sessions (
        id, label, masked_phone, jid, status, auth_dir, owner_telegram_id,
        reconnect_attempts, last_connected_at, last_status_at, last_error,
        last_disconnect_code, last_disconnect_reason, health_status, last_activity_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
    `);

    const isConnected =
      params.status === 'CONNECTED' || params.status === 'AUTHENTICATED';
    const lastConnected = isConnected ? now : null;
    const initialHealth: SessionHealthStatus = isConnected ? 'HEALTHY' : 'UNKNOWN';

    stmt.run(
      params.id,
      params.label,
      params.maskedPhone ?? null,
      params.jid ?? null,
      params.status,
      params.authDir,
      params.ownerTelegramId ?? 0,
      lastConnected,
      now,
      initialHealth,
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

  public listAll(ownerTelegramId?: number): SessionRecord[] {
    if (ownerTelegramId !== undefined && ownerTelegramId > 0) {
      const stmt = this.db.sqlite.prepare(
        'SELECT * FROM sessions WHERE owner_telegram_id = ? ORDER BY created_at ASC'
      );
      return stmt.all(ownerTelegramId) as unknown as SessionRecord[];
    }
    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM sessions ORDER BY created_at ASC'
    );
    return stmt.all() as unknown as SessionRecord[];
  }

  public listConnected(ownerTelegramId?: number): SessionRecord[] {
    if (ownerTelegramId !== undefined && ownerTelegramId > 0) {
      const stmt = this.db.sqlite.prepare(`
        SELECT * FROM sessions
        WHERE status IN ('CONNECTED', 'AUTHENTICATED') AND owner_telegram_id = ?
        ORDER BY created_at ASC
      `);
      return stmt.all(ownerTelegramId) as unknown as SessionRecord[];
    }
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
      WHERE status IN ('AUTHENTICATED', 'CONNECTED', 'DISCONNECTED', 'RECONNECTING', 'RECOVERING')
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
    lastDisconnectCode?: number | null;
    lastDisconnectReason?: string | null;
    healthStatus?: SessionHealthStatus;
    lastActivityAt?: string | null;
    touchActivity?: boolean;
  }): SessionRecord | undefined {
    const existing = this.findById(params.id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const isConnected =
      params.status === 'CONNECTED' || params.status === 'AUTHENTICATED';
    const lastConnectedAt = isConnected ? now : existing.last_connected_at;
    const lastActivityAt =
      params.lastActivityAt !== undefined
        ? params.lastActivityAt
        : isConnected || params.touchActivity
          ? now
          : existing.last_activity_at ?? existing.updated_at;

    const computedHealth: SessionHealthStatus =
      params.healthStatus ??
      (isConnected
        ? 'HEALTHY'
        : params.status === 'RECOVERING' ||
            params.status === 'RECONNECTING' ||
            params.status === 'CONNECTING' ||
            params.status === 'AUTHENTICATING'
          ? 'DEGRADED'
          : 'UNHEALTHY');

    const stmt = this.db.sqlite.prepare(`
      UPDATE sessions
      SET status = ?,
          masked_phone = COALESCE(?, masked_phone),
          jid = COALESCE(?, jid),
          last_error = ?,
          reconnect_attempts = ?,
          last_connected_at = ?,
          last_status_at = ?,
          last_disconnect_code = ?,
          last_disconnect_reason = ?,
          health_status = ?,
          last_activity_at = ?,
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
      params.lastDisconnectCode !== undefined
        ? params.lastDisconnectCode
        : (existing.last_disconnect_code ?? null),
      params.lastDisconnectReason !== undefined
        ? params.lastDisconnectReason
        : (existing.last_disconnect_reason ?? null),
      computedHealth,
      lastActivityAt,
      now,
      params.id
    );

    return this.findById(params.id);
  }

  public recordActivity(id: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.sqlite.prepare(`
      UPDATE sessions
      SET last_activity_at = ?, health_status = 'HEALTHY', updated_at = ?
      WHERE id = ? AND status IN ('CONNECTED', 'AUTHENTICATED')
    `);
    stmt.run(now, now, id);
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
