import { InlineKeyboardRows, toGrammyInlineKeyboard } from './keyboards/main-menu';
import { BotViewResponse } from './workflows/pairing-workflow';
import { toSafeArabicError } from '../utils/errors';
import { createLogger } from '../logging/logger';

const log = createLogger('bot-ui-state');

export type UiDeliveryMode =
  | 'EDIT_TEXT'
  | 'EDIT_MARKUP'
  | 'NOT_MODIFIED'
  | 'NEW_MESSAGE'
  | 'DUPLICATE_BLOCKED';

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
  lastText?: string;
  lastKeyboardJson?: string;
  currentRoute: string;
  history: string[];
  lastView?: BotViewResponse;
  inFlightCallbacks: Set<string>;
  lastCallbackAt: Map<string, number>;
  stats: UiSessionStats;
}

export interface TelegramMessageTransport {
  sendNewMessage(
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
  answerCallbackQuery?(options?: {
    text?: string;
    showAlert?: boolean;
  }): Promise<void>;
}

/**
 * Checks whether an error from Telegram / grammY is the benign
 * "Bad Request: message is not modified" response.
 */
export function isMessageNotModifiedError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'description' in err
        ? String((err as { description?: unknown }).description)
        : String(err);
  return msg.toLowerCase().includes('message is not modified');
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
    callbackData.startsWith('grp:view:') ||
    callbackData.startsWith('task:view:') ||
    callbackData === 'settings:view_access' ||
    callbackData === 'tools:ceksender' ||
    callbackData === 'tools:cekall' ||
    callbackData === 'tools:info' ||
    callbackData === 'tools:gempa' ||
    callbackData === 'tools:prompt_testfunction' ||
    callbackData === 'tools:prompt_channel' ||
    callbackData === 'tools:prompt_ip' ||
    callbackData === 'tools:prompt_shortlink'
  );
}

/**
 * Stateful UI and Single-Message Navigation Manager.
 * Ensures the Telegram bot behaves like a modern single-message interactive application:
 * - Edits existing messages in-place via editMessageText or editMessageReplyMarkup
 * - Absorbs "message is not modified" gracefully
 * - Falls back to sending a new message only when no active message exists or edit fails
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
        currentRoute: 'menu:main',
        history: [],
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

  /**
   * Delivers a BotViewResponse over a Telegram transport (or simulated transport)
   * by editing the active menu message in-place whenever possible.
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
    const nextKeyboardJson = JSON.stringify(view.keyboard);

    let deliveryMode: UiDeliveryMode = 'NEW_MESSAGE';

    if (preferEdit && sess.activeMessageId !== undefined) {
      const sameText = sess.lastText === view.text;
      const sameKeyboard = sess.lastKeyboardJson === nextKeyboardJson;

      if (sameText && sameKeyboard) {
        // Text and keyboard are both identical -> try editMessageText if transport provided
        // so Telegram "message is not modified" is also handled gracefully, or mark NOT_MODIFIED
        if (transport) {
          try {
            await transport.editMessageText(
              sess.activeMessageId,
              view.text,
              view.keyboard
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
        // Only the inline keyboard changed -> use editMessageReplyMarkup!
        try {
          if (transport) {
            await transport.editMessageReplyMarkup(
              sess.activeMessageId,
              view.keyboard
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
            // Fallback to editMessageText or new message
            deliveryMode = await this.fallbackEditOrSend(
              sess,
              view,
              nextKeyboardJson,
              transport
            );
          }
        }
      } else {
        // Message text changed -> use editMessageText!
        deliveryMode = await this.fallbackEditOrSend(
          sess,
          view,
          nextKeyboardJson,
          transport
        );
      }
    } else {
      // No active menu message exists yet -> send initial message and store its ID
      if (transport) {
        const sent = await transport.sendNewMessage(view.text, view.keyboard);
        sess.activeMessageId = sent.messageId;
      } else {
        this.nextSimulatedMessageId += 1;
        sess.activeMessageId = this.nextSimulatedMessageId;
      }
      sess.lastText = view.text;
      sess.lastKeyboardJson = nextKeyboardJson;
      sess.stats.sentCount += 1;
      deliveryMode = 'NEW_MESSAGE';
    }

    const enriched: BotViewResponse = {
      ...view,
      route: view.route || sess.currentRoute,
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
        log.warn('Failed to edit existing menu message; falling back to new message', {
          userId: sess.userId,
          activeMessageId: sess.activeMessageId,
          reason: toSafeArabicError(err).sanitizedTechnicalMessage,
        });
      }
    }

    if (transport) {
      const sent = await transport.sendNewMessage(view.text, view.keyboard);
      sess.activeMessageId = sent.messageId;
    } else {
      this.nextSimulatedMessageId += 1;
      sess.activeMessageId = this.nextSimulatedMessageId;
    }
    sess.lastText = view.text;
    sess.lastKeyboardJson = nextKeyboardJson;
    sess.stats.sentCount += 1;
    return 'NEW_MESSAGE';
  }
}

/**
 * Wraps a grammY Context into a TelegramMessageTransport so callback queries
 * and text workflows edit the active menu message in-place.
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

  return {
    sendNewMessage: async (text, keyboard) => {
      const sent = await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: toGrammyInlineKeyboard(keyboard),
      });
      return { messageId: sent.message_id };
    },
    editMessageText: async (messageId, text, keyboard) => {
      if (ctx.callbackQuery?.message?.message_id === messageId) {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          reply_markup: toGrammyInlineKeyboard(keyboard),
        });
      } else if (ctx.api && chatId !== undefined) {
        await ctx.api.editMessageText(chatId, messageId, text, {
          parse_mode: 'Markdown',
          reply_markup: toGrammyInlineKeyboard(keyboard),
        });
      } else {
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          reply_markup: toGrammyInlineKeyboard(keyboard),
        });
      }
    },
    editMessageReplyMarkup: async (messageId, keyboard) => {
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
    },
    answerCallbackQuery: async (options) => {
      await ctx.answerCallbackQuery({
        text: options?.text,
        show_alert: options?.showAlert,
      });
    },
  };
}
