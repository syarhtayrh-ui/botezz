import crypto from 'node:crypto';
import type { SessionRecord } from '../database/repositories/session-repository';
import type { AuditLogRecord } from '../database/repositories/audit-repository';
import { redactObject } from './redaction';

export const ADMIN_SESSION_COOKIE_NAME = 'botezz_admin_session';

export interface WebAuthCheckInput {
  headers?: { get(name: string): string | null } | Record<string, string | string[] | undefined>;
  cookies?: { get(name: string): { value: string } | undefined } | Record<string, string | undefined>;
}

export interface WebAuthCheckResult {
  authorized: boolean;
  authRequired: boolean;
  status: number;
  errorArabic?: string;
}

export type ClientSafeSessionDto = Omit<SessionRecord, 'auth_dir'> & {
  auth_dir?: undefined;
};

export type ClientSafeAuditDto = AuditLogRecord;

export function timingSafeStringMatch(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const candidateDigest = crypto.createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return (
    candidate.length === expected.length &&
    crypto.timingSafeEqual(candidateDigest, expectedDigest)
  );
}

export function computeAdminSessionToken(secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update('botezz_admin_authenticated_v1', 'utf8')
    .digest('hex');
}

function readHeader(
  headers: WebAuthCheckInput['headers'],
  name: string
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const val = (headers as { get(k: string): string | null }).get(name);
    return val ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function readCookie(
  cookies: WebAuthCheckInput['cookies'],
  name: string
): string | undefined {
  if (!cookies) return undefined;
  if (typeof (cookies as { get?: unknown }).get === 'function') {
    return (cookies as { get(k: string): { value: string } | undefined }).get(name)?.value;
  }
  const record = cookies as Record<string, string | undefined>;
  return record[name];
}

export function extractBearerToken(authorizationHeader?: string): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1]?.trim();
}

export function verifyWebRequestAuth(input: WebAuthCheckInput = {}): WebAuthCheckResult {
  const configuredSecret = process.env.DASHBOARD_API_SECRET?.trim() || '';
  const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();

  if (configuredSecret.length > 0) {
    const headerSecret =
      readHeader(input.headers, 'x-api-secret')?.trim() ||
      extractBearerToken(readHeader(input.headers, 'authorization'));
    const cookieToken = readCookie(input.cookies, ADMIN_SESSION_COOKIE_NAME)?.trim();
    const expectedCookieToken = computeAdminSessionToken(configuredSecret);

    const headerValid = headerSecret
      ? timingSafeStringMatch(headerSecret, configuredSecret)
      : false;
    const cookieValid = cookieToken
      ? timingSafeStringMatch(cookieToken, expectedCookieToken) ||
        timingSafeStringMatch(cookieToken, configuredSecret)
      : false;

    if (headerValid || cookieValid) {
      return {
        authorized: true,
        authRequired: true,
        status: 200,
      };
    }

    return {
      authorized: false,
      authRequired: true,
      status: 401,
      errorArabic:
        'غير مصرح بالوصول إلى واجهة التحكم. يرجى تسجيل الدخول بمفتاح DASHBOARD_API_SECRET الصحيح.',
    };
  }

  if (nodeEnv === 'production') {
    return {
      authorized: false,
      authRequired: true,
      status: 401,
      errorArabic:
        'تم حظر الوصول في بيئة الإنتاج لعدم ضبط المتغير الأمني DASHBOARD_API_SECRET.',
    };
  }

  return {
    authorized: true,
    authRequired: false,
    status: 200,
  };
}

export function maskJidForDisplay(jid?: string | null): string | null {
  if (!jid) return null;
  const [userPart, domainPart] = jid.split('@');
  if (!userPart || !domainPart) return '***';
  const baseUser = userPart.split(':')[0] || userPart;
  if (baseUser.length <= 4) {
    return `***@${domainPart}`;
  }
  return `${baseUser.slice(0, 3)}***${baseUser.slice(-2)}@${domainPart}`;
}

export function toClientSafeSessionDto(session: SessionRecord): ClientSafeSessionDto {
  const { auth_dir: _omittedAuthDir, ...rest } = session;
  void _omittedAuthDir;
  return {
    ...rest,
    jid: maskJidForDisplay(session.jid),
  };
}

export function toClientSafeAuditDto(log: AuditLogRecord): ClientSafeAuditDto {
  let sanitizedMetadata = log.metadata_json;
  if (sanitizedMetadata) {
    try {
      const parsed = JSON.parse(sanitizedMetadata) as Record<string, unknown>;
      delete parsed.authDir;
      delete parsed.auth_dir;
      delete parsed.filePath;
      delete parsed.videoFilePath;
      sanitizedMetadata = JSON.stringify(redactObject(parsed));
    } catch {
      sanitizedMetadata = null;
    }
  }
  return {
    ...log,
    metadata_json: sanitizedMetadata,
  };
}
