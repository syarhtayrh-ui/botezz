import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  downloadMediaMessage,
  getAllBinaryNodeChildren,
  isJidStatusBroadcast,
  jidDecode,
  proto,
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
  | 'signal.decrypt'
  | 'signal.decrypt_failed'
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
  | 'STAGE2_DISSECTION_FAILURE'
  | 'OVERSIZED_QUARANTINE_PAYLOAD'
  | 'PROTOBUF_WIRE_CORRUPTION'
  | 'REPEATED_FIELD_BOMB'
  | 'SIGNAL_DECRYPTION_FAILURE';

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

export const QUARANTINE_PLAINTEXT_SIZE_BYTES = 256 * 1024; // 256 KB

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
  // Signal Post-Decryption Forensic Artifacts (Steps 2 & 3):
  decryptedRawProtobufBinPath?: string; // 02_decrypted_raw_protobuf.bin
  decryptedProtobufDecodedJsonPath?: string; // 03_decrypted_protobuf_decoded.json
  extractedUnencryptedTextPath?: string; // 04_extracted_unencrypted_text.txt
  forensicWireAnatomyReportJsonPath?: string; // 05_forensic_wire_anatomy_report.json
}

export interface SenderForensicAttribution {
  senderPnJid?: string;
  senderPhoneDigits?: string;
  senderLidJid?: string;
  senderLidBaseJid?: string;
  companionDeviceId?: number;
  companionDeviceTag?: string;
  companionDeviceLabel: string;
  rawSenderJid: string;
  groupJid?: string;
  addressingMode: 'lid' | 'pn';
}

export interface StanzaEncNodeSummary {
  type: string;
  v?: string;
  mediatype?: string;
  byteLength: number;
}

export interface IncomingStanzaCorrelationContext {
  sessionId: string;
  stanzaId: string;
  fromJid: string;
  participantJid?: string;
  senderPnJid?: string;
  senderLidJid?: string;
  companionDeviceId?: number;
  companionDeviceTag?: string;
  addressingMode: 'lid' | 'pn';
  encNodes: StanzaEncNodeSummary[];
  rawBinaryNode: BinaryNode;
  recordedAtMs: number;
}

export interface ProtobufWireFieldSummary {
  fieldPath: string;
  fieldNumber: number;
  fieldName?: string;
  wireType: number;
  wireTypeName:
    | 'varint'
    | 'fixed64'
    | 'length_delimited'
    | 'start_group'
    | 'end_group'
    | 'fixed32'
    | 'invalid';
  occurrences: number;
  totalBytes: number;
  maxSingleBytes: number;
  sampleStringPreview?: string;
}

export interface ProtobufWireScanResult {
  totalBytes: number;
  totalWireFieldsScanned: number;
  totalRepeatedItems: number;
  maxNestingDepth: number;
  corruptedWireTag: boolean;
  corruptedOffset?: number;
  corruptedOffsets: number[];
  corruptionReasons: string[];
  fieldSummaries: ProtobufWireFieldSummary[];
  repeatedFieldSummaries: string[];
  extractedStrings: string[];
  extractedJids: string[];
  extractedUrls: string[];
  extractedJsonFragments: string[];
  unicodeMap: UnicodeForensicMap;
  unparsedTailHex?: string;
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
  companionDeviceId?: number;
  companionDeviceTag?: string;
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
  signalEncType?: string;
  ciphertextBytes?: number;
  decryptedProtobufBytes?: number;
  quarantineTriggered?: boolean;
  wireScanSummary?: ProtobufWireScanResult;
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

export interface SignalPlaintextDecryptedInput {
  sessionId: string;
  senderJid: string;
  groupJid?: string;
  encType: 'pkmsg' | 'msg' | 'skmsg' | string;
  ciphertextByteLength: number;
  paddedPlaintext: Buffer | Uint8Array;
  ciphertext?: Buffer | Uint8Array;
  stanzaNode?: BinaryNode | Record<string, unknown> | null;
  forceCapture?: boolean;
}

export interface SignalDecryptionFailedInput {
  sessionId: string;
  senderJid: string;
  groupJid?: string;
  encType: 'pkmsg' | 'msg' | 'skmsg' | string;
  ciphertextByteLength: number;
  ciphertext: Buffer | Uint8Array;
  error: unknown;
  stanzaNode?: BinaryNode | Record<string, unknown> | null;
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

const KNOWN_TOP_LEVEL_WA_PROTO_FIELDS: Record<number, string> = {
  1: 'conversation',
  2: 'senderKeyDistributionMessage',
  3: 'imageMessage',
  4: 'contactMessage',
  5: 'locationMessage',
  6: 'extendedTextMessage',
  7: 'documentMessage',
  8: 'audioMessage',
  9: 'videoMessage',
  10: 'call',
  12: 'protocolMessage',
  13: 'contactsArrayMessage',
  14: 'highlyStructuredMessage',
  16: 'sendPaymentMessage',
  17: 'liveLocationMessage',
  25: 'templateMessage',
  26: 'stickerMessage',
  28: 'groupInviteMessage',
  29: 'templateButtonReplyMessage',
  30: 'productMessage',
  31: 'deviceSentMessage',
  35: 'messageContextInfo',
  36: 'listMessage',
  37: 'viewOnceMessage',
  38: 'orderMessage',
  39: 'listResponseMessage',
  40: 'ephemeralMessage',
  42: 'buttonsMessage',
  43: 'buttonsResponseMessage',
  45: 'interactiveMessage',
  46: 'reactionMessage',
  49: 'interactiveResponseMessage',
  50: 'pollCreationMessage',
  51: 'pollUpdateMessage',
  53: 'documentWithCaptionMessage',
  55: 'viewOnceMessageV2',
  58: 'editedMessage',
  59: 'viewOnceMessageV2Extension',
  60: 'pollCreationMessageV2',
  64: 'pollCreationMessageV3',
  66: 'ptvMessage',
  74: 'lottieStickerMessage',
  75: 'eventMessage',
};

/**
 * WhatsApp Signal Unpadding (`safeUnpadWhatsAppPlaintext`).
 * WhatsApp pads Signal plaintext with `1..16` bytes where the last byte `padLen = buf[buf.length - 1]`
 * indicates the number of padding bytes.
 */
export function safeUnpadWhatsAppPlaintext(padded: Buffer): {
  unpadded: Buffer;
  padLength: number;
  paddingValid: boolean;
} {
  if (!padded || padded.length === 0) {
    return { unpadded: Buffer.alloc(0), padLength: 0, paddingValid: false };
  }
  const padLen = padded[padded.length - 1]!;
  if (padLen >= 1 && padLen <= 16 && padLen <= padded.length) {
    // Verify all padding bytes equal padLen
    let valid = true;
    for (let i = padded.length - padLen; i < padded.length; i++) {
      if (padded[i] !== padLen) {
        valid = false;
        break;
      }
    }
    if (valid) {
      return {
        unpadded: padded.subarray(0, padded.length - padLen),
        padLength: padLen,
        paddingValid: true,
      };
    }
  }
  // Fallback: return untouched if non-standard padding
  return { unpadded: padded, padLength: 0, paddingValid: false };
}

/**
 * Extracts comprehensive sender attribution including Companion LID (`144109809438738:3@lid` -> Device `#3`)
 * and linked primary phone number (`967739724794@s.whatsapp.net`).
 */
export function extractSenderAttribution(input: {
  senderJid?: string;
  groupJid?: string;
  stanzaNode?: BinaryNode | Record<string, unknown> | null;
  rawWaMessage?: Record<string, unknown> | null;
  correlatedContext?: IncomingStanzaCorrelationContext | null;
}): SenderForensicAttribution {
  const rawNode = input.stanzaNode as BinaryNode | undefined | null;
  const nodeAttrs = (rawNode?.attrs ?? {}) as Record<string, string>;
  const rawMsg = input.rawWaMessage as Record<string, unknown> | undefined | null;
  const msgKey = (rawMsg?.key ?? {}) as Record<string, unknown>;
  const rawStanzaMeta = (rawMsg?.__rawStanzaMeta ?? {}) as Record<string, unknown>;
  const ctx = input.correlatedContext;

  const candidateStrings: string[] = [
    input.senderJid,
    ctx?.senderLidJid,
    ctx?.senderPnJid,
    ctx?.fromJid,
    ctx?.participantJid,
    nodeAttrs.sender_lid,
    nodeAttrs.participant_lid,
    nodeAttrs.peer_recipient_lid,
    nodeAttrs.from,
    nodeAttrs.participant,
    nodeAttrs.sender_pn,
    nodeAttrs.participant_pn,
    nodeAttrs.peer_recipient_pn,
    nodeAttrs.recipient_pn,
    typeof msgKey.remoteJid === 'string' ? msgKey.remoteJid : undefined,
    typeof msgKey.participant === 'string' ? msgKey.participant : undefined,
    typeof msgKey.remoteJidAlt === 'string' ? msgKey.remoteJidAlt : undefined,
    typeof msgKey.participantAlt === 'string' ? msgKey.participantAlt : undefined,
    typeof rawStanzaMeta.senderPn === 'string' ? rawStanzaMeta.senderPn : undefined,
    typeof rawStanzaMeta.rawFrom === 'string' ? rawStanzaMeta.rawFrom : undefined,
    typeof rawStanzaMeta.rawParticipant === 'string'
      ? rawStanzaMeta.rawParticipant
      : undefined,
  ]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());

  let senderLidJid: string | undefined;
  let senderLidWithDevice: string | undefined;
  let senderPnJid: string | undefined;
  let senderPhoneDigits: string | undefined;
  let companionDeviceId: number | undefined;
  let groupJid = input.groupJid;

  for (const cand of candidateStrings) {
    if (cand.endsWith('@g.us') && !groupJid) {
      groupJid = cand;
    }

    if (cand.endsWith('@lid') || cand.endsWith('@hosted.lid')) {
      if (!senderLidJid) {
        senderLidJid = cand;
      }
      const devMatch = /:(\d+)@(?:hosted\.)?lid$/i.exec(cand);
      if (devMatch) {
        if (!senderLidWithDevice) {
          senderLidWithDevice = cand;
        }
        if (companionDeviceId === undefined) {
          companionDeviceId = Number(devMatch[1]);
        }
      }
    } else if (
      cand.endsWith('@s.whatsapp.net') ||
      cand.endsWith('@hosted') ||
      cand.endsWith('@c.us')
    ) {
      const userPart = cand.split('@')[0] || '';
      const [digitsPart, devPart] = userPart.split(':');
      const cleanDigits = (digitsPart || '').replace(/\D/g, '');
      if (cleanDigits && !senderPnJid) {
        senderPhoneDigits = cleanDigits;
        senderPnJid = `${cleanDigits}@s.whatsapp.net`;
      }
      if (devPart && /^\d+$/.test(devPart) && companionDeviceId === undefined) {
        companionDeviceId = Number(devPart);
      }
    }
  }

