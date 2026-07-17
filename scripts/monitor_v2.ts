// Monitorizacion institucional: Tier 1 (semanal) + Tier 2 (mensual)
// Metricas: Sharpe, Sortino, Calmar, CAGR, MaxDD, Vol, Win Rate,
//   Recovery Factor, Ulcer Index, Turnover, Monthly P&L, EW benchmark
// Ejecutar: npx tsx scripts/monitor_v2.ts [--monthly]
//   Sin flag: Tier 1 (semanal)
//   --monthly: Tier 1 + Tier 2 completo

import fs from 'fs';
import path from 'path';

const isMonthly = process.argv.includes('--monthly');

// ── Cargar paper trading log ──
const logPath = path.join(process.cwd(), 'paper_trading_log.csv');
if (!fs.existsSync(logPath)) {
  console.log('ERROR: paper_trading_log.csv not found. Run paper_trading.ts first.');
  process.exit(1);
}

const logContent = fs.readFileSync(logPath, 'utf8');
const logLines = logContent.split('\n').filter(l => l.trim());
const logHeaders = logLines[0].split(',');

// Detect format: legacy (6 cols) vs institutional (9 cols)
const isInstitutional = logHeaders.length >= 9;
const formatLabel = isInstitutional ? 'INSTITUCIONAL (dual tracking)' : 'LEGACY';

const dates: string[] = [];
const values: number[] = [];          // motorValue in new format
const frozenValues: number[] = [];    // frozenValue in new format
const drawdowns: number[] = [];
const regimes: string[] = [];
const allocStrings: string[] = [];
const rebalanceFlags: string[] = [];
const legacyPnLs: number[] = [];      // legacy P&L (col 7)
const alphaDailies: number[] = [];    // alpha daily (col 8)

for (let i = 1; i < logLines.length; i++) {
  const parts = logLines[i].split(',');
  if (parts.length < 4) continue;
  dates.push(parts[0]);
  if (isInstitutional) {
    values.push(parseFloat(parts[1]));          // motorValue
    frozenValues.push(parseFloat(parts[2]));    // frozenValue
    drawdowns.push(parseFloat(parts[3].replace('%', '')) / 100);
    regimes.push(parts[4]);
    allocStrings.push(parts[5] || '');
    rebalanceFlags.push(parts[6] || 'N');
    legacyPnLs.push(parseFloat(parts[7]) || 0);
    alphaDailies.push(parseFloat(parts[8]) || 0);
  } else {
    values.push(parseFloat(parts[1]));
    drawdowns.push(parseFloat(parts[2].replace('%', '')) / 100);
    regimes.push(parts[3]);
    allocStrings.push(parts[4] || '');
    rebalanceFlags.push(parts[5] || 'N');
  }
}

const minData = isMonthly ? 60 : 20;
if (values.length < minData) {
  console.log('Insufficient data: ' + values.length + ' entries. Need ' + minData + '.');
  process.exit(1);
}

const modeLabel = isMonthly ? 'MENSUAL (Tier 1 + Tier 2)' : 'SEMANAL (Tier 1)';
console.log('OLYMPUS V3+ — Monitorizacion ' + modeLabel);
console.log('='.repeat(70));
console.log('Formato: ' + formatLabel);
console.log('Periodo: ' + dates[0] + ' -> ' + dates[dates.length-1]);
console.log('Dias: ' + values.length);
if (isInstitutional && legacyPnLs.length > 0) {
  console.log('Legacy P&L (archivado): €' + legacyPnLs[legacyPnLs.length-1].toFixed(0));
  console.log('Forward P&L (motor):    €' + (values[values.length-1] - values[0]).toFixed(0));
}

// ── Retornos diarios ──
const returns: number[] = [];
for (let i = 1; i < values.length; i++) {
  returns.push(values[i] / values[i-1] - 1);
}

// ── TIER 1: Metricas basicas ──
const meanRet = returns.reduce((a,b) => a+b, 0) / returns.length;
const variance = returns.reduce((s, r) => s + (r-meanRet)**2, 0) / returns.length;
const dailyStd = Math.sqrt(Math.max(1e-16, variance));
const annVol = dailyStd * Math.sqrt(252);
const annRet = meanRet * 252;
const sharpe = (annRet - 0.04) / Math.max(0.01, annVol);

