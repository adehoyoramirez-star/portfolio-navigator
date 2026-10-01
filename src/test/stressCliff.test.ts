// ============================================================
// FIX-CLIFF-STRESS-02 — Tests de regresión permanentes
// ============================================================
// CASO LIVE (01-oct-2026): con VIX 16.2 (normalidad), el régimen era CRISIS
//   por tres cliffs simultáneos: Brent $100.1 (+2 en ≥95), CB-QT −0.28% (+2
//   en <0) y MOVE 110.5 (+1 en >110). Perturbaciones de $0.20 de Brent, 2bp
//   de WALCL o 0.2 de MOVE volteaban EXPANSION↔CRISIS. Brent además contaba
//   DOS veces (score +2 Y multiplicador ×0.70 → 0.468 pts de penalty en un día).
//
// Estos tests pinnan:
//   1. Continuidad y monotonicidad de las tres contribuciones nuevas.
//   2. Anclas semánticas exactas (equivalentes a los antiguos escalones).
//   3. Sin cliffs: perturbaciones mínimas NO voltean regímenes.
//   4. El multiplicador petrolero interpolado pasa por los valores antiguos.
//   5. Crisis genuinas (Brent ≥115, QT ≤−5, MOVE ≥180, VIX alto) intactas.

import { describe, test, expect, beforeEach } from "vitest";
import {
  computeGlobalStress,
  brentStressContribution,
  wtiPenaltyContinuous,
  cbLiquidityStressContribution,
  moveStressContribution,
  OIL_STRESS_CONFIG,
  CB_LIQUIDITY_STRESS_CONFIG,
  MOVE_STRESS_CONFIG,
} from "../core/macro/globalStress";
import { getMasterRegime } from "../core/macro/masterRegime";

const HYSTERESIS_KEY = "olympus_regime_hysteresis_v1";
const REFRESH_KEY = "olympus_manual_refresh_v1";

beforeEach(() => {
  localStorage.removeItem(HYSTERESIS_KEY);
  localStorage.removeItem(REFRESH_KEY);
});

// Escenario del caso live: VIX normal, Brent shock, QT marginal, MOVE al borde.
const LIVE = {
  vix: 16.23,
  yieldSpread: 0.354,
  creditSpread: 2.93,
  move: 110.5,
  dxyTrend: 0.025,
  btcVol: 0.3783,
  m2Growth: 5.66,
  wtiOil: 100.1,
  cbLiquidityGrowth: -0.28,
};

function regimeAt(over: Partial<typeof LIVE> = {}) {
  return getMasterRegime({ ...LIVE, ...over }, undefined, undefined, true);
}

