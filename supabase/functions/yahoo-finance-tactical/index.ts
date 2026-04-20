// supabase/functions/yahoo-finance-tactical/index.ts
// Edge Function — datos de mercado + fundamentales (PER/EY automático)
// Retorna: precios históricos + earningsYield + per + volumen
// EarningsYield = EPS / Price = 1/PER — calculado AUTOMÁTICAMENTE

// @ts-ignore
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TickerResult {
  ticker:         string;
  currentPrice:   number;
  closes:         number[];
  volumes:        number[];
  timestamps:     number[];
  // AUTO: fundamentales para el factor Value (1/PER)
  earningsYield:  number;   // EPS/Price = 1/PER (0 si ETF sin datos)
  per:            number;   // PER directo de Yahoo (0 si no hay)
  eps:            number;   // Beneficio por acción
  error?:         string;
}

// ── Cache en memoria por 5 minutos ───────────────────────────
const cache = new Map<string, { data: TickerResult; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function fromCache(ticker: string): TickerResult | null {
  const entry = cache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(ticker); return null; }
  return entry.data;
}

// ── Fetch precio histórico (v8) ───────────────────────────────
async function fetchChart(ticker: string): Promise<Partial<TickerResult>> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`chart HTTP ${res.status}`);
  const json  = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error('No chart data');
  const q      = result.indicators?.quote?.[0] ?? {};
  const closes = (q.close ?? []).filter((c: any) => c != null) as number[];
  const volumes= (q.volume ?? []).map((v: any) => v ?? 1000000) as number[];
  const timestamps = (result.timestamp ?? []) as number[];
  const currentPrice = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
  return { currentPrice, closes, volumes, timestamps };
}

// ── Fetch fundamentales (v10) — PER y EPS automático ─────────
async function fetchFundamentals(ticker: string): Promise<{ per: number; eps: number; earningsYield: number }> {
  try {
    const url  = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics,financialData,summaryDetail`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { per: 0, eps: 0, earningsYield: 0 };
    const json  = await res.json();
    const stats = json.quoteSummary?.result?.[0];
    if (!stats) return { per: 0, eps: 0, earningsYield: 0 };

    // Trailing PER (precio / EPS últimos 12 meses)
    const per  = stats.summaryDetail?.trailingPE?.raw
              ?? stats.defaultKeyStatistics?.trailingPE?.raw
              ?? 0;
    // EPS trailing
    const eps  = stats.defaultKeyStatistics?.trailingEps?.raw
              ?? stats.financialData?.revenuePerShare?.raw
              ?? 0;
    // Earnings Yield = 1/PER si tenemos PER, o EPS/Price si tenemos EPS
    let earningsYield = 0;
    if (per > 0) earningsYield = 1 / per;
    // Para ETFs sin PER: earningsYield queda a 0 (factor value neutro)

    return { per, eps, earningsYield };
  } catch {
    return { per: 0, eps: 0, earningsYield: 0 };
  }
}

// ── Procesar un ticker completo ───────────────────────────────
async function fetchTicker(ticker: string): Promise<TickerResult> {
  const cached = fromCache(ticker);
  if (cached) return cached;

  try {
    const [chartData, fundData] = await Promise.all([
      fetchChart(ticker),
      fetchFundamentals(ticker),
    ]);

    const result: TickerResult = {
      ticker,
      currentPrice:  chartData.currentPrice ?? 0,
      closes:        chartData.closes ?? [],
      volumes:       chartData.volumes ?? [],
      timestamps:    chartData.timestamps ?? [],
      per:           fundData.per,
      eps:           fundData.eps,
      earningsYield: fundData.earningsYield,
    };

    cache.set(ticker, { data: result, ts: Date.now() });
    return result;
  } catch (e: any) {
    return {
      ticker, currentPrice: 0, closes: [], volumes: [], timestamps: [],
      per: 0, eps: 0, earningsYield: 0,
      error: e?.message ?? 'Unknown error',
    };
  }
}

// @ts-ignore
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  let body: { tickers?: string[] };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }

  const tickers = (body.tickers ?? []).slice(0, 20);
  if (tickers.length === 0) {
    return new Response(JSON.stringify({ error: 'No tickers' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const results: Record<string, TickerResult> = {};
  const BATCH = 5;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(fetchTicker));
    settled.forEach((r, idx) => {
      const t = batch[idx];
      results[t] = r.status === 'fulfilled' ? r.value : { ticker: t, currentPrice: 0, closes: [], volumes: [], timestamps: [], per: 0, eps: 0, earningsYield: 0, error: String((r as any).reason) };
    });
    if (i + BATCH < tickers.length) await new Promise(res => setTimeout(res, 300));
  }

  const errors = Object.values(results).filter(r => r.error).map(r => `${r.ticker}: ${r.error}`);
  return new Response(
    JSON.stringify({ data: results, errors, fetchedAt: new Date().toISOString(), cached: true }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});