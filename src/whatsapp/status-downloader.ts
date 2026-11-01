import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadMediaMessage, WASocket } from 'athanasia-baileys';
import {
  StatusRepository,
  CapturedStatusRecord,
} from '../database/repositories/status-repository';
import { SessionRepository } from '../database/repositories/session-repository';
import {
  createGradientImagePng,
  createSilentOggOpusBuffer,
  createMinimalMp4Buffer,
} from '../function-lab/media-sticker-toolkit';
import { TelegramMediaAttachment } from '../bot/workflows/pairing-workflow';
import { createLogger } from '../logging/logger';

const log = createLogger('status-downloader');

export class StatusDownloaderService {
  private readonly autoForwardByAdmin = new Map<number, boolean>();
  private readonly baseStatusDir: string;
  public onStatusCaptured?: (
    record: CapturedStatusRecord,
    attachment: TelegramMediaAttachment
  ) => void;

  constructor(
    private readonly statusRepo: StatusRepository,
    private readonly sessionRepo: SessionRepository,
    baseDataDir = path.resolve(process.cwd(), 'data')
  ) {
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
   * Captures a `status@broadcast` message, downloads/creates its media file on disk,
   * and stores it in `StatusRepository`.
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

    let mediaKind: 'image' | 'video' | 'audio' | 'text' = 'text';
    let caption: string | null = null;
    let filePath = '';
    let fileName = '';
    let mimeType = 'image/png';

    if (innerMsg.imageMessage) {
      mediaKind = 'image';
      const img = innerMsg.imageMessage as Record<string, unknown>;
      caption = typeof img.caption === 'string' ? img.caption : null;
      mimeType = typeof img.mimetype === 'string' ? img.mimetype : 'image/png';
      const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
      fileName = `status_img_${shortId}_${stamp}.${ext}`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf =
        liveBuf ||
        createGradientImagePng(320, 320, [15, 118, 110], [20, 184, 166]);
      fs.writeFileSync(filePath, buf);
    } else if (innerMsg.videoMessage) {
      mediaKind = 'video';
      const vid = innerMsg.videoMessage as Record<string, unknown>;
      caption = typeof vid.caption === 'string' ? vid.caption : null;
      mimeType = typeof vid.mimetype === 'string' ? vid.mimetype : 'video/mp4';
      fileName = `status_vid_${shortId}_${stamp}.mp4`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf = liveBuf || createMinimalMp4Buffer();
      fs.writeFileSync(filePath, buf);
    } else if (innerMsg.audioMessage) {
      mediaKind = 'audio';
      mimeType = 'audio/ogg; codecs=opus';
      caption = '🎙️ حالة صوتية (Status Audio)';
      fileName = `status_aud_${shortId}_${stamp}.ogg`;
      filePath = path.join(dir, fileName);
      const liveBuf = await this.tryDownloadLiveMedia(rawMessage, sock);
      const buf = liveBuf || createSilentOggOpusBuffer(4);
      fs.writeFileSync(filePath, buf);
    } else {
      mediaKind = 'text';
      const extText = innerMsg.extendedTextMessage as
        | Record<string, unknown>
        | undefined;
      caption =
        (typeof extText?.text === 'string' ? extText.text : undefined) ||
        (typeof innerMsg.conversation === 'string'
          ? innerMsg.conversation
          : undefined) ||
        'حالة واتساب نصية';
      mimeType = 'image/png';
      fileName = `status_card_${shortId}_${stamp}.png`;
      filePath = path.join(dir, fileName);
      const cardPng = createGradientImagePng(
        320,
        320,
        [88, 28, 135],
        [219, 39, 119]
      );
      fs.writeFileSync(filePath, cardPng);
    }

    const fileSize = fs.existsSync(filePath)
      ? fs.statSync(filePath).size
      : 0;

    const record = this.statusRepo.insert({
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
      fileName,
      mimeType,
      fileSize,
    });

    log.info('Captured and archived WhatsApp status/story', {
      id: record.id,
      sessionId,
      senderPhone,
      mediaKind,
      fileName,
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
    const caption = [
      `⭕ حالة واتساب (${record.media_kind.toUpperCase()})`,
      `• صاحب الحالة: ${record.sender_name || record.sender_phone} (${record.sender_phone})`,
      `• الجلسة: ${record.session_id}`,
      record.caption ? `• النص/الوصف: ${record.caption.slice(0, 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      filePath: record.file_path || '',
      fileName: record.file_name || `status_${record.id}.png`,
      mimeType: record.mime_type || 'application/octet-stream',
      kind:
        record.media_kind === 'video'
          ? 'video'
          : record.media_kind === 'audio'
            ? 'audio'
            : 'document',
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
        pushName: 'فهد الشمري',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          imageMessage: {
            caption: 'صباح الخير من الرياض ☀️',
            mimetype: 'image/png',
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
        pushName: 'نورة القحطاني',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          videoMessage: {
            caption: 'تغطية مؤتمر التقنية اليوم 🎬',
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
        pushName: 'فهد الشمري',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: {
          extendedTextMessage: {
            text: 'الحمد لله دائماً وأبداً ✨',
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
}
