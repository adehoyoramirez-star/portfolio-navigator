-- ============================================================
-- Migration: Tactical state persistence (2026-05-31)
-- Tabla para almacenar el estado del motor táctico en la nube
-- para que las posiciones no se pierdan al limpiar localStorage.
-- ============================================================

CREATE TABLE IF NOT EXISTS tactical_engine_state (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

ALTER TABLE tactical_engine_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read tactical state"
  ON tactical_engine_state FOR SELECT USING (true);

CREATE POLICY "Anyone can upsert tactical state"
  ON tactical_engine_state FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can update tactical state"
  ON tactical_engine_state FOR UPDATE USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_tactical_state_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tactical_state_updated_at ON tactical_engine_state;
CREATE TRIGGER trg_tactical_state_updated_at
  BEFORE UPDATE ON tactical_engine_state
  FOR EACH ROW
  EXECUTE FUNCTION update_tactical_state_timestamp();

CREATE INDEX IF NOT EXISTS idx_tactical_state_id ON tactical_engine_state (id);
