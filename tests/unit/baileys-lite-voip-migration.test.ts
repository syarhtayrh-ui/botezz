import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type {
  VoipCallInstance,
  WaCallMediaSessionLike,
} from '@hiroosy/baileys-lite/voip';

import {
  makeWASocket,
  Voip,
  jidNormalizedUser,
  getBinaryNodeChild,
  encodeSignedDeviceIdentity,
  parseAndInjectE2ESessions,
  getUSyncDevices,
  toCompatibleWhatsAppSocket,
  classifyEngineeringFailure,
} from '../../src/whatsapp/baileys-compat';
import {
  runBaileysCompatibilityProbe,
  VOIP_INCOMPATIBLE_ARABIC_MESSAGE,
} from '../../src/whatsapp/compatibility-probe';
import {
  validateAndInspectVideoMedia,
  generatePlayableVoipMp4File,
  computeTargetVoipResolution,
} from '../../src/whatsapp/voip-media-pipeline';
import { RealVideoCallService } from '../../src/whatsapp/video-call-bridge';
import {
  instrumentVideoEngineInstance,
  instrumentMediaSessionInstance,
  ensureHiroosyVoipRuntimePatched,
} from '../../src/whatsapp/voip-runtime-patch';
import {
  MockWhatsAppSessionDriver,
  HiroosyBaileysSessionDriver,
  BaileysSessionDriver,
} from '../../src/whatsapp/connection-manager';
import {
  MediaValidationError,
  VoipFailureError,
} from '../../src/utils/errors';
import { AppDatabase } from '../../src/database/database';
import { InboxRepository } from '../../src/database/repositories/inbox-repository';
import { StatusRepository } from '../../src/database/repositories/status-repository';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { IncomingMessageReceiver } from '../../src/whatsapp/incoming-message-receiver';
import { StatusDownloaderService } from '../../src/whatsapp/status-downloader';
import { InboxHandler } from '../../src/bot/handlers/inbox';
import { StoriesHandler } from '../../src/bot/handlers/stories';

type TrackedMockDriver = MockWhatsAppSessionDriver & {
  sentMediaCalls: unknown[];
  sentTextCalls: unknown[];
};

async function createConnectedMockDriver(
  sessionId: string
): Promise<TrackedMockDriver> {
  const driver = new MockWhatsAppSessionDriver(sessionId) as TrackedMockDriver;
  driver.sentMediaCalls = [];
  driver.sentTextCalls = [];
  const origSendMedia = driver.sendMediaMessage.bind(driver);
  driver.sendMediaMessage = async (params) => {
    driver.sentMediaCalls.push(params);
    return origSendMedia(params);
  };
  const origSendText = driver.sendTextMessage.bind(driver);
  driver.sendTextMessage = async (jid, text) => {
    driver.sentTextCalls.push({ jid, text });
    return origSendText(jid, text);
  };
  driver.markRegistered('966500000000@s.whatsapp.net');
  await driver.connect({
    onStatusChange: () => undefined,
  });
  return driver;
}

interface RealisticMockCallInstance extends EventEmitter {
  callId: string;
  target: string;
  isVideoDowngraded: boolean;
  hangupCalls: number;
  mediaSession: WaCallMediaSessionLike;
  hangup?: () => Promise<void>;
  mute: () => void;
  raiseHand: () => void;
  shareScreen: () => void;
  react: () => boolean;
  upgradeToVideo: () => Promise<void>;
  silent: () => Promise<boolean>;
}

/**
 * Creates a realistic mock of `@hiroosy/baileys-lite/voip` matching `src/voip/index.js`,
 * `src/voip/WaVoipCoordinator.js`, and `src/voip/call/WaCallMediaSession.js`.
 *
 * Key fidelity rules:
 * - `Voip` is NOT an EventEmitter; its `.on`/`.off` methods delegate to `coordinator`
 *   only after `listen()` is called.
 * - `voip.call()` returns a `VoipCall` instance (`EventEmitter`) emitting
 *   `'ringing'`, `'connected'`, `'ended'`, `'error'`.
 * - `voip.coordinator.manager.calls` holds a `WaCallMediaSessionLike` entry per `callId`
 *   with `audioSendCount`, `audioOctetsSent`, `videoSendCount`, `videoOctetsSent`, `videoIdrSendCount`.
 */
function createRealisticHiroosyVoipMock(options?: {
  omitCallInstanceHangup?: boolean;
}) {
  const coordinatorEmitter = new EventEmitter();
  const callsMap = new Map<string, WaCallMediaSessionLike>();
  const createdCallInstances: RealisticMockCallInstance[] = [];
  let listenCalls = 0;
  let coordinatorDisposed = false;
  let endCalls = 0;
  const voipHangupCallIds: Array<string | undefined> = [];
  const receivedPresets: string[] = [];

  const coordinator = Object.assign(coordinatorEmitter, {
    manager: {
      calls: callsMap,
    },
    disposed: false,
    dispose() {
      coordinatorDisposed = true;
      this.disposed = true;
      callsMap.clear();
      coordinatorEmitter.removeAllListeners();
    },
  });

  const voipMock = {
    coordinator: null as typeof coordinator | null,
    get listenCalls() {
      return listenCalls;
    },
    get coordinatorDisposed() {
      return coordinatorDisposed;
    },
    get endCalls() {
      return endCalls;
    },
    voipHangupCallIds,
    receivedPresets,
    createdCallInstances,
    callsMap,
    async listen() {
      listenCalls += 1;
      this.coordinator = coordinator;
      return this;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!this.coordinator) {
        throw new Error('Call listen() before subscribing to voip events.');
      }
      this.coordinator.on(event, listener);
      return this;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      this.coordinator?.off(event, listener);
      return this;
    },
    async call(
      jid: string,
      _videoPath: string,
      preset: string
    ): Promise<VoipCallInstance> {
      if (!this.coordinator) {
        throw new Error('Call listen() before starting a call.');
      }
      const validPresets = ['240p', '360p', '480p', '720p', '1080p'];
      if (!validPresets.includes(preset)) {
        throw new Error(
          `Unknown resolution "${preset}". Use one of: 240p, 360p, 480p, 720p, 1080p, or pass { width, height, frameRate } directly.`
        );
      }
      receivedPresets.push(preset);
      const callId = `HIROOSY_CALL_${createdCallInstances.length + 1}`;
      const mediaSession: WaCallMediaSessionLike = {
        callId,
        peerJid: jid,
        isVideo: true,
        audioSendCount: 0,
        audioOctetsSent: 0,
        realAudioSendCount: 0,
        videoSendCount: 0,
        videoOctetsSent: 0,
        videoIdrSendCount: 0,
        firstPacketSent: false,
        mediaFlowStarted: false,
      };
      callsMap.set(callId, mediaSession);

      const callInstance = new EventEmitter() as RealisticMockCallInstance;
      callInstance.callId = callId;
      callInstance.target = jid;
      callInstance.isVideoDowngraded = false;
      callInstance.hangupCalls = 0;
      callInstance.mediaSession = mediaSession;
      callInstance.mute = () => undefined;
      callInstance.raiseHand = () => undefined;
      callInstance.shareScreen = () => undefined;
      callInstance.react = () => true;
      callInstance.upgradeToVideo = async () => undefined;
      callInstance.silent = async () => false;

      if (!options?.omitCallInstanceHangup) {
        callInstance.hangup = async () => {
          callInstance.hangupCalls += 1;
          callsMap.delete(callId);
        };
      }

      createdCallInstances.push(callInstance);
      return callInstance as unknown as VoipCallInstance;
    },
    async hangup(callId?: string) {
      voipHangupCallIds.push(callId);
      if (callId) {
        callsMap.delete(callId);
      }
    },
    async end() {
      endCalls += 1;
      for (const inst of createdCallInstances) {
        if (typeof inst.hangup === 'function') {
          await inst.hangup();
        }
      }
      callsMap.clear();
    },
  };

  return {
    voipMock,
    coordinator,
    callsMap,
    createdCallInstances,
    simulateOutboundRtpSrtpFrames(
      callId: string,
      counts?: {
        audioSendCount?: number;
        audioOctetsSent?: number;
        videoSendCount?: number;
        videoOctetsSent?: number;
        videoIdrSendCount?: number;
      }
    ) {
      const session = callsMap.get(callId);
      if (!session) {
        throw new Error(`No WaCallMediaSession found for ${callId}`);
      }
      session.firstPacketSent = true;
      session.mediaFlowStarted = true;
      if (counts?.audioSendCount !== undefined) {
        session.audioSendCount = counts.audioSendCount;
      }
      if (counts?.audioOctetsSent !== undefined) {
        session.audioOctetsSent = counts.audioOctetsSent;
      }
      if (counts?.videoSendCount !== undefined) {
        session.videoSendCount = counts.videoSendCount;
      }
      if (counts?.videoOctetsSent !== undefined) {
        session.videoOctetsSent = counts.videoOctetsSent;
      }
      if (counts?.videoIdrSendCount !== undefined) {
        session.videoIdrSendCount = counts.videoIdrSendCount;
      }
    },
  };
}

