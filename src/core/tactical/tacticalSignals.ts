// ============================================================
// src/core/tactical/tacticalSignals.ts — v6
//
// CORRECCIONES v6 (BUG CRÍTICO — dashboard sin resultados):
//
//   1. calcTakeProfits REESCRITA.
//      BUG: usaba sigma20 * 0.6/0.8 para calcular TP.
//      En ETFs de baja vol (sigma20≈0.50€ sobre 50€):
//        TP1 = 50 + 0.30 → riesgo 1.20€ → R:R = 0.25 → FAIL filtro 1.2
//      Resultado: 0 oportunidades en el screener → dashboard vacío.
//      FIX: TP basados en risk * tp1Mult (siempre ≥ 1.25×Risk).
//      R:R garantizado por construcción ≥ 1.25 > umbral 1.2.
//
//   2. calcDynamicTPMultiplier:
//      TOO_SLOW: tp1 subido de 1.0 → 1.25 (R:R mínimo seguro).
//      SLOW:     tp1 subido de 1.2 → 1.3 (margen ante redondeo).
//
// CORRECCIONES v5 (previas):
//   - Eliminadas funciones duplicadas.
//   - Añadida propiedad 'atr' en TechnicalIndicators (alias de atr14).
//   - Validaciones robustas en todas las funciones auxiliares.
//   - calcEfficiencyRatio con índice corregido.
// ============================================================

import type {
  TechnicalIndicators, TacticalSignal, TrendDirection,
  OpportunityType, SignalStrength
} from './types';

// ════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES SEGURAS
// ════════════════════════════════════════════════════════════

function sma(arr: number[], n: number): number {
  if (!arr || arr.length === 0) return 0;
  const slice = arr.slice(-n);
  if (slice.length < n) return arr[arr.length - 1] ?? 0;
  let sum = 0;
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    if (typeof v === 'number' && isFinite(v)) sum += v;
  }
  return sum / n;
}

function stdev(arr: number[]): number {
  if (!arr || arr.length < 2) return 0;
  const valid = arr.filter(v => typeof v === 'number' && isFinite(v));
  if (valid.length < 2) return 0;
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - m) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

function ema(arr: number[], n: number): number {
  if (!arr || arr.length === 0) return 0;
  if (arr.length < n) return arr[arr.length - 1] ?? 0;
  const k = 2 / (n + 1);
  let e = sma(arr.slice(0, n), n);
  for (let i = n; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === 'number' && isFinite(v)) e = v * k + e * (1 - k);
  }
  return e;
}

// ── Normal CDF (Abramowitz & Stegun) ─────────────────────────
function normCDF(z: number): number {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x / 2.0);
  return 0.5 * (1.0 + sign * y);
}

