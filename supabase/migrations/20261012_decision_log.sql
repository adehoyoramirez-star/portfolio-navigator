-- ============================================================
-- Migration: decision_log — registro append-only CON PROCEDENCIA (12-oct-2026)
--
-- CONTEXTO REAL (verificado contra el remoto, no supuesto):
--   La tabla `decision_log` YA EXISTE con 1.193 filas escritas entre
--   2026-03-13 (engine v3.5.1) y 2026-06-19 (v5.2.0), con un esquema distinto
--   (id UUID, created_at, factor_scores, market_data_snapshot, user_id...).
--   El escritor se retiró en el commit 4837ea8 ("ELIMINAR SUPABASE") — con
--   toda probabilidad para no exponer el anon key en el frontend — y la tabla
--   quedó huérfana.
--
--   POR ESO ESTA MIGRACIÓN ES ADITIVA (ALTER), NO un CREATE TABLE:
--   un `CREATE TABLE IF NOT EXISTS` habría hecho NADA en silencio sobre una
--   tabla existente, y el contrato nuevo (captured_at, inputs, record_hash…)
--   no habría funcionado nunca. La escritura se restaura AHORA sin claves en
--   el frontend: sólo la Edge Function `decision-log` escribe, con su service
--   role key en el servidor.
--
-- ESTRATEGIA: una sola tabla, un solo registro de verdad.
--   · Se AÑADEN las columnas que faltan para el contrato canónico.
--   · Se RELLENAN las filas históricas con valores derivados y honestos:
--       captured_at    ← created_at   (es la misma hora de captura)
--       path           ← 'legacy'     (las produjo el stack v5.3/v3.5)
--       config_version ← 'unversioned'(no existe config versionada en la época)
--   · `record_hash` queda NULL en el segmento histórico = PRE-CADENA. La
--     cadena de custodia empieza en el primer registro nuevo (prev_hash NULL)
--     y NADIE debe afirmar que cubre marzo-junio: la marca es `record_hash IS
--     NULL` y es explícita y consultable.
--   · El trigger append-only se crea AL FINAL, después del backfill (si no, el
--     propio backfill fallaría) y desde entonces la tabla es inmutable para
--     todos, incluido service role.
--
-- IDEMPOTENTE: reejecutable sin efectos secundarios (ADD COLUMN IF NOT EXISTS,
-- índices IF NOT EXISTS y constraints guardadas por catálogo).
-- ============================================================

-- ── 1. Columnas que faltan para el contrato canónico ─────────────────
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS captured_at    TIMESTAMPTZ;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS config_version TEXT;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS path           TEXT;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS inputs         JSONB   NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS data_quality   JSONB   NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS risk_chain     JSONB   NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS breadth        JSONB   NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS prev_hash      TEXT;
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS record_hash    TEXT;

-- `allocations_before`, `allocations_after`, `trigger_reason`, `regime`,
-- `regime_penalty`, `engine_version` y `created_at` YA existen y se reutilizan
-- tal cual (no se renombran: renombrar rompería al lector antiguo).

-- ── 2. Backfill del segmento histórico (ANTES del trigger) ───────────
UPDATE decision_log SET captured_at    = created_at     WHERE captured_at    IS NULL;
UPDATE decision_log SET path           = 'legacy'       WHERE path           IS NULL;
UPDATE decision_log SET config_version = 'unversioned'  WHERE config_version IS NULL;

-- ── 3. NOT NULL en lo que el contrato exige ──────────────────────────
ALTER TABLE decision_log ALTER COLUMN captured_at    SET NOT NULL;
ALTER TABLE decision_log ALTER COLUMN config_version SET NOT NULL;
ALTER TABLE decision_log ALTER COLUMN path           SET NOT NULL;
-- `path` y `config_version` se dejan SIN default a propósito: que un registro
-- futuro que no los traiga falle en voz alta en vez de heredar un valor falso.

