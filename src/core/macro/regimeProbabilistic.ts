export interface RegimeProbabilities {
  expansion: number;
  contraction: number;
  crisis: number;
}

export function detectRegimeProbabilistic(
  vix: number,
  yieldSpread: number,
  m2Growth: number
): RegimeProbabilities {
  // Crisis: VIX alto y M2 bajo
  const crisisScore = Math.min(1, vix / 50);
  const liquidityCrisis = m2Growth < 0 ? 0.6 : 0.2;
  const crisis = 0.5 * crisisScore + 0.5 * liquidityCrisis;

  // Contracción: yield spread negativo y M2 bajo
  const contractionScore = yieldSpread < 0 ? 0.7 : 0.2;
  const liquidityContraction = m2Growth < 2 ? 0.5 : 0.1;
  const contraction = 0.6 * contractionScore + 0.4 * liquidityContraction;

  // Expansión: residual, pero con límites
  let expansion = 1 - (crisis + contraction);
  expansion = Math.max(0, Math.min(1, expansion));

  // Normalizar para que sumen 1 (por si acaso)
  const total = crisis + contraction + expansion;
  return {
    crisis: crisis / total,
    contraction: contraction / total,
    expansion: expansion / total,
  };
}