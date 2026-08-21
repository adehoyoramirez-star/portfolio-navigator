// ============================================================
// src/test/compositeMetrics.test.ts
// Tests de regresión para el alineamiento BTC del Composite Strategy
// (FIX-FORENSIC-COMPOSITE).
// ============================================================
import { describe, test, expect } from "vitest";
import { computeCompositeMetrics, runBacktestCoupled } from "../core/backtest/compositeMetrics";
import { runBacktest } from "../core/backtest/backtestEngine";

describe("computeCompositeMetrics — alineación BTC (FIX-FORENSIC-COMPOSITE)", () => {
  test("regresión: BTC crash en la pre-ventana (primeros 252 días) NO contamina el composite", () => {
    // 252 días de crash 100→50 (deben quedar FUERA de la ventana alineada) + 1001 días planos en 50.
    // (FIX-ALIGN-1D: con btcStart = btcLen − recLen − 1 hace falta un día plano extra para que el
    // primer retorno de la ventana no sea el último día del crash.)
    const btcPrices: number[] = [];
    for (let i = 0; i < 252; i++) btcPrices.push(100 - (50 * i) / 251); // 100 → 50
    for (let i = 0; i < 1001; i++) btcPrices.push(50); // plano

    // Olympus plano: 1000 días (recLen = 1000)
    const olympusDaily = Array(1000).fill(10000);

    // 100% BTC (olympusPct = 0)
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 0, initialCapital: 10000 });

    // btcStart = 1252 - 1000 = 252 → usa solo la zona plana → retorno 0, sin drawdown.
    // Con el bug (btcStart=0) habría cogido el crash → maxDD ≈ -50%.
    expect(m.maxDrawdown).toBeCloseTo(0, 6);
    expect(m.finalValue).toBeCloseTo(10000, 0);
  });

  test("si el crash está DENTRO de la ventana alineada, sí se refleja en el drawdown", () => {
    // 1000 días planos + 252 días de crash al final (dentro de la ventana)
    const btcPrices: number[] = [];
    for (let i = 0; i < 1000; i++) btcPrices.push(100);
    for (let i = 0; i < 252; i++) btcPrices.push(100 - (50 * i) / 251); // 100 → 50

    const olympusDaily = Array(1000).fill(10000);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 0, initialCapital: 10000 });

    // btcStart = 1252 - 1000 = 252 → incluye el crash final → drawdown negativo
    expect(m.maxDrawdown).toBeLessThan(0);
  });

  test("blend 70/30 con Olympus plano y BTC plano → sin variación", () => {
    const btcPrices = Array(752).fill(100);
    const olympusDaily = Array(500).fill(10000);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 70, initialCapital: 10000 });
    expect(m.finalValue).toBeCloseTo(10000, 6);
    expect(m.maxDrawdown).toBeCloseTo(0, 6);
  });

  test("blend 80/20 (satélite 20%, default auditado): composite = 0.8 × engine + 0.2 × BTC con rebalanceo 21d", () => {
    // engine crece 1%/día compuesto; BTC plano. Con rebalanceo DIARIO sería
    // exactamente 1.008^365; con 21d el peso del motor deriva al alza entre
    // rebalances → el valor final queda entre 1.008^365 y 1.01^365.
    const olympusDaily: number[] = [];
    for (let i = 0; i < 365; i++) olympusDaily.push(10000 * Math.pow(1.01, i + 1));
    // 252 días de pre-ventana (crash irreal) + 365 planos: la alineación usa los últimos 365
    const btcPrices = Array(365 + 252).fill(100);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 80, initialCapital: 10000 });
    expect(m.finalValue).toBeGreaterThan(10000 * Math.pow(1.008, 365));
    expect(m.finalValue).toBeLessThan(10000 * Math.pow(1.01, 365));
    expect(m.maxDrawdown).toBeCloseTo(0, 3);
  });

  test("rebalanceo 21d: los pesos derivan entre rebalances y se resetean al target cada 21 días", () => {
    // engine +1%/día compuesto durante 25 días (incluye un reset en el día 21); BTC plano
    const n = 25;
    const olympusDaily: number[] = [];
    for (let i = 0; i < n; i++) olympusDaily.push(10000 * Math.pow(1.01, i + 1));
    const btcPrices = Array(n + 252).fill(100);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 80, initialCapital: 10000 });

    // Referencia explícita de la convención: wOly deriva con el retorno del motor
    // y se resetea a 0.8 cada 21 días (día 0 = target inicial, sin ejecución en t+1)
    let w = 0.8;
    let v = 10000;
    for (let d = 0; d < n; d++) {
      if (d > 0 && d % 21 === 0) w = 0.8;
      const r = w * 0.01;
      v *= 1 + r;
      w = (w * 1.01) / (1 + r);
    }
    expect(m.finalValue).toBeCloseTo(v, 0);
    // El drift (sin rebalancear a diario) aporta valor frente al blend diario
    expect(m.finalValue).toBeGreaterThan(10000 * Math.pow(1.008, n));
  });

  test("blend 80/20 con BTC moviéndose: el satélite aporta exactamente el 20% del retorno BTC", () => {
    // engine plano (ret 0); BTC sube +10% en un solo día dentro de la ventana alineada
    const olympusDaily = Array(100).fill(10000);
    const btcPrices: number[] = [];
    for (let i = 0; i < 50; i++) btcPrices.push(100);
    btcPrices.push(110); // +10%
    for (let i = 0; i < 50; i++) btcPrices.push(110);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 80, initialCapital: 10000 });
    // retorno composite = 0.2 × 10% = 2% → 10000 × 1.02
    expect(m.finalValue).toBeCloseTo(10200, 0);
    expect(m.maxDrawdown).toBeCloseTo(0, 6);
  });
});

