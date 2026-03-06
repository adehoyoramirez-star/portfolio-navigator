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

export interface AssetInput {
  name: string;
  volatility: number;
  riskBudget: number;
}

export interface EngineInput {
  macro: MacroInputs;
  erp: number;
  liquidity: number;
  returns: number[];
  corrMatrix: number[][];
  drawdown: number;
  assets: AssetInput[];
}

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