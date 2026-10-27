# WhatsApp Multi-Session Management System Controlled Through Telegram

A modular, production-oriented Node.js + TypeScript system for managing multiple independent WhatsApp Web sessions (`athanasia-baileys` v1.0.0 from `github:AthanasiaCMD/athanasia-baileys`) through an authorized Arabic Telegram Bot (`grammY`), backed by SQLite persistence (`node:sqlite`), Zod startup validation, Pino redacted structured logging, and bounded concurrent multi-session task execution.

---

## Key Capabilities

1. **Multi-Account WhatsApp Session Management (`athanasia-baileys`)**:
   - Link multiple independent WhatsApp accounts via interactive Pairing Code workflow (supports both auto-generated 8-character codes and `athanasia-baileys` custom 8-character pairing codes `sock.requestPairingCode(phoneNumber, customCode)`).
   - Strict per-session filesystem isolation (`WHATSAPP_AUTH_DIR/<sessionId>`, mode `0700`).
   - Automatic session restoration on startup, `DisconnectReason.restartRequired` (`515`) post-pairing socket recreation, and bounded exponential backoff reconnection with jitter.
   - Automatic credential invalidation and cleanup on logout (`DisconnectReason.loggedOut`).
2. **Arabic Telegram Inline-Keyboard Interface**:
   - Full 11-item Arabic main menu, paginated session/task/audit lists, and guided multi-step workflows with Back (`🔙 رجوع`), Cancel (`❌ إلغاء`), and Confirm (`✅ تأكيد`) controls.
   - Default-deny numeric Telegram Administrator ID allowlist (`TELEGRAM_ADMIN_ID`) enforced on every command, message, and callback query.
3. **Bounded Concurrent Multi-Session Task Engine**:
   - Select one or multiple sessions to execute text messaging, validated media/file sending, or group joining concurrently up to `MAX_CONCURRENT_TASKS`.
   - Per-session timeout protection, isolated failure handling (`COMPLETED`, `PARTIALLY_COMPLETED`, `FAILED`, `CANCELLED`), duplicate-task prevention, and cooperative cancellation.
4. **Group Management & Permission Verification**:
   - List participating groups (supporting both `PN` and `LID` addressing modes in `athanasia-baileys`), inspect metadata and participants, generate invite links, join groups via invite link, add/remove/promote/demote participants (verified for Group Admin permissions and per-participant status codes), and leave groups after confirmation.
5. **Interactive Local Web Control Center & Telegram Simulator (Port 3000)**:
   - Distinguishes clearly between the **Standalone Production Telegram Daemon (`npm run bot:start`)** and the **Local Web Harness / Simulator (`npm run dev`)** connected to the real SQLite database and `TelegramBotController`.

---

## Project Structure

```text
src/
  app.ts                          # Standalone production daemon entrypoint (grammY + athanasia-baileys)
  runtime-harness.ts              # Singleton bridge for the local web inspection & simulator UI
  types/
    athanasia-baileys.d.ts        # Strict TypeScript declarations for athanasia-baileys CommonJS build
  config/
    env.ts                        # Zod environment variable startup validation
  bot/
    bot.ts                        # TelegramBotController & grammY Bot factory
    middleware/
      authorization.ts            # Numeric TELEGRAM_ADMIN_ID allowlist enforcement
    handlers/
      start.ts                    # Main menu & System Health handler
      sessions.ts                 # Session list, detail, reconnect, disconnect, remove
      messaging.ts                # Text message workflow entry handler
      media.ts                    # Media/file workflow entry handler
      groups.ts                   # Group management submenu & list handler
      tasks.ts                    # Task monitor, cancellation & audit history handler
      settings.ts                 # Runtime settings & rate-limit profile handler
    keyboards/
      main-menu.ts                # 11-item Arabic main menu & navigation builders
      session-menu.ts             # Paginated session list & multi-session checklist
      task-menu.ts                # Paginated task monitor & detail keyboards
    workflows/
      pairing-workflow.ts         # Interactive phone normalization & custom/random pairing code workflow
      message-workflow.ts         # Guided multi-session text message workflow
      media-workflow.ts           # Guided media upload, validation & cleanup workflow
      group-workflow.ts           # Join group & permission-checked group admin workflows
  whatsapp/
    session-manager.ts            # Session lifecycle, pairing lock, 515 restart & backoff reconnect
    session-store.ts              # Isolated 0700 per-session credential directory store
    connection-manager.ts         # AthanasiaBaileysSessionDriver (live) & MockWhatsAppSessionDriver (test/sim)
    operations/
      send-message.ts             # Validated text sending with rate-limit & dedup cooldown
      send-media.ts               # Validated media sending with automatic temp file cleanup
      group-operations.ts         # Group queries, invite links, join & admin participant updates
  tasks/
    task-manager.ts               # Multi-session task lifecycle & crash recovery
    task-runner.ts                # Concurrent per-session execution & partial failure aggregation
    concurrency.ts                # ConcurrencyLimiter semaphore & timeout wrapper
  database/
    database.ts                   # SQLite connection, WAL mode & atomic transaction runner
    migrations/
      001_initial.ts              # Schema for sessions, tasks, task_results, settings, audit_logs
    repositories/
      session-repository.ts
      task-repository.ts
      settings-repository.ts
      audit-repository.ts
  security/
    redaction.ts                  # Deep log redaction & phone number masking
    validation.ts                 # Phone, JID, group link, MIME, path traversal & rate limiter
  logging/
    logger.ts                     # Structured Pino logger with secret redaction
  utils/
    errors.ts                     # Categorized errors with sanitized Arabic user messages
    retry.ts                      # Bounded exponential backoff with jitter
    shutdown.ts                   # LIFO graceful shutdown coordinator
tests/
  unit/core.test.ts               # Unit tests for config, auth, validation, redaction, concurrency
  integration/workflows.test.ts   # Integration tests for DB transactions, pairing, tasks, groups
scripts/
  setup.sh                        # Environment, directory permissions & test bootstrap script
  health-check.sh                 # CLI health inspection script
systemd/
  whatsapp-telegram-bot.service   # Production Ubuntu 24.04 systemd service unit
docs/
  INSTALLATION.md
  CONFIGURATION.md
  SECURITY.md
  DEPLOYMENT_AWS.md
  TROUBLESHOOTING.md
```

---

## Quick Start Commands

```bash
# 1. Run automated unit & integration test suites
npm test

# 2. Start standalone Telegram Bot + Baileys backend (requires .env)
npm run bot:start

# 3. Run interactive Web Control Center & Telegram Bot Harness (Port 3000)
npm run dev
```

See `docs/INSTALLATION.md`, `docs/CONFIGURATION.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT_AWS.md`, and `docs/TROUBLESHOOTING.md` for complete operational documentation.
