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

export type ForensicInvestigationMode =
  | 'PHONE_NAMES_ONLY'
  | 'SOCIAL_ONLY'
  | 'BREACH_LEAKS_ONLY'
  | 'TEN_ENGINES_SCRAPE_ONLY'
  | 'HANDLE_EMAIL_PIVOT_ONLY'
  | 'FULL_DOSSIER';

export interface WhatsAppForensicFootprint {
  checked: boolean;
  registered: boolean;
  jid?: string;
  lid?: string;
  linkedDevices: number[];
  privacyTokenChecked?: boolean;
  privacyTokenTrusted?: boolean;
  pushName?: string;
  verifiedBusinessName?: string;
  businessCategory?: string;
  businessDescription?: string;
  businessEmail?: string;
  businessWebsites: string[];
  businessAddress?: string;
  statusBio?: string;
  statusSetAt?: string;
  aboutPrivacyRestricted?: boolean;
  profilePictureUrl?: string;
  profilePictureBuffer?: Buffer;
  profilePicturePrivacyRestricted?: boolean;
  presenceState?: string;
  lastSeenIso?: string;
  disappearingTimerSeconds?: number;
  sharedGroupsCount?: number;
  sharedGroupsSample?: Array<{ groupName: string; role: string }>;
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
  avatarUrl?: string;
  bioOrSnippet?: string;
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

export interface SearchEngineExecutionStat {
  engineName: string;
  status: 'OK' | 'EMPTY' | 'RATE_LIMITED_OR_TIMEOUT';
  hitsCount: number;
  latencyMs: number;
}

export interface LiveWebMentionHit {
  engineSource: string;
  title: string;
  url: string;
  snippet: string;
  extractedNames: string[];
  sourceDomain: string;
}

export interface BreachExposureRecord {
  sourceEngine:
    | 'HudsonRock-Cavalier'
    | 'LeakCheck-Public'
    | 'ProxyNova-COMB'
    | 'XposedOrNot'
    | 'EmailRep-OSINT';
  targetIdentifier: string;
  compromised: boolean;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'INFO';
  breachOrStealerName: string;
  compromisedDate?: string;
  exposedFields: string[];
  maskedSamples: string[];
  details: string;
}

export interface PasteOrCodeDumpHit {
  sourceEngine: 'PSBDMP-Pastebin' | 'GrepApp-GitCode' | 'GitHub-PublicCode';
  titleOrRepo: string;
  url: string;
  snippet: string;
  recordedAt?: string;
}

export interface PhoneForensicReport {
  reportId: string;
  generatedAtIso: string;
  mode: ForensicInvestigationMode;
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
    provider?: string;
    valid?: boolean;
    carrier?: string;
    lineType?: string;
    location?: string;
    numverify?: {
      queried: boolean;
      valid: boolean;
      carrier?: string;
      lineType?: string;
      location?: string;
    };
    ovhTelecom?: {
      queried: boolean;
      found: boolean;
      city?: string;
      zipCode?: string;
    };
  };
  socialAccounts: SocialPlatformFootprint[];
  searchEngineStats: SearchEngineExecutionStat[];
  liveWebMentions: LiveWebMentionHit[];
  breachExposures: BreachExposureRecord[];
  pasteAndCodeHits: PasteOrCodeDumpHit[];
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
  { code: '52', iso2: 'MX', ar: 'المكسيك 🇲🇽', en: 'Mexico' },
  { code: '54', iso2: 'AR', ar: 'الأرجنتين 🇦🇷', en: 'Argentina' },
  { code: '57', iso2: 'CO', ar: 'كولومبيا 🇨🇴', en: 'Colombia' },
  { code: '56', iso2: 'CL', ar: 'تشيلي 🇨🇱', en: 'Chile' },
  { code: '51', iso2: 'PE', ar: 'بيرو 🇵🇪', en: 'Peru' },
  { code: '58', iso2: 'VE', ar: 'فنزويلا 🇻🇪', en: 'Venezuela' },
  { code: '61', iso2: 'AU', ar: 'أستراليا 🇦🇺', en: 'Australia' },
  { code: '64', iso2: 'NZ', ar: 'نيوزيلندا 🇳🇿', en: 'New Zealand' },
  { code: '65', iso2: 'SG', ar: 'سنغافورة 🇸🇬', en: 'Singapore' },
  { code: '66', iso2: 'TH', ar: 'تايلاند 🇹🇭', en: 'Thailand' },
  { code: '63', iso2: 'PH', ar: 'الفلبين 🇵🇭', en: 'Philippines' },
  { code: '84', iso2: 'VN', ar: 'فيتنام 🇻🇳', en: 'Vietnam' },
  { code: '93', iso2: 'AF', ar: 'أفغانستان 🇦🇫', en: 'Afghanistan' },
  { code: '94', iso2: 'LK', ar: 'سريلانكا 🇱🇰', en: 'Sri Lanka' },
  { code: '95', iso2: 'MM', ar: 'ميانمار 🇲🇲', en: 'Myanmar' },
  { code: '977', iso2: 'NP', ar: 'نيبال 🇳🇵', en: 'Nepal' },
  { code: '994', iso2: 'AZ', ar: 'أذربيجان 🇦🇿', en: 'Azerbaijan' },
  { code: '995', iso2: 'GE', ar: 'جورجيا 🇬🇪', en: 'Georgia' },
  { code: '998', iso2: 'UZ', ar: 'أوزبكستان 🇺🇿', en: 'Uzbekistan' },
  { code: '27', iso2: 'ZA', ar: 'جنوب أفريقيا 🇿🇦', en: 'South Africa' },
  { code: '234', iso2: 'NG', ar: 'نيجيريا 🇳🇬', en: 'Nigeria' },
  { code: '254', iso2: 'KE', ar: 'كينيا 🇰🇪', en: 'Kenya' },
  { code: '251', iso2: 'ET', ar: 'إثيوبيا 🇪🇹', en: 'Ethiopia' },
  { code: '255', iso2: 'TZ', ar: 'تنزانيا 🇹🇿', en: 'Tanzania' },
  { code: '256', iso2: 'UG', ar: 'أوغندا 🇺🇬', en: 'Uganda' },
  { code: '233', iso2: 'GH', ar: 'غانا 🇬🇭', en: 'Ghana' },
  { code: '221', iso2: 'SN', ar: 'السنغال 🇸🇳', en: 'Senegal' },
  { code: '269', iso2: 'KM', ar: 'جزر القمر 🇰🇲', en: 'Comoros' },
  { code: '291', iso2: 'ER', ar: 'إريتريا 🇪🇷', en: 'Eritrea' },
  { code: '30', iso2: 'GR', ar: 'اليونان 🇬🇷', en: 'Greece' },
  { code: '48', iso2: 'PL', ar: 'بولندا 🇵🇱', en: 'Poland' },
  { code: '380', iso2: 'UA', ar: 'أوكرانيا 🇺🇦', en: 'Ukraine' },
  { code: '40', iso2: 'RO', ar: 'رومانيا 🇷🇴', en: 'Romania' },
  { code: '43', iso2: 'AT', ar: 'النمسا 🇦🇹', en: 'Austria' },
  { code: '47', iso2: 'NO', ar: 'النرويج 🇳🇴', en: 'Norway' },
  { code: '45', iso2: 'DK', ar: 'الدنمارك 🇩🇰', en: 'Denmark' },
  { code: '358', iso2: 'FI', ar: 'فنلندا 🇫🇮', en: 'Finland' },
  { code: '351', iso2: 'PT', ar: 'البرتغال 🇵🇹', en: 'Portugal' },
  { code: '353', iso2: 'IE', ar: 'أيرلندا 🇮🇪', en: 'Ireland' },
  { code: '420', iso2: 'CZ', ar: 'التشيك 🇨🇿', en: 'Czechia' },
  { code: '36', iso2: 'HU', ar: 'المجر 🇭🇺', en: 'Hungary' },
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

  const fallbackCode = digits.slice(0, 3) || digits.slice(0, 2) || '00';
  let matchedMeta: CallingCodeMeta = {
    code: fallbackCode,
    iso2: 'UN',
    ar: 'دولي غير محدد 🌍',
    en: 'International',
  };
  let significantNumber = digits.length > 3 ? digits.slice(3) : digits;

