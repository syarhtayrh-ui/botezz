import { execFileSync } from 'node:child_process';
import {
  Baileys,
  Voip,
  BAILEYS_LITE_LIBRARY_NAME,
  BAILEYS_LITE_LIBRARY_VERSION,
  type WASocket,
  type CompatibleWhatsAppSocket,
} from './baileys-compat';

export interface VoipCapabilitiesChecklist {
  authClient: boolean;
  signedDeviceIdentity: boolean;
  signalEncryptionDecryption: boolean;
  e2eSessionInjection: boolean;
  trustedContactToken: boolean;
  getUSyncDevices: boolean;
  lidMapping: boolean;
  lowLevelSendNode: boolean;
  incomingCallStanzaInterception: boolean;
  outgoingCallSignaling: boolean;
  callStateEvents: boolean;
  mediaCoordinator: boolean;
  audioPipeline: boolean;
  videoPipeline: boolean;
  rtpSrtpSupport: boolean;
}

export interface BaileysBaseCapabilitiesChecklist {
  makeWASocket: boolean;
  useMultiFileAuthState: boolean;
  requestPairingCode: boolean;
  disconnectReason: boolean;
  jidUtilities: boolean;
  mediaDownloadUpload: boolean;
  messageComposition: boolean;
  binaryNodeHelpers: boolean;
}

export interface MediaBinariesStatus {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
}

export type CompatibilityVerificationLevel =
  | 'STATIC_EXPORTS_ONLY'
  | 'LIVE_SOCKET_VERIFIED';

export type CompatibilityReport = {
  libraryName: string;
  libraryVersion: string;
  verificationLevel: CompatibilityVerificationLevel;
  baileysCompatible: boolean;
  baseBaileysCompatible: boolean;
  voipCompatible: boolean;
  missingCapabilities: string[];
  warnings: string[];
  reasons: string[];
  baseCapabilities: BaileysBaseCapabilitiesChecklist;
  voipCapabilities: VoipCapabilitiesChecklist;
  externalBinaries: MediaBinariesStatus;
  mediaBinaries: MediaBinariesStatus;
};

export interface CompatibilityProbeOptions {
  /** Optional socket or compatible socket wrapper to inspect live runtime bindings */
  socket?:
    | Partial<WASocket>
    | CompatibleWhatsAppSocket
    | Record<string, unknown>
    | null;
  /** Whether a live connected socket with credentials/signalRepository is required */
  requireLiveSocket?: boolean;
  /** Override binary probe in unit tests */
  binaryOverrides?: {
    ffmpegAvailable?: boolean;
    ffprobeAvailable?: boolean;
  };
  /** Optional capability overrides for simulating missing capabilities in unit tests */
  capabilityOverrides?: Partial<
    BaileysBaseCapabilitiesChecklist & VoipCapabilitiesChecklist
  >;
}

let cachedBinaryCheck: MediaBinariesStatus | null = null;

