// ============================================================
// src/core/tactical/tacticalScreener.ts
// Motor principal del screener táctico
// ============================================================

import type {
  TacticalAsset, TacticalOpportunity, ScreenerResult,
  TacticalConfig, TechnicalIndicators,
} from './types';   // ya no tiene .ts
import {
  calcIndicators, generateSignals, calcTotalScore,
  calcStopLoss, calcTakeProfits
} from './tacticalSignals';   // ya no tiene .ts
import {
  CORE_TACTICAL_UNIVERSE,
  FULL_TACTICAL_UNIVERSE,
  VOLATILE_UNIVERSE,
  type UniverseAsset
} from './tacticalUniverse';
import { getFundamentals } from './fundamentalsConfig';

export { CORE_TACTICAL_UNIVERSE, FULL_TACTICAL_UNIVERSE, VOLATILE_UNIVERSE };
export type ScanMode = 'core' | 'full' | 'volatile';

async function fetchTickerData(
  ticker: string,
  supabase: any
): Promise<{ closes: number[]; volumes: number[]; price: number; per?: number; earningsYield?: number; eps?: number } | null> {
  try {
    const { data, error } = await supabase.functions.invoke('yahoo-finance-tactical', {
      body: { tickers: [ticker] }
    });
    if (error || !data?.data?.[ticker]) return null;
    const d = data.data[ticker];
    return {
      closes:       d.closes  ?? [],
      volumes:      d.volumes ?? [],
      price:        d.currentPrice ?? 0,
      per:          d.per,
      earningsYield: d.earningsYield,
      eps:          d.eps,
    };
  } catch {
    return null;
  }
}

async function fetchFromExistingYahoo(
  supabase: any,
  ticker: string
): Promise<{ closes: number[]; volumes: number[]; price: number } | null> {
  try {
    const { data } = await supabase.functions.invoke('yahoo-finance');
    if (!data?.data?.[ticker]) return null;
    const d = data.data[ticker];
    return {
      closes:  d.closes  ?? [],
      volumes: Array(d.closes?.length ?? 0).fill(1000000),
      price:   d.currentPrice ?? 0,
    };
  } catch {
    return null;
  }
}

async function processAsset(
  asset: UniverseAsset,
  supabase: any
): Promise<TacticalAsset | null> {
  let data = await fetchTickerData(asset.yahooSymbol, supabase);

  // Fallback al símbolo americano si el UCITS no tiene datos
  if ((!data || data.closes.length < 21 || data.price === 0) && asset.fallbackYahooSymbol) {
    console.warn(`[Screener] ${asset.ticker}: usando proxy americano ${asset.fallbackYahooSymbol}`);
    data = await fetchTickerData(asset.fallbackYahooSymbol, supabase);
  }
  // Último recurso: función genérica
  if (!data || data.closes.length < 21 || data.price === 0) {
    data = await fetchFromExistingYahoo(supabase, asset.yahooSymbol)
        || (asset.fallbackYahooSymbol ? await fetchFromExistingYahoo(supabase, asset.fallbackYahooSymbol) : null);
  }
  if (!data || data.closes.length < 21 || data.price === 0) {
    console.warn(`[Screener] Sin datos para ${asset.yahooSymbol}`);
    return null;
  }

  const indicators = calcIndicators(data.closes, data.volumes);
  const signals    = generateSignals(indicators);
  const totalScore = calcTotalScore(signals);
  const high52w    = Math.max(...data.closes.slice(-252));
  const low52w     = Math.min(...data.closes.slice(-252));
  const manualFundamentals = getFundamentals(asset.yahooSymbol);
  const hasYahooFundamentals = data.per !== undefined && data.per > 0;

  console.log(`[Screener] ${asset.ticker}: score=${totalScore}, price=${data.price.toFixed(2)}, ` +
              `RSI2=${indicators.rsi2.toFixed(1)}, RSI14=${indicators.rsi14.toFixed(1)}, ` +
              `sobreMA200=${indicators.aboveMA200}, señales=${signals.filter(s => s.active).length} activas`);

  return {
    ticker:      asset.ticker,
    name:        asset.name,
    sector:      asset.sector,
    type:        asset.type,
    exchange:    asset.exchange,
    currency:    asset.currency,
    price:       data.price,
    closes:      data.closes,
    volumes:     data.volumes,
    high52w,
    low52w,
    indicators,
    signals,
    totalScore,
    lastUpdated: new Date().toISOString(),
    earningsYield: hasYahooFundamentals ? data.earningsYield : manualFundamentals.earningsYield,
    per: hasYahooFundamentals ? data.per : manualFundamentals.per,
    eps: hasYahooFundamentals ? data.eps : manualFundamentals.eps,
  };
}

