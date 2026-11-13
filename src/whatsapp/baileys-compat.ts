import makeWASocket, * as BaileysNamespace from '@hiroosy/baileys-lite';
import {
  DisconnectReason,
  Browsers,
  STORIES_JID,
  S_WHATSAPP_NET,
  DEFAULT_CONNECTION_CONFIG,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  proto,
  jidEncode,
  jidDecode,
  jidNormalizedUser,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
  isJidBroadcast,
  isLidUser,
  isPnUser,
  areJidsSameUser,
  getBinaryNodeChild,
  getAllBinaryNodeChildren,
  getBinaryNodeChildren,
  encodeSignedDeviceIdentity,
  parseAndInjectE2ESessions,
  getContentType,
  normalizeMessageContent,
  extractMessageContent,
  downloadMediaMessage,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  generateForwardMessageContent,
  generateWAMessage,
  generateWAMessageContent,
  prepareWAMessageMedia,
  prepareDisappearingMessageSettingContent,
  encodeWAMessage,
  generateMessageIDV2,
  generateMessageID,
  USyncQuery,
  USyncUser,
  isTcTokenExpired,
  shouldSendNewTcToken,
  resolveTcTokenJid,
  resolveIssuanceJid,
  buildTcTokenFromJid,
  storeTcTokensFromIqResult,
  NACK_REASONS,
  SERVER_ERROR_CODES,
  type USyncQueryResultItem,
  type WASocket,
  type UserFacingSocketConfig,
  type AuthenticationState,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type SignalRepository,
  type BaileysEventEmitter,
  type ConnectionState,
  type ReachoutTimelockInfo,
  type TcTokenEntry,
  type GroupMetadata,
  type GroupParticipant,
  type ParticipantAction,
  type NewsletterMetadataResult,
  type AnyMessageContent,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type MessageUserReceiptUpdate,
  type BinaryNode,
  type WAPresence,
  type PresenceData,
  type WABusinessHoursConfig,
  type WABusinessProfile,
} from '@hiroosy/baileys-lite';
import Voip from '@hiroosy/baileys-lite/voip';

export const USERNAME_MIN_LENGTH = 4;
export const USERNAME_MAX_LENGTH = 30;
const USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9._]*$/;

export function normalizeUsername(input: string): string {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/^@/, '');
}

export function isValidUsername(input: string): boolean {
  const handle = normalizeUsername(input);
  if (handle.length < USERNAME_MIN_LENGTH || handle.length > USERNAME_MAX_LENGTH) {
    return false;
  }
  return USERNAME_PATTERN.test(handle);
}

export function isValidUsernameKey(key: string): boolean {
  return typeof key === 'string' && /^\d{4}$/.test(key);
}

// Ensure USyncQuery.prototype.withDevicesProtocol aliases withDeviceProtocol on @hiroosy/baileys-lite
if (
  typeof USyncQuery === 'function' &&
  USyncQuery.prototype &&
  typeof USyncQuery.prototype.withDevicesProtocol !== 'function' &&
  typeof USyncQuery.prototype.withDeviceProtocol === 'function'
) {
  USyncQuery.prototype.withDevicesProtocol = USyncQuery.prototype.withDeviceProtocol;
}

export const getDevice: (
  id: string
) => 'ios' | 'web' | 'android' | 'desktop' | 'unknown' =
  (
    BaileysNamespace as unknown as {
      getDevice?: (id: string) => 'ios' | 'web' | 'android' | 'desktop' | 'unknown';
    }
  ).getDevice ||
  ((id = '') =>
    /^3A.{18}$/.test(id)
      ? 'ios'
      : /^3E.{20}$/.test(id)
        ? 'web'
        : /^(.{21}|.{32})$/.test(id)
          ? 'android'
          : /^(3F|.{18}$)/.test(id)
            ? 'desktop'
            : 'unknown');

