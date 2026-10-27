import { SettingsRepository } from '../../database/repositories/settings-repository';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { AppConfig } from '../../config/env';

export class SettingsHandler {
  constructor(
    private readonly settingsRepo: SettingsRepository,
    private readonly auditRepo: AuditRepository,
    private readonly config: AppConfig
  ) {}

  public renderSettings(): BotViewResponse {
    const rateLimitMode =
      this.settingsRepo.get('rate_limit_profile', 'STANDARD') || 'STANDARD';
    const notifications =
      this.settingsRepo.get('notify_on_disconnect', 'ENABLED') || 'ENABLED';
    const cooldownSeconds = this.settingsRepo.getCooldownSeconds();
    const premiumList = this.settingsRepo.listPremiumSubscriptions();
    const claimGroups = this.settingsRepo.listClaimGroups();

    return {
      text:
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
            text: `⏳ تغيير التهدئة (${cooldownSeconds}s)`,
            callbackData: 'settings:cycle_cooldown',
          },
        ],
        [
          {
            text: '⭐ إدارة الاشتراكات والمجموعات',
            callbackData: 'settings:view_access',
          },
          {
            text: '🛠️ الأدوات والفحص المتقدم',
            callbackData: 'menu:tools',
          },
        ],
        [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
      ],
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
    }

    return this.renderSettings();
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
    return this.renderSettings();
  }

  public renderAccessControlSummary(): BotViewResponse {
    const subs = this.settingsRepo.listPremiumSubscriptions();
    const groups = this.settingsRepo.listClaimGroups();

    const subsText =
      subs.length === 0
        ? 'لا توجد اشتراكات مفعلة حالياً.'
        : subs
            .slice(0, 10)
            .map(
              (s, i) =>
                `${i + 1}. \`${s.targetId}\` (${s.targetType}) — ينتهي: \`${s.expiresAtIso.slice(0, 10)}\``
            )
            .join('\n');

    const groupsText =
      groups.length === 0
        ? 'لا توجد مجموعات تفعيل مسجلة.'
        : groups
            .slice(0, 10)
            .map((g, i) => `${i + 1}. *${g.title}* (\`${g.groupId}\`)`)
            .join('\n');

    return {
      text:
        `⭐ *إدارة الاشتراكات ومجموعات التفعيل (SQLite)*\n\n` +
        `📋 *الاشتراكات النشطة (${subs.length}):*\n${subsText}\n\n` +
        `👥 *مجموعات المطالبة بالتفعيل (${groups.length}):*\n${groupsText}\n\n` +
        `📌 *الأوامر المباشرة المدعومة:*\n` +
        `• \`/addpremium <id> <days>\` — إضافة اشتراك مستخدم\n` +
        `• \`/delpremium <id>\` — حذف اشتراك مستخدم\n` +
        `• \`/cekprem\` — فحص حالة الاشتراك\n` +
        `• \`/addgcpremium <groupId> <days>\` — إضافة اشتراك مجموعة\n` +
        `• \`/delgcpremium <groupId>\` — حذف اشتراك مجموعة\n` +
        `• \`/addgb <groupId>\` | \`/delgb <groupId>\` | \`/listgb\` | \`/claim\`\n` +
        `• \`/setcooldown <seconds>\` — ضبط مهلة التهدئة`,
      keyboard: [
        [
          { text: '🔄 تحديث القائمة', callbackData: 'settings:view_access' },
          { text: '🔙 العودة للإعدادات', callbackData: 'menu:settings' },
        ],
      ],
    };
  }
}
