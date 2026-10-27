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
import { AppConfig } from '../../src/config/env';

function createTestEnvironment() {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tg-int-'));
  const authDir = path.join(baseTmp, 'whatsapp-sessions');
  const uploadDir = path.join(baseTmp, 'tmp');

  const config: AppConfig = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_integration_suite',
    TELEGRAM_ADMIN_ID: 777000111,
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

  const taskRunner = new TaskRunner(taskRepo, config.MAX_CONCURRENT_TASKS, config.TASK_TIMEOUT_MS);
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
    sessionRepo,
    taskRepo,
    settingsRepo,
    auditRepo,
    sessionStore,
    sessionManager,
    taskManager,
    controller,
    mockDrivers,
    cleanup: async () => {
      await sessionManager.shutdownAll();
      db.close();
      fs.rmSync(baseTmp, { recursive: true, force: true });
    },
  };
}

test('Database transactions rollback atomically on error', async () => {
  const env = createTestEnvironment();
  try {
    assert.throws(() => {
      env.db.runInTransaction(() => {
        env.sessionRepo.create({
          id: 'sess_tx_test',
          label: 'Tx Session',
          status: 'INITIALIZING',
          authDir: '/tmp/tx_test',
        });
        throw new Error('Simulated failure inside transaction');
      });
    }, /Simulated failure/);

    assert.equal(env.sessionRepo.findById('sess_tx_test'), undefined);
  } finally {
    await env.cleanup();
  }
});

test('Session creation, pairing workflow, state isolation, restoration, and deletion', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. Start pairing via Telegram Bot Controller
    const step1 = await env.controller.handleCallbackQuery(adminId, 'menu:link_account');
    assert.ok(step1.text.includes('ربط حساب واتساب جديد'));

    // 2. Submit invalid phone number first
    const invalidStep = await env.controller.handleTextMessage(adminId, '050111');
    assert.ok(invalidStep.text.includes('تعذر إتمام الربط'));

    // 3. Submit valid international phone number
    const pairedStep = await env.controller.handleTextMessage(adminId, '+966501234567');
    assert.ok(pairedStep.text.includes('رمز الربط'));
    assert.ok(pairedStep.text.includes('WA96-4567'));

    // 4. Link a second isolated account with custom 8-char Athanasia Baileys pairing code
    await env.controller.handleCallbackQuery(adminId, 'menu:add_account');
    const customPairedStep = await env.controller.handleTextMessage(
      adminId,
      '+966509998888 ATHN2026'
    );
    assert.ok(customPairedStep.text.includes('ATHN-2026'));

    const sessions = env.sessionManager.listSessions();
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0].auth_dir, sessions[1].auth_dir);
    assert.ok(env.sessionStore.hasPersistedCredentials(sessions[0].id));
    assert.ok(env.sessionStore.hasPersistedCredentials(sessions[1].id));

    // 5. Test session restoration logic
    const restoreRes = await env.sessionManager.restoreSessionsOnStartup();
    assert.equal(restoreRes.restoredCount, 2);

    // 6. Remove first session and verify directory is purged
    const firstId = sessions[0].id;
    await env.sessionManager.removeSession(firstId, adminId);
    assert.equal(env.sessionStore.hasPersistedCredentials(firstId), false);
    assert.equal(env.sessionManager.listSessions().length, 1);
  } finally {
    await env.cleanup();
  }
});

