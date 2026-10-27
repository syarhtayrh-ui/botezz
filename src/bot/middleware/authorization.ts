import { Context, NextFunction } from 'grammy';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { AuthorizationError } from '../../utils/errors';
import { createLogger } from '../../logging/logger';

const log = createLogger('auth-middleware');

/**
 * Verifies whether a numeric Telegram User ID matches the configured administrator ID.
 * Denies access by default if configuredAdminId is missing, zero, or non-matching.
 */
export function verifyTelegramAdmin(params: {
  candidateUserId: number | undefined | null;
  configuredAdminId: number | undefined | null;
  actionDescription: string;
  auditRepo?: AuditRepository;
}): void {
  const { candidateUserId, configuredAdminId, actionDescription, auditRepo } = params;

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
    !candidateUserId ||
    !Number.isSafeInteger(candidateUserId) ||
    candidateUserId !== configuredAdminId
  ) {
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
      '⛔ غير مصرح لك باستخدام هذا البوت. هذه اللوحة مخصصة للمسؤول المعتمد فقط.'
    );
  }
}

/**
 * grammY middleware that enforces strict numeric administrator allowlist on every
 * message, command, and callback query before any handler runs.
 */
export function createGrammyAuthorizationMiddleware(
  configuredAdminId: number,
  auditRepo: AuditRepository
) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const candidateUserId = ctx.from?.id;
    const actionDescription = ctx.callbackQuery?.data
      ? `callback:${ctx.callbackQuery.data}`
      : ctx.message?.text
      ? `message:${ctx.message.text.slice(0, 32)}`
      : 'telegram_update';

    try {
      verifyTelegramAdmin({
        candidateUserId,
        configuredAdminId,
        actionDescription,
        auditRepo,
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
