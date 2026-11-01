# الماستر برومبت التوجيهي الشامل لتطوير مشروع Botezz (مختبر الدوال الشامل + مكالمات الفيديو البروتوكولية + قسم استقبال الرسائل + قسم تحميلات الحالات)

انسخ النص التوجيهي التالي بالكامل والصقه مباشرة في **Google AI Studio** مع إرفاق ملفات المشروع:

---

## نص الماستر برومبت (Master Prompt)

أنت مهندس برمجيات رئيسي (Principal Systems & Protocol Architect) ومطور خبير في بروتوكولات واتساب (`athanasia-baileys` / WhatsApp Multi-Device WebSocket & BinaryNode Protocol) وبوتات تيليجرام التفاعلية (`grammY` + `TypeScript` + `Next.js 15` + `node:sqlite`).

أمامك الكود المصدري الكامل لمشروع **Botezz**. المطلوب منك تنفيذ **تحديث هندسي عميق، شامل، ودقيق جداً** يغطي 4 محاور رئيسية مع الحفاظ الكامل على استقرار الجلسات، تعدد المستخدمين (Multi-Tenant Isolation)، ونظام الرسالة التفاعلية الواحدة (`BotUiStateManager`)، ونجاح جميع الاختبارات (`npm test` و `npm run build`).

يُمنع منعاً باتاً حذف أي ميزة عاملة حالياً أو وضع أكواد وهمية (Placeholders / TODOs). يجب كتابة الكود الفعلي الكامل لكل ملف يتم تعديله أو إنشاؤه.

---

### المحور الأول: التطوير الجذري والشامل لمختبر الدوال (`src/function-lab/index.ts` و `src/bot/handlers/tools.ts`)

المطلوب جعل **مختبر الدوال (`/testfunction`)** قادراً على تشغيل **أي دالة واتساب مهما كان مصدرها أو هيكلها أو المسار البروتوكولي الذي تستخدمه بدون أي استثناء**، مع تزويده بأدوات بناء الصور والملصقات، وإضافة ميزة رفع ملف الدالة لحفظها باسم مخصص وتشغيلها لاحقاً بالاسم.

#### 1. تزويد البيئة المعزولة (`VM Sandbox`) بأدوات بناء الصور والملصقات والوسائط (`Media & Sticker Creation Toolkit`)
في ملف `src/function-lab/index.ts`، قم ببناء وحقن محرك متكامل لبناء وتوليد الصور والملصقات والوسائط داخل الـ Sandbox (بدون الحاجة لمحركات خارجية معقدة، مع دعم المكتبات المثبتة إن وجدت وتوفير بدائل Pure-JS/Buffer أصلية مضمونة 100%):
- **`imageBuilder` / `stickerBuilder` (متاحة ككائنات عامة وكدوال مباشرة في الـ Sandbox):**
  - `createSolidImagePng(width, height, rgbaColor)` و `createGradientImagePng(width, height, color1, color2)`: توليد Buffer لصورة PNG صالحة بـترويسة `IHDR` و `IDAT` مضغوطة عبر `zlib.deflateSync` و `IEND` مع حساب `CRC32` الدقيق، بحيث يمكن لأي دالة توليد صور حقيقية بأي أبعاد فوراً داخل الذاكرة.
  - `createMinimalJpegThumbnail(width, height, quality)`: توليد Buffer لصورة JPEG صالحة كاملة الترويسات (`SOI`, `APP0/JFIF`, `DQT`, `SOF0`, `DHT`, `SOS`, `EOI`) لاستخدامها في `jpegThumbnail` داخل رسائل واتساب (`extendedTextMessage`, `imageMessage`, `videoMessage`, `locationMessage`, `orderMessage`, `productMessage`) دون أن يرفضها خادم واتساب.
  - `createWebpSticker(inputBufferOrOptions, metadata?)`: تحويل أو تغليف أي Buffer صورة أو توليد ملصق `RIFF....WEBP` قياسي (ثابت `VP8 ` أو متحرك `VP8X` + `ANIM` + `ANMF`) مع دعم حقن بيانات **EXIF للملصقات (`EXIF` chunk في WebP)** التي تحتوي على:
    - `sticker-pack-id`
    - `sticker-pack-name`
    - `sticker-pack-publisher`
    - `emojis`
    بحيث يظهر اسم الحزمة والناشر رسمياً عند الضغط على الملصق داخل واتساب.
  - `createStickerPackZip(stickers, packMeta)`: بناء حزمة ملصقات كاملة (`stickerPackMessage`) متوافقة مع بروتوكول واتساب شاملة أيقونة الحزمة (`tray.png`) وملفات `.webp` وحساب `fileSha256` و `fileEncSha256` و `mediaKey`.
  - `createVoicePttWaveform(barsCount = 64)`: توليد `Uint8Array` (64 بايت بقيم 0..100) لتمريرها في `audioMessage.waveform` للبصمات الصوتية (`ptt: true`).
  - `createSilentOggOpusBuffer(durationSeconds)`: توليد Buffer صوتي صالح بترويسة `OggS` / `OpusHead` لاستخدامه في دوال الرسائل الصوتية الفورية.

