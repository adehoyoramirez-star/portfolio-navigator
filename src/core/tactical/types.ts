// ============================================================
// src/core/tactical/types.ts
// Tipos del Motor Táctico Olympus — Oportunidades de Mercado
// ============================================================

export type OpportunityType =
  | 'BLOOD_IN_STREETS'   // Caída brutal por pánico — mean reversion
  | 'MOMENTUM_BREAKOUT'  // Ruptura de resistencia con volumen
  | 'MEAN_REVERSION'     // Desviación extrema de la media
  | 'OVERSOLD_BOUNCE'    // RSI muy bajo + soporte técnico
  | 'SECTOR_ROTATION'    // Dinero rotando hacia sector infraponderado
  | 'EVENT_DRIVEN';      // Reacción exagerada a evento puntual

export type SignalStrength = 'WEAK' | 'MODERATE' | 'STRONG' | 'EXTREME';
export type TrendDirection = 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
export type OpportunityStatus = 'OPEN' | 'CLOSED_TP' | 'CLOSED_SL' | 'CLOSED_TIME' | 'CLOSED_MANUAL';

// ── Indicadores técnicos calculados ─────────────────────────
export interface TechnicalIndicators {
  // Precios
  price:       number;
  ma20:        number;
  ma50:        number;
  ma200:       number;
  // RSI
  rsi2:        number;   // Para mean reversion (< 5 = extremo)
  rsi14:       number;   // Estándar
  rsiWeekly:   number;   // Confirmación en timeframe superior
  // Momentum
  macdLine:    number;
  macdSignal:  number;
  macdHist:    number;
  adx:         number;   // > 25 = tendencia fuerte
  // Volatilidad / Bandas
  bbUpper:     number;   // Bollinger Band superior (2σ, 20d)
  bbMiddle:    number;
  bbLower:     number;
  bbWidth:     number;   // (Upper-Lower)/Middle — compresión < 0.05
  atr14:       number;   // Average True Range 14 periodos
  atrPct:      number;   // ATR como % del precio
  // Z-Score
  zScore20:    number;   // Desviaciones desde MA20
  zScore50:    number;   // Desviaciones desde MA50
  // Volumen
  volumeRatio: number;   // Volumen hoy / media 20 días (> 3 = capitulación)
  // Tendencia
  trend:       TrendDirection;
  aboveMA200:  boolean;
  aboveMA50:   boolean;
  aboveMA20:   boolean;
  // Drawdown desde máximo 52 semanas
  drawdownFrom52wHigh: number;  // Negativo, ej: -0.35 = -35% desde máximo
}

// ── Señal individual de oportunidad ─────────────────────────
export interface TacticalSignal {
  type:        OpportunityType;
  strength:    SignalStrength;
  score:       number;           // 0-100
  active:      boolean;
  description: string;
  condition:   string;           // La condición técnica que la activa
}

// ── Activo del universo táctico ──────────────────────────────
export interface TacticalAsset {
  ticker:      string;
  name:        string;
  sector:      string;
  type:        'ETF' | 'ETC' | 'CRYPTO' | 'INDEX';
  exchange:    string;
  currency:    'EUR' | 'USD' | 'GBP';  // <- Añadido 'GBP'
  // Datos de mercado (actualizados al cargar)
  price:       number;
  closes:      number[];         // Histórico de cierres
  volumes:     number[];         // Histórico de volúmenes
  high52w:     number;
  low52w:      number;
  // Indicadores calculados
  indicators:  TechnicalIndicators | null;
  signals:     TacticalSignal[];
  totalScore:  number;           // 0-100, agregado de todas las señales
  lastUpdated: string | null;
  // Fundamentales (Value factor)
  earningsYield?: number;       // E/P = 1/PER
  per?: number;                 // Price/Earnings
  eps?: number;                 // Earnings per share
}

