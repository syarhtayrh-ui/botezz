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
import {
  MockWhatsAppSessionDriver,
  selectBrowserProfileForSession,
} from '../../src/whatsapp/connection-manager';
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
    taskRepo,
    taskManager,
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

test('Botezz V5 Upgrade: Multi-Tenant Subscriber Isolation, Strict Owner/Subscriber RBAC, Anti-Ban Browser Profiles, and Multi-Recipient MessageWorkflow', async () => {
  const env = createUpgradeTestHarness();
  try {
    const ownerId = env.config.TELEGRAM_ADMIN_ID;
    const subA = 222000111;
    const subB = 333000222;
    env.settingsRepo.setCooldownSeconds(0);

    // Grant Premium subscriptions to Subscriber A and Subscriber B
    await env.controller.handleTextMessage(ownerId, `/addpremium ${subA} 30`);
    await env.controller.handleTextMessage(ownerId, `/addpremium ${subB} 30`);

    // 1. Strict RBAC: Subscribers do NOT see Admin Controls or Subscriptions buttons on /start or /tools
    const subAMainMenu = await env.controller.handleStartCommand(subA);
    const subAButtonCallbacks = subAMainMenu.keyboard.flat().map((b) => b.callbackData);
    assert.ok(!subAButtonCallbacks.includes('menu:admin'));
    assert.ok(!subAButtonCallbacks.includes('menu:subscriptions'));
    assert.ok(!subAButtonCallbacks.includes('menu:settings'));

    const subAToolsMenu = await env.controller.handleCallbackQuery(subA, 'menu:tools');
    const subAToolsCallbacks = subAToolsMenu.keyboard.flat().map((b) => b.callbackData);
    assert.ok(!subAToolsCallbacks.includes('tools:cekall'));
    assert.ok(!subAToolsCallbacks.includes('menu:subscriptions'));

    // Subscribers are blocked from owner-only callbacks & commands
    await assert.rejects(
      () => env.controller.handleCallbackQuery(subA, 'menu:admin'),
      /غير مصرح/
    );

    await assert.rejects(
      () => env.controller.handleTextMessage(subA, '/cekall'),
      /غير مصرح/
    );
    await assert.rejects(
      () => env.controller.handleTextMessage(subA, '/listprem'),
      /غير مصرح/
    );

    // 2. Multi-Tenant Session Isolation: Sub A pairs a session, Sub B pairs a session
    const pairSubA = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966501110001',
      label: 'SubA Sales Session',
      actorTelegramId: subA,
      autoCompleteInMock: true,
    });
    const pairSubB = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966502220002',
      label: 'SubB Support Session',
      actorTelegramId: subB,
      autoCompleteInMock: true,
    });

    assert.equal(pairSubA.session.owner_telegram_id, subA);
    assert.equal(pairSubB.session.owner_telegram_id, subB);

    // Sub A only sees Sub A's session; Sub B only sees Sub B's session; Owner sees BOTH
    const listSubA = env.sessionManager.listSessions(subA);
    assert.equal(listSubA.length, 1);
    assert.equal(listSubA[0].id, pairSubA.session.id);

    const listSubB = env.sessionManager.listSessions(subB);
    assert.equal(listSubB.length, 1);
    assert.equal(listSubB[0].id, pairSubB.session.id);

    const listOwner = env.sessionManager.listSessions(ownerId);
    assert.equal(listOwner.length, 2);

    // Sub A cannot view, disconnect, or delete Sub B's session
    const crossView = await env.controller.handleCallbackQuery(
      subA,
      `sess:view:${pairSubB.session.id}`
    );
    assert.ok(
      crossView.text.includes('غير مصرح') ||
        crossView.text.includes('لم يتم العثور')
    );

    await assert.rejects(
      () => env.sessionManager.removeSession(pairSubB.session.id, subA),
      /غير مصرح/
    );

    // 3. Multi-Tenant Function Lab Isolation: Sub A saves a custom function; Sub B cannot see it, and Sub A's /testfunction only uses Sub A's socket
    await env.controller.handleTextMessage(
      subA,
      '/savefunction sub_a_only_fn',
      'async function sub_a_only_fn(sock, target) { await sock.sendMessage(target, { text: "From SubA" }); }'
    );
    const catalogSubA = await env.controller.handleCallbackQuery(
      subA,
      'tools:flab_catalog'
    );
    assert.ok(catalogSubA.text.includes('sub_a_only_fn'));

    const catalogSubB = await env.controller.handleCallbackQuery(
      subB,
      'tools:flab_catalog'
    );
    assert.ok(!catalogSubB.text.includes('sub_a_only_fn'));

    // Execute /testfunction as Sub A with ALL scope — must ONLY execute on Sub A's 1 session, never Sub B's session
    const tfRunSubA = await env.controller.handleTextMessage(
      subA,
      '/testfunction +966509991111 1 sub_a_only_fn --scope=ALL --delay=0'
    );
    assert.ok(tfRunSubA.text.includes(pairSubA.session.id));
    assert.ok(!tfRunSubA.text.includes(pairSubB.session.id));

    // 4. Multi-Recipient Support in MessageWorkflow (comma/newline separated recipients)
    await env.controller.handleCallbackQuery(subA, 'menu:send_text');
    const multiRecipientInput = '+966551112221, +966551112222\n120363029998887771@g.us';
    const step2View = await env.controller.handleTextMessage(subA, multiRecipientInput);
    assert.ok(step2View.text.includes('تم تحديد المستلم (3)'));

    const step3View = await env.controller.handleTextMessage(
      subA,
      'رسالة جماعية تجريبية لعدة مستلمين'
    );
    assert.ok(step3View.text.includes('اختيار الجلسات'));

    const step4View = await env.controller.handleCallbackQuery(
      subA,
      'wf_msg:proceed_confirm'
    );
    assert.ok(step4View.text.includes('المستلم (3)'));

    const execView = await env.controller.handleCallbackQuery(
      subA,
      'wf_msg:confirm_execute'
    );
    assert.ok(execView.text.includes('تقرير تنفيذ مهمة إرسال الرسالة'));
    assert.ok(execView.text.includes('3 مستلم'));

    // Verify Task Isolation: Sub B cannot see Sub A's task in Task Monitor
    const subATasks = env.taskManager.listRecentTasks(10, subA);
    const subBTasks = env.taskManager.listRecentTasks(10, subB);
    assert.equal(subATasks.length, 1);
    assert.equal(subBTasks.length, 0);

    // 5. Anti-Disconnect & Anti-Ban Browser Profile Diversification
    const profileA = selectBrowserProfileForSession(pairSubA.session.id);
    const profileA2 = selectBrowserProfileForSession(pairSubA.session.id);
    assert.deepEqual(profileA, profileA2);
    assert.equal(profileA.length, 3);

    // 6. Pillar 4: Mandatory 3-Step Interactive Video Call Streaming Workflow
    // (menu:video_call -> Step 1: upload .mp4 -> Step 2: enter phone number -> Step 3: immediate call & camera stream -> repeat/change recipient/stop)
    assert.ok(subAButtonCallbacks.includes('menu:video_call'));

    // Step 1: Start workflow -> immediately prompts for video file upload (`AWAITING_VIDEO`)
    const vcallStep1 = await env.controller.handleCallbackQuery(
      subA,
      'menu:video_call'
    );
    assert.ok(vcallStep1.text.includes('الخطوة 1 من 2'));
    assert.ok(vcallStep1.text.includes('الرجاء إرسال أو رفع ملف الفيديو'));

    // Step 2: Upload recorded .mp4 video file to Telegram -> transitions to `AWAITING_RECIPIENT`
    const fakeMp4Buffer = Buffer.from(
      '00000018667479706d703432000000006d70343269736f6d000000086d64617401020304',
      'hex'
    );
    const vcallStep2 = await env.controller.handleMediaUpload(subA, {
      originalFilename: 'promo_interview.mp4',
      mimeType: 'video/mp4',
      sizeBytes: fakeMp4Buffer.length,
      contentBuffer: fakeMp4Buffer,
    });
    assert.ok(
      vcallStep2.text.includes('تم استلام وتجهيز ملف الفيديو للبث بنجاح')
    );
    assert.ok(vcallStep2.text.includes('promo_interview.mp4'));
    assert.ok(vcallStep2.text.includes('الخطوة 2 من 2'));

    // Step 3: Enter target WhatsApp phone number -> immediately starts call ring & video stream (`STREAMING_ACTIVE`)
    const vcallStep3 = await env.controller.handleTextMessage(
      subA,
      '+966501234567'
    );
    assert.ok(
      vcallStep3.text.includes('تم بدء المكالمة المرئية وبث الفيديو بنجاح')
    );
    assert.ok(vcallStep3.text.includes('+966501234567'));
    assert.ok(vcallStep3.text.includes('promo_interview.mp4'));

    // Active Call Controls: Repeat call to same recipient (`wf_vcall:repeat_call`)
    const repeatedCallView = await env.controller.handleCallbackQuery(
      subA,
      'wf_vcall:repeat_call'
    );
    assert.ok(
      repeatedCallView.text.includes('تم بدء المكالمة المرئية وبث الفيديو بنجاح')
    );

    // Active Call Controls: Change recipient keeping the same video (`wf_vcall:change_recipient`)
    const changeRecPrompt = await env.controller.handleCallbackQuery(
      subA,
      'wf_vcall:change_recipient'
    );
    assert.ok(changeRecPrompt.text.includes('الرجاء إرسال الرقم المستهدف الآن'));
    assert.ok(changeRecPrompt.text.includes('promo_interview.mp4'));

    const secondRecipientCall = await env.controller.handleTextMessage(
      subA,
      '+966509998877'
    );
    assert.ok(
      secondRecipientCall.text.includes('تم بدء المكالمة المرئية وبث الفيديو بنجاح')
    );
    assert.ok(secondRecipientCall.text.includes('+966509998877'));

    // Stop active call and verify cleanup
    const stoppedView = await env.controller.handleCallbackQuery(
      subA,
      'wf_vcall:stop'
    );
    assert.ok(stoppedView.text.includes('تم إنهاء المكالمة المرئية'));
    assert.ok(
      fs.existsSync(path.resolve(process.cwd(), 'scripts/setup-ubuntu-video-engine.sh'))
    );
  } finally {
    await env.cleanup();
  }
});

