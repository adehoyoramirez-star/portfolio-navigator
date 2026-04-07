// ===============================================
// ARCHIVO: src/core/risk/tailRisk.ts
// NIVEL 4.1 PRO: Tail risk overlay + Volatility rules
// ===============================================
// ANTES: función suelta sin consumidor, operaba sobre drawdown puntual
// AHORA: overlay que combina drawdown + stress + volatilidad para escalar allocations
//        Actúa DESPUÉS del volatility targeting como capa adicional de protección
//
// Filosofía: cuando el portfolio ya está en drawdown severo,
// reducir aún más exposición para evitar el "double dip"
//
// SPEC V4.1 PRO - Reglas de volatilidad:
//   if volatility > 25%: reduce_position_size -25%
//   if volatility > 30%: reduce_position_size -40%
//   if drawdown > 25%: pause_large_buys, allow_small_dca
// ===============================================

export interface TailRiskInput {
  drawdown: number;        // drawdown actual en decimal (ej: -0.15 = -15%)
  vix: number;             // VIX actual
  creditSpread: number;    // credit spread HY-IG en %
  stressScore: number;     // score del GlobalStress [0-9]
  portfolioVolatility?: number;  // volatilidad realizada del portfolio
}

export interface TailRiskOutput {
  overlay: number;          // multiplicador de overlay [0.3, 1.0]
  isActive: boolean;        // true si el overlay está reduciendo exposición
  triggerReason: string;    // para mostrar en el dashboard

  // V4.1 PRO: Volatility rules
  volatilityReduction: number;  // reducción por volatilidad [0, 0.40]
  maxBtcWeightActive: boolean;  // true si BTC weight > 70% → cap activado
}

/**
 * Calcula el tail risk overlay — capa final de reducción de riesgo.
 *
 * Triggers (en orden de severidad):
 *   1. Drawdown > 25%: overlay = 0.40 (reducción severa)
 *   2. Drawdown > 15% + VIX > 35: overlay = 0.55
 *   3. Drawdown > 10% + stress score > 6: overlay = 0.65
 *   4. VIX > 35 + credit spread > 3: overlay = 0.45
 *   5. Sin trigger: overlay = 1.0
 *
 * V4.1 PRO: Reglas de volatilidad adicionales
 *   if volatility > 25%: reduce_position_size -25%
 *   if volatility > 30%: reduce_position_size -40%
 *
 * Se aplica multiplicando sobre el finalAllocation ya ajustado por vol target:
 *   effectiveAllocation = kellyAllocation × volMultiplier × tailOverlay
 *
 * @example uso en olympusV3.ts:
 *   const tail = computeTailRiskOverlay({
 *     drawdown: portfolioDrawdown,
 *     vix, creditSpread,
 *     stressScore: masterRegime.stressDetail.score,
 *     portfolioVolatility: portfolioRealizedVol,
 *   });
 *   // Aplicar sobre todas las allocations:
 *   allocation.finalAllocation *= tail.overlay;
 */
export function computeTailRiskOverlay(input: TailRiskInput): TailRiskOutput {
  const { drawdown, vix, creditSpread, stressScore } = input;
  const portfolioVol = input.portfolioVolatility ?? 0;

  // ===============================================
  // V4.1 PRO: VOLATILITY RULES
  // ===============================================
  let volatilityReduction = 0;

  if (portfolioVol > 0.30) {
    volatilityReduction = 0.40;  // -40% si vol > 30%
  } else if (portfolioVol > 0.25) {
    volatilityReduction = 0.25;  // -25% si vol > 25%
  }

  // ===============================================
  // DRAWDOWN RULES (V4.1 PRO)
  // ===============================================
  let overlay = 1.0;
  let isActive = false;
  let triggerReason = '';

  // Drawdown severo — reducción fuerte independiente del entorno
  if (drawdown < -0.25) {
    overlay = 0.40;
    isActive = true;
    triggerReason = `Drawdown severo (${(drawdown * 100).toFixed(1)}%) — protección máxima activada`;
  }
  // Crisis de mercado: VIX extremo + crédito disfuncional
  else if (vix > 35 && creditSpread > 3) {
    overlay = 0.45;
    isActive = true;
    triggerReason = `VIX ${vix.toFixed(0)} + Credit Spread ${creditSpread.toFixed(1)}% — mercado disfuncional`;
  }
  // Drawdown moderado + mercado de miedo
  else if (drawdown < -0.15 && vix > 35) {
    overlay = 0.55;
    isActive = true;
    triggerReason = `Drawdown (${(drawdown * 100).toFixed(1)}%) con VIX elevado — reducción preventiva`;
  }
  // Drawdown moderado + estrés sistémico alto
  else if (drawdown < -0.10 && stressScore > 6) {
    overlay = 0.65;
    isActive = true;
    triggerReason = `Drawdown (${(drawdown * 100).toFixed(1)}%) con stress score ${stressScore} — cautela`;
  }

  // Aplicar volatility reduction al overlay final
  const finalOverlay = overlay * (1 - volatilityReduction);

  // Construir triggerReason completo
  let fullReason = triggerReason;
  if (volatilityReduction > 0) {
    const volPct = (portfolioVol * 100).toFixed(1);
    const reductionPct = (volatilityReduction * 100).toFixed(0);
    const volReason = `Volatilidad ${volPct}% > ${portfolioVol > 0.30 ? '30' : '25'}% → reducción ${reductionPct}%`;
    fullReason = fullReason ? `${fullReason} + ${volReason}` : volReason;
  }

  // Max BTC weight check (V4.1 PRO: max_btc_weight: 70%)
  // Esto se aplica en el motor principal, no aquí, pero exponemos el flag
  const maxBtcWeightActive = false;  // Se calcula en olympusV3.ts por activo

  return {
    overlay: finalOverlay,
    isActive: isActive || volatilityReduction > 0,
    triggerReason: fullReason || (volatilityReduction > 0 ? `Volatilidad ${((portfolioVol)*100).toFixed(1)}%` : ""),
    volatilityReduction,
    maxBtcWeightActive,
  };
}