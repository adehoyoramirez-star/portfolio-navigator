// ===============================================
// TESTS: tacticalSignals.ts — Funciones puras del motor táctico
// ===============================================
import { describe, test, expect } from "vitest";
import {
  classifyAssetSpeed,
  calcDynamicMaxDays,
  calcDynamicTPMultiplier,
  calcOptimalHorizon,
  calcExpectedDays,
  calcTimingScore,
  calcDaysToBreakeven,
  calcStopLoss,
  calcTakeProfits,
  calcTotalScore,
  generateSignals,
  calcIndicators,
} from "../core/tactical/tacticalSignals";

// ──────────────────────────────────────────────
// classifyAssetSpeed
// ──────────────────────────────────────────────
describe("classifyAssetSpeed", () => {
  test("FAST cuando ATR >= 4%", () => {
    expect(classifyAssetSpeed(0.04)).toBe("FAST");
    expect(classifyAssetSpeed(0.08)).toBe("FAST");
    expect(classifyAssetSpeed(0.12)).toBe("FAST");
  });

  test("MEDIUM cuando ATR entre 2% y 4%", () => {
    expect(classifyAssetSpeed(0.02)).toBe("MEDIUM");
    expect(classifyAssetSpeed(0.03)).toBe("MEDIUM");
    expect(classifyAssetSpeed(0.039)).toBe("MEDIUM");
  });

  test("SLOW cuando ATR entre 0.8% y 2%", () => {
    expect(classifyAssetSpeed(0.008)).toBe("SLOW");
    expect(classifyAssetSpeed(0.01)).toBe("SLOW");
    expect(classifyAssetSpeed(0.015)).toBe("SLOW");
  });

  test("TOO_SLOW cuando ATR < 0.8%", () => {
    expect(classifyAssetSpeed(0.005)).toBe("TOO_SLOW");
    expect(classifyAssetSpeed(0.001)).toBe("TOO_SLOW");
    expect(classifyAssetSpeed(0)).toBe("TOO_SLOW");
  });
});

// ──────────────────────────────────────────────
// calcDynamicMaxDays
// ──────────────────────────────────────────────
describe("calcDynamicMaxDays", () => {
  test("FAST → 20 días", () => {
    expect(calcDynamicMaxDays(0.04)).toBe(20);
    expect(calcDynamicMaxDays(0.10)).toBe(20);
  });
  test("MEDIUM → 40 días", () => {
    expect(calcDynamicMaxDays(0.02)).toBe(40);
    expect(calcDynamicMaxDays(0.03)).toBe(40);
  });
  test("SLOW → 75 días", () => {
    expect(calcDynamicMaxDays(0.008)).toBe(75);
    expect(calcDynamicMaxDays(0.015)).toBe(75);
  });
  test("TOO_SLOW → 90 días", () => {
    expect(calcDynamicMaxDays(0.005)).toBe(90);
    expect(calcDynamicMaxDays(0)).toBe(90);
  });
});

// ──────────────────────────────────────────────
// calcDynamicTPMultiplier
// ──────────────────────────────────────────────
describe("calcDynamicTPMultiplier", () => {
  test("FAST → tp1=1.5, tp2=4.0", () => {
    const m = calcDynamicTPMultiplier(0.04);
    expect(m.tp1).toBe(1.5);
    expect(m.tp2).toBe(4.0);
  });
  test("MEDIUM → tp1=1.5, tp2=2.5", () => {
    const m = calcDynamicTPMultiplier(0.02);
    expect(m.tp1).toBe(1.5);
    expect(m.tp2).toBe(2.5);
  });
  test("SLOW → tp1=1.3, tp2=1.8", () => {
    const m = calcDynamicTPMultiplier(0.008);
    expect(m.tp1).toBe(1.3);
    expect(m.tp2).toBe(1.8);
  });
  test("TOO_SLOW → tp1=1.25, tp2=1.5 (mínimo R:R ≥ 1.25)", () => {
    const m = calcDynamicTPMultiplier(0.005);
    expect(m.tp1).toBe(1.25);
    expect(m.tp2).toBe(1.5);
  });
});

// ──────────────────────────────────────────────
// calcOptimalHorizon
// ──────────────────────────────────────────────
describe("calcOptimalHorizon", () => {
  test("retorna días y probabilidad con input válido", () => {
    const r = calcOptimalHorizon(100, 102, 2);
    expect(r.days).toBeGreaterThan(0);
    expect(r.prob).toBeGreaterThan(0);
    expect(r.assetSpeed).toBe("MEDIUM");
    expect(r.probs.length).toBeGreaterThan(0);
  });

  test("retorna 0 días cuando target <= entry", () => {
    const r = calcOptimalHorizon(100, 90, 2);
    expect(r.days).toBe(0);
    expect(r.prob).toBe(0);
  });

  test("retorna 0 días cuando atr <= 0", () => {
    const r = calcOptimalHorizon(100, 110, 0);
    expect(r.days).toBe(0);
    expect(r.prob).toBe(0);
  });

  test("reconoce assetSpeed FAST con ATR alto", () => {
    const r = calcOptimalHorizon(100, 105, 8);  // atrPct = 8%
    expect(r.assetSpeed).toBe("FAST");
  });
});

