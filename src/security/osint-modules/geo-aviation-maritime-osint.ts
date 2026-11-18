export interface SunAndShadowCalculation {
  latitude: number;
  longitude: number;
  timestampIso: string;
  solarAltitudeDeg: number;
  solarAzimuthDeg: number;
  shadowDirectionDeg: number;
  shadowToHeightRatio?: number;
  estimatedObjectHeightMeters?: number;
  estimatedShadowLengthMeters?: number;
  isDaylight: boolean;
  solarPhaseArabic: string;
  sunriseUtcIso?: string;
  solarNoonUtcIso?: string;
  sunsetUtcIso?: string;
  sunCalcUrl: string;
  shadeMapUrl: string;
}

export interface AviationOsintReport {
  query: string;
  foundLiveState: boolean;
  icao24?: string;
  callsign?: string;
  registration?: string;
  aircraftType?: string;
  manufacturer?: string;
  operatorOwner?: string;
  originCountry?: string;
  longitude?: number;
  latitude?: number;
  baroAltitudeMeters?: number;
  velocityMetersPerSec?: number;
  trueTrackDeg?: number;
  onGround?: boolean;
  investigativeLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

export interface MaritimeVesselOsintReport {
  query: string;
  queryType: 'MMSI' | 'IMO' | 'VESSEL_NAME';
  normalizedId: string;
  midCountryHint?: string;
  investigativeLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

export interface GeoSatelliteMatrixReport {
  query: string;
  resolvedDisplayName?: string;
  latitude: number;
  longitude: number;
  sunShadow: SunAndShadowCalculation;
  mapLinks: Array<{
    toolName: string;
    category: 'SATELLITE_STREET' | 'SHADOW_SOLAR' | 'CONFLICT_GPS' | 'CROWD_CALC';
    url: string;
    descriptionArabic: string;
  }>;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Pure astronomical solar position & shadow geometry calculator (Jean Meeus / SunCalc equations).
 * Computes solar altitude, azimuth, shadow direction, shadow-to-height ratio, and sunrise/noon/sunset UTC.
 */
export function computeSunAndShadowForensics(
  lat: number,
  lon: number,
  dateIso?: string,
  objectHeightMeters?: number,
  shadowLengthMeters?: number
): SunAndShadowCalculation {
  const dateObj = dateIso ? new Date(dateIso) : new Date();
  const validDate = Number.isNaN(dateObj.getTime()) ? new Date() : dateObj;

  // Days since J2000.0 (2000-01-01T12:00:00Z)
  const jd = validDate.getTime() / 86_400_000 + 2440587.5;
  const d = jd - 2451545.0;

  // Mean anomaly and ecliptic longitude of the Sun
  const M = (357.5291 + 0.98560028 * d) % 360;
  const Mrad = M * RAD;
  const C =
    1.9148 * Math.sin(Mrad) +
    0.02 * Math.sin(2 * Mrad) +
    0.0003 * Math.sin(3 * Mrad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const lambdaRad = lambda * RAD;

  // Obliquity of the ecliptic
  const epsilon = 23.4393 - 0.00000036 * d;
  const epsRad = epsilon * RAD;

  // Declination and Right Ascension
  const sinDec = Math.sin(lambdaRad) * Math.sin(epsRad);
  const dec = Math.asin(sinDec);
  const ra = Math.atan2(
    Math.sin(lambdaRad) * Math.cos(epsRad),
    Math.cos(lambdaRad)
  );

  // Greenwich Mean Sidereal Time & Local Hour Angle
  const theta = ((280.16 + 360.9856235 * d) % 360) * RAD;
  const lw = -lon * RAD;
  const phi = lat * RAD;
  const H = theta - lw - ra;

  // Solar Altitude (elevation) and Azimuth (compass bearing from North: 0°=N, 90°=E, 180°=S, 270°=W)
  const sinAlt =
    Math.sin(phi) * Math.sin(dec) +
    Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const altRad = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const solarAltitudeDeg = Number((altRad * DEG).toFixed(2));

  const azFromSouthRad = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
  );
  const solarAzimuthDeg = Number((((azFromSouthRad * DEG + 180) % 360 + 360) % 360).toFixed(2));
  const shadowDirectionDeg = Number(((solarAzimuthDeg + 180) % 360).toFixed(2));

  const isDaylight = solarAltitudeDeg > 0;
  let shadowToHeightRatio: number | undefined;
  let estimatedObjectHeightMeters: number | undefined;
  let estimatedShadowLengthMeters: number | undefined;

  if (solarAltitudeDeg > 0.5) {
    const tanAlt = Math.tan(altRad);
    shadowToHeightRatio = Number((1 / tanAlt).toFixed(3));
    if (typeof objectHeightMeters === 'number' && objectHeightMeters > 0) {
      estimatedShadowLengthMeters = Number(
        (objectHeightMeters / tanAlt).toFixed(2)
      );
    }
    if (typeof shadowLengthMeters === 'number' && shadowLengthMeters > 0) {
      estimatedObjectHeightMeters = Number(
        (shadowLengthMeters * tanAlt).toFixed(2)
      );
    }
  }

  // Approximate Solar Noon, Sunrise, Sunset UTC for that day
  const n = Math.round(d - 0.0009 - lon / 360);
  const jStar = 2451545.0 + 0.0009 + lon / 360 + n;
  const jTransit =
    jStar + 0.0053 * Math.sin(Mrad) - 0.0069 * Math.sin(2 * lambdaRad);
  const solarNoonMs = (jTransit - 2440587.5) * 86_400_000;
  const solarNoonUtcIso = new Date(solarNoonMs).toISOString();

  let sunriseUtcIso: string | undefined;
  let sunsetUtcIso: string | undefined;
  const cosOmega0 =
    (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(dec)) /
    (Math.cos(phi) * Math.cos(dec));
  if (cosOmega0 >= -1 && cosOmega0 <= 1) {
    const omega0Deg = Math.acos(cosOmega0) * DEG;
    const jSet = jTransit + omega0Deg / 360;
    const jRise = jTransit - omega0Deg / 360;
    sunriseUtcIso = new Date((jRise - 2440587.5) * 86_400_000).toISOString();
    sunsetUtcIso = new Date((jSet - 2440587.5) * 86_400_000).toISOString();
  }

  let solarPhaseArabic = 'ليل (الشمس تحت الأفق — لا توجد ظلال شمسية)';
  if (solarAltitudeDeg > 45) {
    solarPhaseArabic = 'ظهيرة مشمسة (الشمس مرتفعة والظلال قصيرة)';
  } else if (solarAltitudeDeg > 12) {
    solarPhaseArabic = 'نهار ساطع (زاوية شمسية متوسطة مثالية لتحليل الظلال)';
  } else if (solarAltitudeDeg > 0) {
    solarPhaseArabic = 'شروق/غروب (الساعة الذهبية — ظلال طويلة جداً)';
  } else if (solarAltitudeDeg > -6) {
    solarPhaseArabic = 'شفق مدني (Civil Twilight)';
  }

  const datePart = validDate.toISOString().slice(0, 10).replace(/-/g, '.');
  const timePart = validDate.toISOString().slice(11, 16);
  const sunCalcUrl = `https://www.suncalc.org/#/${lat.toFixed(5)},${lon.toFixed(
    5
  )},16/${datePart}/${timePart}/1/3`;
  const shadeMapUrl = `https://shademap.app/@${lat.toFixed(5)},${lon.toFixed(
    5
  )},15z,${validDate.getTime()}t`;

  return {
    latitude: Number(lat.toFixed(6)),
    longitude: Number(lon.toFixed(6)),
    timestampIso: validDate.toISOString(),
    solarAltitudeDeg,
    solarAzimuthDeg,
    shadowDirectionDeg,
    shadowToHeightRatio,
    estimatedObjectHeightMeters,
    estimatedShadowLengthMeters,
    isDaylight,
    solarPhaseArabic,
    sunriseUtcIso,
    solarNoonUtcIso,
    sunsetUtcIso,
    sunCalcUrl,
    shadeMapUrl,
  };
}

export async function lookupAviationOsint(
  rawQuery: string
): Promise<AviationOsintReport> {
  const q = rawQuery.trim().toUpperCase();
  const isHexIcao = /^[0-9A-F]{6}$/i.test(q);
  const icao24Lower = isHexIcao ? q.toLowerCase() : undefined;

  let foundLiveState = false;
  let callsign: string | undefined;
  let registration: string | undefined;
  let aircraftType: string | undefined;
  let manufacturer: string | undefined;
  let operatorOwner: string | undefined;
  let originCountry: string | undefined;
  let longitude: number | undefined;
  let latitude: number | undefined;
  let baroAltitudeMeters: number | undefined;
  let velocityMetersPerSec: number | undefined;
  let trueTrackDeg: number | undefined;
  let onGround: boolean | undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    if (icao24Lower) {
      const [openSkyRes, hexDbRes] = await Promise.all([
        fetch(
          `https://opensky-network.org/api/states/all?icao24=${encodeURIComponent(
            icao24Lower
          )}`,
          { signal: controller.signal }
        ).catch(() => null),
        fetch(
          `https://hexdb.io/api/v1/aircraft/${encodeURIComponent(icao24Lower)}`,
          { signal: controller.signal }
        ).catch(() => null),
      ]);

      if (openSkyRes && openSkyRes.ok) {
        const osJson = (await openSkyRes.json()) as { states?: unknown[][] };
        const st = osJson?.states?.[0];
        if (Array.isArray(st)) {
          foundLiveState = true;
          callsign = typeof st[1] === 'string' ? st[1].trim() : undefined;
          originCountry = typeof st[2] === 'string' ? st[2] : undefined;
          longitude = typeof st[5] === 'number' ? st[5] : undefined;
          latitude = typeof st[6] === 'number' ? st[6] : undefined;
          baroAltitudeMeters = typeof st[7] === 'number' ? st[7] : undefined;
          onGround = typeof st[8] === 'boolean' ? st[8] : undefined;
          velocityMetersPerSec = typeof st[9] === 'number' ? st[9] : undefined;
          trueTrackDeg = typeof st[10] === 'number' ? st[10] : undefined;
        }
      }

      if (hexDbRes && hexDbRes.ok) {
        const hexJson = (await hexDbRes.json()) as Record<string, unknown>;
        registration =
          typeof hexJson.Registration === 'string'
            ? hexJson.Registration
            : undefined;
        aircraftType =
          typeof hexJson.Type === 'string' ? hexJson.Type : undefined;
        manufacturer =
          typeof hexJson.Manufacturer === 'string'
            ? hexJson.Manufacturer
            : undefined;
        operatorOwner =
          typeof hexJson.RegisteredOwners === 'string'
            ? hexJson.RegisteredOwners
            : undefined;
      }
    }
  } catch {
    // ignore network timeout
  } finally {
    clearTimeout(timer);
  }