#### 2. حقن نظام `require` ذكي وشامل داخل الـ Sandbox (`createSandboxRequire`)
الكثير من الدوال الخارجية تستخدم `const ... = require(...)` داخل جسم الدالة أو في أعلاها. قم بحقن دالة `require(moduleName)` ذكية داخل `sandbox` في `src/function-lab/index.ts` تدعم:
- جميع مسميات مكتبات Baileys بدون استثناء:
  - `'athanasia-baileys'`
  - `'@whiskeysockets/baileys'`
  - `'@adiwajshing/baileys'`
  - `'baileys'`
  وتُرجع كائن `Baileys` الكامل مدعماً بجميع دوال `WABinary` و `proto` و `builders` و `prepareWAMessageMedia` المربوط تلقائياً بالمقبس النشط.
- مكتبات Node.js القياسية الآمنة: `'crypto'`, `'node:crypto'`, `'buffer'`, `'node:buffer'`, `'util'`, `'node:util'`, `'stream'`, `'node:stream'`, `'events'`, `'node:events'`, `'url'`, `'node:url'`, `'path'`, `'node:path'`, `'zlib'`, `'node:zlib'`, `'querystring'`.
- نظام ملفات افتراضي آمن (`'fs'`, `'node:fs'`): يسمح بقراءة وكتابة الملفات داخل مجلد مؤقت معزول خاص بالمختبر (`./data/tmp/flab-sandbox/`) مع منع صارم لأي محاولة خروج عن المجلد (Path Traversal Guard)؛ وإذا طلبت الدالة `fs.readFileSync` لملف صورة/فيديو/صوت غير موجود، يقوم بإرجاع Buffer افتراضي صالح حسب الامتداد (`.jpg`, `.png`, `.webp`, `.mp4`, `.ogg`, `.pdf`) بدلاً من إسقاط الدالة بخطأ `ENOENT`!
- مكتبات الشبكة والوسائط الشائعة:
  - `'axios'` و `'node-fetch'`: محول متوافق مبني فوق `fetch` الأصلي يدعم `axios.get(url, { responseType: 'arraybuffer' })` و `axios.post(...)`.
  - `'sharp'` و `'jimp'` و `'canvas'` و `'wa-sticker-formatter'`: محولات (Adapters) مبنية فوق `imageBuilder` و `stickerBuilder` بحيث إذا استدعت أي دالة خارجية `sharp(buf).resize(512, 512).webp().toBuffer()` أو `new Sticker(buf, { pack, author }).toBuffer()` تعمل فوراً وتُرجع `Buffer` لصورة WebP/PNG/JPEG صالحة دون رمي خطأ عدم وجود المكتبة.

