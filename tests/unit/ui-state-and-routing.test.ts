import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { MockWhatsAppSessionDriver } from '../../src/whatsapp/connection-manager';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { OperationRateLimiter } from '../../src/security/validation';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { TelegramBotController } from '../../src/bot/bot';
import { createGrammyAuthorizationMiddleware } from '../../src/bot/middleware/authorization';
import { AppConfig } from '../../src/config/env';
import { TelegramMessageTransport } from '../../src/bot/ui-state';
import { InlineKeyboardRows } from '../../src/bot/keyboards/main-menu';

const ADMIN_ID = 777000111;

function createTestEnvironment() {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tg-ui-state-'));
  const authDir = path.join(baseTmp, 'whatsapp-sessions');
  const uploadDir = path.join(baseTmp, 'tmp');

  const config: AppConfig = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_integration_suite',
    TELEGRAM_ADMIN_ID: ADMIN_ID,
    DATABASE_PATH: ':memory:',
    WHATSAPP_AUTH_DIR: authDir,
    TEMP_UPLOAD_DIR: uploadDir,
    LOG_LEVEL: 'silent',
    MAX_CONCURRENT_TASKS: 2,
    TASK_TIMEOUT_MS: 5000,
    MAX_UPLOAD_SIZE_MB: 10,
  };

  const db = new AppDatabase(':memory:');
  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const auditRepo = new AuditRepository(db);

  const sessionStore = new SessionStore(authDir);
  const mockDrivers = new Map<string, MockWhatsAppSessionDriver>();

  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId) => {
      const drv = new MockWhatsAppSessionDriver(sessionId);
      drv.simulatedDelayMs = 10;
      mockDrivers.set(sessionId, drv);
      return drv;
    }
  );

  const rateLimiter = new OperationRateLimiter(50, 60_000, 100);
  const sendMessageOp = new SendMessageOperation(sessionManager, rateLimiter);
  const sendMediaOp = new SendMediaOperation(sessionManager, rateLimiter);
  const groupOps = new GroupOperations(sessionManager, auditRepo, rateLimiter);

  const taskRunner = new TaskRunner(
    taskRepo,
    config.MAX_CONCURRENT_TASKS,
    config.TASK_TIMEOUT_MS
  );
  const taskManager = new TaskManager(taskRepo, auditRepo, taskRunner);

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

  return {
    baseTmp,
    config,
    db,
    auditRepo,
    settingsRepo,
    sessionManager,
    controller,
    cleanup: async () => {
      await sessionManager.shutdownAll();
      db.close();
      fs.rmSync(baseTmp, { recursive: true, force: true });
    },
  };
}

function createTrackingTransport() {
  let nextMessageId = 100;
  const sentMessages: Array<{
    id: number;
    text: string;
    keyboard: InlineKeyboardRows;
  }> = [];
  const editedMessages: Array<{
    id: number;
    text: string;
    keyboard: InlineKeyboardRows;
  }> = [];
  const deletedMessageIds: number[] = [];
  const pinnedMessageIds: number[] = [];
  const unpinnedMessageIds: Array<number | undefined> = [];

  const allocateId = () => {
    const id = nextMessageId++;
    return id;
  };

  const transport: TelegramMessageTransport & {
    allocateChatMessageId: () => number;
    sentMessages: typeof sentMessages;
    editedMessages: typeof editedMessages;
    deletedMessageIds: typeof deletedMessageIds;
    pinnedMessageIds: typeof pinnedMessageIds;
    unpinnedMessageIds: typeof unpinnedMessageIds;
  } = {
    allocateChatMessageId: allocateId,
    sentMessages,
    editedMessages,
    deletedMessageIds,
    pinnedMessageIds,
    unpinnedMessageIds,
    sendNewMessage: async (text: string, keyboard: InlineKeyboardRows) => {
      const id = allocateId();
      sentMessages.push({ id, text, keyboard });
      return { messageId: id };
    },
    editMessageText: async (
      messageId: number,
      text: string,
      keyboard: InlineKeyboardRows
    ) => {
      editedMessages.push({ id: messageId, text, keyboard });
    },
    editMessageReplyMarkup: async (
      messageId: number,
      keyboard: InlineKeyboardRows
    ) => {
      editedMessages.push({ id: messageId, text: '', keyboard });
    },
    deleteMessage: async (messageId: number) => {
      deletedMessageIds.push(messageId);
    },
    pinMessage: async (messageId: number) => {
      pinnedMessageIds.push(messageId);
    },
    unpinMessage: async (messageId: number) => {
      unpinnedMessageIds.push(messageId);
    },
    answerCallbackQuery: async () => undefined,
  };

  return transport;
}

