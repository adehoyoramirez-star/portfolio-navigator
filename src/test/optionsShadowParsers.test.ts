// ============================================================
// src/test/optionsShadowParsers.test.ts
// Parsers de Yahoo chart y Deribit DVOL con fixtures (sin red).
// ============================================================
import { describe, it, expect } from "vitest";
import {
  parseYahooChart,
  parseDeribitDvol,
  isCompleteDay,
  DVOL_MIN_PLAUSIBLE_PCT,
} from "../../scripts/shadow/optionsShadowParsers";

const sec = (iso: string) => Date.parse(iso) / 1000;
const ms = (iso: string) => Date.parse(iso);

describe("isCompleteDay", () => {
  it("días pasados completos; hoy solo a partir de las 21:00 UTC; futuros nunca", () => {
    expect(isCompleteDay("2026-10-15", new Date("2026-10-16T10:00:00Z"))).toBe(true);
    expect(isCompleteDay("2026-10-16", new Date("2026-10-16T10:00:00Z"))).toBe(false);
    expect(isCompleteDay("2026-10-16", new Date("2026-10-16T21:30:00Z"))).toBe(true);
    expect(isCompleteDay("2026-10-17", new Date("2026-10-16T23:59:00Z"))).toBe(false);
  });
});

describe("parseYahooChart", () => {
  const fixture = {
    chart: {
      result: [
        {
          timestamp: [
            sec("2026-10-13T13:30:00Z"),
            sec("2026-10-14T13:30:00Z"),
            sec("2026-10-15T13:30:00Z"),
            sec("2026-10-16T13:30:00Z"),
          ],
          indicators: { quote: [{ close: [16.2, null, 17.5, 18.1] }] },
        },
      ],
    },
  };

  it("omite cierres nulos y descarta la barra de hoy si la jornada no ha terminado", () => {
    const bars = parseYahooChart(fixture, new Date("2026-10-16T10:00:00Z"));
    expect([...bars.entries()]).toEqual([
      ["2026-10-13", 16.2],
      ["2026-10-15", 17.5],
    ]);
  });

  it("incluye la barra de hoy tras el cierre", () => {
    const bars = parseYahooChart(fixture, new Date("2026-10-16T21:30:00Z"));
    expect(bars.get("2026-10-16")).toBe(18.1);
  });

  it("valores no positivos o no finitos se ignoran", () => {
    const f = {
      chart: { result: [{ timestamp: [sec("2026-10-13T13:30:00Z"), sec("2026-10-14T13:30:00Z")],
        indicators: { quote: [{ close: [0, Number.NaN] }] } }] },
    };
    expect(parseYahooChart(f, new Date("2026-10-20T00:00:00Z")).size).toBe(0);
  });

  it("respuesta sin result lanza error", () => {
    expect(() => parseYahooChart({ chart: { result: null } }, new Date())).toThrow(/chart\.result/);
  });
});

describe("parseDeribitDvol", () => {
  const now = new Date("2026-10-16T10:00:00Z");
  const mk = (rows: unknown[], continuation: number | null = null) => ({
    jsonrpc: "2.0", id: 1, result: { data: rows, continuation },
  });

  it("parsea [ts_ms, open, high, low, close] y usa el cierre", () => {
    const { bars, continuation } = parseDeribitDvol(
      mk([
        [ms("2026-10-13T00:00:00Z"), 44, 47, 43, 45.5],
        [ms("2026-10-14T00:00:00Z"), 45, 48, 44, 46.25],
        [ms("2026-10-16T00:00:00Z"), 46, 49, 45, 47], // hoy, incompleto
      ]),
      now,
    );
    expect([...bars.entries()]).toEqual([["2026-10-13", 45.5], ["2026-10-14", 46.25]]);
    expect(continuation).toBeNull();
  });

  it("devuelve continuation cuando existe", () => {
    const { continuation } = parseDeribitDvol(mk([[ms("2026-10-13T00:00:00Z"), 1, 1, 1, 50]], 1760000000000), now);
    expect(continuation).toBe(1760000000000);
  });

  it("filas mal formadas se omiten", () => {
    const { bars } = parseDeribitDvol(
      mk([[1, 2], "x", [ms("2026-10-13T00:00:00Z"), 44, 47, 43, 45.5]]),
      now,
    );
    expect(bars.size).toBe(1);
  });

  it("I3: unidad en fracción (mediana < 5) → error, no reescalado silencioso", () => {
    const rows = [
      [ms("2026-10-12T00:00:00Z"), 0.4, 0.5, 0.4, 0.45],
      [ms("2026-10-13T00:00:00Z"), 0.4, 0.5, 0.4, 0.46],
    ];
    expect(() => parseDeribitDvol(mk(rows), now)).toThrow(/unidad inesperada/);
    expect(DVOL_MIN_PLAUSIBLE_PCT).toBe(5);
  });

  it("respuesta sin result.data lanza error", () => {
    expect(() => parseDeribitDvol({ error: { code: 10000 } }, now)).toThrow(/result\.data/);
  });
});