test('Multi-session concurrent task execution, partial failures, and cancellation', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // Create and connect 3 sessions
    const s1 = env.sessionManager.createSession('حساب 1', adminId);
    const s2 = env.sessionManager.createSession('حساب 2', adminId);
    const s3 = env.sessionManager.createSession('حساب 3', adminId);

    await env.sessionManager.initiatePairing({
      sessionId: s1.id,
      rawPhoneNumber: '+966501111111',
      actorTelegramId: adminId,
    });
    await env.sessionManager.initiatePairing({
      sessionId: s2.id,
      rawPhoneNumber: '+966502222222',
      actorTelegramId: adminId,
    });
    await env.sessionManager.initiatePairing({
      sessionId: s3.id,
      rawPhoneNumber: '+966503333333',
      actorTelegramId: adminId,
    });

    // Interactive Send Text Message workflow across all 3 sessions
    await env.controller.handleCallbackQuery(adminId, 'menu:send_text');
    await env.controller.handleTextMessage(adminId, '+966559990000');
    const selectView = await env.controller.handleTextMessage(
      adminId,
      'رسالة اختبار متزامنة'
    );
    assert.ok(selectView.text.includes('اختيار الجلسات'));

    const confirmView = await env.controller.handleCallbackQuery(
      adminId,
      'wf_msg:proceed_confirm'
    );
    assert.ok(confirmView.text.includes('ملخص تأكيد إرسال الرسالة النصية'));

    const reportView = await env.controller.handleCallbackQuery(
      adminId,
      'wf_msg:confirm_execute'
    );
    assert.ok(reportView.text.includes('مكتملة بنجاح'));

    // Now simulate a partial failure where s2 fails
    const drv2 = env.mockDrivers.get(s2.id)!;
    drv2.shouldFailSend = true;

    const partialTask = await env.taskManager.runMultiSessionTask({
      operationType: 'SEND_TEXT',
      targetSummary: '+966*****0000',
      selectedSessionIds: [s1.id, s2.id, s3.id],
      actorTelegramId: adminId,
      executor: async (sessId) => {
        const driver = env.sessionManager.getDriver(sessId);
        const res = await driver.sendTextMessage('966559990000@s.whatsapp.net', 'Hello');
        return res.messageId;
      },
    });

    assert.equal(partialTask.status, 'PARTIALLY_COMPLETED');
    const s2Result = partialTask.results.find((r) => r.session_id === s2.id);
    assert.equal(s2Result?.status, 'FAILED');

    // Test cooperative cancellation on queued sessions
    const slowTaskPromise = env.taskManager.runMultiSessionTask({
      operationType: 'SEND_TEXT',
      targetSummary: 'slow_cancel_target',
      selectedSessionIds: [s1.id, s2.id, s3.id],
      actorTelegramId: adminId,
      executor: async (sessId) => {
        await new Promise((r) => setTimeout(r, 80));
        return `done_${sessId}`;
      },
    });

    // Immediately cancel the running task
    const recentTasks = env.taskManager.listRecentTasks(5);
    const runningTask = recentTasks.find((t) => t.target_summary === 'slow_cancel_target');
    if (runningTask) {
      env.taskManager.cancelTask(runningTask.id, adminId);
    }

    const cancelledOutcome = await slowTaskPromise;
    const cancelledSessions = cancelledOutcome.results.filter(
      (r) => r.status === 'CANCELLED'
    );
    assert.ok(cancelledSessions.length >= 1);
  } finally {
    await env.cleanup();
  }
});

test('Group management enforces admin permissions and Join Group workflow executes', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;
    const s1 = env.sessionManager.createSession('حساب المجموعات', adminId);
    await env.sessionManager.initiatePairing({
      sessionId: s1.id,
      rawPhoneNumber: '+966507778888',
      actorTelegramId: adminId,
    });

    // List groups
    const listRes = await env.controller.handleCallbackQuery(
      adminId,
      `grp:list:${s1.id}`
    );
    assert.ok(listRes.text.includes('مجموعة العمليات والتنسيق الإداري'));

    // Try admin action on group where bot is NOT admin (120363042002@g.us)
    const nonAdminRes = await env.controller.handleCallbackQuery(
      adminId,
      `grp:act:${s1.id}:120363042002@g.us:GET_INVITE_LINK`
    );
    assert.ok(nonAdminRes.text.includes('لا يملك الحساب صلاحية مشرف'));

    // Generate invite link on group where bot IS admin (120363041001@g.us)
    const adminRes = await env.controller.handleCallbackQuery(
      adminId,
      `grp:act:${s1.id}:120363041001@g.us:GET_INVITE_LINK`
    );
    assert.ok(adminRes.text.includes('https://chat.whatsapp.com/'));

    // Join group workflow
    await env.controller.handleCallbackQuery(adminId, 'menu:join_group');
    await env.controller.handleTextMessage(
      adminId,
      'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrSt12'
    );
    await env.controller.handleCallbackQuery(adminId, 'wf_join:proceed_confirm');
    const joinExec = await env.controller.handleCallbackQuery(
      adminId,
      'wf_join:confirm_execute'
    );
    assert.ok(joinExec.text.includes('تقرير مهمة الانضمام إلى المجموعة'));
  } finally {
    await env.cleanup();
  }
});

