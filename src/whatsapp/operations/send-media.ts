import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isJidGroup, jidNormalizedUser, AnyMessageContent } from '../baileys-compat';
import { SessionManager } from '../session-manager';
import {
  validateRecipient,
  ValidatedMediaFile,
  OperationRateLimiter,
} from '../../security/validation';
import { MediaProcessor, MessageSender } from '../message-capabilities';
import { ValidationError } from '../../utils/errors';
import { createLogger } from '../../logging/logger';

const log = createLogger('send-media-op');

export type OutboundMediaDeliveryMode =
  | 'STANDARD'
  | 'VIEW_ONCE'
  | 'PTT_WAVEFORM'
  | 'PTV_NOTE'
  | 'STICKER_WEBP';

export interface SendMediaOperationInput {
  sessionId: string;
  recipient: string;
  mediaFile: ValidatedMediaFile;
  caption?: string;
  deliveryMode?: OutboundMediaDeliveryMode;
}

/**
 * Injects WhatsApp Sticker EXIF metadata chunk into a RIFF/WEBP buffer.
 */
export function injectWhatsAppStickerExif(
  webpBuffer: Buffer,
  packMeta?: { packId?: string; packName?: string; publisher?: string }
): Buffer {
  if (
    webpBuffer.length < 16 ||
    webpBuffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    webpBuffer.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return webpBuffer;
  }

  const jsonPayload = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': packMeta?.packId || 'botezz.protocol.suite',
      'sticker-pack-name': packMeta?.packName || 'Botezz Stickers',
      'sticker-pack-publisher': packMeta?.publisher || 'Botezz WA Suite',
      emojis: ['🔥'],
    }),
    'utf8'
  );

  // TIFF/EXIF header used by WhatsApp for sticker metadata
  const tiffHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  tiffHeader.writeUInt32LE(jsonPayload.length, 14);
  const exifData = Buffer.concat([tiffHeader, jsonPayload]);

  const exifChunkHeader = Buffer.alloc(8);
  exifChunkHeader.write('EXIF', 0, 'ascii');
  exifChunkHeader.writeUInt32LE(exifData.length, 4);
  const padByte = exifData.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);

  const appended = Buffer.concat([webpBuffer, exifChunkHeader, exifData, padByte]);
  appended.writeUInt32LE(appended.length - 8, 4);
  return appended;
}

/**
 * Computes a 64-byte normalized WhatsApp voice-note waveform (values 0..100) from an audio buffer.
 */
export function computeVoiceNoteWaveform64(audioBuffer: Buffer): Uint8Array {
  const waveform = new Uint8Array(64);
  if (audioBuffer.length === 0) {
    waveform.fill(25);
    return waveform;
  }
  const blockSize = Math.max(1, Math.floor(audioBuffer.length / 64));
  for (let i = 0; i < 64; i++) {
    const start = i * blockSize;
    const end = Math.min(audioBuffer.length, start + blockSize);
    let sum = 0;
    let count = 0;
    for (let j = start; j + 1 < end; j += 2) {
      const sample = audioBuffer.readInt16LE(j);
      sum += Math.abs(sample);
      count++;
    }
    if (count === 0) {
      waveform[i] = 20;
    } else {
      const avg = sum / count / 32768;
      waveform[i] = Math.min(100, Math.max(8, Math.round(Math.sqrt(avg) * 100)));
    }
  }
  return waveform;
}

