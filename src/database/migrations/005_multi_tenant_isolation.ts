export const MIGRATION_005_ID = '005_multi_tenant_isolation';

export const MIGRATION_005_UP_SQL = `
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_telegram_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_telegram_id);
`;

export const MIGRATION_005_DOWN_SQL = `
DROP INDEX IF EXISTS idx_tasks_owner;
DROP INDEX IF EXISTS idx_sessions_owner;
`;
