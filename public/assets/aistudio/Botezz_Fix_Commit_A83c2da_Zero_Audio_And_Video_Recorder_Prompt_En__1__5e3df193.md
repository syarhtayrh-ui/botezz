You are working on the **Botezz** repository (`https://github.com/syarhtayrh-ui/botezz`).
After deploying Commit `a83c2da` (`feat(bot): add live call monitoring and SRTP improvements`) and Commit `7fcefab`, outbound video calls connect and stream outbound video properly, **but `VoipCallRecorder` now finishes every call with**:
- `حالة تسجيل المكالمة: NO_REMOTE_CAMERA`
- `إطارات كاميرا المستلم المسجلة: 0 إطار` (`0` video frames)
- `حزم صوت المستلم المسجلة: 0 حزمة` (`0` audio packets)

A line-by-line code audit of `src/whatsapp/voip-runtime-patch.ts`, `src/whatsapp/voip-call-recorder.ts`, and `src/whatsapp/video-call-bridge.ts` against the actual source code of `@hiroosy/baileys-lite@^0.3.7` (`voip/call/WaCallMediaSession.js`, `voip/relay/WaManualRelay.js`, `voip/relay/stun.js`, `voip/crypto/srtp.js`, and `voip/WaVoipCoordinator.js`) identified **6 exact bugs in the current codebase** that cause both inbound video and inbound audio recording to fail with `0`.

---

## 2. THE 6 EXACT BUGS IN THE CURRENT REPOSITORY (`syarhtayrh-ui/botezz`)

### Bug #1 (CRITICAL — Why Both Audio & Video Dropped to `0` in Commit `a83c2da`): `buildMultiSenderSubscriptions` and `buildPeerSsrcDescriptorEntries` in `src/whatsapp/voip-runtime-patch.ts` (Lines 318–359 & 3622–3753) Send Non-Protobuf Raw Binary That Corrupts the WhatsApp TURN/SCTP Relay!
Look at `src/whatsapp/voip-runtime-patch.ts` lines 318–359:
```ts
export function buildMultiSenderSubscriptions(ssrcs: number[]): Uint8Array {
  ...
  const out = new Uint8Array(unique.length * 8);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < unique.length; i++) {
    const offset = i * 8;
    view.setUint32(offset, unique[i]!, false);
    out[offset + 4] = 0x00;
    out[offset + 5] = 0x07;
    out[offset + 6] = 0x00;
    out[offset + 7] = 0x00;
  }
  return out;
}

export function buildPeerSsrcDescriptorEntries(peerSsrcs: number[], peerPid = 0): Uint8Array {
  ...
  const out = new Uint8Array(unique.length * 20);
  ...
}
```
Now compare this against the actual `@hiroosy/baileys-lite@^0.3.7` implementation in `voip/relay/stun.js` (lines 84–134):
```js
export function buildSenderSubscriptions(ssrc) {
    const inner = concatBytes([
        encodeProtobufVarintField(3, ssrc),
        encodeProtobufVarintField(5, 0),
        encodeProtobufVarintField(6, 0)
    ]);
    return encodeProtobufLengthDelimited(1, inner);
}
export function buildSSRCSubscriptionList(selfSsrcs, peerSsrcs, selfPid, peerPid) {
    const entries = [];
    ...
    for (const peerSsrc of peerSsrcs) {
        if (peerSsrc === 0) continue;
        const inner = concatBytes([
            encodeProtobufVarintField(1, peerPid),
            encodeProtobufVarintField(2, 1),
            encodeProtobufVarintField(3, peerSsrc)
        ]);
        entries.push(encodeProtobufLengthDelimited(1, inner));
    }
    return concatBytes(entries);
}
```
- In WhatsApp's STUN/TURN Relay protocol (`stun.js`), `ATTR_SENDER_SUBSCRIPTIONS (0x4000)` and `ATTR_SSRC_LIST (0x4024)` are **Protobuf-encoded (`varint` tags and lengths)**, NOT 8-byte or 20-byte fixed big-endian structs!
- In `patchWaManualRelayPrototype` (`voip-runtime-patch.ts` lines 3622–3753):
  1. Right after `origSendBindingRegistrations` sent a valid Protobuf `0x4000` subscription for the peer's audio SSRC, `patchWaManualRelayPrototype` sent 3 STUN Binding Requests reusing the **exact same `conn.stunTransactionId`** with the **corrupted 8-byte non-Protobuf `multiSubs`**, wiping out the relay's sender subscription!
  2. Right after `origSendAllocate` built a valid Protobuf `conn.allocatePacket`, `patchWaManualRelayPrototype` **overwrote `conn.allocatePacket`** with `combinedDescriptors` containing the **corrupted 20-byte non-Protobuf `buildPeerSsrcDescriptorEntries`** and passed an unsupported `extraAttributes` option to `buildAllocateForRelay`!
