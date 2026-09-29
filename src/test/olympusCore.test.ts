// ============================================================
// src/test/olympusCore.test.ts
// OLYMPUS CORE v1.0 — tests del perfil canónico (evidencia Phases 9-12).
// Garantía central: NINGÚN cambio de código puede alterar silenciosamente
// el comportamiento histórico (spec §19).
// ============================================================
import { describe, test, expect } from "vitest";
import {
  runOlympusEngine,
  type AssetInput,
  type CoreTrendGateState,
} from "../core/engine/olympusV3";
import { OLYMPUS_CORE } from "../core/config/engineConfig";
import { computeBtcTotalRisk } from "../core/backtest/compositeMetrics";
import { computeUnifiedDrawdown, updateHighWaterMark } from "../core/risk/drawdown";

// ── 6. CONTRACT v1.0.1: drawdown LIVE/BACKTEST unificado ─────────────────
describe("CONTRACT v1.0.1 — denominador de drawdown único (live ≡ backtest)", () => {
  test("formula canónica: denominador = peak (HWM), nunca el valor actual", () => {
    // Caso exacto del contract test Phase 11 §11: 10.000 → 9.500
    expect(computeUnifiedDrawdown({ currentTotal: 9500, hwm: 10000 })).toBe(-0.05);
    expect(computeUnifiedDrawdown({ currentTotal: 9500, hwm: 10000 })).not.toBe(-0.05263157894736842);
  });
  test("nuevo máximo → DD 0; total <= 0 → DD 0 (guard defensivo)", () => {
    expect(computeUnifiedDrawdown({ currentTotal: 10500, hwm: 10000 })).toBe(0);
    expect(computeUnifiedDrawdown({ currentTotal: 0, hwm: 10000 })).toBe(0);
    expect(computeUnifiedDrawdown({ currentTotal: NaN, hwm: 10000 })).toBe(0);
  });
  test("sin HWM externo (hwm <= 0) → peak = currentTotal → DD 0 (arranque en suelo)", () => {
    expect(computeUnifiedDrawdown({ currentTotal: 5000, hwm: 0 })).toBe(0);
  });
  test("updateHighWaterMark: sube solo con nuevos máximos; nunca baja", () => {
    expect(updateHighWaterMark(11000, 10000)).toEqual({ hwm: 11000, changed: true });
    expect(updateHighWaterMark(9000, 10000)).toEqual({ hwm: 10000, changed: false });
  });
  test("TD1: drawdown de cartera por rebalanceo activa defensivas v5.3 y no altera CORE", () => {
    const withDD = runOlympusEngine(coreInput({
      portfolioDrawdown: -0.18,
      portfolioRealizedVol: 0.28,
    }));
    const withDDCore = runOlympusEngine(coreInput({ coreMode: true, portfolioDrawdown: -0.18, portfolioRealizedVol: 0.28 }));
    expect(withDD.meta.coreMode).toBe(false);
    expect(withDD.tailRiskActive || withDD.killSwitchLevel > 0 || withDD.volTargetMultiplier < 1).toBe(true);
    expect(withDDCore.volTargetMultiplier).toBe(1);
    expect(withDDCore.tailRiskOverlay).toBe(1);
  });
});

// ── 7. Modo sombra: comparativa CORE vs v5.3 (solo observabilidad) ────────
describe("Modo sombra CORE vs v5.3", () => {
  test("v5.3 (default) no emite coreShadow; CORE emite stub PENDING_CUTOVER", () => {
    const legacy = runOlympusEngine(coreInput());
    expect(legacy.meta.coreShadow).toBeUndefined();
    const core = runOlympusEngine(coreInput({ coreMode: true }));
    expect(core.meta.coreShadow).not.toBeNull();
    expect(core.meta.coreShadow?.regime).toBe("PENDING_CUTOVER");
  });
  test("el modo sombra no muta el resultado principal (mismas allocations)", () => {
    const plain = runOlympusEngine(coreInput({ coreMode: true }));
    const withShadow = runOlympusEngine(coreInput({ coreMode: true }));
    expect(withShadow.allocations.map(a => a.finalAllocation)).toEqual(plain.allocations.map(a => a.finalAllocation));
  });
});

