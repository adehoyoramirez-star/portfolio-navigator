// @ts-ignore — Deno types no están en el tsconfig del frontend
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
/// <reference types="https://deno.land/x/types/deno.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Tickers macroeconómicos que SIEMPRE se piden
const MACRO_TICKERS: string[] = [
  '%5EVIX',   // VIX
  '%5ETNX',   // 10Y Treasury
  '%5EIRX',   // 30Y Treasury
  '%5EMOVE',  // MOVE Index
  'HYG',      // High Yield ETF
  'LQD',      // Investment Grade ETF
  '%5EGSPC',  // S&P 500
  'DX-Y.NYB', // DXY (dólar)
  'BZ=F',     // Brent Crude
];

// FIX BUG-PROXY: Proxies americanos necesarios para backtestEngine y stressScenarios
// backtestEngine PROXY_MAP: EMXC.DE→EEM, IS3Q.DE→QUAL, PPFB.DE→GLD, URNU.DE→URA, VVSM.DE→SMH, XNAS.DE→QQQ
// stressScenarios PROXY_MAP: IS3Q.DE→EEM (también necesita EEM)
const PROXY_TICKERS: string[] = [
  'EEM',   // Emerging Markets proxy (EMXC.DE + IS3Q.DE en stress)
  'QUAL',  // MSCI USA Quality proxy (IS3Q.DE en backtest)
  'GLD',   // Gold proxy (PPFB.DE)
  'URA',   // Uranium proxy (URNU.DE)
  'SMH',   // Semiconductors proxy (VVSM.DE)
  'QQQ',   // NASDAQ 100 proxy (XNAS.DE)
  'SPY',   // S&P 500 benchmark alternativo para backtest
];

// FIX BUG-HIGSHLOWS: ChartResult ahora incluye highs y lows para ATR del Motor Táctico
interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];    // FIX: necesario para ATR
  lows: number[];     // FIX: necesario para ATR
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      console.error(`Failed to fetch ${ticker}: ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes: number[] = quote.close  || [];
    const highs:  number[] = quote.high   || [];  // FIX: extraer highs
    const lows:   number[] = quote.low    || [];  // FIX: extraer lows

    // Limpiar nulls que Yahoo a veces devuelve en medio del array
    const clean = (arr: number[]) => arr.map(v => (v == null || !isFinite(v)) ? 0 : v);

    // FIX: Sincronizar longitudes — usar la longitud mínima válida para evitar mismatch dimensional
    const minLen = Math.min(
      timestamps.length,
      closes.length,
      highs.length,
      lows.length
    );
    
    // Si hay desalineación significativa, loguear warning
    if (minLen < timestamps.length) {
      console.warn(`⚠️ ${ticker} data misalignment: timestamps=${timestamps.length}, closes=${closes.length}, highs=${highs.length}, lows=${lows.length} → usando ${minLen}`);
    }

    const currentPrice = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;
    const cleanTicker = ticker.replace('%5E', '^');

    return {
      ticker: cleanTicker,
      currentPrice,
      timestamps: timestamps.slice(0, minLen),
      closes: clean(closes).slice(0, minLen),
      highs:  clean(highs).slice(0, minLen),
      lows:   clean(lows).slice(0, minLen),
    };
  } catch (e) {
    console.error(`Error fetching ${ticker}:`, e);
    return null;
  }
}

// ── HELPER: fetch con reintentos ──────────────────────────────
async function fetchWithRetry(url: string, retries = 3, delayMs = 1000): Promise<Response | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        // @ts-ignore - Deno específico para forzar HTTP/1.1
        httpVersion: '1.1',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.ok) return res;
      console.warn(`Attempt ${attempt} for ${url} failed with status ${res.status}`);
    } catch (e) {
      console.error(`Attempt ${attempt} for ${url} error:`, e);
    }
    if (attempt < retries) {
      const wait = delayMs * attempt;
      console.log(`Waiting ${wait}ms before retry ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return null;
}

// ── FRED M2 ──────────────────────────────────────────────────
interface M2DataPoint { date: string; value: number; }
interface M2Result { current: number; growthYoY: number; history: M2DataPoint[]; }
interface CentralBankData { fedCurrent: number; fedPrev: number; ecbCurrent: number; ecbPrev: number; source: string; }

async function fetchM2FRED(): Promise<M2Result | null> {
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL';
    const res = await fetchWithRetry(url, 3, 1500);
    if (!res) throw new Error('No response after retries');
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
    console.error('FRED M2 error:', e);
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
    console.error('FRED CAPE error:', e);
    return null;
  }
}

