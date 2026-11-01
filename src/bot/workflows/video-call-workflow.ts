import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../whatsapp/session-manager';
import {
  UbuntuVideoCallBridge,
  NativeCallProtocolMode,
} from '../../whatsapp/video-call-bridge';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { normalizePhoneNumber } from '../../security/validation';
import { createMinimalMp4Buffer } from '../../function-lab/media-sticker-toolkit';
import {
  InlineButtonSpec,
  InlineKeyboardRows,
  buildBackCancelRow,
  buildAppNavigationRow,
} from '../keyboards/main-menu';
import { BotViewResponse } from './pairing-workflow';
import { toSafeArabicError, ValidationError } from '../../utils/errors';

export type VideoCallStep =
  | 'AWAITING_RECIPIENT'
  | 'AWAITING_VIDEO'
  | 'READY_TO_CALL'
  | 'STREAMING';

export interface VideoCallWorkflowState {
  step: VideoCallStep;
  selectedSessionId?: string;
  recipientJid?: string;
  recipientDisplay?: string;
  videoFilePath?: string;
  videoFileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  callKind: 'video' | 'voice';
  protocolMode: NativeCallProtocolMode;
  wavesCount: number;
  loopVideo: boolean;
  maxDurationSeconds: number;
  activeCallId?: string;
}

const PROTOCOL_MODE_LABELS: Record<NativeCallProtocolMode, string> = {
  NATIVE_CALL_OFFER_RING: '📞 رنين مكالمة حقيقي عبر البروتوكول (<call><offer>)',
  HYBRID_CALL_OFFER_AND_PTV: '📹 رنين مكالمة + بث فيديو مسجل فوري (Hybrid PTV)',
  SCHEDULED_AND_CALL_LOG_PROTOCOL: '📅 إشعار وعقدة مكالمة مجدولة (Scheduled Call)',
};

