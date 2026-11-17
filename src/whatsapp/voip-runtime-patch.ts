import { spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WaCallMediaSessionLike } from '@hiroosy/baileys-lite/voip';

const H264_FUA_TYPE = 28;
const MTU_PAYLOAD_MAX = 800;

export interface InstrumentedVideoEngine {
  __botezzVideoPatched?: boolean;
  logger?: {
    debug?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    trace?: (...args: unknown[]) => void;
    media?: (...args: unknown[]) => void;
  };
  videoSender?: {
    sendCapturedVideoAU?: (au: Uint8Array, durationMs?: number) => void;
    sendVideoAccessUnit?: (au: Uint8Array, durationMs?: number) => void;
  } | null;
  proc?: ChildProcess | null;
  width: number;
  height: number;
  frameRate: number;
  frameDurationMs: number;
  running: boolean;
  pending: Uint8Array;
  _pendingHeaderNalus?: Uint8Array[];
  _cachedSpsNalu?: Uint8Array | null;
  _cachedPpsNalu?: Uint8Array | null;
  _cachedIdrNalu?: Uint8Array | null;
  accessUnitsSent: number;
  videoPath: string | null;
  waitingForKeyFrame: boolean;
  waitForKeyFrame?: boolean;
  sourceKind: 'file' | 'blank' | null;
  videoLoop?: boolean;
  _deliberateStop?: boolean;
  _restartWindowStartedAt?: number;
  _restartCount?: number;
  lastGeneratedFfmpegArgs?: string[];
  onVideoCompleted?: () => void;
  onEncoderFatalError?: (err: Error) => void;
  onAccessUnit?: (au: Uint8Array) => void;
  __botezzSavedOnAccessUnit?: (au: Uint8Array) => void;
  start?: (...args: unknown[]) => unknown;
  spawnFfmpeg?: () => ChildProcess | null;
  onData?: (chunk: Uint8Array | Buffer) => void;
  handleChunk?: (chunk: Uint8Array | Buffer, flush?: boolean) => void;
  emitAccessUnit?: (au: Uint8Array) => void;
  stop?: (opts?: { keepSource?: boolean }) => void;
  [key: string]: unknown;
}

export interface InstrumentedMediaSession extends WaCallMediaSessionLike {
  __botezzInstrumented?: boolean;
  __botezzDisposed?: boolean;
  __botezzPassiveTapApplied?: boolean;
  __botezzRecorderAttached?: {
    setPeerSrtpKeys?: (keys: {
      sessionKey: Uint8Array;
      sessionSalt: Uint8Array;
      authKey: Uint8Array;
      authTagLen?: number;
    }) => void;
    handleInboundVideoRtpPacket?: (
      packet: Uint8Array,
      session?: unknown
    ) => void;
    handleInboundAudioRtpPacket?: (
      packet: Uint8Array,
      session?: unknown
    ) => void;
  } | null;
  __relayBroadcastAttempted?: boolean;
  __relayBroadcastAcceptedCount?: number;
  __mediaStartDelayTimers?: Set<ReturnType<typeof setTimeout>>;
  __peerCallKey?: Uint8Array;
  __localCallKey?: Uint8Array;
  __peerRecvCtx?: {
    sessionKey?: Uint8Array;
    sessionSalt?: Uint8Array;
    authKey?: Uint8Array;
    authTagLen?: number;
  };
  localCallKey?: Uint8Array;
  peerCallKey?: Uint8Array;
  selfLid?: string;
  selfSsrcJid?: string;
  selfSsrc?: number;
  videoSsrc?: number;
  ensureDeviceJid?: (jid: string) => string;
  _pendingNonVclNalus?: Uint8Array[];
  _cachedSpsNalu?: Uint8Array | null;
  _cachedPpsNalu?: Uint8Array | null;
  _cachedIdrNalu?: Uint8Array | null;
  injectCachedSpsPpsKeyframe?: () => boolean;
  videoTimestamp?: number;
  acceptedAudioPackets?: number;
  acceptedAudioOctets?: number;
  acceptedVideoPackets?: number;
  acceptedVideoOctets?: number;
  acceptedVideoKeyframes?: number;
  audioTransportSentCount?: number;
  videoTransportSentCount?: number;
  videoIdrTransportSentCount?: number;
  sentVideoRtpPackets?: Array<{
    sequenceNumber: number;
    timestamp: number;
    marker: boolean;
    naluType: number;
    payload: Uint8Array;
  }>;
  sctpRelay?: {
    hasConnection?: () => boolean;
    broadcast?: (packet: Buffer | Uint8Array | ArrayBuffer) => boolean;
    getVideoFlushCount?: () => number;
    setVideoSsrc?: (ssrc: number) => void;
    setStreamSsrcs?: (ssrcs: number[]) => void;
    __botezzBroadcastWrapped?: boolean;
    [key: string]: unknown;
  } | null;
  videoRtpStream?: {
    ssrc: number;
    sequenceNumber: number;
    timestamp: number;
    tsStride: number;
    transportSequence?: number;
    frameNumber?: number;
    firstPacket?: boolean;
    setTimestampStride?: (tsStride: number) => boolean;
    nextPacket?: (
      lastInAccessUnit: boolean,
      mediaFrameInfo: number
    ) => {
      version: number;
      padding: boolean;
      extension: boolean;
      marker: boolean;
      payloadType: number;
      sequenceNumber: number;
      timestamp: number;
      ssrc: number;
      csrc: number[];
      extensionProfile: number;
      extensionData: Uint8Array;
      size: () => number;
      encode: (buf: Uint8Array) => number;
    };
  } | null;
  videoSrtpSession?: {
    sendCtx?: {
      sessionKey?: Uint8Array;
      sessionSalt?: Uint8Array;
      authKey?: Uint8Array;
      authTagLen?: number;
      roc?: number;
      lastSeq?: number;
      initialized?: boolean;
    };
    recvCtx?: {
      sessionKey?: Uint8Array;
      sessionSalt?: Uint8Array;
      authKey?: Uint8Array;
      authTagLen?: number;
    };
    protect: (packet: unknown) => Uint8Array;
  } | null;
  videoEngine?: InstrumentedVideoEngine | null;
  videoDropCount?: number;
  videoFlushSeen?: number;
  videoKeyframeRequired?: boolean;
  info?: {
    callId?: string;
    callCreator?: string;
    callKey?: Uint8Array;
    encryptionKey?: Uint8Array;
    isEnded?: boolean;
    stateData?: {
      state?: string;
      endReason?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  cleanup?: () => void;
  startMediaFlow?: () => void;
  handleCallAck?: (node: unknown) => Promise<void>;
  sendCapturedAudio?: (opusFrame: Buffer | Uint8Array) => void;
  sendCapturedVideoAU?: (
    auOrNalus: Uint8Array | Buffer | Array<Buffer | Uint8Array>,
    durationOrIsKeyframe?: number | boolean
  ) => void;
  sendVideoAccessUnit?: (
    auOrNalus: Uint8Array | Buffer | Array<Buffer | Uint8Array>,
    durationOrIsKeyframe?: number | boolean
  ) => void;
}

export interface InstrumentedAudioEngine {
  __botezzAudioPatched?: boolean;
  __activeDecoderProc?: ChildProcess | null;
  ffmpegPath?: string;
  captureRunning?: boolean;
  playbackRunning?: boolean;
  decodeWithFFmpeg?: (inputPath: string, timeoutMs?: number) => Promise<Buffer>;
  stop?: () => void;
  [key: string]: unknown;
}

let patchPromise: Promise<void> | null = null;
let patchApplied = false;

export const activeCallMediaSessions = new Set<any>();

export function resolveBaileysLitePackageDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve('@hiroosy/baileys-lite/package.json');
    return path.dirname(pkgJsonPath);
  } catch {
    const candidates = [
      path.resolve(process.cwd(), 'node_modules/@hiroosy/baileys-lite'),
      path.resolve(process.cwd(), '../node_modules/@hiroosy/baileys-lite'),
      path.resolve(process.cwd(), '../../node_modules/@hiroosy/baileys-lite'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        return candidate;
      }
    }
    return null;
  }
}

/**
 * Computes the deterministic WhatsApp VoIP SSRC (`generateSecureSsrc`) for a given
 * `callId`, device JID (`selfJid`), and stream counter (`0` = audio, `2` = video).
 */
export function computeWhatsAppSecureSsrc(
  callId: string,
  selfJid: string,
  counter = 0
): number {
  const key = Buffer.from(callId, 'utf8');
  const salt = Buffer.alloc(4);
  salt.writeUInt32LE(counter >>> 0, 0);
  const info = Buffer.from(selfJid, 'utf8');
  const derived = Buffer.from(hkdfSync('sha256', key, salt, info, 4));
  return derived.readUInt32LE(0);
}

export const computeWhatsAppSsrc = computeWhatsAppSecureSsrc;

type InboundVideoHook = (callId: string, accessUnit: Uint8Array) => void;
type InboundAudioHook = (callId: string, pcmFloat32: Float32Array) => void;

const globalInboundVideoHooks = new Set<InboundVideoHook>();
const globalInboundAudioHooks = new Set<InboundAudioHook>();

export function registerGlobalInboundVideoHook(
  hook: InboundVideoHook
): () => void {
  globalInboundVideoHooks.add(hook);
  return () => {
    globalInboundVideoHooks.delete(hook);
  };
}

export function registerGlobalInboundAudioHook(
  hook: InboundAudioHook
): () => void {
  globalInboundAudioHooks.add(hook);
  return () => {
    globalInboundAudioHooks.delete(hook);
  };
}

export function emitGlobalInboundVideo(
  callId: string | undefined,
  accessUnit: Uint8Array
): void {
  if (!callId || !accessUnit || accessUnit.byteLength === 0) return;
  for (const hook of globalInboundVideoHooks) {
    try {
      hook(callId, accessUnit);
    } catch {
      // Non-fatal hook error
    }
  }
}

export function emitGlobalInboundAudio(
  callId: string | undefined,
  pcmFloat32: Float32Array
): void {
  if (!callId || !pcmFloat32 || pcmFloat32.length === 0) return;
  for (const hook of globalInboundAudioHooks) {
    try {
      hook(callId, pcmFloat32);
    } catch {
      // Non-fatal hook error
    }
  }
}

export function ensureDeviceJidFormat(jid: string): string {
  if (!jid) return '';
  if (/:\d+@/.test(jid)) return jid;
  return jid.replace('@', ':0@');
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function encodeProtobufVarintField(
  fieldNumber: number,
  value: number
): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 0);
  const val = encodeVarint(value);
  return concatUint8Arrays([tag, val]);
}

function encodeProtobufLengthDelimited(
  fieldNumber: number,
  data: Uint8Array
): Uint8Array {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(data.length);
  return concatUint8Arrays([tag, len, data]);
}

/**
 * Builds STUN `ATTR_SENDER_SUBSCRIPTIONS (0x4000)` Protobuf payload for multiple SSRCs
 * matching `@hiroosy/baileys-lite/voip/relay/stun.js` `buildSenderSubscriptions`.
 */
export function buildMultiSenderSubscriptions(ssrcs: number[]): Uint8Array {
  const unique = Array.from(
    new Set(ssrcs.map((s) => s >>> 0).filter((s) => s !== 0))
  );
  const entries: Uint8Array[] = [];
  for (const ssrc of unique) {
    const inner = concatUint8Arrays([
      encodeProtobufVarintField(3, ssrc),
      encodeProtobufVarintField(5, 0),
      encodeProtobufVarintField(6, 0),
    ]);
    entries.push(encodeProtobufLengthDelimited(1, inner));
  }
  return concatUint8Arrays(entries);
}

/**
 * Builds Protobuf stream descriptor entries for peer SSRCs inside STUN Allocate `0x4024`
 * matching `@hiroosy/baileys-lite/voip/relay/stun.js` `buildSSRCSubscriptionList`.
 */
export function buildPeerSsrcDescriptorEntries(
  peerSsrcs: number[],
  peerPid = 0
): Uint8Array {
  const unique = Array.from(
    new Set(peerSsrcs.map((s) => s >>> 0).filter((s) => s !== 0))
  );
  const entries: Uint8Array[] = [];
  for (let i = 0; i < unique.length; i++) {
    const inner = concatUint8Arrays([
      encodeProtobufVarintField(1, peerPid >>> 0),
      encodeProtobufVarintField(2, i + 1),
      encodeProtobufVarintField(3, unique[i]!),
    ]);
    entries.push(encodeProtobufLengthDelimited(1, inner));
  }
  return concatUint8Arrays(entries);
}

const ANNEX_B_START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);
const H264_STAPA_TYPE = 24;
const H264_STAPB_TYPE = 25;

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/**
 * Fault-Tolerant H.264 Access Unit Assembler (replaces `@hiroosy/baileys-lite`'s strict `H264AccessUnitAssembler`).
 *
 * Fixes:
 * 1. Never discards standalone SPS (`type 7`) or PPS (`type 8`) RTP packets when `marker = true`.
 *    Caches `cachedSps` and `cachedPps` across the entire call and prepends them to IDR frames (`type 5`)
 *    and to the first emitted frame.
 * 2. Supports Single NALU (`1..23`), STAP-A (`24`), STAP-B (`25`), and FU-A (`28`).
 * 3. Recovers gracefully from single UDP packet loss (`seqGap`): discards only the incomplete FU-A fragment
 *    instead of permanently freezing (`keyframeNeeded = true`) and dropping all subsequent P-frames.
 * 4. Flushes completed frames on `marker === true` OR when the RTP timestamp changes on a new frame.
 */
export class SmartH264Assembler {
  private currentNalus: Uint8Array[] = [];
  private fragmentChunks: Uint8Array[] = [];
  private fragmentHeader = 0;
  private fragmentActive = false;
  private lastSeq: number | null = null;
  private lastTimestamp: number | null = null;
  public cachedSps: Uint8Array | null = null;
  public cachedPps: Uint8Array | null = null;
  public hasEmittedValidFrame = false;
  public totalFramesEmitted = 0;
  public seqGapsDetected = 0;

  private resetFragments(): void {
    this.fragmentChunks = [];
    this.fragmentHeader = 0;
    this.fragmentActive = false;
  }

  private ingestSingleNalu(nalu: Uint8Array): void {
    if (!nalu || nalu.byteLength === 0) return;
    let clean = nalu;
    if (
      clean.byteLength > 4 &&
      clean[0] === 0 &&
      clean[1] === 0 &&
      clean[2] === 0 &&
      clean[3] === 1
    ) {
      clean = clean.subarray(4);
    } else if (
      clean.byteLength > 3 &&
      clean[0] === 0 &&
      clean[1] === 0 &&
      clean[2] === 1
    ) {
      clean = clean.subarray(3);
    }
    if (clean.byteLength === 0) return;
    const naluType = clean[0]! & 0x1f;
    if (naluType === 0 || naluType > 23) return;
    if (naluType === 7) {
      this.cachedSps = new Uint8Array(clean);
    } else if (naluType === 8) {
      this.cachedPps = new Uint8Array(clean);
    }
    this.currentNalus.push(new Uint8Array(clean));
  }

  private flushCurrentAccessUnit(): Uint8Array | null {
    if (this.currentNalus.length === 0) return null;

    let hasVcl = false;
    let hasIdr = false;
    let hasSps = false;
    let hasPps = false;

    for (const nalu of this.currentNalus) {
      const t = nalu[0]! & 0x1f;
      if (t >= 1 && t <= 5) hasVcl = true;
      if (t === 5) hasIdr = true;
      if (t === 7) hasSps = true;
      if (t === 8) hasPps = true;
    }

    // If this packet only contained standalone SPS/PPS (with marker=true), keep them cached
    // and wait for the upcoming IDR/VCL slice so we don't discard them!
    if (!hasVcl) {
      this.currentNalus = [];
      return null;
    }

    // Require either an IDR or cached SPS+PPS before emitting the very first frame
    if (
      !this.hasEmittedValidFrame &&
      !hasIdr &&
      !(this.cachedSps && this.cachedPps)
    ) {
      this.currentNalus = [];
      return null;
    }

    const annexBParts: Uint8Array[] = [];
    if ((hasIdr || !this.hasEmittedValidFrame) && !hasSps && this.cachedSps) {
      annexBParts.push(ANNEX_B_START_CODE, this.cachedSps);
    }
    if ((hasIdr || !this.hasEmittedValidFrame) && !hasPps && this.cachedPps) {
      annexBParts.push(ANNEX_B_START_CODE, this.cachedPps);
    }
    for (const nalu of this.currentNalus) {
      annexBParts.push(ANNEX_B_START_CODE, nalu);
    }

    this.currentNalus = [];
    this.hasEmittedValidFrame = true;
    this.totalFramesEmitted++;
    return concatUint8Arrays(annexBParts);
  }

  public push(
    seq: number,
    marker: boolean,
    payload: Uint8Array,
    timestamp?: number
  ): { accessUnit: Uint8Array | null; complete: boolean; seqGap: boolean } {
    if (!payload || payload.byteLength === 0) {
      return { accessUnit: null, complete: false, seqGap: false };
    }

    let flushedFromPrevTimestamp: Uint8Array | null = null;
    if (
      timestamp !== undefined &&
      this.lastTimestamp !== null &&
      timestamp !== this.lastTimestamp &&
      this.currentNalus.length > 0
    ) {
      this.resetFragments();
      flushedFromPrevTimestamp = this.flushCurrentAccessUnit();
    }
    if (timestamp !== undefined) {
      this.lastTimestamp = timestamp;
    }

    let seqGap = false;
    if (this.lastSeq !== null) {
      const expected = (this.lastSeq + 1) & 0xffff;
      if (seq !== expected) {
        const diff = (seq - expected + 65536) % 65536;
        if (diff > 0 && diff < 0x8000) {
          seqGap = true;
          this.seqGapsDetected++;
          // Only drop any broken in-flight FU-A fragment; do NOT wipe cached SPS/PPS or lock out future frames!
          this.resetFragments();
        }
      }
    }
    this.lastSeq = seq;

    const firstByte = payload[0]!;
    const nalType = firstByte & 0x1f;

    if (nalType >= 1 && nalType <= 23) {
      this.resetFragments();
      this.ingestSingleNalu(payload);
    } else if (nalType === H264_STAPA_TYPE) {
      this.resetFragments();
      let offset = 1;
      while (offset + 2 <= payload.byteLength) {
        const size = (payload[offset]! << 8) | payload[offset + 1]!;
        offset += 2;
        if (size <= 0 || offset + size > payload.byteLength) break;
        this.ingestSingleNalu(payload.subarray(offset, offset + size));
        offset += size;
      }
    } else if (nalType === H264_STAPB_TYPE) {
      this.resetFragments();
      let offset = 3; // Skip STAP-B header + 16-bit DON
      while (offset + 2 <= payload.byteLength) {
        const size = (payload[offset]! << 8) | payload[offset + 1]!;
        offset += 2;
        if (size <= 0 || offset + size > payload.byteLength) break;
        this.ingestSingleNalu(payload.subarray(offset, offset + size));
        offset += size;
      }
    } else if (nalType === H264_FUA_TYPE && payload.byteLength >= 2) {
      const fuIndicator = firstByte;
      const fuHeader = payload[1]!;
      const startBit = (fuHeader & 0x80) !== 0;
      const endBit = (fuHeader & 0x40) !== 0;
      const origNalType = fuHeader & 0x1f;
      const fragBody = payload.subarray(2);

      if (startBit) {
        this.fragmentHeader = (fuIndicator & 0xe0) | origNalType;
        this.fragmentChunks = [fragBody];
        this.fragmentActive = true;
        if (endBit) {
          const fullNalu = new Uint8Array(1 + fragBody.byteLength);
          fullNalu[0] = this.fragmentHeader;
          fullNalu.set(fragBody, 1);
          this.resetFragments();
          this.ingestSingleNalu(fullNalu);
        }
      } else if (this.fragmentActive) {
        this.fragmentChunks.push(fragBody);
        if (endBit) {
          const body = concatUint8Arrays(this.fragmentChunks);
          const fullNalu = new Uint8Array(1 + body.byteLength);
          fullNalu[0] = this.fragmentHeader;
          fullNalu.set(body, 1);
          this.resetFragments();
          this.ingestSingleNalu(fullNalu);
        }
      }
    }

    if (marker) {
      const au = this.flushCurrentAccessUnit() ?? flushedFromPrevTimestamp;
      if (au) {
        return { accessUnit: au, complete: true, seqGap };
      }
    }

    if (flushedFromPrevTimestamp) {
      return {
        accessUnit: flushedFromPrevTimestamp,
        complete: true,
        seqGap,
      };
    }

    return { accessUnit: null, complete: false, seqGap };
  }
}

