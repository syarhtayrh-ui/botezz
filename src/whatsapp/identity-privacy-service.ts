import {
  WASocket,
  BinaryNode,
  AnyMessageContent,
  WAMessageKey,
  USyncQuery,
  USyncUser,
  ReachoutTimelockInfo,
  TcTokenEntry,
  S_WHATSAPP_NET,
  jidNormalizedUser,
  isLidUser,
  isPnUser,
  areJidsSameUser,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  generateWAMessageFromContent,
  isTcTokenExpired,
  shouldSendNewTcToken,
  resolveTcTokenJid,
  resolveIssuanceJid,
  buildTcTokenFromJid,
  storeTcTokensFromIqResult,
  NACK_REASONS,
  SERVER_ERROR_CODES,
  normalizeUsername,
  isValidUsername,
  isValidUsernameKey,
} from './baileys-compat';

export interface SessionMemoryStoreLike {
  getLidForPn(pnJid: string): string | undefined;
  getPnForLid(lidJid: string): string | undefined;
  recordLidMapping(lidJid: string, pnJid: string): void;
}
import {
  getNetworkTrafficMonitor,
  InspectableBinaryNode,
} from '../network/network-traffic-monitor';
import { maskJidForDiagnostics, redactSensitiveData } from '../security/redaction';
import { validateRecipient } from '../security/validation';
import { WhatsAppConnectionError, ValidationError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('identity-privacy-service');

// ============================================================================
// Telemetry Helper (Zero raw secret leakage)
// ============================================================================

export type IdentityTelemetryEvent =
  | 'LID_RESOLUTION_STARTED'
  | 'LID_RESOLUTION_SUCCESS'
  | 'LID_RESOLUTION_FAILED'
  | 'USERNAME_CHECK'
  | 'USERNAME_SET'
  | 'USERNAME_DELETE'
  | 'USERNAME_PIN_SET'
  | 'TC_TOKEN_CAPTURED'
  | 'TC_TOKEN_REFRESHED'
  | 'TC_TOKEN_INJECTED'
  | 'MESSAGE_463'
  | 'REACHOUT_TIMELOCK_DETECTED'
  | 'ANON_SESSION_CREATED'
  | 'ANON_SESSION_MESSAGE_RELAYED'
  | 'ANON_SESSION_REPLY_RELAYED'
  | 'ANON_SESSION_CLOSED';

export function emitIdentityTelemetry(params: {
  sessionId: string;
  event: IdentityTelemetryEvent;
  targetJid?: string;
  outcome?: 'SUCCESS' | 'ERROR';
  durationMs?: number;
  metadata?: Record<string, unknown>;
}): void {
  try {
    const monitor = getNetworkTrafficMonitor();
    const maskedTarget = params.targetJid
      ? maskJidForDiagnostics(params.targetJid)
      : 'self';
    const safeMetadata = params.metadata
      ? (redactSensitiveData(params.metadata) as Record<string, unknown>)
      : {};
    monitor.pushEntry({
      channel: 'WA_STANZA',
      direction: 'OUTBOUND',
      sessionId: params.sessionId,
      methodOrTag: params.event,
      targetOrUrl: `wa://identity/${maskedTarget}`,
      summary: `${params.event} (${maskedTarget})`,
      statusCode: params.outcome === 'ERROR' ? 463 : 200,
      outcome: params.outcome === 'ERROR' ? 'ERROR' : 'SUCCESS',
      durationMs: params.durationMs ?? 0,
      txBytes: 0,
      rxBytes: 0,
      stanzaAttrs: {
        event: params.event,
        target: maskedTarget,
      },
      requestBodyPreview: JSON.stringify(safeMetadata),
      errorDetail:
        params.outcome === 'ERROR' && typeof safeMetadata.reason === 'string'
          ? safeMetadata.reason
          : undefined,
    });
  } catch {
    // Telemetry must never break protocol execution
  }
}

// ============================================================================
// Feature A1: Native PN <-> LID Resolution & Identity Service
// ============================================================================

export type LidResolutionSource = 'usync' | 'mapping' | 'cache' | 'direct';

export interface LidResolutionResult {
  pnJid?: string;
  lidJid?: string;
  phoneNumber?: string;
  username?: string;
  source: LidResolutionSource;
}

export interface SendLidAddressedParams {
  target: string;
  content: AnyMessageContent | string;
  quoted?: {
    key: WAMessageKey;
    message?: Record<string, unknown>;
  };
  customPushName?: string;
  preferLid?: boolean;
  ensurePrivacyToken?: boolean;
}

export interface SendLidAddressedResult {
  messageId: string;
  targetJid: string;
  pnJid?: string;
  lidJid?: string;
  addressingMode: 'lid' | 'pn';
  resolutionSource: LidResolutionSource;
  tcTokenAttached: boolean;
  diagnostic?: ReachoutDiagnostic;
}

// ============================================================================
// Feature A2: TC-Token / CS-Token & Error 463 / Reachout Timelock
// ============================================================================

export interface PrivacyTokenRecord {
  storageJid: string;
  hasToken: boolean;
  timestampSec?: number;
  senderTimestampSec?: number;
  expired: boolean;
  source: 'incoming_iq' | 'incoming_message' | 'outgoing_issue' | 'auth_store';
  updatedAtIso: string;
}

export type ReachoutFailureReason =
  | 'TOKEN_EXPIRED'
  | 'TOKEN_UNAVAILABLE'
  | 'REACHOUT_TIMELOCK'
  | 'MISSING_TC_TOKEN'
  | 'MESSAGE_REJECTED';

export interface ReachoutDiagnostic {
  code?: number | string;
  reason: ReachoutFailureReason;
  targetJid: string;
  timelockActive: boolean;
  timelockEndsAtIso?: string;
  enforcementType?: string;
  retried: boolean;
  recovered: boolean;
  detailArabic: string;
  detailTechnical?: string;
}

// ============================================================================
// Feature B: WhatsApp Username Management
// ============================================================================

export interface WhatsAppUsernameState {
  username?: string;
  usernameKey?: string;
  available?: boolean;
  jid?: string;
  lidJid?: string;
  supported: boolean;
  status:
    | 'ok'
    | 'available'
    | 'taken'
    | 'key-required'
    | 'not-found'
    | 'unsupported'
    | 'error';
  reasonArabic: string;
  source: 'usync' | 'socket_iq' | 'mex' | 'creds';
}

export interface UsernameRecommendationResult {
  seed: string;
  candidates: Array<{
    username: string;
    available: boolean;
    status: WhatsAppUsernameState['status'];
  }>;
  supported: boolean;
}

function extractCleanLid(raw: unknown): string | undefined {
  if (!raw) return undefined;
  let candidate: string | undefined;
  if (typeof raw === 'string') {
    candidate = raw.trim();
  } else if (typeof raw === 'object') {
    const obj = raw as { id?: unknown; lid?: unknown; val?: unknown; jid?: unknown };
    const val = obj.lid ?? obj.id ?? obj.val ?? obj.jid;
    if (typeof val === 'string') candidate = val.trim();
  }
  if (!candidate) return undefined;
  const user = candidate.split('@')[0]?.split(':')[0]?.trim();
  if (!user || !/^\d{5,}$/.test(user)) return undefined;
  if (candidate.endsWith('@s.whatsapp.net')) return undefined;
  return `${user}@lid`;
}

function extractCleanPn(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.endsWith('@lid') || trimmed.endsWith('@g.us')) {
    return undefined;
  }
  const user = trimmed.split('@')[0]?.split(':')[0]?.replace(/\D/g, '');
  if (!user || user.length < 7 || user.length > 15) return undefined;
  return `${user}@s.whatsapp.net`;
}

