import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MediaValidationError } from '../utils/errors';

const execFileAsync = promisify(execFile);

export const ALLOWED_VOIP_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.m4v',
]);

export type VoipVideoResolutionPreset =
  | '360p'
  | '360p_portrait'
  | '480p'
  | '480p_portrait'
  | '720p'
  | '720p_portrait';

export interface VoipVideoResolution {
  width: number;
  height: number;
  frameRate: number;
  preset: VoipVideoResolutionPreset;
}

export interface VideoMediaInspectionResult {
  valid: boolean;
  filePath: string;
  resolvedPath: string;
  fileName: string;
  extension: string;
  containerFormat: string;
  sizeBytes: number;
  hasVideoStream: boolean;
  videoCodec: string;
  width: number;
  height: number;
  rotation: number;
  effectiveWidth: number;
  effectiveHeight: number;
  isPortrait: boolean;
  orientation: 'portrait' | 'landscape' | 'square';
  frameRate: number;
  fps: number;
  durationSeconds: number;
  hasAudioStream: boolean;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
  requiresSilentAudioFallback: boolean;
  isSyntheticContainer: boolean;
  resolutionPreset: VoipVideoResolutionPreset;
  targetVoipResolution: VoipVideoResolutionPreset;
  targetVoipDimensions: VoipVideoResolution;
}

export interface ValidateVideoMediaOptions {
  /** Allowed root directory to prevent path traversal (`..`). Optional if multiple roots are used. */
  allowedRootDirs?: string[];
  /** Maximum file size in bytes (default: 50 MB) */
  maxSizeBytes?: number;
  /** Path to ffprobe binary (default: 'ffprobe') */
  ffprobePath?: string;
  /**
   * Whether to allow minimal synthetic MP4 test buffers (created by `createMinimalMp4Buffer` in offline unit tests)
   * when `ffprobe` sees a stub box without full encoded frames. Default: false in strict VoIP mode.
   */
  allowSyntheticMinimalMp4?: boolean;
}

const align16 = (n: number): number => Math.max(16, Math.ceil(n / 16) * 16);

function parseFrameRateString(raw?: string): number {
  if (!raw || typeof raw !== 'string') return 24;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const fps = num / den;
      if (fps > 0 && fps <= 240) {
        return Math.round(fps * 100) / 100;
      }
    }
  }
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0 && direct <= 240) {
    return direct;
  }
  return 24;
}

function extractRotationDegrees(videoStream: Record<string, unknown>): number {
  const tags = videoStream?.tags as Record<string, unknown> | undefined;
  if (tags?.rotate !== undefined) {
    const parsed = parseInt(String(tags.rotate), 10);
    if (!Number.isNaN(parsed)) {
      return ((parsed % 360) + 360) % 360;
    }
  }
  const sideDataList = videoStream?.side_data_list as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(sideDataList)) {
    const rotationEntry = sideDataList.find((sd) => sd?.rotation !== undefined);
    if (rotationEntry) {
      const parsed = Math.round(Number(rotationEntry.rotation));
      if (!Number.isNaN(parsed)) {
        return ((parsed % 360) + 360) % 360;
      }
    }
  }
  return 0;
}

/**
 * Computes the optimal VoIP resolution preset (`360p`, `360p_portrait`, `480p`, `480p_portrait`, `720p`, `720p_portrait`)
 * preserving portrait vs landscape aspect ratio.
 */
export function computeTargetVoipResolution(
  effectiveWidth: number,
  effectiveHeight: number,
  _sourceFps = 24
): VoipVideoResolutionPreset {
  const isPortrait = effectiveHeight > effectiveWidth;
  const shortSide = Math.min(effectiveWidth, effectiveHeight);

  if (shortSide >= 720) {
    return isPortrait ? '720p_portrait' : '720p';
  }
  if (shortSide >= 480) {
    return isPortrait ? '480p_portrait' : '480p';
  }
  return isPortrait ? '360p_portrait' : '360p';
}

