import { loadRuntimeConfig, AppConfig } from './config/env';
import { AppDatabase } from './database/database';
import { SessionRepository } from './database/repositories/session-repository';
import { TaskRepository } from './database/repositories/task-repository';
import { SettingsRepository } from './database/repositories/settings-repository';
import { AuditRepository } from './database/repositories/audit-repository';
import { FunctionLabRepository } from './database/repositories/function-lab-repository';
import { MessageSender, MediaProcessor } from './whatsapp/message-capabilities';
import { SessionStore } from './whatsapp/session-store';
import { MockWhatsAppSessionDriver } from './whatsapp/connection-manager';
import { SessionManager } from './whatsapp/session-manager';
import { SendMessageOperation } from './whatsapp/operations/send-message';
import { SendMediaOperation } from './whatsapp/operations/send-media';
import { GroupOperations } from './whatsapp/operations/group-operations';
import { OperationRateLimiter } from './security/validation';
import { TaskRunner } from './tasks/task-runner';
import { TaskManager } from './tasks/task-manager';
import { TelegramBotController } from './bot/bot';
import { BotViewResponse } from './bot/workflows/pairing-workflow';

export interface HarnessSingleton {
  config: AppConfig;
  isLiveConfigured: boolean;
  validationIssues: string[];
  db: AppDatabase;
  sessionRepo: SessionRepository;
  sessionManager: SessionManager;
  taskManager: TaskManager;
  auditRepo: AuditRepository;
  settingsRepo: SettingsRepository;
  controller: TelegramBotController;
  lastBotView: BotViewResponse;
}

const globalForHarness = globalThis as unknown as {
  __waTelegramHarness?: HarnessSingleton;
};

export async function getRuntimeHarness(): Promise<HarnessSingleton> {
  if (globalForHarness.__waTelegramHarness) {
    return globalForHarness.__waTelegramHarness;
  }

  const { config, isLiveConfigured, validationIssues } = loadRuntimeConfig(process.env);
  const db = new AppDatabase(config.DATABASE_PATH);

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
    (sessionId) => new MockWhatsAppSessionDriver(sessionId, messageSender)
  );

  const rateLimiter = new OperationRateLimiter(30, 60_000, 3_000, {
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

  // Only run simulated startup restoration and demo seeding when NOT sharing a live production database
  if (!isLiveConfigured) {
    await sessionManager.restoreSessionsOnStartup();

    // Seed 2 deterministic simulated sessions if database is empty so multi-session journeys work out of the box
    if (sessionRepo.listAll().length === 0) {
      const s1 = sessionManager.createSession(
        'حساب العمليات الرئيسي (محاكاة)',
        config.TELEGRAM_ADMIN_ID
      );
      await sessionManager.initiatePairing({
        sessionId: s1.id,
        rawPhoneNumber: '+966501234567',
        actorTelegramId: config.TELEGRAM_ADMIN_ID,
        autoCompleteInMock: true,
      });

      const s2 = sessionManager.createSession(
        'حساب مساندة العملاء (محاكاة)',
        config.TELEGRAM_ADMIN_ID
      );
      await sessionManager.initiatePairing({
        sessionId: s2.id,
        rawPhoneNumber: '+966558889999',
        actorTelegramId: config.TELEGRAM_ADMIN_ID,
        autoCompleteInMock: true,
      });
    }
  }

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

  const rawInitialView = controller.startHandler.renderMainMenu({ isAdmin: true });
  const initialView = await controller.uiState.deliverView({
    userId: config.TELEGRAM_ADMIN_ID,
    view: rawInitialView,
    pendingWorkflow: 'NONE',
    preferEdit: false,
  });

  const instance: HarnessSingleton = {
    config,
    isLiveConfigured,
    validationIssues,
    db,
    sessionRepo,
    sessionManager,
    taskManager,
    auditRepo,
    settingsRepo,
    controller,
    lastBotView: initialView,
  };

  globalForHarness.__waTelegramHarness = instance;
  return instance;
}
