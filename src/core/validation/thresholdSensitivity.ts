// ============================================================
// ARCHIVO: src/core/validation/thresholdSensitivity.ts
// G4 — SENSIBILIDAD DE UMBRALES + DETECCIÓN DE CLIFFS (Tier 1).
//
// Barre los thresholds REALES de los detectores (no los del WFO) y
// detecta discontinuidades: un desplazamiento pequeño del input que
// produce un salto excesivo de trimPct = "cliff".
//
// Criterio pre-registrado: ΔtrimPct > CLIFF_TRIM_PP (10pp) entre dos
// pasos consecutivos (~0.5% del rango) → cliff → FAIL.
//
// ESTO ES UN DETECTOR, NO UN OPTIMIZADOR: no se ajusta el threshold
// para conseguir PASS. Se reporta el cliff y se propone suavizarlo
// de forma estructural.
// ============================================================
import { detectCycleTops, type CycleTopInputs } from "../risk/cycleTopDetector";

export interface SweepSpec {
  id: string;
  ticker: string;
  center: number;        // umbral nominal que se barre
  rangePct?: number;     // ±% alrededor del center (default 20)
  steps?: number;        // pasos del barrido (default 200 → ~0.5% del rango cada uno)
  build: (v: number) => CycleTopInputs;
}

export interface SweepPoint {
  input: number;
  multiplier: number;
  trimPct: number;
  zone: string;
}

export interface Cliff {
  at: number;            // valor de input donde ocurre el salto
  fromTrimPct: number;
  toTrimPct: number;
  deltaTrimPct: number;
}

export interface SweepResult {
  id: string;
  ticker: string;
  center: number;
  range: [number, number];
  steps: number;
  points: SweepPoint[];
  cliffs: Cliff[];
  verdict: "PASS" | "FAIL";
}

export interface SensitivitySummary {
  total: number;
  pass: number;
  fail: number;
  failIds: string[];
  totalCliffs: number;
}

// Umbral de cliff pre-registrado (spec): salto >10pp de trimPct.
export const CLIFF_TRIM_PP = 10;

export function detectCliffs(points: SweepPoint[], minDeltaPp = CLIFF_TRIM_PP): Cliff[] {
  const cliffs: Cliff[] = [];
  for (let i = 1; i < points.length; i++) {
    const delta = Math.abs(points[i].trimPct - points[i - 1].trimPct);
    if (delta > minDeltaPp) {
      cliffs.push({
        at: points[i].input,
        fromTrimPct: points[i - 1].trimPct,
        toTrimPct: points[i].trimPct,
        deltaTrimPct: delta,
      });
    }
  }
  return cliffs;
}

export function sweepThreshold(spec: SweepSpec): SweepResult {
  const rangePct = spec.rangePct ?? 20;
  const steps = spec.steps ?? 200;
  const lo = spec.center * (1 - rangePct / 100);
  const hi = spec.center * (1 + rangePct / 100);
  const points: SweepPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const v = lo + (hi - lo) * (i / steps);
    const signal = detectCycleTops(spec.build(v)).signals.find(s => s.ticker === spec.ticker);
    if (!signal) continue;
    points.push({
      input: v,
      multiplier: signal.allocationMultiplier,
      trimPct: signal.trimPct,
      zone: signal.zone,
    });
  }
  const cliffs = detectCliffs(points);
  return {
    id: spec.id,
    ticker: spec.ticker,
    center: spec.center,
    range: [lo, hi],
    steps,
    points,
    cliffs,
    verdict: cliffs.length === 0 ? "PASS" : "FAIL",
  };
}

export function runThresholdSensitivity(specs: SweepSpec[]): { results: SweepResult[]; summary: SensitivitySummary } {
  const results = specs.map(sweepThreshold);
  const failIds = results.filter(r => r.verdict === "FAIL").map(r => r.id);
  const summary: SensitivitySummary = {
    total: results.length,
    pass: results.filter(r => r.verdict === "PASS").length,
    fail: failIds.length,
    failIds,
    totalCliffs: results.reduce((n, r) => n + r.cliffs.length, 0),
  };
  return { results, summary };
}

export function formatSensitivityReport(results: SweepResult[], summary: SensitivitySummary): string {
  const lines: string[] = [];
  lines.push("=".repeat(92));
  lines.push("  G4 — SENSIBILIDAD DE UMBRALES (detección de cliffs)");
  lines.push("=".repeat(92));
  lines.push(`  Criterio: ΔtrimPct > ${CLIFF_TRIM_PP}pp entre pasos (~0.5% del rango) → cliff`);
  lines.push("");
  for (const r of results) {
    if (r.verdict === "PASS") {
      lines.push(`  PASS: ${r.id.padEnd(22)} — zona robusta (0 cliffs) en [${r.range[0].toFixed(2)}, ${r.range[1].toFixed(2)}]`);
    } else {
      lines.push(`  FAIL: ${r.id.padEnd(22)} — ${r.cliffs.length} cliff(s)`);
      for (const c of r.cliffs) {
        lines.push(`        cliff alrededor de input=${c.at.toFixed(2)} → trimPct ${c.fromTrimPct}% → ${c.toTrimPct}% (Δ${c.deltaTrimPct.toFixed(0)}pp)`);
      }
    }
  }
  lines.push("");
  lines.push(`  RESUMEN: ${summary.pass}/${summary.total} PASS · ${summary.fail} FAIL · ${summary.totalCliffs} cliffs totales`);
  lines.push("=".repeat(92));
  return lines.join("\n");
}