test('Integrated Nebula features: Tools menu, Channel metadata (/cekidch), Sender diagnostics (/ceksender, /cekall), Quick Pairing (/requestpair), Cooldown, and SQLite Subscriptions', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. Quick Pairing via /requestpair with custom 8-char code
    const pairCmdRes = await env.controller.handleTextMessage(
      adminId,
      '/requestpair +966504445555 NEBU2026'
    );
    assert.ok(pairCmdRes.text.includes('NEBU-2026'));

    // 2. Tools menu navigation & Sender Diagnostics (/ceksender, /cekall, /info)
    const toolsMenu = await env.controller.handleCallbackQuery(adminId, 'menu:tools');
    assert.ok(toolsMenu.text.includes('الأدوات والفحص المتقدم'));

    const senderDiag = await env.controller.handleCallbackQuery(
      adminId,
      'tools:ceksender'
    );
    assert.ok(senderDiag.text.includes('تقرير فحص جلسات ومقابس واتساب'));
    assert.ok(senderDiag.text.includes('MockWhatsAppSessionDriver'));

    const checkAll = await env.controller.handleCallbackQuery(adminId, 'tools:cekall');
    assert.ok(checkAll.text.includes('التقرير الشامل للنظام والجلسات'));
    assert.ok(checkAll.text.includes('athanasia-baileys@1.0.0'));

    const infoCard = await env.controller.handleCallbackQuery(adminId, 'tools:info');
    assert.ok(infoCard.text.includes('بطاقة معلومات الحساب'));

    // 3. WhatsApp Channel Metadata Lookup (/cekidch & guided workflow)
    const chPrompt = await env.controller.handleCallbackQuery(
      adminId,
      'tools:prompt_channel'
    );
    assert.ok(chPrompt.text.includes('فحص بيانات قناة واتساب'));

    const chResult = await env.controller.handleTextMessage(
      adminId,
      'https://whatsapp.com/channel/0029VaChannelDemo123'
    );
    assert.ok(chResult.text.includes('بيانات قناة واتساب'));
    assert.ok(chResult.text.includes('@newsletter'));

    // 4. Premium Subscriptions & Claim Groups in SQLite
    const addPrem = await env.controller.handleTextMessage(
      adminId,
      '/addpremium 123456789 30d'
    );
    assert.ok(addPrem.text.includes('تم تفعيل الاشتراك'));

    const addGb = await env.controller.handleTextMessage(
      adminId,
      '/addgb -1001234567890 مجموعة النخبة'
    );
    assert.ok(addGb.text.includes('مجموعة النخبة'));

    const listGb = await env.controller.handleTextMessage(adminId, '/listgb');
    assert.ok(listGb.text.includes('123456789'));
    assert.ok(listGb.text.includes('-1001234567890'));

    const delPrem = await env.controller.handleTextMessage(
      adminId,
      '/delpremium 123456789'
    );
    assert.ok(delPrem.text.includes('تم إلغاء اشتراك المعرف'));

    // 5. Test /testfunction (Reply mode, Inline mode, and Sample callback)
    const testFuncReplyRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966501234567 3 --delay=0',
      'async function customBugProbe(sock, target) { await sock.presenceSubscribe(target); await sock.sendMessage(target, { text: "Probe" }); }'
    );
    assert.ok(testFuncReplyRes.text.includes('تقرير تنفيذ الدالة المخصصة (/testfunction)'));
    assert.ok(testFuncReplyRes.text.includes('customBugProbe'));
    assert.ok(testFuncReplyRes.text.includes('3/3'));

    const testFuncInlineRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction 966559998888 2 --delay=0 async function inlineRelayTest(sock, target) { const msg = generateWAMessageFromContent(target, { extendedTextMessage: { text: "Hi" } }, {}); await sock.relayMessage(target, msg.message, {}); }'
    );
    assert.ok(testFuncInlineRes.text.includes('inlineRelayTest'));
    assert.ok(testFuncInlineRes.text.includes('2/2'));

    const invalidFuncRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction 966559998888 1',
      'function notAsync(sock, target) {}'
    );
    assert.ok(invalidFuncRes.text.includes('غير صالحة'));

    // 6. Command Cooldown enforcement (/setcooldown)
    const setCd = await env.controller.handleTextMessage(adminId, '/setcooldown 5');
    assert.ok(setCd.text.includes('5 ثانية'));

    // Immediate next command within 5s window should be rate-limited by cooldown
    const blockedCmd = await env.controller.handleTextMessage(adminId, '/info');
    assert.ok(blockedCmd.text.includes('الرجاء الانتظار'));

    // Reset cooldown via callback button
    await env.controller.handleCallbackQuery(adminId, 'menu:settings');
  } finally {
    await env.cleanup();
  }
});

