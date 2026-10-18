// ============================================================
// El monitor en vivo usaba DEFAULT_POSITIONS y un pico fijo de 6.622 €: con la cartera real mostraba
// "Drawdown crítico −36,5%" inexistente. syncPortfolio lo alimenta con la cartera real.
// ============================================================
import { describe, test, expect } from "vitest";
import { OlympusLiveMonitor } from "../core/monitor/liveMonitor";

const REAL = [
  { ticker: "BTC-EUR", shares: 0.0503, avgPrice: 78352, price: 72270 },
  { ticker: "EMXC.DE", shares: 39, avgPrice: 39.64, price: 39.69 },
  { ticker: "PPFB.DE", shares: 40, avgPrice: 70.22, price: 72.01 },
  { ticker: "URNU.DE", shares: 93.5, avgPrice: 21.67, price: 18.82 },
  { ticker: "VVSM.DE", shares: 14, avgPrice: 88.22, price: 89.95 },
  { ticker: "0P00000WLG.F", shares: 15.99, avgPrice: 61.76, price: 65.26 },
];
const total = (ps: typeof REAL, cash: number) => ps.reduce((s, p) => s + p.shares * p.price, 0) + cash;

describe("OlympusLiveMonitor.syncPortfolio", () => {
  test("antes de sincronizar: equity de la cartera por defecto (no la real)", () => {
    const m = new OlympusLiveMonitor();
    expect(Math.abs(m.getState().totalEquity - total(REAL, 0))).toBeGreaterThan(1000);
  });

  test("tras sincronizar: equity = posiciones reales + cash y drawdown 0 (sin −36,5% fantasma)", () => {
    const m = new OlympusLiveMonitor();
    m.syncPortfolio({ positions: REAL, cash: 1830.62 });
    const s = m.getState();
    expect(s.totalEquity).toBeCloseTo(total(REAL, 1830.62), 6);
    expect(s.drawdown.peakEquity).toBeCloseTo(s.totalEquity, 6);
    expect(s.drawdown.currentDrawdown).toBe(0);
    expect(s.positions.length).toBe(6);
    expect(s.positions.reduce((a, p) => a + p.weight, 0)).toBeLessThanOrEqual(1);
  });

  test("segunda sincronización: el pico no se reinicia y una caída real sí produce drawdown", () => {
    const m = new OlympusLiveMonitor();
    m.syncPortfolio({ positions: REAL, cash: 0 });
    const peak = m.getState().drawdown.peakEquity;
    const lower = REAL.map(p => ({ ...p, price: p.price * 0.9 }));
    m.syncPortfolio({ positions: lower, cash: 0 });
    const s = m.getState();
    expect(s.drawdown.peakEquity).toBeCloseTo(peak, 6);
    expect(s.drawdown.currentDrawdown).toBeCloseTo(0.1, 2);
  });

  test("cartera real MENOR que el pico fijo antiguo (6.622 €): drawdown 0, no −55%", () => {
    const m = new OlympusLiveMonitor();
    m.syncPortfolio({ positions: [{ ticker: "EMXC.DE", shares: 50, avgPrice: 39, price: 40 }], cash: 1000 }); // 3.000 €
    const s = m.getState();
    expect(s.totalEquity).toBeCloseTo(3000, 6);
    expect(s.drawdown.currentDrawdown).toBe(0);
    expect(s.alerts.some(a => a.message.startsWith("Drawdown"))).toBe(false);
  });

  test("una sincronización con cartera sin posiciones no rompe y deja equity = cash", () => {
    const m = new OlympusLiveMonitor();
    m.syncPortfolio({ positions: [], cash: 500 });
    expect(m.getState().totalEquity).toBe(500);
  });
});
