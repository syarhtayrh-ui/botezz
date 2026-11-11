import { cookies, headers } from 'next/headers';
import ControlCenterDashboard, {
  HarnessStateResponse,
} from '../components/ControlCenterDashboard';
import { getRuntimeHarness } from '../src/runtime-harness';
import {
  toClientSafeAuditDto,
  toClientSafeSessionDto,
  verifyWebRequestAuth,
} from '../src/security/web-auth';

export const dynamic = 'force-dynamic';

function buildLockedInitialData(errorArabic?: string): HarnessStateResponse {
  return {
    ok: false,
    authRequired: true,
    environmentMode: 'AUTH_REQUIRED',
    errorBanner:
      errorArabic ||
      'غير مصرح بالوصول إلى واجهة التحكم. يرجى تسجيل الدخول بمفتاح DASHBOARD_API_SECRET الصحيح.',
    validationIssues: [],
    configuredAdminId: 0,
    maxConcurrentTasks: 0,
    taskTimeoutMs: 0,
    maxUploadSizeMb: 0,
    botView: {
      text: '🔒 *واجهة التحكم محمية*\nيرجى إدخال مفتاح الإدارة (`DASHBOARD_API_SECRET`) للمتابعة.',
      keyboard: [],
    },
    sessions: [],
    tasks: [],
    auditLogs: [],
    health: {
      status: 'UNAUTHORIZED',
      connectedSessions: 0,
      totalSessions: 0,
      runningTasks: 0,
      pendingTasks: 0,
      lastSuccessfulOperationAt: null,
    },
  };
}

function buildUnavailableInitialData(): HarnessStateResponse {
  return {
    ok: false,
    authRequired: false,
    environmentMode: 'BACKEND_UNAVAILABLE',
    errorBanner:
      'تعذر تهيئة الخادم الخلفي أو الاتصال بقاعدة البيانات المحلية (BACKEND_UNAVAILABLE).',
    validationIssues: [
      'تعذر تحميل حالة النظام من الخادم الخلفي أثناء التمهيد الأولي.',
    ],
    configuredAdminId: 0,
    maxConcurrentTasks: 0,
    taskTimeoutMs: 0,
    maxUploadSizeMb: 0,
    botView: {
      text: '⚠️ *الخادم الخلفي غير متاح حالياً (UNAVAILABLE)*\nيرجى التحقق من سجلات النظام وقاعدة البيانات ثم إعادة المحاولة.',
      keyboard: [],
    },
    sessions: [],
    tasks: [],
    auditLogs: [],
    health: {
      status: 'UNAVAILABLE',
      connectedSessions: 0,
      totalSessions: 0,
      runningTasks: 0,
      pendingTasks: 0,
      lastSuccessfulOperationAt: null,
    },
  };
}

async function loadInitialData(): Promise<HarnessStateResponse> {
  try {
    const reqHeaders = await headers();
    const reqCookies = await cookies();
    const auth = verifyWebRequestAuth({
      headers: reqHeaders,
      cookies: reqCookies,
    });

    if (!auth.authorized) {
      return buildLockedInitialData(auth.errorArabic);
    }
  } catch {
    // If called outside Next.js request context in unit tests, evaluate env auth directly
    const auth = verifyWebRequestAuth();
    if (!auth.authorized) {
      return buildLockedInitialData(auth.errorArabic);
    }
  }

  try {
    const harness = await getRuntimeHarness();
    const rawSessions = harness.isLiveConfigured
      ? harness.sessionRepo.listAll()
      : harness.sessionManager.listSessions();
    const sessions = rawSessions.map(toClientSafeSessionDto);
    const tasks = harness.taskManager.listRecentTasks(15);
    const auditLogs = harness.auditRepo.listRecent(20).map(toClientSafeAuditDto);
    const runnerStats = harness.taskManager.getRunnerStats();

    const initialData: HarnessStateResponse = {
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
      botView: harness.getFreshBotView(),
      sessions,
      tasks,
      auditLogs,
      networkTelemetry: {
        metrics: harness.networkMonitor.getMetrics(),
        recentEntries: harness.networkMonitor.queryEntries({
          filter: 'ALL',
          page: 1,
          pageSize: 25,
        }).items,
      },
      health: {
        status: 'HEALTHY',
        connectedSessions: sessions.filter(
          (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
        ).length,
        totalSessions: sessions.length,
        runningTasks: runnerStats.active,
        pendingTasks: runnerStats.queued,
        lastSuccessfulOperationAt:
          harness.taskManager.getLastSuccessfulOperationAt(),
      },
    };

    const plainInitialData: HarnessStateResponse = JSON.parse(
      JSON.stringify(initialData)
    );

    return plainInitialData;
  } catch {
    return buildUnavailableInitialData();
  }
}

export default async function HomePage() {
  const initialData = await loadInitialData();
  return <ControlCenterDashboard initialData={initialData} />;
}