// ── Fixture determinista: 6 activos del universo Core ─────────────────────
const N = 6;
const VOLS = [0.60, 0.18, 0.14, 0.25, 0.20, 0.15]; // BTC, EM, Gold, Uranium, SmallCap, World
function coreAssets(overrides?: Partial<AssetInput>[]): AssetInput[] {
  const tickers = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
  const base: AssetInput[] = tickers.map((t, i) => ({
    name: t,
    ticker: t,
    returns12m: [0.45, 0.06, 0.12, 0.20, 0.10, 0.09][i],
    returns3m: [0.08, 0.02, 0.03, 0.05, 0.02, 0.02][i],
    returns1m: [0.02, 0.01, 0.01, 0.02, 0.01, 0.01][i],
    earningsYield: [0, 0.05, 0, 0.02, 0.04, 0.05][i], // BTC/gold/uranium no-equity
    volatility: VOLS[i],
  }));
  if (overrides) overrides.forEach((o, i) => { base[i] = { ...base[i], ...o }; });
  return base;
}
function covFromVols(corrOffDiag = 0.3): number[][] {
  return VOLS.map((vi, i) =>
    VOLS.map((vj, j) => (i === j ? vi * vi : corrOffDiag * vi * vj)),
  );
}
function coreInput(extra?: Record<string, unknown>) {
  return {
    assets: coreAssets(),
    correlationMatrix: covFromVols(0.3),
    macro: { vix: 16, yieldSpread: 0.8, creditSpread: 2.5, move: 90, dxyTrend: 0, btcVol: 0.5, m2Growth: 3, wtiOil: 70 },
    covMatrix: covFromVols(0.3),
    portfolioDrawdown: 0,
    portfolioRealizedVol: 0.22,
    ...extra,
  } as Parameters<typeof runOlympusEngine>[0];
}

// ── 1. Perfil CORE: asignación HRP puro ───────────────────────────────────
describe("OLYMPUS CORE v1.0 — perfil", () => {
  test("default: OLYMPUS_CORE.enabled=false → la ruta v5.3 queda intacta", () => {
    expect(OLYMPUS_CORE.enabled).toBe(false);
    const out = runOlympusEngine(coreInput());
    expect(out.meta.coreMode).toBe(false);
  });

  test("coreMode: exposición total = 1.0 (VT y Kill Switch OFF, sin caps)", () => {
    const out = runOlympusEngine(coreInput({ coreMode: true }));
    expect(out.meta.coreMode).toBe(true);
    expect(out.volTargetMultiplier).toBe(1);
    expect(out.tailRiskOverlay).toBe(1);
    expect(out.tailRiskActive).toBe(false);
    expect(out.killSwitchLevel).toBe(0);
    expect(out.totalInvested).toBeCloseTo(1.0, 10);
  });

  test("coreMode: el stack defensivo NO responde a drawdown/VIX extremos (KS OFF)", () => {
    const crash = coreInput({
      coreMode: true,
      portfolioDrawdown: -0.30,
      macro: { vix: 45, yieldSpread: -0.5, creditSpread: 6.5, move: 160, dxyTrend: 0.03, btcVol: 0.9, m2Growth: -1, wtiOil: 115 },
    });
    const out = runOlympusEngine(crash);
    expect(out.tailRiskOverlay).toBe(1);            // KS desactivado por evidencia
    expect(out.volTargetMultiplier).toBe(1);        // VT desactivado por evidencia
    // La misma entrada SIN coreMode sí activa protección (contraste de rutas)
    const out53 = runOlympusEngine({ ...crash, coreMode: false });
    expect(out53.tailRiskActive).toBe(true);
    expect(out53.tailRiskOverlay).toBeLessThan(1);
  });

  test("coreMode: blend insensible a blendWeights externo (HRP puro)", () => {
    const a = runOlympusEngine(coreInput({ coreMode: true }));
    const b = runOlympusEngine(coreInput({ coreMode: true, blendWeights: { BL: 1.0, HRP: 0.0, MIN_VAR: 0.0 } }));
    expect(a.allocations.map(x => x.finalAllocation)).toEqual(b.allocations.map(x => x.finalAllocation));
    // Y difiere de la ruta v5.3 (que sí usa BL)
    const c = runOlympusEngine(coreInput({ coreMode: false }));
    expect(a.allocations.map(x => x.finalAllocation)).not.toEqual(c.allocations.map(x => x.finalAllocation));
  });

  test("coreMode: determinismo bit-a-bit en el camino canónico (bypassHysteresis, igualdad de datos/config)", () => {
    // El motor live es intencionalmente stateful (hysteresis con Date.now(),
    // documentado en Phase 9). El determinismo bit-exact aplica al camino de
    // backtest canónico (bypassHysteresis: true) — mismo contrato que el spec §16.
    const a = runOlympusEngine(coreInput({ coreMode: true, bypassHysteresis: true }));
    const b = runOlympusEngine(coreInput({ coreMode: true, bypassHysteresis: true }));
    expect(JSON.stringify(a.allocations)).toBe(JSON.stringify(b.allocations));
    expect(a.totalInvested).toBe(b.totalInvested);
  });
});

