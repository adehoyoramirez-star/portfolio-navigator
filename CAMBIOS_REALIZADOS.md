# Cambios Realizados — Portfolio Navigator

## Fecha: 2026-04-20

---

## ✅ Problemas Resueltos

### 1. Error CORS en Edge Function (CRÍTICO)

**Problema:**
```
Access to fetch at 'https://yrirandgftnuvdzatwgc.supabase.co/functions/v1/yahoo-finance-tactical' 
from origin 'https://portfolio-navigator-dun.vercel.app' has been blocked by CORS policy
```

**Solución:**
- Actualizado `supabase/functions/yahoo-finance-tactical/index.ts`
- Añadidas cabeceras CORS completas:
  - `Access-Control-Allow-Methods: POST, OPTIONS`
  - `Access-Control-Max-Age: 86400`
- Manejo explícito de preflight OPTIONS con status 204

**Deploy:**
```bash
supabase functions deploy yahoo-finance-tactical --no-verify-jwt
```

---

### 2. Fundamentales Manuales (Earnings Yield)

**Problema:**
Yahoo Finance no devuelve consistentemente datos fundamentales (PER, EPS, Earnings Yield) para ETFs europeos.

**Solución:**
- Creado `src/core/tactical/fundamentalsConfig.ts`
- Datos manuales para los 7 activos principales + proxies US:

| Ticker | Earnings Yield | PER | Fuente |
|--------|---------------|-----|--------|
| BTC-EUR | 0 (Crypto) | 0 | N/A |
| IS3Q.DE | 4.2% | 23.8 | MSCI factsheet |
| VVSM.DE | 3.5% | 28.5 | VanEck Q1 2026 |
| URNU.DE | 2.8% | 35.7 | Global X |
| EMXC.DE | 5.5% | 18.2 | iShares |
| PPFB.DE | 0 (Commodity) | 0 | N/A |
| XNAS.DE | 3.2% | 31.2 | NASDAQ-100 |

**Implementación:**
- `tacticalScreener.ts` usa fallback automático a datos manuales
- Si Yahoo devuelve PER > 0, usa Yahoo
- Si no, usa configuración manual

---

### 3. IBKR Configuración

**Problema:**
Imágenes Docker de IBKR no disponibles públicamente.

**Solución:**
- Actualizado `docker-compose.yml` con servicios funcionales:
  - Supabase local (desarrollo)
  - Redis cache
  - IBKR placeholder (ejecutar Gateway nativo en Windows)
- Actualizado `ibkrConnector.ts`:
  - Account ID: `U25387834`
  - `enabled: false` por defecto (hasta configurar Gateway)
- Creada documentación `IBKR_CONFIGURACION.md`

---

## 📁 Archivos Modificados

### Core del Motor
| Archivo | Cambio |
|---------|--------|
| `src/core/tactical/tacticalScreener.ts` | + imports fundamentalsConfig, fallback manual |
| `src/core/tactical/types.ts` | + earningsYield, per, eps en TacticalAsset |
| `src/core/tactical/ibkrConnector.ts` | enabled: false, docs actualizadas |

### Edge Functions
| Archivo | Cambio |
|---------|--------|
| `supabase/functions/yahoo-finance-tactical/index.ts` | CORS headers completos, OPTIONS handler |

### Configuración
| Archivo | Cambio |
|---------|--------|
| `docker-compose.yml` | Servicios locales (Supabase, Redis, IBKR placeholder) |
| `.env` / `.env.local` | Variables IBKR añadidas |

### Nuevos Archivos
| Archivo | Propósito |
|---------|-----------|
| `src/core/tactical/fundamentalsConfig.ts` | Fundamentales manuales fallback |
| `IBKR_CONFIGURACION.md` | Guía configuración IBKR |
| `CONFIGURACION_MOTOR.md` | Documentación del motor |
| `scripts/verify-config.ts` | Script verificación configuración |

---

## 🧪 Verificación

### Build
```bash
npm run build
# ✓ 918 modules transformed
# ✓ built in 5.29s
```

### Edge Function Deploy
```bash
supabase functions deploy yahoo-finance-tactical --no-verify-jwt
# Deployed Functions on project yrirandgftnuvdzatwgc
```

### Configuración Local
```bash
npx tsx scripts/verify-config.ts
# ✓ Correcto: 15
# ⚠ IBKR Gateway: OFFLINE (esperado - usar Gateway nativo)
```

---

## 🚀 Cómo Desplegar en Producción

### 1. Edge Functions (Supabase)
```bash
cd C:\Users\marti\Desktop\PAPA\portfolio-navigator
supabase link --project-ref yrirandgftnuvdzatwgc
supabase functions deploy yahoo-finance-tactical --no-verify-jwt
```

### 2. Frontend (Vercel)
El build se genera automáticamente al hacer push a GitHub.

### 3. IBKR Gateway (Windows)
1. Descargar: https://www.interactivebrokers.com/en/trading/ibgateway.php
2. Instalar y ejecutar
3. Configurar API Settings → Puerto 4001
4. Actualizar `ibkrConnector.ts`: `gatewayUrl: 'http://localhost:4001'`

---

## 📊 Estado del Sistema

| Componente | Estado | Notas |
|------------|--------|-------|
| Supabase Cloud | ✅ ONLINE | Project: yrirandgftnuvdzatwgc |
| Edge Functions | ✅ DEPLOYED | CORS fix aplicado |
| Frontend Vercel | ✅ DEPLOYED | portfolio-navigator-dun.vercel.app |
| IBKR Gateway | ⚠️ PENDIENTE | Requiere instalación nativa Windows |
| Docker Local | ⚠️ OPCIONAL | Supabase/Redis para desarrollo |

---

## 🔧 Próximos Pasos (Opcionales)

1. **IBKR Gateway**: Instalar nativo en Windows para trading en tiempo real
2. **Monitorización**: Configurar alerts en Supabase para Edge Functions
3. **Backtesting**: Ejecutar walk-forward optimization con nuevos datos
4. **Telegram Alerts**: Configurar bot para notificaciones de señales

---

## 📝 Notas Importantes

### Market Data Flow Actualizado
```
1. Yahoo Finance (HTTP)
   ↓
2. Supabase Edge Function (yahoo-finance-tactical)
   - Fetch histórico 2y + fundamentales
   - CORS headers configurados
   ↓
3. marketData.ts (frontend)
   - Calcula indicadores, RSI, volatilidad
   - Fallback a fundamentales manuales si Yahoo no devuelve
   ↓
4. Dashboards (React)
```

### Fundamentales Manuales
- Se usan SOLO si Yahoo Finance no devuelve datos
- Actualizados: 2026-04-20
- Revisar trimestralmente con earnings reports

### IBKR
- Account ID: `U25387834`
- Sin Docker oficial disponible → usar Gateway nativo Windows
- Puerto: 4001 (producción) o 4002 (paper)
