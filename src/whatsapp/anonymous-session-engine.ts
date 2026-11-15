import crypto from 'node:crypto';
import { AppDatabase } from '../database/database';
import {
  AnyMessageContent,
  areJidsSameUser,
  jidNormalizedUser,
} from './baileys-compat';
import {
  WhatsAppIdentityService,
  emitIdentityTelemetry,
  extractCleanLid,
  extractCleanPn,
} from './identity-privacy-service';
import { maskPhoneForMenfess } from '../security/redaction';
import { validateRecipient } from '../security/validation';
import { ValidationError, WhatsAppConnectionError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('anonymous-session-engine');

export type AnonymousSessionState = 'pending' | 'active' | 'closing' | 'closed';

export type AnonymousMediaKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'ptt'
  | 'document'
  | 'sticker';

export interface AnonymousSession {
  id: string;
  sessionId: string;
  ownerTelegramId: number;
  senderJid: string;
  senderLidJid?: string;
  receiverJid: string;
  receiverLidJid?: string;
  senderAlias: string;
  maskPhonePresentation: boolean;
  preferLidDelivery: boolean;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  messagesRelayedCount: number;
  repliesRelayedCount: number;
  unreadCount: number;
  state: AnonymousSessionState;
}

export interface AnonymousRoomMessage {
  messageId: string;
  anonSessionId: string;
  sessionId: string;
  direction: 'OUTBOUND' | 'INBOUND';
  mediaKind: AnonymousMediaKind;
  textContent: string;
  createdAt: number;
}

export interface CreateAnonymousSessionParams {
  sessionId: string;
  ownerTelegramId?: number;
  senderInput: string;
  receiverInput: string;
  senderAlias?: string;
  maskPhonePresentation?: boolean;
  preferLidDelivery?: boolean;
  ttlMs?: number;
  identityService?: WhatsAppIdentityService;
}

export interface RelayDeliveryRequest {
  sessionId: string;
  targetJid: string;
  preferLid: boolean;
  content: AnyMessageContent;
  quotedMessageId?: string;
  customPushName?: string;
}

export interface RelayDeliveryResponse {
  messageId: string;
  deliveredToJid: string;
  addressingMode?: 'lid' | 'pn';
}

export type RelayMessageDeliverer = (
  req: RelayDeliveryRequest
) => Promise<RelayDeliveryResponse>;

export interface RelayAnonymousMessageParams {
  sessionId: string;
  anonSessionId: string;
  text: string;
  quotedMessageId?: string;
  maskPresentationOverride?: boolean;
  deliver: RelayMessageDeliverer;
}

export interface RelayAnonymousMediaParams {
  sessionId: string;
  anonSessionId: string;
  mediaKind: Exclude<AnonymousMediaKind, 'text'>;
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  caption?: string;
  ptt?: boolean;
  quotedMessageId?: string;
  deliver: RelayMessageDeliverer;
}

export interface RelayAnonymousReplyParams {
  sessionId: string;
  anonSessionId?: string;
  fromJid: string;
  text: string;
  quotedWaMessageId?: string;
  deliver: RelayMessageDeliverer;
}

export interface RelayAnonymousResult {
  anonSession: AnonymousSession;
  messageId: string;
  deliveredToJid: string;
  presentationLabel: string;
  direction: 'OUTBOUND' | 'REPLY';
  mediaKind: AnonymousMediaKind;
}

export interface IncomingRelayCandidateResult {
  matched: boolean;
  relayed: boolean;
  anonSessionId?: string;
  messageId?: string;
  reason?: string;
}

interface AnonymousSessionRow {
  id: string;
  session_id: string;
  owner_telegram_id: number;
  sender_jid: string;
  sender_lid_jid: string | null;
  receiver_jid: string;
  receiver_lid_jid: string | null;
  sender_alias: string;
  mask_phone_presentation: number;
  prefer_lid_delivery: number;
  created_at: number;
  last_activity_at: number;
  expires_at: number;
  messages_relayed_count: number;
  replies_relayed_count: number;
  unread_count?: number;
  state: string;
}

interface AnonymousMessageRow {
  relayed_wa_message_id: string;
  anon_session_id: string;
  session_id: string;
  direction: string;
  media_kind: string;
  text_content?: string;
  created_at: number;
}

const DEFAULT_ANON_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function rowToSession(row: AnonymousSessionRow): AnonymousSession {
  const validState: AnonymousSessionState =
    row.state === 'pending' ||
    row.state === 'active' ||
    row.state === 'closing' ||
    row.state === 'closed'
      ? row.state
      : 'closed';
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerTelegramId: row.owner_telegram_id ?? 0,
    senderJid: row.sender_jid,
    senderLidJid: row.sender_lid_jid || undefined,
    receiverJid: row.receiver_jid,
    receiverLidJid: row.receiver_lid_jid || undefined,
    senderAlias: row.sender_alias || 'Anonymous Sender',
    maskPhonePresentation: Boolean(row.mask_phone_presentation),
    preferLidDelivery: Boolean(row.prefer_lid_delivery),
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    expiresAt: row.expires_at,
    messagesRelayedCount: row.messages_relayed_count ?? 0,
    repliesRelayedCount: row.replies_relayed_count ?? 0,
    unreadCount: row.unread_count ?? 0,
    state: validState,
  };
}

