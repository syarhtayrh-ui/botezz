import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionManager } from '../../whatsapp/session-manager';
import { UbuntuVideoCallBridge } from '../../whatsapp/video-call-bridge';
import { AuditRepository } from '../../database/repositories/audit-repository';
import { validateRecipient } from '../../security/validation';
import { buildBackCancelRow, InlineKeyboardRows } from '../keyboards/main-menu';
import { BotViewResponse } from './pairing-workflow';
import { ValidationError, toSafeArabicError } from '../../utils/errors';

export type VideoCallWorkflowStep =
  | 'AWAITING_RECIPIENT'
  | 'AWAITING_VIDEO'
  | 'PREVIEW_AND_CONFIRM'
  | 'STREAMING_ACTIVE';

export interface VideoCallWorkflowState {
  step: VideoCallWorkflowStep;
  recipientJid?: string;
  recipientDigits?: string;
  recipientDisplay?: string;
  videoFilePath?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  loopVideo: boolean;
  maxDurationSec: 60 | 180 | 300;
  selectedSessionId?: string;
}

const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv'];
const DURATION_CYCLE: Array<60 | 180 | 300> = [60, 180, 300];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export class VideoCallWorkflow {
  private readonly states = new Map<number, VideoCallWorkflowState>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly videoCallBridge: UbuntuVideoCallBridge,
    private readonly auditRepo: AuditRepository,
    private readonly tempUploadDir: string,
    private readonly maxUploadSizeMb: number
  ) {
    const resolved = path.resolve(tempUploadDir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
  }

  public getState(userId: number): VideoCallWorkflowState | undefined {
    return this.states.get(userId);
  }

  public cancel(userId: number): void {
    const state = this.states.get(userId);
    if (state?.videoFilePath && state.step !== 'STREAMING_ACTIVE') {
      try {
        if (fs.existsSync(state.videoFilePath)) {
          fs.unlinkSync(state.videoFilePath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    this.states.delete(userId);
  }

  public start(userId: number): BotViewResponse {
    this.cancel(userId);
    const connected = this.sessionManager.listConnectedSessions(userId);
    this.states.set(userId, {
      step: 'AWAITING_RECIPIENT',
      loopVideo: true,
      maxDurationSec: 60,
      selectedSessionId: connected[0]?.id,
    });

    return {
      text:
        `📹 *الاتصال المرئي ببث فيديو مسجل (Ubuntu Live Video Call)*\n\n` +
        `الخطوة 1 من 4: الرجاء إرسال رقم هاتف واتساب المستهدف مع رمز الدولة الدولي (مثال: \`+966501234567\`):`,
      keyboard: [buildBackCancelRow('menu:main')],
      toastText: '📹 أدخل رقم الهاتف المستهدف للمكالمة المرئية',
      route: 'menu:video_call',
    };
  }

  public handleRecipientInput(userId: number, rawPhone: string): BotViewResponse {
    const state = this.states.get(userId);
    if (!state) return this.start(userId);

    try {
      const normalized = validateRecipient(rawPhone);
      if (normalized.isGroup) {
        throw new ValidationError(
          'الاتصال المرئي المباشر يتطلب رقم هاتف واتساب فردي وليس معرف مجموعة.'
        );
      }

      const digits = normalized.jid.split('@')[0].replace(/\D/g, '');
      state.recipientJid = normalized.jid;
      state.recipientDigits = digits;
      state.recipientDisplay = normalized.displayTarget;
      state.step = 'AWAITING_VIDEO';

      return {
        text:
          `✅ *تم تحديد الرقم المستهدف:* \`${normalized.displayTarget}\` (\`+${digits}\`)\n\n` +
          `الخطوة 2 من 4: الرجاء رفع ملف الفيديو المسجل (\`.mp4\`, \`.mov\`, \`.webm\`, \`.mkv\`) إلى البوت ليتم بثه داخل المكالمة المرئية.\n` +
          `📦 الحد الأقصى لحجم الفيديو: *${this.maxUploadSizeMb} ميجابايت*.`,
        keyboard: [
          [
            {
              text: '🎬 إرفاق فيديو تجريبي للمعاينة (sample_call.mp4)',
              callbackData: 'wf_vcall:sample_video',
            },
          ],
          buildBackCancelRow('menu:main'),
        ],
        toastText: '🎬 ارفع ملف الفيديو المسجل للمعاينة',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ ${safeErr.userMessage}\nالرجاء إرسال رقم هاتف دولي صحيح (مثال: \`+966501234567\`):`,
        keyboard: [buildBackCancelRow('menu:main')],
      };
    }
  }

  public async attachSampleVideo(userId: number): Promise<BotViewResponse> {
    const sampleMp4Header = Buffer.from(
      '00000018667479706d703432000000006d70343269736f6d000000086d646174',
      'hex'
    );
    return this.handleVideoUpload(userId, {
      originalFilename: 'sample_call.mp4',
      mimeType: 'video/mp4',
      sizeBytes: sampleMp4Header.length,
      contentBuffer: sampleMp4Header,
    });
  }

  public async handleVideoUpload(
    userId: number,
    params: {
      originalFilename: string;
      mimeType: string;
      sizeBytes: number;
      contentBuffer: Buffer;
    }
  ): Promise<BotViewResponse> {
    const state = this.states.get(userId);
    if (!state || !state.recipientJid) {
      return this.start(userId);
    }

    try {
      const cleanName = path
        .basename(params.originalFilename || 'recorded_call.mp4')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = path.extname(cleanName).toLowerCase() || '.mp4';
      const isVideoMime = (params.mimeType || '').toLowerCase().startsWith('video/');

      if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext) && !isVideoMime) {
        throw new ValidationError(
          `صيغة الملف غير مدعومة للبث المرئي. الصيغ المدعومة: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}`
        );
      }

      const maxBytes = this.maxUploadSizeMb * 1024 * 1024;
      if (params.sizeBytes <= 0 || params.sizeBytes > maxBytes) {
        throw new ValidationError(
          `حجم ملف الفيديو يتجاوز الحد المسموح به (${this.maxUploadSizeMb} ميجابايت).`
        );
      }

      // Clean up any previous staged video for this user
      if (state.videoFilePath && fs.existsSync(state.videoFilePath)) {
        try {
          fs.unlinkSync(state.videoFilePath);
        } catch {
          // Ignore
        }
      }

      const uniqueName = `vcall_${userId}_${Date.now()}_${crypto
        .randomBytes(3)
        .toString('hex')}${ALLOWED_VIDEO_EXTENSIONS.includes(ext) ? ext : '.mp4'}`;
      const safeFilePath = path.resolve(this.tempUploadDir, uniqueName);
      fs.writeFileSync(safeFilePath, params.contentBuffer, { mode: 0o600 });

      state.videoFilePath = safeFilePath;
      state.fileName = cleanName;
      state.mimeType = isVideoMime ? params.mimeType : 'video/mp4';
      state.sizeBytes = params.sizeBytes;
      state.step = 'PREVIEW_AND_CONFIRM';

      const connected = this.sessionManager.listConnectedSessions(userId);
      if (
        !state.selectedSessionId ||
        !connected.some((s) => s.id === state.selectedSessionId)
      ) {
        state.selectedSessionId = connected[0]?.id;
      }

      return this.renderPreviewAndConfirm(userId);
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `⚠️ *تعذر قبول ملف الفيديو:*\n${safeErr.userMessage}`,
        keyboard: [
          [
            {
              text: '🎬 إرفاق فيديو تجريبي للمعاينة (sample_call.mp4)',
              callbackData: 'wf_vcall:sample_video',
            },
          ],
          buildBackCancelRow('menu:main'),
        ],
      };
    }
  }

  public async toggleLoop(userId: number): Promise<BotViewResponse> {
    const state = this.states.get(userId);
    if (!state || state.step !== 'PREVIEW_AND_CONFIRM') return this.start(userId);
    state.loopVideo = !state.loopVideo;
    return this.renderPreviewAndConfirm(userId);
  }

  public async cycleDuration(userId: number): Promise<BotViewResponse> {
    const state = this.states.get(userId);
    if (!state || state.step !== 'PREVIEW_AND_CONFIRM') return this.start(userId);
    const idx = DURATION_CYCLE.indexOf(state.maxDurationSec);
    state.maxDurationSec = DURATION_CYCLE[(idx + 1) % DURATION_CYCLE.length];
    return this.renderPreviewAndConfirm(userId);
  }

  public async selectSession(
    userId: number,
    sessionId: string
  ): Promise<BotViewResponse> {
    const state = this.states.get(userId);
    if (!state || state.step !== 'PREVIEW_AND_CONFIRM') return this.start(userId);
    const sess = this.sessionManager.getSession(sessionId, userId);
    if (sess) {
      state.selectedSessionId = sess.id;
    }
    return this.renderPreviewAndConfirm(userId);
  }

  public promptReupload(userId: number): BotViewResponse {
    const state = this.states.get(userId);
    if (!state || !state.recipientJid) return this.start(userId);
    state.step = 'AWAITING_VIDEO';
    return {
      text:
        `🔄 *تغيير ملف الفيديو المسجل*\n` +
        `👤 المستهدف: \`${state.recipientDisplay}\`\n\n` +
        `أرسل ملف الفيديو الجديد (\`.mp4\`, \`.mov\`, \`.webm\`, \`.mkv\`) الآن:`,
      keyboard: [
        [
          {
            text: '🎬 إرفاق فيديو تجريبي للمعاينة (sample_call.mp4)',
            callbackData: 'wf_vcall:sample_video',
          },
        ],
        buildBackCancelRow('menu:main'),
      ],
    };
  }

  public async renderPreviewAndConfirm(userId: number): Promise<BotViewResponse> {
    const state = this.states.get(userId);
    if (!state || !state.recipientJid || !state.videoFilePath || !state.fileName) {
      return this.start(userId);
    }

    const connected = this.sessionManager.listConnectedSessions(userId);
    if (
      !state.selectedSessionId &&
      connected.length > 0
    ) {
      state.selectedSessionId = connected[0].id;
    }

    const probe = await this.videoCallBridge.probeEnvironment();
    const sizeFormatted = formatFileSize(state.sizeBytes ?? 0);
    const loopLabel = state.loopVideo ? 'مفعل ✅' : 'معطل ❌';
    const selectedSession = state.selectedSessionId
      ? this.sessionManager.getSession(state.selectedSessionId, userId)
      : undefined;
    const sessionLabel = selectedSession
      ? `${selectedSession.label} (\`${selectedSession.id}\`)`
      : '⚠️ لا توجد جلسة متصلة حالياً';

    const rows: InlineKeyboardRows = [
      [
        {
          text: `🔁 تكرار الفيديو: ${loopLabel}`,
          callbackData: 'wf_vcall:toggle_loop',
        },
        {
          text: `⏱️ المدة: ${state.maxDurationSec} ثانية`,
          callbackData: 'wf_vcall:cycle_duration',
        },
      ],
    ];

    if (connected.length > 1) {
      const sessionBtns = connected.slice(0, 3).map((s) => ({
        text: `${s.id === state.selectedSessionId ? '🟢' : '⚪'} ${s.label}`,
        callbackData: `wf_vcall:select_sess:${s.id}`,
      }));
      rows.push(sessionBtns);
    }

    rows.push([
      {
        text: '📹 تأكيد وبدء الاتصال المرئي الآن',
        callbackData: 'wf_vcall:confirm_execute',
      },
    ]);
    rows.push([
      { text: '🔄 تغيير ملف الفيديو', callbackData: 'wf_vcall:reupload' },
      { text: '❌ إلغاء', callbackData: 'workflow:cancel' },
    ]);

    return {
      text:
        `📋 *الخطوة 3 من 4: معاينة وتأكيد الاتصال المرئي ببث مسجل*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 *الرقم المستهدف:* \`${state.recipientDisplay}\` (\`${state.recipientJid}\`)\n` +
        `🎞️ *اسم ملف الفيديو:* \`${state.fileName}\` (${sizeFormatted}, \`${state.mimeType}\`)\n` +
        `🖥️ *حالة محرك البث على Ubuntu:* ${probe.summaryAr}\n` +
        `🔁 *تكرار الفيديو تلقائياً أثناء المكالمة:* ${loopLabel}\n` +
        `⏱️ *الحد الأقصى لمدة المكالمة:* \`${state.maxDurationSec} ثانية\`\n` +
        `📱 *الجلسة المختارة:* ${sessionLabel}\n\n` +
        `هل تؤكد بدء الاتصال المرئي وبث الفيديو المسجل الآن؟`,
      keyboard: rows,
      toastText: '📋 معاينة إعدادات البث المرئي',
    };
  }

  public async confirmAndExecute(userId: number): Promise<BotViewResponse> {
    const state = this.states.get(userId);
    if (
      !state ||
      !state.recipientJid ||
      !state.recipientDigits ||
      !state.videoFilePath ||
      !state.fileName
    ) {
      return this.start(userId);
    }

    const connected = this.sessionManager.listConnectedSessions(userId);
    const chosenSessionId = state.selectedSessionId || connected[0]?.id;
    if (!chosenSessionId) {
      return {
        text:
          `⚠️ *لا توجد جلسة واتساب متصلة في حسابك حالياً لتنفيذ الاتصال المرئي.*\n` +
          `يرجى ربط جلسة واتساب أو إعادة اتصالها أولاً.`,
        keyboard: [
          [{ text: '📲 ربط حساب واتساب', callbackData: 'menu:link_account' }],
          [{ text: '🔙 القائمة الرئيسية', callbackData: 'menu:main' }],
        ],
      };
    }

    try {
      const driver = this.sessionManager.getDriver(chosenSessionId, userId);
      const callSessionKey = `vcall_${userId}`;

      const result = await this.videoCallBridge.startVideoCallStream({
        callSessionKey,
        sessionId: chosenSessionId,
        targetPhoneDigits: state.recipientDigits,
        targetJid: state.recipientJid,
        videoFilePath: state.videoFilePath,
        fileName: state.fileName,
        mimeType: state.mimeType || 'video/mp4',
        loopVideo: state.loopVideo,
        maxDurationSec: state.maxDurationSec,
        driver,
      });

      state.step = 'STREAMING_ACTIVE';

      this.auditRepo.record({
        actorTelegramId: userId,
        action: 'VIDEO_CALL_STREAM_STARTED',
        targetId: state.recipientDisplay || state.recipientJid,
        outcome: 'SUCCESS',
        metadata: {
          sessionId: chosenSessionId,
          mode: result.mode,
          fileName: state.fileName,
          loopVideo: state.loopVideo,
          maxDurationSec: state.maxDurationSec,
        },
      });

      return {
        text:
          `📹 *الخطوة 4 من 4: حالة المكالمة المرئية والبث المباشر*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `${result.summaryAr}\n\n` +
          `👤 *المستهدف:* \`${state.recipientDisplay}\`\n` +
          `📱 *الجلسة المستخدمة:* \`${chosenSessionId}\`\n` +
          `🎞️ *ملف البث:* \`${state.fileName}\`\n` +
          `⏱️ *المدة القصوى:* \`${result.maxDurationSec} ثانية\` (التكرار: ${result.loopVideo ? 'مفعل' : 'معطل'})`,
        keyboard: [
          [
            {
              text: '🛑 إنهاء المكالمة وإيقاف البث',
              callbackData: 'wf_vcall:stop',
            },
          ],
          [
            { text: '📹 مكالمة مرئية جديدة', callbackData: 'menu:video_call' },
            { text: '🏠 القائمة الرئيسية', callbackData: 'menu:main' },
          ],
        ],
        toastText: '📹 بدأ بث المكالمة المرئية',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      return {
        text: `❌ *تعذر بدء الاتصال المرئي:*\n${safeErr.userMessage}`,
        keyboard: [
          [{ text: '🔄 إعادة المحاولة', callbackData: 'menu:video_call' }],
          [{ text: '🏠 القائمة الرئيسية', callbackData: 'menu:main' }],
        ],
      };
    }
  }

  public async stopActiveCall(userId: number): Promise<BotViewResponse> {
    const callSessionKey = `vcall_${userId}`;
    const stopped = await this.videoCallBridge.stopVideoCallStream(callSessionKey);
    this.cancel(userId);

    this.auditRepo.record({
      actorTelegramId: userId,
      action: 'VIDEO_CALL_STREAM_STOPPED',
      targetId: callSessionKey,
      outcome: 'SUCCESS',
      metadata: { wasActive: stopped },
    });

    return {
      text: stopped
        ? `🛑 *تم إنهاء المكالمة المرئية وإيقاف ضخ الفيديو وحذف الملف المؤقت بنجاح.*`
        : `ℹ️ لا يوجد بث مرئي نشط حالياً (ربما انتهت مدة المكالمة تلقائياً).`,
      keyboard: [
        [
          { text: '📹 بدء مكالمة مرئية جديدة', callbackData: 'menu:video_call' },
          { text: '🏠 القائمة الرئيسية', callbackData: 'menu:main' },
        ],
      ],
      toastText: '🛑 تم إيقاف البث المرئي',
    };
  }
}
