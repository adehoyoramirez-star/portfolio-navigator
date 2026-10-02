// FASE 3B · CORRECCIÓN 2 — evento de de-risking (>5 pp de caída de Σtarget) fuera de cadencia.
import { describe, test, expect } from "vitest";
import {
  detectDeRiskEvent, totalTarget, DERISK_EVENT_CONFIG,
  computeRebalanceSuggestions, type RebalanceAsset,
} from "../core/portfolio/rebalancer";

const TICKERS = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];

describe("CORRECCIÓN 2 — detectDeRiskEvent", () => {
  test("umbral fijo = 5 pp", () => {
    expect(DERISK_EVENT_CONFIG.THRESHOLD_PP).toBe(0.05);
  });

  test("COVID (100% → 57.1%) dispara el evento", () => {
    expect(detectDeRiskEvent(1.0, 0.571)).toBe(true);
  });

  test("caída pequeña (<5 pp) NO dispara", () => {
    expect(detectDeRiskEvent(1.0, 0.98)).toBe(false);
    expect(detectDeRiskEvent(1.0, 0.951)).toBe(false);
  });

  test("exactamente 5 pp NO dispara (estrictamente mayor)", () => {
    expect(detectDeRiskEvent(1.0, 0.95)).toBe(false);
    expect(detectDeRiskEvent(1.0, 0.949)).toBe(true);
  });

  test("totalTarget suma solo pesos positivos finitos", () => {
    expect(totalTarget({ a: 0.2, b: 0.3, c: 0 })).toBeCloseTo(0.5, 10);
    expect(totalTarget({ a: 0.2, b: NaN, c: -0.1 })).toBeCloseTo(0.2, 10);
  });
});

describe("CORRECCIÓN 2 — el evento genera órdenes de venta hacia el nuevo objetivo", () => {
  test("COVID 2020-02-28: targets bajan a 57.1% → SELL en todos los activos sobreponderados", () => {
    const pv = 100_000;
    const assets: RebalanceAsset[] = TICKERS.map(t => ({
      ticker: t, name: t, price: 100, shares: pv / TICKERS.length / 100, targetAllocation: 0.571 / TICKERS.length,
    }));
    const out = computeRebalanceSuggestions(assets, 0, pv, 0.02);
    expect(out.sellSuggestions.length).toBe(TICKERS.length);
    expect(out.totalProceeds).toBeGreaterThan(0);
  });

  test("sin evento (targets ya en peso) → no hay ventas", () => {
    const pv = 100_000;
    const assets: RebalanceAsset[] = TICKERS.map(t => ({
      ticker: t, name: t, price: 100, shares: pv / TICKERS.length / 100, targetAllocation: 1 / TICKERS.length,
    }));
    const out = computeRebalanceSuggestions(assets, 0, pv, 0.02);
    expect(out.sellSuggestions.length).toBe(0);
  });
});
