// ===============================================
// ARCHIVO: src/core/dca/smartDCA.ts
// NIVEL 4 — SmartDCA motor-aware
// ===============================================
// ANTES: solo señales de BTC (RSI, ZScore, momentum)
//   → ignoraba régimen, vol target, tail risk, allocations del motor
//   → podía sugerir comprar en CRISIS si BTC estaba oversold
//
// AHORA: integración completa con el motor
//   1. Régimen macro bloquea compras en CRISIS (regimePenalty ≤ 0.4)
//   2. Vol target escala el tamaño: si vol > target → compra menor
//   3. Tail risk overlay bloquea compras si activo
//   4. Señales técnicas de BTC para timing dentro del régimen
//   5. Distribución por activo basada en allocations del motor
// ===============================================

export type DCAAction = "BLOCK_CRISIS" | "BLOCK_TAIL_RISK" | "BLOCK_VOL" | "WAIT" | "SMALL_BUY" | "BUY" | "FULL_BUY";

export interface SmartDCAInput {
  // Señales de BTC (técnicas)
  btcRsi: number;
  btcZScore: number;
  btcMomentum1m: number;

  // Estado del motor (macro)
  regime: string;
  regimePenalty: number;           // [0.4, 1.0] continuo del masterRegime
  volTargetMultiplier: number;     // [0.3, 1.5] — <1 si vol > target
  tailRiskActive: boolean;
  tailRiskOverlay: number;

  // Capital disponible
  availableCash: number;

  // Allocations del motor por activo (para distribuir el DCA)
  motorAllocations: { name: string; ticker: string; finalAllocation: number }[];
}

export interface DCAAllocation {
  ticker: string;
  name: string;
  cashToInvest: number;       // € a invertir en este activo
  motorWeight: number;        // peso según el motor [0,1]
  reason: string;
}

export interface SmartDCAOutput {
  action: DCAAction;
  score: number;              // señal técnica de BTC [0-3]
  buyFraction: number;        // fracción del capital disponible a usar [0,1]
  totalCashToInvest: number;  // € totales a invertir
  allocationByAsset: DCAAllocation[];
  reasoning: string;          // explicación en texto
  blockReason?: string;       // si hay bloqueo, por qué
}

/**
 * Smart DCA con consciencia del motor.
 * La decisión de cuánto invertir viene del motor; el timing de BTC.
 *
 * Orden de decisión:
 *   1. ¿Tail risk activo? → BLOCK (independiente de señales técnicas)
 *   2. ¿Régimen CRISIS (penalty ≤ 0.45)? → BLOCK
 *   3. ¿Vol target < 0.6? → BLOCK (portfolio en modo defensivo)
 *   4. Señales técnicas de BTC → determina fracción de compra
 *   5. Distribuir por allocations del motor
 */
export function computeSmartDCA(input: SmartDCAInput): SmartDCAOutput {
  const { regime, regimePenalty, volTargetMultiplier, tailRiskActive, tailRiskOverlay, availableCash, motorAllocations } = input;

  // ---- BLOQUEOS ----
  if (tailRiskActive && tailRiskOverlay < 0.7) {
    return {
      action: "BLOCK_TAIL_RISK",
      score: 0, buyFraction: 0, totalCashToInvest: 0,
      allocationByAsset: [],
      reasoning: "Tail Risk Overlay activo. El motor ha detectado condiciones de mercado disfuncionales.",
      blockReason: `Overlay: ×${tailRiskOverlay.toFixed(2)} — No hacer compras hasta que el overlay se desactive.`,
    };
  }

  if (regime === "CRISIS" || regimePenalty <= 0.45) {
    return {
      action: "BLOCK_CRISIS",
      score: 0, buyFraction: 0, totalCashToInvest: 0,
      allocationByAsset: [],
      reasoning: `Régimen CRISIS detectado (penalización ×${regimePenalty.toFixed(2)}). El motor reduce exposición al 40%.`,
      blockReason: "Mantener liquidez. No comprar hasta que el régimen mejore a CONTRACTION o EXPANSION.",
    };
  }

  if (volTargetMultiplier < 0.60) {
    return {
      action: "BLOCK_VOL",
      score: 0, buyFraction: 0, totalCashToInvest: 0,
      allocationByAsset: [],
      reasoning: `Volatilidad del portfolio supera el objetivo (×${volTargetMultiplier.toFixed(2)}). El motor está reduciendo exposición.`,
      blockReason: "Esperar normalización de volatilidad antes de añadir capital.",
    };
  }

  // ---- SEÑALES TÉCNICAS DE BTC ----
  let technicalScore = 0;
  const signals: string[] = [];

  if (input.btcMomentum1m < 0) {
    technicalScore++;
    signals.push("momentum BTC negativo");
  }
  if (input.btcRsi < 45) {
    technicalScore++;
    signals.push(`RSI BTC sobrevendido (${input.btcRsi.toFixed(0)})`);
  }
  if (input.btcZScore < -0.75) {
    technicalScore++;
    signals.push(`BTC por debajo de su media (z=${input.btcZScore.toFixed(2)})`);
  }

  // Ajuste base por régimen: en CONTRACTION, comprar menos aunque la señal sea buena
  const regimeFractionCap = regime === "CONTRACTION" ? 0.5 : 1.0;

  // Fracción de compra técnica
  let baseFraction: number;
  let action: DCAAction;
  if (technicalScore === 0) {
    baseFraction = 0; action = "WAIT";
  } else if (technicalScore === 1) {
    baseFraction = 0.25; action = "SMALL_BUY";
  } else if (technicalScore === 2) {
    baseFraction = 0.50; action = "BUY";
  } else {
    baseFraction = 1.00; action = "FULL_BUY";
  }

  // Escalar por vol target y régimen
  const adjustedFraction = baseFraction * regimeFractionCap * Math.min(1, volTargetMultiplier);
  const totalCash = availableCash * adjustedFraction;

  // Distribuir por allocations del motor (solo activos con peso > 2%)
  const eligibleAssets = motorAllocations.filter(a => a.finalAllocation > 0.02);
  const totalEligibleWeight = eligibleAssets.reduce((s, a) => s + a.finalAllocation, 0);

  const allocationByAsset: DCAAllocation[] = totalCash > 0 && totalEligibleWeight > 0
    ? eligibleAssets.map(a => ({
        ticker: a.ticker,
        name: a.name,
        cashToInvest: (a.finalAllocation / totalEligibleWeight) * totalCash,
        motorWeight: a.finalAllocation,
        reason: `Motor: ${(a.finalAllocation * 100).toFixed(1)}% → €${((a.finalAllocation / totalEligibleWeight) * totalCash).toFixed(0)}`,
      }))
    : [];

  // Texto de reasoning
  const reasoning = action === "WAIT"
    ? `Sin señales técnicas de entrada. Régimen ${regime} (×${regimePenalty.toFixed(2)}). Esperar oportunidad.`
    : `${technicalScore}/3 señales: ${signals.join(", ")}. ${regime === "CONTRACTION" ? "Compra reducida por régimen." : ""} €${totalCash.toFixed(0)} distribuidos por motor.`;

  return {
    action,
    score: technicalScore,
    buyFraction: adjustedFraction,
    totalCashToInvest: totalCash,
    allocationByAsset,
    reasoning,
  };
}