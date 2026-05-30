// ============================================================
// src/core/tactical/types.ts
// Tipos del Motor Táctico Olympus
// CAMBIOS v2:
//   + TacticalPosition.atrAtEntry: ATR en EUR en el momento de
//     apertura — necesario para trailing stop y horizonte correcto
//     sin depender del fallback 2% hardcodeado.
//   + TacticalPosition.sectorGroup: grupo sectorial asignado al
//     abrir la posición — necesario para que correlationManager
//     use el sector real (p.type era OpportunityType, nunca
//     coincidía con las claves de SECTOR_GROUPS).
//   + TacticalPosition.currency: divisa nativa del activo.
//   + TacticalAsset.dataSource: indica si los datos provienen del
//     símbolo primario, fallback definido, o ultra-fallback
//     sectorial. Las oportunidades generadas con ultra-fallback
//     se descartan automáticamente en buildOpportunity.
//   + TacticalAsset.priceEur: precio convertido a EUR para sizing.
// ============================================================

export type OpportunityType =
  | 'BLOOD_IN_STREETS'
  | 'MOMENTUM_BREAKOUT'
  | 'MEAN_REVERSION'
  | 'OVERSOLD_BOUNCE'
  | 'SECTOR_ROTATION'
  | 'EVENT_DRIVEN';

// ── Evento corporativo (earnings, splits, etc) ───────────────
// v7 NEW: para tracking de earnings y auto-cierre
export interface CorporateEvent {
  ticker:              string;
  type:                'EARNINGS' | 'SPLIT' | 'SPINOFF' | 'BUYBACK' | 'IPO_LOCKUP' | 'REGULATORY';
  date:                string;  // ISO date (YYYY-MM-DD)
  impact:              'HIGH' | 'MEDIUM' | 'LOW';
  detail:              string;  // Descripción (ej: "Apple Q3 2026 earnings")
  autoCloseDaysAhead?: number;  // default 5 para EARNINGS HIGH
}

export type SignalStrength    = 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';
export type TrendDirection    = 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
export type OpportunityStatus = 'OPEN' | 'CLOSED_TP' | 'CLOSED_SL' | 'CLOSED_TIME' | 'CLOSED_MANUAL';

// ── Origen de los datos de mercado ───────────────────────────
// CRITICAL: las oportunidades generadas con 'ultra-fallback' usan
// datos de un activo distinto (p.ej. GLD para URNU.DE). Deben
// excluirse del motor de señales para evitar trades en el activo
// equivocado con tesis del activo de fallback.
export type DataSource = 'primary' | 'fallback' | 'ultra-fallback';

// ── Indicadores técnicos calculados ─────────────────────────
export interface TechnicalIndicators {
  price:       number;
  ma20:        number;
  ma50:        number;
  ma200:       number;
  rsi2:        number;
  rsi14:       number;
  rsiWeekly:   number;
  macdLine:    number;
  macdSignal:  number;
  macdHist:    number;
  adx:         number;
  efficiencyRatio: number;
  atr14:       number;
  atr:         number;     // alias de atr14 para compatibilidad
  atrPct:      number;
  bbUpper:     number;
  bbMiddle:    number;
  bbLower:     number;
  bbWidth:     number;
  zScore20:    number;
  zScore50:    number;
  volumeRatio: number;
  trend:       TrendDirection;
  aboveMA200:  boolean;
  aboveMA50:   boolean;
  aboveMA20:   boolean;
  drawdownFrom52wHigh: number;
}

// ── Señal individual de oportunidad ─────────────────────────
export interface TacticalSignal {
  type:        OpportunityType;
  strength:    SignalStrength;
  score:       number;
  active:      boolean;
  description: string;
  condition:   string;
}

// ── Activo del universo táctico ──────────────────────────────
export interface TacticalAsset {
  ticker:      string;
  name:        string;
  sector:      string;
  type:        'ETF' | 'ETC' | 'CRYPTO' | 'STOCK';
  exchange:    string;
  currency:    'EUR' | 'USD' | 'GBP';
  price:       number;    // En divisa nativa del activo
  priceEur:    number;    // NUEVO: precio convertido a EUR para sizing
  closes:      number[];
  volumes:     number[];
  high52w:     number;
  low52w:      number;
  indicators:  TechnicalIndicators | null;
  signals:     TacticalSignal[];
  totalScore:  number;
  lastUpdated: string | null;
  dataSource:  DataSource;  // NUEVO: origen de los datos
  hasRealOHLC: boolean;     // NUEVO: OHLC real desde Yahoo, no aproximado sintético
  earningsYield?: number;
  per?: number;
  eps?: number;
}

