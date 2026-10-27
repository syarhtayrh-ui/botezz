import crypto from 'node:crypto';
import { AppDatabase } from '../database';
import { redactObject } from '../../security/redaction';

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';

export interface AuditLogRecord {
  id: string;
  actor_telegram_id: number;
  action: string;
  target_id: string | null;
  outcome: AuditOutcome;
  metadata_json: string | null;
  created_at: string;
}

export class AuditRepository {
  constructor(private readonly db: AppDatabase) {}

  /**
   * Records an administrative or security audit event.
   * Automatically redacts any sensitive keys or phone numbers from metadata.
   */
  public record(params: {
    actorTelegramId: number;
    action: string;
    targetId?: string | null;
    outcome: AuditOutcome;
    metadata?: Record<string, unknown>;
  }): AuditLogRecord {
    const id = `aud_${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const safeMetadata = params.metadata
      ? JSON.stringify(redactObject(params.metadata))
      : null;

    this.db.sqlite
      .prepare(`
        INSERT INTO audit_logs (
          id, actor_telegram_id, action, target_id, outcome, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        params.actorTelegramId,
        params.action,
        params.targetId ?? null,
        params.outcome,
        safeMetadata,
        now
      );

    return {
      id,
      actor_telegram_id: params.actorTelegramId,
      action: params.action,
      target_id: params.targetId ?? null,
      outcome: params.outcome,
      metadata_json: safeMetadata,
      created_at: now,
    };
  }

  public listRecent(limit = 30): AuditLogRecord[] {
    return this.db.sqlite
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as AuditLogRecord[];
  }
}
