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

import { supabase } from "@/integrations/supabase/client";
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

    const { error } = await (supabase as any)
      .from("decision_log")
      .insert({
        engine_version:       ENGINE_VERSION,
        regime:               engineResult.regime,
        regime_penalty:       Number(engineResult.masterRegime.regimePenalty.toFixed(3)),
        vix:                  macro.vix,
        credit_spread:        macro.creditSpread,
        yield_spread:         macro.yieldSpread,
        m2_growth:            macro.m2Growth,
        market_data_snapshot: marketSnapshot,
        factor_scores:        factorScores,
        allocations_before:   positionsBefore,
        allocations_after:    allocationsAfter,
        trigger_reason:       triggerReason ?? "manual",
      });

    if (error) {
      // Log del error pero no romper la UI
      console.warn("[DecisionLog] Error insertando en decision_log:", error.message);
    } else {
      console.info(`[DecisionLog] ✅ Decisión registrada — ${ENGINE_VERSION} · Régimen: ${engineResult.regime}`);
    }
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
  const { data, error } = await (supabase as any)
    .from("decision_log")
    .select("id, created_at, engine_version, regime, regime_penalty, vix, trigger_reason")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("[DecisionLog] Error cargando historial:", error.message);
    return [];
  }

  return data ?? [];
}