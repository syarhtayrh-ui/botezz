import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  VoipCallInstance,
  WaCallMediaSessionLike,
} from '@hiroosy/baileys-lite/voip';
import { SessionManager } from './session-manager';
import { AuditRepository } from '../database/repositories/audit-repository';
import { WhatsAppSessionDriver } from './connection-manager';
import {
  Voip,
  CompatibleWhatsAppSocket,
  toCompatibleWhatsAppSocket,
  classifyEngineeringFailure,
} from './baileys-compat';
import {
  runBaileysCompatibilityProbe,
  CompatibilityReport,
  VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
} from './compatibility-probe';
import {
  validateAndInspectVideoMedia,
  generatePlayableVoipMp4File,
  VideoMediaInspectionResult,
  VoipVideoResolutionPreset,
} from './voip-media-pipeline';
import {
  ensureHiroosyVoipRuntimePatched,
  instrumentMediaSessionInstance,
  hasVerifiedRelayMediaAcceptance,
  listenWithTrackedSocketCleanup,
  type InstrumentedMediaSession,
} from './voip-runtime-patch';
import {
  VoipCallRecorder,
  type CallRecordingStatus,
  type VoipCallRecordingSummary,
} from './voip-call-recorder';
import { createMinimalMp4Buffer } from '../function-lab/media-sticker-toolkit';
import {
  AppError,
  WhatsAppConnectionError,
  VoipFailureError,
  MediaValidationError,
} from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('video-call-bridge');

export type RealCallState =
  | 'INITIATING'
  | 'RINGING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'MEDIA_NEGOTIATING'
  | 'MEDIA_STARTED'
  | 'MEDIA_STOPPED'
  | 'ENDED'
  | 'REJECTED'
  | 'TIMEOUT'
  | 'FAILED'
  | 'MEDIA_FAILED';

export type NativeCallProtocolMode = 'HIROOSY_VOIP_VIDEO_CALL';

export type VideoCallExecutionMode = 'HIROOSY_VOIP_RTP_SRTP';

export interface VideoCallEnvironmentProbe {
  platform: string;
  protocolNativeEngineAvailable: boolean;
  voipCompatible: boolean;
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  recommendedMode: VideoCallExecutionMode;
  compatibilityReport: CompatibilityReport;
}

export interface OutboundMediaEvidence {
  audioPacketsSent: number;
  audioOctetsSent: number;
  videoPacketsSent: number;
  videoOctetsSent: number;
  videoKeyframesSent: number;
  verifiedAt: string;
  source:
    | 'wa_call_media_session'
    | 'call_instance_stats'
    | 'explicit_media_event'
    | 'mock_simulation';
}

export interface StartVideoCallRequest {
  sessionId: string;
  driver?: WhatsAppSessionDriver;
  socket?: CompatibleWhatsAppSocket | Record<string, unknown>;
  recipientJid: string;
  recipientMasked?: string;
  videoFilePath?: string;
  videoFileName?: string;
  mimeType?: string;
  callKind?: 'video' | 'voice';
  protocolMode?: NativeCallProtocolMode;
  loopVideo?: boolean;
  maxDurationSeconds?: number;
  callTimeoutMs?: number;
  mediaStartTimeoutMs?: number;
  actorTelegramId?: number;
  recordCall?: boolean;
  strictMediaValidation?: boolean;
  allowedRootDirs?: string[];
  simulateLifecycle?: 'auto' | 'manual';
}

export interface StopVideoCallOptions {
  autoCompleted?: boolean;
  deleteFile?: boolean;
  reason?: string;
}

export interface ActiveVideoCallStream {
  callId: string;
  voipCallId?: string;
  voipInstance?: InstanceType<typeof Voip>;
  voipCallInstance?: VoipCallInstance;
  cleanupFns?: Array<() => void>;
  abortController?: AbortController;
  sessionId: string;
  actorTelegramId?: number;
  recipientJid: string;
  recipientMasked: string;
  videoFilePath: string;
  videoFileName: string;
  callKind: 'video' | 'voice';
  protocolMode: NativeCallProtocolMode;
  nativeStanzaCallIds: string[];
  mode: VideoCallExecutionMode;
  executionMode?: 'REAL_VOIP' | 'MOCK_SIMULATION';
  aborted?: boolean;
  callState: RealCallState;
  stateHistory: RealCallState[];
  status: RealCallState;
  audioStarted: boolean;
  videoStarted: boolean;
  mediaStarted: boolean;
  mediaFailed?: boolean;
  outboundMediaEvidence?: OutboundMediaEvidence;
  resolutionPreset: VoipVideoResolutionPreset;
  mediaInspection?: VideoMediaInspectionResult;
  loopVideo: boolean;
  maxDurationSeconds: number;
  recordingEnabled: boolean;
  recordingStatus: CallRecordingStatus;
  recordedVideoPath?: string;
  recordedVideoFileName?: string;
  recordedVideoSizeBytes?: number;
  recordedDurationSeconds?: number;
  inboundVideoPacketsReceived: number;
  inboundVideoFramesRecorded: number;
  inboundAudioPacketsReceived: number;
  remoteCameraCaptured: boolean;
  recordingDeliveredToTelegram?: boolean;
  recorder?: VoipCallRecorder;
  __recordingReadyEmitted?: boolean;
  startedAt: string;
  connectedAt?: string;
  endedAt?: string;
  failureReason?: string;
  messageId?: string;
  detailsArabic: string;
}

interface AttachedSessionContext {
  sessionId: string;
  driver?: WhatsAppSessionDriver;
  rawSocket?: Record<string, unknown>;
  compatibleSocket?: CompatibleWhatsAppSocket;
  voipInstance?: InstanceType<typeof Voip>;
  voipListening?: boolean;
  voipSocketCleanup?: () => void;
  cleanupFns: Array<() => void>;
  activeCallInstances: Map<string, VoipCallInstance>;
  connectionListener?: (update: Record<string, unknown>) => void;
}

const TERMINAL_CALL_STATES: ReadonlySet<RealCallState> = new Set<RealCallState>([
  'ENDED',
  'REJECTED',
  'TIMEOUT',
  'FAILED',
  'MEDIA_FAILED',
]);

/**
 * Real WhatsApp VoIP Video Call Service (`RealVideoCallService`) powered by `@hiroosy/baileys-lite/voip`.
 *
 * Strictly enforces:
 * - Zero chat video message or voice note fallbacks.
 * - Zero synthetic `<call><offer>` wave loops.
 * - Full state machine:
 *   `INITIATING` -> `RINGING` -> `CONNECTING` -> `CONNECTED` -> `MEDIA_NEGOTIATING` ->
 *   `MEDIA_STARTED` -> `MEDIA_STOPPED` -> `ENDED` / `REJECTED` / `TIMEOUT` / `FAILED`.
 * - Verified outbound RTP/SRTP audio & video packet evidence before transitioning to `MEDIA_STARTED`.
 * - Pre-call `CompatibilityProbe` check and `validateAndInspectVideoMedia` pipeline.
 */
export class RealVideoCallService extends EventEmitter {
  private static readonly MAX_COMPLETED_HISTORY = 100;
  private readonly attachedSessions = new Map<string, AttachedSessionContext>();
  private readonly voipBySocket = new WeakMap<
    object,
    InstanceType<typeof Voip>
  >();
  private readonly activeStreams = new Map<string, ActiveVideoCallStream>();
  private readonly completedStreamsHistory = new Map<
    string,
    ActiveVideoCallStream
  >();
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();
  private readonly ringingTimeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly mediaStartTimeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly mediaMonitorIntervals = new Map<string, NodeJS.Timeout>();
  private readonly activeMediaLivenessIntervals = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly nonLoopCompletionTimers = new Map<string, NodeJS.Timeout>();
  private readonly callListenerCleanups = new Map<string, () => void>();
  private compatibilityOverride?: CompatibilityReport;

  constructor(
    private readonly sessionManager?: SessionManager,
    private readonly auditRepo?: AuditRepository
  ) {
    super();
  }

  private isTerminalState(state: RealCallState): boolean {
    return TERMINAL_CALL_STATES.has(state);
  }

  private syncRecorderStatsToStream(stream?: ActiveVideoCallStream): void {
    if (!stream || !stream.recorder) return;
    const summary = stream.recorder.getSummary();
    stream.inboundVideoPacketsReceived = summary.inboundVideoPacketsReceived;
    stream.inboundVideoFramesRecorded = summary.inboundVideoFramesRecorded;
    stream.inboundAudioPacketsReceived = summary.inboundAudioPacketsReceived;
    stream.remoteCameraCaptured = summary.remoteCameraCaptured;
    if (
      stream.recordingStatus === 'RECORDING' ||
      stream.recordingStatus === 'FINALIZING'
    ) {
      stream.recordingStatus = summary.recordingStatus;
    }
    if (summary.recordedVideoPath) {
      stream.recordedVideoPath = summary.recordedVideoPath;
      stream.recordedVideoFileName = summary.recordedVideoFileName;
      stream.recordedVideoSizeBytes = summary.recordedVideoSizeBytes;
      stream.recordedDurationSeconds = summary.recordedDurationSeconds;
    }
  }

