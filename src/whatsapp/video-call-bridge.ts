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
import { createMinimalMp4Buffer } from '../function-lab/media-sticker-toolkit';
import {
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
  voipCallInstance?: VoipCallInstance;
  sessionId: string;
  recipientJid: string;
  recipientMasked: string;
  videoFilePath: string;
  videoFileName: string;
  callKind: 'video' | 'voice';
  protocolMode: NativeCallProtocolMode;
  nativeStanzaCallIds: string[];
  mode: VideoCallExecutionMode;
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
  private readonly attachedSessions = new Map<string, AttachedSessionContext>();
  private readonly activeStreams = new Map<string, ActiveVideoCallStream>();
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();
  private readonly ringingTimeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly mediaStartTimeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly mediaMonitorIntervals = new Map<string, NodeJS.Timeout>();
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
   * Detaches a session, terminates all active calls on that session, removes listeners,
   * and disposes VoIP coordinator resources cleanly.
   */
  public detachSession(sessionId: string): void {
    const existing = this.attachedSessions.get(sessionId);
    if (!existing) return;

    // 1. Terminate and clean up any active streams associated with this session
    for (const stream of this.activeStreams.values()) {
      if (stream.sessionId === sessionId) {
        this.clearCallTimers(stream.callId);
        const callInst = stream.voipCallInstance;
        stream.voipCallInstance = undefined;
        if (callInst && typeof callInst.hangup === 'function') {
          try {
            void callInst.hangup().catch(() => undefined);
          } catch {
            // Ignore hangup error on detach
          }
        } else if (
          existing.voipInstance &&
          typeof existing.voipInstance.hangup === 'function' &&
          stream.voipCallId
        ) {
          try {
            void existing.voipInstance.hangup(stream.voipCallId).catch(() => undefined);
          } catch {
            // Ignore fallback hangup error on detach
          }
        }
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
      }
    }

    // 2. Hang up any remaining tracked VoipCallInstance objects on the session context
    for (const callInst of existing.activeCallInstances.values()) {
      if (typeof callInst.hangup === 'function') {
        try {
          void callInst.hangup().catch(() => undefined);
        } catch {
          // Ignore hangup error
        }
      }
    }
    existing.activeCallInstances.clear();

    // 3. Remove socket connection.update listener
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

    // 4. End Voip client calls and dispose coordinator
    if (existing.voipInstance) {
      if (typeof existing.voipInstance.end === 'function') {
        try {
          void existing.voipInstance.end().catch(() => undefined);
        } catch {
          // Ignore end errors on detach
        }
      }
      try {
        const coordinator = existing.voipInstance.coordinator;
        coordinator?.dispose?.();
      } catch {
        // Ignore coordinator dispose errors on detach
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

  public getActiveStreamForSession(
    sessionId: string
  ): ActiveVideoCallStream | undefined {
    for (const stream of this.activeStreams.values()) {
      if (
        stream.sessionId === sessionId &&
        !this.isTerminalState(stream.callState)
      ) {
        return stream;
      }
    }
    return undefined;
  }

  public getStreamById(callId: string): ActiveVideoCallStream | undefined {
    return this.activeStreams.get(callId);
  }

  public getCallStatus(
    sessionIdOrCallId: string,
    maybeCallId?: string
  ): ActiveVideoCallStream | undefined {
    if (maybeCallId) {
      const stream = this.activeStreams.get(maybeCallId);
      if (stream && stream.sessionId === sessionIdOrCallId) {
        return stream;
      }
      return undefined;
    }
    return (
      this.activeStreams.get(sessionIdOrCallId) ||
      this.getActiveStreamForSession(sessionIdOrCallId)
    );
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
          durationSeconds: 3,
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
        recipientJid: req.recipientJid,
        recipientMasked,
        videoFilePath: req.videoFilePath || '',
        videoFileName: req.videoFileName || '',
        callKind,
        protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
        nativeStanzaCallIds: [],
        mode: 'HIROOSY_VOIP_RTP_SRTP',
        callState: 'FAILED',
        stateHistory: ['INITIATING', 'FAILED'],
        status: 'FAILED',
        audioStarted: false,
        videoStarted: false,
        mediaStarted: false,
        resolutionPreset: '360p',
        loopVideo,
        maxDurationSeconds: maxDuration,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        failureReason: VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
        detailsArabic: VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
      };
      this.activeStreams.set(failedCallId, failedStream);
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
    const streamRecord: ActiveVideoCallStream = {
      callId,
      sessionId: req.sessionId,
      recipientJid: req.recipientJid,
      recipientMasked,
      videoFilePath: mediaInspection.resolvedPath,
      videoFileName: resolvedVideo.fileName,
      callKind,
      protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
      nativeStanzaCallIds: [],
      mode: 'HIROOSY_VOIP_RTP_SRTP',
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
      startedAt: new Date().toISOString(),
      messageId: callId,
      detailsArabic: `📞 جاري تهيئة مكالمة الفيديو عبر @hiroosy/baileys-lite/voip (${mediaInspection.targetVoipResolution}) إلى (${recipientMasked})...`,
    };

    this.activeStreams.set(callId, streamRecord);
    this.emit('call:initiating', {
      callId,
      sessionId: req.sessionId,
      recipientJid: req.recipientJid,
      resolutionPreset: mediaInspection.targetVoipResolution,
    });

    await driver
      ?.sendPresenceUpdate('available', req.recipientJid)
      .catch(() => undefined);

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

    this.auditRepo?.record({
      actorTelegramId,
      action: 'VIDEO_CALL_STREAM_STARTED',
      targetId: req.sessionId,
      outcome: 'SUCCESS',
      metadata: {
        callId,
        mode: streamRecord.mode,
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
      callState: streamRecord.callState,
      resolutionPreset: streamRecord.resolutionPreset,
      recipientJid: req.recipientJid,
    });

    return streamRecord;
  }

  /**
   * Resolves the underlying `WaCallMediaSession` for an active call from `@hiroosy/baileys-lite/voip`
   * (`voip.coordinator.manager.calls.get(voipCallId)` or `callInstance.mediaSession`).
   */
  private resolveWaCallMediaSession(
    stream: ActiveVideoCallStream,
    voip: InstanceType<typeof Voip>,
    callInstance?: VoipCallInstance
  ): WaCallMediaSessionLike | undefined {
    if (callInstance?.mediaSession && typeof callInstance.mediaSession === 'object') {
      return callInstance.mediaSession;
    }
    const callInstanceAny = callInstance as unknown as {
      activeCall?: { session?: WaCallMediaSessionLike };
      _session?: WaCallMediaSessionLike;
    } | undefined;
    if (callInstanceAny?.activeCall?.session) {
      return callInstanceAny.activeCall.session;
    }
    if (callInstanceAny?._session) {
      return callInstanceAny._session;
    }

    const callsMap = voip.coordinator?.manager?.calls;
    if (callsMap && typeof callsMap.get === 'function') {
      if (stream.voipCallId) {
        const byId = callsMap.get(stream.voipCallId);
        if (byId) return byId;
      }
      for (const session of callsMap.values()) {
        if (!stream.voipCallId || session?.callId === stream.voipCallId) {
          return session;
        }
      }
    }
    return undefined;
  }

  /**
   * Inspects real outbound RTP/SRTP audio and video packet counters on the active call session
   * and transitions from `MEDIA_NEGOTIATING` to `MEDIA_STARTED` ONLY when real outbound media
   * transmission is proven.
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

    const mediaSession = this.resolveWaCallMediaSession(stream, voip, callInstance);
    const instanceStats =
      typeof callInstance?.getMediaStats === 'function'
        ? callInstance.getMediaStats()
        : undefined;

    const audioPackets =
      explicitStats?.audioSendCount ??
      instanceStats?.audioSendCount ??
      mediaSession?.audioSendCount ??
      mediaSession?.realAudioSendCount ??
      0;
    const audioOctets =
      explicitStats?.audioOctetsSent ??
      instanceStats?.audioOctetsSent ??
      mediaSession?.audioOctetsSent ??
      0;

    const videoPackets =
      explicitStats?.videoSendCount ??
      instanceStats?.videoSendCount ??
      mediaSession?.videoSendCount ??
      mediaSession?.videoEngine?.accessUnitsSent ??
      0;
    const videoOctets =
      explicitStats?.videoOctetsSent ??
      instanceStats?.videoOctetsSent ??
      mediaSession?.videoOctetsSent ??
      0;
    const videoKeyframes =
      explicitStats?.videoIdrSendCount ??
      instanceStats?.videoIdrSendCount ??
      mediaSession?.videoIdrSendCount ??
      (videoPackets > 0 ? 1 : 0);

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
    const tmpDir = path.resolve(process.cwd(), 'data', 'temp_uploads', 'voip_cache');
    fs.mkdirSync(tmpDir, { recursive: true });

    const ctx = this.attachedSessions.get(stream.sessionId);
    let voip = ctx?.voipInstance;
    if (!voip) {
      voip = new Voip(rawSocket as never, {
        voipLogLevel: 'warn',
        maxConcurrentCalls: 1,
        tmpDir,
      });
      if (ctx) {
        ctx.voipInstance = voip;
        ctx.voipListening = false;
      }
    }

    if (!ctx || !ctx.voipListening) {
      await voip.listen();
      if (ctx) {
        ctx.voipListening = true;
      }
    }

    let callInstance: VoipCallInstance | undefined;

    const isMatchingCallInfo = (info: unknown): boolean => {
      if (!info || typeof info !== 'object') return true;
      const cid =
        (info as { callId?: string; id?: string }).callId ||
        (info as { callId?: string; id?: string }).id;
      if (!cid || !stream.voipCallId) return true;
      return cid === stream.voipCallId;
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
        options?: { reason?: string };
      };
      return String(
        obj.reason || obj.endReason || obj.options?.reason || 'ended'
      ).toLowerCase();
    };

    const hangupActiveCallSafely = async () => {
      const inst = stream.voipCallInstance || callInstance;
      stream.voipCallInstance = undefined;
      if (ctx && stream.voipCallId) {
        ctx.activeCallInstances.delete(stream.voipCallId);
      }
      if (inst && typeof inst.hangup === 'function') {
        try {
          await inst.hangup();
          return;
        } catch {
          // Fall through to voip.hangup(callId)
        }
      }
      if (voip && typeof voip.hangup === 'function' && stream.voipCallId) {
        try {
          await voip.hangup(stream.voipCallId);
        } catch {
          // Ignore fallback hangup error
        }
      }
    };

    const startOutboundMediaVerification = () => {
      // Immediately check once in case media counters are already > 0
      if (this.evaluateOutboundMediaEvidence(stream, voip, callInstance)) {
        return;
      }

      this.clearMediaVerificationTimers(stream.callId);

      const monitorInterval = setInterval(() => {
        if (this.isTerminalState(stream.callState) || stream.mediaStarted) {
          this.clearMediaVerificationTimers(stream.callId);
          return;
        }
        this.evaluateOutboundMediaEvidence(stream, voip, callInstance);
      }, 20);
      if (typeof monitorInterval.unref === 'function') {
        monitorInterval.unref();
      }
      this.mediaMonitorIntervals.set(stream.callId, monitorInterval);

      const mediaTimeout = setTimeout(() => {
        if (this.isTerminalState(stream.callState) || stream.mediaStarted) {
          return;
        }
        // Final check right before declaring timeout
        if (this.evaluateOutboundMediaEvidence(stream, voip, callInstance)) {
          return;
        }

        const reason =
          'MEDIA_FAILED: Outbound RTP/SRTP audio/video frames did not start within timeout';
        log.error('Outbound media failed to start within timeout after call connected', {
          callId: stream.callId,
          voipCallId: stream.voipCallId,
          sessionId: stream.sessionId,
          audioStarted: stream.audioStarted,
          videoStarted: stream.videoStarted,
          mediaStartTimeoutMs,
        });

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

      if (reason.includes('reject') || reason.includes('busy')) {
        this.transitionCallState(stream, 'REJECTED', reason);
        stream.detailsArabic = `🚫 تم رفض المكالمة أو الانشغال من الطرف الآخر (${reason}).`;
        this.emit('call:rejected', {
          callId: stream.callId,
          sessionId: stream.sessionId,
          reason,
        });
      } else if (reason.includes('timeout') || reason.includes('unanswered')) {
        this.transitionCallState(stream, 'TIMEOUT', reason);
        stream.detailsArabic = `⏱️ انتهت مهلة الرنين دون رد من الطرف الآخر (${reason}).`;
        this.emit('call:timeout', {
          callId: stream.callId,
          sessionId: stream.sessionId,
          reason,
        });
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
      void hangupActiveCallSafely();
    };

    // Official WaVoipCoordinator listeners (`call_state`, `call_ended`, `call_error`, `call_video_state`, `call_outbound_audio_finished`)
    const coordinator = voip.coordinator;
    const onCoordinatorCallState = (info: Record<string, unknown>) => {
      if (!isMatchingCallInfo(info)) return;
      const st = String(info?.state || '').toLowerCase();
      if (st === 'ringing') {
        handleRinging(info);
      } else if (st === 'connected' || st === 'accepted') {
        handleConnected(info);
      } else if (st === 'ended' || st === 'rejected' || st === 'terminated') {
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
      });
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
        callInstance.off('ended', handleEnded);
        callInstance.off('error', handleError);
        callInstance.off('media_outbound_started', onExplicitOutboundMedia);
      }
    });

    const normalizedVoipPreset = stream.resolutionPreset.replace(
      '_portrait',
      ''
    ) as '360p' | '480p' | '720p';

    const callResult = await voip.call(
      stream.recipientJid,
      stream.videoFilePath,
      normalizedVoipPreset,
      {
        loop: stream.loopVideo,
        autoEndCall: !stream.loopVideo,
      }
    );

    if (callResult && typeof callResult === 'object') {
      callInstance = callResult as VoipCallInstance;
      stream.voipCallInstance = callInstance;
      if (typeof callInstance.on === 'function') {
        callInstance.on('ringing', handleRinging);
        callInstance.on('connected', handleConnected);
        callInstance.on('ended', handleEnded);
        callInstance.on('error', handleError);
        callInstance.on('media_outbound_started', onExplicitOutboundMedia);
      }
    }

    const voipCallId =
      typeof callResult === 'string'
        ? callResult
        : callResult?.callId || (callResult as { id?: string } | undefined)?.id;

    recordVoipCallId(voipCallId);

    // Note: Do NOT force transition to RINGING here unless `ringing` or `call_state`
    // has fired, OR if `callResult` is a legacy string ID without event emitter support.
    if (
      stream.callState === 'INITIATING' &&
      (!callInstance || typeof callInstance.on !== 'function')
    ) {
      handleRinging({ callId: voipCallId });
    }

    // Ringing timeout if recipient does not answer within callTimeoutMs
    const ringTimeout = setTimeout(() => {
      if (
        stream.callState === 'INITIATING' ||
        stream.callState === 'RINGING'
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

    // Maximum call duration timer
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

    void actorTelegramId;
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

    stream.videoStarted = true;
    this.emit('call:video-started', {
      callId: stream.callId,
      sessionId: stream.sessionId,
      resolutionPreset: stream.resolutionPreset,
    });

    stream.outboundMediaEvidence = {
      audioPacketsSent: 1,
      audioOctetsSent: 160,
      videoPacketsSent: 1,
      videoOctetsSent: 1200,
      videoKeyframesSent: 1,
      verifiedAt: new Date().toISOString(),
      source: 'mock_simulation',
    };
    stream.mediaStarted = true;
    this.transitionCallState(stream, 'MEDIA_STARTED');
    stream.detailsArabic = `🟢 جاري بث الصوت والفيديو فعلياً عبر طبقة VoIP RTP/SRTP (${stream.resolutionPreset}) إلى (${stream.recipientMasked}).`;
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
    for (const stream of this.activeStreams.values()) {
      if (
        stream.sessionId === sessionId &&
        !this.isTerminalState(stream.callState)
      ) {
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
    const stream = this.activeStreams.get(callId);
    if (!stream) return undefined;

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
    const callInstance = stream.voipCallInstance;
    stream.voipCallInstance = undefined;
    if (attached?.activeCallInstances && stream.voipCallId) {
      attached.activeCallInstances.delete(stream.voipCallId);
    }

    if (callInstance && typeof callInstance.hangup === 'function') {
      try {
        await callInstance.hangup();
      } catch {
        // Ignore hangup error if already closed
      }
    } else if (
      attached?.voipInstance &&
      typeof attached.voipInstance.hangup === 'function' &&
      stream.voipCallId
    ) {
      try {
        await attached.voipInstance.hangup(stream.voipCallId);
      } catch {
        // Ignore fallback hangup error if already closed
      }
    } else if (
      attached?.voipInstance &&
      typeof attached.voipInstance.end === 'function'
    ) {
      try {
        await attached.voipInstance.end();
      } catch {
        // Ignore end error
      }
    }

    try {
      const driver =
        explicitDriver ||
        attached?.driver ||
        this.sessionManager?.getDriver(stream.sessionId, actorTelegramId);
      if (driver && typeof driver.recordSimulatedVoipCallTermination === 'function') {
        for (const stanzaCallId of stream.nativeStanzaCallIds) {
          await driver
            .recordSimulatedVoipCallTermination(stream.recipientJid, stanzaCallId)
            .catch(() => undefined);
        }
      }
    } catch {
      // Ignore simulated termination error
    }

    if (
      deleteFile &&
      stream.videoFilePath &&
      fs.existsSync(stream.videoFilePath)
    ) {
      try {
        fs.unlinkSync(stream.videoFilePath);
      } catch {
        // Ignore file unlink failure
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
        protocolMode: stream.protocolMode,
        finalState: stream.callState,
        stateHistory: stream.stateHistory,
      },
    });

    return stream;
  }

  public async shutdownAll(): Promise<void> {
    for (const callId of this.activeStreams.keys()) {
      await this.stopVideoCallStream(callId, 0, {
        autoCompleted: false,
        deleteFile: true,
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
