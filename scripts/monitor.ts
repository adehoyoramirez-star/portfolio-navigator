// Monitorizacion forward semanal: compara metricas reales vs backtest
// Ejecutar: npx tsx scripts/monitor.ts
// Usa la ultima ejecucion de paper_trading_log.csv para calcular metricas

import fs from 'fs';
import path from 'path';

// Cargar log de paper trading
const logPath = path.join(process.cwd(), 'paper_trading_log.csv');
if (!fs.existsSync(logPath)) {
  console.log('ERROR: paper_trading_log.csv not found. Run paper_trading.ts first.');
  process.exit(1);
}

const logContent = fs.readFileSync(logPath, 'utf8');
const logLines = logContent.split('\n').filter(l => l.trim());
const headers = logLines[0].split(',');

console.log('OLYMPUS V3+ — Monitorizacion Forward');
console.log('='.repeat(55));
console.log('Log entries: ' + (logLines.length - 1));
console.log();

// Extraer valores de portfolio y drawdowns
const values: number[] = [];
const drawdowns: number[] = [];
const regimes: string[] = [];
const dates: string[] = [];

for (let i = 1; i < logLines.length; i++) {
  const parts = logLines[i].split(',');
  if (parts.length < 3) continue;
  dates.push(parts[0]);
  values.push(parseFloat(parts[1]));
  const ddStr = parts[2].replace('%', '');
  drawdowns.push(parseFloat(ddStr) / 100);
  regimes.push(parts[3]);
}

if (values.length < 20) {
  console.log('Insufficient data (' + values.length + ' entries). Need at least 20.');
  process.exit(1);
}

console.log('Periodo: ' + dates[0] + ' -> ' + dates[dates.length-1]);
console.log('Dias: ' + values.length);

// Calcular retornos diarios
const returns: number[] = [];
for (let i = 1; i < values.length; i++) {
  returns.push(values[i] / values[i-1] - 1);
}

// Metricas
const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
const variance = returns.reduce((s, r) => s + (r-mean)**2, 0) / returns.length;
const std = Math.sqrt(Math.max(1e-16, variance));
const annVol = std * Math.sqrt(252);
const annRet = mean * 252;
const sharpe = (annRet - 0.04) / Math.max(0.01, annVol);

// CAGR
let totalReturn = 1.0;
for (const r of returns) totalReturn *= (1 + r);
const years = returns.length / 252;
const cagr = totalReturn ** (1 / years) - 1;

// MaxDD
let peak = values[0];
let maxDD = 0;
for (const v of values) {
  if (v > peak) peak = v;
  const dd = (v - peak) / peak;
  if (dd < maxDD) maxDD = dd;
}

// Sharpe rolling 12m (si hay suficientes datos)
let rollingSharpe = 0;
if (returns.length >= 252) {
  const recent = returns.slice(-252);
  const rMean = recent.reduce((a,b) => a+b, 0) / recent.length;
  const rVar = recent.reduce((s, r) => s + (r-rMean)**2, 0) / recent.length;
  const rStd = Math.sqrt(Math.max(1e-16, rVar));
  const rAnn = rMean * 252;
  rollingSharpe = (rAnn - 0.04) / Math.max(0.01, rStd * Math.sqrt(252));
}

// Regime distribution
const regimeCount: Record<string, number> = {};
regimes.forEach(r => { regimeCount[r] = (regimeCount[r] || 0) + 1; });
const crisisDays = regimeCount['CRISIS'] || 0;
const contractionDays = regimeCount['CONTRACTION'] || 0;

// Exposicion media (aproximada: 1 - cash implícito)
// Como no tenemos cash en el log, usamos la presencia de CONTRACTION/CRISIS como proxy
const expansionRatio = (regimeCount['EXPANSION'] || 0) / regimes.length;

// ── Comparacion con backtest ──
const BACKTEST = {
  sharpe: 0.74,
  cagr: 0.126,
  maxDD: -0.27,
  vol: 0.12,
  crisisDaysPerYear: 30,
  expansionRatio: 0.70,
};