export const extractAddressingContext: (
  stanza: BinaryNode
) => {
  addressingMode: string;
  altSender?: string;
  altRecipient?: string;
} =
  (
    BaileysNamespace as unknown as {
      extractAddressingContext?: (stanza: BinaryNode) => {
        addressingMode: string;
        altSender?: string;
        altRecipient?: string;
      };
    }
  ).extractAddressingContext ||
  ((stanza: BinaryNode) => ({
    addressingMode: stanza?.attrs?.addressing_mode || 'pn',
  }));

export async function getUSyncDevices(
  sock: Partial<WASocket> | CompatibleWhatsAppSocket,
  jids: string[],
  useCache = true,
  ignoreZeroDevices = false
): Promise<Array<{ user: string; device: number; jid?: string }>> {
  if (typeof sock?.getUSyncDevices === 'function') {
    return await sock.getUSyncDevices(jids, useCache, ignoreZeroDevices);
  }
  return [];
}

export const BAILEYS_LITE_LIBRARY_NAME = '@hiroosy/baileys-lite' as const;
export const BAILEYS_LITE_LIBRARY_VERSION = '0.3.7' as const;
export const BAILEYS_LITE_DISPLAY_TAG = `${BAILEYS_LITE_LIBRARY_NAME}@${BAILEYS_LITE_LIBRARY_VERSION}` as const;

export type EngineeringFailureClass =
  | 'API mismatch'
  | 'Protocol failure'
  | 'Auth failure'
  | 'Network failure'
  | 'VoIP failure'
  | 'Media failure';

export interface ClassifiedEngineeringFailure {
  failureClass: EngineeringFailureClass;
  category: EngineeringFailureClass;
  code:
    | 'API_MISMATCH'
    | 'PROTOCOL_FAILURE'
    | 'AUTH_FAILURE'
    | 'NETWORK_FAILURE'
    | 'VOIP_FAILURE'
    | 'MEDIA_FAILURE';
  reasonArabic: string;
  technicalReason: string;
  summary: string;
}

/**
 * Classifies any runtime/library error into one of the 6 engineering failure categories:
 * - API mismatch
 * - Protocol failure
 * - Auth failure
 * - Network failure
 * - VoIP failure
 * - Media failure
 */
export function classifyEngineeringFailure(
  err: unknown
): ClassifiedEngineeringFailure {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err ?? '');
  const lower = msg.toLowerCase();

  if (
    lower.includes('is not a function') ||
    lower.includes('api mismatch') ||
    lower.includes('missing capability') ||
    lower.includes('unsupported export')
  ) {
    return {
      failureClass: 'API mismatch',
      category: 'API mismatch',
      code: 'API_MISMATCH',
      reasonArabic: 'عدم تطابق في واجهة البرمجة (API mismatch) مع مكتبة البروتوكول.',
      technicalReason: msg,
      summary: msg,
    };
  }

  if (
    lower.includes('voip') ||
    lower.includes('srtp') ||
    lower.includes('rtp') ||
    lower.includes('relay') ||
    lower.includes('call') ||
    lower.includes('طبقة الوسائط voip')
  ) {
    return {
      failureClass: 'VoIP failure',
      category: 'VoIP failure',
      code: 'VOIP_FAILURE',
      reasonArabic: 'فشل في طبقة مكالمات VoIP أو تفاوض الوسائط.',
      technicalReason: msg,
      summary: msg,
    };
  }

  if (
    lower.includes('ffmpeg') ||
    lower.includes('ffprobe') ||
    lower.includes('codec') ||
    lower.includes('video') ||
    lower.includes('audio') ||
    lower.includes('media') ||
    lower.includes('ملف الفيديو') ||
    lower.includes('path traversal')
  ) {
    return {
      failureClass: 'Media failure',
      category: 'Media failure',
      code: 'MEDIA_FAILURE',
      reasonArabic: 'فشل في التحقق من ملف الوسائط أو معالجته عبر خط أنابيب الصوت/الفيديو.',
      technicalReason: msg,
      summary: msg,
    };
  }

  if (
    lower.includes('logged out') ||
    lower.includes('loggedout') ||
    lower.includes('bad mac') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('creds') ||
    lower.includes('auth') ||
    lower.includes('unauthorized') ||
    lower.includes('identitykey')
  ) {
    return {
      failureClass: 'Auth failure',
      category: 'Auth failure',
      code: 'AUTH_FAILURE',
      reasonArabic: 'فشل في مصادقة الجلسة أو صلاحية مفاتيح التشفير (Auth failure).',
      technicalReason: msg,
      summary: msg,
    };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('408') ||
    lower.includes('428') ||
    lower.includes('503') ||
    lower.includes('econn') ||
    lower.includes('enotfound') ||
    lower.includes('websocket')
  ) {
    return {
      failureClass: 'Network failure',
      category: 'Network failure',
      code: 'NETWORK_FAILURE',
      reasonArabic: 'انقطاع في اتصال الشبكة أو انتهاء مهلة الاتصال بخادم واتساب.',
      technicalReason: msg,
      summary: msg,
    };
  }

  return {
    failureClass: 'Protocol failure',
    category: 'Protocol failure',
    code: 'PROTOCOL_FAILURE',
    reasonArabic: 'خطأ في بروتوكول واتساب أو بنية العقد المرسلة (Protocol failure).',
    technicalReason: msg,
    summary: msg,
  };
}

