// ===============================================
// ARCHIVO: src/core/alerts/regimeAlerts.ts
// NIVEL 4 — Sistema de alertas de cambio de régimen
// ===============================================

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface RegimeAlert {
  id: string;
  timestamp: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  action: string;        // qué hacer
  dismissible: boolean;
  regime: string;
}

export interface AlertInput {
  currentRegime: string;
  previousRegime: string | null;
  regimePenalty: number;
  confidence: string;
  tailRiskActive: boolean;
  tailRiskReason: string;
  vix: number;
  portfolioDrawdown: number;
  volTargetMultiplier: number;
}

/**
 * Genera alertas accionables basadas en cambios del motor.
 * Solo genera alertas cuando algo cambia — no en cada render.
 */
export function generateAlerts(input: AlertInput): RegimeAlert[] {
  const alerts: RegimeAlert[] = [];
  const now = new Date().toISOString();

  // ---- CAMBIO DE RÉGIMEN ----
  if (input.previousRegime && input.currentRegime !== input.previousRegime) {
    const isWorsen = worsenedRegime(input.previousRegime, input.currentRegime);
    const isImprove = improvedRegime(input.previousRegime, input.currentRegime);

    if (isWorsen) {
      alerts.push({
        id: `regime_${Date.now()}`,
        timestamp: now,
        severity: input.currentRegime === "CRISIS" ? "CRITICAL" : "WARNING",
        title: `Régimen: ${input.previousRegime} → ${input.currentRegime}`,
        message: `El motor ha detectado deterioro macro. Penalización de allocations: ×${input.regimePenalty.toFixed(2)}.`,
        action: input.currentRegime === "CRISIS"
          ? "Revisar posiciones. El motor está reduciendo exposición al 40%. Considera no hacer compras nuevas."
          : "El motor reduce exposición al 70%. DCA mensual puede continuar con cautela.",
        dismissible: true,
        regime: input.currentRegime,
      });
    }

    if (isImprove) {
      alerts.push({
        id: `regime_improve_${Date.now()}`,
        timestamp: now,
        severity: "INFO",
        title: `Régimen mejorado: ${input.previousRegime} → ${input.currentRegime}`,
        message: `Las condiciones macro han mejorado. El motor está incrementando la exposición.`,
        action: "Momento favorable para ejecutar compras programadas.",
        dismissible: true,
        regime: input.currentRegime,
      });
    }
  }

  // ---- TAIL RISK ACTIVADO ----
  if (input.tailRiskActive) {
    alerts.push({
      id: `tail_${Date.now()}`,
      timestamp: now,
      severity: "CRITICAL",
      title: "⚠️ Tail Risk Overlay activo",
      message: input.tailRiskReason,
      action: "El motor ha reducido la exposición total. No realizar compras adicionales hasta que el overlay se desactive.",
      dismissible: false,
      regime: input.currentRegime,
    });
  }

  // ---- VIX EXTREMO ----
  if (input.vix > 40) {
    alerts.push({
      id: `vix_${Date.now()}`,
      timestamp: now,
      severity: "CRITICAL",
      title: `VIX extremo: ${input.vix.toFixed(0)}`,
      message: "Nivel de miedo de mercado históricamente alto (percentil >95%). Correlaciones entre activos tienden a converger a 1 en estos niveles.",
      action: "Mantener liquidez. Esperar estabilización del VIX antes de compras.",
      dismissible: true,
      regime: input.currentRegime,
    });
  } else if (input.vix > 30) {
    alerts.push({
      id: `vix_warn_${Date.now()}`,
      timestamp: now,
      severity: "WARNING",
      title: `VIX elevado: ${input.vix.toFixed(0)}`,
      message: "Volatilidad implícita por encima del umbral de cautela (30).",
      action: "DCA puede continuar pero reducir tamaño de compras un 30-50%.",
      dismissible: true,
      regime: input.currentRegime,
    });
  }

  // ---- VOL TARGET REDUCIENDO EXPOSICIÓN ----
  if (input.volTargetMultiplier < 0.7) {
    alerts.push({
      id: `voltarget_${Date.now()}`,
      timestamp: now,
      severity: "WARNING",
      title: `Vol Target: exposición reducida al ${(input.volTargetMultiplier * 100).toFixed(0)}%`,
      message: `La volatilidad realizada del portfolio supera el objetivo del 14%. El motor escala exposición a ×${input.volTargetMultiplier.toFixed(2)}.`,
      action: "No incrementar posiciones hasta que la volatilidad se normalice.",
      dismissible: true,
      regime: input.currentRegime,
    });
  }

  return alerts;
}

// ==================== HELPERS ====================

const REGIME_PRIORITY: Record<string, number> = {
  EXPANSION: 0, CONTRACTION: 1, CRISIS: 2, ALL_CASH: 3,
};

function worsenedRegime(prev: string, curr: string): boolean {
  return (REGIME_PRIORITY[curr] ?? 0) > (REGIME_PRIORITY[prev] ?? 0);
}

function improvedRegime(prev: string, curr: string): boolean {
  return (REGIME_PRIORITY[curr] ?? 0) < (REGIME_PRIORITY[prev] ?? 0);
}