import fs from 'node:fs';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  areJidsSameUser,
  WASocket,
  ConnectionState,
  GroupMetadata,
  ParticipantAction,
  AnyMessageContent,
} from 'athanasia-baileys';
import {
  SupportedMediaKind,
  validateCustomPairingCode,
  generateRandomPairingCode,
} from '../security/validation';
import { WhatsAppConnectionError, UnsupportedOperationError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('connection-manager');

export interface GroupParticipantSummary {
  jid: string;
  lid?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupSummary {
  jid: string;
  subject: string;
  size: number;
  owner?: string;
  creation?: number;
  desc?: string;
  addressingMode?: string;
  isBotAdmin: boolean;
  participants: GroupParticipantSummary[];
}

export interface WhatsAppChannelMetadata {
  id: string;
  name: string;
  subscribers: number;
  state: string;
  verified: boolean;
  description?: string;
}

export interface SessionSocketDiagnostics {
  socketActive: boolean;
  registered: boolean;
  platform: string;
  device: string;
  meJid?: string;
  chatsCount: number;
  contactsCount: number;
  cachedMessagesCount: number;
}

/**
 * Per-Session In-Memory Store (adapted from Nebula `makeInMemoryStore`).
 * Tracks recent chats, contacts, and up to 100 recent messages per chat for diagnostics.
 */
export class SessionMemoryStore {
  public readonly chats = new Map<
    string,
    { id: string; name?: string; lastMsgTimestamp?: number }
  >();
  public readonly messages = new Map<string, unknown[]>();
  public readonly contacts = new Map<string, unknown>();

  public bind(ev: WASocket['ev']): () => void {
    const onMessagesUpsert = ({
      messages: newMessages,
    }: {
      messages: Array<{
        key?: { remoteJid?: string | null };
        pushName?: string | null;
        messageTimestamp?: number | { toNumber(): number };
      }>;
      type: string;
    }) => {
      if (!Array.isArray(newMessages)) return;
      for (const msg of newMessages) {
        const chatId = msg?.key?.remoteJid;
        if (!chatId) continue;
        const list = this.messages.get(chatId) || [];
        list.push(msg);
        if (list.length > 100) {
          list.shift();
        }
        this.messages.set(chatId, list);

        const ts =
          typeof msg.messageTimestamp === 'object' &&
          msg.messageTimestamp !== null &&
          typeof msg.messageTimestamp.toNumber === 'function'
            ? msg.messageTimestamp.toNumber()
            : Number(msg.messageTimestamp || Date.now());

        const prev = this.chats.get(chatId);
        this.chats.set(chatId, {
          ...(prev || {}),
          id: chatId,
          name: msg.pushName || prev?.name,
          lastMsgTimestamp: ts,
        });
      }
    };

    const onChatsSet = ({ chats: newChats }: { chats: Array<{ id: string }> }) => {
      if (!Array.isArray(newChats)) return;
      for (const chat of newChats) {
        if (chat?.id) {
          this.chats.set(chat.id, chat);
        }
      }
    };

    const onContactsSet = ({
      contacts: newContacts,
    }: {
      contacts: Record<string, unknown>;
    }) => {
      if (!newContacts || typeof newContacts !== 'object') return;
      for (const [id, contact] of Object.entries(newContacts)) {
        this.contacts.set(id, contact);
      }
    };

    ev.on('messages.upsert', onMessagesUpsert);
    ev.on('chats.set', onChatsSet);
    ev.on('contacts.set', onContactsSet);

    return () => {
      try {
        ev.off('messages.upsert', onMessagesUpsert);
        ev.off('chats.set', onChatsSet);
        ev.off('contacts.set', onContactsSet);
      } catch {
        // Ignore cleanup errors
      }
    };
  }

  public getStats(): {
    chatsCount: number;
    contactsCount: number;
    cachedMessagesCount: number;
  } {
    let cachedMessagesCount = 0;
    for (const list of this.messages.values()) {
      cachedMessagesCount += list.length;
    }
    return {
      chatsCount: this.chats.size,
      contactsCount: this.contacts.size,
      cachedMessagesCount,
    };
  }
}

export interface ConnectionEventCallbacks {
  onStatusChange: (params: {
    status:
      | 'CONNECTING'
      | 'CONNECTED'
      | 'AUTHENTICATED'
      | 'DISCONNECTED'
      | 'RESTART_REQUIRED'
      | 'LOGGED_OUT';
    jid?: string;
    statusCode?: number;
    errorMessage?: string;
  }) => void;
}

export interface WhatsAppSessionDriver {
  readonly sessionId: string;
  readonly isMock: boolean;
  connect(callbacks: ConnectionEventCallbacks): Promise<void>;
  requestPairingCode(phoneDigits: string, customCode?: string): Promise<string>;
  sendTextMessage(recipientJid: string, text: string): Promise<{ messageId: string }>;
  sendMediaMessage(params: {
    recipientJid: string;
    filePath: string;
    kind: SupportedMediaKind;
    mimeType: string;
    fileName: string;
    caption?: string;
  }): Promise<{ messageId: string }>;
  listParticipatingGroups(): Promise<GroupSummary[]>;
  getGroupMetadata(groupJid: string): Promise<GroupSummary>;
  getGroupInviteCode(groupJid: string): Promise<string>;
  acceptGroupInvite(inviteCode: string): Promise<string>;
  updateGroupParticipants(
    groupJid: string,
    participantJids: string[],
    action: ParticipantAction
  ): Promise<void>;
  leaveGroup(groupJid: string): Promise<void>;
  getChannelMetadata(inviteCode: string): Promise<WhatsAppChannelMetadata>;
  getSocketDiagnostics(): SessionSocketDiagnostics;
  sendPresenceUpdate(
    state: 'available' | 'composing' | 'paused',
    jid: string
  ): Promise<void>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
}

/**
 * Production Athanasia Baileys Socket Driver (`athanasia-baileys` v1.0.0).
 * Implements the exact socket, pairing-code (`requestPairingCode(phoneNumber, code)`),
 * group metadata caching (`cachedGroupMetadata`), newsletter/channel inspection (`newsletterMetadata`),
 * and LID/PN participant resolution APIs of `github:AthanasiaCMD/athanasia-baileys`.
 */
export class AthanasiaBaileysSessionDriver implements WhatsAppSessionDriver {
  public readonly isMock = false;
  private sock: WASocket | null = null;
  private evCleanup: (() => void) | null = null;
  private readonly groupMetadataCache = new Map<string, GroupMetadata>();
  public readonly memoryStore = new SessionMemoryStore();

  constructor(
    public readonly sessionId: string,
    private readonly authDir: string
  ) {}

  public async connect(callbacks: ConnectionEventCallbacks): Promise<void> {
    await this.disconnect();

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      // Fallback to athanasia-baileys bundled default version ([2, 3000, 1030831524])
    }

    const silentPino = pino({ level: 'silent' });
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false, // Required by athanasia-baileys for pairing code flow
      logger: silentPino,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid: string) => this.groupMetadataCache.get(jid),
    });

    this.sock = sock;
    const unbindStore = this.memoryStore.bind(sock.ev);

    const credsListener = () => {
      void saveCreds();
    };

    const connectionListener = (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'connecting') {
        callbacks.onStatusChange({ status: 'CONNECTING' });
      } else if (connection === 'open') {
        const rawJid = sock.user?.id || sock.authState?.creds?.me?.id;
        const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : undefined;
        callbacks.onStatusChange({
          status: 'CONNECTED',
          jid: normalizedJid,
        });
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || 'Connection closed';

        if (statusCode === DisconnectReason.loggedOut) {
          callbacks.onStatusChange({
            status: 'LOGGED_OUT',
            statusCode,
            errorMessage: 'تم تسجيل الخروج من تطبيق واتساب على الهاتف.',
          });
        } else if (statusCode === DisconnectReason.restartRequired) {
          callbacks.onStatusChange({
            status: 'RESTART_REQUIRED',
            statusCode,
            errorMessage: 'يتطلب بروتوكول واتساب إعادة تشغيل الجلسة بعد إتمام الاقتران.',
          });
        } else {
          callbacks.onStatusChange({
            status: 'DISCONNECTED',
            statusCode,
            errorMessage: errMsg,
          });
        }
      }
    };

    sock.ev.on('creds.update', credsListener);
    sock.ev.on('connection.update', connectionListener);

    this.evCleanup = () => {
      unbindStore();
      try {
        sock.ev.off('creds.update', credsListener);
        sock.ev.off('connection.update', connectionListener);
      } catch {
        // Ignore cleanup errors
      }
    };
  }

  private ensureSocket(): WASocket {
    if (!this.sock) {
      throw new WhatsAppConnectionError('جلسة واتساب غير متصلة حالياً.');
    }
    return this.sock;
  }

  /**
   * Initiates pairing code generation using `athanasia-baileys`'s `sock.requestPairingCode(phoneNumber, code?)`.
   * Checks `!sock.authState.creds.registered`, awaits socket readiness, and supports custom 8-char codes.
   */
  public async requestPairingCode(
    phoneDigits: string,
    customCode?: string
  ): Promise<string> {
    const sock = this.ensureSocket();
    if (typeof sock.requestPairingCode !== 'function') {
      throw new UnsupportedOperationError(
        'إصدار مكتبة athanasia-baileys الحالي لا يدعم توليد رمز الربط النصي (Pairing Code).'
      );
    }

    if (sock.authState?.creds?.registered) {
      throw new WhatsAppConnectionError(
        'هذه الجلسة مسجلة ومرتبطة بالفعل في بيانات المصادقة.'
      );
    }

    // Ensure WebSocket is open before sending the link_code_companion_reg IQ node
    await sock.waitForSocketOpen();

    const codeToRequest = customCode
      ? validateCustomPairingCode(customCode)
      : generateRandomPairingCode();

    const rawCode = await sock.requestPairingCode(phoneDigits, codeToRequest);
    if (!rawCode) {
      throw new WhatsAppConnectionError('تعذر استلام رمز الربط من خوادم واتساب.');
    }
    return rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
  }

  public async sendTextMessage(
    recipientJid: string,
    text: string
  ): Promise<{ messageId: string }> {
    const sock = this.ensureSocket();
    const res = await sock.sendMessage(recipientJid, { text });
    return { messageId: res?.key?.id || `msg_${Date.now()}` };
  }

  public async sendMediaMessage(params: {
    recipientJid: string;
    filePath: string;
    kind: SupportedMediaKind;
    mimeType: string;
    fileName: string;
    caption?: string;
  }): Promise<{ messageId: string }> {
    const sock = this.ensureSocket();
    const fileBuffer = fs.readFileSync(params.filePath);

    let content: AnyMessageContent;
    if (params.kind === 'image') {
      content = {
        image: fileBuffer,
        mimetype: params.mimeType,
        caption: params.caption,
      };
    } else if (params.kind === 'video') {
      content = {
        video: fileBuffer,
        mimetype: params.mimeType,
        caption: params.caption,
      };
    } else if (params.kind === 'audio') {
      content = {
        audio: fileBuffer,
        mimetype: params.mimeType,
        ptt: false,
      };
    } else {
      content = {
        document: fileBuffer,
        mimetype: params.mimeType,
        fileName: params.fileName,
        caption: params.caption,
      };
    }

    const res = await sock.sendMessage(params.recipientJid, content);
    return { messageId: res?.key?.id || `media_${Date.now()}` };
  }

  /**
   * Maps `athanasia-baileys` GroupMetadata (supporting both PN and LID addressing modes)
   * into a normalized GroupSummary.
   */
  private mapGroupMetadata(sock: WASocket, meta: GroupMetadata): GroupSummary {
    this.groupMetadataCache.set(meta.id, meta);

    const selfId = sock.user?.id || sock.authState?.creds?.me?.id || '';
    const selfLid = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
    const normalizedSelfId = selfId ? jidNormalizedUser(selfId) : '';
    const normalizedSelfLid = selfLid ? jidNormalizedUser(selfLid) : '';

    const participants: GroupParticipantSummary[] = (meta.participants || []).map(
      (p) => {
        const rawJid = p.id || p.lid || '';
        const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : 'unknown@s.whatsapp.net';
        const normalizedLid = p.lid ? jidNormalizedUser(p.lid) : undefined;
        return {
          jid: normalizedJid,
          lid: normalizedLid,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        };
      }
    );

    const selfEntry = participants.find(
      (p) =>
        (normalizedSelfId && areJidsSameUser(p.jid, normalizedSelfId)) ||
        (normalizedSelfLid &&
          ((p.lid && areJidsSameUser(p.lid, normalizedSelfLid)) ||
            areJidsSameUser(p.jid, normalizedSelfLid)))
    );

    return {
      jid: meta.id,
      subject: meta.subject,
      size: meta.size || participants.length,
      owner: meta.owner,
      creation: meta.creation,
      desc: meta.desc,
      addressingMode: meta.addressingMode,
      isBotAdmin: Boolean(selfEntry?.isAdmin),
      participants,
    };
  }

  public async listParticipatingGroups(): Promise<GroupSummary[]> {
    const sock = this.ensureSocket();
    const groupsRecord = await sock.groupFetchAllParticipating();
    return Object.values(groupsRecord).map((meta) =>
      this.mapGroupMetadata(sock, meta)
    );
  }

  public async getGroupMetadata(groupJid: string): Promise<GroupSummary> {
    const sock = this.ensureSocket();
    const meta = await sock.groupMetadata(groupJid);
    return this.mapGroupMetadata(sock, meta);
  }

  public async getGroupInviteCode(groupJid: string): Promise<string> {
    const sock = this.ensureSocket();
    const code = await sock.groupInviteCode(groupJid);
    if (!code) {
      throw new UnsupportedOperationError('تعذر استخراج رابط الدعوة لهذه المجموعة.');
    }
    return code;
  }

  public async acceptGroupInvite(inviteCode: string): Promise<string> {
    const sock = this.ensureSocket();
    const groupJid = await sock.groupAcceptInvite(inviteCode);
    if (!groupJid) {
      throw new WhatsAppConnectionError('تعذر الانضمام إلى المجموعة باستخدام الرابط المرفق.');
    }
    return groupJid;
  }

  public async updateGroupParticipants(
    groupJid: string,
    participantJids: string[],
    action: ParticipantAction
  ): Promise<void> {
    const sock = this.ensureSocket();
    const results = await sock.groupParticipantsUpdate(
      groupJid,
      participantJids,
      action
    );

    if (Array.isArray(results)) {
      const failed = results.find((r) => r.status && r.status !== '200');
      if (failed) {
        throw new WhatsAppConnectionError(
          `رفض خادم واتساب تعديل العضو (${failed.jid}) برمز الحالة: ${failed.status}.`
        );
      }
    }
    // Refresh cached group metadata after participant change
    this.groupMetadataCache.delete(groupJid);
  }

  public async leaveGroup(groupJid: string): Promise<void> {
    const sock = this.ensureSocket();
    await sock.groupLeave(groupJid);
    this.groupMetadataCache.delete(groupJid);
  }

  /**
   * Queries WhatsApp Channel (Newsletter) metadata via `athanasia-baileys` `newsletterMetadata`
   * (adapted from Nebula `/cekidch` command).
   */
  public async getChannelMetadata(
    inviteCode: string
  ): Promise<WhatsAppChannelMetadata> {
    const sock = this.ensureSocket();
    if (typeof sock.newsletterMetadata !== 'function') {
      throw new UnsupportedOperationError(
        'المقبس الحالي لا يدعم استعلام بيانات قنوات واتساب (newsletterMetadata).'
      );
    }

    const res = await sock.newsletterMetadata('invite', inviteCode);
    if (!res) {
      throw new WhatsAppConnectionError(
        'تعذر جلب بيانات القناة. تأكد من صحة رابط القناة وأن جلسة واتساب متصلة.'
      );
    }

    const thread = res.thread_metadata;
    const name =
      thread?.name?.text ||
      (typeof res.name === 'string' ? res.name : undefined) ||
      'قناة واتساب';
    const subscribers = Number(
      thread?.subscribers_count ?? res.subscribers ?? 0
    );
    const rawState =
      typeof res.state === 'object' && res.state !== null
        ? res.state.type || 'ACTIVE'
        : String(res.state || 'ACTIVE');
    const verificationRaw =
      thread?.verification || res.verification || 'UNVERIFIED';
    const description =
      thread?.description?.text ||
      (typeof res.description === 'string' ? res.description : undefined);

    return {
      id: res.id || `${inviteCode}@newsletter`,
      name,
      subscribers: Number.isNaN(subscribers) ? 0 : subscribers,
      state: rawState,
      verified: String(verificationRaw).toUpperCase() === 'VERIFIED',
      description,
    };
  }

  /**
   * Returns detailed socket, credential, and in-memory store diagnostics
   * (adapted from Nebula `/ceksender` and `makeInMemoryStore`).
   */
  public getSocketDiagnostics(): SessionSocketDiagnostics {
    const stats = this.memoryStore.getStats();
    if (!this.sock) {
      return {
        socketActive: false,
        registered: false,
        platform: 'Unavailable',
        device: 'Unavailable',
        ...stats,
      };
    }

    const creds = this.sock.authState?.creds;
    const rawMeId = this.sock.user?.id || creds?.me?.id;
    const meJid = rawMeId ? jidNormalizedUser(rawMeId) : undefined;

    return {
      socketActive: true,
      registered: Boolean(creds?.registered),
      platform: String(creds?.platform || 'Ubuntu / Chrome'),
      device: String(creds?.device || 'Athanasia-Baileys Multi-Device'),
      meJid,
      ...stats,
    };
  }

  /**
   * Safe presence wrapper (adapted from Nebula `createSafeSock`).
   */
  public async sendPresenceUpdate(
    state: 'available' | 'composing' | 'paused',
    jid: string
  ): Promise<void> {
    const sock = this.ensureSocket();
    try {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate(state, jid);
    } catch {
      // Presence updates are best-effort
    }
  }

  public async disconnect(): Promise<void> {
    if (this.evCleanup) {
      this.evCleanup();
      this.evCleanup = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore socket close error
      }
      this.sock = null;
    }
  }

  public async logout(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // Ignore if already disconnected
      }
    }
    await this.disconnect();
  }
}

