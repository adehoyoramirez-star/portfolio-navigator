// ============================================================
// src/core/tactical/tacticalScreener.ts
// Motor principal del screener táctico
// ============================================================

import type {
  TacticalAsset, TacticalOpportunity, ScreenerResult,
  TacticalConfig, TechnicalIndicators,
} from './types.ts';
import {
  calcIndicators, generateSignals, calcTotalScore,
  calcStopLoss, calcTakeProfits
} from './tacticalSignals.ts';
import {
  CORE_TACTICAL_UNIVERSE,
  FULL_TACTICAL_UNIVERSE,
  VOLATILE_UNIVERSE,
  type UniverseAsset
} from './tacticalUniverse';

// Exportar universos para que el dashboard pueda seleccionarlos
export { CORE_TACTICAL_UNIVERSE, FULL_TACTICAL_UNIVERSE, VOLATILE_UNIVERSE };
export type ScanMode = 'core' | 'full' | 'volatile';
import { getFundamentals } from './fundamentalsConfig';

// ── Obtener datos de Yahoo Finance via Supabase ──────────────
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

// ── Fallback: obtener datos del yahoo-finance existente ───────
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

// ── Procesar un activo del universo ──────────────────────────
async function processAsset(
  asset: UniverseAsset,
  supabase: any
): Promise<TacticalAsset | null> {
  // Intentar fetch directo primero
  let data = await fetchTickerData(asset.yahooSymbol, supabase);

  // Fallback al yahoo-finance existente para los activos de Olympus
  if (!data) {
    data = await fetchFromExistingYahoo(supabase, asset.yahooSymbol);
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

  // Fallback a fundamentales manuales si Yahoo no devuelve datos
  const manualFundamentals = getFundamentals(asset.yahooSymbol);
  const hasYahooFundamentals = data.per !== undefined && data.per > 0;

  // LOG para debuggear en consola del navegador
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
    // Datos fundamentales (Yahoo o manual fallback)
    earningsYield: hasYahooFundamentals ? data.earningsYield : manualFundamentals.earningsYield,
    per: hasYahooFundamentals ? data.per : manualFundamentals.per,
    eps: hasYahooFundamentals ? data.eps : manualFundamentals.eps,
  };
}

// ── Convertir activo en oportunidad ──────────────────────────
function buildOpportunity(asset: TacticalAsset): TacticalOpportunity | null {
  if (!asset.indicators) return null;

  const activeSignals = asset.signals.filter(s => s.active);
  if (activeSignals.length === 0) return null;

  // Tomar el tipo de la señal más fuerte
  const bestSignal  = activeSignals.sort((a, b) => b.score - a.score)[0];
  const ind         = asset.indicators;
  const entry       = asset.price;
  const stopLoss    = calcStopLoss(entry, ind.atr14, bestSignal.type, asset.closes);
  const { tp1, tp2, rr } = calcTakeProfits(entry, stopLoss, bestSignal.type, ind);

  // Filtro de calidad: R:R mínimo 1.5
  if (rr < 1.3) return null;

  // Caducidad: 3 días para blood in streets, 7 para el resto
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

// ════════════════════════════════════════════════════════════
// SCREENER PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function runTacticalScreener(
  supabase:  any,
  config:    TacticalConfig,
  scanMode:  ScanMode = 'core',
): Promise<ScreenerResult> {
  // Seleccionar universo según modo
  const universeMap = {
    core:     CORE_TACTICAL_UNIVERSE,     // 50 activos ~2 min
    full:     FULL_TACTICAL_UNIVERSE,     // 120 activos ~8 min
    volatile: VOLATILE_UNIVERSE,          // 25 activos HIGH vol ~1 min
  };
  const universe = universeMap[scanMode];
  const errors: string[] = [];
  const assets: TacticalAsset[] = [];

  // Procesar activos en paralelo (batches de 5 para no saturar)
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

  // Construir oportunidades
  console.log(`[Screener] ${assets.length} activos procesados, aplicando filtros...`);
  console.log(`[Screener] Filtros: minScore=${config.minScore}, requireMA200=${config.requireAboveMA200}, minRR=${config.minRiskReward}`);

  const filteredByScore = assets.filter(a => a.totalScore >= config.minScore);
  console.log(`[Screener] Activos con score >= ${config.minScore}: ${filteredByScore.length}`);

  const filteredByMA200 = assets.filter(a => !config.requireAboveMA200 || a.indicators?.aboveMA200);
  console.log(`[Screener] Activos que pasan filtro MA200: ${filteredByMA200.length}`);

  const rawOpps = filteredByScore
    .filter(a => !config.requireAboveMA200 || a.indicators?.aboveMA200)
    .map(buildOpportunity)
    .filter((o): o is TacticalOpportunity => o !== null)
    .filter(o => {
      const pass = o.riskReward >= config.minRiskReward;
      if (!pass) {
        console.log(`[Screener] ${o.asset.ticker} filtrado por R:R=${o.riskReward.toFixed(2)} < ${config.minRiskReward}`);
      }
      return pass;
    })
    .sort((a, b) => b.score - a.score);

  console.log(`[Screener] Oportunidades encontradas: ${rawOpps.length}`);
  if (rawOpps.length > 0) {
    rawOpps.slice(0, 3).forEach(o => {
      console.log(`  - ${o.asset.ticker}: score=${o.score}, R:R=${o.riskReward.toFixed(2)}, tipo=${o.type}`);
    });
  }

  const topPicks = rawOpps.slice(0, 5);

  return {
    assets,
    opportunities: rawOpps,
    topPicks,
    screennedAt: new Date().toISOString(),
    errors,
  };
}

// ── Calcular tamaño de posición ──────────────────────────────
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
  // Para ETFs: lotes enteros. Para crypto/ETC: fraccional
  const shares        = entryPrice < 1000
    ? Math.floor(rawShares)          // ETF — lote entero
    : Math.round(rawShares * 10000) / 10000; // BTC/ETC — fraccional
  const actualShares  = Math.max(1, shares);
  // Limitar por capital máximo por trade
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

// ── Estado del motor por defecto ─────────────────────────────
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
    minScore:               35,           // REDUCIDO: de 45 a 35 para detectar más oportunidades
    requireAboveMA200:      false,        // CAMBIADO: permitir activos bajo MA200 (más oportunidades)
    minRiskReward:          1.3,          // REDUCIDO: de 1.5 a 1.3 para más flexibilidad
    maxAtrPct:              0.06,
    maxDaysPerTrade:        10,
    trailingStop:           false,
    maxPctFromDefensiveLiq: 0.20,
  };
}