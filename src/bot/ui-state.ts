import fs from 'node:fs';
import { InputFile } from 'grammy';
import { InlineKeyboardRows, toGrammyInlineKeyboard } from './keyboards/main-menu';
import { BotViewResponse, TelegramMediaAttachment } from './workflows/pairing-workflow';
import { toSafeArabicError } from '../utils/errors';
import { stripMarkdown, isMarkdownEntityError } from '../utils/markdown';
import { createLogger } from '../logging/logger';

const log = createLogger('bot-ui-state');

export type UiDeliveryMode =
  | 'EDIT_TEXT'
  | 'EDIT_MARKUP'
  | 'NOT_MODIFIED'
  | 'NEW_MESSAGE'
  | 'DUPLICATE_BLOCKED';

export type ActiveInputOwner =
  | 'NONE'
  | 'PAIRING'
  | 'SEND_TEXT'
  | 'SEND_MEDIA'
  | 'VIDEO_CALL'
  | 'GROUP'
  | 'TOOLS'
  | 'INBOX'
  | 'STORIES'
  | 'SETTINGS'
  | 'SUBSCRIPTIONS';

export type ActiveWorkflowOwner = ActiveInputOwner;

export interface UiSessionStats {
  sentCount: number;
  editedTextCount: number;
  editedMarkupCount: number;
  notModifiedCount: number;
  duplicateBlockedCount: number;
  callbackAnsweredCount: number;
}

export interface UserUiSessionState {
  userId: number;
  chatId?: number;
  activeMessageId?: number;
  pinnedMessageId?: number;
  lastSeenChatMessageId?: number;
  panelBuriedByNewMessages?: boolean;
  activeInputOwner: ActiveInputOwner;
  activeInputUpdatedAtMs: number;
  lastText?: string;
  lastKeyboardJson?: string;
  currentRoute: string;
  history: string[];
  lastView?: BotViewResponse;
  sentAttachments: TelegramMediaAttachment[];
  inFlightCallbacks: Set<string>;
  lastCallbackAt: Map<string, number>;
  stats: UiSessionStats;
}

export type BotUiStateSession = UserUiSessionState;

export interface TelegramMessageTransport {
  sendNewMessage?(
    text: string,
    keyboard: InlineKeyboardRows
  ): Promise<{ messageId: number }>;
  sendMessage?(
    text: string,
    keyboard: InlineKeyboardRows
  ): Promise<{ messageId: number }>;
  editMessageText(
    messageId: number,
    text: string,
    keyboard: InlineKeyboardRows
  ): Promise<void>;
  editMessageReplyMarkup(
    messageId: number,
    keyboard: InlineKeyboardRows
  ): Promise<void>;
  sendMediaAttachment?(
    attachment: TelegramMediaAttachment
  ): Promise<void | { messageId?: number }>;
  answerCallbackQuery?(options?: {
    text?: string;
    showAlert?: boolean;
  }): Promise<void>;
  deleteMessage?(messageId: number): Promise<void>;
  pinMessage?(messageId: number): Promise<void>;
  unpinMessage?(messageId: number): Promise<void>;
}

export type UiDeliveryTransport = TelegramMessageTransport;

const WORKFLOW_OWNER_BANNER_ARABIC: Record<ActiveInputOwner, string> = {
  NONE: 'القائمة الرئيسية (لا توجد عملية معلقة)',
  PAIRING: '📲 ربط جلسة واتساب جديدة (بانتظار إدخال رقم الهاتف)',
  SEND_TEXT: '✉️ إرسال رسالة نصية عبر واتساب',
  SEND_MEDIA: '📎 إرسال وسائط / ملفات عبر واتساب',
  VIDEO_CALL: '📹 إعداد وبث مكالمة فيديو VoIP',
  GROUP: '👥 إدارة المجموعات والانضمام الجماعي',
  TOOLS: '🛠️ أداة واتساب تفاعلية قيد الإدخال',
  INBOX: '📥 إعادة توجيه / الرد من صندوق الوارد',
  STORIES: '⭕ إدارة وتحميل حالات واتساب',
  SETTINGS: '⚙️ تحديث إعدادات النظام والأمان',
  SUBSCRIPTIONS: '⭐ إدارة الاشتراكات ومجموعات التفعيل',
};

