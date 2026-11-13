import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  downloadMediaMessage,
  isJidStatusBroadcast,
  type BinaryNode,
  type WASocket,
} from '../whatsapp/baileys-compat';
import { SettingsRepository } from '../database/repositories/settings-repository';
import { TelegramMediaAttachment } from '../bot/workflows/pairing-workflow';
import { escapeMarkdown } from '../utils/markdown';
import { createLogger } from '../logging/logger';

const log = createLogger('forensic-payload-analyzer');

export type AnalyzerSurfaceFilter =
  | 'ALL'
  | 'PRIVATE_CHAT'
  | 'GROUP'
  | 'STATUS_STORY'
  | 'NEWSLETTER'
  | 'PROTOCOL_STANZA'
  | 'ANOMALIES_ONLY';

export type ForensicSurfaceKind =
  | 'PRIVATE_CHAT'
  | 'GROUP'
  | 'STATUS_STORY'
  | 'NEWSLETTER'
  | 'PROTOCOL_STANZA';

export type RawForensicEventType =
  | 'messages.upsert'
  | 'ws.CB:message'
  | 'ws.CB:iq'
  | 'ws.CB:call'
  | 'ws.CB:notification';

export type SenderOsFingerprint =
  | 'iOS'
  | 'WhatsApp Web / Baileys'
  | 'Android'
  | 'Desktop / Companion';

export type ForensicAnomalyCode =
  | 'UNICODE_CRASH_VECTOR'
  | 'MENTION_ARRAY_BOMB'
  | 'DEEP_WRAPPER_NESTING'
  | 'INVALID_COORDINATES_OR_DIMENSIONS'
  | 'CORRUPTED_MEDIA_HEADER'
  | 'SPOOFED_QUOTED_CONTEXT'
  | 'STAGE2_DISSECTION_FAILURE';

export interface SecurityAnalyzerConfig {
  enabled: boolean;
  targetSessionIds: 'ALL' | string[];
  surfaceFilter: AnalyzerSurfaceFilter;
  autoUploadToTelegram: boolean;
  captureRawBinaryStanzas: boolean;
  captureMediaBuffers: boolean;
  maxMediaCaptureBytes: number; // default 25 * 1024 * 1024 (25 MB)
}

export const DEFAULT_FORENSIC_ANALYZER_CONFIG: SecurityAnalyzerConfig = {
  enabled: false,
  targetSessionIds: 'ALL',
  surfaceFilter: 'ALL',
  autoUploadToTelegram: true,
  captureRawBinaryStanzas: false,
  captureMediaBuffers: true,
  maxMediaCaptureBytes: 25 * 1024 * 1024,
};

export interface SerializedBinaryBuffer {
  __type: 'BinaryBuffer';
  byteLength: number;
  base64: string;
  hexPreview: string;
}

export interface UnicodeForensicMap {
  charLength: number;
  utf8ByteLength: number;
  codepointsHex: string[];
  utf16CodeUnitsHex: string[];
  utf8Hex: string;
  nonPrintableCount: number;
  bidiOverrideCount: number;
  zeroWidthCount: number;
  combiningMarkCount: number;
  loneSurrogateCount: number;
  nullByteCount: number;
}

export interface ForensicAnomalyFlag {
  code: ForensicAnomalyCode;
  severity: 'WARNING' | 'CRITICAL';
  descriptionArabic: string;
  technicalDetail: string;
}

export interface ForensicThreatVerdict {
  isAnomalous: boolean;
  riskLevel: 'CLEAN' | 'SUSPICIOUS' | 'HOSTILE_CRASH_VECTOR';
  verdictSummaryArabic: string;
  anomalies: ForensicAnomalyFlag[];
}

export interface ForensicMediaExtractionResult {
  hasMedia: boolean;
  mediaKind?: string;
  declaredMimeType?: string;
  detectedMagicHeaderHex?: string;
  headerMatchesMimeType?: boolean;
  decryptionSucceeded: boolean;
  encryptedFallbackUsed: boolean;
  savedFilePath?: string;
  savedFileName?: string;
  savedByteLength?: number;
  mediaKeyBase64?: string;
  mediaKeyHex?: string;
  fileSha256Base64?: string;
  fileEncSha256Base64?: string;
  directPath?: string;
  mediaUrl?: string;
  extractionError?: string;
}

export interface ForensicCaptureFiles {
  captureDir: string;
  rawPreProcessJsonPath: string;
  rawPayloadBinPath?: string;
  postProcessForensicsJsonPath?: string;
  rawTextUtf8Path?: string;
  mediaArtifactPath?: string;
  mediaArtifactFileName?: string;
}

export interface ForensicCaptureRecord {
  captureId: string;
  shortId: string;
  sessionId: string;
  capturedAtIso: string;
  rawEventType: RawForensicEventType;
  surface: ForensicSurfaceKind;
  messageId: string;
  remoteJid: string;
  participantJid?: string;
  senderPnJid?: string;
  senderLidJid?: string;
  addressingMode?: string;
  senderOs: SenderOsFingerprint;
  payloadType: string;
  wrapperChain: string[];
  threatVerdict: ForensicThreatVerdict;
  unicodeMap?: UnicodeForensicMap;
  mediaInfo: ForensicMediaExtractionResult;
  preProcessRawBytes: number;
  postProcessBytes: number;
  mediaBytes: number;
  processingError?: string;
  files: ForensicCaptureFiles;
}

export interface CaptureIncomingPayloadInput {
  sessionId: string;
  rawEventType: RawForensicEventType;
  rawBinaryNode?: BinaryNode | Record<string, unknown> | null;
  rawWaMessage?: Record<string, unknown> | null;
  rawBytes?: Buffer | Uint8Array | null;
  sock?: Partial<WASocket> | Record<string, unknown> | null;
  botKnownMessageIds?: Set<string> | { has: (id: string) => boolean } | null;
  botSelfJids?: string[];
  /** Custom media downloader override for deterministic unit testing */
  customMediaDownloader?: (
    rawMsg: Record<string, unknown>
  ) => Promise<Buffer>;
  /** Custom HTTP fetcher override for encrypted media fallback testing */
  customRawMediaFetcher?: (url: string) => Promise<Buffer>;
  /** When true, runs capture even if analyzer.config.enabled is currently false */
  forceCapture?: boolean;
}

const WRAPPER_MESSAGE_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'groupStatusMessageV2',
  'lottieStickerMessage',
  'editedMessage',
  'protocolMessage',
  'deviceSentMessage',
  'associatedChildMessage',
  'botInvokeMessage',
] as const;

const MEDIA_MESSAGE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
  'ptvMessage',
  'lottieStickerMessage',
] as const;

const LOCAL_SECRET_PROPERTY_NAMES = new Set([
  'TELEGRAM_BOT_TOKEN',
  'botToken',
]);

/**
 * Lossless Binary & Malformed-String Serializer (`SafeLosslessSerializer`).
 * - Converts any `Buffer` or `Uint8Array` into `{ __type: "BinaryBuffer", byteLength, base64, hexPreview }`.
 * - Converts `BigInt` or Protobuf `Long` (`{ low, high, unsigned }`) into exact string/number representations.
 * - Preserves malformed UTF-16 surrogates, null bytes (`\u0000`), and BiDi/Zero-Width control characters verbatim.
 * - Redacts ONLY the bot's own local session secrets (`TELEGRAM_BOT_TOKEN`, local `noiseKey.private`, `signedIdentityKey.private`).
 */
export class SafeLosslessSerializer {
  public static formatHexPreview(bytes: Uint8Array, maxBytes = 32): string {
    const slice = bytes.subarray(0, Math.min(bytes.length, maxBytes));
    const hexParts: string[] = [];
    for (let i = 0; i < slice.length; i++) {
      hexParts.push(slice[i].toString(16).padStart(2, '0'));
    }
    const suffix = bytes.length > maxBytes ? ' ...' : '';
    return hexParts.join(' ') + suffix;
  }

