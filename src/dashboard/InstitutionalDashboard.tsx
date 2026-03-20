import React, { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { liquidityScore } from "@/core/macro/liquidity";
import { portfolio as initialPortfolio } from "@/core/types/portfolio";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { calculateCorrelationMatrix } from "@/core/data/portfolioMetrics";
import { calculateRSI, calculateZScore } from "@/core/data/indicators";
import { runOlympusEngine, AssetInput } from "@/core/engine/olympusV3";
import { fromManualInputs } from "@/core/macro/liquidityCycle";
import { fetchRealMarketData, MarketData } from "@/lib/marketData";
import { ASSETS } from "@/lib/constants";
import BacktestPanel from "@/core/backtest/BacktestPanel";
import { logEngineDecision } from "@/lib/decisionLog";
// NIVEL 4
import {
  savePortfolio, loadPortfolio,
  saveMacro, loadMacro,
  saveRegimeEntry, loadRegimeHistory,
  clearAll, RegimeHistoryEntry,
} from "@/core/persistence/portfolioStorage";
import { computeRebalanceSuggestions, RebalanceAsset, RebalanceSuggestion } from "@/core/portfolio/rebalancer";
import { detectCycleTops, isBTCDominanceFalling, type CycleTopInputs, type CycleTopSignal } from "@/core/risk/cycleTopDetector";
import { analyzeSpainTax, type PortfolioTaxSummary, type TaxAnalysis } from "@/core/tax/spainTaxAnalysis";
import { generateAlerts, RegimeAlert } from "@/core/alerts/regimeAlerts";
import { computeSmartDCA } from "@/core/dca/smartDCA";
import {
  computeCEWS, loadCEWSHistory, saveCEWSDataPoint, generateSyntheticHistory,
  CEWSDataPoint,
} from "@/core/macro/crisisEarlyWarning";
import { computeRegimeDuration, detectRegimeStartDate } from "@/core/macro/regimeDuration";
import { runAllStressScenarios, type StressResult } from "@/core/simulation/stressScenarios";
import { runWalkForward } from "@/core/backtest/walkForwardOptimizer";
import {
  analyzeBitcoinCycle,
  getPowerLawProjection,
  type BitcoinCycleInputs,
  type BitcoinCycleOutput,
  type ElliottWavePoint,
  type ElliottWaveLabel,
} from "@/core/crypto/bitcoinCycleAnalyzer";

// GaugeChart eliminado — AUDIT-FIX-02: velocímetros reemplazados por header compacto de estado

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
  simulations: number = 10000,
  // Parámetros multivariante opcionales — si se pasan, se usan activos individuales con correlaciones reales
  multivariate?: {
    weights: number[];          // pesos del portfolio [suma=1]
    mus: number[];              // retornos esperados anualizados por activo
    sigmas: number[];           // volatilidades anualizadas por activo
    covMatrix: number[][];      // covarianza anualizada n×n
    jumpIntensityBTC: number;   // λ solo para BTC (los ETFs tienen menos saltos bruscos)
    jumpMean: number;
    jumpStd: number;
    btcIdx: number;             // índice del activo BTC en el array
  }
): { mean: number; median: number; p25: number; p75: number; worst5: number; best95: number; simulations: number[]; muUsed: number } {
  const months = years * 12;
  const finalValues: number[] = [];

  if (multivariate && multivariate.covMatrix.length > 1 && multivariate.weights.length > 1) {
    // ── SIMULACIÓN MULTIVARIANTE (Cholesky) ──────────────────────────────────
    // Descomposición de Cholesky de la covMatrix mensualizada para correlaciones reales.
    // Esto captura la dinámica de correlación entre activos (ej: todos bajan juntos en crisis).
    const n = multivariate.weights.length;
    const monthlyMus = multivariate.mus.map(m => m / 12);
    const monthlySigmas = multivariate.sigmas.map(s => s / Math.sqrt(12));
    // Covarianza mensualizada
    const monthlyCov = multivariate.covMatrix.map(row => row.map(v => v / 12));
    // Cholesky decomposition: L tal que L*Lᵀ = Σ
    const L = choleskyDecomposition(monthlyCov, n);

    for (let sim = 0; sim < simulations; sim++) {
      const assetValues = multivariate.weights.map((w) => initialCapital * w);
      for (let m = 0; m < months; m++) {
        // Generar n normales independientes y correlacionarlas via Cholesky
        const z = Array.from({ length: n }, () => randomNormal());
        const correlated = Array.from({ length: n }, (_, i) =>
          L[i].reduce((s, lij, j) => s + lij * z[j], 0)
        );
        // Añadir contribución mensual proporcional al peso objetivo
        for (let i = 0; i < n; i++) {
          assetValues[i] += monthlyContribution * multivariate.weights[i];
          const muI = monthlyMus[i] - 0.5 * monthlySigmas[i] ** 2;
          let jump = 0;
          // Jump diffusion solo en BTC; otros activos tienen distribución más normal
          if (i === multivariate.btcIdx) {
            const pJump = 1 - Math.exp(-multivariate.jumpIntensityBTC / 12);
            if (Math.random() < pJump) jump = multivariate.jumpMean + multivariate.jumpStd * randomNormal();
          }
          assetValues[i] = assetValues[i] * Math.exp(muI + correlated[i] + jump);
        }
      }
      finalValues.push(assetValues.reduce((s, v) => s + v, 0));
    }
  } else {
    // ── SIMULACIÓN UNIVARIANTE (fallback cuando no hay covMatrix) ────────────
    const monthlyMu = mu / 12;
    const monthlySigma = sigma / Math.sqrt(12);
    for (let sim = 0; sim < simulations; sim++) {
      let value = initialCapital;
      for (let m = 0; m < months; m++) {
        value += monthlyContribution;
        const diffusion = monthlyMu - 0.5 * monthlySigma ** 2 + monthlySigma * randomNormal();
        const pJump = 1 - Math.exp(-jumpIntensity / 12);
        const jump = Math.random() < pJump ? jumpMean + jumpStd * randomNormal() : 0;
        value = value * Math.exp(diffusion + jump);
      }
      finalValues.push(value);
    }
  }

  finalValues.sort((a, b) => a - b);
  const nSim = finalValues.length;
  const mean   = finalValues.reduce((a, b) => a + b, 0) / nSim;
  const median = finalValues[Math.floor(nSim * 0.50)];
  const p25    = finalValues[Math.floor(nSim * 0.25)];
  const p75    = finalValues[Math.floor(nSim * 0.75)];
  const worst5 = finalValues[Math.floor(nSim * 0.05)];
  const best95 = finalValues[Math.floor(nSim * 0.95)];
  return { mean, median, p25, p75, worst5, best95, simulations: finalValues, muUsed: mu };
}