  const enc = encodeURIComponent(q);
  return {
    query: q,
    foundLiveState,
    icao24: icao24Lower?.toUpperCase(),
    callsign,
    registration,
    aircraftType,
    manufacturer,
    operatorOwner,
    originCountry,
    longitude,
    latitude,
    baroAltitudeMeters,
    velocityMetersPerSec,
    trueTrackDeg,
    onGround,
    investigativeLinks: [
      {
        toolName: 'ADS-B Exchange (Unfiltered Radar)',
        url: isHexIcao
          ? `https://globe.adsbexchange.com/?icao=${icao24Lower}`
          : `https://globe.adsbexchange.com/`,
        descriptionArabic: 'رادار ADS-B غير المفلتر للطائرات العسكرية والخاصة والتجارية',
      },
      {
        toolName: 'Flightradar24',
        url: `https://www.flightradar24.com/data/search?query=${enc}`,
        descriptionArabic: 'تتبع مسار الرحلات الجوية وسجل الطائرة (Flightradar24)',
      },
      {
        toolName: 'FlightAware',
        url: `https://www.flightaware.com/live/flight/${enc}`,
        descriptionArabic: 'بيانات الطيران ومخططات الملاحة الجوية (FlightAware)',
      },
      {
        toolName: 'PlaneFinder',
        url: `https://planefinder.net/`,
        descriptionArabic: 'تتبع حركة الطيران الحية حول العالم (PlaneFinder)',
      },
      {
        toolName: 'Airfleets Aviation Database',
        url: `https://www.airfleets.net/recherche/?key=${enc}`,
        descriptionArabic: 'سجل ملكية الطائرات وتاريخ التسجيل والأسطول (Airfleets)',
      },
    ],
  };
}

const MMSI_MID_PREFIX_MAP: Record<string, string> = {
  '403': 'السعودية 🇸🇦',
  '473': 'اليمن 🇾🇪',
  '470': 'الإمارات 🇦🇪',
  '466': 'قطر 🇶🇦',
  '447': 'الكويت 🇰🇼',
  '408': 'البحرين 🇧🇭',
  '461': 'عُمان 🇴🇲',
  '622': 'مصر 🇪🇬',
  '271': 'تركيا 🇹🇷',
  '338': 'الولايات المتحدة 🇺🇸',
  '235': 'المملكة المتحدة 🇬🇧',
  '351': 'بنما 🇵🇦',
  '636': 'ليبيريا 🇱🇷',
  '538': 'جزر مارشال 🇲🇭',
};

export function lookupMaritimeVesselOsint(
  rawQuery: string
): MaritimeVesselOsintReport {
  const cleaned = rawQuery.trim();
  const digits = cleaned.replace(/\D/g, '');
  let queryType: MaritimeVesselOsintReport['queryType'] = 'VESSEL_NAME';
  let midCountryHint: string | undefined;

  if (/^\d{9}$/.test(digits)) {
    queryType = 'MMSI';
    const mid = digits.slice(0, 3);
    midCountryHint = MMSI_MID_PREFIX_MAP[mid];
  } else if (/^(?:IMO\s*)?\d{7}$/i.test(cleaned)) {
    queryType = 'IMO';
  }

  const enc = encodeURIComponent(queryType === 'VESSEL_NAME' ? cleaned : digits);
  return {
    query: cleaned,
    queryType,
    normalizedId: queryType === 'VESSEL_NAME' ? cleaned : digits,
    midCountryHint,
    investigativeLinks: [
      {
        toolName: 'MarineTraffic AIS',
        url:
          queryType === 'MMSI'
            ? `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${digits}`
            : `https://www.marinetraffic.com/en/ais/index/search/all?keyword=${enc}`,
        descriptionArabic: 'تتبع السفن عبر نظام AIS والموانئ والمسارات البحرية (MarineTraffic)',
      },
      {
        toolName: 'VesselFinder',
        url:
          queryType === 'MMSI'
            ? `https://www.vesselfinder.com/vessels/details/${digits}`
            : `https://www.vesselfinder.com/vessels?name=${enc}`,
        descriptionArabic: 'فحص موقع السفينة وتفاصيل التسجيل البحري (VesselFinder)',
      },
      {
        toolName: 'ShipFinder',
        url: `https://shipfinder.co/`,
        descriptionArabic: 'خريطة حركة الملاحة البحرية المباشرة (ShipFinder)',
      },
    ],
  };
}

export async function buildGeoSatelliteAndStreetMapMatrix(
  queryOrCoords: string,
  timestampIso?: string
): Promise<GeoSatelliteMatrixReport> {
  const trimmed = queryOrCoords.trim();
  const coordMatch = trimmed.match(
    /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/
  );

  let latitude = 15.3694;
  let longitude = 44.191;
  let resolvedDisplayName: string | undefined;

  if (coordMatch) {
    latitude = Number(coordMatch[1]);
    longitude = Number(coordMatch[2]);
    resolvedDisplayName = `إحداثيات جغرافية مباشرة (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
          trimmed
        )}`,
        {
          headers: {
            'User-Agent': 'BotezzCyberForensicsOSINT/2.0',
          },
          signal: controller.signal,
        }
      );
      if (res.ok) {
        const list = (await res.json()) as Array<{
          lat?: string;
          lon?: string;
          display_name?: string;
        }>;
        if (list[0]?.lat && list[0]?.lon) {
          latitude = Number(list[0].lat);
          longitude = Number(list[0].lon);
          resolvedDisplayName = list[0].display_name;
        }
      }
    } catch {
      // fallback coordinates if offline
    } finally {
      clearTimeout(timer);
    }
  }

