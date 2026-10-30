# Master Engineering Prompt for Google AI Studio — Botezz v5 (Multi-Tenant Isolation, Anti-Ban Shield, Multi-Recipient Messaging & Ubuntu Live Video Call Streaming Engine)

Copy and paste the following prompt directly into Google AI Studio to implement:
1. **Complete Multi-Tenant Subscriber Isolation & Role-Based UI Security** (each subscriber has isolated sessions, tasks, and saved functions; Owner-only menus and other users' sessions are strictly hidden and protected).
2. **Comprehensive Anti-Disconnect & Anti-Ban Protection Suite** (diversified per-session browser fingerprints, WebSocket keep-alive pings, human typing/presence simulation, multi-session stagger pacing, and graceful `unavailable` presence on disconnect).
3. **Multi-Recipient Messaging Support** (sending to one or multiple phone numbers/JIDs with safe pacing).
4. **WhatsApp Live Video Call Streaming Bridge & Interactive Workflow (`UbuntuVideoCallBridge` + `VideoCallWorkflow`)** (Step 1: Enter target WhatsApp number -> Step 2: Upload recorded video to Telegram -> Step 3: Preview video details, engine readiness, loop/duration settings & confirm -> Step 4: Stream the recorded video as a live virtual camera feed via Ubuntu `FFmpeg + v4l2loopback + ADB` bridge with seamless Baileys PTV fallback, plus `scripts/setup-ubuntu-video-engine.sh`).

## Role & Objective

You are a Principal TypeScript & WhatsApp Protocol (`athanasia-baileys`) Systems Architect. Upgrade the repository across database migrations, repositories, session/connection managers, Function Lab, and Telegram bot handlers/workflows to implement the 4 architectural pillars below with 100% test coverage and zero TypeScript errors.

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

## Pillar 4: Ubuntu Live Video Call Streaming Engine & Interactive Telegram Workflow (`src/whatsapp/video-call-bridge.ts`, `src/bot/workflows/video-call-workflow.ts`, `scripts/setup-ubuntu-video-engine.sh`)

### Architectural Overview
To stream a pre-recorded video inside a live WhatsApp video call on an **Ubuntu Cloud Server** (where the recipient answers the video call and sees the recorded video instead of a live camera feed), build a two-layer architecture:
1. **`UbuntuVideoCallBridge` (`src/whatsapp/video-call-bridge.ts`)**:
   - Connects the Node.js bot to Ubuntu's Virtual Camera (`v4l2loopback` `/dev/video0`), Virtual Microphone (`PulseAudio`), `ffmpeg` real-time frame injector, and headless Android/WhatsApp instance via `adb` (with automatic fallback to Baileys `ptv: true` Circular Video Note + Call Ring Signaling when `/dev/video0` or `adb` is not mounted in a preview container).
2. **`VideoCallWorkflow` (`src/bot/workflows/video-call-workflow.ts`)**:
   - Implements the exact 4-step Telegram workflow:
     1. User specifies the target WhatsApp number (`+966501234567`).
     2. User uploads the recorded video file (`.mp4`, `.mov`, `.webm`, `.mkv`) to the Telegram bot.
     3. User previews the video metadata (file name, size, format, target number, loop mode, call duration, and Ubuntu V4L2/ADB engine status) and confirms the choice.
     4. The bot initiates the video call and streams the recorded video into the virtual camera feed.

### Required Implementation Details

1. **Create `src/whatsapp/video-call-bridge.ts` (`UbuntuVideoCallBridge`)**:
   - Read optional environment variables (with sensible defaults for Ubuntu Server):
     - `VIDEO_ENGINE_V4L2_DEVICE` (default: `/dev/video0`)
     - `VIDEO_ENGINE_ADB_SERIAL` (default: `127.0.0.1:5555`)
     - `VIDEO_ENGINE_AUDIO_SINK` (default: `VirtualMic`)
   - Method `probeEnvironment(): Promise<VideoEngineDiagnostics>`:
     - Checks if `fs.existsSync(v4l2Device)` is true, checks if `ffmpeg -version` is available, and checks if `adb devices` lists an active device.
     - Returns `{ readyForKernelStream: boolean, hasFfmpeg: boolean, hasV4l2Device: boolean, hasAdbDevice: boolean, v4l2Device: string, adbSerial: string, mode: 'UBUNTU_V4L2_LIVE_CALL' | 'BAILEYS_PTV_AND_RING_FALLBACK', summaryAr: string }`.
   - Method `startVideoCallStream(params: { callSessionKey: string; sessionId: string; targetPhoneDigits: string; targetJid: string; videoFilePath: string; fileName: string; loopVideo: boolean; maxDurationSec: number; driver: WhatsAppSessionDriver }): Promise<VideoCallExecutionResult>`:
     - **Path A — When `probe.readyForKernelStream` is `true` on Ubuntu Server**:
       1. Spawns `ffmpeg` using `child_process.spawn` (no shell interpolation, passing safe array arguments):
          ```ts
          const ffmpegArgs = [
            '-re',
            ...(params.loopVideo ? ['-stream_loop', '-1'] : []),
            '-t', String(params.maxDurationSec),
            '-i', params.videoFilePath,
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
            '-r', '30',
            '-f', 'v4l2',
            this.v4l2Device,
          ];
          ```
       2. Uses `adb` (`spawn('adb', ['-s', this.adbSerial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `https://www.google.com/search?q=https://wa.me/%24{params.targetPhoneDigits}`])`) to open the target chat in the headless WhatsApp instance and initiates the video call so the remote party's phone rings and receives the `/dev/video0` stream upon answering.
       3. Stores the active stream handle in `activeStreams.set(callSessionKey, ...)` with an automatic timer to stop the stream and run `adb shell input keyevent KEYCODE_ENDCALL` after `maxDurationSec`.
     - **Path B — When running in a cloud preview or container without `/dev/video0` / `adb` (`BAILEYS_PTV_AND_RING_FALLBACK`)**:
       1. Uses `params.driver.sendMediaMessage` (enhanced with `ptv: true`) to deliver the uploaded video as an instant live-camera circular broadcast (`ptvMessage`) alongside call signaling, and returns a clear Arabic status report explaining whether the call executed via `UBUNTU_V4L2_LIVE_CALL` or `BAILEYS_PTV_AND_RING_FALLBACK`.
   - Method `stopVideoCallStream(callSessionKey: string): Promise<boolean>`:
     - Kills the active `ffmpeg` child process for `callSessionKey`, sends `KEYCODE_ENDCALL` via `adb` if applicable, and cleans up the staged temporary video file.

2. **Enhance `AthanasiaBaileysSessionDriver.sendMediaMessage` (`src/whatsapp/connection-manager.ts`)**:
   - Support optional `ptv?: boolean` and `gifPlayback?: boolean` flags in `sendMediaMessage` so when `kind === 'video'` and `ptv === true`, it passes `{ video: fileBuffer, mimetype: params.mimeType, ptv: true, caption: params.caption }` to `sock.sendMessage`.

3. **Create `src/bot/workflows/video-call-workflow.ts` (`VideoCallWorkflow`) & Wire in `src/bot/bot.ts` and `src/bot/keyboards/main-menu.ts`**:
   - Add a prominent button in `buildMainMenuKeyboard` (`src/bot/keyboards/main-menu.ts`):
     `📹 اتصال مرئي ببث مسجل` (`callbackData: 'menu:video_call'`).
   - Add `'VIDEO_CALL'` to `ConversationMode` in `src/bot/bot.ts` and support `/videocall` command + `menu:video_call` callback.
   - Implement the 4-step stateful workflow in `VideoCallWorkflow`:
     - **Step 1 (`AWAITING_RECIPIENT`)**:
       - Prompts the user to send the target WhatsApp phone number with country code (e.g., `+966501234567`).
       - Validates the number using `validateRecipient` and transitions to `AWAITING_VIDEO`.
     - **Step 2 (`AWAITING_VIDEO`)**:
       - Prompts the user to upload the recorded video file (`.mp4`, `.mov`, `.webm`, `.mkv`) to Telegram (with a button `🎬 إرفاق فيديو تجريبي للمعاينة` `wf_vcall:sample_video` for quick testing in the web simulator).
       - In `TelegramBotController.handleMediaUpload` (`src/bot/bot.ts`), when `mode === 'VIDEO_CALL'`, route the uploaded video buffer to `this.videoCallWorkflow.handleVideoUpload(actorUserId, upload)`.
     - **Step 3 (`PREVIEW_AND_CONFIRM`)**:
       - Displays the **Video Call Preview & Confirmation Card** in Arabic:
         - `👤 الرقم المستهدف:` `state.recipientDisplay` (`state.recipientJid`)
         - `🎞️ اسم ملف الفيديو:` `state.fileName` (`state.sizeFormatted`, `state.mimeType`)
         - `🖥️ حالة محرك البث على Ubuntu:` live diagnostics from `videoCallBridge.probeEnvironment()`
         - `🔁 تكرار الفيديو تلقائياً أثناء المكالمة:` `مفعل ✅` / `معطل ❌` (toggleable via `wf_vcall:toggle_loop`)
         - `⏱️ الحد الأقصى لمدة المكالمة:` `60 ثانية` / `180 ثانية` / `300 ثانية` (cyclable via `wf_vcall:cycle_duration`)
         - `📱 الجلسة المختارة:` (defaults to first connected session owned by `actorUserId`, or selectable via `wf_vcall:select_sess:<id>`)
       - Provides confirmation buttons:
         - `📹 تأكيد وبدء الاتصال المرئي الآن` (`wf_vcall:confirm_execute`)
         - `🔄 تغيير ملف الفيديو` (`wf_vcall:reupload`)
         - `❌ إلغاء` (`workflow:cancel`)
     - **Step 4 (`confirmAndExecute` & `stopActiveCall`)**:
       - Executes `videoCallBridge.startVideoCallStream(...)`, records the action in `auditRepo`, and displays the active call panel with a button `🛑 إنهاء المكالمة وإيقاف البث` (`wf_vcall:stop`).

4. **Create Ubuntu Server Provisioning Script `scripts/setup-ubuntu-video-engine.sh`**:
   - Write a clean, well-documented bash script for Ubuntu 22.04 / 24.04 LTS that:
     - Installs `ffmpeg`, `v4l2loopback-dkms`, `v4l2loopback-utils`, `v4l-utils`, `pulseaudio`, `android-tools-adb`, and `docker.io`.
     - Loads `modprobe v4l2loopback devices=1 video_nr=0 card_label="WhatsAppVirtualCam" exclusive_caps=1`.
     - Configures a PulseAudio virtual sink/source (`VirtualMic`).
     - Prints the exact `docker run` command to start a headless `redroid/redroid:12.0.0-latest` container with `/dev/video0` passed through (`--device=/dev/video0:/dev/video0`) and `adb connect 127.0.0.1:5555`.

## Verification & Testing Requirements
1. Add unit & integration tests verifying:
   - Subscriber A (`userId: 222222`) cannot see or use sessions created by Owner (`userId: 999999`) or Subscriber B (`userId: 333333`).
   - Subscriber A never sees Owner-only buttons (`menu:admin`, `menu:subscriptions`, `menu:settings`, `menu:audit`, `tools:cekall`) even after pressing `menu:main`, `nav:refresh`, or `/cancel`, and receives an `AuthorizationError` if attempting to invoke Owner-only callbacks or commands directly.
   - Multi-recipient input (`+966501234567, +966559876543`) in `MessageWorkflow` validates and sends to all recipients cleanly.
   - The 4-step `VideoCallWorkflow` (`menu:video_call` -> enter target phone `+966501234567` -> upload `.mp4` video -> preview metadata, toggle loop/duration -> `wf_vcall:confirm_execute` -> `wf_vcall:stop`) executes cleanly end-to-end.
2. Ensure all existing and new tests pass (`npm test`) and `npx tsc --noEmit` completes with 0 errors.
