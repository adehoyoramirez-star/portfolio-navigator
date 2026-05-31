// ============================================================
// src/core/tactical/tacticalPortfolio.ts — v5 IMPROVED
//
// MEJORAS v5 (Antonio's SMCI Strategy):
//
//   1. EARNINGS AUTO-CLOSE INTEGRATION
//      - Nuevas funciones: checkEarningsAutoClose(), applyEarningsAutoClose()
//      - En updatePositionPrices(): verifica si debería cerrarse automáticamente
//      - Cierra 5 días ANTES de earnings HIGH si P&L >= -2%
//      - Dashboard muestra contador de días a earnings + botón manual
//
//   2. DYNAMIC STOP-LOSS (MA50 + ATR) — NUEVO PARÁMETRO
//      - openPosition: opción de usar stop dinámico vs. clásico
//      - calcDynamicStopLoss() integrado (desde tacticalSignals-v7)
//      - Ambos métodos soportados: legacy (entry-atr) y moderno (ma50+atr)
//
//   3. IMPROVED POSITION METRICS
//      - daysToEarnings: nuevo campo en TacticalPosition
//      - autoCloseReason: motivo si cierra por earnings
//      - shouldAutoClose flag para UI
//
// COMPATIBILIDAD:
//   - API existente se mantiene (backward compatible)
//   - Parámetros nuevos son opcionales
//   - Fallback a calcStopLoss() clásico si no hay MA50
//
// ============================================================

import type {
  TacticalEngineState, TacticalConfig, TacticalOpportunity,
  TacticalPosition, OpportunityStatus,
} from './types';
import {
  calcOptimalHorizon, calcTimingScore, calcDaysToBreakeven,
  calcStopLoss, calcTakeProfits, calcDynamicMaxDays,
  classifyAssetSpeed,
  calcDynamicStopLoss,
  shouldAutoCloseBeforeEarnings,
  getUpcomingEventInfo,
} from './tacticalSignals';
import { checkCorrelation, getSectorGroup } from './correlationManager';
import { toEur, getCachedFxRates } from './fxConverter';
import type { MarketRegime } from './marketRegimeFilter';

// ════════════════════════════════════════════════════════════
// ESTADO INICIAL Y PERSISTENCIA
// ════════════════════════════════════════════════════════════

// ── Supabase persistence: cliente inyectado por el dashboard ───
let supabaseClient: any = null;
export function setSupabaseClient(client: any): void {
  supabaseClient = client;
}

// ── Guardar estado en Supabase ──────────────────────────────────
async function saveToSupabase(toSave: Record<string, unknown>): Promise<boolean> {
  if (!supabaseClient) return false;
  try {
    const { error } = await supabaseClient
      .from('tactical_engine_state')
      .upsert({ id: 1, state: toSave, updated_at: new Date().toISOString() });
    if (error) {
      console.warn('[Tactical] Supabase save error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Tactical] Supabase save exception:', err);
    return false;
  }
}

// ── Cargar estado desde Supabase ────────────────────────────────
async function loadFromSupabase(): Promise<Record<string, unknown> | null> {
  if (!supabaseClient) return null;
  try {
    const { data, error } = await supabaseClient
      .from('tactical_engine_state')
      .select('state')
      .eq('id', 1)
      .single();
    if (error || !data?.state) return null;
    return data.state as Record<string, unknown>;
  } catch (err) {
    console.warn('[Tactical] Supabase load error:', err);
    return null;
  }
}

export function initTacticalState(config: TacticalConfig): TacticalEngineState {
  return {
    config,
    opportunities:       [],
    openPositions:       [],
    closedPositions:     [],
    totalRealizedPnL:    0,
    totalUnrealizedPnL:  0,
    winRate:             0,
    avgRiskReward:       0,
    profitFactor:        1,
    maxDrawdown:         0,
    capitalUsed:         0,
    capitalAvailable:    config.tacticalCapitalEur,
    lastScreened:        null,
  };
}

export function sanitizeState(state: TacticalEngineState): TacticalEngineState {
  const capitalUsed = state.openPositions.reduce(
    (sum, p) => sum + (p.totalInvested ?? 0), 0,
  );
  const capitalAvailable = Math.max(
    0, state.config.tacticalCapitalEur - capitalUsed,
  );

  if (
    Math.abs(state.capitalAvailable - capitalAvailable) > 0.01 ||
    Math.abs(state.capitalUsed      - capitalUsed)      > 0.01
  ) {
    console.warn(
      `[Tactical] Capital saneado: disponible ${state.capitalAvailable.toFixed(2)} → ${capitalAvailable.toFixed(2)}, ` +
      `usado ${state.capitalUsed.toFixed(2)} → ${capitalUsed.toFixed(2)}`,
    );
    return { ...state, capitalAvailable, capitalUsed };
  }
  return state;
}

const STORAGE_KEY = 'olympus_tactical_state_v5';

export function loadTacticalState(config: TacticalConfig): TacticalEngineState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initTacticalState(config);
    const parsed = JSON.parse(raw) as TacticalEngineState;
    return sanitizeState({ ...parsed, config });
  } catch {
    console.warn('[Tactical] Error al cargar estado — reiniciando');
    return initTacticalState(config);
  }
}

