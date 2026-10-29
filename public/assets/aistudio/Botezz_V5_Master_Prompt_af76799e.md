# Master Engineering Prompt for Google AI Studio — Botezz v5 (Multi-Tenant Subscriber Isolation, Anti-Ban Shield & Multi-Recipient Upgrades)

Copy and paste the following prompt directly into Google AI Studio to implement:
1. **Complete Multi-Tenant Subscriber Isolation & Role-Based UI Security** (each subscriber has isolated sessions, tasks, and saved functions; Owner-only menus and other users' sessions are strictly hidden and protected).
2. **Comprehensive Anti-Disconnect & Anti-Ban Protection Suite** (diversified per-session browser fingerprints, WebSocket keep-alive pings, human typing/presence simulation, multi-session stagger pacing, and graceful `unavailable` presence on disconnect).
3. **Multi-Recipient Messaging Support** (sending to one or multiple phone numbers/JIDs with safe pacing).

## Role & Objective

You are a Principal TypeScript & WhatsApp Protocol (`athanasia-baileys`) Systems Architect. Upgrade the repository across database migrations, repositories, session/connection managers, Function Lab, and Telegram bot handlers/workflows to implement the 3 architectural pillars below with 100% test coverage and zero TypeScript errors.

## Pillar 1: Complete Multi-Tenant Subscriber Isolation & Role-Based Access Control (RBAC)

### Problem Being Solved
Currently:
1. The `sessions`, `tasks`, and `function_definitions` tables have no tenant ownership filter, so `sessionManager.listSessions()` returns all sessions in the database to any Premium subscriber, allowing subscribers to see and use the Owner's and other subscribers' WhatsApp sessions.
2. In `src/bot/bot.ts` (lines 214, 304, 312, 783, 973, 983, 1472), `renderMainMenu({ isAdmin: true })` is hardcoded on navigation actions (`menu:main`, `nav:home`, `workflow:cancel`, `/cancel`, fallback), causing Owner-only buttons (`⭐ الاشتراكات`, `🛡️ تحكم المشرف`, `📊 مراقبة المهام`, `📜 سجل النشاط`, `⚙️ الإعدادات`) to appear to normal subscribers.
3. `OWNER_ONLY_PATTERNS` in `src/bot/middleware/authorization.ts` does not block Owner-only views such as `menu:admin`, `menu:settings`, `menu:subscriptions`, `menu:audit`, `tools:cekall`, `/admin`, `/settings`, `/controls`, `/cekall`, `/listprem`, `/listgb`.

### Required Implementation
1. **Add Migration `005_multi_tenant_isolation.ts` (`src/database/migrations/005_multi_tenant_isolation.ts`) & Wire in `src/database/database.ts`**:
   - Add `owner_telegram_id INTEGER NOT NULL DEFAULT 0` to `sessions` and `tasks` using safe `ALTER TABLE ... ADD COLUMN` checks (or table rebuild if needed) and create index `idx_sessions_owner ON sessions(owner_telegram_id)` and `idx_tasks_owner ON tasks(owner_telegram_id)`.
2. **Update `SessionRepository` (`src/database/repositories/session-repository.ts`) & `SessionManager` (`src/whatsapp/session-manager.ts`)**:
   - Add `owner_telegram_id?: number` to `SessionRecord` and `create({ ..., ownerTelegramId?: number })`.
   - In `SessionManager.createSession` and `SessionManager.initiatePairing`, store `ownerTelegramId: actorTelegramId ?? 0` when creating a new session.
   - Add helper methods on `SessionManager`:
     - `isOwner(actorTelegramId?: number): boolean` (returns `true` if `!actorTelegramId` or `!this.configuredAdminId` or `actorTelegramId === this.configuredAdminId`).
     - `canAccessSession(session: SessionRecord, actorTelegramId?: number): boolean`:
       - Returns `true` if `this.isOwner(actorTelegramId)`.
       - For non-owner subscribers, returns `true` **only** if `session.owner_telegram_id === actorTelegramId`.
     - `assertSessionAccess(sessionId: string, actorTelegramId?: number): SessionRecord`:
       - Loads the session; if not found or `!this.canAccessSession(session, actorTelegramId)`, throws `AuthorizationError('⛔ غير مصرح لك بالوصول إلى هذه الجلسة أو إدارتها.')`.
     - Update `listSessions(actorTelegramId?: number)` and `listConnectedSessions(actorTelegramId?: number)`:
       - When `actorTelegramId` is provided and `!this.isOwner(actorTelegramId)`, filter returned sessions to `s.owner_telegram_id === actorTelegramId`!
       - When `actorTelegramId` is the Owner (or omitted by internal system tasks), return all sessions.
   - Enforce `this.assertSessionAccess(sessionId, actorTelegramId)` in `reconnectSession`, `disconnectSession`, `removeSession`, `renameSession`, `getLiveVerification(sessionId, actorTelegramId)`, and `initiatePairing` (when re-pairing an existing `sessionId`).
3. **Isolate Workflows, Handlers & Function Lab per User**:
   - Pass `actorUserId` into:
     - `startHandler.renderMainMenu({ isAdmin: this.isOwner(actorUserId), actorUserId })` — and in `renderMainMenu`, pass `actorUserId` to `this.sessionManager.listSessions(actorUserId)` so each subscriber only sees their own session count in the header!
     - `sessionsHandler.renderSessionsList(page, actorUserId, this.isOwner(actorUserId))` and `sessionsHandler.renderSessionStatusOverview(actorUserId, this.isOwner(actorUserId))` and `sessionsHandler.renderSessionDetail(sessionId, actorUserId, this.isOwner(actorUserId))`:
       - Filter sessions via `sessionManager.listSessions(actorUserId)`.
       - Hide the `🧹 تنظيف غير المتصل` (`sess:confirm_purge_inactive`) button from non-owners, or make `handlePurgeInactive(actorUserId)` only purge inactive sessions owned by `actorUserId`!
       - Allow subscribers to delete/disconnect/reconnect **their own** sessions (`canAccessSession`), while blocking them from touching any session owned by someone else.
     - `messageWorkflow`, `mediaWorkflow`, `groupWorkflow`, and `groupsHandler`:
       - Always call `this.sessionManager.listSessions(adminId)` / `this.sessionManager.listConnectedSessions(adminId)` so subscribers only see and select **their own** sessions when sending messages, sending media, joining groups, or listing/managing groups!
     - `toolsHandler`:
       - In `renderSenderDiagnostics(page, actorUserId)`: filter sessions via `this.sessionManager.listSessions(actorUserId)`.
       - In `executeTestFunction`, `executeChannelLookup`, `renderFunctionCatalog`, and `saveCustomFunction`:
         - Filter connected sessions via `this.sessionManager.listConnectedSessions(adminId)`.
         - Filter `listFunctions` in `renderFunctionCatalog(adminId)` so non-owner subscribers only see functions where `createdBy === adminId` (while the Owner sees all functions).
       - In `renderToolsMenu(isAdmin)`: hide `⭐ إدارة الاشتراكات`, `🛡️ لوحة تحكم المشرف`, and `📊 التقرير الشامل (/cekall)` buttons when `isAdmin === false`.
4. **Fix All Hardcoded `isAdmin: true` Calls in `src/bot/bot.ts` & Harden `src/bot/middleware/authorization.ts`**:
   - Add a helper method `public isOwnerUser(userId: number): boolean { return userId === this.deps.config.TELEGRAM_ADMIN_ID; }` on `TelegramBotController`.
   - Replace every single `renderMainMenu({ isAdmin: true })` in `src/bot/bot.ts` with `renderMainMenu({ isAdmin: this.isOwnerUser(actorUserId), actorUserId })`.
   - Expand `OWNER_ONLY_PATTERNS` in `src/bot/middleware/authorization.ts` to strictly block non-owners from:
     - Commands: `/addpremium`, `/addprem`, `/delpremium`, `/delprem`, `/addgcpremium`, `/delgcpremium`, `/listprem`, `/addgb`, `/delgb`, `/listgb`, `/setcooldown`, `/admin`, `/settings`, `/controls`, `/cekall`
     - Callbacks: `menu:admin`, `menu:settings`, `menu:subscriptions`, `menu:audit:`, `tools:cekall`, `sub:`, `settings:`
   - Note: Allow subscribers to remove their **own** sessions (`sess:confirm_remove:` / `sess:remove:` / `/resetsession <id>`) by checking session ownership inside `SessionManager.removeSession(sessionId, actorUserId)` rather than blocking `sess:remove:` globally in middleware.

## Pillar 2: Anti-Disconnect & Anti-Ban Protection Suite (`src/whatsapp/connection-manager.ts`, `src/whatsapp/session-manager.ts`, `src/tasks/task-manager.ts`)

### Required Implementation
1. **Deterministic Per-Session Browser Fingerprint Diversification (`src/whatsapp/connection-manager.ts`)**:
   - Instead of hardcoding `browser: Browsers.ubuntu('Chrome')` for every session, create a helper `selectBrowserProfileForSession(sessionId: string): [string, string, string]` that hashes `sessionId` and deterministically selects one of 5 realistic desktop profiles:
     - `Browsers.ubuntu('Chrome')`
     - `Browsers.macOS('Chrome')`
     - `Browsers.windows('Chrome')`
     - `Browsers.macOS('Safari')`
     - `Browsers.windows('Edge')`
   - Because it is deterministic per `sessionId`, a session never changes its browser fingerprint across reconnects (`515` or network drops), while different sessions on the same server have distinct fingerprints.
2. **Hardened `makeWASocket` Keep-Alive & Retry Parameters (`src/whatsapp/connection-manager.ts`)**:
   - Pass these stability options to `makeWASocket`:
     ```ts
     keepAliveIntervalMs: 25_000,
     connectTimeoutMs: 30_000,
     defaultQueryTimeoutMs: 60_000,
     retryRequestDelayMs: 350,
     maxMsgRetryCount: 5,
     markOnlineOnConnect: false,
     syncFullHistory: false,
     generateHighQualityLinkPreview: false,
     ```
3. **Human-Like Presence & Typing Simulation (`simulateHumanPresenceBeforeSend`) in `AthanasiaBaileysSessionDriver` (`src/whatsapp/connection-manager.ts`)**:
   - Before calling `sock.sendMessage` in `sendTextMessage` and `sendMediaMessage`:
     - Best-effort call `await sock.presenceSubscribe(resolvedJid)` (once per recipient in `this.verifiedRecipientJids`), send `await sock.sendPresenceUpdate('composing', resolvedJid)`, wait a natural human typing micro-delay (`Math.min(900, Math.max(250, text.length * 12))` in live mode, or `0` in test/mock mode), and send `await sock.sendPresenceUpdate('paused', resolvedJid)`.
4. **Graceful `unavailable` Presence on Disconnect (`src/whatsapp/connection-manager.ts`)**:
   - In `disconnect()`, if `this.sock && this.wsOpen`, best-effort call `await this.sock.sendPresenceUpdate('unavailable').catch(() => undefined)` before `this.sock.end(undefined)` so WhatsApp's server cleanly closes the companion presence state and avoids `440` stream conflicts on reconnect.
5. **Staggered Multi-Session Pacing in `TaskManager.runMultiSessionTask` (`src/tasks/task-manager.ts`)**:
   - When executing a task across multiple sessions (`selectedSessionIds.length > 1`), introduce a small staggered start delay per session index (`idx * (150 + Math.floor(Math.random() * 200))` ms when `selectedSessionIds.length > 1`) so 5+ sessions on the same IP do not hit WhatsApp's servers at the exact same millisecond.

## Pillar 3: Multi-Recipient Support in `MessageWorkflow` (`src/bot/workflows/message-workflow.ts`)

### Required Implementation
- Allow the user in `MessageWorkflow` (`AWAITING_RECIPIENT`) to enter **either a single recipient OR multiple recipients** separated by commas, spaces, or newlines (up to 25 recipients per batch, e.g., `+966501234567, +966559876543`).
- Validate each recipient using `validateRecipient`; store `recipientJids: string[]` in `MessageWorkflowState`; and during `confirmAndExecute`, iterate through all `recipientJids` for the selected session(s) with a safe inter-recipient pacing delay (`350ms`) and report the total delivered count clearly in Arabic.

## Verification & Testing Requirements
1. Add unit & integration tests verifying:
   - Subscriber A (`userId: 222222`) cannot see or use sessions created by Owner (`userId: 999999`) or Subscriber B (`userId: 333333`).
   - Subscriber A never sees Owner-only buttons (`menu:admin`, `menu:subscriptions`, `menu:settings`, `menu:audit`, `tools:cekall`) even after pressing `menu:main`, `nav:refresh`, or `/cancel`, and receives an `AuthorizationError` if attempting to invoke Owner-only callbacks or commands directly.
   - Multi-recipient input (`+966501234567, +966559876543`) in `MessageWorkflow` validates and sends to all recipients cleanly.
2. Ensure all existing and new tests pass (`npm test`) and `npx tsc --noEmit` completes with 0 errors.
