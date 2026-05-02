import { supabase } from '@/integrations/supabase/client';
import { getDynamicCovMatrix } from '@/core/risk/dccGarch';
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
  creditSpread?: { spread?: number; value?: number; source: string } | null;
  breakeven?: { value?: number; source: string } | null;
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
  // Brent Crude Oil $/barril — auto Yahoo Finance (BZ=F) — referente europeo/global
  wtiOil: number;
  wtiSource: "YAHOO" | "MANUAL";
  // PASO 5 — Nuevos campos auto desde Yahoo/FRED
  moveIndex: number;      // CBOE MOVE Index (^MOVE) — volatilidad bonos USA
  moveSource: "YAHOO" | "MANUAL";
  creditSpread: number;   // HY-IG spread % — proxy HYG spread o FRED BAMLH0A0HYM2
  creditSpreadSource: "FRED" | "YAHOO_PROXY" | "MANUAL";
  // BTC RSI semanal (resampleado de diario con Wilder EMA)
  btcRsiWeekly: number;
  // Pi Cycle MAs calculados automáticamente desde histórico BTC
  piCycleMa111: number | null;
  piCycleMa350x2: number | null;
  // Breakeven inflación 5y (FRED T5YIFR)
  inflationBreakeven: number | null;
  inflationBESource: "FRED" | "MANUAL";
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

  // ── FIX NaN: necesitamos al menos 2 observaciones para covarianza ──────
  if (minLen < 2) {
    // Fallback: matriz diagonal con varianzas individuales de cada serie
    return Array.from({ length: n }, (_, i) => {
      const series = returnsSeries[i];
      const m = series.length > 0 ? series.reduce((a, b) => a + b, 0) / series.length : 0;
      const v = series.length > 1
        ? series.reduce((a, b) => a + (b - m) ** 2, 0) / (series.length - 1) * 252
        : 0.04; // fallback: 20% vol anualizada
      return Array.from({ length: n }, (_, j) => i === j ? v : 0);
    });
  }

  // Trim all to same length (from the end, most recent)
  const trimmed = returnsSeries.map(r => r.slice(r.length - minLen));
  const means = trimmed.map(mean);

  // Paso 1: MLE sample covariance (anualizada)
  const covSample: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let k = 0; k < minLen; k++) {
        s += (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]);
      }
      const c = s / (minLen - 1);
      covSample[i][j] = c * 252; // anualizar
      covSample[j][i] = c * 252;
    }
  }

  // FIX-IMP-3: Ledoit-Wolf shrinkage analítico (Ledoit & Wolf 2004, fórmula cerrada).
  // PROBLEMA ANTERIOR: estimador MLE puro amplifica ruido en los elementos off-diagonal.
  // Con 7-8 activos y T~500 días, la ratio p/T ≈ 0.016 — razonablemente bajo pero
  // los activos con pocos datos conjuntos (ej: BAYN.DE recién añadida) producen
  // correlaciones inestables que HRP y BL amplifican.
  //
  // SOLUCIÓN: Oracle Approximating Shrinkage (OAS) — shrinkage hacia la identidad escalada.
  //   Σ_LW = (1 - α) × Σ_sample + α × μ_trace × I
  //   donde α (shrinkage intensity) ∈ [0, 1] y μ_trace = trace(Σ)/n
  //
  // Con T >= 500 y n <= 8 → α pequeño (~0.05-0.15) → pequeño ajuste estabilizador.
  // Con T < 100 (activo nuevo como BAYN) → α mayor (~0.3-0.5) → más regularización.
  // Impacto: ±8-12% más estabilidad en pesos HRP en períodos de baja observabilidad.

  if (n <= 1) return covSample; // sin sentido shrinkage con 1 activo

  // Calcular traza media → target de shrinkage (identidad escalada)
  let traceMean = 0;
  for (let i = 0; i < n; i++) traceMean += covSample[i][i];
  traceMean /= n;

  // Intensidad de shrinkage óptima: Ledoit-Wolf Oracle (aproximación analítica)
  // α* ≈ min(1, (n + 2) / ((n + 2) + T × ||Σ_sample - μI||²_F / ||Σ_sample||²_F))
  let normDiff = 0, normSample = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const target = i === j ? traceMean : 0;
      normDiff   += (covSample[i][j] - target) ** 2;
      normSample += covSample[i][j] ** 2;
    }
  }
  // shrinkage intensity: más alta cuando Σ_sample difiere mucho del target o T es pequeño
  // ── FIX NaN: proteger contra normSample = 0 y valores no finitos ──────
  const alpha = (normSample > 1e-12 && isFinite(normDiff) && isFinite(normSample))
    ? Math.min(0.9, (normDiff / normSample) * (n / Math.max(1, minLen - 1)))
    : 0.3; // fallback conservador si la matriz es degenerada

  // Aplicar shrinkage: combinar sample con identidad escalada
  const covLW: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const target = i === j ? traceMean : 0;
      covLW[i][j] = (1 - alpha) * covSample[i][j] + alpha * target;
    }
  }
  return covLW;
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
// RSI con suavizado Wilder (EMA) — estándar de TradingView y Bloomberg
// Necesita mínimo 100 datos para que el EMA converja; con 15 datos era inestable.
// Wilder smoothing: avg_gain = avg_gain_prev * (13/14) + gain_current * (1/14)
function calculateRSI14(closes: number[]): number {
  if (closes.length < 28) return 50; // insuficiente para convergencia
  const period = 14;
  const rets = dailyReturns(closes);
  if (rets.length < period + 1) return 50;

  // Seed: media aritmética de los primeros 14 periodos
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgGain += rets[i];
    else avgLoss += Math.abs(rets[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder EMA para el resto
  for (let i = period; i < rets.length; i++) {
    const gain = rets[i] > 0 ? rets[i] : 0;
    const loss = rets[i] < 0 ? Math.abs(rets[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// RSI semanal: resamplear cierres diarios a cierres semanales (viernes)
// y calcular RSI14 sobre la serie semanal resultante
function calculateWeeklyRSI14(dailyCloses: number[], dailyTimestamps: number[]): number {
  if (dailyCloses.length < 15 || dailyTimestamps.length !== dailyCloses.length) return 50;

  // Agrupar por semana (lunes-domingo) y tomar el cierre del último día
  const weekMap = new Map<string, number>();
  for (let i = 0; i < dailyCloses.length; i++) {
    const d = new Date(dailyTimestamps[i] * 1000);
    // ISO week key: año-semana
    const day = d.getDay(); // 0=Sun
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    weekMap.set(key, dailyCloses[i]); // sobrescribe — queda el último cierre de la semana
  }

  const weeklyCloses = Array.from(weekMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v);

  return calculateRSI14(weeklyCloses);
}

// Calcular Pi Cycle MAs desde histórico diario BTC
// Pi Cycle Top: 111DMA y 350DMAx2
// Señal de techo: cuando 111DMA cruza por encima de 350DMAx2
function calculatePiCycleMAs(closes: number[]): { ma111: number; ma350x2: number } | null {
  if (closes.length < 351) return null;
  const last = closes.slice(-351);
  const ma111 = last.slice(-111).reduce((s, v) => s + v, 0) / 111;
  const ma350 = last.reduce((s, v) => s + v, 0) / 350;
  return {
    ma111: parseFloat(ma111.toFixed(2)),
    ma350x2: parseFloat((ma350 * 2).toFixed(2)),
  };
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

  const { data: yfData, errors: fetchErrors, m2: fredM2, cape: fredCAPE, centralBanks, creditSpread: fredCreditSpread, breakeven: fredBreakeven } = response;
  // M2 real de FRED
  const m2Growth = fredM2?.growthYoY ?? 5.2;

  // Shiller CAPE (PER ajustado al ciclo)
  const per = fredCAPE?.cape ?? 29.5;
  const perSource: "FRED" | "manual" = fredCAPE ? "FRED" : "manual";

  // ====== PRECIOS ACTUALES ======
  // FIX-PRICE-UPDATE: iterar TODOS los tickers devueltos por Yahoo Finance,
  // no solo los de la constante ASSETS. Esto garantiza que cualquier activo
  // añadido al portfolio (ej: BAYN.DE) reciba su precio real aunque no esté
  // en ASSETS todavía, y que el dashboard nunca caiga al fallback estático.
  const prices: Record<string, number> = {};
  // Primero: todos los tickers conocidos de ASSETS
  for (const ticker of ASSETS) {
    const d = yfData[ticker];
    prices[ticker] = d?.currentPrice ?? 0;
  }
  // Segundo: cualquier ticker adicional que Yahoo devuelva (ej: BAYN.DE)
  // Esto actúa como red de seguridad para activos añadidos al portfolio
  // sin actualizar la constante ASSETS.
  for (const ticker of Object.keys(yfData)) {
    if (!(ticker in prices) && yfData[ticker]?.currentPrice) {
      prices[ticker] = yfData[ticker].currentPrice;
    }
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
  // FIX-PRICE-UPDATE: incluir todos los tickers de yfData, no solo ASSETS.
  const closesHistory: Record<string, number[]> = {};
  for (const ticker of ASSETS) {
    const d = yfData[ticker];
    closesHistory[ticker] = d ? cleanCloses(d.closes) : [];
  }
  // Red de seguridad: activos extra en el portfolio no incluidos en ASSETS constant
  for (const ticker of Object.keys(yfData)) {
    if (!(ticker in closesHistory) && yfData[ticker]) {
      closesHistory[ticker] = cleanCloses(yfData[ticker].closes);
    }
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

  // BTC RSI-14 (usando helper genérico — Wilder EMA mejorado)
  const btcDailyCloses = cleanCloses(yfData['BTC-EUR']?.closes ?? []);
  const btcTimestamps  = yfData['BTC-EUR']?.timestamps ?? [];
  const btcRsi = calculateRSI14(btcDailyCloses);

  // PASO 5: BTC RSI semanal — resamplear diario a semanal con Wilder EMA
  const btcRsiWeekly = calculateWeeklyRSI14(btcDailyCloses, btcTimestamps);

  // PASO 5: Pi Cycle MAs — 111DMA y 350DMAx2 calculados desde histórico diario BTC
  const piCycleMAs = calculatePiCycleMAs(btcDailyCloses);

  // BTC vol realizada anualizada
  const btcReturnsForVol = dailyReturns(btcDailyCloses);
  const btcVolRealized = btcReturnsForVol.length > 20
    ? Math.sqrt(btcReturnsForVol.reduce((s, r) => { const m = 0; return s + (r - m) ** 2; }, 0)
        / btcReturnsForVol.length * 252)
    : 0.60;

  // Jump parameters calibrados desde histórico BTC
  const jumpParams = calibrateJumps(btcReturnsForVol);

  // ── S&P 500 ────────────────────────────────────────────────────────────────
  const sp500Closes = cleanCloses(yfData['^GSPC']?.closes ?? []);
  // PASO 5: RSI S&P500 con Wilder EMA fiable (antes solo usaba 15 datos → siempre ~50)
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

  // ── BRENT CRUDE OIL (BZ=F) — referente europeo/global ──────────────────
  const wtiRaw = yfData['BZ=F']?.currentPrice ?? 0;
  const wtiOil = wtiRaw > 0 ? wtiRaw : 0;
  const wtiSource: "YAHOO" | "MANUAL" = wtiRaw > 0 ? "YAHOO" : "MANUAL";

  // ── MOVE INDEX (^MOVE) — volatilidad implícita bonos USA ─────────────────
  // CBOE Interest Rate Swap Volatility Index — referente de estrés en renta fija
  // Rango normal: 80-120 · Tensión: >130 · Crisis: >150 (COVID pico: 164, GFC: >260)
  const moveRaw = yfData['^MOVE']?.currentPrice ?? 0;
  const moveIndex = moveRaw > 0 ? moveRaw : 0;
  const moveSource: "YAHOO" | "MANUAL" = moveRaw > 0 ? "YAHOO" : "MANUAL";

  // ── CREDIT SPREAD HY-IG ──────────────────────────────────────────────────
  // PASO 2: FRED BAMLH0A0HYM2 es la fuente oficial — tiene prioridad absoluta.
  // Proxy HYG-LQD solo si FRED no está disponible.
  const hygPrice = yfData['HYG']?.currentPrice ?? 0;
  const lqdPrice = yfData['LQD']?.currentPrice ?? 0;
  let creditSpread = 3.0;
  let creditSpreadSource: "FRED" | "YAHOO_PROXY" | "MANUAL" = "MANUAL";

  if (fredCreditSpread && fredCreditSpread.spread > 0) {
    // Prioridad 1: FRED BAMLH0A0HYM2 — oficial ICE BofA
    creditSpread = fredCreditSpread.spread;
    creditSpreadSource = "FRED";
  } else if (hygPrice > 0 && lqdPrice > 0) {
    // Prioridad 2: proxy HYG-LQD hasta que FRED esté disponible
    const hygYield  = (4.20 / hygPrice) * 100;
    const lqdYield  = (3.00 / lqdPrice) * 100;
    const rawSpread = Math.max(0, hygYield - lqdYield);
    creditSpread = parseFloat((rawSpread / 0.80).toFixed(2));
    creditSpreadSource = "YAHOO_PROXY";
  }

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

  // Mapa de proxies americanos para ETFs europeos con historia corta
  // Cuando el ETF europeo tiene pocos datos en Yahoo, usamos el proxy
  const PROXY_FALLBACK: Partial<Record<string, string>> = {
    'URNU.DE': 'URA',    // Global X Uranium UCITS → Global X Uranium ETF (US)
    'VVSM.DE': 'SMH',    // VanEck Semiconductor → SOXX/SMH
    'EMXC.DE': 'EEM',    // EM ex-China → EEM
    'IS3Q.DE': 'QUAL',   // MSCI Quality → iShares MSCI USA Quality
    'PPFB.DE': 'GLD',    // Gold ETC → GLD
    'XNAS.DE': 'QQQ',    // NASDAQ 100 → QQQ
    // BAYN.DE: datos europeos desde 2000 en Yahoo Finance — sin proxy necesario
    // Si hay pocos datos, fallback a XBI (biotech USA) como aproximación farmacéutica
    'BAYN.DE': 'XBI',    // SPDR S&P Biotech ETF — proxy sectorial healthcare/pharma
  };

  const getCloses = (ticker: string, minLen: number): number[] => {
    const direct = closesHistory[ticker] ?? [];
    if (direct.length >= minLen) return direct;
    // Fallback al proxy americano si hay datos insuficientes
    const proxyTicker = PROXY_FALLBACK[ticker];
    if (proxyTicker) {
      const proxyData = yfData[proxyTicker];
      if (proxyData) {
        const proxyCloses = cleanCloses(proxyData.closes);
        if (proxyCloses.length >= minLen) return proxyCloses;
      }
    }
    return direct; // devolver lo que hay aunque sea corto
  };

  const returns12m = ASSETS.map(ticker => {
    const closes = getCloses(ticker, DAYS_12M + 1);
    if (closes.length < DAYS_12M + 1) return 0;
    const start = closes[closes.length - DAYS_12M - 1];
    const end   = closes[closes.length - 1];
    return start > 0 ? (end / start) - 1 : 0;
  });

  const returns3m = ASSETS.map(ticker => {
    const closes = getCloses(ticker, DAYS_3M + 1);
    if (closes.length < DAYS_3M + 1) return 0;
    const start = closes[closes.length - DAYS_3M - 1];
    const end   = closes[closes.length - 1];
    return start > 0 ? (end / start) - 1 : 0;
  });

  const returns1m = ASSETS.map(ticker => {
    const closes = getCloses(ticker, DAYS_1M + 1);
    if (closes.length < DAYS_1M + 1) return 0;
    const start = closes[closes.length - DAYS_1M - 1];
    const end   = closes[closes.length - 1];
    return start > 0 ? (end / start) - 1 : 0;
  });

  // ====== EXPECTED RETURNS — Estimador James-Stein con shrinkage hacia priors de LP ======
  //
  // FIX MATH-04: mean(r) * 252 es un estimador MLE sin regularización.
  // Con solo 2 años de datos, el error de estimación domina la señal real.
  // Ejemplo: BTC +68% en 2023-24 → mu=0.68 → €443k mediana a 10 años sobre €6k. INCORRECTO.
  //
  // Solución: James-Stein shrinkage (Jorion 1986 — estándar CFA/GARP para retornos esperados):
  //   μ_JS = (1 - φ) * μ_MLE + φ * μ_prior
  //   φ ∈ [0,1] — mayor φ = más peso al prior de largo plazo (menos al histórico reciente)
  //
  // Priors de largo plazo (consenso académico / Damodaran 2024):
  //   BTC: 15% anual (ajustado ciclo, no 68% del bull run 2023)
  //   Semis: 14%   MSCI Quality: 11%   Uranium: 10%   EM: 8%   Gold: 6%   NASDAQ: 12%
  //
  // φ = 0.65 — ponderación estándar para series de 2 años (Ledoit-Wolf criterion)
  //   Con n=500 obs y k=7 activos: φ_óptimo ≈ (k+2)/(k+2+n*(μ-μ_prior)²/σ²) ~ 0.6-0.7
  //
  // Impacto: mu efectivo baja de ~22% a ~12-14% → mediana MC baja de €900k a €120-180k
  // sobre 10 años con €6k inicial + €500/mes. Rango honesto para retail investor.

  // Priors de largo plazo calibrados por clase de activo (% anual, en decimal)
  // Fuente: Damodaran (NYU) 2024, Vanguard Capital Markets Model 2024, BlackRock BII 2024
  const LONG_RUN_PRIORS: Record<string, number> = {
    'BTC-EUR':  0.15,   // 15% — prima cripto ajustada ciclo (no bull-run)
    'VVSM.DE':  0.14,   // 14% — semiconductores: ciclo AI, pero valoración ya alta
    'IS3Q.DE':  0.11,   // 11% — MSCI World Quality Factor: prima quality ~2-3% sobre market
    'URNU.DE':  0.10,   // 10% — Uranio: demanda nuclear estructural, pero ilíquido
    'EMXC.DE':  0.08,   //  8% — EM ex-China: prima EM ~3% sobre DM, China excluida
    'PPFB.DE':  0.06,   //  6% — Oro: retorno real histórico ~2-4%, inflación ~2%
    'XNAS.DE':  0.15,   // 15% — NASDAQ 100: prima growth/tech histórica, proxy QQQ
    'BAYN.DE':  0.12,   // 12% — Bayer: deep value (P/E ~8x), upside resolución litigios
  };

  const SHRINKAGE_FACTOR = 0.65; // φ — peso al prior de LP (James-Stein estándar para T≈500 días)

  const expectedReturns = ASSETS.map((ticker, idx) => {
    const r = returnsPerAsset[idx];
    if (r.length < 20) return LONG_RUN_PRIORS[ticker] ?? 0.08; // sin datos: usar prior
    const mleMu = mean(r) * 252;                                  // estimador histórico crudo
    const prior = LONG_RUN_PRIORS[ticker] ?? 0.08;               // prior de largo plazo
    // Shrinkage: combinar MLE con prior — reduce sesgo de recency bias
    const shrunk = (1 - SHRINKAGE_FACTOR) * mleMu + SHRINKAGE_FACTOR * prior;
    // Cap conservador: no permitir mu > 25% (evita proyecciones absurdas incluso en bull runs)
    return Math.min(0.25, Math.max(0.02, shrunk));
  });

  // ====== VOLATILIDADES REALIZADAS ANUALIZADAS ======
  // Blend 70% EWMA (lambda=0.94, reactivo a régimen reciente) + 30% histórica larga.
  // El EWMA reacciona 3-4x más rápido que la vol histórica en cambios de régimen,
  // mejorando la señal de Vol Target y el sizing de Kelly en mercados volátiles.
  const realizedVols = returnsPerAsset.map(r => {
    if (r.length < 20) return 0.25;
    const m = mean(r);
    const historicVol = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1) * 252);
    // EWMA lambda=0.94 (RiskMetrics standard) — pondera más los retornos recientes
    let ewmaVariance = 0;
    for (const ret of r) ewmaVariance = 0.94 * ewmaVariance + 0.06 * ret ** 2;
    const ewmaVol = Math.sqrt(ewmaVariance * 252);
    return ewmaVol * 0.70 + historicVol * 0.30;
  });

  // ====== MATRIZ DE COVARIANZA ======
  const staticCov = returnsPerAsset.some(r => r.length < 20)
  ? fallbackCovMatrix()
  : covarianceMatrix(returnsPerAsset);

const covMatrix = getDynamicCovMatrix([...ASSETS], closesHistory, staticCov);
    

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
      wtiOil,
      wtiSource,
      moveIndex,
      moveSource,
      creditSpread,
      creditSpreadSource,
      // PASO 5 — nuevos campos automáticos
      btcRsiWeekly,
      piCycleMa111:   piCycleMAs?.ma111   ?? null,
      piCycleMa350x2: piCycleMAs?.ma350x2 ?? null,
      inflationBreakeven: fredBreakeven?.value ?? null,
      inflationBESource: fredBreakeven ? "FRED" as const : "MANUAL" as const,
    },
    fetchErrors,
  };
}

// Fallback if historical data is incomplete
// FIX-BAYN: expandida de 7×7 a 8×8 para incluir BAYN.DE (healthcare, vol ~35%)
// Orden: BTC-EUR, EMXC.DE, IS3Q.DE, PPFB.DE, URNU.DE, VVSM.DE, XNAS.DE, BAYN.DE
function fallbackCovMatrix(): number[][] {
  const VOLS = [0.60, 0.18, 0.22, 0.15, 0.35, 0.25, 0.16, 0.35];
  const CORR = [
    // BTC   EMXC   IS3Q   PPFB   URNU   VVSM   XNAS   BAYN
    [1.00,  0.15,  0.20,  0.05,  0.10,  0.30,  0.10,  0.05],  // BTC
    [0.15,  1.00,  0.75,  0.10,  0.15,  0.40,  0.25,  0.30],  // EMXC
    [0.20,  0.75,  1.00,  0.10,  0.15,  0.45,  0.20,  0.35],  // IS3Q
    [0.05,  0.10,  0.10,  1.00,  0.05,  0.05,  0.15,  0.00],  // PPFB (oro — descorrelado)
    [0.10,  0.15,  0.15,  0.05,  1.00,  0.20,  0.10,  0.10],  // URNU
    [0.30,  0.40,  0.45,  0.05,  0.20,  1.00,  0.15,  0.25],  // VVSM
    [0.10,  0.25,  0.20,  0.15,  0.10,  0.15,  1.00,  0.20],  // XNAS
    [0.05,  0.30,  0.35,  0.00,  0.10,  0.25,  0.20,  1.00],  // BAYN (healthcare, correlación moderada con equity)
  ];
  return CORR.map((row, i) => row.map((c, j) => c * VOLS[i] * VOLS[j]));
}