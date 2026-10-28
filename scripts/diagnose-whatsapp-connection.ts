import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState as loadMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
} from 'athanasia-baileys';
import {
  resolveWhatsAppWebVersion,
  AthanasiaBaileysSessionDriver,
} from '../src/whatsapp/connection-manager';
import { maskPhoneNumber } from '../src/security/redaction';

interface DiagnosticEventLog {
  offsetMs: number;
  phase: string;
  details: Record<string, unknown>;
}

async function runIsolatedConnectionDiagnostic(): Promise<void> {
  const startTs = Date.now();
  const events: DiagnosticEventLog[] = [];
  const record = (phase: string, details: Record<string, unknown> = {}) => {
    const entry: DiagnosticEventLog = {
      offsetMs: Date.now() - startTs,
      phase,
      details,
    };
    events.push(entry);
    console.log(
      JSON.stringify({
        t: `+${entry.offsetMs}ms`,
        phase: entry.phase,
        ...entry.details,
      })
    );
  };

  // Read installed athanasia-baileys package metadata
  const pkgPath = path.resolve(
    process.cwd(),
    'node_modules/athanasia-baileys/package.json'
  );
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    name: string;
    version: string;
  };

  record('ENVIRONMENT_INFO', {
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    libraryName: pkgJson.name,
    libraryVersion: pkgJson.version,
  });

  // 1. Inspect version resolution mechanisms
  const baileysVerResult = await fetchLatestBaileysVersion({
    signal: AbortSignal.timeout(5_000),
  });
  record('VERSION_CHECK_BAILEYS_DEFAULT', {
    version: baileysVerResult.version.join('.'),
    isLatest: baileysVerResult.isLatest,
    errorType:
      baileysVerResult.error instanceof Error
        ? baileysVerResult.error.name
        : typeof baileysVerResult.error,
    errorMessage:
      baileysVerResult.error instanceof Error
        ? baileysVerResult.error.message
        : undefined,
  });

  const waWebVerResult = await fetchLatestWaWebVersion({
    signal: AbortSignal.timeout(8_000),
  });
  record('VERSION_CHECK_WA_WEB_LIVE', {
    version: waWebVerResult.version.join('.'),
    isLatest: waWebVerResult.isLatest,
  });

  const resolvedVer = await resolveWhatsAppWebVersion(true);
  record('VERSION_RESOLVED_FOR_DRIVER', {
    version: resolvedVer.version.join('.'),
    source: resolvedVer.source,
    isLatest: resolvedVer.isLatest,
  });

  // Optional: Reproduce legacy 405 failure when DIAG_REPRODUCE_405=1 is set
  if (process.env.DIAG_REPRODUCE_405 === '1') {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-diag-legacy405-'));
    try {
      const { state } = await loadMultiFileAuthState(legacyDir);
      record('LEGACY_405_SOCKET_START', {
        version: baileysVerResult.version.join('.'),
      });
      await new Promise<void>((resolve) => {
        const sock = makeWASocket({
          version: baileysVerResult.version,
          auth: state,
          printQRInTerminal: false,
          logger: pino({ level: 'silent' }),
          browser: Browsers.ubuntu('Chrome'),
        });
        const timer = setTimeout(() => {
          try {
            sock.end(undefined);
          } catch {
            // ignore
          }
          resolve();
        }, 8_000);
        sock.ev.on('connection.update', (u) => {
          const err = u.lastDisconnect?.error as
            | (Error & {
                output?: { statusCode?: number };
                data?: Record<string, unknown>;
              })
            | undefined;
          record('LEGACY_405_CONNECTION_UPDATE', {
            connection: u.connection,
            handshakeReady: Boolean(u.qr),
            errorType: err?.constructor?.name,
            errorMessage: err?.message,
            statusCode: err?.output?.statusCode,
            disconnectData: err?.data,
          });
          if (u.connection === 'close' || u.qr) {
            clearTimeout(timer);
            try {
              sock.end(undefined);
            } catch {
              // ignore
            }
            resolve();
          }
        });
      });
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }
  }

  // 2. Test actual production driver (`AthanasiaBaileysSessionDriver`) handshake readiness
  const tempAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-diag-driver-'));
  const driver = new AthanasiaBaileysSessionDriver('diag_session', tempAuthDir);
  let handshakeReadyReached = false;
  let disconnectCode: number | undefined;
  let disconnectMessage: string | undefined;

  try {
    record('DRIVER_CONNECT_START', {
      waVersion: resolvedVer.version.join('.'),
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Diagnostic timeout (15s) waiting for handshake readiness'));
      }, 15_000);

      void driver
        .connect({
          onStatusChange: (evt) => {
            record('DRIVER_STATUS_EVENT', {
              status: evt.status,
              statusCode: evt.statusCode,
              errorMessage: evt.errorMessage,
              isRegistered: evt.isRegistered,
            });

            if (evt.status === 'AWAITING_PAIRING') {
              handshakeReadyReached = true;
              clearTimeout(timeout);
              resolve();
            } else if (evt.status === 'DISCONNECTED' || evt.status === 'LOGGED_OUT') {
              disconnectCode = evt.statusCode;
              disconnectMessage = evt.errorMessage;
              clearTimeout(timeout);
              resolve();
            }
          },
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });

    const diag = driver.getSocketDiagnostics();
    record('DRIVER_HANDSHAKE_DIAGNOSTICS', {
      handshakeReadyReached,
      socketActive: diag.socketActive,
      wsOpen: diag.wsOpen,
      handshakeReady: diag.handshakeReady,
      connectionState: diag.connectionState,
      disconnectCode,
      disconnectMessage,
    });

    // 3. Only if a real phone number is explicitly provided via DIAG_PHONE_NUMBER, test requestPairingCode
    const realPhoneEnv = process.env.DIAG_PHONE_NUMBER?.trim();
    if (handshakeReadyReached && realPhoneEnv) {
      const cleanDigits = realPhoneEnv.replace(/\D/g, '');
      record('PAIRING_CODE_REQUEST_START', {
        maskedPhone: maskPhoneNumber(`+${cleanDigits}`),
      });
      try {
        const formattedCode = await driver.requestPairingCode(cleanDigits);
        const postDiag = driver.getSocketDiagnostics();
        record('PAIRING_CODE_REQUEST_RESULT', {
          codeGenerated: Boolean(formattedCode && formattedCode.length === 9),
          codeLength: formattedCode.replace(/-/g, '').length,
          socketStillOpen: postDiag.wsOpen,
          connectionState: postDiag.connectionState,
        });
      } catch (pairErr) {
        record('PAIRING_CODE_REQUEST_ERROR', {
          errorType: pairErr instanceof Error ? pairErr.constructor.name : typeof pairErr,
          errorMessage: pairErr instanceof Error ? pairErr.message : String(pairErr),
        });
        throw pairErr;
      }
    } else if (handshakeReadyReached) {
      record('PAIRING_CODE_SKIPPED_NO_PHONE', {
        note: 'Socket reached AWAITING_PAIRING (Noise + pair-device ready). Set DIAG_PHONE_NUMBER to test live companion_hello with a real WhatsApp number.',
      });
    }

    if (!handshakeReadyReached) {
      process.exitCode = 1;
    }
  } finally {
    await driver.disconnect();
    fs.rmSync(tempAuthDir, { recursive: true, force: true });
    record('DIAGNOSTIC_CLEANUP_COMPLETE');
  }
}

runIsolatedConnectionDiagnostic()
  .then(() => {
    process.exit(process.exitCode || 0);
  })
  .catch((err) => {
    console.error(
      JSON.stringify({
        phase: 'FATAL_DIAGNOSTIC_ERROR',
        errorType: err instanceof Error ? err.constructor.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    );
    process.exit(1);
  });
