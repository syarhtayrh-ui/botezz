import crypto from 'node:crypto';
import dns from 'node:dns';

export interface HudsonRockStealerEntry {
  stealerFamily?: string;
  dateCompromised?: string;
  computerName?: string;
  operatingSystem?: string;
  ip?: string;
  country?: string;
  malwarePath?: string;
}

export interface HudsonRockEmailResult {
  checked: boolean;
  compromised: boolean;
  message?: string;
  totalStealers: number;
  stealers: HudsonRockStealerEntry[];
}

export interface GravatarProfileResult {
  emailMd5: string;
  exists: boolean;
  displayName?: string;
  preferredUsername?: string;
  profileUrl?: string;
  avatarUrl: string;
  location?: string;
  aboutMe?: string;
  verifiedAccounts: Array<{ domain: string; url: string; username?: string }>;
}

export interface EmailServiceRegistrationHit {
  service: string;
  registered: boolean;
  status: 'CONFIRMED' | 'NOT_FOUND' | 'UNAVAILABLE';
  detailsArabic: string;
  profileUrl?: string;
}

export interface EmailDomainDnsReport {
  domain: string;
  hasMx: boolean;
  mxRecords: Array<{ exchange: string; priority: number }>;
  spfRecord?: string;
  dmarcRecord?: string;
  isDisposableDomain: boolean;
  mailProviderName?: string;
}

export interface EmailPermutationCandidate {
  email: string;
  patternDescription: string;
  gravatarFound: boolean;
  githubCommitsFound: boolean;
  hudsonRockCompromised: boolean;
}

export interface EmailForensicDossier {
  email: string;
  normalizedEmail: string;
  domain: string;
  scannedAtIso: string;
  gravatar: GravatarProfileResult;
  hudsonRock: HudsonRockEmailResult;
  dnsSecurity: EmailDomainDnsReport;
  registrations: EmailServiceRegistrationHit[];
  investigativeLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

const KNOWN_DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'sharklasers.com',
  'trashmail.com',
  'getnada.com',
  'mohmal.com',
  'dispostable.com',
  'maildrop.cc',
]);

