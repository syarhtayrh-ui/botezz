import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ForensicPayloadAnalyzer,
  SafeLosslessSerializer,
  detectSenderOsFingerprint,
  classifyForensicSurface,
  sanitizeIncomingMessageForDownstream,
} from '../../src/security/forensic-payload-analyzer';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SettingsRepository } from '../../src/database/repositories/settings-repository';
import { TaskRepository } from '../../src/database/repositories/task-repository';
import { SessionStore } from '../../src/whatsapp/session-store';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { MockWhatsAppSessionDriver } from '../../src/whatsapp/connection-manager';
import { TaskManager } from '../../src/tasks/task-manager';
import { TaskRunner } from '../../src/tasks/task-runner';
import { OperationRateLimiter } from '../../src/security/validation';
import { AppConfig } from '../../src/config/env';
import { SendMessageOperation } from '../../src/whatsapp/operations/send-message';
import { SendMediaOperation } from '../../src/whatsapp/operations/send-media';
import { GroupOperations } from '../../src/whatsapp/operations/group-operations';
import { TelegramBotController } from '../../src/bot/bot';
import { buildMainMenuKeyboard } from '../../src/bot/keyboards/main-menu';
import { AuthorizationError } from '../../src/utils/errors';

test('1. Stage 1 Raw Pre-Process file (01_raw_pre_process.json) is saved intact even when Stage 2 encounters a simulated corrupted/unparseable payload', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'botezz-forensic-stage1-')
  );
  try {
    const uploadedBundles: Array<{
      captureId: string;
      summary: string;
      fileNames: string[];
    }> = [];

    const analyzer = new ForensicPayloadAnalyzer({
      tempUploadDir: tmpDir,
      botTokenToRedact: '123456789:SECRET_BOT_TOKEN_ABC',
      initialConfig: {
        enabled: true,
        autoUploadToTelegram: true,
        surfaceFilter: 'ALL',
      },
    });

    analyzer.onForensicCaptureReady = (record, summary, attachments) => {
      uploadedBundles.push({
        captureId: record.captureId,
        summary,
        fileNames: attachments.map((a) => a.fileName),
      });
    };

    const rawBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x42]);
    const hostileMessage: Record<string, unknown> = {
      key: {
        remoteJid: '966501234567@s.whatsapp.net',
        fromMe: false,
        id: '3A0123456789ABCDEF01',
      },
      message: {
        conversation: 'Payload before Stage 2 crash',
      },
      __simulateCorruptedDissectionThrow: () => {
        throw new Error('Simulated Protobuf wire type 7 corrupted frame exception');
      },
    };

    const record = await analyzer.captureIncomingPayload({
      sessionId: 'sess_stage1_test',
      rawEventType: 'messages.upsert',
      rawWaMessage: hostileMessage,
      rawBytes,
    });

    assert.ok(record, 'Capture record must be returned even when Stage 2 throws');
    assert.ok(
      record.processingError?.includes(
        'Simulated Protobuf wire type 7 corrupted frame exception'
      )
    );
    assert.equal(record.threatVerdict.isAnomalous, true);
    assert.ok(
      record.threatVerdict.anomalies.some(
        (a) => a.code === 'STAGE2_DISSECTION_FAILURE'
      )
    );

    // Verify Stage 1 files exist on disk and are intact
    assert.ok(fs.existsSync(record.files.rawPreProcessJsonPath));
    assert.ok(
      record.files.rawPayloadBinPath &&
        fs.existsSync(record.files.rawPayloadBinPath)
    );
    const savedRawBin = fs.readFileSync(record.files.rawPayloadBinPath!);
    assert.deepEqual(savedRawBin, rawBytes);

    const parsedStage1 = JSON.parse(
      fs.readFileSync(record.files.rawPreProcessJsonPath, 'utf8')
    );
    assert.equal(parsedStage1.captureStage, 'PRE_PROCESS_RAW');
    assert.equal(
      parsedStage1.rawWaMessage.message.conversation,
      'Payload before Stage 2 crash'
    );

    // Verify automatic upload callback still fired with Stage 1 & Stage 2 documents
    assert.equal(uploadedBundles.length, 1);
    assert.ok(
      uploadedBundles[0].fileNames.some((n) =>
        n.endsWith('_01_raw_pre_process.json')
      )
    );
    assert.ok(
      uploadedBundles[0].fileNames.some((n) =>
        n.endsWith('_02_post_process_forensics.json')
      )
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. Malformed Unicode strings (BiDi overrides, null bytes, lone surrogates) and corrupted/encrypted media buffers are preserved byte-for-byte', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'botezz-forensic-unicode-media-')
  );
  try {
    const analyzer = new ForensicPayloadAnalyzer({
      tempUploadDir: tmpDir,
      botTokenToRedact: '999888777:MY_SUPER_SECRET_BOT_TOKEN',
      initialConfig: {
        enabled: true,
        autoUploadToTelegram: true,
        captureMediaBuffers: true,
      },
    });

    // Build a string with BiDi overrides (\u202E, \u2066), null bytes (\x00), and a lone high surrogate (\uD800)
    const malformedString =
      'CRASH_START\u0000' +
      '\u202E'.repeat(12) +
      '\u2066\u200B' +
      '\uD800' +
      'END_MARKER';

    // Corrupted JPEG buffer (wrong magic header: 0x00 0x11 0x22 instead of FF D8 FF)
    const corruptedJpegBytes = Buffer.from([
      0x00, 0x11, 0x22, 0x33, 0xff, 0xd9, 0xaa, 0xbb, 0xcc, 0xdd,
    ]);

    const rawMsg: Record<string, unknown> = {
      key: {
        remoteJid: '966509998888@s.whatsapp.net',
        fromMe: false,
        id: '3EB0ABCDEF1234567890',
      },
      noiseKey: {
        private: Buffer.from('LOCAL_NOISE_PRIVATE_KEY_DO_NOT_LEAK'),
        public: Buffer.from('LOCAL_NOISE_PUBLIC_KEY'),
      },
      TELEGRAM_BOT_TOKEN: '999888777:MY_SUPER_SECRET_BOT_TOKEN',
      message: {
        viewOnceMessageV2: {
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              caption: malformedString,
              width: -50, // Invalid negative dimension
              height: Number.POSITIVE_INFINITY, // Invalid infinite dimension
              mediaKey: Buffer.alloc(32, 0x5a),
              fileSha256: Buffer.alloc(32, 0x11),
              fileEncSha256: Buffer.alloc(32, 0x22),
              __rawMediaBuffer: corruptedJpegBytes,
            },
          },
        },
      },
    };

    const record = await analyzer.captureIncomingPayload({
      sessionId: 'sess_unicode_media',
      rawEventType: 'messages.upsert',
      rawWaMessage: rawMsg,
    });

    assert.ok(record);
    assert.equal(record.senderOs, 'WhatsApp Web / Baileys');
    assert.deepEqual(record.wrapperChain, ['viewOnceMessageV2']);
    assert.equal(record.payloadType, 'imageMessage');

    // Verify anomaly flags
    const anomalyCodes = record.threatVerdict.anomalies.map((a) => a.code);
    assert.ok(anomalyCodes.includes('UNICODE_CRASH_VECTOR'));
    assert.ok(anomalyCodes.includes('INVALID_COORDINATES_OR_DIMENSIONS'));
    assert.ok(anomalyCodes.includes('CORRUPTED_MEDIA_HEADER'));

    // Verify Unicode map counts
    assert.ok(record.unicodeMap);
    assert.equal(record.unicodeMap.bidiOverrideCount, 13);
    assert.equal(record.unicodeMap.nullByteCount, 1);
    assert.equal(record.unicodeMap.loneSurrogateCount, 1);
    assert.ok(
      record.unicodeMap.codepointsHex.some((c) => c.includes('LONE_SURROGATE'))
    );

    // Verify malformed string with lone surrogate & null byte is preserved verbatim in Stage 1 JSON
    const stage1Parsed = JSON.parse(
      fs.readFileSync(record.files.rawPreProcessJsonPath, 'utf8')
    );
    const recoveredCaption =
      stage1Parsed.rawWaMessage.message.viewOnceMessageV2.message.imageMessage
        .caption;
    assert.equal(
      recoveredCaption,
      malformedString,
      'Malformed string with lone surrogate, null byte, and BiDi overrides must be preserved code-unit-for-code-unit'
    );

    // Verify local secrets were redacted while payload mediaKey was preserved 100%
    assert.equal(
      stage1Parsed.rawWaMessage.TELEGRAM_BOT_TOKEN,
      '[REDACTED_LOCAL_SECRET]'
    );
    assert.equal(
      stage1Parsed.rawWaMessage.noiseKey.private,
      '[REDACTED_LOCAL_PRIVATE_KEY]'
    );
    assert.equal(
      stage1Parsed.rawWaMessage.message.viewOnceMessageV2.message.imageMessage
        .mediaKey.__type,
      'BinaryBuffer'
    );
    assert.equal(
      stage1Parsed.rawWaMessage.message.viewOnceMessageV2.message.imageMessage
        .mediaKey.byteLength,
      32
    );

    // Verify 03_raw_text_utf8.txt and 04_media_payload_original.jpg are preserved byte-for-byte
    assert.ok(
      record.files.rawTextUtf8Path &&
        fs.existsSync(record.files.rawTextUtf8Path)
    );
    assert.deepEqual(
      fs.readFileSync(record.files.rawTextUtf8Path!),
      Buffer.from(malformedString, 'utf8')
    );

    assert.ok(
      record.files.mediaArtifactPath &&
        fs.existsSync(record.files.mediaArtifactPath)
    );
    assert.deepEqual(
      fs.readFileSync(record.files.mediaArtifactPath!),
      corruptedJpegBytes,
      'Corrupted media buffer must be written byte-for-byte without header repair or re-encoding'
    );

    // Verify encrypted media fallback when downloadMediaMessage fails
    const rawCiphertext = Buffer.from('ENCRYPTED_MEDIA_CIPHERTEXT_BYTES_RAW_0123456789');
    const undecryptableMsg: Record<string, unknown> = {
      key: {
        remoteJid: '966509998888@s.whatsapp.net',
        fromMe: false,
        id: '0123456789ABCDEF0123456789ABCDEF',
      },
      message: {
        videoMessage: {
          mimetype: 'video/mp4',
          directPath: '/v/t62.7161-24/corrupted_enc.enc',
          mediaKey: Buffer.alloc(32, 0xaa),
        },
      },
    };

    const encRecord = await analyzer.captureIncomingPayload({
      sessionId: 'sess_unicode_media',
      rawEventType: 'messages.upsert',
      rawWaMessage: undecryptableMsg,
      customMediaDownloader: async () => {
        throw new Error('bad decrypt: corrupted AES-CBC PKCS7 padding');
      },
      customRawMediaFetcher: async (url) => {
        assert.equal(
          url,
          'https://mmg.whatsapp.net/v/t62.7161-24/corrupted_enc.enc'
        );
        return rawCiphertext;
      },
    });

    assert.ok(encRecord);
    assert.equal(encRecord.mediaInfo.decryptionSucceeded, false);
    assert.equal(encRecord.mediaInfo.encryptedFallbackUsed, true);
    assert.equal(
      encRecord.files.mediaArtifactFileName,
      '04_raw_encrypted_media.enc'
    );
    assert.deepEqual(
      fs.readFileSync(encRecord.files.mediaArtifactPath!),
      rawCiphertext
    );

    // Verify all attachments use kind: 'document' so Telegram never re-compresses or rejects corrupted headers
    const attachments = analyzer.buildCaptureDocumentAttachments(record);
    assert.equal(attachments.length, 4);
    for (const att of attachments) {
      assert.equal(att.kind, 'document');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. Classifies all WhatsApp surfaces (@s.whatsapp.net, @lid, @g.us, status@broadcast, @newsletter, protocol stanzas) and fingerprints OS + anomalies accurately', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'botezz-forensic-surfaces-')
  );
  try {
    const analyzer = new ForensicPayloadAnalyzer({
      tempUploadDir: tmpDir,
      initialConfig: {
        enabled: true,
        autoUploadToTelegram: false,
        captureRawBinaryStanzas: true,
      },
    });

    // OS fingerprint unit checks
    assert.equal(detectSenderOsFingerprint('3A998877665544332211'), 'iOS');
    assert.equal(
      detectSenderOsFingerprint('3EB01122334455667788'),
      'WhatsApp Web / Baileys'
    );
    assert.equal(
      detectSenderOsFingerprint('BAE5112233445566'),
      'WhatsApp Web / Baileys'
    );
    assert.equal(
      detectSenderOsFingerprint('0123456789ABCDEF0123456789ABCDEF'),
      'Android'
    );
    assert.equal(
      detectSenderOsFingerprint('3F1122334455667788'),
      'Desktop / Companion'
    );

    // Surface classification checks
    assert.equal(
      classifyForensicSurface('966501234567@s.whatsapp.net', 'messages.upsert'),
      'PRIVATE_CHAT'
    );
    assert.equal(
      classifyForensicSurface('36597986795687@lid', 'messages.upsert'),
      'PRIVATE_CHAT'
    );
    assert.equal(
      classifyForensicSurface('120363041001@g.us', 'messages.upsert'),
      'GROUP'
    );
    assert.equal(
      classifyForensicSurface('status@broadcast', 'messages.upsert'),
      'STATUS_STORY'
    );
    assert.equal(
      classifyForensicSurface('120363199999@newsletter', 'messages.upsert'),
      'NEWSLETTER'
    );
    assert.equal(
      classifyForensicSurface('', 'ws.CB:call'),
      'PROTOCOL_STANZA'
    );

    // Capture across all 5 surfaces + test Mention Array Bomb, Deep Wrapper Nesting, and Spoofed Quoted Context
    const lidRecord = await analyzer.captureIncomingPayload({
      sessionId: 'sess_surf',
      rawEventType: 'messages.upsert',
      rawWaMessage: {
        key: {
          remoteJid: '36597986795687@lid',
          remoteJidAlt: '966501234567@s.whatsapp.net',
          id: '3A001122334455667788',
        },
        message: {
          extendedTextMessage: {
            text: 'LID routed message with mention bomb and spoofed quote',
            contextInfo: {
              mentionedJid: Array.from(
                { length: 120 },
                (_, idx) => `96650000${String(idx).padStart(4, '0')}@s.whatsapp.net`
              ),
              stanzaId: 'FAKE_NONEXISTENT_BOT_MSG_ID',
              participant: '966509999999@s.whatsapp.net',
              quotedMessage: { conversation: 'Fake message from bot' },
            },
          },
        },
      },
      botSelfJids: ['966509999999@s.whatsapp.net'],
      botKnownMessageIds: new Set(['REAL_MSG_1']),
    });

    assert.ok(lidRecord);
    assert.equal(lidRecord.surface, 'PRIVATE_CHAT');
    assert.equal(lidRecord.senderOs, 'iOS');
    assert.equal(lidRecord.senderLidJid, '36597986795687@lid');
    assert.equal(lidRecord.senderPnJid, '966501234567@s.whatsapp.net');
    assert.equal(lidRecord.addressingMode, 'lid');
    const lidAnomalies = lidRecord.threatVerdict.anomalies.map((a) => a.code);
    assert.ok(lidAnomalies.includes('MENTION_ARRAY_BOMB'));
    assert.ok(lidAnomalies.includes('SPOOFED_QUOTED_CONTEXT'));

    // Deep wrapper nesting (> 5 levels) on GROUP surface
    const deepNestedMsg = {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: {
              viewOnceMessageV2: {
                message: {
                  viewOnceMessageV2Extension: {
                    message: {
                      documentWithCaptionMessage: {
                        message: {
                          editedMessage: {
                            message: {
                              conversation: '6-level wrapped group payload',
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const groupRecord = await analyzer.captureIncomingPayload({
      sessionId: 'sess_surf',
      rawEventType: 'messages.upsert',
      rawWaMessage: {
        key: {
          remoteJid: '120363041001@g.us',
          participant: '966551112222@s.whatsapp.net',
          id: '0123456789ABCDEF0123456789ABCDEF',
        },
        message: deepNestedMsg,
      },
    });
    assert.ok(groupRecord);
    assert.equal(groupRecord.surface, 'GROUP');
    assert.equal(groupRecord.senderOs, 'Android');
    assert.equal(groupRecord.wrapperChain.length, 6);
    assert.ok(
      groupRecord.threatVerdict.anomalies.some(
        (a) => a.code === 'DEEP_WRAPPER_NESTING'
      )
    );

    // Status Story & Newsletter & Raw Call Stanza
    const statusRecord = await analyzer.captureIncomingPayload({
      sessionId: 'sess_surf',
      rawEventType: 'messages.upsert',
      rawWaMessage: {
        key: {
          remoteJid: 'status@broadcast',
          participant: '966553334444@s.whatsapp.net',
          id: '3EB09988776655443322',
        },
        message: { conversation: 'Status story text' },
      },
    });
    assert.equal(statusRecord?.surface, 'STATUS_STORY');

    const newsletterRecord = await analyzer.captureIncomingPayload({
      sessionId: 'sess_surf',
      rawEventType: 'messages.upsert',
      rawWaMessage: {
        key: {
          remoteJid: '120363199999@newsletter',
          id: '3F0011223344556677',
        },
        message: { conversation: 'Channel broadcast post' },
      },
    });
    assert.equal(newsletterRecord?.surface, 'NEWSLETTER');

    const callStanzaRecord = await analyzer.captureIncomingPayload({
      sessionId: 'sess_surf',
      rawEventType: 'ws.CB:call',
      rawBinaryNode: {
        tag: 'call',
        attrs: { from: '966501234567@s.whatsapp.net', id: 'CALL_STANZA_01' },
        content: Buffer.from([0x01, 0x02, 0x03, 0x04]),
      },
    });
    assert.equal(callStanzaRecord?.surface, 'PROTOCOL_STANZA');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('4. End-to-End Telegram UI (menu:sec_analyzer, /secanalyzer, /secupload, filters, Owner-Only security) & Priority-0 Sanitizer Guard', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'botezz-forensic-e2e-')
  );
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const sessionsDir = path.join(tmpDir, 'sessions');
  const uploadsDir = path.join(tmpDir, 'uploads');

  const db = new AppDatabase(dbPath);

  try {
    const ownerId = 777000111;
    const nonOwnerPremiumId = 888000222;

    const sessionRepo = new SessionRepository(db);
    const auditRepo = new AuditRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const taskRepo = new TaskRepository(db);
    const sessionStore = new SessionStore(sessionsDir);

    settingsRepo.addPremiumSubscription(String(nonOwnerPremiumId), 30, 'USER');

    const drivers = new Map<string, MockWhatsAppSessionDriver>();
    const sessionManager = new SessionManager(
      sessionRepo,
      auditRepo,
      sessionStore,
      (sessionId) => {
        const d = new MockWhatsAppSessionDriver(sessionId);
        drivers.set(sessionId, d);
        return d;
      },
      { configuredAdminId: ownerId }
    );

    const config: AppConfig = {
      NODE_ENV: 'test',
      TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN_SECRET',
      TELEGRAM_ADMIN_ID: ownerId,
      DATABASE_PATH: dbPath,
      WHATSAPP_AUTH_DIR: sessionsDir,
      TEMP_UPLOAD_DIR: uploadsDir,
      LOG_LEVEL: 'silent',
      MAX_CONCURRENT_TASKS: 2,
      TASK_TIMEOUT_MS: 15_000,
      MAX_UPLOAD_SIZE_MB: 25,
    };

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
      duplicateTapWindowMs: 0,
    });

    // 1. Verify Main Menu includes menu:sec_analyzer for Admin only
    const adminMenu = buildMainMenuKeyboard({ isAdmin: true }).flat();
    const userMenu = buildMainMenuKeyboard({ isAdmin: false }).flat();
    assert.ok(adminMenu.some((b) => b.callbackData === 'menu:sec_analyzer'));
    assert.ok(!userMenu.some((b) => b.callbackData === 'menu:sec_analyzer'));

    // 2. Verify non-owner Premium user is blocked from menu:sec_analyzer and /secanalyzer
    await assert.rejects(
      async () => {
        await controller.handleCallbackQuery(
          nonOwnerPremiumId,
          'menu:sec_analyzer'
        );
      },
      (err: unknown) => err instanceof AuthorizationError
    );

    // 3. Owner opens Security Analyzer panel & enables it
    const dash1 = await controller.handleCallbackQuery(
      ownerId,
      'menu:sec_analyzer'
    );
    assert.ok(dash1.text.includes('قسم المحلل الأمني والجنائي للحمولات الواردة'));

    const toggledOn = await controller.handleCallbackQuery(
      ownerId,
      'sec:toggle'
    );
    assert.ok(toggledOn.text.includes('مفعّل'));
    assert.equal(settingsRepo.getSecurityAnalyzerConfig().enabled, true);

    // 4. Create & connect a mock session, then simulate an incoming Virtex + Mention-Bomb crash message
    const pairing = await sessionManager.initiatePairing({
      rawPhoneNumber: '+966501234567',
      actorTelegramId: ownerId,
    });
    const mockDriver = drivers.get(pairing.session.id)!;

    const hostileBidiBomb = 'VIRTEX_' + '\u202E'.repeat(150) + '_PAYLOAD';
    const mentionBombList = Array.from(
      { length: 600 },
      (_, i) => `96650000${String(i).padStart(4, '0')}@s.whatsapp.net`
    );

    let downstreamReceivedMessage: Record<string, unknown> | undefined;
    sessionManager.addIncomingMessageListener(({ rawMessage }) => {
      downstreamReceivedMessage = rawMessage;
    });

    mockDriver.simulateIncomingMessage({
      key: {
        remoteJid: '966507778888@s.whatsapp.net',
        fromMe: false,
        id: '3A112233445566778899',
      },
      message: {
        extendedTextMessage: {
          text: hostileBidiBomb,
          contextInfo: {
            mentionedJid: mentionBombList,
          },
        },
      },
    });

    // Wait briefly for async capture pipeline
    await new Promise((r) => setTimeout(r, 60));

    // Verify downstream received sanitized payload (BiDi stripped and mentions truncated to 50)
    assert.ok(downstreamReceivedMessage);
    assert.equal(downstreamReceivedMessage.__sanitizedByForensicGuard, true);
    const downstreamExt = (
      downstreamReceivedMessage.message as {
        extendedTextMessage: {
          text: string;
          contextInfo: { mentionedJid: string[] };
        };
      }
    ).extendedTextMessage;
    assert.ok(!downstreamExt.text.includes('\u202E'));
    assert.equal(downstreamExt.contextInfo.mentionedJid.length, 50);

    // Verify Forensic Analyzer archived the 100% UNMODIFIED original payload!
    const captures = controller.forensicAnalyzer.listCaptures();
    assert.equal(captures.totalItems, 1);
    const cap = captures.items[0];
    assert.equal(cap.unicodeMap?.bidiOverrideCount, 150);
    const stage1Raw = JSON.parse(
      fs.readFileSync(cap.files.rawPreProcessJsonPath, 'utf8')
    );
    assert.equal(
      stage1Raw.rawWaMessage.message.extendedTextMessage.text,
      hostileBidiBomb
    );
    assert.equal(
      stage1Raw.rawWaMessage.message.extendedTextMessage.contextInfo.mentionedJid
        .length,
      600
    );

    // 5. Test on-demand upload via `sec:download:<shortId>` and `/secupload <captureId>`
    const dlView = await controller.handleCallbackQuery(
      ownerId,
      `sec:download:${cap.shortId}`
    );
    assert.ok(dlView.mediaAttachments && dlView.mediaAttachments.length >= 3);

    const cmdUploadView = await controller.handleTextMessage(
      ownerId,
      `/secupload ${cap.captureId}`
    );
    assert.ok(
      cmdUploadView.mediaAttachments &&
        cmdUploadView.mediaAttachments.length >= 3
    );

    // 6. Test filter and clear archive
    const filterView = await controller.handleCallbackQuery(
      ownerId,
      'sec:filter:ANOMALIES_ONLY'
    );
    assert.ok(filterView.text.includes('الحمولات المشبوهة والمشوهة فقط'));

    const clearedView = await controller.handleCallbackQuery(
      ownerId,
      'sec:clear'
    );
    assert.ok(clearedView.text.includes('تم مسح أرشيف الفحص المؤقت'));
    assert.equal(controller.forensicAnalyzer.listCaptures().totalItems, 0);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('5. Direct sanitizeIncomingMessageForDownstream unit verification', () => {
  const cleanMsg = {
    key: { id: '1', remoteJid: '966501234567@s.whatsapp.net' },
    message: { conversation: 'Hello normal world' },
  };
  const resClean = sanitizeIncomingMessageForDownstream(cleanMsg);
  assert.equal(resClean.wasSanitized, false);

  const biDiMsg = {
    key: { id: '2', remoteJid: '966501234567@s.whatsapp.net' },
    message: { conversation: 'A' + '\u202E'.repeat(120) + 'B' },
  };
  const resBiDi = sanitizeIncomingMessageForDownstream(biDiMsg);
  assert.equal(resBiDi.wasSanitized, true);
  assert.equal(
    (resBiDi.sanitizedMessage.message as { conversation: string }).conversation,
    'AB'
  );
  // Original object's nested conversation was not mutated by sanitizeIncomingMessageForDownstream itself
  assert.equal(biDiMsg.message.conversation.length, 122);
});
