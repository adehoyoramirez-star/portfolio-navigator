const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const MACRO_TICKERS = [
  '%5EVIX', '%5ETNX', '%5EIRX', '%5EMOVE', 'HYG', 'LQD', '%5EGSPC', 'DX-Y.NYB', 'BZ=F',
];

const PROXY_TICKERS = [
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
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) {
      console.error(`[fetchTicker] ${ticker} HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as any;
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes = quote.close || [];
    const highs = quote.high || [];
    const lows = quote.low || [];

    const clean = (arr: number[]) => arr.map(v => (v == null || !isFinite(v)) ? 0 : v);

    const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);

    if (minLen < timestamps.length) {
      console.warn(
        `⚠️ ${ticker}: timestamps=${timestamps.length}, closes=${closes.length}, ` +
        `highs=${highs.length}, lows=${lows.length} → minLen=${minLen}`
      );
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
      console.error(`Attempt ${attempt}: ${e}`);
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
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL';
    const res = await fetchWithRetry(url, 3, 1500);
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
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE';
    const res = await fetchWithRetry(url, 3, 1500);
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [, val] = line.split(',');
      const cape = parseFloat(val);
      if (!isNaN(cape) && cape > 0) return { cape, source: 'FRED CAPE' };
    }
    return null;
  } catch (e) {
    console.error('CAPE error:', e);
    return null;
  }
}

async function fetchCentralBanksFRED(): Promise<{ fedCurrent: number; fedPrev: number; ecbCurrent: number; ecbPrev: number; source: string } | null> {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL', 3, 1500),
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW', 3, 1500),
    ]);
    const parseFREDcsv = async (res: Response | null): Promise<number[]> => {
      if (!res) return [];
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);
      const values: number[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split(',');
        const v = parseFloat(parts[1]);
        if (!isNaN(v) && v > 0) values.push(v);
      }
      return values;
    };
    const fedVals = await parseFREDcsv(fedRes);
    const ecbVals = await parseFREDcsv(ecbRes);
    if (fedVals.length < 52 || ecbVals.length < 52) return null;
    return {
      fedCurrent: fedVals[fedVals.length - 1] / 1000,
      fedPrev: fedVals[fedVals.length - 53] / 1000,
      ecbCurrent: ecbVals[ecbVals.length - 1] / 1000,
      ecbPrev: ecbVals[ecbVals.length - 53] / 1000,
      source: 'FRED WALCL+ECBASSETSW',
    };
  } catch (e) {
    console.error('Central banks error:', e);
    return null;
  }
}

async function fetchCreditSpreadFRED(): Promise<{ spread: number; source: string } | null> {
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2';
    const res = await fetchWithRetry(url, 3, 1500);
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [, val] = line.split(',');
      const spread = parseFloat(val);
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
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=T5YIFR';
    const res = await fetchWithRetry(url, 3, 1500);
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [, val] = line.split(',');
      const v = parseFloat(val);
      if (!isNaN(v) && v > 0) return { value: parseFloat(v.toFixed(2)), source: 'FRED T5YIFR' };
    }
    return null;
  } catch (e) {
    console.error('Breakeven error:', e);
    return null;
  }
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let userTickers: string[] = [];
    try {
      const body = await req.json() as { tickers?: string[] };
      if (body?.tickers) {
        userTickers = body.tickers.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
      }
    } catch {
      console.warn('[Edge] No body tickers');
    }

    const allTickers = [...new Set([...userTickers, ...MACRO_TICKERS, ...PROXY_TICKERS])];
    console.log(`[Edge] 🚀 Fetching ${allTickers.length} tickers`);

    const [yahooResults, m2Data, capeData, centralBanks, creditSpreadData, breakevenData] = await Promise.all([
      Promise.allSettled(allTickers.map((ticker: string) => fetchTicker(ticker))),
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
      const ticker = allTickers[idx];
      const cleanTicker = ticker.replace('%5E', '^');

      if (result.status === 'fulfilled' && result.value) {
        const chart = result.value;
        const lengths = {
          timestamps: chart.timestamps.length,
          closes: chart.closes.length,
          highs: chart.highs.length,
          lows: chart.lows.length,
        };

        const allEqual = Object.values(lengths).every(len => len === lengths.timestamps);
        if (!allEqual) {
          console.error(`❌ ${cleanTicker} mismatch: ${JSON.stringify(lengths)}`);
          errors.push(cleanTicker);
          return;
        }

        if (chart.isSufficient) {
          sufficiencyCount++;
        }

        data[cleanTicker] = chart;
      } else {
        errors.push(cleanTicker);
      }
    });

    const allPoints = Object.values(data).map(d => d.dataPoints);
    const minDP = allPoints.length ? Math.min(...allPoints) : 0;
    const maxDP = allPoints.length ? Math.max(...allPoints) : 0;
    const avgDP = allPoints.length ? Math.round(allPoints.reduce((a, b) => a + b, 0) / allPoints.length) : 0;

    console.log(`[Edge] ✅ ${Object.keys(data).length} tickers, minDP=${minDP}, avgDP=${avgDP}, maxDP=${maxDP}`);
    console.log(`[Edge] 📈 DCC-GARCH: ${sufficiencyCount} dynamic, ${Object.keys(data).length - sufficiencyCount} static`);

    const metadata = {
      timestamp: new Date().toISOString(),
      range: '6y',
      tickersRequested: allTickers.length,
      tickersSuccessful: Object.keys(data).length,
      tickersFailed: errors.length,
      sufficiencyStats: {
        dccReady: sufficiencyCount,
        staticCovariance: Object.keys(data).length - sufficiencyCount,
      },
      minDataPoints: minDP,
      avgDataPoints: avgDP,
      maxDataPoints: maxDP,
    };

    return new Response(
      JSON.stringify({
        data,
        errors,
        m2: m2Data,
        cape: capeData,
        centralBanks,
        creditSpread: creditSpreadData,
        breakeven: breakevenData,
        metadata,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Edge] ❌ Error:', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
};