#### 3. تغطية كافة مسارات وبروتوكولات الإرسال في واتساب (100% من طرق الإرسال بدون استثناء)
في `src/function-lab/index.ts` و `src/whatsapp/connection-manager.ts`:
- قم بتوسيع `createSafeSock` و `baseSafeSock` و `FunctionValidator` لدعم جميع مسارات الإرسال في بروتوكول واتساب:
  1. **المسار الأول (`sock.sendMessage`):** دعم كافة الحمولات (`text`, `image`, `video`, `ptv`, `audio`, `ptt`, `document`, `sticker`, `stickerPack`, `location`, `liveLocation`, `contacts`, `poll`, `react`, `edit`, `delete`, `viewOnce`, `viewOnceV2`, `ephemeralExpiration`, `mentions`, `contextInfo`).
  2. **المسار الثاني (`sock.relayMessage`):** دعم جميع رسائل `proto.IMessage` المعقدة (`interactiveMessage`, `nativeFlowMessage`, `carouselMessage`, `buttonsMessage`, `listMessage`, `templateMessage`, `requestPaymentMessage`, `sendPaymentMessage`, `paymentInviteMessage`, `orderMessage`, `productMessage`, `scheduledCallCreationMessage`, `callLogMesssage`, `bcallMessage`, `newsletterAdminInviteMessage`, `groupInviteMessage`, `eventMessage`, `pollCreationMessageV3`, `pollResultSnapshotMessage`, `albumMessage`, `stickerPackMessage`, `lottieStickerMessage`, `botInvokeMessage`).
  3. **المسار الثالث (`sock.sendNode` و `sock.query` — BinaryNode Stanzas):** دعم إرسال واستعلام العقد الثنائية المباشرة (`BinaryNode`: `<message>`, `<iq>`, `<call>`, `<presence>`, `<receipt>`, `<notification>`) مع احتسابها في عداد الإرسال (`sendCount`) ودعمها في وضعي `LIVE` و `DRY_RUN` / `SIMULATION`.
  4. **المسار الرابع (`prepareWAMessageMedia` و `sock.waUploadToServer`):**
     - في كثير من الدوال الخارجية، يتم استدعاء `await prepareWAMessageMedia({ image: ... }, { upload: sock.waUploadToServer })` أو حتى بدون تمرير `upload`.
     - تأكد أن `sock.waUploadToServer` معرف دائماً كدالة جاهزة على `safeSock`، وأن `prepareWAMessageMedia` المحقونة في الـ Sandbox تقوم تلقائياً بحقن `upload: safeSock.waUploadToServer` إذا لم يمررها الكود أو إذا كانت غير صالحة، مع تحويل أي Buffer أو URL أو مسار ملف بسلاسة.
  5. **المسار الخامس (`generateWAMessageFromContent` و `generateWAMessage` و `generateWAMessageContent`):**
     - قم بتغليف هذه الدوال في الـ Sandbox بحيث تحقن تلقائياً `userJid: sock.user?.id || '0@s.whatsapp.net'` و `upload: safeSock.waUploadToServer` إذا أغفلتها الدالة، وتُطبع `targetJid` تلقائياً.
  6. **المسار السادس (`WABinary` & Crypto Helpers):**
     - قم بتصدير وحقن أدوات العقد الثنائية والتشفير داخل الـ Sandbox: `encodeBinaryNode`, `decodeBinaryNode`, `getBinaryNodeChild`, `getBinaryNodeChildren`, `getAllBinaryNodeChildren`, `getBinaryNodeChildBuffer`, `getBinaryNodeChildString`, `jidDecode`, `jidEncode`, `jidNormalizedUser`, `areJidsSameUser`, `isJidGroup`, `isJidStatusBroadcast`, `isJidNewsletter`, `isLidUser`, `isPnUser`.
  7. **تحديث `SmartProtocolWrapper`:**
     - لا تقم أبداً بإتلاف أو الكتابة فوق `additionalNodes` أو `messageContextInfo` إذا كانت الدالة نفسها قد بنتها يدوياً، بل قم بدمج الحقول الناقصة فقط بذكاء (`merge` وليس `overwrite`).
     - دعم استدعاء الدوال بأي اسم معامل (`sock`, `client`, `conn`, `ptz`, `ryn`, `wa`, `bot`, `hisoka`, `x`, `target`, `jid`, `to`, `nomor`, `m`, `chatId`) وبأي ترتيب للمعاملات، ودعم الدوال التي تحتوي على عدة دوال مساعدة قبل أو بعد الدالة الرئيسية، ودعم `module.exports = ...` و `export default ...`.

#### 4. ميزة زر "📤 رفع ملف الدالة لحفظها" وتسميتها وتشغيلها بالاسم (`Upload Function File to Save & Run by Name`)
في `src/bot/handlers/tools.ts` و `src/bot/bot.ts`:
- أضف زراً واضحاً في لوحة مختبر الدوال (`promptTestFunction`) وفي مكتبة الدوال (`renderFunctionCatalog`) باسم:
  - **`📤 رفع ملف دالة لحفظها`** (`callbackData: 'tools:flab_prompt_upload_save'`)
- أضف حالات الإدخال التالية في `ToolsInputStep`:
  - `'AWAITING_UPLOAD_FUNCTION_FILE'`
  - `'AWAITING_UPLOADED_FUNCTION_NAME'`
  - `'AWAITING_RUN_SAVED_FUNCTION_PARAMS'`
- أضف خريطة مؤقتة في `ToolsHandler`:
  `private readonly stagedUploadedFunctionByAdmin = new Map<number, { originalFileName: string; normalizedCode: string; detectedFuncName: string }>();`
