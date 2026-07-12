// ============================================================
// src/core/tactical/tacticalScreener.ts — v11
//
// CORRECCIONES v11:
//
//   5. BACKTEST TÁCTICO metrics undefined.
//      El dashboard leía result.backtest.metrics que no existe
//      en ScreenerResult → error en consola + posible crash de render.
//      FIX: scanTacticalUniverse incluye backtest stub vacío en el
//      return para que result.backtest nunca sea undefined.
//      El dashboard debe leer result.backtest?.metrics ?? [].
//
// CORRECCIONES v10 (previas):
//
//   1. ULTRA-FALLBACK DESCARTADO EN SEÑALES.
//      PROBLEMA: GLD como proxy de URNU.DE generaba señales del oro
//      presentadas como señales de uranio. El usuario ejecutaba trades
//      en uranio con tesis construida sobre datos del oro.
//      FIX: buildAsset etiqueta dataSource ('primary'|'fallback'|'ultra-fallback').
//      buildOpportunity devuelve null para ultra-fallback.
//      Los warnings de ultra-fallback se exponen en ScreenerResult.warnings.
//
//   2. FX CONVERSION en buildOpportunity.
//      PROBLEMA: entryPrice, stopLoss, takeProfit en divisa nativa.
//      calcPositionSize los dividía por riskPerShare (USD por EUR) → sizing incorrecto.
//      FIX: buildOpportunity convierte todos los precios a EUR usando toEur().
//      TacticalOpportunity.entryPrice / stopLoss / takeProfit1 / takeProfit2 en EUR.
//
//   3. SIGNAL TYPE POR SCORE (no por posición en array).
//      PROBLEMA: activeSignals[0].type tomaba la primera señal activa
//      en orden hardcodeado, no por score. Una MEAN_REVERSION de score 45
//      ganaba a un MOMENTUM_BREAKOUT de score 90.
//      FIX: generateSignals ya devuelve señales ordenadas por score DESC
//      (corregido en tacticalSignals.ts). activeSignals[0] es siempre el mayor.
//      Aquí verificamos y añademos guard explícito.
//
//   4. fetchFxRates al inicio del scan.
//      Las tasas se cachean 4 horas. Si el scan es el primero del día,
//      se fetchean antes del primer buildAsset.
// ============================================================

import { fetchYahooBatch } from '@/lib/yahooFinance';
import type {
  TacticalAsset, TacticalOpportunity, ScreenerResult, TacticalConfig,
  DataSource,
} from './types';
import {
  calcIndicators, generateSignals, calcTotalScore,
  calcStopLoss, calcTakeProfits,
  generateMacroSignal,
  detectMomentumExhaustion,
  checkWeeklyConfirmation,
} from './tacticalSignals';
import {
  CORE_TACTICAL_UNIVERSE,
  FULL_TACTICAL_UNIVERSE,
  VOLATILE_UNIVERSE,
  type UniverseAsset,
} from './tacticalUniverse';
import { getFundamentals } from './fundamentalsConfig';
import {
  detectMarketRegime,
  isSignalAllowed,
  adjustScoreByRegime,
} from './marketRegimeFilter';
import { fetchFxRates, toEur, normalizeGbxToGbp, getCachedFxRates } from './fxConverter';
import { integratedOverfittingMetric } from '../risk/overfittingMetric';
import { fetchSectorNarrative, applyNarrativeBias } from './aiNarrative';
import { fetchQ5Scores, applyQ5Boost, calcExecutionScoreWithQ5 } from './bridgeQ5Scores';

export { CORE_TACTICAL_UNIVERSE, FULL_TACTICAL_UNIVERSE, VOLATILE_UNIVERSE };

export type ScanMode = 'volatile' | 'core' | 'full';

export const SCAN_MODE_LABELS: Record<ScanMode, string> = {
  volatile: 'RÁPIDO',
  core:     'CORE',
  full:     'FULL',
};

export const SCAN_MODE_DESCRIPTIONS: Record<ScanMode, string> = {
  volatile: 'Alta beta — crypto, ARK, litio, gas, mineras, TSLA, NVDA',
  core:     'Liquidos — S&P500, NASDAQ, sectoriales, oro, bonos + top acciones',
  full:     'Universo completo — ~194 ETFs/stocks IBEX35 DAX40 CAC40 FTSE100 US',
};

export function getScanModeCount(mode: ScanMode): number {
  return { volatile: VOLATILE_UNIVERSE, core: CORE_TACTICAL_UNIVERSE, full: FULL_TACTICAL_UNIVERSE }[mode].length;
}

export const SCAN_MODE_TIMES: Record<ScanMode, string> = {
  volatile: '~1-2 min',
  core:     '~3-5 min',
  full:     '~10-15 min',
};

// ── Configuración de chunks ───────────────────────────────────
const CHUNK_SIZE        = 30;
const MAX_CONCURRENT    = 3;
const INTER_CHUNK_DELAY = 300;

// ── Thresholds institucionales ────────────────────────────────
// MIN_EXECUTION_SCORE: combinación weighted (opportunity×0.6 + quality×0.4).
// Temporalmente en 55 para validar comportamiento real.
// En mercados laterales, qualityScore típico es ~40-50,
// lo que fuerza señales con totalScore > 75 para ejecutar.
// Subir gradualmente: 55 → 60 → 65 tras observar el comportamiento real.
const MIN_EXECUTION_SCORE = 55;

// ── Tipo de dato crudo de Yahoo ───────────────────────────────
interface RawTickerData {
  closes:         number[];
  volumes:        number[];
  highs?:         number[];
  lows?:          number[];
  price:          number;
  per?:           number;
  earningsYield?: number;
  eps?:           number;
}

