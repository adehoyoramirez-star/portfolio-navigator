import { supabase } from '@/integrations/supabase/client';
import { ASSETS } from '@/lib/constants';
import type { CEWSDataPoint } from '@/core/macro/crisisEarlyWarning';
import { globalLiquiditySignal, fromManualInputs } from '@/core/macro/liquidityCycle';

interface YahooChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
}

interface YahooResponse {
  data: Record<string, YahooChartResult>;
  errors: string[];
  m2?: {
    current: number;
    growthYoY: number;
    history: { date: string; value: number }[];
  };
  cape?: { cape: number; source: string } | null;
  centralBanks?: {
    fedCurrent: number; fedPrev: number;
    ecbCurrent: number; ecbPrev: number;
    source: string;
  } | null;
}

// Tipo completo que devuelve fetchRealMarketData — incluye todo lo que el dashboard necesita
export interface MarketData {
  // Precios actuales por ticker
  prices: Record<string, number>;
  // Macro
  vix: number;
  tnx: number;   // bono 10y USA %
  irx: number;   // bono 2y / fed funds %
  // BTC indicadores técnicos calculados desde histórico real
  btcZScore: number;
  btcRsi: number;
  // VIX percentiles para contexto histórico
  vixPercentile80: number;
  vixPercentile20: number;
  // Retornos esperados anualizados por activo (orden = ASSETS)
  expectedReturns: number[];
  // Retornos históricos por períodos por activo (orden = ASSETS)
  returns12m: number[];
  returns3m: number[];
  returns1m: number[];
  // Volatilidades realizadas anualizadas por activo (orden = ASSETS)
  realizedVols: number[];
  // Historial de precios de cierre limpio por ticker (para correlaciones y RSI)
  closesHistory: Record<string, number[]>;
  // Matriz de covarianza anualizada (orden = ASSETS)
  covMatrix: number[][];
  // CEWS: serie semanal automática (5 años) construida desde históricos de Yahoo
  cewsHistory: CEWSDataPoint[];
  // M2 real de FRED (growthYoY en %) — 0 si FRED no disponible
  m2Growth: number;
  m2GrowthSource: "FRED" | "manual";
  // S&P 500 indicadores calculados desde histórico real
  sp500Rsi: number;          // RSI 14 días
  sp500Momentum12m: number;  // retorno últimos 12m (menos 1m)
  sp500Momentum3m: number;   // retorno últimos 3m
  dxy: number;               // índice del dólar (DX-Y.NYB)
  // PER S&P 500 — Shiller CAPE de FRED
  per: number;
  perSource: "FRED" | "manual";
  // BTC vol realizada anualizada (calculada desde histórico)
  btcVolRealized: number;
  // Jump parameters calibrados desde histórico BTC
  jumpIntensity: number;   // frecuencia de saltos por año
  jumpMean: number;        // tamaño medio del salto
  jumpStd: number;         // dispersión del salto
  // Liquidez global calculada automáticamente
  liquidityScore: number;
  liquidityDataQuality: "REAL" | "MANUAL";
}

function cleanCloses(closes: number[]): number[] {
  // Remove nulls/NaN and forward-fill
  const clean: number[] = [];
  let last = 0;
  for (const c of closes) {
    if (c != null && isFinite(c)) {
      last = c;
    }
    clean.push(last);
  }
  return clean;
}

function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      r.push(closes[i] / closes[i - 1] - 1);
    }
  }
  return r;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function covarianceMatrix(returnsSeries: number[][]): number[][] {
  const n = returnsSeries.length;
  // Find minimum length
  const minLen = Math.min(...returnsSeries.map(r => r.length));
  // Trim all to same length (from the end, most recent)
  const trimmed = returnsSeries.map(r => r.slice(r.length - minLen));
  const means = trimmed.map(mean);

  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let k = 0; k < minLen; k++) {
        s += (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]);
      }
      const c = s / (minLen - 1);
      cov[i][j] = c * 252; // annualize
      cov[j][i] = c * 252;
    }
  }
  return cov;
}


