import { isJidGroup, jidNormalizedUser } from 'athanasia-baileys';
import { SessionManager } from '../session-manager';
import {
  validateRecipient,
  validateMessageText,
  OperationRateLimiter,
} from '../../security/validation';
import { MessageSender } from '../message-capabilities';

export interface SendTextOperationInput {
  sessionId: string;
  recipient: string;
  text: string;
}

export class SendMessageOperation {
  private readonly messageSender: MessageSender;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly rateLimiter: OperationRateLimiter,
    messageSender?: MessageSender
  ) {
    this.messageSender = messageSender ?? new MessageSender();
  }

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
    const verifiedResult = await this.messageSender.sendVerifiedMessage(
      {
        sessionId: input.sessionId,
        targetJid,
        content: { text: validText },
        maxRetries: 0,
      },
      {
        isConnected: () => true,
        sendMessage: async (jid) => {
          const { messageId } = await driver.sendTextMessage(jid, validText);
          return { key: { id: messageId } };
        },
      }
    );

    return `تم إرسال الرسالة النصية بنجاح إلى ${normalizedRecipient.displayTarget} (معرف: ${verifiedResult.messageId})`;
  }
}
