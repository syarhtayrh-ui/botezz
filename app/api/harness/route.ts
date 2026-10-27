import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeHarness } from '../../../src/runtime-harness';
import { toSafeArabicError } from '../../../src/utils/errors';

export async function GET() {
  try {
    const harness = await getRuntimeHarness();
    const sessions = harness.sessionManager.listSessions();
    const tasks = harness.taskManager.listRecentTasks(15);
    const auditLogs = harness.auditRepo.listRecent(20);
    const settings = harness.settingsRepo.listAll();
    const runnerStats = harness.taskManager.getRunnerStats();

    return NextResponse.json({
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
      settings,
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
  const harness = await getRuntimeHarness();
  try {
    const body = (await req.json()) as {
      type: 'callback' | 'text';
      actorUserId: number;
      payload: string;
      repliedText?: string;
    };

    const actorUserId = Number(body.actorUserId);
    let view;
    if (body.type === 'callback') {
      view = await harness.controller.handleCallbackQuery(
        actorUserId,
        body.payload
      );
    } else {
      view = await harness.controller.handleTextMessage(
        actorUserId,
        body.payload,
        body.repliedText
      );
    }

    harness.lastBotView = view;

    const sessions = harness.sessionManager.listSessions();
    const tasks = harness.taskManager.listRecentTasks(15);
    const auditLogs = harness.auditRepo.listRecent(20);
    const runnerStats = harness.taskManager.getRunnerStats();

    return NextResponse.json({
      ok: true,
      botView: view,
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
    });
  } catch (err) {
    const safeErr = toSafeArabicError(err);
    const auditLogs = harness.auditRepo.listRecent(20);
    return NextResponse.json(
      {
        ok: false,
        error: safeErr.userMessage,
        category: safeErr.category,
        auditLogs,
      },
      { status: safeErr.category === 'AUTHORIZATION_ERROR' ? 403 : 400 }
    );
  }
}
