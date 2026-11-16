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

import path from 'node:path';

export type StoriesFilterKind = 'ALL' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT';

export interface StoryPublishDraft {
  sessionId: string;
  backgroundKey: string;
  backgroundHex: string;
  font: number;
  awaitingInput: boolean;
}

export const STORY_COLOR_THEMES: ReadonlyArray<{
  key: string;
  label: string;
  hex: string;
}> = [
  { key: 'EMERALD', label: '🟢 زمردي', hex: '#075E54' },
  { key: 'MIDNIGHT', label: '🌑 ليلي داكن', hex: '#0F172A' },
  { key: 'CRIMSON', label: '🔴 قرمزي', hex: '#881337' },
  { key: 'ROYAL', label: '🟣 ملكي', hex: '#4C1D95' },
  { key: 'GOLD', label: '🟡 ذهبي', hex: '#78350F' },
  { key: 'OCEAN', label: '🔵 محيطي', hex: '#0C4A6E' },
];

export class StoriesHandler {
  private readonly filterByAdmin = new Map<number, StoriesFilterKind>();
  private readonly publishDrafts = new Map<number, StoryPublishDraft>();

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
    this.publishDrafts.delete(adminId);
  }

  public hasActivePublishDraft(adminId: number): boolean {
    return Boolean(this.publishDrafts.get(adminId)?.awaitingInput);
  }

  public getStep(adminId: number): 'IDLE' | 'AWAITING_CONTENT' {
    return this.hasActivePublishDraft(adminId) ? 'AWAITING_CONTENT' : 'IDLE';
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
        text: `${currentFilter === 'AUDIO' ? '✅ ' : ''}🎵 صوتيات`,
        callbackData: 'stories:filter:AUDIO',
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
        text: '➕ نشر حالة واتساب جديدة (Story Publisher)',
        callbackData: 'stories:pub_start',
      },
    ]);

    rows.push([
      {
        text: `🔔 التحميل التلقائي للحالات: ${autoForward ? 'مفعّل ✅' : 'معطّل ❌'}`,
        callbackData: 'stories:toggle_autoforward',
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

  private getOrCreatePublishDraft(adminId: number): StoryPublishDraft {
    let draft = this.publishDrafts.get(adminId);
    if (!draft) {
      const connected = this.sessionManager.listConnectedSessions(adminId);
      const all = this.sessionManager.listSessions(adminId);
      const defaultSess = connected[0]?.id || all[0]?.id || '';
      draft = {
        sessionId: defaultSess,
        backgroundKey: 'EMERALD',
        backgroundHex: '#075E54',
        font: 1,
        awaitingInput: true,
      };
      this.publishDrafts.set(adminId, draft);
    }
    return draft;
  }

  public startPublishStory(adminId: number): BotViewResponse {
    const draft = this.getOrCreatePublishDraft(adminId);
    draft.awaitingInput = true;
    const connected = this.sessionManager.listConnectedSessions(adminId);
    if (!draft.sessionId && connected.length > 0) {
      draft.sessionId = connected[0]!.id;
    }

    const themeObj =
      STORY_COLOR_THEMES.find((t) => t.key === draft.backgroundKey) ||
      STORY_COLOR_THEMES[0]!;

    const rows: InlineKeyboardRows = [];
    if (connected.length > 1) {
      rows.push(
        connected.slice(0, 3).map((s) => ({
          text: `${s.id === draft.sessionId ? '✅ ' : '📱 '}${s.label || s.id}`,
          callbackData: `stories:pub_sess:${s.id}`,
        }))
      );
    }

    rows.push(
      STORY_COLOR_THEMES.slice(0, 3).map((t) => ({
        text: `${draft.backgroundKey === t.key ? '✅ ' : ''}${t.label}`,
        callbackData: `stories:pub_color:${t.key}`,
      })),
      STORY_COLOR_THEMES.slice(3, 6).map((t) => ({
        text: `${draft.backgroundKey === t.key ? '✅ ' : ''}${t.label}`,
        callbackData: `stories:pub_color:${t.key}`,
      })),
      [
        {
          text: `🔤 نمط الخط (Font Style): #${draft.font} (تبديل 0..5)`,
          callbackData: 'stories:pub_font',
        },
      ],
      [
        {
          text: '🔙 إلغاء والعودة لقسم الحالات',
          callbackData: 'menu:stories:page:1',
        },
      ]
    );

    return {
      text: [
        '➕ *نشر حالة واتساب جديدة (Story Publisher — `status@broadcast`)*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *الجلسة المختارة:* \`${escapeMarkdown(draft.sessionId || 'لا توجد جلسة متصلة')}\``,
        `• *لون خلفية الحالة النصية:* ${themeObj.label} (\`${themeObj.hex}\`)`,
        `• *نمط الخط (Font):* \`#${draft.font}\``,
        '',
        '📤 *طريقة النشر الفوري:*',
        '1️⃣ *لنشر حالة نصية ملونة:* أرسل النص مباشرة الآن في المحادثة.',
        '2️⃣ *لنشر حالة صورة / فيديو / صوت:* أرسل الصورة أو الفيديو أو المقطع الصوتي مباشرة الآن (مع إمكانية كتابة وصف تحت الوسائط).',
      ].join('\n'),
      keyboard: rows,
      toastText: '➕ أرسل نصاً أو صورة/فيديو/صوت لنشره كحالة واتساب',
    };
  }

  public setPublishColor(adminId: number, colorKey: string): BotViewResponse {
    const draft = this.getOrCreatePublishDraft(adminId);
    const theme = STORY_COLOR_THEMES.find((t) => t.key === colorKey);
    if (theme) {
      draft.backgroundKey = theme.key;
      draft.backgroundHex = theme.hex;
    }
    return this.startPublishStory(adminId);
  }

  public cyclePublishFont(adminId: number): BotViewResponse {
    const draft = this.getOrCreatePublishDraft(adminId);
    draft.font = (draft.font + 1) % 6;
    return this.startPublishStory(adminId);
  }

  public selectPublishSession(
    adminId: number,
    sessionId: string
  ): BotViewResponse {
    const draft = this.getOrCreatePublishDraft(adminId);
    draft.sessionId = sessionId;
    return this.startPublishStory(adminId);
  }

  public async handleTextInput(
    adminId: number,
    text: string
  ): Promise<BotViewResponse> {
    const draft = this.getOrCreatePublishDraft(adminId);
    const trimmed = text.trim();
    if (!trimmed) {
      return this.startPublishStory(adminId);
    }

    const connected = this.sessionManager.listConnectedSessions(adminId);
    const targetSessId = draft.sessionId || connected[0]?.id;
    if (!targetSessId) {
      return {
        text: '⚠️ لا توجد جلسة واتساب متصلة حالياً لنشر الحالة.',
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الحالات',
              callbackData: 'menu:stories:page:1',
            },
          ],
        ],
      };
    }

    try {
      const driver = this.sessionManager.getDriver(targetSessId, adminId);
      const res = await this.statusDownloader.publishStatusBroadcast({
        sessionId: targetSessId,
        driver: driver as never,
        kind: 'TEXT',
        textOrCaption: trimmed,
        backgroundHex: draft.backgroundHex,
        font: draft.font,
      });
      draft.awaitingInput = false;

      return {
        text: [
          '✅ *تم نشر الحالة النصية على واتساب (`status@broadcast`) بنجاح!*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          `• *الجلسة:* \`${escapeMarkdown(targetSessId)}\``,
          `• *معرف الحالة (Message ID):* \`${escapeMarkdown(res.statusMessageId)}\``,
          `• *لون الخلفية:* \`${escapeMarkdown(res.backgroundHex)}\` | *الخط:* \`#${res.font}\``,
          `• *عدد جهات الاتصال المشمولة (statusJidList):* \`${res.recipientsCount}\``,
          `• *النص المنشور:* ${escapeMarkdown(trimmed.slice(0, 300))}`,
        ].join('\n'),
        keyboard: [
          [
            {
              text: '➕ نشر حالة أخرى',
              callbackData: 'stories:pub_start',
            },
            {
              text: '⭕ العودة لقسم الحالات',
              callbackData: 'menu:stories:page:1',
            },
          ],
        ],
        toastText: '✅ تم نشر الحالة النصية بنجاح',
      };
    } catch (err) {
      return {
        text: `❌ تعذر نشر الحالة النصية: ${escapeMarkdown(err instanceof Error ? err.message : String(err))}`,
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الحالات',
              callbackData: 'menu:stories:page:1',
            },
          ],
        ],
      };
    }
  }

  public async handleMediaUpload(
    adminId: number,
    upload: {
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      contentBuffer: Buffer;
      caption?: string;
    }
  ): Promise<BotViewResponse> {
    const draft = this.getOrCreatePublishDraft(adminId);
    const connected = this.sessionManager.listConnectedSessions(adminId);
    const targetSessId = draft.sessionId || connected[0]?.id;
    if (!targetSessId) {
      return {
        text: '⚠️ لا توجد جلسة واتساب متصلة حالياً لنشر الحالة المرئية/الصوتية.',
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الحالات',
              callbackData: 'menu:stories:page:1',
            },
          ],
        ],
      };
    }

    const m = (upload.mimeType || '').toLowerCase();
    const kind: 'IMAGE' | 'VIDEO' | 'AUDIO' = m.startsWith('video/')
      ? 'VIDEO'
      : m.startsWith('audio/')
        ? 'AUDIO'
        : 'IMAGE';

    const tmpDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(
      tmpDir,
      `story_pub_${Date.now()}_${path.basename(upload.originalFilename || 'media.bin')}`
    );
    fs.writeFileSync(tmpPath, upload.contentBuffer);

    try {
      const driver = this.sessionManager.getDriver(targetSessId, adminId);
      const res = await this.statusDownloader.publishStatusBroadcast({
        sessionId: targetSessId,
        driver: driver as never,
        kind,
        textOrCaption: upload.caption,
        backgroundHex: draft.backgroundHex,
        font: draft.font,
        mediaBuffer: upload.contentBuffer,
        mediaFilePath: tmpPath,
        mimeType: upload.mimeType,
      });
      draft.awaitingInput = false;

      return {
        text: [
          `✅ *تم نشر حالة الوسائط (${kind}) على واتساب (\`status@broadcast\`) بنجاح!*`,
          '━━━━━━━━━━━━━━━━━━━━━━',
          `• *الجلسة:* \`${escapeMarkdown(targetSessId)}\``,
          `• *معرف الحالة (Message ID):* \`${escapeMarkdown(res.statusMessageId)}\``,
          `• *الملف:* \`${escapeMarkdown(upload.originalFilename)}\` (\`${upload.sizeBytes}\` بايت)`,
          `• *عدد جهات الاتصال المشمولة (statusJidList):* \`${res.recipientsCount}\``,
          ...(upload.caption ? [`• *الوصف:* ${escapeMarkdown(upload.caption.slice(0, 200))}`] : []),
        ].join('\n'),
        keyboard: [
          [
            {
              text: '➕ نشر حالة أخرى',
              callbackData: 'stories:pub_start',
            },
            {
              text: '⭕ العودة لقسم الحالات',
              callbackData: 'menu:stories:page:1',
            },
          ],
        ],
        toastText: '✅ تم نشر حالة الوسائط بنجاح',
      };
    } finally {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore temp file cleanup error
      }
    }
  }
}
