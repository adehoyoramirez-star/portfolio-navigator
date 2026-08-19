// ============================================================
// src/test/periodReturn.test.ts
// Tests de regresión para periodReturnByDate (FIX-BTC-12M).
// ============================================================
import { describe, test, expect } from "vitest";
import { periodReturnByDate } from "../lib/stats";

const DAY = 86400; // 1 día en segundos

function makeSeries(
  nDays: number,
  priceFn: (i: number) => number,
  startTs: number
): { closes: number[]; timestamps: number[] } {
  const closes: number[] = [];
  const timestamps: number[] = [];
  for (let i = 0; i < nDays; i++) {
    closes.push(priceFn(i));
    timestamps.push(startTs + i * DAY);
  }
  return { closes, timestamps };
}

describe("periodReturnByDate — retorno por fecha (FIX-BTC-12M)", () => {
  test("12m = último cierre / precio 365 días atrás - 1", () => {
    const startTs = 1_700_000_000;
    const s = makeSeries(500, (i) => 100 + i * 0.5, startTs);
    const r = periodReturnByDate(s.closes, s.timestamps, 365);
    const expected = s.closes[499] / s.closes[134] - 1;
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(expected, 10);
  });

  test("ANCLA ESTABLE: prepend de historia (lookback 1→2 años) NO cambia el retorno", () => {
    const endTs = 1_700_000_000;
    const A = makeSeries(400, (i) => 100 * (1 + i * 0.001), endTs - 399 * DAY);
    const B = makeSeries(600, (i) => {
      const idxInA = i - 200;
      return idxInA >= 0 ? 100 * (1 + idxInA * 0.001) : 80 * (1 + i * 0.001);
    }, endTs - 599 * DAY);

    expect(B.timestamps[200]).toBe(A.timestamps[0]);
    expect(B.closes[200]).toBeCloseTo(A.closes[0], 10);
    expect(B.closes[599]).toBeCloseTo(A.closes[399], 10);

    const rA = periodReturnByDate(A.closes, A.timestamps, 365);
    const rB = periodReturnByDate(B.closes, B.timestamps, 365);
    expect(rA).not.toBeNull();
    expect(rB).not.toBeNull();
    expect(rB!).toBeCloseTo(rA!, 10);
  });

  test("365 días ≠ 252 días para BTC (252 = 8.3 meses, no 12)", () => {
    const startTs = 1_700_000_000;
    const s = makeSeries(500, (i) => 100 + i * 0.5, startTs);
    const r365 = periodReturnByDate(s.closes, s.timestamps, 365);
    const r252 = periodReturnByDate(s.closes, s.timestamps, 252);
    expect(r365).not.toBeNull();
    expect(r252).not.toBeNull();
    expect(r365!).not.toBeCloseTo(r252!, 10);
  });

  test("3m y 1m usan 91 y 30 días calendario respectivamente", () => {
    const startTs = 1_700_000_000;
    const s = makeSeries(200, (i) => 100 + i * 0.5, startTs);
    const r3m = periodReturnByDate(s.closes, s.timestamps, 91);
    const r1m = periodReturnByDate(s.closes, s.timestamps, 30);
    expect(r3m).not.toBeNull();
    expect(r1m).not.toBeNull();
    expect(r3m!).toBeCloseTo(s.closes[199] / s.closes[108] - 1, 10);
    expect(r1m!).toBeCloseTo(s.closes[199] / s.closes[169] - 1, 10);
  });

  test("null si timestamps no alineados (longitud distinta)", () => {
    const closes = [100, 101, 102];
    const timestamps = [1_700_000_000, 1_700_000_000 + DAY];
    expect(periodReturnByDate(closes, timestamps, 30)).toBeNull();
  });

  test("null si no hay suficiente historia", () => {
    const s = makeSeries(100, (i) => 100 + i, 1_700_000_000);
    expect(periodReturnByDate(s.closes, s.timestamps, 365)).toBeNull();
  });

  test("null si el ancla o el final es no positivo", () => {
    const s = makeSeries(400, (i) => (i < 35 ? 0 : 100 + i), 1_700_000_000);
    expect(periodReturnByDate(s.closes, s.timestamps, 365)).toBeNull();
  });
});
