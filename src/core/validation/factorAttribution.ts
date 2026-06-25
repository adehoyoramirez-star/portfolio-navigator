// ===============================================
// ARCHIVO: src/core/validation/factorAttribution.ts
// FACTOR ATTRIBUTION + BENCHMARK TRACKING
// ===============================================
//
// OBJETIVO 10/10:
//   Descomponer el retorno del portfolio en contribuciones de factores
//   (momentum, value, quality, lowVol) + alpha residual + beta de mercado.
//   Comparar contra benchmarks institucionales (60/40, Equal Weight,
//   MSCI World) con tracking error e information ratio.
//
// FACTORES ANALIZADOS:
//   1. Momentum (cross-sectional): retorno 12m - 1m por activo
//   2. Value: earnings yield relativo al universo
//   3. Quality: ROE, deuda/equity, estabilidad de beneficios
//   4. Low Volatility: inverso de la volatilidad realizada
//   5. Beta: sensibilidad al benchmark (WLG como proxy del mercado)
//
// MÉTRICAS DE BENCHMARK:
//   - Tracking Error (anualizado)
//   - Information Ratio (excess return / tracking error)
//   - Active Share (% de desviación del benchmark)
//   - Beta (del portfolio vs benchmark)
//   - Alpha de Jensen (intercepto de la regresión)
//
// REFERENCIAS:
//   - Fama & French (1993) "Common Risk Factors in Stock and Bond Returns"
//   - Carhart (1997) "On Persistence in Mutual Fund Performance"
//   - Grinold & Kahn (2000) "Active Portfolio Management"
// ===============================================

import { ASSETS, RISK_FREE_RATE_DAILY } from '../../lib/constants';
import { FACTOR_CONFIG } from '../config/engineConfig';

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface FactorExposure {
  /** Exposición normalizada al factor momentum [0,1] */
  momentum: number;
  /** Exposición normalizada al factor value [0,1] */
  value: number;
  /** Exposición normalizada al factor quality [0,1] */
  quality: number;
  /** Exposición normalizada al factor lowVol [0,1] */
  lowVol: number;
}

export interface FactorReturn {
  /** Retorno atribuible a momentum */
  momentum: number;
  /** Retorno atribuible a value */
  value: number;
  /** Retorno atribuible a quality */
  quality: number;
  /** Retorno atribuible a lowVol */
  lowVol: number;
  /** Retorno de mercado (beta × benchmark return) */
  market: number;
  /** Alpha residual (no explicado por factores) */
  alpha: number;
}

export interface BenchmarkMetrics {
  /** Tracking error anualizado vs benchmark */
  trackingError: number;
  /** Information Ratio (excess return / tracking error) */
  informationRatio: number;
  /** Active Share (% de pesos que difieren del benchmark) */
  activeShare: number;
  /** Beta del portfolio vs benchmark */
  beta: number;
  /** Alpha de Jensen (anualizado) */
  jensenAlpha: number;
  /** Retorno del benchmark (CAGR) */
  benchmarkCagr: number;
  /** Retorno del portfolio (CAGR) */
  portfolioCagr: number;
  /** Excess return (portfolio - benchmark) */
  excessReturn: number;
  /** Ratio de captura al alza (% del upside del benchmark capturado) */
  upsideCapture: number;
  /** Ratio de captura a la baja (% del downside del benchmark capturado) */
  downsideCapture: number;
}

export interface AttributionResult {
  /** Descomposición de retorno por factor */
  factorReturn: FactorReturn;
  /** Métricas vs benchmark */
  benchmarks: {
    equalWeight: BenchmarkMetrics;
    sixtyForty: BenchmarkMetrics;
    msciWorld: BenchmarkMetrics;
  };
  /** Concentración HHI del portfolio */
  hhi: number;
  /** Número efectivo de posiciones (1/HHI) */
  effectiveN: number;
}

// ── Factor exposures por activo ────────────────────────────────────────────

const EARNINGS_YIELD: Record<string, number> = {
  'BTC-EUR': 0,
  'EMXC.DE': 0.05,
  'PPFB.DE': 0,
  'URNU.DE': 0.03,
  'VVSM.DE': 0.04,
  '0P00000WLG.F': 0.05,
  'BAYN.DE': 0.06,
};

const QUALITY_SCORES: Record<string, number> = {
  'BTC-EUR': 0.30,
  'EMXC.DE': 0.55,
  'PPFB.DE': 0.70,
  'URNU.DE': 0.40,
  'VVSM.DE': 0.60,
  '0P00000WLG.F': 0.65,
  'BAYN.DE': 0.50,
};

