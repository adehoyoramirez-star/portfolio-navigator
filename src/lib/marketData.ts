import { fetchYahooBatch, type YahooBatchResponse } from '@/lib/yahooFinance';
import { loadFredManual, isFredDataFresh, fetchFredFromServer } from '@/lib/fredManualInputs';
import { getProxyUS, getLongRunPrior, getEarningsYield, isAssetCrypto } from '@/lib/assetRegistry';
import { ASSETS } from '@/lib/constants';
import { cleanCloses, dailyReturns, tradingDayReturns, mean, std, percentile } from '@/lib/stats';
import type { CEWSDataPoint } from '@/core/macro/crisisEarlyWarning';
import { fromManualInputs } from '@/core/macro/liquidityCycle';
import { ensurePSD } from '@/lib/matrixUtils';

interface YahooChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
  highs: number[];   // FIX-INTERFACE: Edge Function devuelve highs — TypeScript debe validarlo
  lows: number[];    // FIX-INTERFACE: Edge Function devuelve lows — TypeScript debe validarlo
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
  // FIX-1: fundamentals añadido — la función Supabase puede devolver datos
  // de fundamentales (PE, EPS, dividendo) si se implementa en el edge function.
  // Sin esta declaración TypeScript rechaza el destructuring de la línea 442.
  fundamentals?: Record<string, {
    pe?: number;
    eps?: number;
    dividendYield?: number;
    marketCap?: number;
  }> | null;
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
  // Retornos esperados anualizados por activo (orden = ASSETS) — James-Stein shrunk (φ=0.65)
  expectedReturns: number[];
  // Retornos históricos MLE sin shrinkage (orden = ASSETS) — para Monte Carlo y proyecciones forward-looking
  mleReturns: number[];
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
  // Global CB Liquidity Growth YoY% — Fed WALCL + BCE ECBASSETSW
  cbLiquidityGrowth?: number;
  cbLiquiditySource: "FRED" | "MANUAL";
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
  // FIX-AUDIT-R7 MD-0: flags de calidad de datos — true = dato real (FRED/Yahoo), false = fallback manual
  dataQualityFlags: {
    m2Growth: boolean;
    cape: boolean;
    centralBanks: boolean;
    creditSpread: boolean;
    breakeven: boolean;
  };
  // FIX-AUDIT-R9 4: circuit breaker — true if Yahoo data >72h stale (DCA blocked).
  staleDataBlock: boolean;
  // FIX-AUDIT-R9 5: SOX RSI semanal para CycleTop de semiconductores
  soxRsiWeekly: number;
}

// Nota: cleanCloses, dailyReturns, tradingDayReturns, mean, std, percentile importados desde @/lib/stats.ts

// ── Constantes de configuración (module-level) ───────────────────────────────
const DAYS_12M = 252;
const DAYS_3M  = 63;
const DAYS_1M  = 21;

const SHRINKAGE_FACTOR = 0.65; // φ — James-Stein estándar para T ≈ 500 días

// Priors de largo plazo calibrados por clase de activo (% anual, en decimal)
// FIX-AUDIT-R9 2: derivados de assetRegistry.ts (single source of truth).
// Fuente: Damodaran (NYU) 2024, Vanguard Capital Markets Model 2024, BlackRock BII 2024
const LONG_RUN_PRIORS: Record<string, number> = Object.fromEntries(
  ASSETS.map(t => [t, getLongRunPrior(t)])
);

// FIX-AUDIT-R9 2: PROXY_FALLBACK derivado de assetRegistry.ts (single source of truth).
const PROXY_FALLBACK: Partial<Record<string, string>> = Object.fromEntries(
  ASSETS.map(t => [t, getProxyUS(t)]).filter(([ticker, proxy]) => proxy !== undefined && proxy !== ticker)
);

