import { describe, expect, test } from "vitest";
import { calculateDxyTrend } from "../lib/stats";
import { computeGlobalStress } from "../core/macro/globalStress";

const DAY = 86400;

function datedCloses(return20d: number, ageDays = 1) {
  const now = 2_000_000_000;
  const end = now - ageDays * DAY;
  const timestamps = Array.from({ length: 21 }, (_, i) => end - (20 - i) * DAY);
  const closes = Array.from({ length: 21 }, (_, i) =>
    i === 0 ? 100 : i === 20 ? 100 * (1 + return20d) : 100
  );
  return { now, closes, timestamps };
}

describe("DXY trend contract — 20 calendar days, decimal return", () => {
  test.each([
    [0.005, 0.005],
    [0.02, 0.02],
    [0.03, 0.03],
    [-0.03, -0.03],
  ])("returns %s as a decimal, not as an index level", (ret, expected) => {
    const d = datedCloses(ret);
    expect(calculateDxyTrend(d.closes, d.timestamps, d.now)).toBeCloseTo(expected, 10);
  });

  test("returns neutral when history is insufficient", () => {
    expect(calculateDxyTrend([100], [1], 2)).toBe(0);
  });

  test("returns neutral when timestamps do not align with closes", () => {
    const d = datedCloses(0.03);
    expect(calculateDxyTrend(d.closes, d.timestamps.slice(1), d.now)).toBe(0);
  });

  test("returns neutral when the last DXY observation is stale", () => {
    const d = datedCloses(0.03, 8);
    expect(calculateDxyTrend(d.closes, d.timestamps, d.now)).toBe(0);
  });

  test("does not count exactly +2% as above the stress threshold", () => {
    const base = { vix: 15, creditSpread: 1.5, move: 90, btcVol: 0.5 };
    expect(computeGlobalStress({ ...base, dxyTrend: 0.02 }).score).toBe(0);
    expect(computeGlobalStress({ ...base, dxyTrend: 0.020001 }).score).toBe(1);
  });
});