- **مسار العمل الدقيق خطوة بخطوة:**
  1. عند ضغط المستخدم على زر **`📤 رفع ملف دالة لحفظها`** (`tools:flab_prompt_upload_save`):
     - يضبط البوت حالة الأدمن في `ToolsHandler` على `AWAITING_UPLOAD_FUNCTION_FILE` وفي `TelegramBotController` على `TOOLS`.
     - يعرض رسالة واضحة تطلب من المستخدم إرسال ملف الدالة (`.js`, `.ts`, `.mjs`, `.cjs`, `.txt`) أو لصق كود الدالة.
  2. عندما يرفع المستخدم ملف الدالة:
     - يستقبله `handleMediaUpload` في `src/bot/bot.ts` ويمرره إلى `toolsHandler.handleCodeFileUpload`.
     - يتحقق `ToolsHandler` من أن الحالة هي `AWAITING_UPLOAD_FUNCTION_FILE` (أو أن المستخدم رفع ملف كود بدون أمر تشغيل مباشر).
     - يقوم بفحص وتطبيع الكود عبر `this.functionValidator.parseAndValidateSource(codeText)`.
     - يحفظ الكود المفحوص مؤقتاً في `stagedUploadedFunctionByAdmin.set(adminId, { originalFileName, normalizedCode, detectedFuncName })`.
     - ينقل الحالة إلى `AWAITING_UPLOADED_FUNCTION_NAME` ويعرض للمستخدم رسالة:
       *"✅ تم استلام وفحص ملف الدالة (`filename.js`) بنجاح!\n🔍 الاسم المكتشف في الكود: `detectedFuncName`\n\n✏️ **أرسل الآن الاسم الذي تريد حفظ الدالة به** (أو اضغط على الزر أدناه لاعتماد الاسم المكتشف تلقائياً):"*
       مع زر تفاعلي: `✅ حفظ بالاسم (${detectedFuncName})` (`callbackData: 'tools:flab_confirm_upload_name'`).
  3. عندما يرسل المستخدم الاسم المطلوب (أو يضغط زر الاعتماد التلقائي):
     - يتم حفظ الدالة في قاعدة البيانات عبر `this.functionRegistry.registerFunction({ name: chosenName, sourceCode, createdBy: adminId, allowUpdateExisting: true })`.
     - يتم تعيينها كدالة نشطة، وعرض رسالة تأكيد الحفظ مع أزرار فورية:
       - `🚀 تشغيل الدالة الآن (${chosenName})` (`callbackData: 'tools:flab_prompt_run:' + chosenName`)
       - `🧪 فحص جاف (${chosenName})` (`callbackData: 'tools:flab_dryrun:' + chosenName`)
       - `📚 دوالي المحفوظة` (`callbackData: 'tools:flab_catalog'`)
  4. **تشغيل أي دالة محفوظة بالاسم:**
     - عبر الأمر المباشر: `/testfunction <phone> <count> <SavedName>`
     - أو من داخل `📚 دوالي المحفوظة`: أضف بجانب كل دالة محفوظة زر **`🚀 تشغيل (${fn.name})`** (`callbackData: 'tools:flab_prompt_run:' + fn.name`) يطلب من المستخدم فقط `<رقم الهاتف> <العدد>` (مثلاً `+966501234567 5`) ثم يشغل الدالة المحفوظة بالاسم فوراً!

---

### المحور الثاني: إعادة هيكلة وبناء قسم مكالمات الفيديو بالكامل بدون محرك خارجي (`src/whatsapp/video-call-bridge.ts` و `src/bot/workflows/video-call-workflow.ts`)

#### 1. تشخيص المشاكل والتناقضات الحالية التي يجب إزالتها نهائياً
في الكود الحالي (`UbuntuVideoCallBridge` في `src/whatsapp/video-call-bridge.ts`):
- يعتمد القسم على محرك خارجي معقد وغير عملي (`v4l2loopback` `/dev/video0` + `FFmpeg` + محاكي أندرويد خارجي عبر `adb`).
- عند عدم توفر `/dev/video0` و `adb`، يسقط في تناقض صارخ حيث يرسل مجرد رسالة فيديو دائرية عادية (`ptv: true`) بينما يوهم المستخدم في الواجهة أنه في "بث مكالمة مرئية حية"، ثم يقوم المؤقت بحذف الملف بعد 15 ثانية!
- **المطلوب:** إلغاء الاعتماد على أي محرك خارجي (`v4l2loopback` و `adb` و `setup-ubuntu-video-engine.sh`) بشكل كامل، وإعادة بناء القسم ليعتمد 100% على **عقد بروتوكول واتساب الأصلية والمعدلة في `athanasia-baileys` (`Native Protocol Fake Video/Voice Call Engine`)**.

#### 2. الهندسة الجديدة لقسم المكالمات المرئية والصوتية المزيفة (`src/whatsapp/video-call-bridge.ts`)
أعد بناء الملف بالكامل ليعمل كمحرك بروتوكولي داخلي خالص (**Zero External Engine Dependency**) تحتفظ فيه بتصدير الفئة `UbuntuVideoCallBridge` (أو `NativeVideoCallEngine` مع إبقاء الاسم البديل `UbuntuVideoCallBridge` للتوافق مع الاستيرادات والاختبارات)، بحيث ينفذ المكالمات عبر مقبس `athanasia-baileys` مباشرة بثلاثة أطوار بروتوكولية حقيقية:

1. **الطور الأول: رنين مكالمة فيديو/صوت بروتوكولي مباشر (`NATIVE_CALL_OFFER_RING`):**
   - يستخدم دالة جديدة في `WhatsAppSessionDriver` (`sendNativeCallOffer` و `terminateNativeCall`) مبنية مباشرة فوق `sock.sendNode` / `sock.query` في `athanasia-baileys`:
   - يقوم بتوليد `callId = crypto.randomBytes(16).toString('hex').toUpperCase()` وإرسال عقدة `<call>` ثنائية (BinaryNode) أصلية إلى `targetJid`:
     ```ts
     const callNode = {
       tag: 'call',
       attrs: {
         to: resolvedTargetJid,
         id: sock.generateMessageTag ? sock.generateMessageTag() : `call_${Date.now()}`,
         from: sock.user?.id || sock.authState?.creds?.me?.id || '',
       },
       content: [
         {
           tag: 'offer',
           attrs: {
             'call-id': callId,
             'call-creator': sock.user?.id || sock.authState?.creds?.me?.id || '',
           },
           content: [
             ...(isVideo
               ? [
                   {
                     tag: 'video',
                     attrs: {
                       enc: 'vp8',
                       dec: 'vp8',
                       orientation: '0',
                       'screen_width': '1280',
                       'screen_height': '720',
                       'device_orientation': '0',
                     },
                   },
                 ]
               : []),
             {
               tag: 'audio',
               attrs: { enc: 'opus', rate: '16000' },
             },
             {
               tag: 'net',
               attrs: { medium: '3' },
             },
             {
               tag: 'capability',
               attrs: { ver: '1' },
               content: new Uint8Array([1, 4, 255, 131, 207, 4]),
             },
             {
               tag: 'enc',
               attrs: { opt: '2', type: 'pkmsg', v: '2' },
               content: crypto.randomBytes(64),
             },
           ],
         },
       ],
     };
     await sock.sendNode(callNode);
     ```
   - يدعم خيار **تكرار الرنين (Loop Ringing / Multi-Wave Offer)** خلال مدة المكالمة المحددة (`maxDurationSec`) أو إرسال عقدة `<terminate call-id="..." call-creator="...">` عند ضغط المستخدم على زر **"🛑 إنهاء المكالمة"** أو انتهاء المدة.

2. **الطور الثاني: بطاقة مكالمة فيديو مجدولة وسجل مكالمة بروتوكولي (`SCHEDULED_AND_CALL_LOG_PROTOCOL`):**
   - يرسل عبر `sock.relayMessage` رسائل بروتوكول المكالمات الأصلية المدعومة في `proto.IMessage`:
     - `scheduledCallCreationMessage`: `{ scheduledTimestampMs: Date.now(), callType: isVideo ? 2 : 1, title: callTitle }`
     - `callLogMesssage`: `{ isVideo, callOutcome: 1, durationSecs: maxDurationSec, participants: [{ jid: resolvedTargetJid }] }`

3. **الطور الثالث: المكالمة المرئية الهجينة (رنين مكالمة فيديو + بث الفيديو المسجل `HYBRID_CALL_OFFER_AND_PTV`):**
   - إذا قام المستخدم برفع ملف فيديو (أو اختار الفيديو التجريبي)، يجمع المحرك بين إرسال عقدة رنين المكالمة المرئية `<call><offer><video/></offer></call>` وبين تسليم البث المرئي الفوري (`ptvMessage` / `videoMessage`) بدون أي حاجة لـ `FFmpeg` أو `/dev/video0` أو `adb`!

#### 3. تحديث سير عمل قسم المكالمات المرئية (`src/bot/workflows/video-call-workflow.ts`)
- أعد تصميم `VideoCallWorkflow` ليكون سلساً وخالياً من أي تناقضات:
  - بعد إدخال رقم الهاتف المستهدف، امنح المستخدم خيارين واضحين فوراً:
    1. **`📞 بدء رنين مكالمة فيديو فوري (بدون رفع ملف)`** (`callbackData: 'wf_vcall:instant_ring_video'`)
    2. **`🔊 بدء رنين مكالمة صوتية فوري (بدون رفع ملف)`** (`callbackData: 'wf_vcall:instant_ring_voice'`)
    3. **`🎬 رفع ملف فيديو للمكالمة الهجينة (رنين + بث مرئي)`** (أو استخدام `sample_call.mp4` الصالح).
  - أضف زر اختيار وضع المكالمة البروتوكولي (`NATIVE_CALL_OFFER_RING` | `HYBRID_CALL_OFFER_AND_PTV` | `SCHEDULED_AND_CALL_LOG_PROTOCOL`) وزر التحكم في عدد موجات الرنين (`wavesCount`: 1، 3، 5، 10).
  - لا تقم بحذف ملف الفيديو المرفوع أثناء جلسة المستخدم النشطة إلا عند إلغاء العملية بالكامل أو الخروج، لكي يتمكن من إعادة الاتصال أو تكرار البث بدون أخطاء `ENOENT`.

---

### المحور الثالث: بناء قسم استقبال الرسائل الشامل (`Incoming Messages Receiver & Auto-Archiver`)

المطلوب إضافة قسم جديد متكامل في البوت لتحميل وحفظ وعرض **جميع الرسائل الواردة إلى أرقام الجلسات المربوطة تلقائياً** أياً كان نوعها، وتحويل كل رسالة إلى ملف مناسب قابل للتحميل والإرسال الفوري إلى تيليجرام.