test('Deep /testfunction controls: manual maxSends (/settfmax & UI), inline flags (--max, --delay, --session=ALL, --stop-on-error), dynamic sock.setMaxSends, and console capture', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // Pair two connected sessions for multi-session parallel test
    await env.controller.handleTextMessage(adminId, '/requestpair +966501112222');
    await env.controller.handleTextMessage(adminId, '/requestpair +966503334444');

    // 1. Set manual maxSends via /settfmax 2500
    const setMaxRes = await env.controller.handleTextMessage(
      adminId,
      '/settfmax 2500'
    );
    assert.ok(setMaxRes.text.includes('2,500 عملية'));
    assert.equal(env.settingsRepo.getTestFunctionConfig().maxSends, 2500);

    // 2. Guided manual maxSends input via tools:tf_prompt_max callback
    const promptMax = await env.controller.handleCallbackQuery(
      adminId,
      'tools:tf_prompt_max'
    );
    assert.ok(promptMax.text.includes('تحديد الحد الأقصى لعمليات الإرسال يدوياً'));
    const customMaxEntered = await env.controller.handleTextMessage(adminId, '1750');
    assert.ok(customMaxEntered.text.includes('1,750 عملية'));
    assert.equal(env.settingsRepo.getTestFunctionConfig().maxSends, 1750);

    // 3. Test strict custom maxSends enforcement (--max=2 --stop-on-error on 5 iterations)
    const cappedRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966501234567 5 --max=2 --delay=0 --stop-on-error',
      'async function strictCapTest(sock, target) { await sock.sendMessage(target, { text: "ping" }); }'
    );
    assert.ok(cappedRes.text.includes('2/5'));
    assert.ok(cappedRes.text.includes('الحد الأقصى: `2 عملية`'));
    assert.ok(cappedRes.text.includes('RateLimit'));

    // 4. Test multi-session parallel execution (--session=ALL --max=0 unlimited) and console.log capture
    const multiSessRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966501234567 2 --max=0 --delay=0 --session=ALL',
      'async function parallelProbe(sock, target, meta) { console.log("Step", meta.iteration); await sock.sendMessage(target, { text: "multi" }); }'
    );
    assert.ok(multiSessRes.text.includes('4/4'));
    assert.ok(multiSessRes.text.includes('غير محدود (∞)'));
    assert.ok(multiSessRes.text.includes('تفصيل الجلسات المشاركة (2 جلسات بالتوازي)'));
    assert.ok(multiSessRes.text.includes('مخرجات Sandbox Console'));
    assert.ok(multiSessRes.text.includes('Step 1'));
  } finally {
    await env.cleanup();
  }
});

