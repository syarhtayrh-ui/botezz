/**
 * Security Redaction Utilities
 * Ensures sensitive values (Telegram Bot tokens, WhatsApp pairing codes,
 * private keys, raw authentication state, and full phone numbers) never leak into logs or error reports.
 */

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /tctoken/i,
  /tc[_-]?token/i,
  /cstoken/i,
  /cs[_-]?token/i,
  /username[_-]?pin/i,
  /username[_-]?key/i,
  /^pin$/i,
  /secret/i,
  /password/i,
  /pairing[_-]?code/i,
  /private[_-]?key/i,
  /noise[_-]?key/i,
  /signed[_-]?identity[_-]?key/i,
  /signed[_-]?pre[_-]?key/i,
  /adv[_-]?secret[_-]?key/i,
  /creds/i,
  /auth[_-]?state/i,
  /session[_-]?key/i,
  /authorization/i,
];

const TELEGRAM_BOT_TOKEN_REGEX = /\b\d{8,12}:[A-Za-z0-9_-]{30,45}\b/g;
const PAIRING_CODE_FORMAT_REGEX = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;
const PRIVACY_TOKEN_INLINE_REGEX =
  /\b(tctoken|tc_token|cstoken|cs_token|usernamePin|username_pin|usernameKey|username_key)\s*[:=]\s*["']?([^"'\s,;}\]]+)["']?/gi;

/**
 * Masks a phone number so only country prefix and last 4 digits are visible.
 * Example: "+966501234567" -> "+966*****4567"
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return 'غير معروف';
  const cleaned = phone.replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7) {
    return '***';
  }
  const prefix = cleaned.startsWith('+')
    ? `+${digits.slice(0, 3)}`
    : `+${digits.slice(0, 3)}`;
  const suffix = digits.slice(-4);
  const maskedCount = Math.max(3, digits.length - 7);
  return `${prefix}${'*'.repeat(maskedCount)}${suffix}`;
}

/**
 * Masks a phone number or JID for Menfess / Anonymous Session presentation.
 * Example: "967771234535@s.whatsapp.net" -> "+967•••••••35"
 */
export function maskPhoneForMenfess(phoneOrJid: string | null | undefined): string {
  if (!phoneOrJid) return 'Anonymous Sender';
  const rawUser = String(phoneOrJid).split('@')[0].split(':')[0];
  const digits = rawUser.replace(/\D/g, '');
  if (digits.length < 6) {
    return 'Anonymous Sender';
  }
  const prefix = digits.slice(0, 3);
  const suffix = digits.slice(-2);
  const dotsCount = Math.max(5, digits.length - 5);
  return `+${prefix}${'•'.repeat(dotsCount)}${suffix}`;
}

/**
 * Masks a WhatsApp JID (`@s.whatsapp.net` or `@lid`) for safe diagnostics and telemetry.
 */
export function maskJidForDiagnostics(jid: string | null | undefined): string {
  if (!jid) return 'unknown';
  const trimmed = String(jid).trim();
  const atIdx = trimmed.indexOf('@');
  const userPart = (atIdx >= 0 ? trimmed.slice(0, atIdx) : trimmed).split(':')[0];
  const domainPart = atIdx >= 0 ? trimmed.slice(atIdx) : '';
  if (userPart.length <= 5) {
    return `***${domainPart}`;
  }
  return `${userPart.slice(0, 3)}••••${userPart.slice(-2)}${domainPart}`;
}

/**
 * Redacts sensitive patterns from arbitrary text strings.
 */
export function redactText(input: string): string {
  if (!input) return input;
  return input
    .replace(TELEGRAM_BOT_TOKEN_REGEX, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(PAIRING_CODE_FORMAT_REGEX, '[REDACTED_PAIRING_CODE]')
    .replace(PRIVACY_TOKEN_INLINE_REGEX, '$1=[REDACTED]');
}

export { redactText as redactString };

/**
 * Deeply clones and redacts sensitive fields from objects before logging or serializing.
 */
export function redactObject<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactText(value) as unknown as T;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    } as unknown as T;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return '[REDACTED_BINARY_BUFFER]' as unknown as T;
  }
  if (seen.has(value as object)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, seen)) as unknown as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, propVal] of Object.entries(value as Record<string, unknown>)) {
    const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(key));
    if (isSensitiveKey) {
      output[key] = '[REDACTED]';
    } else if (key.toLowerCase().includes('phone') && typeof propVal === 'string') {
      output[key] = maskPhoneNumber(propVal);
    } else {
      output[key] = redactObject(propVal, seen);
    }
  }
  return output as T;
}

export { redactObject as redactSensitiveData };

/**
 * Sanitizes URLs by redacting Telegram Bot tokens (`/bot<TOKEN>/`),
 * query-string secrets (`token=`, `secret=`, `key=`, `password=`, `auth=`),
 * and raw credentials in userinfo.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  let cleaned = rawUrl
    .replace(/\/bot[0-9]{6,15}:[A-Za-z0-9_-]{20,64}/gi, '/bot[REDACTED_TOKEN]')
    .replace(TELEGRAM_BOT_TOKEN_REGEX, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(
      /([?&](?:token|secret|password|api_key|apikey|access_token|auth|key)=)[^&#\s]+/gi,
      '$1[REDACTED]'
    );
  try {
    const parsed = new URL(cleaned);
    if (parsed.username || parsed.password) {
      parsed.username = '[REDACTED]';
      parsed.password = '[REDACTED]';
      cleaned = parsed.toString();
    }
  } catch {
    // Relative path or non-standard URI; regex sanitization already applied
  }
  return cleaned;
}

