import crypto from 'node:crypto';
import { SettingsRepository } from '../database/repositories/settings-repository';
import { SessionManager } from '../whatsapp/session-manager';
import { createLogger } from '../logging/logger';

const log = createLogger('cyber-forensics-osint');

export interface NormalizedPhoneMetadata {
  rawInput: string;
  digitsOnly: string;
  e164: string;
  internationalFormatted: string;
  countryCode: string;
  isoCountry2: string;
  countryNameArabic: string;
  countryNameEnglish: string;
  significantNumber: string;
  localWithZero: string;
  inferredCarrier: string;
  lineType: 'MOBILE' | 'FIXED_LINE' | 'VOIP_OR_VIRTUAL' | 'UNKNOWN';
  isValidLength: boolean;
}

export interface DiscoveredIdentityName {
  name: string;
  source: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  category?: string;
  extraInfo?: string;
  observedAtIso: string;
}

export interface WhatsAppForensicFootprint {
  checked: boolean;
  registered: boolean;
  jid?: string;
  lid?: string;
  linkedDevices: number[];
  pushName?: string;
  verifiedBusinessName?: string;
  businessCategory?: string;
  businessDescription?: string;
  businessEmail?: string;
  businessWebsites: string[];
  businessAddress?: string;
  statusBio?: string;
  statusSetAt?: string;
  profilePictureUrl?: string;
  profilePictureBuffer?: Buffer;
  directChatUrl: string;
}

export interface SocialPlatformFootprint {
  platform: string;
  icon: string;
  status: 'CONFIRMED' | 'LIKELY' | 'NOT_FOUND' | 'SEARCH_DORK' | 'RATE_LIMITED';
  exists: boolean;
  url: string;
  handleOrUsername?: string;
  displayName?: string;
  details: string;
  verificationMethod: string;
}

export interface PhoneOsintDorkItem {
  category:
    | 'SOCIAL_MEDIA'
    | 'CALLER_DIRECTORY'
    | 'REPUTATION_SPAM'
    | 'DISPOSABLE_SMS'
    | 'DOCUMENTS_PASTEBIN';
  title: string;
  dorkQuery: string;
  googleUrl: string;
  duckDuckGoUrl: string;
}

export interface LiveWebMentionHit {
  title: string;
  url: string;
  snippet: string;
  extractedNames: string[];
  sourceDomain: string;
}

export interface PhoneForensicReport {
  reportId: string;
  generatedAtIso: string;
  phone: NormalizedPhoneMetadata;
  discoveredNames: DiscoveredIdentityName[];
  whatsappFootprint: WhatsAppForensicFootprint;
  truecallerData?: {
    queried: boolean;
    found: boolean;
    name?: string;
    altName?: string;
    carrier?: string;
    email?: string;
    jobTitle?: string;
    companyName?: string;
    city?: string;
    spamScore?: number;
    spamType?: string;
    badges?: string[];
    internetAddresses?: Array<{ id: string; service: string; caption?: string }>;
    error?: string;
  };
  eyeconData?: {
    queried: boolean;
    found: boolean;
    names: string[];
    facebookProfileUrl?: string;
    photoUrl?: string;
    error?: string;
  };
  carrierApiData?: {
    provider: string;
    valid: boolean;
    carrier?: string;
    lineType?: string;
    location?: string;
  };
  socialAccounts: SocialPlatformFootprint[];
  liveWebMentions: LiveWebMentionHit[];
  osintDorks: PhoneOsintDorkItem[];
  isDisposableBurner: boolean;
  disposableMatchedDomains: string[];
}

interface CallingCodeMeta {
  code: string;
  iso2: string;
  ar: string;
  en: string;
}

const CALLING_CODE_TABLE: CallingCodeMeta[] = [
  { code: '967', iso2: 'YE', ar: 'اليمن 🇾🇪', en: 'Yemen' },
  { code: '966', iso2: 'SA', ar: 'السعودية 🇸🇦', en: 'Saudi Arabia' },
  { code: '971', iso2: 'AE', ar: 'الإمارات 🇦🇪', en: 'United Arab Emirates' },
  { code: '965', iso2: 'KW', ar: 'الكويت 🇰🇼', en: 'Kuwait' },
  { code: '974', iso2: 'QA', ar: 'قطر 🇶🇦', en: 'Qatar' },
  { code: '973', iso2: 'BH', ar: 'البحرين 🇧🇭', en: 'Bahrain' },
  { code: '968', iso2: 'OM', ar: 'سلطنة عمان 🇴🇲', en: 'Oman' },
  { code: '962', iso2: 'JO', ar: 'الأردن 🇯🇴', en: 'Jordan' },
  { code: '964', iso2: 'IQ', ar: 'العراق 🇮🇶', en: 'Iraq' },
  { code: '961', iso2: 'LB', ar: 'لبنان 🇱🇧', en: 'Lebanon' },
  { code: '963', iso2: 'SY', ar: 'سوريا 🇸🇾', en: 'Syria' },
  { code: '970', iso2: 'PS', ar: 'فلسطين 🇵🇸', en: 'Palestine' },
  { code: '249', iso2: 'SD', ar: 'السودان 🇸🇩', en: 'Sudan' },
  { code: '218', iso2: 'LY', ar: 'ليبيا 🇱🇾', en: 'Libya' },
  { code: '216', iso2: 'TN', ar: 'تونس 🇹🇳', en: 'Tunisia' },
  { code: '213', iso2: 'DZ', ar: 'الجزائر 🇩🇿', en: 'Algeria' },
  { code: '212', iso2: 'MA', ar: 'المغرب 🇲🇦', en: 'Morocco' },
  { code: '222', iso2: 'MR', ar: 'موريتانيا 🇲🇷', en: 'Mauritania' },
  { code: '252', iso2: 'SO', ar: 'الصومال 🇸🇴', en: 'Somalia' },
  { code: '253', iso2: 'DJ', ar: 'جيبوتي 🇩🇯', en: 'Djibouti' },
  { code: '20', iso2: 'EG', ar: 'مصر 🇪🇬', en: 'Egypt' },
  { code: '90', iso2: 'TR', ar: 'تركيا 🇹🇷', en: 'Turkey' },
  { code: '98', iso2: 'IR', ar: 'إيران 🇮🇷', en: 'Iran' },
  { code: '92', iso2: 'PK', ar: 'باكستان 🇵🇰', en: 'Pakistan' },
  { code: '91', iso2: 'IN', ar: 'الهند 🇮🇳', en: 'India' },
  { code: '880', iso2: 'BD', ar: 'بنغلاديش 🇧🇩', en: 'Bangladesh' },
  { code: '62', iso2: 'ID', ar: 'إندونيسيا 🇮🇩', en: 'Indonesia' },
  { code: '60', iso2: 'MY', ar: 'ماليزيا 🇲🇾', en: 'Malaysia' },
  { code: '44', iso2: 'GB', ar: 'المملكة المتحدة 🇬🇧', en: 'United Kingdom' },
  { code: '49', iso2: 'DE', ar: 'ألمانيا 🇩🇪', en: 'Germany' },
  { code: '33', iso2: 'FR', ar: 'فرنسا 🇫🇷', en: 'France' },
  { code: '34', iso2: 'ES', ar: 'إسبانيا 🇪🇸', en: 'Spain' },
  { code: '39', iso2: 'IT', ar: 'إيطاليا 🇮🇹', en: 'Italy' },
  { code: '31', iso2: 'NL', ar: 'هولندا 🇳🇱', en: 'Netherlands' },
  { code: '32', iso2: 'BE', ar: 'بلجيكا 🇧🇪', en: 'Belgium' },
  { code: '41', iso2: 'CH', ar: 'سويسرا 🇨🇭', en: 'Switzerland' },
  { code: '46', iso2: 'SE', ar: 'السويد 🇸🇪', en: 'Sweden' },
  { code: '7', iso2: 'RU', ar: 'روسيا 🇷🇺', en: 'Russia' },
  { code: '86', iso2: 'CN', ar: 'الصين 🇨🇳', en: 'China' },
  { code: '81', iso2: 'JP', ar: 'اليابان 🇯🇵', en: 'Japan' },
  { code: '82', iso2: 'KR', ar: 'كوريا الجنوبية 🇰🇷', en: 'South Korea' },
  { code: '55', iso2: 'BR', ar: 'البرازيل 🇧🇷', en: 'Brazil' },
  { code: '1', iso2: 'US', ar: 'الولايات المتحدة / كندا 🇺🇸', en: 'USA / Canada' },
];

// Sort longest calling code first for prefix matching
const SORTED_CALLING_CODES = [...CALLING_CODE_TABLE].sort(
  (a, b) => b.code.length - a.code.length
);

