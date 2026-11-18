export interface CryptoWalletOsintReport {
  query: string;
  chain: 'BITCOIN' | 'ETHEREUM_EVM' | 'MONERO' | 'TRON' | 'UNKNOWN';
  validFormat: boolean;
  liveChecked: boolean;
  balanceFormatted?: string;
  totalReceivedFormatted?: string;
  totalSentFormatted?: string;
  txCount?: number;
  topTokens?: Array<{ symbol: string; name: string }>;
  investigativeLinks: Array<{
    toolName: string;
    url: string;
    descriptionArabic: string;
  }>;
}

export interface OccrpAlephEntityHit {
  id: string;
  schema: string;
  name: string;
  datasetTitle: string;
  countries: string[];
  url: string;
}

export interface CorporateAndSanctionsOsintReport {
  query: string;
  scannedAtIso: string;
  alephChecked: boolean;
  alephTotalHits: number;
  alephEntities: OccrpAlephEntityHit[];
  investigativeLinks: Array<{
    toolName: string;
    category: 'CORPORATE_REGISTRY' | 'SANCTIONS_WATCHLIST' | 'SUPPLY_CHAIN' | 'LOBBYING_FINANCE';
    url: string;
    descriptionArabic: string;
  }>;
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs = 6500
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'BotezzCyberForensicsOSINT/2.0',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectCryptoWalletOsint(
  rawInput: string
): Promise<CryptoWalletOsintReport> {
  const q = rawInput.trim();
  const isBtc =
    /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,89})$/.test(q);
  const isEth = /^0x[a-fA-F0-9]{40}$/.test(q);
  const isXmr = /^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(q);
  const isTron = /^T[a-zA-Z0-9]{33}$/.test(q);

  if (isBtc) {
    let liveChecked = false;
    let balanceFormatted: string | undefined;
    let totalReceivedFormatted: string | undefined;
    let totalSentFormatted: string | undefined;
    let txCount: number | undefined;

    try {
      const res = await fetchJsonWithTimeout(
        `https://mempool.space/api/address/${encodeURIComponent(q)}`,
        6500
      );
      if (res.ok) {
        const parsed = JSON.parse(res.text) as {
          chain_stats?: {
            funded_txo_sum?: number;
            spent_txo_sum?: number;
            tx_count?: number;
          };
        };
        const stats = parsed?.chain_stats;
        if (stats) {
          liveChecked = true;
          const funded = Number(stats.funded_txo_sum || 0);
          const spent = Number(stats.spent_txo_sum || 0);
          const balSats = funded - spent;
          balanceFormatted = `${(balSats / 1e8).toFixed(8)} BTC`;
          totalReceivedFormatted = `${(funded / 1e8).toFixed(8)} BTC`;
          totalSentFormatted = `${(spent / 1e8).toFixed(8)} BTC`;
          txCount = Number(stats.tx_count || 0);
        }
      }
    } catch {
      // ignore
    }

    return {
      query: q,
      chain: 'BITCOIN',
      validFormat: true,
      liveChecked,
      balanceFormatted,
      totalReceivedFormatted,
      totalSentFormatted,
      txCount,
      investigativeLinks: [
        {
          toolName: 'Mempool.space Bitcoin Explorer',
          url: `https://mempool.space/address/${encodeURIComponent(q)}`,
          descriptionArabic: 'فحص المعاملات والرصيد الحي على سلسلة Bitcoin (Mempool)',
        },
        {
          toolName: 'BitRef Bitcoin Balance',
          url: `https://bitref.com/${encodeURIComponent(q)}`,
          descriptionArabic: 'استعلام سريع عن رصيد وسجل محفظة البيتكوين (BitRef)',
        },
        {
          toolName: 'BlockExplorer',
          url: `https://www.blockchain.com/explorer/addresses/btc/${encodeURIComponent(q)}`,
          descriptionArabic: 'مستكشف الكتل وتتبع التدفقات المالية (Blockchain Explorer)',
        },
        {
          toolName: 'WalletExplorer Cluster Analysis',
          url: `https://www.walletexplorer.com/?q=${encodeURIComponent(q)}`,
          descriptionArabic: 'تجميع المحافظ المشتركة وتحديد المنصات المرتبطة (WalletExplorer)',
        },
      ],
    };
  }

  if (isEth) {
    let liveChecked = false;
    let balanceFormatted: string | undefined;
    let txCount: number | undefined;
    const topTokens: Array<{ symbol: string; name: string }> = [];

    try {
      const res = await fetchJsonWithTimeout(
        `https://api.ethplorer.io/getAddressInfo/${encodeURIComponent(
          q
        )}?apiKey=freekey`,
        6500
      );
      if (res.ok) {
        const parsed = JSON.parse(res.text) as {
          ETH?: { balance?: number };
          countTxs?: number;
          tokens?: Array<{
            tokenInfo?: { symbol?: string; name?: string };
          }>;
        };
        liveChecked = true;
        if (typeof parsed?.ETH?.balance === 'number') {
          balanceFormatted = `${parsed.ETH.balance.toFixed(6)} ETH`;
        }
        if (typeof parsed?.countTxs === 'number') {
          txCount = parsed.countTxs;
        }
        for (const tk of (parsed.tokens || []).slice(0, 6)) {
          if (tk.tokenInfo?.symbol) {
            topTokens.push({
              symbol: tk.tokenInfo.symbol,
              name: tk.tokenInfo.name || tk.tokenInfo.symbol,
            });
          }
        }
      }
    } catch {
      // ignore
    }

    return {
      query: q,
      chain: 'ETHEREUM_EVM',
      validFormat: true,
      liveChecked,
      balanceFormatted,
      txCount,
      topTokens,
      investigativeLinks: [
        {
          toolName: 'Etherscan Block Explorer',
          url: `https://etherscan.io/address/${encodeURIComponent(q)}`,
          descriptionArabic: 'فحص معاملات Ethereum والرموز الذكية ERC-20/NFT (Etherscan)',
        },
        {
          toolName: 'Blockscan Multi-Chain EVM',
          url: `https://blockscan.com/address/${encodeURIComponent(q)}`,
          descriptionArabic: 'فحص نفس العنوان عبر 20+ شبكة EVM (BSC, Polygon, Arbitrum, Base)',
        },
        {
          toolName: 'Ethplorer Token Analytics',
          url: `https://ethplorer.io/address/${encodeURIComponent(q)}`,
          descriptionArabic: 'تحليل أرصدة التوكنات والتحويلات التاريخية (Ethplorer)',
        },
      ],
    };
  }

  if (isXmr) {
    return {
      query: q,
      chain: 'MONERO',
      validFormat: true,
      liveChecked: true,
      balanceFormatted: 'مشفر (بروتوكول RingCT / Stealth Addresses في Monero)',
      investigativeLinks: [
        {
          toolName: 'XMRChain Monero Explorer',
          url: `https://xmrchain.net/search?value=${encodeURIComponent(q)}`,
          descriptionArabic: 'مستكشف كتل ومعاملات Monero (XMRChain)',
        },
      ],
    };
  }

  if (isTron) {
    return {
      query: q,
      chain: 'TRON',
      validFormat: true,
      liveChecked: true,
      investigativeLinks: [
        {
          toolName: 'Tronscan USDT-TRC20 Explorer',
          url: `https://tronscan.org/#/address/${encodeURIComponent(q)}`,
          descriptionArabic: 'فحص محافظ TRON وتحويلات USDT-TRC20 (Tronscan)',
        },
      ],
    };
  }

  return {
    query: q,
    chain: 'UNKNOWN',
    validFormat: false,
    liveChecked: false,
    investigativeLinks: [
      {
        toolName: 'Blockchair Universal Explorer',
        url: `https://blockchair.com/search?q=${encodeURIComponent(q)}`,
        descriptionArabic: 'البحث الشامل عبر 40+ شبكة بلوكتشين (Blockchair)',
      },
    ],
  };
}

