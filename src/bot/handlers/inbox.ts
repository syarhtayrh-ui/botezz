import fs from 'node:fs';
import {
  InboxRepository,
  IncomingMessageRecord,
} from '../../database/repositories/inbox-repository';
import { IncomingMessageReceiver } from '../../whatsapp/incoming-message-receiver';
import { SessionManager } from '../../whatsapp/session-manager';
import { validateRecipient } from '../../security/validation';
import { toSafeArabicError } from '../../utils/errors';
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
  private readonly forwardDrafts = new Map<number, string>();

  constructor(
    private readonly inboxRepo: InboxRepository,
    private readonly receiver: IncomingMessageReceiver,
    private readonly sessionManager: SessionManager
  ) {}

  public cancel(adminId: number): void {
    this.forwardDrafts.delete(adminId);
  }

  public hasPendingForward(adminId: number): boolean {
    return this.forwardDrafts.has(adminId);
  }

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
      const shortSender = (rec.sender_name || rec.sender_phone).slice(0, 14);
      rows.push([
        {
          text: `${icon} ${shortSender} (${rec.file_name || rec.kind})`,
          callbackData: `inbox:view:${rec.id}`,
        },
        {
          text: '⬇️ تحميل',
          callbackData: `inbox:dl:${rec.id}`,
        },
        {
          text: '↗️ توجيه',
          callbackData: `inbox:fwd:${rec.id}`,
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

  public viewMessage(adminId: number, recordId: string): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const rec = this.inboxRepo.findById(recordId, adminId, isOwner);
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

    const detailLines = [
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
    ];

    if (rec.is_edited) {
      detailLines.push('• *حالة التعديل:* ✏️ *تم تعديل هذه الرسالة من قبل المرسل*');
      if (rec.original_text) {
        detailLines.push(`• *النص الأصلي (قبل التعديل):* \`${escapeMarkdown(rec.original_text.slice(0, 300))}\``);
      }
    }

    detailLines.push(
      '',
      `📝 *محتوى / وصف الرسالة${rec.is_edited ? ' (بعد التعديل)' : ''}:*`,
      escapeMarkdown((rec.text_content || '(بدون نص)').slice(0, 800))
    );

    return {
      text: detailLines.join('\n'),
      keyboard: [
        [
          {
            text: '⬇️ تحميل الملف في تيليجرام',
            callbackData: `inbox:dl:${rec.id}`,
          },
          {
            text: '↗️ توجيه لرقم آخر (Forward)',
            callbackData: `inbox:fwd:${rec.id}`,
          },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:inbox:page:1',
          refreshCallback: `inbox:view:${rec.id}`,
        }),
      ],
    };
  }

  public promptForward(adminId: number, recordId: string): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const rec = this.inboxRepo.findById(recordId, adminId, isOwner);
    if (!rec) {
      return {
        text: '⚠️ لم يتم العثور على الرسالة المراد إعادة توجيهها.',
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الرسائل الواردة',
              callbackData: 'menu:inbox:page:1',
            },
          ],
        ],
      };
    }

    this.forwardDrafts.set(adminId, recordId);
    const preview = (rec.text_content || rec.file_name || rec.kind).slice(0, 150);

    return {
      text: [
        '↗️ *إعادة توجيه الرسالة عبر واتساب (Native WhatsApp Forward)*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *معرف الرسالة:* \`${escapeMarkdown(rec.id)}\``,
        `• *المرسل الأصلي:* ${escapeMarkdown(rec.sender_name || rec.sender_phone)} (\`${escapeMarkdown(rec.sender_phone)}\`)`,
        `• *نوع الرسالة:* \`${escapeMarkdown(rec.kind)}\``,
        `• *المحتوى:* ${escapeMarkdown(preview)}`,
        ...(rec.is_edited ? ['• *حالة الرسالة:* ✏️ تم تعديلها من قبل المرسل'] : []),
        '',
        '💬 *الرجاء إدخال رقم هاتف المستلم الدولي الآن:*',
        '*(مثال: `+966501234567` أو `966501234567` أو معرف مجموعة `...@g.us`)*',
        '',
        '🛡️ *ملاحظة البروتوكول:* سيتم إرسال الرسالة كرسالة مُعاد توجيهها رسمياً (`isForwarded: true` مع عداد التوجيه `forwardingScore`) باستخدام مقبس واتساب وليس كرسالة نصية عادية منسوخة.',
      ].join('\n'),
      keyboard: [
        [
          {
            text: '❌ إلغاء العملية',
            callbackData: `inbox:view:${rec.id}`,
          },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:inbox:page:1',
          refreshCallback: `inbox:fwd:${rec.id}`,
        }),
      ],
    };
  }

  public async executeForward(
    adminId: number,
    recipientRaw: string
  ): Promise<BotViewResponse> {
    const recordId = this.forwardDrafts.get(adminId);
    if (!recordId) {
      return {
        text: '⚠️ انتهت مهلة جلسة إعادة التوجيه أو لم يتم تحديد رسالة. الرجاء اختيار الرسالة أولاً.',
        keyboard: [
          [
            {
              text: '📥 الانتقال لصندوق الرسائل الواردة',
              callbackData: 'menu:inbox:page:1',
            },
          ],
        ],
      };
    }

    const isOwner = this.sessionManager.isOwner(adminId);
    const rec = this.inboxRepo.findById(recordId, adminId, isOwner);
    if (!rec) {
      this.forwardDrafts.delete(adminId);
      return {
        text: '⚠️ لم يتم العثور على سجل الرسالة في قاعدة البيانات.',
        keyboard: [
          [
            {
              text: '🔙 العودة لقسم الرسائل الواردة',
              callbackData: 'menu:inbox:page:1',
            },
          ],
        ],
      };
    }

    let normalized;
    try {
      normalized = validateRecipient(recipientRaw);
    } catch (err: unknown) {
      return {
        text: [
          '⚠️ *رقم المستلم غير صحيح!*',
          escapeMarkdown(
            (err as Error)?.message ||
              'تأكد من إدخال الرقم بصيغة دولية مع رمز الدولة.'
          ),
          '',
          '💬 الرجاء إعادة إرسال الرقم بالصيغة الدولية (مثال: `+966501234567`):',
        ].join('\n'),
        keyboard: [
          [
            {
              text: '❌ إلغاء التوجيه',
              callbackData: `inbox:view:${rec.id}`,
            },
          ],
        ],
      };
    }

    this.forwardDrafts.delete(adminId);

    // Find a connected session driver
    let driver = null;
    try {
      driver = this.sessionManager.getDriver(rec.session_id, adminId);
    } catch {
      const connectedSessions = this.sessionManager.listConnectedSessions(adminId);
      if (connectedSessions.length > 0) {
        try {
          driver = this.sessionManager.getDriver(connectedSessions[0]!.id, adminId);
        } catch {
          driver = null;
        }
      }
    }

    if (!driver) {
      return {
        text: [
          '⚠️ *تعذر إتمام إعادة التوجيه:*',
          'لا توجد جلسة واتساب متصلة حالياً لإرسال الرسالة من خلالها.',
          'يرجى التأكد من ربط جلسة واتساب نشطة عبر القائمة الرئيسية.',
        ].join('\n'),
        keyboard: [
          [
            {
              text: '📱 إدارة الجلسات',
              callbackData: 'menu:sessions:page:1',
            },
          ],
          buildAppNavigationRow({
            backCallback: 'menu:inbox:page:1',
            refreshCallback: `inbox:view:${rec.id}`,
          }),
        ],
      };
    }

    let rawPayload: Record<string, unknown> | null = null;
    if (rec.raw_payload) {
      try {
        const parsed = JSON.parse(rec.raw_payload);
        if (parsed && typeof parsed === 'object') {
          rawPayload = parsed as Record<string, unknown>;
        }
      } catch {
        rawPayload = null;
      }
    }

    const forwardPayload: Record<string, unknown> =
      rawPayload || {
        key: {
          id: rec.wa_message_id,
          remoteJid: rec.sender_jid,
          fromMe: false,
        },
        message: {
          conversation: rec.text_content || '',
        },
      };

    try {
      const fwdResult = await driver.forwardMessage(
        normalized.jid,
        forwardPayload,
        {
          forceForward: true,
        }
      );

      if (fwdResult.forwarded || (fwdResult as { success?: boolean }).success) {
        const msgId =
          fwdResult.messageId ||
          (fwdResult as { forwardedMessageId?: string }).forwardedMessageId ||
          'N/A';
        return {
          text: [
            '✅ *تمت إعادة توجيه الرسالة بنجاح عبر واتساب!*',
            '━━━━━━━━━━━━━━━━━━━━━━',
            `• *المستلم:* \`${escapeMarkdown(normalized.displayTarget)}\``,
            `• *معرف الإرسال الجديد:* \`${escapeMarkdown(msgId)}\``,
            `• *نوع الرسالة المُعاد توجيهها:* \`${escapeMarkdown(rec.kind)}\``,
            `• *الجلسة المستخدمة:* \`${escapeMarkdown(driver.sessionId)}\``,
            `• *علامة التوجيه:* 🟢 \`isForwarded: true\` (Forwarding Score: 1)`,
          ].join('\n'),
          keyboard: [
            [
              {
                text: '📥 العودة لصندوق الوارد',
                callbackData: 'menu:inbox:page:1',
              },
              {
                text: '👁️ عرض تفاصيل الرسالة',
                callbackData: `inbox:view:${rec.id}`,
              },
            ],
            buildAppNavigationRow({
              backCallback: 'menu:inbox:page:1',
              refreshCallback: `inbox:view:${rec.id}`,
            }),
          ],
        };
      } else {
        return {
          text: [
            '⚠️ *تعذر إرسال إعادة التوجيه:*',
            escapeMarkdown(
              (fwdResult as { error?: string }).error ||
                'حدث خطأ غير متوقع أثناء معالجة مقبس واتساب.'
            ),
          ].join('\n'),
          keyboard: [
            [
              {
                text: '🔄 إعادة المحاولة',
                callbackData: `inbox:fwd:${rec.id}`,
              },
              {
                text: '🔙 العودة للتفاصيل',
                callbackData: `inbox:view:${rec.id}`,
              },
            ],
          ],
        };
      }
    } catch (err: unknown) {
      const safeErr = toSafeArabicError(err);
      return {
        text: ['⚠️ *خطأ أثناء إعادة التوجيه:*', safeErr.userMessage].join('\n'),
        keyboard: [
          [
            {
              text: '🔄 إعادة المحاولة',
              callbackData: `inbox:fwd:${rec.id}`,
            },
            {
              text: '🔙 العودة لقسم الرسائل',
              callbackData: 'menu:inbox:page:1',
            },
          ],
        ],
      };
    }
  }

  public downloadMessageFile(
    adminId: number,
    recordId: string
  ): BotViewResponse {
    const isOwner = this.sessionManager.isOwner(adminId);
    const rec = this.inboxRepo.findById(recordId, adminId, isOwner);
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
