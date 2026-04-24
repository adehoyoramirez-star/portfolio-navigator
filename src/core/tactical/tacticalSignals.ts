// ============================================================
// src/core/tactical/tacticalSignals.ts — v2 SIMPLIFICADA
// MAX 2-3 inputs por señal. Menos overfitting. Más edge real.
// Blood in Streets:  RSI(2) + Z-Score
// Mean Reversion:    RSI(2) + Bollinger Lower
// Momentum Breakout: ADX + precio sobre BB superior
// Oversold Bounce:   RSI(14) + sobre MA200
// Sector Rotation:   Drawdown 52w + RSI recuperando
// Volumen = confirmador opcional, NO condición obligatoria
// ============================================================

import type {
  TechnicalIndicators, TacticalSignal, TrendDirection,
  OpportunityType, SignalStrength
} from './types';

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

export function calcIndicators(
  closes:  number[],
  volumes: number[],
  highs:   number[],   // OHLC reales o aproximados por approximateHighsLows()
  lows:    number[],   // OHLC reales o aproximados por approximateHighsLows()
): TechnicalIndicators {
  const price  = closes[closes.length - 1];
  const ma20   = sma(closes, 20);
  const ma50   = sma(closes, 50);
  const ma200  = sma(closes, 200);
  const rsi2   = calcRSI(closes, 2);
  const rsi14  = calcRSI(closes, 14);
  const rsiWeekly = closes.length >= 70 ? calcRSI(closes.filter((_, i) => i % 5 === 0), 14) : rsi14;
  const sl20   = closes.slice(-20);
  const m20    = sl20.reduce((a, b) => a + b, 0) / sl20.length;
  const sd20   = stdev(sl20);
  const bbUpper = m20 + 2 * sd20;
  const bbLower = m20 - 2 * sd20;
  const bbWidth = m20 > 0 ? (bbUpper - bbLower) / m20 : 0;
  const zScore20 = sd20 > 0 ? (price - m20) / sd20 : 0;
  const sl50   = closes.slice(-50);
  const m50    = sl50.reduce((a, b) => a + b, 0) / sl50.length;
  const sd50   = stdev(sl50);
  const zScore50 = sd50 > 0 ? (price - m50) / sd50 : 0;
  const retsAbs = closes.slice(-20).map((c, i, a) => i === 0 ? 0 : Math.abs(c - a[i - 1]) / a[i - 1]).slice(1);
  const adx    = (retsAbs.reduce((a, b) => a + b, 0) / retsAbs.length) * 1000;
  const macdLine = ema(closes, 12) - ema(closes, 26);
  const macdSeries: number[] = [];
  for (let i = 26; i <= closes.length; i++) macdSeries.push(ema(closes.slice(0, i), 12) - ema(closes.slice(0, i), 26));
  const macdSignal = ema(macdSeries, 9);
  const macdHist   = macdLine - macdSignal;

  // ATR14 real usando highs/lows (True Range = max(H-L, |H-Cprev|, |L-Cprev|))
  // Si highs/lows son aproximados (de approximateHighsLows) el resultado sigue
  // siendo mejor que usar solo |close - close_prev|.
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
    atr14 = Math.max(rawAtr, price * 0.005); // suelo 0.5% del precio
  } else {
    atr14 = price * 0.02;
  }
  const atrPct = price > 0 ? (atr14 / price) : 0.02;
  const atrPctSafe = Math.max(atrPct, 0.005);

  const volSlice = volumes.slice(-21);
  const avgVol = sma(volSlice.slice(0, -1), 20);
  const volRatio = avgVol > 0 ? (volumes[volumes.length - 1] ?? avgVol) / avgVol : 1;
  const high52w = Math.max(...closes.slice(-252));
  const drawdown52w = high52w > 0 ? (price / high52w) - 1 : 0;
  let trend: TrendDirection = 'SIDEWAYS';
  if (price > ma50 && ma50 > ma200) trend = 'UPTREND';
  else if (price < ma50 && ma50 < ma200) trend = 'DOWNTREND';

  return {
    price, ma20, ma50, ma200, rsi2, rsi14, rsiWeekly,
    macdLine, macdSignal, macdHist, adx, atr14, atrPct: atrPctSafe,
    bbUpper, bbMiddle: m20, bbLower, bbWidth,
    zScore20, zScore50, volumeRatio: volRatio, trend,
    aboveMA200: price > ma200, aboveMA50: price > ma50, aboveMA20: price > ma20,
    drawdownFrom52wHigh: drawdown52w,
  };
}

function mkSig(type: OpportunityType, active: boolean, score: number, description: string, condition: string): TacticalSignal {
  const strength: SignalStrength = score >= 80 ? 'EXTREME' : score >= 60 ? 'STRONG' : score >= 40 ? 'MODERATE' : 'WEAK';
  return { type, strength, score: active ? score : 0, active, description, condition };
}

function signalBloodInStreets(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, zScore20, aboveMA200, volumeRatio } = ind;
  const active = rsi2 < 10 && zScore20 < -1.5 && aboveMA200;
  const score  = active ? Math.min(100, 45 + (10 - Math.min(10, rsi2)) * 4 + (Math.abs(zScore20) - 1.5) * 5 + (volumeRatio > 1.5 ? 8 : 0)) : 0;
  return mkSig('BLOOD_IN_STREETS', active, score,
    active ? `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)}${volumeRatio > 1.5 ? ' · Vol×' + volumeRatio.toFixed(1) : ''} — Pánico de compra`
           : `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)} — No cumple`,
    'RSI(2) < 10 AND Z-Score(20) < -1.5 AND sobre MA200');
}

