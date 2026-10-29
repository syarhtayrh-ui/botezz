import crypto from 'node:crypto';
import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';
import {
  GroupOperations,
  GroupManagementActionType,
} from '../../whatsapp/operations/group-operations';
import { validateGroupInviteLink } from '../../security/validation';
import { buildMultiSessionSelectorKeyboard } from '../keyboards/session-menu';
import { buildBackCancelRow, InlineKeyboardRows } from '../keyboards/main-menu';
import { formatTaskStatusArabic } from '../keyboards/task-menu';
import { BotViewResponse } from './pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';

export interface JoinGroupWorkflowState {
  mode: 'JOIN_GROUP';
  step: 'AWAITING_LINK' | 'SELECTING_SESSIONS' | 'AWAITING_CONFIRMATION';
  inviteLink?: string;
  inviteCode?: string;
  selectedSessionIds: string[];
}

export interface ManageGroupWorkflowState {
  mode: 'MANAGE_GROUP';
  step: 'AWAITING_PARTICIPANT_PHONE' | 'AWAITING_ACTION_CONFIRMATION';
  sessionId: string;
  groupJid: string;
  groupSubject: string;
  action: GroupManagementActionType;
  targetPhone?: string;
}

export type GroupWorkflowState = JoinGroupWorkflowState | ManageGroupWorkflowState;

export type CompactGroupActionCode = 'INV' | 'ADD' | 'PRO' | 'DEM' | 'REM' | 'LV';

const COMPACT_ACTION_TO_FULL: Record<CompactGroupActionCode, GroupManagementActionType> = {
  INV: 'GET_INVITE_LINK',
  ADD: 'ADD_PARTICIPANT',
  PRO: 'PROMOTE_PARTICIPANT',
  DEM: 'DEMOTE_PARTICIPANT',
  REM: 'REMOVE_PARTICIPANT',
  LV: 'LEAVE_GROUP',
};

