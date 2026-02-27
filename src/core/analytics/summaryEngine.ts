export function generateMarketSummary(
  sp500Trend: number,
  vix: number,
  liquidity: number
): string {

  if (sp500Trend > 0 && vix < 20 && liquidity > 0)
    return "Mercado en fase de expansión con liquidez favorable y volatilidad controlada."

  if (vix > 30)
    return "Mercado bajo estrés elevado; priorizar gestión de riesgo."

  if (liquidity < 0)
    return "Condiciones financieras restrictivas; reducir exposición cíclica."

  return "Entorno mixto; mantener posicionamiento táctico."
}