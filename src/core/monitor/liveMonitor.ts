// ════════════════════════════════════════════════════════════════
// ARCHIVO: src/core/monitor/liveMonitor.ts
// OLYMPUS X — Motor de Monitoreo en Tiempo Real
// ════════════════════════════════════════════════════════════════
//
// PROPÓSITO:
//   Monitoreo en vivo del portfolio usando Yahoo Finance como
//   fuente de datos única (IBKR eliminado).
//
// CARACTERÍSTICAS:
//   ✓ Precios vía Yahoo Finance (delay ~15min mercados, ~0min crypto)
//   ✓ Rolling metrics: Sharpe, Sortino, Vol, VaR, CVaR (20d)
//   ✓ Drawdown tracking con picos históricos
//   ✓ DCA Opportunity Detector para BTC y otros activos
//   ✓ Alertas calibradas a estrategia HODL+DCA
//   ✓ Circuit breaker ante fallos consecutivos de Yahoo
// ════════════════════════════════════════════════════════════════

import { DEFAULT_POSITIONS } from '../../lib/constants';
import { fetchRealMarketData } from '../../lib/marketData';

// ── FUENTE DE DATOS: Yahoo Finance ────────────────────────────
// Usa fetchRealMarketData() que ya existe y funciona via Supabase Edge Function.
// Los precios de Yahoo tienen ~15min de delay en mercado abierto.
// En cripto (BTC) el delay es mínimo porque Yahoo publica casi en tiempo real.
async function fetchYahooPrices(): Promise<Record<string, number>> {
  try {
    const { marketData } = await fetchRealMarketData();
    return { ...marketData.prices };
  } catch {
    return {};
  }
}

// ── TIPOS DE ESTADO ───────────────────────────────────────────

export interface LivePosition {
  ticker: string;
  shares: number;
  avgPrice: number;         // precio medio de compra (€)
  livePrice: number;        // precio de mercado ahora (€)
  marketValue: number;      // shares × livePrice
  weight: number;           // % del portfolio total
  unrealizedPnL: number;    // (livePrice - avgPrice) × shares
  unrealizedPct: number;    // unrealizedPnL / (avgPrice × shares)
  dailyChange: number;      // cambio % hoy
  lastUpdate: number;       // timestamp ms
  priceSource: 'YAHOO' | 'STALE' | 'MANUAL';
}

export interface RollingMetrics {
  sharpe20d: number;
  sortino20d: number;
  volatility20d: number;    // anualizada
  cvar95_20d: number;       // CVaR 95% sobre retornos diarios del portfolio
  var95_20d: number;        // VaR 95%
  sharpe_trend: 'UP' | 'DOWN' | 'FLAT';
  risk_trend: 'INCREASING' | 'STABLE' | 'DECREASING';
}

export interface DrawdownState {
  currentDrawdown: number;
  peakEquity: number;
  troughEquity: number;
  maxDrawdown: number;
  drawdownDays: number;
  recoveryTarget: number;
}

export interface DCAOpportunity {
  ticker: string;
  active: boolean;
  drawdownFromPeak: number;
  suggestedAmount: number;
  multiplier: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
  tranche: number;
  totalTranches: number;
}

export interface LiveAlert {
  id: string;
  level: 'CRITICAL' | 'WARNING' | 'INFO' | 'DCA_OPPORTUNITY';
  message: string;
  detail: string;
  timestamp: number;
  dismissed: boolean;
  requiresAction: boolean;
  suggestedAction?: string;
}

export interface LiveMonitorState {
  positions: LivePosition[];
  totalEquity: number;
  cashBalance: number;
  totalUnrealizedPnL: number;
  totalRealizedPnL: number;
  totalPnL: number;
  totalPnLPct: number;

  rolling: RollingMetrics;
  drawdown: DrawdownState;

  equityCurve: { timestamp: number; equity: number }[];
  dailyReturns: number[];

  dcaOpportunities: DCAOpportunity[];

  alerts: LiveAlert[];

  connection: {
    dataFreshness: 'LIVE' | 'DELAYED' | 'STALE';
    consecutiveErrors: number;
    circuitBreakerOpen: boolean;
  };

