import { calculateRSI } from "../indicators/rsi"
import { calculateMACD } from "../indicators/macd"
import { calculateEMA } from "../indicators/ema"

export type TradeSignal = "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL"

export function generateSignal(prices: number[]): TradeSignal {
  const rsi = calculateRSI(prices)
  const macd = calculateMACD(prices)
  const ema50 = calculateEMA(prices, 50)
  const ema200 = calculateEMA(prices, 200)

  let score = 0

  if (rsi < 30) score += 2
  if (rsi > 70) score -= 2
  if (macd.histogram > 0) score += 1
  if (macd.histogram < 0) score -= 1
  if (ema50 > ema200) score += 2
  if (ema50 < ema200) score -= 2

  if (score >= 4) return "STRONG_BUY"
  if (score >= 2) return "BUY"
  if (score <= -4) return "STRONG_SELL"
  if (score <= -2) return "SELL"
  return "HOLD"
}