import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  VoipCallInstance,
  WaCallMediaSessionLike,
} from '@hiroosy/baileys-lite/voip';

import {
  verifyWebRequestAuth,
  computeAdminSessionToken,
  toClientSafeSessionDto,
  toClientSafeAuditDto,
} from '../../src/security/web-auth';
import { isDestructiveLiveSessionAction } from '../../src/runtime-harness';
import { createAtomicMultiFileAuthState } from '../../src/whatsapp/atomic-auth-state';
import {
  SessionMemoryStore,
  MockWhatsAppSessionDriver,
} from '../../src/whatsapp/connection-manager';
import { toCompatibleWhatsAppSocket } from '../../src/whatsapp/baileys-compat';
import { runBaileysCompatibilityProbe } from '../../src/whatsapp/compatibility-probe';
import {
  validateAndInspectVideoMedia,
  generatePlayableVoipMp4File,
} from '../../src/whatsapp/voip-media-pipeline';
import {
  instrumentMediaSessionInstance,
  instrumentAudioEngineInstance,
  instrumentVideoEngineInstance,
  hasVerifiedRelayMediaAcceptance,
  splitAnnexBNalus,
  groupAnnexBToFrameAccessUnits,
  listenWithTrackedSocketCleanup,
  type InstrumentedAudioEngine,
  type InstrumentedVideoEngine,
} from '../../src/whatsapp/voip-runtime-patch';
import { RealVideoCallService } from '../../src/whatsapp/video-call-bridge';
import { VideoCallWorkflow } from '../../src/bot/workflows/video-call-workflow';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { SessionManager } from '../../src/whatsapp/session-manager';
import {
  MediaValidationError,
  VoipFailureError,
  toSafeArabicError,
} from '../../src/utils/errors';
import { assertSupportedNodeSqliteRuntime } from '../../src/app';

