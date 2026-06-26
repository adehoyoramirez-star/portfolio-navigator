// run-backtest-simple.cjs
// Script simplificado para ejecutar el backtest con tail risk overlay
// Ejecutar con: node run-backtest-simple.cjs

const fs = require('fs');
const path = require('path');

// ==================== CONFIGURACIÓN ====================
const ASSETS = ['BTC-EUR', 'EMXC.DE', 'IS3Q.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', 'XNAS.DE'];
const INITIAL_CAPITAL = 10000;
const LOOKBACK_DAYS = 252;
const REBALANCE_DAYS = 63; // trimestral
const TX_COST_BPS = 15;    // 0.15%

// ==================== FUNCIONES AUXILIARES ====================
function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a,b) => a+b, 0) / arr.length;
}

function variance(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return arr.reduce((s,v) => s + (v-m)**2, 0) / (arr.length-1);
}

function dailyReturns(closes) {
    const rets = [];
    for (let i=1; i<closes.length; i++) {
        if (closes[i-1] > 0 && closes[i] > 0) {
            rets.push(closes[i] / closes[i-1] - 1);
        }
    }
    return rets;
}

function periodReturn(closes, t, days) {
    if (t < days || closes[t-days] <= 0) return 0;
    return closes[t] / closes[t-days] - 1;
}

function calculateKelly(expectedReturn, volatility) {
    const variance = volatility * volatility;
    if (variance === 0) return 0;
    let kelly = expectedReturn / variance;
    kelly = Math.max(0, Math.min(0.25, kelly * 0.5)); // half-kelly con cap 25%
    return kelly;
}

function correlationPenalty(corrMatrix) {
    const n = corrMatrix.length;
    let total = 0, count = 0;
    for (let i=0; i<n; i++) {
        for (let j=i+1; j<n; j++) {
            total += corrMatrix[i][j];
            count++;
        }
    }
    const avg = count > 0 ? total / count : 0;
    if (avg > 0.7) return 0.6;
    if (avg > 0.5) return 0.8;
    return 1.0;
}

function computeWindowCorrelation(closesHistory, tickers, t, window) {
    const n = tickers.length;
    const returns = tickers.map(ticker => {
        const closes = closesHistory[ticker] || [];
        return dailyReturns(closes.slice(Math.max(0, t-window), t));
    });
    const minLen = Math.min(...returns.map(r => r.length));
    const trimmed = returns.map(r => r.slice(r.length - minLen));
    const means = trimmed.map(mean);
    const corr = Array(n).fill().map(() => Array(n).fill(0));
    for (let i=0; i<n; i++) {
        for (let j=i; j<n; j++) {
            if (i===j) { corr[i][j]=1; continue; }
            let num=0, si=0, sj=0;
            for (let k=0; k<minLen; k++) {
                const di = trimmed[i][k] - means[i];
                const dj = trimmed[j][k] - means[j];
                num += di*dj;
                si += di*di;
                sj += dj*dj;
            }
            const c = (si>0 && sj>0) ? num / Math.sqrt(si*sj) : 0;
            corr[i][j] = isFinite(c) ? c : 0;
            corr[j][i] = corr[i][j];
        }
    }
    return corr;
}

function computeTailRiskOverlay(drawdown, vix, creditSpread) {
    // Versión simplificada del kill switch
    const dd = Math.abs(drawdown);
    let overlay = 1.0;
    let level = 0;
    if (dd >= 0.32) { overlay = 0.30; level = 5; }
    else if (dd >= 0.25) { overlay = 0.35; level = 4; }
    else if (dd >= 0.20) { overlay = 0.50; level = 3; }
    else if (dd >= 0.15) { overlay = 0.65; level = 2; }
    else if (dd >= 0.08) { overlay = 0.85; level = 1; }
    
    // Ajuste por VIX y credit spread
    if (vix > 40 && creditSpread > 5) overlay *= 0.35;
    else if (vix > 35 && creditSpread > 3.5) overlay *= 0.45;
    else if (vix > 30) overlay *= 0.60;
    
    return Math.max(0.25, Math.min(1.0, overlay));
}

// ==================== CARGA DE DATOS ====================
const csvPath = path.join(__dirname, 'historical_data_daily.csv');
console.log('Leyendo CSV:', csvPath);
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

