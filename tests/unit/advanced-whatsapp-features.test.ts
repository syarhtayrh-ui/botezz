import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

import {
  HiroosyBaileysSessionDriver,
  MockWhatsAppSessionDriver,
  SessionMemoryStore,
  BinaryNode,
} from '../../src/whatsapp/connection-manager';
import { validateRecipient, OperationRateLimiter } from '../../src/security/validation';
import { WASocket } from '../../src/whatsapp/baileys-compat';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { TelegramBotController } from '../../src/bot/bot';
import { AppConfig } from '../../src/config/env';

function createFakeBaileysSocket(overrides?: Partial<Record<string, any>>): {
  sock: WASocket;
  ev: EventEmitter;
  sentMessages: Array<{
    jid: string;
    content: Record<string, unknown>;
    options?: Record<string, unknown>;
  }>;
  queriedNodes: BinaryNode[];
  presenceUpdates: Array<{ type: string; toJid?: string }>;
  presenceSubscriptions: string[];
  migratedSessions: Array<{ fromJid: string; toJid: string }>;
  assertedSessions: string[][];
  storedKeyMappings: Array<Record<string, unknown>>;
} {
  const ev = new EventEmitter();
  const sentMessages: Array<{
    jid: string;
    content: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const queriedNodes: BinaryNode[] = [];
  const presenceUpdates: Array<{ type: string; toJid?: string }> = [];
  const presenceSubscriptions: string[] = [];
  const migratedSessions: Array<{ fromJid: string; toJid: string }> = [];
  const assertedSessions: string[][] = [];
  const storedKeyMappings: Array<Record<string, unknown>> = [];
  const lidMap = new Map<string, string>();
  const pnMap = new Map<string, string>();

  const baseSock: Record<string, any> = {
    ev: {
      on: (event: string, listener: (...args: any[]) => void) => {
        ev.on(event, listener);
      },
      off: (event: string, listener: (...args: any[]) => void) => {
        ev.off(event, listener);
      },
      removeAllListeners: (event?: string) => {
        ev.removeAllListeners(event);
      },
    },
    user: {
      id: '966500000001:1@s.whatsapp.net',
      lid: '10000000000001:1@lid',
      name: 'Botezz Operator',
    },
    authState: {
      creds: {
        registered: true,
        me: {
          id: '966500000001:1@s.whatsapp.net',
          lid: '10000000000001:1@lid',
        },
      },
      keys: {
        get: async () => ({}),
        set: async (data: Record<string, unknown>) => {
          storedKeyMappings.push(data);
        },
      },
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => lidMap.get(pn) ?? null,
        getPNForLID: async (lid: string) => pnMap.get(lid) ?? null,
        storeLIDPNMappings: async (
          mappings: Array<{ lid: string; pn: string }>
        ) => {
          for (const m of mappings) {
            lidMap.set(m.pn, m.lid);
            pnMap.set(m.lid, m.pn);
          }
        },
      },
      migrateSession: async (fromJid: string, toJid: string) => {
        migratedSessions.push({ fromJid, toJid });
        return { migrated: 1, skipped: 0, total: 1 };
      },
    },
    sendMessage: async (
      jid: string,
      content: Record<string, unknown>,
      options?: Record<string, unknown>
    ) => {
      sentMessages.push({ jid, content, options });
      return {
        key: {
          remoteJid: jid,
          fromMe: true,
          id: `MSG_${sentMessages.length}`,
        },
        message: content,
      };
    },
    relayMessage: async (jid: string, message: Record<string, unknown>, options?: Record<string, unknown>) => {
      sentMessages.push({ jid, content: message, options });
      return `RELAY_${sentMessages.length}`;
    },
    sendPresenceUpdate: async (type: string, toJid?: string) => {
      presenceUpdates.push({ type, toJid });
    },
    presenceSubscribe: async (toJid: string) => {
      presenceSubscriptions.push(toJid);
    },
    getUSyncDevices: async (jids: string[]) => [
      { user: jids[0]?.split('@')[0] || '966501234567', device: 0 },
      { user: jids[0]?.split('@')[0] || '966501234567', device: 33 },
    ],
    assertSessions: async (jids: string[]) => {
      assertedSessions.push(jids);
      return true;
    },
    onWhatsApp: async (...jids: string[]) =>
      jids.map((j) => ({
        jid: j,
        exists: true,
        lid: '24681357901234@lid',
      })),
    fetchStatus: async (jid: string) => [
      {
        id: jid,
        status: {
          status: 'متصل عبر بروتوكول واتساب للأعمال',
          setAt: new Date('2026-03-15T10:30:00.000Z'),
        },
      },
    ],
    profilePictureUrl: async (jid: string, type?: 'preview' | 'image') =>
      `https://pps.whatsapp.net/v/t61.24694-24/${type || 'image'}_${jid.split('@')[0]}.jpg`,
    getBusinessProfile: async (jid: string) => ({
      wid: jid,
      category: 'Software & Cloud Engineering',
      description: 'Official Enterprise Account',
      email: 'ops@example.com',
      website: ['https://example.com'],
      address: 'Riyadh, Saudi Arabia',
      latitude: 24.7136,
      longitude: 46.6753,
      business_hours: {
        timezone: 'Asia/Riyadh',
        config: [
          {
            day_of_week: 'sun',
            mode: 'specific_hours',
            open_time: 540,
            close_time: 1020,
          },
        ],
      },
    }),
    query: async (node: BinaryNode) => {
      queriedNodes.push(node);
      return { tag: 'iq', attrs: { type: 'result' }, content: [] };
    },
    end: () => undefined,
    ...overrides,
  };

  return {
    sock: baseSock as unknown as WASocket,
    ev,
    sentMessages,
    queriedNodes,
    presenceUpdates,
    presenceSubscriptions,
    migratedSessions,
    assertedSessions,
    storedKeyMappings,
  };
}

