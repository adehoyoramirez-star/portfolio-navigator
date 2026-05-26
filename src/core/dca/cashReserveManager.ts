// ============================================================
// ARCHIVO: src/core/dca/cashReserveManager.ts
// OLYMPUS X — Gestor de Cash de Reserva y Órdenes BTC Límite.
// ============================================================
//
// PROPÓSITO: Dar al motor una representación explícita del cash de reserva
// y las órdenes límite BTC preparadas, de modo que el motor táctico y el
// DCA engine puedan:
//   1. Saber cuánto cash REAL está disponible vs comprometido en órdenes
//   2. Mostrar en el dashboard las órdenes BTC pendientes y su estado
//   3. Integrar las órdenes con el modo ataque (no duplicar compras)
//   4. Calcular el CVaR considerando el riesgo latente de las órdenes BTC
//
// TIPOS DE CASH:
//   operationalBuffer  → siempre disponible, nunca tocar (€300-400)
//   btcLimitOrders     → comprometido en órdenes límite BTC por nivel
//   tacticalReserve    → para el motor táctico (oportunidades no-BTC)
//   defensiveLiquidity → acumulado en meses de bloqueo DCA (ya existe en smartDCA)
//
// INTEGRACIÓN CON EL MOTOR:
//   El SmartDCA engine (smartDCA.ts) ya gestiona defensiveLiquidity.
//   Este módulo EXTIENDE ese concepto con las órdenes BTC límite.
//   No reemplaza nada — añade visibilidad y control.
//
// PERSISTENCIA: Supabase portfolio tabla + localStorage fallback
// ============================================================

export interface BTCLimitOrder {
  id: string;
  level: 1 | 2 | 3 | 4;        // Tramo del DipAttack
  limitPrice: number;            // Precio BTC en EUR al que se activa
  amountEUR: number;             // Capital comprometido en EUR
  btcAmount: number;             // BTC a comprar (amountEUR / limitPrice)
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'PARTIAL';
  createdAt: string;             // ISO timestamp de cuando se creó
  filledAt?: string;             // ISO timestamp de cuando se ejecutó
  fillPrice?: number;            // Precio real de ejecución
  notes?: string;                // Contexto de la orden (ej: "Onda A target")
}

export interface CashReserveState {
  // ── Breakdown del cash disponible ────────────────────────────────────────
  totalCashEUR: number;             // Cash total en cuenta (real o estimado)

  // Cash operacional — nunca tocar, buffer mínimo
  operationalBuffer: number;        // Default: €350 (5% del portfolio)

  // Cash comprometido en órdenes límite BTC (suma de las órdenes PENDING)
  btcOrdersCommitted: number;       // Suma de amountEUR de órdenes PENDING

  // Cash disponible para el motor táctico (oportunidades screener)
  tacticalReserve: number;          // totalCash - operationalBuffer - btcOrdersCommitted

  // Cash libre sin asignación (puede usarse para DCA regular o rebalanceo)
  freeCash: number;                 // max(0, tacticalReserve - tacticalDeployed)

  // ── Órdenes BTC límite ────────────────────────────────────────────────────
  btcLimitOrders: BTCLimitOrder[];

  // Resumen de exposición BTC comprometida
  btcCommittedBTC: number;          // BTC total comprometido en órdenes PENDING
  btcCommittedEUR: number;          // EUR total en órdenes PENDING
  btcAvgEntryIfFilled: number;      // Precio medio de entrada si todas se ejecutan

  // ── Estado del deployment ─────────────────────────────────────────────────
  deploymentStatus: 'OVERDEPLOYED' | 'OPTIMAL' | 'UNDERDEPLOYED';
  cashUtilizationPct: number;       // % del cash total comprometido

  // ── Timestamps ───────────────────────────────────────────────────────────
  lastUpdated: string;
}

// Niveles recomendados para las órdenes BTC (del post-mortem anticipado)
export const BTC_LIMIT_ORDER_LEVELS = [
  {
    level: 1 as const,
    priceTrigger: 62000,   // Pullback normal, MVRV ~1.25
    amountEUR: 300,
    rationale: 'Pullback técnico — primera oportunidad de acumulación',
  },
  {
    level: 2 as const,
    priceTrigger: 55000,   // Onda A completada, Hash Ribbon puede confirmar
    amountEUR: 400,
    rationale: 'Onda A Elliott — zona de rebote histórica',
  },
  {
    level: 3 as const,
    priceTrigger: 49000,   // Capitulación técnica, MVRV cerca de 1.0
    amountEUR: 400,
    rationale: 'Capitulación técnica — MVRV objetivo < 1.0',
  },
  {
    level: 4 as const,
    priceTrigger: 43000,   // Solo si MVRV < 0.8 (infravaloración extrema)
    amountEUR: 300,
    rationale: 'Infravaloración extrema — MVRV < 0.8 históricamente raro',
  },
];

const STORAGE_KEY = 'olympus_cash_reserve_v1';

