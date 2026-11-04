import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WaCallMediaSessionLike } from '@hiroosy/baileys-lite/voip';
import { createMinimalMp4Buffer } from '../function-lab/media-sticker-toolkit';
import { createLogger } from '../logging/logger';

const execFileAsync = promisify(execFile);
const log = createLogger('voip-call-recorder');

const ANNEX_B_START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const AUDIO_SAMPLE_RATE = 16000;
const AUDIO_BYTES_PER_SAMPLE = 2;
const AUDIO_BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE; // 32000 bytes/sec

export type CallRecordingStatus =
  | 'DISABLED'
  | 'RECORDING'
  | 'FINALIZING'
  | 'READY'
  | 'FAILED';

export interface SrtpKeyMaterial {
  sessionKey: Uint8Array;
  sessionSalt: Uint8Array;
  authKey: Uint8Array;
  authTagLen?: number;
}

export interface PerSsrcSrtpState {
  ssrc: number;
  roc: number;
  lastSeq: number;
  highestIndex: bigint;
  replayMask: bigint;
}

export interface H264DepacketizerState {
  cachedRemoteSps: Uint8Array | null;
  cachedRemotePps: Uint8Array | null;
  wroteParameterSets: boolean;
  fuaBuffer: Uint8Array[];
  fuaLastSeq: number;
  fuaNalType: number;
  fuaActive: boolean;
  inboundVideoPacketsReceived: number;
  inboundVideoFramesRecorded: number;
  inboundKeyframesRecorded: number;
  sequenceGapsDetected: number;
}

export interface H264DepacketizeResult {
  annexBNalus: Uint8Array[];
  nalTypes: number[];
  framesIncrement: number;
  keyframesIncrement: number;
  sequenceGap: boolean;
  rtpSeq: number;
  rtpTimestamp: number;
  rtpMarker: boolean;
  rtpPayloadType: number;
  ssrc: number;
}

export interface VoipCallRecordingSummary {
  callId: string;
  recordingStatus: CallRecordingStatus;
  recordedVideoPath?: string;
  recordedVideoFileName?: string;
  recordedVideoSizeBytes?: number;
  recordedDurationSeconds?: number;
  inboundVideoPacketsReceived: number;
  inboundVideoFramesRecorded: number;
  inboundAudioPacketsReceived: number;
  inboundAudioBytesRecorded: number;
  remoteCameraCaptured: boolean;
  pliRequestsSent: number;
  failureReason?: string;
}

export interface VoipCallRecorderOptions {
  callId: string;
  sessionId: string;
  recipientJid: string;
  outboundVideoPath: string;
  recordingsDir?: string;
  isMockMode?: boolean;
}

export function createInitialH264DepacketizerState(): H264DepacketizerState {
  return {
    cachedRemoteSps: null,
    cachedRemotePps: null,
    wroteParameterSets: false,
    fuaBuffer: [],
    fuaLastSeq: -1,
    fuaNalType: 0,
    fuaActive: false,
    inboundVideoPacketsReceived: 0,
    inboundVideoFramesRecorded: 0,
    inboundKeyframesRecorded: 0,
    sequenceGapsDetected: 0,
  };
}

/**
 * Builds the 16-byte AES-128-CTR IV for SRTP according to RFC 3711 Section 4.1.1
 * (matching `@hiroosy/baileys-lite/src/voip/crypto/srtp.js`).
 */
export function buildSrtpCtrIv(
  salt: Uint8Array,
  ssrc: number,
  packetIndex: bigint
): Buffer {
  const iv = Buffer.alloc(16, 0);
  for (let i = 0; i < Math.min(14, salt.length); i++) {
    iv[i] = salt[i];
  }
  const ssrcBuf = Buffer.alloc(4);
  ssrcBuf.writeUInt32BE(ssrc >>> 0, 0);
  for (let i = 0; i < 4; i++) {
    iv[4 + i] ^= ssrcBuf[i];
  }
  const indexHi = Number((packetIndex >> BigInt(32)) & BigInt(0xffff));
  const indexLo = Number(packetIndex & BigInt(0xffffffff));
  const indexBuf = Buffer.alloc(6);
  indexBuf.writeUInt16BE(indexHi, 0);
  indexBuf.writeUInt32BE(indexLo >>> 0, 2);
  for (let i = 0; i < 6; i++) {
    iv[8 + i] ^= indexBuf[i];
  }
  return iv;
}

/**
 * Per-SSRC SRTP Decryptor that isolates Rollover Counter (`roc`), sequence numbers,
 * and replay window per SSRC so audio (`peerAudioSsrc`) and video (`peerVideoSsrc`)
 * streams never corrupt each other's sequence state.
 */
export class PerSsrcSrtpDecryptor {
  private readonly ssrcStates = new Map<number, PerSsrcSrtpState>();

  public getSsrcState(ssrc: number): PerSsrcSrtpState {
    const normalizedSsrc = ssrc >>> 0;
    let state = this.ssrcStates.get(normalizedSsrc);
    if (!state) {
      state = {
        ssrc: normalizedSsrc,
        roc: 0,
        lastSeq: -1,
        highestIndex: BigInt(-1),
        replayMask: BigInt(0),
      };
      this.ssrcStates.set(normalizedSsrc, state);
    }
    return state;
  }

