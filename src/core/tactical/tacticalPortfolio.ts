// ============================================================
// src/core/tactical/tacticalPortfolio.ts
// Gestión de posiciones tácticas — abre, cierra, trackea P&L
// ============================================================

import type {
  TacticalPosition, TacticalOpportunity,
  TacticalEngineState, TacticalConfig, OpportunityStatus
} from './types';
import { calcPositionSize } from './tacticalScreener';

const STORAGE_KEY = 'olympus_tactical_state';

// ── Persistencia ─────────────────────────────────────────────
export function saveTacticalState(state: TacticalEngineState): void {
  try {
    // No guardamos los datos completos de activos para ahorrar espacio
    const toSave = {
      ...state,
      opportunities: state.opportunities.map(o => ({
        ...o, asset: { ...o.asset, closes: [], volumes: [] }
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {}
}

export function loadTacticalState(): TacticalEngineState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TacticalEngineState;
  } catch {
    return null;
  }
}

export function initTacticalState(config: TacticalConfig): TacticalEngineState {
  return {
    config,
    opportunities:     [],
    openPositions:     [],
    closedPositions:   [],
    totalRealizedPnL:  0,
    totalUnrealizedPnL: 0,
    winRate:           0,
    avgRiskReward:     0,
    profitFactor:      0,
    maxDrawdown:       0,
    capitalUsed:       0,
    capitalAvailable:  config.tacticalCapitalEur,
    lastScreened:      null,
  };
}

// ── Abrir posición ───────────────────────────────────────────
export function openPosition(
  state:       TacticalEngineState,
  opportunity: TacticalOpportunity
): TacticalEngineState {
  const { config } = state;

  // Verificar que hay capital y no excedemos posiciones máximas
  if (state.openPositions.length >= config.maxOpenPositions) {
    console.warn('Max open positions reached');
    return state;
  }

  const { shares, capitalRisked, totalInvested } = calcPositionSize(
    state.capitalAvailable,
    opportunity.entryPrice,
    opportunity.stopLoss,
    config
  );

  if (shares === 0 || totalInvested > state.capitalAvailable) {
    console.warn('Insufficient capital');
    return state;
  }

  const position: TacticalPosition = {
    id:            `pos-${Date.now()}`,
    ticker:        opportunity.asset.ticker,
    name:          opportunity.asset.name,
    type:          opportunity.type,
    entryDate:     new Date().toISOString(),
    entryPrice:    opportunity.entryPrice,
    shares,
    capitalRisked,
    totalInvested,
    stopLoss:      opportunity.stopLoss,
    takeProfit1:   opportunity.takeProfit1,
    takeProfit2:   opportunity.takeProfit2,
    status:        'OPEN',
    currentPrice:  opportunity.entryPrice,
    exitDate:      null,
    exitPrice:     null,
    exitReason:    null,
    unrealizedPnL:    0,
    unrealizedPnLPct: 0,
    realizedPnL:      null,
    realizedPnLPct:   null,
    daysOpen:         0,
    maxDaysAllowed:   config.maxDaysPerTrade,
  };

  const newState: TacticalEngineState = {
    ...state,
    openPositions:   [...state.openPositions, position],
    capitalUsed:     state.capitalUsed + totalInvested,
    capitalAvailable: state.capitalAvailable - totalInvested,
  };

  return recalcMetrics(newState);
}

// ── Cerrar posición ──────────────────────────────────────────
export function closePosition(
  state:      TacticalEngineState,
  positionId: string,
  exitPrice:  number,
  reason:     OpportunityStatus
): TacticalEngineState {
  const pos = state.openPositions.find(p => p.id === positionId);
  if (!pos) return state;

  const realizedPnL    = (exitPrice - pos.entryPrice) * pos.shares;
  const realizedPnLPct = (exitPrice / pos.entryPrice - 1) * 100;
  const daysOpen       = Math.round(
    (Date.now() - new Date(pos.entryDate).getTime()) / 86400000
  );

  const closedPos: TacticalPosition = {
    ...pos,
    status:          reason,
    currentPrice:    exitPrice,
    exitDate:        new Date().toISOString(),
    exitPrice,
    exitReason:      reason,
    unrealizedPnL:   0,
    unrealizedPnLPct: 0,
    realizedPnL,
    realizedPnLPct,
    daysOpen,
  };

  const recoveredCapital = exitPrice * pos.shares;
  const newState: TacticalEngineState = {
    ...state,
    openPositions:   state.openPositions.filter(p => p.id !== positionId),
    closedPositions: [...state.closedPositions, closedPos],
    totalRealizedPnL: state.totalRealizedPnL + realizedPnL,
    capitalUsed:     state.capitalUsed - pos.totalInvested,
    capitalAvailable: state.capitalAvailable + recoveredCapital,
  };

  return recalcMetrics(newState);
}

// ── Actualizar precios de posiciones abiertas ────────────────
export function updatePositionPrices(
  state:  TacticalEngineState,
  prices: Record<string, number>
): TacticalEngineState {
  let autoClose = { ...state };

  const updatedOpen = state.openPositions.map(pos => {
    const price    = prices[pos.ticker] ?? pos.currentPrice;
    const unrealized = (price - pos.entryPrice) * pos.shares;
    const unrealizedPct = (price / pos.entryPrice - 1) * 100;
    const daysOpen   = Math.round(
      (Date.now() - new Date(pos.entryDate).getTime()) / 86400000
    );

    // Verificar stop loss automático
    if (price <= pos.stopLoss) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_SL');
      return null;
    }
    // Verificar take profit 1 automático
    if (price >= pos.takeProfit1) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_TP');
      return null;
    }
    // Verificar tiempo máximo
    if (daysOpen >= pos.maxDaysAllowed) {
      autoClose = closePosition(autoClose, pos.id, price, 'CLOSED_TIME');
      return null;
    }

    return {
      ...pos,
      currentPrice:      price,
      unrealizedPnL:     unrealized,
      unrealizedPnLPct:  unrealizedPct,
      daysOpen,
    };
  }).filter((p): p is TacticalPosition => p !== null);

  const totalUnrealized = updatedOpen.reduce((s, p) => s + p.unrealizedPnL, 0);

  return recalcMetrics({
    ...autoClose,
    openPositions:     updatedOpen,
    totalUnrealizedPnL: totalUnrealized,
  });
}

// ── Recalcular métricas ──────────────────────────────────────
function recalcMetrics(state: TacticalEngineState): TacticalEngineState {
  const closed = state.closedPositions;
  if (closed.length === 0) return state;

  const wins       = closed.filter(p => (p.realizedPnL ?? 0) > 0);
  const losses     = closed.filter(p => (p.realizedPnL ?? 0) <= 0);
  const winRate    = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const sumWins    = wins.reduce((s, p)   => s + (p.realizedPnL ?? 0), 0);
  const sumLosses  = Math.abs(losses.reduce((s, p) => s + (p.realizedPnL ?? 0), 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 99 : 1;

  // Max Drawdown del motor táctico
  let peak = state.config.tacticalCapitalEur;
  let maxDD = 0;
  let running = peak;
  [...closed].sort((a, b) =>
    new Date(a.exitDate ?? 0).getTime() - new Date(b.exitDate ?? 0).getTime()
  ).forEach(p => {
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

// ── Resumen para el dashboard ────────────────────────────────
export interface TacticalSummary {
  openCount:          number;
  capitalUsed:        number;
  capitalAvailable:   number;
  unrealizedPnL:      number;
  realizedPnL:        number;
  totalPnL:           number;
  winRate:            number;
  profitFactor:       number;
  bestPosition:       TacticalPosition | null;
  worstPosition:      TacticalPosition | null;
  alertsToAction:     string[];  // Posiciones que necesitan acción
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

  const allClosed  = state.closedPositions;
  const bestClosed = allClosed.sort((a, b) =>
    (b.realizedPnLPct ?? 0) - (a.realizedPnLPct ?? 0)
  )[0] ?? null;
  const worstClosed = allClosed.sort((a, b) =>
    (a.realizedPnLPct ?? 0) - (b.realizedPnLPct ?? 0)
  )[0] ?? null;

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