// CAGR
let totalReturn = 1.0;
for (const r of returns) totalReturn *= (1 + r);
const years = returns.length / 252;
const cagr = totalReturn ** (1 / Math.max(0.01, years)) - 1;

// MaxDD
let peak = values[0];
let maxDD = 0;
let peakIdx = 0;
let troughIdx = 0;
let currentPeak = values[0];
let currentPeakIdx = 0;
for (let i = 1; i < values.length; i++) {
  if (values[i] > currentPeak) {
    currentPeak = values[i];
    currentPeakIdx = i;
  }
  const dd = (values[i] - currentPeak) / currentPeak;
  if (dd < maxDD) {
    maxDD = dd;
    peakIdx = currentPeakIdx;
    troughIdx = i;
  }
}
const recoveryDays = troughIdx > peakIdx && troughIdx < values.length - 1
  ? (() => { for (let i = troughIdx+1; i < values.length; i++) if (values[i] >= values[peakIdx]) return i - troughIdx; return -1; })()
  : -1;

// Rolling Sharpe 12m
let rollingSharpe = 0;
if (returns.length >= 252) {
  const recent = returns.slice(-252);
  const rMean = recent.reduce((a,b) => a+b, 0) / recent.length;
  const rVar = recent.reduce((s, r) => s + (r-rMean)**2, 0) / recent.length;
  const rStd = Math.sqrt(Math.max(1e-16, rVar));
  rollingSharpe = (rMean * 252 - 0.04) / Math.max(0.01, rStd * Math.sqrt(252));
}

// Regime distribution
const regimeCount: Record<string, number> = { EXPANSION: 0, CONTRACTION: 0, CRISIS: 0 };
regimes.forEach(r => { regimeCount[r] = (regimeCount[r] || 0) + 1; });
const expansionRatio = (regimeCount['EXPANSION'] || 0) / regimes.length;
const crisisDays = regimeCount['CRISIS'] || 0;
const contractionDays = regimeCount['CONTRACTION'] || 0;

// ── TIER 2: Metricas avanzadas (solo --monthly) ──
let sortino = 0, calmar = 0, recoveryFactor = 0, winRate = 0;
let maxConsecutiveLossDays = 0, ulcerIndex = 0, monthlyPosRatio = 0;
let avgTurnover = 0, avgCostsBps = 0;
let ewSharpe = 0, sharpeDiffVsEW = 0;
let frozenSharpe = 0, frozenCagr = 0, frozenMaxDD = 0, frozenVol = 0;
let alphaCagr = 0, alphaMeanDaily = 0, alphaTStat = 0, alphaSignificant = false;
let alphaWinRate = 0;

