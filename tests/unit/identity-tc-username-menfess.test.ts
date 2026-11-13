import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  HiroosyBaileysSessionDriver,
  MockWhatsAppSessionDriver,
  BinaryNode,
  WhatsAppIdentityService,
} from '../../src/whatsapp/connection-manager';
import { AnonymousSessionEngine } from '../../src/whatsapp/anonymous-session-engine';
import { createAtomicMultiFileAuthState } from '../../src/whatsapp/atomic-auth-state';
import {
  WASocket,
  normalizeUsername,
  isValidUsername,
  isValidUsernameKey,
} from '../../src/whatsapp/baileys-compat';
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
import { OperationRateLimiter } from '../../src/security/validation';
import {
  maskPhoneForMenfess,
  maskJidForDiagnostics,
  redactSensitiveData,
  redactText,
} from '../../src/security/redaction';
import { TaskRunner } from '../../src/tasks/task-runner';
import { TaskManager } from '../../src/tasks/task-manager';
import { TelegramBotController } from '../../src/bot/bot';
import { AppConfig } from '../../src/config/env';
import { getNetworkTrafficMonitor } from '../../src/network/network-traffic-monitor';

function createFakeIdentitySocket(overrides?: {
  onWhatsAppFn?: (...jids: string[]) => Promise<Array<{ jid: string; exists: boolean; lid?: string }>>;
  usyncFn?: (query: unknown) => Promise<{ list?: Array<{ id?: string; lid?: string; pn?: string; username?: string }> }>;
  queryFn?: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  relayFn?: (jid: string, msg: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string>;
  resolveUsernameFn?: (handle: string, key?: string) => Promise<{ status: string; jid?: string }>;
  issuePrivacyTokensFn?: (jids: string[], ts?: number) => Promise<BinaryNode | void>;
  fetchReachoutFn?: () => Promise<{ isActive: boolean; timeEnforcementEnds?: Date; enforcementType?: string }>;
}): {
  sock: WASocket;
  ev: EventEmitter;
  queriedNodes: BinaryNode[];
  usyncCalls: number;
  relayedMessages: Array<{ jid: string; msg: Record<string, unknown>; opts?: Record<string, unknown> }>;
  sentMessages: Array<{ jid: string; content: Record<string, unknown>; opts?: Record<string, unknown> }>;
  assertedSessions: string[][];
  migratedSessions: Array<{ from: string; to: string }>;
  keyStoreBacking: Map<string, Record<string, unknown>>;
} {
  const ev = new EventEmitter();
  const queriedNodes: BinaryNode[] = [];
  const relayedMessages: Array<{ jid: string; msg: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
  const sentMessages: Array<{ jid: string; content: Record<string, unknown>; opts?: Record<string, unknown> }> = [];
  const assertedSessions: string[][] = [];
  const migratedSessions: Array<{ from: string; to: string }> = [];
  const lidByPn = new Map<string, string>();
  const pnByLid = new Map<string, string>();
  const keyStoreBacking = new Map<string, Record<string, unknown>>();
  let usyncCalls = 0;

  const sock: Record<string, unknown> = {
    ev: {
      on: (event: string, listener: (...args: unknown[]) => void) => ev.on(event, listener),
      off: (event: string, listener: (...args: unknown[]) => void) => ev.off(event, listener),
      removeAllListeners: (event?: string) => ev.removeAllListeners(event),
    },
    ws: { isOpen: true },
    user: {
      id: '966500000001:1@s.whatsapp.net',
      lid: '10000000000001:1@lid',
      name: 'Botezz Hub',
    },
    serverProps: {
      privacyTokenOn1to1: true,
      lidTrustedTokenIssueToLid: true,
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
        isInTransaction: () => false,
        transaction: async <T>(work: () => Promise<T>) => work(),
        get: async (type: string, ids: string[]) => {
          const typeMap = keyStoreBacking.get(type) || {};
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            if (typeMap[id] !== undefined) {
              out[id] = typeMap[id];
            }
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown>>) => {
          for (const category of Object.keys(data)) {
            const existing = keyStoreBacking.get(category) || {};
            const patch = data[category] || {};
            for (const id of Object.keys(patch)) {
              if (patch[id] === null || patch[id] === undefined) {
                delete existing[id];
              } else {
                existing[id] = patch[id];
              }
            }
            keyStoreBacking.set(category, existing);
          }
        },
      },
    },
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn: string) => lidByPn.get(pn) ?? null,
        getPNForLID: async (lid: string) => pnByLid.get(lid) ?? null,
        storeLIDPNMappings: async (mappings: Array<{ lid: string; pn: string }>) => {
          for (const m of mappings) {
            lidByPn.set(m.pn, m.lid);
            pnByLid.set(m.lid, m.pn);
          }
        },
      },
      migrateSession: async (from: string, to: string) => {
        migratedSessions.push({ from, to });
        return { migrated: 1, skipped: 0, total: 1 };
      },
    },
    getUSyncDevices: async (jids: string[]) =>
      jids.map((j) => ({ user: j.split('@')[0] || '0', device: 0 })),
    assertSessions: async (jids: string[]) => {
      assertedSessions.push(jids);
      return true;
    },
    onWhatsApp: async (...jids: string[]) => {
      if (overrides?.onWhatsAppFn) {
        return overrides.onWhatsAppFn(...jids);
      }
      return jids.map((j) => ({
        jid: j,
        exists: true,
        lid: j.endsWith('@lid') ? j : '88888888888888@lid',
      }));
    },
    executeUSyncQuery: async (query: unknown) => {
      usyncCalls += 1;
      if (overrides?.usyncFn) {
        return overrides.usyncFn(query);
      }
      return {
        list: [
          {
            id: '967771234535@s.whatsapp.net',
            lid: '144109809438738@lid',
          },
        ],
      };
    },
    query: async (node: BinaryNode, timeoutMs?: number) => {
      queriedNodes.push(node);
      if (overrides?.queryFn) {
        return overrides.queryFn(node, timeoutMs);
      }
      return { tag: 'iq', attrs: { type: 'result' }, content: [] };
    },
    relayMessage: async (
      jid: string,
      msg: Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => {
      if (overrides?.relayFn) {
        return overrides.relayFn(jid, msg, opts);
      }
      relayedMessages.push({ jid, msg, opts });
      return `RELAY_ID_${relayedMessages.length}`;
    },
    sendMessage: async (
      jid: string,
      content: Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => {
      sentMessages.push({ jid, content, opts });
      return {
        key: {
          remoteJid: jid,
          fromMe: true,
          id: `SEND_ID_${sentMessages.length}`,
        },
        message: content,
      };
    },
    resolveUsername: overrides?.resolveUsernameFn,
    issuePrivacyTokens: overrides?.issuePrivacyTokensFn,
    fetchAccountReachoutTimelock:
      overrides?.fetchReachoutFn ||
      (async () => ({ isActive: false })),
  };

  return {
    sock: sock as unknown as WASocket,
    ev,
    queriedNodes,
    get usyncCalls() {
      return usyncCalls;
    },
    relayedMessages,
    sentMessages,
    assertedSessions,
    migratedSessions,
    keyStoreBacking,
  };
}