test('1. validateRecipient & LID Resolution + sendAnonymousLidMessage across all 4 protocol layers', async () => {
  // Validate @lid format in security/validation.ts
  const lidCheck = validateRecipient('24681357901234:12@lid');
  assert.equal(lidCheck.jid, '24681357901234@lid');
  assert.equal(lidCheck.isLid, true);
  assert.equal(lidCheck.isGroup, false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-adv-lid-'));
  const driver = new HiroosyBaileysSessionDriver('sess_lid_1', tmpDir);
  const fake = createFakeBaileysSocket({
    onWhatsApp: async (jid: string) => [
      {
        jid,
        exists: true,
        lid: { id: '99887766554433@lid' } as unknown as string,
      },
    ],
  });
  driver.attachSocketForTesting(fake.sock);

  // Layer 1: Direct @lid input
  const direct = await driver.resolveLidForRecipient('11223344556677@lid');
  assert.equal(direct.lidJid, '11223344556677@lid');
  assert.equal(direct.source, 'DIRECT_LID');

  // Layer 3: USync onWhatsApp (object lid format) -> also populates lidMapping & authState.keys
  const viaUsync = await driver.resolveLidForRecipient('+966501234567');
  assert.equal(viaUsync.pnJid, '966501234567@s.whatsapp.net');
  assert.equal(viaUsync.lidJid, '99887766554433@lid');
  assert.equal(viaUsync.source, 'ON_WHATSAPP_USYNC');
  assert.ok(fake.storedKeyMappings.length > 0);

  // Layer 2: Subsequent lookup hits LID_MAPPING_STORE directly
  const viaStore = await driver.resolveLidForRecipient('+966501234567');
  assert.equal(viaStore.lidJid, '99887766554433@lid');
  assert.equal(viaStore.source, 'LID_MAPPING_STORE');

  // Send anonymous LID message and verify session migration + addressingMode: 'lid' + message cache
  const sendRes = await driver.sendAnonymousLidMessage({
    recipient: '+966501234567',
    text: 'رسالة سرية عبر بروتوكول LID',
  });
  assert.equal(sendRes.targetLid, '99887766554433@lid');
  assert.equal(sendRes.resolvedPn, '966501234567@s.whatsapp.net');
  assert.equal(fake.migratedSessions.length, 1);
  assert.deepEqual(fake.migratedSessions[0], {
    fromJid: '966501234567@s.whatsapp.net',
    toJid: '99887766554433@lid',
  });
  assert.equal(fake.assertedSessions.length, 1);
  assert.deepEqual(fake.assertedSessions[0], ['99887766554433@lid']);

  assert.equal(fake.sentMessages.length, 1);
  assert.equal(fake.sentMessages[0].jid, '99887766554433@lid');
  assert.equal(
    (
      fake.sentMessages[0].content as {
        extendedTextMessage?: { text?: string };
      }
    )?.extendedTextMessage?.text,
    'رسالة سرية عبر بروتوكول LID'
  );
  assert.equal(fake.sentMessages[0].options?.addressingMode, 'lid');
  assert.deepEqual(
    fake.sentMessages[0].options?.additionalAttributes,
    { addressing_mode: 'lid' }
  );
  assert.ok(
    driver.memoryStore.getMessage({
      remoteJid: '99887766554433@lid',
      id: sendRes.messageId,
    })
  );

  // Layer 3c: Direct USync IQ <user jid="..."><lid val="..."/></user> fallback when onWhatsApp omits lid
  const fakeUsyncXml = createFakeBaileysSocket({
    onWhatsApp: async (jid: string) => [{ jid, exists: true }],
    query: async (node: BinaryNode) => {
      fake.queriedNodes.push(node);
      return {
        tag: 'iq',
        attrs: { type: 'result' },
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
                    attrs: { jid: '966507778889@s.whatsapp.net' },
                    content: [
                      {
                        tag: 'lid',
                        attrs: { val: '77788899900011@lid' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
    },
  });
  driver.attachSocketForTesting(fakeUsyncXml.sock);
  const viaRawUsyncIq = await driver.resolveLidForRecipient('+966507778889');
  assert.equal(viaRawUsyncIq.pnJid, '966507778889@s.whatsapp.net');
  assert.equal(viaRawUsyncIq.lidJid, '77788899900011@lid');
  assert.equal(viaRawUsyncIq.source, 'ON_WHATSAPP_USYNC');

  await driver.disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('2. Presence Tracking & Heartbeat Engine: merges @lid/@s.whatsapp.net, auto-expires stale composing, and sends heartbeat pulses', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-adv-pres-'));
  const driver = new HiroosyBaileysSessionDriver('sess_pres_1', tmpDir);
  const fake = createFakeBaileysSocket();
  driver.attachSocketForTesting(fake.sock);

  const updatesSeen: string[] = [];
  const trackPromise = driver.trackRecipientPresence({
    recipient: '+966501234567',
    durationSeconds: 1,
    staleComposingTimeoutMs: 300,
    onUpdate: (rec) => {
      updatesSeen.push(rec.currentState);
    },
  });

  await new Promise((r) => setTimeout(r, 80));

  // Emit presence on @s.whatsapp.net and then composing on @lid
  fake.ev.emit('presence.update', {
    id: '966501234567@s.whatsapp.net',
    presences: {
      '966501234567@s.whatsapp.net': {
        lastKnownPresence: 'available',
        lastSeen: 1710000000,
      },
    },
  });

  await new Promise((r) => setTimeout(r, 40));

  fake.ev.emit('presence.update', {
    id: '24681357901234@lid',
    presences: {
      '24681357901234@lid': {
        lastKnownPresence: 'composing',
      },
    },
  });

  const finalRecord = await trackPromise;
  // Stale composing (300ms) should have automatically reverted to 'available' before 1000ms finished!
  assert.equal(finalRecord.chatJid, '966501234567@s.whatsapp.net');
  assert.equal(finalRecord.resolvedLid, '24681357901234@lid');
  assert.equal(finalRecord.currentState, 'available');
  assert.ok(updatesSeen.includes('available'));
  assert.ok(updatesSeen.includes('composing'));
  assert.ok(finalRecord.transitions.length >= 3);
  assert.ok(finalRecord.totalOnlineDurationMs > 0);
  assert.ok(
    fake.presenceSubscriptions.includes('966501234567@s.whatsapp.net')
  );
  assert.ok(fake.presenceSubscriptions.includes('24681357901234@lid'));

  // Test Heartbeat Broadcast
  fake.presenceUpdates.length = 0;
  const hbRes = await driver.startPresenceHeartbeatBroadcast({
    recipient: '+966501234567',
    mode: 'recording',
    durationSeconds: 1,
    pulseIntervalMs: 350,
  });

  assert.ok(hbRes.pulsesSent >= 2);
  const recordingPulses = fake.presenceUpdates.filter(
    (u) =>
      u.type === 'recording' && u.toJid === '966501234567@s.whatsapp.net'
  );
  assert.ok(recordingPulses.length >= 2);
  const lastPulse = fake.presenceUpdates[fake.presenceUpdates.length - 1];
  assert.equal(lastPulse?.type, 'paused');
  assert.equal(lastPulse?.toJid, '966501234567@s.whatsapp.net');

  await driver.disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('3. Full Profile Inspector (fetchFullProfileInfo): aggregates 7 sources and classifies 401/404 profile picture & 1970 epoch status', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-adv-prof-'));
  const driver = new HiroosyBaileysSessionDriver('sess_prof_1', tmpDir);

  // Seed contact and group metadata in driver
  driver.memoryStore.contacts.set('966501234567@s.whatsapp.net', {
    id: '966501234567@s.whatsapp.net',
    notify: 'أحمد المهندس',
    verifiedName: 'Ahmed Tech Corp',
  });

  const fake = createFakeBaileysSocket({
    profilePictureUrl: async (_jid: string, _type?: string) => {
      const err = new Error('not-authorized') as Error & { data?: number };
      err.data = 401;
      throw err;
    },
    fetchStatus: async () => ({
      status: 'مشغول في اجتماع هندسي',
      setAt: new Date(0), // 1970 epoch should be filtered out as unset/hidden
    }),
  });
  driver.attachSocketForTesting(fake.sock);

  const report = await driver.fetchFullProfileInfo('+966501234567');
  assert.equal(report.existsOnWhatsApp, true);
  assert.equal(report.pnJid, '966501234567@s.whatsapp.net');
  assert.equal(report.e164Phone, '+966501234567');
  assert.equal(report.lidJid, '24681357901234@lid');
  assert.equal(report.pushName, 'أحمد المهندس');
  assert.equal(report.verifiedName, 'Ahmed Tech Corp');
  assert.equal(report.statusText, 'مشغول في اجتماع هندسي');
  assert.equal(report.statusSetAt, undefined); // 1970 epoch filtered!
  assert.equal(report.profilePicture.status, 'PRIVACY_HIDDEN');
  assert.equal(report.devices.totalCount, 2);
  assert.deepEqual(report.devices.primaryDevice, [0]);
  assert.deepEqual(report.devices.companionDevices, [33]);
  assert.equal(report.businessProfile?.isBusiness, true);
  assert.equal(
    report.businessProfile?.category,
    'Software & Cloud Engineering'
  );
  assert.ok(
    report.businessProfile?.businessHoursSummary?.[0]?.includes('09:00 - 17:00')
  );

  await driver.disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('4. Short-Timer Self-Destruct Message (sendShortEphemeralMessage): sends ephemeralExpiration and auto-revokes on timer or ON_READ (via message-receipt.update & messages.update)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-adv-eph-'));
  const driver = new HiroosyBaileysSessionDriver('sess_eph_1', tmpDir);
  const fake = createFakeBaileysSocket();
  driver.attachSocketForTesting(fake.sock);

  // Case A: ON_SEND auto-revoke after 1 second (with explicit setChatEphemeralIq: true)
  const ephSend = await driver.sendShortEphemeralMessage({
    recipient: '+966501234567',
    text: 'رسالة تختفي بعد ثانية واحدة',
    expirationSeconds: 1,
    triggerMode: 'ON_SEND',
    setChatEphemeralIq: true,
  });

  assert.equal(ephSend.expirationSeconds, 1);
  assert.equal(ephSend.triggerMode, 'ON_SEND');
  assert.equal(fake.queriedNodes.length, 1);
  assert.equal(fake.queriedNodes[0].attrs.xmlns, 'w:g2');
  assert.equal(fake.sentMessages.length, 1);
  assert.equal(fake.sentMessages[0].jid, '966501234567@s.whatsapp.net');
  assert.equal(fake.sentMessages[0].options?.ephemeralExpiration, 1);

  // Wait 1.15s for the auto-revoke timer to fire
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(fake.sentMessages.length, 2);
  const revokeCall = fake.sentMessages[1];
  assert.equal(revokeCall.jid, '966501234567@s.whatsapp.net');
  assert.deepEqual(revokeCall.content, {
    delete: {
      remoteJid: '966501234567@s.whatsapp.net',
      fromMe: true,
      id: ephSend.messageId,
    },
  });

  // Case B: ON_READ mode waits for read receipt (or messages.update status=4) before starting countdown
  fake.sentMessages.length = 0;
  const ephRead = await driver.sendShortEphemeralMessage({
    recipient: '+966501234567',
    text: 'رسالة تحذف بعد القراءة بثانية',
    expirationSeconds: 1,
    triggerMode: 'ON_READ',
  });
  assert.equal(driver.pendingOnReadRevokes.has(ephRead.messageId), true);

  // Emit messages.update with status=4 (READ) to verify handleMessagesUpdateForReadRevoke
  fake.ev.emit('messages.update', [
    {
      key: {
        id: ephRead.messageId,
        remoteJid: '966501234567@s.whatsapp.net',
      },
      update: {
        status: 4,
      },
    },
  ]);

  assert.equal(driver.pendingOnReadRevokes.has(ephRead.messageId), false);
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(fake.sentMessages.length, 2);
  assert.deepEqual(fake.sentMessages[1].content, {
    delete: {
      remoteJid: '966501234567@s.whatsapp.net',
      fromMe: true,
      id: ephRead.messageId,
    },
  });

  // Case C: ON_READ mode also accepts string status='READ' in messages.update
  fake.sentMessages.length = 0;
  const ephReadString = await driver.sendShortEphemeralMessage({
    recipient: '+966501234567',
    text: 'رسالة تحذف بعد القراءة بحالة نصية READ',
    expirationSeconds: 1,
    triggerMode: 'ON_READ',
  });
  assert.equal(driver.pendingOnReadRevokes.has(ephReadString.messageId), true);
  fake.ev.emit('messages.update', [
    {
      key: {
        id: ephReadString.messageId,
        remoteJid: '966501234567@s.whatsapp.net',
      },
      update: {
        status: 'READ',
      },
    },
  ]);
  assert.equal(driver.pendingOnReadRevokes.has(ephReadString.messageId), false);
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(fake.sentMessages.length, 2);

  await driver.disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('5. TelegramBotController & ToolsHandler end-to-end commands (/anonmsg, /presence, /fullprofile, /ephemeral) and interactive buttons', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-adv-bot-'));
  const authBaseDir = path.join(tmpDir, 'auth');
  const tempMediaDir = path.join(tmpDir, 'media');
  fs.mkdirSync(authBaseDir, { recursive: true });
  fs.mkdirSync(tempMediaDir, { recursive: true });

  const adminId = 999111222;
  const config: AppConfig = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_advanced_suite',
    TELEGRAM_ADMIN_ID: adminId,
    DATABASE_PATH: ':memory:',
    WHATSAPP_AUTH_DIR: authBaseDir,
    TEMP_UPLOAD_DIR: tempMediaDir,
    LOG_LEVEL: 'silent',
    MAX_CONCURRENT_TASKS: 2,
    TASK_TIMEOUT_MS: 15_000,
    MAX_UPLOAD_SIZE_MB: 10,
  };

  const db = new AppDatabase(':memory:');
  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const auditRepo = new AuditRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const sessionStore = new SessionStore(authBaseDir);

  const mockDrivers = new Map<string, MockWhatsAppSessionDriver>();
  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId) => {
      const drv = new MockWhatsAppSessionDriver(sessionId);
      drv.simulatedDelayMs = 5;
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
    settingsRepo,
    auditRepo,
  });

  // Create and connect a session
  const createdSession = sessionManager.createSession('حساب اختبار', adminId);
  await sessionManager.initiatePairing({
    sessionId: createdSession.id,
    rawPhoneNumber: '+966501112222',
    actorTelegramId: adminId,
  });
  const mockDrv = mockDrivers.get(createdSession.id)!;

  // Check tools menu renders the 4 new buttons
  const toolsMenu = await controller.handleTextMessage(adminId, '/tools');
  assert.ok(toolsMenu.text.includes('/anonmsg'));
  assert.ok(toolsMenu.text.includes('/presence'));
  assert.ok(toolsMenu.text.includes('/fullprofile'));
  assert.ok(toolsMenu.text.includes('/ephemeral'));

  // 1. /anonmsg command
  const anonView = await controller.handleTextMessage(
    adminId,
    '/anonmsg +966509998888 رسالة اختبار عبر بروتوكول الهوية المخفية'
  );
  assert.ok(anonView.text.includes('تم إرسال الرسالة عبر بروتوكول الهوية المخفية'));
  assert.ok(anonView.text.includes('@lid'));
  assert.equal(mockDrv.sentAnonymousLidMessages.length, 1);

  // 2. /presence command (track & heartbeat)
  const presTrackView = await controller.handleTextMessage(
    adminId,
    '/presence track +966509998888 1'
  );
  assert.ok(presTrackView.text.includes('تقرير رصد التواجد الحي'));
  assert.ok(presTrackView.text.includes('سجل التحولات الزمنية'));

  const presHbView = await controller.handleTextMessage(
    adminId,
    '/presence composing +966509998888 1'
  );
  assert.ok(presHbView.text.includes('اكتمل بث نبضات التواجد الحي'));

  // 3. /fullprofile command
  const profileView = await controller.handleTextMessage(
    adminId,
    '/fullprofile +966509998888'
  );
  assert.ok(profileView.text.includes('تقرير الفحص الشامل للملف الشخصي'));
  assert.ok(profileView.text.includes('الأجهزة المرتبطة'));
  assert.ok(profileView.text.includes('بيانات حساب الأعمال'));

  // 4. /ephemeral command & interactive preset callback
  await controller.handleCallbackQuery(adminId, 'tools:ephemeral_preset:5');
  const ephView = await controller.handleTextMessage(
    adminId,
    '+966509998888 رسالة مؤقتة 5 ثوانٍ'
  );
  assert.ok(ephView.text.includes('تم إرسال رسالة التدمير الذاتي القصير بنجاح'));
  assert.ok(ephView.text.includes('5 ثانية'));
  assert.equal(mockDrv.sentShortEphemeralMessages.length, 1);
  assert.equal(mockDrv.sentShortEphemeralMessages[0].expirationSeconds, 5);

  await sessionManager.shutdownAll();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
