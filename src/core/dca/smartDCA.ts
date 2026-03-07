// ===============================================
// ARCHIVO: src/core/dca/smartDCA.ts
// NIVEL 5 — SmartDCA con modo ATAQUE
// ===============================================
// DEFENSA (niveles anteriores):
//   - BLOCK en CRISIS, tail risk, vol alta
//   - Señales técnicas BTC para timing
//
// ATAQUE (Nivel 5):
//   - Detecta confluencia de fondo (5 señales)
//   - Sabe cuánta liquidez acumuló durante la defensa
//   - Entra en 3 tramos de forma escalonada
//   - Multiplica el DCA mensual hasta 4x en oportunidades de ciclo
//
// Jerarquía de decisión completa:
//   1. CEWS recuperándose desde ALERT + confluencia fondo → MODO ATAQUE
//   2. Tail risk activo → BLOCK
//   3. Régimen CRISIS → BLOCK
//   4. Vol muy alta → BLOCK
//   5. Señales técnicas BTC → tamaño normal
// ===============================================

import type { CEWSOutput, CEWSLevel } from "../macro/crisisEarlyWarning";

export type DCAAction =
  | "BLOCK_CRISIS"
  | "BLOCK_TAIL_RISK"
  | "BLOCK_VOL"
  | "WAIT"
  | "SMALL_BUY"
  | "BUY"
  | "FULL_BUY"
  | "ATTACK_ENTRY"    // fondo probable — entrar con 1.5x del DCA normal
  | "ATTACK_STRONG"   // fondo confirmándose — 2.5x + liquidez acumulada parcial
  | "ATTACK_MAX";     // señal máxima de ciclo — desplegar toda la liquidez acumulada

export interface SmartDCAInput {
  // Señales técnicas BTC
  btcRsi: number;
  btcZScore: number;
  btcMomentum1m: number;

  // Estado del motor (macro)
  regime: string;
  regimePenalty: number;
  volTargetMultiplier: number;
  tailRiskActive: boolean;
  tailRiskOverlay: number;

  // Capital
  availableCash: number;
  accumulatedDefensiveLiquidity?: number; // liquidez extra acumulada en fase defensiva

  // Allocations del motor
  motorAllocations: { name: string; ticker: string; finalAllocation: number; price: number }[];

  // CEWS — necesario para modo ataque
  cewsOutput?: CEWSOutput;
  cewsPreviousLevel?: CEWSLevel; // nivel de la semana anterior para detectar mejora
}

export interface DCAAllocation {
  ticker: string;
  name: string;
  cashToInvest: number;       // € asignados por el motor
  actualCost: number;         // € real a desembolsar (shares × price)
  motorWeight: number;        // peso según el motor [0,1]
  shares: number;             // participaciones a comprar (enteras salvo BTC)
  pricePerShare: number;      // precio actual del activo
  isFractional: boolean;      // true = BTC, permite fracciones
  skipped: boolean;           // true = cash insuficiente para 1 acción
  reason: string;
}

export interface AttackSignal {
  name: string;
  active: boolean;
  description: string;
}

export interface SmartDCAOutput {
  action: DCAAction;
  score: number;
  buyFraction: number;
  totalCashToInvest: number;
  allocationByAsset: DCAAllocation[];
  reasoning: string;
  blockReason?: string;
  // Modo ataque
  attackMode: boolean;
  attackConfluence: number;        // 0-5: cuántas señales de fondo activas
  attackSignals: AttackSignal[];   // detalle de cada señal
  attackMultiplier: number;        // 1x / 1.5x / 2.5x / 4x
  attackTranche: 0 | 1 | 2 | 3;  // 0=no ataque, 1-3=tramo
}

