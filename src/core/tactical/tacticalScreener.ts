// ============================================================
// src/core/tactical/tacticalScreener.ts — v12 REAL
//
// CORRECCIÓN DEFINITIVA:
//   Se ELIMINA el ultra‑fallback (proxies sectoriales).
//   Si un activo no tiene datos reales (primario ni fallback),
//   no se construye el asset y se añade un error.
//   El motor solo opera con información real.
// ============================================================

import type {
  TacticalAsset, TacticalOpportunity, ScreenerResult, TacticalConfig,
  DataSource,
} from './types';
import {
  calcIndicators, generateSignals, calcTotalScore,
  calcStopLoss, calcTakeProfits,
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

// ── Ya NO hay ultra‑fallback. Solo datos reales. ─────────────

// ── Fetch de un chunk individual ─────────────────────────────
async function fetchSingleChunk(
  supabase: any,
  tickers:  string[],
  fnName:   'yahoo-finance-tactical' | 'yahoo-finance',
): Promise<Record<string, RawTickerData>> {
  if (tickers.length === 0) return {};
  try {
    const { data, error } = await supabase.functions.invoke(fnName, {
      body: { tickers },
    });
    if (error) {
      console.warn(`[Screener] chunk error (${fnName}) [${tickers.slice(0,3).join(',')}...]:`, error?.message ?? error);
      return {};
    }
    if (!data?.data) return {};

    const result: Record<string, RawTickerData> = {};
    for (const ticker of tickers) {
      const d = data.data[ticker];
      if (!d || !d.currentPrice || d.currentPrice <= 0) continue;
      result[ticker] = {
        closes:        Array.isArray(d.closes)  ? d.closes  : [],
        volumes:       Array.isArray(d.volumes) ? d.volumes : [],
        highs:         Array.isArray(d.highs)   ? d.highs   : undefined,
        lows:          Array.isArray(d.lows)    ? d.lows    : undefined,
        price:         d.currentPrice,
        per:           d.per,
        earningsYield: d.earningsYield,
        eps:           d.eps,
      };
    }
    return result;
  } catch (err: any) {
    console.warn(`[Screener] chunk exception (${fnName}):`, err?.message ?? err);
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
  supabase: any,
  tickers:  string[],
  fnName:   'yahoo-finance-tactical' | 'yahoo-finance',
): Promise<Record<string, RawTickerData>> {
  if (tickers.length === 0) return {};
  const chunks = chunkArray(tickers, CHUNK_SIZE);
  const tasks  = chunks.map((chunk, i) => async () => {
    if (i > 0 && i % MAX_CONCURRENT === 0)
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY));
    return fetchSingleChunk(supabase, chunk, fnName);
  });
  const chunkResults = await runWithConcurrency(tasks, MAX_CONCURRENT);
  const merged: Record<string, RawTickerData> = {};
  for (const r of chunkResults) Object.assign(merged, r);
  return merged;
}

export async function fetchLivePrices(
  supabase: any,
  tickers:  string[],
): Promise<Record<string, number>> {
  if (tickers.length === 0) return {};
  const batch1  = await fetchBatch(supabase, tickers, 'yahoo-finance-tactical');
  const prices: Record<string, number> = {};
  for (const t of tickers) {
    if (batch1[t]?.price > 0) prices[t] = batch1[t].price;
  }
  const missing = tickers.filter(t => !prices[t]);
  if (missing.length > 0) {
    const batch2 = await fetchBatch(supabase, missing, 'yahoo-finance');
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
  dataSource: DataSource,
): TacticalAsset | null {
  if (!raw.closes || raw.closes.length < 21 || raw.price <= 0) return null;

  const { highs, lows } =
    (raw.highs && raw.lows && raw.highs.length === raw.closes.length)
      ? { highs: raw.highs, lows: raw.lows }
      : approximateHighsLows(raw.closes, asset.type);

  let indicators, signals, totalScore;
  try {
    indicators = calcIndicators(raw.closes, raw.volumes ?? [], highs, lows);
    signals    = generateSignals(indicators);
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
    price:         normalizedPrice,
    priceEur,
    closes:        raw.closes,
    volumes:       raw.volumes,
    high52w,
    low52w,
    indicators,
    signals,
    totalScore,
    lastUpdated:   new Date().toISOString(),
    dataSource,
    earningsYield: hasYahooFundamentals ? raw.earningsYield : manual.earningsYield,
    per:           hasYahooFundamentals ? raw.per           : manual.per,
    eps:           hasYahooFundamentals ? raw.eps           : manual.eps,
  };
}

// ── Construir oportunidad desde asset (sin ultra‑fallback) ───
function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators || !asset.closes || asset.closes.length < 5) return null;

  // No se permite ultra‑fallback. Si el asset viene con esa etiqueta, lo descartamos.
  if (asset.dataSource === 'ultra-fallback') {
    console.debug(`[Screener] ${asset.ticker}: descartado (ultra‑fallback no permitido)`);
    return null;
  }

  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  const topSignal  = activeSignals[0];
  const signalType = topSignal.type;

  const fxRates = getCachedFxRates();
  const priceEur = asset.priceEur;
  if (priceEur <= 0) return null;

  const rawAtr   = asset.indicators.atr14;
  const atrEur   = toEur(rawAtr, asset.currency, fxRates);

  let stopLossEur: number, tp1Eur: number, tp2Eur: number;
  try {
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
  if (riskReward < 1.2) return null;

  const reasoning = activeSignals.map(s => s.description).join(' + ');

  return {
    id:           `opp_${asset.ticker}_${Date.now()}`,
    asset,
    type:         signalType,
    score:        asset.totalScore,
    entryPrice:   priceEur,
    stopLoss:     stopLossEur,
    takeProfit1:  tp1Eur,
    takeProfit2:  tp2Eur,
    riskReward,
    reasoning,
    detectedAt:   new Date().toISOString(),
    expiresAt:    new Date(Date.now() + 24 * 3600000).toISOString(),
    activeSignals,
  };
}

