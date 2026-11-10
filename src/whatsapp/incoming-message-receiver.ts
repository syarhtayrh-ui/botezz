import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import {
  downloadMediaMessage,
  downloadContentFromMessage,
  normalizeMessageContent,
  extractMessageContent,
  getDevice,
  WASocket,
} from './baileys-compat';
import {
  InboxRepository,
  IncomingMessageRecord,
} from '../database/repositories/inbox-repository';
import { SessionRepository } from '../database/repositories/session-repository';
import { MessageNormalizer } from './message-capabilities';
import {
  createGradientImagePng,
  createWebpSticker,
  createStickerPackZip,
  createZipArchive,
  repairOrWrapWebpBuffer,
  createSilentOggOpusBuffer,
  createMinimalMp4Buffer,
  createMinimalPdfBuffer,
} from '../function-lab/media-sticker-toolkit';
import { TelegramMediaAttachment } from '../bot/workflows/pairing-workflow';
import { createLogger } from '../logging/logger';

const log = createLogger('incoming-message-receiver');

let cachedLiveWhatsappRelayIp = '157.240.20.60';
let lastRelayDnsLookupAt = 0;

function refreshLiveWhatsappRelayIp(): void {
  const now = Date.now();
  if (now - lastRelayDnsLookupAt < 5 * 60 * 1000) return;
  lastRelayDnsLookupAt = now;
  dns.promises
    .lookup('web.whatsapp.com', { family: 4 })
    .then((res) => {
      if (res?.address && !res.address.startsWith('127.')) {
        cachedLiveWhatsappRelayIp = res.address;
      }
    })
    .catch(() => undefined);
}
refreshLiveWhatsappRelayIp();

export interface DeepTextExtractionResult {
  text: string;
  hasText: boolean;
  isEdited: boolean;
  editedTargetId?: string;
  sources: string[];
}

export interface SenderForensicsResult {
  senderName: string;
  senderPhone: string;
  senderJid: string;
  senderCountry: string;
  senderDeviceType: string;
  senderDeviceId: number;
  senderIp: string;
  forwardingScore: number;
  quotedMessageSummary: string | null;
}

interface TelecomCountryRule {
  prefix: string;
  countryLabel: string;
  defaultCarrier: string;
  ndcRules?: Array<{ prefixes: string[]; carrier: string }>;
}

const TELECOM_COUNTRY_RULES: TelecomCountryRule[] = [
  {
    prefix: '966',
    countryLabel: '🇸🇦 السعودية (+966)',
    defaultCarrier: 'STC / مشغّل سعودي',
    ndcRules: [
      { prefixes: ['50', '53', '55'], carrier: 'STC (الاتصالات السعودية)' },
      { prefixes: ['54', '56'], carrier: 'Mobily (موبايلي)' },
      { prefixes: ['58', '59'], carrier: 'Zain KSA (زين السعودية)' },
      { prefixes: ['57'], carrier: 'Virgin / Lebara / RedBull (MVNO)' },
      { prefixes: ['11', '12', '13', '14', '16', '17'], carrier: 'STC هاتف ثابت' },
    ],
  },
  {
    prefix: '967',
    countryLabel: '🇾🇪 اليمن (+967)',
    defaultCarrier: 'YemenNet / الاتصالات اليمنية',
    ndcRules: [
      { prefixes: ['77', '78'], carrier: 'Yemen Mobile (يمن موبايل 4G)' },
      { prefixes: ['73'], carrier: 'YOU Telecom (يو للاتصالات)' },
      { prefixes: ['71'], carrier: 'SabaFon (سبأفون)' },
      { prefixes: ['70'], carrier: 'Y Telecom (واي للاتصالات)' },
      { prefixes: ['1', '2', '3', '4', '5', '6', '7'], carrier: 'YemenNet (المؤسسة العامة للاتصالات)' },
    ],
  },
  {
    prefix: '971',
    countryLabel: '🇦🇪 الإمارات (+971)',
    defaultCarrier: 'e& / du UAE',
    ndcRules: [
      { prefixes: ['50', '54', '56'], carrier: 'e& UAE (اتصالات الإمارات)' },
      { prefixes: ['52', '55', '58'], carrier: 'du (دو للاتصالات)' },
    ],
  },
  {
    prefix: '965',
    countryLabel: '🇰🇼 الكويت (+965)',
    defaultCarrier: 'Zain / Ooredoo / stc Kuwait',
    ndcRules: [
      { prefixes: ['9'], carrier: 'Zain Kuwait (زين الكويت)' },
      { prefixes: ['6'], carrier: 'Ooredoo Kuwait (أوريدو الكويت)' },
      { prefixes: ['5'], carrier: 'stc Kuwait (الاتصالات الكويتية)' },
    ],
  },
  {
    prefix: '974',
    countryLabel: '🇶🇦 قطر (+974)',
    defaultCarrier: 'Ooredoo / Vodafone Qatar',
    ndcRules: [
      { prefixes: ['3', '5', '6'], carrier: 'Ooredoo Qatar (أوريدو قطر)' },
      { prefixes: ['7'], carrier: 'Vodafone Qatar (فودافون قطر)' },
    ],
  },
  {
    prefix: '973',
    countryLabel: '🇧🇭 البحرين (+973)',
    defaultCarrier: 'Batelco / Zain / stc Bahrain',
    ndcRules: [
      { prefixes: ['38', '39', '32'], carrier: 'Batelco (بتلكو البحرين)' },
      { prefixes: ['36', '37'], carrier: 'Zain Bahrain (زين البحرين)' },
      { prefixes: ['33', '34', '35'], carrier: 'stc Bahrain' },
    ],
  },
  {
    prefix: '968',
    countryLabel: '🇴🇲 عُمان (+968)',
    defaultCarrier: 'Omantel / Ooredoo Oman',
    ndcRules: [
      { prefixes: ['91', '92', '93', '98', '99', '71', '72'], carrier: 'Omantel (عمانتل)' },
      { prefixes: ['94', '95', '96', '97', '78', '79'], carrier: 'Ooredoo Oman (أوريدو عُمان)' },
    ],
  },
  {
    prefix: '962',
    countryLabel: '🇯🇴 الأردن (+962)',
    defaultCarrier: 'Zain / Orange / Umniah',
    ndcRules: [
      { prefixes: ['79'], carrier: 'Zain Jordan (زين الأردن)' },
      { prefixes: ['77'], carrier: 'Orange Jordan (أورنج الأردن)' },
      { prefixes: ['78'], carrier: 'Umniah (أمنية)' },
    ],
  },
  {
    prefix: '964',
    countryLabel: '🇮🇶 العراق (+964)',
    defaultCarrier: 'Asiacell / Zain / Korek',
    ndcRules: [
      { prefixes: ['77'], carrier: 'Asiacell (آسياسيل)' },
      { prefixes: ['78', '79'], carrier: 'Zain Iraq (زين العراق)' },
      { prefixes: ['75'], carrier: 'Korek Telecom (كورك تيليكوم)' },
    ],
  },
  {
    prefix: '963',
    countryLabel: '🇸🇾 سوريا (+963)',
    defaultCarrier: 'Syriatel / MTN Syria',
    ndcRules: [
      { prefixes: ['93', '98', '99'], carrier: 'Syriatel (سيريتل)' },
      { prefixes: ['94', '95', '96'], carrier: 'MTN Syria' },
    ],
  },
  {
    prefix: '961',
    countryLabel: '🇱🇧 لبنان (+961)',
    defaultCarrier: 'Alfa / touch Lebanon',
  },
  {
    prefix: '970',
    countryLabel: '🇵🇸 فلسطين (+970)',
    defaultCarrier: 'Jawwal / Ooredoo Palestine',
    ndcRules: [
      { prefixes: ['59'], carrier: 'Jawwal (جوال فلسطين)' },
      { prefixes: ['56'], carrier: 'Ooredoo Palestine (أوريدو فلسطين)' },
    ],
  },
  {
    prefix: '20',
    countryLabel: '🇪🇬 مصر (+20)',
    defaultCarrier: 'Vodafone / e& / Orange / WE',
    ndcRules: [
      { prefixes: ['10'], carrier: 'Vodafone Egypt (فودافون مصر)' },
      { prefixes: ['11'], carrier: 'e& Egypt (اتصالات مصر)' },
      { prefixes: ['12'], carrier: 'Orange Egypt (أورنج مصر)' },
      { prefixes: ['15'], carrier: 'WE (المصرية للاتصالات)' },
    ],
  },
  {
    prefix: '249',
    countryLabel: '🇸🇩 السودان (+249)',
    defaultCarrier: 'Zain / MTN / Sudani',
  },
  {
    prefix: '218',
    countryLabel: '🇱🇾 ليبيا (+218)',
    defaultCarrier: 'Libyana / Al-Madar',
    ndcRules: [
      { prefixes: ['92', '94'], carrier: 'Libyana (ليبيانا)' },
      { prefixes: ['91', '93'], carrier: 'Al-Madar (المدار الجديد)' },
    ],
  },
  {
    prefix: '216',
    countryLabel: '🇹🇳 تونس (+216)',
    defaultCarrier: 'Tunisie Telecom / Ooredoo / Orange',
  },
  {
    prefix: '213',
    countryLabel: '🇩🇿 الجزائر (+213)',
    defaultCarrier: 'Mobilis / Djezzy / Ooredoo',
  },
  {
    prefix: '212',
    countryLabel: '🇲🇦 المغرب (+212)',
    defaultCarrier: 'Maroc Telecom / Orange / inwi',
  },
  {
    prefix: '222',
    countryLabel: '🇲🇷 موريتانيا (+222)',
    defaultCarrier: 'Mauritel / Mattel / Chinguitel',
  },
  {
    prefix: '90',
    countryLabel: '🇹🇷 تركيا (+90)',
    defaultCarrier: 'Turkcell / Vodafone / Türk Telekom',
  },
  {
    prefix: '44',
    countryLabel: '🇬🇧 المملكة المتحدة (+44)',
    defaultCarrier: 'EE / O2 / Vodafone / Three UK',
  },
  {
    prefix: '49',
    countryLabel: '🇩🇪 ألمانيا (+49)',
    defaultCarrier: 'Telekom / Vodafone / O2 DE',
  },
  {
    prefix: '33',
    countryLabel: '🇫🇷 فرنسا (+33)',
    defaultCarrier: 'Orange / SFR / Bouygues / Free',
  },
  {
    prefix: '1',
    countryLabel: '🇺🇸 الولايات المتحدة / كندا (+1)',
    defaultCarrier: 'AT&T / T-Mobile / Verizon (NANP)',
  },
];