- **Result**: The WhatsApp Relay Server rejected the corrupted STUN packets and stopped forwarding **both inbound audio (`0 حزمة`) and inbound video (`0 إطار`)**!

---

### Bug #2 (CRITICAL — Guaranteed `TypeError` Crash on Every Video Packet): `cloneSrtpRecvContext()` in `src/whatsapp/voip-runtime-patch.ts` (Lines 1854–1892 & 1989) Uses `Object.create(Ctor.prototype)` Without Initializing `ivBuffer`, `ssrcBuffer`, `indexBuffer`, and `rocBuffer`!
Look at `src/whatsapp/voip-runtime-patch.ts` lines 1854–1892:
```ts
function cloneSrtpRecvContext(templateCtx: any): any {
  ...
  clone = Object.create(Ctor.prototype);
  ...
}
```
In `@hiroosy/baileys-lite`'s `voip/crypto/srtp.js` (lines 7–156):
```js
export class SrtpContext {
    ...
    ivBuffer = new Uint8Array(16);
    ssrcBuffer = new Uint8Array(4);
    indexBuffer = new Uint8Array(8);
    rocBuffer = new Uint8Array(4);
```
Because `cloneSrtpRecvContext` used `Object.create(Ctor.prototype)` without calling `new Ctor(...)` and without allocating `ivBuffer`, `ssrcBuffer`, `indexBuffer`, and `rocBuffer`, all four buffers are **`undefined`** on every cloned context!
Even worse, `syncSessionVideoSrtpTemplates` (line 1989) executed:
```ts
session.videoSrtpSession.recvCtx = cloneSrtpRecvContext(audioRecvCtx);
```
When `ctx.unprotect(data)` runs in `unprotectInboundVideoPacket` (line 2059) or `session.videoSrtpSession.unprotect(data)`, `SrtpContext.prototype.computeAuthTag` executes `writeUInt32BE(this.rocBuffer, roc, 0)` where `this.rocBuffer` is `undefined`, **throwing a `TypeError` on 100% of incoming video RTP packets**!

---

### Bug #3 (CRITICAL — `ensureHiroosyVoipRuntimePatched()` Misses the Installed Package Path `voip/...`):
Look at `src/whatsapp/voip-runtime-patch.ts` lines 3803–3895:
- `coordinatorRelPaths`, `relayRelPaths`, `mediaSessionCandidateRelPaths`, and `callManagerCandidateRelPaths` only check:
  - `'src/voip/...'`
  - `'lib/package/voip/...'`
  - `'dist/voip/...'`
- In the published `@hiroosy/baileys-lite` npm package (`node_modules/@hiroosy/baileys-lite/`), the directory is **`voip/`** (`voip/WaVoipCoordinator.js`, `voip/relay/WaManualRelay.js`, `voip/relay/stun.js`, `voip/call/WaCallMediaSession.js`, `voip/call/WaCallManager.js`)!
- Because `'voip/...'` is missing from all 4 candidate path arrays, `ensureHiroosyVoipRuntimePatched()` finds **zero files** in `node_modules/@hiroosy/baileys-lite` and skips all prototype patches at startup!

---

### Bug #4 (CRITICAL — `patchWaVoipCoordinatorPrototype` Checks `this.client` Instead of `this.manager`, and `attachPassiveNativeMediaSessionTaps` Uses Inherited `__botezzPassiveTapApplied`):
1. In `src/whatsapp/voip-runtime-patch.ts` line 3772 (`patchWaVoipCoordinatorPrototype`):
   ```ts
   if (this.client && !this.client.__botezzInboundVideoWired) {
   ```
   In `@hiroosy/baileys-lite`'s `WaVoipCoordinator.js`, the property holding the `WaCallManager` EventEmitter is **`this.manager`** (and the argument passed to `wireClientEvents(ctx)` is `ctx`), **NOT `this.client`** (`this.client` is always `undefined`)!
