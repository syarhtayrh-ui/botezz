import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DisconnectReason, useMultiFileAuthState } from 'athanasia-baileys';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import {
  MockWhatsAppSessionDriver,
  ConnectionEventCallbacks,
  resolveWhatsAppWebVersion,
  describeDisconnectReasonArabic,
} from '../../src/whatsapp/connection-manager';
import { SessionManager, SessionManagerOptions } from '../../src/whatsapp/session-manager';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { OperationRateLimiter } from '../../src/security/validation';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { TelegramBotController } from '../../src/bot/bot';
import { AppConfig } from '../../src/config/env';

function createLifecycleTestHarness(managerOptions?: SessionManagerOptions) {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lifecycle-audit-'));
  const authDir = path.join(baseTmp, 'whatsapp-sessions');
  const uploadDir = path.join(baseTmp, 'tmp');

  const config: AppConfig = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_lifecycle_suite',
    TELEGRAM_ADMIN_ID: 888000222,
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

  const createdDrivers: Array<{
    sessionId: string;
    driver: MockWhatsAppSessionDriver;
    capturedCallbacks: ConnectionEventCallbacks | null;
  }> = [];

  let nextDriverConfig: {
    shouldFailConnect?: boolean;
    shouldFailPairingRequest?: boolean;
    shouldTimeoutHandshake?: boolean;
    simulatedCloseStatusCodeBeforeReady?: number | null;
  } = {};

  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId) => {
      const drv = new MockWhatsAppSessionDriver(sessionId);
      drv.simulatedDelayMs = 5;
      if (nextDriverConfig.shouldFailConnect) {
        drv.shouldFailConnect = true;
      }
      if (nextDriverConfig.shouldFailPairingRequest) {
        drv.shouldFailPairingRequest = true;
      }
      if (nextDriverConfig.shouldTimeoutHandshake) {
        drv.shouldTimeoutHandshake = true;
      }
      if (nextDriverConfig.simulatedCloseStatusCodeBeforeReady !== undefined) {
        drv.simulatedCloseStatusCodeBeforeReady =
          nextDriverConfig.simulatedCloseStatusCodeBeforeReady;
      }

      const entry = {
        sessionId,
        driver: drv,
        capturedCallbacks: null as ConnectionEventCallbacks | null,
      };
      const origConnect = drv.connect.bind(drv);
      drv.connect = async (callbacks: ConnectionEventCallbacks) => {
        entry.capturedCallbacks = callbacks;
        return origConnect(callbacks);
      };
      createdDrivers.push(entry);
      return drv;
    },
    {
      defaultAutoCompleteInMock: false,
      maxReconnectAttempts: 3,
      reconnectBaseDelayMs: 25,
      reconnectMaxDelayMs: 80,
      pairingTimeoutMs: 5_000,
      ...managerOptions,
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
    sessionRepo,
    sessionStore,
    sessionManager,
    auditRepo,
    controller,
    createdDrivers,
    setNextDriverConfig: (cfg: typeof nextDriverConfig) => {
      nextDriverConfig = cfg;
    },
    cleanup: async () => {
      await sessionManager.shutdownAll();
      db.close();
      fs.rmSync(baseTmp, { recursive: true, force: true });
    },
  };
}