// Cholesky decomposition: L tal que L*Lᵀ = A (A debe ser definida positiva)
// Si A no es numericamente definitiva positiva, regularización diagonal mínima.
function choleskyDecomposition(A: number[][], n: number): number[][] {
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(sum, 1e-10)); // regularización si no es def. positiva
      } else {
        L[i][j] = L[j][j] > 1e-12 ? sum / L[j][j] : 0;
      }
    }
  }
  return L;
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
  // AUDIT-FIX-01: separar jumpIntensity BTC (λ_btc ≈ 5-8/año) del portfolio (λ_p ≈ 0.5-1.5/año)
  // El error original usaba jumpIntensity=7 (exclusivo BTC) para todo el portfolio,
  // añadiendo +2.5% de drift artificial anual → mediana inflada de €105k a €443k.
  const [jumpIntensity, setJumpIntensity] = useState(7.0);          // λ_btc: saltos BTC (modo multivariante)
  const [jumpIntensityPortfolio, setJumpIntensityPortfolio] = useState(1.0); // λ_p: saltos cartera completa (fallback univariante)
  const [jumpMean, setJumpMean] = useState(-0.08);   // AUDIT-FIX-01: jumpMean negativo (-8%) para reflejar que los saltos son crashes, no rallies
  const [jumpStd, setJumpStd] = useState(0.12);      // AUDIT-FIX-01: std aumentada para capturar asimetría real

  // Inputs manuales macro
  const [vix, setVix] = useState(19);
  const [manualPER, setManualPER] = useState(29.69);
  const [manualBond10y, setManualBond10y] = useState(4.2);
  const [bond2y, setBond2y] = useState(3.0);
  const [m2Growth, setM2Growth] = useState(4.3);
  const [creditSpread, setCreditSpread] = useState(1.5);
  const [rsi, setRsi] = useState(55);
  const [momentum, setMomentum] = useState(0.2);

  // Nuevos parámetros manuales para las señales macro
  const [liquidityGrowth, setLiquidityGrowth] = useState(3.2);       // % crecimiento liquidez global
  const [dxy, setDxy] = useState(99.7);                               // Dollar index
  const [moveIndex, setMoveIndex] = useState(120);                   // MOVE index
  const [wtiOil, setWtiOil] = useState<number>(98);                 // WTI Crude $/barril — auto Yahoo (CL=F)
  const [btcVol, setBtcVol] = useState(0.65);                        // volatilidad BTC (65%)
  const [btcDominance, setBtcDominance] = useState(57.0);           // BTC.D % — CoinGecko auto (PASO 3)
  const [mvrvRatio, setMvrvRatio] = useState(1.8);                   // MVRV — Glassnode auto (PASO 4)
  const [btcRsiWeekly, setBtcRsiWeekly] = useState<number | undefined>(undefined);
  const [prevBtcDominance, setPrevBtcDominance] = useState<number | undefined>(undefined);

  // PASO 3: Fear & Greed Index — Alternative.me (sin key)
  const [fearGreedIndex, setFearGreedIndex] = useState<{
    value: number;
    label: string;
    source: string;
  } | null>(null);

  // PASO 4: fuente de datos on-chain — "GLASSNODE" si API key configurada, "MANUAL" si no
  const [onChainSource, setOnChainSource] = useState<"GLASSNODE" | "MANUAL">("MANUAL");

  // BTC Cycle Analyzer inputs (persistidos)
  const [puellMultiple, setPuellMultiple] = useState<number | undefined>(undefined); // Glassnode auto (PASO 4)
  const [hashRibbonState, setHashRibbonState] = useState<"CAPITULATION" | "RECOVERY" | "EXPANSION" | undefined>(undefined); // Glassnode auto (PASO 4)
  const [piCycleMa111, setPiCycleMa111] = useState<number | undefined>(undefined);
  const [piCycleMa350x2, setPiCycleMa350x2] = useState<number | undefined>(undefined);
  const [elliottPivots, setElliottPivots] = useState<ElliottWavePoint[]>([]);
  const [elliottCurrentWave, setElliottCurrentWave] = useState<ElliottWaveLabel | undefined>(undefined);
  const [elliottPivotsText, setElliottPivotsText] = useState<string>("");

  // PASO 6: Motor de Inteligencia AI — Gemini + Grok + Claude
  const [aiIntelligence, setAiIntelligence] = useState<{
    gemini: { regimeNarrative: string; macroValidation: string; btcCycleSummary: string; model: string; cachedAt: string; error?: string } | null;
    grok:   { marketSentiment: string; topNarratives: string[]; blackSwanAlert: boolean; blackSwanReason: string | null; model: string; cachedAt: string; error?: string } | null;
    claude: { elliottAnalysis: string; rebalanceAdvice: string; contradictionAnalysis: string; model: string; cachedAt: string; error?: string } | null;
    fetchedAt: string;
    cacheHit: boolean;
  } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  // Señales de techo de ciclo — inputs específicos por activo
  const [uraniumSpot, setUraniumSpot] = useState<number | undefined>(undefined);   // $/lb — uxc.com
  const [uraniumLT, setUraniumLT] = useState<number | undefined>(undefined);       // $/lb largo plazo — uxc.com
  const [bookToBill, setBookToBill] = useState<number | undefined>(undefined);     // SEMI.org — mensual
  const [inflationBreakeven, setInflationBreakeven] = useState<number | undefined>(undefined); // TradingView: T5YIE

  const [erpValue, setErpValue] = useState(0.025);
  const [liquidity, setLiquidity] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  // Paso 2: estado para los datos reales de mercado (precios, histórico, covMatrix)
  const [marketData, setMarketData] = useState<MarketData | null>(null);

  // NIVEL 4: alertas, régimen y persistencia
  const [activeAlerts, setActiveAlerts] = useState<RegimeAlert[]>([]);
  const [regimeHistory, setRegimeHistory] = useState<RegimeHistoryEntry[]>(() => loadRegimeHistory());
  const [cewsHistory, setCewsHistory] = useState<CEWSDataPoint[]>(() => loadCEWSHistory());
  const [cewsPreviousLevel, setCewsPreviousLevel] = useState<import("@/core/macro/crisisEarlyWarning").CEWSLevel>("CLEAR");
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

      // ── Auto-populate ALL macro fields from real data ──────────────────────
      // PASO 1 — Activar todas las fuentes automáticas disponibles.
      // El usuario puede hacer override manual después si lo necesita.
      // Fuentes activadas:
      //   Yahoo:  VIX, Bonos 10y/2y, DXY, Brent Crude, MOVE Index, Credit Spread (HYG proxy)
      //   FRED:   M2 Growth, PER Shiller CAPE

      // CEWS: poblar historial automáticamente desde Yahoo (5 años semanales)
      if (md.cewsHistory.length > 0) {
        setCewsHistory(md.cewsHistory);
      }

      if (fetchErrors.length > 0) {
        setApiError(`Datos parciales. Sin datos para: ${fetchErrors.join(", ")}`);
      }

      // ── Yahoo Finance — tiempo real ──────────────────────────────────────
      setVix(md.vix);
      setManualBond10y(md.tnx);
      setBond2y(md.irx);

      // DXY — activo (ticker DX-Y.NYB en TICKERS)
      if (md.dxy > 0) setDxy(parseFloat(md.dxy.toFixed(2)));

      // Brent Crude Oil — activo (ticker BZ=F en TICKERS)
      if (md.wtiOil > 0) setWtiOil(parseFloat(md.wtiOil.toFixed(2)));

      // MOVE Index — activo si viene de Yahoo (^MOVE)
      if (md.moveIndex && md.moveIndex > 0) setMoveIndex(parseFloat(md.moveIndex.toFixed(1)));

      // Credit Spread HY — proxy desde HYG spread (FRED BAMLH0A0HYM2 o HYG Yahoo)
      if (md.creditSpread && md.creditSpread > 0) setCreditSpread(parseFloat(md.creditSpread.toFixed(2)));

      // ── FRED — mensual/semanal ───────────────────────────────────────────
      // M2 Growth desde FRED M2SL
      if (md.m2GrowthSource === "FRED") setM2Growth(parseFloat(md.m2Growth.toFixed(2)));

      // PER Shiller CAPE desde FRED
      if (md.perSource === "FRED" && md.per > 0) setManualPER(parseFloat(md.per.toFixed(2)));

      // Liquidez Global: usar liquidityScore calculado con datos reales
      const liq = liquidityScore({
        m2Growth: md.m2GrowthSource === "FRED" ? md.m2Growth : m2Growth,
        vix: md.vix,
        yieldCurveSpread: md.tnx - md.irx
      });
      setLiquidity(liq);

      // ── PASO 5: auto-seed de los últimos inputs manuales de alta prioridad ──

      // RSI S&P500 — ahora con Wilder EMA fiable (antes ~50 siempre)
      if (md.sp500Rsi > 0 && md.sp500Rsi !== 50) setRsi(parseFloat(md.sp500Rsi.toFixed(1)));

      // Momentum S&P500 — ya calculado en marketData (Jegadeesh-Titman 12m-1m)
      // Convertimos retorno decimal a la escala del input [-1, 1]
      if (md.sp500Momentum12m !== 0) {
        setMomentum(parseFloat(Math.max(-1, Math.min(1, md.sp500Momentum12m)).toFixed(4)));
      }

      // BTC RSI semanal — resampleado de diario con Wilder EMA
      if (md.btcRsiWeekly > 0 && md.btcRsiWeekly !== 50) {
        setBtcRsiWeekly(parseFloat(md.btcRsiWeekly.toFixed(1)));
      }

      // Pi Cycle MAs — calculados desde histórico diario BTC (requiere 350+ días)
      if (md.piCycleMa111 && md.piCycleMa111 > 0) setPiCycleMa111(md.piCycleMa111);
      if (md.piCycleMa350x2 && md.piCycleMa350x2 > 0) setPiCycleMa350x2(md.piCycleMa350x2);

      // Breakeven inflación 5y — FRED T5YIFR (serie diaria, sin key)
      if (md.inflationBreakeven && md.inflationBreakeven > 0) {
        setInflationBreakeven(md.inflationBreakeven);
      }

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

      if (engineResult) {
        logEngineDecision({
          engineResult,
          macro: { vix: md.vix, creditSpread, yieldSpread: md.tnx - md.irx, m2Growth },
          marketData: md,
          allocationsBefore: portfolio.assets,
          triggerReason: "scheduled_refresh",
        });
      }

      // ── PASO 3: CoinGecko + Alternative.me (en paralelo, no bloquean si fallan) ──
      try {
        const { data: cryptoRaw } = await supabase.functions.invoke('crypto-signals');
        if (cryptoRaw && !cryptoRaw.error) {
          // BTC Dominance % — sustituye al input manual
          if (cryptoRaw.btcDominance > 0) setBtcDominance(parseFloat(cryptoRaw.btcDominance.toFixed(2)));

          // Fear & Greed → proxy de momentum/sentiment BTC
          // Lo guardamos en estado para mostrarlo en el dashboard
          if (cryptoRaw.fearGreedValue >= 0) setFearGreedIndex({
            value: cryptoRaw.fearGreedValue,
            label: cryptoRaw.fearGreedLabel,
            source: cryptoRaw.fearGreedSource,
          });

          // Volatilidad BTC 24h como proxy de btcVol si viene disponible
          if (Math.abs(cryptoRaw.btcVol24h) > 0) {
            // change24h en % → anualizar: vol_anual ≈ |change24h| * √365
            const impliedAnnualVol = Math.abs(cryptoRaw.btcVol24h / 100) * Math.sqrt(365);
            // Blend 30% dato instantáneo + 70% valor actual (no reemplazar bruscamente)
            setBtcVol(prev => parseFloat((prev * 0.70 + impliedAnnualVol * 0.30).toFixed(3)));
          }
        }
      } catch {
        // CoinGecko/Alt.me no críticos — el motor funciona sin ellos
      }

      // ── PASO 4: Glassnode on-chain (en paralelo, requiere GLASSNODE_API_KEY) ──
      try {
        const { data: onChainRaw } = await supabase.functions.invoke('glassnode-onchain');
        if (onChainRaw && !onChainRaw.error && onChainRaw.errors?.length < 5) {
          // MVRV Ratio — sustituye input manual de lookintobitcoin.com
          if (onChainRaw.mvrv?.value > 0) setMvrvRatio(parseFloat(onChainRaw.mvrv.value.toFixed(3)));

          // Puell Multiple — sustituye input manual
          if (onChainRaw.puell?.value > 0) setPuellMultiple(parseFloat(onChainRaw.puell.value.toFixed(3)));

          // Hash Ribbon State — derivado automáticamente de MA30 vs MA60 del hash rate
          if (onChainRaw.hashRibbonState) setHashRibbonState(onChainRaw.hashRibbonState);

          // Marcar fuente on-chain como automática para los labels del dashboard
          setOnChainSource("GLASSNODE");
        }
      } catch {
        // Glassnode no crítico — el motor funciona sin on-chain
      }

    } catch (error) {
      setApiError("Error al conectar con Supabase/Yahoo Finance. Usando datos locales.");
    } finally {
      setLoading(false);
    }
  };

  // ── PASO 6: Motor de Inteligencia AI ────────────────────────────────────────
  const refreshAIIntelligence = async () => {
    if (!engineResult) return;
    setAiLoading(true);
    try {
      const contradictions: string[] = [];
      if (dxy > 103 && wtiOil > 90) contradictions.push("DXY alto + Brent alto (señales opuestas)");
      if (vix > 28 && rsi > 65) contradictions.push("VIX pánico + RSI sobrecompra (incoherente)");
      if (creditSpread > 4.5 && manualPER > 26) contradictions.push("Credit spread elevado + PER caro");

      const piCycleSeparation = piCycleMa111 && piCycleMa350x2 && piCycleMa350x2 > 0
        ? ((piCycleMa350x2 - piCycleMa111) / piCycleMa350x2) * 100 : null;

      const totalPortfolioVal = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);

      const ctx = {
        regime: engineResult.regime,
        regimePenalty: engineResult.masterRegime.regimePenalty ?? 1,
        confidence: engineResult.meta.confidence,
        dominantSignal: engineResult.meta.dominantSignal,
        probCrisis: (engineResult.masterRegime as any).crisisProb ?? 0,
        vix, bond10y: manualBond10y, bond2y,
        creditSpread, m2Growth, dxy, brent: wtiOil, move: moveIndex,
        erp: erpValue, breakeven: inflationBreakeven ?? null,
        btcPrice: portfolio.assets.find(a => a.ticker === 'BTC-EUR')?.price ?? 0,
        btcRsi: portfolio.assets.find(a => a.ticker === 'BTC-EUR')?.rsi ?? 50,
        btcRsiWeekly: btcRsiWeekly ?? 50,
        btcDominance, mvrv: mvrvRatio,
        fearGreed: fearGreedIndex?.value ?? 50,
        fearGreedLabel: fearGreedIndex?.label ?? 'Neutral',
        totalValue: totalPortfolioVal,
        allocations: engineResult.allocations.map(a => ({
          name: a.name, pct: a.finalAllocation, momentum: a.momentumScore
        })),
        portfolioVol: portfolioVol ?? 0.18,
        drawdown: portfolioDrawdown ?? 0,
        muEffective: Math.min(0.15, expectedReturn),
        elliottWave: elliottCurrentWave ?? null,
        piCycleMa111: piCycleMa111 ?? null,
        piCycleMa350x2: piCycleMa350x2 ?? null,
        piCycleSeparation,
        hashRibbon: hashRibbonState ?? null,
        puell: puellMultiple ?? null,
        contradictions,
      };

      const { data } = await supabase.functions.invoke('ai-intelligence', { body: ctx });
      if (data) {
        setAiIntelligence(data);

        // ── PASO 7: Alerta Telegram si Grok detecta cisne negro ───────────
        if (data.grok?.blackSwanAlert && data.grok.blackSwanReason) {
          supabase.functions.invoke('telegram-alerts', {
            body: {
              type: 'black_swan',
              blackSwanReason: data.grok.blackSwanReason,
              currentRegime: engineResult.regime,
              vix,
            },
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('AI Intelligence error:', e);
    } finally {
      setAiLoading(false);
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
      if (savedMacro.btcDominance !== undefined) setBtcDominance(savedMacro.btcDominance);
      if (savedMacro.mvrvRatio !== undefined) setMvrvRatio(savedMacro.mvrvRatio);
      // Jump params
      if (savedMacro.jumpIntensity !== undefined) setJumpIntensity(savedMacro.jumpIntensity);
      // AUDIT-FIX-01: cargar jumpIntensityPortfolio — si no existe en storage legacy usar 1.0 (correcto)
      if (savedMacro.jumpIntensityPortfolio !== undefined) setJumpIntensityPortfolio(savedMacro.jumpIntensityPortfolio);
      else setJumpIntensityPortfolio(1.0); // migración: usuarios con storage viejo reciben default correcto
      if (savedMacro.jumpMean !== undefined) setJumpMean(savedMacro.jumpMean);
      if (savedMacro.jumpStd !== undefined) setJumpStd(savedMacro.jumpStd);
      // BTC Cycle
      if (savedMacro.puellMultiple !== undefined) setPuellMultiple(savedMacro.puellMultiple);
      if (savedMacro.hashRibbonState) setHashRibbonState(savedMacro.hashRibbonState as "CAPITULATION" | "RECOVERY" | "EXPANSION");
      if (savedMacro.piCycleMa111 !== undefined) setPiCycleMa111(savedMacro.piCycleMa111);
      if (savedMacro.piCycleMa350x2 !== undefined) setPiCycleMa350x2(savedMacro.piCycleMa350x2);
      if (savedMacro.elliottCurrentWave) setElliottCurrentWave(savedMacro.elliottCurrentWave as ElliottWaveLabel);
      if (savedMacro.elliottPivots && savedMacro.elliottPivots.length > 0) {
        const pts = savedMacro.elliottPivots.map((p: { price: number; dateStr: string; type: string }) => ({
          price: p.price,
          date: new Date(p.dateStr),
          label: p.type,   // stored as 'type' in PersistedMacro, maps to 'label' in ElliottWavePoint
        }));
        setElliottPivots(pts);
        setElliottPivotsText(savedMacro.elliottPivots.map((p: { price: number; dateStr: string; type: string }) => `${p.price}:${p.type}`).join(", "));
      }
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
      btcDominance, mvrvRatio,
      jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd,
      puellMultiple, hashRibbonState,
      piCycleMa111, piCycleMa350x2,
      elliottCurrentWave,
      elliottPivots: elliottPivots.map((p: ElliottWavePoint) => ({
        price: p.price,
        dateStr: p.date ? p.date.toISOString() : new Date().toISOString(),
        type: p.label,
      })),
      savedAt: new Date().toISOString(),
    });
  }, [vix, manualPER, manualBond10y, bond2y, m2Growth, creditSpread, liquidityGrowth, dxy, moveIndex, btcVol, btcDominance, mvrvRatio, jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd, puellMultiple, hashRibbonState, piCycleMa111, piCycleMa350x2, elliottCurrentWave, elliottPivots]);

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

  // CEWS: historial efectivo — real si hay ≥4 puntos, sintético si no
  const effectiveCEWSHistory = useMemo(() => {
    if (cewsHistory.length >= 4) return cewsHistory;
    return generateSyntheticHistory(vix, manualBond10y - bond2y, creditSpread, m2Growth, 12);
  }, [cewsHistory, vix, manualBond10y, bond2y, creditSpread, m2Growth]);

  // CEWS: calcular early warning (antes del motor para que el motor lo use)
  const cewsResult = useMemo(() => computeCEWS(effectiveCEWSHistory), [effectiveCEWSHistory]);

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

  // ── Walk-Forward (declarado ANTES de engineResult — sus adaptive weights alimentan el motor) ──
  const walkForwardResult = useMemo(() => {
    const btcCloses = marketData?.closesHistory["BTC-EUR"] ?? [];
    if (btcCloses.length < 60) return null;
    const weeklyReturns: number[] = [];
    for (let i = 5; i < btcCloses.length; i += 5) {
      if (btcCloses[i - 5] > 0) weeklyReturns.push(btcCloses[i] / btcCloses[i - 5] - 1);
    }
    return runWalkForward(weeklyReturns, 5);
  }, [marketData?.closesHistory]);

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
        wtiOil,           // ← WTI Crude: penalización geopolítica automática
      },
      // Opcionales — motor degrada elegantemente si faltan
      covMatrix: marketData?.covMatrix,
      portfolioDrawdown,
      portfolioRealizedVol,
      erpValue,                            // ERP conectado al motor — ajusta Kelly en renta variable
      liquidityGrowth,                     // para auto-generar views macro en Black-Litterman
      cewsHistory: effectiveCEWSHistory,   // CEWS: historial para early warning predictivo
      // Walk-forward adaptive weights — si hay overfitting detectado, ajustar pesos de factores
      // automáticamente para reducir la dependencia en momentum (factor más propenso a overfitting)
      adaptiveFactorWeights: walkForwardResult?.adaptiveFactorWeights,
    });
  }, [assetInputs, corrMatrix, vix, yieldSpread, creditSpread, m2Growth, moveIndex, dxy, btcVol, wtiOil, erpValue, marketData?.covMatrix, portfolioDrawdown, portfolioRealizedVol, effectiveCEWSHistory, walkForwardResult?.adaptiveFactorWeights]);

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

      // ── PASO 7: Alertas Push Telegram ────────────────────────────────────
      // Solo si hay cambio real de régimen o tail risk — no por cada render
      const totalValue = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);

      // Alerta de cambio de régimen
      if (currentRegime !== previousRegimeRef.current && previousRegimeRef.current !== null) {
        supabase.functions.invoke('telegram-alerts', {
          body: {
            type: 'regime_change',
            previousRegime: previousRegimeRef.current,
            currentRegime,
            regimePenalty: engineResult.masterRegime.regimePenalty,
            confidence: engineResult.meta.confidence,
            dominantSignal: engineResult.meta.dominantSignal,
            vix,
            portfolioValue: totalValue,
            portfolioDrawdown: portfolioDrawdown ?? 0,
          },
        }).catch(() => {}); // silencioso — no bloquea el UI
      }

      // Alerta de tail risk activado
      if (engineResult.tailRiskActive) {
        supabase.functions.invoke('telegram-alerts', {
          body: {
            type: 'tail_risk',
            tailRiskReason: engineResult.tailRiskReason,
            volMultiplier: engineResult.volTargetMultiplier,
            currentRegime,
            vix,
          },
        }).catch(() => {});
      }

      // Alerta de VIX extremo (>30 o >40)
      const hasVixAlert = newAlerts.some(a => a.id.startsWith('vix'));
      if (hasVixAlert) {
        supabase.functions.invoke('telegram-alerts', {
          body: {
            type: 'vix_spike',
            vix,
            currentRegime,
            portfolioValue: totalValue,
          },
        }).catch(() => {});
      }
    }
    previousRegimeRef.current = currentRegime;
  }, [engineResult, vix, portfolioDrawdown, portfolio]);

  // CEWS: guardar punto de datos diariamente cuando cambian las macro inputs
  useEffect(() => {
    if (vix === 0) return;
    const updated = saveCEWSDataPoint({
      vix,
      yieldSpread: manualBond10y - bond2y,
      creditSpread,
      m2Growth,
    });
    setCewsHistory(updated);
  }, [vix, manualBond10y, bond2y, creditSpread, m2Growth]);

  // CEWS: trackear nivel anterior para detectar mejora (señal de ataque)
  const prevCewsLevelRef = React.useRef<import("@/core/macro/crisisEarlyWarning").CEWSLevel>("CLEAR");
  useEffect(() => {
    if (!cewsResult) return;
    if (cewsResult.level !== prevCewsLevelRef.current) {
      setCewsPreviousLevel(prevCewsLevelRef.current);
      prevCewsLevelRef.current = cewsResult.level;
    }
  }, [cewsResult?.level]);

  // ── Regime Duration ────────────────────────────────────────────────────────
  const regimeDuration = useMemo(() => {
    if (!engineResult) return null;
    const regime = engineResult.regime === "ALL_CASH" ? "CRISIS" : engineResult.regime as "EXPANSION" | "CONTRACTION" | "CRISIS";
    const regimeStartDate = detectRegimeStartDate(
      regimeHistory.map(r => ({ timestamp: r.timestamp, regime: r.regime })),
      regime
    );
    return computeRegimeDuration({ currentRegime: regime, regimeStartDate });
  }, [engineResult?.regime, regimeHistory]);

  // ── Stress Scenarios ────────────────────────────────────────────────────────
  const stressResults = useMemo(() => {
    if (!engineResult || totalPortfolioValue === 0) return [];
    const weightedAssets = portfolio.assets.map(a => ({
      ticker: a.ticker,
      name: a.name,
      weight: engineResult.allocations.find(al => al.name === a.name)?.finalAllocation ?? 0,
    }));
    return runAllStressScenarios(weightedAssets, totalPortfolioValue);
  }, [engineResult?.allocations, portfolio.assets, totalPortfolioValue]);

  // ── CYCLE TOP DETECTOR ──────────────────────────────────────────
  // Calcula señales de techo de ciclo ANTES del rebalanceo
  // No depende de availableCash — solo de los inputs macro del usuario
  const cycleTopResult = useMemo(() => {
    const cycleInputs: CycleTopInputs = {
      mvrvRatio,
      btcDominanceFalling: isBTCDominanceFalling(btcDominance, prevBtcDominance),
      btcRsiWeekly,
      uraniumSpotPrice: uraniumSpot,
      uraniumLTPrice: uraniumLT,
      bookToBill,
      bondYield10y: manualBond10y,
      inflationBreakeven,
      brentOil: wtiOil > 0 ? wtiOil : undefined,
    };
    return detectCycleTops(cycleInputs);
  }, [mvrvRatio, btcDominance, prevBtcDominance, btcRsiWeekly, uraniumSpot, uraniumLT, bookToBill, manualBond10y, inflationBreakeven, wtiOil]);

  // ── BTC CYCLE ANALYZER (Power Law + Halving + Puell + Hash Ribbon + Elliott) ──
  const btcCycleResult = useMemo((): BitcoinCycleOutput | null => {
    const btcAssetLocal = portfolio.assets.find(a => a.ticker === "BTC-EUR");
    if (!btcAssetLocal || btcAssetLocal.price <= 0) return null;
    const inputs: BitcoinCycleInputs = {
      currentPrice: btcAssetLocal.price,
      puellMultiple,
      hashRibbonState,
      piCycleMa111,
      piCycleMa350x2,
      elliottPivots:      elliottPivots.length >= 2 ? elliottPivots : undefined,
      elliottCurrentWave: elliottCurrentWave,
      eurUsdRate: 1.08,
    };
    try { return analyzeBitcoinCycle(inputs); }
    catch { return null; }
  }, [portfolio.assets, puellMultiple, hashRibbonState, piCycleMa111, piCycleMa350x2, elliottPivots, elliottCurrentWave]);

  // ── AVAILABLE CASH (paso 1 — sin DCA state, resuelve la dependencia circular) ──
  // Para smartDCA siempre pasamos cashReserve + monthlyInjection (necesita el total para calcular tramos de ataque)
  // Para el rebalanceo final usaremos dcaBlocked DESPUÉS de que smartDCAResult esté disponible
  const totalCashForDCA = cashReserve + monthlyInjection;

  // FIX: rebalanceSuggestions (pase preliminar con totalCashForDCA) eliminado.
  // Era un useMemo redundante — nunca se renderiazba. Solo rebalanceFinal se usa en el JSX.
  // El pase final con availableCash correcto (post-DCA) está en rebalanceFinal abajo.

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
      btcDominance,
      mvrvRatio,
      regime: engineResult?.regime ?? "EXPANSION",
      regimePenalty: engineResult?.masterRegime.regimePenalty ?? 1.0,
      volTargetMultiplier: engineResult?.volTargetMultiplier ?? 1.0,
      tailRiskActive: engineResult?.tailRiskActive ?? false,
      tailRiskOverlay: engineResult?.tailRiskOverlay ?? 1.0,
      availableCash: totalCashForDCA,
      motorAllocations: engineResult?.allocations.map(a => {
        const asset = portfolio.assets.find(pa => pa.name === a.name);
        return {
          name: a.name,
          ticker: asset?.ticker ?? a.name,
          finalAllocation: a.finalAllocation,
          price: asset?.price ?? 0,   // necesario para calcular lotes enteros
        };
      }) ?? [],
      // NIVEL 5: CEWS para modo ataque
      cewsOutput: cewsResult ?? undefined,
      cewsPreviousLevel,
    });
  }, [btcRsi, btcZ, btcRet1m, engineResult, cashReserve, monthlyInjection, portfolio.assets, cewsResult, cewsPreviousLevel]);

  // ── AVAILABLE CASH FINAL — ahora que tenemos el estado del DCA ──
  // DCA bloqueado → solo cashReserve (la inyección mensual se congela como liquidez defensiva)
  // DCA libre     → cashReserve + monthlyInjection (todo disponible para invertir)
  const dcaAction  = smartDCAResult?.action ?? "WATCH";
  const dcaBlocked = dcaAction === "BLOCK_VOL" || dcaAction === "BLOCK_CRISIS" || dcaAction === "BLOCK_TAIL_RISK";
  const availableCash = dcaBlocked ? cashReserve : cashReserve + monthlyInjection;

  // ── REBALANCEO FINAL con availableCash correcto + cycle top signals ──
  // Recalculamos las sugerencias de compra/venta con el cash real disponible
  const rebalanceFinal = useMemo(() => {
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
      0.02,
      cycleTopResult.signals
    );
  }, [engineResult, portfolio.assets, availableCash, totalPortfolioValue, cycleTopResult]);

  // ── ANÁLISIS FISCAL ESPAÑA ──────────────────────────────────────
  // Calcula si conviene vender para cada SELL sugerido por el cicleTopDetector
  // Tiene en cuenta: tramos IRPF 2025, compensación de pérdidas del portfolio,
  // pérdida esperada según zona de ciclo, y break-even fiscal
  const taxAnalysis = useMemo((): PortfolioTaxSummary | null => {
    const sells = rebalanceFinal?.sellSuggestions ?? [];
    if (sells.length === 0) return null;
    return analyzeSpainTax(
      portfolio.assets.map(a => ({
        ticker: a.ticker, name: a.name,
        shares: a.shares, avgPrice: a.avgPrice, price: a.price,
      })),
      sells.map((s: RebalanceSuggestion) => ({
        ticker: s.ticker, sharesToSell: s.sharesToSell,
        trimPct: s.trimPct, cycleZone: s.cycleZone,
      }))
    );
  }, [rebalanceFinal, portfolio.assets]);

  // ── TAX-AWARE REBALANCE — integrar fiscal en las órdenes de venta ──────────
  // Si el análisis fiscal dice NO_CONVIENE para una venta, la marcamos como bloqueada
  // y añadimos el contexto fiscal al reason para que el usuario tome una decisión informada.
  // La señal de ciclo se mantiene (el riesgo no desaparece), pero se recomienda alternativa.
  const taxAwareRebalance = useMemo(() => {
    if (!rebalanceFinal || !taxAnalysis) return rebalanceFinal;
    const modifiedSells = rebalanceFinal.sellSuggestions.map((sell: RebalanceSuggestion) => {
      const taxInfo = taxAnalysis.analyses.find(t => t.ticker === sell.ticker);
      if (!taxInfo) return sell;
      // Enriquecer el reason con información fiscal real
      const taxLabel = taxInfo.verdict === "NO_CONVIENE"
        ? `⚠️ FISCAL: Pagar ${taxInfo.taxAfterOffset.toFixed(0)}€ en IRPF NO compensa (ratio ${taxInfo.taxVsLossRatio.toFixed(1)}x). Espera corrección adicional.`
        : taxInfo.verdict === "EN_PERDIDAS"
        ? `✅ FISCAL: Posición en pérdidas — venta sin impuesto. Aprovecha para compensar ganancias.`
        : taxInfo.verdict === "CONVIENE"
        ? `✅ FISCAL: Coste fiscal ${taxInfo.taxAfterOffset.toFixed(0)}€ (${(taxInfo.effectiveRate * 100).toFixed(1)}% ef.) — conviene vender antes de mayor caída.`
        : `🟡 FISCAL: Analizar — ${taxInfo.taxAfterOffset.toFixed(0)}€ en IRPF. Breakeven precio: ${taxInfo.breakEvenPrice.toFixed(0)}€.`;
      return {
        ...sell,
        reason: `${sell.reason} | ${taxLabel}`,
        // Si NO_CONVIENE y no hay pérdidas que compensar, bajar prioridad a LOW
        priority: (taxInfo.verdict === "NO_CONVIENE" && taxAnalysis.availableLossOffset < taxInfo.taxGross * 0.5)
          ? "LOW" as const
          : sell.priority,
      };
    });
    return {
      ...rebalanceFinal,
      suggestions: [...modifiedSells, ...rebalanceFinal.buySuggestions],
      sellSuggestions: modifiedSells,
    };
  }, [rebalanceFinal, taxAnalysis]);

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
  // AUDIT-FIX-01 (CRÍTICO): Mu correcto para el simulador.
  //
  // PROBLEMA IDENTIFICADO EN AUDITORÍA:
  //   - portfolio.assets tiene expectedReturn hardcoded: BTC=45%, Semis=18%, Uranio=25%...
  //   - Mu ponderado bruto con esos valores = ~18.9%
  //   - En el fallback univariante (sin Supabase covMatrix), se usaban esos valores SIN
  //     aplicar la penalización de régimen → mu efectivo ~19% en vez de 8.8%
  //   - Resultado: mediana Monte Carlo ~€443k en lugar de los ~€105k correctos.
  //
  // FIX APLICADO (por orden de prioridad):
  //   1. Si hay marketData.expectedReturns (James-Stein shrinkage desde Yahoo, φ=0.65):
  //      usar esos retornos ponderados × allocations × regimePenalty → FUENTE MÁS HONESTA
  //   2. Si no hay marketData: usar portfolio.assets.expectedReturn hardcoded PERO
  //      aplicar SIEMPRE la penalización de régimen
  //   3. Cap duro: mu máximo 15% para el portfolio completo (no para BTC individual)
  //      Justificación: un portfolio diversificado no puede tener mu > Nasdaq históricamente
  //
  // Priors de largo plazo usados en James-Stein (marketData.ts):
  //   BTC: 15% · Semis: 14% · MSCI Momentum: 11% · Uranio: 10% · EM: 8% · Gold: 6% · REITs: 9%
  //   Fuente: Damodaran 2024, Vanguard CMA 2024, BlackRock BII 2024
  const expectedReturn = useMemo(() => {
    if (!engineResult) return 0.07; // fallback conservador
    const regimePenalty = engineResult.masterRegime.regimePenalty ?? 1;

    // PRIORIDAD 1: James-Stein desde Yahoo (si disponible) — estimador sin recency bias
    if (marketData?.expectedReturns && marketData.expectedReturns.length > 0) {
      const weightedJS = ASSETS.reduce((acc, ticker, i) => {
        const alloc = engineResult.allocations.find(
          a => a.name === portfolio.assets.find(p => p.ticker === ticker)?.name
        );
        const w = alloc?.finalAllocation ?? (1 / ASSETS.length);
        const muJS = marketData.expectedReturns[i] ?? 0.08;
        return acc + muJS * w;
      }, 0);
      // Cap 15%: portfolio diversificado — no puede superar rentabilidad histórica Nasdaq
      const capped = Math.min(0.15, Math.max(0.02, weightedJS));
      return capped * regimePenalty;
    }

    // PRIORIDAD 2: fallback a hardcoded CON penalización (bug anterior: faltaba el *regimePenalty)
    const weightedHardcoded = engineResult.allocations.reduce((acc, alloc) => {
      const asset = portfolio.assets.find(a => a.name === alloc.name);
      const r = asset ? (asset.expectedReturn / 100) : 0.10;
      return acc + r * alloc.finalAllocation;
    }, 0);
    // Cap 15% también aquí — BTC=45% hardcoded es un outlier que no debe dominar el portfolio
    const capped = Math.min(0.15, Math.max(0.02, weightedHardcoded));
    return capped * regimePenalty;
  }, [engineResult, portfolio.assets, marketData?.expectedReturns]);

  // FIX: volatilidad real del portfolio via covMatrix (σ_p = √(wᵀΣw))
  // La fórmula anterior (media ponderada de vols individuales) ignoraba correlaciones.
  // portfolioRealizedVol ya está calculado arriba con la covMatrix real de Supabase.
  const portfolioVol = portfolioRealizedVol
    ?? portfolio.assets.reduce(
        (acc, asset) => acc + (asset.volatility / 100) * (asset.price * asset.shares / totalPortfolioValue),
        0
       );

  const jumpSim = useMemo(() => {
    // AUDIT-FIX-01: separación de jumpIntensity por modo de simulación
    //   - Multivariante (Cholesky): jumpIntensityBTC=jumpIntensity solo para BTC
    //   - Univariante (fallback):   jumpIntensityPortfolio ≈ 1.0 (cartera diversificada)
    //     ANTES se usaba jumpIntensity=7 aquí → +2.5% drift artificial/año → €443k mediana
    //
    // AUDIT-FIX-01b: cap de mu al 15% — portfolio diversificado no supera Nasdaq histórico
    const muCapped = Math.min(0.15, expectedReturn);

    const hasCovMatrix = marketData?.covMatrix && marketData.covMatrix.length > 1;
    const hasEngineAllocs = engineResult && engineResult.allocations.length > 0;

    if (hasCovMatrix && hasEngineAllocs && ASSETS.length > 1) {
      const weights = ASSETS.map(ticker => {
        const alloc = engineResult!.allocations.find(a => a.name === portfolio.assets.find(p => p.ticker === ticker)?.name);
        return alloc?.finalAllocation ?? (1 / ASSETS.length);
      });
      // James-Stein por activo con cap individual (BTC hasta 25%, resto hasta 20%)
      const mus = ASSETS.map((_, i) => {
        const raw = marketData!.expectedReturns?.[i] ?? muCapped;
        return Math.min(0.25, Math.max(0.02, raw));
      });
      const sigmas = ASSETS.map((_, i) => (marketData!.realizedVols?.[i] ?? portfolioVol));
      const btcIdx = ASSETS.indexOf('BTC-EUR' as any);

      return monteCarloJumpDiffusion(
        totalPortfolioValue, monthlyInjection, muCapped, portfolioVol,
        jumpIntensity, jumpMean, jumpStd, years, 5000,
        {
          weights, mus, sigmas,
          covMatrix: marketData!.covMatrix,
          jumpIntensityBTC: jumpIntensity,   // λ_btc correcto — puede ser 5-8/año
          jumpMean, jumpStd,
          btcIdx: btcIdx >= 0 ? btcIdx : 0,
        }
      );
    }

    // Fallback univariante: jumpIntensityPortfolio (1.0), NO jumpIntensity BTC (7)
    // AUDIT-FIX-01: este era el path del bug original
    return monteCarloJumpDiffusion(
      totalPortfolioValue, monthlyInjection, muCapped, portfolioVol,
      jumpIntensityPortfolio, jumpMean, jumpStd, years, 5000
    );
  }, [totalPortfolioValue, monthlyInjection, expectedReturn, portfolioVol,
      jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd, years,
      marketData?.covMatrix, marketData?.expectedReturns, engineResult]);

  const { mean: meanValue, median: medianValue, p25, p75, worst5, best95, simulations } = jumpSim;

  // CVaR (Expected Shortfall) — calculado directamente sobre los valores absolutos
  // de las 5000 simulaciones del Monte Carlo.
  //
  // FIX BUG-07: La versión anterior dividía por `totalPortfolioValue` (capital inicial
  // ~€5,685) en lugar del capital total invertido en el período (initial + monthly*12*years).
  // Esto hacía que los multiplicadores fueran artificialmente altos (~16x en vez de ~1.7x),
  // distorsionando la interpretación del CVaR como porcentaje de pérdida.
  //
  // Solución: calcular CVaR directamente en euros absolutos sobre los valores simulados.
  // CVaR 95% = media aritmética del peor 5% de los valores finales simulados.
  const cvarResult = useMemo(() => {
    if (simulations.length === 0) return null;
    const totalInvested = totalPortfolioValue + monthlyInjection * 12 * years;
    const sorted = [...simulations].sort((a, b) => a - b);
    const cutoff95 = Math.max(1, Math.floor(sorted.length * 0.05));
    const cutoff99 = Math.max(1, Math.floor(sorted.length * 0.01));
    const cvar95Abs = sorted.slice(0, cutoff95).reduce((s, v) => s + v, 0) / cutoff95;
    const cvar99Abs = sorted.slice(0, cutoff99).reduce((s, v) => s + v, 0) / cutoff99;
    // Pérdida esperada en el peor 5% = capital total invertido − valor medio del peor 5%
    const loss95 = totalInvested - cvar95Abs;
    const loss99 = totalInvested - cvar99Abs;
    // tailRatio: cuánto más extremo es el CVaR99 respecto al CVaR95
    const tailRatio = cvar95Abs > 0 ? Math.abs(cvar99Abs / cvar95Abs) : 1;
    return { cvar95Abs, cvar99Abs, loss95, loss99, tailRatio, totalInvested };
  }, [simulations, totalPortfolioValue, monthlyInjection, years]);
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
    const engineAlloc = engineResult?.allocations.find(a => a.name === asset.name)?.finalAllocation ?? (asset.weight / 100);
    const targetValue = totalPortfolioValue * engineAlloc;
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

      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={refreshMarketData} style={styles.button} disabled={loading}>
          {loading ? "Actualizando..." : "🔄 Actualizar precios y datos macro"}
        </button>

        {/* PASO 6: Botón Motor Intelligence — llama a Gemini, Grok y Claude */}
        <button
          onClick={refreshAIIntelligence}
          disabled={aiLoading || !engineResult}
          style={{
            ...styles.button,
            background: aiLoading
              ? "#374151"
              : "linear-gradient(135deg, #1e3a5f 0%, #312e81 50%, #1e1b4b 100%)",
            border: "1px solid #6366f1",
            fontSize: "0.85rem",
            opacity: !engineResult ? 0.5 : 1,
          }}
        >
          {aiLoading ? "⏳ Analizando..." : "🧠 Motor Intelligence AI"}
        </button>

        {/* PASO 7: Botón resumen diario Telegram */}
        <button
          onClick={async () => {
            if (!engineResult) return;
            const totalVal = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);
            await supabase.functions.invoke('telegram-alerts', {
              body: {
                type: 'daily_summary',
                currentRegime: engineResult.regime,
                regimePenalty: engineResult.masterRegime.regimePenalty,
                confidence: engineResult.meta.confidence,
                portfolioValue: totalVal,
                portfolioDrawdown: portfolioDrawdown ?? 0,
                fearGreed: fearGreedIndex?.value ?? undefined,
                fearGreedLabel: fearGreedIndex?.label ?? undefined,
                btcPrice: portfolio.assets.find(a => a.ticker === 'BTC-EUR')?.price,
                btcDominance,
                allocations: engineResult.allocations.map(a => ({ name: a.name, pct: a.finalAllocation })),
                muEffective: Math.min(0.15, expectedReturn),
                geminiNarrative: aiIntelligence?.gemini?.regimeNarrative ?? undefined,
              },
            });
          }}
          disabled={!engineResult}
          style={{ ...styles.button, backgroundColor: "#0a7d4f", fontSize: "0.8rem", opacity: !engineResult ? 0.5 : 1 }}
          title="Enviar resumen del portfolio a Telegram"
        >
          📱 Resumen Telegram
        </button>

        <button
          onClick={() => { clearAll(); window.location.reload(); }}
          style={{ ...styles.button, backgroundColor: "#374151", fontSize: "0.8rem" }}
        >
          🗑️ Borrar datos guardados
        </button>
        <span style={{ color: "#9ca3af", fontSize: "0.85rem" }}>
          {aiIntelligence && !aiLoading && (
            <span style={{ color: "#818cf8" }}>
              ✓ AI {aiIntelligence.cacheHit ? "(caché)" : ""}
              {" · "}{new Date(aiIntelligence.fetchedAt).toLocaleTimeString("es-ES")}
              {" · "}{[
                aiIntelligence.gemini && "Gemini",
                aiIntelligence.grok && "Grok",
                aiIntelligence.claude && "Claude",
              ].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
      </div>
      {apiError && <div style={{ color: "#ef4444", marginBottom: "10px" }}>{apiError}</div>}

      {/* ── AUDIT-FIX-02: Header de Estado del Motor (reemplaza velocímetros redundantes) ── */}
      {/* Los gauges ERP/Liquidez/VIX/RSI/Momentum duplicaban los inputs manuales de abajo.  */}
      {/* Este panel compacto muestra solo la salida del motor: lo que importa al instante.   */}
      {engineResult && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "0.5rem",
          marginBottom: "1.5rem",
        }}>
          {/* Régimen */}
          <div style={{
            background: engineResult.regime === "CRISIS" ? "#1c0a0a" : engineResult.regime === "CONTRACTION" ? "#1c1107" : "#071c10",
            border: `1px solid ${engineResult.regime === "CRISIS" ? "#ef4444" : engineResult.regime === "CONTRACTION" ? "#f59e0b" : "#10b981"}`,
            borderRadius: 8, padding: "0.6rem 0.9rem",
          }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>RÉGIMEN</div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: engineResult.regime === "CRISIS" ? "#ef4444" : engineResult.regime === "CONTRACTION" ? "#f59e0b" : "#10b981"
            }}>
              {engineResult.regime.toUpperCase()}
            </div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              ×{(engineResult.masterRegime.regimePenalty ?? 1).toFixed(3)} penalización
            </div>
          </div>

          {/* VIX */}
          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>VIX <span style={{ color: "#10b981" }}>● auto</span></div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: vix > 30 ? "#ef4444" : vix > 20 ? "#f59e0b" : "#10b981"
            }}>{vix.toFixed(1)}</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              {vix > 30 ? "Pánico" : vix > 20 ? "Tensión" : "Normalidad"}
            </div>
          </div>

          {/* ERP */}
          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>ERP</div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: erpValue > 0.02 ? "#10b981" : erpValue > 0 ? "#f59e0b" : "#ef4444"
            }}>{(erpValue * 100).toFixed(1)}%</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              {erpValue > 0.02 ? "Prima positiva" : erpValue > 0 ? "Prima baja" : "Bolsa cara vs bonos"}
            </div>
          </div>

          {/* Mu MC */}
          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>μ MONTE CARLO</div>
            <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#818cf8" }}>
              {(Math.min(0.15, expectedReturn) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              anual ajustado régimen · cap 15%
            </div>
          </div>

          {/* Vol Target */}
          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>σ PORTFOLIO</div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: portfolioVol > 0.22 ? "#ef4444" : portfolioVol > 0.16 ? "#f59e0b" : "#10b981"
            }}>{(portfolioVol * 100).toFixed(1)}%</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>volatilidad realizada</div>
          </div>

          {/* Señal DCA */}
          <div style={{
            background: engineResult.regime === "CRISIS" ? "#1c0a0a" : "#071c10",
            border: `1px solid ${engineResult.regime === "CRISIS" ? "#ef4444" : "#10b981"}`,
            borderRadius: 8, padding: "0.6rem 0.9rem",
          }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>SEÑAL DCA</div>
            <div style={{
              fontSize: "0.85rem", fontWeight: "bold",
              color: engineResult.regime === "CRISIS" ? "#ef4444" : "#10b981"
            }}>
              {engineResult.regime === "CRISIS" ? "🛑 BLOQUEADO" :
               engineResult.regime === "CONTRACTION" ? "⚠️ REDUCIDO" : "✅ ACTIVO"}
            </div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              {engineResult.regime === "CRISIS" ? "mantener liquidez" : "compras permitidas"}
            </div>
          </div>

          {/* Liquidez calculada (liquidityScore) */}
          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>LIQUIDEZ <span style={{ color: "#10b981" }}>● auto</span></div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: liquidity > 0.6 ? "#10b981" : liquidity > 0.35 ? "#f59e0b" : "#ef4444"
            }}>{(liquidity * 100).toFixed(0)}%</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              {liquidity > 0.6 ? "Expansiva" : liquidity > 0.35 ? "Neutral" : "Restrictiva"}
            </div>
          </div>

          {/* Fear & Greed — Alternative.me (PASO 3) */}
          {fearGreedIndex && (
            <div style={{
              background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem"
            }}>
              <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>FEAR & GREED <span style={{ color: "#10b981" }}>● auto</span></div>
              <div style={{
                fontSize: "1.1rem", fontWeight: "bold",
                color: fearGreedIndex.value <= 25 ? "#ef4444"
                     : fearGreedIndex.value <= 45 ? "#f59e0b"
                     : fearGreedIndex.value <= 55 ? "#9ca3af"
                     : fearGreedIndex.value <= 75 ? "#10b981"
                     : "#818cf8"
              }}>{fearGreedIndex.value}</div>
              <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>{fearGreedIndex.label}</div>
            </div>
          )}

          {/* On-Chain status — Glassnode (PASO 4) */}
          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>ON-CHAIN</div>
            <div style={{ fontSize: "0.75rem", color: onChainSource === "GLASSNODE" ? "#10b981" : "#f59e0b", fontWeight: "bold" }}>
              {onChainSource === "GLASSNODE" ? "✅ Glassnode" : "⚠️ Manual"}
            </div>
            <div style={{ fontSize: "0.62rem", color: "#6b7280" }}>
              {onChainSource === "GLASSNODE" ? "MVRV · Puell · Hash Ribbon auto" : "configurar GLASSNODE_API_KEY"}
            </div>
          </div>

          {/* Fuente datos Yahoo */}
          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>FUENTE DATOS</div>
            <div style={{ fontSize: "0.75rem", color: "#d1d5db", fontWeight: "bold" }}>
              {marketData ? "✅ Yahoo Finance" : "⚠️ Manual"}
            </div>
            <div style={{ fontSize: "0.62rem", color: "#6b7280" }}>
              {marketData ? "precios + covMatrix reales" : "pendiente actualización"}
            </div>
          </div>
        </div>
      )}

      {/* Inputs macro — fuentes automáticas activadas en PASO 1 */}
      <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem" }}>
        <div>
          <label style={styles.label}>PER S&P 500 {" "}
            <span style={{ fontSize: "0.65rem", color: marketData?.perSource === "FRED" ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {marketData?.perSource === "FRED" ? "● FRED auto (CAPE)" : "● manual"}
            </span>
          </label>
          <input type="number" value={manualPER} onChange={(e) => setManualPER(Number(e.target.value))} style={styles.smallInput} step="0.1" min="1" />
        </div>
        <div>
          <label style={styles.label}>Bono USA 10y % {" "}<span style={{ fontSize: "0.65rem", color: "#10b981", fontWeight: "normal" }}>● Yahoo auto</span></label>
          <input type="number" value={manualBond10y} onChange={(e) => setManualBond10y(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
        </div>
        <div>
          <label style={styles.label}>Bono USA 2y % {" "}<span style={{ fontSize: "0.65rem", color: "#10b981", fontWeight: "normal" }}>● Yahoo auto</span></label>
          <input type="number" value={bond2y} onChange={(e) => setBond2y(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
        </div>
        <div>
          <label style={styles.label}>
            M2 Growth %{" "}
            <span style={{ fontSize: "0.65rem", color: marketData?.m2GrowthSource === "FRED" ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {marketData?.m2GrowthSource === "FRED" ? "● FRED auto (M2SL)" : "● manual"}
            </span>
          </label>
          <input type="number" value={m2Growth} onChange={(e) => setM2Growth(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>Credit Spread %{" "}
            <span style={{ fontSize: "0.65rem", fontWeight: "normal",
              color: marketData?.creditSpreadSource === "FRED" ? "#10b981"
                   : marketData?.creditSpreadSource === "YAHOO_PROXY" ? "#f59e0b"
                   : "#ef4444" }}>
              {marketData?.creditSpreadSource === "FRED" ? "● FRED auto"
               : marketData?.creditSpreadSource === "YAHOO_PROXY" ? "● Yahoo proxy (HYG-LQD)"
               : "● manual"}
            </span>
          </label>
          <input type="number" value={creditSpread} onChange={(e) => setCreditSpread(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>VIX {" "}<span style={{ fontSize: "0.65rem", color: "#10b981", fontWeight: "normal" }}>● Yahoo auto</span></label>
          <input type="number" value={vix} onChange={(e) => setVix(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>RSI S&P 500{" "}
            <span style={{ fontSize: "0.65rem",
              color: marketData?.sp500Rsi && marketData.sp500Rsi !== 50 ? "#10b981" : "#ef4444",
              fontWeight: "normal" }}>
              {marketData?.sp500Rsi && marketData.sp500Rsi !== 50
                ? "● Yahoo auto (^GSPC Wilder EMA)"
                : "● manual — TradingView: SPX · D · RSI(14)"}
            </span>
          </label>
          <input type="number" value={rsi} onChange={(e) => setRsi(Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
        </div>
        <div>
          <label style={styles.label}>Momentum S&P 500{" "}
            <span style={{ fontSize: "0.65rem",
              color: marketData?.sp500Momentum12m !== undefined ? "#10b981" : "#ef4444",
              fontWeight: "normal" }}>
              {marketData?.sp500Momentum12m !== undefined
                ? "● Yahoo auto (12m-1m Jegadeesh-Titman)"
                : "● manual"}
            </span>
          </label>
          <input type="number" value={momentum} onChange={(e) => setMomentum(Number(e.target.value))} style={styles.smallInput} step="0.0001" min="-1" max="1" />
        </div>
        <div>
          <label style={styles.label}>Liquidez Global % <span style={{ fontSize: "0.65rem", color: "#10b981", fontWeight: "normal" }}>● FRED auto (Fed+ECB)</span></label>
          <input type="number" value={liquidityGrowth} onChange={(e) => setLiquidityGrowth(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>DXY (Dólar){" "}
            <span style={{ fontSize: "0.65rem", color: marketData?.dxy ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {marketData?.dxy ? "● Yahoo auto (DX-Y.NYB)" : "● manual"}
            </span>
          </label>
          <input type="number" value={dxy} onChange={(e) => setDxy(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>MOVE Index{" "}
            <span style={{ fontSize: "0.65rem", color: marketData?.moveSource === "YAHOO" ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {marketData?.moveSource === "YAHOO" ? "● Yahoo auto (^MOVE)" : "● manual"}
            </span>
          </label>
          <input type="number" value={moveIndex} onChange={(e) => setMoveIndex(Number(e.target.value))} style={styles.smallInput} step="1" />
        </div>
        <div>
          <label style={styles.label}>
            Brent Crude Oil $/barril{" "}
            <span style={{ fontSize: "0.65rem", color: marketData?.wtiSource === "YAHOO" ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {marketData?.wtiSource === "YAHOO" ? "● Yahoo auto (BZ=F)" : "● manual"}
            </span>
          </label>
          <input type="number" value={wtiOil} onChange={(e) => setWtiOil(Math.max(0, Number(e.target.value)))} style={{
            ...styles.smallInput,
            borderColor: wtiOil >= 115 ? "#ef4444" : wtiOil >= 95 ? "#f59e0b" : wtiOil >= 75 ? "#fcd34d" : "#374151",
            boxShadow: wtiOil >= 115 ? "0 0 0 2px #ef444444" : "none",
          }} step="0.5" min="0" />
          <p style={{ fontSize: "0.65rem", margin: "0.2rem 0 0", color: wtiOil >= 115 ? "#ef4444" : wtiOil >= 95 ? "#f59e0b" : "#6b7280" }}>
            {wtiOil >= 115 ? "🔴 CRISIS ENERGÉTICA — penalización ×0.50 al motor"
             : wtiOil >= 95  ? "🟠 SHOCK GEOPOLÍTICO — penalización ×0.70 al motor"
             : wtiOil >= 75  ? "🟡 Tensión elevada — penalización ×0.85 al motor"
             : "🟢 Normal — sin penalización por petróleo"}
          </p>
          <p style={{ fontSize: "0.6rem", color: "#4b5563", margin: "0.15rem 0 0" }}>
            {"<$75 normal · $75–95 tensión · $95–115 shock · >$115 crisis · Fuente: oilprice.com o TradingView UKOIL"}
          </p>
        </div>
        <div>
          <label style={styles.label}>Volatilidad BTC{" "}
            <span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● auto blend (PASO 3)</span>
          </label>
          <input type="number" value={btcVol} onChange={(e) => setBtcVol(Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="2" />
          <label style={styles.label}>BTC Dominance %{" "}
            <span style={{ fontSize: "0.65rem", color: onChainSource === "GLASSNODE" || fearGreedIndex ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {fearGreedIndex?.source === "CoinGecko" ? "● CoinGecko auto (PASO 3)" : "● manual — TradingView: BTC.D"}
            </span>
          </label>
          <input type="number" value={btcDominance} onChange={(e) => setBtcDominance(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" max="100" />
          <label style={styles.label}>MVRV Ratio{" "}
            <span style={{ fontSize: "0.65rem", color: onChainSource === "GLASSNODE" ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {onChainSource === "GLASSNODE" ? "● Glassnode auto (PASO 4)" : "● manual — lookintobitcoin.com"}
            </span>
          </label>
          <input type="number" value={mvrvRatio} onChange={(e) => setMvrvRatio(Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="10" />
          <label style={styles.label}>BTC RSI Semanal{" "}
            <span style={{ fontSize: "0.65rem",
              color: marketData?.btcRsiWeekly && marketData.btcRsiWeekly !== 50 ? "#10b981" : "#6b7280",
              fontWeight: "normal" }}>
              {marketData?.btcRsiWeekly && marketData.btcRsiWeekly !== 50
                ? "● Yahoo auto (BTC-EUR semanal Wilder)"
                : "● manual — TradingView BTCEUR · W · RSI(14)"}
            </span>
          </label>
          <input type="number" placeholder="—" value={btcRsiWeekly ?? ""} onChange={e => setBtcRsiWeekly(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
          <label style={styles.label}>BTC.D mes anterior %{" "}
            <span style={{ fontSize: "0.6rem", color: "#6b7280", marginLeft: "4px" }}>para detectar caída desde &gt;58%</span>
          </label>
          <input type="number" placeholder="—" value={prevBtcDominance ?? ""} onChange={e => setPrevBtcDominance(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" max="100" />
        </div>

        {/* ── SEÑALES DE TECHO DE CICLO — inputs por activo ── */}
        <div style={{ gridColumn: "1 / -1", borderTop: "1px solid #374151", paddingTop: "0.75rem", marginTop: "0.25rem" }}>
          <p style={{ color: "#f59e0b", fontSize: "0.78rem", fontWeight: "bold", marginBottom: "0.5rem" }}>
            ⚠️ Señales de Techo de Ciclo — activar ventas parciales automáticas
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
            <div>
              <label style={styles.label}>Uranio Spot $/lb {" "}
                <span style={{ fontSize: "0.6rem", color: "#6b7280" }}>uxc.com</span>
              </label>
              <input type="number" placeholder="—" value={uraniumSpot ?? ""} onChange={e => setUraniumSpot(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" />
            </div>
            <div>
              <label style={styles.label}>Uranio LT $/lb {" "}
                <span style={{ fontSize: "0.6rem", color: "#6b7280" }}>precio largo plazo</span>
              </label>
              <input type="number" placeholder="—" value={uraniumLT ?? ""} onChange={e => setUraniumLT(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" />
            </div>
            <div>
              <label style={styles.label}>Semis Book-to-Bill {" "}
                <span style={{ fontSize: "0.6rem", color: "#6b7280" }}>semi.org mensual</span>
              </label>
              <input type="number" placeholder="—" value={bookToBill ?? ""} onChange={e => setBookToBill(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="3" />
            </div>
            <div>
              <label style={styles.label}>Breakeven Inflación 5y %{" "}
                <span style={{ fontSize: "0.65rem",
                  color: marketData?.inflationBESource === "FRED" ? "#10b981" : "#6b7280",
                  fontWeight: "normal" }}>
                  {marketData?.inflationBESource === "FRED"
                    ? "● FRED auto (T5YIFR)"
                    : "TradingView: T5YIE"}
                </span>
              </label>
              <input type="number" placeholder="—" value={inflationBreakeven ?? ""} onChange={e => setInflationBreakeven(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" max="10" />
            </div>
          </div>
        </div>

        {/* AUDIT-FIX-01: separación jumpIntensity BTC vs portfolio */}
        <div style={{ gridColumn: "1 / -1", borderTop: "1px solid #1f2937", paddingTop: "0.75rem", marginTop: "0.25rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#f59e0b", marginBottom: "0.5rem", fontWeight: "bold" }}>
            ⚡ Parámetros Jump Diffusion — Monte Carlo
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.75rem" }}>
            <div>
              <label style={styles.label}>
                λ BTC (jumps/año)
                <span style={{ fontSize: "0.6rem", color: "#ef4444", display: "block" }}>● solo activo BTC</span>
              </label>
              <input type="number" value={jumpIntensity}
                onChange={(e) => setJumpIntensity(Math.max(0, Math.min(15, Number(e.target.value))))}
                style={{ ...styles.smallInput, borderColor: jumpIntensity > 10 ? "#ef4444" : "#374151" }}
                step="0.5" min="0" max="15" />
              <p style={{ fontSize: "0.6rem", color: "#6b7280", margin: "0.15rem 0 0" }}>Típico: 5–8/año</p>
            </div>
            <div>
              <label style={styles.label}>
                λ Portfolio (jumps/año)
                <span style={{ fontSize: "0.6rem", color: "#ef4444", display: "block" }}>● modo univariante</span>
              </label>
              <input type="number" value={jumpIntensityPortfolio}
                onChange={(e) => setJumpIntensityPortfolio(Math.max(0, Math.min(5, Number(e.target.value))))}
                style={{ ...styles.smallInput, borderColor: jumpIntensityPortfolio > 3 ? "#f59e0b" : "#374151" }}
                step="0.1" min="0" max="5" />
              <p style={{ fontSize: "0.6rem", color: "#6b7280", margin: "0.15rem 0 0" }}>
                Típico: 0.5–1.5/año{jumpIntensityPortfolio > 3 && <span style={{ color: "#f59e0b" }}> ⚠️ alto</span>}
              </p>
            </div>
            <div>
              <label style={styles.label}>
                Jump Mean (log-ret)
                <span style={{ fontSize: "0.6rem", color: jumpMean > 0 ? "#ef4444" : "#6b7280", display: "block" }}>
                  {jumpMean > 0 ? "⚠️ positivo = infla MC" : "● negativo = crashes"}
                </span>
              </label>
              <input type="number" value={jumpMean}
                onChange={(e) => setJumpMean(Number(e.target.value))}
                style={{ ...styles.smallInput, borderColor: jumpMean > 0 ? "#ef4444" : "#374151" }}
                step="0.01" />
              <p style={{ fontSize: "0.6rem", color: jumpMean > 0 ? "#ef4444" : "#6b7280", margin: "0.15rem 0 0" }}>
                {jumpMean > 0 ? "PELIGRO: jumps positivos inflan rentabilidad" : "Típico: −0.05 a −0.15"}
              </p>
            </div>
            <div>
              <label style={styles.label}>Jump Std</label>
              <input type="number" value={jumpStd}
                onChange={(e) => setJumpStd(Math.max(0.01, Number(e.target.value)))}
                style={styles.smallInput} step="0.01" min="0.01" />
              <p style={{ fontSize: "0.6rem", color: "#6b7280", margin: "0.15rem 0 0" }}>Típico: 0.08–0.15</p>
            </div>
          </div>
          {jumpMean > 0 && (
            <div style={{ marginTop: "0.5rem", background: "#1c0a0a", border: "1px solid #ef4444", borderRadius: 6, padding: "0.4rem 0.75rem", fontSize: "0.72rem", color: "#ef4444" }}>
              ⚠️ <strong>AUDIT-WARN:</strong> jumpMean positivo ({jumpMean.toFixed(4)}) añade{" "}
              +{(jumpIntensityPortfolio * jumpMean * 100).toFixed(2)}% de drift artificial/año al portfolio.
              Con λ={jumpIntensityPortfolio}: contribución anual jumps = {(jumpIntensityPortfolio * jumpMean * 100).toFixed(1)}%.
              Los saltos del mercado real son principalmente crashes (negativo). Valor recomendado: −0.08 a −0.12.
            </div>
          )}
        </div>
      </div>

      {/* AUDIT-FIX-03: Validación cruzada de inputs manuales */}
      {/* Detecta inconsistencias entre variables macro introducidas manualmente */}
      {(() => {
        const warnings: { label: string; detail: string; severity: "high" | "medium" }[] = [];

        // DXY alto + Brent alto = señales opuestas (dólar fuerte suele bajar commodities en USD)
        if (dxy > 103 && wtiOil > 90) {
          warnings.push({
            label: "DXY vs Brent inconsistentes",
            detail: `DXY ${dxy.toFixed(1)} (dólar fuerte) + Brent $${wtiOil.toFixed(0)} (petróleo caro) son señales opuestas. El dólar fuerte históricamente deprime el precio del petróleo en USD. Verifica las fuentes.`,
            severity: "medium",
          });
        }

        // VIX alto + RSI alto = incoherente (pánico no coexiste con sobrecompra)
        if (vix > 28 && rsi > 65) {
          warnings.push({
            label: "VIX vs RSI incoherentes",
            detail: `VIX ${vix.toFixed(1)} (pánico/miedo) + RSI S&P ${rsi.toFixed(0)} (sobrecompra) son mutuamente excluyentes. Un VIX >28 indica capitulación, incompatible con RSI >65. Revisa uno de los dos valores.`,
            severity: "high",
          });
        }

        // Credit spread alto + PER alto = valoración cara en entorno de riesgo (warn, no error)
        if (creditSpread > 4.5 && manualPER > 26) {
          warnings.push({
            label: "Credit Spread vs PER: riesgo ignorado",
            detail: `Credit Spread ${creditSpread.toFixed(2)}% (estrés HY) + PER ${manualPER.toFixed(1)}x (valoración cara). Los spreads altos históricamente comprimen múltiplos. El motor ya penaliza esto, pero verifica que el PER es actual.`,
            severity: "medium",
          });
        }

        // jumpMean positivo con intensidad alta: ya se advierte en el bloque de jump
        // M2 crecimiento negativo + liquidez alta = inconsistente
        if (m2Growth < 0 && liquidityGrowth > 5) {
          warnings.push({
            label: "M2 negativo vs Liquidez Global positiva",
            detail: `M2 Growth ${m2Growth.toFixed(1)}% (contracción monetaria) + Liquidez Global ${liquidityGrowth.toFixed(1)}% (expansión). Verifica si la liquidez global incluye bancos centrales fuera de Fed (BCE, BoJ, PBoC).`,
            severity: "medium",
          });
        }

        // DXY > 108 con EM > 10% alloc: riesgo de divisa no capturado
        if (dxy > 108 && engineResult) {
          const emAlloc = engineResult.allocations.find(a => a.name?.toLowerCase().includes("emerging") || a.name?.toLowerCase().includes("em"))?.finalAllocation ?? 0;
          if (emAlloc > 0.08) {
            warnings.push({
              label: `DXY >108 con EM allocation ${(emAlloc * 100).toFixed(0)}%`,
              detail: `Dólar muy fuerte (DXY ${dxy.toFixed(1)}) + exposición Emergentes ${(emAlloc * 100).toFixed(0)}% = riesgo de divisa significativo no capturado en el modelo. EM ex-China tiene deuda en USD — el dólar fuerte deteriora sus fundamentales.`,
              severity: "medium",
            });
          }
        }

        if (warnings.length === 0) return null;

        return (
          <div style={{ ...styles.card, border: "1px solid #f59e0b", background: "#111007", marginBottom: "1rem" }}>
            <h3 style={{ color: "#f59e0b", marginBottom: "0.75rem", fontSize: "0.9rem" }}>
              ⚠️ Validación Cruzada de Inputs Manuales — {warnings.length} inconsistencia{warnings.length > 1 ? "s" : ""} detectada{warnings.length > 1 ? "s" : ""}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {warnings.map((w, i) => (
                <div key={i} style={{
                  display: "flex", gap: "0.75rem", alignItems: "flex-start",
                  background: w.severity === "high" ? "#1c0a0a" : "#111827",
                  border: `1px solid ${w.severity === "high" ? "#ef4444" : "#374151"}`,
                  borderRadius: 6, padding: "0.5rem 0.75rem",
                }}>
                  <span style={{ color: w.severity === "high" ? "#ef4444" : "#f59e0b", fontWeight: "bold", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    {w.severity === "high" ? "🔴" : "🟡"} {w.label}
                  </span>
                  <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{w.detail}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* BTC CYCLE INPUTS — Elliott + Puell + Hash Ribbon + Pi Cycle */}
      <div style={{ ...styles.card, border: "1px solid #1d4ed8", background: "linear-gradient(135deg, #0c1228 0%, #111827 100%)" }}>
        <h3 style={{ color: "#60a5fa", marginBottom: "0.75rem" }}>🔬 BTC Cycle Analyzer — Inputs Avanzados</h3>
        <p style={{ color: "#6b7280", fontSize: "0.75rem", marginBottom: "1rem" }}>
          Opcionales. Cada campo que rellenes mejora la precisión del análisis de ciclo. Sin datos = SAFE por defecto.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem" }}>

          {/* Puell Multiple */}
          <div>
            <label style={styles.label}>
              Puell Multiple{" "}
              <span style={{ fontSize: "0.6rem", color: "#6b7280" }}>lookintobitcoin.com</span>
            </label>
            <input type="number" placeholder="— ej: 0.8" value={puellMultiple ?? ""}
              onChange={e => setPuellMultiple(e.target.value === "" ? undefined : Number(e.target.value))}
              style={styles.smallInput} step="0.01" min="0" max="10" />
            <p style={{ fontSize: "0.65rem", color: "#6b7280", margin: "0.2rem 0 0" }}>
              {"<0.5 = mineros en pérdidas → fondo · >2 = euforia mineros → techo"}
            </p>
          </div>

          {/* Hash Ribbon State */}
          <div>
            <label style={styles.label}>Hash Ribbon{" "}
              <span style={{ fontSize: "0.6rem",
                color: onChainSource === "GLASSNODE" ? "#10b981" : "#6b7280" }}>
                {onChainSource === "GLASSNODE" ? "● Glassnode auto (MA30 vs MA60)" : "lookintobitcoin.com"}
              </span>
            </label>
            <select value={hashRibbonState ?? ""}
              onChange={e => setHashRibbonState(e.target.value === "" ? undefined : e.target.value as "CAPITULATION" | "RECOVERY" | "EXPANSION")}
              style={{ ...styles.smallInput, cursor: "pointer" }}>
              <option value="">— sin dato</option>
              <option value="CAPITULATION">CAPITULATION (MA30 &lt; MA60)</option>
              <option value="RECOVERY">RECOVERY (MA30 cruzando MA60 ↑)</option>
              <option value="EXPANSION">EXPANSION (MA30 &gt; MA60)</option>
            </select>
            <p style={{ fontSize: "0.65rem", color: "#6b7280", margin: "0.2rem 0 0" }}>
              RECOVERY = señal histórica de compra · CAPITULATION = mineros apagando
            </p>
          </div>

          {/* Pi Cycle */}
          <div>
            <label style={styles.label}>Pi Cycle — 111 DMA{" "}
              <span style={{ fontSize: "0.65rem",
                color: marketData?.piCycleMa111 ? "#10b981" : "#6b7280",
                fontWeight: "normal" }}>
                {marketData?.piCycleMa111 ? "● Yahoo auto (BTC-EUR historial)" : "TradingView: overlay"}
              </span>
            </label>
            <input type="number" placeholder="— ej: 55000" value={piCycleMa111 ?? ""}
              onChange={e => setPiCycleMa111(e.target.value === "" ? undefined : Number(e.target.value))}
              style={styles.smallInput} step="100" min="0" />
          </div>
          <div>
            <label style={styles.label}>Pi Cycle — 350 DMA × 2{" "}
              <span style={{ fontSize: "0.65rem",
                color: marketData?.piCycleMa350x2 ? "#10b981" : "#6b7280",
                fontWeight: "normal" }}>
                {marketData?.piCycleMa350x2 ? "● auto" : ""}
              </span>
            </label>
            <input type="number" placeholder="— ej: 120000" value={piCycleMa350x2 ?? ""}
              onChange={e => setPiCycleMa350x2(e.target.value === "" ? undefined : Number(e.target.value))}
              style={styles.smallInput} step="100" min="0" />
            <p style={{ fontSize: "0.65rem", color: "#6b7280", margin: "0.2rem 0 0" }}>
              Cuando 111DMA cruza 350DMA×2 → techo histórico de ciclo. Ahora separados = sin señal.
            </p>
          </div>

          {/* Elliott Wave Pivots */}
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={styles.label}>
              Elliott Wave — Pivotes del ciclo{" "}
              <span style={{ fontSize: "0.6rem", color: "#6b7280" }}>mínimo 2 puntos: PRECIO:TIPO separados por coma</span>
            </label>
            <input
              type="text"
              placeholder="ej: 15500:LOW, 73800:HIGH, 49000:LOW"
              value={elliottPivotsText}
              onChange={e => {
                setElliottPivotsText(e.target.value);
                try {
                  const parts = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                  const parsed: ElliottWavePoint[] = parts.map((p, i) => {
                    const [priceStr, typeStr] = p.split(":");
                    const price = parseFloat(priceStr);
                    const lbl = typeStr?.trim().toUpperCase() === "HIGH" ? "HIGH" : "LOW";
                    const d = new Date("2022-11-21");
                    d.setMonth(d.getMonth() + i * 6);
                    return { price, date: d, label: lbl };
                  });
                  if (parsed.length >= 2 && parsed.every(p => !isNaN(p.price))) {
                    setElliottPivots(parsed);
                  }
                } catch { /* parsing in progress */ }
              }}
              style={{ ...styles.smallInput, width: "100%", fontFamily: "monospace" }}
            />
            <p style={{ fontSize: "0.65rem", color: "#6b7280", margin: "0.3rem 0 0" }}>
              Formato: <code style={{ color: "#818cf8" }}>PRECIO:LOW</code> o <code style={{ color: "#818cf8" }}>PRECIO:HIGH</code> · Ciclo actual: desde el suelo de Nov 2022 (~€15.5k) · Alternando LOW/HIGH/LOW/HIGH
            </p>
            {elliottPivots.length >= 2 && (
              <p style={{ fontSize: "0.65rem", color: "#10b981", margin: "0.2rem 0 0" }}>
                ✓ {elliottPivots.length} pivotes cargados · Onda detectada automáticamente
              </p>
            )}
          </div>

          {/* Override manual de onda */}
          <div>
            <label style={styles.label}>Override onda actual (opcional)</label>
            <select value={elliottCurrentWave ?? ""}
              onChange={e => setElliottCurrentWave(e.target.value === "" ? undefined : e.target.value as ElliottWaveLabel)}
              style={{ ...styles.smallInput, cursor: "pointer" }}>
              <option value="">— automático</option>
              {(["1","2","3","4","5","A","B","C","UNKNOWN"] as ElliottWaveLabel[]).map(w => (
                <option key={w} value={w}>Onda {w}</option>
              ))}
            </select>
            <p style={{ fontSize: "0.65rem", color: "#6b7280", margin: "0.2rem 0 0" }}>
              Solo si el motor algorítmico falla — confirma tú mismo el conteo visual
            </p>
          </div>
        </div>
      </div>
      <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "1rem" }}>
        <div>
          <h4>Liquidez Global</h4>
          <p>Régimen: <strong>{liquidityOutput.regime}</strong></p>
          <p>Crec: {liquidityGrowth}%</p>
          <p>DXY Trend: {(liquidityOutput.dxyTrend * 100).toFixed(1)}%</p>
          <p style={{ fontSize: "0.75rem", color: "#f59e0b" }}>Fuente: manual + DXY Yahoo</p>
        </div>
        <div>
          <h4>Régimen Global</h4>
          {engineResult ? (
            <>
              <p>Motor: <strong style={{ color: engineResult.regime === "CRISIS" ? "#ef4444" : engineResult.regime === "CONTRACTION" ? "#f59e0b" : "#10b981" }}>{engineResult.regime}</strong></p>
              <p>Crisis prob: {engineResult.masterRegime.crisisDetail.crisisProbability.toFixed(1)}%</p>
              <p>Stress score: {engineResult.masterRegime.stressDetail.score} / {engineResult.masterRegime.stressDetail.regime}</p>
              {engineResult.masterRegime.stressDetail.wtiShock !== "NONE" && (
                <p style={{ color: engineResult.masterRegime.stressDetail.wtiShock === "CRISIS" ? "#ef4444" : engineResult.masterRegime.stressDetail.wtiShock === "SHOCK" ? "#f59e0b" : "#fcd34d", fontSize: "0.78rem", fontWeight: "bold" }}>
                  🛢 WTI {engineResult.masterRegime.stressDetail.wtiShock} — ×{engineResult.masterRegime.stressDetail.wtiPenalty.toFixed(2)} penalización extra
                </p>
              )}
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
          <p style={{ fontSize: "0.75rem", color: mvrvRatio < 1.0 ? "#ef4444" : mvrvRatio < 1.5 ? "#f59e0b" : mvrvRatio > 3.5 ? "#ef4444" : "#10b981" }}>
            MVRV: {mvrvRatio.toFixed(2)} {mvrvRatio < 1.0 ? "🔴 fondo histórico" : mvrvRatio < 1.5 ? "🟡 acumulación" : mvrvRatio > 3.5 ? "🔴 burbuja" : "🟢 neutral"}
            {" · "}BTC.D: {btcDominance.toFixed(1)}% {btcDominance > 54 ? "↑ acumulación" : btcDominance > 52 ? "→ neutral-alto" : "↓ altseason"}
          </p>
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

      {/* ── PASO 6: Motor Intelligence AI ──────────────────────────────────── */}
      {aiIntelligence && (
        <div style={{ ...styles.card, border: "1px solid #4c1d95", background: "linear-gradient(135deg, #0c0a1f 0%, #111827 100%)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ color: "#a78bfa", margin: 0 }}>🧠 Motor Intelligence — Análisis AI</h2>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {aiIntelligence.cacheHit && (
                <span style={{ fontSize: "0.65rem", color: "#6b7280", background: "#1f2937", padding: "2px 8px", borderRadius: 4 }}>caché</span>
              )}
              <span style={{ fontSize: "0.65rem", color: "#6b7280" }}>
                {new Date(aiIntelligence.fetchedAt).toLocaleString("es-ES")}
              </span>
              <button onClick={refreshAIIntelligence} disabled={aiLoading}
                style={{ ...styles.button, fontSize: "0.7rem", padding: "4px 10px", background: "#312e81" }}>
                {aiLoading ? "..." : "↻ Actualizar"}
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1rem" }}>

            {/* GEMINI — Narrativa macro */}
            {aiIntelligence.gemini && !aiIntelligence.gemini.error && (
              <div style={{ background: "#0c1228", border: "1px solid #1d4ed8", borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <span style={{ fontSize: "1rem" }}>✦</span>
                  <span style={{ color: "#60a5fa", fontWeight: "bold", fontSize: "0.85rem" }}>
                    Gemini Flash — Análisis Macro
                  </span>
                  <span style={{ fontSize: "0.6rem", color: "#374151", marginLeft: "auto" }}>{aiIntelligence.gemini.model}</span>
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#3b82f6", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Régimen actual</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#e5e7eb", lineHeight: 1.6 }}>{aiIntelligence.gemini.regimeNarrative}</p>
                </div>
                <div style={{ marginBottom: "0.75rem", borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#3b82f6", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Validación macro</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.gemini.macroValidation}</p>
                </div>
                <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#3b82f6", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ciclo BTC</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.gemini.btcCycleSummary}</p>
                </div>
              </div>
            )}
            {aiIntelligence.gemini?.error && (
              <div style={{ background: "#1c0a0a", border: "1px solid #374151", borderRadius: 10, padding: "1rem" }}>
                <span style={{ color: "#4b5563", fontSize: "0.8rem" }}>✦ Gemini — configura GEMINI_API_KEY</span>
                <p style={{ color: "#6b7280", fontSize: "0.75rem", marginTop: "0.5rem" }}>
                  Google AI Studio → gratuito 1500 req/día → añadir como Supabase Secret
                </p>
              </div>
            )}
            {!aiIntelligence.gemini && (
              <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 10, padding: "1rem", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: "#4b5563", fontSize: "0.8rem" }}>✦ Gemini — sin GEMINI_API_KEY</span>
              </div>
            )}

            {/* GROK — Sentiment X */}
            {aiIntelligence.grok && !aiIntelligence.grok.error && (
              <div style={{ background: "#0a0a0a", border: `1px solid ${aiIntelligence.grok.blackSwanAlert ? "#ef4444" : "#374151"}`, borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <span style={{ fontSize: "1rem" }}>✕</span>
                  <span style={{ color: "#d1d5db", fontWeight: "bold", fontSize: "0.85rem" }}>Grok — Sentiment X/Twitter</span>
                  <span style={{ fontSize: "0.6rem", color: "#374151", marginLeft: "auto" }}>{aiIntelligence.grok.model}</span>
                </div>
                {aiIntelligence.grok.blackSwanAlert && (
                  <div style={{ background: "#1c0a0a", border: "1px solid #ef4444", borderRadius: 6, padding: "0.5rem 0.75rem", marginBottom: "0.75rem", fontSize: "0.78rem", color: "#ef4444" }}>
                    ⚠️ <strong>ALERTA CISNE NEGRO:</strong> {aiIntelligence.grok.blackSwanReason}
                  </div>
                )}
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#9ca3af", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Sentiment actual</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#e5e7eb", lineHeight: 1.6 }}>{aiIntelligence.grok.marketSentiment}</p>
                </div>
                <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#9ca3af", fontWeight: "bold", marginBottom: "0.5rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Narrativas dominantes</div>
                  {aiIntelligence.grok.topNarratives.map((n, i) => (
                    <div key={i} style={{ fontSize: "0.78rem", color: "#d1d5db", marginBottom: "0.3rem", display: "flex", gap: "0.5rem" }}>
                      <span style={{ color: "#6b7280", minWidth: "1rem" }}>{i + 1}.</span>
                      <span>{n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(!aiIntelligence.grok || aiIntelligence.grok.error) && (
              <div style={{ background: "#0a0a0a", border: "1px solid #1f2937", borderRadius: 10, padding: "1rem", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <span style={{ color: "#4b5563", fontSize: "0.8rem" }}>✕ Grok — sin GROK_API_KEY</span>
                <p style={{ color: "#374151", fontSize: "0.72rem", marginTop: "0.5rem" }}>console.x.ai → beta gratuita o $25/mes</p>
              </div>
            )}

            {/* CLAUDE — Análisis profundo */}
            {aiIntelligence.claude && !aiIntelligence.claude.error && (
              <div style={{ background: "#0d1117", border: "1px solid #d97706", borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <span style={{ fontSize: "1rem" }}>◆</span>
                  <span style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "0.85rem" }}>Claude Sonnet — Análisis Profundo</span>
                  <span style={{ fontSize: "0.6rem", color: "#374151", marginLeft: "auto" }}>{aiIntelligence.claude.model}</span>
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#d97706", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Elliott Wave</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#e5e7eb", lineHeight: 1.6 }}>{aiIntelligence.claude.elliottAnalysis}</p>
                </div>
                <div style={{ marginBottom: "0.75rem", borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#d97706", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Rebalanceo recomendado</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.claude.rebalanceAdvice}</p>
                </div>
                <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#d97706", fontWeight: "bold", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Señales contradictorias</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.claude.contradictionAnalysis}</p>
                </div>
              </div>
            )}
            {(!aiIntelligence.claude || aiIntelligence.claude.error) && (
              <div style={{ background: "#0d1117", border: "1px solid #1f2937", borderRadius: 10, padding: "1rem", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <span style={{ color: "#4b5563", fontSize: "0.8rem" }}>◆ Claude — sin ANTHROPIC_API_KEY</span>
                <p style={{ color: "#374151", fontSize: "0.72rem", marginTop: "0.5rem" }}>console.anthropic.com → pay-per-use (~$0.003/análisis)</p>
              </div>
            )}
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
        {/* Parámetro de años */}
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="years" style={styles.label}>Años de simulación:</label>
          <input id="years" name="years" type="number" value={years} onChange={(e) => setYears(Number(e.target.value))} style={styles.smallInput} min="1" max="50" step="1" />
        </div>

        {/* AUDIT-FIX-01: banner de fuente de mu honesto — muestra fuente real y caps aplicados */}
        <div style={{ background: "#0c1228", border: "1px solid #3b82f6", borderRadius: 6, padding: "0.6rem 1rem", marginBottom: "1rem", fontSize: "0.78rem" }}>
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <span style={{ color: "#60a5fa", fontWeight: "bold" }}>μ efectivo: </span>
              <span style={{ color: "#e5e7eb", fontWeight: "bold", fontSize: "1rem" }}>
                {(Math.min(0.15, expectedReturn) * 100).toFixed(2)}%
              </span>
              <span style={{ color: "#6b7280" }}> anual</span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Fuente: </span>
              <span style={{ color: marketData?.expectedReturns?.length ? "#10b981" : "#f59e0b", fontWeight: "bold" }}>
                {marketData?.expectedReturns?.length
                  ? "✅ James-Stein (Yahoo + shrinkage φ=0.65)"
                  : "⚠️ Hardcoded portfolio.ts (sin datos Yahoo)"}
              </span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Régimen: </span>
              <span style={{ color: "#f59e0b" }}>
                {engineResult?.regime ?? "—"} ×{(engineResult?.masterRegime.regimePenalty ?? 1).toFixed(3)}
              </span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Cap: </span>
              <span style={{ color: expectedReturn > 0.15 ? "#ef4444" : "#6b7280" }}>
                {expectedReturn > 0.15
                  ? `⚠️ aplicado (bruto ${(expectedReturn * 100).toFixed(1)}% → cap 15%)`
                  : "15% (no activo)"}
              </span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Modo: </span>
              <span style={{ color: marketData?.covMatrix?.length ? "#10b981" : "#f59e0b" }}>
                {marketData?.covMatrix?.length ? "Multivariante Cholesky" : "Univariante (λ_p=" + jumpIntensityPortfolio.toFixed(1) + "/año)"}
              </span>
            </div>
          </div>
          <div style={{ marginTop: "0.3rem", color: "#4b5563", fontSize: "0.7rem" }}>
            Priors LP (Damodaran 2024): BTC 15% · Semis 14% · MSCI Mom 11% · Uranio 10% · EM 8% · Gold 6% · REITs 9% — shrinkage 65% hacia prior, 35% histórico Yahoo.
            Estos son retornos esperados a largo plazo; el resultado real depende del ciclo.
          </div>
        </div>

        {/* KPIs del Monte Carlo */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          {/* Mediana — el número más honesto */}
          <div style={{ background: "#0f172a", border: "2px solid #6366f1", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#818cf8", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.2rem" }}>MEDIANA (resultado más probable)</div>
            <div style={{ color: "#e5e7eb", fontSize: "1.3rem", fontWeight: "bold" }}>{formatCurrency(medianValue)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>50% de simulaciones por encima</div>
          </div>

          {/* Rango intercuartil */}
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>RANGO CENTRAL (P25–P75)</div>
            <div style={{ color: "#10b981", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p25)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>— a —</div>
            <div style={{ color: "#10b981", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p75)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>50% central de los escenarios</div>
          </div>

          {/* Media */}
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>MEDIA (sesgada al alza)</div>
            <div style={{ color: "#d1d5db", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(meanValue)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>Media &gt; mediana en log-normal</div>
          </div>

          {/* Peor 5% */}
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>PEOR 5% (cola bajista)</div>
            <div style={{ color: "#ef4444", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(worst5)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>VaR 95% — 1 de cada 20 escenarios</div>
          </div>

          {/* Mejor 95% */}
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>MEJOR 5% (cola alcista)</div>
            <div style={{ color: "#f59e0b", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(best95)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>Escenario optimista</div>
          </div>

          {/* Probabilidad de objetivo */}
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>PROB. OBJETIVO</div>
            <div style={{ color: probability >= 50 ? "#10b981" : probability >= 25 ? "#f59e0b" : "#ef4444", fontSize: "1.3rem", fontWeight: "bold" }}>{probability.toFixed(1)}%</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>Alcanzar {formatCurrency(target)}</div>
          </div>
        </div>

        {/* Capital total invertido vs mediana */}
        <div style={{ background: "#111827", borderRadius: 6, padding: "0.5rem 1rem", marginBottom: "1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
          Capital total invertido en {years} años:{" "}
          <strong style={{ color: "#d1d5db" }}>{formatCurrency(totalPortfolioValue + monthlyInjection * years * 12)}</strong>
          {" · "}Multiplicador mediana:{" "}
          <strong style={{ color: "#6366f1" }}>{(medianValue / (totalPortfolioValue + monthlyInjection * years * 12)).toFixed(1)}x</strong>
          {" · "}Sigma efectiva:{" "}
          <strong>{(portfolioVol * 100).toFixed(1)}%</strong>
        </div>

        {/* CVaR corregido (BUG-07 fix) */}
        <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {cvarResult && (
            <div style={{ borderLeft: "2px solid #f59e0b", paddingLeft: "0.75rem", marginBottom: "0.75rem" }}>
              <p style={{ margin: 0 }}>
                <strong>CVaR 95% — valor esperado peor 5%:</strong>{" "}
                <span style={{ color: "#f59e0b" }}>
                  {formatCurrency(cvarResult.cvar95Abs)}
                </span>
              </p>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#9ca3af" }}>
                Pérdida esperada vs capital invertido: {" "}
                <span style={{ color: cvarResult.loss95 > 0 ? "#ef4444" : "#10b981" }}>
                  {cvarResult.loss95 > 0 ? "−" : "+"}{formatCurrency(Math.abs(cvarResult.loss95))}
                </span>
                {" · "}Capital total invertido: {formatCurrency(cvarResult.totalInvested)}
                {" · "}Tail ratio: {cvarResult.tailRatio.toFixed(2)}x
                {cvarResult.tailRatio < 0.9 ? " ⚠️ cola pesada" : " ✓ distribución normal"}
              </p>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#ef4444" }}>
                CVaR 99%: {formatCurrency(cvarResult.cvar99Abs)}
                {" · "}Estándar Basel III/IV
              </p>
            </div>
          )}
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

      {/* CEWS — Crisis Early Warning System */}
      <div style={{
        ...styles.card,
        border: cewsResult.level === "ALERT" ? "2px solid #ef4444"
              : cewsResult.level === "WARNING" ? "2px solid #f59e0b"
              : cewsResult.level === "WATCH" ? "2px solid #3b82f6"
              : "1px solid #374151",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ margin: 0 }}>
            {cewsResult.level === "ALERT" ? "🚨" : cewsResult.level === "WARNING" ? "⚠️" : cewsResult.level === "WATCH" ? "👁" : "✅"}
            {" "}Crisis Early Warning System
          </h2>
          <div style={{
            padding: "0.35rem 0.9rem", borderRadius: 20, fontWeight: "bold", fontSize: "0.85rem",
            backgroundColor: cewsResult.level === "ALERT" ? "#7f1d1d"
              : cewsResult.level === "WARNING" ? "#78350f"
              : cewsResult.level === "WATCH" ? "#1e3a5f"
              : "#065f46",
            color: "#fff",
          }}>
            {cewsResult.level} · Score {cewsResult.score}/12
          </div>
        </div>

        {/* Señal de alerta temprana */}
        {cewsResult.earlyWarningActive && (
          <div style={{ backgroundColor: "#7f1d1d", border: "1px solid #ef4444", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem" }}>
            <p style={{ fontWeight: "bold", color: "#fca5a5", marginBottom: "0.25rem" }}>🚨 ALERTA TEMPRANA ACTIVA</p>
            <p style={{ color: "#fecaca", fontSize: "0.85rem" }}>{cewsResult.earlyWarningReason}</p>
          </div>
        )}

        {/* 4 señales */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          {Object.values(cewsResult.signals).map(signal => (
            <div key={signal.name} style={{
              backgroundColor: signal.level === "ALERT" ? "#450a0a"
                : signal.level === "WARNING" ? "#422006"
                : signal.level === "WATCH" ? "#172554"
                : "#111827",
              border: `1px solid ${signal.level === "ALERT" ? "#ef4444" : signal.level === "WARNING" ? "#f59e0b" : signal.level === "WATCH" ? "#3b82f6" : "#374151"}`,
              borderRadius: 8, padding: "0.75rem",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                <span style={{ fontSize: "0.75rem", color: "#9ca3af", fontWeight: "bold" }}>{signal.name}</span>
                <span style={{
                  fontSize: "0.7rem", fontWeight: "bold", padding: "0.1rem 0.4rem", borderRadius: 10,
                  backgroundColor: signal.level === "ALERT" ? "#ef4444" : signal.level === "WARNING" ? "#f59e0b" : signal.level === "WATCH" ? "#3b82f6" : "#10b981",
                  color: "#fff",
                }}>{signal.level}</span>
              </div>
              <div style={{ fontSize: "1.4rem", fontWeight: "bold", color: signal.level === "ALERT" ? "#fca5a5" : signal.level === "WARNING" ? "#fde68a" : "#e5e7eb" }}>
                {signal.value.toFixed(signal.name.includes("VIX") || signal.name.includes("Vol") ? 0 : 2)}
                {signal.name.includes("M2") || signal.name.includes("Yield") || signal.name.includes("Credit") ? "%" : ""}
              </div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "0.25rem" }}>
                {signal.trend === "DETERIORATING" ? "📉 Empeorando" : signal.trend === "IMPROVING" ? "📈 Mejorando" : "➡ Estable"}
                {" · "}Score {signal.score}/3
              </div>
            </div>
          ))}
        </div>

        {/* Recomendación */}
        <div style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.75rem 1rem", marginBottom: "0.75rem" }}>
          <p style={{ fontSize: "0.85rem", color: "#d1d5db" }}>
            <strong style={{ color: "#f9fafb" }}>Recomendación: </strong>{cewsResult.recommendation}
          </p>
        </div>

        {/* Meta info */}
        <p style={{ fontSize: "0.72rem", color: "#4b5563" }}>
          {cewsHistory.length >= 4
            ? `Basado en ${cewsHistory.length} puntos reales · ${cewsResult.weeksInWarning} semanas en zona de alerta`
            : `Datos sintéticos (${effectiveCEWSHistory.length} puntos simulados) — el sistema acumulará datos reales con el uso diario`
          }
          {cewsResult.regimePenaltyAdjustment !== 0 && (
            ` · Ajuste al régimen: ${(cewsResult.regimePenaltyAdjustment * 100).toFixed(0)}% (ya aplicado al motor)`
          )}
        </p>
      </div>

      {/* NIVEL 6: Regime Duration */}
      {regimeDuration && (
        <div style={{
          ...styles.card,
          border: regimeDuration.maturityPhase === "OLD" ? "2px solid #f59e0b" : "1px solid #374151",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <h2 style={{ margin: 0 }}>⏱ Madurez del Régimen</h2>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <span style={{
                padding: "0.3rem 0.8rem", borderRadius: 20, fontSize: "0.8rem", fontWeight: "bold",
                backgroundColor: regimeDuration.maturityPhase === "YOUNG" ? "#065f46" : regimeDuration.maturityPhase === "MATURE" ? "#1e3a5f" : "#78350f",
                color: "#fff",
              }}>{regimeDuration.maturityPhase}</span>
              <span style={{ padding: "0.3rem 0.8rem", borderRadius: 20, fontSize: "0.8rem", backgroundColor: "#1f2937", color: "#9ca3af" }}>
                {regimeDuration.monthsInRegime.toFixed(1)} meses
              </span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <div style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.6rem 0.75rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>Semanas en régimen</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "bold" }}>{regimeDuration.weeksInRegime.toFixed(0)}</div>
            </div>
            <div style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.6rem 0.75rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>Ajuste penalización</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "bold", color: regimeDuration.durationAdjustment > 0 ? "#10b981" : regimeDuration.durationAdjustment < 0 ? "#ef4444" : "#9ca3af" }}>
                {regimeDuration.durationAdjustment > 0 ? "+" : ""}{(regimeDuration.durationAdjustment * 100).toFixed(0)}%
              </div>
            </div>
            <div style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.6rem 0.75rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>Preparación ataque</div>
              <div style={{ fontSize: "1.4rem", fontWeight: "bold", color: `hsl(${regimeDuration.attackReadiness * 120}, 70%, 55%)` }}>
                {(regimeDuration.attackReadiness * 100).toFixed(0)}%
              </div>
            </div>
          </div>
          <p style={{ fontSize: "0.82rem", color: "#d1d5db", margin: 0 }}>{regimeDuration.signal}</p>
        </div>
      )}

      {/* NIVEL 6: Stress Scenarios */}
      {stressResults.length > 0 && (
        <div style={styles.card}>
          <h2>🔥 Stress Testing — Escenarios Históricos</h2>
          <p style={{ color: "#6b7280", fontSize: "0.82rem", marginBottom: "1rem" }}>
            Simulación de pérdidas con retornos históricos reales de los proxies en cada crisis
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
            {stressResults.map((s: StressResult) => (
              <div key={s.scenarioId} style={{
                backgroundColor: s.portfolioReturn < -0.30 ? "#450a0a" : s.portfolioReturn < -0.15 ? "#422006" : "#111827",
                border: `1px solid ${s.portfolioReturn < -0.30 ? "#ef4444" : s.portfolioReturn < -0.15 ? "#f59e0b" : "#374151"}`,
                borderRadius: 8, padding: "0.75rem",
              }}>
                <p style={{ fontWeight: "bold", fontSize: "0.82rem", marginBottom: "0.4rem", color: "#f9fafb" }}>{s.scenarioName}</p>
                <div style={{ fontSize: "2rem", fontWeight: "bold", color: s.portfolioReturn < -0.20 ? "#fca5a5" : s.portfolioReturn < -0.10 ? "#fde68a" : "#10b981" }}>
                  {(s.portfolioReturn * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>
                  €{Math.abs(s.portfolioDrawdown).toFixed(0)} {s.portfolioDrawdown < 0 ? "pérdida" : "ganancia"}
                  {" · "}{s.recoveryEstimateMonths}m recuperación
                </div>
                <div style={{ fontSize: "0.72rem", color: "#4b5563", marginTop: "0.25rem" }}>
                  Mejor: {s.bestAsset} · Peor: {s.worstAsset}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* NIVEL 6: Walk-Forward Robustness */}
      {walkForwardResult && (
        <div style={{
          ...styles.card,
          border: walkForwardResult.overfittingRisk === "LOW" ? "1px solid #10b981" : walkForwardResult.overfittingRisk === "HIGH" ? "2px solid #ef4444" : "1px solid #374151",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <h2 style={{ margin: 0 }}>🔬 Walk-Forward Robustness</h2>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span style={{
                fontSize: "2rem", fontWeight: "bold",
                color: walkForwardResult.robustnessGrade === "A" ? "#10b981" : walkForwardResult.robustnessGrade === "B" ? "#3b82f6" : walkForwardResult.robustnessGrade === "C" ? "#f59e0b" : "#ef4444",
              }}>{walkForwardResult.robustnessGrade}</span>
              <span style={{ padding: "0.3rem 0.8rem", borderRadius: 20, fontSize: "0.8rem", fontWeight: "bold",
                backgroundColor: walkForwardResult.overfittingRisk === "LOW" ? "#065f46" : walkForwardResult.overfittingRisk === "HIGH" ? "#7f1d1d" : "#1e3a5f",
                color: "#fff" }}>
                Overfitting: {walkForwardResult.overfittingRisk}
              </span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.5rem", marginBottom: "0.75rem" }}>
            {Object.entries(walkForwardResult.parameterStability).map(([param, score]) => (
              <div key={param} style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.6rem 0.75rem", textAlign: "center" }}>
                <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: "0.2rem" }}>
                  {param.replace(/([A-Z])/g, ' $1').trim()}
                </div>
                <div style={{ fontSize: "1.2rem", fontWeight: "bold",
                  color: (score as number) > 0.7 ? "#10b981" : (score as number) > 0.5 ? "#f59e0b" : "#ef4444" }}>
                  {((score as number) * 100).toFixed(0)}%
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.5rem", marginBottom: "0.75rem" }}>
            {walkForwardResult.windows.map((w, i) => (
              <div key={i} style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.78rem" }}>
                <div style={{ color: "#6b7280", marginBottom: "0.2rem" }}>Ventana {i + 1}</div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>IS Sharpe: <strong style={{ color: w.inSampleMetrics.sharpe > 0 ? "#10b981" : "#ef4444" }}>{w.inSampleMetrics.sharpe.toFixed(2)}</strong></span>
                  <span>OOS: <strong style={{ color: w.outOfSampleMetrics.sharpe > 0 ? "#10b981" : "#ef4444" }}>{w.outOfSampleMetrics.sharpe.toFixed(2)}</strong></span>
                </div>
                <div style={{ marginTop: "0.2rem" }}>
                  Consistencia: <strong style={{ color: w.consistencyScore > 0.7 ? "#10b981" : w.consistencyScore > 0.5 ? "#f59e0b" : "#ef4444" }}>
                    {(w.consistencyScore * 100).toFixed(0)}%
                  </strong>
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: "0.82rem", color: "#d1d5db", margin: 0 }}>{walkForwardResult.recommendation}</p>
          {/* Adaptive factor weights — mostrar solo si se están aplicando ajustes */}
          {walkForwardResult.overfittingRisk !== "LOW" && walkForwardResult.adaptiveFactorWeights && (
            <div style={{ marginTop: "0.75rem", padding: "0.5rem 0.75rem", background: "rgba(245,158,11,0.08)", border: "1px solid #b45309", borderRadius: 6 }}>
              <div style={{ fontSize: "0.78rem", color: "#fbbf24", fontWeight: "bold", marginBottom: "0.3rem" }}>
                ⚙️ Pesos de factores ajustados automáticamente (overfitting {walkForwardResult.overfittingRisk}):
              </div>
              <div style={{ display: "flex", gap: "1rem", fontSize: "0.78rem", color: "#d1d5db" }}>
                {Object.entries(walkForwardResult.adaptiveFactorWeights).map(([factor, weight]) => (
                  <span key={factor}>
                    <span style={{ color: "#9ca3af" }}>{factor}:</span>{" "}
                    <span style={{ color: weight < 0.35 && factor === "momentum" ? "#f59e0b" : "#e5e7eb", fontWeight: "bold" }}>
                      {(weight * 100).toFixed(0)}%
                    </span>
                    {factor === "momentum" && weight < 0.38 && <span style={{ color: "#f59e0b" }}> ↓</span>}
                    {factor === "lowVol" && weight > 0.16 && <span style={{ color: "#10b981" }}> ↑</span>}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "0.3rem" }}>
                El motor aplica estos pesos automáticamente hasta que el walk-forward detecte robustez LOW.
              </div>
            </div>
          )}
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

      {/* ═══════════════ BTC CYCLE ANALYZER ═══════════════ */}
      {btcCycleResult && (() => {
        const c = btcCycleResult;
        const pl = c.powerLaw;
        const hv = c.halvingPhase;
        const ew = c.elliottWave;
        const btcPrice = portfolio.assets.find(a => a.ticker === "BTC-EUR")?.price ?? 0;

        // Proyecciones Power Law para fechas futuras
        const plFair6m   = getPowerLawProjection(new Date(Date.now() + 180*86400000), "fair")  / 1.08;
        const plUpper12m = getPowerLawProjection(new Date(Date.now() + 365*86400000), "upper") / 1.08;
        const plLower12m = getPowerLawProjection(new Date(Date.now() + 365*86400000), "lower") / 1.08;
        const btcPriceUSD = btcPrice * 1.08;
        const discountFromFair = pl.fairValue > 0 ? (pl.fairValue - btcPriceUSD) / pl.fairValue : 0;

        const scoreColor = c.cycleScore >= 75 ? "#10b981" : c.cycleScore >= 55 ? "#3b82f6" : c.cycleScore >= 40 ? "#f59e0b" : "#ef4444";
        const zoneLabels: Record<string, string> = {
          BUY_ZONE: "🟢 ZONA DE COMPRA", ACCUMULATION: "🔵 ACUMULACIÓN",
          NEUTRAL: "🟡 NEUTRAL", CAUTION_ZONE: "🟠 PRECAUCIÓN", SELL_ZONE: "🔴 ZONA DE VENTA"
        };
        const waveColors: Record<string, string> = {
          "1":"#10b981","3":"#10b981","5":"#f59e0b",
          "2":"#6b7280","4":"#6b7280","A":"#ef4444","B":"#f59e0b","C":"#ef4444","UNKNOWN":"#6b7280"
        };
        const waveColor = waveColors[ew.currentWave] ?? "#6b7280";

        // Frases de narrativa según onda
        const elliottNarrative: Record<string, { titulo: string; que: string; como: string; target: string; alerta: string }> = {
          "1": {
            titulo: "Onda 1 — Primer impulso alcista",
            que: "El mercado ha salido del suelo del bear market. La mayoría aún no lo cree — es la onda más difícil de reconocer en tiempo real.",
            como: "Volumen bajo-moderado. Los primeros compradores entran silenciosamente. El sentimiento general sigue siendo negativo.",
            target: "Históricamente retrocede hasta el 38–62% en la Onda 2 siguiente. No es momento de apalancar.",
            alerta: "Invalidación si el precio cae por debajo del inicio de Onda 1."
          },
          "2": {
            titulo: "Onda 2 — Corrección del primer impulso",
            que: "Pullback normal tras Onda 1. El mercado 'prueba' a los compradores débiles. Psicológicamente parece que el rebote fue falso.",
            como: "Retroceso del 50–78.6% de Onda 1 es lo normal. Si cierra por debajo del inicio de Onda 1 → conteo inválido.",
            target: "El suelo de Onda 2 es históricamente la mejor zona de entrada del ciclo entero.",
            alerta: "NO puede cruzar el inicio de Onda 1. Si lo hace, el conteo es incorrecto."
          },
          "3": {
            titulo: "Onda 3 — El impulso más fuerte del ciclo",
            que: "La onda más larga y poderosa. El público generalista empieza a comprar. FOMO institucional. Es donde se hace la mayor parte del dinero.",
            como: "Mínimo 1.618x de Onda 1. Volumen en expansión. Noticias positivas generalizadas. RSI puede mantenerse sobrecomprado semanas.",
            target: ew.waveTargets ? `Target Onda 3: €${ew.waveTargets.conservative?.toFixed(0) ?? "—"}` : "Extensión mínima: 1.618x Onda 1 desde el suelo de Onda 2.",
            alerta: "Zona de techo potencial cuando RSI semanal > 85 + MVRV > 3.5 simultáneamente."
          },
          "4": {
            titulo: "Onda 4 — Consolidación antes del pico final",
            que: "Corrección lateral-alcista después de Onda 3. Los que compraron tarde en Onda 3 se impacientan y venden. Es aburrida y larga.",
            como: `Retroceso típico 23.6–38.2% de Onda 3. Soporte clave: ${ew.correctionSupport ? `€${ew.correctionSupport.shallow.toFixed(0)} (38.2%)` : "Fibonacci 38.2% de Onda 3"}.`,
            target: ew.waveTargets ? `Target Onda 5: €${ew.waveTargets.conservative?.toFixed(0) ?? "—"} (conservador) · €${ew.waveTargets.base?.toFixed(0) ?? "—"} (extendido)` : "Tras confirmar soporte, Onda 5 proyecta 0.618–1.0x Onda 1 desde el techo de Onda 3.",
            alerta: "NO puede entrar en territorio de precio de Onda 1. Señal de alerta máxima si rompe soporte 61.8%."
          },
          "5": {
            titulo: "Onda 5 — Último impulso alcista — PRECAUCIÓN MÁXIMA",
            que: "El pico final del ciclo. Sentimiento eufórico, máxima cobertura mediática, nuevos máximos históricos. Es donde los institucionales distribuyen a los minoristas tardíos.",
            como: "Divergencia bajista RSI frecuente (precio sube, RSI no confirma). Volumen puede ser menor que Onda 3. MVRV > 3.5 posible.",
            target: ew.waveTargets ? `Target: €${ew.waveTargets.conservative?.toFixed(0) ?? "—"}–€${ew.waveTargets.base?.toFixed(0) ?? "—"}. Activar ventas escalonadas.` : "Ventas escalonadas al acercarse a Fibonacci 1.0x–1.618x desde Onda 4.",
            alerta: "Si Pi Cycle cruza + RSI > 85 + MVRV > 4 → VENDER 50–70% de posición BTC inmediatamente."
          },
          "A": {
            titulo: "Onda A — Inicio del crash correctivo",
            que: "El mercado alcista ha terminado. Onda A es el primer impulso bajista. Muchos la interpretan como corrección sana — es una trampa.",
            como: "Caída del 30–50% desde el techo es normal. El sentimiento pasa de eufórico a confuso. Las noticias siguen siendo positivas.",
            target: "Esperar confirmación de Onda B (rebote) antes de aumentar exposición. No es el fondo.",
            alerta: "No comprar agresivamente hasta confirmar el fin de la corrección ABC completa."
          },
          "B": {
            titulo: "Onda B — Rebote trampa en bear market",
            que: "El rebote más peligroso. Parece la recuperación del bull market — no lo es. Muchos reingresan aquí y pierden en la caída de Onda C.",
            como: "Rebote del 50–78.6% de Onda A. Sentimiento mejora artificialmente. Volumen menor que en el impulso bajista anterior.",
            target: "NO aumentar posición aquí. La Onda C siguiente puede ser más violenta que Onda A.",
            alerta: "Si supera el 100% de Onda A → posible reconteo como impulso alcista, no corrección."
          },
          "C": {
            titulo: "Onda C — Caída final — Zona de acumulación histórica",
            que: "El pánico real. Capitulación generalizada. Las noticias son apocalípticas. Es la zona donde los ciclos anteriores formaron los mejores suelos de compra.",
            como: "Onda C suele ser 1.0–1.618x Onda A en longitud. Puell Multiple cae bajo 0.5. Hash Ribbon entra en capitulación.",
            target: ew.correctionSupport ? `Soporte clave: €${ew.correctionSupport.deep.toFixed(0)} (61.8%) · €${ew.correctionSupport.deep.toFixed(0)} (78.6%)` : "DCA agresivo cuando MVRV < 1 + Puell < 0.5.",
            alerta: "Si la cartera tiene liquidez acumulada defensiva → este es el momento de desplegarla."
          },
          "UNKNOWN": {
            titulo: "Onda — Sin conteo confirmado",
            que: "No hay suficientes pivotes definidos para determinar la onda actual con precisión.",
            como: "Introduce los puntos clave del ciclo (suelo Nov 2022, techo Ene 2024, etc.) en el campo de pivotes arriba.",
            target: "Con 2+ pivotes el algoritmo detecta automáticamente la onda y proyecta targets de precio.",
            alerta: "Sin conteo confirmado el sistema usa Power Law + Halving como guía principal."
          }
        };

        const narrative = elliottNarrative[ew.currentWave] ?? elliottNarrative["UNKNOWN"];

        return (
          <div style={{ ...styles.card, border: `1px solid ${scoreColor}`, background: "linear-gradient(135deg, #080d1a 0%, #111827 100%)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
              <h2 style={{ margin: 0 }}>₿ BTC Cycle Intelligence</h2>
              <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "2.5rem", fontWeight: "bold", color: scoreColor, lineHeight: 1 }}>{c.cycleScore}</div>
                  <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>/ 100</div>
                </div>
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: "0.4rem 0.75rem", border: `1px solid ${scoreColor}` }}>
                  <div style={{ color: scoreColor, fontWeight: "bold", fontSize: "0.85rem" }}>{zoneLabels[c.cycleScoreLabel]}</div>
                  <div style={{ color: "#9ca3af", fontSize: "0.72rem" }}>{c.actionBias}</div>
                </div>
              </div>
            </div>

            {/* Narrativa resumen */}
            <div style={{ background: "rgba(99,102,241,0.08)", border: "1px solid #312e81", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem" }}>
              <p style={{ color: "#c7d2fe", fontSize: "0.82rem", margin: 0, lineHeight: 1.6 }}>{c.summary}</p>
            </div>

            {/* Grid de 4 indicadores */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>

              {/* Power Law */}
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.75rem" }}>
                <div style={{ color: "#818cf8", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>📐 POWER LAW CHANNEL</div>
                <div style={{ fontSize: "0.82rem", color: "#e5e7eb", marginBottom: "0.3rem" }}>
                  Precio actual: <strong>€{btcPrice.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</strong>
                </div>
                <div style={{ fontSize: "0.78rem", color: "#9ca3af" }}>
                  Valor justo: <span style={{ color: "#f59e0b" }}>€{(pl.fairValue / 1.08).toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span>
                </div>
                <div style={{ fontSize: "0.78rem", color: "#9ca3af" }}>
                  Canal: €{(pl.lower / 1.08).toLocaleString("es-ES", { maximumFractionDigits: 0 })} – €{(pl.upper / 1.08).toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                </div>
                <div style={{ fontSize: "0.78rem", marginTop: "0.3rem", color: discountFromFair > 0.3 ? "#10b981" : discountFromFair > 0 ? "#f59e0b" : "#ef4444" }}>
                  {discountFromFair > 0
                    ? `${(discountFromFair * 100).toFixed(0)}% por debajo del valor justo — históricamente buena entrada`
                    : `${(Math.abs(discountFromFair) * 100).toFixed(0)}% por encima del valor justo — zona de precaución`}
                </div>
                <div style={{ marginTop: "0.5rem", borderTop: "1px solid #1f2937", paddingTop: "0.4rem" }}>
                  <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>Proyección Power Law:</div>
                  <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>6m: <span style={{ color: "#d1d5db" }}>€{plFair6m.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span></div>
                  <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>12m (rango): <span style={{ color: "#d1d5db" }}>€{plLower12m.toLocaleString("es-ES", { maximumFractionDigits: 0 })} – €{plUpper12m.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span></div>
                  <div style={{ fontSize: "0.65rem", color: "#4b5563", marginTop: "0.2rem" }}>Harold Burger model (2019) · calibrado USD → convertido EUR @1.08</div>
                </div>
              </div>

              {/* Halving Phase */}
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.75rem" }}>
                <div style={{ color: "#f59e0b", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>⛏ HALVING CYCLE</div>
                <div style={{ fontSize: "0.82rem", color: "#e5e7eb", marginBottom: "0.3rem" }}>
                  Fase: <strong style={{ color: "#f59e0b" }}>{hv.phase.replace(/_/g, " ")}</strong>
                </div>
                <div style={{ fontSize: "0.75rem", color: "#9ca3af", lineHeight: 1.5 }}>{hv.phaseDescription}</div>
                <div style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "0.4rem" }}>
                  {hv.daysSinceHalving > 0
                    ? `${hv.daysSinceHalving} días desde el halving (${(hv.daysSinceHalving / 30).toFixed(0)} meses)`
                    : `${Math.abs(hv.daysSinceHalving)} días para el próximo halving`}
                </div>
                <div style={{ fontSize: "0.72rem", color: "#4b5563", marginTop: "0.2rem" }}>
                  Ventana histórica de pico: {hv.historicalPeakWindow}
                </div>
              </div>

              {/* Puell + Hash Ribbon */}
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.75rem" }}>
                <div style={{ color: "#10b981", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>⚡ ON-CHAIN SIGNALS</div>
                <div style={{ marginBottom: "0.5rem" }}>
                  <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Puell Multiple:</div>
                  <div style={{ fontSize: "0.78rem", color: c.puellMultiple.zone === "CAPITULATION" ? "#10b981" : c.puellMultiple.zone === "EUPHORIA" ? "#ef4444" : "#f59e0b" }}>
                    {c.puellMultiple.value === null
                      ? "Sin dato — introduce el valor en los inputs"
                      : `${c.puellMultiple.description}`}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Hash Ribbon:</div>
                  <div style={{ fontSize: "0.78rem", color: c.hashRibbon.buySignalActive ? "#10b981" : c.hashRibbon.state === "CAPITULATION" ? "#ef4444" : "#d1d5db" }}>
                    {c.hashRibbon.state === "UNKNOWN"
                      ? "Sin dato — selecciona estado en los inputs"
                      : c.hashRibbon.description}
                  </div>
                </div>
                <div style={{ marginTop: "0.5rem" }}>
                  <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Pi Cycle Top:</div>
                  <div style={{ fontSize: "0.78rem", color: c.piCycle.state === "CROSSED" ? "#ef4444" : "#10b981" }}>
                    {c.piCycle.state === "CROSSED"
                      ? "⚠️ CRUCE DETECTADO — señal histórica de techo"
                      : c.piCycle.gapPct !== null
                        ? `Separación: ${(c.piCycle.gapPct * 100).toFixed(0)}% · sin señal de techo`
                        : "Sin dato — introduce 111DMA y 350DMA×2"}
                  </div>
                </div>
              </div>

              {/* Elliott Wave */}
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.75rem", border: `1px solid ${waveColor}40` }}>
                <div style={{ color: waveColor, fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>🌊 ELLIOTT WAVE</div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.4rem" }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: "50%",
                    background: `${waveColor}22`, border: `2px solid ${waveColor}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "1.1rem", fontWeight: "bold", color: waveColor
                  }}>{ew.currentWave}</div>
                  <div>
                    <div style={{ fontSize: "0.78rem", color: "#e5e7eb", fontWeight: "bold" }}>{narrative.titulo}</div>
                    <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>
                      Dirección: {ew.currentWaveDirection} · Confianza: {ew.confidence}
                    </div>
                  </div>
                </div>
                {ew.invalidationLevel && (
                  <div style={{ fontSize: "0.72rem", color: "#ef4444", marginTop: "0.3rem" }}>
                    🛑 Invalidación: &lt;€{ew.invalidationLevel.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                  </div>
                )}
              </div>
            </div>

            {/* PANEL ELLIOTT DETALLADO */}
            <div style={{ background: "rgba(0,0,0,0.3)", border: `1px solid ${waveColor}40`, borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}>
              <h4 style={{ color: waveColor, margin: "0 0 0.75rem" }}>🌊 {narrative.titulo} — Análisis Detallado</h4>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0.75rem" }}>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "#818cf8", fontWeight: "bold", marginBottom: "0.25rem" }}>¿QUÉ ESTÁ PASANDO?</div>
                  <p style={{ color: "#d1d5db", fontSize: "0.78rem", margin: 0, lineHeight: 1.6 }}>{narrative.que}</p>
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "#10b981", fontWeight: "bold", marginBottom: "0.25rem" }}>¿CÓMO SE RECONOCE?</div>
                  <p style={{ color: "#d1d5db", fontSize: "0.78rem", margin: 0, lineHeight: 1.6 }}>{narrative.como}</p>
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "#f59e0b", fontWeight: "bold", marginBottom: "0.25rem" }}>🎯 TARGET / ACCIÓN</div>
                  <p style={{ color: "#d1d5db", fontSize: "0.78rem", margin: 0, lineHeight: 1.6 }}>{narrative.target}</p>
                  {/* Targets numéricos si disponibles */}
                  {ew.waveTargets && ew.currentWave === "4" && (
                    <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                      {ew.waveTargets.conservative && (
                        <div style={{ background: "rgba(245,158,11,0.1)", borderRadius: 4, padding: "0.25rem 0.5rem", fontSize: "0.72rem" }}>
                          <span style={{ color: "#f59e0b" }}>Onda 5 conservador:</span>{" "}
                          <strong style={{ color: "#e5e7eb" }}>€{ew.waveTargets.conservative.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</strong>
                        </div>
                      )}
                      {ew.waveTargets.base && (
                        <div style={{ background: "rgba(245,158,11,0.15)", borderRadius: 4, padding: "0.25rem 0.5rem", fontSize: "0.72rem" }}>
                          <span style={{ color: "#f59e0b" }}>Onda 5 extendido:</span>{" "}
                          <strong style={{ color: "#e5e7eb" }}>€{ew.waveTargets.base.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</strong>
                        </div>
                      )}
                    </div>
                  )}
                  {ew.waveTargets && ew.currentWave === "3" && ew.waveTargets.conservative && (
                    <div style={{ marginTop: "0.5rem", background: "rgba(16,185,129,0.1)", borderRadius: 4, padding: "0.25rem 0.5rem", fontSize: "0.72rem" }}>
                      <span style={{ color: "#10b981" }}>Onda 3 target 1.618x:</span>{" "}
                      <strong style={{ color: "#e5e7eb" }}>€{ew.waveTargets.conservative.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</strong>
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: "0.7rem", color: "#ef4444", fontWeight: "bold", marginBottom: "0.25rem" }}>⚠️ ALERTAS / INVALIDACIÓN</div>
                  <p style={{ color: "#d1d5db", fontSize: "0.78rem", margin: 0, lineHeight: 1.6 }}>{narrative.alerta}</p>
                  {ew.invalidationLevel && (
                    <div style={{ marginTop: "0.4rem", background: "rgba(239,68,68,0.1)", borderRadius: 4, padding: "0.25rem 0.5rem", fontSize: "0.72rem", color: "#fca5a5" }}>
                      Si precio &lt; €{ew.invalidationLevel.toLocaleString("es-ES", { maximumFractionDigits: 0 })} → conteo invalidado
                    </div>
                  )}
                </div>
              </div>

              {/* Pivotes del ciclo */}
              {ew.identifiedWaves.length >= 2 && (
                <div style={{ marginTop: "0.75rem", borderTop: "1px solid #1f2937", paddingTop: "0.75rem" }}>
                  <div style={{ fontSize: "0.7rem", color: "#6b7280", marginBottom: "0.4rem" }}>PIVOTES DEL CICLO CARGADOS:</div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {ew.identifiedWaves.map((p, i) => (
                      <div key={i} style={{
                        background: p.label === "HIGH" ? "rgba(245,158,11,0.12)" : "rgba(16,185,129,0.12)",
                        border: `1px solid ${p.label === "HIGH" ? "#f59e0b" : "#10b981"}44`,
                        borderRadius: 4, padding: "0.2rem 0.5rem", fontSize: "0.7rem"
                      }}>
                        <span style={{ color: "#6b7280" }}>P{i + 1} </span>
                        <span style={{ color: p.label === "HIGH" ? "#f59e0b" : "#10b981", fontWeight: "bold" }}>
                          €{p.price.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                        </span>
                        <span style={{ color: "#4b5563" }}> {p.label}</span>
                      </div>
                    ))}
                    {ew.correctionSupport && (
                      <>
                        <div style={{ background: "rgba(99,102,241,0.1)", border: "1px solid #4f46e544", borderRadius: 4, padding: "0.2rem 0.5rem", fontSize: "0.7rem" }}>
                          <span style={{ color: "#818cf8" }}>38.2%: €{ew.correctionSupport.shallow.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span>
                        </div>
                        <div style={{ background: "rgba(99,102,241,0.1)", border: "1px solid #4f46e544", borderRadius: 4, padding: "0.2rem 0.5rem", fontSize: "0.7rem" }}>
                          <span style={{ color: "#818cf8" }}>61.8%: €{ew.correctionSupport.deep.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Razón del conteo */}
              <div style={{ marginTop: "0.5rem", fontSize: "0.7rem", color: "#4b5563", fontStyle: "italic" }}>
                {ew.confidenceReason}
              </div>
            </div>

            {/* PROYECCIÓN COMPLETA DEL CICLO */}
            <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid #1f2937", borderRadius: 8, padding: "1rem" }}>
              <h4 style={{ color: "#9ca3af", margin: "0 0 0.75rem", fontSize: "0.85rem" }}>📈 PROYECCIÓN DE CICLO — Cómo se anticipa el movimiento</h4>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem" }}>

                <div style={{ background: "#111827", borderRadius: 6, padding: "0.6rem" }}>
                  <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>PRECIO ACTUAL</div>
                  <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#e5e7eb" }}>
                    €{btcPrice.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: discountFromFair > 0 ? "#10b981" : "#ef4444" }}>
                    {discountFromFair > 0 ? `−${(discountFromFair * 100).toFixed(0)}% vs fair value` : `+${(Math.abs(discountFromFair) * 100).toFixed(0)}% vs fair value`}
                  </div>
                </div>

                <div style={{ background: "#111827", borderRadius: 6, padding: "0.6rem" }}>
                  <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>FAIR VALUE HOY (Power Law)</div>
                  <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#f59e0b" }}>
                    €{(pl.fairValue / 1.08).toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>modelo logarítmico Harold Burger</div>
                </div>

                <div style={{ background: "#111827", borderRadius: 6, padding: "0.6rem" }}>
                  <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>FAIR VALUE +6M (Power Law)</div>
                  <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#f59e0b" }}>
                    €{plFair6m.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>crecimiento logarítmico del modelo</div>
                </div>

                <div style={{ background: "#111827", borderRadius: 6, padding: "0.6rem" }}>
                  <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>RANGO +12M (Power Law)</div>
                  <div style={{ fontSize: "1rem", fontWeight: "bold", color: "#d1d5db" }}>
                    €{plLower12m.toLocaleString("es-ES", { maximumFractionDigits: 0 })} – €{plUpper12m.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>banda inferior–superior del canal</div>
                </div>

                {ew.waveTargets && (ew.currentWave === "4" || ew.currentWave === "2") && (
                  <>
                    <div style={{ background: "rgba(16,185,129,0.08)", border: "1px solid #10b98133", borderRadius: 6, padding: "0.6rem" }}>
                      <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>TARGET ONDA 5 (conservador)</div>
                      <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#10b981" }}>
                        €{ew.waveTargets.conservative ? ew.waveTargets.conservative.toLocaleString("es-ES", { maximumFractionDigits: 0 }) : "—"}
                      </div>
                      <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>0.618x Onda 1 desde techo Onda 3</div>
                    </div>
                    <div style={{ background: "rgba(16,185,129,0.12)", border: "1px solid #10b98155", borderRadius: 6, padding: "0.6rem" }}>
                      <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>TARGET ONDA 5 (extendido)</div>
                      <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#10b981" }}>
                        €{ew.waveTargets.base ? ew.waveTargets.base.toLocaleString("es-ES", { maximumFractionDigits: 0 }) : "—"}
                      </div>
                      <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>1.618x Onda 1 desde techo Onda 3</div>
                    </div>
                  </>
                )}

                {ew.correctionSupport && (ew.currentWave === "4" || ew.currentWave === "2" || ew.currentWave === "C") && (
                  <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid #ef444433", borderRadius: 6, padding: "0.6rem" }}>
                    <div style={{ fontSize: "0.68rem", color: "#6b7280", marginBottom: "0.25rem" }}>SOPORTE CORRECCIÓN</div>
                    <div style={{ fontSize: "0.85rem", color: "#fca5a5" }}>
                      38.2%: €{ew.correctionSupport.shallow.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                    </div>
                    <div style={{ fontSize: "0.85rem", color: "#ef4444" }}>
                      61.8%: €{ew.correctionSupport.deep.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                    </div>
                    <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>zona de acumulación si respeta</div>
                  </div>
                )}
              </div>

              {/* Condiciones para confirmar el siguiente movimiento */}
              <div style={{ marginTop: "0.75rem", borderTop: "1px solid #1f2937", paddingTop: "0.75rem" }}>
                <div style={{ fontSize: "0.7rem", color: "#6b7280", marginBottom: "0.4rem", fontWeight: "bold" }}>
                  CONDICIONES PARA CONFIRMAR EL SIGUIENTE MOVIMIENTO:
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {ew.currentWave === "4" && (
                    <>
                      <div style={{ fontSize: "0.75rem", color: "#d1d5db" }}>
                        ✅ <strong>Alcista (Onda 5):</strong> precio cierra sobre el máximo previo de Onda 3 + volumen en expansión + RSI semanal saliendo de sobrevendido
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#fca5a5" }}>
                        ⛔ <strong>Bajista (extensión correctiva):</strong> precio pierde soporte 61.8% de Onda 3 · Nivel: €{ew.correctionSupport ? ew.correctionSupport.deep.toLocaleString("es-ES", { maximumFractionDigits: 0 }) : "—"}
                      </div>
                    </>
                  )}
                  {ew.currentWave === "2" && (
                    <>
                      <div style={{ fontSize: "0.75rem", color: "#d1d5db" }}>
                        ✅ <strong>Alcista (Onda 3):</strong> precio cierra sobre el máximo de Onda 1 + RSI semanal girando al alza desde zona neutral
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#fca5a5" }}>
                        ⛔ <strong>Invalidación:</strong> precio cae bajo el inicio de Onda 1 · conteo descartado
                      </div>
                    </>
                  )}
                  {(ew.currentWave === "1" || ew.currentWave === "3" || ew.currentWave === "5") && (
                    <div style={{ fontSize: "0.75rem", color: "#d1d5db" }}>
                      ✅ <strong>Impulso activo:</strong> mantener posición · stops por debajo del último pivote bajo · escalar salidas si RSI semanal {">"} 80
                    </div>
                  )}
                  {(ew.currentWave === "A" || ew.currentWave === "B" || ew.currentWave === "C") && (
                    <div style={{ fontSize: "0.75rem", color: "#fca5a5" }}>
                      ⚠️ <strong>Fase correctiva activa:</strong> no incrementar agresivamente · esperar confirmación de agotamiento bajista (Puell {"<"} 0.5 + Hash Ribbon en capitulación)
                    </div>
                  )}
                  {ew.currentWave === "UNKNOWN" && (
                    <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
                      📌 Introduce los pivotes del ciclo en los inputs de arriba para obtener condiciones de confirmación precisas.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* CYCLE TOP — panel de alertas de techo de ciclo */}
      {cycleTopResult.hasActiveWarnings && (
        <div style={{ ...styles.card, border: "1px solid #d97706", background: "linear-gradient(135deg, #1c1107 0%, #111827 100%)" }}>
          <h2 style={{ color: "#f59e0b", marginBottom: "0.75rem" }}>⚠️ Señales de Techo de Ciclo Activas</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.82rem", marginBottom: "1rem" }}>
            El motor ha detectado condiciones de fin de ciclo en uno o más activos.
            Las sugerencias de venta en el panel de rebalanceo son reducciones parciales — no salidas totales.
            Ejecutar vendiendo las participaciones indicadas en tu broker.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {cycleTopResult.signals.filter((s: CycleTopSignal) => s.zone !== "SAFE").map((s: CycleTopSignal) => (
              <div key={s.ticker} style={{
                background: s.zone === "EXTREME" ? "rgba(239,68,68,0.12)" : s.zone === "DANGER" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                border: `1px solid ${s.zone === "EXTREME" ? "#ef4444" : s.zone === "DANGER" ? "#ef4444" : "#f59e0b"}`,
                borderRadius: "6px", padding: "0.6rem 1rem",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                  <span style={{ fontWeight: "bold", color: "#e5e7eb" }}>{s.ticker} — {s.asset}</span>
                  <span style={{
                    background: s.zone === "EXTREME" ? "#7f1d1d" : s.zone === "DANGER" ? "#7f1d1d" : "#78350f",
                    color: s.zone === "EXTREME" || s.zone === "DANGER" ? "#ef4444" : "#f59e0b",
                    padding: "0.1rem 0.5rem", borderRadius: 4, fontSize: "0.75rem", fontWeight: "bold",
                  }}>{s.zone}{s.shouldTrim ? ` · REDUCIR ${s.trimPct}%` : ""}</span>
                </div>
                <p style={{ color: "#9ca3af", fontSize: "0.8rem", margin: 0 }}>{s.indicatorValue}</p>
                <p style={{ color: "#d1d5db", fontSize: "0.78rem", marginTop: "0.2rem", marginBottom: 0 }}>{s.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PANEL FISCAL ESPAÑA — análisis de conveniencia de ventas */}
      {taxAnalysis && taxAnalysis.analyses.length > 0 && (
        <div style={{ ...styles.card, border: "1px solid #6366f1", background: "linear-gradient(135deg, #0f0a1e 0%, #111827 100%)" }}>
          <h2 style={{ color: "#818cf8", marginBottom: "0.5rem" }}>🧾 Análisis Fiscal — IRPF España 2025</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.82rem", marginBottom: "1rem" }}>
            Basado en tramos del IRPF 2025 (base del ahorro). Incluye compensación de minusvalías latentes del portfolio.
            Este análisis es orientativo — consulta con tu asesor fiscal para decisiones definitivas.
          </p>

          {/* Resumen del portfolio */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
            <div style={{ background: "#1f2937", borderRadius: 6, padding: "0.6rem 1rem" }}>
              <div style={{ color: "#9ca3af", fontSize: "0.75rem" }}>Plusvalías latentes</div>
              <div style={{ color: "#10b981", fontWeight: "bold", fontSize: "1.1rem" }}>+€{taxAnalysis.totalLatentGains.toFixed(0)}</div>
            </div>
            <div style={{ background: "#1f2937", borderRadius: 6, padding: "0.6rem 1rem" }}>
              <div style={{ color: "#9ca3af", fontSize: "0.75rem" }}>Minusvalías latentes</div>
              <div style={{ color: "#ef4444", fontWeight: "bold", fontSize: "1.1rem" }}>−€{taxAnalysis.totalLatentLosses.toFixed(0)}</div>
            </div>
            {taxAnalysis.compensationOpportunity && (
              <div style={{ background: "#1f2937", borderRadius: 6, padding: "0.6rem 1rem", border: "1px solid #f59e0b" }}>
                <div style={{ color: "#f59e0b", fontSize: "0.75rem" }}>⚡ Compensación disponible</div>
                <div style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "1.1rem" }}>€{taxAnalysis.availableLossOffset.toFixed(0)}</div>
                <div style={{ color: "#9ca3af", fontSize: "0.7rem" }}>reduce el impuesto de las ventas</div>
              </div>
            )}
          </div>

          {/* Tabla de análisis por activo */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #374151", color: "#9ca3af" }}>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Activo</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>P&L latente</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Venta parcial</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Ganancia realizada</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Impuesto</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Pérdida si NO vendes</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Break-even</th>
                  <th style={{ textAlign: "center", padding: "0.5rem" }}>Veredicto</th>
                </tr>
              </thead>
              <tbody>
                {taxAnalysis.analyses.map((t: TaxAnalysis) => (
                  <tr key={t.ticker} style={{ borderBottom: "1px solid #1f2937" }}>
                    <td style={{ padding: "0.5rem" }}>
                      <div style={{ fontWeight: "bold" }}>{t.ticker}</div>
                      <div style={{ color: "#6b7280", fontSize: "0.72rem" }}>
                        Compra media: €{t.avgBuyPrice.toFixed(2)}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <span style={{ color: t.latentGainTotal >= 0 ? "#10b981" : "#ef4444" }}>
                        {t.latentGainTotal >= 0 ? "+" : ""}€{t.latentGainTotal.toFixed(0)}
                      </span>
                      <div style={{ color: "#6b7280", fontSize: "0.72rem" }}>
                        {t.latentGainTotal >= 0 ? "+" : ""}{(t.latentGainPct * 100).toFixed(1)}%
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <div>−{t.sharesToSell} acc. ({t.trimPct}%)</div>
                      <div style={{ color: "#9ca3af", fontSize: "0.72rem" }}>Ingreso: €{t.saleProceeds.toFixed(0)}</div>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <span style={{ color: t.realizedGain >= 0 ? "#f59e0b" : "#10b981" }}>
                        {t.realizedGain >= 0 ? "+" : ""}€{t.realizedGain.toFixed(0)}
                      </span>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      {t.realizedGain > 0 ? (
                        <>
                          <div style={{ color: "#ef4444" }}>€{t.taxAfterOffset.toFixed(0)}</div>
                          <div style={{ color: "#6b7280", fontSize: "0.72rem" }}>
                            {(t.effectiveRate * 100).toFixed(1)}% efectivo
                            {t.lossOffsetUsed > 0 && <span style={{ color: "#10b981" }}> (−€{t.lossOffsetUsed.toFixed(0)} offset)</span>}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: "#10b981" }}>€0 — minusvalía</span>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <div style={{ color: "#ef4444" }}>−€{t.expectedLossEuros.toFixed(0)}</div>
                      <div style={{ color: "#6b7280", fontSize: "0.72rem" }}>
                        −{(t.expectedDrawdownPct * 100).toFixed(0)}% caso central {t.cycleZone}
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <div>€{t.breakEvenPrice.toFixed(2)}</div>
                      <div style={{ color: "#6b7280", fontSize: "0.72rem" }}>
                        −{(((t.currentPrice - t.breakEvenPrice) / t.currentPrice) * 100).toFixed(1)}% desde hoy
                      </div>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "center" }}>
                      <div style={{
                        background: t.verdict === "CONVIENE" ? "#052e16" : t.verdict === "ANALIZAR" ? "#78350f" : t.verdict === "EN_PERDIDAS" ? "#052e16" : "#1f2937",
                        border: `1px solid ${t.verdict === "CONVIENE" ? "#10b981" : t.verdict === "ANALIZAR" ? "#f59e0b" : t.verdict === "EN_PERDIDAS" ? "#10b981" : "#6b7280"}`,
                        borderRadius: 6, padding: "0.3rem 0.5rem",
                      }}>
                        <div style={{
                          fontWeight: "bold", fontSize: "0.78rem",
                          color: t.verdict === "CONVIENE" ? "#10b981" : t.verdict === "ANALIZAR" ? "#f59e0b" : t.verdict === "EN_PERDIDAS" ? "#10b981" : "#9ca3af",
                        }}>{t.verdictEmoji} {t.verdict.replace("_", " ")}</div>
                        <div style={{ color: "#6b7280", fontSize: "0.68rem", marginTop: "0.2rem", textAlign: "left" }}>
                          {t.verdictReason}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Avisos generales */}
          {taxAnalysis.generalAdvice.length > 0 && (
            <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {taxAnalysis.generalAdvice.map((advice: string, i: number) => (
                <div key={i} style={{ background: "#1f2937", borderLeft: "3px solid #6366f1", padding: "0.5rem 0.75rem", fontSize: "0.8rem", color: "#d1d5db" }}>
                  💡 {advice}
                </div>
              ))}
            </div>
          )}

          <p style={{ color: "#4b5563", fontSize: "0.72rem", marginTop: "0.75rem" }}>
            ⚠️ Cálculo orientativo. No tiene en cuenta retenciones previas, rendimientos de capital del ejercicio, ni situaciones particulares de IRPF.
            Consulta con un asesor fiscal antes de ejecutar ventas significativas.
          </p>
        </div>
      )}

      {/* NIVEL 4: Rebalanceo real basado en motor */}
      {taxAwareRebalance && (taxAwareRebalance.suggestions.length > 0) && (
        <div style={styles.card}>
          <h2>⚖️ Rebalanceo — Motor Olympus</h2>
          {dcaBlocked && (
            <div style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: '6px', padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.85rem', color: '#fca5a5' }}>
              ⛔ DCA {dcaAction} — La aportación mensual de €{monthlyInjection.toFixed(0)} está congelada como liquidez defensiva.
              Solo se usa la reserva existente (€{cashReserve.toFixed(0)}) para rebalancear déficits prioritarios.
              {cashReserve < 10 && " Sin reserva disponible — no se ejecutan compras."}
            </div>
          )}
          <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: "1rem" }}>
            Basado en allocations reales del motor. Cash disponible: <strong>€{availableCash.toFixed(0)}</strong> ·
            Cobertura del rebalanceo ideal: <strong>{(taxAwareRebalance!.coverageRatio * 100).toFixed(0)}%</strong>
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #374151", color: "#9ca3af" }}>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Activo</th>
                  <th style={{ textAlign: "center", padding: "0.5rem" }}>Acción</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Actual</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Objetivo</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Drift</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>Cantidad</th>
                  <th style={{ textAlign: "right", padding: "0.5rem" }}>€</th>
                  <th style={{ textAlign: "left", padding: "0.5rem" }}>Prioridad / Señal</th>
                </tr>
              </thead>
              <tbody>
                {taxAwareRebalance!.suggestions.map((s: RebalanceSuggestion) => (
                  <tr key={s.ticker} style={{
                    borderBottom: "1px solid #1f2937",
                    background: s.action === "SELL" ? "rgba(239,68,68,0.07)" : "transparent",
                  }}>
                    <td style={{ padding: "0.5rem", fontWeight: "bold" }}>{s.ticker}</td>
                    <td style={{ padding: "0.5rem", textAlign: "center" }}>
                      <span style={{
                        background: s.action === "SELL" ? "#7f1d1d" : "#052e16",
                        color: s.action === "SELL" ? "#ef4444" : "#10b981",
                        padding: "0.1rem 0.5rem", borderRadius: 4, fontSize: "0.75rem", fontWeight: "bold",
                      }}>{s.action}</span>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>{(s.currentPct * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6366f1" }}>{(s.targetPct * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: s.drift > 0 ? "#f59e0b" : "#ef4444" }}>{(s.drift * 100).toFixed(1)}pp</td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      {s.action === "SELL"
                        ? <span style={{ color: "#ef4444" }}>−{s.sharesToSell} ({s.trimPct}%)</span>
                        : <span style={{ color: "#10b981" }}>+{s.sharesToBuy}</span>
                      }
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      {s.action === "SELL"
                        ? <span style={{ color: "#f59e0b" }}>+€{s.proceedsIfSold.toFixed(0)}</span>
                        : <span style={{ color: "#10b981" }}>−€{s.cost.toFixed(0)}</span>
                      }
                    </td>
                    <td style={{ padding: "0.5rem", fontSize: "0.78rem" }}>
                      <span style={{
                        backgroundColor: s.priority === "HIGH" ? "#7f1d1d" : s.priority === "MEDIUM" ? "#78350f" : "#1f2937",
                        color: s.priority === "HIGH" ? "#ef4444" : s.priority === "MEDIUM" ? "#f59e0b" : "#9ca3af",
                        padding: "0.1rem 0.4rem", borderRadius: 4, marginRight: "0.3rem",
                      }}>{s.priority}</span>
                      {s.cycleZone && s.cycleZone !== "SAFE" && (
                        <span style={{ color: "#9ca3af" }}>· {s.cycleIndicatorValue}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginTop: "0.75rem" }}>
            Total compras: <strong style={{ color: "#10b981" }}>€{taxAwareRebalance!.totalCost.toFixed(0)}</strong> ·
            Restante: €{taxAwareRebalance!.remainingCash.toFixed(0)}
          </p>
        </div>
      )}

      {/* NIVEL 5: Panel de confluencia de fondo (siempre visible cuando hay señales) */}
      {smartDCAResult.attackConfluence > 0 && (
        <div style={{
          ...styles.card,
          border: smartDCAResult.attackMode ? "2px solid #22c55e" : "1px solid #374151",
          background: smartDCAResult.attackMode ? "linear-gradient(135deg, #052e16 0%, #111827 100%)" : undefined,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ margin: 0 }}>
              {smartDCAResult.attackMode ? "🚀" : "🎯"} Modo Ataque — Confluencia de Fondo
            </h2>
            <div style={{
              padding: "0.35rem 0.9rem", borderRadius: 20, fontWeight: "bold", fontSize: "0.85rem",
              backgroundColor: smartDCAResult.attackConfluence >= 4 ? "#14532d"
                : smartDCAResult.attackConfluence >= 3 ? "#065f46"
                : smartDCAResult.attackConfluence >= 2 ? "#1e3a5f" : "#374151",
              color: "#fff",
            }}>
              {smartDCAResult.attackConfluence}/5 señales · Tramo {smartDCAResult.attackTranche || "—"}
              {smartDCAResult.attackMultiplier > 1 && ` · ×${smartDCAResult.attackMultiplier} DCA`}
            </div>
          </div>

          {/* Grid de señales de confluencia */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem", marginBottom: "1rem" }}>
            {smartDCAResult.attackSignals.map(signal => (
              <div key={signal.name} style={{
                backgroundColor: signal.active ? "#052e16" : "#111827",
                border: `1px solid ${signal.active ? "#22c55e" : "#374151"}`,
                borderRadius: 8, padding: "0.65rem",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
                  <span style={{ fontSize: "1rem" }}>{signal.active ? "✅" : "⏳"}</span>
                  <span style={{ fontSize: "0.75rem", fontWeight: "bold", color: signal.active ? "#86efac" : "#6b7280" }}>
                    {signal.name}
                  </span>
                </div>
                <p style={{ fontSize: "0.7rem", color: signal.active ? "#bbf7d0" : "#4b5563", margin: 0 }}>
                  {signal.description}
                </p>
              </div>
            ))}
          </div>

          {/* Acción de ataque si está activa */}
          {smartDCAResult.attackMode && (
            <div style={{ backgroundColor: "#052e16", border: "1px solid #22c55e", borderRadius: 8, padding: "0.75rem 1rem" }}>
              <p style={{ fontWeight: "bold", color: "#86efac", marginBottom: "0.25rem" }}>
                {smartDCAResult.action === "ATTACK_MAX" ? "🚀 ATAQUE MÁXIMO — OPORTUNIDAD DE CICLO"
                  : smartDCAResult.action === "ATTACK_STRONG" ? "⚔️ ATAQUE FUERTE — TRAMO 2"
                  : "🎯 ATAQUE ENTRADA — TRAMO 1"}
              </p>
              <p style={{ color: "#d1fae5", fontSize: "0.85rem", margin: 0 }}>{smartDCAResult.reasoning}</p>
            </div>
          )}

          {!smartDCAResult.attackMode && (
            <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: 0 }}>
              Se necesitan ≥2 señales activas + régimen mejorando para activar modo ataque.
              {smartDCAResult.attackConfluence === 1 && " Falta 1 señal más."}
            </p>
          )}
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
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Participaciones</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Precio</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Coste real</th>
                  <th style={{ textAlign: "left",  padding: "0.4rem 0.5rem" }}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {smartDCAResult.allocationByAsset.map(a => (
                  <tr key={a.ticker} style={{
                    borderBottom: "1px solid #1f2937",
                    opacity: a.skipped ? 0.45 : 1,
                  }}>
                    <td style={{ padding: "0.5rem", fontWeight: "bold", color: a.skipped ? "#6b7280" : "#f9fafb" }}>
                      {a.ticker}
                      {a.isFractional && <span style={{ fontSize: "0.7rem", color: "#6366f1", marginLeft: 4 }}>FRAC</span>}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6366f1" }}>
                      {(a.motorWeight * 100).toFixed(1)}%
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold",
                        color: a.skipped ? "#ef4444" : "#f9fafb" }}>
                      {a.skipped ? "—" : a.isFractional
                        ? a.shares.toFixed(6)
                        : `${a.shares}×`}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#9ca3af" }}>
                      €{a.pricePerShare.toFixed(2)}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right",
                        color: a.skipped ? "#6b7280" : "#10b981", fontWeight: a.skipped ? "normal" : "bold" }}>
                      {a.skipped ? "€0" : `€${a.actualCost.toFixed(2)}`}
                    </td>
                    <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.75rem" }}>
                      {a.skipped
                        ? `Necesita €${a.pricePerShare.toFixed(0)} mín.`
                        : a.reason.split("→")[1]?.trim() ?? a.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid #374151", backgroundColor: "#0f172a" }}>
                  <td colSpan={4} style={{ padding: "0.5rem 0.5rem", color: "#9ca3af", textAlign: "right" }}>
                    Total a desembolsar:
                  </td>
                  <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold", color: "#10b981", fontSize: "1rem" }}>
                    €{smartDCAResult.totalCashToInvest.toFixed(2)}
                  </td>
                  <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.75rem" }}>
                    {smartDCAResult.allocationByAsset.filter(a => a.skipped).length > 0 &&
                      `${smartDCAResult.allocationByAsset.filter(a => a.skipped).length} activo(s) omitidos por lote mínimo`}
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
{/* Motor target weight — dynamic from engine, not hardcoded */}
                    <td>
                      {engineResult
                        ? ((engineResult.allocations.find(a => a.name === asset.name)?.finalAllocation ?? 0) * 100).toFixed(1)
                        : asset.weight
                      }%
                    </td>
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