// ── Oportunidad identificada ─────────────────────────────────
export interface TacticalOpportunity {
  id:          string;
  asset:       TacticalAsset;
  type:        OpportunityType;
  score:       number;
  entryPrice:  number;    // En EUR (convertido para sizing uniforme)
  stopLoss:    number;    // En EUR
  takeProfit1: number;    // En EUR
  takeProfit2: number;    // En EUR
  riskReward:  number;
  reasoning:   string;
  detectedAt:  string;
  expiresAt:   string;
  activeSignals: TacticalSignal[];
}

// ── Posición táctica abierta ─────────────────────────────────
export interface TacticalPosition {
  id:           string;
  ticker:       string;
  name:         string;
  type:         OpportunityType;
  currency:     'EUR' | 'USD' | 'GBP';   // NUEVO: divisa nativa del activo
  sectorGroup:  string;                   // NUEVO: grupo sectorial real (de asset.sector)
  entryDate:    string;
  entryPrice:   number;    // En divisa nativa
  entryPriceEur: number;   // NUEVO: precio de entrada en EUR
  shares:       number;
  capitalRisked: number;   // En EUR
  totalInvested: number;   // En EUR (normalizado)
  stopLoss:     number;    // En divisa nativa
  takeProfit1:  number;    // En divisa nativa
  takeProfit2:  number;    // En divisa nativa
  // NUEVO: ATR en EUR en el momento de apertura
  // Crítico para trailing stop y horizonte — reemplaza el 2% hardcodeado
  atrAtEntry:   number;    // En EUR
  status:       OpportunityStatus;
  currentPrice: number;    // En divisa nativa
  exitDate:     string | null;
  exitPrice:    number | null;   // En divisa nativa
  exitReason:   string | null;
  unrealizedPnL:    number;      // En EUR
  unrealizedPnLPct: number;
  realizedPnL:      number | null; // En EUR
  realizedPnLPct:   number | null;
  daysOpen:         number;
  maxDaysAllowed:   number;
  expectedDaysToTP1: number;
  expectedDaysToTP2: number;
  daysToBreakeven:   number;
  timingScore:       number;
  optimalDaysTP1:    number;
  optimalDaysTP2:    number;
  optimalProbTP1:    number;
  // ── v5 NEW: Earnings tracking & auto-close ──────────────
  daysToEarnings?:   number;      // Días hasta próximos earnings (si hay)
  shouldAutoClose?:  boolean;     // Flag: debe cerrarse automáticamente
  autoCloseReason?:  string;      // Motivo de auto-cierre (earnings, etc)
  // ── v6 NEW: Trailing stop en TP2 ─────────────────────────
  trailingStopActive?: boolean;   // True tras cerrar 50% en TP1
  trailingStopPrice?:  number;    // Precio activado del trailing stop
  trailingStopDistance?: number;  // Distancia ATR (en EUR) para el trailing
  highestPriceSinceTP1?: number;  // Precio más alto alcanzado tras TP1
}

// ── Opciones para abrir posición con stop-loss dinámico ─────────
// v5 NEW: permite usar MA50 + ATR en lugar del stop-loss clásico
export interface OpenPositionOptions {
  useDynamicStopLoss?: boolean;  // Si true: usa MA50+ATR, si false: entry-ATR (clásico)
  ma50?: number;                  // Media móvil de 50 periodos (en EUR, requerido si useDynamicStopLoss)
}

// ── Configuración del motor táctico ─────────────────────────
export interface TacticalConfig {
  tacticalCapitalEur:    number;
  maxCapitalPerTrade:    number;
  riskPerTradePct:       number;
  maxOpenPositions:      number;
  minScore:              number;
  requireAboveMA200:     boolean;
  minRiskReward:         number;
  maxAtrPct:             number;
  maxDaysPerTrade:       number;
  trailingStop:          boolean;
  maxPctFromDefensiveLiq: number;
}

// ── Estado del motor táctico ─────────────────────────────────
export interface TacticalEngineState {
  config:              TacticalConfig;
  opportunities:       TacticalOpportunity[];
  openPositions:       TacticalPosition[];
  closedPositions:     TacticalPosition[];
  totalRealizedPnL:    number;
  totalUnrealizedPnL:  number;
  winRate:             number;
  avgRiskReward:       number;
  profitFactor:        number;
  maxDrawdown:         number;   // Incluye posiciones abiertas y cerradas
  capitalUsed:         number;   // En EUR
  capitalAvailable:    number;   // En EUR
  lastScreened:        string | null;
}

// ── Resultado del screener ───────────────────────────────────
import type { RegimeState } from './marketRegimeFilter';

export interface BacktestStub {
  metrics: unknown[];
  ran: boolean;
}

export interface ScreenerResult {
  assets:        TacticalAsset[];
  opportunities: TacticalOpportunity[];
  topPicks:      TacticalOpportunity[];
  screenedAt:    string;   // FIX: typo 'screennedAt' corregido
  errors:        string[];
  warnings:      string[]; // NUEVO: warnings de ultra-fallbacks usados
  marketRegime?: RegimeState;
  backtest:      BacktestStub; // stub para compatibilidad con dashboard
}