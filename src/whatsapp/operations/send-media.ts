import fs from 'node:fs';
import { isJidGroup, jidNormalizedUser, AnyMessageContent } from 'athanasia-baileys';
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

export interface SendMediaOperationInput {
  sessionId: string;
  recipient: string;
  mediaFile: ValidatedMediaFile;
  caption?: string;
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

    let effectiveMimeType = input.mediaFile.mimeType;
    if (fs.existsSync(input.mediaFile.safeFilePath)) {
      const fileBuffer = fs.readFileSync(input.mediaFile.safeFilePath);
      effectiveMimeType = this.mediaProcessor.detectMimeType(
        fileBuffer,
        input.mediaFile.mimeType
      );
      if (
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
    const capPayload: AnyMessageContent =
      input.mediaFile.kind === 'image'
        ? { image: Buffer.alloc(1), caption: input.caption }
        : input.mediaFile.kind === 'video'
          ? { video: Buffer.alloc(1), caption: input.caption }
          : input.mediaFile.kind === 'audio'
            ? { audio: Buffer.alloc(1), mimetype: effectiveMimeType }
            : {
                document: Buffer.alloc(1),
                mimetype: effectiveMimeType,
                fileName: input.mediaFile.safeOriginalName,
              };

    const verifiedResult = await this.messageSender.sendVerifiedMessage(
      {
        sessionId: input.sessionId,
        targetJid,
        content: capPayload,
        maxRetries: 1,
      },
      {
        isConnected: () => true,
        sendMessage: async (jid) => {
          const { messageId } = await driver.sendMediaMessage({
            recipientJid: jid,
            filePath: input.mediaFile.safeFilePath,
            kind: input.mediaFile.kind,
            mimeType: effectiveMimeType,
            fileName: input.mediaFile.safeOriginalName,
            caption: input.caption?.trim() || undefined,
          });
          return { key: { id: messageId } };
        },
      }
    );

    return `تم إرسال الملف (${input.mediaFile.safeOriginalName}) بنجاح إلى ${normalizedRecipient.displayTarget} (معرف: ${verifiedResult.messageId})`;
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
