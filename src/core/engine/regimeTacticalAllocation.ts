// ════════════════════════════════════════════════════════════════════
// ARCHIVO: src/core/engine/regimeTacticalAllocation.ts
// OLYMPUS X — Carteras tácticas predefinidas por régimen
// ════════════════════════════════════════════════════════════════════
// PROBLEMA QUE RESUELVE:
//   La penalización de régimen actual (×0.616 en CONTRACTION) escala
//   uniformemente todos los activos. BTC pasa de 11% a 6.8%, pero
//   sigue siendo la posición más volátil en cartera. El resultado:
//   -9.3% CAGR y Sharpe -0.75 en CONTRACTION porque el motor mantiene
//   la misma estructura de riesgo con menos exposición total.
//
//   SOLUCIÓN: En CONTRACTION y CRISIS, cambiar los PESOS OBJETIVO,
//   no solo escalar la exposición. La optimización (BL+HRP+MV) opera
//   sobre estos pesos base con desviaciones máximas permitidas (±20%).
//
// CARTERAS TÁCTICAS (validadas contra literatura académica):
//   EXPANSION:   cartera "momentum" — perseguir activos con tendencia
//   CONTRACTION: cartera "defensiva" — reducir riesgo, no solo exposición
//   CRISIS:      cartera "supervivencia" — preservar capital, minimal BTC

// Tickers disponibles en el portfolio
type AssetTicker =
  | 'BTC-EUR' | 'VVSM.DE' | 'URNU.DE'
  | 'EMXC.DE' | 'PPFB.DE' | '0P00000WLG.F';

export interface RegimeTacticalWeights {
  weights: Partial<Record<AssetTicker, number>>;
  cashReserveForced: number;     // % mínimo de cash fuera de la cartera
  maxSingleAsset: number;        // cap individual (default: 0.25)
  maxTechCryptoCluster: number;  // cap BTC+VVSM (default: 0.40)
  kellyCapOverride: number;      // cap Kelly en este régimen
  blendToTacticalRatio: number;  // blend 0-1: 0=más táctico, 1=más cuantitativo
  description: string;
}

// ── CARTERAS TÁCTICAS POR RÉGIMEN ────────────────────────────────────────────
export const REGIME_TACTICAL_ALLOCATIONS: Record<string, RegimeTacticalWeights> = {
  EXPANSION: {
    // Cartera de crecimiento — WLG como núcleo developed equity, VVSM como tilt tech/semis
    // IS3Q y XNAS eliminados (redundantes con WLG). Sus pesos redistribuidos.
    weights: {
      'BTC-EUR':  0.25,   // subido 0.22→0.25: más peso al activo más descorrelacionado
      '0P00000WLG.F': 0.22,   // núcleo global — sustituye a IS3Q+XNAS como developed equity base
      'VVSM.DE':  0.18,   // semis — tilt AI (subido 0.12→0.18, absorbe parte de XNAS)
      'URNU.DE':  0.12,   // uranio — tesis estructural
      'EMXC.DE':  0.12,   // EM — subido para compensar menos activos
      'PPFB.DE':  0.11,   // oro — hedge subido (0.08→0.11, más peso sin IS3Q)
    },
    cashReserveForced: 0.01,        // 1% cash mínimo — casi todo invertido en EXPANSIÓN
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.55,     // BTC+VVSM ≤ 55% — benchmark da ~31%, damos margen
    kellyCapOverride: 0.25,         // Kelly cap 25% — permite BTC hasta ~22% post-restricciones
    blendToTacticalRatio: 0.30,     // 70% táctico — más agresivo
    description: 'Cartera crecimiento: WLG 22% núcleo, BTC 25%, VVSM 18% tilt AI',
  },

  // FIX-PORTFOLIO-6: IS3Q y XNAS eliminados. WLG = núcleo developed equity.
  // CONTRACTION más equilibrada: WLG + gold como anclas, VVSM como tilt tech.
  CONTRACTION: {
    // Cartera equilibrada — WLG sustituye a IS3Q como ancla defensiva de developed markets
    weights: {
      '0P00000WLG.F': 0.28,   // núcleo global — sustituye a IS3Q (0.25) + parte de XNAS (0.13)
      'PPFB.DE':  0.18,   // oro — subido de 0.15, más peso defensivo con menos activos
      'BTC-EUR':  0.15,   // BTC — subido de 0.13, descorrelación creciente
      'VVSM.DE':  0.15,   // semis — subido de 0.12, absorbe tilt tech de XNAS
      'URNU.DE':  0.12,   // uranio — tesis independiente del ciclo
      'EMXC.DE':  0.12,   // EM — subido de 0.10, diversificación geográfica
    },
    cashReserveForced: 0.00,        // 0% cash forzado
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.40,     // BTC+VVSM ≤ 40%
    kellyCapOverride: 0.18,
    blendToTacticalRatio: 0.50,     // 50/50 — balance entre protección y crecimiento
    description: 'Cartera equilibrada: WLG 28% núcleo, gold 18%, BTC+VVSM 30%',
  },

  CRISIS: {
    // Cartera supervivencia — preservar capital primero
    weights: {
      'PPFB.DE':  0.35,   // oro — refugio primario en crisis
      '0P00000WLG.F': 0.15,   // núcleo global — calidad developed markets (sustituye a IS3Q)
      'URNU.DE':  0.07,   // uranio — mantener tesis (supply gap independiente)
      'BTC-EUR':  0.03,   // BTC — mínimo
      'EMXC.DE':  0.03,   // EM — mínimo
      'VVSM.DE':  0.02,   // semis — mínimo
    },
    cashReserveForced: 0.35,        // 35% cash — polvo seco para oportunidades de crisis
    maxSingleAsset: 0.35,
    maxTechCryptoCluster: 0.10,     // BTC+VVSM ≤ 10% — mínimo en crisis
    kellyCapOverride: 0.08,         // Kelly máximo 8% en CRISIS
    blendToTacticalRatio: 0.70,     // 70% cuantitativo — conservador: gold y WLG dominan
    description: 'Cartera supervivencia: 35% gold + 35% cash, WLG 15%, BTC+VVSM 5%',
  },
};

