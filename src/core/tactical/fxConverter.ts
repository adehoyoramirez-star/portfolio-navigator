// ============================================================
// src/core/tactical/fxConverter.ts
// Conversión de divisas en tiempo real para el motor táctico
// ============================================================

import { fetchYahooBatch } from '@/lib/yahooFinance';

export interface FxRates {
  EURUSD:    number;
  EURGBP:    number;
  fetchedAt: string;
  isStale:   boolean;
}

const FALLBACK_FX: FxRates = {
  EURUSD:    1.08,
  EURGBP:    0.86,
  fetchedAt: '1970-01-01T00:00:00.000Z',
  isStale:   true,
};

let _cachedRates: FxRates | null = null;
const FX_STALE_MS = 4 * 3600 * 1000;

// ── Fetch de tasas desde Yahoo (directo, sin Supabase) ─────────
export async function fetchFxRates(): Promise<FxRates> {
  if (_cachedRates && !_cachedRates.isStale) {
    const ageMs = Date.now() - new Date(_cachedRates.fetchedAt).getTime();
    if (ageMs < FX_STALE_MS) return _cachedRates;
  }

  try {
    const { data } = await fetchYahooBatch(['EURUSD=X', 'EURGBP=X']);

    if (!data) throw new Error('FX fetch error: sin data');

    const rawUSD = data['EURUSD=X']?.currentPrice;
    const rawGBP = data['EURGBP=X']?.currentPrice;

    if (!rawUSD || rawUSD < 0.80 || rawUSD > 1.40) throw new Error(`EUR/USD inválido: ${rawUSD}`);
    if (!rawGBP || rawGBP < 0.60 || rawGBP > 1.10) throw new Error(`EUR/GBP inválido: ${rawGBP}`);

    _cachedRates = {
      EURUSD:    rawUSD,
      EURGBP:    rawGBP,
      fetchedAt: new Date().toISOString(),
      isStale:   false,
    };

    console.debug(`[FX] Tasas actualizadas: EUR/USD=${rawUSD.toFixed(4)}, EUR/GBP=${rawGBP.toFixed(4)}`);
    return _cachedRates;

  } catch (err: any) {
    console.warn('[FX] Error fetching FX rates, usando fallback:', err?.message ?? err);
    return { ...FALLBACK_FX, isStale: true };
  }
}

export function toEur(price: number, currency: 'EUR' | 'USD' | 'GBP', rates: FxRates): number {
  if (!isFinite(price) || price <= 0) return 0;
  switch (currency) {
    case 'EUR': return price;
    case 'USD': return price / rates.EURUSD;
    case 'GBP': return price / rates.EURGBP;
    default:    return price;
  }
}

export function fromEur(eurAmount: number, currency: 'EUR' | 'USD' | 'GBP', rates: FxRates): number {
  if (!isFinite(eurAmount)) return 0;
  switch (currency) {
    case 'EUR': return eurAmount;
    case 'USD': return eurAmount * rates.EURUSD;
    case 'GBP': return eurAmount * rates.EURGBP;
    default:    return eurAmount;
  }
}

export function normalizeGbxToGbp(price: number, currency: 'EUR' | 'USD' | 'GBP'): number {
  if (currency === 'GBP' && price > 500) {
    console.warn(`[FX] Precio LSE posiblemente en GBX: ${price} → dividiendo por 100 → ${price / 100}`);
    return price / 100;
  }
  return price;
}

export function invalidateFxCache(): void { _cachedRates = null; }

export function getCachedFxRates(): FxRates {
  return _cachedRates ?? FALLBACK_FX;
}