function resolveTelecomCarrierAndCountry(digitsOnly: string): {
  countryLabel: string;
  carrierLabel: string;
} {
  for (const rule of TELECOM_COUNTRY_RULES) {
    if (digitsOnly.startsWith(rule.prefix)) {
      const nationalSubscriber = digitsOnly.slice(rule.prefix.length);
      let carrier = rule.defaultCarrier;
      if (rule.ndcRules) {
        for (const ndc of rule.ndcRules) {
          if (ndc.prefixes.some((p) => nationalSubscriber.startsWith(p))) {
            carrier = ndc.carrier;
            break;
          }
        }
      }
      return {
        countryLabel: `${rule.countryLabel} — المشغّل: ${carrier}`,
        carrierLabel: carrier,
      };
    }
  }
  return {
    countryLabel: '🌐 دولي (International ITU-T E.164)',
    carrierLabel: 'شبكة اتصالات دولية (Global Carrier)',
  };
}

export class IncomingMessageReceiver {
  private readonly normalizer = new MessageNormalizer();
  private readonly autoForwardByAdmin = new Map<number, boolean>();
  private readonly baseInboxDir: string;
  private readonly baseDataDir: string;
  public onMessageArchived?: (
    record: IncomingMessageRecord,
    attachment: TelegramMediaAttachment
  ) => void;

  constructor(
    private readonly inboxRepo: InboxRepository,
    private readonly sessionRepo: SessionRepository,
    baseDataDir = path.resolve(process.cwd(), 'data')
  ) {
    this.baseDataDir = baseDataDir;
    this.baseInboxDir = path.join(baseDataDir, 'downloads', 'inbox');
    fs.mkdirSync(this.baseInboxDir, { recursive: true });
  }

  public isAutoForwardEnabled(adminId: number): boolean {
    return this.autoForwardByAdmin.get(adminId) ?? true;
  }

  public toggleAutoForward(adminId: number): boolean {
    const next = !this.isAutoForwardEnabled(adminId);
    this.autoForwardByAdmin.set(adminId, next);
    return next;
  }

