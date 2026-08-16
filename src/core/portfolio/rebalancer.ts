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

// CycleBottomSignal — señal de suelo de ciclo (drift floor para el recorte).
// Autónomo (mismo criterio que CycleTopSignal) para evitar dependencia
// circular con cycleTopDetector.ts.
interface CycleBottomSignal {
  ticker: string;
  attackMultiplier: number;
  shouldAccumulate: boolean;
  zone: string;
  indicator?: string;
  indicatorValue?: string;
}

// FIX-OVERWEIGHT-TRIM: floor de sobrepeso táctico permitido por señal de suelo.
// Mismo criterio que getBottomDriftFloor() en smartDCA.ts (no importar para
// mantener rebalancer.ts autónomo).
function bottomDriftFloor(attackMultiplier: number): number {
  if (attackMultiplier >= 2.0) return 0.050;  // EXTREME
  if (attackMultiplier >= 1.5) return 0.030;  // OPPORTUNITY
  if (attackMultiplier > 1.0) return 0.015;   // VALUE
  return 0;
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
  /** True si es recorte de concentración (sobrepeso), NO señal de techo. */
  isOverweightTrim?: boolean;
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
  cycleTopSignals: CycleTopSignal[] = [],
  cycleBottomSignals: CycleBottomSignal[] = []
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
    // CONVENCIÓN DRIFT (rebalancer): drift = current − target.
    //   POSITIVO = sobreponderado (vender) · NEGATIVO = infraponderado (comprar).
    //   ⚠️ OPUESTA a smartDCA.ts (target − current). No cruzar valores entre módulos.
    const drift        = currentPct - targetPct;
    const deficitValue = Math.max(0, targetPct * totalValue - currentValue);
    // FIX-CYCLEMATCH: matching exchange-agnostic para cubrir alias de ticker
    // (ej: VVSM.DE y VVSM, 0P00000WLG.F y WLG). El split en '.' captura el ticker base.
    const baseTicker = asset.ticker.split('.')[0];
    const cycleSignal  = cycleTopSignals.find(s =>
      s.ticker === asset.ticker || s.ticker.split('.')[0] === baseTicker
    );
    return { ...asset, currentPct, targetPct, drift, deficitValue, cycleSignal };
  });

  const suggestions: RebalanceSuggestion[] = [];

  // ── SELL — basado en señales de techo de ciclo (target-based) ──
  // FIX-DEATH-SPIRAL (Jul-2026): ANTES aplicaba trimPct% sobre acciones
  // actuales CADA ejecución → death spiral (vender 60% cada día hasta
  // liquidación total). AHORA calcula sharesToSell para alcanzar el peso
  // objetivo (targetAllocation). Si ya se alcanzó, no hay más ventas.
  for (const asset of withDrift) {
    if (!asset.cycleSignal?.shouldTrim) continue;
    const { trimPct, zone, indicator, indicatorValue, reason } = asset.cycleSignal;
    if (trimPct <= 0 || asset.shares <= 0 || asset.price <= 0) continue;

    // Target-based: solo vender el exceso sobre el peso objetivo
    const targetValue = asset.targetPct * totalPortfolioValue;
    const currentValue = asset.shares * asset.price;
    const excessValue = currentValue - targetValue;
    if (excessValue <= 0.01) continue; // ya está en peso o por debajo

    const sharesToSell = asset.ticker === "BTC-EUR"
      ? Math.floor((excessValue / asset.price) * 10000) / 10000
      : Math.floor(excessValue / asset.price);

    if (sharesToSell <= 0) continue;

    // trimPct efectivo: % real que se está vendiendo (informativo)
    const effectiveTrimPct = parseFloat(((sharesToSell / asset.shares) * 100).toFixed(1));

    // Prioridad basada en la zona del cycle signal, no en el trim efectivo.
    // El usuario necesita ver la severidad real de la señal subyacente.
    const priority: "HIGH" | "MEDIUM" | "LOW" =
      zone === "EXTREME" || zone === "DANGER" ? "HIGH" : "MEDIUM";

    suggestions.push({
      ticker: asset.ticker,
      name: asset.name,
      action: "SELL",
      sharesToBuy: 0, cost: 0,
      sharesToSell,
      proceedsIfSold: sharesToSell * asset.price,
      trimPct: effectiveTrimPct,
      currentPct: asset.currentPct,
      targetPct: asset.targetPct,
      drift: asset.drift,
      reason: `🔴 TECHO DE CICLO: ${reason} (target ${(asset.targetPct * 100).toFixed(1)}%, vendiendo ${effectiveTrimPct}%)`,
      priority,
      cycleZone: zone,
      cycleIndicator: indicator,
      cycleIndicatorValue: indicatorValue,
    });
  }

  // ── OVERWEIGHT TRIM (límite de concentración) ─────────────────────
  // FIX-OVERWEIGHT-TRIM (Ago-2026): activos sobreponderados SIN señal de
  // techo también se recortan hacia su target en el rebalanceo mensual,
  // para respetar el presupuesto de riesgo del optimizador.
  //   La señal de suelo (bottom) permite cierto sobrepeso táctico
  //   (drift floor: VALUE +1.5pp, OPPORTUNITY +3pp, EXTREME +5pp),
  //   pero más allá de ese floor el exceso se recorta.
  //   Sin señal de suelo → floor 0 → se recorta todo el sobrepeso.
  for (const asset of withDrift) {
    if (asset.cycleSignal?.shouldTrim) continue; // ya recortado a target arriba
    if (asset.drift <= driftThreshold) continue; // no sobreponderado
    const baseTicker = asset.ticker.split('.')[0];
    const bottom = cycleBottomSignals.find(s =>
      s.ticker === asset.ticker || s.ticker.split('.')[0] === baseTicker
    );
    const floor = bottom?.shouldAccumulate ? bottomDriftFloor(bottom.attackMultiplier) : 0;
    const excessOverFloor = asset.drift - floor;
    if (excessOverFloor <= driftThreshold) continue; // dentro del rango permitido
    const currentValue = asset.price * asset.shares;
    const allowedValue = (asset.targetPct + floor) * totalPortfolioValue;
    const excessValue = currentValue - allowedValue;
    if (excessValue <= 0.01) continue;
    const sharesToSell = asset.ticker === "BTC-EUR"
      ? Math.floor((excessValue / asset.price) * 10000) / 10000
      : Math.floor(excessValue / asset.price);
    if (sharesToSell <= 0) continue;
    const effectiveTrimPct = parseFloat(((sharesToSell / asset.shares) * 100).toFixed(1));
    suggestions.push({
      ticker: asset.ticker,
      name: asset.name,
      action: "SELL",
      sharesToBuy: 0, cost: 0,
      sharesToSell,
      proceedsIfSold: sharesToSell * asset.price,
      trimPct: effectiveTrimPct,
      currentPct: asset.currentPct,
      targetPct: asset.targetPct,
      drift: asset.drift,
      reason: floor > 0
        ? `⚖️ SOBREPESO ${(asset.drift * 100).toFixed(1)}pp — recorte sobre target ${(asset.targetPct * 100).toFixed(1)}% + suelo ${bottom?.zone ?? ""} (+${(floor * 100).toFixed(1)}pp permitido)`
        : `⚖️ SOBREPESO ${(asset.drift * 100).toFixed(1)}pp — recorte hacia target ${(asset.targetPct * 100).toFixed(1)}% (sin señal de techo)`,
      priority: "MEDIUM",
      isOverweightTrim: true,
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

  // FIX-DUAL-SIGNAL: failsafe post-hoc — después de calcular SELLs, ningún activo
  // vendido puede aparecer también como BUY. Esto resuelve el bug donde VVSM (semis)
  // aparecía como "reducir" (SELL por cycleTop) y "comprar" (BUY por infraponderado)
  // simultáneamente en el panel de rebalance.
  const soldTickers = new Set(
    suggestions.filter(s => s.action === "SELL").map(s => s.ticker.split('.')[0])
  );

  if (cashForBuys > 0) {
    const underweight = withDrift
      .filter(a => {
        // Capa 1: señal de techo de ciclo → nunca comprar
        if (a.cycleSignal?.shouldTrim) return false;
        if (a.cycleSignal && a.cycleSignal.allocationMultiplier < 0.6) return false;
        // Capa 2: failsafe — si YA se va a vender este ticker (o un alias), no comprar
        if (soldTickers.has(a.ticker.split('.')[0])) return false;
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
          '0P00000WLG.F': 0.65, 'VVSM.DE': 0.72, 'EMXC.DE': 0.45,
          'PPFB.DE': -0.12, 'URNU.DE': 0.28, 'BTC-EUR': 1.0,
        };
        // FIX: usar withDrift (tiene currentPct) en lugar de assets (RebalanceAsset, sin currentPct)
        const btcEntry = withDrift.find(a => a.ticker === 'BTC-EUR');
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