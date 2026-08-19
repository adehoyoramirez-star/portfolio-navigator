// ================================================
// ARCHIVO: src/core/backtest/compositeMetrics.ts
// Cálculo puro del Composite Strategy (Olympus Core + BTC Satellite).
// Extraído de BacktestPanel.tsx para poder testear la alineación de BTC.
// La fórmula composite vive centralizada en ./composite.ts (auditoría R9).
// ================================================

import { btcSatPct, olyPct as olyPctFraction } from "./composite";

export interface CompositeMetrics {
  cagr: number;
  sharpe: number;
  maxDrawdown: number;
  calmar: number;
  volatility: number;
  finalValue: number;
  totalReturn: number;
}

export interface CompositeInput {
  olympusDailyValues: number[]; // valor del portfolio Olympus por día (recLen elementos)
  btcPrices: number[];          // serie completa de precios BTC-EUR
  olympusPct: number;           // 0-100 (% asignado a Olympus, el resto a BTC)
  initialCapital: number;
}

const RISK_FREE_RATE = 0.04;
// FIX-ANNUALIZATION-365: datos de calendario → 365 días/año (ver constants.ts).
const TRADING_DAYS = 365;

export function computeCompositeMetrics(input: CompositeInput): CompositeMetrics {
  const { olympusDailyValues, btcPrices, olympusPct, initialCapital } = input;
  const btcPct = btcSatPct(olympusPct);
  const olyPct = olyPctFraction(olympusPct);

  const olympusRets = olympusDailyValues.map((v, i) => {
    const prev = i === 0 ? initialCapital : olympusDailyValues[i - 1];
    return prev > 0 ? v / prev - 1 : 0;
  });

  const btcLen = btcPrices.length;
  const recLen = olympusDailyValues.length;
  // FIX-FORENSIC-COMPOSITE: alinear el FINAL de BTC con el FINAL de la ventana del backtest.
  // Antes `btcLen - recLen - 252` evaluaba a 0 (doble resta del lookback), desalineando BTC
  // ~1 año respecto a Olympus → MaxDD -34% en vez de -45%.
  const btcStart = Math.max(0, btcLen - recLen);
  const btcRets: number[] = [];
  for (let i = 0; i < recLen; i++) {
    const idx = btcStart + i;
    if (idx > 0 && idx < btcLen && btcPrices[idx - 1] > 0 && btcPrices[idx] > 0) {
      btcRets.push(btcPrices[idx] / btcPrices[idx - 1] - 1);
    } else {
      btcRets.push(0);
    }
  }

  const compositeRets = olympusRets.map((or, i) => olyPct * or + btcPct * (btcRets[i] ?? 0));

  let value = initialCapital;
  let peak = initialCapital;
  let maxDD = 0;
  for (const r of compositeRets) {
    value *= (1 + r);
    if (value > peak) peak = value;
    const dd = (value - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  const years = compositeRets.length / TRADING_DAYS;
  const totalRet = value / initialCapital - 1;
  const cagr = years > 0 && totalRet > -1 ? Math.pow(1 + totalRet, 1 / years) - 1 : 0;
  const mean = compositeRets.reduce((a, b) => a + b, 0) / compositeRets.length;
  const vol = Math.sqrt(compositeRets.reduce((s, r) => s + (r - mean) ** 2, 0) / compositeRets.length * TRADING_DAYS);
  const rfDaily = RISK_FREE_RATE / TRADING_DAYS;
  const excess = compositeRets.map(r => r - rfDaily);
  const exMean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const exStd = Math.sqrt(excess.reduce((s, r) => s + (r - exMean) ** 2, 0) / excess.length * TRADING_DAYS);
  const sharpe = exStd > 0 ? (exMean * TRADING_DAYS) / exStd : 0;
  const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;

  return { cagr, sharpe, maxDrawdown: maxDD, calmar, volatility: vol, finalValue: value, totalReturn: totalRet };
}
