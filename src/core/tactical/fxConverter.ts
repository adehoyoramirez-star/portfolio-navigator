// ============================================================
// src/core/tactical/fxConverter.ts
// Conversión de divisas en tiempo real para el motor táctico
//
// PROBLEMA PREVIO: calcPositionSize mezclaba EUR/USD/GBP sin
// convertir. Un activo USD de €500 deducía $2000 de un pool EUR,
// generando un error del ~8% por trade que se acumula.
//
// SOLUCIÓN: Fetchear EUR/USD y EUR/GBP al inicio de cada scan.
// Convertir todos los precios a EUR antes de sizing y P&L.
//
// Nota LSE/GBX: Yahoo Finance devuelve precios LSE en GBX (peniques).
// La edge function táctica DEBE dividir por 100 antes de retornar.
// Si no lo hace, SHEL.L cotizaría como 2500 GBX en lugar de £25,
// y calcPositionSize daría 0 shares (riskPerShare demasiado grande).
// Añadir log de advertencia si price > 1000 para currency GBP.
// ============================================================

export interface FxRates {
  EURUSD:    number;   // USD por 1 EUR (e.g., 1.08)
  EURGBP:    number;   // GBP por 1 EUR (e.g., 0.86)
  fetchedAt: string;
  isStale:   boolean;
}

// Fallback conservador — actualizar si el EUR se mueve >5% desde estos niveles
const FALLBACK_FX: FxRates = {
  EURUSD:    1.08,
  EURGBP:    0.86,
  fetchedAt: '1970-01-01T00:00:00.000Z',
  isStale:   true,
};

// Cache en memoria — una instancia por sesión de navegador
let _cachedRates: FxRates | null = null;
const FX_STALE_MS = 4 * 3600 * 1000; // 4 horas

// ── Fetch de tasas desde Yahoo vía Supabase Edge Function ─────
export async function fetchFxRates(supabase: any): Promise<FxRates> {
  // Reutilizar caché si es reciente
  if (_cachedRates && !_cachedRates.isStale) {
    const ageMs = Date.now() - new Date(_cachedRates.fetchedAt).getTime();
    if (ageMs < FX_STALE_MS) return _cachedRates;
  }

  try {
    const { data, error } = await supabase.functions.invoke('yahoo-finance-tactical', {
      body: { tickers: ['EURUSD=X', 'EURGBP=X'] },
    });

    if (error || !data?.data) {
      throw new Error(`FX fetch error: ${error?.message ?? 'sin data'}`);
    }

    const rawUSD = data.data['EURUSD=X']?.currentPrice;
    const rawGBP = data.data['EURGBP=X']?.currentPrice;

    // Validación de rangos históricos razonables (EUR/USD: 0.90-1.30, EUR/GBP: 0.70-1.00)
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

// ── Conversión de precio en divisa nativa a EUR ───────────────
export function toEur(
  price:    number,
  currency: 'EUR' | 'USD' | 'GBP',
  rates:    FxRates,
): number {
  if (!isFinite(price) || price <= 0) return 0;
  switch (currency) {
    case 'EUR': return price;
    case 'USD': return price / rates.EURUSD;
    case 'GBP': return price / rates.EURGBP;
    default:    return price;
  }
}

// ── Conversión de EUR a divisa nativa ─────────────────────────
export function fromEur(
  eurAmount: number,
  currency:  'EUR' | 'USD' | 'GBP',
  rates:     FxRates,
): number {
  if (!isFinite(eurAmount)) return 0;
  switch (currency) {
    case 'EUR': return eurAmount;
    case 'USD': return eurAmount * rates.EURUSD;
    case 'GBP': return eurAmount * rates.EURGBP;
    default:    return eurAmount;
  }
}

// ── Detección de precios en GBX (peniques) ───────────────────
// Yahoo Finance devuelve precios LSE en GBX para algunos tickers.
// Si un activo GBP tiene precio > 500, probablemente está en GBX.
// La edge function táctica debería normalizar, pero como fallback:
export function normalizeGbxToGbp(price: number, currency: 'EUR' | 'USD' | 'GBP'): number {
  if (currency === 'GBP' && price > 500) {
    console.warn(`[FX] Precio LSE posiblemente en GBX: ${price} → dividiendo por 100 → ${price / 100}`);
    return price / 100;
  }
  return price;
}

// ── Invalidar caché (útil al cambiar de sesión o en tests) ────
export function invalidateFxCache(): void {
  _cachedRates = null;
}

// ── Obtener tasas del caché sin fetch (para uso síncrono) ─────
export function getCachedFxRates(): FxRates {
  return _cachedRates ?? FALLBACK_FX;
}
