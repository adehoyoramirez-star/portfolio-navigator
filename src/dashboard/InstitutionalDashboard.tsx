// ═══════════════════════════════════════════════════════════════════════
// HENDE FUND — Institutional Portfolio Dashboard (Olympus Engine V3+)
// AUDIT-CLEAN v5 — Fixes aplicados:
//   FIX-01: Eliminado stub duplicado (líneas 1–58 originales)
//   FIX-02: Todos los imports consolidados al inicio del módulo
//   FIX-03: Guard de historial de régimen corregido (primer render espurio)
//   FIX-04: supabaseClient.ts usa variables de entorno (ver .env.local)
//   FIX-05: Eliminada interfaz Asset/Portfolio duplicada (conflicto factorRole)
//   --- Segunda auditoría (2026-05) ---
//   FIX-DCC-01:    dynamicCovMatrix añadido a deps de engineResult useMemo
//                  → DCC-GARCH ahora propaga Σ dinámica al optimizador (antes stale closure)
//   FIX-KALMAN-01: kalmanWeights movido a useMemo propio (era variable inline, React no detectaba cambios)
//   FIX-KALMAN-02: kalmanWeights añadido a deps de engineResult useMemo
//   FIX-KALMAN-03: updateKalmanFactorWeights() implementado en bucle mensual (antes nunca se llamaba)
//   FIX-META-01:   savePredictionRecord: actualReturn1m y wasCorrect ahora calculados con datos reales
//                  (antes hardcoded a 0/true → learning loop envenenado)
//   FIX-META-02:   evaluatePrediction() ahora se invoca mensualmente sobre la predicción anterior
//   FIX-META-03:   Bucle de aprendizaje ahora mensual (no solo en cambio de régimen)
//   FIX-DCA-01:    SmartDCA: guard engineResult null → no emitir BUY prematuro en primer render
//   FIX-DCA-02:    tacticalPct añadido a deps de smartDCAResult useMemo (antes stale si usuario cambiaba %)
//   FIX-CASH-01:   monthlyInjection eliminado de availableCash cuando DCA activo
//                  → evita double-counting entre Rebalancer y SmartDCA en mismo mes
//   FIX-DEFLIQ-01: smartDCAResult añadido a deps del useEffect de defensiveLiquidity (stale closure)
// ═══════════════════════════════════════════════════════════════════════

// ── Core React ──────────────────────────────────────────────────────────
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { fetchCryptoSignals } from "@/lib/directApis";
// NOTE: Telegram, Gemini, Mistral/AI-intelligence removed per R3 cleanup (July 2026).
// All AI intelligence features (telegram-alerts, ai-intelligence, mistralAI) have been eliminated.
// See MIFID_II_AUDIT.md for the rationale.

// ── UI / charting ────────────────────────────────────────────────────────
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

// ── Core engine & types ──────────────────────────────────────────────────
import { liquidityScore } from "@/core/macro/liquidity";
import { portfolio as initialPortfolio, Asset, Portfolio } from "@/core/types/portfolio";
import { calculateCorrelationMatrix, sortinoRatioReal, betaVsBenchmark, jensenAlpha } from "@/core/data/portfolioMetrics";
import { calculateRSI, calculateZScore } from "@/core/data/indicators";
import { runOlympusEngine, AssetInput } from "@/core/engine/olympusV3";
import { signalManualRefresh, setRegimeLock, clearRegimeLock, isRegimeLocked } from "@/core/macro/masterRegime";
import { fromManualInputs } from "@/core/macro/liquidityCycle";
import { fetchRealMarketData, MarketData } from "@/lib/marketData";
import { ASSETS, KALMAN_FACTOR_PROXY_TICKERS, KALMAN_FACTOR_MIN_POINTS } from "@/lib/constants";
import BacktestPanel from "@/core/backtest/BacktestPanel";
import { logEngineDecision } from "@/lib/decisionLog";
import {
  recordBenchmarkSnapshot,
  getBenchmarkStatus,
  getBenchmarkComposition,
  type BenchmarkStatus,
} from "@/core/benchmark/benchmarkRunner";
import {
  recordAllocation,
  getHistoricalPerformance,
} from "@/core/persistence/allocationLogger";
import {
  getCurrentKalmanWeights,
  updateKalmanFactorWeights,
  type FactorObservation,
} from "@/core/factors/kalmanFactorWeights";
import { getDynamicCovMatrix } from "@/core/risk/dccGarch";
import {
  savePredictionRecord,
  evaluatePrediction,
  loadPredictionHistory,
  type RegimePrediction,
} from "@/core/risk/metaIntelligence";

