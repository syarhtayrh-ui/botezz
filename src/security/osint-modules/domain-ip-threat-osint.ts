import dns from 'node:dns';

export interface CrtShSubdomainEntry {
  commonName: string;
  issuerName: string;
  notBefore: string;
  notAfter: string;
}

export interface ShodanInternetDbReport {
  ip: string;
  found: boolean;
  ports: number[];
  hostnames: string[];
  cpes: string[];
  tags: string[];
  vulns: string[];
}

export interface DomainDnsReport {
  domain: string;
  aRecords: string[];
  aaaaRecords: string[];
  mxRecords: Array<{ exchange: string; priority: number }>;
  nsRecords: string[];
  txtRecords: string[];
  discoveredHosts: Array<{ host: string; ip: string }>;
}

export interface IpReputationReport {
  ip: string;
  valid: boolean;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  asNumber?: string;
  reverseDns?: string;
  isMobile?: boolean;
  isProxyOrVpn?: boolean;
  isHostingDatacenter?: boolean;
}

export interface WebsiteTechFingerprint {
  url: string;
  reachable: boolean;
  httpStatus?: number;
  serverHeader?: string;
  poweredByHeader?: string;
  detectedCms?: string;
  detectedFrameworks: string[];
  cdnOrWaf?: string;
  securityHeaders: {
    strictTransportSecurity: boolean;
    contentSecurityPolicy: boolean;
    xFrameOptions: boolean;
  };
}

export interface DomainOrIpForensicDossier {
  target: string;
  targetType: 'DOMAIN' | 'IPV4';
  resolvedIp?: string;
  scannedAtIso: string;
  dnsReport?: DomainDnsReport;
  crtSubdomains: CrtShSubdomainEntry[];
  uniqueSubdomainNames: string[];
  ipReputation?: IpReputationReport;
  shodanInternetDb?: ShodanInternetDbReport;
  techFingerprint?: WebsiteTechFingerprint;
  investigativeLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = 7000
): Promise<{
  ok: boolean;
  status: number;
  text: string;
  headers: Headers;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'application/json,text/html,*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function queryCrtShSubdomains(
  rawDomain: string
): Promise<{ entries: CrtShSubdomainEntry[]; uniqueSubdomains: string[] }> {
  const domain = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0] || '';
  if (!domain) return { entries: [], uniqueSubdomains: [] };

  try {
    const res = await fetchWithTimeout(
      `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`,
      8000
    );
    if (!res.ok) return { entries: [], uniqueSubdomains: [] };
    const parsed = JSON.parse(res.text) as Array<{
      common_name?: string;
      name_value?: string;
      issuer_name?: string;
      not_before?: string;
      not_after?: string;
    }>;
    if (!Array.isArray(parsed)) return { entries: [], uniqueSubdomains: [] };

    const subSet = new Set<string>();
    const entries: CrtShSubdomainEntry[] = [];

    for (const row of parsed.slice(0, 120)) {
      const names = String(row.name_value || row.common_name || '')
        .split(/\r?\n/)
        .map((s) => s.trim().toLowerCase().replace(/^\*\./, ''))
        .filter((s) => s.endsWith(domain));

      for (const n of names) {
        subSet.add(n);
      }

      if (entries.length < 15 && row.common_name) {
        entries.push({
          commonName: row.common_name,
          issuerName: String(row.issuer_name || '').slice(0, 80),
          notBefore: String(row.not_before || '').slice(0, 10),
          notAfter: String(row.not_after || '').slice(0, 10),
        });
      }
    }

    return {
      entries,
      uniqueSubdomains: Array.from(subSet).slice(0, 40),
    };
  } catch {
    return { entries: [], uniqueSubdomains: [] };
  }
}

