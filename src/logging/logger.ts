import pino from 'pino';
import { redactObject, redactText } from '../security/redaction';

const pinoInstance = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'token',
      'botToken',
      'TELEGRAM_BOT_TOKEN',
      'pairingCode',
      'creds',
      'keys',
      'authState',
      '*.token',
      '*.pairingCode',
      '*.creds',
      '*.keys',
      '*.privateKey',
    ],
    censor: '[REDACTED]',
  },
});

export interface SafeLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(component: string): SafeLogger {
  const child = pinoInstance.child({ component });
  return {
    info(msg: string, meta?: Record<string, unknown>) {
      child.info(meta ? redactObject(meta) : {}, redactText(msg));
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      child.warn(meta ? redactObject(meta) : {}, redactText(msg));
    },
    error(msg: string, meta?: Record<string, unknown>) {
      child.error(meta ? redactObject(meta) : {}, redactText(msg));
    },
    debug(msg: string, meta?: Record<string, unknown>) {
      child.debug(meta ? redactObject(meta) : {}, redactText(msg));
    },
  };
}

export const logger = createLogger('system');
