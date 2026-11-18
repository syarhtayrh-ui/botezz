import crypto from 'node:crypto';
import {
  computeSunAndShadowForensics,
  type SunAndShadowCalculation,
} from './geo-aviation-maritime-osint';

export interface ExtractedGpsCoordinates {
  latitude: number;
  longitude: number;
  altitudeMeters?: number;
  gpsDateStamp?: string;
  dmsFormatted: string;
  googleMapsUrl: string;
}

export interface MediaForensicMetadataReport {
  fileName: string;
  fileSizeBytes: number;
  detectedMimeType: string;
  detectedFormat: 'JPEG' | 'PNG' | 'WEBP' | 'GIF' | 'PDF' | 'MP4' | 'UNKNOWN';
  md5: string;
  sha1: string;
  sha256: string;
  width?: number;
  height?: number;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  software?: string;
  dateTimeOriginal?: string;
  createDate?: string;
  modifyDate?: string;
  authorOrArtist?: string;
  pdfMetadata?: {
    title?: string;
    author?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
  };
  pngTextChunks: Array<{ keyword: string; value: string }>;
  xmpSummary?: string;
  gps?: ExtractedGpsCoordinates;
  sunShadowForensics?: SunAndShadowCalculation;
  authenticityAssessment: {
    hasOriginalExif: boolean;
    likelySocialMediaStripped: boolean;
    editingSoftwareDetected: boolean;
    summaryArabic: string;
  };
  reverseImageLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

export interface SanitizedMediaResult {
  originalSizeBytes: number;
  sanitizedSizeBytes: number;
  bytesRemoved: number;
  removedSegmentsCount: number;
  sanitizedBuffer: Buffer;
  format: 'JPEG' | 'PNG' | 'UNMODIFIED';
}

function readUInt16(buf: Buffer, offset: number, littleEndian: boolean): number {
  if (offset + 2 > buf.length) return 0;
  return littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

function readUInt32(buf: Buffer, offset: number, littleEndian: boolean): number {
  if (offset + 4 > buf.length) return 0;
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function readAsciiString(buf: Buffer, offset: number, length: number): string {
  if (offset < 0 || length <= 0 || offset + length > buf.length) return '';
  return buf
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0+$/g, '')
    .trim();
}

function readRationalArray(
  tiffBuf: Buffer,
  valueOffset: number,
  count: number,
  littleEndian: boolean
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const pos = valueOffset + i * 8;
    if (pos + 8 > tiffBuf.length) break;
    const num = readUInt32(tiffBuf, pos, littleEndian);
    const den = readUInt32(tiffBuf, pos + 4, littleEndian);
    out.push(den !== 0 ? num / den : 0);
  }
  return out;
}

interface ParsedExifBlock {
  make?: string;
  model?: string;
  software?: string;
  modifyDate?: string;
  artist?: string;
  dateTimeOriginal?: string;
  createDate?: string;
  lensModel?: string;
  gps?: ExtractedGpsCoordinates;
}

function parseTiffExifBuffer(tiffBuf: Buffer): ParsedExifBlock {
  const result: ParsedExifBlock = {};
  if (tiffBuf.length < 8) return result;

  const byteOrder = tiffBuf.subarray(0, 2).toString('ascii');
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') return result;

  const magic = readUInt16(tiffBuf, 2, littleEndian);
  if (magic !== 42) return result;

  const ifd0Offset = readUInt32(tiffBuf, 4, littleEndian);
  if (ifd0Offset < 8 || ifd0Offset >= tiffBuf.length) return result;

  let exifSubIfdOffset = 0;
  let gpsIfdOffset = 0;

  const readIfdString = (
    type: number,
    count: number,
    entryOffset: number
  ): string | undefined => {
    if (type !== 2 || count <= 0) return undefined;
    const valOffset =
      count <= 4
        ? entryOffset + 8
        : readUInt32(tiffBuf, entryOffset + 8, littleEndian);
    const str = readAsciiString(tiffBuf, valOffset, count);
    return str || undefined;
  };

  // Parse IFD0
  const ifd0Count = readUInt16(tiffBuf, ifd0Offset, littleEndian);
  for (let i = 0; i < Math.min(ifd0Count, 128); i += 1) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > tiffBuf.length) break;
    const tag = readUInt16(tiffBuf, entryOffset, littleEndian);
    const type = readUInt16(tiffBuf, entryOffset + 2, littleEndian);
    const count = readUInt32(tiffBuf, entryOffset + 4, littleEndian);