describe('@hiroosy/baileys-lite & Real WhatsApp VoIP Video Call Suite', () => {
  let tmpDir: string;
  let validLandscapeMp4: string;
  let validPortraitMp4: string;
  let validSilentMp4: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-voip-test-'));
    validLandscapeMp4 = path.join(tmpDir, 'landscape_360p.mp4');
    validPortraitMp4 = path.join(tmpDir, 'portrait_360p.mp4');
    validSilentMp4 = path.join(tmpDir, 'silent_video.mp4');

    await generatePlayableVoipMp4File(validLandscapeMp4, {
      width: 640,
      height: 360,
      durationSeconds: 1,
      includeAudio: true,
    });
    await generatePlayableVoipMp4File(validPortraitMp4, {
      width: 360,
      height: 640,
      durationSeconds: 1,
      includeAudio: true,
    });
    await generatePlayableVoipMp4File(validSilentMp4, {
      width: 640,
      height: 360,
      durationSeconds: 1,
      includeAudio: false,
    });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failure
    }
  });

  describe('Phase 3: baileys-compat & Error Classification', () => {
    it('exports @hiroosy/baileys-lite core and Voip constructors and helpers', () => {
      assert.equal(typeof makeWASocket, 'function');
      assert.equal(typeof Voip, 'function');
      assert.equal(typeof jidNormalizedUser, 'function');
      assert.equal(typeof getBinaryNodeChild, 'function');
      assert.equal(typeof encodeSignedDeviceIdentity, 'function');
      assert.equal(typeof parseAndInjectE2ESessions, 'function');
      assert.equal(typeof getUSyncDevices, 'function');
      assert.equal(HiroosyBaileysSessionDriver, BaileysSessionDriver);
    });

    it('wraps a raw socket into CompatibleWhatsAppSocket cleanly', () => {
      const ev = new EventEmitter();
      const rawSock: Record<string, unknown> = {
        ev,
        ws: { isOpen: true },
        authState: {
          creds: { me: { id: '966500000000:1@s.whatsapp.net' } },
          keys: { get: async () => ({}), set: async () => undefined },
        },
        signalRepository: {
          injectE2ESession: async () => undefined,
          encryptMessage: async () => ({
            type: 'pkmsg',
            ciphertext: Buffer.alloc(8),
          }),
          decryptMessage: async () => Buffer.alloc(8),
          jidToSignalProtocolAddress: () => 'addr',
          lidMapping: {},
        },
        sendMessage: async () => ({ key: { id: 'msg1' } }),
        relayMessage: async () => 'msg1',
        sendNode: async () => undefined,
        query: async () => ({ tag: 'iq', attrs: {} }),
        getUSyncDevices: async () => [],
      };

      const compat = toCompatibleWhatsAppSocket(rawSock);
      assert.equal(typeof compat.sendMessage, 'function');
      assert.equal(typeof compat.sendNode, 'function');
      assert.equal(typeof compat.getUSyncDevices, 'function');
      assert.ok(compat.signalRepository);
    });

    it('classifies engineering failures into exact 6 categories', () => {
      assert.equal(
        classifyEngineeringFailure(
          new Error('Invalid video codec or ffprobe error')
        ).category,
        'Media failure'
      );
      assert.equal(
        classifyEngineeringFailure(
          new Error('SRTP handshake failed in VoIP call')
        ).category,
        'VoIP failure'
      );
      assert.equal(
        classifyEngineeringFailure(new Error('401 loggedOut bad mac creds'))
          .category,
        'Auth failure'
      );
      assert.equal(
        classifyEngineeringFailure(
          new Error('connect ETIMEDOUT WebSocket closed')
        ).category,
        'Network failure'
      );
      assert.equal(
        classifyEngineeringFailure(
          new Error('TypeError: sock.foo is not a function')
        ).category,
        'API mismatch'
      );
      assert.equal(
        classifyEngineeringFailure(new Error('BinaryNode stanza USync reject'))
          .category,
        'Protocol failure'
      );
    });
  });

  describe('Phase 4: CompatibilityProbe', () => {
    it('verifies all 15 VoIP capabilities and media binaries in static probe', () => {
      const report = runBaileysCompatibilityProbe({ requireLiveSocket: false });
      assert.equal(report.baseBaileysCompatible, true);
      assert.equal(report.voipCompatible, true);
      assert.equal(report.missingCapabilities.length, 0);
      assert.equal(report.mediaBinaries.ffmpegAvailable, true);
      assert.equal(report.mediaBinaries.ffprobeAvailable, true);

      for (const [key, val] of Object.entries(report.voipCapabilities)) {
        assert.equal(val, true, `Expected VoIP capability ${key} to be true`);
      }
    });

    it('detects missing live socket capabilities when requireLiveSocket is true', () => {
      const incompleteSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        authState: { creds: {} },
      };
      const report = runBaileysCompatibilityProbe({
        socket: incompleteSocket,
        requireLiveSocket: true,
      });
      assert.equal(report.voipCompatible, false);
      assert.ok(report.missingCapabilities.includes('voip.authClient'));
      assert.ok(report.missingCapabilities.includes('voip.lowLevelSendNode'));
      assert.ok(
        report.missingCapabilities.includes('voip.signalEncryptionDecryption')
      );
    });
  });

  describe('Phase 6: Video & Audio Media Pipeline (validateAndInspectVideoMedia)', () => {
    it('inspects a valid landscape H.264 + AAC MP4 file via ffprobe', async () => {
      const res = await validateAndInspectVideoMedia(validLandscapeMp4, {
        allowedRootDirs: [tmpDir],
      });
      assert.equal(res.valid, true);
      assert.equal(res.videoCodec, 'h264');
      assert.equal(res.width, 640);
      assert.equal(res.height, 360);
      assert.equal(res.isPortrait, false);
      assert.equal(res.hasAudioStream, true);
      assert.equal(res.requiresSilentAudioFallback, false);
      assert.equal(res.targetVoipResolution, '360p');
    });

    it('inspects a valid portrait MP4 file and selects 360p_portrait preset', async () => {
      const res = await validateAndInspectVideoMedia(validPortraitMp4, {
        allowedRootDirs: [tmpDir],
      });
      assert.equal(res.valid, true);
      assert.equal(res.width, 360);
      assert.equal(res.height, 640);
      assert.equal(res.isPortrait, true);
      assert.equal(res.targetVoipResolution, '360p_portrait');
    });

    it('detects video without audio track and marks requiresSilentAudioFallback = true', async () => {
      const res = await validateAndInspectVideoMedia(validSilentMp4, {
        allowedRootDirs: [tmpDir],
      });
      assert.equal(res.valid, true);
      assert.equal(res.hasAudioStream, false);
      assert.equal(res.requiresSilentAudioFallback, true);
    });

    it('computes resolution presets accurately for landscape and portrait dimensions', () => {
      assert.equal(computeTargetVoipResolution(1920, 1080), '720p');
      assert.equal(computeTargetVoipResolution(1080, 1920), '720p_portrait');
      assert.equal(computeTargetVoipResolution(854, 480), '480p');
      assert.equal(computeTargetVoipResolution(480, 854), '480p_portrait');
      assert.equal(computeTargetVoipResolution(640, 360), '360p');
      assert.equal(computeTargetVoipResolution(360, 640), '360p_portrait');
    });

    it('rejects missing files with MediaValidationError (MEDIA_FAILURE)', async () => {
      await assert.rejects(
        () =>
          validateAndInspectVideoMedia(
            path.join(tmpDir, 'does_not_exist.mp4'),
            {
              allowedRootDirs: [tmpDir],
            }
          ),
        (err: unknown) => err instanceof MediaValidationError
      );
    });

    it('rejects path traversal outside allowedRootDirs with MediaValidationError', async () => {
      await assert.rejects(
        () =>
          validateAndInspectVideoMedia(validLandscapeMp4, {
            allowedRootDirs: [path.join(tmpDir, 'restricted_subdir')],
          }),
        (err: unknown) => err instanceof MediaValidationError
      );
    });

    it('rejects oversized video files exceeding maxSizeBytes', async () => {
      await assert.rejects(
        () =>
          validateAndInspectVideoMedia(validLandscapeMp4, {
            allowedRootDirs: [tmpDir],
            maxSizeBytes: 256,
          }),
        (err: unknown) => err instanceof MediaValidationError
      );
    });

    it('rejects corrupted non-video files', async () => {
      const corruptPath = path.join(tmpDir, 'corrupt.mp4');
      fs.writeFileSync(
        corruptPath,
        Buffer.from('not a valid video container header')
      );
      await assert.rejects(
        () =>
          validateAndInspectVideoMedia(corruptPath, {
            allowedRootDirs: [tmpDir],
          }),
        (err: unknown) => err instanceof MediaValidationError
      );
    });

    it('rejects when ffprobe binary fails or is unavailable', async () => {
      await assert.rejects(
        () =>
          validateAndInspectVideoMedia(validLandscapeMp4, {
            allowedRootDirs: [tmpDir],
            ffprobePath: '/nonexistent/ffprobe-binary',
          }),
        (err: unknown) => err instanceof MediaValidationError
      );
    });
  });

  describe('Phase 6 & 7: RealVideoCallService State Machine & 17 Mandatory Operational Guarantees', () => {
    it('drives full simulated state machine (INITIATING -> RINGING -> CONNECTING -> CONNECTED -> MEDIA_NEGOTIATING -> MEDIA_STARTED -> MEDIA_STOPPED -> ENDED) and sends ZERO PTV/chat messages', async () => {
      const service = new RealVideoCallService();
      const mockDriver = await createConnectedMockDriver('sess_voip_1');

      const observedEvents: string[] = [];
      for (const evt of [
        'call:initiating',
        'call:ringing',
        'call:connecting',
        'call:connected',
        'call:audio-started',
        'call:video-started',
        'call:media-started',
        'call:ended',
      ]) {
        service.on(evt, () => observedEvents.push(evt));
      }

      const stream = await service.startVideoCall({
        sessionId: 'sess_voip_1',
        driver: mockDriver,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        strictMediaValidation: true,
        simulateLifecycle: 'auto',
      });

      assert.equal(stream.callState, 'MEDIA_STARTED');
      assert.equal(stream.audioStarted, true);
      assert.equal(stream.videoStarted, true);
      assert.equal(stream.mediaStarted, true);
      assert.equal(stream.resolutionPreset, '360p');

      assert.equal(
        mockDriver.sentMediaCalls.length,
        0,
        'RealVideoCallService must NEVER send PTV or chat video messages'
      );
      assert.equal(mockDriver.sentTextCalls.length, 0);
      assert.equal(mockDriver.sentCallOffers.length, 1);

      await service.stopVideoCall('sess_voip_1', stream.callId);

      assert.equal(stream.callState, 'ENDED');
      assert.deepEqual(stream.stateHistory, [
        'INITIATING',
        'RINGING',
        'CONNECTING',
        'CONNECTED',
        'MEDIA_NEGOTIATING',
        'MEDIA_STARTED',
        'MEDIA_STOPPED',
        'ENDED',
      ]);
      assert.deepEqual(observedEvents, [
        'call:initiating',
        'call:ringing',
        'call:connecting',
        'call:connected',
        'call:audio-started',
        'call:video-started',
        'call:media-started',
        'call:ended',
      ]);
    });

    it('handles call rejection (INITIATING -> RINGING -> REJECTED) without starting media', async () => {
      const service = new RealVideoCallService();
      const mockDriver = await createConnectedMockDriver('sess_voip_reject');

      let rejectedFired = false;
      service.on('call:rejected', () => {
        rejectedFired = true;
      });

      const stream = await service.startVideoCall({
        sessionId: 'sess_voip_reject',
        driver: mockDriver,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        strictMediaValidation: true,
        simulateLifecycle: 'manual',
      });

      assert.equal(stream.callState, 'RINGING');
      assert.equal(stream.mediaStarted, false);

      service.simulateCallRejected(stream.callId, 'rejected_by_recipient');

      assert.equal(rejectedFired, true);
      assert.equal(stream.callState, 'REJECTED');
      assert.equal(stream.mediaStarted, false);
      assert.deepEqual(stream.stateHistory, [
        'INITIATING',
        'RINGING',
        'REJECTED',
      ]);
      assert.equal(mockDriver.sentMediaCalls.length, 0);
    });

    it('handles call ringing timeout (INITIATING -> RINGING -> TIMEOUT)', async () => {
      const service = new RealVideoCallService();
      const mockDriver = await createConnectedMockDriver('sess_voip_timeout');

      let timeoutFired = false;
      service.on('call:timeout', () => {
        timeoutFired = true;
      });

      const stream = await service.startVideoCall({
        sessionId: 'sess_voip_timeout',
        driver: mockDriver,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        strictMediaValidation: true,
        simulateLifecycle: 'manual',
        callTimeoutMs: 120,
      });

      assert.equal(stream.callState, 'RINGING');

      await new Promise((r) => setTimeout(r, 180));

      assert.equal(timeoutFired, true);
      assert.equal(stream.callState, 'TIMEOUT');
      assert.equal(stream.mediaStarted, false);
      assert.deepEqual(stream.stateHistory, [
        'INITIATING',
        'RINGING',
        'TIMEOUT',
      ]);
    });

    it('cleans up active call and emits call:socket-closed on unexpected socket closure', async () => {
      const service = new RealVideoCallService();
      const mockDriver = await createConnectedMockDriver('sess_voip_sockclose');

      let socketClosedFired = false;
      service.on('call:socket-closed', () => {
        socketClosedFired = true;
      });

      const stream = await service.startVideoCall({
        sessionId: 'sess_voip_sockclose',
        driver: mockDriver,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        strictMediaValidation: true,
        simulateLifecycle: 'auto',
      });

      assert.equal(stream.callState, 'MEDIA_STARTED');

      service.handleSocketClosed('sess_voip_sockclose', 'connection_lost');

      assert.equal(socketClosedFired, true);
      assert.equal(stream.callState, 'FAILED');
      assert.ok(stream.stateHistory.includes('MEDIA_STOPPED'));
      assert.ok(stream.stateHistory.includes('FAILED'));
    });

    it('fails closed with exact Arabic message when VoIP layer is incompatible and never falls back to PTV', async () => {
      const service = new RealVideoCallService();
      const mockDriver = await createConnectedMockDriver('sess_voip_incompat');

      const fakeIncompatibleReport = runBaileysCompatibilityProbe({
        requireLiveSocket: false,
      });
      fakeIncompatibleReport.voipCompatible = false;
      fakeIncompatibleReport.missingCapabilities = ['voip.rtpSrtpSupport'];
      fakeIncompatibleReport.reasons = ['Simulated SRTP incompatibility'];

      service.setCompatibilityOverride(fakeIncompatibleReport);

      await assert.rejects(
        () =>
          service.startVideoCall({
            sessionId: 'sess_voip_incompat',
            driver: mockDriver,
            recipientJid: '966501234567@s.whatsapp.net',
            videoFilePath: validLandscapeMp4,
            allowedRootDirs: [tmpDir],
          }),
        (err: unknown) => {
          assert.ok(err instanceof VoipFailureError);
          assert.equal(err.userMessage, VOIP_INCOMPATIBLE_ARABIC_MESSAGE);
          return true;
        }
      );

      assert.equal(mockDriver.sentCallOffers.length, 0);
      assert.equal(mockDriver.sentMediaCalls.length, 0);
    });

    it('Tests 1, 2, 3, 4, 5, 6: retains VoipCallInstance, binds listeners directly to VoipCallInstance, transitions RINGING -> CONNECTED -> MEDIA_NEGOTIATING on connected, and ONLY transitions to MEDIA_STARTED after real outbound audio + video RTP/SRTP evidence', async () => {
      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );

      const rawSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        ws: { isOpen: true },
      };
      service.attachSession('sess_real_voip_1_to_6', rawSocket);

      const harness = createRealisticHiroosyVoipMock();
      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_real_voip_1_to_6')!.voipInstance = harness.voipMock;

      const stream = await service.startVideoCall({
        sessionId: 'sess_real_voip_1_to_6',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validPortraitMp4,
        allowedRootDirs: [tmpDir],
      });

      // (1) voip.call() returns VoipCallInstance and it is stored on stream.voipCallInstance
      assert.equal(harness.createdCallInstances.length, 1);
      const callInst = harness.createdCallInstances[0]!;
      assert.equal(stream.voipCallInstance, callInst);
      assert.equal(stream.voipCallId, 'HIROOSY_CALL_1');
      assert.equal(stream.resolutionPreset, '360p_portrait');
      assert.deepEqual(harness.voipMock.receivedPresets, ['360p']);

      // (2) Listeners ('ringing', 'connected', 'ended', 'error') are bound to VoipCallInstance itself
      assert.equal(callInst.listenerCount('ringing'), 1);
      assert.equal(callInst.listenerCount('connected'), 1);
      assert.equal(callInst.listenerCount('ended'), 1);
      assert.equal(callInst.listenerCount('error'), 1);

      // (3) 'ringing' event on VoipCallInstance transitions state to RINGING
      assert.equal(stream.callState, 'INITIATING');
      callInst.emit('ringing');
      assert.equal(stream.callState, 'RINGING');
      assert.equal(stream.mediaStarted, false);

      // (4) 'connected' event does NOT transition immediately to MEDIA_STARTED
      callInst.emit('connected');
      assert.equal(stream.callState, 'MEDIA_NEGOTIATING');
      assert.equal(stream.audioStarted, false);
      assert.equal(stream.videoStarted, false);
      assert.equal(stream.mediaStarted, false);

      // (5) No transition to MEDIA_STARTED when only audio (or zero video) packets have been sent
      harness.simulateOutboundRtpSrtpFrames('HIROOSY_CALL_1', {
        audioSendCount: 5,
        audioOctetsSent: 800,
        videoSendCount: 0,
        videoOctetsSent: 0,
        videoIdrSendCount: 0,
      });
      await new Promise((r) => setTimeout(r, 35));
      assert.equal(stream.audioStarted, true);
      assert.equal(stream.videoStarted, false);
      assert.equal(stream.mediaStarted, false);
      assert.equal(stream.callState, 'MEDIA_NEGOTIATING');

      // (6) First outbound video + audio RTP/SRTP evidence transitions state to MEDIA_STARTED
      harness.simulateOutboundRtpSrtpFrames('HIROOSY_CALL_1', {
        audioSendCount: 12,
        audioOctetsSent: 1920,
        videoSendCount: 8,
        videoOctetsSent: 9600,
        videoIdrSendCount: 1,
      });
      await new Promise((r) => setTimeout(r, 35));

      assert.equal(stream.videoStarted, true);
      assert.equal(stream.mediaStarted, true);
      assert.equal(stream.callState, 'MEDIA_STARTED');
      assert.ok(stream.outboundMediaEvidence);
      assert.equal(stream.outboundMediaEvidence.audioPacketsSent, 12);
      assert.equal(stream.outboundMediaEvidence.videoPacketsSent, 8);
      assert.equal(stream.outboundMediaEvidence.videoKeyframesSent, 1);

      await service.stopVideoCall('sess_real_voip_1_to_6', stream.callId);
      service.detachSession('sess_real_voip_1_to_6');
    });

    it('Test 7: media failure / timeout before first frame transitions to FAILED, hangs up, and cleans up the call without claiming MEDIA_STARTED', async () => {
      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );

      const rawSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        ws: { isOpen: true },
      };
      service.attachSession('sess_media_timeout', rawSocket);

      const harness = createRealisticHiroosyVoipMock();
      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_media_timeout')!.voipInstance = harness.voipMock;

      let mediaErrorFired = false;
      service.on('call:media-error', () => {
        mediaErrorFired = true;
      });

      const stream = await service.startVideoCall({
        sessionId: 'sess_media_timeout',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        mediaStartTimeoutMs: 70,
      });

      const callInst = harness.createdCallInstances[0]!;
      callInst.emit('ringing');
      callInst.emit('connected');

      assert.equal(stream.callState, 'MEDIA_NEGOTIATING');
      assert.equal(stream.mediaStarted, false);

      // Wait for mediaStartTimeoutMs (70ms) to expire with zero outbound RTP/SRTP packets
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(mediaErrorFired, true);
      assert.equal(stream.callState, 'FAILED');
      assert.equal(stream.mediaStarted, false);
      assert.equal(stream.mediaFailed, true);
      assert.ok(stream.failureReason?.includes('MEDIA_FAILED'));
      assert.ok(!stream.stateHistory.includes('MEDIA_STARTED'));
      assert.equal(callInst.hangupCalls, 1);
      assert.equal(callInst.listenerCount('connected'), 0);

      service.detachSession('sess_media_timeout');
    });

    it('Tests 8 & 9: calls call.hangup() on stopVideoCall, and falls back to voip.hangup(callId) when call.hangup is unavailable', async () => {
      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );

      const rawSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        ws: { isOpen: true },
      };

      // (8) Primary path: callInstance.hangup() is invoked on stopVideoCall
      service.attachSession('sess_hangup_primary', rawSocket);
      const harnessPrimary = createRealisticHiroosyVoipMock();
      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_hangup_primary')!.voipInstance =
        harnessPrimary.voipMock;

      const stream1 = await service.startVideoCall({
        sessionId: 'sess_hangup_primary',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });
      const callInst1 = harnessPrimary.createdCallInstances[0]!;
      callInst1.emit('ringing');

      await service.stopVideoCall('sess_hangup_primary', stream1.callId);
      assert.equal(callInst1.hangupCalls, 1);
      assert.equal(harnessPrimary.voipMock.voipHangupCallIds.length, 0);
      assert.equal(stream1.callState, 'ENDED');

      // (9) Fallback path: when callInstance.hangup is unavailable, voip.hangup(callId) is invoked with callId
      service.attachSession('sess_hangup_fallback', rawSocket);
      const harnessFallback = createRealisticHiroosyVoipMock({
        omitCallInstanceHangup: true,
      });
      attachedMap.get('sess_hangup_fallback')!.voipInstance =
        harnessFallback.voipMock;

      const stream2 = await service.startVideoCall({
        sessionId: 'sess_hangup_fallback',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });
      const callInst2 = harnessFallback.createdCallInstances[0]!;
      callInst2.emit('ringing');

      await service.stopVideoCall('sess_hangup_fallback', stream2.callId);
      assert.deepEqual(harnessFallback.voipMock.voipHangupCallIds, [
        'HIROOSY_CALL_1',
      ]);
      assert.equal(stream2.callState, 'ENDED');

      service.detachSession('sess_hangup_primary');
      service.detachSession('sess_hangup_fallback');
    });

    it('Tests 10, 11, 12, 13: detachSession ends active calls & disposes coordinator, starting a second call does not duplicate listeners, duplicate ended is idempotent, and error event transitions to FAILED safely', async () => {
      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );

      const rawSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        ws: { isOpen: true },
      };
      service.attachSession('sess_lifecycle_10_to_13', rawSocket);

      const harness = createRealisticHiroosyVoipMock();
      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_lifecycle_10_to_13')!.voipInstance =
        harness.voipMock;

      // Call 1: test duplicate 'ended' event idempotency (Test 12)
      const stream1 = await service.startVideoCall({
        sessionId: 'sess_lifecycle_10_to_13',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });
      const callInst1 = harness.createdCallInstances[0]!;
      callInst1.emit('ringing');

      let endedEventsCount = 0;
      const onEnded = () => {
        endedEventsCount += 1;
      };
      service.on('call:ended', onEnded);

      callInst1.emit('ended', 'completed');
      callInst1.emit('ended', 'completed'); // Duplicate ended event
      await service.stopVideoCall('sess_lifecycle_10_to_13', stream1.callId); // Stop after ended

      assert.equal(endedEventsCount, 1, 'ended transition must be idempotent');
      assert.deepEqual(stream1.stateHistory, ['INITIATING', 'RINGING', 'ENDED']);
      service.off('call:ended', onEnded);

      // Call 2 on the same session: verify zero listener duplication (Test 11) and safe 'error' handling (Test 13)
      const stream2 = await service.startVideoCall({
        sessionId: 'sess_lifecycle_10_to_13',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });
      const callInst2 = harness.createdCallInstances[1]!;

      assert.equal(harness.voipMock.listenCalls, 1);
      assert.equal(
        harness.coordinator.listenerCount('call_state'),
        1,
        'Coordinator call_state listener must not be duplicated on second call'
      );
      assert.equal(callInst1.listenerCount('connected'), 0);
      assert.equal(callInst2.listenerCount('connected'), 1);

      // (13) Emit 'error' on VoipCallInstance -> transitions to FAILED without crashing process
      callInst2.emit('ringing');
      assert.doesNotThrow(() => {
        callInst2.emit('error', new Error('SRTP DTLS transport failure'));
      });
      assert.equal(stream2.callState, 'FAILED');
      assert.equal(callInst2.hangupCalls, 1);

      // Call 3 on the same session: verify detachSession ends active call and disposes coordinator (Test 10)
      const stream3 = await service.startVideoCall({
        sessionId: 'sess_lifecycle_10_to_13',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });
      const callInst3 = harness.createdCallInstances[2]!;
      callInst3.emit('ringing');
      assert.equal(stream3.callState, 'RINGING');

      service.detachSession('sess_lifecycle_10_to_13');

      assert.ok(callInst3.hangupCalls >= 1);
      assert.equal(stream3.callState, 'ENDED');
      assert.equal(harness.voipMock.coordinatorDisposed, true);
    });

    it('Tests 14, 15, 16, 17: verifies lockfile/package consistency, zero legacy fork references in bun.lock & package.json, zero legacy imports across src/ & scripts/, and zero PTV/chat-video/fake-offer fallbacks in video-call-bridge.ts', () => {
      const rootDir = process.cwd();
      const legacyForkName = ['athana', 'sia'].join('');
      const legacyForkPkg = `${legacyForkName}-baileys`;
      const legacyForkPattern = new RegExp(
        `${legacyForkName}|${legacyForkName}cmd|github:${legacyForkName}|${legacyForkName}-libsignal`,
        'i'
      );

      // (16) package.json and bun.lock consistency
      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      assert.equal(
        pkgJson.dependencies?.['@hiroosy/baileys-lite'],
        '^0.3.7',
        '@hiroosy/baileys-lite@^0.3.7 must be the sole WhatsApp dependency in package.json'
      );
      assert.equal(pkgJson.dependencies?.[legacyForkPkg], undefined);
      assert.equal(pkgJson.devDependencies?.[legacyForkPkg], undefined);

      // (15) bun.lock contains zero legacy fork references
      const bunLockContent = fs.readFileSync(
        path.join(rootDir, 'bun.lock'),
        'utf8'
      );
      assert.ok(
        bunLockContent.includes('@hiroosy/baileys-lite@'),
        'bun.lock must resolve @hiroosy/baileys-lite'
      );
      assert.equal(
        legacyForkPattern.test(bunLockContent),
        false,
        'bun.lock must NOT contain any legacy fork references'
      );

      // (14) video-call-bridge.ts never calls sendMessage({ video }), ptv: true, or sendNativeVideoCallOffer
      const bridgeSource = fs.readFileSync(
        path.join(rootDir, 'src/whatsapp/video-call-bridge.ts'),
        'utf8'
      );
      assert.equal(
        /sendMediaMessage|sendNativeVideoCallOffer|sendNativeCallOffer|ptv\s*:/.test(
          bridgeSource
        ),
        false,
        'video-call-bridge.ts must never invoke sendMediaMessage, ptv, or sendNativeVideoCallOffer'
      );

      // (17) All TypeScript files in src/ and scripts/ use @hiroosy/baileys-lite and contain zero legacy fork imports
      const collectTsFiles = (dir: string): string[] => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            files.push(...collectTsFiles(full));
          } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
            files.push(full);
          }
        }
        return files;
      };

      const sourceFiles = [
        ...collectTsFiles(path.join(rootDir, 'src')),
        ...collectTsFiles(path.join(rootDir, 'scripts')),
      ];
      for (const file of sourceFiles) {
        const content = fs.readFileSync(file, 'utf8');
        assert.equal(
          legacyForkPattern.test(content),
          false,
          `File ${path.relative(rootDir, file)} must not reference legacy fork package`
        );
      }
    });

    it('enforces multi-tenant isolation (IDOR prevention) in InboxHandler and StoriesHandler between Subscriber A and Subscriber B', async () => {
      const dbPath = path.join(tmpDir, 'tenant_idor_test.sqlite');
      const db = new AppDatabase(dbPath);
      const inboxRepo = new InboxRepository(db);
      const statusRepo = new StatusRepository(db);
      const sessionRepo = new SessionRepository(db);
      const auditRepo = new AuditRepository(db);
      const sessionStore = new SessionStore(path.join(tmpDir, 'wa-sessions'));
      const sessionManager = new SessionManager(
        sessionRepo,
        auditRepo,
        sessionStore,
        (id) => new MockWhatsAppSessionDriver(id)
      );

      const ownerAdminId = 1000;
      const subscriberA = 2001;
      const subscriberB = 2002;
      sessionManager.setConfiguredAdminId(ownerAdminId);

      const sessA = sessionManager.createSession('Sess A', subscriberA);

      const receiver = new IncomingMessageReceiver(inboxRepo, sessionRepo, tmpDir);
      const statusDownloader = new StatusDownloaderService(
        statusRepo,
        sessionRepo,
        tmpDir
      );

      const inboxHandler = new InboxHandler(inboxRepo, receiver, sessionManager);
      const storiesHandler = new StoriesHandler(
        statusRepo,
        statusDownloader,
        sessionManager
      );

      const msgFile = path.join(tmpDir, 'sub_a_msg.txt');
      fs.writeFileSync(msgFile, 'Secret message for Subscriber A');
      const msgRecord = inboxRepo.recordIncoming({
        sessionId: sessA.id,
        ownerTelegramId: subscriberA,
        senderJid: '966501112222@s.whatsapp.net',
        senderPhone: '+966501112222',
        messageKind: 'text',
        textContent: 'Secret message for Subscriber A',
        savedFilePath: msgFile,
        savedFileName: 'sub_a_msg.txt',
        mimeType: 'text/plain',
        fileSizeBytes: 32,
      });

      const statusFile = path.join(tmpDir, 'sub_a_status.txt');
      fs.writeFileSync(statusFile, 'Secret status for Subscriber A');
      const statusRecord = statusRepo.recordStatus({
        sessionId: sessA.id,
        ownerTelegramId: subscriberA,
        authorJid: '966501112222@s.whatsapp.net',
        authorPhone: '+966501112222',
        mediaKind: 'text',
        caption: 'Secret status for Subscriber A',
        savedFilePath: statusFile,
        savedFileName: 'sub_a_status.txt',
        mimeType: 'text/plain',
        fileSizeBytes: 31,
      });

      const viewByB = inboxHandler.viewMessage(subscriberB, msgRecord.id);
      assert.ok(viewByB.text.includes('لم يتم العثور على الرسالة'));

      const dlMsgByB = inboxHandler.downloadMessageFile(subscriberB, msgRecord.id);
      assert.equal(dlMsgByB.mediaAttachments, undefined);

      const promptFwdByB = inboxHandler.promptForward(subscriberB, msgRecord.id);
      assert.ok(promptFwdByB.text.includes('لم يتم العثور على الرسالة'));

      const dlStatusByB = storiesHandler.downloadStatus(
        subscriberB,
        statusRecord.id
      );
      assert.equal(dlStatusByB.mediaAttachments, undefined);

      const viewByA = inboxHandler.viewMessage(subscriberA, msgRecord.id);
      assert.ok(viewByA.text.includes('Secret message for Subscriber A'));

      const dlStatusByA = storiesHandler.downloadStatus(
        subscriberA,
        statusRecord.id
      );
      assert.equal(dlStatusByA.mediaAttachments?.length, 1);

      db.close();
    });

    it('preserves and calls WaVideoEngine.prototype.start in instrumentVideoEngineInstance and forwards (node, peerJid) in patchedHandleCallAccept', async () => {
      let origStartInvocations = 0;
      const fakeVideoEngine: Record<string, unknown> = {
        _deliberateStop: true,
        running: false,
        waitForKeyFrame: false,
        waitingForKeyFrame: false,
        videoLoop: true,
        start() {
          origStartInvocations++;
        },
        stop() {
          this._deliberateStop = true;
          this.running = false;
        },
      };

      instrumentVideoEngineInstance(
        fakeVideoEngine as unknown as Parameters<
          typeof instrumentVideoEngineInstance
        >[0]
      );
      (fakeVideoEngine.start as () => void)();

      assert.equal(
        origStartInvocations,
        1,
        'instrumentVideoEngineInstance must call origStart so ffmpeg H.264 outbound streaming starts'
      );
      assert.equal(fakeVideoEngine._deliberateStop, false);
      assert.equal(fakeVideoEngine.running, true);
      assert.equal(fakeVideoEngine.waitForKeyFrame, true);
      assert.equal(fakeVideoEngine.waitingForKeyFrame, true);

      // Verify patchedHandleCallAccept forwards both (node, peerJid) and synchronizes videoSrtpSession
      let capturedArgs: unknown[] = [];
      const peerKeyBytes = new Uint8Array(16).fill(0x42);
      const peerSaltBytes = new Uint8Array(14).fill(0x24);
      const peerAuthBytes = new Uint8Array(20).fill(0x99);
      const fakeMediaSession: Record<string, unknown> = {
        videoEnabled: true,
        localVideoSsrc: 1111,
        videoRtpStream: { ssrc: 1111 },
        videoEngine: fakeVideoEngine,
        srtpSession: {
          sendCtx: {
            sessionKey: new Uint8Array(16).fill(0x11),
            sessionSalt: new Uint8Array(14).fill(0x22),
            authKey: new Uint8Array(20).fill(0x33),
          },
          recvCtx: {
            sessionKey: peerKeyBytes,
            sessionSalt: peerSaltBytes,
            authKey: peerAuthBytes,
          },
        },
        videoSrtpSession: null,
        async handleCallAccept(...args: unknown[]) {
          capturedArgs = args;
          return true;
        },
      };

      instrumentMediaSessionInstance(fakeMediaSession);
      const acceptNode = { tag: 'accept', attrs: { 'call-id': 'call_123' }, content: [] };
      const peerDeviceJid = '966501234567:0@s.whatsapp.net';
      await (
        fakeMediaSession.handleCallAccept as (
          node: unknown,
          peerJid: string
        ) => Promise<unknown>
      )(acceptNode, peerDeviceJid);

      assert.equal(capturedArgs.length, 2);
      assert.equal(capturedArgs[0], acceptNode);
      assert.equal(
        capturedArgs[1],
        peerDeviceJid,
        'patchedHandleCallAccept must forward peerJid (2nd argument) so ensureDeviceJid does not throw'
      );
      assert.ok(
        fakeMediaSession.videoSrtpSession,
        'patchedHandleCallAccept must initialize/sync videoSrtpSession'
      );
      const vidSrtp = fakeMediaSession.videoSrtpSession as {
        sendCtx: { sessionKey: Uint8Array; sessionSalt: Uint8Array; authKey: Uint8Array };
        recvCtx: { sessionKey: Uint8Array; sessionSalt: Uint8Array; authKey: Uint8Array };
      };
      assert.deepEqual(
        vidSrtp.sendCtx.sessionKey,
        new Uint8Array(16).fill(0x11),
        'videoSrtpSession.sendCtx MUST use local outbound callKey and NEVER be overwritten with peerCallKey'
      );
      assert.deepEqual(
        vidSrtp.recvCtx.sessionKey,
        peerKeyBytes,
        'videoSrtpSession.recvCtx must hold peer recv keys for inbound decryption'
      );
      assert.ok(
        fakeMediaSession.__peerRecvCtx,
        'patchedHandleCallAccept must store __peerRecvCtx for VoipCallRecorder'
      );
    });

    it('keeps a connected call with maxDurationSeconds=180 alive past 30s without ringingTimeout or mediaStartTimeout disconnecting it', async () => {
      const service = new RealVideoCallService();
      const mockDriver = await createConnectedMockDriver('sess_180s_test');

      const stream = await service.startVideoCall({
        sessionId: 'sess_180s_test',
        driver: mockDriver,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        maxDurationSeconds: 180,
        callTimeoutMs: 50,
        mediaStartTimeoutMs: 1200,
        simulateLifecycle: 'auto',
      });

      assert.equal(stream.callState, 'MEDIA_STARTED');
      assert.equal(stream.maxDurationSeconds, 180);

      // Wait longer than callTimeoutMs (50ms) and verify call was NOT terminated by ringingTimeout
      await new Promise((r) => setTimeout(r, 90));
      const activeAfterRingingWindow = service.getCallStatus(stream.callId);
      assert.ok(activeAfterRingingWindow);
      assert.equal(activeAfterRingingWindow.callState, 'MEDIA_STARTED');
      assert.equal(activeAfterRingingWindow.status, 'MEDIA_STARTED');

      await service.stopVideoCall('sess_180s_test', stream.callId);
    });

    it('extracts and renders deep sender forensics (sender name, phone, carrier NDC, @lid resolution, raw stanza :device, View-Once unwrapping, live edits, and sync-stanza filtering) in InboxHandler', async () => {
      const dbPath = path.join(tmpDir, 'inbox_forensics_test.db');
      const appDb = new AppDatabase(dbPath);
      const inboxRepo = new InboxRepository(appDb);
      const sessionRepo = new SessionRepository(appDb);
      const auditRepo = new AuditRepository(appDb);
      const sessionStore = new SessionStore(path.join(tmpDir, 'sessions_forensics'));
      const sessionManager = new SessionManager(
        sessionRepo,
        auditRepo,
        sessionStore,
        (id) => new MockWhatsAppSessionDriver(id)
      );
      sessionManager.setConfiguredAdminId(777001);

      const session = sessionManager.createSession('Forensics Session', 777001);
      const receiver = new IncomingMessageReceiver(
        inboxRepo,
        sessionRepo,
        path.join(tmpDir, 'data_forensics')
      );
      const inboxHandler = new InboxHandler(inboxRepo, receiver, sessionManager);

      // 1. Standard iOS message with raw stanza :device and explicit IP
      const rec = await receiver.processIncomingMessage({
        sessionId: session.id,
        rawMessage: {
          key: {
            remoteJid: '966501234567:2@s.whatsapp.net',
            fromMe: false,
            id: '3A998877665544332211',
          },
          pushName: 'خالد العتيبي',
          senderIp: '188.54.122.91 (بوابة الرياض — STC / Relay: 157.240.20.60)',
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: {
            extendedTextMessage: {
              text: 'رسالة اختبار مع تفاصيل المرسل والجهاز والـ IP',
              contextInfo: {
                forwardingScore: 2,
                isForwarded: true,
                quotedMessage: {
                  conversation: 'الرسالة الأصلية المقتبس منها',
                },
              },
            },
          },
        },
      });

      assert.ok(rec, 'Expected incoming message record to be created');
      assert.equal(rec.sender_name, 'خالد العتيبي');
      assert.equal(rec.sender_phone, '+966501234567');
      assert.ok(rec.sender_country?.includes('السعودية'), 'Expected Saudi Arabia country');
      assert.ok(rec.sender_country?.includes('STC'), 'Expected STC carrier from +96650 NDC');
      assert.ok(rec.sender_device_type?.includes('آيفون — iOS'));
      assert.ok(rec.sender_device_type?.includes('جهاز مرتبط #2'));
      assert.equal(
        rec.sender_ip,
        '188.54.122.91 (بوابة الرياض — STC / Relay: 157.240.20.60)'
      );
      assert.equal(rec.forwarding_score, 2);
      assert.equal(rec.quoted_message_summary, 'الرسالة الأصلية المقتبس منها');
      assert.ok(rec.file_sha256 && rec.file_sha256.length === 64);

      // 2. Live edit delivered via messages.update (__isLiveEditUpdate + __editedTargetId)
      const editedRec = await receiver.processIncomingMessage({
        sessionId: session.id,
        rawMessage: {
          key: {
            remoteJid: '966501234567@s.whatsapp.net',
            fromMe: false,
            id: '3A998877665544332211',
          },
          __isLiveEditUpdate: true,
          __editedTargetId: '3A998877665544332211',
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: {
            editedMessage: {
              message: {
                extendedTextMessage: {
                  text: 'النص الجديد بعد التعديل الحي عبر messages.update',
                },
              },
            },
          },
        },
      });

      assert.ok(editedRec, 'Expected live edit to update original record');
      assert.equal(editedRec.id, rec.id);
      assert.equal(Boolean(editedRec.is_edited), true);
      assert.equal(editedRec.original_text, 'رسالة اختبار مع تفاصيل المرسل والجهاز والـ IP');
      assert.equal(editedRec.text_content, 'النص الجديد بعد التعديل الحي عبر messages.update');

      // 3. Linked Identity (@lid) resolved via sock.signalRepository.lidMapping.getPNForLID + raw stanza :33 companion
      const fakeSockWithLidMap = {
        signalRepository: {
          lidMapping: {
            async getPNForLID(lid: string) {
              if (lid.startsWith('99887766554433')) {
                return '967771234567:0@s.whatsapp.net';
              }
              return null;
            },
          },
        },
      };

      const lidRec = await receiver.processIncomingMessage({
        sessionId: session.id,
        sock: fakeSockWithLidMap as never,
        rawMessage: {
          key: {
            remoteJid: '99887766554433@lid',
            fromMe: false,
            id: '3EB0A1B2C3D4E5F60011',
          },
          __rawStanzaMeta: {
            id: '3EB0A1B2C3D4E5F60011',
            rawFrom: '99887766554433:33@lid',
            addressingMode: 'lid',
            encType: 'pkmsg',
            capturedAt: Date.now(),
          },
          __contactInfo: {
            id: '99887766554433@lid',
            notify: 'أحمد اليافعي',
          },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: {
            viewOnceMessageV2: {
              message: {
                imageMessage: {
                  caption: 'صورة عرض لمرة واحدة عبر معرف مرتبط @lid',
                  mimetype: 'image/jpeg',
                },
              },
            },
          },
        },
      });

      assert.ok(lidRec, 'Expected @lid View-Once message to be unwrapped and archived');
      assert.equal(lidRec.kind, 'image');
      assert.equal(lidRec.sender_name, 'أحمد اليافعي');
      assert.equal(lidRec.sender_phone, '+967771234567');
      assert.ok(lidRec.sender_country?.includes('اليمن'));
      assert.ok(lidRec.sender_country?.includes('Yemen Mobile'));
      assert.ok(lidRec.sender_device_type?.includes('واتساب ويب'));
      assert.ok(lidRec.sender_device_type?.includes('#33'));
      assert.ok(lidRec.sender_ip?.includes('Yemen Mobile'));
      assert.ok(lidRec.sender_ip?.includes('Signal:pkmsg'));

      // 4. Internal non-user sync protocolMessage (HISTORY_SYNC_NOTIFICATION) must be ignored
      const ignoredSync = await receiver.processIncomingMessage({
        sessionId: session.id,
        rawMessage: {
          key: {
            remoteJid: '966501234567@s.whatsapp.net',
            fromMe: false,
            id: '3EB0SYNC000011112222',
          },
          message: {
            protocolMessage: {
              type: 5, // HISTORY_SYNC_NOTIFICATION
            },
          },
        },
      });
      assert.equal(ignoredSync, null, 'Internal sync protocolMessage must not create an inbox record');

      const listMenu = inboxHandler.renderInboxMenu(777001, 1);
      assert.ok(listMenu.text.includes('اسم المرسل:'));
      assert.ok(listMenu.text.includes('خالد العتيبي'));
      assert.ok(listMenu.text.includes('رقم المرسل:'));
      assert.ok(listMenu.text.includes('+966501234567'));
      assert.ok(listMenu.text.includes('نوع جهاز المرسل:'));
      assert.ok(listMenu.text.includes('آيفون — iOS'));
      assert.ok(listMenu.text.includes('عنوان IP المرسل:'));
      assert.ok(listMenu.text.includes('188.54.122.91'));

      const detailView = inboxHandler.viewMessage(777001, rec.id);
      assert.ok(detailView.text.includes('هوية المرسل'));
      assert.ok(detailView.text.includes('بصمة الجهاز والشبكة'));
      assert.ok(detailView.text.includes('خالد العتيبي'));
      assert.ok(detailView.text.includes('+966501234567'));
      assert.ok(detailView.text.includes('آيفون — iOS'));
      assert.ok(detailView.text.includes('188.54.122.91'));
      assert.ok(detailView.text.includes('الرسالة الأصلية المقتبس منها'));
      assert.ok(detailView.text.includes('النص الأصلي (قبل التعديل)'));
      assert.ok(detailView.text.includes('تم تعديل هذه الرسالة من قبل المرسل'));
      assert.ok(detailView.text.includes('النص الجديد بعد التعديل الحي'));

      const savedComparisonDiskContent = fs.readFileSync(editedRec.file_path, 'utf8');
      assert.ok(savedComparisonDiskContent.includes('النسخة الأولى'));
      assert.ok(savedComparisonDiskContent.includes('النسخة المحدثة'));

      appDb.close();
    });

    it('resolves @lid device sessions (e.g. 36597986795687@lid) via PN fallback, migrates Signal sessions, and prevents "no device sessions to encrypt the call offer"', async () => {
      await ensureHiroosyVoipRuntimePatched();

      const targetPnJid = '967771234567@s.whatsapp.net';
      const targetLidJid = '36597986795687@lid';
      const migratedPairs: Array<{ fromJid: string; toJid: string }> = [];
      const assertedSessionBatches: string[][] = [];
      const usyncQueries: string[][] = [];

      const rawSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        ws: { isOpen: true },
        authState: {
          creds: {
            me: {
              id: '966500000000:1@s.whatsapp.net',
              lid: '11223344556677:1@lid',
            },
          },
          keys: {
            get: async () => ({}),
            set: async () => undefined,
          },
        },
        signalRepository: {
          lidMapping: {
            getLIDForPN: async (pn: string) =>
              pn.startsWith('967771234567') ? targetLidJid : null,
            getPNForLID: async (lid: string) =>
              lid.startsWith('36597986795687') ? targetPnJid : null,
            storeLIDPNMappings: async () => undefined,
          },
          migrateSession: async (fromJid: string, toJid: string) => {
            migratedPairs.push({ fromJid, toJid });
            return { migrated: 2, skipped: 0, total: 2 };
          },
          injectE2ESession: async () => undefined,
          encryptMessage: async () => ({
            type: 'pkmsg',
            ciphertext: Buffer.from([1, 2, 3, 4]),
          }),
          decryptMessage: async () => Buffer.from([1, 2, 3, 4]),
          jidToSignalProtocolAddress: (jid: string) => jid,
        },
        // Simulate WhatsApp USync server returning [] when queried directly with @lid after userDevicesCache expires,
        // but returning the primary + companion device when queried with the counterpart @s.whatsapp.net PN JID:
        getUSyncDevices: async (jids: string[]) => {
          usyncQueries.push(jids);
          if (jids.every((j) => j.endsWith('@lid'))) {
            return [];
          }
          return [
            { user: '967771234567', device: 0 },
            { user: '967771234567', device: 33 },
          ];
        },
        assertSessions: async (jids: string[]) => {
          assertedSessionBatches.push(jids);
          return true;
        },
      };

      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );
      service.attachSession('sess_lid_voip_fix', rawSocket);

      const harness = createRealisticHiroosyVoipMock();
      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_lid_voip_fix')!.voipInstance = harness.voipMock;

      const stream = await service.startVideoCall({
        sessionId: 'sess_lid_voip_fix',
        socket: rawSocket,
        recipientJid: targetPnJid,
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });

      assert.ok(stream.voipCallInstance);

      // Verify wrapped getUSyncDevices on rawSocket now resolves 36597986795687@lid via PN fallback
      const wrappedGetUSyncDevices = rawSocket.getUSyncDevices as (
        jids: string[],
        useCache?: boolean,
        ignoreZeroDevices?: boolean
      ) => Promise<Array<{ user: string; device: number; jid?: string }>>;

      const resolvedLidDevices = await wrappedGetUSyncDevices(
        [targetLidJid],
        true,
        false
      );
      assert.ok(
        resolvedLidDevices.length >= 2,
        'Wrapped getUSyncDevices(["36597986795687@lid"]) must return primary + companion LID devices via PN fallback'
      );
      assert.ok(
        resolvedLidDevices.some(
          (d) => d.user === '36597986795687' && d.device === 0 && d.jid === '36597986795687@lid'
        ),
        'Primary LID device 0 (36597986795687@lid) must be present with .jid populated'
      );
      assert.ok(
        resolvedLidDevices.some(
          (d) => d.user === '36597986795687' && d.device === 33 && d.jid === '36597986795687:33@lid'
        ),
        'Companion LID device 33 (36597986795687:33@lid) must be mapped onto the LID user'
      );
      assert.ok(
        migratedPairs.some(
          (p) => p.fromJid === targetPnJid && p.toJid === targetLidJid
        ),
        'Signal session must be migrated from PN JID to LID JID'
      );

      await service.stopVideoCall('sess_lid_voip_fix', stream.callId);
      service.detachSession('sess_lid_voip_fix');
    });

    it('awaits finalizeStreamRecording BEFORE emitting call:ended and resets videoSrtpSession.recvCtx replay/ROC when peer keys change', async () => {
      const { syncReceiveOnlySrtpOnMediaSession } = await import(
        '../../src/whatsapp/voip-runtime-patch'
      );

      // 1. Verify replay/ROC state resets on peer key switch without touching sendCtx
      const randBytes = (len: number) =>
        crypto.getRandomValues(new Uint8Array(len));
      const initialLocalKey = randBytes(16);
      const newPeerKey = randBytes(16);
      const sendKey = randBytes(16);
      const fakeNativeSession: Record<string, unknown> = {
        srtpSession: {
          recvCtx: {
            sessionKey: newPeerKey,
            sessionSalt: randBytes(14),
            authKey: randBytes(20),
            authTagLen: 10,
          },
        },
        videoSrtpSession: {
          sendCtx: {
            sessionKey: sendKey,
            sessionSalt: randBytes(14),
            authKey: randBytes(20),
            authTagLen: 4,
          },
          recvCtx: {
            sessionKey: initialLocalKey,
            sessionSalt: randBytes(14),
            authKey: randBytes(20),
            authTagLen: 4,
            initialized: true,
            roc: 5,
            lastSeq: 900,
            highestIndex: BigInt(900),
            replayMask: BigInt(0xff),
          },
        },
      };

      syncReceiveOnlySrtpOnMediaSession(fakeNativeSession);
      const videoSrtp = fakeNativeSession.videoSrtpSession as {
        sendCtx: { sessionKey: Uint8Array };
        recvCtx: {
          sessionKey: Uint8Array;
          initialized: boolean;
          roc: number;
          lastSeq: number;
          highestIndex: bigint;
          replayMask: bigint;
        };
      };
      assert.deepEqual(videoSrtp.sendCtx.sessionKey, sendKey);
      assert.deepEqual(videoSrtp.recvCtx.sessionKey, newPeerKey);
      assert.equal(videoSrtp.recvCtx.initialized, false);
      assert.equal(videoSrtp.recvCtx.roc, 0);
      assert.equal(videoSrtp.recvCtx.lastSeq, 0);
      assert.equal(videoSrtp.recvCtx.highestIndex, BigInt(0));
      assert.equal(videoSrtp.recvCtx.replayMask, BigInt(0));

      // 2. Verify RealVideoCallService awaits finalizeStreamRecording BEFORE emitting call:ended
      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );

      const rawSocket = {
        authState: { creds: { me: { id: '966500000000@s.whatsapp.net' } } },
        ev: new EventEmitter(),
        ws: { send: async () => undefined },
      };
      service.attachSession('sess_finalize_order', rawSocket);

      const harness = createRealisticHiroosyVoipMock();
      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_finalize_order')!.voipInstance = harness.voipMock;

      const eventOrder: string[] = [];
      service.on('call:recording-ready', () => {
        eventOrder.push('recording-ready');
      });
      service.on('call:recording-no-remote-camera', () => {
        eventOrder.push('recording-no-remote-camera');
      });

      const endedPromise = new Promise<{
        state: string;
        recordingStatus?: string;
      }>((resolve) => {
        service.once('call:ended', (payload: { callId: string; state: string }) => {
          eventOrder.push('call:ended');
          const status = service.getCallStatus(payload.callId);
          resolve({
            state: payload.state,
            recordingStatus: status?.recordingStatus,
          });
        });
      });

      const stream = await service.startVideoCall({
        sessionId: 'sess_finalize_order',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
        recordCall: true,
      });

      const callInst = harness.createdCallInstances[0]!;
      callInst.emit('connected');
      callInst.emit('ended', 'completed');

      const endedResult = await endedPromise;
      assert.equal(endedResult.state, 'ENDED');
      assert.equal(endedResult.recordingStatus, 'NO_REMOTE_CAMERA');
      assert.deepEqual(
        eventOrder,
        ['recording-no-remote-camera', 'call:ended'],
        'Recording finalization MUST complete and emit recording event BEFORE call:ended fires when call connected'
      );
      assert.equal(stream.hasConnected, true);
      assert.equal(stream.recordingStatus, 'NO_REMOTE_CAMERA');

      service.detachSession('sess_finalize_order');
    });

    it('clears stale voip.calls before voip.call(), retries once on "max concurrent calls reached (1)", and skips false NO_REMOTE_CAMERA when call never connected', async () => {
      const service = new RealVideoCallService();
      service.setCompatibilityOverride(
        runBaileysCompatibilityProbe({ requireLiveSocket: false })
      );

      const rawSocket = {
        authState: { creds: { me: { id: '966500000000@s.whatsapp.net' } } },
        ev: new EventEmitter(),
        ws: { send: async () => undefined },
      };

      // 1. Stale voip.calls must be cleared BEFORE voip.call() even while new stream is INITIALIZING in activeStreams
      service.attachSession('sess_stale_voip_calls', rawSocket);
      const harnessStale = createRealisticHiroosyVoipMock();
      const staleCallsArray: unknown[] = [{ callId: 'STALE_1' }];
      const endForceArgs: boolean[] = [];
      let callAttempts = 0;

      const voipWithStale = Object.assign(harnessStale.voipMock, {
        get calls() {
          return staleCallsArray;
        },
        async end(force = false) {
          endForceArgs.push(Boolean(force));
          if (force) {
            staleCallsArray.length = 0;
          }
          harnessStale.callsMap.clear();
        },
      });
      const origCall = voipWithStale.call.bind(voipWithStale);
      voipWithStale.call = async (jid: string, media: string, preset: string) => {
        callAttempts += 1;
        if (staleCallsArray.length > 0) {
          throw new Error('max concurrent calls reached (1)');
        }
        return origCall(jid, media, preset);
      };

      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      attachedMap.get('sess_stale_voip_calls')!.voipInstance = voipWithStale;

      const streamOk = await service.startVideoCall({
        sessionId: 'sess_stale_voip_calls',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });

      assert.equal(callAttempts, 1, 'Pre-call drain must clear stale voip.calls before first voip.call()');
      assert.ok(endForceArgs.includes(true), 'voip.end(true) must be invoked to clear stale calls');
      assert.ok(streamOk.voipCallInstance);

      // Verify getActiveStreamForSession(..., ignoreCallId) excludes the specified callId
      assert.equal(
        service.getActiveStreamForSession('sess_stale_voip_calls', streamOk.callId),
        undefined
      );

      // Ended WITHOUT connected -> MUST NOT emit call:recording-no-remote-camera
      let falseNoCamEvents = 0;
      service.on('call:recording-no-remote-camera', () => {
        falseNoCamEvents += 1;
      });
      await service.stopVideoCall('sess_stale_voip_calls', streamOk.callId);
      assert.equal(falseNoCamEvents, 0, 'Non-connected call must NEVER emit call:recording-no-remote-camera');
      assert.equal(streamOk.hasConnected, false);
      assert.notEqual(streamOk.recordingStatus, 'NO_REMOTE_CAMERA');

      // 2. Automatic 1-time recovery retry if voip.call() throws "max concurrent calls reached (1)" despite empty voip.calls
      service.attachSession('sess_retry_concurrent', rawSocket);
      const harnessRetry = createRealisticHiroosyVoipMock();
      const retryEndForceArgs: boolean[] = [];
      let retryCallAttempts = 0;
      const voipRetry = Object.assign(harnessRetry.voipMock, {
        calls: [] as unknown[],
        async end(force = false) {
          retryEndForceArgs.push(Boolean(force));
        },
      });
      const origRetryCall = voipRetry.call.bind(voipRetry);
      voipRetry.call = async (jid: string, media: string, preset: string) => {
        retryCallAttempts += 1;
        if (retryCallAttempts === 1) {
          throw new Error('max concurrent calls reached (1)');
        }
        return origRetryCall(jid, media, preset);
      };
      attachedMap.get('sess_retry_concurrent')!.voipInstance = voipRetry;

      const streamRetried = await service.startVideoCall({
        sessionId: 'sess_retry_concurrent',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validLandscapeMp4,
        allowedRootDirs: [tmpDir],
      });
      assert.equal(retryCallAttempts, 2, 'Must automatically retry voip.call() once after max concurrent calls error');
      assert.ok(retryEndForceArgs.includes(true));
      assert.ok(streamRetried.voipCallInstance);

      await service.stopVideoCall('sess_retry_concurrent', streamRetried.callId);

      // 3. Permanent failure during INITIALIZING must NOT emit call:recording-no-remote-camera
      service.attachSession('sess_fail_init_nocam', rawSocket);
      const harnessAlwaysBusy = createRealisticHiroosyVoipMock();
      const voipAlwaysBusy = Object.assign(harnessAlwaysBusy.voipMock, {
        calls: [] as unknown[],
        async end() {
          // Simulates stuck call
        },
      });
      voipAlwaysBusy.call = async () => {
        throw new Error('max concurrent calls reached (1)');
      };
      attachedMap.get('sess_fail_init_nocam')!.voipInstance = voipAlwaysBusy;

      await assert.rejects(() =>
        service.startVideoCall({
          sessionId: 'sess_fail_init_nocam',
          socket: rawSocket,
          recipientJid: '966501234567@s.whatsapp.net',
          videoFilePath: validLandscapeMp4,
          allowedRootDirs: [tmpDir],
        })
      );
      assert.equal(
        falseNoCamEvents,
        0,
        'Failed call during INITIALIZING must NEVER emit call:recording-no-remote-camera'
      );

      service.detachSession('sess_stale_voip_calls');
      service.detachSession('sess_retry_concurrent');
      service.detachSession('sess_fail_init_nocam');
    });
  });
});



