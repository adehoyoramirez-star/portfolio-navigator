// FIX-AUDIT-C5: thresholds centralizados en CORRELATION_PANIC_CONFIG:
//   PANIC_THRESHOLD (0.85) → multiplier 0.60 (40% penalty)
//   DIVERSIFICATION_COLLAPSE (0.60) → multiplier 0.80 (20% penalty)
// Antes hardcodeados como 0.7 y 0.5.
import { CORRELATION_PANIC_CONFIG } from "../config/engineConfig";

export function correlationPenalty(correlationMatrix: number[][]): number {
  const n = correlationMatrix.length;
  if (n < 2) return 1;

  let totalCorrAbs = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      totalCorrAbs += Math.abs(correlationMatrix[i][j]);
      count++;
    }
  }

  // FIX-CORR-ABS (22-Jun-2026): usar valor absoluto de correlaciones.
  // Correlaciones negativas (ej: BTC↔oro = -0.05) reducían la media
  // artificialmente → penalización no se activaba cuando debía.
  // Con abs(), el promedio refleja la magnitud real de comovimiento.
  const avgCorr = count > 0
    ? totalCorrAbs / count
    : 0;

  if (avgCorr > CORRELATION_PANIC_CONFIG.PANIC_THRESHOLD) return 0.6;
  if (avgCorr > CORRELATION_PANIC_CONFIG.DIVERSIFICATION_COLLAPSE) return 0.8;
  return 1;
}