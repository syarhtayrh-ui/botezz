import { SessionManager } from '../../whatsapp/session-manager';
import {
  InlineKeyboardRows,
  buildBackCancelRow,
  buildAppNavigationRow,
} from '../keyboards/main-menu';
import { formatSessionStatusArabic } from '../keyboards/session-menu';
import { toSafeArabicError } from '../../utils/errors';
import { escapeMarkdown } from '../../utils/markdown';
import { UiDeliveryMode, UiSessionStats } from '../ui-state';

export interface BotViewResponse {
  text: string;
  keyboard: InlineKeyboardRows;
  /** Optional short feedback toast for answerCallbackQuery */
  toastText?: string;
  /** Optional modal alert flag for answerCallbackQuery */
  showAlert?: boolean;
  /** Route identifier for navigation history */
  route?: string;
  /** Stateful single-message UI delivery metadata */
  uiMeta?: {
    deliveryMode: UiDeliveryMode;
    activeMessageId: number;
    currentRoute: string;
    canGoBack: boolean;
    pendingWorkflow: string;
    stats: UiSessionStats;
  };
}

export type PairingStep =
  | 'AWAITING_LABEL'
  | 'AWAITING_PHONE'
  | 'AWAITING_RENAME_LABEL'
  | 'CODE_ISSUED';

export interface PairingWorkflowState {
  step: PairingStep;
  sessionId?: string;
  label?: string;
  maskedPhone?: string;
}

export class PairingWorkflow {
  private readonly states = new Map<number, PairingWorkflowState>();

  constructor(private readonly sessionManager: SessionManager) {}

  public getState(adminId: number): PairingWorkflowState | undefined {
    return this.states.get(adminId);
  }

  public cancel(adminId: number): void {
    this.states.delete(adminId);
  }

  public startNewLinking(adminId: number, existingSessionId?: string): BotViewResponse {
    if (existingSessionId) {
      const sess = this.sessionManager.getSession(existingSessionId);
      if (sess) {
        this.states.set(adminId, {
          step: 'AWAITING_PHONE',
          sessionId: sess.id,
          label: sess.label,
        });
        return {
          text:
            `📲 *إعادة ربط الجلسة:* ${sess.label}\n\n` +
            `الرجاء إرسال رقم هاتف واتساب مع رمز الدولة الدولي (مثال: \`+966501234567\`)\n` +
            `أو إرسال الرقم متبوعاً برمز ربط مخصص من 8 أحرف/أرقام تدعمه مكتبة Athanasia Baileys (مثال: \`+966501234567 MYCODE12\`):`,
          keyboard: [
            [
              {
                text: '✏️ تعديل اسم الجلسة أولاً',
                callbackData: `pair:prompt_label:${sess.id}`,
              },
            ],
            buildBackCancelRow('menu:sessions:page:1'),
          ],
          toastText: '📲 أدخل رقم الهاتف الدولي لإعادة ربط الجلسة',
          route: `sess:repair:${sess.id}`,
        };
      }
    }

    const session = this.sessionManager.createSession(undefined, adminId);
    this.states.set(adminId, {
      step: 'AWAITING_PHONE',
      sessionId: session.id,
      label: session.label,
    });

    return {
      text:
        `📲 *ربط حساب واتساب جديد (Athanasia Baileys)*\n` +
        `معرف الجلسة المعزولة: \`${session.id}\` | الاسم: \`${session.label}\`\n\n` +
        `الرجاء إرسال رقم الهاتف مع رمز الدولة الدولي (مثال: \`+966501234567\`)\n` +
        `💡 _اختياري:_ يمكنك إرفاق رمز ربط مخصص من 8 أحرف/أرقام بعد المسافة (مثال: \`+966501234567 MYCODE12\`).\n` +
        `_ملاحظة أمنية: لن يطلب منك البوت أبداً كلمة مرور أو رمز تحقق SMS._`,
      keyboard: [
        [
          {
            text: '✏️ تخصيص اسم الجلسة قبل الربط',
            callbackData: `pair:prompt_label:${session.id}`,
          },
        ],
        buildBackCancelRow('menu:sessions:page:1'),
      ],
      toastText: '📲 جاهز لاستقبال رقم الهاتف الدولي للربط',
      route: 'menu:link_account',
    };
  }

