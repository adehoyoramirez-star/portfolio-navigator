// ═══════════════════════════════════════════════════════════════════════
// HENDE FUND — Institutional Portfolio Dashboard (Olympus Engine V3+)
// AUDIT-CLEAN v4 — Fixes aplicados:
//   FIX-01: Eliminado stub duplicado (líneas 1–58 originales)
//   FIX-02: Todos los imports consolidados al inicio del módulo
//   FIX-03: Guard de historial de régimen corregido (primer render espurio)
//   FIX-04: supabaseClient.ts usa variables de entorno (ver .env.local)
//   FIX-05: Eliminada interfaz Asset/Portfolio duplicada (conflicto factorRole)
// ═══════════════════════════════════════════════════════════════════════

// ── Core React ──────────────────────────────────────────────────────────
import React, { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "./supabaseClient";

// ── UI / charting ────────────────────────────────────────────────────────
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

// ── Core engine & types ──────────────────────────────────────────────────
import { liquidityScore } from "@/core/macro/liquidity";
import { portfolio as initialPortfolio, Asset, Portfolio } from "@/core/types/portfolio";
import { calculateCorrelationMatrix } from "@/core/data/portfolioMetrics";
import { calculateRSI, calculateZScore } from "@/core/data/indicators";
import { runOlympusEngine, AssetInput } from "@/core/engine/olympusV3";
import { fromManualInputs } from "@/core/macro/liquidityCycle";
import { fetchRealMarketData, MarketData } from "@/lib/marketData";
import { ASSETS } from "@/lib/constants";
import BacktestPanel from "@/core/backtest/BacktestPanel";
import { logEngineDecision } from "@/lib/decisionLog";

// ── Persistence & portfolio tools ────────────────────────────────────────
import {
  savePortfolio, loadPortfolio,
  saveMacro, loadMacro,
  saveRegimeEntry, loadRegimeHistory,
  clearAll, RegimeHistoryEntry,
} from "@/core/persistence/portfolioStorage";
import {
  computeRebalanceSuggestions,
  RebalanceAsset,
  RebalanceSuggestion,
} from "@/core/portfolio/rebalancer";
import {
  detectCycleTops,
  isBTCDominanceFalling,
  type CycleTopInputs,
  type CycleTopSignal,
} from "@/core/risk/cycleTopDetector";
import {
  analyzeSpainTax,
  type PortfolioTaxSummary,
  type TaxAnalysis,
} from "@/core/tax/spainTaxAnalysis";
import { generateAlerts, RegimeAlert } from "@/core/alerts/regimeAlerts";
import { computeSmartDCA } from "@/core/dca/smartDCA";
import {
  computeCEWS, loadCEWSHistory, saveCEWSDataPoint, generateSyntheticHistory,
  CEWSDataPoint,
} from "@/core/macro/crisisEarlyWarning";
import {
  computeRegimeDuration,
  detectRegimeStartDate,
} from "@/core/macro/regimeDuration";
import {
  runAllStressScenarios,
  type StressResult,
} from "@/core/simulation/stressScenarios";
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
    const n = multivariate.weights.length;
    const monthlyMus = multivariate.mus.map(m => m / 12);
    const monthlySigmas = multivariate.sigmas.map(s => s / Math.sqrt(12));
    const monthlyCov = multivariate.covMatrix.map(row => row.map(v => v / 12));
    const L = choleskyDecomposition(monthlyCov, n);

    for (let sim = 0; sim < simulations; sim++) {
      const assetValues = multivariate.weights.map((w) => initialCapital * w);
      for (let m = 0; m < months; m++) {
        const z = Array.from({ length: n }, () => randomNormal());
        const correlated = Array.from({ length: n }, (_, i) =>
          L[i].reduce((s, lij, j) => s + lij * z[j], 0)
        );
        for (let i = 0; i < n; i++) {
          assetValues[i] += monthlyContribution * multivariate.weights[i];
          const muI = monthlyMus[i] - 0.5 * monthlySigmas[i] ** 2;
          let jump = 0;
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
function choleskyDecomposition(A: number[][], n: number): number[][] {
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(sum, 1e-10));
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
  const [jumpIntensity, setJumpIntensity] = useState(7.0);
  const [jumpIntensityPortfolio, setJumpIntensityPortfolio] = useState(1.0);
  const [jumpMean, setJumpMean] = useState(-0.08);
  const [jumpStd, setJumpStd] = useState(0.12);

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
  const [liquidityGrowth, setLiquidityGrowth] = useState(3.2);
  const [dxy, setDxy] = useState(99.7);
  const [moveIndex, setMoveIndex] = useState(120);
  const [wtiOil, setWtiOil] = useState<number>(98);
  const [btcVol, setBtcVol] = useState(0.65);
  const [btcDominance, setBtcDominance] = useState(57.0);
  const [mvrvRatio, setMvrvRatio] = useState(1.8);
  const [btcRsiWeekly, setBtcRsiWeekly] = useState<number | undefined>(undefined);
  const [prevBtcDominance, setPrevBtcDominance] = useState<number | undefined>(undefined);

  // PASO 3: Fear & Greed Index — Alternative.me (sin key)
  const [fearGreedIndex, setFearGreedIndex] = useState<{
    value: number;
    label: string;
    source: string;
  } | null>(null);

  // PASO 4: fuente de datos on-chain
  const [onChainSource, setOnChainSource] = useState<"GLASSNODE" | "MANUAL">("MANUAL");

  // BTC Cycle Analyzer inputs (persistidos)
  const [puellMultiple, setPuellMultiple] = useState<number | undefined>(undefined);
  const [hashRibbonState, setHashRibbonState] = useState<"CAPITULATION" | "RECOVERY" | "EXPANSION" | undefined>(undefined);
  const [piCycleMa111, setPiCycleMa111] = useState<number | undefined>(undefined);
  const [piCycleMa350x2, setPiCycleMa350x2] = useState<number | undefined>(undefined);
  const [elliottPivots, setElliottPivots] = useState<ElliottWavePoint[]>([]);
  const [elliottCurrentWave, setElliottCurrentWave] = useState<ElliottWaveLabel | undefined>(undefined);
  const [elliottPivotsText, setElliottPivotsText] = useState<string>("");

  // PASO 6: Motor de Inteligencia AI — Ollama (local, gratuito)
  // Roles: Macro Strategist · Elliott Analyst · Market Sentinel
  const [aiIntelligence, setAiIntelligence] = useState<{
    gemini: { regimeNarrative: string; macroValidation: string; btcCycleSummary: string; model: string; cachedAt: string; error?: string } | null;
    grok:   { marketSentiment: string; topNarratives: string[]; blackSwanAlert: boolean; blackSwanReason: string | null; model: string; cachedAt: string; error?: string } | null;
    claude: { elliottAnalysis: string; rebalanceAdvice: string; contradictionAnalysis: string; model: string; cachedAt: string; error?: string } | null;
    fetchedAt: string;
    cacheHit: boolean;
    ollamaModel?: string;
  } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [ollamaModel, setOllamaModel] = useState<string>('llama3.1:8b');
  const [telegramStatus, setTelegramStatus] = useState<'idle' | 'sending' | 'ok' | 'error'>('idle');
  const [telegramError, setTelegramError] = useState<string>('');
  // Liquidez defensiva acumulada — capital guardado cuando DCA está bloqueado (BLOCK_CRISIS/VOL)
  // Se incrementa automáticamente cada vez que el motor bloquea la aportación mensual.
  // El motor la despliega en Modo Ataque: 10% Tramo1 · 35% Tramo2 · 80% Tramo3.
  const [defensiveLiquidity, setDefensiveLiquidity] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('olympus_defensive_liq') ?? '0') || 0; } catch { return 0; }
  });

  // Señales de techo de ciclo — inputs específicos por activo
  const [uraniumSpot, setUraniumSpot] = useState<number | undefined>(undefined);
  const [uraniumLT, setUraniumLT] = useState<number | undefined>(undefined);
  const [bookToBill, setBookToBill] = useState<number | undefined>(undefined);
  const [inflationBreakeven, setInflationBreakeven] = useState<number | undefined>(undefined);

  const [erpValue, setErpValue] = useState(0.025);
  const [liquidity, setLiquidity] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
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
      const { marketData: md, fetchErrors } = await fetchRealMarketData();
      setMarketData(md);

      if (md.cewsHistory.length > 0) {
        setCewsHistory(md.cewsHistory);
      }

      if (fetchErrors.length > 0) {
        setApiError(`Datos parciales. Sin datos para: ${fetchErrors.join(", ")}`);
      }

      setVix(md.vix);
      setManualBond10y(md.tnx);
      setBond2y(md.irx);

      if (md.dxy > 0) setDxy(parseFloat(md.dxy.toFixed(2)));
      if (md.wtiOil > 0) setWtiOil(parseFloat(md.wtiOil.toFixed(2)));
      if (md.moveIndex && md.moveIndex > 0) setMoveIndex(parseFloat(md.moveIndex.toFixed(1)));
      if (md.creditSpread && md.creditSpread > 0) setCreditSpread(parseFloat(md.creditSpread.toFixed(2)));
      if (md.m2GrowthSource === "FRED") setM2Growth(parseFloat(md.m2Growth.toFixed(2)));
      if (md.perSource === "FRED" && md.per > 0) setManualPER(parseFloat(md.per.toFixed(2)));

      const liq = liquidityScore({
        m2Growth: md.m2GrowthSource === "FRED" ? md.m2Growth : m2Growth,
        vix: md.vix,
        yieldCurveSpread: md.tnx - md.irx
      });
      setLiquidity(liq);

      if (md.sp500Rsi > 0 && md.sp500Rsi !== 50) setRsi(parseFloat(md.sp500Rsi.toFixed(1)));
      if (md.sp500Momentum12m !== 0) {
        setMomentum(parseFloat(Math.max(-1, Math.min(1, md.sp500Momentum12m)).toFixed(4)));
      }
      if (md.btcRsiWeekly > 0 && md.btcRsiWeekly !== 50) {
        setBtcRsiWeekly(parseFloat(md.btcRsiWeekly.toFixed(1)));
      }
      if (md.piCycleMa111 && md.piCycleMa111 > 0) setPiCycleMa111(md.piCycleMa111);
      if (md.piCycleMa350x2 && md.piCycleMa350x2 > 0) setPiCycleMa350x2(md.piCycleMa350x2);
      if (md.inflationBreakeven && md.inflationBreakeven > 0) {
        setInflationBreakeven(md.inflationBreakeven);
      }

      setPortfolio(prev => ({
        ...prev,
        assets: prev.assets.map((asset) => {
          const idx = ASSETS.indexOf(asset.ticker as any);
          if (idx === -1) return { ...asset, price: md.prices[asset.ticker] > 0 ? md.prices[asset.ticker] : asset.price };

          const closes = md.closesHistory[asset.ticker] || [];

          return {
            ...asset,
            price: md.prices[asset.ticker] > 0 ? md.prices[asset.ticker] : asset.price,
            history: closes,
            volatility: (md.realizedVols[idx] ?? asset.volatility / 100) * 100,
            return12m: md.returns12m[idx] ?? asset.return12m,
            return3m:  md.returns3m[idx]  ?? asset.return3m,
            return1m:  md.returns1m[idx]  ?? asset.return1m,
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

      try {
        const { data: cryptoRaw } = await supabase.functions.invoke('crypto-signals');
        if (cryptoRaw && !cryptoRaw.error) {
          if (cryptoRaw.btcDominance > 0) setBtcDominance(parseFloat(cryptoRaw.btcDominance.toFixed(2)));
          if (cryptoRaw.fearGreedValue >= 0) setFearGreedIndex({
            value: cryptoRaw.fearGreedValue,
            label: cryptoRaw.fearGreedLabel,
            source: cryptoRaw.fearGreedSource,
          });
          if (Math.abs(cryptoRaw.btcVol24h) > 0) {
            const impliedAnnualVol = Math.abs(cryptoRaw.btcVol24h / 100) * Math.sqrt(365);
            setBtcVol(prev => parseFloat((prev * 0.70 + impliedAnnualVol * 0.30).toFixed(3)));
          }
        }
      } catch {
        // CoinGecko/Alt.me no críticos
      }

      try {
        const { data: onChainRaw } = await supabase.functions.invoke('glassnode-onchain');
        if (onChainRaw && !onChainRaw.error && onChainRaw.errors?.length < 5) {
          if (onChainRaw.mvrv?.value > 0) setMvrvRatio(parseFloat(onChainRaw.mvrv.value.toFixed(3)));
          if (onChainRaw.puell?.value > 0) setPuellMultiple(parseFloat(onChainRaw.puell.value.toFixed(3)));
          if (onChainRaw.hashRibbonState) setHashRibbonState(onChainRaw.hashRibbonState);
          setOnChainSource("GLASSNODE");
        }
      } catch {
        // Glassnode no crítico
      }

    } catch (error) {
      setApiError("Error al conectar con Supabase/Yahoo Finance. Usando datos locales.");
    } finally {
      setLoading(false);
    }
  };

  // ── PASO 6: Motor de Inteligencia AI — Ollama LOCAL (gratuito, sin API keys) ──
  // Llama directamente a Ollama en localhost:11434 — bypass total de Supabase Edge Functions
  // Prerequisito: ollama debe estar corriendo con CORS habilitado.
  // En Windows PowerShell antes de npm run dev:
  //   $env:OLLAMA_ORIGINS="*"; ollama serve
  // En Mac/Linux:
  //   OLLAMA_ORIGINS="*" ollama serve

  // Caché local para no llamar Ollama en cada render
  const aiCacheRef = React.useRef<{ hash: string; result: any; expiresAt: number } | null>(null);

  const callOllama = async (systemPrompt: string, userContent: string, model: string): Promise<string> => {
    const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2, num_predict: 500 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text: string = json.message?.content ?? '';
    // Limpiar posibles markdown fences
    return text.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, m =>
      m.replace(/```json\n?|```\n?/g, '').trim()
    ).trim();
  };

  // Auto-detectar modelo disponible en Ollama
  const detectOllamaModel = async (): Promise<string> => {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags');
      if (!res.ok) return ollamaModel;
      const json = await res.json();
      const models: string[] = (json.models ?? []).map((m: any) => m.name as string);
      if (models.length === 0) return ollamaModel;
      // Preferencia explícita: llama3.1:8b primero (modelo confirmado disponible),
      // luego los más capaces para análisis financiero
      const preferred = ['llama3.1:8b', 'llama3.1', 'llama3.3', 'llama3.2', 'llama3', 'mistral', 'mixtral', 'qwen2.5', 'deepseek-r1'];
      for (const p of preferred) {
        // Coincidencia exacta primero, luego por prefijo
        const exact = models.find(m => m === p);
        if (exact) return exact;
        const prefix = models.find(m => m.startsWith(p));
        if (prefix) return prefix;
      }
      return models[0]; // usar el primero disponible
    } catch {
      return ollamaModel;
    }
  };

  const refreshAIIntelligence = async () => {
    if (!engineResult) return;
    setAiLoading(true);
    try {
      const contradictions: string[] = [];
      if (dxy > 103 && wtiOil > 90) contradictions.push('DXY alto + Brent alto (señales opuestas)');
      if (vix > 28 && rsi > 65) contradictions.push('VIX pánico + RSI sobrecompra (incoherente)');
      if (creditSpread > 4.5 && manualPER > 26) contradictions.push('Credit spread elevado + PER caro');

      const totalPortfolioVal = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);

      // Hash para caché — si el contexto no cambió, no volvemos a llamar Ollama
      const ctxHash = `${engineResult.regime}-${Math.round(vix)}-${Math.round((mvrvRatio ?? 0) * 100)}-${Math.round((fearGreedIndex?.value ?? 50))}`;
      const now = Date.now();
      const CACHE_TTL = 15 * 60 * 1000; // 15 minutos

      if (aiCacheRef.current && aiCacheRef.current.hash === ctxHash && aiCacheRef.current.expiresAt > now) {
        setAiIntelligence({ ...aiCacheRef.current.result, cacheHit: true });
        setAiLoading(false);
        return;
      }

      // Auto-detectar modelo disponible
      const model = await detectOllamaModel();
      setOllamaModel(model);

      const ts = new Date().toISOString();

      // Contexto compartido para los 3 roles
      const ctx = `FECHA: ${ts.slice(0, 10)}
RÉGIMEN: ${engineResult.regime} | penalty=${((engineResult.masterRegime.regimePenalty ?? 1) * 100).toFixed(0)}% | P(crisis)=${(((engineResult.masterRegime as any).crisisProb ?? 0) * 100).toFixed(0)}%
MACRO: VIX=${vix.toFixed(1)} MOVE=${moveIndex.toFixed(0)} Bond10y=${manualBond10y.toFixed(2)}% Bond2y=${bond2y.toFixed(2)}% CreditSprd=${creditSpread.toFixed(2)}% M2=${m2Growth.toFixed(1)}% DXY=${dxy.toFixed(1)} Brent=$${wtiOil.toFixed(0)}
CRYPTO: BTC=€${(portfolio.assets.find(a => a.ticker === 'BTC-EUR')?.price ?? 0).toFixed(0)} RSI_semanal=${(btcRsiWeekly ?? 50).toFixed(0)} DOM=${(btcDominance ?? 0).toFixed(1)}% MVRV=${(mvrvRatio ?? 0).toFixed(2)} FearGreed=${fearGreedIndex?.value ?? 50}/${fearGreedIndex?.label ?? 'N/D'}
PORTFOLIO: €${totalPortfolioVal.toFixed(0)} vol=${((portfolioVol ?? 0.18) * 100).toFixed(1)}% drawdown=${((portfolioDrawdown ?? 0) * 100).toFixed(1)}% mu=${(Math.min(0.15, expectedReturn) * 100).toFixed(1)}%
ELLIOTT: Onda ${elliottCurrentWave ?? 'N/D'} | Hash Ribbon: ${hashRibbonState ?? 'N/D'} | Puell: ${(puellMultiple ?? 0).toFixed(2)}
${contradictions.length > 0 ? 'CONTRADICCIONES: ' + contradictions.join(' | ') : ''}`.trim();

      // ── ROL 1: Macro Strategist ─────────────────────────────────────────
      const macroPrompt = `Eres estratega macro senior de hedge fund institucional. Analiza el contexto y responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin explicaciones fuera del JSON:
{"regimeNarrative":"<3 frases sobre el régimen macro actual y sus implicaciones para el portfolio>","macroValidation":"<2 frases sobre coherencia entre las señales macro>","btcCycleSummary":"<2 frases sobre la posición actual en el ciclo BTC y qué esperar>"}`;

      // ── ROL 2: Elliott Wave Analyst ─────────────────────────────────────
      const elliottPrompt = `Eres analista técnico especialista en ciclos crypto y Elliott Wave. Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown:
{"elliottAnalysis":"<3 frases sobre la onda actual, dirección y proyección de precio>","rebalanceAdvice":"<2 frases de rebalanceo concreto dado el ciclo>","contradictionAnalysis":"<2 frases sobre señales contradictorias detectadas>"}`;

      // ── ROL 3: Market Sentinel ──────────────────────────────────────────
      const bsAlert = (vix ?? 0) > 35 && (creditSpread ?? 0) > 6 || (mvrvRatio ?? 0) > 7;
      const sentinelPrompt = `Eres analista de riesgo sistémico y vigilante de cisnes negros. Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown:
{"marketSentiment":"<2 frases del sentimiento actual del mercado>","topNarratives":["<narrativa dominante 1>","<narrativa dominante 2>","<narrativa dominante 3>"],"blackSwanAlert":${bsAlert},"blackSwanReason":${bsAlert ? '"<describe el riesgo sistémico detectado>"' : 'null'}}`;

      // Llamar los 3 roles en paralelo
      const [r1, r2, r3] = await Promise.allSettled([
        callOllama(macroPrompt, ctx, model),
        callOllama(elliottPrompt, ctx, model),
        callOllama(sentinelPrompt, ctx, model),
      ]);

      const parseRole = (r: PromiseSettledResult<string>, fallback: object) => {
        if (r.status === 'rejected') return { ...fallback, error: String(r.reason).slice(0, 200), model, cachedAt: ts };
        try {
          // Extraer JSON del texto — Ollama a veces añade texto antes/después
          const match = r.value.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(match ? match[0] : r.value);
          return { ...parsed, model, cachedAt: ts };
        } catch {
          return { ...fallback, error: `JSON parse error: ${r.value.slice(0, 100)}`, model, cachedAt: ts };
        }
      };

      const geminiResult = parseRole(r1, { regimeNarrative: '', macroValidation: '', btcCycleSummary: '' });
      const claudeResult = parseRole(r2, { elliottAnalysis: '', rebalanceAdvice: '', contradictionAnalysis: '' });
      const grokResult   = parseRole(r3, { marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null });

      const output = {
        gemini: geminiResult,
        claude: claudeResult,
        grok: grokResult,
        fetchedAt: ts,
        cacheHit: false,
        ollamaModel: model,
      };

      aiCacheRef.current = { hash: ctxHash, result: output, expiresAt: now + CACHE_TTL };
      setAiIntelligence(output);

      // Alerta Telegram si sentinel detecta cisne negro
      if (grokResult.blackSwanAlert && grokResult.blackSwanReason && !grokResult.error) {
        supabase.functions.invoke('telegram-alerts', {
          body: {
            type: 'black_swan',
            blackSwanReason: grokResult.blackSwanReason,
            currentRegime: engineResult.regime,
            vix,
          },
        }).catch(() => {});
      }

    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      const ts = new Date().toISOString();
      const ollamaDown = errMsg.includes('fetch') || errMsg.includes('ECONNREFUSED') || errMsg.includes('Failed to fetch');
      const errResult = {
        error: ollamaDown
          ? 'Ollama no responde en localhost:11434. Verifica que esté corriendo con: $env:OLLAMA_ORIGINS="*"; ollama serve'
          : errMsg.slice(0, 300),
        model: ollamaModel, cachedAt: ts,
      };
      setAiIntelligence({
        gemini: { regimeNarrative: '', macroValidation: '', btcCycleSummary: '', ...errResult },
        claude: { elliottAnalysis: '', rebalanceAdvice: '', contradictionAnalysis: '', ...errResult },
        grok:   { marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null, ...errResult },
        fetchedAt: ts, cacheHit: false, ollamaModel,
      });
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
      if (savedMacro.jumpIntensity !== undefined) setJumpIntensity(savedMacro.jumpIntensity);
      if (savedMacro.jumpIntensityPortfolio !== undefined) setJumpIntensityPortfolio(savedMacro.jumpIntensityPortfolio);
      else setJumpIntensityPortfolio(1.0);
      if (savedMacro.jumpMean !== undefined) setJumpMean(savedMacro.jumpMean);
      if (savedMacro.jumpStd !== undefined) setJumpStd(savedMacro.jumpStd);
      if (savedMacro.puellMultiple !== undefined) setPuellMultiple(savedMacro.puellMultiple);
      if (savedMacro.hashRibbonState) setHashRibbonState(savedMacro.hashRibbonState as "CAPITULATION" | "RECOVERY" | "EXPANSION");
      if (savedMacro.piCycleMa111 !== undefined) setPiCycleMa111(savedMacro.piCycleMa111);
      if (savedMacro.piCycleMa350x2 !== undefined) setPiCycleMa350x2(savedMacro.piCycleMa350x2);
      if (savedMacro.elliottCurrentWave) setElliottCurrentWave(savedMacro.elliottCurrentWave as ElliottWaveLabel);
      if (savedMacro.elliottPivots && savedMacro.elliottPivots.length > 0) {
        const pts = savedMacro.elliottPivots.map((p: { price: number; dateStr: string; type: string }) => ({
          price: p.price,
          date: new Date(p.dateStr),
          label: p.type,
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
    calculateCorrelationMatrix(portfolio.assets),
    [portfolio.assets]
  );

  const assetInputs: AssetInput[] = useMemo(() => {
    return portfolio.assets.map(asset => ({
      name: asset.name,
      returns12m: asset.return12m ?? 0.01,
      returns3m: asset.return3m ?? 0.01,
      returns1m: asset.return1m ?? 0.01,
      earningsYield: asset.earningsYield ?? 0,
      volatility: asset.volatility / 100,
      sector: asset.sector,
    }));
  }, [portfolio.assets]);

  const yieldSpread = manualBond10y - bond2y;

  const portfolioDrawdown = useMemo(() => {
    if (!marketData) return 0;
    const currentTotal = totalPortfolioValue;
    if (currentTotal <= 0) return 0;
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

  const effectiveCEWSHistory = useMemo(() => {
    if (cewsHistory.length >= 4) return cewsHistory;
    return generateSyntheticHistory(vix, manualBond10y - bond2y, creditSpread, m2Growth, 12);
  }, [cewsHistory, vix, manualBond10y, bond2y, creditSpread, m2Growth]);

  const cewsResult = useMemo(() => computeCEWS(effectiveCEWSHistory), [effectiveCEWSHistory]);

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
        wtiOil,
      },
      covMatrix: marketData?.covMatrix,
      portfolioDrawdown,
      portfolioRealizedVol,
      erpValue,
      liquidityGrowth,
      cewsHistory: effectiveCEWSHistory,
      adaptiveFactorWeights: walkForwardResult?.adaptiveFactorWeights,
    });
  }, [assetInputs, corrMatrix, vix, yieldSpread, creditSpread, m2Growth, moveIndex, dxy, btcVol, wtiOil, erpValue, marketData?.covMatrix, portfolioDrawdown, portfolioRealizedVol, effectiveCEWSHistory, walkForwardResult?.adaptiveFactorWeights]);

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

      // FIX-03: guard corregido — NO guardar historial en el primer render
      // (cuando previousRegimeRef.current === null aún no hay cambio real)
      if (currentRegime !== previousRegimeRef.current && previousRegimeRef.current !== null) {
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
      const totalValue = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);

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
        }).catch(() => {});
      }

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

  const prevCewsLevelRef = React.useRef<import("@/core/macro/crisisEarlyWarning").CEWSLevel>("CLEAR");
  useEffect(() => {
    if (!cewsResult) return;
    if (cewsResult.level !== prevCewsLevelRef.current) {
      setCewsPreviousLevel(prevCewsLevelRef.current);
      prevCewsLevelRef.current = cewsResult.level;
    }
  }, [cewsResult?.level]);

  const regimeDuration = useMemo(() => {
    if (!engineResult) return null;
    const regime = engineResult.regime === "ALL_CASH" ? "CRISIS" : engineResult.regime as "EXPANSION" | "CONTRACTION" | "CRISIS";
    const regimeStartDate = detectRegimeStartDate(
      regimeHistory.map(r => ({ timestamp: r.timestamp, regime: r.regime })),
      regime
    );
    return computeRegimeDuration({ currentRegime: regime, regimeStartDate });
  }, [engineResult?.regime, regimeHistory]);

  const stressResults = useMemo(() => {
    if (!engineResult || totalPortfolioValue === 0) return [];
    const weightedAssets = portfolio.assets.map(a => ({
      ticker: a.ticker,
      name: a.name,
      weight: engineResult.allocations.find(al => al.name === a.name)?.finalAllocation ?? 0,
    }));
    return runAllStressScenarios(weightedAssets, totalPortfolioValue);
  }, [engineResult?.allocations, portfolio.assets, totalPortfolioValue]);

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

  const totalCashForDCA = cashReserve + monthlyInjection;

  const btcAsset = portfolio.assets.find(a => a.ticker === "BTC-EUR");
  const btcRsi = btcAsset?.rsi ?? calculateRSI(btcAsset?.history || [], 14);
  const btcZ = btcAsset?.zScore ?? calculateZScore(btcAsset?.history || [], 200);
  const btcRet1m = btcAsset?.return1m ?? 0;

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
      accumulatedDefensiveLiquidity: defensiveLiquidity,
      motorAllocations: engineResult?.allocations.map(a => {
        const asset = portfolio.assets.find(pa => pa.name === a.name);
        return {
          name: a.name,
          ticker: asset?.ticker ?? a.name,
          finalAllocation: a.finalAllocation,
          price: asset?.price ?? 0,
        };
      }) ?? [],
      cewsOutput: cewsResult ?? undefined,
      cewsPreviousLevel,
    });
  }, [btcRsi, btcZ, btcRet1m, engineResult, cashReserve, monthlyInjection, portfolio.assets, cewsResult, cewsPreviousLevel, defensiveLiquidity]);

  const dcaAction  = smartDCAResult?.action ?? "WATCH";
  const dcaBlocked = dcaAction === "BLOCK_VOL" || dcaAction === "BLOCK_CRISIS" || dcaAction === "BLOCK_TAIL_RISK";
  const availableCash = dcaBlocked ? cashReserve : cashReserve + monthlyInjection;

  // ── AUTO-ACUMULACIÓN DE LIQUIDEZ DEFENSIVA ─────────────────────────────
  // Cuando el motor bloquea el DCA, la aportación mensual se guarda como
  // "pólvora seca" para desplegarse en Modo Ataque (Tramo 1-2-3).
  // El capital se descuenta automáticamente cuando el motor entra en ataque.
  const defensiveLiquidityRef = React.useRef<boolean>(false);
  React.useEffect(() => {
    if (!engineResult) return;
    if (dcaBlocked && monthlyInjection > 0) {
      // Solo acumular una vez por sesión de bloqueo (no en cada render)
      if (!defensiveLiquidityRef.current) {
        defensiveLiquidityRef.current = true;
        setDefensiveLiquidity(prev => {
          const next = Math.round((prev + monthlyInjection) * 100) / 100;
          try { localStorage.setItem('olympus_defensive_liq', String(next)); } catch {}
          return next;
        });
      }
    } else {
      defensiveLiquidityRef.current = false;
      // Cuando el motor despliega en ataque, descontar lo que realmente se invirtió
      if (smartDCAResult.attackMode && smartDCAResult.totalCashToInvest > 0) {
        setDefensiveLiquidity(prev => {
          const deployed = Math.min(prev, smartDCAResult.totalCashToInvest * 0.8);
          const next = Math.max(0, Math.round((prev - deployed) * 100) / 100);
          try { localStorage.setItem('olympus_defensive_liq', String(next)); } catch {}
          return next;
        });
      }
    }
  }, [dcaBlocked, engineResult?.regime]);

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

  const taxAwareRebalance = useMemo(() => {
    if (!rebalanceFinal || !taxAnalysis) return rebalanceFinal;
    const modifiedSells = rebalanceFinal.sellSuggestions.map((sell: RebalanceSuggestion) => {
      const taxInfo = taxAnalysis.analyses.find(t => t.ticker === sell.ticker);
      if (!taxInfo) return sell;
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
  const expectedReturn = useMemo(() => {
    if (!engineResult) return 0.07;
    const regimePenalty = engineResult.masterRegime.regimePenalty ?? 1;

    if (marketData?.expectedReturns && marketData.expectedReturns.length > 0) {
      const weightedJS = ASSETS.reduce((acc, ticker, i) => {
        const alloc = engineResult.allocations.find(
          a => a.name === portfolio.assets.find(p => p.ticker === ticker)?.name
        );
        const w = alloc?.finalAllocation ?? (1 / ASSETS.length);
        const muJS = marketData.expectedReturns[i] ?? 0.08;
        return acc + muJS * w;
      }, 0);
      const capped = Math.min(0.15, Math.max(0.02, weightedJS));
      return capped * regimePenalty;
    }

    const weightedHardcoded = engineResult.allocations.reduce((acc, alloc) => {
      const asset = portfolio.assets.find(a => a.name === alloc.name);
      const r = asset ? (asset.expectedReturn / 100) : 0.10;
      return acc + r * alloc.finalAllocation;
    }, 0);
    const capped = Math.min(0.15, Math.max(0.02, weightedHardcoded));
    return capped * regimePenalty;
  }, [engineResult, portfolio.assets, marketData?.expectedReturns]);

  const portfolioVol = portfolioRealizedVol
    ?? portfolio.assets.reduce(
        (acc, asset) => acc + (asset.volatility / 100) * (asset.price * asset.shares / totalPortfolioValue),
        0
       );

  const jumpSim = useMemo(() => {
    const muCapped = Math.min(0.15, expectedReturn);

    const hasCovMatrix = marketData?.covMatrix && marketData.covMatrix.length > 1;
    const hasEngineAllocs = engineResult && engineResult.allocations.length > 0;

    if (hasCovMatrix && hasEngineAllocs && ASSETS.length > 1) {
      const weights = ASSETS.map(ticker => {
        const alloc = engineResult!.allocations.find(a => a.name === portfolio.assets.find(p => p.ticker === ticker)?.name);
        return alloc?.finalAllocation ?? (1 / ASSETS.length);
      });
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
          jumpIntensityBTC: jumpIntensity,
          jumpMean, jumpStd,
          btcIdx: btcIdx >= 0 ? btcIdx : 0,
        }
      );
    }

    return monteCarloJumpDiffusion(
      totalPortfolioValue, monthlyInjection, muCapped, portfolioVol,
      jumpIntensityPortfolio, jumpMean, jumpStd, years, 5000
    );
  }, [totalPortfolioValue, monthlyInjection, expectedReturn, portfolioVol,
      jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd, years,
      marketData?.covMatrix, marketData?.expectedReturns, engineResult]);

  const { mean: meanValue, median: medianValue, p25, p75, worst5, best95, simulations } = jumpSim;

  const cvarResult = useMemo(() => {
    if (simulations.length === 0) return null;
    const totalInvested = totalPortfolioValue + monthlyInjection * 12 * years;
    const sorted = [...simulations].sort((a, b) => a - b);
    const cutoff95 = Math.max(1, Math.floor(sorted.length * 0.05));
    const cutoff99 = Math.max(1, Math.floor(sorted.length * 0.01));
    const cvar95Abs = sorted.slice(0, cutoff95).reduce((s, v) => s + v, 0) / cutoff95;
    const cvar99Abs = sorted.slice(0, cutoff99).reduce((s, v) => s + v, 0) / cutoff99;
    const loss95 = totalInvested - cvar95Abs;
    const loss99 = totalInvested - cvar99Abs;
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

  const totalGainLoss = portfolio.assets.reduce(
    (sum, asset) => sum + (asset.price - asset.avgPrice) * asset.shares,
    0
  );

  const portfolioAnalytics = useMemo(() => {
    if (!portfolioVol || portfolioVol === 0) return null;
    const rf = (portfolio.riskFreeRate ?? 4) / 100;
    const annualReturn = expectedReturn;
    const excessReturn = annualReturn - rf;
    const sharpe = excessReturn / portfolioVol;
    const downsideVol = portfolioVol / Math.sqrt(2);
    const sortino = downsideVol > 0 ? excessReturn / downsideVol : 0;
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
            setTelegramStatus('sending');
            setTelegramError('');
            try {
              const totalVal = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);
              const { error } = await supabase.functions.invoke('telegram-alerts', {
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
                  aiNarrative: aiIntelligence?.gemini?.regimeNarrative ?? undefined,
                },
              });
              if (error) throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
              setTelegramStatus('ok');
              setTimeout(() => setTelegramStatus('idle'), 4000);
            } catch (e: any) {
              const msg = e?.message ?? String(e);
              setTelegramError(msg.slice(0, 120));
              setTelegramStatus('error');
              setTimeout(() => setTelegramStatus('idle'), 6000);
            }
          }}
          disabled={!engineResult || telegramStatus === 'sending'}
          style={{
            ...styles.button,
            backgroundColor: telegramStatus === 'ok' ? '#059669' : telegramStatus === 'error' ? '#b91c1c' : '#0a7d4f',
            fontSize: '0.8rem',
            opacity: !engineResult ? 0.5 : 1,
          }}
          title="Enviar resumen del portfolio a Telegram"
        >
          {telegramStatus === 'sending' ? '⏳ Enviando...' : telegramStatus === 'ok' ? '✅ Enviado' : telegramStatus === 'error' ? '❌ Error' : '📱 Resumen Telegram'}
        </button>
        {telegramStatus === 'error' && telegramError && (
          <div style={{ color: '#fca5a5', fontSize: '0.72rem', marginTop: '0.25rem', maxWidth: 260 }}>
            ⚠️ {telegramError}
          </div>
        )}

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
              {" · 🦙 "}{aiIntelligence.ollamaModel ?? ollamaModel}
            </span>
          )}
        </span>
      </div>
      {apiError && <div style={{ color: "#ef4444", marginBottom: "10px" }}>{apiError}</div>}

      {/* ── AUDIT-FIX-02: Header de Estado del Motor ── */}
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

          {/* Liquidez */}
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

          {/* Fear & Greed */}
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

          {/* On-Chain */}
          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>ON-CHAIN</div>
            <div style={{ fontSize: "0.75rem", color: onChainSource === "GLASSNODE" ? "#10b981" : "#f59e0b", fontWeight: "bold" }}>
              {onChainSource === "GLASSNODE" ? "✅ Glassnode" : "⚠️ Manual"}
            </div>
            <div style={{ fontSize: "0.62rem", color: "#6b7280" }}>
              {onChainSource === "GLASSNODE" ? "MVRV · Puell · Hash Ribbon auto" : "configurar GLASSNODE_API_KEY"}
            </div>
          </div>

          {/* Fuente datos */}
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

      {/* Inputs macro */}
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
          }} step="0.5" min="0" />
          <p style={{ fontSize: "0.65rem", margin: "0.2rem 0 0", color: wtiOil >= 115 ? "#ef4444" : wtiOil >= 95 ? "#f59e0b" : "#6b7280" }}>
            {wtiOil >= 115 ? "🔴 CRISIS ENERGÉTICA — penalización ×0.50 al motor"
             : wtiOil >= 95  ? "🟠 SHOCK GEOPOLÍTICO — penalización ×0.70 al motor"
             : wtiOil >= 75  ? "🟡 Tensión elevada — penalización ×0.85 al motor"
             : "🟢 Normal — sin penalización por petróleo"}
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

        {/* ── SEÑALES DE TECHO DE CICLO ── */}
        <div style={{ gridColumn: "1 / -1", borderTop: "1px solid #374151", paddingTop: "0.75rem", marginTop: "0.25rem" }}>
          <p style={{ color: "#f59e0b", fontSize: "0.78rem", fontWeight: "bold", marginBottom: "0.5rem" }}>
            ⚠️ Señales de Techo de Ciclo — activar ventas parciales automáticas
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem" }}>
            <div>
              <label style={styles.label}>Uranio Spot $/lb {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>uxc.com</span></label>
              <input type="number" placeholder="—" value={uraniumSpot ?? ""} onChange={e => setUraniumSpot(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" />
            </div>
            <div>
              <label style={styles.label}>Uranio LT $/lb {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>precio largo plazo</span></label>
              <input type="number" placeholder="—" value={uraniumLT ?? ""} onChange={e => setUraniumLT(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" />
            </div>
            <div>
              <label style={styles.label}>Semis Book-to-Bill {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>semi.org mensual</span></label>
              <input type="number" placeholder="—" value={bookToBill ?? ""} onChange={e => setBookToBill(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="3" />
            </div>
            <div>
              <label style={styles.label}>Breakeven Inflación 5y %{" "}
                <span style={{ fontSize: "0.65rem",
                  color: marketData?.inflationBESource === "FRED" ? "#10b981" : "#6b7280",
                  fontWeight: "normal" }}>
                  {marketData?.inflationBESource === "FRED" ? "● FRED auto (T5YIFR)" : "TradingView: T5YIE"}
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
            </div>
          )}
        </div>
      </div>

      {/* AUDIT-FIX-03: Validación cruzada de inputs manuales */}
      {(() => {
        const warnings: { label: string; detail: string; severity: "high" | "medium" }[] = [];
        if (dxy > 103 && wtiOil > 90) {
          warnings.push({ label: "DXY vs Brent inconsistentes", detail: `DXY ${dxy.toFixed(1)} (dólar fuerte) + Brent $${wtiOil.toFixed(0)} (petróleo caro) son señales opuestas.`, severity: "medium" });
        }
        if (vix > 28 && rsi > 65) {
          warnings.push({ label: "VIX vs RSI incoherentes", detail: `VIX ${vix.toFixed(1)} (pánico/miedo) + RSI S&P ${rsi.toFixed(0)} (sobrecompra) son mutuamente excluyentes.`, severity: "high" });
        }
        if (creditSpread > 4.5 && manualPER > 26) {
          warnings.push({ label: "Credit Spread vs PER: riesgo ignorado", detail: `Credit Spread ${creditSpread.toFixed(2)}% + PER ${manualPER.toFixed(1)}x. Los spreads altos históricamente comprimen múltiplos.`, severity: "medium" });
        }
        if (m2Growth < 0 && liquidityGrowth > 5) {
          warnings.push({ label: "M2 negativo vs Liquidez Global positiva", detail: `M2 Growth ${m2Growth.toFixed(1)}% (contracción) + Liquidez Global ${liquidityGrowth.toFixed(1)}% (expansión). Verifica fuentes.`, severity: "medium" });
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

      {/* BTC CYCLE INPUTS */}
      <div style={{ ...styles.card, border: "1px solid #1d4ed8", background: "linear-gradient(135deg, #0c1228 0%, #111827 100%)" }}>
        <h3 style={{ color: "#60a5fa", marginBottom: "0.75rem" }}>🔬 BTC Cycle Analyzer — Inputs Avanzados</h3>
        <p style={{ color: "#6b7280", fontSize: "0.75rem", marginBottom: "1rem" }}>
          Opcionales. Cada campo que rellenes mejora la precisión del análisis de ciclo. Sin datos = SAFE por defecto.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem" }}>
          <div>
            <label style={styles.label}>Puell Multiple{" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>lookintobitcoin.com</span></label>
            <input type="number" placeholder="— ej: 0.8" value={puellMultiple ?? ""}
              onChange={e => setPuellMultiple(e.target.value === "" ? undefined : Number(e.target.value))}
              style={styles.smallInput} step="0.01" min="0" max="10" />
            <p style={{ fontSize: "0.65rem", color: "#6b7280", margin: "0.2rem 0 0" }}>{"<0.5 = mineros en pérdidas → fondo · >2 = euforia mineros → techo"}</p>
          </div>
          <div>
            <label style={styles.label}>Hash Ribbon{" "}
              <span style={{ fontSize: "0.6rem", color: onChainSource === "GLASSNODE" ? "#10b981" : "#6b7280" }}>
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
          </div>
          <div>
            <label style={styles.label}>Pi Cycle — 111 DMA{" "}
              <span style={{ fontSize: "0.65rem", color: marketData?.piCycleMa111 ? "#10b981" : "#6b7280", fontWeight: "normal" }}>
                {marketData?.piCycleMa111 ? "● Yahoo auto (BTC-EUR historial)" : "TradingView: overlay"}
              </span>
            </label>
            <input type="number" placeholder="— ej: 55000" value={piCycleMa111 ?? ""}
              onChange={e => setPiCycleMa111(e.target.value === "" ? undefined : Number(e.target.value))}
              style={styles.smallInput} step="100" min="0" />
          </div>
          <div>
            <label style={styles.label}>Pi Cycle — 350 DMA × 2{" "}
              <span style={{ fontSize: "0.65rem", color: marketData?.piCycleMa350x2 ? "#10b981" : "#6b7280", fontWeight: "normal" }}>
                {marketData?.piCycleMa350x2 ? "● auto" : ""}
              </span>
            </label>
            <input type="number" placeholder="— ej: 120000" value={piCycleMa350x2 ?? ""}
              onChange={e => setPiCycleMa350x2(e.target.value === "" ? undefined : Number(e.target.value))}
              style={styles.smallInput} step="100" min="0" />
          </div>
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
            {elliottPivots.length >= 2 && (
              <p style={{ fontSize: "0.65rem", color: "#10b981", margin: "0.2rem 0 0" }}>
                ✓ {elliottPivots.length} pivotes cargados · Onda detectada automáticamente
              </p>
            )}
          </div>
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
                <p style={{ color: engineResult.masterRegime.stressDetail.wtiShock === "CRISIS" ? "#ef4444" : "#f59e0b", fontSize: "0.78rem", fontWeight: "bold" }}>
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

      {engineResult?.regime === "ALL_CASH" && (
        <div style={{ backgroundColor: "#7f1d1d", border: "1px solid #ef4444", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
          <strong>⚠️ MODO ALL CASH</strong> — Todos los activos tienen retorno esperado negativo según el motor.
          Se recomienda mantener 100% en efectivo hasta que cambien las condiciones.
        </div>
      )}

      {engineResult && (
        <div style={styles.card}>
          <h2>📊 Resultados del Motor Olympus V3 — Nivel 2</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem" }}>
            <div>
              <p><strong>Régimen:</strong> <span style={{ color: engineResult.regime === "CRISIS" || engineResult.regime === "ALL_CASH" ? "#ef4444" : engineResult.regime === "CONTRACTION" ? "#f59e0b" : "#10b981" }}>{engineResult.regime}</span></p>
              <p><strong>Confianza señal:</strong> {engineResult.meta.confidence}</p>
              <p><strong>Señal dominante:</strong> {engineResult.meta.dominantSignal}</p>
              <p><strong>Prob. crisis:</strong> {engineResult.masterRegime.crisisDetail.crisisProbability.toFixed(1)}%</p>
              <p><strong>p(exp/cont/crisis):</strong> {((engineResult.masterRegime.regimeProbs?.expansion ?? 0) * 100).toFixed(0)}% / {((engineResult.masterRegime.regimeProbs?.contraction ?? 0) * 100).toFixed(0)}% / {((engineResult.masterRegime.regimeProbs?.crisis ?? 0) * 100).toFixed(0)}%</p>
              <p><strong>Penalización régimen:</strong> <span style={{ color: "#f59e0b" }}>×{engineResult.masterRegime.regimePenalty.toFixed(3)}</span></p>
              <p><strong>Penalización correlación:</strong> ×{engineResult.correlationPenalty.toFixed(2)}</p>
              <p><strong>Vol Target:</strong> ×{engineResult.volTargetMultiplier.toFixed(2)}</p>
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

      {/* PASO 6: Motor Intelligence AI */}
      {aiIntelligence && (
        <div style={{ ...styles.card, border: "1px solid #4c1d95", background: "linear-gradient(135deg, #0c0a1f 0%, #111827 100%)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ color: "#a78bfa", margin: 0 }}>🧠 Motor Intelligence — Ollama Local</h2>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              {aiIntelligence.cacheHit && (
                <span style={{ fontSize: "0.65rem", color: "#6b7280", background: "#1f2937", padding: "2px 8px", borderRadius: 4 }}>caché</span>
              )}
              <span style={{ fontSize: "0.65rem", color: "#6b7280", background: "#1f2937", padding: "2px 8px", borderRadius: 4 }}>
                🦙 {aiIntelligence.ollamaModel ?? ollamaModel}
              </span>
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
            {/* ROL 1: Macro Strategist */}
            {aiIntelligence.gemini && !aiIntelligence.gemini.error && (
              <div style={{ background: "#0c1228", border: "1px solid #1d4ed8", borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <span>✦</span>
                  <span style={{ color: "#60a5fa", fontWeight: "bold", fontSize: "0.85rem" }}>Macro Strategist</span>
                  <span style={{ fontSize: "0.6rem", color: "#374151", marginLeft: "auto" }}>🦙 {aiIntelligence.gemini.model}</span>
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#3b82f6", fontWeight: "bold", marginBottom: "0.3rem" }}>RÉGIMEN ACTUAL</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#e5e7eb", lineHeight: 1.6 }}>{aiIntelligence.gemini.regimeNarrative}</p>
                </div>
                <div style={{ marginBottom: "0.75rem", borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#3b82f6", fontWeight: "bold", marginBottom: "0.3rem" }}>VALIDACIÓN MACRO</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.gemini.macroValidation}</p>
                </div>
                <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#3b82f6", fontWeight: "bold", marginBottom: "0.3rem" }}>CICLO BTC</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.gemini.btcCycleSummary}</p>
                </div>
              </div>
            )}
            {aiIntelligence.gemini?.error && (
              <div style={{ background: "#1c0a0a", border: "1px solid #374151", borderRadius: 10, padding: "1rem" }}>
                <span style={{ color: "#ef4444", fontSize: "0.8rem" }}>✦ Macro Strategist — Error</span>
                <p style={{ color: "#9ca3af", fontSize: "0.75rem", marginTop: "0.5rem", lineHeight: 1.5 }}>{aiIntelligence.gemini.error}</p>
                {aiIntelligence.gemini.error.includes('Ollama') && (
                  <p style={{ color: "#6b7280", fontSize: "0.7rem", marginTop: "0.5rem", fontFamily: "monospace", background: "#0f172a", padding: "0.5rem", borderRadius: 4 }}>
                    PowerShell: $env:OLLAMA_ORIGINS="*"; ollama serve
                  </p>
                )}
              </div>
            )}

            {/* ROL 3: Market Sentinel */}
            {aiIntelligence.grok && !aiIntelligence.grok.error && (
              <div style={{ background: "#0a0a0a", border: `1px solid ${aiIntelligence.grok.blackSwanAlert ? "#ef4444" : "#374151"}`, borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <span>🛡</span>
                  <span style={{ color: "#d1d5db", fontWeight: "bold", fontSize: "0.85rem" }}>Market Sentinel</span>
                  <span style={{ fontSize: "0.6rem", color: "#374151", marginLeft: "auto" }}>🦙 {aiIntelligence.grok.model}</span>
                </div>
                {aiIntelligence.grok.blackSwanAlert && (
                  <div style={{ background: "#1c0a0a", border: "1px solid #ef4444", borderRadius: 6, padding: "0.5rem 0.75rem", marginBottom: "0.75rem", fontSize: "0.78rem", color: "#ef4444" }}>
                    ⚠️ <strong>ALERTA CISNE NEGRO:</strong> {aiIntelligence.grok.blackSwanReason}
                  </div>
                )}
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#9ca3af", fontWeight: "bold", marginBottom: "0.3rem" }}>SENTIMENT ACTUAL</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#e5e7eb", lineHeight: 1.6 }}>{aiIntelligence.grok.marketSentiment}</p>
                </div>
                <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#9ca3af", fontWeight: "bold", marginBottom: "0.5rem" }}>NARRATIVAS DOMINANTES</div>
                  {(aiIntelligence.grok.topNarratives ?? []).map((n, i) => (
                    <div key={i} style={{ fontSize: "0.78rem", color: "#d1d5db", marginBottom: "0.3rem", display: "flex", gap: "0.5rem" }}>
                      <span style={{ color: "#6b7280", minWidth: "1rem" }}>{i + 1}.</span>
                      <span>{n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(!aiIntelligence.grok || aiIntelligence.grok.error) && !aiIntelligence.gemini?.error && (
              <div style={{ background: "#0a0a0a", border: "1px solid #1f2937", borderRadius: 10, padding: "1rem" }}>
                <span style={{ color: "#4b5563", fontSize: "0.8rem" }}>🛡 Market Sentinel — sin datos</span>
              </div>
            )}

            {/* ROL 2: Elliott Wave Analyst */}
            {aiIntelligence.claude && !aiIntelligence.claude.error && (
              <div style={{ background: "#0d1117", border: "1px solid #d97706", borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  <span>📐</span>
                  <span style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "0.85rem" }}>Elliott Wave Analyst</span>
                  <span style={{ fontSize: "0.6rem", color: "#374151", marginLeft: "auto" }}>🦙 {aiIntelligence.claude.model}</span>
                </div>
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#d97706", fontWeight: "bold", marginBottom: "0.3rem" }}>ELLIOTT WAVE</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#e5e7eb", lineHeight: 1.6 }}>{aiIntelligence.claude.elliottAnalysis}</p>
                </div>
                <div style={{ marginBottom: "0.75rem", borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#d97706", fontWeight: "bold", marginBottom: "0.3rem" }}>REBALANCEO RECOMENDADO</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.claude.rebalanceAdvice}</p>
                </div>
                <div style={{ borderTop: "1px solid #1f2937", paddingTop: "0.6rem" }}>
                  <div style={{ fontSize: "0.65rem", color: "#d97706", fontWeight: "bold", marginBottom: "0.3rem" }}>SEÑALES CONTRADICTORIAS</div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "#d1d5db", lineHeight: 1.6 }}>{aiIntelligence.claude.contradictionAnalysis}</p>
                </div>
              </div>
            )}
            {(!aiIntelligence.claude || aiIntelligence.claude.error) && !aiIntelligence.gemini?.error && (
              <div style={{ background: "#0d1117", border: "1px solid #1f2937", borderRadius: 10, padding: "1rem" }}>
                <span style={{ color: "#4b5563", fontSize: "0.8rem" }}>📐 Elliott Wave Analyst — sin datos</span>
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

      {/* ANALYTICS: SHARPE / SORTINO / DRAWDOWN */}
      {portfolioAnalytics && (
        <div style={styles.card}>
          <h2>📊 Portfolio Analytics</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem" }}>
            <div style={{ background: portfolioAnalytics.sharpe >= 1 ? "#065f46" : portfolioAnalytics.sharpe >= 0.5 ? "#1e3a5f" : portfolioAnalytics.sharpe >= 0 ? "#78350f" : "#7f1d1d", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Sharpe Ratio</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{portfolioAnalytics.sharpe.toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>{portfolioAnalytics.sharpe >= 1 ? "Excelente" : portfolioAnalytics.sharpe >= 0.5 ? "Aceptable" : portfolioAnalytics.sharpe >= 0 ? "Bajo" : "Negativo"}</div>
            </div>
            <div style={{ background: portfolioAnalytics.sortino >= 1.5 ? "#065f46" : portfolioAnalytics.sortino >= 0.8 ? "#1e3a5f" : portfolioAnalytics.sortino >= 0 ? "#78350f" : "#7f1d1d", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Sortino Ratio</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{portfolioAnalytics.sortino.toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>Penaliza solo vol bajista</div>
            </div>
            <div style={{ background: portfolioAnalytics.calmar >= 0.5 ? "#065f46" : portfolioAnalytics.calmar >= 0.2 ? "#1e3a5f" : "#78350f", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Calmar Ratio</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{portfolioAnalytics.calmar.toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>CAGR / Max Drawdown</div>
            </div>
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Vol Portfolio (σ_p)</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: portfolioAnalytics.portfolioVol > 0.25 ? "#ef4444" : portfolioAnalytics.portfolioVol > 0.15 ? "#f59e0b" : "#10b981" }}>
                {(portfolioAnalytics.portfolioVol * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>{marketData?.covMatrix ? "covMatrix real ✅" : "aprox. (sin covMatrix)"}</div>
            </div>
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Drawdown Actual</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: portfolioDrawdown < -0.2 ? "#ef4444" : portfolioDrawdown < -0.1 ? "#f59e0b" : "#10b981" }}>
                {(portfolioDrawdown * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>vs peak histórico</div>
            </div>
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Retorno Esp. (ajust. régimen)</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: expectedReturn >= 0.08 ? "#10b981" : expectedReturn >= 0.03 ? "#f59e0b" : "#ef4444" }}>
                {(expectedReturn * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>×{(engineResult?.masterRegime.regimePenalty ?? 1).toFixed(2)} penalty régimen</div>
            </div>
          </div>
          <p style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.75rem" }}>
            Sharpe = (r_portfolio − r_f) / σ_p · r_f = {(portfolioAnalytics.rf * 100).toFixed(1)}% · Sortino penaliza solo vol bajista · Calmar = retorno anualizado / |max drawdown|
          </p>
        </div>
      )}

      {/* Simulación Monte Carlo */}
      <div style={styles.card}>
        <h2>Distribución de valores finales (Monte Carlo con Jump Diffusion)</h2>
        <div style={{ marginBottom: "1rem" }}>
          <label htmlFor="years" style={styles.label}>Años de simulación:</label>
          <input id="years" name="years" type="number" value={years} onChange={(e) => setYears(Number(e.target.value))} style={styles.smallInput} min="1" max="50" step="1" />
        </div>

        <div style={{ background: "#0c1228", border: "1px solid #3b82f6", borderRadius: 6, padding: "0.6rem 1rem", marginBottom: "1rem", fontSize: "0.78rem" }}>
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <span style={{ color: "#60a5fa", fontWeight: "bold" }}>μ efectivo: </span>
              <span style={{ color: "#e5e7eb", fontWeight: "bold", fontSize: "1rem" }}>{(Math.min(0.15, expectedReturn) * 100).toFixed(2)}%</span>
              <span style={{ color: "#6b7280" }}> anual</span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Fuente: </span>
              <span style={{ color: marketData?.expectedReturns?.length ? "#10b981" : "#f59e0b", fontWeight: "bold" }}>
                {marketData?.expectedReturns?.length ? "✅ James-Stein (Yahoo + shrinkage φ=0.65)" : "⚠️ Hardcoded portfolio.ts (sin datos Yahoo)"}
              </span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Régimen: </span>
              <span style={{ color: "#f59e0b" }}>{engineResult?.regime ?? "—"} ×{(engineResult?.masterRegime.regimePenalty ?? 1).toFixed(3)}</span>
            </div>
            <div>
              <span style={{ color: "#9ca3af" }}>Modo: </span>
              <span style={{ color: marketData?.covMatrix?.length ? "#10b981" : "#f59e0b" }}>
                {marketData?.covMatrix?.length ? "Multivariante Cholesky" : "Univariante (λ_p=" + jumpIntensityPortfolio.toFixed(1) + "/año)"}
              </span>
            </div>
          </div>
          <div style={{ marginTop: "0.3rem", color: "#4b5563", fontSize: "0.7rem" }}>
            Priors LP (Damodaran 2024): BTC 15% · Semis 14% · MSCI Quality 11% · Uranio 10% · EM 8% · Gold 6% · NASDAQ 100 9% — shrinkage 65% hacia prior, 35% histórico Yahoo.
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          <div style={{ background: "#0f172a", border: "2px solid #6366f1", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#818cf8", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.2rem" }}>MEDIANA (resultado más probable)</div>
            <div style={{ color: "#e5e7eb", fontSize: "1.3rem", fontWeight: "bold" }}>{formatCurrency(medianValue)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>50% de simulaciones por encima</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>RANGO CENTRAL (P25–P75)</div>
            <div style={{ color: "#10b981", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p25)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>— a —</div>
            <div style={{ color: "#10b981", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p75)}</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>MEDIA (sesgada al alza)</div>
            <div style={{ color: "#d1d5db", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(meanValue)}</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>PEOR 5% (cola bajista)</div>
            <div style={{ color: "#ef4444", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(worst5)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>VaR 95%</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>MEJOR 5% (cola alcista)</div>
            <div style={{ color: "#f59e0b", fontSize: "1.1rem", fontWeight: "bold" }}>{formatCurrency(best95)}</div>
          </div>
          <div style={{ background: "#1f2937", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ color: "#9ca3af", fontSize: "0.72rem", marginBottom: "0.2rem" }}>PROB. OBJETIVO</div>
            <div style={{ color: probability >= 50 ? "#10b981" : probability >= 25 ? "#f59e0b" : "#ef4444", fontSize: "1.3rem", fontWeight: "bold" }}>{probability.toFixed(1)}%</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>Alcanzar {formatCurrency(target)}</div>
          </div>
        </div>

        <div style={{ background: "#111827", borderRadius: 6, padding: "0.5rem 1rem", marginBottom: "1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
          Capital total invertido en {years} años:{" "}
          <strong style={{ color: "#d1d5db" }}>{formatCurrency(totalPortfolioValue + monthlyInjection * years * 12)}</strong>
          {" · "}Multiplicador mediana:{" "}
          <strong style={{ color: "#6366f1" }}>{(medianValue / (totalPortfolioValue + monthlyInjection * years * 12)).toFixed(1)}x</strong>
        </div>

        <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {cvarResult && (
            <div style={{ borderLeft: "2px solid #f59e0b", paddingLeft: "0.75rem", marginBottom: "0.75rem" }}>
              <p style={{ margin: 0 }}>
                <strong>CVaR 95% — valor esperado peor 5%:</strong>{" "}
                <span style={{ color: "#f59e0b" }}>{formatCurrency(cvarResult.cvar95Abs)}</span>
              </p>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#9ca3af" }}>
                Pérdida esperada vs capital invertido:{" "}
                <span style={{ color: cvarResult.loss95 > 0 ? "#ef4444" : "#10b981" }}>
                  {cvarResult.loss95 > 0 ? "−" : "+"}{formatCurrency(Math.abs(cvarResult.loss95))}
                </span>
                {" · "}Tail ratio: {cvarResult.tailRatio.toFixed(2)}x
              </p>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#ef4444" }}>
                CVaR 99%: {formatCurrency(cvarResult.cvar99Abs)}{" · "}Estándar Basel III/IV
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
      <div style={{ ...styles.card, display: "flex", gap: "2rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <label htmlFor="cashReserve" style={styles.label}>Caja de reserva (€)</label>
          <input id="cashReserve" name="cashReserve" type="number" value={cashReserve}
            onChange={(e) => setCashReserve(Number(e.target.value))} style={styles.input} />
          <p style={{ fontSize: "0.7rem", color: "#6b7280", marginTop: "3px", maxWidth: "140px" }}>
            Cash disponible para DCA ahora mismo
          </p>
        </div>
        <div>
          <label htmlFor="monthlyInjection" style={styles.label}>Aportación mensual (€)</label>
          <input id="monthlyInjection" name="monthlyInjection" type="number" value={monthlyInjection}
            onChange={(e) => setMonthlyInjection(Number(e.target.value))} style={styles.input} />
          <p style={{ fontSize: "0.7rem", color: "#6b7280", marginTop: "3px", maxWidth: "140px" }}>
            Lo que aportas cada mes al portfolio
          </p>
        </div>
        <div style={{ borderLeft: "2px solid #16a34a", paddingLeft: "1rem" }}>
          <label htmlFor="defensiveLiqInput" style={{ ...styles.label, color: "#4ade80" }}>
            💰 Liquidez defensiva acumulada (€)
          </label>
          <input
            id="defensiveLiqInput"
            name="defensiveLiqInput"
            type="number"
            value={defensiveLiquidity}
            min={0}
            step={50}
            onChange={(e) => {
              const val = Math.max(0, Number(e.target.value));
              setDefensiveLiquidity(val);
              try { localStorage.setItem('olympus_defensive_liq', String(val)); } catch {}
            }}
            style={{ ...styles.input, borderColor: "#16a34a", backgroundColor: "#052e16" }}
          />
          <p style={{ fontSize: "0.7rem", color: "#4ade80", marginTop: "3px", maxWidth: "160px" }}>
            Cash guardado durante meses de bloqueo DCA. Para ti ahora: <strong>1.500€</strong> para el ataque de oct 2026.
          </p>
          {defensiveLiquidity > 0 && (
            <div style={{ marginTop: "6px", fontSize: "0.7rem", color: "#86efac" }}>
              Tramo 2 desplegará: <strong>€{Math.round(defensiveLiquidity * 0.35).toLocaleString("es-ES")}</strong>
              {" · "}Tramo 3: <strong>€{Math.round(defensiveLiquidity * 0.80).toLocaleString("es-ES")}</strong>
            </div>
          )}
        </div>
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

      {/* CEWS */}
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
            backgroundColor: cewsResult.level === "ALERT" ? "#7f1d1d" : cewsResult.level === "WARNING" ? "#78350f" : cewsResult.level === "WATCH" ? "#1e3a5f" : "#065f46",
            color: "#fff",
          }}>
            {cewsResult.level} · Score {cewsResult.score}/12
          </div>
        </div>
        {cewsResult.earlyWarningActive && (
          <div style={{ backgroundColor: "#7f1d1d", border: "1px solid #ef4444", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem" }}>
            <p style={{ fontWeight: "bold", color: "#fca5a5", marginBottom: "0.25rem" }}>🚨 ALERTA TEMPRANA ACTIVA</p>
            <p style={{ color: "#fecaca", fontSize: "0.85rem" }}>{cewsResult.earlyWarningReason}</p>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
          {Object.values(cewsResult.signals).map(signal => (
            <div key={signal.name} style={{
              backgroundColor: signal.level === "ALERT" ? "#450a0a" : signal.level === "WARNING" ? "#422006" : signal.level === "WATCH" ? "#172554" : "#111827",
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
        <div style={{ backgroundColor: "#111827", borderRadius: 6, padding: "0.75rem 1rem", marginBottom: "0.75rem" }}>
          <p style={{ fontSize: "0.85rem", color: "#d1d5db" }}>
            <strong style={{ color: "#f9fafb" }}>Recomendación: </strong>{cewsResult.recommendation}
          </p>
        </div>
        <p style={{ fontSize: "0.72rem", color: "#4b5563" }}>
          {cewsHistory.length >= 4
            ? `Basado en ${cewsHistory.length} puntos reales · ${cewsResult.weeksInWarning} semanas en zona de alerta`
            : `Datos sintéticos (${effectiveCEWSHistory.length} puntos simulados)`}
        </p>
      </div>

      {/* Regime Duration */}
      {regimeDuration && (
        <div style={{ ...styles.card, border: regimeDuration.maturityPhase === "OLD" ? "2px solid #f59e0b" : "1px solid #374151" }}>
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
          <p style={{ fontSize: "0.82rem", color: "#d1d5db", margin: 0 }}>{regimeDuration.signal}</p>
        </div>
      )}

      {/* Stress Scenarios */}
      {stressResults.length > 0 && (
        <div style={styles.card}>
          <h2>🔥 Stress Testing — Escenarios Históricos</h2>
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
                  €{Math.abs(s.portfolioDrawdown).toFixed(0)} {s.portfolioDrawdown < 0 ? "pérdida" : "ganancia"}{" · "}{s.recoveryEstimateMonths}m recuperación
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Walk-Forward */}
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
              <span style={{
                padding: "0.3rem 0.8rem", borderRadius: 20, fontSize: "0.8rem", fontWeight: "bold",
                backgroundColor: walkForwardResult.overfittingRisk === "LOW" ? "#065f46" : walkForwardResult.overfittingRisk === "HIGH" ? "#7f1d1d" : "#1e3a5f",
                color: "#fff"
              }}>
                Overfitting: {walkForwardResult.overfittingRisk}
              </span>
            </div>
          </div>
          <p style={{ fontSize: "0.82rem", color: "#d1d5db", margin: 0 }}>{walkForwardResult.recommendation}</p>
        </div>
      )}

      {/* Historial de régimen */}
      {regimeHistory.length > 0 && (
        <div style={styles.card}>
          <h2>📋 Historial de Régimen</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.5rem" }}>
            {regimeHistory.slice(0, 6).map((entry, i) => (
              <div key={i} style={{ backgroundColor: "#1f2937", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.8rem" }}>
                <p style={{ color: entry.regime === "CRISIS" ? "#ef4444" : entry.regime === "CONTRACTION" ? "#f59e0b" : "#10b981", fontWeight: "bold" }}>{entry.regime}</p>
                <p style={{ color: "#9ca3af" }}>VIX: {entry.vix.toFixed(0)} · ×{entry.regimePenalty.toFixed(2)}</p>
                <p style={{ color: "#6b7280" }}>{new Date(entry.timestamp).toLocaleDateString("es-ES")}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* BTC CYCLE ANALYZER */}
      {btcCycleResult && (() => {
        const c = btcCycleResult;
        const pl = c.powerLaw;
        const hv = c.halvingPhase;
        const ew = c.elliottWave;
        const btcPrice = portfolio.assets.find(a => a.ticker === "BTC-EUR")?.price ?? 0;
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
          "1":"#10b981","3":"#10b981","5":"#f59e0b","2":"#6b7280","4":"#6b7280","A":"#ef4444","B":"#f59e0b","C":"#ef4444","UNKNOWN":"#6b7280"
        };
        const waveColor = waveColors[ew.currentWave] ?? "#6b7280";

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
            <div style={{ background: "rgba(99,102,241,0.08)", border: "1px solid #312e81", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "1rem" }}>
              <p style={{ color: "#c7d2fe", fontSize: "0.82rem", margin: 0, lineHeight: 1.6 }}>{c.summary}</p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
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
                    ? `${(discountFromFair * 100).toFixed(0)}% por debajo del valor justo`
                    : `${(Math.abs(discountFromFair) * 100).toFixed(0)}% por encima del valor justo`}
                </div>
                <div style={{ marginTop: "0.5rem", borderTop: "1px solid #1f2937", paddingTop: "0.4rem" }}>
                  <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>Proyección Power Law:</div>
                  <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>6m: <span style={{ color: "#d1d5db" }}>€{plFair6m.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span></div>
                  <div style={{ fontSize: "0.72rem", color: "#9ca3af" }}>12m: <span style={{ color: "#d1d5db" }}>€{plLower12m.toLocaleString("es-ES", { maximumFractionDigits: 0 })} – €{plUpper12m.toLocaleString("es-ES", { maximumFractionDigits: 0 })}</span></div>
                </div>
              </div>
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.75rem" }}>
                <div style={{ color: "#f59e0b", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>⛏ HALVING CYCLE</div>
                <div style={{ fontSize: "0.82rem", color: "#e5e7eb", marginBottom: "0.3rem" }}>
                  Fase: <strong style={{ color: "#f59e0b" }}>{hv.phase.replace(/_/g, " ")}</strong>
                </div>
                <div style={{ fontSize: "0.75rem", color: "#9ca3af", lineHeight: 1.5 }}>{hv.phaseDescription}</div>
                <div style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "0.4rem" }}>
                  {hv.daysSinceHalving > 0
                    ? `${hv.daysSinceHalving} días desde el halving`
                    : `${Math.abs(hv.daysSinceHalving)} días para el próximo halving`}
                </div>
              </div>
              <div style={{ background: "#0f172a", borderRadius: 8, padding: "0.75rem" }}>
                <div style={{ color: "#10b981", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>⚡ ON-CHAIN SIGNALS</div>
                <div style={{ marginBottom: "0.5rem" }}>
                  <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Puell Multiple:</div>
                  <div style={{ fontSize: "0.78rem", color: c.puellMultiple.zone === "CAPITULATION" ? "#10b981" : c.puellMultiple.zone === "EUPHORIA" ? "#ef4444" : "#f59e0b" }}>
                    {c.puellMultiple.value === null ? "Sin dato — introduce el valor en los inputs" : c.puellMultiple.description}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Hash Ribbon:</div>
                  <div style={{ fontSize: "0.78rem", color: c.hashRibbon.buySignalActive ? "#10b981" : c.hashRibbon.state === "CAPITULATION" ? "#ef4444" : "#d1d5db" }}>
                    {c.hashRibbon.state === "UNKNOWN" ? "Sin dato — selecciona estado en los inputs" : c.hashRibbon.description}
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
                    <div style={{ fontSize: "0.78rem", color: "#e5e7eb", fontWeight: "bold" }}>Onda {ew.currentWave}</div>
                    <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>Dirección: {ew.currentWaveDirection} · Confianza: {ew.confidence}</div>
                  </div>
                </div>
                {ew.invalidationLevel && (
                  <div style={{ fontSize: "0.72rem", color: "#ef4444", marginTop: "0.3rem" }}>
                    🛑 Invalidación: &lt;€{ew.invalidationLevel.toLocaleString("es-ES", { maximumFractionDigits: 0 })}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* CYCLE TOP */}
      {cycleTopResult.hasActiveWarnings && (
        <div style={{ ...styles.card, border: "1px solid #d97706", background: "linear-gradient(135deg, #1c1107 0%, #111827 100%)" }}>
          <h2 style={{ color: "#f59e0b", marginBottom: "0.75rem" }}>⚠️ Señales de Techo de Ciclo Activas</h2>
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

      {/* PANEL FISCAL */}
      {taxAnalysis && taxAnalysis.analyses.length > 0 && (
        <div style={{ ...styles.card, border: "1px solid #6366f1", background: "linear-gradient(135deg, #0f0a1e 0%, #111827 100%)" }}>
          <h2 style={{ color: "#818cf8", marginBottom: "0.5rem" }}>🧾 Análisis Fiscal — IRPF España 2025</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
            <div style={{ background: "#1f2937", borderRadius: 6, padding: "0.6rem 1rem" }}>
              <div style={{ color: "#9ca3af", fontSize: "0.75rem" }}>Plusvalías latentes</div>
              <div style={{ color: "#10b981", fontWeight: "bold", fontSize: "1.1rem" }}>+€{taxAnalysis.totalLatentGains.toFixed(0)}</div>
            </div>
            <div style={{ background: "#1f2937", borderRadius: 6, padding: "0.6rem 1rem" }}>
              <div style={{ color: "#9ca3af", fontSize: "0.75rem" }}>Minusvalías latentes</div>
              <div style={{ color: "#ef4444", fontWeight: "bold", fontSize: "1.1rem" }}>−€{taxAnalysis.totalLatentLosses.toFixed(0)}</div>
            </div>
          </div>
          <p style={{ color: "#4b5563", fontSize: "0.72rem", marginTop: "0.75rem" }}>
            ⚠️ Cálculo orientativo. Consulta con un asesor fiscal antes de ejecutar ventas significativas.
          </p>
        </div>
      )}

      {/* REBALANCEO */}
      {taxAwareRebalance && (taxAwareRebalance.suggestions.length > 0) && (
        <div style={styles.card}>
          <h2>⚖️ Rebalanceo — Motor Olympus</h2>
          {dcaBlocked && (
            <div style={{ background: '#7f1d1d', border: '1px solid #ef4444', borderRadius: '6px', padding: '0.6rem 1rem', marginBottom: '0.75rem', fontSize: '0.85rem', color: '#fca5a5' }}>
              <div>⛔ DCA {dcaAction} — La aportación mensual de €{monthlyInjection.toFixed(0)} está congelada como liquidez defensiva.</div>
              <div style={{ marginTop: '0.4rem', color: '#fde68a', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span>💰 Acumulado: <strong>€{defensiveLiquidity.toFixed(0)}</strong></span>
                <span style={{ color: '#9ca3af' }}>·</span>
                <span>Objetivo Tramo 2: <strong>€{(monthlyInjection * 2).toFixed(0)}–€{(monthlyInjection * 3).toFixed(0)}</strong></span>
                {defensiveLiquidity > 0 && (
                  <button
                    onClick={() => { setDefensiveLiquidity(0); try { localStorage.removeItem('olympus_defensive_liq'); } catch {} }}
                    style={{ marginLeft: 'auto', fontSize: '0.7rem', padding: '0.1rem 0.5rem', background: '#450a0a', border: '1px solid #ef4444', borderRadius: 4, color: '#fca5a5', cursor: 'pointer' }}
                  >Resetear</button>
                )}
              </div>
              {defensiveLiquidity >= monthlyInjection && (
                <div style={{ marginTop: '0.3rem', color: '#86efac', fontSize: '0.75rem' }}>
                  ✅ {Math.floor(defensiveLiquidity / monthlyInjection)} mes(es) acumulado(s) — {defensiveLiquidity >= monthlyInjection * 2 ? 'Listo para Tramo 2 cuando el motor cambie a ATAQUE' : 'Acumulando para Tramo 2'}
                </div>
              )}
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
                  <tr key={s.ticker} style={{ borderBottom: "1px solid #1f2937", background: s.action === "SELL" ? "rgba(239,68,68,0.07)" : "transparent" }}>
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
                        : <span style={{ color: "#10b981" }}>+{s.sharesToBuy}</span>}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      {s.action === "SELL"
                        ? <span style={{ color: "#f59e0b" }}>+€{s.proceedsIfSold.toFixed(0)}</span>
                        : <span style={{ color: "#10b981" }}>−€{s.cost.toFixed(0)}</span>}
                    </td>
                    <td style={{ padding: "0.5rem", fontSize: "0.78rem" }}>
                      <span style={{
                        backgroundColor: s.priority === "HIGH" ? "#7f1d1d" : s.priority === "MEDIUM" ? "#78350f" : "#1f2937",
                        color: s.priority === "HIGH" ? "#ef4444" : s.priority === "MEDIUM" ? "#f59e0b" : "#9ca3af",
                        padding: "0.1rem 0.4rem", borderRadius: 4, marginRight: "0.3rem",
                      }}>{s.priority}</span>
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

      {/* Modo Ataque */}
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
              backgroundColor: smartDCAResult.attackConfluence >= 4 ? "#14532d" : smartDCAResult.attackConfluence >= 3 ? "#065f46" : smartDCAResult.attackConfluence >= 2 ? "#1e3a5f" : "#374151",
              color: "#fff",
            }}>
              {smartDCAResult.attackConfluence}/7 señales · Tramo {smartDCAResult.attackTranche || "—"}
              {smartDCAResult.attackMultiplier > 1 && ` · ×${smartDCAResult.attackMultiplier} DCA`}
              {smartDCAResult.action === "BTC_CYCLE_OVERRIDE" && " · ⚡ OVERRIDE"}
            </div>
          </div>
          {/* Indicador de progreso hacia BTC_CYCLE_OVERRIDE */}
          <div style={{ marginBottom: "0.75rem", padding: "0.5rem 0.75rem", borderRadius: 8, backgroundColor: "#0f172a", border: "1px solid #1e3a5f", fontSize: "0.75rem", color: "#6b7280" }}>
            <span style={{ color: "#60a5fa" }}>⚡ Motor B (BTC Ciclo): </span>
            {smartDCAResult.attackConfluence >= 4
              ? <span style={{ color: "#22c55e", fontWeight: "bold" }}>ACTIVO — {smartDCAResult.attackConfluence}/7 señales superan umbral de override</span>
              : <span>Necesita {4 - smartDCAResult.attackConfluence} señal(es) más para BTC_CYCLE_OVERRIDE (actúa en CRISIS macro si ≥4/7)</span>
            }
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem", marginBottom: "1rem" }}>
            {smartDCAResult.attackSignals.map(signal => (
              <div key={signal.name} style={{
                backgroundColor: signal.active ? "#052e16" : "#111827",
                border: `1px solid ${signal.active ? "#22c55e" : "#374151"}`,
                borderRadius: 8, padding: "0.65rem",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
                  <span>{signal.active ? "✅" : "⏳"}</span>
                  <span style={{ fontSize: "0.75rem", fontWeight: "bold", color: signal.active ? "#86efac" : "#6b7280" }}>{signal.name}</span>
                </div>
                <p style={{ fontSize: "0.7rem", color: signal.active ? "#bbf7d0" : "#4b5563", margin: 0 }}>{signal.description}</p>
              </div>
            ))}
          </div>
          {/* BTC_CYCLE_OVERRIDE — display específico */}
          {smartDCAResult.action === "BTC_CYCLE_OVERRIDE" && (
            <div style={{ backgroundColor: "#0c1a0a", border: "2px solid #16a34a", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "0.5rem" }}>
              <p style={{ fontWeight: "bold", color: "#4ade80", marginBottom: "0.25rem" }}>
                ⚡ BTC CYCLE OVERRIDE — Motor B activo en CRISIS macro
              </p>
              <p style={{ color: "#bbf7d0", fontSize: "0.85rem", margin: 0 }}>{smartDCAResult.reasoning}</p>
            </div>
          )}
          {smartDCAResult.attackMode && smartDCAResult.action !== "BTC_CYCLE_OVERRIDE" && (
            <div style={{ backgroundColor: "#052e16", border: "1px solid #22c55e", borderRadius: 8, padding: "0.75rem 1rem" }}>
              <p style={{ fontWeight: "bold", color: "#86efac", marginBottom: "0.25rem" }}>
                {smartDCAResult.action === "ATTACK_MAX" ? "🚀 ATAQUE MÁXIMO" : smartDCAResult.action === "ATTACK_STRONG" ? "⚔️ ATAQUE FUERTE" : "🎯 ATAQUE ENTRADA"}
              </p>
              <p style={{ color: "#d1fae5", fontSize: "0.85rem", margin: 0 }}>{smartDCAResult.reasoning}</p>
            </div>
          )}
        </div>
      )}

      {/* SmartDCA por activo */}
      {smartDCAResult.totalCashToInvest > 0 && smartDCAResult.allocationByAsset.length > 0 && (
        <div style={styles.card}>
          <h2>💸 SmartDCA — Distribución por Motor (Nivel 4)</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: "0.75rem" }}>{smartDCAResult.reasoning}</p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #374151", color: "#6b7280" }}>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Activo</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Peso motor</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Participaciones</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Precio</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem" }}>Coste real</th>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem" }}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {smartDCAResult.allocationByAsset.map(a => (
                  <tr key={a.ticker} style={{ borderBottom: "1px solid #1f2937", opacity: a.skipped ? 0.45 : 1 }}>
                    <td style={{ padding: "0.5rem", fontWeight: "bold", color: a.skipped ? "#6b7280" : "#f9fafb" }}>
                      {a.ticker}
                      {a.isFractional && <span style={{ fontSize: "0.7rem", color: "#6366f1", marginLeft: 4 }}>FRAC</span>}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6366f1" }}>{(a.motorWeight * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold", color: a.skipped ? "#ef4444" : "#f9fafb" }}>
                      {a.skipped ? "—" : a.isFractional ? a.shares.toFixed(6) : `${a.shares}×`}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#9ca3af" }}>€{a.pricePerShare.toFixed(2)}</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: a.skipped ? "#6b7280" : "#10b981", fontWeight: a.skipped ? "normal" : "bold" }}>
                      {a.skipped ? "€0" : `€${a.actualCost.toFixed(2)}`}
                    </td>
                    <td style={{ padding: "0.5rem", color: "#6b7280", fontSize: "0.75rem" }}>
                      {a.skipped ? `Necesita €${a.pricePerShare.toFixed(0)} mín.` : a.reason.split("→")[1]?.trim() ?? a.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid #374151", backgroundColor: "#0f172a" }}>
                  <td colSpan={4} style={{ padding: "0.5rem", color: "#9ca3af", textAlign: "right" }}>Total a desembolsar:</td>
                  <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold", color: "#10b981", fontSize: "1rem" }}>€{smartDCAResult.totalCashToInvest.toFixed(2)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

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
                      <input id={`earnings-${asset.ticker}`} name={`earnings-${asset.ticker}`} type="number"
                        value={asset.earningsYield ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "earningsYield", Number(e.target.value))}
                        style={styles.smallInput} step="0.01" min="0" max="0.5"
                        aria-label={`Earnings Yield de ${asset.name}`} />
                    </td>
                    <td>
                      <input id={`return12m-${asset.ticker}`} name={`return12m-${asset.ticker}`} type="number"
                        value={asset.return12m ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "return12m", Number(e.target.value))}
                        style={styles.smallInput} step="0.01" min="-1" max="5"
                        aria-label={`Retorno 12m de ${asset.name}`} />
                    </td>
                    <td>
                      <input id={`return3m-${asset.ticker}`} name={`return3m-${asset.ticker}`} type="number"
                        value={asset.return3m ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "return3m", Number(e.target.value))}
                        style={styles.smallInput} step="0.01" min="-1" max="2"
                        aria-label={`Retorno 3m de ${asset.name}`} />
                    </td>
                    <td>
                      <input id={`return1m-${asset.ticker}`} name={`return1m-${asset.ticker}`} type="number"
                        value={asset.return1m ?? 0}
                        onChange={(e) => updateAsset(asset.ticker, "return1m", Number(e.target.value))}
                        style={styles.smallInput} step="0.01" min="-1" max="1"
                        aria-label={`Retorno 1m de ${asset.name}`} />
                    </td>
                    <td style={{ color: ganancia >= 0 ? "#10b981" : "#ef4444" }}>
                      <div>{formatCurrency(ganancia)} ({gananciaPorcentaje.toFixed(1)}%)</div>
                      {asset.ticker === "BTC-EUR" && (
                        <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>
                          Compra: {formatCurrency(valorCompra)} | Actual: {formatCurrency(valor)}
                        </div>
                      )}
                    </td>
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
  button: { backgroundColor: "#3b82f6", color: "white", border: "none", padding: "8px 16px", borderRadius: "6px", cursor: "pointer", fontSize: "14px", fontWeight: "bold" },
};

// ── ÚNICO export default del módulo ──────────────────────────────────────
export default InstitutionalDashboard;