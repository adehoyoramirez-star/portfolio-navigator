// ===============================================
// ARCHIVO: src/core/dca/dcaEngine.ts
// OLYMPUS V4.1 PRO — DCA Contracíclico Engine
// ===============================================
// Este módulo calcula la intensidad de compra DCA basada en:
//   1. Régimen macro (CRISIS/CONTRACTION/EXPANSION)
//   2. BTC cycle boost (MVRV<1.5 Y Puell<1 → 1.4x)
//   3. Risk constraints (volatilidad, drawdown)
//
// Filosofía V4.1 PRO:
//   "comprar miedo, no euforia"
//   "el dinero se gana comprando cuando duele"
// ===============================================

import type { BTCCycleOutput } from '../crypto/btcCycleOverlay';

export type PortfolioRegime = 'EXPANSION' | 'CONTRACTION' | 'CRISIS';

export interface DCAEngineInput {
  regime: PortfolioRegime;
  btcCycle?: BTCCycleOutput;

  // Risk constraints
  portfolioVolatility?: number;  // volatilidad realizada del portfolio
  portfolioDrawdown?: number;    // drawdown actual

  // Capital disponible
  availableCash: number;         // cash disponible para DCA
  totalPortfolioValue: number;   // valor total del portfolio
}

export interface DCAEngineOutput {
  // Decisión de inversión
  investAmount: number;          // cantidad a invertir en este período
  investPercent: number;         // % del portfolio a invertir

  // Parámetros del régimen
  baseIntensity: number;         // intensidad base por régimen [0.15, 0.60]
  boostMultiplier: number;       // 1.4 si BTC boost activo
  effectiveIntensity: number;    // intensidad después de boost

  // Frecuencia
  frequency: 'weekly' | 'biweekly' | 'monthly';
  frequencyDays: number;         // días entre inversiones

  // Risk constraints aplicados
  riskConstraintActive: boolean;
  riskConstraintReason: string;
  riskReduction: number;         // % de reducción por risk constraints

  // Desglose
  breakdown: {
    regimeContribution: number;
    btcBoostContribution: number;
    riskConstraintContribution: number;
  };

  description: string;
}

// ===============================================
// CONFIGURACIÓN SEGÚN SPEC V4.1 PRO
// ===============================================

const DCA_CONFIG = {
  // Intensidad base por régimen
  INTENSITY: {
    CRISIS: 0.60,       // Comprar agresivamente en crisis
    CONTRACTION: 0.35,  // Comprar moderadamente
    EXPANSION: 0.15,    // Comprar mínimamente en expansión
  },

  // Frecuencia por régimen
  FREQUENCY: {
    CRISIS: 7,          // semanal (7 días)
    CONTRACTION: 14,    // quincenal (14 días)
    EXPANSION: 30,      // mensual (30 días)
  },

  // Boost BTC
  BTC_BOOST_MULTIPLIER: 1.4,

  // Risk constraints
  VOLATILITY_THRESHOLDS: {
    HIGH: 0.25,         // >25% → reducir 25%
    EXTREME: 0.30,      // >30% → reducir 40%
  },

  DRAWDOWN_THRESHOLDS: {
    SEVERE: 0.25,       // >25% → pause large buys, allow small DCA
  },

  // Max BTC weight
  MAX_BTC_WEIGHT: 0.70,
} as const;

// ===============================================
// HELPERS
// ===============================================

function getFrequencyLabel(days: number): 'weekly' | 'biweekly' | 'monthly' {
  if (days <= 7) return 'weekly';
  if (days <= 14) return 'biweekly';
  return 'monthly';
}

// ===============================================
// MOTOR PRINCIPAL
// ===============================================

/**
 * Calcula el multiplicador DCA según régimen y BTC boost.
 * Versión simplificada para usar en olympusV3.ts
 */
export function computeDCAMultiplier(input: { regime: PortfolioRegime; btcCycle?: BTCCycleOutput }): {
  dcaIntensity: number;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  boostMultiplier: number;
  effectiveIntensity: number;
} {
  // 1. Intensidad base por régimen
  const baseIntensity = DCA_CONFIG.INTENSITY[input.regime];
  const frequencyDays = DCA_CONFIG.FREQUENCY[input.regime];
  const frequency = getFrequencyLabel(frequencyDays);

  // 2. Boost BTC (si MVRV<1.5 Y Puell<1)
  const boostMultiplier = input.btcCycle?.boostActive ? DCA_CONFIG.BTC_BOOST_MULTIPLIER : 1.0;
  const effectiveIntensity = baseIntensity * boostMultiplier;

  return {
    dcaIntensity: baseIntensity,
    frequency,
    boostMultiplier,
    effectiveIntensity,
  };
}

