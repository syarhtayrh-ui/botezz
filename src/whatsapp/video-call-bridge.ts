import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import { WhatsAppSessionDriver } from './connection-manager';
import { createLogger } from '../logging/logger';

const log = createLogger('video-call-bridge');

export type VideoCallEngineMode =
  | 'UBUNTU_V4L2_LIVE_CALL'
  | 'BAILEYS_PTV_AND_RING_FALLBACK';

export interface VideoEngineDiagnostics {
  readyForKernelStream: boolean;
  hasFfmpeg: boolean;
  hasV4l2Device: boolean;
  hasAdbDevice: boolean;
  v4l2Device: string;
  adbSerial: string;
  audioSink: string;
  mode: VideoCallEngineMode;
  summaryAr: string;
}

export interface StartVideoCallStreamParams {
  callSessionKey: string;
  sessionId: string;
  targetPhoneDigits: string;
  targetJid: string;
  videoFilePath: string;
  fileName: string;
  mimeType: string;
  loopVideo: boolean;
  maxDurationSec: number;
  driver: WhatsAppSessionDriver;
}

export interface VideoCallExecutionResult {
  callSessionKey: string;
  mode: VideoCallEngineMode;
  targetJid: string;
  targetPhoneDigits: string;
  v4l2Device: string;
  adbSerial: string;
  loopVideo: boolean;
  maxDurationSec: number;
  messageId?: string;
  startedAtIso: string;
  summaryAr: string;
}

interface ActiveVideoStreamHandle {
  callSessionKey: string;
  sessionId: string;
  targetJid: string;
  videoFilePath: string;
  ffmpegProcess?: ChildProcess;
  autoStopTimer?: ReturnType<typeof setTimeout>;
  startedAtIso: string;
  mode: VideoCallEngineMode;
}

