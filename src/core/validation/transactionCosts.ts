// ===============================================
// ARCHIVO: src/core/validation/transactionCosts.ts
// TRANSACTION COST MODEL — Bid-Ask + Market Impact
// ===============================================
//
// OBJETIVO 10/10:
//   El backtest actual usa 15bps fijo. En la realidad:
//   - BTC-EUR puede tener spreads de 20-50bps en exchanges europeos
//   - URNU.DE (uranio, ilíquido) puede tener spreads > 15bps
//   - Market impact escala con el tamaño de la orden (modelo square-root)
//   - Fixed costs (brokerage mínima) aplican a portfolios pequeños
//
// MODELO:
//   totalCost = fixedCost + spreadCost + impactCost
//   spreadCost = halfSpread × turnover
//   impactCost = impactCoeff × sqrt(turnover / dailyVolume) × volatility
//
// REFERENCIAS:
//   - Almgren, Thum, Hauptmann, Li (2005) "Equity Market Impact"
//   - Kissell (2013) "The Science of Algorithmic Trading"
//   - BIS (2021) "Transaction costs in OTC derivatives"
// ===============================================

export interface CostParams {
  /** Half-spread en bps (bid-ask/2) */
  halfSpreadBps: number;
  /** Volatilidad diaria típica (para modelo de impacto) */
  dailyVol: number;
  /** Volumen diario típico en € (para normalizar impacto) */
  dailyVolumeEur: number;
  /** Coeficiente de impacto de mercado (calibrado por clase de activo) */
  impactCoefficient: number;
}

// ── Parámetros por activo ──────────────────────────────────────────────────

const ASSET_COST_PARAMS: Record<string, CostParams> = {
  'BTC-EUR': {
    halfSpreadBps: 15,       // exchanges europeos: Kraken/Bitstamp ~30bps spread → half=15
    dailyVol: 0.035,         // ~3.5% daily vol (~60% anual/√252)
    dailyVolumeEur: 50_000,   // asumiendo órdenes < €50k/día (retail)
    impactCoefficient: 0.15,  // crypto tiene más slippage por fragmentación de liquidez
  },
  'VVSM.DE': {
    halfSpreadBps: 4,         // ETF líquido, Xetra ~8bps spread
    dailyVol: 0.016,          // ~25% anual
    dailyVolumeEur: 100_000,
    impactCoefficient: 0.08,
  },
  'URNU.DE': {
    halfSpreadBps: 12,        // ETF uranio, menos líquido
    dailyVol: 0.022,          // ~35% anual
    dailyVolumeEur: 30_000,
    impactCoefficient: 0.15,  // ilíquido → más impacto
  },
  'EMXC.DE': {
    halfSpreadBps: 6,         // ETF EM ex-China
    dailyVol: 0.011,          // ~18% anual
    dailyVolumeEur: 80_000,
    impactCoefficient: 0.10,  // EM tiene más impacto que DM
  },
  'PPFB.DE': {
    halfSpreadBps: 3,         // Gold ETC, muy líquido
    dailyVol: 0.009,          // ~15% anual
    dailyVolumeEur: 150_000,
    impactCoefficient: 0.05,  // oro = máxima liquidez
  },
  '0P00000WLG.F': {
    halfSpreadBps: 3,         // MSCI World fund, líquido
    dailyVol: 0.010,          // ~16% anual
    dailyVolumeEur: 200_000,
    impactCoefficient: 0.05,
  },
};

// Coste fijo por operación (brokerage mínimo o comisión fija)
const FIXED_COST_EUR = 1.00; // €1 por operación (Degiro/IBKR típico)

// ── Modelo de coste total ──────────────────────────────────────────────────

export interface TradeCostInput {
  ticker: string;
  /** Peso actual (antes del rebalanceo) */
  oldWeight: number;
  /** Peso objetivo (después del rebalanceo) */
  newWeight: number;
  /** Valor total del portfolio en € */
  portfolioValueEur: number;
  /** Precio actual del activo en € */
  priceEur: number;
}

export interface TradeCostOutput {
  ticker: string;
  /** Turnover en € (valor absoluto negociado) */
  turnoverEur: number;
  /** Coste total de la operación en € */
  totalCostEur: number;
  /** Coste en bps del portfolio */
  costBps: number;
  /** Desglose */
  breakdown: {
    fixedCost: number;
    spreadCost: number;
    impactCost: number;
  };
}

