// ============================================================
// Sombra CORE-DEF (observabilidad, preregistro CORE-DEF §6): el motor v5.3 emite además lo que haría
// CORE + vol target + Kill Switch. Garantías: no cambia el resultado principal, no se anida,
// con coreMode no se emite, y reacciona al drawdown como el perfil real.
// ============================================================
import { describe, test, expect } from "vitest";
import { runOlympusEngine, type AssetInput } from "../core/engine/olympusV3";

const VOLS = [0.60, 0.18, 0.14, 0.25, 0.20, 0.15];
const assets = (): AssetInput[] =>
  ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"].map((t, i) => ({
    name: t, ticker: t,
    returns12m: [0.45, 0.06, 0.12, 0.20, 0.10, 0.09][i], returns3m: [0.08, 0.02, 0.03, 0.05, 0.02, 0.02][i],
    returns1m: [0.02, 0.01, 0.01, 0.02, 0.01, 0.01][i], earningsYield: [0, 0.05, 0, 0.02, 0.04, 0.05][i], volatility: VOLS[i],
  }));
const cov = (c = 0.3) => VOLS.map((a, i) => VOLS.map((b, j) => (i === j ? a * a : c * a * b)));
const CALM = { vix: 16, yieldSpread: 0.8, creditSpread: 2.5, move: 90, dxyTrend: 0, btcVol: 0.5, m2Growth: 3, wtiOil: 70 };
const inp = (extra?: Record<string, unknown>) =>
  ({ assets: assets(), correlationMatrix: cov(), macro: CALM, covMatrix: cov(), portfolioDrawdown: 0, portfolioRealizedVol: 0.15, bypassHysteresis: true, ...extra }) as Parameters<typeof runOlympusEngine>[0];

describe("sombra CORE-DEF", () => {
  test("el motor v5.3 la emite con asignaciones, exposición y estado del Kill Switch", () => {
    const o = runOlympusEngine(inp());
    const s = o.meta.coreDefShadow;
    expect(s).toBeTruthy();
    expect(s!.allocations.length).toBe(6);
    expect(s!.totalInvested).toBeGreaterThan(0);
    expect(s!.killSwitchLevel).toBe(0);
    expect(s!.tailRiskOverlay).toBe(1);
  });

  test("no altera el resultado principal (bit a bit frente a la sombra CORE ya existente)", () => {
    const a = runOlympusEngine(inp());
    const b = runOlympusEngine(inp({ coreShadowMode: true })); // sin sombras: referencia del principal
    expect(JSON.stringify(a.allocations)).toBe(JSON.stringify(b.allocations));
    expect(a.totalInvested).toBe(b.totalInvested);
  });

  test("no se anida: coreShadowMode=true y coreMode=true no la emiten", () => {
    expect(runOlympusEngine(inp({ coreShadowMode: true })).meta.coreDefShadow).toBeUndefined();
    expect(runOlympusEngine(inp({ coreMode: true })).meta.coreDefShadow).toBeUndefined();
  });

  test("con drawdown ≥ 12% la sombra CORE-DEF reduce exposición y la sombra CORE no", () => {
    const o = runOlympusEngine(inp({ portfolioDrawdown: -0.14 }));
    expect(o.meta.coreDefShadow!.totalInvested).toBeLessThan(o.meta.coreShadow!.totalInvested);
    expect(o.meta.coreDefShadow!.killSwitchLevel).toBeGreaterThan(0);
  });

  test("sin drawdown ni estrés coincide con la sombra CORE (mismos pesos relativos)", () => {
    const o = runOlympusEngine(inp());
    const rel = (x: { allocations: { finalAllocation: number }[] }) => {
      const t = x.allocations.reduce((s, v) => s + v.finalAllocation, 0) || 1;
      return x.allocations.map(v => v.finalAllocation / t);
    };
    rel(o.meta.coreDefShadow!).forEach((w, i) => expect(w).toBeCloseTo(rel(o.meta.coreShadow!)[i], 10));
  });
});