// ─────────────────────────────────────────────────────────────
describe("FIX-CLIFF-STRESS-02 — Brent continuo (invariantes)", () => {
  test("anclas semánticas: ≤75→0 · 95→1 · 115→3", () => {
    expect(brentStressContribution(70)).toBe(0);
    expect(brentStressContribution(OIL_STRESS_CONFIG.FLOOR)).toBe(0);
    expect(brentStressContribution(OIL_STRESS_CONFIG.SHOCK)).toBeCloseTo(1, 10);
    expect(brentStressContribution(OIL_STRESS_CONFIG.CRISIS)).toBe(3);
    expect(brentStressContribution(140)).toBe(3);
  });

  test("monotonicidad en $50→$150", () => {
    let prev = brentStressContribution(50);
    for (let p = 50.5; p <= 150.0001; p += 0.5) {
      const cur = brentStressContribution(p);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
  });

  test("continuidad en las fronteras 75 / 95 / 115", () => {
    const EPS = 1e-9;
    for (const b of [75, 95, 115]) {
      expect(Math.abs(brentStressContribution(b + EPS) - brentStressContribution(b))).toBeLessThan(1e-6);
      expect(Math.abs(brentStressContribution(b) - brentStressContribution(b - EPS))).toBeLessThan(1e-6);
    }
  });

  test("$0.20 de Brent mueven ≤0.02 pts — nunca un escalón entero", () => {
    for (const p of [74.9, 75, 85, 94.9, 95, 105, 114.9, 115]) {
      expect(Math.abs(brentStressContribution(p + 0.2) - brentStressContribution(p))).toBeLessThanOrEqual(0.02 + 1e-12);
    }
  });

  test("multiplicador petrolero pasa por los valores antiguos y es continuo", () => {
    expect(wtiPenaltyContinuous(70)).toBeCloseTo(1.0, 10);
    expect(wtiPenaltyContinuous(75)).toBeCloseTo(1.0, 10);
    expect(wtiPenaltyContinuous(95)).toBeCloseTo(0.85, 10);
    expect(wtiPenaltyContinuous(115)).toBeCloseTo(0.70, 10);
    expect(wtiPenaltyContinuous(130)).toBeCloseTo(0.50, 10);
    expect(wtiPenaltyContinuous(150)).toBeCloseTo(0.50, 10);
    // Continuidad local: 10 centavos mueven ≤0.002
    for (const p of [75, 85, 95, 105, 115, 125, 130]) {
      expect(Math.abs(wtiPenaltyContinuous(p + 0.1) - wtiPenaltyContinuous(p))).toBeLessThanOrEqual(0.002 + 1e-12);
    }
  });
});

describe("FIX-CLIFF-STRESS-02 — CB Liquidity continua (invariantes)", () => {
  test("anclas: ≥+1%→0 · 0%→0.5 (SIN cliff en el cero) · −5%→3 · undefined→0", () => {
    expect(cbLiquidityStressContribution(2.0)).toBe(0);
    expect(cbLiquidityStressContribution(CB_LIQUIDITY_STRESS_CONFIG.NEUTRAL)).toBe(0);
    expect(cbLiquidityStressContribution(0)).toBeCloseTo(0.5, 10);
    expect(cbLiquidityStressContribution(CB_LIQUIDITY_STRESS_CONFIG.SATURATION)).toBeCloseTo(3, 10);
    expect(cbLiquidityStressContribution(-7)).toBeCloseTo(3, 10);
    expect(cbLiquidityStressContribution(undefined)).toBe(0);
  });

  test("QT marginal (−0.28%) aporta ~0.72, NO 2.0 — proporcional a su profundidad", () => {
    const marginal = cbLiquidityStressContribution(-0.28);
    expect(marginal).toBeGreaterThan(0.5);
    expect(marginal).toBeLessThan(1.0);
    expect(marginal).toBeLessThan(cbLiquidityStressContribution(-3)); // monotona
  });

  test("monotonicidad y continuidad en +2→−7", () => {
    let prev = cbLiquidityStressContribution(2);
    for (let g = 1.9; g >= -7.0001; g -= 0.1) {
      const cur = cbLiquidityStressContribution(g);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
    expect(Math.abs(cbLiquidityStressContribution(0.001) - cbLiquidityStressContribution(-0.001))).toBeLessThan(0.002);
  });
});

describe("FIX-CLIFF-STRESS-02 — MOVE continuo (invariantes)", () => {
  test("anclas: ≤110→0 · 140→1 · ≥180→2", () => {
    expect(moveStressContribution(100)).toBe(0);
    expect(moveStressContribution(MOVE_STRESS_CONFIG.FLOOR)).toBe(0);
    expect(moveStressContribution(MOVE_STRESS_CONFIG.HIGH)).toBeCloseTo(1, 10);
    expect(moveStressContribution(MOVE_STRESS_CONFIG.SATURATION)).toBe(2);
    expect(moveStressContribution(200)).toBe(2);
  });

  test("monotonicidad y continuidad en 90→200", () => {
    let prev = moveStressContribution(90);
    for (let m = 90.5; m <= 200.0001; m += 0.5) {
      const cur = moveStressContribution(m);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cur;
    }
    for (const b of [110, 140, 180]) {
      expect(Math.abs(moveStressContribution(b + 1e-9) - moveStressContribution(b))).toBeLessThan(1e-6);
    }
  });

  test("0.2 puntos de MOVE mueven ≤0.007 pts — nunca un escalón", () => {
    for (const m of [109.9, 110, 125, 139.9, 140, 160, 179.9, 180]) {
      expect(Math.abs(moveStressContribution(m + 0.2) - moveStressContribution(m))).toBeLessThanOrEqual(0.007 + 1e-12);
    }
  });
});

describe("FIX-CLIFF-STRESS-02 — régimen resuelto: sin cliffs en el caso live", () => {
  test("réplica del panel 01-oct-2026: el score baja de la zona CRISIS", () => {
    // Con el fix: Brent $100.1 ≈ +1.505 (antes +2), QT −0.28 ≈ +0.72 (antes +2),
    // MOVE 110.5 ≈ +0.017 (antes +1) → score ≈ 3.26+dxy → bajo HIGH_RISK (≥5).
    expect(computeGlobalStress(LIVE).score).toBeLessThan(5);
  });

  test("perturbaciones mínimas NO voltean el régimen ($0.20 Brent · 2bp QT · 0.2 MOVE)", () => {
    const base = regimeAt();
    const perturbations: Array<Partial<typeof LIVE>> = [
      { wtiOil: 100.3 }, { wtiOil: 99.9 },
      { cbLiquidityGrowth: -0.30 }, { cbLiquidityGrowth: -0.26 },
      { move: 110.7 }, { move: 110.3 },
    ];
    for (const p of perturbations) {
      expect(regimeAt(p).regime, JSON.stringify(p)).toBe(base.regime);
    }
  });

  test("transición Brent 94→96 es suave en penalty (antes: Δ0.29 en un día)", () => {
    const lo = regimeAt({ wtiOil: 94 });
    const hi = regimeAt({ wtiOil: 96 });
    expect(Math.abs(hi.regimePenalty - lo.regimePenalty)).toBeLessThan(0.12);
  });

  test("transición QT ±2bp alrededor de 0 es suave (antes: EXPANSION→CRISIS)", () => {
    const up = regimeAt({ cbLiquidityGrowth: 0.02 });
    const down = regimeAt({ cbLiquidityGrowth: -0.02 });
    expect(Math.abs(down.regimePenalty - up.regimePenalty)).toBeLessThan(0.12);
  });

  test("transición MOVE 109→111 es suave (antes: Δpenalty 0.146)", () => {
    const lo = regimeAt({ move: 109 });
    const hi = regimeAt({ move: 111 });
    expect(Math.abs(hi.regimePenalty - lo.regimePenalty)).toBeLessThan(0.12);
  });
});

describe("FIX-CLIFF-STRESS-02 — crisis genuinas siguen detectándose", () => {
  test("guerra energética: Brent ≥115 aporta sus 3 pts completos + CONFLUENCIA escala el régimen", () => {
    // (1) La contribución del shock NO se perdió: Brent ≥115 → 3.0 pts completos.
    for (const brent of [115, 120, 130]) {
      const s = computeGlobalStress({ vix: 18, creditSpread: 2.0, move: 100, dxyTrend: 0, btcVol: 0.5, wtiOil: brent });
      expect(brentStressContribution(brent)).toBe(3);
      expect(s.score).toBeGreaterThanOrEqual(3);
    }
    // (2) Principio anti-cliff: UN solo indicador NO voltea el régimen por sí solo
    //     (Brent 115 con mercados totalmente calmados → elevated, no CRISIS).
    //     Esto ES el comportamiento diseñado — es lo que elimina la clase de bug.
    // (3) Con CONFLUENCIA real (VIX elevado = mercados estresando), escala:
    //     Brent 115 (3.0) + VIX 22 (+1) + credit 2.0 (0) + dxy 2% (+1) = 5.0 → HIGH_RISK.
    const confluence = computeGlobalStress({ vix: 22, creditSpread: 2.0, move: 100, dxyTrend: 0.025, btcVol: 0.5, wtiOil: 115 });
    expect(confluence.score).toBeCloseTo(5, 6);
    expect(confluence.regime).toBe("HIGH_RISK");
    // (4) Crisis plena (VIX 35 + credit 4.5 + shock Brent) → CRISIS intacta.
    const full = computeGlobalStress({ vix: 35, creditSpread: 4.5, move: 120, dxyTrend: 0.025, btcVol: 0.6, wtiOil: 120 });
    expect(full.score).toBeGreaterThanOrEqual(6);
    expect(full.regime).toBe("CRISIS");
  });

  test("QT deflacionario (≤−5%) + shock Brent sigue en CRISIS/HIGH_RISK", () => {
    const s = computeGlobalStress({ vix: 20, creditSpread: 2.5, move: 115, dxyTrend: 0.025, btcVol: 0.6, wtiOil: 100, cbLiquidityGrowth: -6 });
    expect(s.score).toBeGreaterThanOrEqual(5);
  });

  test("normalidad plena no produce estrés — comportamiento intacto", () => {
    const s = computeGlobalStress({ vix: 15, creditSpread: 1.8, move: 95, dxyTrend: 0, btcVol: 0.5, wtiOil: 70, cbLiquidityGrowth: 2.0 });
    expect(s.score).toBe(0);
    expect(s.regime).toBe("NORMAL");
  });

  test("wtiShock queda como etiqueta informativa (no alimenta fórmulas)", () => {
    const s = computeGlobalStress({ vix: 15, creditSpread: 1.8, move: 95, dxyTrend: 0, btcVol: 0.5, wtiOil: 100 });
    expect(s.wtiShock).toBe("SHOCK"); // etiqueta correcta para display
    expect(s.wtiPenalty).toBeCloseTo(1.0 - (100 - 75) * (0.15 / 20), 10); // continuo, no 0.70 salto
  });
});
