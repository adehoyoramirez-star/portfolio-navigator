// ===============================================
// ARCHIVO: src/core/portfolio/rebalancer.ts
// NIVEL 4 — Rebalanceo real basado en allocations del motor
// ===============================================
// PROBLEMA ANTERIOR:
//   purchaseSuggestions usaba asset.weight (peso estático del usuario)
//   → ignoraba completamente las allocations del motor
//   → el motor calculaba 35% BTC y el dashboard sugería comprar EMXC
//
// AHORA:
//   Rebalanceo basado en finalAllocation del motor
//   Con restricciones reales: lotes mínimos, capital disponible,
//   priorización por drift (más desviado primero)
// ===============================================

export interface RebalanceAsset {
  ticker: string;
  name: string;
  price: number;
  shares: number;
  targetAllocation: number; // del motor [0,1]
}

export interface RebalanceSuggestion {
  ticker: string;
  name: string;
  action: "BUY" | "HOLD";
  sharesToBuy: number;
  cost: number;
  currentPct: number;      // peso actual en portfolio [0,1]
  targetPct: number;       // peso objetivo del motor [0,1]
  drift: number;           // currentPct - targetPct (negativo = infraponderado)
  reason: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
}

export interface RebalanceOutput {
  suggestions: RebalanceSuggestion[];
  totalCost: number;
  remainingCash: number;
  coverageRatio: number;   // qué fracción del rebalanceo ideal se puede ejecutar
  isFullyFunded: boolean;
}

/**
 * Genera sugerencias de compra basadas en las allocations reales del motor.
 *
 * Lógica:
 *   1. Calcular drift de cada activo (actual vs objetivo del motor)
 *   2. Ordenar por mayor infraponderación primero
 *   3. Asignar cash disponible proporcionalmente al déficit
 *   4. Respetar lotes mínimos (1 acción para ETFs, 0.0001 para BTC)
 *
 * @param assets — activos con precio, shares y targetAllocation del motor
 * @param availableCash — cash disponible para invertir (€)
 * @param totalPortfolioValue — valor total del portfolio (€)
 * @param driftThreshold — drift mínimo para sugerir compra (default: 2%)
 */
export function computeRebalanceSuggestions(
  assets: RebalanceAsset[],
  availableCash: number,
  totalPortfolioValue: number,
  driftThreshold = 0.02
): RebalanceOutput {
  if (availableCash <= 0 || totalPortfolioValue <= 0) {
    return { suggestions: [], totalCost: 0, remainingCash: availableCash, coverageRatio: 0, isFullyFunded: false };
  }

  const totalValue = totalPortfolioValue + availableCash;

  // Calcular peso actual y drift de cada activo
  const withDrift = assets.map(asset => {
    const currentValue  = asset.price * asset.shares;
    const currentPct    = totalPortfolioValue > 0 ? currentValue / totalPortfolioValue : 0;
    const targetPct     = asset.targetAllocation;
    const drift         = currentPct - targetPct; // negativo = infraponderado
    const deficitValue  = Math.max(0, targetPct * totalValue - currentValue);
    return { ...asset, currentPct, targetPct, drift, deficitValue };
  });

  // Solo activos infraponderados más allá del threshold
  const underweight = withDrift
    .filter(a => a.drift < -driftThreshold && a.deficitValue > 0 && a.price > 0)
    .sort((a, b) => a.drift - b.drift); // más infraponderado primero

  if (underweight.length === 0) {
    return { suggestions: [], totalCost: 0, remainingCash: availableCash, coverageRatio: 1, isFullyFunded: true };
  }

  // Distribuir cash proporcionalmente al déficit
  const totalDeficit = underweight.reduce((s, a) => s + a.deficitValue, 0);
  const suggestions: RebalanceSuggestion[] = [];
  let remainingCash = availableCash;

  for (const asset of underweight) {
    if (remainingCash <= 0) break;

    const cashForThis = Math.min(
      (asset.deficitValue / totalDeficit) * availableCash,
      asset.deficitValue,
      remainingCash
    );

    let sharesToBuy: number;
    if (asset.ticker === "BTC-EUR") {
      sharesToBuy = Math.floor((cashForThis / asset.price) * 10000) / 10000;
    } else {
      sharesToBuy = Math.floor(cashForThis / asset.price);
    }

    if (sharesToBuy <= 0) continue;

    const cost = sharesToBuy * asset.price;
    if (cost > remainingCash) continue;

    const absDrift = Math.abs(asset.drift * 100);
    const priority: "HIGH" | "MEDIUM" | "LOW" =
      absDrift > 10 ? "HIGH" : absDrift > 5 ? "MEDIUM" : "LOW";

    suggestions.push({
      ticker:     asset.ticker,
      name:       asset.name,
      action:     "BUY",
      sharesToBuy,
      cost,
      currentPct: asset.currentPct,
      targetPct:  asset.targetPct,
      drift:      asset.drift,
      priority,
      reason: `Infraponderado ${(absDrift).toFixed(1)}pp (actual ${(asset.currentPct * 100).toFixed(1)}% → objetivo ${(asset.targetPct * 100).toFixed(1)}%)`,
    });

    remainingCash -= cost;
  }

  const totalCost      = suggestions.reduce((s, r) => s + r.cost, 0);
  const idealCost      = underweight.reduce((s, a) => s + Math.min(a.deficitValue, availableCash), 0);
  const coverageRatio  = idealCost > 0 ? totalCost / idealCost : 1;

  return {
    suggestions,
    totalCost,
    remainingCash,
    coverageRatio,
    isFullyFunded: remainingCash >= 0 && coverageRatio > 0.95,
  };
}