// ── CEWS HISTORY BUILDER ────────────────────────────────────────────────────
// Construye serie semanal de 5 años desde los históricos diarios de Yahoo.
// Señales:
//   vix          → ^VIX closes directamente
//   yieldSpread  → ^TNX - ^IRX (10y minus 13-week T-bill, proxy de la yield curve)
//   creditSpread → HYG z-score convertido a spread proxy (no requiere datos de FRED)
//   m2Growth     → manual (M2 cambia mensualmente; se pasa como parámetro constante)
//
// HYG Credit Spread Proxy:
//   HYG es el ETF de bonos HY más líquido del mundo. Su precio refleja
//   directamente el estrés crediticio: cuando cae vs su MA200, los spreads se amplían.
//   Fórmula: spread = 3.5% + (-z_score × 1.5%) con floor 1.0% y cap 9.0%
//   Calibración histórica:
//     z = +1.5 (expansión fuerte) → spread ≈ 1.25%
//     z =  0   (neutral)         → spread ≈ 3.5%
//     z = -2   (estrés)          → spread ≈ 6.5%
//     z = -3.5 (crisis tipo 2020)→ spread ≈ 8.75%
function buildCEWSHistory(
  vixCloses: number[],
  vixTimestamps: number[],
  tnxCloses: number[],
  irxCloses: number[],
  hygCloses: number[],
  lastM2Growth: number,   // último valor manual de M2 — se repite para toda la serie
): CEWSDataPoint[] {
  const n = Math.min(vixCloses.length, tnxCloses.length, irxCloses.length, hygCloses.length);
  if (n < 10) return [];

  // Precomputar HYG MA200 para z-score
  const HYG_WINDOW = 200;
  function hygZScore(i: number): number {
    const start = Math.max(0, i - HYG_WINDOW + 1);
    const window = hygCloses.slice(start, i + 1);
    if (window.length < 20) return 0;
    const m = window.reduce((a, b) => a + b, 0) / window.length;
    const s = Math.sqrt(window.reduce((acc, v) => acc + (v - m) ** 2, 0) / window.length);
    return s > 0 ? (hygCloses[i] - m) / s : 0;
  }

  // Muestrear cada 5 días hábiles (≈ 1 semana)
  const STEP = 5;
  const points: CEWSDataPoint[] = [];

  for (let i = HYG_WINDOW; i < n; i += STEP) {
    const vix = vixCloses[i];
    const tnx = tnxCloses[i];
    const irx = irxCloses[i];
    const hygZ = hygZScore(i);

    if (!vix || !tnx || !irx) continue;

    const yieldSpread = tnx - irx;                              // 10y - 13w (proxy yield curve)
    const creditSpread = Math.max(1.0, Math.min(9.0, 3.5 + (-hygZ * 1.5))); // HYG proxy

    const ts = vixTimestamps[i] ? new Date(vixTimestamps[i] * 1000).toISOString()
      : new Date(Date.now() - (n - i) * 24 * 3600 * 1000).toISOString();

    points.push({
      timestamp: ts,
      vix,
      yieldSpread,
      creditSpread,
      m2Growth: lastM2Growth,
    });
  }

  return points;
}

// Generic RSI-14 from a closes array
function calculateRSI14(closes: number[]): number {
  if (closes.length < 15) return 50;
  const returns = dailyReturns(closes.slice(-15));
  const gains  = returns.filter(r => r > 0).reduce((a, b) => a + b, 0) / 14;
  const losses = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0)) / 14;
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - (100 / (1 + rs));
}

// Jump parameters: calibrate from historical daily returns
// Returns annualized intensity, mean jump size, std of jumps
function calibrateJumps(dailyRets: number[]): { intensity: number; mean: number; stdDev: number } {
  if (dailyRets.length < 60) return { intensity: 0.15, mean: -0.12, stdDev: 0.05 };
  const threshold = 0.04; // moves > 4% in a day = jump
  const jumps = dailyRets.filter(r => Math.abs(r) > threshold);
  const intensity = (jumps.length / dailyRets.length) * 252; // annualized
  const jumpMean  = jumps.length > 0 ? jumps.reduce((a, b) => a + b, 0) / jumps.length : -0.05;
  const jumpStdDev = jumps.length > 1
    ? Math.sqrt(jumps.reduce((s, v) => s + (v - jumpMean) ** 2, 0) / (jumps.length - 1))
    : 0.05;
  return {
    intensity: Math.max(0.05, Math.min(3.0, intensity)),
    mean:      Math.max(-0.30, Math.min(0.10, jumpMean)),
    stdDev:    Math.max(0.02, Math.min(0.20, jumpStdDev)),
  };
}