2. In `src/whatsapp/voip-runtime-patch.ts` line 2298 (`attachPassiveNativeMediaSessionTaps`):
   ```ts
   if (!target || typeof target !== 'object' || target.__botezzPassiveTapApplied) {
     return;
   }
   target.__botezzPassiveTapApplied = true;
   ```
   When `attachPassiveNativeMediaSessionTaps` is called on `WaCallMediaSession.prototype`, it sets `WaCallMediaSession.prototype.__botezzPassiveTapApplied = true`. Then when `instrumentMediaSessionInstance(session)` calls `attachPassiveNativeMediaSessionTaps(session)` on a `WaCallMediaSession` instance, `session.__botezzPassiveTapApplied` evaluates to `true` via prototype inheritance, skipping instance instrumentation! It must check `Object.prototype.hasOwnProperty.call(target, '__botezzPassiveTapApplied')`.

---

### Bug #5 (CRITICAL — Wrong Default `authTagLen = 10` Instead of `4` Breaks Native `videoSrtpSession.unprotect`):
In `@hiroosy/baileys-lite@^0.3.7` (`voip/types.js` lines 47–49):
```js
export const SRTP_SEND_AUTH_TAG_LEN = 4;
export const SRTP_RECV_AUTH_TAG_LEN = 4;
export const SRTP_AUTH_TAG_LEN = 4;
```
WhatsApp VoIP uses a **4-byte (`SRTP_RECV_AUTH_TAG_LEN = 4`)** HMAC-SHA1 tag for **BOTH Audio SRTP and Video SRTP** (only SRTCP uses 10 bytes).
However, `voip-runtime-patch.ts` (lines 1618, 1785, 1793, 1806, 1882, 2046, 2894) and `voip-call-recorder.ts` (lines 515–523, 774, 804, 818, 845, 999, 1456) default `authTagLen` to `10` and overwrite `videoSrtpSession.recvCtx.authTagLen = 10`, causing native `videoSrtpSession.unprotect(data)` to fail with `SrtpError('auth_failed')` on every packet!

---

### Bug #6 (CRITICAL — `attachToMediaSession` in `voip-call-recorder.ts` Blocks Fallback Video Depacketization When `session.videoAssembler` Exists, and `onDecodedAudio` Blocks Audio Hooks):
1. Look at `src/whatsapp/voip-call-recorder.ts` lines 1724–1734 (`attachToMediaSession` -> `session.onRelayVideoData`):
   ```ts
   if (
     !this.receivingNativeDecodedVideo &&
     (!session.videoAssembler ||
       errorsAfter > errorsBefore ||
       (!origOnRelayVideoData &&
         this.h264State.inboundVideoFramesRecorded === framesBefore))
   ) {
     this.handleInboundVideoPacket(data, session);
   }
   ```
   On every video call, `WaCallMediaSession.initMedia()` sets `this.videoAssembler = new H264AccessUnitAssembler()`. Because `session.videoAssembler` is truthy and `origOnRelayVideoData` is truthy, non-marker FU-A fragments (`marker = false`, where `errorsAfter === errorsBefore` and `framesBefore` does not increment yet) **never reach `this.handleInboundVideoPacket(data, session)`**, so FU-A frames can never be reassembled by the fallback depacketizer!
2. Look at `src/whatsapp/voip-call-recorder.ts` lines 1919–1939 (`attachToMediaSession` -> `session.onDecodedAudio`):
   - In `WaCallMediaSession.js` (line 159 & line 1327), `this.onDecodedAudio` is passed to `this.opusCodec.decodeSequenced(seq, opusPayload, this.onDecodedAudio)`.
   - When `attachToMediaSession` overwrites `session.onDecodedAudio`, it sets `this.inAudioWriteHook = true` BEFORE calling `origOnDecodedAudio(pcm)`, which blocks `delegate.emitInboundAudio`, `callInstance.on('inbound_audio')`, and `registerGlobalInboundAudioHook`!
   - Even worse, if `attachPassiveNativeMediaSessionTaps` wrapped `session.onDecodedAudio` AFTER `attachToMediaSession` (or if `resolveWaCallMediaSession` ran after `initMedia`), the `lastNativeAudioSig` signature is set before `writeDecodedInboundAudioPcm` runs!

