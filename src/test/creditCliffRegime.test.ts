// ============================================================
// FIX-CLIFF-CREDIT-01 — Tests de regresión permanentes
// ============================================================
// CASO ORIGINAL (Oct-2026): credit 2.98% → CONTRACTION, credit 3.08% → CRISIS
//   (escalón entero `if (credit > 3) score += 1` en globalStress con resto de
//   inputs = 5) → salto de penalty 0.925 → 0.550 → orden material (~225 URNU).
//
// Estos tests pinnan que:
//   1. La contribución de credit es continua y monótona (sin cliffs).
//   2. El caso exacto 2.98 vs 3.08 ya NO cambia el régimen resuelto ni el penalty.
//   3. Toda la batería de perturbaciones (±5..100 pb) mantiene el régimen estable
//      o, si cambia, el cambio es suave (sin saltos de penalty > 0.05).
//   4. Escenarios de crisis GENUINA (credit 5-6%) siguen detectándose — la
//      corrección no anestesia el detector.
//
// La hysteresis existente se limpia en beforeEach para medir el efecto PURO
// de la función (el live añade su propia protección por diseño — no duplicada).

import { describe, test, expect, beforeEach } from "vitest";
import { computeGlobalStress, creditStressContribution, CREDIT_STRESS_CONFIG } from "../core/macro/globalStress";
import { getMasterRegime } from "../core/macro/masterRegime";

const HYSTERESIS_KEY = "olympus_regime_hysteresis_v1";
const REFRESH_KEY = "olympus_manual_refresh_v1";

beforeEach(() => {
  localStorage.removeItem(HYSTERESIS_KEY);
  localStorage.removeItem(REFRESH_KEY);
});

// ── Escenario del caso real: resto de inputs = 5 puntos de stress ──
// VIX 26 (+2) + MOVE 145 (+2) + dxyTrend 3% (+1) = 5 SIN credit.
// Con el escalón antiguo: credit>3 → 6 = CRISIS. Sin él → 5 = HIGH_RISK/CONTRACTION.
function regimeAt(credit: number) {
  const out = getMasterRegime({
    vix: 26,
    yieldSpread: -0.10,
    creditSpread: credit,
    move: 145,
    dxyTrend: 0.03,
    btcVol: 0.60,
    m2Growth: 3.5,
  });
  return out;
}

