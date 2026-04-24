// ============================================================
// src/core/tactical/tacticalScreener.ts
// Motor principal del screener táctico
// ============================================================
//
// NOTA CRÍTICA — ATR = 0%:
//   calcIndicators en tacticalSignals.ts DEBE tener esta firma:
//
//     export function calcIndicators(
//       closes:  number[],
//       volumes: number[],
//       highs:   number[],   // ← OBLIGATORIO para ATR real
//       lows:    number[],   // ← OBLIGATORIO para ATR real
//     ): TechnicalIndicators
//
//   Si solo acepta (closes, volumes) el ATR siempre será 0.
//   Este screener ya calcula highs/lows aproximados cuando Yahoo no
//   los devuelve; solo falta que calcIndicators los acepte.
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
  toIbkrContract,
  type UniverseAsset,
} from './tacticalUniverse';
import { getFundamentals } from './fundamentalsConfig';

export { CORE_TACTICAL_UNIVERSE, FULL_TACTICAL_UNIVERSE, VOLATILE_UNIVERSE };

export type ScanMode = 'volatile' | 'core' | 'full';

export const SCAN_MODE_LABELS: Record<ScanMode, string> = {
  volatile: 'RÁPIDO',
  core:     'CORE',
  full:     'FULL',
};

export const SCAN_MODE_DESCRIPTIONS: Record<ScanMode, string> = {
  volatile: '⚡ Alta beta — crypto, ARK, litio, gas, mineras, TSLA, NVDA…',
  core:     '🎯 Líquidos — S&P500, NASDAQ, sectoriales, oro, bonos + top acciones',
  full:     '🔭 Universo completo — ~159 ETFs/stocks · IBEX35 · DAX40 · CAC40 · FTSE100 · US',
};

/** Cuenta real en runtime — sin riesgo de desincronía con comentarios */
export function getScanModeCount(mode: ScanMode): number {
  const map: Record<ScanMode, UniverseAsset[]> = {
    volatile: VOLATILE_UNIVERSE,
    core:     CORE_TACTICAL_UNIVERSE,
    full:     FULL_TACTICAL_UNIVERSE,
  };
  return map[mode].length;
}

export const SCAN_MODE_TIMES: Record<ScanMode, string> = {
  volatile: '~2-3 min',
  core:     '~4-6 min',
  full:     '~15-20 min',
};

// ── Fetch datos Yahoo Finance via Edge Function ───────────────
async function fetchTickerData(
  ticker:  string,
  supabase: any,
): Promise<{
  closes:         number[];
  volumes:        number[];
  highs?:         number[];
  lows?:          number[];
  price:          number;
  per?:           number;
  earningsYield?: number;
  eps?:           number;
} | null> {
  try {
    const { data, error } = await supabase.functions.invoke('yahoo-finance-tactical', {
      body: { tickers: [ticker] },
    });
    if (error || !data?.data?.[ticker]) return null;
    const d = data.data[ticker];
    return {
      closes:        d.closes        ?? [],
      volumes:       d.volumes       ?? [],
      highs:         d.highs,
      lows:          d.lows,
      price:         d.currentPrice  ?? 0,
      per:           d.per,
      earningsYield: d.earningsYield,
      eps:           d.eps,
    };
  } catch {
    return null;
  }
}

/**
 * Fallback: intenta la función genérica yahoo-finance pasando el ticker.
 * BUG FIX: antes invocaba sin body → devolvía todos los tickers del portfolio,
 * nunca el ticker táctico buscado. Ahora pasa { tickers: [ticker] }.
 */
async function fetchFromExistingYahoo(
  supabase: any,
  ticker:   string,
): Promise<{ closes: number[]; volumes: number[]; price: number } | null> {
  try {
    const { data } = await supabase.functions.invoke('yahoo-finance', {
      body: { tickers: [ticker] },
    });
    if (!data?.data?.[ticker]) return null;
    const d = data.data[ticker];
    return {
      closes:  d.closes  ?? [],
      volumes: Array(d.closes?.length ?? 0).fill(1_000_000),
      price:   d.currentPrice ?? 0,
    };
  } catch {
    return null;
  }
}

// ── FIX ATR=0: aproximar highs/lows desde closes ─────────────
// Cuando Yahoo no devuelve OHLC completo usamos una aproximación
// basada en la volatilidad de cierre reciente (ventana 5 días).
function approximateHighsLows(closes: number[]): { highs: number[]; lows: number[] } {
  const WINDOW = 5;
  const highs: number[] = [];
  const lows:  number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const slice   = closes.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const diffs   = slice.map((c, j) => j === 0 ? 0 : Math.abs(c - slice[j - 1]));
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / Math.max(diffs.length, 1);
    const half    = avgDiff * 1.5;
    highs.push(closes[i] + half);
    lows.push( closes[i] - half);
  }
  return { highs, lows };
}

