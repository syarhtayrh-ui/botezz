import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  normalizeMessageContent,
  extractMessageContent,
  getContentType,
  downloadMediaMessage,
  isJidStatusBroadcast,
  isJidNewsletter,
  isJidGroup,
  isLidUser,
  STORIES_JID,
  WAMessage,
  AnyMessageContent,
  WASocket,
} from 'athanasia-baileys';
import {
  DeliveryTrackingState,
  FunctionFailureCategory,
  FunctionLabRepository,
} from '../database/repositories/function-lab-repository';
import { ValidationError, UnsupportedOperationError, WhatsAppConnectionError } from '../utils/errors';
import { sanitizeFileName } from '../security/validation';
import { createLogger } from '../logging/logger';

const log = createLogger('message-capabilities');

export type NormalizedWhatsAppMessageCategory =
  | 'plain_text'
  | 'extended_text'
  | 'quoted_message'
  | 'image'
  | 'video'
  | 'gif_video'
  | 'audio'
  | 'voice_ptt'
  | 'document'
  | 'sticker'
  | 'animated_sticker'
  | 'sticker_pack'
  | 'contact'
  | 'contact_list'
  | 'location'
  | 'live_location'
  | 'poll_creation'
  | 'poll_update'
  | 'reaction'
  | 'message_edit'
  | 'message_revoke'
  | 'interactive_buttons'
  | 'list_message'
  | 'template_message'
  | 'newsletter_message'
  | 'status_story'
  | 'ephemeral_setting'
  | 'view_once_expired'
  | 'protocol_system'
  | 'unknown_future';

export type MessageWrapperKind =
  | 'none'
  | 'ephemeralMessage'
  | 'viewOnceMessage'
  | 'viewOnceMessageV2'
  | 'viewOnceMessageV2Extension'
  | 'documentWithCaptionMessage'
  | 'editedMessage'
  | 'groupMentionedMessage'
  | 'botInvokeMessage'
  | 'lottieStickerMessage';

export interface NormalizedIncomingMessage {
  messageId: string;
  remoteJid: string;
  participantJid?: string;
  isFromMe: boolean;
  isGroup: boolean;
  isNewsletter: boolean;
  isStatusBroadcast: boolean;
  isLidParticipant: boolean;
  timestampSeconds: number;
  category: NormalizedWhatsAppMessageCategory;
  rawContentType: string;
  wrappersUnwrapped: MessageWrapperKind[];
  isEphemeral: boolean;
  ephemeralExpirationSeconds?: number;
  isViewOnce: boolean;
  viewOncePrivacyRestricted: boolean;
  isEdited: boolean;
  isRevoked: boolean;
  isForwarded: boolean;
  forwardingScore: number;
  textBody?: string;
  caption?: string;
  linkPreview?: {
    canonicalUrl?: string;
    matchedText?: string;
    title?: string;
    description?: string;
  };
  quotedMessage?: {
    stanzaId: string;
    participant?: string;
    remoteJid?: string;
    quotedCategory: string;
    quotedTextPreview?: string;
  };
  mediaMetadata?: {
    mediaKind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
    mimeType: string;
    fileLengthBytes?: number;
    fileName?: string;
    seconds?: number;
    isPtt?: boolean;
    isGifPlayback?: boolean;
    isAnimatedSticker?: boolean;
    width?: number;
    height?: number;
    hasMediaKey: boolean;
    hasDirectPathOrUrl: boolean;
    canDownloadSafely: boolean;
    unavailableReasonAr?: string;
  };
  contactMetadata?: {
    count: number;
    displayNames: string[];
  };
  locationMetadata?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    isLive: boolean;
  };
  pollMetadata?: {
    name?: string;
    optionsCount?: number;
    selectableOptionsCount?: number;
    isPollUpdate: boolean;
  };
  reactionMetadata?: {
    emoji: string;
    targetMessageId?: string;
  };
  stickerPackMetadata?: {
    name?: string;
    publisher?: string;
    packId?: string;
    stickersCount?: number;
  };
  protocolMetadata?: {
    protocolType?: string | number;
    targetMessageId?: string;
    ephemeralExpiration?: number;
  };
  isDuplicateEvent: boolean;
  isMalformedPayload: boolean;
  warningsAr: string[];
}

export interface WhatsAppCapabilityMatrix {
  libraryName: 'athanasia-baileys';
  libraryVersion: string;
  textAndExtendedText: { supported: boolean; notesAr: string };
  quotedMessages: { supported: boolean; notesAr: string };
  mediaMessages: {
    image: boolean;
    video: boolean;
    gifPlayback: boolean;
    audio: boolean;
    voicePtt: boolean;
    document: boolean;
    notesAr: string;
  };
  stickers: {
    receiveWebp: boolean;
    sendWebp: boolean;
    animatedWebp: boolean;
    stickerPackMessage: boolean;
    notesAr: string;
  };
  contactsAndLocations: {
    singleContact: boolean;
    contactArray: boolean;
    staticLocation: boolean;
    liveLocation: boolean;
    notesAr: string;
  };
  pollsAndReactions: {
    pollCreation: boolean;
    pollUpdateDetection: boolean;
    reactions: boolean;
    messageEdit: boolean;
    messageDeleteRevoke: boolean;
    notesAr: string;
  };
  interactiveAndButtons: {
    buttonsMessage: boolean;
    listMessage: boolean;
    interactiveNativeFlow: boolean;
    notesAr: string;
  };
  ephemeralAndViewOnce: {
    receiveEphemeral: boolean;
    sendEphemeralExpiration: boolean;
    groupToggleEphemeral: boolean;
    detectViewOnce: boolean;
    sendViewOnce: boolean;
    privacyEnforcedNoBypass: boolean;
    notesAr: string;
  };
  statusAndStories: {
    receiveStatusBroadcast: boolean;
    downloadStatusMedia: boolean;
    replyToStatus: boolean;
    reactToStatus: boolean;
    publishStatusBroadcast: boolean;
    sendStatusMentions: boolean;
    notesAr: string;
  };
}

/**
 * Inspects and reports the exact WhatsApp protocol capabilities supported by the installed
 * `athanasia-baileys` library and optionally a live socket instance.
 */
