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
import {
  getNetworkTrafficMonitor,
  NetworkTrafficMonitor,
} from './network/network-traffic-monitor';

export interface HarnessSingleton {
  config: AppConfig;
  isLiveConfigured: boolean;
  isReadOnlyWebObserver: boolean;
  validationIssues: string[];
  db: AppDatabase;
  sessionRepo: SessionRepository;
  sessionManager: SessionManager;
  taskManager: TaskManager;
  auditRepo: AuditRepository;
  settingsRepo: SettingsRepository;
  controller: TelegramBotController;
  networkMonitor: NetworkTrafficMonitor;
  lastBotView: BotViewResponse;
  getFreshBotView: () => BotViewResponse;
}

const DESTRUCTIVE_SESSION_CALLBACK_PREFIXES = [
  'sess:disconnect:',
  'sess:remove:',
  'sess:reconnect:',
  'sess:repair:',
  'sess:purge_inactive',
  'sessions:delete:',
  'sessions:remove:',
  'sessions:disconnect:',
  'menu:link_account',
  'menu:add_account',
  'menu:pair',
];

const DESTRUCTIVE_SESSION_COMMANDS = [
  '/requestpair',
  '/addsender',
  '/resetsession',
  '/delete',
  '/disconnect',
];

export function isDestructiveLiveSessionAction(input: {
  text?: string;
  callbackData?: string;
}): boolean {
  const cb = input.callbackData?.trim() || '';
  if (cb) {
    if (
      DESTRUCTIVE_SESSION_CALLBACK_PREFIXES.some(
        (prefix) => cb === prefix || cb.startsWith(prefix)
      )
    ) {
      return true;
    }
  }
  const txt = input.text?.trim().toLowerCase() || '';
  if (txt) {
    if (
      DESTRUCTIVE_SESSION_COMMANDS.some(
        (cmd) => txt === cmd || txt.startsWith(`${cmd} `)
      )
    ) {
      return true;
    }
  }
  return false;
}

const globalForHarness = globalThis as unknown as {
  __waTelegramHarness?: HarnessSingleton;
  __waTelegramHarnessPromise?: Promise<HarnessSingleton>;
};