// ── SEÑALES DE CONFLUENCIA DE FONDO ───────────────────────────────────────
// Las 5 señales que juntas indican un fondo de ciclo real
function detectBottomConfluence(input: SmartDCAInput): AttackSignal[] {
  const { btcRsi, btcZScore, btcMomentum1m, cewsOutput, cewsPreviousLevel, regime, regimePenalty } = input;

  // 1. BTC sobreventa extrema (RSI < 35 Y Z-Score < -1.5)
  const btcOversold = btcRsi < 35 && btcZScore < -1.5;

  // 2. CEWS mejorando desde zona de alerta
  // El mercado estuvo muy mal (ALERT/WARNING) pero ahora está mejorando
  const cewsRecovering =
    cewsOutput !== undefined &&
    cewsPreviousLevel !== undefined &&
    (cewsPreviousLevel === "ALERT" || cewsPreviousLevel === "WARNING") &&
    (cewsOutput.level === "WATCH" || cewsOutput.level === "CLEAR");

  // 3. Régimen mejorando: CRISIS → CONTRACTION o CONTRACTION → EXPANSION
  // El motor empezó a relajar la penalización (> 0.55 tras estar bajo)
  const regimeImproving = regime === "CONTRACTION" && regimePenalty > 0.55;

  // 4. Momentum BTC tocando suelo: muy negativo (caída fuerte) pero el Z-score
  // deja de empeorar — divergencia positiva entre precio y momentum
  const momentumDivergence = btcMomentum1m < -0.10 && btcZScore > -2.5; // caída fuerte pero no destrucción

  // 5. CEWS: volatility clustering empezando a normalizarse
  // (VIX lleva semanas bajando desde pico de pánico)
  const volNormalizing =
    cewsOutput !== undefined &&
    cewsOutput.signals.volClustering.trend === "IMPROVING" &&
    cewsOutput.signals.volClustering.level !== "ALERT";

  return [
    {
      name: "BTC Sobreventa Extrema",
      active: btcOversold,
      description: btcOversold
        ? `RSI ${btcRsi.toFixed(0)} + Z-Score ${btcZScore.toFixed(2)} — precio muy por debajo de su media histórica`
        : `RSI ${btcRsi.toFixed(0)}, Z ${btcZScore.toFixed(2)} — sin sobreventa extrema`,
    },
    {
      name: "CEWS Recuperándose",
      active: cewsRecovering,
      description: cewsRecovering
        ? `Sistema macro mejoró de ${cewsPreviousLevel} → ${cewsOutput?.level} — el peor momento ha pasado`
        : `CEWS en ${cewsOutput?.level ?? "sin datos"} — sin señal de recuperación macro`,
    },
    {
      name: "Régimen Mejorando",
      active: regimeImproving,
      description: regimeImproving
        ? `Motor en CONTRACTION con penalty ${regimePenalty.toFixed(2)} — saliendo del modo defensivo`
        : `Régimen ${regime} (${regimePenalty.toFixed(2)}) — sin mejora suficiente`,
    },
    {
      name: "Divergencia de Momentum",
      active: momentumDivergence,
      description: momentumDivergence
        ? `Caída ${(btcMomentum1m * 100).toFixed(1)}% pero Z-Score ${btcZScore.toFixed(2)} — vendedores agotándose`
        : `Momentum ${(btcMomentum1m * 100).toFixed(1)}% — sin divergencia`,
    },
    {
      name: "VIX Normalizándose",
      active: volNormalizing,
      description: volNormalizing
        ? `Volatility clustering mejorando — el régimen de pánico se está disolviendo`
        : `Vol clustering en ${cewsOutput?.signals.volClustering.level ?? "sin datos"} — sin normalización`,
    },
  ];
}


