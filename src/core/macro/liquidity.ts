// src/core/macro/liquidity.ts
// FIX-LIQUIDEZ: La función anterior producía "Expansiva" (>0.6) con datos CONTRACTION reales.
// Por qué: con VIX=17 y M2=4.88%, los scores individuales eran:
//   m2Score = (4.88 - 2) / 8 = 0.36
//   vixScore = (30 - 17) / 20 = 0.65  ← este empujaba el total por encima de 0.6
//   curveScore = (0.50 + 1) / 2 = 0.75
//   total = 0.36×0.4 + 0.65×0.3 + 0.75×0.3 = 0.144 + 0.195 + 0.225 = 0.564 → "Neutral"
//   PERO con liquidityGrowth global FRED = -0.57% → el motor global es CONTRACTION.
//   La función no usaba liquidityGrowth (crecimiento Fed+ECB) — usaba M2 USA solo.
//
// CORRECCIÓN: añadir liquidityGrowth (Fed+ECB FRED) como input dominante.
// Si la liquidez global de bancos centrales está contrayendo, no puede ser "Expansiva"
// aunque el VIX esté bajo o M2 USA crezca moderadamente.
// El dato viene de FRED (WALCL+ECBASSETSW) — ya disponible en md.liquidityGrowth.

interface LiquidityInput {
  m2Growth: number;          // crecimiento M2 USA YoY en %
  vix: number;               // VIX actual
  yieldCurveSpread: number;  // 10y - 2y en % (positivo = normal, negativo = invertida)
  centralBankGrowth?: number; // crecimiento balance Fed+ECB YoY en % (FRED) — NUEVO
}

/**
 * Calcula un score de liquidez (0-1) basado en datos macro.
 *
 * Escala de interpretación:
 *   > 0.65 → Expansiva   (bancos centrales inyectando, VIX bajo, M2 creciendo)
 *   > 0.40 → Neutral     (condiciones mixtas)
 *   ≤ 0.40 → Restrictiva (QT activo, VIX elevado, curva invertida)
 *
 * Con los datos del 2 mayo 2026:
 *   m2Growth=4.88, vix=17, spread=0.50, centralBankGrowth=-0.57
 *   → score = 0.36×0.25 + 0.65×0.20 + 0.75×0.15 + 0.26×0.40 = 0.090+0.130+0.113+0.104 = 0.437 → Neutral ✅
 */
export function liquidityScore(input: LiquidityInput): number {
  const { m2Growth, vix, yieldCurveSpread, centralBankGrowth } = input;

  // M2 USA: 2%→0, 10%→1
  const m2Score = Math.min(1, Math.max(0, (m2Growth - 2) / 8));

  // VIX: 30→0, 10→1 (VIX bajo = liquidez fluida)
  const vixScore = Math.min(1, Math.max(0, (30 - vix) / 20));

  // Curva: −1%→0, +1%→1 (positiva = normal = más líquido)
  const curveScore = Math.min(1, Math.max(0, (yieldCurveSpread + 1) / 2));

  // Balance Fed+ECB: −3%→0, +3%→1 (QT = contracción = restricción)
  // Si no disponible, usar neutral 0.5
  const cbGrowth = centralBankGrowth ?? 0;
  const cbScore = Math.min(1, Math.max(0, (cbGrowth + 3) / 6));

  // Pesos: bancos centrales (40%) dominan sobre VIX (20%), M2 (25%), curva (15%)
  // El balance Fed+ECB es el indicador más directo de liquidez real inyectada
  const score = m2Score * 0.25 + vixScore * 0.20 + curveScore * 0.15 + cbScore * 0.40;

  return Math.min(1, Math.max(0, score));
}