export async function queryShodanInternetDb(
  ip: string
): Promise<ShodanInternetDbReport> {
  const cleanIp = ip.trim();
  try {
    const res = await fetchWithTimeout(
      `https://internetdb.shodan.io/${encodeURIComponent(cleanIp)}`,
      6000
    );
    if (!res.ok) {
      return {
        ip: cleanIp,
        found: false,
        ports: [],
        hostnames: [],
        cpes: [],
        tags: [],
        vulns: [],
      };
    }
    const parsed = JSON.parse(res.text) as {
      ports?: number[];
      hostnames?: string[];
      cpes?: string[];
      tags?: string[];
      vulns?: string[];
    };
    return {
      ip: cleanIp,
      found: true,
      ports: Array.isArray(parsed.ports) ? parsed.ports : [],
      hostnames: Array.isArray(parsed.hostnames) ? parsed.hostnames : [],
      cpes: Array.isArray(parsed.cpes) ? parsed.cpes : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      vulns: Array.isArray(parsed.vulns) ? parsed.vulns : [],
    };
  } catch {
    return {
      ip: cleanIp,
      found: false,
      ports: [],
      hostnames: [],
      cpes: [],
      tags: [],
      vulns: [],
    };
  }
}

export async function inspectDomainDnsAndHosts(
  rawDomain: string
): Promise<DomainDnsReport> {
  const domain = rawDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0] || '';

  const [aRecords, aaaaRecords, mxRecords, nsRecords, txtChunks, htRes] =
    await Promise.all([
      dns.promises.resolve4(domain).catch(() => [] as string[]),
      dns.promises.resolve6(domain).catch(() => [] as string[]),
      dns.promises
        .resolveMx(domain)
        .then((list) =>
          list
            .sort((a, b) => a.priority - b.priority)
            .map((m) => ({ exchange: m.exchange, priority: m.priority }))
        )
        .catch(() => [] as Array<{ exchange: string; priority: number }>),
      dns.promises.resolveNs(domain).catch(() => [] as string[]),
      dns.promises
        .resolveTxt(domain)
        .then((list) => list.map((c) => c.join('')))
        .catch(() => [] as string[]),
      fetchWithTimeout(
        `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`,
        6000
      ).catch(() => null),
    ]);

  const discoveredHosts: Array<{ host: string; ip: string }> = [];
  if (htRes && htRes.ok && !/error|API count exceeded/i.test(htRes.text)) {
    for (const line of htRes.text.split(/\r?\n/)) {
      const [h, ip] = line.split(',').map((s) => s?.trim());
      if (h && ip && h.includes('.')) {
        discoveredHosts.push({ host: h, ip });
      }
    }
  }

  return {
    domain,
    aRecords,
    aaaaRecords,
    mxRecords,
    nsRecords,
    txtRecords: txtChunks.slice(0, 12),
    discoveredHosts: discoveredHosts.slice(0, 25),
  };
}

export async function inspectIpReputation(ip: string): Promise<IpReputationReport> {
  const cleanIp = ip.trim();
  try {
    const res = await fetchWithTimeout(
      `http://ip-api.com/json/${encodeURIComponent(
        cleanIp
      )}?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,reverse,mobile,proxy,hosting,query`,
      6000
    );
    if (!res.ok) return { ip: cleanIp, valid: false };
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    if (parsed.status !== 'success') {
      return { ip: cleanIp, valid: false };
    }
    return {
      ip: String(parsed.query || cleanIp),
      valid: true,
      country: typeof parsed.country === 'string' ? parsed.country : undefined,
      countryCode:
        typeof parsed.countryCode === 'string' ? parsed.countryCode : undefined,
      regionName:
        typeof parsed.regionName === 'string' ? parsed.regionName : undefined,
      city: typeof parsed.city === 'string' ? parsed.city : undefined,
      lat: typeof parsed.lat === 'number' ? parsed.lat : undefined,
      lon: typeof parsed.lon === 'number' ? parsed.lon : undefined,
      timezone: typeof parsed.timezone === 'string' ? parsed.timezone : undefined,
      isp: typeof parsed.isp === 'string' ? parsed.isp : undefined,
      org: typeof parsed.org === 'string' ? parsed.org : undefined,
      asNumber: typeof parsed.as === 'string' ? parsed.as : undefined,
      reverseDns:
        typeof parsed.reverse === 'string' && parsed.reverse
          ? parsed.reverse
          : undefined,
      isMobile: Boolean(parsed.mobile),
      isProxyOrVpn: Boolean(parsed.proxy),
      isHostingDatacenter: Boolean(parsed.hosting),
    };
  } catch {
    return { ip: cleanIp, valid: false };
  }
}