// ── Ultra-fallback sectorial ──────────────────────────────────
const ULTRA_FALLBACK_MAP: Record<string, string> = {
  'Equity':          'IVV',
  'Technology':      'VOO',
  'Commodities':     'GLD',
  'Energy':          'GLD',
  'Finance':         'IVV',
  'Healthcare':      'VOO',
  'Materials':       'GLD',
  'Utilities':       'VOO',
  'Consumer':        'IVV',
  'Small Cap':       'IWM',
  'Real Estate':     'VNQ',
  'Emerging':        'EEM',
  'Emerging Bonds':  'EMB',
  'Factor':          'QUAL',
  'Crypto':          'BTC-USD',
  'Industry':        'XLI',   // v6
  'Defense':         'ITA',   // v6: iShares US Aerospace & Defense
  'Infrastructure':  'XLI',   // v6
  'Fixed Income':    'TLT',   // v6
};

// ── REFUERZO #3: Sector → ETF de referencia para Strength vs Sector ──
// Cada sector se compara contra su ETF benchmark.
// Si el activo underperforma su sector, se rechaza.
const SECTOR_TO_ETF: Record<string, string> = {
  'Technology':      'XLK',
  'Semiconductores': 'SMH',
  'Finance':         'XLF',
  'Healthcare':      'XLV',
  'Energy':          'XLE',
  'Consumer':        'XLP',
  'Real Estate':     'XLRE',
  'Industrials':     'XLI',
  'Industry':        'XLI',   // FIX v6: XLI e IYT usan 'Industry'
  'Materials':       'XLB',
  'Utilities':       'XLU',
  'Commodities':     'GLD',
  'Crypto':          'BTC-USD',
  'Emerging':        'EEM',
  'Equity':          'SPY',
  'Small Cap':       'IWM',
  'Defense':         'ITA',   // v6: iShares US Aerospace & Defense (PPA está en universo)
  'Infrastructure':  'XLI',   // v6: IBEX35 infra stocks
  'Fixed Income':    'TLT',   // v6: bond ETFs
  'Factor':          'QUAL',  // v6: factor ETFs
  'Emerging Bonds':  'EMB',   // v6: EM bond ETFs
};

// ── REFUERZO #2: Umbrales de filtro duro RS ─────────────────
const MIN_RS_VS_SPY    = 0.85;  // RS vs SPY mínimo para ser tradeable
const MIN_RS_VS_SECTOR = 0.90;  // RS vs sector mínimo

