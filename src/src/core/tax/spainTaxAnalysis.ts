// ===============================================
// ARCHIVO: src/core/tax/spainTaxAnalysis.ts
// Análisis fiscal España — IRPF base del ahorro
// ===============================================
// Tramos 2025 (base del ahorro):
//   0       — 6.000€  → 19%
//   6.000   — 50.000€ → 21%
//   50.000  — 200.000€→ 23%
//   200.000 — 300.000€→ 27%
//   > 300.000€        → 28%
//
// Reglas clave España:
//   - Sin distinción corto/largo plazo (todo a base del ahorro)
//   - Pérdidas del año compensan ganancias del año
//   - Norma 2 meses: si vendes ETF con pérdidas y recompras < 2 meses → Hacienda anula la pérdida
//   - BTC: mismo tratamiento que ETFs (base del ahorro)
//   - ETFs listados: NO tienen régimen de traspaso sin tributar (los fondos sí)
// ===============================================

export interface SpainTaxBracket {
  from: number;
  to: number;
  rate: number;
}

export const SPAIN_TAX_BRACKETS_2025: SpainTaxBracket[] = [
  { from: 0,       to: 6000,     rate: 0.19 },
  { from: 6000,    to: 50000,    rate: 0.21 },
  { from: 50000,   to: 200000,   rate: 0.23 },
  { from: 200000,  to: 300000,   rate: 0.27 },
  { from: 300000,  to: Infinity, rate: 0.28 },
];

// Caída histórica esperada (caso central — percentil 50) por activo y zona de ciclo
export const EXPECTED_DRAWDOWN: Record<string, Record<string, number>> = {
  "BTC-EUR": {
    CAUTION: 0.35, DANGER: 0.60, EXTREME: 0.78,
  },
  "URNU.DE": {
    CAUTION: 0.25, DANGER: 0.50, EXTREME: 0.70,
  },
  "VVSM.DE": {
    CAUTION: 0.20, DANGER: 0.40, EXTREME: 0.55,
  },
  "PPFB.DE": {
    CAUTION: 0.15, DANGER: 0.25, EXTREME: 0.35,
  },
};

// ── Impuesto con tramos progresivos ──────────────────────────────
export function calculateSpainTax(gain: number): {
  taxAmount: number;
  effectiveRate: number;
  breakdown: Array<{ bracket: string; taxable: number; rate: number; tax: number }>;
} {
  if (gain <= 0) return { taxAmount: 0, effectiveRate: 0, breakdown: [] };

  let remaining = gain;
  let totalTax  = 0;
  const breakdown: Array<{ bracket: string; taxable: number; rate: number; tax: number }> = [];

  for (const b of SPAIN_TAX_BRACKETS_2025) {
    if (remaining <= 0) break;
    const taxable = Math.min(remaining, b.to - b.from);
    const tax     = taxable * b.rate;
    if (taxable > 0) {
      breakdown.push({
        bracket: b.to === Infinity
          ? `>${(b.from / 1000).toFixed(0)}k€`
          : `${(b.from / 1000).toFixed(0)}k–${(b.to / 1000).toFixed(0)}k€`,
        taxable, rate: b.rate, tax,
      });
    }
    totalTax  += tax;
    remaining -= taxable;
  }
  return { taxAmount: totalTax, effectiveRate: gain > 0 ? totalTax / gain : 0, breakdown };
}

// ── Análisis por activo ───────────────────────────────────────────
export interface TaxAnalysis {
  ticker: string;
  name: string;
  // Posición
  sharesOwned: number;
  avgBuyPrice: number;
  currentPrice: number;
  latentGainTotal: number;
  latentGainPct: number;
  // Venta propuesta
  sharesToSell: number;
  trimPct: number;
  saleProceeds: number;
  realizedGain: number;
  // Fiscal
  taxGross: number;
  effectiveRate: number;
  taxBreakdown: Array<{ bracket: string; taxable: number; rate: number; tax: number }>;
  lossOffsetUsed: number;
  taxAfterOffset: number;
  netProceeds: number;
  // Análisis de conveniencia
  cycleZone: string;
  expectedDrawdownPct: number;
  expectedLossEuros: number;
  taxVsLossRatio: number;
  breakEvenPrice: number;
  // Veredicto
  verdict: "CONVIENE" | "ANALIZAR" | "NO_CONVIENE" | "EN_PERDIDAS";
  verdictEmoji: string;
  verdictReason: string;
  urgency: "HIGH" | "MEDIUM" | "LOW";
}