function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators) return null;

  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  const bestSignal  = activeSignals.sort((a, b) => b.score - a.score)[0];
  const ind         = asset.indicators;
  const entry       = asset.price;
  const stopLoss    = calcStopLoss(entry, ind.atr14, bestSignal.type, asset.closes);
  const { tp1, tp2, rr } = calcTakeProfits(entry, stopLoss, bestSignal.type, ind);

  if (rr < 1.3) return null;

  const expiryDays  = bestSignal.type === 'BLOOD_IN_STREETS' ? 3 : 7;
  const expiresAt   = new Date(Date.now() + expiryDays * 86400000).toISOString();

  const reasoning = [
    `${activeSignals.length} señal(es) activa(s):`,
    ...activeSignals.map(s => `• ${s.type}: ${s.description}`),
    `R:R ${rr.toFixed(1)} — Stop en €${stopLoss.toFixed(2)}, TP1 €${tp1.toFixed(2)}`,
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
    expiresAt,
    activeSignals,
  };
}

export async function runTacticalScreener(
  supabase:  any,
  config:    TacticalConfig,
  scanMode:  ScanMode = 'core',
): Promise<ScreenerResult> {
  const universeMap = {
    core:     CORE_TACTICAL_UNIVERSE,     // 22 activos
    full:     FULL_TACTICAL_UNIVERSE,     // 57 activos
    volatile: VOLATILE_UNIVERSE,          // 17 activos
  };
  const universe = universeMap[scanMode];
  const errors: string[] = [];
  const assets: TacticalAsset[] = [];

  const BATCH = 5;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(a => processAsset(a, supabase))
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) {
        assets.push(r.value);
      } else if (r.status === 'rejected') {
        errors.push(`${batch[idx].ticker}: ${r.reason}`);
      }
    });
  }

  console.log(`[Screener] ${assets.length} activos procesados, aplicando filtros...`);

  const filteredByScore = assets.filter(a => a.totalScore >= config.minScore);
  const rawOpps = filteredByScore
    .filter(a => !config.requireAboveMA200 || a.indicators?.aboveMA200)
    .map(buildOpportunity)
    .filter((o): o is TacticalOpportunity => o !== null)
    .filter(o => o.riskReward >= config.minRiskReward)
    .sort((a, b) => b.score - a.score);

  console.log(`[Screener] Oportunidades encontradas: ${rawOpps.length}`);

  const topPicks = rawOpps.slice(0, 5);

  return {
    assets,
    opportunities: rawOpps,
    topPicks,
    screennedAt: new Date().toISOString(),
    errors,
  };
}

export function calcPositionSize(
  tacticalCapital: number,
  entryPrice:      number,
  stopLoss:        number,
  config:          TacticalConfig
): { shares: number; capitalRisked: number; totalInvested: number } {
  const riskEur   = tacticalCapital * config.riskPerTradePct;
  const riskPerShare = entryPrice - stopLoss;
  if (riskPerShare <= 0) {
    return { shares: 0, capitalRisked: 0, totalInvested: 0 };
  }
  const rawShares     = riskEur / riskPerShare;
  const shares        = entryPrice < 1000
    ? Math.floor(rawShares)
    : Math.round(rawShares * 10000) / 10000;
  const actualShares  = Math.max(1, shares);
  const maxInvest     = tacticalCapital * config.maxCapitalPerTrade;
  const idealInvest   = actualShares * entryPrice;
  const finalShares   = idealInvest > maxInvest
    ? (entryPrice > 0 ? Math.floor(maxInvest / entryPrice) : 0)
    : actualShares;
  return {
    shares:        Math.max(1, finalShares),
    capitalRisked: finalShares * riskPerShare,
    totalInvested: finalShares * entryPrice,
  };
}

export function defaultTacticalConfig(
  tacticalCapital: number,
  defensiveLiquidity: number
): TacticalConfig {
  const available = Math.min(
    defensiveLiquidity * 0.20,
    tacticalCapital
  );
  return {
    tacticalCapitalEur:     available > 0 ? available : tacticalCapital,
    maxCapitalPerTrade:     0.30,
    riskPerTradePct:        0.01,
    maxOpenPositions:       4,
    minScore:               35,
    requireAboveMA200:      false,
    minRiskReward:          1.3,
    maxAtrPct:              0.06,
    maxDaysPerTrade:        10,
    trailingStop:           false,
    maxPctFromDefensiveLiq: 0.20,
  };
}