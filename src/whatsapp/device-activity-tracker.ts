import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  jidDecode,
  jidNormalizedUser,
  USyncQuery,
  USyncUser,
  type WASocket,
  type WAPresence,
  type BinaryNode,
} from './baileys-compat';
import { createLogger } from '../logging/logger';

const log = createLogger('device-activity-tracker');

export type DeviceActivityState = 'ACTIVE' | 'STANDBY' | 'OFFLINE';

export type RttAckCaptureLayer =
  | 'messages.update'
  | 'message-receipt.update'
  | 'CB:receipt'
  | 'ws.CB:receipt'
  | 'usync_probe'
  | 'simulated';

export interface ParsedTrackerJid {
  rawJid: string;
  bareJid: string;
  user: string;
  server: string;
  deviceId: number;
  formattedDeviceJid: string;
  isLid: boolean;
  isPn: boolean;
}

export interface RttProbeSample {
  probeSeq: number;
  probeMsgId: string;
  fakeTargetMsgId: string;
  targetJid: string;
  sentAtMs: number;
  ackedAtMs?: number;
  rttMs?: number;
  status: 'PENDING' | 'ACKED' | 'TIMEOUT';
  captureLayer?: RttAckCaptureLayer;
  respondingDeviceJid?: string;
  respondingDeviceId?: number;
  isBacklogFlush?: boolean;
  classifiedStateAfterProbe: DeviceActivityState;
  movingAvgRttMs?: number;
  medianRttMs?: number;
  thresholdMs?: number;
}

export interface RttTelemetryStats {
  lastRttMs?: number;
  movingAvgRttMs?: number;
  avgRttMs?: number;
  medianRttMs?: number;
  minRttMs?: number;
  maxRttMs?: number;
  jitterMs?: number;
  dynamicThresholdMs: number;
  sparkline: string;
  sampleCount: number;
}

export interface TargetIdentityResolution {
  pnJid: string;
  lidJid?: string;
  e164Phone: string;
  detectedDevices: string[];
  initialUsyncRttMs?: number;
}

export interface PresenceActivityTransition {
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

export interface PresenceWatchReport {
  watchId: string;
  sessionId?: string;
  chatJid: string;
  resolvedLid?: string;
  currentState: WAPresence;
  deviceActivityState: DeviceActivityState;
  lastSeenTimestampSec?: number;
  lastUpdatedMs: number;
  transitions: PresenceActivityTransition[];
  totalOnlineDurationMs: number;
  onlineSessionStartedAtMs?: number;
  probeRttMs?: number;
  lastRttMs?: number;
  movingAvgRttMs?: number;
  avgRttMs?: number;
  medianRttMs?: number;
  minRttMs?: number;
  maxRttMs?: number;
  jitterMs?: number;
  thresholdMs?: number;
  probesSent: number;
  probesAcked: number;
  probesTimedOut: number;
  consecutiveTimeouts: number;
  deliveryRatePct: number;
  sparkline: string;
  rttSamples: RttProbeSample[];
  activeDurationSeconds: number;
  standbyDurationSeconds: number;
  offlineDurationSeconds: number;
  detectedDevices: string[];
  respondingDevices: string[];
  linkedDevices?: string[];
  activeDevices?: string[];
  privacyLastSeenDenied?: boolean;
  elapsedSeconds: number;
  targetDurationSeconds: number;
  stoppedEarly: boolean;
  startedAtIso: string;
  endedAtIso?: string;
  lastActivitySource?:
    | 'presence'
    | 'chatstate'
    | 'message'
    | 'receipt'
    | 'usync_probe'
    | 'rtt_probe';
}

const SPARKLINE_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * Normalizes any WhatsApp JID (`967xxx:14@s.whatsapp.net`, `12345:2@lid`, `+966501234567`)
 * into `{ bareJid, user, server, deviceId, formattedDeviceJid, isLid, isPn }` so events from
 * companion devices (`:14`, `:2`, `:33`) and primary phones (`:0`) are accurately matched.
 */
export function parseTrackerJid(
  rawJid: string | null | undefined
): ParsedTrackerJid {
  const trimmed = String(rawJid || '').trim();
  if (!trimmed) {
    return {
      rawJid: '',
      bareJid: '',
      user: '',
      server: 's.whatsapp.net',
      deviceId: 0,
      formattedDeviceJid: '',
      isLid: false,
      isPn: true,
    };
  }

  if (!trimmed.includes('@')) {
    const digits = trimmed.replace(/\D/g, '');
    const bareJid = digits ? `${digits}@s.whatsapp.net` : trimmed;
    return {
      rawJid: trimmed,
      bareJid,
      user: digits,
      server: 's.whatsapp.net',
      deviceId: 0,
      formattedDeviceJid: digits ? `${digits}:0@s.whatsapp.net` : '',
      isLid: false,
      isPn: true,
    };
  }

  try {
    const decoded = jidDecode(trimmed);
    if (decoded && decoded.user && decoded.server) {
      const server =
        decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
      const user = String(decoded.user).split(':')[0] || '';
      const deviceId =
        typeof decoded.device === 'number' && Number.isFinite(decoded.device)
          ? decoded.device
          : 0;
      const bareJid = `${user}@${server}`;
      return {
        rawJid: trimmed,
        bareJid,
        user,
        server,
        deviceId,
        formattedDeviceJid: `${user}:${deviceId}@${server}`,
        isLid: server === 'lid',
        isPn: server === 's.whatsapp.net',
      };
    }
  } catch {
    // Fallback to regex parsing below
  }

  const [leftPart = '', rawServer = 's.whatsapp.net'] = trimmed.split('@');
  const server = rawServer === 'c.us' ? 's.whatsapp.net' : rawServer;
  const [userPart = '', devPart] = leftPart.split(':');
  const user = userPart.trim();
  const parsedDev = devPart !== undefined ? Number(devPart) : 0;
  const deviceId =
    Number.isFinite(parsedDev) && parsedDev >= 0 ? Math.floor(parsedDev) : 0;
  const bareJid = user ? `${user}@${server}` : trimmed;

  return {
    rawJid: trimmed,
    bareJid,
    user,
    server,
    deviceId,
    formattedDeviceJid: user ? `${user}:${deviceId}@${server}` : trimmed,
    isLid: server === 'lid',
    isPn: server === 's.whatsapp.net',
  };
}

/**
 * Checks whether a candidate JID from an event (`presence.update`, `messages.update`,
 * `message-receipt.update`, or `CB:receipt`) belongs to the tracked target's PN or LID identity.
 */
export function matchesTrackedTargetJid(
  candidateRawJid: string | null | undefined,
  targetPnBareJid?: string,
  targetLidBareJid?: string
): { matches: boolean; parsed: ParsedTrackerJid } {
  const parsed = parseTrackerJid(candidateRawJid);
  if (!parsed.bareJid) {
    return { matches: false, parsed };
  }
  const normPn = targetPnBareJid ? parseTrackerJid(targetPnBareJid).bareJid : '';
  const normLid = targetLidBareJid
    ? parseTrackerJid(targetLidBareJid).bareJid
    : '';

  const matches =
    (Boolean(normPn) && parsed.bareJid === normPn) ||
    (Boolean(normLid) && parsed.bareJid === normLid);
  return { matches, parsed };
}

/**
 * Renders an ASCII sparkline (`▁▂▃▄▅▆▇█`) for the last `maxBars` RTT values.
 */
export function renderRttSparkline(
  rttValues: number[],
  maxBars = 12
): string {
  const slice = rttValues
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice(-maxBars);
  if (slice.length === 0) {
    return '—';
  }
  const minVal = Math.min(...slice);
  const maxVal = Math.max(...slice);
  const span = maxVal - minVal;

  return slice
    .map((val) => {
      if (span <= 15) {
        // Uniform latency: pick bar height proportional to absolute latency tier
        if (val <= 200) return SPARKLINE_BLOCKS[1];
        if (val <= 400) return SPARKLINE_BLOCKS[2];
        if (val <= 700) return SPARKLINE_BLOCKS[4];
        if (val <= 1000) return SPARKLINE_BLOCKS[5];
        return SPARKLINE_BLOCKS[7];
      }
      const norm = (val - minVal) / span;
      const idx = Math.min(
        SPARKLINE_BLOCKS.length - 1,
        Math.max(0, Math.round(norm * (SPARKLINE_BLOCKS.length - 1)))
      );
      return SPARKLINE_BLOCKS[idx];
    })
    .join('');
}

/**
 * Computes rolling RTT statistics and adaptive threshold using the `gommzystudio/device-activity-tracker` math:
 * - Rolling window of up to 20 valid RTT samples
 * - `movingAvgRttMs`: moving average of the last 5 samples
 * - `medianRttMs`: median of the rolling window
 * - `dynamicThresholdMs`: `Math.min(Math.max(medianRttMs * 0.9, 350), 1200)` (with `800ms` bootstrap during the first <3 samples)
 * - `jitterMs`: standard deviation / mean delta of consecutive RTT changes
 */
export function computeRttTelemetryStats(
  rttHistoryInput: number[],
  maxWindowSize = 20
): RttTelemetryStats {
  const valid = rttHistoryInput
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .slice(-maxWindowSize);

  if (valid.length === 0) {
    return {
      dynamicThresholdMs: 800,
      sparkline: '—',
      sampleCount: 0,
    };
  }

  const lastRttMs = Math.round(valid[valid.length - 1]!);
  const recentFive = valid.slice(-5);
  const movingAvgRttMs = Math.round(
    recentFive.reduce((acc, v) => acc + v, 0) / recentFive.length
  );
  const avgRttMs = Math.round(
    valid.reduce((acc, v) => acc + v, 0) / valid.length
  );

  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianRttMs = Math.round(
    sorted.length % 2 !== 0
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2
  );

  const minRttMs = Math.round(sorted[0]!);
  const maxRttMs = Math.round(sorted[sorted.length - 1]!);

  let jitterMs = 0;
  if (valid.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < valid.length; i++) {
      deltas.push(Math.abs(valid[i]! - valid[i - 1]!));
    }
    const meanDelta = deltas.reduce((acc, d) => acc + d, 0) / deltas.length;
    const variance =
      deltas.reduce((acc, d) => acc + (d - meanDelta) ** 2, 0) / deltas.length;
    jitterMs = Math.round(Math.sqrt(variance) || meanDelta);
  }