    if (tag === 0x010f) {
      result.make = readIfdString(type, count, entryOffset);
    } else if (tag === 0x0110) {
      result.model = readIfdString(type, count, entryOffset);
    } else if (tag === 0x0131) {
      result.software = readIfdString(type, count, entryOffset);
    } else if (tag === 0x0132) {
      result.modifyDate = readIfdString(type, count, entryOffset);
    } else if (tag === 0x013b) {
      result.artist = readIfdString(type, count, entryOffset);
    } else if (tag === 0x8769) {
      exifSubIfdOffset = readUInt32(tiffBuf, entryOffset + 8, littleEndian);
    } else if (tag === 0x8825) {
      gpsIfdOffset = readUInt32(tiffBuf, entryOffset + 8, littleEndian);
    }
  }

  // Parse ExifSubIFD
  if (exifSubIfdOffset > 0 && exifSubIfdOffset + 2 <= tiffBuf.length) {
    const subCount = readUInt16(tiffBuf, exifSubIfdOffset, littleEndian);
    for (let i = 0; i < Math.min(subCount, 128); i += 1) {
      const entryOffset = exifSubIfdOffset + 2 + i * 12;
      if (entryOffset + 12 > tiffBuf.length) break;
      const tag = readUInt16(tiffBuf, entryOffset, littleEndian);
      const type = readUInt16(tiffBuf, entryOffset + 2, littleEndian);
      const count = readUInt32(tiffBuf, entryOffset + 4, littleEndian);

      if (tag === 0x9003) {
        result.dateTimeOriginal = readIfdString(type, count, entryOffset);
      } else if (tag === 0x9004) {
        result.createDate = readIfdString(type, count, entryOffset);
      } else if (tag === 0xa434) {
        result.lensModel = readIfdString(type, count, entryOffset);
      }
    }
  }

  // Parse GPSIFD
  if (gpsIfdOffset > 0 && gpsIfdOffset + 2 <= tiffBuf.length) {
    const gpsCount = readUInt16(tiffBuf, gpsIfdOffset, littleEndian);
    let latRef = 'N';
    let lonRef = 'E';
    let altRef = 0;
    let latRationals: number[] = [];
    let lonRationals: number[] = [];
    let altMeters: number | undefined;
    let gpsDateStamp: string | undefined;

    for (let i = 0; i < Math.min(gpsCount, 64); i += 1) {
      const entryOffset = gpsIfdOffset + 2 + i * 12;
      if (entryOffset + 12 > tiffBuf.length) break;
      const tag = readUInt16(tiffBuf, entryOffset, littleEndian);
      const type = readUInt16(tiffBuf, entryOffset + 2, littleEndian);
      const count = readUInt32(tiffBuf, entryOffset + 4, littleEndian);

      if (tag === 0x0001) {
        const ref = readIfdString(type, count, entryOffset);
        if (ref) latRef = ref.toUpperCase();
      } else if (tag === 0x0002 && type === 5 && count >= 3) {
        const valOffset = readUInt32(tiffBuf, entryOffset + 8, littleEndian);
        latRationals = readRationalArray(tiffBuf, valOffset, 3, littleEndian);
      } else if (tag === 0x0003) {
        const ref = readIfdString(type, count, entryOffset);
        if (ref) lonRef = ref.toUpperCase();
      } else if (tag === 0x0004 && type === 5 && count >= 3) {
        const valOffset = readUInt32(tiffBuf, entryOffset + 8, littleEndian);
        lonRationals = readRationalArray(tiffBuf, valOffset, 3, littleEndian);
      } else if (tag === 0x0005 && entryOffset + 9 <= tiffBuf.length) {
        altRef = tiffBuf[entryOffset + 8] || 0;
      } else if (tag === 0x0006 && type === 5 && count >= 1) {
        const valOffset = readUInt32(tiffBuf, entryOffset + 8, littleEndian);
        const arr = readRationalArray(tiffBuf, valOffset, 1, littleEndian);
        if (arr.length > 0) altMeters = arr[0];
      } else if (tag === 0x001d) {
        gpsDateStamp = readIfdString(type, count, entryOffset);
      }
    }

    if (latRationals.length === 3 && lonRationals.length === 3) {
      const rawLat =
        (latRationals[0] || 0) +
        (latRationals[1] || 0) / 60 +
        (latRationals[2] || 0) / 3600;
      const rawLon =
        (lonRationals[0] || 0) +
        (lonRationals[1] || 0) / 60 +
        (lonRationals[2] || 0) / 3600;

      const latitude = Number(
        (latRef.startsWith('S') ? -rawLat : rawLat).toFixed(6)
      );
      const longitude = Number(
        (lonRef.startsWith('W') ? -rawLon : rawLon).toFixed(6)
      );
      const signedAlt =
        typeof altMeters === 'number'
          ? Number((altRef === 1 ? -altMeters : altMeters).toFixed(1))
          : undefined;

      const dmsFormatted = `${Math.floor(latRationals[0] || 0)}°${Math.floor(
        latRationals[1] || 0
      )}'${(latRationals[2] || 0).toFixed(1)}"${latRef[0] || 'N'} ${Math.floor(
        lonRationals[0] || 0
      )}°${Math.floor(lonRationals[1] || 0)}'${(lonRationals[2] || 0).toFixed(
        1
      )}"${lonRef[0] || 'E'}`;

      result.gps = {
        latitude,
        longitude,
        altitudeMeters: signedAlt,
        gpsDateStamp,
        dmsFormatted,
        googleMapsUrl: `https://www.google.com/maps?q=${latitude},${longitude}`,
      };
    }
  }

  return result;
}