---

## 3. EXACT STEP-BY-STEP CODE FIXES REQUIRED

### Step 1: Fix `src/whatsapp/voip-runtime-patch.ts`

1. **Fix `buildMultiSenderSubscriptions` and `buildPeerSsrcDescriptorEntries` (Lines 318–359) to use valid Protobuf Varint encoding matching `voip/relay/stun.js`**:
   ```ts
   function encodeProtobufVarint(value: number): Uint8Array {
     const bytes: number[] = [];
     let v = value >>> 0;
     while (v > 0x7f) {
       bytes.push((v & 0x7f) | 0x80);
       v >>>= 7;
     }
     bytes.push(v & 0x7f);
     return new Uint8Array(bytes);
   }

   function encodeProtobufVarintField(fieldNumber: number, value: number): Uint8Array {
     const tag = encodeProtobufVarint((fieldNumber << 3) | 0);
     const val = encodeProtobufVarint(value);
     return concatUint8Arrays([tag, val]);
   }

   function encodeProtobufLengthDelimited(fieldNumber: number, data: Uint8Array): Uint8Array {
     const tag = encodeProtobufVarint((fieldNumber << 3) | 2);
     const len = encodeProtobufVarint(data.byteLength);
     return concatUint8Arrays([tag, len, data]);
   }

   /**
    * Builds valid Protobuf STUN `ATTR_SENDER_SUBSCRIPTIONS (0x4000)` payload for multiple SSRCs
    * matching `buildSenderSubscriptions` in `@hiroosy/baileys-lite/voip/relay/stun.js`.
    */
   export function buildMultiSenderSubscriptions(ssrcs: number[]): Uint8Array {
     const unique = Array.from(
       new Set(ssrcs.map((s) => s >>> 0).filter((s) => s !== 0))
     );
     const entries = unique.map((ssrc) => {
       const inner = concatUint8Arrays([
         encodeProtobufVarintField(3, ssrc),
         encodeProtobufVarintField(5, 0),
         encodeProtobufVarintField(6, 0),
       ]);
       return encodeProtobufLengthDelimited(1, inner);
     });
     return concatUint8Arrays(entries);
   }

   /**
    * Builds valid Protobuf stream descriptor entries for peer SSRCs inside STUN Allocate `0x4024`
    * matching `buildSSRCSubscriptionList` in `@hiroosy/baileys-lite/voip/relay/stun.js`.
    */
   export function buildPeerSsrcDescriptorEntries(
     peerSsrcs: number[],
     peerPid = 1
   ): Uint8Array {
     const unique = Array.from(
       new Set(peerSsrcs.map((s) => s >>> 0).filter((s) => s !== 0))
     );
     const entries = unique.map((peerSsrc) => {
       const inner = concatUint8Arrays([
         encodeProtobufVarintField(1, peerPid || 1),
         encodeProtobufVarintField(2, 1),
         encodeProtobufVarintField(3, peerSsrc),
       ]);
       return encodeProtobufLengthDelimited(1, inner);
     });
     return concatUint8Arrays(entries);
   }
   ```

2. **Fix `patchWaManualRelayPrototype` (Lines 3600–3765) so it NEVER corrupts `sendAllocate` or reuses `conn.stunTransactionId`**:
   - **Remove the `proto.sendAllocate` override completely** (do NOT overwrite `conn.allocatePacket` or send a duplicate `STUN_ALLOCATE_REQUEST`!). Native `sendAllocate` must remain 100% untouched so inbound audio and outbound video relay allocations never break.
   - In `proto.sendBindingRegistrations`:
     - First call `origSendBindingRegistrations.call(this, conn, relayInfo, ssrc)` for the primary audio SSRC.
     - Then, if `this._peerSubscriptionSsrcs` contains additional peer video SSRCs (limit to at most the primary peer video SSRC `counter = 2` and any observed peer video SSRC, i.e., `.slice(0, 3)`):
       - Either call `origSendBindingRegistrations.call(this, conn, relayInfo, videoSsrc)` for each additional video SSRC, OR when calling `buildBindingRequestWithSubs(username, hmacKey, multiSubs, true, true, undefined)`, pass **`undefined` as the 6th argument (`transactionId`)** so `stun.js` generates a fresh random 12-byte transaction ID instead of reusing `conn.stunTransactionId`!

