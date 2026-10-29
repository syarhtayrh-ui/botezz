import crypto from 'node:crypto';
import { AppDatabase } from '../database';
import { redactString, redactObject, maskPhoneNumber } from '../../security/redaction';

export type FunctionFailureCategory =
  | 'PARSING_ERROR'
  | 'VALIDATION_ERROR'
  | 'RUNTIME_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_ERROR'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT_ERROR'
  | 'RATE_LIMIT_ERROR';

export type FunctionExecutionMode = 'LIVE' | 'DRY_RUN' | 'SIMULATION';

export interface StoredFunctionDefinition {
  functionId: string;
  name: string;
  version: number;
  category: string;
  descriptionAr: string;
  sourceCode: string;
  inputSchemaJson: string;
  requiredDependencies: string[];
  supportsDryRun: boolean;
  supportsSimulation: boolean;
  isBuiltin: boolean;
  isEnabled: boolean;
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredFunctionExecution {
  executionId: string;
  correlationId: string;
  functionId: string;
  functionName: string;
  functionVersion: number;
  telegramUserId: number;
  sessionId?: string;
  executionMode: FunctionExecutionMode;
  scenarioId?: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
  failureCategory?: FunctionFailureCategory;
  durationMs: number;
  argsPreviewRedacted: string;
  resultSummaryRedacted?: string;
  errorMessageAr?: string;
  diagnosticJsonRedacted?: string;
  createdAt: string;
}

export type DeliveryTrackingState =
  | 'queued'
  | 'submitted'
  | 'acknowledged'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'unknown';

export interface StoredMessageOutcome {
  outcomeId: string;
  correlationId: string;
  sessionId: string;
  direction: 'INCOMING' | 'OUTGOING';
  messageId?: string;
  remoteJidRedacted: string;
  detectedType: string;
  wrapperType?: string;
  isEphemeral: boolean;
  isViewOnce: boolean;
  isStatusBroadcast: boolean;
  deliveryState: DeliveryTrackingState;
  capabilitySupported: boolean;
  retryCount: number;
  durationMs: number;
  errorCategory?: FunctionFailureCategory;
  errorReasonRedacted?: string;
  createdAt: string;
}

interface RawFunctionDefinitionRow {
  function_id: string;
  name: string;
  version: number;
  category: string;
  description_ar: string;
  source_code: string;
  input_schema_json: string;
  required_dependencies_json: string;
  supports_dry_run: number;
  supports_simulation: number;
  is_builtin: number;
  is_enabled: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

interface RawFunctionExecutionRow {
  execution_id: string;
  correlation_id: string;
  function_id: string;
  function_name: string;
  function_version: number;
  telegram_user_id: number;
  session_id: string | null;
  execution_mode: string;
  scenario_id: string | null;
  status: string;
  failure_category: string | null;
  duration_ms: number;
  args_preview_redacted: string;
  result_summary_redacted: string | null;
  error_message_ar: string | null;
  diagnostic_json_redacted: string | null;
  created_at: string;
}

interface RawMessageOutcomeRow {
  outcome_id: string;
  correlation_id: string;
  session_id: string;
  direction: string;
  message_id: string | null;
  remote_jid_redacted: string;
  detected_type: string;
  wrapper_type: string | null;
  is_ephemeral: number;
  is_view_once: number;
  is_status_broadcast: number;
  delivery_state: string;
  capability_supported: number;
  retry_count: number;
  duration_ms: number;
  error_category: string | null;
  error_reason_redacted: string | null;
  created_at: string;
}

function redactJid(jid: string): string {
  if (!jid) return 'unknown';
  if (jid === 'status@broadcast') return 'status@broadcast';
  const [userPart, domainPart] = jid.split('@');
  if (!domainPart) return redactString(jid);
  if (/^\d{7,15}$/.test(userPart)) {
    return `${maskPhoneNumber(userPart)}@${domainPart}`;
  }
  return `${userPart.slice(0, 6)}***@${domainPart}`;
}

export class FunctionLabRepository {
  private readonly maxExecutionHistoryCount: number;
  private readonly maxMessageOutcomesCount: number;