function signalMeanReversion(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, bbLower, price, zScore20 } = ind;
  const active = rsi2 < 15 && price < bbLower * 1.02;
  const score  = active ? Math.min(100, 40 + (15 - Math.min(15, rsi2)) * 2 + (price < bbLower ? 12 : 4) + (zScore20 < -1.5 ? 8 : 0)) : 0;
  return mkSig('MEAN_REVERSION', active, score,
    active ? `RSI(2)=${rsi2.toFixed(1)} · €${price.toFixed(2)} bajo BB(€${bbLower.toFixed(2)}) — Vuelta a la media`
           : `RSI(2)=${rsi2.toFixed(1)} · BBI=€${bbLower.toFixed(2)} — Sin condición`,
    'RSI(2) < 15 AND Precio < BB Inferior +2%');
}

function signalMomentumBreakout(ind: TechnicalIndicators): TacticalSignal {
  const { adx, price, bbUpper, ma50, volumeRatio } = ind;
  const active = adx > 20 && price > bbUpper * 0.995 && price > ma50;
  const score  = active ? Math.min(100, 45 + Math.min(20, (adx - 20) * 1.5) + (volumeRatio > 1.5 ? 20 : 0) + (price > bbUpper ? 15 : 5)) : 0;
  return mkSig('MOMENTUM_BREAKOUT', active, score,
    active ? `ADX=${adx.toFixed(0)} · Ruptura BB superior${volumeRatio > 1.5 ? ' · Vol confirma' : ''}`
           : `ADX=${adx.toFixed(0)} — Sin breakout confirmado`,
    'ADX > 20 AND Precio > BB Superior AND sobre MA50');
}

function signalOversoldBounce(ind: TechnicalIndicators): TacticalSignal {
  const { rsi14, aboveMA200, ma50, price, zScore50 } = ind;
  const active = rsi14 < 45 && (aboveMA200 || price > ma50 * 0.95);
  const score  = active ? Math.min(100, 38 + (45 - Math.min(45, rsi14)) * 1.2 + (aboveMA200 ? 18 : 6) + (zScore50 < -1 ? 8 : 0)) : 0;
  return mkSig('OVERSOLD_BOUNCE', active, score,
    active ? `RSI(14)=${rsi14.toFixed(1)} · Sobre soporte — Rebote técnico probable`
           : `RSI(14)=${rsi14.toFixed(1)} — Sin condición`,
    'RSI(14) < 45 AND sobre MA200 o MA50-5%');
}

function signalSectorRotation(ind: TechnicalIndicators): TacticalSignal {
  const { drawdownFrom52wHigh, rsi14, aboveMA200, price, ma50 } = ind;
  const active = drawdownFrom52wHigh < -0.20 && rsi14 > 40 && rsi14 < 55 && (aboveMA200 || price > ma50);
  const score  = active ? Math.min(100, 40 + Math.min(25, (Math.abs(drawdownFrom52wHigh) - 0.20) * 100) + (aboveMA200 ? 20 : 5) + 15) : 0;
  return mkSig('SECTOR_ROTATION', active, score,
    active ? `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% · RSI=${rsi14.toFixed(1)} recuperando — Rotación sectorial`
           : `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% — Sin condición`,
    'Drawdown52w < -20% AND RSI 40-55 AND sobre MA200/MA50');
}

export function generateSignals(ind: TechnicalIndicators): TacticalSignal[] {
  return [signalBloodInStreets(ind), signalMeanReversion(ind), signalMomentumBreakout(ind), signalOversoldBounce(ind), signalSectorRotation(ind)];
}

export function calcTotalScore(signals: TacticalSignal[]): number {
  const active = signals.filter(s => s.active);
  if (active.length === 0) return 0;
  const best = Math.max(...active.map(s => s.score));
  return Math.min(100, best + Math.min(20, (active.length - 1) * 8));
}

export function calcStopLoss(entryPrice: number, atr: number, type: OpportunityType, closes: number[]): number {
  const recentLow = Math.min(...closes.slice(-5));
  const mult = type === 'MOMENTUM_BREAKOUT' ? 1.0 : type === 'BLOOD_IN_STREETS' ? 1.5 : 2.0;
  return Math.min(entryPrice - mult * atr, recentLow * 0.985);
}

export function calcTakeProfits(entryPrice: number, stopLoss: number, type: OpportunityType, ind: TechnicalIndicators): { tp1: number; tp2: number; rr: number; useTrailing: boolean } {
  const risk = entryPrice - stopLoss;
  const tp1  = entryPrice + risk * 1.5;
  const tp2  = type === 'MOMENTUM_BREAKOUT' ? entryPrice + risk * 4.0
             : type === 'MEAN_REVERSION'    ? Math.min(entryPrice + risk * 2.5, ind.ma20)
             : entryPrice + risk * 2.5;
  return { tp1, tp2, rr: 1.5, useTrailing: type === 'MOMENTUM_BREAKOUT' };
}