  const dynamicThresholdMs =
    valid.length < 3
      ? 800
      : Math.round(Math.min(Math.max(medianRttMs * 0.9, 350), 1200));

  return {
    lastRttMs,
    movingAvgRttMs,
    avgRttMs,
    medianRttMs,
    minRttMs,
    maxRttMs,
    jitterMs,
    dynamicThresholdMs,
    sparkline: renderRttSparkline(valid, 12),
    sampleCount: valid.length,
  };
}

/**
 * Classifies the target device activity state (`ACTIVE`, `STANDBY`, or `OFFLINE`)
 * combining native `presence.update` / `chatstate` and RTT side-channel metrics.
 */
export function classifyDeviceActivityState(params: {
  presenceState?: WAPresence;
  movingAvgRttMs?: number;
  dynamicThresholdMs: number;
  consecutiveTimeouts: number;
  probesAcked: number;
  lastAckElapsedMs?: number;
}): DeviceActivityState {
  const {
    presenceState,
    movingAvgRttMs,
    dynamicThresholdMs,
    consecutiveTimeouts,
    probesAcked,
  } = params;

  // 1. Explicit active presence or chatstate from WhatsApp server
  if (
    presenceState === 'available' ||
    presenceState === 'composing' ||
    presenceState === 'recording'
  ) {
    return 'ACTIVE';
  }

  // 2. Consecutive probe timeouts without client DELIVERY_ACK -> OFFLINE
  if (consecutiveTimeouts >= 2) {
    return 'OFFLINE';
  }

  // 3. Valid client DELIVERY_ACK RTT classification
  if (probesAcked > 0 && typeof movingAvgRttMs === 'number') {
    if (movingAvgRttMs <= dynamicThresholdMs) {
      return 'ACTIVE';
    }
    return 'STANDBY';
  }

  if (presenceState === 'paused') {
    return 'ACTIVE';
  }

  return consecutiveTimeouts >= 1 ? 'OFFLINE' : 'STANDBY';
}

export interface ActivePresenceTrackerHandle {
  watchId: string;
  sessionId: string;
  adminId?: number;
  targetPnJid: string;
  targetLidJid?: string;
  startedAtMs: number;
  stopEarly: () => PresenceWatchReport;
  getLatestSnapshot: () => PresenceWatchReport;
  completionPromise: Promise<PresenceWatchReport>;
}

/**
 * Global & per-session registry of active `DeviceActivityTracker` instances.
 * Prevents duplicate overlapping trackers on the same `sessionId + targetPnJid`
 * and enables instant early termination via `presence:stop:<watchId>` in Telegram.
 */
export class ActivePresenceTrackerRegistry {
  private readonly byWatchId = new Map<string, ActivePresenceTrackerHandle>();
  private readonly bySessionTargetKey = new Map<
    string,
    ActivePresenceTrackerHandle
  >();

  private buildCompositeKey(sessionId: string, bareJid: string): string {
    return `${sessionId}::${parseTrackerJid(bareJid).bareJid}`;
  }

  public register(handle: ActivePresenceTrackerHandle): void {
    // Cleanly stop any prior overlapping tracker on the same sessionId + target
    const pnKey = this.buildCompositeKey(handle.sessionId, handle.targetPnJid);
    const existingPn = this.bySessionTargetKey.get(pnKey);
    if (existingPn && existingPn.watchId !== handle.watchId) {
      try {
        existingPn.stopEarly();
      } catch {
        // Ignore cleanup errors
      }
      this.unregister(existingPn.watchId);
    }

    if (handle.targetLidJid) {
      const lidKey = this.buildCompositeKey(
        handle.sessionId,
        handle.targetLidJid
      );
      const existingLid = this.bySessionTargetKey.get(lidKey);
      if (existingLid && existingLid.watchId !== handle.watchId) {
        try {
          existingLid.stopEarly();
        } catch {
          // Ignore cleanup errors
        }
        this.unregister(existingLid.watchId);
      }
      this.bySessionTargetKey.set(lidKey, handle);
    }

    this.byWatchId.set(handle.watchId, handle);
    this.bySessionTargetKey.set(pnKey, handle);
  }

  public unregister(watchId: string): void {
    const existing = this.byWatchId.get(watchId);
    if (!existing) return;
    this.byWatchId.delete(watchId);
    for (const [key, val] of this.bySessionTargetKey.entries()) {
      if (val.watchId === watchId) {
        this.bySessionTargetKey.delete(key);
      }
    }
  }

  public getByWatchId(
    watchId: string
  ): ActivePresenceTrackerHandle | undefined {
    return this.byWatchId.get(watchId);
  }

  public stopByWatchId(watchId: string): PresenceWatchReport | null {
    const handle = this.byWatchId.get(watchId);
    if (!handle) return null;
    try {
      const report = handle.stopEarly();
      this.unregister(watchId);
      return report;
    } catch {
      this.unregister(watchId);
      return null;
    }
  }

