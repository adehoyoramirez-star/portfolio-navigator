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
