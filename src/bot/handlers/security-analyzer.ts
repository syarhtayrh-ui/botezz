import {
  AnalyzerSurfaceFilter,
  ForensicCaptureRecord,
  ForensicPayloadAnalyzer,
  getForensicPayloadAnalyzer,
} from '../../security/forensic-payload-analyzer';
import { SessionManager } from '../../whatsapp/session-manager';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { BotViewResponse } from '../workflows/pairing-workflow';
import {
  buildAppNavigationRow,
  InlineButtonSpec,
  InlineKeyboardRows,
} from '../keyboards/main-menu';
import { renderBreadcrumb } from '../keyboards/ui-theme';
import { AuthorizationError } from '../../utils/errors';
import { escapeMarkdown } from '../../utils/markdown';

function formatBytesReadable(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${bytes} B`;
}

function formatSurfaceBadgeArabic(record: ForensicCaptureRecord): string {
  switch (record.surface) {
    case 'PRIVATE_CHAT':
      return '💬 محادثة خاصة';
    case 'GROUP':
      return '👥 مجموعة';
    case 'STATUS_STORY':
      return '⭕ حالة واتساب';
    case 'NEWSLETTER':
      return '📡 قناة';
    case 'PROTOCOL_STANZA':
      return '⚡ عقدة بروتوكول';
  }
}

function formatSurfaceFilterTitleArabic(filter: AnalyzerSurfaceFilter): string {
  switch (filter) {
    case 'PRIVATE_CHAT':
      return '💬 الدردشات الفردية (@s.whatsapp.net / @lid)';
    case 'GROUP':
      return '👥 المجموعات (@g.us)';
    case 'STATUS_STORY':
      return '⭕ حالات واتساب (status@broadcast)';
    case 'NEWSLETTER':
      return '📡 القنوات (@newsletter)';
    case 'PROTOCOL_STANZA':
      return '⚡ العقد الثنائية والبروتوكولية (IQ / Call / Notification)';
    case 'ANOMALIES_ONLY':
      return '🚨 الحمولات المشبوهة والمشوهة فقط (Anomalies & Crash Vectors)';
    default:
      return '🌐 جميع الأسطح والحمولات (ALL)';
  }
}

export class SecurityAnalyzerHandler {
  private readonly analyzer: ForensicPayloadAnalyzer;
  private lastPageByAdmin = new Map<number, number>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly auditRepo: AuditRepository,
    analyzer?: ForensicPayloadAnalyzer
  ) {
    this.analyzer = analyzer ?? getForensicPayloadAnalyzer();
  }

  private assertOwnerOnly(actorUserId: number): void {
    if (!this.sessionManager.isOwner(actorUserId)) {
      throw new AuthorizationError(
        '⛔ الوصول مرفوض: قسم المحلل الأمني والجنائي للحمولات الواردة مخصص لمالك النظام (Owner-Only) حصرياً.'
      );
    }
  }

  public renderDashboard(
    actorUserId: number,
    page = 1,
    bannerNotice?: string
  ): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const cfg = this.analyzer.getConfig();
    const queryResult = this.analyzer.listCaptures({
      filter: cfg.surfaceFilter,
      page,
      pageSize: 5,
    });
    this.lastPageByAdmin.set(actorUserId, queryResult.page);

    const allCaptures = this.analyzer.listCaptures({
      filter: 'ALL',
      page: 1,
      pageSize: 200,
    });
    const anomalousCount = allCaptures.items.filter(
      (c) => c.threatVerdict.isAnomalous || Boolean(c.processingError)
    ).length;

    const statusBadge = cfg.enabled
      ? '🟢 *مفعّل (يعترض ويحفظ الحمولات الواردة على مرحلتين قبل وبعد المعالجة)*'
      : '🔴 *معطّل حالياً*';
    const autoUploadBadge = cfg.autoUploadToTelegram
      ? '✅ مفعّل (يرفع الملفات الخام والمحللة فوراً لتليجرام)'
      : '⏸️ معطّل (حفظ محلي وسحب عند الطلب)';
    const rawNodesBadge = cfg.captureRawBinaryStanzas
      ? '✅ مفعّل (يلتقط عقد CB:message / CB:iq / CB:call / CB:notification)'
      : '⏸️ معطّل (يلتقط رسائل وحالات messages.upsert فقط)';

    const captureLines: string[] = [];
    if (queryResult.items.length === 0) {
      captureLines.push(
        '• _لا توجد حمولات ملتقطة في الأرشيف تطابق الفلتر الحالي._'
      );
    } else {
      queryResult.items.forEach((rec, idx) => {
        const verdictIcon = rec.threatVerdict.isAnomalous ? '🚨' : '🟢';
        const surfaceBadge = formatSurfaceBadgeArabic(rec);
        const safeRemote = escapeMarkdown(
          (rec.remoteJid || rec.sessionId).slice(0, 36)
        );
        const wrapperSummary =
          rec.wrapperChain.length > 0
            ? `${rec.wrapperChain.join('->')}->${rec.payloadType}`
            : rec.payloadType;
        captureLines.push(
          `*#${idx + 1}* ${verdictIcon} \`#${rec.shortId}\` | ${surfaceBadge} | \`${rec.senderOs}\`\n` +
            `   • المصدر: \`${safeRemote}\` | النوع: \`${escapeMarkdown(
              wrapperSummary.slice(0, 48)
            )}\`\n` +
            `   • الأحجام: خام \`${formatBytesReadable(
              rec.preProcessRawBytes
            )}\` | جنائي \`${formatBytesReadable(
              rec.postProcessBytes
            )}\` | وسائط \`${formatBytesReadable(rec.mediaBytes)}\``
        );
      });
    }

    const headerBanner = bannerNotice ? `${bannerNotice}\n\n` : '';

    const text =
      `${renderBreadcrumb(['الرئيسية', 'المحلل الأمني والجنائي'])}\n` +
      headerBanner +
      `🛡️ *قسم المحلل الأمني والجنائي للحمولات الواردة (Security & Forensic Payload Analyzer)*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📡 *حالة المحلل الأمني:* ${statusBadge}\n` +
      `📤 *الرفع التلقائي الفوري لتليجرام:* ${autoUploadBadge}\n` +
      `⚡ *التقاط العقد الثنائية الخام (BinaryNode):* ${rawNodesBadge}\n` +
      `🎯 *الفلتر النشط:* ${formatSurfaceFilterTitleArabic(cfg.surfaceFilter)}\n` +
      `📊 *إحصاءات الأرشيف الدائري:* الإجمالي \`${allCaptures.totalItems}/200\` | تحذيرات جنائية: \`${anomalousCount}\`\n\n` +
      `📜 *سجل الحمولات الملتقطة (صفحة ${queryResult.page}/${queryResult.totalPages}):*\n` +
      `${captureLines.join('\n\n')}`;

    const keyboard: InlineKeyboardRows = [
      // Row 1: Primary Toggle
      [
        {
          text: cfg.enabled
            ? '🔴 إيقاف المحلل الأمني الفوري'
            : '🟢 تشغيل المحلل الأمني الفوري',
          callbackData: 'sec:toggle',
        },
      ],
      // Row 2: Auto-Upload & Raw Binary Nodes Toggles
      [
        {
          text: cfg.autoUploadToTelegram
            ? '📤 الرفع التلقائي لتليجرام: مفعّل ✅'
            : '📤 الرفع التلقائي لتليجرام: معطّل ⏸️',
          callbackData: 'sec:toggle_autoupload',
        },
      ],
      [
        {
          text: cfg.captureRawBinaryStanzas
            ? '📡 التقاط العقد الثنائية الخام (BinaryNode): مفعّل ✅'
            : '📡 التقاط العقد الثنائية الخام (BinaryNode): معطّل ⏸️',
          callbackData: 'sec:toggle_raw_nodes',
        },
      ],
      // Row 3 & 4: Surface Filter Buttons
      [
        {
          text: cfg.surfaceFilter === 'ALL' ? '✅ 🌐 الكل' : '🌐 الكل',
          callbackData: 'sec:filter:ALL',
        },
        {
          text:
            cfg.surfaceFilter === 'PRIVATE_CHAT'
              ? '✅ 💬 الدردشات'
              : '💬 الدردشات',
          callbackData: 'sec:filter:PRIVATE_CHAT',
        },
        {
          text:
            cfg.surfaceFilter === 'GROUP' ? '✅ 👥 المجموعات' : '👥 المجموعات',
          callbackData: 'sec:filter:GROUP',
        },
      ],
      [
        {
          text:
            cfg.surfaceFilter === 'STATUS_STORY'
              ? '✅ ⭕ الحالات'
              : '⭕ الحالات',
          callbackData: 'sec:filter:STATUS_STORY',
        },
        {
          text:
            cfg.surfaceFilter === 'ANOMALIES_ONLY'
              ? '✅ 🚨 الحمولات المشبوهة/المشوهة فقط'
              : '🚨 الحمولات المشبوهة/المشوهة فقط',
          callbackData: 'sec:filter:ANOMALIES_ONLY',
        },
      ],
    ];

    // 1-Click Download & Upload Full Forensic Bundle Buttons for visible captures
    for (const rec of queryResult.items) {
      keyboard.push([
        {
          text: `📥 سحب ورفع ملفات الحمولة الكاملة (#${rec.shortId})`,
          callbackData: `sec:download:${rec.shortId}`,
        },
      ]);
    }

    // Pagination row if > 1 page
    if (queryResult.totalPages > 1) {
      const pageRow: InlineButtonSpec[] = [];
      if (queryResult.page > 1) {
        pageRow.push({
          text: '⬅️ السابق',
          callbackData: `sec:page:${queryResult.page - 1}`,
        });
      }
      pageRow.push({
        text: `📄 ${queryResult.page} / ${queryResult.totalPages}`,
        callbackData: `sec:page:${queryResult.page}`,
      });
      if (queryResult.page < queryResult.totalPages) {
        pageRow.push({
          text: '➡️ التالي',
          callbackData: `sec:page:${queryResult.page + 1}`,
        });
      }
      keyboard.push(pageRow);
    }

    // Clear Archive Row
    keyboard.push([
      {
        text: '🗑️ مسح أرشيف الفحص المؤقت',
        callbackData: 'sec:clear',
      },
    ]);

    // Standard Navigation Row
    keyboard.push(
      buildAppNavigationRow({
        backCallback: 'menu:main',
        refreshCallback: `sec:page:${queryResult.page}`,
      })
    );

    return {
      text,
      keyboard,
      route: 'menu:sec_analyzer',
    };
  }

  public toggleEnabled(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const current = this.analyzer.getConfig();
    const updated = this.analyzer.updateConfig({
      enabled: !current.enabled,
    });
    this.auditRepo.record({
      actorTelegramId: actorUserId,
      action: updated.enabled
        ? 'SECURITY_ANALYZER_ENABLED'
        : 'SECURITY_ANALYZER_DISABLED',
      outcome: 'SUCCESS',
    });
    const banner = updated.enabled
      ? '🟢 *تم تشغيل المحلل الأمني والجنائي للحمولات الواردة (المرحلة 1 والمرحلة 2 نشطة الآن).*'
      : '🔴 *تم إيقاف المحلل الأمني والجنائي للحمولات الواردة.*';
    const view = this.renderDashboard(
      actorUserId,
      this.lastPageByAdmin.get(actorUserId) || 1,
      banner
    );
    return {
      ...view,
      toastText: updated.enabled
        ? '🟢 تم تشغيل المحلل الأمني'
        : '🔴 تم إيقاف المحلل الأمني',
    };
  }

  public toggleAutoUpload(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const current = this.analyzer.getConfig();
    const updated = this.analyzer.updateConfig({
      autoUploadToTelegram: !current.autoUploadToTelegram,
    });
    const banner = updated.autoUploadToTelegram
      ? '📤 *تم تفعيل الرفع التلقائي الفوري لملفات الفحص الجنائي إلى تليجرام.*'
      : '⏸️ *تم إيقاف الرفع التلقائي؛ سيتم حفظ الحمولات في الأرشيف لسحبها عند الطلب.*';
    const view = this.renderDashboard(
      actorUserId,
      this.lastPageByAdmin.get(actorUserId) || 1,
      banner
    );
    return {
      ...view,
      toastText: updated.autoUploadToTelegram
        ? '✅ الرفع التلقائي مفعّل'
        : '⏸️ الرفع التلقائي معطّل',
    };
  }

  public toggleRawBinaryNodes(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const current = this.analyzer.getConfig();
    const updated = this.analyzer.updateConfig({
      captureRawBinaryStanzas: !current.captureRawBinaryStanzas,
    });
    const banner = updated.captureRawBinaryStanzas
      ? '📡 *تم تفعيل اعتراض والتقاط العقد الثنائية الخام (CB:message / CB:iq / CB:call / CB:notification).*'
      : '⏸️ *تم قصر الالتقاط على رسائل وحالات messages.upsert.*';
    const view = this.renderDashboard(
      actorUserId,
      this.lastPageByAdmin.get(actorUserId) || 1,
      banner
    );
    return {
      ...view,
      toastText: updated.captureRawBinaryStanzas
        ? '📡 التقاط العقد الخام مفعّل'
        : '⏸️ التقاط العقد الخام معطّل',
    };
  }

  public setSurfaceFilter(
    actorUserId: number,
    rawFilter: string
  ): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const validFilters: AnalyzerSurfaceFilter[] = [
      'ALL',
      'PRIVATE_CHAT',
      'GROUP',
      'STATUS_STORY',
      'NEWSLETTER',
      'PROTOCOL_STANZA',
      'ANOMALIES_ONLY',
    ];
    const upper = String(rawFilter || 'ALL')
      .trim()
      .toUpperCase() as AnalyzerSurfaceFilter;
    const nextFilter: AnalyzerSurfaceFilter = validFilters.includes(upper)
      ? upper
      : 'ALL';

    this.analyzer.updateConfig({ surfaceFilter: nextFilter });
    const banner = `🎯 *تم تحديث فلتر السطح إلى:* ${formatSurfaceFilterTitleArabic(nextFilter)}`;
    const view = this.renderDashboard(actorUserId, 1, banner);
    return {
      ...view,
      toastText: `🎯 الفلتر: ${nextFilter}`,
    };
  }

  public downloadCaptureBundle(
    actorUserId: number,
    idOrShortId: string
  ): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const record = this.analyzer.findCaptureById(idOrShortId);
    const currentPage = this.lastPageByAdmin.get(actorUserId) || 1;

    if (!record) {
      const view = this.renderDashboard(
        actorUserId,
        currentPage,
        `⚠️ *لم يتم العثور على الحمولة الجنائية المطلوبة (\`${escapeMarkdown(
          idOrShortId
        )}\`).*`
      );
      return {
        ...view,
        toastText: '⚠️ لم يتم العثور على الحمولة',
        showAlert: true,
      };
    }

    const summaryText = this.analyzer.formatSanitizedTelegramSummary(record);
    const attachments = this.analyzer.buildCaptureDocumentAttachments(record);

    this.auditRepo.record({
      actorTelegramId: actorUserId,
      action: 'SECURITY_FORENSIC_BUNDLE_UPLOADED',
      targetId: record.captureId,
      outcome: 'SUCCESS',
      metadata: {
        shortId: record.shortId,
        surface: record.surface,
        attachmentsCount: attachments.length,
      },
    });

    return {
      text:
        `${renderBreadcrumb([
          'الرئيسية',
          'المحلل الأمني والجنائي',
          `حمولة #${record.shortId}`,
        ])}\n` +
        `📥 *تم استخراج وإرفاق جميع ملفات الحمولة الجنائية (${attachments.length} ملفات بدون تعديل):*\n\n` +
        summaryText,
      keyboard: [
        [
          {
            text: `🔄 إعادة رفع ملفات الحمولة (#${record.shortId})`,
            callbackData: `sec:download:${record.shortId}`,
          },
        ],
        buildAppNavigationRow({
          backCallback: `sec:page:${currentPage}`,
          refreshCallback: `sec:download:${record.shortId}`,
        }),
      ],
      mediaAttachments: attachments,
      route: `sec:download:${record.shortId}`,
      toastText: `📥 تم رفع ${attachments.length} ملفات جنائية`,
    };
  }

  public clearArchive(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const removedCount = this.analyzer.clearArchive();
    this.auditRepo.record({
      actorTelegramId: actorUserId,
      action: 'SECURITY_FORENSIC_ARCHIVE_CLEARED',
      outcome: 'SUCCESS',
      metadata: { removedCount },
    });
    const view = this.renderDashboard(
      actorUserId,
      1,
      `🗑️ *تم مسح أرشيف الفحص المؤقت وحذف \`${removedCount}\` حزمة جنائية من القرص والذاكرة.*`
    );
    return {
      ...view,
      toastText: '🗑️ تم مسح الأرشيف الجنائي',
    };
  }
}
