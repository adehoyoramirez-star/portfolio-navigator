// ============================================================
// src/core/tactical/marketRegimeFilter.ts
// MEJORA CRÍTICA: Filtro de régimen de mercado
// Sin esto el sistema opera igual en tendencia, lateral y crash
//
// Lógica:
//   TRENDING_UP   → solo Momentum Breakout + Sector Rotation
//   RANGING       → solo Mean Reversion + Oversold Bounce
//   TRENDING_DOWN → solo Blood in Streets (muy selectivo)
//   CRASH         → STOP TOTAL — no operar
// ============================================================

import type { OpportunityType } from './types';

export type MarketRegime = 'TRENDING_UP' | 'RANGING' | 'TRENDING_DOWN' | 'CRASH';

export interface RegimeState {
  regime:       MarketRegime;
  confidence:   number;       // 0-100
  description:  string;
  allowedTypes: OpportunityType[];
  positionSizeMultiplier: number; // Escalar el tamaño según régimen
  // Inputs usados
  spyAboveMA200:  boolean;
  spyADX:         number;
  spyRSI:         number;
  vixLevel:       number;
  spyMom4w:       number;     // Momentum 4 semanas del índice
}

// ── Calcular régimen con datos de índice (SPY o EWQ1/EXW1) ───
export function detectMarketRegime(
  indexCloses:  number[],  // Historial del índice (SPY / MSCI World)
  vix:          number     // VIX actual
): RegimeState {
  if (indexCloses.length < 200) {
    return {
      regime: 'RANGING', confidence: 30,
      description: 'Datos insuficientes — régimen por defecto RANGING',
      allowedTypes: ['MEAN_REVERSION', 'OVERSOLD_BOUNCE'],
      positionSizeMultiplier: 0.7,
      spyAboveMA200: false, spyADX: 20, spyRSI: 50, vixLevel: vix, spyMom4w: 0,
    };
  }

  const price    = indexCloses[indexCloses.length - 1];
  const slice200 = indexCloses.slice(-200);
  const ma200    = slice200.reduce((a, b) => a + b, 0) / 200;
  const slice50  = indexCloses.slice(-50);
  const ma50     = slice50.reduce((a, b) => a + b, 0) / 50;

  // Momentum 4 semanas (20 días)
  const price4wAgo = indexCloses[indexCloses.length - 20];
  const mom4w      = price4wAgo > 0 ? (price / price4wAgo) - 1 : 0;

  // ADX simplificado (stdev de retornos como proxy de fuerza de tendencia)
  const rets = slice50.map((c, i, a) => i === 0 ? 0 : Math.abs(c - a[i-1]) / a[i-1]).slice(1);
  const adxProxy = (rets.reduce((a, b) => a + b, 0) / rets.length) * 1000; // 0-100 aprox

  // RSI 14 simple
  const rsi14Closes = indexCloses.slice(-28);
  let gains = 0, losses = 0, count = 0;
  for (let i = 1; i < rsi14Closes.length; i++) {
    const d = rsi14Closes[i] - rsi14Closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
    count++;
  }
  const avgG = gains / count, avgL = losses / count;
  const rsi14 = avgL === 0 ? 100 : parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));

  const aboveMA200 = price > ma200;
  const aboveMA50  = price > ma50;

  // ── Clasificar régimen ────────────────────────────────────
  let regime: MarketRegime;
  let confidence: number;
  let description: string;
  let allowedTypes: OpportunityType[];
  let sizeMultiplier: number;

  if (vix > 35) {
    // CRASH — mercado disfuncional, no operar tácticamente
    regime          = 'CRASH';
    confidence      = 90;
    description     = `VIX ${vix.toFixed(1)} > 35 — Mercado en pánico. Motor táctico PARADO. Solo Blood in Streets con capital mínimo.`;
    allowedTypes    = ['BLOOD_IN_STREETS'];
    sizeMultiplier  = 0.3;
  } else if (!aboveMA200 && mom4w < -0.05) {
    // TRENDING DOWN — tendencia bajista clara
    regime          = 'TRENDING_DOWN';
    confidence      = 75;
    description     = `Índice bajo MA200 + momentum negativo (${(mom4w*100).toFixed(1)}%). Solo Blood in Streets muy selectivo.`;
    allowedTypes    = ['BLOOD_IN_STREETS', 'OVERSOLD_BOUNCE'];
    sizeMultiplier  = 0.5;
  } else if (aboveMA200 && aboveMA50 && mom4w > 0.02 && adxProxy > 15) {
    // TRENDING UP — tendencia alcista confirmada
    regime          = 'TRENDING_UP';
    confidence      = 80;
    description     = `Índice sobre MA200+MA50 con momentum +${(mom4w*100).toFixed(1)}%. Priorizar Breakout y Rotación.`;
    allowedTypes    = ['MOMENTUM_BREAKOUT', 'SECTOR_ROTATION', 'OVERSOLD_BOUNCE'];
    sizeMultiplier  = 1.0;
  } else {
    // RANGING — mercado lateral
    regime          = 'RANGING';
    confidence      = 65;
    description     = `Mercado lateral (ADX=${adxProxy.toFixed(0)}, MA200=${aboveMA200}). Mean Reversion y rebotes.`;
    allowedTypes    = ['MEAN_REVERSION', 'OVERSOLD_BOUNCE', 'BLOOD_IN_STREETS'];
    sizeMultiplier  = 0.8;
  }

  return {
    regime, confidence, description, allowedTypes,
    positionSizeMultiplier: sizeMultiplier,
    spyAboveMA200: aboveMA200,
    spyADX:        adxProxy,
    spyRSI:        rsi14,
    vixLevel:      vix,
    spyMom4w:      mom4w,
  };
}

// ── Verificar si un tipo de señal está permitido ──────────────
export function isSignalAllowed(
  signalType: OpportunityType,
  regime:     RegimeState
): boolean {
  return regime.allowedTypes.includes(signalType);
}

// ── Ajustar score según régimen ───────────────────────────────
// Penaliza señales que van contra el régimen actual
export function adjustScoreByRegime(
  score:      number,
  signalType: OpportunityType,
  regime:     RegimeState
): number {
  if (!isSignalAllowed(signalType, regime)) return 0; // Eliminar señales no permitidas
  // Bonus si la señal es la más apropiada para el régimen
  const isPrimary = regime.allowedTypes[0] === signalType;
  return isPrimary ? Math.min(100, score * 1.15) : score;
}