  // Also check explicit PN attributes if they were provided as bare digits
  for (const pnAttr of [
    nodeAttrs.sender_pn,
    nodeAttrs.peer_recipient_pn,
    nodeAttrs.participant_pn,
    nodeAttrs.recipient_pn,
  ]) {
    if (typeof pnAttr === 'string' && pnAttr.trim()) {
      const cleanDigits = pnAttr.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || '';
      if (cleanDigits.length >= 6 && !senderPnJid) {
        senderPhoneDigits = cleanDigits;
        senderPnJid = `${cleanDigits}@s.whatsapp.net`;
      }
    }
  }

  // Prefer the @lid string that preserves the companion device suffix (e.g. 144109809438738:3@lid)
  if (senderLidWithDevice) {
    senderLidJid = senderLidWithDevice;
  }

  let senderLidBaseJid: string | undefined;
  if (senderLidJid) {
    const lidUser = senderLidJid.split('@')[0]?.split(':')[0] || '';
    if (lidUser) {
      senderLidBaseJid = `${lidUser}@lid`;
    }
  }

  if (companionDeviceId === undefined && input.senderJid) {
    const decoded = jidDecode(input.senderJid);
    if (typeof decoded?.device === 'number' && Number.isFinite(decoded.device)) {
      companionDeviceId = decoded.device;
    }
  }

  if (companionDeviceId === undefined && ctx?.companionDeviceId !== undefined) {
    companionDeviceId = ctx.companionDeviceId;
  }

  const companionDeviceTag =
    companionDeviceId !== undefined ? `:${companionDeviceId}` : undefined;
  const companionDeviceLabel =
    companionDeviceId !== undefined && companionDeviceId > 0
      ? `Device #${companionDeviceId} (:${companionDeviceId})`
      : companionDeviceId === 0
        ? 'Primary Device #0 (:0)'
        : 'Primary / Unspecified (:0)';

  const rawSenderJid =
    input.senderJid ||
    senderLidJid ||
    senderPnJid ||
    nodeAttrs.from ||
    ctx?.fromJid ||
    '';

  const addressingMode: 'lid' | 'pn' =
    nodeAttrs.addressing_mode === 'lid' ||
    rawSenderJid.includes('@lid') ||
    Boolean(senderLidJid && (!nodeAttrs.from || nodeAttrs.from.includes('@lid')))
      ? 'lid'
      : 'pn';

  return {
    senderPnJid,
    senderPhoneDigits,
    senderLidJid,
    senderLidBaseJid,
    companionDeviceId,
    companionDeviceTag,
    companionDeviceLabel,
    rawSenderJid,
    groupJid,
    addressingMode,
  };
}

/**
 * Lossless Binary & Malformed-String Serializer (`SafeLosslessSerializer`).
 * - Converts any `Buffer` or `Uint8Array` into `{ __type: "BinaryBuffer", byteLength, base64, hexPreview }`.
 * - Converts `BigInt` or Protobuf `Long` (`{ low, high, unsigned }`) into exact string/number representations.
 * - Preserves malformed UTF-16 surrogates, null bytes (`\u0000`), and BiDi/Zero-Width control characters verbatim.
 * - Redacts ONLY the bot's own local session secrets (`TELEGRAM_BOT_TOKEN`, local `noiseKey.private`, `signedIdentityKey.private`).
 * - Supports bounded array serialization (`maxArrayItems`) to prevent `JSON.stringify` OOM on 666 KB repeated-field bombs.
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
      maxArrayItems?: number;
      maxDepth?: number;
    },
    seen = new WeakSet<object>(),
    currentPath = '$',
    depth = 0
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
    if (typeof input === 'number' || typeof input === 'boolean') {
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
      const maxDepth = options?.maxDepth ?? 32;
      if (depth > maxDepth) {
        return {
          __type: 'MaxDepthExceeded',
          path: currentPath,
          maxDepth,
        };
      }

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
        const maxItems = options?.maxArrayItems;
        if (
          typeof maxItems === 'number' &&
          maxItems > 0 &&
          input.length > maxItems
        ) {
          const head = input.slice(0, maxItems).map((item, idx) =>
            SafeLosslessSerializer.toLosslessJsonValue(
              item,
              options,
              seen,
              `${currentPath}[${idx}]`,
              depth + 1
            )
          );
          head.push({
            __type: 'BoundedRepeatedArraySummary',
            totalArrayLength: input.length,
            serializedItemsCount: maxItems,
            omittedRepeatedItemsCount: input.length - maxItems,
          });
          return head;
        }
        return input.map((item, idx) =>
          SafeLosslessSerializer.toLosslessJsonValue(
            item,
            options,
            seen,
            `${currentPath}[${idx}]`,
            depth + 1
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
            `${currentPath}.${key}`,
            depth + 1
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
    options?: {
      botTokenToRedact?: string;
      space?: number;
      maxArrayItems?: number;
      maxDepth?: number;
    }
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
 * Pure TypeScript Fault-Tolerant Protobuf Wire Scanner (`FaultTolerantProtobufWireScanner` / `scanProtobufWireFields`).
 * Always succeeds without throwing even when `proto.Message.decode` fails on malformed wire tags,
 * truncated varints, or oversized repeated-field bombs.
 */
export class FaultTolerantProtobufWireScanner {
  public static readVarint64(
    buf: Buffer,
    offset: number,
    end: number
  ): {
    valueBigInt: bigint;
    nextOffset: number;
    valid: boolean;
  } {
    let result = BigInt(0);
    let shift = BigInt(0);
    let pos = offset;

    for (let byteIdx = 0; byteIdx < 10; byteIdx++) {
      if (pos >= end) {
        return { valueBigInt: result, nextOffset: pos, valid: false };
      }
      const b = buf[pos]!;
      pos++;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        if (byteIdx === 9 && b > 0x01) {
          // 10th byte overflow for 64-bit integer
          return { valueBigInt: result, nextOffset: pos, valid: false };
        }
        return { valueBigInt: result, nextOffset: pos, valid: true };
      }
      shift += BigInt(7);
    }

    return { valueBigInt: result, nextOffset: pos, valid: false };
  }

  public static wireTypeToName(
    wireType: number
  ): ProtobufWireFieldSummary['wireTypeName'] {
    switch (wireType) {
      case 0:
        return 'varint';
      case 1:
        return 'fixed64';
      case 2:
        return 'length_delimited';
      case 3:
        return 'start_group';
      case 4:
        return 'end_group';
      case 5:
        return 'fixed32';
      default:
        return 'invalid';
    }
  }

  /**
   * Checks whether a buffer slice is valid printable/human/Unicode UTF-8 text
   * (including Arabic, Latin, Emoji, BiDi control characters, Zero-Width chars, JSON, URLs, JIDs)
   * without binary Protobuf framing control bytes (`0x01..0x08`, `0x0E..0x1F`).
   */
  public static isPrintableOrUnicodeUtf8Slice(slice: Buffer): {
    isText: boolean;
    decoded: string;
  } {
    if (!slice || slice.length === 0) {
      return { isText: false, decoded: '' };
    }
    const sampleLen = Math.min(slice.length, 4096);
    let binaryControlCount = 0;
    for (let i = 0; i < sampleLen; i++) {
      const b = slice[i]!;
      if ((b >= 0x01 && b <= 0x08) || (b >= 0x0b && b <= 0x0c) || (b >= 0x0e && b <= 0x1f)) {
        binaryControlCount++;
      }
    }
    if (binaryControlCount > 0) {
      return { isText: false, decoded: '' };
    }

    const decoded = slice.toString('utf8');
    if (decoded.length === 0) {
      return { isText: false, decoded: '' };
    }

    // Count replacement characters U+FFFD
    let replacementCount = 0;
    const checkChars = Math.min(decoded.length, 2048);
    for (let i = 0; i < checkChars; i++) {
      if (decoded.charCodeAt(i) === 0xfffd) {
        replacementCount++;
      }
    }
    if (replacementCount > Math.max(1, Math.floor(checkChars * 0.05))) {
      return { isText: false, decoded: '' };
    }

    return { isText: true, decoded };
  }

  /**
   * Carves contiguous printable UTF-8 / ASCII / Unicode runs from an arbitrary binary or corrupted slice.
   */
  public static carveUtf8StringsFromBinary(
    slice: Buffer,
    minChars = 4
  ): string[] {
    if (!slice || slice.length === 0) return [];
    const results: string[] = [];
    let currentBytes: number[] = [];

    const flushRun = () => {
      if (currentBytes.length < minChars) {
        currentBytes = [];
        return;
      }
      const str = Buffer.from(currentBytes)
        .toString('utf8')
        .replace(/\uFFFD+/g, '')
        .trim();
      currentBytes = [];
      if (str.length >= minChars) {
        results.push(str);
      }
    };

    for (let i = 0; i < slice.length; i++) {
      const b = slice[i]!;
      // Printable ASCII (0x20..0x7E), tab/newline/CR, or UTF-8 multi-byte lead/continuation (0x80..0xF4)
      if (
        (b >= 0x20 && b <= 0x7e) ||
        b === 0x09 ||
        b === 0x0a ||
        b === 0x0d ||
        (b >= 0x80 && b <= 0xf4)
      ) {
        currentBytes.push(b);
      } else {
        flushRun();
      }
    }
    flushRun();
    return results;
  }

  public static scan(buf: Buffer): ProtobufWireScanResult {
    return scanProtobufWireFields(buf);
  }
}

/**
 * Pure TypeScript Fault-Tolerant Protobuf Wire Scanner (`scanProtobufWireFields`).
 * Iterates over `unpadded` using standard Protobuf wire rules (`tag = varint >>> 3`, `wireType = varint & 0x7`),
 * recursively scanning nested sub-messages up to depth `12`, counting repeated fields, extracting
 * all printable UTF-8 strings/JIDs/URLs/JSON fragments, and recording corrupted offsets without throwing.
 */