// Inicializar estructuras
const closesHistory = {};
for (const ticker of ASSETS) {
    closesHistory[ticker] = [];
}
const vixHistory = [];
const tnxHistory = [];
const irxHistory = [];

for (let i=1; i<lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < headers.length) continue;
    
    for (const ticker of ASSETS) {
        const idx = headers.indexOf(ticker);
        if (idx !== -1) {
            const val = parseFloat(parts[idx]);
            closesHistory[ticker].push(isNaN(val) ? 0 : val);
        }
    }
    const vixIdx = headers.indexOf('^VIX');
    if (vixIdx !== -1) vixHistory.push(parseFloat(parts[vixIdx]) || 0);
    const tnxIdx = headers.indexOf('^TNX');
    if (tnxIdx !== -1) tnxHistory.push(parseFloat(parts[tnxIdx]) || 0);
    const irxIdx = headers.indexOf('^IRX');
    if (irxIdx !== -1) irxHistory.push(parseFloat(parts[irxIdx]) || 0);
}

// Asegurar que todas las series tengan la misma longitud
const minLen = Math.min(...ASSETS.map(t => closesHistory[t].length), vixHistory.length, tnxHistory.length, irxHistory.length);
for (const ticker of ASSETS) {
    closesHistory[ticker] = closesHistory[ticker].slice(0, minLen);
}
const vix = vixHistory.slice(0, minLen);
const tnx = tnxHistory.slice(0, minLen);
const irx = irxHistory.slice(0, minLen);
const yieldSpread = tnx.map((t, i) => t - irx[i]);

console.log(`Datos cargados: ${minLen} días`);

// ==================== BACKTEST SIMPLIFICADO ====================
let portfolioValue = INITIAL_CAPITAL;
let peakValue = INITIAL_CAPITAL;
let benchmarkValue = INITIAL_CAPITAL;
let currentAllocations = {};
ASSETS.forEach(t => currentAllocations[t] = 1/ASSETS.length);
let currentRegime = 'EXPANSION';
const dailyRecords = [];
let rebalanceCount = 0;
let totalTxCosts = 0;
const txRate = TX_COST_BPS / 10000;

