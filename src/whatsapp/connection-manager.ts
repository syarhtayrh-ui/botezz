import fs from 'node:fs';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  jidEncode,
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
  USyncQuery,
  USyncUser,
  type USyncQueryResultItem,
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
  getNetworkTrafficMonitor,
  InspectableBinaryNode,
} from '../network/network-traffic-monitor';
import {
  ForensicPayloadAnalyzer,
  getForensicPayloadAnalyzer,
  hookSignalRepositoryForForensics,
  RawForensicEventType,
  sanitizeIncomingMessageForDownstream,
} from '../security/forensic-payload-analyzer';
import {
  SupportedMediaKind,
  validateCustomPairingCode,
  generateRandomPairingCode,
  normalizePhoneNumber,
  validateRecipient,
} from '../security/validation';
import {
  DeviceActivityTracker,
  PresenceWatchReport,
  RttProbeSample,
  DeviceActivityState,
  ActivePresenceTrackerRegistry,
  getActivePresenceTrackerRegistry,
  parseTrackerJid,
  matchesTrackedTargetJid,
  computeRttTelemetryStats,
  classifyDeviceActivityState,
  renderRttSparkline,
} from './device-activity-tracker';
import {
  WhatsAppIdentityService,
  PrivacyTokenManager,
  LidResolutionResult,
  LidResolutionSource,
  PrivacyTokenRecord,
  ReachoutDiagnostic,
  ReachoutFailureReason,
  WhatsAppUsernameState,
  UsernameRecommendationResult,
  SendLidAddressedParams,
  SendLidAddressedResult,
  emitIdentityTelemetry,
} from './identity-privacy-service';
import type { ReachoutTimelockInfo } from './baileys-compat';

export type {
  PresenceWatchReport,
  RttProbeSample,
  DeviceActivityState,
  LidResolutionResult,
  LidResolutionSource,
  PrivacyTokenRecord,
  ReachoutDiagnostic,
  ReachoutFailureReason,
  WhatsAppUsernameState,
  UsernameRecommendationResult,
  SendLidAddressedParams,
  SendLidAddressedResult,
  ReachoutTimelockInfo,
};
export {
  DeviceActivityTracker,
  ActivePresenceTrackerRegistry,
  getActivePresenceTrackerRegistry,
  parseTrackerJid,
  matchesTrackedTargetJid,
  computeRttTelemetryStats,
  classifyDeviceActivityState,
  renderRttSparkline,
  WhatsAppIdentityService,
  PrivacyTokenManager,
  emitIdentityTelemetry,
};
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
  activityState?: DeviceActivityState;
  timestampMs: number;
  participantJid: string;
  deviceJid?: string;
  deviceId?: number;
  rttMs?: number;
  source?:
    | 'presence'
    | 'chatstate'
    | 'message'
    | 'receipt'
    | 'usync_probe'
    | 'rtt_probe';
}

