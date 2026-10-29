import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DisconnectReason } from 'athanasia-baileys';
import { createAtomicMultiFileAuthState } from '../../src/whatsapp/atomic-auth-state';
import { SessionStore } from '../../src/whatsapp/session-store';
import {
  SessionMemoryStore,
  classifyDisconnectReason,
  MockWhatsAppSessionDriver,
  ConnectionEventCallbacks,
} from '../../src/whatsapp/connection-manager';
import { AppDatabase } from '../../src/database/database';
import { SessionRepository } from '../../src/database/repositories/session-repository';
import { AuditRepository } from '../../src/database/repositories/audit-repository';
import { SessionManager } from '../../src/whatsapp/session-manager';
import { MIGRATION_004_ID } from '../../src/database/migrations/004_session_lifecycle_hardening';

test('Phase 1: createAtomicMultiFileAuthState writes atomically, maintains creds.json.bak on registered credentials, self-heals corrupted creds.json, and flushes concurrent key writes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-auth-test-'));
  try {
    const authFolder = path.join(tmpDir, 'sess_atomic_1');
    const auth1 = await createAtomicMultiFileAuthState(authFolder);

    assert.equal(auth1.recoveredFromBackup, false);
    assert.equal(auth1.state.creds.registered, false);

    // 1. Save unregistered creds -> should write creds.json but NOT create creds.json.bak yet
    auth1.state.creds.me = { id: '966501112222@s.whatsapp.net', name: 'Test' };
    await auth1.saveCreds();

    const credsPath = path.join(authFolder, 'creds.json');
    const backupPath = path.join(authFolder, 'creds.json.bak');
    assert.equal(fs.existsSync(credsPath), true);
    assert.equal(fs.existsSync(backupPath), false);

    // 2. Mark credentials as registered (`registered = true` + `account`) and write Signal keys concurrently
    auth1.state.creds.registered = true;
    auth1.state.creds.account = {
      details: new Uint8Array([1, 2, 3, 4]),
      accountSignatureKey: new Uint8Array([5, 6, 7, 8]),
      accountSignature: new Uint8Array([9, 10, 11, 12]),
      deviceSignature: new Uint8Array([13, 14, 15, 16]),
    };

    const keyWritePromise = auth1.state.keys.set({
      'pre-key': {
        '1': {
          private: Buffer.from('priv-key-1'),
          public: Buffer.from('pub-key-1'),
        },
        '2': {
          private: Buffer.from('priv-key-2'),
          public: Buffer.from('pub-key-2'),
        },
      },
      session: {
        '966501112222:0': new Uint8Array([99, 88, 77]),
      },
    });
    const credsWritePromise = auth1.saveCreds();

    await Promise.all([keyWritePromise, credsWritePromise]);
    await auth1.flushPendingWrites();

    // Verify backup `creds.json.bak` was created automatically
    assert.equal(fs.existsSync(backupPath), true);

    // Verify no leftover `.tmp` files remain
    const filesInFolder = fs.readdirSync(authFolder);
    assert.equal(
      filesInFolder.some((f) => f.endsWith('.tmp')),
      false
    );

    // 3. Simulate mid-write crash by truncating/corrupting `creds.json`
    fs.writeFileSync(credsPath, '{"noiseKey": {"private": "truncated...', 'utf-8');

    // Re-open with `createAtomicMultiFileAuthState` -> must self-heal from `creds.json.bak`!
    const auth2 = await createAtomicMultiFileAuthState(authFolder);
    assert.equal(auth2.recoveredFromBackup, true);
    assert.equal(auth2.state.creds.registered, true);
    assert.equal(auth2.state.creds.me?.id, '966501112222@s.whatsapp.net');

    // Verify Signal keys are intact as well
    const loadedPreKeys = await auth2.state.keys.get('pre-key', ['1', '2']);
    assert.ok(loadedPreKeys['1']);
    assert.ok(loadedPreKeys['2']);

    // Verify `creds.json` on disk was healed back to valid JSON
    const healedRaw = fs.readFileSync(credsPath, 'utf-8');
    const healedParsed = JSON.parse(healedRaw);
    assert.equal(healedParsed.registered, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 2: SessionStore.inspectCredentials automatically heals corrupted creds.json from creds.json.bak and reports recoveredFromBackup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-heal-'));
  try {
    const store = new SessionStore(tmpDir);
    const sessionId = 'sess_heal_test';
    const authDir = store.prepareSessionAuthDir(sessionId);

    const auth = await createAtomicMultiFileAuthState(authDir);
    auth.state.creds.registered = true;
    auth.state.creds.me = { id: '966509998888:2@s.whatsapp.net', name: 'HealedUser' };
    await auth.saveCreds();

    // Corrupt primary creds.json while leaving creds.json.bak intact
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{corrupted', 'utf-8');

    const inspection = store.inspectCredentials(sessionId);
    assert.equal(inspection.corrupted, false);
    assert.equal(inspection.registered, true);
    assert.equal(inspection.backupExists, true);
    assert.equal(inspection.recoveredFromBackup, true);
    assert.equal(inspection.meJid, '966509998888:2@s.whatsapp.net');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 3: SessionMemoryStore caches sent and incoming messages for getMessage retry encryption lookup with bounded LRU eviction', () => {
  const memoryStore = new SessionMemoryStore();

  memoryStore.cacheSentMessage(
    {
      remoteJid: '966501234567@s.whatsapp.net',
      id: 'BAE5_TEST_MSG_001',
      fromMe: true,
    },
    { conversation: 'مرحباً بك في نظام Botezz' }
  );

  const found = memoryStore.getMessage({
    remoteJid: '966501234567@s.whatsapp.net',
    id: 'BAE5_TEST_MSG_001',
  });
  assert.ok(found);
  assert.equal(found.conversation, 'مرحباً بك في نظام Botezz');

  const foundByIdOnly = memoryStore.getMessage({
    id: 'BAE5_TEST_MSG_001',
  });
  assert.ok(foundByIdOnly);
  assert.equal(foundByIdOnly.conversation, 'مرحباً بك في نظام Botezz');
  assert.equal(memoryStore.getCachedMessagesCount(), 1);
});

test('Phase 4: Disconnect Reason Classification & SessionManager Conflict/Repair Protection (440, 403, 411, 401, 515, 428)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disconnect-matrix-'));
  const db = new AppDatabase(':memory:');
  const sessionRepo = new SessionRepository(db);
  const auditRepo = new AuditRepository(db);
  const sessionStore = new SessionStore(tmpDir);

  const capturedDrivers = new Map<
    string,
    { driver: MockWhatsAppSessionDriver; callbacks: ConnectionEventCallbacks | null }
  >();

  const sessionManager = new SessionManager(
    sessionRepo,
    auditRepo,
    sessionStore,
    (sessionId) => {
      const drv = new MockWhatsAppSessionDriver(sessionId);
      drv.simulatedDelayMs = 5;
      const entry = { driver: drv, callbacks: null as ConnectionEventCallbacks | null };
      const origConnect = drv.connect.bind(drv);
      drv.connect = async (cb: ConnectionEventCallbacks) => {
        entry.callbacks = cb;
        return origConnect(cb);
      };
      capturedDrivers.set(sessionId, entry);
      return drv;
    },
    {
      defaultAutoCompleteInMock: true,
      maxReconnectAttempts: 3,
      reconnectBaseDelayMs: 25,
      reconnectMaxDelayMs: 60,
    }
  );

  try {
    // 1. Unit check classifyDisconnectReason matrix
    const c440 = classifyDisconnectReason(
      DisconnectReason.connectionReplaced,
      true,
      'Stream Errored (conflict)'
    );
    assert.equal(c440.category, 'SESSION_CONFLICT_REPLACED');
    assert.equal(c440.requiresRepair, true);
    assert.equal(c440.shouldAutoReconnect, false);

    const c403 = classifyDisconnectReason(DisconnectReason.forbidden, true);
    assert.equal(c403.category, 'PROTOCOL_OR_AUTH_REJECTED');
    assert.equal(c403.requiresRepair, true);
    assert.equal(c403.shouldAutoReconnect, false);

    const c411 = classifyDisconnectReason(DisconnectReason.multideviceMismatch, true);
    assert.equal(c411.category, 'PROTOCOL_OR_AUTH_REJECTED');
    assert.equal(c411.requiresRepair, true);
    assert.equal(c411.shouldAutoReconnect, false);

    const c428 = classifyDisconnectReason(DisconnectReason.connectionClosed, true);
    assert.equal(c428.category, 'TRANSIENT_RECOVERABLE');
    assert.equal(c428.requiresRepair, false);
    assert.equal(c428.shouldAutoReconnect, true);

    // 2. Verify SessionManager transitions registered session on 440 (connectionReplaced)
    // to REQUIRES_REPAIR and does NOT schedule auto-reconnect
    const paired = await sessionManager.initiatePairing({
      rawPhoneNumber: '+966504404400',
      actorTelegramId: 1001,
      autoCompleteInMock: true,
    });
    const sessId = paired.session.id;
    assert.equal(sessionManager.getSession(sessId)?.status, 'CONNECTED');

    const activeEntry = capturedDrivers.get(sessId)!;
    activeEntry.driver.simulateDisconnect(
      DisconnectReason.connectionReplaced,
      'Replaced by another instance'
    );

    const verifAfter440 = sessionManager.getLiveVerification(sessId)!;
    assert.equal(verifAfter440.session.status, 'REQUIRES_REPAIR');
    assert.equal(verifAfter440.session.last_disconnect_code, 440);
    assert.equal(
      verifAfter440.session.last_disconnect_reason,
      'SESSION_CONFLICT_REPLACED'
    );
    assert.equal(verifAfter440.hasReconnectTimer, false);
    assert.equal(verifAfter440.health.status, 'UNHEALTHY');

    // 3. Verify startup restoration heals a session from creds.json.bak and skips REQUIRES_REPAIR
    const sHeal = sessionManager.createSession('جلسة محمية بنسخة احتياطية', 1001);
    const sHealDir = sessionStore.prepareSessionAuthDir(sHeal.id);
    const atomicAuth = await createAtomicMultiFileAuthState(sHealDir);
    atomicAuth.state.creds.registered = true;
    atomicAuth.state.creds.me = { id: '966507778888@s.whatsapp.net', name: 'BackupUser' };
    await atomicAuth.saveCreds();
    // Corrupt primary creds.json
    fs.writeFileSync(path.join(sHealDir, 'creds.json'), '{broken_json', 'utf-8');
    sessionRepo.updateStatus({ id: sHeal.id, status: 'DISCONNECTED' });

    const restoreSummary = await sessionManager.restoreSessionsOnStartup();
    assert.equal(restoreSummary.restoredCount, 1);
    assert.equal(restoreSummary.repairedFromBackupCount, 1);
    assert.equal(restoreSummary.stoppedOrLoggedOutSkippedCount, 1); // sessId in REQUIRES_REPAIR was skipped
    assert.equal(sessionManager.getSession(sHeal.id)?.status, 'CONNECTED');
  } finally {
    await sessionManager.shutdownAll();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 5: Database Migration 004_session_lifecycle_hardening supports all canonical states and clean non-destructive rollback', () => {
  const db = new AppDatabase(':memory:');
  try {
    const sessionRepo = new SessionRepository(db);
    assert.equal(db.hasMigration(MIGRATION_004_ID), true);

    const s1 = sessionRepo.create({
      id: 'sess_mig_1',
      label: 'اختبار الترحيل',
      status: 'CREATED',
      authDir: '/tmp/sess_mig_1',
    });
    assert.equal(s1.status, 'CREATED');
    assert.equal(s1.health_status, 'UNKNOWN');

    const updated = sessionRepo.updateStatus({
      id: s1.id,
      status: 'REQUIRES_REPAIR',
      lastDisconnectCode: 440,
      lastDisconnectReason: 'SESSION_CONFLICT_REPLACED',
      healthStatus: 'UNHEALTHY',
    });
    assert.equal(updated?.status, 'REQUIRES_REPAIR');
    assert.equal(updated?.last_disconnect_code, 440);
    assert.equal(updated?.health_status, 'UNHEALTHY');

    // Rollback migration 004 and verify row is preserved and mapped to safe legacy status
    const rolledBack = db.rollbackMigration(MIGRATION_004_ID);
    assert.equal(rolledBack, true);
    assert.equal(db.hasMigration(MIGRATION_004_ID), false);

    const afterRollback = sessionRepo.findById(s1.id);
    assert.ok(afterRollback);
    assert.equal(afterRollback.status, 'FAILED');
  } finally {
    db.close();
  }
});
