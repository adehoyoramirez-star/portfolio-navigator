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

export interface CurrentAllocation {
  ticker: string;
  name: string;
  currentWeight: number;
}

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
  /** Pesos actuales del portfolio para calcular drift (target - actual).
   *  Si se proporciona, buildAllocations solo comprará activos con drift POSITIVO
   *  (infraponderados), prorrateando el cash según el drift en vez del target absoluto. */
  currentAllocations?: CurrentAllocation[];
  cewsOutput?: CEWSOutput;
  cewsPreviousLevel?: CEWSLevel;
  /** Señales de techo de ciclo por activo. Si un activo tiene shouldTrim=true,
   *  SmartDCA no comprará más de ese activo (redistribuye el cash a los demás). */
  cycleTopSignals?: { ticker: string; shouldTrim: boolean; zone: string }[];
}

export interface DCAAllocation {
  ticker: string; name: string;
  cashToInvest: number; actualCost: number;
  motorWeight: number; shares: number;
  pricePerShare: number; isFractional: boolean;
  skipped: boolean; reason: string;
  /** Gap entre peso objetivo y peso actual (positivo = infraponderado). */
  drift?: number;
  currentWeight?: number;
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
  const regimeImproving = (regime === "EXPANSION" && regimePenalty >= 0.80) ||
    (regime === "CONTRACTION" && regimePenalty > 0.55);
  const momentumDivergence = btcMomentum1m < -0.10 && btcZScore > -2.5;
  const dominanceAccumulation = btcDominance !== undefined && btcDominance > 52;
  const mvrvUndervalued = mvrvRatio !== undefined && mvrvRatio < 1.5;
  const volNormalizing = cewsOutput !== undefined && cewsOutput.signals.volClustering.trend === "IMPROVING" && cewsOutput.signals.volClustering.level !== "ALERT";

  return [
    { name: "BTC Sobreventa Extrema", active: btcOversold, description: btcOversold ? `RSI ${btcRsi.toFixed(0)} + Z-Score ${btcZScore.toFixed(2)}` : `RSI ${btcRsi.toFixed(0)}, Z ${btcZScore.toFixed(2)}` },
    { name: "CEWS Recuperándose", active: cewsRecovering, description: cewsRecovering ? `CEWS mejoró de ${cewsPreviousLevel} → ${cewsOutput?.level}` : `CEWS en ${cewsOutput?.level ?? "sin datos"}` },
    { name: "Régimen Mejorando", active: regimeImproving, description: regimeImproving ? `Régimen ${regime} (×${regimePenalty.toFixed(2)}) — mejora confirmada` : `Régimen ${regime} (×${regimePenalty.toFixed(2)})` },
    { name: "Divergencia de Momentum", active: momentumDivergence, description: momentumDivergence ? `Caída ${(btcMomentum1m*100).toFixed(1)}% con Z ${btcZScore.toFixed(2)}` : `Momentum ${(btcMomentum1m*100).toFixed(1)}%` },
    { name: "VIX Normalizándose", active: volNormalizing, description: volNormalizing ? `Volatility clustering mejorando` : `Vol clustering sin normalización` },
    { name: "BTC Dominance Acumulación", active: dominanceAccumulation, description: btcDominance !== undefined ? (dominanceAccumulation ? `BTC.D ${btcDominance.toFixed(1)}% — acumulación` : `BTC.D ${btcDominance.toFixed(1)}%`) : "Sin dato" },
    { name: "MVRV Zona de Valor", active: mvrvUndervalued, description: mvrvRatio !== undefined ? (mvrvUndervalued ? (mvrvRatio < 1.0 ? `MVRV ${mvrvRatio.toFixed(2)} — fondo histórico` : `MVRV ${mvrvRatio.toFixed(2)} — acumulación`) : (mvrvRatio > 3.5 ? `MVRV ${mvrvRatio.toFixed(2)} — burbuja` : `MVRV ${mvrvRatio.toFixed(2)} — neutral`)) : "Sin dato" },
  ];
}

