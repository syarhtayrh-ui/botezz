import fs from 'node:fs';
import vm from 'node:vm';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState as loadMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  areJidsSameUser,
  generateWAMessageFromContent,
  generateForwardMessageContent,
  generateWAMessage,
  prepareWAMessageMedia,
  proto,
  jidDecode,
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
import {
  WhatsAppConnectionError,
  UnsupportedOperationError,
  ValidationError,
  TaskTimeoutError,
  AppError,
  toSafeArabicError,
} from '../utils/errors';
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
  wsOpen?: boolean;
  handshakeReady?: boolean;
  connectionState?:
    | 'CLOSED'
    | 'CONNECTING'
    | 'AWAITING_PAIRING'
    | 'AUTHENTICATING'
    | 'CONNECTED';
  platform: string;
  device: string;
  meJid?: string;
  chatsCount: number;
  contactsCount: number;
  cachedMessagesCount: number;
}

export interface TestFunctionExecutionParams {
  targetPhone: string;
  iterations: number;
  funcCode: string;
  /** Delay in milliseconds between loop iterations (0..60000). Default: 200 */
  delayMs?: number;
  /** Maximum socket sends allowed (0 = unlimited, 1..100000). Default: 500 */
  maxSends?: number;
  /** VM evaluation timeout in milliseconds (500..60000). Default: 5000 */
  vmTimeoutMs?: number;
  /** Maximum sleep(ms) cap inside the sandbox per call (0..60000). Default: 10000 */
  maxSleepMs?: number;
  /** Abort remaining loop iterations immediately on first error. Default: false */
  stopOnError?: boolean;
  /** Capture console.log/warn/error output inside the VM sandbox. Default: true */
  captureConsole?: boolean;
  /** Optional custom 3rd argument passed to the sandboxed function */
  extraArg?: unknown;
}

export interface TestFunctionExecutionResult {
  sessionId: string;
  targetJid: string;
  targetDigits: string;
  funcName: string;
  arity: number;
  iterationsRequested: number;
  iterationsSucceeded: number;
  iterationsFailed: number;
  sendCount: number;
  sendMessageCount: number;
  relayMessageCount: number;
  presenceCount: number;
  maxSendsLimit: number;
  abortedEarly: boolean;
  consoleLogs: string[];
  durationMs: number;
  lastError?: string;
}

export interface SafeSocketTargetAdapter {
  sendMessage: (targetJid: string, message: AnyMessageContent) => Promise<unknown>;
  relayMessage: (
    targetJid: string,
    messageObj: proto.IMessage,
    opts?: Record<string, unknown>
  ) => Promise<unknown>;
  presenceSubscribe: (targetJid: string) => Promise<void>;
  sendPresenceUpdate: (
    state: 'available' | 'composing' | 'paused',
    targetJid: string
  ) => Promise<void>;
}

export interface SafeSocketOptions {
  /** Maximum socket sends allowed (0 = unlimited, default = 500) */
  maxSends?: number;
}

/**
 * Creates a rate-limited, JID-normalized socket wrapper (expanded from Nebula `createSafeSock`).
 * Supports manual/dynamic `maxSends` configuration (`0` = unlimited, default `500`),
 * runtime inspection/adjustment (`sock.getMaxSends()`, `sock.setMaxSends(n)`), and per-method counters.
 */