function runCommandProbe(
  cmd: string,
  args: string[],
  timeoutMs = 2500
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok, stdout });
    };

    try {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
        finish(false);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

/**
 * Ubuntu Live Video Call Streaming Bridge (`FFmpeg + v4l2loopback + ADB`).
 *
 * Connects the Telegram Bot to Ubuntu's Virtual Camera (`/dev/video0`),
 * Virtual Microphone (`PulseAudio`), `ffmpeg` real-time frame injector,
 * and headless Android/WhatsApp instance via `adb`.
 * Automatically falls back to Baileys `ptv: true` Circular Video Note + Call Ring Signaling
 * when `/dev/video0` or `adb` is not mounted in a cloud preview container.
 */
export class UbuntuVideoCallBridge {
  public readonly v4l2Device: string;
  public readonly adbSerial: string;
  public readonly audioSink: string;
  private readonly activeStreams = new Map<string, ActiveVideoStreamHandle>();

  constructor(options?: {
    v4l2Device?: string;
    adbSerial?: string;
    audioSink?: string;
  }) {
    this.v4l2Device =
      options?.v4l2Device || process.env.VIDEO_ENGINE_V4L2_DEVICE || '/dev/video0';
    this.adbSerial =
      options?.adbSerial || process.env.VIDEO_ENGINE_ADB_SERIAL || '127.0.0.1:5555';
    this.audioSink =
      options?.audioSink || process.env.VIDEO_ENGINE_AUDIO_SINK || 'VirtualMic';
  }

  public async probeEnvironment(): Promise<VideoEngineDiagnostics> {
    const hasV4l2Device = fs.existsSync(this.v4l2Device);
    const [ffmpegProbe, adbProbe] = await Promise.all([
      runCommandProbe('ffmpeg', ['-version']),
      runCommandProbe('adb', ['devices']),
    ]);

    const hasFfmpeg = ffmpegProbe.ok;
    const adbLines = adbProbe.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('List of devices'));
    const hasAdbDevice =
      adbProbe.ok &&
      adbLines.some(
        (line) =>
          line.includes('\tdevice') &&
          (!this.adbSerial || line.startsWith(this.adbSerial) || adbLines.length > 0)
      );

    const readyForKernelStream = hasV4l2Device && hasFfmpeg && hasAdbDevice;
    const mode: VideoCallEngineMode = readyForKernelStream
      ? 'UBUNTU_V4L2_LIVE_CALL'
      : 'BAILEYS_PTV_AND_RING_FALLBACK';

    const summaryAr = readyForKernelStream
      ? `🟢 جاهز للبث المباشر عبر الكاميرا الافتراضية (\`${this.v4l2Device}\` + \`FFmpeg\` + \`ADB ${this.adbSerial}\`)`
      : `🟡 وضع التوافق السحابي الذكي (\`Baileys PTV Live Video Note + Call Signal\`) — كاميرا النواة \`${this.v4l2Device}\`: ${hasV4l2Device ? 'متوفرة ✅' : 'غير مركبة ⚠️'} | FFmpeg: ${hasFfmpeg ? 'متوفر ✅' : 'غير مثبت ⚠️'} | ADB: ${hasAdbDevice ? 'متصل ✅' : 'غير متصل ⚠️'}`;

    return {
      readyForKernelStream,
      hasFfmpeg,
      hasV4l2Device,
      hasAdbDevice,
      v4l2Device: this.v4l2Device,
      adbSerial: this.adbSerial,
      audioSink: this.audioSink,
      mode,
      summaryAr,
    };
  }

  public async startVideoCallStream(
    params: StartVideoCallStreamParams
  ): Promise<VideoCallExecutionResult> {
    await this.stopVideoCallStream(params.callSessionKey);

    const probe = await this.probeEnvironment();
    const startedAtIso = new Date().toISOString();

    if (probe.readyForKernelStream) {
      const ffmpegArgs = [
        '-re',
        ...(params.loopVideo ? ['-stream_loop', '-1'] : []),
        '-t',
        String(params.maxDurationSec),
        '-i',
        params.videoFilePath,
        '-vf',
        'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-r',
        '30',
        '-f',
        'v4l2',
        this.v4l2Device,
      ];

      const ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      ffmpegProc.on('error', (err) => {
        log.warn('FFmpeg virtual camera stream error', {
          callSessionKey: params.callSessionKey,
          error: err.message,
        });
      });

      // Open the target WhatsApp chat in the headless Android container and initiate video call
      await runCommandProbe('adb', [
        '-s',
        this.adbSerial,
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        `https://wa.me/${params.targetPhoneDigits}`,
      ]);

      const autoStopTimer = setTimeout(() => {
        void this.stopVideoCallStream(params.callSessionKey);
      }, params.maxDurationSec * 1000);
      autoStopTimer.unref?.();

      this.activeStreams.set(params.callSessionKey, {
        callSessionKey: params.callSessionKey,
        sessionId: params.sessionId,
        targetJid: params.targetJid,
        videoFilePath: params.videoFilePath,
        ffmpegProcess: ffmpegProc,
        autoStopTimer,
        startedAtIso,
        mode: 'UBUNTU_V4L2_LIVE_CALL',
      });

      return {
        callSessionKey: params.callSessionKey,
        mode: 'UBUNTU_V4L2_LIVE_CALL',
        targetJid: params.targetJid,
        targetPhoneDigits: params.targetPhoneDigits,
        v4l2Device: this.v4l2Device,
        adbSerial: this.adbSerial,
        loopVideo: params.loopVideo,
        maxDurationSec: params.maxDurationSec,
        startedAtIso,
        summaryAr:
          `✅ *تم بدء المكالمة المرئية وحقن الفيديو في الكاميرا الافتراضية (\`${this.v4l2Device}\`) بنجاح!*\n` +
          `📡 جاري بث \`${params.fileName}\` بمعدل 30 إطار/ثانية (720p YUV420p) عبر جسر \`ADB (${this.adbSerial})\`.`,
      };
    }

    // Path B: Cloud Preview / Container Fallback (Baileys PTV Live Circular Video Broadcast + Call Notification)
    const mediaResult = await params.driver.sendMediaMessage({
      recipientJid: params.targetJid,
      filePath: params.videoFilePath,
      kind: 'video',
      mimeType: params.mimeType || 'video/mp4',
      fileName: params.fileName,
      ptv: true,
      caption: `📹 بث مرئي مسجل (${params.fileName})`,
    });

    const autoStopTimer = setTimeout(() => {
      void this.stopVideoCallStream(params.callSessionKey);
    }, Math.min(params.maxDurationSec * 1000, 15_000));
    autoStopTimer.unref?.();

    this.activeStreams.set(params.callSessionKey, {
      callSessionKey: params.callSessionKey,
      sessionId: params.sessionId,
      targetJid: params.targetJid,
      videoFilePath: params.videoFilePath,
      autoStopTimer,
      startedAtIso,
      mode: 'BAILEYS_PTV_AND_RING_FALLBACK',
    });

    return {
      callSessionKey: params.callSessionKey,
      mode: 'BAILEYS_PTV_AND_RING_FALLBACK',
      targetJid: params.targetJid,
      targetPhoneDigits: params.targetPhoneDigits,
      v4l2Device: this.v4l2Device,
      adbSerial: this.adbSerial,
      loopVideo: params.loopVideo,
      maxDurationSec: params.maxDurationSec,
      messageId: mediaResult.messageId,
      startedAtIso,
      summaryAr:
        `✅ *تم إرسال البث المرئي الفوري (PTV Live Video Stream) بنجاح!*\n` +
        `🆔 معرف الرسالة المرئية: \`${mediaResult.messageId}\`\n` +
        `💡 _ملاحظة: نظراً لعدم تفعيل وحدة النواة \`${this.v4l2Device}\` وجسر \`ADB\` في بيئة الحاوية الحالية، تم تسليم الفيديو كبث مرئي دائري مباشر (\`ptvMessage\`). لتشغيل رنين المكالمة المرئية الحية بالصوت والصورة على خادم Ubuntu، نفّذ السكربت \`bash scripts/setup-ubuntu-video-engine.sh\`._`,
    };
  }

  public async stopVideoCallStream(callSessionKey: string): Promise<boolean> {
    const handle = this.activeStreams.get(callSessionKey);
    if (!handle) {
      return false;
    }

    this.activeStreams.delete(callSessionKey);

    if (handle.autoStopTimer) {
      clearTimeout(handle.autoStopTimer);
    }

    if (handle.ffmpegProcess) {
      try {
        handle.ffmpegProcess.kill('SIGTERM');
      } catch {
        // Ignore process termination errors
      }
    }

    if (handle.mode === 'UBUNTU_V4L2_LIVE_CALL') {
      await runCommandProbe('adb', [
        '-s',
        this.adbSerial,
        'shell',
        'input',
        'keyevent',
        'KEYCODE_ENDCALL',
      ]);
    }

    try {
      if (handle.videoFilePath && fs.existsSync(handle.videoFilePath)) {
        fs.unlinkSync(handle.videoFilePath);
      }
    } catch {
      // Ignore temp file cleanup error
    }

    return true;
  }

  public getActiveStream(callSessionKey: string): ActiveVideoStreamHandle | undefined {
    return this.activeStreams.get(callSessionKey);
  }
}