#### 1. قاعدة البيانات (`src/database/migrations/006_inbox_statuses_and_native_calls.ts` + `src/database/repositories/inbox-repository.ts`)
أنشئ ترحيل قاعدة بيانات جديد `006_inbox_statuses_and_native_calls.ts` وسجله في `src/database/database.ts`، يحتوي على جدول `incoming_messages`:
- الأعمدة:
  - `id TEXT PRIMARY KEY`
  - `session_id TEXT NOT NULL`
  - `owner_telegram_id INTEGER NOT NULL DEFAULT 0`
  - `message_id TEXT NOT NULL`
  - `remote_jid TEXT NOT NULL`
  - `sender_jid TEXT NOT NULL`
  - `sender_name TEXT`
  - `is_group INTEGER NOT NULL DEFAULT 0`
  - `category TEXT NOT NULL` (مثل: `plain_text`, `extended_text`, `quoted_message`, `image`, `video`, `gif_video`, `voice_ptt`, `audio`, `sticker`, `animated_sticker`, `sticker_pack`, `location`, `live_location`, `contact`, `contact_list`, `document`, `poll_creation`, `reaction`, `interactive_buttons`, `list_message`)
  - `raw_content_type TEXT NOT NULL`
  - `text_content TEXT`
  - `file_path TEXT` (المسار الكامل للملف المحفوظ على القرص بعد التحميل أو التوليد)
  - `file_name TEXT`
  - `mime_type TEXT`
  - `file_size_bytes INTEGER NOT NULL DEFAULT 0`
  - `metadata_json TEXT NOT NULL DEFAULT '{}'`
  - `forwarded_to_telegram INTEGER NOT NULL DEFAULT 0`
  - `received_at TEXT NOT NULL`

#### 2. محرك الاستقبال والتحويل التلقائي لكل أنواع الرسائل (`src/whatsapp/incoming-message-receiver.ts`)
أنشئ خدمة `IncomingMessageReceiver` ترتبط بحدث `messages.upsert` في جميع الجلسات المتصلة (`AthanasiaBaileysSessionDriver` و `MockWhatsAppSessionDriver`) وتلتقط كل رسالة واردة (`!msg.key.fromMe` و `!isJidStatusBroadcast(remoteJid)`):
- **تحويل وحفظ كل نوع رسالة كملف مناسب في `./data/downloads/inbox/<sessionId>/`:**
  1. **الرسائل النصية والممتدة والمقتبسة (`plain_text`, `extended_text`, `quoted_message`):**
     - يتم حفظ النص الكامل في قاعدة البيانات، كما يتم توليد ملف نصي منسق `.txt` (يحتوي على: معرف الرسالة، الجلسة، رقم واسم المرسل، التاريخ والوقت، الرسالة المقتبسة إن وجدت، ومعاينة الروابط، والنص الكامل) ليكون جاهزاً للتحميل كملف في أي لحظة.
  2. **الصور (`imageMessage`):**
     - يتم فك تشفيرها وتحميلها تلقائياً عبر `downloadMediaMessage` وحفظها كملف `.jpg` أو `.png` أصلي.
  3. **الفيديو والملاحظات المرئية والـ GIF (`videoMessage`, `ptvMessage`):**
     - يتم تحميلها تلقائياً وحفظها كملف `.mp4` أصلي.
  4. **الصوت والبصمات الصوتية (`audioMessage`):**
     - يتم تحميلها تلقائياً وحفظها كملف `.ogg` أو `.mp3`.
  5. **الملصقات الثابتة والمتحركة (`stickerMessage`):**
     - يتم تحميلها تلقائياً وحفظها كملف `.webp` أصلي.
  6. **حزم الملصقات (`stickerPackMessage`):**
     - يتم تحميل بيانات الحزمة أو ملفها المشفر عبر `downloadMediaMessage` / `downloadContentFromMessage`، وإنشاء ملف حزمة كامل (`.zip` أو `.json` + `.webp`) يحتوي على كافة ملصقات الحزمة وبياناتها (`name`, `publisher`, `packId`, `stickers`).
  7. **المواقع الجغرافية الثابتة والمباشرة (`locationMessage`, `liveLocationMessage`):**
     - يتم استخراج خط العرض (`degreesLatitude`) وخط الطول (`degreesLongitude`) والاسم والعنوان، وتوليد ملف موقع مزدوج/مناسب (`.geojson` أو `.txt` يحتوي على الإحداثيات الدقيقة + رابط Google Maps المباشر `https://maps.google.com/?q=lat,lng` + بيانات `loc`).
  8. **جهات الاتصال المفردة والمتعددة (`contactMessage`, `contactsArrayMessage`):**
     - يتم استخراج محتوى `vcard` بالكامل وحفظه كملف بطاقة جهة اتصال قياسي `.vcf` صالح للاستيراد المباشر في الهاتف أو تيليجرام.
  9. **المستندات والملفات (`documentMessage`, `documentWithCaptionMessage`):**
     - يتم تحميلها وحفظها باسمها وامتدادها الأصلي الآمن (`sanitizeFileName`).
  10. **الاستطلاعات، التفاعلات، والرسائل التفاعلية (`pollCreationMessage`, `reactionMessage`, `interactiveMessage`, `buttonsMessage`, `listMessage`):**
      - يتم حفظ تفاصيلها الكاملة في ملف `.json` / `.txt` منظم يوضح العنوان والخيارات والبيانات البروتوكولية.

