// ============================================================
// src/core/tactical/tacticalSignals.ts — v7 IMPROVED
//
// MEJORAS v7 (Antonio's SMCI Strategy Integration):
//
//   1. ENTRY CONFIRMATION (RSI Pullback)
//      - Nueva función: checkEntryConfirmation()
//      - No entra si RSI(2) > 75 (espera agotamiento)
//      - Entrada confirmada cuando RSI(2) está 60-75 (pullback en curso)
//      - Devuelve { confirmed: bool, rsi2Current: number, nextAction: string }
//      - CASO SMCI: RSI(2)=99.8 → NO ENTRA, espera a 60-75
//
//   2. DYNAMIC STOP-LOSS (MA50 + 1×ATR)
//      - Nueva función: calcDynamicStopLoss()
//      - Stop = MA50 + 1×ATR en lugar de entry - ATR*mult
//      - Más tight, mejor para breakouts + tendencias
//      - Reduce riesgo real manteniendo trade valido
//
//   3. EARNINGS AUTO-CLOSE DETECTION
//      - Función mejorada: getUpcomingEvent() ahora devuelve daysToEvent
//      - Nueva función: shouldAutoCloseBeforeEarnings()
//      - Cierra 5 días ANTES de earnings (HIGH impact)
//      - Dashboard alertará 10 días antes
//      - Aplica límite de pérdida -2% o profit
//
// COMPATIBILIDAD:
//   - Toda la API existente se mantiene
//   - Las funciones nuevas son aditivas
//   - calcStopLoss() clásico disponible como fallback
// ============================================================

import type {
  TechnicalIndicators, TacticalSignal, TrendDirection,
  OpportunityType, SignalStrength
} from './types';

// ════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES SEGURAS
// ════════════════════════════════════════════════════════════

function sma(arr: number[], n: number): number {
  if (!arr || arr.length === 0) return 0;
  const slice = arr.slice(-n);
  if (slice.length < n) return arr[arr.length - 1] ?? 0;
  let sum = 0;
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    if (typeof v === 'number' && isFinite(v)) sum += v;
  }
  return sum / n;
}

function stdev(arr: number[]): number {
  if (!arr || arr.length < 2) return 0;
  const valid = arr.filter(v => typeof v === 'number' && isFinite(v));
  if (valid.length < 2) return 0;
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - m) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

function ema(arr: number[], n: number): number {
  if (!arr || arr.length === 0) return 0;
  if (arr.length < n) return arr[arr.length - 1] ?? 0;
  const k = 2 / (n + 1);
  let e = sma(arr.slice(0, n), n);
  for (let i = n; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === 'number' && isFinite(v)) e = v * k + e * (1 - k);
  }
  return e;
}

// ── Normal CDF (Abramowitz & Stegun) ─────────────────────────
function normCDF(z: number): number {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x / 2.0);
  return 0.5 * (1.0 + sign * y);
}

