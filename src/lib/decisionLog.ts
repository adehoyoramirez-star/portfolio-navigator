// ===============================================
// ARCHIVO: src/lib/decisionLog.ts
// FIX REG-01 (S2-2): Audit trail de decisiones del motor
// FIX-REG-AUDIT (Oct-2026): REGISTRO COMPLETO Y TRAZABLE.
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
//     manualInputs: { mvrvZScore: { value, asOfMs, source: "glassnode" }, ... },
//     dataQuality: { stale, blocked },
//   });
// ===============================================

import { ENGINE_VERSION } from "@/core/engine/olympusV3";
import { ENGINE_CONFIG_VERSION, STORAGE_KEYS } from "@/core/config/engineConfig";
import {
  buildDecisionRecord,
  chainDecisionRecord,
  verifyDecisionRecord,
  type DecisionRecord,
  type DecisionRecordInput,
} from "@/lib/decisionRecord";

// Mismo host que el resto de Edge Functions del proyecto (ver fredManualInputs).
const DECISION_LOG_FUNCTION_URL =
  "https://yrirandgftnuvdzatwgc.supabase.co/functions/v1/decision-log";

/** Clave canónica del registro (antes estaba duplicada a mano en este archivo). */
const CANONICAL_KEY = STORAGE_KEYS.DECISION_LOG;
/** Clave heredada que usaban versiones anteriores del registro. */
const LEGACY_KEY = "olympus_decision_log";

/**
 * Entrada del registro: SUPERCONJUNTO de la firma anterior. Los llamadores que
 * solo pasan { engineResult, macro, marketData, allocationsBefore,
 * triggerReason } siguen funcionando sin cambios; los nuevos campos
 * (manualInputs, dataQuality, path) son los que hacen el registro auditable.
 */
export type DecisionLogInput = DecisionRecordInput;

export type DecisionLogStatus = "pending" | "synced";

/** Fila local: registro canónico + estado de sincronización + campos heredados. */
export interface LocalDecisionRow {
  id: number;
  created_at: string;
  engine_version: string;
  regime: string;
  regime_penalty?: number;
  vix?: number;
  credit_spread?: number;
  yield_spread?: number;
  m2_growth?: number;
  allocations_after?: unknown;
  risk_chain?: unknown;
  breadth?: unknown;
  trigger_reason?: string;
  /** Registro canónico completo. Ausente en las filas del formato antiguo. */
  record?: DecisionRecord;
  record_hash: string;
  prev_hash: string | null;
  sync?: DecisionLogStatus;
}

/** Tope de filas locales: la cola pendiente NUNCA se recorta. */
const MAX_LOCAL_RECORDS = 500;

// ── Persistencia local robusta (nunca lanza) ──────────────────────────────
/** Lee el histórico local tolerando datos corruptos y la clave heredada. */
export function readLocalDecisionRows(): LocalDecisionRow[] {
  const out: LocalDecisionRow[] = [];
  const seen = new Set<string>();
  for (const key of [CANONICAL_KEY, LEGACY_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed as LocalDecisionRow[]) {
        if (!row || typeof row !== "object") continue;
        const id = String(row.record_hash ?? row.id ?? "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        out.push(row);
      }
    } catch {
      // Almacén corrupto: se ignora y se sigue con el otro.
    }
  }
  // El ORDEN DEL ARRAY es la fuente de verdad (append-only): newest-first. No
  // se reordena por id para que la cadena de hashes sea estable aunque dos
  // decisiones se capturen en el mismo milisegundo.
  return out;
}

function writeRows(rows: LocalDecisionRow[]): void {
  try {
    localStorage.setItem(CANONICAL_KEY, JSON.stringify(rows));
  } catch {
    console.warn("[DecisionLog] localStorage lleno — no se pudo conservar la cola local");
  }
}

/**
 * Recorta el histórico local PRESERVANDO el orden (newest-first) y sin
 * descartar NUNCA una fila pendiente: perder un registro sin enviar sería
 * perder trazabilidad, que es justo lo que este archivo existe para evitar.
 */
export function trimLocalRows(rows: LocalDecisionRow[], max = MAX_LOCAL_RECORDS): LocalDecisionRow[] {
  if (rows.length <= max) return rows;
  const key = (r: LocalDecisionRow) => String(r.record_hash ?? r.id);
  const keep = new Set<string>();
  for (const r of rows.filter(x => x.sync !== "synced")) keep.add(key(r));
  const target = Math.max(max, keep.size);
  for (const r of rows) {
    if (keep.size >= target) break;
    keep.add(key(r));
  }
  return rows.filter(r => keep.has(key(r)));
}

/** Hash del registro más reciente = cabeza de la cadena (null si no hay). */
export function getChainHead(): string | null {
  for (const row of readLocalDecisionRows()) {
    if (typeof row.record_hash === "string" && row.record_hash.length > 0) return row.record_hash;
  }
  return null;
}

// ── Sincronización con el almacén append-only ─────────────────────────────
/** Señal de timeout tolerante a entornos sin AbortSignal.timeout (jsdom). */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/**
 * Envía UN registro a la Edge Function. true = almacenado (el conflicto 409
 * por record_hash duplicado también es éxito: reintentar es idempotente).
 * Nunca lanza: un fallo de red se traduce en false y la fila queda pendiente.
 */
