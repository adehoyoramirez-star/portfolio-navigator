import { AssetInput } from "../types";

export function computeRiskParityWeights(assets: AssetInput[]) {
  const raw = assets.map(asset => ({
    name: asset.name,
    weight: asset.riskBudget / asset.volatility,
  }));
  const total = raw.reduce((sum, a) => sum + a.weight, 0);
  return raw.map(a => ({ name: a.name, weight: total === 0 ? 0 : a.weight / total }));
}