export { AthanasiaBaileysSessionDriver as BaileysSessionDriver };

/**
 * Deterministic Mock / Simulation Driver for Automated Testing and Local Web Preview.
 * Never claims to be a live WhatsApp network socket; explicitly marks `isMock = true`.
 */
export class MockWhatsAppSessionDriver implements WhatsAppSessionDriver {
  public readonly isMock = true;
  private callbacks: ConnectionEventCallbacks | null = null;
  private connected = false;
  private currentJid = '';
  private simulatedGroups: Map<string, GroupSummary> = new Map();
  private sentMessagesCount = 0;
  public simulatedDelayMs = 40;
  public shouldFailSend = false;

  constructor(
    public readonly sessionId: string,
    initialPhoneDigits = '966501234567'
  ) {
    this.currentJid = `${initialPhoneDigits}@s.whatsapp.net`;
    this.seedDefaultGroups();
  }

  private seedDefaultGroups(): void {
    this.simulatedGroups.set('120363041001@g.us', {
      jid: '120363041001@g.us',
      subject: 'مجموعة العمليات والتنسيق الإداري',
      size: 4,
      owner: this.currentJid,
      desc: 'مجموعة مخصصة لإدارة العمليات وتنبيهات النظام',
      addressingMode: 'pn',
      isBotAdmin: true,
      participants: [
        { jid: this.currentJid, isAdmin: true, isSuperAdmin: true },
        { jid: '966551112222@s.whatsapp.net', isAdmin: true, isSuperAdmin: false },
        { jid: '966553334444@s.whatsapp.net', isAdmin: false, isSuperAdmin: false },
        { jid: '966556667777@s.whatsapp.net', isAdmin: false, isSuperAdmin: false },
      ],
    });

    this.simulatedGroups.set('120363042002@g.us', {
      jid: '120363042002@g.us',
      subject: 'إعلانات الفريق العام (صلاحية عضو فقط)',
      size: 2,
      owner: '966559998888@s.whatsapp.net',
      desc: 'مجموعة عامة لا يملك فيها الحساب صلاحية مشرف',
      addressingMode: 'pn',
      isBotAdmin: false,
      participants: [
        { jid: '966559998888@s.whatsapp.net', isAdmin: true, isSuperAdmin: true },
        { jid: this.currentJid, isAdmin: false, isSuperAdmin: false },
      ],
    });
  }

