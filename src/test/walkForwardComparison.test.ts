import { describe, expect, test } from "vitest";
import {
  bootstrapMeanConfidenceInterval,
  computePairedDifferences,
} from "../core/backtest/walkForwardComparison";

describe("Paired walk-forward statistics", () => {
  test("computes candidate-minus-benchmark differences window by window", () => {
    const differences = computePairedDifferences([1.2, 1.0, 0.8], [1.0, 1.1, 0.7]);
    expect(differences).toHaveLength(3);
    expect(differences[0]).toBeCloseTo(0.2, 10);
    expect(differences[1]).toBeCloseTo(-0.1, 10);
    expect(differences[2]).toBeCloseTo(0.1, 10);
  });

  test("rejects unpaired series with different window counts", () => {
    expect(() => computePairedDifferences([1, 2], [1])).toThrow(/Cannot pair series/);
  });

  test("returns a reproducible percentile bootstrap CI", () => {
    const options = { samples: 2_000, seed: 20_260_831, confidenceLevel: 0.95 };
    const first = bootstrapMeanConfidenceInterval([1, 2, 3, 4, 5], options);
    const second = bootstrapMeanConfidenceInterval([1, 2, 3, 4, 5], options);

    expect(first).toEqual(second);
    expect(first.estimate).toBe(3);
    expect(first.sampleSize).toBe(5);
    expect(first.bootstrapSamples).toBe(2_000);
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
  });
});
