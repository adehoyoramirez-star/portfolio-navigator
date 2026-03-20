# 🚀 OLYMPUS CAPITAL — GUÍA ELITE
## Google Antigravity + Automatización Completa + Stack 100% Gratuito

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
| **Gemini Flash** (AI analysis) | ✅ GRATIS | **1,500 peticiones/día** |
| Telegram Bot | ✅ GRATIS | Sin límite |
| Google Antigravity (IDE) | ✅ GRATIS | Preview pública gratuita |
| Glassnode | ⚠️ PROXY GRATIS | Métricas exactas: $29/mes |
| **TOTAL** | **€0/mes** | - |

**Con solo la GEMINI_API_KEY gratuita tienes el sistema 100% funcional.**

---

## PARTE 1: GOOGLE ANTIGRAVITY — Qué es y cómo usarlo para este proyecto

### Qué es Antigravity

Google Antigravity es una plataforma de desarrollo que combina un entorno de codificación con IA con una interfaz agent-first. Permite desplegar agentes que planifican, ejecutan y verifican tareas complejas de forma autónoma.

Fue anunciado en noviembre de 2025 junto con Gemini 3. Permite a los desarrolladores delegar tareas de codificación complejas a agentes de IA autónomos. Está disponible gratis para cuentas Gmail personales.

### Instalación (5 minutos)

```
1. Ir a: antigravity.google/download
2. Descargar para tu OS (Windows/Mac/Linux)
3. Instalar y abrir con tu cuenta Gmail personal
4. Seleccionar modelo: Gemini 3 Flash (gratuito)
5. Modo recomendado: "Agent-Assisted" (tú supervisas)
```

### Las 2 vistas de Antigravity

**Editor View** (familiar, como VS Code)
- Abre la carpeta del proyecto Olympus Capital
- El agente sugiere cambios mientras tú codificas
- Usa para: editar `InstitutionalDashboard.tsx`, ajustar parámetros

**Manager View** (la más poderosa — misión control)
- Despacha múltiples agentes en paralelo
- Cada agente trabaja en una tarea independiente
- Usa para: las 5 automatizaciones descritas abajo

---

## PARTE 2: FLUJO DE TRABAJO ELITE CON ANTIGRAVITY

### Cómo trabajar con este proyecto en Antigravity

**Paso 1:** Abrir Antigravity → Editor → Open Folder → seleccionar `portfolio-navigator-main`

**Paso 2:** En Manager View, crear estos Workflows personalizados:

```
Workflow /audit-olympus:
"Analiza el código TypeScript en src/core/ y src/dashboard/.
Busca: funciones sin implementar, imports rotos, tipos any sin justificar,
y parámetros hardcodeados que deberían ser dinámicos. 
Genera un reporte con prioridad ALTA/MEDIA/BAJA."

Workflow /add-asset:
"Añade un nuevo activo al portfolio. El ticker es [TICKER].
Actualiza: constants.ts, data/portfolio.ts, y ajusta los priors
en marketData.ts usando Damodaran 2024 para el sector [SECTOR].
Verifica que los pesos sumen 100%."

Workflow /backtest-report:
"Ejecuta un análisis del backtestEngine.ts con los datos reales disponibles.
Genera un resumen de Sharpe, max drawdown y win rate por régimen.
Formatea los resultados como tabla markdown."

Workflow /upgrade-model:
"Revisa el modelo olympusV3.ts versión actual.
Propón mejoras basadas en literatura académica reciente (factor investing, 
regime detection). Lista cambios con justificación cuantitativa."
```

**Paso 3:** En Planning Mode, delegar tareas complejas:
```
"Implementa la integración con TradingView Webhooks para recibir alertas
de indicadores técnicos en tiempo real y enviarlas via telegram-alerts"
```

---

## PARTE 3: AUTOMATIZACIÓN COMPLETA (100% GRATIS)

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

#### CRON JOB 3: Análisis AI diario (mañana antes de apertura europea)
```sql
-- Se ejecuta a las 7:45 CET (6:45 UTC) de lunes a viernes
-- Antes de la apertura de Frankfurt/Madrid
SELECT cron.schedule(
  'daily-ai-analysis',
  '45 6 * * 1-5',
  $$
  -- Este job lee el último estado del portfolio de la DB y llama ai-intelligence
  WITH portfolio_state AS (
    SELECT regime, vix, btc_rsi, credit_spread, fear_greed
    FROM portfolio_snapshots
    ORDER BY created_at DESC
    LIMIT 1
  )
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/ai-intelligence',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body := row_to_json(portfolio_state)::jsonb
  )
  FROM portfolio_state;
  $$
);
```

#### CRON JOB 4: Alerta Telegram semanal (resumen de domingo)
```sql
-- Domingo a las 18:00 CET — resumen semanal
SELECT cron.schedule(
  'weekly-telegram-summary',
  '0 17 * * 0',  -- domingo 17:00 UTC (18:00 CET)
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/telegram-alerts',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key'),
      'Content-Type', 'application/json'
    ),
    body := json_build_object(
      'type', 'custom',
      'message', '📊 *Resumen Semanal — Olympus Capital*\n_El motor OlympusV3 ha completado el análisis semanal. Revisa el dashboard para las allocations recomendadas._'
    )::jsonb
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

## PARTE 4: TABLA PORTFOLIO_SNAPSHOTS (para automatización)

Crear esta tabla en Supabase para que los cron jobs tengan estado:

```sql
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ DEFAULT now(),
  regime       TEXT,
  vix          NUMERIC,
  btc_rsi      NUMERIC,
  btc_price    NUMERIC,
  credit_spread NUMERIC,
  fear_greed   INTEGER,
  total_value  NUMERIC,
  allocations  JSONB,
  ai_gemini    TEXT,
  ai_claude    TEXT,
  ai_grok_bs   BOOLEAN DEFAULT false
);

