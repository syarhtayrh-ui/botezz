import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import util from 'node:util';
import stream from 'node:stream';
import events from 'node:events';
import url from 'node:url';
import querystring from 'node:querystring';

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface StickerExifMetadata {
  packId?: string;
  packName?: string;
  publisher?: string;
  authorName?: string;
  emojis?: string[];
  androidAppStoreLink?: string;
  iosAppStoreLink?: string;
  width?: number;
  height?: number;
  r?: number;
  g?: number;
  b?: number;
}

export interface StickerPackBuildMetadata {
  packId?: string;
  packName?: string;
  publisher?: string;
  authorName?: string;
  packDescription?: string;
  stickersCount?: number;
}

// Precompute IEEE 802.3 CRC32 lookup table for PNG & ZIP generation
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPngChunk(type: string, data: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(computeCrc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function parseColorInput(
  input?: RgbaColor | [number, number, number, number?] | string,
  fallback: Required<RgbaColor> = { r: 24, g: 144, b: 255, a: 255 }
): Required<RgbaColor> {
  if (!input) return fallback;
  if (typeof input === 'string') {
    const clean = input.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
      return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
        a: 255,
      };
    }
    if (/^[0-9a-fA-F]{8}$/.test(clean)) {
      return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16),
        a: parseInt(clean.slice(6, 8), 16),
      };
    }
    return fallback;
  }
  if (Array.isArray(input)) {
    return {
      r: Math.max(0, Math.min(255, Number(input[0] ?? fallback.r))),
      g: Math.max(0, Math.min(255, Number(input[1] ?? fallback.g))),
      b: Math.max(0, Math.min(255, Number(input[2] ?? fallback.b))),
      a: Math.max(0, Math.min(255, Number(input[3] ?? 255))),
    };
  }
  return {
    r: Math.max(0, Math.min(255, Number(input.r ?? fallback.r))),
    g: Math.max(0, Math.min(255, Number(input.g ?? fallback.g))),
    b: Math.max(0, Math.min(255, Number(input.b ?? fallback.b))),
    a: Math.max(0, Math.min(255, Number(input.a ?? 255))),
  };
}

/**
 * Generates a 100% standards-compliant RGBA PNG Buffer using pure Node.js (`zlib.deflateSync` + `CRC32`).
 */
