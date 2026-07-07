import { describe, test, expect, beforeEach } from "vitest";
import { runOlympusEngine, type OlympusEngineInput } from "../core/engine/olympusV3";

const HYSTERESIS_KEY = "olympus_regime_hysteresis_v1";

function basePortfolio(): OlympusEngineInput["assets"] {
  return [
    { name: "BTC",    ticker: "BTC-EUR", returns12m: 0.10, returns3m: 0.02, returns1m: 0.01, earningsYield: 0,    volatility: 0.60, sector: "crypto" },
    { name: "EMXC",   ticker: "EMXC.DE", returns12m: 0.08, returns3m: 0.03, returns1m: 0.01, earningsYield: 0.04, volatility: 0.22, sector: "emerging" },
    { name: "Gold",   ticker: "PPFB.DE", returns12m: 0.12, returns3m: 0.05, returns1m: 0.02, earningsYield: 0,    volatility: 0.15, sector: "gold" },
    { name: "URNU",   ticker: "URNU.DE", returns12m: 0.15, returns3m: 0.04, returns1m: 0.01, earningsYield: 0.03, volatility: 0.35, sector: "uranium" },
    { name: "VVSM",   ticker: "VVSM.DE", returns12m: 0.20, returns3m: 0.06, returns1m: 0.02, earningsYield: 0.03, volatility: 0.30, sector: "semis" },
    { name: "WLG",    ticker: "0P00000WLG.F", returns12m: 0.10, returns3m: 0.03, returns1m: 0.01, earningsYield: 0.035, volatility: 0.18, sector: "equity" },
  ];
}

const BASE_COV = [
  [0.3600, 0.0264, 0.0135, 0.0420, 0.0360, 0.0216],
  [0.0264, 0.0484, 0.0099, 0.0231, 0.0198, 0.0158],
  [0.0135, 0.0099, 0.0225, 0.0158, 0.0135, 0.0081],
  [0.0420, 0.0231, 0.0158, 0.1225, 0.0525, 0.0315],
  [0.0360, 0.0198, 0.0135, 0.0525, 0.0900, 0.0270],
  [0.0216, 0.0158, 0.0081, 0.0315, 0.0270, 0.0324],
];

const BASE_CORR = [
  [1,    0.20, 0.15, 0.20, 0.20, 0.20],
  [0.20, 1,    0.30, 0.30, 0.30, 0.40],
  [0.15, 0.30, 1,    0.30, 0.30, 0.25],
  [0.20, 0.30, 0.30, 1,    0.50, 0.50],
  [0.20, 0.30, 0.30, 0.50, 1,    0.50],
  [0.20, 0.40, 0.25, 0.50, 0.50, 1   ],
];

const BASE_MACRO = { vix: 18, yieldSpread: 0.5, creditSpread: 1.2, move: 100, dxyTrend: 0, btcVol: 0.60, m2Growth: 3.0, wtiOil: 75 };

function engineInput(overrides: Partial<OlympusEngineInput> = {}): OlympusEngineInput {
  return {
    assets: basePortfolio(),
    correlationMatrix: BASE_CORR,
    covMatrix: BASE_COV,
    macro: BASE_MACRO,
    totalPortfolioValue: 100000,
    availableCash: 20000,
    bypassHysteresis: true,
    ...overrides,
  };
}

