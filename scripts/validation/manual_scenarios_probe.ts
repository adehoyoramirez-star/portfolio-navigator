// ============================================================
// scripts/validation/manual_scenarios_probe.ts
// Descubre umbrales reales de techos/suelos barriendo cada indicador.
// Solo lectura: no modifica src/.
// Ejecutar: npx tsx scripts/validation/manual_scenarios_probe.ts
// ============================================================
import { detectCycleTops, detectCycleBottoms, type CycleTopInputs } from '../../src/core/risk/cycleTopDetector';

const BASE: CycleTopInputs = { bondYield10y: 4.2 };

function rowTop(label: string, ticker: string, inputs: CycleTopInputs) {
  const t = detectCycleTops(inputs).signals.find(s => s.ticker === ticker)!;
  const b = detectCycleBottoms(inputs).signals.find(s => s.ticker === ticker)!;
  return `${label.padEnd(22)} TOP ${t.zone.padEnd(8)} mult ${t.allocationMultiplier.toFixed(2)} trim ${String(t.trimPct).padStart(3)}%  |  BOTTOM ${b.zone.padEnd(11)} score ${String(b.opportunityScore).padStart(3)} x${b.attackMultiplier.toFixed(2)}`;
}

const sweeps: [string, string, string, (v: number) => CycleTopInputs][] = [
  ['mvrvRatio', 'BTC-EUR', 'BTC ratio',  v => ({ ...BASE, mvrvRatio: v })],
  ['mvrvZScore', 'BTC-EUR', 'BTC Z',     v => ({ ...BASE, mvrvZScore: v })],
  ['puell', 'BTC-EUR', 'BTC Puell',      v => ({ ...BASE, puellMultiple: v })],
  ['btcRsi', 'BTC-EUR', 'BTC RSI-W',     v => ({ ...BASE, btcRsiWeekly: v })],
  ['uranium', 'URNU.DE', 'U spot/LT',    v => ({ ...BASE, uraniumSpotPrice: 100, uraniumLTPrice: v })],
  ['sia', 'VVSM.DE', 'SIA YoY %',        v => ({ ...BASE, siaSalesYoY: v })],
  ['soxRsi', 'VVSM.DE', 'SOX RSI-W',     v => ({ ...BASE, soxRsiWeekly: v })],
  ['realYield', 'PPFB.DE', 'real yield', v => ({ ...BASE, realYield10y: v })],
  ['wlgPE', '0P00000WLG.F', 'WLG P/E',   v => ({ ...BASE, wlgPERatio: v })],
  ['wlgRsi', '0P00000WLG.F', 'WLG RSI-W',v => ({ ...BASE, wlgRsiWeekly: v })],
  ['emxcPE', 'EMXC.DE', 'EMXC P/E',      v => ({ ...BASE, emxcPERatio: v })],
  ['emxcRsi', 'EMXC.DE', 'EMXC RSI-W',   v => ({ ...BASE, emxcRsiWeekly: v })],
  ['dxy', 'EMXC.DE', 'DXY',              v => ({ ...BASE, dxy: v })],
];

const GRIDS: Record<string, number[]> = {
  mvrvRatio: [2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8],
  mvrvZScore: [3, 4, 5, 5.5, 6, 6.5, 7, 7.5, 8.5],
  puell: [1, 1.5, 2, 2.5, 3, 3.5, 4, 5],
  btcRsi: [55, 65, 70, 75, 80, 85, 90],
  uranium: [140, 120, 100, 85, 75, 70, 60],
  sia: [-30, -10, 0, 20, 30, 40, 50, 60],
  soxRsi: [35, 45, 55, 65, 70, 75, 80, 85],
  realYield: [-1, 0, 0.5, 1, 1.5, 2, 2.5],
  wlgPE: [12, 14, 16, 18, 20, 22, 25, 28, 30],
  wlgRsi: [45, 55, 65, 70, 75, 80, 85],
  emxcPE: [8, 10, 12, 14, 18, 22, 26, 30],
  emxcRsi: [25, 35, 45, 55, 65, 75, 85],
  dxy: [95, 100, 103, 106, 110, 115, 120],
};

for (const [key, ticker, label, fn] of sweeps) {
  console.log('\n── ' + label + ' (' + key + ') ───────────────');
  for (const v of GRIDS[key]) console.log('  ' + rowTop(String(v), ticker, fn(v)));
}