test('Stateful Single-Message UI: editMessageText, editMessageReplyMarkup, "message is not modified" handling, fallback on deleted message, and prompt answerCallbackQuery', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // Seed 2 connected sessions
    const s1 = env.sessionManager.createSession('جلسة 1', adminId);
    const s2 = env.sessionManager.createSession('جلسة 2', adminId);
    await env.sessionManager.initiatePairing({
      sessionId: s1.id,
      rawPhoneNumber: '+966501112222',
      actorTelegramId: adminId,
    });
    await env.sessionManager.initiatePairing({
      sessionId: s2.id,
      rawPhoneNumber: '+966503334444',
      actorTelegramId: adminId,
    });

    // Instrumented mock Telegram transport to verify exact grammY behavior
    const transportCalls = {
      sentMessages: [] as Array<{ id: number; text: string }>,
      editedTexts: [] as Array<{ id: number; text: string }>,
      editedMarkups: [] as Array<{ id: number }>,
      answeredCallbacks: [] as Array<{ text?: string; showAlert?: boolean }>,
      simulateNotModifiedOnNextEdit: false,
      simulateDeletedMessageOnNextEdit: false,
    };
    let nextMsgId = 5000;

    const transport = {
      sendNewMessage: async (text: string) => {
        nextMsgId += 1;
        transportCalls.sentMessages.push({ id: nextMsgId, text });
        return { messageId: nextMsgId };
      },
      editMessageText: async (messageId: number, text: string) => {
        if (transportCalls.simulateNotModifiedOnNextEdit) {
          transportCalls.simulateNotModifiedOnNextEdit = false;
          throw new Error('GrammyError: Call to editMessageText failed! (400: Bad Request: message is not modified)');
        }
        if (transportCalls.simulateDeletedMessageOnNextEdit) {
          transportCalls.simulateDeletedMessageOnNextEdit = false;
          throw new Error('GrammyError: Call to editMessageText failed! (400: Bad Request: message to edit not found)');
        }
        transportCalls.editedTexts.push({ id: messageId, text });
      },
      editMessageReplyMarkup: async (messageId: number) => {
        transportCalls.editedMarkups.push({ id: messageId });
      },
      answerCallbackQuery: async (opts?: { text?: string; showAlert?: boolean }) => {
        transportCalls.answeredCallbacks.push(opts || {});
      },
    };

    // 1. Initial /start sends the first menu message (#5001)
    const startView = await env.controller.handleTextMessage(
      adminId,
      '/start',
      undefined,
      { transport }
    );
    assert.equal(transportCalls.sentMessages.length, 1);
    assert.equal(startView.uiMeta?.deliveryMode, 'NEW_MESSAGE');
    assert.equal(startView.uiMeta?.activeMessageId, 5001);

    // 2. Pressing a menu button edits message #5001 via editMessageText (does NOT send a new message!)
    const sessionsView = await env.controller.handleCallbackQuery(
      adminId,
      'menu:sessions:page:1',
      { transport }
    );
    assert.equal(transportCalls.sentMessages.length, 1); // Still only 1 message ever sent!
    assert.equal(transportCalls.editedTexts.length, 1);
    assert.equal(transportCalls.editedTexts[0].id, 5001);
    assert.equal(sessionsView.uiMeta?.deliveryMode, 'EDIT_TEXT');
    assert.equal(sessionsView.uiMeta?.activeMessageId, 5001);
    assert.equal(transportCalls.answeredCallbacks.length, 1);

    // 3. When only the inline keyboard changes (e.g., toggling session checkboxes in send_text workflow),
    // editMessageReplyMarkup is used instead of editMessageText!
    await env.controller.handleCallbackQuery(adminId, 'menu:send_text', {
      transport,
    });
    await env.controller.handleTextMessage(adminId, '+966559990000', undefined, {
      transport,
    });
    await env.controller.handleTextMessage(
      adminId,
      'رسالة تجريبية لتحديث الأزرار فقط',
      undefined,
      { transport }
    );

    const beforeMarkupCount = transportCalls.editedMarkups.length;
    const beforeTextCount = transportCalls.editedTexts.length;

    const toggledView = await env.controller.handleCallbackQuery(
      adminId,
      `wf_msg:toggle_sess:${s1.id}`,
      { transport }
    );
    assert.equal(toggledView.uiMeta?.deliveryMode, 'EDIT_MARKUP');
    assert.equal(transportCalls.editedMarkups.length, beforeMarkupCount + 1);
    assert.equal(transportCalls.editedTexts.length, beforeTextCount); // Text was NOT re-edited!
    assert.equal(transportCalls.sentMessages.length, 1); // Still only 1 message!

    // 4. Graceful handling of Telegram's "Bad Request: message is not modified"
    transportCalls.simulateNotModifiedOnNextEdit = true;
    const refreshNotModified = await env.controller.handleCallbackQuery(
      adminId,
      'nav:refresh',
      { transport, skipDuplicateCheck: true }
    );
    assert.equal(refreshNotModified.uiMeta?.deliveryMode, 'NOT_MODIFIED');
    assert.equal(transportCalls.sentMessages.length, 1); // Did NOT fall back to sending a duplicate message!

    // 5. Fallback to sending a new message ONLY when existing message cannot be edited (e.g., deleted by user)
    transportCalls.simulateDeletedMessageOnNextEdit = true;
    const recoveredView = await env.controller.handleCallbackQuery(
      adminId,
      'menu:settings',
      { transport }
    );
    assert.equal(recoveredView.uiMeta?.deliveryMode, 'NEW_MESSAGE');
    assert.equal(recoveredView.uiMeta?.activeMessageId, 5002);
    assert.equal(transportCalls.sentMessages.length, 2);
  } finally {
    await env.cleanup();
  }
});

