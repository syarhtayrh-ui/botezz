import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { FunctionLabRepository } from '../../src/database/repositories/function-lab-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { MockWhatsAppSessionDriver } from '../../src/whatsapp/connection-manager';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { MessageSender, MediaProcessor } from '../../src/whatsapp/message-capabilities';
import { OperationRateLimiter } from '../../src/security/validation';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { TelegramBotController } from '../../src/bot/bot';
import {
  toGrammyInlineKeyboard,
  MAX_TELEGRAM_CALLBACK_DATA_BYTES,
} from '../../src/bot/keyboards/main-menu';
import { buildSessionDetailKeyboard } from '../../src/bot/keyboards/session-menu';
import {
  createAtomicMultiFileAuthState,
  getActiveFileLockCount,
  purgeFileLocksForDirectory,
} from '../../src/whatsapp/atomic-auth-state';

function createUpgradeTestHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-master-upgrade-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const authDir = path.join(tmpDir, 'auth');
  const uploadDir = path.join(tmpDir, 'uploads');

  const config = {
    TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    TELEGRAM_ADMIN_ID: 900100200,
    DATABASE_PATH: dbPath,
    WHATSAPP_AUTH_DIR: authDir,
    TEMP_UPLOAD_DIR: uploadDir,
    LOG_LEVEL: 'error' as const,
    MAX_CONCURRENT_TASKS: 3,
    TASK_TIMEOUT_MS: 15_000,
    MAX_UPLOAD_SIZE_MB: 15,
    NODE_ENV: 'test' as const,
  };

  const db = new AppDatabase(dbPath);
  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const auditRepo = new AuditRepository(db);
  const functionLabRepo = new FunctionLabRepository(db);
  const messageSender = new MessageSender(functionLabRepo);
  const mediaProcessor = new MediaProcessor({
    maxMediaSizeMb: config.MAX_UPLOAD_SIZE_MB,
    tempDir: uploadDir,
  });

  const sessionStore = new SessionStore(authDir);
  const disconnectAlerts: Array<{
    sessionId: string;
    newStatus: string;
    reasonAr: string;
  }> = [];

  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId) => new MockWhatsAppSessionDriver(sessionId, messageSender),
    {
      onDisconnectAlert: ({ session, newStatus, reasonAr }) => {
        if (settingsRepo.get('notify_on_disconnect', 'ENABLED') === 'ENABLED') {
          disconnectAlerts.push({
            sessionId: session.id,
            newStatus,
            reasonAr,
          });
        }
      },
    }
  );

  const rateLimiter = new OperationRateLimiter(20, 60_000, 5_000, {
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
  const taskRunner = new TaskRunner(taskRepo, 3, 15_000);
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
    duplicateTapWindowMs: 0,
  });

  return {
    tmpDir,
    config,
    db,
    sessionRepo,
    settingsRepo,
    auditRepo,
    functionLabRepo,
    messageSender,
    mediaProcessor,
    sessionStore,
    sessionManager,
    rateLimiter,
    sendMessageOp,
    sendMediaOp,
    controller,
    disconnectAlerts,
    cleanup: async () => {
      await sessionManager.shutdownAll();
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test('Task 1: Smart Function Lab unified engine, flexible syntax, rich sandbox helpers, /savefunction, file upload (.js/.txt), and /stopfunction', async () => {
  const env = createUpgradeTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;
    env.settingsRepo.setCooldownSeconds(0);
    await env.controller.handleTextMessage(adminId, '/requestpair +966501112233');

    // 1. Unrestricted custom function using helpers, Buffer, crypto, sleep, uuid, proto, jidDecode, and extended sock methods
    const advancedScript = `
      function buildTag(prefix) {
        return prefix + '_' + uuid().slice(0, 6);
      }
      const runSmartProbe = async (sock, target, meta) => {
        const decoded = jidDecode(target);
        const encoded = jidEncode(decoded?.user || '966501112233', 's.whatsapp.net');
        const same = areJidsSameUser(target, encoded);
        const check = await sock.onWhatsApp(target);
        const statusInfo = await sock.fetchStatus(target);
        const buf = Buffer.from(buildTag('nebula'), 'utf8');
        const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
        await sleep(5);
        const msg = generateWAMessageFromContent(
          target,
          { extendedTextMessage: { text: 'Hash=' + hash + ' same=' + same } },
          {}
        );
        await sock.relayMessage(target, msg.message, { messageId: msg.key.id });
        console.log('SmartProbe OK:', hash, check?.[0]?.exists, Boolean(statusInfo));
      };
    `;

    const res1 = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966509998877 2 --delay=0',
      advancedScript
    );
    assert.ok(res1.text.includes('runSmartProbe'));
    assert.ok(res1.text.includes('2/2'));
    assert.ok(res1.text.includes('SmartProbe OK:'));

    // 2. Raw top-level async body (without `async function` wrapper)
    const rawBodyRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966509998877 1 --delay=0',
      `await sock.presenceSubscribe(target);\nawait sock.sendMessage(target, { text: 'Raw body execution works!' });`
    );
    assert.ok(rawBodyRes.text.includes('customInline'));
    assert.ok(rawBodyRes.text.includes('1/1'));

    // 3. Save custom function to library via /savefunction and execute it by name
    const saveRes = await env.controller.handleTextMessage(
      adminId,
      '/savefunction MySavedNotifier',
      `async function tempName(sock, target) { await sock.sendMessage(target, { text: 'From saved library function' }); }`
    );
    assert.ok(saveRes.text.includes('تم حفظ الدالة المخصصة في مكتبة الدوال بنجاح'));
    assert.ok(saveRes.text.includes('MySavedNotifier'));

    const runSavedRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966509998877 2 MySavedNotifier --delay=0'
    );
    assert.ok(runSavedRes.text.includes('MySavedNotifier'));
    assert.ok(runSavedRes.text.includes('2/2'));

    // 4. Upload a .js file directly in TOOLS mode or with /testfunction caption
    const jsBuffer = Buffer.from(
      `async function uploadedFileProbe(sock, target) {
        await sock.sendMessage(target, { text: 'Executed from uploaded .js file' });
      }`,
      'utf8'
    );
    const fileExecRes = await env.controller.handleMediaUpload(adminId, {
      originalFilename: 'uploaded_probe.js',
      mimeType: 'application/javascript',
      sizeBytes: jsBuffer.length,
      contentBuffer: jsBuffer,
      caption: '/testfunction +966509998877 2 --delay=0',
    });
    assert.ok(fileExecRes.text.includes('uploadedFileProbe'));
    assert.ok(fileExecRes.text.includes('2/2'));

    // 5. Save uploaded .txt code file via /savefunction caption
    const fileSaveRes = await env.controller.handleMediaUpload(adminId, {
      originalFilename: 'saved_from_file.txt',
      mimeType: 'text/plain',
      sizeBytes: jsBuffer.length,
      contentBuffer: jsBuffer,
      caption: '/savefunction UploadedSavedFn',
    });
    assert.ok(fileSaveRes.text.includes('UploadedSavedFn'));
    assert.ok(
      env.controller.toolsHandler.functionRegistry.resolveFunction('UploadedSavedFn')
    );

    // 6. Stop active function via /stopfunction
    const stopRes = await env.controller.handleTextMessage(adminId, '/stopfunction');
    assert.ok(stopRes.text.includes('إيقاف'));
  } finally {
    await env.cleanup();
  }
});

