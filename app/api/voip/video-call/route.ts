import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeHarness } from '../../../../src/runtime-harness';
import { verifyWebRequestAuth } from '../../../../src/security/web-auth';
import { toSafeArabicError } from '../../../../src/utils/errors';

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
    const harness = await getRuntimeHarness();
    const bridge = harness.controller.videoCallBridge;
    const downloadCallId = req.nextUrl.searchParams.get('downloadCallId');
    const callId = req.nextUrl.searchParams.get('callId');
    const sessionId = req.nextUrl.searchParams.get('sessionId') ?? undefined;

    if (downloadCallId) {
      const call = bridge.getStreamById(downloadCallId);
      if (
        !call ||
        call.recordingStatus !== 'READY' ||
        !call.recordedVideoPath ||
        !fs.existsSync(call.recordedVideoPath)
      ) {
        return NextResponse.json(
          { ok: false, error: 'ملف تسجيل المكالمة المطلوب غير متاح.' },
          { status: 404 }
        );
      }
      const buffer = fs.readFileSync(call.recordedVideoPath);
      const fileName =
        call.recordedVideoFileName || path.basename(call.recordedVideoPath);
      return new NextResponse(buffer, {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(buffer.length),
          'Content-Disposition': `attachment; filename="${fileName}"`,
        },
      });
    }

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
    const completedCalls = bridge.listCompletedStreams(sessionId).slice(0, 20);

    return NextResponse.json({
      ok: true,
      probe,
      activeCalls: sessionId
        ? activeCalls.filter((c) => c.sessionId === sessionId)
        : activeCalls,
      completedCalls,
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
    const harness = await getRuntimeHarness();
    const bridge = harness.controller.videoCallBridge;
    const body = (await req.json()) as {
      action?: 'start' | 'stop';
      sessionId?: string;
      recipientJid?: string;
      videoFilePath?: string;
      callKind?: 'video' | 'voice';
      loopVideo?: boolean;
      recordCall?: boolean;
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
      recordCall: body.recordCall !== false,
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
