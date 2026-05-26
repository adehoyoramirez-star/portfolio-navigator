// ============================================================
// src/core/tactical/marketRegimeFilter.ts — v3 ELITE
//
// CORRECCIONES CRÍTICAS v3:
//
//   1. ADX REEMPLAZADO por Efficiency Ratio de Kaufman.
//      PROBLEMA: |retorno diario|×1000 = volatilidad realizada.
//      En crash (vol alta): adxProxy=40 → clasificaba como TRENDING.
//      En bull tranquilo (vol baja): adxProxy=15 → clasificaba como RANGING.
//      Lógica completamente invertida respecto a la realidad.
//      FIX: ER = |net move| / total path sobre 50 días.
//      ER alto = tendencia fuerte (bull run). ER bajo = ruido/lateral.
//
//   2. RSI CORREGIDO con Wilder's exponential smoothing.
//      PROBLEMA: usaba media simple (RSI de Cutler), diverge del
//      estándar en mercados con rachas largas.
//      FIX: mismo calcRSI que tacticalSignals.ts.
//
//   3. Umbral de ER calibrado:
//      ER > 0.40 = tendencia fuerte confirmada (TRENDING_UP)
//      ER 0.20-0.40 = tendencia débil / transitorio
//      ER < 0.20 = lateral (RANGING)
//      Validado: trending market ER ≈ 0.85-1.0, sideways ER ≈ 0-0.10
// ============================================================

import type { OpportunityType } from './types';

export type MarketRegime = 'TRENDING_UP' | 'RANGING' | 'TRENDING_DOWN' | 'CRASH';

export interface RegimeState {
  regime:       MarketRegime;
  confidence:   number;
  description:  string;
  allowedTypes: OpportunityType[];
  positionSizeMultiplier: number;
  spyAboveMA200:  boolean;
  spyER:          number;   // Efficiency Ratio (reemplaza adx)
  spyRSI:         number;
  vixLevel:       number;
  spyMom4w:       number;
}

