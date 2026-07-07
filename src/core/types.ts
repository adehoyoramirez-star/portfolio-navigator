export type Regime =
  | "Expansion"
  | "Slowdown"
  | "Contraction"
  | "Crisis";

export interface MacroInputs {
  m2Growth: number;
  yieldSpread: number;
  vix: number;
  creditSpread: number;
}

// FIX-AUDIT-T7: tipos legacy — DEPRECATED.
// AssetInput canónico está en src/core/engine/olympusV3.ts.
// Estos tipos se mantienen por backward compat; no usar en código nuevo.

/** @deprecated Usar AssetInput de @/core/engine/olympusV3 */
export interface AssetInput {
  name: string;
  volatility: number;
  riskBudget: number;
}

/** @deprecated Usar OlympusEngineInput de @/core/engine/olympusV3 */
export interface EngineInput {
  macro: MacroInputs;
  erp: number;
  liquidity: number;
  returns: number[];
  corrMatrix: number[][];
  drawdown: number;
  assets: AssetInput[];
}

/** @deprecated Usar EngineOutput de @/core/engine/olympusV3 */
export interface EngineOutput {
  regime: {
    regime: Regime;
    probability: number;
  };
  expectedReturn: number;
  volatility: number;
  exposureMultiplier: number;
  weights: {
    name: string;
    weight: number;
  }[];
  simulation: number[];
}