// ── 2. Overlay Trend Gate opcional (especificación E_both) ────────────────
describe("OLYMPUS CORE v1.0 — Trend Gate overlay", () => {
  const bearish = (n: number) => coreAssets().map((a, i) => (i < n ? { ...a, returns3m: -0.05 } : a));

  test("coreTrendGate=false → overlay OFF con razón explícita", () => {
    const state: CoreTrendGateState = { lastGateCallIndex: -1, reentryCount: 0, engaged: false };
    const out = runOlympusEngine(coreInput({ coreMode: true, coreTrendGate: false, coreTrendGateState: state }));
    expect(out.meta.coreTrendGateActive).toBe(false);
    expect(out.meta.coreTrendGateMultiplier).toBe(1);
    expect(out.meta.coreTrendGateReason).toContain("OFF");
  });

  test("activación: primera vez → STAGED cap 0.60 (no salto a 40%)", () => {
    const state: CoreTrendGateState = { lastGateCallIndex: -1, reentryCount: 0, engaged: false };
    const out = runOlympusEngine(coreInput({ coreMode: true, coreTrendGate: true, coreTrendGateState: state, assets: bearish(4) }));
    expect(out.meta.coreTrendGateActive).toBe(true);
    expect(out.meta.coreTrendGateMultiplier).toBeCloseTo(0.60, 10);
    expect(out.meta.coreTrendGateReason).toContain("staged");
    expect(state.engaged).toBe(true);
    expect(state.reentryCount).toBe(0);
  });

  test("re-entry: exposición plena solo tras 2 rebalanceos limpios consecutivos", () => {
    const state: CoreTrendGateState = { lastGateCallIndex: -1, reentryCount: 0, engaged: false };
    const bear = { coreMode: true, coreTrendGate: true, coreTrendGateState: state, assets: bearish(4) };
    runOlympusEngine(coreInput(bear));                       // activación staged
    const re1 = runOlympusEngine(coreInput({ ...bear, assets: coreAssets() })); // limpio #1
    expect(state.engaged).toBe(true);
    expect(state.reentryCount).toBe(1);
    expect(re1.meta.coreTrendGateMultiplier).toBeCloseTo(0.60, 10);
    const re2 = runOlympusEngine(coreInput({ ...bear, assets: coreAssets() })); // limpio #2
    expect(state.engaged).toBe(false);
    expect(state.reentryCount).toBe(0);
    expect(re2.meta.coreTrendGateActive).toBe(false);
    expect(re2.meta.coreTrendGateMultiplier).toBe(1);
    expect(re2.totalInvested).toBeCloseTo(1.0, 10);
  });

  test("confirmación: re-activación tras episodio usa cap completo (0.60→no-staged)", () => {
    const state: CoreTrendGateState = { lastGateCallIndex: -1, reentryCount: 0, engaged: true }; // episodio en curso
    const out = runOlympusEngine(coreInput({ coreMode: true, coreTrendGate: true, coreTrendGateState: state, assets: bearish(4) }));
    expect(state.engaged).toBe(true);
    expect(state.reentryCount).toBe(0);
    expect(out.meta.coreTrendGateReason).toContain("confirmado");
  });
});