export async function detectWebsiteCmsAndTech(
  domainOrUrl: string
): Promise<WebsiteTechFingerprint> {
  const normalizedUrl = /^https?:\/\//i.test(domainOrUrl.trim())
    ? domainOrUrl.trim()
    : `https://${domainOrUrl.trim()}`;

  try {
    const res = await fetchWithTimeout(normalizedUrl, 6500);
    const serverHeader = res.headers.get('server') || undefined;
    const poweredByHeader = res.headers.get('x-powered-by') || undefined;
    const cfRay = res.headers.get('cf-ray');
    const body = res.text;

    let detectedCms: string | undefined;
    const detectedFrameworks: string[] = [];

    if (/wp-content|wp-includes|wordpress/i.test(body)) {
      detectedCms = 'WordPress';
    } else if (/Drupal\.settings|drupal/i.test(body)) {
      detectedCms = 'Drupal';
    } else if (/Joomla!/i.test(body)) {
      detectedCms = 'Joomla';
    } else if (/cdn\.shopify\.com|Shopify\.theme/i.test(body)) {
      detectedCms = 'Shopify';
    } else if (/wix\.com|X-Wix-/i.test(body)) {
      detectedCms = 'Wix';
    } else if (/squarespace/i.test(body)) {
      detectedCms = 'Squarespace';
    } else if (/ghost\.org|content="Ghost/i.test(body)) {
      detectedCms = 'Ghost CMS';
    }

    if (/_next\/static|__NEXT_DATA__/i.test(body)) detectedFrameworks.push('Next.js (React)');
    if (/__NUXT__|_nuxt\//i.test(body)) detectedFrameworks.push('Nuxt.js (Vue)');
    if (/ng-version=/i.test(body)) detectedFrameworks.push('Angular');
    if (/laravel_session/i.test(res.headers.get('set-cookie') || '')) {
      detectedFrameworks.push('Laravel (PHP)');
    }
    if (/csrftoken/i.test(res.headers.get('set-cookie') || '')) {
      detectedFrameworks.push('Django / Python');
    }
    if (/bootstrap/i.test(body)) detectedFrameworks.push('Bootstrap CSS');
    if (/tailwindcss|tw-/i.test(body)) detectedFrameworks.push('Tailwind CSS');

    let cdnOrWaf: string | undefined;
    if (cfRay || /cloudflare/i.test(serverHeader || '')) {
      cdnOrWaf = 'Cloudflare CDN / WAF';
    } else if (res.headers.get('x-amz-cf-id')) {
      cdnOrWaf = 'Amazon CloudFront';
    } else if (/akamai/i.test(serverHeader || '')) {
      cdnOrWaf = 'Akamai Edge';
    } else if (res.headers.get('x-fastly-request-id')) {
      cdnOrWaf = 'Fastly CDN';
    } else if (res.headers.get('x-vercel-id')) {
      cdnOrWaf = 'Vercel Edge Network';
    }

    return {
      url: normalizedUrl,
      reachable: true,
      httpStatus: res.status,
      serverHeader,
      poweredByHeader,
      detectedCms,
      detectedFrameworks,
      cdnOrWaf,
      securityHeaders: {
        strictTransportSecurity: Boolean(res.headers.get('strict-transport-security')),
        contentSecurityPolicy: Boolean(res.headers.get('content-security-policy')),
        xFrameOptions: Boolean(res.headers.get('x-frame-options')),
      },
    };
  } catch {
    return {
      url: normalizedUrl,
      reachable: false,
      detectedFrameworks: [],
      securityHeaders: {
        strictTransportSecurity: false,
        contentSecurityPolicy: false,
        xFrameOptions: false,
      },
    };
  }
}

export function buildDomainIpInvestigativeLinks(
  target: string,
  resolvedIp?: string
): Array<{
  toolName: string;
  url: string;
  descriptionArabic: string;
}> {
  const clean = target
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0] || target.trim();
  const enc = encodeURIComponent(clean);
  const ipEnc = encodeURIComponent(resolvedIp || clean);

  return [
    {
      toolName: 'crt.sh Certificate Transparency',
      url: `https://crt.sh/?q=%25.${enc}`,
      descriptionArabic: 'سجل شفافية شهادات SSL/TLS واكتشاف النطاقات الفرعية (crt.sh)',
    },
    {
      toolName: 'Shodan Search',
      url: `https://www.shodan.io/search?query=${ipEnc}`,
      descriptionArabic: 'فحص المنافذ المفتوحة والخدمات والثغرات المسجلة (Shodan)',
    },
    {
      toolName: 'DNSDumpster',
      url: `https://dnsdumpster.com/`,
      descriptionArabic: 'رسم الخريطة الشبكية الكاملة للنطاق وخوادم DNS (DNSDumpster)',
    },
    {
      toolName: 'DomainTools Whois',
      url: `https://whois.domaintools.com/${enc}`,
      descriptionArabic: 'سجل ملكية النطاق وتاريخ التسجيل وبيانات المسجل (Whois)',
    },
    {
      toolName: 'PublicWWW Source Code Search',
      url: `https://publicwww.com/websites/%22${enc}%22/`,
      descriptionArabic: 'البحث في الشفرة المصدرية للمواقع المرتبطة بنفس النطاق أو المعرفات',
    },
    {
      toolName: 'WhatCMS Tech Detector',
      url: `https://whatcms.org/?s=${enc}`,
      descriptionArabic: 'كشف نظام إدارة المحتوى (CMS) وإصدار الخادم البرمجي',
    },
    {
      toolName: 'Pulsedive Threat Intelligence',
      url: `https://pulsedive.com/indicator/?ioc=${ Buffer.from(clean).toString('base64')}`,
      descriptionArabic: 'تحليل مؤشرات الاختراق والسمعة الأمنية للنطاق أو الـ IP (Pulsedive)',
    },
    {
      toolName: 'Blocklist.de Fail2Ban Radar',
      url: `https://www.blocklist.de/en/view.html?ip=${ipEnc}`,
      descriptionArabic: 'فحص وجود عنوان الـ IP في قوائم الهجمات والحظر العالمية',
    },
    {
      toolName: 'Project Honeypot',
      url: `https://www.projecthoneypot.org/ip_${ipEnc}`,
      descriptionArabic: 'فحص نشاط البريد المزعج والزواحف الخبيثة لعنوان الـ IP',
    },
  ];
}

