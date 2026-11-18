export interface UsernamePlatformProbeResult {
  platform: string;
  category: 'DEVELOPER_TECH' | 'SOCIAL_CREATOR' | 'GAMING_CHESS' | 'MESSAGING_FORUM';
  status: 'CONFIRMED' | 'NOT_FOUND' | 'SEARCH_DORK' | 'RATE_LIMITED' | 'UNAVAILABLE';
  exists: boolean;
  url: string;
  httpStatus?: number;
  extractedTitle?: string;
  detailsArabic: string;
}

export interface RedditForensicReport {
  username: string;
  exists: boolean;
  createdUtcIso?: string;
  accountAgeDays?: number;
  linkKarma?: number;
  commentKarma?: number;
  totalKarma?: number;
  isGold?: boolean;
  isMod?: boolean;
  verified?: boolean;
  hasVerifiedEmail?: boolean;
  iconImg?: string;
  bioDescription?: string;
  topSubreddits: Array<{ subreddit: string; count: number }>;
  activeUtcHoursHistogram: Record<number, number>;
  mostActiveUtcHour?: number;
  recentSampleCount: number;
  profileUrl: string;
  redectiveUrl: string;
}

export interface TikTokTimestampResult {
  rawInput: string;
  videoId: string;
  valid: boolean;
  unixTimestampSeconds?: number;
  unixTimestampMs?: number;
  utcIso?: string;
  arabicFormattedDate?: string;
  errorReasonArabic?: string;
}

export interface UsernameMultiPlatformReport {
  username: string;
  normalizedUsername: string;
  scannedAtIso: string;
  confirmedCount: number;
  probedCount: number;
  results: UsernamePlatformProbeResult[];
  redditAnalysis?: RedditForensicReport;
  investigativeLinks: Array<{
    toolName: string;
    category: string;
    url: string;
    descriptionArabic: string;
  }>;
}

interface PlatformDefinition {
  platform: string;
  category: UsernamePlatformProbeResult['category'];
  buildUrl: (u: string) => string;
  notFoundStatusCodes?: number[];
  notFoundBodyPatterns?: RegExp[];
  confirmedBodyPatterns?: RegExp[];
}

