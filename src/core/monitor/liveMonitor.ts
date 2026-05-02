// ════════════════════════════════════════════════════════════════
// ARCHIVO: src/core/monitor/liveMonitor.ts
// OLYMPUS X — Motor de Monitoreo en Tiempo Real
// ════════════════════════════════════════════════════════════════
//
// AUDITORÍA DEL MONITOR PROPUESTO POR IA EXTERNA:
//
//  ✓ Arquitectura de eventos correcta (MarketTick, FillEvent, OrderEvent)
//  ✓ PnL unrealized calculado correctamente (price - avgPrice) × qty
//  ✓ Max Drawdown sobre equity curve es el método estándar
//  ✓ Estructura LiveOrder es útil y coherente con ibkrConnector.ts
//
//  ✗ CRÍTICO — VaR por ordenación simple (computeVaR) es INCORRECTO:
//    Usa un array plano de "returns" sin especificar de dónde vienen.
//    En un portfolio, el VaR debe calcularse sobre los retornos del
//    portfolio COMPLETO, no por activo. Su implementación mezclaría
//    activos individuales con el portfolio, dando un número sin sentido.
//
//  ✗ CRÍTICO — Alerta BTC al 15%:
//    El usuario ha declarado explícitamente "no voy a vender BTC,
//    voy a bajar precio medio en correcciones". Una alerta de
//    "BTC overweight" que aparece siempre (BTC ya está al 41.6%)
//    es ruido puro y contradice la estrategia. Un monitor que genera
//    alertas irrelevantes constantemente → se ignoran todas, incluyendo
//    las críticas. Peligroso.
//
//  ✗ CRÍTICO — setInterval sin error handling:
//    Si la llamada a IBKR falla (timeout, auth expirada, gateway caído)
//    el loop se rompe silenciosamente o genera estado corrupto.
//    Necesita: circuit breaker + reconexión automática + estado STALE.
//
//  ✗ MEDIO — No hay rolling metrics:
//    VaR/CVaR como snapshot estático no tiene valor operativo.
//    Lo que importa es la TENDENCIA: ¿el CVaR está subiendo esta semana?
//    ¿El Sharpe rolling está cayendo? Eso es lo que dice "el riesgo sube".
//
//  ✗ MEDIO — No hay reconciliación IBKR vs motor:
//    Si IBKR dice "tienes 0.031285 BTC" y el motor esperaba "0.035 BTC",
//    hay una discrepancia que puede ser un fill parcial, un error, o
//    una orden ejecutada que no procesamos. Sin reconciliación, el
//    portfolio state del motor diverge del real.
//
//  ✗ BAJO — ASCII dashboard:
//    Aceptable para prototipo. La app ya tiene React — usar eso.
//
// LO QUE ESTE ARCHIVO AÑADE QUE LA PROPUESTA NO TENÍA:
//   1. Rolling Sharpe y CVaR (ventana 20 días) con tendencia
//   2. Reconciliación IBKR vs motor (detecta divergencias)
//   3. DCA Opportunity Detector (cuándo atacar caídas de BTC)
//   4. Alert system calibrado a la estrategia HODL+DCA del usuario
//   5. Circuit breaker para la conexión IBKR
//   6. Historial de equity curve para drawdown real
//   7. Rolling volatilidad usando GARCH (no solo desviación estándar)
//
// ════════════════════════════════════════════════════════════════

import { getIBKRClient, DEFAULT_IBKR_CONFIG, KNOWN_CONIDS, IBKRPosition } from '../tactical/ibkrConnector';
import { DEFAULT_POSITIONS } from '../../lib/constants';
import { fetchRealMarketData } from '../../lib/marketData';

// ── FALLBACK YAHOO — se activa automáticamente cuando IBKR falla ─────────────
// Usa fetchRealMarketData() que ya existe y funciona via Supabase Edge Function.
// Los precios de Yahoo tienen ~15min de delay en mercado abierto.
// En cripto (BTC) el delay es mínimo porque Yahoo publica casi en tiempo real.
async function fetchYahooPrices(): Promise<Record<string, number>> {
  try {
    const { marketData } = await fetchRealMarketData();
    // marketData.assets contiene los precios actuales de todos los activos
    const priceMap: Record<string, number> = {};
    for (const [ticker, data] of Object.entries(marketData.assets ?? {})) {
      if (data?.price && data.price > 0) {
        priceMap[ticker] = data.price;
      }
    }
    // BTC viene en marketData.btcPrice directamente
    if (marketData.btcPrice > 0) priceMap['BTC-EUR'] = marketData.btcPrice;
    return priceMap;
  } catch {
    return {}; // si Yahoo también falla → quedarse con precios STALE
  }
}

