// ============================================================
// scripts/validation/metrics_unified.ts
// FASE 2C · §1 — DEFINICIONES MATEMÁTICAS UNIFICADAS.
//   ÚNICA implementación de TWR / CAGR / Sharpe / MaxDD / CVaR95 / XIRR.
//   Todo (cuenta, motor, B&H, V1-V6) usa ESTE módulo. Ninguna cifra se
//   calcula con una fórmula distinta en otra parte.
//   Convención (idéntica a sim_core): twr[i] es el retorno del día dates[i+1].
// ============================================================

import { CFG, pct, metrics as coreMetrics, cvarMonthly, xirr } from './sim_core';

export { CFG, pct, xirr, cvarMonthly, coreMetrics };
export const RF = CFG.rf;

/** Índice TWR (base 1). El rendimiento puro de la estrategia. */
export function twrIndex(twr: number[]): number[] {
  const v = [1]; for (const r of twr) v.push(v[v.length - 1] * (1 + r)); return v;
}

/** Métricas de una serie TWR (FULL). */
export function full(twr: number[], dates: string[]) {
  return coreMetrics(twr, twrIndex(twr), dates);
}

/** Ventana por fechas (twr[i] ↔ dates[i+1]). */
export function slice(twr: number[], dates: string[], from: string, to: string) {
  const rs: number[] = []; const ds2: string[] = [];
  for (let i = 0; i < twr.length; i++) { const d = dates[i + 1]; if (d && d >= from && d <= to) { rs.push(twr[i]); ds2.push(d); } }
  if (!rs.length) return null;
  return { m: coreMetrics(rs, twrIndex(rs), [from, ...ds2]), n: rs.length, twr: rs };
}

/** Sharpe de una serie de retornos (misma fórmula que coreMetrics). */
export function sharpeOf(x: number[]): number {
  const mu = x.reduce((a, b) => a + b, 0) / Math.max(1, x.length);
  const sd = Math.sqrt(x.reduce((s, r) => s + (r - mu) ** 2, 0) / Math.max(1, x.length));
  return sd > 0 ? (mu * CFG.dpy - CFG.rf) / (sd * Math.sqrt(CFG.dpy)) : 0;
}

/** Bootstrap pareado por bloques de ΔSharpe (A − B). Devuelve IC95 y mediana. */
export function bootstrapDeltaSharpe(a: number[], b: number[], opts: { block?: number; B?: number; seed?: number } = {}) {
  const D = opts.block ?? 21, B = opts.B ?? 10000;
  let seed = opts.seed ?? 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const m = Math.min(a.length, b.length);
  if (m < D * 2) return { lo: NaN, hi: NaN, median: NaN, n: m };
  const deltas: number[] = [];
  for (let rep = 0; rep < B; rep++) {
    const sa: number[] = [], sb: number[] = []; let total = 0;
    while (total < m) {
      const st = Math.floor(rand() * (m - D));
      for (let j = 0; j < D && total < m; j++, total++) { sa.push(a[st + j]); sb.push(b[st + j]); }
    }
    deltas.push(sharpeOf(sa) - sharpeOf(sb));
  }
  deltas.sort((x, y) => x - y);
  return { lo: deltas[Math.floor(B * 0.025)], hi: deltas[Math.floor(B * 0.975)], median: deltas[Math.floor(B * 0.5)], n: m };
}

/** IC95 del MaxDD observado por bootstrap de bloques (para robustez de DD). */
export function bootstrapMaxDD(x: number[], opts: { block?: number; B?: number; seed?: number } = {}) {
  const D = opts.block ?? 21, B = opts.B ?? 10000;
  let seed = opts.seed ?? 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const m = x.length; if (m < D * 2) return { lo: NaN, hi: NaN, median: NaN };
  const maxdd = (s: number[]) => { const idx = twrIndex(s); let peak = idx[0], dd = 0; for (const v of idx) { if (v > peak) peak = v; const d = v / peak - 1; if (d < dd) dd = d; } return dd; };
  const out: number[] = [];
  for (let rep = 0; rep < B; rep++) {
    const s: number[] = []; let total = 0;
    while (total < m) { const st = Math.floor(rand() * (m - D)); for (let j = 0; j < D && total < m; j++, total++) s.push(x[st + j]); }
    out.push(maxdd(s));
  }
  out.sort((p, q) => p - q);
  return { lo: out[Math.floor(B * 0.025)], hi: out[Math.floor(B * 0.975)], median: out[Math.floor(B * 0.5)] };
}

// Ventanas congeladas (PREREGISTRO_2C §2)
export const WINDOWS = {
  HOLDOUT: ['2018-07-01', '2022-11-30'] as const,
  VISTA: ['2022-12-01', '2099-12-31'] as const,
  FULL: ['2018-07-01', '2099-12-31'] as const,
  Q4_2018: ['2018-10-01', '2018-12-31'] as const,
  COVID: ['2020-02-01', '2020-03-31'] as const,
  Y2022: ['2022-01-01', '2022-12-31'] as const,
};
export type WindowKey = keyof typeof WINDOWS;