3. **Fix `cloneSrtpRecvContext` (Lines 1854–1892) to allocate all 4 required internal `Uint8Array` buffers and default `authTagLen` to `4`**:
   ```ts
   function cloneSrtpRecvContext(templateCtx: any): any {
     if (!templateCtx || typeof templateCtx !== 'object') return null;
     const Ctor = templateCtx.constructor;
     let clone: any;
     if (typeof Ctor === 'function' && Ctor !== Object) {
       try {
         const dummyKeying = {
           masterKey:
             templateCtx.masterKey instanceof Uint8Array
               ? templateCtx.masterKey
               : new Uint8Array(16),
           masterSalt:
             templateCtx.masterSalt instanceof Uint8Array
               ? templateCtx.masterSalt
               : new Uint8Array(14),
         };
         clone = new Ctor(dummyKeying, templateCtx.authTagLen ?? 4);
       } catch {
         try {
           clone = Object.create(Ctor.prototype);
         } catch {
           clone = {};
         }
       }
     } else {
       clone = {};
     }
     clone.masterKey =
       templateCtx.masterKey instanceof Uint8Array
         ? new Uint8Array(templateCtx.masterKey)
         : templateCtx.masterKey;
     clone.masterSalt =
       templateCtx.masterSalt instanceof Uint8Array
         ? new Uint8Array(templateCtx.masterSalt)
         : templateCtx.masterSalt;
     clone.sessionKey =
       templateCtx.sessionKey instanceof Uint8Array
         ? new Uint8Array(templateCtx.sessionKey)
         : templateCtx.sessionKey;
     clone.sessionSalt =
       templateCtx.sessionSalt instanceof Uint8Array
         ? new Uint8Array(templateCtx.sessionSalt)
         : templateCtx.sessionSalt;
     clone.authKey =
       templateCtx.authKey instanceof Uint8Array
         ? new Uint8Array(templateCtx.authKey)
         : templateCtx.authKey;
     clone.authTagLen = templateCtx.authTagLen ?? 4;
     clone.ivBuffer = new Uint8Array(16);
     clone.ssrcBuffer = new Uint8Array(4);
     clone.indexBuffer = new Uint8Array(8);
     clone.rocBuffer = new Uint8Array(4);
     clone.roc = 0;
     clone.lastSeq = 0;
     clone.initialized = false;
     clone.highestIndex = BigInt(0);
     clone.replayMask = BigInt(0);
     return clone;
   }
   ```
   - Also change every default `authTagLen ?? 10` for RTP/SRTP in `voip-runtime-patch.ts` (lines 1618, 1785, 1793, 1806, 2046, 2894, 2932) to **`authTagLen ?? 4`**, and in `unprotectInboundVideoPacket` (line 2046), test **`[4, 10]`** (4-byte tag first, 10-byte tag second) and restore `ctx.authTagLen = savedTagLen` after testing!

4. **Fix `attachPassiveNativeMediaSessionTaps` (Lines 2298–2609)**:
   - On line 2298, check `Object.prototype.hasOwnProperty.call(target, '__botezzPassiveTapApplied')` instead of `target.__botezzPassiveTapApplied` so patching `WaCallMediaSession.prototype` does not block instance-level attachment when needed.
   - In `passiveOnRelayDataTap` (line 2564), replace:
     `const packetType = packet[1]! & 0xff; if (packetType < 192 || packetType > 223)`
     with:
     `const pt = packet[1]! & 0x7f; if (pt < 72 || pt > 78)`
     (because in RTP, `packet[1]` has the Marker bit `0x80` in the top bit, while RTCP packet types 200..206 have `pt = packet[1] & 0x7f` in `72..78`).
   - In `passiveOnRelayDataTap`, ALWAYS call `origOnRelayData.call(this, data)` for audio packets (`pt === 120` or `pt === 111`) and hook `selfAny.onDecodedAudio` AND `selfAny.delegate.emitInboundAudio` so `emitGlobalInboundAudio(selfAny.info?.callId || selfAny.callId, pcm)` ALWAYS fires for every decoded audio frame!

