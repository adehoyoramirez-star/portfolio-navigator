// ============================================================
// src/test/dataQualityPolicy.test.ts
// FIX-DATAQUALITY (Ago-2026, Comité) — política aprobada:
//   1. Uranio (uraniumSpot/uraniumLT) stale → undefined.
//   2. WLG P/E primario stale → BLOQUEO de frontera (sin RSI-W-only ni CAPE-proxy).
//   3. WLG EPS Growth stale → undefined (solo se elimina el modificador PEG).
// Se valida en la FRONTERA (applyCycleDataQuality), sin tocar la matemática
// interna de los detectores.
// ============================================================
import { describe, test, expect } from "vitest";
import { applyCycleDataQuality } from "../lib/dataQuality";
import { detectCycleTops } from "../core/risk/cycleTopDetector";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // timestamp fijo

function wlg(inp: { wlgRsiWeekly?: number; wlgPERatio?: number; wlgEpsGrowth?: number; wlgCAPE?: number }) {
  return detectCycleTops({
    bondYield10y: 4.0,
    wlgRsiWeekly: inp.wlgRsiWeekly,
    wlgPERatio: inp.wlgPERatio,
    wlgEpsGrowth: inp.wlgEpsGrowth,
    wlgCAPE: inp.wlgCAPE,
  }).signals.find(s => s.ticker === "0P00000WLG.F")!;
}

describe("applyCycleDataQuality — Uranio (stale → undefined)", () => {
  test("uraniumSpot stale se degrada a undefined; LT fresco se conserva", () => {
    const out = applyCycleDataQuality(
      { uraniumSpot: 95, uraniumLT: 86 },
      { uraniumSpot: NOW - 30 * DAY, uraniumLT: NOW },
      NOW,
    );
    expect(out.stale).toContain("uraniumSpot");
    expect(out.uraniumSpot).toBeUndefined();
    expect(out.uraniumLT).toBe(86);
  });

  test("uraniumLT stale se degrada a undefined; spot fresco se conserva", () => {
    const out = applyCycleDataQuality(
      { uraniumSpot: 95, uraniumLT: 86 },
      { uraniumSpot: NOW, uraniumLT: NOW - 30 * DAY },
      NOW,
    );
    expect(out.stale).toContain("uraniumLT");
    expect(out.uraniumLT).toBeUndefined();
    expect(out.uraniumSpot).toBe(95);
  });

  test("uranio fresco no se degrada", () => {
    const out = applyCycleDataQuality(
      { uraniumSpot: 95, uraniumLT: 86 },
      { uraniumSpot: NOW, uraniumLT: NOW },
      NOW,
    );
    expect(out.stale).toEqual([]);
    expect(out.uraniumSpot).toBe(95);
    expect(out.uraniumLT).toBe(86);
  });
});

describe("applyCycleDataQuality — WLG P/E (bloqueo de frontera)", () => {
  test("wlgPERatio stale bloquea P/E + RSI-W + CAPE (sin fallback)", () => {
    const out = applyCycleDataQuality(
      { wlgPERatio: 19.1, wlgRsiWeekly: 82, wlgCAPE: 40.5 },
      { wlgPERatio: NOW - 100 * DAY, wlgRsiWeekly: NOW },
      NOW,
    );
    expect(out.stale).toContain("wlgPERatio");
    expect(out.wlgPERatio).toBeUndefined();
    expect(out.wlgRsiWeekly).toBeUndefined();
    expect(out.wlgCAPE).toBeUndefined();
    expect(out.blocked).toContain("wlgRsiWeekly");
    expect(out.blocked).toContain("wlgCAPE");
  });

  test("wlgPERatio fresco NO bloquea (sin falso positivo)", () => {
    const out = applyCycleDataQuality(
      { wlgPERatio: 19.1, wlgRsiWeekly: 82, wlgCAPE: 40.5 },
      { wlgPERatio: NOW, wlgRsiWeekly: NOW },
      NOW,
    );
    expect(out.stale).toEqual([]);
    expect(out.blocked).toEqual([]);
    expect(out.wlgPERatio).toBe(19.1);
    expect(out.wlgRsiWeekly).toBe(82);
    expect(out.wlgCAPE).toBe(40.5);
  });

  test("INTEGRACIÓN: P/E stale NO genera trim vía RSI-W-only", () => {
    // RSI-W 82 solo (sin P/E) daría CAUTION. Con P/E stale → bloqueo → SAFE/trim 0%.
    const dq = applyCycleDataQuality(
      { wlgPERatio: 19.1, wlgRsiWeekly: 82, wlgCAPE: undefined },
      { wlgPERatio: NOW - 100 * DAY, wlgRsiWeekly: NOW },
      NOW,
    );
    const s = wlg({ wlgRsiWeekly: dq.wlgRsiWeekly, wlgPERatio: dq.wlgPERatio, wlgCAPE: dq.wlgCAPE });
    expect(s.zone).toBe("SAFE");
    expect(s.trimPct).toBe(0);
    expect(s.shouldTrim).toBe(false);
  });

  test("INTEGRACIÓN: P/E stale NO genera trim vía CAPE-proxy", () => {
    // CAPE 40.5 sin P/E (fallback) daría EXTREME. Con P/E stale → bloqueo → SAFE/trim 0%.
    const dq = applyCycleDataQuality(
      { wlgPERatio: 19.1, wlgRsiWeekly: undefined, wlgCAPE: 40.5 },
      { wlgPERatio: NOW - 100 * DAY },
      NOW,
    );
    const s = wlg({ wlgRsiWeekly: dq.wlgRsiWeekly, wlgPERatio: dq.wlgPERatio, wlgCAPE: dq.wlgCAPE });
    expect(s.zone).toBe("SAFE");
    expect(s.trimPct).toBe(0);
    expect(s.shouldTrim).toBe(false);
  });
});