function annexBStartCodeLen(data: Uint8Array, offset: number): number {
  if (
    offset + 3 < data.length &&
    data[offset] === 0 &&
    data[offset + 1] === 0 &&
    data[offset + 2] === 0 &&
    data[offset + 3] === 1
  ) {
    return 4;
  }
  if (
    offset + 2 < data.length &&
    data[offset] === 0 &&
    data[offset + 1] === 0 &&
    data[offset + 2] === 1
  ) {
    return 3;
  }
  return 0;
}

/**
 * Splits an Annex-B byte buffer into individual H.264 NAL units (without start codes).
 */
export function splitAnnexBNalus(data: Uint8Array): Uint8Array[] {
  const nalus: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i < data.length) {
    const sc = annexBStartCodeLen(data, i);
    if (sc > 0) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        if (end > start) {
          nalus.push(data.subarray(start, end));
        }
      }
      i += sc;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < data.length) {
    let end = data.length;
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) {
      nalus.push(data.subarray(start, end));
    }
  }
  return nalus;
}

/**
 * Packages a single H.264 NALU (without Annex-B start codes) into RFC 6184 Single NALU (`<= 800B`)
 * or FU-A fragments (`> 800B`).
 */
export function packageH264SingleOrFuA(nalu: Uint8Array): Uint8Array[] {
  if (!nalu || nalu.length === 0) return [];
  if (nalu.length <= MTU_PAYLOAD_MAX) {
    return [nalu.slice()];
  }
  const naluHeader = nalu[0];
  const fbitAndNri = naluHeader & 0xe0;
  const originalType = naluHeader & 0x1f;
  const fuIndicator = fbitAndNri | H264_FUA_TYPE;

  const body = nalu.subarray(1);
  const fragSize = MTU_PAYLOAD_MAX - 2;

  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    const end = Math.min(offset + fragSize, body.length);
    const chunk = body.subarray(offset, end);

    let fuHeader = originalType;
    if (offset === 0) fuHeader |= 0x80; // Start bit
    if (end === body.length) fuHeader |= 0x40; // End bit

    const pkt = new Uint8Array(2 + chunk.length);
    pkt[0] = fuIndicator;
    pkt[1] = fuHeader;
    pkt.set(chunk, 2);
    out.push(pkt);

    offset = end;
  }
  return out;
}

/**
 * Builds a raw 12-byte RTP header + H.264 payload packet.
 */
export function buildRtpPacket(
  payload: Uint8Array | Buffer,
  timestamp: number,
  sequenceNumber: number,
  ssrc: number,
  marker: boolean,
  payloadType = 96
): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2, P=0, X=0, CC=0
  header[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return Buffer.concat([header, payloadBuf]);
}

/**
 * RFC 6184 compliant H.264 NALU -> RTP packet builder.
 * Enforces `Marker Bit = false (0)` on all non-VCL parameter/supplemental NALUs (`SPS=7`, `PPS=8`, `SEI=6`, `AUD=9`)
 * and `Marker Bit = true (1)` strictly on the final packet/fragment of a VCL frame slice (`IDR=5` or `Non-IDR=1`).
 */
export function buildH264RtpPackets(
  naluBuffer: Uint8Array | Buffer,
  timestamp: number,
  sequenceNumberGenerator: () => number,
  ssrc: number,
  isLastNaluInAccessUnit = true
): Buffer[] {
  if (!naluBuffer || naluBuffer.length === 0) return [];
  const view = new Uint8Array(
    naluBuffer.buffer,
    naluBuffer.byteOffset,
    naluBuffer.byteLength
  );
  const split = splitAnnexBNalus(view);
  const payload = split.length === 1 ? split[0] : view;
  if (!payload || payload.length === 0) return [];

  const nalHeader = payload[0];
  const nalType = nalHeader & 0x1f;
  const isVclFrameSlice = nalType === 1 || nalType === 5;
  const chunks = packageH264SingleOrFuA(payload);

  return chunks.map((chunk, idx) => {
    const isLastFragment = idx === chunks.length - 1;
    const isFinalPacketOfFrame =
      isVclFrameSlice && isLastNaluInAccessUnit && isLastFragment;
    return buildRtpPacket(
      chunk,
      timestamp,
      sequenceNumberGenerator(),
      ssrc,
      isFinalPacketOfFrame
    );
  });
}

export function auHasIdrNalu(au: Uint8Array): boolean {
  const nalus = splitAnnexBNalus(au);
  if (nalus.length === 0 && au.length > 0) {
    return (au[0] & 0x1f) === 5;
  }
  return nalus.some((n) => n.length > 0 && (n[0] & 0x1f) === 5);
}

function buildAnnexBFromNalus(nalus: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nalus) {
    total += 4 + n.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const n of nalus) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 1;
    out.set(n, offset + 4);
    offset += 4 + n.length;
  }
  return out;
}

/**
 * Groups Annex-B NALUs so that non-VCL header/delimiter NALUs (`AUD=9`, `SEI=6`, `SPS=7`, `PPS=8`)
 * are combined with the VCL image slice (`IDR=5` or `Non-IDR=1`) that follows them into a single
 * complete Access Unit per frame (`P0-A`).
 */
export function groupAnnexBToFrameAccessUnits(
  nalus: Uint8Array[],
  pendingHeaders: Uint8Array[] = []
): {
  accessUnits: Uint8Array[];
  remainingHeaders: Uint8Array[];
} {
  const accessUnits: Uint8Array[] = [];
  const currentHeaders: Uint8Array[] = [...pendingHeaders];

  for (const nalu of nalus) {
    if (!nalu || nalu.length === 0) continue;
    const naluType = nalu[0] & 0x1f;
    const isVcl = naluType >= 1 && naluType <= 5;
    if (!isVcl) {
      currentHeaders.push(nalu);
      continue;
    }
    const frameNalus = [...currentHeaders.splice(0), nalu];
    accessUnits.push(buildAnnexBFromNalus(frameNalus));
  }

  return {
    accessUnits,
    remainingHeaders: currentHeaders,
  };
}

const align16 = (n: number): number => Math.max(16, Math.ceil(n / 16) * 16);

function pickH264Level(width: number, height: number, frameRate: number): string {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * frameRate;
  if (mbs <= 1620 && mbps <= 40500) return '3.0';
  if (mbs <= 3600 && mbps <= 108000) return '3.1';
  if (mbs <= 5120 && mbps <= 216000) return '3.2';
  return '4.0';
}

export function wrapSctpRelayOnSession(session: InstrumentedMediaSession): void {
  const relay = session?.sctpRelay as
    | (NonNullable<InstrumentedMediaSession['sctpRelay']> & {
        __botezzWrappedFn?: (packet: Buffer | Uint8Array | ArrayBuffer) => boolean;
      })
    | undefined;
  if (!relay || typeof relay !== 'object') {
    return;
  }
  if (
    typeof relay.broadcast === 'function' &&
    relay.broadcast !== relay.__botezzWrappedFn
  ) {
    const originalBroadcast = relay.broadcast.bind(relay);
    const wrappedFn = (packet: Buffer | Uint8Array | ArrayBuffer): boolean => {
      session.__relayBroadcastAttempted = true;
      const hasConn =
        typeof relay.hasConnection === 'function' ? relay.hasConnection() : true;
      if (!hasConn) {
        return false;
      }
      const accepted = Boolean(originalBroadcast(packet));
      if (accepted) {
        session.__relayBroadcastAcceptedCount =
          (session.__relayBroadcastAcceptedCount ?? 0) + 1;
      }
      return accepted;
    };
    relay.broadcast = wrappedFn;
    relay.__botezzWrappedFn = wrappedFn;
    relay.__botezzBroadcastWrapped = true;
  }
}

export function instrumentAudioEngineInstance(
  audioEngine: InstrumentedAudioEngine | null | undefined,
  defaultTimeoutMs = 30_000
): void {
  if (
    !audioEngine ||
    typeof audioEngine !== 'object' ||
    Object.prototype.hasOwnProperty.call(audioEngine, '__botezzAudioPatched')
  ) {
    return;
  }
  audioEngine.__botezzAudioPatched = true;

  const killActiveDecoder = (engine: InstrumentedAudioEngine) => {
    const proc = engine.__activeDecoderProc;
    if (!proc) return;
    engine.__activeDecoderProc = null;
    try {
      proc.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        } catch {
          // Ignore kill error
        }
      }, 250);
      if (typeof forceTimer.unref === 'function') {
        forceTimer.unref();
      }
    } catch {
      // Ignore kill error
    }
  };

  if (typeof audioEngine.decodeWithFFmpeg === 'function') {
    audioEngine.decodeWithFFmpeg = function patchedDecodeWithFFmpeg(
      this: InstrumentedAudioEngine,
      inputPath: string,
      timeoutMs = defaultTimeoutMs
    ): Promise<Buffer> {
      killActiveDecoder(this);
      const ffmpegBin =
        typeof this.ffmpegPath === 'string' && this.ffmpegPath
          ? this.ffmpegPath
          : 'ffmpeg';

      return new Promise<Buffer>((resolve, reject) => {
        let settled = false;
        const proc = spawn(
          ffmpegBin,
          [
            '-i',
            inputPath,
            '-f',
            's16le',
            '-ar',
            '16000',
            '-ac',
            '1',
            '-acodec',
            'pcm_s16le',
            '-v',
            'quiet',
            'pipe:1',
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        this.__activeDecoderProc = proc;

        const chunks: Buffer[] = [];
        let stderr = '';

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          killActiveDecoder(this);
          reject(
            new Error(
              `FFmpeg audio decode timed out after ${timeoutMs}ms for ${path.basename(inputPath)}`
            )
          );
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }

        proc.stdout?.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('close', (code: number | null) => {
          clearTimeout(timer);
          if (this.__activeDecoderProc === proc) {
            this.__activeDecoderProc = null;
          }
          if (settled) return;
          settled = true;
          if (code === 0) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(
              new Error(`FFmpeg exited with code ${code}: ${stderr.slice(0, 200)}`)
            );
          }
        });

        proc.on('error', (err: Error) => {
          clearTimeout(timer);
          if (this.__activeDecoderProc === proc) {
            this.__activeDecoderProc = null;
          }
          if (settled) return;
          settled = true;
          reject(new Error(`FFmpeg spawn failed (${ffmpegBin}): ${err.message}`));
        });
      });
    };
  }

  if (typeof audioEngine.stop === 'function') {
    const origStop = audioEngine.stop;
    audioEngine.stop = function patchedAudioStop(this: InstrumentedAudioEngine) {
      killActiveDecoder(this);
      return origStop.apply(this);
    };
  }
}

/**
 * Instruments `WaVideoEngine` (`P0-A`, `BZ-012`, `BZ-020`):
 * 1. Configures WhatsApp real-time H.264 encoder parameters (`fps=15`, `gop=15`, `sc_threshold=0`, `280k`/`420k`, `zerolatency`, `sliced-threads=0`, `aud=1`, `repeat-headers=1`).
 * 2. Groups non-VCL NALUs (`AUD=9`, `SEI=6`, `SPS=7`, `PPS=8`) with their VCL slice (`IDR=5` or `Slice=1`) into a single Access Unit per frame.
 * 3. Preserves `onAccessUnit` across no-arg restarts and prevents the mid-stream `waitForKeyFrame` trap.
 * 4. Respects `videoLoop` (`loopVideo`) so non-looping calls finish cleanly after one pass.
 */
