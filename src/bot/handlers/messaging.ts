import { MessageWorkflow } from '../workflows/message-workflow';
import { BotViewResponse } from '../workflows/pairing-workflow';

export class MessagingHandler {
  constructor(private readonly messageWorkflow: MessageWorkflow) {}

  public startSendText(adminId: number): BotViewResponse {
    return this.messageWorkflow.start(adminId);
  }
}
