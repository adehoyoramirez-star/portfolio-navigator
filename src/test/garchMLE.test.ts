import { describe, it, expect } from "vitest";
import { calibrateGARCH_MLE, initGARCH, runDCCGARCH, GARCHParams } from "../core/risk/dccGarch";

// ── Seeded linear congruential generator (deterministic) ───────────────────
function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

// ── Box-Muller Gaussian with seeded RNG ───────────────────────────────────
function gaussRng(rng: () => number): () => number {
  let cache: number | null = null;
  return () => {
    if (cache !== null) {
      const v = cache;
      cache = null;
      return v;
    }
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const z1 = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    cache = Math.sqrt(-2.0 * Math.log(u)) * Math.sin(2.0 * Math.PI * v);
    return z1;
  };
}

// ── Generate GARCH(1,1) with seeded Gaussian innovations ──────────────────
function generateGARCH(omega: number, alpha: number, beta: number, T: number, seed: number): number[] {
  const rng = gaussRng(createRng(seed));
  const returns: number[] = [];
  const persistence = alpha + beta;
  let h = persistence < 1 ? omega / (1 - persistence) : omega / 0.02;
  for (let t = 0; t < T; t++) {
    const eps = Math.sqrt(h) * rng();
    returns.push(eps);
    h = omega + alpha * eps * eps + beta * h;
  }
  return returns;
}

// ============================================================================

describe("calibrateGARCH_MLE", () => {
  it("returns default params for < 60 observations", () => {
    const short = Array.from({ length: 30 }, () => (Math.random() - 0.5) * 0.02);
    const params = calibrateGARCH_MLE(short, "TEST");
    expect(params.omega).toBeGreaterThan(0);
    expect(params.alpha).toBeGreaterThan(0);
    expect(params.beta).toBeGreaterThan(0);
    expect(params.alpha + params.beta).toBeLessThan(1);
  });

  it("converges to stationary finite params for simulated GARCH data", () => {
    // Deterministic GARCH data with equity-like parameters (α=0.08, β=0.90)
    const returns = generateGARCH(0.00003, 0.08, 0.90, 1000, 42);
    const params = calibrateGARCH_MLE(returns, "SIM");

    // Critical: must be finite and stationary
    expect(isFinite(params.omega)).toBe(true);
    expect(isFinite(params.alpha)).toBe(true);
    expect(isFinite(params.beta)).toBe(true);
    expect(params.omega).toBeGreaterThan(0);
    expect(params.alpha).toBeGreaterThan(0);
    expect(params.beta).toBeGreaterThan(0);
    expect(params.alpha + params.beta).toBeLessThan(0.99);

    // Unconditional volatility should be in the ballpark of true value
    const trueUncondVar = 0.00003 / (1 - 0.08 - 0.90); // = 0.0015
    const uncondVar = params.omega / (1 - params.alpha - params.beta);
    expect(uncondVar).toBeGreaterThan(trueUncondVar * 0.1);
    expect(uncondVar).toBeLessThan(trueUncondVar * 10);
  });

  it("produces sensible params for high-volatility assets (crypto-like)", () => {
    // Deterministic GARCH data with BTC-like parameters (α=0.14, β=0.80)
    const trueOmega = 0.00008;
    const trueAlpha = 0.14;
    const trueBeta = 0.80;
    const returns = generateGARCH(trueOmega, trueAlpha, trueBeta, 800, 99);
    const params = calibrateGARCH_MLE(returns, "BTC-SIM");

    // Critical: finite and stationary
    expect(isFinite(params.omega)).toBe(true);
    expect(isFinite(params.alpha)).toBe(true);
    expect(isFinite(params.beta)).toBe(true);
    expect(params.omega).toBeGreaterThan(0);
    expect(params.alpha).toBeGreaterThan(0);
    expect(params.beta).toBeGreaterThan(0);
    expect(params.alpha + params.beta).toBeLessThan(0.99);

    // Unconditional vol should be in sensible range for crypto-like data
    const trueUncondVar = trueOmega / (1 - trueAlpha - trueBeta); // = 0.001333
    const uncondVar = params.omega / (1 - params.alpha - params.beta);
    expect(uncondVar).toBeGreaterThan(trueUncondVar * 0.05);
    expect(uncondVar).toBeLessThan(trueUncondVar * 20);
  });

  it("produces finite stationary params for diverse inputs", () => {
    for (let seed = 0; seed < 10; seed++) {
      const rng = createRng(seed * 1000 + 42);
      const returns = Array.from({ length: 400 }, () => {
        const base = (rng() - 0.5) * 0.03;
        const cluster = Math.sin(seed * 0.1 + rng()) * 0.01;
        return base + cluster + (rng() - 0.5) * 0.005;
      });
      const params = calibrateGARCH_MLE(returns, `SEED-${seed}`);
      expect(params.alpha + params.beta).toBeLessThan(0.99);
      expect(params.omega).toBeGreaterThan(0);
      expect(isFinite(params.omega)).toBe(true);
      expect(isFinite(params.alpha)).toBe(true);
      expect(isFinite(params.beta)).toBe(true);
    }
  });
});

