import { Bot } from 'grammy';
import { AppConfig } from '../config/env';
import {
  verifyTelegramAdmin,
  createGrammyAuthorizationMiddleware,
} from './middleware/authorization';
import { buildBackCancelRow, buildAppNavigationRow } from './keyboards/main-menu';
import { formatSessionStatusArabic } from './keyboards/session-menu';
import { PairingWorkflow, BotViewResponse } from './workflows/pairing-workflow';
import { MessageWorkflow } from './workflows/message-workflow';
import { MediaWorkflow } from './workflows/media-workflow';
import { GroupWorkflow } from './workflows/group-workflow';
import { StartHandler } from './handlers/start';
import { SessionsHandler } from './handlers/sessions';
import { MessagingHandler } from './handlers/messaging';
import { MediaHandler } from './handlers/media';
import { GroupsHandler } from './handlers/groups';
import { TasksHandler } from './handlers/tasks';
import { SettingsHandler } from './handlers/settings';
import { ToolsHandler, DEFAULT_SAMPLE_TEST_FUNCTION } from './handlers/tools';
import {
  BotUiStateManager,
  TelegramMessageTransport,
  createGrammyTransport,
  isNavigableRoute,
} from './ui-state';
import { SessionManager } from '../whatsapp/session-manager';
import { TaskManager } from '../tasks/task-manager';
import { SendMessageOperation } from '../whatsapp/operations/send-message';
import { SendMediaOperation } from '../whatsapp/operations/send-media';
import {
  GroupOperations,
  GroupManagementActionType,
} from '../whatsapp/operations/group-operations';
import { AuditRepository } from '../database/repositories/audit-repository';
import { SettingsRepository } from '../database/repositories/settings-repository';
import { toSafeArabicError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('telegram-bot');

export type ConversationMode =
  | 'NONE'
  | 'PAIRING'
  | 'MESSAGE'
  | 'MEDIA'
  | 'GROUP'
  | 'TOOLS'
  | 'SETTINGS';

export interface TelegramControllerDeps {
  config: AppConfig;
  sessionManager: SessionManager;
  taskManager: TaskManager;
  sendMessageOp: SendMessageOperation;
  sendMediaOp: SendMediaOperation;
  groupOps: GroupOperations;
  auditRepo: AuditRepository;
  settingsRepo: SettingsRepository;
  duplicateTapWindowMs?: number;
  callbackTimeoutMs?: number;
}

export interface HandleInteractionOptions {
  transport?: TelegramMessageTransport;
  skipDuplicateCheck?: boolean;
  chatId?: number;
}

export interface IncomingTelegramMediaUpload {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  contentBuffer: Buffer;
  caption?: string;
}

/**
 * Unified Stateful Telegram Bot Controller.
 * Powers both the live grammY Bot instance and automated integration tests / web simulator.
 * Implements single-message editing (`editMessageText` / `editMessageReplyMarkup`),
 * consistent application navigation (`Back`, `Home`, `Refresh`, `Cancel`),
 * anti-double-tap deduplication, and strict input workflow state tracking.
 */
export class TelegramBotController {
  public readonly uiState: BotUiStateManager;
  public readonly pairingWorkflow: PairingWorkflow;
  public readonly messageWorkflow: MessageWorkflow;
  public readonly mediaWorkflow: MediaWorkflow;
  public readonly groupWorkflow: GroupWorkflow;

  public readonly startHandler: StartHandler;
  public readonly sessionsHandler: SessionsHandler;
  public readonly messagingHandler: MessagingHandler;
  public readonly mediaHandler: MediaHandler;
  public readonly groupsHandler: GroupsHandler;
  public readonly tasksHandler: TasksHandler;
  public readonly settingsHandler: SettingsHandler;
  public readonly toolsHandler: ToolsHandler;

  private activeConversationMode = new Map<number, ConversationMode>();

  constructor(private readonly deps: TelegramControllerDeps) {
    deps.sessionManager.setConfiguredAdminId(deps.config.TELEGRAM_ADMIN_ID);
    this.uiState = new BotUiStateManager({
      duplicateTapWindowMs: deps.duplicateTapWindowMs ?? 75,
      callbackTimeoutMs: deps.callbackTimeoutMs ?? 12_000,
    });

    this.pairingWorkflow = new PairingWorkflow(deps.sessionManager);
    this.messageWorkflow = new MessageWorkflow(
      deps.sessionManager,
      deps.taskManager,
      deps.sendMessageOp
    );
    this.mediaWorkflow = new MediaWorkflow(
      deps.sessionManager,
      deps.taskManager,
      deps.sendMediaOp,
      deps.config.TEMP_UPLOAD_DIR,
      deps.config.MAX_UPLOAD_SIZE_MB
    );
    this.groupWorkflow = new GroupWorkflow(
      deps.sessionManager,
      deps.taskManager,
      deps.groupOps
    );

    this.startHandler = new StartHandler(deps.sessionManager, deps.taskManager);
    this.sessionsHandler = new SessionsHandler(deps.sessionManager);
    this.messagingHandler = new MessagingHandler(this.messageWorkflow);
    this.mediaHandler = new MediaHandler(this.mediaWorkflow);
    this.groupsHandler = new GroupsHandler(
      deps.sessionManager,
      deps.groupOps,
      this.groupWorkflow
    );
    this.tasksHandler = new TasksHandler(deps.taskManager, deps.auditRepo);
    this.settingsHandler = new SettingsHandler(
      deps.settingsRepo,
      deps.auditRepo,
      deps.config
    );
    this.toolsHandler = new ToolsHandler(
      deps.sessionManager,
      deps.taskManager,
      deps.settingsRepo,
      deps.auditRepo
    );
  }

  public isOwnerUser(userId: number): boolean {
    return userId === this.deps.config.TELEGRAM_ADMIN_ID;
  }

  public getConversationMode(adminId: number): ConversationMode {
    return this.activeConversationMode.get(adminId) || 'NONE';
  }

  private cancelAllWorkflowsForAdmin(adminId: number): void {
    this.pairingWorkflow.cancel(adminId);
    this.messageWorkflow.cancel(adminId);
    this.mediaWorkflow.cancel(adminId);
    this.groupWorkflow.cancel(adminId);
    this.toolsHandler.cancel(adminId);
    this.settingsHandler.cancel(adminId);
    this.activeConversationMode.set(adminId, 'NONE');
  }

  private async runWithTimeout<T>(work: () => Promise<T>): Promise<T> {
    const timeoutMs = this.uiState.callbackTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('انتهت مهلة معالجة الزر التفاعلي. يرجى المحاولة مرة أخرى.'));
      }, timeoutMs);
      work()
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Processes any incoming callback query after verifying the numeric Telegram admin ID.
   * Updates the existing menu message in-place (`editMessageText` / `editMessageReplyMarkup`),
   * answers callback queries promptly, and prevents duplicate operations on repeated taps.
   */
  public async handleCallbackQuery(
    actorUserId: number,
    callbackData: string,
    options?: HandleInteractionOptions
  ): Promise<BotViewResponse> {
    verifyTelegramAdmin({
      candidateUserId: actorUserId,
      configuredAdminId: this.deps.config.TELEGRAM_ADMIN_ID,
      actionDescription: `callback:${callbackData}`,
      auditRepo: this.deps.auditRepo,
      settingsRepo: this.deps.settingsRepo,
      chatId: options?.chatId,
    });

    if (!options?.skipDuplicateCheck) {
      const lock = this.uiState.tryAcquireCallbackLock(actorUserId, callbackData);
      if (!lock.acquired) {
        this.uiState.recordCallbackAnswered(actorUserId);
        if (options?.transport?.answerCallbackQuery) {
          await options.transport.answerCallbackQuery({
            text: '⏳ جاري تنفيذ العملية، يرجى عدم تكرار النقر...',
            showAlert: false,
          });
        }
        const sess = this.uiState.getOrCreateSession(actorUserId);
        const fallbackView =
          sess.lastView ||
          this.startHandler.renderMainMenu({
            isAdmin: this.isOwnerUser(actorUserId),
            actorUserId,
          });
        return {
          ...fallbackView,
          toastText: '⏳ تم تجاهل النقرة المكررة',
          uiMeta: {
            deliveryMode: 'DUPLICATE_BLOCKED',
            activeMessageId: sess.activeMessageId ?? 1000,
            currentRoute: sess.currentRoute,
            canGoBack: sess.history.length > 0,
            pendingWorkflow: this.getConversationMode(actorUserId),
            stats: { ...sess.stats },
          },
        };
      }
    }

    let callbackAnswered = false;
    try {
      const view = await this.runWithTimeout(() =>
        this.routeCallbackQueryInternal(actorUserId, callbackData)
      );

      // Answer callback query promptly before or alongside message edit
      this.uiState.recordCallbackAnswered(actorUserId);
      callbackAnswered = true;
      if (options?.transport?.answerCallbackQuery) {
        await options.transport.answerCallbackQuery({
          text: view.toastText,
          showAlert: view.showAlert,
        });
      }

      const sess = this.uiState.getOrCreateSession(actorUserId);
      const preferEdit = sess.activeMessageId !== undefined;
      return await this.uiState.deliverView({
        userId: actorUserId,
        view,
        pendingWorkflow: this.getConversationMode(actorUserId),
        preferEdit,
        transport: options?.transport,
      });
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      if (!callbackAnswered) {
        this.uiState.recordCallbackAnswered(actorUserId);
        if (options?.transport?.answerCallbackQuery) {
          await options.transport.answerCallbackQuery({
            text: safeErr.userMessage,
            showAlert: true,
          });
        }
      }
      const errorView: BotViewResponse = {
        text: `⚠️ *تعذر إكمال الإجراء المطلوب:*\n${safeErr.userMessage}`,
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'nav:back',
            refreshCallback: 'nav:refresh',
          }),
        ],
        toastText: safeErr.userMessage,
        showAlert: true,
      };
      const sess = this.uiState.getOrCreateSession(actorUserId);
      return await this.uiState.deliverView({
        userId: actorUserId,
        view: errorView,
        pendingWorkflow: this.getConversationMode(actorUserId),
        preferEdit: sess.activeMessageId !== undefined,
        transport: options?.transport,
      });
    } finally {
      if (!options?.skipDuplicateCheck) {
        this.uiState.releaseCallbackLock(actorUserId, callbackData);
      }
    }
  }

  private async routeCallbackQueryInternal(
    actorUserId: number,
    callbackData: string
  ): Promise<BotViewResponse> {
    const isOwner = this.isOwnerUser(actorUserId);

    // Handle universal application navigation actions: Home, Cancel, Back, Refresh
    if (
      callbackData === 'menu:main' ||
      callbackData === 'nav:home' ||
      callbackData === '/start'
    ) {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.uiState.resetHome(actorUserId);
      return this.startHandler.renderMainMenu({
        isAdmin: isOwner,
        actorUserId,
      });
    }

    if (callbackData === 'workflow:cancel' || callbackData === 'nav:cancel') {
      const wasActive = this.getConversationMode(actorUserId) !== 'NONE';
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.uiState.resetHome(actorUserId);
      const view = this.startHandler.renderMainMenu({
        isAdmin: isOwner,
        actorUserId,
        noticeBanner: wasActive
          ? '✅ *تم إلغاء العملية الحالية وإعادة ضبط حالة الإدخال.*'
          : undefined,
      });
      return {
        ...view,
        toastText: '❌ تم إلغاء العملية الحالية',
      };
    }

    if (callbackData === 'nav:back') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      const targetRoute = this.uiState.popPreviousRoute(actorUserId);
      const view = await this.routeCallbackQueryInternal(actorUserId, targetRoute);
      return {
        ...view,
        toastText: '🔙 العودة للقائمة السابقة',
      };
    }

    if (callbackData === 'nav:refresh') {
      const currentRoute = this.uiState.getCurrentRoute(actorUserId);
      const targetRoute =
        currentRoute && currentRoute !== 'nav:refresh' ? currentRoute : 'menu:main';
      const view = await this.routeCallbackQueryInternal(actorUserId, targetRoute);
      return {
        ...view,
        toastText: '🔄 تم تحديث البيانات',
      };
    }

    if (isNavigableRoute(callbackData)) {
      this.uiState.recordRouteTransition(actorUserId, callbackData);
    }

    // 1 & 2: Link WhatsApp Account / Add Another Account / Session Naming
    if (
      callbackData === 'menu:link_account' ||
      callbackData === 'menu:add_account' ||
      callbackData === 'menu:pair'
    ) {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'PAIRING');
      return this.pairingWorkflow.startNewLinking(actorUserId);
    }
    if (callbackData.startsWith('pair:prompt_label:')) {
      const sessId = callbackData.slice('pair:prompt_label:'.length);
      this.activeConversationMode.set(actorUserId, 'PAIRING');
      return this.pairingWorkflow.promptSessionLabel(actorUserId, sessId, false);
    }
    if (callbackData.startsWith('sess:prompt_rename:')) {
      const sessId = callbackData.slice('sess:prompt_rename:'.length);
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'PAIRING');
      return this.pairingWorkflow.promptSessionLabel(actorUserId, sessId, true);
    }

    // 3: Manage Sessions & Session Status
    if (callbackData === 'menu:sessions') {
      return this.sessionsHandler.renderSessionsList(1, actorUserId);
    }
    if (callbackData.startsWith('menu:sessions:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.sessionsHandler.renderSessionsList(page, actorUserId);
    }
    if (callbackData === 'menu:session_status') {
      return this.sessionsHandler.renderSessionStatusOverview(actorUserId, isOwner);
    }
    if (callbackData.startsWith('sess:refresh:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      const view = this.sessionsHandler.renderSessionsList(page, actorUserId);
      return {
        ...view,
        toastText: '🔄 تم تحديث حالة الجلسات',
      };
    }
    if (callbackData.startsWith('sess:view:')) {
      const sessionId = callbackData.slice('sess:view:'.length);
      return this.sessionsHandler.renderSessionDetail(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:reconnect:')) {
      const sessionId = callbackData.slice('sess:reconnect:'.length);
      return this.sessionsHandler.handleReconnect(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:disconnect:')) {
      const sessionId = callbackData.slice('sess:disconnect:'.length);
      return this.sessionsHandler.handleDisconnect(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:repair:')) {
      const sessionId = callbackData.slice('sess:repair:'.length);
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'PAIRING');
      return this.pairingWorkflow.startNewLinking(actorUserId, sessionId);
    }
    if (callbackData.startsWith('sess:confirm_remove:')) {
      const sessionId = callbackData.slice('sess:confirm_remove:'.length);
      return this.sessionsHandler.renderConfirmRemove(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:remove:')) {
      const sessionId = callbackData.slice('sess:remove:'.length);
      return this.sessionsHandler.handleRemove(sessionId, actorUserId);
    }
    if (callbackData === 'sess:confirm_purge_inactive') {
      return this.sessionsHandler.renderConfirmPurgeInactive(actorUserId);
    }
    if (callbackData === 'sess:purge_inactive') {
      return this.sessionsHandler.handlePurgeInactive(actorUserId);
    }

    // 4: Send Text Message Workflow
    if (callbackData === 'menu:send_text') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'MESSAGE');
      return this.messagingHandler.startSendText(actorUserId);
    }
    if (callbackData.startsWith('wf_msg:toggle_sess:')) {
      const sessId = callbackData.slice('wf_msg:toggle_sess:'.length);
      return this.messageWorkflow.toggleSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_msg:select_all') {
      return this.messageWorkflow.selectAllConnected(actorUserId);
    }
    if (callbackData === 'wf_msg:clear_all') {
      return this.messageWorkflow.clearAll(actorUserId);
    }
    if (callbackData === 'wf_msg:back_sessions') {
      return this.messageWorkflow.renderSessionSelection(actorUserId);
    }
    if (callbackData === 'wf_msg:proceed_confirm') {
      return this.messageWorkflow.proceedToConfirmation(actorUserId);
    }
    if (callbackData === 'wf_msg:confirm_execute') {
      this.activeConversationMode.set(actorUserId, 'NONE');
      return this.messageWorkflow.confirmAndExecute(actorUserId);
    }

    // 5: Send Media or File Workflow
    if (callbackData === 'menu:send_media') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'MEDIA');
      return this.mediaHandler.startSendMedia(actorUserId);
    }
    if (callbackData === 'wf_media:sample:pdf') {
      return this.mediaHandler.attachSampleFile(actorUserId, 'pdf');
    }
    if (callbackData === 'wf_media:sample:png') {
      return this.mediaHandler.attachSampleFile(actorUserId, 'png');
    }
    if (callbackData.startsWith('wf_media:toggle_sess:')) {
      const sessId = callbackData.slice('wf_media:toggle_sess:'.length);
      return this.mediaWorkflow.toggleSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_media:select_all') {
      return this.mediaWorkflow.selectAllConnected(actorUserId);
    }
    if (callbackData === 'wf_media:clear_all') {
      return this.mediaWorkflow.clearAll(actorUserId);
    }
    if (callbackData === 'wf_media:proceed_confirm') {
      return this.mediaWorkflow.proceedToConfirmation(actorUserId);
    }
    if (callbackData === 'wf_media:confirm_execute') {
      this.activeConversationMode.set(actorUserId, 'NONE');
      return this.mediaWorkflow.confirmAndExecute(actorUserId);
    }

    // 6: Group Management
    if (callbackData === 'menu:groups') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.groupsHandler.renderGroupManagementSubmenu(actorUserId);
    }
    if (callbackData.startsWith('grp:list:')) {
      const sessionId = callbackData.slice('grp:list:'.length);
      return this.groupsHandler.renderSessionGroups(sessionId, 1, actorUserId);
    }
    if (callbackData.startsWith('grp:list_page:')) {
      const parts = callbackData.split(':');
      const sessionId = parts[2];
      const page = Number(parts[3] || '1');
      return this.groupsHandler.renderSessionGroups(sessionId, page, actorUserId);
    }
    if (callbackData.startsWith('gv:')) {
      const shortId = callbackData.slice('gv:'.length);
      const resolved = this.groupWorkflow.resolveGroupRef(shortId, actorUserId);
      if (!resolved) {
        return this.groupsHandler.renderGroupManagementSubmenu(actorUserId);
      }
      return this.groupWorkflow.renderGroupDetails(
        resolved.sessionId,
        resolved.groupJid,
        actorUserId
      );
    }
    if (callbackData.startsWith('ga:')) {
      const parts = callbackData.split(':');
      // Supports both `ga:<shortId>:<actionCode>` and `ga:<actionCode>`
      const hasShortId = parts.length >= 3;
      const shortId = hasShortId ? parts[1] : '';
      const actionCode = hasShortId ? parts[2] : parts[1];
      const resolvedGroup = this.groupWorkflow.resolveGroupRef(shortId, actorUserId);
      const resolvedAction = this.groupWorkflow.resolveCompactAction(actionCode);
      if (!resolvedGroup || !resolvedAction) {
        return this.groupsHandler.renderGroupManagementSubmenu(actorUserId);
      }
      this.activeConversationMode.set(actorUserId, 'GROUP');
      return this.groupWorkflow.initiateGroupAction({
        adminId: actorUserId,
        sessionId: resolvedGroup.sessionId,
        groupJid: resolvedGroup.groupJid,
        action: resolvedAction,
      });
    }
    if (callbackData.startsWith('grp:view:')) {
      const parts = callbackData.split(':');
      const sessionId = parts[2];
      const groupJid = parts.slice(3).join(':');
      return this.groupWorkflow.renderGroupDetails(sessionId, groupJid, actorUserId);
    }
    if (callbackData.startsWith('grp:act:')) {
      const parts = callbackData.split(':');
      const sessionId = parts[2];
      const groupJid = parts[3];
      const action = parts[4] as GroupManagementActionType;
      this.activeConversationMode.set(actorUserId, 'GROUP');
      return this.groupWorkflow.initiateGroupAction({
        adminId: actorUserId,
        sessionId,
        groupJid,
        action,
      });
    }
    if (callbackData === 'wf_grp:confirm_action') {
      this.activeConversationMode.set(actorUserId, 'NONE');
      return this.groupWorkflow.confirmGroupAction(actorUserId);
    }

    // 7: Join Group Workflow
    if (callbackData === 'menu:join_group') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'GROUP');
      return this.groupWorkflow.startJoinGroup(actorUserId);
    }
    if (callbackData.startsWith('wf_join:toggle_sess:')) {
      const sessId = callbackData.slice('wf_join:toggle_sess:'.length);
      return this.groupWorkflow.toggleJoinSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_join:select_all') {
      return this.groupWorkflow.selectAllJoinSessions(actorUserId);
    }
    if (callbackData === 'wf_join:clear_all') {
      return this.groupWorkflow.clearAllJoinSessions(actorUserId);
    }
    if (callbackData === 'wf_join:proceed_confirm') {
      return this.groupWorkflow.proceedJoinConfirmation(actorUserId);
    }
    if (callbackData === 'wf_join:confirm_execute') {
      this.activeConversationMode.set(actorUserId, 'NONE');
      return this.groupWorkflow.executeJoinGroup(actorUserId);
    }

    // 8: Task Monitor & Admin Controls
    if (callbackData === 'menu:admin') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.startHandler.renderAdminControls();
    }
    if (callbackData.startsWith('menu:tasks:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.tasksHandler.renderTaskMonitor(page, actorUserId, isOwner);
    }
    if (callbackData.startsWith('task:view:')) {
      const taskId = callbackData.slice('task:view:'.length);
      return this.tasksHandler.renderTaskDetail(taskId, actorUserId, isOwner);
    }
    if (callbackData.startsWith('task:cancel:')) {
      const taskId = callbackData.slice('task:cancel:'.length);
      return this.tasksHandler.handleCancelTask(taskId, actorUserId, isOwner);
    }

    // 9: Activity History
    if (callbackData.startsWith('menu:audit:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.tasksHandler.renderAuditHistory(page);
    }

    // 10: Settings, Cooldown & Subscriptions Management
    if (callbackData === 'menu:settings' || callbackData === '/controls') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.settingsHandler.renderSettings();
    }
    if (callbackData === 'settings:toggle_ratelimit') {
      return this.settingsHandler.toggleSetting('rate_limit_profile', actorUserId);
    }
    if (callbackData === 'settings:toggle_notify') {
      return this.settingsHandler.toggleSetting('notify_on_disconnect', actorUserId);
    }
    if (callbackData === 'settings:cycle_cooldown') {
      return this.settingsHandler.cycleCooldown(actorUserId);
    }
    if (callbackData === 'settings:prompt_cooldown') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'SETTINGS');
      return this.settingsHandler.promptCustomCooldown(actorUserId);
    }
    if (
      callbackData === 'settings:view_access' ||
      callbackData === 'menu:subscriptions'
    ) {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.settingsHandler.renderSubscriptionsMenu(1);
    }
    if (callbackData.startsWith('menu:subscriptions:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.settingsHandler.renderSubscriptionsMenu(page);
    }
    if (callbackData === 'sub:prompt_add') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'SETTINGS');
      return this.settingsHandler.promptAddSubscription(actorUserId);
    }
    if (callbackData === 'sub:prompt_add_group') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'SETTINGS');
      return this.settingsHandler.promptAddClaimGroup(actorUserId);
    }
    if (callbackData.startsWith('sub:confirm_remove:')) {
      const targetId = callbackData.slice('sub:confirm_remove:'.length);
      return this.settingsHandler.renderConfirmRemoveSubscription(targetId);
    }
    if (callbackData.startsWith('sub:remove:')) {
      const targetId = callbackData.slice('sub:remove:'.length);
      return this.settingsHandler.handleRemoveSubscription(targetId, actorUserId);
    }

    // 11: Help and System Status
    if (callbackData === 'menu:help_status' || callbackData === 'menu:help') {
      return this.startHandler.renderHelpAndSystemStatus({
        isAdmin: isOwner,
        actorUserId,
      });
    }

    // 12: Sender Management & Integrated Tools & Diagnostics
    if (callbackData === 'menu:senders' || callbackData === 'tools:ceksender') {
      return this.toolsHandler.renderSenderDiagnostics(1, actorUserId);
    }
    if (callbackData.startsWith('menu:senders:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.toolsHandler.renderSenderDiagnostics(page, actorUserId);
    }
    if (callbackData === 'menu:tools' || callbackData === '/tools') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.renderToolsMenu(isOwner);
    }
    if (callbackData === 'tools:prompt_testfunction') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptTestFunction(actorUserId);
    }
    if (callbackData === 'tools:tf_prompt_max') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptCustomMaxSends(actorUserId);
    }
    if (callbackData === 'tools:tf_prompt_delay') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptCustomDelay(actorUserId);
    }
    if (callbackData.startsWith('tools:tf_set_max:')) {
      const val = callbackData.slice('tools:tf_set_max:'.length);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.setMaxSendsConfig(actorUserId, val);
    }
    if (callbackData.startsWith('tools:tf_set_delay:')) {
      const val = callbackData.slice('tools:tf_set_delay:'.length);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.setDelayConfig(actorUserId, val);
    }
    if (callbackData === 'tools:tf_toggle_scope') {
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleScopeConfig(actorUserId);
    }
    if (callbackData === 'tools:tf_toggle_stop_on_error') {
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleStopOnErrorConfig(actorUserId);
    }
    if (callbackData === 'tools:tf_toggle_smart_wrap') {
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleSmartWrapConfig(actorUserId);
    }
    if (callbackData === 'tools:run_sample_testfunction') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      const fallbackMode =
        this.deps.sessionManager.listConnectedSessions(actorUserId).length === 0
          ? '--mode=SIMULATION'
          : '';
      return this.toolsHandler.executeTestFunction(
        actorUserId,
        `+966501234567 2 ${fallbackMode}`.trim(),
        DEFAULT_SAMPLE_TEST_FUNCTION
      );
    }
    if (callbackData === 'tools:flab_catalog') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.renderFunctionCatalog(actorUserId);
    }
    if (callbackData.startsWith('tools:flab_select:')) {
      const fnName = callbackData.slice('tools:flab_select:'.length);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.selectFunctionForAdmin(actorUserId, fnName);
    }
    if (callbackData.startsWith('tools:flab_dryrun:')) {
      const fnName = callbackData.slice('tools:flab_dryrun:'.length);
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.executeTestFunction(
        actorUserId,
        `+966501234567 1 ${fnName} --dry-run`
      );
    }
    if (callbackData.startsWith('tools:flab_mode:')) {
      const modeVal = callbackData
        .slice('tools:flab_mode:'.length)
        .toUpperCase() as 'LIVE' | 'DRY_RUN' | 'SIMULATION';
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.setExecutionModeForAdmin(actorUserId, modeVal);
    }
    if (
      callbackData === 'tools:flab_run_scenarios' ||
      callbackData === 'tools:flab_scenarios'
    ) {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.renderScenarioSuiteReport(actorUserId);
    }
    if (callbackData === 'tools:flab_capabilities') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.renderCapabilitiesMatrix();
    }
    if (
      callbackData === 'tools:flab_prompt_save' ||
      callbackData === 'tools:flab_save_last'
    ) {
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptSaveLastFunction(actorUserId);
    }
    if (callbackData === 'tools:flab_stop') {
      return this.toolsHandler.stopActiveFunction(actorUserId);
    }
    if (callbackData === 'tools:prompt_channel') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptChannelLookup(actorUserId);
    }
    if (callbackData === 'tools:prompt_ip') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptIpLookup(actorUserId);
    }
    if (callbackData === 'tools:prompt_shortlink') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'TOOLS');
      return this.toolsHandler.promptShortlink(actorUserId);
    }
    if (callbackData === 'tools:cekall') {
      return this.toolsHandler.renderCheckAllReport(actorUserId);
    }
    if (callbackData === 'tools:info') {
      return this.toolsHandler.renderUserInfo(actorUserId, isOwner);
    }
    if (callbackData === 'tools:gempa') {
      return this.toolsHandler.executeEarthquakeCheck();
    }

    return this.startHandler.renderMainMenu({
      isAdmin: isOwner,
      actorUserId,
    });
  }

  /**
   * Processes incoming text messages or commands after verifying the numeric Telegram admin ID.
   * Reuses and edits the active menu message whenever practical, and only routes non-command text
   * to a workflow when a workflow state is explicitly active.
   */
  /**
   * Dedicated first-class handler for Telegram /start and /menu commands.
   * Cancels any pending workflows, resets navigation history, and ALWAYS delivers
   * a fresh, prominent main-menu message at the current scroll position of the chat
   * (`preferEdit: false`), establishing the new active menu message anchor.
   */
  public async handleStartCommand(
    actorUserId: number,
    options?: HandleInteractionOptions
  ): Promise<BotViewResponse> {
    verifyTelegramAdmin({
      candidateUserId: actorUserId,
      configuredAdminId: this.deps.config.TELEGRAM_ADMIN_ID,
      actionDescription: 'command:start',
      auditRepo: this.deps.auditRepo,
      settingsRepo: this.deps.settingsRepo,
      chatId: options?.chatId,
    });

    this.cancelAllWorkflowsForAdmin(actorUserId);
    this.uiState.resetHome(actorUserId);

    const isOwner = this.isOwnerUser(actorUserId);
    const view = this.startHandler.renderMainMenu({
      isAdmin: isOwner,
      actorUserId,
    });

    return this.uiState.deliverView({
      userId: actorUserId,
      view,
      pendingWorkflow: 'NONE',
      preferEdit: false,
      transport: options?.transport,
    });
  }

  /**
   * Processes incoming media or code files uploaded from Telegram (`message:document`,
   * `message:photo`, `message:video`, `message:audio`, `message:voice`, `message:sticker`).
   */
  public async handleMediaUpload(
    actorUserId: number,
    upload: IncomingTelegramMediaUpload,
    options?: HandleInteractionOptions
  ): Promise<BotViewResponse> {
    verifyTelegramAdmin({
      candidateUserId: actorUserId,
      configuredAdminId: this.deps.config.TELEGRAM_ADMIN_ID,
      actionDescription: `upload:${upload.originalFilename.slice(0, 24)}`,
      auditRepo: this.deps.auditRepo,
      settingsRepo: this.deps.settingsRepo,
      chatId: options?.chatId,
    });

    const mode = this.getConversationMode(actorUserId);
    const caption = (upload.caption || '').trim();
    const lowerName = upload.originalFilename.toLowerCase();
    const isCodeExtension =
      lowerName.endsWith('.js') ||
      lowerName.endsWith('.ts') ||
      lowerName.endsWith('.mjs') ||
      lowerName.endsWith('.cjs') ||
      lowerName.endsWith('.txt');
    const isFunctionLabCaption =
      /^\/(?:testfunction|savefunction)\b/i.test(caption);

    let view: BotViewResponse;

    if (
      (mode === 'TOOLS' && isCodeExtension) ||
      (isFunctionLabCaption && isCodeExtension)
    ) {
      const codeText = upload.contentBuffer.toString('utf8');
      view = await this.toolsHandler.handleCodeFileUpload(actorUserId, {
        fileName: upload.originalFilename,
        codeText,
        caption: upload.caption,
      });
      this.activeConversationMode.set(actorUserId, 'TOOLS');
    } else {
      const mediaState = this.mediaWorkflow.getState(actorUserId);
      if (mode === 'MEDIA' && mediaState?.step === 'AWAITING_FILE') {
        view = this.mediaWorkflow.handleFileUpload(actorUserId, upload);
      } else if (caption) {
        // Allow quick media upload if caption starts with a phone number or JID
        const tokens = caption.split(/\s+/);
        const firstToken = tokens[0] || '';
        if (/^(?:\+?\d{8,15}|\d+@g\.us|\d+@s\.whatsapp\.net)$/.test(firstToken)) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'MEDIA');
          this.mediaWorkflow.start(actorUserId);
          const recView = this.mediaWorkflow.handleRecipientInput(
            actorUserId,
            firstToken
          );
          if (this.mediaWorkflow.getState(actorUserId)?.step === 'AWAITING_FILE') {
            view = this.mediaWorkflow.handleFileUpload(actorUserId, {
              ...upload,
              caption: tokens.slice(1).join(' ') || undefined,
            });
          } else {
            view = recView;
          }
        } else {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'MEDIA');
          view = this.mediaWorkflow.start(actorUserId);
        }
      } else {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        this.activeConversationMode.set(actorUserId, 'MEDIA');
        view = this.mediaWorkflow.start(actorUserId);
      }
    }

    const sess = this.uiState.getOrCreateSession(actorUserId);
    const preferEdit = sess.activeMessageId !== undefined;

    return this.uiState.deliverView({
      userId: actorUserId,
      view,
      pendingWorkflow: this.getConversationMode(actorUserId),
      preferEdit,
      transport: options?.transport,
    });
  }

  /**
   * Processes incoming text messages or commands after verifying the numeric Telegram admin ID.
   * Reuses and edits the active menu message whenever practical, and only routes non-command text
   * to a workflow when a workflow state is explicitly active.
   */
  public async handleTextMessage(
    actorUserId: number,
    text: string,
    repliedText?: string,
    options?: HandleInteractionOptions
  ): Promise<BotViewResponse> {
    verifyTelegramAdmin({
      candidateUserId: actorUserId,
      configuredAdminId: this.deps.config.TELEGRAM_ADMIN_ID,
      actionDescription: `text:${text.slice(0, 24)}`,
      auditRepo: this.deps.auditRepo,
      settingsRepo: this.deps.settingsRepo,
      chatId: options?.chatId,
    });

    const trimmed = text.trim();
    // Fast-path /start and /menu commands (with optional @bot and payload)
    if (/^\/(?:start|menu)(?:@\w+)?(?:\s+.*)?$/i.test(trimmed)) {
      return this.handleStartCommand(actorUserId, options);
    }

    const view = await this.routeTextMessageInternal(
      actorUserId,
      text,
      repliedText
    );
    const sess = this.uiState.getOrCreateSession(actorUserId);
    const preferEdit = sess.activeMessageId !== undefined;

    return this.uiState.deliverView({
      userId: actorUserId,
      view,
      pendingWorkflow: this.getConversationMode(actorUserId),
      preferEdit,
      transport: options?.transport,
    });
  }

  private async routeTextMessageInternal(
    actorUserId: number,
    text: string,
    repliedText?: string
  ): Promise<BotViewResponse> {
    const trimmed = text.trim();
    const parts = trimmed.split(/\s+/);
    const rawCommand = parts[0].toLowerCase();
    const command = rawCommand.replace(/@\w+$/, '');
    const args = parts.slice(1);

    const isOwner = this.isOwnerUser(actorUserId);

    if (command === '/start' || command === '/menu') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.uiState.resetHome(actorUserId);
      return this.startHandler.renderMainMenu({
        isAdmin: isOwner,
        actorUserId,
      });
    }
    if (command === '/status' || command === '/help') {
      this.uiState.recordRouteTransition(actorUserId, 'menu:help_status');
      return this.startHandler.renderHelpAndSystemStatus({
        isAdmin: isOwner,
        actorUserId,
      });
    }
    if (command === '/cancel') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.uiState.resetHome(actorUserId);
      return this.startHandler.renderMainMenu({
        isAdmin: isOwner,
        actorUserId,
        noticeBanner: '✅ *تم إلغاء العملية الجارية والعودة للقائمة الرئيسية.*',
      });
    }

    // Check command cooldown if text starts with '/' (except /setcooldown so admin can always adjust it)
    if (trimmed.startsWith('/')) {
      if (command !== '/setcooldown') {
        try {
          this.deps.settingsRepo.checkUserCooldown(actorUserId);
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text: safeErr.userMessage,
            keyboard: [
              buildAppNavigationRow({
                backCallback: 'nav:back',
                refreshCallback: 'nav:refresh',
              }),
            ],
          };
        }
      }

      if (command === '/controls' || command === '/settings') {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        this.uiState.recordRouteTransition(actorUserId, 'menu:settings');
        return this.settingsHandler.renderSettings();
      }

      if (command === '/admin') {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        this.uiState.recordRouteTransition(actorUserId, 'menu:admin');
        return this.startHandler.renderAdminControls();
      }

      if (command === '/sessions') {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        this.uiState.recordRouteTransition(actorUserId, 'menu:sessions:page:1');
        return this.sessionsHandler.renderSessionsList(1, actorUserId);
      }

      if (command === '/tools') {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        this.uiState.recordRouteTransition(actorUserId, 'menu:tools');
        return this.toolsHandler.renderToolsMenu(isOwner);
      }

      if (command === '/ceksender') {
        this.uiState.recordRouteTransition(actorUserId, 'menu:senders:page:1');
        return this.toolsHandler.renderSenderDiagnostics(1, actorUserId);
      }

      if (command === '/cekall') {
        this.uiState.recordRouteTransition(actorUserId, 'tools:cekall');
        return this.toolsHandler.renderCheckAllReport(actorUserId);
      }

      if (command === '/info' || command === '/cekprem') {
        this.uiState.recordRouteTransition(actorUserId, 'tools:info');
        return this.toolsHandler.renderUserInfo(actorUserId, isOwner);
      }

      if (command === '/gempa') {
        this.uiState.recordRouteTransition(actorUserId, 'tools:gempa');
        return this.toolsHandler.executeEarthquakeCheck();
      }

      if (command === '/cekidch') {
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptChannelLookup(actorUserId);
        }
        return this.toolsHandler.executeChannelLookup(actorUserId, args.join(' '));
      }

      if (command === '/trackip') {
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptIpLookup(actorUserId);
        }
        return this.toolsHandler.executeIpLookup(actorUserId, args[0]);
      }

      if (command === '/shortlink') {
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptShortlink(actorUserId);
        }
        return this.toolsHandler.executeShortlink(actorUserId, args.join(' '));
      }

      if (command === '/testfunction') {
        const rawArgsAfterCommand = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgsAfterCommand) {
          if (repliedText || this.toolsHandler.getSelectedFunction(actorUserId)) {
            return this.toolsHandler.executeTestFunction(
              actorUserId,
              '',
              repliedText
            );
          }
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptTestFunction(actorUserId);
        }
        return this.toolsHandler.executeTestFunction(
          actorUserId,
          rawArgsAfterCommand,
          repliedText
        );
      }

      if (command === '/savefunction') {
        const rawArgsAfterCommand = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgsAfterCommand && !repliedText) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptSaveLastFunction(actorUserId);
        }
        this.activeConversationMode.set(actorUserId, 'TOOLS');
        return this.toolsHandler.saveCustomFunction(
          actorUserId,
          rawArgsAfterCommand,
          repliedText
        );
      }

      if (command === '/stopfunction') {
        return this.toolsHandler.stopActiveFunction(actorUserId);
      }

      if (command === '/settfmax') {
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptCustomMaxSends(actorUserId);
        }
        this.activeConversationMode.set(actorUserId, 'TOOLS');
        return this.toolsHandler.setMaxSendsConfig(actorUserId, args[0]);
      }

      if (command === '/settfdelay') {
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptCustomDelay(actorUserId);
        }
        this.activeConversationMode.set(actorUserId, 'TOOLS');
        return this.toolsHandler.setDelayConfig(actorUserId, args[0]);
      }

      if (command === '/settfscope') {
        if (args.length === 0) {
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.toggleScopeConfig(actorUserId);
        }
        this.activeConversationMode.set(actorUserId, 'TOOLS');
        return this.toolsHandler.setScopeConfig(actorUserId, args[0]);
      }

      // Direct pairing commands: /requestpair <phone> [custom8] or /addsender <phone> [custom8]
      if (command === '/requestpair' || command === '/addsender') {
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'PAIRING');
          return this.pairingWorkflow.startNewLinking(actorUserId);
        }
        try {
          const result = await this.deps.sessionManager.initiatePairing({
            rawPhoneNumber: args.join(' '),
            actorTelegramId: actorUserId,
          });
          return {
            text:
              `✅ *تم توليد رمز الربط السريع (${command}):* ${formatSessionStatusArabic(result.session.status)}\n\n` +
              `🆔 معرف الجلسة: \`${result.session.id}\`\n` +
              `📱 الرقم المقترن: \`${result.maskedPhone}\`\n` +
              `🔑 رمز الربط (Pairing Code): \`${result.pairingCode}\`\n\n` +
              `📌 *خطوات الإدخال في تطبيق واتساب:*\n${result.instructionsArabic}`,
            keyboard: [
              [
                {
                  text: '📋 عرض تفاصيل الجلسة',
                  callbackData: `sess:view:${result.session.id}`,
                },
                { text: '📱 فحص المقابس', callbackData: 'tools:ceksender' },
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
            text: `⚠️ *تعذر تنفيذ ${command}:*\n${safeErr.userMessage}`,
            keyboard: [buildBackCancelRow('menu:main')],
          };
        }
      }

      // Safe session reset command: /resetsession [sessionId]
      if (command === '/resetsession') {
        try {
          if (args[0]) {
            await this.deps.sessionManager.removeSession(args[0], actorUserId);
            return {
              text: `✅ *تم حذف الجلسة ومجلد مصادقتها بنجاح:* \`${args[0]}\``,
              keyboard: [
                [{ text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' }],
                buildAppNavigationRow({
                  backCallback: 'menu:sessions:page:1',
                  refreshCallback: 'menu:sessions:page:1',
                }),
              ],
            };
          }
          return this.sessionsHandler.handlePurgeInactive(actorUserId);
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text: `⚠️ *تعذر إعادة تعيين الجلسة:*\n${safeErr.userMessage}`,
            keyboard: [buildBackCancelRow('menu:sessions:page:1')],
          };
        }
      }

      // Cooldown configuration: /setcooldown <seconds>
      if (command === '/setcooldown') {
        try {
          const seconds = Number(args[0]);
          const updated = this.deps.settingsRepo.setCooldownSeconds(seconds);
          this.deps.auditRepo.record({
            actorTelegramId: actorUserId,
            action: 'COOLDOWN_UPDATED',
            targetId: 'command_cooldown_seconds',
            outcome: 'SUCCESS',
            metadata: { cooldownSeconds: updated },
          });
          return {
            text: `✅ *تم ضبط مهلة التهدئة (Cooldown) على:* \`${updated} ثانية\``,
            keyboard: [
              [{ text: '⚙️ الإعدادات', callbackData: 'menu:settings' }],
              buildAppNavigationRow({
                backCallback: 'menu:settings',
                refreshCallback: 'menu:settings',
              }),
            ],
          };
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text: `⚠️ ${safeErr.userMessage}`,
            keyboard: [buildBackCancelRow('menu:settings')],
          };
        }
      }

      // Premium user & group commands: /addpremium, /delpremium, /addgcpremium, /delgcpremium
      if (
        command === '/addpremium' ||
        command === '/addprem' ||
        command === '/addgcpremium'
      ) {
        try {
          const targetId = args[0] || '';
          const daysRaw = (args[1] || '').replace(/d$/i, '');
          const durationDays = Number(daysRaw);
          const targetType = command === '/addgcpremium' ? 'GROUP' : 'USER';
          const entry = this.deps.settingsRepo.addPremiumSubscription(
            targetId,
            durationDays,
            targetType
          );
          this.deps.auditRepo.record({
            actorTelegramId: actorUserId,
            action: 'PREMIUM_ADDED',
            targetId: entry.targetId,
            outcome: 'SUCCESS',
            metadata: { targetType, durationDays: entry.durationDays },
          });
          return {
            text:
              `✅ *تم تفعيل الاشتراك (${targetType}) بنجاح!*\n` +
              `🆔 المعرف: \`${entry.targetId}\`\n` +
              `📅 صالح حتى: \`${entry.expiresAtIso.slice(0, 10)}\` (${entry.durationDays} يوم)`,
            keyboard: [
              [
                {
                  text: '⭐ عرض الاشتراكات',
                  callbackData: 'menu:subscriptions:page:1',
                },
              ],
              buildAppNavigationRow({
                backCallback: 'menu:subscriptions:page:1',
                refreshCallback: 'menu:subscriptions:page:1',
              }),
            ],
          };
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text:
              `⚠️ *تعذر إضافة الاشتراك:*\n${safeErr.userMessage}\n` +
              `الصيغة: \`${command} 123456789 30\``,
            keyboard: [buildBackCancelRow('menu:subscriptions:page:1')],
          };
        }
      }

      if (
        command === '/delpremium' ||
        command === '/delprem' ||
        command === '/delgcpremium'
      ) {
        const targetId = args[0] || '';
        const removed = this.deps.settingsRepo.removePremiumSubscription(targetId);
        return {
          text: removed
            ? `✅ *تم إلغاء اشتراك المعرف:* \`${targetId}\``
            : `ℹ️ المعرف \`${targetId || '—'}\` غير موجود في قائمة الاشتراكات النشطة.`,
          keyboard: [
            [
              {
                text: '⭐ عرض الاشتراكات',
                callbackData: 'menu:subscriptions:page:1',
              },
            ],
            buildAppNavigationRow({
              backCallback: 'menu:subscriptions:page:1',
              refreshCallback: 'menu:subscriptions:page:1',
            }),
          ],
        };
      }

      if (command === '/listprem') {
        return this.settingsHandler.renderSubscriptionsMenu(1);
      }

      // Claim groups commands: /addgb, /delgb, /listgb, /claim
      if (command === '/addgb') {
        try {
          const groupId = args[0] || '';
          const title = args.slice(1).join(' ') || undefined;
          const entry = this.deps.settingsRepo.addClaimGroup(groupId, title);
          return {
            text:
              `✅ *تمت إضافة مجموعة التفعيل بنجاح!*\n` +
              `📛 الاسم: ${entry.title}\n` +
              `🆔 المعرف: \`${entry.groupId}\``,
            keyboard: [
              [
                {
                  text: '⭐ إدارة الاشتراكات',
                  callbackData: 'menu:subscriptions:page:1',
                },
              ],
              buildAppNavigationRow({
                backCallback: 'menu:subscriptions:page:1',
                refreshCallback: 'menu:subscriptions:page:1',
              }),
            ],
          };
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text: `⚠️ ${safeErr.userMessage}`,
            keyboard: [buildBackCancelRow('menu:subscriptions:page:1')],
          };
        }
      }

      if (command === '/delgb') {
        const groupId = args[0] || '';
        const removed = this.deps.settingsRepo.removeClaimGroup(groupId);
        return {
          text: removed
            ? `✅ *تم حذف مجموعة التفعيل:* \`${groupId}\``
            : `ℹ️ المجموعة \`${groupId || '—'}\` غير مسجلة في القائمة.`,
          keyboard: [
            [
              {
                text: '⭐ إدارة الاشتراكات',
                callbackData: 'menu:subscriptions:page:1',
              },
            ],
            buildAppNavigationRow({
              backCallback: 'menu:subscriptions:page:1',
              refreshCallback: 'menu:subscriptions:page:1',
            }),
          ],
        };
      }

      if (command === '/listgb') {
        return this.settingsHandler.renderSubscriptionsMenu(1);
      }

      if (command === '/claim') {
        const entry = this.deps.settingsRepo.addPremiumSubscription(
          String(actorUserId),
          30,
          'USER'
        );
        return {
          text:
            `🎉 *تم تفعيل اشتراكك لمدة 30 يوماً بنجاح!*\n` +
            `🆔 المعرف: \`${entry.targetId}\`\n` +
            `📅 تاريخ الانتهاء: \`${entry.expiresAtIso.slice(0, 10)}\``,
          keyboard: [
            [{ text: '🪪 بطاقة الحساب (/info)', callbackData: 'tools:info' }],
            buildAppNavigationRow({
              backCallback: 'menu:main',
              refreshCallback: 'tools:info',
            }),
          ],
        };
      }
    }

    const mode = this.getConversationMode(actorUserId);

    if (mode === 'PAIRING') {
      const res = await this.pairingWorkflow.handlePhoneInput(actorUserId, trimmed);
      if (!this.pairingWorkflow.getState(actorUserId)) {
        this.activeConversationMode.set(actorUserId, 'NONE');
      }
      return res;
    }

    if (mode === 'MESSAGE') {
      return this.messageWorkflow.handleTextInput(actorUserId, trimmed);
    }

    if (mode === 'MEDIA') {
      const state = this.mediaWorkflow.getState(actorUserId);
      if (state?.step === 'AWAITING_RECIPIENT') {
        return this.mediaWorkflow.handleRecipientInput(actorUserId, trimmed);
      }
    }

    if (mode === 'GROUP') {
      const state = this.groupWorkflow.getState(actorUserId);
      if (state?.mode === 'JOIN_GROUP' && state.step === 'AWAITING_LINK') {
        return this.groupWorkflow.handleJoinLinkInput(actorUserId, trimmed);
      }
      if (
        state?.mode === 'MANAGE_GROUP' &&
        state.step === 'AWAITING_PARTICIPANT_PHONE'
      ) {
        return this.groupWorkflow.handleParticipantPhoneInput(actorUserId, trimmed);
      }
    }

    if (mode === 'TOOLS') {
      const response = await this.toolsHandler.handleGuidedInput(
        actorUserId,
        trimmed,
        repliedText
      );
      const nextStep = this.toolsHandler.getStep(actorUserId);
      this.activeConversationMode.set(
        actorUserId,
        nextStep === 'NONE' ? 'NONE' : 'TOOLS'
      );
      return response;
    }

    if (mode === 'SETTINGS') {
      const response = this.settingsHandler.handleGuidedInput(
        actorUserId,
        trimmed
      );
      const nextStep = this.settingsHandler.getStep(actorUserId);
      this.activeConversationMode.set(
        actorUserId,
        nextStep === 'NONE' ? 'NONE' : 'SETTINGS'
      );
      return response;
    }

    // Requirement 3: Do not interpret arbitrary messages as workflow inputs unless a workflow state is active.
    return this.startHandler.renderMainMenu({
      isAdmin: isOwner,
      actorUserId,
      noticeBanner:
        'ℹ️ *لا توجد عملية إدخال نصي نشطة حالياً.*\nيرجى اختيار العملية المطلوبة من الأزرار التفاعلية أدناه أو إرسال أمر مباشر يبدأ بـ `/`.',
    });
  }
}

