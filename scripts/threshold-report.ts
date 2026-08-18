// ============================================================
// scripts/threshold-report.ts
// G4 — Genera el informe legible de sensibilidad de umbrales.
// Ejecutar: npx tsx scripts/threshold-report.ts
// Escribe threshold_sensitivity_report.txt (auditable) y lo imprime.
// ============================================================
import { writeFileSync } from "fs";
import {
  runThresholdSensitivity,
  formatSensitivityReport,
  DEFAULT_SWEEP_SPECS,
} from "../src/core/validation/thresholdSensitivity";

const { results, summary } = runThresholdSensitivity(DEFAULT_SWEEP_SPECS);
const report = formatSensitivityReport(results, summary);

console.log(report);
writeFileSync("threshold_sensitivity_report.txt", report + "\n", "utf8");
console.log("\n[threshold-report] escrito en threshold_sensitivity_report.txt");
