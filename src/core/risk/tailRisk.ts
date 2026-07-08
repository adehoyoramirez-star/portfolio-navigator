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

import { TAIL_RISK_CONFIG, CEWS_CONFIG, CORRELATION_PANIC_CONFIG } from "../config/engineConfig";

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

  // FIX A2: banda intermedia L1.5 entre L1 y L2.
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
  // FIX A2: L1.5 antes de L1
  if ('L1_5' in ks && dd >= (ks as any).L1_5.threshold) {
    const l15 = (ks as any).L1_5;
    return { level: 2, name: l15.name, overlay: l15.overlay, exposureReduction: l15.reduction };
  }
  if (dd >= ks.L1.threshold) {
    return { level: 1, name: ks.L1.name, overlay: ks.L1.overlay, exposureReduction: ks.L1.reduction };
  }
  return { level: 0, name: "SIN TRIGGER", overlay: 1.0, exposureReduction: 0 };
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────
// FIX-AUDIT-R10: JSDoc de unidades documentado.
// Todas las volatilidades están en decimal anualizado (ej: 0.35 = 35% anual).
// drawdown es decimal negativo (ej: -0.15 = -15%).
// overlay es multiplicador [0.05, 1.0] que escala la exposición total.
// volatilityReduction es fracción [0, 1] de reducción sobre el overlay base.
export function computeTailRiskOverlay(input: TailRiskInput): TailRiskOutput {
  const { drawdown, vix, creditSpread, stressScore } = input;
  const portfolioVol = input.portfolioVolatility ?? 0;
  const avgCorr = input.avgCorrelation ?? 0;

  // ── 1. DRAWDOWN KILL SWITCH ────────────────────────────────────────────
  const killSwitch = computeKillSwitch(drawdown);

  // ── 2. VOLATILITY REDUCTION — FIX-CALIBRATION: desactivado (redundante con Vol Target) ──
  // El Vol Target (CAPA 7) ya gestiona la exposición basada en volatilidad.
  // Aplicar una segunda penalización aquí era doble-contar el mismo riesgo.
  // Se mantiene la estructura por si se quiere reactivar en el futuro.
  let volatilityReduction = 0;

  // ── 3. CRISIS SISTÉMICA (VIX + Credit Spread simultáneos) ─────────────
  // FIX-AUDIT-C6: thresholds centralizados en CEWS_CONFIG.SYSTEMIC_CRISIS.
  // Antes hardcodeados como vix>40/creditSpread>5, vix>35/creditSpread>3.5, etc.
  let systemicCrisisOverlay = 1.0;
  let systemicReason = '';
  const sc = CEWS_CONFIG.SYSTEMIC_CRISIS;
  if (vix > sc.DISFUNCTIONAL.vix && creditSpread > sc.DISFUNCTIONAL.creditSpread) {
    systemicCrisisOverlay = sc.DISFUNCTIONAL.overlay;
    systemicReason = `VIX ${vix.toFixed(0)} + Spread ${creditSpread.toFixed(1)}% — mercado disfuncional`;
  } else if (vix > sc.SYSTEMIC_STRESS.vix && creditSpread > sc.SYSTEMIC_STRESS.creditSpread) {
    systemicCrisisOverlay = sc.SYSTEMIC_STRESS.overlay;
    systemicReason = `VIX ${vix.toFixed(0)} + Spread ${creditSpread.toFixed(1)}% — stress sistémico`;
  } else if (vix > sc.ELEVATED.vix && stressScore >= sc.ELEVATED.stressScore) {
    systemicCrisisOverlay = sc.ELEVATED.overlay;
    systemicReason = `VIX ${vix.toFixed(0)} + Stress ${stressScore}/9 — presión elevada`;
  }

  // ── 4. PENALIZACIÓN POR CORRELACIÓN → 1 ───────────────────────────────
  // FIX-AUDIT-C6: thresholds centralizados en CORRELATION_PANIC_CONFIG.
  // Antes hardcodeados como avgCorr>0.85 y avgCorr>0.70.
  let correlationPenalty = 0;
  if (avgCorr > CORRELATION_PANIC_CONFIG.PANIC_THRESHOLD) {
    correlationPenalty = 0.20;
  } else if (avgCorr > CORRELATION_PANIC_CONFIG.DIVERSIFICATION_COLLAPSE) {
    correlationPenalty = CORRELATION_PANIC_CONFIG.DIVERSIFICATION_PENALTY;
  }

  // ── 5. OVERLAY FINAL ───────────────────────────────────────────────────
  // Unidades: overlay ∈ [MIN_ALLOCATION, 1.0]. Multiplica la exposición total.
  // Ej: overlay=0.50 → 50% invertido, 50% cash. No es reducción aditiva.
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
