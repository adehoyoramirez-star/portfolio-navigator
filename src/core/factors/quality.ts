// ===============================================
// ARCHIVO: src/core/factors/quality.ts
// Factor de CALIDAD — cross-sectional z-score
// FIX-IS3Q-QUALITY: IS3Q.DE (MSCI World Quality) debe recibir
//   bonus de calidad explícito porque su índice de referencia
//   ya pre-selecciona empresas de alta calidad (ROE, deuda baja).
//   Anteriormente el motor lo trataba como equity genérico.
// ===============================================
// Para ETFs de factor quality como IS3Q:
//   El factor Quality captura que empresas con alta calidad tienden
//   a superar al mercado en el largo plazo (especialmente en crisis).
//   IS3Q ya tiene este sesgo de selección integrado en su índice.
//
// Calibración histórica:
//   IS3Q.DE (Quality): calidad muy alta — baja vol (~15%), retornos estables
//   Oro (PPFB.DE): calidad alta — vol muy baja (~14%), descorrelacionado
//   Semiconductores (VVSM.DE): calidad media — alta vol pero buen Sharpe ciclo AI
//   Uranio (URNU.DE): calidad media-baja — vol alta, fundamental sólido LP
//   BTC: calidad baja (por métricas tradicionales) — vol extrema aunque retornos altos
// ===============================================

export interface QualityInput {
  volatility: number;   // decimal anualizado (0.60 = 60%)
  returns12m: number;
  returns3m: number;
  returns1m: number;
  // FIX-IS3Q-QUALITY: campo opcional para activos que ya son factor quality
  // Si true, se añade un bonus de +0.3 al qualityScore final
  isQualityFactor?: boolean;
}

export interface QualityResult {
  qualityScore: number;        // z-score cross-sectional [-2, +2]
  implicitSharpe: number;
  returnConsistency: number;
  volatilityScore: number;
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

  const sharpeZ = (implicitSharpe - stats.meanSharpe) / stats.stdSharpe;
  const volZ = -((input.volatility - stats.meanVol) / stats.stdVol);
  const consistencyZ = (returnConsistency - 0.5) * 4;

  let rawQuality = sharpeZ * 0.50 + volZ * 0.30 + consistencyZ * 0.20;

  // FIX-IS3Q-QUALITY: bonus para ETFs de factor quality.
  // NOTA (22-Jun-2026): IS3Q.DE fue eliminado del portfolio.
  // Ningún activo actual usa isQualityFactor=true → este bonus está inactivo.
  // Se mantiene por si se reintroduce un ETF de quality en el futuro.
  if (input.isQualityFactor) {
    rawQuality += 0.30;
  }

  const qualityScore = Math.max(-2, Math.min(2, rawQuality));

  return {
    qualityScore,
    implicitSharpe,
    returnConsistency,
    volatilityScore: volZ,
  };
}

function computeConsistency(a: QualityInput): number {
  const r12 = a.returns12m;
  const r3  = a.returns3m;
  const r1  = a.returns1m;

  const allPositive    = r12 > 0 && r3 > 0 && r1 > 0 ? 0.4 : 0;
  const decelerating   = r12 > 0 && r3 >= r1 ? 0.2 : 0;
  const noReversal     = Math.sign(r12) === Math.sign(r3) ? 0.2 : 0;
  const magnitudeCheck = Math.abs(r1) < Math.abs(r12) * 0.5 ? 0.2 : 0;

  return allPositive + decelerating + noReversal + magnitudeCheck;
}