  public static serializeBinaryBuffer(
    buf: Buffer | Uint8Array
  ): SerializedBinaryBuffer {
    const nodeBuf = Buffer.isBuffer(buf)
      ? buf
      : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      __type: 'BinaryBuffer',
      byteLength: nodeBuf.byteLength,
      base64: nodeBuf.toString('base64'),
      hexPreview: SafeLosslessSerializer.formatHexPreview(nodeBuf, 32),
    };
  }

  public static isProtobufLong(
    val: unknown
  ): val is { low: number; high: number; unsigned?: boolean } {
    if (!val || typeof val !== 'object') return false;
    const candidate = val as Record<string, unknown>;
    return (
      typeof candidate.low === 'number' &&
      typeof candidate.high === 'number' &&
      Object.keys(candidate).length <= 4
    );
  }

  public static protobufLongToString(val: {
    low: number;
    high: number;
    unsigned?: boolean;
  }): string {
    const low = BigInt(val.low >>> 0);
    const high = BigInt(val.unsigned ? val.high >>> 0 : val.high);
    const combined = (high << BigInt(32)) | low;
    return combined.toString();
  }

  public static toLosslessJsonValue(
    input: unknown,
    options?: {
      botTokenToRedact?: string;
    },
    seen = new WeakSet<object>(),
    currentPath = '$'
  ): unknown {
    if (input === null || input === undefined) {
      return input;
    }
    if (typeof input === 'bigint') {
      return input.toString();
    }
    if (typeof input === 'string') {
      if (
        options?.botTokenToRedact &&
        options.botTokenToRedact.length >= 8 &&
        input.includes(options.botTokenToRedact)
      ) {
        return input.split(options.botTokenToRedact).join('[REDACTED_BOT_TOKEN]');
      }
      return input;
    }
    if (
      typeof input === 'number' ||
      typeof input === 'boolean'
    ) {
      if (typeof input === 'number' && !Number.isFinite(input)) {
        return String(input); // Preserve NaN / Infinity/-Infinity losslessly
      }
      return input;
    }
    if (typeof input === 'function' || typeof input === 'symbol') {
      return String(input);
    }

    if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
      return SafeLosslessSerializer.serializeBinaryBuffer(input);
    }

    if (ArrayBuffer.isView(input)) {
      const view = new Uint8Array(
        input.buffer,
        input.byteOffset,
        input.byteLength
      );
      return SafeLosslessSerializer.serializeBinaryBuffer(view);
    }

    if (input instanceof ArrayBuffer) {
      return SafeLosslessSerializer.serializeBinaryBuffer(new Uint8Array(input));
    }

    if (typeof input === 'object') {
      // Check BufferJSON serialized shape `{ type: 'Buffer', data: [...] }`
      const maybeBufJson = input as { type?: unknown; data?: unknown };
      if (
        maybeBufJson.type === 'Buffer' &&
        Array.isArray(maybeBufJson.data)
      ) {
        return SafeLosslessSerializer.serializeBinaryBuffer(
          Buffer.from(maybeBufJson.data)
        );
      }

      if (SafeLosslessSerializer.isProtobufLong(input)) {
        return SafeLosslessSerializer.protobufLongToString(input);
      }

      if (input instanceof Error) {
        return {
          __type: 'Error',
          name: input.name,
          message: input.message,
          stack: input.stack,
        };
      }

      if (seen.has(input)) {
        return {
          __type: 'CircularReference',
          path: currentPath,
        };
      }
      seen.add(input);

      if (Array.isArray(input)) {
        return input.map((item, idx) =>
          SafeLosslessSerializer.toLosslessJsonValue(
            item,
            options,
            seen,
            `${currentPath}[${idx}]`
          )
        );
      }

      const out: Record<string, unknown> = {};
      let keys: string[] = [];
      try {
        keys = Object.keys(input as Record<string, unknown>);
      } catch {
        return { __type: 'UnenumerableObject' };
      }

      for (const key of keys) {
        if (LOCAL_SECRET_PROPERTY_NAMES.has(key)) {
          out[key] = '[REDACTED_LOCAL_SECRET]';
          continue;
        }
        if (
          key === 'private' &&
          (currentPath.endsWith('.noiseKey') ||
            currentPath.endsWith('.signedIdentityKey'))
        ) {
          out[key] = '[REDACTED_LOCAL_PRIVATE_KEY]';
          continue;
        }
        try {
          const propVal = (input as Record<string, unknown>)[key];
          out[key] = SafeLosslessSerializer.toLosslessJsonValue(
            propVal,
            options,
            seen,
            `${currentPath}.${key}`
          );
        } catch (getterErr) {
          out[key] = {
            __type: 'HostilePropertyGetterError',
            error:
              getterErr instanceof Error
                ? getterErr.message
                : String(getterErr),
          };
        }
      }
      return out;
    }

    return String(input);
  }

  public static stringify(
    input: unknown,
    options?: { botTokenToRedact?: string; space?: number }
  ): string {
    const lossless = SafeLosslessSerializer.toLosslessJsonValue(input, options);
    return JSON.stringify(lossless, null, options?.space ?? 2);
  }

  /**
   * Generates a complete Unicode Codepoint & Byte Map for a potentially hostile string,
   * counting BiDi overrides (`U+202A..U+202E`, `U+2066..U+2069`), Zero-Width characters
   * (`U+200B..U+200F`, `U+FEFF`), combining marks (`U+0300..U+036F`, etc.), null bytes (`\u0000`),
   * and lone UTF-16 surrogates (`0xD800..0xDFFF`).
   */
  public static analyzeUnicodeString(raw: string): UnicodeForensicMap {
    const str = typeof raw === 'string' ? raw : String(raw ?? '');
    const utf8Buf = Buffer.from(str, 'utf8');
    const codepointsHex: string[] = [];
    const utf16CodeUnitsHex: string[] = [];

    let nonPrintableCount = 0;
    let bidiOverrideCount = 0;
    let zeroWidthCount = 0;
    let combiningMarkCount = 0;
    let loneSurrogateCount = 0;
    let nullByteCount = 0;

    for (let i = 0; i < str.length; i++) {
      const cu = str.charCodeAt(i);
      if (utf16CodeUnitsHex.length < 512) {
        utf16CodeUnitsHex.push(
          `0x${cu.toString(16).toUpperCase().padStart(4, '0')}`
        );
      }

      if (cu === 0x0000) {
        nullByteCount++;
        nonPrintableCount++;
      }

      // Check high/low surrogates
      if (cu >= 0xd800 && cu <= 0xdbff) {
        if (i + 1 < str.length) {
          const nextCu = str.charCodeAt(i + 1);
          if (nextCu >= 0xdc00 && nextCu <= 0xdfff) {
            const cp = ((cu - 0xd800) << 10) + (nextCu - 0xdc00) + 0x10000;
            if (codepointsHex.length < 512) {
              codepointsHex.push(
                `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
              );
            }
            if (utf16CodeUnitsHex.length < 512) {
              utf16CodeUnitsHex.push(
                `0x${nextCu.toString(16).toUpperCase().padStart(4, '0')}`
              );
            }
            i++;
            continue;
          }
        }
        // Lone high surrogate
        loneSurrogateCount++;
        nonPrintableCount++;
        if (codepointsHex.length < 512) {
          codepointsHex.push(
            `U+${cu.toString(16).toUpperCase().padStart(4, '0')}(LONE_SURROGATE)`
          );
        }
        continue;
      } else if (cu >= 0xdc00 && cu <= 0xdfff) {
        // Lone low surrogate
        loneSurrogateCount++;
        nonPrintableCount++;
        if (codepointsHex.length < 512) {
          codepointsHex.push(
            `U+${cu.toString(16).toUpperCase().padStart(4, '0')}(LONE_SURROGATE)`
          );
        }
        continue;
      }

      if (codepointsHex.length < 512) {
        codepointsHex.push(
          `U+${cu.toString(16).toUpperCase().padStart(4, '0')}`
        );
      }

      // BiDi Overrides & Isolates: U+202A..U+202E, U+2066..U+2069, U+061C
      if (
        (cu >= 0x202a && cu <= 0x202e) ||
        (cu >= 0x2066 && cu <= 0x2069) ||
        cu === 0x061c
      ) {
        bidiOverrideCount++;
        nonPrintableCount++;
      }

      // Zero-Width characters: U+200B..U+200F, U+2060..U+2064, U+FEFF
      if (
        (cu >= 0x200b && cu <= 0x200f) ||
        (cu >= 0x2060 && cu <= 0x2064) ||
        cu === 0xfeff
      ) {
        zeroWidthCount++;
        nonPrintableCount++;
      }

      // Combining diacritical marks: U+0300..U+036F, U+0483..U+0489, U+1AB0..U+1AFF, U+1DC0..U+1DFF, U+20D0..U+20FF, U+FE20..U+FE2F
      if (
        (cu >= 0x0300 && cu <= 0x036f) ||
        (cu >= 0x0483 && cu <= 0x0489) ||
        (cu >= 0x1ab0 && cu <= 0x1aff) ||
        (cu >= 0x1dc0 && cu <= 0x1dff) ||
        (cu >= 0x20d0 && cu <= 0x20ff) ||
        (cu >= 0xfe20 && cu <= 0xfe2f)
      ) {
        combiningMarkCount++;
      }

      // C0/C1 control characters (excluding \t, \n, \r)
      if (
        (cu > 0x0000 && cu < 0x0020 && cu !== 0x09 && cu !== 0x0a && cu !== 0x0d) ||
        (cu >= 0x007f && cu <= 0x009f)
      ) {
        nonPrintableCount++;
      }
    }

    return {
      charLength: str.length,
      utf8ByteLength: utf8Buf.byteLength,
      codepointsHex,
      utf16CodeUnitsHex,
      utf8Hex: SafeLosslessSerializer.formatHexPreview(utf8Buf, 256),
      nonPrintableCount,
      bidiOverrideCount,
      zeroWidthCount,
      combiningMarkCount,
      loneSurrogateCount,
      nullByteCount,
    };
  }
}

/**
 * Fingerprints the sender's operating system/client from the WhatsApp stanza `key.id`.
 */
export function detectSenderOsFingerprint(messageId: string): SenderOsFingerprint {
  const clean = String(messageId || '').trim();
  if (/^3A[0-9A-F]{18}$/i.test(clean)) {
    return 'iOS';
  }
  if (/^(3EB0|BAE5)/i.test(clean)) {
    return 'WhatsApp Web / Baileys';
  }
  if (/^[0-9A-F]{32}$/i.test(clean)) {
    return 'Android';
  }
  return 'Desktop / Companion';
}

/**
 * Classifies the incoming WhatsApp protocol surface from `remoteJid` and event type.
 */
export function classifyForensicSurface(
  remoteJid: string | undefined | null,
  rawEventType: RawForensicEventType
): ForensicSurfaceKind {
  if (
    rawEventType === 'ws.CB:iq' ||
    rawEventType === 'ws.CB:call' ||
    rawEventType === 'ws.CB:notification'
  ) {
    return 'PROTOCOL_STANZA';
  }
  const jid = String(remoteJid || '').trim();
  if (jid === 'status@broadcast' || isJidStatusBroadcast(jid)) {
    return 'STATUS_STORY';
  }
  if (jid.endsWith('@g.us')) {
    return 'GROUP';
  }
  if (jid.endsWith('@newsletter')) {
    return 'NEWSLETTER';
  }
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
    return 'PRIVATE_CHAT';
  }
  return jid ? 'PRIVATE_CHAT' : 'PROTOCOL_STANZA';
}

/**
 * Inspects a media buffer's magic header against its declared MIME type.
 */
export function verifyMediaContainerHeader(
  buf: Buffer,
  declaredMimeType?: string
): {
  magicHex: string;
  isValid: boolean;
  reason?: string;
} {
  const magicHex = SafeLosslessSerializer.formatHexPreview(buf, 12);
  if (!buf || buf.length < 4) {
    return {
      magicHex,
      isValid: false,
      reason: `حجم ملف الوسائط مقطوع أو صغير جداً (${buf?.length ?? 0} bytes)`,
    };
  }

  const mime = String(declaredMimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) {
    const ok = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    return {
      magicHex,
      isValid: ok,
      reason: ok
        ? undefined
        : `ترويسة JPEG غير مطابقة (المتوقع FF D8 FF، الفعلي: ${magicHex})`,
    };
  }
  if (mime.includes('png')) {
    const ok =
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47;
    return {
      magicHex,
      isValid: ok,
      reason: ok
        ? undefined
        : `ترويسة PNG غير مطابقة (المتوقع 89 50 4E 47، الفعلي: ${magicHex})`,
    };
  }
  if (mime.includes('webp')) {
    const ok =
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP';
    return {
      magicHex,
      isValid: ok,
      reason: ok
        ? undefined
        : `ترويسة WebP غير مطابقة (المتوقع RIFF....WEBP، الفعلي: ${magicHex})`,
    };
  }
  if (mime.includes('mp4') || mime.includes('video/')) {
    const hasFtyp =
      buf.length >= 8 &&
      (buf.subarray(4, 8).toString('ascii') === 'ftyp' ||
        buf.subarray(4, 8).toString('ascii') === 'moov' ||
        buf.subarray(4, 8).toString('ascii') === 'mdat');
    return {
      magicHex,
      isValid: hasFtyp,
      reason: hasFtyp
        ? undefined
        : `ترويسة حاوية الفيديو MP4 تالفة أو لا تحتوي على ذرة ftyp (${magicHex})`,
    };
  }
  if (mime.includes('ogg') || mime.includes('opus')) {
    const ok = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS';
    return {
      magicHex,
      isValid: ok,
      reason: ok
        ? undefined
        : `ترويسة الصوت OggS غير مطابقة (الفعلي: ${magicHex})`,
    };
  }
  if (mime.includes('pdf')) {
    const ok = buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF';
    return {
      magicHex,
      isValid: ok,
      reason: ok
        ? undefined
        : `ترويسة PDF غير مطابقة (الفعلي: ${magicHex})`,
    };
  }

  return { magicHex, isValid: true };
}

function extensionFromMimeOrKind(mimeType?: string, mediaKind?: string): string {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('pdf')) return 'pdf';
  if (mediaKind === 'imageMessage') return 'jpg';
  if (mediaKind === 'videoMessage' || mediaKind === 'ptvMessage') return 'mp4';
  if (mediaKind === 'audioMessage') return 'ogg';
  if (mediaKind === 'stickerMessage' || mediaKind === 'lottieStickerMessage') return 'webp';
  return 'bin';
}

/**
 * Pre-processing sanitizer guard for downstream normalizers (`SessionMemoryStore`,
 * `IncomingMessageReceiver`, `StatusDownloader`).
 * If an incoming message has extreme BiDi overrides (`> 100`), oversized text (`> 65536`),
 * or a mention array bomb (`mentionedJid.length > 500`), this function returns a sanitized
 * shallow/deep copy for downstream consumers so the bot process never hangs or runs out of memory,
 * AFTER Stage 1 has already archived the 100% unmodified original payload!
 */
export function sanitizeIncomingMessageForDownstream(
  rawMessage: Record<string, unknown>
): {
  sanitizedMessage: Record<string, unknown>;
  wasSanitized: boolean;
  reasons: string[];
} {
  if (!rawMessage || typeof rawMessage !== 'object') {
    return { sanitizedMessage: rawMessage, wasSanitized: false, reasons: [] };
  }

  const reasons: string[] = [];
  let wasSanitized = false;

  const sanitizeStringField = (val: string): string => {
    let result = val;
    const uMap = SafeLosslessSerializer.analyzeUnicodeString(result);
    if (uMap.bidiOverrideCount > 100 || uMap.combiningMarkCount > 250) {
      result = result.replace(
        /[\u202A-\u202E\u2066-\u2069\u061C\u0300-\u036F]/g,
        ''
      );
      wasSanitized = true;
      reasons.push(
        `Stripped hostile BiDi/combining crash characters (bidi=${uMap.bidiOverrideCount}, combining=${uMap.combiningMarkCount})`
      );
    }
    if (result.length > 65536) {
      result = `${result.slice(0, 65536)}... [TRUNCATED_BY_SECURITY_GUARD]`;
      wasSanitized = true;
      reasons.push(`Truncated oversized text payload (${val.length} chars)`);
    }
    return result;
  };

  const sanitizeMessageNode = (
    node: Record<string, unknown>,
    depth = 0
  ): Record<string, unknown> => {
    if (!node || typeof node !== 'object' || depth > 10) return node;
    const clone: Record<string, unknown> = { ...node };

    for (const [k, v] of Object.entries(clone)) {
      if (typeof v === 'string' && (k === 'conversation' || k === 'text' || k === 'caption' || k === 'title' || k === 'description')) {
        clone[k] = sanitizeStringField(v);
      } else if (k === 'contextInfo' && v && typeof v === 'object') {
        const ctxClone = { ...(v as Record<string, unknown>) };
        if (
          Array.isArray(ctxClone.mentionedJid) &&
          ctxClone.mentionedJid.length > 500
        ) {
          reasons.push(
            `Truncated Mention Array Bomb (${ctxClone.mentionedJid.length} mentions -> 50)`
          );
          ctxClone.mentionedJid = ctxClone.mentionedJid.slice(0, 50);
          wasSanitized = true;
        }
        clone[k] = ctxClone;
      } else if (
        v &&
        typeof v === 'object' &&
        !Buffer.isBuffer(v) &&
        !(v instanceof Uint8Array) &&
        !Array.isArray(v)
      ) {
        clone[k] = sanitizeMessageNode(v as Record<string, unknown>, depth + 1);
      }
    }
    return clone;
  };

  try {
    if (rawMessage.message && typeof rawMessage.message === 'object') {
      const sanitizedInner = sanitizeMessageNode(
        rawMessage.message as Record<string, unknown>
      );
      if (wasSanitized) {
        return {
          sanitizedMessage: {
            ...rawMessage,
            message: sanitizedInner,
            __sanitizedByForensicGuard: true,
            __sanitizedReasons: reasons,
          },
          wasSanitized: true,
          reasons,
        };
      }
    }
  } catch {
    // Never fail downstream delivery
  }

  return { sanitizedMessage: rawMessage, wasSanitized: false, reasons: [] };
}

/**
 * Forensic Security Payload Analyzer Engine (`ForensicPayloadAnalyzer`).
 * Implements the mandatory 2-Stage Capture Pipeline:
 * - Stage 1: Raw Pre-Processing Capture (`01_raw_pre_process.json` & `01_raw_payload.bin`)
 * - Stage 2: Fault-Tolerant Post-Processing Dissection, OS Fingerprinting, Threat Detection,
 *            and Unmodified / Encrypted Media Extraction (`02_post_process_forensics.json`,
 *            `03_raw_text_utf8.txt`, `04_media_payload_original.<ext>` / `04_raw_encrypted_media.enc`)
 */
export class ForensicPayloadAnalyzer {
  private config: SecurityAnalyzerConfig;
  private readonly settingsRepo?: SettingsRepository;
  private readonly baseForensicsDir: string;
  private readonly botTokenToRedact?: string;
  private readonly capturesRingBuffer: ForensicCaptureRecord[] = [];
  private readonly maxRingBufferSize = 200;
  private captureSeq = 0;

  public onForensicCaptureReady?: (
    record: ForensicCaptureRecord,
    summaryMessageArabic: string,
    documentAttachments: TelegramMediaAttachment[]
  ) => void;

  constructor(options?: {
    settingsRepo?: SettingsRepository;
    tempUploadDir?: string;
    botTokenToRedact?: string;
    initialConfig?: Partial<SecurityAnalyzerConfig>;
  }) {
    this.settingsRepo = options?.settingsRepo;
    this.botTokenToRedact = options?.botTokenToRedact;
    const baseTemp =
      options?.tempUploadDir || path.join(os.tmpdir(), 'botezz_uploads');
    this.baseForensicsDir = path.join(baseTemp, 'security_forensics');
    try {
      fs.mkdirSync(this.baseForensicsDir, { recursive: true, mode: 0o700 });
    } catch {
      // Ignore directory creation errors if already exists
    }

    const persisted = this.settingsRepo?.getSecurityAnalyzerConfig();
    this.config = {
      ...DEFAULT_FORENSIC_ANALYZER_CONFIG,
      ...(persisted || {}),
      ...(options?.initialConfig || {}),
    };
  }

  public getConfig(): SecurityAnalyzerConfig {
    if (this.settingsRepo) {
      const persisted = this.settingsRepo.getSecurityAnalyzerConfig();
      this.config = {
        ...this.config,
        ...persisted,
      };
    }
    return { ...this.config };
  }

  public updateConfig(
    partial: Partial<SecurityAnalyzerConfig>
  ): SecurityAnalyzerConfig {
    this.config = {
      ...this.config,
      ...partial,
    };
    if (this.settingsRepo) {
      this.settingsRepo.updateSecurityAnalyzerConfig(this.config);
    }
    return { ...this.config };
  }

  public isSessionMonitored(sessionId: string): boolean {
    const cfg = this.getConfig();
    if (!cfg.enabled) return false;
    if (cfg.targetSessionIds === 'ALL') return true;
    return Array.isArray(cfg.targetSessionIds) && cfg.targetSessionIds.includes(sessionId);
  }

  public matchesSurfaceFilter(
    record: ForensicCaptureRecord,
    filter: AnalyzerSurfaceFilter = this.getConfig().surfaceFilter
  ): boolean {
    if (filter === 'ALL') return true;
    if (filter === 'ANOMALIES_ONLY') {
      return record.threatVerdict.isAnomalous || Boolean(record.processingError);
    }
    return record.surface === filter;
  }

  public listCaptures(options?: {
    filter?: AnalyzerSurfaceFilter;
    page?: number;
    pageSize?: number;
  }): {
    items: ForensicCaptureRecord[];
    totalItems: number;
    page: number;
    pageSize: number;
    totalPages: number;
  } {
    const filter = options?.filter ?? 'ALL';
    const pageSize = Math.max(1, options?.pageSize ?? 6);
    const filtered = this.capturesRingBuffer.filter((rec) =>
      this.matchesSurfaceFilter(rec, filter)
    );
    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.min(Math.max(1, options?.page ?? 1), totalPages);
    const startIdx = (page - 1) * pageSize;
    const items = filtered.slice(startIdx, startIdx + pageSize);
    return {
      items,
      totalItems,
      page,
      pageSize,
      totalPages,
    };
  }

  public findCaptureById(idOrShortId: string): ForensicCaptureRecord | undefined {
    const clean = String(idOrShortId || '')
      .trim()
      .replace(/^#/, '');
    if (!clean) return undefined;
    return this.capturesRingBuffer.find(
      (r) =>
        r.captureId === clean ||
        r.shortId === clean ||
        r.captureId.endsWith(clean)
    );
  }

  public clearArchive(): number {
    const count = this.capturesRingBuffer.length;
    for (const rec of this.capturesRingBuffer) {
      try {
        if (rec.files.captureDir && fs.existsSync(rec.files.captureDir)) {
          fs.rmSync(rec.files.captureDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup error
      }
    }
    this.capturesRingBuffer.length = 0;
    return count;
  }

  private writeFileAtomicSync(filePath: string, data: Buffer | string): number {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore chmod error on unsupported FS
    }
    return buf.byteLength;
  }

  /**
   * Executes the Two-Stage Forensic Capture Pipeline (`captureIncomingPayload`):
   * - STAGE 1: Synchronous/atomic Raw Pre-Processing Capture (`01_raw_pre_process.json` + `01_raw_payload.bin`).
   *            Guaranteed never to throw or fail even on corrupted/hostile payloads.
   * - STAGE 2: Isolated fault-tolerant Post-Processing Dissection & Media Extraction
   *            (`02_post_process_forensics.json`, `03_raw_text_utf8.txt`, `04_media_payload_original.<ext>`).
   */
  public async captureIncomingPayload(
    input: CaptureIncomingPayloadInput
  ): Promise<ForensicCaptureRecord | null> {
    const cfg = this.getConfig();
    if (!input.forceCapture) {
      if (!cfg.enabled) return null;
      if (
        cfg.targetSessionIds !== 'ALL' &&
        Array.isArray(cfg.targetSessionIds) &&
        !cfg.targetSessionIds.includes(input.sessionId)
      ) {
        return null;
      }
      if (
        input.rawEventType.startsWith('ws.CB:') &&
        !cfg.captureRawBinaryStanzas
      ) {
        return null;
      }
    }

    this.captureSeq = (this.captureSeq + 1) % 1_000_000;
    const randHex = crypto.randomBytes(3).toString('hex');
    const captureId = `fcap_${Date.now()}_${randHex}`;
    const shortId = `${this.captureSeq.toString(36)}${randHex}`;
    const capturedAtIso = new Date().toISOString();

    const captureDir = path.join(this.baseForensicsDir, captureId);
    const rawPreProcessJsonPath = path.join(
      captureDir,
      '01_raw_pre_process.json'
    );
    let rawPayloadBinPath: string | undefined;
    let preProcessRawBytes = 0;

    // =========================================================================
    // STAGE 1: Pre-Processing Raw Capture (Must Never Throw or Fail)
    // =========================================================================
    try {
      fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(captureDir, 0o700);
      } catch {
        // Ignore
      }

      const stage1Envelope = {
        captureId,
        shortId,
        sessionId: input.sessionId,
        capturedAtIso,
        captureStage: 'PRE_PROCESS_RAW' as const,
        rawEventType: input.rawEventType,
        rawBinaryNode: input.rawBinaryNode ?? null,
        rawWaMessage: input.rawWaMessage ?? null,
      };

      const stage1Json = SafeLosslessSerializer.stringify(stage1Envelope, {
        botTokenToRedact: this.botTokenToRedact,
        space: 2,
      });
      preProcessRawBytes = this.writeFileAtomicSync(
        rawPreProcessJsonPath,
        stage1Json
      );

      // Extract any immediate raw binary bytes for 01_raw_payload.bin
      let rawBinCandidate: Buffer | null = null;
      if (input.rawBytes && input.rawBytes.byteLength > 0) {
        rawBinCandidate = Buffer.isBuffer(input.rawBytes)
          ? input.rawBytes
          : Buffer.from(
              input.rawBytes.buffer,
              input.rawBytes.byteOffset,
              input.rawBytes.byteLength
            );
      } else if (
        input.rawBinaryNode &&
        typeof input.rawBinaryNode === 'object' &&
        ((input.rawBinaryNode as BinaryNode).content instanceof Uint8Array ||
          Buffer.isBuffer((input.rawBinaryNode as BinaryNode).content))
      ) {
        const c = (input.rawBinaryNode as BinaryNode).content as Uint8Array;
        rawBinCandidate = Buffer.isBuffer(c)
          ? c
          : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
      }

      if (rawBinCandidate && rawBinCandidate.byteLength > 0) {
        rawPayloadBinPath = path.join(captureDir, '01_raw_payload.bin');
        this.writeFileAtomicSync(rawPayloadBinPath, rawBinCandidate);
      }
    } catch (stage1Err) {
      // Fallback emergency write if anything unexpected occurred
      try {
        fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
        const fallbackJson = JSON.stringify(
          {
            captureId,
            shortId,
            sessionId: input.sessionId,
            capturedAtIso,
            captureStage: 'PRE_PROCESS_RAW',
            rawEventType: input.rawEventType,
            stage1SerializationWarning:
              stage1Err instanceof Error
                ? stage1Err.message
                : String(stage1Err),
          },
          null,
          2
        );
        preProcessRawBytes = this.writeFileAtomicSync(
          rawPreProcessJsonPath,
          fallbackJson
        );
      } catch {
        // Never throw
      }
    }

    // =========================================================================
    // STAGE 2: Fault-Tolerant Post-Processing Dissection & Media Extraction
    // =========================================================================
    let surface: ForensicSurfaceKind = 'PROTOCOL_STANZA';
    let messageId = '';
    let remoteJid = '';
    let participantJid: string | undefined;
    let senderPnJid: string | undefined;
    let senderLidJid: string | undefined;
    let addressingMode: string | undefined;
    let senderOs: SenderOsFingerprint = 'Desktop / Companion';
    let payloadType: string = input.rawEventType;
    const wrapperChain: string[] = [];
    const anomalies: ForensicAnomalyFlag[] = [];
    let unicodeMap: UnicodeForensicMap | undefined;
    let mediaInfo: ForensicMediaExtractionResult = {
      hasMedia: false,
      decryptionSucceeded: false,
      encryptedFallbackUsed: false,
    };
    let postProcessForensicsJsonPath: string | undefined;
    let rawTextUtf8Path: string | undefined;
    let mediaArtifactPath: string | undefined;
    let mediaArtifactFileName: string | undefined;
    let postProcessBytes = 0;
    let mediaBytes = 0;
    let processingError: string | undefined;

    try {
      const rawMsg = input.rawWaMessage as Record<string, unknown> | undefined | null;
      const rawNode = input.rawBinaryNode as BinaryNode | undefined | null;

      // 1. Extract Key & Addressing Headers
      const msgKey = (rawMsg?.key ?? {}) as Record<string, unknown>;
      const rawStanzaMeta = (rawMsg?.__rawStanzaMeta ?? {}) as Record<
        string,
        unknown
      >;
      const nodeAttrs = (rawNode?.attrs ?? {}) as Record<string, string>;

      messageId = String(
        msgKey.id || nodeAttrs.id || `stanza_${shortId}`
      );
      remoteJid = String(
        msgKey.remoteJid || nodeAttrs.from || ''
      );
      participantJid =
        typeof msgKey.participant === 'string' && msgKey.participant
          ? msgKey.participant
          : typeof nodeAttrs.participant === 'string' && nodeAttrs.participant
            ? nodeAttrs.participant
            : undefined;

      addressingMode = String(
        rawStanzaMeta.addressingMode ||
          nodeAttrs.addressing_mode ||
          (remoteJid.endsWith('@lid') || participantJid?.endsWith('@lid')
            ? 'lid'
            : 'pn')
      );

      // Extract PN & LID JIDs across all candidate fields
      const candidateJids = [
        remoteJid,
        participantJid,
        typeof msgKey.remoteJidAlt === 'string' ? msgKey.remoteJidAlt : undefined,
        typeof msgKey.participantAlt === 'string' ? msgKey.participantAlt : undefined,
        typeof rawStanzaMeta.senderPn === 'string' ? rawStanzaMeta.senderPn : undefined,
        typeof rawStanzaMeta.rawFrom === 'string' ? rawStanzaMeta.rawFrom : undefined,
        typeof rawStanzaMeta.rawParticipant === 'string'
          ? rawStanzaMeta.rawParticipant
          : undefined,
        nodeAttrs.sender_pn,
        nodeAttrs.participant_pn,
        nodeAttrs.recipient_pn,
      ].filter((j): j is string => typeof j === 'string' && j.length > 0);

      for (const cj of candidateJids) {
        if (cj.endsWith('@s.whatsapp.net') && !senderPnJid) {
          senderPnJid = cj;
        } else if (cj.endsWith('@lid') && !senderLidJid) {
          senderLidJid = cj;
        }
      }

      surface = classifyForensicSurface(remoteJid, input.rawEventType);
      senderOs = detectSenderOsFingerprint(messageId);

      // Check if payload explicitly triggers a simulated/corrupted dissection error
      if (rawMsg && typeof rawMsg.__simulateCorruptedDissectionThrow === 'function') {
        (rawMsg.__simulateCorruptedDissectionThrow as () => void)();
      }

      // 2. Unwrap Nested Message Wrappers (up to 16 levels)
      let currentMessageContainer =
        rawMsg && typeof rawMsg.message === 'object' && rawMsg.message !== null
          ? (rawMsg.message as Record<string, unknown>)
          : undefined;

      let depth = 0;
      while (currentMessageContainer && depth < 16) {
        let unwrappedNext: Record<string, unknown> | undefined;
        for (const wrapperKey of WRAPPER_MESSAGE_KEYS) {
          const wrapperVal = currentMessageContainer[wrapperKey] as
            | Record<string, unknown>
            | undefined;
          if (wrapperVal && typeof wrapperVal === 'object') {
            wrapperChain.push(wrapperKey);
            const innerMsg =
              (wrapperVal.message as Record<string, unknown> | undefined) ||
              ((
                wrapperVal. futureproofMessage as
                  | { message?: Record<string, unknown> }
                  | undefined
              )?.message);
            if (innerMsg && typeof innerMsg === 'object') {
              unwrappedNext = innerMsg;
            }
            break;
          }
        }
        if (!unwrappedNext) {
          break;
        }
        currentMessageContainer = unwrappedNext;
        depth++;
      }

      if (wrapperChain.length > 5) {
        anomalies.push({
          code: 'DEEP_WRAPPER_NESTING',
          severity: 'CRITICAL',
          descriptionArabic: `تداخل عميق وغير طبيعي لأغلفة الرسالة (${wrapperChain.length} طبقات)`,
          technicalDetail: `Wrapper depth ${wrapperChain.length} > 5: ${wrapperChain.join(' -> ')}`,
        });
      }

      // Determine leaf payloadType & leaf content object
      let leafContentObj: Record<string, unknown> | undefined;
      if (currentMessageContainer) {
        const keys = Object.keys(currentMessageContainer).filter(
          (k) =>
            k !== 'messageContextInfo' &&
            currentMessageContainer![k] !== null &&
            currentMessageContainer![k] !== undefined
        );
        if (keys.length > 0) {
          payloadType = keys[0];
          const candidateLeaf = currentMessageContainer[payloadType];
          if (candidateLeaf && typeof candidateLeaf === 'object') {
            leafContentObj = candidateLeaf as Record<string, unknown>;
          }
        } else if (wrapperChain.length > 0) {
          payloadType = wrapperChain[wrapperChain.length - 1];
        }
      } else if (rawNode?.tag) {
        payloadType = `stanza:${rawNode.tag}`;
      }

      // 3. Extract Raw Text / Caption & Build Unicode Codepoint Map
      const rawTextCandidates: string[] = [];
      if (
        currentMessageContainer &&
        typeof currentMessageContainer.conversation === 'string'
      ) {
        rawTextCandidates.push(currentMessageContainer.conversation);
      }
      if (leafContentObj) {
        for (const textField of [
          'text',
          'caption',
          'title',
          'description',
          'contentText',
          'footerText',
          'name',
        ]) {
          if (typeof leafContentObj[textField] === 'string') {
            rawTextCandidates.push(leafContentObj[textField] as string);
          }
        }
      }

      if (rawTextCandidates.length > 0) {
        const combinedRawText = rawTextCandidates.join('\n');
        unicodeMap = SafeLosslessSerializer.analyzeUnicodeString(combinedRawText);

        // Save exact raw text bytes to 03_raw_text_utf8.txt without trimming or normalizing
        rawTextUtf8Path = path.join(captureDir, '03_raw_text_utf8.txt');
        this.writeFileAtomicSync(
          rawTextUtf8Path,
          Buffer.from(combinedRawText, 'utf8')
        );

        // Check for UNICODE_CRASH_VECTOR
        if (
          unicodeMap.bidiOverrideCount >= 5 ||
          unicodeMap.zeroWidthCount > 200 ||
          unicodeMap.combiningMarkCount >= 25 ||
          unicodeMap.loneSurrogateCount > 0 ||
          unicodeMap.nullByteCount > 0 ||
          unicodeMap.charLength > 65536
        ) {
          anomalies.push({
            code: 'UNICODE_CRASH_VECTOR',
            severity: 'CRITICAL',
            descriptionArabic:
              'حمولة نصية مشوهة أو هجومية (رموز BiDi عكسية / بايتات صفرية / بدائل UTF-16 معطوبة / Virtex)',
            technicalDetail: `bidi=${unicodeMap.bidiOverrideCount}, zeroWidth=${unicodeMap.zeroWidthCount}, combining=${unicodeMap.combiningMarkCount}, loneSurrogates=${unicodeMap.loneSurrogateCount}, nullBytes=${unicodeMap.nullByteCount}, len=${unicodeMap.charLength}`,
          });
        }
      }

      // 4. Inspect ContextInfo (`mentionedJid` Bomb & Spoofed Quoted Message)
      const contextInfo = (leafContentObj?.contextInfo ||
        currentMessageContainer?.contextInfo) as
        | Record<string, unknown>
        | undefined;
      if (contextInfo && typeof contextInfo === 'object') {
        const mentionedJid = contextInfo.mentionedJid;
        if (Array.isArray(mentionedJid) && mentionedJid.length > 100) {
          anomalies.push({
            code: 'MENTION_ARRAY_BOMB',
            severity: 'CRITICAL',
            descriptionArabic: `قنبلة إشارات جماعية (Mention Array Bomb: ${mentionedJid.length} حساب)`,
            technicalDetail: `contextInfo.mentionedJid.length = ${mentionedJid.length} (> 100)`,
          });
        }

        const quotedMessage = contextInfo.quotedMessage;
        const stanzaId =
          typeof contextInfo.stanzaId === 'string' ? contextInfo.stanzaId : '';
        const quotedParticipant =
          typeof contextInfo.participant === 'string'
            ? contextInfo.participant
            : '';

        if (quotedMessage && stanzaId) {
          const selfJids = (input.botSelfJids || []).filter(Boolean);
          const claimsToBeFromBot =
            Boolean(contextInfo.quotedClaimedFromBot) ||
            (quotedParticipant &&
              selfJids.some(
                (sj) =>
                  sj === quotedParticipant ||
                  sj.split('@')[0].split(':')[0] ===
                    quotedParticipant.split('@')[0].split(':')[0]
              ));
          if (
            claimsToBeFromBot &&
            input.botKnownMessageIds &&
            !input.botKnownMessageIds.has(stanzaId)
          ) {
            anomalies.push({
              code: 'SPOOFED_QUOTED_CONTEXT',
              severity: 'WARNING',
              descriptionArabic: `اقتباس مزيف ينتحل رسالة غير موجودة للبوت (stanzaId=${stanzaId})`,
              technicalDetail: `Quoted stanzaId ${stanzaId} claiming participant ${quotedParticipant || 'bot'} not found in session memoryStore`,
            });
          }
        }
      }

      // 5. Inspect Coordinates, Dimensions, and Duration Fields for NaN/Infinity/Extreme Values
      if (leafContentObj) {
        const numericChecks: Array<{
          key: string;
          val: unknown;
          min: number;
          max: number;
        }> = [
          { key: 'width', val: leafContentObj.width, min: 1, max: 65535 },
          { key: 'height', val: leafContentObj.height, min: 1, max: 65535 },
          {
            key: 'degreesLatitude',
            val: leafContentObj.degreesLatitude,
            min: -90,
            max: 90,
          },
          {
            key: 'degreesLongitude',
            val: leafContentObj.degreesLongitude,
            min: -180,
            max: 180,
          },
          {
            key: 'seconds',
            val: leafContentObj.seconds,
            min: 0,
            max: 86400 * 30,
          },
        ];

        for (const chk of numericChecks) {
          if (chk.val !== undefined && chk.val !== null) {
            const num = Number(chk.val);
            if (!Number.isFinite(num) || num < chk.min || num > chk.max) {
              anomalies.push({
                code: 'INVALID_COORDINATES_OR_DIMENSIONS',
                severity: 'CRITICAL',
                descriptionArabic: `قيم أبعاد أو إحداثيات غير صالحة/متطرفة (${chk.key}=${String(chk.val)})`,
                technicalDetail: `Field ${chk.key} has out-of-bounds or non-finite value: ${String(chk.val)}`,
              });
            }
          }
        }
      }

      // 6. Unmodified Media & Corrupted/Encrypted Media Extraction
      const isMediaPayload = (MEDIA_MESSAGE_KEYS as readonly string[]).includes(
        payloadType
      );
      if (isMediaPayload && leafContentObj && cfg.captureMediaBuffers) {
        const declaredMimeType =
          typeof leafContentObj.mimetype === 'string'
            ? leafContentObj.mimetype
            : undefined;
        const directPath =
          typeof leafContentObj.directPath === 'string'
            ? leafContentObj.directPath
            : undefined;
        const mediaUrl =
          typeof leafContentObj.url === 'string'
            ? leafContentObj.url
            : directPath
              ? `https://mmg.whatsapp.net${directPath.startsWith('/') ? '' : '/'}${directPath}`
              : undefined;

        const extractKeyBuf = (val: unknown): Buffer | undefined => {
          if (Buffer.isBuffer(val)) return val;
          if (val instanceof Uint8Array) {
            return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
          }
          if (typeof val === 'string' && val.length > 0) {
            return Buffer.from(val, 'base64');
          }
          return undefined;
        };

        const mediaKeyBuf = extractKeyBuf(leafContentObj.mediaKey);
        const fileSha256Buf = extractKeyBuf(leafContentObj.fileSha256);
        const fileEncSha256Buf = extractKeyBuf(leafContentObj.fileEncSha256);

        mediaInfo = {
          hasMedia: true,
          mediaKind: payloadType,
          declaredMimeType,
          decryptionSucceeded: false,
          encryptedFallbackUsed: false,
          mediaKeyBase64: mediaKeyBuf?.toString('base64'),
          mediaKeyHex: mediaKeyBuf?.toString('hex'),
          fileSha256Base64: fileSha256Buf?.toString('base64'),
          fileEncSha256Base64: fileEncSha256Buf?.toString('base64'),
          directPath,
          mediaUrl,
        };

        let decryptedBuf: Buffer | null = null;
        let downloadErrorMsg: string | undefined;

        // Check if message carries an inline/test media buffer or invoke downloader with 12s timeout
        const inlineMediaCandidate =
          (leafContentObj.__rawMediaBuffer as Buffer | Uint8Array | undefined) ||
          (rawMsg?.__rawMediaBuffer as Buffer | Uint8Array | undefined);

        if (inlineMediaCandidate && inlineMediaCandidate.byteLength > 0) {
          decryptedBuf = Buffer.isBuffer(inlineMediaCandidate)
            ? inlineMediaCandidate
            : Buffer.from(
                inlineMediaCandidate.buffer,
                inlineMediaCandidate.byteOffset,
                inlineMediaCandidate.byteLength
              );
          mediaInfo.decryptionSucceeded = true;
        } else {
          try {
            const downloadWork = async (): Promise<Buffer> => {
              if (input.customMediaDownloader && rawMsg) {
                return await input.customMediaDownloader(rawMsg);
              }
              const downloaded = await downloadMediaMessage(
                rawMsg as never,
                'buffer',
                {}
              );
              return Buffer.isBuffer(downloaded)
                ? downloaded
                : Buffer.from(downloaded as unknown as Uint8Array);
            };

            const timeoutPromise = new Promise<never>((_, reject) => {
              const t = setTimeout(
                () => reject(new Error('Media download timed out after 12000ms')),
                12_000
              );
              t.unref?.();
            });

            decryptedBuf = await Promise.race([downloadWork(), timeoutPromise]);
            if (decryptedBuf && decryptedBuf.byteLength > 0) {
              mediaInfo.decryptionSucceeded = true;
            }
          } catch (dlErr) {
            downloadErrorMsg =
              dlErr instanceof Error ? dlErr.message : String(dlErr);
            mediaInfo.extractionError = downloadErrorMsg;
          }
        }

        if (decryptedBuf && decryptedBuf.byteLength > 0) {
          const cappedBuf =
            decryptedBuf.byteLength > cfg.maxMediaCaptureBytes
              ? decryptedBuf.subarray(0, cfg.maxMediaCaptureBytes)
              : decryptedBuf;

          const ext = extensionFromMimeOrKind(declaredMimeType, payloadType);
          mediaArtifactFileName = `04_media_payload_original.${ext}`;
          mediaArtifactPath = path.join(captureDir, mediaArtifactFileName);
          mediaBytes = this.writeFileAtomicSync(mediaArtifactPath, cappedBuf);
          mediaInfo.savedFilePath = mediaArtifactPath;
          mediaInfo.savedFileName = mediaArtifactFileName;
          mediaInfo.savedByteLength = mediaBytes;

          // Inspect magic header without modifying a single byte of the file
          const headerCheck = verifyMediaContainerHeader(
            cappedBuf,
            declaredMimeType
          );
          mediaInfo.detectedMagicHeaderHex = headerCheck.magicHex;
          mediaInfo.headerMatchesMimeType = headerCheck.isValid;

          if (!headerCheck.isValid) {
            anomalies.push({
              code: 'CORRUPTED_MEDIA_HEADER',
              severity: 'CRITICAL',
              descriptionArabic:
                headerCheck.reason ||
                'ترويسة ملف الوسائط (Magic Bytes) مشوهة أو لا تطابق النوع المعلن',
              technicalDetail: `Declared MIME=${declaredMimeType || 'unknown'}, Magic=${headerCheck.magicHex}`,
            });
          }
        } else {
          // Crucial Fallback for Corrupted / Undecryptable Media:
          // Capture raw encrypted ciphertext bytes (`04_raw_encrypted_media.enc`)
          let rawEncryptedBuf: Buffer | null = null;
          const inlineEncrypted =
            (leafContentObj.__rawEncryptedMediaBuffer as
              | Buffer
              | Uint8Array
              | undefined) ||
            (rawMsg?.__rawEncryptedMediaBuffer as
              | Buffer
              | Uint8Array
              | undefined);

          if (inlineEncrypted && inlineEncrypted.byteLength > 0) {
            rawEncryptedBuf = Buffer.isBuffer(inlineEncrypted)
              ? inlineEncrypted
              : Buffer.from(
                  inlineEncrypted.buffer,
                  inlineEncrypted.byteOffset,
                  inlineEncrypted.byteLength
                );
          } else if (mediaUrl) {
            try {
              if (input.customRawMediaFetcher) {
                rawEncryptedBuf = await input.customRawMediaFetcher(mediaUrl);
              } else if (
                mediaUrl.startsWith('https://') ||
                mediaUrl.startsWith('http://')
              ) {
                const res = await fetch(mediaUrl, {
                  signal: AbortSignal.timeout(8_000),
                });
                if (res.ok) {
                  const ab = await res.arrayBuffer();
                  rawEncryptedBuf = Buffer.from(ab);
                }
              }
            } catch (encFetchErr) {
              mediaInfo.extractionError = `${downloadErrorMsg || 'decrypt_failed'} | rawFetch=${
                encFetchErr instanceof Error
                  ? encFetchErr.message
                  : String(encFetchErr)
              }`;
            }
          }

          if (rawEncryptedBuf && rawEncryptedBuf.byteLength > 0) {
            const cappedEnc =
              rawEncryptedBuf.byteLength > cfg.maxMediaCaptureBytes
                ? rawEncryptedBuf.subarray(0, cfg.maxMediaCaptureBytes)
                : rawEncryptedBuf;
            mediaInfo.encryptedFallbackUsed = true;
            mediaArtifactFileName = '04_raw_encrypted_media.enc';
            mediaArtifactPath = path.join(captureDir, mediaArtifactFileName);
            mediaBytes = this.writeFileAtomicSync(mediaArtifactPath, cappedEnc);
            mediaInfo.savedFilePath = mediaArtifactPath;
            mediaInfo.savedFileName = mediaArtifactFileName;
            mediaInfo.savedByteLength = mediaBytes;
            mediaInfo.detectedMagicHeaderHex =
              SafeLosslessSerializer.formatHexPreview(cappedEnc, 12);
          }

          anomalies.push({
            code: 'CORRUPTED_MEDIA_HEADER',
            severity: 'CRITICAL',
            descriptionArabic:
              'فشل فك تشفير الوسائط بسبب تلف الحشوة أو التوقيع (تم حفظ الحمولة المشفرة الخام للفحص الجنائي)',
            technicalDetail:
              downloadErrorMsg ||
              'Media decryption failed; raw ciphertext fallback triggered',
          });
        }
      }
    } catch (stage2Err) {
      processingError =
        stage2Err instanceof Error
          ? `${stage2Err.name}: ${stage2Err.message}`
          : String(stage2Err);
      anomalies.push({
        code: 'STAGE2_DISSECTION_FAILURE',
        severity: 'CRITICAL',
        descriptionArabic: `استثناء أثناء التشريح الجنائي للحمولة (تم حفظ النسخة الخام في المرحلة 1 بنجاح)`,
        technicalDetail: processingError,
      });
    }

    // Build Threat Verdict
    const hasCritical = anomalies.some((a) => a.severity === 'CRITICAL');
    const isAnomalous = anomalies.length > 0;
    const threatVerdict: ForensicThreatVerdict = {
      isAnomalous,
      riskLevel: hasCritical
        ? 'HOSTILE_CRASH_VECTOR'
        : isAnomalous
          ? 'SUSPICIOUS'
          : 'CLEAN',
      verdictSummaryArabic: isAnomalous
        ? `🚨 تحذير جنائي: حمولة مشوهة / هجومية [${anomalies
            .map((a) => a.code)
            .join(' + ')}]`
        : '🟢 سليم (لا توجد مؤشرات شذوذ أو تشويه)',
      anomalies,
    };

    // Always write 02_post_process_forensics.json even if Stage 2 encountered a processingError
    try {
      postProcessForensicsJsonPath = path.join(
        captureDir,
        '02_post_process_forensics.json'
      );
      const stage2Report = {
        captureId,
        shortId,
        sessionId: input.sessionId,
        capturedAtIso,
        captureStage: 'POST_PROCESS_FORENSICS',
        rawEventType: input.rawEventType,
        surface,
        headers: {
          messageId,
          remoteJid,
          participantJid,
          senderPnJid,
          senderLidJid,
          addressingMode,
          senderOs,
        },
        payloadType,
        wrapperChain,
        threatVerdict,
        unicodeMap: unicodeMap ?? null,
        mediaInfo,
        processingError: processingError ?? null,
        dissectedMessage: input.rawWaMessage ?? null,
        dissectedBinaryNode: input.rawBinaryNode ?? null,
      };
      const stage2Json = SafeLosslessSerializer.stringify(stage2Report, {
        botTokenToRedact: this.botTokenToRedact,
        space: 2,
      });
      postProcessBytes = this.writeFileAtomicSync(
        postProcessForensicsJsonPath,
        stage2Json
      );
    } catch {
      // Never throw
    }

    const record: ForensicCaptureRecord = {
      captureId,
      shortId,
      sessionId: input.sessionId,
      capturedAtIso,
      rawEventType: input.rawEventType,
      surface,
      messageId,
      remoteJid,
      participantJid,
      senderPnJid,
      senderLidJid,
      addressingMode,
      senderOs,
      payloadType,
      wrapperChain,
      threatVerdict,
      unicodeMap,
      mediaInfo,
      preProcessRawBytes,
      postProcessBytes,
      mediaBytes,
      processingError,
      files: {
        captureDir,
        rawPreProcessJsonPath,
        rawPayloadBinPath,
        postProcessForensicsJsonPath,
        rawTextUtf8Path,
        mediaArtifactPath,
        mediaArtifactFileName,
      },
    };

    // Store in ring buffer (newest first, max 200)
    this.capturesRingBuffer.unshift(record);
    while (this.capturesRingBuffer.length > this.maxRingBufferSize) {
      const evicted = this.capturesRingBuffer.pop();
      if (evicted?.files.captureDir) {
        try {
          fs.rmSync(evicted.files.captureDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    }

    // Trigger automatic Telegram upload if enabled and matches active surfaceFilter
    if (
      this.onForensicCaptureReady &&
      cfg.autoUploadToTelegram &&
      this.matchesSurfaceFilter(record, cfg.surfaceFilter)
    ) {
      try {
        const summaryText = this.formatSanitizedTelegramSummary(record);
        const attachments = this.buildCaptureDocumentAttachments(record);
        this.onForensicCaptureReady(record, summaryText, attachments);
      } catch (cbErr) {
        log.warn('Error in onForensicCaptureReady callback', {
          captureId,
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    }

    return record;
  }

  /**
   * Formats a clean, 100% sanitized Arabic summary message for Telegram.
   * NEVER embeds raw untrusted/malformed text or crash strings directly into the message body.
   */
  public formatSanitizedTelegramSummary(record: ForensicCaptureRecord): string {
    const surfaceLabel =
      record.surface === 'PRIVATE_CHAT'
        ? '💬 محادثة خاصة'
        : record.surface === 'GROUP'
          ? '👥 مجموعة'
          : record.surface === 'STATUS_STORY'
            ? '⭕ حالة واتساب'
            : record.surface === 'NEWSLETTER'
              ? '📡 قناة'
              : '⚡ عقدة بروتوكول';

    const wrapperPath =
      record.wrapperChain.length > 0
        ? `${record.wrapperChain.join(' -> ')} -> ${record.payloadType}`
        : record.payloadType;

    const safeRemote = escapeMarkdown(record.remoteJid.slice(0, 80) || '—');
    const safePn = record.senderPnJid
      ? escapeMarkdown(record.senderPnJid.slice(0, 64))
      : '—';
    const safeLid = record.senderLidJid
      ? escapeMarkdown(record.senderLidJid.slice(0, 64))
      : '—';
    const safeMsgId = escapeMarkdown(record.messageId.slice(0, 64));

    const anomalyLines =
      record.threatVerdict.anomalies.length > 0
        ? `\n🚨 *تفاصيل الشذوذ الجنائي المرصود:*\n` +
          record.threatVerdict.anomalies
            .map(
              (a) =>
                `• \`${a.code}\`: ${escapeMarkdown(a.descriptionArabic)}`
            )
            .join('\n')
        : '';

    const unicodeLine = record.unicodeMap
      ? `\n🔤 *خريطة الترميز (Unicode Map):* الطول \`${record.unicodeMap.charLength}\` حرف (` +
        `\`${record.unicodeMap.utf8ByteLength} B\`) | BiDi: \`${record.unicodeMap.bidiOverrideCount}\` | ` +
        `Zero-Width: \`${record.unicodeMap.zeroWidthCount}\` | Surrogates: \`${record.unicodeMap.loneSurrogateCount}\``
      : '';

    const errorLine = record.processingError
      ? `\n⚠️ *ملاحظة مرحلة التشريح 2:* \`${escapeMarkdown(
          record.processingError.slice(0, 160)
        )}\` (تم حفظ النسخة الخام في المرحلة 1 بالكامل)`
      : '';

    return (
      `🛡️ *تقرير المحلل الأمني والجنائي للحمولات الواردة*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🆔 *معرف الالتقاط:* \`#${record.captureId}\` (\`#${record.shortId}\`)\n` +
      `📱 *الجلسة:* \`${escapeMarkdown(record.sessionId)}\` | 🕒 *الوقت:* \`${record.capturedAtIso}\`\n` +
      `🌐 *السطح (Surface):* ${surfaceLabel}\n` +
      `🎯 *المصدر (JID):* \`${safeRemote}\`\n` +
      `📞 *هاتف المرسل (PN):* \`${safePn}\` | 🎭 *معرف LID:* \`${safeLid}\`\n` +
      `💻 *بصمة نظام المرسل (OS):* \`${record.senderOs}\` (المعرف: \`${safeMsgId}\`)\n` +
      `📦 *نوع الحمولة وسلسلة الأغلفة:* \`${escapeMarkdown(wrapperPath)}\`\n` +
      `⚖️ *الحكم الجنائي:* ${record.threatVerdict.verdictSummaryArabic}\n` +
      `📊 *أحجام الملفات المحفوظة بدون تعديل:*\n` +
      `• المرحلة 1 (Raw Pre-Process): \`${record.preProcessRawBytes} B\`\n` +
      `• المرحلة 2 (Post-Process Forensics): \`${record.postProcessBytes} B\`\n` +
      `• حجم الوسائط الخام: \`${record.mediaBytes} B\`` +
      unicodeLine +
      anomalyLines +
      errorLine
    );
  }

  /**
   * Builds the list of unmodified `TelegramMediaAttachment` (`kind: 'document'`) files
   * for a capture record so they are uploaded via `sendDocument` / `replyWithDocument` (`InputFile`)
   * without Telegram re-compressing or rejecting corrupted media headers.
   */
  public buildCaptureDocumentAttachments(
    record: ForensicCaptureRecord
  ): TelegramMediaAttachment[] {
    const attachments: TelegramMediaAttachment[] = [];

    // 1. <captureId>_01_raw_pre_process.json
    if (
      record.files.rawPreProcessJsonPath &&
      fs.existsSync(record.files.rawPreProcessJsonPath)
    ) {
      const buf = fs.readFileSync(record.files.rawPreProcessJsonPath);
      attachments.push({
        kind: 'document',
        filePath: record.files.rawPreProcessJsonPath,
        fileName: `${record.captureId}_01_raw_pre_process.json`,
        mimeType: 'application/json',
        buffer: buf,
        caption: `🛡️ [${record.captureId}] المرحلة 1: الحمولة الخام قبل أي معالجة (Pre-Process Raw Capture)`,
      });
    }

    // 2. <captureId>_02_post_process_forensics.json
    if (
      record.files.postProcessForensicsJsonPath &&
      fs.existsSync(record.files.postProcessForensicsJsonPath)
    ) {
      const buf = fs.readFileSync(record.files.postProcessForensicsJsonPath);
      attachments.push({
        kind: 'document',
        filePath: record.files.postProcessForensicsJsonPath,
        fileName: `${record.captureId}_02_post_process_forensics.json`,
        mimeType: 'application/json',
        buffer: buf,
        caption: `🔬 [${record.captureId}] المرحلة 2: تقرير التشريح الجنائي والترويسات وخريطة الترميز`,
      });
    }

    // 3. <captureId>_03_raw_content.txt or .bin
    if (
      record.files.rawTextUtf8Path &&
      fs.existsSync(record.files.rawTextUtf8Path)
    ) {
      const buf = fs.readFileSync(record.files.rawTextUtf8Path);
      attachments.push({
        kind: 'document',
        filePath: record.files.rawTextUtf8Path,
        fileName: `${record.captureId}_03_raw_content.txt`,
        mimeType: 'application/octet-stream',
        buffer: buf,
        caption: `📄 [${record.captureId}] النص الخام الأصلي بايت-ببايت بدون أي تعديل`,
      });
    } else if (
      record.files.rawPayloadBinPath &&
      fs.existsSync(record.files.rawPayloadBinPath)
    ) {
      const buf = fs.readFileSync(record.files.rawPayloadBinPath);
      attachments.push({
        kind: 'document',
        filePath: record.files.rawPayloadBinPath,
        fileName: `${record.captureId}_03_raw_content.bin`,
        mimeType: 'application/octet-stream',
        buffer: buf,
        caption: `📦 [${record.captureId}] البايتات الثنائية الخام الأصلية (Raw Binary Payload)`,
      });
    }

    // 4. <captureId>_04_media_original.<ext> (or encrypted fallback .enc)
    if (
      record.files.mediaArtifactPath &&
      fs.existsSync(record.files.mediaArtifactPath)
    ) {
      const buf = fs.readFileSync(record.files.mediaArtifactPath);
      const ext = path
        .extname(record.files.mediaArtifactFileName || '.bin')
        .replace(/^\./, '') || 'bin';
      const docName = record.mediaInfo.encryptedFallbackUsed
        ? `${record.captureId}_04_raw_encrypted_media.enc`
        : `${record.captureId}_04_media_original.${ext}`;
      attachments.push({
        kind: 'document',
        filePath: record.files.mediaArtifactPath,
        fileName: docName,
        mimeType: 'application/octet-stream',
        buffer: buf,
        caption: record.mediaInfo.encryptedFallbackUsed
          ? `🔐 [${record.captureId}] ملف الوسائط المشفر الخام (فشل فك التشفير - تم حفظ النص المشفر الأصلي)`
          : `📎 [${record.captureId}] ملف الوسائط الأصلي بدون أي تعديل أو إعادة ترميز`,
      });
    }

    return attachments;
  }
}

let sharedForensicAnalyzer = new ForensicPayloadAnalyzer();

export function getForensicPayloadAnalyzer(): ForensicPayloadAnalyzer {
  return sharedForensicAnalyzer;
}

export function setForensicPayloadAnalyzer(
  analyzer: ForensicPayloadAnalyzer
): void {
  sharedForensicAnalyzer = analyzer;
}