#### 3. واجهة قسم استقبال الرسائل في تيليجرام (`src/bot/handlers/inbox.ts`)
- أضف زر **`📥 قسم استقبال الرسائل`** (`callbackData: 'menu:inbox:page:1'`) في القائمة الرئيسية (`src/bot/keyboards/main-menu.ts`) والأمر السريع `/inbox`.
- يوفر القسم الميزات التالية:
  - عرض إحصائيات الرسائل المستقبلة (الإجمالي، الوسائط المحملة، الرسائل النصية، الحجم الإجمالي).
  - زر **`⚡ التحويل التلقائي للرسائل الواردة إلى تيليجرام: مفعل ✅ / معطل ❌`** (`callbackData: 'inbox:toggle_autoforward'`): عند تفعيله، يقوم البوت فور وصول أي رسالة لأي جلسة مربوطة بتحميلها وإرسالها تلقائياً إلى المستخدم في تيليجرام كملف مناسب (صورة/فيديو/ملصق/صوت/مستند `.vcf`/`.geojson`/`.txt`) مع بطاقة بيانات المرسل والجلسة!
  - قائمة متصفحة (`Pagination`) بآخر الرسائل الواردة مع فلترة حسب الجلسة أو النوع (`الكل` | `وسائط وصور` | `ملصقات` | `نصوص ومواقع وجهات اتصال`).
  - عند الضغط على أي رسالة واردة (`inbox:view:<id>`)، يعرض البوت تفاصيلها الكاملة مع زر **`📤 إرسال/تحميل الملف في تيليجرام`** (`inbox:download:<id>`) الذي يرسل الملف الفعلي المحفوظ إلى محادثة تيليجرام مباشرة.
  - زر **`📦 محاكاة استقبال رسائل متنوعة (للفحص)`** (`inbox:simulate_batch`) في بيئة المحاكاة ليتمكن المستخدم من اختبار استقبال (نص + صورة + ملصق + حزمة ملصقات + موقع + جهة اتصال) وتحميل ملفاتها فوراً.

---

### المحور الرابع: بناء قسم تحميلات الحالات (`WhatsApp Status / Stories Viewer & Downloader`)

المطلوب إضافة قسم جديد متكامل في البوت لرؤية وتحميل حالات واتساب (`status@broadcast`) الخاصة بجهات اتصال الجلسات المربوطة.

#### 1. قاعدة البيانات ومستودع الحالات (`captured_statuses` في الترحيل `006` + `src/database/repositories/status-repository.ts`)
أنشئ جدول `captured_statuses`:
- الأعمدة:
  - `id TEXT PRIMARY KEY`
  - `session_id TEXT NOT NULL`
  - `owner_telegram_id INTEGER NOT NULL DEFAULT 0`
  - `status_message_id TEXT NOT NULL`
  - `participant_jid TEXT NOT NULL` (صاحب الحالة)
  - `participant_phone TEXT NOT NULL`
  - `participant_name TEXT` (`pushName`)
  - `media_kind TEXT NOT NULL` (`text` | `image` | `video` | `audio`)
  - `caption_or_text TEXT`
  - `file_path TEXT`
  - `file_name TEXT`
  - `mime_type TEXT`
  - `file_size_bytes INTEGER NOT NULL DEFAULT 0`
  - `background_argb INTEGER`
  - `font_type INTEGER`
  - `forwarded_to_telegram INTEGER NOT NULL DEFAULT 0`
  - `posted_at TEXT NOT NULL`

#### 2. محرك رصد وتحميل الحالات التلقائي (`src/whatsapp/status-downloader.ts`)
أنشئ خدمة `StatusDownloaderService` تستمع إلى جميع الرسائل الواردة التي يكون فيها `remoteJid === 'status@broadcast'` أو `isJidStatusBroadcast(remoteJid)`:
- عند وصول أي حالة جديدة:
  - يستخرج رقم واسم صاحب الحالة (`msg.key.participant` و `msg.pushName`).
  - إذا كانت الحالة **صورة (`imageMessage`)** أو **فيديو (`videoMessage`)** أو **صوت (`audioMessage`)**: يقوم تلقائياً بفك تشفيرها وتحميلها عبر `downloadMediaMessage` وحفظها في `./data/downloads/statuses/<sessionId>/` بالامتداد الصحيح (`.jpg`, `.mp4`, `.ogg`).
  - إذا كانت الحالة **نصية (`extendedTextMessage` / `conversation`)**: يقوم بحفظ النص الكامل وتوليد ملف بطاقة حالة نصية (`.txt` + صورة بطاقة الحالة `.png` عبر `imageBuilder`) بحيث يمكن رؤيتها وتحميلها كملف أيضاً.
  - إذا كان خيار **التحميل والإرسال التلقائي للحالات (`status_auto_forward`)** مفعلاً، يرسل الحالة المحملة مع بيانات صاحبها مباشرة إلى المستخدم في تيليجرام.

