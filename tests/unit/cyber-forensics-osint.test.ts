import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CyberForensicsOsintEngine,
  parseAndNormalizePhoneInput,
} from '../../src/security/cyber-forensics-osint-engine';
import {
  CyberForensicsHandler,
  escapeTelegramLegacyMarkdown,
  sanitizeMarkdownUrl,
  mdLink,
  truncateSafeTelegramMarkdown,
} from '../../src/bot/handlers/cyber-forensics';
import { buildCyberForensicsMenuKeyboard } from '../../src/bot/keyboards/main-menu';
import { isNavigableRoute } from '../../src/bot/ui-state';
import type { SettingsRepository } from '../../src/database/repositories/settings-repository';
import type { SessionManager } from '../../src/whatsapp/session-manager';

function createMockSettingsRepo(): SettingsRepository {
  const store = new Map<string, string>();
  return {
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, val: string) => {
      store.set(key, val);
    },
  } as unknown as SettingsRepository;
}

describe('Cyber Forensics & OSINT End-to-End Overhaul', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes Yemeni and Saudi phone numbers and infers carrier metadata', () => {
    const yemen = parseAndNormalizePhoneInput('775224395');
    assert.equal(yemen.e164, '+967775224395');
    assert.equal(yemen.countryCode, '967');
    assert.equal(yemen.isoCountry2, 'YE');
    assert.ok(yemen.inferredCarrier.includes('Yemen Mobile'));
    assert.equal(yemen.isValidLength, true);

    const saudi = parseAndNormalizePhoneInput('0501234567');
    assert.equal(saudi.e164, '+966501234567');
    assert.equal(saudi.countryCode, '966');
    assert.equal(saudi.isoCountry2, 'SA');
    assert.equal(saudi.isValidLength, true);
  });

  it('escapes Telegram legacy Markdown and percent-encodes parentheses in URLs', () => {
    assert.equal(
      escapeTelegramLegacyMarkdown('Ahmed_Al*Mansoor [Admin] `dev`'),
      'Ahmed Al Mansoor Admin dev'
    );

    const dorkUrl =
      'https://www.google.com/search?q=site:facebook.com%20("%2B967775224395"%20OR%20"775224395")';
    const sanitized = sanitizeMarkdownUrl(dorkUrl);
    assert.equal(sanitized.includes('('), false);
    assert.equal(sanitized.includes(')'), false);
    assert.equal(sanitized.includes('%28'), true);
    assert.equal(sanitized.includes('%29'), true);

    const link = mdLink('Facebook (فيسبوك)', dorkUrl);
    assert.equal(
      link,
      '[Facebook (فيسبوك)](https://www.google.com/search?q=site:facebook.com%20%28"%2B967775224395"%20OR%20"775224395"%29)'
    );

    const longText = Array.from(
      { length: 120 },
      (_, i) => `• Line ${i + 1}: [Link](https://example.com/${i})`
    ).join('\n');
    const truncated = truncateSafeTelegramMarkdown(longText, 1000);
    assert.ok(truncated.length <= 1000);
    assert.ok(truncated.includes('تم اختصار العرض لحجم الرسالة'));
  });

  it('passes actorTelegramId (adminId) to SessionManager.listSessions and invokes driver.fetchFullProfileInfo', async () => {
    const settingsRepo = createMockSettingsRepo();
    const fakePhotoBuffer = Buffer.from('fake-jpeg-bytes');

    let fetchedTarget: string | undefined;
    const fetchFullProfileInfo = async (target: string) => {
      fetchedTarget = target;
      return {
        existsOnWhatsApp: true,
        pnJid: '967775224395@s.whatsapp.net',
        lidJid: '73139551780998@lid',
        pushName: 'Eng_Syarh',
        verifiedName: 'Botezz Security Lab',
        statusText: 'Available 24/7',
        statusSetAt: '2026-11-15T10:00:00.000Z',
        presence: {
          status: 'available',
          lastSeen: 1763350000000,
        },
        disappearingMode: {
          durationSeconds: 86400,
        },
        devices: [
          { deviceId: 0, isPrimary: true },
          { deviceId: 2, isPrimary: false },
        ],
        businessProfile: {
          description: 'Cyber Forensics & VoIP Systems',
          category: 'Technology',
          email: 'security@botezz.org',
          websites: ['https://github.com/syarhtayrh-ui'],
          address: 'Sanaa, Yemen',
        },
        profilePicture: {
          url: 'https://pps.whatsapp.net/v/t61.24694-24/avatar.jpg',
          imageBuffer: fakePhotoBuffer,
          privacyRestricted: false,
        },
        sharedGroups: [
          {
            groupJid: '120363000000001@g.us',
            groupName: 'Core_Architects',
            targetRole: 'ADMIN',
          },
        ],
      };
    };

    const listSessionsCalls: Array<number | undefined> = [];
    const listSessions = (actorId?: number) => {
      listSessionsCalls.push(actorId);
      if (actorId === 777) {
        return [{ id: 'sess_owner_1', status: 'CONNECTED', owner_telegram_id: 777 }];
      }
      return [];
    };

    const sessionManager = {
      listSessions,
      getDriver: () => ({
        fetchFullProfileInfo,
        getRawSocket: () => ({
          privacyToken: async () => ({ trusted: true }),
        }),
      }),
    } as unknown as SessionManager;

    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 404,
        text: async () => '',
        json: async () => ({}),
        headers: new Headers(),
      }) as Response) as typeof fetch;

    const engine = new CyberForensicsOsintEngine(settingsRepo, sessionManager);
    const handler = new CyberForensicsHandler(engine);

    const view = await handler.executeInvestigationAndFormatView(
      777,
      '+967775224395',
      'PHONE_NAMES_ONLY'
    );

    assert.deepEqual(listSessionsCalls, [777]);
    assert.equal(fetchedTarget, '+967775224395');
    assert.ok(view.text.includes('🟢 مسجل ونشط على شبكة واتساب'));
    assert.ok(view.text.includes('73139551780998@lid'));
    assert.ok(view.text.includes('Eng Syarh'));
    assert.ok(view.text.includes('Botezz Security Lab'));
    assert.ok(view.text.includes('Core Architects (ADMIN)'));
    assert.ok(view.mediaAttachments);
    assert.equal(view.mediaAttachments?.[0]?.kind, 'photo');
    assert.deepEqual(view.mediaAttachments?.[0]?.buffer, fakePhotoBuffer);
  });

  it('wires all 6 forensic investigation modes in keyboard and ui-state routes', () => {
    const kb = buildCyberForensicsMenuKeyboard();
    const callbacks = kb.flat().map((b) => b.callbackData);
    assert.ok(callbacks.includes('cyber:phone_lookup'));
    assert.ok(callbacks.includes('cyber:social_lookup'));
    assert.ok(callbacks.includes('cyber:breach_lookup'));
    assert.ok(callbacks.includes('cyber:ten_engines_lookup'));
    assert.ok(callbacks.includes('cyber:handle_lookup'));
    assert.ok(callbacks.includes('cyber:full_scan'));
    assert.ok(callbacks.includes('cyber:history:page:1'));
    assert.ok(callbacks.includes('cyber:settings'));

    assert.equal(isNavigableRoute('cyber:breach_lookup'), true);
    assert.equal(isNavigableRoute('cyber:ten_engines_lookup'), true);
    assert.equal(isNavigableRoute('cyber:handle_lookup'), true);
  });
});