test('Master Prompt Google Studio (Pillars 1-5): Media/Sticker Toolkit, Sandbox require(), Upload-to-Save Function Workflow, Instant Native Protocol Call Ringing, Inbox Archiver, and Status Downloader', async () => {
  const env = createUpgradeTestHarness();
  try {
    const ownerId = env.config.TELEGRAM_ADMIN_ID;
    env.settingsRepo.setCooldownSeconds(0);

    const pairRes = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966501112233',
      label: 'Primary Master Session',
      actorTelegramId: ownerId,
      autoCompleteInMock: true,
    });
    const sessionId = pairRes.session.id;
    const mockDriver = env.sessionManager.getDriver(
      sessionId,
      ownerId
    ) as MockWhatsAppSessionDriver;

    // =========================================================================
    // PILLAR 1: Media & Sticker Toolkit, Sandbox require(), WABinary, sendNode,
    // non-destructive SmartProtocolWrapper, and Upload Function File to Save & Run
    // =========================================================================
    const complexMediaStickerFunction = `
      const baileys = require('@whiskeysockets/baileys');
      const fs = require('fs');
      const sharp = require('sharp');
      const { Sticker } = require('wa-sticker-formatter');

      module.exports = async function masterProtocolTest(client, chatId) {
        // 1. Create PNG, JPEG, WebP sticker with EXIF, and Sticker Pack ZIP inside sandbox
        const pngBuf = imageBuilder.createGradientImagePng(96, 96, [255, 0, 128], [0, 200, 255]);
        const jpgThumb = imageBuilder.createMinimalJpegThumbnail();
        const webpBuf = stickerBuilder.createWebpSticker({
          width: 64,
          height: 64,
          packName: 'Botezz Master Pack',
          authorName: 'Botezz Lab',
          emojis: ['🔥', '⚡']
        });
        const zipBuf = stickerBuilder.createStickerPackZip({
          packName: 'Botezz ZIP Pack',
          stickersCount: 2
        });

        // 2. Virtual fs fallback for non-existent local files (prevents ENOENT in pasted scripts)
        const fallbackWebp = fs.readFileSync('./missing_sticker.webp');
        const sharpOut = await sharp(pngBuf).resize(64, 64).webp().toBuffer();
        const formattedSticker = await new Sticker(pngBuf, { pack: 'Test' }).toBuffer();

        // 3. Test prepareWAMessageMedia + sock.waUploadToServer + sock.sendNode + WABinary
        const uploadedMedia = await prepareWAMessageMedia(
          { image: pngBuf, jpegThumbnail: jpgThumb },
          { upload: client.waUploadToServer }
        );
        await client.sendNode({
          tag: 'iq',
          attrs: { to: WABinary.S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' },
          content: []
        });

        // 4. Test custom additionalNodes & messageContextInfo preservation in relayMessage
        await client.relayMessage(
          chatId,
          {
            stickerMessage: {
              url: 'https://mmg.whatsapp.net/v/t62.15575-24/mock.enc',
              mimetype: 'image/webp',
              fileLength: webpBuf.length
            },
            messageContextInfo: {
              deviceListMetadataVersion: 2
            }
          },
          {
            additionalNodes: [{ tag: 'meta', attrs: { custom_attr: 'preserved_ok' } }]
          }
        );

        await client.sendMessage(chatId, { sticker: formattedSticker });
        console.log(
          'Toolkitcheck:',
          pngBuf.slice(1, 4).toString('ascii') === 'PNG',
          webpBuf.slice(0, 4).toString('ascii') === 'RIFF',
          webpBuf.includes(Buffer.from('EXIF')),
          zipBuf.slice(0, 2).toString('ascii') === 'PK',
          fallbackWebp.slice(0, 4).toString('ascii') === 'RIFF',
          sharpOut.length > 10,
          Boolean(uploadedMedia.imageMessage)
        );
      };
    `;

    const pillar1Exec = await env.controller.handleTextMessage(
      ownerId,
      '/testfunction +966509998877 1 --delay=0',
      complexMediaStickerFunction
    );
    assert.ok(pillar1Exec.text.includes('masterProtocolTest'));
    assert.ok(pillar1Exec.text.includes('1/1'));
    assert.ok(
      pillar1Exec.text.includes('Toolkitcheck: true true true true true true true')
    );
    assert.ok(mockDriver.sentNodes.length >= 1);

    // Interactive Upload Function File to Save -> Name -> Confirm -> Run by Name
    const promptUploadView = await env.controller.handleCallbackQuery(
      ownerId,
      'tools:flab_prompt_upload_save'
    );
    assert.ok(
      promptUploadView.text.includes('رفع ملف دالة مخصصة لحفظها في المكتبة')
    );

    const uploadedFnCode = Buffer.from(
      `async function fileSavedStickerSender(sock, target) {
        const stk = createWebpSticker({ packName: 'SavedFilePack', authorName: 'Admin' });
        await sock.sendMessage(target, { sticker: stk });
      }`,
      'utf8'
    );
    const stageView = await env.controller.handleMediaUpload(ownerId, {
      originalFilename: 'my_sticker_func.js',
      mimeType: 'application/javascript',
      sizeBytes: uploadedFnCode.length,
      contentBuffer: uploadedFnCode,
    });
    assert.ok(stageView.text.includes('تم فحص وقبول ملف الدالة بنجاح'));
    assert.ok(stageView.text.includes('fileSavedStickerSender'));

    // Enter a custom name and confirm saving
    const customNameReply = await env.controller.handleTextMessage(
      ownerId,
      'StickerWaveFn'
    );
    assert.ok(
      customNameReply.text.includes('تم حفظ الدالة المخصصة في مكتبة الدوال بنجاح')
    );
    assert.ok(customNameReply.text.includes('StickerWaveFn'));

    // Click "Run this function now" (`tools:flab_prompt_run:StickerWaveFn`) and supply `<phone> <iterations>`
    const promptRunSaved = await env.controller.handleCallbackQuery(
      ownerId,
      'tools:flab_prompt_run:StickerWaveFn'
    );
    assert.ok(promptRunSaved.text.includes('تشغيل الدالة المحفوظة'));
    assert.ok(promptRunSaved.text.includes('StickerWaveFn'));

    const runSavedResult = await env.controller.handleTextMessage(
      ownerId,
      '+966508887766 2 --delay=0'
    );
    assert.ok(runSavedResult.text.includes('StickerWaveFn'));
    assert.ok(runSavedResult.text.includes('2/2'));

    // =========================================================================
    // PILLAR 2: Pure WhatsApp Protocol Fake Video Call Engine (3-Step Flow:
    // Step 1: menu:video_call -> Step 2: attach sample_call.mp4 -> Step 3: send phone -> Immediate Native Call Offer + PTV Stream)
    // =========================================================================
    const step1Prompt = await env.controller.handleCallbackQuery(
      ownerId,
      'menu:video_call'
    );
    assert.ok(step1Prompt.text.includes('الخطوة 1 من 2'));

    // Step 2: Attach sample video (`wf_vcall:sample_video`) -> transitions to `AWAITING_RECIPIENT`
    const step2Attached = await env.controller.handleCallbackQuery(
      ownerId,
      'wf_vcall:sample_video'
    );
    assert.ok(
      step2Attached.text.includes('تم استلام وتجهيز ملف الفيديو للبث بنجاح')
    );
    assert.ok(step2Attached.text.includes('sample_call.mp4'));
    assert.ok(step2Attached.text.includes('الخطوة 2 من 2'));

    // Step 3: Send target phone number -> immediately triggers `<call><offer><video/></offer></call>` + `ptvMessage` camera stream
    const activeCallView = await env.controller.handleTextMessage(
      ownerId,
      '+966504443322'
    );
    assert.ok(
      activeCallView.text.includes('تم بدء المكالمة المرئية وبث الفيديو بنجاح')
    );
    assert.ok(activeCallView.text.includes('sample_call.mp4'));
    assert.ok(mockDriver.sentCallOffers.length >= 1);
    assert.equal(mockDriver.sentCallOffers[0]!.isVideo, true);

    // Stop active call and verify `<call><terminate>` was sent
    const stoppedNativeCall = await env.controller.handleCallbackQuery(
      ownerId,
      'wf_vcall:stop'
    );
    assert.ok(stoppedNativeCall.text.includes('تم إنهاء المكالمة المرئية'));
    assert.ok(mockDriver.terminatedCalls.length >= 1);

    // =========================================================================
    // PILLAR 3: Incoming Messages Receiver & Auto-Archiver (`menu:inbox:page:1`)
    // =========================================================================
    // Simulate an incoming message directly from MockWhatsAppSessionDriver
    mockDriver.simulateIncomingMessage({
      key: {
        remoteJid: '966509991122@s.whatsapp.net',
        id: 'live_in_msg_1',
        fromMe: false,
      },
      pushName: 'عميل مباشر',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        conversation: 'رسالة واردة مباشرة عبر حدث المقبس!',
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const inboxView = await env.controller.handleCallbackQuery(
      ownerId,
      'menu:inbox:page:1'
    );
    assert.ok(inboxView.text.includes('قسم استقبال الرسائل'));

    // Generate simulated batch of diverse incoming messages (text, image, sticker, location)
    const inboxBatchView = await env.controller.handleCallbackQuery(
      ownerId,
      'inbox:simulate_batch'
    );
    assert.ok(inboxBatchView.mediaAttachments);
    assert.ok(inboxBatchView.mediaAttachments.length >= 4);
    for (const att of inboxBatchView.mediaAttachments) {
      assert.ok(fs.existsSync(att.filePath), `Archived inbox file must exist: ${att.filePath}`);
      assert.ok(fs.statSync(att.filePath).size > 0);
    }

    // Filter by STICKERS and download single archived message file
    const stickerFilteredInbox = await env.controller.handleCallbackQuery(
      ownerId,
      'inbox:filter:STICKERS'
    );
    assert.ok(stickerFilteredInbox.text.includes('STICKERS'));
    const allInboxRecords = env.controller.inboxRepo.listForOwner(ownerId, true);
    assert.ok(allInboxRecords.length >= 5);

    const dlSingleMsg = await env.controller.handleCallbackQuery(
      ownerId,
      `inbox:dl:${allInboxRecords[0]!.id}`
    );
    assert.equal(dlSingleMsg.mediaAttachments?.length, 1);

    // =========================================================================
    // PILLAR 4: WhatsApp Status / Stories Viewer & Downloader (`menu:stories:page:1`)
    // =========================================================================
    // Simulate a live `status@broadcast` message from MockWhatsAppSessionDriver
    mockDriver.simulateIncomingMessage({
      key: {
        remoteJid: 'status@broadcast',
        id: 'live_status_1',
        fromMe: false,
        participant: '966507771111@s.whatsapp.net',
      },
      pushName: 'صاحب الحالة',
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        imageMessage: {
          caption: 'حالة مصورة حية من واتساب',
          mimetype: 'image/png',
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const storiesView = await env.controller.handleCallbackQuery(
      ownerId,
      'menu:stories:page:1'
    );
    assert.ok(storiesView.text.includes('قسم تحميلات الحالات'));

    const storiesBatchView = await env.controller.handleCallbackQuery(
      ownerId,
      'stories:simulate_batch'
    );
    assert.ok(storiesBatchView.mediaAttachments);
    assert.ok(storiesBatchView.mediaAttachments.length >= 3);
    for (const att of storiesBatchView.mediaAttachments) {
      assert.ok(fs.existsSync(att.filePath), `Captured status file must exist: ${att.filePath}`);
      assert.ok(fs.statSync(att.filePath).size > 0);
    }

    const allStatuses = env.controller.statusRepo.listForOwner(ownerId, true);
    assert.ok(allStatuses.length >= 4);

    // Download a single status by ID
    const singleStatusDl = await env.controller.handleCallbackQuery(
      ownerId,
      `stories:dl:${allStatuses[0]!.id}`
    );
    assert.equal(singleStatusDl.mediaAttachments?.length, 1);

    // Download all statuses for a specific phone number
    const contactStatusesDl = await env.controller.handleCallbackQuery(
      ownerId,
      'stories:dlc:966501112233'
    );
    assert.ok((contactStatusesDl.mediaAttachments?.length ?? 0) >= 2);
  } finally {
    await env.cleanup();
  }
});

test('Deep Status Downloader & Deep Message Inbox: all formats, zip fallback, edit tracking, and native WhatsApp forwarding', async () => {
  const env = createUpgradeTestHarness();
  try {
    const ownerId = env.config.TELEGRAM_ADMIN_ID;
    env.settingsRepo.setCooldownSeconds(0);

    // 1. Setup connected session
    const pairRes = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966501112233',
      label: 'جلسة الفحص العميق',
      actorTelegramId: ownerId,
      autoCompleteInMock: true,
    });
    const sess = pairRes.session;
    const mockDriver = env.sessionManager.getDriver(
      sess.id,
      ownerId
    ) as MockWhatsAppSessionDriver;
    assert.equal(sess.status, 'CONNECTED');

    // 2. Deep Status Extraction: Status with rich Arabic diacritics caption
    // 2. Deep Status Extraction: Status with rich Arabic diacritics caption
    const arabicCaptionWithDiacritics = 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ — إعلان هامّ مع خطوط نادرة 🌟🚀 #تحديث';
    const statusResult = await env.controller.statusDownloader.processStatusMessage({
      sessionId: sess.id,
      rawMessage: {
        key: {
          remoteJid: 'status@broadcast',
          id: 'status_deep_arabic_1',
          fromMe: false,
          participant: '966501239999@s.whatsapp.net',
        },
        pushName: 'الناشر الرسمي',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            caption: arabicCaptionWithDiacritics,
            mimetype: 'image/jpeg',
            url: 'https://example.com/status.jpg',
          },
        },
      },
    });

    assert.ok(statusResult);
    assert.equal(statusResult.caption, arabicCaptionWithDiacritics);
    assert.ok(fs.existsSync(statusResult.file_path));

    // Verify companion caption .txt file was written
    const statusDir = path.dirname(statusResult.file_path);
    const descFiles = fs.readdirSync(statusDir).filter((f) => f.startsWith('status_desc_'));
    assert.ok(descFiles.length > 0, 'Companion caption description file must exist');
    const savedCaption = fs.readFileSync(path.join(statusDir, descFiles[0]!), 'utf-8');
    assert.ok(savedCaption.includes(arabicCaptionWithDiacritics));

    // 3. Deep Status Extraction: Corrupted/problematic image falls back to .zip archive
    const zipStatusResult = await env.controller.statusDownloader.processStatusMessage({
      sessionId: sess.id,
      rawMessage: {
        key: {
          remoteJid: 'status@broadcast',
          id: 'status_deep_corrupted_1',
          fromMe: false,
          participant: '966501239999@s.whatsapp.net',
        },
        pushName: 'الناشر مع صورة تالفة',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            caption: 'حالة صورة تالفة أو غير مكتملة المعالجة',
            mimetype: 'image/unknown-raw',
            jpegThumbnail: Buffer.from('corrupted-non-standard-bytes-for-zip-packaging'),
          },
        },
      },
    });

    assert.ok(zipStatusResult);
    assert.equal(zipStatusResult.archive_format, 'zip');
    assert.ok(zipStatusResult.file_path.endsWith('.zip'));
    assert.ok(fs.existsSync(zipStatusResult.file_path));
    assert.ok(fs.statSync(zipStatusResult.file_path).size > 0);

    // 4. Deep Inbox Message Extraction: Complex rare characters & long text
    const longSpecialText = '💎 نص طويل جداً يحتوي على رموز نادرة 𝕭𝖔𝖙𝖊𝖟𝖟 𝖁𝟱 ورموز تعبيرية ⚡💫 وتشيكل كامل: الحَمْدُ لِلَّهِ رَبِّ العَالَمِينَ'.repeat(3);
    const deepMsg = await env.controller.incomingMessageReceiver.processIncomingMessage({
      sessionId: sess.id,
      rawMessage: {
        key: {
          remoteJid: '966551122334@s.whatsapp.net',
          id: 'wa_msg_deep_long_1',
          fromMe: false,
        },
        pushName: 'العميل المميز',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          extendedTextMessage: {
            text: longSpecialText,
          },
        },
      },
    });

    assert.ok(deepMsg);
    assert.equal(deepMsg.text_content, longSpecialText);
    assert.notEqual(deepMsg.text_content, '(بدون نص)');
    assert.ok(fs.existsSync(deepMsg.file_path!));

    // 5. Message Edit Detection & Version Tracking (قبل التعديل / بعد التعديل)
    const editedText = '💎 النص بعد التعديل: تم تصحيح البيان بالكامل مع إضافة توضيح جديد! ✅';
    const editedMsgResult = await env.controller.incomingMessageReceiver.processIncomingMessage({
      sessionId: sess.id,
      rawMessage: {
        key: {
          remoteJid: '966551122334@s.whatsapp.net',
          id: 'wa_msg_edit_protocol_1',
          fromMe: false,
        },
        pushName: 'العميل المميز',
        messageTimestamp: Math.floor(Date.now() / 1000) + 10,
        message: {
          protocolMessage: {
            key: {
              remoteJid: '966551122334@s.whatsapp.net',
              id: 'wa_msg_deep_long_1',
              fromMe: false,
            },
            type: 14, // MESSAGE_EDIT
            editedMessage: {
              conversation: editedText,
            },
          },
        },
      },
    });

    assert.ok(editedMsgResult);
    assert.equal(editedMsgResult.id, deepMsg.id); // Same database record updated
    assert.equal(editedMsgResult.is_edited, 1);
    assert.equal(editedMsgResult.original_text, longSpecialText);
    assert.equal(editedMsgResult.text_content, editedText);

    // Verify inbox view displays the edit metadata
    const messageDetailView = env.controller.inboxHandler.viewMessage(ownerId, deepMsg.id);
    assert.ok(messageDetailView.text.includes('تم تعديل هذه الرسالة'));
    assert.ok(messageDetailView.text.includes(editedText));
    assert.ok(messageDetailView.text.includes(longSpecialText.slice(0, 100)));

    // 6. Native WhatsApp Forwarding Workflow (inbox:fwd:<id> -> phone prompt -> execution)
    // Check forward button present in viewMessage keyboard
    const fwdBtn = messageDetailView.keyboard.flat().find((b) => b.callbackData === `inbox:fwd:${deepMsg.id}`);
    assert.ok(fwdBtn, 'Forward button must be present in message details');

    // Trigger forward prompt via callback query
    const promptView = await env.controller.handleCallbackQuery(ownerId, `inbox:fwd:${deepMsg.id}`);
    assert.ok(promptView.text.includes('إعادة توجيه الرسالة عبر واتساب'));
    assert.equal(env.controller.getConversationMode(ownerId), 'INBOX_FORWARD');

    // Enter destination phone number via text message
    const forwardResponse = await env.controller.handleTextMessage(ownerId, '+966509988776');
    assert.ok(forwardResponse.text.includes('تمت إعادة توجيه الرسالة بنجاح'));
    assert.equal(env.controller.getConversationMode(ownerId), 'NONE');

    // Verify MockWhatsAppSessionDriver received native forward invocation
    assert.equal(mockDriver.forwardedMessages.length, 1);
    const forwardedEntry = mockDriver.forwardedMessages[0]!;
    assert.equal(forwardedEntry.targetJid, '966509988776@s.whatsapp.net');
    assert.equal(forwardedEntry.isForwarded, true);
    assert.ok(forwardedEntry.rawPayload);
  } finally {
    await env.cleanup();
  }
});




