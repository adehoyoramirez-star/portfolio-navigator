// ============================================================
// src/test/coreDefProfile.test.ts
// CORE-DEF (CORE + vol target + Kill Switch, OPT-IN) — criterio B7 de
// scripts/validation/PREREGISTRO_CORE_DEF.md.
// Garantía central: sin `coreDefensive` el comportamiento es BIT-IDÉNTICO al actual.
// ============================================================
import { describe, test, expect } from "vitest";
import { runOlympusEngine, type AssetInput } from "../core/engine/olympusV3";
import { OLYMPUS_CORE } from "../core/config/engineConfig";

const VOLS = [0.60, 0.18, 0.14, 0.25, 0.20, 0.15]; // BTC, EM, Gold, Uranium, SmallCap, World
function assets(): AssetInput[] {
  const tickers = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
  return tickers.map((t, i) => ({
    name: t,
    ticker: t,
    returns12m: [0.45, 0.06, 0.12, 0.20, 0.10, 0.09][i],
    returns3m: [0.08, 0.02, 0.03, 0.05, 0.02, 0.02][i],
    returns1m: [0.02, 0.01, 0.01, 0.02, 0.01, 0.01][i],
    earningsYield: [0, 0.05, 0, 0.02, 0.04, 0.05][i],
    volatility: VOLS[i],
  }));
}
const cov = (c = 0.3): number[][] =>
  VOLS.map((vi, i) => VOLS.map((vj, j) => (i === j ? vi * vi : c * vi * vj)));

const CALM = { vix: 16, yieldSpread: 0.8, creditSpread: 2.5, move: 90, dxyTrend: 0, btcVol: 0.5, m2Growth: 3, wtiOil: 70 };
const PANIC = { vix: 45, yieldSpread: -0.5, creditSpread: 6.5, move: 160, dxyTrend: 0.03, btcVol: 0.9, m2Growth: -1, wtiOil: 115 };

function input(extra?: Record<string, unknown>) {
  return {
    assets: assets(),
    correlationMatrix: cov(0.3),
    macro: CALM,
    covMatrix: cov(0.3),
    portfolioDrawdown: 0,
    portfolioRealizedVol: 0.22,
    bypassHysteresis: true,
    ...extra,
  } as Parameters<typeof runOlympusEngine>[0];
}
const allocs = (o: ReturnType<typeof runOlympusEngine>) => o.allocations.map(a => a.finalAllocation);
const DEF = { volTarget: true, killSwitch: true };

describe("CORE-DEF — retrocompatibilidad (nada cambia si no se pide)", () => {
  test("el perfil sigue siendo opt-in: OLYMPUS_CORE.enabled=false", () => {
    expect(OLYMPUS_CORE.enabled).toBe(false);
  });

  test("coreMode sin coreDefensive == coreMode con coreDefensive vacío o a false (bit a bit)", () => {
    const base = runOlympusEngine(input({ coreMode: true }));
    for (const cd of [{}, { volTarget: false, killSwitch: false }, undefined]) {
      const o = runOlympusEngine(input({ coreMode: true, coreDefensive: cd }));
      expect(JSON.stringify(o.allocations)).toBe(JSON.stringify(base.allocations));
      expect(o.totalInvested).toBe(base.totalInvested);
      expect(o.volTargetMultiplier).toBe(1);
      expect(o.tailRiskOverlay).toBe(1);
    }
  });

  test("coreDefensive SIN coreMode no hace nada: la ruta legacy queda intacta", () => {
    const legacy = runOlympusEngine(input({ drawdown: undefined, portfolioDrawdown: -0.14, macro: PANIC }));
    const withFlag = runOlympusEngine(input({ portfolioDrawdown: -0.14, macro: PANIC, coreDefensive: DEF }));
    expect(JSON.stringify(withFlag.allocations)).toBe(JSON.stringify(legacy.allocations));
    expect(withFlag.totalInvested).toBe(legacy.totalInvested);
    expect(withFlag.tailRiskOverlay).toBe(legacy.tailRiskOverlay);
    expect(withFlag.volTargetMultiplier).toBe(legacy.volTargetMultiplier);
  });
});

// Escenario que SOLO dispara la rama ELEVATED de tailRisk (VIX>30 y stressScore>=7, spread<3,5):
// es la única rama que depende de stressScore, que CORE-DEF fija a 0 (como la ablación V4).
const ELEVATED_ONLY = { vix: 32, yieldSpread: -0.5, creditSpread: 3.0, move: 180, dxyTrend: 0.03, btcVol: 0.9, m2Growth: -1, wtiOil: 130 };