export function formatActiveInputOwnerArabic(owner: ActiveInputOwner): string {
  return (
    WORKFLOW_OWNER_BANNER_ARABIC[owner] ||
    WORKFLOW_OWNER_BANNER_ARABIC.NONE
  );
}

/**
 * Checks whether an error from Telegram / grammY is the benign
 * "Bad Request: message is not modified", "message to edit not found", or rate-limit (429) response.
 */
export function isMessageNotModifiedError(err: unknown): boolean {
  if (!err) return false;
  const msg = (
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'description' in err
        ? String((err as { description?: unknown }).description)
        : String(err)
  ).toLowerCase();
  return msg.includes('message is not modified');
}

export function isTelegramRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = (
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'description' in err
        ? String((err as { description?: unknown }).description)
        : String(err)
  ).toLowerCase();
  const errorCode =
    typeof err === 'object' && err !== null && 'error_code' in err
      ? Number((err as { error_code?: unknown }).error_code)
      : undefined;
  return errorCode === 429 || msg.includes('too many requests');
}

/**
 * Determines whether a callback data string represents a navigation route
 * that should be recorded in the user's Back/Refresh history stack.
 */
export function isNavigableRoute(callbackData: string): boolean {
  if (
    callbackData.startsWith('nav:') ||
    callbackData === 'workflow:cancel' ||
    callbackData === '/start'
  ) {
    return false;
  }
  return (
    callbackData.startsWith('menu:') ||
    callbackData.startsWith('sess:view:') ||
    callbackData.startsWith('sess:confirm_') ||
    callbackData.startsWith('grp:list:') ||
    callbackData.startsWith('grp:list_page:') ||
    callbackData.startsWith('grp:view:') ||
    callbackData.startsWith('gv:') ||
    callbackData.startsWith('task:view:') ||
    callbackData === 'settings:view_access' ||
    callbackData === 'tools:ceksender' ||
    callbackData === 'tools:cekall' ||
    callbackData === 'tools:info' ||
    callbackData === 'tools:gempa' ||
    callbackData === 'tools:prompt_testfunction' ||
    callbackData === 'tools:prompt_channel' ||
    callbackData === 'tools:prompt_ip' ||
    callbackData === 'tools:prompt_shortlink' ||
    callbackData === 'tools:flab_catalog' ||
    callbackData === 'tools:flab_scenarios' ||
    callbackData === 'tools:flab_run_scenarios' ||
    callbackData === 'tools:flab_capabilities' ||
    callbackData.startsWith('inbox:view:') ||
    callbackData.startsWith('inbox:dl:') ||
    callbackData.startsWith('inbox:filter:') ||
    callbackData.startsWith('stories:dl:') ||
    callbackData.startsWith('stories:dlc:') ||
    callbackData.startsWith('stories:filter:') ||
    callbackData === 'menu:network' ||
    callbackData.startsWith('net:list:') ||
    callbackData.startsWith('net:view:') ||
    callbackData === 'net:ping' ||
    callbackData === 'menu:sec_analyzer' ||
    callbackData.startsWith('sec:page:') ||
    callbackData.startsWith('sec:download:') ||
    callbackData === 'tools:prompt_anon_lid' ||
    callbackData === 'tools:prompt_lid_lookup' ||
    callbackData === 'tools:reachout_status' ||
    callbackData === 'tools:prompt_username_mgr' ||
    callbackData.startsWith('tools:uname_mode:') ||
    callbackData === 'tools:prompt_menfess_start' ||
    callbackData === 'tools:menfess_list' ||
    callbackData.startsWith('tools:menfess_relay:')
  );
}

