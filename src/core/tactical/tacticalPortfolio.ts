// ============================================================
// src/core/tactical/tacticalPortfolio.ts — v3 ELITE
// CORRECCIONES:
//   1. openPosition: eliminado Math.min(30, ...) que limitaba
//      maxDaysAllowed a 30 días, ignorando calcDynamicMaxDays.
//      Ahora maxDaysAllowed = optimalTP2.days × 1.2 SIN cap duro,
//      con clamp entre 5 y dynMax calculado desde ATR.
//   2. openPosition: calcula optimalDaysTP1/2 y optimalProbTP1
//      pasando `undefined` como maxDays → deja que calcOptimalHorizon
//      use su propio dynMax interno.
//   3. handleConfirmOpen (en Dashboard): los campos opcionales del
//      tipo TacticalPosition (optimalDaysTP1/2, optimalProbTP1)
//      ahora se calculan al confirmar la apertura manual.
//   4. updatePositionPrices: recalcula horizonte sin cap duro.
//   5. evaluatePositionHealth: sin cambios — ya era correcto.
// ============================================================

import type {
  TacticalPosition, TacticalOpportunity,
  TacticalEngineState, TacticalConfig, OpportunityStatus,
} from './types';
import { calcPositionSize } from './tacticalScreener';
import {
  calcOptimalHorizon, calcDynamicMaxDays, classifyAssetSpeed,
} from './tacticalSignals';

const STORAGE_KEY = 'olympus_tactical_state';