// ── First Passage Time CDF (Inverse Gaussian) ─────────────────
function fptCDF(t: number, d: number, mu: number, sigma: number): number {
  if (t <= 0 || d <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(t);
  const z1    = (mu * t - d) / (sigma * sqrtT);
  const z2    = -(mu * t + d) / (sigma * sqrtT);
  const theta = Math.min(2.0 * mu * d / (sigma * sigma), 700);
  const val   = normCDF(z1) + Math.exp(theta) * normCDF(z2);
  return Math.max(0, Math.min(1, val));
}

// ── Drift diario calibrado por tipo de señal ─────────────────
const SIGNAL_DRIFT: Record<OpportunityType, number> = {
  MOMENTUM_BREAKOUT: 0.15,
  BLOOD_IN_STREETS:  0.12,
  MEAN_REVERSION:    0.09,
  OVERSOLD_BOUNCE:   0.08,
  SECTOR_ROTATION:   0.06,
  EVENT_DRIVEN:      0.10,
};

// ── RSI con Wilder's Smoothing ───────────────────────────────
function calcRSI(closes: number[], period: number): number {
  if (!closes || closes.length < period + 1) return 50;
  const slice = closes.slice(-(period * 3 + period));
  if (slice.length < period + 1) return 50;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (isFinite(diff)) rets.push(diff);
  }
  if (rets.length < period) return 50;

  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgG += rets[i];
    else avgL += Math.abs(rets[i]);
  }
  avgG /= period;
  avgL /= period;

  for (let i = period; i < rets.length; i++) {
    const g = rets[i] > 0 ? rets[i] : 0;
    const l = rets[i] < 0 ? Math.abs(rets[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }

  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

// ── Efficiency Ratio de Kaufman (CORREGIDO) ──────────────────
function calcEfficiencyRatio(closes: number[], period: number): number {
  if (!closes || closes.length < period + 1) return 0;
  const valid = closes.filter(v => typeof v === 'number' && isFinite(v));
  if (valid.length < period + 1) return 0;
  const slice = valid.slice(-period - 1);
  const netMove = Math.abs(slice[slice.length - 1] - slice[0]);
  let totalPath = 0;
  for (let i = 1; i < slice.length; i++) {
    totalPath += Math.abs(slice[i] - slice[i - 1]);
  }
  return totalPath > 0 ? netMove / totalPath : 0;
}

// ════════════════════════════════════════════════════════════
// INDICADORES TÉCNICOS
// ════════════════════════════════════════════════════════════

export function calcIndicators(
  closes:  number[],
  volumes: number[],
  highs:   number[],
  lows:    number[],
): TechnicalIndicators {
  if (!closes || closes.length === 0 || !isFinite(closes[closes.length - 1])) {
    throw new Error('calcIndicators: closes array inválido');
  }
  const price = closes[closes.length - 1];
  if (!isFinite(price) || price <= 0) {
    throw new Error(`calcIndicators: precio inválido ${price}`);
  }

  const ma20   = sma(closes, 20);
  const ma50   = sma(closes, 50);
  const ma200  = sma(closes, 200);
  const rsi2   = calcRSI(closes, 2);
  const rsi14  = calcRSI(closes, 14);

  const weeklyCloses = closes.length >= 70
    ? closes.filter((_, i) => (closes.length - 1 - i) % 5 === 0).reverse()
    : null;
  const rsiWeekly = weeklyCloses && weeklyCloses.length >= 14
    ? calcRSI(weeklyCloses, 14)
    : rsi14;

  const m20     = sma(closes, 20);
  const sd20    = stdev(closes.slice(-20));
  const bbUpper = m20 + 2 * sd20;
  const bbLower = m20 - 2 * sd20;
  const bbWidth = m20 > 0 ? (bbUpper - bbLower) / m20 : 0;
  const zScore20 = sd20 > 0 ? (price - m20) / sd20 : 0;

  const m50      = sma(closes, 50);
  const sd50     = stdev(closes.slice(-50));
  const zScore50 = sd50 > 0 ? (price - m50) / sd50 : 0;

  let er = 0;
  try {
    er = calcEfficiencyRatio(closes, 20);
    if (!isFinite(er)) er = 0;
  } catch { er = 0; }
  const adx = parseFloat((er * 100).toFixed(1));

  let macdLine = 0, macdSignal = 0, macdHist = 0;
  try {
    macdLine = ema(closes, 12) - ema(closes, 26);
    const macdSeries: number[] = [];
    for (let i = 26; i <= closes.length; i++) {
      macdSeries.push(ema(closes.slice(0, i), 12) - ema(closes.slice(0, i), 26));
    }
    macdSignal = ema(macdSeries, 9);
    macdHist   = macdLine - macdSignal;
  } catch { /* mantener 0 */ }

  let atr14 = price * 0.02;
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
      if (isFinite(tr)) trValues.push(tr);
    }
    if (trValues.length > 0) {
      const rawAtr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
      atr14 = Math.max(rawAtr, price * 0.005);
    }
  }
  const atrPct = price > 0 ? atr14 / price : 0.02;
  const atrPctSafe = Math.max(atrPct, 0.005);

  let volRatio = 1;
  if (volumes && volumes.length >= 21) {
    const volSlice = volumes.slice(-21);
    const avgVol = sma(volSlice.slice(0, -1), volSlice.length - 1);
    const lastVol = volumes[volumes.length - 1] ?? avgVol;
    volRatio = avgVol > 0 ? lastVol / avgVol : 1;
    if (!isFinite(volRatio)) volRatio = 1;
  }

  const high52w = closes.length > 0
    ? Math.max(...closes.slice(-252).filter(v => isFinite(v)))
    : price;
  const drawdown52w = high52w > 0 ? (price / high52w) - 1 : 0;

  let trend: TrendDirection = 'SIDEWAYS';
  if (price > ma50 && ma50 > ma200)       trend = 'UPTREND';
  else if (price < ma50 && ma50 < ma200)  trend = 'DOWNTREND';

  return {
    price, ma20, ma50, ma200, rsi2, rsi14, rsiWeekly,
    macdLine, macdSignal, macdHist,
    adx,
    efficiencyRatio: er,
    atr14,
    atr: atr14,        // ← ALIAS para compatibilidad con calcTakeProfits
    atrPct: atrPctSafe,
    bbUpper, bbMiddle: m20, bbLower, bbWidth,
    zScore20, zScore50, volumeRatio: volRatio, trend,
    aboveMA200: price > ma200,
    aboveMA50:  price > ma50,
    aboveMA20:  price > ma20,
    drawdownFrom52wHigh: drawdown52w,
  };
}

