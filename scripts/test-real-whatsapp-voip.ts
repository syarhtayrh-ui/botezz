import path from 'node:path';
import fs from 'node:fs';
import {
  makeWASocket,
  useMultiFileAuthState as loadMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '../src/whatsapp/baileys-compat';
import { runBaileysCompatibilityProbe } from '../src/whatsapp/compatibility-probe';
import {
  validateAndInspectVideoMedia,
  generatePlayableVoipMp4File,
} from '../src/whatsapp/voip-media-pipeline';
import { RealVideoCallService } from '../src/whatsapp/video-call-bridge';

async function main(): Promise<void> {
  const isRealTestEnabled = process.env.REAL_WHATSAPP_VOIP_TEST === 'true';
  const sessionId = process.env.TEST_SESSION_ID?.trim() || '';
  const targetJid = process.env.TEST_TARGET_JID?.trim() || '';
  const videoPathInput = process.env.TEST_VIDEO_PATH?.trim() || '';

  console.log('==============================================================');
  console.log(' Botezz V5 - Real WhatsApp VoIP Video Call Diagnostic Harness ');
  console.log(' Library: @hiroosy/baileys-lite + @hiroosy/baileys-lite/voip  ');
  console.log('==============================================================');

  const staticProbe = runBaileysCompatibilityProbe({
    requireLiveSocket: false,
  });
  console.log('\n[1] Static Runtime & VoIP Capability Probe:');
  console.log(`    - Base Baileys Compatible : ${staticProbe.baseBaileysCompatible}`);
  console.log(`    - VoIP Layer Compatible   : ${staticProbe.voipCompatible}`);
  console.log(`    - ffmpeg Available        : ${staticProbe.mediaBinaries.ffmpegAvailable} (${staticProbe.mediaBinaries.ffmpegVersion || 'n/a'})`);
  console.log(`    - ffprobe Available       : ${staticProbe.mediaBinaries.ffprobeAvailable} (${staticProbe.mediaBinaries.ffprobeVersion || 'n/a'})`);

  if (!isRealTestEnabled) {
    console.log('\n[INFO] REAL_WHATSAPP_VOIP_TEST is not set to "true".');
    console.log('       Skipping live WhatsApp VoIP call execution (safe default).');
    console.log('       To execute a live WhatsApp VoIP video call test, run:');
    console.log('       REAL_WHATSAPP_VOIP_TEST=true \\');
    console.log('       TEST_SESSION_ID=<session_id> \\');
    console.log('       TEST_TARGET_JID=<phone>@s.whatsapp.net \\');
    console.log('       TEST_VIDEO_PATH=/path/to/video.mp4 \\');
    console.log('       npm run test:real-whatsapp-voip\n');
    return;
  }

  if (!sessionId || !targetJid) {
    throw new Error(
      'Missing required environment variables: TEST_SESSION_ID and TEST_TARGET_JID must be provided when REAL_WHATSAPP_VOIP_TEST=true.'
    );
  }

  let resolvedVideoPath = videoPathInput;
  if (!resolvedVideoPath) {
    const generatedDir = path.resolve(process.cwd(), 'data', 'temp_uploads');
    fs.mkdirSync(generatedDir, { recursive: true });
    resolvedVideoPath = path.join(generatedDir, 'voip_test_sample.mp4');
    console.log(
      `\n[2] No TEST_VIDEO_PATH provided; generating playable H.264+AAC MP4 at ${resolvedVideoPath}...`
    );
    await generatePlayableVoipMp4File(resolvedVideoPath, {
      width: 640,
      height: 360,
      durationSeconds: 5,
      includeAudio: true,
    });
  }

  console.log(`\n[2] Validating and inspecting video media: ${resolvedVideoPath}`);
  const mediaInspection = await validateAndInspectVideoMedia(resolvedVideoPath, {
    allowedRootDirs: [process.cwd(), '/tmp'],
  });
  console.log('    - Container       :', mediaInspection.containerFormat);
  console.log('    - Video Codec     :', mediaInspection.videoCodec);
  console.log('    - Audio Codec     :', mediaInspection.audioCodec || 'none (silent fallback)');
  console.log(
    `    - Dimensions      : ${mediaInspection.width}x${mediaInspection.height} (${mediaInspection.fps} fps)`
  );
  console.log('    - Duration (sec)  :', mediaInspection.durationSeconds);
  console.log('    - VoIP Preset     :', mediaInspection.targetVoipResolution);

  const sessionsRoot = path.resolve(process.cwd(), 'data', 'sessions', sessionId);
  if (!fs.existsSync(sessionsRoot)) {
    throw new Error(`Session auth directory not found at: ${sessionsRoot}`);
  }

  console.log(`\n[3] Loading WhatsApp session "${sessionId}" from ${sessionsRoot}...`);
  const { state, saveCreds } = await loadMultiFileAuthState(sessionsRoot);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys),
    },
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WhatsApp socket connection (30s)'));
    }, 30_000);

    sock.ev.on('connection.update', (update: Record<string, unknown>) => {
      if (update.connection === 'open') {
        clearTimeout(timeout);
        resolve();
      } else if (update.connection === 'close') {
        clearTimeout(timeout);
        reject(new Error('WhatsApp socket closed before opening'));
      }
    });
  });

  console.log('\n[4] Running live socket CompatibilityProbe...');
  const liveProbe = runBaileysCompatibilityProbe({
    socket: sock as unknown as Record<string, unknown>,
    requireLiveSocket: true,
  });
  console.log('    - Live VoIP Compatible:', liveProbe.voipCompatible);
  if (!liveProbe.voipCompatible) {
    throw new Error(
      `Live socket failed VoIP CompatibilityProbe: ${liveProbe.reasons.join('; ')}`
    );
  }

  const service = new RealVideoCallService();
  service.attachSession(sessionId, sock as unknown as Record<string, unknown>);

  const eventsToLog = [
    'call:initiating',
    'call:ringing',
    'call:connecting',
    'call:connected',
    'call:audio-started',
    'call:video-started',
    'call:media-started',
    'call:media-error',
    'call:rejected',
    'call:timeout',
    'call:ended',
    'call:socket-closed',
  ] as const;

  for (const evt of eventsToLog) {
    service.on(evt, (payload) => {
      console.log(`[EVENT ${new Date().toISOString()}] ${evt}:`, JSON.stringify(payload));
    });
  }

  console.log(`\n[5] Starting real WhatsApp VoIP video call to ${targetJid}...`);
  const stream = await service.startVideoCall({
    sessionId,
    socket: sock as unknown as Record<string, unknown>,
    recipientJid: targetJid,
    videoFilePath: resolvedVideoPath,
    loopVideo: false,
    maxDurationSeconds: 30,
    callTimeoutMs: 35_000,
    allowedRootDirs: [process.cwd(), '/tmp'],
  });

  console.log(`    - Call ID: ${stream.callId} (VoIP Stanza ID: ${stream.voipCallId})`);

  await new Promise<void>((resolve) => {
    service.once('call:ended', () => resolve());
  });

  console.log('\n[6] Call finished. Final state history:', stream.stateHistory.join(' -> '));
  await service.shutdownAll();
  try {
    sock.end(undefined);
  } catch {
    // Ignore close error
  }
}

main().catch((err) => {
  console.error('[FATAL] Real WhatsApp VoIP test failed:', err);
  process.exit(1);
});
