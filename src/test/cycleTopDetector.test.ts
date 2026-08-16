import { describe, test, expect } from "vitest";
import {
  applyTacticalDaily,
  detectCycleTops,
  detectCycleBottoms,
  isBTCDominanceFalling,
  regimeValuationShift,
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
    const r = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 10, uraniumSpotPrice: 200, uraniumLTPrice: 100, siaSalesYoY: 80, soxRsiWeekly: 90, inflationBreakeven: 2.0, wlgPERatio: 25, wlgRsiWeekly: 85, emxcPERatio: 28, dxy: 115 });
    for (const s of r.signals) { expect(s.allocationMultiplier).toBeGreaterThanOrEqual(0); expect(s.allocationMultiplier).toBeLessThanOrEqual(1); }
  });

  test("hasActiveWarnings true con Z alto", () => expect(detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 8 }).hasActiveWarnings).toBe(true));
  test("hasActiveWarnings false todo SAFE", () => expect(detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 1.0 }).hasActiveWarnings).toBe(false));
});

describe("detectGoldTop - GOLD-CB-SENSOR (Ago 2026)", () => {
  // realRate = 4.7 − 2.3 = 2.4 → baseMultiplier 0.225 → DANGER sin CB
  const base = { bondYield10y: 4.7, inflationBreakeven: 2.3 };
  const gold = (r: ReturnType<typeof detectCycleTops>) => r.signals.find(s => s.ticker === "PPFB.DE")!;

  test("sin compras de BC → DANGER (trim agresivo)", () => {
    expect(gold(detectCycleTops(base)).zone).toBe("DANGER");
  });

  test("compras récord de BC (1100 t/año) → atenúa a CAUTION", () => {
    const g = gold(detectCycleTops({ ...base, goldCbPurchases: 1100 }));
    expect(g.zone).toBe("CAUTION");
    expect(g.allocationMultiplier).toBeCloseTo(0.40, 2);
  });

  test("BC récord atenúa (multiplier mayor) pero NO convierte en SAFE", () => {
    const sin = gold(detectCycleTops(base));
    const con = gold(detectCycleTops({ ...base, goldCbPurchases: 1100 }));
    expect(con.allocationMultiplier).toBeGreaterThan(sin.allocationMultiplier);
    expect(con.allocationMultiplier).toBeLessThan(1.0);
  });

  test("BC normal (450 t/año) → sin efecto (umbral en 500)", () => {
    const sin = gold(detectCycleTops(base));
    const con = gold(detectCycleTops({ ...base, goldCbPurchases: 450 }));
    expect(con.allocationMultiplier).toBeCloseTo(sin.allocationMultiplier, 6);
  });
});

describe("isBTCDominanceFalling", () => {
  test("cae desde >58% >1.5pp", () => expect(isBTCDominanceFalling(55, 60)).toBe(true));
  test("cae desde <58%", () => expect(isBTCDominanceFalling(50, 55)).toBe(false));
  test("previous undefined", () => expect(isBTCDominanceFalling(55, undefined)).toBe(false));
  test("caida <1.5pp", () => expect(isBTCDominanceFalling(58, 59)).toBe(false));
});