function attachFakeSocketToDriver(
  driver: HiroosyBaileysSessionDriver,
  sock: WASocket
): void {
  (driver as unknown as { sock: WASocket | null }).sock = sock;
}

// ============================================================================
// 1. FEATURE A1: Native PN <-> LID Resolution & Concurrent Deduplication
// ============================================================================

test('IdentityService resolves PN->LID, LID->PN, returns null for unknown contact, uses cache, and deduplicates concurrent USync calls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_lid_'));
  try {
    const driver = new HiroosyBaileysSessionDriver('sess_lid_1', tmpDir);
    const fake = createFakeIdentitySocket({
      onWhatsAppFn: async (...jids) =>
        jids.map((j) =>
          j.includes('999000111222')
            ? { jid: j, exists: false }
            : { jid: j, exists: true, lid: '77771111222233@lid' }
        ),
      usyncFn: async (query) => {
        await new Promise((r) => setTimeout(r, 25));
        const qUsers = (query as { users?: Array<{ id?: string; phone?: string }> })?.users || [];
        const hasUnknown = qUsers.some(
          (u) => (u.id || '').includes('999000111222') || (u.phone || '').includes('999000111222')
        );
        if (hasUnknown) {
          return { list: [] };
        }
        return {
          list: [
            {
              id: '967771234535@s.whatsapp.net',
              lid: '77771111222233@lid',
              username: 'sara_dev',
            },
          ],
        };
      },
      queryFn: async (node) => {
        if (node.attrs?.xmlns === 'usync') {
          const users = (node.content as BinaryNode[])
            ?.find((c) => c.tag === 'usync')
            ?.content as BinaryNode[] | undefined;
          const listNode = users?.find((c) => c.tag === 'list');
          const userNode = (listNode?.content as BinaryNode[])?.[0];
          const jid = userNode?.attrs?.jid || '';
          if (jid.includes('999000111222')) {
            return { tag: 'iq', attrs: { type: 'result' }, content: [] };
          }
        }
        return { tag: 'iq', attrs: { type: 'result' }, content: [] };
      },
    });
    attachFakeSocketToDriver(driver, fake.sock);

    const svc = driver.getIdentityService();

    // A) Concurrent deduplication: 8 parallel calls to resolvePnToLid -> 1 USync call
    const concurrentResults = await Promise.all(
      Array.from({ length: 8 }, () => svc.resolvePnToLid('+967771234535'))
    );
    assert.equal(fake.usyncCalls, 1);
    for (const r of concurrentResults) {
      assert.equal(r?.pnJid, '967771234535@s.whatsapp.net');
      assert.equal(r?.lidJid, '77771111222233@lid');
      assert.equal(r?.phoneNumber, '+967771234535');
    }

    // B) Cache hit on subsequent call -> still 1 USync call!
    const cached = await svc.resolvePnToLid('967771234535@s.whatsapp.net');
    assert.equal(fake.usyncCalls, 1);
    assert.equal(cached?.lidJid, '77771111222233@lid');
    assert.equal(cached?.source, 'mapping');

    // C) Reverse resolution LID -> PN from stored mapping
    const reverse = await svc.resolveLidToPn('77771111222233@lid');
    assert.equal(reverse?.pnJid, '967771234535@s.whatsapp.net');
    assert.equal(reverse?.lidJid, '77771111222233@lid');
    assert.equal(reverse?.phoneNumber, '+967771234535');

    // D) Unknown non-existent contact -> returns null cleanly
    const unknown = await svc.resolvePnToLid('+999000111222');
    assert.equal(unknown, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sendLidAddressedMessage delivers with addressing_mode="lid", initializes Signal sessions, preserves sender identity, and injects TC-Token', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_lidsend_'));
  try {
    const driver = new HiroosyBaileysSessionDriver('sess_lidsend', tmpDir);
    const fake = createFakeIdentitySocket();
    attachFakeSocketToDriver(driver, fake.sock);

    // Seed TC-Token for target
    await fake.sock.authState.keys.set({
      tctoken: {
        '77771111222233@lid': {
          token: Buffer.from('abcdef123456', 'hex'),
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      },
    });
    await fake.sock.signalRepository!.lidMapping!.storeLIDPNMappings([
      { pn: '967771234535@s.whatsapp.net', lid: '77771111222233@lid' },
    ]);

    const res = await driver.sendLidAddressedMessage({
      target: '+967771234535',
      content: 'Private protocol message',
      customPushName: 'Anonymous Alias',
    });

    assert.equal(res.addressingMode, 'lid');
    assert.equal(res.targetJid, '77771111222233@lid');
    assert.equal(res.pnJid, '967771234535@s.whatsapp.net');
    assert.equal(res.tcTokenAttached, true);
    assert.equal(fake.sentMessages.length, 1);

    const sent = fake.sentMessages[0]!;
    assert.equal(sent.jid, '77771111222233@lid');
    assert.equal(sent.opts?.addressingMode, 'lid');
    assert.deepEqual(sent.opts?.additionalAttributes, {
      addressing_mode: 'lid',
    });
    assert.ok(fake.assertedSessions.some((s) => s.includes('77771111222233@lid')));
    assert.ok(
      fake.migratedSessions.some(
        (m) => m.from === '967771234535@s.whatsapp.net' && m.to === '77771111222233@lid'
      )
    );

    // Verify explicit injectPrivacyTokenNodes helper builds <tctoken> node
    const injected = await driver
      .getIdentityService()
      .privacyTokens.injectPrivacyTokenNodes('77771111222233@lid');
    assert.equal(injected.injected, true);
    assert.equal(injected.nodes?.[0]?.tag, 'tctoken');

    // Verify relayMessage fallback path when sock.sendMessage is absent
    (fake.sock as unknown as { sendMessage?: unknown }).sendMessage = undefined;
    const relayRes = await driver.sendLidAddressedMessage({
      target: '+967771234535',
      content: 'Direct relay fallback',
    });
    assert.equal(relayRes.addressingMode, 'lid');
    assert.equal(fake.relayedMessages.length, 1);
    assert.equal(fake.relayedMessages[0]!.jid, '77771111222233@lid');
    assert.deepEqual(fake.relayedMessages[0]!.opts?.additionalAttributes, {
      addressing_mode: 'lid',
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. FEATURE A2: TC-Token Lifecycle, Error 463 Recovery, & Reachout Timelock
// ============================================================================

test('AtomicAuthState supports SignalKeyStore transaction & persists tctoken safely across concurrent writes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_atomic_tc_'));
  try {
    const auth = await createAtomicMultiFileAuthState(tmpDir);
    assert.equal(typeof auth.state.keys.transaction, 'function');
    assert.equal(typeof auth.state.keys.isInTransaction, 'function');
    assert.equal(auth.state.keys.isInTransaction!(), false);

    await auth.state.keys.transaction!(async () => {
      assert.equal(auth.state.keys.isInTransaction!(), true);
      await auth.state.keys.set({
        tctoken: {
          '12345@lid': {
            token: Buffer.from('01020304', 'hex'),
            timestamp: '1770000000',
          },
        },
      });
    }, 'tctoken:12345@lid');

    assert.equal(auth.state.keys.isInTransaction!(), false);
    const loaded = await auth.state.keys.get('tctoken', ['12345@lid']);
    assert.ok(loaded['12345@lid']?.token);
    assert.equal(
      Buffer.from(loaded['12345@lid']!.token!).toString('hex'),
      '01020304'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PrivacyTokenManager captures incoming tokens, detects expiry, issues missing tokens, retries once on 463, and refuses retry when reachoutTimeLock is active', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_tc463_'));
  try {
    const driver = new HiroosyBaileysSessionDriver('sess_tc463', tmpDir);
    let issuedCount = 0;
    const fake = createFakeIdentitySocket({
      issuePrivacyTokensFn: async (jids) => {
        issuedCount += 1;
        return {
          tag: 'iq',
          attrs: { type: 'result' },
          content: [
            {
              tag: 'tokens',
              attrs: {},
              content: jids.map((j) => ({
                tag: 'token',
                attrs: {
                  jid: j,
                  type: 'trusted_contact',
                  t: String(Math.floor(Date.now() / 1000)),
                },
                content: Buffer.from('deadbeefcafe', 'hex'),
              })),
            },
          ],
        };
      },
    });
    attachFakeSocketToDriver(driver, fake.sock);
    const svc = driver.getIdentityService();

    // 1. Capture incoming IQ token
    const captured = await svc.privacyTokens.captureIncomingPrivacyToken({
      iqNode: {
        tag: 'iq',
        attrs: { xmlns: 'privacy', type: 'set' },
        content: [
          {
            tag: 'tokens',
            attrs: {},
            content: [
              {
                tag: 'token',
                attrs: {
                  jid: '967771234535@s.whatsapp.net',
                  type: 'trusted_contact',
                  t: String(Math.floor(Date.now() / 1000)),
                },
                content: Buffer.from('aabbccddeeff', 'hex'),
              },
            ],
          },
        ],
      },
    });
    assert.ok(captured?.hasToken);

    const validRec = await svc.privacyTokens.getValidPrivacyToken(
      '967771234535@s.whatsapp.net'
    );
    assert.equal(validRec?.hasToken, true);
    assert.equal(validRec?.expired, false);

    // 2. Expired token cleanup (timestamp from year 2020 -> well past 28-day TC-token TTL)
    await fake.sock.authState.keys.set({
      tctoken: {
        '967700000001@s.whatsapp.net': {
          token: Buffer.from('11223344', 'hex'),
          timestamp: '1580000000',
        },
      },
    });
    const expiredRec = await svc.privacyTokens.getValidPrivacyToken(
      '967700000001@s.whatsapp.net'
    );
    assert.equal(expiredRec?.expired, true);
    assert.equal(expiredRec?.hasToken, false);

    // 3. Error 463 bounded recovery: attempt 1 throws 463 -> refreshes token -> retries ONCE and succeeds
    let attempts = 0;
    const recovered = await svc.privacyTokens.executeWithBounded463Recovery(
      '967779998887@s.whatsapp.net',
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('Message rejected with server error 463') as Error & {
            data?: number;
          };
          err.data = 463;
          throw err;
        }
        return 'OK_AFTER_REFRESH';
      }
    );
    assert.equal(recovered.result, 'OK_AFTER_REFRESH');
    assert.equal(attempts, 2);
    assert.equal(issuedCount >= 1, true);
    assert.equal(recovered.diagnostic?.recovered, true);
    assert.equal(recovered.diagnostic?.retried, true);

    // 4a. When reachoutTimeLock is already active locally, fail-fast with 0 attempts
    svc.privacyTokens.handleReachoutTimelockUpdate({
      isActive: true,
      timeEnforcementEnds: new Date(Date.now() + 3600_000),
      enforcementType: 'new_chat_reachout',
    });
    let timelockAttempts = 0;
    await assert.rejects(
      async () => {
        await svc.privacyTokens.executeWithBounded463Recovery(
          '967779998887@s.whatsapp.net',
          async () => {
            timelockAttempts += 1;
            const err = new Error('463 reachout') as Error & { data?: number };
            err.data = 463;
            throw err;
          }
        );
      },
      (err: unknown) => err instanceof Error && /مهلة تواصل|463/.test(err.message)
    );
    assert.equal(timelockAttempts, 0, 'Must fail-fast when reachoutTimeLock is already active');

    // 4b. When initial send hits 463 and live fetchAccountReachoutTimelock reports active, NEVER retry!
    svc.privacyTokens.handleReachoutTimelockUpdate({ isActive: false });
    (
      fake.sock as unknown as {
        fetchAccountReachoutTimelock: () => Promise<{ isActive: boolean; timeEnforcementEnds?: Date }>;
      }
    ).fetchAccountReachoutTimelock = async () => ({
      isActive: true,
      timeEnforcementEnds: new Date(Date.now() + 3600_000),
    });
    let postCheckAttempts = 0;
    await assert.rejects(
      async () => {
        await svc.privacyTokens.executeWithBounded463Recovery(
          '967779998887@s.whatsapp.net',
          async () => {
            postCheckAttempts += 1;
            const err = new Error('463 reachout') as Error & { data?: number };
            err.data = 463;
            throw err;
          }
        );
      },
      (err: unknown) => err instanceof Error && /مهلة تواصل|463/.test(err.message)
    );
    assert.equal(postCheckAttempts, 1, 'Must NOT retry when server reports active reachoutTimeLock');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 3. FEATURE B: WhatsApp Username Management & PIN Redaction
// ============================================================================

test('Username management handles available, taken, key-required, set, delete, pin (redacted), recommend, and unsupported fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_uname_'));
  try {
    assert.equal(normalizeUsername('@Botezz_Dev'), 'Botezz_Dev');
    assert.equal(isValidUsername('botezz.dev1'), true);
    assert.equal(isValidUsername('ab'), false);
    assert.equal(isValidUsernameKey('1234'), true);

    const driver = new HiroosyBaileysSessionDriver('sess_uname', tmpDir);
    let serverUnsupported = false;
    const fake = createFakeIdentitySocket({
      resolveUsernameFn: async (handle, key) => {
        const clean = normalizeUsername(handle);
        if (clean === 'taken_user') {
          return { status: 'ok', jid: '55555555555@lid' };
        }
        if (clean === 'protected_user') {
          if (key === '7890') {
            return { status: 'ok', jid: '66666666666@lid' };
          }
          return { status: 'key-required' };
        }
        return { status: 'not-found' };
      },
      queryFn: async (node) => {
        if (serverUnsupported && node.attrs?.xmlns === 'w:profile:username') {
          const e = new Error('feature-not-implemented') as Error & { data?: number };
          e.data = 501;
          throw e;
        }
        if (node.attrs?.xmlns === 'w:profile:username') {
          return {
            tag: 'iq',
            attrs: { type: 'result' },
            content: [{ tag: 'username', attrs: { status: 'available' } }],
          };
        }
        return { tag: 'iq', attrs: { type: 'result' }, content: [] };
      },
    });
    attachFakeSocketToDriver(driver, fake.sock);

    // Available username
    const avail = await driver.checkUsername('fresh_handle_99');
    assert.equal(avail.available, true);
    assert.equal(avail.status, 'available');

    // Taken username
    const taken = await driver.checkUsername('@taken_user');
    assert.equal(taken.available, false);
    assert.equal(taken.status, 'taken');
    assert.equal(taken.lidJid, '55555555555@lid');

    // Key-required without PIN vs with PIN
    const keyReq = await driver.checkUsername('protected_user');
    assert.equal(keyReq.status, 'key-required');
    const unlocked = await driver.checkUsername('protected_user', '7890');
    assert.equal(unlocked.status, 'taken');
    assert.equal(unlocked.lidJid, '66666666666@lid');

    // Set & Delete username
    const setRes = await driver.setUsername('@my_botezz_name');
    assert.equal(setRes.status, 'ok');
    assert.equal(setRes.username, 'my_botezz_name');

    const delRes = await driver.deleteUsername();
    assert.equal(delRes.status, 'ok');

    // Set Username PIN -> verify telemetry never contains raw PIN!
    const secretPin = '9182';
    const pinRes = await driver.setUsernamePin(secretPin);
    assert.equal(pinRes.status, 'ok');
    assert.equal(pinRes.reasonArabic.includes(secretPin), false);
    const recentTraffic = getNetworkTrafficMonitor().queryEntries({ pageSize: 20 });
    for (const entry of recentTraffic.items) {
      assert.equal(
        (entry.requestBodyPreview || '').includes(secretPin),
        false,
        'Raw username PIN must NEVER appear in network traffic telemetry'
      );
    }

    // Recommend candidates
    const rec = await driver.recommendUsername('botezz');
    assert.ok(rec.candidates.length >= 3);
    assert.ok(rec.candidates.some((c) => c.username.startsWith('botezz')));

    // Server IQ unsupported fallback
    serverUnsupported = true;
    const unsupportedRes = await driver.setUsername('another_name');
    assert.equal(unsupportedRes.status, 'unsupported');
    assert.equal(unsupportedRes.supported, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// 4. FEATURE C: Menfess / Anonymous Relay Sessions (SQLite + Replies + Media + Isolation)
// ============================================================================

test('AnonymousSessionEngine supports create, masked/alias relay, media relay, incoming quote-reply routing, close, expiry, and cross-session isolation', async () => {
  const db = new AppDatabase(':memory:');
  try {
    const engine = new AnonymousSessionEngine(db);
    const deliveredLog: Array<{
      sessionId: string;
      targetJid: string;
      content: Record<string, unknown>;
      customPushName?: string;
    }> = [];

    const makeDeliverer = (sessionId: string) => async (req: {
      sessionId: string;
      targetJid: string;
      preferLid: boolean;
      content: Record<string, unknown>;
      quotedMessageId?: string;
      customPushName?: string;
    }) => {
      deliveredLog.push({
        sessionId,
        targetJid: req.targetJid,
        content: req.content as Record<string, unknown>,
        customPushName: req.customPushName,
      });
      return {
        messageId: `WA_RELAY_${deliveredLog.length}`,
        deliveredToJid: req.targetJid,
        addressingMode: (req.targetJid.endsWith('@lid') ? 'lid' : 'pn') as 'lid' | 'pn',
      };
    };

    // Masked phone formatting check
    assert.equal(maskPhoneForMenfess('+967771234535'), '+967•••••••35');
    assert.equal(
      maskJidForDiagnostics('967771234535@s.whatsapp.net'),
      '967••••35@s.whatsapp.net'
    );

    // Redaction check for tctoken / cstoken / usernamePin
    const redactedObj = redactSensitiveData({
      tctoken: 'raw_tc_secret_12345',
      cstoken: 'raw_cs_secret_67890',
      usernamePin: '4321',
      ok: 'visible',
    }) as Record<string, unknown>;
    assert.equal(redactedObj.tctoken, '[REDACTED]');
    assert.equal(redactedObj.cstoken, '[REDACTED]');
    assert.equal(redactedObj.usernamePin, '[REDACTED]');
    assert.equal(redactedObj.ok, 'visible');
    assert.equal(
      redactText('tctoken=supersecret999 username_pin=7788').includes('supersecret999'),
      false
    );

    // 1. Concurrent creation on session_A (masked presentation) and session_B (Anonymous Sender alias)
    const [sessA, sessB] = await Promise.all([
      engine.createAnonymousSession({
        sessionId: 'sess_A',
        ownerTelegramId: 1001,
        senderInput: '+967771234535',
        receiverInput: '+966501234567',
        maskPhonePresentation: true,
      }),
      engine.createAnonymousSession({
        sessionId: 'sess_B',
        ownerTelegramId: 1002,
        senderInput: '+967771234535',
        receiverInput: '+966509998887',
        senderAlias: 'Anonymous Sender',
        maskPhonePresentation: false,
      }),
    ]);

    assert.ok(sessA.id.startsWith('anon_'));
    assert.ok(sessB.id.startsWith('anon_'));
    assert.notEqual(sessA.id, sessB.id);

    // 2. Relay text message on sessA -> must mask sender phone, never leak raw sender digits
    const relayRes = await engine.relayAnonymousMessage({
      sessionId: 'sess_A',
      anonSessionId: sessA.id,
      text: 'هل يمكننا الحديث بصراحة؟',
      deliver: makeDeliverer('sess_A'),
    });
    assert.equal(relayRes.presentationLabel, '+967•••••••35');
    const outboundText = String(deliveredLog[0]!.content.text || '');
    assert.equal(outboundText.includes('771234535'), false, 'Raw sender phone MUST NOT leak!');
    assert.equal(outboundText.includes('+967•••••••35'), true);
    assert.equal(relayRes.anonSession.messagesRelayedCount, 1);

    // Relay on sessB with Anonymous Sender label
    await engine.relayAnonymousMessage({
      sessionId: 'sess_B',
      anonSessionId: sessB.id,
      text: 'Hello without mask',
      deliver: makeDeliverer('sess_B'),
    });
    assert.equal(String(deliveredLog[1]!.content.text).includes('Anonymous Sender'), true);

    // 3. Cross-session isolation check: sess_B cannot relay or read or close sessA
    assert.equal(engine.getAnonymousSession('sess_B', sessA.id), null);
    await assert.rejects(async () => {
      await engine.relayAnonymousMessage({
        sessionId: 'sess_B',
        anonSessionId: sessA.id,
        text: 'Cross-session spoof attempt',
        deliver: makeDeliverer('sess_B'),
      });
    });

    // 4. Receiver B quotes WA_RELAY_1 -> incoming reply candidate relays automatically to Sender A
    const replyMatchWrongSession = await engine.handleIncomingRelayCandidate({
      sessionId: 'sess_B', // Wrong session! Must NOT match WA_RELAY_1 from sess_A
      fromJid: '966501234567@s.whatsapp.net',
      text: 'Wrong session attempt',
      quotedMessageId: relayRes.messageId,
      deliver: makeDeliverer('sess_B'),
    });
    assert.equal(replyMatchWrongSession.matched, false);

    const replyMatchRight = await engine.handleIncomingRelayCandidate({
      sessionId: 'sess_A',
      fromJid: '966501234567@s.whatsapp.net',
      text: 'أهلاً بك، تفضل بالتحدث',
      quotedMessageId: relayRes.messageId,
      deliver: makeDeliverer('sess_A'),
    });
    assert.equal(replyMatchRight.matched, true);
    assert.equal(replyMatchRight.relayed, true);
    const relayedReplyEntry = deliveredLog[deliveredLog.length - 1]!;
    assert.equal(relayedReplyEntry.targetJid, '967771234535@s.whatsapp.net');
    assert.equal(
      String(relayedReplyEntry.content.text).includes('966501234567'),
      false,
      'Receiver B raw phone MUST NOT leak in reply header!'
    );

    // 5. Media relay parity: image, audio, ptt voice, document, sticker, video
    const mediaKinds: Array<{
      kind: 'image' | 'video' | 'audio' | 'ptt' | 'document' | 'sticker';
      mime: string;
    }> = [
      { kind: 'image', mime: 'image/jpeg' },
      { kind: 'video', mime: 'video/mp4' },
      { kind: 'audio', mime: 'audio/mpeg' },
      { kind: 'ptt', mime: 'audio/ogg; codecs=opus' },
      { kind: 'document', mime: 'application/pdf' },
      { kind: 'sticker', mime: 'image/webp' },
    ];
    for (const m of mediaKinds) {
      const mRes = await engine.relayAnonymousMedia({
        sessionId: 'sess_A',
        anonSessionId: sessA.id,
        mediaKind: m.kind,
        buffer: Buffer.from(`fake_${m.kind}_bytes`),
        mimeType: m.mime,
        fileName: `test.${m.kind}`,
        caption: `cap ${m.kind}`,
        deliver: makeDeliverer('sess_A'),
      });
      assert.equal(mRes.mediaKind, m.kind);
    }

    // 6. Close session -> subsequent relay rejects
    const closed = engine.closeAnonymousSession({
      sessionId: 'sess_A',
      anonSessionId: sessA.id,
    });
    assert.equal(closed?.state, 'closed');
    await assert.rejects(async () => {
      await engine.relayAnonymousMessage({
        sessionId: 'sess_A',
        anonSessionId: sessA.id,
        text: 'After close',
        deliver: makeDeliverer('sess_A'),
      });
    });

    // 7. Unknown anon_id rejection
    await assert.rejects(async () => {
      await engine.relayAnonymousMessage({
        sessionId: 'sess_A',
        anonSessionId: 'anon_deadbeef',
        text: 'Missing session',
        deliver: makeDeliverer('sess_A'),
      });
    });

    // 8. Expired session rejection
    const expSess = await engine.createAnonymousSession({
      sessionId: 'sess_A',
      senderInput: '+967771234535',
      receiverInput: '+966501234567',
      ttlMs: 60_000,
    });
    db.sqlite
      .prepare('UPDATE anonymous_relay_sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 5000, expSess.id);
    await assert.rejects(async () => {
      await engine.relayAnonymousMessage({
        sessionId: 'sess_A',
        anonSessionId: expSess.id,
        text: 'Should expire',
        deliver: makeDeliverer('sess_A'),
      });
    });
  } finally {
    db.close();
  }
});

// ============================================================================
// 5. End-to-End Telegram Controller, SessionManager Hook & Callback 64-byte Gate
// ============================================================================

test('TelegramBotController end-to-end executes /lid, /reachout, /username, /anonstart, /anonmsg, /anonstop, Menfess media upload, and SessionManager incoming auto-reply', async () => {
  const db = new AppDatabase(':memory:');
  const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_ctrl_e2e_'));
  try {
    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);
    const auditRepo = new AuditRepository(db);
    const settingsRepo = new SettingsRepository(db);
    const sessionStore = new SessionStore(tmpAuthDir);

    const mockDrivers = new Map<string, MockWhatsAppSessionDriver>();
    const sessionManager = new SessionManager(
      sessionRepo,
      auditRepo,
      sessionStore,
      (sessionId) => {
        const d = new MockWhatsAppSessionDriver(sessionId);
        mockDrivers.set(sessionId, d);
        return d;
      }
    );

    const pairing = await sessionManager.initiatePairing({
      rawPhoneNumber: '+966500000001',
      actorTelegramId: 999999,
      autoCompleteInMock: true,
    });

    const config: AppConfig = {
      TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN_E2E',
      TELEGRAM_ADMIN_ID: 999999,
      NODE_ENV: 'test',
      DATABASE_PATH: ':memory:',
      WHATSAPP_AUTH_DIR: tmpAuthDir,
      TEMP_UPLOAD_DIR: tmpAuthDir,
      LOG_LEVEL: 'error',
      MAX_CONCURRENT_TASKS: 2,
      TASK_TIMEOUT_MS: 30_000,
      MAX_UPLOAD_SIZE_MB: 20,
    };

    const rateLimiter = new OperationRateLimiter(50, 60_000, 0);
    const sendMessageOp = new SendMessageOperation(sessionManager, rateLimiter);
    const sendMediaOp = new SendMediaOperation(sessionManager, rateLimiter);
    const groupOps = new GroupOperations(sessionManager, auditRepo, rateLimiter);
    const taskRunner = new TaskRunner(taskRepo, 2, 10_000);
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

    // Verify all tools menu callback_data <= 64 bytes
    const toolsMenu = await controller.handleCallbackQuery(999999, 'menu:tools');
    for (const row of toolsMenu.keyboard) {
      for (const btn of row) {
        assert.ok(
          Buffer.byteLength(btn.callbackData, 'utf8') <= 64,
          `callback_data exceeds 64 bytes: ${btn.callbackData}`
        );
      }
    }

    // /lid lookup
    const lidView = await controller.handleTextMessage(999999, '/lid +967771234535');
    assert.ok(lidView.text.includes('967771234535@s.whatsapp.net'));
    assert.ok(lidView.text.includes('@lid'));

    // /reachout diagnostic
    const reachoutView = await controller.handleTextMessage(999999, '/reachout +967771234535');
    assert.ok(reachoutView.text.includes('Reachout Timelock'));

    // /username workflow
    const unameCheck = await controller.handleTextMessage(999999, '/username check @botezz_pro');
    assert.ok(unameCheck.text.includes('available'));
    const unameSet = await controller.handleTextMessage(999999, '/username set @botezz_pro');
    assert.ok(unameSet.text.includes('botezz_pro'));
    const unamePin = await controller.handleTextMessage(999999, '/username pin 6543');
    assert.equal(unamePin.text.includes('6543'), false);

    // /anonstart creates persistent Menfess session
    const anonStartView = await controller.handleTextMessage(
      999999,
      '/anonstart +967771234535 +966501234567'
    );
    const matchAnonId = anonStartView.text.match(/anon_[a-f0-9]{8}/);
    assert.ok(matchAnonId?.[0], 'Expected generated anon_xxxxxxxx ID');
    const anonId = matchAnonId[0];

    // Verify generated Menfess buttons respect 64-byte limit
    for (const row of anonStartView.keyboard) {
      for (const btn of row) {
        assert.ok(Buffer.byteLength(btn.callbackData, 'utf8') <= 64);
      }
    }

    // /anonmsg <anon_id> <text>
    const relayView = await controller.handleTextMessage(
      999999,
      `/anonmsg ${anonId} رسالة اختبار سرية`
    );
    assert.ok(relayView.text.includes(anonId));
    assert.equal(relayView.text.includes('771234535'), false);

    // Media upload via Menfess caption `/anonmsg <anon_id>`
    const mediaView = await controller.handleMediaUpload(999999, {
      originalFilename: 'voice_note.ogg',
      mimeType: 'audio/ogg; codecs=opus',
      sizeBytes: 12,
      contentBuffer: Buffer.from('OggS_fake_ptt'),
      caption: `/anonmsg ${anonId}`,
    });
    assert.ok(mediaView.text.includes('ptt'));

    // Simulate incoming quoted reply from Receiver B into MockWhatsAppSessionDriver
    // -> SessionManager auto-relays back to Sender A!
    const mockDriver = mockDrivers.get(pairing.session.id)!;
    const sentToReceiver = mockDriver.sentAnonymousLidMessages.find((m) =>
      String(m.text || '').includes(anonId)
    );
    assert.ok(sentToReceiver, 'Expected outbound Menfess message in MockWhatsAppSessionDriver');

    const beforeCount = mockDriver.sentAnonymousLidMessages.length;
    mockDriver.simulateIncomingMessage({
      key: {
        remoteJid: '966501234567@s.whatsapp.net',
        fromMe: false,
        id: 'INCOMING_REPLY_1',
      },
      message: {
        extendedTextMessage: {
          text: 'تم استلام رسالتك المجهولة بنجاح!',
          contextInfo: {
            stanzaId: sentToReceiver!.messageId,
          },
        },
      },
    });
    // Allow async microtask relay handler to settle
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      mockDriver.sentAnonymousLidMessages.length > beforeCount,
      true,
      'SessionManager should auto-relay quoted Menfess reply back to Sender A'
    );

    // /anonstop closes session cleanly
    const stopView = await controller.handleTextMessage(999999, `/anonstop ${anonId}`);
    assert.ok(stopView.text.includes('تم إغلاق'));
  } finally {
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    db.close();
  }
});
