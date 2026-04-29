// ============================================================
// src/core/tactical/tacticalSignals.ts — v3 ELITE
// CORRECCIÓN CRÍTICA:
//   - calcOptimalHorizon: el loop usaba `maxDays` (param opcional)
//     en vez de `dynMax` (el horizonte calculado dinámicamente).
//     Resultado: activos SLOW siempre devolvían día 10 porque
//     el loop solo iteraba hasta maxDays=20 (valor fijo pasado
//     desde tacticalPortfolio). Ahora `dynMax` manda siempre.
//   - calcTakeProfits: usa calcDynamicTPMultiplier para ajustar
//     targets según la velocidad del activo (SLOW → targets más
//     modestos y alcanzables).
//   - calcStopLoss: suelo de 0.5×ATR para evitar stops demasiado
//     ajustados en activos de baja volatilidad.
// ============================================================

import type {
  TechnicalIndicators, TacticalSignal, TrendDirection,
  OpportunityType, SignalStrength
} from './types';

// ── Matemáticas internas ──────────────────────────────────────
export function calcRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  const slice = closes.slice(-(period + 20));
  const rets  = slice.map((c, i, a) => i === 0 ? 0 : c - a[i - 1]).slice(1);
  if (rets.length < period) return 50;
  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgG += rets[i]; else avgL += Math.abs(rets[i]);
  }
  avgG /= period; avgL /= period;
  for (let i = period; i < rets.length; i++) {
    const g = rets[i] > 0 ? rets[i] : 0;
    const l = rets[i] < 0 ? Math.abs(rets[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

function sma(arr: number[], n: number): number {
  const s = arr.slice(-n);
  if (s.length < n) return arr[arr.length - 1] ?? 0;
  return s.reduce((a, b) => a + b, 0) / n;
}
function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function ema(arr: number[], n: number): number {
  if (arr.length < n) return arr[arr.length - 1] ?? 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// ── Indicadores técnicos ──────────────────────────────────────
export function calcIndicators(
  closes:  number[],
  volumes: number[],
  highs:   number[],
  lows:    number[],
): TechnicalIndicators {
  const price  = closes[closes.length - 1];
  const ma20   = sma(closes, 20);
  const ma50   = sma(closes, 50);
  const ma200  = sma(closes, 200);
  const rsi2   = calcRSI(closes, 2);
  const rsi14  = calcRSI(closes, 14);
  const rsiWeekly = closes.length >= 70
    ? calcRSI(closes.filter((_, i) => i % 5 === 0), 14)
    : rsi14;

  const sl20    = closes.slice(-20);
  const m20     = sl20.reduce((a, b) => a + b, 0) / sl20.length;
  const sd20    = stdev(sl20);
  const bbUpper = m20 + 2 * sd20;
  const bbLower = m20 - 2 * sd20;
  const bbWidth = m20 > 0 ? (bbUpper - bbLower) / m20 : 0;
  const zScore20 = sd20 > 0 ? (price - m20) / sd20 : 0;

  const sl50    = closes.slice(-50);
  const m50     = sl50.reduce((a, b) => a + b, 0) / sl50.length;
  const sd50    = stdev(sl50);
  const zScore50 = sd50 > 0 ? (price - m50) / sd50 : 0;

  const retsAbs = closes.slice(-20)
    .map((c, i, a) => i === 0 ? 0 : Math.abs(c - a[i - 1]) / a[i - 1])
    .slice(1);
  const adx = (retsAbs.reduce((a, b) => a + b, 0) / retsAbs.length) * 1000;

  const macdLine   = ema(closes, 12) - ema(closes, 26);
  const macdSeries: number[] = [];
  for (let i = 26; i <= closes.length; i++) {
    macdSeries.push(ema(closes.slice(0, i), 12) - ema(closes.slice(0, i), 26));
  }
  const macdSignal = ema(macdSeries, 9);
  const macdHist   = macdLine - macdSignal;

  // ATR14 real (True Range con highs/lows reales o aproximados)
  let atr14 = 0;
  const n = Math.min(closes.length, highs.length, lows.length);
  if (n >= 15) {
    const trValues: number[] = [];
    for (let i = n - 14; i < n; i++) {
      const prevClose = closes[i - 1] ?? closes[i];
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - prevClose),
        Math.abs(lows[i]  - prevClose),
      );
      trValues.push(tr);
    }
    const rawAtr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
    atr14 = Math.max(rawAtr, price * 0.005);
  } else {
    atr14 = price * 0.02;
  }

  const atrPct     = price > 0 ? atr14 / price : 0.02;
  const atrPctSafe = Math.max(atrPct, 0.005);

  const volSlice = volumes.slice(-21);
  const avgVol   = sma(volSlice.slice(0, -1), 20);
  const volRatio = avgVol > 0 ? (volumes[volumes.length - 1] ?? avgVol) / avgVol : 1;

  const high52w     = Math.max(...closes.slice(-252));
  const drawdown52w = high52w > 0 ? (price / high52w) - 1 : 0;

  let trend: TrendDirection = 'SIDEWAYS';
  if (price > ma50 && ma50 > ma200)       trend = 'UPTREND';
  else if (price < ma50 && ma50 < ma200)  trend = 'DOWNTREND';

  return {
    price, ma20, ma50, ma200, rsi2, rsi14, rsiWeekly,
    macdLine, macdSignal, macdHist, adx, atr14, atrPct: atrPctSafe,
    bbUpper, bbMiddle: m20, bbLower, bbWidth,
    zScore20, zScore50, volumeRatio: volRatio, trend,
    aboveMA200: price > ma200,
    aboveMA50:  price > ma50,
    aboveMA20:  price > ma20,
    drawdownFrom52wHigh: drawdown52w,
  };
}

// ── Generadores de señal ──────────────────────────────────────
function mkSig(
  type: OpportunityType, active: boolean, score: number,
  description: string, condition: string,
): TacticalSignal {
  const strength: SignalStrength =
    score >= 80 ? 'EXTREME' : score >= 60 ? 'STRONG' : score >= 40 ? 'MODERATE' : 'WEAK';
  return { type, strength, score: active ? score : 0, active, description, condition };
}

function signalBloodInStreets(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, zScore20, aboveMA200, volumeRatio } = ind;
  const active = rsi2 < 10 && zScore20 < -1.5 && aboveMA200;
  const score  = active
    ? Math.min(100,
        45
        + (10 - Math.min(10, rsi2)) * 4
        + (Math.abs(zScore20) - 1.5) * 5
        + (volumeRatio > 1.5 ? 8 : 0))
    : 0;
  return mkSig('BLOOD_IN_STREETS', active, score,
    active
      ? `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)}${volumeRatio > 1.5 ? ' · Vol×' + volumeRatio.toFixed(1) : ''} — Pánico de compra`
      : `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)} — No cumple`,
    'RSI(2) < 10 AND Z-Score(20) < -1.5 AND sobre MA200');
}

function signalMeanReversion(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, bbLower, price, zScore20 } = ind;
  const active = rsi2 < 15 && price < bbLower * 1.02;
  const score  = active
    ? Math.min(100,
        40
        + (15 - Math.min(15, rsi2)) * 2
        + (price < bbLower ? 12 : 4)
        + (zScore20 < -1.5 ? 8 : 0))
    : 0;
  return mkSig('MEAN_REVERSION', active, score,
    active
      ? `RSI(2)=${rsi2.toFixed(1)} · €${price.toFixed(2)} bajo BB(€${bbLower.toFixed(2)}) — Vuelta a la media`
      : `RSI(2)=${rsi2.toFixed(1)} · BBI=€${bbLower.toFixed(2)} — Sin condición`,
    'RSI(2) < 15 AND Precio < BB Inferior +2%');
}