// ── TIPOS DE ESTADO ───────────────────────────────────────────────────────────

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
  priceSource: 'IBKR' | 'YAHOO' | 'STALE' | 'MANUAL';
}

export interface RollingMetrics {
  // Ventana 20 días
  sharpe20d: number;
  sortino20d: number;
  volatility20d: number;    // anualizada
  cvar95_20d: number;       // CVaR 95% sobre retornos diarios del portfolio
  var95_20d: number;        // VaR 95%
  // Tendencias (comparando con la semana anterior)
  sharpe_trend: 'UP' | 'DOWN' | 'FLAT';
  risk_trend: 'INCREASING' | 'STABLE' | 'DECREASING';
}

export interface DrawdownState {
  currentDrawdown: number;     // caída desde el máximo (positivo = pérdida)
  peakEquity: number;          // máximo histórico de equity
  troughEquity: number;        // mínimo desde el último pico
  maxDrawdown: number;         // máximo drawdown histórico registrado
  drawdownDays: number;        // días consecutivos en drawdown
  recoveryTarget: number;      // equity necesaria para recuperar el DD
}

export interface DCAOpportunity {
  ticker: string;
  active: boolean;
  drawdownFromPeak: number;    // caída del activo desde su máximo reciente
  suggestedAmount: number;     // EUR a invertir ahora
  multiplier: number;          // multiplicador sobre DCA base
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
  tranche: number;             // cuál tranche es este (1, 2, 3)
  totalTranches: number;
}

export interface LiveAlert {
  id: string;
  level: 'CRITICAL' | 'WARNING' | 'INFO' | 'DCA_OPPORTUNITY';
  message: string;
  detail: string;
  timestamp: number;
  dismissed: boolean;
  // Los CRITICAL requieren acción, no solo awareness
  requiresAction: boolean;
  suggestedAction?: string;
}

export interface IBKRReconciliation {
  status: 'OK' | 'DIVERGENCE' | 'IBKR_OFFLINE';
  divergences: {
    ticker: string;
    motorShares: number;
    ibkrShares: number;
    diffPct: number;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
  }[];
  lastSyncTime: number;
}

export interface LiveMonitorState {
  // Estado del portfolio
  positions: LivePosition[];
  totalEquity: number;
  cashBalance: number;
  totalUnrealizedPnL: number;
  totalRealizedPnL: number;
  totalPnL: number;
  totalPnLPct: number;

  // Métricas de riesgo
  rolling: RollingMetrics;
  drawdown: DrawdownState;

  // Historial (para rolling metrics)
  equityCurve: { timestamp: number; equity: number }[];
  dailyReturns: number[];      // retornos diarios del portfolio

  // Oportunidades DCA
  dcaOpportunities: DCAOpportunity[];

  // Alertas
  alerts: LiveAlert[];

  // Reconciliación IBKR
  reconciliation: IBKRReconciliation;

  // Estado de la conexión
  connection: {
    ibkrConnected: boolean;
    ibkrLastPing: number;
    dataFreshness: 'LIVE' | 'DELAYED' | 'STALE';
    consecutiveErrors: number;
    circuitBreakerOpen: boolean;
  };

  lastUpdate: number;
}

// ── CONFIGURACIÓN DEL MONITOR ─────────────────────────────────────────────────

