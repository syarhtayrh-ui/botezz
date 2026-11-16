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
  extractAddressingContext,
  storeTcTokensFromNode,
  buildTcTokenNodeForJid,
  USERNAME_QUERY_IDS,
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
  driver.attachSocketForTesting(sock);
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
    assert.equal(sent.opts?.addressingMode, undefined);
    assert.equal(
      (sent.opts?.additionalAttributes as { addressing_mode?: string } | undefined)?.addressing_mode,
      undefined
    );
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
    assert.equal(
      (fake.relayedMessages[0]!.opts?.additionalAttributes as { addressing_mode?: string } | undefined)?.addressing_mode,
      undefined
    );
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

    // =========================================================================
    // Unified Interactive "Anonymous Chat Session" Room (`🕵️ جلسة مجهولة`) E2E
    // =========================================================================
    const allToolsButtons = toolsMenu.keyboard.flat().map((b) => b.callbackData);
    assert.ok(
      allToolsButtons.includes('menu:anon_sessions'),
      'Tools menu should include unified menu:anon_sessions button'
    );
    assert.equal(
      allToolsButtons.includes('tools:prompt_lid_lookup'),
      false,
      'Scattered tools:prompt_lid_lookup button should be replaced by unified room button'
    );

    // 1. Open Screen 1 (Sessions Hub)
    const hubView1 = await controller.handleCallbackQuery(
      999999,
      'menu:anon_sessions'
    );
    assert.ok(hubView1.text.includes('غرفة الجلسات المجهولة الموحدة'));

    // 2. Tap `➕ إضافة جلسة مجهولة جديدة` (`anon:add_prompt`) -> Screen 2
    const addPromptView = await controller.handleCallbackQuery(
      999999,
      'anon:add_prompt'
    );
    assert.ok(addPromptView.text.includes('بدء جلسة تواصل مجهولة جديدة'));
    assert.equal(controller.toolsHandler.getStep(999999), 'ANON_AWAITING_TARGET');

    // 3. Enter recipient phone number -> creates session and transitions straight into Screen 3 (`ANON_IN_ROOM`)
    const roomView1 = await controller.handleTextMessage(
      999999,
      '+967771234535'
    );
    assert.ok(roomView1.text.includes('غرفة المحادثة المجهولة الحية'));
    assert.ok(roomView1.text.includes('967771234535@s.whatsapp.net'));
    assert.ok(roomView1.text.includes('@lid'));
    assert.equal(controller.toolsHandler.getStep(999999), 'ANON_IN_ROOM');

    const activeRoomId = controller.toolsHandler.getActiveAnonRoom(999999);
    assert.ok(activeRoomId, 'Expected active room ID in ANON_IN_ROOM');

    // 4. Send outbound message directly inside the room (no command needed!)
    const roomView2 = await controller.handleTextMessage(
      999999,
      'مرحباً، كيف حالك من الجلسة المجهولة؟'
    );
    assert.equal(
      controller.toolsHandler.getStep(999999),
      'ANON_IN_ROOM',
      'User must remain in ANON_IN_ROOM after sending a message'
    );
    assert.ok(roomView2.text.includes('مرحباً، كيف حالك من الجلسة المجهولة؟'));
    assert.ok(roomView2.text.includes('أنت'));

    // 5. Simulate incoming reply from recipient's `@lid` JID (unquoted!) -> should match room and update live transcript!
    const roomSess = controller.toolsHandler.anonymousEngine.getAnonymousSessionById(
      activeRoomId!
    )!;
    assert.ok(roomSess.receiverLidJid, 'Expected resolved receiverLidJid on room session');

    let liveUpdateCount = 0;
    controller.onAnonRoomLiveUpdate = () => {
      liveUpdateCount++;
    };

    mockDriver.simulateIncomingMessage({
      key: {
        remoteJid: roomSess.receiverLidJid,
        fromMe: false,
        id: 'INCOMING_LID_ROOM_REPLY_1',
      },
      message: {
        conversation: 'أهلاً! وصلتني رسالتك عبر الهوية المجهولة.',
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(liveUpdateCount >= 1, true, 'Expected live room update on incoming @lid reply');

    // Refresh room view (`anon:room:<id>`) and verify both outbound and inbound messages appear in transcript
    const refreshedRoom = await controller.handleCallbackQuery(
      999999,
      `anon:room:${activeRoomId}`
    );
    assert.ok(refreshedRoom.text.includes('مرحباً، كيف حالك من الجلسة المجهولة؟'));
    assert.ok(refreshedRoom.text.includes('أهلاً! وصلتني رسالتك عبر الهوية المجهولة.'));
    assert.ok(refreshedRoom.text.includes('المستلم'));

    // 6. Simulate incoming reply from recipient's `@s.whatsapp.net` PN JID -> should also match the same room!
    mockDriver.simulateIncomingMessage({
      key: {
        remoteJid: '967771234535@s.whatsapp.net',
        fromMe: false,
        id: 'INCOMING_PN_ROOM_REPLY_2',
      },
      message: {
        conversation: 'وهذا رد ثانٍ من رقم الهاتف مباشرة.',
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const refreshedRoom2 = await controller.handleCallbackQuery(
      999999,
      `anon:room:${activeRoomId}`
    );
    assert.ok(refreshedRoom2.text.includes('وهذا رد ثانٍ من رقم الهاتف مباشرة.'));

    // 7. Exit room (`anon:exit_room`) -> returns to Screen 1 (`menu:anon_sessions`) and clears active input
    const exitedView = await controller.handleCallbackQuery(
      999999,
      'anon:exit_room'
    );
    assert.ok(exitedView.text.includes('تم الخروج من غرفة المحادثة'));
    assert.equal(controller.toolsHandler.getStep(999999), 'NONE');
    assert.equal(controller.toolsHandler.getActiveAnonRoom(999999), undefined);

    // 8. Delete room (`anon:del:<id>`) -> removes room cleanly
    const deletedView = await controller.handleCallbackQuery(
      999999,
      `anon:del:${activeRoomId}`
    );
    assert.ok(deletedView.text.includes('تم إنهاء وحذف الجلسة المجهولة'));
    assert.equal(
      controller.toolsHandler.anonymousEngine.getAnonymousSessionById(activeRoomId!),
      null
    );
  } finally {
    fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    db.close();
  }
});

test('extractAddressingContext, storeTcTokensFromNode, and buildTcTokenNodeForJid follow official WhiskeySockets/Baileys stanza semantics', async () => {
  assert.equal(typeof HiroosyBaileysSessionDriver, 'function');
  assert.equal(USERNAME_QUERY_IDS.CHECK, '26124072630599520');
  assert.equal(USERNAME_QUERY_IDS.SET, '27108705368767936');

  // 1. extractAddressingContext on LID-addressed incoming DM stanza
  const lidStanza: BinaryNode = {
    tag: 'message',
    attrs: {
      id: 'MSG_LID_1',
      from: '123456789012345@lid',
      sender_pn: '967771234535@s.whatsapp.net',
      recipient_pn: '966500000001@s.whatsapp.net',
    },
  };
  const ctxLid = extractAddressingContext(lidStanza);
  assert.equal(ctxLid.addressingMode, 'lid');
  assert.equal(ctxLid.senderAlt, '967771234535@s.whatsapp.net');
  assert.equal(ctxLid.recipientAlt, '966500000001@s.whatsapp.net');

  // 2. extractAddressingContext on PN-addressed incoming DM stanza
  const pnStanza: BinaryNode = {
    tag: 'message',
    attrs: {
      id: 'MSG_PN_1',
      from: '967771234535@s.whatsapp.net',
      sender_lid: '123456789012345@lid',
      recipient_lid: '99887766554433@lid',
    },
  };
  const ctxPn = extractAddressingContext(pnStanza);
  assert.equal(ctxPn.addressingMode, 'pn');
  assert.equal(ctxPn.senderAlt, '123456789012345@lid');
  assert.equal(ctxPn.recipientAlt, '99887766554433@lid');

  // 3. storeTcTokensFromNode + buildTcTokenNodeForJid with <notification type="privacy_token">
  const tokenStore = new Map<string, unknown>();
  const authStateKeys = {
    get: async (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      if (type === 'tctoken') {
        for (const id of ids) {
          if (tokenStore.has(id)) out[id] = tokenStore.get(id);
        }
      }
      return out;
    },
    set: async (data: Record<string, Record<string, unknown>>) => {
      if (data.tctoken) {
        for (const [k, v] of Object.entries(data.tctoken)) {
          tokenStore.set(k, v);
        }
      }
    },
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const rawTokenBytes = Buffer.from('baileys_trusted_contact_token_bytes');
  const notificationNode: BinaryNode = {
    tag: 'notification',
    attrs: {
      type: 'privacy_token',
      from: '967771234535@s.whatsapp.net',
      sender_lid: '123456789012345@lid',
    },
    content: [
      {
        tag: 'tokens',
        attrs: {},
        content: [
          {
            tag: 'token',
            attrs: {
              type: 'trusted_contact',
              t: String(nowSec),
            },
            content: rawTokenBytes,
          },
        ],
      },
    ],
  };

  const storedCount = await storeTcTokensFromNode({
    node: notificationNode,
    authStateKeys,
    getLIDForPN: (pn) =>
      pn.startsWith('967771234535') ? '123456789012345@lid' : undefined,
  });
  assert.equal(storedCount, 1);
  assert.equal(tokenStore.has('123456789012345@lid'), true);

  // Building tctoken node for PN JID resolves to bare LID JID and attaches attrs.t + binary content
  const { tcTokenNode: tcNode } = await buildTcTokenNodeForJid({
    jid: '967771234535@s.whatsapp.net',
    authStateKeys,
    getLIDForPN: (pn) =>
      pn.startsWith('967771234535') ? '123456789012345@lid' : undefined,
  });
  assert.ok(tcNode, 'Expected non-null <tctoken> BinaryNode');
  assert.equal(tcNode!.tag, 'tctoken');
  assert.equal(tcNode!.attrs?.t, String(nowSec));
  assert.deepEqual(Buffer.from(tcNode!.content as Uint8Array), rawTokenBytes);
});

// ============================================================================
// 7. ANONYMOUS GHOST ROOM PROTOCOL DELIVERY, ACK VERIFICATION, & DUAL-PATH FAILOVER
// ============================================================================

test('Zero-byte tctoken protection & 1-to-1 stanza attribute hygiene in sendAnonymousLidMessage', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_zero_tc_'));
  try {
    const driver = new HiroosyBaileysSessionDriver('sess_zero_tc', tmpDir);
    const fake = createFakeIdentitySocket({
      // Simulate issuePrivacyTokens returning an empty/no-token IQ response
      issuePrivacyTokensFn: async () => ({
        tag: 'iq',
        attrs: { type: 'result' },
        content: [],
      }),
    });
    attachFakeSocketToDriver(driver, fake.sock);
    const svc = driver.getIdentityService();

    // 1. ensurePrivacyToken must NOT write Buffer.alloc(0) into authState.keys.tctoken
    await svc.privacyTokens.ensurePrivacyToken('967771234535@s.whatsapp.net', {
      forceRefresh: true,
    });
    const storedAfterEmptyIssue = await fake.sock.authState.keys.get('tctoken', [
      '77771111222233@lid',
      '967771234535@s.whatsapp.net',
    ]);
    for (const val of Object.values(storedAfterEmptyIssue)) {
      if (val && typeof val === 'object' && 'token' in val && val.token) {
        assert.ok(
          Buffer.from(val.token as Uint8Array).byteLength > 0,
          'authState.keys.tctoken must never store a 0-byte Buffer'
        );
      }
    }

    // 2. If a corrupted 0-byte token was previously persisted on disk, getValidPrivacyToken cleans it up
    await fake.sock.authState.keys.set({
      tctoken: {
        '77771111222233@lid': {
          token: Buffer.alloc(0),
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      },
    });
    const checkZero = await svc.privacyTokens.getValidPrivacyToken('77771111222233@lid');
    assert.equal(checkZero?.hasToken, false);

    // 3. Pure @lid send (when no fallbackPnJid is provided) never attaches a 0-byte <tctoken> node and never sets addressing_mode="lid" on 1-to-1 stanzas
    const sendRes = await driver.sendAnonymousLidMessage({
      recipient: '77771111222233@lid',
      text: 'Ghost message without 0-byte tctoken',
      customPushName: 'Ghost Alias',
      ghostHeaderMode: 'plain',
    });
    assert.equal(sendRes.deliveredJid, '77771111222233@lid');
    assert.equal(sendRes.usedLid, true);
    assert.equal(fake.sentMessages.length, 1);

    const sentOpts = fake.sentMessages[0]!.opts;
    assert.equal(sentOpts?.addressingMode, undefined);
    assert.equal(
      (sentOpts?.additionalAttributes as { addressing_mode?: string } | undefined)?.addressing_mode,
      undefined
    );
    const additionalNodes = (sentOpts?.additionalNodes as BinaryNode[] | undefined) || [];
    assert.equal(
      additionalNodes.some((n) => n.tag === 'tctoken'),
      false,
      'Must not attach 0-byte <tctoken> node'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sendAnonymousLidMessage @lid-first priority, lidDeviceJids pre-assertion (force=false), userJid=selfLid, strict allowPnFallback=false protection, and flexible allowPnFallback=true failover', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_forensic_anon_'));
  try {
    const driver = new HiroosyBaileysSessionDriver('sess_forensic_anon', tmpDir);
    const fake = createFakeIdentitySocket({
      usyncFn: async () => ({
        list: [
          {
            id: '60124505955@s.whatsapp.net',
            contact: true,
            lid: '130804101468269@lid',
            devices: {
              deviceList: [{ id: 0 }, { id: 2 }],
            },
          } as unknown as { id?: string; lid?: string },
        ],
      }),
    });
    const wsEmitter = new EventEmitter();
    (fake.sock as unknown as { ws: EventEmitter; __ackVerifyTimeoutMs?: number }).ws =
      wsEmitter;
    (
      fake.sock as unknown as { __ackVerifyTimeoutMs?: number }
    ).__ackVerifyTimeoutMs = 250;

    let cachedBeforeAckResolved = false;
    let cachedCrossJidLookupBeforeAck = false;
    let migrateSessionCalled = false;
    let updatedProfileName: string | undefined;
    const assertSessionsCalls: Array<{ jids: string[]; force?: boolean }> = [];

    (
      fake.sock.signalRepository as unknown as {
        migrateSession: () => Promise<void>;
      }
    ).migrateSession = async () => {
      migrateSessionCalled = true;
    };

    (
      fake.sock as unknown as {
        assertSessions: (jids: string[], force?: boolean) => Promise<boolean>;
        updateProfileName: (name: string) => Promise<void>;
      }
    ).assertSessions = async (jids: string[], force?: boolean) => {
      assertSessionsCalls.push({ jids, force });
      return false; // false means session already exists locally!
    };
    (
      fake.sock as unknown as {
        updateProfileName: (name: string) => Promise<void>;
      }
    ).updateProfileName = async (name: string) => {
      updatedProfileName = name;
    };

    const origSendMessage = fake.sock.sendMessage.bind(fake.sock);
    (fake.sock as unknown as { sendMessage: typeof origSendMessage }).sendMessage =
      async (jid, content, opts) => {
        const sent = await origSendMessage(jid, content, opts);
        const msgId = sent?.key?.id || 'msg_forensic_1';
        setTimeout(() => {
          const msgByExactLid = driver.memoryStore.getMessage({
            remoteJid: '130804101468269@lid',
            id: msgId,
          });
          const msgByPnDeviceJid = driver.memoryStore.getMessage({
            remoteJid: '60124505955:0@s.whatsapp.net',
            id: msgId,
          });
          const msgByPureLidRetry = driver.memoryStore.getMessage({
            remoteJid: '130804101468269:2@lid',
            id: msgId,
          });
          cachedBeforeAckResolved = Boolean(msgByExactLid);
          cachedCrossJidLookupBeforeAck = Boolean(
            msgByPnDeviceJid && msgByPureLidRetry
          );
          wsEmitter.emit('CB:ack,class:message', {
            tag: 'ack',
            attrs: { class: 'message', id: msgId },
          });
        }, 15);
        return sent;
      };

    attachFakeSocketToDriver(driver, fake.sock);

    // 1. When both pnJid (60124505955@s.whatsapp.net) and lidJid (130804101468269@lid) are resolved,
    // sendAnonymousLidMessage MUST dispatch to 130804101468269@lid (usedLid: true) FIRST!
    const res = await driver.sendAnonymousLidMessage({
      recipient: '+60124505955',
      fallbackPnJid: '60124505955@s.whatsapp.net',
      text: 'رسالة شبح عبر @lid أولاً',
      customPushName: '🕵️ جلسة مجهولة',
      ghostHeaderMode: 'plain',
      allowPnFallback: false,
    });

    assert.equal(res.targetLid, '130804101468269@lid');
    assert.equal(res.deliveredJid, '130804101468269@lid');
    assert.equal(res.resolvedPn, '60124505955@s.whatsapp.net');
    assert.equal(res.usedLid, true);
    assert.equal(res.ackVerified, true);
    assert.equal(res.fallbackTriggered, false);
    assert.equal(updatedProfileName, '🕵️ جلسة مجهولة');
    assert.equal(
      migrateSessionCalled,
      false,
      'sendAnonymousLidMessage must NEVER call migrateSession(pnJid, lidJid)'
    );
    assert.equal(
      assertSessionsCalls.length,
      1,
      'sendAnonymousLidMessage must pre-assert @lid device sessions once'
    );
    assert.deepEqual(assertSessionsCalls[0]!.jids, [
      '130804101468269@lid',
      '130804101468269:2@lid',
    ]);
    assert.equal(
      assertSessionsCalls[0]!.force,
      false,
      'sendAnonymousLidMessage must call assertSessions(lidDeviceJids, false) with force = false'
    );
    assert.equal(
      cachedBeforeAckResolved,
      true,
      'Outgoing message must be cached in memoryStore BEFORE waitForServerMessageAck finishes'
    );
    assert.equal(
      cachedCrossJidLookupBeforeAck,
      true,
      'SessionMemoryStore.getMessage must return the cached message by key.id regardless of retry remoteJid'
    );
    assert.equal(fake.sentMessages.length, 1);
    assert.equal(fake.sentMessages[0]!.jid, '130804101468269@lid');
    assert.deepEqual(fake.sentMessages[0]!.content, {
      text: 'رسالة شبح عبر @lid أولاً',
    });
    assert.equal(
      (fake.sentMessages[0]!.opts as { userJid?: string } | undefined)?.userJid,
      '10000000000001@lid',
      'Outbound @lid message must pass selfLid as userJid'
    );

    // 2. When allowPnFallback is false (default in Strict Ghost Mode) and server returns ACK error 479 on @lid,
    // sendAnonymousLidMessage MUST throw and NEVER fall back to @s.whatsapp.net
    const driverStrict = new HiroosyBaileysSessionDriver('sess_strict_lid', tmpDir);
    const fakeStrict = createFakeIdentitySocket();
    const strictWs = new EventEmitter();
    (fakeStrict.sock as unknown as { ws: EventEmitter }).ws = strictWs;
    const origStrictSend = fakeStrict.sock.sendMessage.bind(fakeStrict.sock);
    (
      fakeStrict.sock as unknown as { sendMessage: typeof origStrictSend }
    ).sendMessage = async (jid, content, opts) => {
      const sent = await origStrictSend(jid, content, opts);
      const msgId = sent?.key?.id || 'msg_strict_1';
      setImmediate(() => {
        strictWs.emit('CB:ack,class:message', {
          tag: 'ack',
          attrs: { class: 'message', id: msgId, error: '479' },
        });
      });
      return sent;
    };
    attachFakeSocketToDriver(driverStrict, fakeStrict.sock);

    await assert.rejects(
      () =>
        driverStrict.sendAnonymousLidMessage({
          recipient: '77771111222233@lid',
          fallbackPnJid: '967771234535@s.whatsapp.net',
          text: 'Strict Ghost Mode blocks PN fallback',
          allowPnFallback: false,
        }),
      /رفض خادم واتساب إرسال الرسالة عبر الهوية المقنّعة/
    );
    assert.equal(
      fakeStrict.sentMessages.length,
      1,
      'Strict mode must never send a second message to @s.whatsapp.net'
    );
    assert.equal(fakeStrict.sentMessages[0]!.jid, '77771111222233@lid');

    // 3. When allowPnFallback is true (Flexible Mode) and @lid returns ACK error 479, it falls back to @s.whatsapp.net
    const resFlex = await driverStrict.sendAnonymousLidMessage({
      recipient: '77771111222233@lid',
      fallbackPnJid: '967771234535@s.whatsapp.net',
      text: 'Flexible Mode allows PN fallback',
      allowPnFallback: true,
    });
    assert.equal(resFlex.usedLid, false);
    assert.equal(resFlex.fallbackTriggered, true);
    assert.equal(resFlex.deliveredJid, '967771234535@s.whatsapp.net');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('End-to-End Anonymous Room: phone + LID storage, outbound text & media in ANON_IN_ROOM, and incoming remoteJidAlt / senderPn / media reply matching', async () => {
  const db = new AppDatabase(':memory:');
  const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botezz_anon_room_e2e_'));
  try {
    const adminId = 999999;
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
      actorTelegramId: adminId,
      autoCompleteInMock: true,
    });
    const driver = mockDrivers.get(pairing.session.id)!;

    const config: AppConfig = {
      TELEGRAM_BOT_TOKEN: '123456:TESTTOKEN_ROOM_E2E',
      TELEGRAM_ADMIN_ID: adminId,
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

    const bot = new TelegramBotController({
      config,
      sessionManager,
      taskManager,
      sendMessageOp,
      sendMediaOp,
      groupOps,
      auditRepo,
      settingsRepo,
    });

    // 1. Create room with phone number -> stores both receiverJid (@s.whatsapp.net) and receiverLidJid (@lid)
    const createPrompt = await bot.handleCallbackQuery(adminId, 'anon:add_prompt');
    assert.ok(createPrompt.text.includes('بدء جلسة تواصل مجهولة جديدة'));

    const roomCreatedView = await bot.handleTextMessage(adminId, '+967771234535');
    assert.ok(roomCreatedView.text.includes('غرفة المحادثة المجهولة الحية'));

    const activeRoomId = bot.toolsHandler.getActiveAnonRoom(adminId);
    assert.ok(activeRoomId, 'Expected admin to be inside active anonymous room');

    const storedSess = bot.toolsHandler.anonymousEngine.getAnonymousSessionById(
      activeRoomId!
    );
    assert.ok(storedSess);
    assert.equal(storedSess!.receiverJid, '967771234535@s.whatsapp.net');
    assert.ok(
      storedSess!.receiverLidJid && storedSess!.receiverLidJid.endsWith('@lid'),
      'Expected receiverLidJid to be stored alongside receiverJid'
    );

    // 2. Send text message while in ANON_IN_ROOM
    const afterTextView = await bot.handleTextMessage(
      adminId,
      'مرحباً من داخل غرفة الشبح'
    );
    assert.ok(afterTextView.text.includes('مرحباً من داخل غرفة الشبح'));
    assert.equal(driver.sentAnonymousLidMessages.length, 1);
    assert.equal(
      driver.sentAnonymousLidMessages[0]!.resolvedPn,
      '967771234535@s.whatsapp.net'
    );

    // 3. Upload photo media while in ANON_IN_ROOM -> routed to sendAnonymousRoomMedia
    const afterMediaView = await bot.handleMediaUpload(adminId, {
      originalFilename: 'secret_photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 15,
      contentBuffer: Buffer.from('fake_jpeg_bytes'),
      caption: 'صورة سرية',
      telegramMediaKind: 'photo',
    });
    assert.ok(afterMediaView.text.includes('📷'));
    assert.equal(driver.sentAnonymousLidMessages.length, 2);

    // 4. Incoming WhatsApp reply carrying remoteJid (@s.whatsapp.net) + senderLid / remoteJidAlt (@lid) + audio ptt media
    let liveUpdatedText = '';
    bot.onAnonRoomLiveUpdate = async (_adminId, view) => {
      liveUpdatedText = view.text;
    };

    (
      bot as unknown as {
        handleIncomingAnonRoomMessage: (
          sessionId: string,
          rawMessage: Record<string, unknown>
        ) => void;
      }
    ).handleIncomingAnonRoomMessage(pairing.session.id, {
      key: {
        id: 'INCOMING_REPLY_1',
        fromMe: false,
        remoteJid: '967771234535@s.whatsapp.net',
        remoteJidAlt: '88889999000011@lid',
        senderPn: '967771234535@s.whatsapp.net',
        senderLid: '88889999000011@lid',
      },
      message: {
        audioMessage: {
          ptt: true,
        },
      },
    });

    assert.ok(
      liveUpdatedText.includes('🎤') && liveUpdatedText.includes('رسالة صوتية واردة'),
      'Expected incoming voice note reply to be recorded and rendered in room transcript'
    );

    const updatedSess = bot.toolsHandler.anonymousEngine.getAnonymousSessionById(
      activeRoomId!
    );
    assert.equal(updatedSess?.receiverLidJid, '88889999000011@lid');
    assert.equal(
      driver.memoryStore.getLidForPn('967771234535@s.whatsapp.net'),
      '88889999000011@lid',
      'Expected incoming message PN<->LID pair to sync into driver memoryStore'
    );
  } finally {
    await sessionManagerCloseSafe(db, tmpAuthDir);
  }
});

async function sessionManagerCloseSafe(db: AppDatabase, tmpDir: string): Promise<void> {
  try {
    db.close();
  } catch {
    // Ignore
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}



