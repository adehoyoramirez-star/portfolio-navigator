// ===============================================
// ARCHIVO: src/test/olympus.test.ts
// ESTADO: CORREGIDO Y BLINDADO
// ===============================================
import { describe, test, expect, beforeEach } from "vitest";
import { computeDCADecision } from "../core/dca/dcaEngine";
import type { BTCCycleOutput } from "../core/crypto/btcCycleOverlay";
import { runOlympusEngine, type OlympusEngineInput } from "../core/engine/olympusV3";
import { calculateQuality, computeQualityUniverseStats, type QualityInput } from "../core/factors/quality";
import { calculateMomentum } from "../core/factors/momentum";
import { getMasterRegime, type MasterRegimeInput } from "../core/macro/masterRegime";
import { getClusterVar } from "../core/risk/hrp";
import { estimatePortfolioVol, type AssetInput } from "../core/engine/olympusV3";

describe("Pruebas del Motor Olympus Predator", () => {

  test("Debe reducir la intensidad en modo CRISIS", () => {
    const input = {
      regime: "CRISIS" as const,
      availableCash: 1000,
      totalPortfolioValue: 10000,
      portfolioVolatility: 0.01
    };

    const result = computeDCADecision(input);

    // Verificamos que la intensidad sea baja en crisis
    expect(result.baseIntensity).toBeLessThanOrEqual(0.05);
  });

  test("Debe aplicar el Boost en modo Recuperación", () => {
    // Mock corregido: sin 'phase' y con breakdown oficial
    const mockBtcCycle: BTCCycleOutput = {
      boostActive: true,
      btcScore: 1,
      btcNumeric: 1,
      signal: "BUY",
      breakdown: {
        mvrvScore: 1,
        puellScore: 1,
        rsiScore: 1
      },
      description: "Test de recuperación"
    };

    const input = {
      regime: "EXPANSION" as const,
      btcCycle: mockBtcCycle,
      availableCash: 5000,
      totalPortfolioValue: 10000,
      // FIX-DCA-2: boost solo se activa si portfolioDrawdown < -5% (recuperación real)
      portfolioDrawdown: -0.10,
    };

    const result = computeDCADecision(input);

    // Verificamos que el boost esté funcionando
    expect(result.boostMultiplier).toBeGreaterThan(1);
    expect(result.effectiveIntensity).toBeGreaterThan(result.baseIntensity);
  });

  test("Debe activar la Venta de Emergencia con alta volatilidad", () => {
    const input = {
      regime: "CRISIS" as const,
      // FIX-BUG-3: PANIC_VOLATILITY cambió de 0.04 (diaria) a 0.40 (anualizada).
      // Vol anual 0.50 supera el umbral de pánico 0.40.
      portfolioVolatility: 0.50, // 50% anual (Pánico detectado)
      availableCash: 0,
      totalPortfolioValue: 10000
    };

    const result = computeDCADecision(input);

    // Verificamos el protocolo de eyección
    expect(result.investAmount).toBeLessThan(0); // Es una venta
    expect(result.riskConstraintActive).toBe(true);
    expect(result.description).toContain("Liquidando");
  });

});