// ── Procesar activo ──────────────────────────────────────────
async function processAsset(
  asset:    UniverseAsset,
  supabase: any,
): Promise<TacticalAsset | null> {

  // 1️⃣ Símbolo UCITS / nativo
  let raw = await fetchTickerData(asset.yahooSymbol, supabase);

  // 2️⃣ Fallback: ETF americano equivalente
  if ((!raw || raw.closes.length < 21 || raw.price === 0) && asset.fallbackYahooSymbol) {
    console.warn(`[Screener] ${asset.ticker}: fallback → ${asset.fallbackYahooSymbol}`);
    raw = await fetchTickerData(asset.fallbackYahooSymbol, supabase);
  }

  // 3️⃣ Función genérica (con ticker correcto ahora)
  if (!raw || raw.closes.length < 21 || raw.price === 0) {
    const fb =
      await fetchFromExistingYahoo(supabase, asset.yahooSymbol)
      ?? (asset.fallbackYahooSymbol
          ? await fetchFromExistingYahoo(supabase, asset.fallbackYahooSymbol)
          : null);
    if (fb) raw = { ...fb };
  }

  if (!raw || raw.closes.length < 21 || raw.price === 0) {
    console.warn(`[Screener] Sin datos suficientes: ${asset.yahooSymbol}`);
    return null;
  }

  // Garantizar highs/lows para ATR real
  // Si Yahoo devuelve OHLC los usamos; si no, aproximamos desde closes.
  const { highs, lows } =
    (raw.highs && raw.lows && raw.highs.length === raw.closes.length)
      ? { highs: raw.highs, lows: raw.lows }
      : approximateHighsLows(raw.closes);

  // calcIndicators DEBE aceptar (closes, volumes, highs, lows) — ver nota arriba
  const indicators = calcIndicators(raw.closes, raw.volumes, highs, lows);
  const signals    = generateSignals(indicators);
  const totalScore = calcTotalScore(signals);
  const high52w    = Math.max(...raw.closes.slice(-252));
  const low52w     = Math.min(...raw.closes.slice(-252));

  const manual               = getFundamentals(asset.yahooSymbol);
  const hasYahooFundamentals = raw.per !== undefined && raw.per > 0;

  const ibkrContract = toIbkrContract(asset);

  console.log(
    `[Screener] ${asset.ticker}: score=${totalScore.toFixed(2)}, ` +
    `price=${raw.price.toFixed(2)}, ATR%=${(indicators.atr14/raw.price*100).toFixed(2)}%, ` +
    `RSI14=${indicators.rsi14.toFixed(1)}, MA200=${indicators.aboveMA200}, ` +
    `IBKR=${ibkrContract.symbol}@${ibkrContract.exchange}`,
  );

  // BUG FIX: incluir ibkrContract e ibkrSymbol en el TacticalAsset
  // (tipos corregidos en types.ts para aceptar ambos campos)
  return {
    ticker:        asset.ticker,
    name:          asset.name,
    sector:        asset.sector,
    type:          asset.type,   // 'ETF' | 'ETC' | 'CRYPTO' | 'STOCK' — corregido en types.ts
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
    ibkrContract,                        // ← contrato IBKR completo
    ibkrSymbol:    asset.ibkrSymbol,     // ← acceso directo al símbolo IBKR
  } satisfies TacticalAsset;
}

// ── Construir oportunidad ─────────────────────────────────────
function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators) return null;
  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  const bestSignal         = [...activeSignals].sort((a, b) => b.score - a.score)[0];
  const ind                = asset.indicators;
  const entry              = asset.price;
  const stopLoss           = calcStopLoss(entry, ind.atr14, bestSignal.type, asset.closes);
  const { tp1, tp2, rr }  = calcTakeProfits(entry, stopLoss, bestSignal.type, ind);

  if (rr < 1.3) return null;

  const c           = asset.currency === 'USD' ? '$' : asset.currency === 'GBP' ? '£' : '€';
  const expiryDays  = bestSignal.type === 'BLOOD_IN_STREETS' ? 3 : 7;

  const reasoning = [
    `${activeSignals.length} señal(es) activa(s):`,
    ...activeSignals.map(s => `• ${s.type}: ${s.description}`),
    `R:R ${rr.toFixed(2)} | Stop ${c}${stopLoss.toFixed(2)} | TP1 ${c}${tp1.toFixed(2)} | TP2 ${c}${tp2.toFixed(2)}`,
  ].join('\n');

  return {
    id:           `${asset.ticker}-${Date.now()}`,
    asset,
    type:         bestSignal.type,
    score:        asset.totalScore,
    entryPrice:   entry,
    stopLoss,
    takeProfit1:  tp1,
    takeProfit2:  tp2,
    riskReward:   rr,
    reasoning,
    detectedAt:   new Date().toISOString(),
    expiresAt:    new Date(Date.now() + expiryDays * 86_400_000).toISOString(),
    activeSignals,
  };
}

