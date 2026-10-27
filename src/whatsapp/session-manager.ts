import crypto from 'node:crypto';
import { SessionRepository, SessionRecord } from '../database/repositories/session-repository';
import { AuditRepository } from '../database/repositories/audit-repository';
import { SessionStore } from './session-store';
import {
  WhatsAppSessionDriver,
  DriverFactory,
  AthanasiaBaileysSessionDriver,
  MockWhatsAppSessionDriver,
} from './connection-manager';
import { normalizePhoneNumber } from '../security/validation';
import {
  PairingError,
  WhatsAppConnectionError,
  ValidationError,
  TaskTimeoutError,
  AppError,
  toSafeArabicError,
} from '../utils/errors';
import { redactText, maskPhoneNumber } from '../security/redaction';
import { calculateBackoffDelay } from '../utils/retry';
import { createLogger } from '../logging/logger';

const log = createLogger('session-manager');

export interface PairingInitiationResult {
  session: SessionRecord;
  pairingCode: string;
  normalizedPhone: string;
  maskedPhone: string;
  isCustomCode: boolean;
  instructionsArabic: string;
}

export class SessionManager {
  private readonly drivers = new Map<string, WhatsAppSessionDriver>();
  private readonly activePairingLocks = new Set<string>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxReconnectAttempts = 5;
  private isShuttingDown = false;

  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly auditRepo: AuditRepository,
    private readonly sessionStore: SessionStore,
    private readonly driverFactory: DriverFactory = (sessionId, authDir) =>
      new AthanasiaBaileysSessionDriver(sessionId, authDir)
  ) {}

  /**
   * Creates a new isolated session record and prepares its storage directory.
   */
  public createSession(label?: string, actorTelegramId = 0): SessionRecord {
    const id = `sess_${crypto.randomUUID().slice(0, 8)}`;
    const cleanLabel = label?.trim() || `حساب واتساب (${id})`;
    const authDir = this.sessionStore.prepareSessionAuthDir(id);

    const record = this.sessionRepo.create({
      id,
      label: cleanLabel,
      status: 'INITIALIZING',
      authDir,
    });

    this.auditRepo.record({
      actorTelegramId,
      action: 'SESSION_CREATED',
      targetId: id,
      outcome: 'SUCCESS',
      metadata: { label: cleanLabel },
    });

    return record;
  }

  /**
   * Initiates the WhatsApp pairing code flow for a session using athanasia-baileys.
   * Supports optional custom 8-character pairing code (`+966501234567 CODE1234`).
   * Prevents duplicate concurrent pairing workflows for the same session.
   */
  public async initiatePairing(params: {
    sessionId: string;
    rawPhoneNumber: string;
    customPairingCode?: string;
    actorTelegramId: number;
    autoCompleteInMock?: boolean;
  }): Promise<PairingInitiationResult> {
    const {
      sessionId,
      rawPhoneNumber,
      customPairingCode,
      actorTelegramId,
      autoCompleteInMock = true,
    } = params;

    if (this.activePairingLocks.has(sessionId)) {
      throw new PairingError(
        'توجد عملية ربط جارية بالفعل لهذه الجلسة. يرجى الانتظار حتى تكتمل أو تنتهي مهلتها.'
      );
    }

    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new ValidationError('الجلسة المحددة غير موجودة.');
    }

    const normalized = normalizePhoneNumber(rawPhoneNumber);
    const effectiveCustomCode = customPairingCode || normalized.customPairingCode;
    this.activePairingLocks.add(sessionId);

    try {
      const authDir = this.sessionStore.prepareSessionAuthDir(sessionId);
      const driver = this.driverFactory(sessionId, authDir);
      this.drivers.set(sessionId, driver);

      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'PAIRING_PENDING',
        maskedPhone: normalized.masked,
        jid: normalized.jid,
        lastError: null,
      });

      await driver.connect({
        onStatusChange: (evt) => this.handleDriverStatusUpdate(sessionId, evt),
      });

      const pairingCode = await driver.requestPairingCode(
        normalized.digits,
        effectiveCustomCode
      );

      // If running with the Mock driver for tests / web preview, persist mock auth marker
      if (driver instanceof MockWhatsAppSessionDriver && autoCompleteInMock) {
        this.sessionStore.writeMockAuthMarker(sessionId, normalized.masked);
        driver.completeSimulatedPairing();
      }

      this.auditRepo.record({
        actorTelegramId,
        action: 'SESSION_PAIRING_INITIATED',
        targetId: sessionId,
        outcome: 'SUCCESS',
        metadata: {
          maskedPhone: normalized.masked,
          isMock: driver.isMock,
          customCodeUsed: Boolean(effectiveCustomCode),
        },
      });

      const updatedSession = this.sessionRepo.findById(sessionId)!;

      return {
        session: updatedSession,
        pairingCode,
        normalizedPhone: normalized.e164,
        maskedPhone: normalized.masked,
        isCustomCode: Boolean(effectiveCustomCode),
        instructionsArabic:
          'افتح تطبيق واتساب على هاتفك ⬅️ الأجهزة المرتبطة ⬅️ ربط جهاز ⬅️ الربط برقم الهاتف بدلاً من ذلك، ثم أدخل الرمز أعلاه.',
      };
    } catch (err) {
      const safeErr = toSafeArabicError(err);
      const sanitizedTechnicalReason = redactText(safeErr.sanitizedTechnicalMessage);
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'FAILED',
        lastError: safeErr.userMessage,
      });
      this.auditRepo.record({
        actorTelegramId,
        action: 'SESSION_PAIRING_FAILED',
        targetId: sessionId,
        outcome: 'FAILURE',
        metadata: {
          category: safeErr.category,
          reason: sanitizedTechnicalReason,
        },
      });
      log.error('WhatsApp session pairing failed', {
        sessionId,
        category: safeErr.category,
        error: sanitizedTechnicalReason,
      });

      if (err instanceof AppError) {
        throw err;
      }
      throw new PairingError(`فشل بدء عملية الربط: ${safeErr.userMessage}`, sanitizedTechnicalReason);
    } finally {
      this.activePairingLocks.delete(sessionId);
    }
  }

  private handleDriverStatusUpdate(
    sessionId: string,
    evt: {
      status:
        | 'CONNECTING'
        | 'AUTHENTICATED'
        | 'CONNECTED'
        | 'DISCONNECTED'
        | 'RESTART_REQUIRED'
        | 'LOGGED_OUT';
      jid?: string;
      statusCode?: number;
      errorMessage?: string;
    }
  ): void {
    if (this.isShuttingDown) return;

    const current = this.sessionRepo.findById(sessionId);
    if (!current) return;

    if (evt.status === 'CONNECTED') {
      this.clearReconnectTimer(sessionId);
      const masked = evt.jid
        ? maskPhoneNumber(`+${evt.jid.split('@')[0]}`)
        : current.masked_phone;
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'CONNECTED',
        jid: evt.jid ?? current.jid,
        maskedPhone: masked,
        reconnectAttempts: 0,
        lastError: null,
      });
      log.info('Session connected', { sessionId });
    } else if (evt.status === 'RESTART_REQUIRED') {
      // athanasia-baileys emits DisconnectReason.restartRequired (515) immediately after
      // pairing finishes (`companion_finish`). Reconnect immediately with the saved credentials.
      this.clearReconnectTimer(sessionId);
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'RECONNECTING',
        lastError: null,
      });
      void this.reconnectSession(sessionId).catch((err) => {
        log.warn('Immediate restart after pairing failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else if (evt.status === 'LOGGED_OUT') {
      this.clearReconnectTimer(sessionId);
      this.sessionStore.removeSessionAuthDir(sessionId);
      this.drivers.delete(sessionId);
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'LOGGED_OUT',
        lastError: evt.errorMessage || 'تم تسجيل الخروج أو إلغاء صلاحية الجلسة.',
      });
      log.warn('Session logged out and local credentials purged', { sessionId });
    } else if (evt.status === 'DISCONNECTED') {
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'DISCONNECTED',
        lastError: evt.errorMessage || 'انقطع الاتصال مؤقتاً.',
      });
      this.scheduleBoundedReconnect(sessionId);
    }
  }

  /**
   * Schedules a bounded exponential backoff reconnection with jitter.
   * Prevents duplicate reconnect loops for the same session.
   */
  private scheduleBoundedReconnect(sessionId: string): void {
    if (this.isShuttingDown || this.reconnectTimers.has(sessionId)) {
      return;
    }

    const session = this.sessionRepo.findById(sessionId);
    if (!session || session.status === 'LOGGED_OUT') {
      return;
    }

    const nextAttempt = session.reconnect_attempts + 1;
    if (nextAttempt > this.maxReconnectAttempts) {
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'FAILED',
        lastError: `تم تجاوز الحد الأقصى لمحاولات إعادة الاتصال (${this.maxReconnectAttempts}).`,
      });
      return;
    }

    const delayMs = calculateBackoffDelay(nextAttempt, {
      baseDelayMs: 1000,
      maxDelayMs: 15000,
    });

    this.sessionRepo.updateStatus({
      id: sessionId,
      status: 'RECONNECTING',
      reconnectAttempts: nextAttempt,
    });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      void this.reconnectSession(sessionId).catch((err) => {
        log.warn('Scheduled reconnect failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);

    this.reconnectTimers.set(sessionId, timer);
  }

  private clearReconnectTimer(sessionId: string): void {
    const existing = this.reconnectTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.reconnectTimers.delete(sessionId);
    }
  }

  /**
   * Restores previously authenticated sessions from isolated storage on application startup.
   */
  public async restoreSessionsOnStartup(): Promise<{
    restoredCount: number;
    skippedCount: number;
  }> {
    const candidates = this.sessionRepo.listRestorable();
    let restoredCount = 0;
    let skippedCount = 0;

    for (const session of candidates) {
      if (!this.sessionStore.hasPersistedCredentials(session.id)) {
        this.sessionRepo.updateStatus({
          id: session.id,
          status: 'DISCONNECTED',
          lastError: 'لم يتم العثور على ملفات المصادقة المحفوظة عند بدء التشغيل.',
        });
        skippedCount++;
        continue;
      }

      try {
        const driver = this.driverFactory(session.id, session.auth_dir);
        this.drivers.set(session.id, driver);
        await driver.connect({
          onStatusChange: (evt) => this.handleDriverStatusUpdate(session.id, evt),
        });
        restoredCount++;
      } catch (err) {
        this.sessionRepo.updateStatus({
          id: session.id,
          status: 'DISCONNECTED',
          lastError:
            err instanceof Error ? err.message : 'فشلت استعادة الجلسة تلقائياً.',
        });
        skippedCount++;
      }
    }

    log.info('Completed startup session restoration', { restoredCount, skippedCount });
    return { restoredCount, skippedCount };
  }

  public async reconnectSession(sessionId: string, actorTelegramId = 0): Promise<SessionRecord> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new ValidationError('الجلسة غير موجودة.');
    }

    this.clearReconnectTimer(sessionId);
    const authDir = this.sessionStore.prepareSessionAuthDir(sessionId);
    const driver = this.driverFactory(sessionId, authDir);
    this.drivers.set(sessionId, driver);

    await driver.connect({
      onStatusChange: (evt) => this.handleDriverStatusUpdate(sessionId, evt),
    });

    if (driver.isMock) {
      this.sessionStore.writeMockAuthMarker(sessionId, session.masked_phone || '+966*****0000');
    }

    const updated = this.sessionRepo.updateStatus({
      id: sessionId,
      status: 'CONNECTED',
      reconnectAttempts: 0,
      lastError: null,
    });

    if (actorTelegramId > 0) {
      this.auditRepo.record({
        actorTelegramId,
        action: 'SESSION_RECONNECTED',
        targetId: sessionId,
        outcome: 'SUCCESS',
      });
    }

    return updated!;
  }

  public async disconnectSession(
    sessionId: string,
    actorTelegramId = 0
  ): Promise<SessionRecord> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new ValidationError('الجلسة غير موجودة.');
    }

    this.clearReconnectTimer(sessionId);
    const driver = this.drivers.get(sessionId);
    if (driver) {
      await driver.disconnect();
      this.drivers.delete(sessionId);
    }

    const updated = this.sessionRepo.updateStatus({
      id: sessionId,
      status: 'DISCONNECTED',
      lastError: 'تم قطع الاتصال يدوياً بواسطة المسؤول.',
    });

    if (actorTelegramId > 0) {
      this.auditRepo.record({
        actorTelegramId,
        action: 'SESSION_DISCONNECTED',
        targetId: sessionId,
        outcome: 'SUCCESS',
      });
    }

    return updated!;
  }

  public async removeSession(sessionId: string, actorTelegramId = 0): Promise<void> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new ValidationError('الجلسة غير موجودة.');
    }

    this.clearReconnectTimer(sessionId);
    const driver = this.drivers.get(sessionId);
    if (driver) {
      await driver.logout();
      this.drivers.delete(sessionId);
    }

    this.sessionStore.removeSessionAuthDir(sessionId);
    this.sessionRepo.deleteById(sessionId);

    this.auditRepo.record({
      actorTelegramId,
      action: 'SESSION_REMOVED',
      targetId: sessionId,
      outcome: 'SUCCESS',
    });
  }

  public getDriver(sessionId: string): WhatsAppSessionDriver {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new WhatsAppConnectionError(`الجلسة (${sessionId}) غير مسجلة في النظام.`);
    }
    if (session.status !== 'CONNECTED' && session.status !== 'AUTHENTICATED') {
      throw new WhatsAppConnectionError(
        `الجلسة (${session.label}) غير متصلة حالياً (الحالة: ${session.status}).`
      );
    }
    const driver = this.drivers.get(sessionId);
    if (!driver) {
      throw new WhatsAppConnectionError(
        `لم يتم العثور على قناة اتصال نشطة للجلسة (${session.label}). يرجى إعادة الاتصال أولاً.`
      );
    }
    return driver;
  }

  public listSessions(): SessionRecord[] {
    return this.sessionRepo.listAll();
  }

  public listConnectedSessions(): SessionRecord[] {
    return this.sessionRepo.listConnected();
  }

  public getSession(sessionId: string): SessionRecord | undefined {
    return this.sessionRepo.findById(sessionId);
  }

  public renameSession(
    sessionId: string,
    newLabel: string,
    actorTelegramId: number
  ): SessionRecord {
    const clean = newLabel.trim();
    if (!clean || clean.length < 2 || clean.length > 50) {
      throw new ValidationError('اسم الجلسة يجب أن يكون بين حرفين و 50 حرفاً.');
    }
    const updated = this.sessionRepo.updateLabel(sessionId, clean);
    if (!updated) {
      throw new ValidationError('الجلسة المحددة غير موجودة.');
    }
    this.auditRepo.record({
      actorTelegramId,
      action: 'SESSION_RENAMED',
      targetId: sessionId,
      outcome: 'SUCCESS',
      metadata: { label: clean },
    });
    return updated;
  }

  public async shutdownAll(): Promise<void> {
    this.isShuttingDown = true;
    for (const sessionId of this.reconnectTimers.keys()) {
      this.clearReconnectTimer(sessionId);
    }
    for (const [sessionId, driver] of this.drivers.entries()) {
      try {
        await driver.disconnect();
      } catch (err) {
        log.warn('Error disconnecting driver during shutdown', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.drivers.clear();
  }
}
