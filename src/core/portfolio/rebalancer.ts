// ===============================================
// ARCHIVO: src/core/portfolio/rebalancer.ts
// NIVEL 4 — Rebalanceo real con soporte de SELL
// ===============================================
// FIX-ORDER-GUARD (Oct-2026, FIX-CLIFF-CREDIT-01 · Fase 4/5):
//   ORDER = target·NAV − actual es correcto y NO se toca (target-driven).
//   Se añade una CAPA DE SEGURIDAD DE EJECUCIÓN sobre las BUYs:
//     orden ≤ min(deficit, MAX_WEIGHT_INCREMENT_PER_REBALANCE·NAV, MAX_ORDER_VALUE)
//   Los límites viven en ORDER_GUARD_CONFIG (engineConfig) — nada hardcodeado
//   aquí y cero excepciones por activo. El déficit no ejecutado NO se elimina:
//   queda en suggestion.pendingDeficit para el siguiente rebalanceo.
//   Los SELLs (trim de ciclo / sobrepeso) NO tienen cap: reducir exposición
//   nunca es la orden desproporcionada peligrosa.
//   No es un segundo motor de sizing:
//     INDICADORES → REGIME → PENALTY → TARGET → DRIFT → CAPA DCA → ORDER GUARD → ORDER
//
// FIX-MUTEX-V3 (Oct-2026) — "un hueco, un euro" con capas (rebalanceo MENSUAL
//   + DCA SEMANAL), sustituye al mutex por SUGERENCIA de FIX-PHASE13-INSTITUTIONAL #5:
//     El candado v1/v2 vivía DENTRO de Smart DCA y se activaba con las sugerencias
//     del panel (que persisten todo el ciclo) → el DCA quedaba en €0 mientras el
//     rebalanceo no se ejecutase (bug live 01-oct-2026: €3.900 sin invertir un mes).
//     AHORA la exclusión es simétrica y por estado:
//       1ª capa (semanal) → Smart DCA despliega su tranche por drift, sin veto.
//       2ª capa (mensual) → este módulo recibe dcaCommitted (€ por ticker) y cierra
//                           solo el REMANENTE del hueco, con el cash restante.
//     Invariante: gap_i = dcaCommitted_i + buy_i  ·  Σ dca + Σ buy ≤ cashReserve.
//     La exclusión mutua depende del ESTADO (pesos + cash), que se actualiza al
//     confirmar cada ejecución — nunca de una sugerencia.