const USERNAME_PLATFORMS: PlatformDefinition[] = [
  // Developer & Tech
  {
    platform: 'GitHub',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://github.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Not Found/i, /Page not found · GitHub/i],
    confirmedBodyPatterns: [/vcard-names|p-nickname|data-scope-id/i],
  },
  {
    platform: 'GitLab',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://gitlab.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Sign in · GitLab/i, /Page Not Found/i],
  },
  {
    platform: 'DockerHub',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://hub.docker.com/v2/users/${encodeURIComponent(u)}/`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/not found|err_code/i],
    confirmedBodyPatterns: [/"username"\s*:/i],
  },
  {
    platform: 'NPM',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://www.npmjs.com/~${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Not Found|Scope not found/i],
  },
  {
    platform: 'PyPI',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://pypi.org/user/${encodeURIComponent(u)}/`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page Not Found|We looked everywhere/i],
  },
  {
    platform: 'Keybase',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) =>
      `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/"them"\s*:\s*\[\s*null\s*\]/i],
    confirmedBodyPatterns: [/"basics"\s*:\s*\{/i],
  },
  {
    platform: 'HackerNews',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) =>
      `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(u)}.json`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/^null$/i],
    confirmedBodyPatterns: [/"id"\s*:/i],
  },
  {
    platform: 'Dev.to',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://dev.to/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/This page does not exist/i],
  },
  {
    platform: 'Hashnode',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://hashnode.com/@${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/404|Page not found/i],
  },
  {
    platform: 'Replit',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://replit.com/@${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page not found|404/i],
  },
  {
    platform: 'Kaggle',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://www.kaggle.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/404 - Page not found/i],
  },
  {
    platform: 'LeetCode',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://leetcode.com/u/${encodeURIComponent(u)}/`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page Not Found/i],
  },
  {
    platform: 'HackerOne',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://hackerone.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page not found/i],
  },
  {
    platform: 'Bugcrowd',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://bugcrowd.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/The requested page was not found/i],
  },
  {
    platform: 'About.me',
    category: 'DEVELOPER_TECH',
    buildUrl: (u) => `https://about.me/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page Not Found|doesn't exist/i],
  },
  // Social & Creator
  {
    platform: 'Telegram',
    category: 'MESSAGING_FORUM',
    buildUrl: (u) => `https://t.me/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/tgme_icon_user/i],
    confirmedBodyPatterns: [/tgme_page_title/i],
  },
  {
    platform: 'Reddit',
    category: 'MESSAGING_FORUM',
    buildUrl: (u) => `https://www.reddit.com/user/${encodeURIComponent(u)}/about.json`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/"error"\s*:\s*404/i, /page not found/i],
    confirmedBodyPatterns: [/"kind"\s*:\s*"t2"/i],
  },
  {
    platform: 'TikTok',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.tiktok.com/@${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Couldn't find this account/i],
    confirmedBodyPatterns: [/"uniqueId"\s*:/i],
  },
  {
    platform: 'Instagram',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page Not Found|isn't available/i],
  },
  {
    platform: 'X (Twitter)',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://x.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/This account doesn’t exist/i],
  },
  {
    platform: 'YouTube',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.youtube.com/@${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/404 Not Found|This page isn't available/i],
  },
  {
    platform: 'Medium',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://medium.com/@${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/PAGE NOT FOUND|404/i],
  },
  {
    platform: 'Substack',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://substack.com/@${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Page not found/i],
  },
  {
    platform: 'Linktree',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://linktr.ee/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/The page you’re looking for doesn’t exist/i],
  },
  {
    platform: 'Pinterest',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.pinterest.com/${encodeURIComponent(u)}/`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/User not found/i],
  },
  {
    platform: 'SoundCloud',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://soundcloud.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/We can’t find that user/i],
  },
  {
    platform: 'Vimeo',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://vimeo.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Sorry, we couldn’t find that page/i],
  },
  {
    platform: 'Twitch',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.twitch.tv/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/time machine|unavailable/i],
  },
  {
    platform: 'Behance',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.behance.net/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Oops! We can’t find that page/i],
  },
  {
    platform: 'Dribbble',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://dribbble.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Whoops, that page is gone/i],
  },
  {
    platform: 'Patreon',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://www.patreon.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/This page could not be found/i],
  },
  {
    platform: 'Gravatar',
    category: 'SOCIAL_CREATOR',
    buildUrl: (u) => `https://en.gravatar.com/${encodeURIComponent(u)}.json`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/User not found/i],
    confirmedBodyPatterns: [/"entry"\s*:\s*\[/i],
  },
  // Gaming & Chess
  {
    platform: 'Steam',
    category: 'GAMING_CHESS',
    buildUrl: (u) => `https://steamcommunity.com/id/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/The specified profile could not be found/i],
    confirmedBodyPatterns: [/actual_persona_name/i],
  },
  {
    platform: 'Chess.com',
    category: 'GAMING_CHESS',
    buildUrl: (u) => `https://api.chess.com/pub/player/${encodeURIComponent(u.toLowerCase())}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/"code"\s*:\s*0/i],
    confirmedBodyPatterns: [/"player_id"\s*:/i],
  },
  {
    platform: 'Lichess',
    category: 'GAMING_CHESS',
    buildUrl: (u) => `https://lichess.org/api/user/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    confirmedBodyPatterns: [/"username"\s*:/i],
  },
  {
    platform: 'PSNProfiles',
    category: 'GAMING_CHESS',
    buildUrl: (u) => `https://psnprofiles.com/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/PSN Profile Not Found/i],
  },
  {
    platform: 'XboxGamertag',
    category: 'GAMING_CHESS',
    buildUrl: (u) => `https://xboxgamertag.com/search/${encodeURIComponent(u)}`,
    notFoundStatusCodes: [404],
    notFoundBodyPatterns: [/Gamertag doesn't exist/i],
  },
];

async function fetchTextWithTimeout(
  url: string,
  timeoutMs = 6000
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/json,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export function buildUsernameInvestigativeLinks(username: string): Array<{
  toolName: string;
  category: string;
  url: string;
  descriptionArabic: string;
}> {
  const clean = username.trim().replace(/^@+/, '');
  const enc = encodeURIComponent(clean);
  return [
    {
      toolName: 'WhatsMyName Web',
      category: 'USERNAME_ENUM',
      url: `https://whatsmyname.app/?q=${enc}`,
      descriptionArabic: 'فحص اسم المستخدم عبر 600+ منصة عالمية (WhatsMyName)',
    },
    {
      toolName: 'Instant Username Search',
      category: 'USERNAME_ENUM',
      url: `https://instantusername.com/#/${enc}`,
      descriptionArabic: 'فحص التوافر الفوري لاسم المستخدم عبر الشبكات الاجتماعية',
    },
    {
      toolName: 'Namechk',
      category: 'USERNAME_ENUM',
      url: `https://namechk.com/`,
      descriptionArabic: 'مطابقة المعرفات والنطاقات المسجلة بنفس الاسم',
    },
    {
      toolName: 'User Searcher',
      category: 'USERNAME_ENUM',
      url: `https://www.usersearcher.com/`,
      descriptionArabic: 'محرك بحث المعرفات عبر 2000+ موقع ومنتدى',
    },
    {
      toolName: 'Redective (Reddit OSINT)',
      category: 'SOCIAL_FORENSICS',
      url: `https://www.redective.com/`,
      descriptionArabic: 'تحليل نشاط حساب Reddit والتوزيع الزمني للكلمات والمجتمعات',
    },
    {
      toolName: 'PSNProfiles',
      category: 'GAMING_OSINT',
      url: `https://psnprofiles.com/${enc}`,
      descriptionArabic: 'فحص ملف PlayStation Network والجوائز وسجل اللعب',
    },
    {
      toolName: 'XboxGamertag',
      category: 'GAMING_OSINT',
      url: `https://xboxgamertag.com/search/${enc}`,
      descriptionArabic: 'استعلام حساب Xbox Live وسجل الألعاب المرتبط',
    },
    {
      toolName: 'TGStat (Telegram Analytics)',
      category: 'TELEGRAM_OSINT',
      url: `https://tgstat.com/search?q=${enc}`,
      descriptionArabic: 'البحث في فهرس قنوات ومجموعات ومنشورات تيليجرام (TGStat)',
    },
    {
      toolName: 'Telemetrio',
      category: 'TELEGRAM_OSINT',
      url: `https://telemetr.io/en/channels?channel=${enc}`,
      descriptionArabic: 'تحليل إحصائيات قنوات وحسابات تيليجرام العامة',
    },
    {
      toolName: 'TelegramDB',
      category: 'TELEGRAM_OSINT',
      url: `https://telegramdb.org/`,
      descriptionArabic: 'قاعدة بيانات المجموعات والقنوات العامة في تيليجرام',
    },
    {
      toolName: 'YouTube GeoFind',
      category: 'VIDEO_GEOLOCATION',
      url: `https://mattw.io/youtube-geofind/location`,
      descriptionArabic: 'البحث عن مقاطع يوتيوب المنشورة حسب الإحداثيات الجغرافية أو القناة',
    },
    {
      toolName: 'YouTube Metadata (mattw.io)',
      category: 'VIDEO_GEOLOCATION',
      url: `https://mattw.io/youtube-metadata/`,
      descriptionArabic: 'استخراج البيانات الوصفية الكاملة لقنوات ومقاطع يوتيوب',
    },
    {
      toolName: 'Snapchat Map',
      category: 'SOCIAL_GEOLOCATION',
      url: `https://map.snapchat.com/`,
      descriptionArabic: 'خريطة القصص العامة المباشرة من سناب شات حسب الموقع الجغرافي',
    },
  ];
}

export async function analyzeRedditAccount(
  rawUsername: string
): Promise<RedditForensicReport> {
  const clean = rawUsername.trim().replace(/^@+/, '').replace(/^u\//i, '');
  const profileUrl = `https://www.reddit.com/user/${encodeURIComponent(clean)}`;
  const redectiveUrl = `https://www.redective.com/`;
  const emptyHistogram: Record<number, number> = {};
  for (let h = 0; h < 24; h += 1) emptyHistogram[h] = 0;

  try {
    const aboutRes = await fetchTextWithTimeout(
      `https://www.reddit.com/user/${encodeURIComponent(clean)}/about.json`,
      6000
    );
    if (!aboutRes.ok || aboutRes.status === 404) {
      return {
        username: clean,
        exists: false,
        topSubreddits: [],
        activeUtcHoursHistogram: emptyHistogram,
        recentSampleCount: 0,
        profileUrl,
        redectiveUrl,
      };
    }

    const parsed = JSON.parse(aboutRes.body) as {
      data?: {
        name?: string;
        created_utc?: number;
        link_karma?: number;
        comment_karma?: number;
        total_karma?: number;
        is_gold?: boolean;
        is_mod?: boolean;
        verified?: boolean;
        has_verified_email?: boolean;
        icon_img?: string;
        subreddit?: { public_description?: string };
      };
    };
    const data = parsed?.data;
    if (!data || !data.name) {
      return {
        username: clean,
        exists: false,
        topSubreddits: [],
        activeUtcHoursHistogram: emptyHistogram,
        recentSampleCount: 0,
        profileUrl,
        redectiveUrl,
      };
    }

    const createdSec = typeof data.created_utc === 'number' ? data.created_utc : undefined;
    const createdUtcIso = createdSec ? new Date(createdSec * 1000).toISOString() : undefined;
    const accountAgeDays = createdSec
      ? Math.max(0, Math.floor((Date.now() - createdSec * 1000) / 86_400_000))
      : undefined;

    const subredditCounts = new Map<string, number>();
    let recentSampleCount = 0;

    try {
      const overviewRes = await fetchTextWithTimeout(
        `https://www.reddit.com/user/${encodeURIComponent(clean)}.json?limit=50`,
        6000
      );
      if (overviewRes.ok) {
        const overviewJson = JSON.parse(overviewRes.body) as {
          data?: {
            children?: Array<{
              data?: { subreddit?: string; created_utc?: number };
            }>;
          };
        };
        const children = overviewJson?.data?.children || [];
        for (const item of children) {
          const itemData = item?.data;
          if (!itemData) continue;
          recentSampleCount += 1;
          if (typeof itemData.subreddit === 'string' && itemData.subreddit) {
            subredditCounts.set(
              itemData.subreddit,
              (subredditCounts.get(itemData.subreddit) || 0) + 1
            );
          }
          if (typeof itemData.created_utc === 'number') {
            const hour = new Date(itemData.created_utc * 1000).getUTCHours();
            emptyHistogram[hour] = (emptyHistogram[hour] || 0) + 1;
          }
        }
      }
    } catch {
      // Ignore overview errors if about.json succeeded
    }

    const topSubreddits = Array.from(subredditCounts.entries())
      .map(([subreddit, count]) => ({ subreddit, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    let mostActiveUtcHour: number | undefined;
    let maxHourCount = 0;
    for (const [hourStr, count] of Object.entries(emptyHistogram)) {
      if (count > maxHourCount) {
        maxHourCount = count;
        mostActiveUtcHour = Number(hourStr);
      }
    }

    return {
      username: data.name,
      exists: true,
      createdUtcIso,
      accountAgeDays,
      linkKarma: data.link_karma,
      commentKarma: data.comment_karma,
      totalKarma:
        data.total_karma ?? (data.link_karma || 0) + (data.comment_karma || 0),
      isGold: Boolean(data.is_gold),
      isMod: Boolean(data.is_mod),
      verified: Boolean(data.verified),
      hasVerifiedEmail: Boolean(data.has_verified_email),
      iconImg: data.icon_img,
      bioDescription: data.subreddit?.public_description,
      topSubreddits,
      activeUtcHoursHistogram: emptyHistogram,
      mostActiveUtcHour,
      recentSampleCount,
      profileUrl,
      redectiveUrl,
    };
  } catch {
    return {
      username: clean,
      exists: false,
      topSubreddits: [],
      activeUtcHoursHistogram: emptyHistogram,
      recentSampleCount: 0,
      profileUrl,
      redectiveUrl,
    };
  }
}

/**
 * Native implementation of Bellingcat's TikTok Timestamp Extraction algorithm.
 * TikTok 64-bit Snowflake IDs store the exact creation Unix timestamp (in seconds)
 * in the upper 32 bits: `Number(BigInt(videoId) >> 32n)`.
 */
export function extractTikTokVideoTimestamp(rawInput: string): TikTokTimestampResult {
  const trimmed = rawInput.trim();
  const idMatch =
    trimmed.match(/\/video\/(\d{15,22})/) ||
    trimmed.match(/\/v\/(\d{15,22})/) ||
    trimmed.match(/\b(\d{17,21})\b/);

  if (!idMatch || !idMatch[1]) {
    return {
      rawInput: trimmed,
      videoId: '',
      valid: false,
      errorReasonArabic:
        'لم يتم العثور على معرف فيديو TikTok صالح (17-20 رقماً) في الرابط أو النص المدخل.',
    };
  }

  const videoId = idMatch[1];
  try {
    const snowFlake = BigInt(videoId);
    const unixTimestampSeconds = Number(snowFlake >> BigInt(32));
    if (
      !Number.isFinite(unixTimestampSeconds) ||
      unixTimestampSeconds < 1400000000 ||
      unixTimestampSeconds > 2200000000
    ) {
      return {
        rawInput: trimmed,
        videoId,
        valid: false,
        errorReasonArabic: 'معرف الفيديو خارج النطاق الزمني المنطقي لمنصة TikTok.',
      };
    }
    const unixTimestampMs = unixTimestampSeconds * 1000;
    const dateObj = new Date(unixTimestampMs);
    const utcIso = dateObj.toISOString();
    return {
      rawInput: trimmed,
      videoId,
      valid: true,
      unixTimestampSeconds,
      unixTimestampMs,
      utcIso,
      arabicFormattedDate: `${utcIso.replace('T', ' ').slice(0, 19)} UTC`,
    };
  } catch {
    return {
      rawInput: trimmed,
      videoId,
      valid: false,
      errorReasonArabic: 'تعذر تحليل معرف الفيديو رقمياً عبر خوارزمية الإزاحة (>> 32).',
    };
  }
}

async function probeSingleUsernamePlatform(
  def: PlatformDefinition,
  username: string
): Promise<UsernamePlatformProbeResult> {
  const url = def.buildUrl(username);
  try {
    const res = await fetchTextWithTimeout(url, 6000);
    if (res.status === 429) {
      return {
        platform: def.platform,
        category: def.category,
        status: 'RATE_LIMITED',
        exists: false,
        url,
        httpStatus: res.status,
        detailsArabic: 'تقييد مؤقت لمعدل الطلبات (HTTP 429) — متاح للفحص اليدوي عبر الرابط.',
      };
    }

    if (
      res.status === 404 ||
      res.status === 410 ||
      (def.notFoundStatusCodes && def.notFoundStatusCodes.includes(res.status))
    ) {
      return {
        platform: def.platform,
        category: def.category,
        status: 'NOT_FOUND',
        exists: false,
        url,
        httpStatus: res.status,
        detailsArabic: 'الحساب غير مسجل على هذه المنصة.',
      };
    }

    if (def.notFoundBodyPatterns?.some((re) => re.test(res.body))) {
      return {
        platform: def.platform,
        category: def.category,
        status: 'NOT_FOUND',
        exists: false,
        url,
        httpStatus: res.status,
        detailsArabic: 'الحساب غير موجود (تم التحقق من محتوى الصفحة).',
      };
    }

    if (res.ok) {
      if (
        def.confirmedBodyPatterns &&
        def.confirmedBodyPatterns.length > 0 &&
        !def.confirmedBodyPatterns.some((re) => re.test(res.body))
      ) {
        return {
          platform: def.platform,
          category: def.category,
          status: 'SEARCH_DORK',
          exists: false,
          url,
          httpStatus: res.status,
          detailsArabic: 'الصفحة تتطلب تحقق متصفح إضافي — افتح الرابط المباشر للتأكد.',
        };
      }

      const titleMatch = res.body.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
      const extractedTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();

      return {
        platform: def.platform,
        category: def.category,
        status: 'CONFIRMED',
        exists: true,
        url,
        httpStatus: res.status,
        extractedTitle,
        detailsArabic: extractedTitle
          ? `حساب مؤكد: ${extractedTitle.slice(0, 75)}`
          : 'حساب عام مؤكد وموجود (HTTP 200).',
      };
    }

    return {
      platform: def.platform,
      category: def.category,
      status: 'SEARCH_DORK',
      exists: false,
      url,
      httpStatus: res.status,
      detailsArabic: `يتطلب فحصاً يدوياً عبر الرابط (HTTP ${res.status}).`,
    };
  } catch {
    return {
      platform: def.platform,
      category: def.category,
      status: 'SEARCH_DORK',
      exists: false,
      url,
      detailsArabic: 'رابط فحص مباشر للحساب على المنصة.',
    };
  }
}

export async function probeUsernameMultiPlatform(
  rawUsername: string,
  options?: { concurrency?: number; includeRedditDeepScan?: boolean }
): Promise<UsernameMultiPlatformReport> {
  const normalizedUsername = rawUsername
    .trim()
    .replace(/^@+/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '');
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 8, 12));
  const results: UsernamePlatformProbeResult[] = [];

  for (let i = 0; i < USERNAME_PLATFORMS.length; i += concurrency) {
    const batch = USERNAME_PLATFORMS.slice(i, i + concurrency);
    const batchRes = await Promise.all(
      batch.map((def) => probeSingleUsernamePlatform(def, normalizedUsername))
    );
    results.push(...batchRes);
  }

  let redditAnalysis: RedditForensicReport | undefined;
  if (options?.includeRedditDeepScan !== false) {
    redditAnalysis = await analyzeRedditAccount(normalizedUsername);
  }

  results.sort((a, b) => {
    const rank = (s: UsernamePlatformProbeResult['status']) =>
      s === 'CONFIRMED' ? 0 : s === 'RATE_LIMITED' ? 1 : s === 'SEARCH_DORK' ? 2 : 3;
    return rank(a.status) - rank(b.status);
  });

  return {
    username: rawUsername.trim(),
    normalizedUsername,
    scannedAtIso: new Date().toISOString(),
    confirmedCount: results.filter((r) => r.status === 'CONFIRMED').length,
    probedCount: results.length,
    results,
    redditAnalysis,
    investigativeLinks: buildUsernameInvestigativeLinks(normalizedUsername),
  };
}
