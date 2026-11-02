import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
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
  VideoMediaInspectionResult,
  VoipVideoResolutionPreset,
} from './voip-media-pipeline';
import { createMinimalMp4Buffer } from '../function-lab/media-sticker-toolkit';
import {
  ValidationError,
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
  | 'FAILED';

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
  connectionListener?: (update: Record<string, unknown>) => void;
}

/**
 * Real WhatsApp VoIP Video Call Service (`RealVideoCallService`) powered by `@hiroosy/baileys-lite/voip`.
 *
 * Strictly enforces:
 * - Zero fake PTV (`sendMediaMessage({ ptv: true })`) or chat video fallbacks.
 * - Zero repeated `<call><offer>` wave loops.
 * - Full state machine:
 *   `INITIATING` -> `RINGING` -> `CONNECTING` -> `CONNECTED` -> `MEDIA_NEGOTIATING` ->
 *   `MEDIA_STARTED` -> `MEDIA_STOPPED` -> `ENDED` / `REJECTED` / `TIMEOUT` / `FAILED`.
 * - Pre-call `CompatibilityProbe` check and `validateAndInspectVideoMedia` pipeline.
 */
export class RealVideoCallService extends EventEmitter {
  private readonly attachedSessions = new Map<string, AttachedSessionContext>();
  private readonly activeStreams = new Map<string, ActiveVideoCallStream>();
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();
  private readonly ringingTimeoutTimers = new Map<string, NodeJS.Timeout>();
  private compatibilityOverride?: CompatibilityReport;

