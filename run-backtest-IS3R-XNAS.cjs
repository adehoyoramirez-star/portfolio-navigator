// run-backtest-IS3R-XNAS.cjs
// Simulación de cartera con IS3R (proxy MTUM) y XNAS

const fs = require('fs');
const path = require('path');

// ==================== CONFIGURACIÓN ====================
// Tickers reales en el CSV
const TICKERS = [
  'BTC-EUR',   // Bitcoin
  'EMXC.DE',   // Emerging Markets ex China
  'IS3Q.DE',   // MSCI World Quality
  'PPFB.DE',   // Oro físico
  'URNU.DE',   // Uranio
  'VVSM.DE',   // Semiconductores (proxy VVSG)
  'XNAS.DE',   // NASDAQ 100
  'IS3R.DE'       // Proxy para IS3R (MSCI USA Momentum Factor)
];

const INITIAL_CAPITAL = 10000;
const LOOKBACK_DAYS = 252;
const REBALANCE_DAYS = 63;
const TX_COST_BPS = 15;

// ==================== FUNCIONES AUXILIARES (mismas que antes) ====================
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
    kelly = Math.max(0, Math.min(0.25, kelly * 0.5));
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
    const dd = Math.abs(drawdown);
    let overlay = 1.0;
    if (dd >= 0.32) overlay = 0.30;
    else if (dd >= 0.25) overlay = 0.35;
    else if (dd >= 0.20) overlay = 0.50;
    else if (dd >= 0.15) overlay = 0.65;
    else if (dd >= 0.08) overlay = 0.85;
    if (vix > 40 && creditSpread > 5) overlay *= 0.35;
    else if (vix > 35 && creditSpread > 3.5) overlay *= 0.45;
    else if (vix > 30) overlay *= 0.60;
    return Math.max(0.25, Math.min(1.0, overlay));
}

// ==================== CARGA DE DATOS ====================
const csvPath = path.join(__dirname, 'historical_data_daily_with_IS3R.csv');
console.log('Leyendo CSV:', csvPath);
const csvContent = fs.readFileSync(csvPath, 'utf8');
const lines = csvContent.split('\n');
const headers = lines[0].split(',');