test('Application-Like Navigation (Back, Home, Refresh), Anti-Double-Tap Deduplication, Workflow Cancellation, and Arbitrary Message Isolation', async () => {
  const env = createTestEnvironment();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // Initialize active menu message via /start
    const home0 = await env.controller.handleTextMessage(adminId, '/start');
    assert.equal(home0.uiMeta?.currentRoute, 'menu:main');

    // Navigate: Main Menu -> Settings -> Subscriptions
    const settingsView = await env.controller.handleCallbackQuery(
      adminId,
      'menu:settings'
    );
    assert.ok(settingsView.text.includes('إعدادات النظام والأمان'));
    assert.equal(settingsView.uiMeta?.currentRoute, 'menu:settings');
    assert.equal(settingsView.uiMeta?.canGoBack, true);

    const subsView = await env.controller.handleCallbackQuery(
      adminId,
      'menu:subscriptions:page:1'
    );
    assert.ok(subsView.text.includes('إدارة الاشتراكات ومجموعات التفعيل'));
    assert.equal(subsView.uiMeta?.currentRoute, 'menu:subscriptions:page:1');

    // Press Back (nav:back) -> returns to Settings!
    const backToSettings = await env.controller.handleCallbackQuery(
      adminId,
      'nav:back'
    );
    assert.ok(backToSettings.text.includes('إعدادات النظام والأمان'));
    assert.equal(backToSettings.uiMeta?.currentRoute, 'menu:settings');

    // Press Refresh (nav:refresh) -> refreshes Settings in-place!
    const refreshedSettings = await env.controller.handleCallbackQuery(
      adminId,
      'nav:refresh'
    );
    assert.ok(refreshedSettings.text.includes('إعدادات النظام والأمان'));
    assert.equal(refreshedSettings.toastText, '🔄 تم تحديث البيانات');

    // Press Home (nav:home) -> returns to Main Menu and clears Back history!
    const backHome = await env.controller.handleCallbackQuery(adminId, 'nav:home');
    assert.ok(backHome.text.includes('مرحباً بك في لوحة التحكم المركزية'));
    assert.equal(backHome.uiMeta?.currentRoute, 'menu:main');
    assert.equal(backHome.uiMeta?.canGoBack, false);

    // Test Repeated Button Taps (Anti-Double-Tap): two rapid identical taps on settings:cycle_cooldown
    const beforeCooldown = env.settingsRepo.getCooldownSeconds();
    const [tap1, tap2] = await Promise.all([
      env.controller.handleCallbackQuery(adminId, 'settings:cycle_cooldown'),
      env.controller.handleCallbackQuery(adminId, 'settings:cycle_cooldown'),
    ]);
    assert.notEqual(tap1.uiMeta?.deliveryMode, 'DUPLICATE_BLOCKED');
    assert.equal(tap2.uiMeta?.deliveryMode, 'DUPLICATE_BLOCKED');
    // Cooldown was only cycled ONCE (0 -> 3), not twice!
    assert.NotEqual?.(env.settingsRepo.getCooldownSeconds(), beforeCooldown);
    assert.equal(env.settingsRepo.getCooldownSeconds(), 3);
    // Reset cooldown to 0 for subsequent tests
    env.settingsRepo.setCooldownSeconds(0);

    // Test Interactive Workflow + Cancellation + Arbitrary Message Isolation
    const promptSub = await env.controller.handleCallbackQuery(
      adminId,
      'sub:prompt_add'
    );
    assert.ok(promptSub.text.includes('إضافة اشتراك مميز جديد'));
    assert.equal(env.controller.getConversationMode(adminId), 'SETTINGS');

    // Cancel workflow via workflow:cancel button
    const cancelledView = await env.controller.handleCallbackQuery(
      adminId,
      'workflow:cancel'
    );
    assert.equal(env.controller.getConversationMode(adminId), 'NONE');
    assert.ok(cancelledView.text.includes('تم إلغاء العملية الحالية'));

    // Now send an arbitrary non-command message while mode === 'NONE':
    // It must NOT be interpreted as a subscription or phone input!
    const arbitraryMsgView = await env.controller.handleTextMessage(
      adminId,
      '999888777 30'
    );
    assert.ok(arbitraryMsgView.text.includes('لا توجد عملية إدخال نصي نشطة حالياً'));
    assert.equal(env.settingsRepo.listPremiumSubscriptions().length, 0);

    // Test interactive session rename workflow & destructive confirmation dialogs
    const s1 = env.sessionManager.createSession('الاسم القديم', adminId);
    const renamePrompt = await env.controller.handleCallbackQuery(
      adminId,
      `sess:prompt_rename:${s1.id}`
    );
    assert.ok(renamePrompt.text.includes('تحديد اسم الجلسة'));
    const renamedView = await env.controller.handleTextMessage(
      adminId,
      'حساب الدعم الفني الموحد'
    );
    assert.ok(renamedView.text.includes('تم تحديث اسم الجلسة بنجاح'));
    assert.equal(
      env.sessionManager.getSession(s1.id)?.label,
      'حساب الدعم الفني الموحد'
    );

    // Verify all 10 application menus render cleanly without sending extra messages
    const statusOverview = await env.controller.handleCallbackQuery(
      adminId,
      'menu:session_status'
    );
    assert.ok(statusOverview.text.includes('لوحة حالة الجلسات الحية'));

    const sendersMenu = await env.controller.handleCallbackQuery(
      adminId,
      'menu:senders:page:1'
    );
    assert.ok(sendersMenu.text.includes('تقرير فحص جلسات ومقابس واتساب'));

    const adminControls = await env.controller.handleCallbackQuery(
      adminId,
      'menu:admin'
    );
    assert.ok(adminControls.text.includes('لوحة تحكم المشرف العام'));

    // Every single interaction reused the exact same initial message ID!
    assert.equal(adminControls.uiMeta?.stats.sentCount, 1);
    assert.ok((adminControls.uiMeta?.stats.editedTextCount ?? 0) >= 8);
    assert.ok((adminControls.uiMeta?.stats.callbackAnsweredCount ?? 0) >= 8);
  } finally {
    await env.cleanup();
  }
});