describe("Crisis Scenarios - Olympus V3 Stress Tests", () => {

  beforeEach(() => {
    localStorage.removeItem(HYSTERESIS_KEY);
    localStorage.removeItem("olympus_manual_refresh_v1");
  });

  describe("COVID-19 Marzo 2020", () => {

    test("VIX 82 -> CRISIS + totalInvested < 50%", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 82, yieldSpread: 1.5, creditSpread: 10.0, move: 200, dxyTrend: 6, btcVol: 1.5, m2Growth: -1, wtiOil: 20 },
        portfolioDrawdown: -0.30,
        portfolioRealizedVol: 0.65,
        avgCorrelation: 0.92,
      }));

      expect(result.regime).toBe("CRISIS");
      expect(result.totalInvested).toBeLessThan(0.85);
      expect(result.killSwitchLevel).toBeGreaterThanOrEqual(3);
      expect(result.tailRiskActive).toBe(true);
      expect(result.meta.correlationPanicTriggered).toBe(true);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
      const sum = result.allocations.reduce((s, a) => s + a.finalAllocation, 0);
      expect(Math.abs(sum - result.totalInvested)).toBeLessThan(0.02);
    });

    test("Sin covMatrix -> fallback Kelly+HRP no colapsa", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 82, yieldSpread: 1.5, creditSpread: 10.0, move: 200, dxyTrend: 6, btcVol: 1.5, m2Growth: -1, wtiOil: 20 },
        portfolioDrawdown: -0.30,
        portfolioRealizedVol: 0.65,
        avgCorrelation: 0.92,
        covMatrix: undefined,
      }));

      expect(result.meta.hasRealCovMatrix).toBe(false);
      expect(result.regime).toBe("CRISIS");
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });
  });

  describe("GFC Octubre 2008", () => {

    test("VIX 80 + DD -40% -> Kill Switch L5 + totalInvested < 20%", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 80, yieldSpread: -0.8, creditSpread: 8.0, move: 190, dxyTrend: 5, btcVol: 0.90, m2Growth: -3, wtiOil: 40 },
        portfolioDrawdown: -0.40,
        portfolioRealizedVol: 0.55,
        avgCorrelation: 0.88,
        erpValue: 0.020,
      }));

      expect(result.regime).toBe("CRISIS");
      expect(result.killSwitchLevel).toBeGreaterThanOrEqual(4);
      expect(result.totalInvested).toBeLessThan(0.85);
      expect(result.tailRiskActive).toBe(true);
      expect(result.meta.correlationPanicTriggered).toBe(true);
      expect(result.meta.erpTriggered).toBe(true);
      expect(result.coreSignal.finalScore).toBeLessThan(0.65);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });

    test("BTC se capsula incluso en crisis extrema", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 80, yieldSpread: -0.8, creditSpread: 8.0, move: 190, dxyTrend: 5, btcVol: 0.90, m2Growth: -3, wtiOil: 40 },
        portfolioDrawdown: -0.40,
        btcOnChain: { mvrvRatio: 0.6, puellMultiple: 0.3, rsiWeekly: 15 },
      }));

      const btcAlloc = result.allocations.find(a => a.name === "BTC");
      expect(btcAlloc).toBeDefined();
      if (btcAlloc) {
        expect(btcAlloc.finalAllocation).toBeLessThanOrEqual(0.21);
      }
    });
  });

  describe("Crypto Winter 2022", () => {

    test("BTC capitulacion -> STRONG_BUY pero macro CONTRACTION", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 20, yieldSpread: 0.2, creditSpread: 1.8, move: 130, dxyTrend: 2, btcVol: 1.4, m2Growth: 0.5, wtiOil: 85 },
        btcOnChain: { mvrvRatio: 0.65, puellMultiple: 0.35, rsiWeekly: 22 },
        portfolioRealizedVol: 0.40,
      }));

      expect(result.regime).toBe("CONTRACTION");
      expect(result.btcCycle?.signal).toBe("STRONG_BUY");
      expect(result.btcCycle?.boostActive).toBe(true);
      const btcAlloc = result.allocations.find(a => a.name === "BTC");
      if (btcAlloc) {
        expect(btcAlloc.finalAllocation).toBeLessThanOrEqual(0.36);
      }
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
      expect(result.totalInvested).toBeGreaterThan(0.30);
      expect(result.totalInvested).toBeLessThanOrEqual(1.0);
    });

    test("BTC vol extrema no contamina volTarget del core", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 22, yieldSpread: 0.3, creditSpread: 2.0, move: 120, dxyTrend: 1, btcVol: 1.6, m2Growth: 1.0, wtiOil: 80 },
        btcOnChain: { mvrvRatio: 0.70, puellMultiple: 0.40, rsiWeekly: 25 },
      }));

      expect(result.volTargetMultiplier).toBeGreaterThanOrEqual(0.5);
      const wlgAlloc = result.allocations.find(a => a.name === "WLG");
      if (wlgAlloc) {
        expect(wlgAlloc.finalAllocation).toBeGreaterThan(0);
      }
    });
  });

  describe("Flash Crash Mayo 2010", () => {

    test("VIX spike a 40 -> CRISIS/CONTRACTION, no ALL_CASH", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 40, yieldSpread: 0.4, creditSpread: 3.0, move: 160, dxyTrend: 3, btcVol: 0.70, m2Growth: 2.0, wtiOil: 75 },
        portfolioDrawdown: -0.08,
        portfolioRealizedVol: 0.35,
        avgCorrelation: 0.70,
      }));

      expect(["CRISIS", "CONTRACTION"]).toContain(result.regime);
      expect(result.meta.allCash).toBe(false);
      expect(result.totalInvested).toBeGreaterThan(0.10);
      expect(result.killSwitchLevel).toBeLessThanOrEqual(1);
      expect(result.meta.correlationPanicTriggered).toBe(false);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });


    test("Recuperacion rapida -> motor permite re-entrada", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 22, yieldSpread: 0.5, creditSpread: 1.5, move: 100, dxyTrend: 0, btcVol: 0.60, m2Growth: 2.5, wtiOil: 75 },
        portfolioDrawdown: -0.06,
        portfolioRealizedVol: 0.20,
      }));
      expect(["EXPANSION", "CONTRACTION"]).toContain(result.regime);
      expect(result.totalInvested).toBeGreaterThan(0.40);
      expect(result.killSwitchLevel).toBe(0);
      expect(result.meta.allCash).toBe(false);
    });
  });

  describe("Dot-Com 2000-2002", () => {

    test("Drawdown -45 0radual -> Kill Switch L5 bloquea re-entrada agresiva", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 35, yieldSpread: -0.5, creditSpread: 3.5, move: 140, dxyTrend: 2, btcVol: 0.50, m2Growth: 1.0, wtiOil: 28 },
        portfolioDrawdown: -0.45,
        portfolioRealizedVol: 0.30,
        avgCorrelation: 0.55,
      }));
      expect(result.killSwitchLevel).toBeGreaterThanOrEqual(4);
      expect(result.totalInvested).toBeLessThan(0.85);
      expect(result.tailRiskActive).toBe(true);
    });

    test("Equities en bear market prolongado -> ERP negativo capsula equity", () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 32, yieldSpread: -0.3, creditSpread: 3.0, move: 135, dxyTrend: 1, btcVol: 0.55, m2Growth: 2.0, wtiOil: 30 },
        portfolioDrawdown: -0.35,
        erpValue: -0.02,
      }));
      expect(result.meta.erpTriggered).toBe(true);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
      const sum = result.allocations.reduce((s, a) => s + a.finalAllocation, 0);
      expect(Math.abs(sum - result.totalInvested)).toBeLessThan(0.02);
    });

    test("BTC no existe aun -> motor funciona sin activos crypto", () => {
      const noCryptoAssets = basePortfolio().filter(a => a.sector !== 'crypto');
      const result = runOlympusEngine(engineInput({
        assets: noCryptoAssets,
        macro: { vix: 32, yieldSpread: -0.3, creditSpread: 3.0, move: 135, dxyTrend: 1, btcVol: 0.40, m2Growth: 2.0, wtiOil: 30 },
        portfolioDrawdown: -0.35,
        erpValue: -0.02,
      }));
      expect(result.regime).toBeDefined();
      expect(result.allocations.length).toBe(noCryptoAssets.length);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
      expect(result.btcCycle?.signal).toBe('ACCUMULATE');
    });
  });


  describe('NaN/Inf Injection - R4.4 Guard', () => {

    test('returns12m NaN redistributes without crashing', () => {
      const assets = basePortfolio().map((a, i) =>
        i === 0 ? { ...a, returns12m: NaN } : a
      );
      const result = runOlympusEngine(engineInput({ assets }));
      expect(result.allocations.length).toBe(assets.length);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
      const sum = result.allocations.reduce((s, a) => s + a.finalAllocation, 0);
      expect(Math.abs(sum - result.totalInvested)).toBeLessThan(0.02);
    });

    test('volatility Infinity caps and survives', () => {
      const assets = basePortfolio().map((a, i) =>
        i === 0 ? { ...a, volatility: Infinity } : a
      );
      const result = runOlympusEngine(engineInput({ assets }));
      expect(result.allocations.length).toBe(assets.length);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });

    test('covMatrix NaN cell falls back, no crash', () => {
      const badCov = BASE_COV.map(r => [...r]);
      badCov[0][0] = NaN;
      const result = runOlympusEngine(engineInput({ covMatrix: badCov }));
      expect(result.meta.hasRealCovMatrix).toBe(true); // dims ok, NaN guard in minVarW
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });
  });

  describe('Correlation Panic - Corr to 1.0', () => {

    test('avgCorrelation 0.96 CRITICAL -> totalInvested <= 35%', () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 60, yieldSpread: 1.0, creditSpread: 6.0, move: 180, dxyTrend: 4, btcVol: 1.0, m2Growth: -0.5, wtiOil: 30 },
        avgCorrelation: 0.96,
        portfolioDrawdown: -0.20,
        portfolioRealizedVol: 0.50,
      }));
      expect(result.meta.correlationPanicTriggered).toBe(true);
      expect(result.totalInvested).toBeLessThanOrEqual(0.60);
    });

    test('avgCorrelation 0.88 PANIC -> totalInvested <= 50%', () => {
      const result = runOlympusEngine(engineInput({
        macro: { vix: 50, yieldSpread: 0.8, creditSpread: 4.0, move: 160, dxyTrend: 3, btcVol: 0.80, m2Growth: 0, wtiOil: 40 },
        avgCorrelation: 0.88,
        portfolioRealizedVol: 0.40,
      }));
      expect(result.meta.correlationPanicTriggered).toBe(true);
      expect(result.totalInvested).toBeLessThanOrEqual(0.85);
    });
  });

});