/**
 * Unified CompatibleWhatsAppSocket interface isolating the application and VoIP layer
 * from internal library representation details.
 */
export interface CompatibleWhatsAppSocket {
  readonly rawSocket: WASocket;
  readonly ws: {
    readonly isOpen: boolean;
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    prependListener?(event: string, listener: (...args: any[]) => void): void;
    close(): void;
  };
  readonly ev: BaileysEventEmitter;
  readonly authState: AuthenticationState;
  readonly signalRepository?: SignalRepository;
  readonly user?: {
    id: string;
    lid?: string;
    name?: string;
  };
  sendNode(node: BinaryNode): Promise<void>;
  query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>;
  generateMessageTag(): string;
  getUSyncDevices(
    jids: string[],
    useCache?: boolean,
    ignoreZeroDevices?: boolean
  ): Promise<Array<{ user: string; device: number; jid?: string }>>;
  requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string>;
  sendMessage: WASocket['sendMessage'];
  relayMessage: WASocket['relayMessage'];
  end(error?: Error): Promise<void> | void;
  logout(msg?: string): Promise<void>;
}

/**
 * Wraps a `@hiroosy/baileys-lite` socket into a normalized `CompatibleWhatsAppSocket`
 * while preserving full access to the underlying `rawSocket` for `VoipClient` / `WaVoipCoordinator`.
 */
