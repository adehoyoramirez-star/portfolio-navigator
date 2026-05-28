// ============================================================
// src/core/tactical/tacticalPortfolio.ts — v4 ELITE
//
// CORRECCIONES CRÍTICAS v4:1
//
//   1. FX AWARENESS: todo el capital se opera en EUR.
//      openPosition convierte entryPrice y stopLoss a EUR usando
//      priceEur del asset (calculado por el screener con FX rates).
//      closePosition convierte exitPrice a EUR antes de P&L.
//      capitalUsed / capitalAvailable siempre en EUR.
//
//   2. atrAtEntry: almacenado en EUR en TacticalPosition al abrir.
//      updatePositionPrices ya no usa el fallback 2% hardcodeado.
//
//   3. sectorGroup: almacenado en TacticalPosition al abrir desde
//      asset.sector. correlationManager usa p.sectorGroup directamente.
//
//   4. calcExpectedDays ELIMINADO: unificado en calcOptimalHorizon
//      (tacticalSignals.ts). El modelo FPT E[T]=d/μ es la única
//      fuente de verdad para horizonte esperado.
//
//   5. maxDrawdown en recalcMetrics INCLUYE posiciones abiertas.
//      Antes: ignoraba el unrealizedPnL → drawdown subestimado al 100%
//      durante posiciones activas perdedoras.
//
//   6. closePosition P&L en EUR:
//      realizedPnL = (exitPriceEur - entryPriceEur) * shares
//      Consistente con totalInvested en EUR.
// ============================================================

import type {
  TacticalEngineState, TacticalConfig, TacticalOpportunity,
  TacticalPosition, OpportunityStatus,
} from './types';
import {
  calcOptimalHorizon, calcTimingScore, calcDaysToBreakeven,
  calcStopLoss, calcTakeProfits, calcDynamicMaxDays,
  classifyAssetSpeed,
} from './tacticalSignals';
import { checkCorrelation, getSectorGroup } from './correlationManager';
import { toEur, getCachedFxRates } from './fxConverter';
import type { MarketRegime } from './marketRegimeFilter';

// ── Estado inicial ────────────────────────────────────────────
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

// ── Sanear estado (capital drift) ────────────────────────────
export function sanitizeState(state: TacticalEngineState): TacticalEngineState {
  // capitalUsed se recalcula desde posiciones abiertas para evitar drift
  // acumulado por errores de redondeo o recargas de estado stale
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

// ── Cargar / guardar estado en localStorage ──────────────────
const STORAGE_KEY = 'olympus_tactical_state_v4';

export function loadTacticalState(config: TacticalConfig): TacticalEngineState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initTacticalState(config);
    const parsed = JSON.parse(raw) as TacticalEngineState;
    // Sanear en carga para corregir cualquier drift acumulado
    return sanitizeState({ ...parsed, config });
  } catch {
    console.warn('[Tactical] Error al cargar estado — reiniciando');
    return initTacticalState(config);
  }
}

