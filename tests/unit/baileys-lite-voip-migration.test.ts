import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

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
import { MockWhatsAppSessionDriver } from '../../src/whatsapp/connection-manager';
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

  describe('Phase 6 & 7: RealVideoCallService State Machine & Strict Anti-PTV Guarantees', () => {
    it('drives full call state machine (INITIATING -> RINGING -> CONNECTING -> CONNECTED -> MEDIA_NEGOTIATING -> MEDIA_STARTED -> MEDIA_STOPPED -> ENDED) and sends ZERO PTV/chat messages', async () => {
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

      // Strictly verify NO PTV or chat video message was ever sent!
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

    it('normalizes portrait resolution preset (360p_portrait -> 360p) when calling Voip.call and transitions through call:ringing -> call:connected -> call:ended with VoipCallInstance payloads while reusing Voip instance per session', async () => {
      const service = new RealVideoCallService();
      const compatReport = runBaileysCompatibilityProbe({
        requireLiveSocket: false,
      });
      service.setCompatibilityOverride(compatReport);

      const rawSocket: Record<string, unknown> = {
        ev: new EventEmitter(),
        ws: { isOpen: true },
      };
      service.attachSession('sess_real_voip_portrait', rawSocket);

      // Inject a fake Voip instance onto the attached session context that mimics @hiroosy/baileys-lite/voip
      const fakeVoipEmitter = new EventEmitter() as EventEmitter & {
        listenCalls: number;
        receivedPresets: string[];
        hangupCalls: number;
        listen: () => Promise<void>;
        call: (
          jid: string,
          videoPath: string,
          preset: string,
          opts: Record<string, unknown>
        ) => Promise<EventEmitter & { callId: string; jid: string }>;
        hangup: () => Promise<void>;
        coordinator: { disposed: boolean; dispose: () => void };
      };
      fakeVoipEmitter.listenCalls = 0;
      fakeVoipEmitter.receivedPresets = [];
      fakeVoipEmitter.hangupCalls = 0;
      fakeVoipEmitter.coordinator = {
        disposed: false,
        dispose() {
          this.disposed = true;
        },
      };
      fakeVoipEmitter.listen = async () => {
        fakeVoipEmitter.listenCalls += 1;
      };
      fakeVoipEmitter.hangup = async () => {
        fakeVoipEmitter.hangupCalls += 1;
      };
      fakeVoipEmitter.call = async (jid, _videoPath, preset) => {
        const validPresets = ['240p', '360p', '480p', '720p', '1080p'];
        if (!validPresets.includes(preset)) {
          throw new Error(
            `Unknown resolution "${preset}". Use one of: 240p, 360p, 480p, 720p, 1080p, or pass { width, height, frameRate } directly.`
          );
        }
        fakeVoipEmitter.receivedPresets.push(preset);
        const callInstance = new EventEmitter() as EventEmitter & {
          callId: string;
          jid: string;
        };
        callInstance.callId = `HIROOSY_CALL_${fakeVoipEmitter.receivedPresets.length}`;
        callInstance.jid = jid;
        return callInstance;
      };

      const attachedMap = (
        service as unknown as {
          attachedSessions: Map<string, { voipInstance?: unknown }>;
        }
      ).attachedSessions;
      const ctx = attachedMap.get('sess_real_voip_portrait')!;
      ctx.voipInstance = fakeVoipEmitter;

      const stream = await service.startVideoCall({
        sessionId: 'sess_real_voip_portrait',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validPortraitMp4,
        allowedRootDirs: [tmpDir],
      });

      // Stream keeps '360p_portrait' for UI/assertions, while Voip.call received '360p'
      assert.equal(stream.resolutionPreset, '360p_portrait');
      assert.deepEqual(fakeVoipEmitter.receivedPresets, ['360p']);
      assert.equal(fakeVoipEmitter.listenCalls, 1);
      assert.equal(stream.callState, 'RINGING');

      // Emit 'call:ringing' then 'call:connected' with a VoipCallInstance payload ({ callId, jid })
      fakeVoipEmitter.emit('call:ringing', {
        callId: 'HIROOSY_CALL_1',
        jid: '966501234567@s.whatsapp.net',
      });
      fakeVoipEmitter.emit('call:connected', {
        callId: 'HIROOSY_CALL_1',
        jid: '966501234567@s.whatsapp.net',
      });
      // Duplicate connected event should be idempotent
      fakeVoipEmitter.emit('call:connected', {
        callId: 'HIROOSY_CALL_1',
        jid: '966501234567@s.whatsapp.net',
      });

      assert.equal(stream.callState, 'MEDIA_STARTED');
      assert.equal(stream.mediaStarted, true);

      // Emit 'call:ended' with VoipCallInstance payload
      fakeVoipEmitter.emit('call:ended', {
        callId: 'HIROOSY_CALL_1',
        jid: '966501234567@s.whatsapp.net',
        options: { reason: 'completed' },
      });

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

      // Start a second call on the same session and verify Voip instance is reused (listen called only once)
      const stream2 = await service.startVideoCall({
        sessionId: 'sess_real_voip_portrait',
        socket: rawSocket,
        recipientJid: '966501234567@s.whatsapp.net',
        videoFilePath: validPortraitMp4,
        allowedRootDirs: [tmpDir],
      });
      assert.equal(fakeVoipEmitter.listenCalls, 1);
      assert.equal(
        fakeVoipEmitter.listenerCount('call:connected'),
        1,
        'Previous call listeners must be cleaned up when call ends'
      );
      await service.stopVideoCall('sess_real_voip_portrait', stream2.callId);
      service.detachSession('sess_real_voip_portrait');
      assert.equal(fakeVoipEmitter.coordinator.disposed, true);
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

      // Subscriber B must NOT be able to view, download, or forward Subscriber A's message or status
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

      // Subscriber A (the owner of the session) CAN view and download their own records
      const viewByA = inboxHandler.viewMessage(subscriberA, msgRecord.id);
      assert.ok(viewByA.text.includes('Secret message for Subscriber A'));

      const dlStatusByA = storiesHandler.downloadStatus(
        subscriberA,
        statusRecord.id
      );
      assert.equal(dlStatusByA.mediaAttachments?.length, 1);

      db.close();
    });
  });
});