// ── Oportunidad identificada (candidata a operar) ────────────
export interface TacticalOpportunity {
  id:          string;
  asset:       TacticalAsset;
  type:        OpportunityType;
  score:       number;           // 0-100
  entryPrice:  number;
  stopLoss:    number;           // Precio de stop
  takeProfit1: number;           // Primer objetivo (R:R 1.5:1)
  takeProfit2: number;           // Segundo objetivo (R:R 2.5:1)
  riskReward:  number;           // Ratio riesgo/recompensa
  reasoning:   string;           // Por qué es oportunidad
  detectedAt:  string;           // Timestamp
  expiresAt:   string;           // Pierde validez si no se ejecuta
  // Señales activas que la justifican
  activeSignals: TacticalSignal[];
}

// ── Posición táctica abierta ─────────────────────────────────
export interface TacticalPosition {
  id:           string;
  ticker:       string;
  name:         string;
  type:         OpportunityType;
  // Entrada
  entryDate:    string;
  entryPrice:   number;
  shares:       number;          // Entero para ETFs, decimal para crypto/ETC
  capitalRisked: number;         // € en riesgo (entrada - stopLoss) * shares
  totalInvested: number;         // entryPrice * shares
  // Niveles
  stopLoss:     number;
  takeProfit1:  number;
  takeProfit2:  number;
  // Estado
  status:       OpportunityStatus;
  currentPrice: number;
  // Salida (si está cerrada)
  exitDate:     string | null;
  exitPrice:    number | null;
  exitReason:   string | null;
  // P&L
  unrealizedPnL:    number;      // Si sigue abierta
  unrealizedPnLPct: number;
  realizedPnL:      number | null; // Si está cerrada
  realizedPnLPct:   number | null;
  // Días en posición
  daysOpen:     number;
  maxDaysAllowed: number;        // Por defecto 10 días hábiles
}

// ── Configuración del motor táctico ─────────────────────────
export interface TacticalConfig {
  // Capital
  tacticalCapitalEur:    number;  // € dedicados al motor táctico
  maxCapitalPerTrade:    number;  // % máx por operación (0.30 = 30%)
  riskPerTradePct:       number;  // % del capital en riesgo por trade (0.01 = 1%)
  maxOpenPositions:      number;  // Máx posiciones simultáneas (default: 4)
  // Filtros de entrada
  minScore:              number;  // Score mínimo para considerar (0-100)
  requireAboveMA200:     boolean; // Solo comprar activos sobre MA200
  minRiskReward:         number;  // R:R mínimo (1.5 recomendado)
  maxAtrPct:             number;  // ATR máximo como % (evitar activos demasiado volátiles)
  // Gestión
  maxDaysPerTrade:       number;  // Días máximos en una posición
  trailingStop:          boolean; // Usar trailing stop
  // Integración Olympus
  maxPctFromDefensiveLiq: number; // % máx de la liquidez defensiva usable (0.20 = 20%)
}

// ── Estado del motor táctico ─────────────────────────────────
export interface TacticalEngineState {
  config:              TacticalConfig;
  opportunities:       TacticalOpportunity[];
  openPositions:       TacticalPosition[];
  closedPositions:     TacticalPosition[];
  // Métricas
  totalRealizedPnL:    number;
  totalUnrealizedPnL:  number;
  winRate:             number;    // % operaciones ganadoras
  avgRiskReward:       number;    // R:R promedio realizado
  profitFactor:        number;    // Sum(ganancias) / Sum(pérdidas)
  maxDrawdown:         number;    // Drawdown máximo del motor táctico
  capitalUsed:         number;    // Capital actual en posiciones abiertas
  capitalAvailable:    number;    // Capital disponible para nuevas posiciones
  lastScreened:        string | null;
}

// ── Resultado del screener ───────────────────────────────────
export interface ScreenerResult {
  assets:       TacticalAsset[];
  opportunities: TacticalOpportunity[];
  topPicks:     TacticalOpportunity[];   // Top 5 por score
  screennedAt:  string;
  errors:       string[];
}