import fs from 'node:fs';
import path from 'node:path';
import { resolveSafeChildPath } from '../security/validation';
import { createLogger } from '../logging/logger';

const log = createLogger('session-store');

/**
 * Manages isolated filesystem directories for each WhatsApp account's authentication state.
 * Enforces restrictive 0o700 permissions and prevents path traversal or cross-session leakage.
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
   * Checks whether persisted authentication state files exist for a session.
   */
  public hasPersistedCredentials(sessionId: string): boolean {
    try {
      const safeDir = resolveSafeChildPath(this.baseDir, sessionId);
      const credsFile = path.join(safeDir, 'creds.json');
      return fs.existsSync(credsFile);
    } catch {
      return false;
    }
  }

  /**
   * Writes a marker file for simulated/mock authenticated sessions in test/harness mode
   * without storing any real secrets.
   */
  public writeMockAuthMarker(sessionId: string, maskedPhone: string): void {
    const safeDir = this.prepareSessionAuthDir(sessionId);
    const credsFile = path.join(safeDir, 'creds.json');
    const data = JSON.stringify(
      {
        schemaVersion: 1,
        mode: 'SIMULATED_AUTH_MARKER',
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
