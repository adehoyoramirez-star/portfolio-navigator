import { describe, it, expect } from "vitest";
import {
  monteCarloJumpDiffusion,
  choleskyDecomposition,
  randomNormal,
} from "@/lib/monteCarlo";

describe("randomNormal", () => {
  it("returns a finite number", () => {
    const result = randomNormal();
    expect(typeof result).toBe("number");
    expect(Number.isFinite(result)).toBe(true);
  });

  it("returns different values on successive calls", () => {
    const values = new Set<number>();
    for (let i = 0; i < 20; i++) values.add(randomNormal());
    expect(values.size).toBeGreaterThan(1);
  });

  it("approximates standard normal distribution over many samples", () => {
    const N = 5000;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < N; i++) {
      const v = randomNormal();
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / N;
    const std = Math.sqrt(sumSq / N - mean * mean);
    expect(mean).toBeCloseTo(0, 1);
    expect(std).toBeCloseTo(1, 1);
  });
});

describe("choleskyDecomposition", () => {
  it("decomposes a 2x2 identity matrix", () => {
    const A = [[1, 0], [0, 1]];
    const L = choleskyDecomposition(A, 2);
    expect(L[0][0]).toBeCloseTo(1, 5);
    expect(L[0][1]).toBeCloseTo(0, 5);
    expect(L[1][0]).toBeCloseTo(0, 5);
    expect(L[1][1]).toBeCloseTo(1, 5);
  });

  it("decomposes a 2x2 positive definite matrix", () => {
    const A = [[4, 1], [1, 3]];
    const L = choleskyDecomposition(A, 2);
    const result = [
      [L[0][0] * L[0][0], L[0][0] * L[1][0]],
      [L[1][0] * L[0][0], L[1][0] * L[1][0] + L[1][1] * L[1][1]],
    ];
    expect(result[0][0]).toBeCloseTo(A[0][0], 5);
    expect(result[0][1]).toBeCloseTo(A[0][1], 5);
    expect(result[1][0]).toBeCloseTo(A[1][0], 5);
    expect(result[1][1]).toBeCloseTo(A[1][1], 5);
  });

  it("decomposes a 3x3 covariance matrix", () => {
    const A = [[0.04, 0.01, 0.005], [0.01, 0.09, 0.02], [0.005, 0.02, 0.16]];
    const L = choleskyDecomposition(A, 3);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j <= i; j++)
        expect(Number.isFinite(L[i][j])).toBe(true);
    expect(L[0][1]).toBe(0);
    expect(L[0][2]).toBe(0);
    expect(L[1][2]).toBe(0);
  });

  it("handles near-singular matrix gracefully", () => {
    const A = [[1e-10, 0], [0, 1e-10]];
    const L = choleskyDecomposition(A, 2);
    expect(Number.isFinite(L[0][0])).toBe(true);
    expect(L[0][0]).toBeGreaterThan(0);
  });

  it("returns positive diagonal elements for 3x3", () => {
    const A = [[5, 2, 1], [2, 6, 3], [1, 3, 7]];
    const L = choleskyDecomposition(A, 3);
    expect(L[0][0]).toBeGreaterThan(0);
    expect(L[1][1]).toBeGreaterThan(0);
    expect(L[2][2]).toBeGreaterThan(0);
  });

  it("L * L^T equals A for 3x3 matrix", () => {
    const A = [[2, 0.5, 0.3], [0.5, 3, 0.7], [0.3, 0.7, 4]];
    const L = choleskyDecomposition(A, 3);
    const R = Array.from({ length: 3 }, () => Array(3).fill(0));
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          R[i][j] += L[i][k] * L[j][k];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(R[i][j]).toBeCloseTo(A[i][j], 4);
  });
});