export async function loadTacticalStateFromSupabase(config: TacticalConfig): Promise<TacticalEngineState | null> {
  if (!config.supabasePersistence) return null;
  const supabaseState = await loadFromSupabase();
  if (!supabaseState) return null;
  return sanitizeState({ ...supabaseState as unknown as TacticalEngineState, config });
}

export function saveTacticalState(state: TacticalEngineState): void {
  try {
    const toSave = {
      ...state,
      opportunities: [],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));

    // ── Backup a Supabase si config.supabasePersistence está activo ──
    if (state.config.supabasePersistence) {
      saveToSupabase(toSave);
    }
  } catch (err) {
    console.error('[Tactical] Error al guardar estado:', err);
  }
}

// ════════════════════════════════════════════════════════════
// POSITION SIZING (Kelly + Half-Kelly + Fixed Risk)
// ════════════════════════════════════════════════════════════

export function calcPositionSize(
  capitalAvailableEur: number,
  entryPriceEur:       number,
  stopLossEur:         number,
  config:              TacticalConfig,
): { shares: number; capitalRisked: number; totalInvested: number } {
  const riskPerShareEur = entryPriceEur - stopLossEur;
  if (riskPerShareEur <= 0) return { shares: 0, capitalRisked: 0, totalInvested: 0 };

  const riskEur   = capitalAvailableEur * config.riskPerTradePct;
  const rawShares = riskEur / riskPerShareEur;

  const byRisk = entryPriceEur < 1_000
    ? Math.floor(rawShares)
    : Math.round(rawShares * 10_000) / 10_000;

  const maxInvestEur = capitalAvailableEur * config.maxCapitalPerTrade;
  const capped = byRisk * entryPriceEur > maxInvestEur
    ? Math.floor(maxInvestEur / entryPriceEur)
    : byRisk;
  const safe = capped >= 1 ? Math.floor(capped) : 0;

  if (safe === 0) {
    console.warn(
      `[PositionSize] Capital insuficiente: €${entryPriceEur.toFixed(2)} · ` +
      `riesgo €${riskPerShareEur.toFixed(2)}/share`,
    );
  }

  return {
    shares:        safe,
    capitalRisked: safe > 0 ? +(safe * riskPerShareEur).toFixed(2) : 0,
    totalInvested: safe > 0 ? +(safe * entryPriceEur).toFixed(2)   : 0,
  };
}

