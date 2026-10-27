import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateEnv } from '../../src/config/env';
import {
  maskPhoneNumber,
  redactText,
  redactObject,
} from '../../src/security/redaction';
import {
  normalizePhoneNumber,
  convertArabicIndicDigits,
  validateCustomPairingCode,
  generateRandomPairingCode,
  validateRecipient,
  validateMessageText,
  extractInviteCode,
  validateGroupInviteLink,
  validateWhatsAppChannelLink,
  isValidIPv4,
  isValidIPv6,
  validateIpAddress,
  validateShortlinkTargetUrl,
  validateMediaUpload,
  resolveSafeChildPath,
  OperationRateLimiter,
} from '../../src/security/validation';
import {
  escapeMarkdown,
  stripMarkdown,
  isMarkdownEntityError,
} from '../../src/utils/markdown';
import { toSafeArabicError } from '../../src/utils/errors';
import { formatRuntime, formatMemory } from '../../src/bot/handlers/start';
import { SessionMemoryStore } from '../../src/whatsapp/connection-manager';
import {
  DisconnectReason,
  Browsers,
  jidEncode,
  jidNormalizedUser,
  isJidGroup,
  useMultiFileAuthState,
} from 'athanasia-baileys';
import { verifyTelegramAdmin } from '../../src/bot/middleware/authorization';
import { ConcurrencyLimiter } from '../../src/tasks/concurrency';
import { ShutdownManager as GracefulShutdown } from '../../src/utils/shutdown';
import { calculateBackoffDelay } from '../../src/utils/retry';

test('Startup configuration validation succeeds with valid env and fails fast on missing/invalid vars', () => {
  const valid = validateEnv({
    NODE_ENV: 'production',
    TELEGRAM_BOT_TOKEN: '123456789:AAH_valid_bot_token_string_1234567890',
    TELEGRAM_ADMIN_ID: '987654321',
    DATABASE_PATH: './data/app.sqlite',
    WHATSAPP_AUTH_DIR: './data/whatsapp-sessions',
    TEMP_UPLOAD_DIR: './data/tmp',
    LOG_LEVEL: 'info',
    MAX_CONCURRENT_TASKS: '4',
    TASK_TIMEOUT_MS: '60000',
    MAX_UPLOAD_SIZE_MB: '15',
  });

  assert.equal(valid.TELEGRAM_ADMIN_ID, 987654321);
  assert.equal(valid.MAX_CONCURRENT_TASKS, 4);

  // Missing TELEGRAM_BOT_TOKEN and non-numeric TELEGRAM_ADMIN_ID
  assert.throws(
    () =>
      validateEnv({
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_ADMIN_ID: 'admin_username_not_id',
      }),
    /Startup Configuration Validation Failed/
  );
});

test('Unauthorized Telegram users are strictly rejected', () => {
  // Missing admin ID denies by default
  assert.throws(
    () =>
      verifyTelegramAdmin({
        candidateUserId: 111111,
        configuredAdminId: 0,
        actionDescription: '/start',
      }),
    /الوصول مرفوض/
  );

  // Non-matching user ID is rejected
  assert.throws(
    () =>
      verifyTelegramAdmin({
        candidateUserId: 999999,
        configuredAdminId: 100000001,
        actionDescription: 'callback:menu:sessions',
      }),
    /غير مصرح لك/
  );

  // Exact numeric match succeeds
  assert.doesNotThrow(() =>
    verifyTelegramAdmin({
      candidateUserId: 100000001,
      configuredAdminId: 100000001,
      actionDescription: '/start',
    })
  );
});

