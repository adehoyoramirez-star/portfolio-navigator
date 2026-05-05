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
  | 'BTC-EUR' | 'VVSM.DE' | 'IS3Q.DE' | 'URNU.DE'
  | 'EMXC.DE' | 'PPFB.DE' | 'XNAS.DE';

export interface RegimeTacticalWeights {
  weights: Partial<Record<AssetTicker, number>>;
  cashReserveForced: number;     // % mínimo de cash fuera de la cartera
  maxSingleAsset: number;        // cap individual (default: 0.25)
  maxTechCryptoCluster: number;  // cap BTC+XNAS+VVSM (default: 0.40)
  kellyCapOverride: number;      // cap Kelly en este régimen
  description: string;
}

// ── CARTERAS TÁCTICAS POR RÉGIMEN ────────────────────────────────────────────
export const REGIME_TACTICAL_ALLOCATIONS: Record<string, RegimeTacticalWeights> = {
  EXPANSION: {
    // Cartera de crecimiento — permisiva con tech/crypto
    weights: {
      'BTC-EUR':  0.15,   // máx permitido por política
      'XNAS.DE':  0.18,   // Nasdaq en expansión — sobreponderar
      'IS3Q.DE':  0.20,   // quality factor — siempre presente
      'URNU.DE':  0.15,   // uranio — tesis estructural
      'EMXC.DE':  0.12,   // EM — oportunismo en expansión
      'VVSM.DE':  0.12,   // semis — momentum alcista
      'PPFB.DE':  0.08,   // oro — hedge mínimo
    },
    cashReserveForced: 0.05,        // 5% cash mínimo
    maxSingleAsset: 0.25,
    maxTechCryptoCluster: 0.45,     // BTC+XNAS+VVSM ≤ 45%
    kellyCapOverride: 0.20,
    description: 'Cartera crecimiento: tech/crypto permitidos, momentum dominante',
  },

  CONTRACTION: {
    // Cartera defensiva — CAMBIO REAL de composición, no solo escala
    // En CONTRACTION: -9.3% CAGR con la estructura actual → necesita rotación a defensivos
    weights: {
      'IS3Q.DE':  0.35,   // quality factor — protección en contracción
      'PPFB.DE':  0.25,   // oro — rally en incertidumbre macro
      'URNU.DE':  0.15,   // uranio — tesis independiente del ciclo
      'EMXC.DE':  0.08,   // EM — reducido, sensible al ciclo
      'BTC-EUR':  0.07,   // BTC — reducido en CONTRACTION (cartera heredada: HODL, no vender)
      'XNAS.DE':  0.07,   // Nasdaq — reducido, sensible a tipos
      'VVSM.DE':  0.03,   // semis — mínimo, correlación alta con BTC
    },
    cashReserveForced: 0.20,        // 20% cash obligatorio — no invertido
    maxSingleAsset: 0.35,
    maxTechCryptoCluster: 0.17,     // BTC+XNAS+VVSM ≤ 17% en CONTRACTION
    kellyCapOverride: 0.12,         // Kelly máximo 12% en CONTRACTION
    description: 'Cartera defensiva: quality+gold dominan, tech/crypto reducidos, 20% cash',
  },

  CRISIS: {
    // Cartera supervivencia — preservar capital primero
    weights: {
      'PPFB.DE':  0.40,   // oro — refugio primario en crisis
      'IS3Q.DE':  0.30,   // quality — compañías con balance sólido
      'URNU.DE':  0.10,   // uranio — mantener tesis (supply gap independiente)
      'BTC-EUR':  0.05,   // BTC — mínimo absoluto (cartera heredada HODL)
      'EMXC.DE':  0.05,   // EM — mínimo
      'XNAS.DE':  0.05,   // Nasdaq — mínimo
      'VVSM.DE':  0.05,   // semis — mínimo
    },
    cashReserveForced: 0.40,        // 40% cash — "polvo seco" para oportunidades
    maxSingleAsset: 0.40,
    maxTechCryptoCluster: 0.15,     // BTC+XNAS+VVSM ≤ 15% en CRISIS
    kellyCapOverride: 0.08,         // Kelly máximo 8% en CRISIS
    description: 'Cartera supervivencia: 40% cash, gold+quality dominan, mínimo riesgo',
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
  blendToTacticalRatio = 0.60,  // 60% optimización, 40% táctico — ajustable
): number[] {
  const tacticalConfig = REGIME_TACTICAL_ALLOCATIONS[regime]
    ?? REGIME_TACTICAL_ALLOCATIONS['EXPANSION'];

  // Blend: optimización cuantitativa + restricción táctica de régimen
  const blended = blendNorm.map((w, i) =>
    w * blendToTacticalRatio + tacticalWeights[i] * (1 - blendToTacticalRatio)
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

// ── CAP DEL CLUSTER TECH-CRYPTO (BTC + XNAS + VVSM) ─────────────────────────
export const TECH_CRYPTO_TICKERS = new Set(['BTC-EUR', 'XNAS.DE', 'VVSM.DE']);

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