test('Issue 2 Verification: /start establishes fresh menu at current position, clears pending input workflows, and supports /start@BotUsername & payloads', async () => {
  const env = createTestEnvironment();
  const adminId = env.config.TELEGRAM_ADMIN_ID;

  try {
    const sentMessages: Array<{ id: number; text: string }> = [];
    const editedTexts: Array<{ id: number; text: string }> = [];
    let nextMsgId = 1000;

    const transport = {
      sendNewMessage: async (text: string) => {
        nextMsgId += 1;
        sentMessages.push({ id: nextMsgId, text });
        return { messageId: nextMsgId };
      },
      editMessageText: async (messageId: number, text: string) => {
        editedTexts.push({ id: messageId, text });
      },
      editMessageReplyMarkup: async () => {},
      answerCallbackQuery: async () => {},
    };

    // 1. Initial /start delivers fresh message #1001
    const v1 = await env.controller.handleTextMessage(adminId, '/start', undefined, { transport });
    assert.equal(sentMessages.length, 1);
    assert.equal(v1.uiMeta?.deliveryMode, 'NEW_MESSAGE');
    assert.equal(v1.uiMeta?.activeMessageId, 1001);

    // 2. User navigates through inline buttons (message #1001 is edited in-place)
    await env.controller.handleCallbackQuery(adminId, 'menu:sessions:page:1', { transport });
    assert.equal(sentMessages.length, 1);
    assert.equal(editedTexts.length, 1);
    assert.equal(editedTexts[0].id, 1001);

    // 3. User enters PAIRING workflow (awaiting phone number)
    await env.controller.handleCallbackQuery(adminId, 'menu:add_account', { transport });
    assert.equal(env.controller.getConversationMode(adminId), 'PAIRING');
    assert.ok(env.controller.pairingWorkflow.getState(adminId));

    // 4. User types /start@MyWhatsAppBot while in PAIRING workflow:
    // It must NOT be treated as a phone number! It must cancel PAIRING and deliver a FRESH menu message #1002!
    const v2 = await env.controller.handleTextMessage(adminId, '/start@MyWhatsAppBot', undefined, { transport });
    assert.equal(sentMessages.length, 2);
    assert.equal(v2.uiMeta?.deliveryMode, 'NEW_MESSAGE');
    assert.equal(v2.uiMeta?.activeMessageId, 1002);
    assert.equal(env.controller.getConversationMode(adminId), 'NONE');
    assert.equal(env.controller.pairingWorkflow.getState(adminId), undefined);
    assert.ok(v2.text.includes('لوحة التحكم المركزية'));

    // 5. Subsequent button clicks now edit the NEW menu (#1002)!
    await env.controller.handleCallbackQuery(adminId, 'menu:tools', { transport, skipDuplicateCheck: true });
    assert.equal(sentMessages.length, 2);
    const lastEdit = editedTexts[editedTexts.length - 1];
    assert.equal(lastEdit.id, 1002);

    // 6. User enters MESSAGE workflow and types /start with deep link payload:
    await env.controller.handleCallbackQuery(adminId, 'menu:send_text', { transport, skipDuplicateCheck: true });
    assert.equal(env.controller.getConversationMode(adminId), 'MESSAGE');
    const v3 = await env.controller.handleTextMessage(adminId, '/start ref_campaign_123', undefined, { transport });
    assert.equal(sentMessages.length, 3);
    assert.equal(v3.uiMeta?.deliveryMode, 'NEW_MESSAGE');
    assert.equal(v3.uiMeta?.activeMessageId, 1003);
    assert.equal(env.controller.getConversationMode(adminId), 'NONE');

    // 7. Test /menu command variant
    const v4 = await env.controller.handleTextMessage(adminId, '/menu@MyWhatsAppBot', undefined, { transport });
    assert.equal(sentMessages.length, 4);
    assert.equal(v4.uiMeta?.deliveryMode, 'NEW_MESSAGE');
    assert.equal(v4.uiMeta?.activeMessageId, 1004);
  } finally {
    await env.cleanup();
  }
});