export function computeDCADecision(input: DCAEngineInput): DCAEngineOutput {
  const { regime, btcCycle, availableCash, totalPortfolioValue } = input;

  // 1. Intensidad base por régimen
  const baseIntensity = DCA_CONFIG.INTENSITY[regime];
  const frequencyDays = DCA_CONFIG.FREQUENCY[regime];
  const frequency = getFrequencyLabel(frequencyDays);

  // 2. Boost BTC (si MVRV<1.5 Y Puell<1)
  const boostMultiplier = btcCycle?.boostActive ? DCA_CONFIG.BTC_BOOST_MULTIPLIER : 1.0;
  const effectiveIntensity = baseIntensity * boostMultiplier;

  // 3. Cantidad base a invertir
  const baseInvestAmount = totalPortfolioValue * effectiveIntensity;

  // 4. Risk constraints
  let riskReduction = 0;
  let riskConstraintActive = false;
  let riskConstraintReason = '';

  // Volatilidad >25% → reducir 25%
  if ((input.portfolioVolatility ?? 0) > DCA_CONFIG.VOLATILITY_THRESHOLDS.EXTREME) {
    riskReduction = 0.40;
    riskConstraintActive = true;
    riskConstraintReason = `Volatilidad ${((input.portfolioVolatility ?? 0) * 100).toFixed(1)}% > 30% → reducción 40%`;
  } else if ((input.portfolioVolatility ?? 0) > DCA_CONFIG.VOLATILITY_THRESHOLDS.HIGH) {
    riskReduction = 0.25;
    riskConstraintActive = true;
    riskConstraintReason = `Volatilidad ${((input.portfolioVolatility ?? 0) * 100).toFixed(1)}% > 25% → reducción 25%`;
  }

  // Drawdown >25% → pause large buys
  if ((input.portfolioDrawdown ?? 0) > DCA_CONFIG.DRAWDOWN_THRESHOLDS.SEVERE) {
    riskReduction = Math.max(riskReduction, 0.50);
    riskConstraintActive = true;
    riskConstraintReason = riskConstraintReason
      ? `${riskConstraintReason} + Drawdown >25% → reducción 50%`
      : `Drawdown ${((input.portfolioDrawdown ?? 0) * 100).toFixed(1)}% > 25% → reducción 50%`;
  }

  // 5. Cantidad final después de risk constraints
  const finalIntensity = effectiveIntensity * (1 - riskReduction);
  const investAmount = Math.min(
    totalPortfolioValue * finalIntensity,
    availableCash  // No invertir más cash del disponible
  );
  const investPercent = totalPortfolioValue > 0 ? investAmount / totalPortfolioValue : 0;

  // 6. Desglose de contribuciones
  const regimeContribution = baseIntensity;
  const btcBoostContribution = (boostMultiplier - 1) * baseIntensity;
  const riskConstraintContribution = -effectiveIntensity * riskReduction;

  // 7. Descripción
  let description = `Régimen: ${regime}. Intensidad base: ${(baseIntensity * 100).toFixed(1)}%. `;

  if (btcCycle?.boostActive) {
    description += `⚡ BTC BOOST activo (MVRV<1.5, Puell<1) → ×1.4. `;
  }

  if (riskConstraintActive) {
    description += `⚠️ ${riskConstraintReason}. `;
  }

  description += `Inversión: ${(investPercent * 100).toFixed(2)}% del portfolio (€${investAmount.toFixed(2)}). `;
  description += `Frecuencia: ${frequency}.`;

  return {
    investAmount,
    investPercent,
    baseIntensity,
    boostMultiplier,
    effectiveIntensity,
    frequency,
    frequencyDays,
    riskConstraintActive,
    riskConstraintReason,
    riskReduction,
    breakdown: {
      regimeContribution,
      btcBoostContribution,
      riskConstraintContribution,
    },
    description,
  };
}

// ===============================================
// UTILIDAD: Calcular próxima fecha de DCA
// ===============================================

export function getNextDCADate(lastDate: Date, frequencyDays: number): Date {
  const next = new Date(lastDate);
  next.setDate(next.getDate() + frequencyDays);
  return next;
}

// ===============================================
// UTILIDAD: Validar si hoy es día de DCA
// ===============================================

export function isDCADay(lastDate: Date, frequencyDays: number, today: Date = new Date()): boolean {
  const daysSinceLast = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
  return daysSinceLast >= frequencyDays;
}