describe("REGRESION: WLG con datos reales (bug smoothScore Jul-2026)", () => {
  // Datos calibrados a Forward P/E institucional (Jul 2026, media ~16).
  // Umbrales: [16,1.0],[20,1.5],[23,2.0],[27,2.5].
  test("RSI 58 + P/E Forward 17.5 + CAPE 40.5 -> CAUTION ~40% (NO DANGER)", () => {
    const r = detectCycleTops({
      wlgRsiWeekly: 58,
      wlgPERatio: 17.5,
      wlgCAPE: 40.5,
      bondYield10y: 4.7,
    });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // RSI 58 no esta sobrecomprado → NO debe empujar el score
    // P/E Forward 17.5 → smoothScore([16,1.0],[20,1.5]...) ≈ 1.19 → CAUTION
    expect(wlg.zone).toBe("CAUTION");  // NO DANGER
    expect(wlg.trimPct).toBeLessThan(55);
    expect(wlg.trimPct).toBeGreaterThan(25);
    // Verificar que el RSI no aparece como senal de sobrecompra
    expect(wlg.reason).not.toContain("sobrecompra");
  });

  test("WLG SAFE con datos bajos (Forward P/E 12)", () => {
    const r = detectCycleTops({
      wlgRsiWeekly: 50,
      wlgPERatio: 12,
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

// ── P1: REGIME-CONDITIONED VALUATION (Jul 2026, Comité) ──────────
//   Tests de sensibilidad para los shifts de régimen.
//   Validan que ±1/±2/±3 producen resultados coherentes y que
//   el backtest de sensibilidad puede discriminar entre calibraciones.
describe("P1: regimeValuationShift", () => {
  test("CONTRACTION -> 0 (baseline)", () => {
    expect(regimeValuationShift('equity', 'CONTRACTION')).toBe(0);
    expect(regimeValuationShift('btc', 'CONTRACTION')).toBe(0);
  });

  test("regime undefined -> 0", () => {
    expect(regimeValuationShift('equity', undefined)).toBe(0);
    expect(regimeValuationShift('btc')).toBe(0);
  });

  test("EXPANSION: equity +1.5, btc +1.0", () => {
    expect(regimeValuationShift('equity', 'EXPANSION')).toBe(1.5);
    expect(regimeValuationShift('btc', 'EXPANSION')).toBe(1.0);
  });

  test("CRISIS: equity -1.5, btc -1.0", () => {
    expect(regimeValuationShift('equity', 'CRISIS')).toBe(-1.5);
    expect(regimeValuationShift('btc', 'CRISIS')).toBe(-1.0);
  });

  test("TS: type (required) before regime (optional)", () => {
    // If this compiles, the TS bug is fixed (optional after required = error).
    const a: number = regimeValuationShift('equity');
    const b: number = regimeValuationShift('btc', 'EXPANSION');
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});

describe("P1: WLG sensitivity — P/E shift by regime", () => {
  // P/E Forward 18 = "caro" sin shift. En EXPANSION (+2) deberia ser neutral.
  // En CRISIS (-2) deberia ser "muy caro".
  const base: CycleTopInputs = { bondYield10y: 4.0, wlgPERatio: 18, wlgRsiWeekly: 55 };

  test("P/E 18 sin shift -> CAUTION (~40% trim)", () => {
    const r = detectCycleTops(base);
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // smoothScore(18,[[16,1.0],[20,1.5]...]) = 1.25 → multiplier 0.60 → trim ~40%
    expect(wlg.zone).toBe("CAUTION");
    expect(wlg.trimPct).toBeGreaterThan(25);
  });

  test("P/E 18 en EXPANSION (+2 shift) -> menos trim", () => {
    const r = detectCycleTops({ ...base, regimeShiftPE: 2.0 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // effectivePE = 18 - 2 = 16 → smoothScore(16) = 1.0 → multiplier 0.65 → trim ~35%
    expect(wlg.trimPct).toBeLessThan(45);
  });

  test("P/E 18 en CRISIS (-2 shift) -> mas trim", () => {
    const r = detectCycleTops({ ...base, regimeShiftPE: -2.0 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // effectivePE = 18 - (-2) = 20 → smoothScore(20) = 1.5 → multiplier 0.55 → trim ~45%
    expect(wlg.trimPct).toBeGreaterThan(40);
  });

  test("shift=0 no afecta resultado vs sin shift", () => {
    const r0 = detectCycleTops({ ...base, regimeShiftPE: 0 });
    const rNone = detectCycleTops(base);
    expect(r0.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct)
      .toBe(rNone.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct);
  });

  test("SENSIBILIDAD ±1/±2/±3: trim crece monotonicamente", () => {
    const trims = [1, -1, 2, -2, 3, -3].map(s => {
      const r = detectCycleTops({ ...base, regimeShiftPE: s });
      return r.signals.find(w => w.ticker === "0P00000WLG.F")!.trimPct;
    });
    // En orden: +1(laxo), -1(estricto), +2, -2, +3, -3
    // Cuanto mas negativo el shift, mas trim.
    expect(trims[0]).toBeLessThan(trims[1]);  // +1 < -1 → shift positivo reduce trim
    expect(trims[2]).toBeLessThan(trims[3]);  // +2 < -2
    expect(trims[4]).toBeLessThan(trims[5]);  // +3 < -3
    // Y dentro de un mismo signo, ±3 produce mas efecto que ±1
    expect(trims[2]).toBeLessThan(trims[0]);  // +2 < +1 (mas laxo = menos trim)
    expect(trims[3]).toBeGreaterThan(trims[1]); // -2 > -1 (mas estricto = mas trim)
  });
});

describe("P1: BTC sensitivity — Z-Score shift by regime", () => {
  // MVRV Z=6.5 con shift 0 -> ~1.25 topSignals (zona CAUTION baja).
  // En EXPANSION (+1) deberia ser SAFE o CAUTION minima.
  // En CRISIS (-1) deberia ser CAUTION clara.
  const base: CycleTopInputs = { bondYield10y: 4.0, mvrvZScore: 6.5 };

  test("Z=6.5 sin shift -> CAUTION", () => {
    const r = detectCycleTops(base);
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.zone).toBe("CAUTION");
  });

  test("Z=6.5 en EXPANSION (+1) -> CAUTION reducida", () => {
    const r = detectCycleTops({ ...base, regimeShiftBTC: 1.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    // effectiveZ = 6.5 - 1.0 = 5.5 → score 0.5 → multiplier 0.75 → trim ~25%
    // Sin shift: Z=6.5 → score 2.0 → multiplier 0.45 → trim 55% → +1 reduce 30pp
    expect(btc.trimPct).toBeLessThan(30);
  });

  test("Z=6.5 en CRISIS (-1) -> CAUTION mas fuerte", () => {
    const r = detectCycleTops({ ...base, regimeShiftBTC: -1.0 });
    const btc = r.signals.find(s => s.ticker === "BTC-EUR")!;
    // effectiveZ = 6.5 - (-1) = 7.5 → umbral canonico 7 superado
    expect(btc.trimPct).toBeGreaterThan(30);
  });

  test("shift=0 no afecta", () => {
    const r0 = detectCycleTops({ ...base, regimeShiftBTC: 0 });
    const rNone = detectCycleTops(base);
    expect(r0.signals.find(s => s.ticker === "BTC-EUR")!.trimPct)
      .toBe(rNone.signals.find(s => s.ticker === "BTC-EUR")!.trimPct);
  });
});

// ── P1.2: CREDIT-SPREAD (Jul 2026, Comité) ──────────────────
//   Credit spread como amplificador/atenuador de valoración en WLG.
//   - Spreads <1.5%: complacencia de crédito → ×1.25 al score → más trim
//   - Spreads 1.5-3.5%: sin ajuste
//   - Spreads >3.5%: estrés en crédito → contrarian para tops → ×0.70 → menos trim
describe("P1.2: WLG — credit spread amplifier", () => {
  // Base: P/E Forward 17.5, RSI 58 → CAUTION ~40% sin credit spread (media institucional 16)
  const base: CycleTopInputs = {
    bondYield10y: 4.7,
    wlgPERatio: 17.5,
    wlgRsiWeekly: 58,
    wlgCAPE: 40.5,
  };

  test("Spread normal 2.0% -> mismo trim que sin credit", () => {
    const rNorm = detectCycleTops({ ...base, creditSpread: 2.0 });
    const rNone = detectCycleTops(base);
    expect(rNorm.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct)
      .toBe(rNone.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct);
  });

  test("Spread estrecho 1.2% -> mas trim (complacencia ×1.25)", () => {
    const r = detectCycleTops({ ...base, creditSpread: 1.2 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    const rNone = detectCycleTops(base);
    const wlgNone = rNone.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // Complacencia amplifica → mas trim que sin spread
    expect(wlg.trimPct).toBeGreaterThan(wlgNone.trimPct);
    expect(wlg.reason).toContain("complacencia");
  });

  test("Spread amplio 4.0% -> menos trim (estres contradice ×0.70)", () => {
    const r = detectCycleTops({ ...base, creditSpread: 4.0 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    const rNone = detectCycleTops(base);
    const wlgNone = rNone.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // Estrés crediticio → contrarian para equity tops → menos trim
    expect(wlg.trimPct).toBeLessThan(wlgNone.trimPct);
    expect(wlg.reason).toContain("estrés");
  });

  test("Spread 1.5% (umbral exacto) -> sin ajuste", () => {
    const r = detectCycleTops({ ...base, creditSpread: 1.5 });
    const rNone = detectCycleTops(base);
    expect(r.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct)
      .toBe(rNone.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct);
  });

  test("Spread 3.5% (umbral exacto) -> sin ajuste", () => {
    const r = detectCycleTops({ ...base, creditSpread: 3.5 });
    const rNone = detectCycleTops(base);
    expect(r.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct)
      .toBe(rNone.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct);
  });

  test("Credit spread no afecta si P/E es SAFE (valuationScore=0)", () => {
    // P/E Forward 12 (barato) con spread estrecho: score 0 → no dispara amplificador
    const r = detectCycleTops({
      ...base,
      wlgPERatio: 12,
      wlgRsiWeekly: 50,
      creditSpread: 1.0,
    });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.zone).toBe("SAFE");
    // No deberia mencionar credit porque valuationScore=0
    expect(wlg.reason).not.toContain("Crédito");
  });

  test("Credit spread no afecta a otros detectores (solo WLG)", () => {
    // BTC no usa credit spread
    const rNone = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 1.0 });
    const rWith = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 1.0, creditSpread: 1.2 });
    expect(rWith.signals.find(s => s.ticker === "BTC-EUR")!.trimPct)
      .toBe(rNone.signals.find(s => s.ticker === "BTC-EUR")!.trimPct);
  });

  test("REGRESION: P/E Forward 17.5 + RSI 58 + spread 2.69% -> CAUTION ~30-50%", () => {
    // Datos reales del dashboard (Jul 2026) calibrados a Forward P/E institucional (media 16)
    const r = detectCycleTops({
      bondYield10y: 4.7,
      wlgPERatio: 17.5,
      wlgRsiWeekly: 58,
      wlgCAPE: 40.5,
      creditSpread: 2.69,
    });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.zone).toBe("CAUTION");
    // 2.69% está en zona normal (1.5-3.5) → sin ajuste → ~40% trim
    expect(wlg.trimPct).toBeGreaterThan(30);
    expect(wlg.trimPct).toBeLessThan(55);
    expect(wlg.reason).not.toContain("complacencia");
    expect(wlg.reason).not.toContain("estrés");
  });
});

// ── P1.3: PEG MODIFIER (Jul 2026, Comité) ──────────────────
//   PEG = P/E Forward ÷ EPS Growth (%). Modula valuationScore.
//   - PEG < 0.8: crecimiento justifica múltiplo → ×0.70 → menos trim
//   - PEG 0.8-1.2: valoración justa → sin ajuste
//   - PEG 1.2-2.0: múltiplo estirado → ×1.10 → más trim
//   - PEG > 2.0: crecimiento no justifica → ×1.25 → más trim
//   Sin wlgEpsGrowth → sin ajuste (el motor no asume nada).
describe("P1.3: WLG — PEG modifier", () => {
  const base: CycleTopInputs = {
    bondYield10y: 4.7,
    wlgPERatio: 19.1,
    wlgRsiWeekly: 58,
    wlgCAPE: 40.5,
  };

  test("Sin EPS Growth -> sin ajuste", () => {
    const r = detectCycleTops(base);
    const rWith = detectCycleTops({ ...base, wlgEpsGrowth: undefined });
    expect(r.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct)
      .toBe(rWith.signals.find(s => s.ticker === "0P00000WLG.F")!.trimPct);
  });

  test("EPS Growth 25% -> PEG=0.76 -> menos trim (×0.70)", () => {
    // P/E 19.1 / 25 = 0.76 → PEG < 0.8 → crecimiento justifica el múltiplo
    const r = detectCycleTops({ ...base, wlgEpsGrowth: 25 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    const rNone = detectCycleTops(base);
    const wlgNone = rNone.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.trimPct).toBeLessThan(wlgNone.trimPct);
    expect(wlg.reason).toContain("PEG");
    expect(wlg.reason).toContain("justifica");
  });

  test("EPS Growth 18% -> PEG=1.06 -> sin ajuste (PEG razonable)", () => {
    const r = detectCycleTops({ ...base, wlgEpsGrowth: 18 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    // PEG en rango 0.8-1.2 → no modifica valuationScore
    const rNone = detectCycleTops(base);
    const wlgNone = rNone.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.trimPct).toBe(wlgNone.trimPct);
  });

  test("EPS Growth 12% -> PEG=1.59 -> mas trim (×1.10)", () => {
    const r = detectCycleTops({ ...base, wlgEpsGrowth: 12 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    const rNone = detectCycleTops(base);
    const wlgNone = rNone.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.trimPct).toBeGreaterThan(wlgNone.trimPct);
  });

  test("EPS Growth 4% -> PEG=4.78 -> mucho mas trim (×1.25)", () => {
    const r = detectCycleTops({ ...base, wlgEpsGrowth: 4 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    const rNone = detectCycleTops(base);
    const wlgNone = rNone.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.trimPct).toBeGreaterThan(wlgNone.trimPct);
    expect(wlg.reason).toContain("no justifica");
  });

  test("EPS Growth < 1% (floor) -> PEG usa 1 como divisor minimo", () => {
    // EPS Growth 0.5% → floor en 1% → PEG = 19.1/1 = 19.1 → >2.0 → ×1.25
    const r = detectCycleTops({ ...base, wlgEpsGrowth: 0.5 });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.trimPct).toBeGreaterThan(0);
  });

  test("PEG no afecta si P/E es SAFE (valuationScore=0)", () => {
    const r = detectCycleTops({
      ...base,
      wlgPERatio: 12,
      wlgRsiWeekly: 50,
      wlgEpsGrowth: 5,
    });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.zone).toBe("SAFE");
    expect(wlg.reason).not.toContain("PEG");
  });

  test("REGREION: P/E 19.1 + EPS 18% + spread 2.69% -> CAUTION", () => {
    // Datos reales estimados: P/E 19.1, EPS ~18% MSCI World
    const r = detectCycleTops({
      bondYield10y: 4.7,
      wlgPERatio: 19.1,
      wlgEpsGrowth: 18,
      wlgRsiWeekly: 58,
      wlgCAPE: 40.5,
      creditSpread: 2.69,
    });
    const wlg = r.signals.find(s => s.ticker === "0P00000WLG.F")!;
    expect(wlg.zone).toBe("CAUTION");
    // PEG ≈ 1.06 → sin ajuste → trim sin cambios respecto a sin EPS
    expect(wlg.trimPct).toBeGreaterThan(30);
  });
});
