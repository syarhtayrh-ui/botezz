import fs from 'node:fs';
import { Bot, InputFile } from 'grammy';
import { AppConfig } from '../config/env';
import {
  verifyTelegramAdmin,
  createGrammyAuthorizationMiddleware,
} from './middleware/authorization';
import {
  buildBackCancelRow,
  buildAppNavigationRow,
  toGrammyInlineKeyboard,
} from './keyboards/main-menu';
import { formatSessionStatusArabic } from './keyboards/session-menu';
import { PairingWorkflow, BotViewResponse } from './workflows/pairing-workflow';
import { MessageWorkflow } from './workflows/message-workflow';
import { MediaWorkflow } from './workflows/media-workflow';
import { GroupWorkflow } from './workflows/group-workflow';
import { VideoCallWorkflow } from './workflows/video-call-workflow';
import { UbuntuVideoCallBridge } from '../whatsapp/video-call-bridge';
import { StartHandler } from './handlers/start';
import { SessionsHandler } from './handlers/sessions';
import { MessagingHandler } from './handlers/messaging';
import { MediaHandler } from './handlers/media';
import { GroupsHandler } from './handlers/groups';
import { TasksHandler } from './handlers/tasks';
import { SettingsHandler } from './handlers/settings';
import { ToolsHandler, DEFAULT_SAMPLE_TEST_FUNCTION } from './handlers/tools';
import {
  ActiveInputOwner,
  BotUiStateManager,
  TelegramMessageTransport,
  createGrammyTransport,
  formatActiveInputOwnerArabic,
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
import { InboxRepository } from '../database/repositories/inbox-repository';
import { StatusRepository } from '../database/repositories/status-repository';
import { IncomingMessageReceiver } from '../whatsapp/incoming-message-receiver';
import { StatusDownloaderService } from '../whatsapp/status-downloader';
import { InboxHandler, InboxFilterKind } from './handlers/inbox';
import { StoriesHandler, StoriesFilterKind } from './handlers/stories';
import { NetworkTrafficHandler } from './handlers/network';
import { NetworkTrafficFilter } from '../network/network-traffic-monitor';
import { SecurityAnalyzerHandler } from './handlers/security-analyzer';
import {
  ForensicPayloadAnalyzer,
  ForensicCaptureRecord,
  setForensicPayloadAnalyzer,
} from '../security/forensic-payload-analyzer';
import { TelegramMediaAttachment } from './workflows/pairing-workflow';
import { toSafeArabicError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('telegram-bot');

export type ConversationMode =
  | 'NONE'
  | 'PAIRING'
  | 'MESSAGE'
  | 'MEDIA'
  | 'VIDEO_CALL'
  | 'GROUP'
  | 'TOOLS'
  | 'SETTINGS'
  | 'INBOX_FORWARD';

export interface TelegramControllerDeps {
  config: AppConfig;
  sessionManager: SessionManager;
  taskManager: TaskManager;
  sendMessageOp: SendMessageOperation;
  sendMediaOp: SendMediaOperation;
  groupOps: GroupOperations;
  auditRepo: AuditRepository;
  settingsRepo: SettingsRepository;
  inboxRepo?: InboxRepository;
  statusRepo?: StatusRepository;
  incomingMessageReceiver?: IncomingMessageReceiver;
  statusDownloader?: StatusDownloaderService;
  videoCallBridge?: UbuntuVideoCallBridge;
  forensicAnalyzer?: ForensicPayloadAnalyzer;
  duplicateTapWindowMs?: number;
  callbackTimeoutMs?: number;
}

export interface HandleInteractionOptions {
  transport?: TelegramMessageTransport;
  skipDuplicateCheck?: boolean;
  chatId?: number;
  userMessageId?: number;
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
  public readonly videoCallBridge: UbuntuVideoCallBridge;
  public readonly videoCallWorkflow: VideoCallWorkflow;

  public readonly startHandler: StartHandler;
  public readonly sessionsHandler: SessionsHandler;
  public readonly messagingHandler: MessagingHandler;
  public readonly mediaHandler: MediaHandler;
  public readonly groupsHandler: GroupsHandler;
  public readonly tasksHandler: TasksHandler;
  public readonly settingsHandler: SettingsHandler;
  public readonly toolsHandler: ToolsHandler;
  public readonly inboxRepo: InboxRepository;
  public readonly statusRepo: StatusRepository;
  public readonly incomingMessageReceiver: IncomingMessageReceiver;
  public readonly statusDownloader: StatusDownloaderService;
  public readonly inboxHandler: InboxHandler;
  public readonly storiesHandler: StoriesHandler;
  public readonly networkHandler: NetworkTrafficHandler;
  public readonly forensicAnalyzer: ForensicPayloadAnalyzer;
  public readonly securityAnalyzerHandler: SecurityAnalyzerHandler;
  public onCallRecordingReady?: (
    ownerTelegramId: number,
    attachment: {
      kind: 'video';
      filePath: string;
      fileName: string;
      caption?: string;
    }
  ) => void | Promise<void>;
  public onCallRecordingNoRemoteCamera?: (
    ownerTelegramId: number,
    messageArabic: string
  ) => void;
  public onCallLiveViewUpdate?: (
    ownerTelegramId: number,
    view: BotViewResponse
  ) => void | Promise<void>;
  public onForensicCaptureReady?: (
    ownerTelegramId: number,
    record: ForensicCaptureRecord,
    summaryMessageArabic: string,
    documentAttachments: TelegramMediaAttachment[]
  ) => void;

  public readonly activeCallTelegramMonitorByCallId = new Map<
    string,
    {
      adminId: number;
      chatId: number;
      messageId?: number;
      liveTimer?: NodeJS.Timeout;
      lastUpdatedAtMs?: number;
    }
  >();

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
    this.videoCallBridge =
      deps.videoCallBridge ??
      new UbuntuVideoCallBridge(deps.sessionManager, deps.auditRepo);
    this.videoCallBridge.setSettingsRepository?.(deps.settingsRepo);
    this.videoCallWorkflow = new VideoCallWorkflow(
      deps.sessionManager,
      this.videoCallBridge,
      deps.auditRepo,
      deps.config.TEMP_UPLOAD_DIR,
      deps.config.MAX_UPLOAD_SIZE_MB
    );
    this.videoCallWorkflow.setSettingsRepository(deps.settingsRepo);

    const resolveCallAdminId = (payload?: {
      initiatedByAdminId?: number;
      actorTelegramId?: number;
      stream?: NonNullable<ReturnType<UbuntuVideoCallBridge['getCallStatus']>>;
    }): number => {
      const candidate =
        payload?.initiatedByAdminId ||
        payload?.actorTelegramId ||
        payload?.stream?.initiatedByAdminId ||
        payload?.stream?.actorTelegramId ||
        deps.config.TELEGRAM_ADMIN_ID;
      return candidate && candidate > 0
        ? candidate
        : deps.config.TELEGRAM_ADMIN_ID;
    };

    const clearLiveMonitorTimer = (callId: string): void => {
      const monitor = this.activeCallTelegramMonitorByCallId.get(callId);
      if (monitor?.liveTimer) {
        clearInterval(monitor.liveTimer);
        monitor.liveTimer = undefined;
      }
    };

    const pushLiveStreamViewUpdate = (
      callId: string,
      adminId: number,
      stream?: NonNullable<ReturnType<UbuntuVideoCallBridge['getCallStatus']>>
    ): void => {
      const resolvedStream =
        stream || this.videoCallBridge.getCallStatus(callId);
      if (!resolvedStream || adminId <= 0) {
        return;
      }
      const sess = this.uiState.getOrCreateSession(adminId);
      const existingMonitor =
        this.activeCallTelegramMonitorByCallId.get(callId) || {
          adminId,
          chatId: adminId,
          messageId: sess.activeMessageId,
        };
      existingMonitor.messageId =
        sess.activeMessageId ?? existingMonitor.messageId;
      existingMonitor.lastUpdatedAtMs = Date.now();
      this.activeCallTelegramMonitorByCallId.set(callId, existingMonitor);

      const view = this.videoCallWorkflow.renderStreamStatusView(resolvedStream);
      sess.lastView = view;
      if (this.onCallLiveViewUpdate) {
        void Promise.resolve(this.onCallLiveViewUpdate(adminId, view)).catch(
          () => undefined
        );
      }
    };

    const startLiveMonitorTimerIfNeeded = (
      callId: string,
      adminId: number
    ): void => {
      const monitor = this.activeCallTelegramMonitorByCallId.get(callId) || {
        adminId,
        chatId: adminId,
      };
      if (monitor.liveTimer) {
        return;
      }
      const timer = setInterval(() => {
        const currentStream = this.videoCallBridge.getCallStatus(callId);
        if (
          !currentStream ||
          (currentStream.callState !== 'CONNECTED' &&
            currentStream.callState !== 'MEDIA_NEGOTIATING' &&
            currentStream.callState !== 'MEDIA_STARTED')
        ) {
          clearLiveMonitorTimer(callId);
          return;
        }
        pushLiveStreamViewUpdate(callId, adminId, currentStream);
      }, 4000);
      timer.unref?.();
      monitor.liveTimer = timer;
      this.activeCallTelegramMonitorByCallId.set(callId, monitor);
    };

    for (const evtName of [
      'call:initiating',
      'call:ringing',
      'call:connected',
      'call:media-started',
      'call:rejected',
      'call:timeout',
      'call:ended',
      'call:media-error',
    ] as const) {
      this.videoCallBridge.on(
        evtName,
        (payload: {
          callId: string;
          initiatedByAdminId?: number;
          actorTelegramId?: number;
          stream?: NonNullable<
            ReturnType<UbuntuVideoCallBridge['getCallStatus']>
          >;
        }) => {
          const callId = payload?.callId;
          if (!callId) return;
          const targetAdminId = resolveCallAdminId(payload);
          if (
            evtName === 'call:connected' ||
            evtName === 'call:media-started'
          ) {
            startLiveMonitorTimerIfNeeded(callId, targetAdminId);
          } else if (
            evtName === 'call:rejected' ||
            evtName === 'call:timeout' ||
            evtName === 'call:ended'
          ) {
            clearLiveMonitorTimer(callId);
          }
          pushLiveStreamViewUpdate(callId, targetAdminId, payload.stream);
        }
      );
    }

    this.videoCallBridge.on(
      'call:recording-ready',
      (payload: {
        callId: string;
        initiatedByAdminId?: number;
        actorTelegramId?: number;
        outputFilePath?: string;
        stream?: NonNullable<
          ReturnType<UbuntuVideoCallBridge['getCallStatus']>
        >;
      }) => {
        // Defer by one turn so synchronous `stopActiveCall` can attach the recording to its view response first
        setImmediate(() => {
          const callId = payload?.callId;
          if (callId) {
            clearLiveMonitorTimer(callId);
          }
          const stream =
            payload?.stream ||
            (callId ? this.videoCallBridge.getCallStatus(callId) : undefined);
          if (!stream) {
            return;
          }
          const targetAdminId = resolveCallAdminId(payload);
          pushLiveStreamViewUpdate(stream.callId, targetAdminId, stream);

          if (stream.recordingDeliveredToTelegram) {
            return;
          }
          const attachment =
            this.videoCallWorkflow.buildRecordingAttachment(stream);
          if (!attachment) {
            return;
          }
          stream.recordingDeliveredToTelegram = true;
          if (targetAdminId > 0) {
            this.uiState
              .getOrCreateSession(targetAdminId)
              .sentAttachments.push(attachment);
          }
          const filePath =
            payload?.outputFilePath ||
            stream.outputFilePath ||
            stream.recordedVideoPath;
          if (this.onCallRecordingReady && filePath) {
            void Promise.resolve(
              this.onCallRecordingReady(targetAdminId, {
                kind: 'video',
                filePath,
                fileName: attachment.fileName,
                caption: attachment.caption,
              })
            ).catch(() => undefined);
          }
        });
      }
    );

    this.videoCallBridge.on(
      'call:recording-no-remote-camera',
      (payload: {
        callId: string;
        initiatedByAdminId?: number;
        actorTelegramId?: number;
        messageArabic?: string;
        stream?: NonNullable<
          ReturnType<UbuntuVideoCallBridge['getCallStatus']>
        >;
      }) => {
        setImmediate(() => {
          const callId = payload?.callId;
          if (callId) {
            clearLiveMonitorTimer(callId);
          }
          const stream =
            payload?.stream ||
            (callId ? this.videoCallBridge.getCallStatus(callId) : undefined);
          const targetAdminId = resolveCallAdminId(payload);
          if (stream) {
            pushLiveStreamViewUpdate(stream.callId, targetAdminId, stream);
          }
          if (!stream || stream.recordingDeliveredToTelegram) {
            return;
          }
          stream.recordingDeliveredToTelegram = true;
          const notice =
            payload.messageArabic ||
            'ℹ️ انتهت المكالمة، ولم يتم إرسال فيديو تسجيل لأن الطرف المستقبل لم يفتح الكاميرا أثناء المكالمة.';
          if (this.onCallRecordingNoRemoteCamera && targetAdminId > 0) {
            this.onCallRecordingNoRemoteCamera(targetAdminId, notice);
          }
        });
      }
    );

    const appDb = (deps.auditRepo as unknown as { db: ConstructorParameters<typeof InboxRepository>[0] }).db;
    const sessionRepo = (deps.sessionManager as unknown as { sessionRepo: ConstructorParameters<typeof IncomingMessageReceiver>[1] }).sessionRepo;
    this.inboxRepo = deps.inboxRepo ?? new InboxRepository(appDb);
    this.statusRepo = deps.statusRepo ?? new StatusRepository(appDb);
    this.incomingMessageReceiver =
      deps.incomingMessageReceiver ??
      new IncomingMessageReceiver(
        this.inboxRepo,
        sessionRepo,
        deps.config.TEMP_UPLOAD_DIR
      );
    this.statusDownloader =
      deps.statusDownloader ??
      new StatusDownloaderService(
        this.statusRepo,
        sessionRepo,
        deps.config.TEMP_UPLOAD_DIR
      );

    deps.sessionManager.addIncomingMessageListener(
      ({ sessionId, rawMessage, sock }) => {
        const key = rawMessage?.key as { remoteJid?: string } | undefined;
        if (String(key?.remoteJid || '') === 'status@broadcast') {
          void this.statusDownloader
            .processStatusMessage({ sessionId, rawMessage, sock })
            .catch(() => undefined);
        } else {
          void this.incomingMessageReceiver
            .processIncomingMessage({ sessionId, rawMessage, sock })
            .catch(() => undefined);
        }
      }
    );

    this.inboxHandler = new InboxHandler(
      this.inboxRepo,
      this.incomingMessageReceiver,
      deps.sessionManager
    );
    this.storiesHandler = new StoriesHandler(
      this.statusRepo,
      this.statusDownloader,
      deps.sessionManager
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
    this.networkHandler = new NetworkTrafficHandler(
      deps.sessionManager,
      deps.auditRepo
    );
    this.forensicAnalyzer =
      deps.forensicAnalyzer ??
      new ForensicPayloadAnalyzer({
        settingsRepo: deps.settingsRepo,
        tempUploadDir: deps.config.TEMP_UPLOAD_DIR,
        botTokenToRedact: deps.config.TELEGRAM_BOT_TOKEN,
      });
    setForensicPayloadAnalyzer(this.forensicAnalyzer);
    this.securityAnalyzerHandler = new SecurityAnalyzerHandler(
      deps.sessionManager,
      deps.auditRepo,
      this.forensicAnalyzer
    );
    this.forensicAnalyzer.onForensicCaptureReady = (
      record,
      summaryMessageArabic,
      documentAttachments
    ) => {
      const targetAdminId = deps.config.TELEGRAM_ADMIN_ID;
      if (targetAdminId > 0) {
        const sess = this.uiState.getOrCreateSession(targetAdminId);
        for (const att of documentAttachments) {
          sess.sentAttachments.push(att);
          if (sess.sentAttachments.length > 100) {
            sess.sentAttachments.shift();
          }
        }
      }
      if (this.onForensicCaptureReady && targetAdminId > 0) {
        this.onForensicCaptureReady(
          targetAdminId,
          record,
          summaryMessageArabic,
          documentAttachments
        );
      }
    };
  }

  public isOwnerUser(userId: number): boolean {
    return userId === this.deps.config.TELEGRAM_ADMIN_ID;
  }

  public getConversationMode(adminId: number): ConversationMode {
    const owner = this.uiState.getActiveInputOwner(adminId);
    if (owner !== 'NONE') {
      const modeMap: Record<ActiveInputOwner, ConversationMode> = {
        NONE: 'NONE',
        PAIRING: 'PAIRING',
        SEND_TEXT: 'MESSAGE',
        SEND_MEDIA: 'MEDIA',
        VIDEO_CALL: 'VIDEO_CALL',
        GROUP: 'GROUP',
        TOOLS: 'TOOLS',
        INBOX: 'INBOX_FORWARD',
        STORIES: 'NONE',
        SETTINGS: 'SETTINGS',
        SUBSCRIPTIONS: 'SETTINGS',
      };
      return modeMap[owner] || 'NONE';
    }
    return this.activeConversationMode.get(adminId) || 'NONE';
  }

  /**
   * Enforces a single exclusive active input owner per user.
   * Immediately cancels all other 9 workflows/handlers so stale states from earlier
   * interactions can NEVER collide with the newly activated workflow.
   */
  public activateInputOwner(adminId: number, owner: ActiveInputOwner): void {
    if (owner !== 'PAIRING') {
      this.pairingWorkflow.cancel(adminId);
    }
    if (owner !== 'SEND_TEXT') {
      this.messageWorkflow.cancel(adminId);
    }
    if (owner !== 'SEND_MEDIA') {
      this.mediaWorkflow.cancel(adminId);
    }
    if (owner !== 'VIDEO_CALL') {
      this.videoCallWorkflow.cancel(adminId);
    }
    if (owner !== 'GROUP') {
      this.groupWorkflow.cancel(adminId);
    }
    if (owner !== 'TOOLS') {
      this.toolsHandler.cancel(adminId);
    }
    if (owner !== 'INBOX') {
      this.inboxHandler.cancel(adminId);
    }
    if (owner !== 'STORIES') {
      this.storiesHandler.cancel(adminId);
    }
    if (owner !== 'SETTINGS' && owner !== 'SUBSCRIPTIONS') {
      this.settingsHandler.cancel(adminId);
    }

    this.uiState.setActiveInputOwner(adminId, owner);
    const modeMap: Record<ActiveInputOwner, ConversationMode> = {
      NONE: 'NONE',
      PAIRING: 'PAIRING',
      SEND_TEXT: 'MESSAGE',
      SEND_MEDIA: 'MEDIA',
      VIDEO_CALL: 'VIDEO_CALL',
      GROUP: 'GROUP',
      TOOLS: 'TOOLS',
      INBOX: 'INBOX_FORWARD',
      STORIES: 'NONE',
      SETTINGS: 'SETTINGS',
      SUBSCRIPTIONS: 'SETTINGS',
    };
    this.activeConversationMode.set(adminId, modeMap[owner] || 'NONE');
  }

  private cancelAllWorkflowsForAdmin(adminId: number): void {
    this.activateInputOwner(adminId, 'NONE');
  }

  private async runWithTimeout<T>(
    work: () => Promise<T>,
    customTimeoutMs?: number
  ): Promise<T> {
    const timeoutMs = customTimeoutMs ?? this.uiState.callbackTimeoutMs;
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
    const isLongPresenceCallback =
      callbackData.startsWith('tools:presence_run:') ||
      callbackData.startsWith('tools:presence_hb_q:') ||
      callbackData.startsWith('tools:presence_prof:');

    try {
      if (isLongPresenceCallback && options?.transport?.answerCallbackQuery) {
        this.uiState.recordCallbackAnswered(actorUserId);
        callbackAnswered = true;
        await options.transport
          .answerCallbackQuery({
            text: '📡 جاري تشغيل رادار التتبع اللحظي...',
            showAlert: false,
          })
          .catch(() => undefined);
      }

      const onProgressUpdate = async (progressView: BotViewResponse) => {
        const currentSess = this.uiState.getOrCreateSession(actorUserId);
        await this.uiState.deliverView({
          userId: actorUserId,
          view: progressView,
          pendingWorkflow: this.getConversationMode(actorUserId),
          preferEdit: currentSess.activeMessageId !== undefined,
          transport: options?.transport,
        });
      };

      const view = await this.runWithTimeout(
        () =>
          this.routeCallbackQueryInternal(
            actorUserId,
            callbackData,
            onProgressUpdate
          ),
        isLongPresenceCallback
          ? Math.max(this.uiState.callbackTimeoutMs, 320_000)
          : undefined
      );

      // Answer callback query promptly before or alongside message edit
      if (!callbackAnswered) {
        this.uiState.recordCallbackAnswered(actorUserId);
        callbackAnswered = true;
        if (options?.transport?.answerCallbackQuery) {
          await options.transport.answerCallbackQuery({
            text: view.toastText,
            showAlert: view.showAlert,
          });
        }
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
    callbackData: string,
    onProgressUpdate?: (view: BotViewResponse) => Promise<void>
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
      callbackData === 'menu:pair' ||
      callbackData === 'pair:mode:random' ||
      callbackData === 'pair:mode:custom'
    ) {
      this.activateInputOwner(actorUserId, 'PAIRING');
      return this.pairingWorkflow.startNewLinking(actorUserId);
    }
    if (callbackData.startsWith('pair:prompt_label:')) {
      const sessId = callbackData.slice('pair:prompt_label:'.length);
      this.activateInputOwner(actorUserId, 'PAIRING');
      return this.pairingWorkflow.promptSessionLabel(actorUserId, sessId, false);
    }
    if (callbackData.startsWith('sess:prompt_rename:')) {
      const sessId = callbackData.slice('sess:prompt_rename:'.length);
      this.activateInputOwner(actorUserId, 'PAIRING');
      return this.pairingWorkflow.promptSessionLabel(actorUserId, sessId, true);
    }

    // 3: Manage Sessions & Session Status
    if (callbackData === 'menu:sessions') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.renderSessionsList(1, actorUserId);
    }
    if (callbackData.startsWith('menu:sessions:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.renderSessionsList(page, actorUserId);
    }
    if (callbackData === 'menu:session_status') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.renderSessionStatusOverview(actorUserId, isOwner);
    }
    if (callbackData.startsWith('sess:refresh:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      const view = this.sessionsHandler.renderSessionsList(page, actorUserId);
      return {
        ...view,
        toastText: '🔄 تم تحديث حالة الجلسات',
      };
    }
    if (callbackData.startsWith('sess:view:')) {
      const sessionId = callbackData.slice('sess:view:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.renderSessionDetail(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:reconnect:')) {
      const sessionId = callbackData.slice('sess:reconnect:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.handleReconnect(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:disconnect:')) {
      const sessionId = callbackData.slice('sess:disconnect:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.handleDisconnect(sessionId, actorUserId);
    }
    if (
      callbackData.startsWith('sess:repair:') ||
      callbackData.startsWith('sess:pair:')
    ) {
      const sessionId = callbackData.startsWith('sess:repair:')
        ? callbackData.slice('sess:repair:'.length)
        : callbackData.slice('sess:pair:'.length);
      this.activateInputOwner(actorUserId, 'PAIRING');
      return this.pairingWorkflow.startNewLinking(actorUserId, sessionId);
    }
    if (callbackData.startsWith('sess:confirm_remove:')) {
      const sessionId = callbackData.slice('sess:confirm_remove:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.renderConfirmRemove(sessionId, actorUserId);
    }
    if (callbackData.startsWith('sess:remove:')) {
      const sessionId = callbackData.slice('sess:remove:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.handleRemove(sessionId, actorUserId);
    }
    if (callbackData === 'sess:confirm_purge_inactive') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.renderConfirmPurgeInactive(actorUserId);
    }
    if (callbackData === 'sess:purge_inactive') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.sessionsHandler.handlePurgeInactive(actorUserId);
    }

    // 4: Send Text Message Workflow
    if (callbackData === 'menu:send_text') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messagingHandler.startSendText(actorUserId);
    }
    if (callbackData.startsWith('wf_msg:recent:')) {
      const target = callbackData.slice('wf_msg:recent:'.length);
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.handleTextInput(actorUserId, target);
    }
    if (callbackData === 'wf_msg:edit_text') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.promptEditText(actorUserId);
    }
    if (callbackData === 'wf_msg:edit_recipient') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.promptEditRecipient(actorUserId);
    }
    if (callbackData.startsWith('wf_msg:toggle_sess:')) {
      const sessId = callbackData.slice('wf_msg:toggle_sess:'.length);
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.toggleSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_msg:select_all') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.selectAllConnected(actorUserId);
    }
    if (callbackData === 'wf_msg:clear_all') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.clearAll(actorUserId);
    }
    if (callbackData === 'wf_msg:back_sessions') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.renderSessionSelection(actorUserId);
    }
    if (callbackData === 'wf_msg:proceed_confirm') {
      this.activateInputOwner(actorUserId, 'SEND_TEXT');
      return this.messageWorkflow.proceedToConfirmation(actorUserId);
    }
    if (callbackData === 'wf_msg:confirm_execute') {
      const view = this.messageWorkflow.confirmAndExecute(actorUserId);
      this.activateInputOwner(actorUserId, 'NONE');
      return view;
    }

    // 5: Send Media or File Workflow
    if (callbackData === 'menu:send_media') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaHandler.startSendMedia(actorUserId);
    }
    if (callbackData.startsWith('wf_media:recent:')) {
      const target = callbackData.slice('wf_media:recent:'.length);
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.handleRecipientInput(actorUserId, target);
    }
    if (callbackData === 'wf_media:edit_recipient') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.promptEditRecipient(actorUserId);
    }
    if (callbackData === 'wf_media:edit_file') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.promptEditFile(actorUserId);
    }
    if (callbackData === 'wf_media:back_sessions') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.renderSessionSelection(actorUserId);
    }
    if (callbackData === 'wf_media:sample:pdf') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaHandler.attachSampleFile(actorUserId, 'pdf');
    }
    if (callbackData === 'wf_media:sample:png') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaHandler.attachSampleFile(actorUserId, 'png');
    }
    if (callbackData.startsWith('wf_media:toggle_sess:')) {
      const sessId = callbackData.slice('wf_media:toggle_sess:'.length);
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.toggleSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_media:select_all') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.selectAllConnected(actorUserId);
    }
    if (callbackData === 'wf_media:clear_all') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.clearAll(actorUserId);
    }
    if (callbackData === 'wf_media:proceed_confirm') {
      this.activateInputOwner(actorUserId, 'SEND_MEDIA');
      return this.mediaWorkflow.proceedToConfirmation(actorUserId);
    }
    if (callbackData === 'wf_media:confirm_execute') {
      const view = this.mediaWorkflow.confirmAndExecute(actorUserId);
      this.activateInputOwner(actorUserId, 'NONE');
      return view;
    }

    // 5b: Live Video Call Streaming Workflow (3-Step Flow: Upload Video -> Send Phone -> Immediate Stream)
    if (callbackData === 'menu:video_call' || callbackData === 'wf_vcall:start') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.start(actorUserId);
    }
    if (callbackData.startsWith('wf_vcall:start_sess:')) {
      const sessId = callbackData.slice('wf_vcall:start_sess:'.length);
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.start(actorUserId, sessId);
    }
    if (callbackData.startsWith('wf_vcall:recent:')) {
      const target = callbackData.slice('wf_vcall:recent:'.length);
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      const res = await this.videoCallWorkflow.handleRecipientInput(
        actorUserId,
        target
      );
      const nextStep = this.videoCallWorkflow.getState(actorUserId)?.step;
      if (nextStep === 'STREAMING_ACTIVE') {
        this.uiState.setActiveInputOwner(actorUserId, 'NONE');
        this.activeConversationMode.set(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      }
      return res;
    }
    if (callbackData === 'wf_vcall:instant_ring_video') {
      const res = await this.videoCallWorkflow.startInstantCallRing(
        actorUserId,
        'video'
      );
      this.uiState.setActiveInputOwner(actorUserId, 'NONE');
      this.activeConversationMode.set(actorUserId, 'NONE');
      return res;
    }
    if (callbackData === 'wf_vcall:instant_ring_voice') {
      const res = await this.videoCallWorkflow.startInstantCallRing(
        actorUserId,
        'voice'
      );
      this.uiState.setActiveInputOwner(actorUserId, 'NONE');
      this.activeConversationMode.set(actorUserId, 'NONE');
      return res;
    }
    if (callbackData === 'wf_vcall:sample_video') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      const res = await this.videoCallWorkflow.attachSampleVideo(actorUserId);
      const nextStep = this.videoCallWorkflow.getState(actorUserId)?.step;
      if (nextStep === 'STREAMING_ACTIVE') {
        this.uiState.setActiveInputOwner(actorUserId, 'NONE');
        this.activeConversationMode.set(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      }
      return res;
    }
    if (callbackData === 'wf_vcall:repeat_call') {
      const res = await this.videoCallWorkflow.repeatCall(actorUserId);
      this.uiState.setActiveInputOwner(actorUserId, 'NONE');
      this.activeConversationMode.set(actorUserId, 'NONE');
      return res;
    }
    if (callbackData === 'wf_vcall:change_recipient') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.promptChangeRecipient(actorUserId);
    }
    if (callbackData === 'wf_vcall:toggle_loop') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.toggleLoop(actorUserId);
    }
    if (callbackData === 'wf_vcall:toggle_record') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.toggleRecordCall(actorUserId);
    }
    if (
      callbackData === 'wf_vcall:download_recording' ||
      callbackData.startsWith('wf_vcall:download_recording:')
    ) {
      const explicitCallId = callbackData.startsWith(
        'wf_vcall:download_recording:'
      )
        ? callbackData.slice('wf_vcall:download_recording:'.length)
        : undefined;
      return this.videoCallWorkflow.downloadLastRecording(
        actorUserId,
        explicitCallId
      );
    }
    if (callbackData === 'wf_vcall:cycle_duration') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.cycleDuration(actorUserId);
    }
    if (callbackData === 'wf_vcall:cycle_mode') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.cycleProtocolMode(actorUserId);
    }
    if (callbackData === 'wf_vcall:cycle_waves') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.cycleWavesCount(actorUserId);
    }
    if (
      callbackData.startsWith('wf_vcall:select_sess:') ||
      callbackData.startsWith('wf_vcall:sess:')
    ) {
      const sessId = callbackData.split(':').pop() || '';
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.selectSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_vcall:reupload') {
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      return this.videoCallWorkflow.promptReupload(actorUserId);
    }
    if (callbackData === 'wf_vcall:confirm_execute') {
      const res = await this.videoCallWorkflow.confirmAndExecute(actorUserId);
      this.uiState.setActiveInputOwner(actorUserId, 'NONE');
      this.activeConversationMode.set(actorUserId, 'NONE');
      return res;
    }
    if (
      callbackData === 'wf_vcall:stop' ||
      callbackData.startsWith('wf_vcall:stop:') ||
      callbackData.startsWith('vcall:stop:')
    ) {
      const explicitCallId = callbackData.startsWith('vcall:stop:')
        ? callbackData.slice('vcall:stop:'.length).trim()
        : callbackData.startsWith('wf_vcall:stop:')
          ? callbackData.slice('wf_vcall:stop:'.length).trim()
          : undefined;
      const res = await this.videoCallWorkflow.stopActiveCall(
        actorUserId,
        explicitCallId || undefined
      );
      this.activateInputOwner(actorUserId, 'NONE');
      return res;
    }
    if (callbackData === 'vcall:rec_history') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.videoCallWorkflow.renderRecordedCallsHistory(actorUserId);
    }
    if (callbackData.startsWith('vcall:dl_rec:')) {
      const idx = Number(callbackData.slice('vcall:dl_rec:'.length)) || 0;
      this.activateInputOwner(actorUserId, 'NONE');
      return this.videoCallWorkflow.downloadRecordedCallFromHistory(
        actorUserId,
        idx
      );
    }
    if (callbackData.startsWith('vcall:reuse_bcast:')) {
      const idx = Number(callbackData.slice('vcall:reuse_bcast:'.length)) || 0;
      this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      const res = await this.videoCallWorkflow.reuseBroadcastVideo(
        actorUserId,
        idx
      );
      const nextStep = this.videoCallWorkflow.getState(actorUserId)?.step;
      if (nextStep === 'STREAMING_ACTIVE') {
        this.uiState.setActiveInputOwner(actorUserId, 'NONE');
        this.activeConversationMode.set(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      }
      return res;
    }
    if (callbackData.startsWith('vcall:mute:')) {
      const callId = callbackData.slice('vcall:mute:'.length).trim();
      return this.videoCallWorkflow.toggleMuteActiveCall(actorUserId, callId);
    }
    if (callbackData.startsWith('vcall:react:')) {
      const callId = callbackData.slice('vcall:react:'.length).trim();
      return this.videoCallWorkflow.sendReactionOnActiveCall(
        actorUserId,
        callId,
        '❤️'
      );
    }
    if (callbackData.startsWith('vcall:retry:')) {
      const callId = callbackData.slice('vcall:retry:'.length).trim();
      const res = await this.videoCallWorkflow.retryCallById(
        actorUserId,
        callId
      );
      this.uiState.setActiveInputOwner(actorUserId, 'NONE');
      this.activeConversationMode.set(actorUserId, 'NONE');
      return res;
    }

    // 5c: Incoming Messages Receiver & Archive (Inbox)
    if (callbackData === 'menu:inbox') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.renderInboxMenu(actorUserId, 1);
    }
    if (callbackData.startsWith('menu:inbox:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.renderInboxMenu(actorUserId, page);
    }
    if (callbackData.startsWith('inbox:view:')) {
      const id = callbackData.slice('inbox:view:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.viewMessage(actorUserId, id);
    }
    if (
      callbackData.startsWith('inbox:fwd:') ||
      callbackData.startsWith('inbox:reply:')
    ) {
      const id = callbackData.startsWith('inbox:fwd:')
        ? callbackData.slice('inbox:fwd:'.length)
        : callbackData.slice('inbox:reply:'.length);
      this.activateInputOwner(actorUserId, 'INBOX');
      return this.inboxHandler.promptForward(actorUserId, id);
    }
    if (callbackData.startsWith('inbox:dl:')) {
      const id = callbackData.slice('inbox:dl:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.downloadMessageFile(actorUserId, id);
    }
    if (callbackData.startsWith('inbox:filter:')) {
      const filter = callbackData
        .slice('inbox:filter:'.length)
        .toUpperCase() as InboxFilterKind;
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.setFilter(actorUserId, filter);
    }
    if (callbackData === 'inbox:toggle_autoforward') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.toggleAutoForward(actorUserId);
    }
    if (callbackData === 'inbox:simulate_batch') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.inboxHandler.simulateBatch(actorUserId);
    }

    // 5d: WhatsApp Status / Stories Downloader
    if (callbackData === 'menu:stories') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.renderStoriesMenu(actorUserId, 1);
    }
    if (callbackData.startsWith('menu:stories:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.renderStoriesMenu(actorUserId, page);
    }
    if (callbackData.startsWith('stories:dl:')) {
      const id = callbackData.slice('stories:dl:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.downloadStatus(actorUserId, id);
    }
    if (callbackData.startsWith('stories:dlc:')) {
      const phone = callbackData.slice('stories:dlc:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.downloadAllByContact(actorUserId, phone);
    }
    if (callbackData.startsWith('stories:filter:')) {
      const filter = callbackData
        .slice('stories:filter:'.length)
        .toUpperCase() as StoriesFilterKind;
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.setFilter(actorUserId, filter);
    }
    if (callbackData === 'stories:toggle_autoforward') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.toggleAutoForward(actorUserId);
    }
    if (callbackData === 'stories:simulate_batch') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.storiesHandler.simulateBatch(actorUserId);
    }

    // 6: Group Management
    if (callbackData === 'menu:groups') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.groupsHandler.renderGroupManagementSubmenu(actorUserId);
    }
    if (callbackData.startsWith('grp:list:')) {
      const sessionId = callbackData.slice('grp:list:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.groupsHandler.renderSessionGroups(sessionId, 1, actorUserId);
    }
    if (callbackData.startsWith('grp:list_page:')) {
      const parts = callbackData.split(':');
      const sessionId = parts[2];
      const page = Number(parts[3] || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.groupsHandler.renderSessionGroups(sessionId, page, actorUserId);
    }
    if (callbackData.startsWith('gv:')) {
      const shortId = callbackData.slice('gv:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
        return this.groupsHandler.renderGroupManagementSubmenu(actorUserId);
      }
      this.activateInputOwner(actorUserId, 'GROUP');
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
      this.activateInputOwner(actorUserId, 'NONE');
      return this.groupWorkflow.renderGroupDetails(sessionId, groupJid, actorUserId);
    }
    if (callbackData.startsWith('grp:act:')) {
      const parts = callbackData.split(':');
      const sessionId = parts[2];
      const groupJid = parts[3];
      const action = parts[4] as GroupManagementActionType;
      this.activateInputOwner(actorUserId, 'GROUP');
      return this.groupWorkflow.initiateGroupAction({
        adminId: actorUserId,
        sessionId,
        groupJid,
        action,
      });
    }
    if (callbackData === 'wf_grp:confirm_action') {
      const view = this.groupWorkflow.confirmGroupAction(actorUserId);
      this.activateInputOwner(actorUserId, 'NONE');
      return view;
    }

    // 7: Join Group Workflow
    if (callbackData === 'menu:join_group') {
      this.activateInputOwner(actorUserId, 'GROUP');
      return this.groupWorkflow.startJoinGroup(actorUserId);
    }
    if (callbackData.startsWith('wf_join:toggle_sess:')) {
      const sessId = callbackData.slice('wf_join:toggle_sess:'.length);
      this.activateInputOwner(actorUserId, 'GROUP');
      return this.groupWorkflow.toggleJoinSession(actorUserId, sessId);
    }
    if (callbackData === 'wf_join:select_all') {
      this.activateInputOwner(actorUserId, 'GROUP');
      return this.groupWorkflow.selectAllJoinSessions(actorUserId);
    }
    if (callbackData === 'wf_join:clear_all') {
      this.activateInputOwner(actorUserId, 'GROUP');
      return this.groupWorkflow.clearAllJoinSessions(actorUserId);
    }
    if (callbackData === 'wf_join:proceed_confirm') {
      this.activateInputOwner(actorUserId, 'GROUP');
      return this.groupWorkflow.proceedJoinConfirmation(actorUserId);
    }
    if (callbackData === 'wf_join:confirm_execute') {
      const view = this.groupWorkflow.executeJoinGroup(actorUserId);
      this.activateInputOwner(actorUserId, 'NONE');
      return view;
    }

    // 8: Task Monitor & Admin Controls
    if (callbackData === 'menu:admin') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.startHandler.renderAdminControls();
    }
    if (callbackData.startsWith('menu:tasks:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.tasksHandler.renderTaskMonitor(page, actorUserId, isOwner);
    }
    if (callbackData.startsWith('task:view:')) {
      const taskId = callbackData.slice('task:view:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.tasksHandler.renderTaskDetail(taskId, actorUserId, isOwner);
    }
    if (callbackData.startsWith('task:cancel:')) {
      const taskId = callbackData.slice('task:cancel:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.tasksHandler.handleCancelTask(taskId, actorUserId, isOwner);
    }

    // 9: Activity History
    if (callbackData.startsWith('menu:audit:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.tasksHandler.renderAuditHistory(page);
    }

    // 10: Settings, Cooldown & Subscriptions Management
    if (callbackData === 'menu:settings' || callbackData === '/controls') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.renderSettings();
    }
    if (callbackData === 'settings:toggle_ratelimit') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.toggleSetting('rate_limit_profile', actorUserId);
    }
    if (callbackData === 'settings:toggle_notify') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.toggleSetting('notify_on_disconnect', actorUserId);
    }
    if (callbackData === 'settings:cycle_cooldown') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.cycleCooldown(actorUserId);
    }
    if (callbackData === 'settings:prompt_cooldown') {
      this.activateInputOwner(actorUserId, 'SETTINGS');
      return this.settingsHandler.promptCustomCooldown(actorUserId);
    }
    if (
      callbackData === 'settings:view_access' ||
      callbackData === 'menu:subscriptions'
    ) {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.renderSubscriptionsMenu(1);
    }
    if (callbackData.startsWith('menu:subscriptions:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.renderSubscriptionsMenu(page);
    }
    if (callbackData === 'sub:prompt_add') {
      this.activateInputOwner(actorUserId, 'SUBSCRIPTIONS');
      return this.settingsHandler.promptAddSubscription(actorUserId);
    }
    if (callbackData === 'sub:prompt_add_group') {
      this.activateInputOwner(actorUserId, 'SUBSCRIPTIONS');
      return this.settingsHandler.promptAddClaimGroup(actorUserId);
    }
    if (callbackData.startsWith('sub:confirm_remove:')) {
      const targetId = callbackData.slice('sub:confirm_remove:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.renderConfirmRemoveSubscription(targetId);
    }
    if (callbackData.startsWith('sub:remove:')) {
      const targetId = callbackData.slice('sub:remove:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.settingsHandler.handleRemoveSubscription(targetId, actorUserId);
    }

    // 11: Help and System Status
    if (callbackData === 'menu:help_status' || callbackData === 'menu:help') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.startHandler.renderHelpAndSystemStatus({
        isAdmin: isOwner,
        actorUserId,
      });
    }

    // 12: Sender Management & Integrated Tools & Diagnostics
    if (callbackData === 'menu:senders' || callbackData === 'tools:ceksender') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderSenderDiagnostics(1, actorUserId);
    }
    if (callbackData.startsWith('menu:senders:page:')) {
      const page = Number(callbackData.split(':').pop() || '1');
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderSenderDiagnostics(page, actorUserId);
    }
    if (callbackData === 'menu:tools' || callbackData === '/tools') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderToolsMenu(isOwner);
    }
    if (callbackData === 'tools:prompt_testfunction') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptTestFunction(actorUserId);
    }
    if (callbackData === 'tools:tf_prompt_max') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptCustomMaxSends(actorUserId);
    }
    if (callbackData === 'tools:tf_prompt_delay') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptCustomDelay(actorUserId);
    }
    if (callbackData.startsWith('tools:tf_set_max:')) {
      const val = callbackData.slice('tools:tf_set_max:'.length);
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.setMaxSendsConfig(actorUserId, val);
    }
    if (callbackData.startsWith('tools:tf_set_delay:')) {
      const val = callbackData.slice('tools:tf_set_delay:'.length);
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.setDelayConfig(actorUserId, val);
    }
    if (callbackData === 'tools:tf_toggle_scope') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleScopeConfig(actorUserId);
    }
    if (callbackData === 'tools:tf_toggle_stop_on_error') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleStopOnErrorConfig(actorUserId);
    }
    if (callbackData === 'tools:tf_toggle_smart_wrap') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleSmartWrapConfig(actorUserId);
    }
    if (callbackData === 'tools:run_sample_testfunction') {
      this.activateInputOwner(actorUserId, 'NONE');
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
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderFunctionCatalog(actorUserId);
    }
    if (callbackData.startsWith('tools:flab_select:')) {
      const fnName = callbackData.slice('tools:flab_select:'.length);
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.selectFunctionForAdmin(actorUserId, fnName);
    }
    if (callbackData.startsWith('tools:flab_dryrun:')) {
      const fnName = callbackData.slice('tools:flab_dryrun:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executeTestFunction(
        actorUserId,
        `+966501234567 1 ${fnName} --dry-run`
      );
    }
    if (callbackData.startsWith('tools:flab_mode:')) {
      const modeVal = callbackData
        .slice('tools:flab_mode:'.length)
        .toUpperCase() as 'LIVE' | 'DRY_RUN' | 'SIMULATION';
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.setExecutionModeForAdmin(actorUserId, modeVal);
    }
    if (
      callbackData === 'tools:flab_run_scenarios' ||
      callbackData === 'tools:flab_scenarios'
    ) {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderScenarioSuiteReport(actorUserId);
    }
    if (callbackData === 'tools:flab_capabilities') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderCapabilitiesMatrix();
    }
    if (
      callbackData === 'tools:flab_prompt_save' ||
      callbackData === 'tools:flab_save_last'
    ) {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptSaveLastFunction(actorUserId);
    }
    if (callbackData === 'tools:flab_prompt_upload_save') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptUploadFunctionToSave(actorUserId);
    }
    if (callbackData === 'tools:flab_confirm_upload_name') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      const view = this.toolsHandler.confirmUploadedFunctionName(actorUserId);
      if (this.toolsHandler.getStep(actorUserId) === 'NONE') {
        this.activateInputOwner(actorUserId, 'NONE');
      }
      return view;
    }
    if (callbackData.startsWith('tools:flab_prompt_run:')) {
      const fnName = callbackData.slice('tools:flab_prompt_run:'.length);
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptRunSavedFunction(actorUserId, fnName);
    }
    if (callbackData === 'tools:flab_stop') {
      return this.toolsHandler.stopActiveFunction(actorUserId);
    }
    if (callbackData === 'tools:prompt_channel') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptChannelLookup(actorUserId);
    }
    if (callbackData === 'tools:prompt_ip') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptIpLookup(actorUserId);
    }
    if (callbackData === 'tools:prompt_shortlink') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptShortlink(actorUserId);
    }
    if (callbackData === 'tools:cekall') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderCheckAllReport(actorUserId);
    }
    if (callbackData === 'tools:info') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderUserInfo(actorUserId, isOwner);
    }
    if (callbackData === 'tools:gempa') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executeEarthquakeCheck();
    }
    if (callbackData === 'tools:prompt_anon_lid') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptAnonymousLidMessage(actorUserId);
    }
    if (callbackData === 'tools:prompt_lid_lookup') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptLidResolve(actorUserId);
    }
    if (callbackData === 'tools:reachout_status') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executeReachoutDiagnostic(actorUserId);
    }
    if (callbackData === 'tools:prompt_username_mgr') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderUsernameManager(actorUserId);
    }
    if (callbackData.startsWith('tools:uname_mode:')) {
      const modeRaw = callbackData
        .slice('tools:uname_mode:'.length)
        .toLowerCase();
      const validMode: 'check' | 'set' | 'pin' | 'recommend' =
        modeRaw === 'set' || modeRaw === 'pin' || modeRaw === 'recommend'
          ? modeRaw
          : 'check';
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptUsernameMode(actorUserId, validMode);
    }
    if (callbackData === 'tools:uname_delete') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executeUsernameCommand(actorUserId, 'delete');
    }
    if (callbackData === 'tools:prompt_menfess_start') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptMenfessStart(actorUserId);
    }
    if (callbackData === 'tools:menfess_list') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.renderMenfessSessionsMenu(actorUserId);
    }
    if (callbackData.startsWith('tools:menfess_relay:')) {
      const anonId = callbackData.slice('tools:menfess_relay:'.length).trim();
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptMenfessRelayMessage(actorUserId, anonId);
    }
    if (callbackData.startsWith('tools:menfess_stop:')) {
      const anonId = callbackData.slice('tools:menfess_stop:'.length).trim();
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executeAnonStopCommand(actorUserId, anonId);
    }
    if (callbackData === 'tools:prompt_presence') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptPresenceTool(actorUserId);
    }
    if (callbackData === 'tools:presence_mode_track') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptPresenceTrackMode(actorUserId);
    }
    if (callbackData.startsWith('tools:presence_dur:')) {
      const durSec = Number(callbackData.slice('tools:presence_dur:'.length));
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptPresenceTrackMode(
        actorUserId,
        Number.isFinite(durSec) && durSec >= 5 ? durSec : 15
      );
    }
    if (callbackData.startsWith('tools:presence_run:')) {
      const rest = callbackData.slice('tools:presence_run:'.length);
      const lastColon = rest.lastIndexOf(':');
      const target = lastColon > 0 ? rest.slice(0, lastColon) : rest;
      const durSec =
        lastColon > 0 ? Number(rest.slice(lastColon + 1)) || 15 : 15;
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executePresenceTracking(
        actorUserId,
        `${target} ${durSec}`,
        onProgressUpdate
      );
    }
    if (callbackData.startsWith('tools:presence_hb_q:')) {
      const rest = callbackData.slice('tools:presence_hb_q:'.length);
      const firstColon = rest.indexOf(':');
      const modeRaw = firstColon > 0 ? rest.slice(0, firstColon) : 'composing';
      const target = firstColon > 0 ? rest.slice(firstColon + 1) : '';
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executePresenceHeartbeat(
        actorUserId,
        `${modeRaw} ${target} 15`,
        onProgressUpdate
      );
    }
    if (callbackData.startsWith('tools:presence_prof:')) {
      const target = callbackData.slice('tools:presence_prof:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.toolsHandler.executeFullProfileLookup(actorUserId, target);
    }
    if (callbackData.startsWith('presence:stop:')) {
      const watchId = callbackData.slice('presence:stop:'.length).trim();
      return this.toolsHandler.stopPresenceTrackerByWatchId(
        actorUserId,
        watchId
      );
    }
    if (callbackData === 'tools:presence_stop') {
      return this.toolsHandler.stopPresenceTrackingForAdmin(actorUserId);
    }
    if (callbackData === 'tools:heartbeat_stop') {
      return this.toolsHandler.stopPresenceHeartbeatForAdmin(actorUserId);
    }
    if (callbackData.startsWith('tools:presence_hb:')) {
      const modeRaw = callbackData
        .slice('tools:presence_hb:'.length)
        .toLowerCase();
      const mode: 'composing' | 'recording' | 'available' =
        modeRaw === 'recording'
          ? 'recording'
          : modeRaw === 'available'
            ? 'available'
            : 'composing';
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptPresenceHeartbeatMode(actorUserId, mode);
    }
    if (callbackData === 'tools:prompt_full_profile') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptFullProfileLookup(actorUserId);
    }
    if (callbackData === 'tools:prompt_short_ephemeral') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptShortEphemeralMessage(actorUserId);
    }
    if (callbackData.startsWith('tools:ephemeral_preset:')) {
      const sec = Number(callbackData.slice('tools:ephemeral_preset:'.length));
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.promptShortEphemeralMessage(
        actorUserId,
        Number.isFinite(sec) && sec >= 1 && sec <= 60 ? sec : 10
      );
    }
    if (callbackData === 'tools:ephemeral_toggle_trigger') {
      this.activateInputOwner(actorUserId, 'TOOLS');
      return this.toolsHandler.toggleEphemeralTriggerMode(actorUserId);
    }

    // 13: Network Traffic & Protocol Telemetry Inspector (Owner-Only)
    if (callbackData === 'menu:network') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.renderDashboard(actorUserId, 'ALL', 1);
    }
    if (callbackData.startsWith('net:list:')) {
      const parts = callbackData.split(':');
      const rawFilter = (parts[2] || 'ALL').toUpperCase();
      const page = Number(parts[3] || '1') || 1;
      const validFilter: NetworkTrafficFilter =
        rawFilter === 'HTTP' ||
        rawFilter === 'WA_STANZA' ||
        rawFilter === 'LOCAL_API' ||
        rawFilter === 'VOIP_RTP' ||
        rawFilter === 'ERRORS'
          ? (rawFilter as NetworkTrafficFilter)
          : 'ALL';
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.renderDashboard(actorUserId, validFilter, page);
    }
    if (callbackData.startsWith('net:view:')) {
      const shortId = callbackData.slice('net:view:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.renderEntryDetail(actorUserId, shortId);
    }
    if (callbackData === 'net:ping') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.executeLivePing(actorUserId);
    }
    if (callbackData === 'net:export') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.exportTrafficReport(actorUserId);
    }
    if (callbackData === 'net:toggle') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.toggleCapture(actorUserId);
    }
    if (callbackData === 'net:clear') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.networkHandler.clearBuffer(actorUserId);
    }

    // 14: Security & Forensic Payload Analyzer (Owner-Only)
    if (callbackData === 'menu:sec_analyzer') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.renderDashboard(actorUserId, 1);
    }
    if (callbackData === 'sec:toggle') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.toggleEnabled(actorUserId);
    }
    if (callbackData === 'sec:toggle_autoupload') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.toggleAutoUpload(actorUserId);
    }
    if (callbackData === 'sec:toggle_raw_nodes') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.toggleRawBinaryNodes(actorUserId);
    }
    if (callbackData.startsWith('sec:filter:')) {
      const rawFilter = callbackData.slice('sec:filter:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.setSurfaceFilter(
        actorUserId,
        rawFilter
      );
    }
    if (callbackData.startsWith('sec:page:')) {
      const page = Number(callbackData.slice('sec:page:'.length)) || 1;
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.renderDashboard(actorUserId, page);
    }
    if (callbackData.startsWith('sec:download:')) {
      const shortId = callbackData.slice('sec:download:'.length);
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.downloadCaptureBundle(
        actorUserId,
        shortId
      );
    }
    if (callbackData === 'sec:clear') {
      this.activateInputOwner(actorUserId, 'NONE');
      return this.securityAnalyzerHandler.clearArchive(actorUserId);
    }

    this.activateInputOwner(actorUserId, 'NONE');
    return this.startHandler.renderMainMenu({
      isAdmin: isOwner,
      actorUserId,
    });
  }

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

    if (typeof options?.userMessageId === 'number') {
      this.uiState.recordChatActivityMessageId(actorUserId, options.userMessageId);
    }

    this.cancelAllWorkflowsForAdmin(actorUserId);
    this.uiState.resetHome(actorUserId);

    const isOwner = this.isOwnerUser(actorUserId);
    const view = this.startHandler.renderMainMenu({
      isAdmin: isOwner,
      actorUserId,
      activeModeLabel: formatActiveInputOwnerArabic(
        this.uiState.getActiveInputOwner(actorUserId)
      ),
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

    if (typeof options?.userMessageId === 'number') {
      this.uiState.recordChatActivityMessageId(actorUserId, options.userMessageId);
    }

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

    const isMenfessCaption =
      /^(?:\/anonmsg\s+)?#?anon_[a-f0-9]{6,16}\b/i.test(caption);
    const isAwaitingMenfessMedia =
      mode === 'TOOLS' &&
      this.toolsHandler.getStep(actorUserId) === 'AWAITING_MENFESS_RELAY_INPUT';

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
      this.activateInputOwner(actorUserId, 'TOOLS');
    } else if (isAwaitingMenfessMedia || isMenfessCaption) {
      view = await this.toolsHandler.handleMenfessMediaUpload(
        actorUserId,
        upload
      );
      this.activateInputOwner(actorUserId, 'NONE');
    } else if (mode === 'VIDEO_CALL') {
      view = await this.videoCallWorkflow.handleVideoUpload(actorUserId, upload);
      const nextStep = this.videoCallWorkflow.getState(actorUserId)?.step;
      if (nextStep === 'STREAMING_ACTIVE') {
        this.uiState.setActiveInputOwner(actorUserId, 'NONE');
        this.activeConversationMode.set(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'VIDEO_CALL');
      }
    } else {
      const mediaState = this.mediaWorkflow.getState(actorUserId);
      if (mode === 'MEDIA' && mediaState?.step === 'AWAITING_FILE') {
        view = this.mediaWorkflow.handleFileUpload(actorUserId, upload);
      } else if (caption) {
        // Allow quick media upload if caption starts with a phone number or JID
        const tokens = caption.split(/\s+/);
        const firstToken = tokens[0] || '';
        if (/^(?:\+?\d{8,15}|\d+@g\.us|\d+@s\.whatsapp\.net)$/.test(firstToken)) {
          this.activateInputOwner(actorUserId, 'SEND_MEDIA');
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
          this.activateInputOwner(actorUserId, 'SEND_MEDIA');
          view = this.mediaWorkflow.start(actorUserId);
        }
      } else {
        this.activateInputOwner(actorUserId, 'SEND_MEDIA');
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

    if (typeof options?.userMessageId === 'number') {
      this.uiState.recordChatActivityMessageId(actorUserId, options.userMessageId);
    }

    const trimmed = text.trim();
    // Fast-path /start and /menu commands (with optional @bot and payload)
    if (/^\/(?:start|menu)(?:@\w+)?(?:\s+.*)?$/i.test(trimmed)) {
      return this.handleStartCommand(actorUserId, options);
    }

    const onProgressUpdate = async (progressView: BotViewResponse) => {
      const currentSess = this.uiState.getOrCreateSession(actorUserId);
      await this.uiState.deliverView({
        userId: actorUserId,
        view: progressView,
        pendingWorkflow: this.getConversationMode(actorUserId),
        preferEdit: currentSess.activeMessageId !== undefined,
        transport: options?.transport,
      });
    };

    const view = await this.routeTextMessageInternal(
      actorUserId,
      text,
      repliedText,
      options?.chatId,
      onProgressUpdate
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
    repliedText?: string,
    chatId?: number,
    onProgressUpdate?: (view: BotViewResponse) => Promise<void>
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
      this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:settings');
        return this.settingsHandler.renderSettings();
      }

      if (command === '/admin') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:admin');
        return this.startHandler.renderAdminControls();
      }

      if (command === '/sessions') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:sessions:page:1');
        return this.sessionsHandler.renderSessionsList(1, actorUserId);
      }

      if (command === '/tools') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:tools');
        return this.toolsHandler.renderToolsMenu(isOwner);
      }

      if (command === '/inbox') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:inbox:page:1');
        return this.inboxHandler.renderInboxMenu(actorUserId, 1);
      }

      if (command === '/stories' || command === '/statusdl') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:stories:page:1');
        return this.storiesHandler.renderStoriesMenu(actorUserId, 1);
      }

      if (command === '/ceksender') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:senders:page:1');
        return this.toolsHandler.renderSenderDiagnostics(1, actorUserId);
      }

      if (command === '/cekall') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'tools:cekall');
        return this.toolsHandler.renderCheckAllReport(actorUserId);
      }

      if (command === '/info' || command === '/cekprem') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'tools:info');
        return this.toolsHandler.renderUserInfo(actorUserId, isOwner);
      }

      if (command === '/gempa') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'tools:gempa');
        return this.toolsHandler.executeEarthquakeCheck();
      }

      if (command === '/cekidch') {
        if (args.length === 0) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptChannelLookup(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeChannelLookup(actorUserId, args.join(' '));
      }

      if (command === '/trackip') {
        if (args.length === 0) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptIpLookup(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeIpLookup(actorUserId, args[0]);
      }

      if (command === '/shortlink') {
        if (args.length === 0) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptShortlink(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeShortlink(actorUserId, args.join(' '));
      }

      if (command === '/anonmsg' || command === '/lidmsg') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgs) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptAnonymousLidMessage(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeAnonymousLidMessage(actorUserId, rawArgs);
      }

      if (command === '/lid') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgs) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptLidResolve(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeLidResolveCommand(actorUserId, rawArgs);
      }

      if (command === '/reachout' || command === '/tctoken') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeReachoutDiagnostic(
          actorUserId,
          rawArgs || undefined
        );
      }

      if (command === '/username') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeUsernameCommand(actorUserId, rawArgs);
      }

      if (command === '/anonstart') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgs) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptMenfessStart(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeAnonStartCommand(actorUserId, rawArgs);
      }

      if (command === '/anonstop') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeAnonStopCommand(actorUserId, rawArgs);
      }

      if (command === '/presence') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgs) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptPresenceTool(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executePresenceCommand(
          actorUserId,
          rawArgs,
          onProgressUpdate
        );
      }

      if (command === '/fullprofile' || command === '/whois') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgs) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptFullProfileLookup(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeFullProfileLookup(actorUserId, rawArgs);
      }

      if (command === '/ephemeral' || command === '/selfdestruct') {
        const rawArgs = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgs) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptShortEphemeralMessage(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeShortEphemeralMessage(
          actorUserId,
          rawArgs
        );
      }

      if (command === '/nettraffic') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:network');
        return this.networkHandler.handleCommandNetTraffic(actorUserId, args[0]);
      }

      if (command === '/netinspect') {
        this.activateInputOwner(actorUserId, 'NONE');
        const targetId = args[0] || '';
        if (!targetId) {
          return this.networkHandler.renderDashboard(actorUserId, 'ALL', 1);
        }
        return this.networkHandler.renderEntryDetail(actorUserId, targetId);
      }

      if (command === '/secanalyzer') {
        this.activateInputOwner(actorUserId, 'NONE');
        this.uiState.recordRouteTransition(actorUserId, 'menu:sec_analyzer');
        return this.securityAnalyzerHandler.renderDashboard(actorUserId, 1);
      }

      if (command === '/secupload') {
        this.activateInputOwner(actorUserId, 'NONE');
        const targetId = args[0] || '';
        if (!targetId) {
          return this.securityAnalyzerHandler.renderDashboard(actorUserId, 1);
        }
        return this.securityAnalyzerHandler.downloadCaptureBundle(
          actorUserId,
          targetId
        );
      }

      if (command === '/testfunction') {
        const rawArgsAfterCommand = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgsAfterCommand) {
          if (repliedText || this.toolsHandler.getSelectedFunction(actorUserId)) {
            this.activateInputOwner(actorUserId, 'NONE');
            return this.toolsHandler.executeTestFunction(
              actorUserId,
              '',
              repliedText
            );
          }
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptTestFunction(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
        return this.toolsHandler.executeTestFunction(
          actorUserId,
          rawArgsAfterCommand,
          repliedText
        );
      }

      if (command === '/savefunction') {
        const rawArgsAfterCommand = trimmed.replace(/^\/\S+\s*/, '');
        if (!rawArgsAfterCommand && !repliedText) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptSaveLastFunction(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'TOOLS');
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
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptCustomMaxSends(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'TOOLS');
        return this.toolsHandler.setMaxSendsConfig(actorUserId, args[0]);
      }

      if (command === '/settfdelay') {
        if (args.length === 0) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.promptCustomDelay(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'TOOLS');
        return this.toolsHandler.setDelayConfig(actorUserId, args[0]);
      }

      if (command === '/settfscope') {
        if (args.length === 0) {
          this.activateInputOwner(actorUserId, 'TOOLS');
          return this.toolsHandler.toggleScopeConfig(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'TOOLS');
        return this.toolsHandler.setScopeConfig(actorUserId, args[0]);
      }

      // Direct pairing commands: /pair, /requestpair <phone> [custom8] or /addsender <phone> [custom8]
      if (
        command === '/pair' ||
        command === '/requestpair' ||
        command === '/addsender'
      ) {
        if (args.length === 0) {
          this.activateInputOwner(actorUserId, 'PAIRING');
          return this.pairingWorkflow.startNewLinking(actorUserId);
        }
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
        return this.settingsHandler.renderSubscriptionsMenu(1);
      }

      // Claim groups commands: /addgb, /delgb, /listgb, /claim
      if (command === '/addgb') {
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
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
        this.activateInputOwner(actorUserId, 'NONE');
        return this.settingsHandler.renderSubscriptionsMenu(1);
      }

      if (command === '/videocall') {
        this.activateInputOwner(actorUserId, 'VIDEO_CALL');
        if (args.length > 0) {
          return this.videoCallWorkflow.start(
            actorUserId,
            undefined,
            args.join(' ')
          );
        }
        return this.videoCallWorkflow.start(actorUserId);
      }

      if (command === '/claim') {
        this.activateInputOwner(actorUserId, 'NONE');
        const claimGroups = this.deps.settingsRepo.listClaimGroups();
        const isInRegisteredClaimGroup =
          chatId !== undefined &&
          chatId !== null &&
          chatId !== actorUserId &&
          claimGroups.some((g) => g.groupId === String(chatId));

        if (!isOwner && !isInRegisteredClaimGroup) {
          return {
            text: '🚫 أمر `/claim` متاح فقط داخل مجموعات التفعيل المعتمدة.',
            keyboard: [buildBackCancelRow('menu:main')],
          };
        }

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

    // Strict exclusive non-command text routing via ActiveInputOwner (zero cross-workflow fallthrough)
    const owner = this.uiState.getActiveInputOwner(actorUserId);
    const mode = this.getConversationMode(actorUserId);
    const buttonStepGuidanceBanner =
      'ℹ️ *يرجى استخدام الأزرار التفاعلية أدناه للمتابعة أو الضغط على ❌ إلغاء.*';

    if (owner === 'PAIRING' || mode === 'PAIRING') {
      this.activateInputOwner(actorUserId, 'PAIRING');
      const res = await this.pairingWorkflow.handlePhoneInput(actorUserId, trimmed);
      if (!this.pairingWorkflow.getState(actorUserId)) {
        this.activateInputOwner(actorUserId, 'NONE');
      }
      return res;
    }

    if (owner === 'SEND_TEXT' || (owner === 'NONE' && mode === 'MESSAGE')) {
      const state = this.messageWorkflow.getState(actorUserId);
      if (!state) {
        this.activateInputOwner(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'SEND_TEXT');
        if (state.step === 'SELECTING_SESSIONS') {
          const currentView = this.messageWorkflow.renderSessionSelection(actorUserId);
          return {
            ...currentView,
            text: `${buttonStepGuidanceBanner}\n\n${currentView.text}`,
          };
        }
        if (state.step === 'AWAITING_CONFIRMATION') {
          const currentView = this.messageWorkflow.proceedToConfirmation(actorUserId);
          return {
            ...currentView,
            text: `${buttonStepGuidanceBanner}\n\n${currentView.text}`,
          };
        }
        return this.messageWorkflow.handleTextInput(actorUserId, trimmed);
      }
    }

    if (owner === 'SEND_MEDIA' || (owner === 'NONE' && mode === 'MEDIA')) {
      const state = this.mediaWorkflow.getState(actorUserId);
      if (!state) {
        this.activateInputOwner(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'SEND_MEDIA');
        if (state.step === 'AWAITING_RECIPIENT') {
          return this.mediaWorkflow.handleRecipientInput(actorUserId, trimmed);
        }
        if (state.step === 'SELECTING_SESSIONS') {
          const currentView = this.mediaWorkflow.renderSessionSelection(actorUserId);
          return {
            ...currentView,
            text: `${buttonStepGuidanceBanner}\n\n${currentView.text}`,
          };
        }
        if (state.step === 'AWAITING_CONFIRMATION') {
          const currentView = this.mediaWorkflow.proceedToConfirmation(actorUserId);
          return {
            ...currentView,
            text: `${buttonStepGuidanceBanner}\n\n${currentView.text}`,
          };
        }
      }
    }

    if (owner === 'VIDEO_CALL' || (owner === 'NONE' && mode === 'VIDEO_CALL')) {
      const state = this.videoCallWorkflow.getState(actorUserId);
      if (!state) {
        this.activateInputOwner(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'VIDEO_CALL');
        if (state.step === 'AWAITING_RECIPIENT') {
          const res = await this.videoCallWorkflow.handleRecipientInput(
            actorUserId,
            trimmed
          );
          const nextStep = this.videoCallWorkflow.getState(actorUserId)?.step;
          if (nextStep === 'STREAMING_ACTIVE') {
            this.uiState.setActiveInputOwner(actorUserId, 'NONE');
            this.activeConversationMode.set(actorUserId, 'NONE');
          } else {
            this.activateInputOwner(actorUserId, 'VIDEO_CALL');
          }
          return res;
        }
        if (state.step === 'AWAITING_VIDEO') {
          if (/^[\d+\s()-]{7,20}$/.test(trimmed)) {
            return this.videoCallWorkflow.handleRecipientInput(actorUserId, trimmed);
          }
          return {
            text: `🎬 *الخطوة 1 من 2:* الرجاء رفع ملف الفيديو المسجل (\`.mp4\`, \`.mov\`, \`.webm\`, \`.mkv\`) أولاً أو الضغط على زر الفيديو التجريبي أدناه:`,
            keyboard: [
              [
                {
                  text: '🎬 استخدام فيديو تجريبي جاهز (sample_call.mp4)',
                  callbackData: 'wf_vcall:sample_video',
                },
              ],
              buildBackCancelRow('menu:main'),
            ],
          };
        }
      }
    }

    if (owner === 'GROUP' || (owner === 'NONE' && mode === 'GROUP')) {
      const state = this.groupWorkflow.getState(actorUserId);
      if (!state) {
        this.activateInputOwner(actorUserId, 'NONE');
      } else {
        this.activateInputOwner(actorUserId, 'GROUP');
        if (state.mode === 'JOIN_GROUP') {
          if (state.step === 'AWAITING_LINK') {
            return this.groupWorkflow.handleJoinLinkInput(actorUserId, trimmed);
          }
          if (state.step === 'SELECTING_SESSIONS') {
            const currentView =
              this.groupWorkflow.renderJoinSessionSelection(actorUserId);
            return {
              ...currentView,
              text: `${buttonStepGuidanceBanner}\n\n${currentView.text}`,
            };
          }
          if (state.step === 'AWAITING_CONFIRMATION') {
            const currentView =
              this.groupWorkflow.proceedJoinConfirmation(actorUserId);
            return {
              ...currentView,
              text: `${buttonStepGuidanceBanner}\n\n${currentView.text}`,
            };
          }
        }
        if (state.mode === 'MANAGE_GROUP') {
          if (state.step === 'AWAITING_PARTICIPANT_PHONE') {
            return this.groupWorkflow.handleParticipantPhoneInput(
              actorUserId,
              trimmed
            );
          }
          if (state.step === 'AWAITING_ACTION_CONFIRMATION') {
            const shortId = this.groupWorkflow.registerGroupRef(
              state.sessionId,
              state.groupJid
            );
            return {
              text:
                `${buttonStepGuidanceBanner}\n\n` +
                `⚠️ *تأكيد إجراء إداري على المجموعة*\n\n` +
                `📌 المجموعة: *${state.groupSubject}*\n` +
                `🆔 الجلسة: \`${state.sessionId}\`\n` +
                `⚡ الإجراء: \`${state.action}\``,
              keyboard: [
                [
                  {
                    text: '✅ تأكيد التنفيذ',
                    callbackData: 'wf_grp:confirm_action',
                  },
                  { text: '❌ إلغاء', callbackData: `gv:${shortId}` },
                ],
              ],
            };
          }
        }
      }
    }

    if (owner === 'TOOLS' || (owner === 'NONE' && mode === 'TOOLS')) {
      this.activateInputOwner(actorUserId, 'TOOLS');
      const response = await this.toolsHandler.handleGuidedInput(
        actorUserId,
        trimmed,
        repliedText,
        onProgressUpdate
      );
      const nextStep = this.toolsHandler.getStep(actorUserId);
      this.activateInputOwner(
        actorUserId,
        nextStep === 'NONE' ? 'NONE' : 'TOOLS'
      );
      return response;
    }

    if (
      owner === 'SETTINGS' ||
      owner === 'SUBSCRIPTIONS' ||
      (owner === 'NONE' && mode === 'SETTINGS')
    ) {
      const currentOwner =
        owner === 'SUBSCRIPTIONS' ? 'SUBSCRIPTIONS' : 'SETTINGS';
      this.activateInputOwner(actorUserId, currentOwner);
      const response = this.settingsHandler.handleGuidedInput(
        actorUserId,
        trimmed
      );
      const nextStep = this.settingsHandler.getStep(actorUserId);
      this.activateInputOwner(
        actorUserId,
        nextStep === 'NONE' ? 'NONE' : currentOwner
      );
      return response;
    }

    if (owner === 'INBOX' || (owner === 'NONE' && mode === 'INBOX_FORWARD')) {
      this.activateInputOwner(actorUserId, 'INBOX');
      const response = await this.inboxHandler.executeForward(actorUserId, trimmed);
      if (!this.inboxHandler.hasPendingForward(actorUserId)) {
        this.activateInputOwner(actorUserId, 'NONE');
      }
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

  const reanchorControlPanelToBottom = async (
    targetAdminId: number,
    targetChatId: number
  ): Promise<void> => {
    const state = controller.uiState.getOrCreateSession(targetAdminId);
    if (!state.activeMessageId || !state.lastView) {
      return;
    }
    const oldMessageId = state.activeMessageId;
    try {
      const sent = await bot.api.sendMessage(
        targetChatId,
        state.lastView.text,
        {
          parse_mode: 'Markdown',
          reply_markup: toGrammyInlineKeyboard(state.lastView.keyboard),
        }
      );
      await bot.api.deleteMessage(targetChatId, oldMessageId).catch(() => undefined);
      await bot.api
        .pinChatMessage(targetChatId, sent.message_id, {
          disable_notification: true,
        })
        .catch(() => undefined);
      state.activeMessageId = sent.message_id;
      state.pinnedMessageId = sent.message_id;
      state.lastSeenChatMessageId = Math.max(
        state.lastSeenChatMessageId ?? 0,
        sent.message_id
      );
      state.panelBuriedByNewMessages = false;
    } catch {
      // Ignore if Telegram chat is unreachable or Markdown fallback is needed
    }
  };

  const forwardCapturedAttachmentToTelegram = async (
    ownerTelegramId: number,
    attachment: {
      kind: 'photo' | 'video' | 'audio' | 'document' | 'sticker';
      filePath: string;
      fileName: string;
      caption?: string;
    },
    onForwarded: () => void
  ): Promise<void> => {
    const targetChatId =
      ownerTelegramId > 0 ? ownerTelegramId : config.TELEGRAM_ADMIN_ID;
    if (
      !targetChatId ||
      !attachment?.filePath ||
      !fs.existsSync(attachment.filePath)
    ) {
      return;
    }
    const rawCaption = attachment.caption ? String(attachment.caption) : '';
    const trimmedCaption =
      rawCaption.length > 1024
        ? `${rawCaption.slice(0, 1020)}...`
        : rawCaption;
    const sendWithFallback = async (usePlainCaption: boolean): Promise<void> => {
      if (!fs.existsSync(attachment.filePath)) {
        return;
      }
      const inputFile = new InputFile(attachment.filePath, attachment.fileName);
      const effectiveCaption = usePlainCaption
        ? trimmedCaption.replace(/[*_`]/g, '')
        : trimmedCaption;
      const captionOpts = effectiveCaption
        ? {
            caption: effectiveCaption,
            ...(usePlainCaption ? {} : { parse_mode: 'Markdown' as const }),
          }
        : {};
      if (attachment.kind === 'photo') {
        await bot.api.sendPhoto(targetChatId, inputFile, captionOpts);
      } else if (attachment.kind === 'video') {
        try {
          await bot.api.sendVideo(targetChatId, inputFile, captionOpts);
        } catch {
          const docFile = new InputFile(attachment.filePath, attachment.fileName);
          await bot.api.sendDocument(targetChatId, docFile, captionOpts);
        }
      } else if (attachment.kind === 'audio') {
        await bot.api.sendAudio(targetChatId, inputFile, captionOpts);
      } else {
        await bot.api.sendDocument(targetChatId, inputFile, captionOpts);
      }
    };

    try {
      await sendWithFallback(false);
    } catch {
      await sendWithFallback(true);
    }
    if (rawCaption.length > 1024) {
      const remainder = rawCaption.slice(0, 4096).replace(/[*_`]/g, '');
      await bot.api.sendMessage(targetChatId, remainder).catch(() => undefined);
    }
    controller.uiState.markPanelBuried(targetChatId);
    await reanchorControlPanelToBottom(targetChatId, targetChatId);
    onForwarded();
  };

  controller.incomingMessageReceiver.onMessageArchived = (record, attachment) => {
    const targetAdminId =
      record.owner_telegram_id > 0
        ? record.owner_telegram_id
        : config.TELEGRAM_ADMIN_ID;
    if (!controller.incomingMessageReceiver.isAutoForwardEnabled(targetAdminId)) {
      return;
    }
    void forwardCapturedAttachmentToTelegram(
      record.owner_telegram_id,
      attachment,
      () => controller.inboxRepo.markForwarded(record.id)
    ).catch((err) => {
      log.warn('Failed auto-forwarding archived inbox message to Telegram', {
        recordId: record.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  controller.statusDownloader.onStatusCaptured = (record, attachment) => {
    const targetAdminId =
      record.owner_telegram_id > 0
        ? record.owner_telegram_id
        : config.TELEGRAM_ADMIN_ID;
    if (!controller.statusDownloader.isAutoForwardEnabled(targetAdminId)) {
      return;
    }
    void forwardCapturedAttachmentToTelegram(
      record.owner_telegram_id,
      attachment,
      () => controller.statusRepo.markForwarded(record.id)
    ).catch((err) => {
      log.warn('Failed auto-forwarding captured status to Telegram', {
        recordId: record.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const lastLiveCallEditMsByChat = new Map<number, number>();
  controller.onCallLiveViewUpdate = async (ownerTelegramId, view) => {
    const targetChatId =
      ownerTelegramId && ownerTelegramId > 0
        ? ownerTelegramId
        : config.TELEGRAM_ADMIN_ID;
    if (!targetChatId || targetChatId <= 0) return;

    const now = Date.now();
    const prevMs = lastLiveCallEditMsByChat.get(targetChatId) ?? 0;
    if (now - prevMs < 1500) {
      return;
    }
    lastLiveCallEditMsByChat.set(targetChatId, now);

    const sess = controller.uiState.getOrCreateSession(targetChatId);
    if (!sess.activeMessageId) {
      return;
    }

    try {
      await bot.api.editMessageText(
        targetChatId,
        sess.activeMessageId,
        view.text,
        {
          parse_mode: 'Markdown',
          reply_markup: toGrammyInlineKeyboard(view.keyboard),
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('message is not modified') ||
        msg.includes('message to edit not found')
      ) {
        return;
      }
      try {
        await bot.api.editMessageText(
          targetChatId,
          sess.activeMessageId,
          view.text.replace(/[*_`]/g, ''),
          {
            reply_markup: toGrammyInlineKeyboard(view.keyboard),
          }
        );
      } catch {
        // Ignore harmless edit conflicts during live call updates
      }
    }
  };

  controller.onCallRecordingReady = async (ownerTelegramId, attachment) => {
    try {
      await forwardCapturedAttachmentToTelegram(
        ownerTelegramId,
        attachment,
        () => undefined
      );
    } catch (err) {
      log.warn('Failed auto-forwarding recorded VoIP video call to Telegram', {
        fileName: attachment.fileName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  controller.onCallRecordingNoRemoteCamera = (
    ownerTelegramId,
    messageArabic
  ) => {
    const targetChatId =
      ownerTelegramId && ownerTelegramId > 0
        ? ownerTelegramId
        : config.TELEGRAM_ADMIN_ID;
    if (targetChatId > 0) {
      void bot.api
        .sendMessage(targetChatId, messageArabic)
        .then(async (sent) => {
          controller.uiState.recordChatActivityMessageId(
            targetChatId,
            sent.message_id
          );
          await reanchorControlPanelToBottom(targetChatId, targetChatId);
        })
        .catch((err) => {
          log.warn('Failed sending NO_REMOTE_CAMERA notice to Telegram', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  };

  controller.onForensicCaptureReady = (
    ownerTelegramId,
    record,
    summaryMessageArabic,
    documentAttachments
  ) => {
    const targetChatId =
      ownerTelegramId && ownerTelegramId > 0
        ? ownerTelegramId
        : config.TELEGRAM_ADMIN_ID;
    if (!targetChatId || targetChatId <= 0) return;

    void (async () => {
      try {
        try {
          await bot.api.sendMessage(targetChatId, summaryMessageArabic, {
            parse_mode: 'Markdown',
          });
        } catch {
          await bot.api.sendMessage(
            targetChatId,
            summaryMessageArabic.replace(/[*_`]/g, '')
          );
        }
        for (const att of documentAttachments) {
          let inputFile: InputFile;
          if (att.buffer && att.buffer.length > 0) {
            inputFile = new InputFile(att.buffer, att.fileName);
          } else if (att.filePath && fs.existsSync(att.filePath)) {
            inputFile = new InputFile(att.filePath, att.fileName);
          } else {
            continue;
          }
          const safeCaption =
            att.caption && att.caption.length > 1024
              ? `${att.caption.slice(0, 1020)}...`
              : att.caption;
          await bot.api.sendDocument(
            targetChatId,
            inputFile,
            safeCaption ? { caption: safeCaption } : {}
          );
        }
        controller.uiState.markPanelBuried(targetChatId);
        await reanchorControlPanelToBottom(targetChatId, targetChatId);
      } catch (err) {
        log.warn('Failed auto-uploading forensic capture bundle to Telegram', {
          captureId: record.captureId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };

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
        userMessageId: ctx.message?.message_id,
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
        userMessageId: ctx.message?.message_id,
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleTextMessage(
        ctx.from.id,
        ctx.message.text,
        repliedText,
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: doc.file_name || `document_${Date.now()}.bin`,
          mimeType: doc.mime_type || 'application/octet-stream',
          sizeBytes: doc.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: `photo_${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: highestRes.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: vid.file_name || `video_${Date.now()}.mp4`,
          mimeType: vid.mime_type || 'video/mp4',
          sizeBytes: vid.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: aud.file_name || `audio_${Date.now()}.mp3`,
          mimeType: aud.mime_type || 'audio/mpeg',
          sizeBytes: aud.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: `voice_${Date.now()}.ogg`,
          mimeType: voice.mime_type || 'audio/ogg',
          sizeBytes: voice.file_size || buffer.length,
          contentBuffer: buffer,
          caption: ctx.message.caption,
        },
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
      const hadActiveInput =
        controller.uiState.getActiveInputOwner(ctx.from.id) !== 'NONE';
      await controller.handleMediaUpload(
        ctx.from.id,
        {
          originalFilename: `sticker_${Date.now()}.webp`,
          mimeType: 'image/webp',
          sizeBytes: stk.file_size || buffer.length,
          contentBuffer: buffer,
        },
        {
          transport,
          chatId: ctx.chat?.id,
          userMessageId: ctx.message.message_id,
        }
      );
      if (hadActiveInput && ctx.chat?.id && ctx.message.message_id) {
        await ctx.api
          .deleteMessage(ctx.chat.id, ctx.message.message_id)
          .catch(() => undefined);
      }
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