function exifDateToIso(exifDate?: string): string | undefined {
  if (!exifDate) return undefined;
  // Standard EXIF date: "YYYY:MM:DD HH:MM:SS"
  const m = exifDate
    .trim()
    .match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }
  const parsed = new Date(exifDate);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function buildReverseImageSearchLinks(): Array<{
  toolName: string;
  url: string;
  descriptionArabic: string;
}> {
  return [
    {
      toolName: 'Google Lens Visual Search',
      url: 'https://lens.google.com/',
      descriptionArabic: 'البحث البصري العكسي والتعرف على المعالم والمنتجات (Google Lens)',
    },
    {
      toolName: 'Yandex Images Reverse Search',
      url: 'https://yandex.com/images/',
      descriptionArabic: 'أقوى محرك بحث عكسي عن الوجوه والأماكن والمباني (Yandex Images)',
    },
    {
      toolName: 'TinEye Reverse Image Search',
      url: 'https://tineye.com/',
      descriptionArabic: 'تتبع أقدم ظهور للصورة على الإنترنت وتعديلاتها (TinEye)',
    },
    {
      toolName: 'Forensically (29a.ch)',
      url: 'https://29a.ch/photo-forensics/',
      descriptionArabic: 'مختبر تحليل التلاعب الرقمي ومستوى ضغط الأخطاء ELA واستنساخ البكسلات',
    },
    {
      toolName: 'FotoForensics ELA',
      url: 'https://fotoforensics.com/',
      descriptionArabic: 'تحليل Error Level Analysis (ELA) لكشف الفوتوشوب والتعديلات',
    },
    {
      toolName: 'Bing Visual Search',
      url: 'https://www.bing.com/visualsearch',
      descriptionArabic: 'البحث العكسي ومطابقة العناصر داخل الصورة (Bing Visual Search)',
    },
  ];
}