function normalizeEndpointIdentity(input: string): {
  primaryJid: string;
  pnJid?: string;
  lidJid?: string;
} {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new ValidationError('الرجاء إدخال رقم أو معرف طرف صالح للجلسة المجهولة.');
  }
  const lid = extractCleanLid(trimmed);
  if (lid) {
    return { primaryJid: lid, lidJid: lid };
  }
  const validated = validateRecipient(trimmed);
  const pn = extractCleanPn(validated.jid) || jidNormalizedUser(validated.jid);
  return { primaryJid: pn, pnJid: pn };
}

function matchesPartyIdentity(
  candidateJid: string,
  primaryJid: string,
  lidJid?: string
): boolean {
  if (!candidateJid) return false;
  const normCandidate = jidNormalizedUser(candidateJid);
  if (normCandidate === primaryJid || areJidsSameUser(normCandidate, primaryJid)) {
    return true;
  }
  if (lidJid && (normCandidate === lidJid || areJidsSameUser(normCandidate, lidJid))) {
    return true;
  }
  return false;
}

export class AnonymousSessionEngine {
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(private readonly db: AppDatabase) {
    this.ensureRoomSchemaColumns();
  }

  private ensureRoomSchemaColumns(): void {
    try {
      const sessionCols = this.db.sqlite
        .prepare('PRAGMA table_info(anonymous_relay_sessions)')
        .all() as Array<{ name: string }>;
      if (
        sessionCols.length > 0 &&
        !sessionCols.some((c) => c.name === 'unread_count')
      ) {
        this.db.sqlite.exec(
          'ALTER TABLE anonymous_relay_sessions ADD COLUMN unread_count INTEGER NOT NULL DEFAULT 0'
        );
      }

      const msgCols = this.db.sqlite
        .prepare('PRAGMA table_info(anonymous_relay_messages)')
        .all() as Array<{ name: string }>;
      if (
        msgCols.length > 0 &&
        !msgCols.some((c) => c.name === 'text_content')
      ) {
        this.db.sqlite.exec(
          "ALTER TABLE anonymous_relay_messages ADD COLUMN text_content TEXT NOT NULL DEFAULT ''"
        );
      }
    } catch {
      // Ignore if table not yet initialized
    }
  }

  private runWithSessionLock<T>(
    sessionId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.then(
      () => undefined,
      () => undefined
    );
    this.sessionLocks.set(sessionId, tracked);
    const cleanup = () => {
      if (this.sessionLocks.get(sessionId) === tracked) {
        this.sessionLocks.delete(sessionId);
      }
    };
    tracked.then(cleanup, cleanup);
    return next;
  }

  public generateAnonId(): string {
    return `anon_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Builds the display label shown to Receiver B while NEVER exposing Sender A's raw phone JID.
   */
  public formatPresentationLabel(
    session: AnonymousSession,
    maskOverride?: boolean
  ): string {
    const useMasked =
      maskOverride !== undefined ? maskOverride : session.maskPhonePresentation;
    if (useMasked) {
      const masked = maskPhoneForMenfess(session.senderJid);
      return masked !== 'Anonymous Sender'
        ? masked
        : session.senderAlias || 'Anonymous Sender';
    }
    return session.senderAlias || 'Anonymous Sender';
  }

  /**
   * Marks expired sessions as `closed` in SQLite. Returns number of closed sessions.
   */
  public purgeExpiredSessions(now = Date.now()): number {
    const stmt = this.db.sqlite.prepare(
      `UPDATE anonymous_relay_sessions
       SET state = 'closed', last_activity_at = ?
       WHERE state IN ('pending', 'active', 'closing') AND expires_at <= ?`
    );
    const info = stmt.run(now, now);
    return Number(info.changes ?? 0);
  }

  public getAnonymousSession(
    sessionId: string,
    anonSessionId: string
  ): AnonymousSession | null {
    this.purgeExpiredSessions();
    const row = this.db.sqlite
      .prepare(
        `SELECT * FROM anonymous_relay_sessions WHERE id = ? AND session_id = ? LIMIT 1`
      )
      .get(anonSessionId.trim(), sessionId) as AnonymousSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  public listAnonymousSessions(params: {
    sessionId?: string;
    ownerTelegramId?: number;
    includeClosed?: boolean;
  }): AnonymousSession[] {
    this.purgeExpiredSessions();
    const conditions: string[] = [];
    const args: Array<string | number> = [];

    if (params.sessionId) {
      conditions.push('session_id = ?');
      args.push(params.sessionId);
    }
    if (params.ownerTelegramId && params.ownerTelegramId > 0) {
      conditions.push('owner_telegram_id = ?');
      args.push(params.ownerTelegramId);
    }
    if (!params.includeClosed) {
      conditions.push("state IN ('pending', 'active')");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM anonymous_relay_sessions ${where} ORDER BY last_activity_at DESC LIMIT 100`
      )
      .all(...args) as unknown as AnonymousSessionRow[];