export function instrumentVideoEngineInstance(
  videoEngine: InstrumentedVideoEngine | null | undefined
): void {
  if (!videoEngine || typeof videoEngine !== 'object') {
    return;
  }
  // Always enforce 15fps real-time cadence on the instance even if prototype was already patched
  videoEngine.frameRate = 15;
  videoEngine.frameDurationMs = 1000 / 15;

  if (Object.prototype.hasOwnProperty.call(videoEngine, '__botezzVideoPatched')) {
    return;
  }
  videoEngine.__botezzVideoPatched = true;

  const origEmitAccessUnit =
    typeof videoEngine.emitAccessUnit === 'function'
      ? videoEngine.emitAccessUnit
      : undefined;

  videoEngine.emitAccessUnit = function patchedEmitAccessUnit(
    this: InstrumentedVideoEngine,
    au: Uint8Array
  ) {
    // Cache SPS (7), PPS (8), and IDR (5) whenever emitted by ffmpeg
    const emittedNalus = splitAnnexBNalus(au);
    for (const n of emittedNalus.length > 0 ? emittedNalus : [au]) {
      if (!n || n.length === 0) continue;
      const nt = n[0] & 0x1f;
      if (nt === 7) {
        this._cachedSpsNalu = n.slice();
      } else if (nt === 8) {
        this._cachedPpsNalu = n.slice();
      } else if (nt === 5) {
        this._cachedIdrNalu = n.slice();
      }
    }

    if (this.waitingForKeyFrame || this.waitForKeyFrame) {
      if (!auHasIdrNalu(au)) {
        return;
      }
      this.waitingForKeyFrame = false;
      this.waitForKeyFrame = false;
    }
    this.accessUnitsSent = (this.accessUnitsSent ?? 0) + 1;
    const frameDurMs = this.frameDurationMs || 1000 / (this.frameRate || 15);
    const activeCallback =
      typeof this.onAccessUnit === 'function'
        ? this.onAccessUnit
        : typeof this.__botezzSavedOnAccessUnit === 'function'
          ? this.__botezzSavedOnAccessUnit
          : undefined;

    if (this.videoSender) {
      try {
        if (typeof this.videoSender.sendVideoAccessUnit === 'function') {
          this.videoSender.sendVideoAccessUnit(au, frameDurMs);
        } else if (typeof this.videoSender.sendCapturedVideoAU === 'function') {
          this.videoSender.sendCapturedVideoAU(au, frameDurMs);
        }
      } catch (err) {
        this.logger?.trace?.('captured video send failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (activeCallback) {
      activeCallback.call(this, au);
    } else if (origEmitAccessUnit && origEmitAccessUnit !== patchedEmitAccessUnit) {
      origEmitAccessUnit.call(this, au);
    }
  };

  /**
   * Processes an Annex-B chunk, grouping non-VCL NALUs (`AUD=9`, `SEI=6`, `SPS=7`, `PPS=8`)
   * with the VCL slice (`IDR=5`, `Slice=1`) that follows them so each frame is emitted as a
   * single Access Unit (`P0-A`).
   */
  videoEngine.handleChunk = function patchedHandleChunk(
    this: InstrumentedVideoEngine,
    chunk: Uint8Array | Buffer
  ) {
    const view = new Uint8Array(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength
    );
    if (view.length === 0) return;

    const nalus = splitAnnexBNalus(view);
    const effectiveNalus = nalus.length > 0 ? nalus : [view];
    const pendingHeaders = this._pendingHeaderNalus ?? [];
    const { accessUnits, remainingHeaders } = groupAnnexBToFrameAccessUnits(
      effectiveNalus,
      pendingHeaders
    );
    this._pendingHeaderNalus = remainingHeaders;

    for (const au of accessUnits) {
      this.emitAccessUnit?.(au);
    }
  };

  videoEngine.onData = function patchedOnData(
    this: InstrumentedVideoEngine,
    chunk: Uint8Array | Buffer
  ) {
    const view = new Uint8Array(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength
    );
    const prevPending = this.pending ?? new Uint8Array(0);
    const merged = new Uint8Array(prevPending.length + view.length);
    merged.set(prevPending, 0);
    merged.set(view, prevPending.length);
    this.pending = merged;

    if (this.pending.length > 8 * 1024 * 1024) {
      this.pending = new Uint8Array(0);
      this._pendingHeaderNalus = [];
      return;
    }

    // Locate all Annex-B start codes and identify frame boundaries.
    // Whenever we have accumulated a VCL slice (type 1..5) and see the start code of
    // the next frame's AUD(9) / SPS(7) / PPS(8) / SEI(6) / next VCL slice, emit the completed frame AU.
    const data = this.pending;
    const naluSpans: Array<{ scOffset: number; naluOffset: number; naluType: number }> = [];
    let i = 0;
    while (i < data.length) {
      const sc = annexBStartCodeLen(data, i);
      if (sc > 0) {
        const naluStart = i + sc;
        if (naluStart < data.length) {
          naluSpans.push({
            scOffset: i,
            naluOffset: naluStart,
            naluType: data[naluStart] & 0x1f,
          });
        }
        i += sc;
        continue;
      }
      i++;
    }

    if (naluSpans.length < 2) {
      return;
    }

    let auStartOffset = naluSpans[0].scOffset;
    let auHasVcl = false;

    // Only inspect up to naluSpans.length - 1 because the very last NALU in `this.pending`
    // may still have bytes arriving in the next stdout pipe chunk.
    for (let idx = 0; idx < naluSpans.length; idx++) {
      const span = naluSpans[idx];
      const isVcl = span.naluType >= 1 && span.naluType <= 5;

      if (idx > 0 && auHasVcl) {
        const isNewAuBoundary =
          span.naluType === 9 ||
          span.naluType === 7 ||
          span.naluType === 8 ||
          span.naluType === 6 ||
          isVcl;
        if (isNewAuBoundary) {
          const completedAu = data.subarray(auStartOffset, span.scOffset);
          this.emitAccessUnit?.(completedAu);
          auStartOffset = span.scOffset;
          auHasVcl = false;
        }
      }

      if (idx < naluSpans.length - 1 && isVcl) {
        auHasVcl = true;
      }
    }

    if (auStartOffset > 0) {
      this.pending = data.slice(auStartOffset);
    }
  };

  videoEngine.spawnFfmpeg = function patchedSpawnFfmpeg(
    this: InstrumentedVideoEngine
  ): ChildProcess | null {
    if (!this.sourceKind || this.proc) {
      return this.proc ?? null;
    }
    this.frameRate = 15;
    this.frameDurationMs = 1000 / 15;

    const outW = align16(this.width || 640);
    const outH = align16(this.height || 360);
    const fps = 15;
    const gop = 15;
    const maxDim = Math.max(outW, outH);
    const bitrateKbps = maxDim <= 640 ? 280 : 420;
    const bufsizeKbps = bitrateKbps * 2;
    const level = pickH264Level(outW, outH, fps);

    const scaleFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const shouldLoop = this.videoLoop !== false;

    const inputArgs =
      this.sourceKind === 'blank'
        ? ['-f', 'lavfi', '-re', '-i', `color=c=black:s=${outW}x${outH}:r=${fps}`]
        : shouldLoop
          ? ['-stream_loop', '-1', '-re', '-i', String(this.videoPath)]
          : ['-re', '-i', String(this.videoPath)];

    const x264Params = [
      'repeat-headers=1',
      `keyint=${gop}`,
      `min-keyint=${gop}`,
      'scenecut=0',
      'bframes=0',
      'cabac=0',
      'aud=1',
      'annexb=1',
      'sliced-threads=0',
      'rc-lookahead=0',
      'sync-lookahead=0',
      'open-gop=0',
      'ref=1',
    ].join(':');

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-an',
      '-vf',
      scaleFilter,
      '-r',
      String(fps),
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-profile:v',
      'baseline',
      '-level',
      level,
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-bf',
      '0',
      '-b_strategy',
      '0',
      '-g',
      String(gop),
      '-keyint_min',
      String(gop),
      '-sc_threshold',
      '0',
      '-flags',
      '+low_delay',
      '-max_delay',
      '0',
      '-b:v',
      `${bitrateKbps}k`,
      '-maxrate',
      `${bitrateKbps}k`,
      '-bufsize',
      `${bufsizeKbps}k`,
      '-x264-params',
      x264Params,
      '-bsf:v',
      'dump_extra',
      '-f',
      'h264',
      'pipe:1',
    ];

    this.lastGeneratedFfmpegArgs = args;

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.pending = new Uint8Array(0);
    this._pendingHeaderNalus = [];
    this.accessUnitsSent = 0;
    this.waitingForKeyFrame = true;
    this.waitForKeyFrame = true;
    this.running = true;
    this._deliberateStop = false;

    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.onData?.(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
      } catch (err) {
        this.logger?.error?.('video stream parse error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    proc.stdout?.on('end', () => {
      // Flush any trailing complete VCL Access Unit remaining in `this.pending`
      if (this.pending && this.pending.length > 0) {
        const trailingNalus = splitAnnexBNalus(this.pending);
        const { accessUnits } = groupAnnexBToFrameAccessUnits(trailingNalus);
        for (const au of accessUnits) {
          this.emitAccessUnit?.(au);
        }
        this.pending = new Uint8Array(0);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16 * 1024);
    });

    proc.on('error', (err: Error) => {
      this.logger?.error?.('ffmpeg video process error', {
        message: err.message,
      });
      this.running = false;
      this.onEncoderFatalError?.(err);
    });

    proc.on('close', (code: number | null) => {
      if (this.proc === proc) {
        this.proc = null;
      }
      this.running = false;

      if (this._deliberateStop) {
        return;
      }

      if (code === 0 && !shouldLoop) {
        this.onVideoCompleted?.();
        return;
      }

      if (code !== 0 && code !== null) {
        this.logger?.error?.('ffmpeg video process exited unexpectedly', {
          code,
          stderr: stderr.trim(),
        });
      }

      if (this.sourceKind && shouldLoop) {
        const now = Date.now();
        if (
          !this._restartWindowStartedAt ||
          now - this._restartWindowStartedAt > 60_000
        ) {
          this._restartWindowStartedAt = now;
          this._restartCount = 0;
        }
        this._restartCount = (this._restartCount ?? 0) + 1;
        if (this._restartCount > 3) {
          this.onEncoderFatalError?.(
            new Error(
              `Video encoder crash-looped (${this._restartCount} restarts): ${stderr.slice(0, 200)}`
            )
          );
          return;
        }
        this.start?.(this.__botezzSavedOnAccessUnit ?? this.onAccessUnit);
      }
    });

    return proc;
  };

  const origStart =
    typeof videoEngine.start === 'function' ? videoEngine.start : undefined;
  videoEngine.start = function patchedVideoStart(
    this: InstrumentedVideoEngine,
    onAccessUnit?: unknown,
    ...restArgs: unknown[]
  ) {
    if (typeof onAccessUnit === 'function') {
      this.__botezzSavedOnAccessUnit = onAccessUnit as (au: Uint8Array) => void;
    } else if (
      typeof this.onAccessUnit === 'function' &&
      !this.__botezzSavedOnAccessUnit
    ) {
      this.__botezzSavedOnAccessUnit = this.onAccessUnit;
    }

    const effectiveCallback =
      (typeof onAccessUnit === 'function'
        ? (onAccessUnit as (au: Uint8Array) => void)
        : undefined) ||
      this.__botezzSavedOnAccessUnit ||
      this.onAccessUnit;

    if (this.running && this.proc && !this.proc.killed) {
      if (typeof onAccessUnit === 'function') {
        // Callback was updated, ensure the running pipe feeds the new callback
        this.onAccessUnit = effectiveCallback;
      }
      return this.proc;
    }

    if (typeof effectiveCallback === 'function') {
      this.onAccessUnit = effectiveCallback;
    }

    this._deliberateStop = false;
    this.waitForKeyFrame = true;
    this.waitingForKeyFrame = true;

    // When `sourceKind` is configured ('file' or 'blank'), always spawn our patched FFmpeg pipeline directly.
    // Note: Do NOT set `this.running = true` before calling `origStart` or `spawnFfmpeg`, because
    // `WaVideoEngine.prototype.start` starts with `if (this.running) return;`!
    if (this.sourceKind && typeof this.spawnFfmpeg === 'function') {
      return this.spawnFfmpeg();
    }

    if (
      typeof origStart === 'function' &&
      origStart !== patchedVideoStart &&
      this.videoLoop !== false
    ) {
      this.running = false;
      const res = origStart.call(this, effectiveCallback, ...restArgs);
      this.running = true;
      if (typeof effectiveCallback === 'function') {
        this.onAccessUnit = effectiveCallback;
      }
      return res;
    }
    this.running = true;
    return this.spawnFfmpeg?.();
  };

  const origStop = videoEngine.stop;
  videoEngine.stop = function patchedVideoStop(
    this: InstrumentedVideoEngine,
    opts?: { keepSource?: boolean }
  ) {
    this._deliberateStop = true;
    this.running = false;
    this._pendingHeaderNalus = [];
    const activeProc = this.proc;
    if (activeProc) {
      try {
        activeProc.stdout?.removeAllListeners('data');
        activeProc.stderr?.removeAllListeners('data');
        activeProc.kill('SIGTERM');
        const forceKillTimer = setTimeout(() => {
          try {
            if (!activeProc.killed && activeProc.exitCode === null) {
              activeProc.kill('SIGKILL');
            }
          } catch {
            // Ignore SIGKILL error
          }
        }, 1200);
        forceKillTimer.unref?.();
      } catch {
        // Ignore kill error
      }
    }
    if (typeof origStop === 'function') {
      return origStop.call(this, opts);
    }
    this.proc = null;
    this.pending = new Uint8Array(0);
  };
}

/**
 * Synchronizes `session.videoSsrc` and `session.videoRtpStream.ssrc` with `session.selfSsrcJid`
 * (`generateSecureSsrc(callId, ourDeviceJid, 2)`), fixing the `@hiroosy/baileys-lite` bug where
 * `handleCallAck` updates `selfSsrc` (`streamIndex=0`) to the `:33@lid` companion device JID
 * but leaves `videoSsrc` (`streamIndex=2`) on the bare `:0@lid` JID.
 * Also computes and synchronizes `peerAudioSsrc` and `peerVideoSsrc` for inbound relay subscriptions.
 */
function syncSessionVideoSsrcWithDeviceJid(
  session: InstrumentedMediaSession
): void {
  const callId = session.info?.callId || session.callId;
  if (!callId) {
    return;
  }

  const normalizeDeviceJid = (jid: string): string =>
    typeof session.ensureDeviceJid === 'function'
      ? session.ensureDeviceJid(jid)
      : jid.includes(':')
        ? jid
        : jid.replace('@', ':0@');

  const sessionFlags = session as InstrumentedMediaSession & {
    mediaFlowStarted?: boolean;
    __botezzRelaysConnected?: boolean;
    acceptedByJid?: string | null;
  };

  // NEVER mutate outbound `videoSsrc` or `videoRtpStream.ssrc` once relays are connected,
  // call is accepted, or media flow has started — changing outbound SSRC after relay allocation
  // causes the WhatsApp relay or remote phone to drop all subsequent video frames after Frame 1!
  const outboundSsrcLocked = Boolean(
    sessionFlags.mediaFlowStarted ||
      sessionFlags.__botezzRelaysConnected ||
      (sessionFlags.acceptedByJid &&
        typeof session.videoSsrc === 'number' &&
        session.videoSsrc >>> 0 !== 0)
  );

  const activeDeviceJid = session.selfSsrcJid || session.selfLid;
  if (
    !outboundSsrcLocked &&
    activeDeviceJid &&
    (session.selfSsrcJid || session.videoSsrc === undefined)
  ) {
    const normalizedDeviceJid = normalizeDeviceJid(activeDeviceJid);
    const expectedVideoSsrc = computeWhatsAppSecureSsrc(
      callId,
      normalizedDeviceJid,
      2
    );
    session.videoSsrc = expectedVideoSsrc;
    if (session.videoRtpStream && typeof session.videoRtpStream === 'object') {
      session.videoRtpStream.ssrc = expectedVideoSsrc;
    }
    if (session.sctpRelay && typeof session.sctpRelay === 'object') {
      try {
        session.sctpRelay.setVideoSsrc?.(expectedVideoSsrc);
        const streamSsrcs = (session.sctpRelay as { streamSsrcs?: number[] })
          .streamSsrcs;
        if (Array.isArray(streamSsrcs) && streamSsrcs.length >= 4) {
          streamSsrcs[3] = expectedVideoSsrc;
        }
      } catch {
        // Ignore relay SSRC setter failure
      }
    }
  }

  const sessionAny = session as InstrumentedMediaSession & {
    acceptedByJid?: string;
    peerJid?: string;
    participantJids?: string[];
    peerSsrcs?: number[];
    peerAudioSsrc?: number;
    peerVideoSsrc?: number;
  };
  const candidatePeerJid =
    sessionAny.acceptedByJid ||
    sessionAny.peerJid ||
    (Array.isArray(sessionAny.participantJids)
      ? sessionAny.participantJids[0]
      : undefined);

  if (candidatePeerJid && typeof candidatePeerJid === 'string') {
    const normalizedPeerDeviceJid = normalizeDeviceJid(candidatePeerJid);
    const peerAudioSsrc =
      sessionAny.peerSsrcs?.[0] ||
      computeWhatsAppSecureSsrc(callId, normalizedPeerDeviceJid, 0);
    const peerVideoSsrc = computeWhatsAppSecureSsrc(
      callId,
      normalizedPeerDeviceJid,
      2
    );
    sessionAny.peerAudioSsrc = peerAudioSsrc;
    sessionAny.peerVideoSsrc = peerVideoSsrc;
    if (session.sctpRelay && typeof session.sctpRelay === 'object') {
      const relayAny = session.sctpRelay as Record<string, unknown>;
      relayAny.peerAudioSsrc = peerAudioSsrc;
      relayAny.peerVideoSsrc = peerVideoSsrc;
    }
  }
}

function deriveSrtpLabelBlock(
  masterKey: Uint8Array,
  masterSalt: Uint8Array,
  label: number,
  outBytes: number
): Uint8Array {
  const keyId = Buffer.alloc(14, 0);
  keyId[7] = label & 0xff;
  const x = Buffer.alloc(16, 0);
  for (let i = 0; i < 14; i++) {
    x[i] = (masterSalt[i] ?? 0) ^ (keyId[i] ?? 0);
  }
  const numBlocks = Math.ceil(outBytes / 16);
  const out = Buffer.alloc(numBlocks * 16, 0);
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(masterKey), null);
  cipher.setAutoPadding(false);
  for (let b = 0; b < numBlocks; b++) {
    const blockIn = Buffer.from(x);
    blockIn.writeUInt16BE(b, 14);
    const enc = cipher.update(blockIn);
    enc.copy(out, b * 16);
  }
  return new Uint8Array(out.subarray(0, outBytes));
}

function derivePeerRecvCtxFromKeyMaterial(
  rawOrKeying:
    | Uint8Array
    | {
        masterKey?: Uint8Array;
        masterSalt?: Uint8Array;
        key?: Uint8Array;
        salt?: Uint8Array;
      }
    | null
    | undefined,
  authTagLen = 4
): {
  sessionKey: Uint8Array;
  sessionSalt: Uint8Array;
  authKey: Uint8Array;
  authTagLen: number;
} | null {
  if (!rawOrKeying) return null;
  let masterKey: Uint8Array | undefined;
  let masterSalt: Uint8Array | undefined;
  if (rawOrKeying instanceof Uint8Array) {
    if (rawOrKeying.length < 30) return null;
    masterKey = rawOrKeying.subarray(0, 16);
    masterSalt = rawOrKeying.subarray(16, 30);
  } else if (typeof rawOrKeying === 'object') {
    const mk = rawOrKeying.masterKey ?? rawOrKeying.key;
    const ms = rawOrKeying.masterSalt ?? rawOrKeying.salt;
    if (
      mk instanceof Uint8Array &&
      mk.length >= 16 &&
      ms instanceof Uint8Array &&
      ms.length >= 14
    ) {
      masterKey = mk.subarray(0, 16);
      masterSalt = ms.subarray(0, 14);
    }
  }
  if (!masterKey || !masterSalt) return null;
  try {
    return {
      sessionKey: deriveSrtpLabelBlock(masterKey, masterSalt, 0x00, 16),
      authKey: deriveSrtpLabelBlock(masterKey, masterSalt, 0x01, 20),
      sessionSalt: deriveSrtpLabelBlock(masterKey, masterSalt, 0x02, 14),
      authTagLen,
    };
  } catch {
    return null;
  }
}

export function syncReceiveOnlySrtpOnMediaSession(
  target: InstrumentedMediaSession | Record<string, unknown> | null | undefined
): void {
  if (!target || typeof target !== 'object') {
    return;
  }

  // If `target` is a `WaCallManager` holding `this.calls` Map, sync all active media sessions
  const targetWithCalls = target as {
    calls?: Map<string, InstrumentedMediaSession>;
    mediaSession?: InstrumentedMediaSession;
    callMediaSession?: InstrumentedMediaSession;
  };
  if (targetWithCalls.calls instanceof Map) {
    for (const activeCallSession of targetWithCalls.calls.values()) {
      if (activeCallSession && activeCallSession !== target) {
        syncReceiveOnlySrtpOnMediaSession(activeCallSession);
      }
    }
  }

  const mediaSession = (targetWithCalls.mediaSession ||
    targetWithCalls.callMediaSession ||
    target) as InstrumentedMediaSession;
  if (!mediaSession || typeof mediaSession !== 'object') {
    return;
  }

  const s = mediaSession as InstrumentedMediaSession & {
    initSrtpKeys?: () => void;
    videoRtpStream?: unknown;
    srtpSession?: {
      recvCipher?: Record<string, unknown> | null;
      recvKeying?: {
        masterKey?: Uint8Array;
        masterSalt?: Uint8Array;
        key?: Uint8Array;
        salt?: Uint8Array;
      } | null;
      recvAuthTagLen?: number;
      sendCtx?: {
        sessionKey?: Uint8Array;
      } | null;
      recvCtx?: {
        sessionKey?: Uint8Array;
        sessionSalt?: Uint8Array;
        authKey?: Uint8Array;
        authTagLen?: number;
      };
      [key: string]: unknown;
    } | null;
    videoSrtpSession?: {
      recvCipher?: unknown;
      recvKeying?: unknown;
      recvAuthTagLen?: number;
      recvCtx?: {
        sessionKey?: Uint8Array;
        sessionSalt?: Uint8Array;
        authKey?: Uint8Array;
        authTagLen?: number;
        initialized?: boolean;
        roc?: number;
        lastSeq?: number;
        highestIndex?: bigint;
        replayMask?: bigint;
      };
    } | null;
  };

  const localCallKey =
    (mediaSession.info?.callKey instanceof Uint8Array
      ? mediaSession.info.callKey
      : undefined) ||
    (mediaSession.info?.encryptionKey instanceof Uint8Array
      ? mediaSession.info.encryptionKey
      : undefined) ||
    (mediaSession.localCallKey instanceof Uint8Array
      ? mediaSession.localCallKey
      : undefined);
  if (localCallKey) {
    mediaSession.__localCallKey = localCallKey;
  }

  const infoPeerCallKey = (
    mediaSession.info as { peerCallKey?: unknown } | undefined
  )?.peerCallKey;
  const peerCallKey =
    (infoPeerCallKey instanceof Uint8Array ? infoPeerCallKey : undefined) ||
    (mediaSession.peerCallKey instanceof Uint8Array
      ? mediaSession.peerCallKey
      : undefined) ||
    (mediaSession.__peerCallKey instanceof Uint8Array
      ? mediaSession.__peerCallKey
      : undefined);
  if (peerCallKey) {
    mediaSession.__peerCallKey = peerCallKey;
  }

  // If handleCallAccept set srtpFromPeerKey = true before initSrtpKeys() created videoSrtpSession,
  // initialize videoSrtpSession with our local encryptionKey while preserving the peer-derived srtpSession.
  const isVideoMedia =
    (mediaSession.info as { mediaType?: string } | undefined)?.mediaType ===
      'video' || Boolean(s.videoRtpStream);
  if (
    !s.videoSrtpSession &&
    s.srtpSession &&
    isVideoMedia &&
    typeof s.initSrtpKeys === 'function'
  ) {
    const peerDerivedSrtp = s.srtpSession;
    try {
      s.initSrtpKeys();
    } catch {
      // Ignore initSrtpKeys error
    }
    s.srtpSession = peerDerivedSrtp;
  }

  // Copy ONLY receive-side cipher/context from srtpSession onto videoSrtpSession;
  // NEVER overwrite videoSrtpSession.sendCipher or videoSrtpSession.sendCtx with peerCallKey.
  if (s.videoSrtpSession && s.srtpSession?.recvCipher) {
    s.videoSrtpSession.recvCipher = s.srtpSession.recvCipher;
    s.videoSrtpSession.recvKeying = s.srtpSession.recvKeying;
    if (s.srtpSession.recvAuthTagLen) {
      s.videoSrtpSession.recvAuthTagLen = s.srtpSession.recvAuthTagLen;
    }
  }

  let resolvedRecv:
    | {
        sessionKey: Uint8Array;
        sessionSalt: Uint8Array;
        authKey: Uint8Array;
        authTagLen: number;
      }
    | undefined;

  const recv = s.srtpSession?.recvCtx;
  if (
    recv?.sessionKey instanceof Uint8Array &&
    recv.sessionSalt instanceof Uint8Array &&
    recv.authKey instanceof Uint8Array
  ) {
    resolvedRecv = {
      sessionKey: recv.sessionKey,
      sessionSalt: recv.sessionSalt,
      authKey: recv.authKey,
      authTagLen: recv.authTagLen ?? s.srtpSession?.recvAuthTagLen ?? 4,
    };
  }

  // Fallback 1: Scan `s.srtpSession` properties (`recvCipher`, `recvKeying`, or internal sub-objects)
  if (!resolvedRecv && s.srtpSession && typeof s.srtpSession === 'object') {
    const sendKeyRef = s.srtpSession.sendCtx?.sessionKey;
    for (const [propName, propVal] of Object.entries(s.srtpSession)) {
      if (
        propName === 'sendCtx' ||
        propName === 'sendCipher' ||
        propName === 'sendKeying' ||
        !propVal ||
        typeof propVal !== 'object'
      ) {
        continue;
      }
      const cand = propVal as {
        sessionKey?: unknown;
        sessionSalt?: unknown;
        authKey?: unknown;
        authTagLen?: number;
        masterKey?: Uint8Array;
        masterSalt?: Uint8Array;
        key?: Uint8Array;
        salt?: Uint8Array;
      };
      if (
        cand.sessionKey instanceof Uint8Array &&
        cand.sessionSalt instanceof Uint8Array &&
        cand.authKey instanceof Uint8Array
      ) {
        if (sendKeyRef && cand.sessionKey === sendKeyRef) {
          continue;
        }
        resolvedRecv = {
          sessionKey: cand.sessionKey,
          sessionSalt: cand.sessionSalt,
          authKey: cand.authKey,
          authTagLen: cand.authTagLen ?? s.srtpSession.recvAuthTagLen ?? 4,
        };
        break;
      }
      const derivedFromSub = derivePeerRecvCtxFromKeyMaterial(
        cand,
        s.srtpSession.recvAuthTagLen ?? 4
      );
      if (derivedFromSub) {
        resolvedRecv = derivedFromSub;
        break;
      }
    }
  }

  // Fallback 2: Derive RFC 3711 receive keys from `peerCallKey` if available
  if (!resolvedRecv && peerCallKey && peerCallKey.length >= 30) {
    const derived = derivePeerRecvCtxFromKeyMaterial(
      peerCallKey,
      s.srtpSession?.recvAuthTagLen ?? 4
    );
    if (derived) {
      resolvedRecv = derived;
    }
  }

  if (resolvedRecv) {
    mediaSession.__peerRecvCtx = {
      sessionKey: resolvedRecv.sessionKey,
      sessionSalt: resolvedRecv.sessionSalt,
      authKey: resolvedRecv.authKey,
      authTagLen: resolvedRecv.authTagLen,
    };
    if (s.videoSrtpSession?.recvCtx) {
      const targetRecv = s.videoSrtpSession.recvCtx;
      const keyChanged =
        !(targetRecv.sessionKey instanceof Uint8Array) ||
        targetRecv.sessionKey.length !== resolvedRecv.sessionKey.length ||
        !targetRecv.sessionKey.every(
          (b, idx) => b === resolvedRecv!.sessionKey[idx]
        );

      targetRecv.sessionKey = resolvedRecv.sessionKey;
      targetRecv.sessionSalt = resolvedRecv.sessionSalt;
      targetRecv.authKey = resolvedRecv.authKey;
      if (resolvedRecv.authTagLen) {
        targetRecv.authTagLen = resolvedRecv.authTagLen;
      }
      if (keyChanged) {
        targetRecv.initialized = false;
        targetRecv.roc = 0;
        targetRecv.lastSeq = 0;
        targetRecv.highestIndex = BigInt(0);
        targetRecv.replayMask = BigInt(0);
      }
    }
    try {
      mediaSession.__botezzRecorderAttached?.setPeerSrtpKeys?.(resolvedRecv);
    } catch {
      // Non-fatal recorder notification
    }
  }
}

