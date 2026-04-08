import type { BTCCycleOutput } from '../crypto/btcCycleOverlay';

export type PortfolioRegime = 'EXPANSION' | 'CONTRACTION' | 'CRISIS';

export interface DCAEngineInput {
  regime: PortfolioRegime;
  btcCycle?: BTCCycleOutput;
  portfolioVolatility?: number;
  availableCash: number;
  totalPortfolioValue: number;
}

export interface DCAEngineOutput {
  investAmount: number;
  investPercent: number;
  baseIntensity: number;
  boostMultiplier: number;
  effectiveIntensity: number;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  frequencyDays: number;
  riskConstraintActive: boolean;
  riskConstraintReason: string;
  description: string;
}

const DCA_CONFIG = {
  INTENSITY: {
    CRISIS: 0.02,
    CONTRACTION: 0.05,
    EXPANSION: 0.08,
  },
  ATTACK_MODE: {
    RECOVERY_BOOST: 3.5,
  },
  RISK_LIMITS: {
    PANIC_VOLATILITY: 0.04,
    LIQUIDATION_RATIO: 0.30,
  }
};

export function computeDCADecision(input: DCAEngineInput): DCAEngineOutput {
  const { regime, btcCycle, totalPortfolioValue, portfolioVolatility, availableCash } = input;
  const isPanic = (portfolioVolatility ?? 0) > DCA_CONFIG.RISK_LIMITS.PANIC_VOLATILITY;
  
  if (isPanic && totalPortfolioValue > 100) {
    const sellAmount = totalPortfolioValue * DCA_CONFIG.RISK_LIMITS.LIQUIDATION_RATIO;
    return {
      investAmount: -sellAmount,
      investPercent: -DCA_CONFIG.RISK_LIMITS.LIQUIDATION_RATIO,
      baseIntensity: 0,
      boostMultiplier: 0,
      effectiveIntensity: 0,
      frequency: 'monthly',
      frequencyDays: 63,
      riskConstraintActive: true,
      riskConstraintReason: "🚨 VENTA DE EMERGENCIA",
      description: "Liquidando por pánico."
    };
  }

  let baseIntensity = DCA_CONFIG.INTENSITY[regime] || 0.05;
  let boostMultiplier = (regime === 'EXPANSION' && btcCycle?.boostActive) ? DCA_CONFIG.ATTACK_MODE.RECOVERY_BOOST : 1.0;
  const effectiveIntensity = baseIntensity * boostMultiplier;
  const investAmount = Math.min(totalPortfolioValue * effectiveIntensity, availableCash);

  return {
    investAmount,
    investPercent: totalPortfolioValue > 0 ? investAmount / totalPortfolioValue : 0,
    baseIntensity,
    boostMultiplier,
    effectiveIntensity,
    frequency: 'monthly',
    frequencyDays: 63,
    riskConstraintActive: false,
    riskConstraintReason: "Normal",
    description: "Inversión estándar"
  };
}

// EL PUENTE PARA ARREGLAR TU ERROR:
export function computeDCAMultiplier(input: DCAEngineInput): number {
  return computeDCADecision(input).effectiveIntensity;
}
