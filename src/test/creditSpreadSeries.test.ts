import { describe, expect, test } from "vitest";
import { alignObservedCreditSpread } from "../lib/creditSpreadSeries";

const source = [
  "observation_date,BAMLH0A0HYM2",
  "2023-10-09,4.34",
  "2023-10-10,4.26",
  "2023-10-12,4.25",
  "2023-10-13,4.30",
  "2023-10-16,4.27",
].join("\n");

describe("alignObservedCreditSpread", () => {
  test("starts at observed coverage and carries the latest published OAS across weekends", () => {
    const dates = [
      "2023-10-08",
      "2023-10-09",
      "2023-10-10",
      "2023-10-11",
      "2023-10-12",
      "2023-10-13",
      "2023-10-14",
      "2023-10-15",
      "2023-10-16",
    ];
    const result = alignObservedCreditSpread(dates, source);
    expect(result.startIndex).toBe(1);
    expect(result.values).toEqual([4.34, 4.26, 4.26, 4.25, 4.30, 4.30, 4.30, 4.27]);
  });

  test("fails closed when an observation is stale beyond the allowed calendar age", () => {
    const dates = ["2023-10-09", "2023-10-10", "2023-10-15"];
    expect(() => alignObservedCreditSpread(dates, source)).toThrow(/stale/i);
  });

  test("rejects duplicate or unsorted source observations", () => {
    const badSource = [
      "observation_date,BAMLH0A0HYM2",
      "2023-10-10,4.26",
      "2023-10-10,4.25",
    ].join("\n");
    expect(() => alignObservedCreditSpread(["2023-10-10"], badSource)).toThrow(/duplicated or unsorted/i);
  });
});
