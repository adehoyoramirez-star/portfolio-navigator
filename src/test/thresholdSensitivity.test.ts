// ============================================================
// src/test/thresholdSensitivity.test.ts
// G4 — Sensibilidad de umbrales + detección de cliffs.
// Verifica que la HERRAMIENTA funciona (control positivo/negativo),
// no que "no existan cliffs" (los cliffs se reportan para revisión).
// ============================================================
import { describe, test, expect } from "vitest";
import {
  sweepThreshold,
  runThresholdSensitivity,
  formatSensitivityReport,
  DEFAULT_SWEEP_SPECS,
  CLIFF_TRIM_PP,
} from "../core/validation/thresholdSensitivity";

describe("G4 — Sensibilidad de umbrales (herramienta)", () => {
  test("el barrido produce puntos finitos y en rango", () => {
    for (const spec of DEFAULT_SWEEP_SPECS) {
      const r = sweepThreshold(spec);
      expect(r.points.length).toBeGreaterThan(100);
      for (const p of r.points) {
        expect(Number.isFinite(p.multiplier)).toBe(true);
        expect(Number.isFinite(p.trimPct)).toBe(true);
        expect(p.multiplier).toBeGreaterThanOrEqual(0);
        expect(p.multiplier).toBeLessThanOrEqual(1);
        expect(p.trimPct).toBeGreaterThanOrEqual(0);
        expect(p.trimPct).toBeLessThanOrEqual(100);
      }
    }
  });

  test("control POSITIVO: btc-puell-2.5 detecta el cliff del tier duro", () => {
    const r = sweepThreshold(DEFAULT_SWEEP_SPECS.find(s => s.id === "btc-puell-2.5")!);
    expect(r.cliffs.length).toBeGreaterThan(0);
    // El cliff debe ocurrir alrededor del umbral 2.5 (± un 5% del rango)
    const nearThreshold = r.cliffs.filter(c => Math.abs(c.at - 2.5) < 0.3);
    expect(nearThreshold.length).toBeGreaterThan(0);
  });

  test("control NEGATIVO: uranium-ratio (rampa suave) NO tiene cliffs", () => {
    const r = sweepThreshold(DEFAULT_SWEEP_SPECS.find(s => s.id === "uranium-ratio-1.2")!);
    expect(r.cliffs).toEqual([]);
    expect(r.verdict).toBe("PASS");
  });

  test("control NEGATIVO: global-shiftpe (shift suave) NO tiene cliffs", () => {
    const r = sweepThreshold(DEFAULT_SWEEP_SPECS.find(s => s.id === "global-shiftpe-1.5")!);
    expect(r.cliffs).toEqual([]);
    expect(r.verdict).toBe("PASS");
  });

  test("el informe se genera y clasifica PASS/FAIL coherentemente", () => {
    const { results, summary } = runThresholdSensitivity(DEFAULT_SWEEP_SPECS);
    expect(summary.total).toBe(DEFAULT_SWEEP_SPECS.length);
    expect(summary.pass + summary.fail).toBe(summary.total);
    // Los tiers duros (BTC Puell/RSI, Semis RS/RSI, EMXC DXY/RSI) deben fallar.
    // Los controles negativos (uranium, shiftpe) deben pasar.
    expect(summary.failIds).toContain("btc-puell-2.5");
    expect(summary.failIds).not.toContain("uranium-ratio-1.2");
    expect(summary.failIds).not.toContain("global-shiftpe-1.5");
    const report = formatSensitivityReport(results, summary);
    expect(report.length).toBeGreaterThan(0);
    expect(report).toContain("RESUMEN");
  });
});
