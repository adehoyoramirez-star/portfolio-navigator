import fs from 'fs';
let s=fs.readFileSync('src/test/crisisScenarios.test.ts','utf8');
const nan_test = "
  describe('NaN/Inf Injection — Engine R4.4 Guard', () => {

    test('returns12m NaN -> engine redistributes without crashing', () => {
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

    test('volatility Infinity -> engine caps and survives', () => {
      const assets = basePortfolio().map((a, i) =>
        i === 0 ? { ...a, volatility: Infinity } : a
      );
      const result = runOlympusEngine(engineInput({ assets }));
      expect(result.allocations.length).toBe(assets.length);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });

    test('covMatrix NaN cell -> fallback path used, no crash', () => {
      const badCov = BASE_COV.map(r => [...r]);
      badCov[0][0] = NaN;
      const result = runOlympusEngine(engineInput({ covMatrix: badCov }));
      expect(result.meta.hasRealCovMatrix).toBe(false);
      result.allocations.forEach(a => {
        expect(Number.isFinite(a.finalAllocation)).toBe(true);
      });
    });
  });

  describe('Correlation Panic — Corr→1.0', () => {

    test('avgCorrelation 0.96 > CRITICAL -> totalInvested <= 35