test('Section 17.أ: Pairing Code Generation — valid phone calls driver, invalid phone rejected before session/socket creation, library failure never returns fake code, and code generation alone never marks session CONNECTED', async () => {
  const env = createLifecycleTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. Invalid phone number is rejected BEFORE creating any session record or driver socket
    await assert.rejects(
      () =>
        env.sessionManager.initiatePairing({
          rawPhoneNumber: '050123',
          actorTelegramId: adminId,
        }),
      /صيغة رقم الهاتف غير صالحة/
    );
    assert.equal(env.sessionManager.listSessions().length, 0);
    assert.equal(env.createdDrivers.length, 0);

    // 2. When driver.requestPairingCode fails, no fake code is returned and session is marked FAILED (not PAIRING_PENDING)
    env.setNextDriverConfig({ shouldFailPairingRequest: true });
    await assert.rejects(
      () =>
        env.sessionManager.initiatePairing({
          rawPhoneNumber: '+966501112222',
          actorTelegramId: adminId,
        }),
      /تعذر استلام رمز الربط/
    );
    const failedSessions = env.sessionManager.listSessions();
    assert.equal(failedSessions.length, 1);
    assert.equal(failedSessions[0].status, 'FAILED');
    assert.NotEqual?.(failedSessions[0].status, 'PAIRING_PENDING');
    assert.NotEqual?.(failedSessions[0].status, 'CONNECTED');

    // 3. When socket handshake is not ready (timeout), requestPairingCode fails cleanly without returning any code
    env.setNextDriverConfig({ shouldTimeoutHandshake: true });
    await assert.rejects(
      () =>
        env.sessionManager.initiatePairing({
          rawPhoneNumber: '+966503334444',
          actorTelegramId: adminId,
        }),
      /انتهت مهلة إتمام المصافحة الأولية/
    );
    const timeoutSession = env.sessionManager
      .listSessions()
      .find((s) => s.masked_phone === '+966*****4444')!;
    assert.equal(timeoutSession.status, 'FAILED');

    // 4. Valid phone number calls driver.requestPairingCode with normalized digits and keeps session in PAIRING_PENDING (NOT CONNECTED!)
    env.setNextDriverConfig({});
    const validPair = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966 50-123-4567',
      actorTelegramId: adminId,
    });

    const lastDriverEntry = env.createdDrivers[env.createdDrivers.length - 1];
    assert.equal(lastDriverEntry.driver.pairingCodeRequestCount, 1);
    assert.equal(lastDriverEntry.driver.lastRequestedPhoneDigits, '966501234567');
    assert.equal(validPair.pairingCode, 'WA96-4567');
    assert.equal(validPair.session.status, 'PAIRING_PENDING');

    const liveVerif = env.sessionManager.getLiveVerification(validPair.session.id)!;
    assert.equal(liveVerif.session.status, 'PAIRING_PENDING');
    assert.equal(liveVerif.isLiveConnected, false);
    assert.equal(liveVerif.socketDiagnostics.socketActive, true);
    assert.equal(liveVerif.socketDiagnostics.registered, false);
  } finally {
    await env.cleanup();
  }
});

test('Section 17.ب: Pairing Completion — stays PAIRING_PENDING before auth, transitions to CONNECTED only on real auth event, handles 515 restartRequired, expires on timeout, and never leaks pairing code in logs', async () => {
  const env = createLifecycleTestHarness({ pairingTimeoutMs: 120 });
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. Initiate pairing -> remains PAIRING_PENDING before phone confirmation
    const p1 = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966501234567 MYCODE99',
      actorTelegramId: adminId,
      pairingTimeoutMs: 5_000,
    });
    assert.equal(p1.pairingCode, 'MYCO-DE99');
    assert.equal(env.sessionManager.getSession(p1.session.id)?.status, 'PAIRING_PENDING');

    // Attempting to send a message while PAIRING_PENDING must be rejected because session is not authenticated
    await assert.rejects(
      async () => env.sessionManager.getDriver(p1.session.id),
      /غير متصلة حالياً بمقبس واتساب موثق/
    );

    // 2. Simulate WhatsApp protocol `pair-success` -> `AUTHENTICATING` -> 515 `RESTART_REQUIRED` -> `CONNECTED`
    const drv1Entry = env.createdDrivers.find((d) => d.sessionId === p1.session.id)!;
    env.sessionStore.writeMockAuthMarker(p1.session.id, p1.maskedPhone, true);
    drv1Entry.capturedCallbacks?.onStatusChange({
      status: 'AUTHENTICATING',
      jid: '966501234567@s.whatsapp.net',
      isRegistered: true,
    });
    assert.equal(env.sessionManager.getSession(p1.session.id)?.status, 'AUTHENTICATING');

    drv1Entry.capturedCallbacks?.onStatusChange({
      status: 'RESTART_REQUIRED',
      statusCode: DisconnectReason.restartRequired,
      isRegistered: true,
    });

    // Wait briefly for restartAfterPairing to complete
    await new Promise((r) => setTimeout(r, 40));
    const afterRestart = env.sessionManager.getLiveVerification(p1.session.id)!;
    assert.equal(afterRestart.session.status, 'CONNECTED');
    assert.equal(afterRestart.isLiveConnected, true);
    assert.equal(afterRestart.socketDiagnostics.registered, true);

    // 3. Pairing failure (socket closes before user enters code) -> transitions to FAILED and does NOT auto-reconnect!
    const p2 = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966507654321',
      actorTelegramId: adminId,
      pairingTimeoutMs: 5_000,
    });
    assert.equal(env.sessionManager.getSession(p2.session.id)?.status, 'PAIRING_PENDING');
    const drv2Entry = env.createdDrivers.find((d) => d.sessionId === p2.session.id)!;
    const driversCountBeforeDisconnect = env.createdDrivers.length;

    drv2Entry.driver.simulateDisconnect(408, 'QR refs attempts ended');
    await new Promise((r) => setTimeout(r, 80));

    const verif2 = env.sessionManager.getLiveVerification(p2.session.id)!;
    assert.equal(verif2.session.status, 'FAILED');
    assert.equal(verif2.hasReconnectTimer, false);
    assert.equal(env.createdDrivers.length, driversCountBeforeDisconnect); // No background reconnect socket was spawned!

    // 4. Pairing timeout expiration -> transitions from PAIRING_PENDING to FAILED cleanly
    const p3 = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966508887777',
      actorTelegramId: adminId,
      pairingTimeoutMs: 90,
    });
    assert.equal(env.sessionManager.getSession(p3.session.id)?.status, 'PAIRING_PENDING');
    await new Promise((r) => setTimeout(r, 150));

    const verif3 = env.sessionManager.getLiveVerification(p3.session.id)!;
    assert.equal(verif3.session.status, 'FAILED');
    assert.ok(verif3.session.last_error?.includes('انتهت مهلة انتظار إدخال رمز الربط'));
    assert.equal(verif3.hasActiveDriver, false);

    // 5. Verify pairing code is NEVER leaked in audit logs
    const audits = env.auditRepo.listRecent(50);
    for (const entry of audits) {
      assert.ok(!String(entry.metadata_json || '').includes('MYCO-DE99'));
      assert.ok(!String(entry.metadata_json || '').includes('MYCODE99'));
    }
  } finally {
    await env.cleanup();
  }
});

