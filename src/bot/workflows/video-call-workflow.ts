import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../whatsapp/session-manager';
import {
  UbuntuVideoCallBridge,
  NativeCallProtocolMode,
  RealCallState,
} from '../../whatsapp/video-call-bridge';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { normalizePhoneNumber } from '../../security/validation';
import { createMinimalMp4Buffer } from '../../function-lab/media-sticker-toolkit';
import { generatePlayableVoipMp4File } from '../../whatsapp/voip-media-pipeline';
import {
  InlineButtonSpec,
  InlineKeyboardRows,
  buildBackCancelRow,
  buildAppNavigationRow,
} from '../keyboards/main-menu';
import {
  renderBreadcrumb,
  renderStepProgressBar,
  recordRecentRecipient,
  buildRecentRecipientsRows,
} from '../keyboards/ui-theme';
import {
  BotViewResponse,
  TelegramMediaAttachment,
} from './pairing-workflow';
import { toSafeArabicError, ValidationError } from '../../utils/errors';
import { escapeMarkdown } from '../../utils/markdown';

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
  recordCall: boolean;
  maxDurationSeconds: number;
  activeCallId?: string;
  callState?: RealCallState;
}

const CALL_STATE_ARABIC_LABELS: Record<RealCallState, string> = {
  INITIATING: '🟡 جاري تهيئة اتصال VoIP (`INITIATING`)',
  RINGING: '🔔 جاري الرنين الفعلي لدى الطرف الآخر (`RINGING`)',
  CONNECTING: '🔄 جاري التفاوض وتأسيس قناة الاتصال (`CONNECTING`)',
  CONNECTED: '🟢 تم الرد وتأسيس المكالمة (`CONNECTED`)',
  MEDIA_NEGOTIATING: '🎛️ جاري التفاوض على قنوات RTP/SRTP (`MEDIA_NEGOTIATING`)',
  MEDIA_STARTED: '🟢 جاري بث الصوت والفيديو عبر VoIP (`MEDIA_STARTED`)',
  MEDIA_STOPPED: '⏸️ تم إيقاف تدفق الوسائط (`MEDIA_STOPPED`)',
  ENDED: '🛑 انتهت المكالمة (`ENDED`)',
  REJECTED: '🚫 تم رفض المكالمة من الطرف الآخر (`REJECTED`)',
  TIMEOUT: '⏱️ انتهت مهلة الرنين دون رد (`TIMEOUT`)',
  FAILED: '❌ تعذر إتمام المكالمة (`FAILED`)',
  MEDIA_FAILED: '❌ فشل بدء تدفق الصوت والفيديو عبر RTP/SRTP (`MEDIA_FAILED`)',
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

  private releaseOwnedTempVideoFile(filePath?: string): void {
    if (!filePath) return;
    try {
      const resolvedPath = path.resolve(filePath);
      const resolvedTempDir = path.resolve(this.tempUploadDir);
      const isInsideTempDir =
        resolvedPath.startsWith(resolvedTempDir + path.sep) ||
        path.dirname(resolvedPath) === resolvedTempDir;
      if (!isInsideTempDir) return;

      const baseName = path.basename(resolvedPath);
      if (baseName.startsWith('synthetic_call_')) return;

      const activeStreams = this.videoCallBridge.listActiveStreams();
      const inUseByActiveCall = activeStreams.some(
        (s) => s.videoFilePath && path.resolve(s.videoFilePath) === resolvedPath
      );
      if (inUseByActiveCall) return;

      if (fs.existsSync(resolvedPath)) {
        fs.unlinkSync(resolvedPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  public cancel(adminId: number): void {
    const existing = this.states.get(adminId);
    if (existing?.activeCallId) {
      void this.videoCallBridge.stopVideoCallStream(
        existing.activeCallId,
        adminId,
        { autoCompleted: false, deleteFile: true }
      );
    } else if (existing?.videoFilePath) {
      this.releaseOwnedTempVideoFile(existing.videoFilePath);
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
    const existing = this.states.get(adminId);
    if (existing?.videoFilePath) {
      this.releaseOwnedTempVideoFile(existing.videoFilePath);
    }

    const connected = this.sessionManager.listConnectedSessions(adminId);

    if (connected.length === 0) {
      this.cancel(adminId);
      return {
        text: [
          renderBreadcrumb(['الرئيسية', 'مكالمة فيديو VoIP']),
          '📹 *بدء مكالمة فيديو VoIP حقيقية (بث الفيديو والصوت داخل المكالمة)*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          '⚠️ *لا توجد جلسات متصلة حالياً*',
          '',
          'يرجى ربط جلسة واتساب واحدة على الأقل وتوصيلها قبل بدء المكالمة.',
        ].join('\n'),
        keyboard: [
          [{ text: '📲 ربط جلسة جديدة', callbackData: 'menu:link_account' }],
          buildBackCancelRow('menu:main'),
        ],
        route: 'menu:video_call',
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
      protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
      wavesCount: 1,
      loopVideo: true,
      recordCall: true,
      maxDurationSeconds: 60,
    });

    const lines = [
      renderBreadcrumb(['الرئيسية', 'مكالمة فيديو VoIP']),
      renderStepProgressBar(1, 2, 'رفع ملف الفيديو للبث'),
      '📹 *بدء مكالمة فيديو VoIP حقيقية (بث الفيديو والصوت داخل المكالمة)*',
      '━━━━━━━━━━━━━━━━━━━━━━',
      `• *الجلسة النشطة:* ${escapeMarkdown(defaultSession.label)} (\`${defaultSession.id}\`)`,
      `• *محرك الاتصال:* \`@hiroosy/baileys-lite/voip (RTP/SRTP)\``,
      ...(recipientDisplay
        ? [`• *المستلم المحدد مسبقاً:* \`${recipientDisplay}\``]
        : []),
      '',
      'الخطوة 1 من 2: *الرجاء إرسال أو رفع ملف الفيديو* (`.mp4`, `.mov`, `.webm`, `.mkv`) ليتم فحصه بـ `ffprobe` وبثه مباشرة داخل مكالمة الفيديو:',
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
      route: 'menu:video_call',
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

    const recentRows = buildRecentRecipientsRows(adminId, 'wf_vcall:recent:');
    if (recentRows.length > 0) {
      rows.push(...recentRows);
    }

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
        text: `🔴 تسجيل المكالمة (الطرفين): ${state.recordCall !== false ? 'مفعل ✅' : 'معطل ❌'}`,
        callbackData: 'wf_vcall:toggle_record',
      },
    ]);

    rows.push([
      {
        text: '🎬 تغيير ملف الفيديو',
        callbackData: 'wf_vcall:reupload',
      },
    ]);

    rows.push(buildBackCancelRow('menu:main'));

    return {
      text: [
        renderBreadcrumb(['الرئيسية', 'مكالمة فيديو VoIP']),
        renderStepProgressBar(2, 2, 'إدخال رقم المستلم وبدء الاتصال'),
        `✅ *تم استلام وتجهيز ملف الفيديو للبث بنجاح:* \`${state.videoFileName || 'video.mp4'}\` (\`${sizeFormatted}\`)`,
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *الجلسة المحددة:* \`${state.selectedSessionId}\``,
        `• *طبقة الاتصال:* \`VoIP H.264 + MLow RTP/SRTP\``,
        `• *تكرار البث (Loop):* ${state.loopVideo ? 'مفعل ✅' : 'معطل ❌'}`,
        `• *تسجيل المكالمة ثنائي الاتجاه:* ${state.recordCall !== false ? 'مفعل ✅ (كاميرا وصوت المستلم + البوت)' : 'معطل ❌'}`,
        `• *المدة القصوى للمكالمة:* \`${state.maxDurationSeconds} ثانية\``,
        '',
        'الخطوة 2 من 2: *الرجاء إرسال الرقم المستهدف الآن* مع رمز الدولة الدولي (مثال: `+966501234567`) ليبدأ الاتصال وبث الفيديو فوراً:',
      ].join('\n'),
      keyboard: rows,
      route: 'menu:video_call',
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

    if (state.videoFilePath && state.videoFilePath !== filePath) {
      this.releaseOwnedTempVideoFile(state.videoFilePath);
    }

    state.videoFilePath = filePath;
    state.videoFileName = safeName;
    state.mimeType = upload.mimeType || 'video/mp4';
    state.sizeBytes = upload.sizeBytes;
    state.protocolMode = 'HIROOSY_VOIP_VIDEO_CALL';

    if (state.recipientJid) {
      state.step = 'READY_TO_CALL';
      this.states.set(adminId, state);
      return this.confirmAndExecute(adminId);
    }

    state.step = 'AWAITING_RECIPIENT';
    this.states.set(adminId, state);
    return this.renderAwaitingRecipientStep(adminId);
  }

  private async createSampleVideoFile(
    adminId: number
  ): Promise<{ filePath: string; sizeBytes: number }> {
    const filePath = path.join(
      this.tempUploadDir,
      `sample_call_${adminId}_${Date.now()}.mp4`
    );
    try {
      await generatePlayableVoipMp4File(filePath, {
        width: 640,
        height: 360,
        frameRate: 15,
        durationSeconds: 10,
        includeAudio: true,
      });
    } catch {
      fs.writeFileSync(filePath, createMinimalMp4Buffer());
    }
    const sizeBytes = fs.existsSync(filePath)
      ? fs.statSync(filePath).size
      : 0;
    return { filePath, sizeBytes };
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

    const { filePath, sizeBytes } = await this.createSampleVideoFile(adminId);

    if (state.videoFilePath && state.videoFilePath !== filePath) {
      this.releaseOwnedTempVideoFile(state.videoFilePath);
    }

    state.videoFilePath = filePath;
    state.videoFileName = 'sample_call.mp4';
    state.mimeType = 'video/mp4';
    state.sizeBytes = sizeBytes;
    state.protocolMode = 'HIROOSY_VOIP_VIDEO_CALL';

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
   * Step 3: Validate recipient number and launch the real VoIP video call.
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
      recordRecentRecipient(adminId, normalized.e164);

      if (!state.videoFilePath || !fs.existsSync(state.videoFilePath)) {
        const { filePath, sizeBytes } = await this.createSampleVideoFile(adminId);
        state.videoFilePath = filePath;
        state.videoFileName = 'sample_call.mp4';
        state.mimeType = 'video/mp4';
        state.sizeBytes = sizeBytes;
        state.protocolMode = 'HIROOSY_VOIP_VIDEO_CALL';
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
        keyboard: [
          ...buildRecentRecipientsRows(adminId, 'wf_vcall:recent:'),
          buildBackCancelRow('menu:main'),
        ],
        route: 'menu:video_call',
        toastText: safeErr.userMessage,
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

  public toggleRecordCall(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    state.recordCall = state.recordCall === false ? true : false;
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
    state.protocolMode = 'HIROOSY_VOIP_VIDEO_CALL';
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
    state.wavesCount = 1;
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

  public promptReupload(adminId: number): BotViewResponse {
    const state = this.states.get(adminId);
    if (!state) {
      return this.start(adminId);
    }
    if (state.videoFilePath) {
      this.releaseOwnedTempVideoFile(state.videoFilePath);
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

  public async repeatCall(adminId: number): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.recipientJid) {
      return this.start(adminId);
    }
    return this.confirmAndExecute(adminId);
  }

  public async startInstantCallRing(
    adminId: number,
    callKind: 'video' | 'voice'
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    if (!state || !state.selectedSessionId || !state.recipientJid) {
      return this.start(adminId);
    }
    state.callKind = callKind;
    state.protocolMode = 'HIROOSY_VOIP_VIDEO_CALL';
    state.step = 'READY_TO_CALL';
    this.states.set(adminId, state);
    return this.confirmAndExecute(adminId);
  }

  public renderStreamStatusView(
    stream: ReturnType<UbuntuVideoCallBridge['getCallStatus']> & object
  ): BotViewResponse {
    const stateLabel =
      CALL_STATE_ARABIC_LABELS[stream.callState] || stream.callState;

    const isMediaActivelyStreaming =
      stream.callState === 'MEDIA_STARTED' && stream.mediaStarted;
    const isTerminal =
      stream.callState === 'ENDED' ||
      stream.callState === 'REJECTED' ||
      stream.callState === 'TIMEOUT' ||
      stream.callState === 'FAILED' ||
      stream.callState === 'MEDIA_STOPPED';

    const executionMode =
      (stream as { executionMode?: 'REAL_VOIP' | 'MOCK_SIMULATION' })
        .executionMode || 'REAL_VOIP';
    const isMockMode = executionMode === 'MOCK_SIMULATION';

    const headerLine = isTerminal
      ? `ℹ️ *حالة المكالمة المرئية (${stateLabel})*`
      : isMediaActivelyStreaming
        ? isMockMode
          ? '🧪 *تم بدء المكالمة المرئية وبث الفيديو بنجاح (MOCK_SIMULATION)*'
          : '✅ *تم بدء المكالمة المرئية وبث الفيديو بنجاح*'
        : isMockMode
          ? '🧪 *تم إنشاء جلسة محاكاة مكالمة الفيديو (MOCK_SIMULATION)*'
          : '📞 *تم إرسال طلب مكالمة الفيديو وجاري الرنين وتأسيس قناة الوسائط*';

    const recordingStatusLabel =
      stream.recordingStatus === 'RECORDING'
        ? '🔴 قيد التسجيل (`RECORDING`)'
        : stream.recordingStatus === 'FINALIZING'
          ? '⏳ جاري دمج وحفظ ملف التسجيل (`FINALIZING`)'
          : stream.recordingStatus === 'READY'
            ? `✅ جاهز (\`${stream.recordedVideoFileName || 'recording.mp4'}\`)`
            : stream.recordingStatus === 'NO_REMOTE_CAMERA'
              ? 'ℹ️ انتهت المكالمة، ولم يتم إرسال فيديو تسجيل لأن الطرف المستقبل لم يفتح الكاميرا أثناء المكالمة.'
              : stream.recordingStatus === 'DISABLED'
                ? '⚪ معطل (`DISABLED`)'
                : '⚠️ تعذر الحفظ (`FAILED`)';

    const keyboardRows: InlineKeyboardRows = [
      [
        {
          text: '🔁 إعادة الاتصال وبث الفيديو لنفس الرقم',
          callbackData: 'wf_vcall:repeat_call',
        },
      ],
      [
        {
          text: '🛑 إنهاء المكالمة وإيقاف البث',
          callbackData: 'wf_vcall:stop',
        },
      ],
    ];

    if (stream.recordingStatus === 'READY' && stream.recordedVideoPath) {
      keyboardRows.push([
        {
          text: '📥 إرسال ملف تسجيل المكالمة (.mp4)',
          callbackData: `wf_vcall:download_recording:${stream.callId}`,
        },
      ]);
    }

    keyboardRows.push(
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
      })
    );

    return {
      text: [
        headerLine,
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *معرف المكالمة:* \`${stream.callId}\``,
        `• *معرف عقدة VoIP:* \`${stream.voipCallId || stream.messageId || stream.callId}\``,
        `• *وضع التنفيذ:* ${isMockMode ? '🧪 محاكاة اختبارية (`MOCK_SIMULATION`)' : '🟢 اتصال VoIP حقيقي (`REAL_VOIP`)'}`,
        `• *الجلسة:* \`${stream.sessionId}\``,
        `• *المستلم:* \`${stream.recipientMasked}\``,
        `• *نوع المكالمة:* \`${stream.callKind === 'video' ? 'فيديو 📹' : 'صوتية 🔊'}\``,
        `• *طبقة الوسائط:* \`@hiroosy/baileys-lite/voip (${stream.resolutionPreset})\``,
        `• *ملف الفيديو:* \`${stream.videoFileName}\``,
        `• *الحالة الحالية:* ${stateLabel}`,
        `• *حالة البث الفعلي (RTP/SRTP):* ${isMediaActivelyStreaming ? '🟢 نشط ومؤكد (`MEDIA_STARTED`)' : isTerminal ? '⏹️ متوقف / منتهي' : '⏳ بانتظار رد المستلم وبدء تدفق إطارات الصوت والفيديو'}`,
        `• *تسجيل المكالمة (Two-Way):* ${recordingStatusLabel}`,
        `• *إطارات كاميرا المستلم الملتقطة:* \`${stream.inboundVideoFramesRecorded ?? 0} إطار (${stream.inboundVideoPacketsReceived ?? 0} حزمة RTP)\``,
        `• *حزم صوت المستلم الملتقطة:* \`${stream.inboundAudioPacketsReceived ?? 0} حزمة\``,
        '',
        stream.detailsArabic,
      ].join('\n'),
      keyboard: keyboardRows,
    };
  }

  public renderLiveCallStatusView(adminId: number): BotViewResponse | undefined {
    const state = this.states.get(adminId);
    if (!state || state.step !== 'STREAMING_ACTIVE' || !state.activeCallId) {
      return undefined;
    }
    const stream = this.videoCallBridge.getCallStatus(state.activeCallId);
    if (!stream) {
      return undefined;
    }
    state.callState = stream.callState;
    this.states.set(adminId, state);
    return this.renderStreamStatusView(stream);
  }

  public buildRecordingAttachment(
    stream: NonNullable<ReturnType<UbuntuVideoCallBridge['getCallStatus']>>
  ): TelegramMediaAttachment | undefined {
    if (
      stream.recordingStatus !== 'READY' ||
      !stream.recordedVideoPath ||
      !fs.existsSync(stream.recordedVideoPath)
    ) {
      return undefined;
    }
    try {
      const stat = fs.statSync(stream.recordedVideoPath);
      const fileName =
        stream.recordedVideoFileName ||
        path.basename(stream.recordedVideoPath);
      const sizeStr = formatFileSize(
        stream.recordedVideoSizeBytes || stat.size
      );
      return {
        kind: 'video',
        filePath: stream.recordedVideoPath,
        fileName,
        mimeType: 'video/mp4',
        caption: [
          '🎬 *تسجيل كاميرا وصوت المستلم (VoIP Call Recording)*',
          '━━━━━━━━━━━━━━━━━━━━━━',
          `• *معرف المكالمة:* \`${stream.callId}\``,
          `• *المستلم:* \`${stream.recipientMasked}\``,
          `• *مدة التسجيل:* \`${stream.recordedDurationSeconds ?? 1} ثانية\``,
          `• *حجم الملف:* \`${sizeStr}\``,
          `• *كاميرا المستلم:* ${stream.remoteCameraCaptured ? `🟢 تم التقاطها (${stream.inboundVideoFramesRecorded} إطار)` : '⚪ غير مفعلة'}`,
          `• *حزم صوت المستلم:* \`${stream.inboundAudioPacketsReceived} حزمة\``,
        ].join('\n'),
      };
    } catch {
      return undefined;
    }
  }

  public downloadLastRecording(
    adminId: number,
    explicitCallId?: string
  ): BotViewResponse {
    const state = this.states.get(adminId);
    const callId = explicitCallId || state?.activeCallId;
    const stream = callId
      ? this.videoCallBridge.getCallStatus(callId)
      : this.videoCallBridge.listCompletedStreams()[0];

    if (stream?.recordingStatus === 'NO_REMOTE_CAMERA') {
      return {
        text: 'ℹ️ انتهت المكالمة، ولم يتم إرسال فيديو تسجيل لأن الطرف المستقبل لم يفتح الكاميرا أثناء المكالمة.',
        keyboard: [buildBackCancelRow('menu:video_call')],
      };
    }

    if (!stream || stream.recordingStatus !== 'READY' || !stream.recordedVideoPath) {
      return {
        text: '⚠️ *لا يوجد ملف تسجيل متاح لهذه المكالمة حالياً.*',
        keyboard: [buildBackCancelRow('menu:video_call')],
      };
    }

    const attachment = this.buildRecordingAttachment(stream);
    return {
      text: [
        '📥 *تم تجهيز وإرفاق ملف تسجيل المكالمة المرئية بنجاح*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *معرف المكالمة:* \`${stream.callId}\``,
        `• *اسم الملف:* \`${stream.recordedVideoFileName}\``,
        `• *إطارات كاميرا المستلم:* \`${stream.inboundVideoFramesRecorded}\``,
        `• *حزم صوت المستلم:* \`${stream.inboundAudioPacketsReceived}\``,
      ].join('\n'),
      keyboard: [buildBackCancelRow('menu:video_call')],
      mediaAttachments: attachment ? [attachment] : undefined,
    };
  }

  /**
   * Executes the real WhatsApp VoIP video call via `RealVideoCallService` (`UbuntuVideoCallBridge`).
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
        protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
        loopVideo: state.loopVideo,
        recordCall: state.recordCall !== false,
        maxDurationSeconds: state.maxDurationSeconds,
        actorTelegramId: adminId,
      });

      state.activeCallId = stream.callId;
      state.callState = stream.callState;
      state.step = 'STREAMING_ACTIVE';
      this.states.set(adminId, state);

      return this.renderStreamStatusView(stream);
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

    const stopped = await this.videoCallBridge.stopVideoCallStream(
      callId,
      adminId,
      { autoCompleted: false, deleteFile: false }
    );

    const mediaAttachments: TelegramMediaAttachment[] = [];
    if (stopped && !stopped.recordingDeliveredToTelegram) {
      const recordingAttachment = this.buildRecordingAttachment(stopped);
      if (recordingAttachment) {
        stopped.recordingDeliveredToTelegram = true;
        mediaAttachments.push(recordingAttachment);
      }
    }

    const keyboardRows: InlineKeyboardRows = [
      [
        {
          text: '🔁 إعادة الاتصال وبث الفيديو لنفس الرقم',
          callbackData: 'wf_vcall:repeat_call',
        },
      ],
    ];

    if (stopped?.recordingStatus === 'READY' && stopped.recordedVideoPath) {
      keyboardRows.push([
        {
          text: '📥 إعادة إرسال ملف تسجيل المكالمة (.mp4)',
          callbackData: `wf_vcall:download_recording:${stopped.callId}`,
        },
      ]);
    }

    keyboardRows.push(
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
      })
    );

    return {
      text: [
        '🛑 *تم إنهاء المكالمة المرئية وإيقاف البث بنجاح*',
        '━━━━━━━━━━━━━━━━━━━━━━',
        `• *معرف المكالمة:* \`${stopped?.callId || callId}\``,
        `• *المستلم:* \`${stopped?.recipientMasked || state?.recipientDisplay || '—'}\``,
        `• *ملف الفيديو المرسل:* \`${state?.videoFileName || stopped?.videoFileName || '—'}\``,
        `• *الحالة النهائية:* \`${stopped?.callState || stopped?.status || 'ENDED'}\``,
        ...(stopped?.recordingEnabled
          ? [
              `• *حالة تسجيل المكالمة:* \`${stopped.recordingStatus}\``,
              ...(stopped.recordingStatus === 'NO_REMOTE_CAMERA'
                ? [
                    'ℹ️ انتهت المكالمة، ولم يتم إرسال فيديو تسجيل لأن الطرف المستقبل لم يفتح الكاميرا أثناء المكالمة.',
                  ]
                : []),
              ...(stopped.recordedVideoFileName
                ? [`• *ملف تسجيل المكالمة:* \`${stopped.recordedVideoFileName}\``]
                : []),
              `• *إطارات كاميرا المستلم المسجلة:* \`${stopped.inboundVideoFramesRecorded ?? 0} إطار\``,
              `• *حزم صوت المستلم المسجلة:* \`${stopped.inboundAudioPacketsReceived ?? 0} حزمة\``,
            ]
          : []),
      ].join('\n'),
      keyboard: keyboardRows,
      ...(mediaAttachments.length > 0 ? { mediaAttachments } : {}),
    };
  }
}
