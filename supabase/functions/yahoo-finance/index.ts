// @ts-ignore — Deno types no están en el tsconfig del frontend
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const TICKERS = [
  // Portfolio real
  'BTC-EUR', 'EMXC.DE', 'IS3Q.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', 'ZPRR.DE',
  // Macro
  '%5EVIX', '%5ETNX', '%5EIRX',
  // Credit spread proxy (HY bond ETF — proxy del spread HY vs IG)
  'HYG',
  // S&P 500 — para RSI, momentum y PER proxy
  '%5EGSPC',
  // DXY — índice del dólar americano
  'DX-Y.NYB',
  // Proxies americanos para backtest histórico (10-24 años de datos)
  'EEM',   // EMXC.DE + IS3Q.DE → MSCI Emerging Markets
  'GLD',   // PPFB.DE → Oro físico
  'URA',   // URNU.DE → Uranio global
  'SMH',   // VVSM.DE → Semiconductores
  'VNQ',   // ZPRR.DE → REITs globales
];

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
// FRED es pública — no requiere API key para series básicas.
// M2SL = M2 Money Supply mensual en billones USD (Federal Reserve)
// Devolvemos los últimos 5 años como array [{date, value}]
interface M2DataPoint {
  date: string;   // "2024-01-01"
  value: number;  // M2 en billones USD
}

interface M2Result {
  current: number;
  growthYoY: number;
  history: M2DataPoint[];
}

interface CentralBankData {
  // Fed Balance Sheet (WALCL) — billones USD
  fedCurrent: number;
  fedPrev: number;      // hace 12 meses
  // ECB Assets (ECBASSETSW) — millones EUR → convertimos a billones
  ecbCurrent: number;
  ecbPrev: number;
  source: string;
}

// ── FRED Shiller CAPE (PER S&P 500 ajustado al ciclo) ────────────────────────
async function fetchCAPEFRED(): Promise<{ cape: number; source: string } | null> {
  try {
    // CAPE = Cyclically Adjusted Price-Earnings ratio (Shiller)
    // Serie FRED: CAPE (mensual, ~1881 en adelante)
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CAPE';
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1);
    // Last non-empty line
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
    // FRED CSV público — sin API key necesaria
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) {
      console.error(`FRED M2 fetch failed: ${res.status}`);
      return null;
    }

    const text = await res.text();
    const lines = text.trim().split('\n').slice(1); // skip header

    const allPoints: M2DataPoint[] = [];
    for (const line of lines) {
      const [date, val] = line.split(',');
      const value = parseFloat(val);
      if (date && !isNaN(value) && value > 0) {
        allPoints.push({ date: date.trim(), value });
      }
    }

    if (allPoints.length < 13) return null;

    // Últimos 5 años (60 meses)
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

// ── FRED Central Bank Balance Sheets ─────────────────────────────────────────
// WALCL    = Fed total assets (weekly, billones USD)
// ECBASSETSW = ECB total assets (weekly, millones EUR)
// BoJ no tiene serie FRED pública fácil — omitimos y normalizamos Fed+ECB
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

    // Fed en billones USD (WALCL es en millones → dividir por 1000)
    const fedCurrent = fedVals[fedVals.length - 1] / 1000;
    const fedPrev    = fedVals[fedVals.length - 53] / 1000; // ~12 meses atrás (semanal)

    // ECB en billones EUR (ECBASSETSW en millones → dividir por 1000)
    const ecbCurrent = ecbVals[ecbVals.length - 1] / 1000;
    const ecbPrev    = ecbVals[ecbVals.length - 53] / 1000;

    return { fedCurrent, fedPrev, ecbCurrent, ecbPrev, source: 'FRED WALCL+ECBASSETSW' };
  } catch (e) {
    console.error('Central banks FRED error:', e);
    return null;
  }
}

// @ts-ignore — Deno global disponible en el runtime de Supabase Edge Functions
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Fetch Yahoo + FRED en paralelo (M2 + CAPE + bancos centrales)
    const [yahooResults, m2Data, capeData, centralBanks] = await Promise.all([
      Promise.allSettled(TICKERS.map(fetchTicker)),
      fetchM2FRED(),
      fetchCAPEFRED(),
      fetchCentralBanksFRED(),
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

    return new Response(JSON.stringify({ data, errors, m2: m2Data, cape: capeData, centralBanks }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});