export function cloneSrtpRecvContext(templateCtx: any): any {
  if (!templateCtx || typeof templateCtx !== 'object') return null;
  const Ctor = templateCtx.constructor;
  let clone: any;
  if (typeof Ctor === 'function' && Ctor !== Object) {
    try {
      const dummyKeying = {
        masterKey:
          templateCtx.masterKey instanceof Uint8Array
            ? new Uint8Array(templateCtx.masterKey)
            : new Uint8Array(16),
        masterSalt:
          templateCtx.masterSalt instanceof Uint8Array
            ? new Uint8Array(templateCtx.masterSalt)
            : new Uint8Array(14),
      };
      clone = new Ctor(dummyKeying, templateCtx.authTagLen ?? 4);
    } catch {
      clone = Object.create(Ctor.prototype);
    }
  } else {
    clone = {};
  }
  clone.masterKey =
    templateCtx.masterKey instanceof Uint8Array
      ? new Uint8Array(templateCtx.masterKey)
      : templateCtx.masterKey;
  clone.masterSalt =
    templateCtx.masterSalt instanceof Uint8Array
      ? new Uint8Array(templateCtx.masterSalt)
      : templateCtx.masterSalt;
  clone.sessionKey =
    templateCtx.sessionKey instanceof Uint8Array
      ? new Uint8Array(templateCtx.sessionKey)
      : templateCtx.sessionKey;
  clone.sessionSalt =
    templateCtx.sessionSalt instanceof Uint8Array
      ? new Uint8Array(templateCtx.sessionSalt)
      : templateCtx.sessionSalt;
  clone.authKey =
    templateCtx.authKey instanceof Uint8Array
      ? new Uint8Array(templateCtx.authKey)
      : templateCtx.authKey;
  clone.authTagLen = templateCtx.authTagLen ?? 4;
  clone.ivBuffer = new Uint8Array(16);
  clone.ssrcBuffer = new Uint8Array(4);
  clone.indexBuffer = new Uint8Array(8);
  clone.rocBuffer = new Uint8Array(4);
  clone.roc = 0;
  clone.lastSeq = 0;
  clone.initialized = false;
  clone.highestIndex = BigInt(0);
  clone.replayMask = BigInt(0);
  return clone;
}

function buildRtcpPliPacket(senderSsrc: number, mediaSsrc: number): Uint8Array {
  const pkt = new Uint8Array(12);
  const view = new DataView(pkt.buffer);
  pkt[0] = 0x81; // V=2, P=0, FMT=1 (PLI)
  pkt[1] = 206; // PT=206 (PSFB)
  view.setUint16(2, 2, false); // length = 2 (12 bytes total)
  view.setUint32(4, senderSsrc >>> 0, false);
  view.setUint32(8, mediaSsrc >>> 0, false);
  return pkt;
}

function syncSessionVideoSrtpTemplates(session: any): void {
  if (!session || typeof session !== 'object') return;
  syncReceiveOnlySrtpOnMediaSession(session);

  const templates: any[] = [];
  const audioRecvCtx = session.srtpSession?.recvCtx;
  const audioSendCtx = session.srtpSession?.sendCtx;

  if (audioRecvCtx) {
    templates.push(cloneSrtpRecvContext(audioRecvCtx));
  }

  if (session.videoSrtpSession?.recvCtx) {
    const existingVidRecv = session.videoSrtpSession.recvCtx;
    const isSameKey =
      audioRecvCtx?.sessionKey instanceof Uint8Array &&
      existingVidRecv?.sessionKey instanceof Uint8Array &&
      Buffer.compare(
        Buffer.from(audioRecvCtx.sessionKey),
        Buffer.from(existingVidRecv.sessionKey)
      ) === 0;
    if (!isSameKey) {
      templates.push(cloneSrtpRecvContext(existingVidRecv));
    }
  }

  // Ensure `session.videoSrtpSession` exists and has `recvCtx` updated to `audioRecvCtx` (`peerCallKey`)
  // while NEVER replacing or cloning `videoSrtpSession.sendCtx` once initialized (so outbound ROC/lastSeq stay intact).
  if (!session.videoSrtpSession && session.srtpSession) {
    const SrtpSessionCtor = session.srtpSession.constructor;
    try {
      const created = Object.create(SrtpSessionCtor.prototype);
      created.sendCtx = cloneSrtpRecvContext(audioSendCtx);
      created.recvCtx = cloneSrtpRecvContext(audioRecvCtx);
      session.videoSrtpSession = created;
    } catch {
      // Fallback handled by syncReceiveOnlySrtpOnMediaSession
    }
  } else if (session.videoSrtpSession && audioRecvCtx) {
    const vidRecv = session.videoSrtpSession.recvCtx;
    const keyDiffers =
      !vidRecv?.sessionKey ||
      !(audioRecvCtx.sessionKey instanceof Uint8Array) ||
      Buffer.compare(
        Buffer.from(vidRecv.sessionKey),
        Buffer.from(audioRecvCtx.sessionKey)
      ) !== 0;
    if (keyDiffers && typeof audioRecvCtx.unprotect === 'function') {
      session.videoSrtpSession.recvCtx = cloneSrtpRecvContext(audioRecvCtx);
    }
  }

  if (templates.length > 0) {
    session._videoRecvTemplates = templates.filter(Boolean);
    session._videoRecvBySsrc = new Map<number, any[]>();
  }
}