describe('Audit 33 Defects (BZ-001 through BZ-033) Behavioral Regression Suite', () => {
  let tmpDir: string;
  let sampleMp4: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-bz33-test-'));
    sampleMp4 = path.join(tmpDir, 'sample_call.mp4');
    await generatePlayableVoipMp4File(sampleMp4, {
      width: 640,
      height: 360,
      durationSeconds: 1,
      includeAudio: true,
    });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('BZ-001: rejects fake MEDIA_STARTED when sctpRelay.broadcast returns false or hasConnection() is false, and only transitions when relay accepts audio + video packets', async () => {
    const rawSession: WaCallMediaSessionLike & {
      sctpRelay?: {
        hasConnection: () => boolean;
        broadcast: (pkt: Buffer | Uint8Array) => boolean;
      };
      sendCapturedAudio?: (frame: Buffer | Uint8Array) => void;
      sendCapturedVideoAU?: (
        nalus: Array<Buffer | Uint8Array>,
        isKey: boolean
      ) => void;
    } = {
      callId: 'CALL_BZ001',
      peerJid: '966501234567@s.whatsapp.net',
      isVideo: true,
      audioSendCount: 0,
      audioOctetsSent: 0,
      videoSendCount: 0,
      videoOctetsSent: 0,
      videoIdrSendCount: 0,
      sctpRelay: {
        hasConnection: () => false,
        broadcast: () => false,
      },
      sendCapturedAudio(frame) {
        this.audioSendCount = (this.audioSendCount ?? 0) + 1;
        this.audioOctetsSent = (this.audioOctetsSent ?? 0) + frame.length;
        this.sctpRelay?.broadcast(frame);
      },
      sendCapturedVideoAU(nalus, isKey) {
        this.videoSendCount = (this.videoSendCount ?? 0) + 1;
        this.videoOctetsSent =
          (this.videoOctetsSent ?? 0) +
          nalus.reduce((acc, n) => acc + n.length, 0);
        if (isKey) {
          this.videoIdrSendCount = (this.videoIdrSendCount ?? 0) + 1;
        }
        for (const n of nalus) {
          this.sctpRelay?.broadcast(n);
        }
      },
    };

    const instrumented = instrumentMediaSessionInstance(rawSession)!;
    instrumented.sendCapturedAudio!(Buffer.alloc(160));
    instrumented.sendCapturedVideoAU!([Buffer.alloc(1200)], true);

    assert.equal(instrumented.audioSendCount, 1);
    assert.equal(instrumented.videoSendCount, 1);
    assert.equal(instrumented.acceptedAudioPackets ?? 0, 0);
    assert.equal(instrumented.acceptedVideoPackets ?? 0, 0);
    assert.equal(hasVerifiedRelayMediaAcceptance(instrumented), false);

    // Now simulate relay connection open and broadcast returning true
    const relayOpen = true;
    rawSession.sctpRelay!.hasConnection = () => relayOpen;
    rawSession.sctpRelay!.broadcast = () => relayOpen;

    instrumented.sendCapturedAudio!(Buffer.alloc(160));
    instrumented.sendCapturedVideoAU!([Buffer.alloc(1200)], true);

    assert.equal(hasVerifiedRelayMediaAcceptance(instrumented), true);
    assert.equal(instrumented.acceptedAudioPackets, 1);
    assert.equal(instrumented.acceptedVideoPackets, 1);
    assert.equal(instrumented.acceptedVideoKeyframes, 1);
  });

  it('BZ-003, BZ-004, BZ-014, BZ-015: enforces web auth, sanitizes session/audit DTOs, and blocks destructive live actions in observer mode', () => {
    const envObj = process.env as Record<string, string | undefined>;
    const prevSecret = envObj.DASHBOARD_API_SECRET;
    const prevNodeEnv = envObj.NODE_ENV;
    try {
      envObj.DASHBOARD_API_SECRET = 'super-secret-dashboard-key';
      envObj.NODE_ENV = 'production';

      const token = computeAdminSessionToken('super-secret-dashboard-key');

      const unauthRes = verifyWebRequestAuth({
        headers: {},
        cookies: {},
      });
      assert.equal(unauthRes.authorized, false);
      assert.equal(unauthRes.status, 401);

      const cookieAuthRes = verifyWebRequestAuth({
        cookies: {
          botezz_admin_session: token,
        },
      });
      assert.equal(cookieAuthRes.authorized, true);
    } finally {
      if (prevSecret === undefined) {
        delete envObj.DASHBOARD_API_SECRET;
      } else {
        envObj.DASHBOARD_API_SECRET = prevSecret;
      }
      if (prevNodeEnv === undefined) {
        delete envObj.NODE_ENV;
      } else {
        envObj.NODE_ENV = prevNodeEnv;
      }
    }

    const safeSession = toClientSafeSessionDto({
      id: 'sess_1',
      label: 'Primary',
      masked_phone: '+96650****567',
      jid: '966501234567:12@s.whatsapp.net',
      status: 'CONNECTED',
      auth_dir: '/var/data/whatsapp-sessions/sess_1',
      owner_telegram_id: 12345,
      reconnect_attempts: 0,
      last_connected_at: null,
      last_status_at: '2026-01-01T00:00:00.000Z',
      last_error: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(
      'auth_dir' in (safeSession as unknown as Record<string, unknown>),
      false
    );
    assert.ok(safeSession.jid?.includes('***'));

    const safeAudit = toClientSafeAuditDto({
      id: 'audit_1',
      actor_telegram_id: 12345,
      action: 'PAIRING',
      target_id: 'sess_1',
      outcome: 'SUCCESS',
      metadata_json: JSON.stringify({
        authDir: '/secret/path',
        pairingCode: '1234-5678',
        safeField: 'visible',
      }),
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const parsedMeta = JSON.parse(safeAudit.metadata_json || '{}');
    assert.equal('authDir' in parsedMeta, false);
    assert.equal(parsedMeta.pairingCode, '[REDACTED]');
    assert.equal(parsedMeta.safeField, 'visible');

    assert.equal(
      isDestructiveLiveSessionAction({ text: '/delete sess_1' }),
      true
    );
    assert.equal(
      isDestructiveLiveSessionAction({ callbackData: 'sessions:delete:sess_1' }),
      true
    );
    assert.equal(isDestructiveLiveSessionAction({ text: '/status' }), false);
  });

  it('BZ-005: SessionManager serializes concurrent session lifecycle operations per sessionId', async () => {
    const db = new AppDatabase(':memory:');
    try {
      const sessionRepo = new SessionRepository(db);
      const auditRepo = new AuditRepository(db);
      const authRoot = path.join(tmpDir, 'bz005-auth');
      const sessionStore = new SessionStore(authRoot);

      let activeConnectCount = 0;
      let maxConcurrentConnects = 0;

      const manager = new SessionManager(
        sessionRepo,
        auditRepo,
        sessionStore,
        (id) => {
          const drv = new MockWhatsAppSessionDriver(id);
          const origConnect = drv.connect.bind(drv);
          drv.connect = async (handlers) => {
            activeConnectCount += 1;
            maxConcurrentConnects = Math.max(
              maxConcurrentConnects,
              activeConnectCount
            );
            await new Promise((r) => setTimeout(r, 30));
            try {
              return await origConnect(handlers);
            } finally {
              activeConnectCount -= 1;
            }
          };
          return drv;
        }
      );

      const session = manager.createSession('BZ005 Session', 100);
      await manager.initiatePairing({
        sessionId: session.id,
        rawPhoneNumber: '+966501112222',
        actorTelegramId: 100,
      });
      const drv005 = manager.getDriver(
        session.id,
        100
      ) as MockWhatsAppSessionDriver;
      drv005.completeSimulatedPairing();

      // Write valid registered creds on disk so reconnectSession is allowed
      const authState = await createAtomicMultiFileAuthState(session.auth_dir);
      authState.state.creds.registered = true;
      authState.state.creds.me = { id: '966501112222:1@s.whatsapp.net', name: 'BZ005' };
      await authState.saveCreds();
      await authState.flushPendingWrites();

      await Promise.all([
        manager.reconnectSession(session.id, 100),
        manager.reconnectSession(session.id, 100),
        manager.disconnectSession(session.id, 100),
      ]);

      assert.equal(
        maxConcurrentConnects,
        1,
        'Per-session mutex must prevent overlapping connect() executions'
      );
    } finally {
      db.close();
    }
  });

  it('BZ-006 & R-002: createAtomicMultiFileAuthState validates creds.json structure (noiseKey + signedIdentityKey) and recovers from backup when creds.json is empty {}', async () => {
    const authDir = path.join(tmpDir, 'bz006-atomic-auth');
    const state1 = await createAtomicMultiFileAuthState(authDir);
    await state1.saveCreds();
    await state1.flushPendingWrites();

    const credsPath = path.join(authDir, 'creds.json');
    const bakPath = path.join(authDir, 'creds.json.bak');
    fs.copyFileSync(credsPath, bakPath);
    fs.writeFileSync(credsPath, '{}', 'utf-8');

    const state2 = await createAtomicMultiFileAuthState(authDir);
    assert.ok(
      state2.state.creds.noiseKey,
      'Must reject empty {} creds.json and recover valid noiseKey from backup'
    );
    assert.ok(
      state2.state.creds.signedIdentityKey,
      'Must recover valid signedIdentityKey from backup'
    );
  });

  it('BZ-007, BZ-008, BZ-009, BZ-012, BZ-013, BZ-020, BZ-021, BZ-022, BZ-023: RealVideoCallService coordinator state reconciliation, failure cleanup, voice call item, non-loop completion, declined/timeout mapping, socket listener cleanup, and bounded history', async () => {
    const service = new RealVideoCallService();
    service.setCompatibilityOverride(
      runBaileysCompatibilityProbe({ requireLiveSocket: false })
    );

    const ev = new EventEmitter();
    const rawSocket: Record<string, unknown> = {
      ev,
      ws: { isOpen: true, on: () => undefined, off: () => undefined },
    };

    const coordinatorEmitter = new EventEmitter();
    const callsMap = new Map<string, WaCallMediaSessionLike>();
    const receivedMediaPayloads: unknown[] = [];

    const coordinator = Object.assign(coordinatorEmitter, {
      manager: { calls: callsMap },
      getCall(callId: string) {
        const sess = callsMap.get(callId);
        return sess ? (sess as { info?: unknown }).info ?? null : null;
      },
      dispose() {
        callsMap.clear();
        coordinatorEmitter.removeAllListeners();
      },
    });

    let simulateCallRejectError = false;
    let simulatePreRingingInGetCall = false;

    const voipMock = {
      coordinator,
      async listen() {
        // Simulate VoipClient registering a connection.update listener on sock.ev (BZ-022)
        ev.on('connection.update', () => undefined);
        return this;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        coordinator.on(event, listener);
        return this;
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        coordinator.off(event, listener);
        return this;
      },
      async call(jid: string, mediaPayload: unknown) {
        receivedMediaPayloads.push(mediaPayload);
        if (simulateCallRejectError) {
          throw new Error('USync device query failed');
        }
        const callId = `CALL_${receivedMediaPayloads.length}`;
        const callInfo = {
          callId,
          peerJid: jid,
          isRinging: simulatePreRingingInGetCall,
          isActive: false,
          isEnded: false,
          stateData: {
            state: simulatePreRingingInGetCall ? 'ringing' : 'initiating',
          },
        };
        const session: WaCallMediaSessionLike & { info: typeof callInfo } = {
          callId,
          peerJid: jid,
          isVideo: true,
          audioSendCount: 0,
          audioOctetsSent: 0,
          videoSendCount: 0,
          videoOctetsSent: 0,
          videoIdrSendCount: 0,
          info: callInfo,
        };
        callsMap.set(callId, session);

        const inst = Object.assign(new EventEmitter(), {
          callId,
          target: jid,
          hangupCalls: 0,
          mediaSession: session,
          async hangup() {
            this.hangupCalls += 1;
            callsMap.delete(callId);
          },
        });
        return inst as unknown as VoipCallInstance;
      },
      async hangup(callId?: string) {
        if (callId) callsMap.delete(callId);
      },
      async end() {
        callsMap.clear();
      },
    };

    service.attachSession('sess_bz_voip', rawSocket);
    const attachedMap = (
      service as unknown as {
        attachedSessions: Map<string, { voipInstance?: unknown }>;
      }
    ).attachedSessions;
    attachedMap.get('sess_bz_voip')!.voipInstance = voipMock;

    // 1. BZ-007 & BZ-021: Reconcile pre-ringing from coordinator.getCall(callId) and map stateData.endReason = 'declined' to REJECTED
    simulatePreRingingInGetCall = true;
    const stream1 = await service.startVideoCall({
      sessionId: 'sess_bz_voip',
      socket: rawSocket,
      recipientJid: '966501234567@s.whatsapp.net',
      videoFilePath: sampleMp4,
      allowedRootDirs: [tmpDir],
    });
    assert.equal(
      stream1.callState,
      'RINGING',
      'BZ-007: Must reconcile RINGING state from coordinator.getCall(callId)'
    );

    coordinator.emit('call_ended', {
      callId: stream1.voipCallId,
      stateData: { state: 'ended', endReason: 'declined' },
    });
    assert.equal(
      stream1.callState,
      'REJECTED',
      'BZ-021: stateData.endReason="declined" must map to REJECTED'
    );

    // 2. BZ-023: Completed stream is archived out of activeStreams into completedStreamsHistory
    const activeStreamsMap = (
      service as unknown as { activeStreams: Map<string, unknown> }
    ).activeStreams;
    assert.equal(
      activeStreamsMap.has(stream1.callId),
      false,
      'BZ-023: Terminal stream must be removed from activeStreams'
    );
    assert.ok(
      service.getStreamById(stream1.callId),
      'BZ-023: Completed stream remains queryable in bounded history'
    );

    // 3. BZ-013 & BZ-020: Voice call passes [{ audio, autoAdvance }] to voip.call
    simulatePreRingingInGetCall = false;
    const streamVoice = await service.startVideoCall({
      sessionId: 'sess_bz_voip',
      socket: rawSocket,
      recipientJid: '966501234567@s.whatsapp.net',
      videoFilePath: sampleMp4,
      allowedRootDirs: [tmpDir],
      callKind: 'voice',
      loopVideo: false,
    });
    const lastPayload = receivedMediaPayloads[
      receivedMediaPayloads.length - 1
    ] as Array<{ audio?: string; autoAdvance?: boolean }>;
    assert.equal(Array.isArray(lastPayload), true);
    assert.ok(
      lastPayload[0]?.audio,
      'BZ-013: Voice call must pass { audio } item'
    );
    assert.equal(
      lastPayload[0]?.autoAdvance,
      true,
      'BZ-020: loopVideo=false must set autoAdvance=true'
    );
    await service.stopVideoCall('sess_bz_voip', streamVoice.callId);

    // 4. BZ-009: When voip.call() throws, startVideoCall transitions stream to FAILED, cleans up, and rethrows
    simulateCallRejectError = true;
    await assert.rejects(
      () =>
        service.startVideoCall({
          sessionId: 'sess_bz_voip',
          socket: rawSocket,
          recipientJid: '966501234567@s.whatsapp.net',
          videoFilePath: sampleMp4,
          allowedRootDirs: [tmpDir],
        }),
      /USync device query failed/
    );
    assert.equal(
      activeStreamsMap.size,
      0,
      'BZ-009: Failed startVideoCall must not leak in activeStreams'
    );
    simulateCallRejectError = false;

    // 5. BZ-022: detachSession removes both bridge and VoipClient listeners from rawSocket.ev
    assert.ok(ev.listenerCount('connection.update') >= 1);
    service.detachSession('sess_bz_voip');
    assert.equal(
      ev.listenerCount('connection.update'),
      0,
      'BZ-022: detachSession must remove all connection.update listeners from rawSocket.ev'
    );
  });

  it('BZ-010 & BZ-011: instrumentMediaSessionInstance prevents startMediaFlow after cleanup, and instrumentAudioEngineInstance patches FFmpeg decode timeout/stop', () => {
    let audioStartedCount = 0;
    const rawSession = {
      callId: 'CALL_BZ010',
      info: {
        isEnded: false,
        stateData: { state: 'active' },
      },
      cleanup() {
        // Original cleanup without setting state='ended'
      },
      startMediaFlow() {
        audioStartedCount += 1;
      },
    };

    const instrumented = instrumentMediaSessionInstance(rawSession)!;
    instrumented.startMediaFlow!();
    assert.equal(audioStartedCount, 1);

    // Call cleanup() (simulating call hangup while DTLS handshake is in-flight)
    instrumented.cleanup!();
    assert.equal(instrumented.info?.stateData?.state, 'ended');

    // Late DTLS callback invokes startMediaFlow() -> must be blocked!
    instrumented.startMediaFlow!();
    assert.equal(
      audioStartedCount,
      1,
      'BZ-010: startMediaFlow must not execute after cleanup()'
    );

    // BZ-011: Verify audioEngine decodeWithFFmpeg timeout patch
    const audioEngine: InstrumentedAudioEngine = {
      ffmpegPath: process.execPath,
      decodeWithFFmpeg: async () => Buffer.alloc(0),
      stop() {
        // noop
      },
    };
    instrumentAudioEngineInstance(audioEngine, 40);
    assert.equal(audioEngine.__botezzAudioPatched, true);
  });

  it('BZ-016, BZ-018, BZ-019, BZ-024, BZ-025, BZ-026, BZ-029, BZ-030, BZ-031: validates runtime check, socket.end(), SessionMemoryStore events, symlink traversal protection, probe verificationLevel, and workflow temp file cleanup', async () => {
    // BZ-016: Node runtime check
    await assertSupportedNodeSqliteRuntime();
    await assert.rejects(
      () => assertSupportedNodeSqliteRuntime('20.11.0'),
      /requires Node\.js >= 22\.13\.0/
    );

    // BZ-018: BaileysCompatibleSocket.end() forwards to rawSocket.end()
    let endCalled = false;
    const compat = toCompatibleWhatsAppSocket({
      ev: new EventEmitter(),
      end: () => {
        endCalled = true;
      },
    });
    compat.end?.();
    assert.equal(endCalled, true);

    // BZ-019: SessionMemoryStore populates chats & contacts from messaging-history.set, chats.upsert, contacts.upsert
    const store = new SessionMemoryStore();
    const ev = new EventEmitter();
    store.bind(ev as never);
    ev.emit('messaging-history.set', {
      chats: [{ id: '120363000001@g.us', name: 'Ops Group' }],
      contacts: [{ id: '966501112222@s.whatsapp.net', name: 'Alice' }],
    });
    ev.emit('contacts.update', [
      { id: '966501112222@s.whatsapp.net', notify: 'Alice Updated' },
    ]);
    assert.equal(store.chats.has('120363000001@g.us'), true);
    assert.equal(store.contacts.has('966501112222@s.whatsapp.net'), true);
    assert.equal(
      (
        store.contacts.get('966501112222@s.whatsapp.net') as {
          notify?: string;
        }
      )?.notify,
      'Alice Updated'
    );

    // BZ-025: Symlink inside allowedRootDirs pointing outside allowedRootDirs is rejected
    const allowedSubdir = path.join(tmpDir, 'allowed_only');
    fs.mkdirSync(allowedSubdir, { recursive: true });
    const symlinkPath = path.join(allowedSubdir, 'escaped_link.mp4');
    try {
      fs.symlinkSync(sampleMp4, symlinkPath);
    } catch {
      // Symlink creation should succeed on Linux
    }
    if (fs.existsSync(symlinkPath)) {
      await assert.rejects(
        () =>
          validateAndInspectVideoMedia(symlinkPath, {
            allowedRootDirs: [allowedSubdir],
          }),
        (err: unknown) => err instanceof MediaValidationError
      );
    }

    // BZ-026: CompatibilityProbe verificationLevel
    const staticProbe = runBaileysCompatibilityProbe({
      requireLiveSocket: false,
    });
    assert.equal(staticProbe.verificationLevel, 'STATIC_EXPORTS_ONLY');

    // BZ-024, BZ-029, BZ-030: VideoCallWorkflow cleans up temp files on cancel and renders live status + executionMode
    const db = new AppDatabase(':memory:');
    try {
      const sessionRepo = new SessionRepository(db);
      const auditRepo = new AuditRepository(db);
      const sessionStore = new SessionStore(path.join(tmpDir, 'wf-auth'));
      const sessionManager = new SessionManager(
        sessionRepo,
        auditRepo,
        sessionStore,
        (id) => new MockWhatsAppSessionDriver(id)
      );
      const sess = sessionManager.createSession('WF Session', 500);
      await sessionManager.initiatePairing({
        sessionId: sess.id,
        rawPhoneNumber: '+966500000000',
        actorTelegramId: 500,
      });
      const drv = sessionManager.getDriver(
        sess.id,
        500
      ) as MockWhatsAppSessionDriver;
      drv.completeSimulatedPairing();

      const bridge = new RealVideoCallService(sessionManager, auditRepo);
      const tempUploadsDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
      fs.mkdirSync(tempUploadsDir, { recursive: true });
      const sampleBuf = fs.readFileSync(sampleMp4);

      const wf = new VideoCallWorkflow(
        sessionManager,
        bridge,
        auditRepo,
        tempUploadsDir
      );
      wf.start(500, sess.id);
      await wf.handleVideoUpload(500, {
        originalFilename: 'wf_upload.mp4',
        mimeType: 'video/mp4',
        sizeBytes: sampleBuf.length,
        contentBuffer: sampleBuf,
      });

      const stagedPath = wf.getState(500)?.videoFilePath;
      assert.ok(stagedPath);
      assert.equal(fs.existsSync(stagedPath!), true);

      // Cancel workflow -> stagedPath must be deleted (BZ-024)
      wf.cancel(500);
      assert.equal(
        fs.existsSync(stagedPath!),
        false,
        'BZ-024: cancel() must unlink owned temporary uploaded video file'
      );
    } finally {
      db.close();
    }
  });

  it('P0-A: packages H.264 Annex-B Access Units per RFC 6184 with identical frame timestamp, M=0 on SPS/PPS, and M=1 only on last VCL packet', async () => {
    const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
    const aud = Buffer.from([0x09, 0xf0]);
    const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80, 0xb6]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
    const sei = Buffer.from([0x06, 0x05, 0x04, 0xde, 0xad, 0xbe, 0xef, 0x80]);
    // Create an IDR slice > 900 bytes to exercise FU-A fragmentation (type 28)
    const idrPayload = Buffer.alloc(1500, 0xaa);
    idrPayload[0] = 0x65; // NalRefIdc=3, Type=5 (IDR)
    const slicePayload = Buffer.from([0x41, 0x9a, 0x22, 0x33, 0x44]); // Type=1 (Non-IDR)

    const annexBChunk = Buffer.concat([
      startCode,
      aud,
      startCode,
      sps,
      startCode,
      pps,
      startCode,
      sei,
      startCode,
      idrPayload,
      startCode,
      aud,
      startCode,
      slicePayload,
    ]);

    const nalus = splitAnnexBNalus(annexBChunk);
    assert.equal(nalus.length, 7);

    // Verify WaVideoEngine Access Unit grouping groups AUD+SPS+PPS+SEI+IDR into Frame 1 and AUD+Slice into Frame 2
    const emittedFrames: Uint8Array[] = [];
    const videoEngineMock: InstrumentedVideoEngine = {
      width: 640,
      height: 360,
      frameRate: 15,
      frameDurationMs: 1000 / 15,
      bitrateKbps: 280,
      running: true,
      videoPath: sampleMp4,
      videoLoop: true,
      waitingForKeyFrame: false,
      sourceKind: 'file',
      pending: new Uint8Array(0),
      accessUnitsSent: 0,
      bytesEncoded: 0,
      emitAccessUnit(frameAu: Uint8Array) {
        emittedFrames.push(frameAu);
      },
    };
    instrumentVideoEngineInstance(videoEngineMock);
    videoEngineMock.handleChunk!(annexBChunk);
    assert.equal(
      emittedFrames.length,
      2,
      'P0-A: Annex-B chunk with 2 VCL slices must emit exactly 2 complete frame Access Units'
    );
    assert.deepEqual(
      splitAnnexBNalus(emittedFrames[0]).map((n) => n[0] & 0x1f),
      [9, 7, 8, 6, 5]
    );
    assert.deepEqual(
      splitAnnexBNalus(emittedFrames[1]).map((n) => n[0] & 0x1f),
      [9, 1]
    );

    // Verify WaCallMediaSession RFC 6184 RTP packaging
    const sentPayloads: Uint8Array[] = [];
    const mediaSessionMock: WaCallMediaSessionLike & Record<string, unknown> = {
      ended: false,
      videoStreaming: true,
      videoSeq: 100,
      videoTimestamp: 90_000,
      videoSsrc: 0x11223344,
      videoSendCount: 0,
      videoOctetsSent: 0,
      videoIdrSendCount: 0,
      videoEngine: { running: true, accessUnitsSent: 0 },
      sctpRelay: {
        hasConnection: () => true,
        broadcast: (pkt: ArrayBuffer | Uint8Array | Buffer) => {
          const u8 =
            pkt instanceof Uint8Array
              ? pkt
              : new Uint8Array(pkt as ArrayBuffer);
          sentPayloads.push(new Uint8Array(u8));
          return 1;
        },
      },
    };

    const instrumented = instrumentMediaSessionInstance(mediaSessionMock)!;
    // Frame 1: AUD + SPS + PPS + SEI + 1500B IDR (SPS + PPS + 2 FU-A packets = 4 RTP packets)
    const frame1Buffer = Buffer.concat([
      startCode,
      aud,
      startCode,
      sps,
      startCode,
      pps,
      startCode,
      sei,
      startCode,
      idrPayload,
    ]);
    await (
      instrumented as unknown as {
        sendVideoAccessUnit: (au: Buffer) => Promise<void>;
      }
    ).sendVideoAccessUnit(frame1Buffer);

    const sentPackets = instrumented.sentVideoRtpPackets ?? [];
    assert.equal(
      sentPackets.length,
      4,
      'P0-A: Frame 1 must produce 4 RTP packets (SPS, PPS, and 2 FU-A fragments; AUD/SEI dropped)'
    );

    const frame1Timestamps = sentPackets.map((pkt) => pkt.timestamp);
    const frame1Markers = sentPackets.map((pkt) => pkt.marker);
    const frame1NalTypes = sentPackets.map((pkt) => pkt. payload[0] & 0x1f);

    assert.deepEqual(
      frame1Timestamps,
      [90_000, 90_000, 90_000, 90_000],
      'P0-A: SPS, PPS, and all IDR FU-A fragments of the same frame must share the exact same RTP timestamp'
    );
    assert.deepEqual(
      frame1Markers,
      [false, false, false, true],
      'P0-A: RTP Marker bit M=1 must be set ONLY on the last fragment of the VCL IDR slice (M=0 on SPS/PPS)'
    );
    assert.deepEqual(
      frame1NalTypes,
      [7, 8, 28, 28],
      'P0-A: SPS (7) and PPS (8) must be single NALUs, and large IDR must be FU-A (28) without start codes'
    );

    // Verify timestamp incremented by 90000 / 15 = 6000 for Frame 2
    assert.equal(mediaSessionMock.videoTimestamp, 96_000);
  });

  it('P0-B: tears down VoIP session cleanly between consecutive calls and classifies VoIP/Media errors into Arabic diagnostics', async () => {
    const rawSocketEv = new EventEmitter();
    // Simulate an unrelated connection listener already on rawSocket.ev
    const baseConnListener = () => {};
    rawSocketEv.on('connection.update', baseConnListener);

    let addedVoipConnListener: ((...args: unknown[]) => void) | undefined;
    const voipFake = {
      listen: async () => {
        addedVoipConnListener = () => {};
        rawSocketEv.on('connection.update', addedVoipConnListener);
      },
    };

    const cleanup = await listenWithTrackedSocketCleanup(voipFake, {
      ev: rawSocketEv,
    });
    assert.equal(
      rawSocketEv.listenerCount('connection.update'),
      2,
      'P0-B: voip.listen() adds its connection.update listener'
    );
    cleanup();
    assert.equal(
      rawSocketEv.listenerCount('connection.update'),
      1,
      'P0-B: cleanup function removes the exact connection.update listener added during voip.listen()'
    );

    // Verify diagnostic Arabic error classification in toSafeArabicError
    const concurrentErr = toSafeArabicError(
      new Error('Maximum concurrent calls reached (1)')
    );
    assert.equal(
      concurrentErr.userMessage.includes('حدث خطأ غير متوقع'),
      false,
      'P0-B: Maximum concurrent calls reached must not return generic unexpected error'
    );
    assert.equal(
      concurrentErr.userMessage.includes('الحد الأقصى للمكالمات'),
      true
    );

    const voipFailureErr = toSafeArabicError(
      new VoipFailureError('فشل تهيئة مسار المكالمة الصوتية/المرئية')
    );
    assert.equal(
      voipFailureErr.userMessage,
      'فشل تهيئة مسار المكالمة الصوتية/المرئية'
    );
  });
});