for (let t = LOOKBACK_DAYS; t < minLen - 1; t++) {
    const dayIndex = t - LOOKBACK_DAYS;
    
    // Rebalanceo cada REBALANCE_DAYS
    if (dayIndex % REBALANCE_DAYS === 0) {
        // Determinar régimen con VIX real
        const currentVix = vix[t];
        let regime = 'EXPANSION';
        let regimePenalty = 1.0;
        if (currentVix > 35) { regime = 'CRISIS'; regimePenalty = 0.4; }
        else if (currentVix > 25) { regime = 'CONTRACTION'; regimePenalty = 0.7; }
        currentRegime = regime;
        
        // Calcular retornos por activo para los últimos LOOKBACK_DAYS
        const returns12m = ASSETS.map(ticker => periodReturn(closesHistory[ticker], t, 252));
        const returns3m  = ASSETS.map(ticker => periodReturn(closesHistory[ticker], t, 63));
        const returns1m  = ASSETS.map(ticker => periodReturn(closesHistory[ticker], t, 21));
        
        // Calcular volatilidades
        const vols = ASSETS.map(ticker => {
            const closes = closesHistory[ticker];
            const rets = dailyReturns(closes.slice(Math.max(0, t-LOOKBACK_DAYS), t));
            if (rets.length < 20) return 0.25;
            return Math.sqrt(variance(rets) * 252);
        });
        
        // Kelly simple (sin factores complejos)
        const expectedReturns = returns12m.map(r => Math.min(0.25, Math.max(0.02, r)));
        const kellyFractions = expectedReturns.map((mu, i) => calculateKelly(mu, vols[i]));
        
        // Penalización por correlación
        const corrMatrix = computeWindowCorrelation(closesHistory, ASSETS, t, 63);
        const corrPen = correlationPenalty(corrMatrix);
        
        // Asignaciones raw
        let rawAllocs = kellyFractions.map(k => k * corrPen * regimePenalty);
        const totalRaw = rawAllocs.reduce((a,b)=>a+b,0);
        if (totalRaw > 0) rawAllocs = rawAllocs.map(w => w / totalRaw);
        else rawAllocs = ASSETS.map(() => 1/ASSETS.length);
        
        const newAllocs = {};
        ASSETS.forEach((ticker, i) => newAllocs[ticker] = rawAllocs[i]);
        
        // APLICAR TAIL RISK OVERLAY
        const drawdown = (portfolioValue - peakValue) / peakValue;
        const creditSpread = 3.0; // simplificado, podríamos estimarlo pero no es crítico
        const tailOverlay = computeTailRiskOverlay(drawdown, currentVix, creditSpread);
        const totalWeight = Object.values(newAllocs).reduce((a,b)=>a+b,0);
        if (totalWeight > 0) {
            for (const ticker of ASSETS) {
                newAllocs[ticker] = (newAllocs[ticker] / totalWeight) * tailOverlay;
            }
            const newTotal = Object.values(newAllocs).reduce((a,b)=>a+b,0);
            if (newTotal > 0) {
                for (const ticker of ASSETS) {
                    newAllocs[ticker] /= newTotal;
                }
            }
        }
        
        currentAllocations = newAllocs;
        rebalanceCount++;
        
        // Costes de transacción
        const activeCount = Object.values(currentAllocations).filter(w => w > 0.01).length;
        const cost = portfolioValue * txRate * activeCount;
        portfolioValue -= cost;
        totalTxCosts += cost;
    }
    
    // Calcular retorno diario del portfolio
    let portRet = 0;
    let benchRet = 0;
    for (let i=0; i<ASSETS.length; i++) {
        const ticker = ASSETS[i];
        const closes = closesHistory[ticker];
        const c0 = closes[t];
        const c1 = closes[t-1];
        if (c0 && c1 && c1>0 && c0>0) {
            const dailyRet = c0/c1 - 1;
            portRet += (currentAllocations[ticker] || 0) * dailyRet;
            benchRet += (1/ASSETS.length) * dailyRet;
        }
    }
    portfolioValue *= (1 + portRet);
    benchmarkValue *= (1 + benchRet);
    if (portfolioValue > peakValue) peakValue = portfolioValue;
    const drawdown = (portfolioValue - peakValue) / peakValue;
    
    dailyRecords.push({
        day: dayIndex,
        value: portfolioValue,
        drawdown: drawdown,
        regime: currentRegime
    });
}

// ==================== RESULTADOS ====================
const finalValue = portfolioValue;
const totalReturn = finalValue / INITIAL_CAPITAL - 1;
const years = dailyRecords.length / 252;
const cagr = years > 0 ? Math.pow(1 + totalReturn, 1/years) - 1 : 0;
const dailyRets = [];
for (let i=1; i<dailyRecords.length; i++) {
    dailyRets.push(dailyRecords[i].value / dailyRecords[i-1].value - 1);
}
const vol = Math.sqrt(variance(dailyRets) * 252);
const sharpe = vol > 0 ? (mean(dailyRets)*252 - 0.04) / vol : 0;
const maxDD = Math.min(...dailyRecords.map(r => r.drawdown));

console.log('\n=== RESULTADOS DEL BACKTEST (CON TAIL RISK OVERLAY) ===\n');
console.log(`CAGR: ${(cagr*100).toFixed(2)}%`);
console.log(`Sharpe: ${sharpe.toFixed(2)}`);
console.log(`Max Drawdown: ${(maxDD*100).toFixed(2)}%`);
console.log(`Volatilidad: ${(vol*100).toFixed(2)}%`);
console.log(`Capital final: €${finalValue.toFixed(2)}`);
console.log(`Costes totales: €${totalTxCosts.toFixed(2)}`);
console.log(`Rebalanceos: ${rebalanceCount}`);

// Guardar resultados diarios
const outputPath = path.join(__dirname, 'backtest_result_simple.csv');
const outputLines = ['Día,Valor,Drawdown,Régimen'];
dailyRecords.forEach(rec => {
    outputLines.push(`${rec.day},${rec.value.toFixed(2)},${(rec.drawdown*100).toFixed(2)},${rec.regime}`);
});
fs.writeFileSync(outputPath, outputLines.join('\n'));
console.log(`\nResultados diarios guardados en: ${outputPath}`);