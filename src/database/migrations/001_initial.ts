export const INITIAL_MIGRATION_ID = '001_initial_schema';

export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  masked_phone TEXT,
  jid TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'INITIALIZING',
      'CONNECTING',
      'PAIRING_PENDING',
      'AUTHENTICATING',
      'AUTHENTICATED',
      'CONNECTED',
      'DISCONNECTED',
      'RECONNECTING',
      'LOGGED_OUT',
      'FAILED',
      'STOPPED'
    )
  ),
  auth_dir TEXT NOT NULL UNIQUE,
  reconnect_attempts INTEGER NOT NULL DEFAULT 0,
  last_connected_at TEXT,
  last_status_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (
    operation_type IN (
      'SEND_TEXT',
      'SEND_MEDIA',
      'JOIN_GROUP',
      'GROUP_ACTION'
    )
  ),
  target_summary TEXT NOT NULL,
  selected_session_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'RUNNING',
      'COMPLETED',
      'PARTIALLY_COMPLETED',
      'FAILED',
      'CANCELLED'
    )
  ),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS task_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'RUNNING',
      'SUCCESS',
      'FAILED',
      'CANCELLED',
      'UNKNOWN'
    )
  ),
  result_summary TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_results_task_id ON task_results(task_id);
CREATE INDEX IF NOT EXISTS idx_task_results_session_id ON task_results(session_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_telegram_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
`;