  public promptSessionLabel(
    adminId: number,
    sessionId: string,
    isRenameOnly = false
  ): BotViewResponse {
    const sess = this.sessionManager.getSession(sessionId);
    if (!sess) {
      return this.startNewLinking(adminId);
    }

    this.states.set(adminId, {
      step: isRenameOnly ? 'AWAITING_RENAME_LABEL' : 'AWAITING_LABEL',
      sessionId: sess.id,
      label: sess.label,
    });

    return {
      text:
        `✏️ *تحديد اسم الجلسة (Session Name)*\n` +
        `الجلسة: \`${sess.id}\` (الاسم الحالي: *${sess.label}*)\n\n` +
        `الرجاء إرسال الاسم التوضيحي الجديد للجلسة (بين حرفين و 50 حرفاً، مثال: \`حساب المبيعات الرئيسي\`):`,
      keyboard: [
        buildBackCancelRow(
          isRenameOnly ? `sess:view:${sess.id}` : 'menu:sessions:page:1'
        ),
      ],
      toastText: '✏️ أرسل الاسم الجديد للجلسة',
    };
  }

  public async handlePhoneInput(
    adminId: number,
    rawInputText: string
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.sessionId) {
      return this.startNewLinking(adminId);
    }

    if (state.step === 'AWAITING_RENAME_LABEL') {
      try {
        const updated = this.sessionManager.renameSession(
          state.sessionId,
          rawInputText,
          adminId
        );
        this.states.delete(adminId);
        return {
          text:
            `✅ *تم تحديث اسم الجلسة بنجاح!*\n\n` +
            `🆔 المعرف: \`${updated.id}\`\n` +
            `🏷️ الاسم الجديد: *${updated.label}*\n` +
            `📡 الحالة: ${formatSessionStatusArabic(updated.status)}`,
          keyboard: [
            [{ text: '📱 عرض تفاصيل الجلسة', callbackData: `sess:view:${updated.id}` }],
            buildAppNavigationRow({
              backCallback: 'menu:sessions:page:1',
              refreshCallback: `sess:view:${updated.id}`,
            }),
          ],
        };
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text:
            `⚠️ *تعذر تغيير اسم الجلسة:*\n${safeErr.userMessage}\n\n` +
            `الرجاء إرسال اسم صالح (بين حرفين و 50 حرفاً) أو إلغاء العملية:`,
          keyboard: [buildBackCancelRow(`sess:view:${state.sessionId}`)],
        };
      }
    }

    if (state.step === 'AWAITING_LABEL') {
      try {
        const updated = this.sessionManager.renameSession(
          state.sessionId,
          rawInputText,
          adminId
        );
        state.label = updated.label;
        state.step = 'AWAITING_PHONE';
        return {
          text:
            `✅ *تم اعتماد اسم الجلسة:* *${updated.label}* (\`${updated.id}\`)\n\n` +
            `الآن أرسل رقم هاتف واتساب مع رمز الدولة الدولي لإكمال الربط (مثال: \`+966501234567\`):`,
          keyboard: [buildBackCancelRow('menu:sessions:page:1')],
        };
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text:
            `⚠️ *الاسم المدخل غير صالح:*\n${safeErr.userMessage}\n\n` +
            `أعد إرسال اسم الجلسة أو اضغط إلغاء:`,
          keyboard: [buildBackCancelRow('menu:sessions:page:1')],
        };
      }
    }

    try {
      const result = await this.sessionManager.initiatePairing({
        sessionId: state.sessionId,
        rawPhoneNumber: rawInputText,
        actorTelegramId: adminId,
      });

      this.states.delete(adminId);

      return {
        text:
          `✅ *تم توليد رمز الربط وحالة الجلسة الآن:* ${formatSessionStatusArabic(result.session.status)}\n\n` +
          `🆔 معرف الجلسة: \`${result.session.id}\` (\`${result.session.label}\`)\n` +
          `📱 الرقم المقترن: \`${result.maskedPhone}\`\n` +
          `🔑 رمز الربط (Pairing Code): \`${result.pairingCode}\`\n\n` +
          `📌 *خطوات الإدخال في تطبيق واتساب:*\n${result.instructionsArabic}\n\n` +
          `تم حفظ حالة الجلسة في مجلد معزول وتسجيلها في قاعدة البيانات.`,
        keyboard: [
          [
            { text: '📋 عرض تفاصيل الجلسة', callbackData: `sess:view:${result.session.id}` },
            { text: '➕ ربط حساب آخر', callbackData: 'menu:add_account' },
          ],
          buildAppNavigationRow({
            backCallback: 'menu:sessions:page:1',
            refreshCallback: `sess:view:${result.session.id}`,
          }),
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text:
          `⚠️ *تعذر إتمام الربط:*\n${escapeMarkdown(safeErr.userMessage)}\n\n` +
          `الرجاء إعادة إرسال رقم هاتف دولي صحيح (مثال: \`+966501234567\`) أو إلغاء العملية:`,
        keyboard: [buildBackCancelRow('menu:sessions:page:1')],
      };
    }
  }
}