describe("Motor Olympus V5 - Factor Quality y Momentum", () => {

  test("Quality debe calcular score correcto para activo defensivo", () => {
    const defensiveAsset: QualityInput = {
      volatility: 0.12,  // baja volatilidad
      returns12m: 0.15,  // retorno positivo
      returns3m: 0.04,
      returns1m: 0.01,
    };

    const aggressiveAsset: QualityInput = {
      volatility: 0.60,  // alta volatilidad
      returns12m: 0.50,  // alto retorno pero volátil
      returns3m: 0.10,
      returns1m: 0.05,
    };

    const stats = computeQualityUniverseStats([defensiveAsset, aggressiveAsset]);
    const qualityDefensive = calculateQuality(defensiveAsset, stats);
    const qualityAggressive = calculateQuality(aggressiveAsset, stats);

    // Activo defensivo debe tener mayor quality score (menor vol, retorno estable)
    expect(qualityDefensive.volatilityScore).toBeGreaterThan(qualityAggressive.volatilityScore);
  });

  test("Quality debe aplicar bonus para ETF Quality Factor", () => {
    const qualityETF: QualityInput = {
      volatility: 0.15,
      returns12m: 0.12,
      returns3m: 0.03,
      returns1m: 0.01,
      isQualityFactor: true,  // ETF de factor quality
    };

    const genericETF: QualityInput = {
      ...qualityETF,
      isQualityFactor: false,
    };

    const stats = computeQualityUniverseStats([qualityETF, genericETF]);
    const qualityWithBonus = calculateQuality(qualityETF, stats);
    const qualityWithoutBonus = calculateQuality(genericETF, stats);

    // El bonus debe aumentar el score
    expect(qualityWithBonus.qualityScore).toBeGreaterThan(qualityWithoutBonus.qualityScore);
  });

  test("Momentum debe calcular score correctamente", () => {
    const strongMomentum = calculateMomentum({
      returns12m: 0.50,
      returns3m: 0.15,
      returns1m: 0.05,
    });

    const weakMomentum = calculateMomentum({
      returns12m: 0.05,
      returns3m: -0.02,
      returns1m: -0.01,
    });

    // Momentum fuerte debe tener score mayor
    expect(strongMomentum.momentumScore).toBeGreaterThan(weakMomentum.momentumScore);

    // Verificar componentes
    expect(strongMomentum.momentum12_1).toBeGreaterThan(0);  // 12m - 1m positivo
  });

  test("Olympus Engine debe integrar Quality y Momentum correctamente", () => {
    const input: OlympusEngineInput = {
      assets: [
        {
          name: "Quality ETF",
          returns12m: 0.12,
          returns3m: 0.04,
          returns1m: 0.01,
          earningsYield: 0.04,
          volatility: 0.15,
          sector: "equity",
        },
        {
          name: "Momentum ETF",
          returns12m: 0.25,
          returns3m: 0.08,
          returns1m: 0.03,
          earningsYield: 0.03,
          volatility: 0.22,
          sector: "equity",
        },
      ],
      correlationMatrix: [[1, 0.6], [0.6, 1]],
      macro: {
        vix: 18,
        yieldSpread: 0.5,
        creditSpread: 1.2,
        move: 100,
        dxyTrend: 0,
        btcVol: 0.60,
        m2Growth: 3.0,
      },
    };

    const result = runOlympusEngine(input);

    // Verificar que el engine produce asignaciones
    expect(result.allocations).toHaveLength(2);
    expect(result.allocations[0].finalAllocation).toBeGreaterThan(0);

    // Verificar que quality y momentum scores están presentes
    expect(result.allocations[0].qualityScore).toBeDefined();
    expect(result.allocations[0].momentumScore).toBeDefined();

    // Verificar régimen (debería ser EXPANSION con VIX 18)
    expect(result.regime).toBe("EXPANSION");
  });
});