// ──────────────────────────────────────────────
// calcExpectedDays
// ──────────────────────────────────────────────
describe("calcExpectedDays", () => {
  test("retorna ≥ 1 con parámetros válidos", () => {
    const d = calcExpectedDays(100, 103, 2, "MOMENTUM_BREAKOUT");
    expect(d).toBeGreaterThanOrEqual(1);
  });
  test("MOMENTUM_BREAKOUT tiene drift mayor → menos días", () => {
    const mb = calcExpectedDays(100, 102, 2, "MOMENTUM_BREAKOUT");
    const mr = calcExpectedDays(100, 102, 2, "MEAN_REVERSION");
    expect(mb).toBeLessThanOrEqual(mr);
  });
});

// ──────────────────────────────────────────────
// calcTimingScore
// ──────────────────────────────────────────────
describe("calcTimingScore", () => {
  test("0% al entrar", () => expect(calcTimingScore(0, 20)).toBe(0));
  test("50% a mitad del horizonte", () => expect(calcTimingScore(10, 20)).toBe(50));
  test("cien por cien al cumplir horizonte", () => expect(calcTimingScore(20, 20)).toBe(100));
  test("cap en 100 si excede", () => expect(calcTimingScore(30, 20)).toBe(100));
  test("0 si expectedDays ≤ 0", () => expect(calcTimingScore(5, 0)).toBe(0));
});

