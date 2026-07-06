// ============================================================
// src/lib/riskMetrics.ts — Métricas de riesgo institucionales
// ============================================================
// Añade las métricas que la auditoría externa señaló como faltantes.
// Todas trabajan con arrays de retornos diarios. Anualización ×252.

import { mean } from './stats';

export function sortino(dailyRets: number[], rfAnnual: number = 0.04, targetReturn: number = 0): number {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length < 2) return 0;
  const annualMean = mean(clean) * 252;
  const excessReturn = annualMean - targetReturn;
  const targetDaily = targetReturn / 252;
  const downsideRets = clean.map(r => Math.min(0, r - targetDaily));
  const downVar = downsideRets.reduce((s, v) => s + v * v, 0) / (downsideRets.length - 1);
  const downStd = Math.sqrt(Math.max(0, downVar)) * Math.sqrt(252);
  return downStd > 1e-10 ? excessReturn / downStd : 0;
}

export function downsideDeviation(dailyRets: number[], targetReturn: number = 0): number {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length < 2) return 0;
  const targetDaily = targetReturn / 252;
  const downsideRets = clean.map(r => Math.min(0, r - targetDaily));
  const downVar = downsideRets.reduce((s, v) => s + v * v, 0) / (downsideRets.length - 1);
  return Math.sqrt(Math.max(0, downVar)) * Math.sqrt(252);
}

export function beta(strategyRets: number[], benchmarkRets: number[]): number {
  const minLen = Math.min(strategyRets.length, benchmarkRets.length);
  if (minLen < 20) return 1;
  const s = strategyRets.slice(-minLen);
  const b = benchmarkRets.slice(-minLen);
  const sMean = mean(s), bMean = mean(b);
  let cov = 0, bVar = 0;
  for (let i = 0; i < minLen; i++) { cov += (s[i] - sMean) * (b[i] - bMean); bVar += (b[i] - bMean) ** 2; }
  cov /= (minLen - 1); bVar /= (minLen - 1);
  return bVar > 1e-12 ? cov / bVar : 1;
}

export function alpha(strategyRets: number[], benchmarkRets: number[], rfAnnual: number = 0.04): number {
  const b = beta(strategyRets, benchmarkRets);
  const minLen = Math.min(strategyRets.length, benchmarkRets.length);
  if (minLen < 20) return 0;
  const s = strategyRets.slice(-minLen), bm = benchmarkRets.slice(-minLen);
  const rfDaily = rfAnnual / 252;
  const sExcess = mean(s.map(r => r - rfDaily)) * 252;
  const bExcess = mean(bm.map(r => r - rfDaily)) * 252;
  return sExcess - b * bExcess;
}

export function hhi(weights: number[]): number {
  const clean = weights.filter(w => isFinite(w));
  if (clean.length === 0) return 1;
  const sum = clean.reduce((s, w) => s + Math.abs(w), 0) || 1;
  const normalized = clean.map(w => w / sum);
  return normalized.reduce((s, w) => s + w * w, 0);
}

export function diversificationRatio(weights: number[]): number {
  const n = weights.filter(w => isFinite(w)).length;
  if (n === 0) return 0;
  return 1 / (hhi(weights) * n);
}

export function calmar(cagr: number, maxDrawdown: number): number {
  return maxDrawdown < 0 ? cagr / Math.abs(maxDrawdown) : 0;
}

export function omega(dailyRets: number[], threshold: number = 0): number {
  const clean = dailyRets.filter(r => isFinite(r));
  if (clean.length === 0) return 1;
  let gains = 0, losses = 0;
  for (const r of clean) { if (r > threshold) gains += (r - threshold); else losses += (threshold - r); }
  return losses > 1e-12 ? gains / losses : (gains > 0 ? 99 : 1);
}
