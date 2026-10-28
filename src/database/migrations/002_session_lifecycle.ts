export const MIGRATION_002_ID = '002_session_lifecycle_states';

export const MIGRATION_002_SQL = `
CREATE TABLE IF NOT EXISTS sessions_v2 (
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

INSERT OR IGNORE INTO sessions_v2 (
  id, label, masked_phone, jid, status, auth_dir,
  reconnect_attempts, last_connected_at, last_status_at, last_error, created_at, updated_at
)
SELECT
  id, label, masked_phone, jid, status, auth_dir,
  reconnect_attempts, last_connected_at, last_status_at, last_error, created_at, updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
`;
