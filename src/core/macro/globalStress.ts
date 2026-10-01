// ===============================================
// ARCHIVO: src/core/macro/globalStress.ts
// ===============================================

export interface StressInputs {
  vix: number;
  creditSpread: number;
  move: number;          // MOVE index
  dxyTrend: number;      // tendencia del dólar (en tanto por uno)
  btcVol: number;        // volatilidad de Bitcoin (anualizada en tanto por uno)
  wtiOil?: number;       // WTI Crude Oil $/barril — geopolitical shock detector
  cbLiquidityGrowth?: number; // Global CB Liquidity Growth YoY% — Fed (WALCL) + BCE (ECBASSETSW)
                               //   Dimensión: BASE monetaria (QE/QT directo), NO dinero amplio (M2).
                               //   M2 mide crédito privado + multiplicador bancario.
                               //   CB balance mide creación directa de reservas por QE/QT.
                               //   Son dimensiones distintas: la Fed puede reducir balance
                               //   (QT) mientras M2 sube por crédito privado. Ver AGENTS.md.
}

export type StressRegime = "NORMAL" | "HIGH_RISK" | "CRISIS";

// ═══ CREDIT SPREAD CONTINUO — FIX-CLIFF-CREDIT-01 (Oct-2026) ═══
// PROBLEMA AUDITADO (caso real): el escalón entero `if (credit > 3) score += 1`
//   hacía que 10 pb (credit 2.98% → 3.08%) voltearan CONTRACTION → CRISIS con
//   resto-de-inputs=5, saltando el penalty 0.925 → 0.550 en UNA observación y
//   generando una orden material (≈225 URNU) sin cambio macro real.
//
// SOLUCIÓN: contribución CONTINUA y MONÓTONA por tramos lineales.
//   credit ≤ 2.0%  → 0.0 pts   (spread comprimido: complacencia, cero estrés)
//   credit 2→5%    → 0→1 pts   (pendiente 1/3 pts por pp — zona de acción)
//   credit 5→6%    → 1→2 pts   (pendiente 1 pp — zona de crisis real)
//   credit ≥ 6.0%  → 2.0 pts   (saturación; equivalentes a credit=∞)
//
// ELECCIÓN DE FUNCIÓN (A/B/C comparadas):
//   A) step/binaria (ANTES)        — RECHAZADA: cliff en 3.0 y 5.0 (causa del bug).
//   B) piecewise linear por tramos — ELEGIDA: monotona, continua, preserva la
//      interpretación económica de los umbrales (2.0 normal / 3.0 estrés / 5.0
//      disfunción) como CAMBIOS DE PENDIENTE, no saltos de nivel.
//   C) sigmoid / smoothstep        — RECHAZADA: difumina exactamente la zona de
//      acción (≥3%) donde el indicador debe discriminar; su sensibilidad máxima
//      caería en el centro del tramo y casi cero en los propios umbrales.
//
// PROPIEDADES GARANTIZADAS (pinned en creditCliffRegime.test.ts):
//   - Continuidad: sin saltos en 2.0, 3.0, 5.0 ni 6.0.
//   - Monotonicidad: no decreciente en todo el rango.
//   - Sin cliffs: |f(x+δ)−f(x)| ≤ pendiente·δ en cualquier punto; 10 pb de credit
//     mueven ≤0.0034 pts en el tramo de acción 2→5% (≤0.1 en el tramo 5→6%)
//     vs 1.0 pts del escalón antiguo → nunca voltean un régimen por sí solos.
//   - Las demás contribuciones de computeGlobalStress NO cambian.
export const CREDIT_STRESS_CONFIG = {
  FLOOR: 2.0,    // credit ≤ FLOOR → contribución 0
  PLATEAU: 5.0,  // credit = PLATEAU → contribución 1.0 (equivale al antiguo "+1")
  MAX: 6.0,      // credit ≥ MAX → contribución 2.0 (equivale al antiguo "+2")
} as const;

export function creditStressContribution(creditSpread: number): number {
  const { FLOOR, PLATEAU, MAX } = CREDIT_STRESS_CONFIG;
  if (creditSpread <= FLOOR) return 0;
  if (creditSpread >= MAX) return 2;
  if (creditSpread <= PLATEAU) return (creditSpread - FLOOR) / (PLATEAU - FLOOR);
  return 1 + (creditSpread - PLATEAU) / (MAX - PLATEAU);
}