async function createRuntimeHarness(): Promise<HarnessSingleton> {
  const { config, isLiveConfigured, validationIssues } = loadRuntimeConfig(process.env);
  const isTestEnv = process.env.NODE_ENV === 'test';

  // Isolate demo simulation database and auth directories from live production storage (BZ-015)
  const effectiveDbPath =
    !isLiveConfigured && !isTestEnv && !process.env.DATABASE_PATH
      ? './data/harness_demo.db'
      : config.DATABASE_PATH;
  const effectiveAuthDir =
    !isLiveConfigured && !isTestEnv && !process.env.WHATSAPP_AUTH_DIR
      ? './data/harness_sessions'
      : config.WHATSAPP_AUTH_DIR;

  const effectiveConfig: AppConfig = {
    ...config,
    DATABASE_PATH: effectiveDbPath,
    WHATSAPP_AUTH_DIR: effectiveAuthDir,
  };

  const db = new AppDatabase(effectiveConfig.DATABASE_PATH);

  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const auditRepo = new AuditRepository(db);
  const functionLabRepo = new FunctionLabRepository(db);
  const messageSender = new MessageSender(functionLabRepo);
  const mediaProcessor = new MediaProcessor({
    maxMediaSizeMb: effectiveConfig.MAX_UPLOAD_SIZE_MB,
    tempDir: effectiveConfig.TEMP_UPLOAD_DIR,
  });

  const sessionStore = new SessionStore(effectiveConfig.WHATSAPP_AUTH_DIR);
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
    effectiveConfig.MAX_CONCURRENT_TASKS,
    effectiveConfig.TASK_TIMEOUT_MS
  );
  const taskManager = new TaskManager(taskRepo, auditRepo, taskRunner);

  // Only run simulated startup restoration and demo seeding when NOT sharing a live production database
  if (!isLiveConfigured) {
    await sessionManager.restoreSessionsOnStartup();

    // Seed 2 deterministic simulated sessions if database is empty so multi-session journeys work out of the box
    if (sessionRepo.listAll().length === 0) {
      const s1 = sessionManager.createSession(
        'حساب العمليات الرئيسي (محاكاة)',
        effectiveConfig.TELEGRAM_ADMIN_ID
      );
      await sessionManager.initiatePairing({
        sessionId: s1.id,
        rawPhoneNumber: '+966501234567',
        actorTelegramId: effectiveConfig.TELEGRAM_ADMIN_ID,
        autoCompleteInMock: true,
      });

      const s2 = sessionManager.createSession(
        'حساب مساندة العملاء (محاكاة)',
        effectiveConfig.TELEGRAM_ADMIN_ID
      );
      await sessionManager.initiatePairing({
        sessionId: s2.id,
        rawPhoneNumber: '+966558889999',
        actorTelegramId: effectiveConfig.TELEGRAM_ADMIN_ID,
        autoCompleteInMock: true,
      });
    }
  }

  const controller = new TelegramBotController({
    config: effectiveConfig,
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
    userId: effectiveConfig.TELEGRAM_ADMIN_ID,
    view: rawInitialView,
    pendingWorkflow: 'NONE',
    preferEdit: false,
  });

  const networkMonitor = getNetworkTrafficMonitor();
  if (!isLiveConfigured && networkMonitor.getMetrics().totalEntries === 0) {
    networkMonitor.recordWhatsAppStanza({
      sessionId: 'sess_bootstrap',
      direction: 'OUTBOUND',
      node: {
        tag: 'iq',
        attrs: {
          id: 'boot_usync_1',
          to: 's.whatsapp.net',
          type: 'get',
          xmlns: 'usync',
        },
        content: [
          {
            tag: 'usync',
            attrs: { mode: 'query', context: 'interactive' },
            content: [
              {
                tag: 'query',
                attrs: {},
                content: [
                  { tag: 'contact', attrs: {} },
                  { tag: 'lid', attrs: {} },
                  { tag: 'devices', attrs: { version: '2' } },
                ],
              },
            ],
          },
        ],
      },
      responseNode: {
        tag: 'iq',
        attrs: { id: 'boot_usync_1', from: 's.whatsapp.net', type: 'result' },
        content: [
          {
            tag: 'usync',
            attrs: {},
            content: [
              {
                tag: 'list',
                attrs: {},
                content: [
                  {
                    tag: 'user',
                    attrs: { jid: '966501234567@s.whatsapp.net' },
                    content: [{ tag: 'lid', attrs: { val: '192837465@lid' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
      durationMs: 42,
      statusCode: 'RESULT',
    });
  }

  const instance: HarnessSingleton = {
    config: effectiveConfig,
    isLiveConfigured,
    isReadOnlyWebObserver: isLiveConfigured,
    validationIssues,
    db,
    sessionRepo,
    sessionManager,
    taskManager,
    auditRepo,
    settingsRepo,
    controller,
    networkMonitor,
    lastBotView: initialView,
    getFreshBotView() {
      const liveCallView = controller.videoCallWorkflow.renderLiveCallStatusView(
        effectiveConfig.TELEGRAM_ADMIN_ID
      );
      if (liveCallView) {
        instance.lastBotView = liveCallView;
      }
      return instance.lastBotView;
    },
  };

  const syncLiveCallView = () => {
    const liveCallView = controller.videoCallWorkflow.renderLiveCallStatusView(
      effectiveConfig.TELEGRAM_ADMIN_ID
    );
    if (liveCallView) {
      instance.lastBotView = liveCallView;
    }
  };

  controller.videoCallBridge.on('call:state', syncLiveCallView);
  controller.videoCallBridge.on('call:ended', syncLiveCallView);

  globalForHarness.__waTelegramHarness = instance;
  return instance;
}

export async function getRuntimeHarness(): Promise<HarnessSingleton> {
  if (globalForHarness.__waTelegramHarness) {
    return globalForHarness.__waTelegramHarness;
  }
  if (!globalForHarness.__waTelegramHarnessPromise) {
    globalForHarness.__waTelegramHarnessPromise = createRuntimeHarness().catch((err) => {
      globalForHarness.__waTelegramHarnessPromise = undefined;
      throw err;
    });
  }
  return globalForHarness.__waTelegramHarnessPromise;
}
