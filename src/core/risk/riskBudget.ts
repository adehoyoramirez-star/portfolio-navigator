// ===============================================
// ARCHIVO: src/core/risk/riskBudget.ts
// NIVEL 2: Risk Parity conectado al motor
// ===============================================
// ANTES: usaba AssetInput de ../types que requería campo `riskBudget`
//   inexistente en el Asset del dashboard → código muerto
//
// AHORA: opera sobre los activos del motor directamente
//   Risk budget por defecto = igual para todos (equal risk contribution)
//   Override por sector: crypto recibe presupuesto reducido automáticamente
// ===============================================

export interface RiskParityAsset {
  name: string;
  volatility: number;   // decimal anualizado (0.60 = 60%)
  riskBudget?: number;  // opcional: presupuesto de riesgo relativo [0,1]
                        // si no se pasa, se usa equal risk contribution
}

export interface RiskParityWeight {
  name: string;
  weight: number;       // [0,1] — suman 1
  riskContribution: number; // peso × volatilidad (para verificación)
}

/**
 * Calcula pesos de risk parity (igual contribución de riesgo) o
 * risk budgeting (contribución proporcional al budget asignado).
 *
 * Fórmula: weight_i = budget_i / vol_i
 * Normalizado para que sumen 1.
 *
 * Con budget=1 para todos → equal risk contribution (ERC / risk parity puro)
 * Con budgets distintos   → risk budgeting (BlackRock style)
 *
 * @example — uso en olympusV3.ts para blendear con Kelly:
 *   const rpWeights = computeRiskParityWeights(assets);
 *   // blend 50% Kelly + 50% Risk Parity
 *   finalWeight = 0.5 * kellyWeight + 0.5 * rpWeight
 */
export function computeRiskParityWeights(assets: RiskParityAsset[]): RiskParityWeight[] {
  if (assets.length === 0) return [];

  // Budget por defecto: igual para todos (equal risk contribution)
  const withBudgets = assets.map(a => ({
    ...a,
    budget: a.riskBudget ?? 1,
    vol: a.volatility > 0 ? a.volatility : 0.01, // guard contra vol=0
  }));

  // Peso raw = budget / volatilidad
  const rawWeights = withBudgets.map(a => ({
    name: a.name,
    raw: a.budget / a.vol,
    vol: a.vol,
  }));

  const totalRaw = rawWeights.reduce((s, a) => s + a.raw, 0);
  if (totalRaw === 0) {
    const eq = 1 / assets.length;
    return assets.map(a => ({ name: a.name, weight: eq, riskContribution: eq }));
  }

  const normalized = rawWeights.map(a => ({
    name: a.name,
    weight: a.raw / totalRaw,
    riskContribution: (a.raw / totalRaw) * a.vol,
  }));

  return normalized;
}

/**
 * Budgets de riesgo por sector para el universo del dashboard.
 * Reducir cripto relativo a equity — su volatilidad es 3-4x mayor.
 *
 * Uso en olympusV3.ts:
 *   const sectorBudgets = getSectorRiskBudgets(assets, SECTOR_MAP);
 *   const rpWeights = computeRiskParityWeights(
 *     assets.map((a, i) => ({ ...a, riskBudget: sectorBudgets[i] }))
 *   );
 */
export const DEFAULT_SECTOR_BUDGETS: Record<string, number> = {
  crypto:      0.6,  // BTC recibe 60% del budget por unidad de vol — reduce dominancia
  emerging:    1.0,
  gold:        1.0,
  uranium:     0.9,
  semis:       1.0,
  real_estate: 1.0,
};