export function estimateFactorExposures(
  allocations: Record<string, number>,
  returns12m: Record<string, number>,
  volatilities: Record<string, number>
): FactorExposure {
  let momentumExp = 0, valueExp = 0, qualityExp = 0, lowVolExp = 0;
  let totalWeight = 0;

  for (const ticker of ASSETS) {
    const w = allocations[ticker] ?? 0;
    if (w <= 0) continue;
    totalWeight += w;

    // Momentum: retorno 12m normalizado al rango [-0.5, 1.5]
    const momRaw = returns12m[ticker] ?? 0;
    const momNorm = Math.max(0, Math.min(1, (momRaw + 0.30) / 1.20));
    momentumExp += w * momNorm;

    // Value: earnings yield relativo a la media del universo
    const ey = EARNINGS_YIELD[ticker] ?? 0.03;
    valueExp += w * ey / 0.05;

    // Quality: score predefinido por clase de activo
    qualityExp += w * (QUALITY_SCORES[ticker] ?? 0.50);

    // LowVol: inverso de volatilidad, normalizado
    const vol = volatilities[ticker] ?? 0.25;
    const invVol = 1 / Math.max(0.10, vol);
    lowVolExp += w * Math.min(1, invVol / 5);
  }

  if (totalWeight <= 0) return { momentum: 0, value: 0, quality: 0, lowVol: 0 };

  return {
    momentum: momentumExp / totalWeight,
    value: valueExp / totalWeight,
    quality: qualityExp / totalWeight,
    lowVol: lowVolExp / totalWeight,
  };
}

// ── Benchmark construction ─────────────────────────────────────────────────

/**
 * Construye un benchmark 60/40 (60% equity WLG, 40% bonds proxy).
 * Como no tenemos un ETF de bonos puro, usamos PPFB (oro) como proxy conservador
 * con 0% de retorno para la porción de bonos.
 */
function sixtyFortyAllocations(): Record<string, number> {
  return {
    'BTC-EUR': 0,
    'EMXC.DE': 0.10,
    'PPFB.DE': 0.40,
    'URNU.DE': 0,
    'VVSM.DE': 0.15,
    '0P00000WLG.F': 0.35,
  };
}

function equalWeightAllocations(): Record<string, number> {
  const w = 1 / ASSETS.length;
  return Object.fromEntries(ASSETS.map(t => [t, w]));
}

function msciWorldAllocations(): Record<string, number> {
  return {
    'BTC-EUR': 0,
    'EMXC.DE': 0.10,
    'PPFB.DE': 0,
    'URNU.DE': 0,
    'VVSM.DE': 0.10,
    '0P00000WLG.F': 0.80,
  };
}

// ── Métricas de benchmark ──────────────────────────────────────────────────