-- RLS: solo el usuario autenticado puede leer/escribir
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_access" ON portfolio_snapshots
  FOR ALL USING (auth.role() = 'anon');  -- ajustar si usas auth
```

---

## PARTE 5: STACK COMPLETO — RESUMEN VISUAL

```
┌─────────────────────────────────────────────────────────────┐
│  GOOGLE ANTIGRAVITY (IDE local gratuito)                    │
│  ┌─────────────┐  ┌──────────────────────────────────────┐  │
│  │ Editor View │  │ Manager View (Agentes en paralelo)   │  │
│  │ (VS Code)   │  │ /audit /add-asset /backtest /upgrade │  │
│  └─────────────┘  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
              │ deploy / editar código
              ▼
┌─────────────────────────────────────────────────────────────┐
│  SUPABASE (backend gratuito)                                │
│  ┌──────────────────┐  ┌─────────────────────────────────┐  │
│  │  Edge Functions  │  │  pg_cron (automatización)       │  │
│  │  yahoo-finance   │  │  • cada hora: market data       │  │
│  │  crypto-signals  │  │  • cada 30min: crypto           │  │
│  │  glassnode-proxy │  │  • 7:45 CET: AI análisis        │  │
│  │  ai-intelligence │  │  • domingo 18h: resumen         │  │
│  │  telegram-alerts │  └─────────────────────────────────┘  │
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
│  Gemini Flash → AI analysis (1,500/día gratis)              │
└─────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│  OUTPUTS                                                    │
│  📱 Telegram → alertas en tiempo real                       │
│  🌐 Dashboard React → portfolio navigator                   │
│  📊 Decision Log → trazabilidad MiFID II                    │
└─────────────────────────────────────────────────────────────┘
```

---

## PARTE 6: WORKFLOW ELITE CON ANTIGRAVITY — PASO A PASO

### Tu flujo diario ideal (15 min/día)

```
07:30 ← pg_cron ejecuta análisis AI automático
07:45 ← Telegram recibe el análisis de Gemini Flash
08:00 ← Tú abres el dashboard en el navegador
08:05 ← Revisas régimen + allocations + alertas
08:10 ← Si hay rebalanceo sugerido: ejecutas en tu broker
        Si hay señal de ciclo: revisas en Antigravity
15 min total
```

### Usar Antigravity para mejoras continuas

**1. Abrir proyecto en Antigravity:**
```
File → Open Folder → portfolio-navigator-main
```

**2. En Manager View, despachar agentes en paralelo:**
```
Agente 1: "Añade el indicador NUPL (Net Unrealized Profit/Loss) 
           al BitcoinCycleAnalyzer como señal adicional de ciclo"

Agente 2: "Mejora el SmartDCA para que considere el tipo de cambio 
           EUR/USD al calcular el importe óptimo de compra"

Agente 3: "Crea un test unitario para el módulo Kelly que verifique 
           que nunca supera el cap del 25%"
```

**3. Los 3 agentes trabajan en paralelo. Tú revisas y apruebas.**

**4. Deploy automático:**
```bash
# En la terminal integrada de Antigravity
git add .
git commit -m "feat: NUPL indicator + DCA FX-aware + Kelly tests"
git push origin main
# Vercel/Netlify auto-despliega en < 2 minutos
```

---

## PARTE 7: OBTENER LA GEMINI API KEY (3 minutos)

```
1. Ir a: https://aistudio.google.com/apikey
2. Click "Create API Key"
3. Seleccionar proyecto (o crear nuevo)
4. Copiar la key: AIzaSy...

5. En Supabase Dashboard:
   Settings → Edge Functions → Secrets → Add new secret
   Name:  GEMINI_API_KEY
   Value: AIzaSy...

6. Redeploy las funciones:
   supabase functions deploy ai-intelligence
```

**¿Cuántas peticiones usará tu app?**
- Por click del botón AI: 3 peticiones (3 roles en paralelo)  
- Con caché 15 min: máximo 48 peticiones/día si pulsas cada 15 min todo el día
- Límite gratuito: 1,500/día
- **Margen: 97% sin usar** → absolutamente gratis

---

## RESUMEN FINAL: STACK ELITE GRATUITO

| Herramienta | Para qué | Gratis |
|-------------|---------|--------|
| **Antigravity** | IDE agentic — mejoras continuas | ✅ |
| **Gemini Flash** | AI analysis (macro/quant/sentinel) | ✅ |
| **Supabase** | Backend, DB, Edge Functions, cron | ✅ |
| **FRED** | Datos macro oficiales Fed/BCE | ✅ |
| **Yahoo Finance** | Precios reales 5 años | ✅ |
| **Telegram Bot** | Alertas institucionales | ✅ |
| **Vercel** | Hosting React | ✅ |
| **TOTAL** | Sistema hedge fund institucional | **€0/mes** |

---

*Olympus Capital — OlympusV3 Engine — Powered by Google Antigravity + Gemini Flash*
