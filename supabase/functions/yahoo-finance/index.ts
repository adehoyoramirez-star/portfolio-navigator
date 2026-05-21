// Silencia el error "Cannot find name 'Deno'" del editor local
// En Supabase Edge Functions, Deno existe en tiempo de ejecución
declare const Deno: any;

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
    // range=6y → ~1500 barras: cubre COVID 2020, Taper 2022, rally 2023-24
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

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

    // Sincronización crítica: previene mismatch dimensional en Olympus
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
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) return res;
      console.warn(`Attempt ${attempt}: HTTP ${res.status}`);
    } catch (e) {
      console.error(`Attempt ${attempt} error:`, e);
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  return null;
}

interface M2DataPoint { date: string; value: number }
interface M2Result { current: number; growthYoY: number; history: M2DataPoint[] }

async function fetchM2FRED(): Promise<M2Result | null> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL', 3, 1500);
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    const allPoints: M2DataPoint[] = [];
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
    const growthYoY = yearAgo > 0 ? ((current - yearAgo) / yearAgo) * 100 : 0;
    return { current, growthYoY, history };
  } catch (e) {
    console.error('M2 error:', e);
    return null;
  }
}

async function fetchCAPEFRED(): Promise<{ cape: number; source: string } | null> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE', 3, 1500);
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const cape = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(cape) && cape > 0) return { cape, source: 'FRED CAPE' };
    }
    return null;
  } catch (e) {
    console.error('CAPE error:', e);
    return null;
  }
}

async function fetchCentralBanksFRED(): Promise<{
  fedCurrent: number; fedPrev: number;
  ecbCurrent: number; ecbPrev: number; source: string
} | null> {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL', 3, 1500),
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW', 3, 1500),
    ]);
    const parse = async (res: Response | null): Promise<number[]> => {
      if (!res) return [];
      const lines = (await res.text()).trim().split('\n').slice(1);
      const values: number[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const v = parseFloat(line.split(',')[1]);
        if (!isNaN(v) && v > 0) values.push(v);
      }
      return values;
    };
    const [fed, ecb] = await Promise.all([parse(fedRes), parse(ecbRes)]);
    if (fed.length < 52 || ecb.length < 52) return null;
    return {
      fedCurrent: fed[fed.length - 1] / 1000,
      fedPrev: fed[fed.length - 53] / 1000,
      ecbCurrent: ecb[ecb.length - 1] / 1000,
      ecbPrev: ecb[ecb.length - 53] / 1000,
      source: 'FRED WALCL+ECBASSETSW',
    };
  } catch (e) {
    console.error('Central banks error:', e);
    return null;
  }
}

async function fetchCreditSpreadFRED(): Promise<{ spread: number; source: string } | null> {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2', 3, 1500);
    if (!res) return null;
    const lines = (await res.text()).trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const spread = parseFloat(lines[i].split(',')[1]);
      if (!isNaN(spread) && spread > 0) return { spread: parseFloat(spread.toFixed(2)), source: 'FRED OAS' };
    }
    return null;
  } catch (e) {
    console.error('CreditSpread error:', e);
    return null;
  }
}

async function fetchBreakevenFRED(): Promise<{ value: number; source: string } | null> {
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
  } catch (e) {
    console.error('Breakeven error:', e);
    return null;
  }
}

// Punto de entrada Supabase Edge Functions
Deno.serve(async (req: Request) => {
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
    } catch {
      console.warn('[Edge] Sin tickers en body');
    }

    const allTickers = [...new Set([...userTickers, ...MACRO_TICKERS, ...PROXY_TICKERS])];
    console.log(`[Edge] 🚀 Fetching ${allTickers.length} tickers (${userTickers.length} user + ${MACRO_TICKERS.length} macro + ${PROXY_TICKERS.length} proxy)`);

    const [yahooResults, m2Data, capeData, centralBanks, creditSpreadData, breakevenData] = await Promise.all([
      Promise.allSettled(allTickers.map((t: string) => fetchTicker(t))),
      fetchM2FRED(),
      fetchCAPEFRED(),
      fetchCentralBanksFRED(),
      fetchCreditSpreadFRED(),
      fetchBreakevenFRED(),
    ]);

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];
    let sufficiencyCount = 0;

    yahooResults.forEach((result: PromiseSettledResult<ChartResult | null>, idx: number) => {
      const cleanTicker = allTickers[idx].replace('%5E', '^');

      if (result.status === 'fulfilled' && result.value) {
        const chart = result.value;
        const lengths = [chart.timestamps.length, chart.closes.length, chart.highs.length, chart.lows.length];
        const allEqual = lengths.every(l => l === lengths[0]);

        if (!allEqual) {
          console.error(`❌ ${cleanTicker} array mismatch → SKIP`);
          errors.push(cleanTicker);
          return;
        }

        if (chart.isSufficient) sufficiencyCount++;
        data[cleanTicker] = chart;
      } else {
        errors.push(cleanTicker);
      }
    });

    const allPoints = Object.values(data).map(d => d.dataPoints);
    const minDP = allPoints.length ? Math.min(...allPoints) : 0;
    const maxDP = allPoints.length ? Math.max(...allPoints) : 0;
    const avgDP = allPoints.length ? Math.round(allPoints.reduce((a, b) => a + b, 0) / allPoints.length) : 0;
    const totalOk = Object.keys(data).length;

    console.log(`[Edge] ✅ ${totalOk} tickers OK | minDP=${minDP} avgDP=${avgDP} maxDP=${maxDP}`);
    console.log(`[Edge] 📈 DCC-GARCH: ${sufficiencyCount} dynamic, ${totalOk - sufficiencyCount} static`);
    if (errors.length > 0) console.error(`[Edge] ❌ Failed: ${errors.join(', ')}`);

    const metadata = {
      timestamp: new Date().toISOString(),
      range: '6y',
      tickersRequested: allTickers.length,
      tickersSuccessful: totalOk,
      tickersFailed: errors.length,
      sufficiencyStats: {
        dccReady: sufficiencyCount,
        staticCovariance: totalOk - sufficiencyCount,
      },
      minDataPoints: minDP,
      avgDataPoints: avgDP,
      maxDataPoints: maxDP,
    };

    return new Response(
      JSON.stringify({ data, errors, m2: m2Data, cape: capeData, centralBanks, creditSpread: creditSpreadData, breakeven: breakevenData, metadata }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Edge] ❌ Unhandled:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
