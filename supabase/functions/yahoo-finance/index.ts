// @ts-ignore
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const MACRO_TICKERS: string[] = [
  '%5EVIX', '%5ETNX', '%5EIRX', '%5EMOVE', 'HYG', 'LQD', '%5EGSPC', 'DX-Y.NYB', 'BZ=F',
];

const PROXY_TICKERS: string[] = [
  'EEM', 'QUAL', 'GLD', 'URA', 'SMH', 'QQQ', 'SPY',
];

interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];
  lows: number[];
  dataPoints: number;
  isSufficient: boolean;
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6y&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.error(`[fetchTicker] ${ticker} HTTP ${res.status}`);
      return null;
    }

    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes: number[] = quote.close || [];
    const highs: number[] = quote.high || [];
    const lows: number[] = quote.low || [];

    const clean = (arr: number[]) => arr.map((v: any) => (v == null || !isFinite(v)) ? 0 : v);
    const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);

    if (minLen < timestamps.length) {
      console.warn(`⚠️ ${ticker}: misalignment → minLen=${minLen}`);
    }

    const currentPrice = result.meta?.regularMarketPrice ?? clean(closes)[closes.length - 1] ?? 0;
    const cleanTicker = ticker.replace('%5E', '^');

    return {
      ticker: cleanTicker,
      currentPrice,
      timestamps: timestamps.slice(0, minLen),
      closes: clean(closes).slice(0, minLen),
      highs: clean(highs).slice(0, minLen),
      lows: clean(lows).slice(0, minLen),
      dataPoints: minLen,
      isSufficient: minLen >= 60,
    };
  } catch (e) {
    console.error(`[fetchTicker] ${ticker} error:`, e);
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
      console.error(`Attempt ${attempt}:`, e);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
  }
  return null;
}

async function fetchM2FRED(): Promise<any> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL', 3, 1500);
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    const allPoints: { date: string; value: number }[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const [date, val] = line.split(',');
      const value = parseFloat(val);
      if (date && !isNaN(value) && value > 0) allPoints.push({ date: date.trim(), value });
    }
    if (allPoints.length < 13) return null;
    const history = allPoints.slice(-60);
    const current = history[history.length - 1].value;
    const yearAgo = history[history.length - 13]?.value ?? current;
    return { current, growthYoY: yearAgo > 0 ? ((current - yearAgo) / yearAgo) * 100 : 0, history };
  } catch (e) { return null; }
}

async function fetchCAPEFRED(): Promise<any> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE', 3, 1500);
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const cape = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(cape) && cape > 0) return { cape, source: 'FRED CAPE' };
    }
    return null;
  } catch (e) { return null; }
}

async function fetchCentralBanksFRED(): Promise<any> {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL', 3, 1500),
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW', 3, 1500),
    ]);
    const parse = async (r: Response | null): Promise<number[]> => {
      if (!r) return [];
      const lines = (await r.text()).trim().split('\n').slice(1);
      const vals: number[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
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
      source: 'FRED WALCL+ECBASSETSW',
    };
  } catch (e) { return null; }
}

async function fetchCreditSpreadFRED(): Promise<any> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2', 3, 1500);
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const s = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(s) && s > 0) return { spread: parseFloat(s.toFixed(2)), source: 'FRED OAS' };
    }
    return null;
  } catch (e) { return null; }
}

async function fetchBreakevenFRED(): Promise<any> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=T5YIFR', 3, 1500);
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const v = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(v) && v > 0) return { value: parseFloat(v.toFixed(2)), source: 'FRED T5YIFR' };
    }
    return null;
  } catch (e) { return null; }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let userTickers: string[] = [];
    try {
      const body: any = await req.json();
      if (body?.tickers) {
        userTickers = body.tickers.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
      }
    } catch { /* sin body */ }

    const allTickers = [...new Set([...userTickers, ...MACRO_TICKERS, ...PROXY_TICKERS])];
    console.log(`[Edge] 🚀 Fetching ${allTickers.length} tickers`);

    const [yahooResults, m2Data, capeData, centralBanks, creditSpreadData, breakevenData] = await Promise.all([
      Promise.allSettled(allTickers.map((t: string) => fetchTicker(t))),
      fetchM2FRED(), fetchCAPEFRED(), fetchCentralBanksFRED(), fetchCreditSpreadFRED(), fetchBreakevenFRED(),
    ]);

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];
    let sufficiencyCount = 0;

    yahooResults.forEach((result: PromiseSettledResult<ChartResult | null>, idx: number) => {
      const cleanTicker = allTickers[idx].replace('%5E', '^');
      if (result.status === 'fulfilled' && result.value) {
        const chart = result.value;
        const lens = [chart.timestamps.length, chart.closes.length, chart.highs.length, chart.lows.length];
        if (!lens.every(l => l === lens[0])) {
          console.error(`❌ ${cleanTicker} mismatch → SKIP`);
          errors.push(cleanTicker);
          return;
        }
        if (chart.isSufficient) sufficiencyCount++;
        data[cleanTicker] = chart;
      } else {
        errors.push(cleanTicker);
      }
    });

    const pts = Object.values(data).map(d => d.dataPoints);
    const minDP = pts.length ? Math.min(...pts) : 0;
    const maxDP = pts.length ? Math.max(...pts) : 0;
    const avgDP = pts.length ? Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) : 0;
    const totalOk = Object.keys(data).length;

    console.log(`[Edge] ✅ ${totalOk} OK | min=${minDP} avg=${avgDP} max=${maxDP}`);
    console.log(`[Edge] 📈 DCC: ${sufficiencyCount} dynamic, ${totalOk - sufficiencyCount} static`);
    if (errors.length) console.error(`[Edge] ❌ Failed: ${errors.join(', ')}`);

    return new Response(
      JSON.stringify({
        data, errors,
        m2: m2Data, cape: capeData, centralBanks,
        creditSpread: creditSpreadData, breakeven: breakevenData,
        metadata: {
          timestamp: new Date().toISOString(),
          range: '6y',
          tickersRequested: allTickers.length,
          tickersSuccessful: totalOk,
          tickersFailed: errors.length,
          sufficiencyStats: { dccReady: sufficiencyCount, staticCovariance: totalOk - sufficiencyCount },
          minDataPoints: minDP, avgDataPoints: avgDP, maxDataPoints: maxDP,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Edge] ❌', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
