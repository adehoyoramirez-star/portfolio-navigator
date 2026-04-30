// @ts-ignore — Deno types no están en el tsconfig del frontend
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};//   La función Supabase solo fetcha los tickers de esta lista.
//   Si un activo no está aquí → su precio nunca se recupera de Yahoo Finance
//   → marketData.prices[
//   estático del portfolio.ts (o 0 si no existe) → el precio nunca actualiza.
const TICKERS = [
  // ── Portfolio real ────────────────────────────────────────────────────────
  'BTC-EUR', 'EMXC.DE', 'IS3Q.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', 'XNAS.DE',
  // ── Macro — tiempo real ───────────────────────────────────────────────────
  '%5EVIX', '%5ETNX', '%5EIRX',
  // MOVE Index — volatilidad bonos USA (CBOE)
  '%5EMOVE',
  // Credit spread proxy (HY bond ETF — spread HY vs IG)
  'HYG',
  // Investment Grade ETF — para calcular spread HY-IG real
  'LQD',
  // S&P 500 — para RSI, momentum y PER proxy
  '%5EGSPC',
  // DXY — índice del dólar americano
  'DX-Y.NYB',
  // Brent Crude Oil — geopolitical shock detector (referente europeo/global)
  'BZ=F',
  // ── Proxies americanos para backtest histórico (10-24 años de datos) ──────
  'EEM',   // EMXC.DE → MSCI Emerging Markets
  'GLD',   // PPFB.DE → Oro físico
  'URA',   // URNU.DE → Uranio global
  'SMH',   // VVSM.DE → Semiconductores
  'QQQ',   // XNAS.DE → Nasdaq-100];

interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
}

async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    // 5y en lugar de 2y — da ~1250 días hábiles para backtest estadísticamente válido
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      console.error(`Failed to fetch ${ticker}: ${res.status}`);
      return null;
    }
    const json = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp || [];
    const closes: number[] = result.indicators?.quote?.[0]?.close || [];
    const currentPrice = result.meta?.regularMarketPrice ?? closes[closes.length - 1] ?? 0;

    const cleanTicker = ticker.replace('%5E', '^');
    return { ticker: cleanTicker, currentPrice, timestamps, closes };
  } catch (e) {
    console.error(`Error fetching ${ticker}:`, e);
    return null;
  }
}

// ── FRED M2 ──────────────────────────────────────────────────────────────────
interface M2DataPoint {
  date: string;
  value: number;
}

interface M2Result {
  current: number;
  growthYoY: number;
  history: M2DataPoint[];
}

interface CentralBankData {
  fedCurrent: number;
  fedPrev: number;
  ecbCurrent: number;
  ecbPrev: number;
  source: string;
}

async function fetchCAPEFRED(): Promise<{ cape: number; source: string } | null> {
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const [, val] = lines[i].split(',');
      const cape = parseFloat(val);
      if (!isNaN(cape) && cape > 0) {
        return { cape, source: 'FRED CAPE' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchM2FRED(): Promise<M2Result | null> {
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.error(`FRED M2 fetch failed: ${res.status}`);
      return null;
    }

    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);

    const allPoints: M2DataPoint[] = [];
    for (const line of lines) {
      const [date, val] = line.split(',');
      const value = parseFloat(val);
      if (date && !isNaN(value) && value > 0) {
        allPoints.push({ date: date.trim(), value });
      }
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

async function fetchCentralBanksFRED(): Promise<CentralBankData | null> {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
      fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    ]);

    const parseFREDcsv = async (res: Response): Promise<number[]> => {
      if (!res.ok) return [];
      const text = await res.text();
      const lines = text.trim().split('\n').slice(1);
      const values: number[] = [];
      for (const line of lines) {
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
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.error(`FRED CreditSpread fetch failed: ${res.status}`);
      return null;
    }
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const [, val] = lines[i].split(',');
      const spread = parseFloat(val);
      if (!isNaN(spread) && spread > 0) {
        return { spread: parseFloat(spread.toFixed(2)), source: 'FRED BAMLH0A0HYM2' };
      }
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
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const [, val] = lines[i].split(',');
      const v = parseFloat(val);
      if (!isNaN(v) && v > 0) {
        return { value: parseFloat(v.toFixed(2)), source: 'FRED T5YIFR' };
      }
    }
    return null;
  } catch (e) {
    console.error('FRED Breakeven error:', e);
    return null;
  }
}

// @ts-ignore — Deno global disponible en el runtime de Supabase Edge Functions
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const [yahooResults, m2Data, capeData, centralBanks, creditSpreadData, breakevenData] = await Promise.all([
      Promise.allSettled(TICKERS.map(fetchTicker)),
      fetchM2FRED(),
      fetchCAPEFRED(),
      fetchCentralBanksFRED(),
      fetchCreditSpreadFRED(),
      fetchBreakevenFRED(),
    ]);

    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];

    yahooResults.forEach((r, i) => {
      const cleanTicker = TICKERS[i].replace('%5E', '^');
      if (r.status === 'fulfilled' && r.value) {
        data[cleanTicker] = r.value;
      } else {
        errors.push(cleanTicker);
      }
    });

    return new Response(JSON.stringify({ data, errors, m2: m2Data, cape: capeData, centralBanks, creditSpread: creditSpreadData, breakeven: breakevenData }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
