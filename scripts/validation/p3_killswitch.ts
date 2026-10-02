// ============================================================
// scripts/validation/p3_killswitch.ts
// FASE 2B · P3 — ¿Cómo mide el drawdown el kill switch (base, frecuencia,
// post-escalado) y está bien conectado en el backtest?
//   Réplica exacta del nivel diario con los umbrales exportados.
// Ejecutar: npx tsx scripts/validation/p3_killswitch.ts
// ============================================================

import fs from 'fs';
import { TAIL_RISK_CONFIG } from '../../src/core/config/engineConfig';
import { buildCanonicalDataset, runEngine, CFG } from './sim_core';
import { loadLongDataset, validate } from './data_long';

const KS = TAIL_RISK_CONFIG.KILL_SWITCH;
function level(dd: number): 0 | 1 | 1.5 | 2 | 3 | 4 | 5 {
  const x = Math.abs(dd);
  if (x >= KS.L5.threshold) return 5;
  if (x >= KS.L4.threshold) return 4;
  if (x >= KS.L3.threshold) return 3;
  if (x >= KS.L2.threshold) return 2;
  if (x >= KS.L1_5.threshold) return 1.5;
  if (x >= KS.L1.threshold) return 1;
  return 0;
}
const KEYS = ['L1(12%)', 'L1.5(13.5%)', 'L2(15%)', 'L3(20%)', 'L4(25%)', 'L5(32%)'] as const;

function analyse(name: string, values: number[], dds: number[], days: number[], exposure: number[]) {
  const daily: Record<string, number> = { L1: 0, L1_5: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
  const seen: Record<string, number> = { L1: 0, L1_5: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
  const key = (l: number) => l === 1 ? 'L1' : l === 1.5 ? 'L1_5' : l === 2 ? 'L2' : l === 3 ? 'L3' : l === 4 ? 'L4' : l === 5 ? 'L5' : '';
  let dailyActive = 0, seenActive = 0, seenEvals = 0;
  for (let i = 0; i < dds.length; i++) {
    const l = level(dds[i]);
    if (l > 0) { daily[key(l)]++; dailyActive++; }
    if (days[i] % CFG.rebalanceDays === 0) {
      seenEvals++;
      if (l > 0) { seen[key(l)]++; seenActive++; }
    }
  }
  const maxDD = Math.min(...dds);
  const minExp = Math.min(...exposure);
  const lowExpNoKs = exposure.filter((e, i) => e <= 0.80 && level(dds[i]) === 0).length;
  console.log(`\n  ── ${name} ──`);
  console.log(`    MaxDD serie: ${(maxDD * 100).toFixed(1)}% · min exposición: ${(minExp * 100).toFixed(1)}%`);
  console.log(`    Serie DIARIA  : activo ${dailyActive}/${dds.length} días · ${JSON.stringify(daily)}`);
  console.log(`    ENGINE-SEEN (solo días de rebalanceo, n=${seenEvals}): activo ${seenActive} · ${JSON.stringify(seen)}`);
  console.log(`    Días con exposición ≤80% y nivel 0 (proxy viejo los contaba como L1): ${lowExpNoKs}`);
  return { daily, seen, dailyActive, seenActive, seenEvals, maxDD, minExp };
}

(async () => {
  console.log('='.repeat(104));
  console.log('  P3 — KILL SWITCH: BASE, FRECUENCIA, POST-ESCALADO Y NIVEL DIARIO');
  console.log('='.repeat(104));
  console.log('  Base (código): DD unificado = min(0,(V−peak)/peak) sobre portfolioValue del sleeve');
  console.log('    (src/core/risk/drawdown.ts; backtestEngine.ts L822-824: computeUnifiedDrawdown).');
  console.log('  Frecuencia: el motor solo se evalúa en rebalanceo (dayIndex % 21 === 0, backtestEngine.ts L808).');
  console.log('  Post-escalado: totalInvested = volTarget × tailRisk.overlay, clamp [0.05,1] (olympusV3.ts L1229).');
  console.log('  Conexión: coreMode no se pasa en el runner canónico → kill switch ACTIVO (olympusV3 L1211-1213).');

  const ds = buildCanonicalDataset();
  const R = runEngine(ds);
  const dds = R.recs.map(r => r.drawdown);
  const exp = R.recs.map(r => 1 - r.cash);
  const days = R.recs.map(r => r.day);
  analyse('CANÓNICO (2022-12-30 → 2026-08-24)', R.values, dds, days, exp);

  const out = R.recs.map((r, i) => `${R.dates[i]},${(r.drawdown * 100).toFixed(3)},${level(r.drawdown)},${r.day % 21 === 0 ? 1 : 0},${((1 - r.cash) * 100).toFixed(2)}`);
  fs.writeFileSync('scripts/validation/killswitch_daily_canonical.csv', 'date,dd_pct,ks_level,engine_seen,exposure_pct\n' + out.join('\n') + '\n');
  console.log(`    → serie diaria exportada: scripts/validation/killswitch_daily_canonical.csv`);

  const long = await loadLongDataset();
  if (validate(long).valid) {
    const RL = runEngine(long);
    const ddsL = RL.recs.map(r => r.drawdown);
    const expL = RL.recs.map(r => 1 - r.cash);
    const daysL = RL.recs.map(r => r.day);
    analyse('LARGO (2017-08 → 2026-10, proxies reales)', RL.values, ddsL, daysL, expL);
  } else {
    console.log('  LARGO: dataset inválido → omitido');
  }
})();