/**
 * Stateful UI and Single-Message Navigation Manager.
 * Ensures the Telegram bot behaves like a modern single-message interactive application:
 * - Edits existing messages in-place via editMessageText or editMessageReplyMarkup when not buried
 * - Re-anchors the Control Panel to the bottom of the chat, deletes the old buried panel,
 *   and pins the new Control Panel whenever user input, media, or background notifications bury it
 * - Tracks single exclusive ActiveInputOwner to prevent multi-map workflow collisions
 * - Tracks Back / Home / Refresh navigation stack per user
 * - Prevents duplicate operations on repeated button taps
 */
export class BotUiStateManager {
  private readonly sessions = new Map<number, UserUiSessionState>();
  private nextSimulatedMessageId = 1000;
  public readonly duplicateTapWindowMs: number;
  public readonly callbackTimeoutMs: number;

  constructor(options?: {
    duplicateTapWindowMs?: number;
    callbackTimeoutMs?: number;
  }) {
    this.duplicateTapWindowMs = options?.duplicateTapWindowMs ?? 300;
    this.callbackTimeoutMs = options?.callbackTimeoutMs ?? 12_000;
  }

  public getOrCreateSession(userId: number): UserUiSessionState {
    let sess = this.sessions.get(userId);
    if (!sess) {
      sess = {
        userId,
        activeInputOwner: 'NONE',
        activeInputUpdatedAtMs: Date.now(),
        currentRoute: 'menu:main',
        history: [],
        sentAttachments: [],
        inFlightCallbacks: new Set<string>(),
        lastCallbackAt: new Map<string, number>(),
        stats: {
          sentCount: 0,
          editedTextCount: 0,
          editedMarkupCount: 0,
          notModifiedCount: 0,
          duplicateBlockedCount: 0,
          callbackAnsweredCount: 0,
        },
      };
      this.sessions.set(userId, sess);
    }
    return sess;
  }

  public getState(userId: number): UserUiSessionState {
    return this.getOrCreateSession(userId);
  }

  public getActiveMessageId(userId: number): number | undefined {
    return this.getOrCreateSession(userId).activeMessageId;
  }

  /**
   * Returns the single exclusive active input workflow owner for the user.
   */
  public getActiveInputOwner(userId: number): ActiveInputOwner {
    return this.getOrCreateSession(userId).activeInputOwner;
  }

  /**
   * Updates the single exclusive active input workflow owner for the user.
   */
  public setActiveInputOwner(userId: number, owner: ActiveInputOwner): void {
    const sess = this.getOrCreateSession(userId);
    sess.activeInputOwner = owner;
    sess.activeInputUpdatedAtMs = Date.now();
  }

  /**
   * Records a new message ID observed in the chat (e.g., user text/media input or
   * background notification) so `deliverView` knows if the Control Panel was buried.
   */
  public recordChatActivityMessageId(userId: number, messageId: number): void {
    if (!Number.isFinite(messageId) || messageId <= 0) return;
    const sess = this.getOrCreateSession(userId);
    if (
      sess.lastSeenChatMessageId === undefined ||
      messageId > sess.lastSeenChatMessageId
    ) {
      sess.lastSeenChatMessageId = messageId;
    }
    if (
      sess.activeMessageId !== undefined &&
      messageId > sess.activeMessageId
    ) {
      sess.panelBuriedByNewMessages = true;
    }
  }

  /**
   * Explicitly marks the current Control Panel message as buried below newer chat
   * messages (e.g., after sending a background notification or media upload).
   */
  public markPanelBuried(userId: number): void {
    const sess = this.getOrCreateSession(userId);
    sess.panelBuriedByNewMessages = true;
    if (sess.activeMessageId !== undefined) {
      sess.lastSeenChatMessageId = Math.max(
        sess.lastSeenChatMessageId ?? 0,
        sess.activeMessageId + 1
      );
    }
  }

  public setActiveMessage(
    userId: number,
    messageId: number,
    chatId?: number,
    text?: string,
    keyboard?: InlineKeyboardRows
  ): void {
    const sess = this.getOrCreateSession(userId);
    sess.activeMessageId = messageId;
    if (chatId !== undefined) {
      sess.chatId = chatId;
    }
    if (text !== undefined) {
      sess.lastText = text;
    }
    if (keyboard !== undefined) {
      sess.lastKeyboardJson = JSON.stringify(keyboard);
    }
  }

