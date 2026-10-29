# Master Engineering Prompt for Google AI Studio — Botezz v4 Upgrade

Copy and paste the following prompt directly into Google AI Studio to apply both the **Post-Pairing Immediate Logout (401) Fix** and the **Deep Function Lab (`/testfunction`) Overhaul & Smart Protocol Delivery Wrapper**:

## Role & Objective

You are a Principal TypeScript & WhatsApp Protocol (`athanasia-baileys`) Systems Architect. Perform a surgical, production-grade upgrade across the project to resolve the post-pairing session logout bug (`401` / `LOGGED_OUT` on first operation) and overhaul the **Function Lab (`/testfunction`)** subsystem according to the exact specifications below.

## Part 1: Fix Immediate Session Logout (`401` / `LOGGED_OUT`) on First Operation After Pairing

### Root Cause
In `src/whatsapp/connection-manager.ts`, `creds.registered = true` is currently forced manually during `isNewLogin` (around line 1088) and during `connection === 'open'` (around line 1125). In `athanasia-baileys`, when Socket 1 finishes `pair-success` and closes with `515` (`restartRequired`), `creds.registered` **must remain `false`** so that when Socket 2 connects and receives `CB:success` and `CB:ib,,offline`, Baileys executes `uploadPreKeysToServerIfRequired()`, sends `sendPassiveIq('active')`, and emits `creds.update: { registered: true }` itself. Setting `creds.registered = true` prematurely causes Socket 2 to skip uploading Initial PreKeys to WhatsApp servers, causing WhatsApp to immediately reject the first `sock.sendMessage()` / `sock.relayMessage()` with `401` (`DisconnectReason.loggedOut` / `device-removed`).

### Required Changes in `src/whatsapp/connection-manager.ts` & `src/whatsapp/operations/`
1. **Remove Premature `creds.registered = true` Mutations**:
   - In `src/whatsapp/connection-manager.ts` inside `connectionListener`:
     - Remove `if (sock.authState?.creds) { sock.authState.creds.registered = true; }` inside `if (isNewLogin)`.
     - Remove `if (creds && hasValidAuth && !creds.registered) { creds.registered = true; }` inside `else if (connection === 'open')`.
2. **Merge `creds.update` Payload in `credsListener` (`src/whatsapp/connection-manager.ts` line 1063)**:
   - Update `credsListener` so it accepts `(update: Partial<AuthenticationCreds>)`, merges `if (update && typeof update === 'object') { Object.assign(state.creds, update); }`, chains `enqueueSaveCreds().then(() => this.flushAuthWrites())`, and when `update?.registered === true` while `this.wsOpen` is `true`, transitions `this.connectionState = 'CONNECTED'` and fires `callbacks.onStatusChange({ status: 'CONNECTED', jid: normalizedJid, isRegistered: true })`.
3. **Ensure Post-Pairing PreKeys Upload Completes Before Marking `CONNECTED`**:
   - Inside `else if (connection === 'open')`:
     - If `creds?.registered === true` and `normalizedJid` is present, set `this.connectionState = 'CONNECTED'` and emit `status: 'CONNECTED'`.
     - If `creds?.account` exists and `normalizedJid` is present, but `creds.registered` is still `false` (Socket 2 right after `515`), keep `this.connectionState = 'AUTHENTICATING'`, emit `status: 'AUTHENTICATING'`, and run an async post-pairing initializer that calls `await sock.uploadPreKeysToServerIfRequired?.()`, `await sock.sendPassiveIq?.('active')`, waits up to `1500ms` for Baileys' `CB:ib,,offline` handler to emit `creds.update: { registered: true }`, and if still `false` after `uploadPreKeysToServerIfRequired()` succeeds, sets `state.creds.registered = true`, flushes auth writes, and transitions to `'CONNECTED'`.
