import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';
import { SendMessageOperation } from '../../whatsapp/operations/send-message';
import { validateRecipient, validateMessageText } from '../../security/validation';
import { buildMultiSessionSelectorKeyboard } from '../keyboards/session-menu';
import { buildBackCancelRow } from '../keyboards/main-menu';
import { formatTaskStatusArabic } from '../keyboards/task-menu';
import { BotViewResponse } from './pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';

export type MessageWorkflowStep =
  | 'AWAITING_RECIPIENT'
  | 'AWAITING_TEXT'
  | 'SELECTING_SESSIONS'
  | 'AWAITING_CONFIRMATION';

export interface MessageWorkflowState {
  step: MessageWorkflowStep;
  recipientJid?: string;
  recipientJids?: string[];
  recipientDisplay?: string;
  messageText?: string;
  selectedSessionIds: string[];
}

const MAX_RECIPIENTS_PER_BATCH = 25;

function splitRawRecipients(rawInput: string): string[] {
  const trimmed = rawInput.trim();
  if (!trimmed) return [];

  // Primary split by comma, Arabic comma, semicolon, or newline
  const byDelimiters = trimmed
    .split(/[,،;\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (byDelimiters.length > 1) {
    return byDelimiters;
  }

  // Secondary check: if a single line has multiple whitespace-separated tokens where each token is a distinct phone/JID
  const wsTokens = trimmed.split(/\s+/).filter(Boolean);
  if (
    wsTokens.length > 1 &&
    wsTokens.every((tok) => tok.includes('@') || tok.replace(/\D/g, '').length >= 8)
  ) {
    return wsTokens;
  }

  return [trimmed];
}

export class MessageWorkflow {
  private readonly states = new Map<number, MessageWorkflowState>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager,
    private readonly sendMessageOp: SendMessageOperation
  ) {}

  public getState(adminId: number): MessageWorkflowState | undefined {
    return this.states.get(adminId);
  }

  public cancel(adminId: number): void {
    this.states.delete(adminId);
  }

  public start(adminId: number): BotViewResponse {
    this.states.set(adminId, {
      step: 'AWAITING_RECIPIENT',
      selectedSessionIds: [],
    });

    return {
      text:
        `✉️ *إرسال رسالة نصية عبر جلسة أو عدة جلسات*\n\n` +
        `الخطوة 1 من 4: الرجاء إرسال رقم هاتف المستلم مع رمز الدولة (مثال: \`+966559876543\`) أو معرف المجموعة (\`...g.us\`).\n` +
        `💡 _يمكنك أيضاً إدخال عدة أرقام أو مجموعات (حتى ${MAX_RECIPIENTS_PER_BATCH} مستلماً) مفصولة بفاصلة أو سطر جديد:_`,
      keyboard: [buildBackCancelRow('menu:main')],
    };
  }

  public handleTextInput(adminId: number, text: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }

    if (state.step === 'AWAITING_RECIPIENT') {
      try {
        const rawSegments = splitRawRecipients(text);
        if (rawSegments.length === 0) {
          const single = validateRecipient(text);
          rawSegments.push(single.displayTarget);
        }
        if (rawSegments.length > MAX_RECIPIENTS_PER_BATCH) {
          return {
            text: `⚠️ الحد الأقصى لعدد المستلمين في الدفعة الواحدة هو *${MAX_RECIPIENTS_PER_BATCH}* مستلماً (تم إدخال ${rawSegments.length}).\nالرجاء تقليل القائمة والمحاولة مجدداً:`,
            keyboard: [buildBackCancelRow('menu:main')],
          };
        }

        const uniqueMap = new Map<string, string>();
        for (const seg of rawSegments) {
          const normalized = validateRecipient(seg);
          if (!uniqueMap.has(normalized.jid)) {
            uniqueMap.set(normalized.jid, normalized.displayTarget);
          }
        }

        const jids = Array.from(uniqueMap.keys());
        const displays = Array.from(uniqueMap.values());

        state.recipientJids = jids;
        state.recipientJid = jids[0];
        state.recipientDisplay =
          displays.length === 1
            ? displays[0]
            : `${displays.slice(0, 3).join(', ')}${displays.length > 3 ? ` (+${displays.length - 3} آخرين)` : ''} [الإجمالي: ${displays.length}]`;
        state.step = 'AWAITING_TEXT';

        return {
          text:
            `✅ *تم تحديد المستلم (${jids.length}):* \`${state.recipientDisplay}\`\n\n` +
            `الخطوة 2 من 4: الرجاء إرسال نص الرسالة المراد إرسالها:`,
          keyboard: [buildBackCancelRow('menu:main')],
        };
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text: `⚠️ ${safeErr.userMessage}\nالرجاء إرسال رقم هاتف دولي صحيح (أو قائمة أرقام مفصولة بفاصلة أو سطر جديد):`,
          keyboard: [buildBackCancelRow('menu:main')],
        };
      }
    }

    if (state.step === 'AWAITING_TEXT') {
      try {
        const validText = validateMessageText(text);
        state.messageText = validText;
        state.step = 'SELECTING_SESSIONS';

        const connectedIds = this.sessionManager
          .listConnectedSessions(adminId)
          .map((s) => s.id);
        state.selectedSessionIds = connectedIds;

        return this.renderSessionSelection(adminId);
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text: `⚠️ ${safeErr.userMessage}`,
          keyboard: [buildBackCancelRow('menu:main')],
        };
      }
    }

    return this.renderSessionSelection(adminId);
  }

  public toggleSession(adminId: number, sessionId: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) return this.start(adminId);

    if (!this.sessionManager.getSession(sessionId, adminId)) {
      return this.renderSessionSelection(adminId);
    }

    const idx = state.selectedSessionIds.indexOf(sessionId);
    if (idx === -1) {
      state.selectedSessionIds.push(sessionId);
    } else {
      state.selectedSessionIds.splice(idx, 1);
    }
    return this.renderSessionSelection(adminId);
  }

  public selectAllConnected(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) return this.start(adminId);

    state.selectedSessionIds = this.sessionManager
      .listConnectedSessions(adminId)
      .map((s) => s.id);
    return this.renderSessionSelection(adminId);
  }

  public clearAll(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) return this.start(adminId);

    state.selectedSessionIds = [];
    return this.renderSessionSelection(adminId);
  }

  public renderSessionSelection(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) return this.start(adminId);

    const sessions = this.sessionManager.listSessions(adminId);
    if (sessions.length === 0) {
      return {
        text: '⚠️ لا توجد جلسات واتساب مسجلة في حسابك حالياً. يرجى ربط حساب واتساب أولاً.',
        keyboard: [
          [{ text: '📲 ربط حساب واتساب الآن', callbackData: 'menu:link_account' }],
          [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
        ],
      };
    }

    return {
      text:
        `✉️ *اختيار الجلسات للإرسال المتزامن*\n` +
        `المستلم: \`${state.recipientDisplay}\`\n\n` +
        `الخطوة 3 من 4: اختر جلسة واحدة أو عدة جلسات لتنفيذ العملية بالتوازي:`,
      keyboard: buildMultiSessionSelectorKeyboard({
        sessions,
        selectedIds: state.selectedSessionIds,
        workflowPrefix: 'wf_msg',
      }),
    };
  }

  public proceedToConfirmation(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid || !state.messageText) {
      return this.start(adminId);
    }

    if (state.selectedSessionIds.length === 0) {
      return {
        text: '⚠️ الرجاء اختيار جلسة واحدة على الأقل قبل المتابعة للتأكيد.',
        keyboard: buildMultiSessionSelectorKeyboard({
          sessions: this.sessionManager.listSessions(adminId),
          selectedIds: state.selectedSessionIds,
          workflowPrefix: 'wf_msg',
        }),
      };
    }

    state.step = 'AWAITING_CONFIRMATION';
    const preview =
      state.messageText.length > 180
        ? `${state.messageText.slice(0, 180)}...`
        : state.messageText;
    const recipientCount = state.recipientJids?.length ?? 1;

    return {
      text:
        `📋 *ملخص تأكيد إرسال الرسالة النصية*\n\n` +
        `👤 *المستلم (${recipientCount}):* \`${state.recipientDisplay}\`\n` +
        `📝 *معاينة الرسالة:*\n${preview}\n\n` +
        `🔢 *عدد الجلسات المحددة:* ${state.selectedSessionIds.length}\n` +
        `🆔 *معرفات الجلسات:* \`${state.selectedSessionIds.join(', ')}\`\n\n` +
        `هل تؤكد بدء التنفيذ المتزامن للمهمة؟`,
      keyboard: [
        [
          { text: '✅ تأكيد الإرسال الآن', callbackData: 'wf_msg:confirm_execute' },
          { text: '❌ إلغاء العملية', callbackData: 'workflow:cancel' },
        ],
        [{ text: '🔙 تعديل الجلسات المحددة', callbackData: 'wf_msg:back_sessions' }],
      ],
    };
  }

  public async confirmAndExecute(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid || !state.messageText) {
      return this.start(adminId);
    }

    const recipientJids =
      state.recipientJids && state.recipientJids.length > 0
        ? [...state.recipientJids]
        : [state.recipientJid];
    const recipientDisplay = state.recipientDisplay || state.recipientJid;
    const messageText = state.messageText;
    const selectedSessionIds = [...state.selectedSessionIds];
    this.states.delete(adminId);

    try {
      const task = await this.taskManager.runMultiSessionTask({
        operationType: 'SEND_TEXT',
        targetSummary: `إلى ${recipientDisplay}`,
        selectedSessionIds,
        actorTelegramId: adminId,
        executor: async (sessionId) => {
          if (recipientJids.length === 1) {
            return this.sendMessageOp.executeForSession({
              sessionId,
              recipient: recipientJids[0],
              text: messageText,
            });
          }

          const results: string[] = [];
          for (let i = 0; i < recipientJids.length; i += 1) {
            if (i > 0) {
              const interDelayMs = process.env.WA_DRIVER_MODE === 'mock' ? 10 : 350;
              await new Promise((r) => setTimeout(r, interDelayMs));
            }
            const summary = await this.sendMessageOp.executeForSession({
              sessionId,
              recipient: recipientJids[i],
              text: messageText,
            });
            results.push(summary);
          }
          return `تم إرسال الرسالة النصية بنجاح إلى ${recipientJids.length} مستلم (${results[0]})`;
        },
      });

      const perSessionLines = task.results.map((r) => {
        const icon = r.status === 'SUCCESS' ? '✅' : r.status === 'CANCELLED' ? '🚫' : '❌';
        const detail = r.result_summary || r.error_message || r.status;
        return `${icon} \`${r.session_id}\`: ${detail}`;
      });

      return {
        text:
          `📊 *تقرير تنفيذ مهمة إرسال الرسالة*\n` +
          `🆔 معرف المهمة: \`${task.id}\`\n` +
          `📌 الحالة النهائية: ${formatTaskStatusArabic(task.status)}\n\n` +
          `*نتائج الجلسات:*\n${perSessionLines.join('\n')}`,
        keyboard: [
          [
            { text: '📊 تفاصيل المهمة', callbackData: `task:view:${task.id}` },
            { text: '✉️ إرسال رسالة أخرى', callbackData: 'menu:send_text' },
          ],
          [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *تعذر تنفيذ المهمة:*\n${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    }
  }
}