async function fetchJsonOrTextWithTimeout(
  url: string,
  timeoutMs = 6500,
  headers?: Record<string, string>
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function queryHudsonRockEmail(
  rawEmail: string
): Promise<HudsonRockEmailResult> {
  const email = rawEmail.trim().toLowerCase();
  const url = `https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email?email=${encodeURIComponent(
    email
  )}`;
  try {
    const res = await fetchJsonOrTextWithTimeout(url, 7000);
    if (!res.ok) {
      return {
        checked: false,
        compromised: false,
        totalStealers: 0,
        stealers: [],
      };
    }
    const parsed = JSON.parse(res.text) as {
      message?: string;
      stealers?: Array<Record<string, unknown>>;
    };
    const rawStealers = Array.isArray(parsed?.stealers) ? parsed.stealers : [];
    const stealers: HudsonRockStealerEntry[] = rawStealers.slice(0, 10).map((s) => ({
      stealerFamily:
        typeof s.stealer_family === 'string' ? s.stealer_family : undefined,
      dateCompromised:
        typeof s.date_compromised === 'string' ? s.date_compromised : undefined,
      computerName:
        typeof s.computer_name === 'string' ? s.computer_name : undefined,
      operatingSystem:
        typeof s.operating_system === 'string' ? s.operating_system : undefined,
      ip: typeof s.ip === 'string' ? s.ip : undefined,
      country: typeof s.country === 'string' ? s.country : undefined,
      malwarePath: typeof s.malware_path === 'string' ? s.malware_path : undefined,
    }));

    return {
      checked: true,
      compromised: stealers.length > 0,
      message: typeof parsed?.message === 'string' ? parsed.message : undefined,
      totalStealers: rawStealers.length,
      stealers,
    };
  } catch {
    return {
      checked: false,
      compromised: false,
      totalStealers: 0,
      stealers: [],
    };
  }
}

export async function queryGravatarByEmail(
  rawEmail: string
): Promise<GravatarProfileResult> {
  const normalized = rawEmail.trim().toLowerCase();
  const emailMd5 = crypto.createHash('md5').update(normalized).digest('hex');
  const avatarUrl = `https://www.gravatar.com/avatar/${emailMd5}?d=404&s=256`;

  try {
    const jsonRes = await fetchJsonOrTextWithTimeout(
      `https://en.gravatar.com/${emailMd5}.json`,
      5500
    );
    if (jsonRes.ok) {
      const parsed = JSON.parse(jsonRes.text) as {
        entry?: Array<{
          displayName?: string;
          preferredUsername?: string;
          profileUrl?: string;
          currentLocation?: string;
          aboutMe?: string;
          accounts?: Array<{ domain?: string; url?: string; username?: string }>;
        }>;
      };
      const entry = parsed?.entry?.[0];
      if (entry) {
        return {
          emailMd5,
          exists: true,
          displayName: entry.displayName,
          preferredUsername: entry.preferredUsername,
          profileUrl: entry.profileUrl,
          avatarUrl,
          location: entry.currentLocation,
          aboutMe: entry.aboutMe,
          verifiedAccounts: (entry.accounts || [])
            .filter((a) => typeof a.domain === 'string' && typeof a.url === 'string')
            .map((a) => ({
              domain: String(a.domain),
              url: String(a.url),
              username: a.username,
            })),
        };
      }
    }

    const avatarCheck = await fetchJsonOrTextWithTimeout(avatarUrl, 5000);
    return {
      emailMd5,
      exists: avatarCheck.ok,
      avatarUrl,
      verifiedAccounts: [],
    };
  } catch {
    return {
      emailMd5,
      exists: false,
      avatarUrl,
      verifiedAccounts: [],
    };
  }
}

export async function probeEmailRegistrations(
  rawEmail: string
): Promise<EmailServiceRegistrationHit[]> {
  const email = rawEmail.trim().toLowerCase();
  const hits: EmailServiceRegistrationHit[] = [];

  const tasks = [
    // 1. GitHub Commits & Users Search
    (async (): Promise<EmailServiceRegistrationHit> => {
      try {
        const res = await fetchJsonOrTextWithTimeout(
          `https://api.github.com/search/commits?q=author-email:${encodeURIComponent(
            email
          )}&per_page=3`,
          6000,
          { Accept: 'application/vnd.github.cloak-preview+json,application/json' }
        );
        if (res.ok) {
          const parsed = JSON.parse(res.text) as {
            total_count?: number;
            items?: Array<{
              author?: { login?: string; html_url?: string };
              commit?: { author?: { name?: string } };
            }>;
          };
          const count = Number(parsed?.total_count || 0);
          if (count > 0) {
            const firstAuthor = parsed.items?.[0]?.author?.login;
            const firstCommitName = parsed.items?.[0]?.commit?.author?.name;
            return {
              service: 'GitHub Commits',
              registered: true,
              status: 'CONFIRMED',
              profileUrl:
                parsed.items?.[0]?.author?.html_url ||
                `https://github.com/search?q=${encodeURIComponent(email)}&type=commits`,
              detailsArabic: `مرتبط بـ ${count} التزام برمجي (Commit)${
                firstAuthor ? ` — الحساب: @${firstAuthor}` : ''
              }${firstCommitName ? ` (${firstCommitName})` : ''}`,
            };
          }
          return {
            service: 'GitHub Commits',
            registered: false,
            status: 'NOT_FOUND',
            detailsArabic: 'لا توجد التزامات برمجية عامة مرتبطة بهذا البريد.',
          };
        }
      } catch {
        // ignore
      }
      return {
        service: 'GitHub Commits',
        registered: false,
        status: 'UNAVAILABLE',
        detailsArabic: 'تعذر استعلام GitHub Search حالياً.',
      };
    })(),

    // 2. Duolingo Email Check
    (async (): Promise<EmailServiceRegistrationHit> => {
      try {
        const res = await fetchJsonOrTextWithTimeout(
          `https://www.duolingo.com/2017-06-30/users?email=${encodeURIComponent(email)}`,
          5500
        );
        if (res.ok) {
          const parsed = JSON.parse(res.text) as {
            users?: Array<{ username?: string; name?: string }>;
          };
          const user = parsed?.users?.[0];
          if (user) {
            return {
              service: 'Duolingo',
              registered: true,
              status: 'CONFIRMED',
              profileUrl: user.username
                ? `https://www.duolingo.com/profile/${user.username}`
                : undefined,
              detailsArabic: `حساب مسجل${
                user.username ? ` (@${user.username})` : ''
              }${user.name ? ` — الاسم: ${user.name}` : ''}`,
            };
          }
          return {
            service: 'Duolingo',
            registered: false,
            status: 'NOT_FOUND',
            detailsArabic: 'غير مسجل في Duolingo.',
          };
        }
      } catch {
        // ignore
      }
      return {
        service: 'Duolingo',
        registered: false,
        status: 'UNAVAILABLE',
        detailsArabic: 'تعذر فحص Duolingo.',
      };
    })(),

    // 3. WordPress.com / Automattic Account Check
    (async (): Promise<EmailServiceRegistrationHit> => {
      try {
        const res = await fetchJsonOrTextWithTimeout(
          `https://public-api.wordpress.com/rest/v1.1/users/${encodeURIComponent(
            email
          )}/auth-options`,
          5500
        );
        if (res.status === 200) {
          return {
            service: 'WordPress.com',
            registered: true,
            status: 'CONFIRMED',
            detailsArabic: 'حساب مسجل ومؤكد في شبكة WordPress.com.',
          };
        }
        if (res.status === 404 || /unknown_user/i.test(res.text)) {
          return {
            service: 'WordPress.com',
            registered: false,
            status: 'NOT_FOUND',
            detailsArabic: 'غير مسجل في WordPress.com.',
          };
        }
      } catch {
        // ignore
      }
      return {
        service: 'WordPress.com',
        registered: false,
        status: 'UNAVAILABLE',
        detailsArabic: 'تعذر فحص WordPress.com.',
      };
    })(),

    // 4. Spotify Signup API Validator
    (async (): Promise<EmailServiceRegistrationHit> => {
      try {
        const res = await fetchJsonOrTextWithTimeout(
          `https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email=${encodeURIComponent(
            email
          )}`,
          5500
        );
        if (res.ok) {
          const parsed = JSON.parse(res.text) as { status?: number };
          if (parsed?.status === 20) {
            return {
              service: 'Spotify',
              registered: true,
              status: 'CONFIRMED',
              detailsArabic: 'البريد مسجل ومرتبط بحساب Spotify نشط.',
            };
          }
          if (parsed?.status === 1) {
            return {
              service: 'Spotify',
              registered: false,
              status: 'NOT_FOUND',
              detailsArabic: 'غير مسجل في Spotify.',
            };
          }
        }
      } catch {
        // ignore
      }
      return {
        service: 'Spotify',
        registered: false,
        status: 'UNAVAILABLE',
        detailsArabic: 'تعذر فحص Spotify.',
      };
    })(),
  ];

  const settled = await Promise.all(tasks);
  hits.push(...settled);
  return hits;
}

export async function inspectEmailDomainDns(
  emailOrDomain: string
): Promise<EmailDomainDnsReport> {
  const cleaned = emailOrDomain.trim().toLowerCase();
  const domain = cleaned.includes('@') ? cleaned.split('@').pop() || '' : cleaned;
  const isDisposableDomain =
    KNOWN_DISPOSABLE_EMAIL_DOMAINS.has(domain) ||
    Array.from(KNOWN_DISPOSABLE_EMAIL_DOMAINS).some((d) =>
      domain.endsWith(`.${d}`)
    );

  const mxRecords: Array<{ exchange: string; priority: number }> = [];
  let spfRecord: string | undefined;
  let dmarcRecord: string | undefined;

  try {
    const mx = await dns.promises.resolveMx(domain);
    for (const entry of mx.sort((a, b) => a.priority - b.priority)) {
      mxRecords.push({ exchange: entry.exchange, priority: entry.priority });
    }
  } catch {
    // ignore DNS error
  }

  try {
    const txtList = await dns.promises.resolveTxt(domain);
    for (const chunks of txtList) {
      const joined = chunks.join('');
      if (/^v=spf1\b/i.test(joined)) {
        spfRecord = joined;
      }
    }
  } catch {
    // ignore
  }

  try {
    const dmarcList = await dns.promises.resolveTxt(`_dmarc.${domain}`);
    for (const chunks of dmarcList) {
      const joined = chunks.join('');
      if (/^v=DMARC1\b/i.test(joined)) {
        dmarcRecord = joined;
      }
    }
  } catch {
    // ignore
  }

  const firstMx = (mxRecords[0]?.exchange || '').toLowerCase();
  let mailProviderName: string | undefined;
  if (firstMx.includes('google') || firstMx.includes('gmail')) {
    mailProviderName = 'Google Workspace / Gmail';
  } else if (firstMx.includes('outlook') || firstMx.includes('protection.outlook.com')) {
    mailProviderName = 'Microsoft 365 / Exchange Online';
  } else if (firstMx.includes('protonmail') || firstMx.includes('proton.ch')) {
    mailProviderName = 'ProtonMail Encrypted Mail';
  } else if (firstMx.includes('zoho')) {
    mailProviderName = 'Zoho Mail';
  } else if (firstMx.includes('yahoodns')) {
    mailProviderName = 'Yahoo Mail';
  } else if (firstMx.includes('icloud') || firstMx.includes('apple')) {
    mailProviderName = 'Apple iCloud Mail';
  }

  return {
    domain,
    hasMx: mxRecords.length > 0,
    mxRecords,
    spfRecord,
    dmarcRecord,
    isDisposableDomain,
    mailProviderName,
  };
}

export async function generateAndProbeEmailPermutations(
  firstNameRaw: string,
  lastNameRaw: string,
  domainRaw: string
): Promise<EmailPermutationCandidate[]> {
  const f = firstNameRaw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const l = lastNameRaw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const d = domainRaw
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');

  if (!f || !d) return [];
  const fi = f[0] || '';
  const li = l[0] || '';

  const patterns: Array<{ email: string; desc: string }> = l
    ? [
        { email: `${f}.${l}@${d}`, desc: 'first.last' },
        { email: `${f}${l}@${d}`, desc: 'firstlast' },
        { email: `${fi}${l}@${d}`, desc: 'flast' },
        { email: `${fi}.${l}@${d}`, desc: 'f.last' },
        { email: `${f}_${l}@${d}`, desc: 'first_last' },
        { email: `${f}-${l}@${d}`, desc: 'first-last' },
        { email: `${f}@${d}`, desc: 'first' },
        { email: `${l}@${d}`, desc: 'last' },
        { email: `${l}.${f}@${d}`, desc: 'last.first' },
        { email: `${l}${fi}@${d}`, desc: 'lastf' },
        { email: `${f}${li}@${d}`, desc: 'firstl' },
        { email: `${fi}${li}@${d}`, desc: 'fl' },
      ]
    : [{ email: `${f}@${d}`, desc: 'first' }];

  const candidates = await Promise.all(
    patterns.slice(0, 8).map(async (p) => {
      const [grav, hr] = await Promise.all([
        queryGravatarByEmail(p.email),
        queryHudsonRockEmail(p.email),
      ]);
      return {
        email: p.email,
        patternDescription: p.desc,
        gravatarFound: grav.exists,
        githubCommitsFound: false,
        hudsonRockCompromised: hr.compromised,
      };
    })
  );

  return candidates;
}

export function buildEmailInvestigativeLinks(email: string): Array<{
  toolName: string;
  url: string;
  descriptionArabic: string;
}> {
  const clean = email.trim().toLowerCase();
  const enc = encodeURIComponent(clean);
  return [
    {
      toolName: 'HaveIBeenPwned (HIBP)',
      url: `https://haveibeenpwned.com/account/${enc}`,
      descriptionArabic: 'فحص قواعد بيانات التسريبات العالمية المعتمدة (HIBP)',
    },
    {
      toolName: 'Epieos Email OSINT',
      url: `https://epieos.com/?q=${enc}`,
      descriptionArabic: 'استخراج حسابات Google وخرائط المراجعات المرتبطة بالبريد (Epieos)',
    },
    {
      toolName: 'GHunt / Google Ecosystem',
      url: `https://github.com/mxrch/GHunt`,
      descriptionArabic: 'تحليل البصمة الرقمية لحسابات Google Workspace وGAIA ID',
    },
    {
      toolName: 'Leak-Lookup',
      url: `https://leak-lookup.com/`,
      descriptionArabic: 'البحث في فهارس التسريبات المفتوحة (Leak-Lookup)',
    },
    {
      toolName: "That's Them Reverse Email",
      url: `https://thatsthem.com/email/${enc}`,
      descriptionArabic: 'البحث العكسي عن الاسم والعنوان ورقم الهاتف المرتبط بالبريد',
    },
    {
      toolName: 'Hunter.io Domain Verifier',
      url: `https://hunter.io/email-verifier/${enc}`,
      descriptionArabic: 'التحقق من قابلية استلام البريد المؤسسي وخوادم MX',
    },
  ];
}

export async function runFullEmailForensicDossier(
  rawEmail: string
): Promise<EmailForensicDossier> {
  const normalizedEmail = rawEmail.trim().toLowerCase();
  const domain = normalizedEmail.split('@')[1] || '';

  const [gravatar, hudsonRock, dnsSecurity, registrations] = await Promise.all([
    queryGravatarByEmail(normalizedEmail),
    queryHudsonRockEmail(normalizedEmail),
    inspectEmailDomainDns(normalizedEmail),
    probeEmailRegistrations(normalizedEmail),
  ]);

  return {
    email: rawEmail.trim(),
    normalizedEmail,
    domain,
    scannedAtIso: new Date().toISOString(),
    gravatar,
    hudsonRock,
    dnsSecurity,
    registrations,
    investigativeLinks: buildEmailInvestigativeLinks(normalizedEmail),
  };
}
