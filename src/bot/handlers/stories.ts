import fs from 'node:fs';
import {
  StatusRepository,
  CapturedStatusRecord,
} from '../../database/repositories/status-repository';
import { StatusDownloaderService } from '../../whatsapp/status-downloader';
import { SessionManager } from '../../whatsapp/session-manager';
import {
  InlineButtonSpec,
  InlineKeyboardRows,
  buildAppNavigationRow,
} from '../keyboards/main-menu';
import { BotViewResponse } from '../workflows/pairing-workflow';
import { escapeMarkdown, truncateGraphemes } from '../../utils/markdown';

export type StoriesFilterKind = 'ALL' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT';

export class StoriesHandler {
  private readonly filterByAdmin = new Map<number, StoriesFilterKind>();

  constructor(
    private readonly statusRepo: StatusRepository,
    private readonly statusDownloader: StatusDownloaderService,
    private readonly sessionManager: SessionManager
  ) {}

  private getFilter(adminId: number): StoriesFilterKind {
    return this.filterByAdmin.get(adminId) || 'ALL';
  }

  public cancel(adminId: number): void {
    this.filterByAdmin.delete(adminId);
  }

  public setFilter(adminId: number, filter: StoriesFilterKind): BotViewResponse {
    this.filterByAdmin.set(adminId, filter);
    return this.renderStoriesMenu(adminId, 1);
  }

  public toggleAutoForward(adminId: number): BotViewResponse {
    this.statusDownloader.toggleAutoForward(adminId);
    return this.renderStoriesMenu(adminId, 1);
  }

  private filterRecords(
    records: CapturedStatusRecord[],
    filter: StoriesFilterKind
  ): CapturedStatusRecord[] {
    if (filter === 'ALL') return records;
    return records.filter((r) => r.media_kind.toUpperCase() === filter);
  }

  private kindIcon(kind: string): string {
    switch (kind) {
      case 'image':
        return '🖼️';
      case 'video':
        return '🎬';
      case 'audio':
        return '🎙️';
      default:
        return '📝';
    }
  }

  public renderStoriesMenu(adminId: number, page = 1): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const allRecords = this.statusRepo.listForOwner(
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

    const autoForward = this.statusDownloader.isAutoForwardEnabled(adminId);

    const lines = [
      '⭕ *قسم تحميلات الحالات (WhatsApp Status / Stories)*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      `• *إجمالي الحالات المحفوظة:* \`${allRecords.length}\` حالة`,
      `• *الفلتر الحالي:* \`${currentFilter}\` (${filtered.length})`,
      `• *الإرسال التلقائي للحالات الجديدة:* ${autoForward ? '🟢 مفعّل' : '⚪ معطّل'}`,
      '',
    ];

    if (slice.length === 0) {
      lines.push(
        '📭 لا توجد حالات واتساب محفوظة مطابقة للفلتر الحالي بعد.',
        '💡 يلتقط النظام تلقائياً جميع حالات جهات الاتصال (`status@broadcast`) من صور وفيديوهات ومقاطع صوتية ونصوص ويحفظها كملفات جاهزة للتحميل.'
      );
    } else {
      lines.push(
        '*أحدث الحالات الملتقطة (اضغط لتحميل الحالة أو جميع حالات الرقم):*'
      );
      slice.forEach((rec, idx) => {
        const icon = this.kindIcon(rec.media_kind);
        const sender = escapeMarkdown(
          rec.sender_name || rec.sender_phone || 'جهة اتصال'
        );
        const cap = escapeMarkdown(
          truncateGraphemes(rec.caption || rec.file_name || rec.media_kind, 45)
        );
        lines.push(
          `${(safePage - 1) * pageSize + idx + 1}. ${icon} *${sender}* (\`${escapeMarkdown(rec.sender_phone)}\`)\n   └ 📁 \`${escapeMarkdown(rec.file_name || 'status')}\` — ${cap}`
        );
      });
    }

    const rows: InlineKeyboardRows = [];

    for (const rec of slice) {
      const icon = this.kindIcon(rec.media_kind);
      const shortSender = truncateGraphemes(
        rec.sender_name || rec.sender_phone,
        14
      );
      const cleanDigits = rec.sender_phone.replace(/\D/g, '').slice(0, 15);
      rows.push([
        {
          text: `⬇️ ${icon} ${shortSender} (${rec.media_kind})`,
          callbackData: `stories:dl:${rec.id}`,
        },
        ...(cleanDigits
          ? [
              {
                text: `📦 كل حالات ${cleanDigits.slice(-4)}`,
                callbackData: `stories:dlc:${cleanDigits}`,
              },
            ]
          : []),
      ]);
    }

    rows.push([
      {
        text: `${currentFilter === 'ALL' ? '✅ ' : ''}الكل`,
        callbackData: 'stories:filter:ALL',
      },
      {
        text: `${currentFilter === 'IMAGE' ? '✅ ' : ''}صور`,
        callbackData: 'stories:filter:IMAGE',
      },
      {
        text: `${currentFilter === 'VIDEO' ? '✅ ' : ''}فيديو`,
        callbackData: 'stories:filter:VIDEO',
      },
      {
        text: `${currentFilter === 'TEXT' ? '✅ ' : ''}نصوص`,
        callbackData: 'stories:filter:TEXT',
      },
    ]);

    if (totalPages > 1) {
      const navRow: InlineButtonSpec[] = [];
      if (safePage > 1) {
        navRow.push({
          text: '⬅️ السابق',
          callbackData: `menu:stories:page:${safePage - 1}`,
        });
      }
      if (safePage < totalPages) {
        navRow.push({
          text: 'التالي ➡️',
          callbackData: `menu:stories:page:${safePage + 1}`,
        });
      }
      if (navRow.length > 0) {
        rows.push(navRow);
      }
    }

    rows.push([
      {
        text: `🔔 التحميل التلقائي: ${autoForward ? 'مفعّل ✅' : 'معطّل ❌'}`,
        callbackData: 'stories:toggle_autoforward',
      },
      {
        text: '🧪 التقاط حالات تجريبية الآن',
        callbackData: 'stories:simulate_batch',
      },
    ]);

    rows.push(
      buildAppNavigationRow({
        backCallback: 'menu:main',
        refreshCallback: `menu:stories:page:${safePage}`,
      })
    );

    return {
      text: lines.join('\n'),
      keyboard: rows,
      toastText: `📸 حالات واتساب (صفحة ${safePage}/${totalPages})`,
      route: `menu:stories:page:${safePage}`,
    };
  }

