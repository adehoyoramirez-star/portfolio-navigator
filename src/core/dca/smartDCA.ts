// ===============================================
// ARCHIVO: src/core/dca/smartDCA.ts
// HENDENFUND — SmartDCA con separación Olympus/Táctico
// ===============================================
// REGLAS:
//   - Olympus recibe el 80% de la liquidez defensiva + aportación mensual
//   - Táctico recibe el 20% de la liquidez defensiva
//   - El Táctico solo invierte si attackConfluence ≥ 4 (umbral de ataque)
//   - El sobrante del Táctico se acumula como efectivo para el mes siguiente
//   - Olympus puede reclamar hasta el 75% del capital táctico si confluence ≥ 6
//   - El panel de liquidez mostrará el desglose actualizado

import type { CEWSOutput, CEWSLevel } from "../macro/crisisEarlyWarning";

export type DCAAction =
  | "BLOCK_CRISIS" | "BLOCK_TAIL_RISK" | "BLOCK_VOL"
  | "WAIT" | "SMALL_BUY" | "BUY" | "FULL_BUY"
  | "ATTACK_ENTRY" | "ATTACK_STRONG" | "ATTACK_MAX"
  | "BTC_CYCLE_OVERRIDE";

export interface SmartDCAInput {
  btcRsi: number;
  btcZScore: number;
  btcMomentum1m: number;
  btcDominance?: number;
  mvrvRatio?: number;
  regime: string;
  regimePenalty: number;
  volTargetMultiplier: number;
  tailRiskActive: boolean;
  tailRiskOverlay: number;
  olympusAvailableCash: number;
  tacticalAvailableCash: number;
  accumulatedDefensiveLiquidity?: number;
  motorAllocations: { name: string; ticker: string; finalAllocation: number; price: number }[];
  cewsOutput?: CEWSOutput;
  cewsPreviousLevel?: CEWSLevel;
}

export interface DCAAllocation {
  ticker: string; name: string;
  cashToInvest: number; actualCost: number;
  motorWeight: number; shares: number;
  pricePerShare: number; isFractional: boolean;
  skipped: boolean; reason: string;
}

export interface AttackSignal {
  name: string; active: boolean; description: string;
}

export interface SmartDCAOutput {
  action: DCAAction;
  score: number;
  buyFraction: number;
  totalCashToInvest: number;
  allocationByAsset: DCAAllocation[];
  reasoning: string;
  blockReason?: string;
  attackMode: boolean;
  attackConfluence: number;
  attackSignals: AttackSignal[];
  attackMultiplier: number;
  attackTranche: 0 | 1 | 2 | 3;
  olympusInvested: number;
  tacticalInvested: number;
  tacticalAccumulated: number;
}