// ── PERSISTENCIA ─────────────────────────────────────────────────────────────

export function saveCashReserveState(state: CashReserveState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* silencio — localStorage lleno */ }
}

export function loadCashReserveState(): CashReserveState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CashReserveState;
  } catch { return null; }
}

// ── CONSTRUCTOR ───────────────────────────────────────────────────────────────

export function buildCashReserveState(
  totalCashEUR: number,
  btcLimitOrders: BTCLimitOrder[],
  tacticalDeployedEUR = 0,
  operationalBuffer = 350,
): CashReserveState {
  const pendingOrders = btcLimitOrders.filter(o => o.status === 'PENDING' || o.status === 'PARTIAL');
  const btcOrdersCommitted = pendingOrders.reduce((s, o) => s + o.amountEUR, 0);
  const btcCommittedBTC = pendingOrders.reduce((s, o) => s + o.btcAmount, 0);
  const totalBTCEntryEUR = pendingOrders.reduce((s, o) => s + o.limitPrice * o.btcAmount, 0);
  const btcAvgEntry = btcCommittedBTC > 0 ? totalBTCEntryEUR / btcCommittedBTC : 0;

  const tacticalReserve = Math.max(0,
    totalCashEUR - operationalBuffer - btcOrdersCommitted
  );
  const freeCash = Math.max(0, tacticalReserve - tacticalDeployedEUR);

  const cashUsed = operationalBuffer + btcOrdersCommitted + tacticalDeployedEUR;
  const cashUtilizationPct = totalCashEUR > 0 ? cashUsed / totalCashEUR : 0;

  const deploymentStatus: CashReserveState['deploymentStatus'] =
    cashUtilizationPct > 0.95 ? 'OVERDEPLOYED' :
    cashUtilizationPct > 0.60 ? 'OPTIMAL' : 'UNDERDEPLOYED';

  return {
    totalCashEUR,
    operationalBuffer,
    btcOrdersCommitted,
    tacticalReserve,
    freeCash,
    btcLimitOrders,
    btcCommittedBTC,
    btcCommittedEUR: btcOrdersCommitted,
    btcAvgEntryIfFilled: btcAvgEntry,
    deploymentStatus,
    cashUtilizationPct,
    lastUpdated: new Date().toISOString(),
  };
}

// ── GESTIÓN DE ÓRDENES ────────────────────────────────────────────────────────

export function createBTCLimitOrder(
  level: BTCLimitOrder['level'],
  limitPrice: number,
  amountEUR: number,
  notes?: string,
): BTCLimitOrder {
  return {
    id: `btc-order-${level}-${Date.now()}`,
    level,
    limitPrice,
    amountEUR,
    btcAmount: amountEUR / limitPrice,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    notes,
  };
}

export function markOrderFilled(
  orders: BTCLimitOrder[],
  orderId: string,
  fillPrice: number,
): BTCLimitOrder[] {
  return orders.map(o =>
    o.id === orderId
      ? { ...o, status: 'FILLED' as const, filledAt: new Date().toISOString(), fillPrice }
      : o
  );
}

export function cancelOrder(
  orders: BTCLimitOrder[],
  orderId: string,
): BTCLimitOrder[] {
  return orders.map(o =>
    o.id === orderId ? { ...o, status: 'CANCELLED' as const } : o
  );
}

// ── INTEGRACIÓN CON EL MOTOR TÁCTICO ─────────────────────────────────────────
//
// CÓMO USAR ESTE MÓDULO CON EL MOTOR TÁCTICO:
//
//   1. El motor táctico (tacticalPortfolio.ts) opera con `tacticalCapitalEur`
//      que el usuario configura en el dashboard.
//
//   2. Con este módulo, `tacticalCapitalEur` debería ser = `freeCash`
//      (cash no comprometido en órdenes BTC ni en el buffer operacional).
//
//   3. Cuando el screener táctico encuentra una oportunidad en URNU.DE o XNAS.DE,
//      verifica que el coste de la posición no excede `freeCash`.
//
//   4. Si el precio BTC llega al nivel de una orden límite, el modal de
//      "Confirmar fill" actualiza el estado de la orden y reduce `btcOrdersCommitted`.
//      El `freeCash` se reduce también (el BTC ya está comprado, el cash gastado).
//
// FLUJO COMPLETO DEL CASH:
//
//   ENTRADA: aportación mensual €500
//     ↓
//   SPLIT:
//     €100 → operationalBuffer (hasta llegar a €350 total)
//     €200 → btcLimitOrders (mantener el pipeline de órdenes vivo)
//     €200 → freeCash/tacticalReserve (para screener y DCA regular)
//     ↓
//   Cuando BTC llega al nivel:
//     btcLimitOrders → FILLED, btcCommittedEUR baja, BTC en portfolio sube
//   Cuando screener encuentra oportunidad:
//     freeCash → deployed en posición táctica (URNU.DE, XNAS.DE pull-backs)
//
// ── REGLAS DE PRIORIDAD ───────────────────────────────────────────────────────
//
//   NUNCA tocar operationalBuffer (€350) — es el seguro de liquidez
//   Las órdenes BTC tienen prioridad sobre el motor táctico
//   El motor táctico opera SOLO con freeCash
//   Si freeCash < €100 → el motor táctico no abre nuevas posiciones
//
export function getCashAvailableForTactical(state: CashReserveState): number {
  // El motor táctico solo puede usar freeCash
  // Si freeCash < 100 → no operar (mínimo por debajo del que no tiene sentido)
  return state.freeCash >= 100 ? state.freeCash : 0;
}