test('Issue 1 Verification: WhatsApp number pairing supports Arabic numerals, 00-prefix, custom codes, and safe diagnostics', async () => {
  const env = createTestEnvironment();
  const adminId = env.config.TELEGRAM_ADMIN_ID;

  try {
    const transport = {
      sendNewMessage: async () => ({ messageId: 9999 }),
      editMessageText: async () => {},
      editMessageReplyMarkup: async () => {},
      answerCallbackQuery: async () => {},
    };

    // 1. Pairing with Arabic-Indic numerals: +٩٦٦٥٠١٢٣٤٥٦٧
    await env.controller.handleCallbackQuery(adminId, 'menu:add_account', {
      transport,
      skipDuplicateCheck: true,
    });
    assert.equal(env.controller.getConversationMode(adminId), 'PAIRING');
    const pairResult1 = await env.controller.handleTextMessage(adminId, '+٩٦٦٥٠١٢٣٤٥٦٧', undefined, { transport });
    assert.ok(pairResult1.text.includes('تم توليد رمز الربط'));
    assert.ok(pairResult1.text.includes('+966*****4567'));
    assert.equal(env.controller.getConversationMode(adminId), 'NONE');

    // 2. Pairing with 00-prefix international format and custom pairing code: 00966501234567 ATHANASA
    await env.controller.handleCallbackQuery(adminId, 'menu:add_account', {
      transport,
      skipDuplicateCheck: true,
    });
    assert.equal(env.controller.getConversationMode(adminId), 'PAIRING');
    const pairResult2 = await env.controller.handleTextMessage(
      adminId,
      '00966501234567 ATHANASA',
      undefined,
      { transport }
    );
    assert.ok(pairResult2.text.includes('تم توليد رمز الربط'));
    assert.ok(pairResult2.text.includes('ATHA-NASA'));
    assert.ok(pairResult2.text.includes('+966*****4567'));

    // 3. Invalid phone format: gracefully returns validation error in Arabic without throwing unhandled error
    await env.controller.handleCallbackQuery(adminId, 'menu:add_account', {
      transport,
      skipDuplicateCheck: true,
    });
    const invalidResult = await env.controller.handleTextMessage(adminId, 'invalid_number', undefined, { transport });
    assert.ok(invalidResult.text.includes('تعذر إتمام الربط'));
    assert.ok(invalidResult.text.includes('صيغة رقم الهاتف غير صالحة'));
    // User remains in pairing state to retry or cancel
    assert.equal(env.controller.getConversationMode(adminId), 'PAIRING');

    // 4. Cancel cancels cleanly
    const cancelResult = await env.controller.handleTextMessage(adminId, '/cancel', undefined, { transport });
    assert.ok(cancelResult.text.includes('تم إلغاء العملية'));
    assert.equal(env.controller.getConversationMode(adminId), 'NONE');

    // 5. Verify audit log recorded events without sensitive secrets or raw pairing codes
    const auditEvents = env.auditRepo.listRecent(50);
    const pairingAudit = auditEvents.find((e) => e.action === 'SESSION_PAIRING_INITIATED');
    assert.ok(pairingAudit);
    assert.ok(pairingAudit.metadata_json);
    const meta = JSON.parse(pairingAudit.metadata_json);
    // Pairing code should NOT be stored in audit metadata
    assert.equal(meta.pairingCode, undefined);
  } finally {
    await env.cleanup();
  }
});