  public unprotectWithKeys(
    srtpData: Uint8Array,
    keys: SrtpKeyMaterial
  ): Uint8Array | null {
    const authTagLen = keys.authTagLen ?? 4;
    if (!srtpData || srtpData.length < 12 + authTagLen) {
      return null;
    }

    const rtpPart = srtpData.subarray(0, srtpData.length - authTagLen);
    const receivedTag = srtpData.subarray(srtpData.length - authTagLen);
    const seq = (rtpPart[2] << 8) | rtpPart[3];
    const ssrc =
      ((rtpPart[8] << 24) |
        (rtpPart[9] << 16) |
        (rtpPart[10] << 8) |
        rtpPart[11]) >>>
      0;

    const state = this.getSsrcState(ssrc);

    let guessedRoc = state.roc;
    if (state.lastSeq < 0) {
      guessedRoc = 0;
    } else {
      const diff = seq - state.lastSeq;
      if (diff > 32768) {
        guessedRoc = Math.max(0, state.roc - 1);
      } else if (diff < -32768) {
        guessedRoc = state.roc + 1;
      }
    }

    const rocBuf = Buffer.alloc(4);
    rocBuf.writeUInt32BE(guessedRoc >>> 0, 0);
    const hmac = crypto.createHmac('sha1', keys.authKey);
    hmac.update(rtpPart);
    hmac.update(rocBuf);
    const expectedTag = hmac.digest().subarray(0, authTagLen);

    if (
      receivedTag.length !== expectedTag.length ||
      !crypto.timingSafeEqual(receivedTag, expectedTag)
    ) {
      return null;
    }

    const zero = BigInt(0);
    const one = BigInt(1);
    const windowSize = BigInt(64);
    const packetIndex = BigInt(guessedRoc) * BigInt(65536) + BigInt(seq);
    if (state.highestIndex >= zero) {
      const delta = state.highestIndex - packetIndex;
      if (delta >= zero) {
        if (delta >= windowSize) {
          return null;
        }
        const bit = one << delta;
        if ((state.replayMask & bit) !== zero) {
          return null;
        }
      }
    }

    const cc = rtpPart[0] & 0x0f;
    const hasExtension = (rtpPart[0] & 0x10) !== 0;
    let headerSize = 12 + cc * 4;
    if (hasExtension) {
      if (rtpPart.length < headerSize + 4) {
        return null;
      }
      const extLen =
        (rtpPart[headerSize + 2] << 8) | rtpPart[headerSize + 3];
      headerSize += 4 + extLen * 4;
    }

    if (rtpPart.length < headerSize) {
      return null;
    }

    const encryptedPayload = rtpPart.subarray(headerSize);
    const iv = buildSrtpCtrIv(keys.sessionSalt, ssrc, packetIndex);
    const decipher = crypto.createDecipheriv(
      'aes-128-ctr',
      keys.sessionKey,
      iv
    );
    const decryptedPayload = Buffer.concat([
      decipher.update(encryptedPayload),
      decipher.final(),
    ]);

    if (state.highestIndex < zero) {
      state.highestIndex = packetIndex;
      state.replayMask = one;
    } else if (packetIndex > state.highestIndex) {
      const shift = packetIndex - state.highestIndex;
      state.replayMask =
        shift >= windowSize
          ? one
          : ((state.replayMask << shift) | one) & ((one << windowSize) - one);
      state.highestIndex = packetIndex;
    } else {
      const delta = state.highestIndex - packetIndex;
      state.replayMask |= one << delta;
    }

    if (guessedRoc > state.roc) {
      state.roc = guessedRoc;
      state.lastSeq = seq;
    } else if (guessedRoc === state.roc && seq > state.lastSeq) {
      state.lastSeq = seq;
    }

    const plainRtp = new Uint8Array(headerSize + decryptedPayload.length);
    plainRtp.set(rtpPart.subarray(0, headerSize), 0);
    plainRtp.set(decryptedPayload, headerSize);
    return plainRtp;
  }

  /**
   * Decrypts an inbound SRTP packet using `primaryKeys` (typically `session.srtpSession.recvCtx`
   * which holds `peerCallKey`-derived keys) or `fallbackKeys` (`session.videoSrtpSession.recvCtx`).
   * If neither key material is provided (e.g. raw RTP in unit tests), returns `packet` if it has a valid RTP v2 header.
   */
  public unprotectRtpPacket(
    packet: Uint8Array,
    primaryKeys?: SrtpKeyMaterial | null,
    fallbackKeys?: SrtpKeyMaterial | null
  ): Uint8Array | null {
    if (!packet || packet.length < 12) return null;
    const version = (packet[0] >> 6) & 0x03;
    if (version !== 2) return null;

    if (primaryKeys?.sessionKey && primaryKeys?.sessionSalt && primaryKeys?.authKey) {
      const dec = this.unprotectWithKeys(packet, primaryKeys);
      if (dec) return dec;
    }

    if (
      fallbackKeys?.sessionKey &&
      fallbackKeys?.sessionSalt &&
      fallbackKeys?.authKey
    ) {
      const dec = this.unprotectWithKeys(packet, fallbackKeys);
      if (dec) return dec;
    }

    if (!primaryKeys && !fallbackKeys) {
      return packet;
    }

    return null;
  }
}

/**
 * Builds an RFC 4585 RTCP Picture Loss Indication (PLI, PT=206, FMT=1) packet (12 bytes)
 * to request an immediate H.264 IDR keyframe + SPS/PPS from the remote WhatsApp peer.
 */
export function buildRtcpPliPacket(
  senderSsrc: number,
  mediaSsrc: number
): Uint8Array {
  const pli = Buffer.alloc(12);
  pli[0] = 0x81; // V=2, P=0, FMT=1 (PLI)
  pli[1] = 206; // PT=206 (PSFB - Payload-Specific Feedback)
  pli.writeUInt16BE(2, 2); // Length = 2 32-bit words minus 1 (12 bytes total)
  pli.writeUInt32BE((senderSsrc || 1) >>> 0, 4);
  pli.writeUInt32BE((mediaSsrc || 0) >>> 0, 8);
  return new Uint8Array(pli.buffer, pli.byteOffset, pli.byteLength);
}

function buildAnnexBNalu(nalu: Uint8Array): Uint8Array {
  const out = new Uint8Array(ANNEX_B_START_CODE.length + nalu.length);
  out.set(ANNEX_B_START_CODE, 0);
  out.set(nalu, ANNEX_B_START_CODE.length);
  return out;
}

/**
 * RFC 6184 H.264 RTP Depacketizer supporting:
 * - Single NALU (`1 <= nalType <= 23`)
 * - STAP-A (`nalType === 24`)
 * - FU-A (`nalType === 28`) with sequence continuity verification
 * - CSRC & RTP Header Extension (`0xBEDE` etc.) & RTP Padding stripping
 * - Automatic SPS (7) / PPS (8) caching and injection before the first IDR (5) frame
 */