export async function searchCorporateAndSanctionsOsint(
  rawQuery: string
): Promise<CorporateAndSanctionsOsintReport> {
  const q = rawQuery.trim();
  const enc = encodeURIComponent(q);
  let alephChecked = false;
  let alephTotalHits = 0;
  const alephEntities: OccrpAlephEntityHit[] = [];

  try {
    const res = await fetchJsonWithTimeout(
      `https://api.occrp.org/api/2/entities?q=${enc}&limit=6`,
      7000
    );
    if (res.ok) {
      const parsed = JSON.parse(res.text) as {
        total?: number;
        results?: Array<{
          id?: string;
          schema?: string;
          name?: string;
          collection?: { label?: string };
          countries?: string[];
          links?: { ui?: string };
        }>;
      };
      alephChecked = true;
      alephTotalHits = Number(parsed?.total || 0);
      for (const item of (parsed.results || []).slice(0, 6)) {
        if (item.name) {
          alephEntities.push({
            id: String(item.id || ''),
            schema: String(item.schema || 'Entity'),
            name: item.name,
            datasetTitle: String(item.collection?.label || 'OCCRP Aleph Dataset'),
            countries: Array.isArray(item.countries) ? item.countries : [],
            url:
              item.links?.ui ||
              `https://aleph.occrp.org/search?q=${enc}`,
          });
        }
      }
    }
  } catch {
    // ignore network failure
  }

  return {
    query: q,
    scannedAtIso: new Date().toISOString(),
    alephChecked,
    alephTotalHits,
    alephEntities,
    investigativeLinks: [
      {
        toolName: 'OCCRP Aleph Investigative Archive',
        category: 'CORPORATE_REGISTRY',
        url: `https://aleph.occrp.org/search?q=${enc}`,
        descriptionArabic: 'أرشيف مشروع الإبلاغ عن الجريمة المنظمة والفساد والسجلات التجارية (OCCRP Aleph)',
      },
      {
        toolName: 'OpenCorporates Global Registry',
        category: 'CORPORATE_REGISTRY',
        url: `https://opencorporates.com/companies?q=${enc}`,
        descriptionArabic: 'أكبر قاعدة بيانات مفتوحة للشركات ومجالس الإدارة في العالم (OpenCorporates)',
      },
      {
        toolName: 'ICIJ Offshore Leaks Database',
        category: 'CORPORATE_REGISTRY',
        url: `https://offshoreleaks.icij.org/search?q=${enc}`,
        descriptionArabic: 'وثائق بنما وباندورا وبارادايس للشركات العابرة للحدود (ICIJ Offshore Leaks)',
      },
      {
        toolName: 'OpenSanctions Global Watchlist',
        category: 'SANCTIONS_WATCHLIST',
        url: `https://www.opensanctions.org/search/?q=${enc}`,
        descriptionArabic: 'فحص قوائم العقوبات الدولية والأشخاص المعرضين سياسياً PEPs (OpenSanctions)',
      },
      {
        toolName: 'SanctionsExplorer (OFAC / UN / EU)',
        category: 'SANCTIONS_WATCHLIST',
        url: `https://sanctionsexplorer.org/`,
        descriptionArabic: 'محرك البحث في عقوبات الخزانة الأمريكية OFAC والأمم المتحدة',
      },
      {
        toolName: 'ImportYeti Global Customs & Supply Chain',
        category: 'SUPPLY_CHAIN',
        url: `https://www.importyeti.com/search?q=${enc}`,
        descriptionArabic: 'سجلات الشحن البحري وبوالص الاستيراد والتصدير والموردين (ImportYeti)',
      },
      {
        toolName: 'SEC EDGAR Financial Filings',
        category: 'LOBBYING_FINANCE',
        url: `https://www.sec.gov/edgar/searchedgar/companysearch`,
        descriptionArabic: 'الإفصاحات المالية الرسمية للشركات المدرجة في هيئة الأوراق المالية SEC',
      },
      {
        toolName: 'LittleSis Power Networks',
        category: 'LOBBYING_FINANCE',
        url: `https://littlesis.org/search?q=${enc}`,
        descriptionArabic: 'خريطة العلاقات بين رجال الأعمال والشركات ومجموعات الضغط (LittleSis)',
      },
      {
        toolName: 'OpenSecrets Financial Tracking',
        category: 'LOBBYING_FINANCE',
        url: `https://www.opensecrets.org/search?q=${enc}`,
        descriptionArabic: 'تتبع التمويل السياسي واللوبيات والعقود الحكومية (OpenSecrets)',
      },
    ],
  };
}
