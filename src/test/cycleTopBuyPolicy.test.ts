// ============================================================
// Política de veto de compra por techo de ciclo (Oct-2026)
// El objetivo del motor ya lleva allocationMultiplier; el veto duro solo vale en DANGER/EXTREME.
// Antes: cualquier shouldTrim=true (P/E 16,1 o RSI 75,1) congelaba las compras de World.
// ============================================================
import { describe, test, expect } from "vitest";
import { computeRebalanceSuggestions, type RebalanceAsset } from "../core/portfolio/rebalancer";
import { isCycleTopBuyVeto, CYCLE_TOP_BUY_POLICY } from "../core/config/engineConfig";
import { detectCycleTops } from "../core/risk/cycleTopDetector";

const WLG = "0P00000WLG.F";
const sig = (zone: "SAFE" | "CAUTION" | "DANGER" | "EXTREME", mult: number, trim = true) => ({
  asset: "World", ticker: WLG, allocationMultiplier: mult, zone, reason: "", indicator: "", indicatorValue: "",
  shouldTrim: trim, trimPct: Math.round((1 - mult) * 100),
});
const world = (): RebalanceAsset => ({ ticker: WLG, name: "World", price: 10, shares: 100, targetAllocation: 0.30 });
const NAV = 10_000;

describe("isCycleTopBuyVeto", () => {
  test("solo DANGER y EXTREME con shouldTrim vetan", () => {
    expect(CYCLE_TOP_BUY_POLICY.vetoZones).toEqual(["DANGER", "EXTREME"]);
    expect(isCycleTopBuyVeto(sig("CAUTION", 0.6))).toBe(false);
    expect(isCycleTopBuyVeto(sig("DANGER", 0.3))).toBe(true);
    expect(isCycleTopBuyVeto(sig("EXTREME", 0.15))).toBe(true);
    expect(isCycleTopBuyVeto(sig("SAFE", 1, false))).toBe(false);
    expect(isCycleTopBuyVeto(sig("DANGER", 0.3, false))).toBe(false); // sin shouldTrim no veta
    expect(isCycleTopBuyVeto(undefined)).toBe(false);
    expect(isCycleTopBuyVeto(null)).toBe(false);
  });
});

describe("rebalanceador: CAUTION ya no congela una compra infraponderada", () => {
  test("World infraponderado con CAUTION (mult 0,58) → compra hasta su objetivo", () => {
    const out = computeRebalanceSuggestions([world()], 2_000, NAV, 0.02, [sig("CAUTION", 0.58)], []);
    expect(out.buySuggestions).toHaveLength(1);
    expect(out.buySuggestions[0].ticker).toBe(WLG);
    expect(out.buySuggestions[0].cost).toBeGreaterThan(0);
  });
  test("con DANGER sigue sin comprar", () => {
    const out = computeRebalanceSuggestions([world()], 2_000, NAV, 0.02, [sig("DANGER", 0.3)], []);
    expect(out.buySuggestions).toHaveLength(0);
  });
  test("con EXTREME sigue sin comprar", () => {
    const out = computeRebalanceSuggestions([world()], 2_000, NAV, 0.02, [sig("EXTREME", 0.15)], []);
    expect(out.buySuggestions).toHaveLength(0);
  });
  test("sin señal: comportamiento intacto (compra)", () => {
    const out = computeRebalanceSuggestions([world()], 2_000, NAV, 0.02, [], []);
    expect(out.buySuggestions).toHaveLength(1);
  });
  test("el recorte (SELL) por sobrepeso con CAUTION no cambia", () => {
    const heavy: RebalanceAsset = { ticker: WLG, name: "World", price: 10, shares: 500, targetAllocation: 0.10 };
    const out = computeRebalanceSuggestions([heavy], 0, NAV, 0.02, [sig("CAUTION", 0.58)], []);
    expect(out.sellSuggestions.length).toBe(1);
    expect(out.buySuggestions).toHaveLength(0);
  });
});

describe("el caso real: P/E forward de World entre 16 y 22 ya no bloquea compras", () => {
  test.each([16.1, 19, 20, 22])("P/E %s → CAUTION, no veto", pe => {
    const s = detectCycleTops({ bondYield10y: 4, wlgPERatio: pe, creditSpread: 2.5 }).signals.find(x => x.ticker === WLG)!;
    expect(s.shouldTrim).toBe(true);
    expect(s.zone).toBe("CAUTION");
    expect(isCycleTopBuyVeto(s)).toBe(false);
  });
});

describe("la política vale para todos los activos, no solo World", () => {
  test("BTC infraponderado con CAUTION también compra hasta su objetivo reducido; con DANGER no", () => {
    const btc = (): RebalanceAsset => ({ ticker: "BTC-EUR", name: "Bitcoin", price: 100, shares: 10, targetAllocation: 0.30 });
    const s = (zone: "CAUTION" | "DANGER", m: number) => ({ ...sig(zone, m), ticker: "BTC-EUR", asset: "Bitcoin" });
    expect(computeRebalanceSuggestions([btc()], 2_000, NAV, 0.02, [s("CAUTION", 0.6)], []).buySuggestions).toHaveLength(1);
    expect(computeRebalanceSuggestions([btc()], 2_000, NAV, 0.02, [s("DANGER", 0.3)], []).buySuggestions).toHaveLength(0);
  });
});