export function toCompatibleWhatsAppSocket(
  sockInput: WASocket | Partial<WASocket> | Record<string, unknown>
): CompatibleWhatsAppSocket {
  const sock = sockInput as WASocket;
  return {
    rawSocket: sock,
    ws: {
      get isOpen() {
        return Boolean(sock.ws?.isOpen);
      },
      on(event: string, listener: (...args: any[]) => void) {
        sock.ws?.on?.(event, listener);
      },
      off(event: string, listener: (...args: any[]) => void) {
        sock.ws?.off?.(event, listener);
      },
      prependListener(event: string, listener: (...args: any[]) => void) {
        if (typeof sock.ws?.prependListener === 'function') {
          sock.ws.prependListener(event, listener);
        } else {
          sock.ws?.on?.(event, listener);
        }
      },
      close() {
        sock.ws?.close?.();
      },
    },
    get ev() {
      return sock.ev;
    },
    get authState() {
      return sock.authState;
    },
    get signalRepository() {
      return sock.signalRepository;
    },
    get user() {
      return sock.user || sock.authState?.creds?.me;
    },
    async sendNode(node: BinaryNode): Promise<void> {
      if (typeof sock.sendNode !== 'function') {
        throw new Error('API mismatch: sock.sendNode is not a function');
      }
      await sock.sendNode(node);
    },
    async query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode> {
      if (typeof sock.query !== 'function') {
        throw new Error('API mismatch: sock.query is not a function');
      }
      return await sock.query(node, timeoutMs);
    },
    generateMessageTag(): string {
      if (typeof sock.generateMessageTag === 'function') {
        return sock.generateMessageTag();
      }
      return `${Date.now()}.${Math.floor(Math.random() * 10000)}`;
    },
    async getUSyncDevices(
      jids: string[],
      useCache = true,
      ignoreZeroDevices = false
    ): Promise<Array<{ user: string; device: number; jid?: string }>> {
      if (typeof sock.getUSyncDevices === 'function') {
        return await sock.getUSyncDevices(jids, useCache, ignoreZeroDevices);
      }
      return [];
    },
    async requestPairingCode(
      phoneNumber: string,
      customPairingCode?: string
    ): Promise<string> {
      return await sock.requestPairingCode(phoneNumber, customPairingCode);
    },
    sendMessage:
      typeof sock.sendMessage === 'function'
        ? sock.sendMessage.bind(sock)
        : (async () => undefined) as unknown as WASocket['sendMessage'],
    relayMessage:
      typeof sock.relayMessage === 'function'
        ? sock.relayMessage.bind(sock)
        : (async () => '') as unknown as WASocket['relayMessage'],
    end(error?: Error) {
      return sock.end?.(error);
    },
    async logout(msg?: string) {
      await sock.logout?.(msg);
    },
  };
}

/**
 * Creates a new WhatsApp socket using `@hiroosy/baileys-lite`.
 */
export function createCompatibleWASocket(
  config: UserFacingSocketConfig
): WASocket {
  return makeWASocket(config);
}

export {
  makeWASocket,
  BaileysNamespace as Baileys,
  Voip,
  DisconnectReason,
  Browsers,
  STORIES_JID,
  S_WHATSAPP_NET,
  DEFAULT_CONNECTION_CONFIG,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  proto,
  jidEncode,
  jidDecode,
  jidNormalizedUser,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
  isJidBroadcast,
  isLidUser,
  isPnUser,
  areJidsSameUser,
  getBinaryNodeChild,
  getAllBinaryNodeChildren,
  getBinaryNodeChildren,
  encodeSignedDeviceIdentity,
  parseAndInjectE2ESessions,
  getContentType,
  normalizeMessageContent,
  extractMessageContent,
  downloadMediaMessage,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  generateForwardMessageContent,
  generateWAMessage,
  generateWAMessageContent,
  prepareWAMessageMedia,
  prepareDisappearingMessageSettingContent,
  encodeWAMessage,
  generateMessageIDV2,
  generateMessageID,
  USyncQuery,
  USyncUser,
  isTcTokenExpired,
  shouldSendNewTcToken,
  resolveTcTokenJid,
  resolveIssuanceJid,
  buildTcTokenFromJid,
  storeTcTokensFromIqResult,
  NACK_REASONS,
  SERVER_ERROR_CODES,
  type USyncQueryResultItem,
  type WASocket,
  type UserFacingSocketConfig,
  type AuthenticationState,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type SignalRepository,
  type BaileysEventEmitter,
  type ConnectionState,
  type ReachoutTimelockInfo,
  type TcTokenEntry,
  type GroupMetadata,
  type GroupParticipant,
  type ParticipantAction,
  type NewsletterMetadataResult,
  type AnyMessageContent,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type MessageUserReceiptUpdate,
  type BinaryNode,
  type WAPresence,
  type PresenceData,
  type WABusinessHoursConfig,
  type WABusinessProfile,
};

export default makeWASocket;