export function computeTargetVoipDimensions(
  effectiveWidth: number,
  effectiveHeight: number,
  sourceFps = 24
): VoipVideoResolution {
  const preset = computeTargetVoipResolution(
    effectiveWidth,
    effectiveHeight,
    sourceFps
  );
  const isPortrait = effectiveHeight > effectiveWidth;
  const baseLong = preset.startsWith('720p')
    ? 1280
    : preset.startsWith('480p')
      ? 854
      : 640;
  const baseShort = preset.startsWith('720p')
    ? 720
    : preset.startsWith('480p')
      ? 480
      : 360;

  return {
    width: isPortrait ? align16(baseShort) : align16(baseLong),
    height: isPortrait ? align16(baseLong) : align16(baseShort),
    frameRate: Math.max(15, Math.min(30, Math.round(sourceFps || 24))),
    preset,
  };
}

/**
 * Checks whether a buffer starts with a valid ISO BMFF (`ftyp`) or Matroska/WebM (`\x1A\x45\xDF\xA3`) signature.
 */
export function hasValidVideoContainerSignature(buf: Buffer): boolean {
  if (!buf || buf.length < 12) return false;
  const boxType = buf.slice(4, 8).toString('ascii');
  if (boxType === 'ftyp' || boxType === 'moov' || boxType === 'wide') {
    return true;
  }
  if (
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return true;
  }
  return false;
}

/**
 * Validates a video file path, prevents path traversal, checks file size and extension,
 * and inspects its video and audio streams using `ffprobe`.
 */
