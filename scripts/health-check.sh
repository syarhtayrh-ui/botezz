#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DATABASE_PATH:-./data/app.sqlite}"
AUTH_DIR="${WHATSAPP_AUTH_DIR:-./data/whatsapp-sessions}"

echo "=== System Health Check ==="
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Node Version: $(node -v)"

if [ -f "$DB_PATH" ]; then
  echo "Database File: PRESENT ($DB_PATH)"
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    const sessions = db.prepare("SELECT status, COUNT(*) as count FROM sessions GROUP BY status").all();
    const tasks = db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();
    console.log("Sessions Summary:", JSON.stringify(sessions));
    console.log("Tasks Summary:", JSON.stringify(tasks));
    db.close();
  ' "$DB_PATH"
else
  echo "Database File: NOT INITIALIZED YET ($DB_PATH)"
fi

if [ -d "$AUTH_DIR" ]; then
  SESSION_DIRS=$(find "$AUTH_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
  echo "Isolated Auth Directories Count: $SESSION_DIRS"
else
  echo "Isolated Auth Directory: NOT CREATED YET ($AUTH_DIR)"
fi

echo "=== Health Check Passed ==="
