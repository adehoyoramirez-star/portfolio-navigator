import { describe, expect, test } from 'vitest';
import type { TacticalAsset } from '../core/tactical/types';
import {
  applyNarrativeBias,
  parseNarrativesToBiases,
} from '../core/tactical/aiNarrative';

function makeAsset(qualityScore = 50): TacticalAsset {
  return {
    ticker: 'TEST',
    name: 'Test asset',
    sector: 'Technology',
    type: 'ETF',
    exchange: 'TEST',
    currency: 'EUR',
    price: 100,
    priceEur: 100,
    closes: [100, 101],
    volumes: [1_000_000, 1_000_000],
    high52w: 101,
    low52w: 100,
    indicators: null,
    signals: [],
    totalScore: 0,
    qualityScore,
    lastUpdated: null,
    dataSource: 'primary',
    hasRealOHLC: true,
  };
}

describe('AI narrative overlay — auditoría de doble conteo', () => {
  test('no suma sinónimos de la misma narrativa como castigos independientes', () => {
    const { marketWideBias } = parseNarrativesToBiases([
      'recession crash risk-off defensive',
    ]);

    expect(marketWideBias).toBe(-6);
  });

  test('limita el sesgo total de mercado a ±6 puntos', () => {
    const { marketWideBias } = parseNarrativesToBiases([
      'crash risk-off recession',
      'correction bear market risk-off',
      'crash recession risk-off',
    ]);

    expect(marketWideBias).toBe(-6);
  });

  test('limita el impacto combinado por activo', () => {
    const asset = makeAsset();
    applyNarrativeBias(asset, { Technology: 6 }, -6);

    expect(asset.qualityScore).toBe(50);
  });
});