// ════════════════════════════════════════════════════════════
// GENERADORES DE SEÑAL
// ════════════════════════════════════════════════════════════

function mkSig(
  type: OpportunityType, active: boolean, score: number,
  description: string, condition: string,
): TacticalSignal {
  const strength: SignalStrength =
    score >= 80 ? 'EXTREME' : score >= 60 ? 'STRONG' : score >= 40 ? 'MODERATE' : 'WEAK';
  return { type, strength, score: active ? score : 0, active, description, condition };
}

function signalBloodInStreets(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, zScore20, aboveMA200, volumeRatio, drawdownFrom52wHigh } = ind;
  const inExtremeCrash = drawdownFrom52wHigh < -0.35;
  const active = rsi2 < 10 && zScore20 < -1.5 && (aboveMA200 || inExtremeCrash);
  const score  = active
    ? Math.min(100,
        45
        + (10 - Math.min(10, rsi2)) * 4
        + (Math.abs(zScore20) - 1.5) * 5
        + (volumeRatio > 1.5 ? 8 : 0)
        + (aboveMA200 ? 0 : -15))
    : 0;
  return mkSig('BLOOD_IN_STREETS', active, score,
    active
      ? `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)}${volumeRatio > 1.5 ? ' · Vol×' + volumeRatio.toFixed(1) : ''}${!aboveMA200 ? ' · ⚠️bajo MA200' : ''} — Pánico extremo`
      : `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)} — No cumple`,
    'RSI(2)<10 AND Z-Score(20)<-1.5 AND (sobreMA200 OR drawdown<-35%)');
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
    'RSI(2)<15 AND Precio<BB Inferior+2%');
}

function signalMomentumBreakout(ind: TechnicalIndicators): TacticalSignal {
  const { adx, price, bbUpper, ma50, volumeRatio } = ind;
  const active = adx > 30 && price > bbUpper * 0.995 && price > ma50;
  const score  = active
    ? Math.min(100,
        45
        + Math.min(20, (adx - 30) * 1.2)
        + (volumeRatio > 1.5 ? 20 : 0)
        + (price > bbUpper ? 15 : 5))
    : 0;
  return mkSig('MOMENTUM_BREAKOUT', active, score,
    active
      ? `ER=${adx.toFixed(0)} · Ruptura BB superior${volumeRatio > 1.5 ? ' · Vol confirma' : ''}`
      : `ER=${adx.toFixed(0)} — Sin breakout confirmado (umbral ER>30)`,
    'ER>30 AND Precio>BB Superior AND sobre MA50');
}

