import crypto from 'node:crypto';
import fs from 'node:fs';
import { AppDatabase } from '../database';

export type IncomingMessageArchiveKind =
  | 'TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'AUDIO'
  | 'VOICE_PTT'
  | 'STICKER'
  | 'STICKER_PACK'
  | 'DOCUMENT'
  | 'LOCATION'
  | 'CONTACT'
  | 'POLL'
  | 'INTERACTIVE'
  | 'REACTION'
  | 'PROTOCOL'
  | string;

export type InboxFilterKind = 'ALL' | 'MEDIA' | 'STICKERS' | 'TEXT';

export interface IncomingMessageRecord {
  id: string;
  session_id: string;
  owner_telegram_id: number;
  wa_message_id: string;
  message_id: string;
  remote_jid: string;
  sender_jid: string;
  sender_phone: string;
  push_name: string | null;
  sender_name: string | null;
  is_group: number;
  group_jid: string | null;
  message_kind: IncomingMessageArchiveKind;
  kind: string;
  text_content: string | null;
  saved_file_path: string;
  file_path: string;
  saved_file_name: string;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  size_bytes: number;
  forwarded_to_telegram: number;
  received_at: string;
  is_edited: number;
  original_text: string | null;
  raw_payload: string | null;
}

export interface CreateIncomingMessageInput {
  id?: string;
  sessionId: string;
  ownerTelegramId?: number;
  waMessageId?: string;
  messageId?: string;
  remoteJid?: string;
  senderJid: string;
  senderPhone: string;
  pushName?: string | null;
  senderName?: string | null;
  isGroup?: boolean;
  groupJid?: string | null;
  messageKind?: IncomingMessageArchiveKind;
  kind?: string;
  textContent?: string | null;
  savedFilePath?: string;
  filePath?: string;
  savedFileName?: string;
  fileName?: string;
  mimeType: string;
  fileSizeBytes?: number;
  fileSize?: number;
  forwardedToTelegram?: boolean;
  receivedAt?: string;
  isEdited?: boolean;
  originalText?: string | null;
  rawPayload?: string | null;
}

export interface InboxStats {
  total: number;
  textCount: number;
  mediaCount: number;
  stickerCount: number;
}

export class InboxRepository {
  constructor(private readonly db: AppDatabase) {}

  private hydrateRow(raw: Record<string, unknown>): IncomingMessageRecord {
    const messageKind = String(raw.message_kind || 'TEXT');
    const savedFilePath = String(raw.saved_file_path || '');
    const savedFileName = String(raw.saved_file_name || '');
    const fileSizeBytes = Number(raw.file_size_bytes ?? 0);
    const pushName = (raw.push_name as string | null) ?? null;
    const senderPhone = String(raw.sender_phone || '');
    const senderJid = String(raw.sender_jid || '');
    const groupJid = (raw.group_jid as string | null) ?? null;
    const waMessageId = String(raw.wa_message_id || '');

    return {
      id: String(raw.id),
      session_id: String(raw.session_id),
      owner_telegram_id: Number(raw.owner_telegram_id ?? 0),
      wa_message_id: waMessageId,
      message_id: waMessageId,
      remote_jid: groupJid || senderJid,
      sender_jid: senderJid,
      sender_phone: senderPhone,
      push_name: pushName,
      sender_name: pushName || senderPhone,
      is_group: Number(raw.is_group ?? 0),
      group_jid: groupJid,
      message_kind: messageKind,
      kind: messageKind.toLowerCase(),
      text_content: (raw.text_content as string | null) ?? null,
      saved_file_path: savedFilePath,
      file_path: savedFilePath,
      saved_file_name: savedFileName,
      file_name: savedFileName,
      mime_type: String(raw.mime_type || 'application/octet-stream'),
      file_size_bytes: fileSizeBytes,
      size_bytes: fileSizeBytes,
      forwarded_to_telegram: Number(raw.forwarded_to_telegram ?? 0),
      received_at: String(raw.received_at || ''),
      is_edited: Number(raw.is_edited ?? 0),
      original_text: (raw.original_text as string | null) ?? null,
      raw_payload: (raw.raw_payload as string | null) ?? null,
    };
  }

