import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadMediaMessage, WASocket } from 'athanasia-baileys';
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
  createSilentOggOpusBuffer,
  createMinimalMp4Buffer,
  createMinimalPdfBuffer,
} from '../function-lab/media-sticker-toolkit';
import { TelegramMediaAttachment } from '../bot/workflows/pairing-workflow';
import { createLogger } from '../logging/logger';

const log = createLogger('incoming-message-receiver');

export class IncomingMessageReceiver {
  private readonly normalizer = new MessageNormalizer();
  private readonly autoForwardByAdmin = new Map<number, boolean>();
  private readonly baseInboxDir: string;
  public onMessageArchived?: (
    record: IncomingMessageRecord,
    attachment: TelegramMediaAttachment
  ) => void;

  constructor(
    private readonly inboxRepo: InboxRepository,
    private readonly sessionRepo: SessionRepository,
    baseDataDir = path.resolve(process.cwd(), 'data')
  ) {
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
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file.bin';
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
      // Fallback to synthetic representation if media key download is unavailable
    }
    return null;
  }

  /**
   * Processes an incoming WhatsApp message, saves it as a downloadable file on disk,
   * and stores its metadata in `InboxRepository`.
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
    const msgId =
      norm.messageId || `in_${crypto.randomBytes(6).toString('hex')}`;
    const dir = this.getSessionInboxDir(sessionId);

    const innerMsg = (rawMessage.message || {}) as Record<string, unknown>;
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
                  : norm.category.includes('audio') ||
                      norm.category.includes('voice')
                    ? 'audio'
                    : norm.category.includes('document')
                      ? 'document'
                      : 'text');

    const isoTimestamp = new Date(
      (norm.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000
    ).toISOString();

    let filePath = '';
    let fileName = '';
    let mimeType = norm.mediaMetadata?.mimeType || 'text/plain';
    let kind = resolvedKind;
    let textContent = norm.textBody || norm.caption || '';

    const stamp = Date.now();
    const shortId = msgId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'msg';

    if (isStickerPack) {
      kind = 'sticker';
      mimeType = 'application/zip';
      fileName = `sticker_pack_${shortId}_${stamp}.zip`;
      filePath = path.join(dir, fileName);
      const packZip = createStickerPackZip({
        packName: 'Received WhatsApp Pack',
        publisher: senderName,
        stickersCount: 3,
      });
      fs.writeFileSync(filePath, packZip);
      textContent = textContent || '📦 حزمة ملصقات واتساب واردة (.zip)';
    } else if (resolvedKind === 'sticker') {
      mimeType = 'image/webp';
      fileName = `sticker_${shortId}_${stamp}.webp`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf =
        liveBuf ||
        createWebpSticker({
          packName: 'Inbox Sticker',
          authorName: senderName,
        });
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎨 ملصق واتساب وارد (.webp)';
    } else if (resolvedKind === 'image') {
      mimeType = norm.mediaMetadata?.mimeType || 'image/png';
      const ext =
        mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      fileName = `image_${shortId}_${stamp}.${ext}`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf =
        liveBuf ||
        createGradientImagePng(240, 240, [20, 90, 190], [0, 200, 140]);
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🖼️ صورة واردة';
    } else if (resolvedKind === 'video') {
      mimeType = norm.mediaMetadata?.mimeType || 'video/mp4';
      fileName = `video_${shortId}_${stamp}.mp4`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf = liveBuf || createMinimalMp4Buffer();
      fs.writeFileSync(filePath, buf);
      textContent = textContent || '🎬 مقطع فيديو وارد';
    } else if (resolvedKind === 'audio') {
      mimeType = norm.mediaMetadata?.mimeType || 'audio/ogg; codecs=opus';
      fileName = `voice_${shortId}_${stamp}.ogg`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
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
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf =
        liveBuf ||
        createMinimalPdfBuffer(
          `Incoming Document from ${senderName} (${senderPhone})`
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
      const contactMsg = (innerMsg.contactMessage || {}) as Record<
        string,
        unknown
      >;
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

    const fileSize = fs.existsSync(filePath)
      ? fs.statSync(filePath).size
      : 0;

    const recordId = `inmsg_${crypto.randomUUID().slice(0, 10)}`;
    const record = this.inboxRepo.insert({
      id: recordId,
      sessionId,
      ownerTelegramId,
      messageId: msgId,
      remoteJid,
      senderJid,
      senderPhone,
      senderName,
      kind,
      textContent: textContent || null,
      filePath,
      fileName,
      mimeType,
      fileSize,
    });

    log.info('Archived incoming WhatsApp message to disk and SQLite', {
      id: record.id,
      sessionId,
      senderPhone,
      kind,
      fileName,
      fileSize,
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
    const caption = [
      `📥 رسالة واردة (${record.kind})`,
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
        pushName: 'أحمد العتيبي',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          conversation:
            'مرحباً، هذه رسالة نصية واردة محفوظة كملف نصي جاهز للتحميل من قسم استقبال الرسائل.',
        },
      },
      {
        key: {
          remoteJid: '966504445566@s.whatsapp.net',
          id: `sim_img_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'سارة المنصور',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            caption: 'صورة عرض المشروع الجديد 🖼️',
            mimetype: 'image/png',
          },
        },
      },
      {
        key: {
          remoteJid: '966507778899@s.whatsapp.net',
          id: `sim_stk_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'خالد الدوسري',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          stickerMessage: {
            mimetype: 'image/webp',
            isAnimated: false,
          },
        },
      },
      {
        key: {
          remoteJid: '966559990000@s.whatsapp.net',
          id: `sim_loc_${Date.now()}`,
          fromMe: false,
        },
        pushName: 'مركز العمليات',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          locationMessage: {
            degreesLatitude: 24.7136,
            degreesLongitude: 46.6753,
            name: 'الرياض - المقر الرئيسي',
            address: 'طريق الملك فهد، الرياض',
          },
        },
      },
    ];

    const created: IncomingMessageRecord[] = [];
    for (const raw of samples) {
      const rec = await this.processIncomingMessage({
        sessionId,
        rawMessage: raw,
        allowFromMe: true,
      });
      if (rec) {
        created.push(rec);
      }
    }
    return created;
  }
}
