// ============================================================
// src/test/riskMetrics.test.ts
// Tests unitarios para Sortino, Beta, Alpha, HHI, Omega, Calmar
// ============================================================
import { describe, test, expect } from "vitest";
import {
  sortino, downsideDeviation, beta, alpha, hhi,
  diversificationRatio, calmar, omega,
} from "../lib/riskMetrics";

describe("sortino", () => {
  test("retornos positivos → Sortino alto", () => {
    const s = sortino(Array(252).fill(0.001));
    expect(s).toBeGreaterThan(5);
  });

  test("retornos negativos → Sortino negativo", () => {
    const s = sortino(Array(252).fill(-0.002));
    expect(s).toBeLessThan(0);
  });

  test("target más alto reduce Sortino (con downside real)", () => {
    // Con retornos mixtos, un target mas alto reduce el exceso de retorno
    const mixed = Array(126).fill(0.002).concat(Array(126).fill(-0.001));
    expect(sortino(mixed, 0.04, 0.10)).toBeLessThan(sortino(mixed, 0.04, 0));
  });

  test("array vacío → 0", () => {
    expect(sortino([])).toBe(0);
  });
});

describe("downsideDeviation", () => {
  test("retornos alternados ±0.2% → downside > 0", () => {
    const rets: number[] = [];
    for (let i = 0; i < 252; i++) rets.push(i % 2 === 0 ? 0.002 : -0.002);
    expect(downsideDeviation(rets, 0)).toBeGreaterThan(0);
  });
});

describe("beta", () => {
  test("beta = 1 cuando strategy === benchmark", () => {
    const rets = Array(100).fill(0).map((_, i) => 0.001 + Math.sin(i) * 0.005);
    expect(beta(rets, rets)).toBeCloseTo(1, 4);
  });

  test("arrays cortos → 1 por defecto", () => {
    expect(beta([0.01], [0.01])).toBe(1);
  });
});

describe("alpha", () => {
  test("alpha ~ 0 cuando strategy == benchmark", () => {
    const rets = Array(100).fill(0).map((_, i) => 0.001 + Math.sin(i) * 0.003);
    expect(alpha(rets, rets)).toBeCloseTo(0, 0);
  });
});

describe("hhi", () => {
  test("equal weight 6 activos → 1/6", () => {
    expect(hhi([1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6])).toBeCloseTo(1 / 6, 4);
  });

  test("un activo → 1", () => {
    expect(hhi([1])).toBeCloseTo(1, 4);
  });

  test("50/50 → 0.5", () => {
    expect(hhi([0.5, 0.5])).toBeCloseTo(0.5, 4);
  });

  test("80/20 más concentrado que 50/50", () => {
    expect(hhi([0.8, 0.2])).toBeGreaterThan(hhi([0.5, 0.5]));
  });

  test("pesos se normalizan auto", () => {
    expect(hhi([2, 2])).toBeCloseTo(0.5, 4);
  });
});

describe("diversificationRatio", () => {
  test("equal weight → ~1", () => {
    expect(diversificationRatio([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(1, 4);
  });
});

describe("calmar", () => {
  test("CAGR 15% / DD 20% = 0.75", () => {
    expect(calmar(0.15, -0.20)).toBeCloseTo(0.75, 4);
  });
  test("DD 0 → 0", () => expect(calmar(0.10, 0)).toBe(0));
});

describe("omega", () => {
  test("retornos positivos → omega > 1", () => {
    expect(omega(Array(100).fill(0.002))).toBeGreaterThan(10);
  });
  test("retornos negativos → omega < 1", () => {
    expect(omega(Array(100).fill(-0.002))).toBeLessThan(1);
  });
});
