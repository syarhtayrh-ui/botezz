import crypto from 'node:crypto';
import fs from 'node:fs';
import { AppDatabase } from '../database';

export type CapturedStatusMediaKind =
  | 'IMAGE'
  | 'VIDEO'
  | 'AUDIO'
  | 'TEXT'
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | string;
export type StatusFilterKind = 'ALL' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT';

export interface CapturedStatusRecord {
  id: string;
  session_id: string;
  owner_telegram_id: number;
  wa_status_id: string;
  status_message_id: string;
  author_jid: string;
  sender_jid: string;
  author_phone: string;
  sender_phone: string;
  push_name: string | null;
  sender_name: string | null;
  media_kind: string;
  caption: string | null;
  saved_file_path: string;
  file_path: string;
  saved_file_name: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  size_bytes: number;
  forwarded_to_telegram: number;
  captured_at: string;
}

export interface CreateCapturedStatusInput {
  id?: string;
  sessionId: string;
  ownerTelegramId?: number;
  waStatusId?: string;
  statusMessageId?: string;
  authorJid?: string;
  senderJid?: string;
  authorPhone?: string;
  senderPhone?: string;
  pushName?: string | null;
  senderName?: string | null;
  mediaKind: CapturedStatusMediaKind;
  caption?: string | null;
  savedFilePath?: string;
  filePath?: string;
  savedFileName?: string;
  fileName?: string;
  mimeType: string;
  fileSizeBytes?: number;
  fileSize?: number;
  forwardedToTelegram?: boolean;
  capturedAt?: string;
}

export interface StatusStats {
  total: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  textCount: number;
}

export class StatusRepository {
  constructor(private readonly db: AppDatabase) {}

  private hydrateRow(raw: Record<string, unknown>): CapturedStatusRecord {
    const waStatusId = String(raw.wa_status_id || '');
    const authorJid = String(raw.author_jid || '');
    const authorPhone = String(raw.author_phone || '');
    const pushName = (raw.push_name as string | null) ?? null;
    const savedFilePath = String(raw.saved_file_path || '');
    const savedFileName = String(raw.saved_file_name || '');
    const fileSizeBytes = Number(raw.file_size_bytes ?? 0);
    const mediaKind = String(raw.media_kind || 'text').toLowerCase();

    return {
      id: String(raw.id),
      session_id: String(raw.session_id),
      owner_telegram_id: Number(raw.owner_telegram_id ?? 0),
      wa_status_id: waStatusId,
      status_message_id: waStatusId,
      author_jid: authorJid,
      sender_jid: authorJid,
      author_phone: authorPhone,
      sender_phone: authorPhone,
      push_name: pushName,
      sender_name: pushName || authorPhone,
      media_kind: mediaKind,
      caption: (raw.caption as string | null) ?? null,
      saved_file_path: savedFilePath,
      file_path: savedFilePath,
      saved_file_name: savedFileName,
      file_name: savedFileName,
      mime_type: String(raw.mime_type || 'application/octet-stream'),
      file_size_bytes: fileSizeBytes,
      size_bytes: fileSizeBytes,
      forwarded_to_telegram: Number(raw.forwarded_to_telegram ?? 0),
      captured_at: String(raw.captured_at || ''),
    };
  }

  public recordStatus(input: CreateCapturedStatusInput): CapturedStatusRecord {
    const id = input.id || `sts_${crypto.randomBytes(5).toString('hex')}`;
    const capturedAt = input.capturedAt || new Date().toISOString();
    const waStatusId = input.waStatusId || input.statusMessageId || id;
    const authorJid = input.authorJid || input.senderJid || '';
    const authorPhone = input.authorPhone || input.senderPhone || '';
    const pushName = input.pushName ?? input.senderName ?? null;
    const mediaKind = String(input.mediaKind || 'text').toLowerCase();
    const savedFilePath = input.savedFilePath || input.filePath || '';
    const savedFileName = input.savedFileName || input.fileName || 'status.png';
    const fileSizeBytes = input.fileSizeBytes ?? input.fileSize ?? 0;

    this.db.sqlite
      .prepare(
        `
        INSERT INTO captured_statuses (
          id, session_id, owner_telegram_id, wa_status_id,
          author_jid, author_phone, push_name, media_kind,
          caption, saved_file_path, saved_file_name, mime_type,
          file_size_bytes, forwarded_to_telegram, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.sessionId,
        input.ownerTelegramId ?? 0,
        waStatusId,
        authorJid,
        authorPhone,
        pushName,
        mediaKind,
        input.caption ?? null,
        savedFilePath,
        savedFileName,
        input.mimeType,
        fileSizeBytes,
        input.forwardedToTelegram ? 1 : 0,
        capturedAt
      );

    return this.findById(id)!;
  }

  public insert(input: CreateCapturedStatusInput): CapturedStatusRecord {
    return this.recordStatus(input);
  }

  public findById(
    id: string,
    actorTelegramId?: number,
    isOwner = true
  ): CapturedStatusRecord | undefined {
    const row = this.db.sqlite
      .prepare('SELECT * FROM captured_statuses WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const hydrated = this.hydrateRow(row);
    if (
      !isOwner &&
      actorTelegramId !== undefined &&
      actorTelegramId > 0 &&
      hydrated.owner_telegram_id !== actorTelegramId
    ) {
      return undefined;
    }
    return hydrated;
  }

  public listForOwner(
    actorTelegramId: number,
    isOwner = true,
    filterKind?: string,
    limit = 100
  ): CapturedStatusRecord[] {
    const clauses: string[] = [];
    const bindValues: Array<string | number> = [];

    if (!isOwner && actorTelegramId > 0) {
      clauses.push('owner_telegram_id = ?');
      bindValues.push(actorTelegramId);
    }

    if (filterKind && filterKind.toUpperCase() !== 'ALL') {
      clauses.push('LOWER(media_kind) = ?');
      bindValues.push(filterKind.toLowerCase());
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM captured_statuses ${whereSql} ORDER BY captured_at DESC, rowid DESC LIMIT ?`
      )
      .all(...bindValues, Math.max(1, limit)) as Array<Record<string, unknown>>;

    return rows.map((r) => this.hydrateRow(r));
  }