// ── FUNCIÓN DE INTEGRACIÓN CON OLYMPUS V3 ────────────────────────────────────
// Uso en olympusV3.ts, después de computar blendNorm:
//
//   const tacticalWeights = getTacticalWeights(masterRegime.regime, assets);
//   const blendWithTactical = applyTacticalConstraints(blendNorm, tacticalWeights, assets);
//
// Esto reemplaza la penalización uniforme (×0.616) por un cambio real de composición.

export function getTacticalWeights(
  regime: string,
  assets: { name: string; ticker?: string }[]
): number[] {
  const tacticalConfig = REGIME_TACTICAL_ALLOCATIONS[regime]
    ?? REGIME_TACTICAL_ALLOCATIONS['EXPANSION'];
  const w = tacticalConfig.weights;

  return assets.map(a => {
    const ticker = a.ticker ?? a.name;
    return w[ticker as AssetTicker] ?? (1 / assets.length);
  });
}

export function applyTacticalConstraints(
  blendNorm: number[],
  tacticalWeights: number[],
  regime: string,
  blendToTacticalRatio?: number,  // Opcional — si no se pasa, se lee del config por régimen
): number[] {
  const tacticalConfig = REGIME_TACTICAL_ALLOCATIONS[regime]
    ?? REGIME_TACTICAL_ALLOCATIONS['EXPANSION'];

  // FIX-BIMODAL (30-May-2026): blendToTacticalRatio ahora es dinámico por régimen.
  // EXPANSION: 0.30 → 70% táctico (más agresivo, BTC 22% guía)
  // CONTRACTION: 0.50 → 50/50 balance
  // CRISIS: 0.70 → 70% cuantitativo (más conservador, gold/quality pesan menos)
  // Si no se pasa el ratio, se obtiene del config del régimen.
  const effectiveBlendRatio = blendToTacticalRatio
    ?? (REGIME_TACTICAL_ALLOCATIONS[regime]?.blendToTacticalRatio ?? 0.50);

  const blended = blendNorm.map((w, i) =>
    w * effectiveBlendRatio + tacticalWeights[i] * (1 - effectiveBlendRatio)
  );

  // Normalizar
  const total = blended.reduce((s, w) => s + w, 0) || 1;
  const normalized = blended.map(w => w / total);

  // Aplicar cap individual
  const capped = normalized.map(w =>
    Math.min(w, tacticalConfig.maxSingleAsset)
  );

  // Renormalizar post-cap
  const totalCapped = capped.reduce((s, w) => s + w, 0) || 1;
  return capped.map(w => w / totalCapped);
}

// ── CAP DEL CLUSTER TECH-CRYPTO (BTC + VVSM) ─────────────────────────────────
// XNAS.DE eliminado (redundante con WLG). Cluster ahora solo BTC + VVSM.
export const TECH_CRYPTO_TICKERS = new Set(['BTC-EUR', 'VVSM.DE']);

export function enforceClusterCap(
  weights: number[],
  assets: { name: string; ticker?: string }[],
  regime: string,
): number[] {
  const config = REGIME_TACTICAL_ALLOCATIONS[regime]
    ?? REGIME_TACTICAL_ALLOCATIONS['EXPANSION'];
  const clusterCap = config.maxTechCryptoCluster;

  const clusterIdxs = assets.reduce((acc, a, i) => {
    if (TECH_CRYPTO_TICKERS.has(a.ticker ?? a.name)) acc.push(i);
    return acc;
  }, [] as number[]);

  const currentCluster = clusterIdxs.reduce((s, i) => s + weights[i], 0);

  if (currentCluster <= clusterCap) return weights;

  // Escalar cluster hacia el cap
  const scale = clusterCap / currentCluster;
  const excess = currentCluster - clusterCap;
  const nonClusterIdxs = assets.map((_, i) => i).filter(i => !clusterIdxs.includes(i));
  const nonClusterTotal = nonClusterIdxs.reduce((s, i) => s + weights[i], 0) || 1;

  return weights.map((w, i) => {
    if (clusterIdxs.includes(i)) return w * scale;
    return w + excess * (weights[i] / nonClusterTotal);
  });
}