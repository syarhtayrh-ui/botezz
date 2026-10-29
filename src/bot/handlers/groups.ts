import { SessionManager } from '../../whatsapp/session-manager';
import { GroupOperations } from '../../whatsapp/operations/group-operations';
import { GroupWorkflow } from '../workflows/group-workflow';
import { BotViewResponse } from '../workflows/pairing-workflow';
import {
  InlineKeyboardRows,
  InlineButtonSpec,
  buildAppNavigationRow,
} from '../keyboards/main-menu';
import { toSafeArabicError } from '../../utils/errors';

export class GroupsHandler {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly groupOps: GroupOperations,
    private readonly groupWorkflow: GroupWorkflow
  ) {}

  public renderGroupManagementSubmenu(actorUserId?: number): BotViewResponse {
    const connected = this.sessionManager.listConnectedSessions(actorUserId);

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
    rows.push(
      buildAppNavigationRow({
        backCallback: 'nav:back',
        refreshCallback: 'menu:groups',
      })
    );

    return {
      text:
        `👥 *إدارة المجموعات (Group Management)*\n\n` +
        (connected.length > 0
          ? `اختر الجلسة المتصلة لعرض المجموعات المتاحة وإدارتها:`
          : `⚠️ لا توجد جلسات متصلة حالياً. يرجى ربط جلسة أو إعادة اتصالها أولاً.`),
      keyboard: rows,
      toastText: '👥 إدارة المجموعات',
      route: 'menu:groups',
    };
  }

  public async renderSessionGroups(
    sessionId: string,
    page = 1,
    actorUserId?: number
  ): Promise<BotViewResponse> {
    try {
      this.sessionManager.assertSessionAccess(sessionId, actorUserId);
      const groups = await this.groupOps.listGroups(sessionId);
      const pageSize = 5;
      const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
      const currentPage = Math.min(Math.max(1, page), totalPages);
      const startIdx = (currentPage - 1) * pageSize;
      const slice = groups.slice(startIdx, startIdx + pageSize);

      const rows: InlineKeyboardRows = [];

      for (const g of slice) {
        const roleTag = g.isBotAdmin ? '🛡️ مشرف' : '👤 عضو';
        const shortId = this.groupWorkflow.registerGroupRef(sessionId, g.jid);
        rows.push([
          {
            text: `${roleTag} | ${g.subject} (${g.size} عضو)`,
            callbackData: `gv:${shortId}`,
          },
        ]);
      }

      if (totalPages > 1) {
        const navRow: InlineButtonSpec[] = [];
        if (currentPage > 1) {
          navRow.push({
            text: '⬅️ السابق',
            callbackData: `grp:list_page:${sessionId}:${currentPage - 1}`,
          });
        }
        navRow.push({
          text: `صفحة ${currentPage}/${totalPages}`,
          callbackData: `grp:list_page:${sessionId}:${currentPage}`,
        });
        if (currentPage < totalPages) {
          navRow.push({
            text: 'التالي ➡️',
            callbackData: `grp:list_page:${sessionId}:${currentPage + 1}`,
          });
        }
        rows.push(navRow);
      }

      rows.push(
        buildAppNavigationRow({
          backCallback: 'menu:groups',
          refreshCallback: `grp:list:${sessionId}`,
        })
      );

      const summaryLines = slice
        .map(
          (g) =>
            `• *${g.subject}* — ${g.isBotAdmin ? '🛡️ مشرف' : '👤 عضو'} (${g.size} مشارك)`
        )
        .join('\n');

      return {
        text:
          `👥 *المجموعات المتاحة للجلسة (${sessionId})*\n` +
          `عدد المجموعات: *${groups.length}* (صفحة ${currentPage}/${totalPages})\n\n` +
          `${summaryLines}\n\n` +
          `اختر مجموعة لعرض تفاصيلها، المشاركين، أو تنفيذ إجراءات الإدارة:`,
        keyboard: rows,
        toastText: `👥 مجموعات ${sessionId}`,
        route: `grp:list:${sessionId}`,
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}`,
        keyboard: [
          buildAppNavigationRow({
            backCallback: 'menu:groups',
            refreshCallback: 'menu:groups',
          }),
        ],
        toastText: safeErr.userMessage,
        showAlert: true,
      };
    }
  }
}