export interface PortfolioTaxSummary {
  analyses: TaxAnalysis[];
  totalLatentGains: number;
  totalLatentLosses: number;
  availableLossOffset: number;
  compensationOpportunity: boolean;
  generalAdvice: string[];
}

// ── Función principal ─────────────────────────────────────────────
export function analyzeSpainTax(
  assets: Array<{ ticker: string; name: string; shares: number; avgPrice: number; price: number }>,
  sellSuggestions: Array<{ ticker: string; sharesToSell: number; trimPct: number; cycleZone?: string }>
): PortfolioTaxSummary {

  // Calcular plusvalías/minusvalías latentes de TODA la cartera
  const allGainLoss = assets.map(a => ({
    ticker: a.ticker,
    gain:   (a.price - a.avgPrice) * a.shares,
  }));

  const totalGains  = allGainLoss.filter(x => x.gain > 0).reduce((s, x) => s + x.gain, 0);
  const totalLosses = allGainLoss.filter(x => x.gain < 0).reduce((s, x) => s + Math.abs(x.gain), 0);

  // Pool de pérdidas disponibles para compensar (se consume activo a activo)
  let lossPool = totalLosses;
  const analyses: TaxAnalysis[] = [];

  for (const sell of sellSuggestions) {
    const asset = assets.find(a => a.ticker === sell.ticker);
    if (!asset) continue;

    const sharesToSell  = sell.sharesToSell;
    const saleProceeds  = sharesToSell * asset.price;
    const costBasis     = sharesToSell * asset.avgPrice;
    const realizedGain  = saleProceeds - costBasis;
    const latentTotal   = (asset.price - asset.avgPrice) * asset.shares;
    const latentPct     = asset.avgPrice > 0 ? (asset.price - asset.avgPrice) / asset.avgPrice : 0;

    // Impuesto bruto
    const { taxAmount: taxGross, effectiveRate, breakdown } = calculateSpainTax(Math.max(0, realizedGain));

    // Compensar con pérdidas del pool
    const gainToOffset    = Math.max(0, realizedGain);
    const offsetUsed      = Math.min(lossPool, gainToOffset);
    lossPool             -= offsetUsed;
    const { taxAmount: taxAfterOffset } = calculateSpainTax(Math.max(0, gainToOffset - offsetUsed));
    const netProceeds     = saleProceeds - taxAfterOffset;

    // Conveniencia
    const cycleZone     = sell.cycleZone ?? "CAUTION";
    const expectedDD    = EXPECTED_DRAWDOWN[sell.ticker]?.[cycleZone] ?? 0.30;
    const currentValSold = sharesToSell * asset.price;
    const expectedLoss   = currentValSold * expectedDD;

    // Ratio impuesto / pérdida esperada:
    //   < 0.25 → claramente conviene (pagas mucho menos de lo que evitas perder)
    //   0.25–0.55 → conviene con buena convicción
    //   0.55–0.80 → analizar caso a caso
    //   > 0.80 → no conviene tanto
    const ratio         = expectedLoss > 0 ? taxAfterOffset / expectedLoss : 1;

    // Break-even: precio al que caerías a "empate" con el impuesto pagado
    const breakEvenPrice = sharesToSell > 0
      ? asset.price - (taxAfterOffset / sharesToSell)
      : 0;

    let verdict: TaxAnalysis["verdict"];
    let verdictEmoji: string;
    let verdictReason: string;
    let urgency: TaxAnalysis["urgency"];

    if (realizedGain <= 0) {
      verdict = "EN_PERDIDAS";
      verdictEmoji = "🟢";
      verdictReason = `Posición en pérdidas (${(latentPct * 100).toFixed(1)}%). Vender genera una minusvalía que puedes usar para compensar otras ganancias del año. Sin coste fiscal.`;
      urgency = "MEDIUM";
    } else if (ratio < 0.25) {
      verdict = "CONVIENE";
      verdictEmoji = "✅";
      verdictReason = `Impuesto (€${taxAfterOffset.toFixed(0)}) = ${(ratio * 100).toFixed(0)}% de la pérdida esperada (€${expectedLoss.toFixed(0)}). El coste fiscal es pequeño en comparación con el riesgo de ciclo.`;
      urgency = cycleZone === "EXTREME" ? "HIGH" : "HIGH";
    } else if (ratio < 0.55) {
      verdict = "CONVIENE";
      verdictEmoji = "✅";
      verdictReason = `Impuesto (€${taxAfterOffset.toFixed(0)}) = ${(ratio * 100).toFixed(0)}% de la pérdida esperada (€${expectedLoss.toFixed(0)}). Conviene reducir si tienes convicción sobre el techo.`;
      urgency = "MEDIUM";
    } else if (ratio < 0.80) {
      verdict = "ANALIZAR";
      verdictEmoji = "🟡";
      verdictReason = `Impuesto (€${taxAfterOffset.toFixed(0)}) = ${(ratio * 100).toFixed(0)}% de la pérdida esperada. La decisión depende de tu convicción sobre el ciclo y si tienes otras pérdidas para compensar.`;
      urgency = "LOW";
    } else {
      verdict = "NO_CONVIENE";
      verdictEmoji = "🔴";
      verdictReason = `Impuesto (€${taxAfterOffset.toFixed(0)}) casi iguala la pérdida esperada (€${expectedLoss.toFixed(0)}). Solo ejecutar si la señal es EXTREME y la convicción es máxima.`;
      urgency = "LOW";
    }

    analyses.push({
      ticker: sell.ticker, name: asset.name,
      sharesOwned: asset.shares, avgBuyPrice: asset.avgPrice,
      currentPrice: asset.price,
      latentGainTotal: latentTotal, latentGainPct: latentPct,
      sharesToSell, trimPct: sell.trimPct,
      saleProceeds, realizedGain,
      taxGross, effectiveRate, taxBreakdown: breakdown,
      lossOffsetUsed: offsetUsed, taxAfterOffset, netProceeds,
      cycleZone, expectedDrawdownPct: expectedDD,
      expectedLossEuros: expectedLoss,
      taxVsLossRatio: ratio,
      breakEvenPrice,
      verdict, verdictEmoji, verdictReason, urgency,
    });
  }

  // Consejos generales del portfolio
  const generalAdvice: string[] = [];
  if (totalLosses > 0 && totalGains > 0) {
    generalAdvice.push(`Tienes €${totalLosses.toFixed(0)} en minusvalías latentes que pueden compensar €${Math.min(totalLosses, totalGains).toFixed(0)} de ganancias — reduce el impuesto si planeas vender con ganancias.`);
  }
  if (totalLosses > 0) {
    const rule = assets.some(a => a.ticker === "BTC-EUR")
      ? "ETFs: norma de 2 meses (no recomprar el mismo ETF en 2 meses para que la pérdida sea deducible). BTC: norma de 1 año."
      : "Norma de 2 meses: no recomprar el mismo ETF en menos de 2 meses o Hacienda anula la pérdida.";
    generalAdvice.push(rule);
  }
  if (analyses.some(a => a.verdict === "CONVIENE" && a.cycleZone === "EXTREME")) {
    generalAdvice.push("Considera ejecutar las ventas en diciembre si ya tienes muchas ganancias realizadas este año — para diferir el impuesto al ejercicio siguiente.");
  }

  return {
    analyses,
    totalLatentGains:        totalGains,
    totalLatentLosses:       totalLosses,
    availableLossOffset:     totalLosses,
    compensationOpportunity: totalLosses > 0 && totalGains > 0,
    generalAdvice,
  };
}