console.log('\n--- METRICAS FORWARD ---');
console.log('Sharpe (anualizado):    ' + sharpe.toFixed(3) + ' (backtest: ' + BACKTEST.sharpe.toFixed(2) + ')');
console.log('CAGR:                   ' + (cagr*100).toFixed(2) + '% (backtest: ' + (BACKTEST.cagr*100).toFixed(1) + '%)');
console.log('MaxDD:                  ' + (maxDD*100).toFixed(2) + '% (backtest: ' + (BACKTEST.maxDD*100).toFixed(1) + '%)');
console.log('Volatilidad anual:      ' + (annVol*100).toFixed(2) + '% (backtest: ' + (BACKTEST.vol*100).toFixed(1) + '%)');
if (returns.length >= 252) {
  console.log('Sharpe rolling 12m:     ' + rollingSharpe.toFixed(3) + ' (alerta si < 0.45)');
}
console.log('Dias CRISIS:            ' + crisisDays + ' (backtest: ~' + BACKTEST.crisisDaysPerYear + '/ano)');
console.log('Ratio EXPANSION:        ' + (expansionRatio*100).toFixed(0) + '% (backtest: ~' + (BACKTEST.expansionRatio*100).toFixed(0) + '%)');

// ── Alertas ──
console.log('\n--- ALERTAS ---');

const alerts: string[] = [];

if (maxDD < -0.40) alerts.push('CRITICO: MaxDD > 40% (' + (maxDD*100).toFixed(1) + '%). PAUSAR operaciones.');
if (returns.length >= 252 && rollingSharpe < 0.30) alerts.push('CRITICO: Sharpe rolling 12m < 0.30 (' + rollingSharpe.toFixed(2) + '). PAUSAR.');
if (returns.length >= 252 && rollingSharpe < 0.45) alerts.push('WARNING: Sharpe rolling 12m < 0.45 (' + rollingSharpe.toFixed(2) + ').');
if (annVol > 0.20) alerts.push('WARNING: Volatilidad > 20% (' + (annVol*100).toFixed(1) + '%).');
if (annVol < 0.04) alerts.push('WARNING: Volatilidad < 4% (' + (annVol*100).toFixed(1) + '%). ¿Motor demasiado defensivo?');
if (expansionRatio < 0.35 && regimes.length > 60) alerts.push('WARNING: Ratio EXPANSION < 35%. Motor atrapado en modo defensivo.');
if (sharpe < BACKTEST.sharpe * 0.5) alerts.push('WARNING: Forward Sharpe < 50% backtest (' + sharpe.toFixed(2) + ' vs ' + BACKTEST.sharpe.toFixed(2) + ').');
if (crisisDays > 90 && regimes.length > 180) alerts.push('INFO: +90 dias en CRISIS en 6 meses. Verificar detector de regimen.');

if (alerts.length === 0) {
  console.log('✅ Sin alertas. Motor operando dentro de parametros esperados.');
} else {
  alerts.forEach(a => console.log('  ' + a));
}

// ── Veredicto semanal ──
const criticalAlerts = alerts.filter(a => a.startsWith('CRITICO')).length;
const warningAlerts = alerts.filter(a => a.startsWith('WARNING')).length;

console.log('\n--- VEREDICTO SEMANAL ---');
if (criticalAlerts > 0) {
  console.log('🔴 PAUSAR — ' + criticalAlerts + ' alerta(s) critica(s). Revisar antes de continuar.');
} else if (warningAlerts > 2) {
  console.log('🟠 PRECAUCION — ' + warningAlerts + ' warning(s). Monitorizar de cerca.');
} else if (warningAlerts > 0) {
  console.log('🟡 ATENCION — ' + warningAlerts + ' warning(s). Sin accion inmediata requerida.');
} else {
  console.log('🟢 NORMAL — Motor operando dentro de lo esperado.');
}

// Guardar reporte
const reportPath = path.join(process.cwd(), 'monitor_report.json');
fs.writeFileSync(reportPath, JSON.stringify({
  date: new Date().toISOString().split('T')[0],
  period: { start: dates[0], end: dates[dates.length-1], days: values.length },
  metrics: { sharpe, cagr, maxDD, annVol, rollingSharpe, crisisDays, expansionRatio },
  backtest: BACKTEST,
  alerts,
  verdict: criticalAlerts > 0 ? 'PAUSAR' : warningAlerts > 2 ? 'PRECAUCION' : warningAlerts > 0 ? 'ATENCION' : 'NORMAL',
}, null, 2));

console.log('\nReporte: ' + reportPath);
console.log('DONE');