  public recordRouteTransition(userId: number, nextRoute: string): void {
    const sess = this.getOrCreateSession(userId);
    if (nextRoute === 'menu:main' || nextRoute === 'nav:home') {
      sess.history = [];
      sess.currentRoute = 'menu:main';
      return;
    }

    if (
      sess.currentRoute &&
      sess.currentRoute !== nextRoute &&
      isNavigableRoute(sess.currentRoute)
    ) {
      const lastInHistory = sess.history[sess.history.length - 1];
      if (lastInHistory !== sess.currentRoute) {
        sess.history.push(sess.currentRoute);
        if (sess.history.length > 25) {
          sess.history.shift();
        }
      }
    }
    sess.currentRoute = nextRoute;
  }

  public popPreviousRoute(userId: number): string {
    const sess = this.getOrCreateSession(userId);
    const popped = sess.history.pop();
    const target = popped || 'menu:main';
    sess.currentRoute = target;
    return target;
  }

  public getCurrentRoute(userId: number): string {
    return this.getOrCreateSession(userId).currentRoute || 'menu:main';
  }

  public resetHome(userId: number): void {
    const sess = this.getOrCreateSession(userId);
    sess.history = [];
    sess.currentRoute = 'menu:main';
    sess.activeInputOwner = 'NONE';
    sess.activeInputUpdatedAtMs = Date.now();
  }

  /**
   * Acquires an execution lock for a user's callback tap.
   * Blocks concurrent in-flight execution or rapid double-tap within `duplicateTapWindowMs`.
   */
  public tryAcquireCallbackLock(
    userId: number,
    callbackData: string,
    now = Date.now()
  ): { acquired: boolean; reason?: 'IN_FLIGHT' | 'DEBOUNCED' } {
    const sess = this.getOrCreateSession(userId);
    if (sess.inFlightCallbacks.has(callbackData)) {
      sess.stats.duplicateBlockedCount += 1;
      return { acquired: false, reason: 'IN_FLIGHT' };
    }

    const lastAt = sess.lastCallbackAt.get(callbackData);
    if (
      lastAt !== undefined &&
      this.duplicateTapWindowMs > 0 &&
      now - lastAt < this.duplicateTapWindowMs
    ) {
      sess.stats.duplicateBlockedCount += 1;
      return { acquired: false, reason: 'DEBOUNCED' };
    }

    sess.inFlightCallbacks.add(callbackData);
    sess.lastCallbackAt.set(callbackData, now);
    return { acquired: true };
  }

  public releaseCallbackLock(userId: number, callbackData: string): void {
    const sess = this.getOrCreateSession(userId);
    sess.inFlightCallbacks.delete(callbackData);
  }

  public recordCallbackAnswered(userId: number): void {
    const sess = this.getOrCreateSession(userId);
    sess.stats.callbackAnsweredCount += 1;
  }

  private async invokeTransportSendNew(
    transport: TelegramMessageTransport | undefined,
    text: string,
    keyboard: InlineKeyboardRows
  ): Promise<{ messageId: number }> {
    if (transport?.sendNewMessage) {
      return transport.sendNewMessage(text, keyboard);
    }
    if (transport?.sendMessage) {
      return transport.sendMessage(text, keyboard);
    }
    this.nextSimulatedMessageId += 1;
    return { messageId: this.nextSimulatedMessageId };
  }