  lastUpdate: number;
}

// ── CONFIGURACIÓN DEL MONITOR ─────────────────────────────────

const MONITOR_CONFIG = {
  // PRICE_UPDATE_MS ahora es dinámico vía computeOptimalPriceInterval()
  //   mercado abierto=60s · cerrado=120s · finde=300s · alertas=30s
  RISK_UPDATE_MS: 60_000,           // métricas de riesgo cada 1min (local, sin Supabase)

  MAX_CONSECUTIVE_ERRORS: 5,
  CIRCUIT_BREAKER_RESET_MS: 120_000,

  DRAWDOWN_WARNING_PCT: 0.10,
  DRAWDOWN_CRITICAL_PCT: 0.20,
  DAILY_LOSS_WARNING_PCT: 0.05,
  CVAR_WARNING_PCT: 0.12,
  CVAR_CRITICAL_PCT: 0.18,

  BTC_DCA_MIN_DRAWDOWN: 0.10,
  BTC_DCA_BASE_AMOUNT_PCT: 0.06,
  BTC_DCA_LEVELS: [
    { drawdown: 0.10, mult: 1.0, label: 'Pullback moderado' },
    { drawdown: 0.20, mult: 1.8, label: 'Corrección normal' },
    { drawdown: 0.30, mult: 2.5, label: 'Caída significativa' },
    { drawdown: 0.40, mult: 3.5, label: 'Capitulación — máxima agresividad' },
  ],

  RISK_FREE_DAILY: 0.0385 / 252,
  ROLLING_WINDOW: 20,
} as const;

// ── ESTADO INICIAL ────────────────────────────────────────────

function buildInitialState(): LiveMonitorState {
  const initialEquity = 6622;
  return {
    positions: [],
    totalEquity: initialEquity,
    cashBalance: 0,
    totalUnrealizedPnL: 0,
    totalRealizedPnL: 0,
    totalPnL: 0,
    totalPnLPct: 0,
    rolling: {
      sharpe20d: 0, sortino20d: 0, volatility20d: 0,
      cvar95_20d: 0, var95_20d: 0,
      sharpe_trend: 'FLAT', risk_trend: 'STABLE',
    },
    drawdown: {
      currentDrawdown: 0, peakEquity: initialEquity,
      troughEquity: initialEquity, maxDrawdown: 0,
      drawdownDays: 0, recoveryTarget: initialEquity,
    },
    equityCurve: [{ timestamp: Date.now(), equity: initialEquity }],
    dailyReturns: [],
    dcaOpportunities: [],
    alerts: [],
    connection: {
      dataFreshness: 'STALE',
      consecutiveErrors: 0,
      circuitBreakerOpen: false,
    },
    lastUpdate: Date.now(),
  };
}

// ── CÁLCULO DE PnL ────────────────────────────────────────────

function computePositionPnL(pos: LivePosition): LivePosition {
  const costBasis = pos.avgPrice * pos.shares;
  const unrealizedPnL = (pos.livePrice - pos.avgPrice) * pos.shares;
  return {
    ...pos,
    marketValue: pos.livePrice * pos.shares,
    unrealizedPnL,
    unrealizedPct: costBasis > 0 ? unrealizedPnL / costBasis : 0,
  };
}

// ── ROLLING METRICS ───────────────────────────────────────────