test('Section 17.ج: Refresh Status — strictly read-only, never creates sockets, never oscillates state on repeated clicks, and reconciles stale SQLite CONNECTED records', async () => {
  const env = createLifecycleTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. Start a session in PAIRING_PENDING
    const pendingPair = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966501119999',
      actorTelegramId: adminId,
    });
    const sessionId = pendingPair.session.id;
    const socketsBeforeRefresh = env.createdDrivers.length;

    // Press Refresh Status (`sess:view:<id>`, `sess:refresh:1`, `menu:session_status`, `nav:refresh`) 8 times in a row
    for (let i = 0; i < 8; i++) {
      const detailView = await env.controller.handleCallbackQuery(
        adminId,
        `sess:view:${sessionId}`,
        { skipDuplicateCheck: true }
      );
      assert.ok(detailView.text.includes('🟡 بانتظار رمز الربط'));
      assert.ok(!detailView.text.includes('🟢 متصل'));

      const listRefresh = await env.controller.handleCallbackQuery(
        adminId,
        'sess:refresh:1',
        { skipDuplicateCheck: true }
      );
      assert.ok(listRefresh.text.includes('إدارة الجلسات المرتبطة'));
    }

    // Verify ZERO new sockets were created during all 16 refresh actions!
    assert.equal(env.createdDrivers.length, socketsBeforeRefresh);
    assert.equal(env.sessionManager.getSession(sessionId)?.status, 'PAIRING_PENDING');

    // 2. Disconnect the session -> pressing Refresh Status repeatedly never makes it CONNECTED or RECONNECTING
    await env.sessionManager.disconnectSession(sessionId, adminId);
    assert.equal(env.sessionManager.getSession(sessionId)?.status, 'DISCONNECTED');

    for (let i = 0; i < 5; i++) {
      const detailAfterDisc = await env.controller.handleCallbackQuery(
        adminId,
        `sess:view:${sessionId}`,
        { skipDuplicateCheck: true }
      );
      assert.ok(detailAfterDisc.text.includes('🔴 غير متصل'));
      assert.ok(detailAfterDisc.text.includes('🔴 مغلق / غير نشط'));
    }
    assert.equal(env.createdDrivers.length, socketsBeforeRefresh);

    // 3. Stale SQLite state test: Directly write `status = 'CONNECTED'` into SQLite while no live socket is open!
    env.sessionRepo.updateStatus({
      id: sessionId,
      status: 'CONNECTED',
      lastError: null,
    });
    assert.equal(env.sessionRepo.findById(sessionId)?.status, 'CONNECTED'); // Raw DB has stale CONNECTED

    // Now query via SessionManager / Telegram Refresh Status:
    // Must detect that there is no live connected socket in memory and reconcile it to DISCONNECTED!
    const reconciled = env.sessionManager.getSession(sessionId)!;
    assert.equal(reconciled.status, 'DISCONNECTED');
    assert.equal(env.sessionManager.listConnectedSessions().length, 0);

    const staleView = await env.controller.handleCallbackQuery(
      adminId,
      `sess:view:${sessionId}`,
      { skipDuplicateCheck: true }
    );
    assert.ok(staleView.text.includes('🔴 غير متصل'));
    assert.ok(!staleView.text.includes('📡 حالة الاتصال: 🟢 متصل'));
  } finally {
    await env.cleanup();
  }
});

