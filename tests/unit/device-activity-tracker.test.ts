import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  DeviceActivityTracker,
  ActivePresenceTrackerRegistry,
  getActivePresenceTrackerRegistry,
  parseTrackerJid,
  matchesTrackedTargetJid,
  computeRttTelemetryStats,
  classifyDeviceActivityState,
  renderRttSparkline,
} from '../../src/whatsapp/device-activity-tracker';
import {
  HiroosyBaileysSessionDriver,
  MockWhatsAppSessionDriver,
} from '../../src/whatsapp/connection-manager';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { OperationRateLimiter } from '../../src/security/validation';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { TelegramBotController } from '../../src/bot/bot';
import { AppConfig } from '../../src/config/env';

test('1. JID Normalization (parseTrackerJid & matchesTrackedTargetJid): strips :device suffix and attributes :0, :14@s.whatsapp.net, and :2@lid accurately', () => {
  const pnCompanion = parseTrackerJid('967739724794:14@s.whatsapp.net');
  assert.equal(pnCompanion.bareJid, '967739724794@s.whatsapp.net');
  assert.equal(pnCompanion.user, '967739724794');
  assert.equal(pnCompanion.server, 's.whatsapp.net');
  assert.equal(pnCompanion.deviceId, 14);
  assert.equal(
    pnCompanion.formattedDeviceJid,
    '967739724794:14@s.whatsapp.net'
  );
  assert.equal(pnCompanion.isPn, true);
  assert.equal(pnCompanion.isLid, false);

  const lidCompanion = parseTrackerJid('144109809438738:2@lid');
  assert.equal(lidCompanion.bareJid, '144109809438738@lid');
  assert.equal(lidCompanion.user, '144109809438738');
  assert.equal(lidCompanion.server, 'lid');
  assert.equal(lidCompanion.deviceId, 2);
  assert.equal(lidCompanion.formattedDeviceJid, '144109809438738:2@lid');
  assert.equal(lidCompanion.isLid, true);
  assert.equal(lidCompanion.isPn, false);

  const match1 = matchesTrackedTargetJid(
    '967739724794:14@s.whatsapp.net',
    '967739724794@s.whatsapp.net',
    '144109809438738@lid'
  );
  assert.equal(match1.matches, true);
  assert.equal(match1.parsed.deviceId, 14);

  const match2 = matchesTrackedTargetJid(
    '144109809438738:2@lid',
    '967739724794@s.whatsapp.net',
    '144109809438738@lid'
  );
  assert.equal(match2.matches, true);
  assert.equal(match2.parsed.deviceId, 2);

  const nonMatch = matchesTrackedTargetJid(
    '966500000000:1@s.whatsapp.net',
    '967739724794@s.whatsapp.net',
    '144109809438738@lid'
  );
  assert.equal(nonMatch.matches, false);
});

test('2. Adaptive RTT Classification Engine: rolling median, dynamic threshold [350ms..1200ms], ACTIVE / STANDBY / OFFLINE states, and ASCII sparkline', () => {
  // Bootstrap (<3 samples): threshold = 800ms
  const bootStats = computeRttTelemetryStats([180, 220]);
  assert.equal(bootStats.lastRttMs, 220);
  assert.equal(bootStats.movingAvgRttMs, 200);
  assert.equal(bootStats.medianRttMs, 200);
  assert.equal(bootStats.dynamicThresholdMs, 800);

  // Fast active device samples -> median * 0.9 clamped to minimum 350ms
  const fastSamples = [120, 140, 130, 150, 110];
  const fastStats = computeRttTelemetryStats(fastSamples);
  assert.equal(fastStats.medianRttMs, 130);
  assert.equal(fastStats.dynamicThresholdMs, 350);
  assert.equal(
    classifyDeviceActivityState({
      presenceState: 'unavailable',
      movingAvgRttMs: fastStats.movingAvgRttMs,
      dynamicThresholdMs: fastStats.dynamicThresholdMs,
      consecutiveTimeouts: 0,
      probesAcked: 5,
    }),
    'ACTIVE'
  );

  // Standby / Doze mode samples (e.g. baseline 600ms, then recent 5 samples rise to ~900ms > 540ms threshold)
  const standbySamples = [580, 600, 610, 590, 600, 920, 950, 910, 940, 930];
  const standbyStats = computeRttTelemetryStats(standbySamples);
  // Sorted: 580, 590, 600, 600, 610, 910, 920, 930, 940, 950 -> median = (610+910)/2 = 760 -> threshold = 760*0.9 = 684ms
  assert.equal(standbyStats.medianRttMs, 760);
  assert.equal(standbyStats.dynamicThresholdMs, 684);
  assert.ok(standbyStats.movingAvgRttMs! > standbyStats.dynamicThresholdMs);
  assert.equal(
    classifyDeviceActivityState({
      presenceState: 'unavailable',
      movingAvgRttMs: standbyStats.movingAvgRttMs,
      dynamicThresholdMs: standbyStats.dynamicThresholdMs,
      consecutiveTimeouts: 0,
      probesAcked: 10,
    }),
    'STANDBY'
  );

  // Offline: consecutive timeouts >= 2
  assert.equal(
    classifyDeviceActivityState({
      presenceState: 'unavailable',
      movingAvgRttMs: fastStats.movingAvgRttMs,
      dynamicThresholdMs: fastStats.dynamicThresholdMs,
      consecutiveTimeouts: 2,
      probesAcked: 5,
    }),
    'OFFLINE'
  );

  // Native composing/recording overrides to ACTIVE
  assert.equal(
    classifyDeviceActivityState({
      presenceState: 'composing',
      movingAvgRttMs: standbyStats.movingAvgRttMs,
      dynamicThresholdMs: standbyStats.dynamicThresholdMs,
      consecutiveTimeouts: 0,
      probesAcked: 10,
    }),
    'ACTIVE'
  );

  const sparkline = renderRttSparkline([40, 80, 150, 320, 600, 950]);
  assert.equal([...sparkline].length, 6);
  assert.ok(sparkline.includes('▁'));
  assert.ok(sparkline.includes('█'));
});

