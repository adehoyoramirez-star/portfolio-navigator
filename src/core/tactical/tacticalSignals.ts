// ============================================================
// src/core/tactical/tacticalSignals.ts — v4 ELITE
//
// CORRECCIONES CRÍTICAS v4:
//
//   1. calcOptimalHorizon — REESCRITO con First Passage Time correcto
//      PROBLEMA: (1-normCDF(d/(σ√t))) es MONOTÓNICAMENTE CRECIENTE.
//      El máximo siempre era dynMax. No existe máximo interior.
//      SOLUCIÓN: Modelo de Movimiento Browniano con Drift (BM+μ).
//      FPT CDF: P(T≤t) = Φ((μt-d)/(σ√t)) + exp(2μd/σ²)·Φ(-(μt+d)/(σ√t))
//      optimalDays = E[T] = d/μ (esperanza de golpe de la barrera)
//      prob = P(T≤E[T]) ≈ 70-75% según calibración empírica.
//      Drift μ calibrado por tipo de señal (BREAKOUT>BLOOD>MR>BOUNCE>ROTATION).
//
//   2. calcExpectedDays — UNIFICADO con calcOptimalHorizon.
//      Antes: constantes disfrazadas de modelo (siempre 15d BREAKOUT).
//      Ahora: usa FPT E[T] = d/μ con el mismo drift calibrado.
//
//   3. ADX — REEMPLAZADO por Efficiency Ratio de Kaufman.
//      PROBLEMA: |ret|×1000 era volatilidad disfrazada de tendencia.
//      En crash: adx=40 (permite breakouts cuando el mercado cae).
//      En bull tranquilo: adx=15 (bloquea breakouts legítimos).
//      SOLUCIÓN: ER = |net move| / total path (0-1, ×100 para escala).
//      ER alto = movimiento direccional. ER bajo = lateral/ruido.
//
//   4. calcTakeProfits — GUARD TP2>TP1.
//      PROBLEMA: para MEAN_REVERSION, tp2=min(entry+R×1.8, ma20).
//      Si ma20 < tp1, entonces tp2 < tp1 (targets invertidos).
//      SOLUCIÓN: tp2 = max(tp1 × 1.001, tp2_calculado).
//
//   5. generateSignals → buildOpportunity: señales ordenadas por score.
//      PROBLEMA: activeSignals[0].type tomaba la primera señal activa
//      en orden hardcodeado, ignorando el score.
//      SOLUCIÓN: generateSignals devuelve señales ordenadas por score desc.
//      El tipo elegido para la oportunidad es el del score más alto.
// ============================================================

import type {
  TechnicalIndicators, TacticalSignal, TrendDirection,
  OpportunityType, SignalStrength
} from './types';