test('Phone number validation and normalization handles valid and invalid inputs', () => {
  const res = normalizePhoneNumber('+966 50-123-4567');
  assert.equal(res.e164, '+966501234567');
  assert.equal(res.digits, '966501234567');
  assert.equal(res.jid, '966501234567@s.whatsapp.net');
  assert.equal(res.masked, '+966*****4567');

  // Arabic-Indic numerals conversion
  assert.equal(convertArabicIndicDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  const resArabic = normalizePhoneNumber('+٩٦٦٥٠١٢٣٤٥٦٧');
  assert.equal(resArabic.e164, '+966501234567');
  assert.equal(resArabic.digits, '966501234567');

  // 00 international prefix normalization
  const resDoubleZero = normalizePhoneNumber('00966501234567');
  assert.equal(resDoubleZero.e164, '+966501234567');
  assert.equal(resDoubleZero.digits, '966501234567');

  // Invalid numbers
  assert.throws(() => normalizePhoneNumber('0501234567'), /صيغة رقم الهاتف غير صالحة/);
  assert.throws(() => normalizePhoneNumber('123'), /صيغة رقم الهاتف غير صالحة/);
  assert.throws(() => normalizePhoneNumber('abc123456789'), /صيغة رقم الهاتف غير صالحة/);
});

test('Telegram Markdown safety utilities and error classification', () => {
  assert.equal(escapeMarkdown('sess_1234_test'), 'sess\\_1234\\_test');
  assert.equal(escapeMarkdown('*bold [link]*'), '\\*bold \\[link\\]\\*');
  assert.equal(stripMarkdown('*bold* _italic_ `code`'), 'bold italic code');

  assert.equal(isMarkdownEntityError(new Error("Bad Request: can't parse entities")), true);
  assert.equal(isMarkdownEntityError(new Error('Connection Closed')), false);

  // Baileys Boom connection error classification
  const boomConnErr = toSafeArabicError(new Error('Boom: Connection Closed'));
  assert.equal(boomConnErr.category, 'WHATSAPP_CONNECTION_ERROR');
  assert.ok(boomConnErr.userMessage.includes('تعذر الاتصال بخوادم واتساب'));

  // Timeout error classification
  const timeoutErr = toSafeArabicError(new Error('timed out waiting for message'));
  assert.equal(timeoutErr.category, 'TASK_TIMEOUT');
  assert.ok(timeoutErr.userMessage.includes('انتهت مهلة استجابة'));

  // Telegram entity error classification
  const tgErr = toSafeArabicError(new Error("Bad Request: can't parse entities"));
  assert.equal(tgErr.category, 'TELEGRAM_API_ERROR');
  assert.ok(tgErr.userMessage.includes('/start'));
});

test('Athanasia Baileys exports and custom 8-char pairing code validation work accurately', async () => {
  assert.equal(DisconnectReason.loggedOut, 401);
  assert.equal(DisconnectReason.restartRequired, 515);
  assert.deepEqual(Browsers.ubuntu('Chrome'), ['Ubuntu', 'Chrome', '22.04.4']);
  assert.equal(jidEncode('966501234567', 's.whatsapp.net'), '966501234567@s.whatsapp.net');
  assert.equal(jidNormalizedUser('966501234567:12@s.whatsapp.net'), '966501234567@s.whatsapp.net');
  assert.equal(isJidGroup('120363041001@g.us'), true);
  assert.equal(isJidGroup('966501234567@s.whatsapp.net'), false);

  assert.equal(validateCustomPairingCode('mycode12'), 'MYCODE12');
  assert.equal(validateCustomPairingCode('ABCD-1234'), 'ABCD1234');
  assert.equal(validateCustomPairingCode(undefined), undefined);
  assert.throws(() => validateCustomPairingCode('SHORT'), /8 أحرف/);

  const randomCode = generateRandomPairingCode();
  assert.equal(randomCode.length, 8);
  assert.match(randomCode, /^[A-Z0-9]{8}$/);

  // Verify real useMultiFileAuthState from athanasia-baileys initializes creds.json
  const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athanasia-auth-test-'));
  try {
    const { state, saveCreds } = await useMultiFileAuthState(tmpAuthDir);
    assert.ok(state.creds);
    assert.equal(state.creds.registered, false);
    await saveCreds();
    assert.ok(fs.existsSync(path.join(tmpAuthDir, 'creds.json')));
  } finally {
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
  }
});

test('Message input and group link validation', () => {
  assert.equal(validateMessageText('  مرحبا بكم  '), 'مرحبا بكم');
  assert.throws(() => validateMessageText('   '), /لا يمكن أن يتكون من مسافات/);

  const recipient = validateRecipient('+966559876543');
  assert.equal(recipient.jid, '966559876543@s.whatsapp.net');
  assert.equal(recipient.isGroup, false);

  const link = validateGroupInviteLink(
    'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrSt12'
  );
  assert.equal(link.inviteCode, 'AbCdEfGhIjKlMnOpQrSt12');
  assert.throws(
    () => validateGroupInviteLink('https://example.com/evil'),
    /رابط الدعوة غير صالح/
  );
});

test('File type, size validation, and path traversal protection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-upload-'));
  try {
    // Valid PDF
    const valid = validateMediaUpload({
      originalFilename: '../../etc/passwd.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024 * 50,
      maxUploadSizeMb: 5,
      tempUploadDir: tmpDir,
    });
    assert.equal(valid.kind, 'document');
    assert.ok(valid.safeFilePath.startsWith(path.resolve(tmpDir)));
    assert.ok(!valid.safeFilePath.includes('..'));

    // Disallowed MIME type (executable)
    assert.throws(
      () =>
        validateMediaUpload({
          originalFilename: 'malware.sh',
          mimeType: 'application/x-sh',
          sizeBytes: 512,
          maxUploadSizeMb: 5,
          tempUploadDir: tmpDir,
        }),
      /غير مدعوم/
    );

    // Oversized file
    assert.throws(
      () =>
        validateMediaUpload({
          originalFilename: 'huge.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 25 * 1024 * 1024,
          maxUploadSizeMb: 10,
          tempUploadDir: tmpDir,
        }),
      /يتجاوز الحد الأقصى/
    );

    // Direct path traversal check
    assert.throws(
      () => resolveSafeChildPath(tmpDir, '../outside'),
      /Path Traversal/
    );
    assert.throws(
      () => resolveSafeChildPath(tmpDir, 'nested/subpath'),
      /Path Traversal/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Log redaction strips tokens, pairing codes, keys, and masks phone numbers', () => {
  assert.equal(maskPhoneNumber('+966501234567'), '+966*****4567');

  const rawText =
    'Bot token 123456789:AAH_secret_token_value_12345678901234 and pairing code WA96-1234';
  const redactedStr = redactText(rawText);
  assert.ok(!redactedStr.includes('AAH_secret_token_value'));
  assert.ok(!redactedStr.includes('WA96-1234'));
  assert.ok(redactedStr.includes('[REDACTED_TELEGRAM_TOKEN]'));
  assert.ok(redactedStr.includes('[REDACTED_PAIRING_CODE]'));

  const sensitiveObj = {
    botToken: '123456789:AAH_secret_token_value_12345678901234',
    pairingCode: 'ABCD-1234',
    phoneNumber: '+966501234567',
    nested: {
      privateKey: 'super_secret_private_key',
      safeField: 'visible_value',
    },
  };

  const sanitized = redactObject(sensitiveObj);
  assert.equal(sanitized.botToken, '[REDACTED]');
  assert.equal(sanitized.pairingCode, '[REDACTED]');
  assert.equal(sanitized.phoneNumber, '+966*****4567');
  assert.equal(sanitized.nested.privateKey, '[REDACTED]');
  assert.equal(sanitized.nested.safeField, 'visible_value');
});

