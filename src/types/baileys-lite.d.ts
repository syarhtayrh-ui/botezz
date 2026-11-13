declare module '@hiroosy/baileys-lite' {
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

  export interface BinaryNode {
    tag: string;
    attrs: Record<string, string>;
    content?: BinaryNode[] | Uint8Array | string;
    [key: string]: unknown;
  }

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
    reachoutTimeLock?: unknown;
  }

  export interface AuthenticationCreds {
    registered: boolean;
    pairingCode?: string;
    me?: {
      id: string;
      lid?: string;
      name?: string;
    };
    account?: Record<string, unknown>;
    noiseKey?: { public: Uint8Array; private: Uint8Array };
    signedIdentityKey?: { public: Uint8Array; private: Uint8Array };
    pairingEphemeralKeyPair?: { public: Uint8Array; private: Uint8Array };
    advSecretKey?: string;
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
      [C in keyof SignalDataTypeMap]?: {
        [id: string]: SignalDataTypeMap[C] | null | undefined;
      };
    }): Promise<void>;
    clear?(): Promise<void>;
  }

  export interface AuthenticationState {
    creds: AuthenticationCreds;
    keys: SignalKeyStore;
  }

  export interface SignalRepository {
    lidMapping?: {
      getLIDForPN(pnJid: string): Promise<string | undefined>;
      getPNForLID(lidJid: string): Promise<string | undefined>;
      getLIDsForPNs(pnJids: string[]): Promise<Array<{ lid: string; pn: string }> | undefined>;
      getPNsForLIDs(lidJids: string[]): Promise<Array<{ lid: string; pn: string }> | undefined>;
      storeLIDPNMappings(mappings: Array<{ lid: string; pn: string }>): Promise<void>;
    };
    jidToSignalProtocolAddress(jid: string): string;
    validateSession(jid: string): Promise<{ exists: boolean; reason?: string }>;
    encryptMessage(params: {
      jid: string;
      data: Uint8Array | Buffer;
    }): Promise<{ type: 'pkmsg' | 'msg' | string; ciphertext: Uint8Array | Buffer }>;
    decryptMessage(params: {
      jid: string;
      type: 'pkmsg' | 'msg' | string;
      ciphertext: Uint8Array | Buffer;
    }): Promise<Uint8Array | Buffer>;
    injectE2ESession?(params: { jid: string; session: unknown }): Promise<void>;
    migrateSession?(fromJid: string, toJid: string): Promise<void>;
    deleteSession?(jids: string[]): Promise<void>;
    close?(): void;
    [key: string]: unknown;
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
    | {
        audio: Buffer;
        mimetype?: string;
        ptt?: boolean;
        seconds?: number;
        viewOnce?: boolean;
      }
    | { document: Buffer; mimetype: string; fileName?: string; caption?: string }
    | { sticker: Buffer; mimetype?: string; isAnimated?: boolean }
    | { stickerPack: Record<string, unknown> }
    | {
        contacts: {
          displayName?: string;
          contacts?: Array<{ vcard: string; displayName?: string }>;
        };
      }
    | {
        location: {
          degreesLatitude: number;
          degreesLongitude: number;
          name?: string;
          address?: string;
        };
      }
    | { poll: { name: string; values: string[]; selectableCount?: number } }
    | { react: { text: string; key: WAMessageKey } }
    | { edit: WAMessageKey; text: string }
    | { delete: WAMessageKey }
    | { disappearingMessagesInChat: boolean | number }
    | Record<string, unknown>;

  export class USyncUser {
    withId(id: string): this;
    withPhone(phone: string): this;
    withType(type: string): this;
    withPersonaId(personaId: string): this;
  }

  export interface USyncQueryResultItem {
    id: string;
    lid?: string | { id?: string; lid?: string; val?: string };
    contact?: boolean | { type?: string };
    status?: { status?: string; setAt?: Date };
    disappearing_mode?: { duration?: number; setAt?: Date };
    devices?: {
      deviceList?: Array<{ id: number; keyIndex?: number; isHosted?: boolean }>;
      keyIndex?: {
        timestamp?: number;
        signedKeyIndex?: Uint8Array;
        expectedTimestamp?: number;
      };
    };
    [key: string]: unknown;
  }

  export class USyncQuery {
    withMode(mode: 'query' | 'full' | 'delta'): this;
    withContext(context: 'interactive' | 'background' | 'notification'): this;
    withContactProtocol(): this;
    withLIDProtocol(): this;
    withStatusProtocol(): this;
    withDisappearingModeProtocol(): this;
    withDevicesProtocol(): this;
    withDeviceProtocol(): this;
    withBotProfileProtocol(): this;
    withUser(user: USyncUser): this;
    parseUSyncQueryResult?(
      result: BinaryNode
    ): { list: USyncQueryResultItem[]; sideList?: USyncQueryResultItem[] } | undefined;
  }

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

  export type WAPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';

  export interface PresenceData {
    lastKnownPresence?: WAPresence;
    lastSeen?: number;
  }

  export interface WABusinessHoursConfig {
    day_of_week?: string;
    mode?: string;
    open_time?: number;
    close_time?: number;
  }

  export interface WABusinessProfile {
    wid?: string;
    description?: string;
    category?: string;
    email?: string;
    website?: string[];
    address?: string;
    latitude?: number;
    longitude?: number;
    business_hours?: {
      timezone?: string;
      config?: WABusinessHoursConfig[];
      business_config?: WABusinessHoursConfig[];
    };
    profile_options?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface BaileysEventEmitter {
    on(
      event: 'creds.update',
      listener: (creds: Partial<AuthenticationCreds>) => void
    ): void;
    on(
      event: 'connection.update',
      listener: (update: Partial<ConnectionState>) => void
    ): void;
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
      listener: (
        reactions: Array<{
          key: WAMessageKey;
          reaction: { key: WAMessageKey; text?: string | null };
        }>
      ) => void
    ): void;
    on(
      event: 'chats.set',
      listener: (payload: { chats: Array<{ id: string; [key: string]: unknown }> }) => void
    ): void;
    on(
      event: 'chats.upsert',
      listener: (chats: Array<{ id: string; [key: string]: unknown }>) => void
    ): void;
    on(
      event: 'contacts.set',
      listener: (payload: { contacts: Record<string, unknown> | Array<{ id: string; [key: string]: unknown }> }) => void
    ): void;
    on(
      event: 'contacts.upsert',
      listener: (contacts: Array<{ id: string; [key: string]: unknown }>) => void
    ): void;
    on(
      event: 'contacts.update',
      listener: (updates: Array<{ id?: string; [key: string]: unknown }>) => void
    ): void;
    on(
      event: 'messaging-history.set',
      listener: (payload: {
        chats?: Array<{ id: string; [key: string]: unknown }>;
        contacts?: Array<{ id: string; [key: string]: unknown }>;
        messages?: WAMessage[];
      }) => void
    ): void;
    on(
      event: 'presence.update',
      listener: (update: { id: string; presences: { [participant: string]: PresenceData } }) => void
    ): void;
    on(
      event: 'lid-mapping.update',
      listener: (mapping: { lid: string; pn: string }) => void
    ): void;
    on(event: string, listener: (...args: any[]) => void): void;
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
    signalRepository?: SignalRepository;
    ws?: {
      close(): void;
      isOpen?: boolean;
      on?(event: string, listener: (...args: any[]) => void): void;
      off?(event: string, listener: (...args: any[]) => void): void;
      prependListener?(event: string, listener: (...args: any[]) => void): void;
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
      type: WAPresence,
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
    executeUSyncQuery?(
      usyncQuery: USyncQuery
    ): Promise<{ list: USyncQueryResultItem[]; sideList?: USyncQueryResultItem[] } | undefined>;
    fetchDisappearingDuration?(
      ...jids: string[]
    ): Promise<Array<{ id: string; disappearing_mode?: { duration?: number; setAt?: Date } }> | undefined>;
    onWhatsApp?(...jids: string[]): Promise<Array<{ jid: string; exists: boolean; lid?: string }>>;
    getUSyncDevices?(
      jids: string[],
      useCache?: boolean,
      ignoreZeroDevices?: boolean
    ): Promise<Array<{ user: string; device: number; jid?: string }>>;
    fetchStatus?(...jids: string[]): Promise<unknown>;
    getBusinessProfile?(jid: string): Promise<WABusinessProfile | void>;
    fetchBlocklist?(): Promise<string[]>;
    fetchPrivacySettings?(force?: boolean): Promise<Record<string, string>>;
    assertSessions?(jids: string[], force?: boolean): Promise<boolean>;
    profilePictureUrl?(
      jid: string,
      type?: 'preview' | 'image',
      timeoutMs?: number
    ): Promise<string | undefined>;
    updateProfileStatus?(status: string): Promise<void>;
    uploadPreKeysToServerIfRequired?(): Promise<void>;
    sendPassiveIq?(tag: string): Promise<void>;
    sendNode?(frame: BinaryNode | Record<string, unknown>): Promise<void>;
    query?(
      node: BinaryNode | Record<string, unknown>,
      timeoutMs?: number
    ): Promise<BinaryNode>;
    waUploadToServer?: (
      filePath: string,
      opts: { mediaType: string; fileEncSha256B64: string; timeoutMs?: number }
    ) => Promise<{ mediaUrl: string; directPath: string; handle?: string }>;
    generateMessageTag?(): string;
    end(error?: Error): Promise<void> | void;
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
    export const ADVDeviceIdentity: {
      encode(message: unknown): { finish(): Uint8Array };
      decode(buffer: Uint8Array): unknown;
    };
    export const ADVSignedDeviceIdentity: {
      encode(message: unknown): { finish(): Uint8Array };
      decode(buffer: Uint8Array): unknown;
      fromObject(obj: unknown): unknown;
    };
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
  export const DEFAULT_CONNECTION_CONFIG: {
    version: [number, number, number];
    browser: [string, string, string];
    [key: string]: unknown;
  };

  export function useMultiFileAuthState(
    folder: string
  ): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;

  export function fetchLatestBaileysVersion(
    options?: Record<string, unknown>
  ): Promise<{ version: [number, number, number]; isLatest: boolean; error?: unknown }>;

  export function fetchLatestWaWebVersion(
    options?: Record<string, unknown>
  ): Promise<{ version: [number, number, number]; isLatest: boolean; error?: unknown }>;

  export function generateMessageIDV2(userId?: string): string;
  export function generateMessageID(): string;

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

  export function getBinaryNodeChild(
    node: BinaryNode | undefined,
    childTag: string
  ): BinaryNode | undefined;
  export function getAllBinaryNodeChildren(node: BinaryNode | undefined): BinaryNode[];
  export function getBinaryNodeChildren(
    node: BinaryNode | undefined,
    childTag: string
  ): BinaryNode[];

  export function encodeSignedDeviceIdentity(
    account: unknown,
    includeSignatureKey: boolean
  ): Uint8Array;

  export function parseAndInjectE2ESessions(
    node: BinaryNode,
    repository: SignalRepository
  ): Promise<void>;

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
    downloadable: {
      mediaKey?: Uint8Array | string | null;
      directPath?: string | null;
      url?: string | null;
    },
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

  export function generateWAMessageContent(
    message: AnyMessageContent,
    options?: Record<string, unknown>
  ): Promise<proto.IMessage>;

  export function prepareWAMessageMedia(
    message: AnyMessageContent,
    options?: Record<string, unknown>
  ): Promise<proto.IMessage>;

  export function prepareDisappearingMessageSettingContent(
    ephemeralExpiration?: number
  ): proto.IMessage;

  export function encodeWAMessage(message: proto.IMessage): Uint8Array;

  export function getUSyncDevices(
    jids: string[],
    useCache?: boolean,
    ignoreZeroDevices?: boolean
  ): Promise<Array<{ user: string; device: number; jid?: string }>>;

  export function makeWASocket(config: UserFacingSocketConfig): WASocket;
  export default makeWASocket;
}

declare module '@hiroosy/baileys-lite/voip' {
  import type { EventEmitter } from 'node:events';
  import type { WASocket } from '@hiroosy/baileys-lite';

  export interface VoipVideoConfig {
    width: number;
    height: number;
    frameRate: number;
    clockRate?: number;
  }

  export type VoipResolutionPreset =
    | '240p'
    | '360p'
    | '480p'
    | '720p'
    | '1080p'
    | VoipVideoConfig;

  export type VoipMediaItemInput =
    | string
    | {
        video?: string;
        audio?: string;
        autoAdvance?: boolean;
        duration?: number;
        durationMs?: number;
        resolution?: VoipResolutionPreset;
      };

  export interface WaCallMediaSessionLike {
    callId?: string;
    peerJid?: string;
    isVideo?: boolean;
    audioSendCount?: number;
    audioOctetsSent?: number;
    realAudioSendCount?: number;
    videoSendCount?: number;
    videoOctetsSent?: number;
    videoIdrSendCount?: number;
    firstPacketSent?: boolean;
    mediaFlowStarted?: boolean;
    mediaStartedAtMs?: number;
    videoEngine?: {
      accessUnitsSent?: number;
      running?: boolean;
    } | null;
    audioEngine?: {
      captureRunning?: boolean;
      playbackRunning?: boolean;
    } | null;
    [key: string]: unknown;
  }

  export type VoipCallEventName =
    | 'ringing'
    | 'connected'
    | 'ended'
    | 'error'
    | 'downgraded'
    | 'item'
    | 'peer_mute'
    | 'hand_raise'
    | 'reaction'
    | 'screen_share'
    | 'peer_video'
    | 'inbound_audio'
    | 'inbound_video';

  export interface VoipCallInstance extends EventEmitter {
    readonly callId: string | null;
    readonly target: string | null;
    readonly isVideoDowngraded: boolean;
    mediaSession?: WaCallMediaSessionLike;
    getMediaStats?(): {
      audioSendCount?: number;
      audioOctetsSent?: number;
      videoSendCount?: number;
      videoOctetsSent?: number;
      videoIdrSendCount?: number;
    };
    mute(value?: boolean): void;
    raiseHand(value?: boolean): void;
    shareScreen(value?: boolean): void;
    react(emoji: string): boolean;
    sendReaction?(emoji: string): Promise<void>;
    toggleMute?(): Promise<boolean>;
    upgradeToVideo(): Promise<void>;
    hangup(): Promise<void>;
    end?(): Promise<void>;
    silent(value?: boolean): Promise<boolean>;
    on(event: VoipCallEventName | string, listener: (...args: any[]) => void): this;
    off(event: VoipCallEventName | string, listener: (...args: any[]) => void): this;
  }

  export interface VoipCoordinatorLike {
    manager?: {
      calls?: Map<string, WaCallMediaSessionLike>;
    };
    startCall(options: {
      peerJid: string;
      isVideo?: boolean;
      audioFile?: string;
      videoConfig?: VoipVideoConfig;
    }): Promise<string>;
    acceptCall(callId: string): Promise<void>;
    rejectCall(callId: string, reason?: string): Promise<void>;
    endCall(callId: string, reason?: string): Promise<void>;
    loadAudio(callId: string, audioPath: string): Promise<void>;
    loadVideo(callId: string, videoPath: string): Promise<void>;
    startVideoMidCall(callId: string): Promise<void>;
    stopVideoMidCall(callId: string, options?: { keepSource?: boolean }): Promise<void>;
    swapVideoSource(callId: string, videoPath: string): Promise<void>;
    setMute(callId: string, muted: boolean): void;
    getCall(callId: string): Record<string, unknown> | null;
    getCalls(): Array<Record<string, unknown>>;
    on(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    dispose(): void;
  }

  export default class Voip {
    constructor(
      conn: WASocket,
      opts?: {
        ffprobePath?: string;
        voipLogLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
        maxConcurrentCalls?: number;
        tmpDir?: string;
      }
    );
    readonly calls: VoipCallInstance[];
    readonly maxConcurrentCalls: number;
    readonly coordinator: VoipCoordinatorLike | null;
    readonly incoming: Array<Record<string, unknown>>;
    listen(): Promise<this>;
    call(
      jid: string,
      media?: VoipMediaItemInput | VoipMediaItemInput[] | null,
      resolution?: VoipResolutionPreset,
      options?: {
        autoEndCall?: boolean;
        loop?: boolean;
        autoDowngrade?: boolean;
        startVideoOnFirst?: boolean;
      }
    ): Promise<VoipCallInstance | string>;
    accept(
      callId: string,
      media?: VoipMediaItemInput | VoipMediaItemInput[] | null,
      resolution?: VoipResolutionPreset,
      options?: Record<string, unknown>
    ): Promise<VoipCallInstance>;
    reject(callId: string, reason?: string): Promise<void>;
    hangup(callId?: string): Promise<void>;
    sendReaction?(emoji: string): Promise<void>;
    toggleMute?(): Promise<boolean>;
    end(force?: boolean): Promise<void>;
    on(event: VoipCallEventName | string, listener: (...args: any[]) => void): this;
    off(event: VoipCallEventName | string, listener: (...args: any[]) => void): this;
  }
}
