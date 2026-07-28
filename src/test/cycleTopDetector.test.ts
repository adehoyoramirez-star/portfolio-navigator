import { describe, test, expect } from "vitest";
import {
  applyTacticalDaily,
  detectCycleTops,
  detectCycleBottoms,
  isBTCDominanceFalling,
  type CycleTopInputs,
  type CycleTopSignal,
} from "@/core/risk/cycleTopDetector";

function makeStableHistory(d: number, p: number): number[] { return Array(d).fill(p); }
function makeCrashHistory(d: number, b: number, c: number): number[] {
  const px: number[] = []; const pre=b/(1-c);
  for (let i=0;i<d-5;i++) px.push(pre);
  for (let i=0;i<5;i++) px.push(pre*(1-c*(i/4))); return px; }

const R: [number,number][] = [[20,15],[30,10],[40,5]];
const Z: [number,number][] = [[-2.5,15],[-2.0,10],[-1.5,5]];

describe("applyTacticalDaily", () => {
  test("sin historial suficiente", () => {
    const r = applyTacticalDaily(40, [100, 101, 102], undefined, "T", R, Z);
    expect(r.score).toBe(40);
  });

  test("CRISIS guard", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "CRISIS", "T", R, Z);
    expect(r.score).toBe(40);
  });

  test("ALL_CASH guard", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "ALL_CASH", "T", R, Z);
    expect(r.score).toBe(40);
  });

  test("precios estables sin puntos", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    expect(r.score).toBe(40);
  });

  test("crash -25% genera puntos", () => {
    const h = makeCrashHistory(60, 70, 0.25);
    const r = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    expect(r.score).toBeGreaterThan(40);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});


describe("detectBTCTop", () => {
  test("BTC SAFE con Z=1.0", () => {
    const r = detectCycleTops({ mvrvZScore: 1.0, bondYield10y: 4.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("SAFE");
    expect(btc.shouldTrim).toBe(false);
  });

  test("MVRV Z >7 dispara EXTREME", () => {
    // Z=7.5 → smoothScore([5,0],[6,1],[7,3],[8,4]) = interpol(7.5, 7→3, 8→4) = 3.5
    // topSignals=3.5 → zone≥3.5=EXTREME, multiplierFromScore(3.5)=0.20
    const r = detectCycleTops({ mvrvZScore: 7.5, bondYield10y: 4.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("EXTREME");
    expect(btc.allocationMultiplier).toBeLessThan(0.55);
  });

  test("Puell >5 + Z >7 = EXTREME", () => {
    const r = detectCycleTops({ mvrvZScore: 7.2, puellMultiple: 5.5, bondYield10y: 4.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("EXTREME");
  });

  test("Z-Score primario ignora mvrvRatio", () => {
    const r = detectCycleTops({ mvrvZScore: 1.0, mvrvRatio: 7.0, bondYield10y: 4.0 });
    expect(r.signals.find(s => s.ticker === "BTC-EUR")!.zone).toBe("SAFE");
  });

  test("Fallback a mvrvRatio", () => {
    const r = detectCycleTops({ mvrvRatio: 5.0, bondYield10y: 4.0 });
    expect(r.signals.find(s => s.ticker === "BTC-EUR")!.zone).not.toBe("SAFE");
  });
});

describe("detectBTCBottom", () => {
  test("Z<0 + RSI-W 40 -> VALUE", () => {
    const r = detectCycleBottoms({ mvrvZScore: -0.5, puellMultiple: 0.8, btcRsiWeekly: 40, bondYield10y: 4.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("VALUE");
    expect(btc.attackMultiplier).toBeGreaterThanOrEqual(1.25);
  });

  test("Z<-1 + Puell<0.5 + RSI-W<30 -> EXTREME", () => {
    const r = detectCycleBottoms({ mvrvZScore: -1.5, puellMultiple: 0.3, btcRsiWeekly: 25, bondYield10y: 4.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("EXTREME");
    expect(btc.attackMultiplier).toBe(2.0);
  });

  test("Sin datos -> NEUTRAL", () => {
    const btc = detectCycleBottoms({ bondYield10y: 4.0 }).signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("NEUTRAL");
    expect(btc.shouldAccumulate).toBe(false);
  });
});


describe("applyTacticalDaily - currentPrice injection", () => {
  test("currentPrice -20%: score mayor que sin el", () => {
    const h = makeStableHistory(60, 100);
    const noCur = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    const withCur = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z, 80);
    expect(withCur.score).toBeGreaterThan(noCur.score);
  });

  test("currentPrice undefined: mismo resultado", () => {
    const h = makeCrashHistory(60, 70, 0.15);
    const r1 = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z, undefined);
    const r2 = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    expect(r1.score).toBe(r2.score);
  });

  test("currentPrice >40%: rechazado por sanity guard", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z, 30);
    const noCur = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    expect(r.score).toBe(noCur.score);
  });

  test("currentPrice = 0: rechazado", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z, 0);
    const noCur = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    expect(r.score).toBe(noCur.score);
  });

  test("currentPrice = NaN: rechazado", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z, NaN);
    const noCur = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z);
    expect(r.score).toBe(noCur.score);
  });

  test("currentPrice -8%: inyectado y genera senal", () => {
    const h = makeStableHistory(60, 100);
    const r = applyTacticalDaily(40, h, "EXPANSION", "T", R, Z, 92);
    expect(r.score).toBeGreaterThan(40);
  });
});


describe("detectCycleBottoms - Gold contradiction", () => {
  function g(zone: string, trimPct: number): any {
    return { asset: "Gold (ETC)", ticker: "PPFB.DE", allocationMultiplier: 1 - trimPct / 100, zone, reason: "t", indicator: "i", indicatorValue: "v", shouldTrim: trimPct > 0, trimPct };
  }

  test("Top CAUTION 22% + Bottom -> NEUTRAL (supresion gradual)", () => {
    const r = detectCycleBottoms({ bondYield10y: 4.7, inflationBreakeven: 2.3, brentOil: 87 }, [g("CAUTION", 22)]);
    expect(r.signals.find(s => s.ticker === "PPFB.DE")!.opportunityScore).toBeLessThan(40);
  });

  test("Top SAFE + Bottom -> sin supresion", () => {
    const inp = { bondYield10y: 2.0, inflationBreakeven: 4.0, brentOil: 100 };
    const r1 = detectCycleBottoms(inp, [g("SAFE", 0)]);
    const r2 = detectCycleBottoms(inp);
    expect(r1.signals.find(s => s.ticker === "PPFB.DE")!.opportunityScore).toBe(r2.signals.find(s => s.ticker === "PPFB.DE")!.opportunityScore);
  });
});

describe("detectCycleTops - central clamp", () => {
  test("allocationMultiplier en [0,1] con datos extremos", () => {
    const r = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 10, uraniumSpotPrice: 200, uraniumLTPrice: 100, siaSalesYoY: 80, soxRsiWeekly: 90, inflationBreakeven: 2.0, wlgPERatio: 35, wlgRsiWeekly: 85, emxcPERatio: 28, dxy: 115 });
    for (const s of r.signals) { expect(s.allocationMultiplier).toBeGreaterThanOrEqual(0); expect(s.allocationMultiplier).toBeLessThanOrEqual(1); }
  });

  test("hasActiveWarnings true con Z alto", () => expect(detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 8 }).hasActiveWarnings).toBe(true));
  test("hasActiveWarnings false todo SAFE", () => expect(detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 1.0 }).hasActiveWarnings).toBe(false));
});

