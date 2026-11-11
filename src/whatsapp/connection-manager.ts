import fs from 'node:fs';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  jidDecode,
  jidNormalizedUser,
  areJidsSameUser,
  proto,
  WASocket,
  ConnectionState,
  GroupMetadata,
  ParticipantAction,
  AnyMessageContent,
  WAMessageKey,
  WAPresence,
  PresenceData,
  WABusinessProfile,
  generateForwardMessageContent,
  generateWAMessageFromContent,
  S_WHATSAPP_NET,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  toCompatibleWhatsAppSocket,
  CompatibleWhatsAppSocket,
} from './baileys-compat';

export interface BinaryNode {
  tag: string;
  attrs: Record<string, string>;
  content?: BinaryNode[] | Uint8Array | string;
  [key: string]: unknown;
}
import { createAtomicMultiFileAuthState } from './atomic-auth-state';
import {
  SupportedMediaKind,
  validateCustomPairingCode,
  generateRandomPairingCode,
  normalizePhoneNumber,
  validateRecipient,
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

export interface PresenceStateTransition {
  state: WAPresence;
  timestampMs: number;
  participantJid: string;
}

export interface TrackedPresenceRecord {
  chatJid: string;
  resolvedLid?: string;
  currentState: WAPresence;
  lastSeenTimestampSec?: number;
  lastUpdatedMs: number;
  transitions: PresenceStateTransition[];
  totalOnlineDurationMs: number;
  onlineSessionStartedAtMs?: number;
}

export interface WhatsAppFullProfileReport {
  queriedInput: string;
  existsOnWhatsApp: boolean;
  pnJid: string;
  e164Phone: string;
  lidJid?: string;
  pushName?: string;
  verifiedName?: string;
  statusText?: string;
  statusSetAt?: string;
  pictureId?: string;
  profilePicture: {
    hdUrl?: string;
    previewUrl?: string;
    pictureId?: string;
    status: 'AVAILABLE' | 'PRIVACY_HIDDEN' | 'NO_PICTURE' | 'ERROR';
    statusReasonArabic: string;
    imageBuffer?: Buffer;
  };
  disappearingMode?: {
    durationSeconds: number;
    setAtIso?: string;
  };
  presence: {
    currentState: WAPresence | 'unknown';
    lastSeenIso?: string;
  };
  devices: {
    totalCount: number;
    primaryDevice: number[];
    companionDevices: number[];
    deviceListFormatted: string[];
  };
  businessProfile?: {
    isBusiness: boolean;
    category?: string;
    description?: string;
    email?: string;
    website?: string[];
    address?: string;
    latitude?: number;
    longitude?: number;
    timezone?: string;
    businessHoursSummary?: string[];
  };
  sharedGroups: Array<{
    groupJid: string;
    subject: string;
    role: 'superadmin' | 'admin' | 'member';
  }>;
  fetchedAtIso: string;
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
  sendNode?: (node: BinaryNode) => Promise<void>;
  query?: (node: BinaryNode, timeoutMs?: number) => Promise<unknown>;
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
 * SmartProtocolWrapper integration, and Proxy-based access to all underlying `@hiroosy/baileys-lite` socket methods.
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
 * Ensures both `HiroosyBaileysSessionDriver` and `MockWhatsAppSessionDriver` share the exact
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
  public readonly presences = new Map<string, TrackedPresenceRecord>();
  public readonly lidToPnMap = new Map<string, string>();
  public readonly pnToLidMap = new Map<string, string>();
  private readonly presenceListeners = new Map<
    string,
    Set<(record: TrackedPresenceRecord) => void>
  >();
  private readonly messageByKey = new Map<string, proto.IMessage>();
  private readonly normalizer = new MessageNormalizer();

  public recordLidMapping(lidRaw?: string | null, pnRaw?: string | null): void {
    if (!lidRaw || !pnRaw) return;
    try {
      const lid = jidNormalizedUser(lidRaw);
      const pn = jidNormalizedUser(pnRaw);
      if (!lid.endsWith('@lid') || !pn.endsWith('@s.whatsapp.net')) return;
      this.lidToPnMap.set(lid, pn);
      this.pnToLidMap.set(pn, lid);
      const pnRecord = this.presences.get(pn);
      if (pnRecord && !pnRecord.resolvedLid) {
        pnRecord.resolvedLid = lid;
      }
      const lidRecord = this.presences.get(lid);
      if (lidRecord && !pnRecord) {
        this.presences.set(pn, {
          ...lidRecord,
          chatJid: pn,
          resolvedLid: lid,
          transitions: [...lidRecord.transitions],
        });
      }
    } catch {
      // Ignore invalid JID format
    }
  }

  public getLidForPn(pnRaw: string): string | undefined {
    try {
      return this.pnToLidMap.get(jidNormalizedUser(pnRaw));
    } catch {
      return undefined;
    }
  }

  public getPnForLid(lidRaw: string): string | undefined {
    try {
      return this.lidToPnMap.get(jidNormalizedUser(lidRaw));
    } catch {
      return undefined;
    }
  }

  public onPresenceChange(
    jid: string,
    listener: (record: TrackedPresenceRecord) => void
  ): () => void {
    const norm = jidNormalizedUser(jid);
    let set = this.presenceListeners.get(norm);
    if (!set) {
      set = new Set();
      this.presenceListeners.set(norm, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.presenceListeners.delete(norm);
      }
    };
  }

  public applyPresenceTransition(params: {
    chatJid: string;
    participantJid: string;
    state: WAPresence;
    lastSeen?: number;
    timestampMs?: number;
  }): TrackedPresenceRecord {
    const now = params.timestampMs ?? Date.now();
    const rawChat = jidNormalizedUser(params.chatJid);
    const rawParticipant = jidNormalizedUser(params.participantJid || params.chatJid);

    const mappedPn = rawChat.endsWith('@lid')
      ? this.lidToPnMap.get(rawChat)
      : rawParticipant.endsWith('@lid')
        ? this.lidToPnMap.get(rawParticipant)
        : undefined;
    const mappedLid = rawChat.endsWith('@lid')
      ? rawChat
      : rawParticipant.endsWith('@lid')
        ? rawParticipant
        : this.pnToLidMap.get(rawChat);

    const primaryChatJid = mappedPn || rawChat;
    const existing = this.presences.get(primaryChatJid) ||
      (mappedLid ? this.presences.get(mappedLid) : undefined) || {
        chatJid: primaryChatJid,
        resolvedLid: mappedLid,
        currentState: 'unavailable' as WAPresence,
        lastUpdatedMs: now,
        transitions: [],
        totalOnlineDurationMs: 0,
      };

    const isOnlineState =
      params.state === 'available' ||
      params.state === 'composing' ||
      params.state === 'recording';

    let totalOnlineDurationMs = existing.totalOnlineDurationMs;
    let onlineSessionStartedAtMs = existing.onlineSessionStartedAtMs;

    if (isOnlineState) {
      if (onlineSessionStartedAtMs === undefined) {
        onlineSessionStartedAtMs = now;
      }
    } else if (params.state === 'unavailable') {
      if (onlineSessionStartedAtMs !== undefined) {
        totalOnlineDurationMs += Math.max(0, now - onlineSessionStartedAtMs);
        onlineSessionStartedAtMs = undefined;
      }
    }

    const transitions = [...existing.transitions];
    const lastTransition = transitions[transitions.length - 1];
    if (!lastTransition || lastTransition.state !== params.state) {
      transitions.push({
        state: params.state,
        timestampMs: now,
        participantJid: rawParticipant,
      });
      if (transitions.length > 50) {
        transitions.shift();
      }
    }

    const updated: TrackedPresenceRecord = {
      chatJid: primaryChatJid,
      resolvedLid: mappedLid || existing.resolvedLid,
      currentState: params.state,
      lastSeenTimestampSec:
        typeof params.lastSeen === 'number' && params.lastSeen > 0
          ? params.lastSeen
          : existing.lastSeenTimestampSec,
      lastUpdatedMs: now,
      transitions,
      totalOnlineDurationMs,
      onlineSessionStartedAtMs,
    };

    this.presences.set(primaryChatJid, updated);
    if (updated.resolvedLid) {
      this.presences.set(updated.resolvedLid, updated);
    }

    const notifyTargets = new Set<string>([primaryChatJid, rawChat, rawParticipant]);
    if (updated.resolvedLid) notifyTargets.add(updated.resolvedLid);
    for (const targetKey of notifyTargets) {
      const listeners = this.presenceListeners.get(targetKey);
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(updated);
          } catch {
            // Ignore listener errors
          }
        }
      }
    }

    return updated;
  }

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
   * Caches an outgoing or incoming `proto.IMessage` so `@hiroosy/baileys-lite` `sendMessagesAgain`
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
        key?: {
          remoteJid?: string | null;
          id?: string | null;
          remoteJidAlt?: string | null;
          participant?: string | null;
          participantAlt?: string | null;
        };
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

        if (msg?.key?.remoteJid && msg?.key?.remoteJidAlt) {
          if (msg.key.remoteJid.endsWith('@lid')) {
            this.recordLidMapping(msg.key.remoteJid, msg.key.remoteJidAlt);
          } else if (msg.key.remoteJidAlt.endsWith('@lid')) {
            this.recordLidMapping(msg.key.remoteJidAlt, msg.key.remoteJid);
          }
        }
        if (msg?.key?.participant && msg?.key?.participantAlt) {
          if (msg.key.participant.endsWith('@lid')) {
            this.recordLidMapping(msg.key.participant, msg.key.participantAlt);
          } else if (msg.key.participantAlt.endsWith('@lid')) {
            this.recordLidMapping(msg.key.participantAlt, msg.key.participant);
          }
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

    const upsertChatsList = (newChats?: Array<{ id: string; [key: string]: unknown }>) => {
      if (!Array.isArray(newChats)) return;
      for (const chat of newChats) {
        if (chat?.id) {
          const prev = this.chats.get(chat.id) || {};
          this.chats.set(chat.id, { ...prev, ...chat });
        }
      }
    };

    const recordContactLidIfPresent = (cObj: Record<string, unknown>, fallbackId?: string) => {
      const idStr = typeof cObj.id === 'string' ? cObj.id : fallbackId;
      const lidStr = typeof cObj.lid === 'string' ? cObj.lid : undefined;
      const pnStr = typeof cObj.phoneNumber === 'string' ? cObj.phoneNumber : undefined;
      if (idStr && lidStr && idStr.endsWith('@s.whatsapp.net')) {
        this.recordLidMapping(lidStr, idStr);
      } else if (idStr && pnStr && idStr.endsWith('@lid')) {
        this.recordLidMapping(idStr, pnStr);
      } else if (lidStr && pnStr) {
        this.recordLidMapping(lidStr, pnStr);
      }
    };

    const upsertContactsPayload = (
      newContacts?:
        | Record<string, unknown>
        | Array<{ id?: string; [key: string]: unknown }>
    ) => {
      if (!newContacts || typeof newContacts !== 'object') return;
      if (Array.isArray(newContacts)) {
        for (const contact of newContacts) {
          if (contact && typeof contact.id === 'string' && contact.id) {
            recordContactLidIfPresent(contact, contact.id);
            const prev =
              (this.contacts.get(contact.id) as Record<string, unknown> | undefined) ||
              {};
            this.contacts.set(contact.id, { ...prev, ...contact });
          }
        }
        return;
      }
      for (const [id, contact] of Object.entries(newContacts)) {
        if (contact && typeof contact === 'object' && 'id' in contact) {
          const cObj = contact as { id?: string; [key: string]: unknown };
          const key = typeof cObj.id === 'string' && cObj.id ? cObj.id : id;
          recordContactLidIfPresent(cObj, key);
          const prev =
            (this.contacts.get(key) as Record<string, unknown> | undefined) || {};
          this.contacts.set(key, { ...prev, ...cObj });
        } else {
          this.contacts.set(id, contact);
        }
      }
    };

    const onChatsSet = ({ chats: newChats }: { chats: Array<{ id: string }> }) => {
      upsertChatsList(newChats);
    };

    const onChatsUpsert = (newChats: Array<{ id: string }>) => {
      upsertChatsList(newChats);
    };

    const onContactsSet = ({
      contacts: newContacts,
    }: {
      contacts: Record<string, unknown> | Array<{ id?: string; [key: string]: unknown }>;
    }) => {
      upsertContactsPayload(newContacts);
    };

    const onContactsUpsert = (
      newContacts: Array<{ id?: string; [key: string]: unknown }>
    ) => {
      upsertContactsPayload(newContacts);
    };

    const onContactsUpdate = (
      updates: Array<{ id?: string; [key: string]: unknown }>
    ) => {
      upsertContactsPayload(updates);
    };

    const onMessagingHistorySet = (payload: {
      chats?: Array<{ id: string; [key: string]: unknown }>;
      contacts?: Array<{ id?: string; [key: string]: unknown }>;
      messages?: Parameters<typeof onMessagesUpsert>[0]['messages'];
    }) => {
      if (payload?.chats) {
        upsertChatsList(payload.chats);
      }
      if (payload?.contacts) {
        upsertContactsPayload(payload.contacts);
      }
      if (Array.isArray(payload?.messages) && payload.messages.length > 0) {
        onMessagesUpsert({ messages: payload.messages, type: 'append' });
      }
    };

    const onLidMappingUpdate = (mapping: { lid?: string; pn?: string }) => {
      if (mapping?.lid && mapping?.pn) {
        this.recordLidMapping(mapping.lid, mapping.pn);
      }
    };

    const onPresenceUpdate = (update: {
      id: string;
      presences: { [participant: string]: PresenceData };
    }) => {
      if (!update?.id || !update?.presences || typeof update.presences !== 'object') {
        return;
      }
      for (const [participant, pData] of Object.entries(update.presences)) {
        const state = pData?.lastKnownPresence || 'unavailable';
        this.applyPresenceTransition({
          chatJid: update.id,
          participantJid: participant || update.id,
          state,
          lastSeen: pData?.lastSeen,
        });
      }
    };

    ev.on('messages.upsert', onMessagesUpsert);
    ev.on('chats.set', onChatsSet);
    ev.on('chats.upsert', onChatsUpsert);
    ev.on('contacts.set', onContactsSet);
    ev.on('contacts.upsert', onContactsUpsert);
    ev.on('contacts.update', onContactsUpdate);
    ev.on('messaging-history.set', onMessagingHistorySet);
    ev.on('lid-mapping.update', onLidMappingUpdate);
    ev.on('presence.update', onPresenceUpdate);

    return () => {
      try {
        ev.off('messages.upsert', onMessagesUpsert);
        ev.off('chats.set', onChatsSet);
        ev.off('chats.upsert', onChatsUpsert);
        ev.off('contacts.set', onContactsSet);
        ev.off('contacts.upsert', onContactsUpsert);
        ev.off('contacts.update', onContactsUpdate);
        ev.off('messaging-history.set', onMessagingHistorySet);
        ev.off('lid-mapping.update', onLidMappingUpdate);
        ev.off('presence.update', onPresenceUpdate);
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
  onIncomingMessage?: (params: {
    sessionId: string;
    rawMessage: Record<string, unknown>;
    sock?: WASocket;
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
    ptv?: boolean;
    gifPlayback?: boolean;
  }): Promise<{ messageId: string }>;
  sendNode?(node: BinaryNode): Promise<void>;
  query?(node: BinaryNode, timeoutMs?: number): Promise<unknown>;
  recordSimulatedVoipCallOffer?(
    targetJid: string,
    options?: { callId?: string; isVideo?: boolean }
  ): Promise<{ callId: string }>;
  recordSimulatedVoipCallTermination?(
    targetJid: string,
    callId: string
  ): Promise<void>;
  forwardMessage(
    targetJid: string,
    messagePayloadOrRaw: Record<string, unknown>,
    options?: { forceForward?: boolean }
  ): Promise<{ messageId: string; forwarded: boolean }>;
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
    state: WAPresence,
    jid: string
  ): Promise<void>;
  resolveLidForRecipient(targetInput: string): Promise<{
    pnJid?: string;
    lidJid: string;
    source:
      | 'DIRECT_LID'
      | 'LID_MAPPING_STORE'
      | 'ON_WHATSAPP_USYNC'
      | 'GROUP_PARTICIPANT_CACHE';
  }>;
  sendAnonymousLidMessage(params: {
    recipient: string;
    text: string;
    customPushName?: string;
  }): Promise<{
    messageId: string;
    targetLid: string;
    resolvedPn?: string;
    resolutionSource: string;
  }>;
  trackRecipientPresence(params: {
    recipient: string;
    durationSeconds: number;
    onUpdate?: (record: TrackedPresenceRecord) => void;
    staleComposingTimeoutMs?: number;
  }): Promise<TrackedPresenceRecord>;
  startPresenceHeartbeatBroadcast(params: {
    recipient: string;
    mode: 'composing' | 'recording' | 'available';
    durationSeconds: number;
    pulseIntervalMs?: number;
  }): Promise<{
    pulsesSent: number;
    targetJid: string;
    durationMs: number;
  }>;
  fetchFullProfileInfo(recipient: string): Promise<WhatsAppFullProfileReport>;
  sendShortEphemeralMessage(params: {
    recipient: string;
    text: string;
    expirationSeconds: number;
    triggerMode?: 'ON_SEND' | 'ON_READ';
    setChatEphemeralIq?: boolean;
  }): Promise<{
    messageId: string;
    targetJid: string;
    expirationSeconds: number;
    triggerMode: 'ON_SEND' | 'ON_READ';
    scheduledRevokeAtIso: string;
  }>;
  executeTestFunction(
    params: TestFunctionExecutionParams
  ): Promise<TestFunctionExecutionResult>;
  getCompatibleSocket?(): CompatibleWhatsAppSocket | null;
  getRawSocket?(): WASocket | null;
  disconnect(): Promise<void>;
  logout(): Promise<void>;
}

/**
 * Production Hiroosy Baileys-Lite Socket Driver (`@hiroosy/baileys-lite` v0.3.6).
 * Implements the exact socket, pairing-code (`requestPairingCode(phoneNumber, code)`),
 * Noise + `pair-device` handshake synchronization, serialized credential persistence,
 * group metadata caching (`cachedGroupMetadata`), newsletter/channel inspection (`newsletterMetadata`),
 * and LID/PN participant resolution APIs of `@hiroosy/baileys-lite`.
 */
/**
 * Minimum revision threshold above legacy static revisions (which WhatsApp servers reject with `<failure reason="405"/>`).
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
 * Resolves a live, compatible WhatsApp Web client version supported by `@hiroosy/baileys-lite`.
 *
 * Queries `fetchLatestWaWebVersion()` (`https://web.whatsapp.com/sw.js`) and `fetchLatestBaileysVersion()`
 * to extract an active `client_revision` that passes WhatsApp's handshake and emits `pair-device` (`qr`).
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

export class HiroosyBaileysSessionDriver implements WhatsAppSessionDriver {
  public readonly isMock = false;
  private sock: WASocket | null = null;
  private evCleanup: (() => void) | null = null;
  private readonly groupMetadataCache = new Map<string, GroupMetadata>();
  private readonly verifiedRecipientJids = new Set<string>();
  public readonly memoryStore = new SessionMemoryStore();
  private credsSaveChain: Promise<void> = Promise.resolve();
  private flushAuthWrites: () => Promise<void> = async () => undefined;
  private wsOpen = false;
  private authenticatedOpen = false;
  private handshakeReady = false;
  private connectGeneration = 0;
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
  public readonly ephemeralRevokeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  public readonly pendingOnReadRevokes = new Map<
    string,
    {
      targetJid: string;
      key: WAMessageKey;
      expirationSeconds: number;
      fallbackTimer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly activePresenceCleanups = new Set<() => void>();
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
   * Attaches a socket instance directly (used in deterministic protocol unit tests).
   */
  public attachSocketForTesting(sock: WASocket): () => void {
    this.sock = sock;
    this.wsOpen = true;
    this.authenticatedOpen = true;
    this.handshakeReady = true;
    this.connectionState = 'CONNECTED';
    const unbind = this.memoryStore.bind(sock.ev);
    const onReceipt = (
      updates: Array<{
        key?: { id?: string | null; remoteJid?: string | null };
        receipt?: {
          readTimestamp?: unknown;
          playedTimestamp?: unknown;
          receiptTimestamp?: unknown;
        };
      }>
    ) => {
      this.handleReceiptUpdates(updates);
    };
    const onMessagesUpdate = (
      updates: Array<{
        key?: { id?: string | null; remoteJid?: string | null };
        update?: { status?: number | string | null };
      }>
    ) => {
      this.handleMessagesUpdateForReadRevoke(updates);
    };
    sock.ev.on('message-receipt.update', onReceipt as never);
    sock.ev.on('messages.update', onMessagesUpdate as never);
    this.evCleanup = () => {
      unbind();
      try {
        sock.ev.off('message-receipt.update', onReceipt as never);
        sock.ev.off('messages.update', onMessagesUpdate as never);
      } catch {
        // Ignore
      }
    };
    return this.evCleanup;
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
    const myGen = ++this.connectGeneration;
    await this.disconnect();
    if (myGen !== this.connectGeneration) return;

    const { state, saveCreds, flushPendingWrites, recoveredFromBackup } =
      await createAtomicMultiFileAuthState(this.authDir);
    if (myGen !== this.connectGeneration) return;
    this.flushAuthWrites = flushPendingWrites;

    const resolvedVersionInfo = await resolveWhatsAppWebVersion();
    if (myGen !== this.connectGeneration) return;
    const version = resolvedVersionInfo.version;
    this.resolvedWaVersion = version;

    log.info('Initializing @hiroosy/baileys-lite socket', {
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
    this.authenticatedOpen = false;
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
      printQRInTerminal: false, // Required by @hiroosy/baileys-lite for pairing code flow
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
          // Only promote to CONNECTED when the socket has genuinely reached an authenticated `connection === 'open'`
          // (`this.authenticatedOpen === true`). During initial phone pairing (`qr`), `this.authenticatedOpen` is false,
          // preventing premature `CONNECTED` before the mandatory post-pairing 515 restart (`BZ-002`, `R-001`).
          if (
            update?.registered === true &&
            this.authenticatedOpen &&
            this.wsOpen &&
            this.sock === sock
          ) {
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
        this.authenticatedOpen = false;
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
      // CRITICAL: Do NOT mutate `creds.registered = true` or `this.authenticatedOpen = true` here!
      // Baileys emits 515 (`restartRequired`) right after `companion_finish`, and only the post-515
      // socket's `connection === 'open'` represents an authenticated live session.
      if (isNewLogin) {
        this.authenticatedOpen = false;
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
          this.authenticatedOpen = true;
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
          this.authenticatedOpen = true;
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
          this.authenticatedOpen = false;
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
        this.authenticatedOpen = false;
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

    const rawStanzaMetaByMsgId = new Map<
      string,
      {
        rawFrom?: string;
        rawParticipant?: string;
        senderPn?: string;
        senderLid?: string;
        addressingMode?: string;
        notify?: string;
        encType?: string;
        encVersion?: string;
        retryCount?: number;
        offline?: boolean;
      }
    >();

    const rawMessageStanzaListener = (node: {
      attrs?: Record<string, string | undefined>;
      content?: unknown;
    }) => {
      try {
        const attrs = node?.attrs || {};
        const msgId = attrs.id;
        if (!msgId) return;
        let encType: string | undefined;
        let encVersion: string | undefined;
        let retryCount: number | undefined;
        if (Array.isArray(node?.content)) {
          for (const child of node.content as Array<{
            tag?: string;
            attrs?: Record<string, string | undefined>;
          }>) {
            if (child?.tag === 'enc' && child.attrs) {
              encType = child.attrs.type || encType;
              encVersion = child.attrs.v || encVersion;
              if (child.attrs.count) {
                retryCount = Number(child.attrs.count) || 0;
              }
            }
          }
        }
        rawStanzaMetaByMsgId.set(msgId, {
          rawFrom: attrs.from,
          rawParticipant: attrs.participant,
          senderPn:
            attrs.sender_pn || attrs.participant_pn || attrs.peer_recipient_pn,
          senderLid:
            attrs.sender_lid ||
            attrs.participant_lid ||
            attrs.peer_recipient_lid,
          addressingMode: attrs.addressing_mode,
          notify: attrs.notify,
          encType,
          encVersion,
          retryCount,
          offline: Boolean(attrs.offline),
        });
        if (rawStanzaMetaByMsgId.size > 500) {
          const oldest = rawStanzaMetaByMsgId.keys().next().value;
          if (oldest) rawStanzaMetaByMsgId.delete(oldest);
        }
      } catch {
        // Never allow stanza metadata inspection to disrupt socket pipeline
      }
    };

    const wsEmitter = (
      sock as unknown as {
        ws?: {
          on?: (event: string, cb: (node: unknown) => void) => void;
          off?: (event: string, cb: (node: unknown) => void) => void;
        };
      }
    ).ws;
    if (typeof wsEmitter?.on === 'function') {
      wsEmitter.on('CB:message', rawMessageStanzaListener as never);
    }

    const messagesUpdateListener = (
      updates: Array<{
        key?: {
          id?: string | null;
          remoteJid?: string | null;
          fromMe?: boolean | null;
          participant?: string | null;
          remoteJidAlt?: string | null;
          participantAlt?: string | null;
        };
        update?: {
          status?: number | string | null;
          message?: Record<string, unknown> | null;
          messageTimestamp?: number;
        };
      }>
    ) => {
      if (!Array.isArray(updates)) return;
      for (const u of updates) {
        if (this.messageSender && u?.key?.id && typeof u?.update?.status === 'number') {
          this.messageSender.recordAckUpdate({
            sessionId: this.sessionId,
            messageId: u.key.id,
            statusNumber: u.update.status,
          });
        }
        if (u?.key?.id && u?.update?.status !== undefined && u?.update?.status !== null) {
          this.handleMessagesUpdateForReadRevoke([u]);
        }
        // Forward live message edits (emitted by @hiroosy/baileys-lite on messages.update)
        if (
          callbacks.onIncomingMessage &&
          u?.key?.id &&
          u?.key?.remoteJid &&
          u?.update?.message &&
          typeof u.update.message === 'object'
        ) {
          try {
            const targetId = String(u.key.id);
            const rawMeta = rawStanzaMetaByMsgId.get(targetId);
            callbacks.onIncomingMessage({
              sessionId: this.sessionId,
              rawMessage: {
                key: {
                  ...u.key,
                  id: targetId,
                },
                message: u.update.message,
                messageTimestamp:
                  u.update.messageTimestamp || Math.floor(Date.now() / 1000),
                __isLiveEditUpdate: true,
                __editedTargetId: targetId,
                ...(rawMeta ? { __rawStanzaMeta: rawMeta } : {}),
              },
              sock,
            });
          } catch (err) {
            log.warn('Error forwarding live message edit from messages.update', {
              sessionId: this.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
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
      this.handleReceiptUpdates(updates);
    };

    const incomingMessagesUpsertListener = ({
      messages: newMessages,
    }: {
      messages: Array<Record<string, unknown>>;
      type: string;
    }) => {
      if (!callbacks.onIncomingMessage || !Array.isArray(newMessages)) return;
      for (const msg of newMessages) {
        try {
          const msgKey = (msg?.key || {}) as {
            id?: string;
            remoteJid?: string;
            participant?: string;
            remoteJidAlt?: string;
            participantAlt?: string;
          };
          const msgId = String(msgKey.id || '');
          const rawMeta = msgId ? rawStanzaMetaByMsgId.get(msgId) : undefined;
          const lookupJids = [
            msgKey.participant,
            msgKey.participantAlt,
            msgKey.remoteJid,
            msgKey.remoteJidAlt,
            rawMeta?.senderPn,
            rawMeta?.rawParticipant,
            rawMeta?.rawFrom,
          ].filter((j): j is string => typeof j === 'string' && j.length > 0);

          let contactInfo: Record<string, unknown> | undefined;
          for (const candidateJid of lookupJids) {
            const normJid = jidNormalizedUser(candidateJid);
            const found =
              (this.memoryStore.contacts.get(normJid) as
                | Record<string, unknown>
                | undefined) ||
              (this.memoryStore.contacts.get(candidateJid) as
                | Record<string, unknown>
                | undefined);
            if (found) {
              contactInfo = found;
              break;
            }
          }

          const enrichedMsg: Record<string, unknown> = {
            ...msg,
            ...(rawMeta ? { __rawStanzaMeta: rawMeta } : {}),
            ...(contactInfo ? { __contactInfo: contactInfo } : {}),
          };

          callbacks.onIncomingMessage({
            sessionId: this.sessionId,
            rawMessage: enrichedMsg,
            sock,
          });
        } catch (err) {
          log.warn('Error in onIncomingMessage listener', {
            sessionId: this.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    sock.ev.on('creds.update', credsListener);
    sock.ev.on('connection.update', connectionListener);
    sock.ev.on('messages.update', messagesUpdateListener);
    sock.ev.on('message-receipt.update', receiptUpdateListener);
    sock.ev.on('messages.upsert', incomingMessagesUpsertListener as never);

    this.evCleanup = () => {
      unbindStore();
      try {
        if (typeof wsEmitter?.off === 'function') {
          wsEmitter.off('CB:message', rawMessageStanzaListener as never);
        }
        sock.ev.off('creds.update', credsListener);
        sock.ev.off('connection.update', connectionListener);
        sock.ev.off('messages.update', messagesUpdateListener);
        sock.ev.off('message-receipt.update', receiptUpdateListener);
        sock.ev.off('messages.upsert', incomingMessagesUpsertListener as never);
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

  public getRawSocket(): WASocket | null {
    return this.sock;
  }

  public getCompatibleSocket(): CompatibleWhatsAppSocket | null {
    if (!this.sock) return null;
    return toCompatibleWhatsAppSocket(this.sock);
  }

  /**
   * Initiates pairing code generation using `@hiroosy/baileys-lite`'s `sock.requestPairingCode(phoneNumber, code?)`.
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
        'إصدار مكتبة @hiroosy/baileys-lite الحالي لا يدعم توليد رمز الربط النصي (Pairing Code).'
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
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const resultPromise = sock.requestPairingCode(cleanDigits, codeToRequest);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () =>
            reject(
              new TaskTimeoutError(
                'انتهت مهلة استلام رمز الربط من خوادم واتساب (30 ثانية). يرجى التحقق من الشبكة وإعادة المحاولة.'
              )
            ),
          30_000
        );
        if (typeof timerId.unref === 'function') {
          timerId.unref();
        }
      });
      try {
        return await Promise.race([resultPromise, timeoutPromise]);
      } finally {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
      }
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
    ptv?: boolean;
    gifPlayback?: boolean;
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
        ...(params.ptv ? { ptv: true } : {}),
        ...(params.gifPlayback ? { gifPlayback: true } : {}),
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
   * Maps `@hiroosy/baileys-lite` GroupMetadata (supporting both PN and LID addressing modes)
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
   * Queries WhatsApp Channel (Newsletter) metadata via `@hiroosy/baileys-lite` `newsletterMetadata`
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
    const isRegistered = Boolean(
      this.authenticatedOpen && (creds?.registered || creds?.account) && meJid
    );

    return {
      socketActive: this.wsOpen && this.connectionState !== 'CLOSED',
      registered: isRegistered,
      wsOpen: this.wsOpen,
      handshakeReady: this.handshakeReady,
      connectionState: this.connectionState,
      platform: String(creds?.platform || 'Ubuntu / Chrome'),
      device: String(creds?.device || 'Hiroosy-Baileys-Lite Multi-Device'),
      meJid,
      ...stats,
    };
  }

  /**
   * Safe presence wrapper (adapted from Nebula `createSafeSock`).
   */
  public async sendPresenceUpdate(
    state: WAPresence,
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

  private handleMessagesUpdateForReadRevoke(
    updates: Array<{
      key?: { id?: string | null; remoteJid?: string | null };
      update?: { status?: number | string | null };
    }>
  ): void {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      const id = item?.key?.id;
      const rawStatus = item?.update?.status;
      const isReadOrPlayed =
        rawStatus === 4 ||
        rawStatus === 5 ||
        rawStatus === 'READ' ||
        rawStatus === 'PLAYED';
      if (id && isReadOrPlayed) {
        const msgId = String(id);
        const pendingOnRead = this.pendingOnReadRevokes.get(msgId);
        if (pendingOnRead) {
          clearTimeout(pendingOnRead.fallbackTimer);
          this.pendingOnReadRevokes.delete(msgId);
          this.scheduleEphemeralRevokeTimer(
            msgId,
            pendingOnRead.targetJid,
            pendingOnRead.key,
            pendingOnRead.expirationSeconds * 1000
          );
        }
      }
    }
  }

  private handleReceiptUpdates(
    updates: Array<{
      key?: { id?: string | null; remoteJid?: string | null };
      receipt?: {
        readTimestamp?: unknown;
        playedTimestamp?: unknown;
        receiptTimestamp?: unknown;
      };
    }>
  ): void {
    if (!Array.isArray(updates)) return;
    for (const r of updates) {
      if (!r?.key?.id || !r?.receipt) continue;
      const msgId = String(r.key.id);
      const receiptType = r.receipt.readTimestamp
        ? 'read'
        : r.receipt.playedTimestamp
          ? 'played'
          : 'delivery';
      if (this.messageSender) {
        this.messageSender.recordAckUpdate({
          sessionId: this.sessionId,
          messageId: msgId,
          receiptType,
        });
      }
      if (r.receipt.readTimestamp || r.receipt.playedTimestamp) {
        const pendingOnRead = this.pendingOnReadRevokes.get(msgId);
        if (pendingOnRead) {
          clearTimeout(pendingOnRead.fallbackTimer);
          this.pendingOnReadRevokes.delete(msgId);
          this.scheduleEphemeralRevokeTimer(
            msgId,
            pendingOnRead.targetJid,
            pendingOnRead.key,
            pendingOnRead.expirationSeconds * 1000
          );
        }
      }
    }
  }

  private scheduleEphemeralRevokeTimer(
    msgId: string,
    targetJid: string,
    messageKey: WAMessageKey,
    delayMs: number
  ): void {
    const existing = this.ephemeralRevokeTimers.get(msgId);
    if (existing) {
      clearTimeout(existing);
    }
    const effectiveDelayMs = Math.max(10, delayMs);
    const timer = setTimeout(async () => {
      this.ephemeralRevokeTimers.delete(msgId);
      try {
        if (!this.sock || !this.wsOpen) return;
        const revokeKey: WAMessageKey = {
          remoteJid: messageKey.remoteJid || targetJid,
          fromMe: true,
          id: msgId,
          ...(messageKey.participant
            ? { participant: messageKey.participant }
            : {}),
        };
        await this.sock.sendMessage(revokeKey.remoteJid!, {
          delete: revokeKey,
        });
      } catch (err) {
        log.warn('Failed auto-revoking short ephemeral message', {
          sessionId: this.sessionId,
          msgId,
          targetJid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, effectiveDelayMs);
    // Keep short timers (<= 60s) active on the event loop; only unref long fallback timers
    if (effectiveDelayMs > 60_000 && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.ephemeralRevokeTimers.set(msgId, timer);
  }

  private extractLidString(rawLid: unknown): string | undefined {
    if (!rawLid) return undefined;
    if (typeof rawLid === 'string') {
      const trimmed = rawLid.trim();
      if (!trimmed) return undefined;
      return trimmed.includes('@')
        ? jidNormalizedUser(trimmed)
        : `${trimmed.replace(/\D/g, '')}@lid`;
    }
    if (typeof rawLid === 'object') {
      const obj = rawLid as {
        id?: string;
        lid?: string;
        _serialized?: string;
        user?: string;
        val?: string;
        jid?: string;
      };
      const candidate =
        obj.lid || obj.val || obj.jid || obj.id || obj._serialized || obj.user;
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.includes('@')
          ? jidNormalizedUser(candidate)
          : `${candidate.replace(/\D/g, '')}@lid`;
      }
    }
    return undefined;
  }

  private async persistLidPnMappingOnSocket(
    sock: WASocket,
    lidJid: string,
    pnJid: string
  ): Promise<void> {
    this.memoryStore.recordLidMapping(lidJid, pnJid);
    try {
      await sock.signalRepository?.lidMapping?.storeLIDPNMappings?.([
        { lid: lidJid, pn: pnJid },
      ]);
    } catch {
      // Best-effort
    }
    try {
      const pnUser = jidDecode(pnJid)?.user || pnJid.split('@')[0];
      const lidUser = jidDecode(lidJid)?.user || lidJid.split('@')[0];
      if (pnUser && lidUser && sock.authState?.keys?.set) {
        await sock.authState.keys.set({
          'lid-mapping': {
            [pnUser]: lidUser,
            [`${lidUser}_reverse`]: pnUser,
          },
        } as never);
      }
    } catch {
      // Best-effort
    }
  }

  private findLidAttrInBinaryNode(node: BinaryNode | undefined): string | undefined {
    if (!node || typeof node !== 'object') return undefined;
    if (node.tag === 'lid' || node.tag === 'user') {
      const rawVal =
        node.attrs?.val ||
        node.attrs?.lid ||
        (node.attrs?.jid?.endsWith('@lid') ? node.attrs.jid : undefined) ||
        (node.tag === 'lid' ? node.attrs?.id : undefined);
      const parsed = this.extractLidString(rawVal);
      if (parsed && parsed.endsWith('@lid')) {
        return parsed;
      }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const found = this.findLidAttrInBinaryNode(child);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Resolves the Privacy-Preserving Linked Identity (`@lid`) for a target phone number or JID
   * across 6 protocol layers:
   * 1. Direct `@lid` input
   * 2. Local `signalRepository.lidMapping` & `SessionMemoryStore`
   * 3. Live `sock.onWhatsApp(pnJid)` USync `<lid>` stanza query
   * 4. `sock.getUSyncDevices([pnJid], false, false)` (which triggers `withLIDProtocol()` and populates `lidMapping`)
   * 5. Direct USync `<iq xmlns="usync">` query with `<contact/>`, `<lid/>`, and `<devices version="2"/>`
   * 6. Participating `groupMetadataCache` participant entries
   */
  public async resolveLidForRecipient(targetInput: string): Promise<{
    pnJid?: string;
    lidJid: string;
    source:
      | 'DIRECT_LID'
      | 'LID_MAPPING_STORE'
      | 'ON_WHATSAPP_USYNC'
      | 'GROUP_PARTICIPANT_CACHE';
  }> {
    const sock = this.ensureSocket();
    const trimmed = String(targetInput || '').trim();
    if (!trimmed) {
      throw new ValidationError('الرجاء إدخال رقم الهاتف أو معرف @lid للمستلم.');
    }

    // 1. Direct @lid input
    if (trimmed.endsWith('@lid')) {
      const validated = validateRecipient(trimmed);
      const lidJid = jidNormalizedUser(validated.jid);
      let pnJid = this.memoryStore.getPnForLid(lidJid);
      if (!pnJid && sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const fromRepo = await sock.signalRepository.lidMapping.getPNForLID(lidJid);
          if (fromRepo) {
            pnJid = jidNormalizedUser(fromRepo);
            this.memoryStore.recordLidMapping(lidJid, pnJid);
          }
        } catch {
          // Ignore
        }
      }
      return {
        pnJid,
        lidJid,
        source: 'DIRECT_LID',
      };
    }

    // Normalize as PN JID
    const normalizedRecipient = validateRecipient(trimmed);
    if (normalizedRecipient.isGroup) {
      throw new ValidationError(
        'استخراج معرف @lid المباشر مخصص لجهات الاتصال الفردية (رقم دولي أو @lid).'
      );
    }
    let pnJid = jidNormalizedUser(normalizedRecipient.jid);

    // 2. Check signalRepository.lidMapping & memoryStore
    try {
      const repoLid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid);
      const parsedRepoLid = this.extractLidString(repoLid);
      if (parsedRepoLid && parsedRepoLid.endsWith('@lid')) {
        await this.persistLidPnMappingOnSocket(sock, parsedRepoLid, pnJid);
        return {
          pnJid,
          lidJid: parsedRepoLid,
          source: 'LID_MAPPING_STORE',
        };
      }
    } catch {
      // Fall through
    }

    const storeLid = this.memoryStore.getLidForPn(pnJid);
    if (storeLid && storeLid.endsWith('@lid')) {
      return {
        pnJid,
        lidJid: storeLid,
        source: 'LID_MAPPING_STORE',
      };
    }

    // 3a. Query USync via sock.onWhatsApp(pnJid)
    if (typeof sock.onWhatsApp === 'function') {
      try {
        const results = await sock.onWhatsApp(pnJid);
        const entry = Array.isArray(results) ? results[0] : undefined;
        if (entry?.jid) {
          pnJid = jidNormalizedUser(entry.jid);
        }
        const usyncLid = this.extractLidString(entry?.lid);
        if (usyncLid && usyncLid.endsWith('@lid')) {
          await this.persistLidPnMappingOnSocket(sock, usyncLid, pnJid);
          return {
            pnJid,
            lidJid: usyncLid,
            source: 'ON_WHATSAPP_USYNC',
          };
        }
      } catch {
        // Fall through to getUSyncDevices & direct USync IQ
      }
    }

    // 3b. Trigger sock.getUSyncDevices([pnJid], false, false) which executes USync withLIDProtocol()
    // in @hiroosy/baileys-lite and populates signalRepository.lidMapping
    if (typeof sock.getUSyncDevices === 'function') {
      try {
        await sock.getUSyncDevices([pnJid], false, false);
        const repoLidAfterDevices =
          await sock.signalRepository?.lidMapping?.getLIDForPN?.(pnJid);
        const parsedAfterDevices =
          this.extractLidString(repoLidAfterDevices) ||
          this.memoryStore.getLidForPn(pnJid);
        if (parsedAfterDevices && parsedAfterDevices.endsWith('@lid')) {
          await this.persistLidPnMappingOnSocket(sock, parsedAfterDevices, pnJid);
          return {
            pnJid,
            lidJid: parsedAfterDevices,
            source: 'ON_WHATSAPP_USYNC',
          };
        }
      } catch {
        // Fall through to direct USync IQ
      }
    }

    // 3c. Direct USync IQ query requesting <contact/>, <lid/>, and <devices version="2"/>
    if (typeof sock.query === 'function') {
      try {
        const usyncNode: BinaryNode = {
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'get',
            xmlns: 'usync',
          },
          content: [
            {
              tag: 'usync',
              attrs: {
                sid: `lid_sync_${Date.now()}`,
                mode: 'query',
                last: 'true',
                index: '0',
                context: 'interactive',
              },
              content: [
                {
                  tag: 'query',
                  attrs: {},
                  content: [
                    { tag: 'contact', attrs: {} },
                    { tag: 'lid', attrs: {} },
                    { tag: 'devices', attrs: { version: '2' } },
                  ],
                },
                {
                  tag: 'list',
                  attrs: {},
                  content: [{ tag: 'user', attrs: { jid: pnJid } }],
                },
              ],
            },
          ],
        };
        const iqRes = (await sock.query(usyncNode, 10_000)) as
          | BinaryNode
          | undefined;
        const extractedFromIq = this.findLidAttrInBinaryNode(iqRes);
        if (extractedFromIq && extractedFromIq.endsWith('@lid')) {
          await this.persistLidPnMappingOnSocket(sock, extractedFromIq, pnJid);
          return {
            pnJid,
            lidJid: extractedFromIq,
            source: 'ON_WHATSAPP_USYNC',
          };
        }
      } catch {
        // Fall through to group participant cache
      }
    }

    // 4. Search groupMetadataCache participants (populating cache once if empty)
    if (
      this.groupMetadataCache.size === 0 &&
      typeof sock.groupFetchAllParticipating === 'function'
    ) {
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        if (allGroups && typeof allGroups === 'object') {
          for (const [gJid, gMeta] of Object.entries(allGroups)) {
            if (gMeta && typeof gMeta === 'object') {
              this.groupMetadataCache.set(gJid, gMeta as GroupMetadata);
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    for (const meta of this.groupMetadataCache.values()) {
      for (const p of meta.participants || []) {
        const pId = p.id ? jidNormalizedUser(p.id) : '';
        const pPn = (p as { phoneNumber?: string }).phoneNumber
          ? jidNormalizedUser((p as { phoneNumber?: string }).phoneNumber!)
          : '';
        const pLid = this.extractLidString(
          p.lid || (pId.endsWith('@lid') ? pId : undefined)
        );
        const matchesPn =
          (pId && areJidsSameUser(pId, pnJid)) ||
          (pPn && areJidsSameUser(pPn, pnJid));
        if (matchesPn && pLid && pLid.endsWith('@lid')) {
          await this.persistLidPnMappingOnSocket(sock, pLid, pnJid);
          return {
            pnJid,
            lidJid: pLid,
            source: 'GROUP_PARTICIPANT_CACHE',
          };
        }
      }
    }

    throw new WhatsAppConnectionError(
      `تعذر استخراج معرف الهوية المخفية (@lid) للمستلم (${pnJid}) عبر USync أو سجل المجموعات. تأكد من أن الرقم مسجل في واتساب أو أدخل معرف @lid مباشرة.`
    );
  }

  /**
   * Sends a protocol-level LID-addressed message (`addressing_mode="lid"`) via `@hiroosy/baileys-lite`,
   * migrating/asserting the E2E Signal session onto the target `@lid` JID and relaying with `userJid = selfLid`
   * so the message stanza is strictly addressed from `@lid` to `@lid` without leaking PN identity.
   */
  public async sendAnonymousLidMessage(params: {
    recipient: string;
    text: string;
    customPushName?: string;
  }): Promise<{
    messageId: string;
    targetLid: string;
    resolvedPn?: string;
    resolutionSource: string;
  }> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'الجلسة غير متصلة حالياً لإرسال الرسائل عبر بروتوكول LID.'
      );
    }

    const validText = String(params.text || '').trim();
    if (!validText) {
      throw new ValidationError(
        'الرجاء إدخال نص الرسالة المراد إرسالها عبر بروتوكول LID.'
      );
    }

    const selfLid = sock.user?.lid || sock.authState?.creds?.me?.lid;
    const senderJid = selfLid
      ? jidNormalizedUser(selfLid)
      : sock.user?.id
        ? jidNormalizedUser(sock.user.id)
        : undefined;

    const trimmedRecipient = String(params.recipient || '').trim();
    if (trimmedRecipient.endsWith('@g.us')) {
      const groupCheck = validateRecipient(trimmedRecipient);
      const waMsg = generateWAMessageFromContent(
        groupCheck.jid,
        { extendedTextMessage: { text: validText } },
        { userJid: senderJid }
      );
      const msgId = waMsg.key.id || `lid_grp_${Date.now()}`;
      if (waMsg.message) {
        this.memoryStore.cacheSentMessage(groupCheck.jid, msgId, waMsg.message);
      }
      await sock.relayMessage(groupCheck.jid, waMsg.message!, {
        messageId: msgId,
        addressingMode: 'lid',
        additionalAttributes: { addressing_mode: 'lid' },
      });
      await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
      return {
        messageId: msgId,
        targetLid: groupCheck.jid,
        resolutionSource: 'GROUP_LID_RELAY',
      };
    }

    const { pnJid, lidJid, source } = await this.resolveLidForRecipient(
      trimmedRecipient
    );

    // Warm up USync devices & migrate/assert E2E Signal session onto the @lid identity
    try {
      if (typeof sock.getUSyncDevices === 'function') {
        const jidsToFetch = [pnJid, lidJid].filter((j): j is string => Boolean(j));
        await sock.getUSyncDevices(jidsToFetch, false, false).catch(() => []);
        await sock.getUSyncDevices([lidJid], true, false).catch(() => []);
      }
      if (pnJid && typeof sock.signalRepository?.migrateSession === 'function') {
        await sock.signalRepository
          .migrateSession(pnJid, lidJid)
          .catch(() => undefined);
      }
      if (typeof sock.assertSessions === 'function') {
        await sock.assertSessions([lidJid], false).catch(() => false);
      }
    } catch {
      // Best-effort session preparation before relayMessage
    }

    const previousName = sock.user?.name;
    if (params.customPushName && sock.user) {
      sock.user.name = params.customPushName;
    }

    let msgId = `lid_msg_${Date.now()}`;
    try {
      const waMsg = generateWAMessageFromContent(
        lidJid,
        { extendedTextMessage: { text: validText } },
        { userJid: senderJid }
      );
      msgId = waMsg.key?.id || msgId;
      if (waMsg.message) {
        this.memoryStore.cacheSentMessage(lidJid, msgId, waMsg.message);
      }

      if (typeof sock.relayMessage === 'function') {
        await sock.relayMessage(lidJid, waMsg.message!, {
          messageId: msgId,
          addressingMode: 'lid',
          additionalAttributes: { addressing_mode: 'lid' },
        });
      } else {
        const res = await sock.sendMessage(
          lidJid,
          { text: validText },
          { addressingMode: 'lid' }
        );
        if (res?.key?.id) {
          msgId = res.key.id;
        }
        if (res?.message) {
          this.memoryStore.cacheSentMessage(lidJid, msgId, res.message);
        }
      }
    } finally {
      if (params.customPushName && sock.user) {
        sock.user.name = previousName;
      }
    }

    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);

    return {
      messageId: msgId,
      targetLid: lidJid,
      resolvedPn: pnJid,
      resolutionSource: source,
    };
  }

  /**
   * Subscribes to and tracks real-time recipient presence (`available`, `unavailable`, `composing`, `recording`, `paused`)
   * across both `@s.whatsapp.net` and `@lid` JIDs, auto-expiring stale composing states after 12s of silence.
   */
  public async trackRecipientPresence(params: {
    recipient: string;
    durationSeconds: number;
    onUpdate?: (record: TrackedPresenceRecord) => void;
    staleComposingTimeoutMs?: number;
  }): Promise<TrackedPresenceRecord> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'الجلسة غير متصلة حالياً لتتبع حالة التواجد (Presence).'
      );
    }

    const durationSec = Math.min(
      300,
      Math.max(1, Math.floor(Number(params.durationSeconds) || 15))
    );
    const staleTimeoutMs = Math.max(
      250,
      params.staleComposingTimeoutMs ?? 12_000
    );

    const validated = validateRecipient(params.recipient);
    const targetJid = jidNormalizedUser(validated.jid);
    let pnJid = targetJid.endsWith('@s.whatsapp.net') ? targetJid : undefined;
    let lidJid = targetJid.endsWith('@lid') ? targetJid : undefined;

    const resolved = await this.resolveLidForRecipient(params.recipient).catch(
      () => null
    );
    if (resolved) {
      pnJid = resolved.pnJid || pnJid;
      lidJid = resolved.lidJid || lidJid;
    }

    if (pnJid && lidJid) {
      this.memoryStore.recordLidMapping(lidJid, pnJid);
    }

    const primaryKey = pnJid || lidJid || targetJid;

    // 1. Register onUpdate listener BEFORE subscribing so the immediate initial `<presence>` stanza is captured!
    const unsubListener = params.onUpdate
      ? this.memoryStore.onPresenceChange(primaryKey, params.onUpdate)
      : () => undefined;

    // 2. Activate our own presence (globally and directed to target) so WhatsApp servers stream presence + lastSeen
    await sock.sendPresenceUpdate('available').catch(() => undefined);
    await sock
      .sendPresenceUpdate('available', pnJid || primaryKey)
      .catch(() => undefined);

    // 3. Subscribe to both PN and LID JIDs
    const subscribeBoth = async () => {
      if (pnJid) {
        await sock.presenceSubscribe(pnJid).catch(() => undefined);
      }
      if (lidJid && lidJid !== pnJid) {
        await sock.presenceSubscribe(lidJid).catch(() => undefined);
      }
      if (!pnJid && !lidJid) {
        await sock.presenceSubscribe(primaryKey).catch(() => undefined);
      }
    };
    await subscribeBoth();

    // 4. Re-subscribe every 45s to keep WhatsApp's server-side subscription active
    const resubscribeInterval = setInterval(() => {
      void subscribeBoth();
    }, 45_000);
    if (typeof resubscribeInterval.unref === 'function') {
      resubscribeInterval.unref();
    }

    // 5. Watchdog for stale composing/recording (>12s without paused/message)
    const staleWatchdogInterval = setInterval(() => {
      const rec =
        this.memoryStore.presences.get(primaryKey) ||
        (lidJid ? this.memoryStore.presences.get(lidJid) : undefined);
      if (
        rec &&
        (rec.currentState === 'composing' || rec.currentState === 'recording') &&
        Date.now() - rec.lastUpdatedMs >= staleTimeoutMs
      ) {
        this.memoryStore.applyPresenceTransition({
          chatJid: primaryKey,
          participantJid: rec.resolvedLid || primaryKey,
          state: 'available',
        });
      }
    }, Math.min(1_000, Math.max(50, Math.floor(staleTimeoutMs / 2))));
    if (typeof staleWatchdogInterval.unref === 'function') {
      staleWatchdogInterval.unref();
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const doneTimer = setTimeout(() => {
        cleanup();
      }, durationSec * 1000);
      const cleanup = () => {
        clearTimeout(doneTimer);
        clearInterval(resubscribeInterval);
        clearInterval(staleWatchdogInterval);
        unsubListener();
        this.activePresenceCleanups.delete(cleanup);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      this.activePresenceCleanups.add(cleanup);
    });

    const finalRecord =
      this.memoryStore.presences.get(primaryKey) ||
      (lidJid ? this.memoryStore.presences.get(lidJid) : undefined) || {
        chatJid: primaryKey,
        resolvedLid: lidJid,
        currentState: 'unavailable' as WAPresence,
        lastUpdatedMs: Date.now(),
        transitions: [],
        totalOnlineDurationMs: 0,
      };

    if (finalRecord.onlineSessionStartedAtMs !== undefined) {
      const now = Date.now();
      return {
        ...finalRecord,
        totalOnlineDurationMs:
          finalRecord.totalOnlineDurationMs +
          Math.max(0, now - finalRecord.onlineSessionStartedAtMs),
      };
    }

    return finalRecord;
  }

  /**
   * Broadcasts continuous presence heartbeat pulses (`composing`, `recording`, or `available`)
   * every `pulseIntervalMs` (default `7500ms`) so the indicator never times out on the recipient's phone,
   * concluding with a clean `paused` stanza.
   */
  public async startPresenceHeartbeatBroadcast(params: {
    recipient: string;
    mode: 'composing' | 'recording' | 'available';
    durationSeconds: number;
    pulseIntervalMs?: number;
  }): Promise<{
    pulsesSent: number;
    targetJid: string;
    durationMs: number;
  }> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'الجلسة غير متصلة حالياً لبث نبضات التواجد.'
      );
    }

    const durationSec = Math.min(
      180,
      Math.max(1, Math.floor(Number(params.durationSeconds) || 15))
    );
    const pulseIntervalMs = Math.max(50, params.pulseIntervalMs ?? 7_500);

    const validated = validateRecipient(params.recipient);
    const resolvedJid = validated.jid.endsWith('@s.whatsapp.net')
      ? await this.resolveDirectRecipientJid(sock, validated.jid)
      : jidNormalizedUser(validated.jid);

    const startedAt = Date.now();
    await sock.presenceSubscribe(resolvedJid).catch(() => undefined);

    let pulsesSent = 0;
    const sendPulse = async () => {
      if (!this.sock || !this.wsOpen) return;
      await sock.sendPresenceUpdate(params.mode, resolvedJid).catch(() => undefined);
      pulsesSent++;
    };

    await sendPulse();

    await new Promise<void>((resolve) => {
      let settled = false;
      const pulseTimer = setInterval(() => {
        void sendPulse();
      }, pulseIntervalMs);
      if (typeof pulseTimer.unref === 'function') {
        pulseTimer.unref();
      }

      const endTimer = setTimeout(() => {
        cleanup();
      }, durationSec * 1000);

      const cleanup = () => {
        clearInterval(pulseTimer);
        clearTimeout(endTimer);
        this.activePresenceCleanups.delete(cleanup);
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      this.activePresenceCleanups.add(cleanup);
    });

    if (this.sock && this.wsOpen) {
      await sock.sendPresenceUpdate('paused', resolvedJid).catch(() => undefined);
    }

    return {
      pulsesSent,
      targetJid: resolvedJid,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  /**
   * Deep OSINT Profile Inspector (`fetchFullProfileInfo`) combining comprehensive USync IQ (`<contact/>`,
   * `<status/>`, `<picture/>`, `<lid/>`, `<devices version="2"/>`, `<disappearing_mode/>`, `<business/>`)
   * with `onWhatsApp`, `fetchStatus`, `getBusinessProfile`, `getUSyncDevices`, HD `profilePictureUrl` + binary buffer,
   * `SessionMemoryStore` contacts/presence, and `groupFetchAllParticipating` shared groups.
   */
  public async fetchFullProfileInfo(
    recipient: string
  ): Promise<WhatsAppFullProfileReport> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'الجلسة غير متصلة حالياً لفحص الملف الشخصي.'
      );
    }

    const validated = validateRecipient(recipient);
    if (validated.isGroup) {
      throw new ValidationError(
        'فحص الملف الشخصي العميق (/fullprofile) مخصص لحسابات المستخدمين الفردية (رقم دولي أو @lid).'
      );
    }

    let pnJid = validated.isLid ? '' : jidNormalizedUser(validated.jid);
    let lidJid = validated.isLid ? jidNormalizedUser(validated.jid) : undefined;

    if (validated.isLid && lidJid) {
      const mappedPn =
        this.memoryStore.getPnForLid(lidJid) ||
        (await sock.signalRepository?.lidMapping
          ?.getPNForLID?.(lidJid)
          .catch(() => undefined)) ||
        undefined;
      if (mappedPn) {
        pnJid = jidNormalizedUser(mappedPn);
      }
    }

    const targetQueryJid = pnJid || lidJid || validated.jid;

    // Subscribe to presence early so the server pushes presence while other queries run
    void sock.sendPresenceUpdate('available').catch(() => undefined);
    void sock.presenceSubscribe(targetQueryJid).catch(() => undefined);

    const [
      usyncIqSettled,
      onWaSettled,
      statusSettled,
      bizSettled,
      devicesSettled,
    ] = await Promise.allSettled([
      // (0) Comprehensive USync IQ query (<contact/>, <status/>, <picture/>, <lid/>, <devices version="2"/>, <disappearing_mode/>, <business/>)
      (async () => {
        if (typeof sock.query !== 'function') return undefined;
        const comprehensiveUsyncNode: BinaryNode = {
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'get',
            xmlns: 'usync',
          },
          content: [
            {
              tag: 'usync',
              attrs: {
                sid: `fullprof_${Date.now()}`,
                mode: 'full',
                last: 'true',
                index: '0',
                context: 'interactive',
              },
              content: [
                {
                  tag: 'query',
                  attrs: {},
                  content: [
                    { tag: 'contact', attrs: {} },
                    { tag: 'status', attrs: {} },
                    { tag: 'picture', attrs: {} },
                    { tag: 'lid', attrs: {} },
                    { tag: 'devices', attrs: { version: '2' } },
                    { tag: 'disappearing_mode', attrs: {} },
                    {
                      tag: 'business',
                      attrs: {},
                      content: [{ tag: 'verified_name', attrs: {} }],
                    },
                  ],
                },
                {
                  tag: 'list',
                  attrs: {},
                  content: [{ tag: 'user', attrs: { jid: targetQueryJid } }],
                },
              ],
            },
          ],
        };
        return (await sock.query(comprehensiveUsyncNode, 10_000)) as
          | BinaryNode
          | undefined;
      })(),

      // (A) Identity & LID via onWhatsApp
      (async () => {
        let exists = true;
        if (typeof sock.onWhatsApp === 'function' && pnJid) {
          const res = await sock.onWhatsApp(pnJid);
          if (Array.isArray(res) && res.length > 0) {
            exists = Boolean(res[0]?.exists);
            if (res[0]?.jid) {
              pnJid = jidNormalizedUser(res[0].jid);
            }
            const extractedLid = this.extractLidString(res[0]?.lid);
            if (extractedLid) {
              lidJid = extractedLid;
              await this.persistLidPnMappingOnSocket(sock, extractedLid, pnJid);
            }
          } else {
            exists = false;
          }
        }
        if (!lidJid && pnJid) {
          const repoLid = await sock.signalRepository?.lidMapping
            ?.getLIDForPN?.(pnJid)
            .catch(() => undefined);
          lidJid =
            this.extractLidString(repoLid) || this.memoryStore.getLidForPn(pnJid);
        }
        return { exists };
      })(),

      // (C) About / Status (`fetchStatus`)
      (async () => {
        if (typeof sock.fetchStatus !== 'function') return undefined;
        return await sock.fetchStatus(targetQueryJid);
      })(),

      // (D) Business Profile (`getBusinessProfile`)
      (async () => {
        if (typeof sock.getBusinessProfile !== 'function') return undefined;
        return await sock.getBusinessProfile(targetQueryJid);
      })(),

      // (E) Linked Companion Devices (`getUSyncDevices`)
      (async () => {
        if (typeof sock.getUSyncDevices !== 'function') return [];
        return await sock.getUSyncDevices([targetQueryJid], false, false);
      })(),
    ]);

    let existsOnWhatsApp =
      onWaSettled.status === 'fulfilled' ? onWaSettled.value.exists : true;

    // Extract fields from comprehensive USync IQ response if present
    let usyncStatusText: string | undefined;
    let usyncStatusSetAt: string | undefined;
    let pictureId: string | undefined;
    let disappearingMode: WhatsAppFullProfileReport['disappearingMode'];
    const usyncDeviceIds: number[] = [];

    if (usyncIqSettled.status === 'fulfilled' && usyncIqSettled.value) {
      const iqNode = usyncIqSettled.value;
      const usyncNode = getBinaryNodeChild(iqNode, 'usync');
      const listNode = getBinaryNodeChild(usyncNode, 'list');
      const userNode = getBinaryNodeChild(listNode, 'user');
      if (userNode) {
        if (userNode.attrs?.jid && !pnJid && userNode.attrs.jid.endsWith('@s.whatsapp.net')) {
          pnJid = jidNormalizedUser(userNode.attrs.jid);
        }
        const contactNode = getBinaryNodeChild(userNode, 'contact');
        if (contactNode?.attrs?.type === 'out') {
          existsOnWhatsApp = false;
        } else if (contactNode?.attrs?.type === 'in') {
          existsOnWhatsApp = true;
        }
        const lidNode = getBinaryNodeChild(userNode, 'lid');
        const rawUsyncLid =
          lidNode?.attrs?.val || lidNode?.attrs?.jid || lidNode?.attrs?.id;
        const parsedUsyncLid = this.extractLidString(rawUsyncLid);
        if (parsedUsyncLid && parsedUsyncLid.endsWith('@lid')) {
          lidJid = parsedUsyncLid;
          if (pnJid) {
            await this.persistLidPnMappingOnSocket(sock, parsedUsyncLid, pnJid);
          }
        }

        const statusNode = getBinaryNodeChild(userNode, 'status');
        if (statusNode) {
          const rawContent = statusNode.content;
          const decodedText =
            typeof rawContent === 'string'
              ? rawContent
              : Buffer.isBuffer(rawContent)
                ? rawContent.toString('utf8')
                : rawContent instanceof Uint8Array
                  ? Buffer.from(rawContent).toString('utf8')
                  : '';
          if (decodedText.trim()) {
            usyncStatusText = decodedText.trim();
          }
          const rawT = Number(statusNode.attrs?.t || 0);
          if (Number.isFinite(rawT) && rawT > 0) {
            usyncStatusSetAt = new Date(rawT * 1000).toISOString();
          }
        }

        const pictureNode = getBinaryNodeChild(userNode, 'picture');
        if (pictureNode?.attrs?.id) {
          pictureId = String(pictureNode.attrs.id);
        }

        const dmNode = getBinaryNodeChild(userNode, 'disappearing_mode');
        if (dmNode) {
          const dur = Number(dmNode.attrs?.duration || 0);
          const dmT = Number(dmNode.attrs?.t || 0);
          if (Number.isFinite(dur) && dur >= 0 && dmNode.attrs?.duration !== undefined) {
            disappearingMode = {
              durationSeconds: dur,
              ...(Number.isFinite(dmT) && dmT > 0
                ? { setAtIso: new Date(dmT * 1000).toISOString() }
                : {}),
            };
          }
        }

        const devicesNode = getBinaryNodeChild(userNode, 'devices');
        const deviceListNode = getBinaryNodeChild(devicesNode, 'device-list');
        for (const devNode of getBinaryNodeChildren(deviceListNode, 'device')) {
          const devId = Number(devNode.attrs?.id ?? NaN);
          if (Number.isFinite(devId) && devId >= 0) {
            usyncDeviceIds.push(devId);
          }
        }
      }
    }

    if (lidJid) {
      void sock.presenceSubscribe(lidJid).catch(() => undefined);
    }

    // (B) Profile Picture with fallback & privacy/404 classification + binary download
    const profilePicture: WhatsAppFullProfileReport['profilePicture'] = {
      status: 'NO_PICTURE',
      statusReasonArabic: 'لا توجد صورة شخصية متاحة',
      ...(pictureId ? { pictureId } : {}),
    };

    if (typeof sock.profilePictureUrl === 'function') {
      const classifyPicError = (err: unknown): {
        status: 'PRIVACY_HIDDEN' | 'NO_PICTURE' | 'ERROR';
        reason: string;
      } => {
        const msg = err instanceof Error ? err.message : String(err || '');
        const statusCode = Number(
          (err as { data?: number; output?: { statusCode?: number } })?.data ||
            (err as { output?: { statusCode?: number } })?.output?.statusCode ||
            0
        );
        if (
          statusCode === 401 ||
          statusCode === 403 ||
          /not-authorized|401|403|forbidden/i.test(msg)
        ) {
          return {
            status: 'PRIVACY_HIDDEN',
            reason: 'محجوبة بإعدادات الخصوصية (جهات الاتصال فقط / لا أحد)',
          };
        }
        if (statusCode === 404 || /item-not-found|404/i.test(msg)) {
          return {
            status: 'NO_PICTURE',
            reason: 'لا توجد صورة شخصية (أو محذوفة)',
          };
        }
        return {
          status: 'ERROR',
          reason: 'تعذر جلب الصورة الشخصية من الخادم',
        };
      };

      let hdUrl: string | undefined;
      let previewUrl: string | undefined;
      let lastPicError: unknown;

      try {
        hdUrl = await sock.profilePictureUrl(targetQueryJid, 'image', 10_000);
      } catch (err) {
        lastPicError = err;
        if (lidJid && lidJid !== targetQueryJid) {
          try {
            hdUrl = await sock.profilePictureUrl(lidJid, 'image', 10_000);
          } catch (lidErr) {
            lastPicError = lidErr;
          }
        }
      }

      try {
        previewUrl = await sock.profilePictureUrl(
          lidJid && !hdUrl ? lidJid : targetQueryJid,
          'preview',
          8_000
        );
      } catch (err) {
        if (!lastPicError) lastPicError = err;
      }

      if (hdUrl || previewUrl) {
        profilePicture.hdUrl = hdUrl;
        profilePicture.previewUrl = previewUrl;
        profilePicture.status = 'AVAILABLE';
        profilePicture.statusReasonArabic = hdUrl
          ? 'متاحة بدقة عالية (HD)'
          : 'متاحة بدقة مصغرة (Preview)';

        const downloadUrl = hdUrl || previewUrl;
        if (downloadUrl) {
          try {
            const parsedUrl = new URL(downloadUrl);
            if (
              parsedUrl.protocol === 'https:' ||
              parsedUrl.protocol === 'http:'
            ) {
              const res = await fetch(downloadUrl, {
                signal: AbortSignal.timeout(8_000),
              });
              if (res.ok) {
                const ab = await res.arrayBuffer();
                const buf = Buffer.from(ab);
                if (buf.length > 0) {
                  profilePicture.imageBuffer = buf;
                }
              }
            }
          } catch {
            // Keep URL even if binary download fails
          }
        }
      } else if (lastPicError) {
        const classified = classifyPicError(lastPicError);
        profilePicture.status = classified.status;
        profilePicture.statusReasonArabic = classified.reason;
      }
    }

    // Parse Status (About) from fetchStatus or USync IQ
    let statusText: string | undefined = usyncStatusText;
    let statusSetAt: string | undefined = usyncStatusSetAt;
    if (statusSettled.status === 'fulfilled' && statusSettled.value) {
      const rawStatus = statusSettled.value as unknown;
      const firstEntry = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
      if (firstEntry && typeof firstEntry === 'object') {
        const entryObj = firstEntry as Record<string, unknown>;
        const nestedStatus = entryObj.status;
        if (typeof nestedStatus === 'string') {
          statusText = nestedStatus.trim() || statusText;
          const rawDate = entryObj.setAt;
          if (rawDate) {
            const d = new Date(rawDate as string | number | Date);
            if (!Number.isNaN(d.getTime()) && d.getTime() > 0) {
              statusSetAt = d.toISOString();
            }
          }
        } else if (nestedStatus && typeof nestedStatus === 'object') {
          const inner = nestedStatus as Record<string, unknown>;
          if (typeof inner.status === 'string' && inner.status.trim()) {
            statusText = inner.status.trim();
          }
          const rawDate = inner.setAt ?? entryObj.setAt;
          if (rawDate) {
            const d = new Date(rawDate as string | number | Date);
            if (!Number.isNaN(d.getTime()) && d.getTime() > 0) {
              statusSetAt = d.toISOString();
            }
          }
        }
      }
    }

    // Parse Business Profile
    let businessProfile: WhatsAppFullProfileReport['businessProfile'];
    if (
      bizSettled.status === 'fulfilled' &&
      bizSettled.value &&
      typeof bizSettled.value === 'object'
    ) {
      const biz = bizSettled.value as WABusinessProfile;
      const hoursCfg =
        biz.business_hours?.config || biz.business_hours?.business_config || [];
      const hoursSummary = Array.isArray(hoursCfg)
        ? hoursCfg.map((h) => {
            const day = h.day_of_week || 'day';
            const mode = h.mode || 'open';
            if (
              typeof h.open_time === 'number' &&
              typeof h.close_time === 'number'
            ) {
              const openH = String(Math.floor(h.open_time / 60)).padStart(2, '0');
              const openM = String(h.open_time % 60).padStart(2, '0');
              const closeH = String(Math.floor(h.close_time / 60)).padStart(2, '0');
              const closeM = String(h.close_time % 60).padStart(2, '0');
              return `${day}: ${openH}:${openM} - ${closeH}:${closeM} (${mode})`;
            }
            return `${day}: ${mode}`;
          })
        : undefined;

      const hasBizFields = Boolean(
        biz.wid ||
          biz.description ||
          biz.category ||
          biz.email ||
          (Array.isArray(biz.website) && biz.website.length > 0) ||
          biz.address
      );
      if (hasBizFields) {
        businessProfile = {
          isBusiness: true,
          category: biz.category,
          description: biz.description,
          email: biz.email,
          website: Array.isArray(biz.website) ? biz.website : undefined,
          address: biz.address,
          latitude:
            typeof biz.latitude === 'number' ? biz.latitude : undefined,
          longitude:
            typeof biz.longitude === 'number' ? biz.longitude : undefined,
          timezone: biz.business_hours?.timezone,
          businessHoursSummary:
            hoursSummary && hoursSummary.length > 0 ? hoursSummary : undefined,
        };
      }
    }

    // Parse Linked Devices (merging getUSyncDevices + USync IQ <devices>)
    const rawDevices =
      devicesSettled.status === 'fulfilled' && Array.isArray(devicesSettled.value)
        ? devicesSettled.value
        : [];
    const primaryDevice: number[] = [];
    const companionDevices: number[] = [];
    const seenDevs = new Set<number>();
    const recordDeviceNumber = (devNum: number) => {
      if (seenDevs.has(devNum)) return;
      seenDevs.add(devNum);
      if (devNum === 0) {
        primaryDevice.push(0);
      } else {
        companionDevices.push(devNum);
      }
    };
    for (const d of rawDevices) {
      const devNum = typeof d?.device === 'number' ? d.device : 0;
      recordDeviceNumber(devNum);
    }
    for (const devId of usyncDeviceIds) {
      recordDeviceNumber(devId);
    }
    const deviceListFormatted = [
      ...primaryDevice.map((d) => `${d} (الهاتف الأساسي)`),
      ...companionDevices.map((d) => `${d} (جهاز مرافق Web/Desktop #${d})`),
    ];

    // Contact names & Presence snapshot
    const contactFromPn = pnJid
      ? (this.memoryStore.contacts.get(pnJid) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    const contactFromLid = lidJid
      ? (this.memoryStore.contacts.get(lidJid) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    const chatEntry =
      (pnJid ? this.memoryStore.chats.get(pnJid) : undefined) ||
      (lidJid ? this.memoryStore.chats.get(lidJid) : undefined);

    const pushName =
      (typeof contactFromPn?.notify === 'string' && contactFromPn.notify) ||
      (typeof contactFromLid?.notify === 'string' && contactFromLid.notify) ||
      (typeof contactFromPn?.name === 'string' && contactFromPn.name) ||
      (typeof contactFromLid?.name === 'string' && contactFromLid.name) ||
      chatEntry?.name ||
      undefined;

    const verifiedName =
      (typeof contactFromPn?.verifiedName === 'string' &&
        contactFromPn.verifiedName) ||
      (typeof contactFromLid?.verifiedName === 'string' &&
        contactFromLid.verifiedName) ||
      undefined;

    // Wait briefly (up to 150ms if not yet in store) for presence response
    let presenceRec =
      (pnJid ? this.memoryStore.presences.get(pnJid) : undefined) ||
      (lidJid ? this.memoryStore.presences.get(lidJid) : undefined);
    if (!presenceRec) {
      await new Promise((r) => setTimeout(r, 150));
      presenceRec =
        (pnJid ? this.memoryStore.presences.get(pnJid) : undefined) ||
        (lidJid ? this.memoryStore.presences.get(lidJid) : undefined);
    }

    // Shared Groups from groupMetadataCache (populating once via groupFetchAllParticipating if empty)
    if (
      this.groupMetadataCache.size === 0 &&
      typeof sock.groupFetchAllParticipating === 'function'
    ) {
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        if (allGroups && typeof allGroups === 'object') {
          for (const [gJid, gMeta] of Object.entries(allGroups)) {
            if (gMeta && typeof gMeta === 'object') {
              this.groupMetadataCache.set(gJid, gMeta as GroupMetadata);
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    const sharedGroups: WhatsAppFullProfileReport['sharedGroups'] = [];
    for (const meta of this.groupMetadataCache.values()) {
      for (const p of meta.participants || []) {
        const pId = p.id ? jidNormalizedUser(p.id) : '';
        const pLid = p.lid ? jidNormalizedUser(p.lid) : '';
        const pPn = (p as { phoneNumber?: string }).phoneNumber
          ? jidNormalizedUser((p as { phoneNumber?: string }).phoneNumber!)
          : '';
        const matchesUser =
          (pnJid &&
            ((pId && areJidsSameUser(pId, pnJid)) ||
              (pPn && areJidsSameUser(pPn, pnJid)))) ||
          (lidJid &&
            ((pLid && areJidsSameUser(pLid, lidJid)) ||
              (pId && areJidsSameUser(pId, lidJid))));
        if (matchesUser) {
          const role: 'superadmin' | 'admin' | 'member' =
            p.admin === 'superadmin'
              ? 'superadmin'
              : p.admin === 'admin'
                ? 'admin'
                : 'member';
          sharedGroups.push({
            groupJid: meta.id,
            subject: meta.subject || meta.id,
            role,
          });
          break;
        }
      }
    }

    const finalPnJid = pnJid || targetQueryJid;
    const digitsOnly = (jidDecode(finalPnJid)?.user || finalPnJid.split('@')[0]).replace(
      /\D/g,
      ''
    );
    const e164Phone = digitsOnly ? `+${digitsOnly}` : finalPnJid;

    return {
      queriedInput: recipient,
      existsOnWhatsApp,
      pnJid: finalPnJid,
      e164Phone,
      lidJid,
      pushName,
      verifiedName,
      statusText,
      statusSetAt,
      ...(pictureId ? { pictureId } : {}),
      profilePicture,
      ...(disappearingMode ? { disappearingMode } : {}),
      presence: {
        currentState: presenceRec?.currentState || 'unknown',
        lastSeenIso:
          presenceRec?.lastSeenTimestampSec &&
          presenceRec.lastSeenTimestampSec > 0
            ? new Date(presenceRec.lastSeenTimestampSec * 1000).toISOString()
            : undefined,
      },
      devices: {
        totalCount: primaryDevice.length + companionDevices.length,
        primaryDevice,
        companionDevices,
        deviceListFormatted,
      },
      businessProfile,
      sharedGroups,
      fetchedAtIso: new Date().toISOString(),
    };
  }

  /**
   * Sends a short-timer self-destructing message (`1` to `60` seconds) using a 3-layer hybrid mechanism:
   * 1. Optional `<iq xmlns="w:g2" type="set"><ephemeral expiration="N" trigger="1"/></iq>` stanza (only for `@g.us` groups or when explicitly requested)
   * 2. Protobuf `contextInfo.expiration = expirationSeconds` via `{ ephemeralExpiration: expirationSeconds }`
   * 3. Deterministic auto-revoke timer (`REVOKE` protocolMessage) triggered `ON_SEND` or `ON_READ` (`messages.update` status 4/5 or `message-receipt.update`).
   */
  public async sendShortEphemeralMessage(params: {
    recipient: string;
    text: string;
    expirationSeconds: number;
    triggerMode?: 'ON_SEND' | 'ON_READ';
    setChatEphemeralIq?: boolean;
  }): Promise<{
    messageId: string;
    targetJid: string;
    expirationSeconds: number;
    triggerMode: 'ON_SEND' | 'ON_READ';
    scheduledRevokeAtIso: string;
  }> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'الجلسة غير متصلة حالياً لإرسال رسائل التدمير الذاتي.'
      );
    }

    const expSec = Math.floor(Number(params.expirationSeconds));
    if (!Number.isFinite(expSec) || expSec < 1 || expSec > 60) {
      throw new ValidationError(
        'مدة التدمير الذاتي القصير يجب أن تكون بين 1 و60 ثانية.'
      );
    }

    const triggerMode: 'ON_SEND' | 'ON_READ' =
      params.triggerMode === 'ON_READ' ? 'ON_READ' : 'ON_SEND';

    // Keep PN JID (`@s.whatsapp.net`) when user provides a phone number so both sendMessage and delete
    // use the exact same JID; only use `@lid` if the caller explicitly passed `@lid`.
    const validated = validateRecipient(params.recipient);
    const resolvedJid = validated.jid.endsWith('@s.whatsapp.net')
      ? await this.resolveDirectRecipientJid(sock, validated.jid)
      : jidNormalizedUser(validated.jid);

    // Layer 1: Only send <iq xmlns="w:g2" type="set"><ephemeral .../></iq> for groups (@g.us)
    // or when explicitly requested via setChatEphemeralIq: true (since w:g2 on 1:1 chats returns 400).
    const shouldSendGroupEphemeralIq =
      params.setChatEphemeralIq === true ||
      (params.setChatEphemeralIq !== false && resolvedJid.endsWith('@g.us'));
    if (shouldSendGroupEphemeralIq && typeof sock.query === 'function') {
      await sock
        .query({
          tag: 'iq',
          attrs: {
            to: resolvedJid,
            type: 'set',
            xmlns: 'w:g2',
          },
          content: [
            {
              tag: 'ephemeral',
              attrs: {
                expiration: String(expSec),
                trigger: '1',
              },
            },
          ],
        })
        .catch(() => undefined);
    }

    // Layer 2: Send message with ephemeralExpiration in contextInfo
    const res = await sock.sendMessage(
      resolvedJid,
      { text: params.text },
      { ephemeralExpiration: expSec }
    );

    const msgId = res?.key?.id || `eph_${Date.now()}`;
    const exactSentKey: WAMessageKey = {
      remoteJid: resolvedJid,
      fromMe: true,
      id: msgId,
      ...(res?.key || {}),
    };

    if (res?.message) {
      this.memoryStore.cacheSentMessage(resolvedJid, msgId, res.message);
    }

    // Layer 3: Guaranteed Protocol Auto-Revoke Timer
    const nowMs = Date.now();
    let scheduledRevokeAtMs = nowMs + expSec * 1000;

    if (triggerMode === 'ON_READ') {
      const fallbackDelaySec = Math.max(expSec * 3, 180);
      scheduledRevokeAtMs = nowMs + fallbackDelaySec * 1000;
      const fallbackTimer = setTimeout(() => {
        this.pendingOnReadRevokes.delete(msgId);
        this.scheduleEphemeralRevokeTimer(
          msgId,
          resolvedJid,
          exactSentKey,
          10
        );
      }, fallbackDelaySec * 1000);
      if (typeof fallbackTimer.unref === 'function') {
        fallbackTimer.unref();
      }
      this.pendingOnReadRevokes.set(msgId, {
        targetJid: resolvedJid,
        key: exactSentKey,
        expirationSeconds: expSec,
        fallbackTimer,
      });
    } else {
      this.scheduleEphemeralRevokeTimer(
        msgId,
        resolvedJid,
        exactSentKey,
        expSec * 1000
      );
    }

    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);

    return {
      messageId: msgId,
      targetJid: resolvedJid,
      expirationSeconds: expSec,
      triggerMode,
      scheduledRevokeAtIso: new Date(scheduledRevokeAtMs).toISOString(),
    };
  }

  public async sendNode(node: BinaryNode): Promise<void> {
    const sock = this.ensureSocket();
    if (typeof sock.sendNode === 'function') {
      await sock.sendNode(node);
    }
  }

  public async query(node: BinaryNode, timeoutMs?: number): Promise<unknown> {
    const sock = this.ensureSocket();
    if (typeof sock.query === 'function') {
      return await sock.query(node, timeoutMs);
    }
    return undefined;
  }

  public async forwardMessage(
    targetJid: string,
    messagePayloadOrRaw: Record<string, unknown>,
    options?: { forceForward?: boolean }
  ): Promise<{ messageId: string; forwarded: boolean }> {
    const sock = this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً لإعادة التوجيه.');
    }
    const cleanJid = targetJid.includes('@')
      ? targetJid
      : `${targetJid.replace(/\D/g, '')}@s.whatsapp.net`;

    const rawMessage = (messagePayloadOrRaw.rawMessage ||
      messagePayloadOrRaw) as Record<string, unknown>;

    let forwardContent: proto.IMessage | undefined;
    try {
      forwardContent = generateForwardMessageContent(
        rawMessage as never,
        options?.forceForward ?? true
      );
    } catch {
      const text = String(
        messagePayloadOrRaw.textContent ||
          messagePayloadOrRaw.text_content ||
          messagePayloadOrRaw.text ||
          ''
      );
      forwardContent = {
        extendedTextMessage: {
          text,
          contextInfo: {
            isForwarded: true,
            forwardingScore: 1,
          },
        },
      };
    }

    const waMsg = generateWAMessageFromContent(cleanJid, forwardContent, {
      userJid: sock.user?.id,
    });
    if (typeof sock.relayMessage === 'function') {
      await sock.relayMessage(cleanJid, waMsg.message!, {
        messageId: waMsg.key.id!,
      });
    } else {
      await sock.sendMessage(cleanJid, { forward: rawMessage as never, forceForward: true });
    }
    return { messageId: waMsg.key.id!, forwarded: true };
  }

  /**
   * Executes a custom `async function` in the isolated VM sandbox against the active `@hiroosy/baileys-lite` socket
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
        sendNode: async () => undefined,
        query: async () => ({ tag: 'iq', attrs: { type: 'result' }, content: [] }),
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
        sendNode: async (node: BinaryNode) => {
          if (typeof sock.sendNode === 'function') {
            await sock.sendNode(node);
          }
        },
        query: async (node: BinaryNode, timeoutMs?: number) => {
          if (typeof sock.query === 'function') {
            return await sock.query(node, timeoutMs);
          }
          return { tag: 'iq', attrs: { type: 'result' }, content: [] };
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
    this.authenticatedOpen = false;
    this.handshakeReady = false;
    this.connectionState = 'CLOSED';
    this.verifiedRecipientJids.clear();
    for (const timer of this.ephemeralRevokeTimers.values()) {
      clearTimeout(timer);
    }
    this.ephemeralRevokeTimers.clear();
    for (const pending of this.pendingOnReadRevokes.values()) {
      clearTimeout(pending.fallbackTimer);
    }
    this.pendingOnReadRevokes.clear();
    for (const cleanup of Array.from(this.activePresenceCleanups)) {
      try {
        cleanup();
      } catch {
        // Ignore
      }
    }
    this.activePresenceCleanups.clear();
    this.rejectHandshakeWaiters(
      new WhatsAppConnectionError('تم إغلاق مقبس واتساب.')
    );
    if (this.evCleanup) {
      this.evCleanup();
      this.evCleanup = null;
    }
    const sockToClose = this.sock;
    this.sock = null;
    if (sockToClose) {
      if (wasOpen && typeof sockToClose.sendPresenceUpdate === 'function') {
        await sockToClose.sendPresenceUpdate('unavailable').catch(() => undefined);
      }
      try {
        await Promise.resolve(sockToClose.end(undefined)).catch(() => undefined);
      } catch {
        // Ignore socket close error
      }
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

export { HiroosyBaileysSessionDriver as BaileysSessionDriver };

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
    ptv?: boolean;
    gifPlayback?: boolean;
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
    const prefix = params.ptv ? 'sim_ptv' : 'sim_media';
    return { messageId: `${prefix}_${this.sessionId}_${Date.now()}` };
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
    _state: WAPresence,
    _jid: string
  ): Promise<void> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
  }

  public readonly sentAnonymousLidMessages: Array<{
    recipient: string;
    targetLid: string;
    resolvedPn?: string;
    text: string;
    messageId: string;
  }> = [];

  public readonly sentShortEphemeralMessages: Array<{
    targetJid: string;
    text: string;
    expirationSeconds: number;
    triggerMode: 'ON_SEND' | 'ON_READ';
    messageId: string;
    revoked: boolean;
  }> = [];

  private readonly mockEphemeralTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  public async resolveLidForRecipient(targetInput: string): Promise<{
    pnJid?: string;
    lidJid: string;
    source:
      | 'DIRECT_LID'
      | 'LID_MAPPING_STORE'
      | 'ON_WHATSAPP_USYNC'
      | 'GROUP_PARTICIPANT_CACHE';
  }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const trimmed = String(targetInput || '').trim();
    if (trimmed.endsWith('@lid')) {
      const validated = validateRecipient(trimmed);
      return {
        lidJid: validated.jid,
        source: 'DIRECT_LID',
      };
    }
    const validated = validateRecipient(trimmed);
    const digits = validated.jid.split('@')[0].replace(/\D/g, '');
    const lidDigits = `1000${digits.slice(-10).padStart(10, '0')}`;
    return {
      pnJid: validated.jid,
      lidJid: `${lidDigits}@lid`,
      source: 'ON_WHATSAPP_USYNC',
    };
  }

  public async sendAnonymousLidMessage(params: {
    recipient: string;
    text: string;
    customPushName?: string;
  }): Promise<{
    messageId: string;
    targetLid: string;
    resolvedPn?: string;
    resolutionSource: string;
  }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const resolved = await this.resolveLidForRecipient(params.recipient);
    const messageId = `sim_lid_${this.sessionId}_${Date.now()}`;
    this.sentAnonymousLidMessages.push({
      recipient: params.recipient,
      targetLid: resolved.lidJid,
      resolvedPn: resolved.pnJid,
      text: params.text,
      messageId,
    });
    this.sentMessagesCount++;
    return {
      messageId,
      targetLid: resolved.lidJid,
      resolvedPn: resolved.pnJid,
      resolutionSource: resolved.source,
    };
  }

  public async trackRecipientPresence(params: {
    recipient: string;
    durationSeconds: number;
    onUpdate?: (record: TrackedPresenceRecord) => void;
    staleComposingTimeoutMs?: number;
  }): Promise<TrackedPresenceRecord> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const resolved = await this.resolveLidForRecipient(params.recipient);
    const chatJid = resolved.pnJid || resolved.lidJid;
    const now = Date.now();
    const record: TrackedPresenceRecord = {
      chatJid,
      resolvedLid: resolved.lidJid,
      currentState: 'available',
      lastSeenTimestampSec: Math.floor(now / 1000),
      lastUpdatedMs: now,
      transitions: [
        {
          state: 'available',
          timestampMs: now - 1500,
          participantJid: chatJid,
        },
        {
          state: 'composing',
          timestampMs: now - 800,
          participantJid: resolved.lidJid,
        },
        {
          state: 'available',
          timestampMs: now,
          participantJid: chatJid,
        },
      ],
      totalOnlineDurationMs: Math.min(params.durationSeconds * 1000, 3500),
    };
    params.onUpdate?.(record);
    return record;
  }

  public async startPresenceHeartbeatBroadcast(params: {
    recipient: string;
    mode: 'composing' | 'recording' | 'available';
    durationSeconds: number;
    pulseIntervalMs?: number;
  }): Promise<{
    pulsesSent: number;
    targetJid: string;
    durationMs: number;
  }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const validated = validateRecipient(params.recipient);
    const durationSec = Math.min(
      180,
      Math.max(1, Math.floor(Number(params.durationSeconds) || 15))
    );
    const intervalMs = Math.max(50, params.pulseIntervalMs ?? 7_500);
    const pulsesSent = Math.max(1, Math.ceil((durationSec * 1000) / intervalMs));
    return {
      pulsesSent,
      targetJid: validated.jid,
      durationMs: durationSec * 1000,
    };
  }

  public async fetchFullProfileInfo(
    recipient: string
  ): Promise<WhatsAppFullProfileReport> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const resolved = await this.resolveLidForRecipient(recipient);
    const pnJid = resolved.pnJid || resolved.lidJid;
    const digits = pnJid.split('@')[0].replace(/\D/g, '');
    const e164Phone = digits ? `+${digits}` : pnJid;

    return {
      queriedInput: recipient,
      existsOnWhatsApp: true,
      pnJid,
      e164Phone,
      lidJid: resolved.lidJid,
      pushName: `مستخدم واتساب (${digits.slice(-4) || 'LID'})`,
      verifiedName: 'حساب موثق تجريبي',
      statusText: 'متاح عبر بروتوكول WhatsApp Multi-Device',
      statusSetAt: new Date(Date.now() - 86_400_000).toISOString(),
      profilePicture: {
        hdUrl: `https://pps.whatsapp.net/v/t61.24694-24/mock_hd_${digits || 'user'}.jpg`,
        previewUrl: `https://pps.whatsapp.net/v/t61.24694-24/mock_prev_${digits || 'user'}.jpg`,
        status: 'AVAILABLE',
        statusReasonArabic: 'متاحة بدقة عالية (HD - محاكاة)',
      },
      presence: {
        currentState: 'available',
        lastSeenIso: new Date().toISOString(),
      },
      devices: {
        totalCount: 2,
        primaryDevice: [0],
        companionDevices: [33],
        deviceListFormatted: [
          '0 (الهاتف الأساسي)',
          '33 (جهاز مرافق Web/Desktop #33)',
        ],
      },
      businessProfile: {
        isBusiness: true,
        category: 'تقنية المعلومات والاتصالات',
        description: 'حساب أعمال رسمي عبر واتساب للأعمال',
        email: 'contact@example.com',
        website: ['https://example.com'],
        address: 'الرياض، المملكة العربية السعودية',
        timezone: 'Asia/Riyadh',
        businessHoursSummary: ['sun: 09:00 - 17:00 (specific_hours)'],
      },
      sharedGroups: [
        {
          groupJid: '120363041001@g.us',
          subject: 'مجموعة العمليات والتنسيق الإداري',
          role: 'admin',
        },
      ],
      fetchedAtIso: new Date().toISOString(),
    };
  }

  public async sendShortEphemeralMessage(params: {
    recipient: string;
    text: string;
    expirationSeconds: number;
    triggerMode?: 'ON_SEND' | 'ON_READ';
    setChatEphemeralIq?: boolean;
  }): Promise<{
    messageId: string;
    targetJid: string;
    expirationSeconds: number;
    triggerMode: 'ON_SEND' | 'ON_READ';
    scheduledRevokeAtIso: string;
  }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const expSec = Math.floor(Number(params.expirationSeconds));
    if (!Number.isFinite(expSec) || expSec < 1 || expSec > 60) {
      throw new ValidationError(
        'مدة التدمير الذاتي القصير يجب أن تكون بين 1 و60 ثانية.'
      );
    }
    const validated = validateRecipient(params.recipient);
    const triggerMode: 'ON_SEND' | 'ON_READ' =
      params.triggerMode === 'ON_READ' ? 'ON_READ' : 'ON_SEND';
    const messageId = `sim_eph_${this.sessionId}_${Date.now()}`;
    const entry = {
      targetJid: validated.jid,
      text: params.text,
      expirationSeconds: expSec,
      triggerMode,
      messageId,
      revoked: false,
    };
    this.sentShortEphemeralMessages.push(entry);
    this.sentMessagesCount++;

    const timer = setTimeout(() => {
      entry.revoked = true;
      this.mockEphemeralTimers.delete(messageId);
    }, expSec * 1000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.mockEphemeralTimers.set(messageId, timer);

    return {
      messageId,
      targetJid: validated.jid,
      expirationSeconds: expSec,
      triggerMode,
      scheduledRevokeAtIso: new Date(Date.now() + expSec * 1000).toISOString(),
    };
  }

  public readonly sentNodes: BinaryNode[] = [];
  public readonly sentCallOffers: Array<{
    targetJid: string;
    isVideo: boolean;
    callId: string;
  }> = [];
  public readonly terminatedCalls: Array<{
    targetJid: string;
    callId: string;
  }> = [];

  public async sendNode(node: BinaryNode): Promise<void> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    this.sentNodes.push(node);
    this.sentMessagesCount++;
  }

  public async query(node: BinaryNode, _timeoutMs?: number): Promise<unknown> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    this.sentNodes.push(node);
    return { tag: 'iq', attrs: { type: 'result' }, content: [] };
  }

  public async recordSimulatedVoipCallOffer(
    targetJid: string,
    options?: { callId?: string; isVideo?: boolean }
  ): Promise<{ callId: string }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً لإرسال رنين المكالمة.');
    }
    const callId = (
      options?.callId || crypto.randomBytes(16).toString('hex')
    ).toUpperCase();
    const isVideo = options?.isVideo !== false;

    this.sentCallOffers.push({
      targetJid,
      isVideo,
      callId,
    });
    this.sentMessagesCount++;
    return { callId };
  }

  public async recordSimulatedVoipCallTermination(
    targetJid: string,
    callId: string
  ): Promise<void> {
    this.terminatedCalls.push({
      targetJid,
      callId,
    });
  }

  public readonly forwardedMessages: Array<{
    targetJid: string;
    messageId: string;
    isForwarded: boolean;
    rawPayload: Record<string, unknown>;
  }> = [];

  public async forwardMessage(
    targetJid: string,
    messagePayloadOrRaw: Record<string, unknown>,
    _options?: { forceForward?: boolean }
  ): Promise<{ messageId: string; forwarded: boolean }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً لإعادة التوجيه.');
    }
    const cleanJid = targetJid.includes('@')
      ? targetJid
      : `${targetJid.replace(/\D/g, '')}@s.whatsapp.net`;
    const messageId = `sim_fwd_${Date.now()}`;
    this.forwardedMessages.push({
      targetJid: cleanJid,
      messageId,
      isForwarded: true,
      rawPayload: messagePayloadOrRaw,
    });
    this.sentMessagesCount++;
    return { messageId, forwarded: true };
  }

  public simulateIncomingMessage(rawMessage: Record<string, unknown>): void {
    this.callbacks?.onIncomingMessage?.({
      sessionId: this.sessionId,
      rawMessage,
    });
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
        sendNode: async (node: BinaryNode) => {
          if (!isOfflineSafeMode) {
            this.sentNodes.push(node);
            this.sentMessagesCount++;
          }
        },
        query: async (node: BinaryNode) => {
          if (!isOfflineSafeMode) {
            this.sentNodes.push(node);
          }
          return { tag: 'iq', attrs: { type: 'result' }, content: [] };
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
    for (const timer of this.mockEphemeralTimers.values()) {
      clearTimeout(timer);
    }
    this.mockEphemeralTimers.clear();
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

