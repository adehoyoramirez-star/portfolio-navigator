import { describe, expect, test } from "vitest";
import {
  computeInstitutionalRiskBreadth,
  evaluateInstitutionalBreadth,
  type InstitutionalBreadthAsset,
} from "../core/risk/institutionalBreadth";

const assets = (returns3m: number[]): InstitutionalBreadthAsset[] => returns3m.map((returns, index) => ({
  ticker: `A${index}`,
  returns3m: returns,
  volatility: 0.20,
  weight: 0.25,
}));

describe("Institutional breadth candidate", () => {
  test("pondera el riesgo adverso, no solo el número de votos", () => {
    const result = computeInstitutionalRiskBreadth([
      { ticker: "LOW_RISK", returns3m: -0.01, volatility: 0.10, weight: 0.10, riskContribution: 0.01 },
      { ticker: "HIGH_RISK", returns3m: -0.20, volatility: 0.80, weight: 0.90, riskContribution: 0.89 },
      { ticker: "DEFENSIVE", returns3m: 0.05, volatility: 0.10, weight: 0.10, riskContribution: 0.10 },
    ]);

    expect(result.negativeCount).toBe(2);
    expect(result.negativePct).toBeCloseTo(2 / 3, 10);
    expect(result.riskBreadth).toBeCloseTo(0.90, 10);
  });

  test("no activa antes de confirmar las observaciones adversas", () => {
    const first = evaluateInstitutionalBreadth(assets([-0.1, -0.1, 0.1, 0.1]), undefined, {
      activationThreshold: 0.5,
      deactivationThreshold: 0.4,
      activationDays: 3,
      deactivationDays: 5,
      minimumMultiplier: 0.4,
      maximumMultiplier: 1,
      slope: 1.2,
    });
    const second = evaluateInstitutionalBreadth(assets([-0.1, -0.1, 0.1, 0.1]), first.state, {
      activationThreshold: 0.5,
      deactivationThreshold: 0.4,
      activationDays: 3,
      deactivationDays: 5,
      minimumMultiplier: 0.4,
      maximumMultiplier: 1,
      slope: 1.2,
    });

    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
    expect(second.state.adverseDays).toBe(2);
    expect(second.multiplier).toBe(1);
  });

  test("activa en la tercera observación y el multiplicador es continuo", () => {
    const config = {
      activationThreshold: 0.5,
      deactivationThreshold: 0.4,
      activationDays: 3,
      deactivationDays: 5,
      minimumMultiplier: 0.4,
      maximumMultiplier: 1,
      slope: 1.2,
    };
    let state = { active: false, adverseDays: 0, benignDays: 0 };
    let result = evaluateInstitutionalBreadth(assets([-0.1, -0.1, -0.1, 0.1]), state, config);
    state = result.state;
    result = evaluateInstitutionalBreadth(assets([-0.1, -0.1, -0.1, 0.1]), state, config);
    state = result.state;
    result = evaluateInstitutionalBreadth(assets([-0.1, -0.1, -0.1, 0.1]), state, config);

    expect(result.active).toBe(true);
    expect(result.multiplier).toBeGreaterThan(0.4);
    expect(result.multiplier).toBeLessThan(1);
  });

  test("requiere persistencia favorable para desactivar", () => {
    const config = {
      activationThreshold: 0.5,
      deactivationThreshold: 0.4,
      activationDays: 1,
      deactivationDays: 2,
      minimumMultiplier: 0.4,
      maximumMultiplier: 1,
      slope: 1.2,
    };
    const active = evaluateInstitutionalBreadth(assets([-0.1, -0.1, -0.1, 0.1]), undefined, config);
    const oneBenign = evaluateInstitutionalBreadth(assets([0.1, 0.1, 0.1, 0.1]), active.state, config);
    const twoBenign = evaluateInstitutionalBreadth(assets([0.1, 0.1, 0.1, 0.1]), oneBenign.state, config);

    expect(active.active).toBe(true);
    expect(oneBenign.active).toBe(true);
    expect(twoBenign.active).toBe(false);
    expect(twoBenign.multiplier).toBe(1);
  });
});