export class GroupWorkflow {
  private readonly states = new Map<number, GroupWorkflowState>();
  private readonly groupRefs = new Map<string, { sessionId: string; groupJid: string }>();
  private readonly activeGroupByAdmin = new Map<
    number,
    { sessionId: string; groupJid: string; shortId: string }
  >();
  private lastActiveGroup?: { sessionId: string; groupJid: string; shortId: string };

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager,
    private readonly groupOps: GroupOperations
  ) {}

  public registerGroupRef(sessionId: string, groupJid: string): string {
    const shortId = crypto
      .createHash('sha1')
      .update(`${sessionId}:${groupJid}`)
      .digest('hex')
      .slice(0, 10);
    this.groupRefs.set(shortId, { sessionId, groupJid });
    return shortId;
  }

  public resolveGroupRef(
    shortId: string,
    adminId?: number
  ): { sessionId: string; groupJid: string } | undefined {
    const found = this.groupRefs.get(shortId);
    if (found) return found;
    if (adminId !== undefined) {
      const active = this.activeGroupByAdmin.get(adminId);
      if (active) return { sessionId: active.sessionId, groupJid: active.groupJid };
    }
    if (this.lastActiveGroup) {
      return {
        sessionId: this.lastActiveGroup.sessionId,
        groupJid: this.lastActiveGroup.groupJid,
      };
    }
    return undefined;
  }

  public resolveCompactAction(
    codeOrAction: string
  ): GroupManagementActionType | undefined {
    const upper = codeOrAction.toUpperCase() as CompactGroupActionCode;
    if (upper in COMPACT_ACTION_TO_FULL) {
      return COMPACT_ACTION_TO_FULL[upper];
    }
    const validActions: GroupManagementActionType[] = [
      'GET_INVITE_LINK',
      'ADD_PARTICIPANT',
      'REMOVE_PARTICIPANT',
      'PROMOTE_PARTICIPANT',
      'DEMOTE_PARTICIPANT',
      'LEAVE_GROUP',
    ];
    if (validActions.includes(codeOrAction as GroupManagementActionType)) {
      return codeOrAction as GroupManagementActionType;
    }
    return undefined;
  }

  public getState(adminId: number): GroupWorkflowState | undefined {
    return this.states.get(adminId);
  }

  public cancel(adminId: number): void {
    this.states.delete(adminId);
  }

  // --- Dedicated Join Group Workflow (Section 10) ---
  public startJoinGroup(adminId: number): BotViewResponse {
    this.states.set(adminId, {
      mode: 'JOIN_GROUP',
      step: 'AWAITING_LINK',
      selectedSessionIds: [],
    });

    return {
      text:
        `🔗 *الانضمام إلى مجموعة واتساب عبر رابط دعوة*\n\n` +
        `الخطوة 1 من 3: الرجاء إرسال رابط دعوة المجموعة بالصيغة الرسمية:\n` +
        `\`https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrSt12\``,
      keyboard: [buildBackCancelRow('menu:main')],
    };
  }

  public handleJoinLinkInput(adminId: number, rawLink: string): BotViewResponse {
    try {
      const validated = validateGroupInviteLink(rawLink);
      const connectedIds = this.sessionManager
        .listSessions()
        .filter((s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED')
        .map((s) => s.id);

      this.states.set(adminId, {
        mode: 'JOIN_GROUP',
        step: 'SELECTING_SESSIONS',
        inviteLink: validated.normalizedUrl,
        inviteCode: validated.inviteCode,
        selectedSessionIds: connectedIds,
      });

      return this.renderJoinSessionSelection(adminId);
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [buildBackCancelRow('menu:main')],
      };
    }
  }

  public toggleJoinSession(adminId: number, sessionId: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP') return this.startJoinGroup(adminId);

    const idx = state.selectedSessionIds.indexOf(sessionId);
    if (idx === -1) {
      state.selectedSessionIds.push(sessionId);
    } else {
      state.selectedSessionIds.splice(idx, 1);
    }
    return this.renderJoinSessionSelection(adminId);
  }

  public selectAllJoinSessions(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP') return this.startJoinGroup(adminId);

    state.selectedSessionIds = this.sessionManager
      .listSessions()
      .filter((s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED')
      .map((s) => s.id);
    return this.renderJoinSessionSelection(adminId);
  }

  public clearAllJoinSessions(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP') return this.startJoinGroup(adminId);

    state.selectedSessionIds = [];
    return this.renderJoinSessionSelection(adminId);
  }

  public renderJoinSessionSelection(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP') return this.startJoinGroup(adminId);

    return {
      text:
        `🔗 *اختيار الجلسات للانضمام إلى المجموعة*\n` +
        `الرابط: \`${state.inviteLink}\`\n\n` +
        `الخطوة 2 من 3: اختر الجلسات التي تريد ضمها للمجموعة:`,
      keyboard: buildMultiSessionSelectorKeyboard({
        sessions: this.sessionManager.listSessions(),
        selectedIds: state.selectedSessionIds,
        workflowPrefix: 'wf_join',
      }),
    };
  }

  public proceedJoinConfirmation(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP' || !state.inviteLink) {
      return this.startJoinGroup(adminId);
    }

    if (state.selectedSessionIds.length === 0) {
      return {
        text: '⚠️ الرجاء اختيار جلسة واحدة على الأقل.',
        keyboard: buildMultiSessionSelectorKeyboard({
          sessions: this.sessionManager.listSessions(),
          selectedIds: state.selectedSessionIds,
          workflowPrefix: 'wf_join',
        }),
      };
    }

    state.step = 'AWAITING_CONFIRMATION';
    return {
      text:
        `📋 *تأكيد الانضمام إلى المجموعة*\n\n` +
        `🔗 *رابط الدعوة:* \`${state.inviteLink}\`\n` +
        `🔢 *عدد الجلسات المحددة:* ${state.selectedSessionIds.length}\n` +
        `🆔 *الجلسات:* \`${state.selectedSessionIds.join(', ')}\`\n\n` +
        `هل تؤكد تنفيذ عملية الانضمام؟`,
      keyboard: [
        [
          { text: '✅ تأكيد الانضمام', callbackData: 'wf_join:confirm_execute' },
          { text: '❌ إلغاء', callbackData: 'workflow:cancel' },
        ],
      ],
    };
  }

  public async executeJoinGroup(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP' || !state.inviteLink) {
      return this.startJoinGroup(adminId);
    }

    const inviteLink = state.inviteLink;
    const selectedSessionIds = [...state.selectedSessionIds];
    this.states.delete(adminId);

    try {
      const task = await this.taskManager.runMultiSessionTask({
        operationType: 'JOIN_GROUP',
        targetSummary: inviteLink,
        selectedSessionIds,
        actorTelegramId: adminId,
        executor: (sessionId) =>
          this.groupOps.joinGroupForSession({
            sessionId,
            inviteLink,
            actorTelegramId: adminId,
          }),
      });

      const lines = task.results.map((r) => {
        const icon = r.status === 'SUCCESS' ? '✅' : '❌';
        return `${icon} \`${r.session_id}\`: ${r.result_summary || r.error_message}`;
      });

      return {
        text:
          `📊 *تقرير مهمة الانضمام إلى المجموعة*\n` +
          `🆔 معرف المهمة: \`${task.id}\`\n` +
          `📌 الحالة: ${formatTaskStatusArabic(task.status)}\n\n` +
          `*النتائج لكل جلسة:*\n${lines.join('\n')}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    }
  }

  // --- Group Management Submenu & Permission-Sensitive Actions (Section 9) ---
  public async renderGroupDetails(
    sessionId: string,
    groupJid: string,
    adminId?: number
  ): Promise<BotViewResponse> {
    try {
      const group = await this.groupOps.getGroupDetails(sessionId, groupJid);
      const shortId = this.registerGroupRef(sessionId, groupJid);
      const activeEntry = { sessionId, groupJid, shortId };
      this.lastActiveGroup = activeEntry;
      if (adminId !== undefined) {
        this.activeGroupByAdmin.set(adminId, activeEntry);
      }

      const adminBadge = group.isBotAdmin
        ? '🟢 مشرف في المجموعة (يمتلك صلاحيات الإدارة)'
        : '🟡 عضو عادي (صلاحيات الإدارة غير متاحة)';

      const participantPreview = group.participants
        .slice(0, 6)
        .map(
          (p) =>
            `• \`${p.jid.split('@')[0]}\` (${p.isSuperAdmin ? 'مالك' : p.isAdmin ? 'مشرف' : 'عضو'})`
        )
        .join('\n');

      const rows: InlineKeyboardRows = [];

      if (group.isBotAdmin) {
        rows.push([
          {
            text: '🔗 استخراج رابط الدعوة',
            callbackData: `ga:${shortId}:INV`,
          },
          {
            text: '➕ إضافة عضو',
            callbackData: `ga:${shortId}:ADD`,
          },
        ]);
        rows.push([
          {
            text: '⬆️ ترقية عضو لمشرف',
            callbackData: `ga:${shortId}:PRO`,
          },
          {
            text: '⬇️ إلغاء إشراف عضو',
            callbackData: `ga:${shortId}:DEM`,
          },
        ]);
        rows.push([
          {
            text: '🚫 إزالة عضو من المجموعة',
            callbackData: `ga:${shortId}:REM`,
          },
        ]);
      }

      rows.push([
        {
          text: '🚪 مغادرة المجموعة (يتطلب تأكيد)',
          callbackData: `ga:${shortId}:LV`,
        },
      ]);
      rows.push([
        { text: '🔙 رجوع لقائمة المجموعات', callbackData: `grp:list:${sessionId}` },
      ]);

      return {
        text:
          `👥 *تفاصيل المجموعة:* ${group.subject}\n\n` +
          `🆔 المعرف: \`${group.jid}\`\n` +
          `👥 عدد الأعضاء: ${group.size}\n` +
          `🛡️ صلاحية الجلسة: ${adminBadge}\n` +
          `📝 الوصف: ${group.desc || 'لا يوجد'}\n\n` +
          `*أبرز المشاركين:*\n${participantPreview}`,
        keyboard: rows,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    }
  }

  public async initiateGroupAction(params: {
    adminId: number;
    sessionId: string;
    groupJid: string;
    action: GroupManagementActionType;
  }): Promise<BotViewResponse> {
    const { adminId, sessionId, groupJid, action } = params;
    try {
      const group = await this.groupOps.getGroupDetails(sessionId, groupJid);
      const shortId = this.registerGroupRef(sessionId, groupJid);
      this.activeGroupByAdmin.set(adminId, { sessionId, groupJid, shortId });
      this.lastActiveGroup = { sessionId, groupJid, shortId };

      if (action === 'GET_INVITE_LINK') {
        const resultMsg = await this.groupOps.executeAdminGroupAction({
          sessionId,
          groupJid,
          action,
          actorTelegramId: adminId,
        });
        return {
          text: `✅ ${resultMsg}`,
          keyboard: [
            [
              {
                text: '🔙 العودة لتفاصيل المجموعة',
                callbackData: `gv:${shortId}`,
              },
            ],
          ],
        };
      }

      if (action === 'LEAVE_GROUP') {
        this.states.set(adminId, {
          mode: 'MANAGE_GROUP',
          step: 'AWAITING_ACTION_CONFIRMATION',
          sessionId,
          groupJid,
          groupSubject: group.subject,
          action,
        });
        return {
          text:
            `⚠️ *تأكيد إجراء حساس (مغادرة مجموعة)*\n\n` +
            `📌 المجموعة المستهدفة: *${group.subject}*\n` +
            `🆔 الجلسة: \`${sessionId}\`\n` +
            `⚡ الإجراء: مغادرة المجموعة نهائياً\n\n` +
            `هل أنت متأكد من رغبتك في المغادرة؟`,
          keyboard: [
            [
              { text: '✅ تأكيد المغادرة', callbackData: 'wf_grp:confirm_action' },
              { text: '❌ إلغاء', callbackData: `gv:${shortId}` },
            ],
          ],
        };
      }

      // Participant modification actions require phone number input first
      this.states.set(adminId, {
        mode: 'MANAGE_GROUP',
        step: 'AWAITING_PARTICIPANT_PHONE',
        sessionId,
        groupJid,
        groupSubject: group.subject,
        action,
      });

      const actionArabic: Record<string, string> = {
        ADD_PARTICIPANT: 'إضافة عضو جديد',
        REMOVE_PARTICIPANT: 'إزالة عضو من المجموعة',
        PROMOTE_PARTICIPANT: 'ترقية عضو إلى مشرف',
        DEMOTE_PARTICIPANT: 'إلغاء إشراف عضو',
      };

      return {
        text:
          `👥 *${actionArabic[action]}*\n` +
          `المجموعة: *${group.subject}*\n\n` +
          `الرجاء إرسال رقم هاتف العضو المستهدف مع رمز الدولة (مثال: \`+966553334444\`):`,
        keyboard: [
          [
            {
              text: '🔙 إلغاء والعودة للمجموعة',
              callbackData: `gv:${shortId}`,
            },
          ],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    }
  }

  public handleParticipantPhoneInput(adminId: number, rawPhone: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'MANAGE_GROUP') {
      return this.startJoinGroup(adminId);
    }

    state.targetPhone = rawPhone.trim();
    state.step = 'AWAITING_ACTION_CONFIRMATION';
    const shortId = this.registerGroupRef(state.sessionId, state.groupJid);

    return {
      text:
        `⚠️ *تأكيد إجراء إداري على المجموعة*\n\n` +
        `📌 المجموعة: *${state.groupSubject}*\n` +
        `🆔 الجلسة: \`${state.sessionId}\`\n` +
        `⚡ الإجراء: \`${state.action}\`\n` +
        `📱 العضو المستهدف: \`${state.targetPhone}\`\n\n` +
        `هل تؤكد تنفيذ هذا الإجراء وتسجيله في سجل التدقيق؟`,
      keyboard: [
        [
          { text: '✅ تأكيد التنفيذ', callbackData: 'wf_grp:confirm_action' },
          {
            text: '❌ إلغاء',
            callbackData: `gv:${shortId}`,
          },
        ],
      ],
    };
  }

  public async confirmGroupAction(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'MANAGE_GROUP') {
      return {
        text: 'لا توجد عملية مجموعة معلقة للتأكيد.',
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
      };
    }

    const { sessionId, groupJid, action, targetPhone } = state;
    const shortId = this.registerGroupRef(sessionId, groupJid);
    this.states.delete(adminId);

    try {
      const summary = await this.groupOps.executeAdminGroupAction({
        sessionId,
        groupJid,
        action,
        targetPhone,
        actorTelegramId: adminId,
      });

      return {
        text: `✅ *تم تنفيذ العملية بنجاح:*\n${summary}`,
        keyboard: [
          [{ text: '👥 العودة لقائمة المجموعات', callbackData: `grp:list:${sessionId}` }],
          [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *تعذر تنفيذ إجراء المجموعة:*\n${safeErr.userMessage}`,
        keyboard: [
          [
            {
              text: '🔙 العودة لتفاصيل المجموعة',
              callbackData: `gv:${shortId}`,
            },
          ],
        ],
      };
    }
  }
}
