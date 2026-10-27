# Configuration Guide (`CONFIGURATION.md`)

All runtime configuration is validated at application startup using **Zod** (`src/config/env.ts`). If any required variable is missing or malformed, the daemon fails fast with an explicit error report.

## Environment Variables Reference

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token issued by `@BotFather` in Telegram |
| `TELEGRAM_ADMIN_ID` | **Yes** | — | Numeric Telegram User ID of the sole authorized administrator |
| `DATABASE_PATH` | No | `./data/app.sqlite` | Path to the SQLite database file |
| `WHATSAPP_AUTH_DIR` | No | `./data/whatsapp-sessions` | Parent directory storing isolated per-session auth folders |
| `TEMP_UPLOAD_DIR` | No | `./data/tmp` | Controlled directory for temporary media uploads |
| `LOG_LEVEL` | No | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `MAX_CONCURRENT_TASKS` | No | `3` | Maximum simultaneous WhatsApp session operations (`1`–`25`) |
| `TASK_TIMEOUT_MS` | No | `120000` | Per-session operation timeout in milliseconds (`1000`–`600000`) |
| `MAX_UPLOAD_SIZE_MB` | No | `20` | Maximum allowed file upload size in megabytes (`1`–`100`) |

---

## How to Obtain Your Numeric `TELEGRAM_ADMIN_ID`

1. Open Telegram and message `@userinfobot` or `@RawDataBot`.
2. Copy the numeric `id` field (e.g., `123456789`).
3. **Never** use your `@username` — usernames can be changed or swapped. The authorization middleware strictly compares the immutable numeric Telegram user ID.
4. Set `TELEGRAM_ADMIN_ID=123456789` in `.env` and ensure `chmod 600 .env`.