  public markForwarded(id: string): void {
    this.db.sqlite
      .prepare('UPDATE captured_statuses SET forwarded_to_telegram = 1 WHERE id = ?')
      .run(id);
  }

  public listByAuthorPhone(
    authorPhone: string,
    actorTelegramId?: number,
    isOwner = true
  ): CapturedStatusRecord[] {
    const cleanDigits = authorPhone.replace(/\D/g, '');
    const withPlus = `+${cleanDigits}`;
    const rawRows =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? (this.db.sqlite
            .prepare(
              'SELECT * FROM captured_statuses WHERE (author_phone = ? OR author_phone = ?) AND owner_telegram_id = ? ORDER BY captured_at DESC, rowid DESC'
            )
            .all(cleanDigits, withPlus, actorTelegramId) as Array<
            Record<string, unknown>
          >)
        : (this.db.sqlite
            .prepare(
              'SELECT * FROM captured_statuses WHERE (author_phone = ? OR author_phone = ?) ORDER BY captured_at DESC, rowid DESC'
            )
            .all(cleanDigits, withPlus) as Array<Record<string, unknown>>);
    return rawRows.map((r) => this.hydrateRow(r));
  }

  public listBySenderPhone(
    senderPhone: string,
    actorTelegramId?: number,
    isOwner = true
  ): CapturedStatusRecord[] {
    return this.listByAuthorPhone(senderPhone, actorTelegramId, isOwner);
  }

  public listPaginated(params: {
    page: number;
    pageSize?: number;
    filterKind?: StatusFilterKind;
    authorPhone?: string;
    actorTelegramId?: number;
    isOwner?: boolean;
  }): {
    items: CapturedStatusRecord[];
    total: number;
    page: number;
    totalPages: number;
  } {
    const pageSize = Math.max(1, params.pageSize ?? 6);
    const clauses: string[] = [];
    const bindValues: Array<string | number> = [];

    if (
      !params.isOwner &&
      params.actorTelegramId !== undefined &&
      params.actorTelegramId > 0
    ) {
      clauses.push('owner_telegram_id = ?');
      bindValues.push(params.actorTelegramId);
    }

    if (params.authorPhone) {
      const cleanDigits = params.authorPhone.replace(/\D/g, '');
      clauses.push('(author_phone = ? OR author_phone = ?)');
      bindValues.push(cleanDigits, `+${cleanDigits}`);
    }

    const filter = params.filterKind || 'ALL';
    if (filter !== 'ALL') {
      clauses.push('LOWER(media_kind) = ?');
      bindValues.push(filter.toLowerCase());
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = this.db.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM captured_statuses ${whereSql}`)
      .get(...bindValues) as { cnt: number };
    const total = Number(countRow?.cnt ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(params.page || 1, totalPages));
    const offset = (safePage - 1) * pageSize;

    const rawRows = this.db.sqlite
      .prepare(
        `SELECT * FROM captured_statuses ${whereSql} ORDER BY captured_at DESC, rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...bindValues, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      items: rawRows.map((r) => this.hydrateRow(r)),
      total,
      page: safePage,
      totalPages,
    };
  }

  public getStats(actorTelegramId?: number, isOwner = true): StatusStats {
    const whereOwner =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? 'WHERE owner_telegram_id = ?'
        : '';
    const args =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? [actorTelegramId]
        : [];

    const rows = this.db.sqlite
      .prepare(
        `SELECT media_kind, COUNT(*) AS cnt FROM captured_statuses ${whereOwner} GROUP BY media_kind`
      )
      .all(...args) as Array<{ media_kind: string; cnt: number }>;

    let total = 0;
    let imageCount = 0;
    let videoCount = 0;
    let audioCount = 0;
    let textCount = 0;

    for (const r of rows) {
      const cnt = Number(r.cnt || 0);
      const k = String(r.media_kind || '').toLowerCase();
      total += cnt;
      if (k === 'image') imageCount += cnt;
      else if (k === 'video') videoCount += cnt;
      else if (k === 'audio') audioCount += cnt;
      else textCount += cnt;
    }

    return { total, imageCount, videoCount, audioCount, textCount };
  }

  public clearAll(actorTelegramId?: number, isOwner = true): number {
    const records =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? (this.db.sqlite
            .prepare(
              'SELECT saved_file_path FROM captured_statuses WHERE owner_telegram_id = ?'
            )
            .all(actorTelegramId) as Array<{ saved_file_path: string }>)
        : (this.db.sqlite
            .prepare('SELECT saved_file_path FROM captured_statuses')
            .all() as Array<{ saved_file_path: string }>);

    for (const r of records) {
      try {
        if (r.saved_file_path && fs.existsSync(r.saved_file_path)) {
          fs.unlinkSync(r.saved_file_path);
        }
      } catch {
        // Ignore cleanup error
      }
    }

    const res =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? this.db.sqlite
            .prepare('DELETE FROM captured_statuses WHERE owner_telegram_id = ?')
            .run(actorTelegramId)
        : this.db.sqlite.prepare('DELETE FROM captured_statuses').run();

    return Number(res.changes ?? 0);
  }
}
