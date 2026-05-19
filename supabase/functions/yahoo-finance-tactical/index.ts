// supabase/functions/yahoo-finance-tactical/index.ts
// Edge Function — datos de mercado + macro (VIX, FRED)

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
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5y&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const timestamps: number[] = result.timestamp || [];
    const closes: number[] = result.indicators?.quote?.[0]?.close || [];
    const currentPrice = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    const cleanTicker = ticker.replace('%5E', '^');
    return { ticker: cleanTicker, currentPrice, timestamps, closes };
  } catch {
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
    } catch { /* ignora */ }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
  }
  return null;
}

async function fetchM2FRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL');
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    const values: number[] = [];
    for (const line of lines) {
      const parts = line.split(',');
      const val = parseFloat(parts[1]);
      if (!isNaN(val) && val > 0) values.push(val);
    }
    if (values.length < 13) return null;
    const current = values[values.length - 1];
    const yearAgo = values[values.length - 13];
    const growthYoY = yearAgo ? ((current - yearAgo) / yearAgo) * 100 : 0;
    return { current, growthYoY };
  } catch {
    return null;
  }
}

async function fetchCAPEFRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE');
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split(',');
      const cape = parseFloat(parts[1]);
      if (!isNaN(cape) && cape > 0) return { cape };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchCentralBanksFRED() {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL'),
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW'),
    ]);
    const parseCSV = async (res: Response | null): Promise<number[]> => {
      if (!res) return [];
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);
      const vals: number[] = [];
      for (const line of lines) {
        const parts = line.split(',');
        const v = parseFloat(parts[1]);
        if (!isNaN(v) && v > 0) vals.push(v);
      }
      return vals;
    };
    const fedVals = await parseCSV(fedRes);
    const ecbVals = await parseCSV(ecbRes);
    if (fedVals.length < 52 || ecbVals.length < 52) return null;
    return {
      fedCurrent: fedVals[fedVals.length - 1] / 1000,
      fedPrev: fedVals[fedVals.length - 53] / 1000,
      ecbCurrent: ecbVals[ecbVals.length - 1] / 1000,
      ecbPrev: ecbVals[ecbVals.length - 53] / 1000,
    };
  } catch {
    return null;
  }
}

async function fetchCreditSpreadFRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2');
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split(',');
      const spread = parseFloat(parts[1]);
      if (!isNaN(spread) && spread > 0) return { spread: parseFloat(spread.toFixed(2)) };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchBreakevenFRED() {
  try {
    const res = await fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=T5YIFR');
    if (!res) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split(',');
      const val = parseFloat(parts[1]);
      if (!isNaN(val) && val > 0) return { value: parseFloat(val.toFixed(2)) };
    }
    return null;
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
    } catch { /* no body */ }

    const allTickers = [...new Set([...userTickers, ...MACRO_TICKERS])];
    console.log(`[Edge] Fetching ${allTickers.length} tickers`);

    const [yahooResults, m2, cape, centralBanks, creditSpread, breakeven] = await Promise.all([
      Promise.allSettled(allTickers.map(t => fetchTicker(t))),
      fetchM2FRED(),
      fetchCAPEFRED(),
      fetchCentralBanksFRED(),
      fetchCreditSpreadFRED(),
      fetchBreakevenFRED(),
    ]);

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];

    yahooResults.forEach((result, idx) => {
      const ticker = allTickers[idx];
      const cleanTicker = ticker.replace('%5E', '^');
      if (result.status === 'fulfilled' && result.value) {
        data[cleanTicker] = result.value;
      } else {
        errors.push(cleanTicker);
      }
    });

    return new Response(JSON.stringify({ data, errors, m2, cape, centralBanks, creditSpread, breakeven }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Unhandled error:', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});