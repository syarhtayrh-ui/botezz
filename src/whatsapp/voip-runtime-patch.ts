import { spawn, type ChildProcess } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
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

  const activeDeviceJid = session.selfSsrcJid || session.selfLid;
  if (activeDeviceJid && (session.selfSsrcJid || session.videoSsrc === undefined)) {
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

export function instrumentMediaSessionInstance(
  rawSession: WaCallMediaSessionLike | null | undefined
): InstrumentedMediaSession | undefined {
  if (!rawSession || typeof rawSession !== 'object') {
    return undefined;
  }
  const session = rawSession as InstrumentedMediaSession;

  // For real `@hiroosy/baileys-lite` `WaCallMediaSession` instances, NEVER monkey-patch or override
  // outbound audio/video engines (`WaVideoEngine`, `WaAudioEngine`, `sendCapturedVideoAU`, `videoSrtpSession`).
  // Attach ONLY a 100% passive, read-only inbound tap (`__peerRecvCtx`) for `VoipCallRecorder`.
  const isNativeWaCallMediaSession =
    (session as { constructor?: { name?: string } }).constructor?.name ===
    'WaCallMediaSession';
  if (isNativeWaCallMediaSession) {
    if (Object.prototype.hasOwnProperty.call(session, '__botezzInstrumented')) {
      return session;
    }
    session.__botezzInstrumented = true;
    const nativeWithAccept = session as InstrumentedMediaSession & {
      handleCallAccept?: (...args: unknown[]) => Promise<unknown>;
      srtpSession?: {
        recvCtx?: {
          sessionKey?: Uint8Array;
          sessionSalt?: Uint8Array;
          authKey?: Uint8Array;
          authTagLen?: number;
        };
      } | null;
    };
    if (typeof nativeWithAccept.handleCallAccept === 'function') {
      const origAccept = nativeWithAccept.handleCallAccept;
      nativeWithAccept.handleCallAccept = async function passiveAcceptTap(
        this: typeof nativeWithAccept,
        ...args: unknown[]
      ) {
        const res = await origAccept.apply(this, args);
        try {
          const recv = this.srtpSession?.recvCtx;
          if (recv?.sessionKey instanceof Uint8Array) {
            this.__peerRecvCtx = {
              sessionKey: recv.sessionKey,
              sessionSalt: recv.sessionSalt,
              authKey: recv.authKey,
              authTagLen: recv.authTagLen ?? 4,
            };
          }
        } catch {
          // Passive read-only tap must never throw
        }
        return res;
      };
    }
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

      // Ensure `videoSsrc`, `videoRtpStream.ssrc`, `peerAudioSsrc`, and `peerVideoSsrc` match the resolved device JIDs
      syncSessionVideoSsrcWithDeviceJid(this);

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
          authTagLen: primaryRecv.authTagLen ?? 10,
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
              primaryRecv?.authTagLen ?? 10
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

      // Send `<call><video state="1" dec="H264" device_orientation="0"/></call>` stanza on video call accept
      // so the recipient's WhatsApp client immediately activates its remote video renderer and camera encoder.
      const isVideoCall =
        (this.info as { mediaType?: string } | undefined)?.mediaType ===
          'video' || Boolean(this.videoRtpStream);
      const acceptingPeerJid = this.acceptedByJid || this.peerJid;
      const callId = this.info?.callId || this.callId;
      const callCreator =
        this.info?.callCreator || this.selfSsrcJid || this.selfLid;
      if (
        isVideoCall &&
        acceptingPeerJid &&
        callId &&
        callCreator &&
        typeof this.deps?.lowLevelCoordinator?.sendNode === 'function'
      ) {
        const videoStateStanza = {
          tag: 'call',
          attrs: {
            to: acceptingPeerJid,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          },
          content: [
            {
              tag: 'video',
              attrs: {
                'call-id': callId,
                'call-creator': callCreator,
                state: '1',
                dec: 'H264',
                device_orientation: '0',
              },
            },
          ],
        };
        this.deps.lowLevelCoordinator.sendNode(videoStateStanza).catch(() => {
          // Ignore non-fatal video state stanza error
        });
      }

      // Restart `videoEngine` from the beginning if it was already running mid-stream before accept,
      // so the recipient immediately receives `SPS (7) + PPS (8) + IDR (5)` within the first 100ms!
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

/**
 * Applies ONLY a 100% passive, read-only inbound tap for `VoipCallRecorder` and `<reject>` stanza cleanup.
 * Does NOT monkey-patch `WaVideoEngine`, `WaAudioEngine`, `WaManualRelay`, `PreNegotiatedDataChannel`,
 * or outbound `sendCapturedVideoAU` / `videoSrtpSession` on `@hiroosy/baileys-lite/voip` (`^0.3.7`).
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

      // Passive read-only tap on `WaCallMediaSession.prototype.handleCallAccept` to expose `srtpSession.recvCtx`
      // as `__peerRecvCtx` for `VoipCallRecorder` without mutating any outbound media or SRTP state.
      const mediaSessionPath = path.join(
        pkgDir,
        'src/voip/call/WaCallMediaSession.js'
      );
      if (fs.existsSync(mediaSessionPath)) {
        const mod = (await import(
          /* webpackIgnore: true */ pathToFileURL(mediaSessionPath).href
        )) as {
          WaCallMediaSession?: {
            prototype?: InstrumentedMediaSession & {
              __botezzPassiveTapApplied?: boolean;
              handleCallAccept?: (...args: unknown[]) => Promise<unknown>;
              srtpSession?: {
                recvCtx?: {
                  sessionKey?: Uint8Array;
                  sessionSalt?: Uint8Array;
                  authKey?: Uint8Array;
                  authTagLen?: number;
                };
              } | null;
            };
          };
        };
        const sessionProto = mod?.WaCallMediaSession?.prototype;
        if (
          sessionProto &&
          !sessionProto.__botezzPassiveTapApplied &&
          typeof sessionProto.handleCallAccept === 'function'
        ) {
          sessionProto.__botezzPassiveTapApplied = true;
          const origHandleCallAccept = sessionProto.handleCallAccept;
          sessionProto.handleCallAccept =
            async function passiveHandleCallAcceptTap(
              this: NonNullable<typeof sessionProto>,
              ...args: unknown[]
            ) {
              const res = await origHandleCallAccept.apply(this, args);
              try {
                const recv = this.srtpSession?.recvCtx;
                if (recv?.sessionKey instanceof Uint8Array) {
                  this.__peerRecvCtx = {
                    sessionKey: recv.sessionKey,
                    sessionSalt: recv.sessionSalt,
                    authKey: recv.authKey,
                    authTagLen: recv.authTagLen ?? 4,
                  };
                }
              } catch {
                // Passive read-only tap must never throw
              }
              return res;
            };
        }
      }

      // Clean up calls when a `<reject>` stanza arrives (`P0-B` + `BZ-021`)
      const callManagerPath = path.join(
        pkgDir,
        'src/voip/call/WaCallManager.js'
      );
      if (fs.existsSync(callManagerPath)) {
        const mod = (await import(
          /* webpackIgnore: true */ pathToFileURL(callManagerPath).href
        )) as {
          WaCallManager?: {
            prototype?: {
              __botezzCallManagerPatched?: boolean;
              calls?: Map<string, InstrumentedMediaSession>;
              resolveSessionFromNode?: (
                node: unknown
              ) => InstrumentedMediaSession | null;
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
