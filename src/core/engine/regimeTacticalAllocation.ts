// ════════════════════════════════════════════════════════════════════
// ARCHIVO: src/core/engine/regimeTacticalAllocation.ts
// OLYMPUS X — Overlay Discrecional por Régimen
// ════════════════════════════════════════════════════════════════════
// FIX-R2-C10 (auditoría institucional ronda 2):
//   ANTES: REGIME_TACTICAL_ALLOCATIONS — sonaba a "táctico = automático"
//     cuando en realidad son pesos discrecionales definidos por el gestor.
//     El blendToTacticalRatio daba más peso al overlay en EXPANSION (70%)
//     que en CRISIS (30%), lo cual es contraintuitivo: en crisis quieres
//     MÁS control del motor cuantitativo (BL+HRP+MinVar protegen), no menos.
//   AHORA: DISCRETIONARY_OVERLAY — nombre honesto. El blend da prioridad
//     al motor cuantitativo cuando el estrés aumenta:
//       EXPANSION:    70% cuant / 30% overlay
//       CONTRACTION:  80% cuant / 20% overlay
//       CRISIS:      100% cuant / 0% overlay (solo BL+HRP+MinVar)
//     En crisis, el overlay se desactiva completamente — el motor
//     cuantitativo con mínima varianza y HRP protege mejor que cualquier
//     guía discrecional.

// Tickers disponibles en el portfolio
type AssetTicker =
  | 'BTC-EUR' | 'VVSM.DE' | 'URNU.DE'
  | 'EMXC.DE' | 'PPFB.DE' | '0P00000WLG.F';

export interface RegimeTacticalWeights {
  weights: Partial<Record<AssetTicker, number>>;
  maxSingleAsset: number;
  maxTechCryptoCluster: number;
  kellyCapOverride: number;
  // FIX-R2-C10: blendToTacticalRatio ahora es blendQuantWeight:
  //   fracción del peso final que viene del motor cuantitativo (BL+HRP+MinVar).
  //   1 - blendQuantWeight = fracción del overlay discrecional.
  //   EXPANSION=0.70, CONTRACTION=0.80, CRISIS=1.00 (sin overlay).
  blendToTacticalRatio: number;
  description: string;
}

// ── OVERLAY DISCRECIONAL POR RÉGIMEN ────────────────────────────────────────
// FIX-R2-C10: renombrado de REGIME_TACTICAL_ALLOCATIONS a DISCRETIONARY_OVERLAY.
// El overlay es una guía de pesos definida por el gestor, no una asignación
// táctica automática. Su peso en el blend DECRECE con el estrés:
//   EXPANSION:    70% cuantitativo / 30% overlay (más margen para convicción)
//   CONTRACTION:  80% cuantitativo / 20% overlay
//   CRISIS:      100% cuantitativo / 0% overlay (solo BL+HRP+MinVar)
// En CRISIS el overlay se desactiva: el motor cuantitativo con MinVar+HRP
// es más rápido reaccionando a correlaciones extremas que cualquier guía fija.
export const DISCRETIONARY_OVERLAY: Record<string, RegimeTacticalWeights> = {
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
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.55,
    kellyCapOverride: 0.25,
    blendToTacticalRatio: 0.70,     // 70% cuant / 30% overlay (FIX-R2-C10: antes 0.30)
    description: 'Overlay EXPANSION: WLG 22% núcleo, BTC 25%, VVSM 18% tilt AI',
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
    maxSingleAsset: 0.30,
    maxTechCryptoCluster: 0.40,
    kellyCapOverride: 0.18,
    blendToTacticalRatio: 0.80,     // 80% cuant / 20% overlay (FIX-R2-C10: antes 0.50)
    description: 'Overlay CONTRACTION: WLG 28% núcleo, gold 18%, BTC+VVSM 30%',
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
    maxSingleAsset: 0.35,
    maxTechCryptoCluster: 0.10,
    kellyCapOverride: 0.08,
    blendToTacticalRatio: 1.00,     // 100% cuant / 0% overlay (FIX-R2-C10: antes 0.70)
    description: 'Overlay CRISIS: desactivado — 100% motor cuantitativo (BL+HRP+MinVar)',
  },
};

// ── FUNCIÓN DE INTEGRACIÓN CON OLYMPUS V3 ────────────────────────────────────
// Uso en olympusV3.ts, después de computar blendNorm:
//
//   const tacticalWeights = getTacticalWeights(masterRegime.regime, assets);
//   const blendWithTactical = applyTacticalConstraints(blendNorm, tacticalWeights, assets);
//
// Esto reemplaza la penalización uniforme (×0.616) por un cambio real de composición.

