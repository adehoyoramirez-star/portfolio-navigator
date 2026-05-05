// ════════════════════════════════════════════════════════════════════
// ARCHIVO: src/core/engine/positionManager.ts
// OLYMPUS X — Gestión dinámica de posiciones: daysOpen + SL/TP1/TP2
// ════════════════════════════════════════════════════════════════════
//
// PROBLEMAS QUE RESUELVE:
//
//  1. CONTADOR DE DÍAS ESTÁTICO
//     Bug: daysOpen se almacenaba como número y se congelaba en 0.
//     Fix: daysOpen se CALCULA desde openTimestamp. Nunca se almacena.
//
//  2. SL / TP1 / TP2 ESTÁTICOS
//     Fix: SL trailing ATR, TP1 estático (salida parcial 50%),
//     TP2 trailing que se activa solo tras TP1.

export type Direction    = 'LONG' | 'SHORT';
export type ExitReason   = 'SL' | 'TP1' | 'TP2' | 'MANUAL' | 'REGIME_CHANGE';
export type PositionStatus = 'OPEN' | 'PARTIAL' | 'CLOSED';

export interface Position {
  ticker:          string;
  direction:       Direction;
  regime:          string;
  openTimestamp:   number;         // Date.now() al abrir — base del daysOpen
  tp1Timestamp:    number | null;
  entry:           number;
  totalUnits:      number;
  remainingUnits:  number;
  sl:              number;
  slPeak:          number;         // precio más favorable visto (trailing)
  tp1:             number;         // ESTÁTICO — se fija al abrir, nunca cambia
  tp1Hit:          boolean;
  tp2:             number | null;  // trailing — se activa tras TP1
  tp2Peak:         number | null;
  atrAtOpen:       number;
  atrCurrent:      number;
  status:          PositionStatus;
  partialPnL:      number;
}

export interface OpenPositionParams {
  ticker:     string;
  entry:      number;
  atr:        number;
  regime:     string;
  direction:  Direction;
  totalUnits: number;
}

export interface ExitSignal {
  position:  Position;
  reason:    ExitReason;
  exitPrice: number;
  units:     number;
  pnl:       number;
  daysHeld:  number;
}

// ── MULTIPLICADORES POR RÉGIMEN ────────────────────────────────────
const REGIME_MULTIPLIERS: Record<string, {
  slAtrMult:  number;
  tp1AtrMult: number;
  tp2AtrMult: number;
}> = {
  EXPANSION:   { slAtrMult: 2.0, tp1AtrMult: 2.0, tp2AtrMult: 1.0 },
  CONTRACTION: { slAtrMult: 1.5, tp1AtrMult: 1.5, tp2AtrMult: 0.8 },
  CRISIS:      { slAtrMult: 1.2, tp1AtrMult: 1.2, tp2AtrMult: 0.6 },
};

// ── OPEN POSITION ─────────────────────────────────────────────────
export function openPosition(params: OpenPositionParams): Position {
  const { ticker, entry, atr, regime, direction, totalUnits } = params;
  const mult   = REGIME_MULTIPLIERS[regime] ?? REGIME_MULTIPLIERS['EXPANSION'];
  const atrPct = atr / entry;

  const sl = direction === 'LONG'
    ? entry * (1 - mult.slAtrMult * atrPct)
    : entry * (1 + mult.slAtrMult * atrPct);

  // TP1 — ESTÁTICO, se calcula aquí y NO se vuelve a tocar
  const tp1 = direction === 'LONG'
    ? entry * (1 + mult.tp1AtrMult * atrPct)
    : entry * (1 - mult.tp1AtrMult * atrPct);

  return {
    ticker, direction, regime,
    openTimestamp:  Date.now(),
    tp1Timestamp:   null,
    entry,
    totalUnits,
    remainingUnits: totalUnits,
    sl,
    slPeak:         entry,
    tp1,
    tp1Hit:         false,
    tp2:            null,   // se activa cuando TP1 se toca
    tp2Peak:        null,
    atrAtOpen:      atr,
    atrCurrent:     atr,
    status:         'OPEN',
    partialPnL:     0,
  };
}

// ── UPDATE POSITION (cada vela/tick) ──────────────────────────────
export function updatePosition(
  pos: Position,
  currentPrice: number,
  currentATR: number,
): Position {
  if (pos.status === 'CLOSED') return pos;

  const updated = { ...pos, atrCurrent: currentATR };
  const mult   = REGIME_MULTIPLIERS[pos.regime] ?? REGIME_MULTIPLIERS['EXPANSION'];
  const atrPct = currentATR / currentPrice;

  // TRAILING SL — solo mejora, nunca retrocede
  if (pos.direction === 'LONG' && currentPrice > pos.slPeak) {
    updated.slPeak = currentPrice;
    const newSL = currentPrice * (1 - mult.slAtrMult * atrPct);
    if (newSL > pos.sl) updated.sl = newSL;
  }
  if (pos.direction === 'SHORT' && currentPrice < pos.slPeak) {
    updated.slPeak = currentPrice;
    const newSL = currentPrice * (1 + mult.slAtrMult * atrPct);
    if (newSL < pos.sl) updated.sl = newSL;
  }

  // TRAILING TP2 — solo activo tras TP1
  if (pos.tp1Hit) {
    const newPeak = pos.direction === 'LONG'
      ? Math.max(pos.tp2Peak ?? currentPrice, currentPrice)
      : Math.min(pos.tp2Peak ?? currentPrice, currentPrice);
    updated.tp2Peak = newPeak;

    const tp2Trail = pos.direction === 'LONG'
      ? newPeak * (1 - mult.tp2AtrMult * atrPct)
      : newPeak * (1 + mult.tp2AtrMult * atrPct);

    updated.tp2 = pos.tp2 === null ? tp2Trail
      : pos.direction === 'LONG'
        ? Math.max(pos.tp2, tp2Trail)
        : Math.min(pos.tp2, tp2Trail);
  }

  return updated;
}

