import { supabase } from '@/integrations/supabase/client';
import { ASSETS } from '@/lib/constants';

interface YahooChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
}

interface YahooResponse {
  data: Record<string, YahooChartResult>;
  errors: string[];
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

export async function fetchRealMarketData(): Promise<{ marketData: MarketData; fetchErrors: string[] }> {
  const { data: response, error } = await supabase.functions.invoke<YahooResponse>('yahoo-finance');

  if (error || !response) {
    throw new Error(`Failed to fetch market data: ${error?.message || 'No response'}`);
  }

  const { data: yfData, errors: fetchErrors } = response;

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
  const vixP80 = vixCloses.length > 50 ? percentile(vixCloses, 80) : 28;
  const vixP20 = vixCloses.length > 50 ? percentile(vixCloses, 20) : 14;
  const tnxPrice = yfData['^TNX']?.currentPrice ?? 4.25;
  const irxPrice = yfData['^IRX']?.currentPrice ?? 3.80;

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
  const btcReturns = returnsPerAsset[ASSETS.indexOf('BTC-EUR')];

  // Z-Score 200 días
  let btcZScore = 0;
  const last200 = btcCloses.slice(-200);
  if (last200.length >= 200) {
    const m = mean(last200);
    const s = std(last200);
    btcZScore = s > 0 ? ((yfData['BTC-EUR']?.currentPrice ?? last200[last200.length - 1]) - m) / s : 0;
  }

  // RSI 14 días desde retornos reales
  let btcRsi = 50;
  if (btcReturns.length >= 15) {
    const recent = btcReturns.slice(-14);
    const gains = recent.filter(r => r > 0).reduce((a, b) => a + b, 0) / 14;
    const losses = Math.abs(recent.filter(r => r < 0).reduce((a, b) => a + b, 0)) / 14;
    const rs = losses === 0 ? 100 : gains / losses;
    btcRsi = 100 - (100 / (1 + rs));
  }

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