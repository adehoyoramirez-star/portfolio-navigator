// ============================================================
// src/test/positionHistory.test.ts
// Tests de regresión para FIX-FORENSIC-H6 (look-ahead de pesos
// fijos en retornos históricos).
//
// Verifica que:
//  1. computeRealizedReturns usa pesos VARIABLES en el tiempo (sin
//     look-ahead): un cambio de posiciones afecta el retorno SOLO
//     a partir del día del cambio, nunca hacia atrás.
//  2. Devuelve [] cuando no hay datos suficientes.
//  3. recordCurrentPositions hace UPSERT por día (no duplica) y
//     añade días nuevos.
//  4. Persistencia round-trip.
// ============================================================
import { describe, test, expect, beforeEach } from "vitest";
import {
  computeRealizedReturns,
  recordCurrentPositions,
  loadPositionHistory,
  resetPositionHistory,
  type PositionSnapshot,
} from "../core/data/positionHistory";

beforeEach(() => {
  resetPositionHistory();
});

describe("H-6 — computeRealizedReturns (sin look-ahead)", () => {
  test("REGRESIÓN: un cambio de pesos afecta solo al día del cambio, nunca hacia atrás", () => {
    // Historias de 5 días. A dobla de 100 a 200 entre el día 2 y 3.
    const histories = {
      A: [100, 100, 100, 200, 200],
      B: [50, 50, 50, 50, 50],
    };
    // 3 snapshots alineados a los días 2, 3, 4 del historial.
    // El día 2 (k=1) se añade B → el peso de B solo debe entrar en el
    // retorno del día k=2 (transición snapshot 1 -> 2), NO en el del
    // día k=1 (que usa el snapshot 0, 100% A).
    const snapshots: PositionSnapshot[] = [
      { date: "2026-08-01", positions: { A: 1, B: 0 } },
      { date: "2026-08-02", positions: { A: 1, B: 1 } },
      { date: "2026-08-03", positions: { A: 1, B: 1 } },
    ];

    const returns = computeRealizedReturns(histories, snapshots);

    expect(returns).toHaveLength(2);

    // Día k=1: snapshot 0 = 100% A. A sube +100% → retorno +1.0.
    // Si hubiera look-ahead (peso del ÚLTIMO snapshot), B diluiría a 0.8.
    expect(returns[0]).toBeCloseTo(1.0, 6);

    // Día k=2: snapshot 1 = A 80% / B 20%. Ambos planos → retorno 0.
    expect(returns[1]).toBeCloseTo(0.0, 6);
  });

  test("pesos al inicio del día (TWR): la revalorización intra-periodo no se dobla", () => {
    // A duplica entre el día 2 y 3. Con snapshot fijo 100% A durante todo,
    // el único retorno debe ser exactamente +1.0 (un solo día de subida).
    const histories = { A: [100, 100, 100, 200, 200] };
    const snapshots: PositionSnapshot[] = [
      { date: "2026-08-01", positions: { A: 1 } },
      { date: "2026-08-02", positions: { A: 1 } },
      { date: "2026-08-03", positions: { A: 1 } },
    ];
    const returns = computeRealizedReturns(histories, snapshots);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(1.0, 6);
    expect(returns[1]).toBeCloseTo(0.0, 6);
  });

  test("sin datos suficientes devuelve [] (no inventa retornos)", () => {
    // Menos de 2 snapshots.
    expect(computeRealizedReturns({ A: [100, 101] }, [])).toEqual([]);
    expect(
      computeRealizedReturns({ A: [100, 101] }, [{ date: "2026-08-01", positions: { A: 1 } }])
    ).toEqual([]);

    // Historial más corto que el nº de snapshots.
    expect(
      computeRealizedReturns(
        { A: [100] },
        [
          { date: "2026-08-01", positions: { A: 1 } },
          { date: "2026-08-02", positions: { A: 1 } },
        ]
      )
    ).toEqual([]);
  });

  test("tickers ausentes de un snapshot cuentan como 0 shares", () => {
    const histories = { A: [100, 100, 100, 100, 200], B: [100, 100, 100, 100, 100] };
    const snapshots: PositionSnapshot[] = [
      { date: "2026-08-01", positions: { A: 1 } }, // B ausente → 0
      { date: "2026-08-02", positions: { A: 1 } },
      { date: "2026-08-03", positions: { A: 1 } },
    ];
    const returns = computeRealizedReturns(histories, snapshots);
    // A sube +100% en el día k=2 (idx 3->4). Día k=1 es plano.
    expect(returns[0]).toBeCloseTo(0.0, 6);
    expect(returns[1]).toBeCloseTo(1.0, 6);
  });
});

describe("H-6 — recordCurrentPositions (upsert por día + persistencia)", () => {
  test("UPSERT: dos registros el mismo día no duplican, actualizan las shares", () => {
    const d1 = new Date(2026, 7, 14, 10, 0, 0); // 14 ago 2026, local
    const d1b = new Date(2026, 7, 14, 15, 0, 0); // mismo día, más tarde

    recordCurrentPositions({ A: 1 }, d1);
    const afterFirst = loadPositionHistory();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].positions.A).toBe(1);

    recordCurrentPositions({ A: 2, B: 5 }, d1b);
    const afterUpsert = loadPositionHistory();
    expect(afterUpsert).toHaveLength(1);
    expect(afterUpsert[0].positions.A).toBe(2);
    expect(afterUpsert[0].positions.B).toBe(5);
  });

  test("día nuevo añade snapshot (no sobrescribe el anterior)", () => {
    const d1 = new Date(2026, 7, 14, 10, 0, 0);
    const d2 = new Date(2026, 7, 15, 10, 0, 0);

    recordCurrentPositions({ A: 1 }, d1);
    recordCurrentPositions({ A: 3 }, d2);

    const snapshots = loadPositionHistory();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].positions.A).toBe(1);
    expect(snapshots[1].positions.A).toBe(3);
    expect(snapshots[0].date).toBe("2026-08-14");
    expect(snapshots[1].date).toBe("2026-08-15");
  });
});