// ── First Passage Time CDF (Inverse Gaussian) ─────────────────
function fptCDF(t: number, d: number, mu: number, sigma: number): number {
  if (t <= 0 || d <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(t);
  const z1    = (mu * t - d) / (sigma * sqrtT);
  const z2    = -(mu * t + d) / (sigma * sqrtT);
  const theta = Math.min(2.0 * mu * d / (sigma * sigma), 700);
  const val   = normCDF(z1) + Math.exp(theta) * normCDF(z2);
  return Math.max(0, Math.min(1, val));
}

// ── Pesos por tipo de señal (señales de capitulación pesan más) ─
export const SIGNAL_WEIGHTS: Record<OpportunityType, number> = {
  BLOOD_IN_STREETS:  1.0,
  MOMENTUM_BREAKOUT: 0.8,
  MEAN_REVERSION:    0.7,
  OVERSOLD_BOUNCE:   0.5,
  SECTOR_ROTATION:   0.4,
  EVENT_DRIVEN:      0.2,
};

// ── Drift diario calibrado por tipo de señal ─────────────────
const SIGNAL_DRIFT: Record<OpportunityType, number> = {
  MOMENTUM_BREAKOUT: 0.15,
  BLOOD_IN_STREETS:  0.12,
  MEAN_REVERSION:    0.09,
  OVERSOLD_BOUNCE:   0.08,
  SECTOR_ROTATION:   0.06,
  EVENT_DRIVEN:      0.10,
};

// ════════════════════════════════════════════════════════════
// CORPORATE EVENTS + ECONOMIC CALENDAR DATABASE (v8)
// ════════════════════════════════════════════════════════════

export interface CorporateEvent {
  ticker:      string;
  type:        'EARNINGS' | 'SPLIT' | 'SPINOFF' | 'BUYBACK' | 'IPO_LOCKUP' | 'REGULATORY' | 'MACRO';
  date:        string;  // ISO date (YYYY-MM-DD)
  impact:      'HIGH' | 'MEDIUM' | 'LOW';
  detail:      string;
  autoCloseDaysAhead?: number;  // default 5 para EARNINGS HIGH
}

export const UPCOMING_EVENTS: CorporateEvent[] = [
  // ── EARNINGS — Mega-caps ──────────────────────────────────
  { ticker: 'AAPL',  type: 'EARNINGS', date: '2026-07-25', impact: 'HIGH',   detail: 'Apple Q3 2026 earnings', autoCloseDaysAhead: 5 },
  { ticker: 'MSFT',  type: 'EARNINGS', date: '2026-07-18', impact: 'HIGH',   detail: 'Microsoft Q4 2026 earnings', autoCloseDaysAhead: 5 },
  { ticker: 'NVDA',  type: 'EARNINGS', date: '2026-08-22', impact: 'HIGH',   detail: 'NVIDIA Q2 2026 earnings', autoCloseDaysAhead: 5 },
  { ticker: 'TSLA',  type: 'EARNINGS', date: '2026-07-16', impact: 'HIGH',   detail: 'Tesla Q2 2026 earnings', autoCloseDaysAhead: 5 },
  { ticker: 'AMZN',  type: 'EARNINGS', date: '2026-07-30', impact: 'HIGH',   detail: 'Amazon Q2 2026 earnings', autoCloseDaysAhead: 5 },
  { ticker: 'META',  type: 'EARNINGS', date: '2026-07-24', impact: 'HIGH',   detail: 'Meta Q2 2026 earnings', autoCloseDaysAhead: 5 },
  { ticker: 'GOOGL', type: 'EARNINGS', date: '2026-07-23', impact: 'MEDIUM', detail: 'Alphabet Q2 2026 earnings', autoCloseDaysAhead: 3 },
  { ticker: 'SMCI',  type: 'EARNINGS', date: '2026-08-11', impact: 'HIGH',   detail: 'Super Micro Q3 2026 earnings', autoCloseDaysAhead: 5 },
  
  // ── EVENTOS REGULATORIOS ───────────────────────────────────
  { ticker: 'COIN',  type: 'REGULATORY', date: '2026-09-15', impact: 'HIGH',   detail: 'MiCA crypto regulation final implementation EU' },
  { ticker: 'MSTR',  type: 'BUYBACK',    date: '2026-08-01', impact: 'MEDIUM', detail: 'MicroStrategy ATM share issuance update' },

  // ════════════════════════════════════════════════════════════
  // CALENDARIO ECONÓMICO 2026 — 100% gratis, hardcodeado
  // Fuentes: FED calendar, BLS (Bureau of Labor Statistics)
  // Marcador macro: '__MACRO__' — afecta a TODOS los activos
  // ════════════════════════════════════════════════════════════

  // ── FOMC Rate Decisions (8 reuniones/año) ───────────────────
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-28', impact: 'HIGH',   detail: 'FOMC rate decision (Jul 28-29)' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-09-16', impact: 'HIGH',   detail: 'FOMC rate decision (Sep 16-17)' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-04', impact: 'HIGH',   detail: 'FOMC rate decision (Nov 4-5)' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-12-16', impact: 'HIGH',   detail: 'FOMC rate decision (Dec 16-17)' },

  // ── CPI (Consumer Price Index) — mensual ────────────────────
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-15', impact: 'HIGH',   detail: 'US CPI Jun 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-08-12', impact: 'HIGH',   detail: 'US CPI Jul 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-09-16', impact: 'HIGH',   detail: 'US CPI Aug 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-10-14', impact: 'HIGH',   detail: 'US CPI Sep 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-13', impact: 'HIGH',   detail: 'US CPI Oct 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-12-10', impact: 'HIGH',   detail: 'US CPI Nov 2026' },

  // ── NFP (Non-Farm Payrolls / Empleo USA) — mensual ──────────
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-02', impact: 'HIGH',   detail: 'US Jobs Report (NFP) Jun 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-08-05', impact: 'HIGH',   detail: 'US Jobs Report (NFP) Jul 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-09-04', impact: 'HIGH',   detail: 'US Jobs Report (NFP) Aug 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-10-07', impact: 'HIGH',   detail: 'US Jobs Report (NFP) Sep 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-06', impact: 'HIGH',   detail: 'US Jobs Report (NFP) Oct 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-12-04', impact: 'HIGH',   detail: 'US Jobs Report (NFP) Nov 2026' },

  // ── PPI (Producer Price Index) — mensual ────────────────────
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-14', impact: 'MEDIUM', detail: 'US PPI Jun 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-08-11', impact: 'MEDIUM', detail: 'US PPI Jul 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-09-15', impact: 'MEDIUM', detail: 'US PPI Aug 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-10-14', impact: 'MEDIUM', detail: 'US PPI Sep 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-13', impact: 'MEDIUM', detail: 'US PPI Oct 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-12-10', impact: 'MEDIUM', detail: 'US PPI Nov 2026' },

  // ── GDP (advance/revised) ───────────────────────────────────
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-30', impact: 'HIGH',   detail: 'US GDP Q2 2026 (advance)' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-08-27', impact: 'HIGH',   detail: 'US GDP Q2 2026 (revised)' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-10-29', impact: 'HIGH',   detail: 'US GDP Q3 2026 (advance)' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-26', impact: 'HIGH',   detail: 'US GDP Q3 2026 (revised)' },

  // ── ISM Manufacturing & Services PMI ────────────────────────
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-01', impact: 'MEDIUM', detail: 'ISM Manufacturing PMI Jun 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-07-06', impact: 'MEDIUM', detail: 'ISM Services PMI Jun 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-08-03', impact: 'MEDIUM', detail: 'ISM Manufacturing PMI Jul 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-08-05', impact: 'MEDIUM', detail: 'ISM Services PMI Jul 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-09-01', impact: 'MEDIUM', detail: 'ISM Manufacturing PMI Aug 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-09-04', impact: 'MEDIUM', detail: 'ISM Services PMI Aug 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-10-01', impact: 'MEDIUM', detail: 'ISM Manufacturing PMI Sep 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-10-06', impact: 'MEDIUM', detail: 'ISM Services PMI Sep 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-02', impact: 'MEDIUM', detail: 'ISM Manufacturing PMI Oct 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-11-04', impact: 'MEDIUM', detail: 'ISM Services PMI Oct 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-12-01', impact: 'MEDIUM', detail: 'ISM Manufacturing PMI Nov 2026' },
  { ticker: '__MACRO__', type: 'MACRO', date: '2026-12-03', impact: 'MEDIUM', detail: 'ISM Services PMI Nov 2026' },
];