describe("CORE-DEF — la rama ELEVATED (stressScore) y la fuga a la ruta legacy", () => {
  test("precondición: en legacy el escenario dispara ELEVATED (overlay 0,60)", () => {
    const o = runOlympusEngine(input({ macro: ELEVATED_ONLY }));
    expect(o.tailRiskOverlay).toBeCloseTo(0.6, 10);
  });

  test("coreDefensive sin coreMode no altera esa rama en legacy (bit a bit)", () => {
    const a = runOlympusEngine(input({ macro: ELEVATED_ONLY }));
    const b = runOlympusEngine(input({ macro: ELEVATED_ONLY, coreDefensive: DEF }));
    expect(b.tailRiskOverlay).toBe(a.tailRiskOverlay);
    expect(JSON.stringify(b.allocations)).toBe(JSON.stringify(a.allocations));
    expect(b.totalInvested).toBe(a.totalInvested);
  });

  test("diseño documentado: CORE-DEF fija stressScore=0, así que ELEVATED no se dispara", () => {
    const o = runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, macro: ELEVATED_ONLY, portfolioRealizedVol: 0.15 }));
    expect(o.tailRiskOverlay).toBe(1);
  });
});

describe("CORE-DEF — comportamiento protector (B7)", () => {
  test("mercado tranquilo: exposición plena y sin Kill Switch", () => {
    const o = runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, portfolioRealizedVol: 0.15 }));
    expect(o.meta.coreMode).toBe(true);
    expect(o.killSwitchLevel).toBe(0);
    expect(o.tailRiskOverlay).toBe(1);
    expect(o.totalInvested).toBeCloseTo(1.0, 10);
  });

  test("drawdown ≥ 12% → overlay < 1 y exposición total < 1", () => {
    const o = runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, portfolioDrawdown: -0.14, portfolioRealizedVol: 0.15 }));
    expect(o.killSwitchLevel).toBeGreaterThan(0);
    expect(o.tailRiskOverlay).toBeLessThan(1);
    expect(o.totalInvested).toBeLessThan(1);
  });

  test("más drawdown → más protección (monótono)", () => {
    const at = (dd: number) =>
      runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, portfolioDrawdown: dd, portfolioRealizedVol: 0.15 })).totalInvested;
    expect(at(-0.14)).toBeGreaterThanOrEqual(at(-0.20));
    expect(at(-0.20)).toBeGreaterThanOrEqual(at(-0.30));
    expect(at(-0.30)).toBeLessThan(1);
  });

  test("VIX 45 + spread 6,5 reduce la exposición aunque no haya drawdown", () => {
    const o = runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, macro: PANIC, portfolioRealizedVol: 0.15 }));
    expect(o.tailRiskActive).toBe(true);
    expect(o.totalInvested).toBeLessThan(1);
  });

  test("vol target: volatilidad realizada muy por encima del objetivo reduce el multiplicador", () => {
    const calmVol = runOlympusEngine(input({ coreMode: true, coreDefensive: { volTarget: true }, portfolioRealizedVol: 0.15 }));
    const hotVol = runOlympusEngine(input({ coreMode: true, coreDefensive: { volTarget: true }, portfolioRealizedVol: 0.45 }));
    expect(calmVol.volTargetMultiplier).toBeGreaterThanOrEqual(1);
    expect(hotVol.volTargetMultiplier).toBeLessThan(1);
    expect(hotVol.totalInvested).toBeLessThan(calmVol.totalInvested);
  });

  test("los dos interruptores son independientes", () => {
    const onlyVt = runOlympusEngine(input({ coreMode: true, coreDefensive: { volTarget: true }, portfolioDrawdown: -0.25, portfolioRealizedVol: 0.15 }));
    expect(onlyVt.tailRiskOverlay).toBe(1);          // KS apagado: el drawdown no actúa
    const onlyKs = runOlympusEngine(input({ coreMode: true, coreDefensive: { killSwitch: true }, portfolioDrawdown: -0.25, portfolioRealizedVol: 0.45 }));
    expect(onlyKs.volTargetMultiplier).toBe(1);      // VT apagado: la volatilidad no actúa
    expect(onlyKs.tailRiskOverlay).toBeLessThan(1);  // KS encendido: el drawdown sí
  });

  test("sigue siendo HRP puro: los pesos relativos no dependen de coreDefensive", () => {
    const rel = (cd?: unknown) => {
      const o = runOlympusEngine(input({ coreMode: true, coreDefensive: cd }));
      const tot = allocs(o).reduce((s, x) => s + x, 0) || 1;
      return allocs(o).map(x => x / tot);
    };
    const a = rel(undefined), b = rel(DEF);
    a.forEach((x, i) => expect(b[i]).toBeCloseTo(x, 10));
  });

  test("determinismo bit a bit del perfil", () => {
    const a = runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, portfolioDrawdown: -0.14 }));
    const b = runOlympusEngine(input({ coreMode: true, coreDefensive: DEF, portfolioDrawdown: -0.14 }));
    expect(JSON.stringify(a.allocations)).toBe(JSON.stringify(b.allocations));
    expect(a.totalInvested).toBe(b.totalInvested);
  });
});
