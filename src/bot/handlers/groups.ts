import { SessionManager } from '../../whatsapp/session-manager';
import { GroupOperations } from '../../whatsapp/operations/group-operations';
import { GroupWorkflow } from '../workflows/group-workflow';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { InlineKeyboardRows } from '../keyboards/main-menu';
import { toSafeArabicError } from '../../utils/errors';

export class GroupsHandler {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly groupOps: GroupOperations,
    private readonly groupWorkflow: GroupWorkflow
  ) {}

  public renderGroupManagementSubmenu(): BotViewResponse {
    const connected = this.sessionManager
      .listSessions()
      .filter((s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED');

    const rows: InlineKeyboardRows = [];
    for (const sess of connected) {
      rows.push([
        {
          text: `👥 عرض مجموعات: ${sess.label} (${sess.masked_phone || sess.id})`,
          callbackData: `grp:list:${sess.id}`,
        },
      ]);
    }

    rows.push([
      { text: '🔗 الانضمام إلى مجموعة برابط دعوة', callbackData: 'menu:join_group' },
    ]);
    rows.push([{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }]);

    return {
      text:
        `👥 *إدارة المجموعات (Group Management)*\n\n` +
        (connected.length > 0
          ? `اختر الجلسة المتصلة لعرض المجموعات المتاحة وإدارتها:`
          : `⚠️ لا توجد جلسات متصلة حالياً. يرجى ربط جلسة أو إعادة اتصالها أولاً.`),
      keyboard: rows,
    };
  }

  public async renderSessionGroups(sessionId: string): Promise<BotViewResponse> {
    try {
      const groups = await this.groupOps.listGroups(sessionId);
      const rows: InlineKeyboardRows = [];

      for (const g of groups) {
        const roleTag = g.isBotAdmin ? '🛡️ مشرف' : '👤 عضو';
        rows.push([
          {
            text: `${roleTag} | ${g.subject} (${g.size} عضو)`,
            callbackData: `grp:view:${sessionId}:${g.jid}`,
          },
        ]);
      }

      rows.push([
        { text: '🔙 رجوع لإدارة المجموعات', callbackData: 'menu:groups' },
        { text: '🏠 القائمة الرئيسية', callbackData: 'menu:main' },
      ]);

      const summaryLines = groups
        .map(
          (g) =>
            `• *${g.subject}* — ${g.isBotAdmin ? '🛡️ مشرف' : '👤 عضو'} (${g.size} مشارك)`
        )
        .join('\n');

      return {
        text:
          `👥 *المجموعات المتاحة للجلسة (${sessionId})*\n` +
          `عدد المجموعات: *${groups.length}*\n\n` +
          `${summaryLines}\n\n` +
          `اختر مجموعة لعرض تفاصيلها، المشاركين، أو تنفيذ إجراءات الإدارة:`,
        keyboard: rows,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [[{ text: '🔙 رجوع لإدارة المجموعات', callbackData: 'menu:groups' }]],
      };
    }
  }
}
