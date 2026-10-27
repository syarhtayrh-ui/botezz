import ControlCenterDashboard, {
  HarnessStateResponse,
} from '../components/ControlCenterDashboard';
import { getRuntimeHarness } from '../src/runtime-harness';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const harness = await getRuntimeHarness();
  const sessions = harness.sessionManager.listSessions();
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
      lastSuccessfulOperationAt: harness.taskManager.getLastSuccessfulOperationAt(),
    },
  };

  const plainInitialData: HarnessStateResponse = JSON.parse(
    JSON.stringify(initialData)
  );

  return <ControlCenterDashboard initialData={plainInitialData} />;
}
