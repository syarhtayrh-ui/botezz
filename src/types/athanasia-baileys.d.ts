declare module 'athanasia-baileys' {
  import type { Logger } from 'pino';

  export enum DisconnectReason {
    connectionClosed = 428,
    connectionLost = 408,
    connectionReplaced = 440,
    timedOut = 408,
    loggedOut = 401,
    badSession = 500,
    restartRequired = 515,
    multideviceMismatch = 411,
    forbidden = 403,
    unavailableService = 503,
  }

  export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote';

  export interface GroupParticipant {
    id: string;
    lid?: string;
    phoneNumber?: string;
    admin?: 'admin' | 'superadmin' | null;
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
  }

  export interface GroupMetadata {
    id: string;
    addressingMode?: 'pn' | 'lid' | string;
    owner?: string;
    ownerPn?: string;
    subject: string;
    subjectOwner?: string;
    subjectTime?: number;
    creation?: number;
    desc?: string;
    descOwner?: string;
    descId?: string;
    restrict?: boolean;
    announce?: boolean;
    isCommunity?: boolean;
    isCommunityAnnounce?: boolean;
    joinApprovalMode?: boolean;
    memberAddMode?: boolean;
    size?: number;
    participants: GroupParticipant[];
    ephemeralDuration?: number;
    inviteCode?: string;
  }

  export interface NewsletterMetadataResult {
    id: string;
    state?: { type?: string } | string;
    thread_metadata?: {
      creation_time?: string | number;
      description?: { id?: string; text?: string };
      handle?: string | null;
      invite?: string;
      name?: { id?: string; text?: string };
      subscribers_count?: string | number;
      verification?: string;
    };
    name?: string;
    description?: string;
    invite?: string;
    subscribers?: number;
    verification?: string;
  }

  export interface ConnectionState {
    connection: 'open' | 'connecting' | 'close';
    lastDisconnect?: {
      error?: Error & {
        output?: {
          statusCode?: number;
          payload?: unknown;
        };
      };
      date?: Date;
    };
    isNewLogin?: boolean;
    qr?: string;
    receivedPendingNotifications?: boolean;
    isOnline?: boolean;
  }

  export interface AuthenticationCreds {
    registered: boolean;
    pairingCode?: string;
    me?: {
      id: string;
      lid?: string;
      name?: string;
    };
    platform?: string;
    device?: string;
    [key: string]: unknown;
  }

  export type SignalDataTypeMap = {
    'pre-key': unknown;
    session: unknown;
    'sender-key': unknown;
    'sender-key-memory': unknown;
    'app-state-sync-key': unknown;
    'app-state-sync-version': unknown;
    'lid-mapping': unknown;
    'device-list': unknown;
    tctoken: unknown;
    [key: string]: unknown;
  };

  export interface SignalKeyStore {
    get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }>;
    set(data: {
      [C in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[C] | null | undefined };
    }): Promise<void>;
    clear?(): Promise<void>;
  }

  export interface AuthenticationState {
    creds: AuthenticationCreds;
    keys: SignalKeyStore;
  }

  export const BufferJSON: {
    replacer(key: string, value: unknown): unknown;
    reviver(key: string, value: unknown): unknown;
  };

  export function initAuthCreds(): AuthenticationCreds;

  export function makeCacheableSignalKeyStore(
    store: SignalKeyStore,
    logger?: Logger,
    cache?: unknown
  ): SignalKeyStore;

  export type AnyMessageContent =
    | { text: string; mentions?: string[]; viewOnce?: boolean }
    | { image: Buffer; mimetype?: string; caption?: string; viewOnce?: boolean }
    | {
        video: Buffer;
        mimetype?: string;
        caption?: string;
        gifPlayback?: boolean;
        ptv?: boolean;
        viewOnce?: boolean;
      }
    | { audio: Buffer; mimetype?: string; ptt?: boolean; seconds?: number; viewOnce?: boolean }
    | { document: Buffer; mimetype: string; fileName?: string; caption?: string }
    | { sticker: Buffer; mimetype?: string; isAnimated?: boolean }
    | { stickerPack: Record<string, unknown> }
    | { contacts: { displayName?: string; contacts?: Array<{ vcard: string; displayName?: string }> } }
    | { location: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string } }
    | { poll: { name: string; values: string[]; selectableCount?: number } }
    | { react: { text: string; key: WAMessageKey } }
    | { edit: WAMessageKey; text: string }
    | { delete: WAMessageKey }
    | Record<string, unknown>;

  export interface WAMessageKey {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
  }

  export interface WAMessage {
    key: WAMessageKey;
    messageTimestamp?: number | Long;
    pushName?: string | null;
    participant?: string | null;
    message?: Record<string, unknown> | null;
    status?: number;
    userReceipt?: Array<{
      userJid: string;
      receiptTimestamp?: number | Long;
      readTimestamp?: number | Long;
      playedTimestamp?: number | Long;
    }>;
    reactions?: Array<{
      key: WAMessageKey;
      text?: string | null;
      senderTimestampMs?: number | Long;
    }>;
    pollUpdates?: Array<{
      pollUpdateMessageKey: WAMessageKey;
      vote?: { selectedOptions?: Uint8Array[] };
    }>;
    messageStubType?: number;
    messageStubParameters?: string[];
  }

  export interface WAMessageUpdate {
    key: WAMessageKey;
    update: Partial<WAMessage>;
  }

  export interface MessageUserReceiptUpdate {
    key: WAMessageKey;
    receipt: {
      userJid: string;
      receiptTimestamp?: number | Long;
      readTimestamp?: number | Long;
      playedTimestamp?: number | Long;
    };
  }

  type Long = { toNumber(): number } | number;

  export interface BaileysEventEmitter {
    on(event: 'creds.update', listener: (creds: Partial<AuthenticationCreds>) => void): void;
    on(event: 'connection.update', listener: (update: Partial<ConnectionState>) => void): void;
    on(
      event: 'groups.update',
      listener: (updates: Partial<GroupMetadata>[]) => void
    ): void;
    on(
      event: 'group-participants.update',
      listener: (update: {
        id: string;
        participants: string[];
        action: ParticipantAction;
      }) => void
    ): void;
    on(
      event: 'messages.upsert',
      listener: (payload: { messages: WAMessage[]; type: string }) => void
    ): void;
    on(
      event: 'messages.update',
      listener: (updates: WAMessageUpdate[]) => void
    ): void;
    on(
      event: 'message-receipt.update',
      listener: (updates: MessageUserReceiptUpdate[]) => void
    ): void;
    on(
      event: 'messages.reaction',
      listener: (reactions: Array<{ key: WAMessageKey; reaction: { key: WAMessageKey; text?: string | null } }>) => void
    ): void;
    on(
      event: 'chats.set',
      listener: (payload: { chats: Array<{ id: string; [key: string]: unknown }> }) => void
    ): void;
    on(
      event: 'contacts.set',
      listener: (payload: { contacts: Record<string, unknown> }) => void
    ): void;
    off(event: string, listener: (...args: any[]) => void): void;
  }

  export interface WASocket {
    ev: BaileysEventEmitter;
    user?: {
      id: string;
      lid?: string;
      name?: string;
    };
    authState: AuthenticationState;
    ws?: {
      close(): void;
      isOpen?: boolean;
      on?(event: string, listener: (...args: any[]) => void): void;
      off?(event: string, listener: (...args: any[]) => void): void;
    };
    waitForSocketOpen(): Promise<void>;
    requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string>;
    sendMessage(
      jid: string,
      content: AnyMessageContent,
      options?: Record<string, unknown>
    ): Promise<{ key?: WAMessageKey; message?: proto.IMessage } | undefined>;
    sendStatusMentions?(
      content: Record<string, unknown>,
      jids?: string[]
    ): Promise<WAMessage>;
    relayMessage(
      jid: string,
      message: proto.IMessage,
      options?: Record<string, unknown>
    ): Promise<string>;
    readMessages?(keys: WAMessageKey[]): Promise<void>;
    sendReceipt?(
      jid: string,
      participant: string | undefined,
      messageIds: string[],
      type?: string
    ): Promise<void>;
    updateMediaMessage?(message: WAMessage): Promise<WAMessage>;
    presenceSubscribe(toJid: string): Promise<void>;
    sendPresenceUpdate(
      type: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused',
      toJid?: string
    ): Promise<void>;
    groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>>;
    groupMetadata(jid: string): Promise<GroupMetadata>;
    groupInviteCode(jid: string): Promise<string | undefined>;
    groupAcceptInvite(code: string): Promise<string | undefined>;
    groupParticipantsUpdate(
      jid: string,
      participants: string[],
      action: ParticipantAction
    ): Promise<Array<{ status: string; jid: string }>>;
    groupLeave(id: string): Promise<void>;
    groupToggleEphemeral?(jid: string, ephemeralExpiration: number): Promise<void>;
    newsletterMetadata(
      type: 'invite' | 'jid' | 'INVITE' | 'JID',
      key: string
    ): Promise<NewsletterMetadataResult | null>;
    onWhatsApp?(...jids: string[]): Promise<Array<{ jid: string; exists: boolean; lid?: string }>>;
    fetchStatus?(...jids: string[]): Promise<unknown>;
    profilePictureUrl?(jid: string, type?: 'preview' | 'image', timeoutMs?: number): Promise<string | undefined>;
    updateProfileStatus?(status: string): Promise<void>;
    end(error?: Error): void;
    logout(msg?: string): Promise<void>;
    [key: string]: unknown;
  }

  export namespace proto {
    export type IMessage = Record<string, unknown>;
    export const Message: {
      AppStateSyncKeyData: {
        fromObject(obj: unknown): unknown;
      };
      [key: string]: unknown;
    };
    export const WebMessageInfo: Record<string, unknown>;
  }

  export interface UserFacingSocketConfig {
    version?: [number, number, number];
    auth: AuthenticationState;
    printQRInTerminal?: boolean;
    logger?: Logger;
    browser?: [string, string, string];
    markOnlineOnConnect?: boolean;
    syncFullHistory?: boolean;
    generateHighQualityLinkPreview?: boolean;
    cachedGroupMetadata?: (jid: string) => Promise<GroupMetadata | undefined>;
    getMessage?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
    [key: string]: unknown;
  }

  export const Browsers: {
    ubuntu(browser: string): [string, string, string];
    macOS(browser: string): [string, string, string];
    windows(browser: string): [string, string, string];
    appropriate(browser: string): [string, string, string];
  };

  export const STORIES_JID: string;
  export const S_WHATSAPP_NET: string;

  export function useMultiFileAuthState(
    folder: string
  ): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;

  export function fetchLatestBaileysVersion(
    options?: Record<string, unknown>
  ): Promise<{ version: [number, number, number]; isLatest: boolean; error?: unknown }>;

  export function fetchLatestWaWebVersion(
    options?: Record<string, unknown>
  ): Promise<{ version: [number, number, number]; isLatest: boolean; error?: unknown }>;

  export function jidEncode(
    user: string | number | null | undefined,
    server: string,
    device?: number,
    agent?: number
  ): string;

  export function jidDecode(
    jid: string | undefined
  ): { user: string; server: string; device?: number; domainType?: number } | undefined;

  export function jidNormalizedUser(jid: string | undefined): string;
  export function isJidGroup(jid: string | undefined): boolean | undefined;
  export function isJidStatusBroadcast(jid: string | undefined): boolean;
  export function isJidNewsletter(jid: string | undefined): boolean | undefined;
  export function isJidBroadcast(jid: string | undefined): boolean | undefined;
  export function isLidUser(jid: string | undefined): boolean | undefined;
  export function isPnUser(jid: string | undefined): boolean | undefined;
  export function areJidsSameUser(jid1: string | undefined, jid2: string | undefined): boolean;

  export function getContentType(
    content: Record<string, unknown> | null | undefined
  ): string | undefined;

  export function normalizeMessageContent(
    content: Record<string, unknown> | null | undefined
  ): Record<string, unknown> | undefined;

  export function extractMessageContent(
    content: Record<string, unknown> | null | undefined
  ): Record<string, unknown> | undefined;

  export function downloadMediaMessage(
    message: WAMessage | { key?: WAMessageKey; message?: Record<string, unknown> | null },
    type: 'buffer' | 'stream',
    options?: Record<string, unknown>,
    ctx?: Record<string, unknown>
  ): Promise<Buffer | NodeJS.ReadableStream>;

  export function downloadContentFromMessage(
    downloadable: { mediaKey?: Uint8Array | string | null; directPath?: string | null; url?: string | null },
    type: string,
    opts?: Record<string, unknown>
  ): Promise<AsyncIterable<Buffer>>;

  export function generateWAMessageFromContent(
    jid: string,
    message: proto.IMessage,
    options?: Record<string, unknown>
  ): { key: WAMessageKey; message: proto.IMessage; [key: string]: unknown };

  export function generateForwardMessageContent(
    message: WAMessage | Record<string, unknown>,
    forceForward?: boolean
  ): proto.IMessage;

  export function generateWAMessage(
    jid: string,
    content: AnyMessageContent,
    options?: Record<string, unknown>
  ): Promise<WAMessage>;

  export function prepareWAMessageMedia(
    message: AnyMessageContent,
    options?: Record<string, unknown>
  ): Promise<proto.IMessage>;

  export function makeWASocket(config: UserFacingSocketConfig): WASocket;
  export default makeWASocket;
}
