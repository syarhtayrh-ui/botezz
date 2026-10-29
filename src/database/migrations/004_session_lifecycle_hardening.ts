export const MIGRATION_004_ID = '004_session_lifecycle_hardening';

export const MIGRATION_004_UP_SQL = `
CREATE TABLE IF NOT EXISTS sessions_v4 (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  masked_phone TEXT,
  jid TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'CREATED',
      'INITIALIZING',
      'CONNECTING',
      'WAITING_FOR_PAIRING',
      'PAIRING_PENDING',
      'AUTHENTICATING',
      'AUTHENTICATED',
      'CONNECTED',
      'RECOVERING',
      'RECONNECTING',
      'DISCONNECTED',
      'LOGGED_OUT',
      'REQUIRES_REPAIR',
      'STOPPING',
      'STOPPED',
      'FAILED'
    )
  ),
  auth_dir TEXT NOT NULL UNIQUE,
  reconnect_attempts INTEGER NOT NULL DEFAULT 0,
  last_connected_at TEXT,
  last_status_at TEXT NOT NULL,
  last_error TEXT,
  last_disconnect_code INTEGER,
  last_disconnect_reason TEXT,
  health_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO sessions_v4 (
  id, label, masked_phone, jid, status, auth_dir,
  reconnect_attempts, last_connected_at, last_status_at, last_error,
  last_disconnect_code, last_disconnect_reason, health_status, last_activity_at,
  created_at, updated_at
)
SELECT
  id, label, masked_phone, jid, status, auth_dir,
  reconnect_attempts, last_connected_at, last_status_at, last_error,
  NULL, NULL,
  CASE
    WHEN status IN ('CONNECTED', 'AUTHENTICATED') THEN 'HEALTHY'
    WHEN status IN ('RECONNECTING', 'RECOVERING', 'CONNECTING', 'AUTHENTICATING', 'PAIRING_PENDING', 'WAITING_FOR_PAIRING', 'INITIALIZING', 'CREATED') THEN 'DEGRADED'
    ELSE 'UNHEALTHY'
  END,
  COALESCE(last_connected_at, updated_at),
  created_at, updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_v4 RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
`;

export const MIGRATION_004_DOWN_SQL = `
CREATE TABLE IF NOT EXISTS sessions_v2_rollback (
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

INSERT OR IGNORE INTO sessions_v2_rollback (
  id, label, masked_phone, jid, status, auth_dir,
  reconnect_attempts, last_connected_at, last_status_at, last_error, created_at, updated_at
)
SELECT
  id, label, masked_phone, jid,
  CASE
    WHEN status = 'CREATED' THEN 'INITIALIZING'
    WHEN status = 'WAITING_FOR_PAIRING' THEN 'PAIRING_PENDING'
    WHEN status = 'RECOVERING' THEN 'RECONNECTING'
    WHEN status = 'REQUIRES_REPAIR' THEN 'FAILED'
    WHEN status = 'STOPPING' THEN 'STOPPED'
    ELSE status
  END,
  auth_dir,
  reconnect_attempts, last_connected_at, last_status_at, last_error, created_at, updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_v2_rollback RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
`;