export function createSafeSock(
  adapter: SafeSocketTargetAdapter,
  options?: SafeSocketOptions
) {
  let sendCount = 0;
  let sendMessageCount = 0;
  let relayMessageCount = 0;
  let presenceCount = 0;
  let maxSendsLimit =
    options?.maxSends !== undefined &&
    Number.isFinite(options.maxSends) &&
    options.maxSends >= 0
      ? Math.floor(options.maxSends)
      : 500;

  const normalize = (j: string): string =>
    j && j.includes('@')
      ? j
      : `${String(j || '').replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  const checkAndIncrementSend = () => {
    if (maxSendsLimit > 0 && sendCount >= maxSendsLimit) {
      throw new Error(`RateLimit: تم الوصول للحد الأقصى للإرسال (${maxSendsLimit})`);
    }
    sendCount++;
  };

  return {
    getSendCount: () => sendCount,
    getSendMessageCount: () => sendMessageCount,
    getRelayMessageCount: () => relayMessageCount,
    getPresenceCount: () => presenceCount,
    getMaxSends: () => maxSendsLimit,
    setMaxSends: (newLimit: number) => {
      if (Number.isFinite(newLimit) && newLimit >= 0) {
        maxSendsLimit = Math.min(100000, Math.floor(newLimit));
      }
    },
    sendMessage: async (target: string, message: AnyMessageContent) => {
      checkAndIncrementSend();
      sendMessageCount++;
      const jid = normalize(target);
      return await adapter.sendMessage(jid, message);
    },
    relayMessage: async (
      target: string,
      messageObj: proto.IMessage,
      opts: Record<string, unknown> = {}
    ) => {
      checkAndIncrementSend();
      relayMessageCount++;
      const jid = normalize(target);
      return await adapter.relayMessage(jid, messageObj, opts);
    },
    presenceSubscribe: async (jid: string) => {
      try {
        presenceCount++;
        await adapter.presenceSubscribe(normalize(jid));
      } catch {
        // Best-effort presence subscribe
      }
    },
    sendPresenceUpdate: async (
      state: 'available' | 'composing' | 'paused',
      jid: string
    ) => {
      try {
        presenceCount++;
        await adapter.sendPresenceUpdate(state, normalize(jid));
      } catch {
        // Best-effort presence update
      }
    },
  };
}

/**
 * Executes a custom `async function <name>(...)` inside an isolated VM context
 * with `athanasia-baileys` helpers and `createSafeSock` (expanded from Nebula `/testfunction`).
 */
export async function runSandboxedTestFunction(
  sessionId: string,
  params: TestFunctionExecutionParams,
  adapter: SafeSocketTargetAdapter
): Promise<TestFunctionExecutionResult> {
  const digits = params.targetPhone.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new ValidationError(
      'رقم الهاتف الهدف غير صالح. يرجى إدخال رقم دولي صحيح (مثال: +966501234567).'
    );
  }

  const iterations = Math.max(
    1,
    Math.min(Number(params.iterations) || 1, 10000)
  );
  const targetJid = `${digits}@s.whatsapp.net`;

  const match = params.funcCode.match(/async\s+function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (!match) {
    throw new ValidationError(
      'الدالة المرفقة غير صالحة. يجب أن تكون بصيغة: async function myFunc(sock, target) { ... }'
    );
  }

  const funcName = match[1];
  const configuredMaxSends =
    params.maxSends !== undefined &&
    Number.isFinite(params.maxSends) &&
    params.maxSends >= 0
      ? Math.min(100000, Math.floor(params.maxSends))
      : 500;

  const safeSock = createSafeSock(adapter, { maxSends: configuredMaxSends });
  const stepDelayMs =
    params.delayMs !== undefined && Number.isFinite(params.delayMs)
      ? Math.min(Math.max(0, Math.floor(params.delayMs)), 60000)
      : 200;
  const vmTimeoutMs =
    params.vmTimeoutMs !== undefined && Number.isFinite(params.vmTimeoutMs)
      ? Math.min(Math.max(500, Math.floor(params.vmTimeoutMs)), 60000)
      : 5000;
  const maxSleepMs =
    params.maxSleepMs !== undefined && Number.isFinite(params.maxSleepMs)
      ? Math.min(Math.max(0, Math.floor(params.maxSleepMs)), 60000)
      : 10000;
  const stopOnError = Boolean(params.stopOnError);
  const captureConsole = params.captureConsole !== false;

  const sleep = (ms: number) =>
    new Promise((resolve) =>
      setTimeout(resolve, Math.min(Math.max(0, Number(ms) || 0), maxSleepMs))
    );

  const consoleLogs: string[] = [];
  const pushLog = (level: string, args: unknown[]) => {
    if (!captureConsole || consoleLogs.length >= 25) return;
    const formatted = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, 200);
    consoleLogs.push(level === 'LOG' ? formatted : `[${level}] ${formatted}`);
  };

  const sandbox = {
    console: {
      log: (...args: unknown[]) => pushLog('LOG', args),
      info: (...args: unknown[]) => pushLog('INFO', args),
      warn: (...args: unknown[]) => pushLog('WARN', args),
      error: (...args: unknown[]) => pushLog('ERR', args),
    },
    Buffer,
    sock: safeSock,
    target: targetJid,
    sessionId,
    maxSends: configuredMaxSends,
    sleep,
    generateWAMessageFromContent,
    generateForwardMessageContent,
    generateWAMessage,
    prepareWAMessageMedia,
    proto,
    jidDecode,
    areJidsSameUser,
  };

  const context = vm.createContext(sandbox);
  const wrapper = `${params.funcCode}\n${funcName}`;
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    const evaluated = vm.runInContext(wrapper, context, { timeout: vmTimeoutMs });
    if (typeof evaluated !== 'function') {
      throw new Error('Evaluated target is not a function');
    }
    fn = evaluated as (...args: unknown[]) => Promise<unknown>;
  } catch (err) {
    throw new ValidationError(
      `فشل تحليل كود الدالة (${funcName}): ${err instanceof Error ? err.message : 'خطأ برمجي'}`
    );
  }

  const arity = fn.length;
  let iterationsSucceeded = 0;
  let iterationsFailed = 0;
  let abortedEarly = false;
  let lastError: string | undefined;
  const startTime = Date.now();

  for (let i = 0; i < iterations; i++) {
    try {
      const iterContext =
        params.extraArg !== undefined
          ? params.extraArg
          : {
              iteration: i + 1,
              totalIterations: iterations,
              sessionId,
              maxSends: safeSock.getMaxSends(),
              sendCount: safeSock.getSendCount(),
            };
      if (arity === 1) {
        await fn(targetJid);
      } else if (arity === 2) {
        await fn(safeSock, targetJid);
      } else {
        await fn(safeSock, targetJid, iterContext);
      }
      iterationsSucceeded++;
    } catch (err) {
      iterationsFailed++;
      lastError = err instanceof Error ? err.message : String(err);
      if (stopOnError) {
        abortedEarly = true;
        break;
      }
    }
    if (i + 1 < iterations && stepDelayMs > 0) {
      await sleep(stepDelayMs);
    }
  }

  return {
    sessionId,
    targetJid,
    targetDigits: digits,
    funcName,
    arity,
    iterationsRequested: iterations,
    iterationsSucceeded,
    iterationsFailed,
    sendCount: safeSock.getSendCount(),
    sendMessageCount: safeSock.getSendMessageCount(),
    relayMessageCount: safeSock.getRelayMessageCount(),
    presenceCount: safeSock.getPresenceCount(),
    maxSendsLimit: safeSock.getMaxSends(),
    abortedEarly,
    consoleLogs,
    durationMs: Date.now() - startTime,
    lastError,
  };
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
      | 'AWAITING_PAIRING'
      | 'AUTHENTICATING'
      | 'CONNECTED'
      | 'AUTHENTICATED'
      | 'DISCONNECTED'
      | 'RESTART_REQUIRED'
      | 'LOGGED_OUT';
    jid?: string;
    statusCode?: number;
    errorMessage?: string;
    isRegistered?: boolean;
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
  executeTestFunction(
    params: TestFunctionExecutionParams
  ): Promise<TestFunctionExecutionResult>;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
}

/**
 * Production Athanasia Baileys Socket Driver (`athanasia-baileys` v1.0.0).
 * Implements the exact socket, pairing-code (`requestPairingCode(phoneNumber, code)`),
 * Noise + `pair-device` handshake synchronization, serialized credential persistence,
 * group metadata caching (`cachedGroupMetadata`), newsletter/channel inspection (`newsletterMetadata`),
 * and LID/PN participant resolution APIs of `github:AthanasiaCMD/athanasia-baileys`.
 */
export class AthanasiaBaileysSessionDriver implements WhatsAppSessionDriver {
  public readonly isMock = false;
  private sock: WASocket | null = null;
  private evCleanup: (() => void) | null = null;
  private readonly groupMetadataCache = new Map<string, GroupMetadata>();
  public readonly memoryStore = new SessionMemoryStore();
  private credsSaveChain: Promise<void> = Promise.resolve();
  private wsOpen = false;
  private handshakeReady = false;
  private connectionState:
    | 'CLOSED'
    | 'CONNECTING'
    | 'AWAITING_PAIRING'
    | 'AUTHENTICATING'
    | 'CONNECTED' = 'CLOSED';
  private readonly handshakeWaiters = new Set<{
    resolve: () => void;
    reject: (err: Error) => void;
  }>();

  constructor(
    public readonly sessionId: string,
    private readonly authDir: string
  ) {}

  private resolveHandshakeWaiters(): void {
    for (const waiter of this.handshakeWaiters) {
      waiter.resolve();
    }
    this.handshakeWaiters.clear();
  }

  private rejectHandshakeWaiters(err: Error): void {
    for (const waiter of this.handshakeWaiters) {
      waiter.reject(err);
    }
    this.handshakeWaiters.clear();
  }

  private waitForPairingHandshakeReady(timeoutMs = 20_000): Promise<void> {
    if (this.handshakeReady && this.wsOpen) {
      return Promise.resolve();
    }
    if (!this.sock) {
      return Promise.reject(
        new WhatsAppConnectionError('جلسة واتساب غير مهيأة حالياً لبدء المصافحة.')
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.handshakeWaiters.delete(waiter);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.handshakeWaiters.delete(waiter);
          reject(err);
        },
      };

      const timer = setTimeout(() => {
        this.handshakeWaiters.delete(waiter);
        reject(
          new TaskTimeoutError(
            'انتهت مهلة إتمام المصافحة المشفرة (Noise Handshake) مع خوادم واتساب قبل طلب رمز الربط.'
          )
        );
      }, timeoutMs);

      this.handshakeWaiters.add(waiter);
    });
  }

  public async connect(callbacks: ConnectionEventCallbacks): Promise<void> {
    await this.disconnect();

    const { state, saveCreds } = await loadMultiFileAuthState(this.authDir);
    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      // Fallback to athanasia-baileys bundled default version ([2, 3000, 1030831524])
    }

    const enqueueSaveCreds = (): Promise<void> => {
      this.credsSaveChain = this.credsSaveChain
        .then(() => saveCreds())
        .catch((err) => {
          log.warn('Failed saving WhatsApp credentials', {
            sessionId: this.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return this.credsSaveChain;
    };

    const silentPino = pino({ level: 'silent' });
    this.connectionState = 'CONNECTING';
    this.wsOpen = false;
    this.handshakeReady = false;

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false, // Required by athanasia-baileys for pairing code flow
      qrTimeout: 60_000, // Keep companion registration refs alive for 60s each during phone pairing
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
      void enqueueSaveCreds();
    };

    const connectionListener = (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      // 1. Companion registration handshake ready (`CB:iq,type:set,pair-device` emitted `qr`):
      // At this point `validateConnection()` and `noise.finishInit()` are 100% complete,
      // and WhatsApp server is ready to accept `link_code_companion_reg (stage="companion_hello")`.
      if (typeof qr === 'string' && qr.length > 0) {
        this.wsOpen = true;
        this.handshakeReady = true;
        this.connectionState = 'AWAITING_PAIRING';
        this.resolveHandshakeWaiters();
        callbacks.onStatusChange({
          status: 'AWAITING_PAIRING',
          isRegistered: false,
        });
      }

      // 2. User entered pairing code on phone and `CB:iq,,pair-success` succeeded (`isNewLogin: true`):
      if (isNewLogin) {
        if (sock.authState?.creds) {
          sock.authState.creds.registered = true;
        }
        this.connectionState = 'AUTHENTICATING';
        const rawJid = sock.user?.id || sock.authState?.creds?.me?.id;
        const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : undefined;
        void enqueueSaveCreds().then(() => {
          callbacks.onStatusChange({
            status: 'AUTHENTICATING',
            jid: normalizedJid,
            isRegistered: true,
          });
        });
      }

      if (connection === 'connecting') {
        this.connectionState = 'CONNECTING';
        callbacks.onStatusChange({
          status: 'CONNECTING',
          isRegistered: Boolean(
            sock.authState?.creds?.registered || sock.authState?.creds?.account
          ),
        });
      } else if (connection === 'open') {
        this.wsOpen = true;
        this.handshakeReady = true;
        this.resolveHandshakeWaiters();

        const creds = sock.authState?.creds;
        const rawJid = sock.user?.id || creds?.me?.id;
        const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : undefined;
        const hasValidAuth = Boolean(
          (creds?.registered || creds?.account) && normalizedJid
        );

        if (creds && hasValidAuth && !creds.registered) {
          creds.registered = true;
        }

        this.connectionState = hasValidAuth ? 'CONNECTED' : 'AWAITING_PAIRING';
        void enqueueSaveCreds().then(() => {
          if (hasValidAuth) {
            callbacks.onStatusChange({
              status: 'CONNECTED',
              jid: normalizedJid,
              isRegistered: true,
            });
          } else {
            callbacks.onStatusChange({
              status: 'AWAITING_PAIRING',
              jid: normalizedJid,
              isRegistered: false,
            });
          }
        });
      } else if (connection === 'close') {
        this.wsOpen = false;
        this.handshakeReady = false;
        this.connectionState = 'CLOSED';

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || 'Connection closed';
        this.rejectHandshakeWaiters(
          new WhatsAppConnectionError(
            `انقطع اتصال مقبس واتساب قبل جاهزية الربط (${statusCode || errMsg}).`,
            errMsg
          )
        );

        const isRegistered = Boolean(
          sock.authState?.creds?.registered || sock.authState?.creds?.account
        );

        // Wait for any pending credential writes (such as `pair-success` right before 515 restartRequired)
        // before notifying SessionManager so the restarted socket reads complete credentials from disk.
        void this.credsSaveChain.finally(() => {
          if (statusCode === DisconnectReason.loggedOut) {
            callbacks.onStatusChange({
              status: 'LOGGED_OUT',
              statusCode,
              errorMessage: 'تم تسجيل الخروج من تطبيق واتساب على الهاتف.',
              isRegistered: false,
            });
          } else if (statusCode === DisconnectReason.restartRequired) {
            callbacks.onStatusChange({
              status: 'RESTART_REQUIRED',
              statusCode,
              errorMessage:
                'يتطلب بروتوكول واتساب إعادة تشغيل الجلسة بعد إتمام الاقتران.',
              isRegistered: true,
            });
          } else {
            callbacks.onStatusChange({
              status: 'DISCONNECTED',
              statusCode,
              errorMessage: errMsg,
              isRegistered,
            });
          }
        });
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
   * Explicitly waits for the Noise handshake (`validateConnection`) and `CB:iq,type:set,pair-device` (`qr` event)
   * to complete BEFORE calling `sock.requestPairingCode`, preventing premature `creds.me` mutation
   * and uninitialized Noise frame encryption.
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

    const cleanDigits = phoneDigits.replace(/\D/g, '');
    if (!cleanDigits || cleanDigits.length < 8 || cleanDigits.length > 15) {
      throw new ValidationError(
        'رقم الهاتف المطلوب للاقتران غير صالح. يجب أن يحتوي على 8 إلى 15 رقماً دولياً.'
      );
    }

    const codeToRequest = customCode
      ? validateCustomPairingCode(customCode)
      : generateRandomPairingCode();

    // Wait for full Noise handshake + pair-device readiness (not just raw TCP open!)
    try {
      await this.waitForPairingHandshakeReady(20_000);
    } catch (handshakeErr) {
      if (handshakeErr instanceof AppError) throw handshakeErr;
      const safeErr = toSafeArabicError(handshakeErr);
      throw new WhatsAppConnectionError(
        `تعذر إتمام المصافحة الأولية مع خوادم واتساب لطلب رمز الربط: ${safeErr.userMessage}`,
        safeErr.sanitizedTechnicalMessage
      );
    }

    if (!this.sock || this.connectionState === 'CLOSED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'انغلق مقبس واتساب قبل إرسال طلب رمز الربط.'
      );
    }

    const executeRequest = async (): Promise<string> => {
      const resultPromise = sock.requestPairingCode(cleanDigits, codeToRequest);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new TaskTimeoutError(
                'انتهت مهلة استلام رمز الربط من خوادم واتساب (30 ثانية). يرجى التحقق من الشبكة وإعادة المحاولة.'
              )
            ),
          30_000
        )
      );
      return Promise.race([resultPromise, timeoutPromise]);
    };

    let rawCode: string;
    try {
      rawCode = await executeRequest();
      await this.credsSaveChain;
    } catch (firstErr) {
      if (firstErr instanceof AppError) throw firstErr;
      const safe = toSafeArabicError(firstErr);
      throw new WhatsAppConnectionError(
        `تعذر استلام رمز الربط من واتساب: ${safe.userMessage}`,
        safe.sanitizedTechnicalMessage
      );
    }

    // Verify the socket remained open and did not immediately reject the companion_hello stanza
    await new Promise((r) => setTimeout(r, 150));
    const currentConnectionState: string = this.connectionState;
    if (!this.sock || currentConnectionState === 'CLOSED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'رفض خادم واتساب طلب الاقتران أو انقطع الاتصال فور إرسال رمز الربط.'
      );
    }

    const cleanedCode = String(rawCode || '').trim().replace(/-/g, '').toUpperCase();
    if (!cleanedCode || cleanedCode.length !== 8) {
      throw new WhatsAppConnectionError('تعذر استلام رمز ربط صالح من خوادم واتساب.');
    }

    this.connectionState = 'AWAITING_PAIRING';
    return `${cleanedCode.slice(0, 4)}-${cleanedCode.slice(4)}`;
  }

  public async sendTextMessage(
    recipientJid: string,
    text: string
  ): Promise<{ messageId: string }> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً لإرسال الرسائل.');
    }
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
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً لإرسال الوسائط.');
    }
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
        wsOpen: false,
        handshakeReady: false,
        connectionState: 'CLOSED',
        platform: 'Unavailable',
        device: 'Unavailable',
        ...stats,
      };
    }

    const creds = this.sock.authState?.creds;
    const rawMeId = this.sock.user?.id || creds?.me?.id;
    const meJid = rawMeId ? jidNormalizedUser(rawMeId) : undefined;
    const isRegistered = Boolean((creds?.registered || creds?.account) && meJid);

    return {
      socketActive: this.wsOpen && this.connectionState !== 'CLOSED',
      registered: isRegistered,
      wsOpen: this.wsOpen,
      handshakeReady: this.handshakeReady,
      connectionState: this.connectionState,
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

  /**
   * Executes a custom `async function` in the isolated VM sandbox against the active Athanasia Baileys socket
   * (adapted from Nebula `/testfunction`).
   */
  public async executeTestFunction(
    params: TestFunctionExecutionParams
  ): Promise<TestFunctionExecutionResult> {
    const sock = this.ensureSocket();
    return runSandboxedTestFunction(this.sessionId, params, {
      sendMessage: async (targetJid, message) => sock.sendMessage(targetJid, message),
      relayMessage: async (targetJid, messageObj, opts = {}) =>
        sock.relayMessage(targetJid, messageObj, opts),
      presenceSubscribe: async (targetJid) => {
        await sock.presenceSubscribe(targetJid);
      },
      sendPresenceUpdate: async (state, targetJid) => {
        await sock.sendPresenceUpdate(state, targetJid);
      },
    });
  }

  public async disconnect(): Promise<void> {
    this.wsOpen = false;
    this.handshakeReady = false;
    this.connectionState = 'CLOSED';
    this.rejectHandshakeWaiters(
      new WhatsAppConnectionError('تم إغلاق مقبس واتساب.')
    );
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
    await this.credsSaveChain;
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
 * Accurately models the two-step pairing lifecycle (`AWAITING_PAIRING` -> `AUTHENTICATING` -> `CONNECTED`),
 * socket readiness, credential registration state, and simulated failure/disconnect modes.
 */
export class MockWhatsAppSessionDriver implements WhatsAppSessionDriver {
  public readonly isMock = true;
  private callbacks: ConnectionEventCallbacks | null = null;
  private socketOpen = false;
  private handshakeComplete = false;
  private registered = false;
  private connected = false;
  private connectionState:
    | 'CLOSED'
    | 'CONNECTING'
    | 'AWAITING_PAIRING'
    | 'AUTHENTICATING'
    | 'CONNECTED' = 'CLOSED';
  private currentJid = '';
  private simulatedGroups: Map<string, GroupSummary> = new Map();
  private sentMessagesCount = 0;
  public simulatedDelayMs = 40;
  public shouldFailSend = false;
  public shouldFailConnect = false;
  public shouldFailPairingRequest = false;
  public shouldTimeoutHandshake = false;
  public pairingCodeRequestCount = 0;
  public lastRequestedPhoneDigits: string | null = null;

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

  /**
   * Marks this mock driver as pre-registered (used when restoring or reconnecting an authenticated session).
   */
  public markRegistered(jid?: string): void {
    this.registered = true;
    if (jid) {
      this.currentJid = jid;
    }
  }

  public async connect(callbacks: ConnectionEventCallbacks): Promise<void> {
    if (this.shouldFailConnect) {
      this.socketOpen = false;
      this.handshakeComplete = false;
      this.connected = false;
      this.connectionState = 'CLOSED';
      throw new WhatsAppConnectionError('فشل فتح مقبس الاتصال مع خوادم واتساب.');
    }

    this.callbacks = callbacks;
    this.socketOpen = true;
    this.connectionState = 'CONNECTING';
    callbacks.onStatusChange({
      status: 'CONNECTING',
      isRegistered: this.registered,
    });

    if (this.shouldTimeoutHandshake) {
      this.handshakeComplete = false;
      return;
    }

    this.handshakeComplete = true;
    if (this.registered) {
      this.connected = true;
      this.connectionState = 'CONNECTED';
      callbacks.onStatusChange({
        status: 'CONNECTED',
        jid: this.currentJid,
        isRegistered: true,
      });
    } else {
      this.connected = false;
      this.connectionState = 'AWAITING_PAIRING';
      callbacks.onStatusChange({
        status: 'AWAITING_PAIRING',
        isRegistered: false,
      });
    }
  }

  public async requestPairingCode(
    phoneDigits: string,
    customCode?: string
  ): Promise<string> {
    if (!this.socketOpen) {
      throw new WhatsAppConnectionError(
        'مقبس واتساب غير مفتوح لطلب رمز الربط.'
      );
    }
    if (!this.handshakeComplete || this.shouldTimeoutHandshake) {
      throw new TaskTimeoutError(
        'انتهت مهلة إتمام المصافحة الأولية مع خادم واتساب قبل توليد رمز الربط.'
      );
    }
    if (this.registered) {
      throw new WhatsAppConnectionError(
        'هذه الجلسة مسجلة ومرتبطة بالفعل في بيانات المصادقة.'
      );
    }

    const cleanDigits = phoneDigits.replace(/\D/g, '');
    if (!cleanDigits || cleanDigits.length < 8 || cleanDigits.length > 15) {
      throw new ValidationError(
        'رقم الهاتف المطلوب للاقتران غير صالح. يجب أن يحتوي على 8 إلى 15 رقماً.'
      );
    }

    if (this.shouldFailPairingRequest) {
      throw new WhatsAppConnectionError(
        'تعذر استلام رمز الربط من خوادم واتساب (فشل طلب الاقتران).'
      );
    }

    this.pairingCodeRequestCount += 1;
    this.lastRequestedPhoneDigits = cleanDigits;
    this.currentJid = `${cleanDigits}@s.whatsapp.net`;
    this.connectionState = 'AWAITING_PAIRING';

    const validCustom = validateCustomPairingCode(customCode);
    if (validCustom) {
      return `${validCustom.slice(0, 4)}-${validCustom.slice(4)}`;
    }
    const suffix = cleanDigits.slice(-4).padStart(4, '0');
    return `WA96-${suffix}`;
  }

  /**
   * Simulates the user entering the pairing code on their WhatsApp phone
   * (`pair-success` -> `AUTHENTICATING` -> `CONNECTED`).
   */
  public completeSimulatedPairing(): void {
    this.socketOpen = true;
    this.handshakeComplete = true;
    this.registered = true;
    this.connectionState = 'AUTHENTICATING';
    this.callbacks?.onStatusChange({
      status: 'AUTHENTICATING',
      jid: this.currentJid,
      isRegistered: true,
    });
    this.connected = true;
    this.connectionState = 'CONNECTED';
    this.callbacks?.onStatusChange({
      status: 'CONNECTED',
      jid: this.currentJid,
      isRegistered: true,
    });
  }

  /**
   * Simulates a socket disconnect or stream error during runtime/pairing for testing.
   */
  public simulateDisconnect(statusCode = 428, errorMessage = 'Connection lost'): void {
    this.socketOpen = false;
    this.handshakeComplete = false;
    this.connected = false;
    this.connectionState = 'CLOSED';

    if (statusCode === DisconnectReason.loggedOut) {
      this.registered = false;
      this.callbacks?.onStatusChange({
        status: 'LOGGED_OUT',
        statusCode,
        errorMessage,
        isRegistered: false,
      });
    } else if (statusCode === DisconnectReason.restartRequired) {
      this.callbacks?.onStatusChange({
        status: 'RESTART_REQUIRED',
        statusCode,
        errorMessage,
        isRegistered: this.registered,
      });
    } else {
      this.callbacks?.onStatusChange({
        status: 'DISCONNECTED',
        statusCode,
        errorMessage,
        isRegistered: this.registered,
      });
    }
  }

  public async sendTextMessage(
    recipientJid: string,
    text: string
  ): Promise<{ messageId: string }> {
    if (this.simulatedDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedDelayMs));
    }
    if (!this.connected || !this.registered) {
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
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    if (!fs.existsSync(params.filePath)) {
      throw new WhatsAppConnectionError('الملف المؤقت غير موجود لإرساله.');
    }
    this.sentMessagesCount++;
    return { messageId: `sim_media_${this.sessionId}_${Date.now()}` };
  }

  public async listParticipatingGroups(): Promise<GroupSummary[]> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    return Array.from(this.simulatedGroups.values());
  }

  public async getGroupMetadata(groupJid: string): Promise<GroupSummary> {
    if (!this.connected || !this.registered) {
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
    if (!this.connected || !this.registered) {
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
    if (!this.connected || !this.registered) {
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
      socketActive: this.socketOpen && this.connectionState !== 'CLOSED',
      registered: this.registered,
      wsOpen: this.socketOpen,
      handshakeReady: this.handshakeComplete,
      connectionState: this.connectionState,
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
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
  }

  public async executeTestFunction(
    params: TestFunctionExecutionParams
  ): Promise<TestFunctionExecutionResult> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    return runSandboxedTestFunction(
      this.sessionId,
      {
        ...params,
        delayMs: params.delayMs ?? this.simulatedDelayMs,
      },
      {
        sendMessage: async (targetJid, _message) => {
          if (this.shouldFailSend) {
            throw new WhatsAppConnectionError('رفض الإرسال من الجلسة في وضع الاختبار.');
          }
          this.sentMessagesCount++;
          return { key: { remoteJid: targetJid, id: `sim_tf_${Date.now()}` } };
        },
        relayMessage: async (_targetJid, _messageObj) => {
          if (this.shouldFailSend) {
            throw new WhatsAppConnectionError('رفض تمرير العقدة (relayMessage) في وضع الاختبار.');
          }
          this.sentMessagesCount++;
          return `sim_relay_${Date.now()}`;
        },
        presenceSubscribe: async () => undefined,
        sendPresenceUpdate: async () => undefined,
      }
    );
  }

  public async disconnect(): Promise<void> {
    this.socketOpen = false;
    this.handshakeComplete = false;
    this.connected = false;
    this.connectionState = 'CLOSED';
  }

  public async logout(): Promise<void> {
    this.socketOpen = false;
    this.handshakeComplete = false;
    this.connected = false;
    this.registered = false;
    this.connectionState = 'CLOSED';
    this.callbacks?.onStatusChange({
      status: 'LOGGED_OUT',
      errorMessage: 'تم تسجيل الخروج من الجلسة.',
      isRegistered: false,
    });
  }
}

export type DriverFactory = (sessionId: string, authDir: string) => WhatsAppSessionDriver;

