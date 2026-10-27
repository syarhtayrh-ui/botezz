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