  public stopBySession(
    sessionId: string,
    targetFilter?: string
  ): PresenceWatchReport[] {
    const stopped: PresenceWatchReport[] = [];
    const normFilter = targetFilter
      ? parseTrackerJid(targetFilter).bareJid
      : undefined;
    const digitsFilter = targetFilter
      ? targetFilter.split('@')[0]?.replace(/\D/g, '')
      : undefined;

    for (const handle of Array.from(this.byWatchId.values())) {
      if (handle.sessionId !== sessionId) continue;
      if (normFilter || digitsFilter) {
        const matchesBare =
          handle.targetPnJid === normFilter ||
          handle.targetLidJid === normFilter;
        const matchesDigits =
          Boolean(digitsFilter) &&
          (handle.targetPnJid.startsWith(`${digitsFilter}@`) ||
            Boolean(handle.targetLidJid?.startsWith(`${digitsFilter}@`)));
        if (!matchesBare && !matchesDigits) continue;
      }
      try {
        stopped.push(handle.stopEarly());
      } catch {
        // Ignore
      }
      this.unregister(handle.watchId);
    }
    return stopped;
  }

  public stopByAdminId(adminId: number): PresenceWatchReport[] {
    const stopped: PresenceWatchReport[] = [];
    for (const handle of Array.from(this.byWatchId.values())) {
      if (handle.adminId !== undefined && handle.adminId !== adminId) continue;
      try {
        stopped.push(handle.stopEarly());
      } catch {
        // Ignore
      }
      this.unregister(handle.watchId);
    }
    return stopped;
  }

  public stopAllForAdmin(adminId: number): PresenceWatchReport[] {
    return this.stopByAdminId(adminId);
  }

  public listActive(sessionId?: string): ActivePresenceTrackerHandle[] {
    const all = Array.from(this.byWatchId.values());
    return sessionId ? all.filter((h) => h.sessionId === sessionId) : all;
  }
}

const defaultTrackerRegistry = new ActivePresenceTrackerRegistry();

export function getActivePresenceTrackerRegistry(): ActivePresenceTrackerRegistry {
  return defaultTrackerRegistry;
}

/**
 * Resolves a target's `pnJid`, `lidJid`, and multi-device list via a single `USyncQuery`
 * (`.withContactProtocol().withLIDProtocol().withDeviceProtocol()`) with safe fallbacks
 * to `getUSyncDevices` and `onWhatsApp`.
 */
export async function resolveTargetIdentityAndDevices(params: {
  sock: Partial<WASocket> & Record<string, unknown>;
  recipient: string;
  fallbackLookup?: (
    targetJid: string
  ) => Promise<{ pnJid?: string; lidJid?: string } | null>;
}): Promise<TargetIdentityResolution> {
  const parsedInput = parseTrackerJid(params.recipient);
  let pnJid = parsedInput.isPn ? parsedInput.bareJid : '';
  let lidJid = parsedInput.isLid ? parsedInput.bareJid : undefined;
  const detectedDevicesSet = new Set<string>();
  const startMs = Date.now();
  let initialUsyncRttMs: number | undefined;

  const sock = params.sock;

  // 1. Primary USyncQuery with Contact + LID + Device protocols
  if (
    typeof sock.executeUSyncQuery === 'function' &&
    typeof USyncQuery === 'function' &&
    typeof USyncUser === 'function'
  ) {
    try {
      const usyncQuery = new USyncQuery().withContext('interactive');
      if (typeof usyncQuery.withContactProtocol === 'function') {
        usyncQuery.withContactProtocol();
      }
      if (typeof usyncQuery.withLIDProtocol === 'function') {
        usyncQuery.withLIDProtocol();
      }
      if (typeof usyncQuery.withDeviceProtocol === 'function') {
        usyncQuery.withDeviceProtocol();
      } else if (typeof usyncQuery.withDevicesProtocol === 'function') {
        usyncQuery.withDevicesProtocol();
      }

      const user = new USyncUser();
      if (pnJid) {
        const digits = pnJid.split('@')[0]?.replace(/\D/g, '') || '';
        if (digits && typeof user.withPhone === 'function') {
          user.withPhone(`+${digits}`);
        }
        if (typeof user.withId === 'function') {
          user.withId(pnJid);
        }
      } else if (lidJid && typeof user.withId === 'function') {
        user.withId(lidJid);
      }
      usyncQuery.withUser(user);

      const queryRes = await sock.executeUSyncQuery(usyncQuery);
      initialUsyncRttMs = Math.max(1, Date.now() - startMs);
      const list = Array.isArray(queryRes?.list) ? queryRes.list : [];

      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const itemId =
          typeof item.id === 'string' ? parseTrackerJid(item.id).bareJid : '';
        if (itemId.endsWith('@s.whatsapp.net') && !pnJid) {
          pnJid = itemId;
        } else if (itemId.endsWith('@lid') && !lidJid) {
          lidJid = itemId;
        }

        const rawLid = item.lid;
        const lidCandidate =
          typeof rawLid === 'string'
            ? rawLid
            : rawLid && typeof rawLid === 'object'
              ? ((rawLid as { lid?: string; id?: string; jid?: string }).lid ??
                (rawLid as { lid?: string; id?: string; jid?: string }).jid ??
                (rawLid as { lid?: string; id?: string; jid?: string }).id)
              : undefined;
        if (typeof lidCandidate === 'string' && lidCandidate.trim()) {
          const normLid = lidCandidate.includes('@')
            ? parseTrackerJid(lidCandidate).bareJid
            : `${lidCandidate.replace(/\D/g, '')}@lid`;
          if (normLid.endsWith('@lid')) {
            lidJid = normLid;
          }
        }

        const deviceList = item.devices?.deviceList;
        if (Array.isArray(deviceList)) {
          const baseUser = (pnJid || lidJid || parsedInput.bareJid).split(
            '@'
          )[0];
          const baseServer = (pnJid || lidJid || parsedInput.bareJid).endsWith(
            '@lid'
          )
            ? 'lid'
            : 's.whatsapp.net';
          for (const d of deviceList) {
            const devId = Number((d as { id?: number })?.id ?? 0);
            if (Number.isFinite(devId) && baseUser) {
              detectedDevicesSet.add(`${baseUser}:${devId}@${baseServer}`);
            }
          }
        }
      }
    } catch {
      // Safe fallback to fallbackLookup and getUSyncDevices below
    }
  }

  // 2. Fallback lookup if LID or PN is still missing
  if ((!lidJid || !pnJid) && params.fallbackLookup) {
    try {
      const fbStart = Date.now();
      const fb = await params.fallbackLookup(parsedInput.bareJid);
      if (!initialUsyncRttMs && fb) {
        initialUsyncRttMs = Math.max(1, Date.now() - fbStart);
      }
      if (fb?.pnJid && fb.pnJid.endsWith('@s.whatsapp.net')) {
        pnJid = parseTrackerJid(fb.pnJid).bareJid;
      }
      if (fb?.lidJid && fb.lidJid.endsWith('@lid')) {
        lidJid = parseTrackerJid(fb.lidJid).bareJid;
      }
    } catch {
      // Ignore fallback lookup errors
    }
  }

  // 3. Fallback device enumeration via sock.getUSyncDevices
  if (typeof sock.getUSyncDevices === 'function') {
    try {
      const targets = [pnJid, lidJid].filter((j): j is string => Boolean(j));
      if (targets.length > 0) {
        const devStart = Date.now();
        const rawDevs = await sock.getUSyncDevices(targets, false, false);
        if (!initialUsyncRttMs) {
          initialUsyncRttMs = Math.max(1, Date.now() - devStart);
        }
        if (Array.isArray(rawDevs)) {
          for (const d of rawDevs) {
            if (!d || typeof d !== 'object') continue;
            const dJid = (d as { jid?: string }).jid;
            if (typeof dJid === 'string' && dJid.includes('@')) {
              detectedDevicesSet.add(parseTrackerJid(dJid).formattedDeviceJid);
              continue;
            }
            const user = String((d as { user?: string }).user || '').trim();
            const devId = Number((d as { device?: number }).device ?? 0);
            if (user) {
              const server =
                lidJid && lidJid.startsWith(`${user}@`)
                  ? 'lid'
                  : 's.whatsapp.net';
              detectedDevicesSet.add(`${user}:${devId}@${server}`);
            }
          }
        }
      }
    } catch {
      // Ignore getUSyncDevices error
    }
  }

  if (!pnJid) {
    pnJid = parsedInput.bareJid;
  }

  if (detectedDevicesSet.size === 0 && pnJid) {
    const parsedPn = parseTrackerJid(pnJid);
    if (parsedPn.formattedDeviceJid) {
      detectedDevicesSet.add(parsedPn.formattedDeviceJid);
    }
  }

  const digits = pnJid.split('@')[0]?.replace(/\D/g, '') || '';
  const e164Phone = digits ? `+${digits}` : pnJid;

  return {
    pnJid,
    lidJid,
    e164Phone,
    detectedDevices: Array.from(detectedDevicesSet),
    initialUsyncRttMs,
  };
}

