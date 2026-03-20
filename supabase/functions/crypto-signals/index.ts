// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

/**
 * SUPABASE EDGE FUNCTION: crypto-signals
 * =====================================================================
 * Fuentes de datos GRATUITAS (sin API key obligatoria):
 *   1. Alternative.me  — Fear & Greed Index (cripto)
 *   2. CoinGecko       — BTC Dominance + precio BTC (nivel free, 50 req/min)
 *   3. Blockchain.info — Precio BTC fallback público
 *
 * Retorna:
 *   fearGreedValue   number   0-100
 *   fearGreedLabel   string   "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
 *   fearGreedSource  string   "Alternative.me" | "manual"
 *   btcDominance     number   % BTC.D (CoinGecko)
 *   btcDominanceSrc  string
 *   btcPriceUSD      number   precio BTC/USD
 *   btcPriceEUR      number   precio BTC/EUR (via EUR/USD FX)
 *   eurUsd           number   tipo de cambio EUR/USD
 * =====================================================================
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

interface CryptoSignalsOutput {
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

// ─── Alternative.me Fear & Greed ──────────────────────────────────────────────
async function fetchFearGreed(): Promise<{ value: number; label: string } | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=1&format=json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json?.data?.[0];
    if (!entry) return null;
    return {
      value: parseInt(entry.value, 10),
      label: entry.value_classification,
    };
  } catch {
    return null;
  }
}

// ─── CoinGecko global market (BTC dominance + prices) ─────────────────────────
interface CoinGeckoGlobal {
  btcDominance: number;
  btcPriceUSD: number;
  btcPriceEUR: number;
  eurUsd: number;
}

async function fetchCoinGeckoGlobal(): Promise<CoinGeckoGlobal | null> {
  try {
    // Dos endpoints en paralelo: global (dominance) + simple price (BTC/USD + EUR)
    const [globalRes, priceRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/global', {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      }),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur', {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      }),
    ]);

    if (!globalRes.ok || !priceRes.ok) return null;

    const [globalJson, priceJson] = await Promise.all([
      globalRes.json(),
      priceRes.json(),
    ]);

    const btcDominance: number =
      globalJson?.data?.market_cap_percentage?.btc ?? 0;
    const btcPriceUSD: number = priceJson?.bitcoin?.usd ?? 0;
    const btcPriceEUR: number = priceJson?.bitcoin?.eur ?? 0;
    const eurUsd = btcPriceUSD > 0 && btcPriceEUR > 0
      ? parseFloat((btcPriceUSD / btcPriceEUR).toFixed(4))
      : 1.08; // fallback EUR/USD histórico

    return { btcDominance, btcPriceUSD, btcPriceEUR, eurUsd };
  } catch {
    return null;
  }
}

// ─── Blockchain.info fallback (precio BTC/USD) ────────────────────────────────
async function fetchBlockchainBTC(): Promise<number | null> {
  try {
    const res = await fetch('https://blockchain.info/ticker', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.USD?.last ?? null;
  } catch {
    return null;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
// @ts-ignore — Deno global
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const errors: string[] = [];

  // Fetch all in parallel — ninguna fuente es bloqueante
  const [fearGreedRaw, coinGeckoRaw, blockchainPrice] = await Promise.all([
    fetchFearGreed().catch(() => null),
    fetchCoinGeckoGlobal().catch(() => null),
    fetchBlockchainBTC().catch(() => null),
  ]);

  // Fear & Greed
  const fearGreedValue = fearGreedRaw?.value ?? 50;
  const fearGreedLabel = fearGreedRaw?.label ?? 'Neutral';
  const fearGreedSource = fearGreedRaw ? 'Alternative.me' : 'manual';
  if (!fearGreedRaw) errors.push('Alternative.me');

  // BTC Dominance
  const btcDominance = coinGeckoRaw?.btcDominance ?? 54.0;
  const btcDominanceSrc = coinGeckoRaw ? 'CoinGecko' : 'manual';
  if (!coinGeckoRaw) errors.push('CoinGecko');

  // BTC Price
  let btcPriceUSD = coinGeckoRaw?.btcPriceUSD ?? 0;
  if (!btcPriceUSD && blockchainPrice) {
    btcPriceUSD = blockchainPrice;
  }
  const btcPriceEUR = coinGeckoRaw?.btcPriceEUR ?? (btcPriceUSD / 1.08);
  const eurUsd = coinGeckoRaw?.eurUsd ?? 1.08;

  const output: CryptoSignalsOutput = {
    fearGreedValue,
    fearGreedLabel,
    fearGreedSource,
    btcDominance,
    btcDominanceSrc,
    btcPriceUSD,
    btcPriceEUR,
    eurUsd,
    errors,
  };

  return new Response(JSON.stringify(output), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