async function pushRecord(record: DecisionRecord): Promise<boolean> {
  try {
    const res = await fetch(DECISION_LOG_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: timeoutSignal(8000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; errors?: string[] };
    return json?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Reintenta la cola pendiente, de la fila MÁS ANTIGUA a la más reciente para
 * respetar el orden de la cadena. Se detiene al primer fallo (sin red).
 */
export async function flushPendingDecisions(): Promise<{ attempted: number; synced: number }> {
  const rows = readLocalDecisionRows();
  const pending = rows
    .filter((r): r is LocalDecisionRow & { record: DecisionRecord } => r.sync !== "synced" && r.record !== undefined)
    .reverse(); // oldest → newest
  const syncedHashes = new Set<string>();
  for (const row of pending) {
    if (await pushRecord(row.record)) syncedHashes.add(row.record_hash);
    else break; // sin red: no tiene sentido martillear el resto de la cola
  }
  if (syncedHashes.size > 0) {
    writeRows(trimLocalRows(rows.map(r =>
      syncedHashes.has(r.record_hash) ? { ...r, sync: "synced" as DecisionLogStatus } : r,
    )));
  }
  return { attempted: pending.length, synced: syncedHashes.size };
}

/**
 * Registra una decisión del motor. NUNCA lanza.
 *   1. Construye el registro canónico (inputs + procedencia + cadena de riesgo).
 *   2. Lo encadena por hash con el registro anterior.
 *   3. Lo persiste localmente (append-only; cola si no hay red).
 *   4. Lo envía al almacén append-only (tabla decision_log).
 */
export async function logEngineDecision(input: DecisionLogInput): Promise<DecisionRecord | null> {
  try {
    const prevHash = getChainHead();
    // FIX-REG-AUDIT: la versión de CONFIGURACIÓN también queda sellada. Sin ella
    // no se puede saber con qué configuración (change-control §18) se decidió.
    const record = await chainDecisionRecord(
      buildDecisionRecord({ ...input, configVersion: input.configVersion ?? ENGINE_CONFIG_VERSION }),
      prevHash,
    );

    const row: LocalDecisionRow = {
      id: Date.now(),
      created_at: record.captured_at,
      engine_version: record.engine_version,
      regime: record.regime,
      // Campos heredados: se conservan para no romper a lectores antiguos.
      regime_penalty: record.regime_penalty,
      vix: input.macro.vix,
      credit_spread: input.macro.creditSpread,
      yield_spread: input.macro.yieldSpread,
      m2_growth: input.macro.m2Growth,
      allocations_after: record.allocations_after,
      risk_chain: record.risk_chain,
      breadth: record.breadth,
      trigger_reason: record.trigger_reason,
      record,
      record_hash: record.record_hash ?? "",
      prev_hash: record.prev_hash,
      sync: "pending",
    };

    // Persistir ANTES de enviar: si la red falla, el registro ya existe.
    writeRows(trimLocalRows([row, ...readLocalDecisionRows()]));

    const { synced } = await flushPendingDecisions();

    console.info(
      `[DecisionLog] ✅ Decisión registrada — ${ENGINE_VERSION} · ${record.path} · ` +
        `Régimen: ${record.regime} · ${(record.record_hash ?? "").slice(0, 16)}… ` +
        `(${synced > 0 ? "almacén OK" : "pendiente de sincronizar"})`,
    );
    return record;
  } catch (err) {
    // Nunca propagar: el logging es secundario a la funcionalidad.
    console.warn("[DecisionLog] Error inesperado:", err);
    return null;
  }
}

// ── Consulta y verificación ───────────────────────────────────────────────
/** Registros canónicos completos, más recientes primero. */
export function loadDecisionRecords(limit: number = 50): DecisionRecord[] {
  return readLocalDecisionRows()
    .slice(0, limit)
    .map(r => r.record)
    .filter((r): r is DecisionRecord => r !== undefined);
}

/** Filas con su estado de sincronización (diagnóstico de la cola). */
export function loadLocalDecisionRows(limit: number = 50): LocalDecisionRow[] {
  return readLocalDecisionRows().slice(0, limit);
}

/** Registros aún NO confirmados por el almacén (pendientes de reintento). */
export function pendingDecisionRecords(): LocalDecisionRow[] {
  return readLocalDecisionRows().filter(r => r.sync !== "synced");
}

/**
 * Verifica la integridad del tramo RETENIDO de la cadena local: hash propio de
 * cada registro y enlace con el anterior. Devuelve el primer fallo con su
 * motivo, de modo que una manipulación o corrupción sea evidente.
 */
export async function verifyLocalChain(): Promise<{
  ok: boolean;
  checked: number;
  brokenAt: string | null;
  reason: string | null;
}> {
  const rows = readLocalDecisionRows()
    .filter((r): r is LocalDecisionRow & { record: DecisionRecord } => r.record !== undefined)
    .reverse(); // oldest → newest
  let checked = 0;
  for (let i = 0; i < rows.length; i++) {
    const expectedPrev = i === 0
      ? (rows[i].record.prev_hash ?? null)
      : (rows[i - 1].record.record_hash ?? null);
    const res = await verifyDecisionRecord(rows[i].record, expectedPrev);
    checked += 1;
    if (!res.ok) {
      return { ok: false, checked, brokenAt: rows[i].record_hash, reason: res.reason };
    }
  }
  return { ok: true, checked, brokenAt: null, reason: null };
}

/**
 * Recupera el historial de decisiones para los paneles (vista compacta).
 * Devuelve las últimas N decisiones ordenadas por fecha descendente.
 */
export async function loadDecisionHistory(limit: number = 50) {
  return loadLocalDecisionRows(limit).map(r => ({
    id: r.id,
    created_at: r.created_at,
    engine_version: r.engine_version,
    regime: r.regime,
    regime_penalty: r.regime_penalty,
    vix: r.vix,
    trigger_reason: r.trigger_reason,
    sync: r.sync ?? "synced",
  }));
}

/** Borra el registro local (solo tests y reinicio explícito del operador). */
export function clearDecisionLog(): void {
  try {
    localStorage.removeItem(CANONICAL_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}