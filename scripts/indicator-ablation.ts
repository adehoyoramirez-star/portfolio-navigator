// ============================================================
// scripts/indicator-ablation.ts
// Prioridad 4 — Ablación por indicador (nivel señal).
// Ejecutar: npx tsx scripts/indicator-ablation.ts
// ============================================================
import { writeFileSync } from "fs";
import { runIndicatorAblation, formatAblationReport, DEFAULT_ABLATION_SPECS } from "../src/core/validation/indicatorAblation";

const { rows, summary } = runIndicatorAblation(DEFAULT_ABLATION_SPECS);
const report = formatAblationReport(rows, summary);
console.log(report);
writeFileSync("indicator_ablation_report.txt", report + "\n", "utf8");
console.log("\n[indicator-ablation] escrito en indicator_ablation_report.txt");
