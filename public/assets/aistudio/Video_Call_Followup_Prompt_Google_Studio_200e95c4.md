# برومبت تكميلي منفصل لتطوير وإعادة هيكلة ميزة مكالمات الفيديو المزيفة (Follow-Up Prompt for Google AI Studio)

انسخ النص التوجيهي التالي بالكامل وأرسله في **Google AI Studio** مباشرة بعد انتهاء البرومبت السابق:

---

## نص البرومبت التكميلي (Standalone Video Call Upgrade Prompt)

أنت مهندس برمجيات رئيسي (Principal Systems & Protocol Architect) ومطور خبير في `athanasia-baileys` و `grammY` و `TypeScript`.

**تنبيه معماري هام جداً:**
هذا التوجيه هو **تحديث تكميلي مخصص لقسم مكالمات الفيديو المزيفة فقط** فوق التعديلات السابقة. **يُمنع منعاً باتاً المساس أو التراجع عن أي ميزة تم تطويرها في التحديث السابق** (مختبر الدوال المطور، زر رفع ملف الدالة لحفظها، قسم استقبال الرسائل `/inbox`، وقسم تحميلات الحالات `/stories`).

المطلوب منك الآن تطوير وإعادة ضبط **قسم مكالمات الفيديو المزيفة (`src/whatsapp/video-call-bridge.ts`، `src/bot/workflows/video-call-workflow.ts`، `src/bot/bot.ts`، و `src/whatsapp/connection-manager.ts`)** ليعمل بالآلية البروتوكولية المباشرة وبنفس التسلسل الدقيق التالي:

---

### أولاً: التسلسل الإلزامي الجديد لخطوات المستخدم (`src/bot/workflows/video-call-workflow.ts` و `src/bot/bot.ts`)

قم بتعديل آلة الحالة (`State Machine`) في `VideoCallWorkflow` وتوجيه الرسائل في `TelegramBotController` لتعمل بالتسلسل المباشر التالي من 3 خطوات فقط:

1. **الخطوة 1 — الضغط على زر `📹 بدء مكالمة فيديو` (`menu:video_call` أو `/videocall`):**
   - تبدأ الحالة فوراً بـ **`step = 'AWAITING_VIDEO'`** (وليس طلب الرقم أولاً!).
   - يطلب البوت من المستخدم مباشرة رفع ملف الفيديو أولاً:
     *"📹 **بدء مكالمة فيديو مزيفة (بث الفيديو للطرف الآخر)**\n\nالخطوة 1 من 2: **الرجاء إرسال أو رفع ملف الفيديو** (`.mp4`, `.mov`, `.webm`, `.mkv`) الذي تريد أن يظهر عند الطرف الآخر كبث كاميرا في المكالمة:"*
   - مع توفير زر اختياري سريع للمعاينة الفورية:
     - `🎬 استخدام فيديو تجريبي جاهز (sample_call.mp4)` (`callbackData: 'wf_vcall:sample_video'`)
     - وصف أزرار الرجوع والإلغاء (`buildBackCancelRow('menu:main')`).

2. **الخطوة 2 — عند رفع ملف الفيديو (`handleVideoUpload`):**
   - في `src/bot/bot.ts` (`handleMediaUpload`)، عندما يكون `mode === 'VIDEO_CALL'` ويرفع المستخدم ملف فيديو (سواء كـ `message:video` أو `message:document`)، يتم تمريره إلى `this.videoCallWorkflow.handleVideoUpload(actorUserId, upload)`.
   - يقوم `VideoCallWorkflow` بالتحقق من صيغة وحجم الفيديو وحفظه بأمان في المجلد المؤقت (`state.videoFilePath`)، ثم ينقل الحالة تلقائياً إلى **`state.step = 'AWAITING_RECIPIENT'`**.
   - يعرض البوت للمستخدم الرسالة التالية فوراً:
     *"✅ **تم استلام وتجهيز ملف الفيديو للبث بنجاح:** `filename.mp4` (`sizeFormatted`)\n\nالخطوة 2 من 2: **الرجاء إرسال الرقم المستهدف الآن** مع رمز الدولة الدولي (مثال: `+966501234567`) ليبدأ الاتصال وبث الفيديو فوراً:"*
   - إذا كان لدى المستخدم أكثر من جلسة واتساب متصلة، اعرض أزرار اختيار الجلسة في نفس لوحة المفاتيح مع تحديد الجلسة المتصلة الأولى تلقائياً.