4. **Warm Up Direct Recipient JIDs & Prevent Duplicate Stanza Retries**:
   - In `AthanasiaBaileysSessionDriver` (`src/whatsapp/connection-manager.ts`), add a helper `resolveDirectRecipientJid(sock, recipientJid)` that, for `@s.whatsapp.net` JIDs, checks an in-memory warm cache (`this.verifiedRecipientJids`) and calls `sock.onWhatsApp(recipientJid)` once per recipient (falling back gracefully to `jidNormalizedUser(recipientJid)`) before `sock.sendMessage`, then flushes `Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()])`.
   - In `src/whatsapp/operations/send-message.ts` and `src/whatsapp/operations/send-media.ts`, set `maxRetries: 0` on `this.messageSender.sendVerifiedMessage` so initial USync key-exchange latency never triggers duplicate encrypted message stanzas.

## Part 2: Clean Up Function Lab UI & Remove Experimental Demo Clutter

### Required Changes in `src/function-lab/index.ts` and `src/bot/handlers/tools.ts`
1. **Remove Bloated Demo Functions from `BUILTIN_FUNCTION_DEFINITIONS`**:
   - Clear out the unnecessary experimental probe functions (`nebulaSocketProbe`, `stickerCapabilityProbe`, `statusStoryCapabilityProbe`, `pollAndReactionProbe`, `AewCh`) from `BUILTIN_FUNCTION_DEFINITIONS` so the Function Registry (`📚 دوالي المحفوظة`) is dedicated strictly to **custom functions saved by the admin** (`/savefunction` or the Save button).
2. **Streamline the `/testfunction` Control Panel (`promptTestFunction` & `renderToolsMenu` in `src/bot/handlers/tools.ts`)**:
   - Remove cluttered experimental buttons from `promptTestFunction` and `renderToolsMenu`:
     - Remove `⚡ تشغيل دالة فحص تجريبية جاهزة` (`tools:run_sample_testfunction`)
     - Remove `🚀 فحص دالة AewCh (Dry-Run)` (`tools:flab_dryrun:AewCh`)
     - Remove `🧬 تشغيل سيناريوهات الاختبار (13 سيناريو)` (`tools:flab_run_scenarios`)
     - Remove `📋 مصفوفة قدرات واتساب` (`tools:flab_capabilities`)
     - Remove preset send-cap buttons (`حد: 100`, `حد: 500`, `حد: 2000`)
   - Replace with a clean, focused, high-power control keyboard in `promptTestFunction`:
     - Row 1: `📚 دوالي المحفوظة (Saved Functions)` (`tools:flab_catalog`) | `💾 حفظ آخر دالة` (`tools:flab_prompt_save`)
     - Row 2: `🛑 إيقاف التنفيذ الجاري` (`tools:flab_stop`) | `🛡️ التغليف الذكي: مفعل/معطل` (`tools:tf_toggle_smart_wrap`)
     - Row 3: `⏱️ الفاصل الزمني (${cfg.delayMs}ms)` (`tools:tf_prompt_delay`) | `📡 النطاق: ${cfg.sessionScope === 'ALL' ? 'كل الجلسات (ALL)' : 'جلسة واحدة (FIRST)'}` (`tools:tf_toggle_scope`)
     - Row 4: `🔄 عند الخطأ: ${cfg.stopOnError ? 'إيقاف' : 'استمرار'}` (`tools:tf_toggle_stop_on_error`) | `🔙 رجوع للأدوات` (`menu:tools`)

## Part 3: Remove All Artificial Limits, Ceilings & Restrictions in Function Lab

### Required Changes in `src/database/repositories/settings-repository.ts`, `src/function-lab/index.ts`, and `src/bot/handlers/tools.ts`
1. **Unlimited Default & Uncapped Execution**:
   - In `DEFAULT_TEST_FUNCTION_CONFIG` (`src/database/repositories/settings-repository.ts`):
     - Set `maxSends: 0` (unlimited `∞` by default — never block or cap `sendMessage` / `relayMessage` / `sendNode` / `query` unless the admin explicitly sets `maxSends > 0`).
     - Set `vmTimeoutMs: 0` (no forced per-iteration timeout by default so long-running loops, media uploads, and custom `await sleep(...)` calls inside a function never get killed mid-execution; only apply a timeout if the admin explicitly passes `--timeout=MS` > 0).
     - Set `maxSleepMs: 0` (unlimited `sleep(ms)` duration — `await sleep(ms)` must wait the exact `ms` requested by the custom function without clamping to `10000`).
     - Add `smartWrap: true` (boolean, default `true`) to `TestFunctionConfig` to control the Smart Protocol Delivery Wrapper.
   - Remove the `10000` ceiling on `iterations` in `src/function-lab/index.ts` and `src/bot/handlers/tools.ts` (`const iterations = Math.max(1, Math.floor(Number(request.iterations) || 1));`).
   - Remove the `100000` ceiling on `maxSends` and the `60000` ceiling on `delayMs` and `vmTimeoutMs`.
   - Remove the `65536` byte ceiling on `randomBytes(size)`.
