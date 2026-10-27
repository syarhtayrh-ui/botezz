import { buildMainMenuKeyboard } from '../keyboards/main-menu';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { SessionManager } from '../../whatsapp/session-manager';
import { TaskManager } from '../../tasks/task-manager';

/**
 * Formats process uptime as `Xh Ym Zs` (extracted from Nebula `formatRuntime`).
 */
export function formatRuntime(uptimeSeconds = process.uptime()): string {
  let sec = Math.floor(Math.max(0, uptimeSeconds));
  const hrs = Math.floor(sec / 3600);
  sec %= 3600;
  const mins = Math.floor(sec / 60);
  sec %= 60;
  return `${hrs}h ${mins}m ${sec}s`;
}

/**
 * Formats RSS memory usage in MB (extracted from Nebula `formatMemory`).
 */
export function formatMemory(rssBytes = process.memoryUsage().rss): string {
  const usedMB = rssBytes / 1024 / 1024;
  return `${usedMB.toFixed(0)} MB`;
}

export class StartHandler {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly taskManager: TaskManager
  ) {}

  public renderMainMenu(): BotViewResponse {
    const sessions = this.sessionManager.listSessions();
    const connectedCount = sessions.filter(
      (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
    ).length;

    return {
      text:
        `👋 *مرحباً بك في لوحة التحكم المركزية لجلسات واتساب*\n\n` +
        `📱 إجمالي الجلسات المسجلة: *${sessions.length}* (المتصل منها: *${connectedCount}*)\n` +
        `⏱️ مدة التشغيل: \`${formatRuntime()}\` | الذاكرة: \`${formatMemory()}\`\n` +
        `⚡ اختر العملية المطلوبة من القائمة التفاعلية أدناه:`,
      keyboard: buildMainMenuKeyboard(),
    };
  }

  public renderHelpAndSystemStatus(): BotViewResponse {
    const sessions = this.sessionManager.listSessions();
    const connectedCount = sessions.filter(
      (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
    ).length;
    const disconnectedCount = sessions.length - connectedCount;
    const stats = this.taskManager.getRunnerStats();
    const lastSuccess =
      this.taskManager.getLastSuccessfulOperationAt() || 'لم تسجل عمليات بعد';

    return {
      text:
        `ℹ️ *المساعدة وحالة النظام (System Health)*\n\n` +
        `🟢 *حالة التطبيق:* يعمل بشكل سليم\n` +
        `🤖 *واجهة تيليجرام:* متصلة ومحمية بقائمة السماح (Allowlist)\n` +
        `📱 *الجلسات المتصلة:* ${connectedCount} | *غير المتصلة:* ${disconnectedCount}\n` +
        `🔄 *المهام الجارية حالياً:* ${stats.active} (الحد الأقصى المتزامن: ${stats.max})\n` +
        `⏳ *المهام المنتظرة في الطابور:* ${stats.queued}\n` +
        `⏱️ *مدة التشغيل (Runtime):* \`${formatRuntime()}\`\n` +
        `💾 *استهلاك الذاكرة (RSS):* \`${formatMemory()}\`\n` +
        `🕒 *آخر عملية ناجحة:* \`${lastSuccess}\`\n\n` +
        `⚠️ *تنبيه تقني هام:*\n` +
        `تعتمد هذه المنصة على مكتبة Athanasia Baileys (\`athanasia-baileys@1.0.0\`) كبروتوكول غير رسمي لواتساب ويب. قد تخضع الحسابات لقيود المنصة أو انتهاء صلاحية الجلسات عند تغيير البروتوكول.`,
      keyboard: [
        [
          { text: '📱 فحص المقابس (/ceksender)', callbackData: 'tools:ceksender' },
          { text: '📊 التقرير الشامل (/cekall)', callbackData: 'tools:cekall' },
        ],
        [
          { text: '🔄 تحديث حالة النظام', callbackData: 'menu:help_status' },
          { text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' },
        ],
      ],
    };
  }
}
