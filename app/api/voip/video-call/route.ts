import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeHarness } from '../../../../src/runtime-harness';
import { toSafeArabicError } from '../../../../src/utils/errors';

function isAuthorizedApiRequest(
  req: NextRequest | undefined,
  isLiveConfigured: boolean
): boolean {
  const configuredSecret = process.env.DASHBOARD_API_SECRET?.trim();
  if (!isLiveConfigured || !configuredSecret) {
    return true;
  }
  if (!req) {
    return false;
  }
  const headerSecret = req.headers.get('x-api-secret')?.trim();
  const bearerSecret = req.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim();
  return headerSecret === configuredSecret || bearerSecret === configuredSecret;
}

export async function GET(req: NextRequest) {
  try {
    const harness = await getRuntimeHarness();
    if (!isAuthorizedApiRequest(req, harness.isLiveConfigured)) {
      return NextResponse.json(
        { ok: false, error: 'غير مصرح بالوصول إلى واجهة البرمجة (Unauthorized).' },
        { status: 401 }
      );
    }

    const bridge = harness.controller.videoCallBridge;
    const callId = req.nextUrl.searchParams.get('callId');
    const sessionId = req.nextUrl.searchParams.get('sessionId') ?? undefined;

    if (callId) {
      const call = sessionId
        ? bridge.getCallStatus(sessionId, callId)
        : bridge.getStreamById(callId);
      if (!call) {
        return NextResponse.json(
          { ok: false, error: 'المكالمة المطلوبة غير موجودة.' },
          { status: 404 }
        );
      }
      return NextResponse.json({
        ok: true,
        call,
      });
    }

    const probe = bridge.probeEnvironment();
    const sessions = harness.sessionManager.listSessions();
    const activeCalls = sessions
      .map((s) => bridge.getActiveStreamForSession(s.id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));

    return NextResponse.json({
      ok: true,
      probe,
      activeCalls: sessionId
        ? activeCalls.filter((c) => c.sessionId === sessionId)
        : activeCalls,
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
  try {
    const harness = await getRuntimeHarness();
    if (!isAuthorizedApiRequest(req, harness.isLiveConfigured)) {
      return NextResponse.json(
        { ok: false, error: 'غير مصرح بالوصول إلى واجهة البرمجة (Unauthorized).' },
        { status: 401 }
      );
    }

    const bridge = harness.controller.videoCallBridge;
    const body = (await req.json()) as {
      action?: 'start' | 'stop';
      sessionId?: string;
      recipientJid?: string;
      videoFilePath?: string;
      callKind?: 'video' | 'voice';
      loopVideo?: boolean;
      maxDurationSeconds?: number;
      callTimeoutMs?: number;
      callId?: string;
    };

    if (body.action === 'stop') {
      if (!body.callId) {
        return NextResponse.json(
          { ok: false, error: 'يجب تحديد معرف المكالمة (callId) لإيقافها.' },
          { status: 400 }
        );
      }
      const stopped = await bridge.stopVideoCallStream(
        body.callId,
        harness.config.TELEGRAM_ADMIN_ID,
        {
          reason: 'تم إنهاء المكالمة عبر واجهة البرمجة (API).',
        }
      );
      return NextResponse.json({
        ok: true,
        call: stopped,
      });
    }

    if (!body.sessionId || !body.recipientJid) {
      return NextResponse.json(
        {
          ok: false,
          error: 'يجب تحديد معرف الجلسة (sessionId) ورقم أو معرف المستلم (recipientJid).',
        },
        { status: 400 }
      );
    }

    const stream = await bridge.startVideoCall({
      sessionId: body.sessionId,
      recipientJid: body.recipientJid,
      videoFilePath: body.videoFilePath,
      callKind: body.callKind ?? 'video',
      loopVideo: body.loopVideo ?? false,
      maxDurationSeconds: body.maxDurationSeconds ?? 45,
      callTimeoutMs: body.callTimeoutMs ?? 45_000,
      actorTelegramId: harness.config.TELEGRAM_ADMIN_ID,
      allowedRootDirs: [process.cwd(), harness.config.TEMP_UPLOAD_DIR, '/tmp'],
    });

    return NextResponse.json({
      ok: true,
      call: stream,
    });
  } catch (err) {
    const safeErr = toSafeArabicError(err);
    return NextResponse.json(
      { ok: false, error: safeErr.userMessage, category: safeErr.category },
      { status: 400 }
    );
  }
}