export function saveTacticalState(state: TacticalEngineState): void {
  try {
    const toSave = {
      ...state,
      // No serializar oportunidades (se recalculan en cada scan)
      opportunities: [],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (err) {
    console.error('[Tactical] Error al guardar estado:', err);
  }
}

// ── WARNING: código ELITE — no modificar sin entender el modelo ─
// Este archivo implementa 3 sistemas de sizing:
//   1. calcPositionSize      → Fixed % risk (estándar, config.riskPerTradePct)
//   2. calcKellyPositionSize → Kelly Criterion (óptimo, ajusta por winRate)
//   3. calcHalfKellySize     → Half-Kelly (conservador, recomendado para retail)
// ================================================================

// ── Tamaño de posición (en EUR, FX-aware) ────────────────────
// entryPriceEur y stopLossEur ya están en EUR (convertidos por screener)
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

  // Para activos <€1000: shares enteros. Para crypto/ETC de precio alto: decimales
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

// ── Kelly Criterion position sizing ───────────────────────────
// f* = (W × avgWin - (1-W) × avgLoss) / (avgWin × avgLoss)
// donde:
//   W       = win rate del sistema [0,1]
//   avgWin  = ganancia promedio / riesgo (R múltiplo)
//   avgLoss = pérdida promedio / riesgo (R múltiplo, normalizado a 1)
//
// Half-Kelly (recomendado para retail): f_half = f* × 0.5
// Full Kelly maximiza crecimiento pero drawdown puede ser >50%
export function calcKellyPositionSize(
  capitalAvailableEur: number,
  entryPriceEur:       number,
  stopLossEur:         number,
  winRate:             number,     // 0-100 (ej. 55 = 55% win rate)
  avgRiskReward:       number,     // R múltiplo (ej. 1.8)
  useHalfKelly:        boolean = true,
): { shares: number; capitalRisked: number; totalInvested: number; kellyPct: number } {
  const riskPerShareEur = entryPriceEur - stopLossEur;
  if (riskPerShareEur <= 0 || winRate <= 0 || capitalAvailableEur <= 0) {
    return { shares: 0, capitalRisked: 0, totalInvested: 0, kellyPct: 0 };
  }

  const W = winRate / 100;
  const avgWin = Math.max(avgRiskReward, 0.1);
  const avgLoss = 1.0;  // Normalizado: perder es 1R siempre

  // Fórmula de Kelly para tamaño de apuesta
  // f* = (W × avgWin - (1-W) × avgLoss) / (avgWin × avgLoss)
  // = (W/R - (1-W)/1) / (R/1 × 1)
  const numerator = W * avgWin - (1 - W) * avgLoss;
  const denominator = avgWin * avgLoss;
  const fullKelly = denominator > 0 ? Math.max(0, numerator / denominator) : 0;

  // Kelly limitado a [0, 0.25] — nunca apostar >25% en un solo trade
  const kellyPct = useHalfKelly
    ? Math.min(0.25, fullKelly * 0.5)
    : Math.min(0.25, fullKelly);

  // Warning si Kelly = 0 con winRate > 0 (setup válido pero no scalable)
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

// ── Half-Kelly wrapper (conveniencia) ─────────────────────────
export function calcHalfKellySize(
  capitalAvailableEur: number,
  entryPriceEur:       number,
  stopLossEur:         number,
  winRate:             number,
  avgRiskReward:       number,
): { shares: number; capitalRisked: number; totalInvested: number; kellyPct: number } {
  return calcKellyPositionSize(capitalAvailableEur, entryPriceEur, stopLossEur, winRate, avgRiskReward, true);
}

// ── Abrir posición ────────────────────────────────────────────
export function openPosition(
  state:       TacticalEngineState,
  opportunity: TacticalOpportunity,
): TacticalEngineState {
  const { config } = state;

  if (state.openPositions.length >= config.maxOpenPositions) {
    console.warn('[Tactical] Max open positions reached');
    return state;
  }

  // Verificar correlación ANTES de sizing (el fix del sectorGroup está en correlationManager)
  const corrCheck = checkCorrelation(opportunity, state.openPositions, config.maxOpenPositions);
  if (!corrCheck.allowed) {
    console.warn(`[Tactical] Correlación bloqueada: ${corrCheck.reason}`);
    return state;
  }

  // Precio de entrada en EUR (ya convertido por buildOpportunity en screener)
  // opportunity.entryPrice, stopLoss, takeProfit1, takeProfit2 están en EUR
  const entryPriceEur = opportunity.entryPrice;
  const stopLossEur   = opportunity.stopLoss;

  const { shares, capitalRisked, totalInvested } = calcPositionSize(
    state.capitalAvailable, entryPriceEur, stopLossEur, config,
  );

  if (shares === 0 || totalInvested > state.capitalAvailable) {
    console.warn('[Tactical] Capital insuficiente para abrir posición');
    return state;
  }

  // ATR en EUR (desde indicadores del asset, en divisa nativa → EUR)
  const fxRates   = getCachedFxRates();
  const currency  = opportunity.asset.currency;
  const rawAtr    = opportunity.asset.indicators?.atr14 ?? (opportunity.asset.price * 0.02);
  const atrEur    = toEur(rawAtr, currency, fxRates);

  const atrPct    = atrEur / Math.max(0.01, entryPriceEur);
  const speed     = classifyAssetSpeed(atrPct);
  const dynMax    = calcDynamicMaxDays(atrPct);

  // Horizonte óptimo con el modelo FPT correcto
  const optimalTP1 = calcOptimalHorizon(entryPriceEur, opportunity.takeProfit1, atrEur, opportunity.type);
  const optimalTP2 = calcOptimalHorizon(entryPriceEur, opportunity.takeProfit2, atrEur, opportunity.type);

  const maxDaysAllowed = Math.min(
    dynMax,
    Math.max(5, Math.round(optimalTP2.days * 1.2)),
  );

  const position: TacticalPosition = {
    id:             `pos-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ticker:         opportunity.asset.ticker,
    name:           opportunity.asset.name,
    type:           opportunity.type,
    currency:       currency,
    sectorGroup:    getSectorGroup(opportunity.asset.sector),  // FIX: sector real almacenado
    entryDate:      new Date().toISOString(),
    entryPrice:     opportunity.asset.price,       // En divisa nativa (para display)
    entryPriceEur,                                  // En EUR (para capital tracking)
    shares,
    capitalRisked,
    totalInvested,  // En EUR
    stopLoss:       opportunity.stopLoss,           // En EUR
    takeProfit1:    opportunity.takeProfit1,        // En EUR
    takeProfit2:    opportunity.takeProfit2,        // En EUR
    atrAtEntry:     atrEur,                         // FIX: ATR real en EUR — reemplaza 2% hardcoded
    status:         'OPEN',
    currentPrice:   opportunity.asset.price,        // En divisa nativa (actualizado por updatePositionPrices)
    exitDate:       null,
    exitPrice:      null,
    exitReason:     null,
    unrealizedPnL:    0,
    unrealizedPnLPct: 0,
    realizedPnL:      null,
    realizedPnLPct:   null,
    daysOpen:          0,
    maxDaysAllowed,
    expectedDaysToTP1: optimalTP1.days,
    expectedDaysToTP2: optimalTP2.days,
    daysToBreakeven:   optimalTP1.days,
    timingScore:       0,
    optimalDaysTP1:    optimalTP1.days,
    optimalDaysTP2:    optimalTP2.days,
    optimalProbTP1:    optimalTP1.prob,
  };

  const newState: TacticalEngineState = {
    ...state,
    openPositions:    [...state.openPositions, position],
    capitalUsed:      state.capitalUsed      + totalInvested,
    capitalAvailable: state.capitalAvailable - totalInvested,
  };

  return recalcMetrics(newState);
}

// ── Cerrar posición ───────────────────────────────────────────
export function closePosition(
  state:      TacticalEngineState,
  positionId: string,
  exitPrice:  number,   // En divisa nativa del activo
  reason:     OpportunityStatus,
): TacticalEngineState {
  const pos = state.openPositions.find(p => p.id === positionId);
  if (!pos) return state;

  const fxRates = getCachedFxRates();

  // FIX: convertir exitPrice a EUR para P&L correcto
  const exitPriceEur = toEur(exitPrice, pos.currency, fxRates);

  // P&L en EUR: (salida EUR - entrada EUR) * shares
  const realizedPnL    = (exitPriceEur - pos.entryPriceEur) * pos.shares;
  const realizedPnLPct = pos.entryPriceEur > 0
    ? (exitPriceEur / pos.entryPriceEur - 1) * 100
    : 0;

  const daysOpen = Math.round(
    (Date.now() - new Date(pos.entryDate).getTime()) / 86400000,
  );

  const closedPos: TacticalPosition = {
    ...pos,
    status:           reason,
    currentPrice:     exitPrice,
    exitDate:         new Date().toISOString(),
    exitPrice,
    exitReason:       reason,
    unrealizedPnL:    0,
    unrealizedPnLPct: 0,
    realizedPnL,
    realizedPnLPct,
    daysOpen,
  };

  // FIX: recuperar capital en EUR (exitPriceEur * shares)
  const recoveredCapital = exitPriceEur * pos.shares;

  const newState: TacticalEngineState = {
    ...state,
    openPositions:    state.openPositions.filter(p => p.id !== positionId),
    closedPositions:  [...state.closedPositions, closedPos],
    totalRealizedPnL: state.totalRealizedPnL + realizedPnL,
    capitalUsed:      Math.max(0, state.capitalUsed - pos.totalInvested),
    capitalAvailable: state.capitalAvailable + recoveredCapital,
  };

  return recalcMetrics(newState);
}

// ── Actualizar precios de posiciones abiertas ─────────────────
export function updatePositionPrices(
  state:  TacticalEngineState,
  prices: Record<string, number>,   // Precios en divisa nativa de cada activo
  marketRegime?: MarketRegime,      // NUEVO: para cierre de emergencia en CRASH
): TacticalEngineState {
  const fxRates = getCachedFxRates();
  let autoClose = { ...state };

  // ── EMERGENCY CRASH EXIT ────────────────────────────────────
  // Si el régimen es CRASH (VIX > 35), cerrar TODAS las posiciones
  // inmediatamente para preservar capital. Solo se salvan posiciones
  // BLOOD_IN_STREETS que están en ganancia (stop ya movido a breakeven).
  if (marketRegime === 'CRASH') {
    console.warn('[Tactical] ⚠️ CRASH DETECTED — cerrando todas las posiciones activas');
    for (const pos of state.openPositions) {
      // Exception: BLOOD_IN_STREETS positions already in profit keep running
      if (pos.type === 'BLOOD_IN_STREETS' && pos.unrealizedPnL > 0) {
        console.warn(`[Tactical] ${pos.ticker}: BLOOD_IN_STREETS con ganancia — manteniendo`);
        continue;
      }
      const price = prices[pos.ticker] ?? pos.currentPrice;
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_SL');
    }
    // Recargar state después de cierres
    return recalcMetrics(autoClose);
  }

  const updatedOpen = state.openPositions.map(pos => {
    const price        = prices[pos.ticker] ?? pos.currentPrice;
    const priceEur     = toEur(price, pos.currency, fxRates);

    // FIX: usar atrAtEntry (guardado en EUR al abrir) en lugar de 2% hardcodeado
    const atr = pos.atrAtEntry > 0
      ? pos.atrAtEntry
      : Math.max(0.01, pos.entryPriceEur * 0.02);

    const unrealized    = (priceEur - pos.entryPriceEur) * pos.shares;
    const unrealizedPct = pos.entryPriceEur > 0
      ? (priceEur / pos.entryPriceEur - 1) * 100
      : 0;

    const daysOpen = Math.round(
      (Date.now() - new Date(pos.entryDate).getTime()) / 86400000,
    );

    // ── Trailing stop dinámico + breakeven ─────────────────────
    // ETAPA 1: progreso > 50% → trailing stop activo (stop sube con precio)
    // ETAPA 2: progreso >= 100% (TP1 alcanzado) → stop a breakeven mínimo
    const newStopLoss = (() => {
      if (!state.config.trailingStop) return pos.stopLoss;
      const progressToTP1 = pos.takeProfit1 > pos.entryPriceEur
        ? (priceEur - pos.entryPriceEur) / (pos.takeProfit1 - pos.entryPriceEur)
        : 0;

      // ETAPA 0: stop original intacto
      if (progressToTP1 < 0.3) return pos.stopLoss;

      // ETAPA 1 (30-99%): trailing con 1.5×ATR bajo el precio actual
      if (progressToTP1 < 1.0) {
        const trailLevel = priceEur - atr * 1.5;
        return Math.max(pos.stopLoss, trailLevel);
      }

      // ETAPA 2 (TP1 alcanzado): stop a breakeven, nunca dejar perder
      // Si ya alcanzó TP1, movemos el stop a entryPrice + 0.5×ATR como mínimo
      const breakevenStop = pos.entryPriceEur + atr * 0.3;  // Ligeramente sobre breakeven
      return Math.max(pos.stopLoss, breakevenStop);
    })();

    // ── TP2 dinámico ──────────────────────────────────────────
    const newTP2 = (() => {
      const riskPerShare = pos.entryPriceEur - newStopLoss;
      if (riskPerShare <= 0) return pos.takeProfit2;
      return Math.max(pos.takeProfit2, pos.entryPriceEur + riskPerShare * 2.5);
    })();

    // ── Cierre automático ─────────────────────────────────────
    // Todos los niveles están en EUR — comparación homogénea
    if (priceEur <= newStopLoss) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_SL');
      return null;
    }
    if (priceEur >= pos.takeProfit1) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_TP');
      return null;
    }
    if (daysOpen >= pos.maxDaysAllowed) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_TIME');
      return null;
    }

    const daysToBreakeven = calcDaysToBreakeven(pos.entryPriceEur, priceEur, atr, pos.type);
    const timingScore     = calcTimingScore(daysOpen, pos.expectedDaysToTP1 ?? 10);

    // Recalcular horizonte óptimo con el ATR real almacenado
    const optTP1 = calcOptimalHorizon(pos.entryPriceEur, pos.takeProfit1, atr, pos.type);
    const optTP2 = calcOptimalHorizon(pos.entryPriceEur, newTP2,          atr, pos.type);

    return {
      ...pos,
      currentPrice:      price,
      unrealizedPnL:     unrealized,
      unrealizedPnLPct:  unrealizedPct,
      daysOpen,
      daysToBreakeven,
      timingScore,
      stopLoss:          newStopLoss,
      takeProfit2:       newTP2,
      optimalDaysTP1:    optTP1.days,
      optimalDaysTP2:    optTP2.days,
      optimalProbTP1:    optTP1.prob,
    };
  }).filter((p): p is TacticalPosition => p !== null);

  const totalUnrealized = updatedOpen.reduce((s, p) => s + p.unrealizedPnL, 0);

  return recalcMetrics({
    ...autoClose,
    openPositions:      updatedOpen,
    totalUnrealizedPnL: totalUnrealized,
  });
}

// ── Recalcular métricas ───────────────────────────────────────
function recalcMetrics(state: TacticalEngineState): TacticalEngineState {
  const closed = state.closedPositions;

  // Métricas básicas de trading
  const wins       = closed.filter(p => (p.realizedPnL ?? 0) > 0);
  const losses     = closed.filter(p => (p.realizedPnL ?? 0) <= 0);
  const winRate    = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const sumWins    = wins.reduce((s, p)   => s + (p.realizedPnL ?? 0), 0);
  const sumLosses  = Math.abs(losses.reduce((s, p) => s + (p.realizedPnL ?? 0), 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 99 : 1;

  // FIX CRÍTICO: maxDrawdown incluye posiciones abiertas
  // Antes: solo recorría closedPositions → drawdown = 0 durante posiciones activas
  // Ahora: construye curva de equity completa incluyendo el unrealizedPnL actual
  let peak    = state.config.tacticalCapitalEur;
  let maxDD   = 0;
  let running = peak;

  // 1. Recorrer operaciones cerradas en orden cronológico
  [...closed]
    .sort((a, b) =>
      new Date(a.exitDate ?? 0).getTime() - new Date(b.exitDate ?? 0).getTime(),
    )
    .forEach(p => {
      running += (p.realizedPnL ?? 0);
      if (running > peak) peak = running;
      const dd = peak > 0 ? (running - peak) / peak : 0;
      if (dd < maxDD) maxDD = dd;
    });

  // 2. Añadir el unrealizedPnL actual para drawdown en tiempo real
  const runningWithOpen = running + state.totalUnrealizedPnL;
  const ddWithOpen = peak > 0 ? (runningWithOpen - peak) / peak : 0;
  if (ddWithOpen < maxDD) maxDD = ddWithOpen;

  const avgRR = closed.length > 0
    ? closed.reduce((s, p) => {
        const rr = p.capitalRisked > 0 ? (p.realizedPnL ?? 0) / p.capitalRisked : 0;
        return s + rr;
      }, 0) / closed.length
    : 0;

  return {
    ...state,
    winRate,
    profitFactor,
    maxDrawdown: maxDD,
    avgRiskReward: avgRR,
  };
}

// ── Tipos de análisis de posición ────────────────────────────
export type PositionHealthStatus = 'STRONG' | 'HOLDING' | 'WEAKENING' | 'ABANDON';
export type PositionAction       = 'HOLD'   | 'SCALE_UP' | 'REDUCE_50' | 'EXIT_NOW';
export type PositionUrgency      = 'LOW'    | 'MEDIUM'   | 'HIGH'      | 'CRITICAL';

export interface PositionHealth {
  status:          PositionHealthStatus;
  action:          PositionAction;
  urgency:         PositionUrgency;
  detail:          string;
  reason:          string;   // Alias corto de detail para el dashboard
  confidence:      number;   // 0-100: certeza de la recomendación
  scaleUp?: {
    suggestedAddEur: number;
    triggerPrice:    number;
  };
  scaleUpAmount?:  number;   // Alias de scaleUp.suggestedAddEur para el dashboard
  suggestedExit?:  number;
}

export function analyzePositionHealth(
  pos:     TacticalPosition,
  atrEst?: number,
): PositionHealth {
  // FIX: usar atrAtEntry en lugar del fallback 2%
  const atr      = atrEst ?? pos.atrAtEntry ?? (pos.entryPriceEur * 0.02);
  const price    = pos.currentPrice;
  const priceEur = pos.entryPriceEur > 0 ? price * (pos.entryPriceEur / pos.entryPrice) : price;

  const distToSL = (priceEur - pos.stopLoss) / Math.max(0.01, atr);
  const distToTP = (pos.takeProfit1 - priceEur) / Math.max(0.01, atr);

  const timeRatio = pos.daysOpen / Math.max(pos.optimalDaysTP1, 1);
  const progress  = pos.takeProfit1 > pos.entryPriceEur
    ? (priceEur - pos.entryPriceEur) / (pos.takeProfit1 - pos.entryPriceEur)
    : 0;

  // ABANDON: varios criterios de abandono basados en horizonte FPT real
  if (
    pos.daysOpen >= pos.maxDaysAllowed ||
    (timeRatio > 1.5 && progress < 0.25) ||
    (timeRatio > 2.0 && progress <= 0)   ||
    distToSL < 0.5
  ) {
    const detail = distToSL < 0.5
      ? `SL a ${distToSL.toFixed(1)}×ATR — muy cerca. Salir inmediatamente.`
      : `${timeRatio.toFixed(1)}× tiempo óptimo, progreso ${(progress*100).toFixed(0)}%.`;
    const confidence = distToSL < 0.5 ? 95 : Math.min(95, 60 + timeRatio * 15);
    return {
      status:       'ABANDON',
      action:       'EXIT_NOW',
      urgency:      distToSL < 0.5 ? 'CRITICAL' : 'HIGH',
      detail,
      reason:       detail,
      confidence:   Math.round(confidence),
      suggestedExit: Math.max(pos.stopLoss * 1.005, priceEur - atr * 0.2),
    };
  }

  // STRONG: en tendencia con tiempo suficiente
  if (progress > 0.5 && timeRatio < 1.2 && distToSL > 2) {
    const suggestedAddEur = pos.totalInvested * 0.5;
    const detail = `${(progress*100).toFixed(0)}% del camino a TP1, SL a ${distToSL.toFixed(1)}×ATR. Posición sólida.`;
    const confidence = Math.min(90, 55 + progress * 50 + distToSL * 3);
    return {
      status:        'STRONG',
      action:        'SCALE_UP',
      urgency:       'LOW',
      detail,
      reason:        detail,
      confidence:    Math.round(confidence),
      scaleUp: {
        suggestedAddEur,
        triggerPrice: pos.takeProfit1 * 0.5 + pos.entryPriceEur * 0.5,
      },
      scaleUpAmount: suggestedAddEur,
    };
  }

  // WEAKENING: dentro del horizonte pero sin progresar
  if (timeRatio > 0.8 && progress < 0.1) {
    const detail = `${(timeRatio*100).toFixed(0)}% del tiempo óptimo consumido con solo ${(progress*100).toFixed(0)}% de progreso.`;
    const confidence = Math.min(85, 45 + timeRatio * 20);
    return {
      status:     'WEAKENING',
      action:     'REDUCE_50',
      urgency:    'MEDIUM',
      detail,
      reason:     detail,
      confidence: Math.round(confidence),
    };
  }

  const detail = `En plazo (${timeRatio.toFixed(1)}× horizonte), progreso ${(progress*100).toFixed(0)}%. Mantener.`;
  return {
    status:     'HOLDING',
    action:     'HOLD',
    urgency:    'LOW',
    detail,
    reason:     detail,
    confidence: Math.round(Math.max(40, 70 - timeRatio * 15)),
  };
}

// ── Resumen ejecutivo del estado táctico ─────────────────────
export interface TacticalSummary {
  capitalTotal:       number;
  capitalUsed:        number;
  capitalAvailable:   number;
  utilizationPct:     number;
  openCount:          number;
  closedCount:        number;
  totalRealizedPnL:   number;
  totalUnrealizedPnL: number;
  totalPnL:           number;
  winRate:            number;
  profitFactor:       number;
  maxDrawdown:        number;
  avgRiskReward:      number;
  bestClosed:         TacticalPosition | null;
  worstClosed:        TacticalPosition | null;
  // ── Aliases cortos para TacticalDashboard ──────────────────
  unrealizedPnL:      number;   // = totalUnrealizedPnL
  realizedPnL:        number;   // = totalRealizedPnL
  alertsToAction:     string[]; // posiciones que requieren acción urgente
}

export function getTacticalSummary(state: TacticalEngineState): TacticalSummary {
  const totalCapital = state.config.tacticalCapitalEur;

  // FIX: crear dos copias separadas para sort ascendente y descendente
  const byPnLDesc = [...state.closedPositions].sort(
    (a, b) => (b.realizedPnLPct ?? 0) - (a.realizedPnLPct ?? 0),
  );
  const byPnLAsc = [...state.closedPositions].sort(
    (a, b) => (a.realizedPnLPct ?? 0) - (b.realizedPnLPct ?? 0),
  );

  // Generar alertas de acción desde el análisis de salud de posiciones abiertas
  const alertsToAction: string[] = state.openPositions
    .map(pos => {
      const health = analyzePositionHealth(pos);
      if (health.urgency === 'CRITICAL') return `\u{1F534} ${pos.ticker}: ${health.detail}`;
      if (health.urgency === 'HIGH')     return `\u{1F7E0} ${pos.ticker}: ${health.detail}`;
      return null;
    })
    .filter((a): a is string => a !== null);

  return {
    capitalTotal:       totalCapital,
    capitalUsed:        state.capitalUsed,
    capitalAvailable:   state.capitalAvailable,
    utilizationPct:     totalCapital > 0 ? (state.capitalUsed / totalCapital) * 100 : 0,
    openCount:          state.openPositions.length,
    closedCount:        state.closedPositions.length,
    totalRealizedPnL:   state.totalRealizedPnL,
    totalUnrealizedPnL: state.totalUnrealizedPnL,
    totalPnL:           state.totalRealizedPnL + state.totalUnrealizedPnL,
    winRate:            state.winRate,
    profitFactor:       state.profitFactor,
    maxDrawdown:        state.maxDrawdown,
    avgRiskReward:      state.avgRiskReward,
    bestClosed:         byPnLDesc[0] ?? null,
    worstClosed:        byPnLAsc[0]  ?? null,
    // Aliases cortos para TacticalDashboard
    unrealizedPnL:      state.totalUnrealizedPnL,
    realizedPnL:        state.totalRealizedPnL,
    alertsToAction,
  };
}

// ── Compat aliases para TacticalDashboard ────────────────────
// calcExpectedDays: wrapper sobre calcOptimalHorizon que devuelve solo días.
// Firma: (entry, target, atr, type) → number
export function calcExpectedDays(
  entry:  number,
  target: number,
  atr:    number,
  type:   TacticalPosition['type'],
): number {
  return calcOptimalHorizon(entry, target, atr, type).days;
}

// calcTimingScore: re-exportado desde tacticalSignals para el dashboard
export { calcTimingScore };

// evaluatePositionHealth: alias de analyzePositionHealth (renombrado en v4)
export const evaluatePositionHealth = analyzePositionHealth;
