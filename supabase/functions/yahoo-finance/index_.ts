// @ts-ignore — Deno types no están en el tsconfig del frontend
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
/// <reference types="https://deno.land/x/types/deno.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, ' +
    'x-supabase-client-platform, x-supabase-client-platform-version, ' +
    'x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ═══════════════════════════════════════════════════════════════════
// TICKERS MACROECONÓMICOS — siempre incluidos
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// PROXIES AMERICANOS — necesarios para backtestEngine y stressScenarios
// PROXY_MAP (backtestEngine): EMXC.DE→EEM, IS3Q.DE→QUAL, PPFB.DE→GLD,
//                              URNU.DE→URA, VVSM.DE→SMH, XNAS.DE→QQQ
// PROXY_MAP (stressScenarios): IS3Q.DE→EEM
// ═══════════════════════════════════════════════════════════════════
const PROXY_TICKERS: string[] = [
  'EEM',  // Emerging Markets proxy (EMXC.DE + IS3Q.DE en stress)
  'QUAL', // MSCI USA Quality proxy (IS3Q.DE en backtest)
  'GLD',  // Gold proxy (PPFB.DE)
  'URA',  // Uranium proxy (URNU.DE)
  'SMH',  // Semiconductors proxy (VVSM.DE)
  'QQQ',  // NASDAQ 100 proxy (XNAS.DE)
  'SPY',  // S&P 500 benchmark alternativo para backtest
];

// ═══════════════════════════════════════════════════════════════════
// INTERFAZ ChartResult — MEJORADA con dataPoints e isSufficient
// dataPoints  → número real de barras descargadas
// isSufficient → true si ≥60 barras (DCC-GARCH dinámico); false → covarianza estática
// ═══════════════════════════════════════════════════════════════════
interface ChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];      // Necesario para ATR del Motor Táctico
  lows: number[];       // Necesario para ATR del Motor Táctico
  dataPoints: number;   // Barras reales sincronizadas
  isSufficient: boolean; // ≥60 → DCC-GARCH dinámico; <60 → covarianza estática
}