interface PendingRttProbe {
  probeSeq: number;
  probeMsgId: string;
  fakeTargetMsgId: string;
  targetJid: string;
  sentAtMs: number;
  sentPerfMs: number;
  status: 'PENDING' | 'ACKED' | 'TIMEOUT';
  timeoutTimer?: ReturnType<typeof setTimeout>;
  ackedDevices: Set<string>;
}

export interface DeviceActivityTrackerOptions {
  sessionId: string;
  adminId?: number;
  sock: Partial<WASocket> & Record<string, unknown>;
  recipient: string;
  durationSeconds: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  resubscribeIntervalMs?: number;
  staleComposingTimeoutMs?: number;
  enableSilentReactionProbes?: boolean;
  registry?: ActivePresenceTrackerRegistry;
  fallbackIdentityLookup?: (
    targetJid: string
  ) => Promise<{ pnJid?: string; lidJid?: string } | null>;
  ensureSelfAvailable?: () => Promise<void>;
  onExternalTransition?: (transition: {
    chatJid: string;
    participantJid: string;
    state: WAPresence;
    lastSeen?: number;
    timestampMs: number;
    deviceJid?: string;
    source: 'presence' | 'chatstate' | 'message' | 'receipt' | 'usync_probe';
    privacyLastSeenDenied?: boolean;
    probeRttMs?: number;
    linkedDevices?: string[];
  }) => void;
  onSnapshotSync?: (report: PresenceWatchReport) => void;
  onUpdate?: (report: PresenceWatchReport) => void;
}

/**
 * Full-Featured `DeviceActivityTracker` modeled on `gommzystudio/device-activity-tracker`:
 * - Resolves target PN + LID + companion devices via `USyncQuery`.
 * - Sends periodic silent non-existent reaction probes (`react: { text: '', key: { id: fakeTargetMsgId } }`).
 * - Captures client `DELIVERY_ACK` across 3 simultaneous layers (`messages.update`, `message-receipt.update`, `CB:receipt`).
 * - Computes rolling RTT metrics (`lastRttMs`, `movingAvgRttMs`, `medianRttMs`, `dynamicThresholdMs`, `jitterMs`, `sparkline`).
 * - Classifies device state into `ACTIVE` (Screen On / App Foreground), `STANDBY` (Background / Locked), or `OFFLINE`.
 * - Integrates native `presence.update` and `CB:chatstate` (`available`, `composing`, `recording`, `paused`, `unavailable`).
 * - Supports instant manual termination via `ActivePresenceTrackerRegistry` (`presence:stop:<watchId>`).
 */
export class DeviceActivityTracker {
  public readonly watchId: string;
  public readonly sessionId: string;
  public readonly adminId?: number;
  public readonly durationSeconds: number;
  public readonly probeIntervalMs: number;
  public readonly probeTimeoutMs: number;
  public readonly resubscribeIntervalMs: number;
  public readonly staleComposingTimeoutMs: number;
  public readonly enableSilentReactionProbes: boolean;

  private readonly sock: Partial<WASocket> & Record<string, unknown>;
  private readonly registry: ActivePresenceTrackerRegistry;
  private readonly recipientInput: string;
  private readonly fallbackIdentityLookup?: DeviceActivityTrackerOptions['fallbackIdentityLookup'];
  private readonly ensureSelfAvailable?: DeviceActivityTrackerOptions['ensureSelfAvailable'];
  private readonly onExternalTransition?: DeviceActivityTrackerOptions['onExternalTransition'];
  private readonly onSnapshotSync?: DeviceActivityTrackerOptions['onSnapshotSync'];
  private readonly onUpdate?: DeviceActivityTrackerOptions['onUpdate'];

  private pnJid = '';
  private lidJid?: string;
  private currentPresenceState: WAPresence = 'unavailable';
  private currentActivityState: DeviceActivityState = 'STANDBY';
  private lastSeenTimestampSec?: number;
  private privacyLastSeenDenied = false;
  private lastActivitySource?: PresenceWatchReport['lastActivitySource'];

  private startedAtMs = 0;
  private endedAtMs?: number;
  private lastUpdatedMs = 0;
  private lastStateAccountedAtMs = 0;
  private onlineSessionStartedAtMs?: number;
  private totalOnlineDurationMs = 0;
  private activeDurationMs = 0;
  private standbyDurationMs = 0;
  private offlineDurationMs = 0;

  private probeCounter = 0;
  private probesSent = 0;
  private probesAcked = 0;
  private probesTimedOut = 0;
  private consecutiveTimeouts = 0;
  private initialUsyncRttMs?: number;

  private readonly rttHistory: number[] = [];
  private readonly rttSamples: RttProbeSample[] = [];
  private readonly transitions: PresenceActivityTransition[] = [];
  private readonly pendingProbes = new Map<string, PendingRttProbe>();
  private readonly fakeIdToProbeId = new Map<string, string>();
  private readonly detectedDevices = new Set<string>();
  private readonly respondingDevices = new Set<string>();

  private stoppedEarly = false;
  private finished = false;
  private resolveCompletion?: (report: PresenceWatchReport) => void;
  private readonly cleanupCallbacks: Array<() => void> = [];

  constructor(options: DeviceActivityTrackerOptions) {
    this.watchId = `pw_${crypto.randomBytes(4).toString('hex')}`;
    this.sessionId = options.sessionId;
    this.adminId = options.adminId;
    this.sock = options.sock;
    this.recipientInput = options.recipient;
    this.durationSeconds = Math.min(
      300,
      Math.max(1, Math.floor(Number(options.durationSeconds) || 15))
    );
    this.probeIntervalMs = Math.max(
      250,
      options.probeIntervalMs ??
        (this.durationSeconds <= 3 ? 900 : 2_700)
    );
    this.probeTimeoutMs = Math.max(
      150,
      options.probeTimeoutMs ?? 10_000
    );
    this.resubscribeIntervalMs = Math.max(
      1_000,
      options.resubscribeIntervalMs ?? 30_000
    );
    this.staleComposingTimeoutMs = Math.max(
      200,
      options.staleComposingTimeoutMs ?? 12_000
    );
    this.enableSilentReactionProbes =
      options.enableSilentReactionProbes !== false;
    this.registry = options.registry ?? getActivePresenceTrackerRegistry();
    this.fallbackIdentityLookup = options.fallbackIdentityLookup;
    this.ensureSelfAvailable = options.ensureSelfAvailable;
    this.onExternalTransition = options.onExternalTransition;
    this.onSnapshotSync = options.onSnapshotSync;
    this.onUpdate = options.onUpdate;
  }