export function computeTradeCost(input: TradeCostInput): TradeCostOutput {
  const params = ASSET_COST_PARAMS[input.ticker];
  if (!params) {
    // Fallback: usar coste fijo de 10bps
    const turnoverEur = Math.abs(input.newWeight - input.oldWeight) * input.portfolioValueEur;
    return {
      ticker: input.ticker,
      turnoverEur,
      totalCostEur: turnoverEur * 0.0010 + FIXED_COST_EUR,
      costBps: 10,
      breakdown: { fixedCost: FIXED_COST_EUR, spreadCost: turnoverEur * 0.0010, impactCost: 0 },
    };
  }

  const turnoverWeight = Math.abs(input.newWeight - input.oldWeight);
  
  // Si no hay cambio, no hay coste
  if (turnoverWeight < 1e-6) {
    return {
      ticker: input.ticker,
      turnoverEur: 0,
      totalCostEur: 0,
      costBps: 0,
      breakdown: { fixedCost: 0, spreadCost: 0, impactCost: 0 },
    };
  }

  const turnoverEur = turnoverWeight * input.portfolioValueEur;

  // ── 1. Fixed cost ───────────────────────────────────────────────────
  const fixedCost = FIXED_COST_EUR;

  // ── 2. Spread cost ──────────────────────────────────────────────────
  // half-spread × turnover (pagas el spread al entrar Y al salir)
  const spreadCost = turnoverEur * (params.halfSpreadBps / 10_000);

  // ── 3. Market impact (Almgren square-root model) ────────────────────
  // impact = σ × coefficient × sqrt(Q / V)
  // donde σ = daily vol, Q = tamaño de la orden, V = volumen diario
  const participationRate = turnoverEur / Math.max(1, params.dailyVolumeEur);
  const impactFactor = params.impactCoefficient * Math.sqrt(Math.min(1, participationRate));
  const impactCost = turnoverEur * params.dailyVol * impactFactor;

  // ── Total ───────────────────────────────────────────────────────────
  const totalCostEur = fixedCost + spreadCost + impactCost;
  const costBps = (totalCostEur / input.portfolioValueEur) * 10_000;

  return {
    ticker: input.ticker,
    turnoverEur,
    totalCostEur,
    costBps,
    breakdown: {
      fixedCost,
      spreadCost,
      impactCost,
    },
  };
}

// ── Coste total de un rebalanceo completo ──────────────────────────────────

export interface RebalanceCostInput {
  oldAllocations: Record<string, number>;
  newAllocations: Record<string, number>;
  portfolioValueEur: number;
  prices: Record<string, number>;
}

export interface RebalanceCostOutput {
  trades: TradeCostOutput[];
  totalCostEur: number;
  totalCostBps: number;
  turnoverPct: number;  // % del portfolio rotado
}

export function computeRebalanceCost(input: RebalanceCostInput): RebalanceCostOutput {
  const trades: TradeCostOutput[] = [];
  let totalCostEur = 0;
  let totalTurnover = 0;

  for (const ticker of Object.keys({ ...input.oldAllocations, ...input.newAllocations })) {
    const oldW = input.oldAllocations[ticker] ?? 0;
    const newW = input.newAllocations[ticker] ?? 0;

    if (Math.abs(newW - oldW) < 1e-6) continue;

    const tradeCost = computeTradeCost({
      ticker,
      oldWeight: oldW,
      newWeight: newW,
      portfolioValueEur: input.portfolioValueEur,
      priceEur: input.prices[ticker] ?? 100,
    });

    trades.push(tradeCost);
    totalCostEur += tradeCost.totalCostEur;
    totalTurnover += tradeCost.turnoverEur;
  }

  const turnoverPct = input.portfolioValueEur > 0
    ? totalTurnover / (2 * input.portfolioValueEur)  // ÷2 porque cada trade cuenta entrada+salida
    : 0;

  return {
    trades,
    totalCostEur,
    totalCostBps: input.portfolioValueEur > 0 ? (totalCostEur / input.portfolioValueEur) * 10_000 : 0,
    turnoverPct,
  };
}

// ── Coste anual estimado ───────────────────────────────────────────────────

export function estimateAnnualCost(
  avgRebalanceCostBps: number,
  rebalancesPerYear: number
): { annualCostBps: number; annualCostPct: number } {
  const annualCostBps = avgRebalanceCostBps * rebalancesPerYear;
  return {
    annualCostBps,
    annualCostPct: annualCostBps / 10_000,
  };
}

// ── Formateo ────────────────────────────────────────────────────────────────

export function formatCostBreakdown(rebalanceCost: RebalanceCostOutput): string {
  const lines = [
    '',
    '─── COSTES DE TRANSACCIÓN (Modelo Realista) ───',
    `  Coste total rebalanceo: €${rebalanceCost.totalCostEur.toFixed(2)} (${rebalanceCost.totalCostBps.toFixed(2)} bps)`,
    `  Turnover: ${(rebalanceCost.turnoverPct * 100).toFixed(1)}% del portfolio`,
    '',
    '  Desglose por activo:',
  ];

  for (const t of rebalanceCost.trades) {
    const costEmoji = t.costBps > 15 ? '🔴' : t.costBps > 8 ? '🟡' : '🟢';
    lines.push(
      `  ${costEmoji} ${t.ticker.padEnd(16)} | €${t.totalCostEur.toFixed(2).padStart(6)} (${t.costBps.toFixed(1).padStart(4)} bps) | spread: ${t.breakdown.spreadCost.toFixed(2)} impact: ${t.breakdown.impactCost.toFixed(2)}`
    );
  }

  return lines.join('\n');
}