  /**
   * Delivers a BotViewResponse over a Telegram transport (or simulated transport):
   * - Pure inline button clicks (`preferEdit && !isPanelBuried && !shouldReanchorBelowMedia`)
   *   edit the existing Control Panel message in-place and ensure it is pinned.
   * - When the Control Panel is buried below user messages, media attachments, or background
   *   notifications (`isPanelBuried || !preferEdit || shouldReanchorBelowMedia`), sends a brand-new
   *   Control Panel message at the bottom of the chat, deletes the old buried panel message,
   *   and silently pins the new Control Panel message.
   */
  public async deliverView(params: {
    userId: number;
    view: BotViewResponse;
    pendingWorkflow: string;
    preferEdit: boolean;
    transport?: TelegramMessageTransport;
  }): Promise<BotViewResponse> {
    const { userId, view, pendingWorkflow, preferEdit, transport } = params;
    const sess = this.getOrCreateSession(userId);

    // Ensure a 1-tap escape button (`workflow:cancel`) is present whenever an input workflow is active
    const effectiveKeyboard: InlineKeyboardRows = view.keyboard
      ? view.keyboard.map((row) => [...row])
      : [];
    if (sess.activeInputOwner !== 'NONE' || pendingWorkflow !== 'NONE') {
      const hasCancelButton = effectiveKeyboard
        .flat()
        .some(
          (btn) =>
            btn.callbackData === 'workflow:cancel' ||
            btn.callbackData === 'nav:home' ||
            btn.callbackData === 'menu:main'
        );
      if (!hasCancelButton) {
        effectiveKeyboard.push([
          {
            text: '❌ إلغاء العملية والعودة للرئيسية',
            callbackData: 'workflow:cancel',
          },
        ]);
      }
    }

    const effectiveView: BotViewResponse = {
      ...view,
      keyboard: effectiveKeyboard,
    };

    const nextKeyboardJson = JSON.stringify(effectiveKeyboard);
    const hasAttachments =
      Array.isArray(effectiveView.mediaAttachments) &&
      effectiveView.mediaAttachments.length > 0;
    const shouldReanchorBelowMedia =
      hasAttachments && Boolean(transport?.sendMediaAttachment);

    let deliveryMode: UiDeliveryMode = 'NEW_MESSAGE';

    if (hasAttachments && effectiveView.mediaAttachments) {
      for (const att of effectiveView.mediaAttachments) {
        sess.sentAttachments.push(att);
        if (sess.sentAttachments.length > 100) {
          sess.sentAttachments.shift();
        }
        if (transport?.sendMediaAttachment) {
          try {
            const mediaRes = await transport.sendMediaAttachment(att);
            if (
              mediaRes &&
              typeof mediaRes === 'object' &&
              typeof mediaRes.messageId === 'number'
            ) {
              this.recordChatActivityMessageId(userId, mediaRes.messageId);
            }
          } catch (attErr) {
            log.warn('Failed sending media attachment to Telegram', {
              userId,
              fileName: att.fileName,
              error:
                attErr instanceof Error ? attErr.message : String(attErr),
            });
          }
        }
      }
    }

    const isPanelBuried =
      sess.panelBuriedByNewMessages === true ||
      (sess.activeMessageId !== undefined &&
        sess.lastSeenChatMessageId !== undefined &&
        sess.lastSeenChatMessageId > sess.activeMessageId);

    if (
      preferEdit &&
      sess.activeMessageId !== undefined &&
      !shouldReanchorBelowMedia &&
      !isPanelBuried
    ) {
      const targetMsgId = sess.activeMessageId;
      const sameText = sess.lastText === effectiveView.text;
      const sameKeyboard = sess.lastKeyboardJson === nextKeyboardJson;

      if (sameText && sameKeyboard) {
        if (transport) {
          try {
            await transport.editMessageText(
              targetMsgId,
              effectiveView.text,
              effectiveKeyboard
            );
          } catch (err) {
            if (!isMessageNotModifiedError(err)) {
              throw err;
            }
          }
        }
        sess.stats.notModifiedCount += 1;
        deliveryMode = 'NOT_MODIFIED';
      } else if (sameText && !sameKeyboard) {
        try {
          if (transport) {
            await transport.editMessageReplyMarkup(
              targetMsgId,
              effectiveKeyboard
            );
          }
          sess.lastKeyboardJson = nextKeyboardJson;
          sess.stats.editedMarkupCount += 1;
          deliveryMode = 'EDIT_MARKUP';
        } catch (err) {
          if (isMessageNotModifiedError(err)) {
            sess.stats.notModifiedCount += 1;
            deliveryMode = 'NOT_MODIFIED';
          } else {
            deliveryMode = await this.fallbackEditOrSend(
              sess,
              effectiveView,
              nextKeyboardJson,
              transport
            );
          }
        }
      } else {
        deliveryMode = await this.fallbackEditOrSend(
          sess,
          effectiveView,
          nextKeyboardJson,
          transport
        );
      }

      if (
        sess.activeMessageId !== undefined &&
        sess.pinnedMessageId !== sess.activeMessageId &&
        transport?.pinMessage
      ) {
        await transport.pinMessage(sess.activeMessageId).catch(() => undefined);
        sess.pinnedMessageId = sess.activeMessageId;
      }
    } else {
      const oldMessageId = sess.activeMessageId;
      const sent = await this.invokeTransportSendNew(
        transport,
        effectiveView.text,
        effectiveKeyboard
      );
      sess.activeMessageId = sent.messageId;
      sess.lastText = effectiveView.text;
      sess.lastKeyboardJson = nextKeyboardJson;
      sess.stats.sentCount += 1;
      sess.panelBuriedByNewMessages = false;
      sess.lastSeenChatMessageId = Math.max(
        sess.lastSeenChatMessageId ?? 0,
        sent.messageId
      );

      if (
        oldMessageId !== undefined &&
        oldMessageId !== sent.messageId &&
        transport?.deleteMessage
      ) {
        await transport.deleteMessage(oldMessageId).catch(() => undefined);
      }
      if (transport?.pinMessage) {
        await transport.pinMessage(sent.messageId).catch(() => undefined);
        sess.pinnedMessageId = sent.messageId;
      }
      deliveryMode = 'NEW_MESSAGE';
    }

    const enriched: BotViewResponse = {
      ...effectiveView,
      route: effectiveView.route || sess.currentRoute,
      uiMeta: {
        deliveryMode,
        activeMessageId: sess.activeMessageId!,
        currentRoute: sess.currentRoute,
        canGoBack: sess.history.length > 0,
        pendingWorkflow,
        stats: { ...sess.stats },
      },
    };
    sess.lastView = enriched;
    return enriched;
  }