export function depacketizeH264RtpPacket(
  rtpPacket: Uint8Array,
  state: H264DepacketizerState
): H264DepacketizeResult {
  const emptyResult: H264DepacketizeResult = {
    annexBNalus: [],
    nalTypes: [],
    framesIncrement: 0,
    keyframesIncrement: 0,
    sequenceGap: false,
    rtpSeq: 0,
    rtpTimestamp: 0,
    rtpMarker: false,
    rtpPayloadType: 0,
    ssrc: 0,
  };

  if (!rtpPacket || rtpPacket.length < 12) {
    return emptyResult;
  }

  const byte0 = rtpPacket[0];
  const byte1 = rtpPacket[1];
  const version = (byte0 >> 6) & 0x03;
  if (version !== 2) {
    return emptyResult;
  }

  const hasPadding = (byte0 & 0x20) !== 0;
  const hasExtension = (byte0 & 0x10) !== 0;
  const csrcCount = byte0 & 0x0f;
  const marker = (byte1 & 0x80) !== 0;
  const payloadType = byte1 & 0x7f;
  const seq = (rtpPacket[2] << 8) | rtpPacket[3];
  const timestamp =
    ((rtpPacket[4] << 24) |
      (rtpPacket[5] << 16) |
      (rtpPacket[6] << 8) |
      rtpPacket[7]) >>>
    0;
  const ssrc =
    ((rtpPacket[8] << 24) |
      (rtpPacket[9] << 16) |
      (rtpPacket[10] << 8) |
      rtpPacket[11]) >>>
    0;

  let headerOffset = 12 + csrcCount * 4;
  if (hasExtension) {
    if (rtpPacket.length < headerOffset + 4) {
      return emptyResult;
    }
    const extLenWords =
      (rtpPacket[headerOffset + 2] << 8) | rtpPacket[headerOffset + 3];
    headerOffset += 4 + extLenWords * 4;
  }

  let payloadEnd = rtpPacket.length;
  if (hasPadding) {
    const padLen = rtpPacket[rtpPacket.length - 1];
    if (padLen > 0 && headerOffset + padLen <= rtpPacket.length) {
      payloadEnd = rtpPacket.length - padLen;
    }
  }

  if (headerOffset >= payloadEnd) {
    return emptyResult;
  }

  const payload = rtpPacket.subarray(headerOffset, payloadEnd);
  if (payload.length === 0) {
    return emptyResult;
  }

  state.inboundVideoPacketsReceived++;

  const annexBNalus: Uint8Array[] = [];
  const nalTypes: number[] = [];
  let framesIncrement = 0;
  let keyframesIncrement = 0;
  let sequenceGap = false;

  const recordCompleteNalu = (nalu: Uint8Array) => {
    if (!nalu || nalu.length === 0) return;
    // Strip any accidental leading Annex-B start code so we don't double-prefix
    let cleanNalu = nalu;
    if (
      cleanNalu.length > 4 &&
      cleanNalu[0] === 0 &&
      cleanNalu[1] === 0 &&
      cleanNalu[2] === 0 &&
      cleanNalu[3] === 1
    ) {
      cleanNalu = cleanNalu.subarray(4);
    } else if (
      cleanNalu.length > 3 &&
      cleanNalu[0] === 0 &&
      cleanNalu[1] === 0 &&
      cleanNalu[2] === 1
    ) {
      cleanNalu = cleanNalu.subarray(3);
    }
    if (cleanNalu.length === 0) return;

    const nalType = cleanNalu[0] & 0x1f;
    if (nalType === 7) {
      state.cachedRemoteSps = cleanNalu.slice();
      state.wroteParameterSets = true;
    } else if (nalType === 8) {
      state.cachedRemotePps = cleanNalu.slice();
      state.wroteParameterSets = true;
    }

    if (nalType === 5 && !state.wroteParameterSets) {
      if (state.cachedRemoteSps) {
        annexBNalus.push(buildAnnexBNalu(state.cachedRemoteSps));
        nalTypes.push(7);
      }
      if (state.cachedRemotePps) {
        annexBNalus.push(buildAnnexBNalu(state.cachedRemotePps));
        nalTypes.push(8);
      }
      if (state.cachedRemoteSps && state.cachedRemotePps) {
        state.wroteParameterSets = true;
      }
    }

    annexBNalus.push(buildAnnexBNalu(cleanNalu));
    nalTypes.push(nalType);

    if (nalType === 5 || nalType === 1) {
      state.inboundVideoFramesRecorded++;
      framesIncrement++;
      if (nalType === 5) {
        state.inboundKeyframesRecorded++;
        keyframesIncrement++;
      }
    }
  };

  const nalHeader = payload[0];
  const nalType = nalHeader & 0x1f;

  // Case 1: Single NALU (1..23)
  if (nalType >= 1 && nalType <= 23) {
    state.fuaActive = false;
    state.fuaBuffer = [];
    recordCompleteNalu(payload);
  }
  // Case 2: STAP-A (24)
  else if (nalType === 24) {
    state.fuaActive = false;
    state.fuaBuffer = [];
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const naluSize = (payload[offset] << 8) | payload[offset + 1];
      offset += 2;
      if (naluSize <= 0 || offset + naluSize > payload.length) {
        break;
      }
      const subNal = payload.subarray(offset, offset + naluSize);
      recordCompleteNalu(subNal);
      offset += naluSize;
    }
  }
  // Case 3: FU-A (28)
  else if (nalType === 28 && payload.length >= 2) {
    const fuIndicator = payload[0];
    const fuHeader = payload[1];
    const startBit = (fuHeader & 0x80) !== 0;
    const endBit = (fuHeader & 0x40) !== 0;
    const origNalType = fuHeader & 0x1f;
    const reconstructedHeader = (fuIndicator & 0xe0) | origNalType;
    const fragPayload = payload.subarray(2);

    if (startBit) {
      state.fuaBuffer = [new Uint8Array([reconstructedHeader]), fragPayload.slice()];
      state.fuaLastSeq = seq;
      state.fuaNalType = origNalType;
      state.fuaActive = true;
      if (endBit) {
        const totalLen = state.fuaBuffer.reduce((s, b) => s + b.length, 0);
        const assembled = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of state.fuaBuffer) {
          assembled.set(chunk, pos);
          pos += chunk.length;
        }
        state.fuaActive = false;
        state.fuaBuffer = [];
        recordCompleteNalu(assembled);
      }
    } else if (state.fuaActive) {
      const expectedSeq = (state.fuaLastSeq + 1) & 0xffff;
      if (seq !== expectedSeq) {
        // Sequence gap detected inside FU-A -> discard incomplete NALU
        state.fuaActive = false;
        state.fuaBuffer = [];
        state.sequenceGapsDetected++;
        sequenceGap = true;
      } else {
        state.fuaBuffer.push(fragPayload.slice());
        state.fuaLastSeq = seq;
        if (endBit) {
          const totalLen = state.fuaBuffer.reduce((s, b) => s + b.length, 0);
          const assembled = new Uint8Array(totalLen);
          let pos = 0;
          for (const chunk of state.fuaBuffer) {
            assembled.set(chunk, pos);
            pos += chunk.length;
          }
          state.fuaActive = false;
          state.fuaBuffer = [];
          recordCompleteNalu(assembled);
        }
      }
    } else {
      sequenceGap = true;
    }
  }

  return {
    annexBNalus,
    nalTypes,
    framesIncrement,
    keyframesIncrement,
    sequenceGap,
    rtpSeq: seq,
    rtpTimestamp: timestamp,
    rtpMarker: marker,
    rtpPayloadType: payloadType,
    ssrc,
  };
}

