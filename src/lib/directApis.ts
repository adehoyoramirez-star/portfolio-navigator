// ============================================================
// src/lib/directApis.ts — APIs directas sin Supabase
//   crypto-signals -> fetchCryptoSignals()
// ============================================================
/// <reference types="vite/client" />

// ── Crypto Signals (Alternative.me + CoinGecko) ──────────────
export interface CryptoSignalsOutput {
  fearGreedValue: number;
  fearGreedLabel: string;
  fearGreedSource: string;
  btcDominance: number;
  btcDominanceSrc: string;
  btcPriceUSD: number;
  btcPriceEUR: number;
  eurUsd: number;
  errors: string[];
}

async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1&format=json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json?.data?.[0];
    if (!entry) return null;
    return { value: parseInt(entry.value, 10), label: entry.value_classification };
  } catch { return null; }
}

async function fetchCoinGeckoGlobal(): Promise<{ btcDominance: number; btcPriceUSD: number; btcPriceEUR: number; eurUsd: number } | null> {
  try {
    const [globalRes, priceRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/global', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }),
    ]);
    if (!globalRes.ok || !priceRes.ok) return null;
    const [gJson, pJson] = await Promise.all([globalRes.json(), priceRes.json()]);
    const btcDominance = gJson?.data?.market_cap_percentage?.btc ?? 0;
    const btcPriceUSD = pJson?.bitcoin?.usd ?? 0;
    const btcPriceEUR = pJson?.bitcoin?.eur ?? 0;
    const eurUsd = btcPriceUSD > 0 && btcPriceEUR > 0 ? parseFloat((btcPriceUSD / btcPriceEUR).toFixed(4)) : 1.08;
    return { btcDominance, btcPriceUSD, btcPriceEUR, eurUsd };
  } catch { return null; }
}

export async function fetchCryptoSignals(): Promise<CryptoSignalsOutput> {
  const errors: string[] = [];
  const [fg, cg] = await Promise.all([
    fetchFearGreed().catch(() => null),
    fetchCoinGeckoGlobal().catch(() => null),
  ]);

  const fearGreedValue = fg?.value ?? 50;
  const fearGreedLabel = fg?.label ?? 'Neutral';
  const fearGreedSource = fg ? 'Alternative.me' : 'manual';
  if (!fg) errors.push('Alternative.me');

  const btcDominance = cg?.btcDominance ?? 54.0;
  const btcDominanceSrc = cg ? 'CoinGecko' : 'manual';
  const btcPriceUSD = cg?.btcPriceUSD ?? 0;
  const btcPriceEUR = cg?.btcPriceEUR ?? (btcPriceUSD / 1.08);
  const eurUsd = cg?.eurUsd ?? 1.08;
  if (!cg) errors.push('CoinGecko');

  return { fearGreedValue, fearGreedLabel, fearGreedSource, btcDominance, btcDominanceSrc, btcPriceUSD, btcPriceEUR, eurUsd, errors };
}