// ════════════════════════════════════════════════════════════
// EVENT DETECTION FUNCTIONS (v7 IMPROVED)
// ════════════════════════════════════════════════════════════

export interface UpcomingEventInfo {
  event: CorporateEvent | null;
  daysToEvent: number;
  shouldAutoClose: boolean;
  closeDaysAhead: number;
}

/**
 * Busca eventos corporativos cercanos.
 * Devuelve info completa incluyendo días al evento.
 */
export function getUpcomingEventInfo(ticker: string, daysAhead: number = 14): UpcomingEventInfo {
  const now = Date.now();
  const limit = now + daysAhead * 86400000;
  
  for (const ev of UPCOMING_EVENTS) {
    if (ev.ticker !== ticker) continue;
    const evDate = new Date(ev.date).getTime();
    if (evDate >= now && evDate <= limit) {
      const daysToEv = Math.round((evDate - now) / 86400000);
      const closeDays = ev.autoCloseDaysAhead ?? (ev.impact === 'HIGH' ? 5 : 3);
      const shouldClose = daysToEv <= closeDays && ev.type === 'EARNINGS';
      
      return {
        event: ev,
        daysToEvent: daysToEv,
        shouldAutoClose: shouldClose,
        closeDaysAhead: closeDays,
      };
    }
  }
  
  return { event: null, daysToEvent: 999, shouldAutoClose: false, closeDaysAhead: 5 };
}

/**
 * Determina si una posición abierta debe cerrarse antes de earnings.
 * 
 * @param ticker - Símbolo del activo
 * @param currentPnL - P&L actual de la posición (en %)
 * @returns { shouldClose, reason, minAcceptableReturn }
 */
export function shouldAutoCloseBeforeEarnings(
  ticker: string,
  currentPnL: number,
): { shouldClose: boolean; reason: string; minAcceptableReturn: number } {
  const info = getUpcomingEventInfo(ticker);
  
  if (!info.shouldAutoClose) {
    return { shouldClose: false, reason: 'No earnings cercanas', minAcceptableReturn: -999 };
  }
  
  // Earnings HIGH impact: cierra si está ganando O si pierde <2%
  const minReturn = info.event?.impact === 'HIGH' ? -2 : -5;
  
  if (currentPnL >= minReturn) {
    return {
      shouldClose: true,
      reason: `Cierre automático: ${info.event?.detail} en ${info.daysToEvent}d. P&L actual ${currentPnL.toFixed(1)}%`,
      minAcceptableReturn: minReturn,
    };
  }
  
  return {
    shouldClose: false,
    reason: `Earnings en ${info.daysToEvent}d pero P&L ${currentPnL.toFixed(1)}% < mín ${minReturn}% (espera)`,
    minAcceptableReturn: minReturn,
  };
}

// ════════════════════════════════════════════════════════════
// RSI Y ENTRY CONFIRMATION (v7 IMPROVED)
// ════════════════════════════════════════════════════════════

function calcRSI(closes: number[], period: number): number {
  if (!closes || closes.length < period + 1) return 50;
  const slice = closes.slice(-(period * 3 + period));
  if (slice.length < period + 1) return 50;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (isFinite(diff)) rets.push(diff);
  }
  if (rets.length < period) return 50;

  let avgG = 0, avgL = 0;
  for (let i = 0; i < period; i++) {
    if (rets[i] > 0) avgG += rets[i];
    else avgL += Math.abs(rets[i]);
  }
  avgG /= period;
  avgL /= period;

  for (let i = period; i < rets.length; i++) {
    const g = rets[i] > 0 ? rets[i] : 0;
    const l = rets[i] < 0 ? Math.abs(rets[i]) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }

  if (avgL === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(2));
}

/**
 * Verifica si la entrada está confirmada según el RSI(2).
 * 
 * LÓGICA:
 *   - RSI(2) > 75: TOO_HOT, espera pullback
 *   - RSI(2) 60-75: CONFIRMED, entrada óptima
 *   - RSI(2) < 60: EARLY, puede entrar pero sin confirmar
 *
 * @param rsi2 - RSI de 2 períodos
 * @returns { confirmed, status, nextAction }
 * 
 * CASO SMCI:
 *   - RSI(2)=99.8 → status='TOO_HOT', confirmed=false
 *   - Espera a que RSI(2) caiga a 60-75 para entrada óptima
 */
export function checkEntryConfirmation(rsi2: number): {
  confirmed: boolean;
  status: 'CONFIRMED' | 'EARLY' | 'TOO_HOT' | 'EXTREME';
  nextAction: string;
  recommendedRsiRange: [number, number];
} {
  const recommendedRsiRange: [number, number] = [60, 75];
  
  if (rsi2 > 85) {
    return {
      confirmed: false,
      status: 'EXTREME',
      nextAction: `RSI(2)=${rsi2.toFixed(0)} EXTREMO. Espera pullback a 60-75 (1-2 días típico).`,
      recommendedRsiRange,
    };
  }
  
  if (rsi2 > 75) {
    return {
      confirmed: false,
      status: 'TOO_HOT',
      nextAction: `RSI(2)=${rsi2.toFixed(0)} caliente. Espera a 60-75 para entrada confirmada.`,
      recommendedRsiRange,
    };
  }
  
  if (rsi2 >= 60 && rsi2 <= 75) {
    return {
      confirmed: true,
      status: 'CONFIRMED',
      nextAction: `RSI(2)=${rsi2.toFixed(0)} ✓ Entrada confirmada (pullback en curso).`,
      recommendedRsiRange,
    };
  }
  
  return {
    confirmed: true,  // Puede entrar pero sin la confirmación óptima
    status: 'EARLY',
    nextAction: `RSI(2)=${rsi2.toFixed(0)} bajo. Entrada posible pero espera 60-75 es más seguro.`,
    recommendedRsiRange,
  };
}