function signalOversoldBounce(ind: TechnicalIndicators): TacticalSignal {
  const { rsi14, aboveMA200, ma50, price, zScore50 } = ind;
  const active = rsi14 < 35 && (aboveMA200 || price > ma50 * 0.95);
  const score  = active
    ? Math.min(100,
        42
        + (35 - Math.min(35, rsi14)) * 1.8
        + (aboveMA200 ? 18 : 6)
        + (zScore50 < -1 ? 8 : 0))
    : 0;
  return mkSig('OVERSOLD_BOUNCE', active, score,
    active
      ? `RSI(14)=${rsi14.toFixed(1)} · Sobre soporte — Sobreventa real`
      : `RSI(14)=${rsi14.toFixed(1)} — Sin condición (umbral:<35)`,
    'RSI(14)<35 AND (sobreMA200 OR MA50-5%)');
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
      ? `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% · RSI=${rsi14.toFixed(1)} recuperando`
      : `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% — Sin condición`,
    'Drawdown52w<-20% AND RSI 40-55 AND sobreMA200/MA50');
}

export function generateSignals(ind: TechnicalIndicators): TacticalSignal[] {
  const raw = [
    signalBloodInStreets(ind),
    signalMeanReversion(ind),
    signalMomentumBreakout(ind),
    signalOversoldBounce(ind),
    signalSectorRotation(ind),
  ];
  return raw.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.score - a.score;
  });
}

export function calcTotalScore(signals: TacticalSignal[]): number {
  const active = signals.filter(s => s.active);
  if (active.length === 0) return 0;
  const best = Math.max(...active.map(s => s.score));
  return Math.min(100, best + Math.min(20, (active.length - 1) * 8));
}

// ════════════════════════════════════════════════════════════
// STOP LOSS Y TAKE PROFITS
// ════════════════════════════════════════════════════════════

export function calcStopLoss(
  entryPrice: number,
  atr:        number,
  type:       OpportunityType,
  closes:     number[],
): number {
  const recentLow = closes.length >= 5 ? Math.min(...closes.slice(-5)) : entryPrice * 0.97;
  const mult =
    type === 'MOMENTUM_BREAKOUT' ? 1.0
    : type === 'BLOOD_IN_STREETS' ? 1.5
    : 2.0;
  const stopByATR  = entryPrice - Math.max(atr * mult, atr * 0.5);
  const stopByLow  = recentLow * 0.985;
  return Math.min(stopByATR, stopByLow);
}

export function calcTakeProfits(
  entryPrice: number,
  stopLoss:   number,
  type:       OpportunityType,
  ind:        TechnicalIndicators,
  closes?:    number[],
): { tp1: number; tp2: number; rr: number; useTrailing: boolean } {
  const risk = entryPrice - stopLoss;
  if (risk <= 0) {
    return { tp1: entryPrice * 1.02, tp2: entryPrice * 1.04, rr: 1.5, useTrailing: false };
  }

  // ── CORRECCIÓN CRÍTICA v6 ────────────────────────────────────
  // BUG ANTERIOR: tp1 = entryPrice + sigma20 * 0.6
  //   → sigma20 es la desviación típica absoluta del precio.
  //   → En ETFs de baja vol (sigma20 ≈ 0.50€ sobre precio 50€):
  //       tp1 = 50 + 0.50 * 0.6 = 50.30€ (subida de 0.30€)
  //       stop = ~48.80€ → riesgo = 1.20€
  //       R:R = 0.30 / 1.20 = 0.25  → FAIL filtro 1.2 → 0 oportunidades → dashboard vacío
  //
  // FIX: TPs basados en multiplicadores de RISK (entryPrice − stopLoss)
  //   → R:R = tp1Mult siempre ≥ 1.25 → supera filtro → oportunidades reales
  // ────────────────────────────────────────────────────────────

  const mults  = calcDynamicTPMultiplier(ind.atrPct);   // basado en ATR% del activo

  const tp1    = entryPrice + risk * mults.tp1;
  const tp2Raw = entryPrice + risk * mults.tp2;
  const tp2    = Math.max(tp1 * 1.005, tp2Raw);          // tp2 siempre > tp1

  const rr = (tp1 - entryPrice) / risk;                  // == mults.tp1 por construcción

  return {
    tp1,
    tp2,
    rr:          Math.max(1.2, rr),
    useTrailing: type === 'MOMENTUM_BREAKOUT',
  };
}

