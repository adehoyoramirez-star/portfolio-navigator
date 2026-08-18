// ============================================================
// ARCHIVO: src/core/validation/indicatorAblation.ts
// Prioridad 4 — ABLACIÓN POR INDICADOR (nivel señal, decisión A).
//
// Mide la contribución marginal de cada indicador a la señal de su
// detector: baseline (todos los indicadores) vs sin indicador X.
//
// IMPORTANTE (FLAG 1): el backtest (backtestEngine) NO consume las
// señales de ciclo; estas solo alimentan Smart DCA + rebalancer + motor
// live vía activeCycleSignals. Por tanto la contribución marginal se mide
// A NIVEL DE SEÑAL (trimPct, multiplier, zone), no en CAGR/Sharpe.
// "delta exposure" ≈ delta de multiplier (el multiplier escala el peso).
//
// NO elimina indicadores automáticamente. NO optimiza pesos.
// ============================================================
import { detectCycleTops, type CycleTopInputs } from "../risk/cycleTopDetector";

export interface IndicatorSpec {
  detector: string;
  ticker: string;
  baseline: CycleTopInputs;
  indicators: { key: keyof CycleTopInputs; label: string }[];
}

export interface IndicatorAblationRow {
  detector: string;
  ticker: string;
  indicator: string;
  baselineTrimPct: number;
  baselineMultiplier: number;
  baselineZone: string;
  withoutTrimPct: number;
  withoutMultiplier: number;
  withoutZone: string;
  deltaTrimPct: number;
  deltaMultiplier: number;
  zoneChanged: boolean;
  contribution: number; // |deltaTrimPct|
  saturated: boolean;   // baseline en el floor (multiplier ≈ mínimo) → ceiling effect
}

function readSignal(inputs: CycleTopInputs, ticker: string) {
  return detectCycleTops(inputs).signals.find(s => s.ticker === ticker)!;
}

export function ablateIndicator(spec: IndicatorSpec, key: keyof CycleTopInputs, label: string): IndicatorAblationRow {
  const base = readSignal(spec.baseline, spec.ticker);
  const without = readSignal({ ...spec.baseline, [key]: undefined }, spec.ticker);
  return {
    detector: spec.detector,
    ticker: spec.ticker,
    indicator: label,
    baselineTrimPct: base.trimPct,
    baselineMultiplier: base.allocationMultiplier,
    baselineZone: base.zone,
    withoutTrimPct: without.trimPct,
    withoutMultiplier: without.allocationMultiplier,
    withoutZone: without.zone,
    deltaTrimPct: without.trimPct - base.trimPct,
    deltaMultiplier: without.allocationMultiplier - base.allocationMultiplier,
    zoneChanged: without.zone !== base.zone,
    contribution: Math.abs(without.trimPct - base.trimPct),
    saturated: base.allocationMultiplier <= 0.16,
  };
}

export function runIndicatorAblation(specs: IndicatorSpec[]): { rows: IndicatorAblationRow[]; summary: string[] } {
  const rows: IndicatorAblationRow[] = [];
  const summary: string[] = [];
  for (const spec of specs) {
    for (const ind of spec.indicators) {
      rows.push(ablateIndicator(spec, ind.key, ind.label));
    }
  }
  // NOTA: NO se elimina nada automáticamente. Los deltas ~0pp tienen dos
  // lecturas distintas que se distinguen por el flag `saturated`:
  //   - saturated=true  → ceiling effect (baseline en EXTREME): el techo está
  //     sobre-determinado por múltiples confirmaciones. NO es redundancia.
  //   - saturated=false → el indicador está por debajo de su umbral de
  //     activación en ese escenario (inactivo, no informativo aquí).
  const saturatedZeros = rows.filter(r => r.contribution < 1 && r.saturated);
  const inactiveZeros = rows.filter(r => r.contribution < 1 && !r.saturated && !r.zoneChanged);
  for (const r of saturatedZeros) {
    summary.push(`${r.detector} · ${r.indicator}: 0pp por SATURACIÓN (techo sobre-determinado, no redundante)`);
  }
  for (const r of inactiveZeros) {
    summary.push(`${r.detector} · ${r.indicator}: 0pp por debajo del umbral de activación en este escenario`);
  }
  return { rows, summary };
}

