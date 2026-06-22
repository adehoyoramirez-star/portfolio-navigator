// ===============================================
// ARCHIVO: src/core/risk/tailRisk.ts
// FIX-SCALE-01: Kill Switch calibrado para portfolio <€20k
// ===============================================
// CAMBIO PRINCIPAL:
//   Umbrales de drawdown ajustados para portfolios pequeños.
//   Ver engineConfig.ts → TAIL_RISK_CONFIG.KILL_SWITCH para justificación.
//
//   ANTES:  L1=-5%  L2=-10% L3=-15% L4=-20% L5=-25%
//   AHORA:  L1=-12% L2=-15% L3=-20% L4=-25% L5=-32% (FIX-L1-BTC, 22-Jun-2026)
//
//   PORCENTAJES DE REDUCCIÓN sin cambios (son matemáticamente correctos).
//
// FIX-VOL-REDUCTION:
//   El bloque de volatility reduction tenía un bug:
//   } else if (portfolioVol > 0.25) {  ← duplicado (nunca ejecutaba el tercer branch)
//     volatilityReduction = 0.20;
//   Corregido: el tercer branch ahora comprueba portfolioVol > 0.22.
//
// FIX-IMPORT-PATH:
//   tailRisk.ts está en src/core/risk/
//   engineConfig.ts está en src/core/config/
//   → subir UN nivel (risk → core) + entrar en config = ../config/
//   ANTES (INCORRECTO): "../../config/engineConfig.ts"  (subía a src/)
//   AHORA (CORRECTO):   "../config/engineConfig.ts"     (llega a src/core/config/)
// ===============================================

import { TAIL_RISK_CONFIG } from "../config/engineConfig";

export interface TailRiskInput {
  drawdown: number;
  vix: number;
  creditSpread: number;
  stressScore: number;
  portfolioVolatility?: number;
  avgCorrelation?: number;
}

export interface TailRiskOutput {
  overlay: number;
  isActive: boolean;
  triggerReason: string;
  killSwitchLevel: 0 | 1 | 2 | 3 | 4 | 5;
  killSwitchName: string;
  exposureReduction: number;
  drawdownOverlay: number;
  volatilityReduction: number;
  correlationPenalty: number;
  maxBtcWeightActive: boolean;
}

// ── KILL SWITCH GRANULAR — FIX-SCALE-01 ──────────────────────────────────
function computeKillSwitch(drawdown: number): {
  level: 0 | 1 | 2 | 3 | 4 | 5;
  name: string;
  overlay: number;
  exposureReduction: number;
} {
  const dd = Math.abs(drawdown);
  const ks = TAIL_RISK_CONFIG.KILL_SWITCH;

  if (dd >= ks.L5.threshold) {
    return { level: 5, name: ks.L5.name, overlay: ks.L5.overlay, exposureReduction: ks.L5.reduction };
  }
  if (dd >= ks.L4.threshold) {
    return { level: 4, name: ks.L4.name, overlay: ks.L4.overlay, exposureReduction: ks.L4.reduction };
  }
  if (dd >= ks.L3.threshold) {
    return { level: 3, name: ks.L3.name, overlay: ks.L3.overlay, exposureReduction: ks.L3.reduction };
  }
  if (dd >= ks.L2.threshold) {
    return { level: 2, name: ks.L2.name, overlay: ks.L2.overlay, exposureReduction: ks.L2.reduction };
  }
  if (dd >= ks.L1.threshold) {
    return { level: 1, name: ks.L1.name, overlay: ks.L1.overlay, exposureReduction: ks.L1.reduction };
  }
  return { level: 0, name: "SIN TRIGGER", overlay: 1.0, exposureReduction: 0 };
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────
export function computeTailRiskOverlay(input: TailRiskInput): TailRiskOutput {
  const { drawdown, vix, creditSpread, stressScore } = input;
  const portfolioVol = input.portfolioVolatility ?? 0;
  const avgCorr = input.avgCorrelation ?? 0;

  // ── 1. DRAWDOWN KILL SWITCH ────────────────────────────────────────────
  const killSwitch = computeKillSwitch(drawdown);

  // ── 2. VOLATILITY REDUCTION — FIX-VOL-REDUCTION ───────────────────────
  // BUG ORIGINAL: el tercer else-if repetía portfolioVol > 0.25 (nunca ejecutaba)
  // Corregido con tres bandas distintas.
  let volatilityReduction = 0;
  if (portfolioVol > 0.35) {
    volatilityReduction = 0.40;   // vol extrema: más del 35% anualizado
  } else if (portfolioVol > 0.28) {
    volatilityReduction = 0.25;   // vol alta: 28-35%
  } else if (portfolioVol > 0.22) {
    volatilityReduction = 0.10;   // vol moderada: 22-28% (FIX: era 0.20 con umbral erróneo)
  }
  // Por debajo del 22% no hay penalización por volatilidad

  // ── 3. CRISIS SISTÉMICA (VIX + Credit Spread simultáneos) ─────────────
  let systemicCrisisOverlay = 1.0;
  let systemicReason = '';
  if (vix > 40 && creditSpread > 5) {
    systemicCrisisOverlay = 0.35;
    systemicReason = `VIX ${vix.toFixed(0)} + Spread ${creditSpread.toFixed(1)}% — mercado disfuncional`;
  } else if (vix > 35 && creditSpread > 3.5) {
    systemicCrisisOverlay = 0.45;
    systemicReason = `VIX ${vix.toFixed(0)} + Spread ${creditSpread.toFixed(1)}% — stress sistémico`;
  } else if (vix > 30 && stressScore >= 7) {
    systemicCrisisOverlay = 0.60;
    systemicReason = `VIX ${vix.toFixed(0)} + Stress ${stressScore}/9 — presión elevada`;
  }

  // ── 4. PENALIZACIÓN POR CORRELACIÓN → 1 ───────────────────────────────
  let correlationPenalty = 0;
  if (avgCorr > 0.85) {
    correlationPenalty = 0.20;
  } else if (avgCorr > 0.70) {
    correlationPenalty = 0.10;
  }

  // ── 5. OVERLAY FINAL ───────────────────────────────────────────────────
  const baseOverlay = Math.min(killSwitch.overlay, systemicCrisisOverlay);
  const afterVol  = baseOverlay * (1 - volatilityReduction);
  const afterCorr = afterVol * (1 - correlationPenalty);
  const finalOverlay = Math.max(TAIL_RISK_CONFIG.MIN_ALLOCATION, afterCorr);

  // ── TRIGGER REASON ─────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (killSwitch.level > 0) {
    reasons.push(`DD -${(Math.abs(drawdown) * 100).toFixed(1)}% → Kill Switch L${killSwitch.level} (${killSwitch.name})`);
  }
  if (systemicReason) reasons.push(systemicReason);
  if (volatilityReduction > 0) {
    reasons.push(`Vol ${(portfolioVol * 100).toFixed(1)}% → -${(volatilityReduction * 100).toFixed(0)}% exposición`);
  }
  if (correlationPenalty > 0) {
    reasons.push(`Correlación ${(avgCorr * 100).toFixed(0)}% → -${(correlationPenalty * 100).toFixed(0)}%`);
  }

  return {
    overlay: finalOverlay,
    isActive: finalOverlay < 0.99,
    triggerReason: reasons.join(' | ') || '',
    killSwitchLevel: killSwitch.level,
    killSwitchName: killSwitch.name,
    exposureReduction: 1 - finalOverlay,
    drawdownOverlay: killSwitch.overlay,
    volatilityReduction,
    correlationPenalty,
    maxBtcWeightActive: false,
  };
}
