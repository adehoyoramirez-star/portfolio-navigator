// ============================================================
// src/core/quant/quantEngine.ts
// MASTER ENGINE — conecta todos los módulos cuantitativos
// DATA → FACTORS → REGIME → RANKING → PORTFOLIO → RISK → EXECUTION
// ============================================================

import { computeFactorScores, getFactorExplanation, type FactorScores } from './factorEngine';
import { computeAllocation, type AllocationInput, type CapitalAllocation } from './capitalAllocator';

// ── Tipos ─────────────────────────────────────────────────────
export interface QuantAsset {
  ticker:         string;
  name:           string;
  sector:         string;
  price:          number;
  closes:         number[];
  // Indicadores técnicos (calculados externamente)
  rsi2:           number;
  zscore:         number;
  adx:            number;
  atrPct:         number;
  aboveMA200:     boolean;
  // Value — AUTO via Yahoo Finance
  earningsYield:  number;   // = EPS / Price = 1/PER
  per:            number;   // PER directo de Yahoo
  // Resultados del motor
  factorScores?:  FactorScores;
  finalScore?:    number;   // 0-100
  explanation?:   string;
}

export interface RiskParityAllocation {
  ticker:  string;
  weight:  number;   // Peso en el portfolio táctico
  euros:   number;   // Capital asignado en euros
  shares:  number;   // Unidades a comprar
}

export interface QuantResult {
  // Estado del sistema
  allocationState:   CapitalAllocation;
  regime:            string;
  // Activos rankeados
  ranked:            QuantAsset[];
  top5:              QuantAsset[];
  // Portfolio óptimo
  riskParity:        RiskParityAllocation[];
  // Sizing individual
  positionSizes:     Record<string, number>;
  // Métricas
  expectedEdge:      number;   // Expectancy del sistema
  kellyFraction:     number;   // Kelly criterion
  volatilityTarget:  number;   // Objetivo de volatilidad del portfolio
}

// ════════════════════════════════════════════════════════════
// PASO 1: CALCULAR FACTORES por activo
// ════════════════════════════════════════════════════════════
function scoreAssets(assets: QuantAsset[], regime: string): QuantAsset[] {
  return assets.map(a => {
    const factorScores = computeFactorScores({
      rsi2: a.rsi2, zscore: a.zscore, adx: a.adx,
      atrPct: a.atrPct, earningsYield: a.earningsYield, per: a.per,
    });
    const explanation = getFactorExplanation(factorScores);
    // Score 0-100 = composite * 100
    const finalScore = Math.round(factorScores.composite * 100);
    return { ...a, factorScores, finalScore, explanation };
  });
}

// ════════════════════════════════════════════════════════════
// PASO 2: FILTRAR por régimen + calidad
// ════════════════════════════════════════════════════════════
function filterByRegime(assets: QuantAsset[], regime: string): QuantAsset[] {
  if (regime === 'CRASH') return []; // STOP total
  return assets.filter(a => {
    if (!a.aboveMA200 && regime !== 'CRASH') return false; // Solo activos estructuralmente sanos
    const fs = a.factorScores;
    if (!fs) return false;
    if (regime === 'TRENDING_UP')   return fs.momentum > 0.3 || fs.value > 0.3;
    if (regime === 'TRENDING_DOWN') return fs.meanReversion > 0.6; // Muy selectivo en bajista
    if (regime === 'RANGING')       return fs.meanReversion > 0.4 || fs.value > 0.3;
    return fs.composite > 0.3;
  });
}

// ════════════════════════════════════════════════════════════
// PASO 3: RANKEAR por score compuesto
// ════════════════════════════════════════════════════════════
function rankAssets(assets: QuantAsset[]): QuantAsset[] {
  return [...assets].sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}

