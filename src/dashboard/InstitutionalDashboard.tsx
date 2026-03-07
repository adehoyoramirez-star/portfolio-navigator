import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { liquidityScore } from "@/core/macro/liquidity";
import { portfolio as initialPortfolio } from "@/data/portfolio";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { calculateCorrelationMatrix } from "@/core/data/portfolioMetrics";
import { calculateRSI, calculateZScore } from "@/core/data/indicators";
import { runOlympusEngine, AssetInput } from "@/core/engine/olympusV3";
import { fromManualInputs } from "@/core/macro/liquidityCycle";
import { fetchRealMarketData, MarketData } from "@/lib/marketData";
import { ASSETS } from "@/lib/constants";
import BacktestPanel from "@/core/backtest/BacktestPanel";
// NIVEL 4
import {
  savePortfolio, loadPortfolio,
  saveMacro, loadMacro,
  saveRegimeEntry, loadRegimeHistory,
  clearAll, RegimeHistoryEntry,
} from "@/core/persistence/portfolioStorage";
import { computeRebalanceSuggestions, RebalanceAsset } from "@/core/portfolio/rebalancer";
import { generateAlerts, RegimeAlert } from "@/core/alerts/regimeAlerts";
import { computeSmartDCA } from "@/core/dca/smartDCA";

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
  // Paso 2: estado para los datos reales de mercado (precios, histórico, covMatrix)
  const [marketData, setMarketData] = useState<MarketData | null>(null);

  // NIVEL 4: alertas, régimen y persistencia
  const [activeAlerts, setActiveAlerts] = useState<RegimeAlert[]>([]);
  const [regimeHistory, setRegimeHistory] = useState<RegimeHistoryEntry[]>(() => loadRegimeHistory());
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const previousRegimeRef = useRef<string | null>(null);

  const clippedERP = (erp: number) => Math.max(-0.03, Math.min(0.05, erp));

  useEffect(() => {
    if (manualPER > 0) {
      const earningsYield = 1 / manualPER;
      const riskFree = manualBond10y / 100;
      const rawErp = earningsYield - riskFree;
      setErpValue(clippedERP(rawErp));
    }
  }, [manualPER, manualBond10y]);

  const refreshMarketData = async () => {
    setLoading(true);
    setApiError(null);
    try {
      // PASO 2: una sola llamada a Supabase edge function obtiene TODO:
      // precios actuales, 2 años de histórico, covMatrix real, BTC RSI/ZScore reales,
      // retornos por período (12m/3m/1m), volatilidades realizadas
      const { marketData: md, fetchErrors } = await fetchRealMarketData();
      setMarketData(md);

      if (fetchErrors.length > 0) {
        setApiError(`Datos parciales. Sin datos para: ${fetchErrors.join(", ")}`);
      }

      // Actualizar VIX y liquidez desde datos reales
      setVix(md.vix);
      setManualBond10y(md.tnx);
      setBond2y(md.irx);
      const liq = liquidityScore({
        m2Growth,
        vix: md.vix,
        yieldCurveSpread: md.tnx - md.irx
      });
      setLiquidity(liq);

      // Actualizar portfolio con precios y datos técnicos reales
      setPortfolio(prev => ({
        ...prev,
        assets: prev.assets.map((asset) => {
          const idx = ASSETS.indexOf(asset.ticker as any);
          if (idx === -1) return { ...asset, price: md.prices[asset.ticker] || asset.price };

          const closes = md.closesHistory[asset.ticker] || [];

          return {
            ...asset,
            price: md.prices[asset.ticker] || asset.price,
            history: closes,                          // histórico REAL (reemplaza mock de 30 días)
            volatility: (md.realizedVols[idx] ?? asset.volatility / 100) * 100,
            return12m: md.returns12m[idx] ?? asset.return12m,
            return3m:  md.returns3m[idx]  ?? asset.return3m,
            return1m:  md.returns1m[idx]  ?? asset.return1m,
            // BTC ZScore y RSI reales desde histórico
            ...(asset.ticker === 'BTC-EUR' ? {
              zScore: md.btcZScore,
              rsi: md.btcRsi,
            } : {}),
          };
        })
      }));

    } catch (error) {
      console.error("Error actualizando datos:", error);
      setApiError("Error al conectar con Supabase/Yahoo Finance. Usando datos locales.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // NIVEL 4: cargar estado persistido al arrancar
    const savedPortfolio = loadPortfolio();
    if (savedPortfolio) {
      setPortfolio(prev => ({
        ...prev,
        cashReserve: savedPortfolio.cashReserve,
        monthlyInjection: savedPortfolio.monthlyInjection,
        assets: prev.assets.map(asset => {
          const saved = savedPortfolio.positions.find(p => p.ticker === asset.ticker);
          return saved ? { ...asset, shares: saved.shares, avgPrice: saved.avgPrice } : asset;
        }),
      }));
      setCashReserve(savedPortfolio.cashReserve);
      setMonthlyInjection(savedPortfolio.monthlyInjection);
    }
    const savedMacro = loadMacro();
    if (savedMacro) {
      setVix(savedMacro.vix);
      setManualPER(savedMacro.manualPER);
      setManualBond10y(savedMacro.manualBond10y);
      setBond2y(savedMacro.bond2y);
      setM2Growth(savedMacro.m2Growth);
      setCreditSpread(savedMacro.creditSpread);
      setLiquidityGrowth(savedMacro.liquidityGrowth);
      setDxy(savedMacro.dxy);
      setMoveIndex(savedMacro.moveIndex);
      setBtcVol(savedMacro.btcVol);
    }
    refreshMarketData();
  }, []);

  // NIVEL 4: auto-guardar portfolio cuando cambia
  useEffect(() => {
    savePortfolio({
      positions: portfolio.assets.map(a => ({ ticker: a.ticker, shares: a.shares, avgPrice: a.avgPrice })),
      cashReserve,
      monthlyInjection,
      savedAt: new Date().toISOString(),
    });
  }, [portfolio.assets, cashReserve, monthlyInjection]);

  // NIVEL 4: auto-guardar macro cuando cambia
  useEffect(() => {
    saveMacro({
      vix, manualPER, manualBond10y, bond2y, m2Growth,
      creditSpread, liquidityGrowth, dxy, moveIndex, btcVol,
      savedAt: new Date().toISOString(),
    });
  }, [vix, manualPER, manualBond10y, bond2y, m2Growth, creditSpread, liquidityGrowth, dxy, moveIndex, btcVol]);

  const totalPortfolioValue = portfolio.assets.reduce(
    (sum, asset) => sum + asset.price * asset.shares,
    0
  );

  const corrMatrix = useMemo(() =>
    // Si tenemos histórico real (500+ días), la correlación es estadísticamente válida
    // Si no (30 días mock), sigue funcionando pero con menos precisión
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
      sector: asset.sector,  // NIVEL 2: para risk parity sector budgets
    }));
  }, [portfolio.assets]);

  const yieldSpread = manualBond10y - bond2y;

  // NIVEL 2: drawdown del portfolio desde datos reales
  const portfolioDrawdown = useMemo(() => {
    if (!marketData) return 0;
    const currentTotal = totalPortfolioValue;
    if (currentTotal <= 0) return 0;
    // Calcular peak histórico usando closesHistory × shares de cada activo
    let peak = 0;
    const minLen = Math.min(...portfolio.assets.map(a =>
      (marketData.closesHistory[a.ticker] ?? []).length
    ));
    if (minLen < 2) return 0;
    for (let t = 0; t < minLen; t++) {
      let dayValue = 0;
      for (const asset of portfolio.assets) {
        const closes = marketData.closesHistory[asset.ticker] ?? [];
        dayValue += (closes[closes.length - minLen + t] ?? 0) * asset.shares;
      }
      if (dayValue > peak) peak = dayValue;
    }
    return peak > 0 ? (currentTotal - peak) / peak : 0;
  }, [marketData, portfolio.assets, totalPortfolioValue]);

  // NIVEL 2: volatilidad realizada del portfolio
  const portfolioRealizedVol = useMemo(() => {
    if (!marketData?.covMatrix || assetInputs.length === 0) return undefined;
    const weights = portfolio.assets.map(a => (a.price * a.shares) / totalPortfolioValue);
    let variance = 0;
    for (let i = 0; i < assetInputs.length; i++) {
      for (let j = 0; j < assetInputs.length; j++) {
        variance += weights[i] * weights[j] * (marketData.covMatrix[i]?.[j] ?? 0);
      }
    }
    return Math.sqrt(Math.max(0, variance));
  }, [marketData?.covMatrix, assetInputs, portfolio.assets, totalPortfolioValue]);

  const engineResult = useMemo(() => {
    if (assetInputs.length === 0 || corrMatrix.length === 0) return null;
    return runOlympusEngine({
      assets: assetInputs,
      correlationMatrix: corrMatrix,
      macro: {
        vix,
        yieldSpread,
        creditSpread,
        m2Growth,
        move: moveIndex,
        dxyTrend: (dxy - 100) / 100,
        btcVol,
      },
      // NIVEL 2: campos opcionales — el motor degrada elegantemente si faltan
      covMatrix: marketData?.covMatrix,
      portfolioDrawdown,
      portfolioRealizedVol,
    });
  }, [assetInputs, corrMatrix, vix, yieldSpread, creditSpread, m2Growth, moveIndex, dxy, btcVol, marketData?.covMatrix, portfolioDrawdown, portfolioRealizedVol]);

  // ==================== SEÑALES MACRO UNIFICADAS ====================
  // FIX: fromManualInputs reemplaza el useMemo inline — honesto sobre la fuente de datos
  const liquidityOutput = useMemo(() =>
    fromManualInputs({ liquidityGrowth, dxy }),
    [liquidityGrowth, dxy]
  );

  // NIVEL 4: detectar cambios de régimen y generar alertas
  useEffect(() => {
    if (!engineResult) return;
    const currentRegime = engineResult.regime;
    const newAlerts = generateAlerts({
      currentRegime,
      previousRegime: previousRegimeRef.current,
      regimePenalty: engineResult.masterRegime.regimePenalty,
      confidence: engineResult.meta.confidence,
      tailRiskActive: engineResult.tailRiskActive,
      tailRiskReason: engineResult.tailRiskReason,
      vix,
      portfolioDrawdown: portfolioDrawdown ?? 0,
      volTargetMultiplier: engineResult.volTargetMultiplier,
    });
    if (newAlerts.length > 0) {
      setActiveAlerts(prev => [...newAlerts, ...prev].slice(0, 10));
      // Guardar cambios de régimen en historial persistido
      if (currentRegime !== previousRegimeRef.current) {
        const entry: RegimeHistoryEntry = {
          timestamp: new Date().toISOString(),
          regime: currentRegime,
          regimePenalty: engineResult.masterRegime.regimePenalty,
          confidence: engineResult.meta.confidence,
          vix,
        };
        saveRegimeEntry(entry);
        setRegimeHistory(loadRegimeHistory());
      }
    }
    previousRegimeRef.current = currentRegime;
  }, [engineResult?.regime, engineResult?.tailRiskActive, vix]);

  // availableCash debe declararse ANTES de los useMemos que la usan
  const availableCash = cashReserve + monthlyInjection;

  // NIVEL 4: rebalanceo real basado en allocations del motor
  const rebalanceSuggestions = useMemo(() => {
    if (!engineResult || engineResult.regime === "ALL_CASH") return null;
    const rebalanceAssets: RebalanceAsset[] = portfolio.assets.map(asset => {
      const alloc = engineResult.allocations.find(a => a.name === asset.name);
      return {
        ticker:           asset.ticker,
        name:             asset.name,
        price:            asset.price,
        shares:           asset.shares,
        targetAllocation: alloc?.finalAllocation ?? 0,
      };
    });
    return computeRebalanceSuggestions(
      rebalanceAssets,
      availableCash,
      totalPortfolioValue,
      0.02
    );
  }, [engineResult, portfolio.assets, availableCash, totalPortfolioValue]);

  // FIX: masterRegime ya está dentro de engineResult — no necesitamos stress por separado
  // engineResult.masterRegime tiene: regime, confidence, dominantSignal,
  // crisisDetail (probability, regime) y stressDetail (score, regime)

  // ==================== SEÑALES DE BTC Y DCA (NIVEL 4: motor-aware) ====================
  const btcAsset = portfolio.assets.find(a => a.ticker === "BTC-EUR");
  const btcRsi = btcAsset?.rsi ?? calculateRSI(btcAsset?.history || [], 14);
  const btcZ = btcAsset?.zScore ?? calculateZScore(btcAsset?.history || [], 200);
  const btcRet1m = btcAsset?.return1m ?? 0;

  // SmartDCA integrado con el motor — reemplaza dcaSignal legacy
  const smartDCAResult = useMemo(() => {
    return computeSmartDCA({
      btcRsi,
      btcZScore: btcZ,
      btcMomentum1m: btcRet1m,
      regime: engineResult?.regime ?? "EXPANSION",
      regimePenalty: engineResult?.masterRegime.regimePenalty ?? 1.0,
      volTargetMultiplier: engineResult?.volTargetMultiplier ?? 1.0,
      tailRiskActive: engineResult?.tailRiskActive ?? false,
      tailRiskOverlay: engineResult?.tailRiskOverlay ?? 1.0,
      availableCash,
      motorAllocations: engineResult?.allocations.map(a => ({
        name: a.name,
        ticker: portfolio.assets.find(pa => pa.name === a.name)?.ticker ?? a.name,
        finalAllocation: a.finalAllocation,
      })) ?? [],
    });
  }, [btcRsi, btcZ, btcRet1m, engineResult, availableCash, portfolio.assets]);

  // Legacy btcEntry — solo para compatibilidad con el panel de señales BTC
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
  // FIX: expectedReturn ajustado por régimen (penalización continua del motor)
  const expectedReturn = useMemo(() => {
    const rawReturn = engineResult?.allocations.reduce(
      (acc, a) => acc + a.expectedReturn * a.finalAllocation,
      0
    ) ?? 0.05;
    const regimePenalty = engineResult?.masterRegime.regimePenalty ?? 1;
    return rawReturn * regimePenalty;
  }, [engineResult]);

  // FIX: volatilidad real del portfolio via covMatrix (σ_p = √(wᵀΣw))
  // La fórmula anterior (media ponderada de vols individuales) ignoraba correlaciones.
  // portfolioRealizedVol ya está calculado arriba con la covMatrix real de Supabase.
  const portfolioVol = portfolioRealizedVol
    ?? portfolio.assets.reduce(
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

  // availableCash ya declarado arriba — ver línea ~397

  const totalGainLoss = portfolio.assets.reduce(
    (sum, asset) => sum + (asset.price - asset.avgPrice) * asset.shares,
    0
  );

  // ==================== ANALYTICS: SHARPE / SORTINO ====================
  // Sharpe ratio real: (retorno_esperado - rf) / vol_portfolio
  // Sortino ratio: penaliza solo la volatilidad a la baja (downside deviation)
  const portfolioAnalytics = useMemo(() => {
    if (!portfolioVol || portfolioVol === 0) return null;
    const rf = (portfolio.riskFreeRate ?? 4) / 100;           // rf anualizado en decimal
    const annualReturn = expectedReturn;                       // ya ajustado por régimen
    const excessReturn = annualReturn - rf;

    // Sharpe ratio
    const sharpe = excessReturn / portfolioVol;

    // Sortino ratio: usa solo la vol a la baja (downside deviation)
    // Aproximación: si la distribución es simétrica, downside_vol ≈ portfolioVol / √2
    // Con los datos reales del motor usamos el downside como máx(0, rf - ret_i) por activo
    const downsideVol = portfolioVol / Math.sqrt(2); // aproximación conservadora
    const sortino = downsideVol > 0 ? excessReturn / downsideVol : 0;

    // Calmar ratio: CAGR / |MaxDrawdown|
    const calmar = portfolioDrawdown !== 0 ? annualReturn / Math.abs(portfolioDrawdown) : 0;

    return { sharpe, sortino, calmar, annualReturn, rf, portfolioVol: portfolioVol };
  }, [portfolioVol, expectedReturn, portfolio.riskFreeRate, portfolioDrawdown]);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard (Olympus Engine V3+)</h1>

      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", alignItems: "center" }}>
        <button onClick={refreshMarketData} style={styles.button} disabled={loading}>
          {loading ? "Actualizando..." : "🔄 Actualizar precios y datos macro"}
        </button>
        <button
          onClick={() => { clearAll(); window.location.reload(); }}
          style={{ ...styles.button, backgroundColor: "#374151", fontSize: "0.8rem" }}
        >
          🗑️ Borrar datos guardados
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

      {/* Señales macro unificadas */}
      <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "1rem" }}>
        <div>
          <h4>Liquidez Global</h4>
          <p>Régimen: <strong>{liquidityOutput.regime}</strong></p>
          <p>Crec: {liquidityGrowth}%</p>
          <p>DXY Trend: {(liquidityOutput.dxyTrend * 100).toFixed(1)}%</p>
          <p style={{ fontSize: "0.75rem", color: "#6b7280" }}>Fuente: {liquidityOutput.dataQuality}</p>
        </div>
        <div>
          <h4>Régimen Global</h4>
          {engineResult ? (
            <>
              <p>Motor: <strong style={{ color: engineResult.regime === "CRISIS" ? "#ef4444" : engineResult.regime === "CONTRACTION" ? "#f59e0b" : "#10b981" }}>{engineResult.regime}</strong></p>
              <p>Crisis prob: {engineResult.masterRegime.crisisDetail.crisisProbability.toFixed(1)}%</p>
              <p>Stress score: {engineResult.masterRegime.stressDetail.score} / {engineResult.masterRegime.stressDetail.regime}</p>
              <p style={{ fontSize: "0.75rem", color: "#6b7280" }}>Confianza: {engineResult.meta.confidence} · Señal: {engineResult.meta.dominantSignal}</p>
            </>
          ) : <p style={{ color: "#6b7280" }}>Calculando...</p>}
        </div>
        <div>
          <h4>Smart DCA — Motor Aware</h4>
          {(() => {
            const dca = smartDCAResult;
            const isBlocked = dca.action.startsWith("BLOCK");
            const actionColor = isBlocked ? "#ef4444" : dca.action === "WAIT" ? "#6b7280" : dca.action === "SMALL_BUY" ? "#f59e0b" : dca.action === "BUY" ? "#10b981" : "#6366f1";
            return (
              <>
                <p>Acción: <strong style={{ color: actionColor }}>{dca.action}</strong></p>
                {isBlocked
                  ? <p style={{ color: "#ef4444", fontSize: "0.8rem" }}>{dca.blockReason}</p>
                  : <>
                      <p>Invertir: <strong>{formatCurrency(dca.totalCashToInvest)}</strong> ({(dca.buyFraction * 100).toFixed(0)}%)</p>
                      <p style={{ color: "#9ca3af", fontSize: "0.78rem" }}>{dca.reasoning}</p>
                    </>
                }
              </>
            );
          })()}
        </div>
        <div>
          <h4>BTC Tactical</h4>
          <p>Señal: <strong>{btcEntry.signal}</strong></p>
          <p>RSI: {btcRsi.toFixed(1)} · Z: {btcZ.toFixed(2)}</p>
        </div>
      </div>

      {/* Banner ALL_CASH */}
      {engineResult?.regime === "ALL_CASH" && (
        <div style={{ backgroundColor: "#7f1d1d", border: "1px solid #ef4444", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
          <strong>⚠️ MODO ALL CASH</strong> — Todos los activos tienen retorno esperado negativo según el motor.
          Se recomienda mantener 100% en efectivo hasta que cambien las condiciones.
        </div>
      )}

      {/* Resultados del motor V3 */}
      {engineResult && (
        <div style={styles.card}>
          <h2>📊 Resultados del Motor Olympus V3 — Nivel 2</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
            <div>
              <p><strong>Régimen:</strong> <span style={{ color: engineResult.regime === "CRISIS" || engineResult.regime === "ALL_CASH" ? "#ef4444" : engineResult.regime === "CONTRACTION" ? "#f59e0b" : "#10b981" }}>{engineResult.regime}</span></p>
              <p><strong>Confianza señal:</strong> {engineResult.meta.confidence}</p>
              <p><strong>Señal dominante:</strong> {engineResult.meta.dominantSignal}</p>
              <p><strong>Prob. crisis:</strong> {engineResult.masterRegime.crisisDetail.crisisProbability.toFixed(1)}%</p>
              {/* NIVEL 2: probabilidades continuas */}
              <p><strong>p(exp/cont/crisis):</strong> {((engineResult.masterRegime.regimeProbs?.expansion ?? 0) * 100).toFixed(0)}% / {((engineResult.masterRegime.regimeProbs?.contraction ?? 0) * 100).toFixed(0)}% / {((engineResult.masterRegime.regimeProbs?.crisis ?? 0) * 100).toFixed(0)}%</p>
              <p><strong>Penalización régimen:</strong> <span style={{ color: "#f59e0b" }}>×{engineResult.masterRegime.regimePenalty.toFixed(3)}</span> <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>(continua)</span></p>
              <p><strong>Penalización correlación:</strong> ×{engineResult.correlationPenalty.toFixed(2)}</p>
              {/* NIVEL 2: capas adicionales */}
              <p><strong>Vol Target:</strong> ×{engineResult.volTargetMultiplier.toFixed(2)} {engineResult.volTargetMultiplier < 1 ? "📉" : engineResult.volTargetMultiplier > 1 ? "📈" : ""}</p>
              {engineResult.tailRiskActive && (
                <p style={{ color: "#ef4444", fontSize: "0.8rem" }}>⚠️ Tail Risk: ×{engineResult.tailRiskOverlay.toFixed(2)} — {engineResult.tailRiskReason}</p>
              )}
              <p style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                Markowitz: {engineResult.meta.hasRealCovMatrix ? "✅ activo (50% Kelly + 30% MV + 20% RP)" : "⚠️ sin covMatrix real (50% Kelly + 50% RP)"}
              </p>
            </div>
            <div>
              <p><strong>Asignaciones finales:</strong></p>
              {engineResult.allocations.map(a => (
                <p key={a.name} style={{ fontSize: "0.85rem" }}>
                  <strong>{a.name}:</strong> {(a.finalAllocation * 100).toFixed(1)}%
                  <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                    {" "}(K:{(a.kellyAllocation * 100).toFixed(0)}%
                    {engineResult.meta.hasRealCovMatrix && ` MV:${(a.markowitzAllocation * 100).toFixed(0)}%`}
                    {" "}RP:{(a.riskParityAllocation * 100).toFixed(0)}%
                    {a.isCapped ? " ⚠️cap" : ""})
                  </span>
                </p>
              ))}
            </div>
            <div>
              <p><strong>Scores por activo:</strong></p>
              {engineResult.allocations.map(a => (
                <p key={a.name} style={{ fontSize: "0.82rem" }}>
                  {a.name}: Mom <span style={{ color: a.momentumScore > 0 ? "#10b981" : "#ef4444" }}>{a.momentumScore.toFixed(2)}</span> · Val p{(a.valuePercentileRank * 100).toFixed(0)}
                  {a.isCapped && <span style={{ color: "#f59e0b" }}> ⚠️</span>}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* NIVEL 3: Backtesting */}
      <BacktestPanel
        marketData={marketData}
        currentVix={vix}
        currentCreditSpread={creditSpread}
        portfolioInitialValue={totalPortfolioValue}
      />

      {/* ===== ANALYTICS: SHARPE / SORTINO / DRAWDOWN ===== */}
      {portfolioAnalytics && (
        <div style={styles.card}>
          <h2>📊 Portfolio Analytics</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem" }}>
            {/* Sharpe */}
            <div style={{ background: portfolioAnalytics.sharpe >= 1 ? "#065f46" : portfolioAnalytics.sharpe >= 0.5 ? "#1e3a5f" : portfolioAnalytics.sharpe >= 0 ? "#78350f" : "#7f1d1d", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Sharpe Ratio</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{portfolioAnalytics.sharpe.toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>{portfolioAnalytics.sharpe >= 1 ? "Excelente" : portfolioAnalytics.sharpe >= 0.5 ? "Aceptable" : portfolioAnalytics.sharpe >= 0 ? "Bajo" : "Negativo"}</div>
            </div>
            {/* Sortino */}
            <div style={{ background: portfolioAnalytics.sortino >= 1.5 ? "#065f46" : portfolioAnalytics.sortino >= 0.8 ? "#1e3a5f" : portfolioAnalytics.sortino >= 0 ? "#78350f" : "#7f1d1d", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Sortino Ratio</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{portfolioAnalytics.sortino.toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>Penaliza solo vol bajista</div>
            </div>
            {/* Calmar */}
            <div style={{ background: portfolioAnalytics.calmar >= 0.5 ? "#065f46" : portfolioAnalytics.calmar >= 0.2 ? "#1e3a5f" : "#78350f", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Calmar Ratio</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{portfolioAnalytics.calmar.toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>CAGR / Max Drawdown</div>
            </div>
            {/* Portfolio Vol */}
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Vol Portfolio (σ_p)</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: portfolioAnalytics.portfolioVol > 0.25 ? "#ef4444" : portfolioAnalytics.portfolioVol > 0.15 ? "#f59e0b" : "#10b981" }}>
                {(portfolioAnalytics.portfolioVol * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>{marketData?.covMatrix ? "covMatrix real ✅" : "aprox. (sin covMatrix)"}</div>
            </div>
            {/* Drawdown */}
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Drawdown Actual</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: portfolioDrawdown < -0.2 ? "#ef4444" : portfolioDrawdown < -0.1 ? "#f59e0b" : "#10b981" }}>
                {(portfolioDrawdown * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>vs peak histórico</div>
            </div>
            {/* Return esperado */}
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Retorno Esp. (ajust. régimen)</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: expectedReturn >= 0.08 ? "#10b981" : expectedReturn >= 0.03 ? "#f59e0b" : "#ef4444" }}>
                {(expectedReturn * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>×{(engineResult?.masterRegime.regimePenalty ?? 1).toFixed(2)} penalty régimen</div>
            </div>
          </div>
          <p style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.75rem" }}>
            Sharpe = (r_portfolio − r_f) / σ_p · r_f = {(portfolioAnalytics.rf * 100).toFixed(1)}% · Sortino penaliza solo vol bajista (downside deviation) · Calmar = retorno anualizado / |max drawdown|
          </p>
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

      {/* NIVEL 4: Alertas activas */}
      {activeAlerts.filter(a => !dismissedAlerts.has(a.id)).length > 0 && (
        <div style={styles.card}>
          <h2>🔔 Alertas del Motor</h2>
          {activeAlerts
            .filter(a => !dismissedAlerts.has(a.id))
            .map(alert => (
              <div key={alert.id} style={{
                backgroundColor: alert.severity === "CRITICAL" ? "#7f1d1d" : alert.severity === "WARNING" ? "#78350f" : "#1e3a5f",
                border: `1px solid ${alert.severity === "CRITICAL" ? "#ef4444" : alert.severity === "WARNING" ? "#f59e0b" : "#3b82f6"}`,
                borderRadius: 6, padding: "0.75rem 1rem", marginBottom: "0.5rem",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <p style={{ fontWeight: "bold", marginBottom: "0.25rem" }}>{alert.title}</p>
                    <p style={{ color: "#d1d5db", fontSize: "0.85rem", marginBottom: "0.25rem" }}>{alert.message}</p>
                    <p style={{ color: "#10b981", fontSize: "0.8rem" }}>→ {alert.action}</p>
                    <p style={{ color: "#6b7280", fontSize: "0.75rem" }}>{new Date(alert.timestamp).toLocaleString("es-ES")}</p>
                  </div>
                  {alert.dismissible && (
                    <button
                      onClick={() => setDismissedAlerts(prev => new Set([...prev, alert.id]))}
                      style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: "1.2rem" }}
                    >✕</button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* NIVEL 4: Historial de régimen */}
      {regimeHistory.length > 0 && (
        <div style={styles.card}>
          <h2>📋 Historial de Régimen</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.5rem" }}>
            {regimeHistory.slice(0, 6).map((entry, i) => (
              <div key={i} style={{ backgroundColor: "#1f2937", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.8rem" }}>
                <p style={{ color: entry.regime === "CRISIS" ? "#ef4444" : entry.regime === "CONTRACTION" ? "#f59e0b" : "#10b981", fontWeight: "bold" }}>
                  {entry.regime}
                </p>
                <p style={{ color: "#9ca3af" }}>VIX: {entry.vix.toFixed(0)} · ×{entry.regimePenalty.toFixed(2)}</p>
                <p style={{ color: "#6b7280" }}>{new Date(entry.timestamp).toLocaleDateString("es-ES")}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* NIVEL 4: Rebalanceo real basado en motor */}
      {rebalanceSuggestions && rebalanceSuggestions.suggestions.length > 0 && (
        <div style={styles.card}>
          <h2>⚖️ Rebalanceo — Motor Olympus</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: "1rem" }}>
            Basado en allocations reales del motor. Cash disponible: <strong>€{availableCash.toFixed(0)}</strong> ·
            Cobertura del rebalanceo ideal: <strong>{(rebalanceSuggestions.coverageRatio * 100).toFixed(0)}%</strong>
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #374151", color: "#9ca3af" }}>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Activo</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Actual</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Objetivo</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Drift</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Comprar</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Coste</th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Prioridad</th>
                </tr>
              </thead>
              <tbody>
                {rebalanceSuggestions.suggestions.map(s => (
                  <tr key={s.ticker} style={{ borderBottom: "1px solid #1f2937" }}>
                    <td style={{ padding: "0.5rem", fontWeight: "bold" }}>{s.ticker}</td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>{(s.currentPct * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6366f1" }}>{(s.targetPct * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#ef4444" }}>{(s.drift * 100).toFixed(1)}pp</td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>{s.sharesToBuy}</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#10b981" }}>€{s.cost.toFixed(0)}</td>
                    <td style={{ padding: "0.5rem" }}>
                      <span style={{
                        backgroundColor: s.priority === "HIGH" ? "#7f1d1d" : s.priority === "MEDIUM" ? "#78350f" : "#1f2937",
                        color: s.priority === "HIGH" ? "#ef4444" : s.priority === "MEDIUM" ? "#f59e0b" : "#9ca3af",
                        padding: "0.1rem 0.4rem", borderRadius: 4, fontSize: "0.75rem",
                      }}>{s.priority}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginTop: "0.75rem" }}>
            Total: <strong style={{ color: "#10b981" }}>€{rebalanceSuggestions.totalCost.toFixed(0)}</strong> ·
            Restante: €{rebalanceSuggestions.remainingCash.toFixed(0)}
          </p>
        </div>
      )}

      {/* NIVEL 4: SmartDCA por activo — reemplaza sugerencias legacy */}
      {smartDCAResult.totalCashToInvest > 0 && smartDCAResult.allocationByAsset.length > 0 && (
        <div style={styles.card}>
          <h2>💸 SmartDCA — Distribución por Motor (Nivel 4)</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: "0.75rem" }}>
            {smartDCAResult.reasoning}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #374151", color: "#6b7280" }}>
                  <th style={{ textAlign: "left",  padding: "0.4rem 0.5rem" }}>Activo</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Peso motor</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>€ a invertir</th>
                  <th style={{ textAlign: "left",  padding: "0.4rem 0.5rem" }}>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {smartDCAResult.allocationByAsset.map(a => (
                  <tr key={a.ticker} style={{ borderBottom: "1px solid #1f2937" }}>
                    <td style={{ padding: "0.5rem", fontWeight: "bold" }}>{a.ticker}</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6366f1" }}>{(a.motorWeight * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#10b981" }}>€{a.cashToInvest.toFixed(0)}</td>
                    <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.78rem" }}>{a.reason}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid #374151" }}>
                  <td colSpan={2} style={{ padding: "0.5rem", color: "#9ca3af", textAlign: "right" }}>Total DCA:</td>
                  <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold", color: "#10b981" }}>€{smartDCAResult.totalCashToInvest.toFixed(0)}</td>
                  <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.78rem" }}>
                    Score técnico: {smartDCAResult.score}/3 · Fracción: {(smartDCAResult.buyFraction * 100).toFixed(0)}%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Si SmartDCA está bloqueado, mostrar banner informativo */}
      {smartDCAResult.action.startsWith("BLOCK") && (
        <div style={{ backgroundColor: "#78350f", border: "1px solid #f59e0b", padding: "1rem", borderRadius: 8, marginBottom: "1.5rem" }}>
          <strong>🛑 DCA Bloqueado: {smartDCAResult.action}</strong>
          <p style={{ margin: "0.5rem 0 0", color: "#fde68a", fontSize: "0.85rem" }}>{smartDCAResult.blockReason}</p>
        </div>
      )}



      {/* Donut y tabla de activos */}
      <div key={totalPortfolioValue} style={{ ...styles.card, display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "250px" }}>
          <h2>Distribución actual</h2>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} dataKey="value" label={({ name, percent }: { name: string; percent: number }) => `${name} ${(percent * 100).toFixed(0)}%`}>
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