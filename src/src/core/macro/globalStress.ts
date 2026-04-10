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
}

export type StressRegime = "NORMAL" | "HIGH_RISK" | "CRISIS";

export interface StressResult {
  score: number;
  regime: StressRegime;
  wtiShock: "NONE" | "ELEVATED" | "SHOCK" | "CRISIS";  // nivel de shock petrolero
  wtiPenalty: number;   // multiplicador adicional [0.5, 1.0] por petróleo
}

// Umbrales Brent calibrados históricamente (Brent cotiza $3-5 sobre WTI):
// < $75  → normal
// $75–95 → elevated (tensión geopolítica moderada)
// $95–115 → shock (conflicto regional — Ucrania 2022 llegó a $130)
// > $115 → crisis (Suez 1973, Iraq 2003, Iran 2026)
const WTI_THRESHOLDS = { elevated: 75, shock: 95, crisis: 115 } as const;

export function computeGlobalStress(inputs: StressInputs): StressResult {
  let score = 0;

  if (inputs.vix > 25) score += 2;
  else if (inputs.vix > 18) score += 1;

  if (inputs.creditSpread > 5) score += 2;
  else if (inputs.creditSpread > 3) score += 1;

  if (inputs.move > 140) score += 2;
  else if (inputs.move > 110) score += 1;

  if (inputs.dxyTrend > 0.02) score += 1;

  if (inputs.btcVol > 0.8) score += 1;

  // ── WTI OIL — geopolitical shock multiplier ──────────────────────────
  // El petróleo es el termómetro más rápido de crisis geopolíticas —
  // sube antes que el VIX, antes que credit spreads, antes que cualquier otro indicador.
  let wtiShock: StressResult["wtiShock"] = "NONE";
  let wtiPenalty = 1.0;

  if (inputs.wtiOil !== undefined && inputs.wtiOil > 0) {
    if (inputs.wtiOil >= WTI_THRESHOLDS.crisis) {
      // > $110: crisis energética — penalización severa
      score += 3;
      wtiShock = "CRISIS";
      wtiPenalty = 0.50;
    } else if (inputs.wtiOil >= WTI_THRESHOLDS.shock) {
      // $90–$110: shock geopolítico — penalización importante
      score += 2;
      wtiShock = "SHOCK";
      wtiPenalty = 0.70;
    } else if (inputs.wtiOil >= WTI_THRESHOLDS.elevated) {
      // $70–$90: tensión elevada — penalización leve
      score += 1;
      wtiShock = "ELEVATED";
      wtiPenalty = 0.85;
    }
  }

  let regime: StressRegime = "NORMAL";
  if (score >= 6) regime = "CRISIS";
  else if (score >= 3) regime = "HIGH_RISK";

  return { score, regime, wtiShock, wtiPenalty };
}