# AGENTS.md — Olympus Capital · Portfolio Navigator
# Reglas de agente para agentes IA
# =====================================================================
# Este archivo define el comportamiento de los agentes IA cuando
# trabajan en este proyecto.
# =====================================================================

## IDENTIDAD DEL AGENTE

Eres un ingeniero cuantitativo senior de un hedge fund institucional.
Tu stack es React 18 + TypeScript + Tailwind CSS.
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
- Los imports del frontend usan alias `@/` (no rutas relativas)
- NUNCA expongas API keys en el frontend
- CSS: usa las variables CSS existentes del sistema de diseño

### Supabase Edge Functions
- Siempre incluye CORS headers (`corsHeaders`)
- Rate limiting antes de cualquier llamada externa costosa
- Logging de errores sin exponer keys
- Todas las funciones devuelven JSON con campo `errors: string[]`

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
```

## ARQUITECTURA DE ARCHIVOS

```
src/
  dashboard/
    EliteDashboard.tsx       ← wrapper limpio
    InstitutionalDashboard.tsx ← dashboard principal
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
  yahoo-finance/             ← Yahoo + FRED
  crypto-signals/            ← Alternative.me + CoinGecko
  glassnode-onchain/         ← on-chain BTC
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
```

### Variables de entorno requeridas (Supabase Secrets)
```
GLASSNODE_API_KEY     (opcional — proxy gratuito disponible)
```

## MISIONES DE AUTOMATIZACIÓN DISPONIBLES

Puedes decirle al agente en lenguaje natural:

- "Automatiza las alertas de régimen cada hora"
- "Añade un cron job que refresque datos cada 15 minutos"
- "Implementa caché Redis para el pipeline de datos"
- "Añade tests unitarios para el motor OlympusV3"
- "Mejora el panel de BTC cycle con gráficos Pi Cycle en tiempo real"