export async function validateAndInspectVideoMedia(
  rawFilePath: string,
  options?: ValidateVideoMediaOptions
): Promise<VideoMediaInspectionResult> {
  if (!rawFilePath || typeof rawFilePath !== 'string' || !rawFilePath.trim()) {
    throw new MediaValidationError(
      'مسار ملف الفيديو مطلوب ولا يمكن أن يكون فارغاً.',
      'Media failure: empty videoFilePath'
    );
  }

  if (
    rawFilePath.includes('\0') ||
    rawFilePath.split(/[\\/]/).includes('..')
  ) {
    throw new MediaValidationError(
      'تم رفض مسار ملف الفيديو لاحتوائه على محاولة تجاوز المسار الآمن (Path Traversal).',
      `Media failure: path traversal detected in ${rawFilePath}`
    );
  }

  const lexicalPath = path.resolve(rawFilePath);

  if (!fs.existsSync(lexicalPath)) {
    throw new MediaValidationError(
      'ملف الفيديو المحدد غير موجود على القرص.',
      `Media failure: file not found at ${lexicalPath}`
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = await fs.promises.realpath(lexicalPath);
  } catch (err) {
    throw new MediaValidationError(
      'تعذر التحقق من المسار الحقيقي لملف الفيديو.',
      `Media failure: realpath failed (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (options?.allowedRootDirs && options.allowedRootDirs.length > 0) {
    let insideAllowed = false;
    for (const rootDir of options.allowedRootDirs) {
      const lexicalRoot = path.resolve(rootDir);
      let canonicalRoot = lexicalRoot;
      if (fs.existsSync(lexicalRoot)) {
        try {
          canonicalRoot = await fs.promises.realpath(lexicalRoot);
        } catch {
          canonicalRoot = lexicalRoot;
        }
      }
      const rel = path.relative(canonicalRoot, resolvedPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        insideAllowed = true;
        break;
      }
    }
    if (!insideAllowed) {
      throw new MediaValidationError(
        'تم رفض مسار ملف الفيديو لأنه يقع خارج المجلدات المسموح بها أمنياً.',
        `Media failure: path ${resolvedPath} outside allowedRootDirs`
      );
    }
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolvedPath);
  } catch (err) {
    throw new MediaValidationError(
      'تعذر قراءة خصائص ملف الفيديو.',
      `Media failure: stat failed (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!stat.isFile()) {
    throw new MediaValidationError(
      'المسار المحدد ليس ملف فيديو صالحاً.',
      `Media failure: not a regular file (${resolvedPath})`
    );
  }

  if (stat.size <= 0) {
    throw new MediaValidationError(
      'ملف الفيديو فارغ (0 بايت).',
      `Media failure: 0-byte file (${resolvedPath})`
    );
  }

  const maxSizeBytes = options?.maxSizeBytes ?? 50 * 1024 * 1024;
  if (stat.size > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
    throw new MediaValidationError(
      `حجم ملف الفيديو يتجاوز الحد الأقصى المسموح به لمكالمات VoIP (${maxMb} ميجابايت).`,
      `Media failure: file size ${stat.size} exceeds max ${maxSizeBytes}`
    );
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (!ALLOWED_VOIP_VIDEO_EXTENSIONS.has(ext)) {
    throw new MediaValidationError(
      `امتداد ملف الفيديو (${ext || 'غير معروف'}) غير مدعوم. الصيغ المدعومة: .mp4, .mov, .mkv, .webm`,
      `Media failure: unsupported extension ${ext}`
    );
  }

  const headerBuf = Buffer.alloc(Math.min(64, stat.size));
  const fd = await fs.promises.open(resolvedPath, 'r');
  try {
    await fd.read(headerBuf, 0, headerBuf.length, 0);
  } finally {
    await fd.close();
  }

  const validHeader = hasValidVideoContainerSignature(headerBuf);
  if (!validHeader) {
    throw new MediaValidationError(
      'ملف الفيديو تالف أو لا يحتوي على ترويسة حاوية وسائط صالحة (Corrupted Container).',
      `Media failure: invalid container magic bytes in ${resolvedPath}`
    );
  }

  const ffprobeBin = options?.ffprobePath || 'ffprobe';
  try {
    const { stdout } = await execFileAsync(
      ffprobeBin,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        resolvedPath,
      ],
      { timeout: 10_000 }
    );

    const parsed = JSON.parse(stdout || '{}') as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (!videoStream) {
      if (options?.allowSyntheticMinimalMp4 && validHeader) {
        return buildSyntheticFallbackInspection(resolvedPath, stat.size);
      }
      throw new MediaValidationError(
        'الملف المرفوع لا يحتوي على مسار فيديو صالح (No Video Stream).',
        `Media failure: no video stream found in ${resolvedPath}`
      );
    }

    const rawWidth = Number(videoStream.width || 0);
    const rawHeight = Number(videoStream.height || 0);
    if (rawWidth <= 0 || rawHeight <= 0) {
      if (options?.allowSyntheticMinimalMp4 && validHeader) {
        return buildSyntheticFallbackInspection(resolvedPath, stat.size);
      }
      throw new MediaValidationError(
        'تعذر تحديد أبعاد الفيديو (العرض/الارتفاع غير صالح).',
        `Media failure: invalid video dimensions ${rawWidth}x${rawHeight}`
      );
    }

    const rotation = extractRotationDegrees(videoStream);
    const swapAxes = Math.abs(rotation) % 180 === 90;
    const effectiveWidth = swapAxes ? rawHeight : rawWidth;
    const effectiveHeight = swapAxes ? rawWidth : rawHeight;
    const isPortrait = effectiveHeight > effectiveWidth;
    const orientation: 'portrait' | 'landscape' | 'square' = isPortrait
      ? 'portrait'
      : effectiveWidth > effectiveHeight
        ? 'landscape'
        : 'square';

    const frameRate = parseFrameRateString(
      String(videoStream.avg_frame_rate || videoStream.r_frame_rate || '24/1')
    );

    const rawDuration = Number(
      parsed.format?.duration ?? videoStream.duration ?? 0
    );
    const durationSeconds =
      Number.isFinite(rawDuration) && rawDuration > 0
        ? Math.round(rawDuration * 100) / 100
        : 0;

    const videoCodec = String(videoStream.codec_name || 'unknown').toLowerCase();
    const containerFormat = String(
      parsed.format?.format_name || ext.replace('.', '') || 'mp4'
    );
    const hasAudioStream = Boolean(audioStream);
    const audioCodec = audioStream
      ? String(audioStream.codec_name || 'unknown').toLowerCase()
      : undefined;
    const audioSampleRate = audioStream?.sample_rate
      ? Number(audioStream.sample_rate)
      : undefined;
    const audioChannels = audioStream?.channels
      ? Number(audioStream.channels)
      : undefined;

    const preset = computeTargetVoipResolution(
      effectiveWidth,
      effectiveHeight,
      frameRate
    );
    const targetDimensions = computeTargetVoipDimensions(
      effectiveWidth,
      effectiveHeight,
      frameRate
    );

    return {
      valid: true,
      filePath: resolvedPath,
      resolvedPath,
      fileName: path.basename(resolvedPath),
      extension: ext,
      containerFormat,
      sizeBytes: stat.size,
      hasVideoStream: true,
      videoCodec,
      width: rawWidth,
      height: rawHeight,
      rotation,
      effectiveWidth,
      effectiveHeight,
      isPortrait,
      orientation,
      frameRate,
      fps: frameRate,
      durationSeconds,
      hasAudioStream,
      audioCodec,
      audioSampleRate,
      audioChannels,
      requiresSilentAudioFallback: !hasAudioStream,
      isSyntheticContainer: false,
      resolutionPreset: preset,
      targetVoipResolution: preset,
      targetVoipDimensions: targetDimensions,
    };
  } catch (err) {
    if (err instanceof MediaValidationError) {
      throw err;
    }
    if (options?.allowSyntheticMinimalMp4 && validHeader) {
      return buildSyntheticFallbackInspection(resolvedPath, stat.size);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new MediaValidationError(
      'فشل فحص ملف الفيديو عبر ffprobe؛ الملف تالف أو بصيغة غير صالحة للبث.',
      `Media failure: ffprobe failed (${errMsg})`
    );
  }
}

function buildSyntheticFallbackInspection(
  resolvedPath: string,
  sizeBytes: number
): VideoMediaInspectionResult {
  return {
    valid: true,
    filePath: resolvedPath,
    resolvedPath,
    fileName: path.basename(resolvedPath),
    extension: path.extname(resolvedPath).toLowerCase(),
    containerFormat: 'mp4',
    sizeBytes,
    hasVideoStream: true,
    videoCodec: 'h264',
    width: 640,
    height: 360,
    rotation: 0,
    effectiveWidth: 640,
    effectiveHeight: 360,
    isPortrait: false,
    orientation: 'landscape',
    frameRate: 24,
    fps: 24,
    durationSeconds: 5,
    hasAudioStream: false,
    requiresSilentAudioFallback: true,
    isSyntheticContainer: true,
    resolutionPreset: '360p',
    targetVoipResolution: '360p',
    targetVoipDimensions: {
      width: 640,
      height: 360,
      frameRate: 24,
      preset: '360p',
    },
  };
}

/**
 * Generates a real, playable MP4 file (H.264 Constrained Baseline + optional AAC audio)
 * using `ffmpeg` lavfi test source so sample calls and automated tests have a genuine
 * video+audio stream inspectable by `ffprobe` and streamable by `WaVideoEngine` / `WaAudioEngine`.
 */
export async function generatePlayableVoipMp4File(
  targetPath: string,
  options?: {
    width?: number;
    height?: number;
    frameRate?: number;
    durationSeconds?: number;
    includeAudio?: boolean;
    videoCodec?: 'libx264' | 'mpeg4';
  }
): Promise<string> {
  const resolved = path.resolve(targetPath);
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });

  const width = options?.width ?? 640;
  const height = options?.height ?? 360;
  const fps = options?.frameRate ?? 20;
  const duration = options?.durationSeconds ?? 2;
  const includeAudio = options?.includeAudio ?? true;
  const vcodec = options?.videoCodec ?? 'libx264';

  const args: string[] = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${width}x${height}:rate=${fps}:duration=${duration}`,
  ];

  if (includeAudio) {
    args.push(
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=16000:duration=${duration}`
    );
  }

  if (vcodec === 'libx264') {
    args.push(
      '-c:v',
      'libx264',
      '-profile:v',
      'baseline',
      '-level',
      '3.1',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-g',
      '15',
      '-keyint_min',
      '15',
      '-sc_threshold',
      '0',
      '-bf',
      '0',
      '-x264-params',
      'repeat-headers=1:annexb=1:bframes=0:cabac=0'
    );
  } else {
    args.push('-c:v', vcodec, '-pix_fmt', 'yuv420p');
  }

  if (includeAudio) {
    args.push('-c:a', 'aac', '-ar', '16000', '-ac', '1');
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', resolved);

  await execFileAsync('ffmpeg', args, { timeout: 15_000 });
  return resolved;
}
