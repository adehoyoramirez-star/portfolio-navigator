// ===============================================
// ARCHIVO: src/core/alerts/regimeAlerts.ts
// NIVEL 4 — Sistema de alertas de cambio de régimen
// ===============================================
// FIX-ALERT-01: el mensaje de Vol Target tenía hardcodeado "18%".
//   Ahora lee VOLATILITY_CONFIG.DEFAULT_TARGET_VOL para que el mensaje
//   refleje siempre el target real del motor (actualmente 20%).
// ===============================================

import { VOLATILITY_CONFIG } from "../config/engineConfig";

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
  killSwitchLevel: number;
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

  // ── DEBOUNCE: Tail Risk alert solo se emite 1 vez por hora ──────
  // FIX-ALERT-SPAM: sin debounce, el Kill Switch generaba una alerta nueva
  // en cada tick de precio (cada ~60s con live monitor activo). El id `tail_${Date.now()}`
  // era siempre único → 10+ alertas idénticas en el panel. Ahora: cooldown de 1h.
  const TAIL_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hora
  const lastTailAlert = getLastTailAlertTimestamp();
  // FIX-ALERT-DD-STALE: si el DD cambió >2pp desde la última alerta,
  // invalidar debounce. Evita que alertas con DD viejo (ej: -41%) persistan
  // después de que el usuario resetea el HWM (DD real: -14%).
  const lastTailAlertDD = getLastTailAlertDD();
  const ddChangedSignificantly = lastTailAlertDD !== null &&
    Math.abs(input.portfolioDrawdown - lastTailAlertDD) > TAIL_DD_CHANGE_THRESHOLD;
  const tailDebounced = !ddChangedSignificantly && lastTailAlert !== null && (Date.now() - lastTailAlert) < TAIL_DEBOUNCE_MS;

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
  if (input.tailRiskActive && !tailDebounced) {
    setLastTailAlertTimestamp(Date.now());
    setLastTailAlertDD(input.portfolioDrawdown);
    alerts.push({
      id: `tail_${Date.now()}`,
      timestamp: now,
      severity: (input.killSwitchLevel ?? 0) >= 3 ? "CRITICAL" : "WARNING",
      title: `⚠️ Tail Risk Overlay activo (L${input.killSwitchLevel ?? 0})`,
      message: input.tailRiskReason,
      action: (input.killSwitchLevel ?? 0) >= 4
        ? "El motor ha reducido la exposicion total. No realizar compras adicionales hasta que el overlay se desactive."
        : "El motor ha reducido la exposicion. DCA escalado — compras reducidas pero permitidas.",
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
      message: `La volatilidad realizada del portfolio supera el objetivo del ${(VOLATILITY_CONFIG.DEFAULT_TARGET_VOL * 100).toFixed(0)}%. El motor escala exposición a ×${input.volTargetMultiplier.toFixed(2)}.`,
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

// ── DEBOUNCE HELPERS ───────────────────────────────────────────
// FIX-ALERT-SPAM: guardar timestamp del último Tail Risk alert en sessionStorage
// (no localStorage — se limpia al cerrar pestaña, el debounce es por sesión)
// FIX-ALERT-DD-STALE (Jul-2026): si el DD cambia >2pp desde la última alerta,
// invalidar el debounce. Sin esto, reseteos de HWM dejan alertas con DD del pasado.
const TAIL_ALERT_KEY = 'olympus_last_tail_alert_ts';
const TAIL_ALERT_DD_KEY = 'olympus_last_tail_alert_dd';
const TAIL_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hora
const TAIL_DD_CHANGE_THRESHOLD = 0.02;   // 2pp — si el DD cambio esto, nueva alerta

function getLastTailAlertTimestamp(): number | null {
  try {
    const raw = sessionStorage.getItem(TAIL_ALERT_KEY);
    return raw ? parseInt(raw, 10) : null;
  } catch { return null; }
}

function getLastTailAlertDD(): number | null {
  try {
    const raw = sessionStorage.getItem(TAIL_ALERT_DD_KEY);
    return raw ? parseFloat(raw) : null;
  } catch { return null; }
}

function setLastTailAlertTimestamp(ts: number): void {      try { sessionStorage.setItem(TAIL_ALERT_KEY, String(ts)); } catch { console.warn('[regimeAlerts] sessionStorage setItem failed for TAIL_ALERT_KEY'); }
}

function setLastTailAlertDD(dd: number): void {      try { sessionStorage.setItem(TAIL_ALERT_DD_KEY, String(dd)); } catch { console.warn('[regimeAlerts] sessionStorage setItem failed for TAIL_ALERT_DD_KEY'); }
}

function worsenedRegime(prev: string, curr: string): boolean {
  return (REGIME_PRIORITY[curr] ?? 0) > (REGIME_PRIORITY[prev] ?? 0);
}

function improvedRegime(prev: string, curr: string): boolean {
  return (REGIME_PRIORITY[curr] ?? 0) < (REGIME_PRIORITY[prev] ?? 0);
}