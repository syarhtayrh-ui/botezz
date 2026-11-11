import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getNetworkTrafficMonitor,
  NetworkTrafficEntry,
  NetworkTrafficFilter,
  NetworkTrafficMonitor,
} from '../../network/network-traffic-monitor';
import { SessionManager } from '../../whatsapp/session-manager';
import { AuditRepository } from '../../database/repositories/audit-repository';
import {
  BotViewResponse,
  TelegramMediaAttachment,
} from '../workflows/pairing-workflow';
import {
  buildAppNavigationRow,
  InlineButtonSpec,
  InlineKeyboardRows,
} from '../keyboards/main-menu';
import { renderBreadcrumb } from '../keyboards/ui-theme';
import { AuthorizationError } from '../../utils/errors';
import { escapeMarkdown } from '../../utils/markdown';

function formatBytesMbOrKb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.00 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function formatChannelBadge(entry: NetworkTrafficEntry): string {
  if (entry.channel === 'WA_STANZA') {
    return `[WA-${entry.methodOrTag}]`;
  }
  if (entry.channel === 'HTTP') {
    return `[HTTP]`;
  }
  if (entry.channel === 'LOCAL_API') {
    return `[API]`;
  }
  if (entry.channel === 'VOIP_RTP') {
    return `[VoIP]`;
  }
  return `[NET]`;
}

function formatFilterTitleArabic(filter: NetworkTrafficFilter): string {
  switch (filter) {
    case 'WA_STANZA':
      return '📡 عقد واتساب الثنائية (IQ / Message / Presence / Call)';
    case 'HTTP':
      return '🔗 طلبات وردود HTTP / HTTPS الصادرة';
    case 'LOCAL_API':
      return '🏠 طلبات الخادم المحلي (Local API & Harness)';
    case 'VOIP_RTP':
      return '📹 إحصاءات تدفق مكالمات الفيديو والصوت (VoIP RTP/SRTP)';
    case 'ERRORS':
      return '❌ الأخطاء البرمجية والبطء الشبكي فقط (> 2000ms)';
    default:
      return '🌐 جميع القنوات (All Network Traffic)';
  }
}