// ── SEÑALES DE CONFLUENCIA DE FONDO (sin cambios) ───────────────────────
function detectBottomConfluence(input: SmartDCAInput): AttackSignal[] {
  const { btcRsi, btcZScore, btcMomentum1m, cewsOutput, cewsPreviousLevel, regime, regimePenalty, btcDominance, mvrvRatio } = input;

  const btcOversold = btcRsi < 35 && btcZScore < -1.5;
  const cewsRecovering = cewsOutput !== undefined && cewsPreviousLevel !== undefined &&
    (cewsPreviousLevel === "ALERT" || cewsPreviousLevel === "WARNING") &&
    (cewsOutput.level === "WATCH" || cewsOutput.level === "CLEAR");
  const regimeImproving = regime === "CONTRACTION" && regimePenalty > 0.55;
  const momentumDivergence = btcMomentum1m < -0.10 && btcZScore > -2.5;
  const dominanceAccumulation = btcDominance !== undefined && btcDominance > 52;
  const mvrvUndervalued = mvrvRatio !== undefined && mvrvRatio < 1.5;
  const volNormalizing = cewsOutput !== undefined && cewsOutput.signals.volClustering.trend === "IMPROVING" && cewsOutput.signals.volClustering.level !== "ALERT";

  return [
    { name: "BTC Sobreventa Extrema", active: btcOversold, description: btcOversold ? `RSI ${btcRsi.toFixed(0)} + Z-Score ${btcZScore.toFixed(2)}` : `RSI ${btcRsi.toFixed(0)}, Z ${btcZScore.toFixed(2)}` },
    { name: "CEWS Recuperándose", active: cewsRecovering, description: cewsRecovering ? `CEWS mejoró de ${cewsPreviousLevel} → ${cewsOutput?.level}` : `CEWS en ${cewsOutput?.level ?? "sin datos"}` },
    { name: "Régimen Mejorando", active: regimeImproving, description: regimeImproving ? `CONTRACTION con penalty ${regimePenalty.toFixed(2)}` : `Régimen ${regime} (${regimePenalty.toFixed(2)})` },
    { name: "Divergencia de Momentum", active: momentumDivergence, description: momentumDivergence ? `Caída ${(btcMomentum1m*100).toFixed(1)}% con Z ${btcZScore.toFixed(2)}` : `Momentum ${(btcMomentum1m*100).toFixed(1)}%` },
    { name: "VIX Normalizándose", active: volNormalizing, description: volNormalizing ? `Volatility clustering mejorando` : `Vol clustering sin normalización` },
    { name: "BTC Dominance Acumulación", active: dominanceAccumulation, description: btcDominance !== undefined ? (dominanceAccumulation ? `BTC.D ${btcDominance.toFixed(1)}% — acumulación` : `BTC.D ${btcDominance.toFixed(1)}%`) : "Sin dato" },
    { name: "MVRV Zona de Valor", active: mvrvUndervalued, description: mvrvRatio !== undefined ? (mvrvUndervalued ? (mvrvRatio < 1.0 ? `MVRV ${mvrvRatio.toFixed(2)} — fondo histórico` : `MVRV ${mvrvRatio.toFixed(2)} — acumulación`) : (mvrvRatio > 3.5 ? `MVRV ${mvrvRatio.toFixed(2)} — burbuja` : `MVRV ${mvrvRatio.toFixed(2)} — neutral`)) : "Sin dato" },
  ];
}