// ── CORE: construir allocations respetando lotes mínimos ──────────────────
// BTC-EUR: fraccional → cualquier importe es válido
// ETFs (.DE): solo lotes enteros → mínimo = 1 participación al precio actual
//
// Lógica de redistribución:
//   1. Calcular shares = floor(cashToInvest / price) para cada ETF
//   2. Si shares === 0 → marcar como skipped, guardar el cash sobrante
//   3. Redistribuir el cash sobrante proporcionalmente entre activos con shares ≥ 1
//      para no desperdiciar capital
//   4. Recalcular con el cash redistribuido (máximo 1 iteración)
function buildAllocations(
  totalCash: number,
  assets: { ticker: string; name: string; finalAllocation: number; price: number }[],
  trancheLabel: string,
): DCAAllocation[] {
  const eligible = assets.filter(a => a.finalAllocation > 0.02 && a.price > 0);
  if (eligible.length === 0 || totalCash <= 0) return [];

  const totalWeight = eligible.reduce((s, a) => s + a.finalAllocation, 0);

  // Primera pasada: asignar cash proporcional y calcular shares
  const pass1 = eligible.map(a => {
    const cashAssigned = (a.finalAllocation / totalWeight) * totalCash;
    const isFractional = a.ticker === "BTC-EUR";
    const shares = isFractional
      ? cashAssigned / a.price          // fraccional exacto
      : Math.floor(cashAssigned / a.price); // lote entero
    const actualCost = shares * a.price;
    const skipped = !isFractional && shares === 0;
    return { ...a, cashAssigned, shares, actualCost, isFractional, skipped };
  });

  // Cash que no se pudo invertir (ETFs con cash < 1 share)
  const stranded = pass1
    .filter(a => a.skipped)
    .reduce((s, a) => s + a.cashAssigned, 0);

  // Redistribuir stranded cash entre activos que sí pudieron comprar
  const canBuy = pass1.filter(a => !a.skipped);
  const canBuyWeight = canBuy.reduce((s, a) => s + a.finalAllocation, 0);

  const result: DCAAllocation[] = pass1.map(a => {
    if (a.skipped) {
      return {
        ticker: a.ticker, name: a.name,
        cashToInvest: a.cashAssigned, actualCost: 0,
        motorWeight: a.finalAllocation,
        shares: 0, pricePerShare: a.price,
        isFractional: false, skipped: true,
        reason: `⏭ Omitido — €${a.cashAssigned.toFixed(0)} insuficiente para 1 participación (€${a.price.toFixed(2)})`,
      };
    }

    // Redistribuir stranded si hay activos que pueden absorberlo
    let extraCash = 0;
    if (stranded > 0 && canBuyWeight > 0) {
      extraCash = (a.finalAllocation / canBuyWeight) * stranded;
    }
    const totalForAsset = a.cashAssigned + extraCash;
    const shares = a.isFractional
      ? totalForAsset / a.price
      : Math.floor(totalForAsset / a.price);
    const actualCost = shares * a.price;

    const sharesStr = a.isFractional
      ? `${shares.toFixed(6)} BTC`
      : `${shares} participaciones`;

    return {
      ticker: a.ticker, name: a.name,
      cashToInvest: totalForAsset, actualCost,
      motorWeight: a.finalAllocation,
      shares, pricePerShare: a.price,
      isFractional: a.isFractional, skipped: false,
      reason: `${trancheLabel} ${(a.finalAllocation * 100).toFixed(1)}% → ${sharesStr} × €${a.price.toFixed(2)} = €${actualCost.toFixed(0)}`,
    };
  });

  return result;
}