function sanitizeCodeBlockContent(raw: string, maxLen: number): string {
  const cleaned = raw.replace(/```/g, "'''");
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}\n... [تم اقتطاع العرض مراعاة لحد تليجرام]`;
}

export class NetworkTrafficHandler {
  private readonly monitor: NetworkTrafficMonitor;
  private lastFilterByAdmin = new Map<number, NetworkTrafficFilter>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly auditRepo: AuditRepository,
    monitor?: NetworkTrafficMonitor
  ) {
    this.monitor = monitor ?? getNetworkTrafficMonitor();
  }

  private assertOwnerOnly(actorUserId: number): void {
    if (!this.sessionManager.isOwner(actorUserId)) {
      throw new AuthorizationError(
        '⛔ الوصول مرفوض: مرصد حركة مرور الشبكة والبروتوكول مخصص لمالك النظام (Owner-Only) حصرياً.'
      );
    }
  }

  public renderDashboard(
    actorUserId: number,
    filter: NetworkTrafficFilter = 'ALL',
    page = 1,
    bannerNotice?: string
  ): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    this.lastFilterByAdmin.set(actorUserId, filter);

    const metrics = this.monitor.getMetrics();
    const queryResult = this.monitor.queryEntries({
      filter,
      page,
      pageSize: 8,
    });

    const connectedSessions =
      this.sessionManager.listConnectedSessions(actorUserId);
    const totalSessions = this.sessionManager.listSessions(actorUserId);

    const statusLine = metrics.captureEnabled
      ? '🟢 *نشط (يلتقط الطلبات والردود حياً)*'
      : '⏸️ *متوقف مؤقتاً (Paused)*';

    const portsSummary =
      metrics.activeListeningPorts.length > 0
        ? metrics.activeListeningPorts
            .slice(0, 4)
            .map((p) => `\`${p.protocol}:${p.localPort}(${p.state})\``)
            .join(' ، ')
        : '`TCP:3000(LISTEN)`';

    const feedLines: string[] = [];
    if (queryResult.items.length === 0) {
      feedLines.push(
        '• _لا توجد طلبات أو عقد مسجلة تطابق هذا الفلتر حالياً._'
      );
    } else {
      queryResult.items.forEach((entry, idx) => {
        const dirIcon = entry.direction === 'OUTBOUND' ? '⬆️' : '⬇️';
        const outcomeIcon =
          entry.outcome === 'ERROR'
            ? '❌'
            : entry.outcome === 'SLOW_LATENCY'
              ? '⚠️'
              : '✅';
        const badge = formatChannelBadge(entry);
        const safeSummary = escapeMarkdown(entry.summary.slice(0, 56));
        feedLines.push(
          `*#${idx + 1}* ${dirIcon} \`${badge}\` ${safeSummary} — ${outcomeIcon}\`${entry.statusCode}\` (\`${entry.durationMs}ms\`) [\`#${entry.shortId}\`]`
        );
      });
    }

    const headerBanner = bannerNotice ? `${bannerNotice}\n\n` : '';

    const text =
      `${renderBreadcrumb(['الرئيسية', 'مرصد حركة الشبكة'])}\n` +
      headerBanner +
      `🌐 *مرصد حركة مرور الشبكة والبروتوكول الحي (Network Telemetry Inspector)*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📡 *حالة المرصد:* ${statusLine}\n` +
      `📊 *النطاق الترددي (Bandwidth):*\n` +
      `• ⬆️ *صادر:* \`${formatBytesMbOrKb(metrics.totalTxBytes)}\` (\`${metrics.currentTxKbps} KB/s\`)\n` +
      `• ⬇️ *وارد:* \`${formatBytesMbOrKb(metrics.totalRxBytes)}\` (\`${metrics.currentRxKbps} KB/s\`)\n` +
      `🔌 *المقابس والمنافذ النشطة:*\n` +
      `• *مقابس واتساب (WSS):* \`${connectedSessions.length}/${totalSessions.length}\` متصل | *TCP نشط:* \`${metrics.establishedTcpCount}\`\n` +
      `• *المنافذ المحلية:* ${portsSummary}\n` +
      `📈 *ملخص الطلبات والعقد (${metrics.totalEntries}/${metrics.maxEntries}):*\n` +
      `• \`WA Stanzas: ${metrics.countsByChannel.WA_STANZA}\` | \`HTTP: ${metrics.countsByChannel.HTTP}\` | \`API: ${metrics.countsByChannel.LOCAL_API}\` | \`VoIP: ${metrics.countsByChannel.VOIP_RTP}\`\n` +
      `• ⏱️ *متوسط الاستجابة (Avg RTT):* \`${metrics.avgRttMs} ms\` | *الأبطأ (Max RTT):* \`${metrics.maxRttMs} ms\`\n` +
      `• 🚨 *الأخطاء الشبكية/البروتوكولية:* \`Errors: ${metrics.errorCount}\` | *بطء (>2s):* \`${metrics.slowCount}\`\n\n` +
      `🔎 *الفلتر الحالي:* ${formatFilterTitleArabic(filter)} (صفحة \`${queryResult.page}/${queryResult.totalPages}\`)\n` +
      `📜 *آخر ${queryResult.items.length} طلبات/ردود حية (Live Stream Feed):*\n` +
      `${feedLines.join('\n')}`;

    const keyboard: InlineKeyboardRows = [
      // Row 1: Quick Filters
      [
        {
          text: filter === 'ALL' ? '✅ 🌐 الكل' : '🌐 الكل',
          callbackData: 'net:list:ALL:1',
        },
        {
          text:
            filter === 'WA_STANZA'
              ? '✅ 📡 عقد واتساب'
              : '📡 عقد واتساب (IQ/Msg)',
          callbackData: 'net:list:WA_STANZA:1',
        },
        {
          text:
            filter === 'HTTP' ? '✅ 🔗 طلبات HTTP' : '🔗 طلبات HTTP/API',
          callbackData: 'net:list:HTTP:1',
        },
      ],
      // Row 2: Advanced Filters
      [
        {
          text:
            filter === 'LOCAL_API'
              ? '✅ 🏠 الخادم المحلي'
              : '🏠 طلبات الخادم المحلي',
          callbackData: 'net:list:LOCAL_API:1',
        },
        {
          text:
            filter === 'VOIP_RTP'
              ? '✅ 📹 مكالمات VoIP'
              : '📹 تدفق مكالمات VoIP',
          callbackData: 'net:list:VOIP_RTP:1',
        },
        {
          text:
            filter === 'ERRORS'
              ? '✅ ❌ الأخطاء والبطء'
              : '❌ الأخطاء والبطء فقط',
          callbackData: 'net:list:ERRORS:1',
        },
      ],
    ];

    // Row 3: Quick Inspection buttons (#1 to #5)
    const topFive = queryResult.items.slice(0, 5);
    if (topFive.length > 0) {
      const inspectRow: InlineButtonSpec[] = topFive.map((item, idx) => ({
        text: `🔍 #${idx + 1}`,
        callbackData: `net:view:${item.shortId}`,
      }));
      keyboard.push(inspectRow);
    }

    // Row 4: Pagination if more than 1 page
    if (queryResult.totalPages > 1) {
      const pageRow: InlineButtonSpec[] = [];
      if (queryResult.page > 1) {
        pageRow.push({
          text: '⬅️ السابق',
          callbackData: `net:list:${filter}:${queryResult.page - 1}`,
        });
      }
      pageRow.push({
        text: `📄 ${queryResult.page} / ${queryResult.totalPages}`,
        callbackData: `net:list:${filter}:${queryResult.page}`,
      });
      if (queryResult.page < queryResult.totalPages) {
        pageRow.push({
          text: '➡️ التالي',
          callbackData: `net:list:${filter}:${queryResult.page + 1}`,
        });
      }
      keyboard.push(pageRow);
    }

    // Row 5: Ping & Export
    keyboard.push([
      {
        text: '⚡ فحص سرعة وبنق الخوادم (Live Ping)',
        callbackData: 'net:ping',
      },
      {
        text: '📥 تصدير السجل الكامل (JSON)',
        callbackData: 'net:export',
      },
    ]);

    // Row 6: Toggle Capture & Clear
    keyboard.push([
      {
        text: metrics.captureEnabled
          ? '⏸️ إيقاف الالتقاط مؤقتاً'
          : '▶️ تشغيل الالتقاط الحي',
        callbackData: 'net:toggle',
      },
      {
        text: '🗑️ مسح السجل',
        callbackData: 'net:clear',
      },
    ]);

    // Row 7: Standard Navigation
    keyboard.push(
      buildAppNavigationRow({
        backCallback: 'menu:main',
        refreshCallback: `net:list:${filter}:${queryResult.page}`,
      })
    );

    return {
      text,
      keyboard,
      route: `net:list:${filter}:${queryResult.page}`,
    };
  }

  public renderEntryDetail(
    actorUserId: number,
    idOrShortId: string
  ): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const entry = this.monitor.findEntryById(idOrShortId);
    const activeFilter = this.lastFilterByAdmin.get(actorUserId) || 'ALL';

    if (!entry) {
      return {
        text:
          `⚠️ *لم يتم العثور على الطلب أو العقدة المطلوبة (\`${escapeMarkdown(idOrShortId)}\`).*\n` +
          `ربما تم تدوير السجل في الذاكرة الدائرية أو مسحه.`,
        keyboard: [
          [
            {
              text: '🔙 العودة لمرصد الشبكة',
              callbackData: `net:list:${activeFilter}:1`,
            },
            { text: '🏠 الرئيسية', callbackData: 'menu:main' },
          ],
        ],
        toastText: '⚠️ لم يتم العثور على السجل',
      };
    }

    const dirLabel =
      entry.direction === 'OUTBOUND' ? '⬆️ صادر (OUTBOUND)' : '⬇️ وارد (INBOUND)';
    const codeLang = entry.channel === 'WA_STANZA' ? 'xml' : 'json';

    const attrsOrHeadersObj =
      entry.channel === 'WA_STANZA'
        ? entry.stanzaAttrs
        : {
            ...(entry.requestHeaders ? { request: entry.requestHeaders } : {}),
            ...(entry.responseHeaders ? { response: entry.responseHeaders } : {}),
          };

    const attrsBlock =
      attrsOrHeadersObj && Object.keys(attrsOrHeadersObj).length > 0
        ? `\n📋 *الترويسات / خصائص العقدة (Headers / Attrs):*\n\`\`\`json\n${sanitizeCodeBlockContent(
            JSON.stringify(attrsOrHeadersObj, null, 2),
            700
          )}\n\`\`\`\n`
        : '';

    const reqBlock = entry.requestBodyPreview
      ? `\n⬆️ *حمولة الطلب / العقدة الصادرة (Outbound Payload):*\n\`\`\`${codeLang}\n${sanitizeCodeBlockContent(
          entry.requestBodyPreview,
          1000
        )}\n\`\`\`\n`
      : '';

    const resBlock = entry.responseBodyPreview
      ? `\n⬇️ *حمولة الرد / العقدة الواردة (Inbound Payload):*\n\`\`\`${codeLang}\n${sanitizeCodeBlockContent(
          entry.responseBodyPreview,
          1000
        )}\n\`\`\`\n`
      : '';

    const errBlock = entry.errorDetail
      ? `\n🚨 *تفاصيل الخطأ:* \`${escapeMarkdown(entry.errorDetail.slice(0, 300))}\`\n`
      : '';

    let text =
      `${renderBreadcrumb(['الرئيسية', 'مرصد الشبكة', `فحص #${entry.shortId}`])}\n` +
      `🔍 *الفحص العميق للطلب / العقدة (#${entry.shortId})*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🆔 *المعرف الكامل:* \`${entry.requestId}\`\n` +
      `📡 *القناة:* \`${entry.channel}\` | *الاتجاه:* ${dirLabel}\n` +
      (entry.sessionId ? `📱 *الجلسة:* \`${entry.sessionId}\`\n` : '') +
      `🏷️ *الطريقة / الوسم:* \`${entry.methodOrTag}\`\n` +
      `🎯 *الهدف / الرابط:* \`${escapeMarkdown(entry.targetOrUrl.slice(0, 180))}\`\n` +
      `📊 *الحالة:* \`${entry.statusCode}\` (\`${entry.outcome}\`)\n` +
      `⏱️ *الوقت:* \`${entry.startedAtIso}\` | *زمن الاستجابة:* \`${entry.durationMs} ms\`\n` +
      `📦 *الحجم:* ⬆️ \`${entry.txBytes} B\` | ⬇️ \`${entry.rxBytes} B\`\n` +
      errBlock +
      attrsBlock +
      reqBlock +
      resBlock;

    if (text.length > 4000) {
      text = `${text.slice(0, 3950)}\n\`\`\`\n... [تم اختصار الحمولة لمراعاة حد 4096 حرفاً]`;
    }

    return {
      text,
      keyboard: [
        [
          {
            text: '📥 تصدير السجل الكامل (JSON)',
            callbackData: 'net:export',
          },
          {
            text: '🔙 العودة للقائمة',
            callbackData: `net:list:${activeFilter}:1`,
          },
        ],
        buildAppNavigationRow({
          backCallback: `net:list:${activeFilter}:1`,
          refreshCallback: `net:view:${entry.shortId}`,
        }),
      ],
      route: `net:view:${entry.shortId}`,
      toastText: `🔍 تفاصيل #${entry.shortId}`,
    };
  }

  public toggleCapture(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const nowEnabled = this.monitor.toggleCapture();
    this.auditRepo.record({
      actorTelegramId: actorUserId,
      action: nowEnabled
        ? 'NETWORK_MONITOR_RESUMED'
        : 'NETWORK_MONITOR_PAUSED',
      outcome: 'SUCCESS',
    });
    const filter = this.lastFilterByAdmin.get(actorUserId) || 'ALL';
    const banner = nowEnabled
      ? '▶️ *تم استئناف التقاط حركة مرور الشبكة الحية بنجاح.*'
      : '⏸️ *تم إيقاف التقاط حركة مرور الشبكة مؤقتاً.*';
    const view = this.renderDashboard(actorUserId, filter, 1, banner);
    return {
      ...view,
      toastText: nowEnabled ? '▶️ تم تشغيل الالتقاط' : '⏸️ تم إيقاف الالتقاط',
    };
  }

  public clearBuffer(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    this.monitor.clearBuffer();
    this.auditRepo.record({
      actorTelegramId: actorUserId,
      action: 'NETWORK_MONITOR_BUFFER_CLEARED',
      outcome: 'SUCCESS',
    });
    const view = this.renderDashboard(
      actorUserId,
      'ALL',
      1,
      '🗑️ *تم مسح السجل المؤقت لحركة مرور الشبكة وإعادة ضبط المؤشرات.*'
    );
    return {
      ...view,
      toastText: '🗑️ تم مسح سجل الشبكة',
    };
  }

  public async executeLivePing(actorUserId: number): Promise<BotViewResponse> {
    this.assertOwnerOnly(actorUserId);
    const results = await this.monitor.runLiveServerPing({
      sqlitePingFn: () => {
        this.auditRepo.listRecent(1);
      },
      timeoutMs: 3500,
    });

    const lines = results.map((r) => {
      const icon = r.reachable ? '🟢' : '🔴';
      return (
        `${icon} *${r.labelArabic}*\n` +
        `   • الهدف: \`${r.target}\`\n` +
        `   • زمن الاستجابة (RTT): \`${r.rttMs} ms\` — الحالة: \`${r.statusDetail}\``
      );
    });

    const filter = this.lastFilterByAdmin.get(actorUserId) || 'ALL';

    return {
      text:
        `${renderBreadcrumb(['الرئيسية', 'مرصد الشبكة', 'فحص سرعة وبنق الخوادم'])}\n` +
        `⚡ *نتائج فحص سرعة وبنق الخوادم الحية (Live Server Ping & RTT)*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `${lines.join('\n\n')}\n\n` +
        `🕒 *وقت القياس:* \`${new Date().toISOString()}\``,
      keyboard: [
        [
          {
            text: '🔄 إعادة فحص البنق',
            callbackData: 'net:ping',
          },
          {
            text: '🔙 العودة لمرصد الشبكة',
            callbackData: `net:list:${filter}:1`,
          },
        ],
        buildAppNavigationRow({
          backCallback: `net:list:${filter}:1`,
          refreshCallback: 'net:ping',
        }),
      ],
      route: 'net:ping',
      toastText: '⚡ اكتمل فحص سرعة الخوادم',
    };
  }

  public exportTrafficReport(actorUserId: number): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const exported = this.monitor.exportSanitizedReportJson();

    let tempFilePath = '';
    try {
      tempFilePath = path.join(os.tmpdir(), exported.fileName);
      fs.writeFileSync(tempFilePath, exported.buffer);
    } catch {
      tempFilePath = '';
    }

    const attachment: TelegramMediaAttachment = {
      kind: 'document',
      filePath: tempFilePath,
      fileName: exported.fileName,
      mimeType: 'application/json',
      buffer: exported.buffer,
      caption: `📥 تقرير حركة مرور الشبكة الكامل (منقّح وآمن) — عدد السجلات: ${exported.entryCount}`,
    };

    this.auditRepo.record({
      actorTelegramId: actorUserId,
      action: 'NETWORK_MONITOR_EXPORTED',
      outcome: 'SUCCESS',
      metadata: {
        fileName: exported.fileName,
        entryCount: exported.entryCount,
        sizeBytes: exported.buffer.byteLength,
      },
    });

    const filter = this.lastFilterByAdmin.get(actorUserId) || 'ALL';
    const view = this.renderDashboard(
      actorUserId,
      filter,
      1,
      `📥 *تم توليد وإرفاق تقرير حركة مرور الشبكة الكامل (\`${exported.fileName}\` — \`${exported.entryCount}\` سجل).*`
    );

    return {
      ...view,
      mediaAttachments: [attachment],
      toastText: '📥 تم تصدير تقرير حركة المرور',
    };
  }

  public handleCommandNetTraffic(
    actorUserId: number,
    rawFilterArg?: string
  ): BotViewResponse {
    this.assertOwnerOnly(actorUserId);
    const upper = (rawFilterArg || '').trim().toUpperCase();
    let filter: NetworkTrafficFilter = 'ALL';
    if (
      upper === 'HTTP' ||
      upper === 'WA_STANZA' ||
      upper === 'LOCAL_API' ||
      upper === 'VOIP_RTP' ||
      upper === 'ERRORS'
    ) {
      filter = upper as NetworkTrafficFilter;
    } else if (upper === 'WA' || upper === 'STANZA' || upper === 'IQ') {
      filter = 'WA_STANZA';
    } else if (upper === 'API' || upper === 'LOCAL') {
      filter = 'LOCAL_API';
    } else if (upper === 'VOIP' || upper === 'RTP') {
      filter = 'VOIP_RTP';
    } else if (upper === 'ERR' || upper === 'ERROR') {
      filter = 'ERRORS';
    }
    return this.renderDashboard(actorUserId, filter, 1);
  }
}