const closesHistory = {};
for (const ticker of TICKERS) {
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
    
    for (const ticker of TICKERS) {
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

// Verificar que todos los tickers tienen datos
for (const ticker of TICKERS) {
    if (closesHistory[ticker].length === 0) {
        console.error(`Error: No hay datos para ${ticker}. El ticker no existe en el CSV.`);
        process.exit(1);
    }
}

// Ajustar longitudes
const minLen = Math.min(...TICKERS.map(t => closesHistory[t].length), vixHistory.length, tnxHistory.length, irxHistory.length);
for (const ticker of TICKERS) {
    closesHistory[ticker] = closesHistory[ticker].slice(0, minLen);
}
const vix = vixHistory.slice(0, minLen);
const tnx = tnxHistory.slice(0, minLen);
const irx = irxHistory.slice(0, minLen);
const yieldSpread = tnx.map((t, i) => t - irx[i]);

console.log(`Datos cargados: ${minLen} días para ${TICKERS.length} activos`);

// ==================== BACKTEST ====================
let portfolioValue = INITIAL_CAPITAL;
let peakValue = INITIAL_CAPITAL;
let benchmarkValue = INITIAL_CAPITAL;
let currentAllocations = {};
TICKERS.forEach(t => currentAllocations[t] = 1/TICKERS.length);
let currentRegime = 'EXPANSION';
const dailyRecords = [];
let rebalanceCount = 0;
let totalTxCosts = 0;
const txRate = TX_COST_BPS / 10000;

for (let t = LOOKBACK_DAYS; t < minLen - 1; t++) {
    const dayIndex = t - LOOKBACK_DAYS;
    
    if (dayIndex % REBALANCE_DAYS === 0) {
        const currentVix = vix[t];
        let regime = 'EXPANSION';
        let regimePenalty = 1.0;
        if (currentVix > 35) { regime = 'CRISIS'; regimePenalty = 0.4; }
        else if (currentVix > 25) { regime = 'CONTRACTION'; regimePenalty = 0.7; }
        currentRegime = regime;
        
        // Calcular retornos y volatilidades
        const returns12m = TICKERS.map(ticker => periodReturn(closesHistory[ticker], t, 252));
        const returns3m  = TICKERS.map(ticker => periodReturn(closesHistory[ticker], t, 63));
        const returns1m  = TICKERS.map(ticker => periodReturn(closesHistory[ticker], t, 21));
        const vols = TICKERS.map(ticker => {
            const closes = closesHistory[ticker];
            const rets = dailyReturns(closes.slice(Math.max(0, t-LOOKBACK_DAYS), t));
            if (rets.length < 20) return 0.25;
            return Math.sqrt(variance(rets) * 252);
        });
        
        // Esperado retorno: usar prior + shrinkage simple
        const expectedReturns = returns12m.map((r, i) => {
            const prior = (TICKERS[i] === 'BTC-EUR') ? 0.15 :
                         (TICKERS[i] === 'VVSM.DE' || TICKERS[i] === 'XNAS.DE') ? 0.14 :
                         (TICKERS[i] === 'IS3Q.DE') ? 0.11 :
                         (TICKERS[i] === 'URNU.DE') ? 0.10 :
                         (TICKERS[i] === 'EMXC.DE') ? 0.08 :
                         (TICKERS[i] === 'PPFB.DE') ? 0.06 : 0.10;
            return Math.min(0.25, Math.max(0.02, r * 0.35 + prior * 0.65));
        });
        
        const kellyFractions = expectedReturns.map((mu, i) => calculateKelly(mu, vols[i]));
        const corrMatrix = computeWindowCorrelation(closesHistory, TICKERS, t, 63);
        const corrPen = correlationPenalty(corrMatrix);
        
        let rawAllocs = kellyFractions.map(k => k * corrPen * regimePenalty);
        const totalRaw = rawAllocs.reduce((a,b)=>a+b,0);
        if (totalRaw > 0) rawAllocs = rawAllocs.map(w => w / totalRaw);
        else rawAllocs = TICKERS.map(() => 1/TICKERS.length);
        
        const newAllocs = {};
        TICKERS.forEach((ticker, i) => newAllocs[ticker] = rawAllocs[i]);
        
        // Tail risk overlay
        const drawdown = (portfolioValue - peakValue) / peakValue;
        const creditSpread = 2.5 + (currentVix / 20);
        const tailOverlay = computeTailRiskOverlay(drawdown, currentVix, creditSpread);
        const totalWeight = Object.values(newAllocs).reduce((a,b)=>a+b,0);
        if (totalWeight > 0) {
            for (const ticker of TICKERS) {
                newAllocs[ticker] = (newAllocs[ticker] / totalWeight) * tailOverlay;
            }
            const newTotal = Object.values(newAllocs).reduce((a,b)=>a+b,0);
            if (newTotal > 0) {
                for (const ticker of TICKERS) {
                    newAllocs[ticker] /= newTotal;
                }
            }
        }
        
        currentAllocations = newAllocs;
        rebalanceCount++;
        
        const activeCount = Object.values(currentAllocations).filter(w => w > 0.01).length;
        const cost = portfolioValue * txRate * activeCount;
        portfolioValue -= cost;
        totalTxCosts += cost;
    }
    
    let portRet = 0;
    for (let i=0; i<TICKERS.length; i++) {
        const ticker = TICKERS[i];
        const closes = closesHistory[ticker];
        const c0 = closes[t];
        const c1 = closes[t-1];
        if (c0 && c1 && c1>0 && c0>0) {
            const dailyRet = c0/c1 - 1;
            portRet += (currentAllocations[ticker] || 0) * dailyRet;
        }
    }
    portfolioValue *= (1 + portRet);
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

console.log('\n=== RESULTADOS CON IS3R (MTUM) + XNAS ===\n');
console.log(`CAGR: ${(cagr*100).toFixed(2)}%`);
console.log(`Sharpe: ${sharpe.toFixed(2)}`);
console.log(`Max Drawdown: ${(maxDD*100).toFixed(2)}%`);
console.log(`Volatilidad: ${(vol*100).toFixed(2)}%`);
console.log(`Capital final: €${finalValue.toFixed(2)}`);
console.log(`Costes totales: €${totalTxCosts.toFixed(2)}`);
console.log(`Rebalanceos: ${rebalanceCount}`);

// Guardar CSV
const outputPath = path.join(__dirname, 'backtest_IS3R_XNAS.csv');
const outputLines = ['Día,Valor,Drawdown,Régimen'];
dailyRecords.forEach(rec => {
    outputLines.push(`${rec.day},${rec.value.toFixed(2)},${(rec.drawdown*100).toFixed(2)},${rec.regime}`);
});
fs.writeFileSync(outputPath, outputLines.join('\n'));
console.log(`\nResultados guardados en: ${outputPath}`);