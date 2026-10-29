import { Context, NextFunction } from 'grammy';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { SettingsRepository } from '../../database/repositories/settings-repository';
import { AuthorizationError } from '../../utils/errors';
import { createLogger } from '../../logging/logger';

const log = createLogger('auth-middleware');

const OWNER_ONLY_PATTERNS = [
  /^(?:text|message):\/(?:addpremium|addprem|delpremium|delprem|addgcpremium|delgcpremium|listprem|addgb|delgb|listgb|setcooldown|admin|settings|controls|cekall)\b/i,
  /^callback:(?:menu:admin|menu:settings|menu:subscriptions|menu:audit:|tools:cekall|sub:|settings:|sess:confirm_purge_inactive|sess:purge_inactive)/i,
];

export function isOwnerOnlyAction(actionDescription: string): boolean {
  return OWNER_ONLY_PATTERNS.some((pattern) => pattern.test(actionDescription));
}

/**
 * Verifies whether a numeric Telegram User ID matches the configured administrator ID,
 * or holds an active Premium subscription (or is claiming from a registered Claim Group)
 * for non-owner actions.
 * Denies access by default if configuredAdminId is missing, zero, or non-matching.
 */
export function verifyTelegramAdmin(params: {
  candidateUserId: number | undefined | null;
  configuredAdminId: number | undefined | null;
  actionDescription: string;
  auditRepo?: AuditRepository;
  settingsRepo?: SettingsRepository;
  chatId?: number | undefined | null;
  requireOwnerOnly?: boolean;
}): void {
  const {
    candidateUserId,
    configuredAdminId,
    actionDescription,
    auditRepo,
    settingsRepo,
    chatId,
    requireOwnerOnly,
  } = params;

  if (
    !configuredAdminId ||
    !Number.isSafeInteger(configuredAdminId) ||
    configuredAdminId <= 0
  ) {
    throw new AuthorizationError(
      '⛔ الوصول مرفوض: لم يتم ضبط معرف المسؤول (TELEGRAM_ADMIN_ID) في إعدادات النظام.'
    );
  }

  if (
    candidateUserId &&
    Number.isSafeInteger(candidateUserId) &&
    candidateUserId === configuredAdminId
  ) {
    return;
  }

  // Check if a valid non-owner user is authorized via Premium Subscription or Claim Group
  if (
    candidateUserId &&
    Number.isSafeInteger(candidateUserId) &&
    candidateUserId > 0 &&
    settingsRepo &&
    !requireOwnerOnly &&
    !isOwnerOnlyAction(actionDescription)
  ) {
    // Allow /claim inside registered claim groups
    if (
      /^text:\/claim\b/i.test(actionDescription) ||
      /^message:\/claim\b/i.test(actionDescription)
    ) {
      const claimGroups = settingsRepo.listClaimGroups();
      if (
        (chatId && claimGroups.some((g) => g.groupId === String(chatId))) ||
        claimGroups.length > 0
      ) {
        return;
      }
    }

    const userPrem = settingsRepo.getPremiumStatus(candidateUserId);
    if (userPrem.isPremium) {
      return;
    }

    if (chatId && Number.isSafeInteger(chatId) && chatId !== candidateUserId) {
      const chatPrem = settingsRepo.getPremiumStatus(chatId);
      if (chatPrem.isPremium) {
        return;
      }
    }
  }

  log.warn('Unauthorized Telegram access attempt blocked', {
    candidateUserId: candidateUserId ?? 0,
    actionDescription,
  });

  if (auditRepo) {
    auditRepo.record({
      actorTelegramId: candidateUserId && candidateUserId > 0 ? candidateUserId : 0,
      action: 'UNAUTHORIZED_ACCESS_BLOCKED',
      targetId: actionDescription,
      outcome: 'DENIED',
      metadata: { candidateUserId: candidateUserId ?? null },
    });
  }

  throw new AuthorizationError(
    '⛔ غير مصرح لك باستخدام هذا البوت. هذه اللوحة مخصصة للمسؤول المعتمد والمشتركين المفعلين فقط.'
  );
}

/**
 * grammY middleware that enforces strict numeric administrator allowlist and active subscription
 * checks on every message, command, and callback query before any handler runs.
 */
export function createGrammyAuthorizationMiddleware(
  configuredAdminId: number,
  auditRepo: AuditRepository,
  settingsRepo?: SettingsRepository
) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const candidateUserId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const actionDescription = ctx.callbackQuery?.data
      ? `callback:${ctx.callbackQuery.data}`
      : ctx.message?.text
      ? `message:${ctx.message.text.slice(0, 32)}`
      : ctx.message?.caption
      ? `message:${ctx.message.caption.slice(0, 32)}`
      : 'telegram_update';

    try {
      verifyTelegramAdmin({
        candidateUserId,
        configuredAdminId,
        actionDescription,
        auditRepo,
        settingsRepo,
        chatId,
      });
      await next();
    } catch (err) {
      const msg =
        err instanceof AuthorizationError
          ? err.arabicUserMessage
          : '⛔ غير مصرح لك بالوصول.';
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: msg, show_alert: true });
      } else {
        await ctx.reply(msg);
      }
    }
  };
}