function extractLidAttrFromBinaryNode(node: BinaryNode | undefined): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (node.tag === 'lid' && node.attrs) {
    const val = node.attrs.jid || node.attrs.val || node.attrs.id;
    const lid = extractCleanLid(val);
    if (lid) return lid;
  }
  if (node.attrs) {
    const fromAttr = extractCleanLid(node.attrs.lid);
    if (fromAttr) return fromAttr;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (child && typeof child === 'object' && 'tag' in child) {
        const found = extractLidAttrFromBinaryNode(child as BinaryNode);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function extractPnAttrFromBinaryNode(node: BinaryNode | undefined): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (node.attrs) {
    const fromPn = extractCleanPn(
      node.attrs.pn || node.attrs.phone_number || node.attrs.sender_pn || node.attrs.jid
    );
    if (fromPn) return fromPn;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (child && typeof child === 'object' && 'tag' in child) {
        const found = extractPnAttrFromBinaryNode(child as BinaryNode);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function extractUsernameAttrFromBinaryNode(node: BinaryNode | undefined): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (node.tag === 'username') {
    if (typeof node.content === 'string' && node.content.trim()) {
      return normalizeUsername(node.content);
    }
    if (Buffer.isBuffer(node.content) || node.content instanceof Uint8Array) {
      const str = Buffer.from(node.content).toString('utf8').trim();
      if (str) return normalizeUsername(str);
    }
    if (node.attrs?.username) {
      return normalizeUsername(node.attrs.username);
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (child && typeof child === 'object' && 'tag' in child) {
        const found = extractUsernameAttrFromBinaryNode(child as BinaryNode);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function isUnsupportedIqError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    const text = String(err || '').toLowerCase();
    return (
      text.includes('not-implemented') ||
      text.includes('feature-not-implemented') ||
      text.includes('service-unavailable') ||
      text.includes('unsupported') ||
      text.includes('501') ||
      text.includes('405')
    );
  }
  const anyErr = err as {
    message?: string;
    data?: number | string | { code?: number; text?: string };
    output?: { statusCode?: number; payload?: { statusCode?: number } };
  };
  const code =
    anyErr.output?.statusCode ??
    anyErr.output?.payload?.statusCode ??
    (typeof anyErr.data === 'number'
      ? anyErr.data
      : typeof anyErr.data === 'object' && anyErr.data !== null
        ? anyErr.data.code
        : undefined);
  if (code === 405 || code === 501 || code === 503) return true;
  const msg = `${anyErr.message || ''} ${
    typeof anyErr.data === 'object' ? anyErr.data?.text || '' : String(anyErr.data || '')
  }`.toLowerCase();
  return (
    msg.includes('not-implemented') ||
    msg.includes('feature-not-implemented') ||
    msg.includes('unsupported') ||
    msg.includes('not allowed') ||
    msg.includes('501') ||
    msg.includes('405')
  );
}

// ============================================================================
// Session-Scoped Privacy Token Manager (TC-Token / CS-Token / 463 Recovery)
// ============================================================================

export class PrivacyTokenManager {
  private readonly sessionId: string;
  private readonly getSocket: () => WASocket | null;
  private readonly memoryStore: SessionMemoryStoreLike;
  private readonly inFlightTokenRefreshes = new Map<
    string,
    Promise<PrivacyTokenRecord>
  >();
  private reachoutTimeLock: ReachoutTimelockInfo = { isActive: false };
  private selfUsernameCache?: string;

  constructor(params: {
    sessionId: string;
    getSocket: () => WASocket | null;
    memoryStore: SessionMemoryStoreLike;
  }) {
    this.sessionId = params.sessionId;
    this.getSocket = params.getSocket;
    this.memoryStore = params.memoryStore;
  }

  public getReachoutTimeLock(): ReachoutTimelockInfo {
    return { ...this.reachoutTimeLock };
  }

  public setSelfUsernameCache(username: string | undefined): void {
    this.selfUsernameCache = username ? normalizeUsername(username) : undefined;
  }

  public getSelfUsernameCache(): string | undefined {
    return this.selfUsernameCache;
  }

  public handleReachoutTimelockUpdate(info: ReachoutTimelockInfo): void {
    this.reachoutTimeLock = {
      isActive: Boolean(info.isActive),
      timeEnforcementEnds: info.timeEnforcementEnds,
      enforcementType: info.enforcementType,
    };
    if (this.reachoutTimeLock.isActive) {
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'REACHOUT_TIMELOCK_DETECTED',
        outcome: 'ERROR',
        metadata: {
          enforcementType: info.enforcementType || 'DEFAULT',
          timeEnforcementEnds: info.timeEnforcementEnds?.toISOString(),
        },
      });
    }
  }

  private getGetLIDForPN(sock: WASocket): (pn: string) => Promise<string | undefined> {
    return async (pn: string) => {
      try {
        const mapped = await sock.signalRepository?.lidMapping?.getLIDForPN(pn);
        if (mapped) return mapped;
      } catch {
        // Fallback to memory store
      }
      return this.memoryStore.getLidForPn(pn);
    };
  }

  private getGetPNForLID(sock: WASocket): (lid: string) => Promise<string | undefined> {
    return async (lid: string) => {
      try {
        const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(lid);
        if (mapped) return mapped;
      } catch {
        // Fallback to memory store
      }
      return this.memoryStore.getPnForLid(lid);
    };
  }

  /**
   * Captures and persists an incoming TC-token / CS-token IQ stanza or message attribute
   * using `@hiroosy/baileys-lite`'s `storeTcTokensFromIqResult` / `authState.keys`.
   * Never logs raw token bytes.
   */
  public async captureIncomingPrivacyToken(params: {
    iqNode?: BinaryNode;
    fallbackJid?: string;
    rawTokenBytes?: Uint8Array | Buffer;
    timestampSec?: number;
  }): Promise<PrivacyTokenRecord | null> {
    const sock = this.getSocket();
    if (!sock?.authState?.keys) return null;

    const getLIDForPN = this.getGetLIDForPN(sock);

    if (params.iqNode) {
      let storedJid: string | undefined;
      await storeTcTokensFromIqResult({
        result: params.iqNode,
        fallbackJid: params.fallbackJid,
        keys: sock.authState.keys,
        getLIDForPN,
        onNewJidStored: (jid) => {
          storedJid = jid;
        },
      });
      const resolvedStorageJid =
        storedJid ||
        (params.fallbackJid
          ? await resolveTcTokenJid(jidNormalizedUser(params.fallbackJid), getLIDForPN)
          : undefined);

      if (resolvedStorageJid) {
        const current = await this.getValidPrivacyToken(resolvedStorageJid);
        if (current) {
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'TC_TOKEN_CAPTURED',
            targetJid: resolvedStorageJid,
            metadata: {
              source: 'incoming_iq',
              timestampSec: current.timestampSec,
            },
          });
          return {
            ...current,
            source: 'incoming_iq',
          };
        }
      }
      return null;
    }

    if (
      params.fallbackJid &&
      params.rawTokenBytes &&
      params.rawTokenBytes.byteLength > 0
    ) {
      const normalized = jidNormalizedUser(params.fallbackJid);
      const storageJid = await resolveTcTokenJid(normalized, getLIDForPN);
      const existingData = await sock.authState.keys.get('tctoken', [storageJid]);
      const existingEntry = existingData[storageJid];
      const ts = params.timestampSec ?? Math.floor(Date.now() / 1000);
      await sock.authState.keys.set({
        tctoken: {
          [storageJid]: {
            ...existingEntry,
            token: Buffer.from(params.rawTokenBytes),
            timestamp: String(ts),
          },
        },
      });
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'TC_TOKEN_CAPTURED',
        targetJid: storageJid,
        metadata: {
          source: 'incoming_message',
          timestampSec: ts,
        },
      });
      return {
        storageJid,
        hasToken: true,
        timestampSec: ts,
        senderTimestampSec: existingEntry?.senderTimestamp,
        expired: false,
        source: 'incoming_message',
        updatedAtIso: new Date().toISOString(),
      };
    }

    return null;
  }

  /**
   * Retrieves a valid (non-expired) TC-token entry from `authState.keys`.
   * Automatically clears expired tokens while keeping `senderTimestamp` intact.
   */
  public async getValidPrivacyToken(
    targetJid: string
  ): Promise<PrivacyTokenRecord | null> {
    const sock = this.getSocket();
    if (!sock?.authState?.keys || !targetJid) return null;

    const normalized = jidNormalizedUser(targetJid);
    const getLIDForPN = this.getGetLIDForPN(sock);
    const storageJid = await resolveTcTokenJid(normalized, getLIDForPN);

    let data = await sock.authState.keys.get('tctoken', [storageJid]);
    let entry: TcTokenEntry | undefined = data?.[storageJid];
    let effectiveStorageJid = storageJid;

    if (!entry && normalized !== storageJid) {
      data = await sock.authState.keys.get('tctoken', [normalized]);
      if (data?.[normalized]) {
        entry = data[normalized];
        effectiveStorageJid = normalized;
      }
    }

    if (!entry) return null;

    const tokenLen = entry.token?.length ?? 0;
    const expired = entry.timestamp !== undefined ? isTcTokenExpired(entry.timestamp) : true;
    const tsNum =
      entry.timestamp !== undefined && !Number.isNaN(Number(entry.timestamp))
        ? Number(entry.timestamp)
        : undefined;

    if (tokenLen === 0 || expired) {
      if (tokenLen > 0 && expired) {
        const cleared: TcTokenEntry | null =
          entry.senderTimestamp !== undefined
            ? { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp }
            : null;
        await sock.authState.keys.set({
          tctoken: {
            [effectiveStorageJid]: cleared,
          },
        });
      }
      return {
        storageJid: effectiveStorageJid,
        hasToken: false,
        timestampSec: tsNum,
        senderTimestampSec: entry.senderTimestamp,
        expired: true,
        source: 'auth_store',
        updatedAtIso: new Date().toISOString(),
      };
    }

    return {
      storageJid: effectiveStorageJid,
      hasToken: true,
      timestampSec: tsNum,
      senderTimestampSec: entry.senderTimestamp,
      expired: false,
      source: 'auth_store',
      updatedAtIso: new Date().toISOString(),
    };
  }

  /**
   * Ensures a valid trusted-contact / CS token exists for `targetJid`, issuing or refreshing
   * via `sock.issuePrivacyTokens` when needed. Deduplicates concurrent refresh attempts.
   */
  public async ensurePrivacyToken(
    targetJid: string,
    options?: { forceRefresh?: boolean }
  ): Promise<{ record: PrivacyTokenRecord | null; refreshed: boolean }> {
    const sock = this.getSocket();
    if (!sock?.authState?.keys) {
      return { record: null, refreshed: false };
    }

    const normalized = jidNormalizedUser(targetJid);
    const existing = await this.getValidPrivacyToken(normalized);

    const needsRefresh =
      Boolean(options?.forceRefresh) ||
      !existing ||
      !existing.hasToken ||
      existing.expired ||
      shouldSendNewTcToken(existing.senderTimestampSec);

    if (!needsRefresh && existing?.hasToken) {
      return { record: existing, refreshed: false };
    }

    if (typeof sock.issuePrivacyTokens !== 'function') {
      return { record: existing, refreshed: false };
    }

    const getLIDForPN = this.getGetLIDForPN(sock);
    const getPNForLID = this.getGetPNForLID(sock);
    const storageJid = await resolveTcTokenJid(normalized, getLIDForPN);

    const inFlight = this.inFlightTokenRefreshes.get(storageJid);
    if (inFlight) {
      const record = await inFlight;
      return { record, refreshed: true };
    }

    const refreshPromise = (async (): Promise<PrivacyTokenRecord> => {
      const issueTimestamp = Math.floor(Date.now() / 1000);
      const issueToLid = Boolean(sock.serverProps?.lidTrustedTokenIssueToLid);
      const issueJid = await resolveIssuanceJid(
        normalized,
        issueToLid,
        getLIDForPN,
        getPNForLID
      );
      const iqResult = await sock.issuePrivacyTokens!([issueJid], issueTimestamp);
      if (iqResult) {
        await storeTcTokensFromIqResult({
          result: iqResult,
          fallbackJid: storageJid,
          keys: sock.authState.keys,
          getLIDForPN,
        });
      }
      const afterData = await sock.authState.keys.get('tctoken', [storageJid]);
      const afterEntry = afterData?.[storageJid];
      await sock.authState.keys.set({
        tctoken: {
          [storageJid]: {
            token: Buffer.alloc(0),
            ...afterEntry,
            senderTimestamp: issueTimestamp,
          },
        },
      });
      const updated = await this.getValidPrivacyToken(storageJid);
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'TC_TOKEN_REFRESHED',
        targetJid: storageJid,
        metadata: {
          hasToken: Boolean(updated?.hasToken),
          senderTimestampSec: issueTimestamp,
        },
      });
      return (
        updated || {
          storageJid,
          hasToken: Boolean(afterEntry?.token?.length),
          timestampSec: afterEntry?.timestamp ? Number(afterEntry.timestamp) : undefined,
          senderTimestampSec: issueTimestamp,
          expired: false,
          source: 'outgoing_issue',
          updatedAtIso: new Date().toISOString(),
        }
      );
    })();

    this.inFlightTokenRefreshes.set(storageJid, refreshPromise);
    try {
      const record = await refreshPromise;
      return { record, refreshed: true };
    } finally {
      this.inFlightTokenRefreshes.delete(storageJid);
    }
  }

  /**
   * Builds outgoing `<tctoken>` stanza nodes via `@hiroosy/baileys-lite`'s `buildTcTokenFromJid`.
   */
  public async injectPrivacyTokenNodes(
    targetJid: string,
    baseContent: BinaryNode[] = []
  ): Promise<{ nodes: BinaryNode[] | undefined; injected: boolean }> {
    const sock = this.getSocket();
    if (!sock?.authState) {
      return {
        nodes: baseContent.length > 0 ? baseContent : undefined,
        injected: false,
      };
    }
    const startLen = baseContent.length;
    const nodes = await buildTcTokenFromJid({
      authState: sock.authState,
      jid: jidNormalizedUser(targetJid),
      baseContent: [...baseContent],
      getLIDForPN: this.getGetLIDForPN(sock),
    });
    const injected = Boolean(nodes && nodes.length > startLen);
    if (injected) {
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'TC_TOKEN_INJECTED',
        targetJid,
        metadata: { injected: true },
      });
    }
    return { nodes, injected };
  }

  public classifyReachoutError(
    err: unknown,
    targetJid: string,
    retried = false,
    recovered = false
  ): ReachoutDiagnostic {
    const rawMsg =
      err instanceof Error ? err.message : typeof err === 'string' ? err : String(err || '');
    const lower = rawMsg.toLowerCase();
    const anyErr =
      err && typeof err === 'object'
        ? (err as {
            code?: number | string;
            data?: { code?: number | string; attrs?: { error?: string } };
            output?: { statusCode?: number };
          })
        : undefined;
    const code =
      anyErr?.code ??
      anyErr?.data?.attrs?.error ??
      anyErr?.data?.code ??
      anyErr?.output?.statusCode;

    const is463 =
      String(code) === String(NACK_REASONS.SenderReachoutTimelocked) ||
      String(code) === SERVER_ERROR_CODES.MessageAccountRestriction ||
      lower.includes('463');

    const timelockActive = Boolean(this.reachoutTimeLock.isActive);
    const endsIso = this.reachoutTimeLock.timeEnforcementEnds?.toISOString();

    if (
      timelockActive ||
      lower.includes('timelock') ||
      lower.includes('nackcallerreachouttimelocked') ||
      lower.includes('account has been restricted')
    ) {
      return {
        code: code ?? 463,
        reason: 'REACHOUT_TIMELOCK',
        targetJid,
        timelockActive: true,
        timelockEndsAtIso: endsIso,
        enforcementType: this.reachoutTimeLock.enforcementType,
        retried,
        recovered,
        detailArabic:
          `الحساب مقيد مؤقتاً بمهلة تواصل (Reachout Timelock / 463)` +
          (endsIso ? ` حتى ${endsIso}` : '') +
          `.`,
        detailTechnical: rawMsg,
      };
    }

    if (lower.includes('missingtctoken') || lower.includes('missing tctoken')) {
      return {
        code: code ?? 463,
        reason: 'MISSING_TC_TOKEN',
        targetJid,
        timelockActive: false,
        retried,
        recovered,
        detailArabic:
          'رفض الخادم الإرسال لغياب رمز الثقة Trusted Contact Token (MissingTcToken).',
        detailTechnical: rawMsg,
      };
    }

    if (lower.includes('expired')) {
      return {
        code: code ?? 463,
        reason: 'TOKEN_EXPIRED',
        targetJid,
        timelockActive: false,
        retried,
        recovered,
        detailArabic: 'انتهت صلاحية رمز الثقة TC-Token للمستلم وتجديده مطلوب.',
        detailTechnical: rawMsg,
      };
    }

    if (is463) {
      return {
        code: 463,
        reason: 'TOKEN_UNAVAILABLE',
        targetJid,
        timelockActive: false,
        retried,
        recovered,
        detailArabic:
          'رفض الخادم الرسالة برمز الخطأ 463 (قيود التواصل أو نقص رمز TC-Token).',
        detailTechnical: rawMsg,
      };
    }

    return {
      code,
      reason: 'MESSAGE_REJECTED',
      targetJid,
      timelockActive,
      timelockEndsAtIso: endsIso,
      enforcementType: this.reachoutTimeLock.enforcementType,
      retried,
      recovered,
      detailArabic: `تم رفض الرسالة من الخادم: ${rawMsg.slice(0, 120)}`,
      detailTechnical: rawMsg,
    };
  }

  /**
   * Executes an outgoing 1:1 send with bounded Error 463 / MissingTcToken recovery:
   * - Never retries when `reachoutTimeLock.isActive` is true.
   * - On a 463 / MissingTcToken / expired-token error, performs AT MOST ONE token refresh
   *   via `issuePrivacyTokens` and retries once cleanly.
   */
  public async executeWithBounded463Recovery<T>(
    targetJid: string,
    sendFn: () => Promise<T>
  ): Promise<{ result: T; diagnostic?: ReachoutDiagnostic }> {
    if (this.reachoutTimeLock.isActive) {
      const diag = this.classifyReachoutError(
        new Error('463 ReachoutTimelock active'),
        targetJid,
        false,
        false
      );
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'MESSAGE_463',
        targetJid,
        outcome: 'ERROR',
        metadata: { reason: diag.reason, timelockActive: true },
      });
      throw Object.assign(new WhatsAppConnectionError(diag.detailArabic), {
        reachoutDiagnostic: diag,
      });
    }

    try {
      const result = await sendFn();
      return { result };
    } catch (firstErr) {
      const initialDiag = this.classifyReachoutError(firstErr, targetJid, false, false);
      const isRecoverableTokenError =
        initialDiag.code === 463 ||
        initialDiag.reason === 'MISSING_TC_TOKEN' ||
        initialDiag.reason === 'TOKEN_EXPIRED' ||
        initialDiag.reason === 'TOKEN_UNAVAILABLE';

      if (!isRecoverableTokenError) {
        throw firstErr;
      }

      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'MESSAGE_463',
        targetJid,
        outcome: 'ERROR',
        metadata: { reason: initialDiag.reason, willRetry: true },
      });

      const sock = this.getSocket();
      // Check live reachout timelock state before attempting token refresh retry
      if (typeof sock?.fetchAccountReachoutTimelock === 'function') {
        try {
          const lockInfo = await sock.fetchAccountReachoutTimelock();
          if (lockInfo?.isActive) {
            this.handleReachoutTimelockUpdate(lockInfo);
            const lockedDiag = this.classifyReachoutError(
              new Error('463 ReachoutTimelock active'),
              targetJid,
              false,
              false
            );
            throw Object.assign(new WhatsAppConnectionError(lockedDiag.detailArabic), {
              reachoutDiagnostic: lockedDiag,
            });
          }
        } catch (lockCheckErr) {
          if (
            lockCheckErr instanceof WhatsAppConnectionError &&
            (lockCheckErr as { reachoutDiagnostic?: ReachoutDiagnostic }).reachoutDiagnostic
              ?.timelockActive
          ) {
            throw lockCheckErr;
          }
        }
      }

      // Bounded 1-time recovery: refresh TC token and retry once
      await this.ensurePrivacyToken(targetJid, { forceRefresh: true }).catch(
        () => undefined
      );

      try {
        const retriedResult = await sendFn();
        return {
          result: retriedResult,
          diagnostic: {
            ...initialDiag,
            retried: true,
            recovered: true,
            detailArabic: 'تمت استعادة الإرسال بعد تحديث رمز TC-Token بنجاح (463 Recovery).',
          },
        };
      } catch (secondErr) {
        const finalDiag = this.classifyReachoutError(secondErr, targetJid, true, false);
        throw Object.assign(
          new WhatsAppConnectionError(
            `${finalDiag.detailArabic} (فشلت محاولة الاستعادة المحدودة)`
          ),
          { reachoutDiagnostic: finalDiag }
        );
      }
    }
  }
}

