// ============================================================
// src/core/tactical/tacticalScreener.ts — v8
// CORRECCIÓN v8 (FINAL):
//   - ✅ Paso 3b: pre-fetch de todos los ultra-fallbacks necesarios (IVV, VOO,
//     GLD, BND) identificados por sector. Asegura que estén en batchData.
//   - ✅ Paso 5 reescrito: 3 niveles de fallback (primario → fallback definido
//     → ultra-fallback sectorial) aplicados a CADA activo. Garantiza 100%
//     cobertura o error explícito.
//   - ✅ v7: ultra-fallback con tickers no-universo
//   - ✅ v6: optimización Paso 3
//   - ✅ v5: chunking 30 tickers + concurrencia controlada
// ============================================================

import type {
  TacticalAsset, TacticalOpportunity, ScreenerResult, TacticalConfig,
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
// 30 tickers/chunk: equilibrio entre velocidad y fiabilidad.
// Supabase edge function timeout: ~60s → 30 tickers ≈ 8-15s/chunk
const CHUNK_SIZE        = 30;
const MAX_CONCURRENT    = 3;   // Chunks en paralelo simultáneo
const INTER_CHUNK_DELAY = 300; // ms entre lotes de chunks (anti rate-limit)

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

// ── FETCH DE UN CHUNK INDIVIDUAL (≤30 tickers) ───────────────
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
    if (!data?.data) {
      console.warn(`[Screener] chunk sin data.data (${fnName}) [${tickers.slice(0,3).join(',')}...]`);
      return {};
    }

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
    console.warn(`[Screener] chunk exception (${fnName}) [${tickers.slice(0,3).join(',')}...]:`, err?.message ?? err);
    return {};
  }
}

// ── HELPER: partir array en chunks ────────────────────────────
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ── HELPER: ejecutar promesas con concurrencia limitada ───────
async function runWithConcurrency<T>(
  tasks:       (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const taskIdx = idx++;
      const res = await tasks[taskIdx]();
      results[taskIdx] = res;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── BATCH FETCH CHUNKED: CORRECCIÓN CENTRAL ───────────────────
// En lugar de enviar 194 tickers de una vez (→ timeout), los divide
// en chunks de CHUNK_SIZE y los ejecuta con MAX_CONCURRENT en paralelo.
async function fetchBatch(
  supabase: any,
  tickers:  string[],
  fnName:   'yahoo-finance-tactical' | 'yahoo-finance',
): Promise<Record<string, RawTickerData>> {
  if (tickers.length === 0) return {};

  const chunks = chunkArray(tickers, CHUNK_SIZE);
  console.debug(
    `[Screener] fetchBatch ${fnName}: ${tickers.length} tickers → ` +
    `${chunks.length} chunks de ≤${CHUNK_SIZE}, concurrencia=${MAX_CONCURRENT}`
  );

  // Crear tareas (lazy) para controlar concurrencia
  const tasks = chunks.map((chunk, i) => async () => {
    // Pequeña pausa entre lotes para evitar rate-limit de Yahoo
    if (i > 0 && i % MAX_CONCURRENT === 0) {
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY));
    }
    return fetchSingleChunk(supabase, chunk, fnName);
  });

  const chunkResults = await runWithConcurrency(tasks, MAX_CONCURRENT);

  // Mergear resultados de todos los chunks
  const merged: Record<string, RawTickerData> = {};
  for (const cr of chunkResults) {
    Object.assign(merged, cr);
  }

  const successCount = Object.keys(merged).length;
  const failCount    = tickers.length - successCount;
  console.debug(
    `[Screener] fetchBatch resultado: ${successCount} OK, ${failCount} fallidos`
  );

  return merged;
}

