import React, { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { liquidityScore } from "@/core/macro/liquidity";
import { portfolio as initialPortfolio } from "@/data/portfolio";
import { getMacroData } from "@/lib/yahooFinance";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { calculateCorrelationMatrix } from "@/core/data/portfolioMetrics";
import { calculateRSI, calculateZScore } from "@/core/data/indicators";
import { runOlympusEngine, AssetInput } from "@/core/engine/olympusV3";
import { computeGlobalStress } from "@/core/macro/globalStress";

const GaugeChart = lazy(() => import("react-gauge-chart"));

// ==================== MONTE CARLO JUMP DIFFUSION ====================
function monteCarloJumpDiffusion(
  initialCapital: number,
  monthlyContribution: number,
  mu: number,
  sigma: number,
  jumpIntensity: number,
  jumpMean: number,
  jumpStd: number,
  years: number,
  simulations: number = 5000
): { mean: number; worst5: number; simulations: number[] } {
  const monthlyMu = mu / 12;
  const monthlySigma = sigma / Math.sqrt(12);
  const monthlyJumpIntensity = jumpIntensity / 12;
  const months = years * 12;
  const finalValues: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let value = initialCapital;
    for (let m = 0; m < months; m++) {
      value += monthlyContribution;
      const z = randomNormal();
      const diffusion = monthlyMu - 0.5 * monthlySigma ** 2 + monthlySigma * z;
      let jump = 0;
      if (Math.random() < monthlyJumpIntensity) {
        jump = jumpMean + jumpStd * randomNormal();
      }
      const totalReturn = diffusion + jump;
      value = value * Math.exp(totalReturn);
    }
    finalValues.push(value);
  }

  finalValues.sort((a, b) => a - b);
  const mean = finalValues.reduce((a, b) => a + b, 0) / simulations;
  const worst5 = finalValues[Math.floor(simulations * 0.05)];

  return { mean, worst5, simulations: finalValues };
}

function randomNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ==================== TIPOS ====================
interface Asset {
  ticker: string;
  name: string;
  weight: number;
  currentWeight: number;
  price: number;
  shares: number;
  avgPrice: number;
  volatility: number;
  expectedReturn: number;
  sector: string;
  history: number[];
  zScore?: number;
  rsi?: number;
  return12m?: number;
  return3m?: number;
  return1m?: number;
  earningsYield?: number;
}

interface Portfolio {
  totalValue: number;
  cashReserve: number;
  monthlyInjection: number;
  targetGoal: number;
  regime: "ATTACK" | "NEUTRAL" | "RISK_OFF";
  riskFreeRate: number;
  expectedVolatility: number;
  assets: Asset[];
}

const ASSETS = [
  "BTC-EUR",
  "EMXC.DE",
  "IS3Q.DE",
  "PPFB.DE",
  "URNU.DE",
  "VVSM.DE",
  "ZPRR.DE"
];

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value);
};

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

