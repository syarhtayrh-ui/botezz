import { isJidGroup, jidNormalizedUser } from 'athanasia-baileys';
import { SessionManager } from '../session-manager';
import {
  validateRecipient,
  validateMessageText,
  OperationRateLimiter,
} from '../../security/validation';

export interface SendTextOperationInput {
  sessionId: string;
  recipient: string;
  text: string;
}

export class SendMessageOperation {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly rateLimiter: OperationRateLimiter
  ) {}

  public async executeForSession(input: SendTextOperationInput): Promise<string> {
    const normalizedRecipient = validateRecipient(input.recipient);
    const targetJid = isJidGroup(normalizedRecipient.jid)
      ? normalizedRecipient.jid
      : jidNormalizedUser(normalizedRecipient.jid);
    const validText = validateMessageText(input.text);

    this.rateLimiter.checkRateLimit(`send_text:${input.sessionId}`);
    this.rateLimiter.checkDuplicateOperation(
      `dup_text:${input.sessionId}:${targetJid}:${validText}`
    );

    const driver = this.sessionManager.getDriver(input.sessionId);
    const { messageId } = await driver.sendTextMessage(targetJid, validText);

    return `تم إرسال الرسالة النصية بنجاح إلى ${normalizedRecipient.displayTarget} (معرف: ${messageId})`;
  }
}