test('Task 2 & Task 4: Real Telegram media upload workflow (document, photo, voice, sticker) and MessageSender outcome persistence', async () => {
  const env = createUpgradeTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;
    env.settingsRepo.setCooldownSeconds(0);
    await env.controller.handleTextMessage(adminId, '/requestpair +966501112233');

    // Start media workflow and enter recipient
    await env.controller.handleCallbackQuery(adminId, 'menu:send_media');
    const step2 = await env.controller.handleTextMessage(adminId, '+966554433221');
    assert.ok(step2.text.includes('الخطوة 2 من 4'));

    // Upload real PNG buffer via handleMediaUpload
    const pngBuffer = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    const step3 = await env.controller.handleMediaUpload(adminId, {
      originalFilename: 'invoice_photo.png',
      mimeType: 'image/png',
      sizeBytes: pngBuffer.length,
      contentBuffer: pngBuffer,
      caption: 'فاتورة العميل',
    });
    assert.ok(step3.text.includes('الخطوة 3 من 4'));

    const step4 = await env.controller.handleCallbackQuery(
      adminId,
      'wf_media:proceed_confirm'
    );
    assert.ok(step4.text.includes('ملخص تأكيد إرسال ملف/وسائط'));

    const execView = await env.controller.handleCallbackQuery(
      adminId,
      'wf_media:confirm_execute'
    );
    assert.ok(execView.text.includes('تقرير إرسال الوسائط والملفات'));

    // Verify MessageSender recorded the outgoing media message in SQLite message_processing_outcomes
    const outcomes = env.functionLabRepo.listRecentMessageOutcomes({ limit: 10 });
    assert.ok(outcomes.length >= 1);
    assert.equal(outcomes[0].direction, 'OUTGOING');
    assert.equal(outcomes[0].detectedType, 'image');
    assert.equal(outcomes[0].deliveryState, 'submitted');
  } finally {
    await env.cleanup();
  }
});