function signalMomentumBreakout(ind: TechnicalIndicators): TacticalSignal {
  const { adx, price, bbUpper, ma50, volumeRatio } = ind;
  const active = adx > 20 && price > bbUpper * 0.995 && price > ma50;
  const score  = active
    ? Math.min(100,
        45
        + Math.min(20, (adx - 20) * 1.5)
        + (volumeRatio > 1.5 ? 20 : 0)
        + (price > bbUpper ? 15 : 5))
    : 0;
  return mkSig('MOMENTUM_BREAKOUT', active, score,
    active
      ? `ADX=${adx.toFixed(0)} · Ruptura BB superior${volumeRatio > 1.5 ? ' · Vol confirma' : ''}`
      : `ADX=${adx.toFixed(0)} — Sin breakout confirmado`,
    'ADX > 20 AND Precio > BB Superior AND sobre MA50');
}

function signalOversoldBounce(ind: TechnicalIndicators): TacticalSignal {
  const { rsi14, aboveMA200, ma50, price, zScore50 } = ind;
  const active = rsi14 < 45 && (aboveMA200 || price > ma50 * 0.95);
  const score  = active
    ? Math.min(100,
        38
        + (45 - Math.min(45, rsi14)) * 1.2
        + (aboveMA200 ? 18 : 6)
        + (zScore50 < -1 ? 8 : 0))
    : 0;
  return mkSig('OVERSOLD_BOUNCE', active, score,
    active
      ? `RSI(14)=${rsi14.toFixed(1)} · Sobre soporte — Rebote técnico probable`
      : `RSI(14)=${rsi14.toFixed(1)} — Sin condición`,
    'RSI(14) < 45 AND sobre MA200 o MA50-5%');
}