  public recordIncoming(input: CreateIncomingMessageInput): IncomingMessageRecord {
    const id = input.id || `inb_${crypto.randomBytes(5).toString('hex')}`;
    const receivedAt = input.receivedAt || new Date().toISOString();
    const waMessageId = input.waMessageId || input.messageId || id;
    const pushName = input.pushName ?? input.senderName ?? null;
    const isGroup =
      input.isGroup ?? Boolean(input.remoteJid && input.remoteJid.endsWith('@g.us'));
    const groupJid =
      input.groupJid ?? (isGroup ? input.remoteJid || null : null);
    const messageKind = String(
      input.messageKind || input.kind || 'text'
    ).toLowerCase();
    const savedFilePath = input.savedFilePath || input.filePath || '';
    const savedFileName = input.savedFileName || input.fileName || 'message.txt';
    const fileSizeBytes = input.fileSizeBytes ?? input.fileSize ?? 0;

    this.db.sqlite
      .prepare(
        `
        INSERT INTO incoming_messages (
          id, session_id, owner_telegram_id, wa_message_id,
          sender_jid, sender_phone, push_name, is_group, group_jid,
          message_kind, text_content, saved_file_path, saved_file_name,
          mime_type, file_size_bytes, forwarded_to_telegram, received_at,
          is_edited, original_text, raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        id,
        input.sessionId,
        input.ownerTelegramId ?? 0,
        waMessageId,
        input.senderJid,
        input.senderPhone,
        pushName,
        isGroup ? 1 : 0,
        groupJid,
        messageKind,
        input.textContent ?? null,
        savedFilePath,
        savedFileName,
        input.mimeType,
        fileSizeBytes,
        input.forwardedToTelegram ? 1 : 0,
        receivedAt,
        input.isEdited ? 1 : 0,
        input.originalText ?? null,
        input.rawPayload ?? null
      );

    return this.findById(id)!;
  }

  public insert(input: CreateIncomingMessageInput): IncomingMessageRecord {
    return this.recordIncoming(input);
  }

  public findById(
    id: string,
    actorTelegramId?: number,
    isOwner = true
  ): IncomingMessageRecord | undefined {
    const row = this.db.sqlite
      .prepare('SELECT * FROM incoming_messages WHERE id = ?')
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

  public findByWaMessageId(
    waMessageId: string,
    sessionId?: string
  ): IncomingMessageRecord | undefined {
    let sql = 'SELECT * FROM incoming_messages WHERE wa_message_id = ?';
    const params: string[] = [waMessageId];
    if (sessionId) {
      sql += ' AND session_id = ?';
      params.push(sessionId);
    }
    sql += ' ORDER BY received_at DESC LIMIT 1';
    const row = this.db.sqlite.prepare(sql).get(...params) as
      | Record<string, unknown>
      | undefined;
    return row ? this.hydrateRow(row) : undefined;
  }

  public updateEditedMessage(
    id: string,
    updates: {
      textContent: string;
      originalText?: string;
      savedFilePath?: string;
      savedFileName?: string;
      fileSizeBytes?: number;
    }
  ): IncomingMessageRecord | undefined {
    const existing = this.findById(id);
    if (!existing) return undefined;

    const origText = updates.originalText ?? existing.text_content ?? '';
    const filePath = updates.savedFilePath ?? existing.saved_file_path;
    const fileName = updates.savedFileName ?? existing.saved_file_name;
    const sizeBytes = updates.fileSizeBytes ?? existing.file_size_bytes;

    this.db.sqlite
      .prepare(
        `UPDATE incoming_messages
         SET text_content = ?,
             original_text = ?,
             saved_file_path = ?,
             saved_file_name = ?,
             file_size_bytes = ?,
             is_edited = 1
         WHERE id = ?`
      )
      .run(updates.textContent, origText, filePath, fileName, sizeBytes, id);

    return this.findById(id);
  }

  public updateRawPayload(id: string, rawPayload: string): void {
    this.db.sqlite
      .prepare('UPDATE incoming_messages SET raw_payload = ? WHERE id = ?')
      .run(rawPayload, id);
  }

  public listForOwner(
    actorTelegramId: number,
    isOwner = true,
    filterKind?: string,
    limit = 100
  ): IncomingMessageRecord[] {
    const clauses: string[] = [];
    const bindValues: Array<string | number> = [];

    if (!isOwner && actorTelegramId > 0) {
      clauses.push('owner_telegram_id = ?');
      bindValues.push(actorTelegramId);
    }

    if (filterKind && filterKind.toUpperCase() !== 'ALL') {
      clauses.push('LOWER(message_kind) = ?');
      bindValues.push(filterKind.toLowerCase());
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM incoming_messages ${whereSql} ORDER BY received_at DESC, rowid DESC LIMIT ?`
      )
      .all(...bindValues, Math.max(1, limit)) as Array<Record<string, unknown>>;

    return rows.map((r) => this.hydrateRow(r));
  }