async function fetchCentralBanksFRED(): Promise<CentralBankData | null> {
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
    const fedCurrent = fedVals[fedVals.length - 1] / 1000;
    const fedPrev    = fedVals[fedVals.length - 53] / 1000;
    const ecbCurrent = ecbVals[ecbVals.length - 1] / 1000;
    const ecbPrev    = ecbVals[ecbVals.length - 53] / 1000;
    return { fedCurrent, fedPrev, ecbCurrent, ecbPrev, source: 'FRED WALCL+ECBASSETSW' };
  } catch (e) {
    console.error('Central banks FRED error:', e);
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
      if (!isNaN(spread) && spread > 0) return { spread: parseFloat(spread.toFixed(2)), source: 'FRED BAMLH0A0HYM2' };
    }
    return null;
  } catch (e) {
    console.error('FRED CreditSpread error:', e);
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
    console.error('FRED Breakeven error:', e);
    return null;
  }
}

// ── MANEJADOR PRINCIPAL ───────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let userTickers: string[] = [];
    try {
      const body = await req.json() as { tickers?: string[] };
      if (body && Array.isArray(body.tickers)) {
        userTickers = body.tickers.map((t: string) => t.trim()).filter((t: string) => t.length > 0);
      }
    } catch (e) {
      console.warn('Error parsing body or no tickers provided, using only macro tickers');
    }

    // FIX BUG-PROXY: combinar user tickers + MACRO + PROXY (sin duplicados)
    const allTickers: string[] = [...new Set([...userTickers, ...MACRO_TICKERS, ...PROXY_TICKERS])];
    console.log(`[Edge] Fetching ${allTickers.length} tickers (${userTickers.length} user + ${MACRO_TICKERS.length} macro + ${PROXY_TICKERS.length} proxy)`);

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

    yahooResults.forEach((result: PromiseSettledResult<ChartResult | null>, idx: number) => {
      const ticker = allTickers[idx];
      const cleanTicker = ticker.replace('%5E', '^');
      if (result.status === 'fulfilled' && result.value) {
        const chart = result.value;
        
        // ✅ VALIDACIÓN CRÍTICA: todas las series deben tener la misma longitud
        // Si no, Olympus fallará en minimumVarianceWeights
        const lengths = {
          timestamps: chart.timestamps.length,
          closes: chart.closes.length,
          highs: chart.highs.length,
          lows: chart.lows.length,
        };
        
        const allEqual = Object.values(lengths).every(len => len === lengths.timestamps);
        if (!allEqual) {
          console.error(`❌ ${cleanTicker} array mismatch (CRITICAL): ${JSON.stringify(lengths)} → SKIPPING`);
          errors.push(cleanTicker);
          return;
        }
        
        // ✅ WARNING: Si menos de 60 datos, DCC-GARCH usará fallback
        if (chart.closes.length < 60) {
          console.warn(`⚠️ ${cleanTicker} insufficient data (${chart.closes.length} < 60) → DCC-GARCH will use static covariance`);
        }
        
        data[cleanTicker] = chart;
      } else {
        errors.push(cleanTicker);
      }
    });

    // Log de diagnóstico — visible en Supabase Edge Function logs
    const proxyLengths = ['EEM','QUAL','GLD','URA','SMH','QQQ'].map(t =>
      `${t}:${data[t]?.closes?.length ?? '❌'}`
    ).join(' | ');
    console.log(`[Edge] ✅ Proxy closes lengths: ${proxyLengths}`);
    
    const macroLengths = ['VIX','TNX','GSPC','HYG','LQD'].map(t =>
      `${t}:${data[t]?.closes?.length ?? '❌'}`
    ).join(' | ');
    console.log(`[Edge] ✅ Macro closes lengths: ${macroLengths}`);
    
    console.log(`[Edge] 📊 Data points: ${Object.keys(data).length} successfully fetched, ${errors.length} errors`);
    if (errors.length > 0) {
      console.error(`[Edge] ❌ Failed tickers: ${errors.join(', ')}`);
    }
    
    // Log de suficiencia para DCC-GARCH
    const tickers60plus = Object.values(data).filter(d => d.closes.length >= 60).length;
    const tickersLess60 = Object.values(data).filter(d => d.closes.length < 60).length;
    console.log(`[Edge] 📈 DCC-GARCH ready: ${tickers60plus} tickers ≥60 datos, ${tickersLess60} tickers <60 (fallback a static)`)

    return new Response(JSON.stringify({
      data,
      errors,
      m2: m2Data,
      cape: capeData,
      centralBanks,
      creditSpread: creditSpreadData,
      breakeven: breakevenData,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Unhandled error:', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});