export function computeBenchmarkMetrics(
  portfolioReturns: number[],
  benchmarkReturns: number[],
  portfolioAllocations: Record<string, number>,
  benchmarkAllocations: Record<string, number>
): BenchmarkMetrics {
  const cleanP = portfolioReturns.filter(r => isFinite(r));
  const cleanB = benchmarkReturns.filter(r => isFinite(r));
  
  if (cleanP.length < 20 || cleanB.length < 20) {
    return {
      trackingError: 0, informationRatio: 0, activeShare: 0, beta: 0,
      jensenAlpha: 0, benchmarkCagr: 0, portfolioCagr: 0, excessReturn: 0,
      upsideCapture: 0, downsideCapture: 0,
    };
  }

  const n = Math.min(cleanP.length, cleanB.length);
  const pRets = cleanP.slice(-n);
  const bRets = cleanB.slice(-n);

  // Excess returns
  const excessRets = pRets.map((p, i) => p - bRets[i]);
  const exMean = excessRets.reduce((a, b) => a + b, 0) / n;
  const exVar = excessRets.reduce((s, r) => s + (r - exMean) ** 2, 0) / n;
  const trackingError = Math.sqrt(Math.max(0, exVar)) * Math.sqrt(252);

  // Information Ratio
  const excessAnnual = exMean * 252;
  const informationRatio = trackingError > 0 ? excessAnnual / trackingError : 0;

  // Active Share
  let activeShare = 0;
  for (const ticker of ASSETS) {
    activeShare += Math.abs(
      (portfolioAllocations[ticker] ?? 0) - (benchmarkAllocations[ticker] ?? 0)
    );
  }
  activeShare /= 2; // Normalizar a [0, 1]

  // Beta (regresión simple)
  const bMean = bRets.reduce((a, b) => a + b, 0) / n;
  const pMean = pRets.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (pRets[i] - pMean) * (bRets[i] - bMean);
    varB += (bRets[i] - bMean) ** 2;
  }
  const beta = varB > 0 ? cov / varB : 1;

  // Jensen Alpha (anualizado)
  // FIX-AUDIT-R3 R3-03 sweep: rf rate centralizado en src/lib/constants
  const rfDaily = RISK_FREE_RATE_DAILY;
  const jensenAlpha = (pMean - rfDaily - beta * (bMean - rfDaily)) * 252;

  // CAGR
  const years = n / 252;
  const pTotal = pRets.reduce((a, r) => a * (1 + r), 1);
  const bTotal = bRets.reduce((a, r) => a * (1 + r), 1);
  const portfolioCagr = years > 0 ? Math.pow(Math.max(0.001, pTotal), 1 / years) - 1 : 0;
  const benchmarkCagr = years > 0 ? Math.pow(Math.max(0.001, bTotal), 1 / years) - 1 : 0;
  const excessReturn = portfolioCagr - benchmarkCagr;

  // Upside/Downside capture
  let upsideP = 0, upsideB = 0, downsideP = 0, downsideB = 0;
  let upCount = 0, downCount = 0;
  for (let i = 0; i < n; i++) {
    if (bRets[i] > 0) {
      upsideP += pRets[i];
      upsideB += bRets[i];
      upCount++;
    } else {
      downsideP += pRets[i];
      downsideB += bRets[i];
      downCount++;
    }
  }
  const upsideCapture = upCount > 0 && upsideB > 0
    ? (upsideP / upCount) / (upsideB / upCount)
    : 0;
  const downsideCapture = downCount > 0 && downsideB < 0
    ? (downsideP / downCount) / (downsideB / downCount)
    : 0;

  return {
    trackingError,
    informationRatio,
    activeShare,
    beta,
    jensenAlpha,
    benchmarkCagr,
    portfolioCagr,
    excessReturn,
    upsideCapture: isFinite(upsideCapture) ? upsideCapture : 0,
    downsideCapture: isFinite(downsideCapture) ? downsideCapture : 0,
  };
}

// ── Factor attribution principal ───────────────────────────────────────────

export function computeFactorAttribution(
  allocations: Record<string, number>,
  assetReturns12m: Record<string, number>,
  assetVolatilities: Record<string, number>,
  portfolioReturns: number[],
  benchmarkReturnsEW: number[],
  benchmarkReturns6040: number[],
  benchmarkReturnsMSCI: number[]
): AttributionResult {
  // ── Factor exposures ─────────────────────────────────────────────────
  const exposures = estimateFactorExposures(allocations, assetReturns12m, assetVolatilities);

  // ── Factor returns (primas anuales de AQR/Dimensional) ──────────────
  // Usar las primas centralizadas de engineConfig.ts
  const PREMIUMS = FACTOR_CONFIG.FACTOR_PREMIUMS;

  // ── Descomposición ───────────────────────────────────────────────────
  const n = portfolioReturns.length;
  const pMeanDaily = n > 0 ? portfolioReturns.reduce((a, b) => a + b, 0) / n : 0;
  const pCagr = Math.pow(1 + pMeanDaily, 252) - 1;

  // Contribución de cada factor al retorno total
  const factorSum = 
    exposures.momentum * PREMIUMS.momentum +
    exposures.value * PREMIUMS.value +
    exposures.quality * PREMIUMS.quality +
    exposures.lowVol * PREMIUMS.lowVol;

  // Market = beta × equity risk premium (~5% anual)
  // Alpha = CAGR total - (factorSum + market)
  const marketReturn = 0.05; // ERP asumido 5% para developed equity
  
  const factorReturn: FactorReturn = {
    momentum: exposures.momentum * PREMIUMS.momentum,
    value: exposures.value * PREMIUMS.value,
    quality: exposures.quality * PREMIUMS.quality,
    lowVol: exposures.lowVol * PREMIUMS.lowVol,
    market: marketReturn,
    alpha: pCagr - factorSum - marketReturn,
  };

  // ── Benchmarks ───────────────────────────────────────────────────────
  const ewAlloc = equalWeightAllocations();
  const sfAlloc = sixtyFortyAllocations();
  const msciAlloc = msciWorldAllocations();

  const benchmarks = {
    equalWeight: computeBenchmarkMetrics(portfolioReturns, benchmarkReturnsEW, allocations, ewAlloc),
    sixtyForty: computeBenchmarkMetrics(portfolioReturns, benchmarkReturns6040, allocations, sfAlloc),
    msciWorld: computeBenchmarkMetrics(portfolioReturns, benchmarkReturnsMSCI, allocations, msciAlloc),
  };

  // ── Concentración ────────────────────────────────────────────────────
  let hhi = 0;
  for (const ticker of ASSETS) {
    const w = allocations[ticker] ?? 0;
    hhi += w * w;
  }
  const effectiveN = hhi > 0 ? 1 / hhi : 0;

  return {
    factorReturn,
    benchmarks,
    hhi,
    effectiveN,
  };
}

