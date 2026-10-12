// ============================================================
// src/test/dataQuality.test.ts
// FASE 4 — DataQuality estructural: staleness + degradación.
// ============================================================
import { describe, test, expect } from "vitest";
import {
  isStale,
  getStaleFields,
  degradeStaleInputs,
  buildStalenessReport,
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

describe("DataQuality — informe de frescura (visible)", () => {
  test("solo lista campos CON timestamp (no inventa antigüedad)", () => {
    const rep = buildStalenessReport({ uraniumSpot: NOW - 3 * DAY }, CYCLE_STALENESS_RULES, NOW);
    expect(rep.map(e => e.field)).toEqual(["uraniumSpot"]);
    expect(rep[0].ageDays).toBeCloseTo(3, 6);
    expect(rep[0].limitDays).toBe(7);
    expect(rep[0].isStale).toBe(false);
    expect(rep[0].frequency).toBe("diario");
  });

  test("sin timestamps -> informe vacío (no se afirma nada)", () => {
    expect(buildStalenessReport(undefined, CYCLE_STALENESS_RULES, NOW)).toEqual([]);
    expect(buildStalenessReport({}, CYCLE_STALENESS_RULES, NOW)).toEqual([]);
  });

  test("caducados primero y, entre ellos, los más antiguos", () => {
    const asOf = {
      goldCbPurchases: NOW - 30 * DAY, // fresco (trimestral, 92d)
      uraniumSpot: NOW - 10 * DAY,     // stale (diario, 7d)
      soxRsiWeekly: NOW - 40 * DAY,    // stale (semanal, 14d)
    };
    const rep = buildStalenessReport(asOf, CYCLE_STALENESS_RULES, NOW);
    expect(rep.map(e => e.field)).toEqual(["soxRsiWeekly", "uraniumSpot", "goldCbPurchases"]);
    expect(rep.map(e => e.isStale)).toEqual([true, true, false]);
  });

  test("un timestamp no finito se ignora (no genera entrada)", () => {
    expect(buildStalenessReport({ uraniumSpot: NaN }, CYCLE_STALENESS_RULES, NOW)).toEqual([]);
  });
});