test('Section 17.د: Reconnection & Socket Generation Isolation — stale socket events ignored, bounded retries stop at maxReconnectAttempts, and LOGGED_OUT (401) purges auth without reconnecting', async () => {
  const env = createLifecycleTestHarness({
    maxReconnectAttempts: 2,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 40,
  });
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // Create and complete pairing for session 1
    const p1 = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966505551111',
      actorTelegramId: adminId,
      autoCompleteInMock: true,
    });
    const sessionId = p1.session.id;
    assert.equal(env.sessionManager.getSession(sessionId)?.status, 'CONNECTED');
    assert.equal(env.sessionManager.getConnectionGeneration(sessionId), 2);

    const firstDriverEntry = env.createdDrivers[0];

    // 1. Reconnect creates a new generation (#4) and disconnects the old socket
    await env.sessionManager.reconnectSession(sessionId, adminId);
    assert.equal(env.sessionManager.getSession(sessionId)?.status, 'CONNECTED');
    const newGen = env.sessionManager.getConnectionGeneration(sessionId);
    assert.ok(newGen > 2);

    // 2. Emit a stale `DISCONNECTED` or `LOGGED_OUT` event from the OLD socket (`firstDriverEntry`):
    // SessionManager MUST ignore it because its generation is stale!
    firstDriverEntry.capturedCallbacks?.onStatusChange({
      status: 'LOGGED_OUT',
      statusCode: DisconnectReason.loggedOut,
      errorMessage: 'Stale logout from old socket',
    });
    assert.equal(env.sessionManager.getSession(sessionId)?.status, 'CONNECTED');

    // 3. Test bounded reconnect exhaustion when network stays down (`shouldFailConnect = true`)
    const currentDriverEntry = env.createdDrivers[env.createdDrivers.length - 1];
    env.setNextDriverConfig({ shouldFailConnect: true });
    currentDriverEntry.driver.simulateDisconnect(428, 'Connection lost');

    // Wait for the 2 bounded reconnect attempts to run and exhaust
    await new Promise((r) => setTimeout(r, 220));
    const exhaustedSession = env.sessionManager.getSession(sessionId)!;
    assert.equal(exhaustedSession.status, 'FAILED');
    assert.ok(
      exhaustedSession.last_error?.includes('تم تجاوز الحد الأقصى لمحاولات إعادة الاتصال')
    );

    // 4. Test LOGGED_OUT (401) on an active session -> purges auth dir and never schedules reconnect
    env.setNextDriverConfig({});
    const p2 = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966505552222',
      actorTelegramId: adminId,
      autoCompleteInMock: true,
    });
    const sess2Id = p2.session.id;
    assert.equal(env.sessionStore.hasRegisteredCredentials(sess2Id), true);

    const drv2Entry = env.createdDrivers[env.createdDrivers.length - 1];
    drv2Entry.driver.simulateDisconnect(DisconnectReason.loggedOut, 'Logged out from phone');

    const loggedOutVerif = env.sessionManager.getLiveVerification(sess2Id)!;
    assert.equal(loggedOutVerif.session.status, 'LOGGED_OUT');
    assert.equal(loggedOutVerif.hasReconnectTimer, false);
    assert.equal(env.sessionStore.hasRegisteredCredentials(sess2Id), false);
  } finally {
    await env.cleanup();
  }
});