  public markForwarded(id: string): void {
    this.db.sqlite
      .prepare('UPDATE incoming_messages SET forwarded_to_telegram = 1 WHERE id = ?')
      .run(id);
  }

  public listPaginated(params: {
    page: number;
    pageSize?: number;
    filterKind?: InboxFilterKind;
    sessionId?: string;
    actorTelegramId?: number;
    isOwner?: boolean;
  }): {
    items: IncomingMessageRecord[];
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

    if (params.sessionId) {
      clauses.push('session_id = ?');
      bindValues.push(params.sessionId);
    }

    const filter = params.filterKind || 'ALL';
    if (filter === 'TEXT') {
      clauses.push(
        "LOWER(message_kind) IN ('text', 'location', 'contact', 'poll', 'interactive', 'reaction', 'protocol')"
      );
    } else if (filter === 'STICKERS') {
      clauses.push("LOWER(message_kind) IN ('sticker', 'sticker_pack')");
    } else if (filter === 'MEDIA') {
      clauses.push(
        "LOWER(message_kind) IN ('image', 'video', 'audio', 'voice_ptt', 'document')"
      );
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const countRow = this.db.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM incoming_messages ${whereSql}`)
      .get(...bindValues) as { cnt: number };
    const total = Number(countRow?.cnt ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(params.page || 1, totalPages));
    const offset = (safePage - 1) * pageSize;

    const rawRows = this.db.sqlite
      .prepare(
        `SELECT * FROM incoming_messages ${whereSql} ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...bindValues, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      items: rawRows.map((r) => this.hydrateRow(r)),
      total,
      page: safePage,
      totalPages,
    };
  }

  public getStats(actorTelegramId?: number, isOwner = true): InboxStats {
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
        `SELECT message_kind, COUNT(*) AS cnt FROM incoming_messages ${whereOwner} GROUP BY message_kind`
      )
      .all(...args) as Array<{ message_kind: string; cnt: number }>;

    let total = 0;
    let textCount = 0;
    let mediaCount = 0;
    let stickerCount = 0;

    for (const r of rows) {
      const cnt = Number(r.cnt || 0);
      const k = String(r.message_kind || '').toLowerCase();
      total += cnt;
      if (k === 'sticker' || k === 'sticker_pack') {
        stickerCount += cnt;
      } else if (
        k === 'image' ||
        k === 'video' ||
        k === 'audio' ||
        k === 'voice_ptt' ||
        k === 'document'
      ) {
        mediaCount += cnt;
      } else {
        textCount += cnt;
      }
    }

    return { total, textCount, mediaCount, stickerCount };
  }

  public clearAll(actorTelegramId?: number, isOwner = true): number {
    const records =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? (this.db.sqlite
            .prepare(
              'SELECT saved_file_path FROM incoming_messages WHERE owner_telegram_id = ?'
            )
            .all(actorTelegramId) as Array<{ saved_file_path: string }>)
        : (this.db.sqlite
            .prepare('SELECT saved_file_path FROM incoming_messages')
            .all() as Array<{ saved_file_path: string }>);

    for (const r of records) {
      try {
        if (r.saved_file_path && fs.existsSync(r.saved_file_path)) {
          fs.unlinkSync(r.saved_file_path);
        }
      } catch {
        // Ignore cleanup failure
      }
    }

    const res =
      !isOwner && actorTelegramId !== undefined && actorTelegramId > 0
        ? this.db.sqlite
            .prepare('DELETE FROM incoming_messages WHERE owner_telegram_id = ?')
            .run(actorTelegramId)
        : this.db.sqlite.prepare('DELETE FROM incoming_messages').run();

    return Number(res.changes ?? 0);
  }
}