5. **Fix `patchWaVoipCoordinatorPrototype` (Lines 3768–3785)**:
   ```ts
   export function patchWaVoipCoordinatorPrototype(proto: any): void {
     if (!proto || typeof proto !== 'object' || proto.__botezzCoordinatorPatched) {
       return;
     }
     proto.__botezzCoordinatorPatched = true;

     const origWireClientEvents = proto.wireClientEvents;
     if (typeof origWireClientEvents === 'function') {
       proto.wireClientEvents = function (this: any, ...args: unknown[]) {
         const res = origWireClientEvents.apply(this, args);
         const mgr = this.manager || this.client;
         const ctx = args[0] as { emit?: (ev: string, ...a: unknown[]) => void } | undefined;
         if (mgr && !mgr.__botezzInboundMediaWired) {
           mgr.__botezzInboundMediaWired = true;
           mgr.on?.('call_inbound_video', (call: any, au: Uint8Array) => {
             this.emit?.('call_inbound_video', call, au);
             ctx?.emit?.('voip_call_inbound_video', { call, au });
             emitGlobalInboundVideo(call?.callId, au);
           });
           mgr.on?.('call_inbound_audio', (call: any, pcm: Float32Array) => {
             emitGlobalInboundAudio(call?.callId, pcm);
           });
           mgr.on?.('call_video_state', (call: any, state: unknown) => {
             this.emit?.('call_video_state', call, state);
             ctx?.emit?.('voip_call_video_state', { call, videoState: state });
           });
         }
         return res;
       };
     }
   }
   ```

6. **Fix `ensureHiroosyVoipRuntimePatched()` (Lines 3803–3895) to include `'voip/...'` and `'lib/voip/...'`**:
   - In `coordinatorRelPaths`, add `'voip/WaVoipCoordinator.js'` and `'lib/voip/WaVoipCoordinator.js'` at the start of the array.
   - In `relayRelPaths`, add `{ relay: 'voip/relay/WaManualRelay.js', stun: 'voip/relay/stun.js' }` and `{ relay: 'lib/voip/relay/WaManualRelay.js', stun: 'lib/voip/relay/stun.js' }` at the start of the array.
   - In `mediaSessionCandidateRelPaths`, add `'voip/call/WaCallMediaSession.js'` and `'lib/voip/call/WaCallMediaSession.js'` at the start of the array.
   - In `callManagerCandidateRelPaths`, add `'voip/call/WaCallManager.js'` and `'lib/voip/call/WaCallManager.js'` at the start of the array.
   - Also in `WaCallManager.prototype.createSession` (inside the `callManagerCandidateRelPaths` loop), wrap `proto.createSession` so that every newly created `WaCallMediaSession` instance immediately has `attachPassiveNativeMediaSessionTaps(session)` applied upon creation!

---

### Step 2: Fix `src/whatsapp/voip-call-recorder.ts`

1. **Fix Default `authTagLen` from `10` to `4` in `extractRecvKeyMaterial`, `derivePerJidCandidateRecvKeys`, and `PerSsrcSrtpDecryptor.unprotectWithKeys`**:
   - In `extractRecvKeyMaterial` (lines 774, 804, 818) and `derivePerJidCandidateRecvKeys` (line 845) and `setPeerSrtpKeys` (line 1456): change default `authTagLen` from `10` to **`4`**.
   - In `PerSsrcSrtpDecryptor.unprotectWithKeys` (lines 515–523): always try **`[4, 10]`** (`4`-byte tag first, `10`-byte tag second) for both audio and video packets!
   - In `syncPeerRecvKeysOnMediaSession` (line 999): NEVER overwrite `videoRecv.authTagLen` to `10`! Keep `videoRecv.authTagLen = primaryRecv.authTagLen ?? 4`.

