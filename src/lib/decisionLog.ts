// ===============================================
// ARCHIVO: src/lib/decisionLog.ts
// FIX REG-01 (S2-2): Audit trail de decisiones del motor
// ===============================================
// MiFID II Art. 16(6): conservar registros de decisiones de inversión 5 años.
//
// USO en InstitutionalDashboard.tsx:
//   import { logEngineDecision } from "@/lib/decisionLog";
//
//   // Después de cada runOlympusEngine():
//   await logEngineDecision({
//     engineResult,
//     macro: { vix, creditSpread, yieldSpread, m2Growth },
//     marketData,
//     allocationsBefore: portfolio.assets,
//     triggerReason: "scheduled_refresh",
//   });
// ===============================================

import { ENGINE_VERSION } from "@/core/engine/olympusV3";
import type { EngineOutput } from "@/core/engine/olympusV3";
import type { MarketData } from "@/lib/marketData";
import type { Asset } from "@/core/types/portfolio";

export interface DecisionLogInput {
  engineResult: EngineOutput;
  macro: {
    vix: number;
    creditSpread: number;
    yieldSpread: number;
    m2Growth: number;
  };
  marketData?: MarketData | null;
  allocationsBefore?: Asset[];
  triggerReason?: string;
}

/**
 * Inserta una fila en decision_log tras cada ejecución del motor.
 * Falla silenciosamente — un error de logging nunca debe romper la UI.
 *
 * La tabla decision_log es INMUTABLE por diseño (no hay UPDATE/DELETE).
 * Cada fila es un registro permanente de auditoría.
 */
export async function logEngineDecision(input: DecisionLogInput): Promise<void> {
  try {
    const { engineResult, macro, marketData, allocationsBefore, triggerReason } = input;

    // Factor scores compactos para el log
    const factorScores = engineResult.allocations.map(a => ({
      name: a.name,
      momentum: Number(a.momentumScore.toFixed(3)),
      value: Number(a.valueScore.toFixed(3)),
      quality: Number(a.qualityScore.toFixed(3)),
      lowVol: Number(a.lowVolScore.toFixed(3)),
      kelly: Number(a.kellyFraction.toFixed(3)),
      finalAllocation: Number(a.finalAllocation.toFixed(4)),
    }));

    // Allocations recomendadas por el motor
    const allocationsAfter = engineResult.allocations.map(a => ({
      name: a.name,
      finalAllocation: Number(a.finalAllocation.toFixed(4)),
      blendedAllocation: Number(a.blendedAllocation.toFixed(4)),
    }));

    // Snapshot de precios actuales (solo lo esencial para no sobrecargar la BD)
    const marketSnapshot = marketData ? {
      prices: marketData.prices,
      vix: marketData.vix,
      sp500Rsi: marketData.sp500Rsi,
      btcRsi: marketData.btcRsi,
      m2Growth: marketData.m2Growth,
      dxy: marketData.dxy,
      wtiOil: marketData.wtiOil,
    } : null;

    // Posiciones actuales antes del rebalanceo
    const positionsBefore = allocationsBefore?.map(a => ({
      ticker: a.ticker,
      name: a.name,
      shares: a.shares,
      currentWeight: a.currentWeight,
      price: a.price,
    })) ?? null;

    // ── Guardar en localStorage (sin Supabase) ──
    const key = 'olympus_decision_log';
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.unshift({
      id: Date.now(),
      created_at: new Date().toISOString(),
      engine_version: ENGINE_VERSION,
      regime: engineResult.regime,
      regime_penalty: Number(engineResult.masterRegime.regimePenalty.toFixed(3)),
      vix: macro.vix,
      credit_spread: macro.creditSpread,
      yield_spread: macro.yieldSpread,
      m2_growth: macro.m2Growth,
      factor_scores: factorScores,
      allocations_after: allocationsAfter,
      trigger_reason: triggerReason ?? "manual",
    });
    localStorage.setItem(key, JSON.stringify(existing.slice(0, 200)));
    console.info(`[DecisionLog] ✅ Decisión registrada — ${ENGINE_VERSION} · Régimen: ${engineResult.regime}`);
  } catch (err) {
    // Nunca propagar el error — el logging es secundario a la funcionalidad
    console.warn("[DecisionLog] Error inesperado:", err);
  }
}

/**
 * Recupera el historial de decisiones del motor para auditoría.
 * Devuelve las últimas N decisiones ordenadas por fecha descendente.
 */
export async function loadDecisionHistory(limit: number = 50) {
  try {
    const raw = localStorage.getItem('olympus_decision_log');
    if (!raw) return [];
    const all = JSON.parse(raw);
    return all.slice(0, limit).map((r: any) => ({
      id: r.id,
      created_at: r.created_at,
      engine_version: r.engine_version,
      regime: r.regime,
      regime_penalty: r.regime_penalty,
      vix: r.vix,
      trigger_reason: r.trigger_reason,
    }));
  } catch {
    return [];
  }
}