// Verificación: el suelo del oro puntúa Δ6m del tipo real y alcanza OPPORTUNITY/EXTREME.
import { detectCycleTops, detectCycleBottoms, type CycleTopInputs } from '../../src/core/risk/cycleTopDetector';

function show(label: string, i: CycleTopInputs) {
  const tops = detectCycleTops(i).signals;
  const t = tops.find(s => s.ticker === 'PPFB.DE')!;
  const b = detectCycleBottoms(i, tops).signals.find(s => s.ticker === 'PPFB.DE')!;
  console.log(
    label.padEnd(40),
    'TOP', t.zone.padEnd(7), 'mult', t.allocationMultiplier.toFixed(2), 'trim', String(t.trimPct).padStart(2) + '%',
    '| BOTTOM', b.zone.padEnd(11), 'score', String(b.opportunityScore).padStart(3), 'x' + b.attackMultiplier.toFixed(2),
  );
}

console.log('='.repeat(112));
show('Δ −1,5pp + Brent 100 (techo SAFE)', { bondYield10y: 4.2, realYield10y: 0, realYield10yPrev6m: 1.5, brentOil: 100 });
show('Δ −1,5pp + Brent 80', { bondYield10y: 4.2, realYield10y: 0, realYield10yPrev6m: 1.5, brentOil: 80 });
show('Δ −1,5pp + Brent 100 + DXY 112', { bondYield10y: 4.2, realYield10y: 1.0, realYield10yPrev6m: 2.5, brentOil: 100, dxy: 112 });
show('Δ +1,5pp (tipo real subiendo)', { bondYield10y: 4.2, realYield10y: 3.0, realYield10yPrev6m: 1.5 });
show('Sin Δ6m (solo nivel 3%)', { bondYield10y: 4.2, realYield10y: 3.0 });
console.log('='.repeat(112));