// ═══ FIX-CLIFF-STRESS-02 (Oct-2026) — Brent, CB-Liquidity y MOVE continuos ═══
// Misma plantilla y justificación que FIX-CLIFF-CREDIT-01 (bloque superior).
// Motivación (caso live 01-oct-2026): con VIX 16.2 el régimen era CRISIS por
//   tres cliffs simultáneos — Brent $100.1 (+2 en ≥95), CB-QT −0.28% (+2 en <0)
//   y MOVE 110.5 (+1 en >110) = 6.3. Perturbaciones de $0.20 de Brent, 2bp de
//   WALCL o 0.2 de MOVE volteaban EXPANSION↔CRISIS (Δpenalty hasta 0.29 en una
//   observación). Brent contaba DOS veces (score +2 Y multiplicador ×0.70 →
//   0.468 pts de penalty en un día). Anclas semánticas preservadas como cambios
//   de pendiente. VIX, dxyTrend y btcVol NO se tocan (riesgo residual documentado).

// BRENT: score continuo 0→3 pts en $75→$115 (antes +1/+2/+3 escalones).
export const OIL_STRESS_CONFIG = {
  FLOOR: 75,     // Brent ≤ FLOOR → contribución 0
  SHOCK: 95,     // Brent = SHOCK → contribución 1
  CRISIS: 115,   // Brent ≥ CRISIS → contribución 3 (equivale al antiguo "+3")
} as const;

export function brentStressContribution(price: number): number {
  const { FLOOR, SHOCK, CRISIS } = OIL_STRESS_CONFIG;
  if (price <= FLOOR) return 0;
  if (price >= CRISIS) return 3;
  if (price <= SHOCK) return (price - FLOOR) / (SHOCK - FLOOR);
  return 1 + (price - SHOCK) * (2 / (CRISIS - SHOCK));
}

// Multiplicador petrolero CONTINUO (antes: 1.00/0.85/0.70/0.50 en saltos).
// Mismos valores EXACTOS en los umbrales antiguos; interpola linealmente entre
// ellos y satura en $130 (penalty mínimo 0.50). Elimina el segundo cliff del
// par score+penalty. La señal NO desaparece — su transporte ya no da tirones.
export function wtiPenaltyContinuous(price: number): number {
  if (price <= 75) return 1.0;
  if (price >= 130) return 0.50;
  if (price >= 115) return 0.70 - (price - 115) * (0.20 / 15);  // 0.70→0.50 en 115→130
  if (price >= 95) return 0.85 - (price - 95) * (0.15 / 20);    // 0.85→0.70 en 95→115
  return 1.0 - (price - 75) * (0.15 / 20);                       // 1.00→0.85 en 75→95
}

// CB LIQUIDITY: continuo 0→3 pts en +1%→−5% (antes +2 en <0, +3 en <−5).
// En 0.00 aporta 0.5 — SIN cliff en el cero (2bp de revisión WALCL ya no
// voltean regímenes). QT marginal (−0.28%) aporta ~0.72, proporcional.
export const CB_LIQUIDITY_STRESS_CONFIG = {
  NEUTRAL: 1.0,      // growth ≥ NEUTRAL → contribución 0
  SATURATION: -5.0,  // growth ≤ SATURATION → contribución 3 (equivale al antiguo "+3")
} as const;

export function cbLiquidityStressContribution(growthYoY: number | undefined): number {
  if (growthYoY === undefined) return 0;
  const { NEUTRAL, SATURATION } = CB_LIQUIDITY_STRESS_CONFIG;
  if (growthYoY >= NEUTRAL) return 0;
  if (growthYoY <= SATURATION) return 3;
  return ((NEUTRAL - growthYoY) / (NEUTRAL - SATURATION)) * 3;
}

// MOVE: continuo 0→1 en 110→140 y 1→2 en 140→180 (antes +1 en >110, +2 en >140).
export const MOVE_STRESS_CONFIG = {
  FLOOR: 110,      // MOVE ≤ FLOOR → contribución 0
  HIGH: 140,       // MOVE = HIGH → contribución 1 (equivale al antiguo "+1")
  SATURATION: 180, // MOVE ≥ SATURATION → contribución 2 (equivale al antiguo "+2")
} as const;

export function moveStressContribution(move: number): number {
  const { FLOOR, HIGH, SATURATION } = MOVE_STRESS_CONFIG;
  if (move <= FLOOR) return 0;
  if (move >= SATURATION) return 2;
  if (move <= HIGH) return (move - FLOOR) / (HIGH - FLOOR);
  return 1 + (move - HIGH) / (SATURATION - HIGH);
}

export interface StressResult {
  score: number;
  regime: StressRegime;
  wtiShock: "NONE" | "ELEVATED" | "SHOCK" | "CRISIS";  // nivel de shock petrolero
  wtiPenalty: number;   // multiplicador adicional [0.5, 1.0] por petróleo
}