// ── CHECK EXITS ───────────────────────────────────────────────────
// TP1 cierra 50% de la posición. SL y TP2 cierran el resto.
export function checkExits(
  pos: Position,
  currentPrice: number,
): ExitSignal | null {
  if (pos.status === 'CLOSED') return null;
  const daysHeld = getDaysOpen(pos);

  // SL
  const slHit = pos.direction === 'LONG'
    ? currentPrice <= pos.sl
    : currentPrice >= pos.sl;
  if (slHit) return {
    position: pos, reason: 'SL', exitPrice: pos.sl,
    units: pos.remainingUnits,
    pnl: calcPnL(pos, pos.sl, pos.remainingUnits), daysHeld,
  };

  // TP1 (solo si no tocado aún)
  if (!pos.tp1Hit) {
    const tp1Hit = pos.direction === 'LONG'
      ? currentPrice >= pos.tp1
      : currentPrice <= pos.tp1;
    if (tp1Hit) {
      const tp1Units = Math.floor(pos.totalUnits * 0.50);
      return {
        position: pos, reason: 'TP1', exitPrice: pos.tp1,
        units: tp1Units,
        pnl: calcPnL(pos, pos.tp1, tp1Units), daysHeld,
      };
    }
  }

  // TP2 (solo si TP1 ejecutado y TP2 activo)
  if (pos.tp1Hit && pos.tp2 !== null) {
    const tp2Hit = pos.direction === 'LONG'
      ? currentPrice <= pos.tp2
      : currentPrice >= pos.tp2;
    if (tp2Hit) return {
      position: pos, reason: 'TP2', exitPrice: pos.tp2,
      units: pos.remainingUnits,
      pnl: calcPnL(pos, pos.tp2, pos.remainingUnits), daysHeld,
    };
  }

  return null;
}

// ── APLICAR SALIDA ────────────────────────────────────────────────
export function applyExit(pos: Position, exit: ExitSignal): Position {
  const updated = { ...pos };
  if (exit.reason === 'TP1') {
    updated.remainingUnits = pos.remainingUnits - exit.units;
    updated.tp1Hit         = true;
    updated.tp1Timestamp   = Date.now();
    updated.tp2Peak        = exit.exitPrice;
    updated.status         = 'PARTIAL';
    updated.partialPnL     = exit.pnl;
  } else {
    updated.remainingUnits = 0;
    updated.status         = 'CLOSED';
  }
  return updated;
}

// ── daysOpen — SIEMPRE DERIVADO, NUNCA ALMACENADO ─────────────────
export function getDaysOpen(pos: Position): number {
  return Math.floor((Date.now() - pos.openTimestamp) / 86_400_000);
}

export function getDaysInPartial(pos: Position): number | null {
  if (!pos.tp1Timestamp) return null;
  return Math.floor((Date.now() - pos.tp1Timestamp) / 86_400_000);
}

// ── RESUMEN PARA EL DASHBOARD ─────────────────────────────────────
export interface PositionSummary {
  ticker:        string;
  direction:     Direction;
  regime:        string;
  status:        PositionStatus;
  daysOpen:      number;          // calculado al momento, nunca frozen
  daysInPartial: number | null;
  entry:         number;
  currentPrice:  number;
  sl:            number;
  tp1:           number;
  tp1Hit:        boolean;
  tp2:           number | null;
  unrealizedPnL: number;
  partialPnL:    number;
  riskReward:    string;
}

export function getPositionSummary(
  pos: Position,
  currentPrice: number,
): PositionSummary {
  const unrealizedPnL = calcPnL(pos, currentPrice, pos.remainingUnits);
  const risk   = Math.abs(pos.entry - pos.sl);
  const reward = Math.abs(pos.tp1 - pos.entry);
  const rr     = risk > 0 ? (reward / risk).toFixed(1) : 'N/A';
  return {
    ticker: pos.ticker, direction: pos.direction,
    regime: pos.regime, status: pos.status,
    daysOpen:      getDaysOpen(pos),
    daysInPartial: getDaysInPartial(pos),
    entry: pos.entry, currentPrice,
    sl: pos.sl, tp1: pos.tp1, tp1Hit: pos.tp1Hit, tp2: pos.tp2,
    unrealizedPnL, partialPnL: pos.partialPnL,
    riskReward: `1:${rr}`,
  };
}

// ── CIERRE FORZADO POR CAMBIO DE RÉGIMEN ─────────────────────────
export function forceCloseByRegimeChange(
  pos: Position,
  currentPrice: number,
): ExitSignal {
  return {
    position: pos, reason: 'REGIME_CHANGE', exitPrice: currentPrice,
    units: pos.remainingUnits,
    pnl: calcPnL(pos, currentPrice, pos.remainingUnits),
    daysHeld: getDaysOpen(pos),
  };
}

// ── HELPER PRIVADO ────────────────────────────────────────────────
function calcPnL(pos: Position, exitPrice: number, units: number): number {
  const diff = pos.direction === 'LONG'
    ? exitPrice - pos.entry
    : pos.entry - exitPrice;
  return diff * units;
}