// ── BUILD ALLOCATIONS (drift-aware) ──────────────────────────────────────
// Distribuye el cash entre activos infraponderados (drift positivo),
// prorrateando por el drift en vez del peso objetivo.
// Si un activo está sobreponderado (drift negativo), NO recibe cash.
function buildAllocations(
  totalCash: number,
  assets: { ticker: string; name: string; finalAllocation: number; price: number }[],
  trancheLabel: string,
  skipTickers: Set<string> = new Set(),
  currentAllocations: Map<string, number> = new Map()
): DCAAllocation[] {
  // FIX-AUDIT-DEDUP: eliminar tickers duplicados antes de procesar.
  // Si el motor recibe assets duplicados (ej: VVSM.DE aparece 2 veces en el portfolio),
  // solo se procesa la primera ocurrencia. Esto previene que un mismo activo aparezca
  // 2 veces en las propuestas de compra del DCA.
  const seenTickers = new Set<string>();
  const deduped = assets.filter(a => {
    const base = a.ticker.split('.')[0];
    if (seenTickers.has(base)) return false;
    seenTickers.add(base);
    return true;
  });

  // 1. Calcular drift para cada activo
  const withDrift = deduped.map(a => {
    const currentWeight = currentAllocations.get(a.ticker) ?? 0;
    const drift = a.finalAllocation - currentWeight;
    return { ...a, drift, currentWeight };
  });

  // 2. Filtrar: solo activos con target > 2%, precio > 0, sin techo de ciclo, y drift POSITIVO
  const eligible = withDrift.filter(a =>
    a.finalAllocation > 0.02 &&
    a.price > 0 &&
    !skipTickers.has(a.ticker) &&
    a.drift > 0.005 // al menos 0.5pp de infraponderación
  );

  if (eligible.length === 0) return [];
  if (totalCash <= 0) return [];

  // 3. Prorratear cash por drift, no por target absoluto
  const totalDrift = eligible.reduce((s, a) => s + a.drift, 0);
  const pass1 = eligible.map(a => {
    const cashAssigned = (a.drift / totalDrift) * totalCash;
    const isFractional = a.ticker === "BTC-EUR";
    const shares = isFractional ? cashAssigned / a.price : Math.floor(cashAssigned / a.price);
    const actualCost = shares * a.price;
    const skipped = !isFractional && shares === 0;
    return { ...a, cashAssigned, shares, actualCost, isFractional, skipped };
  });

  // 4. Redistribuir cash sobrante de activos que no alcanzan 1 acción
  const stranded = pass1.filter(a => a.skipped).reduce((s, a) => s + a.cashAssigned, 0);
  const canBuy = pass1.filter(a => !a.skipped);
  const canBuyDrift = canBuy.reduce((s, a) => s + a.drift, 0);

  // 5. Construir resultado final con drift en la descripción
  return pass1.map(a => {
    if (a.skipped) {
      return {
        ticker: a.ticker, name: a.name,
        cashToInvest: a.cashAssigned, actualCost: 0,
        motorWeight: a.finalAllocation, shares: 0,
        pricePerShare: a.price, isFractional: false,
        skipped: true, reason: `Necesita €${a.price.toFixed(0)} mín.`,
        drift: a.drift, currentWeight: a.currentWeight,
      };
    }
    let extra = 0;
    if (stranded > 0 && canBuyDrift > 0) extra = (a.drift / canBuyDrift) * stranded;
    const total = a.cashAssigned + extra;
    const shares = a.isFractional ? total / a.price : Math.floor(total / a.price);
    return {
      ticker: a.ticker, name: a.name,
      cashToInvest: total, actualCost: shares * a.price,
      motorWeight: a.finalAllocation, shares,
      pricePerShare: a.price, isFractional: a.isFractional,
      skipped: false,
      reason: `${trancheLabel} ${(a.finalAllocation*100).toFixed(1)}% (drift ${(a.drift*100).toFixed(1)}pp)`,
      drift: a.drift, currentWeight: a.currentWeight,
    };
  });
}