// ──────────────────────────────────────────────
// calcDaysToBreakeven
// ──────────────────────────────────────────────
describe("calcDaysToBreakeven", () => {
  test("0 cuando currentPrice >= entryPrice", () => {
    expect(calcDaysToBreakeven(100, 105, 2, "MOMENTUM_BREAKOUT")).toBe(0);
  });
  test("> 0 cuando en pérdidas", () => {
    const d = calcDaysToBreakeven(100, 97, 2, "MOMENTUM_BREAKOUT");
    expect(d).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────
// calcStopLoss
// ──────────────────────────────────────────────
describe("calcStopLoss", () => {
  test("SL menor que entryPrice", () => {
    const closes = [98, 99, 100, 99, 101];
    const sl = calcStopLoss(100, 2, "MOMENTUM_BREAKOUT", closes);
    expect(sl).toBeLessThan(100);
  });
  test("BLOOD_IN_STREETS usa multi 1.5 → SL más amplio que MOMENTUM", () => {
    // Closes con recentLow alto para que stopByATR sea el factor dominante
    const closes = [99.5, 100, 100.5, 101, 102];
    const slBlood = calcStopLoss(100, 2, "BLOOD_IN_STREETS", closes);
    const slMomentum = calcStopLoss(100, 2, "MOMENTUM_BREAKOUT", closes);
    expect(slBlood).toBeLessThan(slMomentum); // multi 1.5 → stop más abajo → más amplio
  });
});

// ──────────────────────────────────────────────
// calcTakeProfits (CORRECCIÓN v6)
// ──────────────────────────────────────────────
describe("calcTakeProfits", () => {
  const defaultInd = {
    price: 100, ma20: 100, ma50: 100, ma200: 100,
    rsi2: 50, rsi14: 50, rsiWeekly: 50,
    macdLine: 0, macdSignal: 0, macdHist: 0,
    adx: 25, efficiencyRatio: 0.3,
    atr14: 2, atr: 2, atrPct: 0.02,
    bbUpper: 102, bbMiddle: 100, bbLower: 98, bbWidth: 0.04,
    zScore20: 0, zScore50: 0, volumeRatio: 1,
    trend: "SIDEWAYS" as const,
    aboveMA200: true, aboveMA50: true, aboveMA20: true,
    drawdownFrom52wHigh: 0,
  };

  test("tp1 > entryPrice", () => {
    const tp = calcTakeProfits(100, 98.5, "MOMENTUM_BREAKOUT", defaultInd);
    expect(tp.tp1).toBeGreaterThan(100);
  });

  test("tp2 > tp1", () => {
    const tp = calcTakeProfits(100, 98.5, "MOMENTUM_BREAKOUT", defaultInd);
    expect(tp.tp2).toBeGreaterThan(tp.tp1);
  });

  test("R:R >= 1.2 por construcción (FIX v6)", () => {
    const tp = calcTakeProfits(100, 98.5, "MOMENTUM_BREAKOUT", defaultInd);
    expect(tp.rr).toBeGreaterThanOrEqual(1.2);
  });

  test("MOMENTUM_BREAKOUT usa trailing", () => {
    const tp = calcTakeProfits(100, 98.5, "MOMENTUM_BREAKOUT", defaultInd);
    expect(tp.useTrailing).toBe(true);
  });

  test("MEAN_REVERSION no usa trailing", () => {
    const tp = calcTakeProfits(100, 98.5, "MEAN_REVERSION", defaultInd);
    expect(tp.useTrailing).toBe(false);
  });

  test("risk=0 → fallback tp1=1.02*tp2=1.04", () => {
    const tp = calcTakeProfits(100, 100, "MOMENTUM_BREAKOUT", defaultInd);
    expect(tp.tp1).toBeCloseTo(102, 0);
    expect(tp.tp2).toBeCloseTo(104, 0);
  });
});

// ──────────────────────────────────────────────
// calcTotalScore
// ──────────────────────────────────────────────
describe("calcTotalScore", () => {
  test("0 si ninguna señal activa", () => {
    const signals = [
      { type: "MOMENTUM_BREAKOUT", active: false, score: 0 } as any,
    ];
    expect(calcTotalScore(signals)).toBe(0);
  });

  test("best score + bonus por señales activas extra", () => {
    const signals = [
      { type: "MOMENTUM_BREAKOUT", active: true, score: 60 } as any,
      { type: "OVERSOLD_BOUNCE", active: true, score: 40 } as any,
    ];
    const score = calcTotalScore(signals);
    expect(score).toBeGreaterThan(60);  // 60 + 8 de bonus
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ──────────────────────────────────────────────
// generateSignals
// ──────────────────────────────────────────────
describe("generateSignals", () => {
  const bullInd = {
    price: 105, ma20: 100, ma50: 98, ma200: 95,
    rsi2: 70, rsi14: 60, rsiWeekly: 55,
    macdLine: 1, macdSignal: 0.5, macdHist: 0.5,
    adx: 35, efficiencyRatio: 0.6,
    atr14: 2, atr: 2, atrPct: 0.02,
    bbUpper: 103, bbMiddle: 100, bbLower: 97, bbWidth: 0.06,
    zScore20: 1.5, zScore50: 1.2, volumeRatio: 2,
    trend: "UPTREND" as const,
    aboveMA200: true, aboveMA50: true, aboveMA20: true,
    drawdownFrom52wHigh: -0.05,
  };

  test("retorna array de 5 señales", () => {
    const sigs = generateSignals(bullInd);
    expect(sigs).toHaveLength(5);
  });

  test("señales activas aparecen primero", () => {
    const sigs = generateSignals(bullInd);
    const firstActive = sigs.findIndex(s => s.active);
    const firstInactive = sigs.findIndex(s => !s.active);
    if (firstActive >= 0 && firstInactive >= 0) {
      expect(firstActive).toBeLessThan(firstInactive);
    }
  });
});

// ──────────────────────────────────────────────
// calcIndicators
// ──────────────────────────────────────────────
describe("calcIndicators", () => {
  const prices = Array.from({ length: 210 }, (_, i) => 100 + Math.sin(i * 0.1) * 10 + i * 0.05);
  const volumes = Array.from({ length: 210 }, () => 1_000_000);
  const highs = prices.map(p => p * 1.02);
  const lows = prices.map(p => p * 0.98);

  test("retorna todos los campos esperados", () => {
    const ind = calcIndicators(prices, volumes, highs, lows);
    expect(ind.price).toBeCloseTo(prices[prices.length - 1], 0);
    expect(ind.atr14).toBeGreaterThan(0);
    expect(ind.rsi14).toBeGreaterThanOrEqual(0);
    expect(ind.rsi14).toBeLessThanOrEqual(100);
    expect(ind.trend).toMatch(/^(UPTREND|DOWNTREND|SIDEWAYS)$/);
  });

  test("lanza error con array vacío", () => {
    expect(() => calcIndicators([], [], [], [])).toThrow();
  });

  test("lanza error con precio inválido", () => {
    expect(() => calcIndicators([NaN], [1], [1], [1])).toThrow();
  });
});

// ──────────────────────────────────────────────
// FPT Model (indirecto via calcOptimalHorizon)
// ──────────────────────────────────────────────
describe("FPT Model (first passage time)", () => {
  test("probabilidad aumenta con más días", () => {
    const r = calcOptimalHorizon(100, 110, 3, "MOMENTUM_BREAKOUT", 60);
    // La probabilidad en días tardíos >= probabilidad en días tempranos
    const early = r.probs[5] ?? 0;
    const late = r.probs[25] ?? 0;
    expect(late).toBeGreaterThanOrEqual(early);
  });

  test("target más lejano → más días esperados", () => {
    const near = calcOptimalHorizon(100, 102, 2, "MOMENTUM_BREAKOUT");
    const far  = calcOptimalHorizon(100, 110, 2, "MOMENTUM_BREAKOUT");
    expect(far.days).toBeGreaterThanOrEqual(near.days);
  });
});