test('Section 17.هـ: Auth State Persistence & Startup Restoration — restores only registered credentials, skips incomplete pairing folders, and handles corrupted creds.json safely', async () => {
  const env = createLifecycleTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // Session A: Truly authenticated session (has registered credentials)
    const sA = env.sessionManager.createSession('جلسة موثقة', adminId);
    env.sessionStore.writeMockAuthMarker(sA.id, '+966*****1111', true);
    env.sessionRepo.updateStatus({ id: sA.id, status: 'DISCONNECTED' });

    // Session B: Unregistered Baileys pairing-attempt folder (`registered: false`, no `account`)
    const sB = env.sessionManager.createSession('جلسة غير مكتملة الربط', adminId);
    const dirB = env.sessionStore.prepareSessionAuthDir(sB.id);
    const { state: stateB, saveCreds: saveCredsB } = await useMultiFileAuthState(dirB);
    // Simulate `requestPairingCode` having set `creds.me` while `registered` is still `false`
    stateB.creds.me = { id: '966502222222@s.whatsapp.net', name: '~' };
    await saveCredsB();
    env.sessionRepo.updateStatus({ id: sB.id, status: 'PAIRING_PENDING' });

    assert.equal(env.sessionStore.hasRegisteredCredentials(sB.id), false);

    // Session C: Corrupted `creds.json` file on disk
    const sC = env.sessionManager.createSession('جلسة بملف تالف', adminId);
    const dirC = env.sessionStore.prepareSessionAuthDir(sC.id);
    fs.writeFileSync(path.join(dirC, 'creds.json'), '{ invalid json !!!', 'utf-8');
    env.sessionRepo.updateStatus({ id: sC.id, status: 'CONNECTED' });

    assert.equal(env.sessionStore.inspectCredentials(sC.id).corrupted, true);

    // Run startup restoration
    const res = await env.sessionManager.restoreSessionsOnStartup();
    assert.equal(res.restoredCount, 1); // Only Session A was restored!
    assert.equal(res.skippedCount, 2); // Session B and C were skipped!

    assert.equal(env.sessionManager.getSession(sA.id)?.status, 'CONNECTED');
    assert.equal(env.sessionManager.getSession(sB.id)?.status, 'DISCONNECTED');
    assert.equal(env.sessionManager.getSession(sC.id)?.status, 'FAILED');
    assert.ok(env.sessionManager.getSession(sC.id)?.last_error?.includes('تالف'));

    // Verify Session A's credentials were preserved and not deleted
    assert.equal(env.sessionStore.hasRegisteredCredentials(sA.id), true);
  } finally {
    await env.cleanup();
  }
});

test('Section 17.و & 17.ز: Multi-Session Isolation, Concurrent Pairing Lock, and /start Cancel Without Orphan Sessions', async () => {
  const env = createLifecycleTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. User opens "Add Account", types invalid phone, then sends `/start`:
    // Must NOT create any orphan session in SQLite!
    await env.controller.handleCallbackQuery(adminId, 'menu:link_account');
    const invalidReply = await env.controller.handleTextMessage(adminId, 'invalid_phone_input');
    assert.ok(invalidReply.text.includes('تعذر إتمام الربط'));
    assert.equal(env.sessionManager.listSessions().length, 0);

    const startReply = await env.controller.handleTextMessage(adminId, '/start');
    assert.ok(startReply.text.includes('لوحة التحكم المركزية'));
    assert.equal(env.controller.getConversationMode(adminId), 'NONE');
    assert.equal(env.sessionManager.listSessions().length, 0); // Still 0 orphan sessions!

    // 2. Concurrent pairing requests for the same phone number are blocked from creating duplicate sockets
    const [res1, res2] = await Promise.allSettled([
      env.sessionManager.initiatePairing({
        rawPhoneNumber: '+966509991111',
        actorTelegramId: adminId,
      }),
      env.sessionManager.initiatePairing({
        rawPhoneNumber: '+966509991111',
        actorTelegramId: adminId,
      }),
    ]);
    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled');
    const rejected = [res1, res2].filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(env.sessionManager.listSessions().length, 1);

    // 3. Multi-session isolation: disconnecting or failing session 1 does not affect session 2
    const pair2 = await env.sessionManager.initiatePairing({
      rawPhoneNumber: '+966509992222',
      actorTelegramId: adminId,
      autoCompleteInMock: true,
    });
    const sess1Id = (fulfilled[0] as PromiseFulfilledResult<any>).value.session.id;
    const sess2Id = pair2.session.id;

    await env.sessionManager.disconnectSession(sess1Id, adminId);
    assert.equal(env.sessionManager.getSession(sess1Id)?.status, 'DISCONNECTED');
    assert.equal(env.sessionManager.getSession(sess2Id)?.status, 'CONNECTED');
  } finally {
    await env.cleanup();
  }
});