export async function runFullDomainOrIpForensicDossier(
  rawInput: string
): Promise<DomainOrIpForensicDossier> {
  const cleaned = rawInput
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0] || '';
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(cleaned);

  if (isIpv4) {
    const [ipReputation, shodanInternetDb] = await Promise.all([
      inspectIpReputation(cleaned),
      queryShodanInternetDb(cleaned),
    ]);
    return {
      target: cleaned,
      targetType: 'IPV4',
      resolvedIp: cleaned,
      scannedAtIso: new Date().toISOString(),
      crtSubdomains: [],
      uniqueSubdomainNames: [],
      ipReputation,
      shodanInternetDb,
      investigativeLinks: buildDomainIpInvestigativeLinks(cleaned, cleaned),
    };
  }

  const [dnsReport, crtRes, techFingerprint] = await Promise.all([
    inspectDomainDnsAndHosts(cleaned),
    queryCrtShSubdomains(cleaned),
    detectWebsiteCmsAndTech(cleaned),
  ]);

  const resolvedIp = dnsReport.aRecords[0];
  const [ipReputation, shodanInternetDb] = resolvedIp
    ? await Promise.all([
        inspectIpReputation(resolvedIp),
        queryShodanInternetDb(resolvedIp),
      ])
    : [undefined, undefined];

  return {
    target: cleaned,
    targetType: 'DOMAIN',
    resolvedIp,
    scannedAtIso: new Date().toISOString(),
    dnsReport,
    crtSubdomains: crtRes.entries,
    uniqueSubdomainNames: crtRes.uniqueSubdomains,
    ipReputation,
    shodanInternetDb,
    techFingerprint,
    investigativeLinks: buildDomainIpInvestigativeLinks(cleaned, resolvedIp),
  };
}