test('Single Exclusive ActiveInputOwner prevents pairing phone input from opening the Send Text Message window after visiting menu:send_text', async () => {
  const env = createTestEnvironment();
  try {
    const { controller, sessionManager } = env;
    const session = sessionManager.createSession('Session-Test-1', ADMIN_ID);
    await sessionManager.initiatePairing({
      sessionId: session.id,
      rawPhoneNumber: '+966501111111',
      actorTelegramId: ADMIN_ID,
    });

    // 1. User opens "Send Text Message" (`menu:send_text`) -> messageWorkflow enters AWAITING_RECIPIENT
    const sendTextView = await controller.handleCallbackQuery(
      ADMIN_ID,
      'menu:send_text'
    );
    assert.ok(sendTextView.text.includes('إرسال رسالة نصية'));
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'SEND_TEXT');
    assert.ok(controller.messageWorkflow.getState(ADMIN_ID) !== undefined);

    // 2. User navigates to Sessions list (`menu:sessions`) -> cancels SEND_TEXT and resets owner to NONE
    await controller.handleCallbackQuery(ADMIN_ID, 'menu:sessions');
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'NONE');
    assert.equal(controller.messageWorkflow.getState(ADMIN_ID), undefined);

    // 3. User clicks `sess:repair:<id>` to pair a phone number
    const pairPrompt = await controller.handleCallbackQuery(
      ADMIN_ID,
      `sess:repair:${session.id}`
    );
    assert.ok(pairPrompt.text.includes('إعادة ربط الجلسة'));
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'PAIRING');
    assert.ok(controller.pairingWorkflow.getState(ADMIN_ID) !== undefined);
    assert.equal(controller.messageWorkflow.getState(ADMIN_ID), undefined);

    // 4. User enters their phone number `+967775224395`
    const pairResult = await controller.handleTextMessage(
      ADMIN_ID,
      '+967775224395'
    );
    // Must generate the 8-character pairing code and NEVER open "إرسال رسالة نصية"
    assert.ok(pairResult.text.includes('رمز الربط'));
    assert.ok(!pairResult.text.includes('أرسل نص الرسالة المطلوب'));
    assert.equal(controller.messageWorkflow.getState(ADMIN_ID), undefined);
  } finally {
    await env.cleanup();
  }
});

test('ActiveInputOwner === PAIRING stays locked on invalid phone input and never falls through to messageWorkflow', async () => {
  const env = createTestEnvironment();
  try {
    const { controller, sessionManager } = env;
    const session = sessionManager.createSession('Session-Test-2', ADMIN_ID);
    await sessionManager.initiatePairing({
      sessionId: session.id,
      rawPhoneNumber: '+966501112222',
      actorTelegramId: ADMIN_ID,
    });

    // Previously visited menu:send_text
    await controller.handleCallbackQuery(ADMIN_ID, 'menu:send_text');
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'SEND_TEXT');

    // User switches to menu:link_account
    await controller.handleCallbackQuery(ADMIN_ID, 'menu:link_account');
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'PAIRING');
    assert.equal(controller.messageWorkflow.getState(ADMIN_ID), undefined);

    // User enters an invalid short phone number "123"
    const invalidResult = await controller.handleTextMessage(ADMIN_ID, '123');
    assert.ok(invalidResult.text.includes('تعذر إتمام الربط'));
    assert.ok(!invalidResult.text.includes('إرسال رسالة نصية'));
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'PAIRING');
    assert.equal(controller.messageWorkflow.getState(ADMIN_ID), undefined);

    // User then enters valid phone number "+967775224395"
    const validResult = await controller.handleTextMessage(
      ADMIN_ID,
      '+967775224395'
    );
    assert.ok(validResult.text.includes('رمز الربط'));
    assert.equal(controller.uiState.getActiveInputOwner(ADMIN_ID), 'NONE');
  } finally {
    await env.cleanup();
  }
});