// ── Persistence & portfolio tools ────────────────────────────────────────
import {
  savePortfolio, loadPortfolio,
  saveMacro, loadMacro,
  saveRegimeEntry, loadRegimeHistory,
  loadDailySnapshots,
  clearAll, RegimeHistoryEntry,
} from "@/core/persistence/portfolioStorage";
import {
  computeRebalanceSuggestions,
  RebalanceAsset,
  RebalanceSuggestion,
} from "@/core/portfolio/rebalancer";
import {
  detectCycleTops,
  detectCycleBottoms,
  isBTCDominanceFalling,
  regimeValuationShift,
  type CycleTopInputs,
  type CycleTopSignal,
  type CycleBottomSignal,
  type CycleBottomOutput,
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
import walkforwardResults from "@/data/walkforward-results";
import WalkForwardSection from "@/dashboard/WalkForwardSection";
import FredManualPanel from "@/dashboard/FredManualPanel";
import { generateAuditCSV, downloadCSV } from "@/lib/marketDataExport";
import {
  analyzeBitcoinCycle,
  getPowerLawProjection,
  type BitcoinCycleInputs,
  type BitcoinCycleOutput,
  type ElliottWavePoint,
  type ElliottWaveLabel,
} from "@/core/crypto/bitcoinCycleAnalyzer";
import RealTimeMonitorPanel, {
  type MonitorPanelProps,
} from "@/dashboard/RealTimeMonitorPanel";

import { monteCarloJumpDiffusion, choleskyDecomposition, randomNormal } from "@/lib/monteCarlo";

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

// ==================== COMPONENTE PRINCIPAL ====================
const InstitutionalDashboard: React.FC = () => {
  const [portfolio, setPortfolio] = useState<Portfolio>(initialPortfolio);
  const [cashReserve, setCashReserve] = useState(portfolio.cashReserve);
  const [monthlyInjection, setMonthlyInjection] = useState(portfolio.monthlyInjection);
  // PERSIST-01: rastrea cuándo se guardaron los datos por última vez y si hay
  // cambios sin guardar desde la última sesión (para mostrar el banner de confirmación)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [showSessionBanner, setShowSessionBanner] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<string[]>([]);
  const [years, setYears] = useState(10);

  const [jumpIntensity, setJumpIntensity] = useState(1.5);  // FIX-MC-03: default recalibrado (1-2 crashes BTC reales/ano)
  const [jumpIntensityPortfolio, setJumpIntensityPortfolio] = useState(0.5);  // FIX-MC-03: default recalibrado (correccion cada ~2 anos)
  const [jumpMean, setJumpMean] = useState(-0.10);  // FIX-MC-03: -10% por crash, no -0.08 en exponente
  const [jumpStd, setJumpStd] = useState(0.10);  // FIX-MC-03: dispersion de crash recalibrada
  const [enableJumps, setEnableJumps] = useState(false);  // FIX-MC-05: OFF = GBM puro (proyeccion), ON = Jump Diffusion (stress test)

  const [vix, setVix] = useState(19);
  const [manualPER, setManualPER] = useState(29.69);
  const [manualBond10y, setManualBond10y] = useState(4.2);
  const [bond2y, setBond2y] = useState(3.0);
  const [m2Growth, setM2Growth] = useState(4.3);
  const [creditSpread, setCreditSpread] = useState(1.5);
  const [rsi, setRsi] = useState(55);
  const [momentum, setMomentum] = useState(0.2);

  const [liquidityGrowth, setLiquidityGrowth] = useState(3.2);
  const [dxy, setDxy] = useState(99.7);
  const [moveIndex, setMoveIndex] = useState(120);
  const [wtiOil, setWtiOil] = useState<number>(98);
  const [btcVol, setBtcVol] = useState(0.65);
  const [btcDominance, setBtcDominance] = useState(57.0);
  const [mvrvRatio, setMvrvRatio] = useState(1.8);
  const [btcRsiWeekly, setBtcRsiWeekly] = useState<number | undefined>(undefined);
  const [staleDataBlock, setStaleDataBlock] = useState(false);
  // FEAT: USD/EUR display toggle + exchange rate
  const [displayCurrency, setDisplayCurrency] = useState<'EUR' | 'USD'>('EUR');
  const [eurUsdRate, setEurUsdRate] = useState(1.08);
  // FEAT: Manual forward-looking volatility overrides (per asset, persisted)
  const [manualVols, setManualVols] = useState<Record<string, number | undefined>>(() => {
    try { return JSON.parse(localStorage.getItem('olympus_manual_vols') ?? '{}'); } catch { return {}; }
  });

const formatCurrency = (value: number): string => {
  const converted = displayCurrency === 'USD' ? value * eurUsdRate : value;
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: displayCurrency }).format(converted);
};

  const [prevBtcDominance, setPrevBtcDominance] = useState<number | undefined>(undefined);

  const [fearGreedIndex, setFearGreedIndex] = useState<{
    value: number;
    label: string;
    source: string;
  } | null>(null);

  const [onChainSource, setOnChainSource] = useState<"GLASSNODE" | "MANUAL">("MANUAL");

  const [puellMultiple, setPuellMultiple] = useState<number | undefined>(undefined);
  const [mvrvZScore, setMvrvZScore] = useState<number | undefined>(undefined);
  // MVRV-Z-STALE (Jul-2026): el Z-Score es manual (Glassnode). Si el usuario
  //   no lo actualiza en >7 días, se degrada automáticamente a undefined →
  //   el fallback a MVRV Ratio en detectBTCTop/detectBTCBottom se activa solo.
  //   Previene operar con un Z-Score stale sin que el motor lo sepa.
  //   Se computa en cada render (coste trivial: 1 localStorage read + 1 comparación).
  const MVRV_ZSCORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MVRV_ZSCORE_TS_KEY = 'olympus_mvrv_zscore_updated_at';
  const mvrvZScoreEffective = (() => {
    if (mvrvZScore === undefined) return undefined;
    try {
      const ts = parseInt(localStorage.getItem(MVRV_ZSCORE_TS_KEY) ?? '0');
      if (!ts) return mvrvZScore; // sin timestamp = asumir fresco (primera carga)
      if (Date.now() - ts > MVRV_ZSCORE_MAX_AGE_MS) {
        console.warn(`[MVRV-Z] Z-Score stale (${Math.round((Date.now()-ts)/86400000)}d sin actualizar) → degradado a MVRV Ratio`);
        return undefined; // trigger fallback
      }
    } catch { /* localStorage no disponible → asumir fresco */ }
    return mvrvZScore;
  })();
  const [hashRibbonState, setHashRibbonState] = useState<"CAPITULATION" | "RECOVERY" | "EXPANSION" | undefined>(undefined);
  const [piCycleMa111, setPiCycleMa111] = useState<number | undefined>(undefined);
  const [piCycleMa350x2, setPiCycleMa350x2] = useState<number | undefined>(undefined);
  const [elliottPivots, setElliottPivots] = useState<ElliottWavePoint[]>([]);
  const [elliottCurrentWave, setElliottCurrentWave] = useState<ElliottWaveLabel | undefined>(undefined);
  const [elliottPivotsText, setElliottPivotsText] = useState<string>("");



  const [defensiveLiquidity, setDefensiveLiquidity] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('olympus_defensive_liq') ?? '0') || 0; } catch { return 0; }
  });
  // CASH-REDESIGN: tacticalAccumulated y tacticalPct eliminados.
  // El táctico era una subcuenta automática que nunca existía en el broker real.
  // Ahora: defensiveLiquidity es el único colchón de oportunidad, gestionado 100% manual.
  // transferAmount: importe que el usuario quiere mover de cashReserve → defensiveLiquidity
  const [transferAmount, setTransferAmount] = useState<number>(0);


  // MEJORA-9: Log de operaciones ejecutadas — persiste en localStorage
  // Cada vez que el usuario confirma una operación real, se registra aquí.
  interface TradeRecord {
    id: string;
    date: string;           // ISO timestamp
    ticker: string;
    name: string;
    action: 'BUY' | 'SELL';
    shares: number;
    priceExecuted: number;  // precio real al que se ejecutó en el broker
    totalCost: number;      // shares * priceExecuted
    source: 'DCA' | 'REBALANCE' | 'MANUAL';
    regime: string;
    notes?: string;
  }
  const [tradeLog, setTradeLog] = useState<TradeRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem('olympus_trade_log') ?? '[]'); } catch { return []; }
  });
  // Modal de confirmación de operación ejecutada
  const [pendingTrade, setPendingTrade] = useState<{
    ticker: string; name: string; action: 'BUY' | 'SELL';
    suggestedShares: number; suggestedPrice: number; source: 'DCA' | 'REBALANCE';
  } | null>(null);
  const [execPrice, setExecPrice] = useState<number>(0);
  const [execShares, setExecShares] = useState<number>(0);

  const [uraniumSpot, setUraniumSpot] = useState<number | undefined>(undefined);
  const [uraniumLT, setUraniumLT] = useState<number | undefined>(undefined);
 const [siaSalesYoY, setSiaSalesYoY] = useState<number | undefined>(undefined);
 const [soxRsiWeekly, setSoxRsiWeekly] = useState<number | undefined>(undefined);
 const [soxSpyRS, setSoxSpyRS] = useState<number>(0);
  const [inflationBreakeven, setInflationBreakeven] = useState<number | undefined>(undefined);
  const [wlgRsiWeekly, setWlgRsiWeekly] = useState<number | undefined>(undefined);
  const [wlgPERatio, setWlgPERatio] = useState<number | undefined>(undefined);
  const [emxcRsiWeekly, setEmxcRsiWeekly] = useState<number | undefined>(undefined);
  const [emxcPERatio, setEmxcPERatio] = useState<number | undefined>(undefined);

  const [erpValue, setErpValue] = useState(0.025);
  const [liquidity, setLiquidity] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [marketData, setMarketData] = useState<MarketData | null>(null);

  // ── COMPOSITE STRATEGY: Olympus Core + BTC Satellite ──────────────────
  // Controla qué % del capital gestiona Olympus (resto = BTC buy & hold).
  // 100% = todo Olympus. 80% = 80% Olympus + 20% BTC directo.
  // Este slider controla la EJECUCIÓN REAL: afecta rebalanceo, Monte Carlo y
  // sugerencias de trading. NO es solo visualización histórica.
  const [olympusPct, setOlympusPctRaw] = useState(() => {
    try { const v = Number(localStorage.getItem('olympus_composite_pct')); return (v >= 0 && v <= 100) ? v : 100; } catch { return 100; }
  });

  // GUARD: evitar liquidación accidental al bajar olympusPct de 10%
  const setOlympusPct = useCallback((newPct: number) => {
    const safePct = Math.min(100, Math.max(0, newPct));
    if (safePct < 10 && olympusPct >= 10) {
      const confirmed = window.confirm(
        `⚠️ Composite Strategy: ${safePct}% Olympus\n\n` +
        `Esto movería ${100 - safePct}% de tu cartera a BTC directo (buy & hold),\n` +
        `lo que puede implicar vender otros activos para comprar BTC.\n\n` +
        `¿Confirmas este cambio?`
      );
      if (!confirmed) return;
    }
    setOlympusPctRaw(safePct);
  }, [olympusPct]);

  // FIX-AUDIT-R2 N4: eliminado leak a window.__marketData.
  // ANTES: cualquier extensión del navegador o XSS podía leer posiciones, allocations y datos macro.
  // Surface de ataque innecesario en producción. Para debug usar React DevTools.
  // useEffect removido por completo.

  const [activeAlerts, setActiveAlerts] = useState<RegimeAlert[]>([]);
  const [regimeHistory, setRegimeHistory] = useState<RegimeHistoryEntry[]>(() => loadRegimeHistory());
  const [cewsHistory, setCewsHistory] = useState<CEWSDataPoint[]>(() => loadCEWSHistory());
  const [cewsPreviousLevel, setCewsPreviousLevel] = useState<import("@/core/macro/crisisEarlyWarning").CEWSLevel>("CLEAR");
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const previousRegimeRef = useRef<string | null>(null);
  // FIX-ALERT-STALE (Jul-2026): ref independiente para limpiar alertas de Tail Risk
  // cuando el Kill Switch baja de nivel. No interfiere con previousKillSwitchRef
  // (usado por Recovery Memory en otro useEffect).
  const alertKillSwitchRef = useRef<number>(0);

  // ── Kill Switch Recovery Memory ───────────────────────────────────
  // FIX-KS-MEMORY (Jul-2026): cuando el Kill Switch baja de L4+ a L3-,
  // activa 4 ciclos de despliegue acelerado (2×) para desplegar el cash
  // acumulado durante la fase defensiva.
  const [recoveryCycles, setRecoveryCycles] = useState<number>(() => {
    try {
      const stored = sessionStorage.getItem('olympus_recovery_cycles');
      return stored ? parseInt(stored, 10) : 0;
    } catch { return 0; }
  });
  const previousKillSwitchRef = useRef<number>(0);
  const [benchmarkStatus, setBenchmarkStatus] = useState<BenchmarkStatus | null>(null);

  const clippedERP = (erp: number) => Math.max(-0.03, Math.min(0.05, erp));

  useEffect(() => {
    if (manualPER > 0) {
      const earningsYield = 1 / manualPER;
      const riskFree = manualBond10y / 100;
      const rawErp = earningsYield - riskFree;
      setErpValue(clippedERP(rawErp));
    }
  }, [manualPER, manualBond10y]);

  const refreshMarketData = async (isUserInitiated = false) => {
    setLoading(true);
    setApiError(null);
    if (isUserInitiated) {
      signalManualRefresh();
    }
    try {
      const { marketData: md, fetchErrors } = await fetchRealMarketData();
      setMarketData(md);
      // FIX-AUDIT-R9 4: circuit breaker from marketData
      if (md.staleDataBlock) setStaleDataBlock(true); else setStaleDataBlock(false);

      if (md.cewsHistory.length > 0) {
        setCewsHistory(md.cewsHistory);
      }

      if (fetchErrors.length > 0) {
        setApiError(`Datos parciales. Sin datos para: ${fetchErrors.join(", ")}`);
      }

      setVix(md.vix);
      setManualBond10y(md.tnx);

      if (md.dxy > 0) setDxy(parseFloat(md.dxy.toFixed(2)));
      if (md.wtiOil > 0) setWtiOil(parseFloat(md.wtiOil.toFixed(2)));
      if (md.moveIndex && md.moveIndex > 0) setMoveIndex(parseFloat(md.moveIndex.toFixed(1)));
      if (md.m2Growth !== undefined && md.m2Growth !== null) setM2Growth(parseFloat(md.m2Growth.toFixed(2))); // FIX-FRED-SYNC: always sync from FRED panel
      // FIX-PER-MANUAL: PER S&P 500 ahora es 100% manual (P/E Ratio TTM, no Shiller CAPE).
      // El CAPE de FRED usa beneficios promedio 10 años → sobrestima el PER → subestima el ERP.
      // El motor necesita el P/E trailing de 12 meses para calcular ERP = 1/PER - BondYield correctamente.
      // if (md.per > 0) setManualPER(parseFloat(md.per.toFixed(2))); // FIX-FRED-SYNC — DESACTIVADO
      if (md.creditSpread > 0) setCreditSpread(parseFloat(md.creditSpread.toFixed(2))); // FIX-FRED-SYNC

      const liq = liquidityScore({
        m2Growth: md.m2GrowthSource === "FRED" ? md.m2Growth : m2Growth,
        vix: md.vix,
        yieldCurveSpread: md.tnx - md.irx,
        centralBankGrowth: md.cbLiquidityGrowth
      });
      setLiquidity(liq);

      if (md.sp500Rsi > 0 && md.sp500Rsi !== 50) setRsi(parseFloat(md.sp500Rsi.toFixed(1)));
      if (md.sp500Momentum12m !== 0) {
        setMomentum(parseFloat(Math.max(-1, Math.min(1, md.sp500Momentum12m)).toFixed(4)));
      }
      if (md.btcRsiWeekly > 0 && md.btcRsiWeekly !== 50) {
        setBtcRsiWeekly(parseFloat(md.btcRsiWeekly.toFixed(1)));
      }
      // FIX-AUDIT-R9 5: SOX RSI semanal para CycleTop de semiconductores
      if (md.soxRsiWeekly > 0 && md.soxRsiWeekly !== 50) {
        setSoxRsiWeekly(md.soxRsiWeekly);
      }
      // FEAT-SOX-SPY (Jul-2026): SOX/SPX RS Z-score
      if (md.soxSpyRelativeStrength !== 0) {
        setSoxSpyRS(parseFloat(md.soxSpyRelativeStrength.toFixed(3)));
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
          if (idx === -1) return { ...asset, price: md.prices[asset.ticker] || asset.price };

          const closes = md.closesHistory[asset.ticker] || [];

          return {
            ...asset,
            price: md.prices[asset.ticker] || asset.price,
            history: closes,
            volatility: (md.realizedVols[idx] ?? asset.volatility / 100) * 100,
            return12m: md.returns12m[idx] ?? asset.return12m,
            return3m: md.returns3m[idx] ?? asset.return3m,
            return1m: md.returns1m[idx] ?? asset.return1m,
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
        const cryptoRaw = await fetchCryptoSignals();
        if (cryptoRaw && (!cryptoRaw.errors || cryptoRaw.errors.length < 5)) {
          if (cryptoRaw.fearGreedValue >= 0) setFearGreedIndex({
            value: cryptoRaw.fearGreedValue,
            label: cryptoRaw.fearGreedLabel,
            source: cryptoRaw.fearGreedSource,
          });
          if (cryptoRaw.eurUsd > 0) setEurUsdRate(cryptoRaw.eurUsd);
          // btcVol24h removed - not in direct API
          const hasVol = (cryptoRaw as any).btcVol24h > 0;
          if (hasVol) {
            const impliedAnnualVol = Math.abs((cryptoRaw as any).btcVol24h / 100) * Math.sqrt(365);
            setBtcVol(prev => parseFloat((prev * 0.70 + impliedAnnualVol * 0.30).toFixed(3)));
          }
        }
      } catch {
        // no crítico
      }

      try {
        // Glassnode on-chain desactivado. Datos manuales.
        setOnChainSource("MANUAL");
      } catch {
        // no crítico
      }

    } catch (error) {
      setApiError("Error al conectar con Yahoo Finance. Usando datos locales.");
    } finally {
      setLoading(false);
    }
  };



  useEffect(() => {
    const savedPortfolio = loadPortfolio();
    if (savedPortfolio) {
      // PERSIST-02: Detectar qué cambió desde la última vez que el usuario
      // introdujo datos. Si el sistema cargó valores guardados, mostramos
      // un banner de confirmación en lugar de sobreescribir silenciosamente.
      const changes: string[] = [];
      const prevAt = savedPortfolio.savedAt
        ? new Date(savedPortfolio.savedAt).toLocaleDateString('es-ES', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
          })
        : null;

      setLastSavedAt(prevAt);

      // Cargar datos guardados
      setPortfolio(prev => ({
        ...prev,
        cashReserve: savedPortfolio.cashReserve,
        monthlyInjection: savedPortfolio.monthlyInjection,
        assets: prev.assets.map(asset => {
          const saved = savedPortfolio.positions.find(p => p.ticker === asset.ticker);
          if (saved) {
            if (saved.shares !== asset.shares)
              changes.push(`${asset.name}: ${asset.shares} → ${saved.shares} acc.`);
            if (Math.abs(saved.avgPrice - asset.avgPrice) > 0.01)
              changes.push(`${asset.name}: precio medio ${asset.avgPrice.toFixed(2)} → ${saved.avgPrice.toFixed(2)}€`);
            return { ...asset, shares: saved.shares, avgPrice: saved.avgPrice };
          }
          return asset;
        }),
      }));
      setCashReserve(savedPortfolio.cashReserve);
      setMonthlyInjection(savedPortfolio.monthlyInjection);

      if (savedPortfolio.cashReserve !== initialPortfolio.cashReserve)
        changes.push(`Cash: ${savedPortfolio.cashReserve}€`);
      if (savedPortfolio.monthlyInjection !== initialPortfolio.monthlyInjection)
        changes.push(`Aportación mensual: ${savedPortfolio.monthlyInjection}€`);

      // Mostrar banner solo si hay datos guardados (no es primera vez)
      if (changes.length > 0 || prevAt) {
        setPendingChanges(changes);
        setShowSessionBanner(true);
      }
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
      else setJumpIntensityPortfolio(0.5);  // FIX-MC-03: default recalibrado
      if (savedMacro.jumpMean !== undefined) setJumpMean(savedMacro.jumpMean);
      if (savedMacro.jumpStd !== undefined) setJumpStd(savedMacro.jumpStd);
      if (savedMacro.enableJumps !== undefined) setEnableJumps(savedMacro.enableJumps);  // FIX-MC-05
      if (savedMacro.puellMultiple !== undefined) setPuellMultiple(savedMacro.puellMultiple);
      if (savedMacro.mvrvZScore !== undefined) setMvrvZScore(savedMacro.mvrvZScore);
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
      if (savedMacro.wlgRsiWeekly !== undefined) setWlgRsiWeekly(savedMacro.wlgRsiWeekly);
      if (savedMacro.wlgPERatio !== undefined) setWlgPERatio(savedMacro.wlgPERatio);
      if (savedMacro.emxcRsiWeekly !== undefined) setEmxcRsiWeekly(savedMacro.emxcRsiWeekly);
      if (savedMacro.emxcPERatio !== undefined) setEmxcPERatio(savedMacro.emxcPERatio);
    }
    refreshMarketData();
  }, []);

  useEffect(() => {
    const now = new Date().toISOString();
    savePortfolio({
      positions: portfolio.assets.map(a => ({ ticker: a.ticker, shares: a.shares, avgPrice: a.avgPrice })),
      cashReserve,
      monthlyInjection,
      savedAt: now,
    });
    // PERSIST-03: actualizar el timestamp visible cada vez que se guarda
    setLastSavedAt(
      new Date(now).toLocaleDateString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    );
  }, [portfolio.assets, cashReserve, monthlyInjection]);

  useEffect(() => {
    saveMacro({
      vix, manualPER, manualBond10y, bond2y, m2Growth,
      creditSpread, liquidityGrowth, dxy, moveIndex, btcVol,
      btcDominance, mvrvRatio,
      jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd, enableJumps,
      puellMultiple, mvrvZScore, hashRibbonState,
      piCycleMa111, piCycleMa350x2,
      elliottCurrentWave,
      elliottPivots: elliottPivots.map((p: ElliottWavePoint) => ({
        price: p.price,
        dateStr: p.date ? p.date.toISOString() : new Date().toISOString(),
        type: p.label,
      })),
      wlgRsiWeekly, wlgPERatio,
      emxcRsiWeekly, emxcPERatio,
      savedAt: new Date().toISOString(),
    });
  }, [vix, manualPER, manualBond10y, bond2y, m2Growth, creditSpread, liquidityGrowth, dxy, moveIndex, btcVol, btcDominance, mvrvRatio, jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd, enableJumps, puellMultiple, mvrvZScore, hashRibbonState, piCycleMa111, piCycleMa350x2, elliottCurrentWave, elliottPivots, wlgRsiWeekly, wlgPERatio, emxcRsiWeekly, emxcPERatio]);

  const totalPortfolioValue = portfolio.assets.reduce(
    (sum, asset) => sum + asset.price * asset.shares,
    0
  );

  const availableCash = cashReserve;

  const corrMatrix = useMemo(() =>
    calculateCorrelationMatrix(portfolio.assets),
    [portfolio.assets]
  );

  const assetInputs: AssetInput[] = useMemo(() => {
    return portfolio.assets.map(asset => {
      // FEAT: manual forward-looking vol override
      const manualVol = manualVols[asset.ticker];
      const effectiveVol = manualVol !== undefined && manualVol > 0
        ? manualVol
        : asset.volatility / 100;
      return {
        name: asset.name,
        ticker: asset.ticker,
        returns12m: asset.return12m ?? 0.01,
        returns3m: asset.return3m ?? 0.01,
        returns1m: asset.return1m ?? 0.01,
        earningsYield: asset.earningsYield ?? 0,
        volatility: effectiveVol,
        sector: asset.sector,
      };
    });
  }, [portfolio.assets, manualVols]);

  const yieldSpread = manualBond10y - bond2y;

  // FIX-HWM-INSTITUCIONAL (Jul 2026): High-Water Mark real, no contrafactual.
  // ANTES: se recorria TODA la historia de precios con las shares ACTUALES,
  //   creando un pico fantasma (ej: 0.3 BTC x 100K = 30.000 que nunca existio).
  //   Resultado: Kill Switch L4 tras cualquier cambio de composicion.
  // AHORA: se persiste el valor maximo REAL alcanzado por la cartera en
  //   localStorage (olympus_hwm). El HWM solo sube cuando el valor actual
  //   supera el maximo historico real. Si compras en suelo, DD = 0%.
  //   Si la cartera cae de verdad, el HWM queda alto y el Kill Switch protege.
  //   Hedge-fund standard: Bridgewater, AQR, Two Sigma usan HWM, no contrafactual.
  // FIX-HWM-DEFLIQ (Jul 2026): defensiveLiquidity incluido en currentTotal.
  //   ANTES: mover cash de cashReserve → defensiveLiquidity creaba un DD fantasma.
  //   El total real de riqueza es posiciones + cash broker + liquidez apartada.
  //   El HWM ahora refleja el patrimonio TOTAL, no solo la parte en broker.
  const HWM_KEY = "olympus_hwm";
  const hwmRef = useRef<number>(Number(localStorage.getItem(HWM_KEY)) || 0);
  const [hwmResetKey, setHwmResetKey] = useState(0);
  const portfolioDrawdown = useMemo(() => {
    const currentTotal = totalPortfolioValue + cashReserve + defensiveLiquidity;
    if (currentTotal <= 0) return 0;
    const peak = hwmRef.current > 0 ? hwmRef.current : currentTotal;
    if (currentTotal > peak) return 0; // nuevo maximo -> DD 0%
    return (currentTotal - peak) / peak;
  }, [totalPortfolioValue, cashReserve, defensiveLiquidity, hwmResetKey]);
  // Persistir HWM como efecto puro (separa calculo de side-effect)
  useEffect(() => {
    const currentTotal = totalPortfolioValue + cashReserve + defensiveLiquidity;
    if (currentTotal > hwmRef.current) {
      hwmRef.current = currentTotal;
      localStorage.setItem(HWM_KEY, String(currentTotal));
    }
  }, [totalPortfolioValue, cashReserve, defensiveLiquidity, hwmResetKey]);
  const handleResetHWM = useCallback(() => {
    if (window.confirm("¿Resetear el High-Water Mark al valor actual de la cartera?\n\nEsto reinicia el drawdown al 0%. Úsalo solo cuando:\n• Cambiaste la composición de la cartera (más/menos shares)\n• Hiciste pruebas que inflaron artificialmente el HWM\n• Quieres reiniciar la medición desde hoy")) {
      hwmRef.current = 0;
      localStorage.removeItem(HWM_KEY);
      setHwmResetKey(k => k + 1);
    }
  }, []);

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

  const [lastRegime, setLastRegime] = useState<string>('');
  // FIX-ORDER-01: regimeChangeCounter declarado ANTES de kalmanWeights useMemo
  // que lo referencia en sus deps. El orden de hooks en React debe ser
  // estrictamente top-down: primero el useState, luego el useMemo que lo consume.
  const [regimeChangeCounter, setRegimeChangeCounter] = useState(0);

  // REGIME-LOCK: el usuario puede congelar el régimen manualmente (30 min)
  const [regimeLock, setRegimeLockState] = useState(() => isRegimeLocked());

  // FIX-KALMAN-01: kalmanWeights como useMemo para que React detecte cambios
  // y lo propague correctamente al engine useMemo.
  // updateKalmanFactorWeights se llama en el useEffect mensual (ver más abajo).
  const kalmanWeights = useMemo(() => getCurrentKalmanWeights(), [regimeChangeCounter]);

  const dynamicCovResult = useMemo(() => {
    if (!marketData?.closesHistory || !marketData?.covMatrix) return undefined;
    try {
      return getDynamicCovMatrix(
        ASSETS as unknown as string[],
        marketData.closesHistory,
        marketData.covMatrix
      );
    } catch {
      return { covMatrix: marketData.covMatrix, avgCorrelation: 0.3 };
    }
  }, [marketData?.closesHistory, marketData?.covMatrix]);

  // ── P1: REGIME-CONDITIONED VALUATION STATE (Jul 2026, Comité) ──
  //   Declarado ANTES de cycleTopResult (TS: no puede usar variable
  //   antes de su declaración). El ramp useEffect que los escribe
  //   está después de currentRegime porque necesita leerlo.
  const [smoothedShiftPE, setSmoothedShiftPE] = useState<number>(0);
  const [smoothedShiftBTC, setSmoothedShiftBTC] = useState<number>(0);

  const cycleTopResult = useMemo(() => {
    const cycleInputs: CycleTopInputs = {
      mvrvRatio,
      btcDominanceFalling: isBTCDominanceFalling(btcDominance, prevBtcDominance),
      btcRsiWeekly,
      puellMultiple,
      mvrvZScore: mvrvZScoreEffective,
      uraniumSpotPrice: uraniumSpot,
      uraniumLTPrice: uraniumLT,
      siaSalesYoY,
soxRsiWeekly,
      soxSpyRelativeStrength: soxSpyRS,
      bondYield10y: manualBond10y,
      inflationBreakeven,
      brentOil: wtiOil > 0 ? wtiOil : undefined,
      wlgRsiWeekly,
      wlgPERatio,
      wlgCAPE: marketData?.per,
      emxcRsiWeekly,
      emxcPERatio,
      dxy,
      regimeShiftPE: smoothedShiftPE,
      regimeShiftBTC: smoothedShiftBTC,
    };
    return detectCycleTops(cycleInputs);
  }, [mvrvRatio, btcDominance, prevBtcDominance, btcRsiWeekly, puellMultiple, mvrvZScoreEffective, uraniumSpot, uraniumLT, siaSalesYoY, soxRsiWeekly, soxSpyRS, manualBond10y, inflationBreakeven, wtiOil, wlgRsiWeekly, wlgPERatio, emxcRsiWeekly, emxcPERatio, marketData?.per, dxy, smoothedShiftPE, smoothedShiftBTC]);

  // TACTICAL-DAILY (Jul 2026): track regime via state so React sees the dependency.
  // Declared before cycleBottomResult; useEffect (which sets it) is after engineResult.
  const [currentRegime, setCurrentRegimeRaw] = useState<string | undefined>(undefined);

  // ── P1: REGIME-CONDITIONED VALUATION RAMP (Jul 2026, Comité) ─────
  //   Cuando el régimen cambia, el shift de valoración transiciona
  //   suavemente en 5 días (rampa temporal). Esto evita saltos de
  //   14pp de trim en una sola sesión si EXPANSION→CRISIS.
  //   Usa setInterval para progresar con el tiempo real, no con renders.
  //   Los estados smoothedShiftPE/BTC están declarados antes de
  //   cycleTopResult (TS: no pueden usarse antes de declararse).
  useEffect(() => {
    const RAMP_KEY = 'olympus_regime_ramp';
    const RAMP_DAYS = 5;
    const RAMP_INTERVAL_MS = 5 * 60 * 1000;

    const computeRamp = () => {
      try {
        const stored = JSON.parse(localStorage.getItem(RAMP_KEY) ?? 'null');
        if (!stored) { setSmoothedShiftPE(0); setSmoothedShiftBTC(0); return; }
        const elapsed = Date.now() - stored.startTs;
        const progress = Math.min(1.0, elapsed / (RAMP_DAYS * 24 * 60 * 60 * 1000));
        setSmoothedShiftPE(parseFloat((stored.startPE + (stored.targetPE - stored.startPE) * progress).toFixed(4)));
        setSmoothedShiftBTC(parseFloat((stored.startBTC + (stored.targetBTC - stored.startBTC) * progress).toFixed(4)));
      } catch { setSmoothedShiftPE(0); setSmoothedShiftBTC(0); }
    };

    if (currentRegime) {
      const targetPE = regimeValuationShift('equity', currentRegime);
      const targetBTC = regimeValuationShift('btc', currentRegime);
      let startPE = 0, startBTC = 0, startTs = Date.now();
      try {
        const prev = JSON.parse(localStorage.getItem(RAMP_KEY) ?? 'null');
        const isSameRegime = prev?.targetRegime === currentRegime;
        if (isSameRegime) {
          // P1-FIX-TS (Jul 2026): preservar startTs original al continuar
          //   el mismo régimen tras un page reload. ANTES: startTs=Date.now()
          //   siempre → la rampa se reseteaba en cada recarga.
          startPE = prev.startPE;
          startBTC = prev.startBTC;
          startTs = prev.startTs ?? Date.now();
        } else if (prev) {
          startPE = prev.targetPE;
          startBTC = prev.targetBTC;
        }
      } catch {}
      localStorage.setItem(RAMP_KEY, JSON.stringify({ startTs, startPE, startBTC, targetPE, targetBTC, targetRegime: currentRegime }));
    }

    computeRamp();
    const interval = setInterval(computeRamp, RAMP_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [currentRegime]);

  // ── Cycle Bottom Detection — suelos de ciclo por activo ───────────
  // Simétrico a cycleTopResult: reutiliza los mismos cycleInputs invertidos.
  // Detecta activos infravalorados/oversold con opportunityScore 0-100.
  // Se pasa al Smart DCA para escalar compras en activos con suelo detectado.
  const cycleBottomResult = useMemo(() => {
    const cycleInputs: CycleTopInputs = {
      mvrvRatio,
      btcDominanceFalling: isBTCDominanceFalling(btcDominance, prevBtcDominance),
      btcRsiWeekly,
      puellMultiple,
      mvrvZScore: mvrvZScoreEffective,
      uraniumSpotPrice: uraniumSpot,
      uraniumLTPrice: uraniumLT,
      siaSalesYoY,
      soxRsiWeekly,
      soxSpyRelativeStrength: soxSpyRS,
      bondYield10y: manualBond10y,
      inflationBreakeven,
      brentOil: wtiOil > 0 ? wtiOil : undefined,
      wlgRsiWeekly,
      wlgPERatio,
      wlgCAPE: marketData?.per,
      emxcRsiWeekly,
      emxcPERatio,
      dxy,
      // TACTICAL-DAILY (Jul 2026): pasar price histories + currentPrices
      //   al detector de suelos. currentPrices inyecta el near-real-time
      //   de Yahoo (delay ~15min) para capturar caídas intradía.
      priceHistories: marketData?.closesHistory,
      currentPrices: marketData?.prices,
      regime: currentRegime,
      regimeShiftPE: smoothedShiftPE,
      regimeShiftBTC: smoothedShiftBTC,
    };
    return detectCycleBottoms(cycleInputs, cycleTopResult?.signals);
  }, [mvrvRatio, btcDominance, prevBtcDominance, btcRsiWeekly, puellMultiple, mvrvZScoreEffective, uraniumSpot, uraniumLT, siaSalesYoY, soxRsiWeekly, soxSpyRS, manualBond10y, inflationBreakeven, wtiOil, wlgRsiWeekly, wlgPERatio, emxcRsiWeekly, emxcPERatio, marketData?.per, dxy, cycleTopResult?.signals, marketData?.closesHistory, marketData?.prices, currentRegime, smoothedShiftPE, smoothedShiftBTC]);

  

  const engineResult = useMemo(() => {
    if (assetInputs.length === 0 || corrMatrix.length === 0) return null;
    // MEJORA-7: El WFO autocorrige los blend weights cuando detecta overfitting HIGH.
    // Si overfittingRisk === HIGH → aumenta HRP, reduce Kelly, para mayor robustez OOS.
    const wfoOverfit = walkForwardResult?.overfittingRisk;
    const autoBlend = wfoOverfit === 'HIGH'
      ? { kelly: 0.20, markowitz: 0.25, hrp: 0.55 }   // más HRP, menos Kelly (WFO recomienda)
      : undefined;                                       // undefined → el engine usa sus defaults

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
        cbLiquidityGrowth: marketData?.cbLiquidityGrowth,
      },
      covMatrix: dynamicCovResult?.covMatrix ?? marketData?.covMatrix,
      portfolioDrawdown,
      portfolioRealizedVol,
      erpValue,
      liquidityGrowth,
      cewsHistory: effectiveCEWSHistory,
      adaptiveFactorWeights: kalmanWeights,
      btcOnChain: {
        mvrvRatio,
        mvrvZScore: mvrvZScoreEffective,
        puellMultiple,
        rsiWeekly: btcRsiWeekly,
      },
      // FIX-AUDIT-R9 5: SOX RSI + inflation breakeven para CycleTop detection
      soxRsiWeekly: soxRsiWeekly && soxRsiWeekly !== 50 ? soxRsiWeekly : undefined,
      inflationBreakeven: inflationBreakeven && inflationBreakeven > 0 ? inflationBreakeven : undefined,
      availableCash,
      totalPortfolioValue,
      avgCorrelation: dynamicCovResult?.avgCorrelation,
      blendWeights: autoBlend,
      cycleTopSignals: (cycleTopResult?.signals ?? []).map(s => ({
        ticker: s.ticker,
        allocationMultiplier: s.allocationMultiplier,
      })),
      regimeLock,
      // FIX-AUDIT-TRANSVERSAL-R3 #1 (Jul-2026): regimeHistory ahora se pasa al motor
      // para que computeRegimeDuration() ajuste ±0.10 en finalPenalty según la madurez
      // del régimen (CRISIS OLD +0.08 prepara ataque, CRISIS YOUNG -0.10 cautela extra).
      // ANTES: regimeHistory estaba cargado en el dashboard pero nunca llegaba al engine
      // → el bloque `if (regimeHistory !== undefined)` en masterRegime.ts nunca se ejecutaba.
      regimeHistory,
    });
  // FIX-DCC-01: dynamicCovResult añadido a deps para que el engine reaccione
  // cuando DCC-GARCH actualiza la Σ dinámica (antes usaba closure estale).
  // FIX-KALMAN-02: kalmanWeights añadido a deps por la misma razón.
  // MEJORA-7: walkForwardResult añadido para que el blend autocorregido se propague.
  // FIX-AUDIT-TRANSVERSAL-R3: regimeHistory añadido a deps para regimeDuration.
  }, [assetInputs, corrMatrix, vix, yieldSpread, creditSpread, m2Growth, moveIndex, dxy, btcVol, wtiOil, erpValue, dynamicCovResult, marketData?.covMatrix, marketData?.cbLiquidityGrowth, portfolioDrawdown, portfolioRealizedVol, effectiveCEWSHistory, kalmanWeights, regimeChangeCounter, walkForwardResult, mvrvRatio, puellMultiple, btcRsiWeekly, availableCash, totalPortfolioValue, cycleTopResult, regimeHistory]);

  // TACTICAL-DAILY (Jul 2026): sync regime to state so cycleBottomResult reacts.
  // currentRegime is used by the tactical daily layer in applyTacticalDaily().
  useEffect(() => {
    if (engineResult?.regime && engineResult.regime !== lastRegime) {
      setLastRegime(engineResult.regime);
      setRegimeChangeCounter(c => c + 1);
    }
    // Always sync regime, even for undefined → guards work on first render too.
    setCurrentRegimeRaw(engineResult?.regime);
  }, [engineResult?.regime, lastRegime]);


  // REGIME-LOCK: auto-unlock si ha pasado el tiempo
  useEffect(() => {
    const interval = setInterval(() => {
      const lock = isRegimeLocked();
      if (regimeLock && !lock) {
        setRegimeLockState(null);
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [regimeLock]);

  const liquidityOutput = useMemo(() =>
    fromManualInputs({ liquidityGrowth, dxy }),
    [liquidityGrowth, dxy]
  );

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
      killSwitchLevel: engineResult.killSwitchLevel ?? 0,
      portfolioDrawdown: portfolioDrawdown ?? 0,
      volTargetMultiplier: engineResult.volTargetMultiplier,
    });
    if (newAlerts.length > 0) {
      setActiveAlerts(prev => [...newAlerts, ...prev].slice(0, 10));

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

      const totalValue = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);


    }

    // FIX-ALERT-STALE-v2 (Jul-2026): cuando KS=0, TODAS las alertas de
    // "Kill Switch" / "DD -" son basura. Limpiar SIEMPRE, sin condiciones.
    // v1 tenia bug: alertKillSwitchRef.current > 0 bloqueaba el primer render
    // y KS=0 nunca sube → la limpieza nunca se ejecutaba → alerta fantasma.
    // FUERA del if(newAlerts) porque generateAlerts devuelve [] con KS=0.
    const currKill = engineResult.killSwitchLevel ?? 0;
    if (currKill === 0) {
      setActiveAlerts(prev => prev.filter(a => {
        const msg = a.message ?? '';
        return !msg.includes('Kill Switch') && !msg.includes('DD -');
      }));
    }

    previousRegimeRef.current = currentRegime;
  }, [engineResult, vix, portfolioDrawdown, portfolio]);

  // ── Kill Switch Recovery Memory ───────────────────────────────────
  // Cuando el Kill Switch baja de L4+ a L3-, activa 4 ciclos de
  // despliegue acelerado (2×) para inyectar el cash acumulado.
  useEffect(() => {
    const current = engineResult?.killSwitchLevel ?? 0;
    const previous = previousKillSwitchRef.current;

    if (previous >= 4 && current < 4 && current > 0) {
      // Salida de bloqueo → activar recuperación
      setRecoveryCycles(4);
      try { sessionStorage.setItem('olympus_recovery_cycles', '4'); } catch {}
    } else if (recoveryCycles > 0 && current === 0) {
      // Kill Switch desactivado completamente → cancelar recuperación pendiente
      setRecoveryCycles(0);
      try { sessionStorage.removeItem('olympus_recovery_cycles'); } catch {}
    } else if (recoveryCycles > 0) {
      // Decrementar ciclo en cada render donde Kill Switch sigue activo
      const next = recoveryCycles - 1;
      setRecoveryCycles(next);
      try { sessionStorage.setItem('olympus_recovery_cycles', String(next)); } catch {}
    }

    previousKillSwitchRef.current = current;
  }, [engineResult]);

  // ── SPRINT-7: Monitoreo en Vivo — Real-Time Monitor Panel ────────
  //

  // ── SPRINT-3: Benchmark 60/40 — registra snapshot y calcula status ───────
  const lastBenchmarkSnapshot = useRef<string | null>(null);
  // FIX-AUDIT-R3 R3-01 v2: consecutive-run counter for ALL_CASH hysteresis
    // FIX-AUDIT-R3 R3-01 v2: consecutive counter for ALL_CASH hysteresis. ASYMMETRY rationale:
  // engine.regime === "ALL_CASH" (direct engine signal, totalKelly===0 path) fires in run 1 without hysteresis:
  //   el motor YA ha colapsado. No es derived/fluctuante.
  // ASYMMETRY RATIONALE (greppable): hysteresis is intentionally asymmetric — see lines below.
  // engine.totalInvested < 0.05 (derived signal via Tail Risk + Correlation Panic + ERP trigger) -> 3-run hysteresis:
  //   derived signals pueden oscilar 0.04-0.06 con micro-changes. Hysteresis evita pulsos espurios.
  // Si renormalizas esto a 3 runs para AMBOS, reintroduces latency bug en crash real.
  const allCashStreakRef = useRef<number>(0);
  useEffect(() => {
    if (!engineResult || totalPortfolioValue <= 0) return;

    const prices: Record<string, number> = {};
    for (const asset of portfolio.assets) {
      prices[asset.ticker] = asset.price;
    }

    recordBenchmarkSnapshot({
      portfolioValue: totalPortfolioValue,
      totalInvested: engineResult.allocations.reduce((s, a) => s + a.finalAllocation, 0),
      regime: engineResult.regime,
      prices,
    });

    setBenchmarkStatus(getBenchmarkStatus());
    lastBenchmarkSnapshot.current = new Date().toISOString();
  }, [engineResult, totalPortfolioValue, portfolio.assets]);

  // ── SPRINT-6: Allocation Logger — registra cada ejecución del engine ──────
  useEffect(() => {
    if (!engineResult || totalPortfolioValue <= 0) return;
    try {
      recordAllocation({
        regime: engineResult.regime,
        totalInvested: engineResult.allocations.reduce((s, a) => s + a.finalAllocation, 0),
        totalPortfolioValue,
        portfolioDrawdown: portfolioDrawdown ?? 0,
        allocations: engineResult.allocations.map(a => {
          const asset = portfolio.assets.find(pa => pa.name === a.name);
          return {
            name: a.name,
            ticker: asset?.ticker,
            finalAllocation: a.finalAllocation,
            momentumScore: a.momentumScore ?? 0,
            valueScore: a.valueScore ?? 0,
            qualityScore: a.qualityScore ?? 0,
            lowVolScore: a.lowVolScore ?? 0,
            expectedReturn: a.expectedReturn ?? 0,
            kellyFraction: a.kellyFraction ?? a.finalAllocation,
          };
        }),
        regimePenalty: engineResult.masterRegime.regimePenalty ?? 1,
        coreSignalScore: typeof engineResult.meta.confidence === "number"
          ? engineResult.meta.confidence
          : engineResult.meta.confidence === "HIGH"
          ? 0.85
          : engineResult.meta.confidence === "MEDIUM"
          ? 0.55
          : 0.25,
        volTargetMultiplier: engineResult.volTargetMultiplier ?? 1,
        tailRiskOverlay: engineResult.tailRiskOverlay ?? 0,
        tailRiskActive: engineResult.tailRiskActive ?? false,
        tailRiskReason: engineResult.tailRiskReason ?? "",
        metaConfidence: engineResult.meta.confidence ?? "MEDIUM",
        killSwitchLevel: engineResult.killSwitchLevel ?? 0,
        engineVersion: "olympus-v3.2",
      });
    } catch (e) {
      console.warn("AllocationLogger error:", e);
    }
  }, [engineResult, totalPortfolioValue, portfolio.assets, portfolioDrawdown]);

  // ── FIX-META-01 + FIX-KALMAN-03: Bucle de aprendizaje mensual ─────────────
  // Ejecuta una vez por mes calendario. Hace tres cosas en orden:
  //   1. Evalúa la predicción guardada hace ~30 días con el retorno REAL del portfolio
  //   2. Guarda una nueva predicción para el mes actual (con wasCorrect calculado, no hardcoded)
  //   3. Actualiza los pesos del filtro de Kalman con las observaciones de factor del mes
  // Esto cierra los tres bucles de aprendizaje que estaban abiertos.
  const lastMetaMonth = useRef<string | null>(null);
  useEffect(() => {
    if (!engineResult || !marketData?.closesHistory) return;

    // FIX-AUDIT-R3 R3-02 v4: DEGRADED MODE with subset confidence multiplier.
    // v2 strict every() causaba deadlock en partial outage (1 ticker missing -> Kalman congelado indefinido).
    // v4: require >=3 de los 5 proxies listos (lower bound para Kalman observation covariance no singular).
    // Si ready < 3 -> skip update with warn.
    // Si ready 3-5 -> proceed with subsetConfidenceMultiplier = 0.9^missing_count applied to kalmanObs.portfolioReturn
    // (multiplicar la observacion reduce su peso en el filtro Kalman via effective observation covariance;
    //  alternative: factor específico por proxy — más complejo, no justificado aún).
    // 0.9 decay es heurístico (calibrar empíricamente en ADR futura con 2008/2020 stress).
    // FIX-AUDIT-R3 v4 cleanup: dropped FACTOR_PROXY_TICKERS alias (use hoisted KALMAN_FACTOR_PROXY_TICKERS directly).
    const FACTOR_REQUIRED_READY = 3;
    const FACTOR_CONFIDENCE_DECAY = 0.9;
    const readyProxies = KALMAN_FACTOR_PROXY_TICKERS.filter(t => Array.isArray(marketData.closesHistory[t]) && marketData.closesHistory[t].length >= KALMAN_FACTOR_MIN_POINTS);
    if (readyProxies.length < FACTOR_REQUIRED_READY) {
      if (typeof console !== "undefined") console.warn("[DCA-Kalman] only", readyProxies.length, "of", KALMAN_FACTOR_PROXY_TICKERS.length, "proxies ready - skipping month update");
      return;
    }
    const missingCount = KALMAN_FACTOR_PROXY_TICKERS.length - readyProxies.length;
    const subsetConfidenceMultiplier = Math.pow(FACTOR_CONFIDENCE_DECAY, missingCount);
    if (missingCount > 0 && typeof console !== "undefined") console.warn("[DCA-Kalman] degraded mode:", readyProxies.length, "/", KALMAN_FACTOR_PROXY_TICKERS.length, "ready, confidence mul =", subsetConfidenceMultiplier.toFixed(3));
    const currentMonth = new Date().toISOString().slice(0, 7); // "2026-05"
    if (lastMetaMonth.current === currentMonth) return;        // ya procesado este mes
    lastMetaMonth.current = lastMetaMonth.current ?? "__init__"; // evita re-fire en mismo mes tras re-render

    try {
      // ── PASO 1: Evaluar predicción del mes anterior ──────────────────────
      const snapshots = loadDailySnapshots();
      const currentValue = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const oldSnap = snapshots.find(s => s.timestamp < thirtyDaysAgo);

      const actualReturn1m = oldSnap && oldSnap.portfolioValue > 0
        ? (currentValue - oldSnap.portfolioValue) / oldSnap.portfolioValue
        : 0;

      // Recuperar la predicción que hicimos hace ~30 días (el último registro guardado)
      const predHistory = loadPredictionHistory();
      const prevPrediction = predHistory.length > 0
        ? predHistory[predHistory.length - 1]
        : null;

      // ── PASO 2: Guardar predicción del mes actual con datos REALES ───────
      // wasCorrect evalúa el régimen que predijimos el mes pasado vs lo que pasó
      const wasCorrect = prevPrediction
        ? evaluatePrediction(
            prevPrediction.predictedRegime as RegimePrediction,
            actualReturn1m
          )
        : true; // sin historial previo → neutro

      const regime = engineResult.regime;
      if (regime !== "ALL_CASH") {
        savePredictionRecord({
          predictedRegime: regime as RegimePrediction,
          actualReturn1m,
          wasCorrect,
          penaltyApplied: engineResult.masterRegime.regimePenalty,
        });
      }

      // ── PASO 3: Actualizar filtro de Kalman con observaciones del mes ────
      // Aproximamos los retornos de cada factor premium usando los activos del universo:
      //   momentum  → promedio top-3 por retorno 1m (WLG, VVSM, URNU si subieron)
      //   value     → retorno de EMXC + PPFB (proxies value/commodity)
      //   quality   → retorno de WLG (MSCI World broad equity)
      //   lowVol    → retorno de PPFB (oro, menor volatilidad del universo)
      const closes = marketData.closesHistory;
      const getMonthlyReturn = (ticker: string): number => {
        const series = closes[ticker] ?? [];
        if (series.length < 22) return 0;
        const prev = series[series.length - 22]; // ~1 mes atrás
        const curr = series[series.length - 1];
        return prev > 0 ? (curr - prev) / prev : 0;
      };

      const retWLG   = getMonthlyReturn("0P00000WLG.F");
      const retVVSM  = getMonthlyReturn("VVSM.DE");
      const retURNU  = getMonthlyReturn("URNU.DE");
      const retEMXC  = getMonthlyReturn("EMXC.DE");
      const retPPFB  = getMonthlyReturn("PPFB.DE");
      

      const momentumReturn = (retWLG + retVVSM + retURNU) / 3;
      const valueReturn    = (retEMXC + retPPFB) / 2;
      const qualityReturn  = retWLG;
      const lowVolReturn   = retPPFB;

      const kalmanObs: FactorObservation = {
        momentumReturn,
        valueReturn,
        qualityReturn,
        lowVolReturn,
        portfolioReturn: actualReturn1m * subsetConfidenceMultiplier, // FIX-AUDIT-R3 R3-02 v4: scale observation by readiness
        regime: (regime === "ALL_CASH" ? "CRISIS" : regime) as "EXPANSION" | "CONTRACTION" | "CRISIS",
      };

      updateKalmanFactorWeights(kalmanObs);

      // Forzar recálculo del engine en el siguiente render
      setRegimeChangeCounter(c => c + 1);
      lastMetaMonth.current = currentMonth;

    } catch (e) {
      console.warn("MetaIntelligence/Kalman monthly update error:", e);
    }
  }, [engineResult?.regime, marketData?.closesHistory, portfolio.assets]);

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

  const btcCycleResult = useMemo((): BitcoinCycleOutput | null => {
    const btcAssetLocal = portfolio.assets.find(a => a.ticker === "BTC-EUR");
    if (!btcAssetLocal || btcAssetLocal.price <= 0) return null;
    const inputs: BitcoinCycleInputs = {
      currentPrice: btcAssetLocal.price,
      puellMultiple,
      mvrvZScore: mvrvZScoreEffective,
      hashRibbonState,
      piCycleMa111,
      piCycleMa350x2,
      elliottPivots: elliottPivots.length >= 2 ? elliottPivots : undefined,
      elliottCurrentWave: elliottCurrentWave,
      eurUsdRate: 1.08,
    };
    try {
      const result = analyzeBitcoinCycle(inputs);
      if (!result) return null;
      // MEJORA-6: Elliott Wave penaliza cycleScore cuando la dirección es bajista.
      // Onda A/C DOWN confirmada → reduce el score para evitar STRONG_BUY contradictorio.
      const elliottResult = result.elliottWave;
      if (
        elliottResult &&
        elliottResult.currentWaveDirection === 'DOWN' &&
        elliottResult.confidence !== 'LOW'
      ) {
        const penalty = elliottResult.confidence === 'HIGH' ? 20 : 12;
        const adjustedScore = Math.max(0, result.cycleScore - penalty);
        const adjustedBias: BitcoinCycleOutput['actionBias'] =
          adjustedScore >= 75 ? 'STRONG_BUY'
          : adjustedScore >= 60 ? 'BUY'
          : adjustedScore >= 40 ? 'HOLD'
          : adjustedScore >= 25 ? 'REDUCE' : 'SELL';
        return {
          ...result,
          cycleScore: adjustedScore,
          actionBias: adjustedBias,
          summary: `${result.summary} ⚠️ Elliott Wave ${elliottResult.currentWave} DOWN: −${penalty}pts (${result.cycleScore} → ${adjustedScore}).`,
        };
      }
      return result;
    }
    catch { return null; }
  }, [portfolio.assets, puellMultiple, mvrvZScoreEffective, hashRibbonState, piCycleMa111, piCycleMa350x2, elliottPivots, elliottCurrentWave]);

  const olympusAvailableCash = cashReserve;
  const tacticalAvailableCash = defensiveLiquidity; // solo se activa en ATTACK >= 4/7
  const btcAsset = portfolio.assets.find(a => a.ticker === "BTC-EUR");
  const btcRsi = btcAsset?.rsi ?? calculateRSI(btcAsset?.history || [], 14);
  const btcZ = btcAsset?.zScore ?? calculateZScore(btcAsset?.history || [], 200);
  const btcRet1m = btcAsset?.return1m ?? 0;

  const smartDCAResult = useMemo(() => {
    // FIX-DCA-01: no emitir señal de compra si el engine todavía no tiene datos.
    // El default "EXPANSION" original podía producir un BUY prematuro en el primer render.
    if (!engineResult) return null;
    return computeSmartDCA({
      btcRsi,
      btcZScore: btcZ,
      btcMomentum1m: btcRet1m,
      btcDominance,
      mvrvRatio,
      regime: engineResult.regime,
      regimePenalty: engineResult.masterRegime.regimePenalty,
      volTargetMultiplier: engineResult.volTargetMultiplier,        tailRiskActive: engineResult.tailRiskActive,
        tailRiskOverlay: engineResult.tailRiskOverlay,
        killSwitchLevel: engineResult.killSwitchLevel ?? 0,
        recoveryCyclesRemaining: recoveryCycles,
        olympusAvailableCash,
      tacticalAvailableCash,
      accumulatedDefensiveLiquidity: defensiveLiquidity,
      motorAllocations: engineResult.allocations.map(a => {
        const asset = portfolio.assets.find(pa => pa.name === a.name);
        const isBtc = asset?.ticker === 'BTC-EUR';
        const olyPctVal = olympusPct / 100;
        const btcSatVal = (100 - olympusPct) / 100;
        // FIX-COMPOSITE-DCA (Jul 2026): aplicar fórmula composite a las
        // finalAllocation para que el DCA use los mismos targets que el rebalanceo.
        // ANTES: BTC target = 2% (motor) → drift -23pp → BLOQUEADO.
        // AHORA: BTC target = 31.4% (composite 70/30) → drift +6pp → COMPRA.
        const compositeAlloc = isBtc
          ? (a.finalAllocation * olyPctVal) + btcSatVal
          : a.finalAllocation * olyPctVal;
        return {
          name: a.name,
          ticker: asset?.ticker ?? a.name,
          finalAllocation: compositeAlloc,
          price: asset?.price ?? 0,
        };
      }),
      // FIX-DCA-DRIFT: pasar pesos actuales para calcular drift (solo comprar infraponderados)
      currentAllocations: portfolio.assets.map(a => ({
        ticker: a.ticker,
        name: a.name,
        currentWeight: totalPortfolioValue > 0
          ? (a.price * a.shares) / totalPortfolioValue
          : 0,
      })),
      cewsOutput: cewsResult ?? undefined,
      cewsPreviousLevel,
      cycleTopSignals: (cycleTopResult?.signals ?? []).map(s => ({
        ticker: s.ticker,
        allocationMultiplier: s.allocationMultiplier,
        shouldTrim: s.shouldTrim,
        zone: s.zone,
      })),
      // FIX-AUDIT-R9 4: stale data circuit breaker
      staleDataBlock,
      // FIX-CAP-ALLOC: pasar totalPortfolioValue para cap de compra por activo
      totalPortfolioValueEUR: totalPortfolioValue,
      // Cycle Bottom Detection: per-asset attackMultiplier para escalar DCA en suelos
      cycleBottomSignals: (cycleBottomResult?.signals ?? []).map(s => ({
        ticker: s.ticker,
        attackMultiplier: s.attackMultiplier,
        shouldAccumulate: s.shouldAccumulate,
        zone: s.zone,
      })),
    });
  // CASH-REDESIGN-03: tacticalPct eliminado de deps (ya no existe).
  // cashReserve es ahora el único input de cash real para SmartDCA.
  }, [btcRsi, btcZ, btcRet1m, engineResult, cashReserve, portfolio.assets, cewsResult, cewsPreviousLevel, defensiveLiquidity, cycleTopResult, cycleBottomResult, totalPortfolioValue, olympusPct]);

  const dcaAction = smartDCAResult?.action ?? "WATCH";
  const dcaBlocked = dcaAction === "BLOCK_VOL" || dcaAction === "BLOCK_CRISIS" || dcaAction === "BLOCK_TAIL_RISK" || dcaAction === "BLOCK_STALE_DATA";

  // CASH-REDESIGN-05: eliminados los 3 useEffects de auto-acumulación.
  //   - defensiveLiquidityRef + useEffect que movía monthlyInjection → defensiveLiquidity en CRISIS
  //   - useEffect que vaciaba defensiveLiquidity en attackMode
  //   - useEffect que acumulaba tacticalAccumulated mensualmente
  //   - useEffect de persistencia de tacticalAccumulated
  //   - useEffect de persistencia de tacticalPct
  // El usuario gestiona defensiveLiquidity manualmente con el botón de transferencia.
  // Nada toca defensiveLiquidity automáticamente.

  // Botón "Transferir sobrante a Liquidez Defensiva"
  // FEAT: persist manual vol overrides
  useEffect(() => {
    try { localStorage.setItem('olympus_manual_vols', JSON.stringify(manualVols)); } catch {}
  }, [manualVols]);

  // Persist Composite Strategy olympusPct
  useEffect(() => {
    try { localStorage.setItem('olympus_composite_pct', String(olympusPct)); } catch {}
  }, [olympusPct]);




  // Botón "Usar Liquidez Defensiva" (después de un ataque manual)
  // MEJORA-9: Confirmar operación ejecutada en broker
  // Actualiza shares, recalcula avgPrice y descuenta del cashReserve automáticamente.
  const confirmTradeExecution = () => {
    if (!pendingTrade || execShares <= 0 || execPrice <= 0) return;
    const { ticker, name, action, source } = pendingTrade;
    const totalCost = execShares * execPrice;

    // 1. Actualizar portfolio (shares + avgPrice)
    setPortfolio(prev => ({
      ...prev,
      assets: prev.assets.map(asset => {
        if (asset.ticker !== ticker) return asset;
        if (action === 'BUY') {
          const newShares = asset.shares + execShares;
          const newAvg = newShares > 0
            ? (asset.shares * asset.avgPrice + execShares * execPrice) / newShares
            : execPrice;
          return { ...asset, shares: newShares, avgPrice: Math.round(newAvg * 100) / 100 };
        } else {
          const newShares = Math.max(0, asset.shares - execShares);
          return { ...asset, shares: newShares }; // avgPrice no cambia al vender
        }
      }),
    }));

    // 2. Actualizar cashReserve
    if (action === 'BUY') {
      setCashReserve(prev => Math.max(0, Math.round((prev - totalCost) * 100) / 100));
    } else {
      setCashReserve(prev => Math.round((prev + totalCost) * 100) / 100);
    }

    // 3. Registrar en trade log
    const record: TradeRecord = {
      id: `${Date.now()}-${ticker}`,
      date: new Date().toISOString(),
      ticker, name, action,
      shares: execShares,
      priceExecuted: execPrice,
      totalCost,
      source,
      regime: engineResult?.regime ?? 'UNKNOWN',
    };
    const newLog = [record, ...tradeLog];
    setTradeLog(newLog);
    try { localStorage.setItem('olympus_trade_log', JSON.stringify(newLog.slice(0, 200))); } catch {}

    // 4. Cerrar modal
    setPendingTrade(null);
    setExecPrice(0);
    setExecShares(0);
  };

  const rebalanceFinal = useMemo(() => {
    // FIX-AUDIT-R2 N3 v2: rebalanceFinal en ALL_CASH ahora emite sell-all explícito.
    // ANTES: guard `if (...regime === "ALL_CASH") return null` → el motor decidía ALL_CASH
    // (pánico total) y el dashboard quedaba con 0 sugerencias → el usuario permanecía 100% invertido
    // sin instrucción de vender. v1 sólo quita el guard, pero computeRebalanceSuggestions
    // NO emite SELL porque depende de cycleTopSignals.shouldTrim. Sin cycle actives + targetPct=0
    // → deficitValue=0 → no BUY tampoco → 0 sugerencias → mismo bug.
    // REAL FIX: en ALL_CASH, generar SELL signals manuales para todos los activos con shares>0
    // a 100% (liquidation total), priority HIGH, descartando BUY suggestions del base output.
    if (!engineResult) return null;
    // COMPOSITE STRATEGY: calcular composite allocations inline
    const olyPct = olympusPct / 100;
    const btcSat = (100 - olympusPct) / 100;
    const rebalanceAssets: RebalanceAsset[] = portfolio.assets.map(asset => {
      const alloc = engineResult.allocations.find(a => a.name === asset.name);
      const engineAlloc = alloc?.finalAllocation ?? 0;
      const isBtc = asset.ticker === 'BTC-EUR';
      const compositeAlloc = isBtc
        ? (engineAlloc * olyPct) + btcSat
        : engineAlloc * olyPct;
      return {
        ticker: asset.ticker,
        name: asset.name,
        price: asset.price,
        shares: asset.shares,
        targetAllocation: compositeAlloc,
      };
    });
    const baseRebalance = computeRebalanceSuggestions(
      rebalanceAssets,
      availableCash,
      totalPortfolioValue,
      0.02,
      cycleTopResult.signals
    );
    // FIX-AUDIT-R3 R3-01: trigger extendido para liquidación total.
    // ANTES: solo `regime === "ALL_CASH"` disparaba el branch de liquidación. PERO el engine
    // solo emite "ALL_CASH" cuando totalKelly===0 (todos los kelly sums son cero), lo cual
    // es raro en producción (requiere TODOS los expectedReturn ≤ vol² simultáneamente).
    // EFECTO: el dashboard raramente disparaba la venda a cash, dando falsa sensación de protección.
    // AHORA: también dispara cuando totalInvested < 5% (engine decidió efectivo implícito muy
    // alto por regime CRISIS + tail risk alto). En ese caso finalAllocation para cada activo es ~0
    // y la liquidación total es la instrucción correcta al broker.
    // FIX-AUDIT-R3 R3-01 v2: hysteresis of 3 consecutive engine runs to suppress spurious SELL-all pulses during regime micro-changes.
    const DASH_ALL_CASH_HYSTERESIS_RUNS = 3;
    const totalInv = engineResult.totalInvested ?? 0;
    const immediateAllCash = engineResult.regime === "ALL_CASH" || totalInv < 0.05;
    if (immediateAllCash) {
      allCashStreakRef.current = DASH_ALL_CASH_HYSTERESIS_RUNS;
    } else if (totalInv >= 0.05) {
      allCashStreakRef.current = 0;
    }
    const isAllCash = allCashStreakRef.current >= DASH_ALL_CASH_HYSTERESIS_RUNS;
    if (!isAllCash) {
      // FIX-BTC-BUY-GUARD (Jul-2026): garantizar que BTC BUY aparece en el panel
      // cuando el drift es significativo y no hay Cycle Top que lo bloquee.
      // El computeRebalanceSuggestions a veces no genera el BUY por un bug de
      // estado React no reproducible (posible race condition cycleTopResult/engineResult).
      // Este guard es un safety net: solo inyecta el BUY si realmente debería estar.
      const btcAsset = rebalanceAssets.find(a => a.ticker === 'BTC-EUR');
      if (btcAsset && btcAsset.targetAllocation > 0) {
        const currentValue = btcAsset.price * btcAsset.shares;
        const currentPct = totalPortfolioValue > 0 ? currentValue / totalPortfolioValue : 0;
        const drift = currentPct - btcAsset.targetAllocation;
        const soldTickersForGuard = new Set(
          baseRebalance.suggestions.filter(s => s.action === 'SELL').map(s => s.ticker.split('.')[0])
        );
        const alreadyInBuys = baseRebalance.buySuggestions.some(s => s.ticker === 'BTC-EUR');
        // FIX-BTC-TRIM (Jul-2026): NO usar shouldTrim como bloqueo.
        // detectBTCTop SIEMPRE devuelve un signal incluso sin señal de techo,
        // y shouldTrim puede ser true por ruido en el cálculo residual de trimPct.
        // En vez de shouldTrim, usar zone: SAFE → no hay techo. CAUTION/DANGER → sí.
        const btcTopSignal = cycleTopResult.signals.find(s => s.ticker === 'BTC-EUR');
        const hasActiveCycleTop = btcTopSignal ? (btcTopSignal.zone === 'CAUTION' || btcTopSignal.zone === 'DANGER') : false;
        if (typeof console !== 'undefined') {
          console.warn('[BTC-BUY-GUARD] targetAlloc=' + btcAsset.targetAllocation.toFixed(3) + ' currentPct=' + currentPct.toFixed(4) + ' drift=' + drift.toFixed(4) + ' alreadyInBuys=' + alreadyInBuys + ' zone=' + (btcTopSignal?.zone ?? 'N/A') + ' soldBtc=' + soldTickersForGuard.has('BTC-EUR') + ' btcSh=' + currentValue.toFixed(0));
          console.warn('[BTC-BUY-GUARD] remainingCash=' + baseRebalance.remainingCash.toFixed(0) + ' buySuggestions=' + baseRebalance.buySuggestions.length + ' sellSuggestions=' + baseRebalance.suggestions.filter(s=>s.action==='SELL').length);
        }
        if (!alreadyInBuys && !hasActiveCycleTop && !soldTickersForGuard.has('BTC-EUR') && drift < -0.02 && currentValue > 0) {
          const totalValue = totalPortfolioValue + availableCash;
          const deficitValue = Math.max(0, btcAsset.targetAllocation * totalValue - currentValue);
          if (deficitValue > 0) {
            const maxAvailable = baseRebalance.remainingCash;
            if (maxAvailable <= 0) { if (typeof console !== 'undefined') console.warn('[BTC-BUY-GUARD] maxAvailable<=0, skipping'); return baseRebalance; }
            const cashForBtc = Math.min(deficitValue, maxAvailable);
            const sharesToBuy = Math.floor((cashForBtc / btcAsset.price) * 10000) / 10000;
            if (sharesToBuy > 0) {
              const cost = sharesToBuy * btcAsset.price;
              const absDrift = Math.abs(drift * 100);
              if (typeof console !== 'undefined') console.warn('[BTC-BUY-GUARD] INYECTANDO BUY: shares=' + sharesToBuy + ' cost=' + cost.toFixed(0) + ' remaining=' + (baseRebalance.remainingCash - cost).toFixed(0));
              const btcBuy: RebalanceSuggestion = {
                ticker: 'BTC-EUR', name: 'Bitcoin', action: 'BUY',
                sharesToBuy, cost,
                sharesToSell: 0, proceedsIfSold: 0, trimPct: 0,
                currentPct, targetPct: btcAsset.targetAllocation, drift,
                reason: `Infraponderado ${absDrift.toFixed(1)}pp (actual ${(currentPct * 100).toFixed(1)}% → objetivo ${(btcAsset.targetAllocation * 100).toFixed(1)}%)`,
                priority: absDrift > 10 ? 'HIGH' : 'MEDIUM',
                cycleZone: undefined, cycleIndicator: undefined, cycleIndicatorValue: undefined,
              };
              return {
                ...baseRebalance,
                suggestions: [...baseRebalance.suggestions, btcBuy],
                buySuggestions: [...baseRebalance.buySuggestions, btcBuy],
                totalCost: baseRebalance.totalCost + cost,
                remainingCash: baseRebalance.remainingCash - cost,
              };
            } else if (typeof console !== 'undefined') console.warn('[BTC-BUY-GUARD] sharesToBuy<=0: cashForBtc=' + cashForBtc.toFixed(0) + ' price=' + btcAsset.price);
          } else if (typeof console !== 'undefined') console.warn('[BTC-BUY-GUARD] deficitValue<=0: ' + deficitValue.toFixed(0));
        } else if (typeof console !== 'undefined') {
          if (alreadyInBuys) console.warn('[BTC-BUY-GUARD] SKIP: alreadyInBuys');
          else if (hasActiveCycleTop) console.warn('[BTC-BUY-GUARD] SKIP: hasActiveCycleTop zone=' + (btcTopSignal?.zone ?? 'N/A'));
          else if (soldTickersForGuard.has('BTC-EUR')) console.warn('[BTC-BUY-GUARD] SKIP: soldBTC');
          else if (!(drift < -0.02)) console.warn('[BTC-BUY-GUARD] SKIP: drift=' + drift.toFixed(4));
          else if (!(currentValue > 0)) console.warn('[BTC-BUY-GUARD] SKIP: currentValue<=0');
        }
      } else if (typeof console !== 'undefined') console.warn('[BTC-BUY-GUARD] SKIP: btcAsset null or target<=0');
      return baseRebalance;
    }
    // ALL_CASH branch: liquidar todo
    const liquidationSells: typeof baseRebalance.suggestions = [];
    for (const asset of rebalanceAssets) {
      if (asset.shares <= 0 || asset.price <= 0) continue;
      const sharesToSell = asset.ticker === "BTC-EUR"
        ? Math.floor(asset.shares * 10000) / 10000
        : Math.floor(asset.shares);
      if (sharesToSell <= 0) continue;
      // #2: drift = currentPct - targetPct; targetPct=0 → drift = currentPct (no constante 100%)
      const liqCurrentPct = (asset.shares * asset.price) / Math.max(totalPortfolioValue, 1);
      liquidationSells.push({
        ticker: asset.ticker, name: asset.name, action: "SELL",
        sharesToBuy: 0, cost: 0,
        sharesToSell,
        proceedsIfSold: sharesToSell * asset.price,
        trimPct: 100,
        currentPct: liqCurrentPct,
        targetPct: 0, drift: liqCurrentPct, // rbalancer(): drift = currentPct - targetPct = currentPct (target=0)
        priority: "HIGH",
        reason: `🚨 ALL_CASH — liquidación total ${asset.name} (régimen motor en pánico máximo)`,
        cycleZone: "EXTREME", // marca explícita que es signal de crisis, no de techo de ciclo
      });
    }
    const totalProceeds = liquidationSells.reduce((s, r) => s + r.proceedsIfSold, 0);
    return {
      suggestions: liquidationSells,
      sellSuggestions: liquidationSells,
      buySuggestions: [],
      totalCost: 0,
      totalProceeds,
      remainingCash: availableCash + totalProceeds,
      // #3: isFullyFunded en rebalancer.ts = "BUYs cubiertos por cash". En liquidación no hay BUYs
      // → marcar false honestamente (no true para evitar badges confusos en dashboard).
      coverageRatio: 0,
      isFullyFunded: false,
    };
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

  const expectedReturn = useMemo(() => {
    if (!engineResult) return 0.07;
    const regimePenalty = engineResult.masterRegime.regimePenalty ?? 1;

    if (marketData?.expectedReturns && marketData.expectedReturns.length > 0) {
      // FIX-MC-MLE: usar mleReturns (MLE sin shrinkage) para Monte Carlo.
      // James-Stein es para el optimizador (evitar over-betting).
      // Monte Carlo proyecta con la mejor estimación forward-looking: μ histórico real.
      const muSource = marketData.mleReturns && marketData.mleReturns.length > 0
        ? marketData.mleReturns
        : marketData.expectedReturns;
      const weightedJS = ASSETS.reduce((acc, ticker, i) => {
        const alloc = engineResult.allocations.find(
          a => a.name === portfolio.assets.find(p => p.ticker === ticker)?.name
        );
        const w = alloc?.finalAllocation ?? (1 / ASSETS.length);
        const mu = muSource[i] ?? 0.08;
        return acc + mu * w;
      }, 0);
      const capped = Math.min(0.25, Math.max(0.01, weightedJS));
      return capped * regimePenalty;
    }

    const weightedHardcoded = engineResult.allocations.reduce((acc, alloc) => {
      const asset = portfolio.assets.find(a => a.name === alloc.name);
      const r = asset ? (asset.expectedReturn / 100) : 0.10;
      return acc + r * alloc.finalAllocation;
    }, 0);
    const capped = Math.min(0.25, Math.max(0.01, weightedHardcoded));
    return capped * regimePenalty;
  }, [engineResult, portfolio.assets, marketData?.expectedReturns]);

  const portfolioVol = portfolioRealizedVol
    ?? portfolio.assets.reduce(
      (acc, asset) => acc + (asset.volatility / 100) * (asset.price * asset.shares / totalPortfolioValue),
      0
    );

  const jumpSim = useMemo(() => {
    const muCapped = Math.min(0.25, expectedReturn);
    // FIX-MC-CASH: incluir cashReserve en proyecciones Monte Carlo.
    // El cash no crece ni se deprecia. Se suma flat al final de cada simulacion.
    // mu y sigma se diluyen proporcionalmente para no sobreestimar retornos.
    const totalEquity = totalPortfolioValue + cashReserve;
    const investedFraction = totalEquity > 0 ? totalPortfolioValue / totalEquity : 1;
    const monthlyInvested = monthlyInjection * investedFraction;
    const monthlyCash = monthlyInjection * (1 - investedFraction);
    const totalMonths = years * 12;
    const accumulatedFlatCash = cashReserve + monthlyCash * totalMonths;

    const hasCovMatrix = marketData?.covMatrix && marketData.covMatrix.length > 1;
    const hasEngineAllocs = engineResult && engineResult.allocations.length > 0;

    if (hasCovMatrix && hasEngineAllocs && ASSETS.length > 1) {
      // COMPOSITE STRATEGY: pesos compuestos con BTC satellite para Monte Carlo
      const olyPct = olympusPct / 100;
      const btcSat = (100 - olympusPct) / 100;
      const btcIdx = ASSETS.indexOf('BTC-EUR' as any);
      const weights = ASSETS.map((ticker, i) => {
        const alloc = engineResult!.allocations.find(a => a.name === portfolio.assets.find(p => p.ticker === ticker)?.name);
        const engineW = alloc?.finalAllocation ?? (1 / ASSETS.length);
        return i === btcIdx ? (engineW * olyPct) + btcSat : engineW * olyPct;
      });
      const mus = ASSETS.map((_, i) => {
        // FIX-MC-MLE: ruta multivariante también usa mleReturns (sin shrinkage)
        const raw = marketData!.mleReturns?.[i] ?? marketData!.expectedReturns?.[i] ?? muCapped;
        return Math.min(0.25, Math.max(-0.05, raw));
      });
      const sigmas = ASSETS.map((_, i) => (marketData!.realizedVols?.[i] ?? portfolioVol));

      // FIX-MC-CASH: usar monthlyInvested (solo parte invertida) y sumar cash al final
      const multiResult = monteCarloJumpDiffusion(
        totalPortfolioValue, monthlyInvested, muCapped, portfolioVol,
        jumpIntensity, jumpMean, jumpStd, years, 10000,
        {
          weights, mus, sigmas,
          covMatrix: marketData!.covMatrix,
          jumpIntensityBTC: jumpIntensity,
          jumpMean, jumpStd,
          btcIdx: btcIdx >= 0 ? btcIdx : -1,  // FIX-MC-02: -1 = sin BTC
        },
        !enableJumps  // FIX-MC-05: disableJumps = !enableJumps
      );
      multiResult.simulations = multiResult.simulations.map(function(v) { return v + accumulatedFlatCash; });
      multiResult.mean += accumulatedFlatCash;
      multiResult.median += accumulatedFlatCash;
      multiResult.p25 += accumulatedFlatCash;
      multiResult.p75 += accumulatedFlatCash;
      multiResult.worst5 += accumulatedFlatCash;
      multiResult.best95 += accumulatedFlatCash;
      return multiResult;
    }

    // FIX-MC-CASH: modelar SOLO la parte invertida (no diluir mu/sigma).
    // El cash no crece → se modela aparte y se suma flat al final.
    // Usar totalPortfolioValue (solo activos) + monthlyInvested (parte invertida
    // de la aportacion). mu/sigma SIN diluir porque aplican solo a lo invertido.
    const uniResult = monteCarloJumpDiffusion(
      totalPortfolioValue, monthlyInvested,
      muCapped, portfolioVol,
      jumpIntensityPortfolio, jumpMean, jumpStd, years, 10000,
      undefined,
      !enableJumps  // FIX-MC-05: disableJumps = !enableJumps
    );
    uniResult.simulations = uniResult.simulations.map(function(v) { return v + accumulatedFlatCash; });
    uniResult.mean += accumulatedFlatCash;
    uniResult.median += accumulatedFlatCash;
    uniResult.p25 += accumulatedFlatCash;
    uniResult.p75 += accumulatedFlatCash;
    uniResult.worst5 += accumulatedFlatCash;
    uniResult.best95 += accumulatedFlatCash;
    return uniResult;
  }, [totalPortfolioValue, cashReserve, monthlyInjection, expectedReturn, portfolioVol,
    jumpIntensity, jumpIntensityPortfolio, jumpMean, jumpStd, years,
    marketData?.covMatrix, marketData?.expectedReturns, engineResult, enableJumps, cashReserve, olympusPct]);  // FIX-MC-05 + FIX-MC-CASH: cashReserve en deps + olympusPct para composite

  const { mean: meanValue, median: medianValue, p25, p75, worst5, best95, simulations } = jumpSim;

  const cvarResult = useMemo(() => {
    if (simulations.length === 0) return null;
    // FIX-MC-CASH: incluir cashReserve en el capital total invertido para CVaR
    const totalInvested = totalPortfolioValue + cashReserve + monthlyInjection * 12 * years;
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

    const dailyPortfolioReturns: number[] = [];
    if (portfolio.assets.length > 0 && portfolio.assets[0].history.length > 1) {
      const totalVal = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);
      const numDays = portfolio.assets[0].history.length;
      for (let t = 1; t < numDays; t++) {
        let dayRet = 0;
        for (const asset of portfolio.assets) {
          if (asset.history[t] && asset.history[t - 1]) {
            const w = (asset.price * asset.shares) / (totalVal || 1);
            dayRet += w * (asset.history[t] / asset.history[t - 1] - 1);
          }
        }
        dailyPortfolioReturns.push(dayRet);
      }
    }
    const sortino = dailyPortfolioReturns.length >= 10
      ? sortinoRatioReal(dailyPortfolioReturns, annualReturn, rf)
      : excessReturn / (portfolioVol / Math.sqrt(2));

    const benchmarkAsset = portfolio.assets.find(a => a.ticker === '0P00000WLG.F');
    let beta = 1.0, alpha = 0;
    if (benchmarkAsset && benchmarkAsset.history.length > 20 && dailyPortfolioReturns.length > 20) {
      const benchReturns: number[] = [];
      for (let t = 1; t < benchmarkAsset.history.length; t++) {
        if (benchmarkAsset.history[t] && benchmarkAsset.history[t - 1]) {
          benchReturns.push(benchmarkAsset.history[t] / benchmarkAsset.history[t - 1] - 1);
        }
      }
      if (benchReturns.length >= 20) {
        beta = betaVsBenchmark(dailyPortfolioReturns, benchReturns);
        const benchAnnualReturn = benchReturns.reduce((a, b) => a + b, 0) / benchReturns.length * 252;
        alpha = jensenAlpha(annualReturn, beta, benchAnnualReturn, rf);
      }
    }

    const hasCovMatrix = marketData?.covMatrix && marketData.covMatrix.length > 1;
    const mcRoute = hasCovMatrix ? "✅ Multivariante (Cholesky + correlaciones reales)" : "⚠️ Univariante (fallback — sin covMatrix)";

    const MAX_HISTORICAL_DD = 0.50;
    const effectiveMaxDD = Math.min(Math.abs(portfolioDrawdown), MAX_HISTORICAL_DD);
    const calmar = effectiveMaxDD > 0 ? annualReturn / effectiveMaxDD : 0;
    return { sharpe, sortino, calmar, annualReturn, rf, portfolioVol, beta, alpha, mcRoute, hasCovMatrix };
  }, [portfolioVol, expectedReturn, portfolio.riskFreeRate, portfolioDrawdown, portfolio.assets, marketData?.covMatrix]);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard (Olympus Engine V3+)</h1>

      {/* PERSIST-04: Banner de sesión anterior — aparece al abrir el motor si hay datos guardados */}
      {showSessionBanner && (
        <div style={{
          background: '#0f1f38', border: '1.5px solid #3b82f6', borderRadius: '10px',
          padding: '16px 20px', marginBottom: '16px', color: '#e2e8f0',
        }}>
          {/* Cabecera */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ fontWeight: 700, color: '#60a5fa', fontSize: '0.95rem' }}>
              📂 Cartera restaurada desde la última sesión
              {lastSavedAt && (
                <span style={{ fontWeight: 400, color: '#64748b', marginLeft: '8px', fontSize: '0.78rem' }}>
                  Guardada el {lastSavedAt}
                </span>
              )}
            </div>
            <button
              onClick={() => setShowSessionBanner(false)}
              style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: '6px', padding: '7px 16px', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600 }}
            >
              ✓ Todo correcto — continuar
            </button>
          </div>

          {/* Instrucción */}
          <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '12px', background: '#1e3a5f', padding: '7px 10px', borderRadius: '6px' }}>
            ⚠️ <strong style={{ color: '#e2e8f0' }}>Revisa cada dato.</strong> Si algo no es correcto, cámbialo directamente aquí antes de continuar. Los cambios se guardan solos.
          </div>

          {/* Tabla de activos editable */}
          <div style={{ overflowX: 'auto', marginBottom: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ color: '#64748b', borderBottom: '1px solid #1e3a5f' }}>
                  <th style={{ textAlign: 'left',  padding: '4px 8px' }}>Activo</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>Acciones actuales</th>
                  <th style={{ textAlign: 'center', padding: '4px 4px', color: '#94a3b8' }}>→</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', color: '#fbbf24' }}>Corregir acciones</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px' }}>Precio medio actual</th>
                  <th style={{ textAlign: 'center', padding: '4px 4px', color: '#94a3b8' }}>→</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', color: '#fbbf24' }}>Corregir precio medio</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.assets.map(asset => (
                  <tr key={asset.ticker} style={{ borderBottom: '1px solid #1e3a5f' }}>
                    <td style={{ padding: '5px 8px', color: '#cbd5e1', fontWeight: 600 }}>
                      {asset.name}
                      <span style={{ color: '#475569', fontWeight: 400, marginLeft: '6px', fontSize: '0.72rem' }}>{asset.ticker}</span>
                    </td>
                    {/* Acciones guardadas (solo lectura) */}
                    <td style={{ textAlign: 'right', padding: '5px 8px', color: '#94a3b8' }}>
                      {asset.ticker === 'BTC-EUR' ? asset.shares.toFixed(6) : asset.shares}
                    </td>
                    <td style={{ textAlign: 'center', color: '#374151' }}>→</td>
                    {/* Acciones corregibles */}
                    <td style={{ textAlign: 'right', padding: '5px 8px' }}>
                      <input
                        type="number"
                        defaultValue={asset.ticker === 'BTC-EUR' ? asset.shares.toFixed(6) : asset.shares}
                        step={asset.ticker === 'BTC-EUR' ? '0.000001' : '1'}
                        min={0}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (!isNaN(val) && val !== asset.shares) {
                            setPortfolio(prev => ({
                              ...prev,
                              assets: prev.assets.map(a =>
                                a.ticker === asset.ticker ? { ...a, shares: val } : a
                              )
                            }));
                          }
                        }}
                        style={{
                          width: '90px', background: '#1e293b', border: '1px solid #f59e0b',
                          color: '#fbbf24', borderRadius: '4px', padding: '3px 6px',
                          fontSize: '0.82rem', textAlign: 'right',
                        }}
                      />
                    </td>
                    {/* Precio medio guardado (solo lectura) */}
                    <td style={{ textAlign: 'right', padding: '5px 8px', color: '#94a3b8' }}>
                      €{asset.avgPrice.toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'center', color: '#374151' }}>→</td>
                    {/* Precio medio corregible */}
                    <td style={{ textAlign: 'right', padding: '5px 8px' }}>
                      <input
                        type="number"
                        defaultValue={asset.avgPrice.toFixed(2)}
                        step="0.01"
                        min={0}
                        onBlur={(e) => {
                          const val = Number(e.target.value);
                          if (!isNaN(val) && val > 0 && val !== asset.avgPrice) {
                            setPortfolio(prev => ({
                              ...prev,
                              assets: prev.assets.map(a =>
                                a.ticker === asset.ticker ? { ...a, avgPrice: val } : a
                              )
                            }));
                          }
                        }}
                        style={{
                          width: '90px', background: '#1e293b', border: '1px solid #f59e0b',
                          color: '#fbbf24', borderRadius: '4px', padding: '3px 6px',
                          fontSize: '0.82rem', textAlign: 'right',
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cash editable */}
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-end', padding: '10px 12px', background: '#1e293b', borderRadius: '7px' }}>
            <div>
              <label style={{ fontSize: '0.72rem', color: '#94a3b8', display: 'block', marginBottom: '3px' }}>
                💵 Cash en broker
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.75rem', color: '#475569' }}>€</span>
                <input
                  type="number" value={cashReserve} min={0} step={10}
                  onChange={(e) => setCashReserve(Math.max(0, Number(e.target.value)))}
                  style={{ width: '100px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fbbf24', borderRadius: '4px', padding: '4px 8px', fontSize: '0.85rem' }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: '0.72rem', color: '#94a3b8', display: 'block', marginBottom: '3px' }}>
                🛡 Liquidez defensiva
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.75rem', color: '#475569' }}>€</span>
                <input
                  type="number" value={defensiveLiquidity} min={0} step={10}
                  onChange={(e) => {
                    const val = Math.max(0, Number(e.target.value));
                    setDefensiveLiquidity(val);
                    try { localStorage.setItem('olympus_defensive_liq', String(val)); } catch {}
                  }}
                  style={{ width: '100px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fbbf24', borderRadius: '4px', padding: '4px 8px', fontSize: '0.85rem' }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: '0.72rem', color: '#94a3b8', display: 'block', marginBottom: '3px' }}>
                📅 Aportación mensual (proyecciones)
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '0.75rem', color: '#475569' }}>€</span>
                <input
                  type="number" value={monthlyInjection} min={0} step={50}
                  onChange={(e) => setMonthlyInjection(Math.max(0, Number(e.target.value)))}
                  style={{ width: '100px', background: '#0f172a', border: '1px solid #475569', color: '#94a3b8', borderRadius: '4px', padding: '4px 8px', fontSize: '0.85rem' }}
                />
              </div>
            </div>
            <div style={{ fontSize: '0.72rem', color: '#4b5563', maxWidth: '200px', lineHeight: '1.5' }}>
              Cualquier cambio se guarda automáticamente. Cuando todo esté correcto pulsa "✓ Todo correcto".
            </div>
          </div>
        </div>
      )}

      {/* PERSIST-05: Indicador de guardado automático — siempre visible arriba a la derecha */}
      {lastSavedAt && !showSessionBanner && (
        <div style={{ fontSize: '0.72rem', color: '#475569', textAlign: 'right', marginBottom: '8px' }}>
          💾 Guardado automáticamente · {lastSavedAt}
        </div>
      )}

      <div style={{ marginBottom: "20px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => refreshMarketData(true)} style={styles.button} disabled={loading}>
          {loading ? "Actualizando..." : "🔄 Actualizar precios y datos macro"}
        </button>



        <button
          onClick={() => { clearAll(); window.location.reload(); }}
          style={{ ...styles.button, backgroundColor: "#374151", fontSize: "0.8rem" }}
        >
          🗑️ Borrar datos guardados
        </button>
        
        {/* FEAT: USD/EUR currency toggle */}
        <button
          onClick={() => setDisplayCurrency(c => c === "EUR" ? "USD" : "EUR")}
          style={{
            ...styles.button,
            backgroundColor: displayCurrency === "USD" ? "#1e40af" : "#374151",
            fontSize: "0.85rem",
            minWidth: "80px",
          }}
          title={"Mostrar en " + (displayCurrency === "EUR" ? "USD" : "EUR") + " (EUR/USD = " + eurUsdRate.toFixed(4) + ")"}
        >
          {displayCurrency === "EUR" ? "💶 EUR" : "💵 USD"}
        </button>

        {/* FEAT: CSV export button */}
        <button
          onClick={() => {
            if (!marketData || !engineResult) return;
            const csv = generateAuditCSV({
              marketData,
              portfolioValue: totalPortfolioValue,
              cashReserve,
              defensiveLiquidity,
              regime: engineResult.regime,
              allocations: engineResult.allocations.map(a => {
                const asset = portfolio.assets.find(pa => pa.name === a.name);
                return { name: a.name, ticker: asset?.ticker ?? a.name, finalAllocation: a.finalAllocation, price: asset?.price ?? 0 };
              }),
              shares: portfolio.assets.map(a => ({ ticker: a.ticker, name: a.name, shares: a.shares, avgPrice: a.avgPrice })),
            });
            downloadCSV(csv);
          }}
          style={{
            ...styles.button,
            backgroundColor: "#1e3a5f",
            fontSize: "0.8rem",
            border: "1px solid #3b82f6",
          }}
          disabled={!marketData || !engineResult}
          title="Exportar datos de mercado a CSV para auditoria externa"
        >
          CSV Auditoria
        </button>


      </div>
      {apiError && <div style={{ color: "#ef4444", marginBottom: "10px" }}>{apiError}</div>}

      {engineResult && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "0.5rem",
          marginBottom: "1.5rem",
        }}>
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
            
            <div style={{ marginTop: "4px" }}>
              <button
                onClick={() => {
                  if (regimeLock) {
                    clearRegimeLock();
                    setRegimeLockState(null);
                  } else {
                    setRegimeLock(engineResult.regime as any, engineResult.masterRegime.regimePenalty);
                    setRegimeLockState(isRegimeLocked());
                  }
                }}
                style={{
                  background: regimeLock ? "#b45309" : "#374151",
                  border: "1px solid " + (regimeLock ? "#f59e0b" : "#4b5563"),
                  color: regimeLock ? "#fbbf24" : "#9ca3af",
                  borderRadius: "5px",
                  padding: "2px 8px",
                  cursor: "pointer",
                  fontSize: "0.68rem",
                  fontWeight: 600,
                  width: "100%",
                }}
                title={regimeLock ? "Régimen congelado. Pulsa para desbloquear." : "Congela el régimen actual mientras actualizas datos manualmente (auto-unlock 30 min)"}
              >
                {regimeLock ? "🔒 Regimen Bloqueado" : "🔓 Lock Regime"}
              </button>
            </div></div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>VIX <span style={{ color: "#f59e0b" }}>● auto</span></div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: vix > 30 ? "#ef4444" : vix > 20 ? "#f59e0b" : "#10b981"
            }}>{vix.toFixed(1)}</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              {vix > 30 ? "Pánico" : vix > 20 ? "Tensión" : "Normalidad"}
            </div>
          </div>

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

          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>μ MONTE CARLO</div>
            <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#818cf8" }}>
              {(Math.min(0.25, expectedReturn) * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              MLE histórico (sin shrinkage) · cap 25%
            </div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>σ PORTFOLIO</div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: portfolioVol > 0.22 ? "#ef4444" : portfolioVol > 0.16 ? "#f59e0b" : "#10b981"
            }}>{(portfolioVol * 100).toFixed(1)}%</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>volatilidad realizada</div>
          </div>

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

          <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>LIQUIDEZ <span style={{ color: "#f59e0b" }}>● auto</span></div>
            <div style={{
              fontSize: "1.1rem", fontWeight: "bold",
              color: liquidity > 0.6 ? "#10b981" : liquidity > 0.35 ? "#f59e0b" : "#ef4444"
            }}>{(liquidity * 100).toFixed(0)}%</div>
            <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
              {liquidity > 0.6 ? "Expansiva" : liquidity > 0.35 ? "Neutral" : "Restrictiva"}
              {liquidityOutput && (
                <span style={{ color: liquidityOutput.regime === 'EXPANSION' ? '#10b981' : liquidityOutput.regime === 'CONTRACTION' ? '#ef4444' : '#f59e0b', marginLeft: '4px' }}>
                  · {liquidityOutput.regime === 'EXPANSION' ? 'CB Exp' : liquidityOutput.regime === 'CONTRACTION' ? 'CB Cont' : 'CB Neu'}
                </span>
              )}
            </div>
          </div>

          {fearGreedIndex && (
            <div style={{
              background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem"
            }}>
              <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>FEAR & GREED <span style={{ color: "#f59e0b" }}>● auto</span></div>
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

          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>ON-CHAIN</div>
            <div style={{ fontSize: "0.75rem", color: onChainSource === "GLASSNODE" ? "#10b981" : "#f59e0b", fontWeight: "bold" }}>
              {onChainSource === "GLASSNODE" ? "✅ Glassnode" : "⚠️ Manual"}
            </div>
            <div style={{ fontSize: "0.62rem", color: "#6b7280" }}>
              {onChainSource === "GLASSNODE" ? "MVRV · Puell · Hash Ribbon auto" : "configurar GLASSNODE_API_KEY"}
            </div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: "0.6rem 0.9rem" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>FUENTE DATOS</div>
            <div style={{ fontSize: "0.75rem", color: "#d1d5db", fontWeight: "bold" }}>
              {marketData ? "✅ Yahoo Finance" : "⚠️ Manual"}
            </div>
            <div style={{ fontSize: "0.62rem", color: "#6b7280" }}>
              {marketData ? "precios + covMatrix reales" : "pendiente actualización"}
            </div>
          </div>
          <div style={{ background: olympusPct < 100 ? "#1a1a0a" : "#111827", border: olympusPct < 100 ? "2px solid #f59e0b" : "1px solid #374151", borderRadius: 8, padding: "0.6rem 0.9rem", gridColumn: "span 2" }}>
            <div style={{ fontSize: "0.65rem", color: "#6b7280", marginBottom: 2 }}>🚀 COMPOSITE STRATEGY</div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
              <span style={{ color: "#818cf8", fontSize: "0.75rem", fontWeight: "bold" }}>{olympusPct}% Olympus</span>
              <input type="range" min={0} max={100} value={olympusPct} onChange={e => setOlympusPct(Number(e.target.value))} style={{ flex: 1, accentColor: "#6366f1", height: 6 }} />
              <span style={{ color: "#f59e0b", fontSize: "0.75rem", fontWeight: "bold" }}>{100 - olympusPct}% BTC</span>
            </div>
            <div style={{ fontSize: "0.58rem", color: olympusPct < 100 ? "#f59e0b" : "#6b7280" }}>
              {olympusPct === 100 ? "100% motor — sin BTC satellite" : olympusPct + "% motor + " + (100-olympusPct) + "% BTC buy & hold"}
            </div>
          </div>
        </div>
      )}

      <div style={{ ...styles.card, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem" }}>
        <div>
          <label style={styles.label}>P/E Ratio S&P 500 (TTM) {" "}
            <span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● manual</span>
          </label>
          <input type="number" value={manualPER} onChange={(e) => setManualPER(Number(e.target.value))} style={styles.smallInput} step="0.1" min="1" />
        </div>
        <div>
          <label style={styles.label}>Bono USA 10y % {" "}<span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● Yahoo auto</span></label>
          <input type="number" value={manualBond10y} onChange={(e) => setManualBond10y(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
        </div>
        <div>
          <label style={styles.label}>Bono USA 2y % {" "}<span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● manual</span></label>
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
            <span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● manual</span>
          </label>
          <input type="number" value={creditSpread} onChange={(e) => setCreditSpread(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>VIX {" "}<span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● Yahoo auto</span></label>
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
          <label style={styles.label}>Liquidez Global % <span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● manual (Fed+ECB)</span></label>
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
              : wtiOil >= 95 ? "🟠 SHOCK GEOPOLÍTICO — penalización ×0.70 al motor"
              : wtiOil >= 75 ? "🟡 Tensión elevada — penalización ×0.85 al motor"
              : "🟢 Normal — sin penalización por petróleo"}
          </p>
        </div>
        <div>
          <label style={styles.label}>Volatilidad BTC{" "}
            <span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● auto blend (PASO 3)</span>
          </label>
          <input type="number" value={btcVol} onChange={(e) => setBtcVol(Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="2" />
          <label style={styles.label}>BTC Dominance %{" "}
            <span style={{ fontSize: "0.65rem", color: "#f59e0b", fontWeight: "normal" }}>● manual</span>
          </label>
          <input type="number" value={btcDominance} onChange={(e) => setBtcDominance(Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" max="100" />
          <label style={styles.label}>MVRV Ratio{" "}
            <span style={{ fontSize: "0.65rem", color: onChainSource === "GLASSNODE" ? "#10b981" : "#ef4444", fontWeight: "normal" }}>
              {onChainSource === "GLASSNODE" ? "● Glassnode auto (PASO 4)" : "● manual — lookintobitcoin.com"}
            </span>
          </label>
          <input type="number" value={mvrvRatio} onChange={(e) => setMvrvRatio(Number(e.target.value))} style={styles.smallInput} step="0.01" min="0" max="10" />
          <label style={styles.label}>MVRV Z-Score{" "}
            <span style={{ fontSize: "0.65rem", color: "#ef4444", fontWeight: "normal" }}>
              ● manual — Glassnode (Z &gt;7 techo, Z &lt;0 suelo)
            </span>
          </label>
          <input type="number" value={mvrvZScore ?? ""} onChange={(e) => { const v = e.target.value === "" ? undefined : Number(e.target.value); setMvrvZScore(v); if (v !== undefined) try { localStorage.setItem(MVRV_ZSCORE_TS_KEY, Date.now().toString()); } catch {} }} style={styles.smallInput} step="0.01" min="-3" max="10" placeholder="— ej: 0.5" />
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
            <div>
  <label style={styles.label}>Semis SIA Sales YoY% {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>SIA/WSTS mensual</span></label>
  <input type="number" placeholder="—" value={siaSalesYoY ?? ""} onChange={e => setSiaSalesYoY(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.1" />
</div>
<div>
  <label style={styles.label}>SOX RSI Semanal {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>TradingView: ^SOX · W · RSI(14)</span></label>
  <input type="number" placeholder="—" value={soxRsiWeekly ?? ""} onChange={e => setSoxRsiWeekly(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
</div>
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
            <div>
              <label style={styles.label}>WLG RSI Semanal {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>TradingView: URTH · W · RSI(14)</span></label>
              <input type="number" placeholder="—" value={wlgRsiWeekly ?? ""} onChange={e => setWlgRsiWeekly(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
            </div>
            <div>
              <label style={styles.label}>WLG P/E Ratio {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>TradingView: URTH · P/E (TTM)</span></label>
              <input type="number" placeholder="—" value={wlgPERatio ?? ""} onChange={e => setWlgPERatio(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
            </div>
            <div>
              <label style={styles.label}>EMXC RSI Semanal {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>TradingView: EMXC.DE · W · RSI(14)</span></label>
              <input type="number" placeholder="—" value={emxcRsiWeekly ?? ""} onChange={e => setEmxcRsiWeekly(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
            </div>
            <div>
              <label style={styles.label}>EMXC P/E Ratio {" "}<span style={{ fontSize: "0.6rem", color: "#6b7280" }}>TradingView: EMXC.DE · P/E (TTM)</span></label>
              <input type="number" placeholder="—" value={emxcPERatio ?? ""} onChange={e => setEmxcPERatio(e.target.value === "" ? undefined : Number(e.target.value))} style={styles.smallInput} step="0.1" min="0" />
            </div>
          </div>
        </div>

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
                <span style={{ fontSize: "0.6rem", color: "#ef4444", display: "block" }}>● {marketData?.covMatrix ? "multivariante (Cholesky activo)" : "modo univariante"}</span>
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
                Jump Mean (% multiplicativo)
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
            <div style={{ marginTop: "0.6rem", padding: "0.4rem 0.6rem", background: enableJumps ? "#1c0a0a" : "#071c10", borderRadius: "6px", border: `1px solid ${enableJumps ? "#ef4444" : "#10b981"}` }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.68rem", color: "#d1d5db", fontWeight: 600 }}>
                <input type="checkbox" checked={enableJumps} onChange={(e) => setEnableJumps(e.target.checked)}
                  style={{ width: "14px", height: "14px", accentColor: "#10b981", cursor: "pointer" }} />
                {enableJumps ? "🔴 Jump Diffusion (Stress Test)" : "🟢 GBM Puro (Proyección de crecimiento)"}
              </label>
              <p style={{ fontSize: "0.55rem", color: "#6b7280", margin: "0.15rem 0 0" }}>
                {enableJumps 
                  ? "Incluye crashes aleatorios — muestra riesgo de cola, no crecimiento esperado."
                  : "Sin saltos — muestra el crecimiento real compuesto al μ anual declarado."}
              </p>
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
              <p style={{ fontSize: "0.65rem", color: "#f59e0b", margin: "0.2rem 0 0" }}>
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
            const isBlocked = dca?.action.startsWith("BLOCK");
            const actionColor = isBlocked ? "#ef4444" : dca?.action === "WAIT" ? "#6b7280" : dca?.action === "SMALL_BUY" ? "#f59e0b" : dca?.action === "BUY" ? "#10b981" : "#6366f1";
            return (
              <>
                <p>Acción: <strong style={{ color: actionColor }}>{dca?.action}</strong></p>
                {isBlocked
                  ? <p style={{ color: "#ef4444", fontSize: "0.8rem" }}>{dca?.blockReason}</p>
                  : <>
                    <p>Invertir: <strong>{formatCurrency(dca?.totalCashToInvest ?? 0)}</strong> ({((dca?.buyFraction ?? 0) * 100).toFixed(0)}%)</p>
                    <p style={{ color: "#9ca3af", fontSize: "0.78rem" }}>{dca?.reasoning}</p>
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
              {/* MEJORA-3: Explicar override cuando el modelo probabilístico y el régimen final difieren */}
              {(() => {
                const probRegime = engineResult.masterRegime.regimeProbs;
                const finalRegime = engineResult.regime;
                const probModel = probRegime
                  ? (probRegime.expansion > 0.5 ? 'EXPANSION' : probRegime.crisis > 0.3 ? 'CRISIS' : 'CONTRACTION')
                  : null;
                const hasOverride = probModel && probModel !== finalRegime && finalRegime !== 'ALL_CASH';
                const wtiShock = engineResult.masterRegime.stressDetail?.wtiShock !== 'NONE';
                const creditHigh = creditSpread > 3.5;
                const overrideReasons = [
                  wtiShock && `WTI geopolítico ×${engineResult.masterRegime.stressDetail?.wtiPenalty?.toFixed(2)}`,
                  creditHigh && `Credit spread ${creditSpread.toFixed(2)}% (>3.5% umbral crisis)`,
                  engineResult.meta.dominantSignal === 'STRESS_MODEL' && 'Stress model activo',
                ].filter(Boolean).join(' + ');
                return hasOverride ? (
                  <div style={{ marginTop: '6px', padding: '7px 10px', background: '#1c1506', borderRadius: '6px', border: '1px solid #d97706' }}>
                    <div style={{ fontSize: '0.72rem', color: '#f59e0b', fontWeight: 700, marginBottom: '3px' }}>
                      ⚠️ Override de régimen activo
                    </div>
                    <div style={{ fontSize: '0.70rem', color: '#d97706', lineHeight: 1.6 }}>
                      Modelo probabilístico → <strong style={{ color: '#fbbf24' }}>{probModel}</strong>
                      {' '}pero régimen final → <strong style={{ color: '#ef4444' }}>{finalRegime}</strong>
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#92400e', marginTop: '2px' }}>
                      Motivo del override: {overrideReasons || 'modelo más conservador'}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: '#78350f', marginTop: '2px' }}>
                      Regla: el modelo más conservador de los 3 determina el régimen final.
                    </div>
                  </div>
                ) : (
                  <p style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '4px' }}>
                    ⓘ Modelo probabilístico y régimen final coinciden. Sin override activo.
                  </p>
                );
              })()}
              <p><strong>Penalización régimen:</strong> <span style={{ color: "#f59e0b" }}>×{engineResult.masterRegime.regimePenalty.toFixed(3)}</span></p>
              <p style={{ fontSize: "0.7rem", color: "#9ca3af", marginTop: "4px" }}>
                <strong>p(exp/cont/crisis): {(engineResult.masterRegime.regimeProbs.expansion * 100).toFixed(0)}% / {(engineResult.masterRegime.regimeProbs.contraction * 100).toFixed(0)}% / {(engineResult.masterRegime.regimeProbs.crisis * 100).toFixed(0)}%</strong>
                <br />
                <span style={{ color: "#6b7280" }}>
                  ⓘ Modelo VIX+M2+Yield (probabilístico). El régimen final combina éste + 
                  credit spreads + WTI shock. El más conservador de los 3 modelos determina el régimen.
                  Penalización = 40% modelo binario + 60% modelo continuo.
                </span>
              </p>
              <p><strong>Penalización correlación:</strong> ×{engineResult.correlationPenalty.toFixed(2)}</p>
              <p><strong>Vol Target:</strong> ×{engineResult.volTargetMultiplier.toFixed(2)}</p>
              {engineResult.tailRiskActive && (
                <p style={{ color: "#ef4444", fontSize: "0.8rem" }}>⚠️ Tail Risk: ×{engineResult.tailRiskOverlay.toFixed(2)} — {engineResult.tailRiskReason}</p>
              )}
              <p style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                Blend: {(() => {
                  const wfoActive = walkForwardResult?.overfittingRisk === 'HIGH';
                  const isAggressive = engineResult.regime === 'EXPANSION';
                  if (engineResult.meta.hasRealCovMatrix) {
                    if (wfoActive) return "BL×0.20 + HRP×0.55 + MinVar×0.25 (WFO anti-overfitting)";
                    return isAggressive
                      ? "BL×0.40 + HRP×0.40 + MinVar×0.20 (aggressive)"
                      : "BL×0.20 + HRP×0.65 + MinVar×0.15 (conservative)";
                  }
                  return isAggressive
                    ? "KellyNorm×0.40 + HRP×0.60 (sin covMatrix)"
                    : "KellyNorm×0.25 + HRP×0.75 (sin covMatrix)";
                })()}
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


      <BacktestPanel
        marketData={marketData}
        currentVix={vix}
        currentCreditSpread={creditSpread}
        portfolioInitialValue={totalPortfolioValue}
        erpValue={erpValue}
        avgCorrelation={dynamicCovResult?.avgCorrelation}
        olympusPct={olympusPct}
        setOlympusPct={setOlympusPct}
      />

      {portfolioAnalytics && (
        <div style={styles.card}>
          <h2>📊 Portfolio Analytics (Forward-Looking)</h2>
          <p style={{ fontSize: "0.72rem", color: "#6b7280", marginTop: "-0.3rem", marginBottom: "0.75rem" }}>
            Estimaciones forward-looking basadas en condiciones actuales de mercado — no es backtest histórico.
            Sharpe, Sortino y Alpha usan el expected return estimado (μ), no retornos realizados.
          </p>
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
              <button
                onClick={handleResetHWM}
                title="Resetear High-Water Mark al valor actual"
                style={{
                  marginTop: "0.4rem",
                  padding: "0.2rem 0.5rem",
                  fontSize: "0.65rem",
                  background: "transparent",
                  color: "#6b7280",
                  border: "1px solid #374151",
                  borderRadius: "0.25rem",
                  cursor: "pointer",
                }}
              >
                ↺ Reset HWM
              </button>
            </div>
            <div style={{ background: "#1f2937", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Retorno Esp. (ajust. régimen)</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: expectedReturn >= 0.08 ? "#10b981" : expectedReturn >= 0.03 ? "#f59e0b" : "#ef4444" }}>
                {(expectedReturn * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>×{(engineResult?.masterRegime.regimePenalty ?? 1).toFixed(2)} penalty régimen</div>
            </div>
            <div style={{ background: (portfolioAnalytics.beta ?? 1) > 1.3 ? "#78350f" : (portfolioAnalytics.beta ?? 1) > 0.8 ? "#1e3a5f" : "#065f46", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Beta vs WLG (MSCI World)</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: "#ffffff" }}>{(portfolioAnalytics.beta ?? 1).toFixed(2)}</div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>
                {(portfolioAnalytics.beta ?? 1) > 1.2 ? "Agresivo" : (portfolioAnalytics.beta ?? 1) > 0.8 ? "Mercado" : "Defensivo"}
              </div>
            </div>
            <div style={{ background: (portfolioAnalytics.alpha ?? 0) > 0.02 ? "#065f46" : (portfolioAnalytics.alpha ?? 0) > 0 ? "#1e3a5f" : "#7f1d1d", borderRadius: "0.5rem", padding: "1rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af", marginBottom: "0.25rem" }}>Alpha de Jensen</div>
              <div style={{ fontSize: "1.8rem", fontWeight: "bold", color: (portfolioAnalytics.alpha ?? 0) >= 0 ? "#10b981" : "#ef4444" }}>
                {((portfolioAnalytics.alpha ?? 0) * 100).toFixed(1)}%
              </div>
              <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>r_p - [rf + β(r_m - rf)]</div>
            </div>
          </div>
          <div style={{ marginTop: "0.75rem", background: "#0f172a", borderRadius: 6, padding: "0.5rem 0.75rem", fontSize: "0.7rem", color: "#6b7280", display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
            <span>Sharpe = (r_p − r_f) / σ_p · r_f = {(portfolioAnalytics.rf * 100).toFixed(1)}%</span>
            <span>·</span>
            <span style={{ color: "#94a3b8" }}>Sortino: semi-desviación real (retornos &lt; rf) — no aprox. σ/√2</span>
            <span>·</span>
            <span>Calmar = CAGR / |Max DD|</span>
            <span>·</span>
            <span style={{ color: portfolioAnalytics.hasCovMatrix ? "#4ade80" : "#f59e0b", fontWeight: 700 }}>
              MC: {portfolioAnalytics.mcRoute}
            </span>
          </div>
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
              <span style={{ color: "#e5e7eb", fontWeight: "bold", fontSize: "1rem" }}>{(Math.min(0.25, expectedReturn) * 100).toFixed(2)}%</span>
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
            Priors LP (Damodaran 2024): BTC 15% · Semis 14% · MSCI World 9% (Portfolio 6 activos desde refactor 22-Jun-2026: IS3Q.DE + XNAS.DE consolidados en 0P00000WLG.F.) — shrinkage 65% hacia prior, 35% histórico Yahoo.
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
            <div style={{ color: "#f59e0b", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p25)}</div>
            <div style={{ color: "#6b7280", fontSize: "0.7rem" }}>— a —</div>
            <div style={{ color: "#f59e0b", fontSize: "1rem", fontWeight: "bold" }}>{formatCurrency(p75)}</div>
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

      {/* ══════════════════════════════════════════════════════════════════════
           PANEL DE LIQUIDEZ — HendenFund (sin buffer, con % táctico editable)
           ══════════════════════════════════════════════════════════════════════ */}
      <div style={{ ...styles.card }}>
        <h2 style={{ marginBottom: "1rem", fontSize: "1rem" }}>
          💰 Gestión de Liquidez — Capital disponible y comprometido
        </h2>

        {/* ── Fila de inputs ── */}
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
          <div>
            <label htmlFor="cashReserve" style={styles.label}>Caja de reserva (€)</label>
            <input id="cashReserve" name="cashReserve" type="number" value={cashReserve}
              onChange={(e) => setCashReserve(Number(e.target.value))} style={styles.input} />
            <p style={{ fontSize: "0.7rem", color: "#6b7280", marginTop: "3px", maxWidth: "140px" }}>Cash total en cuenta ahora mismo</p>
          </div>

          <div>
            <label htmlFor="monthlyInjection" style={styles.label}>Aportación mensual (€)</label>
            <input id="monthlyInjection" name="monthlyInjection" type="number" value={monthlyInjection}
              onChange={(e) => setMonthlyInjection(Number(e.target.value))} style={styles.input} />
            <p style={{ fontSize: "0.7rem", color: "#6b7280", marginTop: "3px", maxWidth: "140px" }}>Lo que aportas cada mes</p>
          </div>
          <div style={{ borderLeft: "2px solid #16a34a", paddingLeft: "1rem" }}>
            <label htmlFor="defensiveLiqInput" style={{ ...styles.label, color: "#4ade80" }}>💰 Liquidez defensiva acumulada (€)</label>
            <input id="defensiveLiqInput" type="number" value={defensiveLiquidity} min={0} step={50}
              onChange={(e) => { const val = Math.max(0, Number(e.target.value)); setDefensiveLiquidity(val); try { localStorage.setItem("olympus_defensive_liq", String(val)); } catch {} }}
              style={{ ...styles.input, borderColor: "#16a34a", backgroundColor: "#052e16" }} />
            <p style={{ fontSize: "0.7rem", color: "#4ade80", marginTop: "3px", maxWidth: "160px" }}>Acumulado en meses de bloqueo DCA</p>
          </div>
          <div style={{ borderLeft: "2px solid #22c55e", paddingLeft: "1rem" }}>
          </div>
        </div>


      {/* Simple Cash Reserve Panel */}
      <div style={styles.card}>
        <h2 style={{ marginTop: 0, marginBottom: "0.75rem", fontSize: "0.95rem", color: "#e2e8f0" }}>Cash & Liquidez</h2>
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ fontSize: "0.72rem", color: "#94a3b8", display: "block", marginBottom: "4px" }}>
              Cash en broker
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>EUR</span>
              <input
                type="number" value={cashReserve} min={0} step={100}
                onChange={(e) => setCashReserve(Math.max(0, Number(e.target.value)))}
                style={{ width: "130px", background: "#0f172a", border: "1px solid #3b82f6", color: "#60a5fa", borderRadius: "6px", padding: "6px 10px", fontSize: "0.95rem", fontWeight: "bold" }}
              />
            </div>
          </div>

          {/* Transfer between Cash and Defensive */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", alignSelf: "flex-end" }}>
            <input
              type="number" value={transferAmount} min={0} step={100}
              onChange={(e) => setTransferAmount(Math.max(0, Number(e.target.value)))}
              placeholder="Importe"
              style={{ width: "80px", background: "#0f172a", border: "1px solid #6366f1", color: "#a5b4fc", borderRadius: "4px", padding: "4px 6px", fontSize: "0.75rem", textAlign: "center" }}
            />
            <div style={{ display: "flex", gap: "3px" }}>
              <button
                onClick={() => {
                  const amt = Math.min(transferAmount, cashReserve);
                  if (amt <= 0) return;
                  setCashReserve(cr => Math.round((cr - amt) * 100) / 100);
                  setDefensiveLiquidity(dl => {
                    const nd = Math.round((dl + amt) * 100) / 100;
                    try { localStorage.setItem("olympus_defensive_liq", String(nd)); } catch {}
                    return nd;
                  });
                  setTransferAmount(0);
                }}
                disabled={transferAmount <= 0}
                title="Mover de Cash a Liquidez Defensiva"
                style={{ background: transferAmount > 0 ? "#78350f" : "#1f2937", color: transferAmount > 0 ? "#f59e0b" : "#4b5563", border: "1px solid #f59e0b", borderRadius: "4px", padding: "2px 6px", cursor: transferAmount > 0 ? "pointer" : "not-allowed", fontSize: "0.65rem", fontWeight: "bold", whiteSpace: "nowrap" }}
              >Def</button>
              <button
                onClick={() => {
                  const amt = Math.min(transferAmount, defensiveLiquidity);
                  if (amt <= 0) return;
                  setDefensiveLiquidity(dl => {
                    const nd = Math.round((dl - amt) * 100) / 100;
                    try { localStorage.setItem("olympus_defensive_liq", String(nd)); } catch {}
                    return nd;
                  });
                  setCashReserve(cr => Math.round((cr + amt) * 100) / 100);
                  setTransferAmount(0);
                }}
                disabled={transferAmount <= 0}
                title="Mover de Liquidez Defensiva a Cash"
                style={{ background: transferAmount > 0 ? "#052e16" : "#1f2937", color: transferAmount > 0 ? "#10b981" : "#4b5563", border: "1px solid #10b981", borderRadius: "4px", padding: "2px 6px", cursor: transferAmount > 0 ? "pointer" : "not-allowed", fontSize: "0.65rem", fontWeight: "bold", whiteSpace: "nowrap" }}
              >Cash</button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: "0.72rem", color: "#94a3b8", display: "block", marginBottom: "4px" }}>
              Liquidez Defensiva
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>EUR</span>
              <input
                type="number" value={defensiveLiquidity} min={0} step={100}
                onChange={(e) => {
                  const val = Math.max(0, Number(e.target.value));
                  setDefensiveLiquidity(val);
                  try { localStorage.setItem("olympus_defensive_liq", String(val)); } catch {}
                }}
                style={{ width: "130px", background: "#0f172a", border: "1px solid #f59e0b", color: "#fbbf24", borderRadius: "6px", padding: "6px 10px", fontSize: "0.95rem", fontWeight: "bold" }}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: "0.72rem", color: "#94a3b8", display: "block", marginBottom: "4px" }}>
              Aportacion Mensual
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>EUR</span>
              <input
                type="number" value={monthlyInjection} min={0} step={50}
                onChange={(e) => setMonthlyInjection(Math.max(0, Number(e.target.value)))}
                style={{ width: "130px", background: "#0f172a", border: "1px solid #10b981", color: "#34d399", borderRadius: "6px", padding: "6px 10px", fontSize: "0.95rem", fontWeight: "bold" }}
              />
            </div>
          </div>

          <div style={{ fontSize: "0.7rem", color: "#4b5563", maxWidth: "180px", lineHeight: "1.5" }}>
            Liquidez total: <strong style={{ color: "#e2e8f0" }}>{formatCurrency(cashReserve + defensiveLiquidity)}</strong>
          </div>
        </div>
      </div>
        {/* ── Pesos del Portfolio ── */}
        <div style={{ marginTop: "0.5rem", padding: "0.5rem 0", borderTop: "1px solid #374151" }}>
          <h3 style={{ fontSize: "0.75rem", fontWeight: "bold", color: "#9ca3af", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>📊 Pesos del Motor</h3>
          <div style={{ display: "flex", gap: "0.75rem 1.2rem", flexWrap: "wrap", fontSize: "0.78rem" }}>
            {engineResult && engineResult.allocations.length > 0 && engineResult.allocations.map(a => (
              <span key={a.name}>
                <strong>{a.name.replace('.DE', '')}</strong> {(a.finalAllocation * 100).toFixed(1)}%
              </span>
            ))}
            <span style={{ color: "#fbbf24" }}><strong>Cash (cuenta)</strong> {formatCurrency(cashReserve)} · {(cashReserve / Math.max(1, totalPortfolioValue + cashReserve) * 100).toFixed(1)}% del patrimonio</span>
            <span style={{ color: "#34d399" }}><strong>Motor:</strong> {((engineResult?.totalInvested ?? 0) * 100).toFixed(1)}% a invertir · {(Math.max(0, 1 - (engineResult?.totalInvested ?? 0)) * 100).toFixed(1)}% a retener</span>
            <span style={{ color: "#9ca3af", fontSize: "0.6rem" }}>Los % de activos son sobre el tramo invertido (Σ dentro del motor)</span>
          </div>
        </div>

        {/* ── Resumen portfolio ── */}
        <div style={{ marginTop: "1rem", display: "flex", gap: "2rem", flexWrap: "wrap" }}>
          <p><strong>Valor total cartera:</strong> {formatCurrency(totalPortfolioValue)}</p>
          <p><strong>Objetivo:</strong> {formatCurrency(portfolio.targetGoal)}</p>
          <p><strong>G/P totales:</strong> <span style={{ color: totalGainLoss >= 0 ? "#10b981" : "#ef4444" }}>{formatCurrency(totalGainLoss)}</span></p>
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
                    <p style={{ color: "#f59e0b", fontSize: "0.8rem" }}>→ {alert.action}</p>
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


            {/* SPRINT-6: Historial de Rendimiento — Allocation Logger */}
      {(() => {
        const perf = getHistoricalPerformance(30);
        if (perf.totalRecords < 2) return null;
        const regimeColors = { EXPANSION: "#10b981", CONTRACTION: "#f59e0b", CRISIS: "#ef4444", ALL_CASH: "#ef4444" };
        return (
          <details style={{ marginBottom: "1rem" }}>
            <summary style={{ cursor: "pointer", color: "#60a5fa", fontSize: "0.85rem", fontWeight: 600, padding: "0.5rem 0", userSelect: "none" }}>
              📊 Rendimiento Histórico ({perf.totalRecords} registros)
              <span style={{ color: "#6b7280", fontWeight: 400, fontSize: "0.72rem", marginLeft: "0.5rem" }}>
                último: {perf.lastDate ? new Date(perf.lastDate).toLocaleDateString("es-ES") : "N/A"}
              </span>
            </summary>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "0.75rem" }}>
              <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.75rem" }}>
                <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.78rem", color: "#9ca3af" }}>Métricas del Motor</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", fontSize: "0.8rem" }}>
                  <span style={{ color: "#6b7280" }}>Asignación media</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.avgInvested * 100).toFixed(1)}%</span>
                  <span style={{ color: "#6b7280" }}>Vol Target medio</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.avgVolTarget * 100).toFixed(1)}%</span>
                  <span style={{ color: "#6b7280" }}>Tail Risk medio</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.avgTailOverlay * 100).toFixed(1)}%</span>
                  <span style={{ color: "#6b7280" }}>Desde</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{perf.firstDate ? new Date(perf.firstDate).toLocaleDateString("es-ES") : "N/A"}</span>
                </div>
              </div>
              <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.75rem" }}>
                <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.78rem", color: "#9ca3af" }}>Distribución de Régimen</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
                  {Object.entries(perf.regimeDistribution).map(([regime, pct]) => (
                    <div key={regime} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: regimeColors[regime as keyof typeof regimeColors] || "#9ca3af" }}>{regime}</span>
                      <span style={{ color: "#d1d5db" }}>{(pct * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                  {Object.keys(perf.regimeDistribution).length === 0 && <span style={{ color: "#6b7280" }}>Sin datos</span>}
                </div>
              </div>
              <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.75rem" }}>
                <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.78rem", color: "#9ca3af" }}>Factores Promedio</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem", fontSize: "0.8rem" }}>
                  <span style={{ color: "#6b7280" }}>Momentum</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.factorAverage.momentum * 100).toFixed(1)}%</span>
                  <span style={{ color: "#6b7280" }}>Value</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.factorAverage.value * 100).toFixed(1)}%</span>
                  <span style={{ color: "#6b7280" }}>Quality</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.factorAverage.quality * 100).toFixed(1)}%</span>
                  <span style={{ color: "#6b7280" }}>Low Vol</span>
                  <span style={{ color: "#d1d5db", textAlign: "right" }}>{(perf.factorAverage.lowVol * 100).toFixed(1)}%</span>
                </div>
              </div>
              {perf.allocationTrends.length > 0 && (
                <div style={{ background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "0.75rem" }}>
                  <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.78rem", color: "#9ca3af" }}>Tendencias (30 días)</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.78rem" }}>
                    {perf.allocationTrends.slice(0, 6).map((t, i) => {
                      const trendIcon = t.trend === "up" ? "↑" : t.trend === "down" ? "↓" : "→";
                      const trendColor = t.trend === "up" ? "#10b981" : t.trend === "down" ? "#ef4444" : "#6b7280";
                      return (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span style={{ color: "#d1d5db" }}>{t.name}</span>
                          <span style={{ color: trendColor }}>
                            {trendIcon} {(t.currentAllocation * 100).toFixed(1)}% / {(t.avgAllocation30d * 100).toFixed(1)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </details>
        );
      })()}

      

      {/* SPRINT-7: Monitoreo en Vivo */}
      <RealTimeMonitorPanel
        totalPortfolioValue={totalPortfolioValue}
        availableCash={availableCash}
        onManualRefresh={() => refreshMarketData(true)}
        loading={loading}
      />

      {/* SPRINT-3: Benchmark 60/40 vs Engine */}{/* SPRINT-3: Benchmark 60/40 vs Engine */}
      {benchmarkStatus && benchmarkStatus.dataPoints >= 2 && (
        <div style={{
          ...styles.card,
          border: benchmarkStatus.underperformanceAlert
            ? '2px solid #ef4444'
            : '1px solid #374151',
          background: benchmarkStatus.underperformanceAlert
            ? 'linear-gradient(135deg, #1c0a0a 0%, #111827 100%)'
            : '#111827',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <h4 style={{ margin: 0, fontSize: '0.82rem', color: '#e2e8f0' }}>
              📊 Benchmark 60/40
            </h4>
            <span style={{ fontSize: '0.62rem', color: '#64748b' }}>
              {benchmarkStatus.dataPoints} snapshots · {new Date(benchmarkStatus.lastUpdated).toLocaleDateString('es-ES')}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem' }}>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Engine CAGR (3m)</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.engineCagr3m > 0 ? '#10b981' : '#ef4444' }}>{(benchmarkStatus.engineCagr3m * 100).toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Benchmark CAGR (3m)</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.benchmarkCagr3m > 0 ? '#10b981' : '#ef4444' }}>{(benchmarkStatus.benchmarkCagr3m * 100).toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Outperformance</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.outperformance > 0 ? '#10b981' : benchmarkStatus.underperformanceAlert ? '#ef4444' : '#f59e0b' }}>{(benchmarkStatus.outperformance * 100).toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Engine Sharpe (3m)</div>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: benchmarkStatus.engineSharpe3m > 1 ? '#10b981' : benchmarkStatus.engineSharpe3m > 0.5 ? '#f59e0b' : '#ef4444' }}>{benchmarkStatus.engineSharpe3m.toFixed(2)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Benchmark Sharpe (3m)</div>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: benchmarkStatus.benchmarkSharpe3m > 1 ? '#10b981' : benchmarkStatus.benchmarkSharpe3m > 0.5 ? '#f59e0b' : '#ef4444' }}>{benchmarkStatus.benchmarkSharpe3m.toFixed(2)}</div>
            </div>
          </div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: benchmarkStatus.underperformanceAlert ? '#fca5a5' : '#94a3b8', padding: '0.35rem 0.5rem', background: benchmarkStatus.underperformanceAlert ? '#1c0a0a' : '#1e293b', borderRadius: '4px' }}>
            {benchmarkStatus.underperformanceAlert && '🔴 '}
            {benchmarkStatus.message}
          </div>
          <details style={{ marginTop: '0.4rem' }}>
            <summary style={{ fontSize: '0.65rem', color: '#6b7280', cursor: 'pointer' }}>Composición del benchmark 60/40</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
              {(() => {
                const comp = getBenchmarkComposition();
                return comp.map(c => (
                  <span key={c.ticker} style={{ fontSize: '0.62rem', background: '#1e293b', padding: '2px 6px', borderRadius: '3px', color: '#94a3b8' }}>
                    {c.ticker} {(c.weight * 100).toFixed(0)}%
                  </span>
                ));
              })()}
            </div>
          </details>
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

      <WalkForwardSection />

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

      {/* FIX-AUDIT-R9 UI: FRED Manual Inputs Panel — editar M2, CAPE, credit spread, breakeven */}
      <FredManualPanel onSaved={refreshMarketData} />

      
      {/* FEAT: Manual Forward-Looking Volatility Panel */}
      <div style={{
        background: "#0f1f38", border: "1px solid #1e3a5f", borderRadius: "10px",
        padding: "14px 16px", marginBottom: "12px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <span style={{ fontWeight: 700, color: "#93c5fd", fontSize: "0.88rem" }}>Volatilidad Forward-Looking (manual)</span>
          <span style={{ fontSize: "0.68rem", color: "#64748b" }}>Sobreescribe la vol realizada si se especifica</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {portfolio.assets.map(asset => {
            const assetIdx = ASSETS.indexOf(asset.ticker as any);
            const marketVol = (marketData?.realizedVols?.[assetIdx] ?? asset.volatility / 100) * 100;
            const manualVol = manualVols[asset.ticker];
            const displayVol = manualVol !== undefined ? manualVol : marketVol;
            const isOverridden = manualVol !== undefined;
            return (
              <div key={asset.ticker} style={{
                background: isOverridden ? "#1e293b" : "#0f172a",
                border: "1px solid " + (isOverridden ? "#f59e0b" : "#1e3a5f"),
                borderRadius: "6px", padding: "6px 10px",
                minWidth: "140px",
              }}>
                <div style={{ fontSize: "0.65rem", color: "#64748b", marginBottom: "2px" }}>
                  {asset.name}
                  <span style={{ color: "#94a3b8", marginLeft: "4px" }}>
                    {isOverridden ? "edit" : "chart"} {(displayVol).toFixed(1)}%
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <input
                    type="number"
                    value={manualVol !== undefined ? (manualVol * 100).toFixed(1) : ""}
                    placeholder={(marketVol).toFixed(1)}
                    step="0.5"
                    min="1"
                    max="150"
                    onChange={(e) => {
                      const val = e.target.value === "" ? undefined : Number(e.target.value) / 100;
                      setManualVols(prev => ({ ...prev, [asset.ticker]: val }));
                    }}
                    style={{
                      width: "55px", background: "#0f172a", border: "1px solid " + (isOverridden ? "#f59e0b" : "#334155"),
                      color: isOverridden ? "#fbbf24" : "#94a3b8", borderRadius: "3px",
                      padding: "2px 4px", fontSize: "0.72rem", textAlign: "right",
                    }}
                  />
                  <span style={{ fontSize: "0.6rem", color: "#475569" }}>%</span>
                  {isOverridden && (
                    <button
                      onClick={() => setManualVols(prev => { const n = { ...prev }; delete n[asset.ticker]; return n; })}
                      style={{
                        background: "none", border: "none", color: "#f59e0b", cursor: "pointer",
                        fontSize: "0.65rem", padding: "0 2px",
                      }}
                      title="Volver a vol realizada del mercado"
                    >
                      reset
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {Object.keys(manualVols).length > 0 && (
          <div style={{ marginTop: "8px", fontSize: "0.6rem", color: "#f59e0b" }}>
            {Object.keys(manualVols).length} activo(s) con volatilidad manual - el motor usara estos valores en lugar de la vol realizada.
          </div>
        )}
      </div>
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
                <div style={{ color: "#f59e0b", fontSize: "0.72rem", fontWeight: "bold", marginBottom: "0.5rem" }}>⚡ ON-CHAIN SIGNALS</div>
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

      {/* Cycle Bottom Opportunities */}
      {cycleBottomResult && cycleBottomResult.hasActiveOpportunities && (
        <div style={{ ...styles.card, border: "1px solid #10b981", background: "linear-gradient(135deg, #0a1a10 0%, #111827 100%)" }}>
          <h2 style={{ color: "#34d399", marginBottom: "0.5rem" }}>Oportunidades de Suelo de Ciclo</h2>
          <p style={{ color: "#6b7280", fontSize: "0.78rem", marginBottom: "0.75rem" }}>Activos con indicadores de infravaloracion u oversold. El Smart DCA escala la compra (x1.25 VALUE, x1.5 OPPORTUNITY, x2.0 EXTREME).</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {cycleBottomResult.signals.filter((s: CycleBottomSignal) => s.shouldAccumulate).map((s: CycleBottomSignal) => (
              <div key={s.ticker} style={{
                background: s.zone === "EXTREME" ? "rgba(16,185,129,0.15)" : s.zone === "OPPORTUNITY" ? "rgba(16,185,129,0.10)" : "rgba(16,185,129,0.06)",
                border: "1px solid" + (s.zone === "EXTREME" ? " #10b981" : s.zone === "OPPORTUNITY" ? " #34d399" : " #6ee7b7"),
                borderRadius: "6px", padding: "0.6rem 1rem",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                  <span style={{ fontWeight: "bold", color: "#e5e7eb" }}>{s.ticker} - {s.asset}</span>
                  <span style={{ background: s.zone === "EXTREME" ? "#064e3b" : "#065f46", color: "#34d399", padding: "0.1rem 0.5rem", borderRadius: 4, fontSize: "0.75rem", fontWeight: "bold" }}>{s.zone} {s.opportunityScore}/100 DCA x{s.attackMultiplier.toFixed(2)}</span>
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
              <div style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "1.1rem" }}>+€{taxAnalysis.totalLatentGains.toFixed(0)}</div>
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
                {/* FIX-HOLD-ROWS (23-Jul-2026): mostrar TODOS los activos del portfolio,
                    no solo los que tienen BUY/SELL. Los activos sin sugerencia se muestran
                    como HOLD con su drift, actual y objetivo. Así BTC siempre es visible. */}
                {(() => {
                  const olyPct = olympusPct / 100;
                  const btcSat = (100 - olympusPct) / 100;
                  const allRows = portfolio.assets.map(asset => {
                    const suggestion = taxAwareRebalance!.suggestions.find(s => s.ticker === asset.ticker);
                    if (suggestion) return { ...suggestion, _hasSuggestion: true as const };
                    // Activo sin sugerencia → fila HOLD con estadísticas
                    const alloc = engineResult?.allocations.find(a => a.name === asset.name);
                    const engineAlloc = alloc?.finalAllocation ?? 0;
                    const isBtc = asset.ticker === 'BTC-EUR';
                    const compositeAlloc = isBtc ? (engineAlloc * olyPct) + btcSat : engineAlloc * olyPct;
                    const currentValue = asset.shares * asset.price;
                    const currentPct = totalPortfolioValue > 0 ? currentValue / totalPortfolioValue : 0;
                    const drift = currentPct - compositeAlloc;
                    return {
                      ticker: asset.ticker, name: asset.name,
                      action: 'HOLD' as const, currentPct, targetPct: compositeAlloc, drift,
                      sharesToBuy: 0, sharesToSell: 0, cost: 0, proceedsIfSold: 0, trimPct: 0,
                      reason: drift < -0.02 ? `Infraponderado ${Math.abs(drift * 100).toFixed(1)}pp` : drift > 0.02 ? `Sobreponderado ${(drift * 100).toFixed(1)}pp` : 'Dentro del rango (±2pp)',
                      priority: 'LOW' as const, _hasSuggestion: false as const,
                      cycleZone: undefined as string | undefined,
                      cycleIndicator: undefined as string | undefined,
                      cycleIndicatorValue: undefined as string | undefined,
                    };
                  });
                  return allRows.map((s: any) => (
                  <tr key={s.ticker} style={{ borderBottom: "1px solid #1f2937", background: s.action === "SELL" ? "rgba(239,68,68,0.07)" : s.action === "HOLD" ? "rgba(0,0,0,0.02)" : "transparent" }}>
                    <td style={{ padding: "0.5rem", fontWeight: "bold", color: s.action === "HOLD" ? "#6b7280" : undefined }}>{s.ticker}</td>
                    <td style={{ padding: "0.5rem", textAlign: "center" }}>
                      <span style={{
                        background: s.action === "SELL" ? "#7f1d1d" : s.action === "BUY" ? "#052e16" : "#1f2937",
                        color: s.action === "SELL" ? "#ef4444" : s.action === "BUY" ? "#10b981" : "#9ca3af",
                        padding: "0.1rem 0.5rem", borderRadius: 4, fontSize: "0.75rem", fontWeight: "bold",
                      }}>{s.action}</span>
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: s.action === "HOLD" ? "#6b7280" : undefined }}>{(s.currentPct * 100).toFixed(1)}%</td>
                    <td style={{ padding: "0.5rem", textAlign: "right" }}>
                      <span style={{ color: s.action === "HOLD" ? "#6b7280" : "#6366f1" }}>{(s.targetPct * 100).toFixed(1)}%</span>
                      {s.ticker === "BTC-EUR" && olympusPct < 100 && (
                        <div style={{ fontSize: "0.62rem", color: "#6b7280", marginTop: "2px", lineHeight: "1.3" }}>
                          <span style={{ color: "#818cf8" }}>motor {((engineResult?.allocations.find(a => a.name === portfolio.assets.find(p => p.ticker === "BTC-EUR")?.name)?.finalAllocation ?? 0) * olympusPct).toFixed(1)}%</span>
                          {" · "}
                          <span style={{ color: "#f59e0b" }}>sat {(100 - olympusPct).toFixed(0)}%</span>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: s.action === "HOLD" ? "#9ca3af" : s.drift > 0 ? "#f59e0b" : "#ef4444" }}>{(s.drift * 100).toFixed(1)}pp</td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6b7280" }}>
                      {s.action === "SELL"
                        ? <span style={{ color: "#ef4444" }}>−{s.sharesToSell} ({s.trimPct}%)</span>
                        : s.action === "BUY"
                        ? <span style={{ color: "#f59e0b" }}>+{s.sharesToBuy}</span>
                        : <span>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem", textAlign: "right", color: "#6b7280" }}>
                      {s.action === "SELL"
                        ? <span style={{ color: "#f59e0b" }}>+€{s.proceedsIfSold.toFixed(0)}</span>
                        : s.action === "BUY"
                        ? <span style={{ color: "#f59e0b" }}>−€{s.cost.toFixed(0)}</span>
                        : <span>—</span>}
                    </td>
                    <td style={{ padding: "0.5rem", fontSize: "0.78rem" }}>
                      {s._hasSuggestion !== false ? (
                        <>
                          <span style={{
                            backgroundColor: s.priority === "HIGH" ? "#7f1d1d" : s.priority === "MEDIUM" ? "#78350f" : "#1f2937",
                            color: s.priority === "HIGH" ? "#ef4444" : s.priority === "MEDIUM" ? "#f59e0b" : "#9ca3af",
                            padding: "0.1rem 0.4rem", borderRadius: 4, marginRight: "0.3rem",
                          }}>{s.priority}</span>
                          {s.cycleZone && s.action === "SELL" && (
                            <span style={{ fontSize: "0.65rem", color: "#f97316", background: "#431407", padding: "0.1rem 0.4rem", borderRadius: 4 }}>
                              🔴 Cycle Top override · {s.cycleZone}
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: "#6b7280", fontSize: "0.7rem" }}>{s.reason}</span>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {s._hasSuggestion !== false ? (
                        <button
                          onClick={() => {
                            const asset = portfolio.assets.find(a => a.ticker === s.ticker);
                            setPendingTrade({
                              ticker: s.ticker,
                              name: s.ticker,
                              action: s.action as 'BUY' | 'SELL',
                              suggestedShares: s.action === 'SELL' ? s.sharesToSell : s.sharesToBuy,
                              suggestedPrice: asset?.price ?? 0,
                              source: 'REBALANCE',
                            });
                            setExecShares(s.action === 'SELL' ? s.sharesToSell : s.sharesToBuy);
                            setExecPrice(asset?.price ?? 0);
                          }}
                          style={{
                            background: "#1e3a5f", color: "#60a5fa", border: "1px solid #3b82f6",
                            borderRadius: 4, padding: "0.2rem 0.5rem", cursor: "pointer",
                            fontSize: "0.72rem", whiteSpace: "nowrap",
                          }}
                        >✓ Ejecutado</button>
                      ) : null}
                    </td>
                  </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", marginTop: "0.75rem" }}>
            Total compras: <strong style={{ color: "#f59e0b" }}>€{taxAwareRebalance!.totalCost.toFixed(0)}</strong> ·
            Restante: €{taxAwareRebalance!.remainingCash.toFixed(0)}
          </p>
        </div>
      )}

      {/* Modo Ataque */}
      {(smartDCAResult?.attackConfluence ?? 0) > 0 && (
        <div style={{
          ...styles.card,
          border: smartDCAResult?.attackMode ? "2px solid #22c55e" : "1px solid #374151",
          background: smartDCAResult?.attackMode ? "linear-gradient(135deg, #052e16 0%, #111827 100%)" : undefined,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ margin: 0 }}>
              {smartDCAResult?.attackMode ? "🚀" : "🎯"} Modo Ataque — Confluencia de Fondo
            </h2>
            <div style={{
              padding: "0.35rem 0.9rem", borderRadius: 20, fontWeight: "bold", fontSize: "0.85rem",
              backgroundColor: (smartDCAResult?.attackConfluence ?? 0) >= 4 ? "#14532d" : (smartDCAResult?.attackConfluence ?? 0) >= 3 ? "#065f46" : (smartDCAResult?.attackConfluence ?? 0) >= 2 ? "#1e3a5f" : "#374151",
              color: "#fff",
            }}>
              {smartDCAResult?.attackConfluence ?? 0}/7 señales · Tramo {smartDCAResult?.attackTranche || "—"}
              {(smartDCAResult?.attackMultiplier ?? 1) > 1 && ` · ×${smartDCAResult?.attackMultiplier ?? 1} DCA`}
              {smartDCAResult?.action === "BTC_CYCLE_OVERRIDE" && " · ⚡ OVERRIDE"}
            </div>
          </div>
          {/* Indicador de progreso hacia BTC_CYCLE_OVERRIDE */}
          <div style={{ marginBottom: "0.75rem", padding: "0.5rem 0.75rem", borderRadius: 8, backgroundColor: "#0f172a", border: "1px solid #1e3a5f", fontSize: "0.75rem", color: "#6b7280" }}>
            <span style={{ color: "#60a5fa" }}>⚡ Motor B (BTC Ciclo): </span>
            {(smartDCAResult?.attackConfluence ?? 0) >= 4
              ? <span style={{ color: "#22c55e", fontWeight: "bold" }}>ACTIVO — {smartDCAResult?.attackConfluence ?? 0}/7 señales superan umbral de override</span>
              : <span>Necesita {4 - (smartDCAResult?.attackConfluence ?? 0)} señal(es) más para BTC_CYCLE_OVERRIDE (actúa en CRISIS macro si ≥4/7)</span>
            }
            <br/>
            <span style={{ color: "#9ca3af", fontSize: "0.68rem" }}>
              ⓘ Las 7 señales son indicadores de ciclo BTC/macro. Con régimen no-CRISIS y 4/7 activas → bonus BTC en DCA.
              El DCA completo de cartera requiere además ≥1 señal macro (Régimen, CEWS o VIX) activa.
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem", marginBottom: "1rem" }}>
            {smartDCAResult?.attackSignals.map(signal => (
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
          {smartDCAResult?.action === "BTC_CYCLE_OVERRIDE" && (
            <div style={{ backgroundColor: "#0c1a0a", border: "2px solid #16a34a", borderRadius: 8, padding: "0.75rem 1rem", marginBottom: "0.5rem" }}>
              <p style={{ fontWeight: "bold", color: "#4ade80", marginBottom: "0.25rem" }}>
                ⚡ BTC CYCLE OVERRIDE — Motor B activo en CRISIS macro
              </p>
              <p style={{ color: "#bbf7d0", fontSize: "0.85rem", margin: 0 }}>{smartDCAResult?.reasoning}</p>
            </div>
          )}
          {smartDCAResult?.attackMode && smartDCAResult?.action !== "BTC_CYCLE_OVERRIDE" && (
            <div style={{ backgroundColor: "#052e16", border: "1px solid #22c55e", borderRadius: 8, padding: "0.75rem 1rem" }}>
              <p style={{ fontWeight: "bold", color: "#86efac", marginBottom: "0.25rem" }}>
                {smartDCAResult?.action === "ATTACK_MAX" ? "🚀 ATAQUE MÁXIMO" : smartDCAResult?.action === "ATTACK_STRONG" ? "⚔️ ATAQUE FUERTE" : "🎯 ATAQUE ENTRADA"}
              </p>
              <p style={{ color: "#d1fae5", fontSize: "0.85rem", margin: 0 }}>{smartDCAResult?.reasoning}</p>
            </div>
          )}
        </div>
      )}

      {/* SmartDCA por activo */}
      {(smartDCAResult?.totalCashToInvest ?? 0) > 0 && (
        <div style={styles.card}>
          <h2>💸 SmartDCA — Distribución por Motor (Nivel 4)</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: "0.75rem" }}>{smartDCAResult?.reasoning}</p>
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
                {smartDCAResult?.allocationByAsset.map(a => (
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
                    {/* MEJORA-9: Ejecutado en DCA */}
                    <td style={{ padding: "0.5rem" }}>
                      {!a.skipped && (
                        <button
                          onClick={() => {
                            setPendingTrade({
                              ticker: a.ticker, name: a.name, action: 'BUY',
                              suggestedShares: a.shares, suggestedPrice: a.pricePerShare,
                              source: 'DCA',
                            });
                            setExecShares(a.shares);
                            setExecPrice(a.pricePerShare);
                          }}
                          style={{
                            background: "#052e16", color: "#4ade80", border: "1px solid #16a34a",
                            borderRadius: 4, padding: "0.2rem 0.5rem", cursor: "pointer",
                            fontSize: "0.72rem", whiteSpace: "nowrap",
                          }}
                        >✓ Ejecutado</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid #374151", backgroundColor: "#0f172a" }}>
                  <td colSpan={4} style={{ padding: "0.5rem", color: "#9ca3af", textAlign: "right" }}>Total a desembolsar:</td>
                  <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold", color: "#f59e0b", fontSize: "1rem" }}>€{(smartDCAResult?.totalCashToInvest ?? 0).toFixed(2)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {smartDCAResult?.action.startsWith("BLOCK") && (
        <div style={{ backgroundColor: "#78350f", border: "1px solid #f59e0b", padding: "1rem", borderRadius: 8, marginBottom: "1.5rem" }}>
          <strong>🛑 DCA Bloqueado: {smartDCAResult?.action}</strong>
          <p style={{ margin: "0.5rem 0 0", color: "#fde68a", fontSize: "0.85rem" }}>{smartDCAResult?.blockReason}</p>
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

      {/* MEJORA-9: Modal de confirmación de operación ejecutada */}
      {pendingTrade && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{ background: '#1e293b', borderRadius: 12, padding: 28, width: 380, border: '1px solid #3b82f6' }}>
            <h3 style={{ color: '#60a5fa', marginBottom: 16, fontSize: '1rem' }}>
              ✓ Confirmar operación ejecutada en broker
            </h3>
            <div style={{ background: '#0f172a', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: '0.85rem' }}>
              <div style={{ color: '#94a3b8', marginBottom: 4 }}>Motor sugería:</div>
              <div style={{ color: '#e2e8f0', fontWeight: 600 }}>
                {pendingTrade.action} {pendingTrade.suggestedShares} × {pendingTrade.ticker} @ €{pendingTrade.suggestedPrice.toFixed(2)}
              </div>
              <div style={{ color: '#475569', fontSize: '0.72rem', marginTop: 2 }}>
                Coste estimado: €{(pendingTrade.suggestedShares * pendingTrade.suggestedPrice).toFixed(2)}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                Precio real de ejecución (€/acc)
              </label>
              <input type="number" value={execPrice} step="0.01" min={0}
                onChange={e => setExecPrice(Number(e.target.value))}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #f59e0b', color: '#fbbf24', borderRadius: 6, padding: '8px 12px', fontSize: '0.9rem' }}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                Acciones realmente {pendingTrade.action === 'BUY' ? 'compradas' : 'vendidas'}
              </label>
              <input type="number"
                value={execShares}
                step={pendingTrade.ticker === 'BTC-EUR' ? '0.000001' : '1'}
                min={0}
                onChange={e => setExecShares(Number(e.target.value))}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0f172a', border: '1px solid #f59e0b', color: '#fbbf24', borderRadius: 6, padding: '8px 12px', fontSize: '0.9rem' }}
              />
            </div>
            {execPrice > 0 && execShares > 0 && (
              <div style={{ background: '#052e16', borderRadius: 6, padding: '8px 12px', marginBottom: 14, fontSize: '0.82rem' }}>
                <div style={{ color: '#4ade80' }}>
                  Total {pendingTrade.action === 'BUY' ? 'gastado' : 'recibido'}: <strong>€{(execPrice * execShares).toFixed(2)}</strong>
                </div>
                <div style={{ color: '#166534', fontSize: '0.72rem', marginTop: 2 }}>
                  CashReserve {pendingTrade.action === 'BUY' ? 'bajará' : 'subirá'} a €{pendingTrade.action === 'BUY'
                    ? Math.max(0, cashReserve - execPrice * execShares).toFixed(2)
                    : (cashReserve + execPrice * execShares).toFixed(2)}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={confirmTradeExecution}
                disabled={execPrice <= 0 || execShares <= 0}
                style={{
                  flex: 1, background: execPrice > 0 && execShares > 0 ? '#16a34a' : '#374151',
                  color: 'white', border: 'none', borderRadius: 6, padding: '10px',
                  cursor: execPrice > 0 && execShares > 0 ? 'pointer' : 'not-allowed',
                  fontWeight: 700, fontSize: '0.85rem',
                }}
              >Confirmar y actualizar cartera</button>
              <button
                onClick={() => { setPendingTrade(null); setExecPrice(0); setExecShares(0); }}
                style={{ background: '#374151', color: '#9ca3af', border: 'none', borderRadius: 6, padding: '10px 16px', cursor: 'pointer', fontSize: '0.85rem' }}
              >Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* MEJORA-9: Log de operaciones ejecutadas */}
      {tradeLog.length > 0 && (
        <div style={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>📒 Historial de Operaciones Ejecutadas</h2>
            <button
              onClick={() => {
                const csv = ['Fecha,Ticker,Acción,Acciones,Precio,Total,Régimen,Fuente',
                  ...tradeLog.map(t =>
                    `${new Date(t.date).toLocaleDateString('es-ES')},${t.ticker},${t.action},${t.shares},${t.priceExecuted.toFixed(4)},${t.totalCost.toFixed(2)},${t.regime},${t.source}`
                  )].join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `olympus_trades_${new Date().toISOString().slice(0,10)}.csv`;
                a.click(); URL.revokeObjectURL(url);
              }}
              style={{ background: '#1e3a5f', color: '#60a5fa', border: '1px solid #3b82f6', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: '0.78rem' }}
            >⬇ Exportar CSV</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #374151', color: '#6b7280' }}>
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Fecha</th>
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Activo</th>
                  <th style={{ textAlign: 'center', padding: '0.4rem 0.6rem' }}>Acción</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.6rem' }}>Acciones</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.6rem' }}>Precio ejec.</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.6rem' }}>Total</th>
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Régimen</th>
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.6rem' }}>Fuente</th>
                </tr>
              </thead>
              <tbody>
                {tradeLog.slice(0, 50).map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ padding: '0.4rem 0.6rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {new Date(t.date).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' })}
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', fontWeight: 600, color: '#e2e8f0' }}>{t.ticker}</td>
                    <td style={{ padding: '0.4rem 0.6rem', textAlign: 'center' }}>
                      <span style={{ background: t.action === 'BUY' ? '#052e16' : '#7f1d1d', color: t.action === 'BUY' ? '#4ade80' : '#f87171', padding: '0.1rem 0.5rem', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700 }}>
                        {t.action}
                      </span>
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', color: '#e2e8f0' }}>
                      {t.ticker === 'BTC-EUR' ? t.shares.toFixed(6) : t.shares}
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', color: '#94a3b8' }}>€{t.priceExecuted.toFixed(2)}</td>
                    <td style={{ padding: '0.4rem 0.6rem', textAlign: 'right', fontWeight: 600, color: t.action === 'BUY' ? '#ef4444' : '#4ade80' }}>
                      {t.action === 'BUY' ? '−' : '+'}€{t.totalCost.toFixed(2)}
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.72rem', color: t.regime === 'EXPANSION' ? '#4ade80' : t.regime === 'CRISIS' ? '#ef4444' : '#f59e0b' }}>
                      {t.regime}
                    </td>
                    <td style={{ padding: '0.4rem 0.6rem', fontSize: '0.72rem', color: '#475569' }}>{t.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
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

export default InstitutionalDashboard;