// ════════════════════════════════════════════════════════════
// SCREENER PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function runTacticalScreener(
  supabase:  any,
  config:    TacticalConfig,
  scanMode:  ScanMode = 'core',
): Promise<ScreenerResult> {
  const universeMap: Record<ScanMode, UniverseAsset[]> = {
    volatile: VOLATILE_UNIVERSE,
    core:     CORE_TACTICAL_UNIVERSE,
    full:     FULL_TACTICAL_UNIVERSE,
  };

  const universe = universeMap[scanMode];
  const errors:  string[]        = [];
  const assets:  TacticalAsset[] = [];

  console.log(`[Screener] Iniciando modo=${scanMode}, universo=${universe.length} activos, minScore=${config.minScore}`);

  const BATCH = 5;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch   = universe.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(a => processAsset(a, supabase)));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) assets.push(r.value);
      else if (r.status === 'rejected')         errors.push(`${batch[idx].ticker}: ${r.reason}`);
    });
  }

  const rawOpps = assets
    .filter(a => a.totalScore >= config.minScore)
    .filter(a => !config.requireAboveMA200 || a.indicators?.aboveMA200)
    .map(buildOpportunity)
    .filter((o): o is TacticalOpportunity => o !== null)
    .filter(o => o.riskReward >= config.minRiskReward)
    .sort((a, b) => b.score - a.score);

  console.log(`[Screener] ${assets.length} analizados → ${rawOpps.length} oportunidades · ${errors.length} errores`);

  return {
    assets,
    opportunities: rawOpps,
    topPicks:      rawOpps.slice(0, 5),
    screennedAt:   new Date().toISOString(),
    errors,
  };
}

// ── Tamaño de posición ────────────────────────────────────────
/**
 * Calcula el número de acciones a comprar limitando:
 * 1. Riesgo monetario = tacticalCapital * riskPerTradePct (ej. 1%)
 * 2. Capital máximo por trade = tacticalCapital * maxCapitalPerTrade (ej. 30%)
 * El resultado final es el mínimo de ambos límites.
 */
export function calcPositionSize(
  tacticalCapital: number,
  entryPrice:      number,
  stopLoss:        number,
  config:          TacticalConfig,
): { shares: number; capitalRisked: number; totalInvested: number } {
  const riskPerShare = entryPrice - stopLoss;
  if (riskPerShare <= 0) return { shares: 0, capitalRisked: 0, totalInvested: 0 };

  // Límite por riesgo (1% del capital táctico)
  const riskEur   = tacticalCapital * config.riskPerTradePct;
  const rawShares = riskEur / riskPerShare;

  // Para crypto/ETC con precio alto: usar decimales; para ETFs: entero
  const sharesByRisk = entryPrice < 1_000
    ? Math.floor(rawShares)
    : Math.round(rawShares * 10_000) / 10_000;

  // Límite por capital máximo por trade (30% del capital táctico)
  const maxInvest   = tacticalCapital * config.maxCapitalPerTrade;
  const finalShares = sharesByRisk * entryPrice > maxInvest
    ? (entryPrice > 0 ? Math.floor(maxInvest / entryPrice) : 0)
    : sharesByRisk;

  const safe = Math.max(1, finalShares);
  return {
    shares:        safe,
    capitalRisked: +(safe * riskPerShare).toFixed(2),
    totalInvested: +(safe * entryPrice).toFixed(2),
  };
}

// ── Bracket order IBKR con TP1 (50%) + TP2 (50%) + Stop ──────
/**
 * Genera la estructura de una orden bracket para Interactive Brokers:
 * - Orden de entrada (BUY LMT o MKT)
 * - Stop Loss (SELL STP) cubre toda la posición
 * - Take Profit 1 (SELL LMT) cubre el 50% de la posición
 * - Take Profit 2 (SELL LMT, transmit=true) cubre el 50% restante
 *
 * El campo ibkrContract en TacticalAsset ya viene pre-construido por
 * toIbkrContract() con symbol, secType, exchange y currency correctos
 * para la TWS API / IBKR Gateway.
 */