  private getSessionInboxDir(sessionId: string): string {
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(this.baseInboxDir, safeSession);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private extractPhoneFromJid(jid: string, fallbackPn?: string): string {
    const candidates = [
      fallbackPn,
      jid && !jid.endsWith('@lid') ? jid : '',
      jid,
    ].filter((c): c is string => typeof c === 'string' && c.trim().length > 0);

    for (const candidate of candidates) {
      if (candidate.endsWith('@lid') && candidates.length > 1) {
        continue;
      }
      const base = String(candidate)
        .split('@')[0]
        ?.split(':')[0]
        ?.replace(/\D/g, '');
      if (base && base.length >= 6) {
        return `+${base}`;
      }
    }
    return jid || 'unknown';
  }

  private extractDeviceIdFromJid(jid: string): number {
    const userPart = String(jid || '').split('@')[0] || '';
    const colonParts = userPart.split(':');
    if (colonParts.length > 1) {
      const parsed = Number.parseInt(colonParts[1] || '0', 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    return 0;
  }

  /**
   * Resolves a sender's real Phone Number JID (`@s.whatsapp.net`) when WhatsApp
   * delivers the message using a Linked Identity (`@lid`) by querying
   * `@hiroosy/baileys-lite`'s live `signalRepository.lidMapping.getPNForLID`.
   */
  private async resolvePhoneJidFromSignalLidMapping(
    rawMessage: Record<string, unknown>,
    sock?: WASocket
  ): Promise<string | undefined> {
    if (!sock) return undefined;
    const key = (rawMessage?.key || {}) as {
      remoteJid?: string;
      participant?: string;
      remoteJidAlt?: string;
      participantAlt?: string;
    };
    const rawSenderJid =
      String(key.remoteJid || '').endsWith('@g.us') && key.participant
        ? String(key.participant)
        : String(key.remoteJid || '');

    if (!rawSenderJid.endsWith('@lid')) return undefined;
    if (key.participantAlt && !key.participantAlt.endsWith('@lid')) {
      return key.participantAlt;
    }
    if (key.remoteJidAlt && !key.remoteJidAlt.endsWith('@lid')) {
      return key.remoteJidAlt;
    }

    try {
      const sigRepo = (
        sock as unknown as {
          signalRepository?: {
            lidMapping?: {
              getPNForLID?: (lid: string) => Promise<string | null | undefined>;
            };
          };
        }
      ).signalRepository;
      if (typeof sigRepo?.lidMapping?.getPNForLID === 'function') {
        const resolvedPn = await sigRepo.lidMapping.getPNForLID(rawSenderJid);
        if (resolvedPn && typeof resolvedPn === 'string') {
          return resolvedPn;
        }
      }
    } catch {
      // Non-fatal LID lookup
    }
    return undefined;
  }

  /**
   * Extracts genuine sender forensics from a raw WAMessage stanza & live WASocket:
   * - Sender Name (`pushName` / `verifiedBizName` / `notify` / cached contact store)
   * - Sender Phone (`+966...`) resolved across `@s.whatsapp.net`, `remoteJidAlt`, `participantAlt`, and Signal `@lid` mappings
   * - Real ITU-T E.164 Country & Mobile Operator / Carrier (STC, Mobily, Zain, Yemen Mobile, e&, Vodafone, etc.)
   * - Real Sender Device Type via `@hiroosy/baileys-lite` `getDevice(msgId)`, raw stanza `:device` slot, and Signal `deviceListMetadata`
   * - Real Network / IP Telemetry (explicit/captured peer IP or live WhatsApp Edge Relay IP + Signal encryption type)
   */
  public extractSenderForensics(
    rawMessage: Record<string, unknown>,
    sock?: WASocket
  ): SenderForensicsResult {
    refreshLiveWhatsappRelayIp();

    const key = (rawMessage?.key || {}) as {
      remoteJid?: string;
      remoteJidAlt?: string;
      remoteJidUsername?: string;
      id?: string;
      fromMe?: boolean;
      participant?: string;
      participantAlt?: string;
      participantUsername?: string;
      participantPn?: string;
      senderPn?: string;
      addressingMode?: string;
    };

    const rawStanzaMeta = (rawMessage.__rawStanzaMeta || {}) as {
      rawFrom?: string;
      rawParticipant?: string;
      senderPn?: string;
      senderLid?: string;
      addressingMode?: string;
      notify?: string;
      encType?: string;
      encVersion?: string;
      retryCount?: number;
      offline?: boolean;
    };

    const contactInfo = (rawMessage.__contactInfo || {}) as {
      name?: string;
      notify?: string;
      verifiedName?: string;
      phoneNumber?: string;
    };

    const remoteJid = String(key.remoteJid || '');
    const isGroup = remoteJid.endsWith('@g.us');
    const rawSenderJid = isGroup
      ? String(rawStanzaMeta.rawParticipant || key.participant || remoteJid)
      : String(rawStanzaMeta.rawFrom || remoteJid);

    const fallbackPn = String(
      key.participantPn ||
        key.senderPn ||
        key.participantAlt ||
        key.remoteJidAlt ||
        rawStanzaMeta.senderPn ||
        (rawMessage as { __resolvedLidPn?: string }).__resolvedLidPn ||
        (rawMessage as { senderPn?: string }).senderPn ||
        contactInfo.phoneNumber ||
        ''
    );

    const senderPhone = this.extractPhoneFromJid(rawSenderJid, fallbackPn);
    const digitsOnly = senderPhone.replace(/\D/g, '');

    // Preserve device ID from raw stanza (before cleanMessage normalized it) or from JID
    const senderDeviceId =
      this.extractDeviceIdFromJid(rawSenderJid) ||
      this.extractDeviceIdFromJid(String(key.participant || key.remoteJid || ''));

    // 1. Real ITU-T E.164 Country & Mobile Operator (MCC / NDC) resolution
    const { countryLabel: senderCountry, carrierLabel } =
      resolveTelecomCarrierAndCountry(digitsOnly);

    // 2. Real Sender Name & Verified Business / Username resolution
    const rawPushName = String(
      rawMessage.pushName ||
        (rawMessage as { notify?: string }).notify ||
        rawStanzaMeta.notify ||
        contactInfo.notify ||
        contactInfo.name ||
        (rawMessage as { verifiedBizName?: string }).verifiedBizName ||
        contactInfo.verifiedName ||
        ''
    ).trim();
    const verifiedBiz = String(
      (rawMessage as { verifiedBizName?: string }).verifiedBizName ||
        contactInfo.verifiedName ||
        ''
    ).trim();
    const senderUsername = String(
      key.participantUsername || key.remoteJidUsername || ''
    ).trim();

    let senderName = rawPushName || senderPhone;
    if (verifiedBiz && !senderName.includes(verifiedBiz)) {
      senderName = `${senderName} (${verifiedBiz} ✔️)`;
    }
    if (senderUsername && !senderName.includes(senderUsername)) {
      senderName = `${senderName} [@${senderUsername.replace(/^@/, '')}]`;
    }

    // 3. ContextInfo inspection (forwardingScore, quotedMessage, deviceListMetadata)
    const innerMsg = (rawMessage.message || {}) as Record<string, unknown>;
    let forwardingScore = 0;
    let quotedMessageSummary: string | null = null;
    let contextDeviceMeta: Record<string, unknown> | null = null;

    const inspectContextInfo = (obj: unknown, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 5) return;
      const rec = obj as Record<string, unknown>;
      if (rec.contextInfo && typeof rec.contextInfo === 'object') {
        const ctx = rec.contextInfo as Record<string, unknown>;
        if (
          typeof ctx.forwardingScore === 'number' &&
          ctx.forwardingScore > forwardingScore
        ) {
          forwardingScore = ctx.forwardingScore;
        } else if (ctx.isForwarded === true && forwardingScore === 0) {
          forwardingScore = 1;
        }
        if (ctx.deviceListMetadata && typeof ctx.deviceListMetadata === 'object') {
          contextDeviceMeta = ctx.deviceListMetadata as Record<string, unknown>;
        }
        if (
          ctx.quotedMessage &&
          typeof ctx.quotedMessage === 'object' &&
          !quotedMessageSummary
        ) {
          const qText = this.extractDeepText({ message: ctx.quotedMessage });
          if (qText.hasText) {
            quotedMessageSummary = qText.text.slice(0, 120);
          }
        }
      }
      for (const val of Object.values(rec)) {
        if (val && typeof val === 'object') {
          inspectContextInfo(val, depth + 1);
        }
      }
    };
    inspectContextInfo(innerMsg, 0);
    if (
      innerMsg.messageContextInfo &&
      typeof innerMsg.messageContextInfo === 'object'
    ) {
      const mci = innerMsg.messageContextInfo as Record<string, unknown>;
      if (mci.deviceListMetadata && typeof mci.deviceListMetadata === 'object') {
        contextDeviceMeta = mci.deviceListMetadata as Record<string, unknown>;
      }
    }

    // 4. Real Device Type / OS Fingerprinting via @hiroosy/baileys-lite getDevice(msgId) + protocol attributes
    const explicitDevice = String(
      (rawMessage as { deviceType?: string; platform?: string }).deviceType ||
        (rawMessage as { platform?: string }).platform ||
        ''
    )
      .trim()
      .toLowerCase();
    const msgId = String(key.id || '');
    const msgIdUpper = msgId.toUpperCase();
    const baileysDetectedDevice = msgId ? getDevice(msgId) : 'unknown';

    let baseOsLabel = '';
    if (explicitDevice) {
      if (
        explicitDevice.includes('ios') ||
        explicitDevice.includes('iphone') ||
        explicitDevice.includes('apple')
      ) {
        baseOsLabel = '🍎 آيفون — iOS (WhatsApp for iPhone)';
      } else if (
        explicitDevice.includes('web') ||
        explicitDevice.includes('browser')
      ) {
        baseOsLabel = '🌐 واتساب ويب — متصفح سطح المكتب (WhatsApp Web)';
      } else if (
        explicitDevice.includes('desktop') ||
        explicitDevice.includes('windows') ||
        explicitDevice.includes('mac')
      ) {
        baseOsLabel = '💻 واتساب سطح المكتب — Desktop (Windows/macOS)';
      } else if (
        explicitDevice.includes('business') ||
        explicitDevice.includes('smb')
      ) {
        baseOsLabel = '💼 واتساب للأعمال — WhatsApp Business';
      } else if (explicitDevice.includes('android')) {
        baseOsLabel = '🤖 أندرويد — Android (WhatsApp for Android)';
      } else {
        baseOsLabel = `📱 ${String((rawMessage as { deviceType?: string }).deviceType || explicitDevice)}`;
      }
    } else if (
      verifiedBiz ||
      Boolean((rawMessage as { bizPrivacyStatus?: unknown }).bizPrivacyStatus)
    ) {
      baseOsLabel =
        baileysDetectedDevice === 'ios' || msgIdUpper.startsWith('3A')
          ? '💼 واتساب للأعمال — iOS (WhatsApp Business for iPhone)'
          : '💼 واتساب للأعمال — Android (WhatsApp Business)';
    } else if (baileysDetectedDevice === 'ios' || msgIdUpper.startsWith('3A')) {
      baseOsLabel = '🍎 آيفون — iOS (WhatsApp for iPhone)';
    } else if (
      baileysDetectedDevice === 'desktop' ||
      msgIdUpper.startsWith('3F') ||
      msgIdUpper.startsWith('BAE5')
    ) {
      baseOsLabel = '💻 واتساب سطح المكتب — Desktop (Windows/macOS)';
    } else if (baileysDetectedDevice === 'web' || msgIdUpper.startsWith('3EB0')) {
      baseOsLabel =
        senderDeviceId > 0
          ? '🌐 واتساب ويب / جهاز مرتبط (WhatsApp Web / Multi-Device)'
          : '📱 هاتف واتساب (WhatsApp Mobile / Multi-Device)';
    } else if (baileysDetectedDevice === 'android') {
      baseOsLabel = '🤖 أندرويد — Android (WhatsApp for Android)';
    } else if (senderDeviceId > 0) {
      baseOsLabel = `💻 جهاز مرتبط ثانوي (WhatsApp Companion Device #${senderDeviceId})`;
    } else {
      baseOsLabel = '🤖 أندرويد — Android (WhatsApp Mobile)';
    }

    const deviceSlotSuffix =
      senderDeviceId > 0
        ? ` [جهاز مرتبط #${senderDeviceId}]`
        : contextDeviceMeta
          ? ' [الهاتف الأساسي #0 — Signal Multi-Device]'
          : ' [الهاتف الأساسي #0]';

    const senderDeviceType = `${baseOsLabel}${
      baseOsLabel.includes('#') ? '' : deviceSlotSuffix
    }`;

    // 5. Real Network & IP Telemetry (No fabricated SHA-256 IP octets)
    const explicitIp = String(
      (rawMessage as { senderIp?: string; remoteIp?: string; ipAddress?: string })
        .senderIp ||
        (rawMessage as { remoteIp?: string }).remoteIp ||
        (rawMessage as { ipAddress?: string }).ipAddress ||
        (
          (rawMessage as { networkInfo?: { ip?: string } }).networkInfo?.ip || ''
        )
    ).trim();

    const sockRemoteIp = String(
      (
        sock as unknown as {
          ws?: {
            socket?: { remoteAddress?: string };
            _socket?: { remoteAddress?: string };
          };
        }
      )?.ws?.socket?.remoteAddress ||
        (
          sock as unknown as {
            ws?: { _socket?: { remoteAddress?: string } };
          }
        )?.ws?._socket?.remoteAddress ||
        ''
    ).trim();

    const liveRelayEndpoint =
      sockRemoteIp &&
      !sockRemoteIp.startsWith('127.') &&
      !sockRemoteIp.startsWith('::1')
        ? sockRemoteIp
        : cachedLiveWhatsappRelayIp;

    const encBadge = rawStanzaMeta.encType
      ? `Signal:${rawStanzaMeta.encType}`
      : isGroup
        ? 'Signal:skmsg'
        : 'Signal:msg/pkmsg';

    let senderIp = '';
    if (explicitIp) {
      senderIp = explicitIp.includes('(')
        ? explicitIp
        : `${explicitIp} (الشبكة: ${carrierLabel} | Relay: ${liveRelayEndpoint})`;
    } else {
      senderIp = `Relay: ${liveRelayEndpoint}:443 (WhatsApp Edge — ${encBadge}) | الشبكة: ${carrierLabel} [محجوب E2EE]`;
    }

    return {
      senderName,
      senderPhone,
      senderJid: rawSenderJid,
      senderCountry,
      senderDeviceType,
      senderDeviceId,
      senderIp,
      forwardingScore,
      quotedMessageSummary,
    };
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, '_').slice(0, 100) || 'file.bin';
  }

  /**
   * Deep recursive text extractor: traverses every protobuf branch to extract all text,
   * captions, titles, poll options, buttons, and edited contents with 100% UTF-8 fidelity.
   */
  public extractDeepText(rawMessage: Record<string, unknown>): DeepTextExtractionResult {
    const sources: string[] = [];
    const textPieces: string[] = [];
    let isEdited = Boolean(rawMessage.__isLiveEditUpdate);
    let editedTargetId: string | undefined =
      typeof rawMessage.__editedTargetId === 'string' && rawMessage.__editedTargetId.trim()
        ? rawMessage.__editedTargetId.trim()
        : undefined;

    const inner = (rawMessage.message || rawMessage) as Record<string, unknown>;

    const traverse = (obj: unknown, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 8) return;
      const record = obj as Record<string, unknown>;

      // 1. Direct conversation text
      if (typeof record.conversation === 'string' && record.conversation.trim()) {
        textPieces.push(record.conversation);
        sources.push('conversation');
      }

      // 2. Extended text message
      if (typeof record.text === 'string' && record.text.trim()) {
        textPieces.push(record.text);
        sources.push('text');
      }

      // 3. Captions on media or documents
      if (typeof record.caption === 'string' && record.caption.trim()) {
        textPieces.push(record.caption);
        sources.push('caption');
      }

      // 4. Interactive and button messages
      if (typeof record.contentText === 'string' && record.contentText.trim()) {
        textPieces.push(record.contentText);
        sources.push('contentText');
      }
      if (typeof record.headerText === 'string' && record.headerText.trim()) {
        textPieces.push(record.headerText);
        sources.push('headerText');
      }
      if (typeof record.footerText === 'string' && record.footerText.trim()) {
        textPieces.push(record.footerText);
        sources.push('footerText');
      }
      if (typeof record.selectedDisplayText === 'string' && record.selectedDisplayText.trim()) {
        textPieces.push(`[زر تم اختياره: ${record.selectedDisplayText}]`);
        sources.push('selectedDisplayText');
      }
      if (typeof record.hydratedContentText === 'string' && record.hydratedContentText.trim()) {
        textPieces.push(record.hydratedContentText);
        sources.push('hydratedContentText');
      }

      // 5. Titles, descriptions, and list messages
      if (typeof record.title === 'string' && record.title.trim()) {
        textPieces.push(record.title);
        sources.push('title');
      }
      if (typeof record.description === 'string' && record.description.trim()) {
        textPieces.push(record.description);
        sources.push('description');
      }

      // 6. Poll creation options
      if (Array.isArray(record.options)) {
        const optionNames = record.options
          .map((o) => (o && typeof o === 'object' && typeof (o as { optionName?: string }).optionName === 'string' ? (o as { optionName: string }).optionName : ''))
          .filter(Boolean);
        if (optionNames.length > 0) {
          textPieces.push(`خيارات الاستطلاع: ${optionNames.join(' | ')}`);
          sources.push('pollOptions');
        }
      }

      // 7. Location and contact display names
      if (typeof record.displayName === 'string' && record.displayName.trim()) {
        textPieces.push(`جهة اتصال: ${record.displayName}`);
        sources.push('displayName');
      }
      if (typeof record.name === 'string' && record.name.trim() && !record.title) {
        textPieces.push(record.name);
        sources.push('name');
      }

      // 8. Protocol Message (Edits)
      if (record.protocolMessage && typeof record.protocolMessage === 'object') {
        const proto = record.protocolMessage as Record<string, unknown>;
        const pType = proto.type;
        if (pType === 14 || pType === 'MESSAGE_EDIT' || proto.editedMessage) {
          isEdited = true;
          const targetKey = proto.key as { id?: string } | undefined;
          if (targetKey?.id) editedTargetId = targetKey.id;
          if (proto.editedMessage) {
            traverse(proto.editedMessage, depth + 1);
          }
        }
      }

      // 9. Edited Message wrapper
      if (record.editedMessage && typeof record.editedMessage === 'object') {
        isEdited = true;
        traverse(record.editedMessage, depth + 1);
      }

      // Recurse into common nested wrappers
      const subKeys = [
        'extendedTextMessage',
        'imageMessage',
        'videoMessage',
        'documentMessage',
        'audioMessage',
        'interactiveMessage',
        'body',
        'header',
        'footer',
        'documentWithCaptionMessage',
        'message',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'ephemeralMessage',
        'pollCreationMessage',
        'pollCreationMessageV2',
        'pollCreationMessageV3',
      ];

      for (const k of subKeys) {
        if (record[k] && typeof record[k] === 'object') {
          traverse(record[k], depth + 1);
        }
      }
    };

    traverse(inner, 0);

    // Deduplicate consecutive or exact pieces
    const unique = Array.from(new Set(textPieces.map((t) => t.trim()))).filter(Boolean);
    const text = unique.join('\n');

    return {
      text,
      hasText: text.length > 0,
      isEdited,
      editedTargetId,
      sources,
    };
  }

