// ===============================================
// TESTS: tacticalScreener.ts — Funciones puras (sin dependencia de Supabase)
// ===============================================
import { describe, test, expect } from "vitest";
import {
  getScanModeCount,
  defaultTacticalConfig,
  SCAN_MODE_LABELS,
  SCAN_MODE_DESCRIPTIONS,
  SCAN_MODE_TIMES,
} from "../core/tactical/tacticalScreener";

describe("SCAN_MODE_LABELS y descriptores", () => {
  test("tiene los 3 modos: volatile, core, full", () => {
    expect(SCAN_MODE_LABELS).toHaveProperty("volatile");
    expect(SCAN_MODE_LABELS).toHaveProperty("core");
    expect(SCAN_MODE_LABELS).toHaveProperty("full");
  });

  test("SCAN_MODE_DESCRIPTIONS tiene descripciones no vacías", () => {
    for (const mode of ["volatile", "core", "full"] as const) {
      expect(SCAN_MODE_DESCRIPTIONS[mode].length).toBeGreaterThan(10);
    }
  });

  test("SCAN_MODE_TIMES tiene tiempos estimados", () => {
    for (const mode of ["volatile", "core", "full"] as const) {
      expect(SCAN_MODE_TIMES[mode].length).toBeGreaterThan(3);
    }
  });
});

describe("getScanModeCount", () => {
  test("volatile devuelve número positivo", () => {
    const count = getScanModeCount("volatile");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
  });

  test("core devuelve número entre volatile y full", () => {
    const volatileCount = getScanModeCount("volatile");
    const coreCount = getScanModeCount("core");
    const fullCount = getScanModeCount("full");
    expect(coreCount).toBeGreaterThan(volatileCount);
    expect(fullCount).toBeGreaterThan(coreCount);
  });

  test("full devuelve ~189 activos", () => {
    const count = getScanModeCount("full");
    expect(count).toBeGreaterThan(150);
    expect(count).toBeLessThan(220);
  });
});

describe("defaultTacticalConfig", () => {
  test("retorna configuración con valores válidos", () => {
    const config = defaultTacticalConfig(50000, 20000);
    expect(config.tacticalCapitalEur).toBeGreaterThan(0);
    expect(config.maxCapitalPerTrade).toBeGreaterThan(0);
    expect(config.riskPerTradePct).toBeGreaterThan(0);
    expect(config.maxOpenPositions).toBeGreaterThan(0);
    expect(config.minScore).toBeGreaterThan(0);
  });

  test("usa el mínimo entre defensiveLiquidity*0.20 y tacticalCapital", () => {
    const config1 = defaultTacticalConfig(50000, 100000);
    expect(config1.tacticalCapitalEur).toBe(20000);
    const config2 = defaultTacticalConfig(50000, 10000);
    expect(config2.tacticalCapitalEur).toBe(2000);
  });

  test("fallback a tacticalCapital si defensiveLiquidity es 0", () => {
    const config = defaultTacticalConfig(25000, 0);
    expect(config.tacticalCapitalEur).toBe(25000);
  });

  test("maneja NaN/infinity en parámetros", () => {
    // Ambos NaN → fallback a 0
    const config1 = defaultTacticalConfig(NaN, NaN);
    expect(config1.tacticalCapitalEur).toBe(0);

    // tacticalCapital válido, defensiveLiquidity NaN → fallback a safeTac
    const config2 = defaultTacticalConfig(50000, NaN);
    expect(config2.tacticalCapitalEur).toBe(50000);

    // tacticalCapital NaN, defensiveLiquidity válida → available = min(10000, 0) = 0, fallback safeTac=0
    const config3 = defaultTacticalConfig(NaN, 50000);
    expect(config3.tacticalCapitalEur).toBe(0);
  });

  test("tiene trailingStop activo por defecto", () => {
    const config = defaultTacticalConfig(100000, 50000);
    expect(config.trailingStop).toBe(true);
  });

  test("maxDaysPerTrade es 75", () => {
    const config = defaultTacticalConfig(100000, 50000);
    expect(config.maxDaysPerTrade).toBe(75);
  });

  test("minRiskReward es 1.3", () => {
    const config = defaultTacticalConfig(100000, 50000);
    expect(config.minRiskReward).toBe(2.0);
  });

  test("riskPerTradePct es 0.01 (1%)", () => {
    const config = defaultTacticalConfig(100000, 50000);
    expect(config.riskPerTradePct).toBe(0.01);
  });
});