2. **Unrestricted Function Syntax Support in `FunctionValidator`**:
   - Accept any valid JavaScript function or script structure:
     - `async function name(sock, target, meta) { ... }` or synchronous `function name(...) { ... }`
     - Arrow functions (`async (sock, target) => { ... }`, `(target, sock) => { ... }`)
     - Multi-function scripts (multiple helper functions + entry function)
     - Raw top-level statements (auto-wrapped into `async function customInline(sock, target, meta) { ... }`)
   - Parameter Order Auto-Detection: Inspect declared parameter names (`declaredParameters`). If the first parameter is named `target`, `jid`, `recipient`, or `to` and the second parameter is named `sock`, `client`, `conn`, or `wa` (e.g. `async function myFn(target, sock)` or `async function myFn(target)`), automatically pass arguments in the exact order declared by the user's function! Also bind global `sock`, `client`, `conn`, `target`, `jid`, and `meta` in the VM context so functions can reference them either via parameters or directly as globals.

## Part 4: Expose ALL `athanasia-baileys` Builders, Transports, Media/Sticker Uploaders & Payment/Interactive Pathways

### Required Changes in `src/function-lab/index.ts`, `src/whatsapp/connection-manager.ts`, and `src/types/athanasia-baileys.d.ts`
1. **Inject the Entire `athanasia-baileys` Namespace Into the Sandbox**:
   - In `src/function-lab/index.ts`, import `* as Baileys from 'athanasia-baileys'` and spread all exports of `Baileys` directly into the VM `sandbox` object (`...Baileys, baileys: Baileys`), alongside `Buffer`, `crypto`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`, `structuredClone`, `fetch`.
   - This guarantees direct access to all protocol builders and utilities:
     - `proto` (full `WAProto` definitions)
     - `generateWAMessageFromContent`, `generateWAMessage`, `generateWAMessageContent`, `generateForwardMessageContent`, `prepareWAMessageMedia`, `prepareDisappearingMessageSettingContent`
     - `encodeWAMessage`, `encodeSignedDeviceIdentity`, `encodeNewsletterMessage`
     - `generateMessageID`, `generateMessageIDV2`, `unixTimestampSeconds`, `toNumber`, `encodeBigEndian`, `aesEncryptGCM`, `aesDecryptGCM`, `hmacSign`, `sha256`, `hkdf`, `Curve`
     - `getBinaryNodeChild`, `getBinaryNodeChildren`, `getAllBinaryNodeChildren`, `getBinaryNodeChildBuffer`, `getBinaryNodeChildString`, `S_WHATSAPP_NET`, `STORIES_JID`
2. **Full Socket Method & Transport Forwarding on `safeSock` (`sock` / `client` / `conn`)**:
   - In `AthanasiaBaileysSessionDriver.runSandboxedTestFunction` (`src/whatsapp/connection-manager.ts`) and `FunctionExecutor.execute` (`src/function-lab/index.ts`), ensure `liveAdapter` passes `raw: sock` and exposes all underlying `WASocket` methods and properties without restriction:
     - `sock.sendMessage(jid, content, options)`
     - `sock.relayMessage(jid, message, options)`
     - `sock.sendNode(frame)` and `sock.query(node, timeoutMs)` (direct binary node transmission)
     - `sock.waUploadToServer` (direct media/sticker/document CDN upload function required by `prepareWAMessageMedia`)
     - `sock.sendStatusMentions`, `sock.updateMediaMessage`, `sock.refreshMediaConn`
     - `sock.sendReceipt`, `sock.sendReceipts`, `sock.readMessages`, `sock.chatModify`
     - All group methods (`groupMetadata`, `groupCreate`, `groupParticipantsUpdate`, `groupUpdateSubject`, `groupUpdateDescription`, `groupSettingUpdate`, `groupToggleEphemeral`, `groupInviteCode`, `groupAcceptInvite`, `groupAcceptInviteV4`, `groupGetInviteInfo`, `groupFetchAllParticipating`)
     - All newsletter/channel methods (`newsletterMetadata`, `newsletterFollow`, `newsletterUnfollow`, `newsletterReactMessage`, `newsletterFetchMessages`, `newsletterAction`, etc.)
     - All business/catalog/payment/USync methods (`getBusinessProfile`, `getCatalog`, `getOrderDetails`, `onWhatsApp`, `fetchStatus`, `profilePictureUrl`, `USyncQuery`, `executeUSyncQuery`)
   - Also expose helper aliases on `safeSock`:
     - `sock.uploadMedia(content, opts)` -> wraps `prepareWAMessageMedia(content, { upload: sock.waUploadToServer, ...opts })`
3. **Built-in High-Level Builders (`builders` object & global helper functions in Sandbox)** for Instant Construction of All Message Domains:
   Provide a `builders` toolkit (also exposed as top-level sandbox functions) supporting every WhatsApp message domain:
   - **Payment Pathways (`buildPaymentRequest`, `buildPaymentInvite`, `buildSendPayment`, `buildOrderMessage`, `buildNativeFlowPayment`)**:
     - `buildPaymentRequest({ amount1000, currencyCodeIso4217, noteText, requestFromJid, expiryTimestamp })` -> constructs a valid `requestPaymentMessage` with `currencyCodeIso4217` (default `'USD'` or `'SAR'`), `amount1000`, `requestFrom`, `noteMessage`, and `expiryTimestamp`.
     - `buildPaymentInvite({ serviceType, expiryTimestamp })` -> constructs `paymentInviteMessage: { serviceType: serviceType ?? 1, expiryTimestamp }`.
     - `buildOrderMessage({ orderId, itemCount, status, surface, message, orderTitle, sellerJid, token, totalAmount1000, totalCurrencyCode, thumbnail })` -> constructs a valid `orderMessage`.
     - `buildNativeFlowPayment({ title, body, footer, currency, totalAmountValue, referenceId, buttons })` -> constructs a `viewOnceMessage` -> `interactiveMessage` -> `nativeFlowMessage` with `payment_info` / `review_and_pay` parameters.
   - **Sticker & Sticker Pack Pathways (`buildStickerMessage`, `buildStickerPackMessage`, `sendSticker`, `sendStickerPack`)**:
     - `buildStickerMessage(webpBuffer, { isAnimated, isAvatar, isAiSticker, isLottie, mimetype })` -> uploads via `prepareWAMessageMedia` (or passes direct buffer to `sendMessage`) and constructs a complete `stickerMessage` with valid `mediaKey`, `directPath`, `fileSha256`, `fileEncSha256`, and `isAnimated`.
     - `buildStickerPackMessage({ name, publisher, packId, description, stickers, trayIconBuffer })` -> constructs a valid `stickerPackMessage` with `stickerPackId`, `name`, `publisher`, `packDescription`, and `stickers` array.
   - **Interactive, Carousel, List, Buttons & Status Pathways (`buildInteractiveMessage`, `buildCarouselMessage`, `buildListMessage`, `buildButtonsMessage`, `buildViewOnceMessage`)**:
     - Constructs protocol-compliant `interactiveMessage` (with `nativeFlowMessage`, `carouselMessage`, `shopStorefrontMessage`, or `collectionMessage`), `listMessage`, and `buttonsMessage` with valid `contextInfo` and `messageContextInfo`.

## Part 5: Smart Protocol Delivery Wrapper & Anti-Detection Engine (`SmartProtocolWrapper`)

### Why Custom Functions Trigger WhatsApp Server Blocks or Disconnections
When custom functions call `sock.relayMessage(jid, msgObj, opts)` or `sock.sendMessage(jid, content, opts)` in loops, WhatsApp's server-side anomaly detector flags them for four specific protocol anomalies:
1. Missing or non-standard `messageId` formats (instead of Baileys' `generateMessageIDV2(sock.user?.id)` `3EB0...` hash).
2. Missing `messageContextInfo.messageSecret` (32-byte random key) or missing `deviceListMetadataVersion: 2` on `relayMessage` payloads.
3. Missing `<biz><interactive><native_flow .../></interactive></biz>` `additionalNodes` when relaying interactive/button/list/payment-flow messages.
4. Uncached sent messages in `memoryStore` (so when the recipient's device sends an E2EE `<receipt type="retry">`, `getMessage(key)` returns `undefined`, causing failed decryption retries) and zero packet-spacing jitter (robotic `0ms` stanza bursts).

### Required Implementation of `SmartProtocolWrapper` in `src/function-lab/index.ts` and `src/whatsapp/connection-manager.ts`
When `smartWrap` is enabled (default `true`):
1. **Standardized v2 Message IDs**:
   - In `safeSock.relayMessage(target, messageObj, opts)`: if `opts?.messageId` is not provided, automatically generate one using `generateMessageIDV2(rawSocketTarget?.user?.id)` (or fallback to `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`) and assign `opts.messageId`.
2. **Automatic `messageContextInfo` & `deviceListMetadata` Injection**:
   - When `relayMessage` is called with an object that lacks `messageContextInfo` (and is not a raw `reactionMessage` or `protocolMessage`), clone the top-level message object and attach a compliant `messageContextInfo`:
     ```ts
     messageContextInfo: {
       deviceListMetadata: {},
       deviceListMetadataVersion: 2,
       messageSecret: crypto.randomBytes(32),
       ...(existingContextInfo || {}),
     }
     ```
3. **Automatic `<biz>` Interactive Node Attachment**:
   - Inspect the `messageObj` passed to `relayMessage` (including inside `viewOnceMessage` / `viewOnceMessageV2` / `viewOnceMessageV2Extension` / `ephemeralMessage` / `documentWithCaptionMessage`).
   - If it contains `interactiveMessage`, `buttonsMessage`, or `listMessage` and `opts.additionalNodes` is not already specified, automatically attach the appropriate `additionalNodes` required by WhatsApp Web protocol so the server routes the message cleanly without flagging malformed interactive stanzas.
4. **Adaptive Micro-Jitter & Presence Shaping**:
   - Maintain a per-session `lastStanzaSentAt` timestamp and a `warmedTargets` set inside the execution context.
   - On the first send to a user JID (`@s.whatsapp.net`), resolve the JID once via `resolveDirectRecipientJid` and fire a non-blocking `presenceSubscribe` + subtle `composing` presence pulse.
   - Between rapid consecutive socket sends (`sendMessage` / `relayMessage`), apply a subtle micro-jitter (`25ms` to `65ms` randomized spacing when sends occur back-to-back within `<20ms`, plus `±20%` randomized jitter on `stepDelayMs` between loop iterations) so network timestamps never exhibit a synthetic constant delta.
5. **Automatic `memoryStore.cacheSentMessage` & Credential Flush**:
   - In `AthanasiaBaileysSessionDriver.runSandboxedTestFunction` (`src/whatsapp/connection-manager.ts`), inside both `liveAdapter.sendMessage` and `liveAdapter.relayMessage`:
     - Cache every outgoing message in `this.memoryStore.cacheSentMessage(targetJid, msgId, messageObj)` so recipient E2EE retry requests (`getMessage`) always succeed!
     - After each iteration (and at the end of `runSandboxedTestFunction`), flush `await Promise.allSettled([this.credsSaveChain, this.flushAuthWrites()])` so newly established Signal sessions and Sender Keys are persisted atomically to disk.

## Verification Requirements
1. Update or adjust any unit/integration tests in `tests/` that previously asserted the old `maxSends: 500` default or the removed experimental built-in probe functions so that `npm test` passes 100%.
2. Verify `npx tsc --noEmit` compiles cleanly with zero TypeScript errors.
