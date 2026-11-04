import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';
import { SendMediaOperation } from '../../whatsapp/operations/send-media';
import {
  validateRecipient,
  validateMediaUpload,
  ValidatedMediaFile,
} from '../../security/validation';
import { buildMultiSessionSelectorKeyboard } from '../keyboards/session-menu';
import { buildBackCancelRow } from '../keyboards/main-menu';
import {
  renderBreadcrumb,
  renderStepProgressBar,
  recordRecentRecipient,
  buildRecentRecipientsRows,
} from '../keyboards/ui-theme';
import { formatTaskStatusArabic } from '../keyboards/task-menu';
import { BotViewResponse } from './pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';
import { escapeMarkdown } from '../../utils/markdown';

export type MediaWorkflowStep =
  | 'AWAITING_RECIPIENT'
  | 'AWAITING_FILE'
  | 'SELECTING_SESSIONS'
  | 'AWAITING_CONFIRMATION';

export interface MediaWorkflowState {
  step: MediaWorkflowStep;
  recipientJid?: string;
  recipientDisplay?: string;
  mediaFile?: ValidatedMediaFile;
  caption?: string;
  selectedSessionIds: string[];
}

export class MediaWorkflow {
  private readonly states = new Map<number, MediaWorkflowState>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager,
    private readonly sendMediaOp: SendMediaOperation,
    private readonly tempUploadDir: string,
    private readonly maxUploadSizeMb: number
  ) {
    const resolved = path.resolve(tempUploadDir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
  }

  public getState(adminId: number): MediaWorkflowState | undefined {
    return this.states.get(adminId);
  }

  public cancel(adminId: number): void {
    const existing = this.states.get(adminId);
    if (existing?.mediaFile) {
      this.sendMediaOp.cleanupTempFile(existing.mediaFile.safeFilePath);
    }
    this.states.delete(adminId);
  }

  public start(adminId: number): BotViewResponse {
    this.cancel(adminId);
    this.states.set(adminId, {
      step: 'AWAITING_RECIPIENT',
      selectedSessionIds: [],
    });

    const recentRows = buildRecentRecipientsRows(adminId, 'wf_media:recent:');

    return {
      text:
        `${renderBreadcrumb(['🏠 الرئيسية', '📎 إرسال وسائط أو ملف'])}\n` +
        `${renderStepProgressBar(1, 4, 'تحديد المستلم')}\n\n` +
        `📎 *إرسال وسائط أو ملف (صورة / مستند / فيديو / صوت)*\n\n` +
        `الخطوة 1 من 4: الرجاء إرسال رقم هاتف المستلم مع رمز الدولة (مثال: \`+966559876543\`) أو معرف المجموعة:`,
      keyboard: [...recentRows, buildBackCancelRow('menu:main')],
      toastText: '📎 أرسل رقم المستلم أو اختر من القائمة',
    };
  }

  public promptEditRecipient(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    state.step = 'AWAITING_RECIPIENT';
    const recentRows = buildRecentRecipientsRows(adminId, 'wf_media:recent:');
    return {
      text:
        `${renderBreadcrumb(['🏠 الرئيسية', '📎 إرسال ملف', '👤 تعديل المستلم'])}\n` +
        `${renderStepProgressBar(1, 4, 'تعديل رقم المستلم')}\n\n` +
        `👤 *تعديل رقم المستلم*\n` +
        `المستلم الحالي: \`${state.recipientDisplay || 'غير محدد'}\`\n\n` +
        `أرسل الآن رقم الهاتف الدولي الجديد أو اختر من القائمة أدناه:`,
      keyboard: [...recentRows, buildBackCancelRow('menu:main')],
      toastText: '👤 أرسل رقم المستلم الجديد',
    };
  }

  public promptEditFile(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    state.step = 'AWAITING_FILE';
    return {
      text:
        `${renderBreadcrumb(['🏠 الرئيسية', '📎 إرسال ملف', '📎 تغيير الملف'])}\n` +
        `${renderStepProgressBar(2, 4, 'رفع الملف الجديد')}\n\n` +
        `📎 *تغيير الملف المرفق*\n` +
        `المستلم: \`${state.recipientDisplay}\`\n\n` +
        `الرجاء رفع الملف الجديد (أو اختيار ملف تجريبي من الأزرار أدناه):`,
      keyboard: [
        [
          {
            text: '📄 إرفاق مستند PDF تجريبي (تقرير.pdf)',
            callbackData: 'wf_media:sample:pdf',
          },
          {
            text: '🖼️ إرفاق صورة PNG تجريبية (شعار.png)',
            callbackData: 'wf_media:sample:png',
          },
        ],
        buildBackCancelRow('menu:main'),
      ],
      toastText: '📎 ارفع الملف الجديد الآن',
    };
  }

  public handleRecipientInput(adminId: number, rawRecipient: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) return this.start(adminId);

    try {
      const normalized = validateRecipient(rawRecipient);
      state.recipientJid = normalized.jid;
      state.recipientDisplay = normalized.displayTarget;
      recordRecentRecipient(adminId, normalized.displayTarget);

      if (state.mediaFile && state.selectedSessionIds.length > 0) {
        return this.proceedToConfirmation(adminId);
      }

      state.step = 'AWAITING_FILE';

      return {
        text:
          `${renderBreadcrumb(['🏠 الرئيسية', '📎 إرسال وسائط أو ملف'])}\n` +
          `${renderStepProgressBar(2, 4, 'رفع الملف المطلوب')}\n\n` +
          `✅ *تم تحديد المستلم:* \`${normalized.displayTarget}\`\n\n` +
          `الخطوة 2 من 4: الرجاء رفع الملف المطلوب (أو اختيار ملف تجريبي آمن من الأزرار أدناه للاختبار الفوري).\n` +
          `الحد الأقصى المسموح به: *${this.maxUploadSizeMb} ميجابايت*.`,
        keyboard: [
          [
            {
              text: '📄 إرفاق مستند PDF تجريبي (تقرير.pdf)',
              callbackData: 'wf_media:sample:pdf',
            },
            {
              text: '🖼️ إرفاق صورة PNG تجريبية (شعار.png)',
              callbackData: 'wf_media:sample:png',
            },
          ],
          buildBackCancelRow('menu:main'),
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      const recentRows = buildRecentRecipientsRows(adminId, 'wf_media:recent:');
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [...recentRows, buildBackCancelRow('menu:main')],
      };
    }
  }

  public handleFileUpload(
    adminId: number,
    params: {
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      contentBuffer: Buffer;
      caption?: string;
    }
  ): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }

    try {
      const validated = validateMediaUpload({
        originalFilename: params.originalFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        maxUploadSizeMb: this.maxUploadSizeMb,
        tempUploadDir: this.tempUploadDir,
      });

      fs.writeFileSync(validated.safeFilePath, params.contentBuffer, { mode: 0o600 });

      if (
        state.mediaFile?.safeFilePath &&
        state.mediaFile.safeFilePath !== validated.safeFilePath
      ) {
        this.sendMediaOp.cleanupTempFile(state.mediaFile.safeFilePath);
      }

      state.mediaFile = validated;
      state.caption = params.caption;
      state.step = 'SELECTING_SESSIONS';
      if (state.selectedSessionIds.length === 0) {
        state.selectedSessionIds = this.sessionManager
          .listConnectedSessions(adminId)
          .map((s) => s.id);
      }

      return this.renderSessionSelection(adminId);
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *تم رفض الملف المرفوع:*\n${safeErr.userMessage}`,
        keyboard: [buildBackCancelRow('menu:main')],
      };
    }
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
    if (!state || !state.mediaFile) return this.start(adminId);

    state.step = 'SELECTING_SESSIONS';
    return {
      text:
        `${renderBreadcrumb(['🏠 الرئيسية', '📎 إرسال ملف', '📡 الجلسات'])}\n` +
        `${renderStepProgressBar(3, 4, 'اختيار الجلسات المرسِلة')}\n\n` +
        `📎 *اختيار الجلسات لإرسال الملف*\n` +
        `المستلم: \`${state.recipientDisplay}\`\n` +
        `الملف: \`${escapeMarkdown(state.mediaFile.safeOriginalName)}\` (${state.mediaFile.kind})\n\n` +
        `الخطوة 3 من 4: حدد الجلسات المطلوبة:`,
      keyboard: buildMultiSessionSelectorKeyboard({
        sessions: this.sessionManager.listSessions(adminId),
        selectedIds: state.selectedSessionIds,
        workflowPrefix: 'wf_media',
      }),
    };
  }

  public proceedToConfirmation(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid || !state.mediaFile) {
      return this.start(adminId);
    }

    if (state.selectedSessionIds.length === 0) {
      return {
        text: '⚠️ الرجاء اختيار جلسة واحدة على الأقل.',
        keyboard: buildMultiSessionSelectorKeyboard({
          sessions: this.sessionManager.listSessions(adminId),
          selectedIds: state.selectedSessionIds,
          workflowPrefix: 'wf_media',
        }),
      };
    }

    state.step = 'AWAITING_CONFIRMATION';
    const sizeKb = Math.max(1, Math.round(state.mediaFile.sizeBytes / 1024));
    const safeCaption = state.caption ? escapeMarkdown(state.caption) : 'بدون';

    return {
      text:
        `${renderBreadcrumb(['🏠 الرئيسية', '📎 إرسال ملف', '✅ التأكيد'])}\n` +
        `${renderStepProgressBar(4, 4, 'مراجعة وتأكيد الإرسال')}\n\n` +
        `📋 *ملخص تأكيد إرسال ملف/وسائط*\n\n` +
        `👤 *المستلم:* \`${state.recipientDisplay}\`\n` +
        `📎 *اسم الملف:* \`${escapeMarkdown(state.mediaFile.safeOriginalName)}\`\n` +
        `🏷️ *النوع والحجم:* \`${state.mediaFile.mimeType}\` (${sizeKb} KB)\n` +
        `📝 *التسمية التوضيحية:* ${safeCaption}\n` +
        `🔢 *عدد الجلسات:* ${state.selectedSessionIds.length}\n\n` +
        `_سيتم حذف النسخة المؤقتة من الخادم تلقائياً فور انتهاء المهمة._`,
      keyboard: [
        [
          { text: '✅ تأكيد إرسال الملف', callbackData: 'wf_media:confirm_execute' },
          { text: '❌ إلغاء وحذف الملف المؤقت', callbackData: 'workflow:cancel' },
        ],
        [
          { text: '👤 تعديل المستلم', callbackData: 'wf_media:edit_recipient' },
          { text: '📎 تغيير الملف', callbackData: 'wf_media:edit_file' },
        ],
        [{ text: '🔙 تعديل الجلسات المحددة', callbackData: 'wf_media:back_sessions' }],
      ],
    };
  }

  public async confirmAndExecute(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid || !state.mediaFile) {
      return this.start(adminId);
    }

    const recipientJid = state.recipientJid;
    const recipientDisplay = state.recipientDisplay || recipientJid;
    const mediaFile = state.mediaFile;
    const caption = state.caption;
    const selectedSessionIds = [...state.selectedSessionIds];
    this.states.delete(adminId);

    try {
      const task = await this.taskManager.runMultiSessionTask({
        operationType: 'SEND_MEDIA',
        targetSummary: `${mediaFile.safeOriginalName} إلى ${recipientDisplay}`,
        selectedSessionIds,
        actorTelegramId: adminId,
        executor: (sessionId) =>
          this.sendMediaOp.executeForSession({
            sessionId,
            recipient: recipientJid,
            mediaFile,
            caption,
          }),
        onCompleteCleanup: () => {
          this.sendMediaOp.cleanupTempFile(mediaFile.safeFilePath);
        },
      });

      const perSessionLines = task.results.map((r) => {
        const icon = r.status === 'SUCCESS' ? '✅' : '❌';
        const detail = escapeMarkdown(r.result_summary || r.error_message || r.status);
        return `${icon} \`${r.session_id}\`: ${detail}`;
      });

      return {
        text:
          `📊 *تقرير إرسال الوسائط والملفات*\n` +
          `🆔 معرف المهمة: \`${task.id}\`\n` +
          `📌 الحالة: ${formatTaskStatusArabic(task.status)}\n` +
          `🧹 تم تنظيف وحذف الملف المؤقت بأمان.\n\n` +
          `*النتائج:*\n${perSessionLines.join('\n')}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    } catch (err) {
      this.sendMediaOp.cleanupTempFile(mediaFile.safeFilePath);
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *تعذر إرسال الملف:*\n${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    }
  }
}
