// ===============================================
// ARCHIVO: src/core/risk/tailRisk.ts
// NIVEL 2: Tail risk overlay integrado en el motor
// ===============================================
// ANTES: función suelta sin consumidor, operaba sobre drawdown puntual
// AHORA: overlay que combina drawdown + stress para escalar allocations
//        Actúa DESPUÉS del volatility targeting como capa adicional de protección
//
// Filosofía: cuando el portfolio ya está en drawdown severo,
// reducir aún más exposición para evitar el "double dip"
// ===============================================

export interface TailRiskInput {
  drawdown: number;        // drawdown actual en decimal (ej: -0.15 = -15%)
  vix: number;             // VIX actual
  creditSpread: number;    // credit spread HY-IG en %
  stressScore: number;     // score del GlobalStress [0-9]
}

export interface TailRiskOutput {
  overlay: number;          // multiplicador de overlay [0.3, 1.0]
  isActive: boolean;        // true si el overlay está reduciendo exposición
  triggerReason: string;    // para mostrar en el dashboard
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
 * Se aplica multiplicando sobre el finalAllocation ya ajustado por vol target:
 *   effectiveAllocation = kellyAllocation × volMultiplier × tailOverlay
 *
 * @example uso en olympusV3.ts:
 *   const tail = computeTailRiskOverlay({
 *     drawdown: portfolioDrawdown,
 *     vix, creditSpread,
 *     stressScore: masterRegime.stressDetail.score,
 *   });
 *   // Aplicar sobre todas las allocations:
 *   allocation.finalAllocation *= tail.overlay;
 */
export function computeTailRiskOverlay(input: TailRiskInput): TailRiskOutput {
  const { drawdown, vix, creditSpread, stressScore } = input;

  // Drawdown severo — reducción fuerte independiente del entorno
  if (drawdown < -0.25) {
    return {
      overlay: 0.40,
      isActive: true,
      triggerReason: `Drawdown severo (${(drawdown * 100).toFixed(1)}%) — protección máxima activada`,
    };
  }

  // Crisis de mercado: VIX extremo + crédito disfuncional
  if (vix > 35 && creditSpread > 3) {
    return {
      overlay: 0.45,
      isActive: true,
      triggerReason: `VIX ${vix.toFixed(0)} + Credit Spread ${creditSpread.toFixed(1)}% — mercado disfuncional`,
    };
  }

  // Drawdown moderado + mercado de miedo
  if (drawdown < -0.15 && vix > 35) {
    return {
      overlay: 0.55,
      isActive: true,
      triggerReason: `Drawdown (${(drawdown * 100).toFixed(1)}%) con VIX elevado — reducción preventiva`,
    };
  }

  // Drawdown moderado + estrés sistémico alto
  if (drawdown < -0.10 && stressScore > 6) {
    return {
      overlay: 0.65,
      isActive: true,
      triggerReason: `Drawdown (${(drawdown * 100).toFixed(1)}%) con stress score ${stressScore} — cautela`,
    };
  }

  return { overlay: 1.0, isActive: false, triggerReason: "" };
}