// ════════════════════════════════════════════════════════════
// INDICADORES TÉCNICOS
// ════════════════════════════════════════════════════════════

function calcEfficiencyRatio(closes: number[], period: number): number {
  if (!closes || closes.length < period + 1) return 0;
  const valid = closes.filter(v => typeof v === 'number' && isFinite(v));
  if (valid.length < period + 1) return 0;
  const slice = valid.slice(-period - 1);
  const netMove = Math.abs(slice[slice.length - 1] - slice[0]);
  let totalPath = 0;
  for (let i = 1; i < slice.length; i++) {
    totalPath += Math.abs(slice[i] - slice[i - 1]);
  }
  return totalPath > 0 ? netMove / totalPath : 0;
}

export function calcIndicators(
  closes:  number[],
  volumes: number[],
  highs:   number[],
  lows:    number[],
): TechnicalIndicators {
  if (!closes || closes.length === 0 || !isFinite(closes[closes.length - 1])) {
    throw new Error('calcIndicators: closes array inválido');
  }
  const price = closes[closes.length - 1];
  if (!isFinite(price) || price <= 0) {
    throw new Error(`calcIndicators: precio inválido ${price}`);
  }

  const ma20   = sma(closes, 20);
  const ma50   = sma(closes, 50);
  const ma200  = sma(closes, 200);
  const rsi2   = calcRSI(closes, 2);
  const rsi14  = calcRSI(closes, 14);

  const weeklyCloses = closes.length >= 70
    ? closes.filter((_, i) => (closes.length - 1 - i) % 5 === 0).reverse()
    : null;
  const rsiWeekly = weeklyCloses && weeklyCloses.length >= 14
    ? calcRSI(weeklyCloses, 14)
    : rsi14;

  const m20     = sma(closes, 20);
  const sd20    = stdev(closes.slice(-20));
  const bbUpper = m20 + 2 * sd20;
  const bbLower = m20 - 2 * sd20;
  const bbWidth = m20 > 0 ? (bbUpper - bbLower) / m20 : 0;
  const zScore20 = sd20 > 0 ? (price - m20) / sd20 : 0;

  const m50      = sma(closes, 50);
  const sd50     = stdev(closes.slice(-50));
  const zScore50 = sd50 > 0 ? (price - m50) / sd50 : 0;

  let er = 0;
  try {
    er = calcEfficiencyRatio(closes, 20);
    if (!isFinite(er)) er = 0;
  } catch { er = 0; }
  const adx = parseFloat((er * 100).toFixed(1));

  let macdLine = 0, macdSignal = 0, macdHist = 0;
  try {
    macdLine = ema(closes, 12) - ema(closes, 26);
    const macdSeries: number[] = [];
    for (let i = 26; i <= closes.length; i++) {
      macdSeries.push(ema(closes.slice(0, i), 12) - ema(closes.slice(0, i), 26));
    }
    macdSignal = ema(macdSeries, 9);
    macdHist   = macdLine - macdSignal;
  } catch { /* mantener 0 */ }

  let atr14 = price * 0.02;
  const n = Math.min(closes.length, highs.length, lows.length);
  if (n >= 15) {
    const trValues: number[] = [];
    for (let i = n - 14; i < n; i++) {
      const prevClose = closes[i - 1] ?? closes[i];
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - prevClose),
        Math.abs(lows[i]  - prevClose),
      );
      if (isFinite(tr)) trValues.push(tr);
    }
    if (trValues.length > 0) {
      const rawAtr = trValues.reduce((a, b) => a + b, 0) / trValues.length;
      atr14 = Math.max(rawAtr, price * 0.005);
    }
  }
  const atrPct = price > 0 ? atr14 / price : 0.02;
  const atrPctSafe = Math.max(atrPct, 0.005);

  let volRatio = 1;
  if (volumes && volumes.length >= 21) {
    const volSlice = volumes.slice(-21);
    const avgVol = sma(volSlice.slice(0, -1), volSlice.length - 1);
    const lastVol = volumes[volumes.length - 1] ?? avgVol;
    volRatio = avgVol > 0 ? lastVol / avgVol : 1;
    if (!isFinite(volRatio)) volRatio = 1;
  }

  const high52w = closes.length > 0
    ? Math.max(...closes.slice(-252).filter(v => isFinite(v)))
    : price;
  const drawdown52w = high52w > 0 ? (price / high52w) - 1 : 0;

  let trend: TrendDirection = 'SIDEWAYS';
  if (price > ma50 && ma50 > ma200)       trend = 'UPTREND';
  else if (price < ma50 && ma50 < ma200)  trend = 'DOWNTREND';

  return {
    price, ma20, ma50, ma200, rsi2, rsi14, rsiWeekly,
    macdLine, macdSignal, macdHist,
    adx,
    efficiencyRatio: er,
    atr14,
    atr: atr14,
    atrPct: atrPctSafe,
    bbUpper, bbMiddle: m20, bbLower, bbWidth,
    zScore20, zScore50, volumeRatio: volRatio, trend,
    aboveMA200: price > ma200,
    aboveMA50:  price > ma50,
    aboveMA20:  price > ma20,
    drawdownFrom52wHigh: drawdown52w,
  };
}

// ════════════════════════════════════════════════════════════
// SIGNAL GENERATORS (SAME AS v6)
// ════════════════════════════════════════════════════════════

function mkSig(
  type: OpportunityType, active: boolean, score: number,
  description: string, condition: string,
): TacticalSignal {
  const strength: SignalStrength =
    score >= 80 ? 'EXTREME' : score >= 60 ? 'STRONG' : score >= 40 ? 'MODERATE' : 'WEAK';
  return { type, strength, score: active ? score : 0, active, description, condition };
}