// ── VVSM GATE (Semiconductores) ──────────────────────────────────────────────
// FIX-VVSM-GATE (22-Jun-2026): los pesos tácticos de VVSM se modulan por
// su retorno de 12 meses como proxy de sobrecalentamiento del sector.
// Los semis son notoriamente cíclicos: +60% en 12m suele preceder correcciones.
//
// returns12m < 20%: normal       → 100% del peso táctico
// returns12m 20-40%: caliente    → 80% del peso táctico
// returns12m 40-60%: muy caliente → 50% del peso táctico
// returns12m > 60%: burbuja semis → 25% del peso táctico (tracking position)
//
// El exceso se redistribuye íntegramente a WLG (núcleo developed equity).
// Esto es complementario al cluster cap (BTC+VVSM) y al ERP trigger.
function applyVVSMGate(
  weights: Partial<Record<AssetTicker, number>>,
  vvsmReturns12m?: number
): Partial<Record<AssetTicker, number>> {
  if (vvsmReturns12m === undefined) return weights;
  const vvsmWeight = weights['VVSM.DE'];
  if (!vvsmWeight || vvsmWeight <= 0) return weights;

  let scaleFactor: number;
  if (vvsmReturns12m < 0.20)       scaleFactor = 1.0;   // normal
  else if (vvsmReturns12m < 0.40)  scaleFactor = 0.80;  // caliente
  else if (vvsmReturns12m < 0.60)  scaleFactor = 0.50;  // muy caliente
  else                              scaleFactor = 0.25;  // burbuja semis

  const newVvsmWeight = vvsmWeight * scaleFactor;
  const excess = vvsmWeight - newVvsmWeight;
  if (excess <= 0) return weights;

  // Redistribuir exceso a WLG (núcleo equity, 100%)
  const result = { ...weights };
  result['VVSM.DE'] = newVvsmWeight;
  result['0P00000WLG.F'] = (result['0P00000WLG.F'] ?? 0) + excess;
  return result;
}

// ── BTC ON-CHAIN GATE ─────────────────────────────────────────────────────────
// FIX-BTC-GATE (22-Jun-2026): los pesos tácticos de BTC se modulan por MVRV.
// El régimen define la INTENCIÓN (25% EXPANSION, 15% CONTRACTION, 3% CRISIS),
// pero las métricas on-chain deciden si BTC MERECE ese peso en este momento.
//
// MVRV < 2.0: infravalorado → 100% del peso táctico (oportunidad de compra)
// MVRV 2.0-3.0: fair value  → 80% del peso táctico
// MVRV 3.0-4.0: sobrevalorado → 50% del peso táctico
// MVRV > 4.0: burbuja       → 20% del peso táctico (solo tracking position)
//
// El exceso de peso se redistribuye proporcionalmente a PPFB (oro) y WLG (núcleo).
// Esto es independiente del dynamicBtcCap en olympusV3.ts (que es un hard cap
// sobre el peso final, no sobre la guía táctica).
function applyBTCOnChainGate(
  weights: Partial<Record<AssetTicker, number>>,
  btcMVRV?: number
): Partial<Record<AssetTicker, number>> {
  if (btcMVRV === undefined || btcMVRV <= 0) return weights;
  const btcWeight = weights['BTC-EUR'];
  if (!btcWeight || btcWeight <= 0) return weights;

  // Factor de escala según MVRV
  let scaleFactor: number;
  if (btcMVRV < 2.0)       scaleFactor = 1.0;   // infravalorado — sin reducción
  else if (btcMVRV < 3.0)  scaleFactor = 0.80;  // fair value — leve reducción
  else if (btcMVRV < 4.0)  scaleFactor = 0.50;  // sobrevalorado — reducción media
  else                      scaleFactor = 0.20;  // burbuja — tracking position

  const newBtcWeight = btcWeight * scaleFactor;
  const excess = btcWeight - newBtcWeight;
  if (excess <= 0) return weights;

  // Redistribuir exceso a PPFB (oro, 60%) y WLG (núcleo, 40%)
  const result = { ...weights };
  result['BTC-EUR'] = newBtcWeight;
  result['PPFB.DE'] = (result['PPFB.DE'] ?? 0) + excess * 0.60;
  result['0P00000WLG.F'] = (result['0P00000WLG.F'] ?? 0) + excess * 0.40;
  return result;
}

export function getTacticalWeights(
  regime: string,
  assets: { name: string; ticker?: string }[],
  btcMVRV?: number,         // FIX-BTC-GATE: opcional, para filtrar por on-chain
  vvsmReturns12m?: number   // FIX-VVSM-GATE: opcional, retorno 12m de semis
): number[] {
  const tacticalConfig = DISCRETIONARY_OVERLAY[regime]
    ?? DISCRETIONARY_OVERLAY['EXPANSION'];

  // Aplicar gates: BTC on-chain + VVSM momentum exhaustion
  // (ambas manejan internamente el caso undefined → no-op)
  const w = applyVVSMGate(
    applyBTCOnChainGate(tacticalConfig.weights, btcMVRV),
    vvsmReturns12m
  );

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
  const tacticalConfig = DISCRETIONARY_OVERLAY[regime]
    ?? DISCRETIONARY_OVERLAY['EXPANSION'];

  // FIX-R2-C10: blendToTacticalRatio ahora es blendQuantWeight — fracción
  // del peso final que viene del motor cuantitativo (BL+HRP+MinVar).
  // 1 - blendQuantWeight = fracción del overlay discrecional.
  // EXPANSION: 0.70 → 70% cuant / 30% overlay
  // CONTRACTION: 0.80 → 80% cuant / 20% overlay
  // CRISIS: 1.00 → 100% cuant / 0% overlay (sin overlay en crisis)
  const effectiveBlendRatio = blendToTacticalRatio
    ?? (DISCRETIONARY_OVERLAY[regime]?.blendToTacticalRatio ?? 0.70);

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
  const config = DISCRETIONARY_OVERLAY[regime]
    ?? DISCRETIONARY_OVERLAY['EXPANSION'];
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