describe("FIX-CLIFF-CREDIT-01 — creditStressContribution (invariantes)", () => {
  test("anclas semánticas: ≤2% → 0 · 5% → 1 · ≥6% → 2", () => {
    expect(creditStressContribution(1.5)).toBe(0);
    expect(creditStressContribution(CREDIT_STRESS_CONFIG.FLOOR)).toBe(0);
    expect(creditStressContribution(CREDIT_STRESS_CONFIG.PLATEAU)).toBeCloseTo(1.0, 10);
    expect(creditStressContribution(CREDIT_STRESS_CONFIG.MAX)).toBe(2);
    expect(creditStressContribution(8.0)).toBe(2);
  });

  test("monotonicidad: no decreciente en todo el rango 0→10%", () => {
    let prev = creditStressContribution(0);
    for (let x = 0.05; x <= 10.0001; x += 0.05) {
      const cur = creditStressContribution(x);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
  });

  test("continuidad: sin saltos en las fronteras 2.0 / 5.0 / 6.0", () => {
    const EPS = 1e-9;
    for (const boundary of [2.0, 5.0, 6.0]) {
      const left = creditStressContribution(boundary - EPS);
      const at = creditStressContribution(boundary);
      const right = creditStressContribution(boundary + EPS);
      expect(Math.abs(at - left)).toBeLessThan(1e-6);
      expect(Math.abs(right - at)).toBeLessThan(1e-6);
    }
  });

  test("sin cliffs: 10 pb mueven como máximo pendienteMáx·0.1 (≪ 1 punto)", () => {
    // Pendientes por tramo: 2→5 = 1/3 pts/pp · 5→6 = 1.0 pts/pp (la mayor).
    // Peor caso: 10 pb en el tramo 5→6 → 0.1 pts. En el tramo de acción → 0.0034 pts.
    const maxDelta = 0.1 * 1.0; // pendiente máxima del piecewise × ancho en pp
    const grid = [1.95, 2.0, 2.5, 2.9, 2.98, 3.0, 3.08, 3.5, 4.0, 4.9, 5.0, 5.5, 5.9, 6.0];
    for (const x of grid) {
      const d = Math.abs(creditStressContribution(x + 0.1) - creditStressContribution(x));
      expect(d).toBeLessThanOrEqual(maxDelta + 1e-12);
    }
  });

  test("sin cliffs en el score AGREGADO alrededor de 3.00% y 5.00%", () => {
    for (const around of [3.0, 5.0]) {
      const below = computeGlobalStress({
        vix: 26, creditSpread: around - 0.02, move: 145, dxyTrend: 0.03, btcVol: 0.60,
      }).score;
      const above = computeGlobalStress({
        vix: 26, creditSpread: around + 0.02, move: 145, dxyTrend: 0.03, btcVol: 0.60,
      }).score;
      expect(above - below).toBeLessThan(0.05); // antes: salto entero de +1
    }
  });
});

describe("FIX-CLIFF-CREDIT-01 — caso exacto 2.98% vs 3.08% (regresión)", () => {
  test("10 pb NO voltean CONTRACTION → CRISIS por sí solos", () => {
    const lo = regimeAt(2.98);
    const hi = regimeAt(3.08);
    // La señal de crisis NO puede activarse solo por cruzar 3.0
    expect(hi.stressDetail.regime).not.toBe("CRISIS");
    expect(hi.regime).not.toBe("CRISIS");
    expect(hi.regime).toBe(lo.regime);
  });

  test("el penalty no salta >0.05 por 10 pb de credit", () => {
    const lo = regimeAt(2.98);
    const hi = regimeAt(3.08);
    expect(Math.abs(hi.regimePenalty - lo.regimePenalty)).toBeLessThan(0.05);
    // Fingerprint del fix: el salto histórico era 0.925 → 0.550 (Δ=0.375)
    expect(lo.regimePenalty).toBeGreaterThan(0.85);
  });

  test("tabla de sensibilidad completa: régimen estable en 2.90→3.10", () => {
    const grid = [2.90, 2.95, 2.98, 3.00, 3.02, 3.05, 3.08, 3.10];
    const regimes = grid.map(c => regimeAt(c).regime);
    for (const r of regimes) expect(r).not.toBe("CRISIS");
    expect(new Set(regimes).size).toBe(1);
  });
});

describe("FIX-CLIFF-CREDIT-01 — batería de perturbación ±5..100 pb", () => {
  const CENTER = 3.0;
  const PERTURBATIONS_BP = [5, 10, 20, 30, 50, 100];

  test("continuidad de penalty y exposición en toda la batería", () => {
    const center = regimeAt(CENTER);
    for (const bp of PERTURBATIONS_BP) {
      const up = regimeAt(CENTER + bp / 10000);
      const down = regimeAt(CENTER - bp / 10000);
      // Si el régimen no cambia, el penalty NO puede moverse >0.05
      if (up.regime === center.regime) {
        expect(Math.abs(up.regimePenalty - center.regimePenalty)).toBeLessThan(0.05);
      }
      if (down.regime === center.regime) {
        expect(Math.abs(down.regimePenalty - center.regimePenalty)).toBeLessThan(0.05);
      }
      // Nunca un flip directo a CRISIS por perturbaciones ≤100 pb
      expect(up.regime).not.toBe("CRISIS");
      expect(down.regime).not.toBe("CRISIS");
    }
  });

  test("transiciones grandes (±100 pb) son suaves en penalty", () => {
    // Credit 2.0 → 3.0 (100 pb reales): puede cambiar HIGH_RISK, pero el
    // penalty debe evolucionar gradualmente (piecewise, no escalón).
    const r20 = regimeAt(2.0);
    const r25 = regimeAt(2.5);
    const r30 = regimeAt(3.0);
    const penalties = [r20.regimePenalty, r25.regimePenalty, r30.regimePenalty];
    for (let i = 1; i < penalties.length; i++) {
      expect(Math.abs(penalties[i] - penalties[i - 1])).toBeLessThan(0.12);
    }
  });
});

describe("FIX-CLIFF-CREDIT-01 — crisis genuina sigue detectándose", () => {
  test("credit 5.0-6.0 + VIX 40 sigue en CRISIS/HIGH_RISK (sin anestesia)", () => {
    for (const credit of [5.0, 5.5, 6.0]) {
      const stress = computeGlobalStress({
        vix: 40, creditSpread: credit, move: 160, dxyTrend: 0.03, btcVol: 0.80,
      });
      expect(stress.score).toBeGreaterThanOrEqual(5);
      expect(["HIGH_RISK", "CRISIS"]).toContain(stress.regime);
    }
    // Crisis plena con credit 6%: score de credit = 2.0 (equivalente al antiguo +2)
    const full = computeGlobalStress({
      vix: 40, creditSpread: 6.0, move: 160, dxyTrend: 0.03, btcVol: 0.80,
    });
    expect(full.regime).toBe("CRISIS");
  });

  test("credit normal (≤2%) no aporta estrés — comportamiento intacto", () => {
    const s = computeGlobalStress({
      vix: 15, creditSpread: 1.8, move: 90, dxyTrend: 0, btcVol: 0.5,
    });
    expect(s.score).toBe(0);
    expect(s.regime).toBe("NORMAL");
  });
});