// FIX A3: umbrales recalibrados para Brent (no WTI).
// Brent cotiza $3-5 sobre WTI — los umbrales antiguos eran para WTI.
// FIX-WTI-ALIGN (09-Jul-2026): alineados con dashboard (75/95/115).
// Brent < $75  → normal
// Brent $75–95 → elevated (tensión geopolítica moderada)
// Brent $95–115 → shock (conflicto regional — Ucrania 2022 llegó a $130)
// Brent > $115 → crisis (Suez 1973, Iraq 2003, Iran 2026)
const WTI_THRESHOLDS = { elevated: 75, shock: 95, crisis: 115 } as const;

export function computeGlobalStress(inputs: StressInputs): StressResult {
  let score = 0;

  if (inputs.vix > 25) score += 2;
  else if (inputs.vix > 18) score += 1;

  // FIX-CLIFF-CREDIT-01: contribución continua (0→2 pts en 2%→6%, sin cliffs en 3.0/5.0).
  // 10 pb de credit mueven ≤0.003 pts — nunca voltean un régimen por sí solos.
  score += creditStressContribution(inputs.creditSpread);

  // FIX-CLIFF-STRESS-02: contribución continua (0→2 pts en 110→180, sin cliffs en 110/140).
  score += moveStressContribution(inputs.move);

  // FIX B4: dxyTrend en decimal (0.02 = 2% de apreciación).
  // El dashboard puede pasar 1.6 (porcentaje) → dividir por 100 internamente.
  // Para compatibilidad: si dxyTrend > 1.0 asumimos que viene en % y lo convertimos.
  const dxyDecimal = inputs.dxyTrend > 1.0 ? inputs.dxyTrend / 100 : inputs.dxyTrend;
  if (dxyDecimal > 0.02) score += 1;

  // FIX B3: threshold subido 0.65→0.80. BTC vol media es 60-70% — con 0.65 casi siempre
  // activo. 0.80 captura solo entornos de estrés real (> +2σ sobre media BTC vol).
  // Esto elimina ~40% de los falsos positivos de HIGH_RISK.
  if (inputs.btcVol > 0.80) score += 1;

  // ── BRENT OIL — geopolitical shock detector ──────────────────────────
  // El petróleo es el termómetro más rápido de crisis geopolíticas —
  // sube antes que el VIX, antes que credit spreads, antes que cualquier otro indicador.
  // FIX-CLIFF-STRESS-02: score CONTINUO (0→3 en $75→$115) y multiplicador
  // CONTINUO (1.00→0.50 en $75→$130, mismos valores en los umbrales antiguos).
  // wtiShock queda como ETIQUETA categórica para display/trazabilidad — no
  // alimenta ninguna fórmula (solo stressScore y wtiPenalty sí).
  let wtiShock: StressResult["wtiShock"] = "NONE";
  let wtiPenalty = 1.0;

  if (inputs.wtiOil !== undefined && inputs.wtiOil > 0) {
    score += brentStressContribution(inputs.wtiOil);
    wtiPenalty = wtiPenaltyContinuous(inputs.wtiOil);
    if (inputs.wtiOil >= WTI_THRESHOLDS.crisis) wtiShock = "CRISIS";
    else if (inputs.wtiOil >= WTI_THRESHOLDS.shock) wtiShock = "SHOCK";
    else if (inputs.wtiOil >= WTI_THRESHOLDS.elevated) wtiShock = "ELEVATED";
  }

  // ── GLOBAL CB LIQUIDITY (Fed + BCE) ──────────────────────────────────
  // FIX-CB-LIQUIDITY (Jul-2026): añadido al stress score.
  //   DEFENSA CONTRA DOBLE CONTEO CON m2Growth (ver AGENTS.md):
  //   - m2Growth (detectRegimeProbabilistic) = dinero AMPLIO (crédito privado,
  //     multiplicador bancario, velocidad del dinero).
  //   - cbLiquidityGrowth = dinero BASE (QE/QT directo de bancos centrales).
  //   - Son dimensiones macro distintas: en 2023 la Fed redujo balance (QT)
  //     pero M2 se mantuvo plano porque drenaba del Reverse Repo facility,
  //     no de depósitos bancarios. Divergieron en timing y magnitud.
  //   - Umbrales: > 0% → neutro · < 0% → contractivo (+2 stress) · < -5% → deflacionario (+3).
  // FIX-CLIFF-STRESS-02: contribución continua (0→3 pts en +1%→−5%, sin cliff en 0).
  //   QT marginal (−0.28%) aporta ~0.72 pts, no 2.0 — proporcional a su profundidad.
  score += cbLiquidityStressContribution(inputs.cbLiquidityGrowth);

  let regime: StressRegime = "NORMAL";
  if (score >= 6) regime = "CRISIS";
  else if (score >= 5) regime = "HIGH_RISK"; // FIX-CONTRACTION-LAG: subido 4→5. Elimina falsos positivos a VIX 20-25 con BTC vol normal.

  return { score, regime, wtiShock, wtiPenalty };
}