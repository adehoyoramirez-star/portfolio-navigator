// Diagnóstico del detector de oro: techo (multiplier/zone/trim) y suelo (score).
import { detectCycleTops, detectCycleBottoms, type CycleTopInputs } from '../../src/core/risk/cycleTopDetector';

const B: CycleTopInputs = { bondYield10y: 4.2 };
const f = (x?: number) => (x === undefined ? '—' : x.toFixed(2));

console.log('=== TECHO: tipo real × Brent × DXY (sin compras de BC) ===');
console.log('realYield  Brent  DXY    base+relief  mult final  zona     trim');
for (const rr of [0, 1.0, 1.5, 2.0, 2.5, 2.6, 3.0]) {
  for (const [brent, dxy] of [[undefined, undefined], [80, undefined], [100, undefined], [100, 110], [70, 110]] as [number | undefined, number | undefined][]) {
    const inp: CycleTopInputs = { ...B, realYield10y: rr, ...(brent !== undefined ? { brentOil: brent } : {}), ...(dxy !== undefined ? { dxy } : {}) };
    const s = detectCycleTops(inp).signals.find(x => x.ticker === 'PPFB.DE')!;
    console.log(`${f(rr).padStart(9)} ${String(brent ?? '—').padStart(6)} ${String(dxy ?? '—').padStart(5)} ${' '.padStart(11)} ${f(s.allocationMultiplier).padStart(10)}  ${s.zone.padEnd(8)} ${String(s.trimPct).padStart(4)}%`);
  }
}

console.log('\n=== TECHO: efecto de compras de bancos centrales (real 3.0%, Brent 100, DXY 110) ===');
for (const cb of [undefined, 600, 800, 1000, 1200, 1500]) {
  const inp: CycleTopInputs = { ...B, realYield10y: 3.0, brentOil: 100, dxy: 110, ...(cb !== undefined ? { goldCbPurchases: cb } : {}) };
  const s = detectCycleTops(inp).signals.find(x => x.ticker === 'PPFB.DE')!;
  console.log(`  BC ${String(cb ?? '—').padStart(5)} t/año → mult ${f(s.allocationMultiplier)} · ${s.zone} · trim ${s.trimPct}%`);
}

console.log('\n=== SUELO: score bruto vs score tras supresión del techo ===');
console.log('realYield  Brent  DXY    bruto  zona bruta   | con techo  zona final   x');
for (const rr of [1.0, 2.0, 2.5, 2.6, 3.0, 4.0]) {
  for (const [brent, dxy] of [[undefined, undefined], [100, undefined], [100, 110], [120, 115]] as [number | undefined, number | undefined][]) {
    const inp: CycleTopInputs = { ...B, realYield10y: rr, ...(brent !== undefined ? { brentOil: brent } : {}), ...(dxy !== undefined ? { dxy } : {}) };
    const tops = detectCycleTops(inp).signals;
    const raw = detectCycleBottoms(inp).signals.find(x => x.ticker === 'PPFB.DE')!;
    const sup = detectCycleBottoms(inp, tops).signals.find(x => x.ticker === 'PPFB.DE')!;
    console.log(`${f(rr).padStart(9)} ${String(brent ?? '—').padStart(6)} ${String(dxy ?? '—').padStart(5)} ${String(raw.opportunityScore).padStart(6)}  ${raw.zone.padEnd(12)} | ${String(sup.opportunityScore).padStart(8)}  ${sup.zone.padEnd(12)} ${sup.attackMultiplier.toFixed(2)}`);
  }
}