  constructor(
    private readonly db: AppDatabase,
    options?: { maxExecutionHistoryCount?: number; maxMessageOutcomesCount?: number }
  ) {
    this.maxExecutionHistoryCount = options?.maxExecutionHistoryCount ?? 500;
    this.maxMessageOutcomesCount = options?.maxMessageOutcomesCount ?? 1000;
  }

  private mapDefinitionRow(row: RawFunctionDefinitionRow): StoredFunctionDefinition {
    let requiredDependencies: string[] = [];
    try {
      const parsed = JSON.parse(row.required_dependencies_json);
      if (Array.isArray(parsed)) {
        requiredDependencies = parsed.map(String);
      }
    } catch {
      requiredDependencies = [];
    }

    return {
      functionId: row.function_id,
      name: row.name,
      version: row.version,
      category: row.category,
      descriptionAr: row.description_ar,
      sourceCode: row.source_code,
      inputSchemaJson: row.input_schema_json,
      requiredDependencies,
      supportsDryRun: row.supports_dry_run === 1,
      supportsSimulation: row.supports_simulation === 1,
      isBuiltin: row.is_builtin === 1,
      isEnabled: row.is_enabled === 1,
      createdBy: row.created_by ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapExecutionRow(row: RawFunctionExecutionRow): StoredFunctionExecution {
    return {
      executionId: row.execution_id,
      correlationId: row.correlation_id,
      functionId: row.function_id,
      functionName: row.function_name,
      functionVersion: row.function_version,
      telegramUserId: row.telegram_user_id,
      sessionId: row.session_id ?? undefined,
      executionMode: row.execution_mode as FunctionExecutionMode,
      scenarioId: row.scenario_id ?? undefined,
      status: row.status as StoredFunctionExecution['status'],
      failureCategory: (row.failure_category ?? undefined) as
        | FunctionFailureCategory
        | undefined,
      durationMs: row.duration_ms,
      argsPreviewRedacted: row.args_preview_redacted,
      resultSummaryRedacted: row.result_summary_redacted ?? undefined,
      errorMessageAr: row.error_message_ar ?? undefined,
      diagnosticJsonRedacted: row.diagnostic_json_redacted ?? undefined,
      createdAt: row.created_at,
    };
  }

  private mapMessageOutcomeRow(row: RawMessageOutcomeRow): StoredMessageOutcome {
    return {
      outcomeId: row.outcome_id,
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      direction: row.direction as 'INCOMING' | 'OUTGOING',
      messageId: row.message_id ?? undefined,
      remoteJidRedacted: row.remote_jid_redacted,
      detectedType: row.detected_type,
      wrapperType: row.wrapper_type ?? undefined,
      isEphemeral: row.is_ephemeral === 1,
      isViewOnce: row.is_view_once === 1,
      isStatusBroadcast: row.is_status_broadcast === 1,
      deliveryState: row.delivery_state as DeliveryTrackingState,
      capabilitySupported: row.capability_supported === 1,
      retryCount: row.retry_count,
      durationMs: row.duration_ms,
      errorCategory: (row.error_category ?? undefined) as
        | FunctionFailureCategory
        | undefined,
      errorReasonRedacted: row.error_reason_redacted ?? undefined,
      createdAt: row.created_at,
    };
  }

  public upsertFunctionDefinition(params: {
    functionId?: string;
    name: string;
    category: string;
    descriptionAr: string;
    sourceCode: string;
    inputSchema?: Record<string, unknown>;
    requiredDependencies?: string[];
    supportsDryRun?: boolean;
    supportsSimulation?: boolean;
    isBuiltin?: boolean;
    isEnabled?: boolean;
    createdBy?: number;
    allowUpdateExisting?: boolean;
  }): StoredFunctionDefinition {
    const existing = this.getFunctionByName(params.name);
    const now = new Date().toISOString();

    if (existing) {
      if (params.allowUpdateExisting === false) {
        return existing;
      }
      const nextVersion =
        existing.sourceCode.trim() !== params.sourceCode.trim()
          ? existing.version + 1
          : existing.version;
      const stmt = this.db.sqlite.prepare(`
        UPDATE function_definitions
        SET version = ?,
            category = ?,
            description_ar = ?,
            source_code = ?,
            input_schema_json = ?,
            required_dependencies_json = ?,
            supports_dry_run = ?,
            supports_simulation = ?,
            is_enabled = ?,
            updated_at = ?
        WHERE function_id = ?
      `);
      stmt.run(
        nextVersion,
        params.category,
        params.descriptionAr,
        params.sourceCode,
        JSON.stringify(params.inputSchema || {}),
        JSON.stringify(params.requiredDependencies || []),
        params.supportsDryRun === false ? 0 : 1,
        params.supportsSimulation === false ? 0 : 1,
        params.isEnabled === false ? 0 : 1,
        now,
        existing.functionId
      );
      return this.getFunctionById(existing.functionId)!;
    }

    const functionId =
      params.functionId ||
      `fn_${params.name.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()}_${crypto
        .randomBytes(3)
        .toString('hex')}`;
    const insertStmt = this.db.sqlite.prepare(`
      INSERT INTO function_definitions (
        function_id, name, version, category, description_ar, source_code,
        input_schema_json, required_dependencies_json, supports_dry_run,
        supports_simulation, is_builtin, is_enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      functionId,
      params.name,
      params.category,
      params.descriptionAr,
      params.sourceCode,
      JSON.stringify(params.inputSchema || {}),
      JSON.stringify(params.requiredDependencies || []),
      params.supportsDryRun === false ? 0 : 1,
      params.supportsSimulation === false ? 0 : 1,
      params.isBuiltin ? 1 : 0,
      params.isEnabled === false ? 0 : 1,
      params.createdBy ?? null,
      now,
      now
    );

    return this.getFunctionById(functionId)!;
  }

  public getFunctionById(functionId: string): StoredFunctionDefinition | undefined {
    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM function_definitions WHERE function_id = ?'
    );
    const row = stmt.get(functionId) as RawFunctionDefinitionRow | undefined;
    return row ? this.mapDefinitionRow(row) : undefined;
  }

  public getFunctionByName(name: string): StoredFunctionDefinition | undefined {
    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM function_definitions WHERE LOWER(name) = LOWER(?)'
    );
    const row = stmt.get(name.trim()) as RawFunctionDefinitionRow | undefined;
    return row ? this.mapDefinitionRow(row) : undefined;
  }

  public listFunctions(filter?: {
    category?: string;
    searchQuery?: string;
    onlyEnabled?: boolean;
  }): StoredFunctionDefinition[] {
    let sql = 'SELECT * FROM function_definitions WHERE 1=1';
    const params: Array<string | number> = [];

    if (filter?.onlyEnabled) {
      sql += ' AND is_enabled = 1';
    }
    if (filter?.category && filter.category !== 'all') {
      sql += ' AND LOWER(category) = LOWER(?)';
      params.push(filter.category);
    }
    if (filter?.searchQuery && filter.searchQuery.trim()) {
      const q = `%${filter.searchQuery.trim()}%`;
      sql += ' AND (name LIKE ? OR description_ar LIKE ? OR category LIKE ?)';
      params.push(q, q, q);
    }

    sql += ' ORDER BY is_builtin DESC, name ASC';
    const stmt = this.db.sqlite.prepare(sql);
    const rows = stmt.all(...params) as unknown as RawFunctionDefinitionRow[];
    return rows.map((r) => this.mapDefinitionRow(r));
  }

  public recordExecution(params: {
    executionId?: string;
    correlationId: string;
    functionId: string;
    functionName: string;
    functionVersion?: number;
    telegramUserId: number;
    sessionId?: string;
    executionMode: FunctionExecutionMode;
    scenarioId?: string;
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
    failureCategory?: FunctionFailureCategory;
    durationMs: number;
    argsPreview?: Record<string, unknown>;
    resultSummary?: string;
    errorMessageAr?: string;
    diagnostics?: Record<string, unknown>;
  }): StoredFunctionExecution {
    const executionId =
      params.executionId || `exec_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    const safeArgs = JSON.stringify(redactObject(params.argsPreview || {}));
    const safeSummary = params.resultSummary
      ? redactString(params.resultSummary).slice(0, 500)
      : null;
    const safeError = params.errorMessageAr
      ? redactString(params.errorMessageAr).slice(0, 500)
      : null;
    const safeDiagnostics = params.diagnostics
      ? JSON.stringify(redactObject(params.diagnostics))
      : null;

    const stmt = this.db.sqlite.prepare(`
      INSERT INTO function_executions (
        execution_id, correlation_id, function_id, function_name, function_version,
        telegram_user_id, session_id, execution_mode, scenario_id, status,
        failure_category, duration_ms, args_preview_redacted, result_summary_redacted,
        error_message_ar, diagnostic_json_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      executionId,
      params.correlationId,
      params.functionId,
      params.functionName,
      params.functionVersion ?? 1,
      params.telegramUserId,
      params.sessionId ?? null,
      params.executionMode,
      params.scenarioId ?? null,
      params.status,
      params.failureCategory ?? null,
      Math.max(0, Math.round(params.durationMs)),
      safeArgs,
      safeSummary,
      safeError,
      safeDiagnostics,
      now
    );

    this.pruneOldRecords();
    return this.getExecutionById(executionId)!;
  }

  public getExecutionById(executionId: string): StoredFunctionExecution | undefined {
    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM function_executions WHERE execution_id = ?'
    );
    const row = stmt.get(executionId) as RawFunctionExecutionRow | undefined;
    return row ? this.mapExecutionRow(row) : undefined;
  }

  public getExecutionByCorrelationId(
    correlationId: string
  ): StoredFunctionExecution | undefined {
    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM function_executions WHERE correlation_id = ? ORDER BY created_at DESC LIMIT 1'
    );
    const row = stmt.get(correlationId) as RawFunctionExecutionRow | undefined;
    return row ? this.mapExecutionRow(row) : undefined;
  }

  public listRecentExecutions(options?: {
    functionId?: string;
    functionName?: string;
    limit?: number;
  }): StoredFunctionExecution[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 15, 100));
    if (options?.functionId) {
      const stmt = this.db.sqlite.prepare(
        'SELECT * FROM function_executions WHERE function_id = ? ORDER BY created_at DESC LIMIT ?'
      );
      const rows = stmt.all(
        options.functionId,
        limit
      ) as unknown as RawFunctionExecutionRow[];
      return rows.map((r) => this.mapExecutionRow(r));
    }
    if (options?.functionName) {
      const stmt = this.db.sqlite.prepare(
        'SELECT * FROM function_executions WHERE LOWER(function_name) = LOWER(?) ORDER BY created_at DESC LIMIT ?'
      );
      const rows = stmt.all(
        options.functionName,
        limit
      ) as unknown as RawFunctionExecutionRow[];
      return rows.map((r) => this.mapExecutionRow(r));
    }

    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM function_executions ORDER BY created_at DESC LIMIT ?'
    );
    const rows = stmt.all(limit) as unknown as RawFunctionExecutionRow[];
    return rows.map((r) => this.mapExecutionRow(r));
  }

  public recordMessageOutcome(params: {
    outcomeId?: string;
    correlationId: string;
    sessionId: string;
    direction: 'INCOMING' | 'OUTGOING';
    messageId?: string;
    remoteJid: string;
    detectedType: string;
    wrapperType?: string;
    isEphemeral?: boolean;
    isViewOnce?: boolean;
    isStatusBroadcast?: boolean;
    deliveryState: DeliveryTrackingState;
    capabilitySupported?: boolean;
    retryCount?: number;
    durationMs?: number;
    errorCategory?: FunctionFailureCategory;
    errorReason?: string;
  }): StoredMessageOutcome {
    const outcomeId =
      params.outcomeId || `msgout_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const redactedJid = redactJid(params.remoteJid);
    const safeError = params.errorReason
      ? redactString(params.errorReason).slice(0, 350)
      : null;

    const stmt = this.db.sqlite.prepare(`
      INSERT INTO message_processing_outcomes (
        outcome_id, correlation_id, session_id, direction, message_id,
        remote_jid_redacted, detected_type, wrapper_type, is_ephemeral,
        is_view_once, is_status_broadcast, delivery_state, capability_supported,
        retry_count, duration_ms, error_category, error_reason_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      outcomeId,
      params.correlationId,
      params.sessionId,
      params.direction,
      params.messageId ?? null,
      redactedJid,
      params.detectedType,
      params.wrapperType ?? null,
      params.isEphemeral ? 1 : 0,
      params.isViewOnce ? 1 : 0,
      params.isStatusBroadcast ? 1 : 0,
      params.deliveryState,
      params.capabilitySupported === false ? 0 : 1,
      Math.max(0, Math.floor(params.retryCount ?? 0)),
      Math.max(0, Math.round(params.durationMs ?? 0)),
      params.errorCategory ?? null,
      safeError,
      now
    );

    this.pruneOldRecords();
    const getStmt = this.db.sqlite.prepare(
      'SELECT * FROM message_processing_outcomes WHERE outcome_id = ?'
    );
    const row = getStmt.get(outcomeId) as RawMessageOutcomeRow;
    return this.mapMessageOutcomeRow(row);
  }

  public updateMessageDeliveryState(params: {
    sessionId: string;
    messageId: string;
    deliveryState: DeliveryTrackingState;
  }): number {
    const stmt = this.db.sqlite.prepare(`
      UPDATE message_processing_outcomes
      SET delivery_state = ?
      WHERE session_id = ? AND message_id = ?
    `);
    const res = stmt.run(params.deliveryState, params.sessionId, params.messageId);
    return Number(res.changes || 0);
  }

  public listRecentMessageOutcomes(options?: {
    sessionId?: string;
    limit?: number;
  }): StoredMessageOutcome[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    if (options?.sessionId) {
      const stmt = this.db.sqlite.prepare(
        'SELECT * FROM message_processing_outcomes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
      );
      const rows = stmt.all(
        options.sessionId,
        limit
      ) as unknown as RawMessageOutcomeRow[];
      return rows.map((r) => this.mapMessageOutcomeRow(r));
    }

    const stmt = this.db.sqlite.prepare(
      'SELECT * FROM message_processing_outcomes ORDER BY created_at DESC LIMIT ?'
    );
    const rows = stmt.all(limit) as unknown as RawMessageOutcomeRow[];
    return rows.map((r) => this.mapMessageOutcomeRow(r));
  }

  public pruneOldRecords(): void {
    try {
      this.db.sqlite
        .prepare(
          `
        DELETE FROM function_executions
        WHERE execution_id NOT IN (
          SELECT execution_id FROM function_executions
          ORDER BY created_at DESC
          LIMIT ?
        )
      `
        )
        .run(this.maxExecutionHistoryCount);

      this.db.sqlite
        .prepare(
          `
        DELETE FROM message_processing_outcomes
        WHERE outcome_id NOT IN (
          SELECT outcome_id FROM message_processing_outcomes
          ORDER BY created_at DESC
          LIMIT ?
        )
      `
        )
        .run(this.maxMessageOutcomesCount);
    } catch {
      // Non-fatal pruning
    }
  }
}