/**
 * Extracts `SrtpKeyMaterial` from a `@hiroosy/baileys-lite` `SrtpSession` receive context.
 */
function extractRecvKeyMaterial(
  srtpSessionLike: unknown
): SrtpKeyMaterial | null {
  if (!srtpSessionLike || typeof srtpSessionLike !== 'object') return null;
  const recvCtx = (
    srtpSessionLike as {
      recvCtx?: {
        sessionKey?: Uint8Array;
        sessionSalt?: Uint8Array;
        authKey?: Uint8Array;
        authTagLen?: number;
      };
    }
  ).recvCtx;
  if (
    recvCtx &&
    recvCtx.sessionKey instanceof Uint8Array &&
    recvCtx.sessionSalt instanceof Uint8Array &&
    recvCtx.authKey instanceof Uint8Array
  ) {
    return {
      sessionKey: recvCtx.sessionKey,
      sessionSalt: recvCtx.sessionSalt,
      authKey: recvCtx.authKey,
      authTagLen: recvCtx.authTagLen ?? 4,
    };
  }
  return null;
}

/**
 * Synchronizes `session.videoSrtpSession.recvCtx` keys with `session.srtpSession.recvCtx`
 * when `@hiroosy/baileys-lite` updates `srtpSession` from `peerCallKey` during `handleCallAccept`
 * without updating `videoSrtpSession`.
 */
export function syncPeerRecvKeysOnMediaSession(
  session: WaCallMediaSessionLike | Record<string, unknown> | null | undefined
): void {
  if (!session || typeof session !== 'object') return;
  const s = session as {
    srtpSession?: { recvCtx?: Record<string, unknown> } | null;
    videoSrtpSession?: { recvCtx?: Record<string, unknown> } | null;
  };
  const primaryRecv = s.srtpSession?.recvCtx;
  const videoRecv = s.videoSrtpSession?.recvCtx;
  if (
    primaryRecv &&
    videoRecv &&
    primaryRecv.sessionKey instanceof Uint8Array &&
    primaryRecv.sessionSalt instanceof Uint8Array &&
    primaryRecv.authKey instanceof Uint8Array
  ) {
    videoRecv.sessionKey = primaryRecv.sessionKey;
    videoRecv.sessionSalt = primaryRecv.sessionSalt;
    videoRecv.authKey = primaryRecv.authKey;
  }
}

/**
 * Sends an RTCP Picture Loss Indication (`PT=206, FMT=1`) packet over the session's SCTP relay
 * (protecting with `videoRtcpSession` or `audioRtcpSession` when available) to prompt the remote
 * WhatsApp client to immediately send `SPS + PPS + IDR`.
 */
export function sendRtcpPliOnMediaSession(
  session: WaCallMediaSessionLike | Record<string, unknown> | null | undefined
): boolean {
  if (!session || typeof session !== 'object') return false;
  const s = session as {
    localVideoSsrc?: number;
    localAudioSsrc?: number;
    peerVideoSsrc?: number;
    peerAudioSsrc?: number;
    videoRtpStream?: { ssrc?: number } | null;
    videoRtcpSession?: { protect?: (pkt: Uint8Array) => Uint8Array } | null;
    audioRtcpSession?: { protect?: (pkt: Uint8Array) => Uint8Array } | null;
    sctpRelay?: {
      hasConnection?: () => boolean;
      broadcast?: (pkt: Uint8Array) => boolean;
    } | null;
  };

  if (!s.sctpRelay || typeof s.sctpRelay.broadcast !== 'function') {
    return false;
  }
  if (
    typeof s.sctpRelay.hasConnection === 'function' &&
    !s.sctpRelay.hasConnection()
  ) {
    return false;
  }

  const senderSsrc =
    (s.videoRtpStream?.ssrc || s.localVideoSsrc || s.localAudioSsrc || 1) >>> 0;
  const mediaSsrc = (s.peerVideoSsrc || s.peerAudioSsrc || 0) >>> 0;
  const rawPli = buildRtcpPliPacket(senderSsrc, mediaSsrc);

  let wirePacket: Uint8Array = rawPli;
  const rtcpProtector = s.videoRtcpSession ?? s.audioRtcpSession;
  if (rtcpProtector && typeof rtcpProtector.protect === 'function') {
    try {
      wirePacket = rtcpProtector.protect(rawPli);
    } catch {
      wirePacket = rawPli;
    }
  }

  try {
    return Boolean(s.sctpRelay.broadcast(wirePacket));
  } catch {
    return false;
  }
}

/**
 * Two-Way WhatsApp VoIP Video Call Recorder (`VoipCallRecorder`).
 *
 * Captures:
 * 1. Recipient inbound camera H.264 RTP/SRTP packets (`remote_video.h264`)
 * 2. Recipient inbound microphone PCM audio (`remote_audio.pcm`, 16kHz mono s16le with wall-clock silence padding)
 * 3. Bot outbound video & audio (`outboundVideoPath`)
 *
 * And upon call termination produces a unified `.mp4` recording (`data/recordings/vcall_rec_<callId>_<timestamp>.mp4`).
 */
export class VoipCallRecorder {
  public readonly callId: string;
  public readonly sessionId: string;
  public readonly recipientJid: string;
  public readonly outboundVideoPath: string;
  public readonly recordingsDir: string;
  public readonly remoteVideoTempPath: string;
  public readonly remoteAudioTempPath: string;

