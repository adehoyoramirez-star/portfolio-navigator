// ===============================================
// INSTITUTIONAL MACRO DECISION ENGINE (HEDGE FUND)
// ===============================================

export type DecisionInput = {
  erp: number;           // Prima de riesgo (en tanto por uno, ej. 0.025 = 2.5%)
  liquidity: number;     // Score de liquidez (0-1)
  regimeScore: number;   // Score de régimen (0-1)
  vix: number;           // Nivel de VIX (0-100)
  rsi: number;           // RSI del mercado (0-100)
  momentum: number;      // Momentum (-1 a 1, donde -1 es bajista, 1 alcista)
}

export type DecisionOutput = {
  action: "BUY" | "HOLD" | "TRIM";
  conviction: number;    // 0-100
  explanation: string;
  factors: {              // Nuevo: desglose de la influencia de cada factor
    erp: number;
    liquidity: number;
    regime: number;
    vix: number;
    rsi: number;
    momentum: number;
  };
}

export function generateDecision(input: DecisionInput): DecisionOutput {
  const { erp, liquidity, regimeScore, vix, rsi, momentum } = input;

  // --- Convertir cada indicador a un score normalizado (0-1) donde 1 es favorable ---

  // ERP: >5% es muy favorable, <3% es desfavorable
  const erpScore = Math.min(1, Math.max(0, (erp - 0.02) / 0.05));

  // Liquidez: >0.6 es buena, <0.4 es mala
  const liqScore = liquidity;

  // Régimen: igual que liquidez por ahora
  const regScore = regimeScore;

  // VIX: bajo es favorable (inversa). VIX=10 → 1, VIX=30 → 0
  const vixScore = Math.min(1, Math.max(0, (30 - vix) / 20));

  // RSI: 30-70 es rango normal. Por debajo de 30 es sobreventa (favorable), por encima de 70 sobrecompra (desfavorable)
  const rsiScore = rsi > 70 ? 0 : rsi < 30 ? 1 : (70 - rsi) / 40;

  // Momentum: positivo es favorable. Convertimos de [-1,1] a [0,1]
  const momScore = (momentum + 1) / 2;

  // --- Calcular convicción como media ponderada (pesos ajustables) ---
  const weights = {
    erp: 0.25,
    liquidity: 0.20,
    regime: 0.15,
    vix: 0.15,
    rsi: 0.15,
    momentum: 0.10
  };

  const rawScore =
    erpScore * weights.erp +
    liqScore * weights.liquidity +
    regScore * weights.regime +
    vixScore * weights.vix +
    rsiScore * weights.rsi +
    momScore * weights.momentum;

  const conviction = Math.min(100, Math.max(0, rawScore * 100));

  // --- Lógica de acción (umbrales ajustables) ---
  let action: "BUY" | "HOLD" | "TRIM" = "HOLD";

  // Condiciones para BUY (todas deben cumplirse)
  const buyConditions =
    erp > 0.045 &&
    liquidity > 0.55 &&
    vix < 22 &&
    rsi < 65 &&
    rsi > 35 &&
    momentum > 0;

  // Condiciones para TRIM (cualquiera puede activarlo)
  const trimConditions =
    erp < 0.03 ||
    liquidity < 0.4 ||
    vix > 25 ||
    rsi > 75 ||
    rsi < 25 ||
    momentum < -0.2;

  if (buyConditions) {
    action = "BUY";
  } else if (trimConditions) {
    action = "TRIM";
  } else {
    action = "HOLD";
  }

  // --- Explicación detallada ---
  const explanation = generateExplanation(action, {
    erp, liquidity, regimeScore, vix, rsi, momentum,
    erpScore, liqScore, vixScore, rsiScore, momScore
  });

  return {
    action,
    conviction,
    explanation,
    factors: {
      erp: erpScore,
      liquidity: liqScore,
      regime: regScore,
      vix: vixScore,
      rsi: rsiScore,
      momentum: momScore
    }
  };
}

// Función auxiliar para generar explicación legible
function generateExplanation(
  action: "BUY" | "HOLD" | "TRIM",
  scores: any
): string {
  const lines = [];

  if (action === "BUY") {
    lines.push("✅ CONDICIONES FAVORABLES: Se recomienda COMPRAR.");
    lines.push("Factores clave:");
    if (scores.erp > 0.045) lines.push("• ERP atractivo (>4.5%)");
    if (scores.liquidity > 0.55) lines.push("• Liquidez sólida (>0.55)");
    if (scores.vix < 22) lines.push("• VIX bajo (<22), menor volatilidad esperada");
    if (scores.rsi > 35 && scores.rsi < 65) lines.push("• RSI en zona neutral (35-65)");
    if (scores.momentum > 0) lines.push("• Momentum positivo");
  } else if (action === "TRIM") {
    lines.push("⚠️ SEÑALES DE PRECAUCIÓN: Se recomienda RECORTAR exposición.");
    lines.push("Factores de alerta:");
    if (scores.erp < 0.03) lines.push("• ERP comprimido (<3%)");
    if (scores.liquidity < 0.4) lines.push("• Liquidez baja (<0.4)");
    if (scores.vix > 25) lines.push("• VIX elevado (>25), aumento de volatilidad");
    if (scores.rsi > 75) lines.push("• RSI sobrecomprado (>75)");
    if (scores.rsi < 25) lines.push("• RSI sobrevendido extremo (<25), posible rebote pero con riesgo");
    if (scores.momentum < -0.2) lines.push("• Momentum negativo");
  } else {
    lines.push("⚖️ CONDICIONES NEUTRALES: Se recomienda MANTENER.");
    lines.push("No hay señales claras de compra o venta.");
  }

  return lines.join(" ");
}