  private accrueStateDuration(now = Date.now()): void {
    if (this.lastStateAccountedAtMs <= 0) {
      this.lastStateAccountedAtMs = now;
      return;
    }
    const delta = Math.max(0, now - this.lastStateAccountedAtMs);
    this.lastStateAccountedAtMs = now;
    if (this.currentActivityState === 'ACTIVE') {
      this.activeDurationMs += delta;
    } else if (this.currentActivityState === 'STANDBY') {
      this.standbyDurationMs += delta;
    } else {
      this.offlineDurationMs += delta;
    }
  }

  private recomputeActivityState(now = Date.now()): void {
    this.accrueStateDuration(now);
    const stats = computeRttTelemetryStats(this.rttHistory);
    const nextState = classifyDeviceActivityState({
      presenceState: this.currentPresenceState,
      movingAvgRttMs: stats.movingAvgRttMs,
      dynamicThresholdMs: stats.dynamicThresholdMs,
      consecutiveTimeouts: this.consecutiveTimeouts,
      probesAcked: this.probesAcked,
    });
    this.currentActivityState = nextState;
  }

  public getSnapshot(now = Date.now()): PresenceWatchReport {
    this.accrueStateDuration(now);
    const effectiveSamples =
      this.rttHistory.length > 0
        ? this.rttHistory
        : this.initialUsyncRttMs !== undefined
          ? [this.initialUsyncRttMs]
          : [];
    const stats = computeRttTelemetryStats(effectiveSamples);
    const elapsedSeconds = this.startedAtMs
      ? Math.min(
          this.durationSeconds,
          Math.max(0, Math.floor((now - this.startedAtMs) / 1000))
        )
      : 0;

    const liveOnlineMs =
      this.onlineSessionStartedAtMs !== undefined
        ? this.totalOnlineDurationMs +
          Math.max(0, now - this.onlineSessionStartedAtMs)
        : this.totalOnlineDurationMs;

    const effectiveActiveMs = Math.max(this.activeDurationMs, liveOnlineMs);
    const deliveryRatePct =
      this.probesSent > 0
        ? Math.min(100, Math.round((this.probesAcked / this.probesSent) * 100))
        : 0;

    const detectedDevicesArr = Array.from(this.detectedDevices);
    const respondingDevicesArr = Array.from(this.respondingDevices);

    return {
      watchId: this.watchId,
      sessionId: this.sessionId,
      chatJid: this.pnJid || parseTrackerJid(this.recipientInput).bareJid,
      resolvedLid: this.lidJid,
      currentState: this.currentPresenceState,
      deviceActivityState: this.currentActivityState,
      lastSeenTimestampSec: this.lastSeenTimestampSec,
      lastUpdatedMs: this.lastUpdatedMs || now,
      transitions: [...this.transitions],
      totalOnlineDurationMs: liveOnlineMs,
      onlineSessionStartedAtMs: this.onlineSessionStartedAtMs,
      probeRttMs: stats.lastRttMs ?? this.initialUsyncRttMs,
      lastRttMs: stats.lastRttMs ?? this.initialUsyncRttMs,
      movingAvgRttMs: stats.movingAvgRttMs ?? this.initialUsyncRttMs,
      avgRttMs: stats.avgRttMs ?? this.initialUsyncRttMs,
      medianRttMs: stats.medianRttMs ?? this.initialUsyncRttMs,
      minRttMs: stats.minRttMs ?? this.initialUsyncRttMs,
      maxRttMs: stats.maxRttMs ?? this.initialUsyncRttMs,
      jitterMs: stats.jitterMs ?? 0,
      thresholdMs: stats.dynamicThresholdMs,
      probesSent: this.probesSent,
      probesAcked: this.probesAcked,
      probesTimedOut: this.probesTimedOut,
      consecutiveTimeouts: this.consecutiveTimeouts,
      deliveryRatePct,
      sparkline: stats.sparkline,
      rttSamples: [...this.rttSamples],
      activeDurationSeconds: Number((effectiveActiveMs / 1000).toFixed(1)),
      standbyDurationSeconds: Number((this.standbyDurationMs / 1000).toFixed(1)),
      offlineDurationSeconds: Number((this.offlineDurationMs / 1000).toFixed(1)),
      detectedDevices: detectedDevicesArr,
      respondingDevices: respondingDevicesArr,
      linkedDevices: detectedDevicesArr,
      activeDevices: respondingDevicesArr,
      privacyLastSeenDenied: this.privacyLastSeenDenied,
      elapsedSeconds,
      targetDurationSeconds: this.durationSeconds,
      stoppedEarly: this.stoppedEarly,
      startedAtIso: new Date(this.startedAtMs || now).toISOString(),
      endedAtIso: this.endedAtMs
        ? new Date(this.endedAtMs).toISOString()
        : undefined,
      lastActivitySource: this.lastActivitySource,
    };
  }

  private notifyUpdate(): void {
    if (this.finished) return;
    const snap = this.getSnapshot();
    try {
      this.onSnapshotSync?.(snap);
    } catch {
      // Ignore sync errors
    }
    if (!this.onUpdate) return;
    try {
      this.onUpdate(snap);
    } catch {
      // Never let UI listener errors break protocol loop
    }
  }