export class WhatsAppCapabilityAdapter {
  public getCapabilityMatrix(sock?: Partial<WASocket> | null): WhatsAppCapabilityMatrix {
    const hasSendMessage = !sock || typeof sock.sendMessage === 'function';
    const hasRelayMessage = !sock || typeof sock.relayMessage === 'function';
    const hasStatusMentions = !sock || typeof sock.sendStatusMentions === 'function';
    const hasGroupToggleEphemeral =
      !sock || typeof sock.groupToggleEphemeral === 'function';

    return {
      libraryName: 'athanasia-baileys',
      libraryVersion: '1.0.0',
      textAndExtendedText: {
        supported: hasSendMessage,
        notesAr:
          'مدعوم بالكامل: النص العادي، النص الممتد (ExtendedTextMessage)، المعاينات، والإشارات (Mentions).',
      },
      quotedMessages: {
        supported: hasSendMessage,
        notesAr: 'مدعوم بالكامل: الرد والاقتباس (contextInfo.quotedMessage) للنصوص والوسائط والحالات.',
      },
      mediaMessages: {
        image: hasSendMessage,
        video: hasSendMessage,
        gifPlayback: hasSendMessage,
        audio: hasSendMessage,
        voicePtt: hasSendMessage,
        document: hasSendMessage,
        notesAr:
          'مدعوم بالكامل عبر prepareWAMessageMedia و downloadMediaMessage مع التحقق الآمن من MIME والحجم.',
      },
      stickers: {
        receiveWebp: true,
        sendWebp: hasSendMessage,
        animatedWebp: hasSendMessage,
        stickerPackMessage: hasSendMessage && hasRelayMessage,
        notesAr:
          'يدعم إرسال واستقبال ملصقات WebP الثابتة والمتحركة وحزم الملصقات (stickerPackMessage عبر fflate).',
      },
      contactsAndLocations: {
        singleContact: hasSendMessage,
        contactArray: hasSendMessage,
        staticLocation: hasSendMessage,
        liveLocation: true,
        notesAr:
          'يدعم جهات الاتصال (vCard مفردة ومتعددة) والمواقع الجغرافية الثابتة واستقبال المواقع المباشرة.',
      },
      pollsAndReactions: {
        pollCreation: hasSendMessage,
        pollUpdateDetection: true,
        reactions: hasSendMessage,
        messageEdit: hasSendMessage,
        messageDeleteRevoke: hasSendMessage,
        notesAr:
          'يدعم إنشاء الاستطلاعات (pollCreationMessageV3)، التفاعلات (reactionMessage)، التعديل (edit)، والحذف للجميع (delete).',
      },
      interactiveAndButtons: {
        buttonsMessage: hasSendMessage && hasRelayMessage,
        listMessage: hasSendMessage && hasRelayMessage,
        interactiveNativeFlow: hasSendMessage && hasRelayMessage,
        notesAr:
          'مدعوم عبر generateWAMessageFromContent و relayMessage مع تغليف viewOnceMessage للأزرار التفاعلية.',
      },
      ephemeralAndViewOnce: {
        receiveEphemeral: true,
        sendEphemeralExpiration: hasSendMessage,
        groupToggleEphemeral: hasGroupToggleEphemeral,
        detectViewOnce: true,
        sendViewOnce: hasSendMessage,
        privacyEnforcedNoBypass: true,
        notesAr:
          'يدعم الرسائل المؤقتة (Ephemeral) ورصد رسائل العرض لمرة واحدة (ViewOnce V1/V2) مع الالتزام الصارم بعدم تجاوز قيود الخصوصية أو استخراج المحتوى المخفي.',
      },
      statusAndStories: {
        receiveStatusBroadcast: true,
        downloadStatusMedia: true,
        replyToStatus: hasSendMessage,
        reactToStatus: hasSendMessage,
        publishStatusBroadcast: hasSendMessage,
        sendStatusMentions: hasStatusMentions,
        notesAr:
          'يدعم استقبال حالات واتساب (status@broadcast)، الرد عليها، التفاعل معها، ونشر الحالات النصية/المرئية و sendStatusMentions عند توفر قائمة statusJidList.',
      },
    };
  }

  public assertCapabilityForOutgoing(
    payload: AnyMessageContent,
    targetJid: string,
    sock?: Partial<WASocket> | null
  ): {
    supported: boolean;
    detectedCategory: NormalizedWhatsAppMessageCategory;
    reasonAr?: string;
  } {
    const matrix = this.getCapabilityMatrix(sock);
    const isStatus = isJidStatusBroadcast(targetJid) || targetJid === STORIES_JID;

    if (isStatus && !matrix.statusAndStories.publishStatusBroadcast) {
      return {
        supported: false,
        detectedCategory: 'status_story',
        reasonAr: 'المقبس الحالي لا يدعم نشر حالات واتساب (status@broadcast).',
      };
    }

    if ('stickerPack' in payload && payload.stickerPack) {
      if (!matrix.stickers.stickerPackMessage) {
        return {
          supported: false,
          detectedCategory: 'sticker_pack',
          reasonAr: 'إرسال حزم الملصقات (stickerPackMessage) غير مدعوم في المقبس الحالي.',
        };
      }
      return { supported: true, detectedCategory: 'sticker_pack' };
    }

    if ('sticker' in payload && payload.sticker) {
      return {
        supported: matrix.stickers.sendWebp,
        detectedCategory: payload.isAnimated ? 'animated_sticker' : 'sticker',
      };
    }

    if ('image' in payload && payload.image) {
      return {
        supported: matrix.mediaMessages.image,
        detectedCategory: isStatus ? 'status_story' : 'image',
      };
    }

    if ('video' in payload && payload.video) {
      return {
        supported: matrix.mediaMessages.video,
        detectedCategory: payload.gifPlayback ? 'gif_video' : 'video',
      };
    }

    if ('audio' in payload && payload.audio) {
      return {
        supported: matrix.mediaMessages.audio,
        detectedCategory: payload.ptt ? 'voice_ptt' : 'audio',
      };
    }

    if ('document' in payload && payload.document) {
      return {
        supported: matrix.mediaMessages.document,
        detectedCategory: 'document',
      };
    }

    if ('contacts' in payload && payload.contacts && typeof payload.contacts === 'object') {
      const contactsObj = payload.contacts as { contacts?: unknown[] };
      return {
        supported: matrix.contactsAndLocations.singleContact,
        detectedCategory:
          Array.isArray(contactsObj.contacts) &&
          contactsObj.contacts.length > 1
            ? 'contact_list'
            : 'contact',
      };
    }

    if ('location' in payload && payload.location) {
      return {
        supported: matrix.contactsAndLocations.staticLocation,
        detectedCategory: 'location',
      };
    }

    if ('poll' in payload && payload.poll) {
      return {
        supported: matrix.pollsAndReactions.pollCreation,
        detectedCategory: 'poll_creation',
      };
    }

    if ('react' in payload && payload.react) {
      return {
        supported: matrix.pollsAndReactions.reactions,
        detectedCategory: 'reaction',
      };
    }

    if ('edit' in payload && payload.edit) {
      return {
        supported: matrix.pollsAndReactions.messageEdit,
        detectedCategory: 'message_edit',
      };
    }

    if ('delete' in payload && payload.delete) {
      return {
        supported: matrix.pollsAndReactions.messageDeleteRevoke,
        detectedCategory: 'message_revoke',
      };
    }

    if ('text' in payload && typeof payload.text === 'string') {
      return {
        supported: matrix.textAndExtendedText.supported,
        detectedCategory: isStatus ? 'status_story' : 'plain_text',
      };
    }

    return {
      supported: false,
      detectedCategory: 'unknown_future',
      reasonAr: 'نوع حمولة الرسالة المطلوبة غير معروف أو غير مدعوم حالياً.',
    };
  }
}