#### 3. واجهة قسم تحميلات الحالات في تيليجرام (`src/bot/handlers/stories.ts`)
- أضف زر **`⭕ قسم تحميلات الحالات`** (`callbackData: 'menu:stories:page:1'`) في القائمة الرئيسية (`src/bot/keyboards/main-menu.ts`) والأمر السريع `/stories` أو `/statusdl`.
- يوفر القسم الميزات التالية:
  - عرض قائمة الحالات المرصودة مرتبة من الأحدث إلى الأقدم مع اسم ورقم ناشر الحالة، نوع الحالة (🖼️ صورة، 🎬 فيديو، 🎵 صوت، 📝 نص)، وقت النشر، والوصف (`caption`).
  - فلترة الحالات حسب نوعها أو حسب رقم/جهة الاتصال.
  - زر **`📥 تحميل وإرسال الحالة إلى المحادثة`** (`stories:download:<id>`) لكل حالة، يقوم بإرسال ملف الصورة/الفيديو/الصوت الفعلي إلى المستخدم في تيليجرام.
  - زر **`📦 تحميل كل حالات جهة الاتصال`** (`stories:download_contact:<participantPhone>`).
  - زر **`⚡ التحميل والإرسال التلقائي للحالات فور نشرها: مفعل ✅ / معطل ❌`** (`stories:toggle_autoforward`).
  - زر **`🧪 توليد حالات تجريبية للمعاينة`** (`stories:simulate_batch`) لاختبار عرض وتحميل الحالات (صورة، فيديو، نص) في وضع المحاكاة.

---

### المحور الخامس: دعم إرسال الملفات الفعلية عبر `TelegramMessageTransport` وتحديث الواجهات والاختبارات

1. **توسيع `TelegramMessageTransport` في `src/bot/ui-state.ts` و `src/bot/bot.ts`:**
   - أضف في `TelegramMessageTransport` و `BotViewResponse` خاصية اختيارية `mediaAttachments?: Array<{ kind: 'document' | 'photo' | 'video' | 'audio' | 'sticker'; filePath?: string; buffer?: Buffer; fileName: string; mimeType?: string; caption?: string }>` بحيث عندما يطلب المستخدم تحميل رسالة واردة من `📥 قسم استقبال الرسائل` أو تحميل حالة من `⭕ قسم تحميلات الحالات`، يقوم `createGrammyTransport` بإرسال الملف الفعلي إلى دردشة تيليجرام عبر `ctx.replyWithDocument` / `ctx.replyWithPhoto` / `ctx.replyWithVideo` / `ctx.replyWithAudio` / `ctx.replyWithSticker` باستخدام `InputFile` من مكتبة `grammy`، مع تحديث لوحة التحكم التفاعلية بسلاسة!
2. **تحديث القائمة الرئيسية (`src/bot/keyboards/main-menu.ts`):**
   - أضف أزرار الأقسام الجديدة في `buildMainMenuKeyboard` مع الالتزام الصارم بألا يتجاوز طول أي `callbackData` حد 64 بايت (`MAX_TELEGRAM_CALLBACK_DATA_BYTES = 64`):
     - صف جديد: `[ { text: '📥 قسم استقبال الرسائل', callbackData: 'menu:inbox:page:1' }, { text: '⭕ تحميلات الحالات', callbackData: 'menu:stories:page:1' } ]`
3. **الاختبارات الشاملة (`tests/unit/` و `tests/integration/`):**
   - أضف اختبارات شاملة تتحقق من:
     1. نجاح مختبر الدوال في تشغيل دوال تستخدم `require(...)`، وبناء الصور والملصقات (`imageBuilder` / `stickerBuilder`)، وكافة مسارات الإرسال (`sendMessage`, `relayMessage`, `sendNode`, `prepareWAMessageMedia`, `generateWAMessageFromContent`).
     2. نجاح مسار **رفع ملف الدالة لحفظها (`tools:flab_prompt_upload_save`)** -> طلب الاسم -> الحفظ -> التشغيل بالاسم.
     3. نجاح قسم مكالمات الفيديو البروتوكولي الجديد (`Native Call Offer` + `Scheduled Call` + `Hybrid Video Call`) بدون أي اعتماد على `/dev/video0` أو `adb`.
     4. نجاح قسم استقبال الرسائل (`IncomingMessageReceiver` + `InboxHandler`) في التقاط وتحويل الرسائل النصية والصور والفيديو والملصقات وحزم الملصقات والمواقع وجهات الاتصال إلى ملفات صالحة وتحميلها.
     5. نجاح قسم تحميلات الحالات (`StatusDownloaderService` + `StoriesHandler`) في رصد حالات `status@broadcast` وتحميلها وعرضها.
   - شغل `npm test` و `npm run build` وتأكد من نجاح جميع الاختبارات والبناء بنسبة 100% بدون أي خطأ TypeScript أو ESLint.
