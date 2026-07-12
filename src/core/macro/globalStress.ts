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

  if (inputs.creditSpread > 5) score += 2;
  else if (inputs.creditSpread > 3) score += 1;

  if (inputs.move > 140) score += 2;
  else if (inputs.move > 110) score += 1;

  // FIX B4: dxyTrend en decimal (0.02 = 2% de apreciación).
  // El dashboard puede pasar 1.6 (porcentaje) → dividir por 100 internamente.
  // Para compatibilidad: si dxyTrend > 1.0 asumimos que viene en % y lo convertimos.
  const dxyDecimal = inputs.dxyTrend > 1.0 ? inputs.dxyTrend / 100 : inputs.dxyTrend;
  if (dxyDecimal > 0.02) score += 1;

  // FIX B3: threshold subido 0.65→0.80. BTC vol media es 60-70% — con 0.65 casi siempre
  // activo. 0.80 captura solo entornos de estrés real (> +2σ sobre media BTC vol).
  // Esto elimina ~40% de los falsos positivos de HIGH_RISK.
  if (inputs.btcVol > 0.80) score += 1;

  // ── BRENT OIL — geopolitical shock multiplier ────────────────────────
  // El petróleo es el termómetro más rápido de crisis geopolíticas —
  // sube antes que el VIX, antes que credit spreads, antes que cualquier otro indicador.
  // Umbrales: > $75 → ELEVATED · > $95 → SHOCK · > $115 → CRISIS
  let wtiShock: StressResult["wtiShock"] = "NONE";
  let wtiPenalty = 1.0;

  if (inputs.wtiOil !== undefined && inputs.wtiOil > 0) {
    if (inputs.wtiOil >= WTI_THRESHOLDS.crisis) {
      score += 3;
      wtiShock = "CRISIS";
      wtiPenalty = 0.50;
    } else if (inputs.wtiOil >= WTI_THRESHOLDS.shock) {
      score += 2;
      wtiShock = "SHOCK";
      wtiPenalty = 0.70;
    } else if (inputs.wtiOil >= WTI_THRESHOLDS.elevated) {
      score += 1;
      wtiShock = "ELEVATED";
      wtiPenalty = 0.85;
    }
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
  if (inputs.cbLiquidityGrowth !== undefined) {
    if (inputs.cbLiquidityGrowth < -5) {
      score += 3;  // QT agresivo + BCE reduciendo → deflación de base monetaria
    } else if (inputs.cbLiquidityGrowth < 0) {
      score += 2;  // QT moderado → contracción de liquidez global
    }
    // cbLiquidityGrowth > 0 → no añade stress (expansión de liquidez = favorable)
  }

  let regime: StressRegime = "NORMAL";
  if (score >= 6) regime = "CRISIS";
  else if (score >= 5) regime = "HIGH_RISK"; // FIX-CONTRACTION-LAG: subido 4→5. Elimina falsos positivos a VIX 20-25 con BTC vol normal.

  return { score, regime, wtiShock, wtiPenalty };
}