  private async fallbackEditOrSend(
    sess: UserUiSessionState,
    view: BotViewResponse,
    nextKeyboardJson: string,
    transport?: TelegramMessageTransport
  ): Promise<UiDeliveryMode> {
    if (sess.activeMessageId !== undefined) {
      try {
        if (transport) {
          await transport.editMessageText(
            sess.activeMessageId,
            view.text,
            view.keyboard
          );
        }
        sess.lastText = view.text;
        sess.lastKeyboardJson = nextKeyboardJson;
        sess.stats.editedTextCount += 1;
        return 'EDIT_TEXT';
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          sess.stats.notModifiedCount += 1;
          return 'NOT_MODIFIED';
        }
        if (isTelegramRateLimitError(err)) {
          log.warn('Telegram 429 Too Many Requests during menu edit; skipping duplicate send', {
            userId: sess.userId,
            activeMessageId: sess.activeMessageId,
          });
          sess.stats.notModifiedCount += 1;
          return 'NOT_MODIFIED';
        }
        log.warn('Failed to edit existing menu message; falling back to new message', {
          userId: sess.userId,
          activeMessageId: sess.activeMessageId,
          reason: toSafeArabicError(err).sanitizedTechnicalMessage,
        });
      }
    }

    const oldMessageId = sess.activeMessageId;
    const sent = await this.invokeTransportSendNew(
      transport,
      view.text,
      view.keyboard
    );
    sess.activeMessageId = sent.messageId;
    sess.lastText = view.text;
    sess.lastKeyboardJson = nextKeyboardJson;
    sess.stats.sentCount += 1;
    sess.panelBuriedByNewMessages = false;
    sess.lastSeenChatMessageId = Math.max(
      sess.lastSeenChatMessageId ?? 0,
      sent.messageId
    );
    if (
      oldMessageId !== undefined &&
      oldMessageId !== sent.messageId &&
      transport?.deleteMessage
    ) {
      await transport.deleteMessage(oldMessageId).catch(() => undefined);
    }
    if (transport?.pinMessage) {
      await transport.pinMessage(sent.messageId).catch(() => undefined);
      sess.pinnedMessageId = sent.messageId;
    }
    return 'NEW_MESSAGE';
  }
}