function signalBloodInStreets(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, zScore20, aboveMA200, volumeRatio, drawdownFrom52wHigh } = ind;
  const inExtremeCrash = drawdownFrom52wHigh < -0.35;
  const active = rsi2 < 10 && zScore20 < -1.5 && (aboveMA200 || inExtremeCrash);
  const score  = active
    ? Math.min(100,
        45
        + (10 - Math.min(10, rsi2)) * 4
        + (Math.abs(zScore20) - 1.5) * 5
        + (volumeRatio > 1.5 ? 8 : 0)
        + (aboveMA200 ? 0 : -15))
    : 0;
  return mkSig('BLOOD_IN_STREETS', active, score,
    active
      ? `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)}${volumeRatio > 1.5 ? ' · Vol×' + volumeRatio.toFixed(1) : ''}${!aboveMA200 ? ' · ⚠️bajo MA200' : ''} — Pánico extremo`
      : `RSI(2)=${rsi2.toFixed(1)} · Z=${zScore20.toFixed(2)} — No cumple`,
    'RSI(2)<10 AND Z-Score(20)<-1.5 AND (sobreMA200 OR drawdown<-35%)');
}

function signalMeanReversion(ind: TechnicalIndicators): TacticalSignal {
  const { rsi2, bbLower, price, zScore20 } = ind;
  const active = rsi2 < 15 && price < bbLower * 1.02;
  const score  = active
    ? Math.min(100,
        40
        + (15 - Math.min(15, rsi2)) * 2
        + (price < bbLower ? 12 : 4)
        + (zScore20 < -1.5 ? 8 : 0))
    : 0;
  return mkSig('MEAN_REVERSION', active, score,
    active
      ? `RSI(2)=${rsi2.toFixed(1)} · €${price.toFixed(2)} bajo BB(€${bbLower.toFixed(2)}) — Vuelta a la media`
      : `RSI(2)=${rsi2.toFixed(1)} · BBI=€${bbLower.toFixed(2)} — Sin condición`,
    'RSI(2)<15 AND Precio<BB Inferior+2%');
}

function signalMomentumBreakout(ind: TechnicalIndicators): TacticalSignal {
  const { adx, price, bbUpper, ma50, volumeRatio } = ind;
  const active = adx > 30 && price > bbUpper * 0.995 && price > ma50;
  const score  = active
    ? Math.min(100,
        45
        + Math.min(20, (adx - 30) * 1.2)
        + (volumeRatio > 1.5 ? 20 : 0)
        + (price > bbUpper ? 15 : 5))
    : 0;
  return mkSig('MOMENTUM_BREAKOUT', active, score,
    active
      ? `ER=${adx.toFixed(0)} · Ruptura BB superior${volumeRatio > 1.5 ? ' · Vol confirma' : ''}`
      : `ER=${adx.toFixed(0)} — Sin breakout confirmado (umbral ER>30)`,
    'ER>30 AND Precio>BB Superior AND sobre MA50');
}

function signalOversoldBounce(ind: TechnicalIndicators): TacticalSignal {
  const { rsi14, aboveMA200, ma50, price, zScore50 } = ind;
  const active = rsi14 < 35 && (aboveMA200 || price > ma50 * 0.95);
  const score  = active
    ? Math.min(100,
        42
        + (35 - Math.min(35, rsi14)) * 1.8
        + (aboveMA200 ? 18 : 6)
        + (zScore50 < -1 ? 8 : 0))
    : 0;
  return mkSig('OVERSOLD_BOUNCE', active, score,
    active
      ? `RSI(14)=${rsi14.toFixed(1)} · Sobre soporte — Sobreventa real`
      : `RSI(14)=${rsi14.toFixed(1)} — Sin condición (umbral:<35)`,
    'RSI(14)<35 AND (sobreMA200 OR MA50-5%)');
}

function signalSectorRotation(ind: TechnicalIndicators): TacticalSignal {
  const { drawdownFrom52wHigh, rsi14, aboveMA200, price, ma50 } = ind;
  const active = drawdownFrom52wHigh < -0.20 && rsi14 > 40 && rsi14 < 55
    && (aboveMA200 || price > ma50);
  const score  = active
    ? Math.min(100,
        40
        + Math.min(25, (Math.abs(drawdownFrom52wHigh) - 0.20) * 100)
        + (aboveMA200 ? 20 : 5)
        + 15)
    : 0;
  return mkSig('SECTOR_ROTATION', active, score,
    active
      ? `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% · RSI=${rsi14.toFixed(1)} recuperando`
      : `DD52w=${(drawdownFrom52wHigh * 100).toFixed(0)}% — Sin condición`,
    'Drawdown52w<-20% AND RSI 40-55 AND sobreMA200/MA50');
}

function signalEventDriven(ind: TechnicalIndicators, ticker: string): TacticalSignal {
  if (!ticker) return mkSig('EVENT_DRIVEN', false, 0,
    'Sin ticker para buscar eventos', 'Ticker requerido para EVENT_DRIVEN');
  
  const eventInfo = getUpcomingEventInfo(ticker);
  if (!eventInfo.event) return mkSig('EVENT_DRIVEN', false, 0,
    `Sin eventos cercanos (${ticker})`, 'Próximo evento corporativo en <14 días');

  const event = eventInfo.event;
  
  const impactScore =
    event.impact === 'HIGH'   ? 38
    : event.impact === 'MEDIUM' ? 25
    : 15;

  let techBonus = 0;
  if (ind.aboveMA200) techBonus += 12;
  if (ind.trend === 'UPTREND') techBonus += 10;
  if (ind.volumeRatio > 1.2) techBonus += 8;
  if (ind.rsi14 > 30 && ind.rsi14 < 70) techBonus += 5;

  if (event.type === 'EARNINGS' && ind.bbWidth < 0.05) techBonus += 10;

  const score = Math.min(100, impactScore + techBonus);
  const active = score >= 35;

  return mkSig('EVENT_DRIVEN', active, score,
    active
      ? `${event.type} · ${event.detail} en ${eventInfo.daysToEvent}d · Score ${score}${eventInfo.shouldAutoClose ? ' · ⚠️ Auto-close 5d antes' : ''}`
      : `${event.type} · ${event.detail} en ${eventInfo.daysToEvent}d — Score bajo (${score})`,
    `Evento corporativo próximo + confirmación técnica${eventInfo.shouldAutoClose ? ' + auto-close flag' : ''}`);
}