export function extractMediaForensicMetadata(
  buffer: Buffer,
  fileName = 'evidence_media.bin',
  mimeTypeHint?: string
): MediaForensicMetadataReport {
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  let detectedFormat: MediaForensicMetadataReport['detectedFormat'] = 'UNKNOWN';
  let detectedMimeType = mimeTypeHint || 'application/octet-stream';
  let width: number | undefined;
  let height: number | undefined;

  let parsedExif: ParsedExifBlock = {};
  let xmpSummary: string | undefined;
  const pngTextChunks: Array<{ keyword: string; value: string }> = [];
  let pdfMetadata: MediaForensicMetadataReport['pdfMetadata'];

  // 1. Magic Bytes Detection
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    detectedFormat = 'JPEG';
    detectedMimeType = 'image/jpeg';

    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1]!;
      if (marker === 0xd9 || marker === 0xda) {
        break; // EOI or SOS
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segLength = buffer.readUInt16BE(offset + 2);
      if (segLength < 2 || offset + 2 + segLength > buffer.length) break;

      const payload = buffer.subarray(offset + 4, offset + 2 + segLength);

      // APP1 (Exif or XMP)
      if (marker === 0xe1) {
        if (
          payload.length > 6 &&
          payload.subarray(0, 6).toString('ascii') === 'Exif\0\0'
        ) {
          parsedExif = parseTiffExifBuffer(payload.subarray(6));
        } else if (
          payload.length > 29 &&
          payload.subarray(0, 29).toString('ascii') ===
            'http://ns.adobe.com/xap/1.0/\0'
        ) {
          const xmpStr = payload.subarray(29).toString('utf8');
          const creatorTool = xmpStr.match(/CreatorTool="([^"]+)"/i)?.[1];
          const createDate = xmpStr.match(/CreateDate="([^"]+)"/i)?.[1];
          xmpSummary = [
            creatorTool ? `CreatorTool: ${creatorTool}` : '',
            createDate ? `CreateDate: ${createDate}` : '',
          ]
            .filter(Boolean)
            .join(' | ') || 'حزمة بيانات Adobe XMP مضمنة';
        }
      }

      // SOF0 / SOF2 dimensions
      if (
        (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) &&
        payload.length >= 5
      ) {
        height = payload.readUInt16BE(1);
        width = payload.readUInt16BE(3);
      }

      offset += 2 + segLength;
    }
  } else if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    detectedFormat = 'PNG';
    detectedMimeType = 'image/png';
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);

    let offset = 8;
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > buffer.length) break;

      const chunkData = buffer.subarray(dataStart, dataEnd);
      if (type === 'tEXt' || type === 'iTXt') {
        const nullIdx = chunkData.indexOf(0);
        if (nullIdx > 0) {
          const keyword = chunkData.subarray(0, nullIdx).toString('utf8');
          const value = chunkData
            .subarray(nullIdx + 1)
            .toString('utf8')
            .replace(/\0+/g, ' ')
            .trim()
            .slice(0, 200);
          pngTextChunks.push({ keyword, value });
        }
      } else if (type === 'eXIf') {
        parsedExif = parseTiffExifBuffer(chunkData);
      }
      if (type === 'IEND') break;
      offset = dataEnd + 4;
    }
  } else if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    detectedFormat = 'WEBP';
    detectedMimeType = 'image/webp';
  } else if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    detectedFormat = 'GIF';
    detectedMimeType = 'image/gif';
    if (buffer.length >= 10) {
      width = buffer.readUInt16LE(6);
      height = buffer.readUInt16LE(8);
    }
  } else if (
    buffer.length >= 5 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  ) {
    detectedFormat = 'PDF';
    detectedMimeType = 'application/pdf';
    const textSample = buffer
      .subarray(0, Math.min(buffer.length, 250_000))
      .toString('latin1');
    const extractPdfField = (key: string): string | undefined => {
      const re = new RegExp(`\\/${key}\\s*\\(([^\\)]{1,140})\\)`, 'i');
      return textSample.match(re)?.[1]?.trim();
    };
    pdfMetadata = {
      title: extractPdfField('Title'),
      author: extractPdfField('Author'),
      creator: extractPdfField('Creator'),
      producer: extractPdfField('Producer'),
      creationDate: extractPdfField('CreationDate'),
      modDate: extractPdfField('ModDate'),
    };
  } else if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    detectedFormat = 'MP4';
    detectedMimeType = 'video/mp4';
  }

  const hasOriginalExif = Boolean(
    parsedExif.make ||
      parsedExif.model ||
      parsedExif.dateTimeOriginal ||
      parsedExif.gps
  );
  const editingSoftwareDetected = Boolean(
    parsedExif.software &&
      /photoshop|lightroom|gimp|canva|snapseed|picsart|affinity|ffmpeg/i.test(
        parsedExif.software
      )
  );
  const likelySocialMediaStripped =
    (detectedFormat === 'JPEG' || detectedFormat === 'PNG') &&
    !hasOriginalExif &&
    pngTextChunks.length === 0 &&
    !xmpSummary;

  let summaryArabic = 'ملف وسائط قياسي.';
  if (hasOriginalExif && parsedExif.gps) {
    summaryArabic =
      '🟢 الصورة تحتفظ ببيانات الكاميرا الأصلية (EXIF) وإحداثيات GPS الجغرافية الدقيقة.';
  } else if (hasOriginalExif) {
    summaryArabic =
      '🟢 الصورة تحتفظ ببصمة الكاميرا الأصلية (EXIF) بدون إحداثيات GPS مرفقة.';
  } else if (editingSoftwareDetected) {
    summaryArabic = `🟡 تم رصد معالجة الصورة عبر برنامج تحرير (${parsedExif.software}).`;
  } else if (likelySocialMediaStripped) {
    summaryArabic =
      '⚪ تم تجريد بيانات EXIF مسبقاً (سلوك معتاد لصور واتساب/تيليجرام/فيسبوك المضغوطة).';
  }

  let sunShadowForensics: SunAndShadowCalculation | undefined;
  if (parsedExif.gps) {
    const isoDate =
      exifDateToIso(parsedExif.dateTimeOriginal) ||
      exifDateToIso(parsedExif.createDate) ||
      exifDateToIso(parsedExif.modifyDate);
    sunShadowForensics = computeSunAndShadowForensics(
      parsedExif.gps.latitude,
      parsedExif.gps.longitude,
      isoDate
    );
  }

  return {
    fileName,
    fileSizeBytes: buffer.length,
    detectedMimeType,
    detectedFormat,
    md5,
    sha1,
    sha256,
    width,
    height,
    cameraMake: parsedExif.make,
    cameraModel: parsedExif.model,
    lensModel: parsedExif.lensModel,
    software: parsedExif.software,
    dateTimeOriginal: parsedExif.dateTimeOriginal,
    createDate: parsedExif.createDate,
    modifyDate: parsedExif.modifyDate,
    authorOrArtist: parsedExif.artist,
    pdfMetadata,
    pngTextChunks,
    xmpSummary,
    gps: parsedExif.gps,
    sunShadowForensics,
    authenticityAssessment: {
      hasOriginalExif,
      likelySocialMediaStripped,
      editingSoftwareDetected,
      summaryArabic,
    },
    reverseImageLinks: buildReverseImageSearchLinks(),
  };
}