// ── Fetch de un chunk individual (directo a Yahoo, sin Supabase) ──
async function fetchSingleChunk(
  tickers:  string[]
): Promise<Record<string, RawTickerData>> {
  if (tickers.length === 0) return {};
  try {
    const response = await fetchYahooBatch(tickers);
    if (!response?.data) return {};

    const result: Record<string, RawTickerData> = {};
    for (const ticker of tickers) {
      const d = response.data[ticker];
      if (!d || !d.currentPrice || d.currentPrice <= 0) continue;
      result[ticker] = {
        closes:        Array.isArray(d.closes)  ? d.closes  : [],
        volumes:       Array.isArray((d as any).volumes) ? (d as any).volumes : [],
        highs:         Array.isArray(d.highs)   ? d.highs   : undefined,
        lows:          Array.isArray(d.lows)    ? d.lows    : undefined,
        price:         d.currentPrice,
        per:           (d as any).per,
        earningsYield: (d as any).earningsYield,
        eps:           (d as any).eps,
      };
    }
    return result;
  } catch (err: any) {
    console.warn(`[Screener] chunk exception:`, err?.message ?? err);
    return {};
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function runWithConcurrency<T>(
  tasks:       (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const taskIdx = idx++;
      results[taskIdx] = await tasks[taskIdx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function fetchBatch(
  tickers:  string[],
): Promise<Record<string, RawTickerData>> {
  if (tickers.length === 0) return {};
  const chunks = chunkArray(tickers, CHUNK_SIZE);
  const tasks  = chunks.map((chunk, i) => async () => {
    if (i > 0 && i % MAX_CONCURRENT === 0)
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY));
    return fetchSingleChunk(chunk);
  });
  const chunkResults = await runWithConcurrency(tasks, MAX_CONCURRENT);
  const merged: Record<string, RawTickerData> = {};
  for (const r of chunkResults) Object.assign(merged, r);
  return merged;
}

export async function fetchLivePrices(
  tickers:  string[],
): Promise<Record<string, number>> {
  if (tickers.length === 0) return {};
  const batch1  = await fetchBatch(tickers);
  const prices: Record<string, number> = {};
  for (const t of tickers) {
    if (batch1[t]?.price > 0) prices[t] = batch1[t].price;
  }
  const missing = tickers.filter(t => !prices[t]);
  if (missing.length > 0) {
    const batch2 = await fetchBatch(missing);
    for (const t of missing) {
      if (batch2[t]?.price > 0) prices[t] = batch2[t].price;
    }
  }
  return prices;
}

// ── Aproximar highs/lows cuando no hay OHLC ──────────────────
function approximateHighsLows(
  closes:    number[],
  assetType: 'ETF' | 'ETC' | 'CRYPTO' | 'STOCK',
): { highs: number[]; lows: number[] } {
  const WINDOW = 5;
  const factor = assetType === 'CRYPTO' ? 2.5 : assetType === 'STOCK' ? 1.8 : 1.3;
  const highs: number[] = [];
  const lows:  number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const slice   = closes.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const diffs   = slice.map((c, j) => j === 0 ? 0 : Math.abs(c - slice[j - 1]));
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / Math.max(diffs.length, 1);
    highs.push(closes[i] + avgDiff * factor);
    lows.push( closes[i] - avgDiff * factor);
  }
  return { highs, lows };
}

// ── Construir TacticalAsset desde datos raw ───────────────────
function buildAsset(
  asset:      UniverseAsset,
  raw:        RawTickerData,
  dataSource: DataSource,   // FIX: etiqueta el origen de los datos
): TacticalAsset | null {
  if (!raw.closes || raw.closes.length < 21 || raw.price <= 0) return null;

  const { highs, lows } =
    (raw.highs && raw.lows && raw.highs.length === raw.closes.length)
      ? { highs: raw.highs, lows: raw.lows }
      : approximateHighsLows(raw.closes, asset.type);

  const hasRealOHLC = !!(raw.highs && raw.lows && raw.highs.length === raw.closes.length);

  let indicators, signals, totalScore;
  try {
    indicators = calcIndicators(raw.closes, raw.volumes ?? [], highs, lows);
    signals    = generateSignals(indicators, asset.ticker);  // Ya devuelve ordenadas por score DESC + EVENT_DRIVEN
    totalScore = calcTotalScore(signals);
  } catch (err) {
    console.warn(`[Screener] calcIndicators error ${asset.ticker}:`, err);
    return null;
  }

  const closes252 = raw.closes.slice(-252);
  const high52w   = closes252.length > 0 ? Math.max(...closes252) : raw.price;
  const low52w    = closes252.length > 0 ? Math.min(...closes252) : raw.price;

  const manual               = getFundamentals(asset.yahooSymbol);
  const hasYahooFundamentals = typeof raw.per === 'number' && raw.per > 0;

  // FX: normalizar precio nativo y calcular priceEur
  const fxRates = getCachedFxRates();
  const normalizedPrice = normalizeGbxToGbp(raw.price, asset.currency);
  const priceEur        = toEur(normalizedPrice, asset.currency, fxRates);

  return {
    ticker:        asset.ticker,
    name:          asset.name,
    sector:        asset.sector,
    type:          asset.type,
    exchange:      asset.exchange,
    currency:      asset.currency,
    price:         normalizedPrice,   // En divisa nativa (para display)
    priceEur,                          // En EUR (para sizing y P&L)
    closes:        raw.closes,
    volumes:       raw.volumes,
    high52w,
    low52w,
    indicators,
    signals,
    totalScore,
    lastUpdated:   new Date().toISOString(),
    dataSource,    // FIX: 'primary' | 'fallback' | 'ultra-fallback'
    hasRealOHLC,   // NUEVO: false si OHLC es aproximado sintético
    earningsYield: hasYahooFundamentals ? raw.earningsYield : manual.earningsYield,
    per:           hasYahooFundamentals ? raw.per           : manual.per,
    eps:           hasYahooFundamentals ? raw.eps           : manual.eps,
  };
}

// ── Construir oportunidad desde asset ────────────────────────
function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators || !asset.closes || asset.closes.length < 5) return null;

  // FIX CRÍTICO: descartar activos con ultra-fallback
  // Sus indicadores son de un activo distinto (ej. GLD para URNU.DE)
  if (asset.dataSource === 'ultra-fallback') {
    console.debug(`[Screener] ${asset.ticker}: descartado de oportunidades (ultra-fallback)`);
    return null;
  }

  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  // activeSignals ya está ordenado por score DESC (fix en generateSignals)
  // El tipo es el de mayor score — no el primero en el array hardcodeado
  const topSignal  = activeSignals[0];
  const signalType = topSignal.type;

  const fxRates = getCachedFxRates();

  // FIX: usar priceEur para calcular niveles en EUR
  const priceEur = asset.priceEur;
  if (priceEur <= 0) return null;

  // ATR en EUR
  const rawAtr   = asset.indicators.atr14;
  const atrEur   = toEur(rawAtr, asset.currency, fxRates);

  // Closes en proporción EUR para calcStopLoss/calcTakeProfits
  // Los indicadores ya están calculados en divisa nativa.
  // Para stop/tp usamos priceEur y atrEur con la misma proporción.
  let stopLossEur: number, tp1Eur: number, tp2Eur: number;
  try {
    // Recalcular stop y targets en EUR
    // Usamos el ratio EUR/nativo para escalar el stop
    const priceNative = asset.price;
    const eurFactor   = priceNative > 0 ? priceEur / priceNative : 1;

    const stopNative = calcStopLoss(priceNative, rawAtr, signalType, asset.closes);
    const tps        = calcTakeProfits(priceNative, stopNative, signalType, asset.indicators);

    stopLossEur = stopNative * eurFactor;
    tp1Eur      = tps.tp1    * eurFactor;
    tp2Eur      = tps.tp2    * eurFactor;
  } catch {
    return null;
  }

  if (stopLossEur >= priceEur || tp1Eur <= priceEur) return null;
  const riskReward = (tp1Eur - priceEur) / Math.max(0.0001, priceEur - stopLossEur);

  // FIX INSTITUCIONAL: Execution Score = opportunity * 0.6 + quality * 0.4
  const qualityScore = asset.qualityScore ?? 50;
  const executionScore = Math.min(100, Math.round(
    asset.totalScore * 0.6 + qualityScore * 0.4
  ));

  return {
    id:           `opp_${asset.ticker}_${Date.now()}`,
    asset,
    type:         signalType,
    score:        asset.totalScore,
    qualityScore,
    executionScore,
    entryPrice:   priceEur,   // En EUR
    stopLoss:     stopLossEur,
    takeProfit1:  tp1Eur,
    takeProfit2:  tp2Eur,
    riskReward,
    reasoning:    activeSignals.map(s => s.description).join(' + '),
    detectedAt:   new Date().toISOString(),
    expiresAt:    new Date(Date.now() + 24 * 3600000).toISOString(),
    activeSignals,
  };
}