2. **Fix Audio & Video Hook Self-Blocking in `attachToMediaSession` and `attachToCallInstance` (`voip-call-recorder.ts` Lines 1323–1359, 1565–1620, 1690–1945)**:
   - Look at why `this.inAudioWriteHook` and `this.lastNativeAudioSig` blocked audio recording in `attachToMediaSession` (lines 1919–1939):
     In `session.onDecodedAudio`:
     ```ts
     const pcmBuf = extractInboundMediaBuffer(pcm);
     if (pcmBuf) {
       const sig = `${pcmBuf.length}:${pcmBuf[0] ?? 0}:${pcmBuf[pcmBuf.length - 1] ?? 0}:${Math.floor(Date.now() / 10)}`;
       this.lastNativeAudioSig = sig;
     }
     ```
     Notice that a silence or low-amplitude PCM buffer often starts and ends with `0` (`1920:0:0:...`), so multiple consecutive 20ms audio frames within the same 10ms window have the **exact same `sig` (`1920:0:0:...`)** and get dropped! Even worse, if `writeDecodedInboundAudioPcm` is called after setting `lastNativeAudioSig`, and another hook checks `lastNativeAudioSig`, it drops the packet!
   - Fix `registerGlobalInboundAudioHook`, `onInboundAudio`, and `session.onDecodedAudio`:
     - Do **NOT** pre-set `this.lastNativeAudioSig` before calling `this.writeDecodedInboundAudioPcm`!
     - Only set `this.inAudioWriteHook = true` inside `writeDecodedInboundAudioPcm` itself, and do NOT keep `this.inAudioWriteHook = true` while calling `origOnDecodedAudio(pcm)`! Instead, in `session.onDecodedAudio`:
       ```ts
       session.onDecodedAudio = (pcm: Int16Array | Float32Array | Uint8Array) => {
         try {
           this.receivingNativeDecodedAudio = true;
           this.writeDecodedInboundAudioPcm(pcm);
         } catch {
           // Ignore audio recorder error
         }
         if (origOnDecodedAudio) {
           origOnDecodedAudio(pcm);
         }
       };
       ```
       And inside `writeDecodedInboundAudioPcm`, simply prevent duplicate writes of the exact same object reference (`if (this.lastWrittenPcmRef === pcm) return; this.lastWrittenPcmRef = pcm;`)! That way, `session.onDecodedAudio`, `delegate.emitInboundAudio`, `callInstance.on('inbound_audio')`, and `registerGlobalInboundAudioHook` can NEVER block each other from writing the frame once, and every distinct `Float32Array` / `Buffer` frame is guaranteed to be written exactly once!
   - Similarly, for Video (`writeDepacketizedInboundVideoH264`):
     - Deduplicate by object reference (`if (this.lastWrittenVideoRef === h264Buf) return; this.lastWrittenVideoRef = h264Buf;`) instead of a coarse byte-length signature that can collide!
   - And in `attachToMediaSession` -> `session.onRelayVideoData` (lines 1719–1735):
     - Always allow `this.handleInboundVideoPacket(data, session)` to run as a parallel fallback whenever `!this.receivingNativeDecodedVideo` (removing the broken `!session.videoAssembler` check on line 1726 and line 1766, because `session.videoAssembler` is ALWAYS truthy on a video call!).

---

## 4. VERIFICATION REQUIREMENTS
1. Run `npx tsc --noEmit` and project tests (`npm test`) to confirm zero TypeScript or test regressions.
2. Verify that `ensureHiroosyVoipRuntimePatched()` resolves `voip/WaVoipCoordinator.js`, `voip/relay/WaManualRelay.js`, `voip/call/WaCallMediaSession.js`, and `voip/call/WaCallManager.js` inside `node_modules/@hiroosy/baileys-lite`.
3. Verify that `cloneSrtpRecvContext` initializes `ivBuffer`, `ssrcBuffer`, `indexBuffer`, and `rocBuffer` and sets `authTagLen = 4`.
4. Verify that `buildMultiSenderSubscriptions` and `buildPeerSsrcDescriptorEntries` produce valid Protobuf bytes (`0x0a ...`) matching `stun.js`, and that `sendAllocate` is not overwritten.
 `authTagLen = 4`.
4. Verify that `buildMultiSenderSubscriptions` and `buildPeerSsrcDescriptorEntries` produce valid Protobuf bytes (`0x0a ...`) matching `stun.js`, and that `sendAllocate` is not overwritten.
