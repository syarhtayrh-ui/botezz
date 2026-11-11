import { NextRequest, NextResponse } from 'next/server';
import {
  getRuntimeHarness,
  isDestructiveLiveSessionAction,
} from '../../../src/runtime-harness';
import {
  ADMIN_SESSION_COOKIE_NAME,
  computeAdminSessionToken,
  timingSafeStringMatch,
  toClientSafeAuditDto,
  toClientSafeSessionDto,
  verifyWebRequestAuth,
} from '../../../src/security/web-auth';
import { toSafeArabicError } from '../../../src/utils/errors';
import { getNetworkTrafficMonitor } from '../../../src/network/network-traffic-monitor';

function extractClientIp(req: NextRequest): string {
  const xff = req?.headers?.get?.('x-forwarded-for');
  if (xff) {
    return xff.split(',')[0].trim();
  }
  return req?.headers?.get?.('x-real-ip') || '127.0.0.1';
}

export async function GET(req: NextRequest) {
  const auth = verifyWebRequestAuth({
    headers: req?.headers,
    cookies: req?.cookies,
  });
  if (!auth.authorized) {
    return NextResponse.json(
      {
        ok: false,
        authRequired: true,
        error:
          auth.errorArabic ||
          'غير مصرح بالوصول إلى واجهة البرمجة (Unauthorized).',
      },
      { status: auth.status }
    );
  }

  try {
    const startedAt = Date.now();
    const harness = await getRuntimeHarness();
    // In live production mode, read SQLite session records directly so the web dashboard
    // never overwrites live socket statuses owned by the standalone bot process.
    const rawSessions = harness.isLiveConfigured
      ? harness.sessionRepo.listAll()
      : harness.sessionManager.listSessions();
    const sessions = rawSessions.map(toClientSafeSessionDto);
    const tasks = harness.taskManager.listRecentTasks(15);
    const auditLogs = harness.auditRepo.listRecent(20).map(toClientSafeAuditDto);
    const settings = harness.settingsRepo.listAll();
    const runnerStats = harness.taskManager.getRunnerStats();
    const botView = harness.getFreshBotView();

    getNetworkTrafficMonitor().recordLocalApiRequest({
      method: 'GET',
      route: '/api/harness',
      actionSummary: 'Fetch Dashboard State',
      clientIp: extractClientIp(req),
      statusCode: 200,
      durationMs: Math.max(1, Date.now() - startedAt),
      responsePayload: {
        sessionsCount: sessions.length,
        tasksCount: tasks.length,
        route: botView.route || 'menu:main',
      },
    });

    const networkTelemetry = {
      metrics: harness.networkMonitor.getMetrics(),
      recentEntries: harness.networkMonitor.queryEntries({
        filter: 'ALL',
        page: 1,
        pageSize: 25,
      }).items,
    };

    return NextResponse.json({
      ok: true,
      authRequired: false,
      environmentMode: harness.isLiveConfigured
        ? 'LIVE_ENV_CONFIGURED'
        : 'LOCAL_SIMULATION_HARNESS',
      isReadOnlyWebObserver: harness.isReadOnlyWebObserver,
      validationIssues: harness.validationIssues,
      configuredAdminId: harness.config.TELEGRAM_ADMIN_ID,
      maxConcurrentTasks: harness.config.MAX_CONCURRENT_TASKS,
      taskTimeoutMs: harness.config.TASK_TIMEOUT_MS,
      maxUploadSizeMb: harness.config.MAX_UPLOAD_SIZE_MB,
      botView,
      sessions,
      tasks,
      auditLogs,
      settings,
      networkTelemetry,
      health: {
        status: 'HEALTHY',
        connectedSessions: sessions.filter(
          (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
        ).length,
        totalSessions: sessions.length,
        runningTasks: runnerStats.active,
        pendingTasks: runnerStats.queued,
        lastSuccessfulOperationAt: harness.taskManager.getLastSuccessfulOperationAt(),
      },
    });
  } catch (err) {
    const safeErr = toSafeArabicError(err);
    return NextResponse.json(
      { ok: false, error: safeErr.userMessage, category: safeErr.category },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  let body: {
    action?: 'login' | 'logout';
    secret?: string;
    type?: 'callback' | 'text';
    actorUserId?: number;
    payload?: string;
    repliedText?: string;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'حمولة الطلب غير صالحة (Invalid JSON).' },
      { status: 400 }
    );
  }

  if (body.action === 'login') {
    const configuredSecret = process.env.DASHBOARD_API_SECRET?.trim() || '';
    const candidate = (body.secret || '').trim();
    if (!configuredSecret || !timingSafeStringMatch(candidate, configuredSecret)) {
      return NextResponse.json(
        {
          ok: false,
          authRequired: true,
          error: 'مفتاح الدخول غير صحيح. يرجى التحقق من DASHBOARD_API_SECRET.',
        },
        { status: 401 }
      );
    }

    const token = computeAdminSessionToken(configuredSecret);
    const res = NextResponse.json({
      ok: true,
      authenticated: true,
      authRequired: false,
    });
    res.cookies.set(ADMIN_SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 12,
    });
    return res;
  }

  if (body.action === 'logout') {
    const res = NextResponse.json({
      ok: true,
      authenticated: false,
      authRequired: true,
    });
    res.cookies.delete(ADMIN_SESSION_COOKIE_NAME);
    return res;
  }

  const auth = verifyWebRequestAuth({
    headers: req?.headers,
    cookies: req?.cookies,
  });
  if (!auth.authorized) {
    return NextResponse.json(
      {
        ok: false,
        authRequired: true,
        error:
          auth.errorArabic ||
          'غير مصرح بالوصول إلى واجهة البرمجة (Unauthorized).',
      },
      { status: auth.status }
    );
  }

  let harness: Awaited<ReturnType<typeof getRuntimeHarness>> | undefined;
  try {
    harness = await getRuntimeHarness();

    const payload = String(body.payload ?? '');
    if (
      harness.isReadOnlyWebObserver &&
      isDestructiveLiveSessionAction({
        callbackData: body.type === 'callback' ? payload : undefined,
        text: body.type === 'text' ? payload : undefined,
      })
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'لا يمكن تعديل أو حذف أو إعادة تشغيل جلسات واتساب الحية من واجهة المحاكاة أثناء عمل البوت المستقل؛ يرجى تنفيذ هذا الإجراء من بوت تيليجرام مباشرة.',
          category: 'CONFLICT',
        },
        { status: 409 }
      );
    }

    // Derive actorUserId server-side in live mode; allow simulation toggle only in local demo mode (BZ-014)
    const actorUserId = harness.isLiveConfigured
      ? harness.config.TELEGRAM_ADMIN_ID
      : Number(body.actorUserId) || harness.config.TELEGRAM_ADMIN_ID;

    const postStartedAt = Date.now();
    let view;
    if (body.type === 'callback') {
      view = await harness.controller.handleCallbackQuery(
        actorUserId,
        payload
      );
    } else {
      view = await harness.controller.handleTextMessage(
        actorUserId,
        payload,
        body.repliedText
      );
    }

    harness.lastBotView = view;

    const rawSessions = harness.isLiveConfigured
      ? harness.sessionRepo.listAll()
      : harness.sessionManager.listSessions();
    const sessions = rawSessions.map(toClientSafeSessionDto);
    const tasks = harness.taskManager.listRecentTasks(15);
    const auditLogs = harness.auditRepo.listRecent(20).map(toClientSafeAuditDto);
    const runnerStats = harness.taskManager.getRunnerStats();

    getNetworkTrafficMonitor().recordLocalApiRequest({
      method: 'POST',
      route: '/api/harness',
      actionSummary: `${body.type || 'text'}: ${payload.slice(0, 48)}`,
      clientIp: extractClientIp(req),
      statusCode: 200,
      durationMs: Math.max(1, Date.now() - postStartedAt),
      requestPayload: {
        type: body.type,
        actorUserId,
        payload: payload.slice(0, 120),
      },
      responsePayload: {
        route: view.route,
        toastText: view.toastText,
      },
    });

    const networkTelemetry = {
      metrics: harness.networkMonitor.getMetrics(),
      recentEntries: harness.networkMonitor.queryEntries({
        filter: 'ALL',
        page: 1,
        pageSize: 25,
      }).items,
    };

    return NextResponse.json({
      ok: true,
      botView: harness.getFreshBotView(),
      sessions,
      tasks,
      auditLogs,
      networkTelemetry,
      health: {
        status: 'HEALTHY',
        connectedSessions: sessions.filter(
          (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
        ).length,
        totalSessions: sessions.length,
        runningTasks: runnerStats.active,
        pendingTasks: runnerStats.queued,
        lastSuccessfulOperationAt: harness.taskManager.getLastSuccessfulOperationAt(),
      },
    });
  } catch (err) {
    const safeErr = toSafeArabicError(err);
    getNetworkTrafficMonitor().recordLocalApiRequest({
      method: 'POST',
      route: '/api/harness',
      actionSummary: `ERROR: ${String(body?.payload ?? '').slice(0, 40)}`,
      clientIp: extractClientIp(req),
      statusCode: safeErr.category === 'AUTHORIZATION_ERROR' ? 403 : 400,
      durationMs: 1,
      requestPayload: body,
      errorDetail: safeErr.userMessage,
    });
    const auditLogs = harness
      ? harness.auditRepo.listRecent(20).map(toClientSafeAuditDto)
      : [];
    const networkTelemetry = harness
      ? {
          metrics: harness.networkMonitor.getMetrics(),
          recentEntries: harness.networkMonitor.queryEntries({
            filter: 'ALL',
            page: 1,
            pageSize: 25,
          }).items,
        }
      : undefined;
    return NextResponse.json(
      {
        ok: false,
        error: safeErr.userMessage,
        category: safeErr.category,
        auditLogs,
        networkTelemetry,
      },
      { status: safeErr.category === 'AUTHORIZATION_ERROR' ? 403 : 400 }
    );
  }
}