/**
 * Normalizes all incoming `WAMessage` structures into a single, defensive, strongly typed internal representation.
 * Safely unwraps up to 5 layers of nested containers (`ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2`,
 * `viewOnceMessageV2Extension`, `documentWithCaptionMessage`, `editedMessage`), enforces strict view-once privacy
 * (never exposes or downloads view-once media buffers), and tracks duplicate message IDs.
 */
export class MessageNormalizer {
  private readonly seenMessageKeys = new Set<string>();
  private readonly maxSeenKeys: number;

  constructor(options?: { maxSeenKeys?: number }) {
    this.maxSeenKeys = options?.maxSeenKeys ?? 2000;
  }

  private recordSeenKey(dedupKey: string): boolean {
    if (this.seenMessageKeys.has(dedupKey)) {
      return true;
    }
    this.seenMessageKeys.add(dedupKey);
    if (this.seenMessageKeys.size > this.maxSeenKeys) {
      const oldest = this.seenMessageKeys.values().next().value;
      if (oldest) {
        this.seenMessageKeys.delete(oldest);
      }
    }
    return false;
  }

  public normalizeIncoming(rawMsg: unknown): NormalizedIncomingMessage {
    const warningsAr: string[] = [];

    if (!rawMsg || typeof rawMsg !== 'object') {
      return {
        messageId: `malformed_${Date.now()}`,
        remoteJid: 'unknown@s.whatsapp.net',
        isFromMe: false,
        isGroup: false,
        isNewsletter: false,
        isStatusBroadcast: false,
        isLidParticipant: false,
        timestampSeconds: Math.floor(Date.now() / 1000),
        category: 'unknown_future',
        rawContentType: 'malformed',
        wrappersUnwrapped: [],
        isEphemeral: false,
        isViewOnce: false,
        viewOncePrivacyRestricted: false,
        isEdited: false,
        isRevoked: false,
        isForwarded: false,
        forwardingScore: 0,
        isDuplicateEvent: false,
        isMalformedPayload: true,
        warningsAr: ['حمولة الرسالة الواردة تالفة أو فارغة (Malformed WAMessage).'],
      };
    }

    const msg = rawMsg as Partial<WAMessage> & {
      key?: {
        id?: string | null;
        remoteJid?: string | null;
        fromMe?: boolean | null;
        participant?: string | null;
      };
      message?: Record<string, unknown> | null;
      messageTimestamp?: number | { toNumber?: () => number } | null;
    };

    const messageId = String(msg.key?.id || `unid_${Date.now()}`);
    const remoteJid = String(msg.key?.remoteJid || 'unknown@s.whatsapp.net');
    const participantJid = msg.key?.participant ? String(msg.key.participant) : undefined;
    const isFromMe = Boolean(msg.key?.fromMe);
    const isStatusBroadcast =
      Boolean(isJidStatusBroadcast(remoteJid)) || remoteJid === STORIES_JID;
    const isNewsletter = Boolean(isJidNewsletter(remoteJid));
    const isGroup = Boolean(isJidGroup(remoteJid));
    const isLidParticipant = Boolean(
      (participantJid && isLidUser(participantJid)) || isLidUser(remoteJid)
    );

    const rawTs = msg.messageTimestamp;
    const timestampSeconds =
      typeof rawTs === 'number'
        ? rawTs
        : typeof rawTs === 'object' &&
            rawTs !== null &&
            typeof rawTs.toNumber === 'function'
          ? rawTs.toNumber()
          : Math.floor(Date.now() / 1000);

    const dedupKey = `${remoteJid}:${messageId}:${isFromMe ? '1' : '0'}`;
    const isDuplicateEvent = Boolean(msg.key?.id) && this.recordSeenKey(dedupKey);

    const wrappersUnwrapped: MessageWrapperKind[] = [];
    let isEphemeral = false;
    let ephemeralExpirationSeconds: number | undefined;
    let isViewOnce = false;
    let isEdited = false;

    let currentContent: Record<string, unknown> | undefined =
      msg.message && typeof msg.message === 'object'
        ? (msg.message as Record<string, unknown>)
        : undefined;

    if (!currentContent) {
      warningsAr.push('الرسالة الواردة لا تحتوي على كائن محتوى (message=null).');
      return {
        messageId,
        remoteJid,
        participantJid,
        isFromMe,
        isGroup,
        isNewsletter,
        isStatusBroadcast,
        isLidParticipant,
        timestampSeconds,
        category: 'protocol_system',
        rawContentType: 'empty',
        wrappersUnwrapped,
        isEphemeral: false,
        isViewOnce: false,
        viewOncePrivacyRestricted: false,
        isEdited: false,
        isRevoked: false,
        isForwarded: false,
        forwardingScore: 0,
        isDuplicateEvent,
        isMalformedPayload: true,
        warningsAr,
      };
    }

    // Track wrapper chain explicitly before calling Baileys normalizeMessageContent
    const wrapperKeys: MessageWrapperKind[] = [
      'ephemeralMessage',
      'viewOnceMessage',
      'viewOnceMessageV2',
      'viewOnceMessageV2Extension',
      'documentWithCaptionMessage',
      'editedMessage',
      'groupMentionedMessage',
      'botInvokeMessage',
      'lottieStickerMessage',
    ];

    let cursor: Record<string, unknown> | undefined = currentContent;
    for (let depth = 0; depth < 6 && cursor; depth++) {
      let unwrappedInStep = false;
      for (const wKey of wrapperKeys) {
        const wrapperObj = cursor[wKey] as
          | { message?: Record<string, unknown> }
          | undefined;
        if (wrapperObj && typeof wrapperObj === 'object') {
          wrappersUnwrapped.push(wKey);
          if (wKey === 'ephemeralMessage') isEphemeral = true;
          if (
            wKey === 'viewOnceMessage' ||
            wKey === 'viewOnceMessageV2' ||
            wKey === 'viewOnceMessageV2Extension'
          ) {
            isViewOnce = true;
          }
          if (wKey === 'editedMessage') isEdited = true;
          if (wrapperObj.message && typeof wrapperObj.message === 'object') {
            cursor = wrapperObj.message;
            unwrappedInStep = true;
            break;
          } else {
            // View-once expired / stripped content on companion device
            cursor = undefined;
            unwrappedInStep = true;
            break;
          }
        }
      }
      if (!unwrappedInStep) break;
    }

    const normalizedContent =
      (normalizeMessageContent(msg.message as WAMessage['message']) as
        | Record<string, unknown>
        | undefined) || cursor;

    // Handle view-once wrapper whose inner content was already consumed/stripped by WhatsApp
    if (isViewOnce && (!normalizedContent || Object.keys(normalizedContent).length === 0)) {
      warningsAr.push(
        'محتوى رسالة العرض لمرة واحدة (View-Once) منتهي الصلاحية أو غير متاح على الجهاز المرافق.'
      );
      return {
        messageId,
        remoteJid,
        participantJid,
        isFromMe,
        isGroup,
        isNewsletter,
        isStatusBroadcast,
        isLidParticipant,
        timestampSeconds,
        category: 'view_once_expired',
        rawContentType: 'viewOnceExpired',
        wrappersUnwrapped,
        isEphemeral,
        isViewOnce: true,
        viewOncePrivacyRestricted: true,
        isEdited,
        isRevoked: false,
        isForwarded: false,
        forwardingScore: 0,
        isDuplicateEvent,
        isMalformedPayload: false,
        warningsAr,
      };
    }

    const rawContentType = String(
      (normalizedContent &&
        getContentType(normalizedContent as WAMessage['message'])) ||
        Object.keys(normalizedContent || {})[0] ||
        'unknown'
    );

    const innerPayload = (normalizedContent?.[rawContentType] || {}) as Record<
      string,
      unknown
    >;

    if (Boolean(innerPayload?.viewOnce)) {
      isViewOnce = true;
    }

    const contextInfo = (innerPayload?.contextInfo ||
      (normalizedContent?.messageContextInfo as Record<string, unknown> | undefined)) as
      | Record<string, unknown>
      | undefined;

    if (typeof contextInfo?.expiration === 'number' && contextInfo.expiration > 0) {
      isEphemeral = true;
      ephemeralExpirationSeconds = contextInfo.expiration;
    }

    const isForwarded = Boolean(contextInfo?.isForwarded);
    const forwardingScore = Number(contextInfo?.forwardingScore || 0);

    let quotedMessage: NormalizedIncomingMessage['quotedMessage'];
    if (contextInfo?.quotedMessage && typeof contextInfo.quotedMessage === 'object') {
      const qMsg = contextInfo.quotedMessage as Record<string, unknown>;
      const qType = String(getContentType(qMsg as WAMessage['message']) || 'unknown');
      const qInner = (qMsg[qType] || {}) as Record<string, unknown>;
      const qText =
        typeof qMsg.conversation === 'string'
          ? qMsg.conversation
          : typeof qInner.text === 'string'
            ? qInner.text
            : typeof qInner.caption === 'string'
              ? qInner.caption
              : undefined;
      quotedMessage = {
        stanzaId: String(contextInfo.stanzaId || ''),
        participant: contextInfo.participant ? String(contextInfo.participant) : undefined,
        remoteJid: contextInfo.remoteJid ? String(contextInfo.remoteJid) : undefined,
        quotedCategory: qType,
        quotedTextPreview: qText ? qText.slice(0, 120) : undefined,
      };
    }

    let category: NormalizedWhatsAppMessageCategory = 'unknown_future';
    let textBody: string | undefined;
    let caption: string | undefined;
    let isRevoked = false;
    let linkPreview: NormalizedIncomingMessage['linkPreview'];
    let mediaMetadata: NormalizedIncomingMessage['mediaMetadata'];
    let contactMetadata: NormalizedIncomingMessage['contactMetadata'];
    let locationMetadata: NormalizedIncomingMessage['locationMetadata'];
    let pollMetadata: NormalizedIncomingMessage['pollMetadata'];
    let reactionMetadata: NormalizedIncomingMessage['reactionMetadata'];
    let stickerPackMetadata: NormalizedIncomingMessage['stickerPackMetadata'];
    let protocolMetadata: NormalizedIncomingMessage['protocolMetadata'];

    const buildMediaMeta = (
      mediaKind: 'image' | 'video' | 'audio' | 'document' | 'sticker'
    ): NormalizedIncomingMessage['mediaMetadata'] => {
      const hasMediaKey = Boolean(innerPayload.mediaKey);
      const hasDirectPathOrUrl = Boolean(innerPayload.directPath || innerPayload.url);
      const fileLength = Number(innerPayload.fileLength || 0);
      const canDownloadSafely =
        !isViewOnce && hasMediaKey && hasDirectPathOrUrl;
      let unavailableReasonAr: string | undefined;

      if (isViewOnce) {
        unavailableReasonAr =
          'الرسالة محمية بخصوصية العرض لمرة واحدة (View-Once)؛ يمنع النظام استخراج أو حفظ الوسائط احتراماً لقواعد الخصوصية.';
      } else if (!hasMediaKey || !hasDirectPathOrUrl) {
        unavailableReasonAr =
          'مفتاح فك التشفير (mediaKey) أو مسار الوسائط غير متوفر أو منتهي الصلاحية.';
      }

      return {
        mediaKind,
        mimeType: String(innerPayload.mimetype || 'application/octet-stream'),
        fileLengthBytes: Number.isFinite(fileLength) && fileLength > 0 ? fileLength : undefined,
        fileName: innerPayload.fileName ? String(innerPayload.fileName) : undefined,
        seconds:
          typeof innerPayload.seconds === 'number' ? innerPayload.seconds : undefined,
        isPtt: Boolean(innerPayload.ptt),
        isGifPlayback: Boolean(innerPayload.gifPlayback),
        isAnimatedSticker: Boolean(innerPayload.isAnimated),
        width: typeof innerPayload.width === 'number' ? innerPayload.width : undefined,
        height: typeof innerPayload.height === 'number' ? innerPayload.height : undefined,
        hasMediaKey,
        hasDirectPathOrUrl,
        canDownloadSafely,
        unavailableReasonAr,
      };
    };

    switch (rawContentType) {
      case 'conversation': {
        category = isStatusBroadcast ? 'status_story' : 'plain_text';
        textBody = String(normalizedContent?.conversation || '');
        break;
      }
      case 'extendedTextMessage': {
        textBody = String(innerPayload.text || '');
        if (innerPayload.matchedText || innerPayload.canonicalUrl || innerPayload.title) {
          linkPreview = {
            canonicalUrl: innerPayload.canonicalUrl
              ? String(innerPayload.canonicalUrl)
              : undefined,
            matchedText: innerPayload.matchedText
              ? String(innerPayload.matchedText)
              : undefined,
            title: innerPayload.title ? String(innerPayload.title) : undefined,
            description: innerPayload.description
              ? String(innerPayload.description)
              : undefined,
          };
        }
        category = isStatusBroadcast
          ? 'status_story'
          : quotedMessage
            ? 'quoted_message'
            : 'extended_text';
        break;
      }
      case 'imageMessage': {
        caption = innerPayload.caption ? String(innerPayload.caption) : undefined;
        mediaMetadata = buildMediaMeta('image');
        category = isStatusBroadcast ? 'status_story' : 'image';
        break;
      }
      case 'videoMessage':
      case 'ptvMessage': {
        caption = innerPayload.caption ? String(innerPayload.caption) : undefined;
        mediaMetadata = buildMediaMeta('video');
        category = isStatusBroadcast
          ? 'status_story'
          : mediaMetadata?.isGifPlayback
            ? 'gif_video'
            : 'video';
        break;
      }
      case 'audioMessage': {
        mediaMetadata = buildMediaMeta('audio');
        category = mediaMetadata?.isPtt ? 'voice_ptt' : 'audio';
        break;
      }
      case 'documentMessage': {
        caption = innerPayload.caption ? String(innerPayload.caption) : undefined;
        mediaMetadata = buildMediaMeta('document');
        category = 'document';
        break;
      }
      case 'stickerMessage': {
        mediaMetadata = buildMediaMeta('sticker');
        category = mediaMetadata?.isAnimatedSticker ? 'animated_sticker' : 'sticker';
        break;
      }
      case 'stickerPackMessage': {
        const stickersArr = Array.isArray(innerPayload.stickers)
          ? innerPayload.stickers
          : [];
        stickerPackMetadata = {
          name: innerPayload.name ? String(innerPayload.name) : undefined,
          publisher: innerPayload.publisher ? String(innerPayload.publisher) : undefined,
          packId: innerPayload.stickerPackId
            ? String(innerPayload.stickerPackId)
            : undefined,
          stickersCount: stickersArr.length,
        };
        category = 'sticker_pack';
        break;
      }
      case 'contactMessage': {
        contactMetadata = {
          count: 1,
          displayNames: innerPayload.displayName
            ? [String(innerPayload.displayName)]
            : [],
        };
        category = 'contact';
        break;
      }
      case 'contactsArrayMessage': {
        const list = Array.isArray(innerPayload.contacts) ? innerPayload.contacts : [];
        contactMetadata = {
          count: list.length,
          displayNames: list
            .map((c: { displayName?: string }) => c?.displayName)
            .filter(Boolean)
            .map(String),
        };
        category = 'contact_list';
        break;
      }
      case 'locationMessage': {
        locationMetadata = {
          latitude: Number(innerPayload.degreesLatitude || 0),
          longitude: Number(innerPayload.degreesLongitude || 0),
          name: innerPayload.name ? String(innerPayload.name) : undefined,
          address: innerPayload.address ? String(innerPayload.address) : undefined,
          isLive: false,
        };
        category = 'location';
        break;
      }
      case 'liveLocationMessage': {
        caption = innerPayload.caption ? String(innerPayload.caption) : undefined;
        locationMetadata = {
          latitude: Number(innerPayload.degreesLatitude || 0),
          longitude: Number(innerPayload.degreesLongitude || 0),
          isLive: true,
        };
        category = 'live_location';
        break;
      }
      case 'pollCreationMessage':
      case 'pollCreationMessageV2':
      case 'pollCreationMessageV3': {
        const opts = Array.isArray(innerPayload.options) ? innerPayload.options : [];
        pollMetadata = {
          name: innerPayload.name ? String(innerPayload.name) : undefined,
          optionsCount: opts.length,
          selectableOptionsCount: Number(innerPayload.selectableOptionsCount || 0),
          isPollUpdate: false,
        };
        category = 'poll_creation';
        break;
      }
      case 'pollUpdateMessage': {
        pollMetadata = {
          isPollUpdate: true,
        };
        category = 'poll_update';
        break;
      }
      case 'reactionMessage': {
        const targetKey = innerPayload.key as { id?: string } | undefined;
        reactionMetadata = {
          emoji: String(innerPayload.text || ''),
          targetMessageId: targetKey?.id ? String(targetKey.id) : undefined,
        };
        category = 'reaction';
        break;
      }
      case 'buttonsMessage':
      case 'buttonsResponseMessage':
      case 'interactiveMessage':
      case 'interactiveResponseMessage': {
        caption =
          typeof innerPayload.contentText === 'string'
            ? innerPayload.contentText
            : undefined;
        category = 'interactive_buttons';
        break;
      }
      case 'listMessage':
      case 'listResponseMessage': {
        caption =
          typeof innerPayload.title === 'string' ? innerPayload.title : undefined;
        category = 'list_message';
        break;
      }
      case 'templateMessage':
      case 'templateButtonReplyMessage': {
        category = 'template_message';
        break;
      }
      case 'protocolMessage': {
        const protoType = innerPayload.type;
        const targetKey = innerPayload.key as { id?: string } | undefined;
        const editedSub = innerPayload.editedMessage as
          | Record<string, unknown>
          | undefined;
        protocolMetadata = {
          protocolType:
            typeof protoType === 'number' || typeof protoType === 'string'
              ? protoType
              : undefined,
          targetMessageId: targetKey?.id ? String(targetKey.id) : undefined,
          ephemeralExpiration:
            typeof innerPayload.ephemeralExpiration === 'number'
              ? innerPayload.ephemeralExpiration
              : undefined,
        };

        // Baileys protocolMessage types: 0 = REVOKE, 3 = EPHEMERAL_SETTING, 14 = MESSAGE_EDIT
        if (protoType === 0 || protoType === 'REVOKE') {
          isRevoked = true;
          category = 'message_revoke';
        } else if (
          protoType === 14 ||
          protoType === 'MESSAGE_EDIT' ||
          Boolean(editedSub)
        ) {
          isEdited = true;
          category = 'message_edit';
          if (editedSub) {
            const edText =
              typeof editedSub.conversation === 'string'
                ? editedSub.conversation
                : typeof (editedSub.extendedTextMessage as { text?: string } | undefined)
                      ?.text === 'string'
                  ? (editedSub.extendedTextMessage as { text: string }).text
                  : undefined;
            if (edText) textBody = edText;
          }
        } else if (
          protoType === 3 ||
          protoType === 'EPHEMERAL_SETTING' ||
          typeof innerPayload.ephemeralExpiration === 'number'
        ) {
          isEphemeral = true;
          ephemeralExpirationSeconds = Number(innerPayload.ephemeralExpiration || 0);
          category = 'ephemeral_setting';
        } else {
          category = 'protocol_system';
        }
        break;
      }
      default: {
        if (isNewsletter) {
          category = 'newsletter_message';
        } else {
          category = 'unknown_future';
          warningsAr.push(
            `تم رصد نوع رسالة غير قياسي أو مستقبلي (${rawContentType})؛ تمت معالجته بأمان دون تعطيل النظام.`
          );
        }
        break;
      }
    }

    // If view-once is active on any media message, strip any direct text/caption leak and mark privacy-restricted
    if (isViewOnce) {
      caption = undefined;
      warningsAr.push(
        'تنبيه خصوصية: الرسالة من نوع العرض لمرة واحدة (View-Once). تم حجب تحميل الوسائط التزاماً بقواعد الخصوصية.'
      );
    }

    return {
      messageId,
      remoteJid,
      participantJid,
      isFromMe,
      isGroup,
      isNewsletter,
      isStatusBroadcast,
      isLidParticipant,
      timestampSeconds,
      category,
      rawContentType,
      wrappersUnwrapped,
      isEphemeral,
      ephemeralExpirationSeconds,
      isViewOnce,
      viewOncePrivacyRestricted: isViewOnce,
      isEdited,
      isRevoked,
      isForwarded,
      forwardingScore,
      textBody,
      caption,
      linkPreview,
      quotedMessage,
      mediaMetadata,
      contactMetadata,
      locationMetadata,
      pollMetadata,
      reactionMetadata,
      stickerPackMetadata,
      protocolMetadata,
      isDuplicateEvent,
      isMalformedPayload: false,
      warningsAr,
    };
  }
}