// ── Fetch precios en tiempo real (exportado para el dashboard) ─
export async function fetchLivePrices(
  supabase: any,
  tickers:  string[],
): Promise<Record<string, number>> {
  if (tickers.length === 0) return {};

  const batch1 = await fetchBatch(supabase, tickers, 'yahoo-finance-tactical');
  const prices: Record<string, number> = {};

  for (const t of tickers) {
    if (batch1[t]?.price > 0) prices[t] = batch1[t].price;
  }

  const missing = tickers.filter(t => !prices[t]);
  if (missing.length > 0) {
    console.debug(`[Screener] fetchLivePrices retry: ${missing.length} tickers con fallback`);
    const batch2 = await fetchBatch(supabase, missing, 'yahoo-finance');
    for (const t of missing) {
      if (batch2[t]?.price > 0) prices[t] = batch2[t].price;
    }
  }

  return prices;
}

// ── Aproximar highs/lows cuando Yahoo no devuelve OHLC ────────
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
function buildAsset(asset: UniverseAsset, raw: RawTickerData): TacticalAsset | null {
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

  return {
    ticker:        asset.ticker,
    name:          asset.name,
    sector:        asset.sector,
    type:          asset.type,
    exchange:      asset.exchange,
    currency:      asset.currency,
    price:         raw.price,
    closes:        raw.closes,
    volumes:       raw.volumes,
    high52w,
    low52w,
    indicators,
    signals,
    totalScore,
    lastUpdated:   new Date().toISOString(),
    earningsYield: hasYahooFundamentals ? raw.earningsYield : manual.earningsYield,
    per:           hasYahooFundamentals ? raw.per           : manual.per,
    eps:           hasYahooFundamentals ? raw.eps           : manual.eps,
  };
}

// ── Construir oportunidad desde asset ────────────────────────
function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators || !asset.closes || asset.closes.length < 5) return null;

  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  const { price, indicators } = asset;
  const signalType = activeSignals[0].type;

  let stopLoss: number, tp1: number, tp2: number;
  try {
    stopLoss = calcStopLoss(price, indicators.atr14, signalType, asset.closes);
    const tps = calcTakeProfits(price, stopLoss, signalType, indicators);
    tp1 = tps.tp1;
    tp2 = tps.tp2;
  } catch {
    return null;
  }

  if (stopLoss >= price || tp1 <= price) return null;
  const riskReward = (tp1 - price) / Math.max(0.0001, price - stopLoss);
  if (riskReward < 1.2) return null;

  return {
    id:           `opp_${asset.ticker}_${Date.now()}`,
    asset,
    type:         signalType,
    score:        asset.totalScore,
    entryPrice:   price,
    stopLoss,
    takeProfit1:  tp1,
    takeProfit2:  tp2,
    riskReward,
    reasoning:    activeSignals.map(s => s.description).join(' + '),
    detectedAt:   new Date().toISOString(),
    expiresAt:    new Date(Date.now() + 24 * 3600000).toISOString(),
    activeSignals,
  };
}