-- ── 4. Invariantes (guardadas por catálogo para ser idempotentes) ────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_log_path_valid'
  ) THEN
    ALTER TABLE decision_log
      ADD CONSTRAINT decision_log_path_valid CHECK (path IN ('core', 'legacy'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'decision_log_hash_not_empty'
  ) THEN
    ALTER TABLE decision_log
      ADD CONSTRAINT decision_log_hash_not_empty
      CHECK (record_hash IS NULL OR length(record_hash) > 0);
  END IF;
END $$;

-- ── 5. Unicidad del hash: ÍNDICE PARCIAL ─────────────────────────────
-- Parcial (WHERE record_hash IS NOT NULL) por dos razones:
--   · las 1.193 filas históricas quedan con hash NULL y no colisionan entre sí;
--   · el UNIQUE hace idempotente el reintento del cliente (409 → "ya existía").
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_log_record_hash
  ON decision_log (record_hash) WHERE record_hash IS NOT NULL;

-- ── 6. Índices de consulta de auditoría ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_decision_log_created_at
  ON decision_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_captured_at
  ON decision_log (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_log_engine_version
  ON decision_log (engine_version, captured_at DESC);

-- ── 7. Comentarios: el corte y el segmento pre-cadena, explícitos ────
COMMENT ON TABLE decision_log IS
  'Registro append-only de decisiones del motor Olympus (audit trail). '
  'CONTINUIDAD: filas hasta 2026-06-19 son PRE-CADENA (record_hash IS NULL) — '
  'sin procedencia de inputs ni hash; la cadena de custodia arranca en el '
  'primer registro con record_hash. Inmutable a partir de la migración '
  '20261012 (trigger + RLS sin UPDATE/DELETE). Una fila errónea NO se '
  'reescribe: se emite una compensatoria nueva.';

COMMENT ON COLUMN decision_log.record_hash IS
  'Hash del propio registro canónico ENCADENADO con prev_hash: '
  'record_hash = H(prev_hash + canonical(registro sin record_hash)). '
  'NULL = fila del segmento histórico (pre-cadena), sin verificación posible. '
  'Alterar una fila encadenada rompe la verificación de todas las posteriores.';

COMMENT ON COLUMN decision_log.prev_hash IS
  'record_hash de la fila INMEDIATAMENTE anterior (NULL en la primera de la '
  'cadena). Materializa la cadena de custodia del histórico de decisiones.';

COMMENT ON COLUMN decision_log.path IS
  'Camino de producción que produjo la decisión: core (OLYMPUS_CORE v1.0) o '
  'legacy (stack v5.3). Permite atribuir el track record a un motor. '
  'En el segmento histórico vale "legacy" por derivación, no por medición.';

COMMENT ON COLUMN decision_log.config_version IS
  'ENGINE_CONFIG_VERSION vigente al decidir (change-control §18). En el '
  'segmento histórico vale "unversioned" porque esa versión no se registraba.';

COMMENT ON COLUMN decision_log.inputs IS
  'Inputs de la decisión: macro, snapshot de mercado y bloque "manual" con '
  '{ value, as_of, as_of_ms, source } por campo. Los datos manuales son '
  'correctos: aquí se ESTAMPAN con fecha y fuente, no se juzgan.';

COMMENT ON COLUMN decision_log.data_quality IS
  'Política de data quality aplicada en la frontera: { stale: [...], '
  'blocked: [...] }. Deja constancia de qué campos se degradaron a undefined '
  'antes de llegar al detector (p.ej. un MVRV Z caducado).';

-- ── 8. RLS: lectura + inserción; NUNCA update ni delete ──────────────
ALTER TABLE decision_log ENABLE ROW LEVEL SECURITY;

-- Las políticas se nombran con prefijo propio y se recrean de forma
-- idempotente. No se tocan las políticas ajenas que pudieran existir: la
-- garantía de inmutabilidad la da el TRIGGER (abajo), no la ausencia de
-- política, y así se cumple aunque alguien añada una política de UPDATE.
DROP POLICY IF EXISTS "decision_log: read history" ON decision_log;
CREATE POLICY "decision_log: read history"
  ON decision_log FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "decision_log: append only" ON decision_log;
CREATE POLICY "decision_log: append only"
  ON decision_log FOR INSERT TO anon, authenticated WITH CHECK (true);

REVOKE UPDATE, DELETE, TRUNCATE ON decision_log FROM anon, authenticated;

-- ── 9. Trigger append-only (DESPUÉS del backfill) ────────────────────
CREATE OR REPLACE FUNCTION decision_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'decision_log es APPEND-ONLY: % no está permitido. Corrige emitiendo una fila compensatoria nueva.',
    TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decision_log_append_only ON decision_log;
CREATE TRIGGER trg_decision_log_append_only
  BEFORE UPDATE OR DELETE ON decision_log
  FOR EACH ROW
  EXECUTE FUNCTION decision_log_append_only();
