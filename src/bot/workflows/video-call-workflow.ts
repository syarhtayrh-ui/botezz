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
  | 'AWAITING_VIDEO'
  | 'AWAITING_RECIPIENT'
  | 'READY_TO_CALL'
  | 'STREAMING_ACTIVE'
  | 'STREAMING';

export interface VideoCallWorkflowState {
  step: VideoCallStep;
  selectedSessionId?: string;
  recipientJid?: string;
  recipientDigits?: string;
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

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} Bytes`;
}

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
    if (existing?.activeCallId) {
      void this.videoCallBridge.stopVideoCallStream(
        existing.activeCallId,
        adminId,
        { autoCompleted: false, deleteFile: true }
      );
    } else if (existing?.videoFilePath && fs.existsSync(existing.videoFilePath)) {
      try {
        fs.unlinkSync(existing.videoFilePath);
      } catch {
        // Ignore cleanup error
      }
    }
    this.states.delete(adminId);
  }

  /**
   * Step 1 of 2: Prompt user to upload the video file first (`step = 'AWAITING_VIDEO'`).
   */
  public start(
    adminId: number,
    preselectedSessionId?: string,
    prefilledPhoneRaw?: string
  ): BotViewResponse {
    const connected = this.sessionManager.listConnectedSessions(adminId);

    if (connected.length === 0) {
      this.cancel(adminId);
      return {
        text: [
          '📹 *بدء مكالمة فيديو مزيفة (بث الفيديو للطرف الآخر)*',
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

    let recipientJid: string | undefined;
    let recipientDigits: string | undefined;
    let recipientDisplay: string | undefined;

    if (prefilledPhoneRaw && prefilledPhoneRaw.trim()) {
      try {
        const normalized = normalizePhoneNumber(prefilledPhoneRaw.trim());
        recipientJid = normalized.jid;
        recipientDigits = normalized.digits;
        recipientDisplay = normalized.e164;
      } catch {
        // Ignore invalid prefilled phone; user will be prompted in Step 2
      }
    }

    this.states.set(adminId, {
      step: 'AWAITING_VIDEO',
      selectedSessionId: defaultSession.id,
      recipientJid,
      recipientDigits,
      recipientDisplay,
      callKind: 'video',
      protocolMode: 'HYBRID_CALL_OFFER_AND_PTV',
      wavesCount: 1,
      loopVideo: true,
      maxDurationSeconds: 60,
    });

    const lines = [
      '📹 *بدء مكالمة فيديو مزيفة (بث الفيديو للطرف الآخر)*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      `• *الجلسة النشطة:* ${defaultSession.label} (\`${defaultSession.id}\`)`,
      ...(recipientDisplay
        ? [`• *المستلم المحدد مسبقاً:* \`${recipientDisplay}\``]
        : []),
      '',
      'الخطوة 1 من 2: *الرجاء إرسال أو رفع ملف الفيديو* (`.mp4`, `.mov`, `.webm`, `.mkv`) الذي تريد أن يظهر عند الطرف الآخر كبث كاميرا في المكالمة:',
    ];

    return {
      text: lines.join('\n'),
      keyboard: [
        [
          {
            text: '🎬 استخدام فيديو تجريبي جاهز (sample_call.mp4)',
            callbackData: 'wf_vcall:sample_video',
          },
        ],
        buildBackCancelRow('menu:main'),
      ],
    };
  }

  /**
   * Renders Step 2 of 2 (`AWAITING_RECIPIENT`) after a video file has been uploaded/staged.
   */
  public renderAwaitingRecipientStep(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.videoFilePath) {
      return this.start(adminId);
    }

    const connected = this.sessionManager.listConnectedSessions(adminId);
    const sizeFormatted = formatFileSize(state.sizeBytes || 0);

    const rows: InlineKeyboardRows = [];

    if (connected.length > 1) {
      const sessionBtns: InlineButtonSpec[] = connected.slice(0, 3).map((s) => ({
        text: `${s.id === state.selectedSessionId ? '🟢' : '⚪'} ${s.label.slice(0, 14)}`,
        callbackData: `wf_vcall:select_sess:${s.id}`,
      }));
      rows.push(sessionBtns);
    }

    rows.push([
      {
        text: `🔁 تكرار الفيديو: ${state.loopVideo ? 'مفعل ✅' : 'معطل ❌'}`,
        callbackData: 'wf_vcall:toggle_loop',
      },
      {
        text: `⏱️ المدة: ${state.maxDurationSeconds} ثانية`,
        callbackData: 'wf_vcall:cycle_duration',
      },
    ]);

    rows.push([
      {
        text: `🔔 موجات الرنين: ${state.wavesCount}`,
        callbackData: 'wf_vcall:cycle_waves',
      },
      {
        text: '🎬 تغيير ملف الفيديو',
        callbackData: 'wf_vcall:reupload',
      },
    ]);

    rows.push(buildBackCancelRow('menu:main'));

    return {
      text: [
        `✅ *تم استلام وتجهيز ملف الفيديو للبث بنجاح:* \`${state.videoFileName}\` (\`${sizeFormatted}\`)`,
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *الجلسة المحددة:* \`${state.selectedSessionId}\``,
        `• *تكرار البث (Loop):* ${state.loopVideo ? 'مفعل ✅' : 'معطل ❌'}`,
        `• *المدة القصوى للمكالمة:* \`${state.maxDurationSeconds} ثانية\``,
        `• *عدد موجات الرنين:* \`${state.wavesCount}\` موجة`,
        '',
        'الخطوة 2 من 2: *الرجاء إرسال الرقم المستهدف الآن* مع رمز الدولة الدولي (مثال: `+966501234567`) ليبدأ الاتصال وبث الفيديو فوراً:',
      ].join('\n'),
      keyboard: rows,
    };
  }

  /**
   * Step 2 of 2: Handle uploaded video file -> transitions to `AWAITING_RECIPIENT`
   * (or starts call immediately if recipient was pre-supplied via `/videocall <phone>`).
   */
  public async handleVideoUpload(
    adminId: number,
    upload: {
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      contentBuffer: Buffer;
    }
  ): Promise<BotViewResponse> {
    let state = this.states.get(adminId);
    if (!state || !state.selectedSessionId) {
      this.start(adminId);
      state = this.states.get(adminId);
      if (!state) {
        return this.start(adminId);
      }
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

    // Clean up previous video file if different
    if (
      state.videoFilePath &&
      state.videoFilePath !== filePath &&
      fs.existsSync(state.videoFilePath)
    ) {
      try {
        fs.unlinkSync(state.videoFilePath);
      } catch {
        // Ignore unlink error
      }
    }

    state.videoFilePath = filePath;
    state.videoFileName = safeName;
    state.mimeType = upload.mimeType || 'video/mp4';
    state.sizeBytes = upload.sizeBytes;
    state.protocolMode = 'HYBRID_CALL_OFFER_AND_PTV';

    if (state.recipientJid) {
      state.step = 'READY_TO_CALL';
      this.states.set(adminId, state);
      return this.confirmAndExecute(adminId);
    }

    state.step = 'AWAITING_RECIPIENT';
    this.states.set(adminId, state);
    return this.renderAwaitingRecipientStep(adminId);
  }

  public async attachSampleVideo(adminId: number): Promise<BotViewResponse> {
    let state = this.states.get(adminId);
    if (!state || !state.selectedSessionId) {
      this.start(adminId);
      state = this.states.get(adminId);
      if (!state) {
        return this.start(adminId);
      }
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

    if (state.recipientJid) {
      state.step = 'READY_TO_CALL';
      this.states.set(adminId, state);
      return this.confirmAndExecute(adminId);
    }

    state.step = 'AWAITING_RECIPIENT';
    this.states.set(adminId, state);
    return this.renderAwaitingRecipientStep(adminId);
  }

  public async useSampleVideo(adminId: number): Promise<BotViewResponse> {
    return this.attachSampleVideo(adminId);
  }

  /**
   * Step 3: Validate recipient number and IMMEDIATELY launch the fake video call & PTV stream!
   */
  public async handleRecipientInput(
    adminId: number,
    rawPhoneText: string
  ): Promise<BotViewResponse> {
    let state = this.states.get(adminId);
    if (!state || !state.selectedSessionId) {
      this.start(adminId);
      state = this.states.get(adminId);
      if (!state) {
        return this.start(adminId);
      }
    }

    try {
      const normalized = normalizePhoneNumber(rawPhoneText);
      state.recipientJid = normalized.jid;
      state.recipientDigits = normalized.digits;
      state.recipientDisplay = normalized.e164;

      // If no video file was uploaded yet, ensure a valid sample video buffer is attached so the call starts immediately
      if (!state.videoFilePath || !fs.existsSync(state.videoFilePath)) {
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
      }

      state.step = 'READY_TO_CALL';
      this.states.set(adminId, state);

      return await this.confirmAndExecute(adminId);
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

  public async submitRecipientNumber(
    adminId: number,
    rawPhoneText: string
  ): Promise<BotViewResponse> {
    return this.handleRecipientInput(adminId, rawPhoneText);
  }

  public toggleLoop(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    state.loopVideo = !state.loopVideo;
    this.states.set(adminId, state);
    return state.videoFilePath
      ? this.renderAwaitingRecipientStep(adminId)
      : this.start(adminId, state.selectedSessionId);
  }

  public cycleDuration(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    const durations = [30, 60, 180, 300];
    const idx = durations.indexOf(state.maxDurationSeconds);
    state.maxDurationSeconds = durations[(idx + 1) % durations.length]!;
    this.states.set(adminId, state);
    return state.videoFilePath
      ? this.renderAwaitingRecipientStep(adminId)
      : this.start(adminId, state.selectedSessionId);
  }

  public cycleProtocolMode(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    const modes: NativeCallProtocolMode[] = [
      'HYBRID_CALL_OFFER_AND_PTV',
      'NATIVE_CALL_OFFER_RING',
      'SCHEDULED_AND_CALL_LOG_PROTOCOL',
    ];
    const idx = modes.indexOf(state.protocolMode);
    state.protocolMode = modes[(idx + 1) % modes.length]!;
    this.states.set(adminId, state);
    return state.videoFilePath
      ? this.renderAwaitingRecipientStep(adminId)
      : this.start(adminId, state.selectedSessionId);
  }

  public cycleWavesCount(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    const counts = [1, 3, 5, 10];
    const idx = counts.indexOf(state.wavesCount);
    state.wavesCount = counts[(idx + 1) % counts.length]!;
    this.states.set(adminId, state);
    return state.videoFilePath
      ? this.renderAwaitingRecipientStep(adminId)
      : this.start(adminId, state.selectedSessionId);
  }

  public selectSession(adminId: number, sessionId: string): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId, sessionId);
    }
    state.selectedSessionId = sessionId;
    this.states.set(adminId, state);
    return state.videoFilePath
      ? this.renderAwaitingRecipientStep(adminId)
      : this.start(adminId, sessionId);
  }

  /**
   * Button `👤 إرسال المكالمة لرقم آخر (بنفس الفيديو)` (`wf_vcall:change_recipient`):
   * Returns to `AWAITING_RECIPIENT` while preserving the uploaded `videoFilePath`.
   */
  public promptChangeRecipient(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state || !state.videoFilePath || !fs.existsSync(state.videoFilePath)) {
      return this.start(adminId);
    }
    state.recipientJid = undefined;
    state.recipientDigits = undefined;
    state.recipientDisplay = undefined;
    state.step = 'AWAITING_RECIPIENT';
    this.states.set(adminId, state);
    return this.renderAwaitingRecipientStep(adminId);
  }

  /**
   * Button `🎬 تغيير ملف الفيديو` (`wf_vcall:reupload`):
   * Returns to `AWAITING_VIDEO`.
   */
  public promptReupload(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    state.videoFilePath = undefined;
    state.videoFileName = undefined;
    state.step = 'AWAITING_VIDEO';
    this.states.set(adminId, state);
    return this.start(
      adminId,
      state.selectedSessionId,
      state.recipientDisplay
    );
  }

  /**
   * Button `🔁 إعادة رنين وبث الفيديو لنفس الرقم` (`wf_vcall:repeat_call`):
   * Repeats the native call offer and PTV stream using the same video and recipient.
   */
  public async repeatCall(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    return this.confirmAndExecute(adminId);
  }

  /**
   * Starts an instant native video or voice call offer without requiring a manual file upload.
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
   * Executes the native `<call><offer><video/></offer></call>` stanza and PTV video stream
   * via `UbuntuVideoCallBridge` and transitions state to `'STREAMING_ACTIVE'`.
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
      state.step = 'STREAMING_ACTIVE';
      this.states.set(adminId, state);

      return {
        text: [
          '✅ *تم بدء المكالمة المرئية وبث الفيديو بنجاح*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          `• *معرف المكالمة:* \`${stream.callId}\``,
          `• *معرف الإرسال / العقدة:* \`${stream.messageId || stream.callId}\``,
          `• *الجلسة:* \`${stream.sessionId}\``,
          `• *المستلم:* \`${stream.recipientMasked}\``,
          `• *نوع المكالمة:* \`${stream.callKind === 'video' ? 'فيديو 📹' : 'صوتية 🔊'}\``,
          `• *وضع البروتوكول:* ${PROTOCOL_MODE_LABELS[stream.protocolMode]}`,
          `• *عدد موجات الرنين:* \`${stream.wavesCount}\``,
          `• *ملف الفيديو:* \`${stream.videoFileName}\``,
          `• *الحالة:* 🟢 جاري الرنين وبث الفيديو (\`STREAMING_ACTIVE\`)`,
          '',
          stream.detailsArabic,
        ].join('\n'),
        keyboard: [
          [
            {
              text: '🔁 إعادة رنين وبث الفيديو لنفس الرقم',
              callbackData: 'wf_vcall:repeat_call',
            },
          ],
          [
            {
              text: '🛑 إنهاء المكالمة وإيقاف البث',
              callbackData: 'wf_vcall:stop',
            },
          ],
          [
            {
              text: '👤 إرسال المكالمة لرقم آخر (بنفس الفيديو)',
              callbackData: 'wf_vcall:change_recipient',
            },
          ],
          [
            {
              text: '🎬 تغيير ملف الفيديو',
              callbackData: 'wf_vcall:reupload',
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
          [
            {
              text: '👤 إرسال المكالمة لرقم آخر (بنفس الفيديو)',
              callbackData: 'wf_vcall:change_recipient',
            },
          ],
          [{ text: '📹 بدء مكالمة جديدة', callbackData: 'menu:video_call' }],
          buildBackCancelRow('menu:main'),
        ],
      };
    }

    // Do NOT delete the uploaded video file on stop (`deleteFile: false`) so repeat_call and change_recipient work
    const stopped = await this.videoCallBridge.stopVideoCallStream(
      callId,
      adminId,
      { autoCompleted: false, deleteFile: false }
    );

    return {
      text: [
        '🛑 *تم إنهاء المكالمة المرئية وإيقاف البث بنجاح*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *معرف المكالمة:* \`${stopped?.callId || callId}\``,
        `• *المستلم:* \`${stopped?.recipientMasked || state?.recipientDisplay || '—'}\``,
        `• *ملف الفيديو المحفوظ:* \`${state?.videoFileName || stopped?.videoFileName || '—'}\``,
        `• *موجات الرنين المنفذة:* \`${stopped?.wavesCompleted ?? 1}/${stopped?.wavesCount ?? 1}\``,
        `• *الحالة النهائية:* \`${stopped?.status || 'STOPPED'}\``,
      ].join('\n'),
      keyboard: [
        [
          {
            text: '🔁 إعادة رنين وبث الفيديو لنفس الرقم',
            callbackData: 'wf_vcall:repeat_call',
          },
        ],
        [
          {
            text: '👤 إرسال المكالمة لرقم آخر (بنفس الفيديو)',
            callbackData: 'wf_vcall:change_recipient',
          },
        ],
        [
          {
            text: '🎬 تغيير ملف الفيديو',
            callbackData: 'wf_vcall:reupload',
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