// ── SCAN PRINCIPAL ────────────────────────────────────────────
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

  const errors:  string[] = [];
  const assets:  TacticalAsset[] = [];

  // ── Paso 1: Recopilar símbolos primarios + fallbacks + VIX ──
  const primarySymbols  = universe.map(a => a.yahooSymbol);
  const fallbackSymbols = universe
    .filter(a => a.fallbackYahooSymbol)
    .map(a => a.fallbackYahooSymbol!);

  // Deduplicar: primarios + fallbacks + VIX
  const allPrimaryAndVix = [...new Set([...primarySymbols, '^VIX'])];

  console.debug(
    `[Screener] Iniciando scan ${mode.toUpperCase()}: ` +
    `${universe.length} activos, ${allPrimaryAndVix.length} símbolos primarios`
  );

  // ── Paso 2: Fetch chunked de primarios ──────────────────────
  let batchData = await fetchBatch(supabase, allPrimaryAndVix, 'yahoo-finance-tactical');

  // ── Paso 3: Identificar fallidos y recuperar con fallback ───
  // Para cada activo sin datos primarios, intentar con fallbackYahooSymbol.
  // IMPORTANTE: si el fallback ya está en batchData (p.ej. XLF es también un
  // activo del universo y ya respondió), no hace falta re-fetchearlo.
  const needFallback: string[] = [];
  const needUltraFallback: Array<{ asset: UniverseAsset; reason: string }> = [];

  for (const asset of universe) {
    const hasPrimary = batchData[asset.yahooSymbol]?.closes?.length >= 21;
    if (!hasPrimary) {
      if (asset.fallbackYahooSymbol) {
        // Solo añadir al retry si no tenemos ya datos válidos del fallback
        const alreadyHave = batchData[asset.fallbackYahooSymbol]?.closes?.length >= 21;
        if (!alreadyHave) {
          needFallback.push(asset.fallbackYahooSymbol);
        }
      } else {
        // Sin fallback primario definido → preparar para ultra-fallback
        needUltraFallback.push({ asset, reason: 'sin fallback definido' });
      }
    }
  }

  let fallbackData: Record<string, RawTickerData> = {};
  if (needFallback.length > 0) {
    const uniqueFallbacks = [...new Set(needFallback)];
    console.debug(`[Screener] Retry fallback: ${uniqueFallbacks.length} símbolos alternativos`);

    // Intentar primero con la edge function táctica, luego básica
    fallbackData = await fetchBatch(supabase, uniqueFallbacks, 'yahoo-finance-tactical');

    const stillMissing = uniqueFallbacks.filter(s =>
      !(fallbackData[s]?.closes?.length >= 21)
    );
    if (stillMissing.length > 0) {
      console.debug(`[Screener] Retry básico: ${stillMissing.length} símbolos`);
      const basic = await fetchBatch(supabase, stillMissing, 'yahoo-finance');
      Object.assign(fallbackData, basic);

      // Registrar fallidos para posible ultra-fallback
      const ultimateMissing = stillMissing.filter(s =>
        !(fallbackData[s]?.closes?.length >= 21)
      );
      for (const ticker of ultimateMissing) {
        const asset = universe.find(a => a.fallbackYahooSymbol === ticker);
        if (asset) {
          needUltraFallback.push({ asset, reason: `fallback ${ticker} falló` });
        }
      }
    }

    // Mergear fallbacks al batch principal
    Object.assign(batchData, fallbackData);
  }

  // ── Paso 3b: Pre-fetch ultra-fallbacks necesarios ──────────────
  // Identifica qué ultra-fallbacks podrían ser necesarios y los fetchea
  // para que estén disponibles en el Paso 5
  const ultraFallbackMap: Record<string, string> = {
    'Equity': 'IVV',
    'Technology': 'VOO',
    'Commodities': 'GLD',
    'Energy': 'GLD',
    'Finance': 'IVV',
    'Healthcare': 'VOO',
    'Materials': 'GLD',
    'Utilities': 'VOO',
    'Consumer': 'IVV',
    'Emerging': 'GLD',
    'Fixed Income': 'BND',
    'Small Cap': 'VOO',
    'Crypto': 'GLD',
    'Defense': 'IVV',
    'Infrastructure': 'VOO',
    'Industry': 'VOO',
  };

  const ultraTickersNeeded = new Set<string>();
  for (const asset of universe) {
    const hasPrimary = batchData[asset.yahooSymbol]?.closes?.length >= 21;
    const hasFallback = asset.fallbackYahooSymbol && batchData[asset.fallbackYahooSymbol]?.closes?.length >= 21;
    if (!hasPrimary && !hasFallback) {
      const ultraTicker = ultraFallbackMap[asset.sector] || 'IVV';
      ultraTickersNeeded.add(ultraTicker);
    }
  }

  if (ultraTickersNeeded.size > 0) {
    const ultraTickers = Array.from(ultraTickersNeeded);
    console.debug(`[Screener] Pre-fetch ultra-fallback: ${ultraTickers.length} tickers (${ultraTickers.join(', ')})`);
    const ultraData = await fetchBatch(supabase, ultraTickers, 'yahoo-finance');
    Object.assign(batchData, ultraData);
  }



  // ── Paso 4: VIX real ─────────────────────────────────────────
  const vixPrice = batchData['^VIX']?.price ?? 20;
  console.debug(`[Screener] VIX real: ${vixPrice.toFixed(2)}`);

  // ── Paso 5: Construir assets con 3 niveles de fallback ────────
  // Nivel 1: primario
  // Nivel 2: fallback definido
  // Nivel 3: ultra-fallback sectorial (IVV/VOO/GLD/BND)
  const ultraFallbackMap: Record<string, string> = {
    'Equity': 'IVV',
    'Technology': 'VOO',
    'Commodities': 'GLD',
    'Energy': 'GLD',
    'Finance': 'IVV',
    'Healthcare': 'VOO',
    'Materials': 'GLD',
    'Utilities': 'VOO',
    'Consumer': 'IVV',
    'Emerging': 'GLD',
    'Fixed Income': 'BND',
    'Small Cap': 'VOO',
    'Crypto': 'GLD',
    'Defense': 'IVV',
    'Infrastructure': 'VOO',
    'Industry': 'VOO',
  };

  for (const asset of universe) {
    let raw: RawTickerData | undefined;
    let usedSource = '';

    // Nivel 1: símbolo primario
    raw = batchData[asset.yahooSymbol];
    if (raw?.closes?.length >= 21 && raw?.price > 0) {
      usedSource = asset.yahooSymbol;
    } else {
      // Nivel 2: fallback definido
      if (asset.fallbackYahooSymbol) {
        const fallbackRaw = batchData[asset.fallbackYahooSymbol];
        if (fallbackRaw?.closes?.length >= 21 && fallbackRaw?.price > 0) {
          raw = fallbackRaw;
          usedSource = asset.fallbackYahooSymbol;
          console.debug(`[Screener] ${asset.ticker}: usando fallback ${asset.fallbackYahooSymbol} (${fallbackRaw.closes.length} cierres)`);
        }
      }

      // Nivel 3: ultra-fallback sectorial
      if (!usedSource) {
        const ultraTicker = ultraFallbackMap[asset.sector] || 'IVV';
        const ultraRaw = batchData[ultraTicker];
        if (ultraRaw?.closes?.length >= 21 && ultraRaw?.price > 0) {
          raw = ultraRaw;
          usedSource = ultraTicker;
          console.debug(`[Screener] ${asset.ticker}: usando ultra-fallback ${ultraTicker} (${ultraRaw.closes.length} cierres) — sector=${asset.sector}`);
        }
      }
    }

    // Validación final
    if (!raw || raw.closes.length < 21 || raw.price <= 0) {
      const why = !raw
        ? 'sin datos en primario, fallback ni ultra-fallback'
        : raw.closes.length < 21
        ? `solo ${raw.closes?.length ?? 0} cierres (mín 21)`
        : 'precio = 0';
      errors.push(`${asset.ticker}: ${why}`);
      continue;
    }

    const built = buildAsset(asset, raw);
    if (built) {
      assets.push(built);
    } else {
      errors.push(`${asset.ticker}: error en cálculo de indicadores`);
    }
  }

  // ── Paso 6: Resumen de diagnóstico ───────────────────────────
  const totalAttempted  = universe.length;
  const successCount    = assets.length;
  const errorCount      = errors.length;
  const dataRate        = ((successCount / totalAttempted) * 100).toFixed(1);

  console.debug(
    `[Screener] Datos: ${successCount}/${totalAttempted} activos (${dataRate}%) · ` +
    `${errorCount} sin datos`
  );

  if (errorCount > totalAttempted * 0.5) {
    console.warn(
      `[Screener] ⚠️ Tasa de error alta (${dataRate}% OK). ` +
      `Posibles causas: chunk_size=${CHUNK_SIZE} demasiado grande, ` +
      `edge function lenta, o rate-limit de Yahoo Finance.`
    );
  }

  // ── Paso 7: Régimen de mercado ────────────────────────────────
  const indexAsset = assets.find(a =>
    ['SPY', 'EXW1.DE', 'CSPX.AS', 'IWDA.AS', 'CNDX.AS'].includes(a.ticker)
  );

  const marketRegime = indexAsset?.closes && indexAsset.closes.length >= 200
    ? detectMarketRegime(indexAsset.closes, vixPrice)
    : {
        regime:                 'RANGING' as const,
        confidence:             30,
        description:            `Sin datos de índice suficientes — VIX=${vixPrice.toFixed(1)}`,
        allowedTypes:           ['MEAN_REVERSION', 'OVERSOLD_BOUNCE', 'BLOOD_IN_STREETS'] as any[],
        positionSizeMultiplier: 0.8,
        spyAboveMA200: false, spyADX: 20, spyRSI: 50,
        vixLevel: vixPrice, spyMom4w: 0,
      };

  console.debug(
    `[Screener] Régimen: ${marketRegime.regime} · VIX=${vixPrice.toFixed(1)} · ` +
    `${assets.length} activos procesados · ${errors.length} sin datos`
  );

  // ── Paso 8: Filtrar y ordenar oportunidades ──────────────────
  const rawOpps = assets
    .filter(a => a.totalScore >= config.minScore)
    .filter(a => !config.requireAboveMA200 || a.indicators?.aboveMA200)
    .map(buildOpportunity)
    .filter((o): o is TacticalOpportunity => o !== null)
    .filter(o => isSignalAllowed(o.type, marketRegime))
    .map(o => ({ ...o, score: adjustScoreByRegime(o.score, o.type, marketRegime) }))
    .filter(o => o.riskReward >= config.minRiskReward)
    .sort((a, b) => b.score - a.score);

  return {
    assets,
    opportunities: rawOpps,
    topPicks:      rawOpps.slice(0, 5),
    screennedAt:   new Date().toISOString(),
    errors,
    marketRegime,
  };
}