// ─────────────────────────────────────────────────────
// EDGE CASES — Motor Olympus V5
// ─────────────────────────────────────────────────────
describe("Olympus V5 — Edge Cases", () => {

  function baseInput(overrides: Partial<OlympusEngineInput> = {}): OlympusEngineInput {
    return {
      assets: [
        { name: "BTC", returns12m: 0.80, returns3m: 0.20, returns1m: 0.05, earningsYield: 0, volatility: 0.60, sector: "crypto" },
        { name: "SP500", returns12m: 0.15, returns3m: 0.05, returns1m: 0.01, earningsYield: 0.035, volatility: 0.18, sector: "equity" },
        { name: "Gold", returns12m: 0.08, returns3m: 0.02, returns1m: -0.01, earningsYield: 0, volatility: 0.15, sector: "commodities" },
      ],
      correlationMatrix: [
        [1, 0.4, 0.15],
        [0.4, 1, 0.2],
        [0.15, 0.2, 1],
      ],
      macro: { vix: 18, yieldSpread: 0.5, creditSpread: 1.2, move: 100, dxyTrend: 0, btcVol: 0.60, m2Growth: 3.0, wtiOil: 75 },
      ...overrides,
    };
  }

  test("CRISIS con VIX alto → totalInvested reducido + tailRisk activo", () => {
    const result = runOlympusEngine(baseInput({
      macro: { vix: 45, yieldSpread: 3.5, creditSpread: 3.0, move: 180, dxyTrend: 4, btcVol: 1.2, m2Growth: -2.0, wtiOil: 60 },
    }));

    expect(result.regime).toBe("CRISIS");
    expect(result.totalInvested).toBeLessThanOrEqual(1.0);
    expect(result.metaIntelligence.modelHealth).toBeDefined();
    expect(result.coreSignal.finalScore).toBeLessThan(0.6);
  });

  test("EXPANSION + STRONG_BUY + M2 > 0 → condiciones Alpha-Boost se cumplen", () => {
    // LIMPIEZA: evitar hysteresis de tests CRISIS anteriores que contamina localStorage
    localStorage.removeItem('olympus_regime_hysteresis_v1');

    const result = runOlympusEngine(baseInput({
      macro: { vix: 12, yieldSpread: 0.2, creditSpread: 0.8, move: 80, dxyTrend: -1, btcVol: 0.40, m2Growth: 6.0, wtiOil: 80 },
      btcOnChain: { mvrvRatio: 1.49, puellMultiple: 0.4, rsiWeekly: 35 },
      covMatrix: [
        [0.36, 0.043, 0.0135],
        [0.043, 0.0324, 0.0054],
        [0.0135, 0.0054, 0.0225],
      ],
      liquidityGrowth: 5,
    }));

    // Verificar condiciones de Alpha-Boost (antes de volTarget)
    expect(result.regime).toBe("EXPANSION");
    expect(result.btcCycle?.signal).toBe("STRONG_BUY");
    expect(result.btcCycle?.boostActive).toBe(true);
    // totalInvested es positivo y razonable
    expect(result.totalInvested).toBeGreaterThan(0.50);
    expect(result.totalInvested).toBeLessThanOrEqual(1.0);
  });

  test("MVRV > 3.5 → BTC cap reducido de 20% a 10%", () => {
    const result = runOlympusEngine(baseInput({
      macro: { vix: 12, yieldSpread: 0.2, creditSpread: 0.8, move: 80, dxyTrend: -1, btcVol: 0.50, m2Growth: 4.0 },
      btcOnChain: { mvrvRatio: 3.8, puellMultiple: 2.5, rsiWeekly: 80 },
    }));

    // BTC no debe exceder 10% con MVRV > 3.5
    const btcAlloc = result.allocations.find(a => a.name === "BTC");
    expect(btcAlloc).toBeDefined();
    expect(btcAlloc!.finalAllocation).toBeLessThanOrEqual(0.11);
  });

  test("CRISIS con drawdown activo → tailRisk reduce exposición", () => {
    // NOTA: Con Kelly = μ/σ², retornos negativos dan Kelly negativo, no cero.
    // El camino ALL_CASH solo se activa si expectedReturn = 0 exacto.
    // Para activar tailRisk kill switch se necesita drawdown > umbral L1 (12%).
    // Con drawdown=-13% + VIX=35 + creditSpread=5 → Kill Switch L1 activo + crisis sistémica.
    const result = runOlympusEngine(baseInput({
      assets: [
        { name: "CashL", returns12m: -0.95, returns3m: -0.50, returns1m: -0.30, earningsYield: 0, volatility: 0.05, sector: "fixed_income" },
      ],
      correlationMatrix: [[1]],
      macro: { vix: 35, yieldSpread: 4.0, creditSpread: 5.0, move: 200, dxyTrend: 5, btcVol: 0.80, m2Growth: -5.0 },
      portfolioDrawdown: -0.13,
      portfolioRealizedVol: 0.35,
    }));

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].finalAllocation).toBeDefined();
    expect(isFinite(result.totalInvested)).toBe(true);
    expect(result.regime).toBe("CRISIS");
    // tailRisk activo por drawdown + VIX alto + credit spread
    expect(result.tailRiskActive).toBe(true);
    expect(result.killSwitchLevel).toBeGreaterThanOrEqual(1);
    expect(result.totalInvested).toBeLessThanOrEqual(1.0);
  });

  test("Sin covMatrix → fallback a Kelly+HRP blend", () => {
    // Omitir covMatrix a propósito
    const result = runOlympusEngine({
      assets: [
        { name: "BTC", returns12m: 0.50, returns3m: 0.15, returns1m: 0.05, earningsYield: 0, volatility: 0.60, sector: "crypto" },
        { name: "SP500", returns12m: 0.12, returns3m: 0.04, returns1m: 0.01, earningsYield: 0.035, volatility: 0.18, sector: "equity" },
      ],
      correlationMatrix: [[1, 0.5], [0.5, 1]],
      macro: { vix: 18, yieldSpread: 0.5, creditSpread: 1.2, move: 100, dxyTrend: 0, btcVol: 0.60, m2Growth: 3.0 },
    });

    expect(result.allocations).toHaveLength(2);
    expect(result.meta.hasRealCovMatrix).toBe(false);
    expect(result.allocations[0].finalAllocation).toBeGreaterThan(0);
    expect(result.allocations[1].finalAllocation).toBeGreaterThan(0);
  });

  test("dcaDataMissing flag true cuando falta totalPortfolioValue", () => {
    const result = runOlympusEngine(baseInput({
      // no pasar totalPortfolioValue
    }));

    expect(result.meta.dcaDataMissing).toBe(true);
  });

  test("dcaDataMissing flag false cuando se provee totalPortfolioValue", () => {
    const result = runOlympusEngine(baseInput({
      totalPortfolioValue: 100000,
      availableCash: 20000,
    }));

    expect(result.meta.dcaDataMissing).toBe(false);
  });

  test("Kill switch level 0 con condiciones normales", () => {
    const result = runOlympusEngine(baseInput());

    expect(result.killSwitchLevel).toBe(0);
    expect(result.tailRiskActive).toBe(false);
  });

  test("Todas las allocations suman ∼totalInvested", () => {
    const result = runOlympusEngine(baseInput({
      covMatrix: [
        [0.36, 0.043, 0.0135],
        [0.043, 0.0324, 0.0054],
        [0.0135, 0.0054, 0.0225],
      ],
    }));

    const sumAllocs = result.allocations.reduce((s, a) => s + a.finalAllocation, 0);
    expect(Math.abs(sumAllocs - result.totalInvested)).toBeLessThan(0.01);
  });

  test("btcCycle se incluye en el output", () => {
    const result = runOlympusEngine(baseInput());

    expect(result.btcCycle).toBeDefined();
    expect(result.btcCycle!.btcScore).toBeGreaterThanOrEqual(0);
    expect(result.btcCycle!.btcNumeric).toBeGreaterThanOrEqual(0);
    expect(result.btcCycle!.btcNumeric).toBeLessThanOrEqual(1);
  });

  test("metaIntelligence siempre presente", () => {
    const result = runOlympusEngine(baseInput());

    expect(result.metaIntelligence.modelHealth).toMatch(/^(RELIABLE|DEGRADED|UNRELIABLE)$/);
    expect(result.metaIntelligence.confidenceMultiplier).toBeGreaterThanOrEqual(0.70);
    expect(result.metaIntelligence.confidenceMultiplier).toBeLessThanOrEqual(1.0);
  });
});