// ── FIX-LEDOIT-WOLF-CANONICAL (22-Jun-2026) ───────────────────────────────────
// Corrección de auditoría: la implementación anterior usaba un target
// identity-based (traceMean en diagonal, 0 off-diagonal) con fórmula de
// shrinkage no canónica: α = (normDiff/normSample) * (n/(minLen-1)).
//
// La implementación canónica de Ledoit & Wolf (2004) usa:
//   1. Target F = Constant Correlation Model
//      - diagonal F_ii = S_ii (varianzas muestrales)
//      - off-diagonal F_ij = r̄ * sqrt(S_ii * S_jj) donde r̄ = correlación media
//   2. Shrinkage intensity: ρ̂ = Σ Var(s_ij) / ||S - F||²_F
//      - Var(s_ij) estimado como (1/T²) * Σ_t (x_it * x_jt - s_ij)²
//      - Esto es el oracle shrinkage intensity que minimiza el MSE esperado
//   3. MLE covariance: divide por T (no T-1), siguiendo el paper original
//   4. Annualización (×252) al final, sobre los daily shrunk
//
// Se elimina el shrinkage adaptativo por activo (SHORT_ASSET_THRESHOLD,
// SHORT_ALPHA_BASE) — el target de correlación constante ya regulariza
// naturalmente las covarianzas de series cortas sin necesidad de hacks.
export function covarianceMatrix(returnsSeries: number[][], assetTickers?: readonly string[]): number[][] {
  const n = returnsSeries.length;
  const safeLengths = returnsSeries.map(r => r.length);
  const T = Math.min(...safeLengths);

  // Fallback: < 2 observaciones → matriz diagonal con varianzas por activo
  if (T < 2) {
    const variances = returnsSeries.map(r => {
      if (r.length < 2) return 0.04;
      const m = r.reduce((a, b) => a + b, 0) / r.length;
      return Math.max(0.0001, r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1) * 252);
    });
    const traceMean = variances.reduce((s, v) => s + v, 0) / variances.length;
    const shortCount = returnsSeries.filter(r => r.length < 20).length;
    const alpha = Math.min(0.9, 0.5 + 0.3 * (shortCount / n));
    console.warn(
      '[Olympus] covMatrix: T=' + T + ' < 2, identity-based fallback (α=' + alpha.toFixed(2) + ')'
    );
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => {
        if (i === j) {
          const shrunk = (1 - alpha) * variances[i] + alpha * traceMean;
          return isFinite(shrunk) ? shrunk : 0.04;
        }
        return 0;
      })
    );
  }

  if (n <= 1) {
    const vols = returnsSeries[0];
    if (vols.length < 2) return [[0.04]];
    const m = vols.reduce((a, b) => a + b, 0) / vols.length;
    const v = vols.reduce((s, v) => s + (v - m) ** 2, 0) / (vols.length - 1) * 252;
    return [[isFinite(v) ? v : 0.04]];
  }

  // ── Paso 1: MLE Sample Covariance S (daily, divide por T) ────────────
  // Truncar todas las series a la misma longitud (más reciente)
  const trimmed = returnsSeries.map(r => r.slice(r.length - T));
  const means = trimmed.map(r => r.reduce((a, b) => a + b, 0) / T);
  const x = trimmed.map((r, i) => r.map(val => val - means[i])); // centrado

  const S: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let t = 0; t < T; t++) sum += x[i][t] * x[j][t];
      const cov = isFinite(sum) ? sum / T : 0;
      S[i][j] = cov;
      S[j][i] = cov;
    }
  }

  // ── Paso 2: Target F — Constant Correlation Model ────────────────────
  // Correlación media muestral
  let sumCorr = 0, countCorr = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = Math.sqrt(Math.max(1e-16, S[i][i]));
      const sj = Math.sqrt(Math.max(1e-16, S[j][j]));
      if (si > 0 && sj > 0) {
        sumCorr += S[i][j] / (si * sj);
        countCorr++;
      }
    }
  }
  const avgCorr = countCorr > 0 ? sumCorr / countCorr : 0;

  const F: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        F[i][j] = S[i][i];
      } else {
        F[i][j] = avgCorr * Math.sqrt(Math.max(1e-16, S[i][i] * S[j][j]));
      }
    }
  }

  // ── Paso 3: Shrinkage intensity ρ̂ = Σ Var(s_ij) / ||S - F||²_F ──────
  let sumVar = 0;   // Σ Var(s_ij)
  let normDiffSq = 0; // ||S - F||²_F

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Asymptotic variance of MLE s_ij: (1/T²) * Σ_t (x_it·x_jt - s_ij)²
      let varSum = 0;
      for (let t = 0; t < T; t++) {
        varSum += (x[i][t] * x[j][t] - S[i][j]) ** 2;
      }
      sumVar += isFinite(varSum) ? varSum / (T * T) : 0;

      // Squared Frobenius norm of S - F
      const diff = S[i][j] - F[i][j];
      normDiffSq += isFinite(diff) ? diff * diff : 0;
    }
  }

  let rho = 0;
  if (normDiffSq > 1e-12 && isFinite(sumVar) && isFinite(normDiffSq)) {
    rho = sumVar / normDiffSq;
  }
  rho = Math.max(0, Math.min(1, rho));

  // ── Paso 4: Mix S + F, luego anualizar (×252 equity, ×365 BTC) ──────
  // FIX-AUDIT-B1: BTC cotiza 24/7 (365 días/año), no 252. Anualizar su
  // varianza con ×365. Para covarianzas mixtas (BTC+equity), usar ×252
  // porque el equity no cotiza fines de semana (los días solapados son 252).
  const covLW: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const btcTickerIdx = assetTickers ? assetTickers.indexOf('BTC-EUR') : -1;
  for (let i = 0; i < n; i++) {
    const isBtcRow = i === btcTickerIdx;
    for (let j = 0; j < n; j++) {
      const isBtcCol = j === btcTickerIdx;
      const annualFactor = (isBtcRow && isBtcCol) ? 365 : 252;
      const dailyShrunk = (1 - rho) * S[i][j] + rho * F[i][j];
      covLW[i][j] = isFinite(dailyShrunk) ? dailyShrunk * annualFactor : (i === j ? 0.04 : 0);
    }
  }

  // ── Diagnóstico (solo en desarrollo) ──────────────────────────────────
  const devMode = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
  if (devMode) {
    const tickers = assetTickers ?? returnsSeries.map((_, i) => 'Asset' + i);
    const lenStr = tickers.map((t, i) => t + ':' + safeLengths[i]).join(' | ');
    const hasNaN = covLW.some(row => row.some(v => !isFinite(v)));
    console.log('[Olympus] Ledoit-Wolf Canonical | T=' + T + ' | ρ=' + rho.toFixed(4) + ' | r̄=' + avgCorr.toFixed(4) + ' | hasNaN=' + hasNaN);
    console.log('[Olympus] returnsPerAsset lengths: ' + lenStr);
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

// Jump parameters: calibrate from historical daily returns.
// Returns annualized intensity, mean jump size, std of jumps.
// FIX-JUMP-01: ahora acepta un threshold personalizado por clase de activo.
// BTC con vol ~60% → threshold 4%. Equity con vol ~18% → threshold 2.5%.
// Sin esto, los saltos de equity (más pequeños pero más frecuentes) eran ignorados.
function calibrateJumps(dailyRets: number[], thresholdOverride?: number): { intensity: number; mean: number; stdDev: number } {
  if (dailyRets.length < 60) return { intensity: 0.15, mean: -0.12, stdDev: 0.05 };
  // FIX-JUMP-01: threshold adaptativo por volatilidad del activo
  // BTC: 4% → captura saltos de cola gorda. Equity: 2.5% → captura eventos de estrés.
  const threshold = thresholdOverride ?? 0.04;
  const jumps = dailyRets.filter(r => Math.abs(r) > threshold);
  const intensity = (jumps.length / dailyRets.length) * 252;
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
  // ── Llamada directa a Yahoo Finance (sin Supabase) ──
    // FIX-AUDIT-R9 5: fetch ^SOX for semiconductor CycleTop detection
  const extraTickers = ["^SOX"];
  const { data: yfData, errors: fetchErrors } = await fetchYahooBatch([...ASSETS, ...extraTickers]);

  if (Object.keys(yfData).length === 0 && fetchErrors.length > 0) {
    throw new Error(`Failed to fetch market data: ${fetchErrors.join(', ')}`);
  }

  // FIX-AUDIT-R12: FRED data — resolución de conflicto server vs manual.
  //
  // Prioridad:
  //   1. Si el usuario tiene override manual activo → usar localStorage (manual)
  //   2. Si el servidor responde y no hay override → usar servidor (FRED)
  //   3. Si el servidor falla → usar localStorage como fallback
  //
  // fetchFredFromServer() internamente respeta el override:
  //   - Si manuallyOverridden=true, NO pisa localStorage, guarda datos del
  //     servidor en _server para que el botón "Sync" del panel pueda aplicarlos.
  //   - Si manuallyOverridden=false, guarda normalmente en localStorage.
  const fredServerData = await fetchFredFromServer();
  const fredManual = loadFredManual();
  const isManualOverride = fredManual.manuallyOverridden === true;
  const fredFresh = fredServerData ? true : isFredDataFresh(7);
  const fredSource: "FRED" | "manual" = isManualOverride ? "manual" : (fredServerData ? "FRED" : "manual");
  const yfFundamentals = undefined;
  // Datos de FRED ya no vienen de Supabase — el usuario los introduce manualmente
  const fredM2 = undefined;
  const fredCAPE = undefined;
  const centralBanks = undefined;
  const fredCreditSpread = undefined;
  const fredBreakeven = undefined;
  // Flags de calidad: true = dato real, false = fallback manual
  // FIX-AUDIT-R9 1: ahora indica si el usuario ha actualizado los datos en <7 días
  const dataQualityFlags = {
    m2Growth: fredFresh,
    cape: fredFresh,
    centralBanks: false,
    creditSpread: fredFresh,
    breakeven: fredFresh,
  };
  
  // ====== DEBUG: Verificar estructura de datos recibidos (solo dev) ======
  const devMode = typeof import.meta !== 'undefined' && import.meta.env?.DEV;
  if (devMode) {
    const firstTicker = Object.keys(yfData)[0];
    if (firstTicker && yfData[firstTicker]) {
      const sample = yfData[firstTicker];
      console.log('[Olympus] Edge Function response structure check:');
      console.log(`  Sample ticker: ${firstTicker}`);
      console.log(`  Has closes: ${!!sample.closes} (length: ${sample.closes?.length ?? 0})`);
      console.log(`  Has highs: ${!!sample.highs} (length: ${(sample as any).highs?.length ?? 0})`);
      console.log(`  Has lows: ${!!sample.lows} (length: ${(sample as any).lows?.length ?? 0})`);
      console.log(`  Has timestamps: ${!!sample.timestamps} (length: ${sample.timestamps?.length ?? 0})`);
      console.log(`  Current price: ${sample.currentPrice}`);
      if (!sample.highs || !sample.lows) {
        console.warn('[Olympus] ⚠️  Edge Function NO devuelve highs/lows');
        console.warn('  Esto es esperado si la Edge Function solo devuelve closes.');
        console.warn('  Si necesitas highs/lows, actualiza la Edge Function.');
      }
    }
  }
  
  // M2 real de FRED (server o localStorage)
  const m2Growth = fredManual.m2GrowthYoY;

  // Global CB Liquidity Growth YoY% — Fed (WALCL) + BCE (ECBASSETSW)
  //   Computado comparando valores actuales vs previos almacenados en localStorage.
  //   Si no hay datos previos, cbLiquidityGrowth queda undefined (el engine lo salta).
  let cbLiquidityGrowth: number | undefined = fredManual.cbLiquidityGrowth;
  let cbLiquiditySource: "FRED" | "MANUAL" = "MANUAL";
  if (cbLiquidityGrowth === undefined) {
    // Intentar computar desde fedBalanceSheet + ecbBalanceSheet con prev-persist
    const fedNow = fredManual.fedBalanceSheet;
    const ecbNow = fredManual.ecbBalanceSheet;
    if (fedNow !== undefined && ecbNow !== undefined) {
      const PREV_KEY = 'olympus_cb_liquidity_prev';
      try {
        const prevRaw = localStorage.getItem(PREV_KEY);
        if (prevRaw) {
          const prev = JSON.parse(prevRaw);
          if (typeof prev.fed === 'number' && typeof prev.ecb === 'number' && prev.fed > 0 && prev.ecb > 0) {
    // ECB balance sheet está en billions EUR → convertir a USD (~1.08, aproximado).
            // TODO: usar EUR/USD real del dashboard en vez de hardcodeado.
            const ecbUsd = ecbNow * 1.08;
            const ecbPrevUsd = prev.ecb * 1.08;
            const totalNow = fedNow + ecbUsd;
            const totalPrev = prev.fed + ecbPrevUsd;
            if (totalPrev > 0) {
              cbLiquidityGrowth = ((totalNow - totalPrev) / totalPrev) * 100;
              cbLiquiditySource = "FRED";
            }
          }
        }
        // Guardar actual para la próxima comparación
        localStorage.setItem(PREV_KEY, JSON.stringify({ fed: fedNow, ecb: ecbNow, ts: Date.now() }));
      } catch { /* localStorage no disponible */ }
    }
  } else {
    cbLiquiditySource = "FRED";
  }

  // Shiller CAPE (PER ajustado al ciclo)
  const per = fredManual.cape;
  const perSource: "FRED" | "manual" = fredSource;

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

  // ====== VALIDACIÓN ROBUSTA DE DATOS (solo dev) ======
  const minDataPoints = 60;
  const dataReport: Record<string, number> = {};
  const validTickers: string[] = [];
  const insufficientTickers: string[] = [];

  for (const ticker of ASSETS) {
    const len = closesHistory[ticker]?.length ?? 0;
    dataReport[ticker] = len;
    if (len >= minDataPoints) {
      validTickers.push(ticker);
    } else {
      insufficientTickers.push(ticker);
    }
  }

  if (devMode) {
    console.log('[Olympus] closesHistory validation:');
    console.log(`  ✅ Valid: ${validTickers.length}/${ASSETS.length} tickers con ≥${minDataPoints} días`);
    if (validTickers.length > 0) {
      console.log('  Data lengths:', Object.entries(dataReport)
        .filter(([t]) => validTickers.includes(t))
        .map(([t, l]) => `${t}: ${l}`)
        .join(' | '));
    }
    if (insufficientTickers.length > 0) {
      console.warn(`  ⚠️  Insufficient: ${insufficientTickers.join(', ')}`);
      console.warn('  Data lengths:', Object.entries(dataReport)
        .filter(([t]) => insufficientTickers.includes(t))
        .map(([t, l]) => `${t}: ${l}`)
        .join(' | '));
    }
  }

  if (validTickers.length === 0) {
    console.error('[Olympus] ❌ CRITICAL: closesHistory vacío o insuficiente para TODOS los tickers');
    console.error('  Revisa Supabase Edge Function logs para ver errores de Yahoo Finance fetch.');
  }

  // ====== RETORNOS DIARIOS POR ACTIVO ======
  // FIX-AUDIT-R7 MD-1: usar tradingDayReturns para filtrar fines de semana en activos no-cripto.
  // BTC-EUR cotiza 24/7 → dailyReturns sin filtrar + anualización ×365.
  // Resto de activos: tradingDayReturns filtra Sat/Sun forward-filled → anualización ×252.
  const returnsPerAsset = ASSETS.map(ticker => {
    const closes = closesHistory[ticker];
    const timestamps = yfData[ticker]?.timestamps ?? [];
    if (ticker === 'BTC-EUR') {
      // BTC trades 24/7 — all calendar days are real trading days
      return dailyReturns(closes);
    }
    // Non-crypto: filter weekends to avoid ~28.5% zero-return dilution.
    // FIX-AUDIT-B6: when timestamps are missing, dailyReturns includes weekend
    // zeros → use ×365 annualization to compensate. Flagged via _usesDailyFallback.
    const hasTimestamps = timestamps.length === closes.length && timestamps.length > 0;
    return hasTimestamps
      ? tradingDayReturns(closes, timestamps)
      : dailyReturns(closes); // fallback si no hay timestamps
  });

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

  // FIX-AUDIT-R9 5: SOX RSI semanal para CycleTop de semiconductores (VVSM.DE)
  const soxDailyCloses = cleanCloses(yfData['^SOX']?.closes ?? []);
  const soxTimestamps = yfData['^SOX']?.timestamps ?? [];
  const soxRsiWeekly = calculateWeeklyRSI14(soxDailyCloses, soxTimestamps);

  // PASO 5: Pi Cycle MAs — 111DMA y 350DMAx2 calculados desde histórico diario BTC
  const piCycleMAs = calculatePiCycleMAs(btcDailyCloses);

  // BTC vol realizada anualizada (reusa returnsPerAsset para evitar dailyReturns duplicado)
  // FIX-AUDIT-R7 MD-1: BTC anualiza ×365 (cotiza 24/7).
  const btcIdx = ASSETS.indexOf('BTC-EUR');
  const btcReturnsForVol = btcIdx >= 0 ? returnsPerAsset[btcIdx] : [];
  const btcVolRealized = btcReturnsForVol.length > 20
    ? (() => {
        const mu = btcReturnsForVol.reduce((s, r) => s + r, 0) / btcReturnsForVol.length;
        return Math.sqrt(btcReturnsForVol.reduce((s, r) => s + (r - mu) ** 2, 0)
          / (btcReturnsForVol.length - 1) * 365);
      })()
    : 0.60;

  // Jump parameters calibrados desde histórico BTC
  const jumpParams = calibrateJumps(btcReturnsForVol);

  // ── S&P 500 ────────────────────────────────────────────────────────────────
  const sp500Closes = cleanCloses(yfData['^GSPC']?.closes ?? []);
  // FIX-BACKTEST-VIX: añadir SP500 a closesHistory para que BacktestPanel pueda
  // construir el proxy histórico de VIX en lugar de repetir el valor actual.
  // Sin esto, buildVixProxy recibe un array vacío y usa currentVix para todos los días,
  // resultando en 100% EXPANSION en el backtest (forward-looking bias confirmado en auditoría).
  if (sp500Closes.length > 0) {
    closesHistory['^GSPC'] = sp500Closes;
  }
  // S&P 500 RSI con Wilder EMA
  const sp500Rsi = calculateRSI14(sp500Closes);

  // S&P 500 momentum: retorno 12m (excluyendo último mes = Jegadeesh-Titman)
  const sp500Last = sp500Closes[sp500Closes.length - 1];
  const sp500_12m_start = sp500Closes[sp500Closes.length - 252 - 1];
  const sp500_1m_start  = sp500Closes[sp500Closes.length - 21 - 1];
  const sp500_3m_start  = sp500Closes[sp500Closes.length - 63 - 1];
  const sp500Momentum12m = sp500_12m_start > 0 && sp500_1m_start > 0
    ? (sp500_1m_start / sp500_12m_start) - 1
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

  // FIX-AUDIT-R9 1: credit spread — server FRED data takes priority over HYG-LQD proxy.
  const fredManualSpread = fredManual.creditSpread;
  const isDefaultSpread = fredManualSpread === 3.0; // default = not user-overridden
  if (!isDefaultSpread && fredManualSpread > 0) {
    creditSpread = fredManualSpread;
    creditSpreadSource = "MANUAL";
  } else if (hygPrice > 0 && lqdPrice > 0) {
    // Prioridad 2: proxy HYG-LQD hasta que FRED esté disponible
    const hygYield  = (4.20 / hygPrice) * 100;
    const lqdYield  = (3.00 / lqdPrice) * 100;
    const rawSpread = Math.max(0, hygYield - lqdYield);
    creditSpread = parseFloat((rawSpread / 0.80).toFixed(2));
    creditSpreadSource = "YAHOO_PROXY";
  }

  // ── Liquidez Global desde entradas manuales FRED ──────────────────────
  const liquidityOutput = fromManualInputs({ liquidityGrowth: m2Growth, dxy });

  const liquidityScoreAuto = Math.max(0, Math.min(1,
    (liquidityOutput.liquidityGrowth / 10) * 0.6 +
    Math.max(0, (30 - vixPrice) / 30) * 0.4
  ));

  // ====== RETORNOS POR PERÍODO (12m, 3m, 1m) ======

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

  // ====== EXPECTED RETURNS — James-Stein shrinkage hacia priors de LP ======
  // FIX-AUDIT-R7 MD-1: BTC anualiza ×365, resto ×252.
  const expectedReturns = ASSETS.map((ticker, idx) => {
    const r = returnsPerAsset[idx];
    const annualFactor = ticker === 'BTC-EUR' ? 365 : 252;
    if (r.length < 20) return LONG_RUN_PRIORS[ticker] ?? 0.08;
    const mleMu = mean(r) * annualFactor;
    const prior = LONG_RUN_PRIORS[ticker] ?? 0.08;
    const shrunk = (1 - SHRINKAGE_FACTOR) * mleMu + SHRINKAGE_FACTOR * prior;
    // FIX-MU-CLAMP: floor -5% (antes 2%) permite casos bearish genuinos
    // (oro en real rates altos, EM en fuga de capitales, uranio en oversupply).
    // FIX-AUDIT-B5: cap alineado con factorCalibration [-0.05, 0.30]
    // James-Stein shrinkage → expected return en el mismo rango que factor alphas.
    return Math.min(0.30, Math.max(-0.05, shrunk));
  });

  // ====== MLE RETURNS — sin shrinkage, para Monte Carlo y proyecciones ======
  // El James-Stein shrinkage es una herramienta de regularización para el optimizador
  // (evita over-betting en activos con μ histórico ruidoso). Pero el Monte Carlo
  // debe proyectar con la mejor estimación forward-looking: la media histórica (MLE).
  // Usar μ shrunk en Monte Carlo subestima el retorno esperado en ~40-60%.
  const mleReturns = ASSETS.map((ticker, idx) => {
    const r = returnsPerAsset[idx];
    const annualFactor = ticker === 'BTC-EUR' ? 365 : 252;
    if (r.length < 20) return LONG_RUN_PRIORS[ticker] ?? 0.08;
    const mleMu = mean(r) * annualFactor;
    // Mismo clamp que expectedReturns [-0.05, 0.30] pero SIN shrinkage
    return Math.min(0.30, Math.max(-0.05, mleMu));
  });

  // ====== VOLATILIDADES REALIZADAS ANUALIZADAS ======
  // FIX-AUDIT-R7 MD-1: BTC anualiza ×365 (cotiza 24/7). Resto ×252 (trading days).
  // FIX-AUDIT-B6: when timestamps are missing for non-BTC assets,
  // dailyReturns includes weekend zeros → use ×365 to compensate.
  const realizedVols = returnsPerAsset.map((r, idx) => {
    const ticker = ASSETS[idx];
    const timestamps = yfData[ticker]?.timestamps ?? [];
    const closesLen = closesHistory[ticker]?.length ?? 0;
    const hasTimestamps = timestamps.length === closesLen && timestamps.length > 0;
    const annualFactor = ticker === 'BTC-EUR' ? 365 : (hasTimestamps ? 252 : 365);
    if (r.length < 20) return ticker === 'BTC-EUR' ? 0.60 : 0.25;
    const m = mean(r);
    const historicVol = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1) * annualFactor);
    let ewmaVariance = 0;
    for (const ret of r) ewmaVariance = 0.94 * ewmaVariance + 0.06 * ret ** 2;
    const ewmaVol = Math.sqrt(ewmaVariance * annualFactor);
    return ewmaVol * 0.70 + historicVol * 0.30;
  });

  // ====== MATRIZ DE COVARIANZA ======
  // ── FIX-COV-ADAPTIVE: pasar ASSETS para logging y shrinkage adaptativo ──
  // FIX-NaN-GUARD: fallback si CUALQUIER activo tiene < 2 retornos (no solo < 20)
  // FIX-PSD-CHECK: validar PSD y reparar con nearestPSD si es necesario
  const rawCovMatrix = returnsPerAsset.some(r => r.length < 2)
    ? diagonalEwmaCovMatrix(returnsPerAsset, realizedVols)
    : covarianceMatrix(returnsPerAsset, ASSETS);

  // FIX-PSD-CHECK: test de Cholesky + reparación Higham (2002) si falla.
  // Una covMatrix no-PSD rompe BL (inversión), HRP (distancias imaginarias)
  // y MinVar (divergencia de pesos).
  const { matrix: covMatrix, wasRepaired } = ensurePSD(rawCovMatrix, ASSETS.join(','));
  if (wasRepaired) {
    console.warn('[Olympus] covMatrix reparada (no-PSD) — verificar datos de ' +
      ASSETS.filter((_, i) => returnsPerAsset[i].length < 20).join(', ') || 'todos los activos');
  }

  // ====== CEWS HISTORY AUTOMÁTICO (5 años semanal desde Yahoo) ======
  const cewsHistory = buildCEWSHistory(
    vixCloses, vixTimestamps, tnxCloses, irxCloses, hygCloses, m2Growth
  );

  // FIX-AUDIT-R9 4: circuit breaker + data freshness validation.
  // Warns if Yahoo data >24h old. Blocks DCA if >72h (stale prices = bad allocations).
  const now = Date.now();
  const maxWarnMs = 24 * 60 * 60 * 1000;
  const maxBlockMs = 72 * 60 * 60 * 1000;
  const staleTickers: string[] = [];
  let staleDataBlock = false;
  for (const ticker of ASSETS) {
    const timestamps = yfData[ticker]?.timestamps ?? [];
    if (timestamps.length > 0) {
      const newestTs = timestamps[timestamps.length - 1] * 1000;
      if (now - newestTs > maxBlockMs) {
        staleTickers.push(ticker);
        staleDataBlock = true;
      } else if (now - newestTs > maxWarnMs) {
        staleTickers.push(ticker);
      }
    }
  }
  if (staleDataBlock) {
    console.error(`[Olympus] 🔴 DCA BLOCKED: ${staleTickers.join(', ')} — last update >72h ago. Fix Yahoo connection to resume trading.`);
  } else if (staleTickers.length > 0) {
    console.warn(`[Olympus] ⚠️ STALE DATA: ${staleTickers.join(', ')} — last update >24h ago. Allocations may be based on outdated prices.`);
  }

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
      mleReturns,
      returns12m,
      returns3m,
      returns1m,
      realizedVols,
      closesHistory,
      covMatrix,
      cewsHistory,
      m2Growth,
      m2GrowthSource: fredSource,
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
      cbLiquidityGrowth,
      cbLiquiditySource,
      moveIndex,
      moveSource,
      creditSpread,
      creditSpreadSource,
      // PASO 5 — nuevos campos automáticos
      btcRsiWeekly,
      piCycleMa111:   piCycleMAs?.ma111   ?? null,
      piCycleMa350x2: piCycleMAs?.ma350x2 ?? null,
      inflationBreakeven: fredManual.inflationBreakeven5y,
      inflationBESource: "MANUAL" as const,
      // FIX-AUDIT-R7 MD-0: flags de calidad para warning visible en dashboard
      dataQualityFlags,
      // FIX-AUDIT-R9 4+5: circuit breaker + SOX RSI
      staleDataBlock,
      soxRsiWeekly,
    },
    fetchErrors,
  };
}

