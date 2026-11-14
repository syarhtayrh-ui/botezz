import crypto from 'node:crypto';
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
import {
  generatePlayableVoipMp4File,
  validateAndInspectVideoMedia,
} from '../../whatsapp/voip-media-pipeline';
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

export interface RecentBroadcastVideoItem {
  videoId: string;
  fileName: string;
  filePath: string;
  fileSizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  lastUsedAtIso: string;
}

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
  private readonly inMemoryBroadcastVideosByOwner = new Map<
    number,
    RecentBroadcastVideoItem[]
  >();
  private settingsRepo?: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  };

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly videoCallBridge: UbuntuVideoCallBridge,
    private readonly auditRepo: AuditRepository,
    private readonly tempUploadDir = path.resolve(
      process.cwd(),
      'data',
      'temp_uploads'
    ),
    private readonly maxUploadSizeMb = 50,
    settingsRepo?: {
      get: (key: string) => string | undefined;
      set: (key: string, value: string) => void;
    }
  ) {
    fs.mkdirSync(this.tempUploadDir, { recursive: true });
    this.settingsRepo = settingsRepo;
  }

  public setSettingsRepository(settingsRepo?: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  }): void {
    this.settingsRepo = settingsRepo;
  }

  private getRecentBroadcastVideosDir(): string {
    const dir = path.join(this.tempUploadDir, 'recent_broadcast_videos');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private getRecentBroadcastVideosSettingKey(ownerTelegramId: number): string {
    return `recent_broadcast_videos_json:${ownerTelegramId || 0}`;
  }

  public getRecentBroadcastVideos(
    ownerTelegramId: number
  ): RecentBroadcastVideoItem[] {
    const ownerId = ownerTelegramId || 0;
    let parsed: RecentBroadcastVideoItem[] = [];
    const rawJson = this.settingsRepo?.get(
      this.getRecentBroadcastVideosSettingKey(ownerId)
    );
    if (rawJson) {
      try {
        const arr = JSON.parse(rawJson);
        if (Array.isArray(arr)) {
          parsed = arr as RecentBroadcastVideoItem[];
        }
      } catch {
        parsed = [];
      }
    }
    if (parsed.length === 0) {
      parsed = this.inMemoryBroadcastVideosByOwner.get(ownerId) ?? [];
    }
    const valid = parsed
      .filter(
        (item) =>
          item &&
          typeof item.filePath === 'string' &&
          item.filePath.length > 0 &&
          fs.existsSync(item.filePath)
      )
      .slice(0, 3);
    this.inMemoryBroadcastVideosByOwner.set(ownerId, valid);
    return valid;
  }

  private persistRecentBroadcastVideosList(
    ownerTelegramId: number,
    list: RecentBroadcastVideoItem[]
  ): RecentBroadcastVideoItem[] {
    const ownerId = ownerTelegramId || 0;
    const top3 = list.slice(0, 3);
    const evicted = list.slice(3);

    this.inMemoryBroadcastVideosByOwner.set(ownerId, top3);
    try {
      this.settingsRepo?.set(
        this.getRecentBroadcastVideosSettingKey(ownerId),
        JSON.stringify(top3)
      );
    } catch {
      // Ignore settings persistence error
    }

    const activePaths = new Set(top3.map((x) => path.resolve(x.filePath)));
    for (const stale of evicted) {
      if (
        stale?.filePath &&
        !activePaths.has(path.resolve(stale.filePath)) &&
        fs.existsSync(stale.filePath)
      ) {
        try {
          fs.unlinkSync(stale.filePath);
        } catch {
          // Ignore unlink error
        }
      }
    }

    // Also prune any orphaned files for this owner beyond the 3 active ones
    try {
      const bcastDir = this.getRecentBroadcastVideosDir();
      const prefix = `bcast_${ownerId}_`;
      const ownerFiles = fs
        .readdirSync(bcastDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.mp4'))
        .map((f) => path.join(bcastDir, f));
      for (const candidate of ownerFiles) {
        if (!activePaths.has(path.resolve(candidate))) {
          try {
            fs.unlinkSync(candidate);
          } catch {
            // Ignore unlink error
          }
        }
      }
    } catch {
      // Ignore directory prune error
    }

    return top3;
  }

  public async cacheBroadcastVideoForOwner(
    ownerTelegramId: number,
    sourceFilePath: string,
    originalFileName: string,
    fileSizeBytes: number
  ): Promise<RecentBroadcastVideoItem | undefined> {
    if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
      return undefined;
    }
    const ownerId = ownerTelegramId || 0;
    const bcastDir = this.getRecentBroadcastVideosDir();

    let durationSeconds = 10;
    let width = 640;
    let height = 360;
    let hasAudio = true;

    try {
      const inspection = await validateAndInspectVideoMedia(sourceFilePath, {
        allowSyntheticMinimalMp4: true,
      });
      durationSeconds = Math.max(
        1,
        Math.round(inspection.durationSeconds || 10)
      );
      width = inspection.width || 640;
      height = inspection.height || 360;
      hasAudio = Boolean(inspection.hasAudioStream);
    } catch {
      // Keep default metadata if synthetic buffer in unit tests
    }

    let contentHash = '';
    try {
      const buf = fs.readFileSync(sourceFilePath);
      contentHash = crypto
        .createHash('sha1')
        .update(originalFileName || '')
        .update(':')
        .update(buf)
        .digest('hex')
        .slice(0, 10);
    } catch {
      contentHash = `${Date.now().toString(36)}`;
    }

    const videoId = contentHash || crypto.randomUUID().slice(0, 8);
    const cachedFilePath = path.join(
      bcastDir,
      `bcast_${ownerId}_${videoId}.mp4`
    );

    try {
      if (path.resolve(sourceFilePath) !== path.resolve(cachedFilePath)) {
        fs.copyFileSync(sourceFilePath, cachedFilePath);
        try {
          fs.chmodSync(cachedFilePath, 0o600);
        } catch {
          // Ignore chmod error
        }
      }
    } catch {
      return undefined;
    }

    const statSize = fs.existsSync(cachedFilePath)
      ? fs.statSync(cachedFilePath).size
      : fileSizeBytes;

    const newItem: RecentBroadcastVideoItem = {
      videoId,
      fileName: originalFileName || path.basename(sourceFilePath),
      filePath: cachedFilePath,
      fileSizeBytes: statSize,
      durationSeconds,
      width,
      height,
      hasAudio,
      lastUsedAtIso: new Date().toISOString(),
    };

    const existing = this.getRecentBroadcastVideos(ownerId);
    const deduped = existing.filter(
      (it) =>
        it.videoId !== newItem.videoId &&
        !(
          it.fileName === newItem.fileName &&
          it.fileSizeBytes === newItem.fileSizeBytes
        )
    );

    this.persistRecentBroadcastVideosList(ownerId, [newItem, ...deduped]);
    return newItem;
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

      // Never delete cached recent broadcast videos
      const recentBcastDir = path.resolve(
        this.tempUploadDir,
        'recent_broadcast_videos'
      );
      if (
        resolvedPath.startsWith(recentBcastDir + path.sep) ||
        path.dirname(resolvedPath) === recentBcastDir
      ) {
        return;
      }

      const baseName = path.basename(resolvedPath);
      if (
        baseName.startsWith('synthetic_call_') ||
        baseName.startsWith('bcast_')
      ) {
        return;
      }

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
   * Step 1 of 2: Prompt user to upload the video file first (`step = 'AWAITING_VIDEO'`),
   * while displaying the latest 3 outbound broadcast videos for 1-tap reuse and the latest 3 recorded calls.
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
          [
            {
              text: '📼 استعراض وتحميل آخر 3 مكالمات مسجلة',
              callbackData: 'vcall:rec_history',
            },
          ],
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

    const recentBcastVideos = this.getRecentBroadcastVideos(adminId);
    const recentRecordings =
      this.videoCallBridge.getRecentRecordedCalls(adminId);

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
      '🎬 *آخر 3 فيديوهات استخدمتها لبث المكالمة:*',
      ...(recentBcastVideos.length > 0
        ? recentBcastVideos.map(
            (v, idx) =>
              `  ${idx + 1}. \`${v.fileName}\` (${v.width}x${v.height} • ${v.durationSeconds}s • ${formatFileSize(v.fileSizeBytes)})`
          )
        : ['  • _لا توجد فيديوهات بث محفوظة بعد_']),
      '',
      '📼 *آخر 3 فيديوهات مسجلة للمكالمات:*',
      ...(recentRecordings.length > 0
        ? recentRecordings.map(
            (r, idx) =>
              `  ${idx + 1}. المستلم: \`${r.recipientMasked}\` • المدة: \`${r.durationSeconds}s\` • الحجم: \`${formatFileSize(r.fileSizeBytes)}\` (${r.videoFramesRecorded} إطار)`
          )
        : ['  • _لا توجد مكالمات مسجلة محفوظة حتى الآن_']),
      '',
      'الخطوة 1 من 2: *الرجاء إرسال أو رفع ملف الفيديو* (`.mp4`, `.mov`, `.webm`, `.mkv`) أو اختيار أحد الفيديوهات المحفوظة بالأسفل:',
    ];

    const keyboard: InlineKeyboardRows = [];

    for (let idx = 0; idx < recentBcastVideos.length; idx++) {
      const v = recentBcastVideos[idx]!;
      const shortName =
        v.fileName.length > 20 ? `${v.fileName.slice(0, 17)}...` : v.fileName;
      keyboard.push([
        {
          text: `🎬 استخدام فيديو #${idx + 1}: ${shortName} (${v.durationSeconds}s • ${formatFileSize(v.fileSizeBytes)})`,
          callbackData: `vcall:reuse_bcast:${idx}`,
        },
      ]);
    }

    keyboard.push([
      {
        text: '🎬 استخدام فيديو تجريبي جاهز (sample_call.mp4)',
        callbackData: 'wf_vcall:sample_video',
      },
    ]);

    keyboard.push([
      {
        text: `📼 استعراض وتحميل آخر 3 مكالمات مسجلة (${recentRecordings.length}/3)`,
        callbackData: 'vcall:rec_history',
      },
    ]);

    keyboard.push(buildBackCancelRow('menu:main'));

    return {
      text: lines.join('\n'),
      keyboard,
      route: 'menu:video_call',
    };
  }

  /**
   * Renders the "Recent 3 Recorded Call Videos" Archive & Viewer (`vcall:rec_history`).
   */
  public renderRecordedCallsHistory(adminId: number): BotViewResponse {
    const recordings = this.videoCallBridge.getRecentRecordedCalls(adminId);
    const lines: string[] = [
      renderBreadcrumb(['الرئيسية', 'مكالمة فيديو VoIP', 'المكالمات المسجلة']),
      '📼 *آخر 3 فيديوهات مسجلة للمكالمات (Two-Way Call Recordings)*',
      '━━━━━━━━━━━━━━━━━━━━━━',
    ];

    const keyboard: InlineKeyboardRows = [];

    if (recordings.length === 0) {
      lines.push(
        'ℹ️ *لا توجد فيديوهات مكالمات مسجلة محفوظة حالياً.*',
        '',
        'عند إجراء مكالمة فيديو وقيام الطرف المستلم بفتح الكاميرا، يتم حفظ آخر 3 مكالمات مسجلة تلقائياً هنا لتتمكن من استعراضها وتحميلها في أي وقت.'
      );
    } else {
      for (let i = 0; i < recordings.length; i++) {
        const rec = recordings[i]!;
        lines.push(
          `*#${i + 1} — مكالمة \`${rec.callId}\`*`,
          `• *المستلم:* \`${rec.recipientMasked}\` (الجلسة: \`${rec.sessionId}\`)`,
          `• *المدة والحجم:* \`${rec.durationSeconds} ثانية\` • \`${formatFileSize(rec.fileSizeBytes)}\``,
          `• *الإطارات الملتقطة:* \`${rec.videoFramesRecorded} إطار فيديو\` • \`${rec.audioPacketsRecorded} حزمة صوت\``,
          `• *التاريخ:* \`${rec.recordedAtIso}\``,
          ''
        );
        keyboard.push([
          {
            text: `📥 إرسال الفيديو المسجل #${i + 1} (${rec.recipientMasked})`,
            callbackData: `vcall:dl_rec:${i}`,
          },
        ]);
      }
    }

    keyboard.push(
      buildAppNavigationRow({
        backCallback: 'menu:video_call',
        refreshCallback: 'vcall:rec_history',
      })
    );

    return {
      text: lines.join('\n'),
      keyboard,
      route: 'vcall:rec_history',
    };
  }

  /**
   * Sends one of the recent 3 recorded call `.mp4` videos (`vcall:dl_rec:0..2`) to the user in Telegram.
   */
  public downloadRecordedCallFromHistory(
    adminId: number,
    index: number
  ): BotViewResponse {
    const rec = this.videoCallBridge.getRecordedCallByIndex(adminId, index);
    if (!rec || !rec.filePath || !fs.existsSync(rec.filePath)) {
      return {
        text: '⚠️ *ملف التسجيل المطلوب غير موجود أو تم استبداله بمكالمات أحدث.*',
        keyboard: [
          [
            {
              text: '🔄 تحديث قائمة المكالمات المسجلة',
              callbackData: 'vcall:rec_history',
            },
          ],
          buildBackCancelRow('menu:video_call'),
        ],
        toastText: '⚠️ ملف التسجيل غير متاح',
      };
    }

    const sizeStr = formatFileSize(rec.fileSizeBytes);
    const caption = [
      `📼 *الفيديو المسجل للمكالمة #${index + 1}*`,
      '━━━━━━━━━━━━━━━━━━━━━━',
      `• *معرف المكالمة:* \`${rec.callId}\``,
      `• *المستلم:* \`${rec.recipientMasked}\` (\`${rec.sessionId}\`)`,
      `• *المدة:* \`${rec.durationSeconds} ثانية\` • *الحجم:* \`${sizeStr}\``,
      `• *الإطارات:* \`${rec.videoFramesRecorded} إطار فيديو\` • \`${rec.audioPacketsRecorded} حزمة صوت\``,
      `• *التوقيت:* \`${rec.recordedAtIso}\``,
    ].join('\n');

    const attachment: TelegramMediaAttachment = {
      kind: 'video',
      filePath: rec.filePath,
      fileName: path.basename(rec.filePath),
      mimeType: 'video/mp4',
      caption,
    };

    const view = this.renderRecordedCallsHistory(adminId);
    return {
      ...view,
      mediaAttachments: [attachment],
      toastText: `📥 جاري إرسال الفيديو المسجل #${index + 1}...`,
    };
  }

  /**
   * Reuses one of the recent 3 outbound broadcast videos (`vcall:reuse_bcast:0..2`) without re-uploading.
   */
  public async reuseBroadcastVideo(
    adminId: number,
    index: number
  ): Promise<BotViewResponse> {
    let state = this.states.get(adminId);
    if (!state || !state.selectedSessionId) {
      this.start(adminId);
      state = this.states.get(adminId);
      if (!state) {
        return this.start(adminId);
      }
    }

    const recent = this.getRecentBroadcastVideos(adminId);
    const chosen = recent[index];
    if (!chosen || !chosen.filePath || !fs.existsSync(chosen.filePath)) {
      return {
        ...this.start(adminId, state.selectedSessionId, state.recipientDisplay),
        toastText: '⚠️ ملف الفيديو المحفوظ لم يعد متوفراً، يرجى رفع ملف جديد.',
      };
    }

    // Verify with validateAndInspectVideoMedia before attaching
    await validateAndInspectVideoMedia(chosen.filePath, {
      allowSyntheticMinimalMp4: true,
    });

    // Update lastUsedAtIso and move to index 0
    chosen.lastUsedAtIso = new Date().toISOString();
    const reordered = [
      chosen,
      ...recent.filter((_, i) => i !== index),
    ];
    this.persistRecentBroadcastVideosList(adminId, reordered);

    if (
      state.videoFilePath &&
      path.resolve(state.videoFilePath) !== path.resolve(chosen.filePath)
    ) {
      this.releaseOwnedTempVideoFile(state.videoFilePath);
    }

    state.videoFilePath = chosen.filePath;
    state.videoFileName = chosen.fileName;
    state.mimeType = 'video/mp4';
    state.sizeBytes = chosen.fileSizeBytes;
    state.protocolMode = 'HIROOSY_VOIP_VIDEO_CALL';

    if (state.recipientJid) {
      state.step = 'READY_TO_CALL';
      this.states.set(adminId, state);
      const execView = await this.confirmAndExecute(adminId);
      return {
        ...execView,
        toastText: '✅ تم اختيار الفيديو المحفوظ بنجاح!',
      };
    }

    state.step = 'AWAITING_RECIPIENT';
    this.states.set(adminId, state);
    const step2View = this.renderAwaitingRecipientStep(adminId);
    return {
      ...step2View,
      toastText: '✅ تم اختيار الفيديو المحفوظ بنجاح!',
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
      {
        text: '📼 المكالمات المسجلة (3)',
        callbackData: 'vcall:rec_history',
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
   * Step 2 of 2: Handle uploaded video file -> caches in Recent 3 Outbound Broadcast Videos
   * and transitions to `AWAITING_RECIPIENT` (or starts call immediately if recipient was pre-supplied).
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

    // Cache a persistent copy into the Recent 3 Outbound Broadcast Videos store
    await this.cacheBroadcastVideoForOwner(
      adminId,
      filePath,
      safeName,
      upload.sizeBytes
    );

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

  public async retryCallById(
    adminId: number,
    callId: string
  ): Promise<BotViewResponse> {
    const prev = this.videoCallBridge.getCallStatus(callId);
    if (prev) {
      const existing = this.states.get(adminId);
      this.states.set(adminId, {
        step: 'READY_TO_CALL',
        selectedSessionId: prev.sessionId || existing?.selectedSessionId,
        recipientJid: prev.recipientJid,
        recipientDisplay: prev.recipientMasked || prev.recipientJid,
        videoFilePath:
          prev.videoFilePath && fs.existsSync(prev.videoFilePath)
            ? prev.videoFilePath
            : existing?.videoFilePath,
        videoFileName: prev.videoFileName || existing?.videoFileName,
        mimeType: 'video/mp4',
        callKind: prev.callKind || 'video',
        protocolMode: 'HIROOSY_VOIP_VIDEO_CALL',
        wavesCount: 1,
        loopVideo: prev.loopVideo ?? true,
        recordCall: prev.recordingEnabled ?? true,
        maxDurationSeconds: prev.maxDurationSeconds || 60,
      });
      return this.confirmAndExecute(adminId);
    }
    return this.repeatCall(adminId);
  }

  public async toggleMuteActiveCall(
    adminId: number,
    callId: string
  ): Promise<BotViewResponse> {
    const res = await this.videoCallBridge.toggleMuteCall(callId);
    const stream = this.videoCallBridge.getCallStatus(callId);
    if (!stream) {
      return this.start(adminId);
    }
    const view = this.renderStreamStatusView(stream);
    return {
      ...view,
      toastText: res.muted ? '🔇 تم كتم صوت البث' : '🔊 تم تشغيل صوت البث',
    };
  }

  public async sendReactionOnActiveCall(
    adminId: number,
    callId: string,
    emoji = '❤️'
  ): Promise<BotViewResponse> {
    await this.videoCallBridge.sendCallReaction(callId, emoji);
    const stream = this.videoCallBridge.getCallStatus(callId);
    if (!stream) {
      return this.start(adminId);
    }
    const view = this.renderStreamStatusView(stream);
    return {
      ...view,
      toastText: `${emoji} تم إرسال التفاعل في المكالمة`,
    };
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
    const isConnectedOrStreaming =
      stream.callState === 'CONNECTED' ||
      stream.callState === 'MEDIA_NEGOTIATING' ||
      stream.callState === 'MEDIA_STARTED';
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
        : isConnectedOrStreaming
          ? '🟢 *تم الرد على المكالمة وتأسيس قناة الاتصال المباشر*'
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

    const keyboardRows: InlineKeyboardRows = [];

    if (!isTerminal) {
      keyboardRows.push([
        {
          text: '🛑 إنهاء المكالمة الآن',
          callbackData: `vcall:stop:${stream.callId}`,
        },
      ]);
      if (isConnectedOrStreaming) {
        keyboardRows.push([
          {
            text: stream.muted
              ? '🔊 إلغاء كتم الصوت'
              : '🔇 كتم/تشغيل الصوت',
            callbackData: `vcall:mute:${stream.callId}`,
          },
          {
            text: '👍 إرسال تفاعل',
            callbackData: `vcall:react:${stream.callId}`,
          },
        ]);
      }
    } else {
      keyboardRows.push([
        {
          text: '🔄 إعادة المحاولة',
          callbackData: `vcall:retry:${stream.callId}`,
        },
        {
          text: '🔁 إعادة الاتصال لنفس الرقم',
          callbackData: 'wf_vcall:repeat_call',
        },
      ]);
    }

    if (
      stream.recordingStatus === 'READY' &&
      (stream.outputFilePath || stream.recordedVideoPath)
    ) {
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
          text: '📼 آخر 3 مكالمات مسجلة',
          callbackData: 'vcall:rec_history',
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
      })
    );

    const elapsedSeconds = stream.connectedAt
      ? Math.max(
          0,
          Math.round(
            ((stream.endedAt ? Date.parse(stream.endedAt) : Date.now()) -
              Date.parse(stream.connectedAt)) /
              1000
          )
        )
      : 0;

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
        ...(stream.connectedAt
          ? [`• *زمن المكالمة الفعلي:* \`${elapsedSeconds} ثانية\``]
          : []),
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
    const videoPath = stream.outputFilePath || stream.recordedVideoPath;
    if (
      stream.recordingStatus !== 'READY' ||
      !videoPath ||
      !fs.existsSync(videoPath)
    ) {
      return undefined;
    }
    try {
      const stat = fs.statSync(videoPath);
      const fileName =
        stream.recordedVideoFileName || path.basename(videoPath);
      const sizeStr = formatFileSize(
        stream.recordedVideoSizeBytes || stat.size
      );
      return {
        kind: 'video',
        filePath: videoPath,
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

    const videoPath = stream?.outputFilePath || stream?.recordedVideoPath;
    if (!stream || stream.recordingStatus !== 'READY' || !videoPath) {
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
        initiatedByAdminId: adminId,
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

  public async stopActiveCall(
    adminId: number,
    explicitCallId?: string
  ): Promise<BotViewResponse> {
    const state = this.states.get(adminId);
    const callId =
      explicitCallId ||
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

    if (
      stopped?.recordingStatus === 'READY' &&
      (stopped.outputFilePath || stopped.recordedVideoPath)
    ) {
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
          text: '📼 استعراض آخر 3 مكالمات مسجلة',
          callbackData: 'vcall:rec_history',
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