// ── FUNCIÓN PRINCIPAL ──────────────────────────────────────────────────
export function computeSmartDCA(input: SmartDCAInput): SmartDCAOutput {
  const { regime, regimePenalty, volTargetMultiplier, tailRiskActive, tailRiskOverlay, olympusAvailableCash, tacticalAvailableCash, motorAllocations } = input;
  const defensiveLiquidity = input.accumulatedDefensiveLiquidity ?? 0;
  const ATTACK_THRESHOLD = 4;

  // Extraer tickers con señal de techo de ciclo activa (CAUTION/DANGER/EXTREME)
  // Estos activos NO se comprarán — el cash se redistribuye a los demás
  const cycleTopTickers = new Set<string>(
    (input.cycleTopSignals ?? [])
      .filter(s => s.shouldTrim && s.zone !== "SAFE")
      .map(s => s.ticker)
  );

  const attackSignals = detectBottomConfluence(input);
  const attackConfluence = attackSignals.filter(s => s.active).length;

  // Separar señales macro vs BTC/on-chain.
  // Macro (CEWS, Régimen, VIX) → señales de cartera completa.
  // BTC/on-chain (BTC oversold, momentum, BTC.D, MVRV) → solo justifican comprar BTC.
  // Regla: si no hay ≥2 señales macro, el ataque es solo a BTC-EUR.
  const macroSignalNames = new Set(["CEWS Recuperándose", "Régimen Mejorando", "VIX Normalizándose"]);
  const macroConfluence = attackSignals.filter(s => macroSignalNames.has(s.name) && s.active).length;

  // ── BTC CYCLE OVERRIDE (≥4/7 en CRISIS) ────────────────────────────
  if (attackConfluence >= 4 && !tailRiskActive && regime === "CRISIS") {
    const btcOnly = motorAllocations.filter(a => a.ticker === "BTC-EUR");
    const btcCash = olympusAvailableCash * 0.25;
    const allocs = buildAllocations(btcCash, btcOnly, "OVERRIDE:");
    const cost = allocs.reduce((s, a) => s + a.actualCost, 0);
    return { action: "BTC_CYCLE_OVERRIDE", score: attackConfluence, buyFraction: olympusAvailableCash > 0 ? cost / olympusAvailableCash : 0.25, totalCashToInvest: cost, allocationByAsset: allocs, reasoning: `⚡ BTC OVERRIDE — ${attackConfluence}/7 señales. €${cost.toFixed(0)}.`, attackMode: true, attackConfluence, attackSignals, attackMultiplier: 1, attackTranche: 1, olympusInvested: cost, tacticalInvested: 0, tacticalAccumulated: tacticalAvailableCash };
  }

  // ── BLOQUEOS ─────────────────────────────────────────────────────────
  // [FIX-KILLSWITCH] Umbral subido de 0.70 a 0.85 para que Kill Switch L1
  // (×0.80, DD -10.5%) también bloquee compras. Antes solo L2+ bloqueaba.
  if (tailRiskActive && tailRiskOverlay < 0.85) return emptyOutput("BLOCK_TAIL_RISK", `Tail Risk activo (×${tailRiskOverlay.toFixed(2)}). Kill Switch — no comprar.`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);
  if (regime === "CRISIS" || regimePenalty <= 0.45) return emptyOutput("BLOCK_CRISIS", `CRISIS (×${regimePenalty.toFixed(2)}).`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);
  if (volTargetMultiplier < 0.60) return emptyOutput("BLOCK_VOL", `Vol Target ×${volTargetMultiplier.toFixed(2)}.`, attackSignals, attackConfluence, olympusAvailableCash, tacticalAvailableCash);

  // ── MODO ATAQUE ─────────────────────────────────────────────────────
  const canAttack = attackConfluence >= ATTACK_THRESHOLD;
  // Si el ataque tiene <2 señales macro, solo comprar BTC-EUR (el resto del cash se acumula)
  const btcOnlyAttack = canAttack && macroConfluence < 2;
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
  // cycleTopTickers: activos en zona de techo de ciclo no se compran
  // btcOnlyAttack: solo BTC-EUR se compra, el resto del cash se acumula
  const allocAssets = btcOnlyAttack
    ? motorAllocations.filter(a => a.ticker === "BTC-EUR")
    : motorAllocations;
  // En modo DCA normal: usar drift-aware (solo comprar infraponderados).
  // En modo ATAQUE: también drift-aware — solo comprar infraponderados.
  // [FIX-ATTACK-DRIFT] Antes el modo ataque pasaba mapa vacío ignorando
  // posiciones reales, comprando activos ya sobreponderados (ej: IS3Q al 38%
  // con target 10.5% recibía €1,591). Ahora siempre se respetan las posiciones
  // actuales. El ataque despliega más cash pero solo en activos con drift > 0.
  const currentAllocMap = new Map<string, number>(
    (input.currentAllocations ?? []).map(ca => [ca.ticker, ca.currentWeight])
  );
  const allocs = totalCash > 0
    ? buildAllocations(totalCash, allocAssets, canAttack ? "ATAQUE:" : "DCA:", cycleTopTickers, currentAllocMap)
    : [];
  const action: DCAAction = canAttack ? (attackConfluence >= 6 ? "ATTACK_MAX" : attackConfluence >= 5 ? "ATTACK_STRONG" : "ATTACK_ENTRY") : "BUY";
  const reasoning = canAttack
    ? btcOnlyAttack
      ? `🔷 ATAQUE BTC-ONLY — ${attackConfluence}/7 señales (${macroConfluence} macro). Olympus €${olympusInvested.toFixed(0)} solo BTC.`
      : `🚀 ATAQUE — ${attackConfluence}/7 señales (${macroConfluence} macro). Olympus €${olympusInvested.toFixed(0)} + Táctico €${tacticalInvested.toFixed(0)}.`
    : `DCA normal Olympus €${olympusInvested.toFixed(0)}. Táctico acumula €${tacticalAccumulated.toFixed(0)}.`;

  return { action, score: attackConfluence, buyFraction: olympusAvailableCash > 0 ? olympusInvested / olympusAvailableCash : 0, totalCashToInvest: totalCash, allocationByAsset: allocs, reasoning, attackMode: canAttack, attackConfluence, attackSignals, attackMultiplier: canAttack ? 1.5 : 1, attackTranche: canAttack ? (attackConfluence >= 6 ? 3 : attackConfluence >= 5 ? 2 : 1) : 0, olympusInvested, tacticalInvested, tacticalAccumulated };
}

function emptyOutput(action: DCAAction, reason: string, signals: AttackSignal[], confluence: number, olympusCash: number, tacticalCash: number): SmartDCAOutput {
  return { action, score: 0, buyFraction: 0, totalCashToInvest: 0, allocationByAsset: [], reasoning: reason, blockReason: reason, attackMode: false, attackConfluence: confluence, attackSignals: signals, attackMultiplier: 1, attackTranche: 0, olympusInvested: 0, tacticalInvested: 0, tacticalAccumulated: tacticalCash };
}