  public async connect(callbacks: ConnectionEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.connected = true;
    callbacks.onStatusChange({
      status: 'CONNECTED',
      jid: this.currentJid,
    });
  }

  public async requestPairingCode(
    phoneDigits: string,
    customCode?: string
  ): Promise<string> {
    this.currentJid = `${phoneDigits}@s.whatsapp.net`;
    const validCustom = validateCustomPairingCode(customCode);
    if (validCustom) {
      return `${validCustom.slice(0, 4)}-${validCustom.slice(4)}`;
    }
    const suffix = phoneDigits.slice(-4).padStart(4, '0');
    return `WA96-${suffix}`;
  }

  public completeSimulatedPairing(): void {
    this.connected = true;
    this.callbacks?.onStatusChange({
      status: 'CONNECTED',
      jid: this.currentJid,
    });
  }

  public async sendTextMessage(
    recipientJid: string,
    text: string
  ): Promise<{ messageId: string }> {
    if (this.simulatedDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedDelayMs));
    }
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    if (this.shouldFailSend || text.includes('[FAIL_SIMULATION]')) {
      throw new WhatsAppConnectionError('فشل إرسال الرسالة من هذه الجلسة (رفض من الخادم).');
    }
    this.sentMessagesCount++;
    log.debug('Simulated text message sent', {
      sessionId: this.sessionId,
      recipientJid,
      length: text.length,
    });
    return { messageId: `sim_msg_${this.sessionId}_${Date.now()}` };
  }

  public async sendMediaMessage(params: {
    recipientJid: string;
    filePath: string;
    kind: SupportedMediaKind;
    mimeType: string;
    fileName: string;
    caption?: string;
  }): Promise<{ messageId: string }> {
    if (this.simulatedDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedDelayMs));
    }
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    if (!fs.existsSync(params.filePath)) {
      throw new WhatsAppConnectionError('الملف المؤقت غير موجود لإرساله.');
    }
    this.sentMessagesCount++;
    return { messageId: `sim_media_${this.sessionId}_${Date.now()}` };
  }

  public async listParticipatingGroups(): Promise<GroupSummary[]> {
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    return Array.from(this.simulatedGroups.values());
  }

  public async getGroupMetadata(groupJid: string): Promise<GroupSummary> {
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const group = this.simulatedGroups.get(groupJid);
    if (!group) {
      throw new WhatsAppConnectionError('لم يتم العثور على المجموعة المطلوبة في هذه الجلسة.');
    }
    return group;
  }

  public async getGroupInviteCode(groupJid: string): Promise<string> {
    const group = await this.getGroupMetadata(groupJid);
    if (!group.isBotAdmin) {
      throw new UnsupportedOperationError(
        'لا يمكن استخراج رابط الدعوة لهذه المجموعة لأن الحساب ليس مشرفاً (Admin).'
      );
    }
    return `AbCdEfGhIjKlMnOpQrSt12`;
  }

  public async acceptGroupInvite(inviteCode: string): Promise<string> {
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    if (inviteCode.startsWith('EXPIRED')) {
      throw new WhatsAppConnectionError('رابط الدعوة منتهي الصلاحية أو تم إلغاؤه.');
    }
    const newGroupJid = `120363099${inviteCode.slice(0, 4)}@g.us`;
    if (!this.simulatedGroups.has(newGroupJid)) {
      this.simulatedGroups.set(newGroupJid, {
        jid: newGroupJid,
        subject: `مجموعة منضمة (${inviteCode.slice(0, 6)})`,
        size: 12,
        addressingMode: 'pn',
        isBotAdmin: false,
        participants: [{ jid: this.currentJid, isAdmin: false, isSuperAdmin: false }],
      });
    }
    return newGroupJid;
  }

  public async updateGroupParticipants(
    groupJid: string,
    participantJids: string[],
    action: ParticipantAction
  ): Promise<void> {
    const group = await this.getGroupMetadata(groupJid);
    if (!group.isBotAdmin) {
      throw new UnsupportedOperationError(
        'هذه العملية تتطلب صلاحية مشرف المجموعة (Group Admin) للحساب المتصل.'
      );
    }

    for (const targetJid of participantJids) {
      const existingIdx = group.participants.findIndex((p) => p.jid === targetJid);
      if (action === 'add' && existingIdx === -1) {
        group.participants.push({ jid: targetJid, isAdmin: false, isSuperAdmin: false });
      } else if (action === 'remove' && existingIdx !== -1) {
        group.participants.splice(existingIdx, 1);
      } else if (action === 'promote' && existingIdx !== -1) {
        group.participants[existingIdx].isAdmin = true;
      } else if (action === 'demote' && existingIdx !== -1) {
        group.participants[existingIdx].isAdmin = false;
      }
    }
    group.size = group.participants.length;
  }

  public async leaveGroup(groupJid: string): Promise<void> {
    await this.getGroupMetadata(groupJid);
    this.simulatedGroups.delete(groupJid);
  }

  public async getChannelMetadata(
    inviteCode: string
  ): Promise<WhatsAppChannelMetadata> {
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    return {
      id: `120363199${inviteCode.slice(0, 6)}@newsletter`,
      name: `قناة واتساب الرسمية (${inviteCode.slice(0, 8)})`,
      subscribers: 14850,
      state: 'ACTIVE',
      verified: true,
      description: 'بيانات قناة مستخرجة عبر فاحص القنوات المدمج (محاكاة محلية).',
    };
  }

  public getSocketDiagnostics(): SessionSocketDiagnostics {
    return {
      socketActive: this.connected,
      registered: this.connected,
      platform: 'Ubuntu / Chrome (Simulated)',
      device: 'MockWhatsAppSessionDriver',
      meJid: this.currentJid,
      chatsCount: this.simulatedGroups.size,
      contactsCount: 6,
      cachedMessagesCount: this.sentMessagesCount,
    };
  }

  public async sendPresenceUpdate(
    _state: 'available' | 'composing' | 'paused',
    _jid: string
  ): Promise<void> {
    if (!this.connected) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    this.callbacks?.onStatusChange({ status: 'DISCONNECTED' });
  }

  public async logout(): Promise<void> {
    this.connected = false;
    this.callbacks?.onStatusChange({
      status: 'LOGGED_OUT',
      errorMessage: 'تم تسجيل الخروج من الجلسة.',
    });
  }
}

export type DriverFactory = (sessionId: string, authDir: string) => WhatsAppSessionDriver;
