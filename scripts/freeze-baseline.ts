// ============================================================
// scripts/freeze-baseline.ts
// FASE 0 — Congela el baseline del motor (runBacktest) a un JSON.
// R11 (unificación): usa la ruta de macro CANÓNICA compartida con el panel
// (buildMacroHistoryFromCSV → crédito B + erpValue + avgCorrelation + DXY
// decimal) y el config de producción (useDynamicCovariance: true → DCC-GARCH,
// triggers ERP y correlation-panic activos). Antes duplicaba una fórmula de
// credit spread propia (crédito A) y corría con Ledoit-Wolf sin ERP/panic,
// produciendo un motor distinto al auditado (Sharpe 1.30 vs 1.46).
// Ejecutar: npx tsx scripts/freeze-baseline.ts [label]
// ============================================================
import fs from "fs";
import path from "path";
import { runBacktest } from "../src/core/backtest/backtestEngine";
import { snapshotFromBacktest } from "../src/core/validation/baseline";
import { parseCSVFromText, buildMacroHistoryFromCSV } from "../src/lib/csvBacktestProvider";

const csvPath = path.join(process.cwd(), "historical_data_daily_augmented.csv");
const csvContent = fs.readFileSync(csvPath, "utf8");
const csvData = parseCSVFromText(csvContent);
const macroHistory = buildMacroHistoryFromCSV(csvData, csvData.totalDays);

const label = process.argv[2] ?? "baseline v6.x (motor canónico de producción, R11)";
const output = runBacktest({
  closesHistory: csvData.closesHistory,
  macroHistory,
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
  useDynamicCovariance: true,
});
const snapshot = snapshotFromBacktest(output, label);
fs.writeFileSync("validation_baseline.json", JSON.stringify(snapshot, null, 2), "utf8");
console.log("[freeze-baseline] baseline congelado en validation_baseline.json");
console.log(`  label=${label}`);
console.log(`  returnsSignature=${snapshot.returnsSignature}`);
console.log(`  CAGR=${(snapshot.metrics.cagr * 100).toFixed(2)}% Sharpe=${snapshot.metrics.sharpe.toFixed(3)} MaxDD=${(snapshot.metrics.maxDrawdown * 100).toFixed(1)}% PF=${snapshot.metrics.profitFactor.toFixed(2)}`);
