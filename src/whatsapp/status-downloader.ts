import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  downloadMediaMessage,
  downloadContentFromMessage,
  normalizeMessageContent,
  extractMessageContent,
  STORIES_JID,
  WASocket,
} from './baileys-compat';
import {
  StatusRepository,
  CapturedStatusRecord,
} from '../database/repositories/status-repository';
import { SessionRepository } from '../database/repositories/session-repository';
import {
  createGradientImagePng,
  createSilentOggOpusBuffer,
  createMinimalMp4Buffer,
  createZipArchive,
} from '../function-lab/media-sticker-toolkit';
import { TelegramMediaAttachment } from '../bot/workflows/pairing-workflow';
import { createLogger } from '../logging/logger';

const log = createLogger('status-downloader');

export interface DeepStatusExtractionResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  archiveFormat: 'direct' | 'zip' | 'repaired' | 'raw_stream';
  isZipBundle: boolean;
  zipFilePath?: string;
  companionCaptionPath?: string;
  detailsAr: string;
}

export class StatusDownloaderService {
  private readonly autoForwardByAdmin = new Map<number, boolean>();
  private readonly baseStatusDir: string;
  private readonly baseDataDir: string;
  public onStatusCaptured?: (
    record: CapturedStatusRecord,
    attachment: TelegramMediaAttachment
  ) => void;

  constructor(
    private readonly statusRepo: StatusRepository,
    private readonly sessionRepo: SessionRepository,
    baseDataDir = path.resolve(process.cwd(), 'data')
  ) {
    this.baseDataDir = baseDataDir;
    this.baseStatusDir = path.join(baseDataDir, 'downloads', 'statuses');
    fs.mkdirSync(this.baseStatusDir, { recursive: true });
  }

  public isAutoForwardEnabled(adminId: number): boolean {
    return this.autoForwardByAdmin.get(adminId) ?? true;
  }

  public toggleAutoForward(adminId: number): boolean {
    const next = !this.isAutoForwardEnabled(adminId);
    this.autoForwardByAdmin.set(adminId, next);
    return next;
  }

  private getSessionStatusDir(sessionId: string): string {
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(this.baseStatusDir, safeSession);
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

  /**
   * Searches the internal device storage, auth directories, and cache for pre-downloaded or cached media files.
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
      targetNames.add(`${fileSha256Hex.toLowerCase()}.jpg`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.png`);
      targetNames.add(`${fileSha256Hex.toLowerCase()}.mp4`);
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

  /**
   * Resolves the appropriate file extension for all supported image and media types.
   */
  public resolveExtension(mimeType: string, mediaKind: string, buffer?: Buffer): string {
    const m = (mimeType || '').toLowerCase();
    if (buffer && buffer.length >= 8) {
      // Magic byte detection
      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
      if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
      if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
      if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
      if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
      if (buffer.toString('ascii', 0, 4) === 'OggS') return 'ogg';
    }

    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('svg')) return 'svg';
    if (m.includes('heic') || m.includes('heif')) return 'heic';
    if (m.includes('tiff')) return 'tiff';
    if (m.includes('video') || m.includes('mp4')) return 'mp4';
    if (m.includes('quicktime') || m.includes('mov')) return 'mov';
    if (m.includes('3gpp')) return '3gp';
    if (m.includes('ogg') || m.includes('opus')) return 'ogg';
    if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
    return mediaKind === 'video' ? 'mp4' : mediaKind === 'audio' ? 'ogg' : 'png';
  }

  /**
   * Validates and auto-repairs corrupted media headers without destroying raw content.
   */
  public repairCorruptedBuffer(buffer: Buffer, mimeType: string): { repaired: Buffer; isRepaired: boolean } {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { repaired: buffer, isRepaired: false };
    }
    const m = (mimeType || '').toLowerCase();

