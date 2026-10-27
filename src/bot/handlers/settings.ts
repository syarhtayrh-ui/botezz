import { SettingsRepository } from '../../database/repositories/settings-repository';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { BotViewResponse } from '../workflows/pairing-workflow';
import {
  buildAppNavigationRow,
  buildBackCancelRow,
  InlineButtonSpec,
  InlineKeyboardRows,
} from '../keyboards/main-menu';
import { AppConfig } from '../../config/env';
import { toSafeArabicError } from '../../utils/errors';

export type SettingsInputStep =
  | 'NONE'
  | 'AWAITING_ADD_SUBSCRIPTION'
  | 'AWAITING_ADD_CLAIM_GROUP'
  | 'AWAITING_CUSTOM_COOLDOWN';

export class SettingsHandler {
  private readonly inputStates = new Map<number, SettingsInputStep>();

  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly auditRepo: AuditRepository,
    private readonly config: AppConfig
  ) {}

  public getStep(adminId: number): SettingsInputStep {
    return this.inputStates.get(adminId) || 'NONE';
  }

  public cancel(adminId: number): void {
    this.inputStates.delete(adminId);
  }

  public renderSettings(noticeBanner?: string): BotViewResponse {
    const rateLimitMode =
      this.settingsRepo.get('rate_limit_profile', 'STANDARD') || 'STANDARD';
    const notifications =
      this.settingsRepo.get('notify_on_disconnect', 'ENABLED') || 'ENABLED';
    const cooldownSeconds = this.settingsRepo.getCooldownSeconds();
    const premiumList = this.settingsRepo.listPremiumSubscriptions();
    const claimGroups = this.settingsRepo.listClaimGroups();

    return {
      text:
        (noticeBanner ? `${noticeBanner}\n━━━━━━━━━━━━━━━━━━\n` : '') +
        `⚙️ *إعدادات النظام والأمان والصلاحيات*\n\n` +
        `👤 *معرف المسؤول المعتمد (Allowlist):* \`${this.config.TELEGRAM_ADMIN_ID}\`\n` +
        `⚡ *الحد الأقصى للمهام المتزامنة:* ${this.config.MAX_CONCURRENT_TASKS}\n` +
        `⏱️ *مهلة المهمة الواحدة:* ${Math.round(this.config.TASK_TIMEOUT_MS / 1000)} ثانية\n` +
        `📎 *الحد الأقصى لحجم المرفقات:* ${this.config.MAX_UPLOAD_SIZE_MB} ميجابايت\n` +
        `🛡️ *نمط الحماية من التكرار (Rate Limit):* \`${rateLimitMode}\`\n` +
        `🔔 *تنبيهات انقطاع الجلسات:* \`${notifications}\`\n` +
        `⏳ *مهلة التهدئة بين الأوامر (Cooldown):* \`${cooldownSeconds} ثانية\`\n` +
        `⭐ *الاشتراكات النشطة (Premium Users/Groups):* ${premiumList.length}\n` +
        `👥 *مجموعات التفعيل المسجلة (Claim Groups):* ${claimGroups.length}`,
      keyboard: [
        [
          {
            text:
              rateLimitMode === 'STANDARD'
                ? '🛡️ تفعيل النمط الصارم (STRICT)'
                : '🛡️ تفعيل النمط القياسي (STANDARD)',
            callbackData: 'settings:toggle_ratelimit',
          },
        ],
        [
          {
            text:
              notifications === 'ENABLED'
                ? '🔕 إيقاف تنبيهات الانقطاع'
                : '🔔 تفعيل تنبيهات الانقطاع',
            callbackData: 'settings:toggle_notify',
          },
          {
            text: `⏳ تبديل التهدئة (${cooldownSeconds}s)`,
            callbackData: 'settings:cycle_cooldown',
          },
        ],
        [
          {
            text: '⏱️ إدخال مهلة تهدئة مخصصة',
            callbackData: 'settings:prompt_cooldown',
          },
          {
            text: '⭐ إدارة الاشتراكات (Premium)',
            callbackData: 'menu:subscriptions:page:1',
          },
        ],
        [
          {
            text: '🛡️ لوحة تحكم المشرف',
            callbackData: 'menu:admin',
          },
          {
            text: '🛠️ الأدوات والفحص المتقدم',
            callbackData: 'menu:tools',
          },
        ],
        buildAppNavigationRow({
          backCallback: 'nav:back',
          refreshCallback: 'menu:settings',
        }),
      ],
      toastText: '⚙️ إعدادات النظام',
      route: 'menu:settings',
    };
  }

  public toggleSetting(
    key: 'rate_limit_profile' | 'notify_on_disconnect',
    adminId: number
  ): BotViewResponse {
    if (key === 'rate_limit_profile') {
      const current = this.settingsRepo.get(key, 'STANDARD');
      const next = current === 'STANDARD' ? 'STRICT' : 'STANDARD';
      this.settingsRepo.set(key, next);
      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'SETTING_UPDATED',
        targetId: key,
        outcome: 'SUCCESS',
        metadata: { value: next },
      });
      const view = this.renderSettings();
      return {
        ...view,
        toastText: `🛡️ تم ضبط الحماية على ${next}`,
      };
    } else {
      const current = this.settingsRepo.get(key, 'ENABLED');
      const next = current === 'ENABLED' ? 'DISABLED' : 'ENABLED';
      this.settingsRepo.set(key, next);
      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'SETTING_UPDATED',
        targetId: key,
        outcome: 'SUCCESS',
        metadata: { value: next },
      });
      const view = this.renderSettings();
      return {
        ...view,
        toastText: `🔔 التنبيهات: ${next}`,
      };
    }
  }

  public cycleCooldown(adminId: number): BotViewResponse {
    const options = [0, 3, 5, 10];
    const current = this.settingsRepo.getCooldownSeconds();
    const idx = options.indexOf(current);
    const next = options[(idx + 1) % options.length];
    this.settingsRepo.setCooldownSeconds(next);
    this.auditRepo.record({
      actorTelegramId: adminId,
      action: 'COOLDOWN_UPDATED',
      targetId: 'command_cooldown_seconds',
      outcome: 'SUCCESS',
      metadata: { cooldownSeconds: next },
    });
    const view = this.renderSettings();
    return {
      ...view,
      toastText: `⏳ تم ضبط مهلة التهدئة على ${next}s`,
    };
  }

  public promptCustomCooldown(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_CUSTOM_COOLDOWN');
    const current = this.settingsRepo.getCooldownSeconds();
    return {
      text:
        `⏱️ *تحديد مهلة التهدئة بين الأوامر يدوياً (Command Cooldown)*\n\n` +
        `المهلة الحالية: \`${current} ثانية\`\n\n` +
        `أرسل عدد الثواني المطلوب (بين \`0\` و \`300\` ثانية، مثلاً: \`0\` لإلغاء التهدئة أو \`5\` لـ 5 ثوانٍ):`,
      keyboard: [buildBackCancelRow('menu:settings')],
      toastText: '⏱️ أرسل عدد الثواني المطلوب',
    };
  }

  public promptAddSubscription(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_ADD_SUBSCRIPTION');
    return {
      text:
        `⭐ *إضافة اشتراك مميز جديد (Add Premium Subscription)*\n\n` +
        `أرسل معرف المستخدم أو المجموعة متبوعاً بعدد الأيام بالصيغة التالية:\n` +
        `• مستخدم: \`123456789 30\`\n` +
        `• مجموعة: \`-100123456789 30 GROUP\``,
      keyboard: [buildBackCancelRow('menu:subscriptions:page:1')],
      toastText: '⭐ أرسل المعرف وعدد الأيام',
    };
  }

  public promptAddClaimGroup(adminId: number): BotViewResponse {
    this.inputStates.set(adminId, 'AWAITING_ADD_CLAIM_GROUP');
    return {
      text:
        `👥 *إضافة مجموعة تفعيل جديدة (Add Claim Group)*\n\n` +
        `أرسل معرف المجموعة متبوعاً باسمها التوضيحي بالصيغة التالية:\n` +
        `\`-1001234567890 مجموعة النخبة الرئيسية\``,
      keyboard: [buildBackCancelRow('menu:subscriptions:page:1')],
      toastText: '👥 أرسل معرف المجموعة واسمها',
    };
  }

  public handleGuidedInput(adminId: number, rawText: string): BotViewResponse {
    const step = this.getStep(adminId);

    if (step === 'AWAITING_CUSTOM_COOLDOWN') {
      try {
        const seconds = Number(rawText.trim().replace(/s$/i, ''));
        const updated = this.settingsRepo.setCooldownSeconds(seconds);
        this.cancel(adminId);
        this.auditRepo.record({
          actorTelegramId: adminId,
          action: 'COOLDOWN_UPDATED',
          targetId: 'command_cooldown_seconds',
          outcome: 'SUCCESS',
          metadata: { cooldownSeconds: updated },
        });
        return this.renderSettings(
          `✅ *تم ضبط مهلة التهدئة (Cooldown) على:* \`${updated} ثانية\``
        );
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text:
            `⚠️ *قيمة غير صالحة:*\n${safeErr.userMessage}\n\n` +
            `يرجى إرسال رقم بين \`0\` و \`300\`:`,
          keyboard: [buildBackCancelRow('menu:settings')],
        };
      }
    }

    if (step === 'AWAITING_ADD_SUBSCRIPTION') {
      try {
        const parts = rawText.trim().split(/\s+/);
        const targetId = parts[0] || '';
        const daysRaw = (parts[1] || '30').replace(/d$/i, '');
        const durationDays = Number(daysRaw);
        const typeRaw = (parts[2] || '').toUpperCase();
        const targetType =
          typeRaw === 'GROUP' || targetId.startsWith('-') ? 'GROUP' : 'USER';

        const entry = this.settingsRepo.addPremiumSubscription(
          targetId,
          durationDays,
          targetType
        );
        this.cancel(adminId);
        this.auditRepo.record({
          actorTelegramId: adminId,
          action: 'PREMIUM_ADDED',
          targetId: entry.targetId,
          outcome: 'SUCCESS',
          metadata: { targetType, durationDays: entry.durationDays },
        });
        return this.renderSubscriptionsMenu(
          1,
          `✅ *تم تفعيل الاشتراك (${targetType}) للمعرف \`${entry.targetId}\` لمدة ${entry.durationDays} يوم!*`
        );
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text:
            `⚠️ *تعذر إضافة الاشتراك:*\n${safeErr.userMessage}\n\n` +
            `أعد الإرسال بالصيغة \`123456789 30\` أو اضغط إلغاء:`,
          keyboard: [buildBackCancelRow('menu:subscriptions:page:1')],
        };
      }
    }

    if (step === 'AWAITING_ADD_CLAIM_GROUP') {
      try {
        const parts = rawText.trim().split(/\s+/);
        const groupId = parts[0] || '';
        const title = parts.slice(1).join(' ') || undefined;
        const entry = this.settingsRepo.addClaimGroup(groupId, title);
        this.cancel(adminId);
        return this.renderSubscriptionsMenu(
          1,
          `✅ *تمت إضافة مجموعة التفعيل:* *${entry.title}* (\`${entry.groupId}\`)`
        );
      } catch (err) {
        const safeErr = toSafeArabicError(err);
        return {
          text:
            `⚠️ *تعذر إضافة المجموعة:*\n${safeErr.userMessage}\n\n` +
            `أرسل معرف المجموعة متبوعاً بالاسم أو اضغط إلغاء:`,
          keyboard: [buildBackCancelRow('menu:subscriptions:page:1')],
        };
      }
    }

    return this.renderSettings();
  }

  public renderConfirmRemoveSubscription(targetId: string): BotViewResponse {
    return {
      text:
        `⚠️ *تأكيد إلغاء الاشتراك المميز*\n\n` +
        `هل أنت متأكد من إلغاء اشتراك المعرف \`${targetId}\` نهائياً؟`,
      keyboard: [
        [
          {
            text: '✅ نعم، إلغاء الاشتراك',
            callbackData: `sub:remove:${targetId}`,
          },
          { text: '❌ تراجع', callbackData: 'menu:subscriptions:page:1' },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:subscriptions:page:1',
          refreshCallback: 'menu:subscriptions:page:1',
        }),
      ],
      toastText: '⚠️ يرجى تأكيد إلغاء الاشتراك',
    };
  }

  public handleRemoveSubscription(targetId: string, adminId: number): BotViewResponse {
    const removed = this.settingsRepo.removePremiumSubscription(targetId);
    if (removed) {
      this.auditRepo.record({
        actorTelegramId: adminId,
        action: 'PREMIUM_REMOVED',
        targetId,
        outcome: 'SUCCESS',
      });
    }
    return this.renderSubscriptionsMenu(
      1,
      removed
        ? `🗑️ *تم إلغاء اشتراك المعرف:* \`${targetId}\``
        : `ℹ️ المعرف \`${targetId}\` غير موجود في الاشتراكات النشطة.`
    );
  }

  public renderSubscriptionsMenu(page = 1, noticeBanner?: string): BotViewResponse {
    const subs = this.settingsRepo.listPremiumSubscriptions();
    const groups = this.settingsRepo.listClaimGroups();

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(subs.length / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIdx = (currentPage - 1) * pageSize;
    const pageSubs = subs.slice(startIdx, startIdx + pageSize);

    const subsText =
      subs.length === 0
        ? 'لا توجد اشتراكات مفعلة حالياً.'
        : pageSubs
            .map(
              (s, i) =>
                `${startIdx + i + 1}. \`${s.targetId}\` (${s.targetType}) — ينتهي: \`${s.expiresAtIso.slice(0, 10)}\``
            )
            .join('\n');

    const groupsText =
      groups.length === 0
        ? 'لا توجد مجموعات تفعيل مسجلة.'
        : groups
            .slice(0, 8)
            .map((g, i) => `${i + 1}. *${g.title}* (\`${g.groupId}\`)`)
            .join('\n');

    const rows: InlineKeyboardRows = [];

    for (const s of pageSubs) {
      rows.push([
        {
          text: `🗑️ إلغاء اشتراك: ${s.targetId} (${s.targetType})`,
          callbackData: `sub:confirm_remove:${s.targetId}`,
        },
      ]);
    }

    if (totalPages > 1) {
      const navRow: InlineButtonSpec[] = [];
      if (currentPage > 1) {
        navRow.push({
          text: '⬅️ السابق',
          callbackData: `menu:subscriptions:page:${currentPage - 1}`,
        });
      }
      navRow.push({
        text: `صفحة ${currentPage}/${totalPages}`,
        callbackData: `menu:subscriptions:page:${currentPage}`,
      });
      if (currentPage < totalPages) {
        navRow.push({
          text: 'التالي ➡️',
          callbackData: `menu:subscriptions:page:${currentPage + 1}`,
        });
      }
      rows.push(navRow);
    }

    rows.push([
      { text: '➕ إضافة اشتراك جديد', callbackData: 'sub:prompt_add' },
      { text: '👥 إضافة مجموعة تفعيل', callbackData: 'sub:prompt_add_group' },
    ]);

    rows.push(
      buildAppNavigationRow({
        backCallback: 'menu:settings',
        refreshCallback: `menu:subscriptions:page:${currentPage}`,
      })
    );

    return {
      text:
        (noticeBanner ? `${noticeBanner}\n━━━━━━━━━━━━━━━━━━\n` : '') +
        `⭐ *إدارة الاشتراكات ومجموعات التفعيل (SQLite)*\n\n` +
        `📋 *الاشتراكات النشطة (${subs.length}) — صفحة ${currentPage}/${totalPages}:*\n${subsText}\n\n` +
        `👥 *مجموعات المطالبة بالتفعيل (${groups.length}):*\n${groupsText}\n\n` +
        `📌 *الأوامر المباشرة المدعومة:*\n` +
        `• \`/addpremium <id> <days>\` — إضافة اشتراك مستخدم\n` +
        `• \`/delpremium <id>\` — حذف اشتراك مستخدم\n` +
        `• \`/cekprem\` — فحص حالة الاشتراك\n` +
        `• \`/addgcpremium <groupId> <days>\` — إضافة اشتراك مجموعة\n` +
        `• \`/delgcpremium <groupId>\` — حذف اشتراك مجموعة\n` +
        `• \`/addgb <groupId>\` | \`/delgb <groupId>\` | \`/listgb\` | \`/claim\`\n` +
        `• \`/setcooldown <seconds>\` — ضبط مهلة التهدئة`,
      keyboard: rows,
      toastText: '⭐ إدارة الاشتراكات ومجموعات التفعيل',
      route: `menu:subscriptions:page:${currentPage}`,
    };
  }

  public renderAccessControlSummary(): BotViewResponse {
    return this.renderSubscriptionsMenu(1);
  }
}