3. **الخطوة 3 — عند إرسال الرقم المستهدف (`handleRecipientInput` ⬅️ بدء المكالمة فوراً!):**
   - في `src/bot/bot.ts` (`routeTextMessageInternal`)، عندما يكون `mode === 'VIDEO_CALL'` و `state.step === 'AWAITING_RECIPIENT'` ويرسل المستخدم رقم الهاتف المستهدف:
   - يقوم `handleRecipientInput(userId: number, rawPhone: string): Promise<BotViewResponse>` بالتحقق من الرقم المستهدف (`validateRecipient`)، وحفظ `recipientJid` و `recipientDigits`، ثم **يستدعي فوراً دالة بدء المكالمة البروتوكولية وبث الفيديو (`await this.confirmAndExecute(userId)`)** بدون التوقف عند شاشة تأكيد إضافية!
   - (ملاحظة توافقية: إذا أرسل المستخدم الأمر السريع `/videocall +966501234567` مع الرقم مسبقاً، يحفظ البوت الرقم في `state.recipientJid` ويطلب منه رفع ملف الفيديو، وفور رفع الفيديو يبدأ المكالمة مباشرة!).
   - بعد بدء المكالمة (`state.step = 'STREAMING_ACTIVE'`)، يعرض البوت لوحة التحكم بالمكالمة النشطة مع الأزرار التالية:
     - `🔁 إعادة رنين وبث الفيديو لنفس الرقم` (`callbackData: 'wf_vcall:repeat_call'`)
     - `🛑 إنهاء المكالمة وإيقاف البث` (`callbackData: 'wf_vcall:stop'`)
     - `👤 إرسال المكالمة لرقم آخر (بنفس الفيديو)` (`callbackData: 'wf_vcall:change_recipient'`) — يعيد الخطوة إلى `AWAITING_RECIPIENT` مع الاحتفاظ بنفس ملف الفيديو المرفوع!
     - `🎬 تغيير ملف الفيديو` (`callbackData: 'wf_vcall:reupload'`) — يعيد الخطوة إلى `AWAITING_VIDEO`.

---

### ثانياً: المحرك البروتوكولي الداخلي للمكالمة المزيفة وبث الفيديو بدون محرك خارجي (`src/whatsapp/video-call-bridge.ts` و `src/whatsapp/connection-manager.ts`)

قم بإلغاء أي اعتماد على `/dev/video0` أو `v4l2loopback` أو `adb` أو `FFmpeg` الخارجي نهائياً، وأعد بناء `UbuntuVideoCallBridge` (مع الحفاظ على اسم الكلاس والواجهات المصدرة للتوافق التام مع المشروع) ليعتمد 100% على **بروتوكول `athanasia-baileys` المباشر** عبر تنفيذ آليتين متكاملتين عند بدء المكالمة:

#### 1. إرسال عقدة رنين مكالمة الفيديو البروتوكولية (`Native <call><offer><video/></offer></call>` Stanza)
أضف في `WhatsAppSessionDriver` (`AthanasiaBaileysSessionDriver` و `MockWhatsAppSessionDriver` في `src/whatsapp/connection-manager.ts`) دالتين رسميتين:
- `sendNativeVideoCallOffer(targetJid: string, options?: { callId?: string; isVideo?: boolean }): Promise<{ callId: string }>`
- `terminateNativeVideoCall(targetJid: string, callId: string): Promise<void>`

