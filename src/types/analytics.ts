export interface Recommendation {
  ticker: string
  action: "BUY" | "SELL" | "HOLD"
  conviction: number
  rationale: string
}