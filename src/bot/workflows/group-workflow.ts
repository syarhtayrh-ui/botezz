import crypto from 'node:crypto';
import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';
import {
  GroupOperations,
  GroupManagementActionType,
} from '../../whatsapp/operations/group-operations';
import {
  validateGroupInviteLink,
  normalizePhoneNumber,
} from '../../security/validation';
import { buildMultiSessionSelectorKeyboard } from '../keyboards/session-menu';
import { buildBackCancelRow, InlineKeyboardRows } from '../keyboards/main-menu';
import { formatTaskStatusArabic } from '../keyboards/task-menu';
import {
  renderBreadcrumb,
  renderStepProgressBar,
} from '../keyboards/ui-theme';
import { BotViewResponse } from './pairing-workflow';
import { toSafeArabicError } from '../../utils/errors';
import { escapeMarkdown } from '../../utils/markdown';

export interface JoinGroupWorkflowState {
  mode: 'JOIN_GROUP';
  step: 'AWAITING_LINK' | 'SELECTING_SESSIONS' | 'AWAITING_CONFIRMATION';
  inviteLink?: string;
  inviteCode?: string;
  selectedSessionIds: string[];
}

export interface ManageGroupWorkflowState {
  mode: 'MANAGE_GROUP';
  step:
    | 'AWAITING_PARTICIPANT_PHONE'
    | 'AWAITING_TEXT_PAYLOAD'
    | 'AWAITING_ACTION_CONFIRMATION';
  sessionId: string;
  groupJid: string;
  groupSubject: string;
  action: GroupManagementActionType;
  targetPhone?: string;
  textPayload?: string;
}

export interface CreateGroupWorkflowState {
  mode: 'CREATE_GROUP';
  step: 'AWAITING_SUBJECT' | 'AWAITING_PARTICIPANTS';
  sessionId: string;
  subject?: string;
}

export type GroupWorkflowState =
  | JoinGroupWorkflowState
  | ManageGroupWorkflowState
  | CreateGroupWorkflowState;

export type CompactGroupActionCode =
  | 'INV'
  | 'REV'
  | 'ADD'
  | 'PRO'
  | 'DEM'
  | 'REM'
  | 'SUB'
  | 'DSC'
  | 'ANN'
  | 'NAN'
  | 'EPH'
  | 'APR'
  | 'REJ'
  | 'HTG'
  | 'LV';

const COMPACT_ACTION_TO_FULL: Record<CompactGroupActionCode, GroupManagementActionType> = {
  INV: 'GET_INVITE_LINK',
  REV: 'REVOKE_INVITE_LINK',
  ADD: 'ADD_PARTICIPANT',
  PRO: 'PROMOTE_PARTICIPANT',
  DEM: 'DEMOTE_PARTICIPANT',
  REM: 'REMOVE_PARTICIPANT',
  SUB: 'UPDATE_SUBJECT',
  DSC: 'UPDATE_DESCRIPTION',
  ANN: 'SET_ANNOUNCEMENT',
  NAN: 'SET_NOT_ANNOUNCEMENT',
  EPH: 'TOGGLE_EPHEMERAL',
  APR: 'APPROVE_ALL_JOIN_REQUESTS',
  REJ: 'REJECT_ALL_JOIN_REQUESTS',
  HTG: 'SEND_HIDETAG',
  LV: 'LEAVE_GROUP',
};

const TEXT_INPUT_GROUP_ACTIONS = new Set<GroupManagementActionType>([
  'UPDATE_SUBJECT',
  'UPDATE_DESCRIPTION',
  'TOGGLE_EPHEMERAL',
  'SEND_HIDETAG',
]);

const IMMEDIATE_GROUP_ACTIONS = new Set<GroupManagementActionType>([
  'GET_INVITE_LINK',
  'REVOKE_INVITE_LINK',
  'SET_ANNOUNCEMENT',
  'SET_NOT_ANNOUNCEMENT',
  'APPROVE_ALL_JOIN_REQUESTS',
  'REJECT_ALL_JOIN_REQUESTS',
]);

