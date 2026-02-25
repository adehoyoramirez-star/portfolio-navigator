// src/lib/erp.ts

export interface ERPResult {
  earningsYield: number;
  riskFree: number;
  erp: number;
}

/**
 * Calcula ERP institucional:
 * ERP = Earnings Yield - Risk Free
 * Earnings Yield = 1 / PER
 */
export function calculateERP(
  per: number,
  riskFreeRate: number // en porcentaje, ej: 4.2
): ERPResult {

  if (!per || per <= 0) {
    throw new Error("PER inválido");
  }

  const earningsYield = 1 / per;        // decimal
  const riskFree = riskFreeRate / 100;  // convertir a decimal

  const erp = earningsYield - riskFree;

  return {
    earningsYield,
    riskFree,
    erp
  };
}