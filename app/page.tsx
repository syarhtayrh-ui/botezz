import ControlCenterDashboard, {
  HarnessStateResponse,
} from '../components/ControlCenterDashboard';
import { getRuntimeHarness } from '../src/runtime-harness';

export const dynamic = 'force-dynamic';

const FALLBACK_INITIAL_DATA: HarnessStateResponse = {
  ok: true,
  environmentMode: 'LOCAL_SIMULATION_HARNESS',
  validationIssues: [],
  configuredAdminId: 100000001,
  maxConcurrentTasks: 4,
  taskTimeoutMs: 30000,
  maxUploadSizeMb: 25,
  botView: {
    text: '👋 أهلاً بك في منظومة التحكم بجلسات واتساب عبر تيليجرام.\nاختر العملية المطلوبة من الأزرار التفاعلية أدناه:',
    keyboard: [
      [
        { text: '📱 إدارة الجلسات', callbackData: 'nav:sessions' },
        { text: '✉️ إرسال رسالة', callbackData: 'nav:send_message' },
      ],
      [
        { text: '🎥 مكالمة فيديو (VoIP)', callbackData: 'nav:video_call' },
        { text: '🧪 مختبر الوظائف', callbackData: 'nav:function_lab' },
      ],
    ],
  },
  sessions: [],
  tasks: [],
  auditLogs: [],
  health: {
    status: 'HEALTHY',
    connectedSessions: 0,
    totalSessions: 0,
    runningTasks: 0,
    pendingTasks: 0,
    lastSuccessfulOperationAt: null,
  },
};

async function loadInitialData(): Promise<HarnessStateResponse> {
  try {
    const harness = await getRuntimeHarness();
    const sessions = harness.isLiveConfigured
      ? harness.sessionRepo.listAll()
      : harness.sessionManager.listSessions();
    const tasks = harness.taskManager.listRecentTasks(15);
    const auditLogs = harness.auditRepo.listRecent(20);
    const runnerStats = harness.taskManager.getRunnerStats();

    const initialData: HarnessStateResponse = {
      ok: true,
      environmentMode: harness.isLiveConfigured
        ? 'LIVE_ENV_CONFIGURED'
        : 'LOCAL_SIMULATION_HARNESS',
      validationIssues: harness.validationIssues,
      configuredAdminId: harness.config.TELEGRAM_ADMIN_ID,
      maxConcurrentTasks: harness.config.MAX_CONCURRENT_TASKS,
      taskTimeoutMs: harness.config.TASK_TIMEOUT_MS,
      maxUploadSizeMb: harness.config.MAX_UPLOAD_SIZE_MB,
      botView: harness.lastBotView,
      sessions,
      tasks,
      auditLogs,
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
    return structuredClone(FALLBACK_INITIAL_DATA);
  }
}

export default async function HomePage() {
  const initialData = await loadInitialData();
  return <ControlCenterDashboard initialData={initialData} />;
}
