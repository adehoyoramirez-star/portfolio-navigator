// ============================================================
// ARCHIVO: src/lib/decisionRecord.ts
// FIX-REG-AUDIT (Oct-2026): REGISTRO DE DECISIÓN COMPLETO Y TRAZABLE.
//
// MOTIVO (hallazgo de auditoría, Bloque 3):
//   El registro anterior guardaba SOLO las allocations y el régimen. No
//   permitía reconstruir POR QUÉ se decidió: faltaban los inputs manuales
//   (MVRV Z, spot/LT uranio, P/E, compras BC, PER y bono manuales, DXY...)
//   con su VALOR, su FECHA de entrada (asOf) y su FUENTE, y faltaba dejar
//   constancia de qué campos degradó la política de data quality.
//
// DISEÑO (invariantes):
//   1. El registro es INMUTABLE y APPEND-ONLY. Cada ejecución añade una fila
//      nueva; nunca se reescribe una anterior.
//   2. Los DATOS MANUALES SON CORRECTOS. Aquí no se juzga su valor: se
//      ESTAMPA (valor + asOf + fuente) para que la decisión sea reconstruible
//      y auditable (MiFID II Art. 16(6)).
//   3. ENCADENADO: record_hash = H(prev_hash + canonical(registro sin hash)).
//      Una fila alterada rompe la cadena de todas las posteriores.
//   4. DETERMINISMO: canonicalize() produce exactamente el mismo texto para
//      el mismo contenido → el hash es reproducible en cualquier máquina.
//
// Módulo PURO: no toca red, ni localStorage, ni el motor (ver decisionLog.ts).
// ============================================================

import type { EngineOutput } from "@/core/engine/olympusV3";
import type { MarketData } from "@/lib/marketData";
import type { Asset } from "@/core/types/portfolio";

// ── Procedencia de un input ────────────────────────────────────────────────
export interface ProvenanceEntry {
  /** Valor exacto que el motor recibió. */
  value: number | string | boolean | null;
  /** Epoch ms de la última edición del dato, si se conoce. */
  as_of_ms: number | null;
  /** ISO 8601 derivado de as_of_ms (null si se desconoce). */
  as_of: string | null;
  /** De dónde vino el valor: 'manual', 'yahoo', 'fred', 'glassnode', ... */
  source: string;
}

/** Declaración de input de auditoría: nombre + valor + procedencia. */
export interface ManualInputDeclaration {
  value: number | string | boolean | null | undefined;
  asOfMs?: number;
  source?: string;
}

export interface DecisionRecordInput {
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
  /** Inputs manuales con su procedencia. Es la pieza que faltaba. */
  manualInputs?: Record<string, ManualInputDeclaration>;
  /** Resultado de la política de data quality en la frontera del detector. */
  dataQuality?: { stale: string[]; blocked: string[] };
  /** Camino de producción que produjo la decisión. */
  path?: "core" | "legacy";
  configVersion?: string;
  /** Epoch ms de captura (inyectable para tests deterministas). */
  capturedAt?: number;
  /** Contexto de cartera (opcional; se omite si no se pasa). */
  portfolio?: {
    drawdown?: number;
    realizedVol?: number;
    availableCash?: number;
    totalPortfolioValue?: number;
  };
}

export interface DecisionRecord {
  captured_at: string;
  engine_version: string;
  config_version: string;
  path: "core" | "legacy";
  trigger_reason: string;
  regime: string;
  regime_penalty: number;
  inputs: Record<string, unknown>;
  data_quality: { stale: string[]; blocked: string[] };
  risk_chain: Record<string, unknown>;
  breadth: Record<string, unknown>;
  allocations_before: unknown;
  allocations_after: unknown;
  prev_hash: string | null;
  record_hash?: string;
}

// ── Utilidades numéricas: NaN/Inf NO son JSON y rompen el determinismo ─────
function safeNumber(v: number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  return Number.isFinite(v) ? v : null;
}

function round(v: number | undefined | null, digits = 6): number | null {
  const n = safeNumber(v);
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ============================================================
// CANONICALIZACIÓN
// ============================================================
// Reglas (deterministas, documentadas):
//   · claves de objeto ordenadas alfabéticamente (recursivo)
//   · arrays en su orden original (el orden ES información)
//   · `undefined` se OMITE (no se serializa como null)
//   · números no finitos → null
//   · Date → ISO 8601
//   · sin espacios
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = canonicalValue(src[k]);
      if (v !== undefined) out[k] = v; // undefined = campo ausente
    }
    return out;
  }
  return String(value); // funciones/símbolos: no esperados, se degradan a texto
}