function unprotectInboundVideoPacket(
  session: any,
  data: Uint8Array
): {
  header: {
    padding?: boolean;
    marker: boolean;
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
  };
  payload: Uint8Array;
} | null {
  if (!data || data.byteLength < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ssrc = view.getUint32(8, false);

  if (!session._videoRecvTemplates || session._videoRecvTemplates.length === 0) {
    syncSessionVideoSrtpTemplates(session);
  }

  const bySsrcMap: Map<number, any[]> =
    session._videoRecvBySsrc ||
    (session._videoRecvBySsrc = new Map<number, any[]>());
  let ctxList = bySsrcMap.get(ssrc);
  if (!ctxList || ctxList.length === 0) {
    const templates: any[] = session._videoRecvTemplates || [];
    ctxList = templates
      .map((t: any) => cloneSrtpRecvContext(t))
      .filter(Boolean);
    if (ctxList.length > 0) {
      bySsrcMap.set(ssrc, ctxList);
    }
  }

  const candidates: any[] = [...(ctxList || [])];
  if (
    session.videoSrtpSession?.recvCtx &&
    !candidates.includes(session.videoSrtpSession.recvCtx)
  ) {
    candidates.push(session.videoSrtpSession.recvCtx);
  }

  for (let i = 0; i < candidates.length; i++) {
    const ctx = candidates[i];
    if (!ctx || typeof ctx.unprotect !== 'function') continue;

    // Try with 4-byte authTagLen first (standard in @hiroosy/baileys-lite/voip) and fallback to 10 bytes
    const primaryTagLen = ctx.authTagLen ?? 4;
    const tagLengthsToTry =
      primaryTagLen === 4
        ? [4, 10]
        : primaryTagLen === 10
          ? [4, 10]
          : [primaryTagLen, 4, 10];

    for (const tagLen of tagLengthsToTry) {
      const savedRoc = ctx.roc;
      const savedLastSeq = ctx.lastSeq;
      const savedInit = ctx.initialized;
      const savedHighest = ctx.highestIndex;
      const savedMask = ctx.replayMask;
      const savedTagLen = ctx.authTagLen;
      try {
        ctx.authTagLen = tagLen;
        const pkt = ctx.unprotect(data);
        ctx.authTagLen = savedTagLen;
        if (pkt && pkt.payload) {
          // Strip RTP padding if `header.padding === true`
          if (pkt.header?.padding && pkt.payload.byteLength > 0) {
            const padLen = pkt.payload[pkt.payload.byteLength - 1]!;
            if (padLen > 0 && padLen <= pkt.payload.byteLength) {
              pkt.payload = pkt.payload.subarray(
                0,
                pkt.payload.byteLength - padLen
              );
            }
          }
          if (i > 0 && ctxList && i < ctxList.length) {
            const winning = ctxList[i];
            ctxList.splice(i, 1);
            ctxList.unshift(winning);
          }
          return pkt;
        }
      } catch {
        ctx.roc = savedRoc;
        ctx.lastSeq = savedLastSeq;
        ctx.initialized = savedInit;
        ctx.highestIndex = savedHighest;
        ctx.replayMask = savedMask;
        ctx.authTagLen = savedTagLen;
      }
    }
  }

  return null;
}

function computeAndSubscribePeerSsrcs(
  session: any,
  extraPeerJid?: string
): number[] {
  const callId: string = session?.info?.callId || session?.callId || '';
  if (!callId) return [];

  const creds = session?.deps?.authClient?.getCurrentCredentials?.();
  const ourBase = String(creds?.meLid || creds?.meJid || '').split(/[:@]/)[0];

  const candidatePeerJids = new Set<string>();
  const addJidVariants = (rawJid?: string | null) => {
    if (!rawJid || typeof rawJid !== 'string') return;
    const trimmed = rawJid.trim();
    if (!trimmed || !trimmed.includes('@')) return;
    const baseUser = trimmed.split(/[:@]/)[0];
    if (ourBase && baseUser === ourBase) return;
    candidatePeerJids.add(trimmed);
    candidatePeerJids.add(ensureDeviceJidFormat(trimmed));
    const bare = trimmed.replace(/:\d+@/, '@');
    candidatePeerJids.add(bare);
    candidatePeerJids.add(ensureDeviceJidFormat(bare));
  };

  addJidVariants(extraPeerJid);
  addJidVariants(session.acceptedByJid);
  addJidVariants(session.info?.peerJid);
  addJidVariants(session.peerJid);
  if (Array.isArray(session.info?.relayData?.participantJids)) {
    for (const pJid of session.info.relayData.participantJids) {
      addJidVariants(pJid);
    }
  }
  if (session.peerVideoJids instanceof Set) {
    for (const vJid of session.peerVideoJids) {
      addJidVariants(vJid);
    }
  }

  const derivedSsrcs: number[] = [];
  if (Array.isArray(session.peerSsrcs)) {
    for (const s of session.peerSsrcs) {
      if (typeof s === 'number' && s >>> 0 !== 0) {
        derivedSsrcs.push(s >>> 0);
      }
    }
  }
  if (typeof session.actualPeerSsrc === 'number' && session.actualPeerSsrc >>> 0 !== 0) {
    derivedSsrcs.push(session.actualPeerSsrc >>> 0);
  }
  if (typeof session.peerVideoSsrc === 'number' && session.peerVideoSsrc >>> 0 !== 0) {
    derivedSsrcs.push(session.peerVideoSsrc >>> 0);
  }

  // Counters: 0 = audio, 2 = primary video, 1/3/4/5 = secondary/simulcast video layers
  const counters = [0, 2, 1, 3, 4, 5];
  for (const jid of candidatePeerJids) {
    for (const counter of counters) {
      try {
        const ssrc = computeWhatsAppSecureSsrc(callId, jid, counter);
        if (ssrc >>> 0 !== 0) {
          derivedSsrcs.push(ssrc >>> 0);
        }
      } catch {
        // Ignore
      }
    }
  }

  const unique = Array.from(new Set(derivedSsrcs));
  session._allPeerSubscriptionSsrcs = unique;
  if (unique.length > 0 && session.sctpRelay) {
    if (!Array.isArray(session.peerSsrcs) || session.peerSsrcs.length === 0) {
      session.peerSsrcs = [unique[0]!];
    }
    session.sctpRelay.setSubscriptionSsrc?.(session.peerSsrcs[0] ?? unique[0]!);
    session.sctpRelay.setPeerSubscriptionSsrcs?.(unique);
  }
  return unique;
}

export function sendProactiveVideoStateAndPli(session: any): void {
  if (!session || typeof session !== 'object') return;
  const isVideo =
    session.info?.mediaType === 'video' ||
    Boolean(session.videoRtpStream) ||
    Boolean(session.peerVideoActive);
  if (!isVideo) return;

  // CRITICAL: Do NOT send an unsolicited `<call><video state="1" dec="H264" device_orientation="0"/></call>`
  // stanza here! Sending `state="1"` without `enc="h.264"` causes the remote WhatsApp phone to mark
  // our outbound video encoder as disabled/reset and freeze outbound video on Frame 1.
  // Only send RTCP PLI over `sctpRelay` to request inbound keyframes from the peer's camera.
  const sendPliBurst = () => {
    try {
      if (!session.sctpRelay?.hasConnection?.()) return;
      const rtcpCtx = session.videoRtcpSession || session.audioRtcpSession;
      const senderSsrc = (session.videoSsrc || session.selfSsrc) >>> 0;
      if (!rtcpCtx || !senderSsrc) return;

      const peerCandidates: number[] = [];
      if (session._lastInboundVideoSsrc) {
        peerCandidates.push(session._lastInboundVideoSsrc >>> 0);
      }
      if (Array.isArray(session._allPeerSubscriptionSsrcs)) {
        for (const s of session._allPeerSubscriptionSsrcs.slice(0, 6)) {
          peerCandidates.push(s >>> 0);
        }
      }
      const uniqueTargets = Array.from(
        new Set(peerCandidates.filter((s) => s !== 0))
      );
      for (const mediaSsrc of uniqueTargets.slice(0, 4)) {
        const plainPli = buildRtcpPliPacket(senderSsrc, mediaSsrc);
        const protectedPli = rtcpCtx.protect(senderSsrc, plainPli);
        const ab = protectedPli.buffer.slice(
          protectedPli.byteOffset,
          protectedPli.byteOffset + protectedPli.byteLength
        );
        session.sctpRelay.broadcast(ab);
      }
    } catch {
      // Non-fatal PLI error
    }
  };

  sendPliBurst();
  if (!session._pliIntervalTimer) {
    session._pliIntervalTimer = setInterval(() => {
      if (
        session.__botezzDisposed ||
        session.info?.isEnded ||
        !session.sctpRelay?.hasConnection?.()
      ) {
        clearInterval(session._pliIntervalTimer);
        session._pliIntervalTimer = null;
        return;
      }
      const hasSpsPps = Boolean(
        session._smartVideoAssembler?.cachedSps &&
          session._smartVideoAssembler?.cachedPps
      );
      if (
        !hasSpsPps ||
        (session._inboundVideoFramesCount ?? 0) === 0 ||
        session._needsPliRequest
      ) {
        session._needsPliRequest = false;
        sendPliBurst();
      }
    }, 2500);
    session._pliIntervalTimer.unref?.();
  }
}

function attachPassiveNativeMediaSessionTaps(
  target: InstrumentedMediaSession & {
    __botezzPassiveTapApplied?: boolean;
    handleCallAccept?: (...args: unknown[]) => Promise<unknown>;
    handleCallAck?: (node: unknown) => Promise<void>;
    handleCallVideo?: (node: unknown) => Promise<unknown>;
    enableVideoMidCall?: (...args: unknown[]) => Promise<unknown>;
    swapVideoSource?: (videoPath: string) => Promise<unknown>;
    startMediaFlow?: (...args: unknown[]) => unknown;
    cleanup?: (...args: unknown[]) => unknown;
    connectRelays?: (...args: unknown[]) => Promise<unknown>;
    setupSrtp?: (...args: unknown[]) => unknown;
    initSrtpKeys?: (...args: unknown[]) => unknown;
    onRelayData?: (data: Uint8Array) => unknown;
    onRelayVideoData?: (data: Uint8Array) => unknown;
  }
): void {
  if (!target || typeof target !== 'object') {
    return;
  }

  // Track non-prototype media session instances in `activeCallMediaSessions`
  const isPrototypeObject =
    Object.prototype.hasOwnProperty.call(target, 'constructor') &&
    typeof (target as { constructor?: unknown }).constructor === 'function';
  if (!isPrototypeObject && !target.__botezzDisposed) {
    activeCallMediaSessions.add(target);
  }
  if (target.videoEngine && typeof target.videoEngine === 'object') {
    const veProto = Object.getPrototypeOf(target.videoEngine);
    if (veProto && veProto !== Object.prototype) {
      patchWaVideoEnginePrototype(veProto);
    }
  }

  if (Object.prototype.hasOwnProperty.call(target, '__botezzPassiveTapApplied')) {
    return;
  }
  Object.defineProperty(target, '__botezzPassiveTapApplied', {
    value: true,
    configurable: true,
    enumerable: false,
    writable: true,
  });

  if (typeof target.handleCallAccept === 'function') {
    const origAccept = target.handleCallAccept;
    target.handleCallAccept = async function passiveAcceptTap(
      this: typeof target,
      ...args: unknown[]
    ) {
      if (!this.__botezzDisposed) {
        activeCallMediaSessions.add(this);
      }
      const res = await origAccept.apply(this, args);
      try {
        const peerJidArg = typeof args[1] === 'string' ? args[1] : undefined;
        // Do NOT call syncSessionVideoSsrcWithDeviceJid(this) here after accept;
        // outbound videoSsrc must never be mutated after relay setup.
        syncSessionVideoSrtpTemplates(this);
        computeAndSubscribePeerSsrcs(this, peerJidArg);
        (
          this.sctpRelay as { resendSubscriptions?: () => void } | undefined
        )?.resendSubscriptions?.();
        sendProactiveVideoStateAndPli(this);
      } catch {
        // Passive receive-side sync must never throw
      }
      return res;
    };
  }

  if (typeof target.handleCallAck === 'function') {
    const origAck = target.handleCallAck;
    target.handleCallAck = async function passiveAckTap(
      this: typeof target,
      node: unknown
    ): Promise<void> {
      if (!this.__botezzDisposed) {
        activeCallMediaSessions.add(this);
      }
      await origAck.call(this, node);
      try {
        syncSessionVideoSsrcWithDeviceJid(this);
        syncSessionVideoSrtpTemplates(this);
        computeAndSubscribePeerSsrcs(this);
      } catch {
        // Passive ack sync must never throw
      }
    };
  }

  if (typeof target.connectRelays === 'function') {
    const origRelays = target.connectRelays;
    target.connectRelays = async function passiveRelaysTap(
      this: typeof target,
      ...args: unknown[]
    ) {
      if (!this.__botezzDisposed) {
        activeCallMediaSessions.add(this);
      }
      try {
        syncSessionVideoSsrcWithDeviceJid(this);
        computeAndSubscribePeerSsrcs(this);
      } catch {
        // Non-fatal
      }
      const res = await origRelays.apply(this, args);
      (this as Record<string, unknown>).__botezzRelaysConnected = true;
      try {
        syncSessionVideoSrtpTemplates(this);
        computeAndSubscribePeerSsrcs(this);
        (
          this.sctpRelay as { resendSubscriptions?: () => void } | undefined
        )?.resendSubscriptions?.();
      } catch {
        // Non-fatal
      }
      return res;
    };
  }

  if (typeof target.setupSrtp === 'function') {
    const origSetupSrtp = target.setupSrtp;
    target.setupSrtp = function passiveSetupSrtpTap(
      this: typeof target,
      ...args: unknown[]
    ) {
      const res = origSetupSrtp.apply(this, args);
      try {
        syncSessionVideoSrtpTemplates(this);
        computeAndSubscribePeerSsrcs(this);
      } catch {
        // Non-fatal
      }
      return res;
    };
  }

  if (typeof target.initSrtpKeys === 'function') {
    const origInitSrtp = target.initSrtpKeys;
    target.initSrtpKeys = function passiveInitSrtpTap(
      this: typeof target,
      ...args: unknown[]
    ) {
      const res = origInitSrtp.apply(this, args);
      try {
        syncSessionVideoSrtpTemplates(this);
        computeAndSubscribePeerSsrcs(this);
      } catch {
        // Non-fatal
      }
      return res;
    };
  }

  if (typeof target.swapVideoSource === 'function') {
    const origSwapVideoSource = target.swapVideoSource;
    target.swapVideoSource = async function passiveSwapVideoSourceTap(
      this: typeof target,
      videoPath: string
    ) {
      // If `VoipCall._advance()` loops the exact same video file that `WaVideoEngine` is already
      // streaming via `-stream_loop -1` (or `nalUnits` loop), do NOT kill and restart `videoEngine` mid-call!
      if (
        this.videoEngine &&
        this.videoEngine.running &&
        this.videoEngine.videoPath &&
        videoPath &&
        path.resolve(String(this.videoEngine.videoPath)) ===
          path.resolve(String(videoPath))
      ) {
        return;
      }
      return await origSwapVideoSource.call(this, videoPath);
    };
  }

  if (typeof target.enableVideoMidCall === 'function') {
    const origEnableVideoMidCall = target.enableVideoMidCall;
    target.enableVideoMidCall = async function passiveEnableVideoMidCallTap(
      this: typeof target,
      ...args: unknown[]
    ) {
      const res = await origEnableVideoMidCall.apply(this, args);
      try {
        syncSessionVideoSrtpTemplates(this);
        computeAndSubscribePeerSsrcs(this);
        (
          this.sctpRelay as { resendSubscriptions?: () => void } | undefined
        )?.resendSubscriptions?.();
        sendProactiveVideoStateAndPli(this);
      } catch {
        // Non-fatal
      }
      return res;
    };
  }

  if (typeof target.handleCallVideo === 'function') {
    const origHandleCallVideo = target.handleCallVideo;
    target.handleCallVideo = async function passiveHandleCallVideoTap(
      this: typeof target,
      node: unknown
    ) {
      const res = await origHandleCallVideo.call(this, node);
      try {
        const selfAny = this as any;
        if (selfAny.peerVideoActive) {
          if (
            (!selfAny.videoSrtpSession || !selfAny.videoRtpStream) &&
            typeof selfAny.enableVideoMidCall === 'function'
          ) {
            await selfAny.enableVideoMidCall();
          }
          syncSessionVideoSrtpTemplates(selfAny);
          computeAndSubscribePeerSsrcs(selfAny);
          selfAny.sctpRelay?.resendSubscriptions?.();
          sendProactiveVideoStateAndPli(selfAny);
        }
      } catch {
        // Non-fatal
      }
      return res;
    };
  }

  if (typeof target.cleanup === 'function') {
    const origCleanup = target.cleanup;
    target.cleanup = function passiveCleanupTap(
      this: typeof target,
      ...args: unknown[]
    ) {
      const selfAny = this as any;
      selfAny.__botezzDisposed = true;
      activeCallMediaSessions.delete(selfAny);
      if (selfAny._pliIntervalTimer) {
        clearInterval(selfAny._pliIntervalTimer);
        selfAny._pliIntervalTimer = null;
      }
      if (selfAny._botezzPliTimer) {
        clearInterval(selfAny._botezzPliTimer);
        selfAny._botezzPliTimer = null;
      }
      selfAny._smartVideoAssembler = null;
      selfAny._videoRecvTemplates = null;
      selfAny._videoRecvBySsrc = null;
      selfAny._perSsrcVideoRecvCtx?.clear?.();
      return origCleanup.apply(this, args);
    };
  }

  if (typeof target.onRelayVideoData === 'function') {
    target.onRelayVideoData = function patchedOnRelayVideoDataTap(
      this: typeof target,
      data: Uint8Array
    ) {
      const selfAny = this as any;
      try {
        if (!selfAny.__peerRecvCtx?.sessionKey) {
          syncSessionVideoSrtpTemplates(selfAny);
        }
        const packet = data instanceof Uint8Array ? data : null;
        if (!packet || packet.length < 12) return;

        if (!selfAny._smartVideoAssembler) {
          selfAny._smartVideoAssembler = new SmartH264Assembler();
        }

        const rtpPacket = unprotectInboundVideoPacket(selfAny, packet);
        if (!rtpPacket) {
          selfAny.srtpErrorCount = (selfAny.srtpErrorCount ?? 0) + 1;
          // Fallback: allow VoipCallRecorder's own multi-tag decryptor to try
          selfAny.__botezzRecorderAttached?.handleInboundVideoRtpPacket?.(
            packet,
            selfAny
          );
          return;
        }

        selfAny._lastInboundVideoSsrc = rtpPacket.header.ssrc >>> 0;
        const { accessUnit, complete, seqGap } = (
          selfAny._smartVideoAssembler as SmartH264Assembler
        ).push(
          rtpPacket.header.sequenceNumber,
          rtpPacket.header.marker,
          rtpPacket.payload,
          rtpPacket.header.timestamp
        );

        if (seqGap) {
          selfAny._needsPliRequest = true;
        }

        if (complete && accessUnit && accessUnit.byteLength > 0) {
          selfAny._inboundVideoFramesCount =
            (selfAny._inboundVideoFramesCount ?? 0) + 1;
          const activeCallId: string | undefined =
            selfAny.info?.callId || selfAny.callId;
          try {
            selfAny.delegate?.emitInboundVideo?.(selfAny.info, accessUnit);
          } catch {
            // Ignore delegate error
          }
          emitGlobalInboundVideo(activeCallId, accessUnit);
        }
      } catch {
        // Passive video tap must never throw
      }
    };
  }

  if (typeof target.onRelayData === 'function') {
    const origOnRelayData = target.onRelayData;
    target.onRelayData = function passiveOnRelayDataTap(
      this: typeof target,
      data: Uint8Array
    ) {
      const selfAny = this as any;
      try {
        if (!selfAny.__peerRecvCtx?.sessionKey) {
          syncSessionVideoSrtpTemplates(selfAny);
        }

        // Hook `this.onDecodedAudio` once per instance so decoded PCM audio is forwarded to global audio hooks
        if (
          typeof selfAny.onDecodedAudio === 'function' &&
          !selfAny.onDecodedAudio.__botezzAudioHooked
        ) {
          const origDecodedAudio = selfAny.onDecodedAudio;
          const wrappedDecodedAudio = (pcm: Float32Array) => {
            origDecodedAudio(pcm);
            emitGlobalInboundAudio(
              selfAny.info?.callId || selfAny.callId,
              pcm
            );
          };
          wrappedDecodedAudio.__botezzAudioHooked = true;
          selfAny.onDecodedAudio = wrappedDecodedAudio;
        }

        const packet = data instanceof Uint8Array ? data : null;
        if (packet && packet.length >= 12 && (packet[0]! & 0xc0) === 0x80) {
          const pt = packet[1]! & 0x7f;
          // Skip RTCP packets (PT 72..78 / packetType 200..206)
          if (pt < 72 || pt > 78) {
            const ssrc =
              ((packet[8]! << 24) |
                (packet[9]! << 16) |
                (packet[10]! << 8) |
                packet[11]!) >>>
              0;

            if (ssrc === selfAny.selfSsrc || ssrc === selfAny.videoSsrc) {
              selfAny.selfEchoCount = (selfAny.selfEchoCount ?? 0) + 1;
              return;
            }

            const isAppData =
              selfAny.peerAppDataSsrcs instanceof Set &&
              selfAny.peerAppDataSsrcs.has(ssrc);
            if (!isAppData) {
              const isVideoPt =
                pt === 97 ||
                (pt >= 96 && pt <= 127 && pt !== 111 && pt !== 120);
              const isAudioPt =
                pt < 96 || pt === 111 || pt === 120 || pt === 0 || pt === 8;

              if (isVideoPt) {
                selfAny.sctpRelay?.addPeerSubscriptionSsrc?.(ssrc);
                if (typeof selfAny.onRelayVideoData === 'function') {
                  return selfAny.onRelayVideoData(packet);
                }
              } else if (isAudioPt) {
                selfAny.__botezzRecorderAttached?.handleInboundAudioRtpPacket?.(
                  packet,
                  selfAny
                );
              }
            }
          }
        }
      } catch {
        // Passive relay tap must never throw
      }
      return origOnRelayData.call(this, data);
    };
  }
}

export function instrumentMediaSessionInstance(
  rawSession: WaCallMediaSessionLike | null | undefined
): InstrumentedMediaSession | undefined {
  if (!rawSession || typeof rawSession !== 'object') {
    return undefined;
  }
  const session = rawSession as InstrumentedMediaSession;

  // For real `@hiroosy/baileys-lite` `WaCallMediaSession` instances, NEVER monkey-patch or override
  // outbound audio/video engines (`WaVideoEngine`, `WaAudioEngine`, `sendCapturedVideoAU`, `videoSrtpSession.sendCipher`).
  // Attach ONLY non-destructive receive-side cipher sync (`recvCipher`/`recvKeying`/`recvCtx`), videoSsrc sync, and passive recorder tap.
  const isNativeWaCallMediaSession =
    (session as { constructor?: { name?: string } }).constructor?.name ===
    'WaCallMediaSession';
  if (isNativeWaCallMediaSession) {
    syncReceiveOnlySrtpOnMediaSession(session);
    syncSessionVideoSsrcWithDeviceJid(session);
    if (Object.prototype.hasOwnProperty.call(session, '__botezzInstrumented')) {
      return session;
    }
    session.__botezzInstrumented = true;
    attachPassiveNativeMediaSessionTaps(session);
    return session;
  }

  wrapSctpRelayOnSession(session);
  if (session.audioEngine && typeof session.audioEngine === 'object') {
    instrumentAudioEngineInstance(
      session.audioEngine as unknown as InstrumentedAudioEngine
    );
  }
  if (session.videoEngine && typeof session.videoEngine === 'object') {
    instrumentVideoEngineInstance(
      session.videoEngine as unknown as InstrumentedVideoEngine
    );
  }

  if (Object.prototype.hasOwnProperty.call(session, '__botezzInstrumented')) {
    return session;
  }
  session.__botezzInstrumented = true;

  session.injectCachedSpsPpsKeyframe = function injectCachedSpsPpsKeyframe(
    this: InstrumentedMediaSession
  ): boolean {
    const sps =
      this._cachedSpsNalu ?? this.videoEngine?._cachedSpsNalu ?? null;
    const pps =
      this._cachedPpsNalu ?? this.videoEngine?._cachedPpsNalu ?? null;
    const idr =
      this._cachedIdrNalu ?? this.videoEngine?._cachedIdrNalu ?? null;
    if (!sps || !pps || !idr) {
      return false;
    }
    this.sendCapturedVideoAU?.([sps, pps, idr], true);
    return true;
  };

  // Hook `connectRelays` and `initSrtpKeys` so `videoSsrc` is updated BEFORE `connectRelays` sends STUN Allocate
  const sessionWithRelays = session as InstrumentedMediaSession & {
    connectRelays?: (relays: unknown) => Promise<unknown>;
    initSrtpKeys?: () => void;
    onRelayData?: (data: Uint8Array) => void;
    onRelayVideoData?: (data: Uint8Array) => void;
  };
  if (typeof sessionWithRelays.connectRelays === 'function') {
    const origConnectRelays = sessionWithRelays.connectRelays;
    sessionWithRelays.connectRelays = async function patchedConnectRelays(
      this: typeof sessionWithRelays,
      relays: unknown
    ) {
      syncSessionVideoSsrcWithDeviceJid(this);
      const res = await origConnectRelays.call(this, relays);
      wrapSctpRelayOnSession(this);
      syncSessionVideoSsrcWithDeviceJid(this);
      return res;
    };
  }

  if (typeof sessionWithRelays.initSrtpKeys === 'function') {
    const origInitSrtpKeys = sessionWithRelays.initSrtpKeys;
    sessionWithRelays.initSrtpKeys = function patchedInitSrtpKeys(
      this: typeof sessionWithRelays
    ) {
      syncSessionVideoSsrcWithDeviceJid(this);
      const res = origInitSrtpKeys.call(this);
      syncSessionVideoSsrcWithDeviceJid(this);
      return res;
    };
  }

  // Ensure dynamic H.264 payload types (96..127 excluding Opus 111/120) route to `onRelayVideoData`
  if (typeof sessionWithRelays.onRelayData === 'function') {
    const origOnRelayData = sessionWithRelays.onRelayData;
    sessionWithRelays.onRelayData = function patchedOnRelayData(
      this: typeof sessionWithRelays,
      data: Uint8Array
    ) {
      if (data && data.length >= 12 && (data[0] & 0xc0) === 0x80) {
        const pt = data[1] & 0x7f;
        if (
          pt >= 96 &&
          pt <= 127 &&
          pt !== 97 &&
          pt !== 111 &&
          pt !== 120 &&
          typeof this.onRelayVideoData === 'function'
        ) {
          this.onRelayVideoData(data);
          return;
        }
      }
      return origOnRelayData.call(this, data);
    };
  }

  if (typeof session.handleCallAck === 'function') {
    const origHandleCallAck = session.handleCallAck;
    session.handleCallAck = async function patchedHandleCallAck(
      this: InstrumentedMediaSession,
      node: unknown
    ) {
      const res = await origHandleCallAck.call(this, node);
      syncSessionVideoSsrcWithDeviceJid(this);
      return res;
    };
  }

  if (typeof session.cleanup === 'function') {
    const origCleanup = session.cleanup;
    session.cleanup = function patchedCleanup(this: InstrumentedMediaSession) {
      this.__botezzDisposed = true;
      activeCallMediaSessions.delete(this);
      if (this.__mediaStartDelayTimers) {
        for (const t of this.__mediaStartDelayTimers) {
          clearTimeout(t);
        }
        this.__mediaStartDelayTimers.clear();
      }
      if (this.info?.stateData && typeof this.info.stateData === 'object') {
        this.info.stateData.state = 'ended';
      }
      if (this.audioEngine && typeof this.audioEngine === 'object') {
        instrumentAudioEngineInstance(
          this.audioEngine as unknown as InstrumentedAudioEngine
        );
      }
      if (this.videoEngine && typeof this.videoEngine === 'object') {
        instrumentVideoEngineInstance(
          this.videoEngine as unknown as InstrumentedVideoEngine
        );
      }
      return origCleanup.apply(this);
    };
  }

  if (typeof session.startMediaFlow === 'function') {
    const origStartMediaFlow = session.startMediaFlow;
    session.startMediaFlow = function patchedStartMediaFlow(
      this: InstrumentedMediaSession
    ) {
      if (
        this.__botezzDisposed ||
        this.info?.isEnded === true ||
        this.info?.stateData?.state === 'ended'
      ) {
        return;
      }
      wrapSctpRelayOnSession(this);
      syncSessionVideoSsrcWithDeviceJid(this);
      if (this.audioEngine && typeof this.audioEngine === 'object') {
        instrumentAudioEngineInstance(
          this.audioEngine as unknown as InstrumentedAudioEngine
        );
      }
      if (this.videoEngine && typeof this.videoEngine === 'object') {
        instrumentVideoEngineInstance(
          this.videoEngine as unknown as InstrumentedVideoEngine
        );
      }
      const res = origStartMediaFlow.apply(this);
      syncSessionVideoSsrcWithDeviceJid(this);
      return res;
    };
  }

  const sessionWithAccept = session as InstrumentedMediaSession & {
    handleCallAccept?: (...args: unknown[]) => Promise<void>;
    acceptedByJid?: string;
    peerJid?: string;
    deps?: {
      lowLevelCoordinator?: {
        sendNode?: (node: unknown) => Promise<unknown>;
      };
    };
    srtpSession?: {
      sendCtx?: {
        sessionKey?: Uint8Array;
        sessionSalt?: Uint8Array;
        authKey?: Uint8Array;
        authTagLen?: number;
      };
      recvCtx?: {
        sessionKey?: Uint8Array;
        sessionSalt?: Uint8Array;
        authKey?: Uint8Array;
        authTagLen?: number;
      };
      protect?: (packet: unknown) => Uint8Array;
      unprotect?: (data: Uint8Array) => unknown;
    } | null;
  };
  if (typeof sessionWithAccept.handleCallAccept === 'function') {
    const origHandleCallAccept = sessionWithAccept.handleCallAccept;
    sessionWithAccept.handleCallAccept = async function patchedHandleCallAccept(
      this: typeof sessionWithAccept,
      ...args: unknown[]
    ) {
      // Snapshot the bot's local outbound SRTP send context before handleCallAccept runs.
      // In WhatsApp VoIP, outbound encryption (`protect`) MUST strictly use the bot's own `localCallKey`
      // (`this.info?.callKey || this.info?.encryptionKey || this.localCallKey`), and NEVER `peerCallKey`!
      const preAcceptLocalSendCtx =
        this.videoSrtpSession?.sendCtx?.sessionKey instanceof Uint8Array
          ? {
              sessionKey: this.videoSrtpSession.sendCtx.sessionKey,
              sessionSalt: this.videoSrtpSession.sendCtx.sessionSalt,
              authKey: this.videoSrtpSession.sendCtx.authKey,
              authTagLen: this.videoSrtpSession.sendCtx.authTagLen ?? 4,
            }
          : this.srtpSession?.sendCtx?.sessionKey instanceof Uint8Array
            ? {
                sessionKey: this.srtpSession.sendCtx.sessionKey,
                sessionSalt: this.srtpSession.sendCtx.sessionSalt,
                authKey: this.srtpSession.sendCtx.authKey,
                authTagLen: this.srtpSession.sendCtx.authTagLen ?? 4,
              }
            : undefined;

      const localCallKey =
        (this.info?.callKey instanceof Uint8Array
          ? this.info.callKey
          : undefined) ||
        (this.info?.encryptionKey instanceof Uint8Array
          ? this.info.encryptionKey
          : undefined) ||
        (this.localCallKey instanceof Uint8Array
          ? this.localCallKey
          : undefined) ||
        (this.__localCallKey instanceof Uint8Array
          ? this.__localCallKey
          : undefined);
      if (localCallKey) {
        this.localCallKey = localCallKey;
        this.__localCallKey = localCallKey;
      }

      const res = await origHandleCallAccept.apply(this, args);

      // Extract peerCallKey (from accept node or session property) and store it strictly on `this.__peerCallKey`
      // for `VoipCallRecorder` inbound decryption (`unprotect`). NEVER put `peerCallKey` into `videoSrtpSession.sendCtx`!
      const acceptArgObj =
        args[0] && typeof args[0] === 'object'
          ? (args[0] as { peerCallKey?: unknown })
          : undefined;
      const detectedPeerKey =
        (acceptArgObj?.peerCallKey instanceof Uint8Array
          ? acceptArgObj.peerCallKey
          : undefined) ||
        (this.peerCallKey instanceof Uint8Array ? this.peerCallKey : undefined) ||
        (this.__peerCallKey instanceof Uint8Array
          ? this.__peerCallKey
          : undefined);
      if (detectedPeerKey) {
        this.__peerCallKey = detectedPeerKey;
      }
      if (localCallKey) {
        this.__localCallKey = localCallKey;
      }

      // Outbound sendCtx MUST come from our local call key (`preAcceptLocalSendCtx` or `this.srtpSession.sendCtx`
      // when derived from `ourCallKey`), and NEVER from `this.srtpSession.recvCtx` (`peerCallKey`).
      const postAcceptSend = this.srtpSession?.sendCtx;
      const primaryRecv = this.srtpSession?.recvCtx;

      // Guard: if `postAcceptSend` accidentally matches `primaryRecv` (e.g., if a caller overwrote `srtpSession`
      // with `peerCallKey`), restore `preAcceptLocalSendCtx` as the outbound `localSend`.
      const postSendMatchesPeerRecv =
        postAcceptSend?.sessionKey instanceof Uint8Array &&
        primaryRecv?.sessionKey instanceof Uint8Array &&
        postAcceptSend.sessionKey.length === primaryRecv.sessionKey.length &&
        postAcceptSend.sessionKey.every((b, idx) => b === primaryRecv.sessionKey![idx]);

      const localOutboundSend =
        postSendMatchesPeerRecv && preAcceptLocalSendCtx
          ? preAcceptLocalSendCtx
          : postAcceptSend?.sessionKey instanceof Uint8Array
            ? postAcceptSend
            : preAcceptLocalSendCtx;

      if (primaryRecv?.sessionKey instanceof Uint8Array) {
        this.__peerRecvCtx = {
          sessionKey: primaryRecv.sessionKey,
          sessionSalt: primaryRecv.sessionSalt,
          authKey: primaryRecv.authKey,
          authTagLen: primaryRecv.authTagLen ?? 4,
        };
      }

      // Always ensure `this.videoSrtpSession` is a DEDICATED SrtpSession instance separate from `this.srtpSession`
      // so audio and video sequence numbers never collide in `SrtpContext.updateRoc(seq)`.
      if (
        (!this.videoSrtpSession ||
          (this.videoSrtpSession as unknown) === (this.srtpSession as unknown)) &&
        this.srtpSession &&
        localOutboundSend
      ) {
        const srtpCtor = (
          this.srtpSession as unknown as {
            constructor?: new (...cArgs: unknown[]) => unknown;
          }
        ).constructor;
        const ctxCtor = (
          localOutboundSend as unknown as {
            constructor?: new (...cArgs: unknown[]) => unknown;
          }
        ).constructor;
        if (
          typeof srtpCtor === 'function' &&
          srtpCtor !== Object &&
          typeof ctxCtor === 'function'
        ) {
          try {
            const dummyKeying = {
              masterKey: new Uint8Array(16),
              masterSalt: new Uint8Array(14),
            };
            const clonedSession = new srtpCtor(
              dummyKeying,
              dummyKeying,
              localOutboundSend.authTagLen ?? 4,
              primaryRecv?.authTagLen ?? 4
            ) as {
              sendCtx?: Record<string, unknown>;
              recvCtx?: Record<string, unknown>;
              protect?: (pkt: unknown) => Uint8Array;
            };
            if (clonedSession.sendCtx && clonedSession.recvCtx) {
              clonedSession.sendCtx.sessionKey = localOutboundSend.sessionKey;
              clonedSession.sendCtx.sessionSalt = localOutboundSend.sessionSalt;
              clonedSession.sendCtx.authKey = localOutboundSend.authKey;
              if (primaryRecv) {
                clonedSession.recvCtx.sessionKey = primaryRecv.sessionKey;
                clonedSession.recvCtx.sessionSalt = primaryRecv.sessionSalt;
                clonedSession.recvCtx.authKey = primaryRecv.authKey;
              }
              this.videoSrtpSession = clonedSession as NonNullable<
                typeof this.videoSrtpSession
              >;
            }
          } catch {
            // Fall through to object fallback below
          }
        }
        if (
          !this.videoSrtpSession ||
          (this.videoSrtpSession as unknown) === (this.srtpSession as unknown)
        ) {
          this.videoSrtpSession = {
            sendCtx: { ...localOutboundSend },
            recvCtx: primaryRecv ? { ...primaryRecv } : { ...localOutboundSend },
            protect:
              typeof this.srtpSession.protect === 'function'
                ? this.srtpSession.protect.bind(this.srtpSession)
                : (pkt: unknown) => pkt as Uint8Array,
          } as unknown as NonNullable<typeof this.videoSrtpSession>;
        }
      }

      syncReceiveOnlySrtpOnMediaSession(this);
      const videoSessionObj = this.videoSrtpSession as
        | {
            sendCtx?: {
              sessionKey?: Uint8Array;
              sessionSalt?: Uint8Array;
              authKey?: Uint8Array;
            };
            recvCtx?: {
              sessionKey?: Uint8Array;
              sessionSalt?: Uint8Array;
              authKey?: Uint8Array;
            };
          }
        | null
        | undefined;
      if (
        localOutboundSend &&
        videoSessionObj?.sendCtx &&
        localOutboundSend.sessionKey instanceof Uint8Array &&
        localOutboundSend.sessionSalt instanceof Uint8Array &&
        localOutboundSend.authKey instanceof Uint8Array
      ) {
        videoSessionObj.sendCtx.sessionKey = localOutboundSend.sessionKey;
        videoSessionObj.sendCtx.sessionSalt = localOutboundSend.sessionSalt;
        videoSessionObj.sendCtx.authKey = localOutboundSend.authKey;
      }
      if (
        primaryRecv &&
        videoSessionObj?.recvCtx &&
        primaryRecv.sessionKey instanceof Uint8Array &&
        primaryRecv.sessionSalt instanceof Uint8Array &&
        primaryRecv.authKey instanceof Uint8Array
      ) {
        videoSessionObj.recvCtx.sessionKey = primaryRecv.sessionKey;
        videoSessionObj.recvCtx.sessionSalt = primaryRecv.sessionSalt;
        videoSessionObj.recvCtx.authKey = primaryRecv.authKey;
      }

      // Send relay sender subscriptions for the peer's audio + video SSRCs so the TURN/SFU relay
      // forwards the recipient's camera H.264 stream to us.
      try {
        const relayWithSubs = this.sctpRelay as
          | { sendPeerMediaSubscriptions?: () => void }
          | null
          | undefined;
        relayWithSubs?.sendPeerMediaSubscriptions?.();
      } catch {
        // Non-fatal
      }

      // Do NOT send an unsolicited `<call><video state="1" dec="H264"/></call>` stanza here!
      this.videoKeyframeRequired = true;
      if (this.videoEngine && typeof this.videoEngine === 'object') {
        instrumentVideoEngineInstance(this.videoEngine);
        const savedCb =
          this.videoEngine.__botezzSavedOnAccessUnit ??
          this.videoEngine.onAccessUnit;
        if (
          this.videoEngine.running &&
          this.videoEngine.proc &&
          typeof this.videoEngine.stop === 'function' &&
          typeof this.videoEngine.start === 'function'
        ) {
          this.videoEngine.stop({ keepSource: true });
          this.videoEngine.start(savedCb);
        } else {
          this.videoEngine.waitForKeyFrame = true;
          this.videoEngine.waitingForKeyFrame = true;
          if (savedCb) {
            this.videoEngine.onAccessUnit = savedCb;
          }
        }
      }

      return res;
    };
  }

  if (typeof session.sendCapturedAudio === 'function') {
    const origSendAudio = session.sendCapturedAudio;
    session.sendCapturedAudio = function patchedSendCapturedAudio(
      this: InstrumentedMediaSession,
      opusFrame: Buffer | Uint8Array
    ) {
      wrapSctpRelayOnSession(this);
      const beforeAccepted = this.__relayBroadcastAcceptedCount ?? 0;
      const beforeSendCount = this.audioSendCount ?? 0;
      const result = origSendAudio.call(this, opusFrame);
      const afterAccepted = this.__relayBroadcastAcceptedCount ?? 0;
      const afterSendCount = this.audioSendCount ?? 0;

      const hasRelayObject = Boolean(
        this.sctpRelay && typeof this.sctpRelay === 'object'
      );
      const relayAccepted = hasRelayObject
        ? typeof this.sctpRelay?.broadcast === 'function'
          ? afterAccepted > beforeAccepted
          : this.sctpRelay?.hasConnection?.() !== false &&
            afterSendCount > beforeSendCount
        : afterSendCount > beforeSendCount;

      if (relayAccepted) {
        this.acceptedAudioPackets = (this.acceptedAudioPackets ?? 0) + 1;
        this.audioTransportSentCount = this.acceptedAudioPackets;
        this.acceptedAudioOctets =
          (this.acceptedAudioOctets ?? 0) + (opusFrame?.length ?? 0);
      }
      return result;
    };
  }

  const origSendVideo = session.sendCapturedVideoAU;

  const rfc6184SendVideoAccessUnit = function patchedSendVideoAccessUnit(
    this: InstrumentedMediaSession,
    auOrNalus: Uint8Array | Buffer | Array<Buffer | Uint8Array>,
    durationOrIsKeyframe?: number | boolean
  ) {
    wrapSctpRelayOnSession(this);
    syncSessionVideoSsrcWithDeviceJid(this);

    // 1. Legacy mock test path when `auOrNalus` is an Array and no `videoRtpStream` is attached,
    //    AND the caller did not configure RFC 6184 packet capture (`sentVideoRtpPackets`).
    if (
      Array.isArray(auOrNalus) &&
      typeof durationOrIsKeyframe === 'boolean' &&
      !this.videoRtpStream &&
      !this.sentVideoRtpPackets &&
      typeof origSendVideo === 'function' &&
      origSendVideo !== rfc6184SendVideoAccessUnit
    ) {
      const beforeAccepted = this.__relayBroadcastAcceptedCount ?? 0;
      const beforeVideoCount = this.videoSendCount ?? 0;
      const result = origSendVideo.call(
        this,
        auOrNalus,
        durationOrIsKeyframe
      );
      const afterAccepted = this.__relayBroadcastAcceptedCount ?? 0;
      const afterVideoCount = this.videoSendCount ?? 0;
      const packetDelta = Math.max(1, afterVideoCount - beforeVideoCount);

      const hasRelayObject = Boolean(
        this.sctpRelay && typeof this.sctpRelay === 'object'
      );
      const relayAccepted = hasRelayObject
        ? typeof this.sctpRelay?.broadcast === 'function'
          ? afterAccepted > beforeAccepted
          : this.sctpRelay?.hasConnection?.() !== false &&
            afterVideoCount > beforeVideoCount
        : afterVideoCount > beforeVideoCount;

      if (relayAccepted) {
        const acceptedDelta =
          typeof this.sctpRelay?.broadcast === 'function'
            ? Math.max(1, afterAccepted - beforeAccepted)
            : packetDelta;
        this.acceptedVideoPackets =
          (this.acceptedVideoPackets ?? 0) + acceptedDelta;
        this.videoTransportSentCount = this.acceptedVideoPackets;
        const bytes = auOrNalus.reduce((acc, n) => acc + (n?.length ?? 0), 0);
        this.acceptedVideoOctets = (this.acceptedVideoOctets ?? 0) + bytes;
        if (durationOrIsKeyframe) {
          this.acceptedVideoKeyframes = (this.acceptedVideoKeyframes ?? 0) + 1;
          this.videoIdrTransportSentCount = this.acceptedVideoKeyframes;
        }
      }
      return result;
    }

    // 2. Real RFC 6184 H.264 Access Unit RTP packetization path (`P0-A` + `BZ-001`)
    const hasRelay =
      this.sctpRelay && typeof this.sctpRelay.hasConnection === 'function'
        ? this.sctpRelay.hasConnection()
        : true;

    if (
      this.videoRtpStream !== undefined &&
      this.videoSrtpSession !== undefined &&
      (!this.videoRtpStream || !this.videoSrtpSession || !hasRelay)
    ) {
      this.videoDropCount = (this.videoDropCount ?? 0) + 1;
      return;
    }
    if (!hasRelay) {
      this.videoDropCount = (this.videoDropCount ?? 0) + 1;
      return;
    }

    // Extract constituent NALUs from the Access Unit
    let rawNalus: Uint8Array[] = [];
    if (Array.isArray(auOrNalus)) {
      for (const item of auOrNalus) {
        const view = new Uint8Array(
          item.buffer,
          item.byteOffset,
          item.byteLength
        );
        const split = splitAnnexBNalus(view);
        if (split.length > 0) {
          rawNalus.push(...split);
        } else if (view.length > 0) {
          rawNalus.push(view);
        }
      }
    } else if (auOrNalus) {
      const view = new Uint8Array(
        auOrNalus.buffer,
        auOrNalus.byteOffset,
        auOrNalus.byteLength
      );
      const split = splitAnnexBNalus(view);
      rawNalus = split.length > 0 ? split : view.length > 0 ? [view] : [];
    }

    // Drop AUD (type 9), EOS (10), EOStream (11), Filler (12) — never transmit AUD over RTP
    const filteredNalus = rawNalus.filter((n) => {
      if (!n || n.length === 0) return false;
      const t = n[0] & 0x1f;
      return t !== 9 && t !== 10 && t !== 11 && t !== 12;
    });

    if (filteredNalus.length === 0) {
      return;
    }

    // Update cached SPS (7), PPS (8), and IDR (5) on the session
    for (const n of filteredNalus) {
      const t = n[0] & 0x1f;
      if (t === 7) {
        this._cachedSpsNalu = n.slice();
      } else if (t === 8) {
        this._cachedPpsNalu = n.slice();
      } else if (t === 5) {
        this._cachedIdrNalu = n.slice();
      }
    }
    if (!this._cachedSpsNalu && this.videoEngine?._cachedSpsNalu) {
      this._cachedSpsNalu = this.videoEngine._cachedSpsNalu.slice();
    }
    if (!this._cachedPpsNalu && this.videoEngine?._cachedPpsNalu) {
      this._cachedPpsNalu = this.videoEngine._cachedPpsNalu.slice();
    }

    const hasVcl = filteredNalus.some((n) => {
      const t = n[0] & 0x1f;
      return t >= 1 && t <= 5;
    });

    // If a caller passed standalone non-VCL NALUs (SPS=7, PPS=8, SEI=6) without a VCL slice,
    // buffer them so they are sent together with the next VCL slice under the exact same timestamp
    // and with RTP Marker M = 0 (`P0-A`).
    if (!hasVcl) {
      this._pendingNonVclNalus ??= [];
      this._pendingNonVclNalus.push(...filteredNalus);
      return;
    }

    let frameNalus = this._pendingNonVclNalus?.length
      ? [...this._pendingNonVclNalus.splice(0), ...filteredNalus]
      : [...filteredNalus];

    const isIdr = frameNalus.some((n) => (n[0] & 0x1f) === 5);

    // Guarantee In-Band SPS (7) + PPS (8) before every IDR (5) NALU under the exact same 90kHz timestamp
    if (isIdr) {
      const hasSpsInFrame = frameNalus.some((n) => (n[0] & 0x1f) === 7);
      const hasPpsInFrame = frameNalus.some((n) => (n[0] & 0x1f) === 8);
      const prependHeaders: Uint8Array[] = [];
      if (!hasSpsInFrame && this._cachedSpsNalu) {
        prependHeaders.push(this._cachedSpsNalu);
      }
      if (!hasPpsInFrame && this._cachedPpsNalu) {
        prependHeaders.push(this._cachedPpsNalu);
      }
      if (prependHeaders.length > 0) {
        frameNalus = [...prependHeaders, ...frameNalus];
      }
    }

    const flushesBefore =
      typeof this.sctpRelay?.getVideoFlushCount === 'function'
        ? this.sctpRelay.getVideoFlushCount()
        : 0;
    if (
      this.videoFlushSeen !== undefined &&
      flushesBefore !== this.videoFlushSeen
    ) {
      this.videoFlushSeen = flushesBefore;
      this.videoKeyframeRequired = true;
    }
    if (this.videoKeyframeRequired && !isIdr) {
      return;
    }

    const fps = this.videoEngine?.frameRate || 15;
    const durationMs =
      typeof durationOrIsKeyframe === 'number' && durationOrIsKeyframe > 0
        ? durationOrIsKeyframe
        : 1000 / fps;
    const tsStep = Math.round((durationMs * 90000) / 1000) || Math.round(90000 / fps);

    if (this.videoTimestamp === undefined) {
      this.videoTimestamp = this.videoRtpStream?.timestamp ?? 0;
    }
    const frameTimestamp = this.videoTimestamp >>> 0;

    if (this.videoRtpStream) {
      this.videoRtpStream.setTimestampStride?.(tsStep);
      this.videoRtpStream.timestamp = frameTimestamp;
      this.videoRtpStream.firstPacket = true;
    }

    // Packetize each NALU individually (never concatenating SPS+PPS+IDR into a single FU-A!)
    const framePackets: Array<{
      payload: Uint8Array;
      naluType: number;
      isVclNalu: boolean;
    }> = [];

    for (const nalu of frameNalus) {
      const naluType = nalu[0] & 0x1f;
      if (naluType === 6) {
        // Drop SEI (6) from wire RTP or keep M=0 if needed; dropping SEI saves SCTP bandwidth
        continue;
      }
      const isVclNalu = naluType === 1 || naluType === 5;
      const chunks = packageH264SingleOrFuA(nalu);
      for (const chunk of chunks) {
        framePackets.push({
          payload: chunk,
          naluType,
          isVclNalu,
        });
      }
    }

    if (framePackets.length === 0) {
      return;
    }

    let lastVclPacketIdx = -1;
    for (let i = framePackets.length - 1; i >= 0; i--) {
      if (framePackets[i].isVclNalu) {
        lastVclPacketIdx = i;
        break;
      }
    }

    const mediaFrameInfo = isIdr ? 0x08 : 0x20;
    let frameAcceptedPackets = 0;
    let frameAcceptedBytes = 0;

    for (let i = 0; i < framePackets.length; i++) {
      const pkt = framePackets[i];
      // Marker M = 1 ONLY on the final packet/fragment of the final VCL NALU (type 1 or 5),
      // and ALWAYS M = 0 on SPS (7), PPS (8), SEI (6), and non-final fragments (`P0-A`).
      const isMarker = i === lastVclPacketIdx && pkt.isVclNalu;

      let accepted = true;
      let seqNum = i;

      if (
        this.videoRtpStream &&
        typeof this.videoRtpStream.nextPacket === 'function' &&
        this.videoSrtpSession
      ) {
        this.videoRtpStream.timestamp = frameTimestamp;
        const header = this.videoRtpStream.nextPacket(
          isMarker,
          mediaFrameInfo
        );
        header.timestamp = frameTimestamp;
        header.marker = isMarker;
        seqNum = header.sequenceNumber;

        // Encode RTP packet (header + payload) and protect with SRTP
        const rawRtpSize = header.size() + pkt.payload.length;
        const rawRtpBuf = new Uint8Array(rawRtpSize);
        const hdrLen = header.encode(rawRtpBuf);
        rawRtpBuf.set(pkt.payload, hdrLen);

        const rtpPacketLike = {
          header,
          payload: pkt.payload,
          size: () => rawRtpSize,
          encode: () => rawRtpBuf,
        };
        const srtpData = this.videoSrtpSession.protect(rtpPacketLike);
        const srtpBytes = new Uint8Array(
          srtpData.buffer,
          srtpData.byteOffset,
          srtpData.byteLength
        );
        if (typeof this.sctpRelay?.broadcast === 'function') {
          accepted = Boolean(this.sctpRelay.broadcast(srtpBytes));
        } else if (
          typeof (this as { sendMediaPayload?: (b: Uint8Array) => void })
            .sendMediaPayload === 'function'
        ) {
          (
            this as unknown as { sendMediaPayload: (b: Uint8Array) => void }
          ).sendMediaPayload(srtpBytes);
        }
      } else if (
        this.videoRtpStream &&
        typeof (this.videoRtpStream as { nextSeq?: () => number }).nextSeq ===
          'function'
      ) {
        seqNum = (
          this.videoRtpStream as unknown as { nextSeq: () => number }
        ).nextSeq();
        const ssrcVal =
          this.videoRtpStream.ssrc ?? this.videoSsrc ?? 0x11223344;
        const rawRtpBuf = buildRtpPacket(
          pkt.payload,
          frameTimestamp,
          seqNum,
          ssrcVal,
          isMarker
        );
        const activeSrtp = (this.videoSrtpSession ?? this.srtpSession) as
          | { protect?: (pkt: unknown) => Uint8Array }
          | null
          | undefined;
        const protectedBuf =
          typeof activeSrtp?.protect === 'function'
            ? activeSrtp.protect(rawRtpBuf)
            : rawRtpBuf;
        const srtpBytes = new Uint8Array(
          protectedBuf.buffer,
          protectedBuf.byteOffset,
          protectedBuf.byteLength
        );
        if (typeof this.sctpRelay?.broadcast === 'function') {
          accepted = Boolean(this.sctpRelay.broadcast(srtpBytes));
        } else if (
          typeof (this as { sendMediaPayload?: (b: Uint8Array) => void })
            .sendMediaPayload === 'function'
        ) {
          (
            this as unknown as { sendMediaPayload: (b: Uint8Array) => void }
          ).sendMediaPayload(srtpBytes);
        }
      } else if (typeof this.sctpRelay?.broadcast === 'function') {
        accepted = Boolean(this.sctpRelay.broadcast(pkt.payload));
      }

      this.sentVideoRtpPackets ??= [];
      this.sentVideoRtpPackets.push({
        sequenceNumber: seqNum,
        timestamp: frameTimestamp,
        marker: isMarker,
        naluType: pkt.naluType,
        payload: pkt.payload,
      });

      if (accepted) {
        frameAcceptedPackets++;
        frameAcceptedBytes += pkt.payload.length;
        this.acceptedVideoPackets = (this.acceptedVideoPackets ?? 0) + 1;
        this.videoTransportSentCount = this.acceptedVideoPackets;
        this.acceptedVideoOctets =
          (this.acceptedVideoOctets ?? 0) + pkt.payload.length;
        this.videoOctetsSent =
          ((this.videoOctetsSent ?? 0) + pkt.payload.length) >>> 0;
      }
    }

    // Advance RTP videoTimestamp ONCE per VCL frame (`P0-A`)
    this.videoTimestamp = (frameTimestamp + tsStep) >>> 0;
    if (this.videoRtpStream) {
      this.videoRtpStream.timestamp = this.videoTimestamp;
    }

    const flushesAfter =
      typeof this.sctpRelay?.getVideoFlushCount === 'function'
        ? this.sctpRelay.getVideoFlushCount()
        : flushesBefore;
    if (flushesAfter !== flushesBefore) {
      this.videoFlushSeen = flushesAfter;
      this.videoKeyframeRequired = true;
    } else if (isIdr && frameAcceptedPackets > 0) {
      this.videoKeyframeRequired = false;
    }

    if (frameAcceptedPackets > 0) {
      this.videoSendCount = (this.videoSendCount ?? 0) + 1;
      if (isIdr) {
        this.videoIdrSendCount = (this.videoIdrSendCount ?? 0) + 1;
        this.acceptedVideoKeyframes = (this.acceptedVideoKeyframes ?? 0) + 1;
        this.videoIdrTransportSentCount = this.acceptedVideoKeyframes;
      }
    }

    void frameAcceptedBytes;
  };

  session.sendCapturedVideoAU = rfc6184SendVideoAccessUnit;
  session.sendVideoAccessUnit = rfc6184SendVideoAccessUnit;

  return session;
}

/**
 * Checks whether a `WaCallMediaSession` has a live relay connection and is not dropping packets.
 */
export function hasVerifiedRelayMediaAcceptance(
  rawSession: WaCallMediaSessionLike | null | undefined
): boolean {
  if (!rawSession || typeof rawSession !== 'object') {
    return true;
  }
  const session = rawSession as InstrumentedMediaSession;
  if (session.sctpRelay && typeof session.sctpRelay === 'object') {
    if (
      typeof session.sctpRelay.hasConnection === 'function' &&
      session.sctpRelay.hasConnection() === false
    ) {
      return false;
    }
    if (
      session.__relayBroadcastAttempted === true &&
      (session.__relayBroadcastAcceptedCount ?? 0) <= 0
    ) {
      return false;
    }
  }
  return true;
}

export function patchWaManualRelayPrototype(
  proto: any,
  stunMod?: {
    buildBindingRequestWithSubs?: (
      username?: Uint8Array,
      hmacKey?: Uint8Array,
      subs?: Uint8Array,
      includePriority?: boolean,
      includeControlled?: boolean,
      transactionId?: Uint8Array
    ) => Uint8Array;
    buildAllocateForRelay?: (
      token: Uint8Array,
      ssrcAttr: Uint8Array,
      key: Uint8Array,
      ip: string,
      port: number,
      transactionId?: Uint8Array,
      options?: {
        relayedAddress?: string;
        extraAttributes?: Array<{ type: number; value: Uint8Array }>;
      }
    ) => Uint8Array;
    createWasmStreamDescriptors?: (ssrcs: number[]) => Uint8Array;
    buildSSRCSubscriptionList?: (
      selfSsrcs: number[],
      peerSsrcs: number[],
      selfPid?: number,
      peerPid?: number
    ) => Uint8Array;
  }
): void {
  if (!proto || typeof proto !== 'object' || proto.__botezzRelayPatched) return;
  proto.__botezzRelayPatched = true;

  proto.setPeerSubscriptionSsrcs = function (ssrcs: number[]) {
    this._peerSubscriptionSsrcs = Array.from(
      new Set((ssrcs || []).map((s) => s >>> 0).filter((s) => s !== 0))
    );
    if (this._peerSubscriptionSsrcs.length > 0 && !this.subscriptionSsrc) {
      this.subscriptionSsrc = this._peerSubscriptionSsrcs[0];
    }
  };

  proto.addPeerSubscriptionSsrc = function (ssrc: number) {
    const clean = ssrc >>> 0;
    if (!clean) return;
    if (!Array.isArray(this._peerSubscriptionSsrcs)) {
      this._peerSubscriptionSsrcs = this.subscriptionSsrc
        ? [this.subscriptionSsrc >>> 0]
        : [];
    }
    if (!this._peerSubscriptionSsrcs.includes(clean)) {
      this._peerSubscriptionSsrcs.push(clean);
      this.resendSubscriptions?.();
    }
  };

  const origSendBindingRegistrations = proto.sendBindingRegistrations;
  if (typeof origSendBindingRegistrations === 'function') {
    proto.sendBindingRegistrations = function (
      conn: any,
      relayInfo: any,
      ssrc: number
    ) {
      origSendBindingRegistrations.call(this, conn, relayInfo, ssrc);
      try {
        const peerList: number[] = Array.isArray(this._peerSubscriptionSsrcs)
          ? [...this._peerSubscriptionSsrcs]
          : [];
        if (ssrc && !peerList.includes(ssrc >>> 0)) {
          peerList.unshift(ssrc >>> 0);
        }
        if (peerList.length <= 1 || !relayInfo?.key) return;

        const buildBindingRequestWithSubs =
          stunMod?.buildBindingRequestWithSubs;
        if (typeof buildBindingRequestWithSubs !== 'function') return;

        const encoder = new TextEncoder();
        const hmacKey = encoder.encode(relayInfo.key);
        const multiSubs = buildMultiSenderSubscriptions(peerList);
        const remoteUfrag = relayInfo.authToken || relayInfo.token;

        const toAb = (u8: Uint8Array) =>
          u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

        if (remoteUfrag) {
          const username = encoder.encode(`${remoteUfrag}:${conn.localUfrag}`);
          this.sendToChannel(
            conn,
            toAb(
              buildBindingRequestWithSubs(
                username,
                hmacKey,
                multiSubs,
                true,
                true,
                undefined
              )
            )
          );
        }
        if (relayInfo.token && relayInfo.token !== remoteUfrag) {
          const username = encoder.encode(
            `${relayInfo.token}:${conn.localUfrag}`
          );
          this.sendToChannel(
            conn,
            toAb(
              buildBindingRequestWithSubs(
                username,
                hmacKey,
                multiSubs,
                true,
                true,
                undefined
              )
            )
          );
        }
        this.sendToChannel(
          conn,
          toAb(
            buildBindingRequestWithSubs(
              undefined,
              undefined,
              multiSubs,
              false,
              false,
              undefined
            )
          )
        );
      } catch {
        // Non-fatal
      }
    };
  }
}

export function patchWaVideoEnginePrototype(proto: any): void {
  if (!proto || typeof proto !== 'object' || proto.__botezzVideoEnginePatched) {
    return;
  }
  proto.__botezzVideoEnginePatched = true;

  // 1. Patch `loadVideoFile` so if `this.nalUnits` is populated (NALU array engine), it extracts
  // `_cachedSps` (NALU 7) and `_cachedPps` (NALU 8), and also initializes `_cachedSps` / `_cachedPps`.
  const origLoadVideoFile = proto.loadVideoFile;
  if (typeof origLoadVideoFile === 'function') {
    proto.loadVideoFile = async function (this: any, filePath: string) {
      await origLoadVideoFile.call(this, filePath);
      this._cachedSps = null;
      this._cachedPps = null;
      if (Array.isArray(this.nalUnits)) {
        for (const nalu of this.nalUnits) {
          if (!nalu || nalu.length === 0) continue;
          const naluType = nalu[0] & 0x1f;
          if (naluType === 7 && !this._cachedSps) {
            this._cachedSps = new Uint8Array(nalu);
          } else if (naluType === 8 && !this._cachedPps) {
            this._cachedPps = new Uint8Array(nalu);
          }
        }
      }
    };
  }

  // 2. Patch `emitAccessUnit` on native `WaVideoEngine` (`@hiroosy/baileys-lite/src/voip/media/WaVideoEngine.js`)
  // so SPS (7) and PPS (8) are cached from Annex-B Access Units and guaranteed to be prepended
  // before every IDR (5) frame even across `-stream_loop -1` wrap-arounds.
  const origEmitAccessUnit = proto.emitAccessUnit;
  if (typeof origEmitAccessUnit === 'function') {
    proto.emitAccessUnit = function (this: any, au: Uint8Array) {
      if (!au || au.length === 0) return;
      const nalus = splitAnnexBNalus(au);
      let hasSps = false;
      let hasPps = false;
      let hasIdr = false;
      for (const n of nalus) {
        if (!n || n.length === 0) continue;
        const t = n[0] & 0x1f;
        if (t === 7) {
          hasSps = true;
          this._cachedSps = n.slice();
        } else if (t === 8) {
          hasPps = true;
          this._cachedPps = n.slice();
        } else if (t === 5) {
          hasIdr = true;
        }
      }

      let finalAu = au;
      if (hasIdr && (!hasSps || !hasPps) && this._cachedSps && this._cachedPps) {
        const prefixParts: Uint8Array[] = [];
        const sc = new Uint8Array([0, 0, 0, 1]);
        if (!hasSps && this._cachedSps) {
          prefixParts.push(sc, this._cachedSps);
        }
        if (!hasPps && this._cachedPps) {
          prefixParts.push(sc, this._cachedPps);
        }
        if (prefixParts.length > 0) {
          const prefixLen = prefixParts.reduce((s, p) => s + p.length, 0);
          const merged = new Uint8Array(prefixLen + au.length);
          let off = 0;
          for (const p of prefixParts) {
            merged.set(p, off);
            off += p.length;
          }
          merged.set(au, off);
          finalAu = merged;
        }
      }

      return origEmitAccessUnit.call(this, finalAu);
    };
  }

  // 3. Support `startStreaming(onAccessUnit)` / `stopStreaming()` for NALU-array based `WaVideoEngine`
  // so it loops continuously at `this.fps || this.frameRate || 15` fps without stopping after Frame 1.
  proto.startStreaming = function (
    this: any,
    onAccessUnit: (nalus: Uint8Array[], isKeyframe: boolean) => void
  ) {
    this.stopStreaming?.();
    if (!Array.isArray(this.nalUnits) || this.nalUnits.length === 0) {
      return;
    }

    // Extract SPS & PPS if not already cached
    if (!this._cachedSps || !this._cachedPps) {
      for (const nalu of this.nalUnits) {
        if (!nalu || nalu.length === 0) continue;
        const t = nalu[0] & 0x1f;
        if (t === 7 && !this._cachedSps) this._cachedSps = new Uint8Array(nalu);
        if (t === 8 && !this._cachedPps) this._cachedPps = new Uint8Array(nalu);
      }
    }

    this.streaming = true;
    this.currentIndex = 0;
    const fps =
      typeof this.fps === 'number' && this.fps > 0
        ? this.fps
        : typeof this.frameRate === 'number' && this.frameRate > 0
          ? this.frameRate
          : 15;
    const frameIntervalMs = Math.max(20, Math.round(1000 / fps));

    const sendNextFrame = () => {
      if (!this.streaming) return;
      if (!Array.isArray(this.nalUnits) || this.nalUnits.length === 0) {
        this.stopStreaming?.();
        return;
      }

      if (this.currentIndex >= this.nalUnits.length) {
        if (this.videoLoop === false) {
          this.stopStreaming?.();
          return;
        }
        this.currentIndex = 0;
      }

      const accessUnit: Uint8Array[] = [];
      let isKeyframe = false;
      let hasVcl = false;

      while (this.currentIndex < this.nalUnits.length) {
        const nalu: Uint8Array = this.nalUnits[this.currentIndex]!;
        this.currentIndex++;
        if (!nalu || nalu.length === 0) continue;

        const naluType = nalu[0]! & 0x1f;
        if (naluType === 7) {
          this._cachedSps = nalu;
          accessUnit.push(nalu);
          continue;
        }
        if (naluType === 8) {
          this._cachedPps = nalu;
          accessUnit.push(nalu);
          continue;
        }
        if (naluType === 6) {
          accessUnit.push(nalu);
          continue;
        }
        if (naluType === 9) {
          if (hasVcl) break;
          continue;
        }

        if (naluType === 5) {
          isKeyframe = true;
          hasVcl = true;
          const hasSps = accessUnit.some((n) => (n[0]! & 0x1f) === 7);
          const hasPps = accessUnit.some((n) => (n[0]! & 0x1f) === 8);
          if (!hasSps && this._cachedSps) {
            accessUnit.unshift(this._cachedSps);
          }
          if (!hasPps && this._cachedPps) {
            const spsIdx = accessUnit.findIndex((n) => (n[0]! & 0x1f) === 7);
            if (spsIdx >= 0) {
              accessUnit.splice(spsIdx + 1, 0, this._cachedPps);
            } else {
              accessUnit.unshift(this._cachedPps);
            }
          }
          accessUnit.push(nalu);
          break;
        }

        if (naluType >= 1 && naluType <= 4) {
          hasVcl = true;
          accessUnit.push(nalu);
          break;
        }
      }

      if (hasVcl && accessUnit.length > 0) {
        try {
          onAccessUnit(accessUnit, isKeyframe);
        } catch {
          // Do not kill timer on single frame callback error
        }
      }
    };

    sendNextFrame();
    this.timer = setInterval(sendNextFrame, frameIntervalMs);
    this.timer.unref?.();
  };

  proto.stopStreaming = function (this: any) {
    this.streaming = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  };
}

export function patchWaVoipCoordinatorPrototype(proto: any): void {
  if (!proto || typeof proto !== 'object' || proto.__botezzCoordinatorPatched) {
    return;
  }
  proto.__botezzCoordinatorPatched = true;

  const origWireClientEvents = proto.wireClientEvents;
  if (typeof origWireClientEvents === 'function') {
    proto.wireClientEvents = function (this: any, ...args: unknown[]) {
      const res = origWireClientEvents.apply(this, args);
      const mgr = this.manager || this.client;
      if (mgr && !mgr.__botezzInboundVideoWired) {
        mgr.__botezzInboundVideoWired = true;
        mgr.on?.('call_inbound_video', (call: any, au: Uint8Array) => {
          this.emit?.('call_inbound_video', call, au);
          emitGlobalInboundVideo(call?.callId, au);
        });
        mgr.on?.('call_inbound_audio', (call: any, pcm: Float32Array) => {
          this.emit?.('call_inbound_audio', call, pcm);
          emitGlobalInboundAudio(call?.callId, pcm);
        });
        mgr.on?.('call_video_state', (call: any, state: unknown) => {
          this.emit?.('call_video_state', call, state);
        });
      }
      return res;
    };
  }
}

/**
 * Applies runtime patches for `VoipCallRecorder` inbound video/audio capture, multi-key SRTP decryption,
 * multi-SSRC TURN/SFU relay subscriptions, `WaVideoEngine` loop/SPS+PPS continuity, and `<reject>` stanza cleanup.
 */
export async function ensureHiroosyVoipRuntimePatched(): Promise<void> {
  if (patchApplied) return;
  if (patchPromise) {
    await patchPromise;
    return;
  }

  patchPromise = (async () => {
    try {
      const pkgDir = resolveBaileysLitePackageDir();
      if (!pkgDir) return;

      // 0. Patch `WaVideoEngine.prototype` for continuous H.264 looping and SPS/PPS injection before IDR
      const videoEngineCandidateRelPaths = [
        'voip/media/WaVideoEngine.js',
        'lib/voip/media/WaVideoEngine.js',
        'src/voip/media/WaVideoEngine.js',
        'lib/package/voip/media/WaVideoEngine.js',
        'dist/voip/media/WaVideoEngine.js',
      ];
      for (const relPath of videoEngineCandidateRelPaths) {
        const videoEnginePath = path.join(pkgDir, relPath);
        if (!fs.existsSync(videoEnginePath)) continue;
        try {
          const mod = (await import(
            /* webpackIgnore: true */ pathToFileURL(videoEnginePath).href
          )) as {
            WaVideoEngine?: { prototype?: unknown };
          };
          if (mod?.WaVideoEngine?.prototype) {
            patchWaVideoEnginePrototype(mod.WaVideoEngine.prototype);
          }
        } catch {
          // Ignore non-fatal import error
        }
      }

      // 1. Patch `WaVoipCoordinator.prototype` to forward `call_inbound_video`, `call_inbound_audio`, and `call_video_state`
      const coordinatorRelPaths = [
        'voip/WaVoipCoordinator.js',
        'lib/voip/WaVoipCoordinator.js',
        'src/voip/WaVoipCoordinator.js',
        'lib/package/voip/WaVoipCoordinator.js',
        'dist/voip/WaVoipCoordinator.js',
      ];
      for (const relPath of coordinatorRelPaths) {
        const coordPath = path.join(pkgDir, relPath);
        if (!fs.existsSync(coordPath)) continue;
        try {
          const mod = (await import(
            /* webpackIgnore: true */ pathToFileURL(coordPath).href
          )) as {
            WaVoipCoordinator?: { prototype?: unknown };
          };
          if (mod?.WaVoipCoordinator?.prototype) {
            patchWaVoipCoordinatorPrototype(mod.WaVoipCoordinator.prototype);
          }
        } catch {
          // Ignore non-fatal import error
        }
      }

      // 2. Patch `WaManualRelay.prototype` to subscribe to all peer audio + video SSRCs (`0x4000` + `0x4024`)
      const relayRelPaths = [
        {
          relay: 'voip/relay/WaManualRelay.js',
          stun: 'voip/relay/stun.js',
        },
        {
          relay: 'lib/voip/relay/WaManualRelay.js',
          stun: 'lib/voip/relay/stun.js',
        },
        {
          relay: 'src/voip/relay/WaManualRelay.js',
          stun: 'src/voip/relay/stun.js',
        },
        {
          relay: 'lib/package/voip/relay/WaManualRelay.js',
          stun: 'lib/package/voip/relay/stun.js',
        },
        {
          relay: 'dist/voip/relay/WaManualRelay.js',
          stun: 'dist/voip/relay/stun.js',
        },
      ];
      for (const pair of relayRelPaths) {
        const relayPath = path.join(pkgDir, pair.relay);
        const stunPath = path.join(pkgDir, pair.stun);
        if (!fs.existsSync(relayPath)) continue;
        try {
          const relayMod = (await import(
            /* webpackIgnore: true */ pathToFileURL(relayPath).href
          )) as {
            WaManualRelay?: { prototype?: unknown };
          };
          const stunMod = fs.existsSync(stunPath)
            ? ((await import(
                /* webpackIgnore: true */ pathToFileURL(stunPath).href
              )) as Record<string, any>)
            : undefined;
          if (relayMod?.WaManualRelay?.prototype) {
            patchWaManualRelayPrototype(
              relayMod.WaManualRelay.prototype,
              stunMod
            );
          }
        } catch {
          // Ignore non-fatal import error
        }
      }

      // 3. Patch `WaCallMediaSession.prototype` with Multi-Key SRTP Video Unprotector,
      // Multi-SSRC peer video subscriptions, Proactive SRTCP PLI, and SmartH264Assembler.
      const mediaSessionCandidateRelPaths = [
        'voip/call/WaCallMediaSession.js',
        'lib/voip/call/WaCallMediaSession.js',
        'src/voip/call/WaCallMediaSession.js',
        'lib/package/voip/call/WaCallMediaSession.js',
        'dist/voip/call/WaCallMediaSession.js',
      ];
      for (const relPath of mediaSessionCandidateRelPaths) {
        const mediaSessionPath = path.join(pkgDir, relPath);
        if (!fs.existsSync(mediaSessionPath)) continue;
        try {
          const mod = (await import(
            /* webpackIgnore: true */ pathToFileURL(mediaSessionPath).href
          )) as {
            WaCallMediaSession?: {
              prototype?: InstrumentedMediaSession;
            };
          };
          const sessionProto = mod?.WaCallMediaSession?.prototype;
          if (sessionProto) {
            attachPassiveNativeMediaSessionTaps(sessionProto);
          }
        } catch {
          // Ignore non-fatal import error
        }
      }

      // Clean up calls when a `<reject>` stanza arrives (`P0-B` + `BZ-021`),
      // sync receive-only SRTP on `WaCallManager.prototype.handleCallAccept`,
      // and harden `syncDeviceList` + `ensureSessionsBatch` against empty `@lid` USync responses.
      const callManagerCandidateRelPaths = [
        'voip/call/WaCallManager.js',
        'lib/voip/call/WaCallManager.js',
        'src/voip/call/WaCallManager.js',
        'lib/package/voip/call/WaCallManager.js',
        'dist/voip/call/WaCallManager.js',
      ];
      for (const relPath of callManagerCandidateRelPaths) {
        const callManagerPath = path.join(pkgDir, relPath);
        if (!fs.existsSync(callManagerPath)) continue;
        const mod = (await import(
          /* webpackIgnore: true */ pathToFileURL(callManagerPath).href
        )) as {
          WaCallManager?: {
            prototype?: {
              __botezzCallManagerPatched?: boolean;
              calls?: Map<string, InstrumentedMediaSession>;
              mediaSession?: InstrumentedMediaSession;
              callMediaSession?: InstrumentedMediaSession;
              deps?: {
                __botezzDepsHardened?: boolean;
                signalDeviceSync?: {
                  syncDeviceList?: (
                    jids: string[]
                  ) => Promise<Array<{ deviceJids: string[] }>>;
                  queryLidsByPhoneJids?: (
                    jids: string[]
                  ) => Promise<Array<{ lidJid?: string }>>;
                };
                sessionResolver?: {
                  ensureSessionsBatch?: (
                    devices: string[]
                  ) => Promise<Array<{ address: unknown; session: unknown }>>;
                };
                signalProtocol?: {
                  encryptMessage?: (
                    address: { user: string; server: string; device: number },
                    plaintext: Uint8Array
                  ) => Promise<{ type: string; ciphertext: Uint8Array }>;
                };
              };
              startCall?: (options: {
                peerJid: string;
                isVideo?: boolean;
                audioFile?: string;
                videoConfig?: unknown;
              }) => Promise<string>;
              resolvePeerLid?: (peerJid: string) => Promise<string>;
              resolveSessionFromNode?: (
                node: unknown
              ) => InstrumentedMediaSession | null;
              createSession?: (
                ...args: unknown[]
              ) => InstrumentedMediaSession;
              handleCallAccept?: (...args: unknown[]) => Promise<unknown>;
              handleCallTerminate?: (node: unknown) => Promise<void>;
              handleCallReject?: (node: unknown) => Promise<void>;
              emitState?: (info: unknown) => void;
              emit?: (event: string, ...args: unknown[]) => boolean;
              maybeUnblockWaitingCalls?: () => Promise<void>;
            };
          };
        };
        const proto = mod?.WaCallManager?.prototype;
        if (proto && !proto.__botezzCallManagerPatched) {
          proto.__botezzCallManagerPatched = true;

          if (typeof proto.createSession === 'function') {
            const origCreateSession = proto.createSession;
            proto.createSession = function (
              this: NonNullable<typeof proto>,
              ...args: unknown[]
            ) {
              const session = origCreateSession.apply(this, args);
              if (session) {
                attachPassiveNativeMediaSessionTaps(session);
              }
              return session;
            };
          }

          if (typeof proto.handleCallAccept === 'function') {
            const origManagerAccept = proto.handleCallAccept;
            proto.handleCallAccept = async function passiveManagerAcceptTap(
              this: NonNullable<typeof proto>,
              ...args: unknown[]
            ) {
              const res = await origManagerAccept.apply(this, args);
              try {
                const resolvedSession =
                  this.mediaSession ||
                  this.callMediaSession ||
                  (args[0] ? this.resolveSessionFromNode?.(args[0]) : null);
                if (resolvedSession) {
                  syncReceiveOnlySrtpOnMediaSession(resolvedSession);
                  syncSessionVideoSsrcWithDeviceJid(resolvedSession);
                }
                syncReceiveOnlySrtpOnMediaSession(this as Record<string, unknown>);
              } catch {
                // Non-fatal
              }
              return res;
            };
          }

          const normalizeCallOfferDeviceJids = (
            rawList: string[],
            fallbackTargetJid: string
          ): string[] => {
            const toCanonicalDeviceJid = (input: string): string => {
              const trimmed = String(input || '').trim();
              if (!trimmed) return '';
              const atIdx = trimmed.indexOf('@');
              if (atIdx < 0) {
                const digits = trimmed.replace(/\D/g, '');
                return digits ? `${digits}@s.whatsapp.net` : '';
              }
              const userPart = trimmed.slice(0, atIdx);
              const serverPart = trimmed.slice(atIdx + 1) || 's.whatsapp.net';
              const [userRaw, devRaw] = userPart.split(':');
              const cleanUser = (userRaw || '').split('_')[0] || '';
              if (!cleanUser) return '';
              const devNum =
                devRaw !== undefined && devRaw !== '' ? Number(devRaw) : 0;
              if (!Number.isFinite(devNum) || devNum <= 0) {
                return `${cleanUser}@${serverPart}`;
              }
              return `${cleanUser}:${devNum}@${serverPart}`;
            };

            const seen = new Set<string>();
            const deduped: string[] = [];
            for (const item of rawList) {
              const canonical = toCanonicalDeviceJid(item);
              if (canonical && !seen.has(canonical)) {
                seen.add(canonical);
                deduped.push(canonical);
              }
            }
            if (deduped.length === 0) {
              const fallbackBare = toCanonicalDeviceJid(fallbackTargetJid);
              if (fallbackBare) {
                deduped.push(fallbackBare);
              }
            }
            return deduped.slice(0, 5);
          };

          if (typeof proto.startCall === 'function') {
            const origStartCall = proto.startCall;
            proto.startCall = async function patchedStartCall(
              this: NonNullable<typeof proto>,
              options: {
                peerJid: string;
                isVideo?: boolean;
                audioFile?: string;
                videoConfig?: unknown;
              }
            ) {
              if (this.deps && !this.deps.__botezzDepsHardened) {
                this.deps.__botezzDepsHardened = true;

                const syncObj = this.deps.signalDeviceSync;
                if (syncObj && typeof syncObj.syncDeviceList === 'function') {
                  const origSyncDeviceList = syncObj.syncDeviceList.bind(syncObj);
                  syncObj.syncDeviceList = async (jids: string[]) => {
                    let rawOut: Array<{ deviceJids: string[] }> = [];
                    try {
                      rawOut = await origSyncDeviceList(jids);
                    } catch {
                      rawOut = [];
                    }
                    return jids.map((jid, idx) => {
                      const existing = Array.isArray(rawOut?.[idx]?.deviceJids)
                        ? rawOut[idx]!.deviceJids
                        : [];
                      return {
                        deviceJids: normalizeCallOfferDeviceJids(existing, jid),
                      };
                    });
                  };
                }

                const resolverObj = this.deps.sessionResolver;
                if (
                  resolverObj &&
                  typeof resolverObj.ensureSessionsBatch === 'function'
                ) {
                  const origEnsureBatch =
                    resolverObj.ensureSessionsBatch.bind(resolverObj);
                  resolverObj.ensureSessionsBatch = async (devices: string[]) => {
                    if (Array.isArray(devices) && devices.length > 0) {
                      const normalized = normalizeCallOfferDeviceJids(
                        devices,
                        devices[0]!
                      );
                      devices.splice(0, devices.length, ...normalized);
                    }
                    try {
                      return await origEnsureBatch(devices);
                    } catch (err) {
                      if (Array.isArray(devices) && devices.length > 1) {
                        const primaryOnly = [devices[0]!];
                        devices.splice(0, devices.length, ...primaryOnly);
                        return await origEnsureBatch(devices);
                      }
                      throw err;
                    }
                  };
                }
              }

              return await origStartCall.call(this, options);
            };
          }

          proto.handleCallReject = async function patchedHandleCallReject(
            node: unknown
          ) {
            const session = this.resolveSessionFromNode?.(node);
            if (!session) return;
            try {
              const infoAny = session.info as
                | {
                    callId?: string;
                    applyTransition?: (t: {
                      type: string;
                      reason: string;
                    }) => void;
                  }
                | undefined;
              infoAny?.applyTransition?.({
                type: 'terminated',
                reason: 'declined',
              });
            } catch {
              // Ignore transition error
            }
            this.emit?.('call_ended', session.info);
            this.emitState?.(session.info);
            session.cleanup?.();
            if (session.info?.callId) {
              this.calls?.delete(session.info.callId);
            }
            await this.maybeUnblockWaitingCalls?.();
          };
        }
      }

      patchApplied = true;
    } catch {
      // Ignore optional runtime tap errors
    }
  })();

  await patchPromise;
}

export function applyVoipRuntimePatches(): void {
  void ensureHiroosyVoipRuntimePatched();
}

/**
 * Calls `await voip.listen()` while snapshotting and tracking any `'connection.update'` listener
 * attached to `rawSocket.ev` by `VoipClient`, returning an explicit cleanup function so
 * `teardownSessionVoipInstance()` / `detachSession()` removes all listeners added by `VoipClient`
 * without disturbing `HiroosyBaileysSessionDriver` listeners (`P0-B` + `BZ-022`).
 */
export async function listenWithTrackedSocketCleanup(
  voip: { listen(): Promise<unknown> },
  rawSocket?: {
    ev?: {
      on?: (event: string, listener: (...args: any[]) => void) => unknown;
      off?: (event: string, listener: (...args: any[]) => void) => unknown;
      listeners?: (event: string) => ReadonlyArray<unknown>;
    };
  } | null
): Promise<() => void> {
  const capturedListeners: Array<{
    event: string;
    listener: (...args: any[]) => void;
  }> = [];

  const ev = rawSocket?.ev;
  const origOn = ev && typeof ev.on === 'function' ? ev.on : undefined;
  const beforeConnListeners =
    ev && typeof ev.listeners === 'function'
      ? new Set(ev.listeners('connection.update'))
      : null;

  if (ev && origOn) {
    ev.on = function trackedEvOn(
      this: unknown,
      event: string,
      listener: (...args: any[]) => void
    ) {
      if (typeof listener === 'function') {
        capturedListeners.push({ event, listener });
      }
      return origOn.call(this, event, listener);
    };
  }

  try {
    await voip.listen();
  } finally {
    if (ev && origOn) {
      ev.on = origOn;
    }
  }

  if (beforeConnListeners && ev && typeof ev.listeners === 'function') {
    for (const fn of ev.listeners('connection.update')) {
      if (!beforeConnListeners.has(fn) && typeof fn === 'function') {
        const listenerFn = fn as (...args: any[]) => void;
        const alreadyTracked = capturedListeners.some(
          (c) => c.event === 'connection.update' && c.listener === listenerFn
        );
        if (!alreadyTracked) {
          capturedListeners.push({
            event: 'connection.update',
            listener: listenerFn,
          });
        }
      }
    }
  }

  return () => {
    if (!ev || typeof ev.off !== 'function') return;
    for (const item of capturedListeners) {
      try {
        ev.off(item.event, item.listener);
      } catch {
        // Ignore listener removal errors
      }
    }
    capturedListeners.length = 0;
  };
}
