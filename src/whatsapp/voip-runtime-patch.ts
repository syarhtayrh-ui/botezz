import { spawn, type ChildProcess } from 'node:child_process';
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
  accessUnitsSent: number;
  videoPath: string | null;
  waitingForKeyFrame: boolean;
  sourceKind: 'file' | 'blank' | null;
  videoLoop?: boolean;
  _deliberateStop?: boolean;
  _restartWindowStartedAt?: number;
  _restartCount?: number;
  lastGeneratedFfmpegArgs?: string[];
  onVideoCompleted?: () => void;
  onEncoderFatalError?: (err: Error) => void;
  start?: () => void;
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
  _pendingNonVclNalus?: Uint8Array[];
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
    protect: (packet: unknown) => Uint8Array;
  } | null;
  videoEngine?: InstrumentedVideoEngine | null;
  videoDropCount?: number;
  videoFlushSeen?: number;
  videoKeyframeRequired?: boolean;
  info?: {
    callId?: string;
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

function resolveBaileysLitePackageDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve('@hiroosy/baileys-lite/package.json');
    return path.dirname(pkgJsonPath);
  } catch {
    const candidate = path.resolve(
      process.cwd(),
      'node_modules/@hiroosy/baileys-lite'
    );
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    return null;
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
  if (!audioEngine || typeof audioEngine !== 'object' || audioEngine.__botezzAudioPatched) {
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
 * 1. Configures WhatsApp real-time H.264 encoder parameters (`fps=15`, `gop=15`, `280k`/`420k`, `zerolatency`, `sliced-threads=0`, `aud=1`, `repeat-headers=1`).
 * 2. Groups non-VCL NALUs (`AUD=9`, `SEI=6`, `SPS=7`, `PPS=8`) with their VCL slice (`IDR=5` or `Slice=1`) into a single Access Unit per frame.
 * 3. Respects `videoLoop` (`loopVideo`) so non-looping calls finish cleanly after one pass.
 */
export function instrumentVideoEngineInstance(
  videoEngine: InstrumentedVideoEngine | null | undefined
): void {
  if (!videoEngine || typeof videoEngine !== 'object' || videoEngine.__botezzVideoPatched) {
    return;
  }
  videoEngine.__botezzVideoPatched = true;

  // Enforce 15fps real-time cadence for WhatsApp VoIP H.264 decoder stability
  videoEngine.frameRate = 15;
  videoEngine.frameDurationMs = 1000 / 15;

  const origEmitAccessUnit =
    typeof videoEngine.emitAccessUnit === 'function'
      ? videoEngine.emitAccessUnit
      : undefined;

  videoEngine.emitAccessUnit = function patchedEmitAccessUnit(
    this: InstrumentedVideoEngine,
    au: Uint8Array
  ) {
    if (this.waitingForKeyFrame) {
      if (!auHasIdrNalu(au)) {
        return;
      }
      this.waitingForKeyFrame = false;
    }
    this.accessUnitsSent = (this.accessUnitsSent ?? 0) + 1;
    const frameDurMs = this.frameDurationMs || 1000 / (this.frameRate || 15);
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
      'aud=1',
      'repeat-headers=1',
      'annexb=1',
      'sliced-threads=0',
      'scenecut=0',
      'bframes=0',
      `keyint=${gop}`,
      `min-keyint=${gop}`,
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
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-bf',
      '0',
      '-g',
      String(gop),
      '-keyint_min',
      String(gop),
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
        this.start?.();
      }
    });

    return proc;
  };

  videoEngine.start = function patchedVideoStart(this: InstrumentedVideoEngine) {
    this.spawnFfmpeg?.();
  };

  const origStop = videoEngine.stop;
  videoEngine.stop = function patchedVideoStop(
    this: InstrumentedVideoEngine,
    opts?: { keepSource?: boolean }
  ) {
    this._deliberateStop = true;
    this.running = false;
    this._pendingHeaderNalus = [];
    if (typeof origStop === 'function') {
      return origStop.call(this, opts);
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // Ignore kill error
      }
      this.proc = null;
    }
    this.pending = new Uint8Array(0);
  };
}

