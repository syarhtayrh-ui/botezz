import path from 'node:path';
import crypto from 'node:crypto';
import {
  jidEncode,
  jidNormalizedUser,
  isJidGroup,
} from 'athanasia-baileys';
import { maskPhoneNumber } from './redaction';
import { ValidationError, RateLimitError } from '../utils/errors';

export interface NormalizedPhoneResult {
  e164: string; // e.g. +966501234567
  digits: string; // e.g. 966501234567 (digits only, required by athanasia-baileys requestPairingCode)
  jid: string; // e.g. 966501234567@s.whatsapp.net (encoded via athanasia-baileys jidEncode)
  masked: string; // e.g. +966*****4567
  customPairingCode?: string; // Optional 8-character custom pairing code supported by athanasia-baileys
}

/**
 * Validates an optional 8-character custom pairing code supported by athanasia-baileys:
 * `await sock.requestPairingCode(phoneNumber, customCode)`
 */
export function validateCustomPairingCode(rawCode?: string): string | undefined {
  if (!rawCode || !rawCode.trim()) {
    return undefined;
  }
  const cleaned = rawCode.trim().replace(/-/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(cleaned)) {
    throw new ValidationError(
      'رمز الربط المخصص (Custom Pairing Code) في athanasia-baileys يجب أن يتكون من 8 أحرف/أرقام إنجليزية بالضبط (مثال: ATHANASA أو CODE1234).'
    );
  }
  return cleaned;
}

/**
 * Generates a cryptographically random 8-character alphanumeric pairing code for athanasia-baileys
 * when the administrator does not specify a custom code.
 */
export function generateRandomPairingCode(): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

const ARABIC_INDIC_DIGITS_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/**
 * Converts Arabic-Indic and Eastern Arabic/Persian digits to standard ASCII digits.
 */
export function convertArabicIndicDigits(text: string): string {
  if (!text) return '';
  return text.replace(/[٠-٩۰-۹]/g, (digit) => ARABIC_INDIC_DIGITS_MAP[digit] ?? digit);
}

/**
 * Validates and normalizes an international phone number including country code.
 * Also supports optional second token for athanasia-baileys custom pairing code:
 * e.g. "+966501234567", "00966501234567", "+٩٦٦٥٠١٢٣٤٥٦٧", or "+966501234567 MYCODE12"
 */
export function normalizePhoneNumber(rawInput: string): NormalizedPhoneResult {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new ValidationError('الرجاء إدخال رقم الهاتف مع رمز الدولة (مثال: +966501234567).');
  }

  const converted = convertArabicIndicDigits(rawInput.trim());
  let phonePart = converted;
  let customPairingCode: string | undefined;

  // Check if user supplied an optional custom 8-char pairing code after space/comma: "+966501234567 CODE1234"
  const parts = converted.split(/\s+/);
  if (parts.length === 2 && /^[A-Za-z][A-Za-z0-9\-]{6,8}$/.test(parts[1])) {
    phonePart = parts[0];
    customPairingCode = validateCustomPairingCode(parts[1]);
  }

  // Strip spaces, dashes, dots, and parentheses from phone part
  let compact = phonePart.replace(/[\s\-().]/g, '');

  // Normalize international 00 prefix to + (e.g. 00966... -> +966...)
  if (compact.startsWith('00')) {
    compact = '+' + compact.slice(2);
  }

  // Reject characters other than optional leading '+' and digits
  if (!/^\+?[1-9]\d{7,14}$/.test(compact)) {
    throw new ValidationError(
      'صيغة رقم الهاتف غير صالحة. يجب إدخال الرقم الدولي مسبوقاً برمز الدولة (بين 8 و15 رقماً، ولا يبدأ بصفر).'
    );
  }

  const digits = compact.replace(/^\+/, '');
  const e164 = `+${digits}`;
  const jid = jidEncode(digits, 's.whatsapp.net');

  return {
    e164,
    digits,
    jid,
    masked: maskPhoneNumber(e164),
    ...(customPairingCode ? { customPairingCode } : {}),
  };
}

export interface NormalizedRecipient {
  jid: string;
  displayTarget: string;
  isGroup: boolean;
}

/**
 * Validates and normalizes a WhatsApp recipient identifier (either phone number or JID)
 * using athanasia-baileys JID utilities.
 */
export function validateRecipient(rawInput: string): NormalizedRecipient {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new ValidationError('الرجاء تحديد المستلم (رقم هاتف دولي أو معرف مجموعة).');
  }

  const trimmed = rawInput.trim();
  if (isJidGroup(trimmed) || trimmed.endsWith('@g.us')) {
    const groupPrefix = trimmed.slice(0, -5);
    if (!/^[0-9\-]{8,35}$/.test(groupPrefix)) {
      throw new ValidationError('معرف المجموعة (@g.us) غير صالح.');
    }
    return {
      jid: trimmed,
      displayTarget: trimmed,
      isGroup: true,
    };
  }

  if (trimmed.endsWith('@s.whatsapp.net')) {
    const normalizedJid = jidNormalizedUser(trimmed);
    const userDigits = normalizedJid.split('@')[0];
    const normalized = normalizePhoneNumber(userDigits);
    return {
      jid: normalized.jid,
      displayTarget: normalized.masked,
      isGroup: false,
    };
  }

  const normalized = normalizePhoneNumber(trimmed);
  return {
    jid: normalized.jid,
    displayTarget: normalized.masked,
    isGroup: false,
  };
}