/**
 * Wraps a grammY Context into a TelegramMessageTransport so callback queries
 * edit the active menu message in-place and buried panels re-anchor at the bottom
 * of the chat, deleting the old panel and pinning the new one.
 */
export function createGrammyTransport(
  ctx: {
    chat?: { id: number };
    callbackQuery?: { message?: { message_id: number } };
    reply: (
      text: string,
      other?: Record<string, unknown>
    ) => Promise<{ message_id: number }>;
    editMessageText: (
      text: string,
      other?: Record<string, unknown>
    ) => Promise<unknown>;
    editMessageReplyMarkup: (other?: Record<string, unknown>) => Promise<unknown>;
    answerCallbackQuery: (other?: Record<string, unknown>) => Promise<unknown>;
    api?: {
      editMessageText: (
        chatId: number,
        messageId: number,
        text: string,
        other?: Record<string, unknown>
      ) => Promise<unknown>;
      editMessageReplyMarkup: (
        chatId: number,
        messageId: number,
        other?: Record<string, unknown>
      ) => Promise<unknown>;
      deleteMessage?: (chatId: number, messageId: number) => Promise<unknown>;
      pinChatMessage?: (
        chatId: number,
        messageId: number,
        other?: Record<string, unknown>
      ) => Promise<unknown>;
      unpinChatMessage?: (
        chatId: number,
        messageId?: number
      ) => Promise<unknown>;
    };
  },
  uiState: BotUiStateManager,
  userId: number
): TelegramMessageTransport {
  const callbackMsgId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chat?.id;
  if (callbackMsgId !== undefined) {
    uiState.setActiveMessage(userId, callbackMsgId, chatId);
  }

  const sendNewMessageImpl = async (
    text: string,
    keyboard: InlineKeyboardRows
  ): Promise<{ messageId: number }> => {
    try {
      const sent = await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: toGrammyInlineKeyboard(keyboard),
      });
      uiState.recordChatActivityMessageId(userId, sent.message_id);
      return { messageId: sent.message_id };
    } catch (err) {
      if (isMarkdownEntityError(err)) {
        const sent = await ctx.reply(stripMarkdown(text), {
          reply_markup: toGrammyInlineKeyboard(keyboard),
        });
        uiState.recordChatActivityMessageId(userId, sent.message_id);
        return { messageId: sent.message_id };
      }
      throw err;
    }
  };

  return {
    sendNewMessage: sendNewMessageImpl,
    sendMessage: sendNewMessageImpl,
    editMessageText: async (messageId, text, keyboard) => {
      const editFn = async (parseMode?: 'Markdown') => {
        const opts = {
          ...(parseMode ? { parse_mode: parseMode } : {}),
          reply_markup: toGrammyInlineKeyboard(keyboard),
        };
        if (ctx.callbackQuery?.message?.message_id === messageId) {
          await ctx.editMessageText(parseMode ? text : stripMarkdown(text), opts);
        } else if (ctx.api && chatId !== undefined) {
          await ctx.api.editMessageText(
            chatId,
            messageId,
            parseMode ? text : stripMarkdown(text),
            opts
          );
        } else {
          await ctx.editMessageText(parseMode ? text : stripMarkdown(text), opts);
        }
      };

      try {
        await editFn('Markdown');
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          return;
        }
        if (isTelegramRateLimitError(err)) {
          log.warn('Telegram 429 rate limit during editMessageText; skipping', {
            userId,
            messageId,
          });
          return;
        }
        if (isMarkdownEntityError(err)) {
          try {
            await editFn(undefined);
          } catch (retryErr) {
            if (
              isMessageNotModifiedError(retryErr) ||
              isTelegramRateLimitError(retryErr)
            ) {
              return;
            }
            throw retryErr;
          }
          return;
        }
        throw err;
      }
    },
    editMessageReplyMarkup: async (messageId, keyboard) => {
      try {
        if (ctx.callbackQuery?.message?.message_id === messageId) {
          await ctx.editMessageReplyMarkup({
            reply_markup: toGrammyInlineKeyboard(keyboard),
          });
        } else if (ctx.api && chatId !== undefined) {
          await ctx.api.editMessageReplyMarkup(chatId, messageId, {
            reply_markup: toGrammyInlineKeyboard(keyboard),
          });
        } else {
          await ctx.editMessageReplyMarkup({
            reply_markup: toGrammyInlineKeyboard(keyboard),
          });
        }
      } catch (err) {
        if (isMessageNotModifiedError(err) || isTelegramRateLimitError(err)) {
          return;
        }
        throw err;
      }
    },
    answerCallbackQuery: async (options) => {
      await ctx.answerCallbackQuery({
        text: options?.text,
        show_alert: options?.showAlert,
      });
    },
    deleteMessage: async (messageId: number) => {
      if (ctx.api?.deleteMessage && chatId !== undefined) {
        await ctx.api.deleteMessage(chatId, messageId).catch(() => undefined);
      }
    },
    pinMessage: async (messageId: number) => {
      if (ctx.api?.pinChatMessage && chatId !== undefined) {
        await ctx.api
          .pinChatMessage(chatId, messageId, { disable_notification: true })
          .catch(() => undefined);
      }
    },
    unpinMessage: async (messageId: number) => {
      if (ctx.api?.unpinChatMessage && chatId !== undefined) {
        await ctx.api
          .unpinChatMessage(chatId, messageId)
          .catch(() => undefined);
      }
    },
    sendMediaAttachment: async (attachment) => {
      let inputFile: InputFile;
      if (attachment.buffer && attachment.buffer.length > 0) {
        inputFile = new InputFile(
          attachment.buffer,
          attachment.fileName || 'profile_hd.jpg'
        );
      } else if (attachment.filePath && fs.existsSync(attachment.filePath)) {
        inputFile = new InputFile(attachment.filePath, attachment.fileName);
      } else {
        return;
      }
      const anyCtx = ctx as Record<string, unknown>;
      const safeCaption =
        attachment.caption && attachment.caption.length > 1024
          ? `${attachment.caption.slice(0, 1020)}...`
          : attachment.caption;
      const captionOpts = safeCaption ? { caption: safeCaption } : {};
      let sentMedia: unknown;
      if (
        attachment.kind === 'photo' &&
        typeof anyCtx.replyWithPhoto === 'function'
      ) {
        sentMedia = await (
          anyCtx.replyWithPhoto as (
            f: InputFile,
            o?: Record<string, unknown>
          ) => Promise<unknown>
        )(inputFile, captionOpts);
      } else if (
        attachment.kind === 'video' &&
        typeof anyCtx.replyWithVideo === 'function'
      ) {
        sentMedia = await (
          anyCtx.replyWithVideo as (
            f: InputFile,
            o?: Record<string, unknown>
          ) => Promise<unknown>
        )(inputFile, captionOpts);
      } else if (
        attachment.kind === 'audio' &&
        typeof anyCtx.replyWithAudio === 'function'
      ) {
        sentMedia = await (
          anyCtx.replyWithAudio as (
            f: InputFile,
            o?: Record<string, unknown>
          ) => Promise<unknown>
        )(inputFile, captionOpts);
      } else if (typeof anyCtx.replyWithDocument === 'function') {
        sentMedia = await (
          anyCtx.replyWithDocument as (
            f: InputFile,
            o?: Record<string, unknown>
          ) => Promise<unknown>
        )(inputFile, captionOpts);
      }
      const sentId =
        sentMedia &&
        typeof sentMedia === 'object' &&
        'message_id' in sentMedia &&
        typeof (sentMedia as { message_id?: unknown }).message_id === 'number'
          ? (sentMedia as { message_id: number }).message_id
          : undefined;
      if (sentId !== undefined) {
        uiState.recordChatActivityMessageId(userId, sentId);
        return { messageId: sentId };
      }
    },
  };
}
