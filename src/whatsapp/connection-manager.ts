import fs from 'node:fs';
import pino from 'pino';
import makeWASocket, {
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  jidNormalizedUser,
  areJidsSameUser,
  proto,
  WASocket,
  ConnectionState,
  GroupMetadata,
  ParticipantAction,
  AnyMessageContent,
} from 'athanasia-baileys';
import { createAtomicMultiFileAuthState } from './atomic-auth-state';
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

import {
  FunctionFailureCategory,
  FunctionExecutionMode,
} from '../database/repositories/function-lab-repository';
import {
  FunctionRegistry,
  FunctionExecutor,
  SmartProtocolWrapper,
} from '../function-lab';
import {
  MessageNormalizer,
  MessageSender,
  NormalizedIncomingMessage,
} from './message-capabilities';

const defaultFunctionRegistry = new FunctionRegistry();
const defaultFunctionExecutor = new FunctionExecutor(defaultFunctionRegistry);

export interface TestFunctionExecutionParams {
  targetPhone: string;
  iterations: number;
  funcCode: string;
  /** Execution mode: LIVE (default), DRY_RUN, or SIMULATION */
  executionMode?: FunctionExecutionMode;
  /** Delay in milliseconds between loop iterations (0 = no delay). Default: 200 */
  delayMs?: number;
  /** Maximum socket sends allowed (0 = unlimited). Default: 0 */
  maxSends?: number;
  /** VM evaluation timeout in milliseconds (0 = unlimited). Default: 0 */
  vmTimeoutMs?: number;
  /** Maximum sleep(ms) cap inside the sandbox per call (0 = unlimited). Default: 0 */
  maxSleepMs?: number;
  /** Abort remaining loop iterations immediately on first error. Default: false */
  stopOnError?: boolean;
  /** Capture console.log/warn/error output inside the VM sandbox. Default: true */
  captureConsole?: boolean;
  /** Enable Smart Protocol Delivery Wrapper & Anti-Detection Engine. Default: true */
  smartWrap?: boolean;
  /** Optional custom 3rd argument passed to the sandboxed function */
  extraArg?: unknown;
  /** Optional AbortSignal for immediate cancellation */
  abortSignal?: AbortSignal;
  /** Optional correlation ID for diagnostic tracing */
  correlationId?: string;
}

export interface TestFunctionExecutionResult {
  correlationId?: string;
  sessionId: string;
  executionMode?: FunctionExecutionMode;
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
  returnValuesPreview?: string[];
  durationMs: number;
  failureCategory?: FunctionFailureCategory;
  lastError?: string;
}

export interface SafeSocketTargetAdapter {
  sendMessage: (
    targetJid: string,
    message: AnyMessageContent,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
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
  raw?: Partial<WASocket> | Record<string, unknown>;
  [key: string]: unknown;
}

export interface SafeSocketOptions {
  /** Maximum socket sends allowed (0 = unlimited, default = 0) */
  maxSends?: number;
  /** Enable Smart Protocol Delivery Wrapper (default = true) */
  smartWrap?: boolean;
}

/**
 * Creates a rate-limited, JID-normalized socket wrapper (expanded from Nebula `createSafeSock`).
 * Supports manual/dynamic `maxSends` configuration (`0` = unlimited, default `0`),
 * runtime inspection/adjustment (`sock.getMaxSends()`, `sock.setMaxSends(n)`), per-method counters,
 * SmartProtocolWrapper integration, and Proxy-based access to all underlying `athanasia-baileys` socket methods.
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
      : 0;
  const smartWrapEnabled = options?.smartWrap ?? true;

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

  const rawTarget =
    (adapter.raw as Record<string, unknown> | undefined) ||
    (adapter as unknown as Record<string, unknown>);

  const baseObj: Record<string, unknown> = {
    raw: rawTarget,
    getSendCount: () => sendCount,
    getSendMessageCount: () => sendMessageCount,
    getRelayMessageCount: () => relayMessageCount,
    getPresenceCount: () => presenceCount,
    getMaxSends: () => maxSendsLimit,
    setMaxSends: (newLimit: number) => {
      if (Number.isFinite(newLimit) && newLimit >= 0) {
        maxSendsLimit = Math.floor(newLimit);
      }
    },
    sendMessage: async (
      target: string,
      message: AnyMessageContent,
      sendOpts?: Record<string, unknown>
    ) => {
      checkAndIncrementSend();
      sendMessageCount++;
      const jid = normalize(target);
      const effectiveOpts: Record<string, unknown> = { ...(sendOpts || {}) };
      if (smartWrapEnabled && !effectiveOpts.messageId) {
        effectiveOpts.messageId = SmartProtocolWrapper.generateStandardMessageId(
          (rawTarget?.user as { id?: string } | undefined)?.id
        );
      }
      return await adapter.sendMessage(jid, message, effectiveOpts);
    },
    relayMessage: async (
      target: string,
      messageObj: proto.IMessage,
      opts: Record<string, unknown> = {}
    ) => {
      checkAndIncrementSend();
      relayMessageCount++;
      const jid = normalize(target);
      if (smartWrapEnabled) {
        const prepared = SmartProtocolWrapper.prepareRelayPayload(
          jid,
          messageObj,
          opts,
          (rawTarget?.user as { id?: string } | undefined)?.id
        );
        return await adapter.relayMessage(jid, prepared.message, prepared.options);
      }
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

  return new Proxy(baseObj, {
    get(targetObj, prop, receiver) {
      if (Reflect.has(targetObj, prop)) {
        return Reflect.get(targetObj, prop, receiver);
      }
      if (rawTarget && prop in rawTarget) {
        const val = rawTarget[prop as string];
        return typeof val === 'function' ? val.bind(rawTarget) : val;
      }
      if (prop in adapter) {
        const val = (adapter as Record<string, unknown>)[prop as string];
        return typeof val === 'function' ? val.bind(adapter) : val;
      }
      return undefined;
    },
  }) as {
    raw: Record<string, unknown>;
    getSendCount: () => number;
    getSendMessageCount: () => number;
    getRelayMessageCount: () => number;
    getPresenceCount: () => number;
    getMaxSends: () => number;
    setMaxSends: (newLimit: number) => void;
    sendMessage: (
      target: string,
      message: AnyMessageContent,
      options?: Record<string, unknown>
    ) => Promise<unknown>;
    relayMessage: (
      target: string,
      messageObj: proto.IMessage,
      opts?: Record<string, unknown>
    ) => Promise<unknown>;
    presenceSubscribe: (jid: string) => Promise<void>;
    sendPresenceUpdate: (
      state: 'available' | 'composing' | 'paused',
      jid: string
    ) => Promise<void>;
    [key: string]: unknown;
  };
}

/**
 * Unified Function Lab execution entrypoint delegating directly to `FunctionExecutor`.
 * Ensures both `AthanasiaBaileysSessionDriver` and `MockWhatsAppSessionDriver` share the exact
 * same VM sandbox, Baileys helpers, flexible parser, and timer cleanup.
 */
export async function runSandboxedTestFunction(
  sessionId: string,
  params: TestFunctionExecutionParams,
  adapter: SafeSocketTargetAdapter
): Promise<TestFunctionExecutionResult> {
  return defaultFunctionExecutor.execute(
    {
      sessionId,
      targetPhone: params.targetPhone,
      iterations: params.iterations,
      funcCodeOrName: params.funcCode,
      executionMode: params.executionMode,
      delayMs: params.delayMs,
      maxSends: params.maxSends,
      vmTimeoutMs: params.vmTimeoutMs,
      maxSleepMs: params.maxSleepMs,
      stopOnError: params.stopOnError,
      captureConsole: params.captureConsole,
      smartWrap: params.smartWrap,
      extraArg: params.extraArg,
      abortSignal: params.abortSignal,
      correlationId: params.correlationId,
    },
    adapter
  );
}

/**
 * Per-Session In-Memory Store (adapted from Nebula `makeInMemoryStore`).
 * Tracks recent chats, contacts, normalized incoming messages, and up to 100 recent messages per chat for diagnostics.
 */
export class SessionMemoryStore {
  public readonly chats = new Map<
    string,
    { id: string; name?: string; lastMsgTimestamp?: number }
  >();
  public readonly messages = new Map<string, unknown[]>();
  public readonly normalizedMessages: NormalizedIncomingMessage[] = [];
  public readonly contacts = new Map<string, unknown>();
  private readonly messageByKey = new Map<string, proto.IMessage>();
  private readonly normalizer = new MessageNormalizer();