// ============================================================================
// Unified Session Identity, LID, & Username Service
// ============================================================================

export class WhatsAppIdentityService {
  private readonly sessionId: string;
  private readonly getSocket: () => WASocket | null;
  private readonly memoryStore: SessionMemoryStoreLike;
  private readonly groupMetadataCache: Map<string, { participants?: Array<{ id?: string; lid?: string; phoneNumber?: string }> }>;
  public readonly privacyTokens: PrivacyTokenManager;
  private readonly inFlightLookups = new Map<string, Promise<LidResolutionResult | null>>();

  constructor(params: {
    sessionId: string;
    getSocket: () => WASocket | null;
    memoryStore: SessionMemoryStoreLike;
    groupMetadataCache?: Map<string, { participants?: Array<{ id?: string; lid?: string; phoneNumber?: string }> }>;
  }) {
    this.sessionId = params.sessionId;
    this.getSocket = params.getSocket;
    this.memoryStore = params.memoryStore;
    this.groupMetadataCache = params.groupMetadataCache ?? new Map();
    this.privacyTokens = new PrivacyTokenManager({
      sessionId: this.sessionId,
      getSocket: this.getSocket,
      memoryStore: this.memoryStore,
    });
  }

  private ensureConnectedSocket(): WASocket {
    const sock = this.getSocket();
    if (!sock) {
      throw new WhatsAppConnectionError('جلسة واتساب غير متصلة حالياً.');
    }
    return sock;
  }

