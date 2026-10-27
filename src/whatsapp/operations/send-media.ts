import fs from 'node:fs';
import { isJidGroup, jidNormalizedUser } from 'athanasia-baileys';
import { SessionManager } from '../session-manager';
import {
  validateRecipient,
  ValidatedMediaFile,
  OperationRateLimiter,
} from '../../security/validation';
import { createLogger } from '../../logging/logger';

const log = createLogger('send-media-op');

export interface SendMediaOperationInput {
  sessionId: string;
  recipient: string;
  mediaFile: ValidatedMediaFile;
  caption?: string;
}

export class SendMediaOperation {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly rateLimiter: OperationRateLimiter
  ) {}

  public async executeForSession(input: SendMediaOperationInput): Promise<string> {
    const normalizedRecipient = validateRecipient(input.recipient);
    const targetJid = isJidGroup(normalizedRecipient.jid)
      ? normalizedRecipient.jid
      : jidNormalizedUser(normalizedRecipient.jid);
    this.rateLimiter.checkRateLimit(`send_media:${input.sessionId}`);

    const driver = this.sessionManager.getDriver(input.sessionId);
    const { messageId } = await driver.sendMediaMessage({
      recipientJid: targetJid,
      filePath: input.mediaFile.safeFilePath,
      kind: input.mediaFile.kind,
      mimeType: input.mediaFile.mimeType,
      fileName: input.mediaFile.safeOriginalName,
      caption: input.caption?.trim() || undefined,
    });

    return `تم إرسال الملف (${input.mediaFile.safeOriginalName}) بنجاح إلى ${normalizedRecipient.displayTarget} (معرف: ${messageId})`;
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