export class SendMediaOperation {
  private readonly messageSender: MessageSender;
  private readonly mediaProcessor: MediaProcessor;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly rateLimiter: OperationRateLimiter,
    messageSender?: MessageSender,
    mediaProcessor?: MediaProcessor
  ) {
    this.messageSender = messageSender ?? new MessageSender();
    this.mediaProcessor = mediaProcessor ?? new MediaProcessor();
  }

  public async executeForSession(input: SendMediaOperationInput): Promise<string> {
    const normalizedRecipient = validateRecipient(input.recipient);
    const targetJid = isJidGroup(normalizedRecipient.jid)
      ? normalizedRecipient.jid
      : jidNormalizedUser(normalizedRecipient.jid);
    this.rateLimiter.checkRateLimit(`send_media:${input.sessionId}`);

    const deliveryMode: OutboundMediaDeliveryMode = input.deliveryMode ?? 'STANDARD';
    let effectiveMimeType = input.mediaFile.mimeType;
    let effectiveFilePath = input.mediaFile.safeFilePath;
    let effectiveKind = input.mediaFile.kind;
    let fileBuffer: Buffer = Buffer.alloc(1);
    let tempConvertedFilePath: string | undefined;

    if (fs.existsSync(input.mediaFile.safeFilePath)) {
      fileBuffer = fs.readFileSync(input.mediaFile.safeFilePath);
      effectiveMimeType = this.mediaProcessor.detectMimeType(
        fileBuffer,
        input.mediaFile.mimeType
      );

      if (deliveryMode === 'STICKER_WEBP') {
        const isAlreadyWebp = effectiveMimeType === 'image/webp';
        if (!isAlreadyWebp) {
          const outWebp = `${input.mediaFile.safeFilePath}.sticker.webp`;
          try {
            execFileSync(
              'ffmpeg',
              [
                '-y',
                '-i',
                input.mediaFile.safeFilePath,
                '-vf',
                'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
                '-vcodec',
                'libwebp',
                '-lossless',
                '0',
                '-q:v',
                '75',
                '-loop',
                '0',
                '-an',
                outWebp,
              ],
              { stdio: 'ignore', timeout: 15_000 }
            );
            if (fs.existsSync(outWebp)) {
              const rawWebp = fs.readFileSync(outWebp);
              const withExif = injectWhatsAppStickerExif(rawWebp);
              fs.writeFileSync(outWebp, withExif);
              fileBuffer = withExif;
              effectiveFilePath = outWebp;
              effectiveMimeType = 'image/webp';
              effectiveKind = 'image';
              tempConvertedFilePath = outWebp;
            }
          } catch (err) {
            log.warn('ffmpeg WebP conversion failed; checking raw WebP header', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          const withExif = injectWhatsAppStickerExif(fileBuffer);
          const outWebp = `${input.mediaFile.safeFilePath}.exif.webp`;
          fs.writeFileSync(outWebp, withExif);
          fileBuffer = withExif;
          effectiveFilePath = outWebp;
          effectiveMimeType = 'image/webp';
          tempConvertedFilePath = outWebp;
        }
      } else if (deliveryMode === 'PTT_WAVEFORM') {
        if (!effectiveMimeType.includes('ogg')) {
          const outOgg = `${input.mediaFile.safeFilePath}.ptt.ogg`;
          try {
            execFileSync(
              'ffmpeg',
              [
                '-y',
                '-i',
                input.mediaFile.safeFilePath,
                '-c:a',
                'libopus',
                '-b:a',
                '32k',
                '-vbr',
                'on',
                '-compression_level',
                '10',
                '-application',
                'voip',
                outOgg,
              ],
              { stdio: 'ignore', timeout: 15_000 }
            );
            if (fs.existsSync(outOgg)) {
              fileBuffer = fs.readFileSync(outOgg);
              effectiveFilePath = outOgg;
              effectiveMimeType = 'audio/ogg; codecs=opus';
              effectiveKind = 'audio';
              tempConvertedFilePath = outOgg;
            }
          } catch {
            effectiveMimeType = 'audio/ogg; codecs=opus';
            effectiveKind = 'audio';
          }
        } else {
          effectiveMimeType = 'audio/ogg; codecs=opus';
          effectiveKind = 'audio';
        }
      } else if (
        input.mediaFile.safeOriginalName.toLowerCase().endsWith('.webp') &&
        input.mediaFile.mimeType === 'image/webp'
      ) {
        const stickerCheck = this.mediaProcessor.validateWebpSticker(fileBuffer);
        if (!stickerCheck.valid && stickerCheck.reasonAr) {
          throw new ValidationError(stickerCheck.reasonAr);
        }
      }
    }

    const driver = this.sessionManager.getDriver(input.sessionId);
    const isSticker =
      deliveryMode === 'STICKER_WEBP' ||
      (effectiveMimeType === 'image/webp' &&
        input.mediaFile.safeOriginalName.toLowerCase().endsWith('.webp'));
    const isPtt = deliveryMode === 'PTT_WAVEFORM';
    const isPtv = deliveryMode === 'PTV_NOTE';
    const isViewOnce = deliveryMode === 'VIEW_ONCE';
    const waveform = isPtt ? computeVoiceNoteWaveform64(fileBuffer) : undefined;

    const capPayload: AnyMessageContent = isSticker
      ? { sticker: fileBuffer }
      : effectiveKind === 'image'
        ? {
            image: fileBuffer,
            caption: input.caption,
            ...(isViewOnce ? { viewOnce: true } : {}),
          }
        : effectiveKind === 'video'
          ? {
              video: fileBuffer,
              caption: input.caption,
              ...(isPtv ? { ptv: true } : {}),
              ...(isViewOnce ? { viewOnce: true } : {}),
            }
          : effectiveKind === 'audio'
            ? {
                audio: fileBuffer,
                mimetype: effectiveMimeType,
                ptt: isPtt,
                ...(waveform ? { waveform } : {}),
                ...(isViewOnce ? { viewOnce: true } : {}),
              }
            : {
                document: fileBuffer,
                mimetype: effectiveMimeType,
                fileName: input.mediaFile.safeOriginalName,
              };

    try {
      const verifiedResult = await this.messageSender.sendVerifiedMessage(
        {
          sessionId: input.sessionId,
          targetJid,
          content: capPayload,
          maxRetries: 2,
          retryDelayMs: 300,
        },
        {
          isConnected: () => driver.getSocketDiagnostics().socketActive,
          sendMessage: async (jid) => {
            const { messageId } = await driver.sendMediaMessage({
              recipientJid: jid,
              filePath: effectiveFilePath,
              kind: effectiveKind,
              mimeType: effectiveMimeType,
              fileName: input.mediaFile.safeOriginalName,
              caption: input.caption?.trim() || undefined,
              ptv: isPtv,
              viewOnce: isViewOnce,
              ptt: isPtt,
              waveform,
              isSticker,
            });
            return { key: { id: messageId } };
          },
        }
      );

      const modeBadge =
        deliveryMode === 'VIEW_ONCE'
          ? ' [عرض لمرة واحدة]'
          : deliveryMode === 'PTT_WAVEFORM'
            ? ' [بصمة صوتية PTT]'
            : deliveryMode === 'PTV_NOTE'
              ? ' [فيديو دائري PTV]'
              : deliveryMode === 'STICKER_WEBP'
                ? ' [ملصق WebP]'
                : '';

      return `تم إرسال الملف (${input.mediaFile.safeOriginalName})${modeBadge} بنجاح إلى ${normalizedRecipient.displayTarget} (معرف: ${verifiedResult.messageId})`;
    } finally {
      if (tempConvertedFilePath) {
        this.cleanupTempFile(tempConvertedFilePath);
      }
    }
  }

  /**
   * Documented cleanup policy: immediately removes temporary uploaded file after task completion.
   */
  public cleanupTempFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log.info('Temporary media file cleaned up', { filePath });
      }
    } catch (err) {
      log.warn('Failed to remove temporary media file', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
