export const MIGRATION_003_ID = '003_function_lab_and_message_capabilities';

export const MIGRATION_003_UP_SQL = `
CREATE TABLE IF NOT EXISTS function_definitions (
  function_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL DEFAULT 'general',
  description_ar TEXT NOT NULL,
  source_code TEXT NOT NULL,
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  required_dependencies_json TEXT NOT NULL DEFAULT '[]',
  supports_dry_run INTEGER NOT NULL DEFAULT 1,
  supports_simulation INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_function_definitions_category ON function_definitions(category);
CREATE INDEX IF NOT EXISTS idx_function_definitions_name ON function_definitions(name);

CREATE TABLE IF NOT EXISTS function_executions (
  execution_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  function_id TEXT NOT NULL,
  function_name TEXT NOT NULL,
  function_version INTEGER NOT NULL DEFAULT 1,
  telegram_user_id INTEGER NOT NULL,
  session_id TEXT,
  execution_mode TEXT NOT NULL,
  scenario_id TEXT,
  status TEXT NOT NULL,
  failure_category TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  args_preview_redacted TEXT NOT NULL DEFAULT '{}',
  result_summary_redacted TEXT,
  error_message_ar TEXT,
  diagnostic_json_redacted TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_function_executions_function_id ON function_executions(function_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_function_executions_correlation_id ON function_executions(correlation_id);
CREATE INDEX IF NOT EXISTS idx_function_executions_user_id ON function_executions(telegram_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_processing_outcomes (
  outcome_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  message_id TEXT,
  remote_jid_redacted TEXT NOT NULL,
  detected_type TEXT NOT NULL,
  wrapper_type TEXT,
  is_ephemeral INTEGER NOT NULL DEFAULT 0,
  is_view_once INTEGER NOT NULL DEFAULT 0,
  is_status_broadcast INTEGER NOT NULL DEFAULT 0,
  delivery_state TEXT NOT NULL,
  capability_supported INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  error_reason_redacted TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_outcomes_session ON message_processing_outcomes(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_outcomes_correlation ON message_processing_outcomes(correlation_id);
CREATE INDEX IF NOT EXISTS idx_message_outcomes_type ON message_processing_outcomes(detected_type, delivery_state);
`;

export const MIGRATION_003_DOWN_SQL = `
DROP INDEX IF EXISTS idx_message_outcomes_type;
DROP INDEX IF EXISTS idx_message_outcomes_correlation;
DROP INDEX IF EXISTS idx_message_outcomes_session;
DROP TABLE IF EXISTS message_processing_outcomes;

DROP INDEX IF EXISTS idx_function_executions_user_id;
DROP INDEX IF EXISTS idx_function_executions_correlation_id;
DROP INDEX IF EXISTS idx_function_executions_function_id;
DROP TABLE IF EXISTS function_executions;

DROP INDEX IF EXISTS idx_function_definitions_name;
DROP INDEX IF EXISTS idx_function_definitions_category;
DROP TABLE IF EXISTS function_definitions;
`;