// ============================================================
// HASH
// ============================================================
// Preferencia: SHA-256 (WebCrypto). Fallback declarado: FNV-1a 64 bits,
// que NO es criptográfico: sirve para idempotencia y para detectar
// alteraciones accidentales, no como sello de seguridad. La integridad real
// la aporta el almacén append-only (RLS sin UPDATE/DELETE + trigger).
// ============================================================
export function fnv1a64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const b of bytes) {
    hash = (hash ^ BigInt(b)) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

export async function hashDecision(payload: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(payload));
      const hex = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      return `sha256:${hex}`;
    }
  } catch {
    // Entorno sin WebCrypto (jsdom parcial, runtime antiguo) → fallback.
  }
  return `fnv1a64:${fnv1a64(payload)}`;
}

// ============================================================
// CONSTRUCCIÓN DEL REGISTRO
// ============================================================

/** Convierte las declaraciones de input en entradas de procedencia completas. */
export function buildProvenance(
  declarations: Record<string, ManualInputDeclaration> | undefined,
): Record<string, ProvenanceEntry> {
  const out: Record<string, ProvenanceEntry> = {};
  if (!declarations) return out;
  for (const name of Object.keys(declarations).sort()) {
    const d = declarations[name];
    if (!d || d.value === undefined) continue; // no declarado ≠ declarado vacío
    const asOfMs = typeof d.asOfMs === "number" && Number.isFinite(d.asOfMs) ? d.asOfMs : null;
    out[name] = {
      value: typeof d.value === "number" ? (Number.isFinite(d.value) ? d.value : null) : d.value,
      as_of_ms: asOfMs,
      as_of: asOfMs === null ? null : new Date(asOfMs).toISOString(),
      source: d.source ?? "manual",
    };
  }
  return out;
}

