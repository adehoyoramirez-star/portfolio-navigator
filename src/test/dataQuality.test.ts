// ============================================================
// src/test/dataQuality.test.ts
// FASE 4 — DataQuality estructural: staleness + degradación.
// ============================================================
import { describe, test, expect } from "vitest";
import {
  isStale,
  getStaleFields,
  degradeStaleInputs,
  CYCLE_STALENESS_RULES,
} from "../lib/dataQuality";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // timestamp fijo

describe("DataQuality — staleness", () => {
  test("dato fresco (< umbral) no es stale", () => {
    expect(isStale(NOW - 3 * DAY, 7 * DAY, NOW)).toBe(false);
  });

  test("dato viejo (> umbral) es stale", () => {
    expect(isStale(NOW - 10 * DAY, 7 * DAY, NOW)).toBe(true);
  });

  test("sin timestamp (asOf undefined) no se marca stale", () => {
    expect(isStale(undefined, 7 * DAY, NOW)).toBe(false);
  });
});

describe("DataQuality — reglas de ciclo", () => {
  test("uraniumSpot es diario (7d), goldCbPurchases trimestral (92d)", () => {
    expect(CYCLE_STALENESS_RULES.uraniumSpot.staleAfterMs).toBe(7 * DAY);
    expect(CYCLE_STALENESS_RULES.goldCbPurchases.staleAfterMs).toBe(92 * DAY);
  });

  test("getStaleFields identifica los campos viejos", () => {
    const asOf = {
      uraniumSpot: NOW - 30 * DAY,   // stale (diario)
      goldCbPurchases: NOW - 30 * DAY, // fresco (trimestral, 30d < 92d)
    };
    const stale = getStaleFields(asOf, CYCLE_STALENESS_RULES, NOW);
    expect(stale).toContain("uraniumSpot");
    expect(stale).not.toContain("goldCbPurchases");
  });

  test("degradeStaleInputs degrada a undefined SIN mutar el original", () => {
    const data = { uraniumSpot: 85, goldCbPurchases: 1100, wlgPERatio: 19 };
    const asOf = { uraniumSpot: NOW - 30 * DAY, goldCbPurchases: NOW, wlgPERatio: NOW };
    const { degraded, stale } = degradeStaleInputs(data, asOf, CYCLE_STALENESS_RULES, NOW);
    expect(stale).toContain("uraniumSpot");
    expect(degraded.uraniumSpot).toBeUndefined();
    expect(degraded.goldCbPurchases).toBe(1100);
    expect(degraded.wlgPERatio).toBe(19);
    // el original NO se mutó
    expect(data.uraniumSpot).toBe(85);
  });
});
