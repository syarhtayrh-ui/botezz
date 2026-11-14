import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Parses standard `.env` file content into key-value pairs.
 * Supports:
 * - UTF-8 BOM and CRLF (`\r\n`) line endings
 * - `export KEY=VALUE` prefix
 * - Single-quoted (`'...'`) and double-quoted (`"..."`) values
 * - Unquoted inline comments (`KEY=value # comment`)
 */
export function parseDotEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const normalized = content.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice(7).trim()
      : trimmed;
    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let rawValue = withoutExport.slice(eqIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2)
    ) {
      rawValue = rawValue.slice(1, -1);
    } else {
      const commentIdx = rawValue.indexOf(' #');
      if (commentIdx !== -1) {
        rawValue = rawValue.slice(0, commentIdx).trim();
      }
    }

    result[key] = rawValue;
  }

  return result;
}

/**
 * Automatically loads `.env` from disk into `process.env` so standalone scripts
 * (`npm run bot:start`, `tsx src/app.ts`, PM2, systemd) always receive `.env` variables.
 */
export function loadDotEnvIntoProcessEnv(
  customEnvPath?: string,
  overrideExisting = false
): { loadedFrom?: string; loadedKeys: string[] } {
  const candidatePaths = [
    customEnvPath,
    process.env.ENV_FILE_PATH,
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../.env'),
  ].filter((p): p is string => Boolean(p && p.trim().length > 0));

  for (const filePath of candidatePaths) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        continue;
      }
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const parsed = parseDotEnvContent(rawContent);
      const loadedKeys: string[] = [];

      for (const [key, value] of Object.entries(parsed)) {
        if (value === '') {
          continue;
        }
        const currentVal = process.env[key];
        if (
          overrideExisting ||
          currentVal === undefined ||
          currentVal.trim() === ''
        ) {
          process.env[key] = value;
          loadedKeys.push(key);
        }
      }

      return { loadedFrom: filePath, loadedKeys };
    } catch {
      // Ignore unreadable candidate path and try next
    }
  }

  return { loadedKeys: [] };
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .trim()
    .min(10, 'TELEGRAM_BOT_TOKEN must be a valid Telegram Bot API token'),
  TELEGRAM_ADMIN_ID: z
    .string()
    .trim()
    .regex(/^\d+$/, 'TELEGRAM_ADMIN_ID must be a numeric Telegram User ID')
    .transform((val) => Number(val))
    .refine((val) => Number.isSafeInteger(val) && val > 0, {
      message: 'TELEGRAM_ADMIN_ID must be a positive safe integer',
    }),
  DATABASE_PATH: z.string().trim().min(1).default('./data/app.sqlite'),
  WHATSAPP_AUTH_DIR: z.string().trim().min(1).default('./data/whatsapp-sessions'),
  TEMP_UPLOAD_DIR: z.string().trim().min(1).default('./data/tmp'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  MAX_CONCURRENT_TASKS: z
    .union([z.string(), z.number()])
    .default('3')
    .transform((val) => Number(val))
    .refine((val) => Number.isInteger(val) && val >= 1 && val <= 25, {
      message: 'MAX_CONCURRENT_TASKS must be an integer between 1 and 25',
    }),
  TASK_TIMEOUT_MS: z
    .union([z.string(), z.number()])
    .default('120000')
    .transform((val) => Number(val))
    .refine((val) => Number.isInteger(val) && val >= 1000 && val <= 600000, {
      message: 'TASK_TIMEOUT_MS must be between 1000 and 600000 ms',
    }),
  MAX_UPLOAD_SIZE_MB: z
    .union([z.string(), z.number()])
    .default('20')
    .transform((val) => Number(val))
    .refine((val) => Number.isInteger(val) && val >= 1 && val <= 100, {
      message: 'MAX_UPLOAD_SIZE_MB must be between 1 and 100 MB',
    }),
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Strictly validates environment variables at startup.
 * Automatically loads `.env` from disk when validating `process.env`.
 * Fails fast with a clear, actionable diagnostic message if required variables are missing or malformed.
 */
export function validateEnv(
  rawEnv: Record<string, string | undefined> = process.env
): AppConfig {
  if (rawEnv === process.env) {
    loadDotEnvIntoProcessEnv();
  }
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Startup Configuration Validation Failed:\n${issues}\nPlease check your .env file against .env.example.`
    );
  }
  return parsed.data;
}

/**
 * Loads configuration for the embedded web harness / simulator when live Telegram credentials
 * are not yet provided in environment variables. Clearly flags whether live credentials exist.
 */
export function loadRuntimeConfig(
  rawEnv: Record<string, string | undefined> = process.env
): {
  config: AppConfig;
  isLiveConfigured: boolean;
  validationIssues: string[];
} {
  if (rawEnv === process.env) {
    loadDotEnvIntoProcessEnv();
  }
  const strictResult = envSchema.safeParse(rawEnv);
  if (strictResult.success) {
    return {
      config: strictResult.data,
      isLiveConfigured: true,
      validationIssues: [],
    };
  }

  const issues = strictResult.error.issues.map(
    (i) => `${i.path.join('.')}: ${i.message}`
  );

  // Fallback configuration strictly for local interactive harness / test runner
  // Note: Default admin ID in harness is 100000001 and explicitly marked as non-live.
  const fallbackConfig: AppConfig = {
    NODE_ENV:
      rawEnv.NODE_ENV === 'production' || rawEnv.NODE_ENV === 'test'
        ? rawEnv.NODE_ENV
        : 'development',
    TELEGRAM_BOT_TOKEN: 'HARNESS_UNCONFIGURED_TOKEN',
    TELEGRAM_ADMIN_ID:
      rawEnv.TELEGRAM_ADMIN_ID && /^\d+$/.test(rawEnv.TELEGRAM_ADMIN_ID.trim())
        ? Number(rawEnv.TELEGRAM_ADMIN_ID.trim())
        : 100000001,
    DATABASE_PATH: rawEnv.DATABASE_PATH?.trim() || './data/app.sqlite',
    WHATSAPP_AUTH_DIR:
      rawEnv.WHATSAPP_AUTH_DIR?.trim() || './data/whatsapp-sessions',
    TEMP_UPLOAD_DIR: rawEnv.TEMP_UPLOAD_DIR?.trim() || './data/tmp',
    LOG_LEVEL: 'info',
    MAX_CONCURRENT_TASKS: 3,
    TASK_TIMEOUT_MS: 120000,
    MAX_UPLOAD_SIZE_MB: 20,
  };

  return {
    config: fallbackConfig,
    isLiveConfigured: false,
    validationIssues: issues,
  };
}
