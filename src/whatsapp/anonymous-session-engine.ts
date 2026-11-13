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
  state: AnonymousSessionState;
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
  state: string;
}

interface AnonymousMessageRow {
  relayed_wa_message_id: string;
  anon_session_id: string;
  session_id: string;
  direction: string;
  media_kind: string;
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

  constructor(private readonly db: AppDatabase) {}

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
  }): void {
    const now = Date.now();
    this.db.sqlite
      .prepare(
        `INSERT OR REPLACE INTO anonymous_relay_messages (
          relayed_wa_message_id, anon_session_id, session_id, direction, media_kind, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.messageId,
        params.anonSessionId,
        params.sessionId,
        params.direction,
        params.mediaKind,
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
           SET state = 'active', last_activity_at = ?, replies_relayed_count = replies_relayed_count + 1
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
}