export async function fetchRealMarketData(): Promise<{ marketData: MarketData; fetchErrors: string[] }> {
  const { data: response, error } = await supabase.functions.invoke<YahooResponse>('yahoo-finance');

  if (error || !response) {
    throw new Error(`Failed to fetch market data: ${error?.message || 'No response'}`);
  }

  const { data: yfData, errors: fetchErrors, m2: fredM2, cape: fredCAPE, centralBanks } = response;

  // M2 real de FRED
  const m2Growth = fredM2?.growthYoY ?? 5.2;

  // Shiller CAPE (PER ajustado al ciclo)
  const per = fredCAPE?.cape ?? 29.5;
  const perSource: "FRED" | "manual" = fredCAPE ? "FRED" : "manual";

  // ====== PRECIOS ACTUALES ======
  const prices: Record<string, number> = {};
  for (const ticker of ASSETS) {
    const d = yfData[ticker];
    prices[ticker] = d?.currentPrice ?? 0;
  }

  // ====== MACRO ======
  const vixData = yfData['^VIX'];
  const vixPrice = vixData?.currentPrice ?? 18;
  const vixCloses = vixData ? cleanCloses(vixData.closes) : [];
  const vixTimestamps = vixData?.timestamps ?? [];
  const vixP80 = vixCloses.length > 50 ? percentile(vixCloses, 80) : 28;
  const vixP20 = vixCloses.length > 50 ? percentile(vixCloses, 20) : 14;
  const tnxPrice = yfData['^TNX']?.currentPrice ?? 4.25;
  const irxPrice = yfData['^IRX']?.currentPrice ?? 3.80;
  const tnxCloses = yfData['^TNX'] ? cleanCloses(yfData['^TNX'].closes) : [];
  const irxCloses = yfData['^IRX'] ? cleanCloses(yfData['^IRX'].closes) : [];
  const hygCloses = yfData['HYG'] ? cleanCloses(yfData['HYG'].closes) : [];

  // ====== HISTÓRICO DE CIERRES LIMPIO POR ACTIVO ======
  const closesHistory: Record<string, number[]> = {};
  for (const ticker of ASSETS) {
    const d = yfData[ticker];
    closesHistory[ticker] = d ? cleanCloses(d.closes) : [];
  }

  // ====== RETORNOS DIARIOS POR ACTIVO ======
  const returnsPerAsset = ASSETS.map(ticker => dailyReturns(closesHistory[ticker]));

  // ====== BTC INDICADORES TÉCNICOS (desde histórico real, no mock) ======
  const btcCloses = closesHistory['BTC-EUR'];

  // Z-Score 200 días
  let btcZScore = 0;
  const last200 = btcCloses.slice(-200);
  if (last200.length >= 200) {
    const m = mean(last200);
    const s = std(last200);
    btcZScore = s > 0 ? ((yfData['BTC-EUR']?.currentPrice ?? last200[last200.length - 1]) - m) / s : 0;
  }

  // BTC RSI-14 (usando helper genérico)
  const btcRsi = calculateRSI14(cleanCloses(yfData['BTC-EUR']?.closes ?? []));

  // BTC vol realizada anualizada
  const btcReturnsForVol = dailyReturns(cleanCloses(yfData['BTC-EUR']?.closes ?? []));
  const btcVolRealized = btcReturnsForVol.length > 20
    ? Math.sqrt(btcReturnsForVol.reduce((s, r) => { const m = 0; return s + (r - m) ** 2; }, 0)
        / btcReturnsForVol.length * 252)
    : 0.60;

  // Jump parameters calibrados desde histórico BTC
  const jumpParams = calibrateJumps(btcReturnsForVol);

  // ── S&P 500 ────────────────────────────────────────────────────────────────
  const sp500Closes = cleanCloses(yfData['^GSPC']?.closes ?? []);
  const sp500Rsi = calculateRSI14(sp500Closes);
  const sp500Returns = dailyReturns(sp500Closes);

  // S&P 500 momentum: retorno 12m (excluyendo último mes = Jegadeesh-Titman)
  const sp500_12m_start = sp500Closes[sp500Closes.length - 252 - 1];
  const sp500_1m_start  = sp500Closes[sp500Closes.length - 21 - 1];
  const sp500_3m_start  = sp500Closes[sp500Closes.length - 63 - 1];
  const sp500Last       = sp500Closes[sp500Closes.length - 1];
  const sp500Momentum12m = sp500_12m_start > 0 && sp500_1m_start > 0
    ? (sp500_1m_start / sp500_12m_start) - 1   // 12m excluyendo último mes
    : 0.15;
  const sp500Momentum3m = sp500_3m_start > 0
    ? (sp500Last / sp500_3m_start) - 1
    : 0.05;

  // ── DXY ───────────────────────────────────────────────────────────────────
  const dxy = yfData['DX-Y.NYB']?.currentPrice ?? 103.5;

  // ── Liquidez Global REAL (bancos centrales desde FRED) ──────────────────────
  const liquidityOutput = centralBanks
    ? globalLiquiditySignal({
        fedBalance:    centralBanks.fedCurrent,
        prevFedBalance: centralBanks.fedPrev,
        ecbBalance:    centralBanks.ecbCurrent,
        prevEcbBalance: centralBanks.ecbPrev,
        bojBalance:    1,   // BoJ no disponible — ignorado en ponderación
        prevBojBalance: 1,
        dxy,
        prevDxy: undefined,
      })
    : fromManualInputs({ liquidityGrowth: m2Growth, dxy });

  const liquidityScoreAuto = Math.max(0, Math.min(1,
    (liquidityOutput.liquidityGrowth / 10) * 0.6 +
    Math.max(0, (30 - vixPrice) / 30) * 0.4
  ));

  void sp500Returns; // reservado para futuros cálculos

  // ====== RETORNOS POR PERÍODO (12m, 3m, 1m) ======
  // Aproximación: 252 días hábiles/año, 63 días/trimestre, 21 días/mes
  const DAYS_12M = 252;
  const DAYS_3M  = 63;
  const DAYS_1M  = 21;

  const returns12m = ASSETS.map(ticker => {
    const closes = closesHistory[ticker];
    if (closes.length < DAYS_12M + 1) return 0;
    const start = closes[closes.length - DAYS_12M - 1];
    const end   = closes[closes.length - 1];
    return start > 0 ? (end / start) - 1 : 0;
  });

  const returns3m = ASSETS.map(ticker => {
    const closes = closesHistory[ticker];
    if (closes.length < DAYS_3M + 1) return 0;
    const start = closes[closes.length - DAYS_3M - 1];
    const end   = closes[closes.length - 1];
    return start > 0 ? (end / start) - 1 : 0;
  });

  const returns1m = ASSETS.map(ticker => {
    const closes = closesHistory[ticker];
    if (closes.length < DAYS_1M + 1) return 0;
    const start = closes[closes.length - DAYS_1M - 1];
    const end   = closes[closes.length - 1];
    return start > 0 ? (end / start) - 1 : 0;
  });

  // ====== EXPECTED RETURNS (media aritmética anualizada) ======
  const expectedReturns = returnsPerAsset.map(r => {
    if (r.length < 20) return 0.05;
    return mean(r) * 252;
  });

  // ====== VOLATILIDADES REALIZADAS ANUALIZADAS ======
  const realizedVols = returnsPerAsset.map(r => {
    if (r.length < 20) return 0.25; // fallback razonable
    const m = mean(r);
    const variance = r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1);
    return Math.sqrt(variance * 252);
  });

  // ====== MATRIZ DE COVARIANZA ======
  const covMatrix = returnsPerAsset.some(r => r.length < 20)
    ? fallbackCovMatrix()
    : covarianceMatrix(returnsPerAsset);

  // ====== CEWS HISTORY AUTOMÁTICO (5 años semanal desde Yahoo) ======
  const cewsHistory = buildCEWSHistory(
    vixCloses, vixTimestamps, tnxCloses, irxCloses, hygCloses, m2Growth
  );

  return {
    marketData: {
      prices,
      vix: vixPrice,
      tnx: tnxPrice,
      irx: irxPrice,
      btcZScore,
      btcRsi,
      vixPercentile80: vixP80,
      vixPercentile20: vixP20,
      expectedReturns,
      returns12m,
      returns3m,
      returns1m,
      realizedVols,
      closesHistory,
      covMatrix,
      cewsHistory,
      m2Growth,
      m2GrowthSource: fredM2 ? "FRED" : "manual",
      per,
      perSource,
      sp500Rsi,
      sp500Momentum12m,
      sp500Momentum3m,
      dxy,
      btcVolRealized,
      jumpIntensity: jumpParams.intensity,
      jumpMean:      jumpParams.mean,
      jumpStd:       jumpParams.stdDev,
      liquidityScore: liquidityScoreAuto,
      liquidityDataQuality: liquidityOutput.dataQuality,
    },
    fetchErrors,
  };
}

// Fallback if historical data is incomplete
function fallbackCovMatrix(): number[][] {
  const VOLS = [0.60, 0.18, 0.22, 0.15, 0.35, 0.25, 0.16];
  const CORR = [
    [1.00, 0.15, 0.20, 0.05, 0.10, 0.30, 0.10],
    [0.15, 1.00, 0.75, 0.10, 0.15, 0.40, 0.25],
    [0.20, 0.75, 1.00, 0.10, 0.15, 0.45, 0.20],
    [0.05, 0.10, 0.10, 1.00, 0.05, 0.05, 0.15],
    [0.10, 0.15, 0.15, 0.05, 1.00, 0.20, 0.10],
    [0.30, 0.40, 0.45, 0.05, 0.20, 1.00, 0.15],
    [0.10, 0.25, 0.20, 0.15, 0.10, 0.15, 1.00],
  ];
  return CORR.map((row, i) => row.map((c, j) => c * VOLS[i] * VOLS[j]));
}