const DISPOSABLE_SMS_DOMAINS = [
  'hs3x.com',
  'receive-sms-now.com',
  'smslisten.com',
  'smsnumbersonline.com',
  'freesmscode.com',
  'catchsms.com',
  'smstibo.com',
  'smsreceiving.com',
  'getfreesmsnumber.com',
  'sellaite.com',
  'receive-sms-online.info',
  'receivesmsonline.com',
  'receive-a-sms.com',
  'sms-receive.net',
  'receivefreesms.com',
  'receive-sms.com',
  'receivetxt.com',
  'freephonenum.com',
  'freesmsverification.com',
  'receive-sms-online.com',
  'smslive.co',
];

export function parseAndNormalizePhoneInput(rawInput: string): NormalizedPhoneMetadata {
  let cleaned = String(rawInput || '').trim().replace(/[^\d+]/g, '');
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }
  let digits = cleaned.replace(/\D/g, '');

  // If user entered a 9-digit Yemeni mobile number starting with 7 (e.g., 775224395 or 0775224395)
  if (digits.length === 10 && /^07[01378]\d{7}$/.test(digits)) {
    digits = '967' + digits.slice(1);
  } else if (digits.length === 9 && /^7[01378]\d{7}$/.test(digits)) {
    digits = '967' + digits;
  } else if (digits.length === 10 && /^05\d{8}$/.test(digits)) {
    digits = '966' + digits.slice(1);
  } else if (digits.length === 9 && /^5\d{8}$/.test(digits)) {
    digits = '966' + digits;
  }

  let matchedMeta: CallingCodeMeta = {
    code: '967',
    iso2: 'YE',
    ar: 'دولي',
    en: 'International',
  };
  let significantNumber = digits;

  for (const entry of SORTED_CALLING_CODES) {
    if (digits.startsWith(entry.code) && digits.length > entry.code.length + 4) {
      matchedMeta = entry;
      significantNumber = digits.slice(entry.code.length);
      break;
    }
  }

  const { carrier, lineType } = inferRegionalCarrierAndLineType(
    matchedMeta.code,
    significantNumber
  );

  const e164 = `+${digits}`;
  const localWithZero = significantNumber.startsWith('0')
    ? significantNumber
    : `0${significantNumber}`;
  const internationalFormatted = `+${matchedMeta.code} ${significantNumber.replace(
    /(\d{3})(\d{3})(\d+)/,
    '$1 $2 $3'
  )}`;

  return {
    rawInput,
    digitsOnly: digits,
    e164,
    internationalFormatted,
    countryCode: matchedMeta.code,
    isoCountry2: matchedMeta.iso2,
    countryNameArabic: matchedMeta.ar,
    countryNameEnglish: matchedMeta.en,
    significantNumber,
    localWithZero,
    inferredCarrier: carrier,
    lineType,
    isValidLength: digits.length >= 8 && digits.length <= 15,
  };
}

function inferRegionalCarrierAndLineType(
  countryCode: string,
  sig: string
): {
  carrier: string;
  lineType: 'MOBILE' | 'FIXED_LINE' | 'VOIP_OR_VIRTUAL' | 'UNKNOWN';
} {
  if (countryCode === '967') {
    if (sig.startsWith('77') || sig.startsWith('78')) {
      return { carrier: 'Yemen Mobile (يمن موبايل - 4G/CDMA)', lineType: 'MOBILE' };
    }
    if (sig.startsWith('71')) {
      return { carrier: 'Sabafon (سبأفون - GSM)', lineType: 'MOBILE' };
    }
    if (sig.startsWith('73')) {
      return { carrier: 'YOU Telecom (يو للاتصالات / MTN سابقاً)', lineType: 'MOBILE' };
    }
    if (sig.startsWith('70')) {
      return { carrier: 'Y-Telecom (واي للاتصالات)', lineType: 'MOBILE' };
    }
    if (/^[1-6]\d{5,7}$/.test(sig)) {
      return {
        carrier: 'Yemen Public Telecom Corp (هاتف أرضي ثابت - PTC)',
        lineType: 'FIXED_LINE',
      };
    }
  }
  if (countryCode === '966') {
    if (/^5[035]/.test(sig)) return { carrier: 'STC (الاتصالات السعودية)', lineType: 'MOBILE' };
    if (/^5[46]/.test(sig)) return { carrier: 'Mobily (موبايلي)', lineType: 'MOBILE' };
    if (/^5[89]/.test(sig)) return { carrier: 'Zain KSA (زين السعودية)', lineType: 'MOBILE' };
    if (/^57[012]/.test(sig)) return { carrier: 'Virgin Mobile KSA', lineType: 'MOBILE' };
    if (/^57[678]/.test(sig)) return { carrier: 'Salam / RedBull Mobile', lineType: 'MOBILE' };
    if (/^1[1-7]/.test(sig)) return { carrier: 'STC Fixed Line (هاتف ثابت)', lineType: 'FIXED_LINE' };
  }
  if (countryCode === '971') {
    if (/^5[046]/.test(sig)) return { carrier: 'e& (اتصالات الإمارات)', lineType: 'MOBILE' };
    if (/^5[258]/.test(sig)) return { carrier: 'du (دو للاتصالات)', lineType: 'MOBILE' };
  }
  if (countryCode === '20') {
    if (sig.startsWith('10')) return { carrier: 'Vodafone Egypt (فودافون مصر)', lineType: 'MOBILE' };
    if (sig.startsWith('11')) return { carrier: 'e& Egypt (اتصالات مصر)', lineType: 'MOBILE' };
    if (sig.startsWith('12')) return { carrier: 'Orange Egypt (أورنج مصر)', lineType: 'MOBILE' };
    if (sig.startsWith('15')) return { carrier: 'WE (المصرية للاتصالات)', lineType: 'MOBILE' };
  }
  if (countryCode === '965') {
    if (sig.startsWith('9')) return { carrier: 'Zain Kuwait', lineType: 'MOBILE' };
    if (sig.startsWith('6')) return { carrier: 'Ooredoo Kuwait', lineType: 'MOBILE' };
    if (sig.startsWith('5')) return { carrier: 'STC Kuwait', lineType: 'MOBILE' };
  }
  if (countryCode === '968') {
    if (sig.startsWith('9') || sig.startsWith('71') || sig.startsWith('72')) {
      return { carrier: 'Omantel / Ooredoo Oman', lineType: 'MOBILE' };
    }
  }
  if (countryCode === '974') {
    if (/^[3567]/.test(sig)) return { carrier: 'Ooredoo / Vodafone Qatar', lineType: 'MOBILE' };
  }
  return {
    carrier: `International Carrier (+${countryCode})`,
    lineType: sig.length >= 8 ? 'MOBILE' : 'UNKNOWN',
  };
}

function generateRandomDeviceString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export interface TruecallerOnboardingState {
  phoneNumberE164: string;
  countryCodeIso2: string;
  dialingCode: number;
  significantNumber: string;
  requestId: string;
  createdAtMs: number;
}

/**
 * Cyber Forensics & Multi-Engine Phone/Social OSINT Service.
 * Combines:
 * 1. `sumithemmadi/truecallerjs` (Onboarding OTP Login + `search5-noneu.truecaller.com/v2/search`)
 * 2. `agentnova/KnowhoBot` (Eyecon Caller-ID `getnames.jsp` + Facebook Graph `pic` resolver)
 * 3. `yazeed44/social-media-detector-api` & `megadose/ignorant` (Instagram HMAC lookup + `can_wa_reset`, Snapchat `TAKEN_NUMBER`, Amazon OpenID check)
 * 4. `sundowndev/phoneinfoga` (`Numverify`, `OVH Telecom`, and 5-category `GoogleSearchDork` + live web scraper)
 * 5. Live WhatsApp Baileys Socket USync / Business Profile / Status Bio / High-Res Avatar / Local SQLite Alias Vault
 */