// ════════════════════════════════════════════════════════════
// PASO 4: RISK PARITY WEIGHTS
// Más peso a menor volatilidad → Sharpe estable
// Base académica: Bridgewater All Weather, Asness et al.
// ════════════════════════════════════════════════════════════
function calcRiskParity(
  assets: QuantAsset[],
  tacticalCapital: number
): RiskParityAllocation[] {
  if (assets.length === 0) return [];

  // Inversa de la volatilidad (ATR%) como proxy de riesgo
  const invVols = assets.map(a => a.atrPct > 0 ? 1 / a.atrPct : 1);
  const sumInvVol = invVols.reduce((s, v) => s + v, 0);

  return assets.map((a, i) => {
    const weight  = sumInvVol > 0 ? invVols[i] / sumInvVol : 1 / assets.length;
    const euros   = tacticalCapital * weight;
    const shares  = a.price > 0 ? Math.max(1, Math.floor(euros / a.price)) : 0;
    return { ticker: a.ticker, weight, euros, shares };
  });
}

// ════════════════════════════════════════════════════════════
// PASO 5: KELLY CRITERION
// f* = (p * b - q) / b
// p = win rate, b = avg win / avg loss, q = 1 - p
// Usamos fracción de Kelly (25%) para ser conservadores
// ════════════════════════════════════════════════════════════
function calcKelly(winRate: number, avgRR: number): number {
  const p = winRate / 100;
  const q = 1 - p;
  const b = avgRR;
  if (b <= 0) return 0.01;
  const kelly = (p * b - q) / b;
  // Quarter-Kelly para reducir varianza
  return Math.max(0.005, Math.min(0.04, kelly * 0.25));
}

// ════════════════════════════════════════════════════════════
// PASO 6: EXPECTANCY del sistema
// E = (winRate * avgWin) - (lossRate * avgLoss)
// ════════════════════════════════════════════════════════════
function calcExpectancy(winRate: number, avgRR: number, avgLoss: number): number {
  const p = winRate / 100;
  const avgWin = avgRR * avgLoss;
  return (p * avgWin) - ((1 - p) * avgLoss);
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════
export function runQuantEngine(
  assets:          QuantAsset[],
  regime:          string,
  allocInput:      AllocationInput,
  winRate:         number = 55,
  avgRR:           number = 1.5,
): QuantResult {
  // Asignación de capital
  const allocationState = computeAllocation(allocInput);

  // Pipeline cuantitativo
  const scored  = scoreAssets(assets, regime);
  const filtered = filterByRegime(scored, regime);
  const ranked  = rankAssets(filtered);
  const top5    = ranked.slice(0, 5);

  // Portfolio óptimo con Risk Parity
  const riskParity = calcRiskParity(top5, allocationState.tacticalEur);

  // Métricas del sistema
  const avgLoss       = allocationState.riskPerTradeEur;
  const kellyFraction = calcKelly(winRate, avgRR);
  const expectedEdge  = calcExpectancy(winRate, avgRR, avgLoss);

  // Sizing individual por activo
  const positionSizes: Record<string, number> = {};
  top5.forEach(a => {
    const riskEur = allocationState.tacticalEur * kellyFraction;
    const riskPerShare = a.price * a.atrPct * 1.5; // 1.5x ATR como stop
    positionSizes[a.ticker] = riskPerShare > 0 ? Math.max(1, Math.floor(riskEur / riskPerShare)) : 0;
  });

  return {
    allocationState, regime, ranked, top5, riskParity,
    positionSizes, expectedEdge, kellyFraction,
    volatilityTarget: 0.20, // 20% volatilidad anual objetivo
  };
}

// ── Position sizing con slippage + fees ──────────────────────
export function applyExecutionCosts(
  price:     number,
  side:      'BUY' | 'SELL',
  slippage:  number = 0.0010,  // 0.1% slippage (ETFs líquidos)
  fee:       number = 0.0005,  // 0.05% comisión IBKR
): number {
  return side === 'BUY'
    ? price * (1 + slippage + fee)
    : price * (1 - slippage - fee);
}

// ── Max drawdown check ────────────────────────────────────────
export function hasExceededMaxDrawdown(
  equityCurve:    number[],
  threshold:      number = 0.20,
): boolean {
  if (equityCurve.length < 2) return false;
  let peak = equityCurve[0];
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    if (peak > 0 && (peak - v) / peak > threshold) return true;
  }
  return false;
}
