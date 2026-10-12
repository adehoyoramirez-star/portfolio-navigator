-- ============================================================
-- Migration: decision_log — CIERRE DE ACCESO ANON (13-oct-2026)
--
-- MOTIVO (verificado en vivo el 12-oct-2026, no supuesto):
--   La migración 20261012 dejó dos políticas para los roles anon y
--   authenticated:
--       SELECT USING (true)        -> cualquiera con el anon key leía las
--                                     1.193 decisiones y sus pesos. Comprobado.
--       INSERT WITH CHECK (true)   -> cualquiera podía inundar el log.
--   Un registro de auditoría inmutable (MiFID II Art. 16(6)) que el mundo
--   puede leer y engordar es un instrumento inservible: la inmutabilidad sin
--   confidencialidad ni control de escritura no es custodia.
--
-- POR QUÉ ES SEGURO CERRARLO (verificado en el código, no asumido):
--   1. El frontend NUNCA lee la tabla: loadDecisionHistory() lee solo de
--      localStorage (src/lib/decisionLog.ts). Ningún componente consulta
--      Supabase para el histórico.
--   2. El frontend NUNCA escribe la tabla directamente: la única puerta de
--      escritura es la Edge Function `decision-log`, que usa la SERVICE ROLE
--      KEY en el servidor y por tanto NO pasa por RLS ni necesita grants
--      para anon/authenticated.
--   3. La app no tiene autenticación (0 usos de supabase.auth en src/), así
--      que activar la verificación JWT de la función rompería la escritura
--      sin aportar nada. La defensa correcta aquí es de base de datos.
--
-- QUÉ HACE:
--   · Elimina las dos políticas de anon/authenticated Y las dos heredadas
--     del esquema original (ver nota en el DROP).
--   · Revoca TODO privilegio de tabla a anon y authenticated (defensa en
--     profundidad: aunque se recreara una política, sin GRANT no hay acceso).
--   · Mantiene RLS habilitado.
--   · NO toca el trigger append-only ni los datos: cero filas modificadas.
--
-- LECTURA LEGÍTIMA: si algún día hace falta leer el log desde fuera, se hace
-- con la service role (servidor) o creando una política acotada para un rol
-- autenticado concreto. NUNCA con el anon key.
--
-- IDEMPOTENTE: DROP ... IF EXISTS + REVOKE idempotente. Reejecutable.
--
-- NOTA DE FORMATO: esta migración no usa bloques con dollar-quoting para que
-- pueda aplicarse sentencia a sentencia por cualquier cliente simple.
-- ============================================================

ALTER TABLE decision_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "decision_log: read history" ON decision_log;
DROP POLICY IF EXISTS "decision_log: append only" ON decision_log;

-- Las DOS políticas heredadas del esquema original (marzo 2026) se eliminan
-- también. Eran inofensivas en apariencia, pero su regla de lectura era
-- `user_id = auth.uid() OR user_id IS NULL`, y TODAS las filas nuevas tienen
-- user_id NULL (el contrato nuevo no lo escribe). Es decir: un futuro GRANT
-- habría reabierto la lectura completa del log por esa vía. Se retiran en vez
-- de dejarlas como mina latente.
DROP POLICY IF EXISTS "Users can read own decisions" ON decision_log;
DROP POLICY IF EXISTS "Users can insert own decisions" ON decision_log;

REVOKE ALL ON decision_log FROM anon;
REVOKE ALL ON decision_log FROM authenticated;

COMMENT ON TABLE decision_log IS
  'Registro append-only de decisiones del motor Olympus (audit trail). CONTINUIDAD: las filas hasta 2026-06-19 son PRE-CADENA (record_hash IS NULL), sin procedencia de inputs ni hash. La cadena de custodia arranca en el primer registro con record_hash. Inmutable desde 20261012 (trigger + RLS sin UPDATE ni DELETE). ACCESO: NINGUN privilegio para anon ni authenticated desde 20261013. La unica puerta de escritura es la Edge Function decision-log con la service role key. Una fila erronea NO se reescribe: se emite una compensatoria nueva.'
