import fs from 'node:fs';
import path from 'node:path';
import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap,
} from 'athanasia-baileys';
import { createLogger } from '../logging/logger';

const log = createLogger('atomic-auth-state');

/**
 * Simple FIFO async mutex per file path to serialize concurrent reads/writes/deletes
 * without external race conditions.
 */
class FileMutex {
  private queue: Promise<void> = Promise.resolve();

  public runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

const globalFileLocks = new Map<string, FileMutex>();

function getFileLock(filePath: string): FileMutex {
  let lock = globalFileLocks.get(filePath);
  if (!lock) {
    lock = new FileMutex();
    globalFileLocks.set(filePath, lock);
  }
  return lock;
}

export function sanitizeAuthFileName(file: string): string {
  return file.replace(/\//g, '__').replace(/:/g, '-');
}

/**
 * Atomically writes JSON data to `filePath` via a temporary file + `fsync` + `rename`.
 * Guarantees that a crash or socket teardown mid-write never leaves a 0-byte or half-written file.
 */
export async function atomicWriteJsonFile(
  filePath: string,
  serializedJson: string,
  createBackup = false
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

  const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = `${filePath}.${uniqueSuffix}.tmp`;

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmpPath, 'w', 0o600);
    await handle.writeFile(serializedJson, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;

    await fs.promises.rename(tmpPath, filePath);

    if (createBackup) {
      const bakTmpPath = `${filePath}.bak.${uniqueSuffix}.tmp`;
      const bakPath = `${filePath}.bak`;
      try {
        await fs.promises.copyFile(filePath, bakTmpPath);
        await fs.promises.chmod(bakTmpPath, 0o600).catch(() => undefined);
        await fs.promises.rename(bakTmpPath, bakPath);
      } catch {
        await fs.promises.unlink(bakTmpPath).catch(() => undefined);
      }
    }
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export interface AtomicAuthStateResult {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  flushPendingWrites: () => Promise<void>;
  recoveredFromBackup: boolean;
}

/**
 * Production-hardened, drop-in replacement for `useMultiFileAuthState` in `athanasia-baileys`.
 *
 * Key guarantees over the default library implementation:
 * 1. Atomic writes (`tmp` -> `fsync` -> `rename`) with `0o600` file permissions.
 * 2. Automatic `creds.json.bak` backup whenever valid credentials exist, and automatic self-healing
 *    recovery from `creds.json.bak` if `creds.json` is truncated or corrupted.
 * 3. Tracks all in-flight `creds` and `keys.set` disk writes so `flushPendingWrites()` can be awaited
 *    before socket restart (`515`) or graceful shutdown.
 */
export async function createAtomicMultiFileAuthState(
  folder: string
): Promise<AtomicAuthStateResult> {
  const resolvedFolder = path.resolve(folder);
  const folderInfo = await fs.promises.stat(resolvedFolder).catch(() => null);
  if (folderInfo && !folderInfo.isDirectory()) {
    throw new Error(
      `Expected a directory for WhatsApp session auth state at ${resolvedFolder}`
    );
  }
  if (!folderInfo) {
    await fs.promises.mkdir(resolvedFolder, { recursive: true, mode: 0o700 });
  }

  const pendingWrites = new Set<Promise<unknown>>();
  const trackWrite = <T>(promise: Promise<T>): Promise<T> => {
    pendingWrites.add(promise);
    void promise.finally(() => {
      pendingWrites.delete(promise);
    });
    return promise;
  };

  const writeData = async (
    data: unknown,
    file: string,
    isCredsFile = false
  ): Promise<void> => {
    const filePath = path.join(resolvedFolder, sanitizeAuthFileName(file));
    const lock = getFileLock(filePath);
    const op = lock.runExclusive(async () => {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await atomicWriteJsonFile(filePath, serialized, isCredsFile);
    });
    return trackWrite(op);
  };

  const readData = async (
    file: string
  ): Promise<{ parsed: any; recoveredFromBackup: boolean }> => {
    const filePath = path.join(resolvedFolder, sanitizeAuthFileName(file));
    const lock = getFileLock(filePath);
    return lock.runExclusive(async () => {
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const trimmed = raw.trim();
        if (!trimmed) {
          throw new Error('Empty JSON file');
        }
        return {
          parsed: JSON.parse(trimmed, BufferJSON.reviver),
          recoveredFromBackup: false,
        };
      } catch (primaryErr) {
        if (file === 'creds.json') {
          const bakPath = `${filePath}.bak`;
          try {
            if (fs.existsSync(bakPath)) {
              const bakRaw = (await fs.promises.readFile(bakPath, 'utf-8')).trim();
              if (bakRaw) {
                const recovered = JSON.parse(bakRaw, BufferJSON.reviver);
                await atomicWriteJsonFile(filePath, bakRaw, false);
                log.warn('Recovered corrupted creds.json from creds.json.bak', {
                  folder: path.basename(resolvedFolder),
                });
                return { parsed: recovered, recoveredFromBackup: true };
              }
            }
          } catch {
            // Backup also unreadable
          }
          if (fs.existsSync(filePath)) {
            log.warn('Failed reading primary creds.json and no valid backup available', {
              folder: path.basename(resolvedFolder),
              error:
                primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
            });
          }
        }
        return { parsed: null, recoveredFromBackup: false };
      }
    });
  };

  const removeData = async (file: string): Promise<void> => {
    const filePath = path.join(resolvedFolder, sanitizeAuthFileName(file));
    const lock = getFileLock(filePath);
    const op = lock.runExclusive(async () => {
      await fs.promises.unlink(filePath).catch(() => undefined);
    });
    return trackWrite(op);
  };

  const credsRead = await readData('creds.json');
  const creds: AuthenticationCreds = credsRead.parsed || initAuthCreds();
  const recoveredFromBackup = credsRead.recoveredFromBackup;

  // If primary creds are valid and registered/authenticated, ensure a `.bak` copy exists
  if (
    credsRead.parsed &&
    (creds.registered || creds.account) &&
    creds.me?.id
  ) {
    const credsPath = path.join(resolvedFolder, 'creds.json');
    const bakPath = `${credsPath}.bak`;
    if (fs.existsSync(credsPath) && !fs.existsSync(bakPath)) {
      await fs.promises
        .copyFile(credsPath, bakPath)
        .then(() => fs.promises.chmod(bakPath, 0o600))
        .catch(() => undefined);
    }
  }

  return {
    recoveredFromBackup,
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[]
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              const { parsed } = await readData(`${type}-${id}.json`);
              let value = parsed;
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const categoryData = data[category as keyof SignalDataTypeMap];
            if (!categoryData) continue;
            for (const id in categoryData) {
              const value = categoryData[id];
              const file = `${category}-${id}.json`;
              tasks.push(
                value ? writeData(value, file, false) : removeData(file)
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, 'creds.json', Boolean(creds.registered || creds.account));
    },
    flushPendingWrites: async () => {
      while (pendingWrites.size > 0) {
        await Promise.allSettled(Array.from(pendingWrites));
      }
    },
  };
}
