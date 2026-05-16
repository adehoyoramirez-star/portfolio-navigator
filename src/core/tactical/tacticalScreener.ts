// ============================================================
// src/core/tactical/tacticalScreener.ts
// Motor principal del screener táctico — VERSIÓN SIMPLIFICADA
// CAMBIOS:
//   - ❌ Eliminado buildIbkrOrder() completamente
//   - ✅ Arreglado calcPositionSize() con límite duro
//   - ✅ Simplificado para gestión local de estado
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
  type RegimeState,
} from './marketRegimeFilter';

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
// NOTA: Factor mejorado según tipo de activo
function approximateHighsLows(
  closes: number[],
  assetType: 'ETF' | 'STOCK' | 'CRYPTO' = 'ETF'
): { highs: number[]; lows: number[] } {
  const WINDOW = 5;
  // Factor de volatilidad según asset type
  const factor = assetType === 'CRYPTO' ? 2.5 : assetType === 'STOCK' ? 1.8 : 1.3;
  
  const highs: number[] = [];
  const lows:  number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const slice   = closes.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const diffs   = slice.map((c, j) => j === 0 ? 0 : Math.abs(c - slice[j - 1]));
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / Math.max(diffs.length, 1);
    const half    = avgDiff * factor;
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

  let raw = await fetchTickerData(asset.yahooSymbol, supabase);

  if ((!raw || raw.closes.length < 21 || raw.price === 0) && asset.fallbackYahooSymbol) {
    console.debug(`[Screener] ${asset.ticker}: fallback → ${asset.fallbackYahooSymbol}`);
    raw = await fetchTickerData(asset.fallbackYahooSymbol, supabase);
  }

  if (!raw || raw.closes.length < 21 || raw.price === 0) {
    const fb =
      await fetchFromExistingYahoo(supabase, asset.yahooSymbol)
      ?? (asset.fallbackYahooSymbol
          ? await fetchFromExistingYahoo(supabase, asset.fallbackYahooSymbol)
          : null);
    if (fb) raw = { ...fb };
  }

  if (!raw || raw.closes.length < 21 || raw.price === 0) {
    console.debug(`[Screener] Sin datos suficientes: ${asset.yahooSymbol}`);
    return null;
  }

  // Garantizar highs/lows para ATR real
  const { highs, lows } =
    (raw.highs && raw.lows && raw.highs.length === raw.closes.length)
      ? { highs: raw.highs, lows: raw.lows }
      : approximateHighsLows(raw.closes, asset.type);

  const indicators = calcIndicators(raw.closes, raw.volumes, highs, lows);
  const signals    = generateSignals(indicators);
  const totalScore = calcTotalScore(signals);
  const high52w    = Math.max(...raw.closes.slice(-252));
  const low52w     = Math.min(...raw.closes.slice(-252));

  const manual               = getFundamentals(asset.yahooSymbol);
  const hasYahooFundamentals = raw.per !== undefined && raw.per > 0;

  console.debug(
    `[Screener] ${asset.ticker}: score=${totalScore.toFixed(2)}, ` +
    `price=${raw.price.toFixed(2)}, ATR%=${(indicators.atr14/raw.price*100).toFixed(2)}%, ` +
    `RSI14=${indicators.rsi14.toFixed(1)}, MA200=${indicators.aboveMA200}`
  );

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
    per:           hasYahooFundamentals ? raw.per : manual.per,
    eps:           hasYahooFundamentals ? raw.eps : manual.eps,
  };
}

// ── Construir oportunidad ────────────────────────────────────
function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators) return null;
  const { price, indicators } = asset;
  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  const signalType = activeSignals[0].type;
  const stopLoss   = calcStopLoss(signalType, price, indicators);
  const { tp1, tp2 } = calcTakeProfits(signalType, price, indicators);
  const riskReward = (tp1 - price) / (price - stopLoss);

  if (stopLoss >= price || tp1 <= price || riskReward < 1.2) {
    return null;
  }

  return {
    id:          `opp_${asset.ticker}_${Date.now()}`,
    asset,
    type:        signalType,
    score:       asset.totalScore,
    entryPrice:  price,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    riskReward,
    reasoning:   `${activeSignals.map(s => s.description).join(' + ')}`,
    detectedAt:  new Date().toISOString(),
    expiresAt:   new Date(Date.now() + 24 * 3600000).toISOString(),
    activeSignals,
  };
}

