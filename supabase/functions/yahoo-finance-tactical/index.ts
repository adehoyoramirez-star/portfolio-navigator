// supabase/functions/yahoo-finance-tactical/index.ts
// VERSIÓN FINAL — Solo Yahoo Finance, sin FRED

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const MACRO_TICKERS: string[] = [
  '%5EVIX', '%5ETNX', '%5EIRX', '%5EMOVE', 'HYG', 'LQD', '%5EGSPC', 'DX-Y.NYB', 'BZ=F',
];

interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];
  lows: number[];
  dataPoints: number;
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes: number[] = quote.close || [];
    const highs: number[]  = quote.high  || [];
    const lows: number[]   = quote.low   || [];

    const clean = (arr: number[]) => arr.map((v: any) => (v == null || !isFinite(v)) ? 0 : v);
    const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);
    
    if (minLen < 60) return null;
    const currentPrice = result.meta?.regularMarketPrice ?? clean(closes)[closes.length - 1] ?? 0;

    return {
      ticker: ticker.replace('%5E', '^'),
      currentPrice,
      timestamps: timestamps.slice(0, minLen),
      closes:     clean(closes).slice(0, minLen),
      highs:      clean(highs).slice(0, minLen),
      lows:       clean(lows).slice(0, minLen),
      dataPoints: minLen,
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    let userTickers: string[] = [];
    try {
      const body = await req.json() as { tickers?: string[] };
      if (body && Array.isArray(body.tickers)) {
        userTickers = body.tickers.map(t => t.trim()).filter(t => t.length > 0);
      }
    } catch {
      // sin body
    }

    const allTickers = [...new Set([...userTickers, ...MACRO_TICKERS])];
    console.log(`[Tactical] 🚀 Fetching ${allTickers.length} tickers`);

    // Yahoo con timeout global de 18s
    let yahooResults = [] as PromiseSettledResult<ChartResult | null>[];

    try {
      yahooResults = await Promise.race([
        Promise.allSettled(allTickers.map(t => fetchTicker(t))),
        new Promise<PromiseSettledResult<ChartResult | null>[]>(resolve => 
          setTimeout(() => resolve(allTickers.map(() => ({ status: 'rejected' as const, reason: 'timeout' }))), 18000)
        ),
      ]);
    } catch {
      yahooResults = allTickers.map(() => ({ status: 'rejected' as const, reason: 'error' }));
    }

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];

    yahooResults.forEach((result, idx) => {
      const cleanTicker = allTickers[idx].replace('%5E', '^');
      if (result.status === 'fulfilled' && result.value) {
        const chart = result.value;
        const lens = [chart.timestamps.length, chart.closes.length, chart.highs.length, chart.lows.length];
        if (!lens.every(l => l === lens[0])) {
          errors.push(cleanTicker);
          return;
        }
        data[cleanTicker] = chart;
      } else {
        errors.push(cleanTicker);
      }
    });

    const pts = Object.values(data).map(d => d.dataPoints);
    console.log(`[Tactical] ✅ ${Object.keys(data).length} OK`);

    // FRED devuelve null — tú lo metes manual en el frontend
    return new Response(
      JSON.stringify({ 
        data, 
        errors, 
        m2: null, 
        cape: null, 
        centralBanks: null, 
        creditSpread: null, 
        breakeven: null 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Tactical] ❌', msg);
    return new Response(
      JSON.stringify({ 
        error: msg, 
        data: {}, 
        errors: [],
        m2: null, 
        cape: null, 
        centralBanks: null, 
        creditSpread: null, 
        breakeven: null 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