    // JPEG repair: Ensure SOI marker 0xFF 0xD8 at the beginning
    if (m.includes('jpeg') || m.includes('jpg')) {
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        const soiIdx = buffer.indexOf(Buffer.from([0xff, 0xd8]));
        if (soiIdx > 0) {
          return { repaired: buffer.subarray(soiIdx), isRepaired: true };
        }
        return { repaired: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), buffer]), isRepaired: true };
      }
    }

    // WebP repair: Ensure RIFF and WEBP headers
    if (m.includes('webp')) {
      if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
        return { repaired: buffer, isRepaired: false };
      }
      const riff = Buffer.alloc(12);
      riff.write('RIFF', 0, 'ascii');
      riff.writeUInt32LE(buffer.length + 4, 4);
      riff.write('WEBP', 8, 'ascii');
      return { repaired: Buffer.concat([riff, buffer]), isRepaired: true };
    }

    return { repaired: buffer, isRepaired: false };
  }

  /**
   * Deep extraction engine: retrieves media from WhatsApp socket, searches device storage,
   * extracts embedded payloads, repairs headers, and packages into ZIP if corrupted or multi-part.
   */
  public async retrieveDeepStatusMedia(params: {
    sessionId: string;
    rawMessage: Record<string, unknown>;
    sock?: WASocket;
    mediaKind: 'image' | 'video' | 'audio' | 'text';
    mimeType: string;
    shortId: string;
    caption?: string | null;
    senderPhone: string;
    senderName: string;
    dir: string;
  }): Promise<DeepStatusExtractionResult> {
    const { sessionId, rawMessage, sock, mediaKind, mimeType, shortId, caption, senderPhone, senderName, dir } = params;
    const rawInner = (rawMessage.message || {}) as Record<string, unknown>;
    const innerMsg = (
      normalizeMessageContent(rawMessage.message as never) ||
      extractMessageContent(rawMessage.message as never) ||
      rawInner
    ) as Record<string, unknown>;
    const targetPayload = (innerMsg.imageMessage ||
      innerMsg.videoMessage ||
      innerMsg.audioMessage ||
      rawInner.imageMessage ||
      rawInner.videoMessage ||
      rawInner.audioMessage ||
      {}) as Record<string, unknown>;

    let rawBuffer: Buffer | null = null;
    let retrievalSource = 'none';

    // 1. Try local disk search (device storage / auth directory)
    const fileSha256Hex = targetPayload.fileSha256
      ? Buffer.from(targetPayload.fileSha256 as never).toString('hex')
      : undefined;
    const mediaKeyHex = targetPayload.mediaKey
      ? Buffer.from(targetPayload.mediaKey as never).toString('hex')
      : undefined;
    const directPath = typeof targetPayload.directPath === 'string' ? targetPayload.directPath : undefined;

    const localMatch = this.searchLocalDiskForMedia(sessionId, fileSha256Hex, mediaKeyHex, directPath);
    if (localMatch && localMatch.length > 0) {
      rawBuffer = localMatch;
      retrievalSource = 'local_device_storage';
    }

    // 2A. Stage 1 live Baileys media download from WhatsApp socket
    if (!rawBuffer && sock && mediaKind !== 'text') {
      try {
        const reuploadFn =
          typeof sock.updateMediaMessage === 'function'
            ? sock.updateMediaMessage.bind(sock)
            : undefined;
        const downloaded = await downloadMediaMessage(
          rawMessage as never,
          'buffer',
          {},
          {
            logger: undefined as never,
            ...(reuploadFn ? { reuploadRequest: reuploadFn } : {}),
          }
        );
        if (Buffer.isBuffer(downloaded) && downloaded.length > 0) {
          rawBuffer = downloaded;
          retrievalSource = 'whatsapp_socket_live';
        }
      } catch (err) {
        log.warn('Stage 1 status media download failed, attempting Stage 2 downloadContentFromMessage', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2B. Stage 2 unwrapped downloadContentFromMessage from mmg.whatsapp.net
    if (
      !rawBuffer &&
      mediaKind !== 'text' &&
      targetPayload.mediaKey &&
      (targetPayload.directPath || targetPayload.url)
    ) {
      try {
        const directPathStr =
          typeof targetPayload.directPath === 'string'
            ? targetPayload.directPath
            : '';
        const normalizedPayload = {
          ...targetPayload,
          url:
            targetPayload.url ||
            (directPathStr.startsWith('/')
              ? `https://mmg.whatsapp.net${directPathStr}`
              : undefined),
        };
        const stream = await downloadContentFromMessage(
          normalizedPayload as never,
          mediaKind
        );
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const combined = Buffer.concat(chunks);
        if (combined.length > 0) {
          rawBuffer = combined;
          retrievalSource = 'whatsapp_mmg_cdn_stream';
        }
      } catch {
        // Proceed to thumbnail check
      }
    }

    // 3. Try thumbnail / embedded base64 payload extraction
    if (!rawBuffer) {
      if (Buffer.isBuffer(targetPayload.jpegThumbnail) && targetPayload.jpegThumbnail.length > 0) {
        rawBuffer = targetPayload.jpegThumbnail;
        retrievalSource = 'embedded_jpeg_thumbnail';
      } else if (targetPayload.jpegThumbnail instanceof Uint8Array && targetPayload.jpegThumbnail.byteLength > 0) {
        rawBuffer = Buffer.from(targetPayload.jpegThumbnail);
        retrievalSource = 'embedded_jpeg_thumbnail';
      } else if (typeof targetPayload.jpegThumbnail === 'string') {
        rawBuffer = Buffer.from(targetPayload.jpegThumbnail, 'base64');
        retrievalSource = 'embedded_base64_thumbnail';
      }
    }

    let hadIssue = false;
    let isRepaired = false;

    if (
      !rawBuffer ||
      mimeType.includes('unknown') ||
      mimeType.includes('corrupt') ||
      (Boolean(targetPayload.url) &&
        retrievalSource !== 'whatsapp_socket_live' &&
        retrievalSource !== 'whatsapp_mmg_cdn_stream' &&
        retrievalSource !== 'local_device_storage')
    ) {
      hadIssue = true;
    }

    // 4. Header validation & repair (never generate fake media on a live WhatsApp socket!)
    if (rawBuffer && rawBuffer.length > 0) {
      const repairOutcome = this.repairCorruptedBuffer(rawBuffer, mimeType);
      rawBuffer = repairOutcome.repaired;
      isRepaired = repairOutcome.isRepaired;
    } else if (mediaKind === 'text' && sock) {
      hadIssue = false;
      rawBuffer = Buffer.from(caption || 'حالة واتساب نصية', 'utf8');
      retrievalSource = 'whatsapp_text_story';
    } else if (!sock) {
      hadIssue = true;
      // Offline test harness fallback only when sock is not provided
      if (mediaKind === 'image') {
        rawBuffer = createGradientImagePng(320, 320, [15, 118, 110], [20, 184, 166]);
      } else if (mediaKind === 'video') {
        rawBuffer = createMinimalMp4Buffer();
      } else if (mediaKind === 'audio') {
        rawBuffer = createSilentOggOpusBuffer(4);
      } else {
        rawBuffer = createGradientImagePng(320, 320, [88, 28, 135], [219, 39, 119]);
      }
      retrievalSource = 'offline_test_fixture';
    } else {
      hadIssue = true;
      rawBuffer = Buffer.from(
        caption || `⚠️ تعذر تنزيل وسائط الحالة (${mediaKind}) من خوادم واتساب.`,
        'utf8'
      );
      retrievalSource = 'unavailable_media_metadata';
    }

    const ext =
      retrievalSource === 'whatsapp_text_story' ||
      retrievalSource === 'unavailable_media_metadata'
        ? 'txt'
        : this.resolveExtension(mimeType, mediaKind, rawBuffer);
    const stamp = Date.now();
    const mediaFileName = `status_${mediaKind}_${shortId}_${stamp}.${ext}`;
    const mediaFilePath = path.join(dir, mediaFileName);
    fs.writeFileSync(mediaFilePath, rawBuffer);

    // Save full companion caption/description text file if caption exists
    let companionCaptionPath: string | undefined;
    if (caption && caption.trim()) {
      const captionFileName = `status_desc_${shortId}_${stamp}.txt`;
      companionCaptionPath = path.join(dir, captionFileName);
      const descContent = [
        '==================================================',
        '📝 وصف وتفاصيل حالة واتساب — WhatsApp Status',
        '==================================================',
        `👤 صاحب الحالة: ${senderName} (${senderPhone})`,
        `🆔 معرف الحالة: ${shortId}`,
        `📁 نوع الوسائط: ${mediaKind} (${ext})`,
        `🕒 التاريخ: ${new Date().toISOString()}`,
        '--------------------------------------------------',
        caption,
        '==================================================',
      ].join('\n');
      fs.writeFileSync(companionCaptionPath, descContent, 'utf8');
    }

    // 5. Automatic ZIP packaging if there was an issue, or if image is corrupted/rescued,
    // or if the user requests full deep bundle (media + UTF-8 description + metadata JSON)
    let isZipBundle = false;
    let zipFilePath: string | undefined;
    let finalFileName = mediaFileName;
    let finalFilePath = mediaFilePath;
    let finalMimeType = mimeType;
    let archiveFormat: 'direct' | 'zip' | 'repaired' | 'raw_stream' = hadIssue
      ? 'zip'
      : isRepaired
        ? 'repaired'
        : 'direct';

    if (hadIssue || caption) {
      const metaJson = JSON.stringify(
        {
          statusId: shortId,
          sessionId,
          senderPhone,
          senderName,
          mediaKind,
          mimeType,
          caption: caption || null,
          retrievalSource,
          hadIssue,
          isRepaired,
          capturedAt: new Date().toISOString(),
          protocolMediaMetadata: {
            fileLength: targetPayload.fileLength,
            mimetype: targetPayload.mimetype,
            directPath: targetPayload.directPath,
          },
        },
        null,
        2
      );

      const zipFiles: Array<{ name: string; data: Buffer }> = [
        { name: mediaFileName, data: rawBuffer },
        { name: `status_metadata_${shortId}.json`, data: Buffer.from(metaJson, 'utf8') },
      ];

      if (caption && caption.trim()) {
        zipFiles.push({
          name: `status_caption_${shortId}.txt`,
          data: Buffer.from(caption, 'utf8'),
        });
      }

      const zipBuffer = createZipArchive(zipFiles);
      const zipFileName = `status_bundle_${shortId}_${stamp}.zip`;
      zipFilePath = path.join(dir, zipFileName);
      fs.writeFileSync(zipFilePath, zipBuffer);

      if (hadIssue) {
        isZipBundle = true;
        finalFileName = zipFileName;
        finalFilePath = zipFilePath;
        finalMimeType = 'application/zip';
        archiveFormat = 'zip';
      }
    }

    return {
      buffer: fs.readFileSync(finalFilePath),
      mimeType: finalMimeType,
      fileName: finalFileName,
      archiveFormat,
      isZipBundle,
      zipFilePath,
      companionCaptionPath,
      detailsAr: `المصدر المستخرج منه: ${retrievalSource} (${archiveFormat})`,
    };
  }

  /**
   * Captures a `status@broadcast` message, downloads/creates its media file on disk,
   * preserves all Unicode characters and captions, and stores it in `StatusRepository`.
   */
  public async processStatusMessage(params: {
    sessionId: string;
    rawMessage: Record<string, unknown>;
    sock?: WASocket;
  }): Promise<CapturedStatusRecord | null> {
    const { sessionId, rawMessage, sock } = params;
    const key = rawMessage?.key as
      | {
          remoteJid?: string;
          id?: string;
          fromMe?: boolean;
          participant?: string;
        }
      | undefined;

    if (String(key?.remoteJid || '') !== 'status@broadcast') {
      return null;
    }

    const innerMsg = (rawMessage.message || {}) as Record<string, unknown>;
    if (innerMsg.protocolMessage) {
      return null;
    }

    const session = this.sessionRepo.findById(sessionId);
    const ownerTelegramId = session?.owner_telegram_id ?? 0;

    const senderJid = String(
      key?.participant ||
        (rawMessage as { participant?: string }).participant ||
        '966500000000@s.whatsapp.net'
    );
    const senderPhone = this.extractPhoneFromJid(senderJid);
    const senderName = String(rawMessage.pushName || senderPhone);
    const statusMsgId = String(
      key?.id || `st_${crypto.randomBytes(6).toString('hex')}`
    );

    const dir = this.getSessionStatusDir(sessionId);
    const stamp = Date.now();
    const shortId = statusMsgId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'st';

    // Save raw WAMessage payload on disk for native extraction/reproducibility
    const rawPayloadPath = path.join(dir, `raw_status_${shortId}_${stamp}.json`);
    const rawPayloadJson = JSON.stringify(rawMessage, null, 2);
    try {
      fs.writeFileSync(rawPayloadPath, rawPayloadJson, 'utf8');
    } catch {
      // Best-effort raw dump
    }

    let mediaKind: 'image' | 'video' | 'audio' | 'text' = 'text';
    let caption: string | null = null;
    let mimeType = 'image/png';

    if (innerMsg.imageMessage) {
      mediaKind = 'image';
      const img = innerMsg.imageMessage as Record<string, unknown>;
      caption = typeof img.caption === 'string' ? img.caption : null;
      mimeType = typeof img.mimetype === 'string' ? img.mimetype : 'image/jpeg';
    } else if (innerMsg.videoMessage) {
      mediaKind = 'video';
      const vid = innerMsg.videoMessage as Record<string, unknown>;
      caption = typeof vid.caption === 'string' ? vid.caption : null;
      mimeType = typeof vid.mimetype === 'string' ? vid.mimetype : 'video/mp4';
    } else if (innerMsg.audioMessage) {
      mediaKind = 'audio';
      mimeType = 'audio/ogg; codecs=opus';
      caption = '🎙️ حالة صوتية (Status Audio)';
    } else {
      mediaKind = 'text';
      const extText = innerMsg.extendedTextMessage as Record<string, unknown> | undefined;
      caption =
        (typeof extText?.text === 'string' ? extText.text : undefined) ||
        (typeof innerMsg.conversation === 'string' ? innerMsg.conversation : undefined) ||
        'حالة واتساب نصية';
      mimeType = 'image/png';
    }

    const extraction = await this.retrieveDeepStatusMedia({
      sessionId,
      rawMessage,
      sock,
      mediaKind,
      mimeType,
      shortId,
      caption,
      senderPhone,
      senderName,
      dir,
    });

    const filePath = path.join(dir, extraction.fileName);
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

    const record = this.statusRepo.recordStatus({
      id: `stat_${crypto.randomUUID().slice(0, 10)}`,
      sessionId,
      ownerTelegramId,
      statusMessageId: statusMsgId,
      senderJid,
      senderPhone,
      senderName,
      mediaKind,
      caption,
      filePath,
      fileName: extraction.fileName,
      mimeType: extraction.mimeType,
      fileSize,
      archiveFormat: extraction.archiveFormat,
      rawPayload: rawPayloadJson,
    });

    log.info('Captured and archived WhatsApp status/story with deep extraction', {
      id: record.id,
      sessionId,
      senderPhone,
      mediaKind,
      fileName: extraction.fileName,
      archiveFormat: extraction.archiveFormat,
      fileSize,
    });

    if (
      ownerTelegramId > 0 &&
      this.isAutoForwardEnabled(ownerTelegramId) &&
      this.onStatusCaptured
    ) {
      this.onStatusCaptured(record, this.toTelegramAttachment(record));
    }

    return record;
  }

  public toTelegramAttachment(
    record: CapturedStatusRecord
  ): TelegramMediaAttachment {
    const isZip = record.mime_type === 'application/zip' || (record.file_name && record.file_name.endsWith('.zip'));
    const isVid = record.media_kind === 'video' && !isZip;
    const isAud = record.media_kind === 'audio' && !isZip;

    const caption = [
      `⭕ حالة واتساب (${record.media_kind.toUpperCase()})`,
      `• صاحب الحالة: ${record.sender_name || record.sender_phone} (${record.sender_phone})`,
      `• الجلسة: ${record.session_id}`,
      record.caption ? `• النص/الوصف: ${record.caption.slice(0, 400)}` : '',
      isZip ? '📦 تم تجهيز الحالة كملف مضغوط (.zip) شامل الوسائط والوصف الأصلي والتفاصيل.' : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      filePath: record.file_path || '',
      fileName: record.file_name || `status_${record.id}.${isZip ? 'zip' : 'png'}`,
      mimeType: record.mime_type || 'application/octet-stream',
      kind: isVid ? 'video' : isAud ? 'audio' : 'document',
      caption,
    };
  }

  /**
   * Generates a realistic batch of WhatsApp statuses (Image, Video, Audio, Text)
   * with real downloadable files on disk for testing and verification.
   */
  public async simulateStatusBatch(
    sessionId: string,
    _ownerTelegramId: number
  ): Promise<CapturedStatusRecord[]> {
    const samples: Array<Record<string, unknown>> = [
      {
        key: {
          remoteJid: 'status@broadcast',
          id: `sim_st_img_${Date.now()}`,
          fromMe: false,
          participant: '966501112233@s.whatsapp.net',
        },
        pushName: 'فهد الشمري 🌟',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            caption: 'صباح الخير من الرياض ☀️ تشكيل: السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ',
            mimetype: 'image/jpeg',
          },
        },
      },
      {
        key: {
          remoteJid: 'status@broadcast',
          id: `sim_st_vid_${Date.now()}`,
          fromMe: false,
          participant: '966504445566@s.whatsapp.net',
        },
        pushName: 'نورة القحطاني 🎬',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          videoMessage: {
            caption: 'تغطية مؤتمر التقنية الدولي بالرياض 🚀',
            mimetype: 'video/mp4',
          },
        },
      },
      {
        key: {
          remoteJid: 'status@broadcast',
          id: `sim_st_txt_${Date.now()}`,
          fromMe: false,
          participant: '966501112233@s.whatsapp.net',
        },
        pushName: 'فهد الشمري 🌟',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          extendedTextMessage: {
            text: 'اللهم بك أصبحنا وبك أمسينا وبك نحيا وبك نموت وإليك النشور ✨',
          },
        },
      },
    ];

    const created: CapturedStatusRecord[] = [];
    for (const raw of samples) {
      const rec = await this.processStatusMessage({
        sessionId,
        rawMessage: raw,
      });
      if (rec) {
        created.push(rec);
      }
    }
    return created;
  }

  /**
   * Publishes a new outbound WhatsApp Story / Status (`status@broadcast`) with automatic
   * `statusJidList` resolution, custom background ARGB theme, and font style (`0..5`).
   */
  public async publishStatusBroadcast(params: {
    sessionId: string;
    sock?: WASocket;
    driver?: {
      sendTextMessage?: (jid: string, text: string) => Promise<{ messageId?: string }>;
      sendMediaMessage?: (
        jid: string,
        filePath: string,
        mimeType: string,
        caption?: string
      ) => Promise<{ messageId?: string }>;
      getRawSocket?: () => Record<string, unknown> | null;
      getKnownRecipientJids?: () => string[];
    };
    kind: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO';
    textOrCaption?: string;
    backgroundHex?: string;
    font?: number;
    mediaBuffer?: Buffer;
    mediaFilePath?: string;
    mimeType?: string;
    statusJidList?: string[];
  }): Promise<{
    statusMessageId: string;
    recipientsCount: number;
    backgroundHex: string;
    font: number;
  }> {
    const rawSock =
      params.sock ||
      (params.driver?.getRawSocket?.() as unknown as WASocket | undefined);

    const statusJids = new Set<string>();
    if (Array.isArray(params.statusJidList)) {
      for (const j of params.statusJidList) {
        if (j && j.endsWith('@s.whatsapp.net')) {
          statusJids.add(j.replace(/:\d+@/, '@'));
        }
      }
    }

    // Gather known JIDs from captured statuses in SQLite
    try {
      const recentStatuses = this.statusRepo.listForOwner(0, true, undefined, 200);
      for (const st of recentStatuses) {
        if (st.sender_jid && st.sender_jid.endsWith('@s.whatsapp.net')) {
          statusJids.add(st.sender_jid.replace(/:\d+@/, '@'));
        }
      }
    } catch {
      // Ignore repo lookup failure
    }

    // Gather known JIDs from driver / socket
    try {
      const driverKnown = params.driver?.getKnownRecipientJids?.() || [];
      for (const j of driverKnown) {
        if (j && j.endsWith('@s.whatsapp.net')) {
          statusJids.add(j.replace(/:\d+@/, '@'));
        }
      }
      const selfId =
        (rawSock as unknown as { user?: { id?: string } })?.user?.id ||
        (
          rawSock as unknown as {
            authState?: { creds?: { me?: { id?: string } } };
          }
        )?.authState?.creds?.me?.id;
      if (typeof selfId === 'string' && selfId.includes('@s.whatsapp.net')) {
        statusJids.add(selfId.replace(/:\d+@/, '@'));
      }
    } catch {
      // Ignore socket lookup error
    }

    const statusJidList = Array.from(statusJids);
    const backgroundHex = params.backgroundHex || '#075E54';
    const font =
      typeof params.font === 'number' && params.font >= 0 && params.font <= 5
        ? params.font
        : 1;

    const sendOptions: Record<string, unknown> = {
      backgroundColor: backgroundHex,
      font,
      ...(statusJidList.length > 0 ? { statusJidList } : {}),
    };

    let statusMessageId = `status_${crypto.randomBytes(6).toString('hex')}`;
    const targetBroadcastJid = STORIES_JID || 'status@broadcast';

    if (
      rawSock &&
      typeof (
        rawSock as unknown as {
          sendMessage?: (
            jid: string,
            content: Record<string, unknown>,
            opts?: Record<string, unknown>
          ) => Promise<{ key?: { id?: string } }>;
        }
      ).sendMessage === 'function'
    ) {
      const sendFn = (
        rawSock as unknown as {
          sendMessage: (
            jid: string,
            content: Record<string, unknown>,
            opts?: Record<string, unknown>
          ) => Promise<{ key?: { id?: string } }>;
        }
      ).sendMessage.bind(rawSock);

      let content: Record<string, unknown>;
      if (params.kind === 'TEXT') {
        content = { text: params.textOrCaption || 'حالة واتساب جديدة ✨' };
      } else {
        const buf =
          params.mediaBuffer ||
          (params.mediaFilePath && fs.existsSync(params.mediaFilePath)
            ? fs.readFileSync(params.mediaFilePath)
            : Buffer.alloc(0));
        if (params.kind === 'IMAGE') {
          content = {
            image: buf,
            caption: params.textOrCaption || undefined,
            mimetype: params.mimeType || 'image/jpeg',
          };
        } else if (params.kind === 'VIDEO') {
          content = {
            video: buf,
            caption: params.textOrCaption || undefined,
            mimetype: params.mimeType || 'video/mp4',
          };
        } else {
          content = {
            audio: buf,
            ptt: true,
            mimetype: params.mimeType || 'audio/ogg; codecs=opus',
          };
        }
      }

      const sent = await sendFn(targetBroadcastJid, content, sendOptions);
      if (sent?.key?.id) {
        statusMessageId = sent.key.id;
      }
    } else if (params.driver) {
      if (params.kind === 'TEXT' && typeof params.driver.sendTextMessage === 'function') {
        const res = await params.driver.sendTextMessage(
          targetBroadcastJid,
          params.textOrCaption || 'حالة واتساب جديدة ✨'
        );
        if (res?.messageId) statusMessageId = res.messageId;
      } else if (
        params.mediaFilePath &&
        typeof params.driver.sendMediaMessage === 'function'
      ) {
        const res = await params.driver.sendMediaMessage(
          targetBroadcastJid,
          params.mediaFilePath,
          params.mimeType || 'application/octet-stream',
          params.textOrCaption
        );
        if (res?.messageId) statusMessageId = res.messageId;
      }
    }

    return {
      statusMessageId,
      recipientsCount: statusJidList.length,
      backgroundHex,
      font,
    };
  }
}

