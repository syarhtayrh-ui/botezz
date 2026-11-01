import fs from 'node:fs';
import {
  InboxRepository,
  IncomingMessageRecord,
} from '../../database/repositories/inbox-repository';
import { IncomingMessageReceiver } from '../../whatsapp/incoming-message-receiver';
import { SessionManager } from '../../whatsapp/session-manager';
import {
  InlineButtonSpec,
  InlineKeyboardRows,
  buildAppNavigationRow,
} from '../keyboards/main-menu';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { escapeMarkdown } from '../../utils/markdown';

export type InboxFilterKind = 'ALL' | 'MEDIA' | 'STICKERS' | 'TEXT';

export class InboxHandler {
  private readonly filterByAdmin = new Map<number, InboxFilterKind>();

  constructor(
    private readonly inboxRepo: InboxRepository,
    private readonly receiver: IncomingMessageReceiver,
    private readonly sessionManager: SessionManager
  ) {}

  private getFilter(adminId: number): InboxFilterKind {
    return this.filterByAdmin.get(adminId) || 'ALL';
  }

  public setFilter(adminId: number, filter: InboxFilterKind): BotViewResponse {
    this.filterByAdmin.set(adminId, filter);
    return this.renderInboxMenu(adminId, 1);
  }

  public toggleAutoForward(adminId: number): BotViewResponse {
    this.receiver.toggleAutoForward(adminId);
    return this.renderInboxMenu(adminId, 1);
  }

  private filterRecords(
    records: IncomingMessageRecord[],
    filter: InboxFilterKind
  ): IncomingMessageRecord[] {
    if (filter === 'ALL') return records;
    if (filter === 'STICKERS') {
      return records.filter((r) => r.kind === 'sticker');
    }
    if (filter === 'MEDIA') {
      return records.filter((r) =>
        ['image', 'video', 'audio', 'document', 'location', 'contact'].includes(
          r.kind
        )
      );
    }
    return records.filter(
      (r) =>
        !['sticker', 'image', 'video', 'audio', 'document'].includes(r.kind)
    );
  }

  private kindIcon(kind: string): string {
    switch (kind) {
      case 'image':
        return '🖼️';
      case 'video':
        return '🎬';
      case 'audio':
        return '🎙️';
      case 'sticker':
        return '🎨';
      case 'document':
        return '📄';
      case 'location':
        return '📍';
      case 'contact':
        return '👤';
      case 'poll':
        return '📊';
      default:
        return '💬';
    }
  }

  public renderInboxMenu(adminId: number, page = 1): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const allRecords = this.inboxRepo.listForOwner(
      adminId,
      isOwner,
      undefined,
      100
    );
    const currentFilter = this.getFilter(adminId);
    const filtered = this.filterRecords(allRecords, currentFilter);

    const pageSize = 5;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const slice = filtered.slice(
      (safePage - 1) * pageSize,
      safePage * pageSize
    );

    const autoForward = this.receiver.isAutoForwardEnabled(adminId);

    const lines = [
      '📥 *قسم استقبال الرسائل وأرشيف الملفات الواردة*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      `• *إجمالي الرسائل المؤرشفة:* \`${allRecords.length}\` رسالة`,
      `• *الفلتر الحالي:* \`${currentFilter}\` (${filtered.length})`,
      `• *التحويل التلقائي كملفات لتيليجرام:* ${autoForward ? '🟢 مفعّل' : '⚪ معطّل'}`,
      '',
    ];

    if (slice.length === 0) {
      lines.push(
        '📭 لا توجد رسائل واردة مطابقة للفلتر الحالي بعد.',
        '💡 جميع الرسائل الواردة للجلسات المتصلة يتم تحويلها وحفظها تلقائياً كملفات قابلة للتحميل (`.txt`, `.png`, `.mp4`, `.ogg`, `.webp`, `.geojson`, `.vcf`).'
      );
    } else {
      lines.push(
        '*أحدث الرسائل الواردة (اضغط على أي رسالة لعرضها أو تحميل ملفها):*'
      );
      slice.forEach((rec, idx) => {
        const icon = this.kindIcon(rec.kind);
        const sender = escapeMarkdown(
          rec.sender_name || rec.sender_phone || 'مرسل'
        );
        const preview = escapeMarkdown(
          (rec.text_content || rec.file_name || rec.kind).slice(0, 45)
        );
        lines.push(
          `${(safePage - 1) * pageSize + idx + 1}. ${icon} *${sender}* (\`${escapeMarkdown(rec.sender_phone)}\`)\n   └ 📄 \`${escapeMarkdown(rec.file_name || 'file')}\` — ${preview}`
        );
      });
    }

    const rows: InlineKeyboardRows = [];

    for (const rec of slice) {
      const icon = this.kindIcon(rec.kind);
      const shortSender = (rec.sender_name || rec.sender_phone).slice(0, 16);
      rows.push([
        {
          text: `${icon} ${shortSender} (${rec.file_name || rec.kind})`,
          callbackData: `inbox:view:${rec.id}`,
        },
        {
          text: '⬇️ تحميل الملف',
          callbackData: `inbox:dl:${rec.id}`,
        },
      ]);
    }

