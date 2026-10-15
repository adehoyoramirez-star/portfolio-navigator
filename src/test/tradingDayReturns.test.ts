import { describe, expect, test } from "vitest";
import { tradingDayReturns } from "../lib/stats";

function epoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

describe("tradingDayReturns calendar filtering", () => {
  test("skips returns ending on weekends but retains Friday-to-Monday return", () => {
    const dates = [
      "2026-10-08", // Thursday
      "2026-10-09", // Friday
      "2026-10-10", // Saturday, forward-filled
      "2026-10-11", // Sunday, forward-filled
      "2026-10-12", // Monday
      "2026-10-13", // Tuesday
    ];
    const closes = [100, 110, 110, 110, 121, 120];

    const returns = tradingDayReturns(closes, dates.map(epoch));

    expect(returns).toHaveLength(3);
    expect(returns[0]).toBeCloseTo(0.1, 10); // Thursday → Friday
    expect(returns[1]).toBeCloseTo(0.1, 10); // Friday → Monday (Sunday price is forward-filled)
    expect(returns[2]).toBeCloseTo(120 / 121 - 1, 10); // Monday → Tuesday
  });

  test("rejects mismatched close and timestamp lengths", () => {
    expect(tradingDayReturns([100, 101], [epoch("2026-10-12")])).toEqual([]);
  });
});