test('Bottom-Anchored Control Panel re-sends at bottom, deletes old buried message, and pins new message when buried', async () => {
  const env = createTestEnvironment();
  try {
    const { controller } = env;
    const transport = createTrackingTransport();

    // 1. Initial /start sends message #100 and pins it
    await controller.handleStartCommand(ADMIN_ID, {
      transport,
      chatId: ADMIN_ID,
    });
    assert.equal(transport.sentMessages.length, 1);
    const firstPanelId = transport.sentMessages[0].id;
    assert.equal(controller.uiState.getActiveMessageId(ADMIN_ID), firstPanelId);
    assert.ok(transport.pinnedMessageIds.includes(firstPanelId));

    // 2. Pure inline button click (`menu:link_account`) when NOT buried edits message #100 in-place
    await controller.handleCallbackQuery(ADMIN_ID, 'menu:link_account', {
      transport,
      chatId: ADMIN_ID,
    });
    assert.equal(transport.sentMessages.length, 1);
    assert.equal(transport.editedMessages.length, 1);
    assert.equal(transport.editedMessages[0].id, firstPanelId);
    const allButtons = transport.editedMessages[0].keyboard.flat();
    assert.ok(allButtons.some((btn) => btn.callbackData === 'workflow:cancel'));

    // 3. User sends a text message in chat (message #101 > #100), burying panel #100
    const userMsgId = transport.allocateChatMessageId();
    await controller.handleTextMessage(
      ADMIN_ID,
      '+967775224395',
      undefined,
      {
        transport,
        chatId: ADMIN_ID,
        userMessageId: userMsgId,
      }
    );

    // Because userMsgId (#101) > firstPanelId (#100), deliverView sends a brand-new panel (#102) at the bottom,
    // deletes the old buried panel (#100), and pins the new panel (#102)!
    assert.equal(transport.sentMessages.length, 2);
    const secondPanelId = transport.sentMessages[1].id;
    assert.ok(secondPanelId > userMsgId);
    assert.ok(transport.deletedMessageIds.includes(firstPanelId));
    assert.ok(transport.pinnedMessageIds.includes(secondPanelId));
    assert.equal(controller.uiState.getActiveMessageId(ADMIN_ID), secondPanelId);
  } finally {
    await env.cleanup();
  }
});

test('createGrammyAuthorizationMiddleware ignores pinned_message service updates from the bot itself without sending Unauthorized reply', async () => {
  const env = createTestEnvironment();
  try {
    const middleware = createGrammyAuthorizationMiddleware(
      ADMIN_ID,
      env.auditRepo,
      env.settingsRepo
    );
    const replies: string[] = [];
    const deletedServiceMessages: number[] = [];
    let nextCalled = false;

    const fakePinnedServiceCtx = {
      from: { id: 9191532217, is_bot: true },
      me: { id: 9191532217, is_bot: true },
      chat: { id: ADMIN_ID },
      message: {
        message_id: 555,
        pinned_message: { message_id: 554, text: 'لوحة التحكم' },
      },
      api: {
        deleteMessage: async (_chatId: number, msgId: number) => {
          deletedServiceMessages.push(msgId);
        },
      },
      reply: async (msg: string) => {
        replies.push(msg);
      },
    };

    await middleware(fakePinnedServiceCtx as never, async () => {
      nextCalled = true;
    });

    assert.equal(replies.length, 0);
    assert.equal(nextCalled, false);
    assert.deepEqual(deletedServiceMessages, [555]);
  } finally {
    await env.cleanup();
  }
});