// ── Wilder's RSI (idéntico al de tacticalSignals.ts) ─────────
function calcRSIWilder(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  const slice = closes.slice(-(period * 3 + period));
  if (slice.length < period + 1) return 50;
  const rets = slice.map((c, i, a) => i === 0 ? 0 : c - a[i - 1]).slice(1);
  if (rets.length < period) return 50;

  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgG += rets[i]; else avgL += Math.abs(rets[i]);
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

// ── Efficiency Ratio de Kaufman ───────────────────────────────
// ER = |cambio neto en N barras| / Σ|cambios diarios|
// Rango: 0 (ruido puro) → 1 (tendencia perfecta)
// Umbral TRENDING_UP: ER > 0.40 (40% de eficiencia direccional)
function calcEfficiencyRatio(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const slice     = closes.slice(-period - 1);
  const netMove   = Math.abs(slice[slice.length - 1] - slice[0]);
  const totalPath = slice
    .slice(1)
    .reduce((sum, c, i) => sum + Math.abs(c - slice[i]), 0);
  return totalPath > 0 ? netMove / totalPath : 0;
}

// ── Detectar régimen de mercado ───────────────────────────────
export function detectMarketRegime(
  indexCloses: number[],  // Historial del índice (SPY / MSCI World)
  vix:         number,
): RegimeState {
  if (indexCloses.length < 200) {
    return {
      regime: 'RANGING', confidence: 30,
      description: 'Datos insuficientes — régimen por defecto RANGING',
      allowedTypes: ['MEAN_REVERSION', 'OVERSOLD_BOUNCE'],
      positionSizeMultiplier: 0.7,
      spyAboveMA200: false, spyER: 0, spyRSI: 50, vixLevel: vix, spyMom4w: 0,
    };
  }

  const price   = indexCloses[indexCloses.length - 1];
  const ma200   = indexCloses.slice(-200).reduce((a, b) => a + b, 0) / 200;
  const ma50    = indexCloses.slice(-50).reduce((a, b) => a + b, 0) / 50;

  // Momentum 4 semanas (20 días hábiles)
  const price4wAgo = indexCloses[indexCloses.length - 20];
  const mom4w      = price4wAgo > 0 ? (price / price4wAgo) - 1 : 0;

  // Efficiency Ratio sobre 50 días (reemplaza ADX proxy)
  const er = calcEfficiencyRatio(indexCloses, 50);

  // RSI 14 con Wilder's smoothing (reemplaza media simple)
  const rsi14 = calcRSIWilder(indexCloses, 14);

  const aboveMA200 = price > ma200;
  const aboveMA50  = price > ma50;

  // ── Clasificación de régimen ──────────────────────────────
  let regime: MarketRegime;
  let confidence: number;
  let description: string;
  let allowedTypes: OpportunityType[];
  let sizeMultiplier: number;

  if (vix > 35) {
    // CRASH: mercado disfuncional
    regime         = 'CRASH';
    confidence     = 90;
    description    = `VIX ${vix.toFixed(1)} > 35 — Mercado en pánico. Solo Blood in Streets con capital mínimo (30%).`;
    allowedTypes   = ['BLOOD_IN_STREETS'];
    sizeMultiplier = 0.3;

  } else if (!aboveMA200 && mom4w < -0.05) {
    // TRENDING DOWN: índice bajo MA200 con momentum negativo claro
    regime         = 'TRENDING_DOWN';
    confidence     = 75;
    description    = `Índice bajo MA200 + mom4w=${(mom4w*100).toFixed(1)}%. ER=${(er*100).toFixed(0)}%. Solo Blood in Streets / Oversold muy selectivo.`;
    allowedTypes   = ['BLOOD_IN_STREETS', 'OVERSOLD_BOUNCE'];
    sizeMultiplier = 0.5;

  } else if (aboveMA200 && aboveMA50 && mom4w > 0.02 && er > 0.40) {
    // TRENDING UP: tendencia alcista confirmada con eficiencia alta
    // er > 0.40: movimiento neto = 40%+ del path total → tendencia real
    regime         = 'TRENDING_UP';
    confidence     = 80;
    description    = `Índice sobre MA200+MA50, mom4w=+${(mom4w*100).toFixed(1)}%, ER=${(er*100).toFixed(0)}%. Priorizar Breakout y Rotación.`;
    allowedTypes   = ['MOMENTUM_BREAKOUT', 'SECTOR_ROTATION', 'OVERSOLD_BOUNCE'];
    sizeMultiplier = 1.0;

  } else {
    // RANGING: mercado lateral o transicional
    const erPct = (er * 100).toFixed(0);
    regime         = 'RANGING';
    confidence     = 65;
    description    = `Mercado lateral/transicional (ER=${erPct}%, MA200=${aboveMA200}). Mean Reversion y rebotes.`;
    allowedTypes   = ['MOMENTUM_BREAKOUT', 'MEAN_REVERSION', 'OVERSOLD_BOUNCE', 'BLOOD_IN_STREETS'];
    sizeMultiplier = 0.8;
  }

  console.log(
    `[RegimeFilter] Régimen detectado: ${regime} | ` +
    `confianza=${confidence}% | ` +
    `VIX=${vix.toFixed(1)} | ` +
    `ER=${(er * 100).toFixed(0)}% | ` +
    `RSI14=${rsi14} | ` +
    `mom4w=${(mom4w * 100).toFixed(1)}% | ` +
    `sobreMA200=${price > ma200} | ` +
    `señales permitidas: ${allowedTypes.join(', ')}`
  );

  return {
    regime, confidence, description, allowedTypes,
    positionSizeMultiplier: sizeMultiplier,
    spyAboveMA200: aboveMA200,
    spyER:         er,
    spyRSI:        rsi14,
    vixLevel:      vix,
    spyMom4w:      mom4w,
  };
}

// ── ¿Está permitida la señal en el régimen actual? ────────────
export function isSignalAllowed(
  signalType: OpportunityType,
  regime:     RegimeState,
): boolean {
  return regime.allowedTypes.includes(signalType);
}

// ── Ajustar score según régimen ───────────────────────────────
export function adjustScoreByRegime(
  score:      number,
  signalType: OpportunityType,
  regime:     RegimeState,
): number {
  if (!isSignalAllowed(signalType, regime)) return 0;
  const isPrimary = regime.allowedTypes[0] === signalType;
  return isPrimary ? Math.min(100, score * 1.15) : score;
}