test('3. Silent Delivery-Receipt RTT Probing & Triple-Layer Receipt Capture (messages.update, message-receipt.update, and CB:receipt)', async () => {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const sentReactions: Array<{ jid: string; content: any; probeMsgId: string }> =
    [];
  let probeCounter = 0;

  const fakeSock: any = {
    ev,
    ws,
    user: {
      id: '967700000001:1@s.whatsapp.net',
      lid: '1000000000001:1@lid',
      name: 'Botezz Tracker Node',
    },
    executeUSyncQuery: async () => ({
      list: [
        {
          id: '967739724794@s.whatsapp.net',
          contact: true,
          lid: '144109809438738@lid',
          devices: {
            deviceList: [{ id: 0 }, { id: 14 }],
          },
        },
      ],
    }),
    sendPresenceUpdate: async () => undefined,
    presenceSubscribe: async () => undefined,
    sendMessage: async (jid: string, content: any) => {
      probeCounter++;
      const probeMsgId = `3EB0PROBESENT000${probeCounter}`;
      sentReactions.push({ jid, content, probeMsgId });

      // Simulate Layer 1, Layer 2, and Layer 3 ACKs on consecutive probes
      const fakeTargetId = content?.react?.key?.id;
      if (probeCounter === 1) {
        // Layer 1: messages.update with status=3 (DELIVERY_ACK) from primary phone :0
        setTimeout(() => {
          ev.emit('messages.update', [
            {
              key: {
                id: probeMsgId,
                remoteJid: '967739724794@s.whatsapp.net',
                participant: '967739724794:0@s.whatsapp.net',
              },
              update: { status: 3 },
            },
          ]);
        }, 15);
      } else if (probeCounter === 2) {
        // Layer 2: message-receipt.update from companion web device :14
        setTimeout(() => {
          ev.emit('message-receipt.update', [
            {
              key: {
                id: probeMsgId,
                remoteJid: '967739724794@s.whatsapp.net',
              },
              receipt: {
                userJid: '967739724794:14@s.whatsapp.net',
                receiptTimestamp: Math.floor(Date.now() / 1000),
              },
            },
          ]);
        }, 20);
      } else if (probeCounter >= 3) {
        // Layer 3: Raw BinaryNode CB:receipt matching fakeTargetId on @lid companion :2
        setTimeout(() => {
          ws.emit('CB:receipt', {
            tag: 'receipt',
            attrs: {
              id: fakeTargetId,
              from: '144109809438738:2@lid',
            },
            content: [],
          });
        }, 25);
      }

      return {
        key: {
          remoteJid: jid,
          fromMe: true,
          id: probeMsgId,
        },
      };
    },
  };

  const registry = new ActivePresenceTrackerRegistry();
  const liveSnapshots: number[] = [];

  const tracker = new DeviceActivityTracker({
    sessionId: 'sess_rtt_test',
    adminId: 777888999,
    sock: fakeSock,
    recipient: '+967 739 724 794',
    durationSeconds: 1,
    probeIntervalMs: 320,
    probeTimeoutMs: 1500,
    registry,
    onUpdate: (snap) => {
      liveSnapshots.push(snap.probesAcked);
    },
  });

  const finalReport = await tracker.run();

  // Verify silent non-existent reaction probes were dispatched
  assert.ok(
    sentReactions.length >= 3,
    `Expected at least 3 silent reaction probes, got ${sentReactions.length}`
  );
  for (const call of sentReactions) {
    assert.equal(call.jid, '967739724794@s.whatsapp.net');
    assert.equal(call.content.react.text, '');
    assert.equal(call.content.react.key.fromMe, true);
    assert.ok(
      String(call.content.react.key.id).startsWith('3EB0'),
      'Reaction target key must be a random 3EB0* message ID'
    );
  }

  // Verify all 3 capture layers recorded RTT samples and device JIDs
  assert.ok(finalReport.probesAcked >= 3);
  assert.equal(finalReport.probesTimedOut, 0);
  assert.equal(finalReport.deviceActivityState, 'ACTIVE');
  assert.equal(finalReport.resolvedLid, '144109809438738@lid');
  assert.ok(
    finalReport.detectedDevices.includes('967739724794:0@s.whatsapp.net')
  );
  assert.ok(
    finalReport.detectedDevices.includes('967739724794:14@s.whatsapp.net')
  );
  assert.ok(finalReport.detectedDevices.includes('144109809438738:2@lid'));

  const layersCaptured = new Set(
    finalReport.rttSamples.map((s) => s.captureLayer)
  );
  assert.ok(layersCaptured.has('messages.update'));
  assert.ok(layersCaptured.has('message-receipt.update'));
  assert.ok(
    layersCaptured.has('ws.CB:receipt') || layersCaptured.has('CB:receipt')
  );
});