function computeRollingMetrics(
  dailyReturns: number[],
  window = MONITOR_CONFIG.ROLLING_WINDOW
): RollingMetrics {
  const recent = dailyReturns.slice(-window);
  if (recent.length < 5) {
    return {
      sharpe20d: 0, sortino20d: 0, volatility20d: 0,
      cvar95_20d: 0, var95_20d: 0,
      sharpe_trend: 'FLAT', risk_trend: 'STABLE',
    };
  }

  const n = recent.length;
  const rf = MONITOR_CONFIG.RISK_FREE_DAILY;
  const mean = recent.reduce((s, r) => s + r, 0) / n;
  const excessMean = mean - rf;

  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const annualizedVol = stdDev * Math.sqrt(252);

  const sharpe20d = stdDev > 0 ? (excessMean * Math.sqrt(252)) / annualizedVol : 0;

  const downReturns = recent.filter(r => r < rf);
  const downsideVariance = downReturns.reduce((s, r) => s + (r - rf) ** 2, 0) / Math.max(n - 1, 1);
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino20d = downsideDev > 0 ? (excessMean * Math.sqrt(252)) / (downsideDev * Math.sqrt(252)) : 0;

  const sorted = [...recent].sort((a, b) => a - b);
  const varIdx = Math.max(0, Math.floor(0.05 * n) - 1);
  const var95_20d = -sorted[varIdx];

  const tailReturns = sorted.slice(0, varIdx + 1);
  const cvar95_20d = tailReturns.length > 0
    ? -tailReturns.reduce((s, r) => s + r, 0) / tailReturns.length
    : var95_20d;

  const firstHalf = recent.slice(0, Math.floor(n / 2));
  const secondHalf = recent.slice(Math.floor(n / 2));
  const sharpe1 = computeQuickSharpe(firstHalf, rf);
  const sharpe2 = computeQuickSharpe(secondHalf, rf);
  const sharpe_trend: RollingMetrics['sharpe_trend'] =
    sharpe2 > sharpe1 * 1.10 ? 'UP' :
    sharpe2 < sharpe1 * 0.90 ? 'DOWN' : 'FLAT';

  const vol1 = computeQuickVol(firstHalf);
  const vol2 = computeQuickVol(secondHalf);
  const risk_trend: RollingMetrics['risk_trend'] =
    vol2 > vol1 * 1.15 ? 'INCREASING' :
    vol2 < vol1 * 0.85 ? 'DECREASING' : 'STABLE';

  return {
    sharpe20d, sortino20d,
    volatility20d: annualizedVol,
    cvar95_20d, var95_20d,
    sharpe_trend, risk_trend,
  };
}

function computeQuickSharpe(returns: number[], rf: number): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  return std > 0 ? (mean - rf) / std : 0;
}

function computeQuickVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  return Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
}

// ── DETECTOR DE OPORTUNIDADES DCA ─────────────────────────────

