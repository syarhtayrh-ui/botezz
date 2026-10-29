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
  backupExists?: boolean;
  recoveredFromBackup?: boolean;
  meJid?: string;
  errorReason?: string;
}

/**
 * Manages isolated filesystem directories for each WhatsApp account's authentication state.
 * Enforces restrictive 0o700 permissions, distinguishes between registered credentials
 * and incomplete pairing files, supports automatic `.bak` self-healing recovery,
 * and prevents path traversal or cross-session leakage.
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

  private parseAndValidateCredsRaw(raw: string): {
    valid: boolean;
    registered: boolean;
    isMockMarker: boolean;
    meJid?: string;
    errorReason?: string;
  } {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {
        valid: false,
        registered: false,
        isMockMarker: false,
        errorReason: 'ملف بيانات المصادقة (creds.json) فارغ أو تالف.',
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        valid: false,
        registered: false,
        isMockMarker: false,
        errorReason: 'ملف بيانات المصادقة (creds.json) تالف ولا يحتوي على JSON صالح.',
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        valid: false,
        registered: false,
        isMockMarker: false,
        errorReason: 'بنية ملف بيانات المصادقة (creds.json) غير صالحة.',
      };
    }

    if (parsed.mode === 'SIMULATED_AUTH_MARKER') {
      const isReg = parsed.registered !== false;
      return {
        valid: true,
        registered: isReg,
        isMockMarker: true,
      };
    }

    const meObj = parsed.me as { id?: string } | undefined;
    const meJid =
      typeof meObj?.id === 'string' && meObj.id.length > 0 ? meObj.id : undefined;
    const hasNoiseKey = Boolean(parsed.noiseKey && typeof parsed.noiseKey === 'object');
    const hasIdentityKey = Boolean(
      parsed.signedIdentityKey && typeof parsed.signedIdentityKey === 'object'
    );

    if (!hasNoiseKey || !hasIdentityKey) {
      return {
        valid: false,
        registered: false,
        isMockMarker: false,
        errorReason:
          'ملف بيانات المصادقة يفتقد مفاتيح التشفير الأساسية (Noise / Identity Keys).',
      };
    }

    const hasAccountIdentity = Boolean(
      parsed.account && typeof parsed.account === 'object'
    );
    const isRegisteredFlag = parsed.registered === true;
    const isAuthenticated = (isRegisteredFlag || hasAccountIdentity) && Boolean(meJid);

    return {
      valid: true,
      registered: isAuthenticated,
      isMockMarker: false,
      meJid,
    };
  }

  /**
   * Inspects the session's `creds.json` without logging any secrets.
   * If `creds.json` is corrupted/missing but a valid `creds.json.bak` exists,
   * automatically restores `creds.json` atomically and reports `recoveredFromBackup: true`.
   */
  public inspectCredentials(sessionId: string): CredentialInspectionResult {
    try {
      const safeDir = resolveSafeChildPath(this.baseDir, sessionId);
      const credsFile = path.join(safeDir, 'creds.json');
      const bakFile = path.join(safeDir, 'creds.json.bak');
      const primaryExists = fs.existsSync(credsFile);
      const backupExists = fs.existsSync(bakFile);

      if (!primaryExists && !backupExists) {
        return {
          exists: false,
          corrupted: false,
          registered: false,
          isMockMarker: false,
          backupExists: false,
          recoveredFromBackup: false,
        };
      }

      if (primaryExists) {
        const raw = fs.readFileSync(credsFile, 'utf-8');
        const check = this.parseAndValidateCredsRaw(raw);
        if (check.valid) {
          // Ensure a `.bak` copy exists if this is a registered credential
          if (check.registered && !backupExists) {
            try {
              fs.copyFileSync(credsFile, bakFile);
              fs.chmodSync(bakFile, 0o600);
            } catch {
              // Best-effort backup sync
            }
          }
          return {
            exists: true,
            corrupted: false,
            registered: check.registered,
            isMockMarker: check.isMockMarker,
            backupExists: backupExists || check.registered,
            recoveredFromBackup: false,
            meJid: check.meJid,
          };
        }

        // Primary is corrupted; attempt automatic self-healing from `creds.json.bak`
        if (backupExists) {
          try {
            const bakRaw = fs.readFileSync(bakFile, 'utf-8');
            const bakCheck = this.parseAndValidateCredsRaw(bakRaw);
            if (bakCheck.valid) {
              const tmpHeal = `${credsFile}.heal.${Date.now()}.tmp`;
              fs.writeFileSync(tmpHeal, bakRaw, { mode: 0o600 });
              fs.renameSync(tmpHeal, credsFile);
              log.warn(
                'Healed corrupted creds.json automatically from creds.json.bak',
                { sessionId }
              );
              return {
                exists: true,
                corrupted: false,
                registered: bakCheck.registered,
                isMockMarker: bakCheck.isMockMarker,
                backupExists: true,
                recoveredFromBackup: true,
                meJid: bakCheck.meJid,
              };
            }
          } catch {
            // Backup recovery failed; fall through to corrupted result
          }
        }

        return {
          exists: true,
          corrupted: true,
          registered: false,
          isMockMarker: false,
          backupExists,
          recoveredFromBackup: false,
          errorReason: check.errorReason,
        };
      }

      // Primary missing, but backup exists -> heal primary from backup
      if (backupExists) {
        try {
          const bakRaw = fs.readFileSync(bakFile, 'utf-8');
          const bakCheck = this.parseAndValidateCredsRaw(bakRaw);
          if (bakCheck.valid) {
            const tmpHeal = `${credsFile}.heal.${Date.now()}.tmp`;
            fs.writeFileSync(tmpHeal, bakRaw, { mode: 0o600 });
            fs.renameSync(tmpHeal, credsFile);
            log.warn('Restored missing creds.json from creds.json.bak', { sessionId });
            return {
              exists: true,
              corrupted: false,
              registered: bakCheck.registered,
              isMockMarker: bakCheck.isMockMarker,
              backupExists: true,
              recoveredFromBackup: true,
              meJid: bakCheck.meJid,
            };
          }
        } catch {
          // Ignore
        }
      }

      return {
        exists: false,
        corrupted: false,
        registered: false,
        isMockMarker: false,
        backupExists,
        recoveredFromBackup: false,
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
   * without storing any real secrets. Also writes a `.bak` copy for atomic parity.
   */
  public writeMockAuthMarker(
    sessionId: string,
    maskedPhone: string,
    registered = true
  ): void {
    const safeDir = this.prepareSessionAuthDir(sessionId);
    const credsFile = path.join(safeDir, 'creds.json');
    const bakFile = path.join(safeDir, 'creds.json.bak');
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
    const tmpFile = `${credsFile}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, data, { mode: 0o600 });
    fs.renameSync(tmpFile, credsFile);
    if (registered) {
      fs.writeFileSync(bakFile, data, { mode: 0o600 });
    }
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
