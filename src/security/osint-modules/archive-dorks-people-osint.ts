export interface WaybackCdxSnapshot {
  timestamp: string;
  formattedDateUtc: string;
  originalUrl: string;
  mimeType: string;
  statusCode: string;
  archiveUrl: string;
}

export interface WebArchiveForensicReport {
  targetUrl: string;
  scannedAtIso: string;
  hasArchivedSnapshots: boolean;
  closestSnapshotUrl?: string;
  closestSnapshotTimestamp?: string;
  totalSampledSnapshots: number;
  firstSeenUtc?: string;
  lastSeenUtc?: string;
  snapshots: WaybackCdxSnapshot[];
  archiveLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

export interface PeopleAndDorkDossier {
  query: string;
  scannedAtIso: string;
  googleAdvancedDorks: Array<{
    titleArabic: string;
    dorkQuery: string;
    googleUrl: string;
  }>;
  peopleAndPublicRecordLinks: Array<{
    toolName: string;
    category: 'PEOPLE_SEARCH' | 'GENEALOGY_GRAVES' | 'COURT_LEGAL';
    url: string;
    descriptionArabic: string;
  }>;
}

function formatWaybackTimestamp(ts: string): string {
  if (!/^\d{14}$/.test(ts)) return ts;
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(
    8,
    10
  )}:${ts.slice(10, 12)}:${ts.slice(12, 14)} UTC`;
}

export async function inspectWebArchiveSnapshots(
  rawUrlOrDomain: string
): Promise<WebArchiveForensicReport> {
  const cleaned = rawUrlOrDomain.trim().replace(/^https?:\/\//i, '');
  const targetUrl = `https://${cleaned}`;
  const enc = encodeURIComponent(cleaned);

  let closestSnapshotUrl: string | undefined;
  let closestSnapshotTimestamp: string | undefined;
  const snapshots: WaybackCdxSnapshot[] = [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const [availRes, cdxRes] = await Promise.all([
      fetch(`https://archive.org/wayback/available?url=${enc}`, {
        signal: controller.signal,
      }).catch(() => null),
      fetch(
        `https://web.archive.org/cdx/search/cdx?url=${enc}&output=json&limit=15&fl=timestamp,original,mimetype,statuscode&collapse=timestamp:6`,
        { signal: controller.signal }
      ).catch(() => null),
    ]);

    if (availRes && availRes.ok) {
      const availJson = (await availRes.json()) as {
        archived_snapshots?: {
          closest?: { available?: boolean; url?: string; timestamp?: string };
        };
      };
      const closest = availJson?.archived_snapshots?.closest;
      if (closest?.url) {
        closestSnapshotUrl = closest.url;
        closestSnapshotTimestamp = closest.timestamp
          ? formatWaybackTimestamp(closest.timestamp)
          : undefined;
      }
    }

    if (cdxRes && cdxRes.ok) {
      const rows = (await cdxRes.json()) as string[][];
      if (Array.isArray(rows) && rows.length > 1) {
        for (const row of rows.slice(1)) {
          const [ts, orig, mime, status] = row;
          if (ts && orig) {
            snapshots.push({
              timestamp: ts,
              formattedDateUtc: formatWaybackTimestamp(ts),
              originalUrl: orig,
              mimeType: mime || 'text/html',
              statusCode: status || '200',
              archiveUrl: `https://web.archive.org/web/${ts}/${orig}`,
            });
          }
        }
      }
    }
  } catch {
    // ignore network timeout
  } finally {
    clearTimeout(timer);
  }

  const firstSeenUtc = snapshots[0]?.formattedDateUtc;
  const lastSeenUtc =
    snapshots.length > 0
      ? snapshots[snapshots.length - 1]?.formattedDateUtc
      : closestSnapshotTimestamp;

  return {
    targetUrl,
    scannedAtIso: new Date().toISOString(),
    hasArchivedSnapshots: Boolean(closestSnapshotUrl || snapshots.length > 0),
    closestSnapshotUrl,
    closestSnapshotTimestamp,
    totalSampledSnapshots: snapshots.length,
    firstSeenUtc,
    lastSeenUtc,
    snapshots,
    archiveLinks: [
      {
        toolName: 'Wayback Machine Calendar View',
        url: `https://web.archive.org/web/*/${cleaned}`,
        descriptionArabic: 'التقويم الزمني الكامل لجميع اللقطات المؤرشفة للموقع (Wayback Machine)',
      },
      {
        toolName: 'Archive.today / Archive.ph',
        url: `https://archive.ph/${cleaned}`,
        descriptionArabic: 'لقطات الصفحات المحفوظة والمحذوفة على خوادم Archive.today',
      },
      {
        toolName: 'Ghostarchive',
        url: `https://ghostarchive.org/search?term=${enc}`,
        descriptionArabic: 'أرشيف مقاطع الفيديو والمنشورات الاجتماعية المحذوفة (Ghostarchive)',
      },
      {
        toolName: 'Bellingcat Auto Archiver',
        url: `https://github.com/bellingcat/auto-archiver`,
        descriptionArabic: 'أداة Bellingcat لأرشفة الأدلة الرقمية وتوثيقها جنائياً بتوقيع SHA-256',
      },
    ],
  };
}