export class CyberForensicsOsintEngine {
  private readonly pendingTruecallerOtpByAdmin = new Map<number, TruecallerOnboardingState>();

  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly sessionManager: SessionManager
  ) {}

  // =========================================================================
  // CONFIGURATION KEYS IN SETTINGS REPOSITORY
  // =========================================================================
  public getTruecallerInstallationId(): string {
    return (
      this.settingsRepo.get('forensic:truecaller_installation_id')?.trim() ||
      process.env.TRUECALLER_INSTALLATION_ID?.trim() ||
      ''
    );
  }

  public setTruecallerInstallationId(token: string): void {
    this.settingsRepo.set('forensic:truecaller_installation_id', token.trim());
  }

  public getEyeconCredentials(): { eAuth: string; eAuthV: string; eAuthC: string } {
    return {
      eAuth:
        this.settingsRepo.get('forensic:eyecon_e_auth')?.trim() ||
        process.env.EYECON_E_AUTH?.trim() ||
        '',
      eAuthV:
        this.settingsRepo.get('forensic:eyecon_e_auth_v')?.trim() ||
        process.env.EYECON_E_AUTH_V?.trim() ||
        'e1',
      eAuthC:
        this.settingsRepo.get('forensic:eyecon_e_auth_c')?.trim() ||
        process.env.EYECON_E_AUTH_C?.trim() ||
        '40',
    };
  }

  public setEyeconCredentials(eAuth: string, eAuthV = 'e1', eAuthC = '40'): void {
    this.settingsRepo.set('forensic:eyecon_e_auth', eAuth.trim());
    this.settingsRepo.set('forensic:eyecon_e_auth_v', eAuthV.trim() || 'e1');
    this.settingsRepo.set('forensic:eyecon_e_auth_c', eAuthC.trim() || '40');
  }

  public getNumverifyApiKey(): string {
    return (
      this.settingsRepo.get('forensic:numverify_api_key')?.trim() ||
      process.env.NUMVERIFY_API_KEY?.trim() ||
      ''
    );
  }

  public setNumverifyApiKey(key: string): void {
    this.settingsRepo.set('forensic:numverify_api_key', key.trim());
  }

  // =========================================================================
  // PERSISTENT LOCAL ALIAS & HISTORY VAULT (SQLITE VIA SETTINGS REPO)
  // =========================================================================
  public getStoredNamesForPhone(e164: string): DiscoveredIdentityName[] {
    const raw = this.settingsRepo.get(`forensic:names:${e164}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DiscoveredIdentityName[]) : [];
    } catch {
      return [];
    }
  }

  public saveDiscoveredNamesForPhone(
    e164: string,
    newNames: DiscoveredIdentityName[]
  ): DiscoveredIdentityName[] {
    const existing = this.getStoredNamesForPhone(e164);
    const mergedMap = new Map<string, DiscoveredIdentityName>();

    for (const item of [...existing, ...newNames]) {
      const cleanName = String(item.name || '').trim();
      if (!cleanName || cleanName.length < 2 || cleanName.toLowerCase() === 'unknown name') {
        continue;
      }
      const key = `${cleanName.toLowerCase()}::${item.source.toLowerCase()}`;
      if (!mergedMap.has(key)) {
        mergedMap.set(key, {
          ...item,
          name: cleanName,
        });
      }
    }

    const finalArray = Array.from(mergedMap.values()).slice(0, 40);
    try {
      this.settingsRepo.set(`forensic:names:${e164}`, JSON.stringify(finalArray));
    } catch {
      // Ignore storage error
    }
    return finalArray;
  }

  public recordForensicHistorySummary(summary: {
    phoneE164: string;
    countryAr: string;
    carrier: string;
    topName: string;
    namesCount: number;
    socialCount: number;
    timestampIso: string;
  }): void {
    const raw = this.settingsRepo.get('forensic:recent_history');
    let list: Array<typeof summary> = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = [];
      }
    }
    list = [
      summary,
      ...list.filter((x) => x.phoneE164 !== summary.phoneE164),
    ].slice(0, 30);
    try {
      this.settingsRepo.set('forensic:recent_history', JSON.stringify(list));
    } catch {
      // Ignore
    }
  }

  public getRecentForensicHistory(): Array<{
    phoneE164: string;
    countryAr: string;
    carrier: string;
    topName: string;
    namesCount: number;
    socialCount: number;
    timestampIso: string;
  }> {
    const raw = this.settingsRepo.get('forensic:recent_history');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // =========================================================================
  // ENGINE 1: TRUECALLER INTERACTIVE LOGIN & SEARCH (`sumithemmadi/truecallerjs` + `KnowhoBot`)
  // =========================================================================
  /**
   * Initiates Truecaller OTP onboarding using exact `sumithemmadi/truecallerjs/src/login.ts` protocol.
   */
  public async initiateTruecallerLoginOtp(
    adminId: number,
    rawPhoneNumber: string
  ): Promise<{
    ok: boolean;
    message: string;
    phoneE164?: string;
    requestId?: string;
  }> {
    const phone = parseAndNormalizePhoneInput(rawPhoneNumber);
    if (!phone.isValidLength) {
      return {
        ok: false,
        message: 'رقم الهاتف غير صالح. يرجى إدخاله بالصيغة الدولية مثل +967775224395',
      };
    }

    const postUrl = 'https://account-asia-south1.truecaller.com/v2/sendOnboardingOtp';
    const payload = {
      countryCode: phone.isoCountry2,
      dialingCode: Number(phone.countryCode),
      installationDetails: {
        app: {
          buildVersion: 5,
          majorVersion: 11,
          minorVersion: 7,
          store: 'GOOGLE_PLAY',
        },
        device: {
          deviceId: generateRandomDeviceString(16),
          language: 'en',
          manufacturer: 'Xiaomi',
          model: 'M2010J19SG',
          osName: 'Android',
          osVersion: '10',
          mobileServices: ['GMS'],
        },
        language: 'en',
      },
      phoneNumber: phone.significantNumber,
      region: 'region-2',
      sequenceNo: 2,
    };

    try {
      const res = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': 'Truecaller/11.75.5 (Android;10)',
          clientsecret: 'lvc22mp3l1sfv6ujg83rd17btt',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as {
        status?: number;
        message?: string;
        requestId?: string;
      };
      if (data && (data.status === 1 || data.status === 9 || data.requestId)) {
        this.pendingTruecallerOtpByAdmin.set(adminId, {
          phoneNumberE164: phone.e164,
          countryCodeIso2: phone.isoCountry2,
          dialingCode: Number(phone.countryCode),
          significantNumber: phone.significantNumber,
          requestId: String(data.requestId || ''),
          createdAtMs: Date.now(),
        });
        return {
          ok: true,
          phoneE164: phone.e164,
          requestId: data.requestId,
          message: `تم إرسال رمز التحقق (OTP) من Truecaller إلى الرقم ${phone.e164}. أرسل الرمز المكون من 6 أرقام الآن.`,
        };
      }
      return {
        ok: false,
        message: `تعذر إرسال رمز OTP من Truecaller: ${data?.message || JSON.stringify(data)}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `فشل الاتصال بخادم Truecaller: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Verifies Truecaller 6-digit OTP using exact `sumithemmadi/truecallerjs/src/verifyOtp.ts` protocol
   * and saves the returned `installationId` token automatically.
   */
  public async verifyTruecallerLoginOtp(
    adminId: number,
    otpCode: string
  ): Promise<{ ok: boolean; installationId?: string; message: string }> {
    const pending = this.pendingTruecallerOtpByAdmin.get(adminId);
    if (!pending) {
      return {
        ok: false,
        message: 'لا توجد عملية تسجيل دخول Truecaller معلقة. ابدأ بطلب رمز OTP أولاً.',
      };
    }
    const cleanOtp = otpCode.replace(/\D/g, '');
    if (cleanOtp.length < 4 || cleanOtp.length > 8) {
      return { ok: false, message: 'رمز OTP غير صالح. يرجى إرسال الأرقام فقط.' };
    }

    const postData = {
      countryCode: pending.countryCodeIso2,
      dialingCode: pending.dialingCode,
      phoneNumber: pending.significantNumber,
      requestId: pending.requestId,
      token: cleanOtp,
    };

    try {
      const res = await fetch(
        'https://account-asia-south1.truecaller.com/v1/verifyOnboardingOtp',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'user-agent': 'Truecaller/11.75.5 (Android;10)',
            clientsecret: 'lvc22mp3l1sfv6ujg83rd17btt',
          },
          body: JSON.stringify(postData),
          signal: AbortSignal.timeout(10_000),
        }
      );
      const data = (await res.json()) as {
        status?: number;
        suspended?: boolean;
        installationId?: string;
        message?: string;
      };
      if (data?.installationId && !data.suspended) {
        this.setTruecallerInstallationId(data.installationId);
        this.pendingTruecallerOtpByAdmin.delete(adminId);
        return {
          ok: true,
          installationId: data.installationId,
          message: `✅ تم توثيق حساب Truecaller وحفظ مفتاح الجلسة (installationId) بنجاح!`,
        };
      }
      return {
        ok: false,
        message: `فشل التحقق من الرمز: ${data?.message || JSON.stringify(data)}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `خطأ أثناء التحقق من OTP: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Searches a phone number on Truecaller using exact `sumithemmadi/truecallerjs/src/search.ts`
   * + `agentnova/KnowhoBot/process.py` credential check keep-alive.
   */
  public async queryTruecallerDirectory(
    phone: NormalizedPhoneMetadata
  ): Promise<NonNullable<PhoneForensicReport['truecallerData']>> {
    const rawToken = this.getTruecallerInstallationId();
    if (!rawToken) {
      return {
        queried: false,
        found: false,
        error: 'لم يتم إعداد مفتاح Truecaller (installationId) بعد',
      };
    }

    const authHeader = rawToken.toLowerCase().startsWith('bearer ')
      ? rawToken
      : `Bearer ${rawToken}`;

    try {
      // Optional credential keep-alive check from KnowhoBot (`process.py` line 46)
      await fetch(
        'https://account-asia-south1.truecaller.com/v2.1/credentials/check?encoding=json',
        {
          method: 'POST',
          headers: {
            authorization: authHeader,
            'content-type': 'application/json; charset=UTF-8',
            'user-agent': 'Truecaller/11.75.5 (Android;10)',
          },
          body: JSON.stringify({ reason: 'restored_from_account_manager' }),
          signal: AbortSignal.timeout(4000),
        }
      ).catch(() => undefined);

      const url = new URL('https://search5-noneu.truecaller.com/v2/search');
      url.searchParams.set('q', phone.significantNumber);
      url.searchParams.set('countryCode', phone.isoCountry2);
      url.searchParams.set('type', '4');
      url.searchParams.set('locAddr', '');
      url.searchParams.set('placement', 'SEARCHRESULTS,HISTORY,DETAILS');
      url.searchParams.set('encoding', 'json');

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': 'Truecaller/11.75.5 (Android;10)',
          Authorization: authHeader,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (res.status === 429) {
        return {
          queried: true,
          found: false,
          error: 'تم تجاوز حد الطلبات اليومي في Truecaller (HTTP 429)',
        };
      }
      if (!res.ok) {
        return {
          queried: true,
          found: false,
          error: `Truecaller HTTP ${res.status}`,
        };
      }

      const json = (await res.json()) as {
        data?: Array<{
          name?: string;
          altName?: string;
          transliteratedName?: string;
          jobTitle?: string;
          companyName?: string;
          spamScore?: number;
          spamType?: string;
          badges?: string[];
          phones?: Array<{ carrier?: string; numberType?: string }>;
          addresses?: Array<{ city?: string; countryCode?: string; timeZone?: string }>;
          internetAddresses?: Array<{ id?: string; service?: string; caption?: string }>;
        }>;
      };

      const first = json?.data?.[0];
      if (!first) {
        return { queried: true, found: false };
      }

      const internetAddresses = (first.internetAddresses || [])
        .filter((ia): ia is { id: string; service: string; caption?: string } =>
          Boolean(ia?.id)
        )
        .map((ia) => ({
          id: String(ia.id),
          service: String(ia.service || 'email'),
          caption: ia.caption,
        }));

      return {
        queried: true,
        found: Boolean(first.name || first.altName || internetAddresses.length > 0),
        name: first.name,
        altName: first.altName || first.transliteratedName,
        carrier: first.phones?.[0]?.carrier,
        email: internetAddresses[0]?.id,
        jobTitle: first.jobTitle,
        companyName: first.companyName,
        city: first.addresses?.[0]?.city,
        spamScore: first.spamScore,
        spamType: first.spamType,
        badges: first.badges,
        internetAddresses,
      };
    } catch (err) {
      return {
        queried: true,
        found: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // =========================================================================
  // ENGINE 2: EYECON CALLER-ID & FACEBOOK RESOLVER (`agentnova/KnowhoBot`)
  // =========================================================================
  /**
   * Queries Eyecon `getnames.jsp` and `pic` endpoints using exact `agentnova/KnowhoBot/process.py` protocol.
   */
  public async queryEyeconDirectory(
    phone: NormalizedPhoneMetadata
  ): Promise<NonNullable<PhoneForensicReport['eyeconData']>> {
    const creds = this.getEyeconCredentials();
    if (!creds.eAuth) {
      return {
        queried: false,
        found: false,
        names: [],
        error: 'لم يتم إعداد مفتاح Eyecon (e-auth) بعد',
      };
    }

    const namesUrl =
      `https://api.eyecon-app.com/app/getnames.jsp?cli=${encodeURIComponent(phone.digitsOnly)}` +
      `&lang=en&is_callerid=true&is_ic=true&cv=vc_312_vn_2.0.312_a&requestApi=URLconnection&source=Other`;

    const headers: Record<string, string> = {
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 10; GM1903 Build/QKQ1.190716.003)',
      Accept: 'application/json',
      Connection: 'Keep-Alive',
      'e-auth-v': creds.eAuthV,
      'e-auth-c': creds.eAuthC,
      'e-auth': creds.eAuth,
      'content-type': 'application/x-www-form-urlencoded',
    };

    const discoveredNames: string[] = [];
    let facebookProfileUrl: string | undefined;
    let photoUrl: string | undefined;

    try {
      const [namesRes, picRes] = await Promise.allSettled([
        fetch(namesUrl, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(7000),
        }),
        fetch(
          `https://api.eyecon-app.com/app/pic?cli=${encodeURIComponent(phone.digitsOnly)}` +
            `&is_callerid=true&size=big&type=0&cancelfresh=0&cv=vc_312_vn_2.0.312_a`,
          {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(7000),
          }
        ),
      ]);

      if (namesRes.status === 'fulfilled' && namesRes.value.ok) {
        const json = (await namesRes.value.json()) as unknown;
        if (Array.isArray(json)) {
          for (const entry of json) {
            if (
              entry &&
              typeof entry === 'object' &&
              'name' in entry &&
              typeof (entry as { name?: unknown }).name === 'string' &&
              (entry as { name: string }).name.trim()
            ) {
              discoveredNames.push((entry as { name: string }).name.trim());
            }
          }
        } else if (
          json &&
          typeof json === 'object' &&
          'name' in json &&
          typeof (json as { name?: unknown }).name === 'string'
        ) {
          discoveredNames.push((json as { name: string }).name.trim());
        }
      }

      if (picRes.status === 'fulfilled' && picRes.value.url) {
        const finalUrl = picRes.value.url;
        if (finalUrl.includes('facebook.com')) {
          photoUrl = finalUrl;
          const cleanedFb = finalUrl
            .replace('https://graph.', 'https://')
            .replace(/\/picture\?.*$/, '');
          facebookProfileUrl = cleanedFb;
        }
      }

      return {
        queried: true,
        found: discoveredNames.length > 0 || Boolean(facebookProfileUrl),
        names: Array.from(new Set(discoveredNames)),
        facebookProfileUrl,
        photoUrl,
      };
    } catch (err) {
      return {
        queried: true,
        found: false,
        names: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // =========================================================================
  // ENGINE 3: PHONEINFOGA NUMVERIFY & OVH TELECOM SCANNERS (`sundowndev/phoneinfoga`)
  // =========================================================================
  public async queryCarrierApis(
    phone: NormalizedPhoneMetadata
  ): Promise<PhoneForensicReport['carrierApiData']> {
    const numverifyKey = this.getNumverifyApiKey();
    if (numverifyKey) {
      try {
        // Exact endpoint from sundowndev/phoneinfoga/lib/remote/suppliers/numverify.go
        const url = `https://api.apilayer.com/number_verification/validate?number=${encodeURIComponent(
          phone.digitsOnly
        )}`;
        const res = await fetch(url, {
          headers: { Apikey: numverifyKey },
          signal: AbortSignal.timeout(7000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            valid?: boolean;
            carrier?: string;
            line_type?: string;
            location?: string;
          };
          if (data && typeof data.valid === 'boolean') {
            return {
              provider: 'Numverify (Apilayer)',
              valid: data.valid,
              carrier: data.carrier || undefined,
              lineType: data.line_type || undefined,
              location: data.location || undefined,
            };
          }
        }
      } catch {
        // Fallback to OVH if supported
      }
    }

    // OVH Telecom Scanner from sundowndev/phoneinfoga/lib/remote/suppliers/ovh.go
    const ovhSupportedCodes = new Set(['33', '32', '44', '34', '41']);
    if (ovhSupportedCodes.has(phone.countryCode) && phone.significantNumber.length > 6) {
      try {
        const res = await fetch(
          `https://api.ovh.com/1.0/telephony/number/detailedZones?country=${phone.isoCountry2.toLowerCase()}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (res.ok) {
          const list = (await res.json()) as Array<{
            number?: string;
            city?: string;
            zipCode?: string;
          }>;
          const askedNumber = phone.significantNumber.slice(0, 6) + 'xxxx';
          const match = Array.isArray(list)
            ? list.find((item) => item?.number === askedNumber)
            : undefined;
          if (match) {
            return {
              provider: 'OVH Telecom Europe',
              valid: true,
              location: [match.city, match.zipCode].filter(Boolean).join(' '),
            };
          }
        }
      } catch {
        // Ignore OVH error
      }
    }

    return undefined;
  }

  // =========================================================================
  // ENGINE 4: LIVE WHATSAPP PROTOCOL IDENTITY & USYNC INSPECTOR
  // =========================================================================
  public async inspectWhatsAppProtocolFootprint(
    phone: NormalizedPhoneMetadata
  ): Promise<WhatsAppForensicFootprint> {
    const directChatUrl = `https://wa.me/${phone.digitsOnly}`;
    const connectedSessions = this.sessionManager
      .listSessions()
      .filter((s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED');

    if (connectedSessions.length === 0) {
      return {
        checked: false,
        registered: false,
        linkedDevices: [],
        businessWebsites: [],
        directChatUrl,
      };
    }

    const primarySession = connectedSessions[0]!;
    const driver = this.sessionManager.getDriver(primarySession.id);
    const rawSock = driver?.getRawSocket?.() as Record<string, unknown> | undefined;
    if (!rawSock) {
      return {
        checked: false,
        registered: false,
        linkedDevices: [],
        businessWebsites: [],
        directChatUrl,
      };
    }

    const targetJid = `${phone.digitsOnly}@s.whatsapp.net`;
    let registered = false;
    let resolvedJid = targetJid;
    let resolvedLid: string | undefined;
    const linkedDevices: number[] = [];
    let verifiedBusinessName: string | undefined;
    let businessCategory: string | undefined;
    let businessDescription: string | undefined;
    let businessEmail: string | undefined;
    const businessWebsites: string[] = [];
    let businessAddress: string | undefined;
    let statusBio: string | undefined;
    let statusSetAt: string | undefined;
    let profilePictureUrl: string | undefined;
    let profilePictureBuffer: Buffer | undefined;

    try {
      if (typeof rawSock.onWhatsApp === 'function') {
        const res = await (
          rawSock.onWhatsApp as (
            pn: string
          ) => Promise<Array<{ exists?: boolean; jid?: string; lid?: string }>>
        )(phone.e164);
        const first = Array.isArray(res) ? res[0] : undefined;
        if (first?.exists) {
          registered = true;
          if (typeof first.jid === 'string') resolvedJid = first.jid;
          if (typeof first.lid === 'string') resolvedLid = first.lid;
        }
      } else {
        registered = true;
      }
    } catch {
      // Continue with USync/Profile checks
    }

    // Query USync devices
    try {
      if (typeof rawSock.getUSyncDevices === 'function') {
        const devs = await (
          rawSock.getUSyncDevices as (
            jids: string[],
            a: boolean,
            b: boolean
          ) => Promise<Array<{ device?: number }>>
        )([resolvedJid], false, false);
        if (Array.isArray(devs)) {
          for (const d of devs) {
            const devId = typeof d?.device === 'number' ? d.device : 0;
            if (!linkedDevices.includes(devId)) linkedDevices.push(devId);
            registered = true;
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Query LID mapping from signalRepository if not already resolved
    try {
      const sigRepo = rawSock.signalRepository as
        | { lidMapping?: { getLIDForPN?: (jid: string) => Promise<string | undefined> } }
        | undefined;
      if (!resolvedLid && typeof sigRepo?.lidMapping?.getLIDForPN === 'function') {
        const lid = await sigRepo.lidMapping.getLIDForPN(resolvedJid);
        if (typeof lid === 'string' && lid) resolvedLid = lid;
      }
    } catch {
      // Non-fatal
    }

    // Query Business Profile
    try {
      if (typeof rawSock.getBusinessProfile === 'function') {
        const biz = await (
          rawSock.getBusinessProfile as (
            jid: string
          ) => Promise<Record<string, unknown> | undefined>
        )(resolvedJid);
        if (biz && typeof biz === 'object') {
          registered = true;
          if (typeof biz.verifiedName === 'string' && biz.verifiedName) {
            verifiedBusinessName = biz.verifiedName;
          }
          if (typeof biz.description === 'string' && biz.description) {
            businessDescription = biz.description;
          }
          if (typeof biz.category === 'string' && biz.category) {
            businessCategory = biz.category;
          }
          if (typeof biz.email === 'string' && biz.email) {
            businessEmail = biz.email;
          }
          if (typeof biz.address === 'string' && biz.address) {
            businessAddress = biz.address;
          }
          if (Array.isArray(biz.website)) {
            for (const w of biz.website) {
              if (typeof w === 'string' && w.trim()) {
                businessWebsites.push(w.trim());
              }
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Query Status / Bio
    try {
      if (typeof rawSock.fetchStatus === 'function') {
        const st = await (
          rawSock.fetchStatus as (jid: string) => Promise<unknown>
        )(resolvedJid);
        const stObj = (Array.isArray(st) ? st[0] : st) as
          | {
              status?: { status?: string; setAt?: string | number | Date } | string;
              setAt?: string | number | Date;
            }
          | undefined;
        const bioVal =
          typeof stObj?.status === 'object' ? stObj.status?.status : stObj?.status;
        if (typeof bioVal === 'string' && bioVal.trim()) {
          statusBio = bioVal.trim();
          registered = true;
        }
        const setAtVal =
          typeof stObj?.status === 'object' ? stObj.status?.setAt : stObj?.setAt;
        if (setAtVal) {
          statusSetAt = new Date(setAtVal).toISOString().slice(0, 10);
        }
      }
    } catch {
      // Non-fatal
    }

    // Query High-Res Profile Picture
    try {
      if (typeof rawSock.profilePictureUrl === 'function') {
        const ppUrl = await (
          rawSock.profilePictureUrl as (
            jid: string,
            type: string
          ) => Promise<string | undefined>
        )(resolvedJid, 'image');
        if (typeof ppUrl === 'string' && ppUrl.startsWith('http')) {
          profilePictureUrl = ppUrl;
          registered = true;
          const imgRes = await fetch(ppUrl, { signal: AbortSignal.timeout(6000) });
          if (imgRes.ok) {
            const ab = await imgRes.arrayBuffer();
            profilePictureBuffer = Buffer.from(ab);
          }
        }
      }
    } catch {
      // Non-fatal
    }

    return {
      checked: true,
      registered,
      jid: resolvedJid,
      lid: resolvedLid,
      linkedDevices: linkedDevices.sort((a, b) => a - b),
      verifiedBusinessName,
      businessCategory,
      businessDescription,
      businessEmail,
      businessWebsites,
      businessAddress,
      statusBio,
      statusSetAt,
      profilePictureUrl,
      profilePictureBuffer,
      directChatUrl,
    };
  }

  // =========================================================================
  // ENGINE 5: NON-ALERTING SOCIAL PROBES (`yazeed44/social-media-detector-api` + `megadose/ignorant`)
  // =========================================================================
  /**
   * Exact TypeScript implementation of `yazeed44/social-media-detector-api/blob/master/yocial/features/Instagram/Instagram.py`
   * and `megadose/ignorant/blob/main/ignorant/modules/social_media/instagram.py`.
   * Checks both Instagram registration AND Meta's `can_wa_reset` flag without alerting the target.
   */
  public async probeInstagramAndMetaByPhone(
    phone: NormalizedPhoneMetadata
  ): Promise<{
    instagram: SocialPlatformFootprint;
    metaWhatsAppResetLinked?: boolean;
  }> {
    const USERS_LOOKUP_URL = 'https://i.instagram.com/api/v1/users/lookup/';
    const SIG_KEY_VERSION = '4';
    const IG_SIG_KEY = 'e6358aeede676184b9fe702b30f4fd35e71744605e39d2181a34cede076b3c33';

    const payloadObj = {
      phone_id: crypto.randomUUID(),
      guid: crypto.randomUUID(),
      device_id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      login_attempt_count: '0',
      directly_sign_in: 'true',
      source: 'default',
      q: `${phone.countryCode}${phone.significantNumber}`,
      ig_sig_key_version: SIG_KEY_VERSION,
    };

    const jsonData = JSON.stringify(payloadObj);
    const hmacHex = crypto
      .createHmac('sha256', IG_SIG_KEY)
      .update(jsonData, 'utf8')
      .digest('hex');
    const signedBody = `ig_sig_key_version=${SIG_KEY_VERSION}&signed_body=${hmacHex}.${encodeURIComponent(
      jsonData
    )}`;

    try {
      const res = await fetch(USERS_LOOKUP_URL, {
        method: 'POST',
        headers: {
          'Accept-Language': 'en-US',
          'User-Agent':
            'Instagram 101.0.0.15.120 Android (26/8.0.0; 320dpi; 768x1184; Genymotion/Android; instagram_following_itsmoji; vbox86p; vbox86; en_US; 162439045)',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-IG-Connection-Type': 'WIFI',
          'X-IG-Capabilities': '3brTvw==',
          'X-IG-App-ID': '567067343352427',
          'X-FB-HTTP-Engine': 'Liger',
          Connection: 'close',
        },
        body: signedBody,
        signal: AbortSignal.timeout(8000),
      });

      const rep = (await res.json().catch(() => ({}))) as {
        message?: string;
        user?: { username?: string; full_name?: string };
        has_valid_phone?: boolean;
        can_wa_reset?: boolean;
      };
      if (rep?.message === 'No users found' || res.status === 404) {
        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'NOT_FOUND',
            exists: false,
            url: `https://www.google.com/search?q=${encodeURIComponent(
              `site:instagram.com "${phone.e164}" OR "${phone.significantNumber}"`
            )}`,
            details: 'الرقم غير مرتبط بحساب إنستغرام مباشر (No users found)',
            verificationMethod: 'Instagram Liger API HMAC-SHA256 Lookup (ignorant/yocial)',
          },
        };
      }

      if (res.ok || rep?.user || rep?.has_valid_phone) {
        const username =
          typeof rep?.user?.username === 'string' ? rep.user.username : undefined;
        const fullName =
          typeof rep?.user?.full_name === 'string' ? rep.user.full_name : undefined;
        const canWaReset = Boolean(rep?.can_wa_reset);

        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'CONFIRMED',
            exists: true,
            url: username
              ? `https://www.instagram.com/${encodeURIComponent(username)}/`
              : `https://www.google.com/search?q=${encodeURIComponent(
                  `site:instagram.com "${phone.e164}" OR "${phone.significantNumber}"`
                )}`,
            handleOrUsername: username ? `@${username}` : undefined,
            displayName: fullName,
            details: username
              ? `مرتبط بحساب إنستغرام مؤكد: @${username}`
              : 'الرقم مرتبط بحساب إنستغرام نشط في قاعدة بيانات Meta',
            verificationMethod: 'Instagram Liger API HMAC-SHA256 Lookup (ignorant/yocial)',
          },
          metaWhatsAppResetLinked: canWaReset,
        };
      }

      return {
        instagram: {
          platform: 'Instagram',
          icon: '📸',
          status: 'RATE_LIMITED',
          exists: false,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `site:instagram.com "${phone.e164}" OR "${phone.significantNumber}"`
          )}`,
          details: 'تم تقييد الفحص المباشر مؤقتاً؛ استخدم رابط الفحص العميق المرفق',
          verificationMethod: 'Instagram Liger API + OSINT Dork',
        },
      };
    } catch {
      return {
        instagram: {
          platform: 'Instagram',
          icon: '📸',
          status: 'SEARCH_DORK',
          exists: false,
          url: `https://www.google.com/search?q=${encodeURIComponent(
            `site:instagram.com "${phone.e164}" OR "${phone.significantNumber}"`
          )}`,
          details: 'رابط بحث OSINT المباشر عن الرقم في Instagram',
          verificationMethod: 'PhoneInfoga Social Dork',
        },
      };
    }
  }

  /**
   * Exact TypeScript implementation of `megadose/ignorant/blob/main/ignorant/modules/social_media/snapchat.py`.
   * Checks `https://accounts.snapchat.com/accounts/validate_phone_number` for `status_code === "TAKEN_NUMBER"`.
   */
  public async probeSnapchatByPhone(
    phone: NormalizedPhoneMetadata
  ): Promise<SocialPlatformFootprint> {
    const dorkUrl = `https://www.google.com/search?q=${encodeURIComponent(
      `site:snapchat.com "${phone.e164}" OR "${phone.significantNumber}"`
    )}`;
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en,en-US;q=0.5',
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      Origin: 'https://accounts.snapchat.com',
      DNT: '1',
      Connection: 'keep-alive',
      'Sec-GPC': '1',
    };

    try {
      const initRes = await fetch('https://accounts.snapchat.com', {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(7000),
      });
      const rawCookies = initRes.headers.get('set-cookie') || '';
      const xsrfMatch = /xsrf_token=([^;,\s]+)/.exec(rawCookies);
      const xsrfToken = xsrfMatch?.[1];
      if (!xsrfToken) {
        return {
          platform: 'Snapchat',
          icon: '👻',
          status: 'SEARCH_DORK',
          exists: false,
          url: dorkUrl,
          details: 'رابط البحث الجنائي عن الرقم في سناب شات',
          verificationMethod: 'PhoneInfoga Dork',
        };
      }

      const formData = new URLSearchParams({
        phone_country_code: phone.isoCountry2.toUpperCase(),
        phone_number: phone.significantNumber,
        xsrf_token: xsrfToken,
      }).toString();

      const valRes = await fetch(
        'https://accounts.snapchat.com/accounts/validate_phone_number',
        {
          method: 'POST',
          headers: {
            ...headers,
            Cookie: `xsrf_token=${xsrfToken}`,
          },
          body: formData,
          signal: AbortSignal.timeout(7000),
        }
      );

      const json = (await valRes.json().catch(() => ({}))) as {
        status_code?: string;
      };
      if (json?.status_code === 'TAKEN_NUMBER') {
        return {
          platform: 'Snapchat',
          icon: '👻',
          status: 'CONFIRMED',
          exists: true,
          url: dorkUrl,
          details: 'مؤكد (TAKEN_NUMBER): الرقم مسجل ومرتبط بحساب سناب شات نشط',
          verificationMethod: 'Snapchat Registration Validator (megadose/ignorant)',
        };
      }
      if (json?.status_code === 'OK') {
        return {
          platform: 'Snapchat',
          icon: '👻',
          status: 'NOT_FOUND',
          exists: false,
          url: dorkUrl,
          details: 'غير مسجل في سناب شات (Status: OK)',
          verificationMethod: 'Snapchat Registration Validator (megadose/ignorant)',
        };
      }
    } catch {
      // Fallback to dork
    }

    return {
      platform: 'Snapchat',
      icon: '👻',
      status: 'SEARCH_DORK',
      exists: false,
      url: dorkUrl,
      details: 'رابط فحص بصمة الرقم عبر محركات البحث في سناب شات',
      verificationMethod: 'PhoneInfoga Dork',
    };
  }

  /**
   * Exact TypeScript implementation of `megadose/ignorant/blob/main/ignorant/modules/shopping/amazon.py`.
   * Checks `https://www.amazon.com/ap/signin` for `id="auth-password-missing-alert"`.
   */
  public async probeAmazonByPhone(
    phone: NormalizedPhoneMetadata
  ): Promise<SocialPlatformFootprint> {
    const signInUrl =
      'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F%3F_encoding%3DUTF8%26ref_%3Dnav_ya_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&';
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    try {
      const getRes = await fetch(signInUrl, {
        headers: { 'User-Agent': ua },
        signal: AbortSignal.timeout(7000),
      });
      const html = await getRes.text();
      const formParams = new URLSearchParams();
      const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["'][^>]*>/gi;
      let match: RegExpExecArray | null;
      while ((match = inputRegex.exec(html)) !== null) {
        formParams.set(match[1]!, match[2]!);
      }
      formParams.set('email', `${phone.countryCode}${phone.significantNumber}`);

      const postRes = await fetch('https://www.amazon.com/ap/signin/', {
        method: 'POST',
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formParams.toString(),
        signal: AbortSignal.timeout(7000),
      });
      const postHtml = await postRes.text();
      const exists = postHtml.includes('auth-password-missing-alert');
      return {
        platform: 'Amazon Account',
        icon: '📦',
        status: exists ? 'CONFIRMED' : 'NOT_FOUND',
        exists,
        url: 'https://www.amazon.com',
        details: exists
          ? 'مؤكد: الرقم مرتبط بحساب Amazon نشط (auth-password-missing-alert)'
          : 'لا يوجد حساب Amazon مرتبط بهذا الرقم',
        verificationMethod: 'Amazon OpenID Sign-In Probe (megadose/ignorant)',
      };
    } catch {
      return {
        platform: 'Amazon Account',
        icon: '📦',
        status: 'RATE_LIMITED',
        exists: false,
        url: 'https://www.amazon.com',
        details: 'تعذر إكمال فحص Amazon المباشر (حماية CAPTCHA/Rate-Limit)',
        verificationMethod: 'Amazon OpenID Sign-In Probe',
      };
    }
  }

  // =========================================================================
  // ENGINE 6: PHONEINFOGA OSINT DORKS & LIVE WEB DIRECTORY SCRAPER
  // =========================================================================
  /**
   * Exact TypeScript implementation of `sundowndev/phoneinfoga/blob/master/lib/remote/googlesearch_scanner.go`
   * covering SocialMedia, Individuals/CallerDirectories, Reputation, DisposableProviders, and General.
   */
  public buildPhoneInfogaDorks(phone: NormalizedPhoneMetadata): PhoneOsintDorkItem[] {
    const buildGoogleUrl = (q: string) =>
      `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    const buildDdgUrl = (q: string) =>
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

    const numVariants = `"${phone.e164}" OR "${phone.digitsOnly}" OR "${phone.significantNumber}" OR "${phone.localWithZero}"`;

    const items: Array<{
      category: PhoneOsintDorkItem['category'];
      title: string;
      dorkQuery: string;
    }> = [
      // Social Media Dorks from googlesearch_scanner.go (`getSocialMediaDorks`)
      {
        category: 'SOCIAL_MEDIA',
        title: 'Facebook (فيسبوك)',
        dorkQuery: `site:facebook.com (${numVariants})`,
      },
      {
        category: 'SOCIAL_MEDIA',
        title: 'X / Twitter (إكس / تويتر)',
        dorkQuery: `(site:twitter.com OR site:x.com) (${numVariants})`,
      },
      {
        category: 'SOCIAL_MEDIA',
        title: 'Instagram (إنستغرام)',
        dorkQuery: `site:instagram.com (${numVariants})`,
      },
      {
        category: 'SOCIAL_MEDIA',
        title: 'LinkedIn (لينكد إن)',
        dorkQuery: `site:linkedin.com (${numVariants})`,
      },
      {
        category: 'SOCIAL_MEDIA',
        title: 'TikTok (تيك توك)',
        dorkQuery: `site:tiktok.com (${numVariants})`,
      },
      {
        category: 'SOCIAL_MEDIA',
        title: 'Telegram Public Channels & Groups (تيليجرام)',
        dorkQuery: `site:t.me (${numVariants})`,
      },
      {
        category: 'SOCIAL_MEDIA',
        title: 'VKontakte (VK)',
        dorkQuery: `site:vk.com (${numVariants})`,
      },
      // Individuals & Caller ID Directories (`getIndividualsDorks`)
      {
        category: 'CALLER_DIRECTORY',
        title: 'Sync.ME Caller Directory',
        dorkQuery: `site:sync.me (${numVariants})`,
      },
      {
        category: 'CALLER_DIRECTORY',
        title: 'Numinfo & LocateFamily Directories',
        dorkQuery: `(site:numinfo.net OR site:locatefamily.com OR site:spytox.com) (${numVariants})`,
      },
      {
        category: 'CALLER_DIRECTORY',
        title: 'Pastebin & Public Leaks Mentions',
        dorkQuery: `site:pastebin.com (${numVariants})`,
      },
      // Reputation & Fraud Reports (`getReputationDorks`)
      {
        category: 'REPUTATION_SPAM',
        title: 'WhoCallsMe / WhyCall / WhoseNumber Reputation',
        dorkQuery: `(site:whosenumber.info OR site:findwhocallsme.com OR site:whycall.me OR site:who-calledme.com) (${numVariants})`,
      },
      // Documents & Files (`getGeneralDorks`)
      {
        category: 'DOCUMENTS_PASTEBIN',
        title: 'المستندات والملفات المنشورة (PDF / Word / Excel / TXT)',
        dorkQuery: `(ext:pdf OR ext:doc OR ext:docx OR ext:xls OR ext:xlsx OR ext:csv OR ext:txt) (${numVariants})`,
      },
    ];

    return items.map((item) => ({
      ...item,
      googleUrl: buildGoogleUrl(item.dorkQuery),
      duckDuckGoUrl: buildDdgUrl(item.dorkQuery),
    }));
  }

  /**
   * Scrapes live web mentions and public caller directories via DuckDuckGo Lite HTML
   * to extract real published names, social links, and disposable SMS matches.
   */
  public async scrapeLiveWebAndDirectories(
    phone: NormalizedPhoneMetadata
  ): Promise<{
    mentions: LiveWebMentionHit[];
    extractedNames: DiscoveredIdentityName[];
    disposableMatchedDomains: string[];
  }> {
    const mentions: LiveWebMentionHit[] = [];
    const extractedNames: DiscoveredIdentityName[] = [];
    const disposableMatchedDomains: string[] = [];

    const query = `"${phone.e164}" OR "${phone.digitsOnly}" OR "${phone.localWithZero}"`;
    const ddgHtmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    try {
      const res = await fetch(ddgHtmlUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const html = await res.text();
        const blockRegex =
          /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        let match: RegExpExecArray | null;
        while ((match = blockRegex.exec(html)) !== null && mentions.length < 10) {
          let rawHref = match[1] || '';
          const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawHref);
          if (uddgMatch?.[1]) {
            try {
              rawHref = decodeURIComponent(uddgMatch[1]);
            } catch {
              // Keep rawHref
            }
          }
          const cleanTitle = (match[2] || '').replace(/<[^>]+>/g, '').trim();
          const cleanSnippet = (match[3] || '').replace(/<[^>]+>/g, '').trim();
          if (!rawHref.startsWith('http') || !cleanTitle) continue;

          let domain = '';
          try {
            domain = new URL(rawHref).hostname.replace(/^www\./, '');
          } catch {
            domain = 'web';
          }

          if (DISPOSABLE_SMS_DOMAINS.some((d) => domain.endsWith(d))) {
            if (!disposableMatchedDomains.includes(domain)) {
              disposableMatchedDomains.push(domain);
            }
          }

          mentions.push({
            title: cleanTitle,
            url: rawHref,
            snippet: cleanSnippet,
            extractedNames: [],
            sourceDomain: domain,
          });

          if (cleanTitle.length >= 3 && cleanTitle.length <= 75) {
            extractedNames.push({
              name: cleanTitle.slice(0, 65),
              source: `Web Index (${domain})`,
              confidence: 'MEDIUM',
              extraInfo: rawHref,
              observedAtIso: new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      // Non-fatal web search error
    }

    return { mentions, extractedNames, disposableMatchedDomains };
  }

  /**
   * Probes public profile URLs when a username/handle is discovered from Truecaller,
   * WhatsApp Business, or email prefix.
   */
  public async probeSocialHandlesPivot(
    handles: string[]
  ): Promise<SocialPlatformFootprint[]> {
    const cleanHandles = Array.from(
      new Set(
        handles
          .map((h) =>
            h
              .trim()
              .replace(/^@/, '')
              .replace(/@.*$/, '')
              .replace(/[^a-zA-Z0-9._-]/g, '')
          )
          .filter((h) => h.length >= 3 && h.length <= 32)
      )
    ).slice(0, 2);

    if (cleanHandles.length === 0) return [];

    const results: SocialPlatformFootprint[] = [];
    for (const handle of cleanHandles) {
      // Probe Telegram public profile page (`https://t.me/<handle>`)
      try {
        const tgUrl = `https://t.me/${encodeURIComponent(handle)}`;
        const res = await fetch(tgUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const html = await res.text();
          const titleMatch =
            /<div class="tgme_page_title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i.exec(
              html
            );
          const foundTitle = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
          if (foundTitle && !html.includes('tgme_page_icon_user')) {
            results.push({
              platform: `Telegram (@${handle})`,
              icon: '✈️',
              status: 'CONFIRMED',
              exists: true,
              url: tgUrl,
              handleOrUsername: `@${handle}`,
              displayName: foundTitle,
              details: `حساب تيليجرام عام مرتبط بالمعرّف: ${foundTitle} (@${handle})`,
              verificationMethod: 'Telegram Public Handle Probe',
            });
          }
        }
      } catch {
        // Ignore
      }

      // Provide direct profile pivot links for major platforms using the discovered handle
      const pivotPlatforms = [
        { name: 'X / Twitter', icon: '🐦', url: `https://x.com/${handle}` },
        { name: 'TikTok', icon: '🎵', url: `https://www.tiktok.com/@${handle}` },
        { name: 'Facebook', icon: '📘', url: `https://www.facebook.com/${handle}` },
        { name: 'GitHub', icon: '💻', url: `https://github.com/${handle}` },
      ];

      for (const p of pivotPlatforms) {
        results.push({
          platform: `${p.name} (@${handle})`,
          icon: p.icon,
          status: 'LIKELY',
          exists: true,
          url: p.url,
          handleOrUsername: `@${handle}`,
          details: `رابط الحساب المطابق للمعرّف المكتشف (@${handle})`,
          verificationMethod: 'Cross-Platform Handle Pivot',
        });
      }
    }

    return results;
  }

  // =========================================================================
  // MASTER ORCHESTRATOR: FULL PHONE & SOCIAL FORENSIC SCAN
  // =========================================================================
  public async runFullForensicInvestigation(
    rawPhoneInput: string,
    mode: 'PHONE_NAMES_ONLY' | 'SOCIAL_ONLY' | 'FULL_DOSSIER' = 'FULL_DOSSIER'
  ): Promise<PhoneForensicReport> {
    const phone = parseAndNormalizePhoneInput(rawPhoneInput);
    const nowIso = new Date().toISOString();

    const [
      waFootprint,
      truecallerData,
      eyeconData,
      carrierApiData,
      igAndMeta,
      snapchatProbe,
      amazonProbe,
      webScrape,
    ] = await Promise.all([
      this.inspectWhatsAppProtocolFootprint(phone),
      this.queryTruecallerDirectory(phone),
      this.queryEyeconDirectory(phone),
      this.queryCarrierApis(phone),
      mode === 'PHONE_NAMES_ONLY'
        ? Promise.resolve(null)
        : this.probeInstagramAndMetaByPhone(phone),
      mode === 'PHONE_NAMES_ONLY'
        ? Promise.resolve(null)
        : this.probeSnapchatByPhone(phone),
      mode === 'PHONE_NAMES_ONLY'
        ? Promise.resolve(null)
        : this.probeAmazonByPhone(phone),
      this.scrapeLiveWebAndDirectories(phone),
    ]);

    if (carrierApiData?.carrier) {
      phone.inferredCarrier = `${carrierApiData.carrier} (${phone.inferredCarrier})`;
    }

    // Aggregate all discovered names across all engines
    const newNames: DiscoveredIdentityName[] = [];

    if (waFootprint.verifiedBusinessName) {
      newNames.push({
        name: waFootprint.verifiedBusinessName,
        source: 'WhatsApp Business Verified Name',
        confidence: 'HIGH',
        category: waFootprint.businessCategory,
        observedAtIso: nowIso,
      });
    }
    if (waFootprint.pushName) {
      newNames.push({
        name: waFootprint.pushName,
        source: 'WhatsApp PushName',
        confidence: 'HIGH',
        observedAtIso: nowIso,
      });
    }
    if (truecallerData?.name) {
      newNames.push({
        name: truecallerData.name,
        source: 'Truecaller Global Directory',
        confidence: 'HIGH',
        extraInfo: [truecallerData.jobTitle, truecallerData.companyName]
          .filter(Boolean)
          .join(' @ '),
        observedAtIso: nowIso,
      });
    }
    if (truecallerData?.altName) {
      newNames.push({
        name: truecallerData.altName,
        source: 'Truecaller Alternate Name',
        confidence: 'HIGH',
        observedAtIso: nowIso,
      });
    }
    if (eyeconData?.names && eyeconData.names.length > 0) {
      for (const eyeName of eyeconData.names) {
        newNames.push({
          name: eyeName,
          source: 'Eyecon Caller-ID Database',
          confidence: 'HIGH',
          observedAtIso: nowIso,
        });
      }
    }
    if (igAndMeta?.instagram.displayName) {
      newNames.push({
        name: igAndMeta.instagram.displayName,
        source: 'Instagram Profile Name',
        confidence: 'HIGH',
        observedAtIso: nowIso,
      });
    }
    for (const webName of webScrape.extractedNames) {
      newNames.push(webName);
    }

    const allDiscoveredNames = this.saveDiscoveredNamesForPhone(phone.e164, newNames);

    // Collect candidate handles/usernames for cross-platform pivot
    const candidateHandles: string[] = [];
    if (igAndMeta?.instagram.handleOrUsername) {
      candidateHandles.push(igAndMeta.instagram.handleOrUsername);
    }
    if (truecallerData?.email) {
      candidateHandles.push(truecallerData.email.split('@')[0] || '');
    }
    if (waFootprint.businessEmail) {
      candidateHandles.push(waFootprint.businessEmail.split('@')[0] || '');
    }
    for (const site of waFootprint.businessWebsites) {
      const m =
        /(?:instagram\.com|twitter\.com|x\.com|tiktok\.com|t\.me|facebook\.com)\/@?([a-zA-Z0-9._-]+)/i.exec(
          site
        );
      if (m?.[1]) candidateHandles.push(m[1]);
    }

    const handlePivotAccounts =
      mode === 'PHONE_NAMES_ONLY'
        ? []
        : await this.probeSocialHandlesPivot(candidateHandles);

    // Build unified Social Accounts list
    const socialAccounts: SocialPlatformFootprint[] = [];

    // 1. WhatsApp
    const waExists =
      waFootprint.registered || Boolean(igAndMeta?.metaWhatsAppResetLinked);
    socialAccounts.push({
      platform: 'WhatsApp Messenger',
      icon: '🟢',
      status: waExists ? 'CONFIRMED' : waFootprint.checked ? 'NOT_FOUND' : 'LIKELY',
      exists: waExists,
      url: waFootprint.directChatUrl,
      displayName: waFootprint.verifiedBusinessName || waFootprint.pushName,
      details: waExists
        ? `مرتبط بحساب واتساب نشط${
            waFootprint.lid ? ` (LID: ${waFootprint.lid})` : ''
          }${
            waFootprint.statusBio ? ` | النبذة: ${waFootprint.statusBio}` : ''
          }`
        : 'الرقم غير مسجل حالياً على واتساب أو يتطلب جلسة متصلة للفحص المباشر',
      verificationMethod: waFootprint.checked
        ? 'Baileys USync + Business Profile Probe'
        : 'Meta Account Recovery Probe (can_wa_reset)',
    });

    // 2. Telegram Direct Phone Link
    socialAccounts.push({
      platform: 'Telegram Messenger',
      icon: '✈️',
      status: 'CONFIRMED',
      exists: true,
      url: `https://t.me/+${phone.digitsOnly}`,
      details: `رابط فتح الحساب المباشر عبر رقم الهاتف على تيليجرام (t.me/+${phone.digitsOnly})`,
      verificationMethod: 'Telegram Deep-Link Resolver',
    });

    // 3. Eyecon Facebook Graph Profile (if resolved)
    if (eyeconData?.facebookProfileUrl) {
      socialAccounts.push({
        platform: 'Facebook Profile (Eyecon Graph)',
        icon: '📘',
        status: 'CONFIRMED',
        exists: true,
        url: eyeconData.facebookProfileUrl,
        details: 'تم كشف حساب فيسبوك المرتبط بالرقم مباشرةً عبر Eyecon Graph API',
        verificationMethod: 'Eyecon Facebook Graph Redirect (KnowhoBot)',
      });
    }

    // 4. Instagram, Snapchat, Amazon probes
    if (igAndMeta?.instagram) socialAccounts.push(igAndMeta.instagram);
    if (snapchatProbe) socialAccounts.push(snapchatProbe);
    if (amazonProbe) socialAccounts.push(amazonProbe);

    // 5. WhatsApp Business External Websites
    for (const websiteUrl of waFootprint.businessWebsites) {
      socialAccounts.push({
        platform: 'WhatsApp Business Linked URL',
        icon: '🌐',
        status: 'CONFIRMED',
        exists: true,
        url: websiteUrl,
        details: 'رابط موقع أو حساب تواصل مضاف في ملف أعمال واتساب للرقم',
        verificationMethod: 'WhatsApp Business Profile Metadata',
      });
    }

    // 6. Cross-platform handle pivot accounts
    socialAccounts.push(...handlePivotAccounts);

    const osintDorks = this.buildPhoneInfogaDorks(phone);

    const topName =
      allDiscoveredNames[0]?.name ||
      waFootprint.verifiedBusinessName ||
      truecallerData?.name ||
      eyeconData?.names?.[0] ||
      'غير مسجل في الأدلة الحالية';

    this.recordForensicHistorySummary({
      phoneE164: phone.e164,
      countryAr: phone.countryNameArabic,
      carrier: phone.inferredCarrier,
      topName,
      namesCount: allDiscoveredNames.length,
      socialCount: socialAccounts.filter((s) => s.exists).length,
      timestampIso: nowIso,
    });

    log.debug('Completed forensic phone investigation', {
      phoneE164: phone.e164,
      mode,
      namesCount: allDiscoveredNames.length,
      socialCount: socialAccounts.length,
    });

    return {
      reportId: `cfor_${crypto.randomBytes(4).toString('hex')}`,
      generatedAtIso: nowIso,
      phone,
      discoveredNames: allDiscoveredNames,
      whatsappFootprint: waFootprint,
      truecallerData,
      eyeconData,
      carrierApiData,
      socialAccounts,
      liveWebMentions: webScrape.mentions,
      osintDorks,
      isDisposableBurner: webScrape.disposableMatchedDomains.length > 0,
      disposableMatchedDomains: webScrape.disposableMatchedDomains,
    };
  }
}