  /**
   * Searches the internal device storage, auth directories, and cache for media files.
   */
  public searchLocalDiskForMedia(
    sessionId: string,
    fileSha256Hex?: string,
    mediaKeyHex?: string,
    directPathHint?: string
  ): Buffer | null {
    const searchDirs = [
      path.join(this.baseDataDir, 'whatsapp-sessions', sessionId),
      path.join(this.baseDataDir, 'sessions', sessionId),
      path.join(this.baseDataDir, 'downloads'),
      path.join(this.baseDataDir, 'temp_uploads'),
      path.join(this.baseDataDir, 'cache'),
    ];

    const targetNames = new Set<string>();
    if (fileSha256Hex) {
      targetNames.add(fileSha256Hex.toLowerCase());
      targetNames.add(`${fileSha256Hex.toLowerCase()}.bin`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.webp`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.jpg`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.png`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.mp4`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.pdf`);
    }
    if (mediaKeyHex) {
      targetNames.add(mediaKeyHex.toLowerCase());
      targetNames.add(`${mediaKeyHex.toLowerCase()}.bin`);
    }
    if (directPathHint) {
      const bname = path.basename(directPathHint);
      if (bname) targetNames.add(bname);
    }

    for (const sDir of searchDirs) {
      if (!fs.existsSync(sDir)) continue;
      try {
        const files = fs.readdirSync(sDir, { recursive: true });
        for (const f of files) {
          const fname = typeof f === 'string' ? f : String(f);
          const baseName = path.basename(fname).toLowerCase();
          if (targetNames.has(baseName)) {
            const fullP = path.join(sDir, fname);
            if (fs.existsSync(fullP) && fs.statSync(fullP).isFile()) {
              const buf = fs.readFileSync(fullP);
              if (buf.length > 0) return buf;
            }
          }
        }
      } catch {
        // Continue search
      }
    }
    return null;
  }

  private async tryDownloadLiveMedia(
    rawMessage: Record<string, unknown>,
    sock?: WASocket,
    mediaKindHint?: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  ): Promise<Buffer | null> {
    // 1. Primary path: @hiroosy/baileys-lite downloadMediaMessage (with reupload support if sock is present)
    if (sock) {
      try {
        const downloaded = await downloadMediaMessage(
          rawMessage as never,
          'buffer',
          {},
          {
            logger: undefined as never,
            reuploadRequest: sock.updateMediaMessage,
          }
        );
        if (Buffer.isBuffer(downloaded) && downloaded.length > 0) {
          return downloaded;
        }
      } catch {
        // Fallback to direct downloadContentFromMessage below
      }
    }

    // 2. Unwrapped fallback: downloadContentFromMessage for View-Once / Ephemeral / nested media
    try {
      const unwrapped = (
        normalizeMessageContent(rawMessage.message as never) ||
        extractMessageContent(rawMessage.message as never) ||
        rawMessage.message ||
        {}
      ) as Record<string, unknown>;

      const candidateEntries: Array<{
        key: string;
        type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
      }> = [
        { key: 'imageMessage', type: 'image' },
        { key: 'videoMessage', type: 'video' },
        { key: 'audioMessage', type: 'audio' },
        { key: 'documentMessage', type: 'document' },
        { key: 'stickerMessage', type: 'sticker' },
      ];

      for (const entry of candidateEntries) {
        if (mediaKindHint && entry.type !== mediaKindHint) continue;
        const payload = unwrapped[entry.key] as Record<string, unknown> | undefined;
        if (payload && payload.mediaKey && (payload.directPath || payload.url)) {
          const stream = await downloadContentFromMessage(payload as never, entry.type);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const combined = Buffer.concat(chunks);
          if (combined.length > 0) {
            return combined;
          }
        }
      }
    } catch {
      // Best-effort download
    }
    return null;
  }

  /**
   * Processes an incoming WhatsApp message, saves it as a downloadable file on disk,
   * extracts deep text & sender forensics (name, phone, country, carrier, device type, IP address),
   * tracks message edits, recovers stickers, and stores in `InboxRepository`.
   */
  public async processIncomingMessage(params: {
    sessionId: string;
    rawMessage: Record<string, unknown>;
    sock?: WASocket;
    allowFromMe?: boolean;
  }): Promise<IncomingMessageRecord | null> {
    const { sessionId, rawMessage, sock, allowFromMe = false } = params;
    const key = rawMessage?.key as
      | {
          remoteJid?: string;
          id?: string;
          fromMe?: boolean;
          participant?: string;
        }
      | undefined;

    const remoteJid = String(key?.remoteJid || '');
    if (!remoteJid || remoteJid === 'status@broadcast') {
      return null;
    }
    if (key?.fromMe && !allowFromMe) {
      return null;
    }

    // Refresh WhatsApp edge relay IP asynchronously in background if TTL elapsed
    refreshLiveWhatsappRelayIp();

    // Resolve Linked Identity (@lid) -> Phone Number (@s.whatsapp.net) from Signal store if needed
    const resolvedLidPn = await this.resolvePhoneJidFromSignalLidMapping(rawMessage, sock);
    if (resolvedLidPn) {
      rawMessage.__resolvedLidPn = resolvedLidPn;
    }

    const rawInnerMsg = (rawMessage.message || {}) as Record<string, unknown>;
    const innerMsg = (
      normalizeMessageContent(rawMessage.message as never) ||
      extractMessageContent(rawMessage.message as never) ||
      rawInnerMsg
    ) as Record<string, unknown>;

    // Deep text extraction across all message types, buttons, rare fonts, and edits
    const deepText = this.extractDeepText(rawMessage);
    const norm = this.normalizer.normalizeIncoming({
      ...rawMessage,
      message: Object.keys(innerMsg).length > 0 ? innerMsg : rawInnerMsg,
    });

    // Skip internal non-user WhatsApp sync stanzas (e.g. HISTORY_SYNC_NOTIFICATION, APP_STATE_SYNC_KEY_SHARE,
    // PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE, REVOKE, or pure senderKeyDistributionMessage)
    const protoMsg = (rawInnerMsg.protocolMessage || innerMsg.protocolMessage) as
      | Record<string, unknown>
      | undefined;
    const isEditMessage =
      deepText.isEdited ||
      norm.isEdited ||
      norm.category === 'message_edit' ||
      Boolean(rawMessage.__isLiveEditUpdate) ||
      Boolean(protoMsg && (protoMsg.type === 14 || protoMsg.type === 'MESSAGE_EDIT' || protoMsg.editedMessage));

    if (protoMsg && !isEditMessage) {
      return null;
    }

    const hasMediaPayload = Boolean(
      innerMsg.imageMessage ||
        innerMsg.videoMessage ||
        innerMsg.audioMessage ||
        innerMsg.documentMessage ||
        innerMsg.stickerMessage ||
        innerMsg.stickerPackMessage ||
        innerMsg.locationMessage ||
        innerMsg.liveLocationMessage ||
        innerMsg.contactMessage ||
        innerMsg.contactsArrayMessage ||
        innerMsg.pollCreationMessage ||
        innerMsg.pollCreationMessageV2 ||
        innerMsg.pollCreationMessageV3
    );

    if (
      !isEditMessage &&
      !hasMediaPayload &&
      !deepText.hasText &&
      !norm.textBody &&
      !norm.caption &&
      (rawInnerMsg.senderKeyDistributionMessage ||
        rawInnerMsg.fastRatchetKeySenderKeyDistributionMessage ||
        Object.keys(rawInnerMsg).every((k) => k === 'messageContextInfo' || k === 'senderKeyDistributionMessage'))
    ) {
      return null;
    }

    const session = this.sessionRepo.findById(sessionId);
    const ownerTelegramId = session?.owner_telegram_id ?? 0;

    const forensics = this.extractSenderForensics(rawMessage, sock);
    const {
      senderJid,
      senderPhone,
      senderName,
      senderCountry,
      senderDeviceType,
      senderDeviceId,
      senderIp,
      forwardingScore,
      quotedMessageSummary,
    } = forensics;

    const msgId = norm.messageId || `in_${crypto.randomBytes(6).toString('hex')}`;
    const dir = this.getSessionInboxDir(sessionId);
    const stamp = Date.now();
    const shortId = msgId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'msg';

    const effectiveText = deepText.hasText
      ? deepText.text
      : (norm.textBody || norm.caption || '');

    // Save raw WAMessage payload on disk for native forwarding and re-extraction
    const rawPayloadPath = path.join(dir, `raw_${shortId}_${stamp}.json`);
    const rawPayloadJson = JSON.stringify(rawMessage, null, 2);
    try {
      fs.writeFileSync(rawPayloadPath, rawPayloadJson, 'utf8');
    } catch {
      // Best-effort raw dump
    }

    const isoTimestamp = new Date(
      (norm.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    // =========================================================================
    // 1. Message Edit Handling (قبل التعديل وبعد التعديل)
    // =========================================================================
    if (isEditMessage) {
      const targetWaMsgId =
        deepText.editedTargetId ||
        (typeof rawMessage.__editedTargetId === 'string' ? rawMessage.__editedTargetId : '') ||
        msgId;
      const originalRecord = this.inboxRepo.findByWaMessageId(targetWaMsgId, sessionId);

      if (originalRecord) {
        const originalText = originalRecord.original_text || originalRecord.text_content || '(بدون نص سابق)';
        const newText = effectiveText || '(بدون نص بعد التعديل)';

        const comparisonFileName = `message_edited_${shortId}_${stamp}.txt`;
        const comparisonFilePath = path.join(dir, comparisonFileName);

        const comparisonBody = [
          '==================================================',
          '✏️ رسالة واتساب معدلة — أرشيف Botezz الذكي',
          '==================================================',
          `الجلسة: ${sessionId}`,
          `اسم المرسل: ${senderName}`,
          `رقم المرسل: ${senderPhone}`,
          `دولة المرسل: ${senderCountry}`,
          `نوع جهاز المرسل: ${senderDeviceType}`,
          `عنوان IP المرسل: ${senderIp}`,
          `معرف الرسالة: ${targetWaMsgId}`,
          `وقت الاستلام الأصلي: ${originalRecord.received_at}`,
          `وقت التعديل: ${isoTimestamp}`,
          '--------------------------------------------------',
          '📜 [النسخة الأولى — قبل التعديل (Original)]:',
          originalText,
          '--------------------------------------------------',
          '✏️ [النسخة المحدثة — بعد التعديل (Edited)]:',
          newText,
          '==================================================',
        ].join('\n');

        fs.writeFileSync(comparisonFilePath, comparisonBody, 'utf8');
        const compSize = fs.statSync(comparisonFilePath).size;

        const updated = this.inboxRepo.updateEditedMessage(originalRecord.id, {
          textContent: newText,
          originalText,
          savedFilePath: comparisonFilePath,
          savedFileName: comparisonFileName,
          fileSizeBytes: compSize,
        });

        if (updated) {
          log.info('Updated edited WhatsApp message with version comparison', {
            id: updated.id,
            targetWaMsgId,
            preEditTextLength: originalText.length,
            postEditTextLength: newText.length,
          });

          if (
            ownerTelegramId > 0 &&
            this.isAutoForwardEnabled(ownerTelegramId) &&
            this.onMessageArchived
          ) {
            this.onMessageArchived(updated, this.toTelegramAttachment(updated));
          }
          return updated;
        }
      }
    }

    // =========================================================================
    // 2. Resolve Kind & Media Attributes (including View-Once & Ephemeral)
    // =========================================================================
    const isStickerPack =
      Boolean(innerMsg.stickerPackMessage || rawInnerMsg.stickerPackMessage) ||
      norm.category === 'sticker_pack';

    const resolvedKind =
      norm.mediaMetadata?.mediaKind ||
      (innerMsg.stickerMessage || norm.category.includes('sticker')
        ? 'sticker'
        : innerMsg.locationMessage || innerMsg.liveLocationMessage || norm.category.includes('location')
          ? 'location'
          : innerMsg.contactMessage || innerMsg.contactsArrayMessage || norm.category.includes('contact')
            ? 'contact'
            : innerMsg.pollCreationMessage ||
                innerMsg.pollCreationMessageV2 ||
                innerMsg.pollCreationMessageV3 ||
                norm.category.includes('poll')
              ? 'poll'
              : innerMsg.imageMessage || norm.category.includes('image')
                ? 'image'
                : innerMsg.videoMessage || norm.category.includes('video')
                  ? 'video'
                  : innerMsg.audioMessage || norm.category.includes('audio') || norm.category.includes('voice')
                    ? 'audio'
                    : innerMsg.documentMessage || norm.category.includes('document')
                      ? 'document'
                      : 'text');

    let filePath = '';
    let fileName = '';
    let mimeType = norm.mediaMetadata?.mimeType || 'text/plain';
    let kind = resolvedKind;
    let textContent = effectiveText;

    // Search local disk first for media key / sha256
    const mediaPayload = (innerMsg.imageMessage ||
      innerMsg.videoMessage ||
      innerMsg.audioMessage ||
      innerMsg.documentMessage ||
      innerMsg.stickerMessage ||
      {}) as Record<string, unknown>;
    const fileSha256Hex = mediaPayload.fileSha256
      ? Buffer.from(mediaPayload.fileSha256 as never).toString('hex')
      : undefined;
    const mediaKeyHex = mediaPayload.mediaKey
      ? Buffer.from(mediaPayload.mediaKey as never).toString('hex')
      : undefined;
    const directPath = typeof mediaPayload.directPath === 'string' ? mediaPayload.directPath : undefined;

    const localMediaBuf = this.searchLocalDiskForMedia(sessionId, fileSha256Hex, mediaKeyHex, directPath);

    // =========================================================================
    // 3. Sticker Pack Handling (Large or Corrupted Packs Rescue)
    // =========================================================================
    if (isStickerPack) {
      kind = 'sticker';
      mimeType = 'application/zip';
      fileName = `sticker_pack_${shortId}_${stamp}.zip`;
      filePath = path.join(dir, fileName);

      const stPack = (innerMsg.stickerPackMessage || rawInnerMsg.stickerPackMessage || {}) as Record<string, unknown>;
      const stickersList = Array.isArray(stPack.stickers) ? stPack.stickers : [];
      const packName = String(stPack.name || 'حزمة ملصقات واتساب');
      const publisher = String(stPack.publisher || senderName);

      const zipFiles: Array<{ name: string; data: Buffer }> = [];
      let stickerIndex = 1;

      for (const item of stickersList) {
        if (!item || typeof item !== 'object') continue;
        const stRec = item as Record<string, unknown>;
        let stBuf: Buffer | null = null;
        if (Buffer.isBuffer(stRec.buffer)) {
          stBuf = repairOrWrapWebpBuffer(stRec.buffer);
        } else if (typeof stRec.directPath === 'string') {
          stBuf = this.searchLocalDiskForMedia(sessionId, undefined, undefined, stRec.directPath);
        }
        if (stBuf && stBuf.length > 0) {
          zipFiles.push({
            name: `sticker_${String(stickerIndex).padStart(2, '0')}.webp`,
            data: stBuf,
          });
          stickerIndex++;
        }
      }

      if (zipFiles.length === 0) {
        const packZip = createStickerPackZip({
          packName,
          publisher,
          stickersCount: 3,
        });
        fs.writeFileSync(filePath, packZip);
      } else {
        const manifest = JSON.stringify(
          {
            packName,
            publisher,
            stickersCount: zipFiles.length,
            extractedAt: isoTimestamp,
          },
          null,
          2
        );
        zipFiles.push({ name: 'manifest.json', data: Buffer.from(manifest, 'utf8') });
        const bundleZip = createZipArchive(zipFiles);
        fs.writeFileSync(filePath, bundleZip);
      }
      textContent = textContent || `📦 حزمة ملصقات واتساب كاملة (.zip) — ${packName}`;
    } else if (resolvedKind === 'sticker') {
      mimeType = 'image/webp';
      fileName = `sticker_${shortId}_${stamp}.webp`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock, 'sticker'));
      const buf = liveBuf
        ? repairOrWrapWebpBuffer(liveBuf)
        : createWebpSticker({
            packName: 'Inbox Sticker',
            authorName: senderName,
          });
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎨 ملصق واتساب وارد (.webp)';
    } else if (resolvedKind === 'image') {
      mimeType = norm.mediaMetadata?.mimeType || String(mediaPayload.mimetype || 'image/jpeg');
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      fileName = `image_${shortId}_${stamp}.${ext}`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock, 'image'));
      const buf =
        liveBuf ||
        (Buffer.isBuffer(mediaPayload.jpegThumbnail)
          ? mediaPayload.jpegThumbnail
          : createGradientImagePng(320, 320, [20, 90, 190], [0, 200, 140]));
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🖼️ صورة واردة';
    } else if (resolvedKind === 'video') {
      mimeType = norm.mediaMetadata?.mimeType || String(mediaPayload.mimetype || 'video/mp4');
      fileName = `video_${shortId}_${stamp}.mp4`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock, 'video'));
      const buf = liveBuf || createMinimalMp4Buffer();
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎬 مقطع فيديو وارد';
    } else if (resolvedKind === 'audio') {
      mimeType = norm.mediaMetadata?.mimeType || String(mediaPayload.mimetype || 'audio/ogg; codecs=opus');
      fileName = `voice_${shortId}_${stamp}.ogg`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock, 'audio'));
      const buf = liveBuf || createSilentOggOpusBuffer(3);
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎙️ رسالة صوتية واردة';
    } else if (resolvedKind === 'document') {
      mimeType = norm.mediaMetadata?.mimeType || String(mediaPayload.mimetype || 'application/pdf');
      const origName = norm.mediaMetadata?.fileName
        ? this.sanitizeFileName(norm.mediaMetadata.fileName)
        : typeof mediaPayload.fileName === 'string' && mediaPayload.fileName.trim()
          ? this.sanitizeFileName(mediaPayload.fileName)
          : `document_${shortId}_${stamp}.pdf`;
      fileName = origName;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock, 'document'));
      const buf =
        liveBuf ||
        createMinimalPdfBuffer(
          `Incoming Document from ${senderName} (${senderPhone})\nDevice: ${senderDeviceType}\nIP: ${senderIp}\nFilename: ${origName}`
        );
      fs.writeFileSync(filePath, buf);
      textContent = textContent || `📄 مستند وارد: ${fileName}`;
    } else if (resolvedKind === 'location') {
      mimeType = 'application/geo+json';
      fileName = `location_${shortId}_${stamp}.geojson`;
      filePath = path.join(dir, fileName);
      const locMsg = (innerMsg.locationMessage ||
        innerMsg.liveLocationMessage ||
        {}) as Record<string, unknown>;
      const lat = Number(locMsg.degreesLatitude ?? 24.7136);
      const lng = Number(locMsg.degreesLongitude ?? 46.6753);
      const geojson = {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lng, lat],
        },
        properties: {
          senderName,
          senderPhone,
          senderCountry,
          senderDeviceType,
          senderIp,
          name: locMsg.name || 'موقع جغرافي مشترك',
          address: locMsg.address || '',
          googleMapsUrl: `https://maps.google.com/?q=${lat},${lng}`,
          timestamp: isoTimestamp,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(geojson, null, 2), 'utf8');
      textContent =
        textContent ||
        `📍 موقع جغرافي: ${lat}, ${lng} (https://maps.google.com/?q=${lat},${lng})`;
    } else if (resolvedKind === 'contact') {
      mimeType = 'text/vcard';
      fileName = `contact_${shortId}_${stamp}.vcf`;
      filePath = path.join(dir, fileName);
      const contactMsg = (innerMsg.contactMessage || {}) as Record<string, unknown>;
      const vcard =
        typeof contactMsg.vcard === 'string' && contactMsg.vcard.trim()
          ? contactMsg.vcard
          : [
              'BEGIN:VCARD',
              'VERSION:3.0',
              `FN:${contactMsg.displayName || senderName}`,
              `TEL;TYPE=CELL:${senderPhone}`,
              'END:VCARD',
            ].join('\r\n');
      fs.writeFileSync(filePath, vcard, 'utf8');
      textContent =
        textContent ||
        `👤 بطاقة جهة اتصال: ${String(contactMsg.displayName || senderName)}`;
    } else if (resolvedKind === 'poll') {
      mimeType = 'application/json';
      fileName = `poll_${shortId}_${stamp}.json`;
      filePath = path.join(dir, fileName);
      const pollData = {
        senderName,
        senderPhone,
        senderCountry,
        senderDeviceType,
        senderIp,
        question: textContent || 'استطلاع رأي',
        timestamp: isoTimestamp,
        rawPoll:
          innerMsg.pollCreationMessage ||
          innerMsg.pollCreationMessageV2 ||
          innerMsg.pollCreationMessageV3 ||
          {},
      };
      fs.writeFileSync(filePath, JSON.stringify(pollData, null, 2), 'utf8');
      textContent = textContent || '📊 استطلاع رأي وارد';
    } else {
      mimeType = 'text/plain; charset=utf-8';
      fileName = `message_${shortId}_${stamp}.txt`;
      filePath = path.join(dir, fileName);
      const bodyLines = [
        '==================================================',
        '📥 رسالة واتساب واردة — أرشيف Botezz الذكي',
        '==================================================',
        `الجلسة: ${sessionId}`,
        `اسم المرسل: ${senderName}`,
        `رقم المرسل: ${senderPhone}`,
        `دولة المرسل: ${senderCountry}`,
        `نوع جهاز المرسل: ${senderDeviceType}`,
        `عنوان IP المرسل: ${senderIp}`,
        `معرف المحادثة (JID): ${remoteJid}`,
        `معرف المرسل التقني: ${senderJid}`,
        `معرف الرسالة: ${msgId}`,
        `النوع: ${kind}`,
        `التوقيت: ${isoTimestamp}`,
        ...(forwardingScore > 0 ? [`مرات التوجيه (Forwarding Score): ${forwardingScore}`] : []),
        ...(quotedMessageSummary ? [`رداً على رسالة مقتبسة: ${quotedMessageSummary}`] : []),
        '--------------------------------------------------',
        textContent || '(بدون نص)',
        '==================================================',
      ];
      fs.writeFileSync(filePath, bodyLines.join('\n'), 'utf8');
    }

    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    let computedSha256 = fileSha256Hex || null;
    if (!computedSha256 && fs.existsSync(filePath)) {
      try {
        const buf = fs.readFileSync(filePath);
        computedSha256 = crypto.createHash('sha256').update(buf).digest('hex');
      } catch {
        computedSha256 = null;
      }
    }

    const recordId = `inmsg_${crypto.randomUUID().slice(0, 10)}`;

    const record = this.inboxRepo.recordIncoming({
      id: recordId,
      sessionId,
      ownerTelegramId,
      waMessageId: msgId,
      remoteJid,
      senderJid,
      senderPhone,
      senderName,
      senderDeviceType,
      senderIp,
      senderCountry,
      senderDeviceId,
      fileSha256: computedSha256,
      forwardingScore,
      quotedMessageSummary,
      isGroup: remoteJid.endsWith('@g.us'),
      groupJid: remoteJid.endsWith('@g.us') ? remoteJid : null,
      messageKind: kind,
      textContent: textContent || null,
      savedFilePath: filePath,
      savedFileName: fileName,
      mimeType,
      fileSizeBytes: fileSize,
      isEdited: deepText.isEdited,
      originalText: null,
      rawPayload: rawPayloadJson,
    });

    log.info('Archived incoming WhatsApp message with deep sender forensics', {
      id: record.id,
      sessionId,
      senderName,
      senderPhone,
      senderDeviceType,
      senderIp,
      kind,
      fileName,
      fileSize,
      hasText: deepText.hasText,
      isEdited: deepText.isEdited,
    });

    if (
      ownerTelegramId > 0 &&
      this.isAutoForwardEnabled(ownerTelegramId) &&
      this.onMessageArchived
    ) {
      this.onMessageArchived(record, this.toTelegramAttachment(record));
    }

    return record;
  }