if (isMonthly) {
  // Sortino: usa solo retornos negativos para la desviacion
  const negReturns = returns.filter(r => r < 0);
  if (negReturns.length > 0) {
    const downsideVar = negReturns.reduce((s, r) => s + r**2, 0) / returns.length;
    const downsideStd = Math.sqrt(Math.max(1e-16, downsideVar));
    sortino = (annRet - 0.04) / Math.max(0.01, downsideStd * Math.sqrt(252));
  }

  // Calmar: CAGR / |MaxDD|
  calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;

  // Recovery Factor: retorno total / |MaxDD|
  recoveryFactor = maxDD < 0 ? (totalReturn - 1) / Math.abs(maxDD) : 0;

  // Win Rate
  const positiveDays = returns.filter(r => r > 0).length;
  winRate = returns.length > 0 ? positiveDays / returns.length : 0;

  // Max consecutive loss days
  let consecutiveLoss = 0;
  for (const r of returns) {
    if (r < 0) {
      consecutiveLoss++;
      maxConsecutiveLossDays = Math.max(maxConsecutiveLossDays, consecutiveLoss);
    } else {
      consecutiveLoss = 0;
    }
  }

  // Ulcer Index
  let sumSqDD = 0;
  for (const dd of drawdowns) sumSqDD += dd * dd;
  ulcerIndex = drawdowns.length > 0 ? Math.sqrt(sumSqDD / drawdowns.length) : 0;

  // Monthly P&L consistency
  const monthlyPL: Record<string, number> = {};
  let currentMonth = '';
  let monthStartVal = values[0];
  for (let i = 0; i < values.length; i++) {
    const month = dates[i].substring(0, 7);
    if (month !== currentMonth) {
      if (currentMonth && monthStartVal > 0) {
        monthlyPL[currentMonth] = values[i-1] / monthStartVal - 1;
      }
      currentMonth = month;
      monthStartVal = values[i];
    }
  }
  if (currentMonth && monthStartVal > 0) {
    monthlyPL[currentMonth] = values[values.length-1] / monthStartVal - 1;
  }
  const positiveMonths = Object.values(monthlyPL).filter(pl => pl > 0).length;
  monthlyPosRatio = Object.keys(monthlyPL).length > 0
    ? positiveMonths / Object.keys(monthlyPL).length : 0;

  // Turnover: calcular en dias de rebalanceo comparando allocs actual vs anterior
  const turnovers: number[] = [];
  let prevAlloc: Record<string, number> | null = null;
  for (let i = 0; i < allocStrings.length; i++) {
    if (rebalanceFlags[i] !== 'Y') continue;
    const allocMap: Record<string, number> = {};
    const pairs = allocStrings[i].split('|');
    for (const p of pairs) {
      const [ticker, pctStr] = p.split(':');
      if (ticker && pctStr) allocMap[ticker] = parseFloat(pctStr.replace('%', '')) / 100;
    }
    if (prevAlloc) {
      let turnover = 0;
      const allTickers = new Set([...Object.keys(prevAlloc), ...Object.keys(allocMap)]);
      for (const t of allTickers) {
        turnover += Math.abs((allocMap[t] || 0) - (prevAlloc[t] || 0));
      }
      turnovers.push(turnover / 2); // one-way
    }
    prevAlloc = allocMap;
  }
  avgTurnover = turnovers.length > 0 ? turnovers.reduce((a,b)=>a+b,0) / turnovers.length : 0;
  avgCostsBps = avgTurnover * 15; // 15bps por operacion

  // ── FROZEN BENCHMARK (solo si formato institucional) ──
  if (isInstitutional && frozenValues.length > 0) {
    const frozenReturns: number[] = [];
    for (let i = 1; i < frozenValues.length; i++) {
      frozenReturns.push(frozenValues[i-1] > 0 ? frozenValues[i] / frozenValues[i-1] - 1 : 0);
    }
    if (frozenReturns.length > 0) {
      const fMean = frozenReturns.reduce((a,b)=>a+b,0)/frozenReturns.length;
      const fVar = frozenReturns.reduce((s,r)=>s+(r-fMean)**2,0)/frozenReturns.length;
      const fStd = Math.sqrt(Math.max(1e-16, fVar));
      frozenSharpe = (fMean*252 - 0.04) / Math.max(0.01, fStd*Math.sqrt(252));
      let fTR = 1.0;
      for (const r of frozenReturns) fTR *= (1+r);
      const fYears = Math.max(0.01, frozenReturns.length/252);
      frozenCagr = fTR ** (1/fYears) - 1;
      frozenVol = fStd * Math.sqrt(252);
      let fPeak = frozenValues[0];
      for (const v of frozenValues) {
        if (v > fPeak) fPeak = v;
        const dd = (v - fPeak) / fPeak;
        if (dd < frozenMaxDD) frozenMaxDD = dd;
      }
    }

    // Alpha: from alphaDaily column
    if (alphaDailies.length > 0) {
      const validAlphas = alphaDailies.slice(1).filter(a => !isNaN(a) && isFinite(a));
      if (validAlphas.length > 0) {
        alphaMeanDaily = validAlphas.reduce((a,b)=>a+b,0)/validAlphas.length;
        alphaCagr = alphaMeanDaily * 252;
        const alphaVar = validAlphas.reduce((s,a)=>s+(a-alphaMeanDaily)**2,0)/validAlphas.length;
        const alphaStd = Math.sqrt(Math.max(1e-16, alphaVar));
        alphaTStat = alphaMeanDaily / Math.max(1e-10, alphaStd/Math.sqrt(validAlphas.length));
        alphaSignificant = Math.abs(alphaTStat) > 1.96;
        alphaWinRate = validAlphas.filter(a => a > 0).length / validAlphas.length;
      }
    }
  }
}