export class GroupWorkflow {
  private readonly states = new Map<number, GroupWorkflowState>();
  private readonly groupRefs = new Map<string, { sessionId: string; groupJid: string }>();
  private readonly activeGroupByAdmin = new Map<
    number,
    { sessionId: string; groupJid: string; shortId: string }
  >();

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
    return undefined;
  }

  public resolveCompactAction(
    codeOrAction: string
  ): GroupManagementActionType | undefined {
    const upper = codeOrAction.toUpperCase() as CompactGroupActionCode;
    if (upper in COMPACT_ACTION_TO_FULL) {
      return COMPACT_ACTION_TO_FULL[upper];
    }
    const validActions = Object.values(COMPACT_ACTION_TO_FULL);
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

  // --- Create New Group Workflow ---
  public startCreateGroup(adminId: number, sessionId: string): BotViewResponse {
    this.sessionManager.assertSessionAccess(sessionId, adminId);
    this.states.set(adminId, {
      mode: 'CREATE_GROUP',
      step: 'AWAITING_SUBJECT',
      sessionId,
    });
    return {
      text:
        `${renderBreadcrumb(['الرئيسية', 'المجموعات', 'إنشاء مجموعة جديدة'])}\n` +
        `➕ *إنشاء مجموعة واتساب جديدة*\n` +
        `الجلسة: \`${escapeMarkdown(sessionId)}\`\n\n` +
        `الخطوة 1 من 2: أرسل الآن *عنوان (اسم) المجموعة الجديدة*:`,
      keyboard: [buildBackCancelRow('menu:groups')],
      route: 'menu:groups',
      toastText: '✏️ أرسل اسم المجموعة الجديدة',
    };
  }

  // --- Dedicated Join Group Workflow (Section 10) ---
  public startJoinGroup(adminId: number): BotViewResponse {
    this.states.set(adminId, {
      mode: 'JOIN_GROUP',
      step: 'AWAITING_LINK',
      selectedSessionIds: [],
    });

    const breadcrumb = renderBreadcrumb(['الرئيسية', 'الانضمام لمجموعة']);
    const progress = renderStepProgressBar(1, 3, 'إرسال رابط الدعوة');

    return {
      text:
        `${breadcrumb}\n${progress}\n` +
        `🔗 *الانضمام إلى مجموعة واتساب عبر رابط دعوة*\n\n` +
        `الخطوة 1 من 3: الرجاء إرسال رابط دعوة المجموعة بالصيغة الرسمية:\n` +
        `\`https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrSt12\``,
      keyboard: [buildBackCancelRow('menu:main')],
      route: 'menu:join_group',
    };
  }

  public handleJoinLinkInput(adminId: number, rawLink: string): BotViewResponse {
    try {
      const validated = validateGroupInviteLink(rawLink);
      const connectedIds = this.sessionManager
        .listConnectedSessions(adminId)
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
        route: 'menu:join_group',
        toastText: safeErr.userMessage,
      };
    }
  }

  public toggleJoinSession(adminId: number, sessionId: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'JOIN_GROUP') return this.startJoinGroup(adminId);

    if (!this.sessionManager.getSession(sessionId, adminId)) {
      return this.renderJoinSessionSelection(adminId);
    }

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
      .listConnectedSessions(adminId)
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

    const breadcrumb = renderBreadcrumb(['الرئيسية', 'الانضمام لمجموعة']);
    const progress = renderStepProgressBar(2, 3, 'اختيار الجلسات');

    return {
      text:
        `${breadcrumb}\n${progress}\n` +
        `🔗 *اختيار الجلسات للانضمام إلى المجموعة*\n` +
        `الرابط: \`${state.inviteLink}\`\n\n` +
        `الخطوة 2 من 3: اختر الجلسات التي تريد ضمها للمجموعة:`,
      keyboard: buildMultiSessionSelectorKeyboard({
        sessions: this.sessionManager.listSessions(adminId),
        selectedIds: state.selectedSessionIds,
        workflowPrefix: 'wf_join',
      }),
      route: 'menu:join_group',
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
          sessions: this.sessionManager.listSessions(adminId),
          selectedIds: state.selectedSessionIds,
          workflowPrefix: 'wf_join',
        }),
        route: 'menu:join_group',
        toastText: '⚠️ اختر جلسة واحدة على الأقل',
      };
    }

    state.step = 'AWAITING_CONFIRMATION';
    const breadcrumb = renderBreadcrumb(['الرئيسية', 'الانضمام لمجموعة']);
    const progress = renderStepProgressBar(3, 3, 'المراجعة والتأكيد');

    return {
      text:
        `${breadcrumb}\n${progress}\n` +
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
      route: 'menu:join_group',
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
        const summaryText = escapeMarkdown(
          r.result_summary || r.error_message || '—'
        );
        return `${icon} \`${r.session_id}\`: ${summaryText}`;
      });

      return {
        text:
          `📊 *تقرير مهمة الانضمام إلى المجموعة*\n` +
          `🆔 معرف المهمة: \`${task.id}\`\n` +
          `📌 الحالة: ${formatTaskStatusArabic(task.status)}\n\n` +
          `*النتائج لكل جلسة:*\n${lines.join('\n')}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
        route: 'menu:main',
        toastText: '✅ تم تنفيذ الانضمام للمجموعة',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
        route: 'menu:main',
        toastText: safeErr.userMessage,
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
      this.sessionManager.assertSessionAccess(sessionId, adminId);
      const group = await this.groupOps.getGroupDetails(sessionId, groupJid);
      const shortId = this.registerGroupRef(sessionId, groupJid);
      const activeEntry = { sessionId, groupJid, shortId };
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
            text: '🔄 إلغاء وتجديد الرابط',
            callbackData: `ga:${shortId}:REV`,
          },
        ]);
        rows.push([
          {
            text: '➕ إضافة عضو',
            callbackData: `ga:${shortId}:ADD`,
          },
          {
            text: '🚫 إزالة عضو',
            callbackData: `ga:${shortId}:REM`,
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
            text: '✏️ تعديل اسم المجموعة',
            callbackData: `ga:${shortId}:SUB`,
          },
          {
            text: '📝 تعديل الوصف',
            callbackData: `ga:${shortId}:DSC`,
          },
        ]);
        rows.push([
          {
            text: '🔒 قفل المحادثة (مشرفين)',
            callbackData: `ga:${shortId}:ANN`,
          },
          {
            text: '🔓 فتح المحادثة (للجميع)',
            callbackData: `ga:${shortId}:NAN`,
          },
        ]);
        rows.push([
          {
            text: '⏳ الرسائل المؤقتة (Ephemeral)',
            callbackData: `ga:${shortId}:EPH`,
          },
        ]);
        rows.push([
          {
            text: '✅ قبول طلبات الانضمام',
            callbackData: `ga:${shortId}:APR`,
          },
          {
            text: '❌ رفض طلبات الانضمام',
            callbackData: `ga:${shortId}:REJ`,
          },
        ]);
      }

      rows.push([
        {
          text: '📢 إشارة جماعية مخفية (Hidetag @All)',
          callbackData: `ga:${shortId}:HTG`,
        },
      ]);

      rows.push([
        {
          text: '🚪 مغادرة المجموعة (يتطلب تأكيد)',
          callbackData: `ga:${shortId}:LV`,
        },
      ]);
      rows.push([
        { text: '🔙 رجوع لقائمة المجموعات', callbackData: `grp:list:${sessionId}` },
      ]);

      const safeSubject = escapeMarkdown(group.subject || group.jid);
      const safeDesc = escapeMarkdown(group.desc || 'لا يوجد');
      const breadcrumb = renderBreadcrumb([
        'الرئيسية',
        'المجموعات',
        safeSubject.slice(0, 22),
      ]);

      return {
        text:
          `${breadcrumb}\n` +
          `👥 *تفاصيل المجموعة:* ${safeSubject}\n\n` +
          `🆔 المعرف: \`${group.jid}\`\n` +
          `👥 عدد الأعضاء: ${group.size}\n` +
          `🛡️ صلاحية الجلسة: ${adminBadge}\n` +
          `📝 الوصف: ${safeDesc}\n\n` +
          `*أبرز المشاركين:*\n${participantPreview}`,
        keyboard: rows,
        route: `gv:${shortId}`,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
        route: 'menu:groups',
        toastText: safeErr.userMessage,
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
      this.sessionManager.assertSessionAccess(sessionId, adminId);
      const group = await this.groupOps.getGroupDetails(sessionId, groupJid);
      const shortId = this.registerGroupRef(sessionId, groupJid);
      this.activeGroupByAdmin.set(adminId, { sessionId, groupJid, shortId });
      const safeSubject = escapeMarkdown(group.subject || groupJid);

      if (IMMEDIATE_GROUP_ACTIONS.has(action)) {
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
          route: `gv:${shortId}`,
          toastText: '✅ تم تنفيذ الإجراء بنجاح',
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
            `📌 المجموعة المستهدفة: *${safeSubject}*\n` +
            `🆔 الجلسة: \`${sessionId}\`\n` +
            `⚡ الإجراء: مغادرة المجموعة نهائياً\n\n` +
            `هل أنت متأكد من رغبتك في المغادرة؟`,
          keyboard: [
            [
              { text: '✅ تأكيد المغادرة', callbackData: 'wf_grp:confirm_action' },
              { text: '❌ إلغاء', callbackData: `gv:${shortId}` },
            ],
          ],
          route: `gv:${shortId}`,
        };
      }

      if (TEXT_INPUT_GROUP_ACTIONS.has(action)) {
        this.states.set(adminId, {
          mode: 'MANAGE_GROUP',
          step: 'AWAITING_TEXT_PAYLOAD',
          sessionId,
          groupJid,
          groupSubject: group.subject,
          action,
        });

        const prompts: Record<string, string> = {
          UPDATE_SUBJECT: 'أرسل الآن الاسم الجديد للمجموعة (حتى 100 حرف):',
          UPDATE_DESCRIPTION: 'أرسل الآن الوصف الجديد للمجموعة:',
          TOGGLE_EPHEMERAL:
            'أرسل مدة الرسائل المؤقتة بالثواني (`0` للإيقاف، `86400` ليوم، `604800` لأسبوع، `7776000` لـ 90 يوماً):',
          SEND_HIDETAG:
            'أرسل الآن نص الرسالة ليتم بثها مع إشارة مخفية (@All Hidetag) لجميع أعضاء المجموعة:',
        };

        return {
          text:
            `👥 *إجراء على المجموعة:* *${safeSubject}*\n\n` +
            `${prompts[action] || 'أرسل النص المطلوب:'}`,
          keyboard: [
            [
              {
                text: '🔙 إلغاء والعودة للمجموعة',
                callbackData: `gv:${shortId}`,
              },
            ],
          ],
          route: `gv:${shortId}`,
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
          `المجموعة: *${safeSubject}*\n\n` +
          `الرجاء إرسال رقم هاتف العضو المستهدف مع رمز الدولة (مثال: \`+966553334444\`):`,
        keyboard: [
          [
            {
              text: '🔙 إلغاء والعودة للمجموعة',
              callbackData: `gv:${shortId}`,
            },
          ],
        ],
        route: `gv:${shortId}`,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
        route: 'menu:groups',
        toastText: safeErr.userMessage,
      };
    }
  }

  public async handleCreateGroupInput(
    adminId: number,
    rawInput: string
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'CREATE_GROUP') {
      return {
        text: '⚠️ لا توجد عملية إنشاء مجموعة نشطة حالياً.',
        keyboard: [
          [{ text: '👥 إدارة المجموعات', callbackData: 'menu:groups' }],
          buildBackCancelRow('menu:main'),
        ],
        route: 'menu:groups',
      };
    }

    if (state.step === 'AWAITING_SUBJECT') {
      const cleanSubject = rawInput.trim();
      if (!cleanSubject || cleanSubject.length > 100) {
        return {
          text: '⚠️ الرجاء إدخال اسم صالح للمجموعة (1 إلى 100 حرف).',
          keyboard: [buildBackCancelRow('menu:groups')],
          route: 'menu:groups',
        };
      }
      state.subject = cleanSubject;
      state.step = 'AWAITING_PARTICIPANTS';
      return {
        text:
          `✅ *اسم المجموعة:* \`${escapeMarkdown(cleanSubject)}\`\n\n` +
          `الخطوة 2 من 2: أرسل أرقام الهواتف الدولية للأعضاء المراد إضافتهم مفصولة بفاصلة \`,\` (مثال: \`+966501112233, +966554445566\`) أو أرسل \`-\` لإنشائها بدون أعضاء إضافيين:`,
        keyboard: [buildBackCancelRow('menu:groups')],
        route: 'menu:groups',
      };
    }

    const sessionId = state.sessionId;
    const subject = state.subject || 'مجموعة جديدة';
    this.states.delete(adminId);
    const rawPhones =
      rawInput.trim() === '-'
        ? []
        : rawInput
            .split(/[,،\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    try {
      const created = await this.groupOps.createGroupForSession({
        sessionId,
        subject,
        participantPhones: rawPhones,
        actorTelegramId: adminId,
      });
      const shortId = this.registerGroupRef(sessionId, created.jid);
      return {
        text:
          `✅ *تم إنشاء المجموعة بنجاح!*\n\n` +
          `👥 الاسم: *${escapeMarkdown(created.subject)}*\n` +
          `🆔 المعرف: \`${created.jid}\`\n` +
          `🔢 عدد الأعضاء: ${created.size}`,
        keyboard: [
          [{ text: '⚙️ فتح لوحة تحكم المجموعة', callbackData: `gv:${shortId}` }],
          [{ text: '👥 قائمة المجموعات', callbackData: `grp:list:${sessionId}` }],
        ],
        route: `gv:${shortId}`,
        toastText: '✅ تم إنشاء المجموعة',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *تعذر إنشاء المجموعة:*\n${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 العودة للمجموعات', callbackData: 'menu:groups' }]],
        route: 'menu:groups',
      };
    }
  }

  public handleParticipantPhoneInput(
    adminId: number,
    rawInput: string
  ): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return {
        text: '⚠️ لا توجد عملية إدارة مجموعة نشطة حالياً.',
        keyboard: [
          [{ text: '👥 إدارة المجموعات', callbackData: 'menu:groups' }],
          buildBackCancelRow('menu:main'),
        ],
        route: 'menu:groups',
      };
    }

    if (
      state.mode !== 'MANAGE_GROUP' ||
      !state.sessionId ||
      !state.groupJid ||
      !state.action
    ) {
      return {
        text: '⚠️ لا توجد عملية إدارة مجموعة نشطة حالياً.',
        keyboard: [
          [{ text: '👥 إدارة المجموعات', callbackData: 'menu:groups' }],
          buildBackCancelRow('menu:main'),
        ],
        route: 'menu:groups',
      };
    }

    const shortId = this.registerGroupRef(state.sessionId, state.groupJid);
    const safeSubject = escapeMarkdown(state.groupSubject || state.groupJid);

    if (state.step === 'AWAITING_TEXT_PAYLOAD') {
      state.textPayload = rawInput.trim();
      state.step = 'AWAITING_ACTION_CONFIRMATION';
      return {
        text:
          `⚠️ *تأكيد إجراء على المجموعة*\n\n` +
          `📌 المجموعة: *${safeSubject}*\n` +
          `🆔 الجلسة: \`${state.sessionId}\`\n` +
          `⚡ الإجراء: \`${state.action}\`\n` +
          `📝 القيمة المدخلة: \`${escapeMarkdown(state.textPayload.slice(0, 120))}\`\n\n` +
          `هل تؤكد تنفيذ هذا الإجراء؟`,
        keyboard: [
          [
            { text: '✅ تأكيد التنفيذ', callbackData: 'wf_grp:confirm_action' },
            { text: '❌ إلغاء', callbackData: `gv:${shortId}` },
          ],
        ],
        route: `gv:${shortId}`,
      };
    }

    try {
      const normalized = normalizePhoneNumber(rawInput);
      state.targetPhone = normalized.e164;
      state.step = 'AWAITING_ACTION_CONFIRMATION';

      return {
        text:
          `⚠️ *تأكيد إجراء إداري على المجموعة*\n\n` +
          `📌 المجموعة: *${safeSubject}*\n` +
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
        route: `gv:${shortId}`,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      state.step = 'AWAITING_PARTICIPANT_PHONE';
      return {
        text:
          `⚠️ *رقم العضو غير صالح*\n` +
          `${safeErr.userMessage}\n\n` +
          `📌 المجموعة: *${safeSubject}*\n` +
          `يرجى إعادة إرسال رقم هاتف العضو بالصيغة الدولية الصحيحة (مثال: \`+966553334444\`):`,
        keyboard: [
          [
            {
              text: '🔙 إلغاء والعودة للمجموعة',
              callbackData: `gv:${shortId}`,
            },
          ],
        ],
        route: `gv:${shortId}`,
        toastText: safeErr.userMessage,
      };
    }
  }

  public async confirmGroupAction(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || state.mode !== 'MANAGE_GROUP') {
      return {
        text: 'لا توجد عملية مجموعة معلقة للتأكيد.',
        keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
        route: 'menu:groups',
      };
    }

    const { sessionId, groupJid, action, targetPhone, textPayload } = state;
    const shortId = this.registerGroupRef(sessionId, groupJid);
    this.states.delete(adminId);

    try {
      const summary = await this.groupOps.executeAdminGroupAction({
        sessionId,
        groupJid,
        action,
        targetPhone,
        textPayload,
        actorTelegramId: adminId,
      });

      return {
        text: `✅ *تم تنفيذ العملية بنجاح:*\n${summary}`,
        keyboard: [
          [{ text: '⚙️ العودة لتفاصيل المجموعة', callbackData: `gv:${shortId}` }],
          [{ text: '👥 العودة لقائمة المجموعات', callbackData: `grp:list:${sessionId}` }],
          [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
        ],
        route: `grp:list:${sessionId}`,
        toastText: '✅ تم تنفيذ الإجراء بنجاح',
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
        route: `gv:${shortId}`,
        toastText: safeErr.userMessage,
      };
    }
  }
}
