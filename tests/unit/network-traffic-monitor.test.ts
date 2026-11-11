import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

import {
  NetworkTrafficMonitor,
  formatBinaryNodePreview,
  formatBodyPreview,
} from '../../src/network/network-traffic-monitor';
import { sanitizeUrl } from '../../src/security/redaction';
import {
  HiroosyBaileysSessionDriver,
  MockWhatsAppSessionDriver,
  BinaryNode,
} from '../../src/whatsapp/connection-manager';
import { WASocket } from '../../src/whatsapp/baileys-compat';
import { OperationRateLimiter } from '../../src/security/validation';
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
import { MAX_TELEGRAM_CALLBACK_DATA_BYTES } from '../../src/bot/keyboards/main-menu';

test('1. NetworkTrafficMonitor: sanitizeUrl, Header/Token Redaction, Binary/JSON Previews, and Ring Buffer Eviction', () => {
  const rawTelegramUrl =
    'https://api.telegram.org/bot123456789:AAH_super_secret_bot_token_1234567890/sendMessage?token=my_secret_query';
  const cleanedUrl = sanitizeUrl(rawTelegramUrl);
  assert.equal(cleanedUrl.includes('AAH_super_secret_bot_token'), false);
  assert.equal(cleanedUrl.includes('my_secret_query'), false);
  assert.ok(cleanedUrl.includes('/bot[REDACTED_TOKEN]/sendMessage'));
  assert.ok(cleanedUrl.includes('token=[REDACTED]'));

  // Binary buffer preview formatting
  const jpegBuf = Buffer.alloc(2048, 0xff);
  const binPreview = formatBodyPreview(jpegBuf, 'image/jpeg');
  assert.equal(binPreview.byteLength, 2048);
  assert.equal(binPreview.preview, '[Binary Buffer: image/jpeg, 2.0 KB]');

  // BinaryNode XML preview with <enc> payload redaction
  const sampleNode = {
    tag: 'message',
    attrs: {
      id: '3EB0123456',
      to: '966501234567@s.whatsapp.net',
      type: 'text',
    },
    content: [
      {
        tag: 'enc',
        attrs: { v: '2', type: 'pkmsg' },
        content: new Uint8Array(64),
      },
    ],
  };
  const xmlPreview = formatBinaryNodePreview(sampleNode);
  assert.ok(xmlPreview.includes('<message'));
  assert.ok(xmlPreview.includes('<enc v="2" type="pkmsg">[Encrypted 64B]</enc>'));

  // Bounded Ring Buffer eviction test
  const boundedMonitor = new NetworkTrafficMonitor(10);
  for (let i = 1; i <= 25; i++) {
    boundedMonitor.recordHttpTransaction({
      method: 'POST',
      url: `https://api.telegram.org/bot123456789:AAH_secret_token_abcdefghijklm/sendMessage?seq=${i}`,
      statusCode: i === 20 ? 500 : 200,
      durationMs: i * 10,
      requestHeaders: {
        authorization: 'Bearer secret_jwt_token_value',
        'content-type': 'application/json',
      },
      requestBody: JSON.stringify({ chat_id: 123, text: `Hello #${i}` }),
      responseBody: JSON.stringify({ ok: i !== 20, result: { message_id: i } }),
    });
  }

  const metrics = boundedMonitor.getMetrics();
  assert.equal(metrics.totalEntries, 10);
  assert.equal(metrics.maxEntries, 10);
  assert.ok(metrics.totalTxBytes > 0);
  assert.ok(metrics.totalRxBytes > 0);
  assert.equal(metrics.errorCount, 1);

  const allEntries = boundedMonitor.queryEntries({
    filter: 'ALL',
    page: 1,
    pageSize: 20,
  });
  assert.equal(allEntries.items.length, 10);
  // Newest entry should be seq=25, oldest retained should be seq=16
  assert.ok(allEntries.items[0].requestBodyPreview?.includes('Hello #25'));
  assert.equal(
    allEntries.items[0].requestHeaders?.authorization,
    '[REDACTED]'
  );
  assert.ok(
    allEntries.items[0].targetOrUrl.includes('bot[REDACTED_TOKEN]')
  );

  // Test pause/resume capture
  boundedMonitor.setCaptureEnabled(false);
  boundedMonitor.recordHttpTransaction({
    method: 'GET',
    url: 'https://example.com/should-not-be-stored',
    statusCode: 200,
    durationMs: 12,
  });
  assert.equal(
    boundedMonitor
      .queryEntries({ filter: 'ALL', page: 1, pageSize: 20 })
      .items.some((e) => e.targetOrUrl.includes('should-not-be-stored')),
    false
  );

  boundedMonitor.setCaptureEnabled(true);
  boundedMonitor.clearBuffer();
  assert.equal(boundedMonitor.getMetrics().totalEntries, 0);
});

