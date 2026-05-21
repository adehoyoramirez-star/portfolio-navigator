// supabase/functions/yahoo-finance-tactical/index.ts
// @ts-ignore
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const MACRO_TICKERS: string[] = [
  '%5EVIX', '%5ETNX', '%5EIRX', '%5EMOVE', 'HYG', 'LQD', '%5EGSPC', 'DX-Y.NYB', 'BZ=F',
];

// FIX: ChartResult ahora incluye highs y lows — NECESARIO para ATR del Motor Táctico
// Sin highs/lows → ATR = 0 → ninguna señal supera el umbral → 0 señales
interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];    // FIX: antes faltaba → ATR siempre 0
  lows: number[];     // FIX: antes faltaba → ATR siempre 0
  dataPoints: number;
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    // FIX: range=6y para backtest de 6 años (antes era range=5y)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6y&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.error(`[Tactical] ${ticker} HTTP ${res.status}`);
      return null;
    }

    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes: number[] = quote.close || [];
    const highs: number[]  = quote.high  || [];  // FIX: extraer highs
    const lows: number[]   = quote.low   || [];  // FIX: extraer lows

    // Limpiar nulls
    const clean = (arr: number[]) => arr.map((v: any) => (v == null || !isFinite(v)) ? 0 : v);

    // FIX: Sincronizar longitudes — previene mismatch dimensional
    const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);

    if (minLen < timestamps.length) {
      console.warn(`⚠️ [Tactical] ${ticker}: misalignment → minLen=${minLen}`);
    }

    const currentPrice = result.meta?.regularMarketPrice ?? clean(closes)[closes.length - 1] ?? 0;
    const cleanTicker = ticker.replace('%5E', '^');

    return {
      ticker: cleanTicker,
      currentPrice,
      timestamps: timestamps.slice(0, minLen),
      closes:     clean(closes).slice(0, minLen),
      highs:      clean(highs).slice(0, minLen),
      lows:       clean(lows).slice(0, minLen),
      dataPoints: minLen,
    };
  } catch (e) {
    console.error(`[Tactical] ${ticker} error:`, e);
    return null;
  }
}

async function fetchWithRetry(url: string, retries = 3, delayMs = 1000): Promise<Response | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) return res;
    } catch (e) {
      console.error(`[Tactical] Attempt ${attempt}:`, e);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
  }
  return null;
}

async function fetchM2FRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL');
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    const values: number[] = [];
    for (const line of lines) {
      const val = parseFloat(line.split(',')[1]);
      if (!isNaN(val) && val > 0) values.push(val);
    }
    if (values.length < 13) return null;
    const current = values[values.length - 1];
    const yearAgo = values[values.length - 13];
    return { current, growthYoY: yearAgo ? ((current - yearAgo) / yearAgo) * 100 : 0 };
  } catch { return null; }
}

async function fetchCAPEFRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE');
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const cape = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(cape) && cape > 0) return { cape };
    }
    return null;
  } catch { return null; }
}

async function fetchCentralBanksFRED() {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL'),
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW'),
    ]);
    const parse = async (r: Response | null): Promise<number[]> => {
      if (!r) return [];
      const lines = (await r.text()).trim().split('\n').slice(1);
      const vals: number[] = [];
      for (const line of lines) {
        const v = parseFloat(line.split(',')[1]);
        if (!isNaN(v) && v > 0) vals.push(v);
      }
      return vals;
    };
    const [fed, ecb] = await Promise.all([parse(fedRes), parse(ecbRes)]);
    if (fed.length < 52 || ecb.length < 52) return null;
    return {
      fedCurrent: fed[fed.length - 1] / 1000, fedPrev: fed[fed.length - 53] / 1000,
      ecbCurrent: ecb[ecb.length - 1] / 1000, ecbPrev: ecb[ecb.length - 53] / 1000,
    };
  } catch { return null; }
}

async function fetchCreditSpreadFRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2');
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(s) && s > 0) return { spread: parseFloat(s.toFixed(2)) };
    }
    return null;
  } catch { return null; }
}

async function fetchBreakevenFRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=T5YIFR');
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const v = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(v) && v > 0) return { value: parseFloat(v.toFixed(2)) };
    }
    return null;
  } catch { return null; }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    let userTickers: string[] = [];
    try {
      const body: any = await req.json();
      if (body?.tickers) {
        userTickers = body.tickers.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
      }
    } catch { /* sin body */ }

    const allTickers = [...new Set([...userTickers, ...MACRO_TICKERS])];
    console.log(`[Tactical] 🚀 Fetching ${allTickers.length} tickers (${userTickers.length} user + ${MACRO_TICKERS.length} macro)`);

    const [yahooResults, m2, cape, centralBanks, creditSpread, breakeven] = await Promise.all([
      Promise.allSettled(allTickers.map((t: string) => fetchTicker(t))),
      fetchM2FRED(), fetchCAPEFRED(), fetchCentralBanksFRED(), fetchCreditSpreadFRED(), fetchBreakevenFRED(),
    ]);

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];

    yahooResults.forEach((result: PromiseSettledResult<ChartResult | null>, idx: number) => {
      const cleanTicker = allTickers[idx].replace('%5E', '^');
      if (result.status === 'fulfilled' && result.value) {
        const chart = result.value;
        // Validación de integridad
        const lens = [chart.timestamps.length, chart.closes.length, chart.highs.length, chart.lows.length];
        if (!lens.every(l => l === lens[0])) {
          console.error(`❌ [Tactical] ${cleanTicker} mismatch → SKIP`);
          errors.push(cleanTicker);
          return;
        }
        data[cleanTicker] = chart;
      } else {
        errors.push(cleanTicker);
      }
    });

    const pts = Object.values(data).map(d => d.dataPoints);
    const minDP = pts.length ? Math.min(...pts) : 0;
    const maxDP = pts.length ? Math.max(...pts) : 0;
    console.log(`[Tactical] ✅ ${Object.keys(data).length} OK | min=${minDP} max=${maxDP}`);
    if (errors.length) console.error(`[Tactical] ❌ Failed: ${errors.join(', ')}`);

    return new Response(
      JSON.stringify({ data, errors, m2, cape, centralBanks, creditSpread, breakeven }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Tactical] ❌', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