// ── Persistencia ─────────────────────────────────────────────
export function saveTacticalState(state: TacticalEngineState): void {
  try {
    const toSave = {
      ...state,
      opportunities: state.opportunities.map(o => ({
        ...o, asset: { ...o.asset, closes: [], volumes: [] },
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {}
}

export function loadTacticalState(): TacticalEngineState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as TacticalEngineState;

    // Sanear capitalUsed/capitalAvailable ante estados corruptos
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
        `[Tactical] Estado saneado: capitalAvailable ${state.capitalAvailable} → ${capitalAvailable}, ` +
        `capitalUsed ${state.capitalUsed} → ${capitalUsed}`,
      );
      return { ...state, capitalAvailable, capitalUsed };
    }

    return state;
  } catch {
    return null;
  }
}

export function initTacticalState(config: TacticalConfig): TacticalEngineState {
  return {
    config,
    opportunities:      [],
    openPositions:      [],
    closedPositions:    [],
    totalRealizedPnL:   0,
    totalUnrealizedPnL: 0,
    winRate:            0,
    avgRiskReward:      0,
    profitFactor:       0,
    maxDrawdown:        0,
    capitalUsed:        0,
    capitalAvailable:   config.tacticalCapitalEur,
    lastScreened:       null,
  };
}

// ── First Passage Time ────────────────────────────────────────
export function calcExpectedDays(
  entryPrice:  number,
  target:      number,
  atr:         number,
  signalType:  import('./types').OpportunityType,
): number {
  const dist = Math.abs(target - entryPrice);
  if (atr <= 0 || dist <= 0) return 10;
  let raw: number;

  if (signalType === 'MOMENTUM_BREAKOUT') {
    const drift = atr * 0.15;
    raw = (dist / drift) * 1.5;
    return Math.round(Math.min(25, Math.max(8, raw)));
  }
  if (signalType === 'SECTOR_ROTATION') {
    const drift = atr * 0.08;
    raw = (dist / drift) * 2.0;
    return Math.round(Math.min(30, Math.max(10, raw)));
  }

  // Difusión pura: BLOOD_IN_STREETS, MEAN_REVERSION, OVERSOLD_BOUNCE, EVENT_DRIVEN
  const sigma2 = atr * atr;
  const factor =
    signalType === 'BLOOD_IN_STREETS' ? 1.5
    : signalType === 'MEAN_REVERSION'  ? 2.0
    : 2.0;
  raw = (dist * dist / (2 * sigma2)) * factor;

  const limits: Record<string, [number, number]> = {
    BLOOD_IN_STREETS: [3, 7],
    MEAN_REVERSION:   [4, 10],
    OVERSOLD_BOUNCE:  [4, 12],
    EVENT_DRIVEN:     [3, 8],
  };
  const [mn, mx] = limits[signalType] ?? [4, 10];
  return Math.round(Math.min(mx, Math.max(mn, raw)));
}

export function calcTimingScore(daysOpen: number, expectedDays: number): number {
  if (expectedDays <= 0) return 0;
  return Math.min(100, Math.round((daysOpen / expectedDays) * 100));
}

export function calcDaysToBreakeven(
  entryPrice:   number,
  currentPrice: number,
  atr:          number,
  signalType:   import('./types').OpportunityType,
): number {
  if (currentPrice >= entryPrice) return 0;
  return calcExpectedDays(currentPrice, entryPrice, atr, signalType);
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

  const { shares, capitalRisked, totalInvested } = calcPositionSize(
    state.capitalAvailable,
    opportunity.entryPrice,
    opportunity.stopLoss,
    config,
  );

  if (shares === 0 || totalInvested > state.capitalAvailable) {
    console.warn('[Tactical] Insufficient capital');
    return state;
  }

  const atr = opportunity.asset.indicators?.atr14 ?? (opportunity.entryPrice * 0.02);
  const atrPct = atr / Math.max(0.01, opportunity.entryPrice);

  const expectedDaysToTP1 = calcExpectedDays(
    opportunity.entryPrice, opportunity.takeProfit1, atr, opportunity.type,
  );
  const expectedDaysToTP2 = calcExpectedDays(
    opportunity.entryPrice, opportunity.takeProfit2, atr, opportunity.type,
  );

  // CORRECCIÓN: NO pasar maxDays → calcOptimalHorizon usa dynMax desde ATR
  // Antes: calcOptimalHorizon(..., atr) llamado con maxDays implícito fijo=20
  // Ahora: maxDays=undefined → dynMax se calcula desde atrPct dentro de la función
  const optimalTP1 = calcOptimalHorizon(opportunity.entryPrice, opportunity.takeProfit1, atr);
  const optimalTP2 = calcOptimalHorizon(opportunity.entryPrice, opportunity.takeProfit2, atr);

  // CORRECCIÓN: maxDaysAllowed = horizonte óptimo TP2 ×1.2
  // SIN Math.min(30, ...) que ignoraba activos SLOW (dynMax=75) y MEDIUM (dynMax=40)
  const dynMax = calcDynamicMaxDays(atrPct);
  const maxDaysAllowed = Math.min(
    dynMax,                                              // techo = horizonte del activo
    Math.max(5, Math.round(optimalTP2.days * 1.2)),     // suelo = 5 días
  );

  const position: TacticalPosition = {
    id:             `pos-${Date.now()}`,
    ticker:         opportunity.asset.ticker,
    name:           opportunity.asset.name,
    type:           opportunity.type,
    entryDate:      new Date().toISOString(),
    entryPrice:     opportunity.entryPrice,
    shares,
    capitalRisked,
    totalInvested,
    stopLoss:       opportunity.stopLoss,
    takeProfit1:    opportunity.takeProfit1,
    takeProfit2:    opportunity.takeProfit2,
    status:         'OPEN',
    currentPrice:   opportunity.entryPrice,
    exitDate:       null,
    exitPrice:      null,
    exitReason:     null,
    unrealizedPnL:    0,
    unrealizedPnLPct: 0,
    realizedPnL:      null,
    realizedPnLPct:   null,
    daysOpen:          0,
    maxDaysAllowed,
    expectedDaysToTP1,
    expectedDaysToTP2,
    daysToBreakeven:   expectedDaysToTP1,
    timingScore:       0,
    // Horizonte óptimo dinámico (CORRECCIÓN: calculado sin cap duro)
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
  exitPrice:  number,
  reason:     OpportunityStatus,
): TacticalEngineState {
  const pos = state.openPositions.find(p => p.id === positionId);
  if (!pos) return state;

  const realizedPnL    = (exitPrice - pos.entryPrice) * pos.shares;
  const realizedPnLPct = (exitPrice / pos.entryPrice - 1) * 100;
  const daysOpen       = Math.round(
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

  const recoveredCapital = exitPrice * pos.shares;
  const newState: TacticalEngineState = {
    ...state,
    openPositions:    state.openPositions.filter(p => p.id !== positionId),
    closedPositions:  [...state.closedPositions, closedPos],
    totalRealizedPnL: state.totalRealizedPnL + realizedPnL,
    capitalUsed:      state.capitalUsed      - pos.totalInvested,
    capitalAvailable: state.capitalAvailable + recoveredCapital,
  };

  return recalcMetrics(newState);
}

// ── Actualizar precios ────────────────────────────────────────
export function updatePositionPrices(
  state:  TacticalEngineState,
  prices: Record<string, number>,
): TacticalEngineState {
  let autoClose = { ...state };

  const updatedOpen = state.openPositions.map(pos => {
    const price          = prices[pos.ticker] ?? pos.currentPrice;
    const unrealized     = (price - pos.entryPrice) * pos.shares;
    const unrealizedPct  = (price / pos.entryPrice - 1) * 100;
    const daysOpen       = Math.round(
      (Date.now() - new Date(pos.entryDate).getTime()) / 86400000,
    );

    if (price <= pos.stopLoss) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_SL');
      return null;
    }
    if (price >= pos.takeProfit1) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_TP');
      return null;
    }
    if (daysOpen >= pos.maxDaysAllowed) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_TIME');
      return null;
    }

    const atr = Math.max(0.01, pos.entryPrice * 0.02);
    const daysToBreakeven = calcDaysToBreakeven(pos.entryPrice, price, atr, pos.type);
    const timingScore     = calcTimingScore(daysOpen, pos.expectedDaysToTP1 ?? 10);

    // CORRECCIÓN: recalcular horizonte SIN cap duro (undefined → dynMax interno)
    const optTP1 = calcOptimalHorizon(pos.entryPrice, pos.takeProfit1, atr);
    const optTP2 = calcOptimalHorizon(pos.entryPrice, pos.takeProfit2, atr);

    return {
      ...pos,
      currentPrice:      price,
      unrealizedPnL:     unrealized,
      unrealizedPnLPct:  unrealizedPct,
      daysOpen,
      daysToBreakeven,
      timingScore,
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

// ── Métricas ──────────────────────────────────────────────────
function recalcMetrics(state: TacticalEngineState): TacticalEngineState {
  const closed = state.closedPositions;
  if (closed.length === 0) return state;

  const wins       = closed.filter(p => (p.realizedPnL ?? 0) > 0);
  const losses     = closed.filter(p => (p.realizedPnL ?? 0) <= 0);
  const winRate    = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const sumWins    = wins.reduce((s, p)   => s + (p.realizedPnL ?? 0), 0);
  const sumLosses  = Math.abs(losses.reduce((s, p) => s + (p.realizedPnL ?? 0), 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 99 : 1;

  let peak    = state.config.tacticalCapitalEur;
  let maxDD   = 0;
  let running = peak;
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

  return {
    ...state,
    winRate,
    profitFactor,
    maxDrawdown: maxDD,
    avgRiskReward: closed.length > 0
      ? closed.reduce((s, p) => {
          const rr = p.capitalRisked > 0
            ? (p.realizedPnL ?? 0) / p.capitalRisked : 0;
          return s + rr;
        }, 0) / closed.length
      : 0,
  };
}

// ════════════════════════════════════════════════════════════
// MOTOR DE SALUD DE POSICIÓN — NIVEL INSTITUCIONAL
// Evalúa en tiempo real si una posición sigue siendo válida
// y qué acción tomar ANTES de llegar al stop.
// ════════════════════════════════════════════════════════════

export type PositionHealthStatus = 'STRONG' | 'HOLDING' | 'WEAKENING' | 'ABANDON';
export type PositionAction       = 'HOLD'   | 'SCALE_UP' | 'REDUCE_50' | 'EXIT_NOW';
export type PositionUrgency      = 'LOW'    | 'MEDIUM'   | 'HIGH'      | 'CRITICAL';

export interface PositionHealth {
  status:        PositionHealthStatus;
  action:        PositionAction;
  reason:        string;
  detail:        string;
  confidence:    number;    // 0-100
  urgency:       PositionUrgency;
  suggestedExit?: number;  // Precio sugerido de salida anticipada
  scaleUpAmount?: number;  // € adicionales si SCALE_UP
}

export function evaluatePositionHealth(
  pos:     TacticalPosition,
  atrEst?: number,
): PositionHealth {
  const atr      = atrEst ?? pos.entryPrice * 0.02;
  const range    = pos.takeProfit1 - pos.entryPrice;
  const progress = range > 0 ? (pos.currentPrice - pos.entryPrice) / range : 0;
  const distToSL = (pos.currentPrice - pos.stopLoss) / Math.max(0.01, atr);
  const distToTP1pct = pos.takeProfit1 > 0
    ? ((pos.takeProfit1 - pos.currentPrice) / pos.currentPrice) * 100 : 0;

  const optDays    = pos.optimalDaysTP1 > 0 ? pos.optimalDaysTP1 : (pos.expectedDaysToTP1 ?? 10);
  const timeRatio  = optDays > 0 ? pos.daysOpen / optDays : 0;
  const timeEfficiency = timeRatio > 0.05 ? progress / timeRatio : null;

  // ── REGLA 1: Cerca del TP1 → REDUCE_50 ─────────────────────
  if (progress >= 0.85) {
    return {
      status:     'STRONG',
      action:     'REDUCE_50',
      reason:     `TP1 al ${((1 - progress) * 100).toFixed(0)}% — cerrar 50% y subir stop a entrada`,
      detail:     `Precio ${pos.currentPrice.toFixed(2)} está al ${(progress * 100).toFixed(0)}% del camino a TP1 (${pos.takeProfit1.toFixed(2)})`,
      confidence: 92,
      urgency:    'HIGH',
      suggestedExit: pos.takeProfit1,
    };
  }

  // ── REGLA 2: Tiempo muy superado + poco progreso → EXIT_NOW ─
  if (timeRatio > 1.8 && progress < 0.25 && pos.daysOpen > 4) {
    return {
      status:     'ABANDON',
      action:     'EXIT_NOW',
      reason:     `Tiempo agotado: día ${pos.daysOpen} (${(timeRatio * 100).toFixed(0)}% del horizonte óptimo) con solo ${(progress * 100).toFixed(0)}% de progreso`,
      detail:     `La tesis no se materializa en plazo. Capital mejor asignado a otra oportunidad.`,
      confidence: 84,
      urgency:    'HIGH',
      suggestedExit: pos.currentPrice,
    };
  }

  // ── REGLA 3: Muy cerca del stop con tiempo consumido → EXIT_NOW
  if (distToSL < 0.5 && timeRatio > 0.4) {
    const urgency: PositionUrgency = distToSL < 0.25 ? 'CRITICAL' : 'HIGH';
    return {
      status:     'ABANDON',
      action:     'EXIT_NOW',
      reason:     `A ${distToSL.toFixed(1)} ATRs del stop loss con ${pos.daysOpen} días abierta`,
      detail:     `SL en €${pos.stopLoss.toFixed(2)} — precio actual €${pos.currentPrice.toFixed(2)}. Salir antes de que el stop salte para ahorrar spread.`,
      confidence: 88,
      urgency,
      suggestedExit: Math.max(pos.stopLoss * 1.005, pos.currentPrice - atr * 0.2),
    };
  }

  // ── REGLA 4: Muy eficiente y aún temprano → SCALE_UP ───────
  if (
    timeEfficiency !== null &&
    timeEfficiency > 1.4 &&
    timeRatio < 0.50 &&
    progress > 0.15
  ) {
    return {
      status:     'STRONG',
      action:     'SCALE_UP',
      reason:     `Operación ${(timeEfficiency * 100).toFixed(0)}% más rápida de lo esperado — ampliar posición`,
      detail:     `Progreso ${(progress * 100).toFixed(0)}% en solo ${(timeRatio * 100).toFixed(0)}% del tiempo. La tesis se confirma.`,
      confidence: Math.min(90, 60 + progress * 50),
      urgency:    'MEDIUM',
      scaleUpAmount: pos.totalInvested * 0.5,
    };
  }

  // ── REGLA 5: Ineficiente y >50% del tiempo → WEAKENING ─────
  if (
    timeEfficiency !== null &&
    timeEfficiency < 0.35 &&
    timeRatio > 0.50
  ) {
    return {
      status:     'WEAKENING',
      action:     'HOLD',
      reason:     `Progreso lento: ${(progress * 100).toFixed(0)}% del objetivo en ${(timeRatio * 100).toFixed(0)}% del tiempo`,
      detail:     `Eficiencia temporal: ${(timeEfficiency * 100).toFixed(0)}% de lo esperado. Si no acelera en 2 días, considerar salida.`,
      confidence: 65,
      urgency:    'MEDIUM',
    };
  }

  // ── REGLA 6: En negativo y perdiendo tiempo → WEAKENING/EXIT
  if (progress < -0.15 && timeRatio > 0.30) {
    const shouldExit = pos.daysOpen > optDays * 0.7;
    return {
      status:     'WEAKENING',
      action:     shouldExit ? 'EXIT_NOW' : 'HOLD',
      reason:     `Posición en rojo (${(progress * 100).toFixed(0)}%) con ${(timeRatio * 100).toFixed(0)}% del tiempo consumido`,
      detail:     `El activo se mueve en contra. SL a €${pos.stopLoss.toFixed(2)} es la protección final.`,
      confidence: 70,
      urgency:    timeRatio > 0.7 ? 'HIGH' : 'MEDIUM',
      suggestedExit: shouldExit ? pos.currentPrice : undefined,
    };
  }

  // ── Default: mantener ────────────────────────────────────────
  const isAhead = progress > 0.4 && timeRatio < 0.5;
  return {
    status:     isAhead ? 'STRONG' : 'HOLDING',
    action:     'HOLD',
    reason:     isAhead
      ? `Bien encaminada: ${(progress * 100).toFixed(0)}% del objetivo en plazo`
      : `Día ${pos.daysOpen} de ${optDays} esperados — progreso normal`,
    detail:     `Progreso ${(progress * 100).toFixed(0)}% · Dist. stop ${distToSL.toFixed(1)}×ATR · TP1 a ${distToTP1pct.toFixed(1)}% del precio`,
    confidence: 55,
    urgency:    'LOW',
  };
}

// ── Resumen para el dashboard ─────────────────────────────────
export interface TacticalSummary {
  openCount:        number;
  capitalUsed:      number;
  capitalAvailable: number;
  unrealizedPnL:    number;
  realizedPnL:      number;
  totalPnL:         number;
  winRate:          number;
  profitFactor:     number;
  bestPosition:     TacticalPosition | null;
  worstPosition:    TacticalPosition | null;
  alertsToAction:   string[];
}

export function getTacticalSummary(state: TacticalEngineState): TacticalSummary {
  const alerts: string[] = [];

  state.openPositions.forEach(p => {
    if (p.currentPrice <= p.stopLoss * 1.02) {
      alerts.push(`⚠️ ${p.ticker} cerca del stop loss (€${p.stopLoss.toFixed(2)})`);
    }
    if (p.daysOpen >= p.maxDaysAllowed - 1) {
      alerts.push(`⏰ ${p.ticker} expira mañana — revisar y cerrar`);
    }
    if (p.currentPrice >= p.takeProfit1 * 0.98) {
      alerts.push(`🎯 ${p.ticker} cerca del TP1 — considerar venta parcial`);
    }
  });

  const allClosed   = [...state.closedPositions];
  const bestClosed  = allClosed.sort((a, b) =>
    (b.realizedPnLPct ?? 0) - (a.realizedPnLPct ?? 0))[0] ?? null;
  const worstClosed = allClosed.sort((a, b) =>
    (a.realizedPnLPct ?? 0) - (b.realizedPnLPct ?? 0))[0] ?? null;

  return {
    openCount:        state.openPositions.length,
    capitalUsed:      state.capitalUsed,
    capitalAvailable: state.capitalAvailable,
    unrealizedPnL:    state.totalUnrealizedPnL,
    realizedPnL:      state.totalRealizedPnL,
    totalPnL:         state.totalRealizedPnL + state.totalUnrealizedPnL,
    winRate:          state.winRate,
    profitFactor:     state.profitFactor,
    bestPosition:     bestClosed,
    worstPosition:    worstClosed,
    alertsToAction:   alerts,
  };
}