// ── BUILD ALLOCATIONS (sin cambios) ─────────────────────────────────────
function buildAllocations(totalCash: number, assets: { ticker: string; name: string; finalAllocation: number; price: number }[], trancheLabel: string): DCAAllocation[] {
  const eligible = assets.filter(a => a.finalAllocation > 0.02 && a.price > 0);
  if (eligible.length === 0 || totalCash <= 0) return [];
  const totalWeight = eligible.reduce((s, a) => s + a.finalAllocation, 0);
  const pass1 = eligible.map(a => {
    const cashAssigned = (a.finalAllocation / totalWeight) * totalCash;
    const isFractional = a.ticker === "BTC-EUR";
    const shares = isFractional ? cashAssigned / a.price : Math.floor(cashAssigned / a.price);
    const actualCost = shares * a.price;
    const skipped = !isFractional && shares === 0;
    return { ...a, cashAssigned, shares, actualCost, isFractional, skipped };
  });
  const stranded = pass1.filter(a => a.skipped).reduce((s, a) => s + a.cashAssigned, 0);
  const canBuy = pass1.filter(a => !a.skipped);
  const canBuyWeight = canBuy.reduce((s, a) => s + a.finalAllocation, 0);
  return pass1.map(a => {
    if (a.skipped) return { ticker: a.ticker, name: a.name, cashToInvest: a.cashAssigned, actualCost: 0, motorWeight: a.finalAllocation, shares: 0, pricePerShare: a.price, isFractional: false, skipped: true, reason: `Necesita €${a.price.toFixed(0)} mín.` };
    let extra = 0;
    if (stranded > 0 && canBuyWeight > 0) extra = (a.finalAllocation / canBuyWeight) * stranded;
    const total = a.cashAssigned + extra;
    const shares = a.isFractional ? total / a.price : Math.floor(total / a.price);
    return { ticker: a.ticker, name: a.name, cashToInvest: total, actualCost: shares * a.price, motorWeight: a.finalAllocation, shares, pricePerShare: a.price, isFractional: a.isFractional, skipped: false, reason: `${trancheLabel} ${(a.finalAllocation*100).toFixed(1)}%` };
  });
}

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────
export function computeSmartDCA(input: SmartDCAInput): SmartDCAOutput {
  const { regime, regimePenalty, volTargetMultiplier, tailRiskActive, tailRiskOverlay, olympusAvailableCash, tacticalAvailableCash, motorAllocations } = input;
  const defensiveLiquidity = input.accumulatedDefensiveLiquidity ?? 0;
  const ATTACK_THRESHOLD = 4;

  const attackSignals = detectBottomConfluence(input);
  const attackConfluence = attackSignals.filter(s => s.active).length;

  // ── BTC CYCLE OVERRIDE (≥4/7 en CRISIS) ────────────────────────────
  if (attackConfluence >= 4 && !tailRiskActive && regime === "CRISIS") {
    const btcOnly = motorAllocations.filter(a => a.ticker === "BTC-EUR");
    const btcCash = olympusAvailableCash * 0.25;
    const allocs = buildAllocations(btcCash, btcOnly, "OVERRIDE:");
    const cost = allocs.reduce((s, a) => s + a.actualCost, 0);
    return { action: "BTC_CYCLE_OVERRIDE", score: attackConfluence, buyFraction: olympusAvailableCash > 0 ? cost / olympusAvailableCash : 0.25, totalCashToInvest: cost, allocationByAsset: allocs, reasoning: `⚡ BTC OVERRIDE — ${attackConfluence}/7 señales. €${cost.toFixed(0)}.`, attackMode: true, attackConfluence, attackSignals, attackMultiplier: 1, attackTranche: 1, olympusInvested: cost, tacticalInvested: 0, tacticalAccumulated: tacticalAvailableCash };
  }

  // ── BLOQUEOS ─────────────────────────────────────────────────────────
  if (tailRiskActive && tailRiskOverlay < 0.7) return emptyOutput("BLOCK_TAIL_RISK", "Tail Risk activo.", attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);
  if (regime === "CRISIS" || regimePenalty <= 0.45) return emptyOutput("BLOCK_CRISIS", `CRISIS (×${regimePenalty.toFixed(2)}).`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);
  if (volTargetMultiplier < 0.60) return emptyOutput("BLOCK_VOL", `Vol Target ×${volTargetMultiplier.toFixed(2)}.`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);

  // ── MODO ATAQUE ─────────────────────────────────────────────────────
  const canAttack = attackConfluence >= ATTACK_THRESHOLD;
  let olympusInvested = 0, tacticalInvested = 0, tacticalAccumulated = tacticalAvailableCash;

  if (canAttack) {
    tacticalInvested = tacticalAvailableCash;
    tacticalAccumulated = 0;
    olympusInvested = olympusAvailableCash * 0.60;
  } else {
    olympusInvested = olympusAvailableCash * 0.30;
    tacticalAccumulated = tacticalAvailableCash;
  }

  const totalCash = olympusInvested + tacticalInvested;
  const allocs = totalCash > 0 ? buildAllocations(totalCash, motorAllocations, canAttack ? "ATAQUE:" : "DCA:") : [];
  const action: DCAAction = canAttack ? (attackConfluence >= 6 ? "ATTACK_MAX" : attackConfluence >= 5 ? "ATTACK_STRONG" : "ATTACK_ENTRY") : "BUY";
  const reasoning = canAttack
    ? `🚀 ATAQUE — ${attackConfluence}/7 señales. Olympus €${olympusInvested.toFixed(0)} + Táctico €${tacticalInvested.toFixed(0)}.`
    : `DCA normal Olympus €${olympusInvested.toFixed(0)}. Táctico acumula €${tacticalAccumulated.toFixed(0)}.`;

  return { action, score: attackConfluence, buyFraction: olympusAvailableCash > 0 ? olympusInvested / olympusAvailableCash : 0, totalCashToInvest: totalCash, allocationByAsset: allocs, reasoning, attackMode: canAttack, attackConfluence, attackSignals, attackMultiplier: canAttack ? 1.5 : 1, attackTranche: canAttack ? (attackConfluence >= 6 ? 3 : attackConfluence >= 5 ? 2 : 1) : 0, olympusInvested, tacticalInvested, tacticalAccumulated };
}

function emptyOutput(action: DCAAction, reason: string, signals: AttackSignal[], confluence: number, olympusCash: number, tacticalCash: number): SmartDCAOutput {
  return { action, score: 0, buyFraction: 0, totalCashToInvest: 0, allocationByAsset: [], reasoning: reason, blockReason: reason, attackMode: false, attackConfluence: confluence, attackSignals: signals, attackMultiplier: 1, attackTranche: 0, olympusInvested: 0, tacticalInvested: 0, tacticalAccumulated: tacticalCash };
}