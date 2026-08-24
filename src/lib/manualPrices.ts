// ===============================================
// ARCHIVO: src/lib/manualPrices.ts
// OVERRIDE MANUAL DE PRECIOS DE ACTIVOS
//
// Permite fijar manualmente el precio de un activo
// (ej. URNU.DE cuando Yahoo falla por rate-limiting).
// El motor usa el precio manual si existe; si no,
// usa el de Yahoo normalmente.
//
// Uso desde consola del navegador:
//   setManualPrice("URNU.DE", 24.06);
//   resetManualPrice("URNU.DE");
//   getManualPrices(); // ver todos los overrides activos
// ===============================================

const STORAGE_KEY = "olympus_manual_prices";

export interface ManualPriceEntry {
  ticker: string;
  price: number;
  setAt: string; // ISO date
  note?: string;
}

export function loadManualPrices(): Record<string, ManualPriceEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return {};
  } catch {
    return {};
  }
}

export function saveManualPrice(
  ticker: string,
  price: number,
  note?: string
): void {
  const all = loadManualPrices();
  all[ticker] = {
    ticker,
    price,
    setAt: new Date().toISOString(),
    note,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    console.warn("[ManualPrices] localStorage lleno — no se guardó", ticker);
  }
}

export function resetManualPrice(ticker: string): void {
  const all = loadManualPrices();
  delete all[ticker];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function resetAllManualPrices(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Devuelve el precio manual si existe para este ticker, o undefined si no. */
export function getManualPrice(ticker: string): number | undefined {
  const entry = loadManualPrices()[ticker];
  if (entry && entry.price > 0) return entry.price;
  return undefined;
}