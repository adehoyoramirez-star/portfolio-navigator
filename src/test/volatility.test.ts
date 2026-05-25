import { describe, it, expect } from "vitest";
import { realizedVolatility, ledoitWolfCovariance } from "../core/data/volatility";

describe("realizedVolatility", () => {
  it("returns 0 for fewer than 2 returns", () => {
    expect(realizedVolatility([])).toBe(0);
    expect(realizedVolatility([0.01])).toBe(0);
  });

  it("returns correct annualized vol for constant returns", () => {
    const returns = Array(100).fill(0.01);
    const vol = realizedVolatility(returns);
    expect(vol).toBeCloseTo(0, 10);
  });

  it("returns positive vol for varying returns", () => {
    const returns = [0.01, -0.02, 0.015, -0.01, 0.005, -0.005, 0.02, -0.015, 0.01, -0.01];
    const vol = realizedVolatility(returns);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });
});

describe("ledoitWolfCovariance", () => {
  it("returns empty array for empty input", () => {
    expect(ledoitWolfCovariance([])).toEqual([]);
  });

  it("returns 1x1 matrix for single asset", () => {
    const rets = [[0.01, -0.02, 0.015]];
    const cov = ledoitWolfCovariance(rets);
    expect(cov.length).toBe(1);
    expect(cov[0].length).toBe(1);
    expect(cov[0][0]).toBeGreaterThan(0);
  });

  it("returns diagonal fallback when minLen < 2", () => {
    const rets = [[0.01], [0.02]];
    const cov = ledoitWolfCovariance(rets);
    expect(cov.length).toBe(2);
    expect(cov[0][0]).toBeGreaterThan(0);
    expect(cov[0][1]).toBe(0);
    expect(cov[1][0]).toBe(0);
  });

  it("produces a valid matrix for real-like returns", () => {
    const n = 252;
    const btcLike = Array.from({ length: n }, () => (Math.random() - 0.5) * 0.05);
    const equityLike = Array.from({ length: n }, () => (Math.random() - 0.5) * 0.02);
    const goldLike = Array.from({ length: n }, () => (Math.random() - 0.5) * 0.01);
    const rets = [btcLike, equityLike, goldLike];

    const cov = ledoitWolfCovariance(rets);

    expect(cov.length).toBe(3);
    expect(cov[0].length).toBe(3);

    for (const row of cov) {
      for (const v of row) {
        expect(isFinite(v)).toBe(true);
      }
    }

    expect(cov[0][1]).toBeCloseTo(cov[1][0], 10);
    expect(cov[0][2]).toBeCloseTo(cov[2][0], 10);
    expect(cov[1][2]).toBeCloseTo(cov[2][1], 10);

    expect(cov[0][0]).toBeGreaterThan(0);
    expect(cov[1][1]).toBeGreaterThan(0);
    expect(cov[2][2]).toBeGreaterThan(0);
  });

  it("handles series of different lengths", () => {
    const short = Array.from({ length: 50 }, () => (Math.random() - 0.5) * 0.03);
    const long = Array.from({ length: 500 }, () => (Math.random() - 0.5) * 0.02);
    const rets = [short, long];
    const cov = ledoitWolfCovariance(rets);
    expect(cov.length).toBe(2);
    expect(cov[0][0]).toBeGreaterThan(0);
    expect(cov[1][1]).toBeGreaterThan(0);
    expect(cov[0][1]).toBeCloseTo(cov[1][0], 10);
  });

  it("handles NaN/Inf values gracefully", () => {
    const rets = [
      [0.01, NaN, 0.015, Infinity, -0.01],
      [0.02, -0.01, 0.03, -0.02, 0.01],
    ];
    const cov = ledoitWolfCovariance(rets);
    expect(cov.length).toBe(2);
    for (const row of cov) {
      for (const v of row) {
        expect(isFinite(v)).toBe(true);
      }
    }
  });

  it("returns zero matrix for all-zero returns", () => {
    const rets = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    const cov = ledoitWolfCovariance(rets);
    for (const row of cov) {
      for (const v of row) {
        expect(v).toBe(0);
      }
    }
  });

  it("produces bounded correlations with extreme data", () => {
    const common = Array.from({ length: 20 }, () => (Math.random() - 0.5) * 0.02);
    const a1 = common.map(v => v + (Math.random() - 0.5) * 0.001);
    const a2 = common.map(v => v * 0.8 + (Math.random() - 0.5) * 0.001);
    const rets = [a1, a2];
    const cov = ledoitWolfCovariance(rets);
    const corr = cov[0][1] / Math.sqrt(cov[0][0] * cov[1][1]);
    expect(Math.abs(corr)).toBeLessThanOrEqual(1);
    expect(cov[0][0]).toBeGreaterThan(0);
    expect(cov[0][0]).toBeLessThan(1);
    expect(cov[1][1]).toBeGreaterThan(0);
    expect(cov[1][1]).toBeLessThan(1);
  });
});