export function checkMediaBinaries(force = false): MediaBinariesStatus {
  if (!force && cachedBinaryCheck) {
    return cachedBinaryCheck;
  }

  let ffmpegAvailable = false;
  let ffprobeAvailable = false;
  let ffmpegVersion: string | undefined;
  let ffprobeVersion: string | undefined;

  try {
    const out = execFileSync('ffmpeg', ['-version'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    ffmpegAvailable = true;
    ffmpegVersion = out.split('\n')[0]?.trim();
  } catch {
    ffmpegAvailable = false;
  }

  try {
    const out = execFileSync('ffprobe', ['-version'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    ffprobeAvailable = true;
    ffprobeVersion = out.split('\n')[0]?.trim();
  } catch {
    ffprobeAvailable = false;
  }

  cachedBinaryCheck = {
    ffmpegAvailable,
    ffprobeAvailable,
    ffmpegVersion,
    ffprobeVersion,
  };
  return cachedBinaryCheck;
}

/**
 * Exact Arabic error message required when VoIP media layer is incompatible.
 * Never falls back to PTV or regular video messages.
 */
export const VOIP_INCOMPATIBLE_ARABIC_MESSAGE = [
  'تعذر تشغيل مكالمة فيديو حقيقية:',
  'طبقة الوسائط VoIP غير متوافقة مع إصدار المكتبة الحالي.',
  'لم يتم إرسال فيديو بديل أو رسالة PTV.',
].join('\n');

/**
 * Real Compatibility Probe (`CompatibilityProbe`) verifying both `@hiroosy/baileys-lite`
 * core WhatsApp Web capabilities and all 15 HIROBOT-compatible VoIP signaling & media capabilities.
 */
export function runBaileysCompatibilityProbe(
  options?: CompatibilityProbeOptions
): CompatibilityReport {
  const missingCapabilities: string[] = [];
  const warnings: string[] = [];

  const rawSock: Partial<WASocket> | undefined =
    options?.socket &&
    typeof options.socket === 'object' &&
    'rawSocket' in options.socket
      ? (options.socket as CompatibleWhatsAppSocket).rawSocket
      : (options?.socket as Partial<WASocket> | undefined) || undefined;

  const requireLiveSocket = Boolean(options?.requireLiveSocket);

  const binaries: MediaBinariesStatus = {
    ...checkMediaBinaries(),
    ...(options?.binaryOverrides || {}),
  };

  const b = Baileys as Record<string, unknown>;

  // 1. Base Baileys capabilities
  const baseCapabilities: BaileysBaseCapabilitiesChecklist = {
    makeWASocket: typeof b.makeWASocket === 'function',
    useMultiFileAuthState:
      typeof b.useMultiFileAuthState === 'function' &&
      typeof b.initAuthCreds === 'function' &&
      typeof b.makeCacheableSignalKeyStore === 'function',
    requestPairingCode:
      !rawSock || typeof rawSock.requestPairingCode === 'function',
    disconnectReason:
      typeof b.DisconnectReason === 'object' && b.DisconnectReason !== null,
    jidUtilities:
      typeof b.jidEncode === 'function' &&
      typeof b.jidDecode === 'function' &&
      typeof b.jidNormalizedUser === 'function' &&
      typeof b.areJidsSameUser === 'function' &&
      typeof b.isJidGroup === 'function',
    mediaDownloadUpload:
      typeof b.downloadMediaMessage === 'function' &&
      typeof b.downloadContentFromMessage === 'function' &&
      typeof b.prepareWAMessageMedia === 'function',
    messageComposition:
      typeof b.generateWAMessageFromContent === 'function' &&
      typeof b.generateForwardMessageContent === 'function' &&
      typeof b.normalizeMessageContent === 'function' &&
      typeof b.extractMessageContent === 'function',
    binaryNodeHelpers:
      typeof b.getBinaryNodeChild === 'function' &&
      typeof b.getAllBinaryNodeChildren === 'function',
  };

  // 2. VoIP-specific 15 capabilities
  const hasVoipExport = typeof Voip === 'function';
  const protoObj = b.proto as Record<string, unknown> | undefined;
  const hasProtoAdv = Boolean(
    protoObj &&
      (protoObj.ADVSignedDeviceIdentity ||
        protoObj.ADVDeviceIdentity ||
        typeof b.encodeSignedDeviceIdentity === 'function')
  );

  const sockHasAuthState = requireLiveSocket
    ? Boolean(
        rawSock?.authState &&
          typeof rawSock.authState.creds === 'object' &&
          Boolean(rawSock.authState.creds?.me?.id || rawSock.user?.id) &&
          typeof rawSock.authState.keys?.get === 'function' &&
          typeof rawSock.authState.keys?.set === 'function'
      )
    : !rawSock ||
      Boolean(
        rawSock.authState &&
          typeof rawSock.authState.creds === 'object' &&
          typeof rawSock.authState.keys?.get === 'function' &&
          typeof rawSock.authState.keys?.set === 'function'
      );

  const sockHasSignalEncryptDecrypt = requireLiveSocket
    ? Boolean(
        rawSock?.signalRepository &&
          typeof rawSock.signalRepository.encryptMessage === 'function' &&
          typeof rawSock.signalRepository.decryptMessage === 'function'
      )
    : !rawSock ||
      Boolean(
        rawSock.signalRepository &&
          typeof rawSock.signalRepository.encryptMessage === 'function' &&
          typeof rawSock.signalRepository.decryptMessage === 'function'
      );

  const sockHasE2ESessionSupport =
    typeof b.parseAndInjectE2ESessions === 'function' &&
    (requireLiveSocket
      ? Boolean(
          rawSock?.signalRepository &&
            typeof rawSock.signalRepository.jidToSignalProtocolAddress ===
              'function' &&
            typeof rawSock.signalRepository.injectE2ESession === 'function'
        )
      : !rawSock ||
        Boolean(
          rawSock.signalRepository &&
            typeof rawSock.signalRepository.jidToSignalProtocolAddress ===
              'function'
        ));

  const sockHasLidMapping = requireLiveSocket
    ? Boolean(rawSock?.signalRepository?.lidMapping)
    : !rawSock || Boolean(rawSock.signalRepository?.lidMapping);

  const sockHasUSyncDevices = requireLiveSocket
    ? typeof rawSock?.getUSyncDevices === 'function'
    : !rawSock || typeof rawSock.getUSyncDevices === 'function';

  const sockHasLowLevelSend = requireLiveSocket
    ? Boolean(
        rawSock &&
          typeof rawSock.sendNode === 'function' &&
          typeof rawSock.query === 'function'
      )
    : !rawSock ||
      (typeof rawSock.sendNode === 'function' &&
        typeof rawSock.query === 'function');

  // BZ-026: VoipClient.registerIncomingHandler binds directly to `sock.ws.on('CB:call', ...)`
  const sockHasIncomingStanzaInterception = requireLiveSocket
    ? Boolean(rawSock?.ws && typeof rawSock.ws.on === 'function')
    : !rawSock ||
      Boolean(
        (rawSock.ws && typeof rawSock.ws.on === 'function') ||
          (rawSock.ev && typeof rawSock.ev.on === 'function')
      );

  const voipCapabilities: VoipCapabilitiesChecklist = {
    authClient: sockHasAuthState && typeof b.initAuthCreds === 'function',
    signedDeviceIdentity:
      typeof b.encodeSignedDeviceIdentity === 'function' && hasProtoAdv,
    signalEncryptionDecryption: sockHasSignalEncryptDecrypt,
    e2eSessionInjection: sockHasE2ESessionSupport,
    trustedContactToken: sockHasAuthState && baseCapabilities.binaryNodeHelpers,
    getUSyncDevices: sockHasUSyncDevices,
    lidMapping: sockHasLidMapping,
    lowLevelSendNode: sockHasLowLevelSend,
    incomingCallStanzaInterception: sockHasIncomingStanzaInterception,
    outgoingCallSignaling: hasVoipExport && sockHasLowLevelSend,
    callStateEvents: hasVoipExport,
    mediaCoordinator: hasVoipExport,
    audioPipeline: hasVoipExport && binaries.ffmpegAvailable,
    videoPipeline:
      hasVoipExport && binaries.ffmpegAvailable && binaries.ffprobeAvailable,
    rtpSrtpSupport: hasVoipExport,
  };

  if (options?.capabilityOverrides) {
    for (const [key, val] of Object.entries(options.capabilityOverrides)) {
      if (typeof val === 'boolean') {
        if (key in baseCapabilities) {
          (baseCapabilities as unknown as Record<string, boolean>)[key] = val;
        }
        if (key in voipCapabilities) {
          (voipCapabilities as unknown as Record<string, boolean>)[key] = val;
        }
      }
    }
  }

  for (const [key, ok] of Object.entries(baseCapabilities)) {
    if (!ok) {
      missingCapabilities.push(`baileys.${key}`);
    }
  }

  for (const [key, ok] of Object.entries(voipCapabilities)) {
    if (!ok) {
      missingCapabilities.push(`voip.${key}`);
    }
  }

  if (!binaries.ffmpegAvailable) {
    warnings.push(
      'الأداة التنفيذية ffmpeg غير متوفرة في مسار النظام (PATH)؛ لن يعمل ترميز الفيديو والصوت الفوري.'
    );
  }
  if (!binaries.ffprobeAvailable) {
    warnings.push(
      'الأداة التنفيذية ffprobe غير متوفرة في مسار النظام (PATH)؛ قد يتعذر فحص أبعاد وتدفقات ملف الفيديو.'
    );
  }

  if (
    rawSock &&
    !rawSock.authState?.creds?.me?.lid &&
    rawSock.authState?.creds?.registered
  ) {
    warnings.push(
      'معرف LID الخاص بالحساب (creds.me.lid) غير متوفر حالياً في الجلسة؛ قد يستخدم محرك VoIP معرف PN كبديل.'
    );
  }

  const baileysCompatible = Object.values(baseCapabilities).every(Boolean);
  const voipCompatible =
    baileysCompatible && Object.values(voipCapabilities).every(Boolean);

  const verificationLevel: CompatibilityVerificationLevel =
    rawSock && requireLiveSocket && voipCompatible
      ? 'LIVE_SOCKET_VERIFIED'
      : 'STATIC_EXPORTS_ONLY';

  return {
    libraryName: BAILEYS_LITE_LIBRARY_NAME,
    libraryVersion: BAILEYS_LITE_LIBRARY_VERSION,
    verificationLevel,
    baileysCompatible,
    baseBaileysCompatible: baileysCompatible,
    voipCompatible,
    missingCapabilities,
    warnings,
    reasons: [...warnings, ...missingCapabilities],
    baseCapabilities,
    voipCapabilities,
    externalBinaries: binaries,
    mediaBinaries: binaries,
  };
}