/** Registro SIN hash (prev_hash/record_hash los pone chainDecisionRecord). */
export function buildDecisionRecord(input: DecisionRecordInput): Omit<DecisionRecord, "record_hash"> {
  const { engineResult, macro, marketData, allocationsBefore } = input;
  const capturedAt = input.capturedAt ?? Date.now();
  const meta = engineResult.meta;

  const manual = buildProvenance(input.manualInputs);

  const inputs: Record<string, unknown> = {
    macro: {
      vix: round(macro.vix, 4),
      credit_spread: round(macro.creditSpread, 4),
      yield_spread: round(macro.yieldSpread, 4),
      m2_growth: round(macro.m2Growth, 4),
    },
    market: marketData
      ? {
          prices: marketData.prices ?? null,
          vix: round(marketData.vix, 4),
          sp500_rsi: round(marketData.sp500Rsi, 4),
          btc_rsi: round(marketData.btcRsi, 4),
          m2_growth: round(marketData.m2Growth, 4),
          dxy: round(marketData.dxy, 4),
          // NOTA: la variable se llama wtiOil pero contiene BRENT (ticker BZ=F).
          // Deuda técnica declarada en AGENTS.md; el campo del registro usa el
          // nombre honesto para no perpetuar el error en el archivo de auditoría.
          brent_oil: round(marketData.wtiOil, 4),
        }
      : null,
    manual,
    portfolio: input.portfolio
      ? {
          drawdown: round(input.portfolio.drawdown, 6),
          realized_vol: round(input.portfolio.realizedVol, 6),
          available_cash: round(input.portfolio.availableCash, 2),
          total_portfolio_value: round(input.portfolio.totalPortfolioValue, 2),
        }
      : null,
  };

  return {
    captured_at: new Date(capturedAt).toISOString(),
    engine_version: engineResult.engineVersion,
    config_version: input.configVersion ?? "unversioned",
    path: input.path ?? (meta.coreMode === true ? "core" : "legacy"),
    trigger_reason: input.triggerReason ?? "manual",
    regime: engineResult.regime,
    regime_penalty: round(engineResult.masterRegime?.regimePenalty, 6) ?? 0,
    inputs,
    data_quality: {
      stale: [...(input.dataQuality?.stale ?? [])].sort(),
      blocked: [...(input.dataQuality?.blocked ?? [])].sort(),
    },
    risk_chain: {
      total_invested_alpha: round(meta.totalInvestedAlpha, 6),
      total_invested_after_gate: round(meta.totalInvestedAfterGate, 6),
      total_invested_base: round(meta.totalInvestedBase, 6),
      total_invested: round(engineResult.totalInvested, 6),
      vol_target_multiplier: round(engineResult.volTargetMultiplier, 6),
      tail_risk_overlay: round(engineResult.tailRiskOverlay, 6),
      tail_risk_active: engineResult.tailRiskActive === true,
      tail_risk_reason: engineResult.tailRiskReason ?? "",
      erp_cap_factor: round(meta.erpCapFactor, 6),
      correlation_penalty: round(engineResult.correlationPenalty, 6),
      kill_switch_level: engineResult.killSwitchLevel,
      kill_switch_name: engineResult.killSwitchName,
      core_trend_gate_active: meta.coreTrendGateActive === true,
      core_trend_gate_multiplier: round(meta.coreTrendGateMultiplier, 6),
    },
    breadth: {
      policy: meta.breadthPolicy,
      priority: meta.riskOverlayPriority,
      legacy_active: meta.absoluteTrendGateActive === true,
      legacy_multiplier: round(meta.absoluteTrendGateMultiplier, 6),
      legacy_negative_pct: round(meta.absoluteTrendGateNegativePct, 6),
      effective_multiplier: round(meta.breadthEffectiveMultiplier, 6),
      effective_source: meta.breadthEffectiveSource,
      institutional_shadow: meta.institutionalBreadthShadow ?? null,
      // La sombra CORE se conserva dentro del payload ya encadenado. El
      // snapshot de localStorage solo guarda divergencia agregada y no basta
      // para reconstruir la asignación candidata en cada observación.
      core_shadow: meta.coreShadow
        ? {
            engine_version: meta.coreShadow.engineVersion,
            regime: meta.coreShadow.regime,
            total_invested: round(meta.coreShadow.totalInvested, 6),
            allocations: meta.coreShadow.allocations.map(a => ({
              name: a.name,
              ticker: a.ticker ?? null,
              final_allocation: round(a.finalAllocation, 6),
            })),
          }
        : null,
      regime_breadth_divergence: meta.regimeBreadthDivergence === true,
    },
    allocations_before:
      allocationsBefore?.map(a => ({
        ticker: a.ticker,
        name: a.name,
        shares: safeNumber(a.shares),
        current_weight: round(a.currentWeight, 6),
        price: round(a.price, 4),
      })) ?? null,
    allocations_after: engineResult.allocations.map(a => ({
      name: a.name,
      final_allocation: round(a.finalAllocation, 6),
      blended_allocation: round(a.blendedAllocation, 6),
      kelly_fraction: round(a.kellyFraction, 6),
      effective_cap: round(a.effectiveCap, 6),
      is_capped: a.isCapped === true,
      expected_return: round(a.expectedReturn, 6),
      provenance: a.provenance ?? null,
    })),
    prev_hash: null,
  };
}

/**
 * Sella el registro: fija prev_hash y calcula record_hash sobre el contenido
 * canónico EXCLUYENDO record_hash (si no, el hash dependería de sí mismo).
 */
export async function chainDecisionRecord(
  record: Omit<DecisionRecord, "record_hash">,
  prevHash: string | null,
): Promise<DecisionRecord> {
  const withPrev: Omit<DecisionRecord, "record_hash"> = { ...record, prev_hash: prevHash };
  const hash = await hashDecision(canonicalize(withPrev));
  return { ...withPrev, record_hash: hash };
}

/**
 * Verifica un registro completo (hash propio + enlace con el anterior).
 * Devuelve el motivo del fallo para que el auditor sepa QUÉ se rompió.
 */
export async function verifyDecisionRecord(
  record: DecisionRecord,
  expectedPrevHash: string | null,
): Promise<{ ok: boolean; reason: string | null; computed: string }> {
  const { record_hash, ...rest } = record;
  const computed = await hashDecision(canonicalize(rest));
  if (record_hash !== computed) {
    return { ok: false, reason: "record_hash no coincide con el contenido", computed };
  }
  if ((record.prev_hash ?? null) !== (expectedPrevHash ?? null)) {
    return { ok: false, reason: "prev_hash no enlaza con el registro anterior", computed };
  }
  return { ok: true, reason: null, computed };
}