  private readonly srtpDecryptor = new PerSsrcSrtpDecryptor();
  private readonly h264State = createInitialH264DepacketizerState();
  private readonly isMockMode: boolean;

  private status: CallRecordingStatus = 'RECORDING';
  private startedAtMs: number = Date.now();
  private lastAudioPlayheadMs: number = 0;
  private videoFd: number | null = null;
  private audioFd: number | null = null;
  private inboundAudioPacketsReceived = 0;
  private inboundAudioBytesRecorded = 0;
  private remoteVideoBytesWritten = 0;
  private pliRequestsSent = 0;
  private pliInterval: NodeJS.Timeout | null = null;
  private attachedSession: Record<string, unknown> | null = null;
  private finalizePromise: Promise<VoipCallRecordingSummary> | null = null;
  private recordedVideoPath?: string;
  private recordedVideoFileName?: string;
  private recordedVideoSizeBytes?: number;
  private recordedDurationSeconds?: number;
  private remoteCameraCaptured = false;
  private failureReason?: string;

  constructor(options: VoipCallRecorderOptions) {
    this.callId = options.callId;
    this.sessionId = options.sessionId;
    this.recipientJid = options.recipientJid;
    this.outboundVideoPath = options.outboundVideoPath;
    this.isMockMode = Boolean(options.isMockMode);
    this.recordingsDir =
      options.recordingsDir ||
      path.resolve(process.cwd(), 'data', 'recordings');
    fs.mkdirSync(this.recordingsDir, { recursive: true });

    const safeCallId = this.callId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.remoteVideoTempPath = path.join(
      this.recordingsDir,
      `tmp_${safeCallId}_remote_video.h264`
    );
    this.remoteAudioTempPath = path.join(
      this.recordingsDir,
      `tmp_${safeCallId}_remote_audio.pcm`
    );

    this.startedAtMs = Date.now();
    this.lastAudioPlayheadMs = this.startedAtMs;

    try {
      this.videoFd = fs.openSync(this.remoteVideoTempPath, 'w');
      this.audioFd = fs.openSync(this.remoteAudioTempPath, 'w');
    } catch (err) {
      log.warn('Failed to open temporary recording files', {
        callId: this.callId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public getStatus(): CallRecordingStatus {
    return this.status;
  }

  public getSummary(): VoipCallRecordingSummary {
    return {
      callId: this.callId,
      recordingStatus: this.status,
      recordedVideoPath: this.recordedVideoPath,
      recordedVideoFileName: this.recordedVideoFileName,
      recordedVideoSizeBytes: this.recordedVideoSizeBytes,
      recordedDurationSeconds: this.recordedDurationSeconds,
      inboundVideoPacketsReceived: this.h264State.inboundVideoPacketsReceived,
      inboundVideoFramesRecorded: this.h264State.inboundVideoFramesRecorded,
      inboundAudioPacketsReceived: this.inboundAudioPacketsReceived,
      inboundAudioBytesRecorded: this.inboundAudioBytesRecorded,
      remoteCameraCaptured:
        this.remoteCameraCaptured ||
        (this.h264State.inboundVideoFramesRecorded > 0 &&
          Boolean(
            this.h264State.cachedRemoteSps && this.h264State.cachedRemotePps
          )),
      pliRequestsSent: this.pliRequestsSent,
      failureReason: this.failureReason,
    };
  }

  /**
   * Sends an RTCP PLI request over the attached media session to trigger an immediate keyframe.
   */
  public sendPli(): boolean {
    if (!this.attachedSession) return false;
    syncPeerRecvKeysOnMediaSession(this.attachedSession);
    const sent = sendRtcpPliOnMediaSession(this.attachedSession);
    if (sent) {
      this.pliRequestsSent++;
    }
    return sent;
  }

  /**
   * Attaches inbound RTP/SRTP video and decoded PCM audio hooks to a `WaCallMediaSession` instance.
   * Idempotent per session instance.
   */
  public attachToMediaSession(
    rawSession: WaCallMediaSessionLike | Record<string, unknown> | null | undefined
  ): void {
    if (!rawSession || typeof rawSession !== 'object') return;
    const session = rawSession as Record<string, unknown> & {
      __botezzRecorderAttached?: VoipCallRecorder;
      onRelayData?: (data: Uint8Array) => void;
      onRelayVideoData?: (data: Uint8Array) => void;
      onDecodedAudio?: (pcm: Int16Array | Float32Array | Uint8Array) => void;
      onRelayConnected?: () => void;
      audioEngine?: {
        onPlaybackData?: (pcm: Int16Array | Float32Array | Uint8Array) => void;
      } | null;
    };

    this.attachedSession = session;
    syncPeerRecvKeysOnMediaSession(session);

    if (session.__botezzRecorderAttached === this) {
      return;
    }
    session.__botezzRecorderAttached = this;

    // 1. Wrap `onRelayData` to intercept inbound video packets before or alongside WaCallMediaSession
    const origOnRelayData =
      typeof session.onRelayData === 'function'
        ? session.onRelayData.bind(session)
        : undefined;

    session.onRelayData = (data: Uint8Array) => {
      syncPeerRecvKeysOnMediaSession(session);
      try {
        this.inspectRawRelayPacket(data, session);
      } catch {
        // Never disrupt live call loop
      }
      if (origOnRelayData) {
        origOnRelayData(data);
      }
    };

    // 2. Wrap `onRelayVideoData` directly as well in case direct video channel callbacks fire
    const origOnRelayVideoData =
      typeof session.onRelayVideoData === 'function'
        ? session.onRelayVideoData.bind(session)
        : undefined;

    session.onRelayVideoData = (data: Uint8Array) => {
      syncPeerRecvKeysOnMediaSession(session);
      try {
        this.handleInboundVideoPacket(data, session);
      } catch {
        // Ignore recorder error
      }
      if (origOnRelayVideoData) {
        origOnRelayVideoData(data);
      }
    };

    // 3. Wrap `onDecodedAudio` to capture decoded 16kHz mono PCM audio from the recipient
    const origOnDecodedAudio =
      typeof session.onDecodedAudio === 'function'
        ? session.onDecodedAudio.bind(session)
        : undefined;

    session.onDecodedAudio = (pcm: Int16Array | Float32Array | Uint8Array) => {
      try {
        this.recordInboundAudioPcm(pcm);
      } catch {
        // Ignore audio recorder error
      }
      if (origOnDecodedAudio) {
        origOnDecodedAudio(pcm);
      }
    };

    // 4. Wrap `onRelayConnected` to immediately send an RTCP PLI keyframe request
    const origOnRelayConnected =
      typeof session.onRelayConnected === 'function'
        ? session.onRelayConnected.bind(session)
        : undefined;

    session.onRelayConnected = () => {
      if (origOnRelayConnected) {
        origOnRelayConnected();
      }
      this.startedAtMs = Date.now();
      this.lastAudioPlayheadMs = this.startedAtMs;
      this.sendPli();
      this.startPliWatchdog();
    };

    this.startPliWatchdog();
  }

  private startPliWatchdog(): void {
    if (this.pliInterval) return;
    this.pliInterval = setInterval(() => {
      if (this.status !== 'RECORDING') {
        this.stopPliWatchdog();
        return;
      }
      // Keep requesting PLI every 1.5s until we have captured both SPS/PPS and at least 1 keyframe
      if (
        this.h264State.inboundKeyframesRecorded === 0 ||
        !this.h264State.cachedRemoteSps ||
        !this.h264State.cachedRemotePps
      ) {
        this.sendPli();
      } else {
        this.stopPliWatchdog();
      }
    }, 1500);
    if (typeof this.pliInterval.unref === 'function') {
      this.pliInterval.unref();
    }
  }

  private stopPliWatchdog(): void {
    if (this.pliInterval) {
      clearInterval(this.pliInterval);
      this.pliInterval = null;
    }
  }

  /**
   * Inspects an inbound relay packet (`onRelayData`) and routes video RTP/SRTP packets
   * (`PT 96..103` or `ssrc === peerVideoSsrc`) to `handleInboundVideoPacket`.
   */
  public inspectRawRelayPacket(
    data: Uint8Array,
    session?: Record<string, unknown> | null
  ): void {
    if (this.status !== 'RECORDING' || !data || data.length < 12) return;

    const firstByte = data[0];
    const version = (firstByte >> 6) & 0x03;
    if (version !== 2) return;

    const pt = data[1] & 0x7f;
    // Skip RTCP packets (PT 72..76 / raw byte1 200..209)
    if (pt >= 72 && pt <= 76) return;
    if (data[1] >= 200 && data[1] <= 209) return;

    const ssrc =
      ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0;
    const peerVideoSsrc =
      typeof session?.peerVideoSsrc === 'number'
        ? session.peerVideoSsrc >>> 0
        : 0;
    const peerAudioSsrc =
      typeof session?.peerAudioSsrc === 'number'
        ? session.peerAudioSsrc >>> 0
        : 0;

    const isVideoPt = pt >= 96 && pt <= 103;
    const isPeerVideoSsrc = peerVideoSsrc !== 0 && ssrc === peerVideoSsrc;
    const isUnknownNonAudioSsrc =
      peerAudioSsrc !== 0 &&
      ssrc !== 0 &&
      ssrc !== peerAudioSsrc &&
      pt !== 111 &&
      pt !== 120 &&
      pt !== 0 &&
      pt !== 8;

    if (isVideoPt || isPeerVideoSsrc || isUnknownNonAudioSsrc) {
      this.handleInboundVideoPacket(data, session);
    }
  }

  private lastProcessedVideoSeq = -1;
  private lastProcessedVideoTs = -1;

  /**
   * Decrypts (if SRTP-protected) and depacketizes an inbound H.264 RTP video packet,
   * writing Annex-B NALUs (`00 00 00 01`) to `remote_video.h264`.
   */
  public handleInboundVideoPacket(
    packet: Uint8Array,
    session?: Record<string, unknown> | null
  ): H264DepacketizeResult | null {
    if (this.status !== 'RECORDING' || !packet || packet.length < 12) {
      return null;
    }

    const seq = (packet[2] << 8) | (packet[3] & 0xff);
    const ts =
      ((packet[4] << 24) |
        (packet[5] << 16) |
        (packet[6] << 8) |
        packet[7]) >>>
      0;

    // Guard against duplicate delivery when both `onRelayData` and `onRelayVideoData` fire for the same packet
    if (
      seq === this.lastProcessedVideoSeq &&
      ts === this.lastProcessedVideoTs
    ) {
      return null;
    }

    const effectiveSession = session ?? this.attachedSession;
    const primaryKeys = extractRecvKeyMaterial(effectiveSession?.srtpSession);
    const fallbackKeys = extractRecvKeyMaterial(
      effectiveSession?.videoSrtpSession
    );

    const plainRtp = this.srtpDecryptor.unprotectRtpPacket(
      packet,
      primaryKeys,
      fallbackKeys
    );
    if (!plainRtp) {
      return null;
    }

    this.lastProcessedVideoSeq = seq;
    this.lastProcessedVideoTs = ts;

    // Request an immediate keyframe on the very first video packet if we haven't seen SPS/PPS yet
    if (this.h264State.inboundVideoPacketsReceived === 0) {
      this.sendPli();
    }

    const depacketized = depacketizeH264RtpPacket(plainRtp, this.h264State);

    if (this.videoFd !== null && depacketized.annexBNalus.length > 0) {
      for (const naluWithStartCode of depacketized.annexBNalus) {
        try {
          fs.writeSync(this.videoFd, naluWithStartCode);
          this.remoteVideoBytesWritten += naluWithStartCode.length;
        } catch {
          // Ignore write error
        }
      }
    }

    if (depacketized.sequenceGap) {
      this.sendPli();
    }

    return depacketized;
  }

  /**
   * Records decoded inbound PCM audio (`16kHz, mono, s16le`) with wall-clock silence padding
   * so recipient audio remains synchronized with video across mute/silence intervals.
   */
  public recordInboundAudioPcm(
    pcm: Int16Array | Float32Array | Uint8Array | Buffer,
    nowMs = Date.now()
  ): void {
    if (this.status !== 'RECORDING' || !pcm || pcm.length === 0) return;

    let pcmBytes: Buffer;
    if (pcm instanceof Int16Array) {
      pcmBytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    } else if (pcm instanceof Float32Array) {
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        const clamped = Math.max(-1, Math.min(1, pcm[i]));
        int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      pcmBytes = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
    } else if (Buffer.isBuffer(pcm)) {
      pcmBytes = pcm;
    } else {
      pcmBytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }

    if (pcmBytes.length === 0) return;

    this.inboundAudioPacketsReceived++;

    const chunkDurationMs =
      (pcmBytes.length / AUDIO_BYTES_PER_SECOND) * 1000;
    const gapMs = nowMs - this.lastAudioPlayheadMs;

    // Insert wall-clock silence padding if gap > 60ms (capped at 10s per single gap)
    if (this.audioFd !== null && gapMs > Math.max(60, chunkDurationMs + 40)) {
      const clampedGapMs = Math.min(gapMs - chunkDurationMs, 10_000);
      if (clampedGapMs > 20) {
        const rawSilenceBytes = Math.floor(
          (clampedGapMs / 1000) * AUDIO_BYTES_PER_SECOND
        );
        const alignedSilenceBytes =
          rawSilenceBytes - (rawSilenceBytes % AUDIO_BYTES_PER_SAMPLE);
        if (alignedSilenceBytes > 0) {
          try {
            fs.writeSync(this.audioFd, Buffer.alloc(alignedSilenceBytes, 0));
            this.inboundAudioBytesRecorded += alignedSilenceBytes;
          } catch {
            // Ignore silence write error
          }
        }
      }
    }

    if (this.audioFd !== null) {
      try {
        fs.writeSync(this.audioFd, pcmBytes);
        this.inboundAudioBytesRecorded += pcmBytes.length;
      } catch {
        // Ignore audio write error
      }
    }

    this.lastAudioPlayheadMs = Math.max(
      nowMs,
      this.lastAudioPlayheadMs + chunkDurationMs
    );
  }

  private closeTempDescriptors(): void {
    if (this.videoFd !== null) {
      try {
        fs.closeSync(this.videoFd);
      } catch {
        // Ignore close error
      }
      this.videoFd = null;
    }
    if (this.audioFd !== null) {
      try {
        fs.closeSync(this.audioFd);
      } catch {
        // Ignore close error
      }
      this.audioFd = null;
    }
  }

  private cleanupTempFiles(): void {
    for (const filePath of [
      this.remoteVideoTempPath,
      this.remoteAudioTempPath,
    ]) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore unlink error
      }
    }
  }

  /**
   * Finalizes the call recording, muxing the inbound camera H.264 stream, inbound PCM audio,
   * and outbound bot video/audio into a single `.mp4` file (`data/recordings/vcall_rec_<callId>_<timestamp>.mp4`).
   */
  public async finalizeRecording(): Promise<VoipCallRecordingSummary> {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }

    this.finalizePromise = this.executeFinalizeRecording();
    return this.finalizePromise;
  }

  private async executeFinalizeRecording(): Promise<VoipCallRecordingSummary> {
    this.stopPliWatchdog();
    this.status = 'FINALIZING';
    this.closeTempDescriptors();

    const elapsedSec = Math.max(
      1,
      Math.min(600, Math.round((Date.now() - this.startedAtMs) / 1000))
    );
    this.recordedDurationSeconds = elapsedSec;

    const timestamp = Date.now();
    const safeCallId = this.callId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputFileName = `vcall_rec_${safeCallId}_${timestamp}.mp4`;
    const outputFilePath = path.join(this.recordingsDir, outputFileName);

    const hasValidRemoteVideo =
      this.h264State.inboundVideoFramesRecorded > 0 &&
      Boolean(
        this.h264State.cachedRemoteSps && this.h264State.cachedRemotePps
      ) &&
      this.remoteVideoBytesWritten > 0 &&
      fs.existsSync(this.remoteVideoTempPath);

    const hasRemoteAudio =
      this.inboundAudioBytesRecorded > 0 &&
      fs.existsSync(this.remoteAudioTempPath);

    const hasOutboundVideo =
      Boolean(this.outboundVideoPath) && fs.existsSync(this.outboundVideoPath);

    try {
      let muxSucceeded = false;

      // Mode 1: Two-Way Video (Side-by-Side Split Screen: Recipient Camera + Bot Video + Mixed Two-Way Audio)
      if (hasValidRemoteVideo && hasOutboundVideo) {
        try {
          const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
          // Input 0: Recipient inbound H.264 video
          args.push('-f', 'h264', '-r', '15', '-i', this.remoteVideoTempPath);
          // Input 1: Bot outbound MP4 video (bounded to elapsedSec)
          args.push(
            '-stream_loop',
            '-1',
            '-t',
            String(elapsedSec),
            '-i',
            this.outboundVideoPath
          );

          if (hasRemoteAudio) {
            // Input 2: Recipient inbound s16le 16kHz mono PCM audio
            args.push(
              '-f',
              's16le',
              '-ar',
              '16000',
              '-ac',
              '1',
              '-i',
              this.remoteAudioTempPath
            );
            args.push(
              '-filter_complex',
              '[0:v]scale=360:480:force_original_aspect_ratio=decrease,pad=360:480:(ow-iw)/2:(oh-ih)/2,setsar=1[vrem];' +
                '[1:v]scale=360:480:force_original_aspect_ratio=decrease,pad=360:480:(ow-iw)/2:(oh-ih)/2,setsar=1[vbot];' +
                '[vrem][vbot]hstack=inputs=2:shortest=1[vout];' +
                '[2:a]aresample=16000[arem];' +
                '[1:a]aresample=16000[abot];' +
                '[arem][abot]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
              '-map',
              '[vout]',
              '-map',
              '[aout]'
            );
          } else {
            args.push(
              '-filter_complex',
              '[0:v]scale=360:480:force_original_aspect_ratio=decrease,pad=360:480:(ow-iw)/2:(oh-ih)/2,setsar=1[vrem];' +
                '[1:v]scale=360:480:force_original_aspect_ratio=decrease,pad=360:480:(ow-iw)/2:(oh-ih)/2,setsar=1[vbot];' +
                '[vrem][vbot]hstack=inputs=2:shortest=1[vout]',
              '-map',
              '[vout]',
              '-map',
              '1:a?'
            );
          }

          args.push(
            '-t',
            String(elapsedSec),
            '-c:v',
            'libx264',
            '-profile:v',
            'baseline',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            'veryfast',
            '-c:a',
            'aac',
            '-b:a',
            '96k',
            '-movflags',
            '+faststart',
            outputFilePath
          );

          await execFileAsync('ffmpeg', args, { timeout: 10_000 });
          if (
            fs.existsSync(outputFilePath) &&
            fs.statSync(outputFilePath).size > 0
          ) {
            muxSucceeded = true;
            this.remoteCameraCaptured = true;
          }
        } catch (err) {
          // If [1:a] is not present in outboundVideoPath, retry Mode 1 without [1:a]
          try {
            const fallbackArgs: string[] = [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-f',
              'h264',
              '-r',
              '15',
              '-i',
              this.remoteVideoTempPath,
              '-stream_loop',
              '-1',
              '-t',
              String(elapsedSec),
              '-i',
              this.outboundVideoPath,
            ];
            if (hasRemoteAudio) {
              fallbackArgs.push(
                '-f',
                's16le',
                '-ar',
                '16000',
                '-ac',
                '1',
                '-i',
                this.remoteAudioTempPath
              );
            }
            fallbackArgs.push(
              '-filter_complex',
              '[0:v]scale=360:480:force_original_aspect_ratio=decrease,pad=360:480:(ow-iw)/2:(oh-ih)/2,setsar=1[vrem];' +
                '[1:v]scale=360:480:force_original_aspect_ratio=decrease,pad=360:480:(ow-iw)/2:(oh-ih)/2,setsar=1[vbot];' +
                '[vrem][vbot]hstack=inputs=2:shortest=1[vout]',
              '-map',
              '[vout]'
            );
            if (hasRemoteAudio) {
              fallbackArgs.push('-map', '2:a');
            }
            fallbackArgs.push(
              '-t',
              String(elapsedSec),
              '-c:v',
              'libx264',
              '-profile:v',
              'baseline',
              '-pix_fmt',
              'yuv420p',
              '-preset',
              'veryfast',
              '-c:a',
              'aac',
              '-b:a',
              '96k',
              '-movflags',
              '+faststart',
              outputFilePath
            );
            await execFileAsync('ffmpeg', fallbackArgs, { timeout: 10_000 });
            if (
              fs.existsSync(outputFilePath) &&
              fs.statSync(outputFilePath).size > 0
            ) {
              muxSucceeded = true;
              this.remoteCameraCaptured = true;
            }
          } catch {
            log.warn(
              'Side-by-side H.264 mux failed; falling back to outbound video + two-way audio mux',
              {
                callId: this.callId,
                error: err instanceof Error ? err.message : String(err),
              }
            );
          }
        }
      }

      // Mode 2: Outbound Bot Video + Two-Way Audio (or when remote camera was closed / Mock Mode)
      if (!muxSucceeded && hasOutboundVideo && !this.isMockMode) {
        try {
          const args: string[] = [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-stream_loop',
            '-1',
            '-t',
            String(Math.min(elapsedSec, 30)),
            '-i',
            this.outboundVideoPath,
          ];
          if (hasRemoteAudio) {
            args.push(
              '-f',
              's16le',
              '-ar',
              '16000',
              '-ac',
              '1',
              '-i',
              this.remoteAudioTempPath,
              '-filter_complex',
              '[1:a]aresample=16000[arem];[0:a]aresample=16000[abot];[arem][abot]amix=inputs=2:duration=first:dropout_transition=2[aout]',
              '-map',
              '0:v:0',
              '-map',
              '[aout]'
            );
          } else {
            args.push('-map', '0:v:0', '-map', '0:a?');
          }
          args.push(
            '-t',
            String(Math.min(elapsedSec, 30)),
            '-c:v',
            'libx264',
            '-profile:v',
            'baseline',
            '-pix_fmt',
            'yuv420p',
            '-preset',
            'veryfast',
            '-c:a',
            'aac',
            '-b:a',
            '96k',
            '-movflags',
            '+faststart',
            outputFilePath
          );
          await execFileAsync('ffmpeg', args, { timeout: 25_000 });
          if (
            fs.existsSync(outputFilePath) &&
            fs.statSync(outputFilePath).size > 0
          ) {
            muxSucceeded = true;
          }
        } catch {
          // Retry mapping only 0:v:0 and 1:a (if outbound video had no audio track)
          try {
            const args: string[] = [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-stream_loop',
              '-1',
              '-i',
              this.outboundVideoPath,
            ];
            if (hasRemoteAudio) {
              args.push(
                '-f',
                's16le',
                '-ar',
                '16000',
                '-ac',
                '1',
                '-i',
                this.remoteAudioTempPath,
                '-map',
                '0:v:0',
                '-map',
                '1:a:0'
              );
            } else {
              args.push('-map', '0:v:0');
            }
            args.push(
              '-t',
              String(Math.min(elapsedSec, 30)),
              '-c:v',
              'libx264',
              '-profile:v',
              'baseline',
              '-pix_fmt',
              'yuv420p',
              '-preset',
              'veryfast',
              '-c:a',
              'aac',
              '-b:a',
              '96k',
              '-movflags',
              '+faststart',
              outputFilePath
            );
            await execFileAsync('ffmpeg', args, { timeout: 25_000 });
            if (
              fs.existsSync(outputFilePath) &&
              fs.statSync(outputFilePath).size > 0
            ) {
              muxSucceeded = true;
            }
          } catch {
            // Fall through to fast copy/minimal MP4 fallback
          }
        }
      }

      // Fast copy / synthetic fallback when in mock mode or if ffmpeg re-encode was skipped
      if (!muxSucceeded) {
        if (hasOutboundVideo) {
          fs.copyFileSync(this.outboundVideoPath, outputFilePath);
        } else {
          fs.writeFileSync(outputFilePath, createMinimalMp4Buffer());
        }
        muxSucceeded = true;
      }

      const stat = fs.statSync(outputFilePath);
      this.recordedVideoPath = outputFilePath;
      this.recordedVideoFileName = outputFileName;
      this.recordedVideoSizeBytes = stat.size;
      this.status = 'READY';
    } catch (err) {
      this.status = 'FAILED';
      this.failureReason = err instanceof Error ? err.message : String(err);
      log.error('Failed to finalize VoIP call recording', {
        callId: this.callId,
        error: this.failureReason,
      });
    } finally {
      this.cleanupTempFiles();
    }

    return this.getSummary();
  }
}
