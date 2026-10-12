// @ts-ignore — Deno types
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

/**
 * SUPABASE EDGE FUNCTION: decision-log
 * =====================================================================
 * FUENTE DE VERDAD del registro de decisiones del motor Olympus.
 *
 * La tabla `decision_log` es APPEND-ONLY: RLS sin política de UPDATE/DELETE
 * más un trigger que lanza excepción. Esta función es la ÚNICA puerta de
 * escritura: valida el contrato, aplica rate limit y inserta.
 *
 * Qué guarda cada fila (y por qué):
 *   · inputs ............ macro + mercado + inputs MANUALES con su procedencia
 *                         ({ value, as_of, as_of_ms, source }). Los datos
 *                         manuales son correctos: se estampan, no se juzgan.
 *   · data_quality ...... campos degradados por la política (stale / blocked)
 *   · risk_chain ........ exposición de cada capa (kill switch, vol target...)
 *   · prev_hash + record_hash ... cadena de custodia del histórico.
 *
 * Contrato de petición (POST, JSON plano con NOMBRES DE COLUMNA):
 *   captured_at        string   ISO 8601
 *   engine_version     string
 *   config_version     string
 *   path               string   "core" | "legacy"
 *   trigger_reason     string
 *   regime             string
 *   regime_penalty     number
 *   inputs             object
 *   data_quality       object   { stale: string[], blocked: string[] }
 *   risk_chain         object
 *   breadth            object
 *   allocations_before array | null
 *   allocations_after  array
 *   prev_hash          string | null
 *   record_hash        string   (UNIQUE → reintentos idempotentes)
 *
 * Contrato de respuesta (SIEMPRE JSON con `errors: string[]`):
 *   ok        boolean
 *   id        number | null   id de la fila insertada
 *   duplicate boolean         true si record_hash ya existía (conflicto 409)
 *   errors    string[]
 *
 * Códigos: 200 OK · 400 contrato inválido (incluye las columnas NOT NULL que
 *          falten: regime, regime_penalty) · 405 método · 429 rate limit ·
 *          500 configuración de servidor · 502 error del almacén.
 *
 * SEGURIDAD: nunca se registra ni se devuelve la service role key; los
 * mensajes de error son genéricos (sin volcar el cuerpo de la respuesta SQL).
 * =====================================================================
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

// ─── Rate limit (antes de cualquier escritura) ────────────────────────────────
// NOTA: límite EN MEMORIA por instancia (cada isolate tiene su propio Map).
// Es best-effort: evita que un bucle accidental del cliente inunde la tabla.
// No sustituye a un límite distribuido; se declara como tal.
const RATE_LIMIT_PER_MINUTE = 120;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function rateLimitExceeded(key: string, now: number): boolean {
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MINUTE;
}

// ─── Respuesta JSON (errors siempre presente) ─────────────────────────────────
function jsonResponse(
  body: { ok: boolean; id: number | null; duplicate: boolean; errors: string[] },
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ─── Validación del contrato ──────────────────────────────────────────────────
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateRecord(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    errors.push('body debe ser un objeto JSON con los nombres de columna');
    return errors;
  }
  if (typeof raw.record_hash !== 'string' || raw.record_hash.length === 0) {
    errors.push('record_hash: string no vacío requerido');
  }
  if (typeof raw.captured_at !== 'string' || raw.captured_at.length === 0) {
    errors.push('captured_at: string ISO 8601 requerido');
  }
  if (typeof raw.engine_version !== 'string' || raw.engine_version.length === 0) {
    errors.push('engine_version: string no vacío requerido');
  }
  if (raw.path !== 'core' && raw.path !== 'legacy') {
    errors.push('path: debe ser "core" o "legacy"');
  }
  if (!Array.isArray(raw.allocations_after)) {
    errors.push('allocations_after: array requerido');
  }
  if (raw.config_version !== undefined && typeof raw.config_version !== 'string') {
    errors.push('config_version: string si se envía');
  }
  if (raw.data_quality !== undefined && !isPlainObject(raw.data_quality)) {
    errors.push('data_quality: objeto si se envía');
  }
  if (raw.inputs !== undefined && !isPlainObject(raw.inputs)) {
    errors.push('inputs: objeto si se envía');
  }
  if (raw.prev_hash !== undefined && raw.prev_hash !== null && typeof raw.prev_hash !== 'string') {
    errors.push('prev_hash: string o null si se envía');
  }
  // `regime` y `regime_penalty` son NOT NULL en la tabla. Se validan AQUÍ para
  // que un registro incompleto devuelva un 400 que diga QUÉ falta, en vez del
  // 502 opaco ("almacén rechazó el registro (HTTP 400)") que producía el
  // incumplimiento de la restricción en PostgREST. El camino de producción
  // siempre las emite: buildDecisionRecord fija
  // `regime: engineResult.regime` y `regime_penalty: round(...) ?? 0`.
  if (typeof raw.regime !== 'string' || raw.regime.length === 0) {
    errors.push('regime: string no vacío requerido');
  }
  if (typeof raw.regime_penalty !== 'number' || !Number.isFinite(raw.regime_penalty)) {
    errors.push('regime_penalty: número finito requerido');
  }
  return errors;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
// @ts-ignore — Deno global
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(
      { ok: false, id: null, duplicate: false, errors: ['método no permitido: usa POST'] },
      405,
    );
  }

  // Rate limit ANTES de tocar el almacén.
  const clientKey = req.headers.get('x-forwarded-for') ?? 'unknown';
  if (rateLimitExceeded(clientKey, Date.now())) {
    return jsonResponse(
      {
        ok: false,
        id: null,
        duplicate: false,
        errors: [`rate limit excedido (${RATE_LIMIT_PER_MINUTE}/min)`],
      },
      429,
    );
  }

  // Parseo del cuerpo.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, id: null, duplicate: false, errors: ['JSON inválido'] },
      400,
    );
  }

  const validationErrors = validateRecord(raw);
  if (validationErrors.length > 0) {
    return jsonResponse({ ok: false, id: null, duplicate: false, errors: validationErrors }, 400);
  }

  const record = raw as Record<string, unknown>;

  // Configuración del servidor (secretos NUNCA se devuelven ni se loguean).
  // @ts-ignore — Deno global
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  // @ts-ignore — Deno global
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      {
        ok: false,
        id: null,
        duplicate: false,
        errors: ['configuración de servidor incompleta para el registro de decisiones'],
      },
      500,
    );
  }

  // Whitelist de columnas: el cliente no puede inventar campos.
  const payload = {
    captured_at: record.captured_at,
    engine_version: record.engine_version,
    config_version: typeof record.config_version === 'string' ? record.config_version : 'unversioned',
    path: record.path,
    trigger_reason: typeof record.trigger_reason === 'string' ? record.trigger_reason : 'manual',
    regime: typeof record.regime === 'string' ? record.regime : null,
    regime_penalty: typeof record.regime_penalty === 'number' ? record.regime_penalty : null,
    inputs: isPlainObject(record.inputs) ? record.inputs : {},
    data_quality: isPlainObject(record.data_quality) ? record.data_quality : {},
    risk_chain: isPlainObject(record.risk_chain) ? record.risk_chain : {},
    breadth: isPlainObject(record.breadth) ? record.breadth : {},
    allocations_before: record.allocations_before ?? null,
    allocations_after: record.allocations_after,
    prev_hash: typeof record.prev_hash === 'string' ? record.prev_hash : null,
    record_hash: record.record_hash,
  };

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/decision_log`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    // 409 = record_hash ya existe → el reintento del cliente es idempotente.
    if (res.status === 409) {
      return jsonResponse({ ok: true, id: null, duplicate: true, errors: [] }, 200);
    }

    if (!res.ok) {
      return jsonResponse(
        {
          ok: false,
          id: null,
          duplicate: false,
          errors: [`almacén rechazó el registro (HTTP ${res.status})`],
        },
        502,
      );
    }

    let insertedId: number | null = null;
    try {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0]?.id === 'number') {
        insertedId = rows[0].id;
      }
    } catch {
      // Fila insertada correctamente; el id es informativo.
      insertedId = null;
    }

    return jsonResponse({ ok: true, id: insertedId, duplicate: false, errors: [] }, 200);
  } catch {
    // Error de red/serialización: mensaje genérico, sin exponer detalles internos.
    return jsonResponse(
      {
        ok: false,
        id: null,
        duplicate: false,
        errors: ['fallo de red al escribir el registro de decisiones'],
      },
      502,
    );
  }
});