// ── MODO ATAQUE ───────────────────────────────────────────────────────────
function computeAttackMode(
  signals: AttackSignal[],
  availableCash: number,
  defensiveLiquidity: number,
  motorAllocations: SmartDCAInput["motorAllocations"]
): Pick<SmartDCAOutput, "action" | "buyFraction" | "totalCashToInvest" | "allocationByAsset" | "reasoning" | "attackMultiplier" | "attackTranche"> {

  const activeCount = signals.filter(s => s.active).length;

  // Tramo 1: 2 señales → entrada exploratoria
  if (activeCount === 2) {
    const fraction = 0.40; // 40% del cash disponible
    const totalCash = availableCash * fraction + defensiveLiquidity * 0.10; // + 10% de la liquidez acumulada
    return buildAttackOutput("ATTACK_ENTRY", totalCash, 1, 1.5, availableCash, motorAllocations,
      `MODO ATAQUE TRAMO 1 — ${activeCount}/5 señales de fondo. Entrada exploratoria €${totalCash.toFixed(0)} (1.5x DCA). Las señales de ciclo se están alineando.`
    );
  }

  // Tramo 2: 3 señales → entrada media con liquidez acumulada parcial
  if (activeCount === 3) {
    const totalCash = availableCash * 0.60 + defensiveLiquidity * 0.35; // + 35% liquidez acumulada
    return buildAttackOutput("ATTACK_STRONG", totalCash, 2, 2.5, availableCash, motorAllocations,
      `MODO ATAQUE TRAMO 2 — ${activeCount}/5 señales confirmadas. €${totalCash.toFixed(0)} incluyendo ${(defensiveLiquidity * 0.35).toFixed(0)}€ de liquidez defensiva acumulada.`
    );
  }

  // Tramo 3: 4-5 señales → despliegue máximo, oportunidad generacional
  if (activeCount >= 4) {
    const totalCash = availableCash + defensiveLiquidity * 0.80; // casi toda la liquidez acumulada
    return buildAttackOutput("ATTACK_MAX", totalCash, 3, 4.0, availableCash, motorAllocations,
      `🚀 MODO ATAQUE MÁXIMO — ${activeCount}/5 señales. OPORTUNIDAD DE CICLO. Desplegando €${totalCash.toFixed(0)} (${defensiveLiquidity > 0 ? `incluye €${(defensiveLiquidity * 0.80).toFixed(0)} acumulados en defensa` : "DCA ×4"}). Esta es la ventana que el CEWS estaba esperando.`
    );
  }

  // Menos de 2 señales — no atacar todavía
  return {
    action: "WAIT",
    buyFraction: 0,
    totalCashToInvest: 0,
    allocationByAsset: [],
    reasoning: `${activeCount}/5 señales de fondo activas — insuficiente para modo ataque. Mantener liquidez.`,
    attackMultiplier: 1,
    attackTranche: 0,
  };
}

function buildAttackOutput(
  action: "ATTACK_ENTRY" | "ATTACK_STRONG" | "ATTACK_MAX",
  totalCash: number,
  tranche: 1 | 2 | 3,
  multiplier: number,
  availableCash: number,
  motorAllocations: SmartDCAInput["motorAllocations"],
  reasoning: string
): Pick<SmartDCAOutput, "action" | "buyFraction" | "totalCashToInvest" | "allocationByAsset" | "reasoning" | "attackMultiplier" | "attackTranche"> {
  const allocationByAsset = buildAllocations(totalCash, motorAllocations, `T${tranche}:`);
  const actualTotal = allocationByAsset.reduce((s, a) => s + a.actualCost, 0);

  return {
    action,
    buyFraction: availableCash > 0 ? actualTotal / availableCash : 1,
    totalCashToInvest: actualTotal,
    allocationByAsset,
    reasoning,
    attackMultiplier: multiplier,
    attackTranche: tranche,
  };
}

// ── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────
export function computeSmartDCA(input: SmartDCAInput): SmartDCAOutput {
  const {
    regime, regimePenalty, volTargetMultiplier,
    tailRiskActive, tailRiskOverlay,
    availableCash, motorAllocations,
  } = input;

  const defensiveLiquidity = input.accumulatedDefensiveLiquidity ?? 0;

  // ── Detectar confluencia de fondo SIEMPRE (para mostrar progreso)
  const attackSignals = detectBottomConfluence(input);
  const attackConfluence = attackSignals.filter(s => s.active).length;

  // ── MODO ATAQUE: tiene prioridad sobre bloqueos defensivos normales
  const attackPossible =
    attackConfluence >= 2 &&
    regime !== "CRISIS" &&
    !tailRiskActive &&
    regimePenalty >= 0.55;

  if (attackPossible) {
    const attackResult = computeAttackMode(attackSignals, availableCash, defensiveLiquidity, motorAllocations);
    if (attackResult.action !== "WAIT") {
      return {
        ...attackResult,
        score: attackConfluence,
        attackMode: true,
        attackConfluence,
        attackSignals,
      };
    }
  }

  // ── SEÑALES TÉCNICAS BTC — se declaran aquí, después del return de ataque
  let technicalScore = 0;
  const signals: string[] = [];
  if (input.btcMomentum1m < 0) { technicalScore++; signals.push("momentum BTC negativo"); }
  if (input.btcRsi < 45)       { technicalScore++; signals.push(`RSI BTC ${input.btcRsi.toFixed(0)}`); }
  if (input.btcZScore < -0.75) { technicalScore++; signals.push(`Z-Score ${input.btcZScore.toFixed(2)}`); }

  // ── BLOQUEOS DEFENSIVOS (igual que antes) ────────────────────────────────
  if (tailRiskActive && tailRiskOverlay < 0.7) {
    return emptyOutput("BLOCK_TAIL_RISK",
      "Tail Risk Overlay activo. El motor ha detectado condiciones de mercado disfuncionales.",
      `Overlay: ×${tailRiskOverlay.toFixed(2)} — No hacer compras hasta que el overlay se desactive.`,
      attackSignals, attackConfluence
    );
  }

  if (regime === "CRISIS" || regimePenalty <= 0.45) {
    return emptyOutput("BLOCK_CRISIS",
      `Régimen CRISIS (penalización ×${regimePenalty.toFixed(2)}). El motor reduce exposición al 40%.`,
      "Mantener liquidez. No comprar hasta que el régimen mejore a CONTRACTION o EXPANSION.",
      attackSignals, attackConfluence
    );
  }

  if (volTargetMultiplier < 0.60) {
    return emptyOutput("BLOCK_VOL",
      `Volatilidad del portfolio supera el objetivo (×${volTargetMultiplier.toFixed(2)}).`,
      "Esperar normalización de volatilidad antes de añadir capital.",
      attackSignals, attackConfluence
    );
  }

  const regimeFractionCap = regime === "CONTRACTION" ? 0.5 : 1.0;

  let baseFraction: number;
  let action: DCAAction;
  if (technicalScore === 0)      { baseFraction = 0;    action = "WAIT"; }
  else if (technicalScore === 1) { baseFraction = 0.25; action = "SMALL_BUY"; }
  else if (technicalScore === 2) { baseFraction = 0.50; action = "BUY"; }
  else                           { baseFraction = 1.00; action = "FULL_BUY"; }

  const adjustedFraction = baseFraction * regimeFractionCap * Math.min(1, volTargetMultiplier);
  const totalCash = availableCash * adjustedFraction;

  const allocationByAsset = totalCash > 0
    ? buildAllocations(totalCash, motorAllocations, "Motor:")
    : [];
  const actualTotal = allocationByAsset.reduce((s, a) => s + a.actualCost, 0);

  const reasoning = action === "WAIT"
    ? `Sin señales técnicas. Régimen ${regime} (×${regimePenalty.toFixed(2)}). ${attackConfluence > 0 ? `${attackConfluence}/5 señales de ataque acumulándose.` : ""}`
    : `${technicalScore}/3 señales BTC: ${signals.join(", ")}. ${regime === "CONTRACTION" ? "Compra reducida." : ""} €${totalCash.toFixed(0)} por motor.`;

  return {
    action,
    score: technicalScore,
    buyFraction: availableCash > 0 ? actualTotal / availableCash : adjustedFraction,
    totalCashToInvest: actualTotal,
    allocationByAsset,
    reasoning,
    attackMode: false,
    attackConfluence,
    attackSignals,
    attackMultiplier: 1,
    attackTranche: 0,
  };
}

// ── HELPER ────────────────────────────────────────────────────────────────
function emptyOutput(
  action: DCAAction,
  reasoning: string,
  blockReason: string,
  attackSignals: AttackSignal[],
  attackConfluence: number
): SmartDCAOutput {
  return {
    action, score: 0, buyFraction: 0, totalCashToInvest: 0,
    allocationByAsset: [], reasoning, blockReason,
    attackMode: false, attackConfluence, attackSignals,
    attackMultiplier: 1, attackTranche: 0,
  };
}