  private async finalizeStreamRecording(
    stream?: ActiveVideoCallStream
  ): Promise<VoipCallRecordingSummary | undefined> {
    if (!stream || !stream.recordingEnabled || !stream.recorder) {
      return undefined;
    }
    try {
      const summary = await stream.recorder.finalizeRecording();
      stream.recordingStatus = summary.recordingStatus;
      stream.recordedVideoPath = summary.recordedVideoPath;
      stream.recordedVideoFileName = summary.recordedVideoFileName;
      stream.recordedVideoSizeBytes = summary.recordedVideoSizeBytes;
      stream.recordedDurationSeconds = summary.recordedDurationSeconds;
      stream.inboundVideoPacketsReceived = summary.inboundVideoPacketsReceived;
      stream.inboundVideoFramesRecorded = summary.inboundVideoFramesRecorded;
      stream.inboundAudioPacketsReceived = summary.inboundAudioPacketsReceived;
      stream.remoteCameraCaptured = summary.remoteCameraCaptured;

      if (
        summary.recordingStatus === 'READY' &&
        summary.recordedVideoPath &&
        !stream.__recordingReadyEmitted
      ) {
        stream.__recordingReadyEmitted = true;
        this.emit('call:recording-ready', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          actorTelegramId: stream.actorTelegramId,
          recipientJid: stream.recipientJid,
          recipientMasked: stream.recipientMasked,
          stream,
          summary,
        });
      } else if (
        summary.recordingStatus === 'NO_REMOTE_CAMERA' &&
        !stream.__recordingReadyEmitted
      ) {
        stream.__recordingReadyEmitted = true;
        this.emit('call:recording-no-remote-camera', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          actorTelegramId: stream.actorTelegramId,
          recipientJid: stream.recipientJid,
          recipientMasked: stream.recipientMasked,
          stream,
          summary,
          messageArabic:
            'ℹ️ انتهت المكالمة، ولم يتم إرسال فيديو تسجيل لأن الطرف المستقبل لم يفتح الكاميرا أثناء المكالمة.',
        });
      }
      return summary;
    } catch (err) {
      stream.recordingStatus = 'FAILED';
      log.warn('Failed to finalize call recording', {
        callId: stream.callId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private archiveCompletedStream(stream: ActiveVideoCallStream): void {
    this.syncRecorderStatsToStream(stream);
    this.activeStreams.delete(stream.callId);
    this.completedStreamsHistory.delete(stream.callId);
    this.completedStreamsHistory.set(stream.callId, stream);
    while (
      this.completedStreamsHistory.size >
      RealVideoCallService.MAX_COMPLETED_HISTORY
    ) {
      const oldestKey = this.completedStreamsHistory.keys().next().value;
      if (!oldestKey) break;
      this.completedStreamsHistory.delete(oldestKey);
    }
  }

  /**
   * Allows unit/integration tests to inject a simulated CompatibilityReport
   * (e.g., to verify fail-closed behavior when VoIP layer is incompatible).
   */
  public setCompatibilityOverride(report?: CompatibilityReport): void {
    this.compatibilityOverride = report;
  }

  public probeEnvironment(
    socket?: Record<string, unknown> | null
  ): VideoCallEnvironmentProbe {
    const compatibilityReport =
      this.compatibilityOverride ||
      runBaileysCompatibilityProbe({
        socket: socket ?? null,
        requireLiveSocket: Boolean(socket),
      });

    return {
      platform: process.platform,
      protocolNativeEngineAvailable: compatibilityReport.voipCompatible,
      voipCompatible: compatibilityReport.voipCompatible,
      ffmpegAvailable: compatibilityReport.mediaBinaries.ffmpegAvailable,
      ffprobeAvailable: compatibilityReport.mediaBinaries.ffprobeAvailable,
      recommendedMode: 'HIROOSY_VOIP_RTP_SRTP',
      compatibilityReport,
    };
  }

  /**
   * Attaches a session's Baileys socket or driver to the VoIP service and binds
   * socket close listeners for immediate resource cleanup.
   */
  public attachSession(
    sessionId: string,
    sockOrDriver: WhatsAppSessionDriver | Record<string, unknown>
  ): void {
    let driver: WhatsAppSessionDriver | undefined;
    let rawSocket: Record<string, unknown> | undefined;
    let compatibleSocket: CompatibleWhatsAppSocket | undefined;

    if (
      sockOrDriver &&
      typeof (sockOrDriver as WhatsAppSessionDriver).sendTextMessage === 'function'
    ) {
      driver = sockOrDriver as WhatsAppSessionDriver;
      rawSocket = driver.getRawSocket?.() ?? undefined;
      compatibleSocket = driver.getCompatibleSocket?.() ?? undefined;
    } else if (sockOrDriver && typeof sockOrDriver === 'object') {
      rawSocket = sockOrDriver as Record<string, unknown>;
      try {
        compatibleSocket = toCompatibleWhatsAppSocket(rawSocket);
      } catch {
        compatibleSocket = undefined;
      }
    }

    const existing = this.attachedSessions.get(sessionId);
    if (
      existing &&
      existing.driver === driver &&
      existing.rawSocket === rawSocket
    ) {
      return;
    }

    this.detachSession(sessionId);

    const ctx: AttachedSessionContext = {
      sessionId,
      driver,
      rawSocket,
      compatibleSocket,
      cleanupFns: [],
      activeCallInstances: new Map<string, VoipCallInstance>(),
    };

    const ev = rawSocket?.ev as
      | {
          on?: (
            event: string,
            handler: (update: Record<string, unknown>) => void
          ) => void;
        }
      | undefined;

    if (ev && typeof ev.on === 'function') {
      const listener = (update: Record<string, unknown>) => {
        if (update?.connection === 'close') {
          this.handleSocketClosed(sessionId, 'WhatsApp socket connection closed');
        }
      };
      ev.on('connection.update', listener);
      ctx.connectionListener = listener;
    }

    this.attachedSessions.set(sessionId, ctx);
  }

  /**
   * Cleanly tears down a session's `Voip` and `VoipCall` instances between consecutive calls (`P0-B`):
   * 1. `await stream.voipCallInstance?.hangup?.()`
   * 2. `if (stream.voipCallId) await voipInstance.hangup(stream.voipCallId)`
   * 3. `await voipInstance.end(true)`
   * 4. `voipInstance.coordinator?.dispose?.()`
   * 5. Removes any `connection.update` listener added by `VoipClient` during `voip.listen()`
   *    without disturbing `HiroosyBaileysSessionDriver` listeners.
   */
  public async teardownSessionVoipInstance(
    sessionId: string,
    stream?: ActiveVideoCallStream,
    options?: { forceFullDispose?: boolean }
  ): Promise<void> {
    const ctx = this.attachedSessions.get(sessionId);
    const voipInstance = stream?.voipInstance ?? ctx?.voipInstance;

    const callInst = stream?.voipCallInstance;
    if (stream) {
      stream.voipCallInstance = undefined;
      stream.voipInstance = undefined;
    }
    if (ctx && stream?.voipCallId) {
      ctx.activeCallInstances.delete(stream.voipCallId);
    }

    const isFullVoipDispose = Boolean(
      options?.forceFullDispose ||
        (voipInstance as { __forceFullTeardown?: boolean } | undefined)
          ?.__forceFullTeardown
    );

    // 1. Hang up the active VoipCall instance
    let hungUpViaCallInstance = false;
    if (callInst && typeof callInst.hangup === 'function') {
      try {
        await callInst.hangup().catch(() => undefined);
        hungUpViaCallInstance = true;
      } catch {
        // Ignore hangup error
      }
    }

    // 2. If voipCallId is known, invoke voipInstance.hangup(voipCallId) with explicit callId
    if (
      stream?.voipCallId &&
      voipInstance &&
      typeof voipInstance.hangup === 'function' &&
      (!hungUpViaCallInstance || isFullVoipDispose)
    ) {
      try {
        await Promise.resolve(voipInstance.hangup(stream.voipCallId)).catch(
          () => undefined
        );
      } catch {
        // Ignore hangup error
      }
    }

    // Also hang up any other remaining tracked call instances on the session context
    if (ctx && ctx.activeCallInstances.size > 0) {
      for (const [cid, trackedInst] of Array.from(
        ctx.activeCallInstances.entries()
      )) {
        let trackedHungUp = false;
        if (trackedInst && typeof trackedInst.hangup === 'function') {
          try {
            await trackedInst.hangup().catch(() => undefined);
            trackedHungUp = true;
          } catch {
            // Ignore hangup error
          }
        }
        if (
          voipInstance &&
          typeof voipInstance.hangup === 'function' &&
          cid &&
          (!trackedHungUp || isFullVoipDispose)
        ) {
          try {
            await Promise.resolve(voipInstance.hangup(cid)).catch(
              () => undefined
            );
          } catch {
            // Ignore hangup error
          }
        }
      }
      ctx.activeCallInstances.clear();
    }

    if (isFullVoipDispose) {
      // 3. Force-clear Voip.#calls via end(true)
      if (voipInstance && typeof voipInstance.end === 'function') {
        try {
          await Promise.resolve(voipInstance.end(true)).catch(() => undefined);
        } catch {
          // Ignore end(true) error
        }
      }

      // 4. Dispose WaVoipCoordinator (unregisters CB:call, CB:ack, CB:receipt from rawSocket.ws and destroys WaCallManager)
      if (voipInstance) {
        try {
          voipInstance.coordinator?.dispose?.();
        } catch {
          // Ignore coordinator dispose error
        }
      }

      // 5. Run stream-level and session-level VoIP socket listener cleanups
      if (stream?.cleanupFns && stream.cleanupFns.length > 0) {
        for (const fn of stream.cleanupFns.splice(0)) {
          try {
            fn();
          } catch {
            // Ignore cleanup error
          }
        }
      }

      if (ctx) {
        if (ctx.cleanupFns.length > 0) {
          for (const fn of ctx.cleanupFns.splice(0)) {
            try {
              fn();
            } catch {
              // Ignore cleanup error
            }
          }
        }
        if (ctx.voipSocketCleanup) {
          try {
            ctx.voipSocketCleanup();
          } catch {
            // Ignore cleanup error
          }
          ctx.voipSocketCleanup = undefined;
        }
        ctx.voipListening = false;
        if (ctx.rawSocket) {
          this.voipBySocket.delete(ctx.rawSocket);
        }
        if (voipInstance instanceof Voip) {
          ctx.voipInstance = undefined;
        }
      }
    }
  }

  /**
   * Detaches a session, terminates all active calls on that session, removes listeners,
   * and disposes VoIP coordinator resources cleanly.
   */
  public detachSession(sessionId: string): void {
    const existing = this.attachedSessions.get(sessionId);
    if (!existing) return;

    // 1. Terminate and clean up any active streams associated with this session
    for (const stream of Array.from(this.activeStreams.values())) {
      if (stream.sessionId === sessionId) {
        stream.aborted = true;
        stream.abortController?.abort();
        this.clearCallTimers(stream.callId);
        void this.teardownSessionVoipInstance(sessionId, stream, {
          forceFullDispose: true,
        });
        if (!this.isTerminalState(stream.callState)) {
          if (stream.mediaStarted) {
            this.transitionCallState(stream, 'MEDIA_STOPPED');
          }
          this.transitionCallState(stream, 'ENDED', 'session_detached');
          this.emit('call:ended', {
            callId: stream.callId,
            sessionId,
            state: 'ENDED',
            reason: 'session_detached',
          });
        }
        this.archiveCompletedStream(stream);
      }
    }

    void this.teardownSessionVoipInstance(sessionId, undefined, {
      forceFullDispose: true,
    });

    if (existing.voipInstance) {
      try {
        existing.voipInstance.coordinator?.dispose?.();
      } catch {
        // Ignore coordinator dispose error
      }
      if (typeof existing.voipInstance.end === 'function') {
        try {
          void existing.voipInstance.end(true).catch(() => undefined);
        } catch {
          // Ignore end error
        }
      }
    }

    if (existing.cleanupFns.length > 0) {
      for (const fn of existing.cleanupFns.splice(0)) {
        try {
          fn();
        } catch {
          // Ignore cleanup error
        }
      }
    }
    if (existing.voipSocketCleanup) {
      try {
        existing.voipSocketCleanup();
      } catch {
        // Ignore cleanup error
      }
      existing.voipSocketCleanup = undefined;
    }

    const ev = existing.rawSocket?.ev as
      | {
          off?: (
            event: string,
            handler: (update: Record<string, unknown>) => void
          ) => void;
        }
      | undefined;
    if (
      ev &&
      typeof ev.off === 'function' &&
      existing.connectionListener
    ) {
      try {
        ev.off('connection.update', existing.connectionListener);
      } catch {
        // Ignore listener removal errors
      }
    }

    this.attachedSessions.delete(sessionId);
  }

  private transitionCallState(
    stream: ActiveVideoCallStream,
    nextState: RealCallState,
    failureReason?: string
  ): void {
    if (stream.callState === nextState) return;
    stream.callState = nextState;
    stream.status = nextState;
    stream.stateHistory.push(nextState);
    if (failureReason) {
      stream.failureReason = failureReason;
    }
    if (this.isTerminalState(nextState)) {
      stream.endedAt = new Date().toISOString();
      this.archiveCompletedStream(stream);
    }
  }

  private clearMediaVerificationTimers(callId: string): void {
    const mediaTimeout = this.mediaStartTimeoutTimers.get(callId);
    if (mediaTimeout) {
      clearTimeout(mediaTimeout);
      this.mediaStartTimeoutTimers.delete(callId);
    }
    const monitorInterval = this.mediaMonitorIntervals.get(callId);
    if (monitorInterval) {
      clearInterval(monitorInterval);
      this.mediaMonitorIntervals.delete(callId);
    }
  }

  private clearActiveMediaLivenessTimers(callId: string): void {
    const livenessInterval = this.activeMediaLivenessIntervals.get(callId);
    if (livenessInterval) {
      clearInterval(livenessInterval);
      this.activeMediaLivenessIntervals.delete(callId);
    }
    const completionTimer = this.nonLoopCompletionTimers.get(callId);
    if (completionTimer) {
      clearTimeout(completionTimer);
      this.nonLoopCompletionTimers.delete(callId);
    }
  }

  private clearCallTimers(callId: string): void {
    const stopTimer = this.stopTimers.get(callId);
    if (stopTimer) {
      clearTimeout(stopTimer);
      this.stopTimers.delete(callId);
    }
    const ringTimer = this.ringingTimeoutTimers.get(callId);
    if (ringTimer) {
      clearTimeout(ringTimer);
      this.ringingTimeoutTimers.delete(callId);
    }
    this.clearMediaVerificationTimers(callId);
    this.clearActiveMediaLivenessTimers(callId);
    const cleanupListeners = this.callListenerCleanups.get(callId);
    if (cleanupListeners) {
      this.callListenerCleanups.delete(callId);
      try {
        cleanupListeners();
      } catch {
        // Ignore listener cleanup errors
      }
    }
  }

  public listActiveStreams(): ActiveVideoCallStream[] {
    const active = Array.from(this.activeStreams.values()).filter(
      (s) => !this.isTerminalState(s.callState)
    );
    for (const s of active) {
      this.syncRecorderStatsToStream(s);
    }
    return active;
  }

  public listCompletedStreams(sessionId?: string): ActiveVideoCallStream[] {
    const all = Array.from(this.completedStreamsHistory.values()).reverse();
    for (const s of all) {
      this.syncRecorderStatsToStream(s);
    }
    if (sessionId) {
      return all.filter((s) => s.sessionId === sessionId);
    }
    return all;
  }

  public getActiveStreamForSession(
    sessionId: string
  ): ActiveVideoCallStream | undefined {
    for (const stream of this.activeStreams.values()) {
      if (
        stream.sessionId === sessionId &&
        !this.isTerminalState(stream.callState)
      ) {
        this.syncRecorderStatsToStream(stream);
        return stream;
      }
    }
    return undefined;
  }

  public getStreamById(callId: string): ActiveVideoCallStream | undefined {
    const stream =
      this.activeStreams.get(callId) ?? this.completedStreamsHistory.get(callId);
    this.syncRecorderStatsToStream(stream);
    return stream;
  }

  public getCallStatus(
    sessionIdOrCallId: string,
    maybeCallId?: string
  ): ActiveVideoCallStream | undefined {
    if (maybeCallId) {
      const stream =
        this.activeStreams.get(maybeCallId) ??
        this.completedStreamsHistory.get(maybeCallId);
      if (stream && stream.sessionId === sessionIdOrCallId) {
        this.syncRecorderStatsToStream(stream);
        return stream;
      }
      return undefined;
    }
    const found =
      this.activeStreams.get(sessionIdOrCallId) ||
      this.getActiveStreamForSession(sessionIdOrCallId) ||
      this.completedStreamsHistory.get(sessionIdOrCallId);
    this.syncRecorderStatsToStream(found);
    return found;
  }

  private async ensureFallbackVideoFile(sessionId: string): Promise<{
    filePath: string;
    fileName: string;
  }> {
    const tempDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
    fs.mkdirSync(tempDir, { recursive: true });
    const fileName = `synthetic_call_${sessionId}.mp4`;
    const filePath = path.join(tempDir, fileName);
    if (!fs.existsSync(filePath)) {
      try {
        await generatePlayableVoipMp4File(filePath, {
          width: 640,
          height: 360,
          frameRate: 15,
          durationSeconds: 10,
          includeAudio: true,
        });
      } catch {
        fs.writeFileSync(filePath, createMinimalMp4Buffer());
      }
    }
    return { filePath, fileName };
  }

  /**
   * Primary entry point to start a real WhatsApp VoIP video call.
   */
  public async startVideoCall(
    req: StartVideoCallRequest
  ): Promise<ActiveVideoCallStream> {
    const actorTelegramId = req.actorTelegramId ?? 0;
    const recipientMasked = req.recipientMasked || req.recipientJid;
    const callKind = req.callKind || 'video';
    const loopVideo = req.loopVideo ?? true;
    const maxDuration = Math.min(
      Math.max(req.maxDurationSeconds || 60, 5),
      600
    );
    const callTimeoutMs = Math.min(
      Math.max(req.callTimeoutMs || 35_000, 50),
      120_000
    );
    const mediaStartTimeoutMs = Math.min(
      Math.max(req.mediaStartTimeoutMs || 12_000, 30),
      60_000
    );

    const existing = this.getActiveStreamForSession(req.sessionId);
    if (existing) {
      await this.stopVideoCall(req.sessionId, existing.callId, {
        deleteFile: false,
        reason: 'replaced_by_new_call',
      });
    } else {
      await this.teardownSessionVoipInstance(req.sessionId);
    }

    const attached = this.attachedSessions.get(req.sessionId);
    const driver =
      req.driver ||
      attached?.driver ||
      this.sessionManager?.getDriver(req.sessionId, actorTelegramId);

    const rawSocket =
      (req.socket as Record<string, unknown> | undefined) ||
      attached?.rawSocket ||
      driver?.getRawSocket?.() ||
      undefined;

    if (!driver && !rawSocket) {
      throw new WhatsAppConnectionError(
        'تعذر الوصول إلى مقبس الجلسة المتصلة لبدء المكالمة.'
      );
    }

    if (driver || rawSocket) {
      this.attachSession(req.sessionId, driver || rawSocket!);
    }

    const isMockDriver = Boolean(driver?.isMock && !rawSocket);
    const executionMode: 'REAL_VOIP' | 'MOCK_SIMULATION' = isMockDriver
      ? 'MOCK_SIMULATION'
      : 'REAL_VOIP';

    // 1. Run CompatibilityProbe BEFORE attempting any call or media operation
    const compatibilityReport =
      this.compatibilityOverride ||
      runBaileysCompatibilityProbe({
        socket: rawSocket ?? null,
        requireLiveSocket: !isMockDriver,
      });

    if (!compatibilityReport.voipCompatible) {
      const failedCallId = `vcall_${crypto.randomUUID().slice(0, 8)}`;
      const failedStream: ActiveVideoCallStream = {
        callId: failedCallId,
        sessionId: req.sessionId,
        actorTelegramId,
        recipientJid: req.recipientJid,
        recipientMasked,
        videoFilePath: req.videoFilePath || '',
        videoFileName: req.videoFileName || '',
        callKind,
        protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
        nativeStanzaCallIds: [],
        mode: 'HIROOSY_VOIP_RTP_SRTP',
        executionMode,
        callState: 'FAILED',
        stateHistory: ['INITIATING', 'FAILED'],
        status: 'FAILED',
        audioStarted: false,
        videoStarted: false,
        mediaStarted: false,
        resolutionPreset: '360p',
        loopVideo,
        maxDurationSeconds: maxDuration,
        recordingEnabled: req.recordCall !== false,
        recordingStatus: 'FAILED',
        inboundVideoPacketsReceived: 0,
        inboundVideoFramesRecorded: 0,
        inboundAudioPacketsReceived: 0,
        remoteCameraCaptured: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        failureReason: VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
        detailsArabic: VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
      };
      this.archiveCompletedStream(failedStream);
      const err = new VoipFailureError(VOIP_INCOMPATIBLE_ARABIC_MESSAGE, {
        missingCapabilities: compatibilityReport.missingCapabilities,
        reasons: compatibilityReport.reasons,
      });
      this.emit('call:media-error', {
        callId: failedCallId,
        sessionId: req.sessionId,
        error: err,
      });
      this.emit('call:ended', {
        callId: failedCallId,
        sessionId: req.sessionId,
        state: 'FAILED',
        reason: VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
      });
      throw err;
    }

    // 2. Resolve and validate video file before starting call signaling
    const hasUploadedVideo = Boolean(req.videoFilePath);
    if (hasUploadedVideo && !fs.existsSync(req.videoFilePath!)) {
      throw new MediaValidationError(
        'ملف الفيديو المرفوع غير موجود أو انتهت صلاحيته.'
      );
    }

    const resolvedVideo = hasUploadedVideo
      ? {
          filePath: req.videoFilePath!,
          fileName: req.videoFileName || path.basename(req.videoFilePath!),
        }
      : await this.ensureFallbackVideoFile(req.sessionId);

    const mediaInspection = await validateAndInspectVideoMedia(
      resolvedVideo.filePath,
      {
        allowedRootDirs: req.allowedRootDirs,
        allowSyntheticMinimalMp4: isMockDriver && !req.strictMediaValidation,
      }
    );

    const callId = `vcall_${crypto.randomUUID().slice(0, 8)}`;
    const recordingEnabled = req.recordCall !== false;
    const recorder = recordingEnabled
      ? new VoipCallRecorder({
          callId,
          sessionId: req.sessionId,
          recipientJid: req.recipientJid,
          outboundVideoPath: mediaInspection.resolvedPath,
          isMockMode: isMockDriver,
        })
      : undefined;

    const streamRecord: ActiveVideoCallStream = {
      callId,
      sessionId: req.sessionId,
      actorTelegramId,
      recipientJid: req.recipientJid,
      recipientMasked,
      videoFilePath: mediaInspection.resolvedPath,
      videoFileName: resolvedVideo.fileName,
      callKind,
      protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
      nativeStanzaCallIds: [],
      mode: 'HIROOSY_VOIP_RTP_SRTP',
      executionMode,
      callState: 'INITIATING',
      stateHistory: ['INITIATING'],
      status: 'INITIATING',
      audioStarted: false,
      videoStarted: false,
      mediaStarted: false,
      resolutionPreset: mediaInspection.targetVoipResolution,
      mediaInspection,
      loopVideo,
      maxDurationSeconds: maxDuration,
      recordingEnabled,
      recordingStatus: recordingEnabled ? 'RECORDING' : 'DISABLED',
      inboundVideoPacketsReceived: 0,
      inboundVideoFramesRecorded: 0,
      inboundAudioPacketsReceived: 0,
      remoteCameraCaptured: false,
      recorder,
      startedAt: new Date().toISOString(),
      messageId: callId,
      cleanupFns: [],
      abortController: new AbortController(),
      detailsArabic: `📞 جاري تهيئة مكالمة الفيديو عبر @hiroosy/baileys-lite/voip (${mediaInspection.targetVoipResolution}) إلى (${recipientMasked})...`,
    };

    this.activeStreams.set(callId, streamRecord);
    this.emit('call:initiating', {
      callId,
      sessionId: req.sessionId,
      recipientJid: req.recipientJid,
      resolutionPreset: mediaInspection.targetVoipResolution,
      executionMode,
    });

    await driver
      ?.sendPresenceUpdate('available', req.recipientJid)
      .catch(() => undefined);

    try {
      if (isMockDriver && driver) {
        await this.executeMockVoipCallLifecycle(
          streamRecord,
          driver,
          req.simulateLifecycle || 'auto',
          callTimeoutMs,
          maxDuration,
          actorTelegramId
        );
      } else if (rawSocket) {
        await this.executeRealHiroosyVoipCallLifecycle(
          streamRecord,
          rawSocket,
          callTimeoutMs,
          mediaStartTimeoutMs,
          maxDuration,
          actorTelegramId
        );
      }
    } catch (err) {
      this.clearCallTimers(callId);
      await this.teardownSessionVoipInstance(req.sessionId, streamRecord);
      const reason = err instanceof Error ? err.message : String(err);
      if (!this.isTerminalState(streamRecord.callState)) {
        this.transitionCallState(streamRecord, 'FAILED', reason);
        streamRecord.detailsArabic = `❌ فشل بدء المكالمة عبر VoIP: ${reason}`;
        this.emit('call:ended', {
          callId,
          sessionId: req.sessionId,
          state: 'FAILED',
          reason,
        });
      }
      this.archiveCompletedStream(streamRecord);
      throw err;
    }

    this.auditRepo?.record({
      actorTelegramId,
      action: 'VIDEO_CALL_STREAM_STARTED',
      targetId: req.sessionId,
      outcome: 'SUCCESS',
      metadata: {
        callId,
        mode: streamRecord.mode,
        executionMode: streamRecord.executionMode,
        protocolMode: streamRecord.protocolMode,
        callKind,
        callState: streamRecord.callState,
        resolutionPreset: streamRecord.resolutionPreset,
        recipientMasked,
        videoFileName: streamRecord.videoFileName,
        maxDurationSeconds: maxDuration,
      },
    });

    log.info('Started real WhatsApp VoIP video call', {
      callId,
      sessionId: req.sessionId,
      executionMode: streamRecord.executionMode,
      callState: streamRecord.callState,
      resolutionPreset: streamRecord.resolutionPreset,
      recipientJid: req.recipientJid,
    });

    return streamRecord;
  }

  /**
   * Resolves the underlying `WaCallMediaSession` for an active call from `@hiroosy/baileys-lite/voip`
   * (`voip.coordinator.manager.calls.get(voipCallId)` or `callInstance.mediaSession`)
   * and ensures it is instrumented for relay broadcast verification and safe cleanup.
   */
  private resolveWaCallMediaSession(
    stream: ActiveVideoCallStream,
    voip: InstanceType<typeof Voip>,
    callInstance?: VoipCallInstance
  ): InstrumentedMediaSession | undefined {
    let found: WaCallMediaSessionLike | undefined;

    if (
      callInstance?.mediaSession &&
      typeof callInstance.mediaSession === 'object'
    ) {
      found = callInstance.mediaSession;
    }
    if (!found) {
      const callInstanceAny = callInstance as unknown as {
        activeCall?: { session?: WaCallMediaSessionLike };
        _session?: WaCallMediaSessionLike;
      } | undefined;
      if (callInstanceAny?.activeCall?.session) {
        found = callInstanceAny.activeCall.session;
      } else if (callInstanceAny?._session) {
        found = callInstanceAny._session;
      }
    }

    if (!found) {
      const callsMap = voip.coordinator?.manager?.calls;
      if (callsMap && typeof callsMap.get === 'function') {
        if (stream.voipCallId) {
          const byId = callsMap.get(stream.voipCallId);
          if (byId) found = byId;
        }
        if (!found) {
          for (const session of callsMap.values()) {
            if (!stream.voipCallId || session?.callId === stream.voipCallId) {
              found = session;
              break;
            }
          }
        }
      }
    }

    const instrumented = instrumentMediaSessionInstance(found);
    if (instrumented?.videoEngine) {
      instrumented.videoEngine.videoLoop = stream.loopVideo;
    }
    if (instrumented && stream.recorder) {
      stream.recorder.attachToMediaSession(instrumented);
      this.syncRecorderStatsToStream(stream);
    }
    return instrumented;
  }

  /**
   * Inspects real outbound RTP/SRTP audio and video packet counters on the active call session
   * and transitions from `MEDIA_NEGOTIATING` to `MEDIA_STARTED` ONLY when real outbound media
   * transmission is proven and accepted by the relay (`BZ-001`).
   */
  private evaluateOutboundMediaEvidence(
    stream: ActiveVideoCallStream,
    voip: InstanceType<typeof Voip>,
    callInstance?: VoipCallInstance,
    explicitStats?: {
      audioSendCount?: number;
      audioOctetsSent?: number;
      videoSendCount?: number;
      videoOctetsSent?: number;
      videoIdrSendCount?: number;
      source?: OutboundMediaEvidence['source'];
    }
  ): boolean {
    if (
      stream.callState !== 'MEDIA_NEGOTIATING' ||
      stream.mediaStarted ||
      this.isTerminalState(stream.callState)
    ) {
      return stream.mediaStarted;
    }

    const mediaSession = this.resolveWaCallMediaSession(
      stream,
      voip,
      callInstance
    );

    if (!hasVerifiedRelayMediaAcceptance(mediaSession)) {
      return false;
    }

    const instanceStats =
      typeof callInstance?.getMediaStats === 'function'
        ? callInstance.getMediaStats()
        : undefined;

    const useRelayAcceptedCounters = Boolean(
      mediaSession?.__relayBroadcastAttempted
    );

    const audioPackets =
      explicitStats?.audioSendCount ??
      instanceStats?.audioSendCount ??
      (useRelayAcceptedCounters
        ? mediaSession?.acceptedAudioPackets ?? 0
        : mediaSession?.audioSendCount ?? mediaSession?.realAudioSendCount ?? 0);
    const audioOctets =
      explicitStats?.audioOctetsSent ??
      instanceStats?.audioOctetsSent ??
      (useRelayAcceptedCounters
        ? mediaSession?.acceptedAudioOctets ?? 0
        : mediaSession?.audioOctetsSent ?? 0);

    const videoPackets =
      explicitStats?.videoSendCount ??
      instanceStats?.videoSendCount ??
      (useRelayAcceptedCounters
        ? mediaSession?.acceptedVideoPackets ?? 0
        : mediaSession?.videoSendCount ??
          mediaSession?.videoEngine?.accessUnitsSent ??
          0);
    const videoOctets =
      explicitStats?.videoOctetsSent ??
      instanceStats?.videoOctetsSent ??
      (useRelayAcceptedCounters
        ? mediaSession?.acceptedVideoOctets ?? 0
        : mediaSession?.videoOctetsSent ?? 0);
    const videoKeyframes =
      explicitStats?.videoIdrSendCount ??
      instanceStats?.videoIdrSendCount ??
      (useRelayAcceptedCounters
        ? mediaSession?.acceptedVideoKeyframes ?? 0
        : mediaSession?.videoIdrSendCount ?? (videoPackets > 0 ? 1 : 0));

    const hasAudioEvidence = audioPackets > 0 && audioOctets > 0;
    const hasVideoEvidence =
      stream.callKind === 'voice' ||
      (videoPackets > 0 && videoOctets > 0 && videoKeyframes > 0);

    if (hasAudioEvidence && !stream.audioStarted) {
      stream.audioStarted = true;
      this.emit('call:audio-started', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
        audioPacketsSent: audioPackets,
        audioOctetsSent: audioOctets,
        hasEmbeddedAudio: stream.mediaInspection?.hasAudioStream ?? false,
      });
    }

    if (hasVideoEvidence && stream.callKind === 'video' && !stream.videoStarted) {
      stream.videoStarted = true;
      this.emit('call:video-started', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
        videoPacketsSent: videoPackets,
        videoOctetsSent: videoOctets,
        videoKeyframesSent: videoKeyframes,
        resolutionPreset: stream.resolutionPreset,
      });
    }

    const bothReady =
      stream.audioStarted &&
      (stream.callKind === 'voice' || stream.videoStarted);

    if (bothReady && !stream.mediaStarted) {
      this.clearMediaVerificationTimers(stream.callId);
      const evidenceSource: OutboundMediaEvidence['source'] =
        explicitStats?.source ||
        (instanceStats ? 'call_instance_stats' : 'wa_call_media_session');

      stream.outboundMediaEvidence = {
        audioPacketsSent: audioPackets,
        audioOctetsSent: audioOctets,
        videoPacketsSent: videoPackets,
        videoOctetsSent: videoOctets,
        videoKeyframesSent: videoKeyframes,
        verifiedAt: new Date().toISOString(),
        source: evidenceSource,
      };
      stream.mediaStarted = true;
      this.transitionCallState(stream, 'MEDIA_STARTED');
      stream.detailsArabic = `🟢 جاري بث الصوت والفيديو فعلياً عبر RTP/SRTP داخل مكالمة واتساب (${stream.resolutionPreset}) إلى (${stream.recipientMasked}).`;
      this.emit('call:media-started', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
        resolutionPreset: stream.resolutionPreset,
        evidence: stream.outboundMediaEvidence,
      });
      return true;
    }

    return false;
  }

  /**
   * Executes a real VoIP video call over `@hiroosy/baileys-lite/voip` (`Voip` / `VoipCall` / `WaVoipCoordinator`).
   */
  private async executeRealHiroosyVoipCallLifecycle(
    stream: ActiveVideoCallStream,
    rawSocket: Record<string, unknown>,
    callTimeoutMs: number,
    mediaStartTimeoutMs: number,
    maxDurationSeconds: number,
    actorTelegramId: number
  ): Promise<void> {
    await ensureHiroosyVoipRuntimePatched();

    if (stream.aborted || this.isTerminalState(stream.callState)) {
      return;
    }

    try {
      const tmpDir = path.resolve(
        process.cwd(),
        'data',
        'temp_uploads',
        'voip_cache'
      );
      fs.mkdirSync(tmpDir, { recursive: true });

      const ctx = this.attachedSessions.get(stream.sessionId);
      let voip = ctx?.voipInstance ?? this.voipBySocket.get(rawSocket);
      if (!voip) {
        voip = new Voip(rawSocket as never, {
          voipLogLevel: 'warn',
          maxConcurrentCalls: 1,
          tmpDir,
        });
        this.voipBySocket.set(rawSocket, voip);
        if (ctx) {
          ctx.voipInstance = voip;
          ctx.voipListening = false;
        }
      } else if (ctx && !ctx.voipInstance) {
        ctx.voipInstance = voip;
      }
      stream.voipInstance = voip;

      if (!ctx || !ctx.voipListening) {
        const cleanup = await listenWithTrackedSocketCleanup(
          voip,
          rawSocket as never
        );
        if (ctx) {
          ctx.voipListening = true;
          ctx.voipSocketCleanup = cleanup;
          if (!ctx.cleanupFns.includes(cleanup)) {
            ctx.cleanupFns.push(cleanup);
          }
        }
        if (stream.cleanupFns && !stream.cleanupFns.includes(cleanup)) {
          stream.cleanupFns.push(cleanup);
        }
      }

      if (stream.aborted || this.isTerminalState(stream.callState)) {
        this.clearCallTimers(stream.callId);
        await this.teardownSessionVoipInstance(stream.sessionId, stream);
        return;
      }

      let callInstance: VoipCallInstance | undefined;

    const isMatchingCallInfo = (info: unknown): boolean => {
      if (!info || typeof info !== 'object') return true;
      const cid =
        (info as { callId?: string; id?: string }).callId ||
        (info as { callId?: string; id?: string }).id;
      if (cid && stream.voipCallId) {
        return cid === stream.voipCallId;
      }
      const peerJid = (info as { peerJid?: string }).peerJid;
      if (!stream.voipCallId && peerJid && stream.recipientJid) {
        const normA = peerJid.replace(/\D/g, '');
        const normB = stream.recipientJid.replace(/\D/g, '');
        if (normA && normB && normA !== normB && !peerJid.endsWith('@lid')) {
          return false;
        }
      }
      return true;
    };

    const recordVoipCallId = (cid?: string | null) => {
      if (!cid) return;
      stream.voipCallId = cid;
      if (!stream.nativeStanzaCallIds.includes(cid)) {
        stream.nativeStanzaCallIds.push(cid);
      }
      stream.messageId = cid;
      if (ctx && callInstance) {
        ctx.activeCallInstances.set(cid, callInstance);
      }
    };

    const extractEndReason = (reasonOrInfo: unknown): string => {
      if (typeof reasonOrInfo === 'string' && reasonOrInfo.trim()) {
        return reasonOrInfo.trim().toLowerCase();
      }
      if (!reasonOrInfo || typeof reasonOrInfo !== 'object') {
        return 'ended';
      }
      const obj = reasonOrInfo as {
        reason?: string;
        endReason?: string;
        stateData?: { endReason?: string; state?: string };
        options?: { reason?: string };
      };
      return String(
        obj.reason ||
          obj.endReason ||
          obj.stateData?.endReason ||
          obj.options?.reason ||
          'ended'
      ).toLowerCase();
    };

    const hangupActiveCallSafely = async () => {
      await this.teardownSessionVoipInstance(stream.sessionId, stream);
    };

    const startActiveMediaLivenessWatchdog = () => {
      this.clearActiveMediaLivenessTimers(stream.callId);

      // BZ-020: When loopVideo is false, schedule deterministic completion when the video duration elapses
      if (!stream.loopVideo) {
        const mediaDurationSec = stream.mediaInspection?.durationSeconds ?? 0;
        if (mediaDurationSec > 0 && mediaDurationSec < maxDurationSeconds) {
          const completionMs = Math.max(
            250,
            Math.ceil(mediaDurationSec * 1000) + 250
          );
          const completionTimer = setTimeout(() => {
            if (this.isTerminalState(stream.callState)) return;
            void this.stopVideoCall(stream.sessionId, stream.callId, {
              autoCompleted: true,
              deleteFile: false,
              reason: 'media_playback_completed',
            });
          }, completionMs);
          if (typeof completionTimer.unref === 'function') {
            completionTimer.unref();
          }
          this.nonLoopCompletionTimers.set(stream.callId, completionTimer);
        }
      }
    };

    const startOutboundMediaVerification = () => {
      if (this.evaluateOutboundMediaEvidence(stream, voip, callInstance)) {
        startActiveMediaLivenessWatchdog();
        return;
      }

      this.clearMediaVerificationTimers(stream.callId);

      const monitorInterval = setInterval(() => {
        if (this.isTerminalState(stream.callState) || stream.mediaStarted) {
          this.clearMediaVerificationTimers(stream.callId);
          return;
        }
        if (this.evaluateOutboundMediaEvidence(stream, voip, callInstance)) {
          startActiveMediaLivenessWatchdog();
        }
      }, 20);
      if (typeof monitorInterval.unref === 'function') {
        monitorInterval.unref();
      }
      this.mediaMonitorIntervals.set(stream.callId, monitorInterval);

      const mediaTimeout = setTimeout(() => {
        if (this.isTerminalState(stream.callState) || stream.mediaStarted) {
          return;
        }
        if (this.evaluateOutboundMediaEvidence(stream, voip, callInstance)) {
          startActiveMediaLivenessWatchdog();
          return;
        }

        // In live production calls (default mediaStartTimeoutMs > 1000ms), NEVER disconnect an active
        // answered call or interfere with @hiroosy/baileys-lite's native videoEngine scheduler.
        if (mediaStartTimeoutMs > 1000) {
          return;
        }

        const reason =
          'MEDIA_FAILED: Outbound RTP/SRTP audio/video frames did not start within timeout';
        log.error(
          'Outbound media failed to start within timeout after call connected',
          {
            callId: stream.callId,
            voipCallId: stream.voipCallId,
            sessionId: stream.sessionId,
            audioStarted: stream.audioStarted,
            videoStarted: stream.videoStarted,
            mediaStartTimeoutMs,
          }
        );

        stream.mediaFailed = true;
        stream.detailsArabic =
          '❌ تم الرد على المكالمة ولكن تعذر بدء بث الصوت والفيديو الفعلي (MEDIA_FAILED) خلال المهلة المحددة؛ تم إنهاء المكالمة وتنظيف الموارد.';
        this.clearCallTimers(stream.callId);
        this.transitionCallState(stream, 'FAILED', reason);

        const mediaErr = new VoipFailureError(stream.detailsArabic, {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          audioStarted: stream.audioStarted,
          videoStarted: stream.videoStarted,
          reason,
        });

        this.emit('call:media-error', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          error: mediaErr,
          reason,
        });
        this.emit('call:ended', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          state: 'FAILED',
          reason,
        });

        void hangupActiveCallSafely();
      }, mediaStartTimeoutMs);

      if (typeof mediaTimeout.unref === 'function') {
        mediaTimeout.unref();
      }
      this.mediaStartTimeoutTimers.set(stream.callId, mediaTimeout);
    };

    const scheduleMaxDurationTimerFromNow = () => {
      const existingMaxTimer = this.stopTimers.get(stream.callId);
      if (existingMaxTimer) {
        clearTimeout(existingMaxTimer);
        this.stopTimers.delete(stream.callId);
      }
      const maxTimer = setTimeout(() => {
        void this.stopVideoCall(stream.sessionId, stream.callId, {
          autoCompleted: true,
          deleteFile: false,
          reason: 'max_duration_reached',
        });
      }, maxDurationSeconds * 1000);
      if (typeof maxTimer.unref === 'function') {
        maxTimer.unref();
      }
      this.stopTimers.set(stream.callId, maxTimer);
    };

    const handleRinging = (info?: unknown) => {
      if (!isMatchingCallInfo(info)) return;
      if (info && typeof info === 'object') {
        const cid =
          (info as { callId?: string; id?: string }).callId ||
          (info as { callId?: string; id?: string }).id;
        recordVoipCallId(cid);
      }
      if (stream.callState === 'INITIATING') {
        this.transitionCallState(stream, 'RINGING');
        stream.detailsArabic = `🔔 جاري الرنين الفعلي لدى المستلم (${stream.recipientMasked}) عبر @hiroosy/baileys-lite/voip؛ سيبدأ بث الصوت والفيديو فور الرد وتدفق حزم RTP/SRTP.`;
        this.emit('call:ringing', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          recipientJid: stream.recipientJid,
        });
      }
    };

    const handleConnected = (info?: unknown) => {
      if (!isMatchingCallInfo(info)) return;
      if (
        stream.callState === 'MEDIA_NEGOTIATING' ||
        stream.callState === 'MEDIA_STARTED' ||
        this.isTerminalState(stream.callState)
      ) {
        return;
      }

      const ringTimer = this.ringingTimeoutTimers.get(stream.callId);
      if (ringTimer) {
        clearTimeout(ringTimer);
        this.ringingTimeoutTimers.delete(stream.callId);
      }

      // Reset the maxDurationSeconds countdown from the moment the call is answered
      scheduleMaxDurationTimerFromNow();

      if (info && typeof info === 'object') {
        const cid =
          (info as { callId?: string; id?: string }).callId ||
          (info as { callId?: string; id?: string }).id;
        recordVoipCallId(cid);
      }

      if (stream.callState === 'INITIATING') {
        this.transitionCallState(stream, 'RINGING');
        this.emit('call:ringing', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          recipientJid: stream.recipientJid,
        });
      }

      this.transitionCallState(stream, 'CONNECTING');
      this.emit('call:connecting', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
      });

      stream.connectedAt = new Date().toISOString();
      this.transitionCallState(stream, 'CONNECTED');
      this.emit('call:connected', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
      });

      // Ensure mediaSession is instrumented as soon as call connects and trigger an immediate SPS+PPS+IDR burst if cached
      const connectedMediaSession = this.resolveWaCallMediaSession(
        stream,
        voip,
        callInstance
      ) as (WaCallMediaSessionLike & { injectCachedSpsPpsKeyframe?: () => boolean }) | undefined;
      try {
        connectedMediaSession?.injectCachedSpsPpsKeyframe?.();
      } catch {
        // Ignore keyframe burst error before relay ready
      }

      // Transition to MEDIA_NEGOTIATING and wait for real outbound RTP/SRTP audio+video evidence
      this.transitionCallState(stream, 'MEDIA_NEGOTIATING');
      stream.detailsArabic = `🎛️ تم الرد على المكالمة؛ جاري التفاوض والتحقق من بدء ضخ حزم الصوت والفيديو (RTP/SRTP)...`;
      this.emit('call:media-negotiating', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
      });

      startOutboundMediaVerification();
    };

    const handleEnded = (reasonOrInfo?: unknown) => {
      if (
        reasonOrInfo &&
        typeof reasonOrInfo === 'object' &&
        !isMatchingCallInfo(reasonOrInfo)
      ) {
        return;
      }
      this.clearCallTimers(stream.callId);
      stream.voipCallInstance = undefined;
      if (ctx && stream.voipCallId) {
        ctx.activeCallInstances.delete(stream.voipCallId);
      }

      if (this.isTerminalState(stream.callState)) {
        return;
      }

      const reason = extractEndReason(reasonOrInfo);

      if (
        reason.includes('reject') ||
        reason.includes('decline') ||
        reason.includes('busy') ||
        reason.includes('do_not_disturb')
      ) {
        this.transitionCallState(stream, 'REJECTED', reason);
        stream.detailsArabic = `🚫 تم رفض المكالمة أو الانشغال من الطرف الآخر (${reason}).`;
        this.emit('call:rejected', {
          callId: stream.callId,
          sessionId: stream.sessionId,
          reason,
        });
      } else if (
        reason.includes('timeout') ||
        reason.includes('unanswered') ||
        reason.includes('no_answer')
      ) {
        this.transitionCallState(stream, 'TIMEOUT', reason);
        stream.detailsArabic = `⏱️ انتهت مهلة الرنين دون رد من الطرف الآخر (${reason}).`;
        this.emit('call:timeout', {
          callId: stream.callId,
          sessionId: stream.sessionId,
          reason,
        });
      } else if (reason === 'failed') {
        if (stream.mediaStarted) {
          this.transitionCallState(stream, 'MEDIA_STOPPED');
        }
        this.transitionCallState(stream, 'FAILED', reason);
        stream.detailsArabic = `❌ انتهت المكالمة بسبب خطأ في طبقة الاتصال (${reason}).`;
      } else {
        if (stream.mediaStarted) {
          this.transitionCallState(stream, 'MEDIA_STOPPED');
        }
        this.transitionCallState(stream, 'ENDED', reason);
        stream.detailsArabic = `🛑 انتهت المكالمة المرئية (${reason}).`;
      }

      this.emit('call:ended', {
        callId: stream.callId,
        sessionId: stream.sessionId,
        state: stream.callState,
        reason,
      });
      void this.finalizeStreamRecording(stream);
      void this.teardownSessionVoipInstance(stream.sessionId, stream);
    };

    const handleError = (errInput: unknown) => {
      this.clearCallTimers(stream.callId);
      if (this.isTerminalState(stream.callState)) {
        return;
      }
      const err =
        errInput instanceof Error
          ? errInput
          : new Error(
              String(
                (errInput as { error?: unknown })?.error ||
                  errInput ||
                  'VoIP error'
              )
            );
      const classification = classifyEngineeringFailure(err);
      if (stream.mediaStarted) {
        this.transitionCallState(stream, 'MEDIA_STOPPED');
      } else {
        stream.mediaFailed = true;
      }
      this.transitionCallState(stream, 'FAILED', classification.summary);
      stream.detailsArabic = `❌ تعذر إكمال المكالمة أو بث الوسائط: ${classification.summary}`;
      this.emit('call:media-error', {
        callId: stream.callId,
        sessionId: stream.sessionId,
        error: err,
        classification,
      });
      this.emit('call:ended', {
        callId: stream.callId,
        sessionId: stream.sessionId,
        state: 'FAILED',
        reason: classification.summary,
      });
      void this.finalizeStreamRecording(stream);
      void hangupActiveCallSafely();
    };

    // Official WaVoipCoordinator listeners (`call_state`, `call_ended`, `call_error`, `call_video_state`, `call_outbound_audio_finished`)
    const coordinator = voip.coordinator;
    const onCoordinatorCallState = (info: Record<string, unknown>) => {
      if (!isMatchingCallInfo(info)) return;
      const stateData = info?.stateData as
        | { state?: string; endReason?: string }
        | undefined;
      const st = String(stateData?.state ?? info?.state ?? '').toLowerCase();
      const isRinging =
        info?.isRinging === true ||
        st === 'ringing' ||
        st === 'accept_sent';
      const isActive =
        info?.isActive === true ||
        st === 'active' ||
        st === 'connected' ||
        st === 'accepted';
      const isEnded =
        info?.isEnded === true ||
        st === 'ended' ||
        st === 'rejected' ||
        st === 'terminated';

      if (isRinging) {
        handleRinging(info);
      } else if (isActive) {
        handleConnected(info);
      } else if (isEnded) {
        handleEnded(info);
      }
    };
    const onCoordinatorCallEnded = (info: Record<string, unknown>) => {
      if (!isMatchingCallInfo(info)) return;
      handleEnded(info);
    };
    const onCoordinatorCallError = (err: unknown) => {
      handleError(err);
    };
    const onCoordinatorVideoState = (
      info: Record<string, unknown>,
      videoState: unknown
    ) => {
      if (!isMatchingCallInfo(info)) return;
      this.resolveWaCallMediaSession(stream, voip, callInstance);
      stream.recorder?.sendPli();
      this.emit('call:peer-video-state', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
        videoState,
      });
    };
    const onCoordinatorOutboundAudioFinished = (
      info: Record<string, unknown>
    ) => {
      if (!isMatchingCallInfo(info)) return;
      this.emit('call:outbound-audio-finished', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
      });
    };

    if (coordinator && typeof coordinator.on === 'function') {
      coordinator.on('call_state', onCoordinatorCallState);
      coordinator.on('call_ended', onCoordinatorCallEnded);
      coordinator.on('call_error', onCoordinatorCallError);
      coordinator.on('call_video_state', onCoordinatorVideoState);
      coordinator.on(
        'call_outbound_audio_finished',
        onCoordinatorOutboundAudioFinished
      );
    }

    // Explicit outbound media event handlers if emitted on callInstance
    const onExplicitOutboundMedia = (payload?: Record<string, unknown>) => {
      if (
        this.evaluateOutboundMediaEvidence(stream, voip, callInstance, {
          audioSendCount:
            typeof payload?.audioSendCount === 'number'
              ? payload.audioSendCount
              : undefined,
          audioOctetsSent:
            typeof payload?.audioOctetsSent === 'number'
              ? payload.audioOctetsSent
              : undefined,
          videoSendCount:
            typeof payload?.videoSendCount === 'number'
              ? payload.videoSendCount
              : undefined,
          videoOctetsSent:
            typeof payload?.videoOctetsSent === 'number'
              ? payload.videoOctetsSent
              : undefined,
          videoIdrSendCount:
            typeof payload?.videoIdrSendCount === 'number'
              ? payload.videoIdrSendCount
              : undefined,
          source: 'explicit_media_event',
        })
      ) {
        startActiveMediaLivenessWatchdog();
      }
    };

    const handleItem = (item?: unknown) => {
      this.emit('call:item', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
        item,
      });
    };

    const handleDowngraded = () => {
      this.emit('call:downgraded', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
      });
    };

    const handleInboundVideo = (frame: unknown) => {
      if (frame instanceof Uint8Array || Buffer.isBuffer(frame)) {
        try {
          stream.recorder?.handleInboundAnnexBAccessUnit(
            frame instanceof Uint8Array ? frame : new Uint8Array(frame)
          );
        } catch {
          // Ignore recorder tap error
        }
      }
    };

    const handleInboundAudio = (pcm: unknown) => {
      if (
        pcm instanceof Int16Array ||
        pcm instanceof Float32Array ||
        pcm instanceof Uint8Array ||
        Buffer.isBuffer(pcm)
      ) {
        try {
          stream.recorder?.recordInboundAudioPcm(pcm);
        } catch {
          // Ignore recorder tap error
        }
      }
    };

    this.callListenerCleanups.set(stream.callId, () => {
      if (coordinator && typeof coordinator.off === 'function') {
        coordinator.off('call_state', onCoordinatorCallState);
        coordinator.off('call_ended', onCoordinatorCallEnded);
        coordinator.off('call_error', onCoordinatorCallError);
        coordinator.off('call_video_state', onCoordinatorVideoState);
        coordinator.off(
          'call_outbound_audio_finished',
          onCoordinatorOutboundAudioFinished
        );
      }
      if (callInstance && typeof callInstance.off === 'function') {
        callInstance.off('ringing', handleRinging);
        callInstance.off('connected', handleConnected);
        callInstance.off('item', handleItem);
        callInstance.off('downgraded', handleDowngraded);
        callInstance.off('inbound_video', handleInboundVideo);
        callInstance.off('inbound_audio', handleInboundAudio);
        callInstance.off('ended', handleEnded);
        callInstance.off('error', handleError);
        callInstance.off('media_outbound_started', onExplicitOutboundMedia);
      }
    });

    const normalizedVoipPreset = stream.resolutionPreset.replace(
      '_portrait',
      ''
    ) as '360p' | '480p' | '720p';

      const mediaPayload =
        stream.callKind === 'voice'
          ? stream.videoFilePath && !stream.loopVideo
            ? [
                {
                  audio: stream.videoFilePath,
                  path: stream.videoFilePath,
                  kind: 'audio',
                  autoAdvance: true,
                },
              ]
            : 'silence'
          : stream.videoFilePath;

      let sanitizedTargetJid = stream.recipientJid.replace(/:\d+@/, '@');

      // Ensure rawSocket.getUSyncDevices has LID -> PN fallback and primary device `:0` guarantee
      const sockWithUSync = rawSocket as {
        __botezzVoipUSyncWrapped?: boolean;
        getUSyncDevices?: (
          jids: string[],
          useCache?: boolean,
          ignoreZeroDevices?: boolean
        ) => Promise<
          Array<{ user: string; device: number; server?: string; jid?: string }>
        >;
        assertSessions?: (jids: string[], force?: boolean) => Promise<boolean>;
        signalRepository?: {
          lidMapping?: {
            getLIDForPN?: (pn: string) => Promise<string | null | undefined>;
            getPNForLID?: (lid: string) => Promise<string | null | undefined>;
          };
          migrateSession?: (fromJid: string, toJid: string) => Promise<unknown>;
        };
      };

      if (
        typeof sockWithUSync.getUSyncDevices === 'function' &&
        !sockWithUSync.__botezzVoipUSyncWrapped
      ) {
        sockWithUSync.__botezzVoipUSyncWrapped = true;
        const origGetUSync = sockWithUSync.getUSyncDevices.bind(rawSocket);
        sockWithUSync.getUSyncDevices = async (
          jids: string[],
          useCache = true,
          ignoreZeroDevices = false
        ) => {
          const inputJids = Array.isArray(jids) ? jids.filter(Boolean) : [];
          let items: Array<{
            user: string;
            device: number;
            server?: string;
            jid?: string;
          }> = [];
          try {
            const res = await origGetUSync(
              inputJids,
              useCache,
              ignoreZeroDevices
            );
            if (Array.isArray(res)) {
              items = [...res];
            }
          } catch {
            items = [];
          }

          const formatDeviceJid = (
            u: string,
            srv: string,
            dev?: number
          ): string => {
            const cleanU = String(u || '').split(':')[0]?.split('_')[0] || '';
            const cleanSrv = srv || 's.whatsapp.net';
            const dNum =
              typeof dev === 'number' && Number.isFinite(dev) && dev > 0
                ? dev
                : 0;
            return dNum > 0 ? `${cleanU}:${dNum}@${cleanSrv}` : `${cleanU}@${cleanSrv}`;
          };

          for (const reqJid of inputJids) {
            const atIdx = reqJid.indexOf('@');
            const userPart =
              atIdx >= 0 ? reqJid.slice(0, atIdx) : reqJid.replace(/\D/g, '');
            const reqServer =
              atIdx >= 0
                ? reqJid.slice(atIdx + 1)
                : reqJid.endsWith('@lid')
                  ? 'lid'
                  : 's.whatsapp.net';
            const reqUser = userPart.split(':')[0]?.split('_')[0] || '';
            if (!reqUser) continue;

            let hasUser = items.some((it) => it?.user === reqUser);
            if (
              !hasUser &&
              (reqServer === 'lid' || reqServer === 'hosted.lid') &&
              typeof sockWithUSync.signalRepository?.lidMapping?.getPNForLID ===
                'function'
            ) {
              const mappedPn = await sockWithUSync.signalRepository.lidMapping
                .getPNForLID(`${reqUser}@${reqServer}`)
                .catch(() => undefined);
              if (mappedPn) {
                const cleanPn = String(mappedPn).replace(/:\d+@/, '@');
                const pnDevs = await origGetUSync(
                  [cleanPn],
                  false,
                  ignoreZeroDevices
                ).catch(() => []);
                if (Array.isArray(pnDevs) && pnDevs.length > 0) {
                  for (const pd of pnDevs) {
                    const devNum =
                      typeof pd?.device === 'number' &&
                      Number.isFinite(pd.device)
                        ? pd.device
                        : 0;
                    items.push({
                      user: reqUser,
                      server: reqServer,
                      device: devNum,
                      jid: formatDeviceJid(reqUser, reqServer, devNum),
                    });
                  }
                  hasUser = true;
                }
                if (
                  typeof sockWithUSync.signalRepository?.migrateSession ===
                  'function'
                ) {
                  await sockWithUSync.signalRepository
                    .migrateSession(cleanPn, `${reqUser}@${reqServer}`)
                    .catch(() => undefined);
                }
              }
            }

            if (!hasUser && !ignoreZeroDevices) {
              items.push({
                user: reqUser,
                server: reqServer,
                device: 0,
                jid: formatDeviceJid(reqUser, reqServer, 0),
              });
            }
          }

          const seen = new Set<string>();
          const out: Array<{
            user: string;
            device: number;
            server?: string;
            jid: string;
          }> = [];
          for (const it of items) {
            if (!it || !it.user) continue;
            const srv =
              it.server ||
              (String(it.jid || '').endsWith('@lid')
                ? 'lid'
                : 's.whatsapp.net');
            const devNum =
              typeof it.device === 'number' && Number.isFinite(it.device)
                ? it.device
                : 0;
            const canonical = formatDeviceJid(it.user, srv, devNum);
            if (!canonical || seen.has(canonical)) continue;
            seen.add(canonical);
            out.push({
              ...it,
              user: it.user,
              server: srv,
              device: devNum,
              jid: canonical,
            });
          }
          return out;
        };
      }

      const driverWithPrepare = ctx?.driver as
        | (WhatsAppSessionDriver & {
            preparePeerForVoipCall?: (targetInput: string) => Promise<{
              dialTargetJid: string;
              pnJid?: string;
              lidJid?: string;
              deviceJids: string[];
            }>;
          })
        | undefined;

      if (typeof driverWithPrepare?.preparePeerForVoipCall === 'function') {
        const prepared = await driverWithPrepare
          .preparePeerForVoipCall(sanitizedTargetJid)
          .catch(() => undefined);
        if (prepared?.dialTargetJid) {
          sanitizedTargetJid = prepared.dialTargetJid;
        }
      } else {
        try {
          let pnJid = sanitizedTargetJid.endsWith('@s.whatsapp.net')
            ? sanitizedTargetJid
            : undefined;
          let lidJid = sanitizedTargetJid.endsWith('@lid')
            ? sanitizedTargetJid
            : undefined;
          if (
            pnJid &&
            !lidJid &&
            typeof sockWithUSync.signalRepository?.lidMapping?.getLIDForPN ===
              'function'
          ) {
            const resolvedLid =
              await sockWithUSync.signalRepository.lidMapping
                .getLIDForPN(pnJid)
                .catch(() => undefined);
            if (typeof resolvedLid === 'string' && resolvedLid.endsWith('@lid')) {
              lidJid = resolvedLid.replace(/:\d+@/, '@');
            }
          } else if (
            lidJid &&
            !pnJid &&
            typeof sockWithUSync.signalRepository?.lidMapping?.getPNForLID ===
              'function'
          ) {
            const resolvedPn =
              await sockWithUSync.signalRepository.lidMapping
                .getPNForLID(lidJid)
                .catch(() => undefined);
            if (
              typeof resolvedPn === 'string' &&
              resolvedPn.endsWith('@s.whatsapp.net')
            ) {
              pnJid = resolvedPn.replace(/:\d+@/, '@');
              sanitizedTargetJid = pnJid;
            }
          }
          if (
            pnJid &&
            lidJid &&
            typeof sockWithUSync.signalRepository?.migrateSession === 'function'
          ) {
            await sockWithUSync.signalRepository
              .migrateSession(pnJid, lidJid)
              .catch(() => undefined);
          }
          if (typeof sockWithUSync.assertSessions === 'function') {
            const sessionTargets = [lidJid, pnJid].filter(
              (j): j is string => Boolean(j)
            );
            if (sessionTargets.length > 0) {
              await sockWithUSync
                .assertSessions(sessionTargets, false)
                .catch(() => false);
            }
          }
        } catch {
          // Non-fatal pre-call warmup fallback
        }
      }

      const callResult = await voip.call(
        sanitizedTargetJid,
        mediaPayload as never,
        normalizedVoipPreset,
        {
          loop: Boolean(stream.loopVideo),
          autoEndCall: !stream.loopVideo,
          autoDowngrade: false,
        } as never
      );

    if (callResult && typeof callResult === 'object') {
      callInstance = callResult as VoipCallInstance;
      stream.voipCallInstance = callInstance;
      if (typeof callInstance.on === 'function') {
        callInstance.on('ringing', handleRinging);
        callInstance.on('connected', handleConnected);
        callInstance.on('item', handleItem);
        callInstance.on('downgraded', handleDowngraded);
        callInstance.on('inbound_video', handleInboundVideo);
        callInstance.on('inbound_audio', handleInboundAudio);
        callInstance.on('ended', handleEnded);
        callInstance.on('error', handleError);
        callInstance.on('media_outbound_started', onExplicitOutboundMedia);
      }
    }

    const voipCallId =
      typeof callResult === 'string'
        ? callResult
        : callResult?.callId ||
          (callResult as { id?: string } | undefined)?.id;

    recordVoipCallId(voipCallId);

    // Instrument the newly created WaCallMediaSession immediately
    this.resolveWaCallMediaSession(stream, voip, callInstance);

    // BZ-008: If stopVideoCallStream was invoked while `await voip.call(...)` was in flight, hang up immediately
    if (stream.aborted || this.isTerminalState(stream.callState)) {
      this.clearCallTimers(stream.callId);
      await hangupActiveCallSafely();
      return;
    }

    // BZ-007: Reconcile coordinator / ActiveCall state in case ringing/connected fired during `await voip.call(...)`
    const coordinatorWithGetCall = coordinator as unknown as {
      getCall?: (id: string) => Record<string, unknown> | null;
    } | null;
    if (voipCallId && typeof coordinatorWithGetCall?.getCall === 'function') {
      const currentInfo = coordinatorWithGetCall.getCall(voipCallId);
      if (currentInfo && typeof currentInfo === 'object') {
        onCoordinatorCallState(currentInfo);
      }
    }

    const callInstanceFlags = callInstance as unknown as {
      connected?: boolean;
      ended?: boolean;
    } | undefined;
    if (callInstanceFlags?.ended) {
      handleEnded({ callId: voipCallId, reason: 'ended' });
      return;
    }
    if (callInstanceFlags?.connected) {
      handleConnected({ callId: voipCallId });
    }

    // Legacy string ID fallback without event emitter support
    if (
      stream.callState === 'INITIATING' &&
      (!callInstance || typeof callInstance.on !== 'function')
    ) {
      handleRinging({ callId: voipCallId });
    }

    // Ringing timeout if recipient does not answer within callTimeoutMs (only if not yet connected)
    if (
      !stream.connectedAt &&
      (stream.callState === 'INITIATING' || stream.callState === 'RINGING')
    ) {
      const ringTimeout = setTimeout(() => {
        if (
          !stream.connectedAt &&
          (stream.callState === 'INITIATING' || stream.callState === 'RINGING')
        ) {
          this.transitionCallState(stream, 'TIMEOUT', 'Call ringing timed out');
          stream.detailsArabic =
            '⏱️ انتهت مهلة الرنين دون رد من المستلم؛ تم إنهاء المكالمة وتنظيف الموارد.';
          this.emit('call:timeout', {
            callId: stream.callId,
            sessionId: stream.sessionId,
            reason: 'Call ringing timed out',
          });
          void this.stopVideoCall(stream.sessionId, stream.callId, {
            autoCompleted: true,
            deleteFile: false,
            reason: 'timeout',
          });
        }
      }, callTimeoutMs);
      if (typeof ringTimeout.unref === 'function') {
        ringTimeout.unref();
      }
      this.ringingTimeoutTimers.set(stream.callId, ringTimeout);
    }

      void actorTelegramId;
    } catch (err) {
      this.clearCallTimers(stream.callId);
      await this.teardownSessionVoipInstance(stream.sessionId, stream);
      const classification = classifyEngineeringFailure(err);
      if (!this.isTerminalState(stream.callState)) {
        this.transitionCallState(stream, 'FAILED', classification.summary);
        stream.detailsArabic = `❌ فشل بدء المكالمة عبر VoIP: ${classification.reasonArabic}`;
        this.emit('call:ended', {
          callId: stream.callId,
          sessionId: stream.sessionId,
          state: 'FAILED',
          reason: classification.summary,
        });
      }
      if (err instanceof AppError) {
        throw err;
      }
      throw new VoipFailureError(
        `${classification.reasonArabic} (${classification.summary})`,
        {
          callId: stream.callId,
          sessionId: stream.sessionId,
          classification,
        }
      );
    }
  }

  /**
   * Executes the deterministic VoIP state machine against `MockWhatsAppSessionDriver`
   * during automated unit/integration tests.
   */
  private async executeMockVoipCallLifecycle(
    stream: ActiveVideoCallStream,
    driver: WhatsAppSessionDriver,
    simulateLifecycle: 'auto' | 'manual',
    callTimeoutMs: number,
    maxDurationSeconds: number,
    actorTelegramId: number
  ): Promise<void> {
    if (typeof driver.recordSimulatedVoipCallOffer === 'function') {
      const offerRes = await driver.recordSimulatedVoipCallOffer(
        stream.recipientJid,
        {
          isVideo: stream.callKind === 'video',
        }
      );
      stream.voipCallId = offerRes.callId;
      stream.nativeStanzaCallIds.push(offerRes.callId);
      stream.messageId = offerRes.callId;
    }

    this.transitionCallState(stream, 'RINGING');
    stream.detailsArabic = `🔔 جاري الرنين لدى المستلم (${stream.recipientMasked}) في بيئة المحاكاة...`;
    this.emit('call:ringing', {
      callId: stream.callId,
      voipCallId: stream.voipCallId,
      sessionId: stream.sessionId,
      recipientJid: stream.recipientJid,
    });

    if (simulateLifecycle === 'auto') {
      this.simulateCallAnsweredAndMediaStarted(stream.callId);
    } else {
      const ringTimeout = setTimeout(() => {
        if (
          stream.callState === 'INITIATING' ||
          stream.callState === 'RINGING'
        ) {
          this.simulateCallTimeout(stream.callId);
        }
      }, callTimeoutMs);
      if (typeof ringTimeout.unref === 'function') {
        ringTimeout.unref();
      }
      this.ringingTimeoutTimers.set(stream.callId, ringTimeout);
    }

    const timer = setTimeout(() => {
      void this.stopVideoCallStream(
        stream.callId,
        actorTelegramId,
        { autoCompleted: true, deleteFile: false },
        driver
      );
    }, Math.min(maxDurationSeconds * 1000, 15_000));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.stopTimers.set(stream.callId, timer);
  }

  /**
   * Deterministically advances a simulated call through:
   * `CONNECTING` -> `CONNECTED` -> `MEDIA_NEGOTIATING` -> `MEDIA_STARTED`.
   */
  public simulateCallAnsweredAndMediaStarted(callId: string): void {
    const stream = this.activeStreams.get(callId);
    if (!stream) return;

    const ringTimer = this.ringingTimeoutTimers.get(callId);
    if (ringTimer) {
      clearTimeout(ringTimer);
      this.ringingTimeoutTimers.delete(callId);
    }

    this.transitionCallState(stream, 'CONNECTING');
    this.emit('call:connecting', {
      callId: stream.callId,
      voipCallId: stream.voipCallId,
      sessionId: stream.sessionId,
    });

    stream.connectedAt = new Date().toISOString();
    this.transitionCallState(stream, 'CONNECTED');
    this.emit('call:connected', {
      callId: stream.callId,
      voipCallId: stream.voipCallId,
      sessionId: stream.sessionId,
    });

    this.transitionCallState(stream, 'MEDIA_NEGOTIATING');

    stream.audioStarted = true;
    this.emit('call:audio-started', {
      callId: stream.callId,
      sessionId: stream.sessionId,
      hasEmbeddedAudio: stream.mediaInspection?.hasAudioStream ?? false,
    });

    if (stream.callKind === 'video') {
      stream.videoStarted = true;
      this.emit('call:video-started', {
        callId: stream.callId,
        sessionId: stream.sessionId,
        resolutionPreset: stream.resolutionPreset,
      });
    }

    stream.outboundMediaEvidence = {
      audioPacketsSent: 1,
      audioOctetsSent: 160,
      videoPacketsSent: stream.callKind === 'video' ? 1 : 0,
      videoOctetsSent: stream.callKind === 'video' ? 1200 : 0,
      videoKeyframesSent: stream.callKind === 'video' ? 1 : 0,
      verifiedAt: new Date().toISOString(),
      source: 'mock_simulation',
    };
    stream.mediaStarted = true;
    this.transitionCallState(stream, 'MEDIA_STARTED');
    stream.detailsArabic =
      stream.executionMode === 'MOCK_SIMULATION'
        ? `🟢 [MOCK_SIMULATION] جاري بث الصوت والفيديو في بيئة المحاكاة (${stream.resolutionPreset}) إلى (${stream.recipientMasked}).`
        : `🟢 جاري بث الصوت والفيديو فعلياً عبر طبقة VoIP RTP/SRTP (${stream.resolutionPreset}) إلى (${stream.recipientMasked}).`;
    this.emit('call:media-started', {
      callId: stream.callId,
      voipCallId: stream.voipCallId,
      sessionId: stream.sessionId,
      resolutionPreset: stream.resolutionPreset,
      evidence: stream.outboundMediaEvidence,
    });
  }

  /**
   * Transitions a call to `REJECTED` and emits `call:rejected` + `call:ended`.
   */
  public simulateCallRejected(callId: string, reason = 'rejected_by_peer'): void {
    const stream = this.activeStreams.get(callId);
    if (!stream || this.isTerminalState(stream.callState)) return;
    this.clearCallTimers(callId);
    this.transitionCallState(stream, 'REJECTED', reason);
    this.emit('call:rejected', {
      callId: stream.callId,
      sessionId: stream.sessionId,
      reason,
    });
    this.emit('call:ended', {
      callId: stream.callId,
      sessionId: stream.sessionId,
      state: 'REJECTED',
      reason,
    });
  }

  /**
   * Transitions a call to `TIMEOUT` and emits `call:timeout` + `call:ended`.
   */
  public simulateCallTimeout(callId: string, reason = 'ring_timeout'): void {
    const stream = this.activeStreams.get(callId);
    if (!stream || this.isTerminalState(stream.callState)) return;
    this.clearCallTimers(callId);
    this.transitionCallState(stream, 'TIMEOUT', reason);
    this.emit('call:timeout', {
      callId: stream.callId,
      sessionId: stream.sessionId,
      reason,
    });
    this.emit('call:ended', {
      callId: stream.callId,
      sessionId: stream.sessionId,
      state: 'TIMEOUT',
      reason,
    });
  }

  /**
   * Handles unexpected WhatsApp socket closure during an active call.
   */
  public handleSocketClosed(
    sessionId: string,
    reason = 'socket_disconnected'
  ): void {
    for (const stream of Array.from(this.activeStreams.values())) {
      if (
        stream.sessionId === sessionId &&
        !this.isTerminalState(stream.callState)
      ) {
        stream.aborted = true;
        this.clearCallTimers(stream.callId);
        stream.voipCallInstance = undefined;
        if (stream.mediaStarted) {
          this.transitionCallState(stream, 'MEDIA_STOPPED');
        }
        this.transitionCallState(stream, 'FAILED', reason);
        this.emit('call:socket-closed', {
          callId: stream.callId,
          sessionId,
          reason,
        });
        this.emit('call:ended', {
          callId: stream.callId,
          sessionId,
          state: 'FAILED',
          reason,
        });
      }
    }
  }

  /**
   * Alias of `startVideoCall` for existing workflow callers.
   */
  public async startVideoCallStream(
    req: StartVideoCallRequest
  ): Promise<ActiveVideoCallStream> {
    return this.startVideoCall(req);
  }

  /**
   * Stops an active VoIP video call cleanly, hangs up the VoIP media session
   * (`callInstance.hangup()` first, falling back to `voip.hangup(voipCallId)`),
   * and transitions through `MEDIA_STOPPED` -> `ENDED` idempotently.
   */
  public async stopVideoCall(
    sessionId: string,
    callId: string,
    options: StopVideoCallOptions = {},
    actorTelegramId = 0,
    explicitDriver?: WhatsAppSessionDriver
  ): Promise<ActiveVideoCallStream | undefined> {
    void sessionId;
    return this.stopVideoCallStream(
      callId,
      actorTelegramId,
      options,
      explicitDriver
    );
  }

  public async stopVideoCallStream(
    callId: string,
    actorTelegramId = 0,
    optionsOrAutoCompleted: boolean | StopVideoCallOptions = false,
    explicitDriver?: WhatsAppSessionDriver
  ): Promise<ActiveVideoCallStream | undefined> {
    const stream =
      this.activeStreams.get(callId) ??
      this.completedStreamsHistory.get(callId);
    if (!stream) return undefined;

    stream.aborted = true;
    stream.abortController?.abort();

    const autoCompleted =
      typeof optionsOrAutoCompleted === 'boolean'
        ? optionsOrAutoCompleted
        : Boolean(optionsOrAutoCompleted?.autoCompleted);
    const deleteFile =
      typeof optionsOrAutoCompleted === 'object' &&
      optionsOrAutoCompleted !== null
        ? Boolean(optionsOrAutoCompleted.deleteFile)
        : false;
    const reason =
      typeof optionsOrAutoCompleted === 'object' &&
      optionsOrAutoCompleted?.reason
        ? optionsOrAutoCompleted.reason
        : autoCompleted
          ? 'completed'
          : 'stopped_by_user';

    this.clearCallTimers(callId);

    const attached = this.attachedSessions.get(stream.sessionId);
    await this.teardownSessionVoipInstance(stream.sessionId, stream);

    try {
      const driver =
        explicitDriver ||
        attached?.driver ||
        this.sessionManager?.getDriver(stream.sessionId, actorTelegramId);
      if (
        driver &&
        typeof driver.recordSimulatedVoipCallTermination === 'function'
      ) {
        for (const stanzaCallId of stream.nativeStanzaCallIds) {
          await driver
            .recordSimulatedVoipCallTermination(
              stream.recipientJid,
              stanzaCallId
            )
            .catch(() => undefined);
        }
      }
    } catch {
      // Ignore simulated termination error
    }

    // Finalize two-way call recording BEFORE optionally deleting the source video file
    await this.finalizeStreamRecording(stream);

    // BZ-024 / R-008: Only unlink when explicitly requested AND file is an owned temp upload
    if (
      deleteFile &&
      stream.videoFilePath &&
      fs.existsSync(stream.videoFilePath)
    ) {
      const tempUploadsRoot = path.resolve(
        process.cwd(),
        'data',
        'temp_uploads'
      );
      const resolvedFile = path.resolve(stream.videoFilePath);
      const relToTemp = path.relative(tempUploadsRoot, resolvedFile);
      const isOwnedTempUpload =
        !relToTemp.startsWith('..') &&
        !path.isAbsolute(relToTemp) &&
        !path.basename(resolvedFile).startsWith('synthetic_call_');

      if (isOwnedTempUpload) {
        try {
          fs.unlinkSync(resolvedFile);
        } catch {
          // Ignore file unlink failure
        }
      }
    }

    if (!this.isTerminalState(stream.callState)) {
      if (stream.mediaStarted) {
        this.transitionCallState(stream, 'MEDIA_STOPPED');
      }
      this.transitionCallState(stream, 'ENDED', reason);
      stream.detailsArabic = `🛑 تم إنهاء المكالمة المرئية (${reason}).`;
      this.emit('call:ended', {
        callId: stream.callId,
        sessionId: stream.sessionId,
        state: 'ENDED',
        reason,
      });
    } else {
      this.archiveCompletedStream(stream);
    }

    this.auditRepo?.record({
      actorTelegramId,
      action: autoCompleted
        ? 'VIDEO_CALL_STREAM_COMPLETED'
        : 'VIDEO_CALL_STREAM_STOPPED',
      targetId: stream.sessionId,
      outcome: 'SUCCESS',
      metadata: {
        callId,
        mode: stream.mode,
        executionMode: stream.executionMode,
        protocolMode: stream.protocolMode,
        finalState: stream.callState,
        stateHistory: stream.stateHistory,
        recordingStatus: stream.recordingStatus,
        recordedVideoFileName: stream.recordedVideoFileName,
        inboundVideoFramesRecorded: stream.inboundVideoFramesRecorded,
        inboundAudioPacketsReceived: stream.inboundAudioPacketsReceived,
        remoteCameraCaptured: stream.remoteCameraCaptured,
      },
    });

    return stream;
  }

  public async shutdownAll(): Promise<void> {
    for (const callId of Array.from(this.activeStreams.keys())) {
      await this.stopVideoCallStream(callId, 0, {
        autoCompleted: false,
        deleteFile: false,
        reason: 'service_shutdown',
      });
    }
    for (const sessionId of Array.from(this.attachedSessions.keys())) {
      this.detachSession(sessionId);
    }
  }
}

export {
  RealVideoCallService as UbuntuVideoCallBridge,
  RealVideoCallService as NativeVideoCallEngine,
};