/**
 * Genera señal EVENT_DRIVEN para eventos macro (FOMC, CPI, NFP...).
 * Se ejecuta una vez por scan, no por activo.
 */
export function generateMacroSignal(): TacticalSignal {
  const now = Date.now();
  const limit14 = now + 14 * 86400000;
  const limit3 = now + 3 * 86400000;

  const macroEvents = UPCOMING_EVENTS.filter(e =>
    e.ticker === '__MACRO__' &&
    new Date(e.date).getTime() >= now &&
    new Date(e.date).getTime() <= limit14
  );

  if (macroEvents.length === 0) {
    return mkSig('EVENT_DRIVEN', false, 0,
      'Sin eventos macro en 14 días',
      'Macro evento (FOMC/CPI/NFP) en <14 días');
  }

  // Ordenar por fecha, más cercano primero
  macroEvents.sort((a, b) => a.date.localeCompare(b.date));

  // Construir descripción con los eventos más cercanos
  const nextEvent = macroEvents[0];
  const daysToEvent = Math.round(
    (new Date(nextEvent.date).getTime() - now) / 86400000
  );

  // Calcular score según:
  // - Impacto del evento más cercano
  // - Cuántos eventos se acumulan (semana cargada = más volátil)
  // - Cuán cerca está (3 días = máxima alerta)
  const nearEventCount = macroEvents.filter(e =>
    new Date(e.date).getTime() <= limit3
  ).length;

  let score = 35; // base
  if (nextEvent.impact === 'HIGH') score += 20;
  if (daysToEvent <= 3) score += 25;        // Inminente
  else if (daysToEvent <= 7) score += 15;   // Esta semana
  else score += 5;                           // Lejano
  if (nearEventCount >= 2) score += 15;      // Semana macro cargada
  if (nearEventCount >= 3) score += 10;      // Semana macro muy cargada

  const finalScore = Math.min(100, score);
  const active = finalScore >= 35;

  const eventListStr = macroEvents.slice(0, 3).map(e =>
    `${e.detail}`
  ).join(' | ');

  return mkSig('EVENT_DRIVEN', active, finalScore,
    active
      ? `📅 ${macroEvents.length} eventos macro · Próximo: ${nextEvent.detail} en ${daysToEvent}d · Score ${finalScore}${nearEventCount >= 2 ? ' · ⚠️ Semana cargada' : ''}`
      : `📅 ${macroEvents.length} eventos macro en 14d — Score bajo (${finalScore})`,
    'Evento macro próximo (FOMC/CPI/NFP) en <14 días');
}

export function generateSignals(ind: TechnicalIndicators, ticker?: string): TacticalSignal[] {
  const raw = [
    signalBloodInStreets(ind),
    signalMeanReversion(ind),
    signalMomentumBreakout(ind),
    signalOversoldBounce(ind),
    signalSectorRotation(ind),
    ...(ticker ? [signalEventDriven(ind, ticker)] : []),
  ];
  return raw.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.score - a.score;
  });
}

export function calcTotalScore(signals: TacticalSignal[]): number {
  const active = signals.filter(s => s.active);
  if (active.length === 0) return 0;
  
  // Weighted score: each signal contributes its score × weight
  // Normalized so the best possible score is 100
  
  // Confluence bonus: capped at +15 for 3+ signals
  const extraBonus = active.length >= 3 ? 10 : active.length === 2 ? 5 : 0;
  
  const baseScore = active.reduce((best, sig) => Math.max(best, sig.score), 0);
  return Math.min(100, Math.round(baseScore + extraBonus));
}

// ════════════════════════════════════════════════════════════
// STOP LOSS Y TAKE PROFITS (v7 IMPROVED)
// ════════════════════════════════════════════════════════════

/**
 * Stop-loss clásico (v6 compatible).
 * Mantener para compatibilidad hacia atrás.
 */
export function calcStopLoss(
  entryPrice: number,
  atr:        number,
  type:       OpportunityType,
  closes:     number[],
): number {
  const recentLow = closes.length >= 5 ? Math.min(...closes.slice(-5)) : entryPrice * 0.97;
  const mult =
    type === 'MOMENTUM_BREAKOUT' ? 1.0
    : type === 'BLOOD_IN_STREETS' ? 1.5
    : 2.0;
  const stopByATR  = entryPrice - Math.max(atr * mult, atr * 0.5);
  const stopByLow  = recentLow * 0.985;
  return Math.min(stopByATR, stopByLow);
}

/**
 * NUEVO v7: Stop-loss dinámico basado en MA50 + ATR.
 * 
 * LÓGICA:
 *   - Stop = MA50 + 1×ATR
 *   - Proporciona un nivel natural de soporte dinámico
 *   - Mejor para breakouts alcistas + tendencias
 *   - Reduce riesgo real manteniendo validez de trade
 *
 * @param ma50 - Media móvil de 50 periodos
 * @param atr - Average True Range
 * @param price - Precio actual
 * @returns Stop-loss dinámico
 * 
 * CASO SMCI:
 *   - MA50: $27.90
 *   - ATR: $2.57
 *   - Stop dinámico = $27.90 + $2.57 = $30.47
 *   - Vs. 20% estático = $34.48
 *   - Diferencia: -12% riesgo (más tight, mejor)
 */
