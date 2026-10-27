import { Bot } from 'grammy';
import { AppConfig } from '../config/env';
import {
  verifyTelegramAdmin,
  createGrammyAuthorizationMiddleware,
} from './middleware/authorization';
import { toGrammyInlineKeyboard, buildBackCancelRow } from './keyboards/main-menu';
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

export interface TelegramControllerDeps {
  config: AppConfig;
  sessionManager: SessionManager;
  taskManager: TaskManager;
  sendMessageOp: SendMessageOperation;
  sendMediaOp: SendMediaOperation;
  groupOps: GroupOperations;
  auditRepo: AuditRepository;
  settingsRepo: SettingsRepository;
}

/**
 * Unified Telegram Bot Controller.
 * Used identically by the live grammY Bot instance and by automated integration tests / web harness.
 */
export class TelegramBotController {
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

  private activeConversationMode = new Map<
    number,
    'NONE' | 'PAIRING' | 'MESSAGE' | 'MEDIA' | 'GROUP' | 'TOOLS'
  >();

  constructor(private readonly deps: TelegramControllerDeps) {
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

  private cancelAllWorkflowsForAdmin(adminId: number): void {
    this.pairingWorkflow.cancel(adminId);
    this.messageWorkflow.cancel(adminId);
    this.mediaWorkflow.cancel(adminId);
    this.groupWorkflow.cancel(adminId);
    this.toolsHandler.cancel(adminId);
    this.activeConversationMode.set(adminId, 'NONE');
  }

  /**
   * Processes any incoming callback query after verifying the numeric Telegram admin ID.
   */
  public async handleCallbackQuery(
    actorUserId: number,
    callbackData: string
  ): Promise<BotViewResponse> {
    verifyTelegramAdmin({
      candidateUserId: actorUserId,
      configuredAdminId: this.deps.config.TELEGRAM_ADMIN_ID,
      actionDescription: `callback:${callbackData}`,
      auditRepo: this.deps.auditRepo,
    });

    if (
      callbackData === 'menu:main' ||
      callbackData === 'workflow:cancel' ||
      callbackData === '/start'
    ) {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.startHandler.renderMainMenu();
    }

    // 1 & 2: Link WhatsApp Account / Add Another Account
    if (
      callbackData === 'menu:link_account' ||
      callbackData === 'menu:add_account'
    ) {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      this.activeConversationMode.set(actorUserId, 'PAIRING');
      return this.pairingWorkflow.startNewLinking(actorUserId);
    }

    // 3: Manage Sessions
    if (callbackData.startsWith('menu:sessions:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.sessionsHandler.renderSessionsList(page);
    }
    if (callbackData.startsWith('sess:refresh:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.sessionsHandler.renderSessionsList(page);
    }
    if (callbackData.startsWith('sess:view:')) {
      const sessionId = callbackData.slice('sess:view:'.length);
      return this.sessionsHandler.renderSessionDetail(sessionId);
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
      return this.sessionsHandler.renderConfirmRemove(sessionId);
    }
    if (callbackData.startsWith('sess:remove:')) {
      const sessionId = callbackData.slice('sess:remove:'.length);
      return this.sessionsHandler.handleRemove(sessionId, actorUserId);
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
      return this.groupsHandler.renderGroupManagementSubmenu();
    }
    if (callbackData.startsWith('grp:list:')) {
      const sessionId = callbackData.slice('grp:list:'.length);
      return this.groupsHandler.renderSessionGroups(sessionId);
    }
    if (callbackData.startsWith('grp:view:')) {
      const parts = callbackData.split(':');
      const sessionId = parts[2];
      const groupJid = parts.slice(3).join(':');
      return this.groupWorkflow.renderGroupDetails(sessionId, groupJid);
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

    // 8: Task Monitor
    if (callbackData.startsWith('menu:tasks:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.tasksHandler.renderTaskMonitor(page);
    }
    if (callbackData.startsWith('task:view:')) {
      const taskId = callbackData.slice('task:view:'.length);
      return this.tasksHandler.renderTaskDetail(taskId);
    }
    if (callbackData.startsWith('task:cancel:')) {
      const taskId = callbackData.slice('task:cancel:'.length);
      return this.tasksHandler.handleCancelTask(taskId, actorUserId);
    }

    // 9: Activity History
    if (callbackData.startsWith('menu:audit:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      return this.tasksHandler.renderAuditHistory(page);
    }

    // 10: Settings & Access Control (including Nebula Cooldown & Subscriptions)
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
    if (callbackData === 'settings:view_access') {
      return this.settingsHandler.renderAccessControlSummary();
    }

    // 11: Help and System Status
    if (callbackData === 'menu:help_status') {
      return this.startHandler.renderHelpAndSystemStatus();
    }

    // 12: Integrated Tools & Diagnostics (extracted from Nebula bot)
    if (callbackData === 'menu:tools' || callbackData === '/tools') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.renderToolsMenu();
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
    if (callbackData === 'tools:run_sample_testfunction') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.toolsHandler.executeTestFunction(
        actorUserId,
        '+966501234567 2',
        DEFAULT_SAMPLE_TEST_FUNCTION
      );
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
    if (callbackData === 'tools:ceksender') {
      return this.toolsHandler.renderSenderDiagnostics();
    }
    if (callbackData === 'tools:cekall') {
      return this.toolsHandler.renderCheckAllReport(actorUserId);
    }
    if (callbackData === 'tools:info') {
      return this.toolsHandler.renderUserInfo(actorUserId);
    }
    if (callbackData === 'tools:gempa') {
      return this.toolsHandler.executeEarthquakeCheck();
    }

    return this.startHandler.renderMainMenu();
  }

  /**
   * Processes incoming text messages or commands after verifying the numeric Telegram admin ID.
   */
  public async handleTextMessage(
    actorUserId: number,
    text: string,
    repliedText?: string
  ): Promise<BotViewResponse> {
    verifyTelegramAdmin({
      candidateUserId: actorUserId,
      configuredAdminId: this.deps.config.TELEGRAM_ADMIN_ID,
      actionDescription: `text:${text.slice(0, 24)}`,
      auditRepo: this.deps.auditRepo,
    });

    const trimmed = text.trim();
    if (trimmed === '/start' || trimmed === '/menu') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.startHandler.renderMainMenu();
    }
    if (trimmed === '/status' || trimmed === '/help') {
      return this.startHandler.renderHelpAndSystemStatus();
    }
    if (trimmed === '/cancel') {
      this.cancelAllWorkflowsForAdmin(actorUserId);
      return this.startHandler.renderMainMenu();
    }

    // Check command cooldown if text starts with '/' (except /setcooldown so admin can always adjust it)
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (command !== '/setcooldown') {
        try {
          this.deps.settingsRepo.checkUserCooldown(actorUserId);
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text: safeErr.userMessage,
            keyboard: [[{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]],
          };
        }
      }

      if (command === '/controls') {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        return this.settingsHandler.renderSettings();
      }

      if (command === '/tools') {
        this.cancelAllWorkflowsForAdmin(actorUserId);
        return this.toolsHandler.renderToolsMenu();
      }

      if (command === '/ceksender') {
        return this.toolsHandler.renderSenderDiagnostics();
      }

      if (command === '/cekall') {
        return this.toolsHandler.renderCheckAllReport(actorUserId);
      }

      if (command === '/info' || command === '/cekprem') {
        return this.toolsHandler.renderUserInfo(actorUserId);
      }

      if (command === '/gempa') {
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
        if (args.length === 0) {
          this.cancelAllWorkflowsForAdmin(actorUserId);
          this.activeConversationMode.set(actorUserId, 'TOOLS');
          return this.toolsHandler.promptTestFunction(actorUserId);
        }
        return this.toolsHandler.executeTestFunction(
          actorUserId,
          args.join(' '),
          repliedText
        );
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
          const session = this.deps.sessionManager.createSession(undefined, actorUserId);
          const result = await this.deps.sessionManager.initiatePairing({
            sessionId: session.id,
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
              [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
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
                [
                  { text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' },
                  { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
                ],
              ],
            };
          }
          // If no sessionId passed, purge disconnected / logged-out / failed sessions
          const allSessions = this.deps.sessionManager.listSessions();
          const inactive = allSessions.filter(
            (s) => s.status !== 'CONNECTED' && s.status !== 'AUTHENTICATED'
          );
          for (const sess of inactive) {
            await this.deps.sessionManager.removeSession(sess.id, actorUserId);
          }
          return {
            text:
              inactive.length > 0
                ? `✅ *تم تنظيف وإعادة تعيين ${inactive.length} جلسة غير متصلة بنجاح دون إيقاف الخادم.*`
                : `ℹ️ جميع الجلسات الحالية (${allSessions.length}) متصلة ونشطة. لحذف جلسة محددة استخدم \`/resetsession <sessionId>\`.`,
            keyboard: [
              [
                { text: '📋 إدارة الجلسات', callbackData: 'menu:sessions:page:1' },
                { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
              ],
            ],
          };
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
              [
                { text: '⚙️ الإعدادات', callbackData: 'menu:settings' },
                { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
              ],
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
      if (command === '/addpremium' || command === '/addgcpremium') {
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
                { text: '⭐ عرض الاشتراكات', callbackData: 'settings:view_access' },
                { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
              ],
            ],
          };
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text:
              `⚠️ *تعذر إضافة الاشتراك:*\n${safeErr.userMessage}\n` +
              `الصيغة: \`${command} 123456789 30\``,
            keyboard: [buildBackCancelRow('settings:view_access')],
          };
        }
      }

      if (command === '/delpremium' || command === '/delgcpremium') {
        const targetId = args[0] || '';
        const removed = this.deps.settingsRepo.removePremiumSubscription(targetId);
        return {
          text: removed
            ? `✅ *تم إلغاء اشتراك المعرف:* \`${targetId}\``
            : `ℹ️ المعرف \`${targetId || '—'}\` غير موجود في قائمة الاشتراكات النشطة.`,
          keyboard: [
            [
              { text: '⭐ عرض الاشتراكات', callbackData: 'settings:view_access' },
              { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
            ],
          ],
        };
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
                { text: '⭐ إدارة الاشتراكات', callbackData: 'settings:view_access' },
                { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
              ],
            ],
          };
        } catch (err) {
          const safeErr = toSafeArabicError(err);
          return {
            text: `⚠️ ${safeErr.userMessage}`,
            keyboard: [buildBackCancelRow('settings:view_access')],
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
              { text: '⭐ إدارة الاشتراكات', callbackData: 'settings:view_access' },
              { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
            ],
          ],
        };
      }

      if (command === '/listgb') {
        return this.settingsHandler.renderAccessControlSummary();
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
            [
              { text: '🪪 بطاقة الحساب (/info)', callbackData: 'tools:info' },
              { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
            ],
          ],
        };
      }
    }

    const mode = this.activeConversationMode.get(actorUserId) || 'NONE';

    if (mode === 'PAIRING') {
      return this.pairingWorkflow.handlePhoneInput(actorUserId, trimmed);
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

    return this.startHandler.renderMainMenu();
  }
}

/**
 * Builds a production grammY Bot instance wired to the TelegramBotController.
 */
export function createGrammyBot(
  controller: TelegramBotController,
  config: AppConfig,
  auditRepo: AuditRepository
): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Strict administrator allowlist middleware on all updates
  bot.use(createGrammyAuthorizationMiddleware(config.TELEGRAM_ADMIN_ID, auditRepo));

  bot.on('callback_query:data', async (ctx) => {
    try {
      const view = await controller.handleCallbackQuery(
        ctx.from.id,
        ctx.callbackQuery.data
      );
      await ctx.answerCallbackQuery();
      await ctx.reply(view.text, {
        parse_mode: 'Markdown',
        reply_markup: toGrammyInlineKeyboard(view.keyboard),
      });
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      log.error('Telegram callback error', {
        category: safeErr.category,
        error: safeErr.sanitizedTechnicalMessage,
      });
      await ctx.answerCallbackQuery({
        text: safeErr.userMessage,
        show_alert: true,
      });
    }
  });

  bot.on('message:text', async (ctx) => {
    try {
      const repliedText =
        ctx.message.reply_to_message?.text ||
        ctx.message.reply_to_message?.caption ||
        undefined;
      const view = await controller.handleTextMessage(
        ctx.from.id,
        ctx.message.text,
        repliedText
      );
      await ctx.reply(view.text, {
        parse_mode: 'Markdown',
        reply_markup: toGrammyInlineKeyboard(view.keyboard),
      });
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      log.error('Telegram text message error', {
        category: safeErr.category,
        error: safeErr.sanitizedTechnicalMessage,
      });
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