test('4. Early Cancellation (stopEarly) via ActivePresenceTrackerRegistry and Telegram Callback presence:stop:<watchId> with Forensic JSON Attachment', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz-dat-bot-'));
  const authBaseDir = path.join(tmpDir, 'auth');
  const tempMediaDir = path.join(tmpDir, 'media');
  fs.mkdirSync(authBaseDir, { recursive: true });
  fs.mkdirSync(tempMediaDir, { recursive: true });

  const adminId = 888111222;
  const config: AppConfig = {
    NODE_ENV: 'test',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_test_token_for_dat_suite',
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

  const createdSession = sessionManager.createSession('جلسة رادار RTT', adminId);
  await sessionManager.initiatePairing({
    sessionId: createdSession.id,
    rawPhoneNumber: '+966501112222',
    actorTelegramId: adminId,
  });

  // 1. Verify /presence track renders the RTT Side-Channel Telemetry, ASCII Sparkline, and attaches forensic JSON export
  const trackView = await controller.handleTextMessage(
    adminId,
    '/presence track +967739724794 2'
  );
  assert.ok(trackView.text.includes('تقرير رصد التواجد الحي'));
  assert.ok(trackView.text.includes('RTT Side-Channel Telemetry'));
  assert.ok(trackView.text.includes('Live ASCII Sparkline'));
  assert.ok(trackView.text.includes('سجل التحولات الزمنية'));
  assert.ok(
    Array.isArray(trackView.mediaAttachments) &&
      trackView.mediaAttachments.length === 1,
    'Final presence view must attach downloadable forensic JSON report'
  );
  const attachment = trackView.mediaAttachments![0];
  assert.ok(attachment.fileName.startsWith('device_activity_967739724794_'));
  assert.ok(attachment.fileName.endsWith('.json'));
  const parsedExport = JSON.parse(attachment.buffer!.toString('utf8'));
  assert.equal(parsedExport.chatJid, '967739724794@s.whatsapp.net');
  assert.equal(parsedExport.finalDeviceActivityState, 'ACTIVE');
  assert.ok(Array.isArray(parsedExport.rttSamples));
  assert.ok(parsedExport.rttSamples.length >= 1);

  // 2. Start a long-running DeviceActivityTracker registered in global ActivePresenceTrackerRegistry and stop it early via `presence:stop:<watchId>`
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const fakeSock: any = {
    ev,
    ws,
    executeUSyncQuery: async () => ({
      list: [
        {
          id: '967739724794@s.whatsapp.net',
          contact: true,
          lid: '144109809438738@lid',
          devices: { deviceList: [{ id: 0 }] },
        },
      ],
    }),
    sendPresenceUpdate: async () => undefined,
    presenceSubscribe: async () => undefined,
    sendMessage: async (jid: string) => ({
      key: { remoteJid: jid, fromMe: true, id: '3EB0LONGPROBE01' },
    }),
  };

  const globalRegistry = getActivePresenceTrackerRegistry();
  const longTracker = new DeviceActivityTracker({
    sessionId: createdSession.id,
    adminId,
    sock: fakeSock,
    recipient: '+967739724794',
    durationSeconds: 60,
    probeIntervalMs: 2000,
    registry: globalRegistry,
  });

  const runPromise = longTracker.run();
  await new Promise((r) => setTimeout(r, 60));

  const stopCallbackData = `presence:stop:${longTracker.watchId}`;
  assert.ok(
    Buffer.byteLength(stopCallbackData, 'utf8') <= 64,
    'Telegram callback_data must be <= 64 bytes'
  );

  const stopView = await controller.handleCallbackQuery(
    adminId,
    stopCallbackData
  );
  const stoppedReport = await runPromise;

  assert.equal(stoppedReport.stoppedEarly, true);
  assert.ok(stopView.text.includes('تقرير رصد التواجد الحي'));
  assert.ok(stopView.text.includes('إيقاف مبكر يدوياً'));
  assert.ok(
    Array.isArray(stopView.mediaAttachments) &&
      stopView.mediaAttachments.length === 1
  );

  await sessionManager.shutdownAll();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
