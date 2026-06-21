// ============================================================
// src/lib/yahooFinance.ts — Llamada directa a Yahoo Finance
// Reemplaza a las Edge Functions de Supabase:
//   yahoo-finance          -> fetchYahooBatch()
//   yahoo-finance-tactical -> fetchYahooBatch()
// ============================================================

export interface YahooChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  dataPoints: number;
}

export interface YahooBatchResponse {
  data: Record<string, YahooChartResult>;
  errors: string[];
}

const cache = new Map<string, { data: YahooBatchResponse; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchYahooBatch(tickers: string[]): Promise<YahooBatchResponse> {
  if (tickers.length === 0) return { data: {}, errors: [] };
  const cacheKey = tickers.sort().join(',');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  try {
    const res = await fetch('/_proxy/yahoo-finance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }),
    });
    if (!res.ok) throw new Error(`Yahoo proxy error ${res.status}`);
    const json: YahooBatchResponse = await res.json();
    cache.set(cacheKey, { data: json, expiresAt: Date.now() + CACHE_TTL });
    return json;
  } catch (err: any) {
    console.warn('[YahooFinance] Batch error:', err?.message ?? err);
    return { data: {}, errors: tickers };
  }
}

export async function fetchYahooPrices(tickers: string[]): Promise<Record<string, number>> {
  const result = await fetchYahooBatch(tickers);
  const prices: Record<string, number> = {};
  for (const ticker of tickers) {
    const d = result.data[ticker];
    if (d?.currentPrice && d.currentPrice > 0) prices[ticker] = d.currentPrice;
  }
  return prices;
}

export function clearYahooCache(): void { cache.clear(); }
