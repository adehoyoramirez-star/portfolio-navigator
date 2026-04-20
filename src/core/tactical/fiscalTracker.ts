// ============================================================
// src/core/tactical/fiscalTracker.ts
// Fiscalidad España IRPF para el motor táctico
//
// IRPF 2025 — Rentas del ahorro (ganancias/pérdidas capital):
//   Hasta €6.000:    19%
//   €6.001–€50.000:  21%
//   €50.001–€200.000:23%
//   Más de €200.000: 27%
//
// CLAVE: menos de 1 año = renta del ahorro (mismos tramos)
// COMPENSACIÓN: minusvalías compensan plusvalías mismo año
// RULE 2 MONTHS: si vendes con pérdidas, no puedes recomprar
//   en los 2 meses siguientes el mismo activo (anti-wash sale)
// ============================================================

import type { TacticalPosition } from './types';

// ── Tramos IRPF rentas del ahorro 2025 ───────────────────────
const IRPF_TRAMOS = [
  { limit: 6000,    rate: 0.19 },
  { limit: 50000,   rate: 0.21 },
  { limit: 200000,  rate: 0.23 },
  { limit: Infinity, rate: 0.27 },
];

// ── Calcular impuesto sobre ganancia ─────────────────────────
export function calcTax(gainEur: number): number {
  if (gainEur <= 0) return 0;
  let remaining = gainEur;
  let tax       = 0;
  let prev      = 0;
  for (const tramo of IRPF_TRAMOS) {
    const band = tramo.limit - prev;
    if (remaining <= 0) break;
    const taxable = Math.min(remaining, band);
    tax      += taxable * tramo.rate;
    remaining -= taxable;
    prev      = tramo.limit;
  }
  return tax;
}

// ── Ganancia neta después de impuestos ───────────────────────
export function netAfterTax(gainEur: number): number {
  return gainEur - calcTax(gainEur);
}

// ── Tipo efectivo ─────────────────────────────────────────────
export function effectiveTaxRate(gainEur: number): number {
  if (gainEur <= 0) return 0;
  return calcTax(gainEur) / gainEur;
}

// ── Resumen fiscal anual ──────────────────────────────────────
export interface FiscalSummary {
  year:             number;
  totalGains:       number;    // Suma de plusvalías brutas
  totalLosses:      number;    // Suma de minusvalías (positivo = pérdida)
  netGain:          number;    // Ganancia neta compensada
  taxOwed:          number;    // Impuesto estimado a pagar
  effectiveRate:    number;    // Tipo efectivo %
  tradeCount:       number;
  winningTrades:    number;
  losingTrades:     number;
  // Operaciones pendientes de compensar del año anterior
  lossesPendingComp: number;   // Puedes compensar en los 4 años siguientes
}

export function calcFiscalSummary(
  closedPositions: TacticalPosition[],
  year = new Date().getFullYear()
): FiscalSummary {
  const yearPositions = closedPositions.filter(p => {
    const exitYear = p.exitDate ? new Date(p.exitDate).getFullYear() : 0;
    return exitYear === year;
  });

  let totalGains  = 0;
  let totalLosses = 0;

  yearPositions.forEach(p => {
    const pnl = p.realizedPnL ?? 0;
    if (pnl > 0) totalGains  += pnl;
    else         totalLosses += Math.abs(pnl);
  });

  const netGain      = totalGains - totalLosses;
  const taxOwed      = netGain > 0 ? calcTax(netGain) : 0;
  const effRate      = netGain > 0 ? taxOwed / netGain : 0;

  return {
    year,
    totalGains,
    totalLosses,
    netGain,
    taxOwed,
    effectiveRate:    effRate * 100,
    tradeCount:       yearPositions.length,
    winningTrades:    yearPositions.filter(p => (p.realizedPnL ?? 0) > 0).length,
    losingTrades:     yearPositions.filter(p => (p.realizedPnL ?? 0) <= 0).length,
    lossesPendingComp: netGain < 0 ? Math.abs(netGain) : 0,
  };
}

// ── Verificar regla 2 meses (anti-wash sale española) ────────
export function checkWashSaleRule(
  ticker:          string,
  closedPositions: TacticalPosition[]
): { blocked: boolean; unblocksAt: string | null; reason: string } {
  // Buscar la última venta con pérdida de este ticker
  const lastLoss = closedPositions
    .filter(p =>
      p.ticker === ticker &&
      (p.realizedPnL ?? 0) < 0 &&
      p.exitDate !== null
    )
    .sort((a, b) =>
      new Date(b.exitDate!).getTime() - new Date(a.exitDate!).getTime()
    )[0];

  if (!lastLoss?.exitDate) {
    return { blocked: false, unblocksAt: null, reason: 'Sin ventas anteriores con pérdida' };
  }

  const exitDate   = new Date(lastLoss.exitDate);
  const twoMonths  = new Date(exitDate.getTime() + 60 * 24 * 3600000);
  const now        = new Date();

  if (now < twoMonths) {
    return {
      blocked:    true,
      unblocksAt: twoMonths.toISOString(),
      reason:     `Vendiste ${ticker} con pérdida el ${exitDate.toLocaleDateString('es-ES')}. No puedes recomprar hasta el ${twoMonths.toLocaleDateString('es-ES')} (regla 2 meses IRPF).`,
    };
  }

  return { blocked: false, unblocksAt: null, reason: 'OK — más de 2 meses desde la última venta con pérdida' };
}

// ── Consejo de optimización fiscal ───────────────────────────
export function getFiscalAdvice(summary: FiscalSummary): string[] {
  const advice: string[] = [];

  if (summary.totalGains > 0 && summary.totalLosses > 0) {
    advice.push(`Has compensado €${summary.totalLosses.toFixed(0)} de pérdidas contra €${summary.totalGains.toFixed(0)} de ganancias. Ahorro fiscal: ~€${calcTax(summary.totalLosses).toFixed(0)}`);
  }

  if (summary.netGain > 50000) {
    advice.push(`⚠️ Ganancia neta >€50k — parte tributa al 23%. Considera diferir algunas realizaciones a enero del siguiente año.`);
  }

  if (summary.lossesPendingComp > 0) {
    advice.push(`Tienes €${summary.lossesPendingComp.toFixed(0)} de minusvalías a compensar en los próximos 4 años. Puede reducir futuros impuestos.`);
  }

  if (summary.taxOwed > 0) {
    advice.push(`Impuesto estimado: €${summary.taxOwed.toFixed(0)} (tipo efectivo: ${summary.effectiveRate.toFixed(1)}%). Provisiona este capital antes de fin de año.`);
  }

  return advice;
}

// ── Precio de venta necesario para no tributar más del X% ────
export function calcOptimalExit(
  entryPrice:   number,
  shares:       number,
  maxTaxRate:   number = 0.21   // 21% = tramo hasta €50k
): number {
  // Buscar precio donde la ganancia todavía tributa al tramo deseado
  // Si ya estás en tramo 19%: hasta €6k de ganancia
  const maxGain = maxTaxRate <= 0.19 ? 6000 : maxTaxRate <= 0.21 ? 50000 : 200000;
  const maxGainPerShare = maxGain / shares;
  return entryPrice + maxGainPerShare;
}