export function formatAblationReport(rows: IndicatorAblationRow[], summary: string[]): string {
  const lines: string[] = [];
  lines.push("=".repeat(100));
  lines.push("  ABLACIÓN POR INDICADOR (nivel señal) — contribución marginal");
  lines.push("=".repeat(100));
  lines.push("  ΔtrimPct = trimPct(sin indicador) − trimPct(baseline). Negativo = el indicador suma trim.");
  lines.push("  SAT = baseline saturado (ceiling effect: quitar uno no mueve el veredicto EXTREME).");
  lines.push("");
  lines.push("  " + ["Detector", "Indicador", "base trim", "sin trim", "Δtrim", "Δmult", "zona", "SAT"].map((s, i) => s.padEnd(i === 0 ? 12 : i === 1 ? 18 : 10)).join(""));
  for (const r of rows) {
    const zone = r.zoneChanged ? `${r.baselineZone}→${r.withoutZone}` : r.baselineZone;
    lines.push("  " + [r.detector, r.indicator, `${r.baselineTrimPct}%`, `${r.withoutTrimPct}%`, `${r.deltaTrimPct >= 0 ? "+" : ""}${r.deltaTrimPct}pp`, `${r.deltaMultiplier >= 0 ? "+" : ""}${r.deltaMultiplier.toFixed(2)}`, zone, r.saturated ? "⚠" : ""].map((s, i) => s.padEnd(i === 0 ? 12 : i === 1 ? 18 : 10)).join(""));
  }
  lines.push("");
  lines.push("  LECTURA (0pp):");
  if (summary.length === 0) {
    lines.push("    todos los indicadores aportan señal en su escenario.");
  } else {
    for (const s of summary) lines.push("    - " + s);
  }
  lines.push("=".repeat(100));
  return lines.join("\n");
}

// ============================================================
// ESCENARIOS DE ABLACIÓN (pre-registrados): escenarios "techo"
// representativos por detector.
// ============================================================
export const DEFAULT_ABLATION_SPECS: IndicatorSpec[] = [
  {
    detector: "BTC",
    ticker: "BTC-EUR",
    baseline: { bondYield10y: 4.0, mvrvZScore: 8, puellMultiple: 5, btcRsiWeekly: 90, btcDominanceFalling: true },
    indicators: [
      { key: "mvrvZScore", label: "MVRV Z-Score" },
      { key: "puellMultiple", label: "Puell Multiple" },
      { key: "btcRsiWeekly", label: "RSI-W BTC" },
      { key: "btcDominanceFalling", label: "BTC.D cayendo" },
    ],
  },
  {
    detector: "Uranium",
    ticker: "URNU.DE",
    baseline: { bondYield10y: 4.0, uraniumSpotPrice: 150, uraniumLTPrice: 100 },
    indicators: [
      { key: "uraniumSpotPrice", label: "Spot (ratio Spot/LT)" },
      { key: "uraniumLTPrice", label: "LT price (ratio Spot/LT)" },
    ],
  },
  {
    detector: "Semis",
    ticker: "VVSM.DE",
    baseline: { bondYield10y: 4.0, soxSpyRelativeStrength: 2.5, soxRsiWeekly: 90 },
    indicators: [
      { key: "soxSpyRelativeStrength", label: "SOX/SPX RS Z" },
      { key: "soxRsiWeekly", label: "SOX RSI-W" },
    ],
  },
  {
    detector: "EMXC",
    ticker: "EMXC.DE",
    baseline: { bondYield10y: 4.0, dxy: 116, emxcRsiWeekly: 88 },
    indicators: [
      { key: "dxy", label: "DXY" },
      { key: "emxcRsiWeekly", label: "RSI-W EM" },
    ],
  },
  {
    detector: "Gold",
    ticker: "PPFB.DE",
    baseline: { bondYield10y: 4.0, inflationBreakeven: 1.5, brentOil: 83, goldCbPurchases: 450 },
    indicators: [
      { key: "inflationBreakeven", label: "Breakeven 5y" },
      { key: "brentOil", label: "Brent" },
      { key: "goldCbPurchases", label: "BC compras oro" },
    ],
  },
  {
    detector: "WLG",
    ticker: "0P00000WLG.F",
    baseline: { bondYield10y: 4.0, wlgRsiWeekly: 85, wlgPERatio: 25, wlgEpsGrowth: 3, creditSpread: 1.2 },
    indicators: [
      { key: "wlgRsiWeekly", label: "RSI-W WLG" },
      { key: "wlgPERatio", label: "P/E Forward" },
      { key: "wlgEpsGrowth", label: "EPS Growth" },
      { key: "creditSpread", label: "Credit Spread" },
    ],
  },
];
