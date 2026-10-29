import crypto from 'node:crypto';
import {
  SessionRepository,
  SessionRecord,
  SessionHealthStatus,
} from '../database/repositories/session-repository';
import { AuditRepository } from '../database/repositories/audit-repository';
import { SessionStore, CredentialInspectionResult } from './session-store';
import {
  WhatsAppSessionDriver,
  DriverFactory,
  AthanasiaBaileysSessionDriver,
  MockWhatsAppSessionDriver,
  SessionSocketDiagnostics,
  classifyDisconnectReason,
} from './connection-manager';
import { normalizePhoneNumber } from '../security/validation';
import {
  PairingError,
  WhatsAppConnectionError,
  ValidationError,
  AuthorizationError,
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

export interface SessionManagerOptions {
  maxReconnectAttempts?: number;
  pairingTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  defaultAutoCompleteInMock?: boolean;
  configuredAdminId?: number;
  onDisconnectAlert?: (params: {
    session: SessionRecord;
    newStatus: SessionRecord['status'];
    reasonAr: string;
  }) => void;
}

export interface SessionHealthReport {
  status: SessionHealthStatus;
  score: number;
  issues: string[];
  lastActivityAt: string | null;
}

export interface StartupRestorationSummary {
  restoredCount: number;
  skippedCount: number;
  repairedFromBackupCount: number;
  unregisteredSkippedCount: number;
  corruptedCount: number;
  stoppedOrLoggedOutSkippedCount: number;
}

export interface LiveSessionVerification {
  session: SessionRecord;
  isLiveConnected: boolean;
  connectionGeneration: number;
  hasActiveDriver: boolean;
  hasReconnectTimer: boolean;
  hasPairingTimer: boolean;
  socketDiagnostics: SessionSocketDiagnostics;
  credentialInfo: CredentialInspectionResult;
  health: SessionHealthReport;
}

export class SessionManager {
  private readonly drivers = new Map<string, WhatsAppSessionDriver>();
  private readonly connectionGenerations = new Map<string, number>();
  private readonly activePairingLocks = new Set<string>();
  private readonly activePhonePairingLocks = new Set<string>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly pairingTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxReconnectAttempts: number;
  private readonly pairingTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  public defaultAutoCompleteInMock: boolean;
  private configuredAdminId: number;
  private onDisconnectAlert?: SessionManagerOptions['onDisconnectAlert'];
  private isShuttingDown = false;

  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly auditRepo: AuditRepository,
    private readonly sessionStore: SessionStore,
    private readonly driverFactory: DriverFactory = (sessionId, authDir) =>
      new AthanasiaBaileysSessionDriver(sessionId, authDir),
    options?: SessionManagerOptions
  ) {
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.pairingTimeoutMs = options?.pairingTimeoutMs ?? 180_000;
    this.reconnectBaseDelayMs = options?.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options?.reconnectMaxDelayMs ?? 15_000;
    this.defaultAutoCompleteInMock = options?.defaultAutoCompleteInMock ?? true;
    this.configuredAdminId = options?.configuredAdminId ?? 0;
    this.onDisconnectAlert = options?.onDisconnectAlert;
  }

  public setConfiguredAdminId(adminId: number): void {
    this.configuredAdminId = adminId;
  }

  public isOwner(actorTelegramId?: number): boolean {
    if (actorTelegramId === undefined || actorTelegramId === 0) return true;
    return this.configuredAdminId > 0 && actorTelegramId === this.configuredAdminId;
  }

  public canAccessSession(
    session: SessionRecord,
    actorTelegramId?: number
  ): boolean {
    if (this.isOwner(actorTelegramId)) return true;
    return (session.owner_telegram_id ?? 0) === actorTelegramId;
  }

  public assertSessionAccess(
    sessionId: string,
    actorTelegramId?: number
  ): SessionRecord {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new ValidationError('الجلسة المحددة غير موجودة.');
    }
    if (!this.canAccessSession(session, actorTelegramId)) {
      throw new AuthorizationError('⛔ غير مصرح لك بالوصول إلى هذه الجلسة أو إدارتها.');
    }
    return session;
  }

  public setDisconnectAlertHandler(
    handler: SessionManagerOptions['onDisconnectAlert']
  ): void {
    this.onDisconnectAlert = handler;
  }

  private nextGeneration(sessionId: string): number {
    const next = (this.connectionGenerations.get(sessionId) ?? 0) + 1;
    this.connectionGenerations.set(sessionId, next);
    return next;
  }

  private isCurrentGeneration(sessionId: string, generation: number): boolean {
    return this.connectionGenerations.get(sessionId) === generation;
  }

  public getConnectionGeneration(sessionId: string): number {
    return this.connectionGenerations.get(sessionId) ?? 0;
  }

  private async cleanupExistingDriver(sessionId: string): Promise<void> {
    // Advance generation first so any synchronous close callbacks emitted during disconnect are ignored
    this.nextGeneration(sessionId);
    const existing = this.drivers.get(sessionId);
    if (existing) {
      this.drivers.delete(sessionId);
      try {
        await existing.disconnect();
      } catch (err) {
        log.warn('Error disconnecting previous driver instance', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private clearReconnectTimer(sessionId: string): void {
    const existing = this.reconnectTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.reconnectTimers.delete(sessionId);
    }
  }

  private clearPairingTimer(sessionId: string): void {
    const existing = this.pairingTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.pairingTimers.delete(sessionId);
    }
  }

  private startPairingExpirationTimer(
    sessionId: string,
    generation: number,
    timeoutMs = this.pairingTimeoutMs
  ): void {
    this.clearPairingTimer(sessionId);
    if (timeoutMs <= 0) return;

    const timer = setTimeout(() => {
      this.pairingTimers.delete(sessionId);
      if (this.isShuttingDown || !this.isCurrentGeneration(sessionId, generation)) {
        return;
      }

      const current = this.sessionRepo.findById(sessionId);
      if (
        !current ||
        (current.status !== 'PAIRING_PENDING' &&
          current.status !== 'WAITING_FOR_PAIRING' &&
          current.status !== 'CONNECTING')
      ) {
        return;
      }

      log.warn('Pairing code expired without user confirmation on phone', {
        sessionId,
        generation,
      });

      void this.cleanupExistingDriver(sessionId).finally(() => {
        this.sessionStore.resetUnregisteredAuthDir(sessionId, false);
        this.sessionRepo.updateStatus({
          id: sessionId,
          status: 'FAILED',
          healthStatus: 'UNHEALTHY',
          lastDisconnectReason: 'PAIRING_TIMEOUT',
          lastError:
            'انتهت مهلة انتظار إدخال رمز الربط في تطبيق واتساب دون إتمام المقارنة على الهاتف.',
        });
      });
    }, timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pairingTimers.set(sessionId, timer);
  }

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
      ownerTelegramId: actorTelegramId,
    });

    this.auditRepo.record({
      actorTelegramId,
      action: 'SESSION_CREATED',
      targetId: id,
      outcome: 'SUCCESS',
      metadata: { label: cleanLabel, ownerTelegramId: actorTelegramId },
    });

    return record;
  }

  /**
   * Initiates the WhatsApp pairing code flow for a session using athanasia-baileys.
   * Validates phone number BEFORE creating or modifying any session or socket.
   * Supports optional custom 8-character pairing code (`+966501234567 CODE1234`).
   * Prevents duplicate concurrent pairing workflows for the same session or phone number.
   */
  public async initiatePairing(params: {
    sessionId?: string;
    label?: string;
    rawPhoneNumber: string;
    customPairingCode?: string;
    actorTelegramId: number;
    autoCompleteInMock?: boolean;
    pairingTimeoutMs?: number;
  }): Promise<PairingInitiationResult> {
    const {
      rawPhoneNumber,
      customPairingCode,
      actorTelegramId,
      autoCompleteInMock = this.defaultAutoCompleteInMock,
      pairingTimeoutMs,
    } = params;

    // 1. Validate and normalize the phone number FIRST before creating any session, directory, or socket!
    const normalized = normalizePhoneNumber(rawPhoneNumber);
    const effectiveCustomCode = customPairingCode || normalized.customPairingCode;

    if (this.activePhonePairingLocks.has(normalized.digits)) {
      throw new PairingError(
        'توجد عملية ربط جارية حالياً لهذا الرقم. يرجى الانتظار حتى تكتمل أو تنتهي مهلتها.'
      );
    }

    let sessionId = params.sessionId;
    let session: SessionRecord | undefined;

    if (sessionId) {
      if (this.activePairingLocks.has(sessionId)) {
        throw new PairingError(
          'توجد عملية ربط جارية بالفعل لهذه الجلسة. يرجى الانتظار حتى تكتمل أو تنتهي مهلتها.'
        );
      }
      session = this.assertSessionAccess(sessionId, actorTelegramId);
    } else {
      session = this.createSession(params.label, actorTelegramId);
      sessionId = session.id;
    }

    this.activePairingLocks.add(sessionId);
    this.activePhonePairingLocks.add(normalized.digits);

    try {
      this.clearReconnectTimer(sessionId);
      this.clearPairingTimer(sessionId);
      await this.cleanupExistingDriver(sessionId);

      // Reset any leftover unregistered `creds.json` so `validateConnection()` sees `creds.me === undefined`
      // and sends `generateRegistrationNode` instead of `generateLoginNode`.
      const authDir = this.sessionStore.resetUnregisteredAuthDir(sessionId, true);
      const generation = this.nextGeneration(sessionId);
      const driver = this.driverFactory(sessionId, authDir);
      this.drivers.set(sessionId, driver);

      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'CONNECTING',
        maskedPhone: normalized.masked,
        jid: normalized.jid,
        reconnectAttempts: 0,
        lastDisconnectCode: null,
        lastDisconnectReason: null,
        healthStatus: 'UNKNOWN',
        lastError: null,
      });

      await driver.connect({
        onStatusChange: (evt) =>
          this.handleDriverStatusUpdate(sessionId!, generation, evt),
      });

      const pairingCode = await driver.requestPairingCode(
        normalized.digits,
        effectiveCustomCode
      );

      // Upon generating the pairing code, the session is strictly in `PAIRING_PENDING`
      // (awaiting user confirmation on the phone), NOT `CONNECTED`!
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'PAIRING_PENDING',
        maskedPhone: normalized.masked,
        jid: normalized.jid,
        reconnectAttempts: 0,
        lastError: null,
      });

      this.startPairingExpirationTimer(
        sessionId,
        generation,
        pairingTimeoutMs ?? this.pairingTimeoutMs
      );

      // Only if running with MockWhatsAppSessionDriver AND `autoCompleteInMock` is enabled
      // do we simulate immediate phone confirmation.
      if (driver instanceof MockWhatsAppSessionDriver && autoCompleteInMock) {
        this.sessionStore.writeMockAuthMarker(sessionId, normalized.masked, true);
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
          generation,
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
      this.clearPairingTimer(sessionId);
      await this.cleanupExistingDriver(sessionId);
      this.sessionStore.resetUnregisteredAuthDir(sessionId, false);

      const safeErr = toSafeArabicError(err);
      const sanitizedTechnicalReason = redactText(safeErr.sanitizedTechnicalMessage);
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'FAILED',
        healthStatus: 'UNHEALTHY',
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
      throw new PairingError(
        `فشل بدء عملية الربط: ${safeErr.userMessage}`,
        sanitizedTechnicalReason
      );
    } finally {
      this.activePairingLocks.delete(sessionId);
      this.activePhonePairingLocks.delete(normalized.digits);
    }
  }

  private handleDriverStatusUpdate(
    sessionId: string,
    generation: number,
    evt: {
      status:
        | 'CONNECTING'
        | 'AWAITING_PAIRING'
        | 'AUTHENTICATING'
        | 'AUTHENTICATED'
        | 'CONNECTED'
        | 'DISCONNECTED'
        | 'RESTART_REQUIRED'
        | 'LOGGED_OUT';
      jid?: string;
      statusCode?: number;
      errorMessage?: string;
      isRegistered?: boolean;
    }
  ): void {
    if (this.isShuttingDown) return;

    // Ignore late/stale events emitted by older socket instances
    if (!this.isCurrentGeneration(sessionId, generation)) {
      log.debug('Ignoring stale socket event from older generation', {
        sessionId,
        eventGeneration: generation,
        currentGeneration: this.getConnectionGeneration(sessionId),
        eventStatus: evt.status,
      });
      return;
    }

    const current = this.sessionRepo.findById(sessionId);
    if (!current) return;

    if (evt.status === 'CONNECTING') {
      if (
        current.status !== 'PAIRING_PENDING' &&
        current.status !== 'WAITING_FOR_PAIRING' &&
        current.status !== 'RECONNECTING' &&
        current.status !== 'AUTHENTICATING'
      ) {
        this.sessionRepo.updateStatus({
          id: sessionId,
          status: 'CONNECTING',
          lastError: null,
        });
      }
      return;
    }

    if (evt.status === 'AWAITING_PAIRING') {
      if (current.status === 'CONNECTING' || current.status === 'INITIALIZING') {
        this.sessionRepo.updateStatus({
          id: sessionId,
          status: 'PAIRING_PENDING',
          lastError: null,
        });
      }
      return;
    }

    if (evt.status === 'AUTHENTICATING') {
      this.clearPairingTimer(sessionId);
      this.clearReconnectTimer(sessionId);
      const masked = evt.jid
        ? maskPhoneNumber(`+${evt.jid.split('@')[0]}`)
        : current.masked_phone;
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'AUTHENTICATING',
        jid: evt.jid ?? current.jid,
        maskedPhone: masked,
        lastError: null,
      });
      log.info('Session pairing accepted on phone; authenticating session', {
        sessionId,
        generation,
      });
      return;
    }

    if (evt.status === 'CONNECTED' || evt.status === 'AUTHENTICATED') {
      const driver = this.drivers.get(sessionId);
      const diag = driver?.getSocketDiagnostics();
      if (!driver || !diag?.socketActive || !diag?.registered) {
        log.warn(
          'Refused to mark session CONNECTED because driver socket or registration is not verified',
          {
            sessionId,
            generation,
            socketActive: diag?.socketActive ?? false,
            registered: diag?.registered ?? false,
          }
        );
        return;
      }

      this.clearPairingTimer(sessionId);
      this.clearReconnectTimer(sessionId);
      const masked = evt.jid
        ? maskPhoneNumber(`+${evt.jid.split('@')[0]}`)
        : current.masked_phone;

      if (driver instanceof MockWhatsAppSessionDriver) {
        this.sessionStore.writeMockAuthMarker(
          sessionId,
          masked || '+966*****0000',
          true
        );
      }

      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'CONNECTED',
        jid: evt.jid ?? current.jid,
        maskedPhone: masked,
        reconnectAttempts: 0,
        lastDisconnectCode: null,
        lastDisconnectReason: null,
        healthStatus: 'HEALTHY',
        lastActivityAt: new Date().toISOString(),
        lastError: null,
      });
      log.info('Session connected and authenticated', { sessionId, generation });
      return;
    }

    if (evt.status === 'RESTART_REQUIRED') {
      // athanasia-baileys emits DisconnectReason.restartRequired (515) immediately after
      // pairing finishes (`companion_finish` / `pair-success`). Reconnect immediately with the saved credentials.
      this.clearPairingTimer(sessionId);
      this.clearReconnectTimer(sessionId);
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'AUTHENTICATING',
        lastDisconnectCode: evt.statusCode ?? 515,
        lastDisconnectReason: 'RESTART_REQUIRED',
        lastError: null,
      });
      void this.restartAfterPairing(sessionId).catch((err) => {
        log.warn('Immediate restart after pairing failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    if (evt.status === 'LOGGED_OUT') {
      this.clearPairingTimer(sessionId);
      this.clearReconnectTimer(sessionId);
      const driver = this.drivers.get(sessionId);
      this.drivers.delete(sessionId);
      if (driver) {
        void driver.disconnect().catch(() => undefined);
      }
      this.sessionStore.removeSessionAuthDir(sessionId);
      const reasonAr = evt.errorMessage || 'تم تسجيل الخروج أو إلغاء صلاحية الجلسة.';
      const updated = this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'LOGGED_OUT',
        reconnectAttempts: 0,
        lastDisconnectCode: evt.statusCode ?? 401,
        lastDisconnectReason: 'LOGGED_OUT',
        healthStatus: 'UNHEALTHY',
        lastError: reasonAr,
      });
      log.warn('Session logged out and local credentials purged', {
        sessionId,
        generation,
      });
      if (updated) {
        this.onDisconnectAlert?.({
          session: updated,
          newStatus: 'LOGGED_OUT',
          reasonAr,
        });
      }
      return;
    }

    if (evt.status === 'DISCONNECTED') {
      this.clearPairingTimer(sessionId);

      const hasRegisteredCreds =
        Boolean(evt.isRegistered) ||
        this.sessionStore.hasRegisteredCredentials(sessionId);
      const classification = classifyDisconnectReason(
        evt.statusCode,
        hasRegisteredCreds,
        evt.errorMessage
      );

      // CRITICAL: If the session was in PAIRING_PENDING (or never completed pairing/authentication),
      // DO NOT schedule background reconnects! Clean up and mark FAILED.
      if (
        current.status === 'PAIRING_PENDING' ||
        current.status === 'WAITING_FOR_PAIRING' ||
        !hasRegisteredCreds
      ) {
        const driver = this.drivers.get(sessionId);
        this.drivers.delete(sessionId);
        if (driver) {
          void driver.disconnect().catch(() => undefined);
        }
        this.sessionStore.resetUnregisteredAuthDir(sessionId, false);
        this.sessionRepo.updateStatus({
          id: sessionId,
          status:
            current.status === 'PAIRING_PENDING' ||
            current.status === 'WAITING_FOR_PAIRING' ||
            current.status === 'AUTHENTICATING' ||
            current.status === 'CONNECTING'
              ? 'FAILED'
              : 'DISCONNECTED',
          lastDisconnectCode: evt.statusCode ?? null,
          lastDisconnectReason: classification.category,
          healthStatus: 'UNHEALTHY',
          lastError:
            evt.errorMessage ||
            classification.arabicMessage ||
            'انقطع اتصال مقبس واتساب قبل إتمام عملية الربط والمصادقة.',
        });
        log.warn('Unauthenticated session disconnected; skipping auto-reconnect', {
          sessionId,
          generation,
          previousStatus: current.status,
          statusCode: evt.statusCode,
          category: classification.category,
        });
        return;
      }

      // If an already-registered session encounters a conflict/replacement (440),
      // forbidden (403), or multidevice mismatch (411), transition to REQUIRES_REPAIR
      // and DO NOT auto-reconnect in a loop (prevents ping-pong hijack loops).
      if (classification.requiresRepair) {
        const driver = this.drivers.get(sessionId);
        this.drivers.delete(sessionId);
        if (driver) {
          void driver.disconnect().catch(() => undefined);
        }
        this.clearReconnectTimer(sessionId);
        const reasonAr = evt.errorMessage || classification.arabicMessage;
        const updated = this.sessionRepo.updateStatus({
          id: sessionId,
          status: 'REQUIRES_REPAIR',
          lastDisconnectCode: evt.statusCode ?? null,
          lastDisconnectReason: classification.category,
          healthStatus: 'UNHEALTHY',
          lastError: reasonAr,
        });
        log.warn('Registered session requires manual repair; auto-reconnect disabled', {
          sessionId,
          generation,
          statusCode: evt.statusCode,
          category: classification.category,
        });
        if (updated) {
          this.onDisconnectAlert?.({
            session: updated,
            newStatus: 'REQUIRES_REPAIR',
            reasonAr,
          });
        }
        return;
      }

      const reasonAr =
        evt.errorMessage || classification.arabicMessage || 'انقطع الاتصال مؤقتاً.';
      const updated = this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'DISCONNECTED',
        lastDisconnectCode: evt.statusCode ?? null,
        lastDisconnectReason: classification.category,
        healthStatus: 'DEGRADED',
        lastError: reasonAr,
      });
      if (updated) {
        this.onDisconnectAlert?.({
          session: updated,
          newStatus: 'DISCONNECTED',
          reasonAr,
        });
      }
      this.scheduleBoundedReconnect(sessionId);
    }
  }

  private async restartAfterPairing(sessionId: string): Promise<void> {
    if (this.isShuttingDown) return;
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return;

    await this.cleanupExistingDriver(sessionId);
    const generation = this.nextGeneration(sessionId);
    const authDir = this.sessionStore.prepareSessionAuthDir(sessionId);
    const driver = this.driverFactory(sessionId, authDir);
    if (driver instanceof MockWhatsAppSessionDriver) {
      driver.markRegistered(session.jid || undefined);
    }
    this.drivers.set(sessionId, driver);

    await driver.connect({
      onStatusChange: (evt) =>
        this.handleDriverStatusUpdate(sessionId, generation, evt),
    });
  }

  /**
   * Schedules a bounded exponential backoff reconnection with jitter.
   * Only runs for previously authenticated sessions (`hasRegisteredCredentials === true`).
   * Prevents duplicate reconnect loops for the same session.
   */
  private scheduleBoundedReconnect(sessionId: string): void {
    if (this.isShuttingDown || this.reconnectTimers.has(sessionId)) {
      return;
    }

    const session = this.sessionRepo.findById(sessionId);
    if (
      !session ||
      session.status === 'LOGGED_OUT' ||
      session.status === 'STOPPED' ||
      session.status === 'STOPPING' ||
      session.status === 'REQUIRES_REPAIR' ||
      session.status === 'PAIRING_PENDING' ||
      session.status === 'WAITING_FOR_PAIRING'
    ) {
      return;
    }

    if (!this.sessionStore.hasRegisteredCredentials(sessionId)) {
      return;
    }

    const nextAttempt = session.reconnect_attempts + 1;
    if (nextAttempt > this.maxReconnectAttempts) {
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'FAILED',
        healthStatus: 'DEGRADED',
        lastError: `تم تجاوز الحد الأقصى لمحاولات إعادة الاتصال (${this.maxReconnectAttempts}).`,
      });
      return;
    }

    const delayMs = calculateBackoffDelay(nextAttempt, {
      baseDelayMs: this.reconnectBaseDelayMs,
      maxDelayMs: this.reconnectMaxDelayMs,
    });

    this.sessionRepo.updateStatus({
      id: sessionId,
      status: 'RECONNECTING',
      healthStatus: 'DEGRADED',
      reconnectAttempts: nextAttempt,
    });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      void this.reconnectSession(sessionId).catch((err) => {
        log.warn('Scheduled reconnect failed', {
          sessionId,
          attempt: nextAttempt,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.reconnectTimers.set(sessionId, timer);
  }

  /**
   * Restores previously authenticated sessions from isolated storage on application startup.
   * Never marks a session `CONNECTED` merely from loading SQLite rows; status only becomes
   * `CONNECTED` when the driver emits `CONNECTED` after verifying live authentication.
   */
  public async restoreSessionsOnStartup(): Promise<StartupRestorationSummary> {
    const allSessions = this.sessionRepo.listAll();
    let restoredCount = 0;
    let skippedCount = 0;
    let repairedFromBackupCount = 0;
    let unregisteredSkippedCount = 0;
    let corruptedCount = 0;
    let stoppedOrLoggedOutSkippedCount = 0;

    for (const session of allSessions) {
      if (
        session.status === 'LOGGED_OUT' ||
        session.status === 'STOPPED' ||
        session.status === 'REQUIRES_REPAIR'
      ) {
        skippedCount++;
        stoppedOrLoggedOutSkippedCount++;
        continue;
      }

      const credInfo = this.sessionStore.inspectCredentials(session.id);
      if (credInfo.recoveredFromBackup) {
        repairedFromBackupCount++;
      }

      if (credInfo.corrupted) {
        this.sessionRepo.updateStatus({
          id: session.id,
          status: 'FAILED',
          healthStatus: 'UNHEALTHY',
          lastDisconnectReason: 'CORRUPTED_CREDENTIALS',
          lastError:
            credInfo.errorReason ||
            'ملف بيانات المصادقة المحفوظ تالف ولا يمكن استعادته.',
        });
        skippedCount++;
        corruptedCount++;
        continue;
      }

      if (!credInfo.registered) {
        this.sessionRepo.updateStatus({
          id: session.id,
          status: 'DISCONNECTED',
          healthStatus: 'UNKNOWN',
          lastError:
            session.status === 'PAIRING_PENDING' ||
            session.status === 'WAITING_FOR_PAIRING'
              ? 'انتهت عملية الربط السابقة قبل اكتمال المصادقة.'
              : 'لم يتم العثور على بيانات مصادقة مكتملة عند بدء التشغيل.',
        });
        skippedCount++;
        unregisteredSkippedCount++;
        continue;
      }

      try {
        await this.cleanupExistingDriver(session.id);
        const generation = this.nextGeneration(session.id);
        this.sessionRepo.updateStatus({
          id: session.id,
          status: 'RECOVERING',
          healthStatus: 'DEGRADED',
          reconnectAttempts: 0,
          lastError: null,
        });

        const driver = this.driverFactory(session.id, session.auth_dir);
        if (driver instanceof MockWhatsAppSessionDriver) {
          driver.markRegistered(session.jid || credInfo.meJid || undefined);
        }
        this.drivers.set(session.id, driver);

        await driver.connect({
          onStatusChange: (evt) =>
            this.handleDriverStatusUpdate(session.id, generation, evt),
        });
        restoredCount++;
      } catch (err) {
        this.sessionRepo.updateStatus({
          id: session.id,
          status: 'DISCONNECTED',
          healthStatus: 'DEGRADED',
          lastError:
            err instanceof Error ? err.message : 'فشلت استعادة الجلسة تلقائياً.',
        });
        skippedCount++;
      }
    }

    log.info('Completed startup session restoration', {
      restoredCount,
      skippedCount,
      repairedFromBackupCount,
      unregisteredSkippedCount,
      corruptedCount,
      stoppedOrLoggedOutSkippedCount,
    });
    return {
      restoredCount,
      skippedCount,
      repairedFromBackupCount,
      unregisteredSkippedCount,
      corruptedCount,
      stoppedOrLoggedOutSkippedCount,
    };
  }

  /**
   * Reconnects an existing session that has valid registered credentials.
   * Never fabricates a `CONNECTED` status before the driver actually opens and authenticates.
   */
  public async reconnectSession(
    sessionId: string,
    actorTelegramId = 0
  ): Promise<SessionRecord> {
    const session = this.assertSessionAccess(sessionId, actorTelegramId);

    this.clearReconnectTimer(sessionId);
    this.clearPairingTimer(sessionId);

    const credInfo = this.sessionStore.inspectCredentials(sessionId);
    if (credInfo.corrupted) {
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'FAILED',
        healthStatus: 'UNHEALTHY',
        lastDisconnectReason: 'CORRUPTED_CREDENTIALS',
        lastError:
          credInfo.errorReason || 'ملف بيانات المصادقة تالف. يرجى إعادة ربط الجلسة.',
      });
      throw new WhatsAppConnectionError(
        credInfo.errorReason || 'ملف بيانات المصادقة تالف. يرجى إعادة ربط الجلسة.'
      );
    }

    if (!credInfo.registered) {
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'DISCONNECTED',
        healthStatus: 'UNKNOWN',
        lastError:
          'لا توجد بيانات مصادقة مكتملة لهذه الجلسة. يرجى استخدام خيار "إعادة الربط برقم هاتف".',
      });
      throw new WhatsAppConnectionError(
        'لا يمكن إعادة الاتصال بجلسة لم تكمل عملية الربط والمصادقة. يرجى استخدام خيار "إعادة الربط برقم هاتف" أولاً.'
      );
    }

    await this.cleanupExistingDriver(sessionId);
    const generation = this.nextGeneration(sessionId);
    const authDir = this.sessionStore.prepareSessionAuthDir(sessionId);

    // Transition to RECONNECTING while keeping the current reconnect_attempts count
    // (`reconnectAttempts` is only reset to 0 when the socket genuinely emits `CONNECTED`).
    this.sessionRepo.updateStatus({
      id: sessionId,
      status: 'RECONNECTING',
      healthStatus: 'DEGRADED',
      lastError: null,
    });

    const driver = this.driverFactory(sessionId, authDir);
    if (driver instanceof MockWhatsAppSessionDriver) {
      driver.markRegistered(session.jid || credInfo.meJid || undefined);
    }
    this.drivers.set(sessionId, driver);

    try {
      await driver.connect({
        onStatusChange: (evt) =>
          this.handleDriverStatusUpdate(sessionId, generation, evt),
      });
    } catch (err) {
      await this.cleanupExistingDriver(sessionId);
      const safeErr = toSafeArabicError(err);
      this.sessionRepo.updateStatus({
        id: sessionId,
        status: 'DISCONNECTED',
        healthStatus: 'DEGRADED',
        lastError: safeErr.userMessage,
      });
      this.scheduleBoundedReconnect(sessionId);
      throw err;
    }

    if (actorTelegramId > 0) {
      this.auditRepo.record({
        actorTelegramId,
        action: 'SESSION_RECONNECTED',
        targetId: sessionId,
        outcome: 'SUCCESS',
        metadata: { generation },
      });
    }

    return this.getSession(sessionId)!;
  }

  public async disconnectSession(
    sessionId: string,
    actorTelegramId = 0
  ): Promise<SessionRecord> {
    this.assertSessionAccess(sessionId, actorTelegramId);

    this.clearReconnectTimer(sessionId);
    this.clearPairingTimer(sessionId);
    await this.cleanupExistingDriver(sessionId);

    const updated = this.sessionRepo.updateStatus({
      id: sessionId,
      status: 'DISCONNECTED',
      reconnectAttempts: 0,
      healthStatus: 'UNKNOWN',
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
    this.assertSessionAccess(sessionId, actorTelegramId);

    this.clearReconnectTimer(sessionId);
    this.clearPairingTimer(sessionId);
    this.nextGeneration(sessionId);

    const driver = this.drivers.get(sessionId);
    if (driver) {
      this.drivers.delete(sessionId);
      try {
        await driver.logout();
      } catch {
        // Ignore logout errors on removal
      }
    }

    this.connectionGenerations.delete(sessionId);
    this.sessionStore.removeSessionAuthDir(sessionId);
    this.sessionRepo.deleteById(sessionId);

    this.auditRepo.record({
      actorTelegramId,
      action: 'SESSION_REMOVED',
      targetId: sessionId,
      outcome: 'SUCCESS',
    });
  }

  /**
   * Evaluates multidimensional health of a session combining socket state,
   * credential integrity, reconnect attempts, and disconnect history.
   */
  public evaluateSessionHealth(
    session: SessionRecord,
    socketDiagnostics: SessionSocketDiagnostics,
    credentialInfo: CredentialInspectionResult
  ): SessionHealthReport {
    const issues: string[] = [];
    let score = 100;

    if (credentialInfo.corrupted) {
      issues.push('ملف بيانات المصادقة تالف');
      score -= 80;
    } else if (!credentialInfo.registered) {
      issues.push('لم تكتمل مصادقة الجهاز بعد');
      score -= 40;
    }

    if (session.status === 'REQUIRES_REPAIR') {
      issues.push('الجلسة تتطلب إعادة ربط يدوي بسبب تعارض أو رفض بروتوكول');
      score -= 70;
    } else if (session.status === 'LOGGED_OUT') {
      issues.push('تم تسجيل الخروج من الهاتف');
      score -= 80;
    } else if (session.status === 'FAILED') {
      issues.push('فشل آخر محاولة اتصال أو ربط');
      score -= 60;
    } else if (
      session.status === 'CONNECTED' ||
      session.status === 'AUTHENTICATED'
    ) {
      if (!socketDiagnostics.socketActive || !socketDiagnostics.wsOpen) {
        issues.push('مقبس WebSocket غير نشط رغم حالة الاتصال');
        score -= 50;
      }
    } else if (
      session.status === 'RECONNECTING' ||
      session.status === 'RECOVERING'
    ) {
      issues.push(`جاري استعادة الاتصال (محاولة ${session.reconnect_attempts})`);
      score -= 25;
    } else if (session.status === 'DISCONNECTED') {
      issues.push('الجلسة غير متصلة حالياً');
      score -= 30;
    }

    if (session.reconnect_attempts > 0) {
      score -= Math.min(20, session.reconnect_attempts * 5);
    }

    score = Math.max(0, Math.min(100, score));

    let status: SessionHealthStatus = 'UNKNOWN';
    if (
      (session.status === 'CONNECTED' || session.status === 'AUTHENTICATED') &&
      socketDiagnostics.socketActive &&
      credentialInfo.registered &&
      score >= 80
    ) {
      status = 'HEALTHY';
    } else if (
      session.status === 'REQUIRES_REPAIR' ||
      session.status === 'LOGGED_OUT' ||
      session.status === 'FAILED' ||
      credentialInfo.corrupted
    ) {
      status = 'UNHEALTHY';
    } else if (credentialInfo.registered) {
      status = 'DEGRADED';
    }

    return {
      status,
      score,
      issues,
      lastActivityAt: session.last_activity_at ?? null,
    };
  }

  /**
   * Pure read-only reconciliation between persisted SQLite metadata and live in-memory socket state.
   * Never creates a socket, never initiates a connection, and never schedules reconnect timers.
   * Prevents stale SQLite statuses (`CONNECTED`, `PAIRING_PENDING`, `RECONNECTING`) from being
   * reported as active when no live socket or timer exists in runtime memory.
   */
  private reconcileSessionRecord(record: SessionRecord): SessionRecord {
    const driver = this.drivers.get(record.id);
    const diag = driver?.getSocketDiagnostics();
    const hasReconnectTimer = this.reconnectTimers.has(record.id);
    const hasPairingTimer = this.pairingTimers.has(record.id);

    if (record.status === 'CONNECTED' || record.status === 'AUTHENTICATED') {
      const isTrulyConnected = Boolean(
        driver && diag?.socketActive && diag?.registered
      );
      if (!isTrulyConnected) {
        const reconciled = this.sessionRepo.updateStatus({
          id: record.id,
          status: hasReconnectTimer ? 'RECONNECTING' : 'DISCONNECTED',
          healthStatus: 'DEGRADED',
          lastError:
            record.last_error ||
            'لا يوجد اتصال مقبس حي نشط حالياً لهذه الجلسة.',
        });
        return reconciled ?? { ...record, status: 'DISCONNECTED' };
      }
      return record;
    }

    if (
      record.status === 'PAIRING_PENDING' ||
      record.status === 'WAITING_FOR_PAIRING' ||
      record.status === 'CONNECTING' ||
      record.status === 'AUTHENTICATING'
    ) {
      const isHandshakeOrPairingAlive = Boolean(
        (driver && diag?.socketActive) ||
          hasPairingTimer ||
          this.activePairingLocks.has(record.id)
      );
      if (!isHandshakeOrPairingAlive) {
        const reconciled = this.sessionRepo.updateStatus({
          id: record.id,
          status: 'DISCONNECTED',
          lastError:
            record.last_error ||
            'انتهت جلسة الاقتران أو الاتصال المؤقت دون اكتمال المصادقة.',
        });
        return reconciled ?? { ...record, status: 'DISCONNECTED' };
      }
      return record;
    }

    if (record.status === 'RECONNECTING' || record.status === 'RECOVERING') {
      const isReconnectAlive = Boolean(
        (driver && diag?.socketActive) || hasReconnectTimer
      );
      if (!isReconnectAlive) {
        const reconciled = this.sessionRepo.updateStatus({
          id: record.id,
          status: 'DISCONNECTED',
          lastError:
            record.last_error || 'توقفت عملية إعادة الاتصال لعدم وجود مقبس نشط.',
        });
        return reconciled ?? { ...record, status: 'DISCONNECTED' };
      }
      return record;
    }

    return record;
  }

  /**
   * Returns a full read-only diagnostic snapshot of a session combining SQLite metadata,
   * live socket state, credential inspection, and timer states without any side effects.
   */
  public getLiveVerification(
    sessionId: string,
    actorTelegramId?: number
  ): LiveSessionVerification | undefined {
    const raw = this.sessionRepo.findById(sessionId);
    if (!raw) return undefined;
    if (!this.canAccessSession(raw, actorTelegramId)) {
      return undefined;
    }

    const session = this.reconcileSessionRecord(raw);
    const driver = this.drivers.get(sessionId);
    const socketDiagnostics: SessionSocketDiagnostics = driver
      ? driver.getSocketDiagnostics()
      : {
          socketActive: false,
          registered: false,
          wsOpen: false,
          handshakeReady: false,
          connectionState: 'CLOSED',
          platform: 'Unavailable',
          device: 'Unavailable',
          chatsCount: 0,
          contactsCount: 0,
          cachedMessagesCount: 0,
        };
    const credentialInfo = this.sessionStore.inspectCredentials(sessionId);
    const isLiveConnected = Boolean(
      (session.status === 'CONNECTED' || session.status === 'AUTHENTICATED') &&
        driver &&
        socketDiagnostics.socketActive &&
        socketDiagnostics.registered
    );
    const health = this.evaluateSessionHealth(
      session,
      socketDiagnostics,
      credentialInfo
    );

    return {
      session,
      isLiveConnected,
      connectionGeneration: this.getConnectionGeneration(sessionId),
      hasActiveDriver: Boolean(driver),
      hasReconnectTimer: this.reconnectTimers.has(sessionId),
      hasPairingTimer: this.pairingTimers.has(sessionId),
      socketDiagnostics,
      credentialInfo,
      health,
    };
  }

  public getDriver(sessionId: string, actorTelegramId?: number): WhatsAppSessionDriver {
    const verification = this.getLiveVerification(sessionId, actorTelegramId);
    if (!verification) {
      const raw = this.sessionRepo.findById(sessionId);
      if (raw && !this.canAccessSession(raw, actorTelegramId)) {
        throw new AuthorizationError('⛔ غير مصرح لك بالوصول إلى هذه الجلسة أو إدارتها.');
      }
      throw new WhatsAppConnectionError(
        `الجلسة (${sessionId}) غير مسجلة في النظام.`
      );
    }
    const { session, isLiveConnected } = verification;
    if (!isLiveConnected) {
      throw new WhatsAppConnectionError(
        `الجلسة (${session.label}) غير متصلة حالياً بمقبس واتساب موثق (الحالة الفعلية: ${session.status}).`
      );
    }
    const driver = this.drivers.get(sessionId);
    if (!driver) {
      throw new WhatsAppConnectionError(
        `لم يتم العثور على قناة اتصال نشطة للجلسة (${session.label}). يرجى إعادة الاتصال أولاً.`
      );
    }
    this.sessionRepo.recordActivity(sessionId);
    return driver;
  }

  public listSessions(actorTelegramId?: number): SessionRecord[] {
    const all = this.sessionRepo
      .listAll()
      .map((record) => this.reconcileSessionRecord(record));
    if (this.isOwner(actorTelegramId)) {
      return all;
    }
    return all.filter((s) => (s.owner_telegram_id ?? 0) === actorTelegramId);
  }

  public listConnectedSessions(actorTelegramId?: number): SessionRecord[] {
    return this.listSessions(actorTelegramId).filter(
      (s) => s.status === 'CONNECTED' || s.status === 'AUTHENTICATED'
    );
  }

  public getSession(sessionId: string, actorTelegramId?: number): SessionRecord | undefined {
    const raw = this.sessionRepo.findById(sessionId);
    if (!raw) return undefined;
    if (!this.canAccessSession(raw, actorTelegramId)) {
      return undefined;
    }
    return this.reconcileSessionRecord(raw);
  }

  public renameSession(
    sessionId: string,
    newLabel: string,
    actorTelegramId: number
  ): SessionRecord {
    this.assertSessionAccess(sessionId, actorTelegramId);
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
    return this.reconcileSessionRecord(updated);
  }

  public async shutdownAll(): Promise<void> {
    this.isShuttingDown = true;
    for (const sessionId of this.reconnectTimers.keys()) {
      this.clearReconnectTimer(sessionId);
    }
    for (const sessionId of this.pairingTimers.keys()) {
      this.clearPairingTimer(sessionId);
    }
    for (const [sessionId, driver] of this.drivers.entries()) {
      this.nextGeneration(sessionId);
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