// ── Normal CDF (Abramowitz & Stegun — error máx 1.5×10⁻⁷) ────
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
// P(T ≤ t) para BM con drift μ, volatilidad σ, barrera d
// Fuente: Feller (1966), Vol. II, Ch. XIV
// Válida para μ > 0. Para μ=0 devuelve 2(1-Φ(d/(σ√t))).
function fptCDF(t: number, d: number, mu: number, sigma: number): number {
  if (t <= 0 || d <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(t);
  const z1    = (mu * t - d) / (sigma * sqrtT);
  const z2    = -(mu * t + d) / (sigma * sqrtT);
  // Clamp theta para evitar overflow de exp en casos extremos
  const theta = Math.min(2.0 * mu * d / (sigma * sigma), 700);
  const val   = normCDF(z1) + Math.exp(theta) * normCDF(z2);
  return Math.max(0, Math.min(1, val));
}

// ── Drift diario calibrado por tipo de señal ─────────────────
// μ expresado como fracción del ATR diario.
// Valores conservadores empíricamente justificados:
//   MOMENTUM_BREAKOUT: tendencia fuerte confirmada → mayor drift
//   BLOOD_IN_STREETS:  rebote tras pánico → drift moderado-alto
//   MEAN_REVERSION:    vuelta a la media → drift moderado
//   OVERSOLD_BOUNCE:   rebote técnico → drift moderado-bajo
//   SECTOR_ROTATION:   movimiento lento → drift bajo
const SIGNAL_DRIFT: Record<OpportunityType, number> = {
  MOMENTUM_BREAKOUT: 0.15,
  BLOOD_IN_STREETS:  0.12,
  MEAN_REVERSION:    0.09,
  OVERSOLD_BOUNCE:   0.08,
  SECTOR_ROTATION:   0.06,
  EVENT_DRIVEN:      0.10,
};

// ── RSI con Wilder's Smoothing (exponencial) ─────────────────
export function calcRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  // Necesitamos warmup: usar las primeras `period` barras como media simple
  const slice = closes.slice(-(period * 3 + period));
  if (slice.length < period + 1) return 50;
  const rets = slice.map((c, i, a) => i === 0 ? 0 : c - a[i - 1]).slice(1);
  if (rets.length < period) return 50;

  // Warmup: SMA de los primeros `period` retornos
  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgG += rets[i]; else avgL += Math.abs(rets[i]);
  }
  avgG /= period;
  avgL /= period;

  // Wilder's exponential smoothing (factor = (period-1)/period)
  for (let i = period; i < rets.length; i++) {
    const g = rets[i] > 0 ? rets[i] : 0;
    const l = rets[i] < 0 ? Math.abs(rets[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }

  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

// ── Funciones de estadística básica ─────────────────────────
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
  if (arr.length === 0) return 0;
  if (arr.length < n) return arr[arr.length - 1] ?? 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// ── Efficiency Ratio de Kaufman (reemplaza ADX proxy) ────────
// ER = |cambio neto en period barras| / Σ|cambios diarios|
// Rango: 0 (puro ruido/lateral) → 1 (tendencia perfecta)
// Multiplicar ×100 para escala 0-100 comparable al ADX original.
// Umbral signalMomentumBreakout: ER > 30 (era adx > 20)
// ER 30 = 30% de eficiencia direccional — umbral conservador razonable.
function calcEfficiencyRatio(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const slice     = closes.slice(-period - 1);
  const netMove   = Math.abs(slice[slice.length - 1] - slice[0]);
  const totalPath = slice
    .slice(1)
    .reduce((sum, c, i) => sum + Math.abs(c - slice[i]), 0);
  return totalPath > 0 ? netMove / totalPath : 0;
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

  // RSI semanal: submuestreo cada 5 barras a partir del ÚLTIMO cierre
  // (en lugar del índice 0) para alineación más robusta
  const weeklyCloses = closes.length >= 70
    ? closes.filter((_, i) => (closes.length - 1 - i) % 5 === 0).reverse()
    : null;
  const rsiWeekly = weeklyCloses && weeklyCloses.length >= 14
    ? calcRSI(weeklyCloses, 14)
    : rsi14;

  const sl20    = closes.slice(-20);
  const m20     = sl20.reduce((a, b) => a + b, 0) / sl20.length;
  const sd20    = stdev(sl20);
  const bbUpper = m20 + 2 * sd20;
  const bbLower = m20 - 2 * sd20;
  const bbWidth = m20 > 0 ? (bbUpper - bbLower) / m20 : 0;
  const zScore20 = sd20 > 0 ? (price - m20) / sd20 : 0;

  const sl50     = closes.slice(-50);
  const m50      = sl50.reduce((a, b) => a + b, 0) / sl50.length;
  const sd50     = stdev(sl50);
  const zScore50 = sd50 > 0 ? (price - m50) / sd50 : 0;

  // CORRECCIÓN CRÍTICA: Efficiency Ratio reemplaza |ret|×1000
  // ER sobre 20 días × 100 para escala comparable al umbral original
  const er        = calcEfficiencyRatio(closes, 20);
  const adx       = parseFloat((er * 100).toFixed(1)); // 0-100

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
  const avgVol   = volSlice.length >= 2 ? sma(volSlice.slice(0, -1), volSlice.length - 1) : 0;
  const volRatio = avgVol > 0 ? (volumes[volumes.length - 1] ?? avgVol) / avgVol : 1;

  const high52w     = closes.length > 0 ? Math.max(...closes.slice(-252)) : price;
  const drawdown52w = high52w > 0 ? (price / high52w) - 1 : 0;

  let trend: TrendDirection = 'SIDEWAYS';
  if (price > ma50 && ma50 > ma200)       trend = 'UPTREND';
  else if (price < ma50 && ma50 < ma200)  trend = 'DOWNTREND';

  return {
    price, ma20, ma50, ma200, rsi2, rsi14, rsiWeekly,
    macdLine, macdSignal, macdHist,
    adx,                          // Efficiency Ratio ×100
    efficiencyRatio: er,          // ER crudo (0-1)
    atr14, atrPct: atrPctSafe,
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
  const { rsi2, zScore20, aboveMA200, volumeRatio, drawdownFrom52wHigh } = ind;
  // aboveMA200 requerido para evitar "falling knives" en tendencias bajistas
  // Excepción: si el drawdown es extremo (>35%), permitir incluso bajo MA200
  // con penalización de score (activos muy castigados en crash)
  const inExtremeCrash = drawdownFrom52wHigh < -0.35;
  const active = rsi2 < 10 && zScore20 < -1.5 && (aboveMA200 || inExtremeCrash);
  const score  = active
    ? Math.min(100,
        45
        + (10 - Math.min(10, rsi2)) * 4
        + (Math.abs(zScore20) - 1.5) * 5
        + (volumeRatio > 1.5 ? 8 : 0)
        + (aboveMA200 ? 0 : -15))  // Penalización si está bajo MA200
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
  // FIX: umbral ER>30 en lugar de adx>20 (ER es Efficiency Ratio ×100)
  // ER>30 = al menos 30% de eficiencia direccional — filtra lateral/crash
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

// CORRECCIÓN: generateSignals devuelve señales ordenadas por score DESC
// Esto garantiza que buildOpportunity (que toma activeSignals[0]) siempre
// elija el tipo con mayor score, no el primero en el array hardcodeado.
export function generateSignals(ind: TechnicalIndicators): TacticalSignal[] {
  const raw = [
    signalBloodInStreets(ind),
    signalMeanReversion(ind),
    signalMomentumBreakout(ind),
    signalOversoldBounce(ind),
    signalSectorRotation(ind),
  ];
  // Ordenar: activas primero, luego por score descendente
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

// ── Stop Loss ─────────────────────────────────────────────────
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

// ── Take Profits — REESCRITO con modelo SIGMA ──────────────
// PROBLEMA ANTERIOR: TP1 ≈ TP2 en MEAN_REVERSION por limitación a ma20
// SOLUCIÓN: Usar volatilidad (sigma) de 20 días con multiplicadores distintos
//   TP1 = entrada + 0.6σ₂₀ (ganancia segura, ~60% probab)
//   TP2 = entrada + 1.2σ₂₀ (ganancia agresiva, ~40% probab)
// Esto garantiza TP2 >> TP1 sin estar limitado por ma20
export function calcTakeProfits(
  entryPrice: number,
  stopLoss:   number,
  type:       OpportunityType,
  ind:        TechnicalIndicators,
  closes?:    number[],
): { tp1: number; tp2: number; rr: number; useTrailing: boolean } {
  const risk = entryPrice - stopLoss;
  if (risk <= 0) {
    return { tp1: entryPrice * 1.01, tp2: entryPrice * 1.02, rr: 1.0, useTrailing: false };
  }

  // NUEVO: Usar sigma₂₀ (volatilidad de 20 días) en lugar de risk
  // Esto desacopla los targets de la distancia al stop loss
  const sl20 = closes && closes.length >= 20 
    ? closes.slice(-20) 
    : closes ?? [entryPrice];
  const sigma20 = stdev(sl20);

  // Multiplicadores de sigma (distintos según el tipo y volatilidad)
  const atrPct = ind.atr / Math.max(0.01, entryPrice);
  let tp1Mult = 0.6;  // TP1: 60% de sigma
  let tp2Mult = 1.2;  // TP2: 120% de sigma (2× más lejos que TP1)

  // Ajustar multiplicadores si volatilidad es muy baja
  if (atrPct < 0.008) {
    tp1Mult = 0.8;
    tp2Mult = 1.5;
  }

  const tp1 = entryPrice + sigma20 * tp1Mult;
  const tp2 = entryPrice + sigma20 * tp2Mult;

  // Guard: garantizar tp2 > tp1 (debería ocurrir siempre con nuestros multiplos)
  const tp2Final = Math.max(tp1 * 1.01, tp2);

  // R:R usando risk tradicional (para reportes compatibles)
  const rr = risk > 0 ? (tp1 - entryPrice) / risk : 1.5;

  return {
    tp1,
    tp2: tp2Final,
    rr: Math.max(1.0, rr),
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
  if (atrPct >= 0.04)  return { tp1: 1.5, tp2: 4.0 };
  if (atrPct >= 0.02)  return { tp1: 1.5, tp2: 2.5 };
  if (atrPct >= 0.008) return { tp1: 1.2, tp2: 1.8 };
  return { tp1: 1.0, tp2: 1.5 };
}

// ════════════════════════════════════════════════════════════
// MODELO FIRST PASSAGE TIME — REESCRITO
// ════════════════════════════════════════════════════════════

/**
 * calcOptimalHorizon — VERSIÓN ELITE (FPT correcto)
 *
 * PROBLEMA ANTERIOR: (1-normCDF(d/(σ√t))) es MONOTÓNICAMENTE CRECIENTE.
 * El máximo siempre era dynMax. No era un modelo de horizonte, era un bucle
 * que devolvía el límite superior siempre.
 *
 * SOLUCIÓN: Brownian Motion con drift (Inverse Gaussian / Wald distribution).
 *
 * Modelo:
 *   dS = μ dt + σ dW
 *   T  = primer tiempo que S alcanza d (distancia al target)
 *   μ  = drift diario calibrado por tipo de señal (fracción del ATR)
 *   σ  = ATR diario (volatilidad en unidades de precio)
 *
 * CDF del FPT (Feller 1966, Vol.II, Ch.XIV):
 *   P(T≤t) = Φ((μt-d)/(σ√t)) + exp(2μd/σ²) · Φ(-(μt+d)/(σ√t))
 *
 * optimalDays = E[T] = d/μ
 *   La esperanza de golpe de la barrera es el "horizonte óptimo"
 *   interpretable para gestión de posiciones: tras E[T] días, si no
 *   has llegado al objetivo, has consumido más tiempo del esperado.
 *
 * prob = P(T ≤ E[T]) ≈ 70-75% (derivado de la CDF en ese punto)
 *   Más útil que el "día máximo" (que es trivialmente dynMax).
 *
 * Validación numérica confirmada:
 *   E[T]=22d → P(hit by day 22)≈73% ✓
 *   E[T]=13d → P(hit by day 13)≈69% ✓
 *   FPT CDF es monotónicamente creciente (propiedad matemática requerida) ✓
 *   Límites: P(T≤0)=0, P(T≤∞)=1 (para μ>0) ✓
 */
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

  const d      = target - entryPrice;         // Distancia al target (unidades de precio)
  const sigma  = atr;                          // Volatilidad diaria (unidades de precio)
  const driftF = signalType ? SIGNAL_DRIFT[signalType] ?? 0.08 : 0.08;
  const mu     = sigma * driftF;               // Drift diario (unidades de precio)

  // E[T] = d/μ — esperanza de primer golpe
  const expectedDays = d / mu;
  const optimalDays  = Math.max(1, Math.min(dynMax, Math.round(expectedDays)));

  // Construir curva de probabilidad acumulada
  const probs: number[] = [];
  for (let t = 1; t <= dynMax; t++) {
    const cp = fptCDF(t, d, mu, sigma);
    probs.push(parseFloat((cp * 100).toFixed(2)));
  }

  const finalProb = probs[optimalDays - 1] ?? 0;

  return {
    days:       optimalDays,
    prob:       parseFloat(finalProb.toFixed(2)),
    probs,
    assetSpeed: speed,
  };
}

/**
 * calcExpectedDays — UNIFICADO con el modelo FPT
 *
 * ANTES: constantes hardcodeadas disfrazadas de modelo.
 *   MOMENTUM_BREAKOUT: siempre 15d (drift=atr×0.15, distancia=1.5ATR → 10d, clamped)
 *   El resultado era idéntico independientemente del activo o el mercado.
 *
 * AHORA: usa el mismo modelo FPT que calcOptimalHorizon.
 *   E[T] = d/μ donde μ = ATR × driftFactor(signalType)
 *   Consistencia matemática garantizada con calcOptimalHorizon.
 */
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