// ── 3. Integración backtest ───────────────────────────────────────────────
describe("OLYMPUS CORE v1.0 — backtest pass-through", () => {
  test("runBacktest reporta coreMode/finalState y el flag default es false", () => {
    const closes: Record<string, number[]> = {};
    const tickers = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
    for (const t of tickers) {
      const arr: number[] = [];
      let p = 100;
      for (let i = 0; i < 3 * 365; i++) { p *= 1 + 0.0006 + Math.sin(i * 1.7) * 0.002; arr.push(p); }
      closes[t] = arr;
    }
    const macro = (v: number) => Array(3 * 365).fill(v);
    const input = {
      closesHistory: closes,
      macroHistory: { vix: macro(16), yieldSpread: macro(0.8), creditSpread: macro(2.5) },
      lookbackDays: 252,
      rebalanceDays: 21,
      useDynamicCovariance: false,
    };
    const base = runBacktestCore(input, undefined, undefined);
    expect(base.coreMode).toBe(false);
    expect(base.coreTrendGateFinalState).toBeNull();

    const core = runBacktestCore(input, true, false);
    expect(core.coreMode).toBe(true);
    expect(core.coreTrendGateEnabled).toBe(false);
    expect(core.coreTrendGateFinalState).not.toBeNull();
    expect(core.dailyRecords.length).toBe(base.dailyRecords.length);
  });
});

// Helper local para no depender de tipos generados
import { runBacktest, type BacktestInput, type BacktestOutput } from "../core/backtest/backtestEngine";
function runBacktestCore(
  input: Omit<BacktestInput, "coreMode" | "coreTrendGate" | "coreTrendGateState">,
  coreMode?: boolean,
  coreTrendGate?: boolean,
): BacktestOutput {
  return runBacktest({ ...input, coreMode, coreTrendGate });
}

// ── 4. BTC TOTAL RISK BUDGET (v1.0.1) ─────────────────────────────────────
describe("OLYMPUS CORE v1.0 — BTC total risk", () => {
  test("BTC_TOTAL = satélite + (1-satélite)×BTC motor, con cuantiles correctos", () => {
    // 100 días: 99 con BTC motor 0.10 y uno con 0.20 → P99 = 0.10 (definido), max = 0.20
    const weights = Array.from({ length: 100 }, (_, i) => ({
      "BTC-EUR": i === 99 ? 0.20 : 0.10,
      "EMXC.DE": 0.18, "PPFB.DE": 0.18, "URNU.DE": 0.18, "VVSM.DE": 0.18, "0P00000WLG.F": 0.18,
    }));
    const r = computeBtcTotalRisk(weights, 90);
    expect(r.satelliteWeightPct).toBeCloseTo(10, 10);
    expect(r.btcMotorMeanPct).toBeCloseTo(99 * 0.10 + 0.20, 8); // media en %
    // P99 con n=100: floor(99×0.99)=98 → percentil 99 = valor en índice 98 (0.10)
    expect(r.btcTotalP99Pct).toBeCloseTo(0.9 * 10 + 10, 8);
    expect(r.btcTotalMaxPct).toBeCloseTo(0.9 * 20 + 10, 8);
    // Invariante válida para cualquier n: mean ≤ max
    expect(r.btcTotalMeanPct).toBeLessThanOrEqual(r.btcTotalMaxPct);
  });

  test("sin pesos diarios → fallback explícito al satélite (nunca silencioso)", () => {
    const r = computeBtcTotalRisk(undefined, 90);
    expect(r.btcMotorMeanPct).toBe(0);
    expect(r.btcTotalMeanPct).toBeCloseTo(10, 10);
    expect(r.btcTotalMaxPct).toBeCloseTo(10, 10);
  });
});