test('ConcurrencyLimiter enforces strict maximum simultaneous tasks', async () => {
  const limiter = new ConcurrencyLimiter(2);
  let active = 0;
  let maxObserved = 0;

  const work = Array.from({ length: 6 }, (_, idx) =>
    limiter.run(async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      return idx;
    })
  );

  const results = await Promise.all(work);
  assert.equal(results.length, 6);
  assert.equal(maxObserved, 2);
});

test('Bounded backoff calculation and Graceful Shutdown LIFO order', async () => {
  const delay1 = calculateBackoffDelay(1, { baseDelayMs: 1000, maxDelayMs: 5000 });
  const delay5 = calculateBackoffDelay(10, { baseDelayMs: 1000, maxDelayMs: 5000 });
  assert.ok(delay1 >= 200 && delay1 <= 5000);
  assert.ok(delay5 <= 5000);

  const order: string[] = [];
  const shutdown = new GracefulShutdown();
  shutdown.register('db', () => {
    order.push('db');
  });
  shutdown.register('sessions', () => {
    order.push('sessions');
  });
  shutdown.register('bot', () => {
    order.push('bot');
  });

  await shutdown.shutdown('TEST');
  assert.deepEqual(order, ['bot', 'sessions', 'db']);
});

test('OperationRateLimiter blocks duplicate and excessive bursts', () => {
  const limiter = new OperationRateLimiter(2, 10_000, 10_000);
  limiter.checkRateLimit('sess_1');
  limiter.checkRateLimit('sess_1');
  assert.throws(() => limiter.checkRateLimit('sess_1'), /تجاوز الحد المسموح/);

  limiter.checkDuplicateOperation('sig_abc');
  assert.throws(() => limiter.checkDuplicateOperation('sig_abc'), /منع التكرار/);
});