test('Task 3: Group Management buttons strictly obey the 64-byte Telegram callback_data limit', async () => {
  const env = createUpgradeTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;
    const pairRes = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966501112233',
      actorTelegramId: adminId,
      autoCompleteInMock: true,
    });
    const sessionId = pairRes.session.id;

    // 1. Render session groups list
    const listView = await env.controller.handleCallbackQuery(
      adminId,
      `grp:list:${sessionId}`
    );
    assert.ok(listView.keyboard);
    // Validate via toGrammyInlineKeyboard (which enforces <= 64 bytes on every button)
    assert.doesNotThrow(() => toGrammyInlineKeyboard(listView.keyboard!));

    const firstGroupBtn = listView.keyboard![0][0];
    assert.ok(firstGroupBtn.callbackData.startsWith('gv:'));
    assert.ok(
      Buffer.byteLength(firstGroupBtn.callbackData, 'utf8') <=
        MAX_TELEGRAM_CALLBACK_DATA_BYTES
    );

    // 2. Click group button to open Group Details
    const detailView = await env.controller.handleCallbackQuery(
      adminId,
      firstGroupBtn.callbackData
    );
    assert.ok(detailView.text.includes('تفاصيل المجموعة'));
    assert.ok(detailView.keyboard);
    assert.doesNotThrow(() => toGrammyInlineKeyboard(detailView.keyboard!));

    for (const row of detailView.keyboard!) {
      for (const btn of row) {
        const len = Buffer.byteLength(btn.callbackData, 'utf8');
        assert.ok(
          len <= MAX_TELEGRAM_CALLBACK_DATA_BYTES,
          `Button "${btn.text}" callbackData "${btn.callbackData}" is ${len} bytes (> 64)`
        );
      }
    }

    // 3. Trigger compact group action (GET_INVITE_LINK via ga:<shortId>:INV)
    const invBtn = detailView.keyboard![0][0];
    assert.ok(invBtn.callbackData.endsWith(':INV'));
    const invView = await env.controller.handleCallbackQuery(
      adminId,
      invBtn.callbackData
    );
    assert.ok(invView.text.includes('https://chat.whatsapp.com/'));
  } finally {
    await env.cleanup();
  }
});

test('Task 4 & Task 5: RECOVERING reconciliation, REQUIRES_REPAIR keyboard, dynamic rate_limit_profile, notify_on_disconnect, Premium/Claim authorization, and memory hygiene', async () => {
  const env = createUpgradeTestHarness();
  try {
    const ownerId = env.config.TELEGRAM_ADMIN_ID;
    env.settingsRepo.setCooldownSeconds(0);
    const subscriberId = 555666777;
    const claimUserId = 888999111;
    const claimGroupId = -100123456789;

    // 1. Premium & Claim Group Authorization
    await assert.rejects(
      () => env.controller.handleTextMessage(subscriberId, '/info'),
      /غير مصرح/
    );

    // Owner grants Premium to subscriberId
    await env.controller.handleTextMessage(
      ownerId,
      `/addpremium ${subscriberId} 15`
    );

    // Subscriber can now access /info and tools
    const subInfo = await env.controller.handleTextMessage(subscriberId, '/info');
    assert.ok(subInfo.text.includes(String(subscriberId)));

    // Subscriber still CANNOT run owner-only commands like /addpremium or /setcooldown
    await assert.rejects(
      () => env.controller.handleTextMessage(subscriberId, '/setcooldown 10'),
      /غير مصرح/
    );

    // Owner registers a claim group; claimUserId claims subscription from inside that group
    await env.controller.handleTextMessage(ownerId, `/addgb ${claimGroupId} VIPGroup`);
    const claimRes = await env.controller.handleTextMessage(
      claimUserId,
      '/claim',
      undefined,
      { chatId: claimGroupId }
    );
    assert.ok(claimRes.text.includes('تم تفعيل اشتراكك لمدة 30 يوماً'));

    // 2. Dynamic rate_limit_profile (STANDARD vs STRICT)
    env.settingsRepo.set('rate_limit_profile', 'STRICT');
    for (let i = 0; i < 8; i++) {
      env.rateLimiter.checkRateLimit('strict_test_key');
    }
    assert.throws(
      () => env.rateLimiter.checkRateLimit('strict_test_key'),
      /تجاوز الحد المسموح/
    );

    // 3. RECOVERING reconciliation and notify_on_disconnect alert when an authenticated session logs out
    const pairRes = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966507778899',
      actorTelegramId: ownerId,
      autoCompleteInMock: true,
    });
    const drv = env.sessionManager.getDriver(pairRes.session.id) as MockWhatsAppSessionDriver;
    drv.simulateDisconnect(428, 'Connection lost');
    // Remove driver from active drivers map while reconnect timer is still active, and set status to RECOVERING
    env.sessionRepo.updateStatus({
      id: pairRes.session.id,
      status: 'RECOVERING',
    });
    const recoveringSession = env.sessionManager.getSession(pairRes.session.id)!;
    assert.equal(recoveringSession.status, 'RECOVERING');

    drv.simulateDisconnect(401, 'Logged out');
    assert.ok(
      env.disconnectAlerts.some(
        (a) => a.sessionId === pairRes.session.id && a.newStatus === 'LOGGED_OUT'
      )
    );

    // 4. buildSessionDetailKeyboard prioritizes sess:repair for LOGGED_OUT / REQUIRES_REPAIR
    const loggedOutSession = env.sessionManager.getSession(pairRes.session.id)!;
    assert.equal(loggedOutSession.status, 'LOGGED_OUT');
    const detailKb = buildSessionDetailKeyboard(loggedOutSession);
    assert.equal(detailKb[0][0].callbackData, `sess:repair:${pairRes.session.id}`);

    // 5. Memory hygiene: atomic-auth-state file locks cleanup
    const tempAuthFolder = path.join(env.tmpDir, 'lock-hygiene-test');
    const authState = await createAtomicMultiFileAuthState(tempAuthFolder);
    await authState.saveCreds();
    await authState.flushPendingWrites();
    assert.equal(getActiveFileLockCount(), 0);
    purgeFileLocksForDirectory(tempAuthFolder);
    assert.equal(getActiveFileLockCount(), 0);
  } finally {
    await env.cleanup();
  }
});