describe("monteCarloJumpDiffusion", () => {
  it("returns expected result shape for univariate mode", () => {
    const r = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1.5, -0.10, 0.10, 5, 100);
    expect(r).toHaveProperty("mean");
    expect(r).toHaveProperty("median");
    expect(r).toHaveProperty("p25");
    expect(r).toHaveProperty("p75");
    expect(r).toHaveProperty("worst5");
    expect(r).toHaveProperty("best95");
    expect(r).toHaveProperty("simulations");
    expect(r).toHaveProperty("muUsed");
  });

  it("returns correct number of simulations", () => {
    const r = monteCarloJumpDiffusion(50000, 1000, 0.06, 0.15, 1, -0.05, 0.05, 3, 50);
    expect(r.simulations.length).toBe(50);
  });

  it("all simulation values are positive with zero vol", () => {
    const r = monteCarloJumpDiffusion(50000, 0, 0.05, 0.0001, 0, 0, 0, 1, 50);
    for (const v of r.simulations) expect(v).toBeGreaterThan(0);
  });

  it("statistics are ordered p25 <= median <= p75", () => {
    const r = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1, -0.10, 0.10, 10, 200);
    expect(r.p25).toBeLessThanOrEqual(r.median);
    expect(r.median).toBeLessThanOrEqual(r.p75);
  });

  it("worst5 <= p25 and best95 >= p75", () => {
    const r = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1, -0.10, 0.10, 10, 200);
    expect(r.worst5).toBeLessThanOrEqual(r.p25);
    expect(r.best95).toBeGreaterThanOrEqual(r.p75);
  });

  it("no NaN values in results", () => {
    const r = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1, -0.10, 0.10, 10, 100);
    expect(Number.isFinite(r.mean)).toBe(true);
    expect(Number.isFinite(r.median)).toBe(true);
    expect(Number.isFinite(r.p25)).toBe(true);
    expect(Number.isFinite(r.p75)).toBe(true);
    expect(Number.isFinite(r.worst5)).toBe(true);
    expect(Number.isFinite(r.best95)).toBe(true);
  });

  it("returns muUsed equal to input mu", () => {
    const r = monteCarloJumpDiffusion(50000, 1000, 0.12, 0.15, 1, -0.05, 0.05, 3, 30);
    expect(r.muUsed).toBe(0.12);
  });

  it("disableJumps and enableJumps both produce valid output", () => {
    const withJumps = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1.5, -0.15, 0.10, 5, 200, undefined, false);
    const withoutJumps = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1.5, -0.15, 0.10, 5, 200, undefined, true);
    expect(Number.isFinite(withJumps.median)).toBe(true);
    expect(Number.isFinite(withoutJumps.median)).toBe(true);
  });

  it("multivariate mode works with valid inputs", () => {
    const r = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1, -0.10, 0.10, 3, 100, {
      weights: [0.4, 0.3, 0.3],
      mus: [0.10, 0.08, 0.06],
      sigmas: [0.20, 0.15, 0.25],
      covMatrix: [[0.04, 0.006, 0.005], [0.006, 0.0225, 0.004], [0.005, 0.004, 0.0625]],
      jumpIntensityBTC: 1.5, jumpMean: -0.10, jumpStd: 0.10, btcIdx: 0,
    });
    expect(r.simulations.length).toBe(100);
    expect(Number.isFinite(r.mean)).toBe(true);
  });

  it("multivariate with btcIdx=-1 disables BTC jumps", () => {
    const r = monteCarloJumpDiffusion(100000, 2000, 0.07, 0.18, 1, -0.10, 0.10, 3, 50, {
      weights: [0.6, 0.4], mus: [0.10, 0.08], sigmas: [0.20, 0.15],
      covMatrix: [[0.04, 0.006], [0.006, 0.0225]],
      jumpIntensityBTC: 10, jumpMean: -0.30, jumpStd: 0.15, btcIdx: -1,
    });
    expect(r.simulations.length).toBe(50);
    expect(Number.isFinite(r.mean)).toBe(true);
  });

  it("works with very low simulation count", () => {
    const r = monteCarloJumpDiffusion(50000, 500, 0.05, 0.10, 0, 0, 0, 1, 3);
    expect(r.simulations.length).toBe(3);
    expect(Number.isFinite(r.median)).toBe(true);
  });

  it("years=0 returns values close to initial capital", () => {
    const r = monteCarloJumpDiffusion(50000, 0, 0.05, 0.10, 0, 0, 0, 0, 10);
    expect(r.simulations.length).toBe(10);
    for (const v of r.simulations) expect(v).toBeCloseTo(50000, 0);
  });
});