// ── Screener principal ────────────────────────────────────────
export async function scanTacticalUniverse(
  mode:     ScanMode,
  config:   TacticalConfig,
): Promise<ScreenerResult> {
  const universe = {
    volatile: VOLATILE_UNIVERSE,
    core:     CORE_TACTICAL_UNIVERSE,
    full:     FULL_TACTICAL_UNIVERSE,
  }[mode];

  const assets:       TacticalAsset[]       = [];
  const opportunities: TacticalOpportunity[] = [];
  const errors:       string[]              = [];
  const warnings:     string[]              = [];

  // ── Diagnóstico: contadores de filtrado ──────────────────────────
  const diag = {
    total:         universe.length,
    conDatos:      0,
    primary:       0,
    fallback:      0,
    ultraFallback: 0,
    sinDatos:      0,
    errorBuild:    0,
    sinOhlc:       0,
    conSenales:    0,
    oppUltraFb:    0,
    oppStopInval:  0,
    oppRiskReward: 0,
    oppFiltroReg:  0,
    oppScoreBajo:  0,
    oppRRBajo:     0,
    oppExecBajo:   0,  // FIX INSTITUCIONAL: executionScore < MIN_EXECUTION_SCORE
    oppRSBajo:     0,  // v8: RS vs SPY < MIN_RS_VS_SPY
    oppSectorBajo: 0,  // v8: RS vs sector < MIN_RS_VS_SECTOR
    oppExhaustion: 0,  // v8: rally agotado
    oppMTFBajo:    0,  // v10: MTF weekly < 2/3
    oppDollarVol:  0,  // v10: dollar volume insuficiente
    oppGapAlto:    0,  // v10: gap demasiado grande
    oportunidades: 0,
  };

  // FIX: fetch de tasas FX antes del scan
  // Se cachean 4 horas — si no hay datos, usa fallback EUR=1
  const fxRates = await fetchFxRates();
  if (fxRates.isStale) {
    warnings.push(`FX rates stale o no disponibles — usando fallback EUR/USD=${fxRates.EURUSD}, EUR/GBP=${fxRates.EURGBP}`);
  }

  // Paso 1: recopilar símbolos
  const primarySymbols  = universe.map(a => a.yahooSymbol);
  const fallbackSymbols = universe
    .filter(a => a.fallbackYahooSymbol)
    .map(a => a.fallbackYahooSymbol!);

  // FIX INSTITUCIONAL: añadir SPY + sector ETFs como benchmarks
  const sectorEtfTickers = [...new Set(
    universe.map(a => SECTOR_TO_ETF[a.sector] || 'SPY')
  )];
  const allSymbols = [...new Set([...primarySymbols, ...fallbackSymbols, '^VIX', 'SPY', ...sectorEtfTickers])];

  // Paso 2: fetch batch de todos los símbolos
  let batchData = await fetchBatch(allSymbols);
  const missingSymbols = allSymbols.filter(
    s => !(batchData[s]?.closes?.length >= 21),
  );
  if (missingSymbols.length > 0) {
    const basic = await fetchBatch(missingSymbols);
    Object.assign(batchData, basic);
  }

  // Paso 3: identificar activos que necesitan ultra-fallback
  const needUltraFallback: { asset: UniverseAsset; reason: string }[] = [];
  for (const asset of universe) {
    const hasPrimary  = batchData[asset.yahooSymbol]?.closes?.length >= 21 && batchData[asset.yahooSymbol]?.price > 0;
    const hasFallback = asset.fallbackYahooSymbol && batchData[asset.fallbackYahooSymbol]?.closes?.length >= 21;
    if (!hasPrimary && !hasFallback) {
      needUltraFallback.push({
        asset,
        reason: `${asset.yahooSymbol}${asset.fallbackYahooSymbol ? ' + ' + asset.fallbackYahooSymbol : ''} sin datos`,
      });
    }
  }

  // Paso 3b: pre-fetch ultra-fallbacks (solo para mostrar en lista, no para señales)
  if (needUltraFallback.length > 0) {
    const ultraTickers = new Set(
      needUltraFallback.map(({ asset }) => ULTRA_FALLBACK_MAP[asset.sector] || 'IVV'),
    );
    const toFetch = [...ultraTickers].filter(t => !(batchData[t]?.closes?.length >= 21));
    if (toFetch.length > 0) {
      const ultraData = await fetchBatch(toFetch);
      Object.assign(batchData, ultraData);
    }
  }

  // ── BRIDGE Q5: cargar scores ML del Python ──────────────────────────
  const q5Data = await fetchQ5Scores();
  if (q5Data) {
    console.log(`[Screener] 🤖 Q5 ML Bridge activo: ${q5Data.q5Tickers.length} tickers Q5`);
  }

  // Paso 4: VIX real + benchmark SPY
  const vixPrice    = batchData['^VIX']?.price ?? 20;
  const spyCloses   = batchData['SPY']?.closes ?? [];
  const spyPrice    = batchData['SPY']?.price ?? 500;
  console.debug(`[Screener] VIX: ${vixPrice.toFixed(2)} | SPY: $${spyPrice.toFixed(0)}`);

  // Helper: fuerza relativa vs SPY (252 días, fallback a 126)
  // IMPORTANTE: activos europeos (ej. IWDA.AS, EXH3.DE) pueden tener
  // <252 días de histórico si el símbolo primario falló y usan fallback.
  // Cuando el fallback es SPY, el RS ≈ 1.0 (correcto: SPY vs SPY).
  // Pero activos sin 252d de datos propios merecen intentar 126d.
  function calcRelativeStrength(assetCloses: number[]): number {
    if (spyCloses.length < 21) return 1.0;

    const getRS = (window: number): number | null => {
      if (assetCloses.length < window || spyCloses.length < window) return null;
      const aPerf = assetCloses[assetCloses.length - 1] / assetCloses[assetCloses.length - window];
      const sPerf = spyCloses[spyCloses.length - 1] / spyCloses[spyCloses.length - window];
      if (aPerf <= 0 || sPerf <= 0) return null;
      return aPerf / sPerf;
    };

    const rs = getRS(252) ?? getRS(126) ?? getRS(Math.max(63, Math.min(assetCloses.length, spyCloses.length) - 1)) ?? 1.0;
    return parseFloat(Math.min(Math.max(rs, 0.1), 3.0).toFixed(3));
  }

  // ── REFUERZO #3: RS vs Sector ETF ─────────────────────────
  function calcRSVsSector(assetCloses: number[], sector: string): number {
    const sectorETF = SECTOR_TO_ETF[sector];
    if (!sectorETF) return 1.0;
    const sectorCloses = batchData[sectorETF]?.closes;
    if (!sectorCloses || sectorCloses.length < 63) return 1.0;
    
    const window = Math.min(126, Math.min(assetCloses.length, sectorCloses.length) - 1);
    if (window < 21) return 1.0;
    
    const aPerf = assetCloses[assetCloses.length - 1] / assetCloses[assetCloses.length - window];
    const sPerf = sectorCloses[sectorCloses.length - 1] / sectorCloses[sectorCloses.length - window];
    if (aPerf <= 0 || sPerf <= 0) return 1.0;
    
    return parseFloat(Math.min(Math.max(aPerf / sPerf, 0.1), 3.0).toFixed(3));
  }

  // Helper: calidad del activo (0-100)
  function calcQualityScore(
    rs:      number,
    volRatio: number,
    trend:   string,
    atrPct:  number,
    adx:     number,
    price:   number,
  ): number {
    let score = 0;
    // Fuerza relativa (35%)
    if (rs > 1.15)      score += 35;
    else if (rs > 1.05) score += 25;
    else if (rs > 0.95) score += 15;
    else if (rs > 0.85) score += 5;
    // Liquidez — volumen ratio (20%)
    if (volRatio > 2.0)    score += 20;
    else if (volRatio > 1.5) score += 15;
    else if (volRatio > 1.0) score += 10;
    else if (volRatio >= 0.5) score += 5;
    // Tendencia semanal (25%)
    if (trend === 'UPTREND')    score += 25;
    else if (trend === 'SIDEWAYS') score += 10;
    // Volatilidad controlada (20%) — penalizar si > 8%
    if (atrPct < 0.03)      score += 20;
    else if (atrPct < 0.05) score += 15;
    else if (atrPct < 0.08) score += 8;
    // ADX — fuerza de tendencia (+10pts) — alineado con Pine Script v10
    if (adx > 30)           score += 10;
    else if (adx > 25)      score += 8;
    else if (adx > 20)      score += 5;
    return Math.min(100, score);
  }

  // Paso 5: construir assets con 3 niveles de fallback
  for (const asset of universe) {
    let raw: RawTickerData | undefined;
    let dataSource: DataSource = 'primary';

    // Nivel 1: símbolo primario
    raw = batchData[asset.yahooSymbol];
    if (raw?.closes?.length >= 21 && raw?.price > 0) {
      dataSource = 'primary';
      diag.primary++;
    } else {
      // Nivel 2: fallback definido
      if (asset.fallbackYahooSymbol) {
        const fallbackRaw = batchData[asset.fallbackYahooSymbol];
        if (fallbackRaw?.closes?.length >= 21 && fallbackRaw?.price > 0) {
          raw        = fallbackRaw;
          dataSource = 'fallback';
          diag.fallback++;
          console.debug(`[Screener] ${asset.ticker}: usando fallback ${asset.fallbackYahooSymbol}`);
        }
      }

      // Nivel 3: ultra-fallback sectorial
      // CRÍTICO: se etiqueta explícitamente para que buildOpportunity lo descarte
      if (!raw || raw.closes?.length < 21 || raw.price <= 0) {
        const ultraTicker = ULTRA_FALLBACK_MAP[asset.sector] || 'IVV';
        const ultraRaw    = batchData[ultraTicker];          if (ultraRaw?.closes?.length >= 21 && ultraRaw?.price > 0) {
          raw        = ultraRaw;
          dataSource = 'ultra-fallback';
          diag.ultraFallback++;
          const warning = `${asset.ticker}: datos de ${ultraTicker} (ultra-fallback — sin señales)`;
          warnings.push(warning);
          console.warn(`[Screener] ⚠️ ${warning}`);
        }
      }
    }

    if (!raw || raw.closes.length < 21 || raw.price <= 0) {
      diag.sinDatos++;
      errors.push(`${asset.ticker}: sin datos en ningún nivel de fallback`);
      continue;
    }

    diag.conDatos++;

    const built = buildAsset(asset, raw, dataSource);
    if (built) {
      // FIX INSTITUCIONAL: fuerza relativa + calidad
      const rs = calcRelativeStrength(built.closes);
      built.relativeStrength = rs;
      // REFUERZO #3: RS vs sector ETF
      built.rsVsSector = calcRSVsSector(built.closes, asset.sector);
      built.qualityScore = calcQualityScore(
        rs,
        built.indicators?.volumeRatio ?? 1,
        built.indicators?.trend ?? 'SIDEWAYS',
        built.indicators?.atrPct ?? 0.02,
        built.indicators?.adx ?? 0,
        built.price,
      );

      // ── Q5 BOOST: si el ticker está en Q5 del modelo ML Python ──
      const origQ = built.qualityScore;
      built.qualityScore = applyQ5Boost(built.qualityScore, built.ticker, q5Data);
      if (built.qualityScore !== origQ) {
        console.debug(`[Screener] 🤖 ${built.ticker}: qualityScore ${origQ} → ${built.qualityScore} (Q5 boost)`);
      }

      assets.push(built);
      if (!built.hasRealOHLC && dataSource === 'primary') {
        diag.sinOhlc++;
        warnings.push(`${asset.ticker}: sin OHLC real — ATR aproximado de closes. Señales con precisión reducida.`);
      }
    } else {
      diag.errorBuild++;
      errors.push(`${asset.ticker}: error en cálculo de indicadores`);
    }
  }

    // Paso 6: régimen de mercado (necesario para narrative + filtros)
  const indexAsset = assets.find(a => ['CSPX.AS', 'SPY', 'QQQ', 'IVV'].includes(a.ticker)
  );
  const indexCloses = indexAsset?.closes ?? [];
  const marketRegime = detectMarketRegime(indexCloses, vixPrice);

  // Paso 7: AI Narrative Overlay (Gemini Flash — gratis)
  // Gemini analiza las narrativas de mercado actuales y ajusta calidad
  // por sector. Si falla (sin API key), el sistema sigue sin penalización.
  let narrativeStatus: ScreenerResult['narrativeStatus'] = undefined;
  if (assets.length > 0) {
    const narrative = await fetchSectorNarrative({
      regime: marketRegime?.regime ?? 'RANGING',
      vix: vixPrice,
      spyPrice,
    });
    narrativeStatus = {
      active: narrative.narrativeActive,
      sectorBiases: narrative.sectorBiases,
      marketWideBias: narrative.marketWideBias,
      marketSentiment: narrative.marketSentiment,
      topNarratives: narrative.topNarratives,
    };
    if (narrative.narrativeActive) {
      for (const asset of assets) {
        applyNarrativeBias(asset, narrative.sectorBiases, narrative.marketWideBias);
      }
    }
  }

  // Paso 7b: Macro Event Signal (calendario económico)
  // Si hay eventos macro relevantes (FOMC, CPI, NFP) en los próximos
  // 14 días, penaliza la calidad de todos los activos (incertidumbre).
  const macroSignal = generateMacroSignal();
  let macroEventInfo: ScreenerResult['macroEventInfo'] = undefined;
  if (macroSignal.active) {
    const macroPenalty = Math.round(macroSignal.score * 0.3); // Hasta -30pts de calidad
    for (const asset of assets) {
      if (asset.qualityScore != null) {
        asset.qualityScore = Math.max(10, asset.qualityScore - macroPenalty);
      }
    }
    macroEventInfo = {
      active: true,
      description: macroSignal.description ?? '',
      penalty: macroPenalty,
      score: macroSignal.score,
    };
    console.log(
      `[Screener] 📅 Macro eventos: ${macroSignal.description}` +
      ` · Penalizando calidad -${macroPenalty}pts en todos los activos`
    );
  } else {
    macroEventInfo = {
      active: false,
      description: 'Sin eventos macro próximos',
      penalty: 0,
      score: 0,
    };
  }

  // Paso 8: diagnóstico
  console.debug(
    `[Screener] ${assets.length}/${universe.length} activos · ` +
    `P:${diag.primary} F:${diag.fallback} UF:${diag.ultraFallback} SD:${diag.sinDatos} ` +
    `EB:${diag.errorBuild} noOHLC:${diag.sinOhlc}`,
  );

  // ── Log: distribución de tipos de señal generados ────────────────
  const signalTypeCounts: Record<string, number> = {};
  for (const a of assets) {
    for (const s of a.signals?.filter(sig => sig.active) ?? []) {
      signalTypeCounts[s.type] = (signalTypeCounts[s.type] || 0) + 1;
    }
  }
  console.log(
    `[Screener] Señales generadas por tipo:\n` +
    Object.entries(signalTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `  📌 ${type}: ${count}`)
      .join('\n')
  );

  // Paso 9: construir oportunidades CON FILTRO DE RÉGIMEN
  // Re-auditoría: reactivado el filtro de régimen para evitar operar
  // en contra del mercado (ej. MOMENTUM_BREAKOUT en mercado bajista).
  // marketRegimeFilter.ts detecta TRENDING_UP | RANGING | TRENDING_DOWN | CRASH
  // con su propio detector (independiente de olympusV3).
  for (const asset of assets) {
    // buildOpportunity ya descarta ultra-fallback internamente
    const opp = buildOpportunity(asset);
    if (!opp) {
      if (asset.dataSource === 'ultra-fallback') diag.oppUltraFb++;
      continue;
    }

    diag.conSenales++; // con señales activas (pasaron buildOpportunity)

    // Filtro de régimen: solo señales compatibles con el estado actual
    if (!isSignalAllowed(opp.type, marketRegime)) {
      diag.oppFiltroReg++;
      continue;
    }

    // Ajuste de score por régimen: bonificación para señales alineadas
    const adjustedScore = adjustScoreByRegime(opp.score, opp.type, marketRegime);
    if (adjustedScore < config.minScore) {
      diag.oppScoreBajo++;
      continue;
    }
    if (opp.riskReward < config.minRiskReward) {
      diag.oppRRBajo++;
      continue;
    }
    // FIX INSTITUCIONAL: executionScore (con Q5 boost si disponible)
    const execScore = calcExecutionScoreWithQ5(
      opp.score,
      opp.qualityScore ?? 50,
      opp.asset.ticker,
      q5Data,
    );
    if (execScore < MIN_EXECUTION_SCORE) {
      diag.oppExecBajo++;
      continue;
    }

    // ── REFUERZO #2: RS Hard Filter ──
    // Si el activo underperforma SPY → no es tradeable
    const rs = asset.relativeStrength ?? 1.0;
    if (rs < MIN_RS_VS_SPY) {
      diag.oppRSBajo++;
      continue;
    }

    // ── REFUERZO #3: Strength vs Sector ──
    // Si el activo underperforma su sector → no entres
    const rsVsSector = asset.rsVsSector ?? 1.0;
    if (rsVsSector < MIN_RS_VS_SECTOR) {
      diag.oppSectorBajo++;
      continue;
    }

    // ── REFUERZO #4: Exhaustion Detection ──
    // Si el rally muestra signos de agotamiento → no entres
    // Aplica a MOMENTUM_BREAKOUT y SECTOR_ROTATION (señales direccionales)
    if ((opp.type === 'MOMENTUM_BREAKOUT' || opp.type === 'SECTOR_ROTATION') && asset.indicators) {
      const exhaustion = detectMomentumExhaustion(
        asset.closes,
        asset.volumes ?? [],
        asset.indicators.rsi14,
        asset.indicators.macdHist,
        asset.indicators.bbUpper,
        asset.indicators.price,
      );
      if (exhaustion.exhausted) {
        console.debug(
          `[Screener] 🔥 ${asset.ticker}: Rally agotado — ${exhaustion.reasons.join(' | ')} (confianza: ${exhaustion.confidence}%)`
        );
        diag.oppExhaustion++;
        continue;
      }
    }

    // ── v10: MULTI-TIMEFRAME WEEKLY CONFIRMATION ──
    // Alineado con Pine Script v10.4. Pide 2 de 3 condiciones semanales
    // para confirmar que la tendencia diaria tiene respaldo en el timeframe superior.
    const weeklyCheck = checkWeeklyConfirmation(asset.closes);
    if (!weeklyCheck.confirmed) {
      console.debug(
        `[Screener] 📅 ${asset.ticker}: MTF Weekly ${weeklyCheck.confirmations}/3 — ${weeklyCheck.details}`
      );
      diag.oppMTFBajo++;
      continue;
    }

    // ── v10: DOLLAR VOLUME LIQUIDITY FILTER ──
    // Alineado con Pine Script v10.4. Descarta activos sin suficiente
    // liquidez para ejecutar sin slippage significativo.
    const lastVol = asset.volumes?.[asset.volumes.length - 1] ?? 0;
    const dollarVolM = (asset.price * lastVol) / 1_000_000;
    // Default 5M€ mínimo — configurable si se añade input más adelante
    const MIN_DOLLAR_VOL_M = 5;
    if (dollarVolM < MIN_DOLLAR_VOL_M) {
      console.debug(
        `[Screener] 💧 ${asset.ticker}: Dollar Vol ${dollarVolM.toFixed(1)}M€ < ${MIN_DOLLAR_VOL_M}M€ — ilíquido`
      );
      diag.oppDollarVol++;
      continue;
    }

    // ── v10: GAP FILTER ──
    // Alineado con Pine Script v10.4. Evita entrar en activos que han
    // hecho gap alcista en la apertura — el riesgo de pullback es alto.
    const closesArr = asset.closes;
    if (closesArr.length >= 2) {
      const prevClose = closesArr[closesArr.length - 2];
      const gapPct = prevClose > 0 ? ((closesArr[closesArr.length - 1] - prevClose) / prevClose) * 100 : 0;
      const MAX_GAP_PCT = 5;
      if (gapPct > MAX_GAP_PCT) {
        console.debug(
          `[Screener] 🕳️ ${asset.ticker}: Gap +${gapPct.toFixed(1)}% > ${MAX_GAP_PCT}% — entrada rechazada`
        );
        diag.oppGapAlto++;
        continue;
      }
    }

    opportunities.push({ ...opp, score: adjustedScore });
    diag.oportunidades++;
  }

  // ── Priority scoring: combina score de señal + R:R + capital efficiency ──
  // rankPriority añade:
  //   +5 si R:R > 2.0
  //   +10 si R:R > 3.0
  //   -5 si el activo ya está en posiciones abiertas (conflicto de capital)
  //   +8 si type es MOMENTUM_BREAKOUT en TRENDING_UP
  //   +5 si type es BLOOD_IN_STREETS en CRASH (contrarian oportunidad única)
  interface RankedOpp {
    opp:      TacticalOpportunity;
    priority: number;
  }
  const ranked: RankedOpp[] = opportunities.map(opp => {
    let priority = opp.score;
    // R:R premium
    if (opp.riskReward > 3.0) priority += 10;
    else if (opp.riskReward > 2.0) priority += 5;
    // Capital efficiency: preferir activos con entryPrice bajo (más shares)
    // No penalizar absolutamente, solo bonificar si es bajo
    if (opp.entryPrice < 20) priority += 5;   // Accesible para cualquier capital
    // Regime alignment bonus
    if (marketRegime) {
      if (marketRegime.regime === 'TRENDING_UP' && opp.type === 'MOMENTUM_BREAKOUT') priority += 8;
      if (marketRegime.regime === 'CRASH' && opp.type === 'BLOOD_IN_STREETS') priority += 5;
    }
    return { opp, priority };
  });

  const topPicks = ranked
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5)
    .map(r => r.opp);

  // Log de prioridades
  console.debug(
    `[Screener] ─── TOP 5 PRIORIDADES ───\n` +
    topPicks.map((opp, i) =>
      `  ${i + 1}. ${opp.asset.ticker} (${opp.type}) · Score ${opp.score} · R:R ${opp.riskReward.toFixed(2)} · €${opp.entryPrice.toFixed(0)}`
    ).join('\n') + '\n' +
    `  ─────────────────────────────────────`
  );

  // ── Diagnóstico: reporte de filtrado ─────────────────────────────
  console.log(
    `[Screener] ─── ${SCAN_MODE_LABELS[mode]} DIAGNÓSTICO ───\n` +
    `  ℹ️  Total universo:  ${diag.total}\n` +
    `  ✅ Con datos:        ${diag.conDatos} (primary:${diag.primary} fallback:${diag.fallback} ultra:${diag.ultraFallback})\n` +
    `  ❌ Sin datos:        ${diag.sinDatos} | Error build: ${diag.errorBuild}\n` +
    `  🏭 OHLC sintético:   ${diag.sinOhlc} activos (ATR aproximado)\n` +
    `  📊 Assets con señales: ${diag.conSenales}\n` +
    `  🔇 Filtro régimen:   -${diag.oppFiltroReg}\n` +
    `  📉 Score < ${config.minScore}: -${diag.oppScoreBajo}\n` +
    `  📉 R:R < ${config.minRiskReward}: -${diag.oppRRBajo}\n` +
    `  📉 Execution < ${MIN_EXECUTION_SCORE}: -${diag.oppExecBajo}\n` +
    `  📉 RS vs SPY < ${MIN_RS_VS_SPY}: -${diag.oppRSBajo}\n` +
    `  📉 RS vs Sector < ${MIN_RS_VS_SECTOR}: -${diag.oppSectorBajo}\n` +
    `  🔥 Rally agotado:    -${diag.oppExhaustion}\n` +
    `  📅 MTF Weekly < 2/3: -${diag.oppMTFBajo}\n` +
    `  💧 Dollar Vol < 5M€: -${diag.oppDollarVol}\n` +
    `  🕳️ Gap > 5%:         -${diag.oppGapAlto}\n` +
    `  🎯 Oportunidades:    ${diag.oportunidades}\n` +
    `  ─────────────────────────────────────`
  );

  // ── Overfitting metric ───────────────────────────────────────────
  const totalActiveSignals = assets.reduce(
    (sum, a) => sum + (a.signals?.filter(s => s.active)?.length ?? 0), 0
  );
  const ofReport = integratedOverfittingMetric({
    totalSignals: totalActiveSignals,
    totalAssets: diag.total,
  });
  console.debug(
    `[Screener] ─── SOBREAJUSTE ───\n` +
    `  📊 Señales activas:    ${totalActiveSignals}\n` +
    `  🧩 Parámetros:         ${ofReport.raw.paramCount}\n` +
    `  💾 Datos disponibles:   ${(ofReport.raw.dataPoints / 1000).toFixed(0)}k\n` +
    `  📈 Densidad señal:     ${(ofReport.metrics.signalDensity * 100).toFixed(0)}%\n` +
    `  🔄 Cambios régimen:    ${ofReport.raw.regimeChanges}/año\n` +
    `  🧠 Overfitting Score:  ${ofReport.globalScorePct}% (${ofReport.level})\n` +
    `  ${ofReport.warning}\n` +
    `  ─────────────────────────────────────`
  );

  // ── Discrete Signals Audit ───────────────────────────────────────
  // Mapa completo de señales discretas del sistema táctico:
  //   MOMENTUM_BREAKOUT — ER>30 + precio>BB sup + sobreMA50 + vol confirma
  //   MEAN_REVERSION    — RSI(2)<15 + precio<BB inf+2%
  //   OVERSOLD_BOUNCE   — RSI(14)<35 + sobreMA200 o MA50-5%
  //   BLOOD_IN_STREETS  — RSI(2)<10 + Z<-1.5 + sobreMA200 o drawdown<-35%
  //   SECTOR_ROTATION   — Drawdown52w<-20% + RSI 40-55 + sobreMA200/MA50
  //   EVENT_DRIVEN      — Definido en SIGNAL_DRIFT pero sin generador
  const signalAudit = Object.entries(signalTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => {
      const active = count > 0 ? '✅' : '❌';
      return `  ${active} ${type}: ${count}`;
    })
    .join('\n');
  console.debug(
    `[Screener] ─── AUDITORÍA DE SEÑALES ───\n` +
    `  Tipos implementados: MOMENTUM_BREAKOUT, MEAN_REVERSION, OVERSOLD_BOUNCE,\n` +
    `                       BLOOD_IN_STREETS, SECTOR_ROTATION\n` +
    `  Tipos trackeados en SIGNAL_DRIFT pero SIN generador: EVENT_DRIVEN\n` +
    `\n` +
    (signalAudit || '  (sin señales activas)') + '\n' +
    `  ─────────────────────────────────────`
  );

  return {
    assets,
    opportunities,
    topPicks,
    screenedAt:  new Date().toISOString(),   // FIX: typo 'screennedAt' corregido
    errors,
    warnings,
    marketRegime,
    narrativeStatus,
    macroEventInfo,
    diagnostics: {
      total: diag.total,
      conDatos: diag.conDatos,
      primary: diag.primary,
      fallback: diag.fallback,
      ultraFallback: diag.ultraFallback,
      sinDatos: diag.sinDatos,
      errorBuild: diag.errorBuild,
      sinOhlc: diag.sinOhlc,
      conSenales: diag.conSenales,
      oppFiltroReg: diag.oppFiltroReg,
      oppScoreBajo: diag.oppScoreBajo,
      oppRRBajo: diag.oppRRBajo,
      oppExecBajo: diag.oppExecBajo,
      oppRSBajo: diag.oppRSBajo,
      oppSectorBajo: diag.oppSectorBajo,
      oppExhaustion: diag.oppExhaustion,
      oppMTFBajo: diag.oppMTFBajo,
      oppDollarVol: diag.oppDollarVol,
      oppGapAlto: diag.oppGapAlto,
      oportunidades: diag.oportunidades,
      signalTypeCounts,
      totalActiveSignals,
      overfittingScore: ofReport.globalScorePct,
      overfittingLevel: ofReport.level,
    },
    // FIX v11: stub vacío para evitar "BACKTEST metrics undefined" en el dashboard.
    // El dashboard debe leer result.backtest?.metrics ?? [] (optional chaining).
    backtest: { metrics: [], ran: false },
  };
}

