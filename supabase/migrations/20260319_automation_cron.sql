-- =====================================================================
-- OLYMPUS CAPITAL — Automatización completa con pg_cron
-- Ejecutar en Supabase SQL Editor (una sola vez)
-- =====================================================================

-- 1. Activar extensiones necesarias
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;  -- para llamadas HTTP desde SQL
GRANT USAGE ON SCHEMA cron TO postgres;

-- 2. Tabla de snapshots del portfolio (para cron jobs y trazabilidad)
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT now(),
  regime        TEXT,
  vix           NUMERIC,
  btc_rsi       NUMERIC,
  btc_price     NUMERIC,
  credit_spread NUMERIC,
  fear_greed    INTEGER,
  fear_greed_label TEXT,
  total_value   NUMERIC,
  portfolio_vol NUMERIC,
  drawdown      NUMERIC,
  allocations   JSONB,
  ai_gemini_narrative TEXT,
  ai_quant_advice     TEXT,
  ai_black_swan       BOOLEAN DEFAULT false,
  engine_version      TEXT DEFAULT 'v3.5.1'
);

-- Índice para consultas rápidas por fecha
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON portfolio_snapshots(created_at DESC);

-- RLS: acceso solo con anon key (ajustar si usas auth)
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_write" ON portfolio_snapshots
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- 3. Configurar variables para los cron jobs
-- ⚠️ Sustituir con tus valores reales de Supabase
ALTER DATABASE postgres SET app.supabase_url = 'https://hhzbjekmhpimalqnnpro.supabase.co';
ALTER DATABASE postgres SET app.supabase_anon_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoemJqZWttaHBpbWFscW5ucHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE0NzcwOTIsImV4cCI6MjA4NzA1MzA5Mn0.bH2AXK0HNJKwWT9TxdvF7P4Jl5QYXKdFbdRp54wk42g';

-- 4. CRON JOB: Señales cripto cada 30 minutos (Fear&Greed + BTC Dominance)
SELECT cron.schedule(
  'refresh-crypto-signals',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/crypto-signals',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body   := '{}'::jsonb
  );
  $$
);

-- 5. CRON JOB: Datos on-chain cada 4 horas
SELECT cron.schedule(
  'refresh-onchain',
  '0 */4 * * *',
  $$
  SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/glassnode-onchain',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body   := '{}'::jsonb
  );
  $$
);

-- 6. CRON JOB: Resumen semanal Telegram (domingo 18:00 CET = 17:00 UTC)
SELECT cron.schedule(
  'weekly-telegram-summary',
  '0 17 * * 0',
  $$
  SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/telegram-alerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body   := json_build_object(
      'type', 'custom',
      'message', E'📊 *Resumen Semanal — Olympus Capital*\n_Motor OlympusV3 v3.5.1 activo. Revisa el dashboard para las allocations de esta semana._\n\n✅ Datos: Yahoo Finance + FRED + CoinGecko\n🤖 AI: Gemini Flash (3 roles)\n📡 On-chain: blockchain.info proxy'
    )::jsonb
  );
  $$
);

-- 7. Ver cron jobs activos
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;

-- 8. Ver logs de ejecución (últimas 20)
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- =====================================================================
-- COMANDOS ÚTILES
-- =====================================================================

-- Pausar un job:
-- SELECT cron.unschedule('refresh-crypto-signals');

-- Ver todos los jobs:
-- SELECT * FROM cron.job;

-- Ver últimas ejecuciones:
-- SELECT jobname, status, start_time, end_time 
-- FROM cron.job_run_details 
-- ORDER BY start_time DESC LIMIT 10;

-- Test manual de una función:
-- SELECT net.http_post(
--   url := 'https://hhzbjekmhpimalqnnpro.supabase.co/functions/v1/crypto-signals',
--   headers := '{"Authorization":"Bearer eyJ...","Content-Type":"application/json"}'::jsonb,
--   body := '{}'::jsonb
-- );
