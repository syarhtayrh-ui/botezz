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

  export interface AuthenticationState {
    creds: AuthenticationCreds;
    keys: unknown;
  }

  export type AnyMessageContent =
    | { text: string }
    | { image: Buffer; mimetype?: string; caption?: string }
    | { video: Buffer; mimetype?: string; caption?: string }
    | { audio: Buffer; mimetype?: string; ptt?: boolean }
    | { document: Buffer; mimetype: string; fileName?: string; caption?: string }
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
    message?: Record<string, unknown> | null;
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
    };
    waitForSocketOpen(): Promise<void>;
    requestPairingCode(phoneNumber: string, customPairingCode?: string): Promise<string>;
    sendMessage(
      jid: string,
      content: AnyMessageContent,
      options?: Record<string, unknown>
    ): Promise<{ key?: WAMessageKey } | undefined>;
    relayMessage(
      jid: string,
      message: proto.IMessage,
      options?: Record<string, unknown>
    ): Promise<string>;
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
    newsletterMetadata(
      type: 'invite' | 'jid' | 'INVITE' | 'JID',
      key: string
    ): Promise<NewsletterMetadataResult | null>;
    end(error?: Error): void;
    logout(msg?: string): Promise<void>;
  }

  export namespace proto {
    export type IMessage = Record<string, unknown>;
    export const Message: Record<string, unknown>;
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
    [key: string]: unknown;
  }

  export const Browsers: {
    ubuntu(browser: string): [string, string, string];
    macOS(browser: string): [string, string, string];
    windows(browser: string): [string, string, string];
    appropriate(browser: string): [string, string, string];
  };

  export function useMultiFileAuthState(
    folder: string
  ): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;

  export function fetchLatestBaileysVersion(
    options?: Record<string, unknown>
  ): Promise<{ version: [number, number, number]; isLatest: boolean }>;

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
  export function areJidsSameUser(jid1: string | undefined, jid2: string | undefined): boolean;

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