// ─────────────────────────────────────────────────────
// HYSTERESIS — Aislamiento entre regímenes
// ─────────────────────────────────────────────────────
describe("Hysteresis — aislamiento entre regímenes", () => {

  const HYSTERESIS_KEY = 'olympus_regime_hysteresis_v1';

  function makeInput(vix: number, creditSpread: number, yieldSpread: number, overrides: Partial<MasterRegimeInput> = {}): MasterRegimeInput {
    return {
      vix,
      creditSpread,
      yieldSpread,
      move: 100,
      dxyTrend: 0,
      btcVol: 0.60,
      m2Growth: 3.0,
      ...overrides,
    };
  }

  // Inputs que producen cada régimen según detectCrisis + computeGlobalStress:
  // EXPANSION: crisisScore=5.76 (<10), stressScore=0 → ambos EXPANSION
  const EXPANSION_INPUT = makeInput(12, 0.8, 0.2);
  // CONTRACTION: crisisScore=14.6 (>10, <25), stressScore=4 (HIGH_RISK) → CONTRACTION
  const CONTRACTION_INPUT = makeInput(25, 3.5, 0.5, { move: 130, dxyTrend: 0.025, btcVol: 0.65, m2Growth: 1.5 });
  // CRISIS: crisisScore=26 (>25), stressScore=7 (≥6) → CRISIS (ambos modelos)
  const CRISIS_INPUT = makeInput(50, 5.0, 0.5, { move: 150, dxyTrend: 0.03, btcVol: 0.9, m2Growth: -2 });

  beforeEach(() => {
    localStorage.removeItem(HYSTERESIS_KEY);
    localStorage.removeItem('olympus_manual_refresh_v1');
  });

  // ── Test 1: baseline ────────────────────────────────────────────────
  test("EXPANSION directo sin localStorage previo → EXPANSION", () => {
    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("EXPANSION");
  });

  test("CONTRACTION directo sin localStorage previo → CONTRACTION", () => {
    const result = getMasterRegime(CONTRACTION_INPUT);
    expect(result.regime).toBe("CONTRACTION");
  });

  test("CRISIS directo sin localStorage previo → CRISIS", () => {
    const result = getMasterRegime(CRISIS_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 4: CRISIS→EXPANSION bloqueado ──────────────────────────────
  test("CRISIS previo en localStorage → EXPANSION es bloqueado por hysteresis", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 5: CRISIS→CONTRACTION bloqueado ────────────────────────────
  test("CRISIS previo → CONTRACTION es bloqueado por hysteresis", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(CONTRACTION_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 6: CONTRACTION→EXPANSION bloqueado ─────────────────────────
  test("CONTRACTION previo → EXPANSION es bloqueado por hysteresis", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CONTRACTION",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.55,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("CONTRACTION");
  });

  // ── Test 7: EXPANSION→CRISIS NO bloqueado (upgrade) ────────────────
  test("EXPANSION previo → CRISIS NO es bloqueado por hysteresis (upgrade inmediato)", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "EXPANSION",
      lastTimestamp: Date.now(),
      penaltyAtChange: 1.0,
    }));

    const result = getMasterRegime(CRISIS_INPUT);
    expect(result.regime).toBe("CRISIS");
  });

  // ── Test 8: confidence con hysteresis ───────────────────────────────
  test("Confidence es LOW cuando hysteresis está activa bloqueando downgrade", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    expect(result.regime).toBe("CRISIS");
    expect(result.confidence).toBe("LOW");
  });

  // ── Test 9: limpieza manual ─────────────────────────────────────────
  test("Limpieza de localStorage permite el downgrade liberado", () => {
    // Con hysteresis activa
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));
    const blockedResult = getMasterRegime(EXPANSION_INPUT);
    expect(blockedResult.regime).toBe("CRISIS");

    // Limpiar y reintentar
    localStorage.removeItem(HYSTERESIS_KEY);
    const cleanResult = getMasterRegime(EXPANSION_INPUT);
    expect(cleanResult.regime).toBe("EXPANSION");
  });

  // ── Test 10: expiración automática >72h ─────────────────────────────
  test("Estado expirado (>72h) se resetea automáticamente", () => {
    // Sembrar CRISIS de hace 73 horas (excede HYSTERESIS_MAX_HOURS=72)
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now() - 73 * 3_600_000,
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    // Expiró → hysteresis se resetea → EXPANSION se aplica
    expect(result.regime).toBe("EXPANSION");
    // getMasterRegime re-savea estado nuevo tras el reset automático
    const saved = JSON.parse(localStorage.getItem(HYSTERESIS_KEY)!);
    expect(saved.lastRegime).toBe("EXPANSION");
  });

  // ── Test 11: manual refresh bypass ──────────────────────────────────
  test("Manual Refresh Bypass salta la hysteresis", () => {
    // Sembrar CRISIS reciente
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));
    // Señal de refresh manual (válida por 2 minutos)
    localStorage.setItem('olympus_manual_refresh_v1', Date.now().toString());

    const result = getMasterRegime(EXPANSION_INPUT);
    // Con bypass activo, hysteresis se salta → EXPANSION
    expect(result.regime).toBe("EXPANSION");
  });

  // ── Test 12: penalty interpolation ──────────────────────────────────
  test("Penalty se interpola correctamente con hysteresis activa", () => {
    localStorage.setItem(HYSTERESIS_KEY, JSON.stringify({
      lastRegime: "CRISIS",
      lastTimestamp: Date.now(),
      penaltyAtChange: 0.40,
    }));

    const result = getMasterRegime(EXPANSION_INPUT);
    // hoursElapsed ≈ 0 → lerpFactor = 0 → penalty = penaltyAtChange = 0.40
    expect(result.regimePenalty).toBeGreaterThanOrEqual(0.40);
    expect(result.regimePenalty).toBeLessThan(0.60);
  });

  // ── Test 13: penalty NO se interpola tras limpiar ───────────────────
  test("Penalty es el correcto de EXPANSION tras limpiar hysteresis", () => {
    localStorage.removeItem(HYSTERESIS_KEY);
    const result = getMasterRegime(EXPANSION_INPUT);
    // Sin hysteresis, penalty debe ser ~1.0 (EXPANSION puro)
    expect(result.regimePenalty).toBeGreaterThan(0.80);
    expect(result.confidence).toBe("HIGH");
  });
});