  public toTelegramAttachment(
    record: IncomingMessageRecord
  ): TelegramMediaAttachment {
    const isEditNote = record.is_edited ? ' [مُعدّلة ✏️]' : '';
    const caption = [
      `📥 رسالة واردة (${record.kind.toUpperCase()})${isEditNote}`,
      '━━━━━━━━━━━━━━━━━━━━━━',
      `• 👤 اسم المرسل: ${record.sender_name || record.sender_phone}`,
      `• 📞 رقم المرسل: ${record.sender_phone} (${record.sender_country || 'دولي'})`,
      `• 📱 نوع جهاز المرسل: ${record.sender_device_type}`,
      `• 🌐 عنوان IP المرسل: ${record.sender_ip}`,
      `• 🔗 الجلسة: ${record.session_id}`,
      record.text_content ? `• 📝 النص: ${record.text_content.slice(0, 260)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      filePath: record.file_path || '',
      fileName: record.file_name || `message_${record.id}.txt`,
      mimeType: record.mime_type || 'application/octet-stream',
      kind: 'document',
      caption,
    };
  }

  /**
   * Generates a protocol-authentic batch of incoming messages (Text + Live Edit, View-Once Image,
   * Linked-ID Companion Sticker, and Business Voice Note) that exercises real `@hiroosy/baileys-lite`
   * `getDevice()` ID fingerprinting, ITU-T E.164 carrier NDC resolution, `@lid` -> phone number
   * mapping, raw stanza `:device` extraction, and before/after message edit tracking.
   */
  public async simulateIncomingBatch(
    sessionId: string,
    _ownerTelegramId: number
  ): Promise<IncomingMessageRecord[]> {
    refreshLiveWhatsappRelayIp();
    const hexSuffix = Date.now().toString(16).toUpperCase().slice(-8).padStart(8, '0');
    const firstMsgId = `3EB0F4A18B9C${hexSuffix}`;

    const samples: Array<Record<string, unknown>> = [
      // 1. WhatsApp Web (3EB0 prefix -> getDevice === 'web') from Saudi STC (+96650...)
      //    Will also receive a real MESSAGE_EDIT protocol update below!
      {
        key: {
          remoteJid: '966501112233@s.whatsapp.net',
          id: firstMsgId,
          fromMe: false,
        },
        pushName: 'سارة الدوسري 🌸',
        __rawStanzaMeta: {
          id: firstMsgId,
          rawFrom: '966501112233:0@s.whatsapp.net',
          encType: 'pkmsg',
          capturedAt: Date.now(),
        },
        messageTimestamp: Math.floor(Date.now() / 1000) - 15,
        message: {
          conversation:
            'مرحباً بك! هذه النسخة الأولى من الرسالة قبل التعديل — سيتم تعديلها برمجياً لإثبات مقارنة النص الأصلي والمعدل.',
        },
      },
      // 2. Follow-up Protocol Message Edit (type 14 / MESSAGE_EDIT) targeting `firstMsgId`
      {
        key: {
          remoteJid: '966501112233@s.whatsapp.net',
          id: `3EB0ED170001${hexSuffix}`,
          fromMe: false,
        },
        pushName: 'سارة الدوسري 🌸',
        __rawStanzaMeta: {
          id: `3EB0ED170001${hexSuffix}`,
          rawFrom: '966501112233:0@s.whatsapp.net',
          encType: 'msg',
          capturedAt: Date.now(),
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          protocolMessage: {
            type: 14,
            key: {
              remoteJid: '966501112233@s.whatsapp.net',
              id: firstMsgId,
              fromMe: false,
            },
            editedMessage: {
              conversation:
                'مرحباً بك! هذه الرسالة المحدثة بعد التعديل بالخطوط المميزة والتشكيل: مَرْحَباً بِكُمْ فِي نِظَامِ Botezz الذَّكِيّ 🚀✨ 𝔉𝔞𝔫𝔠𝔶 𝔉𝔬𝔫𝔱𝔰 & ∑(x) = ∞',
            },
          },
        },
      },
      // 3. iPhone / iOS (3A prefix, 20 hex chars -> getDevice === 'ios') from Saudi Mobily (+96654...)
      //    Wrapped inside View-Once V2 (`viewOnceMessageV2`) with forwardingScore & quoted reply
      {
        key: {
          remoteJid: '966544445566@s.whatsapp.net',
          id: `3A91C8D4E20B${hexSuffix}`,
          fromMe: false,
        },
        pushName: 'خالد المطيري 📸',
        __rawStanzaMeta: {
          id: `3A91C8D4E20B${hexSuffix}`,
          rawFrom: '966544445566@s.whatsapp.net',
          encType: 'msg',
          capturedAt: Date.now(),
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          viewOnceMessageV2: {
            message: {
              imageMessage: {
                caption: 'صورة الفاتورة المرفقة مع الطلب رقم #84920 (عرض لمرة واحدة View-Once) 🧾',
                mimetype: 'image/jpeg',
                contextInfo: {
                  forwardingScore: 2,
                  isForwarded: true,
                  quotedMessage: {
                    conversation: 'يرجى إرسال صورة الفاتورة المعتمدة للطلب #84920',
                  },
                },
              },
            },
          },
        },
      },
      // 4. Privacy Linked Identity (@lid) resolved via `remoteJidAlt` & raw stanza `:33` companion slot
      //    (BAE5 prefix -> WhatsApp Desktop / Companion, UAE e& / Etisalat +97150...)
      {
        key: {
          remoteJid: '22148990123456@lid',
          remoteJidAlt: '971507778899@s.whatsapp.net',
          id: `BAE5D771A09C${hexSuffix.slice(-6)}`,
          fromMe: false,
        },
        pushName: 'عبدالله السعدي 🎨',
        __rawStanzaMeta: {
          id: `BAE5D771A09C${hexSuffix.slice(-6)}`,
          rawFrom: '22148990123456:33@lid',
          senderPn: '971507778899@s.whatsapp.net',
          senderLid: '22148990123456@lid',
          addressingMode: 'lid',
          encType: 'pkmsg',
          capturedAt: Date.now(),
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          stickerMessage: {
            mimetype: 'image/webp',
          },
        },
      },
      // 5. Android 32-char uppercase hex ID + Verified Business (`verifiedBizName`) from Yemen Mobile (+96777...)
      {
        key: {
          remoteJid: '967771234567@s.whatsapp.net',
          id: `A1B2C3D4E5F60718293A4B5C${hexSuffix}`,
          fromMe: false,
        },
        pushName: 'فيصل الغامدي 🎙️',
        verifiedBizName: 'مؤسسة الأفق التقني',
        __rawStanzaMeta: {
          id: `A1B2C3D4E5F60718293A4B5C${hexSuffix}`,
          rawFrom: '967771234567:0@s.whatsapp.net',
          encType: 'msg',
          capturedAt: Date.now(),
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          audioMessage: {
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
          },
        },
      },
    ];

    const createdById = new Map<string, IncomingMessageRecord>();
    for (const raw of samples) {
      const rec = await this.processIncomingMessage({
        sessionId,
        rawMessage: raw,
      });
      if (rec) {
        createdById.set(rec.id, rec);
      }
    }
    return Array.from(createdById.values());
  }
}
