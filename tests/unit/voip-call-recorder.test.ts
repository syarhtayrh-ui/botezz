import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VoipCallRecorder,
  PerSsrcSrtpDecryptor,
  buildSrtpCtrIv,
  buildRtcpPliPacket,
  createInitialH264DepacketizerState,
  depacketizeH264RtpPacket,
  syncPeerRecvKeysOnMediaSession,
  sendRtcpPliOnMediaSession,
  type SrtpKeyMaterial,
} from '../../src/whatsapp/voip-call-recorder';
import { RealVideoCallService } from '../../src/whatsapp/video-call-bridge';
import { MockWhatsAppSessionDriver } from '../../src/whatsapp/connection-manager';
import { generatePlayableVoipMp4File } from '../../src/whatsapp/voip-media-pipeline';

function buildRawRtpPacket(opts: {
  payloadType?: number;
  marker?: boolean;
  seq: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
  csrc?: number[];
  extension?: Uint8Array;
  paddingLen?: number;
}): Uint8Array {
  const csrc = opts.csrc ?? [];
  const hasExt = Boolean(opts.extension && opts.extension.length > 0);
  const padLen = opts.paddingLen ?? 0;
  const hasPad = padLen > 0;

  const extWords = hasExt ? Math.ceil(opts.extension!.length / 4) : 0;
  const extTotalBytes = hasExt ? 4 + extWords * 4 : 0;
  const headerLen = 12 + csrc.length * 4 + extTotalBytes;
  const totalLen = headerLen + opts.payload.length + padLen;

  const buf = Buffer.alloc(totalLen, 0);
  let byte0 = 0x80 | (csrc.length & 0x0f);
  if (hasPad) byte0 |= 0x20;
  if (hasExt) byte0 |= 0x10;
  buf[0] = byte0;

  let byte1 = (opts.payloadType ?? 96) & 0x7f;
  if (opts.marker) byte1 |= 0x80;
  buf[1] = byte1;

  buf.writeUInt16BE(opts.seq & 0xffff, 2);
  buf.writeUInt32BE(opts.timestamp >>> 0, 4);
  buf.writeUInt32BE(opts.ssrc >>> 0, 8);

  let offset = 12;
  for (const c of csrc) {
    buf.writeUInt32BE(c >>> 0, offset);
    offset += 4;
  }
  if (hasExt) {
    buf.writeUInt16BE(0xbede, offset);
    buf.writeUInt16BE(extWords, offset + 2);
    offset += 4;
    buf.set(opts.extension!, offset);
    offset += extWords * 4;
  }

  buf.set(opts.payload, offset);
  if (hasPad) {
    buf[totalLen - 1] = padLen;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function protectRtpForTest(
  plainRtp: Uint8Array,
  keys: SrtpKeyMaterial,
  roc = 0
): Uint8Array {
  const authTagLen = keys.authTagLen ?? 4;
  const seq = (plainRtp[2] << 8) | plainRtp[3];
  const ssrc =
    ((plainRtp[8] << 24) |
      (plainRtp[9] << 16) |
      (plainRtp[10] << 8) |
      plainRtp[11]) >>>
    0;
  const cc = plainRtp[0] & 0x0f;
  const hasExt = (plainRtp[0] & 0x10) !== 0;
  let headerLen = 12 + cc * 4;
  if (hasExt) {
    const extWords = (plainRtp[headerLen + 2] << 8) | plainRtp[headerLen + 3];
    headerLen += 4 + extWords * 4;
  }

  const packetIndex = BigInt(roc) * BigInt(65536) + BigInt(seq);
  const iv = buildSrtpCtrIv(keys.sessionSalt, ssrc, packetIndex);
  const cipher = crypto.createCipheriv('aes-128-ctr', keys.sessionKey, iv);
  const encryptedPayload = Buffer.concat([
    cipher.update(plainRtp.subarray(headerLen)),
    cipher.final(),
  ]);

  const rtpPart = new Uint8Array(headerLen + encryptedPayload.length);
  rtpPart.set(plainRtp.subarray(0, headerLen), 0);
  rtpPart.set(encryptedPayload, headerLen);

  const rocBuf = Buffer.alloc(4);
  rocBuf.writeUInt32BE(roc >>> 0, 0);
  const hmac = crypto.createHmac('sha1', keys.authKey);
  hmac.update(rtpPart);
  hmac.update(rocBuf);
  const tag = hmac.digest().subarray(0, authTagLen);

  const out = new Uint8Array(rtpPart.length + authTagLen);
  out.set(rtpPart, 0);
  out.set(tag, rtpPart.length);
  return out;
}

describe('Two-Way VoIP Video Call Recording (VoipCallRecorder)', () => {
  it('depacketizes RFC 6184 Single NALU, STAP-A (24), and FU-A (28) with sequence continuity checks', () => {
    const state = createInitialH264DepacketizerState();

    // 1. STAP-A (type 24) carrying SPS (type 7) and PPS (type 8)
    const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0x2d]);
    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    const stapPayload = new Uint8Array(1 + 2 + sps.length + 2 + pps.length);
    stapPayload[0] = 24; // STAP-A
    stapPayload[1] = 0;
    stapPayload[2] = sps.length;
    stapPayload.set(sps, 3);
    const ppsOffset = 3 + sps.length;
    stapPayload[ppsOffset] = 0;
    stapPayload[ppsOffset + 1] = pps.length;
    stapPayload.set(pps, ppsOffset + 2);

    const stapRtp = buildRawRtpPacket({
      seq: 100,
      timestamp: 9000,
      ssrc: 0x22222222,
      payload: stapPayload,
      csrc: [0x11111111],
      extension: new Uint8Array([0x10, 0x20, 0x30, 0x40]),
      paddingLen: 4,
    });

    const stapRes = depacketizeH264RtpPacket(stapRtp, state);
    assert.deepEqual(stapRes.nalTypes, [7, 8]);
    assert.equal(stapRes.annexBNalus.length, 2);
    assert.ok(state.cachedRemoteSps);
    assert.ok(state.cachedRemotePps);

    // 2. FU-A (type 28) fragmented IDR frame (original type 5, NRI 0x60 -> reconstructed header 0x65)
    const idrBodyPart1 = new Uint8Array(600).fill(0xaa);
    const idrBodyPart2 = new Uint8Array(600).fill(0xbb);
    const idrBodyPart3 = new Uint8Array(300).fill(0xcc);

    const fua1 = new Uint8Array(2 + idrBodyPart1.length);
    fua1[0] = 0x60 | 28;
    fua1[1] = 0x80 | 5; // Start bit + IDR(5)
    fua1.set(idrBodyPart1, 2);

    const fua2 = new Uint8Array(2 + idrBodyPart2.length);
    fua2[0] = 0x60 | 28;
    fua2[1] = 5; // Middle fragment
    fua2.set(idrBodyPart2, 2);

    const fua3 = new Uint8Array(2 + idrBodyPart3.length);
    fua3[0] = 0x60 | 28;
    fua3[1] = 0x40 | 5; // End bit + IDR(5)
    fua3.set(idrBodyPart3, 2);

    const res1 = depacketizeH264RtpPacket(
      buildRawRtpPacket({ seq: 101, timestamp: 9000, ssrc: 0x22222222, payload: fua1 }),
      state
    );
    assert.equal(res1.annexBNalus.length, 0);

    const res2 = depacketizeH264RtpPacket(
      buildRawRtpPacket({ seq: 102, timestamp: 9000, ssrc: 0x22222222, payload: fua2 }),
      state
    );
    assert.equal(res2.annexBNalus.length, 0);

    const res3 = depacketizeH264RtpPacket(
      buildRawRtpPacket({
        seq: 103,
        timestamp: 9000,
        ssrc: 0x22222222,
        marker: true,
        payload: fua3,
      }),
      state
    );
    assert.equal(res3.annexBNalus.length, 1);
    assert.deepEqual(res3.nalTypes, [5]);
    assert.equal(res3.framesIncrement, 1);
    assert.equal(res3.keyframesIncrement, 1);
    // Start code (4) + reconstructed header (1) + 600 + 600 + 300 = 1505 bytes
    assert.equal(res3.annexBNalus[0].length, 4 + 1 + 1500);
    assert.equal(res3.annexBNalus[0][4], 0x65);

    // 3. FU-A with sequence gap -> must discard incomplete NALU and flag sequenceGap
    depacketizeH264RtpPacket(
      buildRawRtpPacket({ seq: 200, timestamp: 15000, ssrc: 0x22222222, payload: fua1 }),
      state
    );
    const gapRes = depacketizeH264RtpPacket(
      buildRawRtpPacket({
        seq: 202, // Skipped seq 201!
        timestamp: 15000,
        ssrc: 0x22222222,
        marker: true,
        payload: fua3,
      }),
      state
    );
    assert.equal(gapRes.sequenceGap, true);
    assert.equal(gapRes.annexBNalus.length, 0);
    assert.equal(state.inboundVideoFramesRecorded, 1);

    // 4. Single NALU (Non-IDR Slice, type 1)
    const sliceNalu = new Uint8Array([0x41, 0x9a, 0x24, 0x6c, 0x88]);
    const singleRes = depacketizeH264RtpPacket(
      buildRawRtpPacket({
        seq: 203,
        timestamp: 21000,
        ssrc: 0x22222222,
        marker: true,
        payload: sliceNalu,
      }),
      state
    );
    assert.equal(singleRes.annexBNalus.length, 1);
    assert.deepEqual(singleRes.nalTypes, [1]);
    assert.equal(state.inboundVideoFramesRecorded, 2);
  });

  it('maintains independent per-SSRC SRTP sequence windows and syncs peerCallKey onto videoSrtpSession', () => {
    const decryptor = new PerSsrcSrtpDecryptor();
    const keys: SrtpKeyMaterial = {
      sessionKey: crypto.randomBytes(16),
      sessionSalt: crypto.randomBytes(14),
      authKey: crypto.randomBytes(20),
      authTagLen: 4,
    };

    const audioRtp = buildRawRtpPacket({
      payloadType: 120,
      seq: 65500,
      timestamp: 48000,
      ssrc: 0xaaaa0001,
      payload: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    });
    const videoRtp = buildRawRtpPacket({
      payloadType: 96,
      seq: 12,
      timestamp: 90000,
      ssrc: 0xbbbb0002,
      payload: new Uint8Array([0x67, 0x42, 0xc0, 0x1f]),
    });

    const srtpAudio = protectRtpForTest(audioRtp, keys);
    const srtpVideo = protectRtpForTest(videoRtp, keys);

    const decAudio = decryptor.unprotectRtpPacket(srtpAudio, keys);
    const decVideo = decryptor.unprotectRtpPacket(srtpVideo, keys);

    assert.ok(decAudio);
    assert.ok(decVideo);
    assert.deepEqual(Buffer.from(decAudio), Buffer.from(audioRtp));
    assert.deepEqual(Buffer.from(decVideo), Buffer.from(videoRtp));
    assert.equal(decryptor.getSsrcState(0xaaaa0001).lastSeq, 65500);
    assert.equal(decryptor.getSsrcState(0xbbbb0002).lastSeq, 12);

    // Verify syncPeerRecvKeysOnMediaSession copies peer keys from srtpSession.recvCtx to videoSrtpSession.recvCtx
    const staleKeys: SrtpKeyMaterial = {
      sessionKey: crypto.randomBytes(16),
      sessionSalt: crypto.randomBytes(14),
      authKey: crypto.randomBytes(20),
    };
    const mockSession = {
      srtpSession: { recvCtx: { ...keys } },
      videoSrtpSession: { recvCtx: { ...staleKeys } },
    };
    syncPeerRecvKeysOnMediaSession(mockSession);
    assert.deepEqual(
      mockSession.videoSrtpSession.recvCtx.sessionKey,
      keys.sessionKey
    );
    assert.deepEqual(
      mockSession.videoSrtpSession.recvCtx.sessionSalt,
      keys.sessionSalt
    );
    assert.deepEqual(
      mockSession.videoSrtpSession.recvCtx.authKey,
      keys.authKey
    );
  });

  it('builds and broadcasts RFC 4585 RTCP PLI (PT=206, FMT=1) keyframe requests', () => {
    const pli = buildRtcpPliPacket(0x12345678, 0x87654321);
    assert.equal(pli.length, 12);
    assert.equal(pli[0], 0x81);
    assert.equal(pli[1], 206);
    assert.equal(Buffer.from(pli).readUInt16BE(2), 2);
    assert.equal(Buffer.from(pli).readUInt32BE(4), 0x12345678);
    assert.equal(Buffer.from(pli).readUInt32BE(8), 0x87654321);

    const broadcasted: Uint8Array[] = [];
    const session = {
      localVideoSsrc: 0x12345678,
      peerVideoSsrc: 0x87654321,
      sctpRelay: {
        hasConnection: () => true,
        broadcast: (pkt: Uint8Array) => {
          broadcasted.push(pkt);
          return true;
        },
      },
    };
    const sent = sendRtcpPliOnMediaSession(session);
    assert.equal(sent, true);
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0][1], 206);
  });

  it('records inbound video RTP + wall-clock padded PCM audio and muxes a final MP4 on call stop', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-vcall-rec-'));
    try {
      const outboundVideoPath = path.join(tmpDir, 'bot_outbound.mp4');
      await generatePlayableVoipMp4File(outboundVideoPath, {
        width: 320,
        height: 240,
        frameRate: 15,
        durationSeconds: 2,
        includeAudio: true,
      });

      const recorder = new VoipCallRecorder({
        callId: 'vcall_test_two_way',
        sessionId: 'sess_rec_1',
        recipientJid: '966501234567@s.whatsapp.net',
        outboundVideoPath,
        recordingsDir: tmpDir,
        isMockMode: false,
      });

      const peerKeys: SrtpKeyMaterial = {
        sessionKey: crypto.randomBytes(16),
        sessionSalt: crypto.randomBytes(14),
        authKey: crypto.randomBytes(20),
        authTagLen: 4,
      };

      const fakeSession: Record<string, unknown> = {
        localVideoSsrc: 1001,
        peerAudioSsrc: 2001,
        peerVideoSsrc: 2002,
        srtpSession: { recvCtx: peerKeys },
        videoSrtpSession: { recvCtx: peerKeys },
        sctpRelay: {
          hasConnection: () => true,
          broadcast: () => true,
        },
        onRelayData: () => undefined,
        onDecodedAudio: () => undefined,
      };

      recorder.attachToMediaSession(fakeSession);

      // Feed inbound SPS (7), PPS (8), and IDR (5) over SRTP through session.onRelayData
      const onRelayData = fakeSession.onRelayData as (pkt: Uint8Array) => void;
      const onDecodedAudio = fakeSession.onDecodedAudio as (
        pcm: Int16Array
      ) => void;

      const spsPkt = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 1,
          timestamp: 9000,
          ssrc: 2002,
          payload: new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0x2d]),
        }),
        peerKeys
      );
      const ppsPkt = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 2,
          timestamp: 9000,
          ssrc: 2002,
          payload: new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
        }),
        peerKeys
      );
      const idrPkt = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 3,
          timestamp: 9000,
          ssrc: 2002,
          marker: true,
          payload: new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0]),
        }),
        peerKeys
      );

      onRelayData(spsPkt);
      onRelayData(ppsPkt);
      onRelayData(idrPkt);

      // Feed decoded 16kHz PCM audio with a 200ms wall-clock gap to verify silence padding
      const baseMs = Date.now();
      const sampleFrame = new Int16Array(320).fill(1024); // 20ms at 16kHz
      recorder.recordInboundAudioPcm(sampleFrame, baseMs);
      recorder.recordInboundAudioPcm(sampleFrame, baseMs + 250);
      onDecodedAudio(sampleFrame);

      const summary = await recorder.finalizeRecording();
      assert.equal(summary.recordingStatus, 'READY');
      assert.ok(summary.recordedVideoPath);
      assert.ok(fs.existsSync(summary.recordedVideoPath));
      assert.ok((summary.recordedVideoSizeBytes ?? 0) > 100);
      assert.equal(summary.inboundVideoPacketsReceived, 3);
      assert.equal(summary.inboundVideoFramesRecorded, 1);
      assert.equal(summary.inboundAudioPacketsReceived, 3);
      // 3 frames * 640 bytes + ~230ms silence (~7360 bytes) > 1920 bytes
      assert.ok(summary.inboundAudioBytesRecorded > 3 * 640);
      // Verify temporary raw files were deleted after muxing
      assert.equal(fs.existsSync(recorder.remoteVideoTempPath), false);
      assert.equal(fs.existsSync(recorder.remoteAudioTempPath), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('finalizes call recording in RealVideoCallService and emits call:recording-ready on stop', async () => {
    const service = new RealVideoCallService();
    const driver = new MockWhatsAppSessionDriver('sess_vcall_rec');
    await driver.connect({ onStatusChange: () => undefined });
    driver.completeSimulatedPairing();
    service.attachSession('sess_vcall_rec', driver);

    let readyPayload: Record<string, unknown> | undefined;
    service.on('call:recording-ready', (payload) => {
      readyPayload = payload;
    });

    const stream = await service.startVideoCall({
      sessionId: 'sess_vcall_rec',
      driver,
      recipientJid: '966501234567@s.whatsapp.net',
      recordCall: true,
    });

    assert.equal(stream.recordingEnabled, true);
    assert.equal(stream.recordingStatus, 'RECORDING');

    const stopped = await service.stopVideoCall(
      'sess_vcall_rec',
      stream.callId
    );
    assert.ok(stopped);
    assert.equal(stopped.recordingStatus, 'READY');
    assert.ok(stopped.recordedVideoPath);
    assert.ok(fs.existsSync(stopped.recordedVideoPath));
    assert.ok(readyPayload);
    assert.equal(readyPayload.callId, stream.callId);

    try {
      fs.unlinkSync(stopped.recordedVideoPath);
    } catch {
      // Ignore cleanup error
    }
  });

  it('decrypts both 4-byte (HMAC-SHA1-32) and 10-byte (HMAC-SHA1-80) SRTP packets with independent srtpBySsrc states (audio seq=800, video seq=10)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-vcall-srtp-'));
    try {
      const recorder = new VoipCallRecorder({
        callId: 'vcall_srtp_tag_test',
        sessionId: 'sess_srtp_1',
        recipientJid: '966501234567@s.whatsapp.net',
        outboundVideoPath: path.join(tmpDir, 'unused_outbound.mp4'),
        recordingsDir: tmpDir,
        isMockMode: false,
      });

      const peerKeys4: SrtpKeyMaterial = {
        sessionKey: crypto.randomBytes(16),
        sessionSalt: crypto.randomBytes(14),
        authKey: crypto.randomBytes(20),
        authTagLen: 4,
      };

      const fakeSession: Record<string, unknown> = {
        localVideoSsrc: 1001,
        peerAudioSsrc: 0xaaaa1111,
        peerVideoSsrc: 0xbbbb2222,
        srtpSession: { recvCtx: peerKeys4 },
        videoSrtpSession: { recvCtx: peerKeys4 },
      };

      recorder.attachToMediaSession(fakeSession);

      // Simulate high audio sequence number (800) on audio SSRC first
      const audioRtp = buildRawRtpPacket({
        payloadType: 120,
        seq: 800,
        timestamp: 48000,
        ssrc: 0xaaaa1111,
        payload: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
      });
      const srtpAudio = protectRtpForTest(audioRtp, peerKeys4);
      const decAudio = new PerSsrcSrtpDecryptor().unprotectRtpPacket(
        srtpAudio,
        peerKeys4
      );
      assert.ok(decAudio);

      // Now feed video packets with low sequence numbers (10, 11) and 10-byte auth tag (HMAC-SHA1-80)
      // even though peerKeys4 has authTagLen = 4 configured by default
      const peerKeys10: SrtpKeyMaterial = {
        ...peerKeys4,
        authTagLen: 10,
      };
      const pFrameBeforeIdr = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 9,
          timestamp: 8000,
          ssrc: 0xbbbb2222,
          marker: true,
          payload: new Uint8Array([0x41, 0x9a, 0x24, 0x6c]),
        }),
        peerKeys10
      );
      const spsVideo10 = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 10,
          timestamp: 9000,
          ssrc: 0xbbbb2222,
          payload: new Uint8Array([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0x2d]),
        }),
        peerKeys10
      );
      const ppsVideo10 = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 11,
          timestamp: 9000,
          ssrc: 0xbbbb2222,
          payload: new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
        }),
        peerKeys10
      );
      const idrVideo4 = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 12,
          timestamp: 9000,
          ssrc: 0xbbbb2222,
          marker: true,
          payload: new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0]),
        }),
        peerKeys4
      );

      // P-frame before first IDR must be parsed but NOT written to remote_video.h264
      const resPBefore = recorder.handleInboundVideoPacket(
        pFrameBeforeIdr,
        fakeSession
      );
      assert.ok(resPBefore);
      assert.deepEqual(resPBefore.nalTypes, [1]);
      assert.equal(
        fs.existsSync(recorder.remoteVideoTempPath)
          ? fs.statSync(recorder.remoteVideoTempPath).size
          : 0,
        0,
        'P-frames before first IDR must never be written to remote_video.h264'
      );

      const res10 = recorder.handleInboundVideoPacket(spsVideo10, fakeSession);
      assert.ok(res10);
      assert.deepEqual(res10.nalTypes, [7]);
      assert.ok(recorder.cachedSps);
      assert.equal(recorder.cachedPps, null);

      // Sending an IDR before PPS is received must be dropped (not written to remote_video.h264)
      const idrBeforePps = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 11,
          timestamp: 9000,
          ssrc: 0xbbbb2222,
          marker: true,
          payload: new Uint8Array([0x65, 0x11, 0x22, 0x33]),
        }),
        peerKeys10
      );
      recorder.handleInboundVideoPacket(idrBeforePps, fakeSession);
      assert.equal(
        fs.existsSync(recorder.remoteVideoTempPath)
          ? fs.statSync(recorder.remoteVideoTempPath).size
          : 0,
        0,
        'IDR frame without cachedPps must never be written to remote_video.h264'
      );

      const ppsVideoSeq12 = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 12,
          timestamp: 9000,
          ssrc: 0xbbbb2222,
          payload: new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
        }),
        peerKeys10
      );
      const idrVideoSeq13 = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 96,
          seq: 13,
          timestamp: 9000,
          ssrc: 0xbbbb2222,
          marker: true,
          payload: new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0]),
        }),
        peerKeys4
      );

      const resPps = recorder.handleInboundVideoPacket(ppsVideoSeq12, fakeSession);
      const res4 = recorder.handleInboundVideoPacket(idrVideoSeq13, fakeSession);

      assert.ok(resPps);
      assert.deepEqual(resPps.nalTypes, [8]);
      assert.ok(res4);
      assert.deepEqual(res4.nalTypes, [5]);
      assert.ok(recorder.cachedSps);
      assert.ok(recorder.cachedPps);
      assert.equal(recorder.srtpBySsrc.get(0xbbbb2222)?.lastSeq, 13);

      // Verify remote_video.h264 starts with 0x00000001 + SPS (0x67) + 0x00000001 + PPS (0x68) + 0x00000001 + IDR (0x65)
      const h264Bytes = fs.readFileSync(recorder.remoteVideoTempPath);
      assert.equal(h264Bytes[0], 0x00);
      assert.equal(h264Bytes[1], 0x00);
      assert.equal(h264Bytes[2], 0x00);
      assert.equal(h264Bytes[3], 0x01);
      assert.equal(h264Bytes[4], 0x67);
      // After 4-byte start code + 8-byte SPS = offset 12: 0x00000001 + PPS (0x68)
      assert.equal(h264Bytes[12], 0x00);
      assert.equal(h264Bytes[13], 0x00);
      assert.equal(h264Bytes[14], 0x00);
      assert.equal(h264Bytes[15], 0x01);
      assert.equal(h264Bytes[16], 0x68);
      // After 4-byte start code + 4-byte PPS = offset 20: 0x00000001 + IDR (0x65)
      assert.equal(h264Bytes[20], 0x00);
      assert.equal(h264Bytes[21], 0x00);
      assert.equal(h264Bytes[22], 0x00);
      assert.equal(h264Bytes[23], 0x01);
      assert.equal(h264Bytes[24], 0x65);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('never copies or re-encodes outboundVideoPath when recipient camera is closed (returns NO_REMOTE_CAMERA)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-no-cam-'));
    try {
      const outboundVideoPath = path.join(tmpDir, 'local_uploaded_video.mp4');
      fs.writeFileSync(
        outboundVideoPath,
        Buffer.from('LOCAL_UPLOADED_VIDEO_SENTINEL_BYTES_DO_NOT_COPY')
      );

      const recorder = new VoipCallRecorder({
        callId: 'vcall_no_remote_cam',
        sessionId: 'sess_no_cam',
        recipientJid: '966501234567@s.whatsapp.net',
        outboundVideoPath,
        recordingsDir: tmpDir,
        isMockMode: false,
      });

      // Only inbound audio, zero inbound video frames
      recorder.recordInboundAudioPcm(new Int16Array(320).fill(512), Date.now());

      const summary = await recorder.finalizeRecording();
      assert.equal(summary.recordingStatus, 'NO_REMOTE_CAMERA');
      assert.equal(summary.remoteCameraCaptured, false);
      assert.equal(summary.recordedVideoPath, undefined);
      assert.equal(summary.inboundVideoFramesRecorded, 0);
      assert.ok(
        summary.failureReason?.includes(
          'لم يتم إرسال فيديو تسجيل لأن الطرف المستقبل لم يفتح الكاميرا'
        )
      );

      // Verify executeFinalizeRecording source code contains zero references to this.outboundVideoPath
      const recorderSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/whatsapp/voip-call-recorder.ts'),
        'utf8'
      );
      const finalizeSection =
        recorderSource.split('private async executeFinalizeRecording')[1] || '';
      assert.equal(
        finalizeSection.includes('this.outboundVideoPath'),
        false,
        'executeFinalizeRecording must never reference this.outboundVideoPath'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('spawns FFmpeg on WaVideoEngine when videoLoop is true and emits H.264 Access Units without short-circuiting on this.running', async () => {
    const {
      ensureHiroosyVoipRuntimePatched,
      instrumentVideoEngineInstance,
    } = await import('../../src/whatsapp/voip-runtime-patch');
    await ensureHiroosyVoipRuntimePatched();

    const fakeEngine: {
      sourceKind: 'blank';
      videoLoop: boolean;
      width: number;
      height: number;
      frameRate: number;
      frameDurationMs: number;
      running: boolean;
      pending: Uint8Array;
      accessUnitsSent: number;
      videoPath: string | null;
      waitingForKeyFrame: boolean;
      proc?: unknown;
      lastGeneratedFfmpegArgs?: string[];
      start: (onAccessUnit?: (au: Uint8Array) => void) => unknown;
      stop?: () => void;
    } = {
      sourceKind: 'blank' as const,
      videoLoop: true,
      width: 320,
      height: 240,
      frameRate: 30,
      frameDurationMs: 33.33,
      running: false,
      pending: new Uint8Array(0),
      accessUnitsSent: 0,
      videoPath: null,
      waitingForKeyFrame: true,
      // Simulate real WaVideoEngine.prototype.start which checks `if (this.running) return;`
      start(onAccessUnit?: (au: Uint8Array) => void) {
        if (this.running) return null;
        if (onAccessUnit) {
          (this as { onAccessUnit?: (au: Uint8Array) => void }).onAccessUnit =
            onAccessUnit;
        }
        return (this as { spawnFfmpeg?: () => unknown }).spawnFfmpeg?.();
      },
    };

    instrumentVideoEngineInstance(fakeEngine);
    assert.equal(fakeEngine.frameRate, 15);
    assert.equal(fakeEngine.frameDurationMs, 1000 / 15);

    try {
      const proc = fakeEngine.start(() => undefined);
      assert.ok(
        proc && fakeEngine.proc,
        'WaVideoEngine.start with videoLoop=true must spawn FFmpeg process instead of short-circuiting on this.running'
      );
      assert.equal(fakeEngine.running, true);
      assert.ok(
        Array.isArray(fakeEngine.lastGeneratedFfmpegArgs) &&
          fakeEngine.lastGeneratedFfmpegArgs.includes('libx264')
      );
    } finally {
      fakeEngine.stop?.();
    }
  });

  it('bypasses SCTP reorderBuffer head-of-line blocking for ordered inbound video RTP packets and captures relay_receive { ip, port, data } + delegate.emitInboundVideo(info, accessUnit)', async () => {
    const { ensureHiroosyVoipRuntimePatched } = await import(
      '../../src/whatsapp/voip-runtime-patch'
    );
    await ensureHiroosyVoipRuntimePatched();

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'botezz-sctp-cam-rec-')
    );
    try {
      const recorder = new VoipCallRecorder({
        callId: 'vcall_sctp_relay_obj',
        sessionId: 'sess_sctp_1',
        recipientJid: '966501234567@s.whatsapp.net',
        outboundVideoPath: path.join(tmpDir, 'unused_outbound.mp4'),
        recordingsDir: tmpDir,
        isMockMode: false,
      });

      // Derive keys using per-JID HKDF (matching WaCallMediaSession.handleCallAccept)
      const peerCallKey = crypto.randomBytes(30);
      const acceptedByJid = '1234567890:0@lid';

      const relayListeners = new Map<string, Array<(arg: unknown) => void>>();
      const fakeSession: Record<string, unknown> = {
        acceptedByJid,
        __peerCallKey: new Uint8Array(peerCallKey),
        peerVideoSsrc: 0x55667788,
        sctpRelay: {
          hasConnection: () => true,
          broadcast: () => true,
          on(event: string, cb: (arg: unknown) => void) {
            const list = relayListeners.get(event) ?? [];
            list.push(cb);
            relayListeners.set(event, list);
          },
        },
        delegate: {
          emitInboundVideo: (_info: unknown, _au: Uint8Array) => undefined,
        },
      };

      recorder.attachToMediaSession(fakeSession);

      // 1. Test `relay_receive` emitting `{ ip, port, data }` object (exact WaManualRelay shape)
      //    encrypted with per-JID HKDF key derived from `(peerCallKey, acceptedByJid)` and 10-byte auth tag
      const perJidDerived = new Uint8Array(
        crypto.hkdfSync(
          'sha256',
          peerCallKey,
          new Uint8Array(0),
          Buffer.from(acceptedByJid, 'utf8'),
          30
        )
      );
      const { deriveSrtpSessionKeysFromMaster } = await import(
        '../../src/whatsapp/voip-call-recorder'
      );
      const perJidKeys10 = deriveSrtpSessionKeysFromMaster(
        perJidDerived.subarray(0, 16),
        perJidDerived.subarray(16, 30),
        10
      );

      const spsPkt = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 97,
          seq: 50,
          timestamp: 18000,
          ssrc: 0x55667788,
          payload: new Uint8Array([
            0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0x2d,
          ]),
        }),
        perJidKeys10
      );
      const ppsPkt = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 97,
          seq: 51,
          timestamp: 18000,
          ssrc: 0x55667788,
          payload: new Uint8Array([0x68, 0xce, 0x3c, 0x80]),
        }),
        perJidKeys10
      );
      const idrPkt = protectRtpForTest(
        buildRawRtpPacket({
          payloadType: 97,
          seq: 52,
          timestamp: 18000,
          ssrc: 0x55667788,
          marker: true,
          payload: new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0]),
        }),
        perJidKeys10
      );

      for (const pkt of [spsPkt, ppsPkt, idrPkt]) {
        for (const cb of relayListeners.get('relay_receive') ?? []) {
          cb({ ip: '157.240.1.1', port: 3478, data: pkt });
        }
      }

      assert.equal(recorder.getSummary().inboundVideoPacketsReceived, 3);
      assert.equal(recorder.getSummary().inboundVideoFramesRecorded, 1);

      // 2. Test `delegate.emitInboundVideo(info, accessUnit)` (2-argument Annex-B signature)
      const delegateObj = fakeSession.delegate as {
        emitInboundVideo: (info: unknown, au: Uint8Array) => void;
      };
      const annexBPFrame = new Uint8Array([
        0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x24, 0x6c,
      ]);
      delegateObj.emitInboundVideo({ callId: 'vcall_sctp_relay_obj' }, annexBPFrame);

      assert.equal(recorder.getSummary().inboundVideoFramesRecorded, 2);

      const summary = await recorder.finalizeRecording();
      assert.equal(summary.recordingStatus, 'READY');
      assert.equal(summary.remoteCameraCaptured, true);
      assert.ok(summary.recordedVideoPath);
      assert.ok(fs.existsSync(summary.recordedVideoPath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