import { ORDER_GUARD_CONFIG } from "../config/engineConfig";

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
  /**
   * FIX-ORDER-GUARD: parte del déficit que el guard de ejecución deja para
   * futuros rebalanceos (solo BUYs — los sells no tienen cap). El gap no se
   * descarta: compras repetidas hacia el mismo target lo cierran.
   */
  pendingDeficit?: number;
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
  cycleBottomSignals: CycleBottomSignal[] = [],
  /**
   * FIX-MUTEX-V3 (Oct-2026): € por ticker ya comprometidos por la capa SEMANAL
   * (Smart DCA) en este ciclo. El rebalanceo MENSUAL es la 2ª capa: cierra solo
   * el REMANENTE de cada hueco (deficitValue − dcaCommitted) y su presupuesto de
   * cash se reduce en la suma comprometida. Invariante "un hueco, un euro":
   *   gap_i = dcaCommitted_i + buy_rebalanceo_i  ·  Σ dca + Σ buy ≤ cash.
   * Sustituye al mutex por SUGERENCIA (v1/v2), que paralizaba el DCA durante
   * todo el ciclo. La exclusión mutua pasa a depender del ESTADO compartido.
   */
  dcaCommitted: Record<string, number> = {}
): RebalanceOutput {

  const emptyOutput: RebalanceOutput = {
    suggestions: [], sellSuggestions: [], buySuggestions: [],
    totalCost: 0, totalProceeds: 0,
    remainingCash: availableCash, coverageRatio: 0, isFullyFunded: false,
  };

  if (totalPortfolioValue <= 0) return emptyOutput;

  const totalValue = totalPortfolioValue + Math.max(0, availableCash);

  // FIX-MUTEX-V3: € comprometidos por la capa SEMANAL (Smart DCA) en este ciclo,
  //   agregados por ticker base (exchange-agnostic: WLG ≈ 0P00000WLG.F).
  const dcaCommittedByBase = new Map<string, number>();
  let dcaCommittedTotal = 0;
  for (const [ticker, amount] of Object.entries(dcaCommitted)) {
    const value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    if (value <= 0) continue;
    const base = ticker.split('.')[0];
    dcaCommittedByBase.set(base, (dcaCommittedByBase.get(base) ?? 0) + value);
    dcaCommittedTotal += value;
  }

  const withDrift = assets.map(asset => {
    const currentValue = asset.price * asset.shares;
    const currentPct   = totalPortfolioValue > 0 ? currentValue / totalPortfolioValue : 0;
    const targetPct    = asset.targetAllocation;
    // CONVENCIÓN DRIFT (rebalancer): drift = current − target.
    //   POSITIVO = sobreponderado (vender) · NEGATIVO = infraponderado (comprar).
    //   ⚠️ OPUESTA a smartDCA.ts (target − current). No cruzar valores entre módulos.
    const drift        = currentPct - targetPct;
    // FIX-CYCLEMATCH: matching exchange-agnostic para cubrir alias de ticker
    // (ej: VVSM.DE y VVSM, 0P00000WLG.F y WLG). El split en '.' captura el ticker base.
    const baseTicker = asset.ticker.split('.')[0];
    // FIX-MUTEX-V3: hueco BRUTO (target·NAV − actual) y hueco NETO de lo que la
    // capa semanal (DCA) ya está desplegando en este ciclo. Si el DCA cubre todo
    // el hueco, el rebalanceo no emite BUY para ese activo (deficitValue → 0).
    const deficitGross = Math.max(0, targetPct * totalValue - currentValue);
    const dcaAlready = dcaCommittedByBase.get(baseTicker) ?? 0;
    const deficitValue = Math.max(0, deficitGross - dcaAlready);
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
  // FIX-MUTEX-V3: presupuesto de cash COMPARTIDO con la capa semanal. La parte
  //   del cash operativo ya comprometida por el DCA no puede financiar de nuevo
  //   el rebalanceo del mismo ciclo (sería doble gasto del mismo euro).
  const cashForBuys = Math.max(0, availableCash + sellProceeds - dcaCommittedTotal);

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
        const rawCashForThis = Math.min(
          (asset.deficitValue / totalDeficit) * cashForBuys,
          asset.deficitValue, loopCash
        );
        // ── ORDER GUARD (FIX-ORDER-GUARD): límites de EJECUCIÓN, no de sizing ──
        // La orden sigue siendo deficit-pro-rata; solo se trunca al máximo
        // permitido por sesión (incremento de peso y valor absoluto). Lo que
        // no cabe hoy queda como déficit pendiente, no se elimina.
        const maxByWeight = ORDER_GUARD_CONFIG.MAX_WEIGHT_INCREMENT_PER_REBALANCE * totalValue;
        const cashForThis = Math.min(rawCashForThis, maxByWeight, ORDER_GUARD_CONFIG.MAX_ORDER_VALUE);
        const sharesToBuy = asset.ticker === "BTC-EUR"
          ? Math.floor((cashForThis / asset.price) * 10000) / 10000
          : Math.floor(cashForThis / asset.price);
        if (sharesToBuy <= 0) continue;
        const cost = sharesToBuy * asset.price;
        if (cost > loopCash) continue;
        // Déficit pendiente = deficit original − coste realmente ejecutable hoy.
        const pendingDeficit = Math.max(0, asset.deficitValue - cost);

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
          pendingDeficit: pendingDeficit > 0.01 ? pendingDeficit : undefined,
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