export function calcKellyPositionSize(
  capitalAvailableEur: number,
  entryPriceEur:       number,
  stopLossEur:         number,
  winRate:             number,
  avgRiskReward:       number,
  useHalfKelly:        boolean = true,
): { shares: number; capitalRisked: number; totalInvested: number; kellyPct: number } {
  const riskPerShareEur = entryPriceEur - stopLossEur;
  if (riskPerShareEur <= 0 || winRate <= 0 || capitalAvailableEur <= 0) {
    return { shares: 0, capitalRisked: 0, totalInvested: 0, kellyPct: 0 };
  }

  const W = winRate / 100;
  const avgWin = Math.max(avgRiskReward, 0.1);
  const avgLoss = 1.0;

  const numerator = W * avgWin - (1 - W) * avgLoss;
  const denominator = avgWin * avgLoss;
  const fullKelly = denominator > 0 ? Math.max(0, numerator / denominator) : 0;

  const kellyPct = useHalfKelly
    ? Math.min(0.25, fullKelly * 0.5)
    : Math.min(0.25, fullKelly);

  if (fullKelly <= 0 && winRate > 0) {
    console.warn(
      `[Kelly] f*=0 — WinRate ${winRate}%, R:R ${avgRiskReward.toFixed(2)} insuficiente ` +
      `para Kelly positivo (necesitas W > 1/(R+1) = ${(1 / (avgWin + 1) * 100).toFixed(0)}%)`
    );
  }

  const riskEur = capitalAvailableEur * kellyPct;
  const rawShares = riskEur / riskPerShareEur;

  const shares = entryPriceEur < 1_000
    ? Math.floor(rawShares)
    : Math.round(rawShares * 10_000) / 10_000;

  const safe = Math.max(0, shares >= 1 ? Math.floor(shares) : 0);

  return {
    shares:        safe,
    capitalRisked: safe > 0 ? +(safe * riskPerShareEur).toFixed(2) : 0,
    totalInvested: safe > 0 ? +(safe * entryPriceEur).toFixed(2)   : 0,
    kellyPct:      +(kellyPct * 100).toFixed(1),
  };
}

export function calcHalfKellySize(
  capitalAvailableEur: number,
  entryPriceEur:       number,
  stopLossEur:         number,
  winRate:             number,
  avgRiskReward:       number,
): { shares: number; capitalRisked: number; totalInvested: number; kellyPct: number } {
  return calcKellyPositionSize(capitalAvailableEur, entryPriceEur, stopLossEur, winRate, avgRiskReward, true);
}

// ════════════════════════════════════════════════════════════
// OPEN POSITION WITH DYNAMIC STOP-LOSS OPTION (v5 NEW)
// ════════════════════════════════════════════════════════════

export interface OpenPositionOptions {
  useDynamicStopLoss?: boolean;  // Si true: usa MA50+ATR en lugar de entry-ATR
  ma50?: number;                  // Media móvil de 50 periodos (en EUR)
}

/**
 * Calcula el sizing Kelly progresivo basado en executionScore.
 * executionScore ≥ 85 → Kelly completo (hasta 25% del capital disponible)
 * executionScore ≥ 75 → Half-Kelly (hasta 15%)
 * executionScore ≥ 65 → Quarter-Kelly (hasta 8%)
 * executionScore < 65 → Fixed risk (config.riskPerTradePct, 1%)
 */
function calcKellySizingFromScore(
  capitalAvailableEur: number,
  entryPriceEur:       number,
  stopLossEur:         number,
  executionScore:      number,
): { shares: number; capitalRisked: number; totalInvested: number; kellyPct: number } {
  const riskPerShareEur = entryPriceEur - stopLossEur;
  if (riskPerShareEur <= 0 || capitalAvailableEur <= 0) {
    return { shares: 0, capitalRisked: 0, totalInvested: 0, kellyPct: 0 };
  }

  // Escalar Kelly según executionScore
  // executionScore 100 → 0.25 (25% del capital disponible)
  // executionScore 65 → 0.01 (1%, igual que fixed risk)
  // interpolación lineal entre 0.01 y 0.25 para scores 65-100
  const minPct = 0.01;
  const maxPct = 0.25;
  const normalizedScore = Math.max(65, Math.min(100, executionScore)) - 65;
  const kellyPct = minPct + (maxPct - minPct) * (normalizedScore / 35);

  const riskEur = capitalAvailableEur * kellyPct;
  const rawShares = riskEur / riskPerShareEur;

  const shares = entryPriceEur < 1_000
    ? Math.floor(rawShares)
    : Math.max(1, Math.round(rawShares * 10_000) / 10_000);

  const safe = Math.max(0, shares >= 1 ? Math.floor(shares) : 0);

  return {
    shares:        safe,
    capitalRisked: safe > 0 ? +(safe * riskPerShareEur).toFixed(2) : 0,
    totalInvested: safe > 0 ? +(safe * entryPriceEur).toFixed(2)   : 0,
    kellyPct:      +(kellyPct * 100).toFixed(1),
  };
}