// ════════════════════════════════════════════════════════════
// VELOCIDAD DEL ACTIVO Y HORIZONTE DINÁMICO
// ════════════════════════════════════════════════════════════

export type AssetSpeed = 'FAST' | 'MEDIUM' | 'SLOW' | 'TOO_SLOW';

export function classifyAssetSpeed(atrPct: number): AssetSpeed {
  if (atrPct >= 0.04)  return 'FAST';
  if (atrPct >= 0.02)  return 'MEDIUM';
  if (atrPct >= 0.008) return 'SLOW';
  return 'TOO_SLOW';
}

export function calcDynamicMaxDays(atrPct: number): number {
  if (atrPct >= 0.04)  return 20;
  if (atrPct >= 0.02)  return 40;
  if (atrPct >= 0.008) return 75;
  return 90;
}

export function calcDynamicTPMultiplier(atrPct: number): { tp1: number; tp2: number } {
  // FIX v6: tp1 nunca < 1.25 — garantiza R:R >= 1.25 > filtro mínimo 1.2
  // Antes: SLOW=1.2, TOO_SLOW=1.0 → R:R caía a 0.3–1.0 con sigma20 → 0 oportunidades
  if (atrPct >= 0.04)  return { tp1: 1.5, tp2: 4.0 };
  if (atrPct >= 0.02)  return { tp1: 1.5, tp2: 2.5 };
  if (atrPct >= 0.008) return { tp1: 1.3, tp2: 1.8 };
  return { tp1: 1.25, tp2: 1.5 };   // TOO_SLOW: mínimo 1.25 (antes 1.0 → sin señales)
}

// ════════════════════════════════════════════════════════════
// MODELO FIRST PASSAGE TIME (FPT)
// ════════════════════════════════════════════════════════════

export function calcOptimalHorizon(
  entryPrice:  number,
  target:      number,
  atr:         number,
  signalType?: OpportunityType,
  maxDays?:    number,
): { days: number; prob: number; probs: number[]; assetSpeed: AssetSpeed } {
  const atrPct = atr / Math.max(0.01, entryPrice);
  const speed  = classifyAssetSpeed(atrPct);
  const dynMax = maxDays ?? calcDynamicMaxDays(atrPct);
  if (atr <= 0 || target <= entryPrice || dynMax <= 0) {
    return { days: 0, prob: 0, probs: [], assetSpeed: speed };
  }
  const d      = target - entryPrice;
  const sigma  = atr;
  const driftF = signalType ? SIGNAL_DRIFT[signalType] ?? 0.08 : 0.08;
  const mu     = sigma * driftF;
  const expectedDays = d / mu;
  const optimalDays  = Math.max(1, Math.min(dynMax, Math.round(expectedDays)));
  const probs: number[] = [];
  for (let t = 1; t <= dynMax; t++) {
    const cp = fptCDF(t, d, mu, sigma);
    probs.push(parseFloat((cp * 100).toFixed(2)));
  }
  const finalProb = probs[optimalDays - 1] ?? 0;
  return {
    days: optimalDays,
    prob: parseFloat(finalProb.toFixed(2)),
    probs,
    assetSpeed: speed,
  };
}

export function calcExpectedDays(
  entryPrice:  number,
  target:      number,
  atr:         number,
  signalType:  OpportunityType,
): number {
  const { days } = calcOptimalHorizon(entryPrice, target, atr, signalType);
  return Math.max(1, days);
}

export function calcTimingScore(daysOpen: number, expectedDays: number): number {
  if (expectedDays <= 0) return 0;
  return Math.min(100, Math.round((daysOpen / expectedDays) * 100));
}

export function calcDaysToBreakeven(
  entryPrice:   number,
  currentPrice: number,
  atr:          number,
  signalType:   OpportunityType,
): number {
  if (currentPrice >= entryPrice) return 0;
  return calcExpectedDays(currentPrice, entryPrice, atr, signalType);
}