export function calcDynamicStopLoss(
  ma50: number,
  atr: number,
  price: number,
): number {
  const stopByMA = ma50 + atr;
  
  // Sanity check: el stop nunca debería estar por encima del precio actual
  // (eso sería una posición SHORT)
  if (stopByMA >= price) {
    return price * 0.97;  // Fallback: 3% por debajo del precio
  }
  
  return stopByMA;
}

export function calcTakeProfits(
  entryPrice: number,
  stopLoss:   number,
  type:       OpportunityType,
  ind:        TechnicalIndicators,
  closes?:    number[],
): { tp1: number; tp2: number; rr: number; useTrailing: boolean } {
  const risk = entryPrice - stopLoss;
  if (risk <= 0) {
    return { tp1: entryPrice * 1.02, tp2: entryPrice * 1.04, rr: 1.5, useTrailing: false };
  }

  const mults  = calcDynamicTPMultiplier(ind.atrPct);

  const tp1    = entryPrice + risk * mults.tp1;
  const tp2Raw = entryPrice + risk * mults.tp2;
  const tp2    = Math.max(tp1 * 1.005, tp2Raw);

  const rr = (tp1 - entryPrice) / risk;

  return {
    tp1,
    tp2,
    rr:          Math.max(1.2, rr),
    useTrailing: type === 'MOMENTUM_BREAKOUT',
  };
}

// ════════════════════════════════════════════════════════════
// ASSET SPEED & DYNAMIC HORIZONS
// ════════════════════════════════════════════════════════════

export type AssetSpeed = 'FAST' | 'MEDIUM' | 'SLOW' | 'TOO_SLOW';

export function classifyAssetSpeed(atrPct: number): AssetSpeed {
  if (atrPct >= 0.04)  return 'FAST';
  if (atrPct >= 0.02)  return 'MEDIUM';
  if (atrPct >= 0.008) return 'SLOW';
  return 'TOO_SLOW';
}

export function calcDynamicMaxDays(atrPct: number): number {
  if (atrPct >= 0.04)  return 20;
  if (atrPct >= 0.02)  return 40;
  if (atrPct >= 0.008) return 75;
  return 90;
}

export function calcDynamicTPMultiplier(atrPct: number): { tp1: number; tp2: number } {
  if (atrPct >= 0.04)  return { tp1: 1.5, tp2: 4.0 };
  if (atrPct >= 0.02)  return { tp1: 1.5, tp2: 2.5 };
  if (atrPct >= 0.008) return { tp1: 1.3, tp2: 1.8 };
  return { tp1: 1.25, tp2: 1.5 };
}

// ════════════════════════════════════════════════════════════
// FIRST PASSAGE TIME MODEL
// ════════════════════════════════════════════════════════════

export function calcOptimalHorizon(
  entryPrice:  number,
  target:      number,
  atr:         number,
  signalType?: OpportunityType,
  maxDays?:    number,
): { days: number; prob: number; probs: number[]; assetSpeed: AssetSpeed } {
  const atrPct = atr / Math.max(0.01, entryPrice);
  const speed  = classifyAssetSpeed(atrPct);
  const dynMax = maxDays ?? calcDynamicMaxDays(atrPct);
  if (atr <= 0 || target <= entryPrice || dynMax <= 0) {
    return { days: 0, prob: 0, probs: [], assetSpeed: speed };
  }
  const d      = target - entryPrice;
  const sigma  = atr;
  const driftF = signalType ? SIGNAL_DRIFT[signalType] ?? 0.08 : 0.08;
  const mu     = sigma * driftF;
  const expectedDays = d / mu;
  const optimalDays  = Math.max(1, Math.min(dynMax, Math.round(expectedDays)));
  const probs: number[] = [];
  for (let t = 1; t <= dynMax; t++) {
    const cp = fptCDF(t, d, mu, sigma);
    probs.push(parseFloat((cp * 100).toFixed(2)));
  }
  const finalProb = probs[optimalDays - 1] ?? 0;
  return {
    days: optimalDays,
    prob: parseFloat(finalProb.toFixed(2)),
    probs,
    assetSpeed: speed,
  };
}

export function calcExpectedDays(
  entryPrice:  number,
  target:      number,
  atr:         number,
  signalType:  OpportunityType,
): number {
  const { days } = calcOptimalHorizon(entryPrice, target, atr, signalType);
  return Math.max(1, days);
}

export function calcTimingScore(daysOpen: number, expectedDays: number): number {
  if (expectedDays <= 0) return 0;
  return Math.min(100, Math.round((daysOpen / expectedDays) * 100));
}

export function calcDaysToBreakeven(
  entryPrice:   number,
  currentPrice: number,
  atr:          number,
  signalType:   OpportunityType,
): number {
  if (currentPrice >= entryPrice) return 0;
  return calcExpectedDays(currentPrice, entryPrice, atr, signalType);
}

// ════════════════════════════════════════════════════════════
// MOMENTUM EXHAUSTION DETECTION (v8 — Refuerzo #4)
//
// Detecta si el rally está perdiendo fuel antes de llegar al
// take profit. Señales:
//   1. Precio cerca de resistencia (BB superior < 2%)
//   2. Volumen decreciente en velas alcistas (rally débil)
//   3. RSI(14) sobrecomprado > 70
//   4. Precio estancado (3 velas en rango < 0.5%)
//
// Confianza ≥ 40 → rally agotado. No entres o cierra.
// ════════════════════════════════════════════════════════════

export interface ExhaustionResult {
  exhausted:  boolean;
  reasons:    string[];
  confidence: number;  // 0-100
}