export function instrumentMediaSessionInstance(
  rawSession: WaCallMediaSessionLike | null | undefined
): InstrumentedMediaSession | undefined {
  if (!rawSession || typeof rawSession !== 'object') {
    return undefined;
  }
  const session = rawSession as InstrumentedMediaSession;
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

  if (session.__botezzInstrumented) {
    return session;
  }
  session.__botezzInstrumented = true;

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
      return origStartMediaFlow.apply(this);
    };
  }

  const sessionWithAccept = session as InstrumentedMediaSession & {
    handleCallAccept?: (node: unknown) => Promise<void>;
    srtpSession?: {
      recvCtx?: {
        sessionKey?: Uint8Array;
        sessionSalt?: Uint8Array;
        authKey?: Uint8Array;
      };
    } | null;
  };
  if (typeof sessionWithAccept.handleCallAccept === 'function') {
    const origHandleCallAccept = sessionWithAccept.handleCallAccept;
    sessionWithAccept.handleCallAccept = async function patchedHandleCallAccept(
      this: typeof sessionWithAccept,
      node: unknown
    ) {
      const res = await origHandleCallAccept.call(this, node);
      const primaryRecv = this.srtpSession?.recvCtx;
      const videoRecv = (
        this.videoSrtpSession as
          | {
              recvCtx?: {
                sessionKey?: Uint8Array;
                sessionSalt?: Uint8Array;
                authKey?: Uint8Array;
              };
            }
          | null
          | undefined
      )?.recvCtx;
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

    const frameNalus = this._pendingNonVclNalus?.length
      ? [...this._pendingNonVclNalus.splice(0), ...filteredNalus]
      : filteredNalus;

    const isIdr = frameNalus.some((n) => (n[0] & 0x1f) === 5);

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
      const isVclNalu = naluType >= 1 && naluType <= 5;
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

      if (this.videoRtpStream && this.videoSrtpSession) {
        this.videoRtpStream.timestamp = frameTimestamp;
        const header = this.videoRtpStream.nextPacket!(
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
 * Applies idempotent prototype-level instrumentation to `@hiroosy/baileys-lite/voip` internal classes
 * (`WaCallMediaSession`, `WaAudioEngine`, `WaVideoEngine`, `WaCallManager`).
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

      const videoEnginePath = path.join(pkgDir, 'src/voip/media/WaVideoEngine.js');
      if (fs.existsSync(videoEnginePath)) {
        const mod = (await import(
          /* webpackIgnore: true */ pathToFileURL(videoEnginePath).href
        )) as {
          WaVideoEngine?: { prototype?: InstrumentedVideoEngine };
        };
        if (mod?.WaVideoEngine?.prototype) {
          instrumentVideoEngineInstance(mod.WaVideoEngine.prototype);
        }
      }

      const audioEnginePath = path.join(pkgDir, 'src/voip/media/WaAudioEngine.js');
      if (fs.existsSync(audioEnginePath)) {
        const mod = (await import(
          /* webpackIgnore: true */ pathToFileURL(audioEnginePath).href
        )) as {
          WaAudioEngine?: { prototype?: InstrumentedAudioEngine };
        };
        if (mod?.WaAudioEngine?.prototype) {
          instrumentAudioEngineInstance(mod.WaAudioEngine.prototype);
        }
      }

      const mediaSessionPath = path.join(
        pkgDir,
        'src/voip/call/WaCallMediaSession.js'
      );
      if (fs.existsSync(mediaSessionPath)) {
        const mod = (await import(
          /* webpackIgnore: true */ pathToFileURL(mediaSessionPath).href
        )) as {
          WaCallMediaSession?: { prototype?: InstrumentedMediaSession };
        };
        if (mod?.WaCallMediaSession?.prototype) {
          instrumentMediaSessionInstance(mod.WaCallMediaSession.prototype);
        }
      }

      // Also patch WaCallManager to properly clean up calls when a `<reject>` stanza arrives (`P0-B` + `BZ-021`)
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
              resolveSessionFromNode?: (node: unknown) => InstrumentedMediaSession | null;
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
                    applyTransition?: (t: { type: string; reason: string }) => void;
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
      // Fall back to instance-level instrumentation if prototype import fails
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
