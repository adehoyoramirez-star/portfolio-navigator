# 🚀 OLYMPUS CAPITAL — GUÍA ELITE
## Automatización Completa + Stack 100% Gratuito

---

## RESPUESTA DIRECTA: ¿Es todo gratis?

| Componente | Coste real | Límite free |
|------------|-----------|-------------|
| Yahoo Finance | ✅ GRATIS | Sin límite práctico |
| FRED (Federal Reserve) | ✅ GRATIS | Sin límite |
| Alternative.me (Fear&Greed) | ✅ GRATIS | Sin límite |
| CoinGecko (BTC dominance) | ✅ GRATIS | 50 req/min |
| blockchain.info (on-chain proxy) | ✅ GRATIS | Sin límite |
| Supabase (DB + Edge Functions) | ✅ GRATIS | 500k invocaciones/mes |
| Vercel / Netlify (hosting) | ✅ GRATIS | Proyectos ilimitados |
| Glassnode | ⚠️ PROXY GRATIS | Métricas exactas: $29/mes |
| **TOTAL** | **€0/mes** | - |

---

## PARTE 1: AUTOMATIZACIÓN COMPLETA (100% GRATIS)

### Sistema de automatización con Supabase pg_cron

Supabase incluye `pg_cron` en el tier gratuito. Permite ejecutar SQL que llama Edge Functions de forma programada.

#### Activar pg_cron en Supabase

```sql
-- Ejecutar en Supabase SQL Editor (una sola vez)
CREATE EXTENSION IF NOT EXISTS pg_cron;
GRANT USAGE ON SCHEMA cron TO postgres;
```

#### CRON JOB 1: Actualizar datos de mercado cada hora
```sql
-- Se ejecuta cada hora en días de mercado (lun-vie)
SELECT cron.schedule(
  'refresh-market-data',
  '0 * * * 1-5',  -- cada hora, solo lunes a viernes
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/yahoo-finance',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

#### CRON JOB 2: Señales cripto cada 30 minutos
```sql
SELECT cron.schedule(
  'refresh-crypto-signals',
  '*/30 * * * *',  -- cada 30 minutos
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/crypto-signals',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

### Configurar las variables en Supabase para los cron jobs
```sql
-- Ejecutar una sola vez en SQL Editor
ALTER DATABASE postgres SET app.supabase_url = 'https://hhzbjekmhpimalqnnpro.supabase.co';
ALTER DATABASE postgres SET app.supabase_anon_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

---

## PARTE 2: STACK COMPLETO — RESUMEN VISUAL

```
┌─────────────────────────────────────────────────────────────┐
│  SUPABASE (backend gratuito)                                │
│  ┌──────────────────┐  ┌─────────────────────────────────┐  │
│  │  Edge Functions  │  │  pg_cron (automatización)       │  │
│  │  yahoo-finance   │  │  • cada hora: market data       │  │
│  │  crypto-signals  │  │  • cada 30min: crypto           │  │
│  │  glassnode-proxy │  └─────────────────────────────────┘  │
│  └──────────────────┘                                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  PostgreSQL: decision_log, portfolio_snapshots, CEWS   │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  DATOS EXTERNOS (todos gratuitos)                           │
│  Yahoo Finance → precios 5Y (BTC, ETFs, VIX, TNX)          │
│  FRED → M2, CAPE, Fed/ECB balance, credit spread           │
│  Alternative.me → Fear & Greed Index                        │
│  CoinGecko → BTC dominance + precio                         │
│  blockchain.info → on-chain proxy (MVRV, Puell)            │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  OUTPUTS                                                    │
│  🌐 Dashboard React → portfolio navigator                   │
│  📊 Decision Log → trazabilidad MiFID II                    │
└─────────────────────────────────────────────────────────────┘
```

---

## RESUMEN FINAL: STACK ELITE GRATUITO

| Herramienta | Para qué | Gratis |
|-------------|---------|--------|
| **Supabase** | Backend, DB, Edge Functions, cron | ✅ |
| **FRED** | Datos macro oficiales Fed/BCE | ✅ |
| **Yahoo Finance** | Precios reales 5 años | ✅ |
| **Vercel** | Hosting React | ✅ |
| **TOTAL** | Sistema hedge fund institucional | **€0/mes** |

---

*Olympus Capital — OlympusV3 Engine v5.2.2*
