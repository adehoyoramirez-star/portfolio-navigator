// ===============================================
// ARCHIVO: src/core/portfolio/rebalancer.ts
// NIVEL 4 — Rebalanceo real con soporte de SELL
// ===============================================

// CycleTopSignal definido inline para que rebalancer.ts sea autónomo.
// Misma interfaz que src/core/risk/cycleTopDetector.ts — no importar desde allí
// para evitar dependencia circular y errores de módulo no encontrado.
interface CycleTopSignal {
  asset: string;
  ticker: string;
  allocationMultiplier: number;
  zone: "SAFE" | "CAUTION" | "DANGER" | "EXTREME";
  reason: string;
  indicator: string;
  indicatorValue: string;
  shouldTrim: boolean;
  trimPct: number;
}

export interface RebalanceAsset {
  ticker: string;
  name: string;
  price: number;
  shares: number;
  targetAllocation: number;
}

export interface RebalanceSuggestion {
  ticker: string;
  name: string;
  action: "BUY" | "HOLD" | "SELL";
  sharesToBuy: number;
  cost: number;
  sharesToSell: number;
  proceedsIfSold: number;
  trimPct: number;
  currentPct: number;
  targetPct: number;
  drift: number;
  reason: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  cycleZone?: string;
  cycleIndicator?: string;
  cycleIndicatorValue?: string;
}

export interface RebalanceOutput {
  suggestions: RebalanceSuggestion[];
  sellSuggestions: RebalanceSuggestion[];
  buySuggestions: RebalanceSuggestion[];
  totalCost: number;
  totalProceeds: number;
  remainingCash: number;
  coverageRatio: number;
  isFullyFunded: boolean;
}