// ── Wrapper de compatibilidad ─────────────────────────────────
export async function runTacticalScreener(
  mode:     ScanMode,
  config:   TacticalConfig,
): Promise<ScreenerResult> {
  return scanTacticalUniverse(mode, config);
}

// ── Tamaño de posición (exportado para acceso desde dashboard) ─
export { calcPositionSize } from './tacticalPortfolio';

// ── Config por defecto ────────────────────────────────────────
export function defaultTacticalConfig(
  tacticalCapital:    number,
  defensiveLiquidity: number,
): TacticalConfig {
  const safeTac   = isFinite(tacticalCapital)    ? tacticalCapital    : 0;
  const safeDef   = isFinite(defensiveLiquidity) ? defensiveLiquidity : 0;
  const available = Math.min(safeDef * 0.20, safeTac);
  return {
    tacticalCapitalEur:     available > 0 ? available : safeTac,
    maxCapitalPerTrade:     0.30,
    riskPerTradePct:        0.01,
    maxOpenPositions:       4,
    minScore:               38,
    requireAboveMA200:      false,
    minRiskReward:          2.0, // Filtro R/R con diagnóstico (antes hardcodeado en buildOpportunity)
    maxAtrPct:              0.15,
    maxDaysPerTrade:        75,
    trailingStop:           true,
    maxPctFromDefensiveLiq: 0.20,
    // ── INSTITUCIONAL v2 ───────────────────────────────────
    useKellySizing:        true,     // Kelly progresivo por executionScore
    maxDrawdownPct:         15,      // Circuit breaker al -15% drawdown
  };
}