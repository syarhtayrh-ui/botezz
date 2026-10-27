import { SessionManager } from '../../whatsapp/session-manager';
import {
  InlineKeyboardRows,
  buildBackCancelRow,
} from '../keyboards/main-menu';
import { formatSessionStatusArabic } from '../keyboards/session-menu';
import { toSafeArabicError } from '../../utils/errors';

export interface BotViewResponse {
  text: string;
  keyboard: InlineKeyboardRows;
}

export type PairingStep = 'AWAITING_LABEL' | 'AWAITING_PHONE' | 'CODE_ISSUED';

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
          keyboard: [buildBackCancelRow('menu:sessions:page:1')],
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
        `معرف الجلسة المعزولة: \`${session.id}\`\n\n` +
        `الرجاء إرسال رقم الهاتف مع رمز الدولة الدولي (مثال: \`+966501234567\`)\n` +
        `💡 _اختياري:_ يمكنك إرفاق رمز ربط مخصص من 8 أحرف/أرقام بعد المسافة (مثال: \`+966501234567 MYCODE12\`).\n` +
        `_ملاحظة أمنية: لن يطلب منك البوت أبداً كلمة مرور أو رمز تحقق SMS._`,
      keyboard: [buildBackCancelRow('menu:sessions:page:1')],
    };
  }

  public async handlePhoneInput(
    adminId: number,
    rawPhoneText: string
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.sessionId) {
      return this.startNewLinking(adminId);
    }

    try {
      const result = await this.sessionManager.initiatePairing({
        sessionId: state.sessionId,
        rawPhoneNumber: rawPhoneText,
        actorTelegramId: adminId,
      });

      this.states.delete(adminId);

      return {
        text:
          `✅ *تم توليد رمز الربط وحالة الجلسة الآن:* ${formatSessionStatusArabic(result.session.status)}\n\n` +
          `🆔 معرف الجلسة: \`${result.session.id}\`\n` +
          `📱 الرقم المقترن: \`${result.maskedPhone}\`\n` +
          `🔑 رمز الربط (Pairing Code): \`${result.pairingCode}\`\n\n` +
          `📌 *خطوات الإدخال في تطبيق واتساب:*\n${result.instructionsArabic}\n\n` +
          `تم حفظ حالة الجلسة في مجلد معزول وتسجيلها في قاعدة البيانات.`,
        keyboard: [
          [
            { text: '📋 عرض تفاصيل الجلسة', callbackData: `sess:view:${result.session.id}` },
            { text: '➕ ربط حساب آخر', callbackData: 'menu:add_account' },
          ],
          [{ text: '🔙 العودة لإدارة الجلسات', callbackData: 'menu:sessions:page:1' }],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text:
          `⚠️ *تعذر إتمام الربط:*\n${safeErr.userMessage}\n\n` +
          `الرجاء إعادة إرسال رقم هاتف دولي صحيح (مثال: \`+966501234567\`) أو إلغاء العملية:`,
        keyboard: [buildBackCancelRow('menu:sessions:page:1')],
      };
    }
  }
}