export function computeRebalanceSuggestions(
  assets: RebalanceAsset[],
  availableCash: number,
  totalPortfolioValue: number,
  driftThreshold = 0.02,
  cycleTopSignals: CycleTopSignal[] = []
): RebalanceOutput {

  const emptyOutput: RebalanceOutput = {
    suggestions: [], sellSuggestions: [], buySuggestions: [],
    totalCost: 0, totalProceeds: 0,
    remainingCash: availableCash, coverageRatio: 0, isFullyFunded: false,
  };

  if (totalPortfolioValue <= 0) return emptyOutput;

  const totalValue = totalPortfolioValue + Math.max(0, availableCash);

  const withDrift = assets.map(asset => {
    const currentValue = asset.price * asset.shares;
    const currentPct   = totalPortfolioValue > 0 ? currentValue / totalPortfolioValue : 0;
    const targetPct    = asset.targetAllocation;
    const drift        = currentPct - targetPct;
    const deficitValue = Math.max(0, targetPct * totalValue - currentValue);
    const cycleSignal  = cycleTopSignals.find(s => s.ticker === asset.ticker);
    return { ...asset, currentPct, targetPct, drift, deficitValue, cycleSignal };
  });

  const suggestions: RebalanceSuggestion[] = [];

  // ── SELL — basado en señales de techo de ciclo ────────────────
  for (const asset of withDrift) {
    if (!asset.cycleSignal?.shouldTrim) continue;
    const { trimPct, zone, indicator, indicatorValue, reason } = asset.cycleSignal;
    if (trimPct <= 0 || asset.shares <= 0) continue;

    const sharesToSell = asset.ticker === "BTC-EUR"
      ? Math.floor((asset.shares * trimPct / 100) * 10000) / 10000
      : Math.floor(asset.shares * trimPct / 100);

    if (sharesToSell <= 0) continue;

    const priority: "HIGH" | "MEDIUM" | "LOW" =
      trimPct > 50 ? "HIGH" : trimPct > 25 ? "MEDIUM" : "LOW";

    suggestions.push({
      ticker: asset.ticker,
      name: asset.name,
      action: "SELL",
      sharesToBuy: 0, cost: 0,
      sharesToSell,
      proceedsIfSold: sharesToSell * asset.price,
      trimPct,
      currentPct: asset.currentPct,
      targetPct: asset.targetPct,
      drift: asset.drift,
      reason: `🔴 TECHO DE CICLO: ${reason}`,
      priority,
      cycleZone: zone,
      cycleIndicator: indicator,
      cycleIndicatorValue: indicatorValue,
    });
  }

  // ── BUY — activos infraponderados SIN señal de techo ─────────
  // FIX BUG-08: Los proceeds de las ventas (SELL) deben sumarse al cash disponible
  // para compras. Antes: SELL y BUY se calculaban con el mismo availableCash inicial
  // → el usuario veía BUYs sin poder financiarlos con los fondos de las ventas.
  const sellProceeds = suggestions
    .filter(s => s.action === "SELL")
    .reduce((sum, s) => sum + s.proceedsIfSold, 0);
  const cashForBuys = availableCash + sellProceeds;

  if (cashForBuys > 0) {
    const underweight = withDrift
      .filter(a => {
        if (a.cycleSignal?.shouldTrim) return false;
        if (a.cycleSignal && a.cycleSignal.allocationMultiplier < 0.6) return false;
        return a.drift < -driftThreshold && a.deficitValue > 0 && a.price > 0;
      })
      .sort((a, b) => a.drift - b.drift);

    if (underweight.length > 0) {
      const totalDeficit = underweight.reduce((s, a) => s + a.deficitValue, 0);
      let loopCash = cashForBuys;

      for (const asset of underweight) {
        if (loopCash <= 0) break;
        const cashForThis = Math.min(
          (asset.deficitValue / totalDeficit) * cashForBuys,
          asset.deficitValue, loopCash
        );
        const sharesToBuy = asset.ticker === "BTC-EUR"
          ? Math.floor((cashForThis / asset.price) * 10000) / 10000
          : Math.floor(cashForThis / asset.price);
        if (sharesToBuy <= 0) continue;
        const cost = sharesToBuy * asset.price;
        if (cost > loopCash) continue;

        const absDrift = Math.abs(asset.drift * 100);
        // FIX-REBALANCER-CORR: degradar HIGH si el activo tiene alta correlación con BTC
        // y BTC ya está sobreexpuesto (> 25%). Evita añadir cluster tech-crypto involuntariamente.
        const BTC_CORR: Record<string, number> = {
          'XNAS.DE': 0.68, 'VVSM.DE': 0.72, 'IS3Q.DE': 0.52, 'EMXC.DE': 0.45,
          'PPFB.DE': -0.12, 'URNU.DE': 0.28, 'BTC-EUR': 1.0,
        };
        const btcEntry = allAssets?.find((a: { ticker: string; currentPct: number }) => a.ticker === 'BTC-EUR');
        const btcOverweight = btcEntry && btcEntry.currentPct > 0.25;
        const assetBtcCorr = BTC_CORR[asset.ticker] ?? 0;
        let priority: "HIGH" | "MEDIUM" | "LOW" =
          absDrift > 10 ? "HIGH" : absDrift > 5 ? "MEDIUM" : "LOW";
        if (btcOverweight && assetBtcCorr > 0.55 && priority === "HIGH") {
          priority = "MEDIUM"; // cluster BTC activo — bajar prioridad
        }

        suggestions.push({
          ticker: asset.ticker, name: asset.name, action: "BUY",
          sharesToBuy, cost,
          sharesToSell: 0, proceedsIfSold: 0, trimPct: 0,
          currentPct: asset.currentPct, targetPct: asset.targetPct, drift: asset.drift,
          priority,
          reason: `Infraponderado ${absDrift.toFixed(1)}pp (actual ${(asset.currentPct * 100).toFixed(1)}% → objetivo ${(asset.targetPct * 100).toFixed(1)}%)`,
          cycleZone: asset.cycleSignal?.zone,
          cycleIndicator: asset.cycleSignal?.indicator,
          cycleIndicatorValue: asset.cycleSignal?.indicatorValue,
        });
        loopCash -= cost;
      }
    }
  }

  const sellSuggestions  = suggestions.filter(s => s.action === "SELL");
  const buySuggestions   = suggestions.filter(s => s.action === "BUY");
  const totalCost        = buySuggestions.reduce((s, r) => s + r.cost, 0);
  const totalProceeds    = sellSuggestions.reduce((s, r) => s + r.proceedsIfSold, 0);
  const spentCash        = buySuggestions.reduce((s, r) => s + r.cost, 0);
  const underweightForCoverage = withDrift.filter(a =>
    a.drift < -driftThreshold && !a.cycleSignal?.shouldTrim
  );
  const idealCost       = underweightForCoverage.reduce((s, a) => s + Math.min(a.deficitValue, cashForBuys), 0);
  const coverageRatio   = idealCost > 0 ? totalCost / idealCost : 1;
  // remainingCash: dinero que queda del pool total (cash original + sell proceeds) tras las compras
  const remainingCash   = cashForBuys - spentCash;

  return {
    suggestions, sellSuggestions, buySuggestions,
    totalCost, totalProceeds,
    remainingCash,
    coverageRatio,
    isFullyFunded: remainingCash >= 0 && coverageRatio > 0.95,
  };
}
