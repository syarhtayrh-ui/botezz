import fs from 'node:fs';
import path from 'node:path';
import { resolveSafeChildPath } from '../security/validation';
import { createLogger } from '../logging/logger';

const log = createLogger('session-store');

export interface CredentialInspectionResult {
  exists: boolean;
  corrupted: boolean;
  registered: boolean;
  isMockMarker: boolean;
  meJid?: string;
  errorReason?: string;
}

/**
 * Manages isolated filesystem directories for each WhatsApp account's authentication state.
 * Enforces restrictive 0o700 permissions, distinguishes between registered credentials
 * and incomplete pairing files, and prevents path traversal or cross-session leakage.
 */
export class SessionStore {
  public readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.ensureBaseDirectory();
  }

  private ensureBaseDirectory(): void {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    } else {
      try {
        fs.chmodSync(this.baseDir, 0o700);
      } catch {
        // Ignore on platforms that don't support POSIX chmod
      }
    }
  }

  /**
   * Resolves and initializes an isolated directory for a specific session ID.
   */
  public prepareSessionAuthDir(sessionId: string): string {
    const safeDir = resolveSafeChildPath(this.baseDir, sessionId);
    if (!fs.existsSync(safeDir)) {
      fs.mkdirSync(safeDir, { recursive: true, mode: 0o700 });
    } else {
      try {
        fs.chmodSync(safeDir, 0o700);
      } catch {
        // Ignore chmod failure if not supported
      }
    }
    return safeDir;
  }

  /**
   * Inspects the session's `creds.json` without logging any secrets.
   * Distinguishes between:
   * - Missing credentials (`exists: false`)
   * - Corrupted/unparseable JSON (`corrupted: true`)
   * - Incomplete/unregistered pairing attempt (`exists: true, registered: false`)
   * - Completed authenticated session (`exists: true, registered: true`)
   */
  public inspectCredentials(sessionId: string): CredentialInspectionResult {
    try {
      const safeDir = resolveSafeChildPath(this.baseDir, sessionId);
      const credsFile = path.join(safeDir, 'creds.json');
      if (!fs.existsSync(credsFile)) {
        return {
          exists: false,
          corrupted: false,
          registered: false,
          isMockMarker: false,
        };
      }

      const raw = fs.readFileSync(credsFile, 'utf-8').trim();
      if (!raw) {
        return {
          exists: true,
          corrupted: true,
          registered: false,
          isMockMarker: false,
          errorReason: 'ملف بيانات المصادقة (creds.json) فارغ أو تالف.',
        };
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {
          exists: true,
          corrupted: true,
          registered: false,
          isMockMarker: false,
          errorReason: 'ملف بيانات المصادقة (creds.json) تالف ولا يحتوي على JSON صالح.',
        };
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          exists: true,
          corrupted: true,
          registered: false,
          isMockMarker: false,
          errorReason: 'بنية ملف بيانات المصادقة (creds.json) غير صالحة.',
        };
      }

      if (parsed.mode === 'SIMULATED_AUTH_MARKER') {
        const isReg = parsed.registered !== false;
        return {
          exists: true,
          corrupted: false,
          registered: isReg,
          isMockMarker: true,
        };
      }

      const meObj = parsed.me as { id?: string } | undefined;
      const meJid = typeof meObj?.id === 'string' && meObj.id.length > 0 ? meObj.id : undefined;
      const hasNoiseKey = Boolean(parsed.noiseKey && typeof parsed.noiseKey === 'object');
      const hasIdentityKey = Boolean(
        parsed.signedIdentityKey && typeof parsed.signedIdentityKey === 'object'
      );

      if (!hasNoiseKey || !hasIdentityKey) {
        return {
          exists: true,
          corrupted: true,
          registered: false,
          isMockMarker: false,
          errorReason: 'ملف بيانات المصادقة يفتقد مفاتيح التشفير الأساسية (Noise / Identity Keys).',
        };
      }

      const hasAccountIdentity = Boolean(parsed.account && typeof parsed.account === 'object');
      const isRegisteredFlag = parsed.registered === true;
      const isAuthenticated = (isRegisteredFlag || hasAccountIdentity) && Boolean(meJid);

      return {
        exists: true,
        corrupted: false,
        registered: isAuthenticated,
        isMockMarker: false,
        meJid,
      };
    } catch {
      return {
        exists: false,
        corrupted: false,
        registered: false,
        isMockMarker: false,
      };
    }
  }

  /**
   * Returns true if and only if the session has valid, authenticated credentials on disk.
   * Unfinished pairing-attempt folders (`registered: false` without `account`) return false.
   */
  public hasRegisteredCredentials(sessionId: string): boolean {
    const info = this.inspectCredentials(sessionId);
    return info.exists && !info.corrupted && info.registered;
  }

  /**
   * Checks whether valid persisted authentication credentials exist for a session.
   */
  public hasPersistedCredentials(sessionId: string): boolean {
    return this.hasRegisteredCredentials(sessionId);
  }

  /**
   * Cleans any leftover unregistered or corrupted pairing state before starting a fresh
   * pairing flow so `athanasia-baileys` `validateConnection()` sees `creds.me === undefined`
   * and sends `generateRegistrationNode` instead of `generateLoginNode`.
   */
  public resetUnregisteredAuthDir(sessionId: string, forceReset = false): string {
    const safeDir = resolveSafeChildPath(this.baseDir, sessionId);
    if (fs.existsSync(safeDir)) {
      const info = this.inspectCredentials(sessionId);
      if (forceReset || !info.registered || info.corrupted) {
        fs.rmSync(safeDir, { recursive: true, force: true });
      }
    }
    return this.prepareSessionAuthDir(sessionId);
  }

  /**
   * Writes a marker file for simulated/mock authenticated sessions in test/harness mode
   * without storing any real secrets.
   */
  public writeMockAuthMarker(
    sessionId: string,
    maskedPhone: string,
    registered = true
  ): void {
    const safeDir = this.prepareSessionAuthDir(sessionId);
    const credsFile = path.join(safeDir, 'creds.json');
    const data = JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'SIMULATED_AUTH_MARKER',
        registered,
        sessionId,
        maskedPhone,
        persistedAt: new Date().toISOString(),
      },
      null,
      2
    );
    const tmpFile = `${credsFile}.tmp`;
    fs.writeFileSync(tmpFile, data, { mode: 0o600 });
    fs.renameSync(tmpFile, credsFile);
  }

  /**
   * Securely removes a session's isolated authentication directory.
   */
  public removeSessionAuthDir(sessionId: string): void {
    const safeDir = resolveSafeChildPath(this.baseDir, sessionId);
    if (fs.existsSync(safeDir)) {
      fs.rmSync(safeDir, { recursive: true, force: true });
      log.info('Removed isolated session auth directory', { sessionId });
    }
  }
}
