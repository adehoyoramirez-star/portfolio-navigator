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
    // FIX-OVERPERF: cluster cap subido 45%→55% para no limitar BTC/tech
    // en mercado alcista. Cash forzado reducido 5%→3%. BTC weight subido.
    weights: {
      'BTC-EUR':  0.22,   // subido 0.18→0.22: benchmark da 14.29% fijo, engine necesita ~14% tras blend
      'XNAS.DE':  0.18,   // Nasdaq en expansión — sobreponderar
      'IS3Q.DE':  0.18,   // quality factor — siempre presente
      'URNU.DE':  0.12,   // uranio — tesis estructural
      'EMXC.DE':  0.10,   // EM — reducido para dar más peso a BTC
      'VVSM.DE':  0.12,   // semis — momentum alcista
      'PPFB.DE':  0.08,   // oro — hedge mínimo (reducido 0.10→0.08)
    },
    cashReserveForced: 0.01,        // 1% cash mínimo — casi todo invertido en EXPANSIÓN
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.65,     // BTC+XNAS+VVSM ≤ 65% — benchmark tiene 42.87%, damos margen
    kellyCapOverride: 0.25,         // Kelly cap 25% — permite BTC hasta ~20-22% post-restricciones
    description: 'Cartera crecimiento agresivo: BTC 22% objetivo, 1% cash, cluster cap 65%',
  },

  CONTRACTION: {
    // Cartera defensiva — CAMBIO REAL de composición, no solo escala
    // FIX-OVERPERF: cash forzado 20%→10% (demasiado lastre para contracciones cortas)
    // cluster cap subido 17%→25% para no malvender en correcciones técnicas
    weights: {
      'IS3Q.DE':  0.30,   // quality factor — protección en contracción
      'PPFB.DE':  0.20,   // oro — rally en incertidumbre macro
      'URNU.DE':  0.12,   // uranio — tesis independiente del ciclo
      'EMXC.DE':  0.08,   // EM — reducido, sensible al ciclo
      'BTC-EUR':  0.10,   // BTC — moderado (era 0.07, no malvender en dips)
      'XNAS.DE':  0.10,   // Nasdaq — moderado (era 0.07)
      'VVSM.DE':  0.10,   // semis — moderado (era 0.03)
    },
    cashReserveForced: 0.10,        // 10% cash obligatorio (era 20%)
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.25,     // BTC+XNAS+VVSM ≤ 25% (era 17%)
    kellyCapOverride: 0.15,         // Kelly máximo 15% en CONTRACTION (era 12%)
    description: 'Cartera defensiva moderada: quality+gold dominan, tech/crypto reducidos, 10% cash',
  },

  CRISIS: {
    // Cartera supervivencia — preservar capital primero
    // Code Review feedback: CRISIS debe ser defensiva. BTC a 5%, cash 35%, cluster cap 15%.
    // Las correcciones de overperformance se concentran en EXPANSION (80% de los días).
    // CRISIS tiene solo ~63 días en 4117 (1.5%) — no mueve el CAGR pero protege en cola.
    weights: {
      'PPFB.DE':  0.40,   // oro — refugio primario en crisis
      'IS3Q.DE':  0.25,   // quality — compañías con balance sólido
      'URNU.DE':  0.10,   // uranio — mantener tesis (supply gap independiente)
      'BTC-EUR':  0.05,   // BTC — mínimo (revertido de 0.10 por feedback reviewer)
      'EMXC.DE':  0.05,   // EM — mínimo
      'XNAS.DE':  0.05,   // Nasdaq — mínimo (revertido de 0.08)
      'VVSM.DE':  0.05,   // semis — mínimo (revertido de 0.07)
    },
    cashReserveForced: 0.35,        // 35% cash — polvo seco para oportunidades de crisis
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.15,     // BTC+XNAS+VVSM ≤ 15% — mínimo en crisis
    kellyCapOverride: 0.08,         // Kelly máximo 8% en CRISIS
    description: 'Cartera supervivencia: 40% gold + 35% cash, BTC 5%, cluster cap 15%',
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
  blendToTacticalRatio = 0.50,  // 50% optimización, 50% táctico — balance entre pesos cuantitativos y tácticos
  // Code Review: 0.40 daba demasiado peso a pesos manuales vs optimización cuantitativa.
  // 0.50 mantiene ~13.5% BTC (vs benchmark 14.29%) mientras preserva la influencia de BL+HRP+MinVar.
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