/**
 * Builds a production grammY Bot instance wired to the stateful TelegramBotController.
 * Uses `editMessageText` and `editMessageReplyMarkup` to update the active menu message
 * in-place rather than sending a new message on every button press.
 */
export function createGrammyBot(
  controller: TelegramBotController,
  config: AppConfig,
  auditRepo: AuditRepository
): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Strict administrator & active subscription allowlist middleware on all updates
  bot.use(
    createGrammyAuthorizationMiddleware(
      config.TELEGRAM_ADMIN_ID,
      auditRepo,
      controller['deps'].settingsRepo
    )
  );

  const downloadTelegramFileBuffer = async (fileId: string): Promise<Buffer> => {
    const fileInfo = await bot.api.getFile(fileId);
    if (!fileInfo.file_path) {
      throw new Error('تعذر الحصول على مسار الملف من خادم تيليجرام.');
    }
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`فشل تحميل الملف من خادم تيليجرام (HTTP ${res.status}).`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.from) return;
    try {
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleCallbackQuery(
        ctx.from.id,
        ctx.callbackQuery.data,
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      log.error('Telegram callback error', {
        category: safeErr.category,
        error: safeErr.sanitizedTechnicalMessage,
      });
      try {
        await ctx.answerCallbackQuery({
          text: safeErr.userMessage,
          show_alert: true,
        });
      } catch {
        // Ignore if callback query was already answered
      }
    }
  });

  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    try {
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleStartCommand(ctx.from.id, {
        transport,
        chatId: ctx.chat?.id,
      });
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      log.error('Telegram start command error', {
        category: safeErr.category,
        error: safeErr.sanitizedTechnicalMessage,
      });
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.command('menu', async (ctx) => {
    if (!ctx.from) return;
    try {
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleStartCommand(ctx.from.id, {
        transport,
        chatId: ctx.chat?.id,
      });
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      log.error('Telegram menu command error', {
        category: safeErr.category,
        error: safeErr.sanitizedTechnicalMessage,
      });
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (!ctx.from) return;
    try {
      const repliedText =
        ctx.message.reply_to_message?.text ||
        ctx.message.reply_to_message?.caption ||
        undefined;
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleTextMessage(
        ctx.from.id,
        ctx.message.text,
        repliedText,
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      log.error('Telegram text message error', {
        category: safeErr.category,
        error: safeErr.sanitizedTechnicalMessage,
      });
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:document', async (ctx) => {
    if (!ctx.from || !ctx.message.document) return;
    try {
      const doc = ctx.message.document;
      const buffer = await downloadTelegramFileBuffer(doc.file_id);
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: doc.file_name || `document_${Date.now()}.bin`,
          mimeType: doc.mime_type || 'application/octet-stream',
          sizeBytes: doc.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:photo', async (ctx) => {
    if (!ctx.from || !ctx.message.photo || ctx.message.photo.length === 0) return;
    try {
      const highestRes = ctx.message.photo[ctx.message.photo.length - 1];
      const buffer = await downloadTelegramFileBuffer(highestRes.file_id);
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: `photo_${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: highestRes.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:video', async (ctx) => {
    if (!ctx.from || !ctx.message.video) return;
    try {
      const vid = ctx.message.video;
      const buffer = await downloadTelegramFileBuffer(vid.file_id);
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: vid.file_name || `video_${Date.now()}.mp4`,
          mimeType: vid.mime_type || 'video/mp4',
          sizeBytes: vid.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:audio', async (ctx) => {
    if (!ctx.from || !ctx.message.audio) return;
    try {
      const aud = ctx.message.audio;
      const buffer = await downloadTelegramFileBuffer(aud.file_id);
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: aud.file_name || `audio_${Date.now()}.mp3`,
          mimeType: aud.mime_type || 'audio/mpeg',
          sizeBytes: aud.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:voice', async (ctx) => {
    if (!ctx.from || !ctx.message.voice) return;
    try {
      const voice = ctx.message.voice;
      const buffer = await downloadTelegramFileBuffer(voice.file_id);
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: `voice_${Date.now()}.ogg`,
          mimeType: voice.mime_type || 'audio/ogg',
          sizeBytes: voice.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.on('message:sticker', async (ctx) => {
    if (!ctx.from || !ctx.message.sticker) return;
    try {
      const stk = ctx.message.sticker;
      const buffer = await downloadTelegramFileBuffer(stk.file_id);
      const transport = createGrammyTransport(
        ctx as unknown as Parameters<typeof createGrammyTransport>[0],
        controller.uiState,
        ctx.from.id
      );
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: `sticker_${Date.now()}.webp`,
          mimeType: 'image/webp',
          sizeBytes: stk.file_size || buffer.length,
          contentBuffer: buffer,
        },
        { transport, chatId: ctx.chat?.id }
      );
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      await ctx.reply(safeErr.userMessage);
    }
  });

  bot.catch((err) => {
    const safeErr = toSafeArabicError(err.error);
    log.error('Unhandled grammY bot error', {
      category: safeErr.category,
      error: safeErr.sanitizedTechnicalMessage,
    });
  });

  return bot;
}