  private canAccessRecord(
    adminId: number,
    rec: { session_id: string; owner_telegram_id: number } | undefined
  ): boolean {
    if (!rec) return false;
    const isOwner = this.sessionManager.isOwner(adminId);
    if (isOwner) return true;
    if (rec.owner_telegram_id > 0 && rec.owner_telegram_id !== adminId) {
      return false;
    }
    try {
      this.sessionManager.assertSessionAccess(rec.session_id, adminId);
      return true;
    } catch {
      return false;
    }
  }

  public downloadStatus(adminId: number, recordId: string): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const rec = this.statusRepo.findById(recordId, adminId, isOwner);
    if (
      !rec ||
      !this.canAccessRecord(adminId, rec) ||
      !rec.file_path ||
      !fs.existsSync(rec.file_path)
    ) {
      return {
        text: '⚠️ ملف هذه الحالة غير موجود على القرص أو غير مصرح لك بالوصول إليه.',
        keyboard: [
          [
            {
              text: '🔙 العودة لتحميلات الحالات',
              callbackData: 'menu:stories:page:1',
            },
          ],
        ],
        toastText: '⚠️ الحالة غير موجودة أو غير مصرح بها',
      };
    }

    const attachment = this.statusDownloader.toTelegramAttachment(rec);
    const view = this.renderStoriesMenu(adminId, 1);
    return {
      ...view,
      toastText: `⬇️ جاري إرسال الحالة (${rec.file_name})...`,
      mediaAttachments: [attachment],
    };
  }

  public downloadAllByContact(
    adminId: number,
    phoneDigits: string
  ): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const phoneWithPlus = phoneDigits.startsWith('+')
      ? phoneDigits
      : `+${phoneDigits}`;
    const list = this.statusRepo.listBySenderPhone(
      phoneWithPlus,
      adminId,
      isOwner
    );

    const attachments = list
      .filter(
        (r) =>
          this.canAccessRecord(adminId, r) &&
          r.file_path &&
          fs.existsSync(r.file_path)
      )
      .map((r) => this.statusDownloader.toTelegramAttachment(r));

    const view = this.renderStoriesMenu(adminId, 1);
    return {
      ...view,
      toastText:
        attachments.length > 0
          ? `📦 جاري إرسال ${attachments.length} حالة للرقم ${phoneWithPlus}...`
          : 'ℹ️ لا توجد ملفات حالات محفوظة لهذا الرقم.',
      mediaAttachments: attachments,
    };
  }

  public async simulateBatch(adminId: number): Promise<BotViewResponse> {
    const sessions = this.sessionManager.listSessions(adminId);
    let sessionId = sessions[0]?.id;
    if (!sessionId) {
      const createdSess = this.sessionManager.createSession(
        'جلسة حالات افتراضية',
        adminId
      );
      sessionId = createdSess.id;
    }

    const created = await this.statusDownloader.simulateStatusBatch(
      sessionId,
      adminId
    );
    const attachments = created
      .filter((r) => r.file_path && fs.existsSync(r.file_path))
      .map((r) => this.statusDownloader.toTelegramAttachment(r));

    const view = this.renderStoriesMenu(adminId, 1);
    return {
      ...view,
      toastText: `✅ تم التقاط وحفظ ${created.length} حالات واتساب جديدة`,
      mediaAttachments: attachments,
    };
  }
}
