// ============================================================
// src/core/quant/factorEngine.ts
// Multi-Factor Engine — el cerebro cuantitativo del sistema
// Factores: Momentum · MeanReversion · Volatility · Value(EY)
// EarningsYield = 1/PER — calculado AUTOMATICAMENTE via Yahoo
// ============================================================

export interface FactorScores {
  momentum:      number;   // 0-1 — persistencia de precio
  meanReversion: number;   // 0-1 — reversión estadística
  volatility:    number;   // 0-1 — control de riesgo (inversa ATR)
  value:         number;   // 0-1 — Earnings Yield = 1/PER
  composite:     number;   // Score final ponderado
  // Inputs usados para trazabilidad
  inputs: {
    adx:            number;
    rsi2:           number;
    zscore:         number;
    atrPct:         number;
    earningsYield:  number;
    per:            number;
  };
}

export interface FactorInput {
  rsi2:           number;
  zscore:         number;
  adx:            number;
  atrPct:         number;   // ATR como % del precio
  earningsYield:  number;   // 1/PER — auto desde Yahoo
  per:            number;   // PER = Precio / BPA — auto desde Yahoo
}

// ── Normalizar 0-1 con clamp ──────────────────────────────────
function norm(v: number, min: number, max: number): number {
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

// ════════════════════════════════════════════════════════════
// FACTOR 1 — MOMENTUM (ADX-based, no sobreajustado)
// Edge: activos con tendencia fuerte tienden a continuar
// Validación académica: Jegadeesh & Titman (1993)
// ════════════════════════════════════════════════════════════
function calcMomentumFactor(adx: number): number {
  // ADX > 25 = tendencia fuerte
  // ADX > 40 = tendencia muy fuerte → máximo score
  if (adx > 40) return 1;
  if (adx > 25) return norm(adx, 25, 40);
  return 0;
}

// ════════════════════════════════════════════════════════════
// FACTOR 2 — MEAN REVERSION (RSI2 + ZScore)
// Edge: reversión a la media en timeframes cortos
// Validación: Connors & Alvarez (2009), Larry Connors RSI-2
// ════════════════════════════════════════════════════════════
function calcMeanReversionFactor(rsi2: number, zscore: number): number {
  // Condición: RSI(2) < 10 Y Z-Score < -1.5
  if (rsi2 > 15 || zscore > -1.0) return 0;
  // Cuanto más extremo, mayor el factor
  const rsiScore  = norm(15 - rsi2, 0, 15);   // 15-0 → 0-1
  const zScore    = norm(-zscore - 1.0, 0, 3); // z=-1 a z=-4 → 0-1
  return (rsiScore + zScore) / 2;
}

// ════════════════════════════════════════════════════════════
// FACTOR 3 — VOLATILITY (inversa del ATR%)
// Edge: posiciones en activos menos volátiles tienen mejor
// Sharpe ajustado. Basis: Risk Parity, Asness et al.
// ════════════════════════════════════════════════════════════
function calcVolatilityFactor(atrPct: number): number {
  // ATR 1% → factor 1 (poco volátil, preferible)
  // ATR 6% → factor 0 (muy volátil, penalizado)
  if (atrPct <= 0) return 0.5;
  if (atrPct > 0.06) return 0;
  return norm(0.06 - atrPct, 0, 0.05); // invierte la escala
}

// ════════════════════════════════════════════════════════════
// FACTOR 4 — VALUE via Earnings Yield (1/PER)
// Edge: activos baratos vs earnings tienden a outperformar
// Validación: Fama & French (1992), Graham value investing
// AUTO-CALCULADO desde Yahoo Finance (earningsYield = EPS/Price)
// ════════════════════════════════════════════════════════════
function calcValueFactor(earningsYield: number): number {
  // earningsYield = 0 si no hay datos (ETFs sin beneficios)
  if (!earningsYield || earningsYield <= 0) return 0;
  // EY > 8% = muy barato (PER < 12.5) → factor 1
  // EY < 2% = caro (PER > 50) → factor 0
  return norm(earningsYield, 0.02, 0.08);
}

// ════════════════════════════════════════════════════════════
// COMPOSITE — Ponderación institucional
// Pesos calibrados para trading táctico (no largo plazo):
//   Momentum 30% · MeanReversion 30% · Vol 25% · Value 15%
// Para largo plazo invertir: Value 40% · Momentum 20%
// ════════════════════════════════════════════════════════════
export function computeFactorScores(input: FactorInput): FactorScores {
  const momentum      = calcMomentumFactor(input.adx);
  const meanReversion = calcMeanReversionFactor(input.rsi2, input.zscore);
  const volatility    = calcVolatilityFactor(input.atrPct);
  const value         = calcValueFactor(input.earningsYield);

  // Detectar qué señal está activa para ajustar pesos dinámicamente
  const isMRActive = meanReversion > 0.5;
  const isMomActive= momentum > 0.5;

  let composite: number;
  if (isMRActive && !isMomActive) {
    // Mean reversion dominante: más peso a MR y volatility
    composite = meanReversion * 0.45 + volatility * 0.30 + value * 0.15 + momentum * 0.10;
  } else if (isMomActive && !isMRActive) {
    // Momentum dominante: más peso a momentum
    composite = momentum * 0.45 + volatility * 0.25 + meanReversion * 0.15 + value * 0.15;
  } else {
    // Base: pesos balanceados
    composite = momentum * 0.30 + meanReversion * 0.30 + volatility * 0.25 + value * 0.15;
  }

  return {
    momentum, meanReversion, volatility, value,
    composite: Math.min(1, Math.max(0, composite)),
    inputs: {
      adx: input.adx, rsi2: input.rsi2, zscore: input.zscore,
      atrPct: input.atrPct, earningsYield: input.earningsYield, per: input.per,
    },
  };
}

// ── Descripción legible del factor dominante ─────────────────
export function getFactorExplanation(scores: FactorScores): string {
  const parts: string[] = [];
  if (scores.meanReversion > 0.5) parts.push(`Mean Reversion ${(scores.meanReversion * 100).toFixed(0)}% — RSI(2)=${scores.inputs.rsi2.toFixed(1)}, Z=${scores.inputs.zscore.toFixed(2)}`);
  if (scores.momentum > 0.5)      parts.push(`Momentum ${(scores.momentum * 100).toFixed(0)}% — ADX=${scores.inputs.adx.toFixed(0)}`);
  if (scores.value > 0.3 && scores.inputs.earningsYield > 0)
    parts.push(`Value — EY=${(scores.inputs.earningsYield * 100).toFixed(1)}% (PER=${scores.inputs.per.toFixed(1)}x)`);
  return parts.length > 0 ? parts.join(' · ') : 'Sin factor dominante activo';
}