describe("initGARCH auto-calibration", () => {
  it("auto-calibrates when given >= 252 observations", () => {
    const rng = gaussRng(createRng(123));
    const returns = Array.from({ length: 300 }, () => rng() * 0.015);
    const state = initGARCH("AUTO-TEST", returns);
    expect(state.params.omega).toBeGreaterThan(0);
    expect(state.params.alpha).toBeGreaterThan(0);
    expect(state.params.beta).toBeGreaterThan(0);
    expect(state.lastVariance).toBeGreaterThan(0);
    expect(isFinite(state.lastVariance)).toBe(true);
    expect(state.nObservations).toBe(300);
  });

  it("uses default params when calibrate=false", () => {
    const rng = gaussRng(createRng(456));
    const returns = Array.from({ length: 300 }, () => rng() * 0.015);
    const state = initGARCH("IS3Q.DE", returns, undefined, false);
    expect(state.params.omega).toBe(0.00002);
    expect(state.params.alpha).toBe(0.06);
    expect(state.params.beta).toBe(0.90);
  });

  it("uses custom params when provided (bypasses calibration)", () => {
    const custom: GARCHParams = { omega: 0.00005, alpha: 0.10, beta: 0.85 };
    const rng = gaussRng(createRng(789));
    const returns = Array.from({ length: 300 }, () => rng() * 0.02);
    const state = initGARCH("CUSTOM-TEST", returns, custom);
    expect(state.params.omega).toBeCloseTo(0.00005, 10);
    expect(state.params.alpha).toBeCloseTo(0.10, 8);
    expect(state.params.beta).toBeCloseTo(0.85, 8);
  });

  it("handles short series (< 252 obs) without calibrating", () => {
    const rng = gaussRng(createRng(101));
    const returns = Array.from({ length: 100 }, () => rng() * 0.015);
    const state = initGARCH("SHORT-TEST", returns);
    expect(state.params).toBeDefined();
    expect(state.lastVariance).toBeGreaterThan(0);
    expect(isFinite(state.lastVariance)).toBe(true);
  });
});

describe("runDCCGARCH with calibration", () => {
  it("produces valid output with calibrated params", () => {
    const nAssets = 4;
    const T = 400;
    const tickers = ["BTC-EUR", "IS3Q.DE", "XNAS.DE", "PPFB.DE"];
    const rngs = tickers.map((_, i) => gaussRng(createRng(1000 + i)));
    const returnMatrix: number[][] = rngs.map((rng, i) =>
      Array.from({ length: T }, () => rng() * 0.015 * (1 + i * 0.3))
    );
    const staticCov = Array.from({ length: nAssets }, (_, i) =>
      Array.from({ length: nAssets }, (_, j) => i === j ? 0.0004 : 0.0001)
    );
    const output = runDCCGARCH(tickers, returnMatrix, staticCov);
    expect(output.conditionalVols.length).toBe(nAssets);
    expect(output.dynamicCorrelations.length).toBe(nAssets);
    expect(output.dynamicCovariance.length).toBe(nAssets);
    for (const v of output.conditionalVols) {
      expect(isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    for (const row of output.dynamicCorrelations) {
      for (const v of row) {
        expect(isFinite(v)).toBe(true);
      }
    }
    for (const state of output.garchStates) {
      expect(state.params.alpha).toBeGreaterThan(0);
      expect(state.params.beta).toBeGreaterThan(0);
      expect(state.params.alpha + state.params.beta).toBeLessThan(0.99);
      expect(state.lastVariance).toBeGreaterThan(0);
      expect(isFinite(state.lastVariance)).toBe(true);
    }
    expect(output.avgCorrelation).toBeGreaterThanOrEqual(0);
    expect(output.avgCorrelation).toBeLessThanOrEqual(1);
    expect(["LOW", "NORMAL", "HIGH", "CRISIS"]).toContain(output.correlationRegime);
  });

  it("handles edge case with minimal data (60 obs)", () => {
    const tickers = ["A", "B"];
    const T = 60;
    const rng = gaussRng(createRng(2001));
    const returnMatrix = tickers.map(() => Array.from({ length: T }, () => rng() * 0.02));
    const staticCov = [[0.0004, 0.0001], [0.0001, 0.0004]];
    const output = runDCCGARCH(tickers, returnMatrix, staticCov);
    expect(output.conditionalVols.length).toBe(2);
    expect(output.dynamicCovariance.length).toBe(2);
    for (const v of output.conditionalVols) {
      expect(isFinite(v)).toBe(true);
    }
    for (const row of output.dynamicCovariance) {
      for (const v of row) {
        expect(isFinite(v)).toBe(true);
      }
    }
  });

  it("uses consistent params between states and residuals", () => {
    const T = 400;
    const trendRng = gaussRng(createRng(3000));
    const sharedTrend = Array.from({ length: T }, () => trendRng() * 0.005);
    const tickers = ["A", "B", "C"];
    const rngs = tickers.map((_, i) => gaussRng(createRng(3001 + i)));
    const returnMatrix = tickers.map((_, i) =>
      sharedTrend.map((trend) => trend + rngs[i]() * 0.01 * (1 + i * 0.3))
    );
    const staticCov = [[0.0003, 0.0001, 0.0001], [0.0001, 0.0004, 0.0001], [0.0001, 0.0001, 0.0005]];
    const output = runDCCGARCH(tickers, returnMatrix, staticCov);
    for (const v of output.conditionalVols) {
      expect(isFinite(v)).toBe(true);
    }
    for (const row of output.dynamicCorrelations) {
      for (const v of row) {
        expect(isFinite(v)).toBe(true);
      }
    }
  });
});