test('2. WhatsApp BinaryNode & Socket Telemetry Instrumentation (Outbound query/sendNode/sendMessage + Inbound CB:iq/CB:message)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-net-wa-'));
  const driver = new HiroosyBaileysSessionDriver('sess_net_wa', tmpDir);
  const ev = new EventEmitter();
  const wsEv = new EventEmitter();

  const fakeSock: Record<string, unknown> = {
    ev: {
      on: (event: string, cb: (...args: unknown[]) => void) => ev.on(event, cb),
      off: (event: string, cb: (...args: unknown[]) => void) => ev.off(event, cb),
    },
    ws: {
      on: (event: string, cb: (node: unknown) => void) => wsEv.on(event, cb),
      off: (event: string, cb: (node: unknown) => void) => wsEv.off(event, cb),
    },
    user: { id: '966500000001:1@s.whatsapp.net' },
    query: async (node: BinaryNode) => {
      await new Promise((r) => setTimeout(r, 15));
      return {
        tag: 'iq',
        attrs: {
          id: node.attrs?.id || 'iq_1',
          from: 's.whatsapp.net',
          type: 'result',
        },
        content: [{ tag: 'usync', attrs: {}, content: [] }],
      };
    },
    sendNode: async (_node: BinaryNode) => {
      await new Promise((r) => setTimeout(r, 5));
    },
    sendMessage: async (jid: string, content: Record<string, unknown>) => ({
      key: { remoteJid: jid, fromMe: true, id: 'WA_MSG_NET_1' },
      message: content,
    }),
    end: () => undefined,
  };

  driver.attachSocketForTesting(fakeSock as unknown as WASocket);

  await driver.query({
    tag: 'iq',
    attrs: { id: 'usync_req_99', to: 's.whatsapp.net', type: 'get', xmlns: 'usync' },
    content: [{ tag: 'query', attrs: {} }],
  });

  await driver.sendNode({
    tag: 'presence',
    attrs: { type: 'available' },
  });

  // Emit inbound CB:call stanza over ws
  wsEv.emit('CB:call', {
    tag: 'call',
    attrs: { from: '966501234567@s.whatsapp.net', id: 'call_stanza_1' },
    content: [
      {
        tag: 'offer',
        attrs: { 'call-id': 'CALL_ABC_123' },
        content: [{ tag: 'enc', attrs: { v: '2' }, content: new Uint8Array(48) }],
      },
    ],
  });

  const globalMonitor = (await import('../../src/network/network-traffic-monitor')).getNetworkTrafficMonitor();
  const waEntries = globalMonitor.queryEntries({
    filter: 'WA_STANZA',
    sessionId: 'sess_net_wa',
    page: 1,
    pageSize: 10,
  });

  assert.ok(waEntries.items.length >= 3);
  const inboundCall = waEntries.items.find((e) => e.methodOrTag === 'CALL');
  assert.ok(inboundCall);
  assert.equal(inboundCall.direction, 'INBOUND');
  assert.ok(inboundCall.responseBodyPreview?.includes('[Encrypted 48B]'));

  const outboundIq = waEntries.items.find(
    (e) => e.methodOrTag === 'IQ' && e.direction === 'OUTBOUND'
  );
  assert.ok(outboundIq);
  assert.ok(outboundIq.durationMs >= 10);

  await driver.disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('3. NetworkTrafficHandler & TelegramBotController End-to-End: menu:network, Filters, Deep Inspect, Live Ping, JSON Export, and Owner-Only Security', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-net-bot-'));
  const authBaseDir = path.join(tmpDir, 'auth');
  const tempMediaDir = path.join(tmpDir, 'media');
  fs.mkdirSync(authBaseDir, { recursive: true });
  fs.mkdirSync(tempMediaDir, { recursive: true });

  const ownerId = 777000111;
  const premiumNonOwnerId = 888000222;
  const strangerId = 999000333;

  const config: AppConfig = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_network_inspector',
    TELEGRAM_ADMIN_ID: ownerId,
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

  // Grant premium to premiumNonOwnerId to verify Owner-Only still blocks them from Network Inspector!
  settingsRepo.addPremiumSubscription(String(premiumNonOwnerId), 30, 'USER');

  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId) => {
      const drv = new MockWhatsAppSessionDriver(sessionId);
      drv.simulatedDelayMs = 5;
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
    settingsRepo,
    auditRepo,
  });

  // Create a session and send a simulated message to generate WA_STANZA traffic
  const s1 = sessionManager.createSession('جلسة رصد الشبكة', ownerId);
  await sessionManager.initiatePairing({
    sessionId: s1.id,
    rawPhoneNumber: '+966501234567',
    actorTelegramId: ownerId,
  });
  const driver = sessionManager.getDriver(s1.id);
  await driver.sendTextMessage('966509998888@s.whatsapp.net', 'رسالة فحص مرصد الشبكة');

  // Record a sample VoIP telemetry entry and a sample Local API entry
  const monitor = (await import('../../src/network/network-traffic-monitor')).getNetworkTrafficMonitor();
  monitor.recordVoipStreamTelemetry({
    sessionId: s1.id,
    callId: 'VCALL_NET_TEST_1',
    recipientJid: '966509998888@s.whatsapp.net',
    durationMs: 5000,
    txPackets: 250,
    rxPackets: 240,
    txBytes: 180_000,
    rxBytes: 175_000,
  });
  monitor.recordLocalApiRequest({
    method: 'POST',
    route: '/api/harness',
    actionSummary: 'callback: menu:network',
    clientIp: '127.0.0.1',
    statusCode: 200,
    durationMs: 8,
  });

  // 1. Main menu includes 🌐 حركة مرور الشبكة والطلبات for Owner
  const mainMenu = await controller.handleTextMessage(ownerId, '/start');
  const allButtons = mainMenu.keyboard.flat();
  assert.ok(allButtons.some((b) => b.callbackData === 'menu:network'));

  // 2. Open menu:network dashboard
  const netDash = await controller.handleCallbackQuery(ownerId, 'menu:network');
  assert.ok(
    netDash.text.includes('مرصد حركة مرور الشبكة والبروتوكول الحي')
  );
  assert.ok(netDash.text.includes('النطاق الترددي (Bandwidth)'));
  assert.ok(netDash.text.includes('Live Stream Feed'));

  // Verify every button in the Network dashboard respects Telegram's 64-byte callback_data limit
  for (const row of netDash.keyboard) {
    for (const btn of row) {
      const byteLen = Buffer.byteLength(btn.callbackData, 'utf8');
      assert.ok(
        byteLen <= MAX_TELEGRAM_CALLBACK_DATA_BYTES,
        `Callback exceeds 64 bytes: ${btn.callbackData}`
      );
    }
  }

  // 3. Test Channel Filters (WA_STANZA, VOIP_RTP, LOCAL_API, HTTP, ERRORS)
  const waFilterView = await controller.handleCallbackQuery(
    ownerId,
    'net:list:WA_STANZA:1'
  );
  assert.ok(waFilterView.text.includes('عقد واتساب الثنائية'));

  const voipFilterView = await controller.handleCallbackQuery(
    ownerId,
    'net:list:VOIP_RTP:1'
  );
  assert.ok(voipFilterView.text.includes('VCALL'));
  assert.ok(voipFilterView.text.includes('VoIP RTP/SRTP'));

  // 4. Test Deep Request Inspection (net:view:<shortId> & /netinspect <shortId>)
  const inspectBtn = netDash.keyboard
    .flat()
    .find((b) => b.callbackData.startsWith('net:view:'));
  assert.ok(inspectBtn, 'Expected at least one 🔍 #1 inspection button');
  const detailView = await controller.handleCallbackQuery(
    ownerId,
    inspectBtn.callbackData
  );
  assert.ok(detailView.text.includes('الفحص العميق للطلب / العقدة'));
  assert.ok(detailView.text.length <= 4096);

  const shortId = inspectBtn.callbackData.slice('net:view:'.length);
  const cmdInspectView = await controller.handleTextMessage(
    ownerId,
    `/netinspect ${shortId}`
  );
  assert.ok(cmdInspectView.text.includes('الفحص العميق للطلب / العقدة'));

  // 5. Test /nettraffic command with filter
  const cmdTrafficView = await controller.handleTextMessage(
    ownerId,
    '/nettraffic WA_STANZA'
  );
  assert.ok(cmdTrafficView.text.includes('عقد واتساب الثنائية'));

  // 6. Test Export Full JSON Report (net:export)
  const exportView = await controller.handleCallbackQuery(ownerId, 'net:export');
  assert.ok(exportView.mediaAttachments);
  assert.equal(exportView.mediaAttachments.length, 1);
  assert.equal(exportView.mediaAttachments[0].kind, 'document');
  assert.ok(
    exportView.mediaAttachments[0].fileName.endsWith('.json')
  );
  const exportedJson = JSON.parse(
    exportView.mediaAttachments[0].buffer!.toString('utf8')
  );
  assert.equal(
    exportedJson.redactionPolicy,
    'STRICT_TOKEN_AND_KEY_REDACTION_ENABLED'
  );
  assert.ok(Array.isArray(exportedJson.entries));

  // 7. Test Toggle Capture (net:toggle)
  const pausedView = await controller.handleCallbackQuery(ownerId, 'net:toggle');
  assert.ok(pausedView.text.includes('متوقف مؤقتاً'));
  const resumedView = await controller.handleCallbackQuery(
    ownerId,
    'net:toggle'
  );
  assert.ok(resumedView.text.includes('نشط'));

  // 8. Verify Owner-Only Protection blocks both Non-Owner Premium subscribers and strangers
  await assert.rejects(
    async () => {
      await controller.handleCallbackQuery(premiumNonOwnerId, 'menu:network');
    },
    /غير مصرح/
  );
  await assert.rejects(
    async () => {
      await controller.handleTextMessage(premiumNonOwnerId, '/nettraffic');
    },
    /غير مصرح/
  );
  await assert.rejects(
    async () => {
      await controller.handleTextMessage(strangerId, '/netinspect 1234');
    },
    /غير مصرح/
  );

  await sessionManager.shutdownAll();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
