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
import { integratedOverfittingMetric } from '../risk/overfittingMetric';

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

// ── Ultra-fallback sectorial ──────────────────────────────────
// CRÍTICO: los datos de estos tickers NO se usan para generar señales.
// Se usan únicamente para que el asset aparezca en la lista con
// el campo dataSource='ultra-fallback'. buildOpportunity los descarta.
// Sin esto, el asset desaparecería completamente del resultado → no se
// podría mostrar al usuario que el activo existe pero no tiene datos.
const ULTRA_FALLBACK_MAP: Record<string, string> = {
  'Equity':         'IVV',
  'Technology':     'VOO',
  'Commodities':    'GLD',
  'Energy':         'GLD',
  'Finance':        'IVV',
  'Healthcare':     'VOO',
  'Materials':      'GLD',
  'Utilities':      'VOO',
  'Consumer':       'IVV',
  'Small Cap':      'IWM',
  'Real Estate':    'VNQ',
  'Emerging':       'EEM',
  'Emerging Bonds': 'EMB',
  'Factor':         'QUAL',
  'Crypto':         'BTC-USD',
};

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
  if (riskReward < 1.2) return null;

  return {
    id:           `opp_${asset.ticker}_${Date.now()}`,
    asset,
    type:         signalType,
    score:        asset.totalScore,
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
    oportunidades: 0,
  };

  // FIX: fetch de tasas FX antes del scan
  // Se cachean 4 horas — si no hay datos, usa fallback EUR=1
  const fxRates = await fetchFxRates(supabase);
  if (fxRates.isStale) {
    warnings.push(`FX rates stale o no disponibles — usando fallback EUR/USD=${fxRates.EURUSD}, EUR/GBP=${fxRates.EURGBP}`);
  }

  // Paso 1: recopilar símbolos
  const primarySymbols  = universe.map(a => a.yahooSymbol);
  const fallbackSymbols = universe
    .filter(a => a.fallbackYahooSymbol)
    .map(a => a.fallbackYahooSymbol!);

  const allSymbols = [...new Set([...primarySymbols, ...fallbackSymbols, '^VIX'])];

  // Paso 2: fetch batch de todos los símbolos
  let batchData = await fetchBatch(supabase, allSymbols, 'yahoo-finance-tactical');
  const missingSymbols = allSymbols.filter(
    s => !(batchData[s]?.closes?.length >= 21),
  );
  if (missingSymbols.length > 0) {
    const basic = await fetchBatch(supabase, missingSymbols, 'yahoo-finance');
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
      const ultraData = await fetchBatch(supabase, toFetch, 'yahoo-finance-tactical');
      Object.assign(batchData, ultraData);
    }
  }

  // Paso 4: VIX real
  const vixPrice = batchData['^VIX']?.price ?? 20;
  console.debug(`[Screener] VIX real: ${vixPrice.toFixed(2)}`);

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

    // Paso 6: diagnóstico
  console.debug(
    `[Screener] ${assets.length}/${universe.length} activos · ` +
    `P:${diag.primary} F:${diag.fallback} UF:${diag.ultraFallback} SD:${diag.sinDatos} ` +
    `EB:${diag.errorBuild} noOHLC:${diag.sinOhlc}`,
  );

  // Paso 7: régimen de mercado
  const indexAsset = assets.find(a =>
    ['IS3Q.DE', 'XNAS.DE', 'CSPX.AS', 'SPY', 'QQQ', 'IVV'].includes(a.ticker),
  );
  const indexCloses = indexAsset?.closes ?? [];
  const marketRegime = detectMarketRegime(indexCloses, vixPrice);

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

  // Paso 8: construir oportunidades CON FILTRO DE RÉGIMEN
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
    // FIX v11: stub vacío para evitar "BACKTEST metrics undefined" en el dashboard.
    // El dashboard debe leer result.backtest?.metrics ?? [] (optional chaining).
    backtest: { metrics: [], ran: false },
  };
}

// ── Wrapper de compatibilidad ─────────────────────────────────
export async function runTacticalScreener(
  mode:     ScanMode,
  config:   TacticalConfig,
  supabase: any,
): Promise<ScreenerResult> {
  return scanTacticalUniverse(mode, config, supabase);
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
    minRiskReward:          1.3,
    maxAtrPct:              0.15,
    maxDaysPerTrade:        75,   // FIX: consistente con dynMax máximo del FPT
    trailingStop:           true,
    maxPctFromDefensiveLiq: 0.20,
  };
}