  /**
   * Atomically persists a validated PN <-> LID mapping into `signalRepository.lidMapping`
   * and `SessionMemoryStore`.
   */
  public async ensureLidMapping(
    pnInput: string,
    lidInput: string
  ): Promise<{ pnJid: string; lidJid: string } | null> {
    const pnJid = extractCleanPn(pnInput);
    const lidJid = extractCleanLid(lidInput);
    if (!pnJid || !lidJid || pnJid === lidJid) {
      return null;
    }

    this.memoryStore.recordLidMapping(lidJid, pnJid);

    const sock = this.getSocket();
    try {
      if (sock?.signalRepository?.lidMapping?.storeLIDPNMappings) {
        await sock.signalRepository.lidMapping.storeLIDPNMappings([
          { lid: lidJid, pn: pnJid },
        ]);
      }
    } catch (err) {
      log.warn('Failed storing LID-PN mapping in signalRepository', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { pnJid, lidJid };
  }

  /**
   * Resolves a Phone Number (`+967...` or `...@s.whatsapp.net`) to its `@lid` JID
   * with concurrent request deduplication per session + target.
   */
  public async resolvePnToLid(
    pnInput: string
  ): Promise<LidResolutionResult | null> {
    const sock = this.ensureConnectedSocket();
    const cleaned = String(pnInput || '').trim();
    if (!cleaned) return null;

    if (cleaned.endsWith('@lid')) {
      return this.resolveLidToPn(cleaned);
    }

    const validated = validateRecipient(cleaned);
    const pnJid = extractCleanPn(validated.jid);
    if (!pnJid) return null;
    const phoneDigits = pnJid.split('@')[0];

    const dedupeKey = `pn2lid:${pnJid}`;
    const existingInFlight = this.inFlightLookups.get(dedupeKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    const run = (async (): Promise<LidResolutionResult | null> => {
      const startedAt = Date.now();
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'LID_RESOLUTION_STARTED',
        targetJid: pnJid,
      });

      try {
        // 1. Check Signal repository lidMapping
        if (sock.signalRepository?.lidMapping?.getLIDForPN) {
          const mapped = await sock.signalRepository.lidMapping
            .getLIDForPN(pnJid)
            .catch(() => undefined);
          const cleanLid = extractCleanLid(mapped);
          if (cleanLid) {
            emitIdentityTelemetry({
              sessionId: this.sessionId,
              event: 'LID_RESOLUTION_SUCCESS',
              targetJid: cleanLid,
              durationMs: Date.now() - startedAt,
              metadata: { source: 'mapping' },
            });
            return {
              pnJid,
              lidJid: cleanLid,
              phoneNumber: `+${phoneDigits}`,
              source: 'mapping',
            };
          }
        }

        // 2. Check SessionMemoryStore cache
        const cachedLid = extractCleanLid(this.memoryStore.getLidForPn(pnJid));
        if (cachedLid) {
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'LID_RESOLUTION_SUCCESS',
            targetJid: cachedLid,
            durationMs: Date.now() - startedAt,
            metadata: { source: 'cache' },
          });
          return {
            pnJid,
            lidJid: cachedLid,
            phoneNumber: `+${phoneDigits}`,
            source: 'cache',
          };
        }

        // 3. Check Group Metadata cache
        for (const meta of this.groupMetadataCache.values()) {
          for (const p of meta.participants || []) {
            const pId = p.id ? jidNormalizedUser(p.id) : '';
            const pPn = p.phoneNumber ? jidNormalizedUser(p.phoneNumber) : '';
            const pLid = extractCleanLid(p.lid || (pId.endsWith('@lid') ? pId : undefined));
            const matches =
              (pId && areJidsSameUser(pId, pnJid)) ||
              (pPn && areJidsSameUser(pPn, pnJid));
            if (matches && pLid) {
              await this.ensureLidMapping(pnJid, pLid);
              emitIdentityTelemetry({
                sessionId: this.sessionId,
                event: 'LID_RESOLUTION_SUCCESS',
                targetJid: pLid,
                durationMs: Date.now() - startedAt,
                metadata: { source: 'cache' },
              });
              return {
                pnJid,
                lidJid: pLid,
                phoneNumber: `+${phoneDigits}`,
                source: 'cache',
              };
            }
          }
        }

        // 4. Native USync Query (Contact + LID + Username)
        let resolvedLid: string | undefined;
        let resolvedUsername: string | undefined;

        if (typeof sock.executeUSyncQuery === 'function' && typeof USyncQuery === 'function') {
          try {
            const uQuery = new USyncQuery()
              .withContext('interactive')
              .withMode('query')
              .withContactProtocol()
              .withLIDProtocol();
            if (typeof uQuery.withUsernameProtocol === 'function') {
              uQuery.withUsernameProtocol();
            }
            const uUser = new USyncUser().withPhone(`+${phoneDigits}`).withId(pnJid);
            uQuery.withUser(uUser);
            const res = await sock.executeUSyncQuery(uQuery);
            const item = res?.list?.[0];
            if (item) {
              resolvedLid = extractCleanLid(item.lid || item.id);
              if (typeof item.username === 'string' && item.username) {
                resolvedUsername = normalizeUsername(item.username);
              }
            }
          } catch {
            // Fall through to onWhatsApp / direct IQ
          }
        }

        if (!resolvedLid && typeof sock.onWhatsApp === 'function') {
          try {
            const waRes = await sock.onWhatsApp(`+${phoneDigits}`);
            const first = Array.isArray(waRes) ? waRes[0] : undefined;
            if (first?.exists) {
              resolvedLid = extractCleanLid(first.lid || first.jid);
            }
          } catch {
            // Fall through to direct IQ
          }
        }

        if (!resolvedLid && typeof sock.query === 'function') {
          try {
            const iqRes = await sock.query(
              {
                tag: 'iq',
                attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
                content: [
                  {
                    tag: 'usync',
                    attrs: {
                      sid: `lid_pn_${Date.now()}`,
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
                          { tag: 'username', attrs: {} },
                        ],
                      },
                      {
                        tag: 'list',
                        attrs: {},
                        content: [
                          {
                            tag: 'user',
                            attrs: { jid: pnJid },
                            content: [{ tag: 'contact', attrs: {}, content: `+${phoneDigits}` }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              10_000
            );
            resolvedLid = extractLidAttrFromBinaryNode(iqRes);
            resolvedUsername =
              resolvedUsername || extractUsernameAttrFromBinaryNode(iqRes);
          } catch {
            // Unavailable
          }
        }

        if (resolvedLid) {
          await this.ensureLidMapping(pnJid, resolvedLid);
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'LID_RESOLUTION_SUCCESS',
            targetJid: resolvedLid,
            durationMs: Date.now() - startedAt,
            metadata: { source: 'usync' },
          });
          return {
            pnJid,
            lidJid: resolvedLid,
            phoneNumber: `+${phoneDigits}`,
            username: resolvedUsername,
            source: 'usync',
          };
        }

        emitIdentityTelemetry({
          sessionId: this.sessionId,
          event: 'LID_RESOLUTION_FAILED',
          targetJid: pnJid,
          outcome: 'ERROR',
          durationMs: Date.now() - startedAt,
          metadata: { reason: 'LID_NOT_FOUND' },
        });
        return null;
      } finally {
        this.inFlightLookups.delete(dedupeKey);
      }
    })();

    this.inFlightLookups.set(dedupeKey, run);
    return run;
  }

  /**
   * Resolves an `@lid` JID back to its PN JID when permitted by Signal mapping / memory store / USync.
   */
  public async resolveLidToPn(
    lidInput: string
  ): Promise<LidResolutionResult | null> {
    const sock = this.ensureConnectedSocket();
    const lidJid = extractCleanLid(lidInput);
    if (!lidJid) return null;

    const dedupeKey = `lid2pn:${lidJid}`;
    const existingInFlight = this.inFlightLookups.get(dedupeKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    const run = (async (): Promise<LidResolutionResult | null> => {
      const startedAt = Date.now();
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'LID_RESOLUTION_STARTED',
        targetJid: lidJid,
      });

      try {
        // 1. Signal repository lidMapping
        if (sock.signalRepository?.lidMapping?.getPNForLID) {
          const mappedPn = await sock.signalRepository.lidMapping
            .getPNForLID(lidJid)
            .catch(() => undefined);
          const cleanPn = extractCleanPn(mappedPn);
          if (cleanPn) {
            emitIdentityTelemetry({
              sessionId: this.sessionId,
              event: 'LID_RESOLUTION_SUCCESS',
              targetJid: lidJid,
              durationMs: Date.now() - startedAt,
              metadata: { source: 'mapping' },
            });
            return {
              pnJid: cleanPn,
              lidJid,
              phoneNumber: `+${cleanPn.split('@')[0]}`,
              source: 'mapping',
            };
          }
        }

        // 2. SessionMemoryStore cache
        const cachedPn = extractCleanPn(this.memoryStore.getPnForLid(lidJid));
        if (cachedPn) {
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'LID_RESOLUTION_SUCCESS',
            targetJid: lidJid,
            durationMs: Date.now() - startedAt,
            metadata: { source: 'cache' },
          });
          return {
            pnJid: cachedPn,
            lidJid,
            phoneNumber: `+${cachedPn.split('@')[0]}`,
            source: 'cache',
          };
        }

        // 3. Group Metadata cache
        for (const meta of this.groupMetadataCache.values()) {
          for (const p of meta.participants || []) {
            const pLid = extractCleanLid(
              p.lid || (p.id?.endsWith('@lid') ? p.id : undefined)
            );
            const pPn = extractCleanPn(
              p.phoneNumber || (p.id?.endsWith('@s.whatsapp.net') ? p.id : undefined)
            );
            if (pLid && areJidsSameUser(pLid, lidJid) && pPn) {
              await this.ensureLidMapping(pPn, lidJid);
              emitIdentityTelemetry({
                sessionId: this.sessionId,
                event: 'LID_RESOLUTION_SUCCESS',
                targetJid: lidJid,
                durationMs: Date.now() - startedAt,
                metadata: { source: 'cache' },
              });
              return {
                pnJid: pPn,
                lidJid,
                phoneNumber: `+${pPn.split('@')[0]}`,
                source: 'cache',
              };
            }
          }
        }

        // 4. Native USync query with LID
        let resolvedPn: string | undefined;
        let resolvedUsername: string | undefined;

        if (typeof sock.executeUSyncQuery === 'function' && typeof USyncQuery === 'function') {
          try {
            const uQuery = new USyncQuery()
              .withContext('interactive')
              .withMode('query')
              .withContactProtocol()
              .withLIDProtocol();
            if (typeof uQuery.withUsernameProtocol === 'function') {
              uQuery.withUsernameProtocol();
            }
            const uUser = new USyncUser().withId(lidJid);
            if (typeof uUser.withLid === 'function') {
              uUser.withLid(lidJid);
            }
            uQuery.withUser(uUser);
            const res = await sock.executeUSyncQuery(uQuery);
            const item = res?.list?.[0];
            if (item) {
              resolvedPn = extractCleanPn(item.id);
              if (typeof item.username === 'string' && item.username) {
                resolvedUsername = normalizeUsername(item.username);
              }
            }
          } catch {
            // Fall through to IQ
          }
        }

        if (!resolvedPn && typeof sock.query === 'function') {
          try {
            const iqRes = await sock.query(
              {
                tag: 'iq',
                attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'usync' },
                content: [
                  {
                    tag: 'usync',
                    attrs: {
                      sid: `lid_rev_${Date.now()}`,
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
                          { tag: 'username', attrs: {} },
                        ],
                      },
                      {
                        tag: 'list',
                        attrs: {},
                        content: [{ tag: 'user', attrs: { jid: lidJid } }],
                      },
                    ],
                  },
                ],
              },
              10_000
            );
            resolvedPn = extractPnAttrFromBinaryNode(iqRes);
            resolvedUsername =
              resolvedUsername || extractUsernameAttrFromBinaryNode(iqRes);
          } catch {
            // Unavailable
          }
        }

        if (resolvedPn) {
          await this.ensureLidMapping(resolvedPn, lidJid);
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'LID_RESOLUTION_SUCCESS',
            targetJid: lidJid,
            durationMs: Date.now() - startedAt,
            metadata: { source: 'usync' },
          });
          return {
            pnJid: resolvedPn,
            lidJid,
            phoneNumber: `+${resolvedPn.split('@')[0]}`,
            username: resolvedUsername,
            source: 'usync',
          };
        }

        // Direct LID identity without exposing PN (expected under LID privacy)
        emitIdentityTelemetry({
          sessionId: this.sessionId,
          event: 'LID_RESOLUTION_SUCCESS',
          targetJid: lidJid,
          durationMs: Date.now() - startedAt,
          metadata: { source: 'direct' },
        });
        return {
          lidJid,
          username: resolvedUsername,
          source: 'direct',
        };
      } finally {
        this.inFlightLookups.delete(dedupeKey);
      }
    })();

    this.inFlightLookups.set(dedupeKey, run);
    return run;
  }

  /**
   * Unified identity resolver accepting phone number, PN JID, LID JID, or `@username`.
   */
  public async resolveIdentity(
    targetInput: string,
    options?: { usernameKey?: string }
  ): Promise<LidResolutionResult | null> {
    const sock = this.ensureConnectedSocket();
    const raw = String(targetInput || '').trim();
    if (!raw) return null;

    if (raw.endsWith('@lid')) {
      return this.resolveLidToPn(raw);
    }

    // Username input (@handle or handle containing letters)
    if (raw.startsWith('@') || (!raw.includes('@') && /[a-zA-Z]/.test(raw))) {
      const handle = normalizeUsername(raw);
      if (!isValidUsername(handle)) {
        return null;
      }
      if (typeof sock.resolveUsername === 'function') {
        const res = await sock
          .resolveUsername(handle, options?.usernameKey)
          .catch(() => ({ status: 'not-found' as const }));
        if (res.status === 'ok' && res.jid) {
          if (isLidUser(res.jid)) {
            const lidRes = await this.resolveLidToPn(res.jid);
            return lidRes
              ? { ...lidRes, username: handle }
              : { lidJid: res.jid, username: handle, source: 'usync' };
          }
          const pnRes = await this.resolvePnToLid(res.jid);
          return pnRes
            ? { ...pnRes, username: handle }
            : {
                pnJid: jidNormalizedUser(res.jid),
                username: handle,
                source: 'usync',
              };
        }
      }
      return null;
    }

    return this.resolvePnToLid(raw);
  }

  /**
   * Sends a message strictly respecting LID addressing (`addressingMode: 'lid'`),
   * ensuring LID mapping + Signal session migration/assertion + optional TC-token assurance
   * + bounded Error 463 recovery. Preserves full sender identity metadata for Signal.
   */
  public async sendLidAddressedMessage(
    params: SendLidAddressedParams
  ): Promise<SendLidAddressedResult> {
    const sock = this.ensureConnectedSocket();
    const identity = await this.resolveIdentity(params.target);

    const preferLid = params.preferLid !== false;
    const deliveryJid =
      preferLid && identity?.lidJid
        ? identity.lidJid
        : identity?.pnJid || identity?.lidJid;

    if (!deliveryJid) {
      throw new WhatsAppConnectionError(
        `تعذر تحديد هوية المستلم (${params.target}) عبر PN أو LID.`
      );
    }

    const usingLid = deliveryJid.endsWith('@lid');
    if (identity?.pnJid && identity?.lidJid) {
      await this.ensureLidMapping(identity.pnJid, identity.lidJid);
    }

    // Prepare Signal E2E session onto the target LID JID
    try {
      const devicesTarget = Array.from(
        new Set(
          [identity?.pnJid, identity?.lidJid, deliveryJid].filter((j): j is string =>
            Boolean(j)
          )
        )
      );
      if (devicesTarget.length > 0 && typeof sock.getUSyncDevices === 'function') {
        await sock.getUSyncDevices(devicesTarget, false, false).catch(() => []);
      }
      if (
        usingLid &&
        identity?.pnJid &&
        typeof sock.signalRepository?.migrateSession === 'function'
      ) {
        await sock.signalRepository
          .migrateSession(identity.pnJid, deliveryJid)
          .catch(() => undefined);
      }
      if (typeof sock.assertSessions === 'function') {
        await sock.assertSessions([deliveryJid], false).catch(() => false);
      }
    } catch {
      // Best-effort session setup
    }

    let tcTokenAttached = false;
    if (params.ensurePrivacyToken !== false) {
      const tokenCheck = await this.privacyTokens
        .getValidPrivacyToken(deliveryJid)
        .catch(() => null);
      tcTokenAttached = Boolean(tokenCheck?.hasToken && !tokenCheck.expired);
    }

    const msgContent: AnyMessageContent =
      typeof params.content === 'string' ? { text: params.content } : params.content;

    const sendOptions: Record<string, unknown> = {};
    if (usingLid) {
      sendOptions.addressingMode = 'lid';
      sendOptions.additionalAttributes = { addressing_mode: 'lid' };
    }
    if (params.quoted) {
      sendOptions.quoted = params.quoted;
    }

    const prevName = sock.user?.name;
    if (sock.user && params.customPushName !== undefined) {
      sock.user.name = params.customPushName;
    }

    try {
      const { result, diagnostic } =
        await this.privacyTokens.executeWithBounded463Recovery(deliveryJid, async () => {
          if (typeof sock.sendMessage === 'function') {
            const sent = await sock.sendMessage(deliveryJid, msgContent, sendOptions);
            return sent?.key?.id || `lid_${Date.now()}`;
          }
          const selfLid = sock.user?.lid || sock.authState?.creds?.me?.lid;
          const selfId = sock.user?.id || sock.authState?.creds?.me?.id;
          const userJid = usingLid && selfLid ? jidNormalizedUser(selfLid) : selfId;
          const waMsg = generateWAMessageFromContent(
            deliveryJid,
            typeof params.content === 'string'
              ? { extendedTextMessage: { text: params.content } }
              : (params.content as Record<string, unknown>),
            { userJid }
          );
          const id = waMsg.key?.id || `lid_${Date.now()}`;
          await sock.relayMessage(deliveryJid, waMsg.message, {
            messageId: id,
            ...sendOptions,
          });
          return id;
        });

      return {
        messageId: result,
        targetJid: deliveryJid,
        pnJid: identity?.pnJid,
        lidJid: identity?.lidJid,
        addressingMode: usingLid ? 'lid' : 'pn',
        resolutionSource: identity?.source || 'direct',
        tcTokenAttached,
        diagnostic,
      };
    } finally {
      if (sock.user && params.customPushName !== undefined) {
        sock.user.name = prevName;
      }
    }
  }

  // ============================================================================
  // Feature B: WhatsApp Username Management
  // ============================================================================

  public async checkUsername(
    rawUsername: string,
    usernameKey?: string
  ): Promise<WhatsAppUsernameState> {
    const sock = this.ensureConnectedSocket();
    const username = normalizeUsername(rawUsername);
    if (!isValidUsername(username)) {
      throw new ValidationError(
        'اسم المستخدم غير صالح: يجب أن يكون بين 4 و 30 حرفاً، يبدأ بحرف إنجليزي ويحتوي على أحرف أو أرقام أو . أو _ فقط.'
      );
    }
    if (usernameKey !== undefined && usernameKey !== '' && !isValidUsernameKey(usernameKey)) {
      throw new ValidationError(
        'رمز PIN الخاص باسم المستخدم يجب أن يتكون من 4 أرقام بالضبط.'
      );
    }

    const startMs = Date.now();
    try {
      // 1. Primary native method exposed by @hiroosy/baileys-lite
      if (typeof sock.resolveUsername === 'function') {
        const res = await sock.resolveUsername(
          username,
          usernameKey || undefined
        );
        if (res.status === 'not-found') {
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'USERNAME_CHECK',
            durationMs: Date.now() - startMs,
            metadata: { username, status: 'available' },
          });
          return {
            username,
            available: true,
            supported: true,
            status: 'available',
            reasonArabic: `اسم المستخدم (@${username}) متاح للاستخدام.`,
            source: 'socket_iq',
          };
        }
        if (res.status === 'key-required') {
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'USERNAME_CHECK',
            durationMs: Date.now() - startMs,
            metadata: { username, status: 'key-required' },
          });
          return {
            username,
            available: false,
            supported: true,
            status: 'key-required',
            reasonArabic: `اسم المستخدم (@${username}) محجوز ويتطلب رمز PIN لإظهار هويته.`,
            source: 'socket_iq',
          };
        }
        if (res.status === 'ok') {
          const jid = res.jid;
          const lidJid = isLidUser(jid)
            ? jid
            : (await this.resolvePnToLid(jid).catch(() => null))?.lidJid;
          emitIdentityTelemetry({
            sessionId: this.sessionId,
            event: 'USERNAME_CHECK',
            targetJid: jid,
            durationMs: Date.now() - startMs,
            metadata: { username, status: 'taken' },
          });
          return {
            username,
            available: false,
            jid,
            lidJid,
            supported: true,
            status: 'taken',
            reasonArabic: `اسم المستخدم (@${username}) مستخدم بالفعل (${jid}).`,
            source: 'socket_iq',
          };
        }
      }

      // 2. Fallback via USyncQuery + withUsernameProtocol()
      if (typeof sock.executeUSyncQuery === 'function' && typeof USyncQuery === 'function') {
        const uUser = new USyncUser().withUsername(username);
        if (usernameKey) uUser.withUsernameKey(usernameKey);
        const uQuery = new USyncQuery()
          .withContext('interactive')
          .withMode('query')
          .withContactProtocol()
          .withLIDProtocol();
        if (typeof uQuery.withUsernameProtocol === 'function') {
          uQuery.withUsernameProtocol();
        }
        uQuery.withUser(uUser);
        const usyncRes = await sock.executeUSyncQuery(uQuery);
        const first = usyncRes?.list?.[0];
        if (!first || !first.contact) {
          return {
            username,
            available: true,
            supported: true,
            status: 'available',
            reasonArabic: `اسم المستخدم (@${username}) متاح للاستخدام.`,
            source: 'usync',
          };
        }
        const lidJid = extractCleanLid(first.lid || first.id);
        return {
          username,
          available: false,
          jid: first.id,
          lidJid,
          supported: true,
          status: 'taken',
          reasonArabic: `اسم المستخدم (@${username}) مسجل بالفعل.`,
          source: 'usync',
        };
      }

      return {
        username,
        supported: false,
        status: 'unsupported',
        reasonArabic: 'ميزة فحص اسم المستخدم غير مدعومة على هذا الاتصال حالياً.',
        source: 'socket_iq',
      };
    } catch (err) {
      if (isUnsupportedIqError(err)) {
        emitIdentityTelemetry({
          sessionId: this.sessionId,
          event: 'USERNAME_CHECK',
          outcome: 'ERROR',
          durationMs: Date.now() - startMs,
          metadata: { username, status: 'unsupported' },
        });
        return {
          username,
          supported: false,
          status: 'unsupported',
          reasonArabic:
            'خادم واتساب لا يدعم استعلام اسم المستخدم لهذا الحساب حالياً (Feature Unsupported).',
          source: 'socket_iq',
        };
      }
      throw err;
    }
  }

  public async setUsername(rawUsername: string): Promise<WhatsAppUsernameState> {
    const sock = this.ensureConnectedSocket();
    const username = normalizeUsername(rawUsername);
    if (!isValidUsername(username)) {
      throw new ValidationError(
        'اسم المستخدم غير صالح: يجب أن يكون بين 4 و 30 حرفاً، يبدأ بحرف إنجليزي ويحتوي على أحرف أو أرقام أو . أو _ فقط.'
      );
    }

    const startMs = Date.now();
    if (typeof sock.query !== 'function') {
      return {
        username,
        supported: false,
        status: 'unsupported',
        reasonArabic: 'المقبس الحالي لا يدعم إرسال أوامر IQ لتعيين اسم المستخدم.',
        source: 'socket_iq',
      };
    }

    try {
      await sock.query(
        {
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'set',
            xmlns: 'w:profile:username',
          },
          content: [
            {
              tag: 'username',
              attrs: { action: 'set' },
              content: username,
            },
          ],
        },
        12_000
      );

      this.privacyTokens.setSelfUsernameCache(username);
      if (sock.user) {
        sock.user.username = username;
      }

      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'USERNAME_SET',
        durationMs: Date.now() - startMs,
        metadata: { username },
      });

      return {
        username,
        available: false,
        jid: sock.user?.id,
        lidJid: sock.user?.lid,
        supported: true,
        status: 'ok',
        reasonArabic: `تم تعيين اسم المستخدم (@${username}) لهذا الحساب بنجاح.`,
        source: 'socket_iq',
      };
    } catch (err) {
      if (isUnsupportedIqError(err)) {
        emitIdentityTelemetry({
          sessionId: this.sessionId,
          event: 'USERNAME_SET',
          outcome: 'ERROR',
          durationMs: Date.now() - startMs,
          metadata: { username, status: 'unsupported' },
        });
        return {
          username,
          supported: false,
          status: 'unsupported',
          reasonArabic:
            'تعيين اسم المستخدم غير مفعّل من خادم واتساب لهذا الحساب حالياً (Unsupported by server/account).',
          source: 'socket_iq',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        username,
        supported: true,
        status: 'error',
        reasonArabic: `تعذر تعيين اسم المستخدم (@${username}): ${msg}`,
        source: 'socket_iq',
      };
    }
  }

  public async deleteUsername(): Promise<WhatsAppUsernameState> {
    const sock = this.ensureConnectedSocket();
    const startMs = Date.now();
    if (typeof sock.query !== 'function') {
      return {
        supported: false,
        status: 'unsupported',
        reasonArabic: 'المقبس الحالي لا يدعم إرسال أوامر IQ لحذف اسم المستخدم.',
        source: 'socket_iq',
      };
    }

    try {
      await sock.query(
        {
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'set',
            xmlns: 'w:profile:username',
          },
          content: [
            {
              tag: 'username',
              attrs: { action: 'delete' },
            },
          ],
        },
        12_000
      );

      this.privacyTokens.setSelfUsernameCache(undefined);
      if (sock.user) {
        sock.user.username = undefined;
      }

      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'USERNAME_DELETE',
        durationMs: Date.now() - startMs,
        metadata: { deleted: true },
      });

      return {
        supported: true,
        status: 'ok',
        reasonArabic: 'تم حذف اسم المستخدم المرتبط بهذه الجلسة بنجاح.',
        source: 'socket_iq',
      };
    } catch (err) {
      if (isUnsupportedIqError(err)) {
        emitIdentityTelemetry({
          sessionId: this.sessionId,
          event: 'USERNAME_DELETE',
          outcome: 'ERROR',
          durationMs: Date.now() - startMs,
          metadata: { status: 'unsupported' },
        });
        return {
          supported: false,
          status: 'unsupported',
          reasonArabic:
            'حذف اسم المستخدم غير مفعّل من خادم واتساب لهذا الحساب حالياً (Unsupported by server/account).',
          source: 'socket_iq',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        supported: true,
        status: 'error',
        reasonArabic: `تعذر حذف اسم المستخدم: ${msg}`,
        source: 'socket_iq',
      };
    }
  }

  /**
   * Configures a 4-digit WhatsApp Username PIN (`usernameKey`).
   * Strictly validates format via `isValidUsernameKey` and NEVER logs the raw PIN.
   */
  public async setUsernamePin(rawPin: string): Promise<WhatsAppUsernameState> {
    const sock = this.ensureConnectedSocket();
    const pin = String(rawPin || '').trim();
    if (!isValidUsernameKey(pin)) {
      throw new ValidationError(
        'رمز PIN غير صالح: يجب إدخال 4 أرقام فقط (مثال: 1234).'
      );
    }

    const startMs = Date.now();
    if (typeof sock.query !== 'function') {
      return {
        supported: false,
        status: 'unsupported',
        reasonArabic: 'المقبس الحالي لا يدعم تعيين رمز PIN لاسم المستخدم.',
        source: 'socket_iq',
      };
    }

    try {
      await sock.query(
        {
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'set',
            xmlns: 'w:profile:username',
          },
          content: [
            {
              tag: 'username_key',
              attrs: { action: 'set', pin },
            },
          ],
        },
        12_000
      );

      // Explicitly omit pin from telemetry
      emitIdentityTelemetry({
        sessionId: this.sessionId,
        event: 'USERNAME_PIN_SET',
        durationMs: Date.now() - startMs,
        metadata: { configured: true },
      });

      return {
        username: this.privacyTokens.getSelfUsernameCache() || sock.user?.username,
        supported: true,
        status: 'ok',
        reasonArabic: 'تم تحديث رمز الحماية (PIN) لاسم المستخدم بنجاح (مُعمّى في السجلات).',
        source: 'socket_iq',
      };
    } catch (err) {
      if (isUnsupportedIqError(err)) {
        return {
          supported: false,
          status: 'unsupported',
          reasonArabic:
            'تعيين رمز PIN لاسم المستخدم غير مفعّل من خادم واتساب لهذا الحساب حالياً.',
          source: 'socket_iq',
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        supported: true,
        status: 'error',
        reasonArabic: `تعذر تعيين رمز PIN: ${msg}`,
        source: 'socket_iq',
      };
    }
  }

  public async recommendUsername(seedInput?: string): Promise<UsernameRecommendationResult> {
    const sock = this.ensureConnectedSocket();
    const rawSeed = normalizeUsername(
      seedInput ||
        sock.user?.name?.replace(/[^a-zA-Z0-9._]/g, '') ||
        'botezz_user'
    );
    const base = /^[a-zA-Z]/.test(rawSeed)
      ? rawSeed.replace(/[^a-zA-Z0-9._]/g, '').slice(0, 18)
      : `wa_${rawSeed.replace(/[^a-zA-Z0-9._]/g, '').slice(0, 15)}`;
    const safeBase = base.length >= 4 ? base : `${base}_node`;

    const suffixNum = Math.floor(100 + Math.random() * 899);
    const rawCandidates = [
      safeBase,
      `${safeBase}_${suffixNum}`,
      `${safeBase}.pro`,
      `${safeBase}_${new Date().getUTCFullYear().toString().slice(-2)}`,
    ]
      .map((c) => c.slice(0, 30))
      .filter((c) => isValidUsername(c));

    const checks = await Promise.all(
      rawCandidates.map(async (cand) => {
        const res = await this.checkUsername(cand).catch(() => ({
          available: false,
          supported: false,
          status: 'error' as const,
        }));
        return {
          username: cand,
          available: Boolean(res.available),
          status: res.status,
          supported: res.supported,
        };
      })
    );

    const anySupported = checks.some((c) => c.supported);
    return {
      seed: safeBase,
      supported: anySupported,
      candidates: checks.map(({ username, available, status }) => ({
        username,
        available,
        status,
      })),
    };
  }

  public async getSelfUsernameState(): Promise<WhatsAppUsernameState> {
    const sock = this.getSocket();
    if (!sock) {
      return {
        supported: false,
        status: 'unsupported',
        reasonArabic: 'الجلسة غير متصلة حالياً.',
        source: 'creds',
      };
    }
    const cached = this.privacyTokens.getSelfUsernameCache() || sock.user?.username;
    if (cached) {
      return {
        username: cached,
        jid: sock.user?.id,
        lidJid: sock.user?.lid,
        supported: true,
        status: 'ok',
        reasonArabic: `اسم المستخدم الحالي المسجل: @${cached}`,
        source: 'creds',
      };
    }

    const selfJid = sock.user?.id || sock.authState?.creds?.me?.id;
    if (selfJid && typeof sock.executeUSyncQuery === 'function') {
      try {
        const uQuery = new USyncQuery()
          .withContext('interactive')
          .withMode('query')
          .withLIDProtocol();
        if (typeof uQuery.withUsernameProtocol === 'function') {
          uQuery.withUsernameProtocol();
        }
        uQuery.withUser(new USyncUser().withId(jidNormalizedUser(selfJid)));
        const res = await sock.executeUSyncQuery(uQuery);
        const item = res?.list?.[0];
        const foundUsername =
          typeof item?.username === 'string' && item.username
            ? normalizeUsername(item.username)
            : undefined;
        if (foundUsername) {
          this.privacyTokens.setSelfUsernameCache(foundUsername);
          return {
            username: foundUsername,
            jid: sock.user?.id,
            lidJid: extractCleanLid(item?.lid) || sock.user?.lid,
            supported: true,
            status: 'ok',
            reasonArabic: `اسم المستخدم الحالي: @${foundUsername}`,
            source: 'usync',
          };
        }
      } catch {
        // Fall through
      }
    }

    return {
      username: undefined,
      jid: sock.user?.id,
      lidJid: sock.user?.lid,
      supported: true,
      status: 'not-found',
      reasonArabic: 'لا يوجد اسم مستخدم (@username) مضبوط لهذا الحساب حالياً.',
      source: 'creds',
    };
  }
}

export {
  extractCleanLid,
  extractCleanPn,
  extractLidAttrFromBinaryNode,
  extractPnAttrFromBinaryNode,
  extractUsernameAttrFromBinaryNode,
};
export type { InspectableBinaryNode };