    return rows.map(rowToSession);
  }

  public async createAnonymousSession(
    params: CreateAnonymousSessionParams
  ): Promise<AnonymousSession> {
    if (!params.sessionId?.trim()) {
      throw new ValidationError('معرف جلسة واتساب الوسيطة (sessionId) مطلوب.');
    }

    return this.runWithSessionLock(params.sessionId, async () => {
      this.purgeExpiredSessions();

      let sender = normalizeEndpointIdentity(params.senderInput);
      let receiver = normalizeEndpointIdentity(params.receiverInput);

      if (params.identityService) {
        try {
          const sResolved = await params.identityService
            .resolveIdentity(params.senderInput)
            .catch(() => null);
          if (sResolved) {
            sender = {
              primaryJid: sResolved.pnJid || sResolved.lidJid || sender.primaryJid,
              pnJid: sResolved.pnJid || sender.pnJid,
              lidJid: sResolved.lidJid || sender.lidJid,
            };
          }
          const rResolved = await params.identityService
            .resolveIdentity(params.receiverInput)
            .catch(() => null);
          if (rResolved) {
            receiver = {
              primaryJid: rResolved.pnJid || rResolved.lidJid || receiver.primaryJid,
              pnJid: rResolved.pnJid || receiver.pnJid,
              lidJid: rResolved.lidJid || receiver.lidJid,
            };
          }
        } catch {
          // Proceed with normalized JIDs
        }
      }

      if (areJidsSameUser(sender.primaryJid, receiver.primaryJid)) {
        throw new ValidationError(
          'لا يمكن إنشاء جلسة تواصل مجهول بين نفس الرقم (المرسل والمستلم متطابقان).'
        );
      }

      const id = this.generateAnonId();
      const now = Date.now();
      const ttlMs = Math.max(
        60_000,
        Math.min(7 * 24 * 60 * 60 * 1000, params.ttlMs ?? DEFAULT_ANON_SESSION_TTL_MS)
      );
      const expiresAt = now + ttlMs;
      const senderAlias =
        (params.senderAlias || '').trim().slice(0, 48) || 'Anonymous Sender';
      const maskPhonePresentation = params.maskPhonePresentation !== false;
      const preferLidDelivery = params.preferLidDelivery !== false;

      this.db.sqlite
        .prepare(
          `INSERT INTO anonymous_relay_sessions (
            id, session_id, owner_telegram_id, sender_jid, sender_lid_jid,
            receiver_jid, receiver_lid_jid, sender_alias,
            mask_phone_presentation, prefer_lid_delivery,
            created_at, last_activity_at, expires_at,
            messages_relayed_count, replies_relayed_count, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active')`
        )
        .run(
          id,
          params.sessionId,
          params.ownerTelegramId ?? 0,
          sender.primaryJid,
          sender.lidJid || null,
          receiver.primaryJid,
          receiver.lidJid || null,
          senderAlias,
          maskPhonePresentation ? 1 : 0,
          preferLidDelivery ? 1 : 0,
          now,
          now,
          expiresAt
        );

      const created = this.getAnonymousSession(params.sessionId, id)!;

      emitIdentityTelemetry({
        sessionId: params.sessionId,
        event: 'ANON_SESSION_CREATED',
        targetJid: receiver.lidJid || receiver.primaryJid,
        metadata: {
          anonSessionId: id,
          preferLidDelivery,
          maskPhonePresentation,
        },
      });

      return created;
    });
  }

  private assertActiveSession(
    sessionId: string,
    anonSessionId: string
  ): AnonymousSession {
    const sess = this.getAnonymousSession(sessionId, anonSessionId);
    if (!sess) {
      throw new ValidationError(
        `الجلسة المجهولة (${anonSessionId}) غير موجودة على هذه الجلسة (${sessionId}).`
      );
    }
    if (sess.state !== 'active' && sess.state !== 'pending') {
      throw new WhatsAppConnectionError(
        `الجلسة المجهولة (${anonSessionId}) مغلقة أو منتهية الصلاحية (الحالة: ${sess.state}).`
      );
    }
    if (sess.expiresAt <= Date.now()) {
      this.closeAnonymousSession({ sessionId, anonSessionId });
      throw new WhatsAppConnectionError(
        `انتهت صلاحية الجلسة المجهولة (${anonSessionId}).`
      );
    }
    return sess;
  }

  private recordRelayedMessageMapping(params: {
    messageId: string;
    anonSessionId: string;
    sessionId: string;
    direction: 'OUTBOUND' | 'REPLY';
    mediaKind: AnonymousMediaKind;
    textContent?: string;
  }): void {
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `INSERT OR REPLACE INTO anonymous_relay_messages (
          relayed_wa_message_id, anon_session_id, session_id, direction, media_kind, text_content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.messageId,
        params.anonSessionId,
        params.sessionId,
        params.direction,
        params.mediaKind,
        params.textContent || '',
        now
      );

    if (params.direction === 'OUTBOUND') {
      this.db.sqlite
        .prepare(
          `UPDATE anonymous_relay_sessions
           SET state = 'active', last_activity_at = ?, messages_relayed_count = messages_relayed_count + 1
           WHERE id = ? AND session_id = ?`
        )
        .run(now, params.anonSessionId, params.sessionId);
    } else {
      this.db.sqlite
        .prepare(
          `UPDATE anonymous_relay_sessions
           SET state = 'active', last_activity_at = ?, replies_relayed_count = replies_relayed_count + 1, unread_count = COALESCE(unread_count, 0) + 1
           WHERE id = ? AND session_id = ?`
        )
        .run(now, params.anonSessionId, params.sessionId);
    }
  }

  /**
   * Relays a text message from Sender A through the Botezz broker session to Receiver B
   * without leaking Sender A's raw JID or phone number.
   */
  public async relayAnonymousMessage(
    params: RelayAnonymousMessageParams
  ): Promise<RelayAnonymousResult> {
    const cleanText = String(params.text || '').trim();
    if (!cleanText) {
      throw new ValidationError('نص الرسالة المجهولة فارغ.');
    }

    const sess = this.assertActiveSession(params.sessionId, params.anonSessionId);
    const presentation = this.formatPresentationLabel(
      sess,
      params.maskPresentationOverride
    );

    const formattedText =
      `🎭 *رسالة مجهولة (Menfess Relay)*\n` +
      `🆔 الجلسة: \`#${sess.id}\`\n` +
      `👤 المرسل: *${presentation}*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${cleanText}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `↩️ _يمكنك الرد مباشرة (Quote/Reply) على هذه الرسالة وسيتولى البوت إيصال ردك بسرية تامة._`;

    const targetJid =
      sess.preferLidDelivery && sess.receiverLidJid
        ? sess.receiverLidJid
        : sess.receiverJid;

    const delivery = await params.deliver({
      sessionId: params.sessionId,
      targetJid,
      preferLid: sess.preferLidDelivery,
      content: { text: formattedText },
      quotedMessageId: params.quotedMessageId,
      customPushName: presentation,
    });

    this.recordRelayedMessageMapping({
      messageId: delivery.messageId,
      anonSessionId: sess.id,
      sessionId: params.sessionId,
      direction: 'OUTBOUND',
      mediaKind: 'text',
      textContent: cleanText,
    });

    emitIdentityTelemetry({
      sessionId: params.sessionId,
      event: 'ANON_SESSION_MESSAGE_RELAYED',
      targetJid: delivery.deliveredToJid,
      metadata: {
        anonSessionId: sess.id,
        mediaKind: 'text',
      },
    });

    const refreshed = this.getAnonymousSession(params.sessionId, sess.id) || sess;
    return {
      anonSession: refreshed,
      messageId: delivery.messageId,
      deliveredToJid: delivery.deliveredToJid,
      presentationLabel: presentation,
      direction: 'OUTBOUND',
      mediaKind: 'text',
    };
  }

  /**
   * Relays rich media (image, video, audio, ptt voice note, document, sticker) anonymously
   * from Sender A to Receiver B through the Botezz relay session.
   */
  public async relayAnonymousMedia(
    params: RelayAnonymousMediaParams
  ): Promise<RelayAnonymousResult> {
    if (!params.buffer || params.buffer.byteLength === 0) {
      throw new ValidationError('بيانات الوسائط المراد تمريرها مجهولاً فارغة.');
    }

    const sess = this.assertActiveSession(params.sessionId, params.anonSessionId);
    const presentation = this.formatPresentationLabel(sess);
    const headerCaption =
      `🎭 *رسالة وسائط مجهولة (#${sess.id})*\n` +
      `👤 *المرسل:* ${presentation}` +
      (params.caption ? `\n\n${params.caption}` : '') +
      `\n\n↩️ _قم بالرد (Reply) على هذه الرسالة للرد على المرسل بسرية._`;

    let content: AnyMessageContent;
    if (params.mediaKind === 'image') {
      content = {
        image: params.buffer,
        mimetype: params.mimeType || 'image/jpeg',
        caption: headerCaption,
      };
    } else if (params.mediaKind === 'video') {
      content = {
        video: params.buffer,
        mimetype: params.mimeType || 'video/mp4',
        caption: headerCaption,
      };
    } else if (params.mediaKind === 'audio' || params.mediaKind === 'ptt') {
      content = {
        audio: params.buffer,
        mimetype: params.mimeType || 'audio/ogg; codecs=opus',
        ptt: params.mediaKind === 'ptt' || Boolean(params.ptt),
      };
    } else if (params.mediaKind === 'sticker') {
      content = {
        sticker: params.buffer,
        mimetype: params.mimeType || 'image/webp',
      };
    } else {
      content = {
        document: params.buffer,
        mimetype: params.mimeType || 'application/octet-stream',
        fileName: params.fileName || `menfess_${sess.id}.bin`,
        caption: headerCaption,
      };
    }

    const targetJid =
      sess.preferLidDelivery && sess.receiverLidJid
        ? sess.receiverLidJid
        : sess.receiverJid;

    const delivery = await params.deliver({
      sessionId: params.sessionId,
      targetJid,
      preferLid: sess.preferLidDelivery,
      content,
      quotedMessageId: params.quotedMessageId,
      customPushName: presentation,
    });

    this.recordRelayedMessageMapping({
      messageId: delivery.messageId,
      anonSessionId: sess.id,
      sessionId: params.sessionId,
      direction: 'OUTBOUND',
      mediaKind: params.mediaKind,
    });

    emitIdentityTelemetry({
      sessionId: params.sessionId,
      event: 'ANON_SESSION_MESSAGE_RELAYED',
      targetJid: delivery.deliveredToJid,
      metadata: {
        anonSessionId: sess.id,
        mediaKind: params.mediaKind,
      },
    });

    const refreshed = this.getAnonymousSession(params.sessionId, sess.id) || sess;
    return {
      anonSession: refreshed,
      messageId: delivery.messageId,
      deliveredToJid: delivery.deliveredToJid,
      presentationLabel: presentation,
      direction: 'OUTBOUND',
      mediaKind: params.mediaKind,
    };
  }

  /**
   * Resolves a reply from Receiver B back to Sender A (or vice versa in active two-way relay)
   * without leaking either side's raw PN JID, strictly scoped to `params.sessionId`.
   */
  public async relayAnonymousReply(
    params: RelayAnonymousReplyParams
  ): Promise<RelayAnonymousResult> {
    const cleanText = String(params.text || '').trim();
    if (!cleanText) {
      throw new ValidationError('نص الرد المجهول فارغ.');
    }

    let resolvedAnonId = params.anonSessionId?.trim();
    if (!resolvedAnonId && params.quotedWaMessageId) {
      const msgRow = this.db.sqlite
        .prepare(
          `SELECT * FROM anonymous_relay_messages WHERE relayed_wa_message_id = ? AND session_id = ? LIMIT 1`
        )
        .get(params.quotedWaMessageId, params.sessionId) as
        | AnonymousMessageRow
        | undefined;
      if (msgRow) {
        resolvedAnonId = msgRow.anon_session_id;
      }
    }

    if (!resolvedAnonId) {
      throw new ValidationError(
        'تعذر تحديد جلسة Menfess المطابقة لهذا الرد على هذه الجلسة.'
      );
    }

    const sess = this.assertActiveSession(params.sessionId, resolvedAnonId);
    const fromIsReceiver = matchesPartyIdentity(
      params.fromJid,
      sess.receiverJid,
      sess.receiverLidJid
    );
    const fromIsSender = matchesPartyIdentity(
      params.fromJid,
      sess.senderJid,
      sess.senderLidJid
    );

    if (!fromIsReceiver && !fromIsSender) {
      throw new ValidationError(
        `المرسل (${params.fromJid}) لا ينتمي إلى جلسة التواصل المجهول (${sess.id}).`
      );
    }

    const targetJid = fromIsReceiver
      ? sess.preferLidDelivery && sess.senderLidJid
        ? sess.senderLidJid
        : sess.senderJid
      : sess.preferLidDelivery && sess.receiverLidJid
        ? sess.receiverLidJid
        : sess.receiverJid;

    const replyHeader = fromIsReceiver
      ? `↩️ *رد وارد من المستلم (جلسة #${sess.id})*`
      : `🎭 *رسالة متابعة من المرسل (${this.formatPresentationLabel(sess)} — #${sess.id})*`;

    const body =
      `${replyHeader}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `${cleanText}`;

    const delivery = await params.deliver({
      sessionId: params.sessionId,
      targetJid,
      preferLid: sess.preferLidDelivery,
      content: { text: body },
      quotedMessageId: params.quotedWaMessageId,
      customPushName: fromIsReceiver
        ? 'Menfess Recipient'
        : this.formatPresentationLabel(sess),
    });

    this.recordRelayedMessageMapping({
      messageId: delivery.messageId,
      anonSessionId: sess.id,
      sessionId: params.sessionId,
      direction: fromIsReceiver ? 'REPLY' : 'OUTBOUND',
      mediaKind: 'text',
      textContent: cleanText,
    });

    emitIdentityTelemetry({
      sessionId: params.sessionId,
      event: 'ANON_SESSION_REPLY_RELAYED',
      targetJid: delivery.deliveredToJid,
      metadata: {
        anonSessionId: sess.id,
        fromRole: fromIsReceiver ? 'receiver' : 'sender',
      },
    });

    const refreshed = this.getAnonymousSession(params.sessionId, sess.id) || sess;
    return {
      anonSession: refreshed,
      messageId: delivery.messageId,
      deliveredToJid: delivery.deliveredToJid,
      presentationLabel: fromIsReceiver
        ? 'Anonymous Recipient'
        : this.formatPresentationLabel(sess),
      direction: 'REPLY',
      mediaKind: 'text',
    };
  }

  /**
   * Automatically detects whether an incoming WhatsApp message is a reply to an active
   * Menfess relay message on the SAME `sessionId` and relays it back seamlessly.
   */
  public async handleIncomingRelayCandidate(params: {
    sessionId: string;
    fromJid: string;
    senderLidJid?: string;
    text: string;
    quotedMessageId?: string;
    fromMe?: boolean;
    deliver: RelayMessageDeliverer;
  }): Promise<IncomingRelayCandidateResult> {
    if (params.fromMe || !params.text?.trim() || !params.fromJid) {
      return { matched: false, relayed: false };
    }

    this.purgeExpiredSessions();

    let targetAnonId: string | undefined;

    // 1. Exact quoted stanza match in SQLite scoped to `params.sessionId`
    if (params.quotedMessageId) {
      const msgRow = this.db.sqlite
        .prepare(
          `SELECT * FROM anonymous_relay_messages WHERE relayed_wa_message_id = ? AND session_id = ? LIMIT 1`
        )
        .get(params.quotedMessageId, params.sessionId) as
        | AnonymousMessageRow
        | undefined;
      if (msgRow) {
        targetAnonId = msgRow.anon_session_id;
      }
    }

    // 2. Explicit `#anon_xxxxxxxx` tag inside message text
    if (!targetAnonId) {
      const tagMatch = params.text.match(/#?(anon_[a-f0-9]{6,16})/i);
      if (tagMatch?.[1]) {
        targetAnonId = tagMatch[1].toLowerCase();
      }
    }

    if (!targetAnonId) {
      return { matched: false, relayed: false };
    }

    const sess = this.getAnonymousSession(params.sessionId, targetAnonId);
    if (!sess || sess.state !== 'active') {
      return {
        matched: true,
        relayed: false,
        anonSessionId: targetAnonId,
        reason: sess ? `SESSION_${sess.state.toUpperCase()}` : 'SESSION_NOT_FOUND',
      };
    }

    const effectiveFrom =
      params.senderLidJid &&
      (matchesPartyIdentity(params.senderLidJid, sess.receiverJid, sess.receiverLidJid) ||
        matchesPartyIdentity(params.senderLidJid, sess.senderJid, sess.senderLidJid))
        ? params.senderLidJid
        : params.fromJid;

    try {
      const cleanedBody = params.text.replace(/#?anon_[a-f0-9]{6,16}/gi, '').trim() || params.text.trim();
      const relayed = await this.relayAnonymousReply({
        sessionId: params.sessionId,
        anonSessionId: sess.id,
        fromJid: effectiveFrom,
        text: cleanedBody,
        quotedWaMessageId: params.quotedMessageId,
        deliver: params.deliver,
      });
      return {
        matched: true,
        relayed: true,
        anonSessionId: sess.id,
        messageId: relayed.messageId,
      };
    } catch (err) {
      log.warn('Failed auto-relaying incoming Menfess reply', {
        sessionId: params.sessionId,
        anonSessionId: targetAnonId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        matched: true,
        relayed: false,
        anonSessionId: targetAnonId,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  public closeAnonymousSession(params: {
    sessionId: string;
    anonSessionId: string;
  }): AnonymousSession | null {
    const existing = this.getAnonymousSession(params.sessionId, params.anonSessionId);
    if (!existing) return null;

    const now = Date.now();
    this.db.sqlite
      .prepare(
        `UPDATE anonymous_relay_sessions SET state = 'closing', last_activity_at = ? WHERE id = ? AND session_id = ?`
      )
      .run(now, existing.id, params.sessionId);

    this.db.sqlite
      .prepare(
        `UPDATE anonymous_relay_sessions SET state = 'closed', last_activity_at = ? WHERE id = ? AND session_id = ?`
      )
      .run(now, existing.id, params.sessionId);

    emitIdentityTelemetry({
      sessionId: params.sessionId,
      event: 'ANON_SESSION_CLOSED',
      metadata: { anonSessionId: existing.id },
    });

    return {
      ...existing,
      lastActivityAt: now,
      state: 'closed',
    };
  }

  /**
   * Looks up an anonymous session by its ID across all WhatsApp sessions (optionally scoped by ownerTelegramId).
   */
  public getAnonymousSessionById(
    anonSessionId: string,
    ownerTelegramId?: number
  ): AnonymousSession | null {
    this.purgeExpiredSessions();
    const cleanId = String(anonSessionId || '').trim();
    if (!cleanId) return null;

    if (ownerTelegramId && ownerTelegramId > 0) {
      const row = this.db.sqlite
        .prepare(
          `SELECT * FROM anonymous_relay_sessions WHERE id = ? AND (owner_telegram_id = ? OR owner_telegram_id = 0) LIMIT 1`
        )
        .get(cleanId, ownerTelegramId) as AnonymousSessionRow | undefined;
      return row ? rowToSession(row) : null;
    }

    const row = this.db.sqlite
      .prepare(`SELECT * FROM anonymous_relay_sessions WHERE id = ? LIMIT 1`)
      .get(cleanId) as AnonymousSessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Creates or re-opens an interactive Anonymous Chat Room session for a recipient (`targetPnJid` and/or `targetLidJid`).
   */
  public createOrOpenRoomSession(params: {
    sessionId: string;
    ownerTelegramId: number;
    senderJid?: string;
    senderLidJid?: string;
    targetPnJid?: string;
    targetLidJid?: string;
    targetDisplayLabel?: string;
    ttlMs?: number;
  }): AnonymousSession {
    this.purgeExpiredSessions();
    const now = Date.now();
    const ttlMs = Math.max(
      60_000,
      Math.min(7 * 24 * 60 * 60 * 1000, params.ttlMs ?? 7 * 24 * 60 * 60 * 1000)
    );
    const expiresAt = now + ttlMs;

    const cleanPn = extractCleanPn(params.targetPnJid) || undefined;
    const cleanLid = extractCleanLid(params.targetLidJid) || undefined;
    const primaryReceiverJid =
      cleanPn || cleanLid || jidNormalizedUser(params.targetPnJid || params.targetLidJid || '');
    if (!primaryReceiverJid) {
      throw new ValidationError('تعذر تحديد معرف المستلم لبدء الجلسة المجهولة.');
    }

    // Check if an active room already exists for this admin & recipient
    const existingList = this.listAnonymousSessions({
      ownerTelegramId: params.ownerTelegramId,
      includeClosed: false,
    });
    const matchedExisting = existingList.find((s) => {
      if (cleanPn && matchesPartyIdentity(cleanPn, s.receiverJid, s.receiverLidJid)) {
        return true;
      }
      if (cleanLid && matchesPartyIdentity(cleanLid, s.receiverJid, s.receiverLidJid)) {
        return true;
      }
      return matchesPartyIdentity(primaryReceiverJid, s.receiverJid, s.receiverLidJid);
    });

    if (matchedExisting) {
      const updatedReceiverJid = cleanPn || matchedExisting.receiverJid;
      const updatedReceiverLid = cleanLid || matchedExisting.receiverLidJid || null;
      const updatedAlias =
        params.targetDisplayLabel?.trim() || matchedExisting.senderAlias;
      this.db.sqlite
        .prepare(
          `UPDATE anonymous_relay_sessions
           SET session_id = ?, receiver_jid = ?, receiver_lid_jid = ?, sender_alias = ?,
               state = 'active', last_activity_at = ?, expires_at = ?
           WHERE id = ?`
        )
        .run(
          params.sessionId,
          updatedReceiverJid,
          updatedReceiverLid,
          updatedAlias,
          now,
          expiresAt,
          matchedExisting.id
        );
      return this.getAnonymousSessionById(matchedExisting.id)!;
    }

    const id = this.generateAnonId();
    const senderPrimary =
      extractCleanPn(params.senderJid) ||
      extractCleanLid(params.senderLidJid) ||
      params.senderJid ||
      'self@s.whatsapp.net';
    const senderLid = extractCleanLid(params.senderLidJid) || null;
    const aliasLabel =
      (params.targetDisplayLabel || '').trim().slice(0, 64) ||
      (cleanPn ? `+${cleanPn.split('@')[0]}` : cleanLid || primaryReceiverJid);

    this.db.sqlite
      .prepare(
        `INSERT INTO anonymous_relay_sessions (
          id, session_id, owner_telegram_id, sender_jid, sender_lid_jid,
          receiver_jid, receiver_lid_jid, sender_alias,
          mask_phone_presentation, prefer_lid_delivery,
          created_at, last_activity_at, expires_at,
          messages_relayed_count, replies_relayed_count, unread_count, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 0, 0, 0, 'active')`
      )
      .run(
        id,
        params.sessionId,
        params.ownerTelegramId || 0,
        senderPrimary,
        senderLid,
        primaryReceiverJid,
        cleanLid || null,
        aliasLabel,
        now,
        now,
        expiresAt
      );

    return this.getAnonymousSessionById(id)!;
  }

  /**
   * Records an outbound message sent from the interactive Anonymous Chat Room.
   */
  public recordRoomOutboundMessage(params: {
    anonSessionId: string;
    sessionId: string;
    messageId: string;
    text: string;
    mediaKind?: AnonymousMediaKind;
    deliveredLidJid?: string;
    resolvedPnJid?: string;
  }): AnonymousSession | null {
    const sess = this.getAnonymousSessionById(params.anonSessionId);
    if (!sess) return null;

    const now = Date.now();
    const cleanText = String(params.text || '').trim();
    const cleanLid = extractCleanLid(params.deliveredLidJid) || sess.receiverLidJid || null;
    const cleanPn = extractCleanPn(params.resolvedPnJid) || undefined;
    const receiverJid = cleanPn || sess.receiverJid;

    this.db.sqlite
      .prepare(
        `INSERT OR REPLACE INTO anonymous_relay_messages (
          relayed_wa_message_id, anon_session_id, session_id, direction, media_kind, text_content, created_at
        ) VALUES (?, ?, ?, 'OUTBOUND', ?, ?, ?)`
      )
      .run(
        params.messageId,
        sess.id,
        params.sessionId,
        params.mediaKind || 'text',
        cleanText,
        now
      );

    this.db.sqlite
      .prepare(
        `UPDATE anonymous_relay_sessions
         SET session_id = ?, receiver_jid = ?, receiver_lid_jid = ?,
             state = 'active', last_activity_at = ?, messages_relayed_count = messages_relayed_count + 1
         WHERE id = ?`
      )
      .run(params.sessionId, receiverJid, cleanLid, now, sess.id);

    return this.getAnonymousSessionById(sess.id);
  }

  /**
   * Returns chronological message history for an Anonymous Chat Room.
   */
  public getSessionMessages(
    anonSessionId: string,
    limit = 15
  ): AnonymousRoomMessage[] {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = this.db.sqlite
      .prepare(
        `SELECT * FROM anonymous_relay_messages
         WHERE anon_session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(anonSessionId.trim(), safeLimit) as unknown as AnonymousMessageRow[];

    return rows.reverse().map((r) => ({
      messageId: r.relayed_wa_message_id,
      anonSessionId: r.anon_session_id,
      sessionId: r.session_id,
      direction: r.direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND',
      mediaKind: (r.media_kind as AnonymousMediaKind) || 'text',
      textContent: r.text_content || '',
      createdAt: r.created_at,
    }));
  }

  /**
   * Resets unread replies count to 0 when the user enters or refreshes the room.
   */
  public markSessionRead(anonSessionId: string): void {
    this.db.sqlite
      .prepare(
        `UPDATE anonymous_relay_sessions SET unread_count = 0 WHERE id = ?`
      )
      .run(anonSessionId.trim());
  }

  /**
   * Permanently deletes an anonymous session and its transcript history.
   */
  public deleteAnonymousSession(
    anonSessionId: string,
    ownerTelegramId?: number
  ): boolean {
    const existing = this.getAnonymousSessionById(anonSessionId, ownerTelegramId);
    if (!existing) return false;

    this.db.sqlite
      .prepare(`DELETE FROM anonymous_relay_messages WHERE anon_session_id = ?`)
      .run(existing.id);
    const info = this.db.sqlite
      .prepare(`DELETE FROM anonymous_relay_sessions WHERE id = ?`)
      .run(existing.id);
    return Number(info.changes ?? 0) > 0;
  }

  /**
   * Matches an incoming WhatsApp message (whether addressed from `@lid` or `@s.whatsapp.net`)
   * against active Anonymous Chat Sessions and records the reply in `anonymous_relay_messages`.
   */
  public matchAndRecordIncomingRoomReply(params: {
    sessionId: string;
    candidateJids: Array<string | undefined | null>;
    messageId?: string;
    text: string;
    quotedMessageId?: string;
    fromMe?: boolean;
    markReadImmediately?: boolean;
  }): {
    matched: boolean;
    session?: AnonymousSession;
    message?: AnonymousRoomMessage;
  } {
    if (params.fromMe) {
      return { matched: false };
    }
    const cleanText = String(params.text || '').trim();
    if (!cleanText) {
      return { matched: false };
    }

    const normalizedCandidates = new Set<string>();
    let discoveredPn: string | undefined;
    let discoveredLid: string | undefined;

    for (const raw of params.candidateJids) {
      if (!raw || typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.endsWith('@g.us') || trimmed === 'status@broadcast') {
        continue;
      }
      normalizedCandidates.add(jidNormalizedUser(trimmed));
      const pn = extractCleanPn(trimmed);
      if (pn) {
        normalizedCandidates.add(pn);
        if (!discoveredPn) discoveredPn = pn;
      }
      const lid = extractCleanLid(trimmed);
      if (lid) {
        normalizedCandidates.add(lid);
        if (!discoveredLid) discoveredLid = lid;
      }
    }

    if (normalizedCandidates.size === 0) {
      return { matched: false };
    }

    this.purgeExpiredSessions();

    let matchedSession: AnonymousSession | null = null;

    // 1. Check quoted message ID first
    if (params.quotedMessageId) {
      const msgRow = this.db.sqlite
        .prepare(
          `SELECT * FROM anonymous_relay_messages WHERE relayed_wa_message_id = ? LIMIT 1`
        )
        .get(params.quotedMessageId) as AnonymousMessageRow | undefined;
      if (msgRow) {
        const s = this.getAnonymousSessionById(msgRow.anon_session_id);
        if (s && (s.state === 'active' || s.state === 'pending')) {
          matchedSession = s;
        }
      }
    }

    // 2. Match against active sessions by EITHER receiverJid (PN) OR receiverLidJid (LID)
    if (!matchedSession) {
      const activeSessions = this.listAnonymousSessions({ includeClosed: false });
      // Prefer sessions bound to the same WhatsApp sessionId first, then any active session
      const sortedSessions = [
        ...activeSessions.filter((s) => s.sessionId === params.sessionId),
        ...activeSessions.filter((s) => s.sessionId !== params.sessionId),
      ];

      for (const s of sortedSessions) {
        for (const cand of normalizedCandidates) {
          if (matchesPartyIdentity(cand, s.receiverJid, s.receiverLidJid)) {
            matchedSession = s;
            break;
          }
        }
        if (matchedSession) break;
      }
    }

    if (!matchedSession) {
      return { matched: false };
    }

    const msgId =
      params.messageId?.trim() ||
      `in_${matchedSession.id}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;

    // Deduplicate if this exact messageId was already recorded for this session
    const existingMsg = this.db.sqlite
      .prepare(
        `SELECT * FROM anonymous_relay_messages WHERE relayed_wa_message_id = ? AND anon_session_id = ? LIMIT 1`
      )
      .get(msgId, matchedSession.id) as AnonymousMessageRow | undefined;

    const now = Date.now();
    const updatedReceiverLid =
      discoveredLid || matchedSession.receiverLidJid || null;
    const updatedReceiverPn =
      discoveredPn && matchedSession.receiverJid.endsWith('@lid')
        ? discoveredPn
        : matchedSession.receiverJid;

    if (!existingMsg) {
      this.db.sqlite
        .prepare(
          `INSERT INTO anonymous_relay_messages (
            relayed_wa_message_id, anon_session_id, session_id, direction, media_kind, text_content, created_at
          ) VALUES (?, ?, ?, 'REPLY', 'text', ?, ?)`
        )
        .run(msgId, matchedSession.id, matchedSession.sessionId, cleanText, now);

      const unreadIncrement = params.markReadImmediately ? 0 : 1;
      this.db.sqlite
        .prepare(
          `UPDATE anonymous_relay_sessions
           SET receiver_jid = ?, receiver_lid_jid = ?, state = 'active',
               last_activity_at = ?,
               replies_relayed_count = replies_relayed_count + 1,
               unread_count = COALESCE(unread_count, 0) + ?
           WHERE id = ?`
        )
        .run(
          updatedReceiverPn,
          updatedReceiverLid,
          now,
          unreadIncrement,
          matchedSession.id
        );
    } else if (existingMsg && !existingMsg.text_content && cleanText) {
      this.db.sqlite
        .prepare(
          `UPDATE anonymous_relay_messages SET text_content = ? WHERE relayed_wa_message_id = ? AND anon_session_id = ?`
        )
        .run(cleanText, msgId, matchedSession.id);
    }

    const refreshed =
      this.getAnonymousSessionById(matchedSession.id) || matchedSession;
    return {
      matched: true,
      session: refreshed,
      message: {
        messageId: msgId,
        anonSessionId: refreshed.id,
        sessionId: refreshed.sessionId,
        direction: 'INBOUND',
        mediaKind: 'text',
        textContent: cleanText,
        createdAt: existingMsg?.created_at ?? now,
      },
    };
  }
}
