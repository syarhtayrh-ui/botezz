# Security & Privacy Architecture (`SECURITY.md`)

## 1. Administrator Authorization (`src/bot/middleware/authorization.ts`)

- **Default-Deny Allowlist**: If `TELEGRAM_ADMIN_ID` is unset or invalid, all requests are rejected.
- **Every Action Verified**: Both text commands (`/start`, phone inputs) and inline keyboard callback queries (`callback_query:data`) verify `ctx.from.id === TELEGRAM_ADMIN_ID`.
- **Audit Trail**: Unauthorized access attempts are immediately blocked and recorded in the `audit_logs` table with outcome `DENIED`.

## 2. Session Isolation & Credential Protection (`src/whatsapp/session-store.ts`)

- Each WhatsApp session gets a unique internal identifier (`sess_<uuid8>`) and a dedicated directory under `WHATSAPP_AUTH_DIR/<sessionId>` with `0700` permissions.
- Path traversal sequences (`..`, `/`, `\`, null bytes) are rejected by `resolveSafeChildPath`.
- Authentication keys (`creds.json`, pre-keys, signal keys) are **never** stored in SQLite tables, **never** logged, and **never** sent over Telegram.
- On logout (`DisconnectReason.loggedOut`) or explicit session removal, the session's isolated credential directory is purged from disk.

## 3. Log Redaction & Privacy (`src/security/redaction.ts`)

- `redactText` and `redactObject` strip Telegram bot tokens, 8-character pairing codes (`XXXX-XXXX`), buffers, private keys, and raw auth objects before Pino writes any log entry.
- Phone numbers in logs, UI views, and audit records are masked via `maskPhoneNumber` (e.g., `+966*****4567`).
- `audit_logs` never stores message body contents or unmasked phone numbers.

## 4. Safe Temporary File Handling (`src/whatsapp/operations/send-media.ts`)

- Uploaded media is validated against an explicit MIME-type allowlist and `MAX_UPLOAD_SIZE_MB`.
- Files are written using generated UUID filenames (`upload_<uuid>.ext`) with mode `0600` inside `TEMP_UPLOAD_DIR`.
- Files are never executed and are deleted automatically in the `finally` block as soon as the task finishes.

## 5. Remaining Limitations of Local Storage & Unofficial Athanasia Baileys Protocol

- **Disk Encryption**: Because `athanasia-baileys` requires access to Signal session keys in `WHATSAPP_AUTH_DIR` to reconnect after restarts, you should enable full-disk encryption (AWS EBS encryption at rest) on the host server.
- **Unofficial Protocol Risk**: `athanasia-baileys` (`github:AthanasiaCMD/athanasia-baileys`) implements the WhatsApp Web multi-device protocol unofficially. WhatsApp may change protocol handshakes, expire sessions, or restrict accounts that violate platform terms.