test('Extracted Nebula utilities: invite code, channel links, IPv4/IPv6, URL shortlink, runtime/memory, and SessionMemoryStore', () => {
  // Direct invite code and URL extraction
  assert.equal(
    extractInviteCode('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrSt12'),
    'AbCdEfGhIjKlMnOpQrSt12'
  );
  assert.equal(extractInviteCode('AbCdEfGhIjKlMnOpQrSt12'), 'AbCdEfGhIjKlMnOpQrSt12');
  assert.equal(extractInviteCode('invalid_short'), null);

  // WhatsApp channel link validation (/cekidch)
  const ch = validateWhatsAppChannelLink(
    'https://whatsapp.com/channel/0029VaChannelDemo123'
  );
  assert.equal(ch.inviteCode, '0029VaChannelDemo123');
  assert.throws(
    () => validateWhatsAppChannelLink('https://example.com/not-channel'),
    /رابط قناة واتساب غير صالح/
  );

  // IPv4 & IPv6 validation (/trackip)
  assert.equal(isValidIPv4('8.8.8.8'), true);
  assert.equal(isValidIPv4('192.168.01.1'), false); // Leading zero rejected
  assert.equal(isValidIPv4('999.1.1.1'), false);
  assert.equal(isValidIPv6('2001:4860:4860::8888'), true);
  assert.equal(validateIpAddress('1.1.1.1'), '1.1.1.1');
  assert.throws(() => validateIpAddress('not.an.ip'), /عنوان IP غير صالح/);

  // Shortlink URL validation (/shortlink)
  assert.equal(
    validateShortlinkTargetUrl('https://example.com/path?a=1'),
    'https://example.com/path?a=1'
  );
  assert.throws(
    () => validateShortlinkTargetUrl('javascript:alert(1)'),
    /يجب أن يبدأ الرابط/
  );

  // Runtime & Memory formatting
  assert.equal(formatRuntime(3665), '1h 1m 5s');
  assert.equal(formatMemory(128 * 1024 * 1024), '128 MB');

  // SessionMemoryStore cap at 100 messages per chat
  const store = new SessionMemoryStore();
  const listeners: Record<string, (arg: any) => void> = {};
  const fakeEv = {
    on: (ev: string, fn: (arg: any) => void) => {
      listeners[ev] = fn;
    },
    off: (ev: string) => {
      delete listeners[ev];
    },
  } as any;

  const unbind = store.bind(fakeEv);
  const messagesBatch = Array.from({ length: 115 }, (_, idx) => ({
    key: { remoteJid: '966501234567@s.whatsapp.net', id: `m_${idx}` },
    pushName: 'Tester',
    messageTimestamp: 1700000000 + idx,
  }));
  listeners['messages.upsert']({ messages: messagesBatch, type: 'notify' });
  listeners['contacts.set']({ contacts: { c1: { id: 'c1' }, c2: { id: 'c2' } } });

  const stats = store.getStats();
  assert.equal(stats.chatsCount, 1);
  assert.equal(stats.contactsCount, 2);
  assert.equal(stats.cachedMessagesCount, 100); // Capped at 100
  unbind();
});

test('Role-aware Main Menu keyboard filters privileged admin options for non-admin users', async () => {
  const { buildMainMenuKeyboard } = await import('../../src/bot/keyboards/main-menu');
  const adminKb = buildMainMenuKeyboard({ isAdmin: true });
  const userKb = buildMainMenuKeyboard({ isAdmin: false });

  const adminCallbacks = adminKb.flat().map((b) => b.callbackData);
  const userCallbacks = userKb.flat().map((b) => b.callbackData);

  assert.ok(adminCallbacks.includes('menu:admin'));
  assert.ok(adminCallbacks.includes('menu:subscriptions:page:1'));
  assert.ok(adminCallbacks.includes('menu:settings'));
  assert.ok(adminCallbacks.includes('menu:audit:page:1'));

  assert.ok(!userCallbacks.includes('menu:admin'));
  assert.ok(!userCallbacks.includes('menu:subscriptions:page:1'));
  assert.ok(!userCallbacks.includes('menu:settings'));
  assert.ok(!userCallbacks.includes('menu:audit:page:1'));
});

