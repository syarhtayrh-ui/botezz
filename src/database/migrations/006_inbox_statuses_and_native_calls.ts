export const MIGRATION_006_ID = '006_inbox_statuses_and_native_calls';

export const MIGRATION_006_UP_SQL = `
CREATE TABLE IF NOT EXISTS incoming_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_telegram_id INTEGER NOT NULL DEFAULT 0,
  wa_message_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  push_name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  group_jid TEXT,
  message_kind TEXT NOT NULL,
  text_content TEXT,
  saved_file_path TEXT NOT NULL,
  saved_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  forwarded_to_telegram INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incoming_messages_owner_time
  ON incoming_messages(owner_telegram_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_incoming_messages_session_time
  ON incoming_messages(session_id, received_at DESC);

CREATE TABLE IF NOT EXISTS captured_statuses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_telegram_id INTEGER NOT NULL DEFAULT 0,
  wa_status_id TEXT NOT NULL,
  author_jid TEXT NOT NULL,
  author_phone TEXT NOT NULL,
  push_name TEXT,
  media_kind TEXT NOT NULL,
  caption TEXT,
  saved_file_path TEXT NOT NULL,
  saved_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL DEFAULT 0,
  forwarded_to_telegram INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_captured_statuses_owner_time
  ON captured_statuses(owner_telegram_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_captured_statuses_author
  ON captured_statuses(author_phone, captured_at DESC);
`;

export const MIGRATION_006_DOWN_SQL = `
DROP INDEX IF EXISTS idx_captured_statuses_author;
DROP INDEX IF EXISTS idx_captured_statuses_owner_time;
DROP TABLE IF EXISTS captured_statuses;

DROP INDEX IF EXISTS idx_incoming_messages_session_time;
DROP INDEX IF EXISTS idx_incoming_messages_owner_time;
DROP TABLE IF EXISTS incoming_messages;
`;