export function buildIbkrOrder(
  opportunity: TacticalOpportunity,
  shares:      number,
  orderType:   'LMT' | 'MKT' = 'LMT',
): {
  contract: object;
  entry:    object;
  bracket: {
    stop: object;
    tp1:  object;
    tp2:  object;
  };
  summary: {
    sharesTotal:  number;
    sharesTP1:    number;
    sharesTP2:    number;
    entryPrice:   number;
    stopPrice:    number;
    tp1Price:     number;
    tp2Price:     number;
    riskReward:   number;
    maxRisk:      number;
    maxGainTP1:   number;
    maxGainTP2:   number;
  };
} {
  const { asset, entryPrice, stopLoss, takeProfit1, takeProfit2, riskReward } = opportunity;

  // ibkrContract viene del processAsset (toIbkrContract); si por alguna razón
  // no estuviera disponible, lo reconstruimos desde los campos base.
  const contract = asset.ibkrContract ?? {
    symbol:   asset.ibkrSymbol ?? asset.ticker,
    secType:  asset.type === 'CRYPTO' ? 'CRYPTO' : 'STK',
    exchange: 'SMART',
    currency: asset.currency,
  };

  // Dividir posición 50/50 entre TP1 y TP2
  const sharesTP1 = Math.max(1, Math.floor(shares / 2));
  const sharesTP2 = Math.max(1, shares - sharesTP1);

  const entry = {
    action:        'BUY',
    orderType,
    totalQuantity: shares,
    lmtPrice:      orderType === 'LMT' ? +entryPrice.toFixed(2) : undefined,
    transmit:      false,
    tif:           'GTC',
  };

  const stopOrder = {
    action:        'SELL',
    orderType:     'STP',
    auxPrice:      +stopLoss.toFixed(2),
    totalQuantity: shares,      // Stop cubre toda la posición
    transmit:      false,
    tif:           'GTC',
  };

  const tp1Order = {
    action:        'SELL',
    orderType:     'LMT',
    lmtPrice:      +takeProfit1.toFixed(2),
    totalQuantity: sharesTP1,   // 50% en TP1
    transmit:      false,
    tif:           'GTC',
  };

  const tp2Order = {
    action:        'SELL',
    orderType:     'LMT',
    lmtPrice:      +takeProfit2.toFixed(2),
    totalQuantity: sharesTP2,   // 50% restante en TP2
    transmit:      true,        // Último → transmite todo el bracket
    tif:           'GTC',
  };

  const riskPerShare  = entryPrice - stopLoss;
  const gainTP1PerSh  = takeProfit1 - entryPrice;
  const gainTP2PerSh  = takeProfit2 - entryPrice;

  return {
    contract,
    entry,
    bracket: { stop: stopOrder, tp1: tp1Order, tp2: tp2Order },
    summary: {
      sharesTotal: shares,
      sharesTP1,
      sharesTP2,
      entryPrice:  +entryPrice.toFixed(2),
      stopPrice:   +stopLoss.toFixed(2),
      tp1Price:    +takeProfit1.toFixed(2),
      tp2Price:    +takeProfit2.toFixed(2),
      riskReward:  +riskReward.toFixed(2),
      maxRisk:     +(riskPerShare * shares).toFixed(2),
      maxGainTP1:  +(gainTP1PerSh * sharesTP1).toFixed(2),
      maxGainTP2:  +(gainTP2PerSh * sharesTP2).toFixed(2),
    },
  };
}

// ── Config por defecto ────────────────────────────────────────
/**
 * Capital táctico disponible:
 *   - Se toma el MENOR de: (a) defensiveLiquidity × 20%, (b) tacticalCapital
 *   - Esto evita comprometer más del 20% de la liquidez defensiva del portfolio Olympus
 *   - Si el resultado fuera ≤ 0 (sin liquidez defensiva), se usa tacticalCapital completo
 *
 * Ejemplo: portfolio de 12.000 €, liquidez defensiva = 2.400 €, capital táctico = 3.000 €
 *   → disponible = min(2.400×0.20, 3.000) = min(480, 3.000) = 480 €
 */
export function defaultTacticalConfig(
  tacticalCapital:    number,  // € totales asignados al motor táctico (viene del portfolio)
  defensiveLiquidity: number,  // € de liquidez defensiva actual del portfolio Olympus
): TacticalConfig {
  const available = Math.min(defensiveLiquidity * 0.20, tacticalCapital);
  return {
    tacticalCapitalEur:     available > 0 ? available : tacticalCapital,
    maxCapitalPerTrade:     0.30,   // 30% máx por operación individual
    riskPerTradePct:        0.01,   // 1% del capital táctico en riesgo por trade
    maxOpenPositions:       4,      // 4 posiciones abiertas simultáneas
    minScore:               35,     // Score mínimo para considerar (0-100)
    requireAboveMA200:      false,  // Permite comprar debajo de MA200 (para mean reversion)
    minRiskReward:          1.3,    // R:R mínimo aceptable
    maxAtrPct:              0.06,   // Máx 6% de ATR diario (evita activos demasiado volátiles)
    maxDaysPerTrade:        10,     // Máx 10 días hábiles en posición
    trailingStop:           false,
    maxPctFromDefensiveLiq: 0.20,   // 20% de la liquidez defensiva usable
  };
}
