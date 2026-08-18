// ============================================================
// ARCHIVO: src/core/validation/baseline.ts
// Prioridad 7 — BASELINE VERSIONADO + comparación (G3).
//
// Congela los outputs del motor (runBacktest) en un snapshot y permite
// comparar una versión nueva contra el baseline para distinguir:
//   - mejora / regresión (métricas)
//   - cambio estructural (returnsSignature distinta → el motor cambió de comportamiento)
//   - cambio esperado (modificación intencional documentada)
//
// NO decide PASS/FAIL por una métrica aislada: entrega deltas para decisión humana.
// ============================================================
import { createHash } from "crypto";
import type { BacktestOutput, BacktestMetrics } from "../backtest/backtestEngine";

export interface BaselineSnapshot {
  createdAt: string;
  label: string;
  metrics: BacktestMetrics;
  benchmarkMetrics: BacktestMetrics;
  institutionalBenchmarkMetrics: BacktestMetrics;
  regimeDays: Record<string, number>;
  rebalanceCount: number;
  transactionCostBps: number;
  totalTransactionCosts: number;
  /** hash de la serie de retornos diarios — detecta cualquier cambio de comportamiento */
  returnsSignature: string;
}

export interface BaselineDiff {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  deltaPct: number;
}

export function hashReturns(dailyReturns: number[]): string {
  // Normalizar a 6 decimales para que el hash sea estable ante ruido float.
  const s = dailyReturns.map(r => r.toFixed(6)).join(",");
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function snapshotFromBacktest(output: BacktestOutput, label: string): BaselineSnapshot {
  // dailyRecords guarda portfolioValue; reconstruimos retornos diarios aproximados.
  const values = output.dailyRecords.map(d => d.portfolioValue);
  const dailyReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    dailyReturns.push(values[i - 1] > 0 ? values[i] / values[i - 1] - 1 : 0);
  }
  return {
    createdAt: new Date().toISOString(),
    label,
    metrics: output.metrics,
    benchmarkMetrics: output.benchmarkMetrics,
    institutionalBenchmarkMetrics: output.institutionalBenchmarkMetrics,
    regimeDays: output.regimeDays,
    rebalanceCount: output.rebalanceCount,
    transactionCostBps: output.transactionCostBps,
    totalTransactionCosts: output.totalTransactionCosts,
    returnsSignature: hashReturns(dailyReturns),
  };
}

export function compareBaselines(prev: BaselineSnapshot, curr: BaselineSnapshot): BaselineDiff[] {
  const fields: (keyof BacktestMetrics)[] = [
    "cagr", "sharpe", "sortino", "maxDrawdown", "calmar", "totalReturn",
    "winRate", "profitFactor", "maxWinStreak", "maxLossStreak", "volatility",
    "betaVsBenchmark", "alphaVsBenchmark", "hhi",
  ];
  const diffs: BaselineDiff[] = [];
  for (const f of fields) {
    const b = prev.metrics[f];
    const c = curr.metrics[f];
    const delta = c - b;
    const deltaPct = b !== 0 ? (delta / Math.abs(b)) * 100 : 0;
    diffs.push({ metric: f, baseline: b, current: c, delta, deltaPct });
  }
  return diffs;
}

export function formatBaselineDiff(prev: BaselineSnapshot, curr: BaselineSnapshot): string {
  const lines: string[] = [];
  lines.push("=".repeat(100));
  lines.push(`  BASELINE vs ACTUAL — ${curr.label}`);
  lines.push(`  baseline: ${prev.createdAt} (${prev.label})`);
  lines.push(`  actual:   ${curr.createdAt} (${curr.label})`);
  lines.push("=".repeat(100));
  if (prev.returnsSignature !== curr.returnsSignature) {
    lines.push("  ⚠️  CAMBIO ESTRUCTURAL: la serie de retornos diarios es distinta.");
    lines.push(`     signature baseline=${prev.returnsSignature} · actual=${curr.returnsSignature}`);
  } else {
    lines.push("  ✅ Sin cambio estructural: misma serie de retornos (cambios solo cosméticos/report).");
  }
  lines.push("");
  lines.push("  " + ["Métrica", "baseline", "actual", "Δ", "Δ%"].map((s, i) => s.padEnd(i === 0 ? 16 : i === 1 ? 12 : 12)).join(""));
  for (const d of compareBaselines(prev, curr)) {
    const sign = d.delta >= 0 ? "+" : "";
    lines.push("  " + [d.metric, d.baseline.toFixed(4), d.current.toFixed(4), `${sign}${d.delta.toFixed(4)}`, `${sign}${d.deltaPct.toFixed(1)}%`].map((s, i) => s.padEnd(i === 0 ? 16 : i === 1 ? 12 : 12)).join(""));
  }
  lines.push("=".repeat(100));
  return lines.join("\n");
}