export function scanProtobufWireFields(buf: Buffer): ProtobufWireScanResult {
  const safeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const fieldStatsByPath = new Map<string, ProtobufWireFieldSummary>();
  const extractedStrings: string[] = [];
  const seenExtractedStrings = new Set<string>();
  const extractedJids = new Set<string>();
  const extractedUrls = new Set<string>();
  const extractedJsonFragments: string[] = [];
  const corruptedOffsets: number[] = [];
  const corruptionReasons: string[] = [];
  let totalWireFieldsScanned = 0;
  let maxNestingDepth = 0;
  let unparsedTailHex: string | undefined;

  const harvestTextMetadata = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!seenExtractedStrings.has(text) && extractedStrings.length < 2000) {
      seenExtractedStrings.add(text);
      extractedStrings.push(text);
    }

    // Extract JIDs
    const jidMatches = text.match(
      /[0-9a-zA-Z._:-]{3,64}@(?:s\.whatsapp\.net|lid|hosted\.lid|g\.us|newsletter|broadcast)/g
    );
    if (jidMatches) {
      for (const jm of jidMatches) {
        if (extractedJids.size < 1000) {
          extractedJids.add(jm);
        }
      }
    }

    // Extract URLs
    const urlMatches = text.match(/https?:\/\/[^\s"'<>\\]+/gi);
    if (urlMatches) {
      for (const um of urlMatches) {
        if (extractedUrls.size < 500) {
          extractedUrls.add(um);
        }
      }
    }

    // Check JSON fragments
    if (
      ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) &&
      extractedJsonFragments.length < 200
    ) {
      extractedJsonFragments.push(
        trimmed.length > 4096 ? `${trimmed.slice(0, 4096)}...` : trimmed
      );
    }
  };

  const recordFieldOccurrence = (
    fieldPath: string,
    fieldNumber: number,
    wireType: number,
    byteCount: number,
    depth: number,
    sampleStr?: string
  ) => {
    totalWireFieldsScanned++;
    const existing = fieldStatsByPath.get(fieldPath);
    const knownName =
      depth === 1 ? KNOWN_TOP_LEVEL_WA_PROTO_FIELDS[fieldNumber] : undefined;
    if (existing) {
      existing.occurrences++;
      existing.totalBytes += byteCount;
      if (byteCount > existing.maxSingleBytes) {
        existing.maxSingleBytes = byteCount;
      }
      if (!existing.sampleStringPreview && sampleStr) {
        existing.sampleStringPreview = sampleStr.slice(0, 120);
      }
    } else {
      fieldStatsByPath.set(fieldPath, {
        fieldPath,
        fieldNumber,
        fieldName: knownName,
        wireType,
        wireTypeName: FaultTolerantProtobufWireScanner.wireTypeToName(wireType),
        occurrences: 1,
        totalBytes: byteCount,
        maxSingleBytes: byteCount,
        sampleStringPreview: sampleStr ? sampleStr.slice(0, 120) : undefined,
      });
    }
  };

  const recordCorruption = (
    offset: number,
    reason: string,
    remainingStart: number,
    remainingEnd: number
  ) => {
    if (!corruptedOffsets.includes(offset)) {
      corruptedOffsets.push(offset);
    }
    corruptionReasons.push(reason);
    if (remainingStart < remainingEnd) {
      const tailSlice = safeBuf.subarray(remainingStart, remainingEnd);
      if (!unparsedTailHex) {
        unparsedTailHex = SafeLosslessSerializer.formatHexPreview(tailSlice, 64);
      }
      const carved =
        FaultTolerantProtobufWireScanner.carveUtf8StringsFromBinary(
          tailSlice,
          4
        );
      for (const c of carved) {
        harvestTextMetadata(c);
      }
    }
  };

  const looksLikeSubMessage = (
    sliceStart: number,
    sliceEnd: number,
    depth: number,
    fieldNumber: number
  ): boolean => {
    const len = sliceEnd - sliceStart;
    if (len < 2 || depth >= 12) return false;

    // At depth 1 in proto.Message, field 1 is conversation (string); all other valid fields (2..100) are sub-messages
    if (depth === 1 && fieldNumber !== 1 && fieldNumber >= 2 && fieldNumber <= 120) {
      return true;
    }

    // Check first tag inside slice
    const firstTag = FaultTolerantProtobufWireScanner.readVarint64(
      safeBuf,
      sliceStart,
      sliceEnd
    );
    if (!firstTag.valid) return false;
    const innerField = Number(firstTag.valueBigInt >> BigInt(3));
    const innerWire = Number(firstTag.valueBigInt & BigInt(0x07));
    if (
      innerField <= 0 ||
      innerField > 500 ||
      (innerWire !== 0 && innerWire !== 1 && innerWire !== 2 && innerWire !== 5)
    ) {
      return false;
    }
    if (innerWire === 2) {
      const innerLen = FaultTolerantProtobufWireScanner.readVarint64(
        safeBuf,
        firstTag.nextOffset,
        sliceEnd
      );
      if (!innerLen.valid) return false;
      const decl = Number(innerLen.valueBigInt);
      return decl >= 0 && innerLen.nextOffset + decl <= sliceEnd;
    }
    return true;
  };

  const scanRange = (
    start: number,
    end: number,
    parentPath: string,
    depth: number
  ): void => {
    if (depth > maxNestingDepth) {
      maxNestingDepth = depth;
    }
    let offset = start;

    while (offset < end) {
      const tagStart = offset;
      const tagVarint = FaultTolerantProtobufWireScanner.readVarint64(
        safeBuf,
        offset,
        end
      );
      if (!tagVarint.valid) {
        recordCorruption(
          tagStart,
          `Truncated or invalid varint wire tag at byte offset ${tagStart}`,
          tagStart,
          end
        );
        return;
      }

      const fieldNumber = Number(tagVarint.valueBigInt >> BigInt(3));
      const wireType = Number(tagVarint.valueBigInt & BigInt(0x07));
      const fieldLabel =
        depth === 1 && KNOWN_TOP_LEVEL_WA_PROTO_FIELDS[fieldNumber]
          ? `${fieldNumber}(${KNOWN_TOP_LEVEL_WA_PROTO_FIELDS[fieldNumber]})`
          : String(fieldNumber);
      const fieldPath = parentPath ? `${parentPath}.${fieldLabel}` : `field_${fieldLabel}`;

      if (
        fieldNumber <= 0 ||
        fieldNumber > 536870911 ||
        wireType === 3 ||
        wireType === 4 ||
        wireType === 6 ||
        wireType === 7
      ) {
        recordFieldOccurrence(
          fieldPath,
          fieldNumber,
          wireType,
          end - tagStart,
          depth
        );
        recordCorruption(
          tagStart,
          `Corrupted Protobuf wire tag at offset ${tagStart} (fieldNumber=${fieldNumber}, wireType=${wireType})`,
          tagStart,
          end
        );
        return;
      }

      offset = tagVarint.nextOffset;

      if (wireType === 0) {
        // Varint
        const valVarint = FaultTolerantProtobufWireScanner.readVarint64(
          safeBuf,
          offset,
          end
        );
        if (!valVarint.valid) {
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            end - tagStart,
            depth
          );
          recordCorruption(
            offset,
            `Truncated varint value for ${fieldPath} at offset ${offset}`,
            offset,
            end
          );
          return;
        }
        recordFieldOccurrence(
          fieldPath,
          fieldNumber,
          wireType,
          valVarint.nextOffset - tagStart,
          depth
        );
        offset = valVarint.nextOffset;
      } else if (wireType === 1) {
        // 64-bit fixed
        if (offset + 8 > end) {
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            end - tagStart,
            depth
          );
          recordCorruption(
            offset,
            `Truncated fixed64 value for ${fieldPath} at offset ${offset} (need 8B, remaining ${end - offset}B)`,
            offset,
            end
          );
          return;
        }
        recordFieldOccurrence(
          fieldPath,
          fieldNumber,
          wireType,
          offset + 8 - tagStart,
          depth
        );
        offset += 8;
      } else if (wireType === 5) {
        // 32-bit fixed
        if (offset + 4 > end) {
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            end - tagStart,
            depth
          );
          recordCorruption(
            offset,
            `Truncated fixed32 value for ${fieldPath} at offset ${offset} (need 4B, remaining ${end - offset}B)`,
            offset,
            end
          );
          return;
        }
        recordFieldOccurrence(
          fieldPath,
          fieldNumber,
          wireType,
          offset + 4 - tagStart,
          depth
        );
        offset += 4;
      } else if (wireType === 2) {
        // Length-delimited
        const lenVarint = FaultTolerantProtobufWireScanner.readVarint64(
          safeBuf,
          offset,
          end
        );
        if (!lenVarint.valid) {
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            end - tagStart,
            depth
          );
          recordCorruption(
            offset,
            `Invalid length varint for ${fieldPath} at offset ${offset}`,
            offset,
            end
          );
          return;
        }

        const payloadStart = lenVarint.nextOffset;
        const declaredLen = Number(lenVarint.valueBigInt);
        let payloadEnd = payloadStart + declaredLen;

        if (
          declaredLen < 0 ||
          !Number.isSafeInteger(declaredLen) ||
          payloadEnd > end
        ) {
          recordCorruption(
            tagStart,
            `Length-delimited field ${fieldPath} at offset ${tagStart} declared ${declaredLen} bytes, exceeding remaining ${end - payloadStart} bytes (clamped to remaining buffer)`,
            payloadStart,
            end
          );
          payloadEnd = end;
        }

        const payloadSlice = safeBuf.subarray(payloadStart, payloadEnd);
        const textCheck =
          depth === 1 && fieldNumber !== 1
            ? { isText: false, decoded: '' }
            : FaultTolerantProtobufWireScanner.isPrintableOrUnicodeUtf8Slice(
                payloadSlice
              );

        if (textCheck.isText) {
          harvestTextMetadata(textCheck.decoded);
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            payloadEnd - tagStart,
            depth,
            textCheck.decoded
          );
        } else if (
          looksLikeSubMessage(payloadStart, payloadEnd, depth, fieldNumber)
        ) {
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            payloadEnd - tagStart,
            depth
          );
          scanRange(payloadStart, payloadEnd, fieldPath, depth + 1);
        } else {
          recordFieldOccurrence(
            fieldPath,
            fieldNumber,
            wireType,
            payloadEnd - tagStart,
            depth
          );
          // Carve any embedded printable strings inside mixed/binary payload
          const carved =
            FaultTolerantProtobufWireScanner.carveUtf8StringsFromBinary(
              payloadSlice,
              4
            );
          for (const c of carved) {
            harvestTextMetadata(c);
          }
        }

        offset = payloadEnd;
      }
    }
  };

  try {
    if (safeBuf.length > 0) {
      scanRange(0, safeBuf.length, '', 1);
    }
  } catch (unexpectedScanErr) {
    recordCorruption(
      0,
      `Unexpected scanner recovery: ${
        unexpectedScanErr instanceof Error
          ? unexpectedScanErr.message
          : String(unexpectedScanErr)
      }`,
      0,
      safeBuf.length
    );
  }

  const fieldSummaries = Array.from(fieldStatsByPath.values()).sort(
    (a, b) => b.totalBytes - a.totalBytes || b.occurrences - a.occurrences
  );

  let totalRepeatedItems = 0;
  const repeatedFieldSummaries: string[] = [];
  for (const summary of fieldSummaries) {
    if (summary.occurrences > 1) {
      totalRepeatedItems += summary.occurrences;
    }
    const label = summary.fieldName
      ? `Field ${summary.fieldNumber} (${summary.fieldName})`
      : summary.fieldPath;
    repeatedFieldSummaries.push(
      `${label}: ${summary.occurrences}x (${summary.totalBytes} bytes)`
    );
  }

  const combinedText = extractedStrings.join('\n');
  const unicodeMap = SafeLosslessSerializer.analyzeUnicodeString(combinedText);

  return {
    totalBytes: safeBuf.length,
    totalWireFieldsScanned,
    totalRepeatedItems,
    maxNestingDepth,
    corruptedWireTag: corruptedOffsets.length > 0,
    corruptedOffset: corruptedOffsets[0],
    corruptedOffsets,
    corruptionReasons,
    fieldSummaries,
    repeatedFieldSummaries,
    extractedStrings,
    extractedJids: Array.from(extractedJids),
    extractedUrls: Array.from(extractedUrls),
    extractedJsonFragments,
    unicodeMap,
    unparsedTailHex,
  };
}