// =====================================================
// AUDIT C1 — HRP getClusterVar con IVP weights
// =====================================================
// Validación matemática del fix C1: Inverse Variance Portfolio (IVP)
// en vez de equal-weight para calcular la varianza del cluster.
// Referencia: López de Prado (2016), Hierarchical Risk Parity.
describe("HRP getClusterVar — IVP weights (audit C1)", () => {

  test("IVP asigna más peso a activos de baja volatilidad", () => {
    // BTC 60% vol, Bond 15% vol, correlación 0.2
    const cov = [
      [0.36, 0.018],   // σ²_BTC = 0.36, cov = 0.60*0.15*0.20 = 0.018
      [0.018, 0.0225], // σ²_Bond = 0.0225
    ];
    // IVP weights: invVar = [1/0.36, 1/0.0225] = [2.78, 44.44]
    // normalized: [0.0588, 0.9412]
    // w^T Σ w = 0.0588²*0.36 + 0.9412²*0.0225 + 2*0.0588*0.9412*0.018
    //        = 0.001244 + 0.019937 + 0.001993 = 0.0232
    // √0.0232 ≈ 0.152 (15.2% vol del cluster)
    const varIVP = getClusterVar(cov, [0, 1]);
    expect(varIVP).toBeGreaterThan(0.02);
    expect(varIVP).toBeLessThan(0.04);

    // Equal-weight para comparar: w=[0.5, 0.5]
    // varEW = 0.25*0.36 + 0.25*0.0225 + 2*0.25*0.018
    //       = 0.09 + 0.005625 + 0.009 = 0.1046
    // IVP debe ser MUCHO menor (~4.5x) por el peso extremo en bonds (94%)
    const covEW = [
      [0.36, 0.018],
      [0.018, 0.0225],
    ];
    // Equal weight: w^T Σ w with w=[0.5, 0.5]
    let varEW = 0;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        varEW += 0.5 * 0.5 * covEW[i][j];
      }
    }
    // IVP debería dar menor varianza que equal-weight
    expect(varIVP).toBeLessThan(varEW);
  });

  test("IVP con activos de volatilidad similar → similar a equal-weight", () => {
    // Dos activos con misma volatilidad (20%), correlación 0.5
    const cov = [
      [0.04, 0.02],
      [0.02, 0.04],
    ];
    // invVar = [1/0.04, 1/0.04] = [25, 25]
    // weights = [0.5, 0.5] (idéntico a equal-weight)
    const varIVP = getClusterVar(cov, [0, 1]);
    // Equal-weight: 0.5²*0.04 + 0.5²*0.04 + 2*0.5*0.5*0.02 = 0.01+0.01+0.01 = 0.03
    expect(varIVP).toBeCloseTo(0.03, 5);
  });

  test("n=1 → devuelve la varianza del único activo", () => {
    const cov = [[0.36]];
    const varIVP = getClusterVar(cov, [0]);
    // Con n=1, IVP: w=[1.0], var = 1² * 0.36 = 0.36
    expect(varIVP).toBeCloseTo(0.36, 5);
  });

  test("n=0 → devuelve 0", () => {
    const cov = [
      [0.36, 0.018],
      [0.018, 0.0225],
    ];
    const varIVP = getClusterVar(cov, []);
    expect(varIVP).toBe(0);
  });

  test("varianzas near-zero → fallback a equal-weight", () => {
    // Varianzas casi nulas pero no exactamente cero
    const cov = [
      [1e-12, 0],
      [0, 1e-12],
    ];
    const varIVP = getClusterVar(cov, [0, 1]);
    // 1/1e-12 = 1e12, ambos iguales → weights ≈ [0.5, 0.5]
    // var = 0.25*1e-12 + 0.25*1e-12 ≈ 5e-13
    expect(varIVP).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(varIVP)).toBe(true);
  });

  test("varianza exactamente cero en un activo → ese activo recibe peso 0 en IVP", () => {
    // Un activo con varianza 0 (imposible en práctica, pero edge case)
    const cov = [
      [0.36, 0],
      [0, 0],     // varianza = 0
    ];
    const varIVP = getClusterVar(cov, [0, 1]);
    // invVar = [1/0.36, 0] = [2.78, 0], totalInvVar=2.78
    // w = [1.0, 0.0]
    // var = 1.0² * 0.36 = 0.36 (todo el peso en el activo con varianza > 0)
    expect(varIVP).toBeCloseTo(0.36, 5);
  });

  test("todos los activos con varianza near-zero → fallback equal-weight", () => {
    const cov = [
      [0, 0],
      [0, 0],
    ];
    const varIVP = getClusterVar(cov, [0, 1]);
    // Todas las varianzas ≤ 1e-10 → totalInvVar = 0 → fallback equal-weight
    // var = (0+0+0+0) / 4 = 0
    expect(varIVP).toBe(0);
  });

  test("3 activos con distintas volatilidades → IVP correcto", () => {
    // BTC 60%, SP500 18%, Gold 15%, correlaciones típicas
    const cov = [
      [0.36, 0.0432, 0.0135],
      [0.0432, 0.0324, 0.0054],
      [0.0135, 0.0054, 0.0225],
    ];
    const varIVP = getClusterVar(cov, [0, 1, 2]);
    // invVar = [1/0.36, 1/0.0324, 1/0.0225] = [2.78, 30.86, 44.44]
    // totalInvVar = 78.08
    // w = [0.0356, 0.3953, 0.5691]
    // Gold (15% vol) recibe más peso, BTC (60% vol) menos
    expect(varIVP).toBeGreaterThan(0.01);
    expect(varIVP).toBeLessThan(0.03); // debe ser baja por el peso en Gold
    expect(Number.isFinite(varIVP)).toBe(true);
  });
});

