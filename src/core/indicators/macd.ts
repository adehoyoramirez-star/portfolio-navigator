import { calculateEMA } from "./ema"

export interface MACDResult {
  macd: number
  signal: number
  histogram: number
}

export function calculateMACD(prices: number[]): MACDResult {
  const ema12 = calculateEMA(prices, 12)
  const ema26 = calculateEMA(prices, 26)
  const macd = ema12 - ema26
  const signal = macd * 0.8
  const histogram = macd - signal

  return { macd, signal, histogram }
}