// ==================== COMPONENTE PRINCIPAL ====================
const InstitutionalDashboard: React.FC = () => {
  const [portfolio, setPortfolio] = useState<Portfolio>(initialPortfolio);
  const [cashReserve, setCashReserve] = useState(portfolio.cashReserve);
  const [monthlyInjection, setMonthlyInjection] = useState(portfolio.monthlyInjection);
  const [years, setYears] = useState(10);

  // Parámetros de jump (ahora editables)
  const [jumpIntensity, setJumpIntensity] = useState(0.15);
  const [jumpMean, setJumpMean] = useState(-0.12);
  const [jumpStd, setJumpStd] = useState(0.05);

  // Inputs manuales macro
  const [vix, setVix] = useState(19);
  const [manualPER, setManualPER] = useState(29.69);
  const [manualBond10y, setManualBond10y] = useState(4.2);
  const [bond2y, setBond2y] = useState(3.0);
  const [m2Growth, setM2Growth] = useState(5.2);
  const [creditSpread, setCreditSpread] = useState(1.5);
  const [rsi, setRsi] = useState(55);
  const [momentum, setMomentum] = useState(0.2);

  // Nuevos parámetros manuales para las señales macro
  const [liquidityGrowth, setLiquidityGrowth] = useState(3.2);       // % crecimiento liquidez global
  const [dxy, setDxy] = useState(103);                               // Dollar index
  const [moveIndex, setMoveIndex] = useState(120);                   // MOVE index
  const [btcVol, setBtcVol] = useState(0.65);                        // volatilidad BTC (65%)

  const [erpValue, setErpValue] = useState(0.025);
  const [liquidity, setLiquidity] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const clippedERP = (erp: number) => Math.max(-0.03, Math.min(0.05, erp));

  useEffect(() => {
    if (manualPER > 0) {
      const earningsYield = 1 / manualPER;
      const riskFree = manualBond10y / 100;
      const rawErp = earningsYield - riskFree;
      setErpValue(clippedERP(rawErp));
    }
  }, [manualPER, manualBond10y]);

  const getCurrentPricesLocal = async () => {
    const prices: Record<string, number> = {};
    for (const ticker of ASSETS) {
      try {
        await new Promise(resolve => setTimeout(resolve, 200));
        const response = await fetch(`/api/yahoo/${encodeURIComponent(ticker)}?range=1d&interval=1d`);
        if (!response.ok) {
          if (response.status === 429) {
            console.warn(`Rate limit para ${ticker}, usando precio anterior`);
            const prev = portfolio.assets.find(a => a.ticker === ticker)?.price;
            prices[ticker] = prev || 0;
            continue;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        prices[ticker] = data.chart.result[0].meta.regularMarketPrice;
      } catch (error) {
        console.error(`Error obteniendo precio de ${ticker}:`, error);
        const prev = portfolio.assets.find(a => a.ticker === ticker)?.price;
        prices[ticker] = prev || 0;
      }
    }
    return prices;
  };

  const refreshMarketData = async () => {
    setLoading(true);
    setApiError(null);
    try {
      const macro = await getMacroData();
      setVix(macro.vix);
      const liq = liquidityScore({
        m2Growth,
        vix: macro.vix,
        yieldCurveSpread: macro.tnx - macro.irx
      });
      setLiquidity(liq);
      const prices = await getCurrentPricesLocal();
      const hasError = Object.values(prices).some(p => p === 0);
      if (hasError) {
        setApiError("Algunos precios no se pudieron obtener. Se muestran los últimos disponibles.");
      }
      setPortfolio(prev => ({
        ...prev,
        assets: prev.assets.map(asset => ({
          ...asset,
          price: prices[asset.ticker] || asset.price
        }))
      }));
    } catch (error) {
      console.error("Error actualizando datos:", error);
      setApiError("Error al conectar con Yahoo Finance. Usando datos locales.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshMarketData();
  }, []);

  const totalPortfolioValue = portfolio.assets.reduce(
    (sum, asset) => sum + asset.price * asset.shares,
    0
  );

  const corrMatrix = useMemo(() => 
    calculateCorrelationMatrix(portfolio.assets),
    [portfolio.assets]
  );

  // Preparar inputs para el motor V3
  const assetInputs: AssetInput[] = useMemo(() => {
    return portfolio.assets.map(asset => ({
      name: asset.name,
      returns12m: asset.return12m ?? 0.01,
      returns3m: asset.return3m ?? 0.01,
      returns1m: asset.return1m ?? 0.01,
      earningsYield: asset.earningsYield ?? 0,
      volatility: asset.volatility / 100,
    }));
  }, [portfolio.assets]);

  const yieldSpread = manualBond10y - bond2y;

  const engineResult = useMemo(() => {
    if (assetInputs.length === 0 || corrMatrix.length === 0) return null;
    return runOlympusEngine({
      assets: assetInputs,
      correlationMatrix: corrMatrix,
      macro: {
        vix,
        yieldSpread,
        creditSpread,
      },
    });
  }, [assetInputs, corrMatrix, vix, yieldSpread, creditSpread]);

  // ==================== NUEVAS SEÑALES MACRO (con valores manuales) ====================
  const dxyTrend = (dxy - 100) / 100; // tendencia del dólar

  // Régimen de liquidez global calculado manualmente
  const liquidityRegime = useMemo(() => {
    if (liquidityGrowth > 2.5 && dxyTrend < -0.01) return "EXPANSION";
    if (liquidityGrowth < 0 || dxyTrend > 0.02) return "CONTRACTION";
    return "NEUTRAL";
  }, [liquidityGrowth, dxyTrend]);

  // Global Stress Index (usando la función importada)
  const stress = computeGlobalStress({
    vix,
    creditSpread,
    move: moveIndex,
    dxyTrend,
    btcVol,
  });

  // ==================== SEÑALES DE BTC Y DCA ====================
  const btcAsset = portfolio.assets.find(a => a.ticker === "BTC-EUR");
  const btcRsi = btcAsset?.rsi ?? calculateRSI(btcAsset?.history || [], 14);
  const btcZ = btcAsset?.zScore ?? calculateZScore(btcAsset?.history || [], 200);
  const btcRet1m = btcAsset?.return1m ?? 0;

  const dcaSignal = (() => {
    let score = 0;
    if ((engineResult?.allocations.reduce((acc, a) => acc + a.momentumScore * a.finalAllocation, 0) ?? 0) < 0) score++;
    if (btcRsi < 45) score++;
    if (btcZ < -0.75) score++;

    let buyFraction = 0;
    let action: "WAIT" | "SMALL_BUY" | "BUY" | "FULL_BUY" = "WAIT";
    if (score === 1) { buyFraction = 0.25; action = "SMALL_BUY"; }
    else if (score === 2) { buyFraction = 0.5; action = "BUY"; }
    else if (score === 3) { buyFraction = 1; action = "FULL_BUY"; }

    return { score, buyFraction, action };
  })();

  const btcEntry = (() => {
    let score = 0;
    if (btcRsi < 35) score++;
    if (btcZ < -1.5) score++;
    if (btcRet1m < -0.08) score++;

    let signal: "NONE" | "WATCH" | "BUY" | "STRONG_BUY" = "NONE";
    if (score === 1) signal = "WATCH";
    else if (score === 2) signal = "BUY";
    else if (score === 3) signal = "STRONG_BUY";

    return { score, signal };
  })();

  // ==================== MONTE CARLO ====================
  const expectedReturn = engineResult?.allocations.reduce(
    (acc, a) => acc + a.expectedReturn * a.finalAllocation,
    0
  ) ?? 0.05;

  const portfolioVol = portfolio.assets.reduce(
    (acc, asset) => acc + (asset.volatility / 100) * (asset.price * asset.shares / totalPortfolioValue),
    0
  );

  const jumpSim = useMemo(() => {
    return monteCarloJumpDiffusion(
      totalPortfolioValue,
      monthlyInjection,
      expectedReturn,
      portfolioVol,
      jumpIntensity,
      jumpMean,
      jumpStd,
      years,
      5000
    );
  }, [totalPortfolioValue, monthlyInjection, expectedReturn, portfolioVol, jumpIntensity, jumpMean, jumpStd, years]);

  const { mean: meanValue, worst5, simulations } = jumpSim;
  const target = portfolio.targetGoal;
  const successes = simulations.filter(v => v >= target).length;
  const probability = (successes / simulations.length) * 100;

  const histogramData = useMemo(() => {
    if (simulations.length === 0) return [];
    const numBins = 20;
    const min = Math.min(...simulations);
    const max = Math.max(...simulations);
    const binWidth = (max - min) / numBins;
    const bins = Array(numBins).fill(0);
    simulations.forEach(v => {
      const index = Math.min(numBins - 1, Math.floor((v - min) / binWidth));
      bins[index]++;
    });
    return bins.map((count, i) => ({
      range: `${formatCurrency(min + i * binWidth)} - ${formatCurrency(min + (i + 1) * binWidth)}`,
      count,
    }));
  }, [simulations]);

  const pieData = portfolio.assets.map(asset => ({
    name: asset.name,
    value: asset.price * asset.shares
  }));

  const updateAsset = (ticker: string, field: keyof Asset, value: number) => {
    setPortfolio(prev => ({
      ...prev,
      assets: prev.assets.map(asset =>
        asset.ticker === ticker ? { ...asset, [field]: value } : asset
      )
    }));
  };

  useEffect(() => {
    setPortfolio(prev => ({ ...prev, cashReserve, monthlyInjection }));
  }, [cashReserve, monthlyInjection]);

  const isAttackMode = (asset: Asset): boolean => {
    const rsiVal = asset.rsi ?? calculateRSI(asset.history, 14);
    const zScoreVal = asset.zScore ?? calculateZScore(asset.history, 200);
    const currentValue = asset.price * asset.shares;
    const targetValue = totalPortfolioValue * (asset.weight / 100);
    const deficit = targetValue - currentValue;
    return rsiVal < 30 && zScoreVal < -1.5 && deficit > 0;
  };

  const getAttackReason = (asset: Asset): string => {
    const rsiVal = asset.rsi ?? calculateRSI(asset.history, 14);
    const zScoreVal = asset.zScore ?? calculateZScore(asset.history, 200);
    const reasons = [];
    if (rsiVal < 30) reasons.push(`RSI ${rsiVal.toFixed(1)} (sobreventa extrema, potencial rebote)`);
    if (zScoreVal < -1.5) reasons.push(`Z-Score ${zScoreVal.toFixed(2)} (precio ${Math.abs(zScoreVal).toFixed(1)} desviaciones por debajo de la media, infravaloración significativa)`);
    return reasons.join('. ');
  };

  const availableCash = cashReserve + monthlyInjection;

  const purchaseSuggestions = useMemo(() => {
    if (!engineResult) return [];
    if (engineResult.crisis.regime === "CRISIS") return [];

    const sorted = [...engineResult.allocations].sort((a, b) => b.finalAllocation - a.finalAllocation);
    const suggestions: { 
      ticker: string; 
      name: string; 
      price: number; 
      sharesToBuy: number; 
      cost: number; 
      reason: string;
    }[] = [];

    let remainingCash = availableCash;

    for (const alloc of sorted) {
      if (remainingCash <= 0) break;
      const asset = portfolio.assets.find(a => a.name === alloc.name);
      if (!asset) continue;

      const currentValue = asset.price * asset.shares;
      const targetValue = totalPortfolioValue * (asset.weight / 100);
      const deficit = targetValue - currentValue;
      if (deficit <= 0) continue;

      const allocationAmount = remainingCash * alloc.finalAllocation;
      const maxSharesByDeficit = deficit / asset.price;
      const maxSharesByCash = allocationAmount / asset.price;

      let sharesToBuy: number;
      if (asset.ticker === "BTC-EUR") {
        sharesToBuy = Math.min(maxSharesByDeficit, maxSharesByCash);
        sharesToBuy = Math.floor(sharesToBuy * 10000) / 10000;
      } else {
        sharesToBuy = Math.floor(Math.min(maxSharesByDeficit, maxSharesByCash));
      }
      if (sharesToBuy <= 0) continue;

      const cost = sharesToBuy * asset.price;
      if (cost <= remainingCash) {
        const attack = isAttackMode(asset);
        let reason = attack 
          ? `⚔️ MODO ATAQUE: ${getAttackReason(asset)}. `
          : `Déficit de ${formatCurrency(deficit)}. `;
        reason += `Prioridad según motor: ${(alloc.finalAllocation * 100).toFixed(1)}%. `;
        reason += `Se recomienda comprar ${sharesToBuy} acciones por ${formatCurrency(cost)}.`;
        suggestions.push({
          ticker: asset.ticker,
          name: asset.name,
          price: asset.price,
          sharesToBuy,
          cost,
          reason,
        });
        remainingCash -= cost;
      }
    }
    return suggestions;
  }, [engineResult, portfolio.assets, totalPortfolioValue, availableCash]);

  const totalSuggestedCost = purchaseSuggestions.reduce((sum, s) => sum + s.cost, 0);

  const totalGainLoss = portfolio.assets.reduce(
    (sum, asset) => sum + (asset.price - asset.avgPrice) * asset.shares,
    0
  );

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard (Olympus Engine V3+)</h1>

      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", alignItems: "center" }}>
        <button onClick={refreshMarketData} style={styles.button} disabled={loading}>
          {loading ? "Actualizando..." : "🔄 Actualizar precios y datos macro"}
        </button>
        <span style={{ color: "#9ca3af", fontSize: "0.9rem" }}>
          Precios actualizados desde Yahoo Finance.
        </span>
      </div>
      {apiError && <div style={{ color: "#ef4444", marginBottom: "10px" }}>{apiError}</div>}

      {/* Velocímetros */}
      <div style={{ ...styles.card, display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: "20px" }}>
        <Suspense fallback={<div style={{ height: 120, background: "#1f2937", width: 160 }}>Cargando...</div>}>
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>ERP</h4>
            <GaugeChart id="gauge-erp" nrOfLevels={20} percent={erpValue * 20} textColor="#fff" formatTextValue={() => `${(erpValue * 100).toFixed(1)}%`} colors={["#ef4444", "#f59e0b", "#10b981"]} arcWidth={0.3} cornerRadius={3} />
          </div>
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>Liquidez</h4>
            <GaugeChart id="gauge-liquidity" nrOfLevels={20} percent={liquidity} textColor="#fff" formatTextValue={() => (liquidity * 100).toFixed(0) + "%"} colors={["#ef4444", "#f59e0b", "#10b981"]} arcWidth={0.3} cornerRadius={3} />
          </div>
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>VIX</h4>
            <GaugeChart id="gauge-vix" nrOfLevels={20} percent={Math.min(1, vix / 40)} textColor="#fff" formatTextValue={() => vix.toFixed(1)} colors={["#10b981", "#f59e0b", "#ef4444"]} arcWidth={0.3} cornerRadius={3} />
          </div>
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>RSI</h4>
            <GaugeChart id="gauge-rsi" nrOfLevels={20} percent={rsi / 100} textColor="#fff" formatTextValue={() => rsi.toFixed(0)} colors={["#ef4444", "#f59e0b", "#10b981"]} arcWidth={0.3} cornerRadius={3} />
            <p style={{ color: rsi > 70 ? "#ef4444" : rsi < 30 ? "#ef4444" : "#10b981" }}>
              {rsi > 70 ? "Sobrecompra" : rsi < 30 ? "Sobreventa" : "Neutral"}
            </p>
          </div>
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>Momentum cartera</h4>
            <GaugeChart
              id="gauge-portfolio-momentum"
              nrOfLevels={20}
              percent={ ((engineResult?.allocations.reduce((acc, a) => acc + a.momentumScore * a.finalAllocation, 0) ?? 0) + 1) / 2 }
              textColor="#fff"
              formatTextValue={() => (engineResult?.allocations.reduce((acc, a) => acc + a.momentumScore * a.finalAllocation, 0) ?? 0).toFixed(2)}
              colors={["#ef4444", "#f59e0b", "#10b981"]}
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
        </Suspense>
      </div>

      {/* Inputs manuales macro (incluyendo nuevos parámetros) */}
      <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem" }}>
        <div>
          <label style={styles.label}>PER S&P 500</label>
          <input type="number" value={manualPER} onChange={(e) => setManualPER(Number(e.target.value))} style={styles.smallInput} step="0.1" min="1" />
        </div>
        <div>
          <label style={styles.label}>Bono USA 10y %</label>
          <input type="number" value={manualBond10y} onChange={(e) => setManualBond10y(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
        </div>
        <div>
          <label style={styles.label}>Bono USA 2y %</label>
          <input type="number" value={bond2y} onChange={(e) => setBond2y(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
        </div>
        <div>
          <label style={styles.label}>M2 Growth %</label>
          <input type="number" value={m2Growth} onChange={(e) => setM2Growth(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>Credit Spread %</label>
          <input type="number" value={creditSpread} onChange={(e) => setCreditSpread(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>VIX</label>
          <input type="number" value={vix} onChange={(e) => setVix(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>RSI S&P 500</label>
          <input type="number" value={rsi} onChange={(e) => setRsi(Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
        </div>
        <div>
          <label style={styles.label}>Momentum S&P 500</label>
          <input type="number" value={momentum} onChange={(e) => setMomentum(Number(e.target.value))} style={styles.smallInput} step="0.1" min="-1" max="1" />
        </div>
        <div>
          <label style={styles.label}>Liquidez Global %</label>
          <input type="number" value={liquidityGrowth} onChange={(e) => setLiquidityGrowth(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>DXY (Dólar)</label>
          <input type="number" value={dxy} onChange={(e) => setDxy(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>MOVE Index</label>
          <input type="number" value={moveIndex} onChange={(e) => setMoveIndex(Number(e.target.value))} style={styles.smallInput} step="1" />
        </div>
        <div>
          <label style={styles.label}>Volatilidad BTC</label>
          <input type="number" value={btcVol} onChange={(e) => setBtcVol(Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="2" />
        </div>
        <div>
          <label style={styles.label}>Jump Intensity</label>
          <input type="number" value={jumpIntensity} onChange={(e) => setJumpIntensity(Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="1" />
        </div>
        <div>
          <label style={styles.label}>Jump Mean</label>
          <input type="number" value={jumpMean} onChange={(e) => setJumpMean(Number(e.target.value))} style={styles.smallInput} step="0.01" />
        </div>
        <div>
          <label style={styles.label}>Jump Std</label>
          <input type="number" value={jumpStd} onChange={(e) => setJumpStd(Number(e.target.value))} style={styles.smallInput} step="0.01" />
        </div>
      </div>

      {/* Nuevas tarjetas de señales macro */}
      <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "1rem" }}>
        <div>
          <h4>Liquidez Global</h4>
          <p>Regime: {liquidityRegime}</p>
          <p>Crec: {liquidityGrowth}%</p>
          <p>DXY Trend: {(dxyTrend * 100).toFixed(1)}%</p>
        </div>
        <div>
          <h4>Global Stress</h4>
          <p>Score: {stress.score} / {stress.regime}</p>
        </div>
        <div>
          <h4>Smart DCA</h4>
          <p>Acción: {dcaSignal.action}</p>
          <p>Comprar: {formatCurrency(cashReserve * dcaSignal.buyFraction)}</p>
        </div>
        <div>
          <h4>BTC Tactical</h4>
          <p>Señal: {btcEntry.signal}</p>
        </div>
      </div>

      {/* Resultados del motor V3 */}
      {engineResult && (
        <div style={styles.card}>
          <h2>📊 Resultados del Motor Olympus V3</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
            <div>
              <p><strong>Régimen:</strong> {engineResult.crisis.regime}</p>
              <p><strong>Prob. crisis:</strong> {engineResult.crisis.probability.toFixed(1)}%</p>
              <p><strong>Penalización correlación:</strong> {engineResult.correlationPenalty.toFixed(2)}</p>
            </div>
            <div>
              <p><strong>Asignaciones óptimas:</strong></p>
              {engineResult.allocations.map(a => (
                <p key={a.name}>{a.name}: {(a.finalAllocation * 100).toFixed(1)}% (Kelly {(a.kellyFraction * 100).toFixed(1)}%)</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Simulación Monte Carlo */}
      <div style={styles.card}>
        <h2>Distribución de valores finales (Monte Carlo con Jump Diffusion)</h2>
        <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <div><label htmlFor="years" style={styles.label}>Años de simulación:</label><input id="years" name="years" type="number" value={years} onChange={(e) => setYears(Number(e.target.value))} style={styles.smallInput} min="1" max="50" step="1" /></div>
          <div><p><strong>Probabilidad de alcanzar {formatCurrency(target)}:</strong> {probability.toFixed(1)}%</p></div>
          <div><p><strong>Media:</strong> {formatCurrency(meanValue)}</p></div>
          <div><p><strong>Peor 5%:</strong> {formatCurrency(worst5)}</p></div>
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={histogramData} barSize={15}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="range" tick={{ fontSize: 10, fill: "#9ca3af" }} interval={0} angle={-45} textAnchor="end" height={80} />
            <YAxis tick={{ fill: "#9ca3af" }} />
            <Tooltip formatter={(value: number) => value} labelFormatter={() => ""} />
            <Bar dataKey="count" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
        <p style={{ fontSize: "0.9rem", color: "#9ca3af" }}>Histograma basado en {simulations.length} simulaciones (20 bins).</p>
      </div>

      {/* Caja y aportaciones */}
      <div style={{ ...styles.card, display: "flex", gap: "2rem", alignItems: "center", flexWrap: "wrap" }}>
        <div><label htmlFor="cashReserve" style={styles.label}>Caja de reserva (€)</label><input id="cashReserve" name="cashReserve" type="number" value={cashReserve} onChange={(e) => setCashReserve(Number(e.target.value))} style={styles.input} /></div>
        <div><label htmlFor="monthlyInjection" style={styles.label}>Aportación mensual (€)</label><input id="monthlyInjection" name="monthlyInjection" type="number" value={monthlyInjection} onChange={(e) => setMonthlyInjection(Number(e.target.value))} style={styles.input} /></div>
        <div>
          <p><strong>Valor total cartera:</strong> {formatCurrency(totalPortfolioValue)}</p>
          <p><strong>Objetivo:</strong> {formatCurrency(portfolio.targetGoal)}</p>
          <p><strong>Ganancias/Pérdidas totales:</strong> <span style={{ color: totalGainLoss >= 0 ? "#10b981" : "#ef4444" }}>{formatCurrency(totalGainLoss)}</span></p>
        </div>
      </div>

      {/* Sugerencias de compra */}
      {purchaseSuggestions.length > 0 && (
        <div style={styles.card}>
          <h2>📈 Sugerencias de compra</h2>
          <p>Dinero disponible: {formatCurrency(availableCash)}</p>
          <table style={styles.table}>
            <thead>
              <tr><th>Activo</th><th>Precio</th><th>Acciones</th><th>Coste</th><th>Motivo detallado</th></tr>
            </thead>
            <tbody>
              {purchaseSuggestions.map(s => (
                <tr key={s.ticker}>
                  <td>{s.name}</td>
                  <td>{formatCurrency(s.price)}</td>
                  <td>{s.sharesToBuy}</td>
                  <td>{formatCurrency(s.cost)}</td>
                  <td style={{ color: "#9ca3af", fontSize: "0.9rem", maxWidth: "300px" }}>{s.reason}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={3} style={{ textAlign: "right", fontWeight: "bold" }}>Total:</td><td>{formatCurrency(totalSuggestedCost)}</td><td></td></tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Donut y tabla de activos */}
      <div key={totalPortfolioValue} style={{ ...styles.card, display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "250px" }}>
          <h2>Distribución actual</h2>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                {pieData.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div style={{ flex: 2, overflowX: "auto" }}>
          <h2>Activos</h2>
          <p style={{ fontSize: "0.9rem", color: "#9ca3af", marginBottom: "10px" }}>
            Los pesos objetivo son tus metas de asignación. El motor sugiere compras para acercarte a ellos.
          </p>
          <table style={styles.table}>
            <thead>
              <tr>
                <th>Activo</th><th>Precio (€)</th><th>Particip.</th><th>Valor (€)</th><th>Precio compra</th>
                <th>Earnings Yield %</th><th>Ret 12m %</th><th>Ret 3m %</th><th>Ret 1m %</th>
                <th>Ganancia/pérdida</th><th>Peso obj.</th><th>Peso act.</th><th>Ataque</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.assets.map(asset => {
                const valor = asset.price * asset.shares;
                const pesoActual = (valor / totalPortfolioValue) * 100;
                const ganancia = (asset.price - asset.avgPrice) * asset.shares;
                const gananciaPorcentaje = ((asset.price - asset.avgPrice) / asset.avgPrice) * 100;
                const attack = isAttackMode(asset);
                const attackReason = attack ? getAttackReason(asset) : "";
                const valorCompra = asset.avgPrice * asset.shares;
                return (
                  <tr key={asset.ticker}>
                    <td><div style={{ fontWeight: 500 }}>{asset.name}</div><div style={styles.ticker}>{asset.ticker}</div></td>
                    <td>{formatCurrency(asset.price)}</td>
                    <td><input id={`shares-${asset.ticker}`} name={`shares-${asset.ticker}`} type="number" value={asset.shares} onChange={(e) => updateAsset(asset.ticker, "shares", Number(e.target.value))} style={styles.smallInput} step="0.0001" aria-label={`Participaciones de ${asset.name}`} /></td>
                    <td>{formatCurrency(valor)}</td>
                    <td><input id={`avgPrice-${asset.ticker}`} name={`avgPrice-${asset.ticker}`} type="number" value={asset.avgPrice} onChange={(e) => updateAsset(asset.ticker, "avgPrice", Number(e.target.value))} style={styles.smallInput} step="0.01" aria-label={`Precio de compra de ${asset.name}`} /></td>
                    <td>
                      <input
                        id={`earnings-${asset.ticker}`}
                        name={`earnings-${asset.ticker}`}
                        type="number"
                        value={asset.earningsYield ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "earningsYield", Number(e.target.value))}
                        style={styles.smallInput}
                        step="0.01"
                        min="0"
                        max="0.5"
                        aria-label={`Earnings Yield de ${asset.name}`}
                      />
                    </td>
                    <td>
                      <input
                        id={`return12m-${asset.ticker}`}
                        name={`return12m-${asset.ticker}`}
                        type="number"
                        value={asset.return12m ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "return12m", Number(e.target.value))}
                        style={styles.smallInput}
                        step="0.01"
                        min="-1"
                        max="5"
                        aria-label={`Retorno 12m de ${asset.name}`}
                      />
                    </td>
                    <td>
                      <input
                        id={`return3m-${asset.ticker}`}
                        name={`return3m-${asset.ticker}`}
                        type="number"
                        value={asset.return3m ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "return3m", Number(e.target.value))}
                        style={styles.smallInput}
                        step="0.01"
                        min="-1"
                        max="2"
                        aria-label={`Retorno 3m de ${asset.name}`}
                      />
                    </td>
                    <td>
                      <input
                        id={`return1m-${asset.ticker}`}
                        name={`return1m-${asset.ticker}`}
                        type="number"
                        value={asset.return1m ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "return1m", Number(e.target.value))}
                        style={styles.smallInput}
                        step="0.01"
                        min="-1"
                        max="1"
                        aria-label={`Retorno 1m de ${asset.name}`}
                      />
                    </td>
                    <td style={{ color: ganancia >= 0 ? "#10b981" : "#ef4444" }}>
                      <div>{formatCurrency(ganancia)} ({gananciaPorcentaje.toFixed(1)}%)</div>
                      {asset.ticker === "BTC-EUR" && (
                        <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>
                          Compra: {formatCurrency(valorCompra)} | Actual: {formatCurrency(valor)}
                        </div>
                      )}
                    </td>
                    <td>{asset.weight}%</td>
                    <td>{pesoActual.toFixed(1)}%</td>
                    <td title={attackReason}>{attack ? "⚔️" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: { padding: "40px", fontFamily: "Inter, sans-serif", backgroundColor: "#0e1117", minHeight: "100vh", color: "white" },
  title: { marginBottom: "40px" },
  card: { backgroundColor: "#161b22", padding: "24px", borderRadius: "12px", marginBottom: "24px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)" },
  label: { display: "block", marginBottom: "8px", color: "#9ca3af", fontSize: "0.9rem" },
  input: { backgroundColor: "#1f2937", border: "1px solid #374151", color: "white", padding: "8px 12px", borderRadius: "6px", width: "150px" },
  smallInput: { backgroundColor: "#1f2937", border: "1px solid #374151", color: "white", padding: "4px 6px", borderRadius: "4px", width: "80px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "14px" },
  ticker: { fontSize: "12px", color: "#6b7280" },
  button: { backgroundColor: "#3b82f6", color: "white", border: "none", padding: "8px 16px", borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontWeight: "bold" }
};

export default InstitutionalDashboard;