// ============================================================
// SPECS PRE-REGISTRADAS (ummbrales reales de los detectores).
// Modificar estas specs NO hace PASS automáticamente: solo cambia
// qué se barre. Cualquier cliff reportado requiere decisión estructural.
// ============================================================
export const DEFAULT_SWEEP_SPECS: SweepSpec[] = [
  // BTC — Puell Multiple (tiers duros 2.5 / 3.5 / 5.0)
  { id: "btc-puell-2.5", ticker: "BTC-EUR", center: 2.5, build: v => ({ bondYield10y: 4.0, puellMultiple: v }) },
  { id: "btc-puell-3.5", ticker: "BTC-EUR", center: 3.5, build: v => ({ bondYield10y: 4.0, puellMultiple: v }) },
  { id: "btc-puell-5.0", ticker: "BTC-EUR", center: 5.0, build: v => ({ bondYield10y: 4.0, puellMultiple: v }) },
  // BTC — RSI-W (tiers duros 80 / 85)
  { id: "btc-rsi-80", ticker: "BTC-EUR", center: 80, build: v => ({ bondYield10y: 4.0, btcRsiWeekly: v }) },
  { id: "btc-rsi-85", ticker: "BTC-EUR", center: 85, build: v => ({ bondYield10y: 4.0, btcRsiWeekly: v }) },
  // Semis — SOX/SPX RS Z (tiers duros 1.0 / 1.5 / 2.0)
  { id: "semis-rs-1.0", ticker: "VVSM.DE", center: 1.0, build: v => ({ bondYield10y: 4.0, soxSpyRelativeStrength: v }) },
  { id: "semis-rs-1.5", ticker: "VVSM.DE", center: 1.5, build: v => ({ bondYield10y: 4.0, soxSpyRelativeStrength: v }) },
  { id: "semis-rs-2.0", ticker: "VVSM.DE", center: 2.0, build: v => ({ bondYield10y: 4.0, soxSpyRelativeStrength: v }) },
  // Semis — SOX RSI-W (tiers duros 80 / 85)
  { id: "semis-rsi-80", ticker: "VVSM.DE", center: 80, build: v => ({ bondYield10y: 4.0, soxRsiWeekly: v }) },
  { id: "semis-rsi-85", ticker: "VVSM.DE", center: 85, build: v => ({ bondYield10y: 4.0, soxRsiWeekly: v }) },
  // EMXC — DXY (tiers duros 103 / 106 / 110 / 115)
  { id: "emxc-dxy-103", ticker: "EMXC.DE", center: 103, build: v => ({ bondYield10y: 4.0, dxy: v }) },
  { id: "emxc-dxy-106", ticker: "EMXC.DE", center: 106, build: v => ({ bondYield10y: 4.0, dxy: v }) },
  { id: "emxc-dxy-110", ticker: "EMXC.DE", center: 110, build: v => ({ bondYield10y: 4.0, dxy: v }) },
  { id: "emxc-dxy-115", ticker: "EMXC.DE", center: 115, build: v => ({ bondYield10y: 4.0, dxy: v }) },
  // EMXC — RSI-W (tiers duros 75 / 80 / 85)
  { id: "emxc-rsi-75", ticker: "EMXC.DE", center: 75, build: v => ({ bondYield10y: 4.0, emxcRsiWeekly: v }) },
  { id: "emxc-rsi-80", ticker: "EMXC.DE", center: 80, build: v => ({ bondYield10y: 4.0, emxcRsiWeekly: v }) },
  { id: "emxc-rsi-85", ticker: "EMXC.DE", center: 85, build: v => ({ bondYield10y: 4.0, emxcRsiWeekly: v }) },
  // Uranio — ratio Spot/LT (CONTROL NEGATIVO: rampa suave, 0 cliffs esperados)
  { id: "uranium-ratio-1.2", ticker: "URNU.DE", center: 1.2, build: v => ({ bondYield10y: 4.0, uraniumSpotPrice: v * 100, uraniumLTPrice: 100 }) },
  // Global — regimeShiftPE (CONTROL NEGATIVO: shift suave, 0 cliffs esperados)
  { id: "global-shiftpe-1.5", ticker: "0P00000WLG.F", center: 1.5, build: v => ({ bondYield10y: 4.0, wlgPERatio: 19, regimeShiftPE: v }) },
];