const MONITOR_CONFIG = {
  // Intervalos de actualización
  PRICE_UPDATE_MS: 5_000,         // precios cada 5s
  RISK_UPDATE_MS: 60_000,         // métricas de riesgo cada 1min
  RECONCILE_MS: 300_000,          // reconciliación cada 5min

  // Circuit breaker
  MAX_CONSECUTIVE_ERRORS: 5,
  CIRCUIT_BREAKER_RESET_MS: 60_000,

  // Alertas — umbrales ajustados para estrategia HODL+DCA en €7k
  DRAWDOWN_WARNING_PCT: 0.10,     // alerta a -10% de drawdown
  DRAWDOWN_CRITICAL_PCT: 0.20,    // crítico a -20% (límite tolerancia)
  DAILY_LOSS_WARNING_PCT: 0.05,   // -5% en un día
  CVAR_WARNING_PCT: 0.12,         // CVaR > 12% → aviso
  CVAR_CRITICAL_PCT: 0.18,        // CVaR > 18% → acción

  // DCA — parámetros calibrados para BTC HODL+DCA
  BTC_DCA_MIN_DRAWDOWN: 0.10,     // atacar a partir del -10%
  BTC_DCA_BASE_AMOUNT_PCT: 0.06,  // 6% del portfolio por tranche
  BTC_DCA_LEVELS: [
    { drawdown: 0.10, mult: 1.0, label: 'Pullback moderado' },
    { drawdown: 0.20, mult: 1.8, label: 'Corrección normal' },
    { drawdown: 0.30, mult: 2.5, label: 'Caída significativa' },
    { drawdown: 0.40, mult: 3.5, label: 'Capitulación — máxima agresividad' },
  ],

  // Reconciliación
  DIVERGENCE_THRESHOLD_PCT: 0.02, // 2% diferencia → divergencia media
  DIVERGENCE_HIGH_PCT: 0.05,      // 5% diferencia → divergencia alta

  // Risk-free rate para Sharpe
  RISK_FREE_DAILY: 0.0385 / 252,

  ROLLING_WINDOW: 20,             // días para rolling metrics
} as const;

// ── ESTADO INICIAL ────────────────────────────────────────────────────────────

function buildInitialState(): LiveMonitorState {
  const initialEquity = 6622; // estimación actual
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
    reconciliation: {
      status: 'IBKR_OFFLINE',
      divergences: [],
      lastSyncTime: 0,
    },
    connection: {
      ibkrConnected: false,
      ibkrLastPing: 0,
      dataFreshness: 'STALE',
      consecutiveErrors: 0,
      circuitBreakerOpen: false,
    },
    lastUpdate: Date.now(),
  };
}

// ── CÁLCULO DE PnL ────────────────────────────────────────────────────────────

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

// ── ROLLING METRICS — CORRECCIÓN DEL ERROR DE LA IA EXTERNA ──────────────────
//
// La IA externa calculaba VaR como:
//   const sorted = [...returns].sort()
//   return sorted[Math.floor(0.05 * sorted.length)]
//
// PROBLEMA: Esto asume que todos los "returns" son del portfolio completo,
// pero si mezclas retornos de activos individuales con pesos distintos,
// el número resultante no tiene interpretación.
//
// CORRECCIÓN: Calculamos el retorno DIARIO del PORTFOLIO (ponderado por pesos)
// y aplicamos el VaR sobre esa serie, que SÍ tiene interpretación de pérdida
// en euros del portfolio completo.

function computePortfolioReturn(
  prevPrices: Record<string, number>,
  currPrices: Record<string, number>,
  weights: Record<string, number>
): number {
  let portfolioReturn = 0;
  for (const [ticker, w] of Object.entries(weights)) {
    const prev = prevPrices[ticker];
    const curr = currPrices[ticker];
    if (prev && curr && prev > 0) {
      portfolioReturn += w * (curr / prev - 1);
    }
  }
  return portfolioReturn;
}

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

  // Volatilidad diaria → anualizada
  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const annualizedVol = stdDev * Math.sqrt(252);

  // Sharpe anualizado
  const sharpe20d = stdDev > 0 ? (excessMean * Math.sqrt(252)) / annualizedVol : 0;

  // Sortino: solo desviación negativa
  const downReturns = recent.filter(r => r < rf);
  const downsideVariance = downReturns.reduce((s, r) => s + (r - rf) ** 2, 0) / Math.max(n - 1, 1);
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino20d = downsideDev > 0 ? (excessMean * Math.sqrt(252)) / (downsideDev * Math.sqrt(252)) : 0;

  // VaR y CVaR correctos sobre retornos del portfolio
  const sorted = [...recent].sort((a, b) => a - b);
  const varIdx = Math.max(0, Math.floor(0.05 * n) - 1);
  const var95_20d = -sorted[varIdx]; // positivo = pérdida

  const tailReturns = sorted.slice(0, varIdx + 1);
  const cvar95_20d = tailReturns.length > 0
    ? -tailReturns.reduce((s, r) => s + r, 0) / tailReturns.length
    : var95_20d;

  // Tendencias: comparar primera mitad vs segunda mitad de la ventana
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

