import { validateEnv } from './config/env';
import { AppDatabase } from './database/database';
import { SessionRepository } from './database/repositories/session-repository';
import { TaskRepository } from './database/repositories/task-repository';
import { SettingsRepository } from './database/repositories/settings-repository';
import { AuditRepository } from './database/repositories/audit-repository';
import { FunctionLabRepository } from './database/repositories/function-lab-repository';
import { MessageSender, MediaProcessor } from './whatsapp/message-capabilities';
import { SessionStore } from './whatsapp/session-store';
import { AthanasiaBaileysSessionDriver } from './whatsapp/connection-manager';
import { SessionManager } from './whatsapp/session-manager';
import { SendMessageOperation } from './whatsapp/operations/send-message';
import { SendMediaOperation } from './whatsapp/operations/send-media';
import { GroupOperations } from './whatsapp/operations/group-operations';
import { OperationRateLimiter } from './security/validation';
import { TaskRunner } from './tasks/task-runner';
import { TaskManager } from './tasks/task-manager';
import { TelegramBotController, createGrammyBot } from './bot/bot';
import { ShutdownManager } from './utils/shutdown';
import { createLogger } from './logging/logger';

const log = createLogger('app');

/**
 * Standalone Production Entrypoint (`npm run bot:start`).
 * Validates environment variables, initializes SQLite and migrations, restores authenticated
 * Athanasia Baileys WhatsApp sessions, starts the grammY Telegram Bot polling loop, and registers SIGINT/SIGTERM graceful shutdown.
 */
export async function startStandaloneBotApplication(): Promise<void> {
  const config = validateEnv(process.env);
  const shutdownManager = new ShutdownManager();

  log.info('Starting WhatsApp Multi-Session Management System (athanasia-baileys)...', {
    nodeEnv: config.NODE_ENV,
    maxConcurrentTasks: config.MAX_CONCURRENT_TASKS,
  });

  const db = new AppDatabase(config.DATABASE_PATH);
  shutdownManager.register('sqlite-database', () => db.close());

  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const auditRepo = new AuditRepository(db);
  const functionLabRepo = new FunctionLabRepository(db);
  const messageSender = new MessageSender(functionLabRepo);
  const mediaProcessor = new MediaProcessor({
    maxMediaSizeMb: config.MAX_UPLOAD_SIZE_MB,
    tempDir: config.TEMP_UPLOAD_DIR,
  });

  const sessionStore = new SessionStore(config.WHATSAPP_AUTH_DIR);
  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId, authDir) =>
      new AthanasiaBaileysSessionDriver(sessionId, authDir, messageSender)
  );
  shutdownManager.register('whatsapp-sessions', () =>
    sessionManager.shutdownAll()
  );

  const rateLimiter = new OperationRateLimiter(15, 60_000, 10_000, {
    profileProvider: () =>
      settingsRepo.get('rate_limit_profile', 'STANDARD') === 'STRICT'
        ? 'STRICT'
        : 'STANDARD',
  });
  const sendMessageOp = new SendMessageOperation(
    sessionManager,
    rateLimiter,
    messageSender
  );
  const sendMediaOp = new SendMediaOperation(
    sessionManager,
    rateLimiter,
    messageSender,
    mediaProcessor
  );
  const groupOps = new GroupOperations(sessionManager, auditRepo, rateLimiter);

  const taskRunner = new TaskRunner(
    taskRepo,
    config.MAX_CONCURRENT_TASKS,
    config.TASK_TIMEOUT_MS
  );
  const taskManager = new TaskManager(taskRepo, auditRepo, taskRunner);

  // Restore previously authenticated sessions from disk
  await sessionManager.restoreSessionsOnStartup();

  const controller = new TelegramBotController({
    config,
    sessionManager,
    taskManager,
    sendMessageOp,
    sendMediaOp,
    groupOps,
    auditRepo,
    settingsRepo,
  });

  const bot = createGrammyBot(controller, config, auditRepo);
  sessionManager.setDisconnectAlertHandler(({ session, newStatus, reasonAr }) => {
    const notifySetting = settingsRepo.get('notify_on_disconnect', 'ENABLED');
    if (notifySetting !== 'ENABLED') return;
    const alertText =
      `🔔 *تنبيه حالة جلسة واتساب (${newStatus})*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📛 *الجلسة:* ${session.label} (\`${session.id}\`)\n` +
      `📱 *الرقم:* \`${session.masked_phone || 'غير مقترن'}\`\n` +
      `📌 *الحالة الجديدة:* \`${newStatus}\`\n` +
      `⚠️ *السبب:* ${reasonAr}`;
    void bot.api
      .sendMessage(config.TELEGRAM_ADMIN_ID, alertText, {
        parse_mode: 'Markdown',
      })
      .catch((err) => {
        log.warn('Failed to send disconnect notification to admin', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });

  shutdownManager.register('telegram-bot', async () => {
    await bot.stop();
  });

  process.once('SIGINT', () => {
    void shutdownManager.shutdown('SIGINT').then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdownManager.shutdown('SIGTERM').then(() => process.exit(0));
  });

  log.info('Telegram Bot starting long-polling...');
  await bot.start({
    onStart: (botInfo) => {
      log.info('Telegram Bot is online and polling', {
        botUsername: botInfo.username,
      });
    },
  });
}

// Run if invoked directly as main script
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('src/app.ts')
) {
  startStandaloneBotApplication().catch((err) => {
    log.error('Fatal startup error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
