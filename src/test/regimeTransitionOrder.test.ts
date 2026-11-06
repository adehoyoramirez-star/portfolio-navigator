// ============================================================
// FIX-REGIME-TRANSITION-ORDER (Nov-2026) — pins del orden del historial
// ============================================================
// Caso live que lo motivó: EXPANSION → CONTRACTION (deterioro, ×0.78) y el
// dashboard publicaba «Régimen CONTRACTION — mejora confirmada» + ✅, con
// 4/8 señales y ataque de cartera completa desplegando el war chest.
//
// Causa: saveRegimeEntry hace unshift (historial NEWEST-FIRST) y el consumidor
// recorría el array del final al principio → devolvía el régimen MÁS ANTIGUO
// distinto del actual, no el anterior. Un CONTRACTION de hoy se comparaba
// contra un CRISIS de hace meses → SEV 1 < 2 → "mejora".
//
// Segundo defecto pinado aquí: el registro solo ocurría si el render generaba
// alertas (generateAlerts devuelve [] con Kill Switch 0) → historial vacío o
// incompleto → fallback legacy por nivel.

import { describe, test, expect } from "vitest";
import { findPreviousRegime, type RegimeHistoryEntry } from "../core/persistence/portfolioStorage";
import { detectBottomConfluence, type SmartDCAInput } from "../core/dca/smartDCA";

// El historial real está ordenado del más reciente al más antiguo.
const entry = (regime: string): RegimeHistoryEntry => ({
  timestamp: "2026-11-01T00:00:00.000Z",
  regime,
  regimePenalty: 0.78,
  confidence: "MEDIUM",
  vix: 20,
});

/** Input mínimo válido para detectBottomConfluence (no pasa por ruta de compra). */
function baseInput(overrides: Partial<SmartDCAInput> = {}): SmartDCAInput {
  return {
    btcRsi: 41, btcZScore: 0.59, btcMomentum1m: -0.084,
    btcDominance: 60.4, mvrvRatio: 1.40, mvrvZScore: undefined,
    regime: "CONTRACTION", regimePenalty: 0.78,
    volTargetMultiplier: 1.0, tailRiskActive: false, tailRiskOverlay: 1.0,
    killSwitchLevel: 0, recoveryCyclesRemaining: 0,
    olympusAvailableCash: 1_946, tacticalAvailableCash: 7_976,
    motorAllocations: [],
    ...overrides,
  };
}

const regimeSignal = (input: SmartDCAInput) =>
  detectBottomConfluence(input).find(s => s.name === "Régimen Mejorando");

describe("FIX-REGIME-TRANSITION-ORDER — previousRegime sobre historial newest-first", () => {
  test("devuelve el régimen INMEDIATAMENTE anterior, no el más antiguo", () => {
    // [hoy, anterior, …, más antiguo]
    expect(findPreviousRegime([entry("CONTRACTION"), entry("EXPANSION"), entry("CRISIS")], "CONTRACTION"))
      .toBe("EXPANSION");
  });

  test("cambio aún no registrado: el primero del historial YA es el anterior", () => {
    expect(findPreviousRegime([entry("EXPANSION"), entry("CRISIS")], "CONTRACTION")).toBe("EXPANSION");
  });

  test("historial con solo el régimen actual → persistencia, no undefined", () => {
    expect(findPreviousRegime([entry("CONTRACTION"), entry("CONTRACTION")], "CONTRACTION")).toBe("CONTRACTION");
  });

  test("sin historial → undefined (único caso con fallback legacy)", () => {
    expect(findPreviousRegime([], "CONTRACTION")).toBeUndefined();
  });

  test("ALL_CASH se normaliza a CRISIS al comparar", () => {
    expect(findPreviousRegime([entry("CRISIS")], "ALL_CASH")).toBe("CRISIS");
    expect(findPreviousRegime([entry("ALL_CASH")], "CRISIS")).toBe("CRISIS");
  });
});

describe("FIX-REGIME-TRANSITION-ORDER — la señal no se enciende sin transición real", () => {
  test("EXPANSION → CONTRACTION (caso live) NO es mejora", () => {
    const prev = findPreviousRegime([entry("CONTRACTION"), entry("EXPANSION")], "CONTRACTION");
    expect(prev).toBe("EXPANSION");
    const sig = regimeSignal(baseInput({ regime: "CONTRACTION", regimePenalty: 0.78, previousRegime: prev }));
    expect(sig?.active).toBe(false);
  });

  test("CONTRACTION → CONTRACTION (persistencia) NO es mejora", () => {
    const prev = findPreviousRegime([entry("CONTRACTION")], "CONTRACTION");
    const sig = regimeSignal(baseInput({ regime: "CONTRACTION", regimePenalty: 0.78, previousRegime: prev }));
    expect(sig?.active).toBe(false);
  });

  test("CRISIS → CONTRACTION SÍ es mejora (no se rompe el caso legítimo)", () => {
    const prev = findPreviousRegime([entry("CONTRACTION"), entry("CRISIS")], "CONTRACTION");
    expect(prev).toBe("CRISIS");
    const sig = regimeSignal(baseInput({ regime: "CONTRACTION", regimePenalty: 0.78, previousRegime: prev }));
    expect(sig?.active).toBe(true);
  });
});
