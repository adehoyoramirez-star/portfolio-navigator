// ===============================================
// ARCHIVO: src/core/engine/olympusV3.ts
// ===============================================
import { calculateMomentum } from "../factors/momentum";
import { calculateValue } from "../factors/value";
import { detectCrisis } from "../macro/crisis";
import { calculateKelly } from "../portfolio/kelly";
import { correlationPenalty } from "../portfolio/correlation";

export interface AssetInput {
  name: string;
  returns12m: number;
  returns3m: number;
  returns1m: number;
  earningsYield: number;
  volatility: number;
}

export interface OlympusOutput {
  name: string;
  momentumScore: number;
  valueScore: number;
  expectedReturn: number;
  kellyFraction: number;
  baseAllocation: number;
  finalAllocation: number;
}

export interface EngineOutput {
  allocations: OlympusOutput[];
  crisis: {
    probability: number;
    regime: "EXPANSION" | "CONTRACTION" | "CRISIS";
  };
  correlationPenalty: number;
  totalAllocation: number;
}

export interface OlympusEngineInput {
  assets: AssetInput[];
  correlationMatrix: number[][];
  macro: {
    vix: number;
    yieldSpread: number;
    creditSpread: number;
  };
}

export function runOlympusEngine(input: OlympusEngineInput): EngineOutput {
  const { assets, correlationMatrix, macro } = input;
  const crisis = detectCrisis(macro.vix, macro.yieldSpread, macro.creditSpread);
  const corrPenalty = correlationPenalty(correlationMatrix);

  const allocations: OlympusOutput[] = [];

  for (const asset of assets) {
    const momentum = calculateMomentum({
      returns12m: asset.returns12m,
      returns1m: asset.returns1m,
      returns3m: asset.returns3m,
    });

    const value = calculateValue({ earningsYield: asset.earningsYield });

    const expectedReturn = momentum.momentumScore * 0.6 + value.valueScore * 0.4;

    const kelly = calculateKelly({
      expectedReturn,
      volatility: asset.volatility,
    });

    let regimePenalty = 1;
    if (crisis.regime === "CRISIS") regimePenalty = 0.4;
    else if (crisis.regime === "CONTRACTION") regimePenalty = 0.7;

    const baseAllocation = kelly.kellyFraction * corrPenalty * regimePenalty;

    allocations.push({
      name: asset.name,
      momentumScore: momentum.momentumScore,
      valueScore: value.valueScore,
      expectedReturn,
      kellyFraction: kelly.kellyFraction,
      baseAllocation,
      finalAllocation: 0,
    });
  }

  const totalBase = allocations.reduce((sum, a) => sum + a.baseAllocation, 0);
  if (totalBase > 0) {
    allocations.forEach(a => {
      a.finalAllocation = a.baseAllocation / totalBase;
    });
  }

  const totalAllocation = allocations.reduce((sum, a) => sum + a.finalAllocation, 0);

  return {
    allocations,
    crisis: {
      probability: crisis.crisisProbability,
      regime: crisis.regime,
    },
    correlationPenalty: corrPenalty,
    totalAllocation,
  };
}