export function buildPeopleAndDorkDossier(rawQuery: string): PeopleAndDorkDossier {
  const q = rawQuery.trim();
  const enc = encodeURIComponent(q);

  const dorks = [
    {
      titleArabic: '📄 المستندات الرسمية والملفات (PDF / DOCX / XLSX)',
      dorkQuery: `"${q}" (filetype:pdf OR filetype:docx OR filetype:xlsx OR filetype:pptx)`,
    },
    {
      titleArabic: '🔑 التسريبات النصية ومستودعات الكود واللصق (Pastebin / GitHub)',
      dorkQuery: `"${q}" (site:pastebin.com OR site:github.com OR site:gitlab.com OR site:gist.github.com)`,
    },
    {
      titleArabic: '👤 الحسابات الشخصية المهنية والاجتماعية',
      dorkQuery: `"${q}" (site:linkedin.com OR site:facebook.com OR site:instagram.com OR site:x.com OR site:t.me)`,
    },
    {
      titleArabic: '🏛️ السجلات الحكومية والأكاديمية (.gov / .edu)',
      dorkQuery: `"${q}" (site:.gov OR site:.edu OR site:.org)`,
    },
    {
      titleArabic: '📂 الفهارس المفتوحة وخوادم الملفات المكشوفة (Index of)',
      dorkQuery: `intitle:"index of" "${q}"`,
    },
    {
      titleArabic: '📇 السير الذاتية وبطاقات الاتصال (CV / Resume / vCard)',
      dorkQuery: `"${q}" ("CV" OR "Resume" OR "سيرة ذاتية" OR filetype:vcf)`,
    },
    {
      titleArabic: '⚙️ ملفات الإعدادات وقواعد البيانات المكشوفة (.env / .sql / .log)',
      dorkQuery: `"${q}" (ext:env OR ext:sql OR ext:log OR ext:bak OR ext:json)`,
    },
    {
      titleArabic: '📰 الأرشيف الإخباري والبيانات الصحفية',
      dorkQuery: `"${q}" (inurl:news OR inurl:article OR inurl:press)`,
    },
  ];

  return {
    query: q,
    scannedAtIso: new Date().toISOString(),
    googleAdvancedDorks: dorks.map((d) => ({
      titleArabic: d.titleArabic,
      dorkQuery: d.dorkQuery,
      googleUrl: `https://www.google.com/search?q=${encodeURIComponent(d.dorkQuery)}`,
    })),
    peopleAndPublicRecordLinks: [
      {
        toolName: 'WebMii People Visibility Score',
        category: 'PEOPLE_SEARCH',
        url: `https://webmii.com/people?n=%22${enc}%22`,
        descriptionArabic: 'تحليل الظهور الرقمي للأشخاص والروابط الإخبارية والاجتماعية (WebMii)',
      },
      {
        toolName: 'PeekYou People Search',
        category: 'PEOPLE_SEARCH',
        url: `https://www.peekyou.com/${q.replace(/\s+/g, '_')}`,
        descriptionArabic: 'محرك بحث الهويات الرقمية والمعرفات العامة (PeekYou)',
      },
      {
        toolName: 'TruePeopleSearch',
        category: 'PEOPLE_SEARCH',
        url: `https://www.truepeoplesearch.com/results?name=${enc}`,
        descriptionArabic: 'دليل السجلات العامة والعناوين وأرقام الهواتف المرتبطة (TruePeopleSearch)',
      },
      {
        toolName: 'FastPeopleSearch',
        category: 'PEOPLE_SEARCH',
        url: `https://www.fastpeoplesearch.com/name/${q.toLowerCase().replace(/\s+/g, '-')}`,
        descriptionArabic: 'البحث السريع عن الأشخاص والأقارب والعناوين المسجلة (FastPeopleSearch)',
      },
      {
        toolName: 'Spokeo Public Directory',
        category: 'PEOPLE_SEARCH',
        url: `https://www.spokeo.com/search?q=${enc}`,
        descriptionArabic: 'تجميع السجلات العامة والحسابات الاجتماعية (Spokeo)',
      },
      {
        toolName: 'ZabaSearch & 411 Directory',
        category: 'PEOPLE_SEARCH',
        url: `https://www.zabasearch.com/people/${q.toLowerCase().replace(/\s+/g, '+')}/`,
        descriptionArabic: 'أرشيف أدلة الهاتف البيضاء والعناوين التاريخية (ZabaSearch)',
      },
      {
        toolName: 'FamilySearch Genealogy Archive',
        category: 'GENEALOGY_GRAVES',
        url: `https://www.familysearch.org/search/record/results?q.surname=${enc}`,
        descriptionArabic: 'أرشيف الأنساب والسجلات المدنية التاريخية (FamilySearch)',
      },
      {
        toolName: 'Find A Grave Memorials',
        category: 'GENEALOGY_GRAVES',
        url: `https://www.findagrave.com/memorial/search?lastname=${enc}`,
        descriptionArabic: 'قاعدة بيانات السجلات الجنائزية وشواهد القبور العالمية (Find A Grave)',
      },
      {
        toolName: 'UniCourt Legal & Court Records',
        category: 'COURT_LEGAL',
        url: `https://unicourt.com/search?q=${enc}`,
        descriptionArabic: 'البحث في القضايا والأحكام القضائية الفيدرالية والمدنية (UniCourt)',
      },
    ],
  };
}