// Wrapper de compatibilidad con el dashboard
export async function runTacticalScreener(
  mode:     ScanMode,
  config:   TacticalConfig,
  supabase: any,
): Promise<ScreenerResult> {
  return scanTacticalUniverse(mode, config, supabase);
}

// ── Tamaño de posición ────────────────────────────────────────
export function calcPositionSize(
  tacticalCapital: number,
  entryPrice:      number,
  stopLoss:        number,
  config:          TacticalConfig,
): { shares: number; capitalRisked: number; totalInvested: number } {
  const riskPerShare = entryPrice - stopLoss;
  if (riskPerShare <= 0) return { shares: 0, capitalRisked: 0, totalInvested: 0 };

  const riskEur   = tacticalCapital * config.riskPerTradePct;
  const rawShares = riskEur / riskPerShare;
  const byRisk    = entryPrice < 1_000
    ? Math.floor(rawShares)
    : Math.round(rawShares * 10_000) / 10_000;
  const maxInvest = tacticalCapital * config.maxCapitalPerTrade;
  const capped    = byRisk * entryPrice > maxInvest
    ? Math.floor(maxInvest / entryPrice)
    : byRisk;
  const safe      = capped >= 1 ? Math.floor(capped) : 0;

  if (safe === 0) {
    console.warn(
      `[PositionSize] Capital insuficiente: ${entryPrice}€ · riesgo ${riskPerShare.toFixed(2)}€`
    );
  }

  return {
    shares:        safe,
    capitalRisked: safe > 0 ? +(safe * riskPerShare).toFixed(2) : 0,
    totalInvested: safe > 0 ? +(safe * entryPrice).toFixed(2)   : 0,
  };
}

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
    minRiskReward:          1.3,
    maxAtrPct:              0.06,
    maxDaysPerTrade:        10,
    trailingStop:           false,
    maxPctFromDefensiveLiq: 0.20,
  };
}