// ── DIAGNÓSTICO ───────────────────────────────────────────────────────────────

export interface CashDiagnostic {
  status: 'READY' | 'LOW_CASH' | 'OVERCOMMITTED' | 'NO_BUFFER';
  message: string;
  recommendation: string;
  urgency: 'HIGH' | 'MEDIUM' | 'LOW';
}

export function diagnoseCashState(state: CashReserveState): CashDiagnostic {
  if (state.totalCashEUR < state.operationalBuffer) {
    return {
      status: 'NO_BUFFER',
      message: `Cash total €${state.totalCashEUR.toFixed(0)} < buffer mínimo €${state.operationalBuffer}`,
      recommendation: 'Depositar efectivo hasta completar el buffer operacional antes de cualquier compra',
      urgency: 'HIGH',
    };
  }
  if (state.btcOrdersCommitted > state.totalCashEUR * 0.85) {
    return {
      status: 'OVERCOMMITTED',
      message: `${(state.cashUtilizationPct * 100).toFixed(0)}% del cash comprometido en órdenes BTC`,
      recommendation: 'Considerar cancelar los tramos de menor prioridad (nivel 4) para liberar liquidez táctica',
      urgency: 'MEDIUM',
    };
  }
  if (state.freeCash < 100) {
    return {
      status: 'LOW_CASH',
      message: `Cash libre €${state.freeCash.toFixed(0)} — insuficiente para motor táctico`,
      recommendation: 'Motor táctico en pausa. Próxima aportación mensual irá a freeCash',
      urgency: 'LOW',
    };
  }
  return {
    status: 'READY',
    message: `Cash operativo: €${state.freeCash.toFixed(0)} libre · €${state.btcOrdersCommitted.toFixed(0)} en órdenes BTC · €${state.operationalBuffer} buffer`,
    recommendation: 'Sistema en estado óptimo. Motor táctico puede operar.',
    urgency: 'LOW',
  };
}

// ── CÁLCULO DEL IMPACTO EN RIESGO DEL PORTFOLIO ───────────────────────────────
//
// Las órdenes BTC pendientes son riesgo LATENTE — si se ejecutan todas,
// el peso BTC del portfolio aumenta significativamente.
// Este cálculo permite al CVaR optimizer ver el riesgo futuro, no solo el actual.

export interface LatentRiskImpact {
  // Portfolio actual
  currentBTCweight: number;
  currentPortfolioEUR: number;

  // Portfolio si TODAS las órdenes se ejecutan al precio límite
  projectedBTCweight: number;
  projectedPortfolioEUR: number;

  // Delta de riesgo
  additionalBTCexposure: number;   // EUR adicionales en BTC
  maxDrawdownIncrease: number;     // Estimación de incremento de Max DD

  // ¿Supera el límite de concentración?
  exceedsConcentrationLimit: boolean;
  btcCapLimit: number;             // 25% institucional
}

export function calculateLatentRisk(
  cashState: CashReserveState,
  currentBTCvalueEUR: number,
  currentPortfolioEUR: number,
  btcCapLimit = 0.25,
): LatentRiskImpact {
  const currentBTCweight = currentPortfolioEUR > 0
    ? currentBTCvalueEUR / currentPortfolioEUR : 0;

  // Si todas las órdenes se ejecutan, el portfolio crece por el cash gastado
  // pero el BTC también aumenta su valor base
  const projectedBTCvalueEUR = currentBTCvalueEUR + cashState.btcCommittedEUR;
  const projectedPortfolioEUR = currentPortfolioEUR; // el cash se convierte en BTC, no crece el portfolio

  const projectedBTCweight = projectedPortfolioEUR > 0
    ? projectedBTCvalueEUR / projectedPortfolioEUR : 0;

  // Incremento de Max DD estimado: BTC vol ~72% anualizada
  // cada punto porcentual adicional de BTC añade ~0.72pp de vol al portfolio
  const additionalBTCweight = projectedBTCweight - currentBTCweight;
  const maxDrawdownIncrease = additionalBTCweight * 0.72 * 0.50; // aprox

  return {
    currentBTCweight,
    currentPortfolioEUR,
    projectedBTCweight,
    projectedPortfolioEUR,
    additionalBTCexposure: cashState.btcCommittedEUR,
    maxDrawdownIncrease,
    exceedsConcentrationLimit: projectedBTCweight > btcCapLimit,
    btcCapLimit,
  };
}