/**
 * Non-destructively wraps `sock.signalRepository.decryptMessage` and `decryptGroupMessage`
 * so `ForensicPayloadAnalyzer` receives a copy of the decrypted plaintext buffer inline
 * at the exact moment Signal decryption succeeds (before `proto.Message.decode` runs),
 * without advancing the one-way Signal ratchet a second time!
 */
export function hookSignalRepositoryForForensics(params: {
  sessionId: string;
  signalRepository: Record<string, unknown> | undefined | null;
  analyzer?: ForensicPayloadAnalyzer;
  getStanzaNode?: () => BinaryNode | undefined;
}): void {
  const repo = params.signalRepository as Record<string, any> | undefined | null;
  if (!repo || typeof repo !== 'object') return;

  if (typeof repo.decryptMessage === 'function' && !repo.__botezzForensicHooked) {
    const origDecryptMessage = repo.decryptMessage.bind(repo);
    repo.__botezzForensicHooked = true;
    repo.decryptMessage = async (decryptParams: {
      jid: string;
      type: 'pkmsg' | 'msg' | string;
      ciphertext: Uint8Array | Buffer;
    }) => {
      const activeAnalyzer = params.analyzer ?? getForensicPayloadAnalyzer();
      try {
        const paddedPlaintext: Uint8Array | Buffer =
          await origDecryptMessage(decryptParams);
        try {
          const copyPlaintext = Buffer.isBuffer(paddedPlaintext)
            ? Buffer.from(paddedPlaintext)
            : Buffer.from(
                paddedPlaintext.buffer,
                paddedPlaintext.byteOffset,
                paddedPlaintext.byteLength
              );
          const copyCiphertext = decryptParams.ciphertext
            ? Buffer.isBuffer(decryptParams.ciphertext)
              ? Buffer.from(decryptParams.ciphertext)
              : Buffer.from(
                  decryptParams.ciphertext.buffer,
                  decryptParams.ciphertext.byteOffset,
                  decryptParams.ciphertext.byteLength
                )
            : undefined;
          activeAnalyzer?.onSignalPlaintextDecrypted({
            sessionId: params.sessionId,
            senderJid: decryptParams.jid,
            encType: decryptParams.type,
            ciphertextByteLength: decryptParams.ciphertext?.byteLength ?? 0,
            paddedPlaintext: copyPlaintext,
            ciphertext: copyCiphertext,
            stanzaNode: params.getStanzaNode?.(),
          });
        } catch {
          // Never disrupt Signal decryption pipeline
        }
        return paddedPlaintext;
      } catch (decryptErr) {
        try {
          const copyCiphertext = decryptParams.ciphertext
            ? Buffer.isBuffer(decryptParams.ciphertext)
              ? Buffer.from(decryptParams.ciphertext)
              : Buffer.from(
                  decryptParams.ciphertext.buffer,
                  decryptParams.ciphertext.byteOffset,
                  decryptParams.ciphertext.byteLength
                )
            : Buffer.alloc(0);
          activeAnalyzer?.onSignalDecryptionFailed({
            sessionId: params.sessionId,
            senderJid: decryptParams.jid,
            encType: decryptParams.type,
            ciphertextByteLength: decryptParams.ciphertext?.byteLength ?? 0,
            ciphertext: copyCiphertext,
            error: decryptErr,
            stanzaNode: params.getStanzaNode?.(),
          });
        } catch {
          // Never disrupt error propagation
        }
        throw decryptErr;
      }
    };
  }

  if (
    typeof repo.decryptGroupMessage === 'function' &&
    !repo.__botezzForensicGroupHooked
  ) {
    const origDecryptGroupMessage = repo.decryptGroupMessage.bind(repo);
    repo.__botezzForensicGroupHooked = true;
    repo.decryptGroupMessage = async (groupParams: {
      group: string;
      authorJid: string;
      msg: Uint8Array | Buffer;
    }) => {
      const activeAnalyzer = params.analyzer ?? getForensicPayloadAnalyzer();
      try {
        const paddedPlaintext: Uint8Array | Buffer =
          await origDecryptGroupMessage(groupParams);
        try {
          const copyPlaintext = Buffer.isBuffer(paddedPlaintext)
            ? Buffer.from(paddedPlaintext)
            : Buffer.from(
                paddedPlaintext.buffer,
                paddedPlaintext.byteOffset,
                paddedPlaintext.byteLength
              );
          const copyCiphertext = groupParams.msg
            ? Buffer.isBuffer(groupParams.msg)
              ? Buffer.from(groupParams.msg)
              : Buffer.from(
                  groupParams.msg.buffer,
                  groupParams.msg.byteOffset,
                  groupParams.msg.byteLength
                )
            : undefined;
          activeAnalyzer?.onSignalPlaintextDecrypted({
            sessionId: params.sessionId,
            senderJid: groupParams.authorJid,
            groupJid: groupParams.group,
            encType: 'skmsg',
            ciphertextByteLength: groupParams.msg?.byteLength ?? 0,
            paddedPlaintext: copyPlaintext,
            ciphertext: copyCiphertext,
            stanzaNode: params.getStanzaNode?.(),
          });
        } catch {
          // Never disrupt group decryption pipeline
        }
        return paddedPlaintext;
      } catch (decryptErr) {
        try {
          const copyCiphertext = groupParams.msg
            ? Buffer.isBuffer(groupParams.msg)
              ? Buffer.from(groupParams.msg)
              : Buffer.from(
                  groupParams.msg.buffer,
                  groupParams.msg.byteOffset,
                  groupParams.msg.byteLength
                )
            : Buffer.alloc(0);
          activeAnalyzer?.onSignalDecryptionFailed({
            sessionId: params.sessionId,
            senderJid: groupParams.authorJid,
            groupJid: groupParams.group,
            encType: 'skmsg',
            ciphertextByteLength: groupParams.msg?.byteLength ?? 0,
            ciphertext: copyCiphertext,
            error: decryptErr,
            stanzaNode: params.getStanzaNode?.(),
          });
        } catch {
          // Ignore
        }
        throw decryptErr;
      }
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
  if (
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@lid') ||
    jid.endsWith('@hosted.lid')
  ) {
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
 * If an incoming message has extreme BiDi overrides (`> 100`), zero-width chars (`> 200`),
 * oversized text (`> 65536`), or repeated array bombs (`mentionedJid.length > 500`, `buttons.length > 200`, etc.),
 * this function returns a sanitized copy for downstream consumers so the bot process never hangs or runs out of memory,
 * AFTER Stage 1 / Signal Inline Capture has already archived the 100% unmodified original payload!
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

  const sanitizeStringField = (val: string, fieldName: string): string => {
    let result = val;
    const uMap = SafeLosslessSerializer.analyzeUnicodeString(result);
    if (
      uMap.bidiOverrideCount > 100 ||
      uMap.combiningMarkCount > 250 ||
      uMap.zeroWidthCount > 500
    ) {
      result = result.replace(
        /[\u202A-\u202E\u2066-\u2069\u061C\u200B-\u200F\u2060-\u2064\uFEFF\u0300-\u036F]/g,
        ''
      );
      wasSanitized = true;
      reasons.push(
        `Stripped hostile BiDi/ZeroWidth/combining crash characters in ${fieldName} (bidi=${uMap.bidiOverrideCount}, zeroWidth=${uMap.zeroWidthCount}, combining=${uMap.combiningMarkCount})`
      );
    }
    if (result.length > 65536) {
      result = `${result.slice(0, 65536)}... [TRUNCATED_BY_SECURITY_GUARD]`;
      wasSanitized = true;
      reasons.push(
        `Truncated oversized text payload in ${fieldName} (${val.length} chars)`
      );
    }
    return result;
  };

  const sanitizeMessageNode = (
    node: Record<string, unknown>,
    depth = 0
  ): Record<string, unknown> => {
    if (!node || typeof node !== 'object' || depth > 12) return node;
    const clone: Record<string, unknown> = { ...node };

    for (const [k, v] of Object.entries(clone)) {
      if (typeof v === 'string') {
        if (v.length > 100) {
          clone[k] = sanitizeStringField(v, k);
        }
      } else if (Array.isArray(v)) {
        const threshold = k === 'mentionedJid' ? 500 : 200;
        let workingArr = v;
        if (v.length > threshold) {
          reasons.push(
            `Truncated ${k === 'mentionedJid' ? 'Mention Array Bomb' : `Repeated Array Bomb (${k})`} (${v.length} items -> 50)`
          );
          workingArr = v.slice(0, 50);
          wasSanitized = true;
        }
        clone[k] = workingArr.map((item) => {
          if (typeof item === 'string' && item.length > 100) {
            return sanitizeStringField(item, `${k}[]`);
          }
          if (
            item &&
            typeof item === 'object' &&
            !Buffer.isBuffer(item) &&
            !(item instanceof Uint8Array) &&
            !Array.isArray(item)
          ) {
            return sanitizeMessageNode(
              item as Record<string, unknown>,
              depth + 1
            );
          }
          return item;
        });
      } else if (
        v &&
        typeof v === 'object' &&
        !Buffer.isBuffer(v) &&
        !(v instanceof Uint8Array)
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
 * Implements:
 * - Inline Signal Decryption Interception (`onSignalPlaintextDecrypted` & `onSignalDecryptionFailed`)
 *   with `01_raw_pre_process.json`, `02_decrypted_raw_protobuf.bin`, `03_decrypted_protobuf_decoded.json`,
 *   `04_extracted_unencrypted_text.txt`, and `05_forensic_wire_anatomy_report.json`.
 * - Two-Stage Capture Pipeline (`captureIncomingPayload`) for `messages.upsert` and raw binary stanzas.
 * - Pre-Decode Crash Protection Shield (`Quarantine Mode` for >256 KB or hostile wire payloads).
 */
export class ForensicPayloadAnalyzer {
  private config: SecurityAnalyzerConfig;
  private readonly settingsRepo?: SettingsRepository;
  private readonly baseForensicsDir: string;
  private readonly botTokenToRedact?: string;
  private readonly capturesRingBuffer: ForensicCaptureRecord[] = [];
  private readonly maxRingBufferSize = 200;
  private captureSeq = 0;

  // Short-lived correlation state for incoming <message> stanzas prior to Signal decryption
  private readonly pendingStanzaByKey = new Map<
    string,
    IncomingStanzaCorrelationContext
  >();
  private readonly latestStanzaBySession = new Map<
    string,
    IncomingStanzaCorrelationContext
  >();
  private readonly signalCapturedStanzaIds = new Set<string>();

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
    return (
      Array.isArray(cfg.targetSessionIds) &&
      cfg.targetSessionIds.includes(sessionId)
    );
  }

  public matchesSurfaceFilter(
    record: ForensicCaptureRecord,
    filter: AnalyzerSurfaceFilter = this.getConfig().surfaceFilter
  ): boolean {
    if (filter === 'ALL') return true;
    if (filter === 'ANOMALIES_ONLY') {
      return (
        record.threatVerdict.isAnomalous || Boolean(record.processingError)
      );
    }
    return record.surface === filter;
  }

  public hasSignalCaptureForStanza(
    sessionId: string,
    stanzaId: string
  ): boolean {
    if (!stanzaId) return false;
    return this.signalCapturedStanzaIds.has(`${sessionId}:${stanzaId}`);
  }

  /**
   * STEP 1.1: Tracks incoming `CB:message` stanza metadata (`stanzaId`, `fromJid`, `participantJid`,
   * `sender_pn`, `sender_lid`, `companionDeviceId`, and `<enc>` nodes) immediately before Signal decryption.
   */
  public recordIncomingMessageStanzaContext(params: {
    sessionId: string;
    node: BinaryNode;
  }): IncomingStanzaCorrelationContext | null {
    const { sessionId, node } = params;
    if (!node || typeof node !== 'object') return null;

    const attrs = (node.attrs ?? {}) as Record<string, string>;
    const stanzaId = String(attrs.id || `stanza_${Date.now()}`);
    const fromJid = String(attrs.from || '');
    const participantJid =
      typeof attrs.participant === 'string' && attrs.participant
        ? attrs.participant
        : undefined;

    const attribution = extractSenderAttribution({
      stanzaNode: node,
    });

    const encNodes: StanzaEncNodeSummary[] = [];
    const children = getAllBinaryNodeChildren(node);
    for (const child of children) {
      if (child.tag === 'enc') {
        const byteLength =
          child.content instanceof Uint8Array || Buffer.isBuffer(child.content)
            ? child.content.byteLength
            : 0;
        encNodes.push({
          type: String(child.attrs?.type || 'msg'),
          v: child.attrs?.v ? String(child.attrs.v) : undefined,
          mediatype: child.attrs?.mediatype
            ? String(child.attrs.mediatype)
            : undefined,
          byteLength,
        });
      }
    }

    const ctx: IncomingStanzaCorrelationContext = {
      sessionId,
      stanzaId,
      fromJid,
      participantJid,
      senderPnJid: attribution.senderPnJid,
      senderLidJid: attribution.senderLidJid,
      companionDeviceId: attribution.companionDeviceId,
      companionDeviceTag: attribution.companionDeviceTag,
      addressingMode: attribution.addressingMode,
      encNodes,
      rawBinaryNode: node,
      recordedAtMs: Date.now(),
    };

    // Evict stale entries (> 60s or > 200 entries)
    if (this.pendingStanzaByKey.size > 200) {
      const firstKey = this.pendingStanzaByKey.keys().next().value;
      if (firstKey) this.pendingStanzaByKey.delete(firstKey);
    }

    this.pendingStanzaByKey.set(`${sessionId}:id:${stanzaId}`, ctx);
    if (fromJid) {
      this.pendingStanzaByKey.set(`${sessionId}:jid:${fromJid}`, ctx);
    }
    if (participantJid) {
      this.pendingStanzaByKey.set(`${sessionId}:jid:${participantJid}`, ctx);
    }
    if (attribution.senderLidJid) {
      this.pendingStanzaByKey.set(
        `${sessionId}:jid:${attribution.senderLidJid}`,
        ctx
      );
    }
    if (attribution.senderPnJid) {
      this.pendingStanzaByKey.set(
        `${sessionId}:jid:${attribution.senderPnJid}`,
        ctx
      );
    }
    this.latestStanzaBySession.set(sessionId, ctx);

    return ctx;
  }

  private resolveCorrelatedStanzaContext(params: {
    sessionId: string;
    senderJid: string;
    groupJid?: string;
    encType: string;
    ciphertextByteLength: number;
    stanzaNode?: BinaryNode | Record<string, unknown> | null;
  }): IncomingStanzaCorrelationContext | undefined {
    if (
      params.stanzaNode &&
      typeof params.stanzaNode === 'object' &&
      'tag' in params.stanzaNode
    ) {
      return (
        this.recordIncomingMessageStanzaContext({
          sessionId: params.sessionId,
          node: params.stanzaNode as BinaryNode,
        }) ?? undefined
      );
    }

    // 1. Direct lookup by senderJid or groupJid
    const directCandidates = [params.senderJid, params.groupJid].filter(
      (j): j is string => Boolean(j)
    );
    for (const jid of directCandidates) {
      const hit = this.pendingStanzaByKey.get(`${params.sessionId}:jid:${jid}`);
      if (hit && Date.now() - hit.recordedAtMs < 30_000) {
        return hit;
      }
    }

    // 2. Match by encType + ciphertextByteLength on same session
    for (const ctx of this.pendingStanzaByKey.values()) {
      if (
        ctx.sessionId === params.sessionId &&
        Date.now() - ctx.recordedAtMs < 30_000 &&
        ctx.encNodes.some(
          (e) =>
            e.type === params.encType &&
            (params.ciphertextByteLength === 0 ||
              e.byteLength === params.ciphertextByteLength)
        )
      ) {
        return ctx;
      }
    }

    // 3. Fallback to most recent stanza on this session within 15s
    const latest = this.latestStanzaBySession.get(params.sessionId);
    if (latest && Date.now() - latest.recordedAtMs < 15_000) {
      return latest;
    }

    return undefined;
  }

  /**
   * STEP 2 & STEP 3: Inline Signal Plaintext Decryption Handler (`onSignalPlaintextDecrypted`).
   * Executes synchronously right after `signalRepository.decryptMessage` (or `decryptGroupMessage`)
   * returns `paddedPlaintext` and BEFORE Baileys invokes `proto.Message.decode`:
   * 1. Unpads WhatsApp Signal padding via `safeUnpadWhatsAppPlaintext`.
   * 2. Immediately writes `01_raw_pre_process.json` and `02_decrypted_raw_protobuf.bin` to disk.
   * 3. Runs Dual-Engine Dissection:
   *    - Engine A: `proto.Message.decode` -> `03_decrypted_protobuf_decoded.json` (bounded against OOM).
   *    - Engine B: `FaultTolerantProtobufWireScanner` (`scanProtobufWireFields`) -> `04_extracted_unencrypted_text.txt`
   *                and `05_forensic_wire_anatomy_report.json`.
   * 4. Triggers Quarantine Mode & immediate Telegram Document upload when enabled or when crash signatures are detected.
   */
  public onSignalPlaintextDecrypted(
    input: SignalPlaintextDecryptedInput
  ): ForensicCaptureRecord | null {
    const paddedBuf = Buffer.isBuffer(input.paddedPlaintext)
      ? input.paddedPlaintext
      : Buffer.from(
          input.paddedPlaintext.buffer,
          input.paddedPlaintext.byteOffset,
          input.paddedPlaintext.byteLength
        );

    const { unpadded, padLength, paddingValid } =
      safeUnpadWhatsAppPlaintext(paddedBuf);

    const isOversizedPayload =
      unpadded.byteLength > QUARANTINE_PLAINTEXT_SIZE_BYTES;

    const cfg = this.getConfig();
    if (!input.forceCapture && !cfg.enabled) {
      return null;
    }
    if (
      !input.forceCapture &&
      cfg.targetSessionIds !== 'ALL' &&
      Array.isArray(cfg.targetSessionIds) &&
      !cfg.targetSessionIds.includes(input.sessionId)
    ) {
      return null;
    }

    const correlatedCtx = this.resolveCorrelatedStanzaContext({
      sessionId: input.sessionId,
      senderJid: input.senderJid,
      groupJid: input.groupJid,
      encType: input.encType,
      ciphertextByteLength: input.ciphertextByteLength,
      stanzaNode: input.stanzaNode,
    });

    const rawBinaryNode =
      (input.stanzaNode as BinaryNode | undefined) ??
      correlatedCtx?.rawBinaryNode;

    const attribution = extractSenderAttribution({
      senderJid: input.senderJid,
      groupJid: input.groupJid,
      stanzaNode: rawBinaryNode,
      correlatedContext: correlatedCtx,
    });

    this.captureSeq = (this.captureSeq + 1) % 1_000_000;
    const randHex = crypto.randomBytes(3).toString('hex');
    const captureId = `fcap_${Date.now()}_${randHex}`;
    const shortId = `${this.captureSeq.toString(36)}${randHex}`;
    const capturedAtIso = new Date().toISOString();

    const captureDir = path.join(this.baseForensicsDir, captureId);
    try {
      fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(captureDir, 0o700);
      } catch {
        // Ignore
      }
    } catch {
      // Ignore
    }

    const rawPreProcessJsonPath = path.join(
      captureDir,
      '01_raw_pre_process.json'
    );
    const decryptedRawProtobufBinPath = path.join(
      captureDir,
      '02_decrypted_raw_protobuf.bin'
    );
    const decryptedProtobufDecodedJsonPath = path.join(
      captureDir,
      '03_decrypted_protobuf_decoded.json'
    );
    const extractedUnencryptedTextPath = path.join(
      captureDir,
      '04_extracted_unencrypted_text.txt'
    );
    const forensicWireAnatomyReportJsonPath = path.join(
      captureDir,
      '05_forensic_wire_anatomy_report.json'
    );

    const messageId =
      correlatedCtx?.stanzaId ||
      (rawBinaryNode?.attrs?.id ? String(rawBinaryNode.attrs.id) : '') ||
      `sig_${shortId}`;
    const remoteJid =
      attribution.groupJid ||
      correlatedCtx?.fromJid ||
      rawBinaryNode?.attrs?.from ||
      attribution.senderLidJid ||
      attribution.senderPnJid ||
      input.senderJid;
    const participantJid =
      correlatedCtx?.participantJid ||
      (rawBinaryNode?.attrs?.participant
        ? String(rawBinaryNode.attrs.participant)
        : undefined) ||
      (attribution.groupJid ? input.senderJid : undefined);

    if (messageId) {
      this.signalCapturedStanzaIds.add(`${input.sessionId}:${messageId}`);
      if (this.signalCapturedStanzaIds.size > 500) {
        const oldest = this.signalCapturedStanzaIds.values().next().value;
        if (oldest) this.signalCapturedStanzaIds.delete(oldest);
      }
    }

    // =========================================================================
    // 1. Write 01_raw_pre_process.json & 02_decrypted_raw_protobuf.bin IMMEDIATELY
    // =========================================================================
    let preProcessRawBytes = 0;
    let decryptedProtobufBytes = 0;
    try {
      const stage1Envelope = {
        captureId,
        shortId,
        sessionId: input.sessionId,
        capturedAtIso,
        captureStage: 'PRE_PROCESS_RAW' as const,
        rawEventType: 'signal.decrypt' as const,
        sender_pn: attribution.senderPnJid ?? null,
        sender_lid: attribution.senderLidJid ?? null,
        companionDeviceId: attribution.companionDeviceId ?? null,
        companionDevice: attribution.companionDeviceLabel,
        signalEnvelope: {
          encType: input.encType,
          senderJid: input.senderJid,
          groupJid: attribution.groupJid ?? null,
          ciphertextByteLength: input.ciphertextByteLength,
          paddedPlaintextByteLength: paddedBuf.byteLength,
          unpaddedPlaintextByteLength: unpadded.byteLength,
          padLength,
          paddingValid,
        },
        rawBinaryNode: rawBinaryNode ?? null,
      };
      const stage1Json = SafeLosslessSerializer.stringify(stage1Envelope, {
        botTokenToRedact: this.botTokenToRedact,
        space: 2,
        maxArrayItems: 5000,
      });
      preProcessRawBytes = this.writeFileAtomicSync(
        rawPreProcessJsonPath,
        stage1Json
      );
    } catch {
      // Never fail
    }

    try {
      decryptedProtobufBytes = this.writeFileAtomicSync(
        decryptedRawProtobufBinPath,
        unpadded
      );
    } catch {
      // Never fail
    }

    // =========================================================================
    // 2. Engine A (`proto.Message.decode`) + Engine B (`FaultTolerantProtobufWireScanner`)
    // =========================================================================
    let decodeSucceeded = false;
    let decodeError: string | undefined;
    let decodedPlainObject: Record<string, unknown> | null = null;
    const wrapperChain: string[] = [];
    let leafPayloadType = `signal:${input.encType}`;
    const engineATextStrings: string[] = [];

    try {
      let decodedMsg: proto.Message | undefined;
      try {
        decodedMsg = proto.Message.decode(unpadded);
      } catch (primaryDecodeErr) {
        // Fallback: if caller passed an already-unpadded buffer whose last byte happened to match 1..16
        if (paddingValid && paddedBuf.byteLength !== unpadded.byteLength) {
          try {
            decodedMsg = proto.Message.decode(paddedBuf);
          } catch {
            throw primaryDecodeErr;
          }
        } else {
          throw primaryDecodeErr;
        }
      }

      if (decodedMsg) {
        const plainObj = proto.Message.toObject(decodedMsg, {
          defaults: false,
          arrays: true,
          bytes: String,
          longs: String,
        }) as Record<string, unknown>;
        const nonMetaKeys = Object.keys(plainObj || {});
        if (nonMetaKeys.length > 0) {
          decodeSucceeded = true;
          decodedPlainObject = plainObj;
        } else if (unpadded.byteLength > 0) {
          // Empty object decoded from non-empty buffer implies unknown/corrupted wire tags
          decodeSucceeded = false;
          decodeError = 'Decoded Protobuf object had 0 known proto.Message fields';
        } else {
          decodeSucceeded = true;
          decodedPlainObject = plainObj;
        }
      }
    } catch (err) {
      decodeSucceeded = false;
      decodeError =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }

    // Inspect decodedPlainObject if Engine A succeeded
    if (decodedPlainObject) {
      let currentContainer: Record<string, unknown> | undefined =
        decodedPlainObject;
      let depth = 0;
      while (currentContainer && depth < 16) {
        let nextInner: Record<string, unknown> | undefined;
        for (const wk of WRAPPER_MESSAGE_KEYS) {
          const wv = currentContainer[wk] as Record<string, unknown> | undefined;
          if (wv && typeof wv === 'object') {
            wrapperChain.push(wk);
            const inner =
              (wv.message as Record<string, unknown> | undefined) ||
              (
                wv.futureproofMessage as
                  | { message?: Record<string, unknown> }
                  | undefined
              )?.message;
            if (inner && typeof inner === 'object') {
              nextInner = inner;
            }
            break;
          }
        }
        if (!nextInner) break;
        currentContainer = nextInner;
        depth++;
      }

      if (currentContainer) {
        const keys = Object.keys(currentContainer).filter(
          (k) =>
            k !== 'messageContextInfo' &&
            currentContainer![k] !== null &&
            currentContainer![k] !== undefined
        );
        if (keys.length > 0) {
          leafPayloadType = keys[0]!;
        } else if (wrapperChain.length > 0) {
          leafPayloadType = wrapperChain[wrapperChain.length - 1]!;
        }
      }

      // Collect strings from decodedPlainObject (bounded walk)
      const collectDecodedStrings = (node: unknown, d = 0) => {
        if (!node || d > 10 || engineATextStrings.length >= 1000) return;
        if (typeof node === 'string') {
          if (node.trim().length > 0) {
            engineATextStrings.push(node);
          }
          return;
        }
        if (Array.isArray(node)) {
          const limit = Math.min(node.length, 200);
          for (let i = 0; i < limit; i++) {
            collectDecodedStrings(node[i], d + 1);
          }
          return;
        }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (
              k === 'mediaKey' ||
              k === 'fileSha256' ||
              k === 'fileEncSha256' ||
              k === 'jpegThumbnail'
            ) {
              continue;
            }
            collectDecodedStrings(v, d + 1);
          }
        }
      };
      collectDecodedStrings(decodedPlainObject);
    }

    // Engine B: FaultTolerantProtobufWireScanner ALWAYS runs on `unpadded`
    const wireScan = scanProtobufWireFields(unpadded);
    if (
      leafPayloadType.startsWith('signal:') &&
      wireScan.fieldSummaries.length > 0
    ) {
      const topNamed = wireScan.fieldSummaries.find((f) => f.fieldName);
      if (topNamed?.fieldName) {
        leafPayloadType = topNamed.fieldName;
      }
    }

    // Write 03_decrypted_protobuf_decoded.json (bounded against OOM)
    let postProcessBytes = 0;
    try {
      const decodedJsonPayload = {
        captureId,
        shortId,
        sessionId: input.sessionId,
        capturedAtIso,
        decodeSucceeded,
        decodeError: decodeError ?? null,
        senderAttribution: attribution,
        wrapperChain,
        leafPayloadType,
        decodedMessage: decodedPlainObject,
        wireScannerFallbackFields: !decodeSucceeded
          ? wireScan.fieldSummaries.slice(0, 100)
          : undefined,
      };
      const jsonStr = SafeLosslessSerializer.stringify(decodedJsonPayload, {
        botTokenToRedact: this.botTokenToRedact,
        space: 2,
        maxArrayItems: 5000,
      });
      postProcessBytes = this.writeFileAtomicSync(
        decryptedProtobufDecodedJsonPath,
        jsonStr
      );
    } catch {
      // Never fail
    }

    // Combine extracted text from Engine A + Engine B and write 04_extracted_unencrypted_text.txt
    const allExtractedStrings: string[] = [];
    const seenStr = new Set<string>();
    for (const s of [...engineATextStrings, ...wireScan.extractedStrings]) {
      if (s && !seenStr.has(s)) {
        seenStr.add(s);
        allExtractedStrings.push(s);
      }
    }

    const extractedTextDocument =
      allExtractedStrings.length > 0
        ? allExtractedStrings.join('\n')
        : `[No printable UTF-8 text fields found in ${unpadded.byteLength}B Protobuf payload. Hex preview: ${SafeLosslessSerializer.formatHexPreview(
            unpadded,
            128
          )}]`;

    try {
      this.writeFileAtomicSync(
        extractedUnencryptedTextPath,
        Buffer.from(extractedTextDocument, 'utf8')
      );
    } catch {
      // Never fail
    }

    const unicodeMap =
      allExtractedStrings.length > 0
        ? SafeLosslessSerializer.analyzeUnicodeString(
            allExtractedStrings.join('\n')
          )
        : wireScan.unicodeMap;

    // =========================================================================
    // 3. Evaluate Anomalies & Pre-Decode Crash Protection Shield (Quarantine Mode)
    // =========================================================================
    const anomalies: ForensicAnomalyFlag[] = [];
    const quarantineReasons: string[] = [];

    if (isOversizedPayload) {
      quarantineReasons.push(
        `Oversized decrypted Protobuf (${unpadded.byteLength} bytes > ${QUARANTINE_PLAINTEXT_SIZE_BYTES} bytes)`
      );
      anomalies.push({
        code: 'OVERSIZED_QUARANTINE_PAYLOAD',
        severity: 'CRITICAL',
        descriptionArabic: `حمولة فك تشفير ضخمة تتجاوز حد الأمان (${(
          unpadded.byteLength / 1024
        ).toFixed(1)} KB > 256 KB) — تم تفعيل وضع العزل الجنائي`,
        technicalDetail: `unpadded.byteLength = ${unpadded.byteLength} bytes (encType=${input.encType}, ciphertext=${input.ciphertextByteLength}B)`,
      });
    }

    if (wireScan.corruptedWireTag || !decodeSucceeded) {
      quarantineReasons.push(
        `Corrupted Protobuf wire structure (corruptedOffset=${
          wireScan.corruptedOffset ?? 'decode_error'
        })`
      );
      anomalies.push({
        code: 'PROTOBUF_WIRE_CORRUPTION',
        severity: 'CRITICAL',
        descriptionArabic: `تلف أو تشويه متعمد في وسم سلك Protobuf عند الإزاحة ${
          wireScan.corruptedOffset ?? 0
        } (${decodeError || wireScan.corruptionReasons[0] || 'wire error'})`,
        technicalDetail: `corruptedOffset=${
          wireScan.corruptedOffset ?? 'N/A'
        }, reasons=${wireScan.corruptionReasons.join('; ') || decodeError || 'unknown'}`,
      });
    }

    if (wireScan.totalRepeatedItems > 2000) {
      quarantineReasons.push(
        `Repeated Protobuf field bomb (totalRepeatedItems=${wireScan.totalRepeatedItems} > 2000)`
      );
      anomalies.push({
        code: 'REPEATED_FIELD_BOMB',
        severity: 'CRITICAL',
        descriptionArabic: `قنبلة حقول متكررة في Protobuf (${wireScan.totalRepeatedItems} عنصر مكرر لاستنزاف الذاكرة)`,
        technicalDetail: `totalRepeatedItems=${wireScan.totalRepeatedItems}, topRepeated=${wireScan.repeatedFieldSummaries
          .slice(0, 3)
          .join(', ')}`,
      });
    }

    if (
      unicodeMap.bidiOverrideCount > 200 ||
      unicodeMap.bidiOverrideCount >= 5 ||
      unicodeMap.zeroWidthCount > 200 ||
      unicodeMap.combiningMarkCount >= 25 ||
      unicodeMap.loneSurrogateCount > 0 ||
      unicodeMap.nullByteCount > 0 ||
      unicodeMap.charLength > 65536
    ) {
      if (unicodeMap.bidiOverrideCount > 200) {
        quarantineReasons.push(
          `Unicode BiDi crash bomb (bidiOverrideCount=${unicodeMap.bidiOverrideCount} > 200)`
        );
      }
      anomalies.push({
        code: 'UNICODE_CRASH_VECTOR',
        severity: 'CRITICAL',
        descriptionArabic:
          'حمولة نصية مشوهة أو هجومية بعد فك تشفير Signal (رموز BiDi عكسية / Virtex / بدائل UTF-16)',
        technicalDetail: `bidi=${unicodeMap.bidiOverrideCount}, zeroWidth=${unicodeMap.zeroWidthCount}, combining=${unicodeMap.combiningMarkCount}, loneSurrogates=${unicodeMap.loneSurrogateCount}, nullBytes=${unicodeMap.nullByteCount}, len=${unicodeMap.charLength}`,
      });
    }

    if (wrapperChain.length > 5 || wireScan.maxNestingDepth > 8) {
      anomalies.push({
        code: 'DEEP_WRAPPER_NESTING',
        severity: 'CRITICAL',
        descriptionArabic: `تداخل عميق لأغلفة الرسالة أو بنية Protobuf (العمق: ${Math.max(
          wrapperChain.length,
          wireScan.maxNestingDepth
        )})`,
        technicalDetail: `wrapperDepth=${wrapperChain.length}, wireMaxDepth=${wireScan.maxNestingDepth}`,
      });
    }

    const quarantineTriggered = quarantineReasons.length > 0;
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
        ? `🚨 تحذير جنائي: حمولة مشوهة / هجومية مفكوكة التشفير [${anomalies
            .map((a) => a.code)
            .join(' + ')}]`
        : '🟢 سليم (تم فك تشفير Signal وفحص البنية السلكية بنجاح)',
      anomalies,
    };

    const surface = classifyForensicSurface(remoteJid, 'messages.upsert');
    const senderOs = detectSenderOsFingerprint(messageId);

    // =========================================================================
    // 4. Write 05_forensic_wire_anatomy_report.json
    // =========================================================================
    try {
      const wireAnatomyReport = {
        captureId,
        shortId,
        sessionId: input.sessionId,
        capturedAtIso,
        captureStage: 'SIGNAL_POST_DECRYPTION_WIRE_ANATOMY' as const,
        surface,
        senderAttribution: {
          senderPnJid: attribution.senderPnJid ?? null,
          senderPhoneDigits: attribution.senderPhoneDigits ?? null,
          senderLidJid: attribution.senderLidJid ?? null,
          senderLidBaseJid: attribution.senderLidBaseJid ?? null,
          companionDeviceId: attribution.companionDeviceId ?? null,
          companionDeviceTag: attribution.companionDeviceTag ?? null,
          companionDeviceLabel: attribution.companionDeviceLabel,
          rawSenderJid: attribution.rawSenderJid,
          groupJid: attribution.groupJid ?? null,
          addressingMode: attribution.addressingMode,
          senderOs,
          messageId,
        },
        signalLayer: {
          encType: input.encType,
          ciphertextByteLength: input.ciphertextByteLength,
          paddedPlaintextByteLength: paddedBuf.byteLength,
          unpaddedPlaintextByteLength: unpadded.byteLength,
          padLength,
          paddingValid,
          unpaddedSha256Hex: crypto
            .createHash('sha256')
            .update(unpadded)
            .digest('hex'),
        },
        protobufEngineA: {
          decodeSucceeded,
          decodeError: decodeError ?? null,
          wrapperChain,
          leafPayloadType,
        },
        wireScannerEngineB: {
          totalBytes: wireScan.totalBytes,
          totalWireFieldsScanned: wireScan.totalWireFieldsScanned,
          totalRepeatedItems: wireScan.totalRepeatedItems,
          maxNestingDepth: wireScan.maxNestingDepth,
          corruptedWireTag: wireScan.corruptedWireTag,
          corruptedOffset: wireScan.corruptedOffset ?? null,
          corruptedOffsets: wireScan.corruptedOffsets,
          corruptionReasons: wireScan.corruptionReasons,
          repeatedFieldSummaries: wireScan.repeatedFieldSummaries.slice(0, 100),
          topFieldsByBytes: wireScan.fieldSummaries.slice(0, 50),
          extractedJids: wireScan.extractedJids,
          extractedUrls: wireScan.extractedUrls,
          extractedJsonFragmentsCount: wireScan.extractedJsonFragments.length,
          unparsedTailHex: wireScan.unparsedTailHex ?? null,
        },
        unicodeForensics: unicodeMap,
        quarantineShield: {
          quarantineTriggered,
          exceeds256KbThreshold: isOversizedPayload,
          quarantineReasons,
        },
        threatVerdict,
      };

      const reportJson = SafeLosslessSerializer.stringify(wireAnatomyReport, {
        botTokenToRedact: this.botTokenToRedact,
        space: 2,
        maxArrayItems: 5000,
      });
      this.writeFileAtomicSync(forensicWireAnatomyReportJsonPath, reportJson);
    } catch {
      // Never fail
    }

    const record: ForensicCaptureRecord = {
      captureId,
      shortId,
      sessionId: input.sessionId,
      capturedAtIso,
      rawEventType: 'signal.decrypt',
      surface,
      messageId,
      remoteJid,
      participantJid,
      senderPnJid: attribution.senderPnJid,
      senderLidJid: attribution.senderLidJid,
      companionDeviceId: attribution.companionDeviceId,
      companionDeviceTag: attribution.companionDeviceTag,
      addressingMode: attribution.addressingMode,
      senderOs,
      payloadType: leafPayloadType,
      wrapperChain,
      threatVerdict,
      unicodeMap,
      mediaInfo: {
        hasMedia: false,
        decryptionSucceeded: true,
        encryptedFallbackUsed: false,
      },
      preProcessRawBytes,
      postProcessBytes,
      mediaBytes: decryptedProtobufBytes,
      signalEncType: input.encType,
      ciphertextBytes: input.ciphertextByteLength,
      decryptedProtobufBytes,
      quarantineTriggered,
      wireScanSummary: wireScan,
      processingError: decodeError,
      files: {
        captureDir,
        rawPreProcessJsonPath,
        postProcessForensicsJsonPath: forensicWireAnatomyReportJsonPath,
        rawTextUtf8Path: extractedUnencryptedTextPath,
        decryptedRawProtobufBinPath,
        decryptedProtobufDecodedJsonPath,
        extractedUnencryptedTextPath,
        forensicWireAnatomyReportJsonPath,
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

    // Trigger automatic Telegram upload when enabled (or unconditionally when quarantineTriggered & autoUploadToTelegram)
    if (
      this.onForensicCaptureReady &&
      cfg.autoUploadToTelegram &&
      (quarantineTriggered || this.matchesSurfaceFilter(record, cfg.surfaceFilter))
    ) {
      try {
        const summaryText = this.formatSanitizedTelegramSummary(record);
        const attachments = this.buildCaptureDocumentAttachments(record);
        this.onForensicCaptureReady(record, summaryText, attachments);
      } catch (cbErr) {
        log.warn('Error in onForensicCaptureReady callback for Signal plaintext', {
          captureId,
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        });
      }
    }

    return record;
  }

  /**
   * STEP 1.2: Captures Signal decryption failures (`onSignalDecryptionFailed`) with full stanza context
   * and the raw ciphertext buffer (`01_raw_payload.bin`).
   */
  public onSignalDecryptionFailed(
    input: SignalDecryptionFailedInput
  ): ForensicCaptureRecord | null {
    const cfg = this.getConfig();
    if (!input.forceCapture && !cfg.enabled) {
      return null;
    }
    if (
      !input.forceCapture &&
      cfg.targetSessionIds !== 'ALL' &&
      Array.isArray(cfg.targetSessionIds) &&
      !cfg.targetSessionIds.includes(input.sessionId)
    ) {
      return null;
    }

    const correlatedCtx = this.resolveCorrelatedStanzaContext({
      sessionId: input.sessionId,
      senderJid: input.senderJid,
      groupJid: input.groupJid,
      encType: input.encType,
      ciphertextByteLength: input.ciphertextByteLength,
      stanzaNode: input.stanzaNode,
    });

    const rawBinaryNode =
      (input.stanzaNode as BinaryNode | undefined) ??
      correlatedCtx?.rawBinaryNode;

    const attribution = extractSenderAttribution({
      senderJid: input.senderJid,
      groupJid: input.groupJid,
      stanzaNode: rawBinaryNode,
      correlatedContext: correlatedCtx,
    });

    this.captureSeq = (this.captureSeq + 1) % 1_000_000;
    const randHex = crypto.randomBytes(3).toString('hex');
    const captureId = `fcap_${Date.now()}_${randHex}`;
    const shortId = `${this.captureSeq.toString(36)}${randHex}`;
    const capturedAtIso = new Date().toISOString();
    const captureDir = path.join(this.baseForensicsDir, captureId);

    try {
      fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
    } catch {
      // Ignore
    }

    const rawPreProcessJsonPath = path.join(
      captureDir,
      '01_raw_pre_process.json'
    );
    const rawPayloadBinPath = path.join(captureDir, '01_raw_payload.bin');
    const postProcessForensicsJsonPath = path.join(
      captureDir,
      '02_post_process_forensics.json'
    );

    const errMsg =
      input.error instanceof Error
        ? `${input.error.name}: ${input.error.message}`
        : String(input.error);

    const cipherBuf = Buffer.isBuffer(input.ciphertext)
      ? input.ciphertext
      : Buffer.from(
          input.ciphertext.buffer,
          input.ciphertext.byteOffset,
          input.ciphertext.byteLength
        );

    let preProcessRawBytes = 0;
    let postProcessBytes = 0;
    try {
      preProcessRawBytes = this.writeFileAtomicSync(
        rawPreProcessJsonPath,
        SafeLosslessSerializer.stringify(
          {
            captureId,
            shortId,
            sessionId: input.sessionId,
            capturedAtIso,
            captureStage: 'PRE_PROCESS_RAW',
            rawEventType: 'signal.decrypt_failed',
            sender_pn: attribution.senderPnJid ?? null,
            sender_lid: attribution.senderLidJid ?? null,
            companionDeviceId: attribution.companionDeviceId ?? null,
            signalError: errMsg,
            rawBinaryNode: rawBinaryNode ?? null,
          },
          { botTokenToRedact: this.botTokenToRedact, space: 2 }
        )
      );
      if (cipherBuf.byteLength > 0) {
        this.writeFileAtomicSync(rawPayloadBinPath, cipherBuf);
      }
      postProcessBytes = this.writeFileAtomicSync(
        postProcessForensicsJsonPath,
        SafeLosslessSerializer.stringify(
          {
            captureId,
            shortId,
            sessionId: input.sessionId,
            capturedAtIso,
            senderAttribution: attribution,
            encType: input.encType,
            ciphertextByteLength: input.ciphertextByteLength,
            decryptionError: errMsg,
          },
          { botTokenToRedact: this.botTokenToRedact, space: 2 }
        )
      );
    } catch {
      // Ignore
    }

    const messageId =
      correlatedCtx?.stanzaId ||
      (rawBinaryNode?.attrs?.id ? String(rawBinaryNode.attrs.id) : '') ||
      `sigfail_${shortId}`;
    const remoteJid =
      attribution.groupJid ||
      correlatedCtx?.fromJid ||
      attribution.senderLidJid ||
      attribution.senderPnJid ||
      input.senderJid;

    const anomalies: ForensicAnomalyFlag[] = [
      {
        code: 'SIGNAL_DECRYPTION_FAILURE',
        severity: 'CRITICAL',
        descriptionArabic: `فشل فك تشفير طبقة Signal (${input.encType}): ${errMsg}`,
        technicalDetail: `encType=${input.encType}, ciphertext=${input.ciphertextByteLength}B, err=${errMsg}`,
      },
    ];

    const record: ForensicCaptureRecord = {
      captureId,
      shortId,
      sessionId: input.sessionId,
      capturedAtIso,
      rawEventType: 'signal.decrypt_failed',
      surface: classifyForensicSurface(remoteJid, 'messages.upsert'),
      messageId,
      remoteJid,
      senderPnJid: attribution.senderPnJid,
      senderLidJid: attribution.senderLidJid,
      companionDeviceId: attribution.companionDeviceId,
      companionDeviceTag: attribution.companionDeviceTag,
      addressingMode: attribution.addressingMode,
      senderOs: detectSenderOsFingerprint(messageId),
      payloadType: `signal_failed:${input.encType}`,
      wrapperChain: [],
      threatVerdict: {
        isAnomalous: true,
        riskLevel: 'HOSTILE_CRASH_VECTOR',
        verdictSummaryArabic: `🚨 تحذير جنائي: فشل فك تشفير Signal [SIGNAL_DECRYPTION_FAILURE]`,
        anomalies,
      },
      mediaInfo: {
        hasMedia: false,
        decryptionSucceeded: false,
        encryptedFallbackUsed: true,
      },
      preProcessRawBytes,
      postProcessBytes,
      mediaBytes: cipherBuf.byteLength,
      signalEncType: input.encType,
      ciphertextBytes: input.ciphertextByteLength,
      processingError: errMsg,
      files: {
        captureDir,
        rawPreProcessJsonPath,
        rawPayloadBinPath: cipherBuf.byteLength > 0 ? rawPayloadBinPath : undefined,
        postProcessForensicsJsonPath,
      },
    };

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

    if (
      this.onForensicCaptureReady &&
      cfg.autoUploadToTelegram &&
      this.matchesSurfaceFilter(record, cfg.surfaceFilter)
    ) {
      try {
        const summaryText = this.formatSanitizedTelegramSummary(record);
        const attachments = this.buildCaptureDocumentAttachments(record);
        this.onForensicCaptureReady(record, summaryText, attachments);
      } catch {
        // Ignore
      }
    }

    return record;
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
    this.pendingStanzaByKey.clear();
    this.latestStanzaBySession.clear();
    this.signalCapturedStanzaIds.clear();
    return count;
  }

  private writeFileAtomicSync(filePath: string, data: Buffer | string): number {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 7)}`;
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

    const attribution = extractSenderAttribution({
      stanzaNode: input.rawBinaryNode,
      rawWaMessage: input.rawWaMessage,
    });

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
        sender_pn: attribution.senderPnJid ?? null,
        sender_lid: attribution.senderLidJid ?? null,
        companionDeviceId: attribution.companionDeviceId ?? null,
        rawBinaryNode: input.rawBinaryNode ?? null,
        rawWaMessage: input.rawWaMessage ?? null,
      };

      const stage1Json = SafeLosslessSerializer.stringify(stage1Envelope, {
        botTokenToRedact: this.botTokenToRedact,
        space: 2,
        maxArrayItems: 5000,
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
    let senderPnJid: string | undefined = attribution.senderPnJid;
    let senderLidJid: string | undefined = attribution.senderLidJid;
    const companionDeviceId: number | undefined = attribution.companionDeviceId;
    const companionDeviceTag: string | undefined = attribution.companionDeviceTag;
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

      messageId = String(msgKey.id || nodeAttrs.id || `stanza_${shortId}`);
      remoteJid = String(msgKey.remoteJid || nodeAttrs.from || '');
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
      if (!senderPnJid) {
        senderPnJid = attribution.senderPnJid;
      }
      if (!senderLidJid) {
        senderLidJid = attribution.senderLidJid;
      }

      surface = classifyForensicSurface(remoteJid, input.rawEventType);
      senderOs = detectSenderOsFingerprint(messageId);

      // Check if payload explicitly triggers a simulated/corrupted dissection error
      if (
        rawMsg &&
        typeof rawMsg.__simulateCorruptedDissectionThrow === 'function'
      ) {
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
              (
                wrapperVal.futureproofMessage as
                  | { message?: Record<string, unknown> }
                  | undefined
              )?.message;
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
          payloadType = keys[0]!;
          const candidateLeaf = currentMessageContainer[payloadType];
          if (candidateLeaf && typeof candidateLeaf === 'object') {
            leafContentObj = candidateLeaf as Record<string, unknown>;
          }
        } else if (wrapperChain.length > 0) {
          payloadType = wrapperChain[wrapperChain.length - 1]!;
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
                  sj.split('@')[0]!.split(':')[0] ===
                    quotedParticipant.split('@')[0]!.split(':')[0]
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
          companionDeviceId,
          companionDeviceTag,
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
        maxArrayItems: 5000,
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
      companionDeviceId,
      companionDeviceTag,
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
    const deviceSuffix =
      record.companionDeviceId !== undefined
        ? ` (الجهاز المرافق: \`#${record.companionDeviceId}\` / \`${record.companionDeviceTag || `:${record.companionDeviceId}`}\`)`
        : '';
    const safeMsgId = escapeMarkdown(record.messageId.slice(0, 64));

    const signalLine =
      record.decryptedProtobufBytes !== undefined
        ? `\n🔓 *طبقة تشفير Signal (\`${escapeMarkdown(record.signalEncType || 'msg')}\`):* المشفر \`${
            record.ciphertextBytes ?? 0
          } B\` ⬅️ المفكوك الخام (Protobuf): \`${record.decryptedProtobufBytes} B\`${
            record.quarantineTriggered ? ' 🛡️ *(وضع العزل الفوري مفعّل)*' : ''
          }`
        : '';

    const wireLine = record.wireScanSummary
      ? `\n🧬 *تشريح سلك Protobuf:* الحقول: \`${record.wireScanSummary.totalWireFieldsScanned}\` | العناصر المكررة: \`${record.wireScanSummary.totalRepeatedItems}\` | أقصى عمق: \`${record.wireScanSummary.maxNestingDepth}\` | تلف سلكي: \`${
          record.wireScanSummary.corruptedWireTag
            ? `نعم (عند ${record.wireScanSummary.corruptedOffset ?? 0})`
            : 'لا'
        }\``
      : '';

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
      ? `\n⚠️ *ملاحظة مرحلة التشريح:* \`${escapeMarkdown(
          record.processingError.slice(0, 160)
        )}\` (تم حفظ الحمولة المفكوكة والنسخة الخام بالكامل)`
      : '';

    return (
      `🛡️ *تقرير المحلل الأمني والجنائي للحمولات الواردة*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🆔 *معرف الالتقاط:* \`#${record.captureId}\` (\`#${record.shortId}\`)\n` +
      `📱 *الجلسة:* \`${escapeMarkdown(record.sessionId)}\` | 🕒 *الوقت:* \`${record.capturedAtIso}\`\n` +
      `🌐 *السطح (Surface):* ${surfaceLabel}\n` +
      `🎯 *المصدر (JID):* \`${safeRemote}\`\n` +
      `📞 *هاتف المرسل (PN):* \`${safePn}\` | 🎭 *معرف LID:* \`${safeLid}\`${deviceSuffix}\n` +
      `💻 *بصمة نظام المرسل (OS):* \`${record.senderOs}\` (المعرف: \`${safeMsgId}\`)\n` +
      `📦 *نوع الحمولة وسلسلة الأغلفة:* \`${escapeMarkdown(wrapperPath)}\`\n` +
      `⚖️ *الحكم الجنائي:* ${record.threatVerdict.verdictSummaryArabic}\n` +
      `📊 *أحجام الملفات المحفوظة بدون تعديل:*\n` +
      `• المرحلة 1 (Raw Pre-Process): \`${record.preProcessRawBytes} B\`\n` +
      `• المرحلة 2 (Post-Process / Decoded): \`${record.postProcessBytes} B\`\n` +
      `• حجم الحمولة الثنائية / الوسائط: \`${record.mediaBytes} B\`` +
      signalLine +
      wireLine +
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
        caption: `🛡️ [${record.captureId}] 01: العقدة الخام والهوية (PN: ${record.senderPnJid || '—'} | LID: ${record.senderLidJid || '—'})`,
      });
    }

    // If this is a Signal Post-Decryption capture, attach the 5-file decrypted forensic bundle:
    if (
      record.files.decryptedRawProtobufBinPath &&
      fs.existsSync(record.files.decryptedRawProtobufBinPath)
    ) {
      // 2. <captureId>_02_decrypted_raw_protobuf.bin
      const rawProtoBuf = fs.readFileSync(
        record.files.decryptedRawProtobufBinPath
      );
      attachments.push({
        kind: 'document',
        filePath: record.files.decryptedRawProtobufBinPath,
        fileName: `${record.captureId}_02_decrypted_raw_protobuf.bin`,
        mimeType: 'application/octet-stream',
        buffer: rawProtoBuf,
        caption: `🔓 [${record.captureId}] 02: بايتات Protobuf الخام المفكوكة بعد إزالة تشفير Signal (${rawProtoBuf.byteLength} B)`,
      });

      // 3. <captureId>_03_decrypted_protobuf_decoded.json
      if (
        record.files.decryptedProtobufDecodedJsonPath &&
        fs.existsSync(record.files.decryptedProtobufDecodedJsonPath)
      ) {
        const decodedJsonBuf = fs.readFileSync(
          record.files.decryptedProtobufDecodedJsonPath
        );
        attachments.push({
          kind: 'document',
          filePath: record.files.decryptedProtobufDecodedJsonPath,
          fileName: `${record.captureId}_03_decrypted_protobuf_decoded.json`,
          mimeType: 'application/json',
          buffer: decodedJsonBuf,
          caption: `🧬 [${record.captureId}] 03: الهيكل الكامل للرسالة المفكوكة (Decoded Protobuf JSON)`,
        });
      }

      // 4. <captureId>_04_extracted_unencrypted_text.txt
      if (
        record.files.extractedUnencryptedTextPath &&
        fs.existsSync(record.files.extractedUnencryptedTextPath)
      ) {
        const extractedTxtBuf = fs.readFileSync(
          record.files.extractedUnencryptedTextPath
        );
        attachments.push({
          kind: 'document',
          filePath: record.files.extractedUnencryptedTextPath,
          fileName: `${record.captureId}_04_extracted_unencrypted_text.txt`,
          mimeType: 'application/octet-stream',
          buffer: extractedTxtBuf,
          caption: `📄 [${record.captureId}] 04: جميع النصوص السليمة والمشوهة والروابط والمعرفات المستخرجة من الحمولة المفكوكة`,
        });
      }

      // 5. <captureId>_05_forensic_wire_anatomy_report.json
      if (
        record.files.forensicWireAnatomyReportJsonPath &&
        fs.existsSync(record.files.forensicWireAnatomyReportJsonPath)
      ) {
        const wireReportBuf = fs.readFileSync(
          record.files.forensicWireAnatomyReportJsonPath
        );
        attachments.push({
          kind: 'document',
          filePath: record.files.forensicWireAnatomyReportJsonPath,
          fileName: `${record.captureId}_05_forensic_wire_anatomy_report.json`,
          mimeType: 'application/json',
          buffer: wireReportBuf,
          caption: `🔬 [${record.captureId}] 05: تقرير التشريح السلكي وإحصائيات الحقول المكررة وهوية الجهاز المرافق`,
        });
      }

      return attachments;
    }

    // Standard Stage 2 Post-Process Forensics Bundle:
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
      const ext =
        path
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
