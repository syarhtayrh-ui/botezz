import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { STORIES_JID } from 'athanasia-baileys';
import { AppDatabase } from '../../src/database/database';
import { MIGRATION_003_ID } from '../../src/database/migrations/003_function_lab_and_message_capabilities';
import { FunctionLabRepository } from '../../src/database/repositories/function-lab-repository';
import {
  FunctionValidator,
  FunctionRegistry,
  FunctionExecutor,
  TestRunner,
  SessionResolver,
  DiagnosticLogger,
  extractCrossRealmErrorMessage,
} from '../../src/function-lab';
import {
  WhatsAppCapabilityAdapter,
  MessageNormalizer,
  MediaProcessor,
  MessageSender,
} from '../../src/whatsapp/message-capabilities';
import { validateEnv } from '../../src/config/env';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { OperationRateLimiter } from '../../src/security/validation';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { TelegramBotController } from '../../src/bot/bot';
import { MockWhatsAppSessionDriver } from '../../src/whatsapp/connection-manager';

test('Regression: AewCh Function Lab failure root causes (cross-realm VM errors, newline preservation, markdown fences, comments, and registry selection)', async () => {
  // 1. Verify cross-realm V8 VM error extraction never collapses to generic "خطأ برمجي"
  const vmContext = vm.createContext({});
  let caughtVmError: unknown;
  try {
    vm.runInContext('async function AewCh(sock, target) { const broken = ; }', vmContext);
  } catch (err) {
    caughtVmError = err;
  }
  assert.ok(caughtVmError);
  // In Node.js V8, cross-realm VM errors are NOT `instanceof Error` in host realm
  assert.equal(caughtVmError instanceof Error, false);
  const extracted = extractCrossRealmErrorMessage(caughtVmError);
  assert.equal(extracted.name, 'SyntaxError');
  assert.notEqual(extracted.message, 'خطأ برمجي');
  assert.ok(extracted.message.includes('Unexpected token'));

  // 2. Verify FunctionValidator handles multi-line AewCh with single-line comments, no semicolons, markdown fences, zero-width chars, and smart quotes
  const validator = new FunctionValidator();
  const fencedAewCh =
    '```js\n\u200Basync function AewCh(sock, target, meta) {\n' +
    '  // تعليق سطر واحد داخل الدالة\n' +
    '  const step = meta?.iteration || 1\n' +
    '  const label = “AewCh Probe”\n' +
    '  await sock.sendMessage(target, { text: label + " #" + step })\n' +
    '}\u200F\n```';

  const parsed = validator.parseAndValidateSource(fencedAewCh);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.funcName, 'AewCh');
  assert.equal(parsed.isAsync, true);
  assert.deepEqual(parsed.declaredParameters, ['sock', 'target', 'meta']);

  // 3. Verify full end-to-end Telegram Bot workflow:
  // User selects AewCh in Function Lab and sends `/testfunction`, OR sends multi-line `/testfunction`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-aewch-test-'));
  const db = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  try {
    const config = validateEnv({
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_aewch_regression_12345',
      TELEGRAM_ADMIN_ID: '777888999',
      DATABASE_PATH: path.join(tmpDir, 'test.sqlite'),
      WHATSAPP_AUTH_DIR: path.join(tmpDir, 'auth'),
      TEMP_UPLOAD_DIR: path.join(tmpDir, 'tmp'),
    });
    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);
    const auditRepo = new AuditRepository(db);
    const settingsRepo = new SettingsRepository(db);
    settingsRepo.setCooldownSeconds(0);

    const sessionStore = new SessionStore(config.WHATSAPP_AUTH_DIR);
    const sessionManager = new SessionManager(
      sessionRepo,
      auditRepo,
      sessionStore,
      (id) => {
        const drv = new MockWhatsAppSessionDriver(id);
        drv.simulatedDelayMs = 5;
        return drv;
      }
    );
    const rateLimiter = new OperationRateLimiter(50, 60_000, 100);
    const taskRunner = new TaskRunner(taskRepo, 2, 10_000);
    const taskManager = new TaskManager(taskRepo, auditRepo, taskRunner);
    const controller = new TelegramBotController({
      config,
      sessionManager,
      taskManager,
      sendMessageOp: new SendMessageOperation(sessionManager, rateLimiter),
      sendMediaOp: new SendMediaOperation(sessionManager, rateLimiter),
      groupOps: new GroupOperations(sessionManager, auditRepo, rateLimiter),
      auditRepo,
      settingsRepo,
      duplicateTapWindowMs: 0,
    });

    const adminId = config.TELEGRAM_ADMIN_ID;

    // Pair a session and complete simulated pairing
    const pairView = await controller.handleTextMessage(
      adminId,
      '/requestpair +966501112222'
    );
    assert.ok(pairView.text.includes('رمز الربط'));
    const sessions = sessionManager.listSessions();
    const drv = sessionManager.getDriver(sessions[0].id) as MockWhatsAppSessionDriver;
    drv.completeSimulatedPairing();

    // Save `AewCh` as a custom function first (since built-in demo functions are empty by design)
    await controller.handleTextMessage(
      adminId,
      '/savefunction AewCh',
      'async function AewCh(sock, target, meta) { await sock.sendMessage(target, { text: "AewCh saved probe" }); }'
    );

    // Workflow A: User opens Function Lab catalog, selects `AewCh`, and sends `/testfunction`
    const catalogView = await controller.handleCallbackQuery(
      adminId,
      'tools:flab_catalog'
    );
    assert.ok(catalogView.text.includes('AewCh'));

    const selectView = await controller.handleCallbackQuery(
      adminId,
      'tools:flab_select:AewCh'
    );
    assert.ok(selectView.text.includes('تم اختيار الدالة النشطة'));
    assert.ok(selectView.text.includes('AewCh'));

    const runSelectedRes = await controller.handleTextMessage(
      adminId,
      '/testfunction'
    );
    assert.ok(runSelectedRes.text.includes('تقرير تنفيذ الدالة المخصصة (/testfunction)'));
    assert.ok(runSelectedRes.text.includes('AewCh'));
    assert.ok(runSelectedRes.text.includes('1/1'));
    assert.ok(!runSelectedRes.text.includes('فشل تحليل كود الدالة'));

    // Workflow B: User sends multi-line `/testfunction` with `//` comments and no semicolons
    const multilineCmd =
      '/testfunction +966501234567 2 --delay=0\n' +
      'async function AewCh(sock, target, meta) {\n' +
      '  // First comment line\n' +
      '  const iter = meta.iteration\n' +
      '  console.log("Running AewCh iter", iter)\n' +
      '  await sock.sendMessage(target, { text: "Hello " + iter })\n' +
      '}';
    const multilineRes = await controller.handleTextMessage(adminId, multilineCmd);
    assert.ok(multilineRes.text.includes('AewCh'));
    assert.ok(multilineRes.text.includes('2/2'));
    assert.ok(multilineRes.text.includes('Running AewCh iter 1'));

    // Workflow C: User sends dry-run callback for AewCh
    const dryRunRes = await controller.handleCallbackQuery(
      adminId,
      'tools:flab_dryrun:AewCh'
    );
    assert.ok(dryRunRes.text.includes('DRY_RUN'));
    assert.ok(dryRunRes.text.includes('AewCh'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Function Lab TestRunner executes all 13 scenarios with 100% pass rate and records history in SQLite', async () => {
  const db = new AppDatabase(':memory:');
  try {
    const repo = new FunctionLabRepository(db);
    const registry = new FunctionRegistry(repo);
    const executor = new FunctionExecutor(registry);
    const diagLogger = new DiagnosticLogger();
    const runner = new TestRunner(registry, executor, diagLogger, repo);

    const suiteReport = await runner.runAllScenarios();
    assert.equal(suiteReport.total, 13);
    assert.equal(suiteReport.passed, 13);
    assert.equal(suiteReport.failed, 0);

    // Verify duplicate registration guard when allowUpdateExisting = false
    registry.registerFunction({
      name: 'AewCh',
      sourceCode: 'async function AewCh(sock, target) {}',
    });
    assert.throws(
      () =>
        registry.registerFunction({
          name: 'AewCh',
          sourceCode: 'async function AewCh(sock, target) {}',
          allowUpdateExisting: false,
        }),
      /مسجلة مسبقاً/
    );

    // Verify custom function registration & versioning
    const v1 = registry.registerFunction({
      name: 'customAuditFn',
      category: 'custom',
      sourceCode: 'async function customAuditFn(sock, target) { return 1; }',
    });
    assert.equal(v1.version, 1);

    const v2 = registry.registerFunction({
      name: 'customAuditFn',
      category: 'custom',
      sourceCode: 'async function customAuditFn(sock, target) { return 2; }',
    });
    assert.equal(v2.version, 2);

    // Verify SessionResolver offline safety for DRY_RUN & SIMULATION
    const resolver = new SessionResolver();
    const liveNoSess = resolver.resolveTargetSessions({
      connectedSessions: [],
      requestedScope: 'FIRST',
      executionMode: 'LIVE',
    });
    assert.equal(liveNoSess.sessions.length, 0);
    assert.ok(liveNoSess.errorMessageAr);

    const dryNoSess = resolver.resolveTargetSessions({
      connectedSessions: [],
      requestedScope: 'FIRST',
      executionMode: 'DRY_RUN',
    });
    assert.equal(dryNoSess.sessions.length, 1);
    assert.equal(dryNoSess.isSimulatedOfflineSession, true);
  } finally {
    db.close();
  }
});

test('Unified WhatsApp MessageNormalizer & MediaProcessor handle all message types, nested wrappers, View-Once privacy, and stickers', async () => {
  const normalizer = new MessageNormalizer();
  const mediaProcessor = new MediaProcessor();

  // 1. Plain conversation & duplicate detection
  const rawPlain = {
    key: { id: 'MSG_100', remoteJid: '966501234567@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1710000001,
    message: { conversation: 'السلام عليكم' },
  };
  const firstNorm = normalizer.normalizeIncoming(rawPlain);
  const secondNorm = normalizer.normalizeIncoming(rawPlain);
  assert.equal(firstNorm.category, 'plain_text');
  assert.equal(firstNorm.textBody, 'السلام عليكم');
  assert.equal(firstNorm.isDuplicateEvent, false);
  assert.equal(secondNorm.isDuplicateEvent, true);

  // 2. Voice note (PTT) vs standard audio
  const pttNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_PTT', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: 12,
        mediaKey: Buffer.from('key123'),
        directPath: '/v/t62/audio',
      },
    },
  });
  assert.equal(pttNorm.category, 'voice_ptt');
  assert.equal(pttNorm.mediaMetadata?.isPtt, true);
  assert.equal(pttNorm.mediaMetadata?.canDownloadSafely, true);

  // 3. GIF video (gifPlayback: true)
  const gifNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_GIF', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      videoMessage: {
        mimetype: 'video/mp4',
        gifPlayback: true,
        caption: 'ملف متحرك',
        mediaKey: Buffer.from('key123'),
        directPath: '/v/t62/gif',
      },
    },
  });
  assert.equal(gifNorm.category, 'gif_video');
  assert.equal(gifNorm.caption, 'ملف متحرك');

  // 4. Contacts & Locations (static and live)
  const contactsNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_CNT', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      contactsArrayMessage: {
        contacts: [{ displayName: 'أحمد' }, { displayName: 'خالد' }],
      },
    },
  });
  assert.equal(contactsNorm.category, 'contact_list');
  assert.deepEqual(contactsNorm.contactMetadata?.displayNames, ['أحمد', 'خالد']);

  const liveLocNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_LOC', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      liveLocationMessage: {
        degreesLatitude: 24.7136,
        degreesLongitude: 46.6753,
        caption: 'موقعي المباشر',
      },
    },
  });
  assert.equal(liveLocNorm.category, 'live_location');
  assert.equal(liveLocNorm.locationMetadata?.isLive, true);
  assert.equal(liveLocNorm.locationMetadata?.latitude, 24.7136);

  // 5. Reaction & Message Edit
  const reactNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_REACT', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      reactionMessage: {
        text: '👍',
        key: { id: 'MSG_100' },
      },
    },
  });
  assert.equal(reactNorm.category, 'reaction');
  assert.equal(reactNorm.reactionMetadata?.emoji, '👍');
  assert.equal(reactNorm.reactionMetadata?.targetMessageId, 'MSG_100');

  const editNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_EDIT', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      protocolMessage: {
        type: 14,
        key: { id: 'MSG_100' },
        editedMessage: {
          conversation: 'النص المعدل الجديد',
        },
      },
    },
  });
  assert.equal(editNorm.category, 'message_edit');
  assert.equal(editNorm.isEdited, true);
  assert.equal(editNorm.textBody, 'النص المعدل الجديد');

  // 6. Expired View-Once message (empty inner wrapper on companion device)
  const expiredVoNorm = normalizer.normalizeIncoming({
    key: { id: 'MSG_VO_EXP', remoteJid: '966501234567@s.whatsapp.net' },
    message: {
      viewOnceMessageV2: {},
    },
  });
  assert.equal(expiredVoNorm.category, 'view_once_expired');
  assert.equal(expiredVoNorm.isViewOnce, true);
  assert.equal(expiredVoNorm.viewOncePrivacyRestricted, true);

  // 7. Malformed null payload safety
  const malformedNorm = normalizer.normalizeIncoming(null);
  assert.equal(malformedNorm.isMalformedPayload, true);
  assert.equal(malformedNorm.category, 'unknown_future');

  // 8. MediaProcessor MIME magic-byte detection & invalid sticker rejection
  const pngMagic = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  assert.equal(mediaProcessor.detectMimeType(pngMagic), 'image/png');

  const invalidWebp = mediaProcessor.validateWebpSticker(pngMagic);
  assert.equal(invalidWebp.valid, false);
  assert.ok(invalidWebp.reasonAr?.includes('WebP'));
});

