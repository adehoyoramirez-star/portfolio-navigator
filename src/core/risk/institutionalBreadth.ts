// ===============================================
// Institutional Breadth Overlay — shadow-mode candidate
// ===============================================
// Este módulo NO cambia por defecto la exposición de OlympusV3.
// Su propósito es producir una señal auditable para validación OOS.

export interface InstitutionalBreadthAsset {
  ticker: string;
  returns3m: number;
  volatility: number;
  weight: number;
  /** Marginal risk contribution supplied by the covariance-aware engine. */
  riskContribution?: number;
}

export interface InstitutionalBreadthConfig {
  activationThreshold: number;
  deactivationThreshold: number;
  activationDays: number;
  deactivationDays: number;
  minimumMultiplier: number;
  maximumMultiplier: number;
  slope: number;
}

export const DEFAULT_INSTITUTIONAL_BREADTH_CONFIG: InstitutionalBreadthConfig = {
  activationThreshold: 0.50,
  deactivationThreshold: 0.40,
  activationDays: 3,
  deactivationDays: 5,
  minimumMultiplier: 0.40,
  maximumMultiplier: 1.00,
  slope: 1.20,
};

export function resolveInstitutionalBreadthConfig(
  overrides: Partial<InstitutionalBreadthConfig> = {},
): InstitutionalBreadthConfig {
  return { ...DEFAULT_INSTITUTIONAL_BREADTH_CONFIG, ...overrides };
}

export interface InstitutionalBreadthState {
  active: boolean;
  adverseDays: number;
  benignDays: number;
}

export interface InstitutionalBreadthResult {
  active: boolean;
  multiplier: number;
  riskBreadth: number;
  negativeCount: number;
  negativePct: number;
  reason: string;
  state: InstitutionalBreadthState;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Evalúa la fracción de riesgo expuesta a activos con momentum absoluto negativo.
 * Cada activo aporta weight × volatility; no modifica pesos de cartera.
 */
export function computeInstitutionalRiskBreadth(
  assets: InstitutionalBreadthAsset[],
): { riskBreadth: number; negativeCount: number; negativePct: number } {
  const valid = assets.filter(asset =>
    Number.isFinite(asset.returns3m) &&
    Number.isFinite(asset.volatility) && asset.volatility > 0 &&
    Number.isFinite(asset.weight) && asset.weight >= 0,
  );
  if (valid.length === 0) return { riskBreadth: 0, negativeCount: 0, negativePct: 0 };

  const riskMeasure = (asset: InstitutionalBreadthAsset): number => {
    const supplied = asset.riskContribution;
    return supplied !== undefined && Number.isFinite(supplied) && supplied > 0
      ? supplied
      : asset.weight * asset.volatility;
  };
  const totalRisk = valid.reduce((sum, asset) => sum + riskMeasure(asset), 0);
  const adverseRisk = valid
    .filter(asset => asset.returns3m < 0)
    .reduce((sum, asset) => sum + riskMeasure(asset), 0);
  const negativeCount = valid.filter(asset => asset.returns3m < 0).length;

  return {
    riskBreadth: totalRisk > 0 ? clamp(adverseRisk / totalRisk, 0, 1) : 0,
    negativeCount,
    negativePct: negativeCount / valid.length,
  };
}

export function evaluateInstitutionalBreadth(
  assets: InstitutionalBreadthAsset[],
  previousState: InstitutionalBreadthState = { active: false, adverseDays: 0, benignDays: 0 },
  config: InstitutionalBreadthConfig = DEFAULT_INSTITUTIONAL_BREADTH_CONFIG,
): InstitutionalBreadthResult {
  const breadth = computeInstitutionalRiskBreadth(assets);
  const adverse = breadth.riskBreadth >= config.activationThreshold;
  const benign = breadth.riskBreadth <= config.deactivationThreshold;
  const adverseDays = adverse ? previousState.adverseDays + 1 : 0;
  const benignDays = benign ? previousState.benignDays + 1 : 0;

  let active = previousState.active;
  if (!active && adverseDays >= config.activationDays) active = true;
  if (active && benignDays >= config.deactivationDays) active = false;

  // La función es continua; la histéresis decide si el candidato está confirmado.
  const excessBreadth = Math.max(0, breadth.riskBreadth - config.deactivationThreshold);
  const rawMultiplier = config.maximumMultiplier - config.slope * excessBreadth;
  const multiplier = active
    ? clamp(rawMultiplier, config.minimumMultiplier, config.maximumMultiplier)
    : config.maximumMultiplier;

  const state = { active, adverseDays, benignDays };
  const reason = active
    ? `shadow breadth: riesgo adverso ${(breadth.riskBreadth * 100).toFixed(1)}% → multiplicador ${(multiplier * 100).toFixed(1)}%`
    : `shadow breadth: riesgo adverso ${(breadth.riskBreadth * 100).toFixed(1)}% → sin reducción confirmada`;

  return {
    active,
    multiplier,
    riskBreadth: breadth.riskBreadth,
    negativeCount: breadth.negativeCount,
    negativePct: breadth.negativePct,
    reason,
    state,
  };
}
