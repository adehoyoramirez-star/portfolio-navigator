-- ============================================================
-- Migration: Decision log append-only (2026-10-12)
-- Registro de decisiones del motor. FUENTE DE VERDAD de auditoría:
-- cada ejecución añade una fila con los inputs y su procedencia
-- (valor + asOf + fuente), la política de data quality aplicada, la
-- cadena de riesgo y los hashes encadenados.
--
-- INVARIANTE: APPEND-ONLY. No hay política de UPDATE ni de DELETE y un
-- trigger lanza excepción ante cualquier intento (incluso con service
-- role). Un dato erróneo NO se corrige reescribiendo: se emite una fila
-- compensatoria nueva que lo referencia. Así el histórico siempre es
-- reconstruible y no hay reescritura silenciosa.
-- ============================================================

CREATE TABLE IF NOT EXISTS decision_log (
  id                 BIGSERIAL PRIMARY KEY,
  captured_at        TIMESTAMPTZ NOT NULL,
  engine_version     TEXT        NOT NULL,
  config_version     TEXT        NOT NULL,
  path               TEXT        NOT NULL,
  trigger_reason     TEXT,
  regime             TEXT,
  regime_penalty     NUMERIC,
  inputs             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  data_quality       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  risk_chain         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  breadth            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  allocations_before JSONB,
  allocations_after  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  prev_hash          TEXT,
  record_hash        TEXT        NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT decision_log_path_valid CHECK (path IN ('core', 'legacy')),
  CONSTRAINT decision_log_hash_not_empty CHECK (length(record_hash) > 0)
);

COMMENT ON TABLE decision_log IS
  'Registro append-only de decisiones del motor Olympus (audit trail). '
  'Cada fila es inmutable: no hay UPDATE/DELETE (RLS + trigger). '
  'Incluye los inputs manuales con su procedencia para poder reconstruir '
  'el POR QUÉ de cada decisión.';

COMMENT ON COLUMN decision_log.record_hash IS
  'Hash del propio registro canónico ENCADENADO con prev_hash: '
  'record_hash = H(prev_hash + canonical(registro sin record_hash)). '
  'Alterar una fila rompe la verificación de todas las posteriores. '
  'Es UNIQUE para que el reintento del cliente sea idempotente.';

COMMENT ON COLUMN decision_log.prev_hash IS
  'record_hash de la fila INMEDIATAMENTE anterior (NULL en la primera). '
  'Materializa la cadena de custodia del histórico de decisiones.';

COMMENT ON COLUMN decision_log.inputs IS
  'Inputs de la decisión: macro, snapshot de mercado y bloque "manual" con '
  '{ value, as_of, as_of_ms, source } por campo. Los datos manuales son '
  'correctos: aquí se ESTAMPAN con fecha y fuente, no se juzgan.';

COMMENT ON COLUMN decision_log.data_quality IS
  'Política de data quality aplicada en la frontera: { stale: [...], '
  'blocked: [...] }. Deja constancia de qué campos se degradaron a '
  'undefined antes de llegar al detector.';

COMMENT ON COLUMN decision_log.path IS
  'Camino de producción que produjo la decisión: core (OLYMPUS_CORE v1.0) '
  'o legacy (stack v5.3). Permite atribuir el track record a un motor.';

-- ── RLS: lectura + inserción; NUNCA update ni delete ─────────────────
ALTER TABLE decision_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "decision_log: read history" ON decision_log;
CREATE POLICY "decision_log: read history"
  ON decision_log FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "decision_log: append only" ON decision_log;
CREATE POLICY "decision_log: append only"
  ON decision_log FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Sin política de UPDATE ni DELETE → cualquier intento queda denegado.
-- Refuerzo explícito a nivel de privilegios (idempotente):
REVOKE UPDATE, DELETE, TRUNCATE ON decision_log FROM anon, authenticated;

-- ── Trigger append-only: defensa en profundidad ──────────────────────
-- La ausencia de política ya bloquea a anon/authenticated, pero un cliente
-- con service role podría intentar reescribir. Este trigger lo impide a
-- nivel de tabla y explica en el error cómo proceder correctamente.
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

-- ── Índices de consulta de auditoría ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_decision_log_created_at
  ON decision_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_log_captured_at
  ON decision_log (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_decision_log_engine_version
  ON decision_log (engine_version, captured_at DESC);