  for (const entry of SORTED_CALLING_CODES) {
    if (digits.startsWith(entry.code) && digits.length >= entry.code.length + 4) {
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

  public parseAndNormalizePhoneInput(rawInput: string): NormalizedPhoneMetadata {
    return parseAndNormalizePhoneInput(rawInput);
  }

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

  public getLeakCheckApiKey(): string {
    return (
      this.settingsRepo.get('forensic:leakcheck_api_key')?.trim() ||
      process.env.LEAKCHECK_API_KEY?.trim() ||
      ''
    );
  }

  public setLeakCheckApiKey(key: string): void {
    this.settingsRepo.set('forensic:leakcheck_api_key', key.trim());
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
    breachCount?: number;
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
    breachCount?: number;
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

  public saveFullForensicReportToCache(report: PhoneForensicReport): void {
    try {
      const raw = this.settingsRepo.get('cyber_forensics.full_reports_cache_v2');
      let mapObj: Record<string, PhoneForensicReport> = {};
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          mapObj = parsed as Record<string, PhoneForensicReport>;
        }
      }
      const phoneObj = report.phone || (report as unknown as { target?: NormalizedPhoneMetadata }).target;
      const digitsKey = phoneObj?.digitsOnly;
      if (!digitsKey) return;
      const serializableReport: PhoneForensicReport = {
        ...report,
        phone: phoneObj,
        whatsappFootprint: report.whatsappFootprint
          ? {
              ...report.whatsappFootprint,
              profilePictureBuffer: undefined,
            }
          : ({
              checked: false,
              registered: false,
            } as WhatsAppForensicFootprint),
      };
      mapObj[digitsKey] = serializableReport;
      const keys = Object.keys(mapObj);
      if (keys.length > 30) {
        const oldestKey = keys[0];
        if (oldestKey) delete mapObj[oldestKey];
      }
      this.settingsRepo.set(
        'cyber_forensics.full_reports_cache_v2',
        JSON.stringify(mapObj)
      );
    } catch {
      // Non-fatal cache write error
    }
  }

  public getFullForensicReportFromCache(
    digitsOrE164: string
  ): PhoneForensicReport | undefined {
    const digits = String(digitsOrE164 || '').replace(/\D/g, '');
    if (!digits) return undefined;
    try {
      const raw = this.settingsRepo.get('cyber_forensics.full_reports_cache_v2');
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as Record<string, PhoneForensicReport>;
      return parsed?.[digits];
    } catch {
      return undefined;
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
    let numverifyResult:
      | {
          queried: boolean;
          valid: boolean;
          carrier?: string;
          lineType?: string;
          location?: string;
        }
      | undefined;
    let ovhResult:
      | {
          queried: boolean;
          found: boolean;
          city?: string;
          zipCode?: string;
        }
      | undefined;

    const numverifyKey = this.getNumverifyApiKey();
    if (numverifyKey) {
      try {
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
            numverifyResult = {
              queried: true,
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
            ovhResult = {
              queried: true,
              found: true,
              city: match.city || undefined,
              zipCode: match.zipCode || undefined,
            };
          }
        }
      } catch {
        // Ignore OVH error
      }
    }

    if (!numverifyResult && !ovhResult) {
      return undefined;
    }

    return {
      provider: numverifyResult ? 'Numverify (Apilayer)' : 'OVH Telecom Europe',
      valid: numverifyResult ? numverifyResult.valid : Boolean(ovhResult?.found),
      carrier: numverifyResult?.carrier,
      lineType: numverifyResult?.lineType,
      location:
        numverifyResult?.location ||
        (ovhResult ? [ovhResult.city, ovhResult.zipCode].filter(Boolean).join(' ') : undefined),
      numverify: numverifyResult,
      ovhTelecom: ovhResult,
    };
  }

  // =========================================================================
  // ENGINE 4: LIVE WHATSAPP PROTOCOL IDENTITY & FULL USYNC INSPECTOR
  // =========================================================================
  public async inspectWhatsAppProtocolFootprint(
    phone: NormalizedPhoneMetadata,
    actorTelegramId?: number
  ): Promise<WhatsAppForensicFootprint> {
    const directChatUrl = `https://wa.me/${phone.digitsOnly}`;

    // Multi-stage connected session lookup:
    // 1. User's own sessions via actorTelegramId
    // 2. All sessions in repository (if sessionRepo is accessible)
    // 3. Active driver map inside sessionManager
    let connectedSessions = this.sessionManager
      .listSessions(actorTelegramId)
      .filter((s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED');

    if (connectedSessions.length === 0) {
      const mgrAny = this.sessionManager as unknown as {
        sessionRepo?: {
          listAll?: () => Array<{ id: string; status: string }>;
        };
        drivers?: Map<string, unknown>;
      };
      if (typeof mgrAny.sessionRepo?.listAll === 'function') {
        const all = mgrAny.sessionRepo.listAll();
        connectedSessions = all.filter(
          (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
        ) as typeof connectedSessions;
      }
      if (connectedSessions.length === 0 && mgrAny.drivers instanceof Map) {
        for (const [sessId] of mgrAny.drivers.entries()) {
          connectedSessions.push({
            id: sessId,
            status: 'CONNECTED',
          } as (typeof connectedSessions)[number]);
        }
      }
    }

    if (connectedSessions.length === 0) {
      return {
        checked: false,
        registered: false,
        linkedDevices: [],
        businessWebsites: [],
        directChatUrl,
      };
    }

    // Find the first session that has an active driver
    let driver: ReturnType<SessionManager['getDriver']> | undefined;
    for (const sess of connectedSessions) {
      const d = this.sessionManager.getDriver(sess.id);
      if (d) {
        driver = d;
        break;
      }
    }

    if (!driver) {
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
    let privacyTokenChecked = false;
    let privacyTokenTrusted = false;
    let pushName: string | undefined;
    let verifiedBusinessName: string | undefined;
    let businessCategory: string | undefined;
    let businessDescription: string | undefined;
    let businessEmail: string | undefined;
    const businessWebsites: string[] = [];
    let businessAddress: string | undefined;
    let statusBio: string | undefined;
    let statusSetAt: string | undefined;
    let aboutPrivacyRestricted = false;
    let profilePictureUrl: string | undefined;
    let profilePictureBuffer: Buffer | undefined;
    let profilePicturePrivacyRestricted = false;
    let presenceState: string | undefined;
    let lastSeenIso: string | undefined;
    let disappearingTimerSeconds: number | undefined;
    let sharedGroupsCount = 0;
    const sharedGroupsSample: Array<{ groupName: string; role: string }> = [];

    // 1. Primary path: Invoke driver.fetchFullProfileInfo(phone.e164) from connection-manager.ts
    // which performs Official Baileys USync (Contact, Status, DisappearingMode, Picture, Devices, LID),
    // PresenceSubscribe, BusinessProfile, High-Res Profile Picture download, and Shared Groups scan!
    const driverWithFullProfile = driver as unknown as {
      fetchFullProfileInfo?: (target: string) => Promise<{
        existsOnWhatsApp?: boolean;
        pnJid?: string;
        lidJid?: string;
        pushName?: string;
        verifiedName?: string;
        statusText?: string;
        statusSetAt?: string;
        presence?: {
          status?: string;
          lastSeen?: number;
        };
        disappearingMode?: {
          durationSeconds?: number;
        };
        devices?: Array<{ deviceId: number; isPrimary: boolean }>;
        businessProfile?: {
          description?: string;
          category?: string;
          email?: string;
          websites?: string[];
          address?: string;
        };
        profilePicture?: {
          url?: string;
          imageBuffer?: Buffer;
          privacyRestricted?: boolean;
        };
        sharedGroups?: Array<{
          groupJid: string;
          groupName: string;
          targetRole: string;
        }>;
      }>;
    };

    let fullProfileAttempted = false;
    if (typeof driverWithFullProfile.fetchFullProfileInfo === 'function') {
      try {
        const fullInfo = await driverWithFullProfile.fetchFullProfileInfo(phone.e164);
        if (fullInfo) {
          fullProfileAttempted = true;
          registered = Boolean(fullInfo.existsOnWhatsApp);
          if (fullInfo.pnJid) resolvedJid = fullInfo.pnJid;
          if (fullInfo.lidJid) resolvedLid = fullInfo.lidJid;
          if (fullInfo.pushName) pushName = fullInfo.pushName;
          if (fullInfo.verifiedName) verifiedBusinessName = fullInfo.verifiedName;
          if (fullInfo.statusText) {
            statusBio = fullInfo.statusText;
          } else if (registered) {
            aboutPrivacyRestricted = true;
          }
          if (fullInfo.statusSetAt) {
            statusSetAt = fullInfo.statusSetAt.slice(0, 10);
          }
          if (fullInfo.presence?.status && fullInfo.presence.status !== 'unknown') {
            presenceState = fullInfo.presence.status;
          }
          if (fullInfo.presence?.lastSeen) {
            lastSeenIso = new Date(fullInfo.presence.lastSeen).toISOString();
          }
          if (typeof fullInfo.disappearingMode?.durationSeconds === 'number') {
            disappearingTimerSeconds = fullInfo.disappearingMode.durationSeconds;
          }
          if (Array.isArray(fullInfo.devices)) {
            for (const d of fullInfo.devices) {
              if (typeof d.deviceId === 'number' && !linkedDevices.includes(d.deviceId)) {
                linkedDevices.push(d.deviceId);
              }
            }
          }
          if (fullInfo.businessProfile) {
            if (fullInfo.businessProfile.description) {
              businessDescription = fullInfo.businessProfile.description;
            }
            if (fullInfo.businessProfile.category) {
              businessCategory = fullInfo.businessProfile.category;
            }
            if (fullInfo.businessProfile.email) {
              businessEmail = fullInfo.businessProfile.email;
            }
            if (fullInfo.businessProfile.address) {
              businessAddress = fullInfo.businessProfile.address;
            }
            if (Array.isArray(fullInfo.businessProfile.websites)) {
              for (const w of fullInfo.businessProfile.websites) {
                if (typeof w === 'string' && w.trim() && !businessWebsites.includes(w.trim())) {
                  businessWebsites.push(w.trim());
                }
              }
            }
          }
          if (fullInfo.profilePicture) {
            if (fullInfo.profilePicture.url) {
              profilePictureUrl = fullInfo.profilePicture.url;
            }
            if (Buffer.isBuffer(fullInfo.profilePicture.imageBuffer)) {
              profilePictureBuffer = fullInfo.profilePicture.imageBuffer;
            }
            profilePicturePrivacyRestricted = Boolean(
              fullInfo.profilePicture.privacyRestricted
            );
          }
          if (Array.isArray(fullInfo.sharedGroups)) {
            sharedGroupsCount = fullInfo.sharedGroups.length;
            for (const g of fullInfo.sharedGroups.slice(0, 6)) {
              sharedGroupsSample.push({
                groupName: g.groupName,
                role: g.targetRole,
              });
            }
          }
        }
      } catch (err) {
        log.debug('fetchFullProfileInfo fallback in inspectWhatsAppProtocolFootprint', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Secondary Raw Socket Enrichment & Privacy Token Probe
    const rawSock = driver.getRawSocket?.() as Record<string, unknown> | undefined;
    if (!fullProfileAttempted && !rawSock) {
      return {
        checked: false,
        registered: false,
        linkedDevices: [],
        businessWebsites: [],
        directChatUrl,
      };
    }

    if (rawSock) {
      let onWhatsAppExplicitlyFalse =
        fullProfileAttempted && !registered;

      if (!registered && typeof rawSock.onWhatsApp === 'function') {
        try {
          const res = await (
            rawSock.onWhatsApp as (
              pn: string
            ) => Promise<Array<{ exists?: boolean; jid?: string; lid?: string }>>
          )(phone.e164);
          const first = Array.isArray(res) ? res[0] : undefined;
          if (first?.exists === true) {
            registered = true;
            onWhatsAppExplicitlyFalse = false;
            if (typeof first.jid === 'string') resolvedJid = first.jid;
            if (typeof first.lid === 'string') resolvedLid = first.lid;
          } else if (first && first.exists === false) {
            registered = false;
            onWhatsAppExplicitlyFalse = true;
          }
        } catch {
          // Non-fatal
        }
      }

      if (!onWhatsAppExplicitlyFalse && typeof rawSock.privacyToken === 'function') {
        try {
          privacyTokenChecked = true;
          const privTokens = await (
            rawSock.privacyToken as (jids: string[]) => Promise<unknown>
          )([resolvedJid]);
          if (privTokens) {
            privacyTokenTrusted = true;
          }
        } catch {
          // Non-fatal
        }
      }

      if (!resolvedLid && registered) {
        try {
          const sigRepo = rawSock.signalRepository as
            | { lidMapping?: { getLIDForPN?: (jid: string) => Promise<string | undefined> } }
            | undefined;
          if (typeof sigRepo?.lidMapping?.getLIDForPN === 'function') {
            const lid = await sigRepo.lidMapping.getLIDForPN(resolvedJid);
            if (typeof lid === 'string' && lid) resolvedLid = lid;
          }
        } catch {
          // Non-fatal
        }
      }

      if (
        registered &&
        linkedDevices.length === 0 &&
        typeof rawSock.getUSyncDevices === 'function'
      ) {
        try {
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
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }

    return {
      checked: true,
      registered,
      jid: resolvedJid,
      lid: resolvedLid,
      linkedDevices: linkedDevices.sort((a, b) => a - b),
      privacyTokenChecked,
      privacyTokenTrusted,
      pushName,
      verifiedBusinessName,
      businessCategory,
      businessDescription,
      businessEmail,
      businessWebsites,
      businessAddress,
      statusBio,
      statusSetAt,
      aboutPrivacyRestricted,
      profilePictureUrl,
      profilePictureBuffer,
      profilePicturePrivacyRestricted,
      presenceState,
      lastSeenIso,
      disappearingTimerSeconds,
      sharedGroupsCount,
      sharedGroupsSample,
      directChatUrl,
    };
  }

  // =========================================================================
  // ENGINE 5: NON-ALERTING SOCIAL PROBES (`yazeed44/social-media-detector-api` + `megadose/ignorant`)
  // =========================================================================
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
      device_id: `android-${crypto.randomBytes(8).toString('hex')}`,
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
        signal: AbortSignal.timeout(7000),
      });

      const rep = (await res.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        user?: { username?: string; full_name?: string; profile_pic_url?: string };
        has_valid_phone?: boolean;
        can_wa_reset?: boolean;
        can_email_reset?: boolean;
        can_sms_reset?: boolean;
        obfuscated_phone?: string;
        obfuscated_email?: string;
      };

      if (
        rep?.status === 'fail' &&
        /wait|rate|limit|challenge|spam/i.test(String(rep?.message || ''))
      ) {
        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'RATE_LIMITED',
            exists: false,
            url: 'https://www.instagram.com/',
            details: 'الخادم قيّد استعلام الفحص المباشر مؤقتاً (Rate Limited / Challenge)',
            verificationMethod: 'Instagram Liger API HMAC-SHA256 Lookup',
          },
        };
      }

      const confirmedIg =
        Boolean(rep?.user) ||
        rep?.has_valid_phone === true ||
        rep?.can_wa_reset === true ||
        rep?.can_email_reset === true ||
        rep?.can_sms_reset === true;

      if (confirmedIg) {
        const username =
          typeof rep?.user?.username === 'string' ? rep.user.username : undefined;
        const fullName =
          typeof rep?.user?.full_name === 'string' ? rep.user.full_name : undefined;
        const canWaReset = rep?.can_wa_reset === true;
        const obfEmail =
          typeof rep?.obfuscated_email === 'string' ? rep.obfuscated_email : undefined;

        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'CONFIRMED',
            exists: true,
            url: username
              ? `https://www.instagram.com/${encodeURIComponent(username)}/`
              : 'https://www.instagram.com/accounts/password/reset/',
            handleOrUsername: username ? `@${username}` : undefined,
            displayName: fullName,
            avatarUrl: rep?.user?.profile_pic_url,
            details: username
              ? `مرتبط بحساب إنستغرام مؤكد: @${username}${obfEmail ? ` (البريد المقنّع: ${obfEmail})` : ''}`
              : `الرقم مرتبط بحساب إنستغرام نشط في قاعدة بيانات Meta${obfEmail ? ` (البريد المقنّع: ${obfEmail})` : ''}`,
            verificationMethod: 'Instagram Liger API HMAC-SHA256 Lookup (ignorant/yocial)',
          },
          metaWhatsAppResetLinked: canWaReset,
        };
      }

      if (
        /no users found/i.test(String(rep?.message || '')) ||
        res.status === 404
      ) {
        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'NOT_FOUND',
            exists: false,
            url: 'https://www.instagram.com/',
            details: 'الرقم غير مرتبط بحساب إنستغرام مباشر (No users found)',
            verificationMethod: 'Instagram Liger API HMAC-SHA256 Lookup',
          },
        };
      }
    } catch {
      // Proceed to Web Account Recovery AJAX fallback
    }

    // Fallback Endpoint 2: Instagram Web Account Recovery AJAX (`https://www.instagram.com/api/v1/web/accounts/account_recovery_send_ajax/`)
    try {
      const csrfToken = crypto.randomBytes(16).toString('hex');
      const webRes = await fetch(
        'https://www.instagram.com/api/v1/web/accounts/account_recovery_send_ajax/',
        {
          method: 'POST',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRFToken': csrfToken,
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://www.instagram.com',
            Referer: 'https://www.instagram.com/accounts/password/reset/',
            Cookie: `csrftoken=${csrfToken}`,
          },
          body: new URLSearchParams({
            email_or_username: phone.e164,
            flow: 'fxcal',
          }).toString(),
          signal: AbortSignal.timeout(7000),
        }
      );

      const webJson = (await webRes.json().catch(() => ({}))) as {
        status?: string;
        message?: string | string[];
        contact_point?: string;
        can_recover_with_code?: boolean;
      };

      const msgStr = Array.isArray(webJson?.message)
        ? webJson.message.join(' ')
        : String(webJson?.message || '');

      if (
        webJson?.can_recover_with_code === true ||
        Boolean(webJson?.contact_point)
      ) {
        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'CONFIRMED',
            exists: true,
            url: 'https://www.instagram.com/',
            details: `مرتبط بحساب إنستغرام نشط${
              webJson.contact_point ? ` (نقطة الاسترداد: ${webJson.contact_point})` : ''
            }`,
            verificationMethod: 'Instagram Web Account Recovery Probe',
          },
        };
      }

      if (msgStr.toLowerCase().includes('no users found')) {
        return {
          instagram: {
            platform: 'Instagram',
            icon: '📸',
            status: 'NOT_FOUND',
            exists: false,
            url: 'https://www.instagram.com/',
            details: 'الرقم غير مرتبط بحساب إنستغرام مباشر (No users found)',
            verificationMethod: 'Instagram Web Account Recovery Probe',
          },
        };
      }
    } catch {
      // Non-fatal
    }

    return {
      instagram: {
        platform: 'Instagram',
        icon: '📸',
        status: 'RATE_LIMITED',
        exists: false,
        url: 'https://www.instagram.com/',
        details: 'الخادم قيّد استعلام الفحص المباشر حالياً',
        verificationMethod: 'Instagram Dual-Endpoint Probe',
      },
    };
  }

  /**
   * Exact TypeScript implementation of `megadose/ignorant/blob/main/ignorant/modules/social_media/snapchat.py`.
   * Uses Double-Submit Cookie CSRF (`xsrf_token`) against `https://accounts.snapchat.com/accounts/validate_phone_number`.
   */
  public async probeSnapchatByPhone(
    phone: NormalizedPhoneMetadata
  ): Promise<SocialPlatformFootprint> {
    let xsrfToken = crypto.randomBytes(16).toString('base64url');
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

    try {
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
            'User-Agent': ua,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
            Origin: 'https://accounts.snapchat.com',
            Referer: 'https://accounts.snapchat.com/accounts/signup',
            Cookie: `xsrf_token=${xsrfToken}`,
          },
          body: formData,
          signal: AbortSignal.timeout(7000),
        }
      );

      const setCookieRaw =
        valRes.headers.getSetCookie?.()?.join('; ') ||
        valRes.headers.get('set-cookie') ||
        '';
      const cookieMatch = /xsrf_token=([^;\s]+)/i.exec(setCookieRaw);
      if (cookieMatch?.[1]) {
        xsrfToken = cookieMatch[1];
      }

      const json = (await valRes.json().catch(() => ({}))) as {
        status_code?: string;
        error_message?: string;
      };

      if (json?.status_code === 'TAKEN_NUMBER') {
        return {
          platform: 'Snapchat',
          icon: '👻',
          status: 'CONFIRMED',
          exists: true,
          url: 'https://www.snapchat.com/',
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
          url: 'https://www.snapchat.com/',
          details: 'الرقم غير مسجل في سناب شات (Status: OK)',
          verificationMethod: 'Snapchat Registration Validator (megadose/ignorant)',
        };
      }
    } catch {
      // Non-fatal
    }

    return {
      platform: 'Snapchat',
      icon: '👻',
      status: 'RATE_LIMITED',
      exists: false,
      url: 'https://www.snapchat.com/',
      details: 'تعذر التحقق المباشر من سناب شات (حماية الخادم)',
      verificationMethod: 'Snapchat Registration Validator',
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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    try {
      const getRes = await fetch(signInUrl, {
        headers: { 'User-Agent': ua },
        signal: AbortSignal.timeout(7000),
      });
      const rawCookies =
        getRes.headers.getSetCookie?.() ??
        [getRes.headers.get('set-cookie')].filter((c): c is string => Boolean(c));
      const cookieHeader = rawCookies
        .map((c) => c.split(';')[0]?.trim())
        .filter(Boolean)
        .join('; ');

      const html = await getRes.text();
      const formParams = new URLSearchParams();
      const inputTagRegex = /<input\b[^>]*>/gi;
      let tagMatch: RegExpExecArray | null;
      while ((tagMatch = inputTagRegex.exec(html)) !== null) {
        const tag = tagMatch[0] || '';
        const nameAttr = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
        const valAttr = /\bvalue=["']([^"']*)["']/i.exec(tag)?.[1];
        if (nameAttr) {
          formParams.set(nameAttr, valAttr ?? '');
        }
      }
      formParams.set('email', `${phone.countryCode}${phone.significantNumber}`);

      const postHeaders: Record<string, string> = {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: signInUrl,
      };
      if (cookieHeader) {
        postHeaders.Cookie = cookieHeader;
      }

      const postRes = await fetch('https://www.amazon.com/ap/signin/', {
        method: 'POST',
        headers: postHeaders,
        body: formParams.toString(),
        signal: AbortSignal.timeout(7000),
      });
      const postHtml = await postRes.text();
      if (/opfcaptcha|cvf-page-content|validateCaptcha/i.test(postHtml)) {
        return {
          platform: 'Amazon Account',
          icon: '📦',
          status: 'RATE_LIMITED',
          exists: false,
          url: 'https://www.amazon.com/',
          details: 'طلب Amazon تحقق CAPTCHA أثناء الفحص المباشر',
          verificationMethod: 'Amazon OpenID Sign-In Probe (megadose/ignorant)',
        };
      }
      const exists = postHtml.includes('auth-password-missing-alert');
      return {
        platform: 'Amazon Account',
        icon: '📦',
        status: exists ? 'CONFIRMED' : 'NOT_FOUND',
        exists,
        url: 'https://www.amazon.com/',
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
        url: 'https://www.amazon.com/',
        details: 'تعذر إكمال فحص Amazon المباشر (حماية CAPTCHA/Rate-Limit)',
        verificationMethod: 'Amazon OpenID Sign-In Probe',
      };
    }
  }

  /**
   * Probes Telegram public phone deep-link (`https://t.me/+<digits>`) to check if a public profile
   * card is exposed, otherwise labels it accurately as a deep-link resolver.
   */
  public async probeTelegramByPhone(
    phone: NormalizedPhoneMetadata
  ): Promise<SocialPlatformFootprint> {
    const tgUrl = `https://t.me/+${phone.digitsOnly}`;
    try {
      const res = await fetch(tgUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const html = await res.text();
        const titleMatch =
          /<div class="tgme_page_title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i.exec(
            html
          );
        const extraMatch = /<div class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/i.exec(
          html
        );
        const photoMatch =
          /<img class="tgme_page_photo_image"[^>]+src="([^"]+)"/i.exec(html);

        const foundTitle = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
        const foundExtra = extraMatch?.[1]?.replace(/<[^>]+>/g, '').trim();

        if (foundTitle && !foundTitle.includes('Telegram: Contact')) {
          return {
            platform: 'Telegram Messenger',
            icon: '✈️',
            status: 'CONFIRMED',
            exists: true,
            url: tgUrl,
            displayName: foundTitle,
            handleOrUsername: foundExtra?.startsWith('@') ? foundExtra : undefined,
            avatarUrl: photoMatch?.[1],
            details: `حساب تيليجرام مكشوف بالرقم: ${foundTitle}${
              foundExtra ? ` (${foundExtra})` : ''
            }`,
            verificationMethod: 'Telegram Web Profile Resolver',
          };
        }
      }
    } catch {
      // Fallback
    }

    return {
      platform: 'Telegram Phone Deep-Link',
      icon: '✈️',
      status: 'SEARCH_DORK',
      exists: false,
      url: tgUrl,
      details:
        'رابط فتح محادثة مباشر عبر رقم الهاتف (يتطلب فحص الخصوصية داخل تيليجرام)',
      verificationMethod: 'Telegram Deep-Link Resolver',
    };
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
   * Executes 10 distinct search engines in parallel (`Promise.allSettled`) with strict timeouts:
   * 1. DuckDuckGo HTML (`html.duckduckgo.com`)
   * 2. DuckDuckGo Lite (`lite.duckduckgo.com`)
   * 3. Brave Search (`search.brave.com`)
   * 4. Microsoft Bing (`www.bing.com`)
   * 5. Yahoo Search (`search.yahoo.com`)
   * 6. Mojeek (`www.mojeek.com`)
   * 7. Startpage (`www.startpage.com`)
   * 8. Yandex Web (`yandex.com`)
   * 9. SearXNG Meta-Search (`opnxng.com`)
   * 10. Ahmia DeepWeb / Onion & Public Index (`ahmia.fi`)
   */
  public async queryTenSearchEnginesParallel(
    phone: NormalizedPhoneMetadata
  ): Promise<{
    mentions: LiveWebMentionHit[];
    searchEngineStats: SearchEngineExecutionStat[];
    extractedNames: DiscoveredIdentityName[];
    extractedEmails: string[];
    extractedHandles: string[];
    extractedSocialAccounts: SocialPlatformFootprint[];
    disposableMatchedDomains: string[];
  }> {
    const query = `"${phone.e164}" OR "${phone.digitsOnly}" OR "${phone.significantNumber}"`;
    const compactQuery = `"${phone.e164}" OR "${phone.digitsOnly}"`;
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    interface RawHit {
      engineName: string;
      title: string;
      url: string;
      snippet: string;
    }

    const decodeHtmlEntities = (str: string): string =>
      str
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

    const extractAnchorHitsFromHtml = (
      engineName: string,
      html: string,
      blockRegex: RegExp,
      urlTransform?: (rawUrl: string) => string
    ): RawHit[] => {
      const hits: RawHit[] = [];
      let m: RegExpExecArray | null;
      while ((m = blockRegex.exec(html)) !== null && hits.length < 8) {
        let rawUrl = (m[1] || '').trim();
        if (urlTransform) {
          rawUrl = urlTransform(rawUrl);
        }
        const title = decodeHtmlEntities(m[2] || '');
        const snippet = decodeHtmlEntities(m[3] || '');
        if (
          !rawUrl.startsWith('http') ||
          !title ||
          rawUrl.includes('duckduckgo.com') ||
          (!rawUrl.includes('bing.com/ck/') && rawUrl.includes('microsoft.com')) ||
          rawUrl.includes('yahoo.com/preferences') ||
          rawUrl.includes('mojeek.com/') ||
          rawUrl.includes('brave.com/')
        ) {
          continue;
        }
        hits.push({ engineName, title, url: rawUrl, snippet });
      }
      return hits;
    };

    const unwrapDdgUrl = (rawHref: string): string => {
      const uddgMatch = /[?&]uddg=([^&]+)/.exec(rawHref);
      if (uddgMatch?.[1]) {
        try {
          return decodeURIComponent(uddgMatch[1]);
        } catch {
          return rawHref;
        }
      }
      return rawHref;
    };

    const unwrapYahooUrl = (rawHref: string): string => {
      const ruMatch = /\/RU=([^/]+)\/RK=/i.exec(rawHref);
      if (ruMatch?.[1]) {
        try {
          return decodeURIComponent(ruMatch[1]);
        } catch {
          return rawHref;
        }
      }
      return rawHref;
    };

    const engineRunners: Array<{
      name: string;
      run: () => Promise<RawHit[]>;
    }> = [
      // 1. DuckDuckGo HTML
      {
        name: 'DuckDuckGo HTML',
        run: async () => {
          const res = await fetch(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'DuckDuckGo HTML',
            html,
            /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
            unwrapDdgUrl
          );
        },
      },
      // 2. DuckDuckGo Lite
      {
        name: 'DuckDuckGo Lite',
        run: async () => {
          const res = await fetch(
            `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(compactQuery)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'DuckDuckGo Lite',
            html,
            /<a[^>]+class=['"]result-link['"][^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi,
            unwrapDdgUrl
          );
        },
      },
      // 3. Brave Search
      {
        name: 'Brave Search',
        run: async () => {
          const res = await fetch(
            `https://search.brave.com/search?q=${encodeURIComponent(compactQuery)}&source=web`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Brave Search',
            html,
            /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*heading-serpresult[^"]*"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,400}?)(?:<\/div>|<\/p>)/gi
          );
        },
      },
      // 4. Microsoft Bing
      {
        name: 'Microsoft Bing',
        run: async () => {
          const res = await fetch(
            `https://www.bing.com/search?q=${encodeURIComponent(compactQuery)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Microsoft Bing',
            html,
            /<li[^>]+class="b_algo"[^>]*>[\s\S]*?<h2><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi
          );
        },
      },
      // 5. Yahoo Search
      {
        name: 'Yahoo Search',
        run: async () => {
          const res = await fetch(
            `https://search.yahoo.com/search?p=${encodeURIComponent(compactQuery)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Yahoo Search',
            html,
            /<div[^>]+class="[^"]*algo[^"]*"[\s\S]*?<h3[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>[\s\S]*?<div[^>]+class="[^"]*compText[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
            unwrapYahooUrl
          );
        },
      },
      // 6. Mojeek Independent Index
      {
        name: 'Mojeek',
        run: async () => {
          const res = await fetch(
            `https://www.mojeek.com/search?q=${encodeURIComponent(compactQuery)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Mojeek',
            html,
            /<a[^>]+class="title"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]+class="s"[^>]*>([\s\S]*?)<\/p>/gi
          );
        },
      },
      // 7. Startpage (Google Privacy Proxy)
      {
        name: 'Startpage',
        run: async () => {
          const res = await fetch('https://www.startpage.com/sp/search', {
            method: 'POST',
            headers: {
              'User-Agent': ua,
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'text/html',
            },
            body: new URLSearchParams({ query: compactQuery, cat: 'web' }).toString(),
            signal: AbortSignal.timeout(6500),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Startpage',
            html,
            /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]+class="[^"]*w-gl__description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi
          );
        },
      },
      // 8. Yandex Search
      {
        name: 'Yandex Web',
        run: async () => {
          const res = await fetch(
            `https://yandex.com/search/?text=${encodeURIComponent(compactQuery)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Yandex Web',
            html,
            /<a[^>]+class="[^"]*OrganicTitle-Link[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div[^>]+class="[^"]*OrganicTextContentSpan[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
          );
        },
      },
      // 9. SearXNG Meta-Search Pool
      {
        name: 'SearXNG Pool',
        run: async () => {
          const res = await fetch(
            `https://opnxng.com/search?q=${encodeURIComponent(compactQuery)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'SearXNG Pool',
            html,
            /<article[^>]+class="[^"]*result[^"]*"[\s\S]*?<h3><a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>[\s\S]*?<p[^>]+class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/gi
          );
        },
      },
      // 10. Ahmia DeepWeb / Onion & Public Index
      {
        name: 'Ahmia DeepWeb',
        run: async () => {
          const res = await fetch(
            `https://ahmia.fi/search/?q=${encodeURIComponent(phone.digitsOnly)}`,
            {
              headers: { 'User-Agent': ua, Accept: 'text/html' },
              signal: AbortSignal.timeout(6500),
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const html = await res.text();
          return extractAnchorHitsFromHtml(
            'Ahmia DeepWeb',
            html,
            /<li[^>]+class="result"[\s\S]*?<h4><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h4>[\s\S]*?<p>([\s\S]*?)<\/p>/gi,
            (rawUrl) => {
              const redirectMatch = /redirect_url=(https?:\/\/[^&]+)/i.exec(rawUrl);
              return redirectMatch?.[1]
                ? decodeURIComponent(redirectMatch[1])
                : rawUrl.startsWith('http')
                ? rawUrl
                : `https://ahmia.fi${rawUrl}`;
            }
          );
        },
      },
    ];

    const searchEngineStats: SearchEngineExecutionStat[] = [];
    const allRawHits: RawHit[] = [];

    await Promise.allSettled(
      engineRunners.map(async (engine) => {
        const startedAt = Date.now();
        try {
          const hits = await engine.run();
          const latencyMs = Date.now() - startedAt;
          searchEngineStats.push({
            engineName: engine.name,
            status: hits.length > 0 ? 'OK' : 'EMPTY',
            hitsCount: hits.length,
            latencyMs,
          });
          allRawHits.push(...hits);
        } catch {
          searchEngineStats.push({
            engineName: engine.name,
            status: 'RATE_LIMITED_OR_TIMEOUT',
            hitsCount: 0,
            latencyMs: Date.now() - startedAt,
          });
        }
      })
    );

    const mentions: LiveWebMentionHit[] = [];
    const seenUrls = new Set<string>();
    const extractedNames: DiscoveredIdentityName[] = [];
    const extractedEmails = new Set<string>();
    const extractedHandles = new Set<string>();
    const extractedSocialAccounts: SocialPlatformFootprint[] = [];
    const disposableMatchedDomains: string[] = [];

    const emailRegex = /\b[A-Za-z0-9._%+-]{2,40}@[A-Za-z0-9.-]+\.[A-Za-z]{2,10}\b/g;
    const socialUrlRegex =
      /https?:\/\/(?:www\.)?(instagram\.com|facebook\.com|x\.com|twitter\.com|tiktok\.com|t\.me|linkedin\.com\/in)\/([A-Za-z0-9._@-]{3,45})/i;

    for (const hit of allRawHits) {
      const normalizedUrl = hit.url.replace(/\/+$/, '');
      if (seenUrls.has(normalizedUrl)) continue;
      seenUrls.add(normalizedUrl);

      let domain = 'web';
      try {
        domain = new URL(hit.url).hostname.replace(/^www\./, '');
      } catch {
        domain = 'web';
      }

      if (
        DISPOSABLE_SMS_DOMAINS.some(
          (d) => domain === d || domain.endsWith(`.${d}`)
        )
      ) {
        if (!disposableMatchedDomains.includes(domain)) {
          disposableMatchedDomains.push(domain);
        }
      }

      const combinedText = `${hit.title} ${hit.snippet}`;
      let emMatch: RegExpExecArray | null;
      while ((emMatch = emailRegex.exec(combinedText)) !== null) {
        const em = emMatch[0].toLowerCase();
        if (!em.endsWith('.png') && !em.endsWith('.jpg') && !em.includes('example.')) {
          extractedEmails.add(em);
        }
      }

      const socialMatch = socialUrlRegex.exec(hit.url);
      if (socialMatch?.[1] && socialMatch?.[2]) {
        const host = socialMatch[1].toLowerCase();
        const handle = socialMatch[2].replace(/^@/, '');
        if (
          !['login', 'explore', 'share', 'intent', 'hashtag', 'search', 'p', 'reel', 'watch'].includes(
            handle.toLowerCase()
          )
        ) {
          extractedHandles.add(handle);
          extractedSocialAccounts.push({
            platform: `${host} (@${handle})`,
            icon: '🌐',
            status: 'CONFIRMED',
            exists: true,
            url: hit.url,
            handleOrUsername: `@${handle}`,
            displayName: hit.title.slice(0, 60),
            details: `تم رصد الحساب مرتبطاً بالرقم عبر محرك ${hit.engineName}`,
            verificationMethod: `Multi-Engine OSINT (${hit.engineName})`,
          });
        }
      }

      if (mentions.length < 18) {
        mentions.push({
          engineSource: hit.engineName,
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
          extractedNames: [],
          sourceDomain: domain,
        });
      }

      const cleanedTitle = hit.title.replace(/\s+/g, ' ').trim();
      const isGenericNoiseTitle =
        /(?:phone\s*number|reverse\s*lookup|caller\s*id|free\s*phone|directory|spam\s*report|who\s*called|search\s*results|receive\s*sms|https?:\/\/|www\.|^\+?\d[\d\s()-]{5,}$)/i.test(
          cleanedTitle
        );
      if (
        cleanedTitle.length >= 3 &&
        cleanedTitle.length <= 70 &&
        !isGenericNoiseTitle
      ) {
        const isCallerDirectory =
          /truecaller|sync\.me|whoseno|showcaller|eyecon/i.test(domain);
        extractedNames.push({
          name: cleanedTitle.slice(0, 65),
          source: `${hit.engineName} (${domain})`,
          confidence: isCallerDirectory ? 'MEDIUM' : 'LOW',
          extraInfo: hit.url,
          observedAtIso: new Date().toISOString(),
        });
      }
    }

    return {
      mentions,
      searchEngineStats,
      extractedNames,
      extractedEmails: Array.from(extractedEmails),
      extractedHandles: Array.from(extractedHandles),
      extractedSocialAccounts,
      disposableMatchedDomains,
    };
  }

  public async scrapeLiveWebAndDirectories(
    phone: NormalizedPhoneMetadata
  ): Promise<{
    mentions: LiveWebMentionHit[];
    extractedNames: DiscoveredIdentityName[];
    disposableMatchedDomains: string[];
  }> {
    const res = await this.queryTenSearchEnginesParallel(phone);
    return {
      mentions: res.mentions,
      extractedNames: res.extractedNames,
      disposableMatchedDomains: res.disposableMatchedDomains,
    };
  }

  // =========================================================================
  // ENGINE 7: BREACHES, INFOSTEALERS, LEAKS, PASTES & CODE DUMPS SCANNER
  // =========================================================================
  /**
   * Queries 6 real-world Cyber Intelligence & Breach Databases in parallel:
   * 1. Hudson Rock Cavalier API (`cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email` & `search-by-username`)
   * 2. LeakCheck Public/Pro API (`leakcheck.io/api/public`)
   * 3. ProxyNova COMB 3.2 Billion Credential Leak Database (`api.proxynova.com/comb`)
   * 4. XposedOrNot Breach Analytics API (`api.xposedornot.com/v1/check-email/`)
   * 5. PSBDMP Pastebin Dump Archive (`psbdmp.ws/api/v3/search/`)
   * 6. Grep.app Public Git Code & Dump Search (`grep.app/api/search`)
   */
  public async scanBreachesLeaksAndPastes(
    phone: NormalizedPhoneMetadata,
    candidateEmails: string[],
    candidateHandles: string[]
  ): Promise<{
    breachExposures: BreachExposureRecord[];
    pasteAndCodeHits: PasteOrCodeDumpHit[];
  }> {
    const breachExposures: BreachExposureRecord[] = [];
    const pasteAndCodeHits: PasteOrCodeDumpHit[] = [];

    const uniqueEmails = Array.from(
      new Set(candidateEmails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')))
    ).slice(0, 3);

    const uniqueHandles = Array.from(
      new Set(
        candidateHandles
          .map((h) => h.trim().replace(/^@/, ''))
          .filter((h) => h.length >= 4 && h.length <= 32)
      )
    ).slice(0, 3);

    const leakTargets = [
      phone.digitsOnly,
      phone.e164,
      ...uniqueEmails,
      ...uniqueHandles,
    ].slice(0, 5);

    const tasks: Array<Promise<void>> = [];

    // 1. Hudson Rock Cavalier Infostealer Intelligence (Emails & Usernames)
    for (const email of uniqueEmails) {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email?email=${encodeURIComponent(
                email
              )}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              stealers?: Array<{
                date_compromised?: string;
                computer_name?: string;
                operating_system?: string;
                ip?: string;
                top_passwords?: string[];
                top_logins?: string[];
              }>;
            };
            if (Array.isArray(data?.stealers) && data.stealers.length > 0) {
              for (const st of data.stealers.slice(0, 3)) {
                breachExposures.push({
                  sourceEngine: 'HudsonRock-Cavalier',
                  targetIdentifier: email,
                  compromised: true,
                  severity: 'CRITICAL',
                  breachOrStealerName: `Infostealer Malware Log (${
                    st.operating_system || 'Device'
                  })`,
                  compromisedDate: st.date_compromised?.slice(0, 10),
                  exposedFields: ['Email', 'Saved Passwords', 'Browser Cookies', 'IP', 'OS'],
                  maskedSamples: [
                    ...(st.top_logins || []).slice(0, 2),
                    st.ip ? `IP: ${st.ip}` : '',
                  ].filter(Boolean),
                  details: `تم رصد إصابة جهاز مرتبط بالبريد (${email}) ببرمجية سحب بيانات (Infostealer)${
                    st.computer_name ? ` | الجهاز: ${st.computer_name}` : ''
                  }`,
                });
              }
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    for (const handle of uniqueHandles) {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-username?username=${encodeURIComponent(
                handle
              )}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              stealers?: Array<{
                date_compromised?: string;
                computer_name?: string;
                operating_system?: string;
                ip?: string;
              }>;
            };
            if (Array.isArray(data?.stealers) && data.stealers.length > 0) {
              const st = data.stealers[0]!;
              breachExposures.push({
                sourceEngine: 'HudsonRock-Cavalier',
                targetIdentifier: `@${handle}`,
                compromised: true,
                severity: 'HIGH',
                breachOrStealerName: `Infostealer Username Match (${
                  st.operating_system || 'System'
                })`,
                compromisedDate: st.date_compromised?.slice(0, 10),
                exposedFields: ['Username', 'Credentials', 'System Metadata'],
                maskedSamples: st.ip ? [`IP: ${st.ip}`] : [],
                details: `المعرّف @${handle} ظهر في سجلات أجهزة مصابة ببرمجيات Infostealer (${data.stealers.length} سجل)`,
              });
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    // 2. LeakCheck Public API (10B+ Records — supports Phone digits, Email, Username)
    for (const target of [phone.digitsOnly, ...uniqueEmails].slice(0, 3)) {
      tasks.push(
        (async () => {
          try {
            const apiKey = this.getLeakCheckApiKey();
            const headers: Record<string, string> = {
              Accept: 'application/json',
              'User-Agent': 'BotezzForensics/2.0',
            };
            if (apiKey) headers['X-API-Key'] = apiKey;

            const res = await fetch(
              `https://leakcheck.io/api/public?check=${encodeURIComponent(target)}`,
              {
                headers,
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              success?: boolean;
              found?: number;
              fields?: string[];
              sources?: Array<{ name?: string; date?: string }>;
            };
            if (data?.success && (data.found ?? 0) > 0) {
              const sourceNames = (data.sources || [])
                .map((s) => (s.name ? `${s.name}${s.date ? ` (${s.date})` : ''}` : ''))
                .filter(Boolean)
                .slice(0, 5);
              breachExposures.push({
                sourceEngine: 'LeakCheck-Public',
                targetIdentifier: target,
                compromised: true,
                severity: 'CRITICAL',
                breachOrStealerName:
                  sourceNames.join(' ، ') || `LeakCheck (${data.found} تسريب)`,
                compromisedDate: data.sources?.[0]?.date,
                exposedFields: Array.isArray(data.fields) ? data.fields : ['Phone/Email', 'Hash'],
                maskedSamples: [],
                details: `ظهر الهدف (${target}) في ${data.found} قاعدة بيانات مسربة موثقة لدى LeakCheck`,
              });
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    // 3. ProxyNova COMB (Compilation of Many Breaches - 3.2 Billion lines)
    for (const queryTarget of [phone.digitsOnly, ...uniqueEmails, ...uniqueHandles].slice(0, 3)) {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://api.proxynova.com/comb?query=${encodeURIComponent(queryTarget)}&start=0&limit=10`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              count?: number;
              lines?: string[];
            };
            if ((data?.count ?? 0) > 0 && Array.isArray(data.lines) && data.lines.length > 0) {
              // Mask passwords partially for safe forensic display (e.g., user@mail.com:pa****rd)
              const maskedLines = data.lines.slice(0, 4).map((line) => {
                const parts = String(line).split(/[:;]/);
                if (parts.length >= 2) {
                  const userPart = parts[0] || '';
                  const passPart = parts.slice(1).join(':');
                  const maskedPass =
                    passPart.length > 4
                      ? `${passPart.slice(0, 2)}${'*'.repeat(Math.min(6, passPart.length - 3))}${passPart.slice(-1)}`
                      : '****';
                  return `${userPart}:${maskedPass}`;
                }
                return String(line).slice(0, 40);
              });

              breachExposures.push({
                sourceEngine: 'ProxyNova-COMB',
                targetIdentifier: queryTarget,
                compromised: true,
                severity: 'CRITICAL',
                breachOrStealerName: `COMB Credential Dump (${data.count} سجل)`,
                exposedFields: ['Identifier', 'Plaintext/Hashed Password'],
                maskedSamples: maskedLines,
                details: `تم العثور على ${data.count} سجل بيانات اعتماد مسربة مطابقة لـ (${queryTarget}) في أرشيف COMB`,
              });
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    // 4. XposedOrNot Breach Analytics (for discovered emails)
    for (const email of uniqueEmails) {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              breaches?: string[][];
            };
            const flatBreaches = Array.isArray(data?.breaches?.[0])
              ? data.breaches[0]
              : Array.isArray(data?.breaches)
              ? (data.breaches as unknown as string[])
              : [];
            if (flatBreaches.length > 0) {
              breachExposures.push({
                sourceEngine: 'XposedOrNot',
                targetIdentifier: email,
                compromised: true,
                severity: 'HIGH',
                breachOrStealerName: flatBreaches.slice(0, 6).join(' ، '),
                exposedFields: ['Email', 'Account Profile'],
                maskedSamples: [],
                details: `البريد الإلكتروني (${email}) مدرج في ${flatBreaches.length} حادثة تسريب عالمية موثقة`,
              });
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    // 5. PSBDMP Pastebin Archive Search
    for (const pasteTarget of [phone.digitsOnly, ...uniqueEmails].slice(0, 2)) {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://psbdmp.ws/api/v3/search/${encodeURIComponent(pasteTarget)}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              data?: Array<{ id?: string; tags?: string; text?: string; time?: string }>;
            };
            const list = Array.isArray(data?.data) ? data.data : [];
            for (const item of list.slice(0, 3)) {
              if (!item?.id) continue;
              pasteAndCodeHits.push({
                sourceEngine: 'PSBDMP-Pastebin',
                titleOrRepo: `Pastebin Dump #${item.id}${item.tags ? ` (${item.tags})` : ''}`,
                url: `https://pastebin.com/${encodeURIComponent(item.id)}`,
                snippet: (item.text || `ذكر مباشر لـ ${pasteTarget} في ملف Pastebin`).slice(
                  0,
                  140
                ),
                recordedAt: item.time,
              });
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    // 6. Grep.app Public Code & Dump Search across GitHub/GitLab/Bitbucket
    for (const codeTarget of leakTargets.slice(0, 2)) {
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://grep.app/api/search?q=${encodeURIComponent(codeTarget)}&case=false`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(7000),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              hits?: {
                hits?: Array<{
                  repo?: { raw?: string };
                  path?: { raw?: string };
                  content?: { snippet?: string };
                }>;
              };
            };
            const hits = data?.hits?.hits || [];
            for (const h of hits.slice(0, 4)) {
              const repo = h.repo?.raw || 'repository';
              const path = h.path?.raw || '';
              const cleanSnippet = (h.content?.snippet || '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 140);
              pasteAndCodeHits.push({
                sourceEngine: 'GrepApp-GitCode',
                titleOrRepo: `${repo}/${path}`,
                url: `https://github.com/${repo}/blob/HEAD/${path}`,
                snippet: cleanSnippet || `تطابق برمجي لـ ${codeTarget}`,
              });
            }
          } catch {
            // Non-fatal
          }
        })()
      );
    }

    await Promise.allSettled(tasks);
    return { breachExposures, pasteAndCodeHits };
  }

  // =========================================================================
  // ENGINE 8: VERIFIED SOCIAL HANDLE & EMAIL PIVOT ENGINE (12+ PLATFORMS)
  // =========================================================================
  /**
   * Actively verifies handle/username and email existence across 12+ platforms
   * (Telegram, GitHub, Reddit, GitLab, Keybase, X/Twitter, TikTok, Duolingo, Gravatar)
   * using real API/HTTP checks — NEVER pushes unverified guessed URLs!
   */
  public async probeSocialHandlesPivot(
    handles: string[],
    emails: string[] = []
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
    ).slice(0, 3);

    const cleanEmails = Array.from(
      new Set(
        emails
          .map((e) => e.trim().toLowerCase())
          .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      )
    ).slice(0, 3);

    const results: SocialPlatformFootprint[] = [];
    const tasks: Array<Promise<void>> = [];

    for (const handle of cleanHandles) {
      // 1. Telegram Public Handle Verification (`https://t.me/<handle>`)
      tasks.push(
        (async () => {
          try {
            const tgUrl = `https://t.me/${encodeURIComponent(handle)}`;
            const res = await fetch(tgUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(5500),
            });
            if (!res.ok) return;
            const html = await res.text();
            const titleMatch =
              /<div class="tgme_page_title"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i.exec(
                html
              );
            const descMatch =
              /<div class="tgme_page_description"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
            const foundTitle = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
            const foundDesc = descMatch?.[1]?.replace(/<[^>]+>/g, ' ').trim();
            if (
              foundTitle &&
              !foundTitle.includes('Telegram: Contact') &&
              !html.includes('tgme_page_icon_user')
            ) {
              results.push({
                platform: `Telegram (@${handle})`,
                icon: '✈️',
                status: 'CONFIRMED',
                exists: true,
                url: tgUrl,
                handleOrUsername: `@${handle}`,
                displayName: foundTitle,
                bioOrSnippet: foundDesc?.slice(0, 100),
                details: `حساب تيليجرام عام مؤكد: ${foundTitle}${
                  foundDesc ? ` | النبذة: ${foundDesc.slice(0, 80)}` : ''
                }`,
                verificationMethod: 'Telegram Public Profile HTML Resolver',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 2. GitHub User API (`https://api.github.com/users/<handle>`)
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://api.github.com/users/${encodeURIComponent(handle)}`,
              {
                headers: {
                  Accept: 'application/vnd.github+json',
                  'User-Agent': 'BotezzForensics/2.0',
                },
                signal: AbortSignal.timeout(5500),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              login?: string;
              name?: string;
              bio?: string;
              location?: string;
              company?: string;
              blog?: string;
              public_repos?: number;
              followers?: number;
              html_url?: string;
            };
            if (data?.login) {
              results.push({
                platform: `GitHub (@${data.login})`,
                icon: '💻',
                status: 'CONFIRMED',
                exists: true,
                url: data.html_url || `https://github.com/${data.login}`,
                handleOrUsername: `@${data.login}`,
                displayName: data.name || data.login,
                bioOrSnippet: data.bio || undefined,
                details: `حساب GitHub مؤكد${data.name ? ` (${data.name})` : ''} | المستودعات: ${
                  data.public_repos ?? 0
                } | المتابعون: ${data.followers ?? 0}${
                  data.location ? ` | الموقع: ${data.location}` : ''
                }`,
                verificationMethod: 'GitHub REST API v3',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 3. Reddit Account API (`https://www.reddit.com/user/<handle>/about.json`)
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://www.reddit.com/user/${encodeURIComponent(handle)}/about.json`,
              {
                headers: {
                  Accept: 'application/json',
                  'User-Agent': 'BotezzForensics/2.0',
                },
                signal: AbortSignal.timeout(5500),
              }
            );
            if (!res.ok) return;
            const json = (await res.json()) as {
              data?: {
                name?: string;
                total_karma?: number;
                created_utc?: number;
                subreddit?: { title?: string; public_description?: string };
              };
            };
            if (json?.data?.name) {
              results.push({
                platform: `Reddit (u/${json.data.name})`,
                icon: '👽',
                status: 'CONFIRMED',
                exists: true,
                url: `https://www.reddit.com/user/${encodeURIComponent(json.data.name)}/`,
                handleOrUsername: `u/${json.data.name}`,
                displayName: json.data.subreddit?.title || json.data.name,
                details: `حساب Reddit مؤكد | نقاط Karma: ${json.data.total_karma ?? 0}`,
                verificationMethod: 'Reddit JSON Profile API',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 4. GitLab User API (`https://gitlab.com/api/v4/users?username=<handle>`)
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://gitlab.com/api/v4/users?username=${encodeURIComponent(handle)}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(5500),
              }
            );
            if (!res.ok) return;
            const list = (await res.json()) as Array<{
              username?: string;
              name?: string;
              web_url?: string;
            }>;
            const first = Array.isArray(list) ? list[0] : undefined;
            if (first?.username) {
              results.push({
                platform: `GitLab (@${first.username})`,
                icon: '🦊',
                status: 'CONFIRMED',
                exists: true,
                url: first.web_url || `https://gitlab.com/${first.username}`,
                handleOrUsername: `@${first.username}`,
                displayName: first.name || first.username,
                details: `حساب GitLab مؤكد باسم: ${first.name || first.username}`,
                verificationMethod: 'GitLab REST API v4',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 5. Keybase Cryptographic Identity Lookup (`https://keybase.io/_/api/1.0/user/lookup.json?usernames=<handle>`)
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(
                handle
              )}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
                signal: AbortSignal.timeout(5500),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              them?: Array<{
                basics?: { username?: string };
                profile?: { full_name?: string; bio?: string; location?: string };
              } | null>;
            };
            const user = data?.them?.[0];
            if (user?.basics?.username) {
              results.push({
                platform: `Keybase (@${user.basics.username})`,
                icon: '🔐',
                status: 'CONFIRMED',
                exists: true,
                url: `https://keybase.io/${encodeURIComponent(user.basics.username)}`,
                handleOrUsername: `@${user.basics.username}`,
                displayName: user.profile?.full_name || user.basics.username,
                details: `هوية Keybase مشفرة مؤكدة${
                  user.profile?.full_name ? `: ${user.profile.full_name}` : ''
                }`,
                verificationMethod: 'Keybase Identity Lookup API',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 6. X / Twitter Public Syndication / OEmbed Verification
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://publish.twitter.com/oembed?url=${encodeURIComponent(
                `https://twitter.com/${handle}`
              )}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(5500),
              }
            );
            if (res.ok) {
              const data = (await res.json()) as { author_name?: string; author_url?: string };
              results.push({
                platform: `X / Twitter (@${handle})`,
                icon: '🐦',
                status: 'CONFIRMED',
                exists: true,
                url: data.author_url || `https://x.com/${encodeURIComponent(handle)}`,
                handleOrUsername: `@${handle}`,
                displayName: data.author_name || `@${handle}`,
                details: `حساب X / Twitter مؤكد ومفعل (@${handle})`,
                verificationMethod: 'Twitter Publish OEmbed Resolver',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 7. TikTok Public Profile Verification (`https://www.tiktok.com/@<handle>`)
      tasks.push(
        (async () => {
          try {
            const tkUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
            const res = await fetch(tkUrl, {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              },
              signal: AbortSignal.timeout(5500),
            });
            if (!res.ok) return;
            const html = await res.text();
            if (
              html.includes(`"uniqueId":"${handle.toLowerCase()}"`) ||
              html.includes(`"uniqueId":"${handle}"`)
            ) {
              const nickMatch = /"nickname":"([^"]+)"/i.exec(html);
              results.push({
                platform: `TikTok (@${handle})`,
                icon: '🎵',
                status: 'CONFIRMED',
                exists: true,
                url: tkUrl,
                handleOrUsername: `@${handle}`,
                displayName: nickMatch?.[1] || `@${handle}`,
                details: `حساب TikTok مؤكد${nickMatch?.[1] ? `: ${nickMatch[1]}` : ''}`,
                verificationMethod: 'TikTok Hydration State Probe',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );
    }

    // Email-specific probes (Duolingo + Gravatar SHA256/MD5)
    for (const email of cleanEmails) {
      // 8. Duolingo Email Account Lookup
      tasks.push(
        (async () => {
          try {
            const res = await fetch(
              `https://www.duolingo.com/2017-06-30/users?email=${encodeURIComponent(email)}`,
              {
                headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(5500),
              }
            );
            if (!res.ok) return;
            const data = (await res.json()) as {
              users?: Array<{ username?: string; name?: string; streak?: number }>;
            };
            const u = data?.users?.[0];
            if (u?.username) {
              results.push({
                platform: `Duolingo (@${u.username})`,
                icon: '🦉',
                status: 'CONFIRMED',
                exists: true,
                url: `https://www.duolingo.com/profile/${encodeURIComponent(u.username)}`,
                handleOrUsername: `@${u.username}`,
                displayName: u.name || u.username,
                details: `حساب Duolingo مرتبط بالبريد (${email}) | الاسم: ${
                  u.name || u.username
                }`,
                verificationMethod: 'Duolingo User Directory API',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );

      // 9. Gravatar MD5 Profile Resolver
      tasks.push(
        (async () => {
          try {
            const md5 = crypto
              .createHash('md5')
              .update(email.trim().toLowerCase())
              .digest('hex');
            const res = await fetch(`https://en.gravatar.com/${md5}.json`, {
              headers: { Accept: 'application/json', 'User-Agent': 'BotezzForensics/2.0' },
              signal: AbortSignal.timeout(5500),
            });
            if (!res.ok) return;
            const data = (await res.json()) as {
              entry?: Array<{
                displayName?: string;
                preferredUsername?: string;
                profileUrl?: string;
                thumbnailUrl?: string;
                currentLocation?: string;
              }>;
            };
            const entry = data?.entry?.[0];
            if (entry) {
              results.push({
                platform: `Gravatar / WordPress (${email})`,
                icon: '🌐',
                status: 'CONFIRMED',
                exists: true,
                url: entry.profileUrl || `https://gravatar.com/${md5}`,
                handleOrUsername: entry.preferredUsername
                  ? `@${entry.preferredUsername}`
                  : undefined,
                displayName: entry.displayName,
                avatarUrl: entry.thumbnailUrl,
                details: `ملف Gravatar عالمي مرتبط بالبريد (${email})${
                  entry.displayName ? ` | الاسم: ${entry.displayName}` : ''
                }${entry.currentLocation ? ` | الموقع: ${entry.currentLocation}` : ''}`,
                verificationMethod: 'Gravatar MD5 JSON API',
              });
            }
          } catch {
            // Ignore
          }
        })()
      );
    }

    await Promise.allSettled(tasks);
    return results;
  }

  // =========================================================================
  // STANDALONE USERNAME / EMAIL IDENTIFIER INVESTIGATION (TOOL #5)
  // =========================================================================
  public async runIdentifierForensicInvestigation(
    rawIdentifier: string,
    actorTelegramId?: number
  ): Promise<{
    identifier: string;
    isEmail: boolean;
    socialAccounts: SocialPlatformFootprint[];
    breachExposures: BreachExposureRecord[];
    pasteAndCodeHits: PasteOrCodeDumpHit[];
  }> {
    const cleaned = String(rawIdentifier || '').trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned);
    const handle = isEmail ? cleaned.split('@')[0]! : cleaned.replace(/^@/, '');
    const dummyPhone = parseAndNormalizePhoneInput('+967770000000');

    const [socialAccounts, breachScan] = await Promise.all([
      this.probeSocialHandlesPivot([handle], isEmail ? [cleaned] : []),
      this.scanBreachesLeaksAndPastes(
        dummyPhone,
        isEmail ? [cleaned] : [],
        [handle]
      ),
    ]);

    log.debug('Completed identifier forensic investigation', {
      actorTelegramId,
      identifier: cleaned,
      socialCount: socialAccounts.length,
      breachCount: breachScan.breachExposures.length,
    });

    return {
      identifier: cleaned,
      isEmail,
      socialAccounts,
      breachExposures: breachScan.breachExposures,
      pasteAndCodeHits: breachScan.pasteAndCodeHits,
    };
  }

  // =========================================================================
  // MASTER ORCHESTRATOR: FULL PHONE, SOCIAL, 10-ENGINES & BREACH SCAN
  // =========================================================================
  public async runFullForensicInvestigation(
    rawPhoneInput: string,
    mode: ForensicInvestigationMode = 'FULL_DOSSIER',
    actorTelegramId?: number
  ): Promise<PhoneForensicReport> {
    const phone = parseAndNormalizePhoneInput(rawPhoneInput);
    const nowIso = new Date().toISOString();

    const shouldRunSocialProbes =
      mode === 'SOCIAL_ONLY' ||
      mode === 'HANDLE_EMAIL_PIVOT_ONLY' ||
      mode === 'FULL_DOSSIER';
    const shouldRunTenSearchEngines =
      mode === 'TEN_ENGINES_SCRAPE_ONLY' ||
      mode === 'PHONE_NAMES_ONLY' ||
      mode === 'BREACH_LEAKS_ONLY' ||
      mode === 'FULL_DOSSIER';
    const shouldRunBreachScan =
      mode === 'BREACH_LEAKS_ONLY' ||
      mode === 'HANDLE_EMAIL_PIVOT_ONLY' ||
      mode === 'FULL_DOSSIER';

    const [
      waFootprint,
      truecallerData,
      eyeconData,
      carrierApiData,
      igAndMeta,
      snapchatProbe,
      amazonProbe,
      telegramProbe,
      tenEnginesRes,
    ] = await Promise.all([
      this.inspectWhatsAppProtocolFootprint(phone, actorTelegramId),
      this.queryTruecallerDirectory(phone),
      this.queryEyeconDirectory(phone),
      this.queryCarrierApis(phone),
      shouldRunSocialProbes
        ? this.probeInstagramAndMetaByPhone(phone)
        : Promise.resolve(null),
      shouldRunSocialProbes ? this.probeSnapchatByPhone(phone) : Promise.resolve(null),
      shouldRunSocialProbes ? this.probeAmazonByPhone(phone) : Promise.resolve(null),
      shouldRunSocialProbes ? this.probeTelegramByPhone(phone) : Promise.resolve(null),
      shouldRunTenSearchEngines
        ? this.queryTenSearchEnginesParallel(phone)
        : Promise.resolve({
            mentions: [],
            searchEngineStats: [],
            extractedNames: [],
            extractedEmails: [],
            extractedHandles: [],
            extractedSocialAccounts: [],
            disposableMatchedDomains: [],
          }),
    ]);

    if (carrierApiData?.numverify?.carrier) {
      phone.inferredCarrier = `${carrierApiData.numverify.carrier} (${phone.inferredCarrier})`;
    } else if (carrierApiData?.carrier) {
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
    if (telegramProbe?.displayName) {
      newNames.push({
        name: telegramProbe.displayName,
        source: 'Telegram Public Profile',
        confidence: 'HIGH',
        observedAtIso: nowIso,
      });
    }
    for (const webName of tenEnginesRes.extractedNames) {
      newNames.push(webName);
    }

    const allDiscoveredNames = this.saveDiscoveredNamesForPhone(phone.e164, newNames);

    // Collect candidate emails & handles for cross-platform pivot and breach intelligence
    const candidateEmails: string[] = [...tenEnginesRes.extractedEmails];
    if (truecallerData?.email) candidateEmails.push(truecallerData.email);
    if (waFootprint.businessEmail) candidateEmails.push(waFootprint.businessEmail);

    const candidateHandles: string[] = [...tenEnginesRes.extractedHandles];
    if (igAndMeta?.instagram.handleOrUsername) {
      candidateHandles.push(igAndMeta.instagram.handleOrUsername);
    }
    if (telegramProbe?.handleOrUsername) {
      candidateHandles.push(telegramProbe.handleOrUsername);
    }
    for (const em of candidateEmails) {
      const prefix = em.split('@')[0];
      if (prefix) candidateHandles.push(prefix);
    }
    for (const site of waFootprint.businessWebsites) {
      const m =
        /(?:instagram\.com|twitter\.com|x\.com|tiktok\.com|t\.me|facebook\.com)\/@?([a-zA-Z0-9._-]+)/i.exec(
          site
        );
      if (m?.[1]) candidateHandles.push(m[1]);
    }

    const [handlePivotAccounts, breachAndPastes] = await Promise.all([
      shouldRunSocialProbes
        ? this.probeSocialHandlesPivot(candidateHandles, candidateEmails)
        : Promise.resolve([]),
      shouldRunBreachScan
        ? this.scanBreachesLeaksAndPastes(phone, candidateEmails, candidateHandles)
        : Promise.resolve({ breachExposures: [], pasteAndCodeHits: [] }),
    ]);

    // Build unified Social Accounts list
    const socialAccounts: SocialPlatformFootprint[] = [];

    // 1. WhatsApp
    const waExists =
      waFootprint.registered || Boolean(igAndMeta?.metaWhatsAppResetLinked);
    socialAccounts.push({
      platform: 'WhatsApp Messenger',
      icon: '🟢',
      status: waExists
        ? 'CONFIRMED'
        : waFootprint.checked
        ? 'NOT_FOUND'
        : 'SEARCH_DORK',
      exists: waExists,
      url: waFootprint.directChatUrl,
      displayName: waFootprint.verifiedBusinessName || waFootprint.pushName,
      details: waExists
        ? `مرتبط بحساب واتساب نشط${
            waFootprint.lid ? ` (LID: ${waFootprint.lid})` : ''
          }${
            waFootprint.statusBio ? ` | النبذة: ${waFootprint.statusBio}` : ''
          }`
        : waFootprint.checked
        ? 'الرقم غير مسجل حالياً على واتساب'
        : 'يتطلب جلسة واتساب متصلة للفحص المباشر',
      verificationMethod: waFootprint.checked
        ? 'Baileys USync + Full Profile Inspector'
        : 'Meta Account Recovery Probe (can_wa_reset)',
    });

    // 2. Telegram Probe
    if (telegramProbe) {
      socialAccounts.push(telegramProbe);
    }

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

    // 6. Discovered Social Accounts from 10 Search Engines & Handle Pivot
    socialAccounts.push(...tenEnginesRes.extractedSocialAccounts);
    socialAccounts.push(...handlePivotAccounts);

    const osintDorks = this.buildPhoneInfogaDorks(phone);

    const topName =
      allDiscoveredNames[0]?.name ||
      waFootprint.verifiedBusinessName ||
      waFootprint.pushName ||
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
      breachCount: breachAndPastes.breachExposures.length,
      timestampIso: nowIso,
    });

    log.debug('Completed forensic phone investigation', {
      phoneE164: phone.e164,
      mode,
      waChecked: waFootprint.checked,
      waRegistered: waFootprint.registered,
      namesCount: allDiscoveredNames.length,
      socialCount: socialAccounts.length,
      breachCount: breachAndPastes.breachExposures.length,
      enginesQueried: tenEnginesRes.searchEngineStats.length,
    });

    const finalReport: PhoneForensicReport = {
      reportId: `cfor_${crypto.randomBytes(4).toString('hex')}`,
      generatedAtIso: nowIso,
      mode,
      phone,
      discoveredNames: allDiscoveredNames,
      whatsappFootprint: waFootprint,
      truecallerData,
      eyeconData,
      carrierApiData,
      socialAccounts,
      searchEngineStats: tenEnginesRes.searchEngineStats,
      liveWebMentions: tenEnginesRes.mentions,
      breachExposures: breachAndPastes.breachExposures,
      pasteAndCodeHits: breachAndPastes.pasteAndCodeHits,
      osintDorks,
      isDisposableBurner: tenEnginesRes.disposableMatchedDomains.length > 0,
      disposableMatchedDomains: tenEnginesRes.disposableMatchedDomains,
    };

    this.saveFullForensicReportToCache(finalReport);
    return finalReport;
  }
}