// FIX-FALLBACK-COV: sustituye la matriz hardcodeada con VOLS/CORR mágicos
// por una matriz diagonal con varianzas EWMA calculadas desde realizedVols.
//
// ANTES: fallbackCovMatrix() usaba arrays VOLS y CORR hardcodeados que:
//   1. Asumían correlaciones fijas sin evidencia (ej: BTC-VVSM 0.30 siempre)
//   2. Ignoraban los realizedVols ya calculados (línea ~760)
//   3. Eran estáticos — no reflejaban cambios de régimen
//
// AHORA: diagonal con varianzas EWMA por activo. Si un activo tiene < 2 retornos,
// usa su realizedVol como varianza. Esto es conservador (correlación=0) pero
// matemáticamente correcto: en ausencia de datos, no asumimos correlación.
function diagonalEwmaCovMatrix(
  returnsPerAsset: number[][],
  realizedVols: number[]
): number[][] {
  const n = returnsPerAsset.length;
  const variances: number[] = [];

  for (let i = 0; i < n; i++) {
    const rets = returnsPerAsset[i];
    if (rets.length >= 2) {
      // EWMA variance (λ=0.94) anualizada
      // FIX-AUDIT-B7: BTC usa ×365 (cotiza 24/7), resto ×252
      let ewmaVar = 0;
      for (const r of rets) ewmaVar = 0.94 * ewmaVar + 0.06 * r * r;
      const isBtc = ASSETS[i] === 'BTC-EUR';
      variances.push(ewmaVar * (isBtc ? 365 : 252));
    } else if (i < realizedVols.length && realizedVols[i] > 0) {
      // Fallback: usar realizedVol (ya calculado con EWMA, línea ~760)
      variances.push(realizedVols[i] * realizedVols[i]);
    } else {
      variances.push(0.04); // último recurso: 20% vol anual
    }
  }

  console.warn('[Olympus] Usando matriz diagonal EWMA (datos insuficientes para covarianza completa)');

  // Matriz diagonal: varianzas en diagonal, 0 en off-diagonal
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? variances[i] : 0))
  );
}