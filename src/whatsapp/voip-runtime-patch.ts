import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WaCallMediaSessionLike } from '@hiroosy/baileys-lite/voip';

export interface InstrumentedMediaSession extends WaCallMediaSessionLike {
  __botezzInstrumented?: boolean;
  __botezzDisposed?: boolean;
  __relayBroadcastAttempted?: boolean;
  __relayBroadcastAcceptedCount?: number;
  acceptedAudioPackets?: number;
  acceptedAudioOctets?: number;
  acceptedVideoPackets?: number;
  acceptedVideoOctets?: number;
  acceptedVideoKeyframes?: number;
  sctpRelay?: {
    hasConnection?: () => boolean;
    broadcast?: (packet: Buffer | Uint8Array) => boolean;
    __botezzBroadcastWrapped?: boolean;
    [key: string]: unknown;
  } | null;
  info?: {
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
  sendCapturedVideoAU?: (nalus: Array<Buffer | Uint8Array>, isKeyframe: boolean) => void;
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

export function wrapSctpRelayOnSession(session: InstrumentedMediaSession): void {
  const relay = session?.sctpRelay as
    | (NonNullable<InstrumentedMediaSession['sctpRelay']> & {
        __botezzWrappedFn?: (packet: Buffer | Uint8Array) => boolean;
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
    const wrappedFn = (packet: Buffer | Uint8Array): boolean => {
      session.__relayBroadcastAttempted = true;
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
  defaultTimeoutMs = 20_000
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

  if (session.__botezzInstrumented) {
    return session;
  }
  session.__botezzInstrumented = true;

  if (typeof session.cleanup === 'function') {
    const origCleanup = session.cleanup;
    session.cleanup = function patchedCleanup(this: InstrumentedMediaSession) {
      this.__botezzDisposed = true;
      if (this.info?.stateData && typeof this.info.stateData === 'object') {
        this.info.stateData.state = 'ended';
      }
      if (this.audioEngine && typeof this.audioEngine === 'object') {
        instrumentAudioEngineInstance(
          this.audioEngine as unknown as InstrumentedAudioEngine
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
      return origStartMediaFlow.apply(this);
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
        this.acceptedAudioOctets =
          (this.acceptedAudioOctets ?? 0) + (opusFrame?.length ?? 0);
      }
      return result;
    };
  }

  if (typeof session.sendCapturedVideoAU === 'function') {
    const origSendVideo = session.sendCapturedVideoAU;
    session.sendCapturedVideoAU = function patchedSendCapturedVideoAU(
      this: InstrumentedMediaSession,
      nalus: Array<Buffer | Uint8Array>,
      isKeyframe: boolean
    ) {
      wrapSctpRelayOnSession(this);
      const beforeAccepted = this.__relayBroadcastAcceptedCount ?? 0;
      const beforeVideoCount = this.videoSendCount ?? 0;
      const result = origSendVideo.call(this, nalus, isKeyframe);
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
        const bytes = Array.isArray(nalus)
          ? nalus.reduce((acc, n) => acc + (n?.length ?? 0), 0)
          : 0;
        this.acceptedVideoOctets = (this.acceptedVideoOctets ?? 0) + bytes;
        if (isKeyframe) {
          this.acceptedVideoKeyframes = (this.acceptedVideoKeyframes ?? 0) + 1;
        }
      }
      return result;
    };
  }

  return session;
}

/**
 * Checks whether a `WaCallMediaSession` has a live relay connection and is not dropping packets.
 * When `sctpRelay` is present on the session and `hasConnection()` returns `false`,
 * or when `sctpRelay.broadcast()` was attempted and accepted 0 packets, returns `false`.
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
 * (`WaCallMediaSession`, `WaAudioEngine`).
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

      patchApplied = true;
    } catch {
      // Fall back to instance-level instrumentation if prototype import fails
    }
  })();

  await patchPromise;
}

/**
 * Calls `await voip.listen()` while tracking any `'connection.update'` listener attached
 * to `rawSocket.ev` by `VoipClient`, returning an explicit cleanup function so `detachSession()`
 * removes all listeners from `rawSocket.ev` (`BZ-022`).
 */
export async function listenWithTrackedSocketCleanup(
  voip: { listen(): Promise<unknown> },
  rawSocket?: {
    ev?: {
      on?: (event: string, listener: (...args: any[]) => void) => unknown;
      off?: (event: string, listener: (...args: any[]) => void) => unknown;
    };
  } | null
): Promise<() => void> {
  const capturedListeners: Array<{
    event: string;
    listener: (...args: any[]) => void;
  }> = [];

  const ev = rawSocket?.ev;
  const origOn = ev && typeof ev.on === 'function' ? ev.on : undefined;

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