  const sunShadow = computeSunAndShadowForensics(latitude, longitude, timestampIso);
  const latStr = latitude.toFixed(5);
  const lonStr = longitude.toFixed(5);

  return {
    query: trimmed,
    resolvedDisplayName,
    latitude,
    longitude,
    sunShadow,
    mapLinks: [
      {
        toolName: 'Google Maps Satellite & StreetView',
        category: 'SATELLITE_STREET',
        url: `https://www.google.com/maps/@${latStr},${lonStr},18z/data=!3m1!1e3`,
        descriptionArabic: 'صور الأقمار الصناعية والتجول الافتراضي (Google Maps)',
      },
      {
        toolName: 'Yandex Maps Satellite',
        category: 'SATELLITE_STREET',
        url: `https://yandex.com/maps/?ll=${lonStr}%2C${latStr}&z=18&l=sat`,
        descriptionArabic: 'أقمار Yandex الصناعية (تغطية عالية الدقة للشرق الأوسط وأوروبا الشرقية)',
      },
      {
        toolName: 'Bing Maps Aerial',
        category: 'SATELLITE_STREET',
        url: `https://www.bing.com/maps?cp=${latStr}~${lonStr}&lvl=18&style=a`,
        descriptionArabic: 'التصوير الجوي والأقمار الصناعية من Microsoft Bing',
      },
      {
        toolName: 'Satellites.pro 3D Map',
        category: 'SATELLITE_STREET',
        url: `https://satellites.pro/#${latStr},${lonStr},17`,
        descriptionArabic: 'مقارنة طبقات الأقمار الصناعية المتعددة (Satellites.pro)',
      },
      {
        toolName: 'Wikimapia Crowd Intelligence',
        category: 'SATELLITE_STREET',
        url: `https://wikimapia.org/#lang=ar&lat=${latStr}&lon=${lonStr}&z=16&m=b`,
        descriptionArabic: 'تسميات المنشآت والمباني والمواقع الميدانية (Wikimapia)',
      },
      {
        toolName: 'Mapillary Street-Level Imagery',
        category: 'SATELLITE_STREET',
        url: `https://www.mapillary.com/app/?lat=${latStr}&lng=${lonStr}&z=16`,
        descriptionArabic: 'صور الشوارع الميدانية الملتقطة جماعياً (Mapillary)',
      },
      {
        toolName: 'SunCalc Solar & Shadow Trajectory',
        category: 'SHADOW_SOLAR',
        url: sunShadow.sunCalcUrl,
        descriptionArabic: 'محاكاة زاوية الشمس واتجاه الظل لتحديد ساعة التقاط الصورة (SunCalc)',
      },
      {
        toolName: 'ShadeMap 3D Terrain Shadows',
        category: 'SHADOW_SOLAR',
        url: sunShadow.shadeMapUrl,
        descriptionArabic: 'محاكاة ثلاثية الأبعاد لظلال الجبال والمباني في أي دقيقة (ShadeMap)',
      },
      {
        toolName: 'GPSJam GNSS Interference Map',
        category: 'CONFLICT_GPS',
        url: `https://gpsjam.org/?lat=${latStr}&lon=${lonStr}&z=6`,
        descriptionArabic: 'خريطة التشويش اليومي على إشارات الملاحة GPS/GNSS (GPSJam)',
      },
      {
        toolName: 'LiveUAMap Conflict & Field Events',
        category: 'CONFLICT_GPS',
        url: `https://liveuamap.com/`,
        descriptionArabic: 'خريطة الأحداث الميدانية والجيوسياسية المباشرة (LiveUAMap)',
      },
      {
        toolName: 'MapChecking Crowd Estimator',
        category: 'CROWD_CALC',
        url: `https://www.mapchecking.com/#b=${latStr},${lonStr},18`,
        descriptionArabic: 'حساب مساحة التجمعات وتقدير أعداد الحشود هندسياً (MapChecking)',
      },
      {
        toolName: 'Geohints Visual Geo-Clues',
        category: 'CROWD_CALC',
        url: `https://geohints.com/`,
        descriptionArabic: 'موسوعة العلامات البصرية للدول (لوحات المركبات، أعمدة الكهرباء، لافتات الطرق)',
      },
    ],
  };
}