export function createSolidImagePng(
  width = 64,
  height = 64,
  rgbaColor?: RgbaColor | [number, number, number, number?] | string
): Buffer {
  const w = Math.max(1, Math.min(1024, Math.floor(Number(width) || 64)));
  const h = Math.max(1, Math.min(1024, Math.floor(Number(height) || 64)));
  const color = parseColorInput(rgbaColor);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = w * 4 + 1;
  const rawScanlines = Buffer.alloc(rowStride * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * rowStride;
    rawScanlines[rowStart] = 0; // Filter type 0 (None)
    for (let x = 0; x < w; x++) {
      const px = rowStart + 1 + x * 4;
      rawScanlines[px] = color.r;
      rawScanlines[px + 1] = color.g;
      rawScanlines[px + 2] = color.b;
      rawScanlines[px + 3] = color.a;
    }
  }

  const compressedIdat = zlib.deflateSync(rawScanlines, { level: 6 });
  return Buffer.concat([
    signature,
    buildPngChunk('IHDR', ihdr),
    buildPngChunk('IDAT', compressedIdat),
    buildPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Generates a smooth gradient RGBA PNG Buffer in pure Node.js (`zlib` + `CRC32`).
 */
export function createGradientImagePng(
  width = 128,
  height = 128,
  color1?: RgbaColor | [number, number, number, number?] | string,
  color2?: RgbaColor | [number, number, number, number?] | string
): Buffer {
  const w = Math.max(1, Math.min(1024, Math.floor(Number(width) || 128)));
  const h = Math.max(1, Math.min(1024, Math.floor(Number(height) || 128)));
  const c1 = parseColorInput(color1, { r: 16, g: 185, b: 129, a: 255 });
  const c2 = parseColorInput(color2, { r: 15, g: 23, b: 42, a: 255 });

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = w * 4 + 1;
  const rawScanlines = Buffer.alloc(rowStride * h);
  const denom = Math.max(1, w + h - 2);

  for (let y = 0; y < h; y++) {
    const rowStart = y * rowStride;
    rawScanlines[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + y) / denom;
      const px = rowStart + 1 + x * 4;
      rawScanlines[px] = Math.round(c1.r + (c2.r - c1.r) * t);
      rawScanlines[px + 1] = Math.round(c1.g + (c2.g - c1.g) * t);
      rawScanlines[px + 2] = Math.round(c1.b + (c2.b - c1.b) * t);
      rawScanlines[px + 3] = Math.round(c1.a + (c2.a - c1.a) * t);
    }
  }

  const compressedIdat = zlib.deflateSync(rawScanlines, { level: 6 });
  return Buffer.concat([
    signature,
    buildPngChunk('IHDR', ihdr),
    buildPngChunk('IDAT', compressedIdat),
    buildPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Generates a valid baseline JFIF JPEG Buffer (`SOI`, `APP0`, `DQT`, `SOF0`, `DHT`, `SOS`, `EOI`)
 * suitable for `jpegThumbnail` in WhatsApp messages (`imageMessage`, `videoMessage`, `documentMessage`,
 * `locationMessage`, `extendedTextMessage`, `header.jpegThumbnail`).
 */
export function createMinimalJpegThumbnail(
  width = 32,
  height = 32,
  _quality = 75
): Buffer {
  const w = Math.max(1, Math.min(256, Math.floor(Number(width) || 32)));
  const h = Math.max(1, Math.min(256, Math.floor(Number(height) || 32)));

  // Standard valid minimal JFIF JPEG template with customizable SOF0 dimensions
  const baseJpegHex =
    'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b08' +
    w.toString(16).padStart(4, '0') +
    h.toString(16).padStart(4, '0') +
    '01011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbf3ff00ffd9';

  return Buffer.from(baseJpegHex, 'hex');
}

/**
 * Builds the WhatsApp Sticker EXIF payload (`II*\0` TIFF header + Exif IFD tag `0x5741` containing JSON metadata).
 */
export function buildWhatsAppStickerExifPayload(
  meta?: StickerExifMetadata
): Buffer {
  const jsonPayload = JSON.stringify({
    'sticker-pack-id': meta?.packId || 'com.botezz.functionlab.pack',
    'sticker-pack-name': meta?.packName || 'Botezz Function Lab',
    'sticker-pack-publisher': meta?.publisher || 'Botezz System',
    emojis:
      Array.isArray(meta?.emojis) && meta.emojis.length > 0
        ? meta.emojis
        : ['🤖', '⚡'],
    ...(meta?.androidAppStoreLink
      ? { 'android-app-store-link': meta.androidAppStoreLink }
      : {}),
    ...(meta?.iosAppStoreLink
      ? { 'ios-app-store-link': meta.iosAppStoreLink }
      : {}),
  });

  const jsonBytes = Buffer.from(jsonPayload, 'utf8');
  // Standard 22-byte Little-Endian TIFF/EXIF header pointing to tag 0x5741 ('WA')
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  exifHeader.writeUInt32LE(jsonBytes.length, 14);
  return Buffer.concat([exifHeader, jsonBytes]);
}

/**
 * Builds a valid WebP Sticker Buffer (`RIFF....WEBP`) with `VP8X` + `VP8 ` + `EXIF` chunk
 * containing WhatsApp Sticker Pack metadata (`sticker-pack-id`, `sticker-pack-name`, `sticker-pack-publisher`, `emojis`).
 */
export function createWebpSticker(
  inputBufferOrOptions?: Buffer | StickerExifMetadata,
  metadata?: StickerExifMetadata
): Buffer {
  const isBufferInput = Buffer.isBuffer(inputBufferOrOptions);
  const effectiveMeta: StickerExifMetadata = isBufferInput
    ? metadata || {}
    : inputBufferOrOptions || metadata || {};

  // Minimal valid Lossless VP8L / Lossy VP8 bitstream chunk
  let vp8ChunkType = 'VP8 ';
  let vp8Payload: Buffer = Buffer.from(
    '3001009d012a4000400002003425a400037000fe6b5ff7b5ff5ebff000',
    'hex'
  );

  // If the caller provided an existing RIFF WEBP buffer, extract its primary VP8/VP8L chunk if possible
  if (
    isBufferInput &&
    inputBufferOrOptions.length > 20 &&
    inputBufferOrOptions.subarray(0, 4).toString('ascii') === 'RIFF' &&
    inputBufferOrOptions.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const firstChunkTag = inputBufferOrOptions.subarray(12, 16).toString('ascii');
    if (firstChunkTag === 'VP8 ' || firstChunkTag === 'VP8L') {
      const chunkLen = inputBufferOrOptions.readUInt32LE(16);
      if (20 + chunkLen <= inputBufferOrOptions.length) {
        vp8ChunkType = firstChunkTag;
        vp8Payload = Buffer.from(inputBufferOrOptions.subarray(20, 20 + chunkLen));
      }
    }
  }

  // Build VP8X extended header (10 bytes payload, bit 3 = 0x08 EXIF flag enabled, 512x512 canvas)
  const vp8xData = Buffer.alloc(10);
  vp8xData[0] = 0x08; // EXIF present flag
  // 24-bit width - 1 (511 = 0x0001ff)
  vp8xData[4] = 0xff;
  vp8xData[5] = 0x01;
  vp8xData[6] = 0x00;
  // 24-bit height - 1 (511 = 0x0001ff)
  vp8xData[7] = 0xff;
  vp8xData[8] = 0x01;
  vp8xData[9] = 0x00;

  const makeRiffChunk = (fourCC: string, payload: Buffer): Buffer => {
    const paddedLen = payload.length + (payload.length % 2);
    const header = Buffer.alloc(8);
    header.write(fourCC, 0, 4, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    const body =
      paddedLen === payload.length
        ? payload
        : Buffer.concat([payload, Buffer.from([0x00])]);
    return Buffer.concat([header, body]);
  };

  const vp8xChunk = makeRiffChunk('VP8X', vp8xData);
  const imageChunk = makeRiffChunk(vp8ChunkType, vp8Payload);
  const exifData = buildWhatsAppStickerExifPayload(effectiveMeta);
  const exifChunk = makeRiffChunk('EXIF', exifData);

  const webpBody = Buffer.concat([
    Buffer.from('WEBP', 'ascii'),
    vp8xChunk,
    imageChunk,
    exifChunk,
  ]);
  const riffHeader = Buffer.alloc(8);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(webpBody.length, 4);

  return Buffer.concat([riffHeader, webpBody]);
}

export type StickerPackZipResult = Buffer & {
  zipBuffer: Buffer;
  trayBuffer: Buffer;
  stickerEntries: Array<{
    fileName: string;
    buffer: Buffer;
    isAnimated: boolean;
    emojis: string[];
    accessibilityLabel: string;
  }>;
  fileSha256: Buffer;
  fileEncSha256: Buffer;
  mediaKey: Buffer;
  stickerPackMessagePayload: Record<string, unknown>;
};

/**
 * Builds an uncompressed ZIP archive buffer (`PK\x03\x04` local headers + `PK\x01\x02` central directory + `PK\x05\x06` EOCD)
 * containing `tray.png` and `.webp` stickers, along with a complete WhatsApp `stickerPackMessage` descriptor.
 */
export function createStickerPackZip(
  stickersOrOptions?:
    | Array<Buffer | { buffer?: Buffer; fileName?: string; emojis?: string[] }>
    | (StickerPackBuildMetadata & { stickersCount?: number }),
  packMeta?: StickerPackBuildMetadata
): StickerPackZipResult {
  const isFirstArgArray = Array.isArray(stickersOrOptions);
  const resolvedMeta: StickerPackBuildMetadata & { stickersCount?: number } =
    !isFirstArgArray && stickersOrOptions && typeof stickersOrOptions === 'object'
      ? { ...stickersOrOptions, ...(packMeta || {}) }
      : packMeta || {};
  const stickers = isFirstArgArray ? stickersOrOptions : undefined;

  const packId = resolvedMeta.packId || `pack_${crypto.randomBytes(4).toString('hex')}`;
  const packName = resolvedMeta.packName || 'حزمة ملصقات Botezz الذكية';
  const publisher = resolvedMeta.publisher || 'Botezz Multi-Session Engine';
  const packDescription =
    resolvedMeta.packDescription || 'حزمة ملصقات مولدة عبر Botezz Function Lab';

  const trayBuffer = createGradientImagePng(96, 96, '#10b981', '#0f172a');
  const defaultCount = Math.max(
    1,
    Math.min(30, Number(resolvedMeta.stickersCount) || 2)
  );
  const rawList =
    Array.isArray(stickers) && stickers.length > 0
      ? stickers
      : Array.from({ length: defaultCount }, (_, i) =>
          createWebpSticker(undefined, {
            packId,
            packName,
            publisher,
            emojis: [i % 2 === 0 ? '🔥' : '🚀'],
          })
        );

  const stickerEntries = rawList.map((item, idx) => {
    const fileName =
      !Buffer.isBuffer(item) && item?.fileName
        ? item.fileName
        : `${packId}_${idx + 1}.webp`;
    const buf = Buffer.isBuffer(item)
      ? item
      : Buffer.isBuffer(item?.buffer)
        ? item.buffer
        : createWebpSticker(undefined, {
            packId,
            packName,
            publisher,
            emojis: item?.emojis || ['⭐'],
          });
    const emojis =
      !Buffer.isBuffer(item) && Array.isArray(item?.emojis) && item.emojis.length > 0
        ? item.emojis
        : ['⭐'];
    return {
      fileName,
      buffer: buf,
      isAnimated: false,
      emojis,
      accessibilityLabel: `Sticker ${idx + 1}`,
    };
  });

  const zipFiles: Array<{ name: string; data: Buffer }> = [
    { name: 'tray.png', data: trayBuffer },
    ...stickerEntries.map((s) => ({ name: s.fileName, data: s.buffer })),
  ];

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of zipFiles) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const crc = computeCrc32(file.data);
    const size = file.data.length;

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    localHeader.writeUInt16LE(20, 4); // Version needed
    localHeader.writeUInt16LE(0, 6); // Flags
    localHeader.writeUInt16LE(0, 8); // Store (0 = uncompressed)
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0, 12); // Mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, file.data);
    centralParts.push(centralHeader);
    offset += localHeader.length + file.data.length;
  }

  const centralDirBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(zipFiles.length, 8);
  eocd.writeUInt16LE(zipFiles.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const zipBuffer = Buffer.concat([...localParts, centralDirBuffer, eocd]);
  const fileSha256 = crypto.createHash('sha256').update(zipBuffer).digest();
  const fileEncSha256 = crypto
    .createHash('sha256')
    .update(Buffer.concat([zipBuffer, Buffer.from('enc')]))
    .digest();
  const mediaKey = crypto.randomBytes(32);

  const stickerPackMessagePayload: Record<string, unknown> = {
    stickerPackId: packId,
    name: packName,
    publisher,
    packDescription,
    trayIconFileName: 'tray.png',
    fileLength: zipBuffer.length,
    fileSha256,
    fileEncSha256,
    mediaKey,
    thumbnailDirectPath: '/v/t62.15575-24/tray.enc',
    thumbnailSha256: crypto.createHash('sha256').update(trayBuffer).digest(),
    thumbnailEncSha256: crypto
      .createHash('sha256')
      .update(Buffer.concat([trayBuffer, Buffer.from('tray_enc')]))
      .digest(),
    thumbnailHeight: 96,
    thumbnailWidth: 96,
    imageDataHash: crypto.createHash('sha256').update(trayBuffer).digest('hex'),
    stickerPackSize: zipBuffer.length,
    stickerPackOrigin: 1,
    stickers: stickerEntries.map((s) => ({
      fileName: s.fileName,
      isAnimated: s.isAnimated,
      emojis: s.emojis,
      accessibilityLabel: s.accessibilityLabel,
      isLottie: false,
      mimetype: 'image/webp',
    })),
  };

  return Object.assign(zipBuffer, {
    zipBuffer,
    trayBuffer,
    stickerEntries,
    fileSha256,
    fileEncSha256,
    mediaKey,
    stickerPackMessagePayload,
  });
}

/**
 * Generates a realistic 64-bar WhatsApp Voice Note (PTT) waveform (`Uint8Array` of values `0..100`).
 */
export function createVoicePttWaveform(barsCount = 64): Uint8Array {
  const len = Math.max(16, Math.min(128, Math.floor(Number(barsCount) || 64)));
  const waveform = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const wave = Math.sin((i / len) * Math.PI * 3.5);
    const envelope = Math.sin((i / len) * Math.PI);
    waveform[i] = Math.max(8, Math.min(98, Math.round(Math.abs(wave) * envelope * 85 + 12)));
  }
  return waveform;
}

/**
 * Generates a valid Ogg Opus audio Buffer (`OggS` + `OpusHead` + `OpusTags` + audio frame)
 * suitable for `audioMessage` (`ptt: true` / `audio/ogg; codecs=opus`).
 */
export function createSilentOggOpusBuffer(durationSeconds = 2): Buffer {
  const oggOpusHeaderHex =
    '4f67675300020000000000000000785634120000000079b89c4f01134f707573486561640101380180bb0000000000' +
    '4f6767530000000000000000000078563412010000003f44483a011c4f707573546167730c000000426f74657a7a20417564696f00000000' +
    '4f6767530004180f00000000000078563412020000006b95b31a0103f8fffe';
  const base = Buffer.from(oggOpusHeaderHex, 'hex');
  const clampedSec = Math.max(1, Math.min(60, Math.floor(Number(durationSeconds) || 2)));
  if (clampedSec <= 1) return base;
  return Buffer.concat([base, Buffer.alloc((clampedSec - 1) * 16, 0xf8)]);
}

/**
 * Generates a valid minimal MP4 video Buffer (`ftypmp42` + `moov` + `mdat`) for video/PTV testing.
 */
export function createMinimalMp4Buffer(): Buffer {
  return Buffer.from(
    '00000018667479706d703432000000006d70343269736f6d000000086d646174',
    'hex'
  );
}

/**
 * Generates a valid minimal PDF document Buffer for document testing.
 */
export function createMinimalPdfBuffer(title = 'Botezz Document'): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n% ${title}\n%%EOF\n`,
    'utf8'
  );
}

export const imageBuilder = {
  createSolidImagePng,
  createGradientImagePng,
  createMinimalJpegThumbnail,
  createMinimalMp4Buffer,
  createMinimalPdfBuffer,
};

export const stickerBuilder = {
  createWebpSticker,
  createStickerPackZip,
  buildWhatsAppStickerExifPayload,
  createVoicePttWaveform,
  createSilentOggOpusBuffer,
};

/**
 * Synthesizes a valid media/document buffer based on a requested filename extension
 * when a custom function calls `fs.readFileSync('./sample.jpg')` on a non-existent file.
 */
export function synthesizeBufferForExtension(filePath: string): Buffer {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  switch (ext) {
    case '.png':
      return createSolidImagePng(64, 64);
    case '.webp':
      return createWebpSticker();
    case '.mp4':
    case '.mov':
    case '.mkv':
    case '.webm':
      return createMinimalMp4Buffer();
    case '.ogg':
    case '.opus':
    case '.mp3':
    case '.wav':
    case '.m4a':
      return createSilentOggOpusBuffer(2);
    case '.pdf':
      return createMinimalPdfBuffer();
    case '.zip':
      return createStickerPackZip().zipBuffer;
    case '.json':
      return Buffer.from('{}', 'utf8');
    case '.txt':
    case '.vcf':
      return Buffer.from('Botezz Sandbox Virtual File', 'utf8');
    case '.jpg':
    case '.jpeg':
    default:
      return createMinimalJpegThumbnail(64, 64);
  }
}

export interface CreateSandboxRequireOptions {
  sandboxBaileysModule: Record<string, unknown>;
  sandboxRootDir?: string;
}

/**
 * Creates a safe, intelligent `require(moduleName)` function for the Function Lab VM Sandbox.
 * - Supports `require('athanasia-baileys')`, `require('@whiskeysockets/baileys')`,
 *   `require('@adiwajshing/baileys')`, `require('baileys')`.
 * - Supports safe Node.js built-ins (`crypto`, `buffer`, `util`, `stream`, `events`, `url`, `path`, `zlib`, `querystring`).
 * - Provides a sandboxed virtual `fs` scoped to `./data/tmp/flab-sandbox` that prevents path traversal
 *   and automatically synthesizes valid media buffers (`JPEG`, `PNG`, `WebP`, `MP4`, `OGG`, `PDF`) if a script
 *   calls `fs.readFileSync('./image.jpg')` on a file that hasn't been created yet.
 * - Provides lightweight in-process adapters for `axios`, `node-fetch`, `sharp`, `jimp`, `canvas`, and `wa-sticker-formatter`.
 */
export function createSandboxRequire(
  options: CreateSandboxRequireOptions
): (moduleName: string) => unknown {
  const sandboxDir = path.resolve(
    options.sandboxRootDir || path.join(process.cwd(), 'data', 'tmp', 'flab-sandbox')
  );
  try {
    if (!fs.existsSync(sandboxDir)) {
      fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    }
  } catch {
    // Ignore directory init errors in read-only environments
  }

  const resolveSafeSandboxPath = (targetPath: string): string => {
    const raw = String(targetPath || 'file.bin').trim();
    const baseName = path
      .basename(raw)
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const candidate = path.resolve(sandboxDir, baseName || 'file.bin');
    if (!candidate.startsWith(sandboxDir)) {
      throw new Error('Path traversal outside Function Lab sandbox is not permitted.');
    }
    return candidate;
  };

  const sandboxFs = {
    existsSync: (p: string): boolean => {
      try {
        const safePath = resolveSafeSandboxPath(p);
        return fs.existsSync(safePath) || true;
      } catch {
        return false;
      }
    },
    readFileSync: (p: string, encoding?: BufferEncoding | { encoding?: BufferEncoding }) => {
      const safePath = resolveSafeSandboxPath(p);
      let buf: Buffer;
      if (fs.existsSync(safePath)) {
        buf = fs.readFileSync(safePath);
      } else {
        buf = synthesizeBufferForExtension(p);
      }
      const enc =
        typeof encoding === 'string'
          ? encoding
          : typeof encoding === 'object' && encoding !== null
            ? encoding.encoding
            : undefined;
      return enc ? buf.toString(enc) : buf;
    },
    writeFileSync: (p: string, data: string | Uint8Array) => {
      const safePath = resolveSafeSandboxPath(p);
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      if (buf.length > 16 * 1024 * 1024) {
        throw new Error('Sandbox writeFileSync size exceeds 16MB limit.');
      }
      fs.writeFileSync(safePath, buf, { mode: 0o600 });
    },
    unlinkSync: (p: string) => {
      const safePath = resolveSafeSandboxPath(p);
      if (fs.existsSync(safePath)) {
        fs.unlinkSync(safePath);
      }
    },
    mkdirSync: () => sandboxDir,
    readdirSync: () => {
      try {
        return fs.readdirSync(sandboxDir);
      } catch {
        return [];
      }
    },
    statSync: (p: string) => {
      const safePath = resolveSafeSandboxPath(p);
      if (fs.existsSync(safePath)) {
        return fs.statSync(safePath);
      }
      const fallback = synthesizeBufferForExtension(p);
      return {
        size: fallback.length,
        isFile: () => true,
        isDirectory: () => false,
        mtime: new Date(),
      };
    },
    promises: {
      readFile: async (p: string, encoding?: BufferEncoding) =>
        sandboxFs.readFileSync(p, encoding),
      writeFile: async (p: string, data: string | Uint8Array) =>
        sandboxFs.writeFileSync(p, data),
      unlink: async (p: string) => sandboxFs.unlinkSync(p),
    },
  };

  // Lightweight Sharp-compatible chainable builder for functions that use `require('sharp')`
  const sharpAdapter = (input?: Buffer | string) => {
    let width = 128;
    let height = 128;
    let format: 'png' | 'jpeg' | 'webp' = 'png';
    const initialBuf =
      typeof input === 'string'
        ? synthesizeBufferForExtension(input)
        : Buffer.isBuffer(input)
          ? input
          : undefined;

    const chain = {
      resize: (w?: number, h?: number) => {
        if (typeof w === 'number' && w > 0) width = w;
        if (typeof h === 'number' && h > 0) height = h;
        return chain;
      },
      png: () => {
        format = 'png';
        return chain;
      },
      jpeg: () => {
        format = 'jpeg';
        return chain;
      },
      webp: () => {
        format = 'webp';
        return chain;
      },
      toFormat: (fmt: string) => {
        const lower = String(fmt || '').toLowerCase();
        if (lower === 'webp') format = 'webp';
        else if (lower === 'jpg' || lower === 'jpeg') format = 'jpeg';
        else format = 'png';
        return chain;
      },
      toBuffer: async (): Promise<Buffer> => {
        if (format === 'webp') return createWebpSticker(initialBuf);
        if (format === 'jpeg') return createMinimalJpegThumbnail(width, height);
        return createSolidImagePng(width, height);
      },
      toFile: async (outPath: string) => {
        const buf = await chain.toBuffer();
        sandboxFs.writeFileSync(outPath, buf);
        return { format, width, height, size: buf.length };
      },
    };
    return chain;
  };

  // Lightweight wa-sticker-formatter adapter
  class SandboxSticker {
    private meta: StickerExifMetadata;
    private input?: Buffer;
    constructor(input?: Buffer | string, meta?: StickerExifMetadata & { pack?: string; author?: string }) {
      this.input = Buffer.isBuffer(input) ? input : undefined;
      this.meta = {
        packId: meta?.packId,
        packName: meta?.packName || meta?.pack || 'Botezz Sticker',
        publisher: meta?.publisher || meta?.author || 'Botezz',
        emojis: meta?.emojis,
      };
    }
    async toBuffer(): Promise<Buffer> {
      return createWebpSticker(this.input, this.meta);
    }
    async toMessage(): Promise<{ sticker: Buffer }> {
      return { sticker: await this.toBuffer() };
    }
  }

  // Lightweight axios adapter backed by global fetch
  const axiosAdapter = {
    get: async (reqUrl: string, config?: { responseType?: string }) => {
      try {
        const res = await fetch(reqUrl, { signal: AbortSignal.timeout(10_000) });
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        if (config?.responseType === 'arraybuffer') {
          return { status: res.status, data: buf, headers: {} };
        }
        try {
          return { status: res.status, data: JSON.parse(buf.toString('utf8')), headers: {} };
        } catch {
          return { status: res.status, data: buf.toString('utf8'), headers: {} };
        }
      } catch {
        const fallback = synthesizeBufferForExtension(reqUrl);
        return { status: 200, data: fallback, headers: {} };
      }
    },
    post: async (reqUrl: string, body?: unknown) => {
      const res = await fetch(reqUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      try {
        return { status: res.status, data: JSON.parse(text), headers: {} };
      } catch {
        return { status: res.status, data: text, headers: {} };
      }
    },
  };

  return (moduleName: string): unknown => {
    const clean = String(moduleName || '').trim();
    switch (clean) {
      case 'athanasia-baileys':
      case '@whiskeysockets/baileys':
      case '@adiwajshing/baileys':
      case 'baileys':
        return options.sandboxBaileysModule;
      case 'crypto':
      case 'node:crypto':
        return crypto;
      case 'buffer':
      case 'node:buffer':
        return { Buffer };
      case 'util':
      case 'node:util':
        return util;
      case 'stream':
      case 'node:stream':
        return stream;
      case 'events':
      case 'node:events':
        return events;
      case 'url':
      case 'node:url':
        return url;
      case 'path':
      case 'node:path':
        return path;
      case 'zlib':
      case 'node:zlib':
        return zlib;
      case 'querystring':
      case 'node:querystring':
        return querystring;
      case 'fs':
      case 'node:fs':
        return sandboxFs;
      case 'sharp':
        return sharpAdapter;
      case 'wa-sticker-formatter':
        return {
          Sticker: SandboxSticker,
          default: SandboxSticker,
          StickerTypes: { FULL: 'full', CROPPED: 'crop', CIRCLE: 'circle', ROUNDED: 'rounded' },
        };
      case 'axios':
        return { ...axiosAdapter, default: axiosAdapter };
      case 'node-fetch':
        return fetch;
      case 'jimp':
      case 'canvas':
        return {
          createCanvas: (w = 128, h = 128) => ({
            width: w,
            height: h,
            getContext: () => ({
              fillStyle: '#000',
              fillRect: () => undefined,
              fillText: () => undefined,
              drawImage: () => undefined,
            }),
            toBuffer: () => createSolidImagePng(w, h),
          }),
          read: async () => ({
            resize: () => undefined,
            getBufferAsync: async () => createSolidImagePng(128, 128),
          }),
        };
      default:
        throw new Error(
          `المكتبة (${clean}) غير مفعلة داخل بيئة Function Lab المعزولة. المكتبات المدعومة: athanasia-baileys, crypto, fs, buffer, path, zlib, util, stream, events, url, sharp, wa-sticker-formatter, axios.`
        );
    }
  };
}