  private setBoundedMessageKey(lookupKey: string, message: proto.IMessage): void {
    if (this.messageByKey.has(lookupKey)) {
      this.messageByKey.delete(lookupKey);
    }
    this.messageByKey.set(lookupKey, message);
    if (this.messageByKey.size > 500) {
      const oldestKey = this.messageByKey.keys().next().value;
      if (oldestKey) {
        this.messageByKey.delete(oldestKey);
      }
    }
  }

  /**
   * Caches an outgoing or incoming `proto.IMessage` so `athanasia-baileys` `sendMessagesAgain`
   * can re-encrypt and re-transmit the payload when a companion device or recipient sends
   * `<receipt type="retry">`, preventing post-send and post-pairing session disconnects.
   */
  public cacheSentMessage(
    chatJidOrKey:
      | string
      | { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null }
      | undefined
      | null,
    messageIdOrContent: string | proto.IMessage | undefined | null,
    maybeMessage?: proto.IMessage | undefined | null
  ): void {
    let chatJid: string | undefined | null;
    let messageId: string | undefined | null;
    let message: proto.IMessage | undefined | null;

    if (
      chatJidOrKey &&
      typeof chatJidOrKey === 'object' &&
      !Array.isArray(chatJidOrKey)
    ) {
      chatJid = chatJidOrKey.remoteJid;
      messageId = chatJidOrKey.id;
      message = messageIdOrContent as proto.IMessage | undefined | null;
    } else {
      chatJid = chatJidOrKey as string | undefined | null;
      messageId = messageIdOrContent as string | undefined | null;
      message = maybeMessage;
    }

    if (!messageId || !message) return;
    this.setBoundedMessageKey(messageId, message);
    if (chatJid) {
      this.setBoundedMessageKey(`${chatJid}:${messageId}`, message);
      try {
        const normJid = jidNormalizedUser(chatJid);
        this.setBoundedMessageKey(`${normJid}:${messageId}`, message);
      } catch {
        // Ignore JID normalization failure
      }
    }
  }

  public getMessage(key: {
    remoteJid?: string | null;
    id?: string | null;
  }): proto.IMessage | undefined {
    const id = key?.id;
    if (!id) return undefined;
    if (key?.remoteJid) {
      const composite = this.messageByKey.get(`${key.remoteJid}:${id}`);
      if (composite) return composite;
      try {
        const normComposite = this.messageByKey.get(
          `${jidNormalizedUser(key.remoteJid)}:${id}`
        );
        if (normComposite) return normComposite;
      } catch {
        // Ignore
      }
    }
    return this.messageByKey.get(id);
  }

  public getCachedMessagesCount(): number {
    let count = 0;
    for (const k of this.messageByKey.keys()) {
      if (!k.includes(':')) {
        count++;
      }
    }
    return count;
  }