// ═══════════════════════════════════════════════════════════════════
// FIX CRÍTICO #1: fetchTicker con rango 6y, sincronización minLen
//                 y población de dataPoints / isSufficient
// ═══════════════════════════════════════════════════════════════════
async function fetchTicker(ticker: string): Promise<ChartResult | null> {
  try {
    // CAMBIO CLAVE: range=6y para cubrir COVID 2020, Taper 2022, rally 2023-24
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6y&interval=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!res.ok) {
      console.error(`[fetchTicker] ❌ ${ticker} HTTP ${res.status}`);
      return null;
    }

    const json: any = await res.json();
    const result = json.chart?.result?.[0];
    if (!result) {
      console.error(`[fetchTicker] ❌ ${ticker} — sin result en chart`);
      return null;
    }

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const closes: number[] = quote.close || [];
    const highs:  number[] = quote.high  || [];
    const lows:   number[] = quote.low   || [];

    // ═══════════════════════════════════════════════════════════════
    // FIX CRÍTICO #2: Limpiar nulls y valores inválidos
    // Yahoo devuelve null en medio del array para sesiones sin datos
    // ═══════════════════════════════════════════════════════════════
    const clean = (arr: number[]): number[] =>
      arr.map(v => (v == null || !isFinite(v)) ? 0 : v);

    // ═══════════════════════════════════════════════════════════════
    // FIX CRÍTICO #3: Sincronización de arrays con minLen
    // Previene "dimensión n no coincide con covMatrix → fallback" en Olympus
    // ═══════════════════════════════════════════════════════════════
    const minLen = Math.min(
      timestamps.length,
      closes.length,
      highs.length,
      lows.length,
    );

    if (minLen < timestamps.length) {
      console.warn(
        `⚠️ ${ticker} misalignment: timestamps=${timestamps.length}, ` +
        `closes=${closes.length}, highs=${highs.length}, lows=${lows.length} ` +
        `→ usando minLen=${minLen}`
      );
    }

    const currentPrice =
      result.meta?.regularMarketPrice ??
      clean(closes)[closes.length - 1] ??
      0;

    const cleanTicker = ticker.replace('%5E', '^');

    return {
      ticker:       cleanTicker,
      currentPrice,
      timestamps:   timestamps.slice(0, minLen),
      closes:       clean(closes).slice(0, minLen),
      highs:        clean(highs).slice(0, minLen),
      lows:         clean(lows).slice(0, minLen),
      dataPoints:   minLen,
      isSufficient: minLen >= 60,
    };
  } catch (e) {
    console.error(`[fetchTicker] ❌ ${ticker} exception:`, e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// HELPER: fetch con reintentos y timeout de 15s
// ═══════════════════════════════════════════════════════════════════
async function fetchWithRetry(
  url: string,
  retries = 3,
  delayMs = 1000,
): Promise<Response | null> {
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
      console.warn(`Attempt ${attempt} for ${url} → HTTP ${res.status}`);
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

// ═══════════════════════════════════════════════════════════════════
// FRED — M2 Supply
// ═══════════════════════════════════════════════════════════════════
interface M2DataPoint { date: string; value: number; }
interface M2Result { current: number; growthYoY: number; history: M2DataPoint[]; }
interface CentralBankData {
  fedCurrent: number; fedPrev: number;
  ecbCurrent: number; ecbPrev: number;
  source: string;
}

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
    const history  = allPoints.slice(-60);
    const current  = history[history.length - 1].value;
    const yearAgo  = history[history.length - 13]?.value ?? current;
    const growthYoY = yearAgo > 0 ? ((current - yearAgo) / yearAgo) * 100 : 0;
    return { current, growthYoY, history };
  } catch (e) {
    console.error('FRED M2 error:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FRED — CAPE (Shiller P/E)
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// FRED — Balance sheets Fed + ECB
// ═══════════════════════════════════════════════════════════════════
async function fetchCentralBanksFRED(): Promise<CentralBankData | null> {
  try {
    const [fedRes, ecbRes] = await Promise.all([
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL', 3, 1500),
      fetchWithRetry('https://fred.stlouisfed.org/graph/fredgraph.csv?id=ECBASSETSW', 3, 1500),
    ]);
    const parseFREDcsv = async (res: Response | null): Promise<number[]> => {
      if (!res) return [];
      const text  = await res.text();
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
      fedCurrent: fedVals[fedVals.length - 1]  / 1000,
      fedPrev:    fedVals[fedVals.length - 53] / 1000,
      ecbCurrent: ecbVals[ecbVals.length - 1]  / 1000,
      ecbPrev:    ecbVals[ecbVals.length - 53] / 1000,
      source:     'FRED WALCL+ECBASSETSW',
    };
  } catch (e) {
    console.error('Central banks FRED error:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FRED — Credit spread OAS (BAMLH0A0HYM2)
// ═══════════════════════════════════════════════════════════════════
async function fetchCreditSpreadFRED(): Promise<{ spread: number; source: string } | null> {
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2';
    const res = await fetchWithRetry(url, 3, 1500);
    if (!res) return null;
    const text  = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [, val] = line.split(',');
      const spread = parseFloat(val);
      if (!isNaN(spread) && spread > 0)
        return { spread: parseFloat(spread.toFixed(2)), source: 'FRED BAMLH0A0HYM2' };
    }
    return null;
  } catch (e) {
    console.error('FRED CreditSpread error:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FRED — Breakeven inflation 5Y5Y forward (T5YIFR)
// ═══════════════════════════════════════════════════════════════════
async function fetchBreakevenFRED(): Promise<{ value: number; source: string } | null> {
  try {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=T5YIFR';
    const res = await fetchWithRetry(url, 3, 1500);
    if (!res) return null;
    const text  = await res.text();
    const lines = text.trim().split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const [, val] = line.split(',');
      const v = parseFloat(val);
      if (!isNaN(v) && v > 0)
        return { value: parseFloat(v.toFixed(2)), source: 'FRED T5YIFR' };
    }
    return null;
  } catch (e) {
    console.error('FRED Breakeven error:', e);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MANEJADOR PRINCIPAL
// ═══════════════════════════════════════════════════════════════════
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Parsear tickers del body ──────────────────────────────────
    let userTickers: string[] = [];
    try {
      const body = await req.json() as { tickers?: string[] };
      if (body && Array.isArray(body.tickers)) {
        userTickers = body.tickers
          .map((t: string) => t.trim())
          .filter((t: string) => t.length > 0);
      }
    } catch (_e) {
      console.warn('[Edge] No body / sin tickers — usando sólo macro+proxy');
    }

    // ── Combinar sin duplicados ───────────────────────────────────
    const allTickers: string[] = [
      ...new Set([...userTickers, ...MACRO_TICKERS, ...PROXY_TICKERS]),
    ];

    console.log(
      `[Edge] 🚀 Fetching ${allTickers.length} tickers ` +
      `(${userTickers.length} user + ${MACRO_TICKERS.length} macro + ${PROXY_TICKERS.length} proxy)`
    );

    // ── Fetch paralelo Yahoo + FRED ───────────────────────────────
    const [
      yahooResults,
      m2Data,
      capeData,
      centralBanks,
      creditSpreadData,
      breakevenData,
    ] = await Promise.all([
      Promise.allSettled(allTickers.map((ticker: string) => fetchTicker(ticker))),
      fetchM2FRED(),
      fetchCAPEFRED(),
      fetchCentralBanksFRED(),
      fetchCreditSpreadFRED(),
      fetchBreakevenFRED(),
    ]);

    // ── Procesar resultados ───────────────────────────────────────
    const data: Record<string, ChartResult> = {};
    const errors: string[] = [];
    let sufficiencyCount = 0;

    yahooResults.forEach(
      (result: PromiseSettledResult<ChartResult | null>, idx: number) => {
        const ticker      = allTickers[idx];
        const cleanTicker = ticker.replace('%5E', '^');

        if (result.status === 'fulfilled' && result.value) {
          const chart = result.value;

          // ═══════════════════════════════════════════════════════
          // FIX CRÍTICO #4: Validación de integridad de arrays
          // Si pasan arrays desalineados, Olympus falla en
          // minimumVarianceWeights con "dimensión n no coincide"
          // ═══════════════════════════════════════════════════════
          const lengths = {
            timestamps: chart.timestamps.length,
            closes:     chart.closes.length,
            highs:      chart.highs.length,
            lows:       chart.lows.length,
          };

          const allEqual = Object.values(lengths).every(
            len => len === lengths.timestamps,
          );

          if (!allEqual) {
            console.error(
              `❌ ${cleanTicker} array mismatch (CRITICAL): ` +
              `${JSON.stringify(lengths)} → SKIPPING`
            );
            errors.push(cleanTicker);
            return;
          }

          // ═══════════════════════════════════════════════════════
          // Registrar suficiencia para DCC-GARCH
          // ═══════════════════════════════════════════════════════
          if (chart.isSufficient) {
            sufficiencyCount++;
          } else {
            console.warn(
              `⚠️ ${cleanTicker} insuficiente (${chart.dataPoints} < 60) ` +
              `→ DCC-GARCH usará covarianza estática`
            );
          }

          data[cleanTicker] = chart;
        } else {
          errors.push(cleanTicker);
        }
      }
    );

    // ── Logging detallado para diagnóstico en Supabase logs ───────
    const proxyLog = ['EEM', 'QUAL', 'GLD', 'URA', 'SMH', 'QQQ', 'SPY']
      .map(t => `${t}:${data[t]?.dataPoints ?? '❌'}`)
      .join(' | ');
    console.log(`[Edge] 📊 Proxy data points: ${proxyLog}`);

    const macroLog = ['^VIX', '^TNX', '^GSPC', 'HYG', 'LQD']
      .map(t => `${t.replace('^','')}:${data[t]?.dataPoints ?? '❌'}`)
      .join(' | ');
    console.log(`[Edge] 📈 Macro data points: ${macroLog}`);

    const totalOk  = Object.keys(data).length;
    const totalErr = errors.length;
    console.log(
      `[Edge] ✅ Data integrity: ${totalOk} tickers loaded${totalErr > 0 ? `, ${totalErr} failed` : ' successfully'}`
    );
    if (totalErr > 0) {
      console.error(`[Edge] ❌ Failed tickers: ${errors.join(', ')}`);
    }

    const staticCount = totalOk - sufficiencyCount;
    console.log(
      `[Edge] 📈 DCC-GARCH readiness: ${sufficiencyCount} tickers ≥60 datos (dynamic), ` +
      `${staticCount} ticker${staticCount !== 1 ? 's' : ''} <60 (static covariance)`
    );

    // ── Estadísticas de cobertura ─────────────────────────────────
    const allPoints = Object.values(data).map(d => d.dataPoints);
    const minDP  = allPoints.length ? Math.min(...allPoints) : 0;
    const maxDP  = allPoints.length ? Math.max(...allPoints) : 0;
    const avgDP  = allPoints.length
      ? Math.round(allPoints.reduce((a, b) => a + b, 0) / allPoints.length)
      : 0;
    console.log(
      `[Edge] 📊 Data coverage: min=${minDP}, avg=${avgDP}, max=${maxDP}`
    );

    // ── Construir metadata para el frontend ───────────────────────
    const metadata = {
      timestamp:         new Date().toISOString(),
      range:             '6y',
      tickersRequested:  allTickers.length,
      tickersSuccessful: totalOk,
      tickersFailed:     totalErr,
      sufficiencyStats: {
        dccReady:        sufficiencyCount,
        staticCovariance: staticCount,
      },
      minDataPoints:  minDP,
      avgDataPoints:  avgDP,
      maxDataPoints:  maxDP,
    };

    // ── Respuesta final ───────────────────────────────────────────
    return new Response(
      JSON.stringify({
        data,
        errors,
        m2:           m2Data,
        cape:         capeData,
        centralBanks,
        creditSpread: creditSpreadData,
        breakeven:    breakevenData,
        metadata,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[Edge] ❌ Unhandled error:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
