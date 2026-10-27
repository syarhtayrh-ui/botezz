/**
 * Security Redaction Utilities
 * Ensures sensitive values (Telegram Bot tokens, WhatsApp pairing codes,
 * private keys, raw authentication state, and full phone numbers) never leak into logs or error reports.
 */

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
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
 * Redacts sensitive patterns from arbitrary text strings.
 */
export function redactText(input: string): string {
  if (!input) return input;
  return input
    .replace(TELEGRAM_BOT_TOKEN_REGEX, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(PAIRING_CODE_FORMAT_REGEX, '[REDACTED_PAIRING_CODE]');
}

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