/**
 * Validates message text length and content.
 */
export function validateMessageText(text: string): string {
  if (!text || typeof text !== 'string') {
    throw new ValidationError('نص الرسالة مطلوب ولا يمكن أن يكون فارغاً.');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('نص الرسالة لا يمكن أن يتكون من مسافات فقط.');
  }
  if (trimmed.length > 4096) {
    throw new ValidationError('نص الرسالة يتجاوز الحد الأقصى المسموح به (4096 حرفاً).');
  }
  return trimmed;
}

/**
 * Extracts a WhatsApp group invite code from either a full chat.whatsapp.com URL
 * or a direct 20-26 character invite code (adapted from Nebula extractInviteCode).
 */
export function extractInviteCode(rawInput: string): string | null {
  if (typeof rawInput !== 'string') return null;
  const value = rawInput.trim();
  const match = value.match(
    /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{20,26})\/?$/i
  );
  if (match && match[1]) {
    return match[1];
  }
  if (/^[A-Za-z0-9_-]{20,26}$/.test(value)) {
    return value;
  }
  return null;
}

/**
 * Validates a WhatsApp group invitation link and extracts the invite code.
 */
export function validateGroupInviteLink(rawInput: string): {
  inviteCode: string;
  normalizedUrl: string;
} {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new ValidationError('الرجاء إرسال رابط دعوة مجموعة واتساب صالح.');
  }
  const inviteCode = extractInviteCode(rawInput);
  if (!inviteCode) {
    throw new ValidationError(
      'رابط الدعوة غير صالح. يجب أن يكون بالصيغة: https://chat.whatsapp.com/XXXX...'
    );
  }
  return {
    inviteCode,
    normalizedUrl: `https://chat.whatsapp.com/${inviteCode}`,
  };
}

/**
 * Validates a WhatsApp Channel (Newsletter) link and extracts its invite code
 * (adapted from Nebula /cekidch handler).
 */
export function validateWhatsAppChannelLink(rawInput: string): {
  inviteCode: string;
  normalizedUrl: string;
} {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new ValidationError('الرجاء إرسال رابط قناة واتساب صالح (https://whatsapp.com/channel/XXXX).');
  }
  const trimmed = rawInput.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]{10,40})\/?$/i
  );
  if (match && match[1]) {
    return {
      inviteCode: match[1],
      normalizedUrl: `https://whatsapp.com/channel/${match[1]}`,
    };
  }
  if (/^[A-Za-z0-9_-]{15,35}$/.test(trimmed)) {
    return {
      inviteCode: trimmed,
      normalizedUrl: `https://whatsapp.com/channel/${trimmed}`,
    };
  }
  throw new ValidationError(
    'رابط قناة واتساب غير صالح. يجب أن يكون بالصيغة: https://whatsapp.com/channel/XXXX...'
  );
}

/**
 * Strict IPv4 validation (adapted from Nebula /trackip isValidIPv4).
 */
export function isValidIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    if (p.length > 1 && p.startsWith('0')) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * Strict IPv6 validation (adapted from Nebula /trackip isValidIPv6).
 */
export function isValidIPv6(ip: string): boolean {
  const ipv6Regex =
    /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(::)|(::[0-9a-fA-F]{1,4})|([0-9a-fA-F]{1,4}::[0-9a-fA-F]{0,4})|([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){0,6}::([0-9a-fA-F]{1,4}){0,6}))$/;
  return ipv6Regex.test(ip);
}

/**
 * Validates an IPv4 or IPv6 address for IP geolocation lookup (/trackip).
 */
export function validateIpAddress(rawIp: string): string {
  if (!rawIp || typeof rawIp !== 'string') {
    throw new ValidationError('الرجاء إدخال عنوان IPv4 أو IPv6 صالح (مثال: 8.8.8.8).');
  }
  const ip = rawIp.trim();
  if (!isValidIPv4(ip) && !isValidIPv6(ip)) {
    throw new ValidationError(
      'عنوان IP غير صالح. الرجاء إدخال عنوان IPv4 صحيح (مثال: 8.8.8.8) أو IPv6 صحيح.'
    );
  }
  return ip;
}

/**
 * Validates an HTTP/HTTPS URL for link shortening (/shortlink).
 */
export function validateShortlinkTargetUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new ValidationError('الرجاء إرسال رابط يبدأ بـ http:// أو https:// لاختصاره.');
  }
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError('يجب أن يبدأ الرابط بـ http:// أو https://.');
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      'صيغة الرابط غير صالحة. مثال: https://example.com/very/long/path'
    );
  }
}