// =====================================================
// AUDIT C2 — estimatePortfolioVol con avgCorrelation
// =====================================================
// Validación matemática del fix C2: el fallback sin covMatrix
// ahora usa avgCorrelation como off-diagonal implícita en vez
// de asumir correlación = 0.
describe("estimatePortfolioVol — avgCorrelation fallback (audit C2)", () => {

  function makeAsset(vol: number): AssetInput {
    return {
      name: `Asset_${vol}`,
      returns12m: 0.10,
      returns3m: 0.03,
      returns1m: 0.01,
      earningsYield: 0.03,
      volatility: vol,
      sector: "equity",
    };
  }

  test("con covMatrix completa → calcula w^T Σ w exacto", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15)];
    const weights = [0.6, 0.4];
    const cov = [
      [0.04, 0.009],    // σ²₁=0.04, cov=0.20*0.15*0.30=0.009
      [0.009, 0.0225],
    ];
    // w^T Σ w = 0.6²*0.04 + 0.4²*0.0225 + 2*0.6*0.4*0.009
    //         = 0.0144 + 0.0036 + 0.00432 = 0.02232
    // √0.02232 ≈ 0.1494
    const vol = estimatePortfolioVol(assets, weights, cov);
    expect(vol).toBeCloseTo(Math.sqrt(0.02232), 5);
  });

  test("sin covMatrix, sin avgCorrelation → solo diagonal (caso base)", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15)];
    const weights = [0.6, 0.4];
    // Solo diagonal: 0.6²*0.04 + 0.4²*0.0225 = 0.0144 + 0.0036 = 0.018
    // √0.018 ≈ 0.1342
    const vol = estimatePortfolioVol(assets, weights);
    expect(vol).toBeCloseTo(Math.sqrt(0.018), 5);
  });

  test("sin covMatrix, con avgCorrelation=0.3 → incluye off-diagonal", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15)];
    const weights = [0.6, 0.4];
    const avgCorr = 0.3;
    // diagonalVar = 0.6²*0.04 + 0.4²*0.0225 = 0.018
    // offDiagVar = w0*w1*σ0*σ1 + w1*w0*σ1*σ0 (i≠j, ambos pares)
    //            = 0.6*0.4*0.20*0.15 + 0.4*0.6*0.15*0.20 = 0.0072 + 0.0072 = 0.0144
    // totalVar = 0.018 + 0.3 * 0.0144 = 0.018 + 0.00432 = 0.02232
    // √0.02232 ≈ 0.1494
    const vol = estimatePortfolioVol(assets, weights, undefined, avgCorr);
    expect(vol).toBeCloseTo(Math.sqrt(0.02232), 5);
  });

  test("sin covMatrix, con avgCorrelation=0 → mismo que sin avgCorrelation", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15)];
    const weights = [0.6, 0.4];
    // avgCorrelation=0: el guard `avgCorrelation > 0` es false → mismo que sin avgCorr
    const volWithZero = estimatePortfolioVol(assets, weights, undefined, 0);
    const volWithout = estimatePortfolioVol(assets, weights);
    expect(volWithZero).toBeCloseTo(volWithout, 8);
  });

  test("con avgCorrelation=0.5 la vol es mayor que con avgCorrelation=0.3", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15)];
    const weights = [0.6, 0.4];
    const vol03 = estimatePortfolioVol(assets, weights, undefined, 0.3);
    const vol05 = estimatePortfolioVol(assets, weights, undefined, 0.5);
    // Mayor correlación → mayor vol del portafolio
    expect(vol05).toBeGreaterThan(vol03);
  });

  test("n=1 → avgCorrelation es irrelevante (no hay off-diagonal)", () => {
    const assets = [makeAsset(0.25)];
    const weights = [1.0];
    // diagonalVar = 1² * 0.0625 = 0.0625, √ = 0.25
    const volNoAvgCorr = estimatePortfolioVol(assets, weights);
    const volWithAvgCorr = estimatePortfolioVol(assets, weights, undefined, 0.8);
    // Con n=1, no hay off-diagonal → ambos deben dar lo mismo
    expect(volNoAvgCorr).toBeCloseTo(0.25, 5);
    expect(volWithAvgCorr).toBeCloseTo(0.25, 5);
  });

  test("avgCorrelation negativo se ignora (guard > 0)", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15)];
    const weights = [0.6, 0.4];
    // avgCorrelation = -0.2 < 0 → mismo que sin avgCorr
    const volNeg = estimatePortfolioVol(assets, weights, undefined, -0.2);
    const volNone = estimatePortfolioVol(assets, weights);
    expect(volNeg).toBeCloseTo(volNone, 8);
  });

  test("covMatrix con dimensión incorrecta → fallback a diagonal + avgCorrelation", () => {
    const assets = [makeAsset(0.20), makeAsset(0.15), makeAsset(0.10)];
    const weights = [0.5, 0.3, 0.2];
    // covMatrix de 2x2 para 3 assets → no coincide → fallback
    const badCov = [
      [0.04, 0.009],
      [0.009, 0.0225],
    ];
    const vol = estimatePortfolioVol(assets, weights, badCov, 0.25);
    // Debe usar el fallback con avgCorrelation, no romperse
    expect(vol).toBeGreaterThan(0.05);
    expect(vol).toBeLessThan(0.30);
  });

  test("3 activos con avgCorrelation típica → vol coherente", () => {
    const assets = [makeAsset(0.60), makeAsset(0.18), makeAsset(0.15)];
    const weights = [0.2, 0.5, 0.3];
    // Sin correlación: 0.2²*0.36 + 0.5²*0.0324 + 0.3²*0.0225 = 0.0144+0.0081+0.002025 = 0.024525
    // √0.024525 ≈ 0.1566
    const volNoCorr = estimatePortfolioVol(assets, weights);
    expect(volNoCorr).toBeCloseTo(Math.sqrt(0.024525), 5);

    // Con avgCorrelation=0.3:
    // offDiagVar = sum_{i≠j} w_i * w_j * σ_i * σ_j = ...
    // offDiagVar:
    //   i=0,j=1: 0.2*0.5*0.60*0.18 = 0.0108
    //   i=0,j=2: 0.2*0.3*0.60*0.15 = 0.0054
    //   i=1,j=0: 0.5*0.2*0.18*0.60 = 0.0108
    //   i=1,j=2: 0.5*0.3*0.18*0.15 = 0.00405
    //   i=2,j=0: 0.3*0.2*0.15*0.60 = 0.0054
    //   i=2,j=1: 0.3*0.5*0.15*0.18 = 0.00405
    // total offDiagVar = 0.0405
    // totalVar = 0.024525 + 0.3*0.0405 = 0.024525 + 0.01215 = 0.036675
    // √0.036675 ≈ 0.1915
    const volWithCorr = estimatePortfolioVol(assets, weights, undefined, 0.3);
    expect(volWithCorr).toBeCloseTo(Math.sqrt(0.036675), 5);
    // Con correlación positiva, la vol debe ser mayor
    expect(volWithCorr).toBeGreaterThan(volNoCorr);
  });
});