// ── EW Benchmark (desde CSV) ──
let ewReturns: number[] = [];
try {
  const csvPath = path.join(process.cwd(), 'historical_data_daily_augmented.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const csvLines = csvContent.split('\n');
  const csvHeaders = csvLines[0].split(',');
  const assets = ['BTC-EUR','EMXC.DE','0P00000WLG.F','PPFB.DE','URNU.DE','VVSM.DE'];
  const csvDates: string[] = [];
  const csvCloses: Record<string, number[]> = {};
  for (const a of assets) csvCloses[a] = [];

  for (let i = 1; i < csvLines.length; i++) {
    const parts = csvLines[i].split(',');
    if (parts.length < csvHeaders.length) continue;
    csvDates.push(parts[0]);
    for (const a of assets) {
      const idx = csvHeaders.indexOf(a);
      csvCloses[a].push(idx >= 0 ? parseFloat(parts[idx]) || 0 : 0);
    }
  }

  // Alinear EW con las fechas del paper trading
  const ewVals: number[] = [];
  for (const date of dates) {
    const csvIdx = csvDates.findIndex(d => d >= date);
    if (csvIdx < 0) continue;
    let ew = 0;
    let count = 0;
    for (const a of assets) {
      const v = csvCloses[a][csvIdx];
      if (v > 0) { ew += v; count++; }
    }
    ewVals.push(count > 0 ? ew / count : 0);
  }

  if (ewVals.length > 0 && ewVals[0] > 0 && values[0] > 0) {
    const scale = values[0] / ewVals[0];
    const ewValsScaled = ewVals.map(v => v * scale);
    const ewRets: number[] = [];
    for (let i = 1; i < ewValsScaled.length; i++) {
      ewRets.push(ewValsScaled[i] / ewValsScaled[i-1] - 1);
    }
    if (ewRets.length > 0) {
      const ewMean = ewRets.reduce((a,b)=>a+b,0)/ewRets.length;
      const ewVar = ewRets.reduce((s,r)=>s+(r-ewMean)**2,0)/ewRets.length;
      const ewStd = Math.sqrt(Math.max(1e-16, ewVar));
      ewSharpe = (ewMean*252 - 0.04) / Math.max(0.01, ewStd*Math.sqrt(252));
      sharpeDiffVsEW = sharpe - ewSharpe;
      ewReturns = ewRets;
    }
  }
} catch (_e) {
  // EW benchmark not available — skip
}

// ── Backtest references ──
const BT = {
  sharpe: 0.74, cagr: 0.126, maxDD: -0.27, vol: 0.12, sortino: 1.62,
  calmar: 0.47, recoveryFactor: 1.85, winRate: 0.53,
  expansionRatio: 0.70, crisisDaysPerYear: 30, ulcerIndex: 0.08,
  avgTurnover: 0.15, maxConsecutiveLoss: 12,
};

// ── OUTPUT ──
console.log('\n--- TIER 1: Metricas Semanales ---');
console.log('Sharpe (anualizado):    ' + sharpe.toFixed(3) + '  (BT: ' + BT.sharpe.toFixed(2) + ')');
console.log('CAGR:                   ' + (cagr*100).toFixed(2) + '%  (BT: ' + (BT.cagr*100).toFixed(1) + '%)');
console.log('MaxDD:                  ' + (maxDD*100).toFixed(2) + '%  (BT: ' + (BT.maxDD*100).toFixed(1) + '%)');
console.log('Volatilidad anual:      ' + (annVol*100).toFixed(2) + '%  (BT: ' + (BT.vol*100).toFixed(1) + '%)');
if (returns.length >= 252) {
  console.log('Sharpe rolling 12m:     ' + rollingSharpe.toFixed(3) + '  (alerta < 0.45)');
}
console.log('Ratio EXPANSION:        ' + (expansionRatio*100).toFixed(0) + '%  (BT: ~' + (BT.expansionRatio*100).toFixed(0) + '%)');
console.log('Dias CRISIS:            ' + crisisDays + '  (BT: ~' + BT.crisisDaysPerYear + '/ano)');
console.log('Dias CONTRACTION:       ' + contractionDays);

if (isMonthly) {
  console.log('\n--- TIER 2: Metricas Mensuales ---');
  console.log('Sortino Ratio:          ' + sortino.toFixed(3) + '  (BT: ' + BT.sortino.toFixed(2) + ')');
  console.log('Calmar Ratio:           ' + calmar.toFixed(3) + '  (BT: ' + BT.calmar.toFixed(2) + ')');
  console.log('Recovery Factor:        ' + recoveryFactor.toFixed(2) + '  (BT: ' + BT.recoveryFactor.toFixed(2) + ')');
  console.log('Win Rate:               ' + (winRate*100).toFixed(1) + '%  (BT: ~' + (BT.winRate*100).toFixed(0) + '%)');
  console.log('Max Consec. Loss Days:  ' + maxConsecutiveLossDays + '  (BT: ~' + BT.maxConsecutiveLoss + ')');
  console.log('Ulcer Index:            ' + ulcerIndex.toFixed(3) + '  (BT: ' + BT.ulcerIndex.toFixed(2) + ')');
  console.log('Monthly P&L Positive:   ' + (monthlyPosRatio*100).toFixed(0) + '%  (BT: ~60%)');
  console.log('Avg Turnover (one-way): ' + (avgTurnover*100).toFixed(1) + '%  (BT: ~' + (BT.avgTurnover*100).toFixed(0) + '%)');
  console.log('Est. Costs / rebalance: ' + avgCostsBps.toFixed(1) + ' bps');
  if (ewReturns.length > 0) {
    console.log('EW Sharpe:              ' + ewSharpe.toFixed(3));
    console.log('Sharpe Diff vs EW:      ' + (sharpeDiffVsEW >= 0 ? '+' : '') + sharpeDiffVsEW.toFixed(3) + '  (BT: -0.03)');
  }
  if (recoveryDays > 0) console.log('Recovery del MaxDD:     ' + recoveryDays + ' dias');
  else if (recoveryDays === -1) console.log('Recovery del MaxDD:     NO recuperado aun');

  // ── ALPHA & FROZEN BENCHMARK ──
  if (isInstitutional && frozenValues.length > 0) {
    console.log('\n--- BENCHMARK CONGELADO (Do-Nothing) ---');
    console.log('Motor  Sharpe:          ' + sharpe.toFixed(3));
    console.log('Frozen Sharpe:          ' + frozenSharpe.toFixed(3));
    console.log('Motor  CAGR:            ' + (cagr*100).toFixed(2) + '%');
    console.log('Frozen CAGR:            ' + (frozenCagr*100).toFixed(2) + '%');
    console.log('Motor  MaxDD:           ' + (maxDD*100).toFixed(2) + '%');
    console.log('Frozen MaxDD:           ' + (frozenMaxDD*100).toFixed(2) + '%');
    console.log('Motor  Vol:             ' + (annVol*100).toFixed(2) + '%');
    console.log('Frozen Vol:             ' + (frozenVol*100).toFixed(2) + '%');
    console.log('Motor  Final (€):       ' + values[values.length-1].toFixed(0));
    console.log('Frozen Final (€):       ' + frozenValues[frozenValues.length-1].toFixed(0));

    console.log('\n--- ALPHA (Motor - Frozen) ---');
    console.log('Alpha CAGR (anual):    ' + (alphaCagr >= 0 ? '+' : '') + (alphaCagr*100).toFixed(2) + '%');
    console.log('Alpha t-statistic:     ' + alphaTStat.toFixed(3));
    console.log('Alpha significativo:   ' + (alphaSignificant ? '✅ SI (95%)' : '❌ NO'));
    console.log('Alpha Win Rate:        ' + (alphaWinRate*100).toFixed(1) + '% de dias alpha > 0');

    if (alphaSignificant && alphaCagr > 0) {
      console.log('✅ EL MOTOR GENERA VALOR — alpha positivo y significativo.');
    } else if (alphaSignificant && alphaCagr < 0) {
      console.log('🔴 EL MOTOR DESTRUYE VALOR — alpha negativo y significativo.');
    } else {
      console.log('🟡 Alpha no significativo — continuar monitoreando.');
    }
  }
}

// ── Alerta con contexto de mercado ──
console.log('\n--- ALERTAS ---');

// Detectar contexto de mercado
const recentReturns = returns.slice(-Math.min(60, returns.length));
const recentMean = recentReturns.reduce((a,b)=>a+b,0)/recentReturns.length;
const marketBias = recentMean > 0.001 ? 'BULL' : recentMean < -0.001 ? 'BEAR' : 'NEUTRAL';
const inCrisis = crisisDays > 5;

console.log('Contexto mercado: ' + marketBias + (inCrisis ? ' + CRISIS' : ''));

const alerts: { level: string; msg: string }[] = [];

// Tier 1 alerts
if (maxDD < -0.40) alerts.push({ level: 'CRITICO', msg: 'MaxDD > 40% (' + (maxDD*100).toFixed(1) + '%). PAUSAR operaciones.' });
if (returns.length >= 252 && rollingSharpe < 0.30) alerts.push({ level: 'CRITICO', msg: 'Sharpe rolling 12m < 0.30 (' + rollingSharpe.toFixed(2) + '). PAUSAR.' });
if (returns.length >= 252 && rollingSharpe < 0.45 && rollingSharpe >= 0.30) alerts.push({ level: 'WARNING', msg: 'Sharpe rolling 12m < 0.45 (' + rollingSharpe.toFixed(2) + ').' });
if (annVol > 0.25) alerts.push({ level: 'CRITICO', msg: 'Volatilidad > 25% (' + (annVol*100).toFixed(1) + '%).' });
if (annVol > 0.20 && annVol <= 0.25) alerts.push({ level: 'WARNING', msg: 'Volatilidad > 20% (' + (annVol*100).toFixed(1) + '%).' });

// Context-aware: no alertar por baja expansion en bear market (es el motor funcionando)
if (expansionRatio < 0.20 && marketBias !== 'BEAR' && !inCrisis) {
  alerts.push({ level: 'WARNING', msg: 'Ratio EXPANSION < 20% sin bear market. Motor atrapado?' });
} else if (expansionRatio < 0.35 && marketBias === 'BEAR') {
  alerts.push({ level: 'INFO', msg: 'Ratio EXPANSION bajo (' + (expansionRatio*100).toFixed(0) + '%) en bear market. Esperable.' });
}

if (sharpe < BT.sharpe * 0.5 && marketBias !== 'BEAR') {
  alerts.push({ level: 'WARNING', msg: 'Forward Sharpe < 50% BT (' + sharpe.toFixed(2) + ' vs ' + BT.sharpe.toFixed(2) + ').' });
}
if (crisisDays > 90 && regimes.length > 180) {
  alerts.push({ level: 'INFO', msg: '+90 dias en CRISIS en 6 meses. Verificar detector.' });
}
if (annVol < 0.04 && regimes.length > 60) {
  alerts.push({ level: 'WARNING', msg: 'Volatilidad < 4%. Motor demasiado defensivo?' });
}

// Tier 2 alerts (solo --monthly)
if (isMonthly) {
  if (sortino < 0.90 && sortino > 0) alerts.push({ level: 'WARNING', msg: 'Sortino < 0.90 (' + sortino.toFixed(2) + ').' });
  if (calmar < 0.25 && calmar > 0) alerts.push({ level: 'WARNING', msg: 'Calmar < 0.25 (' + calmar.toFixed(2) + ').' });
  if (recoveryFactor < 1.0 && recoveryFactor > 0) alerts.push({ level: 'WARNING', msg: 'Recovery Factor < 1.0 (' + recoveryFactor.toFixed(2) + ').' });
  if (winRate < 0.42 && winRate > 0) alerts.push({ level: 'WARNING', msg: 'Win Rate < 42% (' + (winRate*100).toFixed(1) + '%).' });
  if (avgTurnover > 0.35) alerts.push({ level: 'WARNING', msg: 'Turnover > 35% (' + (avgTurnover*100).toFixed(1) + '%). Costes elevados.' });
  if (maxConsecutiveLossDays > 25) alerts.push({ level: 'WARNING', msg: 'Max consec. loss > 25 dias (' + maxConsecutiveLossDays + ').' });
  if (sharpeDiffVsEW < -0.30 && ewReturns.length > 0 && marketBias !== 'BULL') {
    alerts.push({ level: 'WARNING', msg: 'Sharpe muy inferior a EW (' + sharpeDiffVsEW.toFixed(2) + ') sin bull market.' });
  }
  if (monthlyPosRatio < 0.40 && monthlyPosRatio > 0) alerts.push({ level: 'WARNING', msg: 'Meses positivos < 40% (' + (monthlyPosRatio*100).toFixed(0) + '%).' });

  // Alpha alerts (solo formato institucional)
  if (isInstitutional && alphaDailies.length > 0) {
    if (alphaSignificant && alphaCagr < -0.05) {
      alerts.push({ level: 'CRITICO', msg: 'Alpha NEGATIVO y significativo (' + (alphaCagr*100).toFixed(1) + '% anual). Motor destruye valor. PAUSAR.' });
    } else if (alphaCagr < -0.02 && alphaDailies.length > 60) {
      alerts.push({ level: 'WARNING', msg: 'Alpha negativo (' + (alphaCagr*100).toFixed(2) + '% anual) por >60 dias.' });
    }
    if (frozenSharpe - sharpe > 0.15 && frozenValues.length > 60) {
      alerts.push({ level: 'WARNING', msg: 'Frozen Sharpe supera al motor por +' + ((frozenSharpe - sharpe)*100).toFixed(0) + 'pp. Mejor no hacer nada.' });
    }
    if (alphaWinRate < 0.45 && alphaDailies.length > 60) {
      alerts.push({ level: 'INFO', msg: 'Alpha Win Rate < 45% (' + (alphaWinRate*100).toFixed(0) + '%). Motor pierde vs frozen la mayoria de dias.' });
    }
  }
}

if (alerts.length === 0) {
  console.log('✅ Sin alertas. Motor operando dentro de parametros esperados.');
} else {
  alerts.forEach(a => console.log('  [' + a.level + '] ' + a.msg));
}

// ── Veredicto ──
const criticalAlerts = alerts.filter(a => a.level === 'CRITICO').length;
const warningAlerts = alerts.filter(a => a.level === 'WARNING').length;

console.log('\n--- VEREDICTO ' + (isMonthly ? 'MENSUAL' : 'SEMANAL') + ' ---');
let verdict: string;
if (criticalAlerts > 0) {
  verdict = 'PAUSAR';
  console.log('🔴 PAUSAR — ' + criticalAlerts + ' alerta(s) critica(s). Protocolo de emergencia.');
} else if (warningAlerts > 2) {
  verdict = 'PRECAUCION';
  console.log('🟠 PRECAUCION — ' + warningAlerts + ' warning(s). Pausar nuevas aportaciones.');
} else if (warningAlerts > 0) {
  verdict = 'ATENCION';
  console.log('🟡 ATENCION — ' + warningAlerts + ' warning(s). Aumentar frecuencia.');
} else {
  verdict = 'NORMAL';
  console.log('🟢 NORMAL — Motor operando dentro de lo esperado.');
}

// ── Guardar reporte ──
const reportPath = path.join(process.cwd(), 'monitor_report.json');
const report: any = {
  date: new Date().toISOString().split('T')[0],
  mode: isMonthly ? 'monthly' : 'weekly',
  period: { start: dates[0], end: dates[dates.length-1], days: values.length },
  marketContext: { bias: marketBias, inCrisis },
  metrics: {
    sharpe, cagr, maxDD, annVol, rollingSharpe,
    expansionRatio, crisisDays, contractionDays,
  },
  backtest: BT,
  alerts: alerts.map(a => a.level + ': ' + a.msg),
  verdict,
};

if (isMonthly) {
  report.metrics.sortino = sortino;
  report.metrics.calmar = calmar;
  report.metrics.recoveryFactor = recoveryFactor;
  report.metrics.winRate = winRate;
  report.metrics.maxConsecutiveLossDays = maxConsecutiveLossDays;
  report.metrics.ulcerIndex = ulcerIndex;
  report.metrics.monthlyPosRatio = monthlyPosRatio;
  report.metrics.avgTurnover = avgTurnover;
  report.metrics.avgCostsBps = avgCostsBps;
  report.metrics.ewSharpe = ewSharpe;
  report.metrics.sharpeDiffVsEW = sharpeDiffVsEW;
  report.metrics.recoveryDays = recoveryDays;
  if (isInstitutional) {
    report.metrics.alpha = { cagr: alphaCagr, tStat: alphaTStat, significant: alphaSignificant, winRate: alphaWinRate };
    report.metrics.frozen = { sharpe: frozenSharpe, cagr: frozenCagr, maxDD: frozenMaxDD, vol: frozenVol };
    report.institutional = {
      format: 'dual tracking (motor vs frozen do-nothing)',
      legacyPnL: legacyPnLs.length > 0 ? legacyPnLs[legacyPnLs.length-1] : 0,
      forwardPnL: values.length > 0 ? values[values.length-1] - values[0] : 0,
      day0MtM: true,
    };
  }
}

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log('\nReporte: ' + reportPath);
console.log('DONE');
