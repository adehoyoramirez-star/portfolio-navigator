// ===============================================
// STATS: Helpers estadísticos compartidos
// ===============================================

export function cleanCloses(closes: number[]): number[] {
  const clean: number[] = [];
  let last = 0;
  for (const c of closes) {
    if (c != null && isFinite(c)) {
      last = c;
    }
    clean.push(last);
  }
  return clean;
}

export function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      const ret = closes[i] / closes[i - 1] - 1;
      if (isFinite(ret)) r.push(ret);
    }
  }
  return r;
}

// FIX-AUDIT-R7 MD-1: Trading-day filtered returns — skips weekend transitions
// where non-crypto prices are forward-filled (Friday repeated Sat/Sun).
// Without this, ~28.5% of daily returns are zeros → volatility underestimated ~15-17%.
// BTC trades 24/7, so it should use unfiltered dailyReturns() with ×365 annualization.
// All other assets use tradingDayReturns() with ×252 annualization.
export function tradingDayReturns(closes: number[], timestamps: number[]): number[] {
  const r: number[] = [];
  if (closes.length !== timestamps.length || closes.length < 2) return r;
  for (let i = 1; i < closes.length; i++) {
    // FIX-AUDIT-R7 MD-1 v2: solo saltar transiciones que TERMINAN en fin de semana.
    // No saltar prevDay=0 (Sun→Mon) porque en datos forward-filled, el precio
    // del domingo = precio del viernes → Sun→Mon = Fri→Mon return real.
    // Perder el lunes descartaría ~20% de los retornos (52 lunes/año).
    const currDay = new Date(timestamps[i] * 1000).getDay();
    if (currDay === 0 || currDay === 6) continue; // skip transitions ending on weekend
    if (closes[i - 1] > 0 && closes[i] > 0) {
      const ret = closes[i] / closes[i - 1] - 1;
      if (isFinite(ret)) r.push(ret);
    }
  }
  return r;
}

export function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

export function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
}

export function std(arr: number[]): number {
  return Math.sqrt(variance(arr));
}

export function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function isPositiveFinite(v: number): boolean {
  return typeof v === 'number' && isFinite(v);
}

// ── FIX-BTC-12M (Oct-2026) ───────────────────────────────────────────────
// Retorno de periodo calculado por FECHA (no por índice de array).
// El enfoque antiguo (closes[closes.length - 253]) era frágil: si el tamaño
// de la serie cacheada cambiaba (lookback 1→2 años), el índice caía en OTRA
// fecha y el "precio de hace 12m" saltaba de golpe (BTC +21.8% en un día).
// Además BTC cotiza 365 días/año: 252 elementos ≈ 8.3 meses, no 12.
//
// Devuelve null si no hay timestamps alineados o historia insuficiente,
// para que el caller use un fallback legacy por índice.
//
// @param closes       serie de cierres (forward-filled por cleanCloses)
// @param timestamps   timestamps UNIX en segundos, alineados con closes
// @param calendarDays lookback en días calendario
export function periodReturnByDate(
  closes: number[],
  timestamps: number[],
  calendarDays: number
): number | null {
  if (closes.length < 2) return null;
  const aligned = timestamps.length === closes.length && timestamps.length > 0;
  if (!aligned) return null;
  const endTs = timestamps[timestamps.length - 1];
  if (!isFinite(endTs) || endTs <= 0) return null;
  const targetTs = endTs - calendarDays * 86400; // 86400s = 1 día
  // última observación con timestamp <= targetTs (asumiendo serie ascendente)
  let idx = -1;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (timestamps[i] <= targetTs) { idx = i; break; }
  }
  if (idx < 0) return null; // sin historia suficiente
  const start = closes[idx];
  const end = closes[closes.length - 1];
  if (!isFinite(start) || start <= 0 || !isFinite(end) || end <= 0) return null;
  return end / start - 1;
}