/**
 * Native ExifPurge implementation: strips JPEG APP1..APP15 (EXIF, XMP, ICC, IPTC)
 * and COM (comment) markers, or PNG ancillary metadata chunks (tEXt, iTXt, zTXt, eXIf, tIME),
 * returning a clean, privacy-hardened image buffer without re-encoding pixel data.
 */
export function sanitizeImageMetadata(buffer: Buffer): SanitizedMediaResult {
  // Case 1: JPEG
  if (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    const chunks: Buffer[] = [buffer.subarray(0, 2)]; // SOI (0xFFD8)
    let offset = 2;
    let removedSegmentsCount = 0;

    while (offset + 2 <= buffer.length) {
      if (buffer[offset] !== 0xff) {
        chunks.push(buffer.subarray(offset));
        break;
      }
      const marker = buffer[offset + 1]!;
      // SOS (Start of Scan 0xDA) or EOI (0xD9): copy the rest of the image bitstream intact
      if (marker === 0xda || marker === 0xd9) {
        chunks.push(buffer.subarray(offset));
        break;
      }
      if (
        marker === 0xd8 ||
        marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        chunks.push(buffer.subarray(offset, offset + 2));
        offset += 2;
        continue;
      }
      if (offset + 4 > buffer.length) {
        chunks.push(buffer.subarray(offset));
        break;
      }
      const segLength = buffer.readUInt16BE(offset + 2);
      if (segLength < 2 || offset + 2 + segLength > buffer.length) {
        chunks.push(buffer.subarray(offset));
        break;
      }

      // Strip APP1..APP15 (0xE1..0xEF) and COM (0xFE); keep APP0 (0xE0 JFIF) and quantization/Huffman tables
      const isMetadataMarker =
        (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
      if (isMetadataMarker) {
        removedSegmentsCount += 1;
      } else {
        chunks.push(buffer.subarray(offset, offset + 2 + segLength));
      }
      offset += 2 + segLength;
    }

    const sanitizedBuffer = Buffer.concat(chunks);
    return {
      originalSizeBytes: buffer.length,
      sanitizedSizeBytes: sanitizedBuffer.length,
      bytesRemoved: Math.max(0, buffer.length - sanitizedBuffer.length),
      removedSegmentsCount,
      sanitizedBuffer,
      format: 'JPEG',
    };
  }

  // Case 2: PNG
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    const chunks: Buffer[] = [buffer.subarray(0, 8)]; // PNG Signature
    let offset = 8;
    let removedSegmentsCount = 0;
    const stripTypes = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);

    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
      const totalChunkLen = 12 + length;
      if (offset + totalChunkLen > buffer.length) {
        chunks.push(buffer.subarray(offset));
        break;
      }
      if (stripTypes.has(type)) {
        removedSegmentsCount += 1;
      } else {
        chunks.push(buffer.subarray(offset, offset + totalChunkLen));
      }
      offset += totalChunkLen;
      if (type === 'IEND') break;
    }

    const sanitizedBuffer = Buffer.concat(chunks);
    return {
      originalSizeBytes: buffer.length,
      sanitizedSizeBytes: sanitizedBuffer.length,
      bytesRemoved: Math.max(0, buffer.length - sanitizedBuffer.length),
      removedSegmentsCount,
      sanitizedBuffer,
      format: 'PNG',
    };
  }

  return {
    originalSizeBytes: buffer.length,
    sanitizedSizeBytes: buffer.length,
    bytesRemoved: 0,
    removedSegmentsCount: 0,
    sanitizedBuffer: Buffer.from(buffer),
    format: 'UNMODIFIED',
  };
}