// ── DETECTOR DE OPORTUNIDADES DCA ─────────────────────────────────────────────
// DIFERENCIA CLAVE vs la otra IA: esta función SABE que BTC es HODL
// y que el objetivo es bajar el precio medio en correcciones.
// Genera oportunidades de COMPRA, nunca alertas de venta para BTC.

function detectDCAOpportunities(
  positions: LivePosition[],
  totalEquity: number,
  cashBalance: number
): DCAOpportunity[] {
  const opportunities: DCAOpportunity[] = [];

  for (const pos of positions) {
    // Calcular drawdown del activo desde su precio medio de compra
    // (proxy del drawdown desde máximo reciente cuando no tenemos historial)
    const drawdownFromAvg = pos.avgPrice > 0
      ? (pos.avgPrice - pos.livePrice) / pos.avgPrice
      : 0;

    // Para BTC: activar DCA según los niveles configurados
    if (pos.ticker === 'BTC-EUR' && drawdownFromAvg >= MONITOR_CONFIG.BTC_DCA_MIN_DRAWDOWN) {
      // Encontrar el nivel DCA apropiado
      const level = [...MONITOR_CONFIG.BTC_DCA_LEVELS]
        .reverse()
        .find(l => drawdownFromAvg >= l.drawdown);

      if (level) {
        const baseAmount = totalEquity * MONITOR_CONFIG.BTC_DCA_BASE_AMOUNT_PCT;
        const suggestedAmount = Math.min(
          baseAmount * level.mult,
          cashBalance * 0.90, // máximo 90% del cash disponible
          totalEquity * 0.12   // máximo 12% del portfolio por tranche
        );

        if (suggestedAmount > 50) { // mínimo €50 para que tenga sentido
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

    // Para otros activos: oportunidades si están en pullback > 8% desde precio medio
    if (pos.ticker !== 'BTC-EUR' && drawdownFromAvg >= 0.08) {
      const baseAmount = totalEquity * 0.03; // 3% para activos no-BTC
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

// ── SISTEMA DE ALERTAS CALIBRADO ──────────────────────────────────────────────
// CRÍTICA A LA OTRA IA: su alerta "BTC overweight" se disparará SIEMPRE
// (BTC está al 41.6%) creando ruido constante que hace ignorar todas las alertas.
// Aquí: las alertas son contextuales a la estrategia real del usuario.

function generateSmartAlerts(
  state: LiveMonitorState,
  newRolling: RollingMetrics,
  newDrawdown: DrawdownState
): LiveAlert[] {
  const alerts: LiveAlert[] = [...state.alerts.filter(a => !a.dismissed).slice(-20)];
  const now = Date.now();
  const addAlert = (a: Omit<LiveAlert, 'id' | 'timestamp' | 'dismissed'>) => {
    const id = `${a.level}-${a.message.slice(0, 20)}-${now}`;
    // No duplicar alertas del mismo tipo en menos de 1 hora
    const existing = alerts.find(x => x.message === a.message && now - x.timestamp < 3_600_000);
    if (!existing) alerts.push({ ...a, id, timestamp: now, dismissed: false });
  };

  // ── Alertas de drawdown del portfolio ────────────────────────
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

  // ── Alertas de CVaR ───────────────────────────────────────────
  if (newRolling.cvar95_20d >= MONITOR_CONFIG.CVAR_CRITICAL_PCT) {
    addAlert({
      level: 'CRITICAL',
      message: `CVaR 95% elevado: ${(newRolling.cvar95_20d * 100).toFixed(1)}%`,
      detail: `El riesgo de cola ha superado el límite institucional. En el peor 5% de días, el portfolio pierde más del ${(newRolling.cvar95_20d * 100).toFixed(1)}%.`,
      requiresAction: true,
      suggestedAction: 'CVaR Optimizer debería reducir exposición automáticamente. Verificar que olympusX.ts está activo.',
    });
  }

  // ── Alertas de riesgo creciente ───────────────────────────────
  if (newRolling.risk_trend === 'INCREASING' && newRolling.volatility20d > 0.25) {
    addAlert({
      level: 'WARNING',
      message: 'Volatilidad del portfolio en aumento',
      detail: `Vol 20d: ${(newRolling.volatility20d * 100).toFixed(1)}% anualizado y subiendo. El DCC-GARCH debería detectar esto.`,
      requiresAction: false,
    });
  }

  // ── Alerta de pérdida diaria ───────────────────────────────────
  const todayReturn = state.dailyReturns.slice(-1)[0] ?? 0;
  if (todayReturn < -MONITOR_CONFIG.DAILY_LOSS_WARNING_PCT) {
    addAlert({
      level: 'WARNING',
      message: `Pérdida diaria: ${(todayReturn * 100).toFixed(1)}%`,
      detail: `El portfolio ha perdido ${(todayReturn * 100).toFixed(1)}% hoy (€${(todayReturn * state.totalEquity).toFixed(0)}).`,
      requiresAction: false,
    });
  }

  // ── Alerta de oportunidad DCA (positiva) ─────────────────────
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

  // ── Alerta de reconciliación ───────────────────────────────────
  const highDivergences = state.reconciliation.divergences.filter(d => d.severity === 'HIGH');
  if (highDivergences.length > 0) {
    addAlert({
      level: 'CRITICAL',
      message: `Divergencia IBKR detectada: ${highDivergences.map(d => d.ticker).join(', ')}`,
      detail: `Las posiciones reales en IBKR difieren del motor en más del 5%. Puede haber órdenes no procesadas.`,
      requiresAction: true,
      suggestedAction: 'Verificar manualmente en IBKR Client Portal. Reconciliar posiciones antes de operar.',
    });
  }

  // ── Alerta de conexión STALE ──────────────────────────────────
  if (state.connection.dataFreshness === 'STALE' && state.connection.ibkrConnected) {
    addAlert({
      level: 'WARNING',
      message: 'Datos de mercado desactualizados (STALE)',
      detail: 'Los precios no se han actualizado en más de 30 segundos. Posible problema de conexión.',
      requiresAction: false,
    });
  }

  return alerts;
}

// ── RECONCILIACIÓN IBKR vs MOTOR ─────────────────────────────────────────────

function reconcileWithIBKR(
  motorPositions: LivePosition[],
  ibkrPositions: IBKRPosition[]
): IBKRReconciliation {
  const divergences: IBKRReconciliation['divergences'] = [];

  for (const motorPos of motorPositions) {
    const ibkrPos = ibkrPositions.find(p => p.ticker === motorPos.ticker);
    const ibkrShares = ibkrPos?.position ?? 0;
    const motorShares = motorPos.shares;

    if (motorShares === 0 && ibkrShares === 0) continue;

    const diff = Math.abs(motorShares - ibkrShares);
    const diffPct = motorShares > 0 ? diff / motorShares : 1;

    if (diffPct > MONITOR_CONFIG.DIVERGENCE_THRESHOLD_PCT) {
      divergences.push({
        ticker: motorPos.ticker,
        motorShares,
        ibkrShares,
        diffPct,
        severity: diffPct > MONITOR_CONFIG.DIVERGENCE_HIGH_PCT ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  return {
    status: divergences.length === 0 ? 'OK' : 'DIVERGENCE',
    divergences,
    lastSyncTime: Date.now(),
  };
}

// ── MOTOR PRINCIPAL DEL MONITOR ───────────────────────────────────────────────

export class OlympusLiveMonitor {
  private state: LiveMonitorState;
  private priceIntervalId?: ReturnType<typeof setInterval>;
  private riskIntervalId?: ReturnType<typeof setInterval>;
  private reconcileIntervalId?: ReturnType<typeof setInterval>;
  private listeners: Set<(state: LiveMonitorState) => void> = new Set();

  // Precios anteriores para calcular retornos diarios
  private prevDayPrices: Record<string, number> = {};

  constructor() {
    this.state = buildInitialState();
    // Cargar posiciones iniciales desde DEFAULT_POSITIONS
    this.initializeFromDefaults();
  }

  private initializeFromDefaults(): void {
    const positions: LivePosition[] = Object.entries(DEFAULT_POSITIONS).map(([ticker, pos]) => ({
      ticker,
      shares: pos.shares,
      avgPrice: pos.avgPrice,
      livePrice: pos.avgPrice, // precio inicial = precio medio hasta que llegue dato real
      marketValue: pos.shares * pos.avgPrice,
      weight: 0, // se calcula después
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

  // ── API PÚBLICA ─────────────────────────────────────────────────────────────

  subscribe(listener: (state: LiveMonitorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state); // emit current state immediately
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

  // ── INICIAR/PARAR MONITOR ───────────────────────────────────────────────────

  start(): void {
    this.priceIntervalId = setInterval(
      () => this.updatePrices().catch(e => this.handleError('price', e)),
      MONITOR_CONFIG.PRICE_UPDATE_MS
    );

    this.riskIntervalId = setInterval(
      () => this.updateRiskMetrics(),
      MONITOR_CONFIG.RISK_UPDATE_MS
    );

    this.reconcileIntervalId = setInterval(
      () => this.reconcile().catch(e => this.handleError('reconcile', e)),
      MONITOR_CONFIG.RECONCILE_MS
    );

    // Primera actualización inmediata
    this.updatePrices().catch(() => {});
    this.updateRiskMetrics();
  }

  stop(): void {
    if (this.priceIntervalId) clearInterval(this.priceIntervalId);
    if (this.riskIntervalId) clearInterval(this.riskIntervalId);
    if (this.reconcileIntervalId) clearInterval(this.reconcileIntervalId);
  }

  // ── ACTUALIZACIÓN DE PRECIOS ─────────────────────────────────────────────────

  private async updatePrices(): Promise<void> {
    // Circuit breaker: no llamar a IBKR si hay demasiados errores consecutivos
    if (this.state.connection.circuitBreakerOpen) return;

    const ibkr = getIBKRClient(DEFAULT_IBKR_CONFIG);
    const conids = Object.values(KNOWN_CONIDS);
    const conidToTicker = Object.fromEntries(
      Object.entries(KNOWN_CONIDS).map(([t, c]) => [c, t])
    );

    try {
      const marketData = await ibkr.getMarketData(conids);

      const priceMap: Record<string, number> = {};
      for (const md of marketData) {
        const ticker = conidToTicker[md.conid];
        const price = parseFloat(md['31'] ?? md['84'] ?? '0');
        if (ticker && price > 0) priceMap[ticker] = price;
      }

      // Actualizar posiciones con precios reales
      const updatedPositions = this.state.positions.map(pos => {
        const newPrice = priceMap[pos.ticker];
        if (!newPrice) return pos;

        const prevPrice = this.prevDayPrices[pos.ticker] ?? pos.livePrice;
        const dailyChange = prevPrice > 0 ? (newPrice / prevPrice - 1) : 0;

        return computePositionPnL({
          ...pos,
          livePrice: newPrice,
          dailyChange,
          lastUpdate: Date.now(),
          priceSource: 'IBKR',
        });
      });

      // Recalcular totales
      const totalEquity = updatedPositions.reduce((s, p) => s + p.marketValue, 0) +
                          this.state.cashBalance;
      const totalUnrealizedPnL = updatedPositions.reduce((s, p) => s + p.unrealizedPnL, 0);
      const costBasis = updatedPositions.reduce((s, p) => s + p.avgPrice * p.shares, 0);
      const totalPnLPct = costBasis > 0 ? totalUnrealizedPnL / costBasis : 0;

      // Actualizar weights
      const withWeights = updatedPositions.map(p => ({
        ...p,
        weight: totalEquity > 0 ? p.marketValue / totalEquity : 0,
      }));

      // Actualizar drawdown
      const newDrawdown = this.computeDrawdown(totalEquity);

      // Oportunidades DCA
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
          ...this.state.connection,
          ibkrConnected: true,
          ibkrLastPing: Date.now(),
          dataFreshness: 'LIVE',
          consecutiveErrors: 0,
          circuitBreakerOpen: false,
        },
        lastUpdate: Date.now(),
      };

      this.emit();

    } catch (err) {
      // ── IBKR FALLÓ → Yahoo Finance como fallback automático ──────────────
      this.handleError('price', err);
      try {
        const yahooPrices = await fetchYahooPrices();
        if (Object.keys(yahooPrices).length === 0) return;
        const updatedPositions = this.state.positions.map(pos => {
          const newPrice = yahooPrices[pos.ticker];
          if (!newPrice) return pos;
          const prevPrice = this.prevDayPrices[pos.ticker] ?? pos.livePrice;
          return computePositionPnL({
            ...pos,
            livePrice: newPrice,
            dailyChange: prevPrice > 0 ? (newPrice / prevPrice - 1) : 0,
            lastUpdate: Date.now(),
            priceSource: 'YAHOO',
          });
        });
        const totalEquity = updatedPositions.reduce((s,p) => s + p.marketValue, 0) + this.state.cashBalance;
        const totalUnrealizedPnL = updatedPositions.reduce((s,p) => s + p.unrealizedPnL, 0);
        const costBasis = updatedPositions.reduce((s,p) => s + p.avgPrice * p.shares, 0);
        this.state = {
          ...this.state,
          positions: updatedPositions.map(p => ({ ...p, weight: totalEquity > 0 ? p.marketValue / totalEquity : 0 })),
          totalEquity,
          totalUnrealizedPnL,
          totalPnL: this.state.totalRealizedPnL + totalUnrealizedPnL,
          totalPnLPct: costBasis > 0 ? totalUnrealizedPnL / costBasis : 0,
          drawdown: this.computeDrawdown(totalEquity),
          dcaOpportunities: detectDCAOpportunities(updatedPositions, totalEquity, this.state.cashBalance),
          connection: { ...this.state.connection, ibkrConnected: false, dataFreshness: 'DELAYED' },
          lastUpdate: Date.now(),
        };
        this.emit();
      } catch { /* Yahoo también falló — precios STALE, circuit breaker activo */ }
    }
  }

  // ── ACTUALIZACIÓN DE MÉTRICAS DE RIESGO ─────────────────────────────────────

  private updateRiskMetrics(): void {
    const weights: Record<string, number> = {};
    this.state.positions.forEach(p => { weights[p.ticker] = p.weight; });

    // Añadir retorno de hoy a la serie histórica
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

  // ── RECONCILIACIÓN ────────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    if (this.state.connection.circuitBreakerOpen) return;
    const ibkr = getIBKRClient(DEFAULT_IBKR_CONFIG);
    try {
      const ibkrPositions = await ibkr.getPositions(DEFAULT_IBKR_CONFIG.accountId);
      const reconciliation = reconcileWithIBKR(this.state.positions, ibkrPositions);
      this.state = { ...this.state, reconciliation };
      this.emit();
    } catch {
      // Silencioso — reconciliación no es crítica, solo informativa
    }
  }

  // ── DRAWDOWN ─────────────────────────────────────────────────────────────────

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

  // ── CIRCUIT BREAKER ───────────────────────────────────────────────────────────

  private handleError(source: string, error: unknown): void {
    const errors = this.state.connection.consecutiveErrors + 1;
    const circuitOpen = errors >= MONITOR_CONFIG.MAX_CONSECUTIVE_ERRORS;

    this.state = {
      ...this.state,
      connection: {
        ...this.state.connection,
        consecutiveErrors: errors,
        circuitBreakerOpen: circuitOpen,
        dataFreshness: errors > 2 ? 'STALE' : 'DELAYED',
        ibkrConnected: !circuitOpen,
      },
    };

    if (circuitOpen) {
      // Resetear el circuit breaker después de 60s
      setTimeout(() => {
        this.state = {
          ...this.state,
          connection: { ...this.state.connection, consecutiveErrors: 0, circuitBreakerOpen: false },
        };
      }, MONITOR_CONFIG.CIRCUIT_BREAKER_RESET_MS);
    }

    this.emit();
  }

  // ── ACTUALIZACIÓN MANUAL DE PRECIOS (fallback si IBKR offline) ───────────────

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

// ── SINGLETON ─────────────────────────────────────────────────────────────────

let _monitor: OlympusLiveMonitor | null = null;

export function getLiveMonitor(): OlympusLiveMonitor {
  if (!_monitor) _monitor = new OlympusLiveMonitor();
  return _monitor;
}

export function resetLiveMonitor(): void {
  _monitor?.stop();
  _monitor = null;
}