    rows.push([
      {
        text: `${currentFilter === 'ALL' ? '✅ ' : ''}الكل`,
        callbackData: 'inbox:filter:ALL',
      },
      {
        text: `${currentFilter === 'MEDIA' ? '✅ ' : ''}وسائط`,
        callbackData: 'inbox:filter:MEDIA',
      },
      {
        text: `${currentFilter === 'STICKERS' ? '✅ ' : ''}ملصقات`,
        callbackData: 'inbox:filter:STICKERS',
      },
      {
        text: `${currentFilter === 'TEXT' ? '✅ ' : ''}نصوص`,
        callbackData: 'inbox:filter:TEXT',
      },
    ]);

    if (totalPages > 1) {
      const navRow: InlineButtonSpec[] = [];
      if (safePage > 1) {
        navRow.push({
          text: '⬅️ السابق',
          callbackData: `menu:inbox:page:${safePage - 1}`,
        });
      }
      if (safePage < totalPages) {
        navRow.push({
          text: 'التالي ➡️',
          callbackData: `menu:inbox:page:${safePage + 1}`,
        });
      }
      if (navRow.length > 0) {
        rows.push(navRow);
      }
    }

    rows.push([
      {
        text: `🔔 التحويل التلقائي: ${autoForward ? 'مفعّل ✅' : 'معطّل ❌'}`,
        callbackData: 'inbox:toggle_autoforward',
      },
      {
        text: '🧪 توليد رسائل واردة تجريبية',
        callbackData: 'inbox:simulate_batch',
      },
    ]);

    rows.push(
      buildAppNavigationRow({
        backCallback: 'menu:main',
        refreshCallback: `menu:inbox:page:${safePage}`,
      })
    );

    return {
      text: lines.join('\n'),
      keyboard: rows,
    };
  }

  public viewMessage(_adminId: number, recordId: string): BotViewResponse {
    const rec = this.inboxRepo.findById(recordId);
    if (!rec) {
      return {
        text: '⚠️ لم يتم العثور على الرسالة المطلوبة.',
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الاستقبال',
              callbackData: 'menu:inbox:page:1',
            },
          ],
        ],
      };
    }

    const existsOnDisk = Boolean(
      rec.file_path && fs.existsSync(rec.file_path)
    );

    return {
      text: [
        `${this.kindIcon(rec.kind)} *تفاصيل الرسالة الواردة المؤرشفة*`,
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *المعرف:* \`${escapeMarkdown(rec.id)}\``,
        `• *الجلسة:* \`${escapeMarkdown(rec.session_id)}\``,
        `• *المرسل:* ${escapeMarkdown(rec.sender_name || rec.sender_phone)} (\`${escapeMarkdown(rec.sender_phone)}\`)`,
        `• *نوع الرسالة:* \`${escapeMarkdown(rec.kind)}\``,
        `• *اسم الملف المحفوظ:* \`${escapeMarkdown(rec.file_name || 'N/A')}\``,
        `• *نوع الملف (MIME):* \`${escapeMarkdown(rec.mime_type || 'N/A')}\``,
        `• *حجم الملف:* \`${rec.size_bytes}\` بايت (${existsOnDisk ? '🟢 جاهز للتحميل' : '⚪ غير متاح'})`,
        `• *التوقيت:* \`${escapeMarkdown(rec.received_at)}\``,
        '',
        '📝 *محتوى / وصف الرسالة:*',
        escapeMarkdown((rec.text_content || '(بدون نص)').slice(0, 800)),
      ].join('\n'),
      keyboard: [
        [
          {
            text: '⬇️ إرسال وتحميل الملف الآن في تيليجرام',
            callbackData: `inbox:dl:${rec.id}`,
          },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:inbox:page:1',
          refreshCallback: `inbox:view:${rec.id}`,
        }),
      ],
    };
  }

  public downloadMessageFile(
    adminId: number,
    recordId: string
  ): BotViewResponse {
    const rec = this.inboxRepo.findById(recordId);
    if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) {
      return {
        text: '⚠️ ملف هذه الرسالة غير موجود على القرص.',
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الاستقبال',
              callbackData: 'menu:inbox:page:1',
            },
          ],
        ],
      };
    }

    const attachment = this.receiver.toTelegramAttachment(rec);
    const view = this.viewMessage(adminId, recordId);
    return {
      ...view,
      toastText: `⬇️ جاري إرسال الملف (${rec.file_name})...`,
      mediaAttachments: [attachment],
    };
  }

  public async simulateBatch(adminId: number): Promise<BotViewResponse> {
    const sessions = this.sessionManager.listSessions(adminId);
    let sessionId = sessions[0]?.id;
    if (!sessionId) {
      const createdSess = this.sessionManager.createSession(
        'جلسة استقبال افتراضية',
        adminId
      );
      sessionId = createdSess.id;
    }

    const created = await this.receiver.simulateIncomingBatch(
      sessionId,
      adminId
    );
    const attachments = created
      .filter((r) => r.file_path && fs.existsSync(r.file_path))
      .map((r) => this.receiver.toTelegramAttachment(r));

    const view = this.renderInboxMenu(adminId, 1);
    return {
      ...view,
      toastText: `✅ تم استقبال وأرشفة ${created.length} رسائل كملفات قابلة للتحميل`,
      mediaAttachments: attachments,
    };
  }
}