  public bind(ev: WASocket['ev']): () => void {
    const onMessagesUpsert = ({
      messages: newMessages,
    }: {
      messages: Array<{
        key?: { remoteJid?: string | null; id?: string | null };
        message?: proto.IMessage | null;
        pushName?: string | null;
        messageTimestamp?: number | { toNumber(): number };
      }>;
      type: string;
    }) => {
      if (!Array.isArray(newMessages)) return;
      for (const msg of newMessages) {
        try {
          const norm = this.normalizer.normalizeIncoming(msg);
          this.normalizedMessages.push(norm);
          if (this.normalizedMessages.length > 200) {
            this.normalizedMessages.shift();
          }
        } catch {
          // Never allow malformed incoming messages to crash the store listener
        }

        const chatId = msg?.key?.remoteJid;
        const msgId = msg?.key?.id;
        if (msgId && msg?.message) {
          this.cacheSentMessage(chatId, msgId, msg.message);
        }
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
/**
 * Minimum revision threshold above the expired `[2, 3000, 1030831524]` bundled in
 * `athanasia-baileys/lib/Defaults/baileys-version.json` (which WhatsApp servers reject with `<failure reason="405"/>`).
 */
const EXPIRED_BUNDLED_REVISION = 1030831524;
const VERIFIED_BASELINE_WA_WEB_VERSION: [number, number, number] = [2, 3000, 1052053390];
const WA_WEB_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedWaWebVersion: {
  version: [number, number, number];
  fetchedAt: number;
  source: 'wa_web_live' | 'baileys_remote';
} | null = null;

function isModernWaWebVersion(version: unknown): version is [number, number, number] {
  return (
    Array.isArray(version) &&
    version.length === 3 &&
    typeof version[0] === 'number' &&
    typeof version[1] === 'number' &&
    typeof version[2] === 'number' &&
    version[2] > EXPIRED_BUNDLED_REVISION
  );
}

export function invalidateWhatsAppWebVersionCache(): void {
  cachedWaWebVersion = null;
}

/**
 * Resolves a live, compatible WhatsApp Web client version supported by `athanasia-baileys`.
 *
 * Root-cause note:
 * `fetchLatestBaileysVersion()` in `athanasia-baileys` queries
 * `https://raw.githubusercontent.com/AthanasiaCMD/athanasia-baileys/refs/heads/master/lib/Defaults/baileys-version.json`
 * which returns HTTP 404 (the repository uses branch `main`, and its static JSON contains `[2, 3000, 1030831524]`).
 * Because `fetchLatestBaileysVersion()` catches errors internally without throwing, it silently returns
 * `[2, 3000, 1030831524]`, which WhatsApp servers immediately reject during `validateConnection()` with
 * `<failure reason="405" location="vll"/>`.
 *
 * By contrast, `fetchLatestWaWebVersion()` in `athanasia-baileys` queries `https://web.whatsapp.com/sw.js`
 * and extracts the active `client_revision`, which passes WhatsApp's handshake and emits `pair-device` (`qr`).
 */
export async function resolveWhatsAppWebVersion(forceRefresh = false): Promise<{
  version: [number, number, number];
  isLatest: boolean;
  source: 'wa_web_live' | 'baileys_remote' | 'cached_live' | 'verified_fallback';
}> {
  if (
    !forceRefresh &&
    cachedWaWebVersion &&
    Date.now() - cachedWaWebVersion.fetchedAt < WA_WEB_VERSION_CACHE_TTL_MS
  ) {
    return {
      version: cachedWaWebVersion.version,
      isLatest: true,
      source: 'cached_live',
    };
  }

  try {
    const waWeb = await fetchLatestWaWebVersion({
      signal: AbortSignal.timeout(8_000),
    });
    if (waWeb?.isLatest && isModernWaWebVersion(waWeb.version)) {
      cachedWaWebVersion = {
        version: waWeb.version,
        fetchedAt: Date.now(),
        source: 'wa_web_live',
      };
      return {
        version: waWeb.version,
        isLatest: true,
        source: 'wa_web_live',
      };
    }
    log.warn('fetchLatestWaWebVersion did not return a modern live version', {
      isLatest: waWeb?.isLatest ?? false,
      returnedVersion: Array.isArray(waWeb?.version) ? waWeb.version.join('.') : 'none',
      error:
        waWeb?.error instanceof Error
          ? waWeb.error.message
          : typeof (waWeb?.error as { message?: string } | undefined)?.message === 'string'
            ? (waWeb.error as { message: string }).message
            : undefined,
    });
  } catch (err) {
    log.warn('fetchLatestWaWebVersion threw an exception', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const baileysLatest = await fetchLatestBaileysVersion({
      signal: AbortSignal.timeout(5_000),
    });
    if (baileysLatest?.isLatest && isModernWaWebVersion(baileysLatest.version)) {
      cachedWaWebVersion = {
        version: baileysLatest.version,
        fetchedAt: Date.now(),
        source: 'baileys_remote',
      };
      return {
        version: baileysLatest.version,
        isLatest: true,
        source: 'baileys_remote',
      };
    }
  } catch {
    // Ignore secondary check failure
  }

  if (cachedWaWebVersion) {
    return {
      version: cachedWaWebVersion.version,
      isLatest: false,
      source: 'cached_live',
    };
  }

  return {
    version: [...VERIFIED_BASELINE_WA_WEB_VERSION],
    isLatest: false,
    source: 'verified_fallback',
  };
}

export function describeDisconnectReasonArabic(
  statusCode?: number,
  errMsg?: string,
  errData?: Record<string, unknown>
): string {
  const location = typeof errData?.location === 'string' ? ` [${errData.location}]` : '';
  switch (statusCode) {
    case 405:
      return `رفض خادم واتساب مصافحة البروتوكول أو تسجيل الجلسة (رمز 405${location}). تم تحديث إصدار بروتوكول WhatsApp Web؛ يرجى إعادة المحاولة.`;
    case DisconnectReason.loggedOut: // 401
      return 'تم تسجيل الخروج من تطبيق واتساب على الهاتف (رمز 401).';
    case DisconnectReason.forbidden: // 403
      return 'رفض خادم واتساب الوصول لهذه الجلسة (رمز 403).';
    case DisconnectReason.timedOut: // 408
      return 'انتهت مهلة الاتصال بخادم واتساب أو فُقد الاتصال (رمز 408).';
    case DisconnectReason.multideviceMismatch: // 411
      return 'عدم توافق وضع الأجهزة المتعددة في الحساب (رمز 411).';
    case DisconnectReason.connectionClosed: // 428
      return 'انغلق اتصال مقبس واتساب قبل جاهزية الربط (رمز 428).';
    case DisconnectReason.connectionReplaced: // 440
      return 'تم استبدال الاتصال بجلسة أخرى نشطة (رمز 440).';
    case DisconnectReason.badSession: // 500
      return 'خطأ في بيانات جلسة واتساب أو استجابة الخادم (رمز 500).';
    case DisconnectReason.unavailableService: // 503
      return 'خدمة واتساب غير متاحة مؤقتاً (رمز 503).';
    case DisconnectReason.restartRequired: // 515
      return 'يتطلب بروتوكول واتساب إعادة تشغيل الجلسة بعد إتمام الاقتران (رمز 515).';
    default:
      return `انقطع اتصال مقبس واتساب قبل جاهزية الربط (${statusCode || errMsg || 'closed'}).`;
  }
}

export type DisconnectClassificationCategory =
  | 'RESTART_REQUIRED'
  | 'LOGGED_OUT'
  | 'SESSION_CONFLICT_REPLACED'
  | 'PROTOCOL_OR_AUTH_REJECTED'
  | 'TRANSIENT_RECOVERABLE'
  | 'PAIRING_HANDSHAKE_ABORTED';

export interface DisconnectClassification {
  category: DisconnectClassificationCategory;
  shouldAutoReconnect: boolean;
  requiresImmediateRestart: boolean;
  shouldPurgeCredentials: boolean;
  requiresManualRepair: boolean;
  requiresRepair: boolean;
  targetSessionStatus:
    | 'AUTHENTICATING'
    | 'RECOVERING'
    | 'LOGGED_OUT'
    | 'REQUIRES_REPAIR'
    | 'DISCONNECTED'
    | 'FAILED';
  reasonArabic: string;
  arabicMessage: string;
}

/**
 * Deterministically classifies any WhatsApp disconnect statusCode (`401`, `403`, `405`, `408`,
 * `411`, `428`, `440`, `500`, `503`, `515`, or unknown) and registration state into an explicit
 * recovery action and target session state.
 */
export function classifyDisconnectReason(
  statusCode?: number,
  isRegistered = false,
  errMsg?: string,
  errData?: Record<string, unknown>
): DisconnectClassification {
  const reasonArabic = describeDisconnectReasonArabic(statusCode, errMsg, errData);

  if (statusCode === DisconnectReason.restartRequired) {
    return {
      category: 'RESTART_REQUIRED',
      shouldAutoReconnect: true,
      requiresImmediateRestart: true,
      shouldPurgeCredentials: false,
      requiresManualRepair: false,
      requiresRepair: false,
      targetSessionStatus: 'AUTHENTICATING',
      reasonArabic,
      arabicMessage: reasonArabic,
    };
  }

  if (statusCode === DisconnectReason.loggedOut) {
    return {
      category: 'LOGGED_OUT',
      shouldAutoReconnect: false,
      requiresImmediateRestart: false,
      shouldPurgeCredentials: true,
      requiresManualRepair: true,
      requiresRepair: true,
      targetSessionStatus: 'LOGGED_OUT',
      reasonArabic,
      arabicMessage: reasonArabic,
    };
  }

  if (statusCode === DisconnectReason.connectionReplaced) {
    return {
      category: 'SESSION_CONFLICT_REPLACED',
      shouldAutoReconnect: false,
      requiresImmediateRestart: false,
      shouldPurgeCredentials: false,
      requiresManualRepair: true,
      requiresRepair: true,
      targetSessionStatus: 'REQUIRES_REPAIR',
      reasonArabic,
      arabicMessage: reasonArabic,
    };
  }

  if (
    statusCode === DisconnectReason.forbidden ||
    statusCode === DisconnectReason.multideviceMismatch
  ) {
    return {
      category: 'PROTOCOL_OR_AUTH_REJECTED',
      shouldAutoReconnect: false,
      requiresImmediateRestart: false,
      shouldPurgeCredentials: false,
      requiresManualRepair: true,
      requiresRepair: true,
      targetSessionStatus: isRegistered ? 'REQUIRES_REPAIR' : 'FAILED',
      reasonArabic,
      arabicMessage: reasonArabic,
    };
  }

  if (!isRegistered) {
    return {
      category:
        statusCode === 405
          ? 'PROTOCOL_OR_AUTH_REJECTED'
          : 'PAIRING_HANDSHAKE_ABORTED',
      shouldAutoReconnect: false,
      requiresImmediateRestart: false,
      shouldPurgeCredentials: false,
      requiresManualRepair: false,
      requiresRepair: false,
      targetSessionStatus: 'FAILED',
      reasonArabic,
      arabicMessage: reasonArabic,
    };
  }

  if (statusCode === 405) {
    return {
      category: 'PROTOCOL_OR_AUTH_REJECTED',
      shouldAutoReconnect: true,
      requiresImmediateRestart: false,
      shouldPurgeCredentials: false,
      requiresManualRepair: false,
      requiresRepair: false,
      targetSessionStatus: 'RECOVERING',
      reasonArabic,
      arabicMessage: reasonArabic,
    };
  }

  return {
    category: 'TRANSIENT_RECOVERABLE',
    shouldAutoReconnect: true,
    requiresImmediateRestart: false,
    shouldPurgeCredentials: false,
    requiresManualRepair: false,
    requiresRepair: false,
    targetSessionStatus: 'RECOVERING',
    reasonArabic,
    arabicMessage: reasonArabic,
  };
}

/**
 * Deterministically selects a realistic desktop browser profile per `sessionId`
 * so concurrent multi-session sockets on the same server do not share an identical fingerprint.
 */
export function selectBrowserProfileForSession(
  sessionId: string
): [string, string, string] {
  const profiles: Array<() => [string, string, string]> = [
    () => Browsers.ubuntu('Chrome'),
    () => Browsers.macOS('Chrome'),
    () => Browsers.windows('Chrome'),
    () => Browsers.macOS('Safari'),
    () => Browsers.windows('Edge'),
  ];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return profiles[hash % profiles.length]!();
}

export class AthanasiaBaileysSessionDriver implements WhatsAppSessionDriver {
  public readonly isMock = false;
  private sock: WASocket | null = null;
  private evCleanup: (() => void) | null = null;
  private readonly groupMetadataCache = new Map<string, GroupMetadata>();
  private readonly verifiedRecipientJids = new Set<string>();
  public readonly memoryStore = new SessionMemoryStore();
  private credsSaveChain: Promise<void> = Promise.resolve();
  private flushAuthWrites: () => Promise<void> = async () => undefined;
  private wsOpen = false;
  private handshakeReady = false;
  private lastCloseError: WhatsAppConnectionError | null = null;
  private lastCloseStatusCode: number | undefined;
  private resolvedWaVersion: [number, number, number] | undefined;
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
  public messageSender?: MessageSender;

  constructor(
    public readonly sessionId: string,
    private readonly authDir: string,
    optionsOrSender?: MessageSender | { messageSender?: MessageSender }
  ) {
    this.messageSender =
      optionsOrSender instanceof MessageSender
        ? optionsOrSender
        : optionsOrSender?.messageSender;
  }

  /**
   * Warms up and resolves direct user JIDs (`@s.whatsapp.net`) via `sock.onWhatsApp` once per session
   * so USync device/LID mapping is populated before building Signal sessions.
   */
  private async resolveDirectRecipientJid(
    sock: WASocket,
    recipientJid: string
  ): Promise<string> {
    if (!recipientJid || !recipientJid.endsWith('@s.whatsapp.net')) {
      return recipientJid;
    }
    const normalized = jidNormalizedUser(recipientJid);
    if (this.verifiedRecipientJids.has(normalized)) {
      return normalized;
    }
    if (typeof sock.onWhatsApp === 'function') {
      try {
        const results = await sock.onWhatsApp(normalized);
        if (Array.isArray(results) && results.length > 0 && results[0]?.jid) {
          const serverJid = jidNormalizedUser(results[0].jid);
          this.verifiedRecipientJids.add( normalized );
          this.verifiedRecipientJids.add(serverJid);
          await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
          return serverJid;
        }
      } catch {
        // Proceed with normalized JID if USync query fails
      }
    }
    this.verifiedRecipientJids.add(normalized);
    return normalized;
  }

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
    if (this.lastCloseError) {
      return Promise.reject(this.lastCloseError);
    }
    if (!this.sock || this.connectionState === 'CLOSED') {
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

    const { state, saveCreds, flushPendingWrites, recoveredFromBackup } =
      await createAtomicMultiFileAuthState(this.authDir);
    this.flushAuthWrites = flushPendingWrites;

    const resolvedVersionInfo = await resolveWhatsAppWebVersion();
    const version = resolvedVersionInfo.version;
    this.resolvedWaVersion = version;

    log.info('Initializing Athanasia Baileys socket', {
      sessionId: this.sessionId,
      waVersion: version.join('.'),
      versionSource: resolvedVersionInfo.source,
      isLatestVersion: resolvedVersionInfo.isLatest,
      hasRegisteredCreds: Boolean(state.creds?.registered || state.creds?.account),
      recoveredFromBackup,
    });

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
    this.lastCloseError = null;
    this.lastCloseStatusCode = undefined;

    const cacheableKeys = makeCacheableSignalKeyStore(state.keys, silentPino);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: cacheableKeys,
      },
      printQRInTerminal: false, // Required by athanasia-baileys for pairing code flow
      qrTimeout: 60_000, // Keep companion registration refs alive for 60s each during phone pairing
      logger: silentPino,
      browser: selectBrowserProfileForSession(this.sessionId),
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 5,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid: string) => this.groupMetadataCache.get(jid),
      getMessage: async (key: { remoteJid?: string | null; id?: string | null }) =>
        this.memoryStore.getMessage(key),
    });

    this.sock = sock;
    const unbindStore = this.memoryStore.bind(sock.ev);

    const credsListener = (update?: Partial<typeof state.creds>) => {
      if (update && typeof update === 'object') {
        Object.assign(state.creds, update);
      }
      void enqueueSaveCreds()
        .then(() => this.flushAuthWrites())
        .then(() => {
          // If Baileys finished uploading initial PreKeys and set `registered: true` while socket is open:
          if (update?.registered === true && this.wsOpen && this.sock === sock) {
            const rawJid = sock.user?.id || state.creds?.me?.id;
            const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : undefined;
            if (normalizedJid && this.connectionState !== 'CONNECTED') {
              this.connectionState = 'CONNECTED';
              callbacks.onStatusChange({
                status: 'CONNECTED',
                jid: normalizedJid,
                isRegistered: true,
              });
            }
          }
        });
    };

    const connectionListener = (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      // 1. Companion registration handshake ready (`CB:iq,type:set,pair-device` emitted `qr`):
      // At this point `validateConnection()` and `noise.finishInit()` are 100% complete,
      // and WhatsApp server is ready to accept `link_code_companion_reg (stage="companion_hello")`.
      if (typeof qr === 'string' && qr.length > 0) {
        this.wsOpen = true;
        this.handshakeReady = true;
        this.lastCloseError = null;
        this.connectionState = 'AWAITING_PAIRING';
        this.resolveHandshakeWaiters();
        callbacks.onStatusChange({
          status: 'AWAITING_PAIRING',
          isRegistered: false,
        });
      }

      // 2. User entered pairing code on phone and `CB:iq,,pair-success` succeeded (`isNewLogin: true`):
      // CRITICAL: Do NOT mutate `creds.registered = true` here! Baileys needs `creds.registered === false`
      // on the subsequent 515 reconnect (`connection === 'open'`) so `validateConnection` runs
      // `uploadPreKeysToServerIfRequired()` + `sendPassiveIq('active')` before marking `registered: true`.
      if (isNewLogin) {
        this.connectionState = 'AUTHENTICATING';
        const rawJid = sock.user?.id || sock.authState?.creds?.me?.id;
        const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : undefined;
        void enqueueSaveCreds()
          .then(() => this.flushAuthWrites())
          .then(() => {
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
        this.lastCloseError = null;
        this.resolveHandshakeWaiters();

        const creds = sock.authState?.creds;
        const rawJid = sock.user?.id || creds?.me?.id;
        const normalizedJid = rawJid ? jidNormalizedUser(rawJid) : undefined;

        if (creds?.registered === true && normalizedJid) {
          // Fully registered & PreKeys already uploaded on server
          this.connectionState = 'CONNECTED';
          void enqueueSaveCreds()
            .then(() => this.flushAuthWrites())
            .then(() => {
              callbacks.onStatusChange({
                status: 'CONNECTED',
                jid: normalizedJid,
                isRegistered: true,
              });
            });
        } else if (creds?.account && normalizedJid && !creds.registered) {
          // Post-pairing 515 reconnect: `creds.account` is present, and Baileys is now finishing
          // `uploadPreKeysToServerIfRequired()` + `sendPassiveIq('active')`.
          this.connectionState = 'AUTHENTICATING';
          callbacks.onStatusChange({
            status: 'AUTHENTICATING',
            jid: normalizedJid,
            isRegistered: true,
          });

          void (async () => {
            try {
              if (typeof sock.uploadPreKeysToServerIfRequired === 'function') {
                await sock.uploadPreKeysToServerIfRequired();
              }
              if (typeof sock.sendPassiveIq === 'function') {
                await sock.sendPassiveIq('active');
              }
            } catch (preKeyErr) {
              log.warn('Post-pairing PreKey upload or active IQ warning', {
                sessionId: this.sessionId,
                error:
                  preKeyErr instanceof Error ? preKeyErr.message : String(preKeyErr),
              });
            }

            // Wait up to 1500ms for Baileys internal `creds.update({ registered: true })`
            const deadline = Date.now() + 1500;
            while (
              Date.now() < deadline &&
              this.wsOpen &&
              this.sock === sock &&
              !sock.authState?.creds?.registered
            ) {
              await new Promise((r) => setTimeout(r, 100));
            }

            if (this.wsOpen && this.sock === sock) {
              if (sock.authState?.creds && !sock.authState.creds.registered) {
                sock.authState.creds.registered = true;
              }
              await enqueueSaveCreds();
              await this.flushAuthWrites();
              if (this.wsOpen && this.sock === sock && this.connectionState !== 'CONNECTED') {
                this.connectionState = 'CONNECTED';
                callbacks.onStatusChange({
                  status: 'CONNECTED',
                  jid: normalizedJid,
                  isRegistered: true,
                });
              }
            }
          })();
        } else {
          this.connectionState = 'AWAITING_PAIRING';
          void enqueueSaveCreds()
            .then(() => this.flushAuthWrites())
            .then(() => {
              callbacks.onStatusChange({
                status: 'AWAITING_PAIRING',
                jid: normalizedJid,
                isRegistered: false,
              });
            });
        }
      } else if (connection === 'close') {
        this.wsOpen = false;
        this.handshakeReady = false;
        this.connectionState = 'CLOSED';
        this.verifiedRecipientJids.clear();

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || 'Connection closed';
        const errData = (
          lastDisconnect?.error as { data?: Record<string, unknown> } | undefined
        )?.data;

        if (statusCode === 405) {
          invalidateWhatsAppWebVersionCache();
        }

        const arabicDisconnectReason = describeDisconnectReasonArabic(
          statusCode,
          errMsg,
          errData
        );
        const technicalDetail = `${errMsg} (statusCode=${statusCode ?? 'none'}, location=${String(errData?.location ?? 'none')}, waVersion=${this.resolvedWaVersion?.join('.') ?? 'unknown'})`;

        log.warn('WhatsApp socket connection closed', {
          sessionId: this.sessionId,
          statusCode,
          errMsg,
          location: errData?.location,
          waVersion: this.resolvedWaVersion?.join('.'),
        });

        const closeError = new WhatsAppConnectionError(
          arabicDisconnectReason,
          technicalDetail
        );
        this.lastCloseError = closeError;
        this.lastCloseStatusCode = statusCode;
        this.rejectHandshakeWaiters(closeError);

        const isRegistered = Boolean(
          sock.authState?.creds?.registered || sock.authState?.creds?.account
        );

        // Wait for all pending credential and Signal key writes (such as `pair-success` or LID session migration)
        // before notifying SessionManager so restarted sockets always read complete credentials from disk.
        void Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]).finally(
          () => {
            if (statusCode === DisconnectReason.loggedOut) {
              callbacks.onStatusChange({
                status: 'LOGGED_OUT',
                statusCode,
                errorMessage: arabicDisconnectReason,
                isRegistered: false,
              });
            } else if (statusCode === DisconnectReason.restartRequired) {
              callbacks.onStatusChange({
                status: 'RESTART_REQUIRED',
                statusCode,
                errorMessage: arabicDisconnectReason,
                isRegistered: true,
              });
            } else {
              callbacks.onStatusChange({
                status: 'DISCONNECTED',
                statusCode,
                errorMessage: arabicDisconnectReason,
                isRegistered,
              });
            }
          }
        );
      }
    };

    const messagesUpdateListener = (
      updates: Array<{
        key?: { id?: string | null; remoteJid?: string | null };
        update?: { status?: number };
      }>
    ) => {
      if (!this.messageSender || !Array.isArray(updates)) return;
      for (const u of updates) {
        if (u?.key?.id && typeof u?.update?.status === 'number') {
          this.messageSender.recordAckUpdate({
            sessionId: this.sessionId,
            messageId: u.key.id,
            statusNumber: u.update.status,
          });
        }
      }
    };

    const receiptUpdateListener = (
      updates: Array<{
        key?: { id?: string | null; remoteJid?: string | null };
        receipt?: {
          readTimestamp?: unknown;
          playedTimestamp?: unknown;
          receiptTimestamp?: unknown;
        };
      }>
    ) => {
      if (!this.messageSender || !Array.isArray(updates)) return;
      for (const r of updates) {
        if (!r?.key?.id || !r?.receipt) continue;
        const receiptType = r.receipt.readTimestamp
          ? 'read'
          : r.receipt.playedTimestamp
            ? 'played'
            : 'delivery';
        this.messageSender.recordAckUpdate({
          sessionId: this.sessionId,
          messageId: r.key.id,
          receiptType,
        });
      }
    };

    sock.ev.on('creds.update', credsListener);
    sock.ev.on('connection.update', connectionListener);
    sock.ev.on('messages.update', messagesUpdateListener);
    sock.ev.on('message-receipt.update', receiptUpdateListener);

    this.evCleanup = () => {
      unbindStore();
      try {
        sock.ev.off('creds.update', credsListener);
        sock.ev.off('connection.update', connectionListener);
        sock.ev.off('messages.update', messagesUpdateListener);
        sock.ev.off('message-receipt.update', receiptUpdateListener);
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
      if (this.lastCloseError) throw this.lastCloseError;
      throw new WhatsAppConnectionError(
        'انغلق مقبس واتساب قبل إرسال طلب رمز الربط.'
      );
    }

    let iqErrorNode: { code?: string; text?: string } | null = null;
    const onIqError = (node: {
      attrs?: Record<string, string>;
      content?: Array<{ tag?: string; attrs?: Record<string, string> }>;
    }) => {
      const errChild = Array.isArray(node?.content)
        ? node.content.find((c) => c?.tag === 'error')
        : undefined;
      iqErrorNode = {
        code: errChild?.attrs?.code || node?.attrs?.code,
        text: errChild?.attrs?.text || 'IQ error on companion_hello',
      };
    };

    try {
      sock.ws?.on?.('CB:iq,type:error', onIqError);
    } catch {
      // Ignore if ws wrapper does not expose event listener
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
      // Wait briefly to catch immediate IQ error stanzas or socket disconnects on `companion_hello`
      await new Promise((r) => setTimeout(r, 150));
    } catch (firstErr) {
      if (firstErr instanceof AppError) throw firstErr;
      const safe = toSafeArabicError(firstErr);
      throw new WhatsAppConnectionError(
        `تعذر استلام رمز الربط من واتساب: ${safe.userMessage}`,
        safe.sanitizedTechnicalMessage
      );
    } finally {
      try {
        sock.ws?.off?.('CB:iq,type:error', onIqError);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (iqErrorNode) {
      const codeInfo = iqErrorNode as { code?: string; text?: string };
      throw new WhatsAppConnectionError(
        `رفض خادم واتساب طلب ربط الجهاز (${codeInfo.code || codeInfo.text || 'خطأ بروتوكول'}).`,
        `IQ Error: code=${codeInfo.code ?? 'unknown'} text=${codeInfo.text ?? 'none'}`
      );
    }

    const currentConnectionState: string = this.connectionState;
    if (!this.sock || currentConnectionState === 'CLOSED' || !this.wsOpen) {
      if (this.lastCloseError) throw this.lastCloseError;
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

  private async simulateHumanPresenceBeforeSend(
    sock: WASocket,
    resolvedJid: string,
    textLengthHint = 20
  ): Promise<void> {
    if (!resolvedJid || resolvedJid.endsWith('@newsletter')) {
      return;
    }
    try {
      if (resolvedJid.endsWith('@s.whatsapp.net')) {
        await sock.presenceSubscribe(resolvedJid).catch(() => undefined);
      }
      await sock.sendPresenceUpdate('composing', resolvedJid).catch(() => undefined);
      const baseMs = Math.min(800, Math.max(250, textLengthHint * 8));
      const jitterMs = Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, baseMs + jitterMs));
      await sock.sendPresenceUpdate('paused', resolvedJid).catch(() => undefined);
    } catch {
      // Never block message sending if presence update fails
    }
  }

  public async sendTextMessage(
    recipientJid: string,
    text: string
  ): Promise<{ messageId: string }> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً لإرسال الرسائل.');
    }
    const resolvedJid = await this.resolveDirectRecipientJid(sock, recipientJid);
    await this.simulateHumanPresenceBeforeSend(sock, resolvedJid, text.length);
    const res = await sock.sendMessage(resolvedJid, { text });
    const msgId = res?.key?.id || `msg_${Date.now()}`;
    if (res?.message) {
      this.memoryStore.cacheSentMessage(resolvedJid, msgId, res.message);
    }
    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
    return { messageId: msgId };
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

    const resolvedJid = await this.resolveDirectRecipientJid(
      sock,
      params.recipientJid
    );
    await this.simulateHumanPresenceBeforeSend(
      sock,
      resolvedJid,
      params.caption?.length ?? 30
    );
    const res = await sock.sendMessage(resolvedJid, content);
    const msgId = res?.key?.id || `media_${Date.now()}`;
    if (res?.message) {
      this.memoryStore.cacheSentMessage(resolvedJid, msgId, res.message);
    }
    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
    return { messageId: msgId };
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
    if (params.executionMode === 'DRY_RUN' || params.executionMode === 'SIMULATION') {
      return runSandboxedTestFunction(this.sessionId, params, {
        sendMessage: async () => undefined,
        relayMessage: async () => undefined,
        presenceSubscribe: async () => undefined,
        sendPresenceUpdate: async () => undefined,
      });
    }
    const sock = this.ensureSocket();
    const flushAfterIteration = async () => {
      await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
    };

    try {
      return await runSandboxedTestFunction(this.sessionId, params, {
        raw: sock as unknown as Record<string, unknown>,
        afterIterationFlush: flushAfterIteration,
        sendMessage: async (targetJid, message, options) => {
          const resolvedJid = await this.resolveDirectRecipientJid(sock, targetJid);
          const res = await sock.sendMessage(resolvedJid, message, options);
          const msgId =
            res?.key?.id ||
            (typeof options?.messageId === 'string'
              ? options.messageId
              : `flab_${Date.now()}`);
          if (res?.message) {
            this.memoryStore.cacheSentMessage(resolvedJid, msgId, res.message);
          }
          return res;
        },
        relayMessage: async (targetJid, messageObj, opts = {}) => {
          const resolvedJid = await this.resolveDirectRecipientJid(sock, targetJid);
          const msgId =
            typeof opts?.messageId === 'string' && opts.messageId.trim()
              ? opts.messageId.trim()
              : SmartProtocolWrapper.generateStandardMessageId(sock.user?.id);
          const relayOpts = { ...opts, messageId: msgId };
          // Cache outgoing message BEFORE and AFTER relay so retry receipts (`getMessage`) can always re-encrypt!
          if (messageObj && typeof messageObj === 'object') {
            this.memoryStore.cacheSentMessage(resolvedJid, msgId, messageObj);
          }
          return await sock.relayMessage(resolvedJid, messageObj, relayOpts);
        },
        presenceSubscribe: async (targetJid) => {
          await sock.presenceSubscribe(targetJid);
        },
        sendPresenceUpdate: async (state, targetJid) => {
          await sock.sendPresenceUpdate(state, targetJid);
        },
      });
    } finally {
      await flushAfterIteration();
    }
  }

  public async disconnect(): Promise<void> {
    const wasOpen = this.wsOpen;
    this.wsOpen = false;
    this.handshakeReady = false;
    this.connectionState = 'CLOSED';
    this.verifiedRecipientJids.clear();
    this.rejectHandshakeWaiters(
      new WhatsAppConnectionError('تم إغلاق مقبس واتساب.')
    );
    if (this.evCleanup) {
      this.evCleanup();
      this.evCleanup = null;
    }
    if (this.sock) {
      if (wasOpen && typeof this.sock.sendPresenceUpdate === 'function') {
        await this.sock.sendPresenceUpdate('unavailable').catch(() => undefined);
      }
      try {
        this.sock.end(undefined);
      } catch {
        // Ignore socket close error
      }
      this.sock = null;
    }
    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
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
  public simulatedCloseStatusCodeBeforeReady: number | null = null;
  public pairingCodeRequestCount = 0;
  public lastRequestedPhoneDigits: string | null = null;
  private lastCloseError: WhatsAppConnectionError | null = null;

  private readonly messageSender?: MessageSender;

  constructor(
    public readonly sessionId: string,
    initialPhoneOrSender:
      | string
      | MessageSender
      | { messageSender?: MessageSender; initialPhoneDigits?: string } = '966501234567',
    options?: { messageSender?: MessageSender }
  ) {
    let initialPhoneDigits = '966501234567';
    if (typeof initialPhoneOrSender === 'string') {
      initialPhoneDigits = initialPhoneOrSender;
      this.messageSender = options?.messageSender;
    } else if (initialPhoneOrSender instanceof MessageSender) {
      this.messageSender = initialPhoneOrSender;
    } else if (initialPhoneOrSender && typeof initialPhoneOrSender === 'object') {
      this.messageSender = initialPhoneOrSender.messageSender;
      if (initialPhoneOrSender.initialPhoneDigits) {
        initialPhoneDigits = initialPhoneOrSender.initialPhoneDigits;
      }
    }
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
    this.lastCloseError = null;
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

    if (this.simulatedCloseStatusCodeBeforeReady !== null) {
      const code = this.simulatedCloseStatusCodeBeforeReady;
      this.socketOpen = false;
      this.handshakeComplete = false;
      this.connected = false;
      this.connectionState = 'CLOSED';
      const arabicMsg = describeDisconnectReasonArabic(code, 'Connection Failure', {
        reason: String(code),
        location: 'vll',
      });
      this.lastCloseError = new WhatsAppConnectionError(
        arabicMsg,
        `Connection Failure (statusCode=${code}, location=vll)`
      );
      callbacks.onStatusChange({
        status: 'DISCONNECTED',
        statusCode: code,
        errorMessage: arabicMsg,
        isRegistered: this.registered,
      });
      return;
    }

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
    if (this.lastCloseError) {
      throw this.lastCloseError;
    }
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
    const isOfflineSafeMode =
      params.executionMode === 'DRY_RUN' || params.executionMode === 'SIMULATION';
    if (!isOfflineSafeMode && (!this.connected || !this.registered)) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    return runSandboxedTestFunction(
      this.sessionId,
      {
        ...params,
        delayMs: params.delayMs ?? this.simulatedDelayMs,
      },
      {
        raw: {
          user: { id: this.currentJid, name: `Mock (${this.sessionId})` },
          groupMetadata: async (jid: string) => this.getGroupMetadata(jid),
          groupFetchAllParticipating: async () => {
            const obj: Record<string, GroupSummary> = {};
            for (const [k, v] of this.simulatedGroups.entries()) {
              obj[k] = v;
            }
            return obj;
          },
          groupParticipantsUpdate: async (
            jid: string,
            participants: string[],
            action: ParticipantAction
          ) => {
            await this.updateGroupParticipants(jid, participants, action);
            return participants.map((p) => ({ status: '200', jid: p }));
          },
          groupInviteCode: async (jid: string) => this.getGroupInviteCode(jid),
          groupAcceptInvite: async (code: string) => this.acceptGroupInvite(code),
          newsletterMetadata: async (_type: string, key: string) =>
            this.getChannelMetadata(key),
          onWhatsApp: async (...jids: string[]) =>
            jids.map((j) => ({
              jid: j.includes('@') ? j : `${j.replace(/\D/g, '')}@s.whatsapp.net`,
              exists: true,
            })),
          fetchStatus: async (jid: string) => ({
            status: 'متاح عبر Botezz Function Lab',
            setAt: new Date(),
            jid,
          }),
          profilePictureUrl: async (jid: string) =>
            `https://pps.whatsapp.net/v/mock_${jid.split('@')[0]}.jpg`,
          updateProfileStatus: async () => undefined,
        },
        sendMessage: async (targetJid, _message) => {
          if (this.shouldFailSend) {
            throw new WhatsAppConnectionError('رفض الإرسال من الجلسة في وضع الاختبار.');
          }
          if (!isOfflineSafeMode) {
            this.sentMessagesCount++;
          }
          return { key: { remoteJid: targetJid, id: `sim_tf_${Date.now()}` } };
        },
        relayMessage: async (_targetJid, _messageObj) => {
          if (this.shouldFailSend) {
            throw new WhatsAppConnectionError('رفض تمرير العقدة (relayMessage) في وضع الاختبار.');
          }
          if (!isOfflineSafeMode) {
            this.sentMessagesCount++;
          }
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