describe("applyCycleDataQuality — WLG EPS Growth (solo elimina PEG)", () => {
  test("wlgEpsGrowth stale → undefined, P/E fresco se conserva", () => {
    const out = applyCycleDataQuality(
      { wlgPERatio: 19.1, wlgEpsGrowth: 38 },
      { wlgPERatio: NOW, wlgEpsGrowth: NOW - 100 * DAY },
      NOW,
    );
    expect(out.stale).toContain("wlgEpsGrowth");
    expect(out.wlgEpsGrowth).toBeUndefined();
    expect(out.wlgPERatio).toBe(19.1);
  });

  test("INTEGRACIÓN: EPS Growth stale solo quita el PEG (P/E sigue puntuando)", () => {
    const dq = applyCycleDataQuality(
      { wlgPERatio: 19.1, wlgEpsGrowth: 38, wlgRsiWeekly: 56 },
      { wlgPERatio: NOW, wlgEpsGrowth: NOW - 100 * DAY, wlgRsiWeekly: NOW },
      NOW,
    );
    expect(dq.wlgEpsGrowth).toBeUndefined();

    // Resultado degradado debe ser EXACTAMENTE el caso "sin PEG".
    const withPeg = wlg({ wlgPERatio: 19.1, wlgEpsGrowth: 38, wlgRsiWeekly: 56 });
    const noPeg = wlg({ wlgPERatio: 19.1, wlgEpsGrowth: undefined, wlgRsiWeekly: 56 });
    const degraded = wlg({ wlgPERatio: dq.wlgPERatio, wlgEpsGrowth: dq.wlgEpsGrowth, wlgRsiWeekly: dq.wlgRsiWeekly });

    // Sin el relief PEG (×0.70), el trim es mayor.
    expect(withPeg.trimPct).toBeLessThan(noPeg.trimPct);
    // Y el degradado equivale al "sin PEG" (no toca nada más).
    expect(degraded.trimPct).toBe(noPeg.trimPct);
    expect(degraded.zone).toBe(noPeg.zone);
  });
});

describe("applyCycleDataQuality — no degrada lo no-stale", () => {
  test("todo fresco → stale y blocked vacíos, valores intactos", () => {
    const out = applyCycleDataQuality(
      { uraniumSpot: 95, uraniumLT: 86, wlgPERatio: 19.1, wlgEpsGrowth: 38, wlgRsiWeekly: 82, wlgCAPE: 40.5 },
      { uraniumSpot: NOW, uraniumLT: NOW, wlgPERatio: NOW, wlgEpsGrowth: NOW, wlgRsiWeekly: NOW },
      NOW,
    );
    expect(out.stale).toEqual([]);
    expect(out.blocked).toEqual([]);
    expect(out.uraniumSpot).toBe(95);
    expect(out.wlgPERatio).toBe(19.1);
    expect(out.wlgCAPE).toBe(40.5);
  });
});