export interface TrackedPresenceRecord {
  watchId?: string;
  sessionId?: string;
  targetPhone?: string;
  chatJid: string;
  resolvedLid?: string;
  currentState: WAPresence;
  deviceActivityState?: DeviceActivityState;
  lastSeenTimestampSec?: number;
  lastUpdatedMs: number;
  transitions: PresenceStateTransition[];
  totalOnlineDurationMs: number;
  onlineSessionStartedAtMs?: number;
  probeRttMs?: number;
  lastRttMs?: number;
  movingAvgRttMs?: number;
  avgRttMs?: number;
  medianRttMs?: number;
  minRttMs?: number;
  maxRttMs?: number;
  dynamicThresholdMs?: number;
  jitterMs?: number;
  probesSent?: number;
  probesAcked?: number;
  probesTimedOut?: number;
  deliveryRatePct?: number;
  rttSamples?: RttProbeSample[];
  rttHistory?: number[];
  sparkline?: string;
  detectedDevices?: string[];
  respondingDevices?: string[];
  linkedDevices?: string[];
  activeDevices?: string[];
  privacyLastSeenDenied?: boolean;
  startedAtMs?: number;
  endedAtMs?: number;
  elapsedSeconds?: number;
  targetDurationSeconds?: number;
  activeDurationMs?: number;
  standbyDurationMs?: number;
  offlineDurationMs?: number;
  stoppedEarly?: boolean;
  lastActivitySource?:
    | 'presence'
    | 'chatstate'
    | 'message'
    | 'receipt'
    | 'usync_probe'
    | 'rtt_probe';
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
    deviceJid?: string;
    source?: 'presence' | 'chatstate' | 'message' | 'receipt' | 'usync_probe';
    privacyLastSeenDenied?: boolean;
    probeRttMs?: number;
    linkedDevices?: string[];
  }): TrackedPresenceRecord {
    const now = params.timestampMs ?? Date.now();
    const rawChat = jidNormalizedUser(params.chatJid);
    const rawParticipantInput = params.participantJid || params.chatJid;
    const rawParticipant = jidNormalizedUser(rawParticipantInput);
    const rawDeviceCandidate =
      params.deviceJid ||
      (rawParticipantInput && rawParticipantInput.includes(':')
        ? rawParticipantInput
        : params.chatJid && params.chatJid.includes(':')
          ? params.chatJid
          : undefined);

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

    // Guard against baileys-lite's internal `if (type === 'paused') type = 'available'` rewrite
    // overwriting a raw `CB:chatstate` `<paused/>` transition captured milliseconds earlier.
    let effectiveState = params.state;
    if (
      existing.currentState === 'paused' &&
      existing.lastActivitySource === 'chatstate' &&
      params.state === 'available' &&
      (!params.source || params.source === 'presence') &&
      Math.abs(now - existing.lastUpdatedMs) < 250
    ) {
      effectiveState = 'paused';
    }

    const isOnlineState =
      effectiveState === 'available' ||
      effectiveState === 'composing' ||
      effectiveState === 'recording' ||
      effectiveState === 'paused';

    const wasPreviouslyOnline =
      existing.onlineSessionStartedAtMs !== undefined ||
      existing.currentState === 'available' ||
      existing.currentState === 'composing' ||
      existing.currentState === 'recording' ||
      existing.currentState === 'paused';

    let totalOnlineDurationMs = existing.totalOnlineDurationMs;
    let onlineSessionStartedAtMs = existing.onlineSessionStartedAtMs;

    if (isOnlineState) {
      if (onlineSessionStartedAtMs === undefined) {
        onlineSessionStartedAtMs = now;
      }
    } else if (effectiveState === 'unavailable') {
      if (onlineSessionStartedAtMs !== undefined) {
        totalOnlineDurationMs += Math.max(0, now - onlineSessionStartedAtMs);
        onlineSessionStartedAtMs = undefined;
      }
    }

    const transitions = [...existing.transitions];
    const lastTransition = transitions[transitions.length - 1];
    if (!lastTransition || lastTransition.state !== effectiveState) {
      transitions.push({
        state: effectiveState,
        timestampMs: now,
        participantJid: rawParticipant,
        deviceJid: rawDeviceCandidate,
        source: params.source || 'presence',
      });
      if (transitions.length > 50) {
        transitions.shift();
      }
    } else if (lastTransition && rawDeviceCandidate && !lastTransition.deviceJid) {
      lastTransition.deviceJid = rawDeviceCandidate;
    }

    const computedLastSeenSec =
      typeof params.lastSeen === 'number' && params.lastSeen > 0
        ? params.lastSeen
        : effectiveState === 'unavailable' && wasPreviouslyOnline
          ? Math.floor(now / 1000)
          : existing.lastSeenTimestampSec;

    const activeDevicesSet = new Set<string>(existing.activeDevices || []);
    if (rawDeviceCandidate) {
      activeDevicesSet.add(rawDeviceCandidate);
    } else if (isOnlineState && rawParticipant) {
      activeDevicesSet.add(rawParticipant);
    }

    const linkedDevicesSet = new Set<string>(existing.linkedDevices || []);
    if (Array.isArray(params.linkedDevices)) {
      for (const dev of params.linkedDevices) {
        if (dev) linkedDevicesSet.add(dev);
      }
    }

    const probeRttMs =
      typeof params.probeRttMs === 'number' && params.probeRttMs >= 0
        ? params.probeRttMs
        : existing.probeRttMs;
    const minRttMs =
      typeof probeRttMs === 'number'
        ? existing.minRttMs !== undefined
          ? Math.min(existing.minRttMs, probeRttMs)
          : probeRttMs
        : existing.minRttMs;
    const maxRttMs =
      typeof probeRttMs === 'number'
        ? existing.maxRttMs !== undefined
          ? Math.max(existing.maxRttMs, probeRttMs)
          : probeRttMs
        : existing.maxRttMs;

    const privacyLastSeenDenied =
      params.privacyLastSeenDenied === true
        ? true
        : typeof params.lastSeen === 'number' && params.lastSeen > 0
          ? false
          : existing.privacyLastSeenDenied;

    const updated: TrackedPresenceRecord = {
      ...existing,
      chatJid: primaryChatJid,
      resolvedLid: mappedLid || existing.resolvedLid,
      currentState: effectiveState,
      lastSeenTimestampSec: computedLastSeenSec,
      lastUpdatedMs: now,
      transitions,
      totalOnlineDurationMs,
      onlineSessionStartedAtMs,
      probeRttMs,
      minRttMs,
      maxRttMs,
      linkedDevices: linkedDevicesSet.size > 0 ? Array.from(linkedDevicesSet) : existing.linkedDevices,
      activeDevices: activeDevicesSet.size > 0 ? Array.from(activeDevicesSet) : existing.activeDevices,
      privacyLastSeenDenied,
      lastActivitySource: params.source || existing.lastActivitySource || 'presence',
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

  public updatePresenceTelemetry(
    chatJid: string,
    telemetry: {
      probeRttMs?: number;
      linkedDevices?: string[];
      activeDevices?: string[];
      privacyLastSeenDenied?: boolean;
      elapsedSeconds?: number;
      targetDurationSeconds?: number;
      notify?: boolean;
    }
  ): TrackedPresenceRecord {
    const rawChat = jidNormalizedUser(chatJid);
    const mappedPn = rawChat.endsWith('@lid') ? this.lidToPnMap.get(rawChat) : undefined;
    const mappedLid = rawChat.endsWith('@lid')
      ? rawChat
      : this.pnToLidMap.get(rawChat);
    const primaryChatJid = mappedPn || rawChat;
    const now = Date.now();
    const existing = this.presences.get(primaryChatJid) ||
      (mappedLid ? this.presences.get(mappedLid) : undefined) || {
        chatJid: primaryChatJid,
        resolvedLid: mappedLid,
        currentState: 'unavailable' as WAPresence,
        lastUpdatedMs: now,
        transitions: [],
        totalOnlineDurationMs: 0,
      };

    const linkedSet = new Set<string>(existing.linkedDevices || []);
    if (Array.isArray(telemetry.linkedDevices)) {
      for (const d of telemetry.linkedDevices) {
        if (d) linkedSet.add(d);
      }
    }

    const activeSet = new Set<string>(existing.activeDevices || []);
    if (Array.isArray(telemetry.activeDevices)) {
      for (const d of telemetry.activeDevices) {
        if (d) activeSet.add(d);
      }
    }

    const probeRttMs =
      typeof telemetry.probeRttMs === 'number' && telemetry.probeRttMs >= 0
        ? telemetry.probeRttMs
        : existing.probeRttMs;
    const minRttMs =
      typeof probeRttMs === 'number'
        ? existing.minRttMs !== undefined
          ? Math.min(existing.minRttMs, probeRttMs)
          : probeRttMs
        : existing.minRttMs;
    const maxRttMs =
      typeof probeRttMs === 'number'
        ? existing.maxRttMs !== undefined
          ? Math.max(existing.maxRttMs, probeRttMs)
          : probeRttMs
        : existing.maxRttMs;

    const updated: TrackedPresenceRecord = {
      ...existing,
      chatJid: primaryChatJid,
      resolvedLid: mappedLid || existing.resolvedLid,
      probeRttMs,
      minRttMs,
      maxRttMs,
      linkedDevices: linkedSet.size > 0 ? Array.from(linkedSet) : existing.linkedDevices,
      activeDevices: activeSet.size > 0 ? Array.from(activeSet) : existing.activeDevices,
      privacyLastSeenDenied:
        telemetry.privacyLastSeenDenied !== undefined
          ? telemetry.privacyLastSeenDenied
          : existing.privacyLastSeenDenied,
      elapsedSeconds:
        telemetry.elapsedSeconds !== undefined
          ? telemetry.elapsedSeconds
          : existing.elapsedSeconds,
      targetDurationSeconds:
        telemetry.targetDurationSeconds !== undefined
          ? telemetry.targetDurationSeconds
          : existing.targetDurationSeconds,
    };

    this.presences.set(primaryChatJid, updated);
    if (updated.resolvedLid) {
      this.presences.set(updated.resolvedLid, updated);
    }

    if (telemetry.notify) {
      const liveSnapshot: TrackedPresenceRecord =
        updated.onlineSessionStartedAtMs !== undefined
          ? {
              ...updated,
              totalOnlineDurationMs:
                updated.totalOnlineDurationMs +
                Math.max(0, now - updated.onlineSessionStartedAtMs),
            }
          : updated;
      const notifyTargets = new Set<string>([primaryChatJid, rawChat]);
      if (updated.resolvedLid) notifyTargets.add(updated.resolvedLid);
      for (const targetKey of notifyTargets) {
        const listeners = this.presenceListeners.get(targetKey);
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(liveSnapshot);
            } catch {
              // Ignore listener errors
            }
          }
        }
      }
      return liveSnapshot;
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
      type,
    }: {
      messages: Array<{
        key?: {
          remoteJid?: string | null;
          id?: string | null;
          fromMe?: boolean | null;
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

        // Cross-signal activity inference: incoming live message proves target is active right now
        if (
          !msg?.key?.fromMe &&
          type === 'notify' &&
          (chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid'))
        ) {
          try {
            this.applyPresenceTransition({
              chatJid: chatId,
              participantJid: msg.key?.participant || chatId,
              deviceJid: msg.key?.participant || chatId,
              state: 'available',
              source: 'message',
            });
          } catch {
            // Ignore presence inference error
          }
        }

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
          deviceJid: participant || update.id,
          state,
          lastSeen: pData?.lastSeen,
          source: 'presence',
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
  preparePeerForVoipCall?(targetInput: string): Promise<{
    dialTargetJid: string;
    pnJid?: string;
    lidJid?: string;
    deviceJids: string[];
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
    usedLid?: boolean;
  }>;
  getIdentityService?(): WhatsAppIdentityService;
  resolveIdentity?(
    targetInput: string,
    options?: { usernameKey?: string }
  ): Promise<LidResolutionResult | null>;
  sendLidAddressedMessage?(
    params: SendLidAddressedParams
  ): Promise<SendLidAddressedResult>;
  getPrivacyTokenInfo?(targetJid: string): Promise<PrivacyTokenRecord | null>;
  ensurePrivacyToken?(
    targetJid: string,
    forceRefresh?: boolean
  ): Promise<{ record: PrivacyTokenRecord | null; refreshed: boolean }>;
  getReachoutStatus?(): Promise<ReachoutTimelockInfo>;
  checkUsername?(
    handle: string,
    pin?: string
  ): Promise<WhatsAppUsernameState>;
  setUsername?(handle: string): Promise<WhatsAppUsernameState>;
  deleteUsername?(): Promise<WhatsAppUsernameState>;
  setUsernamePin?(pin: string): Promise<WhatsAppUsernameState>;
  recommendUsername?(seed?: string): Promise<UsernameRecommendationResult>;
  getSelfUsernameState?(): Promise<WhatsAppUsernameState>;
  deliverRelayPayload?(params: {
    targetJid: string;
    preferLid?: boolean;
    content: AnyMessageContent;
    quotedMessageId?: string;
    customPushName?: string;
  }): Promise<{
    messageId: string;
    deliveredToJid: string;
    addressingMode: 'lid' | 'pn';
  }>;
  trackRecipientPresence(params: {
    recipient: string;
    durationSeconds: number;
    onUpdate?: (record: TrackedPresenceRecord) => void;
    staleComposingTimeoutMs?: number;
  }): Promise<TrackedPresenceRecord>;
  stopTrackingRecipientPresence?(recipient?: string): number;
  startPresenceHeartbeatBroadcast(params: {
    recipient: string;
    mode: 'composing' | 'recording' | 'available';
    durationSeconds: number;
    pulseIntervalMs?: number;
    onProgress?: (info: {
      pulsesSent: number;
      elapsedSeconds: number;
      durationSeconds: number;
      mode: 'composing' | 'recording' | 'available';
      targetJid: string;
    }) => void;
  }): Promise<{
    pulsesSent: number;
    targetJid: string;
    durationMs: number;
  }>;
  stopPresenceHeartbeat?(recipient?: string): number;
  fetchFullProfileInfo(recipient: string): Promise<WhatsAppFullProfileReport>;
  sendShortEphemeralMessage(params: {
    recipient: string;
    text: string;
    expirationSeconds: number;
    triggerMode?: 'ON_SEND' | 'ON_READ';
    setChatEphemeralIq?: boolean;
    useRevokeDelete?: boolean;
    viewOnce?: boolean;
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
  private readonly activePresenceTrackersByKey = new Map<string, Set<() => void>>();
  private readonly activePresenceHeartbeatsByKey = new Map<string, Set<() => void>>();
  public messageSender?: MessageSender;
  public readonly identityService: WhatsAppIdentityService;

  constructor(
    public readonly sessionId: string,
    private readonly authDir: string,
    optionsOrSender?: MessageSender | { messageSender?: MessageSender }
  ) {
    this.messageSender =
      optionsOrSender instanceof MessageSender
        ? optionsOrSender
        : optionsOrSender?.messageSender;
    this.identityService = new WhatsAppIdentityService({
      sessionId: this.sessionId,
      getSocket: () => this.sock,
      memoryStore: this.memoryStore,
      groupMetadataCache: this.groupMetadataCache,
    });
  }

  public getIdentityService(): WhatsAppIdentityService {
    return this.identityService;
  }

  private lastActiveIncomingStanza: BinaryNode | undefined;

  public get forensicAnalyzer(): ForensicPayloadAnalyzer {
    return getForensicPayloadAnalyzer();
  }

  public instrumentSignalRepositoryForForensics(sock: WASocket): void {
    hookSignalRepositoryForForensics({
      sessionId: this.sessionId,
      signalRepository: sock.signalRepository as unknown as
        | Record<string, unknown>
        | undefined,
      analyzer: this.forensicAnalyzer,
      getStanzaNode: () => this.lastActiveIncomingStanza,
    });
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
    this.instrumentSignalRepositoryForForensics(sock);
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
    const unbindTelemetry = this.instrumentSocketForTelemetry(sock);
    this.evCleanup = () => {
      unbind();
      unbindTelemetry();
      try {
        sock.ev.off('message-receipt.update', onReceipt as never);
        sock.ev.off('messages.update', onMessagesUpdate as never);
      } catch {
        // Ignore
      }
    };
    return this.evCleanup;
  }

  private instrumentSocketForTelemetry(sock: WASocket): () => void {
    const anySock = sock as unknown as Record<string, unknown> & {
      __botezzTelemetryInstrumented?: boolean;
      ws?: {
        on?: (event: string, cb: (node: unknown) => void) => void;
        off?: (event: string, cb: (node: unknown) => void) => void;
        prependListener?: (event: string, cb: (node: unknown) => void) => void;
      };
    };
    if (anySock.__botezzTelemetryInstrumented) {
      return () => undefined;
    }
    anySock.__botezzTelemetryInstrumented = true;
    this.instrumentSignalRepositoryForForensics(sock);
    const monitor = getNetworkTrafficMonitor();

    if (typeof sock.query === 'function') {
      const origQuery = sock.query.bind(sock);
      sock.query = async (node: BinaryNode, timeoutMs?: number) => {
        const start = Date.now();
        try {
          const res = await origQuery(node, timeoutMs);
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: node as unknown as InspectableBinaryNode,
            responseNode:
              res && typeof res === 'object' && 'tag' in (res as object)
                ? (res as InspectableBinaryNode)
                : undefined,
            durationMs: Date.now() - start,
          });
          return res;
        } catch (err) {
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: node as unknown as InspectableBinaryNode,
            durationMs: Date.now() - start,
            statusCode: 'ERR',
            errorDetail: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    }

    if (typeof sock.sendNode === 'function') {
      const origSendNode = sock.sendNode.bind(sock);
      sock.sendNode = async (node: BinaryNode) => {
        const start = Date.now();
        try {
          await origSendNode(node);
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: node as unknown as InspectableBinaryNode,
            durationMs: Date.now() - start,
          });
        } catch (err) {
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: node as unknown as InspectableBinaryNode,
            durationMs: Date.now() - start,
            statusCode: 'ERR',
            errorDetail: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    }

    if (typeof sock.sendMessage === 'function') {
      const origSendMessage = sock.sendMessage.bind(sock);
      sock.sendMessage = async (jid, content, options) => {
        const start = Date.now();
        const contentKeys =
          content && typeof content === 'object' ? Object.keys(content) : ['text'];
        const syntheticNode: InspectableBinaryNode = {
          tag: 'message',
          attrs: {
            to: jid,
            type: contentKeys[0] || 'text',
          },
          content: [
            {
              tag: contentKeys[0] || 'body',
              attrs: {},
              content:
                typeof (content as { text?: string })?.text === 'string'
                  ? (content as { text: string }).text.slice(0, 200)
                  : `[${contentKeys.join(', ')}]`,
            },
          ],
        };
        try {
          const res = await origSendMessage(jid, content, options);
          if (res?.key?.id && syntheticNode.attrs) {
            syntheticNode.attrs.id = res.key.id;
          }
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: syntheticNode,
            durationMs: Date.now() - start,
            statusCode: 'SENT',
          });
          return res;
        } catch (err) {
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: syntheticNode,
            durationMs: Date.now() - start,
            statusCode: 'ERR',
            errorDetail: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    }

    if (typeof sock.relayMessage === 'function') {
      const origRelayMessage = sock.relayMessage.bind(sock);
      sock.relayMessage = async (jid, message, options) => {
        const start = Date.now();
        const msgKeys =
          message && typeof message === 'object' ? Object.keys(message) : ['proto'];
        const syntheticNode: InspectableBinaryNode = {
          tag: 'message',
          attrs: {
            to: jid,
            id:
              typeof options?.messageId === 'string'
                ? options.messageId
                : undefined,
            addressing_mode:
              typeof options?.addressingMode === 'string'
                ? options.addressingMode
                : typeof (options?.additionalAttributes as Record<string, unknown> | undefined)
                      ?.addressing_mode === 'string'
                  ? String(
                      (options?.additionalAttributes as Record<string, unknown>)
                        .addressing_mode
                    )
                  : undefined,
          },
          content: [
            {
              tag: 'enc',
              attrs: { type: 'msg', proto: msgKeys[0] || 'message' },
              content: '[Signal Encrypted Message]',
            },
          ],
        };
        try {
          const res = await origRelayMessage(jid, message, options);
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: syntheticNode,
            durationMs: Date.now() - start,
            statusCode: 'RELAYED',
          });
          return res;
        } catch (err) {
          monitor.recordWhatsAppStanza({
            sessionId: this.sessionId,
            direction: 'OUTBOUND',
            node: syntheticNode,
            durationMs: Date.now() - start,
            statusCode: 'ERR',
            errorDetail: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    }

    if (typeof sock.getUSyncDevices === 'function') {
      const origGetUSyncDevices = sock.getUSyncDevices.bind(sock);
      sock.getUSyncDevices = async (
        jids: string[],
        useCache = true,
        ignoreZeroDevices = false
      ) => {
        const inputJids = Array.isArray(jids) ? jids.filter(Boolean) : [];
        let rawResults: Array<{
          user: string;
          device: number;
          server?: string;
          jid?: string;
        }> = [];
        try {
          const fetched = await origGetUSyncDevices(
            inputJids,
            useCache,
            ignoreZeroDevices
          );
          if (Array.isArray(fetched)) {
            rawResults = [...fetched];
          }
        } catch {
          rawResults = [];
        }

        const normalizeResultJid = (
          user: string,
          server: string,
          device?: number
        ): string => {
          const cleanUser = String(user || '').split(':')[0]?.split('_')[0] || '';
          const cleanServer = server || 's.whatsapp.net';
          const devNum =
            typeof device === 'number' && Number.isFinite(device) && device > 0
              ? device
              : undefined;
          return jidEncode(cleanUser, cleanServer, devNum);
        };

        for (const reqJid of inputJids) {
          const decoded = jidDecode(reqJid);
          const reqUser =
            decoded?.user || reqJid.split('@')[0]?.split(':')[0] || '';
          const reqServer =
            decoded?.server ||
            (reqJid.endsWith('@lid') ? 'lid' : 's.whatsapp.net');
          if (!reqUser) continue;

          if (typeof decoded?.device === 'number' && decoded.device >= 0) {
            const explicitJid = normalizeResultJid(
              reqUser,
              reqServer,
              decoded.device
            );
            if (!rawResults.some((r) => r.jid === explicitJid)) {
              rawResults.push({
                user: reqUser,
                server: reqServer,
                device: decoded.device,
                jid: explicitJid,
              });
            }
            continue;
          }

          let hasUserDevices = rawResults.some((r) => r?.user === reqUser);

          // If `@lid` device discovery returned empty or missed `userDevicesCache`,
          // resolve the counterpart `pnJid` (`@s.whatsapp.net`) and query USync via `pnJid`.
          if (
            !hasUserDevices &&
            (reqServer === 'lid' || reqServer === 'hosted.lid')
          ) {
            const normLid = jidNormalizedUser(reqJid);
            const mappedPn =
              this.memoryStore.getPnForLid(normLid) ||
              (await sock.signalRepository?.lidMapping
                ?.getPNForLID?.(normLid)
                .catch(() => undefined)) ||
              undefined;
            if (mappedPn) {
              const normPn = jidNormalizedUser(mappedPn);
              const pnUser = normPn.split('@')[0]?.split(':')[0] || '';
              this.memoryStore.recordLidMapping(normLid, normPn);
              const alreadyFetchedPnDevs = pnUser
                ? rawResults.filter((r) => r?.user === pnUser)
                : [];
              const pnWasInInput = inputJids.some(
                (j) => jidNormalizedUser(j) === normPn
              );
              const pnDevices =
                alreadyFetchedPnDevs.length > 0
                  ? alreadyFetchedPnDevs
                  : await origGetUSyncDevices(
                      [normPn],
                      false,
                      ignoreZeroDevices
                    ).catch(() => []);
              if (Array.isArray(pnDevices) && pnDevices.length > 0) {
                for (const pd of pnDevices) {
                  const devNum =
                    typeof pd?.device === 'number' && Number.isFinite(pd.device)
                      ? pd.device
                      : 0;
                  rawResults.push({
                    user: reqUser,
                    server: reqServer,
                    device: devNum,
                    jid: normalizeResultJid(reqUser, reqServer, devNum),
                  });
                }
                hasUserDevices = true;
              }
              if (
                !pnWasInInput &&
                typeof sock.signalRepository?.migrateSession === 'function'
              ) {
                await sock.signalRepository
                  .migrateSession(normPn, normLid)
                  .catch(() => undefined);
              }
            }
          }

          // Guarantee primary phone device `:0` is present when `!ignoreZeroDevices`
          if (!hasUserDevices && !ignoreZeroDevices) {
            rawResults.push({
              user: reqUser,
              server: reqServer,
              device: 0,
              jid: normalizeResultJid(reqUser, reqServer, 0),
            });
          }
        }

        const deduped: Array<{
          user: string;
          device: number;
          server?: string;
          jid: string;
        }> = [];
        const seenJids = new Set<string>();
        for (const item of rawResults) {
          if (!item || !item.user) continue;
          const itemDecoded = item.jid ? jidDecode(item.jid) : undefined;
          const server =
            item.server ||
            itemDecoded?.server ||
            (String(item.jid || '').endsWith('@lid')
              ? 'lid'
              : 's.whatsapp.net');
          const devNum =
            typeof item.device === 'number' && Number.isFinite(item.device)
              ? item.device
              : itemDecoded?.device ?? 0;
          const canonicalJid = normalizeResultJid(item.user, server, devNum);
          if (!canonicalJid || seenJids.has(canonicalJid)) continue;
          seenJids.add(canonicalJid);
          deduped.push({
            ...item,
            user: item.user,
            server,
            device: devNum,
            jid: canonicalJid,
          });
        }

        return deduped;
      };
    }

    const wsCallbacks: Array<{ event: string; fn: (node: unknown) => void }> = [];
    const ws = anySock.ws;
    if (typeof ws?.on === 'function') {
      const inboundEvents = [
        'CB:iq',
        'CB:message',
        'CB:call',
        'CB:presence',
        'CB:chatstate',
        'CB:receipt',
        'CB:notification',
        'CB:ack',
      ];
      for (const evt of inboundEvents) {
        const fn = (rawNode: unknown) => {
          try {
            if (rawNode && typeof rawNode === 'object' && 'tag' in (rawNode as object)) {
              const bNode = rawNode as BinaryNode;
              monitor.recordWhatsAppStanza({
                sessionId: this.sessionId,
                direction: 'INBOUND',
                node: bNode as InspectableBinaryNode,
              });

              if (evt === 'CB:message') {
                this.lastActiveIncomingStanza = bNode;
                const stanzaCtx =
                  this.forensicAnalyzer.recordIncomingMessageStanzaContext({
                    sessionId: this.sessionId,
                    node: bNode,
                  });
                const hasSignalEnc = Boolean(
                  stanzaCtx &&
                    stanzaCtx.encNodes.some(
                      (e) =>
                        e.type === 'pkmsg' ||
                        e.type === 'msg' ||
                        e.type === 'skmsg'
                    ) &&
                    sock.signalRepository
                );
                if (!hasSignalEnc) {
                  void this.forensicAnalyzer
                    .captureIncomingPayload({
                      sessionId: this.sessionId,
                      rawEventType: 'ws.CB:message',
                      rawBinaryNode: bNode,
                      sock,
                    })
                    .catch(() => undefined);
                }
              } else if (
                evt === 'CB:call' ||
                evt === 'CB:iq' ||
                evt === 'CB:notification'
              ) {
                if (evt === 'CB:iq' && bNode.attrs?.xmlns === 'privacy') {
                  void this.identityService.privacyTokens
                    .captureIncomingPrivacyToken({
                      iqNode: bNode,
                      fallbackJid: bNode.attrs?.from,
                    })
                    .catch(() => undefined);
                }
                void this.forensicAnalyzer
                  .captureIncomingPayload({
                    sessionId: this.sessionId,
                    rawEventType: `ws.${evt}` as RawForensicEventType,
                    rawBinaryNode: bNode,
                    sock,
                  })
                  .catch(() => undefined);
              } else if (evt === 'CB:ack' && bNode.attrs?.error === '463') {
                emitIdentityTelemetry({
                  sessionId: this.sessionId,
                  event: 'MESSAGE_463',
                  targetJid: bNode.attrs?.from,
                  outcome: 'ERROR',
                  metadata: {
                    msgId: bNode.attrs?.id,
                    error: '463',
                  },
                });
              }

              // Intercept raw <chatstate> and <presence> stanzas before baileys-lite
              // rewrites `<paused/>` to `'available'` or strips device JIDs (`:0`, `:33`) and `last="deny"`.
              if (evt === 'CB:chatstate' && bNode.attrs?.from) {
                const fromJid = String(bNode.attrs.from);
                const participantRaw = String(bNode.attrs.participant || fromJid);
                const firstChild = Array.isArray(bNode.content)
                  ? bNode.content[0]
                  : undefined;
                if (firstChild && typeof firstChild === 'object' && 'tag' in firstChild) {
                  let state: WAPresence | undefined;
                  if (firstChild.tag === 'paused') {
                    state = 'paused';
                  } else if (firstChild.tag === 'composing') {
                    state =
                      firstChild.attrs?.media === 'audio' ? 'recording' : 'composing';
                  }
                  if (state) {
                    this.memoryStore.applyPresenceTransition({
                      chatJid: fromJid,
                      participantJid: participantRaw,
                      deviceJid: participantRaw,
                      state,
                      source: 'chatstate',
                    });
                  }
                }
              } else if (evt === 'CB:presence' && bNode.attrs?.from) {
                const fromJid = String(bNode.attrs.from);
                const participantRaw = String(bNode.attrs.participant || fromJid);
                const typeAttr = bNode.attrs.type;
                const lastAttr = bNode.attrs.last;
                const state: WAPresence =
                  typeAttr === 'unavailable' ? 'unavailable' : 'available';
                const lastSeenNum =
                  lastAttr && lastAttr !== 'deny' && !Number.isNaN(Number(lastAttr))
                    ? Number(lastAttr)
                    : undefined;
                this.memoryStore.applyPresenceTransition({
                  chatJid: fromJid,
                  participantJid: participantRaw,
                  deviceJid: participantRaw,
                  state,
                  lastSeen: lastSeenNum,
                  privacyLastSeenDenied: lastAttr === 'deny' ? true : undefined,
                  source: 'presence',
                });
              }
            }
          } catch {
            // Never disrupt socket pipeline
          }
        };
        if (evt === 'CB:message' && typeof ws.prependListener === 'function') {
          ws.prependListener(evt, fn);
        } else {
          ws.on(evt, fn);
        }
        wsCallbacks.push({ event: evt, fn });
      }
    }

    return () => {
      if (typeof ws?.off === 'function') {
        for (const item of wsCallbacks) {
          try {
            ws.off(item.event, item.fn);
          } catch {
            // Ignore
          }
        }
      }
    };
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
    this.instrumentSignalRepositoryForForensics(sock);

    const rawStanzaNodeByMsgId = new Map<string, BinaryNode>();

    // Priority-0 Forensic Security Analyzer Hook (runs BEFORE SessionMemoryStore, IncomingMessageReceiver, and StatusDownloader)
    const forensicPriorityZeroUpsertListener = ({
      messages: rawIncomingMessages,
    }: {
      messages: Array<Record<string, unknown>>;
      type: string;
    }) => {
      if (!Array.isArray(rawIncomingMessages)) return;
      for (let i = 0; i < rawIncomingMessages.length; i++) {
        const msg = rawIncomingMessages[i];
        if (!msg || typeof msg !== 'object') continue;
        try {
          const msgKey = (msg.key || {}) as { id?: string };
          const msgId = String(msgKey.id || '');
          const rawNode = msgId ? rawStanzaNodeByMsgId.get(msgId) : undefined;
          const selfJids = [
            sock.user?.id || state.creds?.me?.id || '',
            sock.user?.lid || state.creds?.me?.lid || '',
          ].filter(Boolean);

          // Only invoke captureIncomingPayload if Signal inline hook didn't already capture this stanzaId
          if (
            !this.forensicAnalyzer.hasSignalCaptureForStanza(
              this.sessionId,
              msgId
            )
          ) {
            const untouchedForForensics: Record<string, unknown> = {
              ...msg,
              message:
                msg.message && typeof msg.message === 'object'
                  ? { ...(msg.message as Record<string, unknown>) }
                  : msg.message,
            };

            void this.forensicAnalyzer
              .captureIncomingPayload({
                sessionId: this.sessionId,
                rawEventType: 'messages.upsert',
                rawBinaryNode: rawNode,
                rawWaMessage: untouchedForForensics,
                sock,
                botKnownMessageIds: this.memoryStore.messages,
                botSelfJids: selfJids,
              })
              .catch(() => undefined);
          }

          // Pre-processing sanitizer guard to protect downstream normalizers from OOM / BiDi / Mention bombs
          const { sanitizedMessage, wasSanitized } =
            sanitizeIncomingMessageForDownstream(msg);
          if (wasSanitized) {
            rawIncomingMessages[i] = sanitizedMessage;
            msg.message = sanitizedMessage.message;
            msg.__sanitizedByForensicGuard = true;
            msg.__sanitizedReasons = sanitizedMessage.__sanitizedReasons;
          }
        } catch {
          // Never block or crash socket pipeline
        }
      }
    };

    sock.ev.on('messages.upsert', forensicPriorityZeroUpsertListener as never);
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
      const { connection, lastDisconnect, qr, isNewLogin, reachoutTimeLock } = update;
      if (reachoutTimeLock) {
        this.identityService.privacyTokens.handleReachoutTimelockUpdate(
          reachoutTimeLock
        );
      }

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
        rawStanzaNodeByMsgId.set(msgId, node as unknown as BinaryNode);
        if (rawStanzaNodeByMsgId.size > 500) {
          const oldestNodeKey = rawStanzaNodeByMsgId.keys().next().value;
          if (oldestNodeKey) rawStanzaNodeByMsgId.delete(oldestNodeKey);
        }
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
    const unbindSocketTelemetry = this.instrumentSocketForTelemetry(sock);

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
      unbindSocketTelemetry();
      try {
        if (typeof wsEmitter?.off === 'function') {
          wsEmitter.off('CB:message', rawMessageStanzaListener as never);
        }
        sock.ev.off('creds.update', credsListener);
        sock.ev.off('connection.update', connectionListener);
        sock.ev.off('messages.update', messagesUpdateListener);
        sock.ev.off('message-receipt.update', receiptUpdateListener);
        sock.ev.off(
          'messages.upsert',
          forensicPriorityZeroUpsertListener as never
        );
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
   * Ensures `authState.creds.me.name` is populated so `@hiroosy/baileys-lite`'s `sendPresenceUpdate('available')`
   * never silently aborts (`if (!me.name) return`), and transmits `<presence type="available"/>` so WhatsApp
   * servers unlock real-time presence and `lastSeen` streaming for subscribed contacts.
   */
  private async ensureSelfPresenceAvailable(
    sock: WASocket,
    targetJid?: string
  ): Promise<void> {
    try {
      const anySock = sock as unknown as {
        authState?: { creds?: { me?: { id?: string; name?: string } } };
        user?: { id?: string; name?: string; verifiedName?: string };
        sendNode?: (node: BinaryNode) => Promise<void>;
      };
      const fallbackName =
        (
          anySock.authState?.creds?.me?.name ||
          anySock.user?.name ||
          anySock.user?.verifiedName ||
          'WhatsApp'
        )
          .replace(/@/g, '')
          .trim() || 'WhatsApp';

      if (anySock.authState?.creds?.me && !anySock.authState.creds.me.name) {
        anySock.authState.creds.me.name = fallbackName;
      }
      if (anySock.user && !anySock.user.name) {
        anySock.user.name = fallbackName;
      }

      await sock.sendPresenceUpdate('available').catch(async () => {
        if (typeof anySock.sendNode === 'function') {
          await anySock
            .sendNode({
              tag: 'presence',
              attrs: { name: fallbackName, type: 'available' },
            })
            .catch(() => undefined);
        }
      });

      if (targetJid) {
        await sock.sendPresenceUpdate('available', targetJid).catch(() => undefined);
      }
    } catch {
      // Best-effort self-presence activation
    }
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
      if (state === 'available' || state === 'unavailable') {
        await this.ensureSelfPresenceAvailable(sock);
      }
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate(state, jid);
    } catch {
      // Presence updates are best-effort
    }
  }

  private handleMessagesUpdateForReadRevoke(
    updates: Array<{
      key?: { id?: string | null; remoteJid?: string | null; participant?: string | null };
      update?: { status?: number | string | null };
    }>
  ): void {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      const id = item?.key?.id;
      const remoteJid = item?.key?.remoteJid;
      const rawStatus = item?.update?.status;
      const isReadOrPlayed =
        rawStatus === 4 ||
        rawStatus === 5 ||
        rawStatus === 'READ' ||
        rawStatus === 'PLAYED';
      const isDelivered =
        rawStatus === 3 || rawStatus === 'DELIVERY_ACK';

      if (
        remoteJid &&
        (isReadOrPlayed || isDelivered) &&
        (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'))
      ) {
        try {
          if (isReadOrPlayed) {
            this.memoryStore.applyPresenceTransition({
              chatJid: remoteJid,
              participantJid: item?.key?.participant || remoteJid,
              deviceJid: item?.key?.participant || remoteJid,
              state: 'available',
              source: 'receipt',
            });
          } else if (item?.key?.participant && item.key.participant.includes(':')) {
            this.memoryStore.updatePresenceTelemetry(remoteJid, {
              activeDevices: [item.key.participant],
            });
          }
        } catch {
          // Ignore presence inference error
        }
      }

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
      key?: { id?: string | null; remoteJid?: string | null; participant?: string | null };
      receipt?: {
        userJid?: string | null;
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
      const remoteJid = r.key.remoteJid;
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
      if (
        remoteJid &&
        (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'))
      ) {
        const deviceSender =
          r.receipt.userJid || r.key.participant || remoteJid;
        if (r.receipt.readTimestamp || r.receipt.playedTimestamp) {
          try {
            this.memoryStore.applyPresenceTransition({
              chatJid: remoteJid,
              participantJid: deviceSender,
              deviceJid: deviceSender,
              state: 'available',
              source: 'receipt',
            });
          } catch {
            // Ignore
          }
        } else if (r.receipt.receiptTimestamp && deviceSender.includes(':')) {
          this.memoryStore.updatePresenceTelemetry(remoteJid, {
            activeDevices: [deviceSender],
          });
        }
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
   * Executes an official Baileys `USyncQuery` combining Contact, LID, Status, DisappearingMode,
   * and Devices protocols in a single round-trip via `sock.executeUSyncQuery(usyncQuery)`,
   * with safe fallbacks for mock/partial sockets.
   */
  public async executeOfficialUSyncAccountLookup(
    sock: WASocket,
    targetInput: string
  ): Promise<{
    exists: boolean;
    pnJid: string;
    lidJid?: string;
    statusText?: string;
    statusSetAt?: Date;
    disappearingDuration?: number;
    disappearingSetAt?: Date;
    pictureId?: string;
    devices: Array<{ id: number; keyIndex?: number; isHosted?: boolean }>;
  }> {
    let trimmed = String(targetInput || '').trim();
    if (!trimmed.includes('@')) {
      trimmed = trimmed.replace(/[\s\-()]+/g, '');
    }

    let isLid = trimmed.endsWith('@lid');
    if (isLid) {
      const userPart = trimmed.slice(0, -4).trim();
      const digitsOnly = userPart.replace(/\D/g, '');
      const looksLikePhoneWithFakeLid =
        userPart.startsWith('+') ||
        /^(?:9665\d{8}|9715\d{8}|965[569]\d{7}|974[3567]\d{7}|9733\d{7}|968[79]\d{7}|201\d{9}|9627\d{8}|9647\d{9}|9677\d{8})$/.test(
          digitsOnly
        );
      if (looksLikePhoneWithFakeLid) {
        trimmed = `+${digitsOnly}`;
        isLid = false;
      }
    }

    const cleanDigits = trimmed.split('@')[0].replace(/\D/g, '');
    let pnJid = isLid ? '' : `${cleanDigits}@s.whatsapp.net`;
    let lidJid = isLid ? jidNormalizedUser(trimmed) : undefined;

    if (isLid && lidJid) {
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

    let exists = false;
    let statusText: string | undefined;
    let statusSetAt: Date | undefined;
    let disappearingDuration: number | undefined;
    let disappearingSetAt: Date | undefined;
    let pictureId: string | undefined;
    let devices: Array<{ id: number; keyIndex?: number; isHosted?: boolean }> = [];

    // 1. Primary path: Official Baileys USyncQuery combining all 5 protocols in 1 round-trip
    if (typeof USyncQuery === 'function' && typeof USyncUser === 'function') {
      const usyncQuery = new USyncQuery()
        .withContext('interactive')
        .withContactProtocol()
        .withLIDProtocol()
        .withStatusProtocol()
        .withDisappearingModeProtocol()
        .withDevicesProtocol();

      const usyncUser = new USyncUser();
      if (isLid && lidJid) {
        usyncUser.withId(lidJid);
      } else if (cleanDigits) {
        usyncUser.withPhone(`+${cleanDigits}`).withId(pnJid);
      }
      usyncQuery.withUser(usyncUser);

      if (typeof sock.executeUSyncQuery === 'function') {
        try {
          const res = await sock.executeUSyncQuery(usyncQuery);
          const item: USyncQueryResultItem | undefined = res?.list?.[0];
          if (item) {
            if (item.id && item.id.endsWith('@s.whatsapp.net')) {
              pnJid = jidNormalizedUser(item.id);
            } else if (item.id && item.id.endsWith('@lid')) {
              lidJid = jidNormalizedUser(item.id);
            }

            if (typeof item.contact === 'boolean') {
              exists = item.contact;
            } else if (item.contact && typeof item.contact === 'object') {
              exists = item.contact.type !== 'out';
            } else if (item.id) {
              exists = true;
            }

            const parsedLid = this.extractLidString(item.lid);
            if (parsedLid && parsedLid.endsWith('@lid')) {
              lidJid = parsedLid;
            }

            if (
              item.status &&
              typeof item.status.status === 'string' &&
              item.status.status.trim()
            ) {
              statusText = item.status.status.trim();
            }
            if (
              item.status?.setAt instanceof Date &&
              !Number.isNaN(item.status.setAt.getTime()) &&
              item.status.setAt.getTime() > 0
            ) {
              statusSetAt = item.status.setAt;
            }

            if (
              item.disappearing_mode &&
              typeof item.disappearing_mode.duration === 'number'
            ) {
              disappearingDuration = item.disappearing_mode.duration;
              if (
                item.disappearing_mode.setAt instanceof Date &&
                !Number.isNaN(item.disappearing_mode.setAt.getTime()) &&
                item.disappearing_mode.setAt.getTime() > 0
              ) {
                disappearingSetAt = item.disappearing_mode.setAt;
              }
            }

            if (Array.isArray(item.devices?.deviceList)) {
              devices = item.devices!.deviceList.map((d) => ({
                id: Number(d.id ?? 0),
                keyIndex: d.keyIndex,
                isHosted: d.isHosted,
              }));
            }
          }
        } catch {
          // Fall through to individual Baileys socket methods below
        }
      }
    }

    // 2. Check signalRepository.lidMapping & memoryStore if LID is still unknown
    if (!lidJid && pnJid) {
      const repoLid = await sock.signalRepository?.lidMapping
        ?.getLIDForPN?.(pnJid)
        .catch(() => undefined);
      const parsedRepoLid =
        this.extractLidString(repoLid) || this.memoryStore.getLidForPn(pnJid);
      if (parsedRepoLid && parsedRepoLid.endsWith('@lid')) {
        lidJid = parsedRepoLid;
      }
    }

    // 3. Fallback / Enrichment via sock.onWhatsApp, sock.getUSyncDevices, sock.fetchStatus, sock.fetchDisappearingDuration
    if ((!lidJid || !exists) && typeof sock.onWhatsApp === 'function' && pnJid) {
      try {
        const waRes = await sock.onWhatsApp(pnJid);
        const first = Array.isArray(waRes) ? waRes[0] : undefined;
        if (first) {
          exists = Boolean(first.exists);
          if (first.jid) {
            pnJid = jidNormalizedUser(first.jid);
          }
          const waLid = this.extractLidString(first.lid);
          if (waLid && waLid.endsWith('@lid')) {
            lidJid = waLid;
          }
        }
      } catch {
        // Ignore
      }
    }

    if (
      (devices.length === 0 || !lidJid) &&
      typeof sock.getUSyncDevices === 'function' &&
      (pnJid || lidJid)
    ) {
      try {
        const devTarget = pnJid || lidJid!;
        const rawDevs = await sock.getUSyncDevices([devTarget], false, false);
        if (Array.isArray(rawDevs) && rawDevs.length > 0) {
          exists = true;
          if (devices.length === 0) {
            const seen = new Set<number>();
            for (const d of rawDevs) {
              const id = Number(d?.device ?? 0);
              if (Number.isFinite(id) && !seen.has(id)) {
                seen.add(id);
                devices.push({ id });
              }
            }
          }
        }
        if (!lidJid && pnJid) {
          const repoLid = await sock.signalRepository?.lidMapping
            ?.getLIDForPN?.(pnJid)
            .catch(() => undefined);
          const parsedLid =
            this.extractLidString(repoLid) || this.memoryStore.getLidForPn(pnJid);
          if (parsedLid && parsedLid.endsWith('@lid')) {
            lidJid = parsedLid;
          }
        }
      } catch {
        // Ignore
      }
    }

    if (!statusText && typeof sock.fetchStatus === 'function' && (pnJid || lidJid)) {
      try {
        const stRes = await sock.fetchStatus(pnJid || lidJid!);
        const first = Array.isArray(stRes) ? stRes[0] : stRes;
        if (first && typeof first === 'object') {
          const entryObj = first as Record<string, unknown>;
          const nested = entryObj.status;
          if (typeof nested === 'string' && nested.trim()) {
            statusText = nested.trim();
            const rawDate = entryObj.setAt;
            if (rawDate) {
              const d = new Date(rawDate as string | number | Date);
              if (!Number.isNaN(d.getTime()) && d.getTime() > 0) {
                statusSetAt = d;
              }
            }
          } else if (nested && typeof nested === 'object') {
            const inner = nested as Record<string, unknown>;
            if (typeof inner.status === 'string' && inner.status.trim()) {
              statusText = inner.status.trim();
            }
            const rawDate = inner.setAt ?? entryObj.setAt;
            if (rawDate) {
              const d = new Date(rawDate as string | number | Date);
              if (!Number.isNaN(d.getTime()) && d.getTime() > 0) {
                statusSetAt = d;
              }
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    if (
      disappearingDuration === undefined &&
      typeof sock.fetchDisappearingDuration === 'function' &&
      (pnJid || lidJid)
    ) {
      try {
        const dmRes = await sock.fetchDisappearingDuration(pnJid || lidJid!);
        const dmItem = Array.isArray(dmRes) ? dmRes[0] : undefined;
        if (typeof dmItem?.disappearing_mode?.duration === 'number') {
          disappearingDuration = dmItem.disappearing_mode.duration;
          if (
            dmItem.disappearing_mode.setAt instanceof Date &&
            !Number.isNaN(dmItem.disappearing_mode.setAt.getTime()) &&
            dmItem.disappearing_mode.setAt.getTime() > 0
          ) {
            disappearingSetAt = dmItem.disappearing_mode.setAt;
          }
        }
      } catch {
        // Ignore
      }
    }

    // 4. Persist LID <-> PN mapping in both memoryStore and Baileys' internal signalRepository.lidMapping
    if (lidJid && pnJid) {
      await this.persistLidPnMappingOnSocket(sock, lidJid, pnJid);
    }

    return {
      exists,
      pnJid: pnJid || lidJid || trimmed,
      lidJid,
      statusText,
      statusSetAt,
      disappearingDuration,
      disappearingSetAt,
      pictureId,
      devices,
    };
  }

  /**
   * Resolves the Privacy-Preserving Linked Identity (`@lid`) for a target phone number or JID
   * using official Baileys `USyncQuery` (`USyncLIDProtocol`), `signalRepository.lidMapping`,
   * `SessionMemoryStore`, and participating `groupMetadataCache`.
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
    let trimmed = String(targetInput || '').trim();
    if (!trimmed) {
      throw new ValidationError('الرجاء إدخال رقم الهاتف أو معرف @lid للمستلم.');
    }

    // Strip formatting spaces/hyphens/parentheses if user entered a formatted phone number
    if (!trimmed.includes('@')) {
      trimmed = trimmed.replace(/[\s\-()]+/g, '');
    }

    // 1. Direct @lid input (guarding against phone numbers that had @lid mistakenly appended, e.g. +966501234567@lid)
    if (trimmed.endsWith('@lid')) {
      const userPart = trimmed.slice(0, -4).trim();
      const digitsOnly = userPart.replace(/\D/g, '');
      const looksLikePhoneWithFakeLid =
        userPart.startsWith('+') ||
        /^(?:9665\d{8}|9715\d{8}|965[569]\d{7}|974[3567]\d{7}|9733\d{7}|968[79]\d{7}|201\d{9}|9627\d{8}|9647\d{9}|9677\d{8})$/.test(
          digitsOnly
        );
      if (looksLikePhoneWithFakeLid) {
        trimmed = `+${digitsOnly}`;
      } else {
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
    }

    // Normalize as PN JID
    const normalizedRecipient = validateRecipient(trimmed);
    if (normalizedRecipient.isGroup) {
      throw new ValidationError(
        'استخراج معرف @lid المباشر مخصص لجهات الاتصال الفردية (رقم دولي أو @lid).'
      );
    }
    const pnJid = jidNormalizedUser(normalizedRecipient.jid);

    // 2. Fast-path: Check signalRepository.lidMapping & memoryStore
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

    // 3a. Official Baileys USync lookup (USyncQuery + onWhatsApp + getUSyncDevices)
    const usyncLookup = await this.executeOfficialUSyncAccountLookup(sock, pnJid);
    if (usyncLookup.lidJid && usyncLookup.lidJid.endsWith('@lid')) {
      await this.persistLidPnMappingOnSocket(
        sock,
        usyncLookup.lidJid,
        usyncLookup.pnJid || pnJid
      );
      return {
        pnJid: usyncLookup.pnJid || pnJid,
        lidJid: usyncLookup.lidJid,
        source: 'ON_WHATSAPP_USYNC',
      };
    }

    // 3b. Direct USync IQ query fallback when executeUSyncQuery is unavailable on mock sockets
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
   * registering the LID<->PN mapping in `signalRepository.lidMapping`, migrating/asserting the E2E Signal
   * session onto the target `@lid` JID (`migrateSession` + `assertSessions`), and delivering via
   * `sock.sendMessage(lidJid, { text }, { addressingMode: 'lid', additionalAttributes: { addressing_mode: 'lid' } })`.
   * If the WhatsApp server does not expose a `@lid` for a valid phone number, safely falls back to delivering
   * to `pnJid` (`@s.whatsapp.net`) with stripped `pushName`.
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
    usedLid?: boolean;
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

    const rawRecipient = String(params.recipient || '').trim();
    const trimmedRecipient = rawRecipient.includes('@')
      ? rawRecipient
      : rawRecipient.replace(/[\s\-()]+/g, '');

    if (trimmedRecipient.endsWith('@g.us')) {
      const groupCheck = validateRecipient(trimmedRecipient);
      const sent = await sock.sendMessage(
        groupCheck.jid,
        { text: validText },
        {
          addressingMode: 'lid',
          additionalAttributes: { addressing_mode: 'lid' },
        } as unknown as Record<string, unknown>
      );
      const msgId = sent?.key?.id || `lid_grp_${Date.now()}`;
      if (sent?.message) {
        this.memoryStore.cacheSentMessage(groupCheck.jid, msgId, sent.message);
      }
      await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
      return {
        messageId: msgId,
        targetLid: groupCheck.jid,
        resolutionSource: 'GROUP_LID_RELAY',
        usedLid: true,
      };
    }

    let pnJid: string | undefined;
    let lidJid: string | undefined;
    let source = 'ON_WHATSAPP_USYNC';
    let usedLid = true;

    try {
      const resolved = await this.resolveLidForRecipient(trimmedRecipient);
      pnJid = resolved.pnJid;
      lidJid = resolved.lidJid;
      source = resolved.source;
    } catch (err) {
      const normalizedCheck = validateRecipient(
        trimmedRecipient.endsWith('@lid')
          ? `+${trimmedRecipient.slice(0, -4).replace(/\D/g, '')}`
          : trimmedRecipient
      );
      if (
        normalizedCheck.jid.endsWith('@s.whatsapp.net') &&
        typeof sock.onWhatsApp === 'function'
      ) {
        const waCheck = await sock.onWhatsApp(normalizedCheck.jid).catch(() => []);
        const waEntry = Array.isArray(waCheck) ? waCheck[0] : undefined;
        if (waEntry && waEntry.exists === false) {
          throw err;
        }
      }
      if (normalizedCheck.jid.endsWith('@s.whatsapp.net')) {
        pnJid = jidNormalizedUser(normalizedCheck.jid);
        lidJid = pnJid;
        source = 'PN_FALLBACK';
        usedLid = false;
      } else {
        throw err;
      }
    }

    const deliveryJid = lidJid!;

    // 1. Register LID <-> PN mapping in Baileys' internal Signal repository
    if (pnJid && usedLid) {
      await this.persistLidPnMappingOnSocket(sock, deliveryJid, pnJid);
    }

    // 2. Official Baileys session migration from PN -> LID + assertSessions
    try {
      if (typeof sock.getUSyncDevices === 'function') {
        const jidsToFetch = Array.from(
          new Set([pnJid, deliveryJid].filter((j): j is string => Boolean(j)))
        );
        await sock.getUSyncDevices(jidsToFetch, false, false).catch(() => []);
      }
      if (
        usedLid &&
        pnJid &&
        typeof sock.signalRepository?.migrateSession === 'function'
      ) {
        await sock.signalRepository
          .migrateSession(pnJid, deliveryJid)
          .catch(() => undefined);
      }
      if (typeof sock.assertSessions === 'function') {
        await sock.assertSessions([deliveryJid], false).catch(() => false);
      }
    } catch {
      // Best-effort session preparation before sending
    }

    const previousName = sock.user?.name;
    if (sock.user) {
      sock.user.name = params.customPushName ?? '';
    }

    let msgId = `lid_msg_${Date.now()}`;
    try {
      if (typeof sock.sendMessage === 'function') {
        const sent = await sock.sendMessage(
          deliveryJid,
          { text: validText },
          usedLid
            ? ({
                addressingMode: 'lid',
                additionalAttributes: { addressing_mode: 'lid' },
              } as unknown as Record<string, unknown>)
            : undefined
        );
        if (sent?.key?.id) {
          msgId = sent.key.id;
        }
        const messageToCache =
          sent?.message ||
          ({
            extendedTextMessage: { text: validText },
          } as unknown as proto.IMessage);
        this.memoryStore.cacheSentMessage(deliveryJid, msgId, messageToCache);
      } else {
        const waMsg = generateWAMessageFromContent(
          deliveryJid,
          { extendedTextMessage: { text: validText } },
          {
            userJid: usedLid
              ? senderJid
              : sock.user?.id
                ? jidNormalizedUser(sock.user.id)
                : senderJid,
          }
        );
        msgId = waMsg.key?.id || msgId;
        if (waMsg.message) {
          this.memoryStore.cacheSentMessage(deliveryJid, msgId, waMsg.message);
        }
        await sock.relayMessage(
          deliveryJid,
          waMsg.message!,
          usedLid
            ? {
                messageId: msgId,
                addressingMode: 'lid',
                additionalAttributes: { addressing_mode: 'lid' },
              }
            : {
                messageId: msgId,
              }
        );
      }
    } finally {
      if (sock.user) {
        sock.user.name = previousName;
      }
    }

    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);

    return {
      messageId: msgId,
      targetLid: deliveryJid,
      resolvedPn: pnJid,
      resolutionSource: source,
      usedLid,
    };
  }

  public async resolveIdentity(
    targetInput: string,
    options?: { usernameKey?: string }
  ): Promise<LidResolutionResult | null> {
    this.ensureSocket();
    return this.identityService.resolveIdentity(targetInput, options);
  }

  public async sendLidAddressedMessage(
    params: SendLidAddressedParams
  ): Promise<SendLidAddressedResult> {
    this.ensureSocket();
    const res = await this.identityService.sendLidAddressedMessage(params);
    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
    return res;
  }

  public async getPrivacyTokenInfo(
    targetJid: string
  ): Promise<PrivacyTokenRecord | null> {
    this.ensureSocket();
    return this.identityService.privacyTokens.getValidPrivacyToken(targetJid);
  }

  public async ensurePrivacyToken(
    targetJid: string,
    forceRefresh = false
  ): Promise<{ record: PrivacyTokenRecord | null; refreshed: boolean }> {
    this.ensureSocket();
    const res = await this.identityService.privacyTokens.ensurePrivacyToken(
      targetJid,
      { forceRefresh }
    );
    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
    return res;
  }

  public async getReachoutStatus(): Promise<ReachoutTimelockInfo> {
    const sock = this.ensureSocket();
    if (typeof sock.fetchAccountReachoutTimelock === 'function') {
      const live = await sock.fetchAccountReachoutTimelock().catch(() => null);
      if (live) {
        this.identityService.privacyTokens.handleReachoutTimelockUpdate(live);
        return live;
      }
    }
    return this.identityService.privacyTokens.getReachoutTimeLock();
  }

  public async checkUsername(
    handle: string,
    pin?: string
  ): Promise<WhatsAppUsernameState> {
    return this.identityService.checkUsername(handle, pin);
  }

  public async setUsername(handle: string): Promise<WhatsAppUsernameState> {
    return this.identityService.setUsername(handle);
  }

  public async deleteUsername(): Promise<WhatsAppUsernameState> {
    return this.identityService.deleteUsername();
  }

  public async setUsernamePin(pin: string): Promise<WhatsAppUsernameState> {
    return this.identityService.setUsernamePin(pin);
  }

  public async recommendUsername(
    seed?: string
  ): Promise<UsernameRecommendationResult> {
    return this.identityService.recommendUsername(seed);
  }

  public async getSelfUsernameState(): Promise<WhatsAppUsernameState> {
    return this.identityService.getSelfUsernameState();
  }

  public async deliverRelayPayload(params: {
    targetJid: string;
    preferLid?: boolean;
    content: AnyMessageContent;
    quotedMessageId?: string;
    customPushName?: string;
  }): Promise<{
    messageId: string;
    deliveredToJid: string;
    addressingMode: 'lid' | 'pn';
  }> {
    this.ensureSocket();
    if (this.connectionState !== 'CONNECTED' || !this.wsOpen) {
      throw new WhatsAppConnectionError(
        'الجلسة غير متصلة حالياً لتمرير رسالة Menfess.'
      );
    }
    let quotedObj: { key: WAMessageKey; message?: Record<string, unknown> } | undefined;
    if (params.quotedMessageId) {
      const cached = await this.memoryStore.getMessage({
        remoteJid: params.targetJid,
        id: params.quotedMessageId,
      });
      quotedObj = {
        key: {
          remoteJid: params.targetJid,
          id: params.quotedMessageId,
          fromMe: false,
        },
        message: cached || undefined,
      };
    }

    const res = await this.identityService.sendLidAddressedMessage({
      target: params.targetJid,
      content: params.content,
      preferLid: params.preferLid,
      quoted: quotedObj,
      customPushName: params.customPushName,
      ensurePrivacyToken: true,
    });

    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);
    return {
      messageId: res.messageId,
      deliveredToJid: res.targetJid,
      addressingMode: res.addressingMode,
    };
  }

  /**
   * Performs a non-intrusive USync device & LID probe to measure round-trip latency (`probeRttMs`)
   * and enumerate all linked devices (`:0` primary phone + `:N` companion web/desktop devices).
   */
  private async probeRecipientDevicesAndRtt(
    sock: WASocket,
    pnOrTargetJid: string,
    lidJid?: string
  ): Promise<{ rttMs?: number; linkedDevices: string[] }> {
    const linkedDevices: string[] = [];
    const probeTargets = [pnOrTargetJid];
    if (lidJid && lidJid !== pnOrTargetJid) {
      probeTargets.push(lidJid);
    }
    const startMs = Date.now();
    try {
      if (typeof sock.getUSyncDevices === 'function') {
        const rawDevices = await sock.getUSyncDevices(probeTargets, false, false);
        const rttMs = Math.max(1, Date.now() - startMs);
        if (Array.isArray(rawDevices)) {
          for (const d of rawDevices) {
            if (!d || typeof d !== 'object') continue;
            const user = String((d as { user?: string }).user || '').trim();
            const devId = Number((d as { device?: number }).device ?? 0);
            const server =
              user.length >= 14 && !pnOrTargetJid.startsWith(user)
                ? 'lid'
                : 's.whatsapp.net';
            if (user) {
              linkedDevices.push(`${user}:${devId}@${server}`);
            }
          }
        }
        return { rttMs, linkedDevices };
      }
    } catch {
      // Ignore probe error
    }
    return { linkedDevices };
  }

  /**
   * Subscribes to and tracks real-time recipient presence (`available`, `unavailable`, `composing`, `recording`, `paused`)
   * across both `@s.whatsapp.net` and `@lid` JIDs using the official Baileys `makeInMemoryStore` pattern:
   * 1. Resolves both `pnJid` and `lidJid` via `executeOfficialUSyncAccountLookup` / `resolveLidForRecipient` and links them in `memoryStore` BEFORE subscribing.
   * 2. Registers `memoryStore.onPresenceChange` BEFORE calling `presenceSubscribe`.
   * 3. Sends `await sock.sendPresenceUpdate('available')` and subscribes to both `pnJid` and `lidJid`.
   */
  public async trackRecipientPresence(params: {
    recipient: string;
    durationSeconds: number;
    onUpdate?: (record: TrackedPresenceRecord) => void;
    staleComposingTimeoutMs?: number;
    probeIntervalMs?: number;
    probeTimeoutMs?: number;
    adminId?: number;
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

    const cleanRecipient = String(params.recipient || '').includes('@')
      ? String(params.recipient || '').trim()
      : String(params.recipient || '').replace(/[\s\-()]+/g, '');
    const validated = validateRecipient(cleanRecipient);
    const targetJid = jidNormalizedUser(validated.jid);
    let pnJid = targetJid.endsWith('@s.whatsapp.net') ? targetJid : undefined;
    let lidJid = targetJid.endsWith('@lid') ? targetJid : undefined;

    const trackingStartedAtMs = Date.now();
    const resolveStartMs = Date.now();
    const usyncLookup = await this.executeOfficialUSyncAccountLookup(
      sock,
      targetJid
    ).catch(() => null);
    let initialResolveRttMs = usyncLookup
      ? Math.max(1, Date.now() - resolveStartMs)
      : undefined;
    if (usyncLookup) {
      if (usyncLookup.pnJid && usyncLookup.pnJid.endsWith('@s.whatsapp.net')) {
        pnJid = usyncLookup.pnJid;
      }
      if (usyncLookup.lidJid && usyncLookup.lidJid.endsWith('@lid')) {
        lidJid = usyncLookup.lidJid;
      }
    }

    if (!lidJid) {
      const resolved = await this.resolveLidForRecipient(cleanRecipient).catch(
        () => null
      );
      if (resolved) {
        if (!initialResolveRttMs) {
          initialResolveRttMs = Math.max(1, Date.now() - resolveStartMs);
        }
        pnJid = resolved.pnJid || pnJid;
        lidJid = resolved.lidJid || lidJid;
      }
    }

    if (pnJid && lidJid) {
      this.memoryStore.recordLidMapping(lidJid, pnJid);
    }

    const primaryKey = pnJid || lidJid || targetJid;
    const digitsKey = primaryKey.split('@')[0].replace(/\D/g, '');
    const candidateKeys = Array.from(
      new Set(
        [primaryKey, pnJid, lidJid, targetJid, digitsKey].filter(
          (k): k is string => Boolean(k)
        )
      )
    );

    // Seed initial telemetry (targetDurationSeconds, elapsedSeconds=0, initial RTT if measured)
    this.memoryStore.updatePresenceTelemetry(primaryKey, {
      probeRttMs: initialResolveRttMs,
      elapsedSeconds: 0,
      targetDurationSeconds: durationSec,
    });

    // Helper to merge DeviceActivityTracker report with memoryStore record
    const mergeTrackerAndMemoryRecord = (
      report: PresenceWatchReport
    ): TrackedPresenceRecord => {
      const memRec =
        this.memoryStore.presences.get(primaryKey) ||
        (lidJid ? this.memoryStore.presences.get(lidJid) : undefined);

      const linkedSet = new Set<string>([
        ...(memRec?.linkedDevices || []),
        ...(report.linkedDevices || []),
        ...(report.detectedDevices || []),
      ]);
      const activeSet = new Set<string>([
        ...(memRec?.activeDevices || []),
        ...(report.activeDevices || []),
        ...(report.respondingDevices || []),
      ]);

      // Prefer memoryStore's currentState if it holds a fresh composing/recording/paused state
      const effectiveCurrentState =
        memRec &&
        (memRec.currentState === 'composing' ||
          memRec.currentState === 'recording' ||
          memRec.currentState === 'paused') &&
        Math.abs(Date.now() - memRec.lastUpdatedMs) < staleTimeoutMs
          ? memRec.currentState
          : report.currentState || memRec?.currentState || 'unavailable';

      // Merge transitions preserving chronological order and unique entries
      const mergedTransitions: PresenceStateTransition[] =
        memRec && memRec.transitions.length >= report.transitions.length
          ? memRec.transitions.map((t) => ({
              ...t,
              activityState:
                t.state === 'available' ||
                t.state === 'composing' ||
                t.state === 'recording' ||
                t.state === 'paused'
                  ? 'ACTIVE'
                  : report.deviceActivityState,
            }))
          : report.transitions;

      const probeRttMs =
        report.lastRttMs ?? report.probeRttMs ?? memRec?.probeRttMs ?? initialResolveRttMs;
      const minRttMs =
        report.minRttMs ?? memRec?.minRttMs ?? probeRttMs;
      const maxRttMs =
        report.maxRttMs ?? memRec?.maxRttMs ?? probeRttMs;

      const merged: TrackedPresenceRecord = {
        ...memRec,
        ...report,
        chatJid: primaryKey,
        resolvedLid: report.resolvedLid || lidJid || memRec?.resolvedLid,
        currentState: effectiveCurrentState,
        lastSeenTimestampSec:
          report.lastSeenTimestampSec ?? memRec?.lastSeenTimestampSec,
        privacyLastSeenDenied: Boolean(
          report.privacyLastSeenDenied || memRec?.privacyLastSeenDenied
        ),
        probeRttMs,
        minRttMs,
        maxRttMs,
        linkedDevices: Array.from(linkedSet),
        detectedDevices: Array.from(linkedSet),
        activeDevices: Array.from(activeSet),
        respondingDevices: Array.from(activeSet),
        transitions: mergedTransitions,
        totalOnlineDurationMs: Math.max(
          report.totalOnlineDurationMs || 0,
          memRec?.totalOnlineDurationMs || 0
        ),
        onlineSessionStartedAtMs:
          memRec?.onlineSessionStartedAtMs ?? report.onlineSessionStartedAtMs,
      };

      this.memoryStore.presences.set(primaryKey, merged);
      if (merged.resolvedLid) {
        this.memoryStore.presences.set(merged.resolvedLid, merged);
      }
      return merged;
    };

    const emitLiveUpdate = (record: TrackedPresenceRecord) => {
      if (!params.onUpdate) return;
      const now = Date.now();
      const elapsedSeconds = Math.min(
        durationSec,
        Math.max(0, Math.floor((now - trackingStartedAtMs) / 1000))
      );
      const liveTotalOnlineMs =
        record.onlineSessionStartedAtMs !== undefined
          ? record.totalOnlineDurationMs +
            Math.max(0, now - record.onlineSessionStartedAtMs)
          : record.totalOnlineDurationMs;
      params.onUpdate({
        ...record,
        elapsedSeconds,
        targetDurationSeconds: durationSec,
        totalOnlineDurationMs: liveTotalOnlineMs,
      });
    };

    const unsubListener = params.onUpdate
      ? this.memoryStore.onPresenceChange(primaryKey, (rec) => {
          const snap = tracker.getSnapshot();
          const merged = mergeTrackerAndMemoryRecord({
            ...snap,
            currentState: rec.currentState,
            privacyLastSeenDenied: Boolean(
              rec.privacyLastSeenDenied || snap.privacyLastSeenDenied
            ),
          });
          emitLiveUpdate(merged);
        })
      : () => undefined;

    // Also run active USync device + RTT probe so linkedDevices (:0, :33, etc.) and fallback RTT are populated immediately
    const runUsyncDeviceProbe = async (notifyListeners: boolean) => {
      if (!this.sock || !this.wsOpen) return;
      const probeRes = await this.probeRecipientDevicesAndRtt(
        sock,
        pnJid || primaryKey,
        lidJid
      );
      if (probeRes.rttMs !== undefined || probeRes.linkedDevices.length > 0) {
        const elapsedSeconds = Math.min(
          durationSec,
          Math.max(0, Math.floor((Date.now() - trackingStartedAtMs) / 1000))
        );
        this.memoryStore.updatePresenceTelemetry(primaryKey, {
          probeRttMs: probeRes.rttMs,
          linkedDevices: probeRes.linkedDevices,
          elapsedSeconds,
          targetDurationSeconds: durationSec,
          notify: notifyListeners,
        });
      }
    };

    const computedProbeIntervalMs =
      params.probeIntervalMs ??
      (durationSec <= 4
        ? 1200
        : Math.min(2500, Math.max(1500, Math.floor((durationSec * 1000) / 6))));

    const tracker = new DeviceActivityTracker({
      sessionId: this.sessionId,
      adminId: params.adminId,
      sock: sock as unknown as Partial<WASocket> & Record<string, unknown>,
      recipient: pnJid || cleanRecipient,
      durationSeconds: durationSec,
      probeIntervalMs: computedProbeIntervalMs,
      probeTimeoutMs: params.probeTimeoutMs ?? Math.min(10_000, Math.max(2000, durationSec * 1000)),
      staleComposingTimeoutMs: staleTimeoutMs,
      enableSilentReactionProbes: true,
      registry: getActivePresenceTrackerRegistry(),
      fallbackIdentityLookup: async () => ({
        pnJid: pnJid || primaryKey,
        lidJid,
      }),
      ensureSelfAvailable: async () => {
        await this.ensureSelfPresenceAvailable(sock, pnJid || primaryKey);
      },
      onSnapshotSync: (report) => {
        mergeTrackerAndMemoryRecord(report);
      },
      onUpdate: (report) => {
        const merged = mergeTrackerAndMemoryRecord(report);
        emitLiveUpdate(merged);
      },
    });

    // Fire USync device probe concurrently
    void runUsyncDeviceProbe(true);

    // Watchdog for stale composing/recording (>12s without paused/message) in memoryStore
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
          source: 'presence',
        });
      }
    }, Math.min(1_000, Math.max(50, Math.floor(staleTimeoutMs / 2))));
    if (typeof staleWatchdogInterval.unref === 'function') {
      staleWatchdogInterval.unref();
    }

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(staleWatchdogInterval);
      unsubListener();
      this.activePresenceCleanups.delete(cleanup);
      for (const k of candidateKeys) {
        const keySet = this.activePresenceTrackersByKey.get(k);
        if (keySet) {
          keySet.delete(cleanup);
          if (keySet.size === 0) {
            this.activePresenceTrackersByKey.delete(k);
          }
        }
      }
      tracker.stopEarly();
    };

    this.activePresenceCleanups.add(cleanup);
    for (const k of candidateKeys) {
      let keySet = this.activePresenceTrackersByKey.get(k);
      if (!keySet) {
        keySet = new Set();
        this.activePresenceTrackersByKey.set(k, keySet);
      }
      keySet.add(cleanup);
    }

    let finalReport: PresenceWatchReport;
    try {
      finalReport = await tracker.run();
    } finally {
      cleanup();
    }

    const elapsedFinalSec = Math.min(
      durationSec,
      Math.max(1, Math.round((Date.now() - trackingStartedAtMs) / 1000))
    );
    const mergedFinal = mergeTrackerAndMemoryRecord({
      ...finalReport,
      elapsedSeconds: elapsedFinalSec,
      targetDurationSeconds: durationSec,
    });

    if (mergedFinal.onlineSessionStartedAtMs !== undefined) {
      const now = Date.now();
      return {
        ...mergedFinal,
        totalOnlineDurationMs:
          mergedFinal.totalOnlineDurationMs +
          Math.max(0, now - mergedFinal.onlineSessionStartedAtMs),
      };
    }

    return mergedFinal;
  }

  /**
   * Stops active recipient presence tracking loop(s) immediately without sending `unavailable`.
   */
  public stopTrackingRecipientPresence(recipient?: string): number {
    let stoppedCount = 0;
    const uniqueCleanups = new Set<() => void>();
    if (!recipient) {
      for (const set of this.activePresenceTrackersByKey.values()) {
        for (const fn of set) {
          uniqueCleanups.add(fn);
        }
      }
      for (const fn of uniqueCleanups) {
        fn();
        stoppedCount++;
      }
      this.activePresenceTrackersByKey.clear();
      return stoppedCount;
    }

    const clean = recipient.includes('@')
      ? recipient.trim()
      : recipient.replace(/[\s\-()]+/g, '');
    const digitsOnly = clean.split('@')[0].replace(/\D/g, '');
    const lookupKeys = new Set<string>([clean]);
    if (digitsOnly) {
      lookupKeys.add(digitsOnly);
      lookupKeys.add(`${digitsOnly}@s.whatsapp.net`);
    }
    try {
      const norm = jidNormalizedUser(validateRecipient(clean).jid);
      lookupKeys.add(norm);
      const mappedLid = this.memoryStore.getLidForPn(norm);
      if (mappedLid) lookupKeys.add(mappedLid);
      const mappedPn = this.memoryStore.getPnForLid(norm);
      if (mappedPn) lookupKeys.add(mappedPn);
    } catch {
      // keep raw
    }

    for (const key of lookupKeys) {
      const matchingSet = this.activePresenceTrackersByKey.get(key);
      if (matchingSet) {
        for (const fn of matchingSet) {
          uniqueCleanups.add(fn);
        }
        this.activePresenceTrackersByKey.delete(key);
      }
    }
    for (const fn of uniqueCleanups) {
      fn();
      stoppedCount++;
    }
    return stoppedCount;
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
    onProgress?: (info: {
      pulsesSent: number;
      elapsedSeconds: number;
      durationSeconds: number;
      mode: 'composing' | 'recording' | 'available';
      targetJid: string;
    }) => void;
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

    const cleanRecipient = String(params.recipient || '').includes('@')
      ? String(params.recipient || '').trim()
      : String(params.recipient || '').replace(/[\s\-()]+/g, '');
    const validated = validateRecipient(cleanRecipient);
    const resolvedJid = validated.jid.endsWith('@s.whatsapp.net')
      ? await this.resolveDirectRecipientJid(sock, validated.jid)
      : jidNormalizedUser(validated.jid);
    const digitsKey = resolvedJid.split('@')[0].replace(/\D/g, '');
    const candidateKeys = Array.from(
      new Set([resolvedJid, validated.jid, digitsKey].filter(Boolean))
    );

    const startedAt = Date.now();
    await this.ensureSelfPresenceAvailable(sock, resolvedJid);
    await sock.presenceSubscribe(resolvedJid).catch(() => undefined);

    let pulsesSent = 0;
    const sendPulse = async () => {
      if (!this.sock || !this.wsOpen) return;
      if (params.mode === 'available') {
        await this.ensureSelfPresenceAvailable(sock, resolvedJid);
      } else {
        await sock.sendPresenceUpdate(params.mode, resolvedJid).catch(() => undefined);
      }
      pulsesSent++;
      params.onProgress?.({
        pulsesSent,
        elapsedSeconds: Math.min(
          durationSec,
          Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        ),
        durationSeconds: durationSec,
        mode: params.mode,
        targetJid: resolvedJid,
      });
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
        for (const k of candidateKeys) {
          const hbSet = this.activePresenceHeartbeatsByKey.get(k);
          if (hbSet) {
            hbSet.delete(cleanup);
            if (hbSet.size === 0) {
              this.activePresenceHeartbeatsByKey.delete(k);
            }
          }
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      this.activePresenceCleanups.add(cleanup);
      for (const k of candidateKeys) {
        let hbSet = this.activePresenceHeartbeatsByKey.get(k);
        if (!hbSet) {
          hbSet = new Set();
          this.activePresenceHeartbeatsByKey.set(k, hbSet);
        }
        hbSet.add(cleanup);
      }
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
   * Stops active presence heartbeat broadcast(s) immediately.
   */
  public stopPresenceHeartbeat(recipient?: string): number {
    let stoppedCount = 0;
    const uniqueCleanups = new Set<() => void>();
    if (!recipient) {
      for (const set of this.activePresenceHeartbeatsByKey.values()) {
        for (const fn of set) {
          uniqueCleanups.add(fn);
        }
      }
      for (const fn of uniqueCleanups) {
        fn();
        stoppedCount++;
      }
      this.activePresenceHeartbeatsByKey.clear();
      return stoppedCount;
    }

    const clean = recipient.includes('@')
      ? recipient.trim()
      : recipient.replace(/[\s\-()]+/g, '');
    const digitsOnly = clean.split('@')[0].replace(/\D/g, '');
    const lookupKeys = new Set<string>([clean]);
    if (digitsOnly) {
      lookupKeys.add(digitsOnly);
      lookupKeys.add(`${digitsOnly}@s.whatsapp.net`);
    }
    try {
      normalizedKeyAdd: {
        const norm = jidNormalizedUser(validateRecipient(clean).jid);
        lookupKeys.add(norm);
        break normalizedKeyAdd;
      }
    } catch {
      // keep raw
    }
    for (const key of lookupKeys) {
      const matchingSet = this.activePresenceHeartbeatsByKey.get(key);
      if (matchingSet) {
        for (const fn of matchingSet) {
          uniqueCleanups.add(fn);
        }
        this.activePresenceHeartbeatsByKey.delete(key);
      }
    }
    for (const fn of uniqueCleanups) {
      fn();
      stoppedCount++;
    }
    return stoppedCount;
  }

  /**
   * Deep OSINT Profile Inspector (`fetchFullProfileInfo`) powered by official Baileys `USyncQuery`
   * (`executeOfficialUSyncAccountLookup`), `getBusinessProfile`, HD `profilePictureUrl` + binary buffer download,
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

    // 1. Run official Baileys USync account lookup (Contact + LID + Status + DisappearingMode + Devices)
    const usync = await this.executeOfficialUSyncAccountLookup(sock, recipient);
    let pnJid = usync.pnJid || (validated.isLid ? '' : jidNormalizedUser(validated.jid));
    let lidJid =
      usync.lidJid || (validated.isLid ? jidNormalizedUser(validated.jid) : undefined);
    const targetQueryJid = pnJid || lidJid || validated.jid;

    // Subscribe to presence early so the server pushes presence while parallel queries run
    void this.ensureSelfPresenceAvailable(sock, targetQueryJid);
    void sock.presenceSubscribe(targetQueryJid).catch(() => undefined);
    if (lidJid && lidJid !== targetQueryJid) {
      void sock.presenceSubscribe(lidJid).catch(() => undefined);
    }

    // 2. Run parallel queries for Business Profile, Profile Picture (HD + Preview + Binary Buffer), and Shared Groups
    const profilePicture: WhatsAppFullProfileReport['profilePicture'] = {
      status: 'NO_PICTURE',
      statusReasonArabic: 'لا توجد صورة شخصية متاحة',
      ...(usync.pictureId ? { pictureId: usync.pictureId } : {}),
    };

    const [bizSettled] = await Promise.allSettled([
      // (A) Business Profile (`getBusinessProfile`)
      (async () => {
        if (typeof sock.getBusinessProfile !== 'function') return undefined;
        return await sock.getBusinessProfile(targetQueryJid);
      })(),

      // (B) Profile Picture with fallback & privacy/404 classification + binary download
      (async () => {
        if (typeof sock.profilePictureUrl !== 'function') return;
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
      })(),

      // (C) Populate groupMetadataCache once if empty
      (async () => {
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
      })(),
    ]);

    const statusText = usync.statusText;
    const statusSetAt =
      usync.statusSetAt &&
      !Number.isNaN(usync.statusSetAt.getTime()) &&
      usync.statusSetAt.getTime() > 0
        ? usync.statusSetAt.toISOString()
        : undefined;

    const disappearingMode: WhatsAppFullProfileReport['disappearingMode'] =
      typeof usync.disappearingDuration === 'number'
        ? {
            durationSeconds: usync.disappearingDuration,
            ...(usync.disappearingSetAt &&
            !Number.isNaN(usync.disappearingSetAt.getTime()) &&
            usync.disappearingSetAt.getTime() > 0
              ? { setAtIso: usync.disappearingSetAt.toISOString() }
              : {}),
          }
        : undefined;

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

    // Parse Linked Devices from USync lookup
    const primaryDevice: number[] = [];
    const companionDevices: number[] = [];
    const seenDevs = new Set<number>();
    for (const d of usync.devices) {
      const devNum = typeof d?.id === 'number' ? d.id : 0;
      if (seenDevs.has(devNum)) continue;
      seenDevs.add(devNum);
      if (devNum === 0) {
        primaryDevice.push(0);
      } else {
        companionDevices.push(devNum);
      }
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

    let presenceRec =
      (pnJid ? this.memoryStore.presences.get(pnJid) : undefined) ||
      (lidJid ? this.memoryStore.presences.get(lidJid) : undefined);
    if (!presenceRec) {
      await new Promise((r) => setTimeout(r, 150));
      presenceRec =
        (pnJid ? this.memoryStore.presences.get(pnJid) : undefined) ||
        (lidJid ? this.memoryStore.presences.get(lidJid) : undefined);
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
    const digitsOnly = (
      jidDecode(finalPnJid)?.user || finalPnJid.split('@')[0]
    ).replace(/\D/g, '');
    const e164Phone = digitsOnly ? `+${digitsOnly}` : finalPnJid;

    return {
      queriedInput: recipient,
      existsOnWhatsApp: usync.exists,
      pnJid: finalPnJid,
      e164Phone,
      lidJid,
      pushName,
      verifiedName,
      statusText,
      statusSetAt,
      ...(usync.pictureId ? { pictureId: usync.pictureId } : {}),
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
   * Sends a short-timer self-destructing message (`1` to `60` seconds) using official Baileys patterns:
   * 1. Step A: Optional `{ disappearingMessagesInChat: expSec }` protocol message (and `<iq xmlns="w:g2">` for groups/explicit IQ)
   * 2. Step B: `sock.sendMessage(resolvedJid, { text, contextInfo: { expiration: expSec, ... } }, { ephemeralExpiration: expSec })`
   * 3. Step C: Deterministic auto-revoke timer (`{ delete: exactSentKey }`) triggered `ON_SEND` or `ON_READ` (`messages.update` status >= 4 or `message-receipt.update`).
   */
  public async sendShortEphemeralMessage(params: {
    recipient: string;
    text: string;
    expirationSeconds: number;
    triggerMode?: 'ON_SEND' | 'ON_READ';
    setChatEphemeralIq?: boolean;
    useRevokeDelete?: boolean;
    viewOnce?: boolean;
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
    const cleanRecipient = String(params.recipient || '').includes('@')
      ? String(params.recipient || '').trim()
      : String(params.recipient || '').replace(/[\s\-()]+/g, '');
    const validated = validateRecipient(cleanRecipient);
    const resolvedJid = validated.jid.endsWith('@s.whatsapp.net')
      ? await this.resolveDirectRecipientJid(sock, validated.jid)
      : jidNormalizedUser(validated.jid);

    // Step A: Set chat disappearing timer when requested (official Baileys `{ disappearingMessagesInChat }` + group `<iq xmlns="w:g2">`)
    if (params.setChatEphemeralIq === true) {
      await sock
        .sendMessage(resolvedJid, {
          disappearingMessagesInChat: expSec,
        } as AnyMessageContent)
        .catch(() => undefined);
    }
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

    // Step B: Send message with official Baileys `{ ephemeralExpiration: expSec }` option + `contextInfo.expiration`
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await sock.sendMessage(
      resolvedJid,
      {
        text: params.text,
        ...(params.viewOnce ? { viewOnce: true } : {}),
        contextInfo: {
          expiration: expSec,
          ephemeralSettingTimestamp: nowSec,
          disappearingMode: {
            initiator: 0,
          },
        },
      } as AnyMessageContent,
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

    // Step C: Protocol Auto-Revoke Timer (`{ delete: exactSentKey }`)
    const shouldScheduleRevokeDelete = Boolean(
      params.useRevokeDelete ??
        (params.setChatEphemeralIq === true || triggerMode === 'ON_READ')
    );

    const nowMs = Date.now();
    let scheduledRevokeAtMs = nowMs + expSec * 1000;

    if (shouldScheduleRevokeDelete) {
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

  /**
   * Pre-warms USync device discovery, bidirectional `LID <-> PN` mapping, `'device-list'` storage,
   * and E2E Signal sessions (`migrateSession` + `assertSessions`) before initiating an outbound VoIP call
   * so `@hiroosy/baileys-lite/voip` never fails with `no device sessions to encrypt the call offer for <lid>@lid`.
   */
  public async preparePeerForVoipCall(targetInput: string): Promise<{
    dialTargetJid: string;
    pnJid?: string;
    lidJid?: string;
    deviceJids: string[];
  }> {
    const sock = this.ensureSocket();
    const rawTrimmed = String(targetInput || '').trim();
    const sanitizedInput = rawTrimmed.replace(/:\d+@/, '@');

    let pnJid: string | undefined;
    let lidJid: string | undefined;

    if (sanitizedInput.endsWith('@lid')) {
      lidJid = jidNormalizedUser(sanitizedInput);
      const mappedPn =
        this.memoryStore.getPnForLid(lidJid) ||
        (await sock.signalRepository?.lidMapping
          ?.getPNForLID?.(lidJid)
          .catch(() => undefined)) ||
        undefined;
      if (mappedPn) {
        pnJid = jidNormalizedUser(mappedPn);
      }
    } else {
      const digits = sanitizedInput.split('@')[0]?.replace(/\D/g, '') || '';
      if (digits) {
        const candidatePn = `${digits}@s.whatsapp.net`;
        pnJid = await this.resolveDirectRecipientJid(sock, candidatePn).catch(
          () => candidatePn
        );
      }
      if (pnJid) {
        const mappedLid =
          this.memoryStore.getLidForPn(pnJid) ||
          this.extractLidString(
            await sock.signalRepository?.lidMapping
              ?.getLIDForPN?.(pnJid)
              .catch(() => undefined)
          );
        if (mappedLid && mappedLid.endsWith('@lid')) {
          lidJid = mappedLid;
        }
      }
    }

    if (!lidJid && pnJid) {
      try {
        const lookup = await this.executeOfficialUSyncAccountLookup(sock, pnJid);
        if (lookup.pnJid && lookup.pnJid.endsWith('@s.whatsapp.net')) {
          pnJid = jidNormalizedUser(lookup.pnJid);
        }
        if (lookup.lidJid && lookup.lidJid.endsWith('@lid')) {
          lidJid = jidNormalizedUser(lookup.lidJid);
        }
      } catch {
        // Non-fatal
      }
    }

    if (lidJid && pnJid) {
      await this.persistLidPnMappingOnSocket(sock, lidJid, pnJid);
    }

    const deviceNumbers = new Set<number>([0]);
    if (typeof sock.getUSyncDevices === 'function') {
      const fetchTargets = Array.from(
        new Set([pnJid, lidJid].filter((j): j is string => Boolean(j)))
      );
      if (fetchTargets.length > 0) {
        const fetched = await sock
          .getUSyncDevices(fetchTargets, false, false)
          .catch(() => []);
        if (Array.isArray(fetched)) {
          for (const d of fetched) {
            if (typeof d?.device === 'number' && Number.isFinite(d.device) && d.device >= 0) {
              deviceNumbers.add(d.device);
            }
          }
        }
      }
    }

    const pnUser = pnJid ? jidDecode(pnJid)?.user : undefined;
    const lidUser = lidJid ? jidDecode(lidJid)?.user : undefined;
    const deviceStrList = Array.from(deviceNumbers).map((n) => String(n));

    if (sock.authState?.keys?.set && (pnUser || lidUser)) {
      const deviceListUpdate: Record<string, string[]> = {};
      if (pnUser) deviceListUpdate[pnUser] = deviceStrList;
      if (lidUser) deviceListUpdate[lidUser] = deviceStrList;
      await sock.authState.keys
        .set({ 'device-list': deviceListUpdate } as never)
        .catch(() => undefined);
    }

    if (
      pnJid &&
      lidJid &&
      typeof sock.signalRepository?.migrateSession === 'function'
    ) {
      await sock.signalRepository
        .migrateSession(pnJid, lidJid)
        .catch(() => undefined);
    }

    const deviceJids: string[] = [];
    for (const devNum of deviceNumbers) {
      if (lidUser) {
        deviceJids.push(
          jidEncode(lidUser, 'lid', devNum > 0 ? devNum : undefined)
        );
      }
      if (pnUser) {
        deviceJids.push(
          jidEncode(
            pnUser,
            's.whatsapp.net',
            devNum > 0 ? devNum : undefined
          )
        );
      }
    }

    if (typeof sock.assertSessions === 'function' && deviceJids.length > 0) {
      const primaryTargets = lidUser
        ? Array.from(deviceNumbers).map((d) =>
            jidEncode(lidUser, 'lid', d > 0 ? d : undefined)
          )
        : deviceJids;
      await sock.assertSessions(primaryTargets, false).catch(async () => {
        if (pnUser) {
          const pnTargets = Array.from(deviceNumbers).map((d) =>
            jidEncode(pnUser, 's.whatsapp.net', d > 0 ? d : undefined)
          );
          await sock.assertSessions!(pnTargets, false).catch(() => false);
          if (
            pnJid &&
            lidJid &&
            typeof sock.signalRepository?.migrateSession === 'function'
          ) {
            await sock.signalRepository
              .migrateSession(pnJid, lidJid)
              .catch(() => undefined);
          }
        }
        return false;
      });
    }

    await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()]);

    return {
      dialTargetJid: pnJid || lidJid || sanitizedInput,
      pnJid,
      lidJid,
      deviceJids,
    };
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
    const messageId = `sim_msg_${this.sessionId}_${Date.now()}`;
    getNetworkTrafficMonitor().recordWhatsAppStanza({
      sessionId: this.sessionId,
      direction: 'OUTBOUND',
      node: {
        tag: 'message',
        attrs: { id: messageId, to: recipientJid, type: 'text' },
        content: [{ tag: 'body', attrs: {}, content: text.slice(0, 180) }],
      },
      durationMs: Math.max(1, this.simulatedDelayMs),
      statusCode: 'SENT',
    });
    log.debug('Simulated text message sent', {
      sessionId: this.sessionId,
      recipientJid,
      length: text.length,
    });
    return { messageId };
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

  public async resolveIdentity(
    targetInput: string
  ): Promise<LidResolutionResult | null> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const raw = String(targetInput || '').trim();
    if (!raw) return null;
    if (raw.startsWith('@')) {
      const handle = raw.slice(1).toLowerCase();
      const mapped = this.mockUsernameDirectory.get(handle);
      if (!mapped) return null;
      return {
        pnJid: mapped.pnJid,
        lidJid: mapped.lidJid,
        phoneNumber: mapped.pnJid ? `+${mapped.pnJid.split('@')[0]}` : undefined,
        username: handle,
        source: 'usync',
      };
    }
    if (raw.endsWith('@lid')) {
      const validated = validateRecipient(raw);
      return {
        lidJid: validated.jid,
        source: 'direct',
      };
    }
    const res = await this.resolveLidForRecipient(raw);
    return {
      pnJid: res.pnJid,
      lidJid: res.lidJid,
      phoneNumber: res.pnJid ? `+${res.pnJid.split('@')[0]}` : undefined,
      source: 'usync',
    };
  }

  public async sendLidAddressedMessage(
    params: SendLidAddressedParams
  ): Promise<SendLidAddressedResult> {
    const text =
      typeof params.content === 'string'
        ? params.content
        : typeof (params.content as { text?: unknown }).text === 'string'
          ? String((params.content as { text?: string }).text)
          : '[media]';
    const legacy = await this.sendAnonymousLidMessage({
      recipient: params.target,
      text,
      customPushName: params.customPushName,
    });
    const usingLid = legacy.targetLid.endsWith('@lid');
    return {
      messageId: legacy.messageId,
      targetJid: legacy.targetLid,
      pnJid: legacy.resolvedPn,
      lidJid: usingLid ? legacy.targetLid : undefined,
      addressingMode: usingLid ? 'lid' : 'pn',
      resolutionSource: 'usync',
      tcTokenAttached: Boolean(this.mockPrivacyTokens.get(legacy.targetLid)),
    };
  }

  public async deliverRelayPayload(params: {
    targetJid: string;
    preferLid?: boolean;
    content: AnyMessageContent;
    quotedMessageId?: string;
    customPushName?: string;
  }): Promise<{
    messageId: string;
    deliveredToJid: string;
    addressingMode: 'lid' | 'pn';
  }> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    const messageId = `sim_relay_${this.sessionId}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    this.sentMessagesCount++;
    this.sentAnonymousLidMessages.push({
      recipient: params.targetJid,
      targetLid: params.targetJid,
      text: JSON.stringify(params.content).slice(0, 200),
      messageId,
    });
    return {
      messageId,
      deliveredToJid: params.targetJid,
      addressingMode: params.targetJid.endsWith('@lid') ? 'lid' : 'pn',
    };
  }

  private readonly mockPrivacyTokens = new Map<string, PrivacyTokenRecord>();
  private mockSelfUsername?: string;
  private mockSelfUsernamePin?: string;
  private readonly mockUsernameDirectory = new Map<
    string,
    { pnJid?: string; lidJid: string; pin?: string }
  >();
  public mockReachoutTimelock: ReachoutTimelockInfo = { isActive: false };

  public async getPrivacyTokenInfo(
    targetJid: string
  ): Promise<PrivacyTokenRecord | null> {
    return this.mockPrivacyTokens.get(targetJid) || null;
  }

  public async ensurePrivacyToken(
    targetJid: string,
    forceRefresh = false
  ): Promise<{ record: PrivacyTokenRecord | null; refreshed: boolean }> {
    const existing = this.mockPrivacyTokens.get(targetJid);
    if (existing && !existing.expired && !forceRefresh) {
      return { record: existing, refreshed: false };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const rec: PrivacyTokenRecord = {
      storageJid: targetJid,
      hasToken: true,
      timestampSec: nowSec,
      senderTimestampSec: nowSec,
      expired: false,
      source: 'outgoing_issue',
      updatedAtIso: new Date().toISOString(),
    };
    this.mockPrivacyTokens.set(targetJid, rec);
    return { record: rec, refreshed: true };
  }

  public async getReachoutStatus(): Promise<ReachoutTimelockInfo> {
    return { ...this.mockReachoutTimelock };
  }

  public async checkUsername(
    handle: string,
    pin?: string
  ): Promise<WhatsAppUsernameState> {
    const clean = handle.trim().replace(/^@/, '');
    const found = this.mockUsernameDirectory.get(clean.toLowerCase());
    if (!found) {
      return {
        username: clean,
        available: true,
        supported: true,
        status: 'available',
        reasonArabic: `اسم المستخدم (@${clean}) متاح للاستخدام (محاكاة).`,
        source: 'socket_iq',
      };
    }
    if (found.pin && found.pin !== pin) {
      return {
        username: clean,
        available: false,
        supported: true,
        status: 'key-required',
        reasonArabic: `اسم المستخدم (@${clean}) محمي برمز PIN.`,
        source: 'socket_iq',
      };
    }
    return {
      username: clean,
      available: false,
      jid: found.pnJid || found.lidJid,
      lidJid: found.lidJid,
      supported: true,
      status: 'taken',
      reasonArabic: `اسم المستخدم (@${clean}) مستخدم بالفعل.`,
      source: 'socket_iq',
    };
  }

  public async setUsername(handle: string): Promise<WhatsAppUsernameState> {
    const clean = handle.trim().replace(/^@/, '');
    if (this.mockSelfUsername) {
      this.mockUsernameDirectory.delete(this.mockSelfUsername.toLowerCase());
    }
    this.mockSelfUsername = clean;
    this.mockUsernameDirectory.set(clean.toLowerCase(), {
      pnJid: this.currentJid,
      lidJid: `1000${this.currentJid.split('@')[0].slice(-10).padStart(10, '0')}@lid`,
      pin: this.mockSelfUsernamePin,
    });
    return {
      username: clean,
      jid: this.currentJid,
      supported: true,
      status: 'ok',
      reasonArabic: `تم تعيين اسم المستخدم (@${clean}) بنجاح (محاكاة).`,
      source: 'socket_iq',
    };
  }

  public async deleteUsername(): Promise<WhatsAppUsernameState> {
    if (this.mockSelfUsername) {
      this.mockUsernameDirectory.delete(this.mockSelfUsername.toLowerCase());
      this.mockSelfUsername = undefined;
    }
    return {
      supported: true,
      status: 'ok',
      reasonArabic: 'تم حذف اسم المستخدم المرتبط بالجلسة (محاكاة).',
      source: 'socket_iq',
    };
  }

  public async setUsernamePin(pin: string): Promise<WhatsAppUsernameState> {
    this.mockSelfUsernamePin = pin;
    if (this.mockSelfUsername) {
      const entry = this.mockUsernameDirectory.get(
        this.mockSelfUsername.toLowerCase()
      );
      if (entry) entry.pin = pin;
    }
    return {
      username: this.mockSelfUsername,
      supported: true,
      status: 'ok',
      reasonArabic: 'تم تحديث رمز الحماية PIN لاسم المستخدم (محاكاة).',
      source: 'socket_iq',
    };
  }

  public async recommendUsername(
    seed = 'botezz_user'
  ): Promise<UsernameRecommendationResult> {
    const clean = seed.replace(/[^a-zA-Z0-9._]/g, '') || 'botezz_user';
    const candidates = [clean, `${clean}_01`, `${clean}.official`].map((u) => ({
      username: u,
      available: !this.mockUsernameDirectory.has(u.toLowerCase()),
      status: (this.mockUsernameDirectory.has(u.toLowerCase())
        ? 'taken'
        : 'available') as WhatsAppUsernameState['status'],
    }));
    return { seed: clean, supported: true, candidates };
  }

  public async getSelfUsernameState(): Promise<WhatsAppUsernameState> {
    return {
      username: this.mockSelfUsername,
      jid: this.currentJid,
      supported: true,
      status: this.mockSelfUsername ? 'ok' : 'not-found',
      reasonArabic: this.mockSelfUsername
        ? `اسم المستخدم الحالي: @${this.mockSelfUsername}`
        : 'لا يوجد اسم مستخدم مضبوط حالياً.',
      source: 'creds',
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
    const userDigits = chatJid.split('@')[0];
    const primaryDeviceJid = `${userDigits}:0@s.whatsapp.net`;
    const companionDeviceJid = `${userDigits}:33@s.whatsapp.net`;
    const durationSec = Math.min(
      300,
      Math.max(1, Math.floor(Number(params.durationSeconds) || 15))
    );
    const now = Date.now();
    const watchId = `pw_mock_${now.toString(36)}`;
    const rttHistory = [48, 41, 38, 44, 42];
    const rttSamples: RttProbeSample[] = rttHistory.map((rtt, idx) => ({
      probeSeq: idx + 1,
      probeMsgId: `3EB0MOCKPROBE00${idx + 1}`,
      fakeTargetMsgId: `3EB0FAKE0000000${idx + 1}`,
      targetJid: chatJid,
      sentAtMs: now - (rttHistory.length - idx) * 400,
      ackedAtMs: now - (rttHistory.length - idx) * 400 + rtt,
      rttMs: rtt,
      status: 'ACKED',
      captureLayer: idx % 2 === 0 ? 'messages.update' : 'CB:receipt',
      respondingDeviceJid: idx === 2 ? companionDeviceJid : primaryDeviceJid,
      respondingDeviceId: idx === 2 ? 33 : 0,
      isBacklogFlush: false,
      classifiedStateAfterProbe: 'ACTIVE',
      movingAvgRttMs: 43,
      medianRttMs: 42,
      thresholdMs: 378,
    }));
    const record: TrackedPresenceRecord = {
      watchId,
      sessionId: this.sessionId,
      targetPhone: `+${userDigits}`,
      chatJid,
      resolvedLid: resolved.lidJid,
      currentState: 'available',
      deviceActivityState: 'ACTIVE',
      lastSeenTimestampSec: Math.floor(now / 1000),
      lastUpdatedMs: now,
      probeRttMs: 42,
      lastRttMs: 42,
      movingAvgRttMs: 43,
      avgRttMs: 43,
      medianRttMs: 42,
      minRttMs: 38,
      maxRttMs: 48,
      dynamicThresholdMs: 378,
      jitterMs: 5,
      probesSent: 5,
      probesAcked: 5,
      probesTimedOut: 0,
      deliveryRatePct: 100,
      rttSamples,
      rttHistory,
      sparkline: renderRttSparkline(rttHistory),
      detectedDevices: [primaryDeviceJid, companionDeviceJid],
      respondingDevices: [primaryDeviceJid, companionDeviceJid],
      linkedDevices: [primaryDeviceJid, companionDeviceJid],
      activeDevices: [primaryDeviceJid, companionDeviceJid],
      privacyLastSeenDenied: false,
      startedAtMs: now - durationSec * 1000,
      endedAtMs: now,
      elapsedSeconds: durationSec,
      targetDurationSeconds: durationSec,
      activeDurationMs: Math.min(durationSec * 1000, 3500),
      standbyDurationMs: 0,
      offlineDurationMs: 0,
      stoppedEarly: false,
      lastActivitySource: 'rtt_probe',
      transitions: [
        {
          state: 'available',
          activityState: 'ACTIVE',
          timestampMs: now - 1500,
          participantJid: chatJid,
          deviceJid: primaryDeviceJid,
          deviceId: 0,
          rttMs: 48,
          source: 'rtt_probe',
        },
        {
          state: 'composing',
          activityState: 'ACTIVE',
          timestampMs: now - 900,
          participantJid: resolved.lidJid,
          deviceJid: primaryDeviceJid,
          deviceId: 0,
          rttMs: 41,
          source: 'chatstate',
        },
        {
          state: 'paused',
          activityState: 'ACTIVE',
          timestampMs: now - 400,
          participantJid: resolved.lidJid,
          deviceJid: companionDeviceJid,
          deviceId: 33,
          rttMs: 38,
          source: 'chatstate',
        },
        {
          state: 'available',
          activityState: 'ACTIVE',
          timestampMs: now,
          participantJid: chatJid,
          deviceJid: primaryDeviceJid,
          deviceId: 0,
          rttMs: 42,
          source: 'rtt_probe',
        },
      ],
      totalOnlineDurationMs: Math.min(durationSec * 1000, 3500),
    };
    params.onUpdate?.(record);
    return record;
  }

  public async startPresenceHeartbeatBroadcast(params: {
    recipient: string;
    mode: 'composing' | 'recording' | 'available';
    durationSeconds: number;
    pulseIntervalMs?: number;
    onProgress?: (info: {
      pulsesSent: number;
      elapsedSeconds: number;
      durationSeconds: number;
      mode: 'composing' | 'recording' | 'available';
      targetJid: string;
    }) => void;
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
    params.onProgress?.({
      pulsesSent,
      elapsedSeconds: durationSec,
      durationSeconds: durationSec,
      mode: params.mode,
      targetJid: validated.jid,
    });
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

  public stopTrackingRecipientPresence(_recipient?: string): number {
    return 1;
  }

  public stopPresenceHeartbeat(_recipient?: string): number {
    return 1;
  }

  public async sendShortEphemeralMessage(params: {
    recipient: string;
    text: string;
    expirationSeconds: number;
    triggerMode?: 'ON_SEND' | 'ON_READ';
    setChatEphemeralIq?: boolean;
    useRevokeDelete?: boolean;
    viewOnce?: boolean;
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
    getNetworkTrafficMonitor().recordWhatsAppStanza({
      sessionId: this.sessionId,
      direction: 'OUTBOUND',
      node: node as unknown as InspectableBinaryNode,
      durationMs: Math.max(1, this.simulatedDelayMs),
      statusCode: 'SENT',
    });
  }

  public async query(node: BinaryNode, _timeoutMs?: number): Promise<unknown> {
    if (!this.connected || !this.registered) {
      throw new WhatsAppConnectionError('الجلسة غير متصلة حالياً.');
    }
    this.sentNodes.push(node);
    const responseNode: InspectableBinaryNode = {
      tag: 'iq',
      attrs: { type: 'result', id: node.attrs?.id },
      content: [],
    };
    getNetworkTrafficMonitor().recordWhatsAppStanza({
      sessionId: this.sessionId,
      direction: 'OUTBOUND',
      node: node as unknown as InspectableBinaryNode,
      responseNode,
      durationMs: Math.max(1, this.simulatedDelayMs),
      statusCode: 'RESULT',
    });
    return responseNode;
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

  public get forensicAnalyzer(): ForensicPayloadAnalyzer {
    return getForensicPayloadAnalyzer();
  }

  public simulateIncomingMessage(rawMessage: Record<string, unknown>): void {
    const untouchedForForensics: Record<string, unknown> = {
      ...rawMessage,
      message:
        rawMessage?.message && typeof rawMessage.message === 'object'
          ? { ...(rawMessage.message as Record<string, unknown>) }
          : rawMessage?.message,
    };
    void this.forensicAnalyzer
      .captureIncomingPayload({
        sessionId: this.sessionId,
        rawEventType: 'messages.upsert',
        rawWaMessage: untouchedForForensics,
        botSelfJids: [this.currentJid].filter(Boolean),
      })
      .catch(() => undefined);

    const { sanitizedMessage } =
      sanitizeIncomingMessageForDownstream(rawMessage);
    this.callbacks?.onIncomingMessage?.({
      sessionId: this.sessionId,
      rawMessage: sanitizedMessage,
    });
  }

  public simulateIncomingBinaryStanza(
    eventType: 'CB:message' | 'CB:iq' | 'CB:call' | 'CB:notification',
    node: BinaryNode
  ): void {
    void this.forensicAnalyzer
      .captureIncomingPayload({
        sessionId: this.sessionId,
        rawEventType: `ws.${eventType}` as RawForensicEventType,
        rawBinaryNode: node,
      })
      .catch(() => undefined);
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