export async function scanTacticalUniverse(
  mode:     ScanMode,
  config:   TacticalConfig,
  supabase: any,
): Promise<ScreenerResult> {
  const universeMap: Record<ScanMode, UniverseAsset[]> = {
    volatile: VOLATILE_UNIVERSE,
    core:     CORE_TACTICAL_UNIVERSE,
    full:     FULL_TACTICAL_UNIVERSE,
  };

  const universe = universeMap[mode];
  const errors: string[] = [];
  const assets: TacticalAsset[] = [];

  // Procesar activos en paralelo (máx 10 simultáneamente)
  const BATCH_SIZE = 10;
  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(a => processAsset(a, supabase)));
    results.forEach((result, idx) => {
      if (result) assets.push(result);
      else errors.push(`${batch[idx].ticker}: sin datos`);
    });
  }

  // Detectar régimen de mercado
  const spyData = assets.find(a => a.ticker === 'SPY' || a.ticker === 'EXW1.DE');
  const marketRegime = spyData?.closes
    ? detectMarketRegime(spyData.closes, 20)  // VIX por defecto 20
    : {
        regime: 'RANGING',
        confidence: 30,
        description: 'Sin datos de índice — régimen conservador por defecto',
        allowedTypes: ['MEAN_REVERSION', 'OVERSOLD_BOUNCE', 'BLOOD_IN_STREETS'],
        positionSizeMultiplier: 0.8,
        spyAboveMA200: false, spyADX: 20, spyRSI: 50,
        vixLevel: 20, spyMom4w: 0,
      };

  console.debug(
    `[Screener] Régimen detectado: ${marketRegime.regime} (conf=${marketRegime.confidence}%) ` +
    `· Tipos permitidos: [${marketRegime.allowedTypes.join(', ')}] ` +
    `· SizeMult: ×${marketRegime.positionSizeMultiplier}`
  );

  const rawOpps = assets
    .filter(a => a.totalScore >= config.minScore)
    .filter(a => !config.requireAboveMA200 || a.indicators?.aboveMA200)
    .map(buildOpportunity)
    .filter((o): o is TacticalOpportunity => o !== null)
    .filter(o => isSignalAllowed(o.type, marketRegime))
    .map(o => ({ ...o, score: adjustScoreByRegime(o.score, o.type, marketRegime) }))
    .filter(o => o.riskReward >= config.minRiskReward)
    .sort((a, b) => b.score - a.score);

  console.debug(`[Screener] ${assets.length} analizados → ${rawOpps.length} oportunidades · ${marketRegime.regime} · ${errors.length} errores`);

  return {
    assets,
    opportunities: rawOpps,
    topPicks:      rawOpps.slice(0, 5),
    screennedAt:   new Date().toISOString(),
    errors,
    marketRegime,
  };
}

// ── Tamaño de posición ────────────────────────────────────────
/**
 * ARREGLADO: Ahora respeta SIEMPRE los límites de capital.
 * Si la posición calculada viola maxCapitalPerTrade, devuelve 0 (no operar).
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

  // 🔴 FIX CRÍTICO: NO forzar mínimo de 1 acción
  // Antes: const safe = Math.max(1, finalShares);
  // Ahora: si finalShares < 1, NO OPERAR
  const safe = finalShares >= 1 ? Math.floor(finalShares) : 0;
  
  if (safe === 0) {
    console.warn(
      `[PositionSize] ${entryPrice}€/acción con riesgo ${riskPerShare}€ ` +
      `y capital ${tacticalCapital}€ → capital insuficiente (< viable)`
    );
  }

  return {
    shares:        safe,
    capitalRisked: safe > 0 ? +(safe * riskPerShare).toFixed(2) : 0,
    totalInvested: safe > 0 ? +(safe * entryPrice).toFixed(2) : 0,
  };
}

// ── Config por defecto ────────────────────────────────────────
export function defaultTacticalConfig(
  tacticalCapital:    number,
  defensiveLiquidity: number,
): TacticalConfig {
  const safeTac = (typeof tacticalCapital    === 'number' && isFinite(tacticalCapital))    ? tacticalCapital    : 0;
  const safeDef = (typeof defensiveLiquidity === 'number' && isFinite(defensiveLiquidity)) ? defensiveLiquidity : 0;
  const available = Math.min(safeDef * 0.20, safeTac);
  return {
    tacticalCapitalEur:     available > 0 ? available : safeTac,
    maxCapitalPerTrade:     0.30,   // 30% máx por operación individual
    riskPerTradePct:        0.01,   // 1% del capital táctico en riesgo por trade
    maxOpenPositions:       4,      // 4 posiciones abiertas simultáneas
    minScore:               38,     // Score mínimo (bajo el 40 mínimo natural)
    requireAboveMA200:      false,  // Permite comprar debajo de MA200 (para mean reversion)
    minRiskReward:          1.3,    // R:R mínimo aceptable
    maxAtrPct:              0.06,   // Máx 6% de ATR diario
    maxDaysPerTrade:        10,     // Máx 10 días hábiles en posición
    trailingStop:           false,
    maxPctFromDefensiveLiq: 0.20,   // 20% de la liquidez defensiva usable
  };
}