تعمل `sendNativeVideoCallOffer` عبر إرسال عقدة `BinaryNode` أصلية بواسطة `sock.sendNode` تجعل هاتف الطرف الآخر يستقبل إشارة رنين مكالمة فيديو من رقم الجلسة:
```ts
const callId = options?.callId || crypto.randomBytes(16).toString('hex').toUpperCase();
const fromJid = sock.user?.id || sock.authState?.creds?.me?.id || '';
const resolvedJid = await this.resolveDirectRecipientJid(sock, targetJid);

await sock.sendNode({
  tag: 'call',
  attrs: {
    to: resolvedJid,
    id: typeof sock.generateMessageTag === 'function' ? sock.generateMessageTag() : `call_${Date.now()}`,
    from: fromJid,
  },
  content: [
    {
      tag: 'offer',
      attrs: {
        'call-id': callId,
        'call-creator': fromJid,
      },
      content: [
        {
          tag: 'video',
          attrs: {
            enc: 'vp8',
            dec: 'vp8',
            orientation: '0',
            screen_width: '720',
            screen_height: '1280',
            device_orientation: '0',
          },
        },
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
});
```
وعند استدعاء `terminateNativeVideoCall(targetJid, callId)` (عند ضغط المستخدم على زر `🛑 إنهاء المكالمة` أو انتهاء المؤقت)، يرسل المقبس عقدة `<terminate>`:
```ts
await sock.sendNode({
  tag: 'call',
  attrs: {
    to: resolvedJid,
    id: typeof sock.generateMessageTag === 'function' ? sock.generateMessageTag() : `end_${Date.now()}`,
    from: fromJid,
  },
  content: [
    {
      tag: 'terminate',
      attrs: {
        'call-id': callId,
        'call-creator': fromJid,
        reason: 'timeout',
      },
    },
  ],
});
```

#### 2. حقن ملف الفيديو المرفوع ليظهر كبث كاميرا مباشر عند الطرف الآخر (`Native PTV / Video Call Stream Injection`)
بالتزامن مع إرسال إشارة رنين مكالمة الفيديو `<call><offer><video/></offer></call>`:
- يقوم `startVideoCallStream` في `src/whatsapp/video-call-bridge.ts` برفع ملف الفيديو الذي أرسله المستخدم وحقنه عبر مقبس `athanasia-baileys` كـ **بث كاميرا مباشر (`ptvMessage` / `ptv: true`)** مدعم بـ `messageContextInfo` (`deviceListMetadataVersion: 2`, `messageSecret`) عبر `driver.sendMediaMessage({ recipientJid: params.targetJid, filePath: params.videoFilePath, kind: 'video', mimeType: params.mimeType || 'video/mp4', fileName: params.fileName, ptv: true })`.
- في حال تفعيل التكرار (`loopVideo: true`)، يدعم المحرك إمكانية إعادة نبضة الرنين أو تكرار البث عند ضغط المستخدم على `🔁 إعادة رنين وبث الفيديو لنفس الرقم`.
- **منع الحذف المبكر للملف (`Critical Bug Fix`):** لا تقم بحذف `videoFilePath` داخل `stopVideoCallStream` إلا إذا تم تمرير `{ deleteFile: true }` (عند الإلغاء النهائي أو الخروج من القسم)، حتى يتمكن المستخدم من إعادة الاتصال أو تجربة رقم آخر بنفس الفيديو المرفوع دون خطأ عدم وجود الملف.

---

### ثالثاً: تحديث الاختبارات الآلية والتحقق الشامل (`tests/`)

1. قم بتحديث أي اختبارات حالية في `tests/integration/workflows.test.ts` أو `tests/integration/master-upgrade.test.ts` تختبر `VideoCallWorkflow` لتتوافق مع التسلسل الجديد:
   - الضغط على `menu:video_call` ⬅️ يضع الحالة في `AWAITING_VIDEO`.
   - رفع الفيديو (أو الضغط على `wf_vcall:sample_video`) ⬅️ ينقل الحالة إلى `AWAITING_RECIPIENT`.
   - إرسال الرقم المستهدف `+966501234567` ⬅️ يبدأ المكالمة وبث الفيديو فوراً وينقل الحالة إلى `STREAMING_ACTIVE`.
2. أضف اختباراً يتحقق من زر `wf_vcall:repeat_call` وزر `wf_vcall:change_recipient` وزر `wf_vcall:stop`.
3. شغّل `npm test` و `npm run build` وتأكد من نجاح جميع الاختبارات والبناء بنسبة 100% بدون أي أخطاء.
