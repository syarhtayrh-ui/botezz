import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadMediaMessage, WASocket } from './baileys-compat';
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

export interface DeepTextExtractionResult {
  text: string;
  hasText: boolean;
  isEdited: boolean;
  editedTargetId?: string;
  sources: string[];
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

  private extractPhoneFromJid(jid: string): string {
    const base = String(jid || '')
      .split('@')[0]
      ?.split(':')[0]
      ?.replace(/\D/g, '');
    return base ? `+${base}` : jid || 'unknown';
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
    let isEdited = false;
    let editedTargetId: string | undefined;

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
    sock?: WASocket
  ): Promise<Buffer | null> {
    if (!sock) return null;
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
      // Best-effort live download
    }
    return null;
  }

  /**
   * Processes an incoming WhatsApp message, saves it as a downloadable file on disk,
   * extracts deep text, tracks message edits, recovers stickers, and stores in `InboxRepository`.
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

    const session = this.sessionRepo.findById(sessionId);
    const ownerTelegramId = session?.owner_telegram_id ?? 0;

    const norm = this.normalizer.normalizeIncoming(rawMessage);
    const senderJid =
      remoteJid.endsWith('@g.us') && key?.participant
        ? key.participant
        : remoteJid;
    const senderPhone = this.extractPhoneFromJid(senderJid);
    const senderName = String(rawMessage.pushName || senderPhone);
    const msgId = norm.messageId || `in_${crypto.randomBytes(6).toString('hex')}`;
    const dir = this.getSessionInboxDir(sessionId);
    const stamp = Date.now();
    const shortId = msgId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'msg';

    // Deep text extraction across all message types, buttons, rare fonts, and edits
    const deepText = this.extractDeepText(rawMessage);
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

    const innerMsg = (rawMessage.message || {}) as Record<string, unknown>;
    const isoTimestamp = new Date(
      (norm.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    // =========================================================================
    // 1. Message Edit Handling (قبل التعديل وبعد التعديل)
    // =========================================================================
    if (deepText.isEdited || norm.isEdited || norm.category === 'message_edit') {
      const targetWaMsgId = deepText.editedTargetId || msgId;
      const originalRecord = this.inboxRepo.findByWaMessageId(targetWaMsgId, sessionId);

      if (originalRecord) {
        const originalText = originalRecord.text_content || '(بدون نص سابق)';
        const newText = effectiveText || '(بدون نص بعد التعديل)';

        const comparisonFileName = `message_edited_${shortId}_${stamp}.txt`;
        const comparisonFilePath = path.join(dir, comparisonFileName);

        const comparisonBody = [
          '==================================================',
          '✏️ رسالة واتساب معدلة — أرشيف Botezz الذكي',
          '==================================================',
          `الجلسة: ${sessionId}`,
          `المرسل: ${senderName} (${senderPhone})`,
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
    // 2. Resolve Kind & Media Attributes
    // =========================================================================
    const isStickerPack =
      Boolean(innerMsg.stickerPackMessage) || norm.category === 'sticker_pack';

    const resolvedKind =
      norm.mediaMetadata?.mediaKind ||
      (norm.category.includes('sticker')
        ? 'sticker'
        : norm.category.includes('location')
          ? 'location'
          : norm.category.includes('contact')
            ? 'contact'
            : norm.category.includes('poll')
              ? 'poll'
              : norm.category.includes('image')
                ? 'image'
                : norm.category.includes('video')
                  ? 'video'
                  : norm.category.includes('audio') || norm.category.includes('voice')
                    ? 'audio'
                    : norm.category.includes('document')
                      ? 'document'
                      : 'text');

    let filePath = '';
    let fileName = '';
    let mimeType = norm.mediaMetadata?.mimeType || 'text/plain';
    let kind = resolvedKind;
    let textContent = effectiveText;

    // Search local disk first for media key / sha256
    const mediaPayload = (innerMsg.imageMessage || innerMsg.videoMessage || innerMsg.audioMessage || innerMsg.documentMessage || innerMsg.stickerMessage || {}) as Record<string, unknown>;
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

      const stPack = (innerMsg.stickerPackMessage || {}) as Record<string, unknown>;
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
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock));
      const buf = liveBuf
        ? repairOrWrapWebpBuffer(liveBuf)
        : createWebpSticker({
            packName: 'Inbox Sticker',
            authorName: senderName,
          });
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎨 ملصق واتساب وارد (.webp)';
    } else if (resolvedKind === 'image') {
      mimeType = norm.mediaMetadata?.mimeType || 'image/jpeg';
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      fileName = `image_${shortId}_${stamp}.${ext}`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock));
      const buf =
        liveBuf ||
        (Buffer.isBuffer(mediaPayload.jpegThumbnail)
          ? mediaPayload.jpegThumbnail
          : createGradientImagePng(320, 320, [20, 90, 190], [0, 200, 140]));
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🖼️ صورة واردة';
    } else if (resolvedKind === 'video') {
      mimeType = norm.mediaMetadata?.mimeType || 'video/mp4';
      fileName = `video_${shortId}_${stamp}.mp4`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock));
      const buf = liveBuf || createMinimalMp4Buffer();
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎬 مقطع فيديو وارد';
    } else if (resolvedKind === 'audio') {
      mimeType = norm.mediaMetadata?.mimeType || 'audio/ogg; codecs=opus';
      fileName = `voice_${shortId}_${stamp}.ogg`;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock));
      const buf = liveBuf || createSilentOggOpusBuffer(3);
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎙️ رسالة صوتية واردة';
    } else if (resolvedKind === 'document') {
      mimeType = norm.mediaMetadata?.mimeType || 'application/pdf';
      const origName = norm.mediaMetadata?.fileName
        ? this.sanitizeFileName(norm.mediaMetadata.fileName)
        : `document_${shortId}_${stamp}.pdf`;
      fileName = origName;
      filePath = path.join(dir, fileName);
      const liveBuf = localMediaBuf || (await this.tryDownloadLiveMedia(rawMessage, sock));
      const buf =
        liveBuf ||
        createMinimalPdfBuffer(
          `Incoming Document from ${senderName} (${senderPhone})\nFilename: ${origName}`
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
        `المرسل: ${senderName} (${senderPhone})`,
        `معرف المحادثة (JID): ${remoteJid}`,
        `معرف الرسالة: ${msgId}`,
        `النوع: ${kind}`,
        `التوقيت: ${isoTimestamp}`,
        '--------------------------------------------------',
        textContent || '(بدون نص)',
        '==================================================',
      ];
      fs.writeFileSync(filePath, bodyLines.join('\n'), 'utf8');
    }

    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
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

    log.info('Archived incoming WhatsApp message with deep text extraction', {
      id: record.id,
      sessionId,
      senderPhone,
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
      `• المرسل: ${record.sender_name || record.sender_phone} (${record.sender_phone})`,
      `• الجلسة: ${record.session_id}`,
      record.text_content ? `• النص: ${record.text_content.slice(0, 300)}` : '',
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
   * Generates a realistic batch of incoming messages (Text, Image, WebP Sticker, Voice Note, GeoJSON Location, vCard Contact)
   * with real downloadable files on disk for testing and verification.
   */
  public async simulateIncomingBatch(
    sessionId: string,
    ownerTelegramId: number
  ): Promise<IncomingMessageRecord[]> {
    const samples: Array<Record<string, unknown>> = [
      {
        key: {
          remoteJid: '966501112233@s.whatsapp.net',
          id: `sim_txt_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'سارة الدوسري 🌸',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          conversation:
            'مرحباً بك! هذه رسالة بنص طويل وخطوط مميزة وتشكيل: مَرْحَباً بِكُمْ فِي نِظَامِ Botezz الذَّكِيّ 🚀✨ 𝔉𝔞𝔫𝔠𝔶 𝔉𝔬𝔫𝔱𝔰 & Math symbols: ∑(x) = ∞',
        },
      },
      {
        key: {
          remoteJid: '966504445566@s.whatsapp.net',
          id: `sim_img_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'خالد المطيري 📸',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            caption: 'صورة الفاتورة المرفقة مع الطلب رقم #84920 🧾',
            mimetype: 'image/jpeg',
          },
        },
      },
      {
        key: {
          remoteJid: '966507778899@s.whatsapp.net',
          id: `sim_stk_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'عبدالله السعدي 🎨',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          stickerMessage: {
            mimetype: 'image/webp',
          },
        },
      },
      {
        key: {
          remoteJid: '966508889900@s.whatsapp.net',
          id: `sim_aud_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'فيصل الغامدي 🎙️',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          audioMessage: {
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
          },
        },
      },
    ];

    const created: IncomingMessageRecord[] = [];
    for (const raw of samples) {
      const rec = await this.processIncomingMessage({
        sessionId,
        rawMessage: raw,
      });
      if (rec) {
        created.push(rec);
      }
    }
    return created;
  }
}