export class VideoCallWorkflow {
  private readonly states = new Map<number, VideoCallWorkflowState>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly videoCallBridge: UbuntuVideoCallBridge,
    private readonly auditRepo: AuditRepository,
    private readonly tempUploadDir = path.resolve(
      process.cwd(),
      'data',
      'temp_uploads'
    ),
    private readonly maxUploadSizeMb = 50
  ) {
    fs.mkdirSync(this.tempUploadDir, { recursive: true });
  }

  public getState(adminId: number): VideoCallWorkflowState | undefined {
    return this.states.get(adminId);
  }

  public getDraft(adminId: number): VideoCallWorkflowState | undefined {
    return this.states.get(adminId);
  }

  public isActive(adminId: number): boolean {
    return this.states.has(adminId);
  }

  public cancel(adminId: number): void {
    const existing = this.states.get(adminId);
    if (existing?.videoFilePath && fs.existsSync(existing.videoFilePath)) {
      try {
        fs.unlinkSync(existing.videoFilePath);
      } catch {
        // Ignore cleanup error
      }
    }
    this.states.delete(adminId);
  }

  /**
   * Step 1 of 4: Prompt for target WhatsApp phone number.
   */
  public start(adminId: number, preselectedSessionId?: string): BotViewResponse {
    const connected = this.sessionManager.listConnectedSessions(adminId);

    if (connected.length === 0) {
      this.cancel(adminId);
      return {
        text: [
          '📹 *اتصال مرئي / صوتي عبر بروتوكول واتساب*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          '⚠️ *لا توجد جلسات متصلة حالياً*',
          '',
          'يرجى ربط جلسة واتساب واحدة على الأقل وتوصيلها قبل بدء المكالمة.',
        ].join('\n'),
        keyboard: [
          [{ text: '📲 ربط جلسة جديدة', callbackData: 'menu:link_account' }],
          buildBackCancelRow('menu:main'),
        ],
      };
    }

    const defaultSession =
      (preselectedSessionId
        ? connected.find((s) => s.id === preselectedSessionId)
        : undefined) || connected[0]!;

    this.states.set(adminId, {
      step: 'AWAITING_RECIPIENT',
      selectedSessionId: defaultSession.id,
      callKind: 'video',
      protocolMode: 'NATIVE_CALL_OFFER_RING',
      wavesCount: 1,
      loopVideo: true,
      maxDurationSeconds: 60,
    });

    const probe = this.videoCallBridge.probeEnvironment();

    return {
      text: [
        '📹 *اتصال مرئي ببث فيديو مسجل / رنين بروتوكول (الخطوة 1 من 4)*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *الجلسة النشطة:* ${defaultSession.label} (\`${defaultSession.id}\`)`,
        `• *محرك عقد المكالمات الأصيل (\`<call><offer>\`):* 🟢 متاح ومفعّل 100%`,
        `• *محرك البث الفوري للفيديو (\`PTV + Call Ring\`):* 🟢 متاح ومفعّل`,
        `• *FFmpeg / VirtualCam الاختياري:* ${
          probe.ffmpegAvailable ? '🟢 متوفر' : '⚪ غير مطلوب (محرك البروتوكول نشط)'
        }`,
        '',
        '📱 أرسل الآن *رقم هاتف المستلم* بصيغة دولية (مثال: `+966501234567`):',
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:main')],
    };
  }

  /**
   * Step 2 of 4: Validate recipient number and show instant protocol call buttons + video upload option.
   */
  public handleRecipientInput(
    adminId: number,
    rawPhoneText: string
  ): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.selectedSessionId) {
      return this.start(adminId);
    }

    try {
      const normalized = normalizePhoneNumber(rawPhoneText);
      state.recipientJid = normalized.jid;
      state.recipientDisplay = normalized.e164;
      state.step = 'AWAITING_VIDEO';
      this.states.set(adminId, state);

      return {
        text: [
          '📹 *اتصال مرئي ببث فيديو مسجل / رنين بروتوكول (الخطوة 2 من 4)*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          `• *المستلم:* \`${normalized.e164}\` (\`${normalized.masked}\`)`,
          `• *وضع البروتوكول:* ${PROTOCOL_MODE_LABELS[state.protocolMode]}`,
          `• *عدد موجات الرنين:* \`${state.wavesCount}\` موجة`,
          '',
          '💡 *يمكنك الآن الاختيار بين:*',
          '1️⃣ *بدء رنين مكالمة فيديو أو صوتية فوري عبر البروتوكول* (بدون رفع أي ملف).',
          '2️⃣ أو *رفع ملف الفيديو المسجل* (`.mp4`, `.mov`, `.webm`) في المحادثة لبثه مع المكالمة:',
        ].join('\n'),
        keyboard: [
          [
            {
              text: '📞 بدء رنين مكالمة فيديو فوري (بدون رفع ملف)',
              callbackData: 'wf_vcall:instant_ring_video',
            },
          ],
          [
            {
              text: '🔊 بدء رنين مكالمة صوتية فوري (بدون رفع ملف)',
              callbackData: 'wf_vcall:instant_ring_voice',
            },
          ],
          [
            {
              text: '🎬 إرفاق فيديو تجريبي للمعاينة (sample_call.mp4)',
              callbackData: 'wf_vcall:sample_video',
            },
          ],
          [
            {
              text: `🔔 موجات الرنين: ${state.wavesCount}`,
              callbackData: 'wf_vcall:cycle_waves',
            },
            {
              text: '🔄 تغيير وضع البروتوكول',
              callbackData: 'wf_vcall:cycle_mode',
            },
          ],
          buildBackCancelRow('menu:main'),
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: [
          '⚠️ *رقم المستلم غير صالح*',
          safeErr.userMessage,
          '',
          'يرجى إعادة إرسال رقم الهاتف بالصيغة الدولية الصحيحة (مثال: `+966501234567`):',
        ].join('\n'),
        keyboard: [buildBackCancelRow('menu:main')],
      };
    }
  }

  public submitRecipientNumber(
    adminId: number,
    rawPhoneText: string
  ): BotViewResponse {
    return this.handleRecipientInput(adminId, rawPhoneText);
  }

  /**
   * Step 3 of 4: Preview & configure settings before starting call.
   */
  public renderPreviewStep(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }

    const connected = this.sessionManager.listConnectedSessions(adminId);
    const hasVideo = Boolean(
      state.videoFilePath && fs.existsSync(state.videoFilePath)
    );

    const rows: InlineKeyboardRows = [
      [
        {
          text: hasVideo
            ? '🚀 بدء الاتصال المرئي وبث الفيديو الآن'
            : '📞 بدء رنين المكالمة عبر البروتوكول الآن',
          callbackData: 'wf_vcall:confirm_execute',
        },
      ],
      [
        {
          text: '📞 رنين فيديو فوري (بدون ملف)',
          callbackData: 'wf_vcall:instant_ring_video',
        },
        {
          text: '🔊 رنين صوتي فوري (بدون ملف)',
          callbackData: 'wf_vcall:instant_ring_voice',
        },
      ],
      [
        {
          text: `🔁 تكرار الفيديو: ${state.loopVideo ? 'مفعل ✅' : 'معطل ❌'}`,
          callbackData: 'wf_vcall:toggle_loop',
        },
        {
          text: `⏱️ المدة: ${state.maxDurationSeconds} ثانية`,
          callbackData: 'wf_vcall:cycle_duration',
        },
      ],
      [
        {
          text: `🔔 موجات الرنين: ${state.wavesCount} موجة`,
          callbackData: 'wf_vcall:cycle_waves',
        },
        {
          text: '🔄 وضع البروتوكول',
          callbackData: 'wf_vcall:cycle_mode',
        },
      ],
    ];

    if (connected.length > 1) {
      const sessionBtns: InlineButtonSpec[] = connected.slice(0, 3).map((s) => ({
        text: `${s.id === state.selectedSessionId ? '🟢' : '⚪'} ${s.label.slice(0, 14)}`,
        callbackData: `wf_vcall:select_sess:${s.id}`,
      }));
      rows.push(sessionBtns);
    }

    rows.push([
      {
        text: '📤 تغيير ملف الفيديو',
        callbackData: 'wf_vcall:reupload',
      },
    ]);
    rows.push(buildBackCancelRow('menu:main'));

    return {
      text: [
        '📹 *معاينة وتأكيد الاتصال المرئي (الخطوة 3 من 4)*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *المستلم:* \`${state.recipientDisplay || state.recipientJid}\``,
        `• *الجلسة المحددة:* \`${state.selectedSessionId}\``,
        `• *وضع البروتوكول:* ${PROTOCOL_MODE_LABELS[state.protocolMode]}`,
        `• *ملف الفيديو:* \`${state.videoFileName || 'بدون ملف (رنين بروتوكول مباشر)'}\``,
        `• *تكرار البث (Loop):* ${state.loopVideo ? 'مفعل ✅' : 'معطل ❌'}`,
        `• *المدة القصوى للمكالمة:* \`${state.maxDurationSeconds} ثانية\``,
        `• *عدد موجات الرنين:* \`${state.wavesCount}\` موجة`,
        '',
        'اضغط على زر البدء أدناه لإطلاق المكالمة مباشرة:',
      ].join('\n'),
      keyboard: rows,
    };
  }

  public async handleVideoUpload(
    adminId: number,
    upload: {
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      contentBuffer: Buffer;
    }
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }

    const maxBytes = this.maxUploadSizeMb * 1024 * 1024;
    if (upload.sizeBytes > maxBytes) {
      throw new ValidationError(
        `حجم ملف الفيديو يتجاوز الحد المسموح (${this.maxUploadSizeMb} ميجابايت).`
      );
    }

    const safeName =
      upload.originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_') ||
      `call_${Date.now()}.mp4`;
    const filePath = path.join(
      this.tempUploadDir,
      `vcall_${adminId}_${Date.now()}_${safeName}`
    );
    fs.writeFileSync(filePath, upload.contentBuffer);

    state.videoFilePath = filePath;
    state.videoFileName = safeName;
    state.mimeType = upload.mimeType || 'video/mp4';
    state.sizeBytes = upload.sizeBytes;
    state.protocolMode = 'HYBRID_CALL_OFFER_AND_PTV';
    state.step = 'READY_TO_CALL';
    this.states.set(adminId, state);

    return this.renderPreviewStep(adminId);
  }

  public attachSampleVideo(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }

    const sampleBuf = createMinimalMp4Buffer();
    const filePath = path.join(
      this.tempUploadDir,
      `sample_call_${adminId}_${Date.now()}.mp4`
    );
    fs.writeFileSync(filePath, sampleBuf);

    state.videoFilePath = filePath;
    state.videoFileName = 'sample_call.mp4';
    state.mimeType = 'video/mp4';
    state.sizeBytes = sampleBuf.length;
    state.protocolMode = 'HYBRID_CALL_OFFER_AND_PTV';
    state.step = 'READY_TO_CALL';
    this.states.set(adminId, state);

    return this.renderPreviewStep(adminId);
  }

  public useSampleVideo(adminId: number): BotViewResponse {
    return this.attachSampleVideo(adminId);
  }

  public toggleLoop(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    state.loopVideo = !state.loopVideo;
    this.states.set(adminId, state);
    return this.renderPreviewStep(adminId);
  }

  public cycleDuration(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    const durations = [30, 60, 180, 300];
    const idx = durations.indexOf(state.maxDurationSeconds);
    state.maxDurationSeconds = durations[(idx + 1) % durations.length]!;
    this.states.set(adminId, state);
    return this.renderPreviewStep(adminId);
  }

  public cycleProtocolMode(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    const modes: NativeCallProtocolMode[] = [
      'NATIVE_CALL_OFFER_RING',
      'HYBRID_CALL_OFFER_AND_PTV',
      'SCHEDULED_AND_CALL_LOG_PROTOCOL',
    ];
    const idx = modes.indexOf(state.protocolMode);
    state.protocolMode = modes[(idx + 1) % modes.length]!;
    this.states.set(adminId, state);
    return state.step === 'AWAITING_VIDEO'
      ? this.handleRecipientInput(adminId, state.recipientDisplay || state.recipientJid)
      : this.renderPreviewStep(adminId);
  }

  public cycleWavesCount(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    const counts = [1, 3, 5, 10];
    const idx = counts.indexOf(state.wavesCount);
    state.wavesCount = counts[(idx + 1) % counts.length]!;
    this.states.set(adminId, state);
    return state.step === 'AWAITING_VIDEO'
      ? this.handleRecipientInput(adminId, state.recipientDisplay || state.recipientJid)
      : this.renderPreviewStep(adminId);
  }

  public selectSession(adminId: number, sessionId: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId, sessionId);
    }
    state.selectedSessionId = sessionId;
    this.states.set(adminId, state);
    return state.recipientJid
      ? this.renderPreviewStep(adminId)
      : this.start(adminId, sessionId);
  }

  public promptReupload(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    state.step = 'AWAITING_VIDEO';
    this.states.set(adminId, state);
    return this.handleRecipientInput(
      adminId,
      state.recipientDisplay || state.recipientJid
    );
  }

  /**
   * Starts an instant native video or voice call offer without requiring any uploaded video file.
   */
  public async startInstantCallRing(
    adminId: number,
    callKind: 'video' | 'voice'
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.selectedSessionId || !state.recipientJid) {
      return this.start(adminId);
    }
    state.callKind = callKind;
    if (!state.videoFilePath || !fs.existsSync(state.videoFilePath)) {
      state.protocolMode =
        state.protocolMode === 'SCHEDULED_AND_CALL_LOG_PROTOCOL'
          ? 'SCHEDULED_AND_CALL_LOG_PROTOCOL'
          : 'NATIVE_CALL_OFFER_RING';
    }
    state.step = 'READY_TO_CALL';
    this.states.set(adminId, state);
    return this.confirmAndExecute(adminId);
  }

  /**
   * Step 4 of 4: Execute the call and stream via NativeVideoCallEngine.
   */
  public async confirmAndExecute(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.selectedSessionId || !state.recipientJid) {
      return this.start(adminId);
    }

    try {
      const driver = this.sessionManager.getDriver(
        state.selectedSessionId,
        adminId
      );
      const stream = await this.videoCallBridge.startVideoCallStream({
        sessionId: state.selectedSessionId,
        driver,
        recipientJid: state.recipientJid,
        recipientMasked: state.recipientDisplay || state.recipientJid,
        videoFilePath: state.videoFilePath,
        videoFileName: state.videoFileName,
        mimeType: state.mimeType || 'video/mp4',
        callKind: state.callKind,
        protocolMode: state.protocolMode,
        wavesCount: state.wavesCount,
        loopVideo: state.loopVideo,
        maxDurationSeconds: state.maxDurationSeconds,
        actorTelegramId: adminId,
      });

      state.activeCallId = stream.callId;
      state.step = 'STREAMING';
      this.states.set(adminId, state);

      return {
        text: [
          '✅ *تم بدء المكالمة المرئية / الصوتية بنجاح (الخطوة 4 من 4)*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          `• *معرف المكالمة:* \`${stream.callId}\``,
          `• *معرف الإرسال / العقدة:* \`${stream.messageId || stream.callId}\``,
          `• *الجلسة:* \`${stream.sessionId}\``,
          `• *المستلم:* \`${stream.recipientMasked}\``,
          `• *نوع المكالمة:* \`${stream.callKind === 'video' ? 'فيديو 📹' : 'صوتية 🔊'}\``,
          `• *وضع البروتوكول:* ${PROTOCOL_MODE_LABELS[stream.protocolMode]}`,
          `• *عدد موجات الرنين:* \`${stream.wavesCount}\``,
          `• *الملف:* \`${stream.videoFileName}\``,
          `• *الحالة:* 🟢 جاري الرنين والبث (\`${stream.status}\`)`,
          '',
          stream.detailsArabic,
        ].join('\n'),
        keyboard: [
          [
            {
              text: '🛑 إيقاف وإنهاء المكالمة الآن',
              callbackData: 'wf_vcall:stop',
            },
          ],
          [
            {
              text: '🔁 إعادة إطلاق الرنين لنفس الرقم',
              callbackData: 'wf_vcall:confirm_execute',
            },
          ],
          buildAppNavigationRow({
            backCallback: 'menu:video_call',
            refreshCallback: 'menu:video_call',
          }),
        ],
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: [
          '❌ *تعذر بدء المكالمة*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          safeErr.userMessage,
        ].join('\n'),
        keyboard: [buildBackCancelRow('menu:main')],
      };
    }
  }

  public async stopActiveCall(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    const callId =
      state?.activeCallId ||
      (state?.selectedSessionId
        ? this.videoCallBridge.getActiveStreamForSession(state.selectedSessionId)
            ?.callId
        : undefined);

    if (!callId) {
      return {
        text: 'ℹ️ *تم إنهاء المكالمة المرئية* أو أنها منتهية بالفعل.',
        keyboard: [
          [{ text: '📹 بدء مكالمة جديدة', callbackData: 'menu:video_call' }],
          buildBackCancelRow('menu:main'),
        ],
      };
    }

    const stopped = await this.videoCallBridge.stopVideoCallStream(
      callId,
      adminId,
      false
    );

    return {
      text: [
        '🛑 *تم إنهاء المكالمة المرئية وإيقاف البث بنجاح*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *معرف المكالمة:* \`${stopped?.callId || callId}\``,
        `• *المستلم:* \`${stopped?.recipientMasked || state?.recipientDisplay || '—'}\``,
        `• *موجات الرنين المنفذة:* \`${stopped?.wavesCompleted ?? 1}/${stopped?.wavesCount ?? 1}\``,
        `• *الحالة النهائية:* \`${stopped?.status || 'STOPPED'}\``,
      ].join('\n'),
      keyboard: [
        [
          {
            text: '🔁 إعادة الرنين لنفس الرقم',
            callbackData: 'wf_vcall:confirm_execute',
          },
          {
            text: '📹 مكالمة جديدة',
            callbackData: 'menu:video_call',
          },
        ],
        buildAppNavigationRow({
          backCallback: 'menu:main',
          refreshCallback: 'menu:video_call',
        }),
      ],
    };
  }
}
