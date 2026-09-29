// ============================================================
// src/core/risk/drawdown.ts
// LIVE/BACKTEST CONTRACT v1.0.1 — denominador de drawdown unificado.
//
// PROBLEMA (Phase 11 §11, brecha HIGH #1):
//   LIVE (InstitutionalDashboard) y BACKTEST (backtestEngine) calculaban el
//   drawdown con fórmulas duplicadas en archivos distintos. Dos
//   implementaciones = riesgo de divergencia silenciosa ante cualquier cambio
//   unilateral (el bug de clase que la auditoría persigue).
//
// CONTRATO ÚNICO (identidad canónica, idéntica en ambos lados desde Jul-2026):
//   DD = currentTotal <= 0 ? 0 : min(0, (currentTotal - peak) / peak)
//   peak = HWM externo si existe (>0), si no currentTotal (DD = 0 en arranque).
//
//   - Denominador: patrimonio TOTAL real (el caller decide qué incluye: en
//     live = posiciones + cash + defensiveLiquidity; en backtest = sleeve o
//     composite según el override de acoplamiento del satélite).
//   - Denominador SIN look-ahead: el peak solo puede crecer con valores ya
//     observados (HWM persistido en live; peakValue causal en backtest).
//   - HWM resettable: el caller puede inyectar reset/inflación de composición
//     vía getPeak() (ver handleResetHWM en InstitutionalDashboard).
//
// REGLA: cualquier cambio futuro de esta definición es un cambio de CONTRATO
// (change-control v1.x, spec §18) y debe tocar EXACTAMENTE este archivo.
// ============================================================

export interface DrawdownArgs {
  currentTotal: number;
  /** High-Water Mark externo. >0 → peak = hwm; <=0/undefined → peak = currentTotal (DD 0). */
  hwm?: number;
}

/**
 * Definición canónica y única de drawdown del sistema.
 * Devuelve SIEMPRE un valor <= 0 (0 = sin drawdown / nuevo máximo).
 */
export function computeUnifiedDrawdown({ currentTotal, hwm }: DrawdownArgs): number {
  if (!Number.isFinite(currentTotal) || currentTotal <= 0) return 0;
  const peak = hwm !== undefined && Number.isFinite(hwm) && hwm > 0 ? hwm : currentTotal;
  if (currentTotal > peak) return 0; // nuevo máximo → DD 0%
  return Math.min(0, (currentTotal - peak) / peak);
}

/**
 * Helper de HWM para callers con persistencia (live). Encapsula la regla:
 * el HWM solo sube cuando el valor actual supera el máximo histórico real.
 * Devuelve el HWM actualizado y si debe persistirse.
 */
export function updateHighWaterMark(
  currentTotal: number,
  previousHwm: number,
): { hwm: number; changed: boolean } {
  if (Number.isFinite(currentTotal) && currentTotal > previousHwm) {
    return { hwm: currentTotal, changed: true };
  }
  return { hwm: previousHwm, changed: false };
}