function detectDCAOpportunities(
  positions: LivePosition[],
  totalEquity: number,
  cashBalance: number
): DCAOpportunity[] {
  const opportunities: DCAOpportunity[] = [];

  for (const pos of positions) {
    const drawdownFromAvg = pos.avgPrice > 0
      ? (pos.avgPrice - pos.livePrice) / pos.avgPrice
      : 0;

    if (pos.ticker === 'BTC-EUR' && drawdownFromAvg >= MONITOR_CONFIG.BTC_DCA_MIN_DRAWDOWN) {
      const level = [...MONITOR_CONFIG.BTC_DCA_LEVELS]
        .reverse()
        .find(l => drawdownFromAvg >= l.drawdown);

      if (level) {
        const baseAmount = totalEquity * MONITOR_CONFIG.BTC_DCA_BASE_AMOUNT_PCT;
        const suggestedAmount = Math.min(
          baseAmount * level.mult,
          cashBalance * 0.90,
          totalEquity * 0.12
        );

        if (suggestedAmount > 50) {
          const levelIdx = MONITOR_CONFIG.BTC_DCA_LEVELS.indexOf(level);
          opportunities.push({
            ticker: 'BTC-EUR',
            active: true,
            drawdownFromPeak: drawdownFromAvg,
            suggestedAmount,
            multiplier: level.mult,
            confidence: drawdownFromAvg >= 0.30 ? 'HIGH' : drawdownFromAvg >= 0.20 ? 'MEDIUM' : 'LOW',
            reason: `${level.label}: BTC bajó ${(drawdownFromAvg * 100).toFixed(1)}% desde precio medio`,
            tranche: levelIdx + 1,
            totalTranches: MONITOR_CONFIG.BTC_DCA_LEVELS.length,
          });
        }
      }
    }

    if (pos.ticker !== 'BTC-EUR' && drawdownFromAvg >= 0.08) {
      const baseAmount = totalEquity * 0.03;
      const suggestedAmount = Math.min(baseAmount, cashBalance * 0.30);

      if (suggestedAmount > 30) {
        opportunities.push({
          ticker: pos.ticker,
          active: drawdownFromAvg >= 0.10,
          drawdownFromPeak: drawdownFromAvg,
          suggestedAmount,
          multiplier: 1.0 + drawdownFromAvg * 2,
          confidence: drawdownFromAvg >= 0.15 ? 'MEDIUM' : 'LOW',
          reason: `Pullback ${(drawdownFromAvg * 100).toFixed(1)}% desde precio medio`,
          tranche: 1,
          totalTranches: 2,
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.drawdownFromPeak - a.drawdownFromPeak);
}

// ── SISTEMA DE ALERTAS ─────────────────────────────────────────

function generateSmartAlerts(
  state: LiveMonitorState,
  newRolling: RollingMetrics,
  newDrawdown: DrawdownState
): LiveAlert[] {
  const alerts: LiveAlert[] = [...state.alerts.filter(a => !a.dismissed).slice(-20)];
  const now = Date.now();
  const addAlert = (a: Omit<LiveAlert, 'id' | 'timestamp' | 'dismissed'>) => {
    const id = `${a.level}-${a.message.slice(0, 20)}-${now}`;
    const existing = alerts.find(x => x.message === a.message && now - x.timestamp < 3_600_000);
    if (!existing) alerts.push({ ...a, id, timestamp: now, dismissed: false });
  };

  if (newDrawdown.currentDrawdown >= MONITOR_CONFIG.DRAWDOWN_CRITICAL_PCT) {
    addAlert({
      level: 'CRITICAL',
      message: `Drawdown crítico: -${(newDrawdown.currentDrawdown * 100).toFixed(1)}%`,
      detail: `El portfolio ha caído ${(newDrawdown.currentDrawdown * 100).toFixed(1)}% desde su máximo de €${newDrawdown.peakEquity.toFixed(0)}. Máximo tolerable: -25%.`,
      requiresAction: true,
      suggestedAction: 'Revisar si el régimen HMM ha cambiado. No añadir riesgo hasta que el drawdown estabilice.',
    });
  } else if (newDrawdown.currentDrawdown >= MONITOR_CONFIG.DRAWDOWN_WARNING_PCT) {
    addAlert({
      level: 'WARNING',
      message: `Drawdown en zona de atención: -${(newDrawdown.currentDrawdown * 100).toFixed(1)}%`,
      detail: `Acercándose al umbral de alerta. Verificar que las oportunidades DCA están calibradas.`,
      requiresAction: false,
    });
  }

  if (newRolling.cvar95_20d >= MONITOR_CONFIG.CVAR_CRITICAL_PCT) {
    addAlert({
      level: 'CRITICAL',
      message: `CVaR 95% elevado: ${(newRolling.cvar95_20d * 100).toFixed(1)}%`,
      detail: `El riesgo de cola ha superado el límite institucional. En el peor 5% de días, el portfolio pierde más del ${(newRolling.cvar95_20d * 100).toFixed(1)}%.`,
      requiresAction: true,
      suggestedAction: 'CVaR Optimizer debería reducir exposición automáticamente. Verificar que olympusX.ts está activo.',
    });
  }

  if (newRolling.risk_trend === 'INCREASING' && newRolling.volatility20d > 0.25) {
    addAlert({
      level: 'WARNING',
      message: 'Volatilidad del portfolio en aumento',
      detail: `Vol 20d: ${(newRolling.volatility20d * 100).toFixed(1)}% anualizado y subiendo. El DCC-GARCH debería detectar esto.`,
      requiresAction: false,
    });
  }

  const todayReturn = state.dailyReturns.slice(-1)[0] ?? 0;
  if (todayReturn < -MONITOR_CONFIG.DAILY_LOSS_WARNING_PCT) {
    addAlert({
      level: 'WARNING',
      message: `Pérdida diaria: ${(todayReturn * 100).toFixed(1)}%`,
      detail: `El portfolio ha perdido ${(todayReturn * 100).toFixed(1)}% hoy (€${(todayReturn * state.totalEquity).toFixed(0)}).`,
      requiresAction: false,
    });
  }

  const btcDCA = state.dcaOpportunities.find(o => o.ticker === 'BTC-EUR' && o.active && o.confidence === 'HIGH');
  if (btcDCA) {
    addAlert({
      level: 'DCA_OPPORTUNITY',
      message: `🎯 DCA BTC: caída ${(btcDCA.drawdownFromPeak * 100).toFixed(0)}% — zona de acumulación`,
      detail: `Oportunidad de bajar precio medio. Tranche ${btcDCA.tranche}/${btcDCA.totalTranches}: sugerido €${btcDCA.suggestedAmount.toFixed(0)} (×${btcDCA.multiplier.toFixed(1)} DCA base).`,
      requiresAction: false,
      suggestedAction: `Ejecutar orden BTC-EUR TWAP por €${btcDCA.suggestedAmount.toFixed(0)}. Quedan ${btcDCA.totalTranches - btcDCA.tranche} tranches adicionales.`,
    });
  }

  if (state.connection.dataFreshness === 'STALE') {
    addAlert({
      level: 'WARNING',
      message: 'Datos de mercado desactualizados (STALE)',
      detail: 'Los precios no se han actualizado en más de 30 segundos. Posible problema de conexión con Yahoo Finance.',
      requiresAction: false,
    });
  }

  return alerts;
}

// ── MOTOR PRINCIPAL DEL MONITOR ───────────────────────────────

export class OlympusLiveMonitor {
  private state: LiveMonitorState;
  private priceTimeoutId?: ReturnType<typeof setTimeout>;
  private riskIntervalId?: ReturnType<typeof setInterval>;
  private listeners: Set<(state: LiveMonitorState) => void> = new Set();

  private prevDayPrices: Record<string, number> = {};

  constructor() {
    this.state = buildInitialState();
    this.initializeFromDefaults();
  }

  private initializeFromDefaults(): void {
    const positions: LivePosition[] = Object.entries(DEFAULT_POSITIONS).map(([ticker, pos]) => ({
      ticker,
      shares: pos.shares,
      avgPrice: pos.avgPrice,
      livePrice: pos.avgPrice,
      marketValue: pos.shares * pos.avgPrice,
      weight: 0,
      unrealizedPnL: 0,
      unrealizedPct: 0,
      dailyChange: 0,
      lastUpdate: Date.now(),
      priceSource: 'STALE' as const,
    }));

    const totalEquity = positions.reduce((s, p) => s + p.marketValue, 0);
    this.state = {
      ...this.state,
      positions: positions.map(p => ({
        ...p,
        weight: totalEquity > 0 ? p.marketValue / totalEquity : 0,
      })),
      totalEquity,
    };
  }

  // ── API PÚBLICA ─────────────────────────────────────────────

  subscribe(listener: (state: LiveMonitorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach(l => l(this.state));
  }

  getState(): LiveMonitorState {
    return this.state;
  }

  dismissAlert(alertId: string): void {
    this.state = {
      ...this.state,
      alerts: this.state.alerts.map(a =>
        a.id === alertId ? { ...a, dismissed: true } : a
      ),
    };
    this.emit();
  }

  // ── POLLING ADAPTATIVO ────────────────────────────────────
  // En lugar de un setInterval fijo, usamos setTimeout recursivo que
  // recalcula el intervalo óptimo en cada ciclo según las condiciones:
  //   - Mercado abierto (Lun-Vie 15:30-22:00 UTC): cada 60s
  //   - Mercado cerrado: cada 120s
  //   - Fin de semana: cada 300s
  //   - Alertas críticas / DCA activo: cada 30s
  //   - Errores consecutivos: backoff progresivo hasta 120s
  //   - Circuit breaker abierto: cada 30s (para detectar recuperación)
  //
  // BENEFICIO: reduce ~95% las llamadas a Supabase vs el antiguo intervalo fijo de 15s.
  //
  private computeOptimalPriceInterval(): number {
    const s = this.state;

    if (s.connection.circuitBreakerOpen) return 30_000;
    if (s.connection.consecutiveErrors >= 3) return 120_000;
    if (s.connection.consecutiveErrors >= 1) return 60_000;

    const hasCritical = s.alerts.some(a => a.level === 'CRITICAL' && !a.dismissed);
    const hasActiveDCA = s.dcaOpportunities.some(o => o.active && o.confidence === 'HIGH');
    if (hasCritical || hasActiveDCA) return 30_000;

    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
    const isOpen = day >= 1 && day <= 5 && hour >= 14.5 && hour < 21;

    if (isOpen) return 60_000;                         // mercado abierto
    if (day === 0 || day === 6) return 300_000;        // fin de semana (5min)
    return 120_000;                                     // mercado cerrado (2min)
  }

  private isPollingScheduled = false;

  private scheduleNextPriceUpdate(): void {
    if (this.isPollingScheduled) return;
    this.isPollingScheduled = true;

    const interval = this.computeOptimalPriceInterval();
    this.priceTimeoutId = setTimeout(() => {
      this.isPollingScheduled = false;
      this.updatePrices()
        .catch(e => this.handleError(e))
        .finally(() => this.scheduleNextPriceUpdate());
    }, interval);
  }

  // ── INICIAR/PARAR MONITOR ───────────────────────────────────

  start(): void {
    this.scheduleNextPriceUpdate();

    this.riskIntervalId = setInterval(
      () => this.updateRiskMetrics(),
      MONITOR_CONFIG.RISK_UPDATE_MS
    );

    this.updatePrices().catch(() => {});
    this.updateRiskMetrics();
  }

  stop(): void {
    if (this.priceTimeoutId) clearTimeout(this.priceTimeoutId);
    this.isPollingScheduled = false;
    if (this.riskIntervalId) clearInterval(this.riskIntervalId);
  }

  // ── ACTUALIZACIÓN DE PRECIOS (Yahoo Finance) ────────────────

  private async updatePrices(): Promise<void> {
    if (this.state.connection.circuitBreakerOpen) return;

    try {
      const yahooPrices = await fetchYahooPrices();
      if (Object.keys(yahooPrices).length === 0) {
        this.handleError(new Error('Yahoo returned empty prices'));
        return;
      }

      // Resetear contador de errores al tener éxito
      const updatedPositions = this.state.positions.map(pos => {
        const newPrice = yahooPrices[pos.ticker];
        if (!newPrice) return pos;

        const prevPrice = this.prevDayPrices[pos.ticker] ?? pos.livePrice;
        const dailyChange = prevPrice > 0 ? (newPrice / prevPrice - 1) : 0;

        return computePositionPnL({
          ...pos,
          livePrice: newPrice,
          dailyChange,
          lastUpdate: Date.now(),
          priceSource: 'YAHOO',
        });
      });

      const totalEquity = updatedPositions.reduce((s, p) => s + p.marketValue, 0) +
                          this.state.cashBalance;
      const totalUnrealizedPnL = updatedPositions.reduce((s, p) => s + p.unrealizedPnL, 0);
      const costBasis = updatedPositions.reduce((s, p) => s + p.avgPrice * p.shares, 0);
      const totalPnLPct = costBasis > 0 ? totalUnrealizedPnL / costBasis : 0;

      const withWeights = updatedPositions.map(p => ({
        ...p,
        weight: totalEquity > 0 ? p.marketValue / totalEquity : 0,
      }));

      const newDrawdown = this.computeDrawdown(totalEquity);
      const dcaOpportunities = detectDCAOpportunities(
        withWeights, totalEquity, this.state.cashBalance
      );

      this.state = {
        ...this.state,
        positions: withWeights,
        totalEquity,
        totalUnrealizedPnL,
        totalPnL: this.state.totalRealizedPnL + totalUnrealizedPnL,
        totalPnLPct,
        drawdown: newDrawdown,
        dcaOpportunities,
        connection: {
          dataFreshness: 'LIVE',
          consecutiveErrors: 0,
          circuitBreakerOpen: false,
        },
        lastUpdate: Date.now(),
      };

      this.emit();
    } catch (err) {
      this.handleError(err);
    }
  }

  // ── ACTUALIZACIÓN DE MÉTRICAS DE RIESGO ─────────────────────

  private updateRiskMetrics(): void {
    const equity = this.state.totalEquity;
    const prevEquity = this.state.equityCurve.slice(-2, -1)[0]?.equity ?? equity;
    const todayReturn = prevEquity > 0 ? (equity / prevEquity - 1) : 0;

    const newDailyReturns = [...this.state.dailyReturns, todayReturn].slice(-252);
    const newEquityCurve = [
      ...this.state.equityCurve,
      { timestamp: Date.now(), equity }
    ].slice(-252);

    const newRolling = computeRollingMetrics(newDailyReturns);
    const newAlerts = generateSmartAlerts(this.state, newRolling, this.state.drawdown);

    this.state = {
      ...this.state,
      dailyReturns: newDailyReturns,
      equityCurve: newEquityCurve,
      rolling: newRolling,
      alerts: newAlerts,
    };

    this.emit();
  }

  // ── DRAWDOWN ────────────────────────────────────────────────

  private computeDrawdown(currentEquity: number): DrawdownState {
    const prev = this.state.drawdown;
    const newPeak = Math.max(prev.peakEquity, currentEquity);
    const currentDD = newPeak > 0 ? (newPeak - currentEquity) / newPeak : 0;
    const ddDays = currentDD > 0.001 ? prev.drawdownDays + 1 : 0;

    return {
      currentDrawdown: currentDD,
      peakEquity: newPeak,
      troughEquity: currentDD > prev.currentDrawdown ? currentEquity : prev.troughEquity,
      maxDrawdown: Math.max(prev.maxDrawdown, currentDD),
      drawdownDays: ddDays,
      recoveryTarget: newPeak,
    };
  }

  // ── CIRCUIT BREAKER ─────────────────────────────────────────

  private handleError(error: unknown): void {
    const errors = this.state.connection.consecutiveErrors + 1;
    const circuitOpen = errors >= MONITOR_CONFIG.MAX_CONSECUTIVE_ERRORS;

    this.state = {
      ...this.state,
      connection: {
        consecutiveErrors: errors,
        circuitBreakerOpen: circuitOpen,
        dataFreshness: errors > 2 ? 'STALE' : 'DELAYED',
      },
    };

    if (circuitOpen) {
      setTimeout(() => {
        this.state = {
          ...this.state,
          connection: { ...this.state.connection, consecutiveErrors: 0, circuitBreakerOpen: false },
        };
      }, MONITOR_CONFIG.CIRCUIT_BREAKER_RESET_MS);
    }

    this.emit();
  }

  // ── ACTUALIZACIÓN MANUAL DE PRECIOS ─────────────────────────

  updatePriceManual(ticker: string, price: number): void {
    const positions = this.state.positions.map(p => {
      if (p.ticker !== ticker) return p;
      return computePositionPnL({ ...p, livePrice: price, priceSource: 'MANUAL', lastUpdate: Date.now() });
    });
    const totalEquity = positions.reduce((s, p) => s + p.marketValue, 0) + this.state.cashBalance;
    this.state = {
      ...this.state,
      positions: positions.map(p => ({ ...p, weight: totalEquity > 0 ? p.marketValue / totalEquity : 0 })),
      totalEquity,
      totalUnrealizedPnL: positions.reduce((s, p) => s + p.unrealizedPnL, 0),
      lastUpdate: Date.now(),
    };
    this.emit();
  }
}

// ── SINGLETON ─────────────────────────────────────────────────

let _monitor: OlympusLiveMonitor | null = null;

export function getLiveMonitor(): OlympusLiveMonitor {
  if (!_monitor) _monitor = new OlympusLiveMonitor();
  return _monitor;
}

export function resetLiveMonitor(): void {
  _monitor?.stop();
  _monitor = null;
}