describe("runBacktestCoupled — kill switch por DD total (FIX-ACOPLAMIENTO-SATELITE)", () => {
  // Serie sintética: 6 activos, 6 años. Rally suave años 1-3, crash de BTC
  // (satélite) en el año 4 que arrastra el composite por debajo de -12%
  // (threshold del kill switch), rally después. El motor ve el DD total.
  function syntheticInput() {
    const days = 6 * 365;
    const closes: Record<string, number[]> = {};
    const tickers = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
    for (const t of tickers) {
      const arr: number[] = [];
      let p = 100;
      for (let i = 0; i < days; i++) {
        const isBtc = t === "BTC-EUR";
        const inCrash = isBtc && i >= 3 * 365 && i < 4 * 365; // BTC cae -60% en el año 4
        const drift = inCrash ? -0.0025 : 0.0008;
        const noise = Math.sin(i * 1.7 + (isBtc ? 0 : 1)) * 0.002 + Math.cos(i * 0.9) * 0.0015;
        p *= 1 + drift + noise;
        arr.push(p);
      }
      closes[t] = arr;
    }
    const macroSeries = (v: number) => Array(days).fill(v);
    return {
      closesHistory: closes,
      btcPrices: closes["BTC-EUR"],
      macroHistory: {
        vix: macroSeries(16),
        yieldSpread: macroSeries(0.8),
        creditSpread: macroSeries(2.5),
        erpValue: macroSeries(0.03),
        avgCorrelation: macroSeries(0.35),
      },
      initialCapital: 10_000,
      transactionCostBps: 15,
      useDynamicCovariance: false,
    };
  }

  test("el acoplamiento NO empeora el MaxDD del composite frente al canónico", () => {
    const input = syntheticInput();
    const { composite: coupled } = runBacktestCoupled({ ...input, olympusPct: 80 });
    const base = runBacktest({
      closesHistory: input.closesHistory,
      macroHistory: input.macroHistory,
      lookbackDays: 252,
      rebalanceDays: 21,
      initialCapital: input.initialCapital,
      transactionCostBps: input.transactionCostBps,
      useDynamicCovariance: false,
    });
    const plain = computeCompositeMetrics({
      olympusDailyValues: base.dailyRecords.map((r) => r.portfolioValue),
      btcPrices: input.btcPrices,
      olympusPct: 80,
      initialCapital: input.initialCapital,
    });
    // Con un crash de BTC profundo el kill switch del motor frena MÁS al ver
    // el DD total → el MaxDD acoplado debe ser <= (mejor o igual) al canónico.
    expect(coupled.maxDrawdown).toBeLessThanOrEqual(plain.maxDrawdown + 1e-9);
    // Y el CAGR no debe colapsar (dentro de un rango razonable)
    expect(coupled.cagr).toBeGreaterThan(-0.5);
    expect(coupled.cagr).toBeLessThan(1.0);
  });

  test("con BTC sin crash (bull plano), el acoplamiento apenas cambia las métricas", () => {
    const input = syntheticInput();
    // Quitar el crash: BTC sube suavemente todo el periodo
    const noCrash = {
      ...input,
      btcPrices: input.btcPrices.map((_, i) => 100 * Math.pow(1.001, i)),
      closesHistory: {
        ...input.closesHistory,
        "BTC-EUR": input.btcPrices.map((_, i) => 100 * Math.pow(1.001, i)),
      },
    };
    const { composite: coupled } = runBacktestCoupled({ ...noCrash, olympusPct: 80 });
    const base = runBacktest({
      closesHistory: noCrash.closesHistory,
      macroHistory: noCrash.macroHistory,
      lookbackDays: 252,
      rebalanceDays: 21,
      initialCapital: noCrash.initialCapital,
      transactionCostBps: noCrash.transactionCostBps,
      useDynamicCovariance: false,
    });
    const plain = computeCompositeMetrics({
      olympusDailyValues: base.dailyRecords.map((r) => r.portfolioValue),
      btcPrices: noCrash.btcPrices,
      olympusPct: 80,
      initialCapital: noCrash.initialCapital,
    });
    // Sin crisis el kill switch no se activa por DD total → métricas casi idénticas
    expect(Math.abs(coupled.cagr - plain.cagr)).toBeLessThan(0.01);
  });
});