test('Botezz V4 Upgrade: Unlimited defaults, parameter order auto-detection (target, sock), protocol builders (payments, stickers, interactive), and SmartProtocolWrapper', async () => {
  const env = createUpgradeTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;
    env.settingsRepo.setCooldownSeconds(0);

    // 1. Verify default TestFunctionConfig is unlimited (maxSends: 0, vmTimeoutMs: 0, maxSleepMs: 0, smartWrap: true)
    const defaultCfg = env.settingsRepo.getTestFunctionConfig();
    assert.equal(defaultCfg.maxSends, 0);
    assert.equal(defaultCfg.vmTimeoutMs, 0);
    assert.equal(defaultCfg.maxSleepMs, 0);
    assert.equal(defaultCfg.smartWrap, true);

    // Verify uncapped manual settings (>100,000 maxSends and >60,000 delayMs)
    const updatedCfg = env.settingsRepo.updateTestFunctionConfig({
      maxSends: 500_000,
      delayMs: 120_000,
    });
    assert.equal(updatedCfg.maxSends, 500_000);
    assert.equal(updatedCfg.delayMs, 120_000);
    env.settingsRepo.updateTestFunctionConfig({ maxSends: 0, delayMs: 0 });

    // 2. Verify streamlined /testfunction UI and smartWrap toggle button
    const tfPanel = await env.controller.handleCallbackQuery(
      adminId,
      'tools:prompt_testfunction'
    );
    assert.ok(tfPanel.text.includes('التغليف الذكي (Smart Protocol Wrapper)'));
    const toggledWrap = await env.controller.handleCallbackQuery(
      adminId,
      'tools:tf_toggle_smart_wrap'
    );
    assert.equal(env.settingsRepo.getTestFunctionConfig().smartWrap, false);
    assert.ok(toggledWrap.text.includes('معطل'));
    // Toggle back on
    await env.controller.handleCallbackQuery(adminId, 'tools:tf_toggle_smart_wrap');
    assert.equal(env.settingsRepo.getTestFunctionConfig().smartWrap, true);

    // 3. Pair a session and test parameter order auto-detection: `async function bug(target, sock)`
    await env.controller.handleTextMessage(adminId, '/requestpair +966501112233');

    const reversedParamsCode = `
      async function reversedSignature(target, sock) {
        const pay = buildPaymentRequest({ amount1000: 25000, currency: 'USD', note: 'Invoice #99' });
        const inv = buildPaymentInvite({ serviceType: 3 });
        const inter = buildInteractiveMessage({
          title: 'Menu Title',
          body: 'Interactive Body',
          footer: 'Footer',
          buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"OK","id":"btn_1"}' }]
        });
        await sock.relayMessage(target, pay, {});
        await sock.relayMessage(target, inv, {});
        await sock.relayMessage(target, inter, {});
        console.log('Target is string JID:', typeof target === 'string' && target.includes('@s.whatsapp.net'));
      }
    `;
    const revRes = await env.controller.handleTextMessage(
      adminId,
      '/testfunction +966509998877 1 --delay=0',
      reversedParamsCode
    );
    assert.ok(revRes.text.includes('reversedSignature'));
    assert.ok(revRes.text.includes('1/1'));
    assert.ok(revRes.text.includes('Target is string JID: true'));
    assert.ok(revRes.text.includes('`relayMessage`: *3*'));
  } finally {
    await env.cleanup();
  }
});