function signalSectorRotation(ind: TechnicalIndicators): TacticalSignal {
  const { drawdownFrom52wHigh, rsi14, aboveMA200, price, ma50 } = ind;
  const active = drawdownFrom52wHigh < -0.20 && rsi14 > 40 && rsi14 < 55
    && (aboveMA200 || price > ma50);
  const score  = active
    ? Math.min(100,
        40
        + Math.min(25, (Math.abs(drawdownFrom52wHigh) - 0.20) * 100)
        + (aboveMA200 ? 20 : 5)
        + 15)
    : 0;
  return mkSig('SECTOR_ROTATION', active, score,
    active
      ? `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% · RSI=${rsi14.toFixed(1)} recuperando — Rotación sectorial`
      : `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% — Sin condición`,
    'Drawdown52w < -20% AND RSI 40-55 AND sobre MA200/MA50');
}

export function generateSignals(ind: TechnicalIndicators): TacticalSignal[] {
  return [
    signalBloodInStreets(ind),
    signalMeanReversion(ind),
    signalMomentumBreakout(ind),
    signalOversoldBounce(ind),
    signalSectorRotation(ind),
  ];
}

export function calcTotalScore(signals: TacticalSignal[]): number {
  const active = signals.filter(s => s.active);
  if (active.length === 0) return 0;
  const best = Math.max(...active.map(s => s.score));
  return Math.min(100, best + Math.min(20, (active.length - 1) * 8));
}

// ── Stop Loss ─────────────────────────────────────────────────
export function calcStopLoss(
  entryPrice: number,
  atr:        number,
  type:       OpportunityType,
  closes:     number[],
): number {
  const recentLow = Math.min(...closes.slice(-5));
  const mult =
    type === 'MOMENTUM_BREAKOUT' ? 1.0
    : type === 'BLOOD_IN_STREETS' ? 1.5
    : 2.0;
  // CORRECCIÓN: suelo mínimo de 0.5×ATR para evitar stops irreales en activos lentos
  const stopByATR  = entryPrice - Math.max(atr * mult, atr * 0.5);
  const stopByLow  = recentLow * 0.985;
  return Math.min(stopByATR, stopByLow);
}

// ── Take Profits — ajustados por velocidad del activo ─────────
// CORRECCIÓN: usa calcDynamicTPMultiplier para que activos SLOW
// tengan targets realistas (antes siempre usaba 1.5×R y 4×R sin importar ATR).
export function calcTakeProfits(
  entryPrice: number,
  stopLoss:   number,
  type:       OpportunityType,
  ind:        TechnicalIndicators,
): { tp1: number; tp2: number; rr: number; useTrailing: boolean } {
  const risk = entryPrice - stopLoss;
  const mult = calcDynamicTPMultiplier(ind.atrPct);

  const tp1 = entryPrice + risk * mult.tp1;
  const tp2 =
    type === 'MEAN_REVERSION'
      ? Math.min(entryPrice + risk * mult.tp2, ind.ma20)
      : entryPrice + risk * mult.tp2;

  return {
    tp1,
    tp2,
    rr: mult.tp1,
    useTrailing: type === 'MOMENTUM_BREAKOUT',
  };
}

// ════════════════════════════════════════════════════════════
// VELOCIDAD DEL ACTIVO Y HORIZONTE DINÁMICO
// ════════════════════════════════════════════════════════════

export type AssetSpeed = 'FAST' | 'MEDIUM' | 'SLOW' | 'TOO_SLOW';