// ── Screener principal ────────────────────────────────────────
export async function scanTacticalUniverse(
  mode:     ScanMode,
  config:   TacticalConfig,
  supabase: any,
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

  const fxRates = await fetchFxRates(supabase);
  if (fxRates.isStale) {
    warnings.push(`FX rates stale o no disponibles — usando fallback EUR/USD=${fxRates.EURUSD}, EUR/GBP=${fxRates.EURGBP}`);
  }

  // Recopilar símbolos (primarios y fallbacks)
  const primarySymbols  = universe.map(a => a.yahooSymbol);
  const fallbackSymbols = universe
    .filter(a => a.fallbackYahooSymbol)
    .map(a => a.fallbackYahooSymbol!);

  const allSymbols = [...new Set([...primarySymbols, ...fallbackSymbols, '^VIX'])];

  // Fetch batch
  let batchData = await fetchBatch(supabase, allSymbols, 'yahoo-finance-tactical');
  const missingSymbols = allSymbols.filter(
    s => !(batchData[s]?.closes?.length >= 21),
  );
  if (missingSymbols.length > 0) {
    const basic = await fetchBatch(supabase, missingSymbols, 'yahoo-finance');
    Object.assign(batchData, basic);
  }

  const vixPrice = batchData['^VIX']?.price ?? 20;
  console.debug(`[Screener] VIX real: ${vixPrice.toFixed(2)}`);

  // Construir assets usando SOLO datos reales (primary o fallback)
  for (const asset of universe) {
    let raw: RawTickerData | undefined;
    let dataSource: DataSource = 'primary';

    // Intentar primario
    raw = batchData[asset.yahooSymbol];
    if (raw?.closes?.length >= 21 && raw?.price > 0) {
      dataSource = 'primary';
    } else if (asset.fallbackYahooSymbol) {
      // Intentar fallback explícito
      const fallbackRaw = batchData[asset.fallbackYahooSymbol];
      if (fallbackRaw?.closes?.length >= 21 && fallbackRaw?.price > 0) {
        raw        = fallbackRaw;
        dataSource = 'fallback';
        console.debug(`[Screener] ${asset.ticker}: usando fallback ${asset.fallbackYahooSymbol}`);
      }
    }

    // Si no hay datos reales, error y no se incluye el asset
    if (!raw || raw.closes.length < 21 || raw.price <= 0) {
      errors.push(`${asset.ticker}: sin datos reales (ni primario ni fallback). Revisa el símbolo Yahoo en tacticalUniverse.ts`);
      continue;
    }

    const built = buildAsset(asset, raw, dataSource);
    if (built) {
      assets.push(built);
    } else {
      errors.push(`${asset.ticker}: error en cálculo de indicadores`);
    }
  }

  console.debug(
    `[Screener] ${assets.length}/${universe.length} activos con datos reales · ${errors.length} errores`,
  );

  // Régimen de mercado
  const indexAsset = assets.find(a =>
    ['IS3Q.DE', 'XNAS.DE', 'CSPX.AS', 'SPY', 'QQQ', 'IVV'].includes(a.ticker),
  );
  const indexCloses = indexAsset?.closes ?? [];
  const marketRegime = detectMarketRegime(indexCloses, vixPrice);

  // Generar oportunidades solo con assets reales
  for (const asset of assets) {
    const opp = buildOpportunity(asset);
    if (!opp) continue;

    if (!isSignalAllowed(opp.type, marketRegime)) continue;
    const adjustedScore = adjustScoreByRegime(opp.score, opp.type, marketRegime);
    if (adjustedScore < config.minScore) continue;
    if (opp.riskReward < config.minRiskReward) continue;

    opportunities.push({ ...opp, score: adjustedScore });
  }

  const topPicks = [...opportunities]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    assets,
    opportunities,
    topPicks,
    screenedAt:  new Date().toISOString(),
    errors,
    warnings,
    marketRegime,
  };
}

export async function runTacticalScreener(
  mode:     ScanMode,
  config:   TacticalConfig,
  supabase: any,
): Promise<ScreenerResult> {
  return scanTacticalUniverse(mode, config, supabase);
}

export { calcPositionSize } from './tacticalPortfolio';

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
    minRiskReward:          1.3,
    maxAtrPct:              0.15,
    maxDaysPerTrade:        75,
    trailingStop:           true,
    maxPctFromDefensiveLiq: 0.20,
  };
}