test('Section 17.ح: 405 Protocol Handshake Rejection, Pre-Ready Disconnect (428), and WhatsApp Web Version Resolution Integrity', async () => {
  const env = createLifecycleTestHarness();
  try {
    const adminId = env.config.TELEGRAM_ADMIN_ID;

    // 1. Verify resolveWhatsAppWebVersion resolves a modern revision (> 1030831524)
    const verInfo = await resolveWhatsAppWebVersion(true);
    assert.equal(Array.isArray(verInfo.version), true);
    assert.equal(verInfo.version.length, 3);
    assert.equal(verInfo.version[0], 2);
    assert.equal(verInfo.version[1], 3000);
    assert.ok(
      verInfo.version[2] > 1030831524,
      `Expected modern WA Web revision > 1030831524, got ${verInfo.version.join('.')}`
    );

    // 2. Verify describeDisconnectReasonArabic(405) distinguishes protocol rejection from phone validation
    const msg405 = describeDisconnectReasonArabic(405, 'Connection Failure', {
      reason: '405',
      location: 'vll',
    });
    assert.ok(msg405.includes('405'));
    assert.ok(msg405.includes('مصافحة البروتوكول'));
    assert.ok(!msg405.includes('رقم الهاتف غير صالح'));

    // 3. Simulate 405 handshake rejection during pairing (`simulatedCloseStatusCodeBeforeReady = 405`):
    // Must NEVER produce a fake success or mark the session CONNECTED, must NOT blame the phone number,
    // and must NOT schedule background auto-reconnects.
    env.setNextDriverConfig({ simulatedCloseStatusCodeBeforeReady: 405 });
    await assert.rejects(
      () =>
        env.sessionManager.initiatePairing({
          rawPhoneNumber: '+966508881111',
          actorTelegramId: adminId,
        }),
      (err: any) => {
        assert.equal(err.category, 'WHATSAPP_CONNECTION_ERROR');
        assert.ok(err.arabicUserMessage.includes('405'));
        assert.ok(!err.arabicUserMessage.includes('صيغة رقم الهاتف'));
        return true;
      }
    );

    const sessionsAfter405 = env.sessionManager.listSessions();
    assert.equal(sessionsAfter405.length, 1);
    const failed405Session = sessionsAfter405[0];
    assert.equal(failed405Session.status, 'FAILED');
    assert.notEqual(failed405Session.status, 'CONNECTED');
    assert.ok(failed405Session.last_error?.includes('405'));
    const verif405 = env.sessionManager.getLiveVerification(failed405Session.id)!;
    assert.equal(verif405.hasReconnectTimer, false);
    assert.equal(verif405.hasActiveDriver, false);
    assert.equal(verif405.socketDiagnostics.socketActive, false);

    // 4. Simulate pre-ready socket disconnect (`428`) before pairing code generation
    env.setNextDriverConfig({ simulatedCloseStatusCodeBeforeReady: 428 });
    await assert.rejects(
      () =>
        env.sessionManager.initiatePairing({
          rawPhoneNumber: '+966508882222',
          actorTelegramId: adminId,
        }),
      (err: any) => {
        assert.equal(err.category, 'WHATSAPP_CONNECTION_ERROR');
        assert.ok(err.arabicUserMessage.includes('428'));
        return true;
      }
    );

    const sessionsAfter428 = env.sessionManager.listSessions();
    const failed428Session = sessionsAfter428.find(
      (s) => s.id !== failed405Session.id
    )!;
    assert.equal(failed428Session.status, 'FAILED');
    assert.equal(
      env.sessionManager.getLiveVerification(failed428Session.id)?.hasReconnectTimer,
      false
    );
  } finally {
    await env.cleanup();
  }
});

