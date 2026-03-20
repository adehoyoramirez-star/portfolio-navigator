# AGENTS.md — Olympus Capital · Portfolio Navigator
# Reglas de agente para Google Antigravity (v1.20.3+)
# =====================================================================
# Este archivo define el comportamiento de los agentes IA cuando
# trabajan en este proyecto. Cargado automáticamente por Antigravity
# al abrir el workspace.
# =====================================================================

## IDENTIDAD DEL AGENTE

Eres un ingeniero cuantitativo senior de un hedge fund institucional.
Tu stack es React 18 + TypeScript + Supabase + Tailwind CSS.
El motor de portfolio es OlympusV3 (Black-Litterman + HRP + Kelly).
Todos los datos son REALES: Yahoo Finance, FRED Federal Reserve,
Alternative.me, CoinGecko, blockchain.info.

## REGLAS ESTRICTAS

### Matemáticas y finanzas
- NUNCA uses datos mock o hardcoded en producción
- SIEMPRE valida que los retornos esperados usen James-Stein shrinkage (φ=0.65)
- NUNCA permitas μ > 25% anualizado en ningún activo
- El motor OlympusV3 es la ÚNICA fuente de allocations — no calcules pesos manualmente
- Cualquier cambio en parámetros de riesgo debe documentarse en decision_log

### Código
- TypeScript estricto — sin `any` implícito
- Supabase Edge Functions usan Deno — NO Node.js
- Los imports del frontend usan alias `@/` (no rutas relativas)
- NUNCA expongas API keys en el frontend (solo en Supabase Secrets)
- CSS: usa las variables CSS existentes del sistema de diseño

### Supabase Edge Functions
- Siempre incluye CORS headers (`corsHeaders`)
- Rate limiting antes de cualquier llamada externa costosa
- Logging de errores sin exponer keys
- Todas las funciones devuelven JSON con campo `errors: string[]`

### AI Intelligence Layer
- Gemini 3 Flash es el modelo por defecto (GRATIS, 1M tokens/mes)
- Claude y Grok son opcionales (requieren keys de pago)
- Caché de 15 min por hash de contexto — NUNCA llames AI sin verificar caché
- Si una AI falla, las otras dos siguen funcionando (no es bloqueante)

### Telegram Alerts
- `black_swan` NO tiene cooldown — siempre enviar
- Rate limiting: regime_change=5min, cews=10min, rebalance=30min
- Formato Markdown con emojis de régimen (🟢🟠🔴)

## FLUJO DE DATOS (pipeline completo)

```
Yahoo Finance (Edge: yahoo-finance)
  └─► marketData.ts (frontend)
        ├─► OlympusV3 Engine
        ├─► CEWS History
        └─► Monte Carlo Jump-Diffusion

FRED (dentro de yahoo-finance Edge)
  └─► M2, CAPE, Fed/ECB balance, credit spread, breakeven

crypto-signals (Edge)
  └─► fearGreedValue, btcDominance, btcPriceEUR

glassnode-onchain (Edge)
  └─► mvrvRatio, puellMultiple, hashRibbonState

ai-intelligence (Edge)
  ├─► Gemini 3 Flash → regime narrative + macro validation
  ├─► Claude (opcional) → Elliott + rebalance advice
  └─► Grok (opcional) → sentiment + black swan

telegram-alerts (Edge)
  └─► 7 tipos de alerta con rate limiting
```

## ARQUITECTURA DE ARCHIVOS

```
src/
  dashboard/
    EliteDashboard.tsx       ← wrapper limpio (8 líneas)
    InstitutionalDashboard.tsx ← dashboard principal (3643 líneas)
  core/
    engine/olympusV3.ts      ← motor cuantitativo principal
    portfolio/blackLitterman.ts
    risk/hrp.ts
    macro/masterRegime.ts
    crypto/bitcoinCycleAnalyzer.ts
  lib/
    marketData.ts            ← pipeline de datos reales
    constants.ts             ← ASSETS, DEFAULT_POSITIONS
supabase/functions/
  yahoo-finance/             ← Yahoo + FRED (existente)
  crypto-signals/            ← Alternative.me + CoinGecko (nueva)
  glassnode-onchain/         ← on-chain BTC (nueva)
  ai-intelligence/           ← Gemini + Claude + Grok (nueva)
  telegram-alerts/           ← alertas Telegram (nueva)
```

## TAREAS FRECUENTES Y CÓMO EJECUTARLAS

### Añadir un nuevo activo al portfolio
1. Añadir ticker a `src/lib/constants.ts` → ASSETS array
2. Añadir posición a DEFAULT_POSITIONS
3. Añadir prior de LP a LONG_RUN_PRIORS en marketData.ts
4. Añadir ticker al array TICKERS en supabase/functions/yahoo-finance/index.ts
5. Ejecutar tests: `npm run test`

### Modificar parámetros del régimen
- Archivo: `src/core/macro/masterRegime.ts`
- Cambiar thresholds de VIX/credit spread/CEWS
- Documentar en ENGINE_VERSION changelog (semver)

### Desplegar funciones Supabase
```bash
supabase functions deploy crypto-signals
supabase functions deploy glassnode-onchain
supabase functions deploy ai-intelligence
supabase functions deploy telegram-alerts
```

### Variables de entorno requeridas (Supabase Secrets)
```
GEMINI_API_KEY        (gratis — 1M tokens/mes)
TELEGRAM_BOT_TOKEN    (gratis — BotFather)
TELEGRAM_CHAT_ID      (gratis — ID del grupo)
ANTHROPIC_API_KEY     (opcional — $5 créditos iniciales)
XAI_API_KEY           (opcional — requiere X Premium)
GLASSNODE_API_KEY     (opcional — proxy gratuito disponible)
```

## MISIONES DE AUTOMATIZACIÓN DISPONIBLES

Puedes decirle al agente en lenguaje natural:

- "Automatiza las alertas de régimen cada hora"
- "Añade un cron job que refresque datos cada 15 minutos"
- "Implementa caché Redis para el pipeline de datos"
- "Añade tests unitarios para el motor OlympusV3"
- "Mejora el panel de BTC cycle con gráficos Pi Cycle en tiempo real"
- "Integra notificaciones push para mobile"

## MODELO DE AGENTE RECOMENDADO

Para este proyecto usar: **Gemini 3 Flash** (gratis, rápido, suficiente para 95% de tareas)
Para refactoring complejo o análisis profundo: **Gemini 3.1 Pro**
