export function executiveSummary(
  erp: number,
  liquidity: number,
  probability: number
): string {
  return `
Mercado con ERP ${erp.toFixed(2)} y liquidez ${liquidity > 0 ? "expansiva" : "restrictiva"}.
Probabilidad de alcanzar objetivo: ${(probability * 100).toFixed(1)}%.
Asignación ajustada a régimen actual.
`
}