export interface StickerValidationResult {
  valid: boolean;
  isWebp: boolean;
  isAnimated: boolean;
  sizeBytes: number;
  width?: number;
  height?: number;
  reasonAr?: string;
}

export interface SafeMediaDownloadResult {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  tempFilePath?: string;
  cleanup: () => void;
}

/**
 * Safe Media & Sticker Processor.
 * Performs magic-byte MIME detection, WebP sticker validation (RIFF/WEBP + VP8X animation flag),
 * strict file size limits, path-traversal-safe temporary file management, and privacy-respecting
 * encrypted media downloads via `athanasia-baileys` `downloadMediaMessage`.
 */
export class MediaProcessor {
  private readonly maxMediaBytes: number;
  private readonly maxStickerBytes: number;
  private readonly tempDir: string;

  constructor(options?: {
    maxMediaSizeMb?: number;
    maxStickerSizeKb?: number;
    tempDir?: string;
  }) {
    this.maxMediaBytes = (options?.maxMediaSizeMb ?? 20) * 1024 * 1024;
    this.maxStickerBytes = (options?.maxStickerSizeKb ?? 1024) * 1024;
    this.tempDir = path.resolve(options?.tempDir || './data/tmp');
  }

  /**
   * Detects MIME type safely from magic bytes first, falling back to declared MIME.
   */
  public detectMimeType(buffer: Buffer, declaredMime?: string): string {
    if (buffer.length >= 12) {
      // RIFF....WEBP
      if (
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      ) {
        return 'image/webp';
      }
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      ) {
        return 'image/png';
      }
      // JPEG: FF D8 FF
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
      }
      // GIF: GIF87a / GIF89a
      if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
        return 'image/gif';
      }
      // PDF: %PDF
      if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
        return 'application/pdf';
      }
      // OGG: OggS
      if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
        return 'audio/ogg; codecs=opus';
      }
      // MP4: ....ftyp
      if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        return 'video/mp4';
      }
      // MP3: ID3 or FF FB
      if (
        buffer.subarray(0, 3).toString('ascii') === 'ID3' ||
        (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
      ) {
        return 'audio/mpeg';
      }
    }
    return declaredMime || 'application/octet-stream';
  }

  /**
   * Validates WebP sticker binary header, animation chunk (`VP8X` + `ANIM`), and size constraints.
   */
  public validateWebpSticker(buffer: Buffer): StickerValidationResult {
    const sizeBytes = buffer.length;
    if (sizeBytes < 16) {
      return {
        valid: false,
        isWebp: false,
        isAnimated: false,
        sizeBytes,
        reasonAr: 'حجم بيانات الملصق صغير جداً أو تالف.',
      };
    }

    if (sizeBytes > this.maxStickerBytes) {
      return {
        valid: false,
        isWebp: false,
        isAnimated: false,
        sizeBytes,
        reasonAr: `حجم الملصق (${Math.round(sizeBytes / 1024)}KB) يتجاوز الحد المسموح (${Math.round(this.maxStickerBytes / 1024)}KB).`,
      };
    }

    const riff = buffer.subarray(0, 4).toString('ascii');
    const webp = buffer.subarray(8, 12).toString('ascii');
    if (riff !== 'RIFF' || webp !== 'WEBP') {
      return {
        valid: false,
        isWebp: false,
        isAnimated: false,
        sizeBytes,
        reasonAr: 'الملف ليس بصيغة WebP صالحة (ترويسة RIFF/WEBP مفقودة).',
      };
    }

    const chunkHeader = buffer.subarray(12, 16).toString('ascii');
    let isAnimated = false;
    let width: number | undefined;
    let height: number | undefined;

    if (chunkHeader === 'VP8X' && buffer.length >= 30) {
      const flags = buffer[20];
      isAnimated = (flags & 0x02) !== 0;
      width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
      height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    }

    return {
      valid: true,
      isWebp: true,
      isAnimated,
      sizeBytes,
      width,
      height,
    };
  }

  /**
   * Resolves a safe temporary file path inside `this.tempDir` and prevents path traversal.
   */
  public createSafeTempFile(
    rawFileName: string,
    buffer: Buffer
  ): { filePath: string; cleanup: () => void } {
    if (buffer.length > this.maxMediaBytes) {
      throw new ValidationError(
        `حجم ملف الوسائط (${(buffer.length / (1024 * 1024)).toFixed(2)}MB) يتجاوز الحد الأقصى المسموح.`
      );
    }

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
    }

    const safeBase = sanitizeFileName(rawFileName || 'media.bin');
    const uniqueName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeBase}`;
    const candidatePath = path.resolve(this.tempDir, uniqueName);

    const normalizedRoot = this.tempDir.endsWith(path.sep)
      ? this.tempDir
      : `${this.tempDir}${path.sep}`;
    if (!candidatePath.startsWith(normalizedRoot)) {
      throw new ValidationError('تم رفض مسار الملف المؤقت لمنع اختراق المجلدات (Path Traversal).');
    }

    fs.writeFileSync(candidatePath, buffer, { mode: 0o600 });

    const cleanup = () => {
      try {
        if (fs.existsSync(candidatePath)) {
          fs.unlinkSync(candidatePath);
        }
      } catch {
        // Ignore cleanup errors
      }
    };

    return { filePath: candidatePath, cleanup };
  }

  /**
   * Downloads and decrypts media from a normalized incoming message using `athanasia-baileys`
   * `downloadMediaMessage`, while strictly refusing to bypass View-Once privacy restrictions.
   */
  public async downloadIncomingMediaSafely(
    rawMessage: WAMessage,
    normalized: NormalizedIncomingMessage,
    options?: {
      timeoutMs?: number;
      saveToTempFile?: boolean;
      customDownloader?: (msg: WAMessage) => Promise<Buffer>;
    }
  ): Promise<SafeMediaDownloadResult> {
    if (normalized.isViewOnce || normalized.viewOncePrivacyRestricted) {
      throw new UnsupportedOperationError(
        'لا يُسمح بتحميل أو استخراج وسائط رسائل العرض لمرة واحدة (View-Once) التزاماً بضوابط الخصوصية.'
      );
    }

    if (!normalized.mediaMetadata) {
      throw new ValidationError('الرسالة المحددة لا تحتوي على وسائط قابلة للتحميل.');
    }

    if (!normalized.mediaMetadata.canDownloadSafely) {
      throw new ValidationError(
        normalized.mediaMetadata.unavailableReasonAr ||
          'الوسائط المرفقة غير قابلة للتحميل أو منتهية الصلاحية.'
      );
    }

    if (
      normalized.mediaMetadata.fileLengthBytes &&
      normalized.mediaMetadata.fileLengthBytes > this.maxMediaBytes
    ) {
      throw new ValidationError(
        `حجم الوسائط المعلن (${(normalized.mediaMetadata.fileLengthBytes / (1024 * 1024)).toFixed(2)}MB) يتجاوز الحد المسموح.`
      );
    }

    const timeoutMs = Math.min(Math.max(options?.timeoutMs ?? 20_000, 1000), 60_000);

    const downloadPromise = (async () => {
      if (options?.customDownloader) {
        return await options.customDownloader(rawMessage);
      }
      const downloaded = await downloadMediaMessage(rawMessage, 'buffer', {});
      return Buffer.isBuffer(downloaded)
        ? downloaded
        : Buffer.from(downloaded as unknown as Uint8Array);
    })();

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new WhatsAppConnectionError(
              'انتهت مهلة تحميل وفك تشفير ملف الوسائط من خوادم واتساب.'
            )
          ),
        timeoutMs
      )
    );

    const buffer = await Promise.race([downloadPromise, timeoutPromise]);

    if (buffer.length > this.maxMediaBytes) {
      throw new ValidationError(
        'تم إيقاف معالجة الوسائط لأن الحجم الفعلي يتجاوز السقف الآمن للذاكرة.'
      );
    }

    const detectedMime = this.detectMimeType(
      buffer,
      normalized.mediaMetadata.mimeType
    );

    if (options?.saveToTempFile) {
      const temp = this.createSafeTempFile(
        normalized.mediaMetadata.fileName || 'downloaded_media.bin',
        buffer
      );
      return {
        buffer,
        mimeType: detectedMime,
        sizeBytes: buffer.length,
        tempFilePath: temp.filePath,
        cleanup: temp.cleanup,
      };
    }

    return {
      buffer,
      mimeType: detectedMime,
      sizeBytes: buffer.length,
      cleanup: () => undefined,
    };
  }
}

export interface OutgoingMessageSendRequest {
  sessionId: string;
  targetJid: string;
  content: AnyMessageContent;
  quotedMessage?: WAMessage;
  ephemeralExpiration?: number;
  statusJidList?: string[];
  idempotencyKey?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  correlationId?: string;
}

export interface OutgoingMessageSendResult {
  messageId: string;
  correlationId: string;
  sessionId: string;
  targetJid: string;
  detectedCategory: NormalizedWhatsAppMessageCategory;
  deliveryState: DeliveryTrackingState;
  retryCount: number;
  durationMs: number;
}

/**
 * Reliable Outgoing Message Sender & Delivery Tracker.
 * Enforces capability validation, connection readiness, duplicate-send protection (idempotency keys),
 * retry policies strictly for transient network errors, and honest delivery state tracking:
 * `queued` -> `submitted` -> `acknowledged` -> `delivered` -> `read` (or `failed`).
 */
export class MessageSender {
  private readonly capabilityAdapter = new WhatsAppCapabilityAdapter();
  private readonly deliveryStateByMessageKey = new Map<string, DeliveryTrackingState>();
  private readonly recentIdempotencyKeys = new Map<string, OutgoingMessageSendResult>();

  constructor(private readonly repo?: FunctionLabRepository) {}

  private makeTrackingKey(sessionId: string, messageId: string): string {
    return `${sessionId}:${messageId}`;
  }

  public getDeliveryState(sessionId: string, messageId: string): DeliveryTrackingState {
    return (
      this.deliveryStateByMessageKey.get(this.makeTrackingKey(sessionId, messageId)) ||
      'unknown'
    );
  }

  /**
   * Maps Baileys `WAMessageStatus` numeric codes or receipt updates to honest delivery states:
   * 0 = ERROR (`failed`), 1 = PENDING (`submitted`), 2 = SERVER_ACK (`acknowledged`),
   * 3 = DELIVERY_ACK (`delivered`), 4 = READ (`read`), 5 = PLAYED (`read`).
   */
  public recordAckUpdate(params: {
    sessionId: string;
    messageId: string;
    statusNumber?: number;
    receiptType?: 'read' | 'read-self' | 'played' | 'delivery' | string;
  }): DeliveryTrackingState {
    let state: DeliveryTrackingState = 'unknown';

    if (params.receiptType === 'read' || params.receiptType === 'played') {
      state = 'read';
    } else if (params.receiptType === 'delivery') {
      state = 'delivered';
    } else if (typeof params.statusNumber === 'number') {
      switch (params.statusNumber) {
        case 0:
          state = 'failed';
          break;
        case 1:
          state = 'submitted';
          break;
        case 2:
          state = 'acknowledged';
          break;
        case 3:
          state = 'delivered';
          break;
        case 4:
        case 5:
          state = 'read';
          break;
        default:
          state = 'unknown';
      }
    }

    if (state !== 'unknown') {
      this.deliveryStateByMessageKey.set(
        this.makeTrackingKey(params.sessionId, params.messageId),
        state
      );
      this.repo?.updateMessageDeliveryState({
        sessionId: params.sessionId,
        messageId: params.messageId,
        deliveryState: state,
      });
    }

    return state;
  }

  private isRetryableSendError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (
      msg.includes('validation') ||
      msg.includes('غير صالح') ||
      msg.includes('غير مدعوم') ||
      msg.includes('logged out') ||
      msg.includes('401') ||
      msg.includes('403')
    ) {
      return false;
    }
    return (
      msg.includes('timed out') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('socket') ||
      msg.includes('network') ||
      msg.includes('503') ||
      msg.includes('408')
    );
  }

  private classifySendError(err: unknown): FunctionFailureCategory {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes('ratelimit') || msg.includes('الحد الأقصى')) {
      return 'RATE_LIMIT_ERROR';
    }
    if (msg.includes('timeout') || msg.includes('مهلة')) {
      return 'TIMEOUT_ERROR';
    }
    if (msg.includes('غير مدعوم') || msg.includes('protocol')) {
      return 'PROTOCOL_ERROR';
    }
    if (msg.includes('غير صالح') || msg.includes('validation')) {
      return 'VALIDATION_ERROR';
    }
    if (msg.includes('401') || msg.includes('403') || msg.includes('صلاحية')) {
      return 'PERMISSION_ERROR';
    }
    return 'NETWORK_ERROR';
  }

  public async sendVerifiedMessage(
    request: OutgoingMessageSendRequest,
    transport: {
      isConnected: () => boolean;
      sendMessage: (
        jid: string,
        content: AnyMessageContent,
        options?: Record<string, unknown>
      ) => Promise<{ key?: { id?: string | null } } | undefined>;
    }
  ): Promise<OutgoingMessageSendResult> {
    const correlationId =
      request.correlationId || `corr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    if (request.idempotencyKey) {
      const dedup = this.recentIdempotencyKeys.get(
        `${request.sessionId}:${request.idempotencyKey}`
      );
      if (dedup) {
        return dedup;
      }
    }

    const capCheck = this.capabilityAdapter.assertCapabilityForOutgoing(
      request.content,
      request.targetJid
    );
    if (!capCheck.supported) {
      this.repo?.recordMessageOutcome({
        correlationId,
        sessionId: request.sessionId,
        direction: 'OUTGOING',
        remoteJid: request.targetJid,
        detectedType: capCheck.detectedCategory,
        isStatusBroadcast:
          isJidStatusBroadcast(request.targetJid) || request.targetJid === STORIES_JID,
        deliveryState: 'failed',
        capabilitySupported: false,
        errorCategory: 'PROTOCOL_ERROR',
        errorReason: capCheck.reasonAr || 'Capability not supported',
      });
      throw new UnsupportedOperationError(
        capCheck.reasonAr || 'نوع الرسالة المطلوب إرسالها غير مدعوم.'
      );
    }

    if (!transport.isConnected()) {
      this.repo?.recordMessageOutcome({
        correlationId,
        sessionId: request.sessionId,
        direction: 'OUTGOING',
        remoteJid: request.targetJid,
        detectedType: capCheck.detectedCategory,
        deliveryState: 'failed',
        capabilitySupported: true,
        errorCategory: 'NETWORK_ERROR',
        errorReason: 'Session socket not connected',
      });
      throw new WhatsAppConnectionError(
        `الجلسة (${request.sessionId}) غير متصلة حالياً لإرسال الرسالة.`
      );
    }

    const maxRetries = Math.min(Math.max(request.maxRetries ?? 1, 0), 3);
    const retryDelayMs = Math.min(Math.max(request.retryDelayMs ?? 150, 10), 5000);
    const startTime = Date.now();
    let retryCount = 0;
    let lastError: unknown;

    const sendOptions: Record<string, unknown> = {};
    if (request.quotedMessage) {
      sendOptions.quoted = request.quotedMessage;
    }
    if (typeof request.ephemeralExpiration === 'number') {
      sendOptions.ephemeralExpiration = request.ephemeralExpiration;
    }
    if (Array.isArray(request.statusJidList) && request.statusJidList.length > 0) {
      sendOptions.statusJidList = request.statusJidList;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await transport.sendMessage(
          request.targetJid,
          request.content,
          sendOptions
        );
        const messageId = res?.key?.id;
        if (!messageId || typeof messageId !== 'string') {
          throw new WhatsAppConnectionError(
            'لم يُرجع مقبس واتساب معرف رسالة صالح (Message ID) بعد الإرسال.'
          );
        }

        // Honest state: sendMessage resolved means stanza was submitted to socket/server,
        // NOT necessarily delivered to recipient's handset yet (`submitted`).
        const deliveryState: DeliveryTrackingState = 'submitted';
        this.deliveryStateByMessageKey.set(
          this.makeTrackingKey(request.sessionId, messageId),
          deliveryState
        );

        const durationMs = Date.now() - startTime;
        this.repo?.recordMessageOutcome({
          correlationId,
          sessionId: request.sessionId,
          direction: 'OUTGOING',
          messageId,
          remoteJid: request.targetJid,
          detectedType: capCheck.detectedCategory,
          isEphemeral: Boolean(request.ephemeralExpiration),
          isViewOnce: Boolean((request.content as { viewOnce?: boolean }).viewOnce),
          isStatusBroadcast:
            isJidStatusBroadcast(request.targetJid) || request.targetJid === STORIES_JID,
          deliveryState,
          capabilitySupported: true,
          retryCount,
          durationMs,
        });

        const result: OutgoingMessageSendResult = {
          messageId,
          correlationId,
          sessionId: request.sessionId,
          targetJid: request.targetJid,
          detectedCategory: capCheck.detectedCategory,
          deliveryState,
          retryCount,
          durationMs,
        };

        if (request.idempotencyKey) {
          this.recentIdempotencyKeys.set(
            `${request.sessionId}:${request.idempotencyKey}`,
            result
          );
        }

        return result;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries && this.isRetryableSendError(err)) {
          retryCount++;
          await new Promise((r) => setTimeout(r, retryDelayMs * attempt + retryDelayMs));
          continue;
        }
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    const errorCategory = this.classifySendError(lastError);
    this.repo?.recordMessageOutcome({
      correlationId,
      sessionId: request.sessionId,
      direction: 'OUTGOING',
      remoteJid: request.targetJid,
      detectedType: capCheck.detectedCategory,
      deliveryState: 'failed',
      capabilitySupported: true,
      retryCount,
      durationMs,
      errorCategory,
      errorReason:
        lastError instanceof Error ? lastError.message : String(lastError),
    });

    log.warn('Outgoing message send failed', {
      correlationId,
      sessionId: request.sessionId,
      category: capCheck.detectedCategory,
      retryCount,
      errorCategory,
    });

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new WhatsAppConnectionError('تعذر إرسال الرسالة عبر مقبس واتساب.');
  }
}

export { extractMessageContent };