test('MessageSender enforces capabilities, idempotency, retry policy, and honest delivery state transitions', async () => {
  const db = new AppDatabase(':memory:');
  try {
    const repo = new FunctionLabRepository(db);
    const sender = new MessageSender(repo);

    let networkCalls = 0;
    const result1 = await sender.sendVerifiedMessage(
      {
        sessionId: 'sess_alpha',
        targetJid: '966501234567@s.whatsapp.net',
        content: { text: 'اختبار التسليم الموثوق' },
        idempotencyKey: 'idem_001',
        maxRetries: 2,
        retryDelayMs: 10,
      },
      {
        isConnected: () => true,
        sendMessage: async () => {
          networkCalls++;
          if (networkCalls === 1) {
            throw new Error('Socket timeout transient failure');
          }
          return { key: { id: 'WA_MSG_9001' } };
        },
      }
    );

    assert.equal(result1.messageId, 'WA_MSG_9001');
    assert.equal(result1.deliveryState, 'submitted');
    assert.equal(result1.retryCount, 1);
    assert.equal(networkCalls, 2);

    // Duplicate send with same idempotencyKey must NOT trigger another network call
    const dupResult = await sender.sendVerifiedMessage(
      {
        sessionId: 'sess_alpha',
        targetJid: '966501234567@s.whatsapp.net',
        content: { text: 'اختبار التسليم الموثوق' },
        idempotencyKey: 'idem_001',
      },
      {
        isConnected: () => true,
        sendMessage: async () => {
          networkCalls++;
          return { key: { id: 'WA_MSG_9002' } };
        },
      }
    );
    assert.equal(dupResult.messageId, 'WA_MSG_9001');
    assert.equal(networkCalls, 2);

    // Delivery receipt state progression: submitted -> acknowledged (2) -> delivered (3) -> read (4)
    assert.equal(sender.getDeliveryState('sess_alpha', 'WA_MSG_9001'), 'submitted');

    sender.recordAckUpdate({
      sessionId: 'sess_alpha',
      messageId: 'WA_MSG_9001',
      statusNumber: 2,
    });
    assert.equal(sender.getDeliveryState('sess_alpha', 'WA_MSG_9001'), 'acknowledged');

    sender.recordAckUpdate({
      sessionId: 'sess_alpha',
      messageId: 'WA_MSG_9001',
      statusNumber: 3,
    });
    assert.equal(sender.getDeliveryState('sess_alpha', 'WA_MSG_9001'), 'delivered');

    sender.recordAckUpdate({
      sessionId: 'sess_alpha',
      messageId: 'WA_MSG_9001',
      receiptType: 'read',
    });
    assert.equal(sender.getDeliveryState('sess_alpha', 'WA_MSG_9001'), 'read');

    const storedOutcomes = repo.listRecentMessageOutcomes({ sessionId: 'sess_alpha' });
    assert.equal(storedOutcomes.length, 1);
    assert.equal(storedOutcomes[0].deliveryState, 'read');
    assert.ok(storedOutcomes[0].remoteJidRedacted.includes('*****'));
  } finally {
    db.close();
  }
});

test('SQLite Migration 003 supports safe rollback and re-application without affecting existing sessions', () => {
  const db = new AppDatabase(':memory:');
  try {
    const sessionRepo = new SessionRepository(db);
    const created = sessionRepo.create({
      id: 'sess_keep_01',
      label: 'جلسة الإنتاج الأساسية',
      status: 'CONNECTED',
      authDir: '/tmp/sess_keep_01',
    });
    assert.equal(created.id, 'sess_keep_01');

    // Rollback migration 003
    const rolledBack = db.rollbackMigration(MIGRATION_003_ID);
    assert.equal(rolledBack, true);

    // Verify core sessions table and record are untouched
    const stillExists = sessionRepo.findById('sess_keep_01');
    assert.ok(stillExists);
    assert.equal(stillExists?.label, 'جلسة الإنتاج الأساسية');

    // Re-apply migrations cleanly
    db.runMigrations();
    const repo = new FunctionLabRepository(db);
    const registry = new FunctionRegistry(repo);
    registry.registerFunction({
      name: 'AewCh',
      sourceCode: 'async function AewCh(sock, target) { await sock.sendMessage(target, { text: "ok" }); }',
    });
    assert.ok(registry.resolveFunction('AewCh'));
  } finally {
    db.close();
  }
});
