// ===============================================
// ARCHIVO: src/core/factors/quality.ts
// Factor de CALIDAD — cross-sectional z-score
// ===============================================
// El factor Quality captura que las empresas/ETFs de alta calidad
// tienden a superar al mercado en el largo plazo, especialmente en crisis.
//
// Para ETFs (no acciones individuales) aproximamos calidad con:
//   1. Estabilidad de retornos:  menor volatilidad = más calidad
//   2. Consistencia de momentum: 12m > 3m > 1m = tendencia sana
//   3. Sharpe implícito: retorno/vol = eficiencia del activo
//
// Calibración histórica:
//   - Oro (PPFB.DE): calidad alta — vol baja, retornos estables
//   - Semiconductores (VVSM.DE): calidad media — alta vol pero buen Sharpe
//   - BTC: calidad baja — vol extrema aunque retornos altos
//   - Emergentes (EMXC/IS3Q): calidad variable según ciclo macro
// ===============================================

export interface QualityInput {
  volatility: number;   // decimal anualizado (0.60 = 60%)
  returns12m: number;
  returns3m: number;
  returns1m: number;
}

export interface QualityResult {
  qualityScore: number;        // z-score cross-sectional [-2, +2]
  implicitSharpe: number;      // return12m / volatility (sin risk-free)
  returnConsistency: number;   // consistencia de la tendencia [0, 1]
  volatilityScore: number;     // z-score de la volatilidad (menor = mejor)
}

export interface QualityUniverseStats {
  sharpes: number[];
  consistencies: number[];
  vols: number[];
  meanSharpe: number;
  stdSharpe: number;
  meanVol: number;
  stdVol: number;
}

export function computeQualityUniverseStats(assets: QualityInput[]): QualityUniverseStats {
  const sharpes = assets.map(a =>
    a.volatility > 0 ? a.returns12m / a.volatility : 0
  );
  const consistencies = assets.map(a => computeConsistency(a));
  const vols = assets.map(a => a.volatility);

  const meanSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
  const stdSharpe = Math.sqrt(
    sharpes.reduce((s, v) => s + (v - meanSharpe) ** 2, 0) / sharpes.length
  ) || 1;

  const meanVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const stdVol = Math.sqrt(
    vols.reduce((s, v) => s + (v - meanVol) ** 2, 0) / vols.length
  ) || 1;

  return { sharpes, consistencies, vols, meanSharpe, stdSharpe, meanVol, stdVol };
}

export function calculateQuality(
  input: QualityInput,
  stats: QualityUniverseStats
): QualityResult {
  const implicitSharpe = input.volatility > 0 ? input.returns12m / input.volatility : 0;
  const returnConsistency = computeConsistency(input);

  // Z-score del Sharpe (mayor = mejor calidad)
  const sharpeZ = (implicitSharpe - stats.meanSharpe) / stats.stdSharpe;

  // Z-score de la volatilidad (INVERTIDO: menor vol = mejor calidad)
  const volZ = -((input.volatility - stats.meanVol) / stats.stdVol);

  // Z-score de consistencia [0,1] → centrar en 0.5
  const consistencyZ = (returnConsistency - 0.5) * 4; // escala ~[-2, +2]

  // Score compuesto: 50% Sharpe + 30% vol baja + 20% consistencia
  const rawQuality = sharpeZ * 0.50 + volZ * 0.30 + consistencyZ * 0.20;

  const qualityScore = Math.max(-2, Math.min(2, rawQuality));

  return {
    qualityScore,
    implicitSharpe,
    returnConsistency,
    volatilityScore: volZ,
  };
}

// Consistencia: ¿la tendencia es suave o errática?
// 12m > 3m > 1m positivos = tendencia sana = 1.0
// Retornos inconsistentes entre períodos = 0.0
function computeConsistency(a: QualityInput): number {
  const r12 = a.returns12m;
  const r3  = a.returns3m;
  const r1  = a.returns1m;

  // Señales de consistencia
  const allPositive    = r12 > 0 && r3 > 0 && r1 > 0 ? 0.4 : 0;
  const decelerating   = r12 > 0 && r3 >= r1 ? 0.2 : 0; // sano: retorno anual > mensual
  const noReversal     = Math.sign(r12) === Math.sign(r3) ? 0.2 : 0;
  const magnitudeCheck = Math.abs(r1) < Math.abs(r12) * 0.5 ? 0.2 : 0; // sin aceleración brusca

  return allPositive + decelerating + noReversal + magnitudeCheck;
}