/** Clasifica el activo por su ATR diario como % del precio */
export function classifyAssetSpeed(atrPct: number): AssetSpeed {
  if (atrPct >= 0.04)  return 'FAST';      // >4%/día — crypto, semis, high-beta
  if (atrPct >= 0.02)  return 'MEDIUM';    // 2-4%/día — acciones vol., ETFs sectoriales
  if (atrPct >= 0.008) return 'SLOW';      // 0.8-2%/día — ETFs amplios, oro, bonos
  return 'TOO_SLOW';                        // <0.8%/día — no apto para trading táctico
}

/**
 * Horizonte máximo dinámico según velocidad.
 * Un activo lento necesita más días para recorrer la misma distancia en ATRs.
 * Antes esto era FIJO en 20/30 días → todos los activos lentos mostraban "día 10".
 */
export function calcDynamicMaxDays(atrPct: number): number {
  if (atrPct >= 0.04)  return 20;    // FAST
  if (atrPct >= 0.02)  return 40;    // MEDIUM
  if (atrPct >= 0.008) return 75;    // SLOW
  return 90;                          // TOO_SLOW
}

/**
 * Multiplicadores de TP según velocidad.
 * Activos lentos necesitan targets más modestos para tener probabilidades razonables.
 */
export function calcDynamicTPMultiplier(atrPct: number): { tp1: number; tp2: number } {
  if (atrPct >= 0.04)  return { tp1: 1.5, tp2: 4.0 };   // FAST
  if (atrPct >= 0.02)  return { tp1: 1.5, tp2: 2.5 };   // MEDIUM
  if (atrPct >= 0.008) return { tp1: 1.2, tp2: 1.8 };   // SLOW
  return { tp1: 1.0, tp2: 1.5 };                          // TOO_SLOW
}

// ── Función de distribución normal acumulada ──────────────────
function erfApprox(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t
    - 0.284496736)*t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCDF(z: number): number {
  return 0.5 * (1 + erfApprox(z / Math.SQRT2));
}

/**
 * calcOptimalHorizon — VERSIÓN CORREGIDA
 *
 * BUG ORIGINAL: el loop `for (let days = 1; days <= maxDays; ...)` usaba
 * el parámetro `maxDays` (que llegaba fijo en 20 desde tacticalPortfolio),
 * ignorando `dynMax` que se calculaba internamente. El resultado era que
 * activos SLOW con dynMax=75 seguían viendo solo 20 días, y el máximo
 * siempre caía en el último día disponible (día 20 → mostraba "día 10"
 * cuando la curva aún subía).
 *
 * CORRECCIÓN: el loop ahora usa SIEMPRE `dynMax`. El parámetro `maxDays`
 * queda como override explícito (útil solo para tests o casos especiales).
 * Si no se pasa → se calcula dinámicamente según ATR.
 */
export function calcOptimalHorizon(
  entryPrice: number,
  target:     number,
  atr:        number,
  maxDays?:   number,   // Override explícito — omitir en producción normal
): { days: number; prob: number; probs: number[]; assetSpeed: AssetSpeed } {
  const atrPct = atr / Math.max(0.01, entryPrice);
  const speed  = classifyAssetSpeed(atrPct);

  // CORRECCIÓN CRÍTICA: dynMax se calcula desde ATR y se usa en el loop,
  // no el parámetro maxDays que llegaba fijo desde tacticalPortfolio.
  const dynMax = maxDays ?? calcDynamicMaxDays(atrPct);

  if (atr <= 0 || target <= entryPrice || dynMax <= 0) {
    return { days: 0, prob: 0, probs: [], assetSpeed: speed };
  }

  const calcProb = (days: number): number => {
    if (days <= 0) return 0;
    const z = (target - entryPrice) / (atr * Math.sqrt(days));
    return Math.max(0, Math.min(100, (1 - normCDF(z)) * 100));
  };

  let bestDays = 1;
  let bestProb = 0;
  const probs: number[] = [];

  // ✅ Loop usa dynMax — nunca el valor fijo que llegaba desde fuera
  for (let days = 1; days <= dynMax; days++) {
    const prob = calcProb(days);
    probs.push(parseFloat(prob.toFixed(2)));
    if (prob > bestProb) {
      bestProb = prob;
      bestDays = days;
    }
  }

  return {
    days:       bestDays,
    prob:       parseFloat(bestProb.toFixed(2)),
    probs,
    assetSpeed: speed,
  };
}