// ════════════════════════════════════════════════════════════
// MULTI-TIMEFRAME WEEKLY CONFIRMATION (v10 Pine Script alignment)
//
// Pide 2 de 3 condiciones en la vela semanal antes de validar
// una señal diaria. Reduce falsas entradas en mercados sin
// tendencia clara en el timeframe superior.
//
// Condiciones:
//   1. W Close > W MA50 (tendencia alcista semanal)
//   2. W RSI(14) > 50 (momentum positivo semanal)
//   3. W MACD bullish (momentum 4-semanas > 0)
// ════════════════════════════════════════════════════════════
export interface WeeklyConfirmation {
  confirmed:     boolean;
  confirmations: number;   // 0-3
  details:       string;
}

export function checkWeeklyConfirmation(closes: number[]): WeeklyConfirmation {
  if (closes.length < 70) {
    return { confirmed: false, confirmations: 0, details: 'Datos insuficientes (<70 velas diarias)' };
  }

  // Muestrear cierres semanales (cada 5 velas diarias)
  const weeklyCloses: number[] = [];
  for (let i = closes.length - 1; i >= 0; i -= 5) {
    weeklyCloses.unshift(closes[i]);
  }
  if (weeklyCloses.length < 14) {
    return { confirmed: false, confirmations: 0, details: 'Datos semanales insuficientes' };
  }

  // 1. W Close > W MA50
  const wMA50 = weeklyCloses.length >= 50
    ? weeklyCloses.slice(-50).reduce((a, b) => a + b, 0) / 50
    : weeklyCloses.reduce((a, b) => a + b, 0) / weeklyCloses.length;
  const wClose = weeklyCloses[weeklyCloses.length - 1];
  const wTrendOk = wClose > wMA50;

  // 2. W RSI(14) > 50
  const wRsi14 = calcRSI(weeklyCloses, 14);
  const wRsiOk = wRsi14 > 50;

  // 3. W MACD bullish (proxy: momentum 4 semanas positivo)
  const wMomentum4w = weeklyCloses.length >= 5
    ? weeklyCloses[weeklyCloses.length - 1] / weeklyCloses[weeklyCloses.length - 5] - 1
    : 0;
  const wMacdOk = wMomentum4w > 0;

  const confirmations = (wTrendOk ? 1 : 0) + (wRsiOk ? 1 : 0) + (wMacdOk ? 1 : 0);
  const confirmed = confirmations >= 2;

  return {
    confirmed,
    confirmations,
    details: `W Close${wClose.toFixed(0)} vs MA50${wMA50.toFixed(0)}:${wTrendOk ? 'OK' : 'NO'} · RSI:${wRsi14.toFixed(0)}:${wRsiOk ? 'OK' : 'NO'} · Mom4w:${(wMomentum4w*100).toFixed(1)}%:${wMacdOk ? 'BULL' : 'BEAR'} → ${confirmations}/3${confirmed ? ' ✓' : ' ✗'}`,
  };
}

export function detectMomentumExhaustion(
  closes:  number[],
  volumes: number[],
  rsi14:   number,
  macdHist: number,
  bbUpper: number,
  price:   number,
): ExhaustionResult {
  const reasons: string[] = [];
  let confidence = 0;

  // 1. Precio cerca de resistencia (BB superior < 2%)
  if (bbUpper > 0 && price / bbUpper > 0.98) {
    reasons.push('Precio a <2% de BB superior (resistencia técnica)');
    confidence += 25;
  } else if (bbUpper > 0 && price / bbUpper > 0.95) {
    reasons.push('Precio cerca de BB superior (zona de resistencia)');
    confidence += 15;
  }

  // 2. Volumen decreciente en subidas (últimas 4 velas)
  if (closes.length >= 5 && volumes.length >= 5) {
    const c = closes.slice(-5);
    const v = volumes.slice(-5);
    let upBars = 0;
    let volDeclining = true;
    for (let i = 1; i < 5; i++) {
      if (c[i] > c[i - 1]) upBars++;
      if (v[i] >= v[i - 1]) volDeclining = false;
    }
    if (upBars >= 2 && volDeclining && v[4] < v[0] * 0.8) {
      reasons.push('Volumen decreciente en rally (-20% vs media) — compra débil');
      confidence += 20;
    } else if (upBars >= 1 && v[4] < v[3] && v[3] < v[2]) {
      reasons.push('Volumen bajando 3 velas seguidas — interés perdiendo');
      confidence += 12;
    }
  }

  // 3. RSI(14) sobrecomprado
  if (rsi14 > 75) {
    reasons.push(`RSI(14)=${rsi14.toFixed(0)} muy sobrecomprado — agotamiento inminente`);
    confidence += 25;
  } else if (rsi14 > 70) {
    reasons.push(`RSI(14)=${rsi14.toFixed(0)} sobrecomprado`);
    confidence += 15;
  } else if (rsi14 > 65 && price / bbUpper > 0.95) {
    reasons.push('RSI elevado + cerca de resistencia — doble confirmación');
    confidence += 20;
  }

  // 4. Precio estancado (3 velas en rango < 0.5%)
  if (closes.length >= 4) {
    const recent3 = closes.slice(-4);
    const max3 = Math.max(...recent3);
    const min3 = Math.min(...recent3);
    if (max3 > 0 && (max3 - min3) / max3 < 0.005) {
      reasons.push('Precio estancado (3 velas en <0.5%) — sin momentum direccional');
      confidence += 20;
    }
  }

  // 5. MACD histogram perdiendo fuel (positivo pero encogiendo)
  if (macdHist > 0 && macdHist < 0.5) {
    reasons.push('MACD histogram casi plano — momentum agotándose');
    confidence += 10;
  }

  const exhausted = confidence >= 40;

  return {
    exhausted,
    reasons,
    confidence: Math.min(100, confidence),
  };
}