export type SupportedMediaKind = 'image' | 'video' | 'audio' | 'document';

const ALLOWED_MIME_TYPES: Record<string, { kind: SupportedMediaKind; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: '.jpg' },
  'image/png': { kind: 'image', ext: '.png' },
  'image/webp': { kind: 'image', ext: '.webp' },
  'video/mp4': { kind: 'video', ext: '.mp4' },
  'audio/mpeg': { kind: 'audio', ext: '.mp3' },
  'audio/ogg': { kind: 'audio', ext: '.ogg' },
  'audio/mp4': { kind: 'audio', ext: '.m4a' },
  'application/pdf': { kind: 'document', ext: '.pdf' },
  'text/plain': { kind: 'document', ext: '.txt' },
  'text/csv': { kind: 'document', ext: '.csv' },
  'application/zip': { kind: 'document', ext: '.zip' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'document',
    ext: '.docx',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'document',
    ext: '.xlsx',
  },
};

export interface ValidatedMediaFile {
  kind: SupportedMediaKind;
  mimeType: string;
  safeOriginalName: string;
  generatedFilename: string;
  safeFilePath: string;
  sizeBytes: number;
}

/**
 * Validates uploaded media/file metadata and produces a traversal-safe temporary file path.
 * Never trusts user-supplied paths.
 */
export function validateMediaUpload(params: {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  maxUploadSizeMb: number;
  tempUploadDir: string;
}): ValidatedMediaFile {
  const { originalFilename, mimeType, sizeBytes, maxUploadSizeMb, tempUploadDir } = params;

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new ValidationError('حجم الملف غير صالح أو الملف فارغ.');
  }

  const maxBytes = maxUploadSizeMb * 1024 * 1024;
  if (sizeBytes > maxBytes) {
    throw new ValidationError(
      `حجم الملف يتجاوز الحد الأقصى المسموح به (${maxUploadSizeMb} ميجابايت).`
    );
  }

  const normalizedMime = mimeType.trim().toLowerCase();
  const mimeEntry = ALLOWED_MIME_TYPES[normalizedMime];
  if (!mimeEntry) {
    throw new ValidationError(
      `نوع الملف (${normalizedMime || 'غير معروف'}) غير مدعوم لأسباب أمنية.`
    );
  }

  const baseName = path.basename(originalFilename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const randomId = crypto.randomUUID();
  const generatedFilename = `upload_${randomId}${mimeEntry.ext}`;
  const safeFilePath = resolveSafeChildPath(tempUploadDir, generatedFilename);

  return {
    kind: mimeEntry.kind,
    mimeType: normalizedMime,
    safeOriginalName: baseName || `file${mimeEntry.ext}`,
    generatedFilename,
    safeFilePath,
    sizeBytes,
  };
}

/**
 * Resolves a child path inside baseDir and strictly verifies there is no path traversal.
 */
export function resolveSafeChildPath(baseDir: string, childSegment: string): string {
  if (!childSegment || typeof childSegment !== 'string') {
    throw new ValidationError('معرف المسار الفرعي غير صالح.');
  }
  if (
    childSegment.includes('\0') ||
    childSegment.includes('..') ||
    childSegment.includes('/') ||
    childSegment.includes('\\')
  ) {
    throw new ValidationError('تم رفض المسار بسبب محاولة تجاوز المجلد المسموح به (Path Traversal).');
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, childSegment);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new ValidationError('تم رفض المسار لخروجه عن النطاق الآمن.');
  }

  return resolvedTarget;
}

/**
 * Per-user and per-operation rate limiter + duplicate message cooldown protection.
 */
export class OperationRateLimiter {
  private readonly timestampsByKey = new Map<string, number[]>();
  private readonly duplicateHashes = new Map<string, number>();

  constructor(
    private readonly maxRequestsPerWindow = 10,
    private readonly windowMs = 60_000,
    private readonly duplicateCooldownMs = 15_000
  ) {}

  public checkRateLimit(key: string): void {
    const now = Date.now();
    const existing = this.timestampsByKey.get(key) ?? [];
    const recent = existing.filter((ts) => now - ts < this.windowMs);

    if (recent.length >= this.maxRequestsPerWindow) {
      throw new RateLimitError(
        'تم تجاوز الحد المسموح به للعمليات المتتالية. يرجى الانتظار قليلاً قبل المحاولة مرة أخرى.'
      );
    }

    recent.push(now);
    this.timestampsByKey.set(key, recent);
  }

  public checkDuplicateOperation(signature: string): void {
    const now = Date.now();
    const lastExecuted = this.duplicateHashes.get(signature);
    if (lastExecuted !== undefined && now - lastExecuted < this.duplicateCooldownMs) {
      throw new RateLimitError(
        'تم إرسال نفس العملية مؤخراً. تم منع التكرار لحماية الحسابات من الحظر.'
      );
    }
    this.duplicateHashes.set(signature, now);
  }
}
