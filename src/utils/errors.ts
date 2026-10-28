import { redactText } from '../security/redaction';

export type ErrorCategory =
  | 'AUTHORIZATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'WHATSAPP_CONNECTION_ERROR'
  | 'PAIRING_ERROR'
  | 'AUTHENTICATION_EXPIRED'
  | 'DATABASE_ERROR'
  | 'FILESYSTEM_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'TASK_TIMEOUT'
  | 'RATE_LIMIT_EXCEEDED'
  | 'TELEGRAM_API_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly category: ErrorCategory;
  public readonly arabicUserMessage: string;
  public readonly isOperational: boolean;

  constructor(
    category: ErrorCategory,
    arabicUserMessage: string,
    technicalMessage?: string,
    isOperational = true
  ) {
    super(redactText(technicalMessage || arabicUserMessage));
    this.name = this.constructor.name;
    this.category = category;
    this.arabicUserMessage = redactText(arabicUserMessage);
    this.isOperational = isOperational;
  }
}

export class AuthorizationError extends AppError {
  constructor(
    arabicMessage = '⛔ غير مصرح لك باستخدام هذا البوت. هذه اللوحة مخصصة للمسؤول المعتمد فقط.',
    technicalMessage?: string
  ) {
    super('AUTHORIZATION_ERROR', arabicMessage, technicalMessage);
  }
}

export class ValidationError extends AppError {
  constructor(arabicMessage: string, technicalMessage?: string) {
    super('VALIDATION_ERROR', arabicMessage, technicalMessage);
  }
}

export class WhatsAppConnectionError extends AppError {
  constructor(arabicMessage: string, technicalMessage?: string) {
    super('WHATSAPP_CONNECTION_ERROR', arabicMessage, technicalMessage);
  }
}

export class PairingError extends AppError {
  constructor(arabicMessage: string, technicalMessage?: string) {
    super('PAIRING_ERROR', arabicMessage, technicalMessage);
  }
}

export class TaskTimeoutError extends AppError {
  constructor(
    arabicMessage = 'انتهت مهلة تنفيذ العملية قبل استلام تأكيد من جلسة واتساب.',
    technicalMessage?: string
  ) {
    super('TASK_TIMEOUT', arabicMessage, technicalMessage);
  }
}

export class RateLimitError extends AppError {
  constructor(arabicMessage: string, technicalMessage?: string) {
    super('RATE_LIMIT_EXCEEDED', arabicMessage, technicalMessage);
  }
}

export class UnsupportedOperationError extends AppError {
  constructor(
    arabicMessage = 'هذه العملية غير مدعومة حالياً في البروتوكول أو لا يملك الحساب الصلاحية اللازمة.',
    technicalMessage?: string
  ) {
    super('UNSUPPORTED_OPERATION', arabicMessage, technicalMessage);
  }
}

export class DatabaseError extends AppError {
  constructor(
    arabicMessage = 'حدث خطأ في قاعدة البيانات أثناء حفظ أو قراءة السجلات.',
    technicalMessage?: string
  ) {
    super('DATABASE_ERROR', arabicMessage, technicalMessage);
  }
}

/**
 * Converts any thrown error into a sanitized Arabic message safe for display in Telegram.
 * Correctly classifies Baileys Boom errors, WebSocket disconnects, Telegram parse errors,
 * and timeouts while strictly redacting sensitive credentials and tokens.
 */
export function toSafeArabicError(err: unknown): {
  category: ErrorCategory;
  userMessage: string;
  sanitizedTechnicalMessage: string;
} {
  if (
    err instanceof AppError ||
    (err !== null &&
      typeof err === 'object' &&
      'arabicUserMessage' in err &&
      'category' in err)
  ) {
    const appErr = err as AppError;
    return {
      category: appErr.category,
      userMessage: redactText(appErr.arabicUserMessage),
      sanitizedTechnicalMessage: redactText(appErr.message || appErr.arabicUserMessage),
    };
  }

  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'description' in err
        ? String((err as { description?: unknown }).description)
        : String(err ?? '');

  const lower = rawMessage.toLowerCase();

  const boomStatusCode =
    err !== null &&
    typeof err === 'object' &&
    'output' in err &&
    typeof (err as { output?: { statusCode?: unknown } }).output?.statusCode === 'number'
      ? ((err as { output: { statusCode: number } }).output.statusCode)
      : undefined;

  // 1. WhatsApp / Baileys Connection, Handshake, or Disconnect errors
  if (
    boomStatusCode === 405 ||
    lower.includes('connection failure') ||
    lower.includes('connection closed') ||
    lower.includes('connection terminated') ||
    lower.includes('websocket error') ||
    lower.includes('stream errored') ||
    lower.includes('disconnectreason') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('ehostunreach')
  ) {
    const userMessage =
      boomStatusCode === 405
        ? 'رفض خادم واتساب مصافحة البروتوكول أو تسجيل الجلسة (رمز 405). يرجى المحاولة مرة أخرى.'
        : 'تعذر الاتصال بخوادم واتساب أو انقطع اتصال المقبس مؤقتاً. يرجى المحاولة مرة أخرى بعد لحظات.';
    return {
      category: 'WHATSAPP_CONNECTION_ERROR',
      userMessage,
      sanitizedTechnicalMessage: redactText(
        boomStatusCode ? `${rawMessage} (statusCode=${boomStatusCode})` : rawMessage
      ),
    };
  }

  // 2. Query / Operation Timeouts
  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout')
  ) {
    return {
      category: 'TASK_TIMEOUT',
      userMessage:
        'انتهت مهلة استجابة خوادم واتساب قبل إتمام العملية. يرجى التحقق من اتصال الشبكة وإعادة المحاولة.',
      sanitizedTechnicalMessage: redactText(rawMessage),
    };
  }

  // 3. Telegram API parse or interaction errors
  if (
    lower.includes("can't parse entities") ||
    lower.includes('parse mode') ||
    lower.includes('message to edit not found') ||
    lower.includes('grammyerror')
  ) {
    return {
      category: 'TELEGRAM_API_ERROR',
      userMessage:
        'تعذر تحديث واجهة الرسالة في تيليجرام. يرجى استخدام القائمة الرئيسية /start لإعادة ضبط العرض.',
      sanitizedTechnicalMessage: redactText(rawMessage),
    };
  }

  // 4. Validation errors
  if (
    lower.includes('validation') ||
    lower.includes('صيغة') ||
    lower.includes('رقم الهاتف')
  ) {
    return {
      category: 'VALIDATION_ERROR',
      userMessage: redactText(rawMessage),
      sanitizedTechnicalMessage: redactText(rawMessage),
    };
  }

  if (err instanceof Error) {
    return {
      category: 'INTERNAL_ERROR',
      userMessage: 'حدث خطأ غير متوقع أثناء تنفيذ العملية. تم تسجيل التفاصيل بأمان في سجل الخادم.',
      sanitizedTechnicalMessage: redactText(err.message),
    };
  }

  return {
    category: 'INTERNAL_ERROR',
    userMessage: 'حدث خطأ غير معروف أثناء تنفيذ العملية.',
    sanitizedTechnicalMessage: redactText(String(err)),
  };
}