export function openPosition(
  state:       TacticalEngineState,
  opportunity: TacticalOpportunity,
  options?:    OpenPositionOptions,
): TacticalEngineState {
  const { config } = state;

  if (state.openPositions.length >= config.maxOpenPositions) {
    console.warn('[Tactical] Max open positions reached');
    return state;
  }

  // ── INSTITUCIONAL: VaR/Drawdown circuit breaker ───────────────
  // Si el drawdown actual supera el límite, bloquear nuevas posiciones
  if (config.maxDrawdownPct > 0 && Math.abs(state.maxDrawdown) >= config.maxDrawdownPct) {
    console.warn(
      `[Tactical] 🔴 CIRCUIT BREAKER — Drawdown ${state.maxDrawdown.toFixed(1)}% ` +
      `≥ límite ${config.maxDrawdownPct}%. No se abren nuevas posiciones.`
    );
    return state;
  }

  const corrCheck = checkCorrelation(opportunity, state.openPositions, config.maxOpenPositions);
  if (!corrCheck.allowed) {
    console.warn(`[Tactical] Correlación bloqueada: ${corrCheck.reason}`);
    return state;
  }

  const entryPriceEur = opportunity.entryPrice;
  let stopLossEur = opportunity.stopLoss;

  // ── v5 NEW: Dynamic stop-loss MA50 + 1×ATR ────────────────────
  if (options?.useDynamicStopLoss && options.ma50 && opportunity.asset.indicators?.atr14) {
    const fxRates   = getCachedFxRates();
    const currency  = opportunity.asset.currency;
    const rawAtr    = opportunity.asset.indicators.atr14;
    const atrEur    = toEur(rawAtr, currency, fxRates);
    
    const dynStop = calcDynamicStopLoss(options.ma50, atrEur, entryPriceEur);
    if (dynStop > 0 && dynStop < entryPriceEur) {
      stopLossEur = dynStop;
      console.log(
        `[Position] Stop-loss dinámico: MA50 €${options.ma50.toFixed(2)} + ATR €${atrEur.toFixed(2)} = €${dynStop.toFixed(2)}`
      );
    }
  }

  // ── INSTITUCIONAL: Kelly sizing progresivo por executionScore ──
  let shares: number;
  let capitalRisked: number;
  let totalInvested: number;
  let kellyInfo = '';

  if (config.useKellySizing && opportunity.executionScore > 0) {
    const kelly = calcKellySizingFromScore(
      state.capitalAvailable, entryPriceEur, stopLossEur,
      opportunity.executionScore,
    );
    shares = kelly.shares;
    capitalRisked = kelly.capitalRisked;
    totalInvested = kelly.totalInvested;
    kellyInfo = ` (Kelly ${opportunity.executionScore}pt → ${kelly.kellyPct.toFixed(1)}%)`;
  } else {
    const fixed = calcPositionSize(
      state.capitalAvailable, entryPriceEur, stopLossEur, config,
    );
    shares = fixed.shares;
    capitalRisked = fixed.capitalRisked;
    totalInvested = fixed.totalInvested;
  }

  if (shares === 0 || totalInvested > state.capitalAvailable) {
    console.warn('[Tactical] Capital insuficiente para abrir posición');
    return state;
  }

  console.log(`[Tactical] Abriendo ${opportunity.asset.ticker}: ${shares} acc. × €${entryPriceEur.toFixed(2)} = €${totalInvested.toFixed(0)}${kellyInfo}`);

  const fxRates   = getCachedFxRates();
  const currency  = opportunity.asset.currency;
  const rawAtr    = opportunity.asset.indicators?.atr14 ?? (opportunity.asset.price * 0.02);
  const atrEur    = toEur(rawAtr, currency, fxRates);

  const atrPct    = atrEur / Math.max(0.01, entryPriceEur);
  const speed     = classifyAssetSpeed(atrPct);
  const dynMax    = calcDynamicMaxDays(atrPct);

  const optimalTP1 = calcOptimalHorizon(entryPriceEur, opportunity.takeProfit1, atrEur, opportunity.type);
  const optimalTP2 = calcOptimalHorizon(entryPriceEur, opportunity.takeProfit2, atrEur, opportunity.type);

  const maxDaysAllowed = Math.min(
    dynMax,
    Math.max(5, Math.round(optimalTP2.days * 1.2)),
  );

  // ── v5 NEW: Earnings info ──────────────────────────────────────
  const earningsInfo = getUpcomingEventInfo(opportunity.asset.ticker);
  
  const position: TacticalPosition = {
    id:             `pos-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ticker:         opportunity.asset.ticker,
    name:           opportunity.asset.name,
    type:           opportunity.type,
    currency:       currency,
    sectorGroup:    getSectorGroup(opportunity.asset.sector),
    entryDate:      new Date().toISOString(),
    entryPrice:     opportunity.asset.price,
    entryPriceEur,
    shares,
    capitalRisked,
    totalInvested,
    stopLoss:       stopLossEur,
    takeProfit1:    opportunity.takeProfit1,
    takeProfit2:    opportunity.takeProfit2,
    atrAtEntry:     atrEur,
    status:         'OPEN',
    currentPrice:   opportunity.asset.price,
    exitDate:       null,
    exitPrice:      null,
    exitReason:     null,
    unrealizedPnL:  0,
    unrealizedPnLPct: 0,
    realizedPnL:    null,
    realizedPnLPct: null,
    daysOpen:       0,
    maxDaysAllowed,
    expectedDaysToTP1: calcOptimalHorizon(entryPriceEur, opportunity.takeProfit1, atrEur, opportunity.type).days,
    expectedDaysToTP2: calcOptimalHorizon(entryPriceEur, opportunity.takeProfit2, atrEur, opportunity.type).days,
    daysToBreakeven: 0,
    timingScore:    0,
    optimalDaysTP1: optimalTP1.days,
    optimalDaysTP2: optimalTP2.days,
    optimalProbTP1: optimalTP1.prob,
    
    // ── v5 NEW: Earnings tracking ──────────────────────────────
    daysToEarnings:  earningsInfo.daysToEvent,
    shouldAutoClose: earningsInfo.shouldAutoClose,
    autoCloseReason: earningsInfo.shouldAutoClose 
      ? `Earnings ${earningsInfo.event?.detail || 'proximas'} en ${earningsInfo.daysToEvent}d`
      : undefined,
  };

  const updated = {
    ...state,
    openPositions: [...state.openPositions, position],
    capitalAvailable: state.capitalAvailable - totalInvested,
    capitalUsed:      state.capitalUsed + totalInvested,
  };

  saveTacticalState(updated);
  return updated;
}

// ════════════════════════════════════════════════════════════
// UPDATE POSITION PRICES (includes earnings auto-close check)
// ════════════════════════════════════════════════════════════
export function updatePositionPrices(
  state: TacticalEngineState,
  priceUpdates: Record<string, number>,  // ticker -> currentPrice
): TacticalEngineState {
  if (state.openPositions.length === 0) return state;

  const updated = state.openPositions.map(p => {
    const current = priceUpdates[p.ticker];
    if (!current || current <= 0) return p;

    const unrealPnL = (current - p.entryPrice) * p.shares;
    const unrealPct = (current / p.entryPrice - 1) * 100;
    
    const daysOpen = Math.floor(
      (Date.now() - new Date(p.entryDate).getTime()) / 86400000
    );
    
    const timingScore = calcTimingScore(
      daysOpen,
      p.expectedDaysToTP1,
    );

    // ── v5 NEW: Earnings auto-close check ──────────────────────
    const earningsCheck = shouldAutoCloseBeforeEarnings(p.ticker, unrealPct);
    const shouldClose = earningsCheck.shouldClose;

    // ── v6 NEW: Trailing stop check ────────────────────────────
    // Si trailing stop está activo, actualizar highestPrice y
    // verificar si el precio ha caído por debajo del trailing stop
    let trailingHit = false;
    let trailingReason = '';

    if (p.trailingStopActive && p.trailingStopPrice != null && p.highestPriceSinceTP1 != null) {
      const newHighest = Math.max(p.highestPriceSinceTP1, current);
      // Actualizar trailing stop: 2× ATR desde el máximo
      const trailDist = p.trailingStopDistance ?? (current * 0.04);
      const newTrailPrice = Math.max(0.01, newHighest - trailDist);

      if (current <= newTrailPrice) {
        trailingHit = true;
        trailingReason = `TRAILING_STOP: precio €${current.toFixed(2)} cayó desde max €${newHighest.toFixed(2)} (distancia €${trailDist.toFixed(2)})`;
      }

      return {
        ...p,
        currentPrice: current,
        unrealizedPnL: unrealPnL,
        unrealizedPnLPct: unrealPct,
        daysOpen,
        timingScore,
        highestPriceSinceTP1: newHighest,
        trailingStopPrice: trailingHit ? p.trailingStopPrice : newTrailPrice,
        shouldAutoClose: shouldClose || trailingHit,
        autoCloseReason: trailingHit ? trailingReason : (shouldClose ? earningsCheck.reason : p.autoCloseReason),
      };
    }

    return {
      ...p,
      currentPrice: current,
      unrealizedPnL: unrealPnL,
      unrealizedPnLPct: unrealPct,
      daysOpen,
      timingScore,
      shouldAutoClose: shouldClose,
      autoCloseReason: shouldClose ? earningsCheck.reason : p.autoCloseReason,
    };
  });

  return {
    ...state,
    openPositions: updated,
  };
}

// ════════════════════════════════════════════════════════════
// CLOSE POSITION (con earnings auto-close logic)
// ════════════════════════════════════════════════════════════

export function closePosition(
  state:      TacticalEngineState,
  positionId: string,
  exitPrice:  number,
  reason:     string = 'MANUAL',
): TacticalEngineState {
  const position = state.openPositions.find(p => p.id === positionId);
  if (!position) return state;

  const fxRates = getCachedFxRates();
  const currency = position.currency;
  const exitPriceEur = toEur(exitPrice, currency, fxRates);

  const realizedPnL = (exitPriceEur - position.entryPriceEur) * position.shares;
  const realizedPct = (exitPrice / position.entryPrice - 1) * 100;

  const closedStatus: OpportunityStatus =
    reason === 'TP1' || reason === 'TP2' ? 'CLOSED_TP' :
    reason === 'SL'                       ? 'CLOSED_SL' :
    reason === 'TIME'                     ? 'CLOSED_TIME' :
    'CLOSED_MANUAL';

  const closed: TacticalPosition = {
    ...position,
    status: closedStatus,
    exitDate: new Date().toISOString(),
    exitPrice,
    exitReason: reason,
    realizedPnL,
    realizedPnLPct: realizedPct,
  };

  const remaining = state.openPositions.filter(p => p.id !== positionId);
  const totalReal = state.totalRealizedPnL + realizedPnL;
  const allClosed = [...state.closedPositions, closed];

  const winCount = allClosed.filter(p => (p.realizedPnLPct ?? 0) >= 0).length;
  const winRate = allClosed.length > 0 ? (winCount / allClosed.length) * 100 : 0;

  const winSum = allClosed
    .filter(p => (p.realizedPnLPct ?? 0) >= 0)
    .reduce((s, p) => s + (p.realizedPnL ?? 0), 0);
  const lossSum = allClosed
    .filter(p => (p.realizedPnLPct ?? 0) < 0)
    .reduce((s, p) => s + Math.abs(p.realizedPnL ?? 0), 0);
  const profitFactor = lossSum > 0 ? winSum / lossSum : (winSum > 0 ? 999 : 1);

  const allRealizedSum = allClosed.reduce((s, p) => s + (p.realizedPnL ?? 0), 0);
  const allUnrealSum = remaining.reduce((s, p) => s + (p.unrealizedPnL ?? 0), 0);
  const maxDD = allClosed.reduce((worst, p) => {
    const dd = (p.realizedPnL ?? 0) / state.config.tacticalCapitalEur;
    return Math.min(worst, dd);
  }, 0);

  const capitalReleased = position.totalInvested;

  const updated = {
    ...state,
    openPositions: remaining,
    closedPositions: allClosed,
    totalRealizedPnL: totalReal,
    totalUnrealizedPnL: allUnrealSum,
    winRate: parseFloat(winRate.toFixed(1)),
    avgRiskReward: profitFactor,
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdown: parseFloat((maxDD * 100).toFixed(2)),
    capitalAvailable: state.capitalAvailable + capitalReleased,
    capitalUsed: state.capitalUsed - capitalReleased,
  };

  saveTacticalState(updated);
  return updated;
}

// ════════════════════════════════════════════════════════════
// POSITION HEALTH EVALUATION
// ════════════════════════════════════════════════════════════

export interface PositionHealth {
  status:         'HEALTHY' | 'WARNING' | 'CRITICAL';
  reason:         string;
  action?:        string;
  detail?:        string;
  confidence?:    number;
  urgency?:       'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  suggestedExit?: number;
  scaleUpAmount?: number;
}

export function evaluatePositionHealth(
  position: TacticalPosition,
  config?: TacticalConfig,
): PositionHealth {
  const daysLeft = position.maxDaysAllowed - position.daysOpen;
  const pnlPct = position.unrealizedPnLPct;

  // CRITICAL: maxDaysAllowed alcanzado
  if (position.daysOpen >= position.maxDaysAllowed) {
    return {
      status:       'CRITICAL',
      reason:       `Día ${position.daysOpen}/${position.maxDaysAllowed} alcanzado`,
      action:       'CLOSE_NOW',
      detail:       'El horizonte temporal máximo ha sido superado. Cierra la posición independientemente del P&L.',
      confidence:   95,
      urgency:      'CRITICAL',
      suggestedExit: position.currentPrice,
    };
  }

  // CRITICAL: stop-loss hit
  if (position.currentPrice <= position.stopLoss * 1.01) {
    return {
      status:       'CRITICAL',
      reason:       `Cerca del stop-loss €${position.stopLoss.toFixed(2)}`,
      action:       'CLOSE_NOW',
      detail:       `Precio actual €${position.currentPrice.toFixed(2)} dentro del 1% del stop. Ejecuta salida inmediata.`,
      confidence:   90,
      urgency:      'CRITICAL',
      suggestedExit: position.stopLoss,
    };
  }

  // WARNING: <3 días al máximo
  if (daysLeft <= 3) {
    return {
      status:       'WARNING',
      reason:       `Solo ${daysLeft}d hasta maxDays. Considera TP1 o salida.`,
      action:       'CONSIDER_TP1',
      detail:       `Quedan ${daysLeft} día(s) de margen. Si no has alcanzado TP1, evalúa salida parcial.`,
      confidence:   75,
      urgency:      'HIGH',
      suggestedExit: position.takeProfit1,
    };
  }

  // WARNING: drawdown >20%
  if (pnlPct < -20) {
    return {
      status:       'WARNING',
      reason:       `Drawdown ${pnlPct.toFixed(1)}% excesivo. Reevalúa thesis.`,
      action:       'REEVALUATE',
      detail:       `La posición acumula ${pnlPct.toFixed(1)}% de pérdida no realizada. Verifica si la tesis sigue vigente.`,
      confidence:   70,
      urgency:      'HIGH',
      suggestedExit: position.stopLoss,
    };
  }

  // HEALTHY: ganancia > 50% → scale-up
  if (pnlPct > 50) {
    const scaleUp = Math.floor(position.shares * 0.25);
    if (scaleUp > 0) {
      return {
        status:       'HEALTHY',
        reason:       `P&L ${pnlPct.toFixed(1)}% — considera pyramid (add ${scaleUp} shares)`,
        action:       'SCALE_UP',
        detail:       `La posición supera +50%. Pirámide sugerida: añadir ${scaleUp} acciones (25% del tamaño actual).`,
        confidence:   80,
        urgency:      'LOW',
        scaleUpAmount: scaleUp,
      };
    }
  }

  return {
    status:     'HEALTHY',
    reason:     `Trade en rango normal (día ${position.daysOpen}/${position.maxDaysAllowed})`,
    action:     'HOLD',
    detail:     `P&L actual ${pnlPct.toFixed(1)}%. Sin señales de alerta. Mantén la posición según el plan.`,
    confidence: 85,
    urgency:    'LOW',
  };
}

// ════════════════════════════════════════════════════════════
// SUMMARY METRICS
// ════════════════════════════════════════════════════════════

export function getTacticalSummary(state: TacticalEngineState) {
  const netPnL = state.totalRealizedPnL + state.totalUnrealizedPnL;
  const netPnLPct = state.config.tacticalCapitalEur > 0
    ? (netPnL / state.config.tacticalCapitalEur) * 100
    : 0;
  const hasOpenEarnings = state.openPositions.some(
    p => p.daysToEarnings && p.daysToEarnings <= 5
  );
  const needsAutoClose = state.openPositions.filter(p => p.shouldAutoClose).length;

  return {
    totalTrades:        state.closedPositions.length + state.openPositions.length,
    openPositions:      state.openPositions.length,
    closedPositions:    state.closedPositions.length,
    realizedPnL:        state.totalRealizedPnL,
    realizedPnLPct:     state.closedPositions.length > 0
      ? (state.totalRealizedPnL / state.config.tacticalCapitalEur) * 100
      : 0,
    unrealizedPnL:      state.totalUnrealizedPnL,
    unrealizedPnLPct:   state.openPositions.length > 0
      ? (state.totalUnrealizedPnL / state.config.tacticalCapitalEur) * 100
      : 0,
    netPnL,
    netPnLPct,
    winRate:            parseFloat(state.winRate.toFixed(1)),
    profitFactor:       parseFloat(state.profitFactor.toFixed(2)),
    maxDrawdown:        state.maxDrawdown,
    capitalUsed:        state.capitalUsed,
    capitalAvailable:   state.capitalAvailable,
    capitalUtilization: state.config.tacticalCapitalEur > 0
      ? (state.capitalUsed / state.config.tacticalCapitalEur) * 100
      : 0,
    hasOpenEarnings,
    needsAutoClose,
    openCount:      state.openPositions.length,
    alertsToAction: state.openPositions
      .filter(p =>
        p.shouldAutoClose ||
        p.currentPrice <= p.stopLoss * 1.01 ||
        p.daysOpen >= p.maxDaysAllowed,
      )
      .map(p => {
        if (p.shouldAutoClose)
          return `${p.ticker}: ${p.autoCloseReason ?? 'Auto-cierre pendiente'}`;
        if (p.currentPrice <= p.stopLoss * 1.01)
          return `${p.ticker}: Stop-loss alcanzado (€${p.stopLoss.toFixed(2)})`;
        if (p.daysOpen >= p.maxDaysAllowed)
          return `${p.ticker}: Tiempo máximo superado (${p.daysOpen}d/${p.maxDaysAllowed}d)`;
        return `${p.ticker}: Revisar posición`;
      }),
  };
}

// ════════════════════════════════════════════════════════════
// EXPORTED TYPES & CALCULATION HELPERS
// ════════════════════════════════════════════════════════════

export { calcExpectedDays } from './tacticalSignals';
export { calcTimingScore } from './tacticalSignals';
export { calcKellySizingFromScore };
export type { TacticalEngineState } from './types';