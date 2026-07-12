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

## REGLA INSTITUCIONAL: SEÑALES MACRO EN MÚLTIPLES CAPAS

Una variable macro puede aparecer en MÁXIMO DOS capas del pipeline SI Y SOLO SI:

1. **Miden dimensiones diferentes** del mismo fenómeno (spot vs. trend, nivel vs. tasa de cambio)
2. **Los umbrales NO se solapan** (gate mucho más extremo que régimen)
3. **Los mecanismos son distintos** (régimen = recalibración gradual; gate = stop-loss puntual)

**Ejemplos válidos:**
- `dxy spot` → cycleTopDetector EMXC (nivel del dólar para emergentes)
  + `dxy trend` → masterRegime (tendencia para régimen global) → dimensiones distintas ✅
- VIX 20 → masterRegime (40% del peso del régimen, recalibración gradual)
  + VIX > 30 → tailRisk (stop-loss puntual) → umbrales y mecanismos distintos ✅

**Ejemplos de violación (corregidos):**
- `dxyTrend` en masterRegime + Gate 3 Absolute Trend → misma variable, mismos umbrales solapados, mismo efecto → ELIMINADO (Jul-2026)
- `yieldSpread` en masterRegime + propuesto en cycleTopDetector → mismo dato, misma dirección → RECHAZADO (Jul-2026)

**En caso de duda → NO PERMITIDO. Una señal, una capa.**

---

### Deuda técnica conocida

- **Naming WTI/Brent:** La variable `wtiOil` en MarketData, globalStress, olympusV3, masterRegime, y cycleTopDetector contiene en realidad **Brent** (Yahoo ticker BZ=F). Los umbrales están calibrados para Brent (75/95/115). Funcionalmente correcto, pero si se conecta WTI real (CL=F) en el futuro, los umbrales se retrasarían $3-5. Renombrar a `brentOil` en toda la cadena: MarketData → olympusV3 → masterRegime → globalStress → cycleTopDetector → dashboard.

- **Pérdida de granularidad del uranio (ratio Spot/LT):** Cuando se clampeó allocationMultiplier a [0,1] (FIX-AUDIT-URANIO-CLAMP), el boost por ratio Spot/LT bajo (1.40→1.0, 1.20→1.0) perdió toda expresión específica en el motor. La señal más fuerte del detector original —ratio <0.70 = ventana de acumulación agresiva, +100-300% históricamente— ahora es indistinguible de ratio=1.0. Si se quiere recuperar esa granularidad, iría como un multiplicador ortogonal al régimen (similar a dxy spot vs dxyTrend), no dentro de topSignals. La pérdida es consciente, no un bug.

---

### 🔖 SIGNAL_REGISTRY — fuente de verdad de qué variable entra en qué capa

Regla: una variable solo puede aparecer en múltiples capas si cumple los 3 criterios
(dimensiones distintas, umbrales no solapados, mecanismos distintos). Esta tabla es
la referencia canónica. Cualquier propuesta de nueva señal debe consultarse aquí primero.

| Variable | Capas activas | Nota |
|---|---|---|
| `dxyTrend` | `globalStress` (+1 si > 2% apreciación) | Gate 3 DXY eliminado Jul-2026 (doble conteo). Solo en globalStress. |
| `dxy` (spot) | `cycleTopDetector` (EMXC, > 103 → +0.75, > 115 → +3) | Distinta de dxyTrend: spot mide nivel EM, trend mide régimen global. ✅ |
| `yieldSpread` (T10Y2Y) | `crisis.ts` (+4 puntos si invertida), `CEWS_CONFIG` (danger: -0.5) | NO añadir a cycleTopDetector. Doble capa ya justificada (umbrales distintos). |
| `creditSpread` | `globalStress` (+1 si > 3, +2 si > 5) | También en `crisis.ts` (+4 puntos si > 5). Umbrales no solapados (3/5 vs 5). ✅ |
| `m2Growth` | `detectRegimeProbabilistic` (3er input), `CEWS_CONFIG` (warning: 2.0, danger: 0.0) | Dinero AMPLIO. NO confundir con CB Liquidity (dinero BASE). |
| `cbLiquidityGrowth` | `globalStress` (+2 si < 0%, +3 si < -5%) | Dinero BASE (QE/QT directo). Defensa aprobada Jul-2026. Ver sección CB Liquidity vs M2. |
| `vix` | `globalStress` (+1 si > 18, +2 si > 25), `crisis.ts` (+1 si > 20) | Misma variable, distinto mecanismo: régimen vs stop-loss puntual. ✅ |
| `wtiOil` *(Brent real)* | `globalStress` (+1/+2/+3 a 75/95/115), `cycleTopDetector` (gold override) | Dimensiones distintas: shock geopolítico vs protección oro. ✅ |
| `btcVol` | `globalStress` (+1 si > 80%) | Solo en globalStress. |
| `move` | `globalStress` (+1 si > 110, +2 si > 140) | Solo en globalStress. |

**Variables rechazadas:**
| Variable | Propuesta rechazada | Motivo |
|---|---|---|
| `dxyTrend` | Gate 3 Absolute Trend | Doble conteo con globalStress (mismos umbrales, mismo efecto). |
| `yieldSpread` | cycleTopDetector | Ya en crisis.ts + CEWS. Mismo dato, misma dirección. |

### CB Liquidity vs M2 — precedente de la regla institucional (Jul-2026)

**Caso:** Se propuso añadir Global CB Liquidity (WALCL+ECBASSETSW) a globalStress. Objeción: m2Growth ya existe en detectRegimeProbabilistic y CEWS, ambos miden "cantidad de dinero".

**Defensa (APROBADA):** Son dimensiones macro distintas:
- **m2Growth** = dinero AMPLIO (depósitos bancarios, crédito privado, multiplicador bancario). Depende de la voluntad de los bancos de prestar.
- **cbLiquidityGrowth** = dinero BASE (creación directa de reservas vía QE/QT por bancos centrales). No depende del multiplicador bancario.
- **Evidencia de divergencia:** En 2023 la Fed redujo balance vía QT, pero M2 se mantuvo plano porque el drenaje venía del Reverse Repo facility (reservas estériles), no de depósitos bancarios. Divergieron en timing y magnitud.

**Aplica el criterio A de la regla:** "Miden dimensiones diferentes del mismo fenómeno (spot vs. trend, nivel vs. tasa de cambio)" — aquí: base monetaria vs. dinero amplio.

## MISIONES DE AUTOMATIZACIÓN DISPONIBLES

Puedes decirle al agente en lenguaje natural:

- "Automatiza las alertas de régimen cada hora"
- "Añade un cron job que refresque datos cada 15 minutos"
- "Implementa caché Redis para el pipeline de datos"
- "Añade tests unitarios para el motor OlympusV3"
- "Mejora el panel de BTC cycle con gráficos Pi Cycle en tiempo real"