describe("isBTCDominanceFalling", () => {
  test("cae desde >58% >1.5pp", () => expect(isBTCDominanceFalling(55, 60)).toBe(true));
  test("cae desde <58%", () => expect(isBTCDominanceFalling(50, 55)).toBe(false));
  test("previous undefined", () => expect(isBTCDominanceFalling(55, undefined)).toBe(false));
  test("caida <1.5pp", () => expect(isBTCDominanceFalling(58, 59)).toBe(false));
});

describe("REGRESION: WLG con datos reales (bug smoothScore Jul-2026)", () => {
  // Estos datos (RSI 58, P/E 19.3, CAPE 40.5) son los que el usuario tiene
  // en el dashboard. El bug de smoothScore (commit 3387c54) hacia que RSI 58
  // contribuyera +1.0 falso → topSignals subia de 1.73 a 2.73 → DANGER 68%.
  // Este test previene que ese bug reaparezca.
  test("RSI 58 + P/E 19.3 + CAPE 40.5 -> CAUTION ~50% (NO DANGER)", () => {
    const r = detectCycleTops({
      wlgRsiWeekly: 58,
      wlgPERatio: 19.3,
      wlgCAPE: 40.5,
      bondYield10y: 4.7,
    });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // RSI 58 no esta sobrecomprado → NO debe empujar el score
    expect(wlg.zone).toBe("CAUTION");  // NO DANGER
    expect(wlg.trimPct).toBeLessThan(60);  // ~50%, no 68%
    expect(wlg.trimPct).toBeGreaterThan(30);
    // Verificar que el RSI no aparece como senal de sobrecompra
    expect(wlg.reason).not.toContain("sobrecompra");
  });

  test("WLG SAFE con datos bajos", () => {
    const r = detectCycleTops({
      wlgRsiWeekly: 50,
      wlgPERatio: 15,
      wlgCAPE: 25,
      bondYield10y: 4.0,
    });
    expect(r.signals.find(s => s.ticker === "0P00000WLG.F")!.zone).toBe("SAFE");
  });
});

describe("Edge cases", () => {
  test("detectCycleTops sin datos no crashea", () => {
    expect(() => detectCycleTops({ bondYield10y: 4.0 })).not.toThrow();
    expect(detectCycleTops({ bondYield10y: 4.0 }).signals.length).toBe(6);
  });
  test("detectCycleBottoms sin datos no crashea", () => {
    expect(() => detectCycleBottoms({ bondYield10y: 4.0 })).not.toThrow();
    expect(detectCycleBottoms({ bondYield10y: 4.0 }).signals.length).toBe(6);
  });
  test("NaN en mvrvZScore no rompe", () => expect(() => detectCycleTops({ mvrvZScore: NaN, bondYield10y: 4.0 })).not.toThrow());
  test("DXY=0 rechazado", () => expect(detectCycleTops({ dxy: 0, bondYield10y: 4.0 }).signals.find(s => s.ticker === "EMXC.DE")!.zone).toBe("SAFE"));
});
