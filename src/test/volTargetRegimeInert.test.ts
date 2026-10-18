// Caracteriza un hecho verificado (18-oct-2026): con targetVol 20 % y multiplicador clamp a ≤1 en
// totalInvested, la penalización de régimen solo recorta exposición cuando la vol realizada supera
// ~16 %. Por debajo, el régimen es inerte sobre la exposición. Si alguien cambia targetVol o la
// fórmula de regimeFactor, este test obliga a revisar la decisión (change-control §18).
import { describe, it, expect } from 'vitest';
import { computeVolTargetMultiplier } from '../core/risk/volatilityTarget';
import { VOLATILITY_CONFIG } from '../core/config/engineConfig';

const invested = (realizedVol: number, regimePenalty: number) =>
  Math.min(1, computeVolTargetMultiplier({ targetVol: VOLATILITY_CONFIG.DEFAULT_TARGET_VOL, realizedVol, regimePenalty }).multiplier);

describe('vol target vs penalización de régimen', () => {
  it('con vol realizada baja (≤12 %) el régimen NO reduce la exposición', () => {
    for (const v of [0.08, 0.10, 0.12]) expect(invested(v, 0.739)).toBeCloseTo(invested(v, 1.0), 12);
  });
  it('con vol realizada alta (20 %) el régimen sí reduce la exposición', () => {
    expect(invested(0.20, 0.739)).toBeLessThan(invested(0.20, 1.0));
  });
});