  constructor(
    private readonly sessionManager?: SessionManager,
    private readonly auditRepo?: AuditRepository
  ) {
    super();
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
    this.detachSession(sessionId);

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

    const ctx: AttachedSessionContext = {
      sessionId,
      driver,
      rawSocket,
      compatibleSocket,
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
   * Detaches a session, stops any active calls on that session, and disposes VoIP resources.
   */
  public detachSession(sessionId: string): void {
    const existing = this.attachedSessions.get(sessionId);
    if (!existing) return;

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

    if (existing.voipInstance) {
      try {
        void existing.voipInstance.hangup().catch(() => undefined);
      } catch {
        // Ignore hangup errors on detach
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
    if (
      nextState === 'ENDED' ||
      nextState === 'REJECTED' ||
      nextState === 'TIMEOUT' ||
      nextState === 'FAILED'
    ) {
      stream.endedAt = new Date().toISOString();
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
  }

  public getActiveStreamForSession(
    sessionId: string
  ): ActiveVideoCallStream | undefined {
    for (const stream of this.activeStreams.values()) {
      if (
        stream.sessionId === sessionId &&
        !['ENDED', 'REJECTED', 'TIMEOUT', 'FAILED'].includes(stream.callState)
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

  private ensureFallbackVideoFile(sessionId: string): {
    filePath: string;
    fileName: string;
  } {
    const tempDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
    fs.mkdirSync(tempDir, { recursive: true });
    const fileName = `synthetic_call_${sessionId}.mp4`;
    const filePath = path.join(tempDir, fileName);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, createMinimalMp4Buffer());
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
      Math.max(req.callTimeoutMs || 35_000, 100),
      120_000
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
      : this.ensureFallbackVideoFile(req.sessionId);

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
      detailsArabic: `📞📹 مكالمة فيديو VoIP حقيقية عبر @hiroosy/baileys-lite (${mediaInspection.targetVoipResolution}) إلى (${recipientMasked}).`,
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
   * Executes a real VoIP video call over `@hiroosy/baileys-lite/voip` (`Voip` / `WaVoipCoordinator`).
   */
  private async executeRealHiroosyVoipCallLifecycle(
    stream: ActiveVideoCallStream,
    rawSocket: Record<string, unknown>,
    callTimeoutMs: number,
    maxDurationSeconds: number,
    actorTelegramId: number
  ): Promise<void> {
    const tmpDir = path.resolve(process.cwd(), 'data', 'temp_uploads', 'voip_cache');
    fs.mkdirSync(tmpDir, { recursive: true });

    const voip = new Voip(rawSocket as never, {
      voipLogLevel: 'warn',
      maxConcurrentCalls: 1,
      tmpDir,
    });

    const ctx = this.attachedSessions.get(stream.sessionId);
    if (ctx) {
      ctx.voipInstance = voip;
    }

    voip.on('ringing', (info: { callId?: string; peerJid?: string }) => {
      if (info?.callId && !stream.nativeStanzaCallIds.includes(info.callId)) {
        stream.voipCallId = info.callId;
        stream.nativeStanzaCallIds.push(info.callId);
        stream.messageId = info.callId;
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
    });

    voip.on('connected', (info: { callId?: string; peerJid?: string }) => {
      const ringTimer = this.ringingTimeoutTimers.get(stream.callId);
      if (ringTimer) {
        clearTimeout(ringTimer);
        this.ringingTimeoutTimers.delete(stream.callId);
      }

      if (info?.callId && !stream.nativeStanzaCallIds.includes(info.callId)) {
        stream.voipCallId = info.callId;
        stream.nativeStanzaCallIds.push(info.callId);
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

      stream.mediaStarted = true;
      this.transitionCallState(stream, 'MEDIA_STARTED');
      stream.detailsArabic = `🟢 جاري بث الصوت والفيديو فعلياً عبر RTP/SRTP داخل مكالمة واتساب (${stream.resolutionPreset}) إلى (${stream.recipientMasked}).`;
      this.emit('call:media-started', {
        callId: stream.callId,
        voipCallId: stream.voipCallId,
        sessionId: stream.sessionId,
        resolutionPreset: stream.resolutionPreset,
      });
    });

    voip.on('ended', (info: { callId?: string; reason?: string }) => {
      this.clearCallTimers(stream.callId);
      const reason = String(info?.reason || 'ended').toLowerCase();
      if (
        ['ENDED', 'REJECTED', 'TIMEOUT', 'FAILED'].includes(stream.callState)
      ) {
        return;
      }

      if (reason.includes('reject') || reason.includes('busy')) {
        this.transitionCallState(stream, 'REJECTED', reason);
        this.emit('call:rejected', {
          callId: stream.callId,
          sessionId: stream.sessionId,
          reason,
        });
      } else if (reason.includes('timeout') || reason.includes('unanswered')) {
        this.transitionCallState(stream, 'TIMEOUT', reason);
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
      }

      this.emit('call:ended', {
        callId: stream.callId,
        sessionId: stream.sessionId,
        state: stream.callState,
        reason,
      });
    });

    voip.on('error', (err: Error) => {
      this.clearCallTimers(stream.callId);
      const classification = classifyEngineeringFailure(err);
      this.transitionCallState(stream, 'FAILED', classification.summary);
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
    });

    await voip.listen();

    const callResult = await voip.call(
      stream.recipientJid,
      stream.videoFilePath,
      stream.resolutionPreset,
      {
        loop: stream.loopVideo,
        autoEndCall: !stream.loopVideo,
      }
    );

    const voipCallId =
      typeof callResult === 'string' ? callResult : callResult?.callId;

    if (voipCallId) {
      stream.voipCallId = voipCallId;
      if (!stream.nativeStanzaCallIds.includes(voipCallId)) {
        stream.nativeStanzaCallIds.push(voipCallId);
      }
      stream.messageId = voipCallId;
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

    // Ringing timeout if recipient does not answer within callTimeoutMs
    const ringTimeout = setTimeout(() => {
      if (
        stream.callState === 'INITIATING' ||
        stream.callState === 'RINGING'
      ) {
        this.transitionCallState(stream, 'TIMEOUT', 'Call ringing timed out');
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
   * during automated unit/integration tests without sending any fake PTV or chat video.
   */
  private async executeMockVoipCallLifecycle(
    stream: ActiveVideoCallStream,
    driver: WhatsAppSessionDriver,
    simulateLifecycle: 'auto' | 'manual',
    callTimeoutMs: number,
    maxDurationSeconds: number,
    actorTelegramId: number
  ): Promise<void> {
    if (typeof driver.sendNativeVideoCallOffer === 'function') {
      const offerRes = await driver.sendNativeVideoCallOffer(
        stream.recipientJid,
        {
          isVideo: stream.callKind === 'video',
        }
      );
      stream.voipCallId = offerRes.callId;
      stream.nativeStanzaCallIds.push(offerRes.callId);
      stream.messageId = offerRes.callId;
    } else if (typeof driver.sendNativeCallOffer === 'function') {
      const offerRes = await driver.sendNativeCallOffer({
        targetJid: stream.recipientJid,
        isVideo: stream.callKind === 'video',
      });
      stream.voipCallId = offerRes.callId;
      stream.nativeStanzaCallIds.push(offerRes.callId);
      stream.messageId = offerRes.callId;
    }

    this.transitionCallState(stream, 'RINGING');
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
   * Deterministically advances a ringing call through:
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

    stream.mediaStarted = true;
    this.transitionCallState(stream, 'MEDIA_STARTED');
    stream.detailsArabic = `🟢 جاري بث الصوت والفيديو فعلياً عبر طبقة VoIP RTP/SRTP (${stream.resolutionPreset}) إلى (${stream.recipientMasked}).`;
    this.emit('call:media-started', {
      callId: stream.callId,
      voipCallId: stream.voipCallId,
      sessionId: stream.sessionId,
      resolutionPreset: stream.resolutionPreset,
    });
  }

  /**
   * Transitions a call to `REJECTED` and emits `call:rejected` + `call:ended`.
   */
  public simulateCallRejected(callId: string, reason = 'rejected_by_peer'): void {
    const stream = this.activeStreams.get(callId);
    if (!stream) return;
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
    if (!stream) return;
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
        !['ENDED', 'REJECTED', 'TIMEOUT', 'FAILED'].includes(stream.callState)
      ) {
        this.clearCallTimers(stream.callId);
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
   * Stops an active VoIP video call cleanly, hangs up the VoIP media session,
   * and transitions through `MEDIA_STOPPED` -> `ENDED`.
   */
  public async stopVideoCall(
    sessionId: string,
    callId: string,
    options: StopVideoCallOptions = {},
    actorTelegramId = 0,
    explicitDriver?: WhatsAppSessionDriver
  ): Promise<ActiveVideoCallStream | undefined> {
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
    if (attached?.voipInstance) {
      try {
        await attached.voipInstance.hangup();
      } catch {
        // Ignore hangup error if already closed
      }
    }

    try {
      const driver =
        explicitDriver ||
        attached?.driver ||
        this.sessionManager?.getDriver(stream.sessionId, actorTelegramId);
      if (driver) {
        for (const stanzaCallId of stream.nativeStanzaCallIds) {
          if (typeof driver.terminateNativeVideoCall === 'function') {
            await driver
              .terminateNativeVideoCall(stream.recipientJid, stanzaCallId)
              .catch(() => undefined);
          } else if (typeof driver.terminateNativeCall === 'function') {
            await driver
              .terminateNativeCall({
                targetJid: stream.recipientJid,
                callId: stanzaCallId,
              })
              .catch(() => undefined);
          }
        }
      }
    } catch {
      // Ignore if session disconnected before termination stanza
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

    if (
      !['ENDED', 'REJECTED', 'TIMEOUT', 'FAILED'].includes(stream.callState)
    ) {
      if (stream.mediaStarted) {
        this.transitionCallState(stream, 'MEDIA_STOPPED');
      }
      this.transitionCallState(stream, 'ENDED', reason);
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
  RealVideoCallService as NativeVideoCallEngine,
  RealVideoCallService as UbuntuVideoCallBridge,
};
export { WhatsAppConnectionError };