  /**
   * Sends a silent reaction probe to a non-existent random message ID (`3EB0...`)
   * and registers the outbound probe timestamp for Triple-Layer RTT capture.
   */
  public async sendSilentReactionProbe(): Promise<string | null> {
    if (this.finished || !this.enableSilentReactionProbes) return null;
    if (typeof this.sock.sendMessage !== 'function') return null;

    const targetJid = this.pnJid || this.lidJid;
    if (!targetJid) return null;

    const probeSeq = ++this.probeCounter;
    const fakeTargetMsgId = `3EB0${crypto
      .randomBytes(8)
      .toString('hex')
      .toUpperCase()}`;
    const preGeneratedMsgId = `3EB0${crypto
      .randomBytes(8)
      .toString('hex')
      .toUpperCase()}`;
    const sentAtMs = Date.now();
    const sentPerfMs = performance.now();

    // Pre-register before awaiting sendMessage in case synchronous mock sockets emit receipts immediately!
    const pending: PendingRttProbe = {
      probeSeq,
      probeMsgId: preGeneratedMsgId,
      fakeTargetMsgId,
      targetJid,
      sentAtMs,
      sentPerfMs,
      status: 'PENDING',
      ackedDevices: new Set<string>(),
    };
    this.pendingProbes.set(preGeneratedMsgId, pending);
    this.fakeIdToProbeId.set(fakeTargetMsgId, preGeneratedMsgId);
    this.probesSent++;

    try {
      const probeResult = (await this.sock.sendMessage(
        targetJid,
        {
          react: {
            text: '',
            key: {
              remoteJid: targetJid,
              fromMe: true,
              id: fakeTargetMsgId,
            },
          },
        },
        { messageId: preGeneratedMsgId } as unknown as Record<string, unknown>
      )) as { key?: { id?: string } } | undefined;

      const returnedId = probeResult?.key?.id;
      if (returnedId && returnedId !== preGeneratedMsgId) {
        pending.probeMsgId = returnedId;
        this.pendingProbes.set(returnedId, pending);
        this.fakeIdToProbeId.set(fakeTargetMsgId, returnedId);
      }

      if (!this.finished && pending.status === 'PENDING') {
        const timeoutTimer = setTimeout(() => {
          this.handleProbeTimeout(pending.probeMsgId);
        }, this.probeTimeoutMs);
        if (typeof timeoutTimer.unref === 'function') {
          timeoutTimer.unref();
        }
        pending.timeoutTimer = timeoutTimer;
      }

      return pending.probeMsgId;
    } catch (err) {
      this.pendingProbes.delete(preGeneratedMsgId);
      this.fakeIdToProbeId.delete(fakeTargetMsgId);
      this.probesSent = Math.max(0, this.probesSent - 1);
      log.debug('Silent reaction RTT probe send skipped/failed', {
        sessionId: this.sessionId,
        targetJid,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private handleProbeTimeout(probeMsgId: string): void {
    if (this.finished) return;
    const pending = this.pendingProbes.get(probeMsgId);
    if (!pending || pending.status !== 'PENDING') return;

    pending.status = 'TIMEOUT';
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
      pending.timeoutTimer = undefined;
    }

    this.probesTimedOut++;
    this.consecutiveTimeouts++;
    const now = Date.now();
    this.lastUpdatedMs = now;
    this.recomputeActivityState(now);

    const stats = computeRttTelemetryStats(this.rttHistory);
    this.rttSamples.push({
      probeSeq: pending.probeSeq,
      probeMsgId: pending.probeMsgId,
      fakeTargetMsgId: pending.fakeTargetMsgId,
      targetJid: pending.targetJid,
      sentAtMs: pending.sentAtMs,
      status: 'TIMEOUT',
      classifiedStateAfterProbe: this.currentActivityState,
      movingAvgRttMs: stats.movingAvgRttMs,
      medianRttMs: stats.medianRttMs,
      thresholdMs: stats.dynamicThresholdMs,
    });

    if (this.consecutiveTimeouts >= 2) {
      this.transitions.push({
        state: 'unavailable',
        activityState: 'OFFLINE',
        timestampMs: now,
        participantJid: this.pnJid,
        source: 'rtt_probe',
      });
    }

    this.notifyUpdate();
  }

  /**
   * Processes an incoming client receipt from any of the 3 capture layers:
   * - Layer 1: `messages.update` (`status >= 3`)
   * - Layer 2: `message-receipt.update`
   * - Layer 3: `ws.CB:receipt`
   */
  public recordProbeAck(params: {
    messageId?: string | null;
    fromJid?: string | null;
    participantJid?: string | null;
    layer: RttAckCaptureLayer;
    explicitRttMs?: number;
  }): boolean {
    if (this.finished) return false;
    const rawMsgId = String(params.messageId || '').trim();
    if (!rawMsgId) return false;

    const mappedProbeId = this.fakeIdToProbeId.get(rawMsgId) || rawMsgId;
    const pending = this.pendingProbes.get(mappedProbeId);
    if (!pending) return false;

    const responderRaw =
      params.participantJid || params.fromJid || pending.targetJid;
    const parsedResponder = parseTrackerJid(responderRaw);
    if (parsedResponder.formattedDeviceJid) {
      this.detectedDevices.add(parsedResponder.formattedDeviceJid);
      this.respondingDevices.add(parsedResponder.formattedDeviceJid);
    }

    // If this probe was already ACKed on another layer by the primary device, record additional companion device IDs without duplicating the RTT sample
    if (pending.status === 'ACKED') {
      if (
        parsedResponder.formattedDeviceJid &&
        !pending.ackedDevices.has(parsedResponder.formattedDeviceJid)
      ) {
        pending.ackedDevices.add(parsedResponder.formattedDeviceJid);
        this.notifyUpdate();
      }
      return false;
    }

    const wasTimedOut = pending.status === 'TIMEOUT';
    if (pending.timeoutTimer) {
      clearTimeout(pending.timeoutTimer);
      pending.timeoutTimer = undefined;
    }

    const now = Date.now();
    const perfElapsed = Math.max(1, Math.round(performance.now() - pending.sentPerfMs));
    const wallElapsed = Math.max(1, now - pending.sentAtMs);
    const rttMs =
      typeof params.explicitRttMs === 'number' && params.explicitRttMs >= 0
        ? Math.max(1, Math.round(params.explicitRttMs))
        : Math.min(perfElapsed, wallElapsed + 50);

    const isBacklogFlush = wasTimedOut || rttMs > this.probeTimeoutMs;

    pending.status = 'ACKED';
    if (parsedResponder.formattedDeviceJid) {
      pending.ackedDevices.add(parsedResponder.formattedDeviceJid);
    }

    if (wasTimedOut && this.probesTimedOut > 0) {
      this.probesTimedOut--;
    }
    this.probesAcked++;
    this.consecutiveTimeouts = 0;

    if (!isBacklogFlush) {
      this.rttHistory.push(rttMs);
      if (this.rttHistory.length > 20) {
        this.rttHistory.shift();
      }
    }

    this.lastUpdatedMs = now;
    this.lastActivitySource = 'rtt_probe';
    this.recomputeActivityState(now);

    const stats = computeRttTelemetryStats(this.rttHistory);
    const sample: RttProbeSample = {
      probeSeq: pending.probeSeq,
      probeMsgId: pending.probeMsgId,
      fakeTargetMsgId: pending.fakeTargetMsgId,
      targetJid: pending.targetJid,
      sentAtMs: pending.sentAtMs,
      ackedAtMs: now,
      rttMs,
      status: 'ACKED',
      captureLayer: params.layer,
      respondingDeviceJid:
        parsedResponder.formattedDeviceJid || pending.targetJid,
      respondingDeviceId: parsedResponder.deviceId,
      isBacklogFlush,
      classifiedStateAfterProbe: this.currentActivityState,
      movingAvgRttMs: stats.movingAvgRttMs ?? rttMs,
      medianRttMs: stats.medianRttMs ?? rttMs,
      thresholdMs: stats.dynamicThresholdMs,
    };

    const existingTimeoutIdx = this.rttSamples.findIndex(
      (s) => s.probeSeq === pending.probeSeq && s.status === 'TIMEOUT'
    );
    if (existingTimeoutIdx !== -1) {
      this.rttSamples[existingTimeoutIdx] = sample;
    } else {
      this.rttSamples.push(sample);
    }

    const mappedPresenceState: WAPresence =
      this.currentPresenceState === 'composing' ||
      this.currentPresenceState === 'recording' ||
      this.currentPresenceState === 'paused'
        ? this.currentPresenceState
        : this.currentActivityState === 'ACTIVE'
          ? 'available'
          : 'unavailable';

    this.transitions.push({
      state: mappedPresenceState,
      activityState: this.currentActivityState,
      timestampMs: now,
      participantJid: parsedResponder.bareJid || this.pnJid,
      deviceJid: parsedResponder.formattedDeviceJid || undefined,
      deviceId: parsedResponder.deviceId,
      rttMs,
      source: 'rtt_probe',
    });

    this.onExternalTransition?.({
      chatJid: this.pnJid,
      participantJid: parsedResponder.bareJid || this.pnJid,
      state: mappedPresenceState,
      timestampMs: now,
      deviceJid: parsedResponder.formattedDeviceJid || undefined,
      source: 'receipt',
      probeRttMs: rttMs,
      linkedDevices: Array.from(this.detectedDevices),
    });

    this.notifyUpdate();
    return true;
  }

  /**
   * Records a native presence or chatstate event (`available`, `unavailable`, `composing`, `recording`, `paused`).
   */
  public recordNativePresenceEvent(params: {
    fromJid: string;
    participantJid?: string;
    state: WAPresence;
    lastSeenSec?: number;
    privacyLastSeenDenied?: boolean;
    source: 'presence' | 'chatstate' | 'message';
  }): void {
    if (this.finished) return;
    const rawCandidate = params.participantJid || params.fromJid;
    const matchInfo = matchesTrackedTargetJid(
      rawCandidate,
      this.pnJid,
      this.lidJid
    );
    const chatMatchInfo = matchesTrackedTargetJid(
      params.fromJid,
      this.pnJid,
      this.lidJid
    );
    if (!matchInfo.matches && !chatMatchInfo.matches) return;

    const parsedDevice = matchInfo.matches
      ? matchInfo.parsed
      : chatMatchInfo.parsed;
    const now = Date.now();

    // Guard against baileys-lite's internal `if (type === 'paused') type = 'available'` rewrite
    // overwriting a raw `CB:chatstate` `<paused/>` transition captured milliseconds earlier.
    let effectiveState = params.state;
    if (
      this.currentPresenceState === 'paused' &&
      this.lastActivitySource === 'chatstate' &&
      params.state === 'available' &&
      params.source === 'presence' &&
      Math.abs(now - this.lastUpdatedMs) < 250
    ) {
      effectiveState = 'paused';
    }

    if (parsedDevice.formattedDeviceJid) {
      this.detectedDevices.add(parsedDevice.formattedDeviceJid);
      if (effectiveState !== 'unavailable') {
        this.respondingDevices.add(parsedDevice.formattedDeviceJid);
      }
    }

    if (params.privacyLastSeenDenied) {
      this.privacyLastSeenDenied = true;
    }
    if (
      typeof params.lastSeenSec === 'number' &&
      params.lastSeenSec > 946684800
    ) {
      this.lastSeenTimestampSec = params.lastSeenSec;
    }

    const isOnline =
      effectiveState === 'available' ||
      effectiveState === 'composing' ||
      effectiveState === 'recording' ||
      effectiveState === 'paused';

    if (isOnline && this.onlineSessionStartedAtMs === undefined) {
      this.onlineSessionStartedAtMs = now;
      this.consecutiveTimeouts = 0;
    } else if (!isOnline && this.onlineSessionStartedAtMs !== undefined) {
      this.totalOnlineDurationMs += Math.max(
        0,
        now - this.onlineSessionStartedAtMs
      );
      this.onlineSessionStartedAtMs = undefined;
      if (!this.lastSeenTimestampSec && !this.privacyLastSeenDenied) {
        this.lastSeenTimestampSec = Math.floor(now / 1000);
      }
    }

    const stateChanged =
      this.transitions.length === 0 ||
      this.currentPresenceState !== effectiveState;

    this.currentPresenceState = effectiveState;
    this.lastUpdatedMs = now;
    this.lastActivitySource = params.source;
    this.recomputeActivityState(now);

    if (stateChanged) {
      this.transitions.push({
        state: effectiveState,
        activityState: this.currentActivityState,
        timestampMs: now,
        participantJid: parsedDevice.bareJid || this.pnJid,
        deviceJid: parsedDevice.formattedDeviceJid || undefined,
        deviceId: parsedDevice.deviceId,
        source: params.source,
      });
    }

    this.notifyUpdate();
  }

  public stopEarly(): PresenceWatchReport {
    if (!this.finished) {
      this.stoppedEarly = true;
      this.finish();
    }
    return this.getSnapshot();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    const now = Date.now();
    this.endedAtMs = now;
    this.accrueStateDuration(now);

    if (this.onlineSessionStartedAtMs !== undefined) {
      this.totalOnlineDurationMs += Math.max(
        0,
        now - this.onlineSessionStartedAtMs
      );
      this.onlineSessionStartedAtMs = undefined;
    }

    for (const pending of this.pendingProbes.values()) {
      if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = undefined;
      }
    }
    this.pendingProbes.clear();
    this.fakeIdToProbeId.clear();

    for (const fn of this.cleanupCallbacks.splice(0)) {
      try {
        fn();
      } catch {
        // Ignore cleanup error
      }
    }

    this.registry.unregister(this.watchId);
    const finalReport = this.getSnapshot(now);
    try {
      this.onSnapshotSync?.(finalReport);
    } catch {
      // Ignore sync errors
    }
    this.resolveCompletion?.(finalReport);
  }

  /**
   * Starts the full tracking lifecycle and returns a Promise that resolves when
   * `durationSeconds` elapses or `stopEarly()` is called.
   */
  public async run(): Promise<PresenceWatchReport> {
    this.startedAtMs = Date.now();
    this.lastUpdatedMs = this.startedAtMs;
    this.lastStateAccountedAtMs = this.startedAtMs;

    // 1. Target Identity & Multi-Device Resolution via USyncQuery
    const identity = await resolveTargetIdentityAndDevices({
      sock: this.sock,
      recipient: this.recipientInput,
      fallbackLookup: this.fallbackIdentityLookup,
    });
    this.pnJid = identity.pnJid;
    this.lidJid = identity.lidJid;
    this.initialUsyncRttMs = identity.initialUsyncRttMs;
    for (const d of identity.detectedDevices) {
      this.detectedDevices.add(d);
    }

    let completionPromise!: Promise<PresenceWatchReport>;
    const waitPromise = new Promise<PresenceWatchReport>((resolve) => {
      this.resolveCompletion = resolve;
    });
    completionPromise = waitPromise;

    // Register in ActivePresenceTrackerRegistry (stopping any duplicate tracker on same session + target)
    this.registry.register({
      watchId: this.watchId,
      sessionId: this.sessionId,
      adminId: this.adminId,
      targetPnJid: this.pnJid,
      targetLidJid: this.lidJid,
      startedAtMs: this.startedAtMs,
      stopEarly: () => this.stopEarly(),
      getLatestSnapshot: () => this.getSnapshot(),
      completionPromise,
    });

    if (this.finished) {
      return this.getSnapshot();
    }

    // 2. Attach Triple-Layer Receipt & Native Presence Listeners BEFORE subscribing/probing
    const ev = this.sock.ev as
      | {
          on?: (event: string, listener: (...args: any[]) => void) => void;
          off?: (event: string, listener: (...args: any[]) => void) => void;
        }
      | undefined;

    const ws = this.sock.ws as
      | {
          on?: (event: string, listener: (...args: any[]) => void) => void;
          off?: (event: string, listener: (...args: any[]) => void) => void;
        }
      | undefined;

    // Layer 1: messages.update
    const onMessagesUpdate = (
      updates:
        | Array<{
            key?: {
              id?: string | null;
              remoteJid?: string | null;
              participant?: string | null;
              fromMe?: boolean | null;
            };
            update?: { status?: number | null };
          }>
        | {
            key?: {
              id?: string | null;
              remoteJid?: string | null;
              participant?: string | null;
              fromMe?: boolean | null;
            };
            update?: { status?: number | null };
          }
    ) => {
      const list = Array.isArray(updates) ? updates : [updates];
      for (const u of list) {
        const status = Number(u?.update?.status ?? 0);
        if (status >= 3) {
          const msgId = u?.key?.id;
          const remoteJid = u?.key?.remoteJid;
          const participant = u?.key?.participant;
          this.recordProbeAck({
            messageId: msgId,
            fromJid: remoteJid,
            participantJid: participant,
            layer: 'messages.update',
          });
        }
      }
    };

    // Layer 2: message-receipt.update
    const onMessageReceiptUpdate = (
      receipts: Array<{
        key?: {
          id?: string | null;
          remoteJid?: string | null;
          participant?: string | null;
        };
        receipt?: {
          userJid?: string | null;
          receiptTimestamp?: number | unknown;
          readTimestamp?: number | unknown;
          playedTimestamp?: number | unknown;
          type?: string | null;
        };
      }>
    ) => {
      if (!Array.isArray(receipts)) return;
      for (const r of receipts) {
        const rType = r?.receipt?.type;
        if (rType === 'server-error' || rType === 'retry') continue;
        const msgId = r?.key?.id;
        const responder =
          r?.receipt?.userJid || r?.key?.participant || r?.key?.remoteJid;
        this.recordProbeAck({
          messageId: msgId,
          fromJid: r?.key?.remoteJid,
          participantJid: responder,
          layer: 'message-receipt.update',
        });
      }
    };

    // Native presence.update
    const onPresenceUpdate = (update: {
      id: string;
      presences: Record<
        string,
        { lastKnownPresence?: WAPresence; lastSeen?: number }
      >;
    }) => {
      if (!update || !update.presences) return;
      for (const [participantJid, data] of Object.entries(update.presences)) {
        if (!data?.lastKnownPresence) continue;
        this.recordNativePresenceEvent({
          fromJid: update.id,
          participantJid,
          state: data.lastKnownPresence,
          lastSeenSec: data.lastSeen,
          source: 'presence',
        });
      }
    };

    if (typeof ev?.on === 'function') {
      ev.on('messages.update', onMessagesUpdate);
      ev.on('message-receipt.update', onMessageReceiptUpdate);
      ev.on('presence.update', onPresenceUpdate);
      this.cleanupCallbacks.push(() => {
        ev.off?.('messages.update', onMessagesUpdate);
        ev.off?.('message-receipt.update', onMessageReceiptUpdate);
        ev.off?.('presence.update', onPresenceUpdate);
      });
    }

    // Layer 3: Raw WebSocket BinaryNode `CB:receipt`, `CB:chatstate`, `CB:presence`
    const onRawReceiptNode = (node: BinaryNode) => {
      if (!node || typeof node !== 'object') return;
      const receiptType = String(node.attrs?.type || '').toLowerCase();
      if (receiptType === 'server-error' || receiptType === 'retry') return;

      const fromAttr = node.attrs?.from || '';
      const participantAttr = node.attrs?.participant || fromAttr;
      const candidateIds = new Set<string>();
      if (node.attrs?.id) {
        candidateIds.add(node.attrs.id);
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content) {
          if (child?.tag === 'list' && Array.isArray(child.content)) {
            for (const item of child.content) {
              if (item?.attrs?.id) {
                candidateIds.add(item.attrs.id);
              }
            }
          } else if (child?.attrs?.id) {
            candidateIds.add(child.attrs.id);
          }
        }
      }

      for (const msgId of candidateIds) {
        this.recordProbeAck({
          messageId: msgId,
          fromJid: fromAttr,
          participantJid: participantAttr,
          layer: 'ws.CB:receipt',
        });
      }
    };

    const onRawChatstateNode = (node: BinaryNode) => {
      if (!node || typeof node !== 'object') return;
      const fromRaw = node.attrs?.from;
      if (!fromRaw) return;
      const participantRaw = node.attrs?.participant || fromRaw;
      const children = Array.isArray(node.content) ? node.content : [];
      const stateChild = children.find(
        (c) =>
          c &&
          typeof c === 'object' &&
          (c.tag === 'composing' || c.tag === 'paused')
      );
      if (!stateChild) return;

      let state: WAPresence = 'available';
      if (stateChild.tag === 'composing') {
        state =
          stateChild.attrs?.media === 'audio' ? 'recording' : 'composing';
      } else if (stateChild.tag === 'paused') {
        state = 'paused';
      }

      this.recordNativePresenceEvent({
        fromJid: fromRaw,
        participantJid: participantRaw,
        state,
        source: 'chatstate',
      });
    };

    const onRawPresenceNode = (node: BinaryNode) => {
      if (!node || typeof node !== 'object') return;
      const fromRaw = node.attrs?.from;
      if (!fromRaw) return;
      const participantRaw = node.attrs?.participant || fromRaw;
      const typeAttr = node.attrs?.type;
      const lastAttr = node.attrs?.last;
      const state: WAPresence =
        typeAttr === 'unavailable' ? 'unavailable' : 'available';
      const privacyDenied =
        lastAttr === 'deny' || lastAttr === 'none' || lastAttr === 'error';
      const parsedLast =
        lastAttr && !privacyDenied && /^\d+$/.test(String(lastAttr))
          ? Number(lastAttr)
          : undefined;

      this.recordNativePresenceEvent({
        fromJid: fromRaw,
        participantJid: participantRaw,
        state,
        lastSeenSec: parsedLast,
        privacyLastSeenDenied: privacyDenied || undefined,
        source: 'presence',
      });
    };

    if (typeof ws?.on === 'function') {
      ws.on('CB:receipt', onRawReceiptNode);
      ws.on('CB:chatstate', onRawChatstateNode);
      ws.on('CB:presence', onRawPresenceNode);
      this.cleanupCallbacks.push(() => {
        ws.off?.('CB:receipt', onRawReceiptNode);
        ws.off?.('CB:chatstate', onRawChatstateNode);
        ws.off?.('CB:presence', onRawPresenceNode);
      });
    }

    // 3. Keep socket in `available` state and subscribe to both `pnJid` and `lidJid`
    const subscribePresence = async () => {
      if (this.finished) return;
      if (this.ensureSelfAvailable) {
        await this.ensureSelfAvailable().catch(() => undefined);
      } else if (typeof this.sock.sendPresenceUpdate === 'function') {
        await this.sock.sendPresenceUpdate('available').catch(() => undefined);
      }
      if (typeof this.sock.presenceSubscribe === 'function') {
        if (this.pnJid) {
          await this.sock.presenceSubscribe(this.pnJid).catch(() => undefined);
        }
        if (this.lidJid && this.lidJid !== this.pnJid) {
          await this.sock.presenceSubscribe(this.lidJid).catch(() => undefined);
        }
      }
    };

    await subscribePresence();
    this.notifyUpdate();

    // 4. Fire initial silent reaction RTT probe immediately and schedule periodic probes
    void this.sendSilentReactionProbe();

    const probeInterval = setInterval(() => {
      void this.sendSilentReactionProbe();
    }, this.probeIntervalMs);
    if (typeof probeInterval.unref === 'function') {
      probeInterval.unref();
    }
    this.cleanupCallbacks.push(() => clearInterval(probeInterval));

    // 5. Re-subscribe every 30s (`resubscribeIntervalMs`) so WhatsApp never drops presence stream
    const resubscribeTimer = setInterval(() => {
      void subscribePresence();
    }, this.resubscribeIntervalMs);
    if (typeof resubscribeTimer.unref === 'function') {
      resubscribeTimer.unref();
    }
    this.cleanupCallbacks.push(() => clearInterval(resubscribeTimer));

    // 6. Periodic live progress ticker (every 1.5s)
    const liveUiTimer =
      this.durationSeconds >= 2 && this.onUpdate
        ? setInterval(() => {
            this.notifyUpdate();
          }, 1_500)
        : undefined;
    if (liveUiTimer) {
      if (typeof liveUiTimer.unref === 'function') {
        liveUiTimer.unref();
      }
      this.cleanupCallbacks.push(() => clearInterval(liveUiTimer));
    }

    // 7. Watchdog for stale composing/recording (>12s without paused/message)
    const staleWatchdog = setInterval(() => {
      if (this.finished) return;
      if (
        (this.currentPresenceState === 'composing' ||
          this.currentPresenceState === 'recording') &&
        Date.now() - this.lastUpdatedMs >= this.staleComposingTimeoutMs
      ) {
        this.recordNativePresenceEvent({
          fromJid: this.pnJid,
          participantJid: this.lidJid || this.pnJid,
          state: 'available',
          source: 'presence',
        });
        this.onExternalTransition?.({
          chatJid: this.pnJid,
          participantJid: this.lidJid || this.pnJid,
          state: 'available',
          timestampMs: Date.now(),
          source: 'presence',
        });
      }
    }, Math.min(1_000, Math.max(50, Math.floor(this.staleComposingTimeoutMs / 2))));
    if (typeof staleWatchdog.unref === 'function') {
      staleWatchdog.unref();
    }
    this.cleanupCallbacks.push(() => clearInterval(staleWatchdog));

    // 8. Total duration timer
    const doneTimer = setTimeout(() => {
      this.finish();
    }, this.durationSeconds * 1000);
    this.cleanupCallbacks.push(() => clearTimeout(doneTimer));

    return await completionPromise;
  }
}