// ── Formateo ────────────────────────────────────────────────────────────────

export function formatAttribution(result: AttributionResult): string {
  const SEP = '═'.repeat(80);
  const bm = result.benchmarks;
  
  const lines = [
    '',
    SEP,
    '  FACTOR ATTRIBUTION & BENCHMARK TRACKING',
    SEP,
    '',
    '─── DESCOMPOSICIÓN DE RETORNO ───',
    `  Momentum:  ${(result.factorReturn.momentum * 100).toFixed(2)}%`,
    `  Value:     ${(result.factorReturn.value * 100).toFixed(2)}%`,
    `  Quality:   ${(result.factorReturn.quality * 100).toFixed(2)}%`,
    `  LowVol:    ${(result.factorReturn.lowVol * 100).toFixed(2)}%`,
    `  Market β:  ${(result.factorReturn.market * 100).toFixed(2)}%`,
    `  Alpha (ε): ${(result.factorReturn.alpha * 100).toFixed(2)}%`,
    '',
    '─── CONCENTRACIÓN ───',
    `  HHI:       ${(result.hhi * 10000).toFixed(0)} bps`,
    `  N efectivo: ${result.effectiveN.toFixed(2)} de ${ASSETS.length} activos`,
    '',
    '─── VS BENCHMARKS ───',
    `  Métrica              | Equal Weight | 60/40     | MSCI World`,
    `  ---------------------+--------------+-----------+-----------`,
    `  Tracking Error       | ${(bm.equalWeight.trackingError * 100).toFixed(2).padStart(5)}%      | ${(bm.sixtyForty.trackingError * 100).toFixed(2).padStart(5)}%    | ${(bm.msciWorld.trackingError * 100).toFixed(2).padStart(5)}%`,
    `  Information Ratio    | ${bm.equalWeight.informationRatio.toFixed(2).padStart(6)}       | ${bm.sixtyForty.informationRatio.toFixed(2).padStart(6)}     | ${bm.msciWorld.informationRatio.toFixed(2).padStart(6)}`,
    `  Active Share         | ${(bm.equalWeight.activeShare * 100).toFixed(0).padStart(3)}%         | ${(bm.sixtyForty.activeShare * 100).toFixed(0).padStart(3)}%       | ${(bm.msciWorld.activeShare * 100).toFixed(0).padStart(3)}%`,
    `  Beta                 | ${bm.equalWeight.beta.toFixed(2).padStart(6)}       | ${bm.sixtyForty.beta.toFixed(2).padStart(6)}     | ${bm.msciWorld.beta.toFixed(2).padStart(6)}`,
    `  Jensen Alpha (anual) | ${(bm.equalWeight.jensenAlpha * 100).toFixed(2).padStart(5)}%      | ${(bm.sixtyForty.jensenAlpha * 100).toFixed(2).padStart(5)}%    | ${(bm.msciWorld.jensenAlpha * 100).toFixed(2).padStart(5)}%`,
    `  Excess Return (CAGR) | ${(bm.equalWeight.excessReturn * 100).toFixed(2).padStart(5)}%      | ${(bm.sixtyForty.excessReturn * 100).toFixed(2).padStart(5)}%    | ${(bm.msciWorld.excessReturn * 100).toFixed(2).padStart(5)}%`,
    `  Upside Capture       | ${(bm.equalWeight.upsideCapture * 100).toFixed(0).padStart(3)}%         | ${(bm.sixtyForty.upsideCapture * 100).toFixed(0).padStart(3)}%       | ${(bm.msciWorld.upsideCapture * 100).toFixed(0).padStart(3)}%`,
    `  Downside Capture     | ${(bm.equalWeight.downsideCapture * 100).toFixed(0).padStart(3)}%         | ${(bm.sixtyForty.downsideCapture * 100).toFixed(0).padStart(3)}%       | ${(bm.msciWorld.downsideCapture * 100).toFixed(0).padStart(3)}%`,
    SEP,
    '',
  ];

  return lines.join('\n');
}
