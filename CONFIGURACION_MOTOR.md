# OLYMPUS CAPITAL — Motor de Market Data

## Configuración Completada ✅

### 1. Interactive Brokers (IBKR)
- **Account ID**: `U25387834`
- **Gateway URL**: `http://localhost:5000`
- **Estado**: Habilitado

**Archivos configurados:**
- `src/core/tactical/ibkrConnector.ts` - Conector IBKR
- `.env` / `.env.local` - Variables de entorno
- `docker-compose.yml` - Contenedor Docker

### 2. Supabase
- **Proyecto**: `yrirandgftnuvdzatwgc`
- **URL**: `https://yrirandgftnuvdzatwgc.supabase.co`
- **Edge Functions**: `yahoo-finance`, `yahoo-finance-tactical`

**Archivos clave:**
- `src/integrations/supabase/client.ts` - Cliente Supabase
- `src/lib/marketData.ts` - Fetch de market data
- `supabase/functions/yahoo-finance-tactical/index.ts` - Edge Function

### 3. Docker
- **Servicio**: IBKR Client Portal Gateway
- **Puerto**: 5000
- **Imagen**: `ghcr.io/extrange/ibkr-cpapi:latest`

---

## Flujo de Market Data

```
┌─────────────────────────────────────────────────────────────────┐
│                    MARKET DATA FLOW                              │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ Yahoo Finance    │ ← Histórico 2 años, fundamentales (PER, EPS)
│ (vía HTTP)       │   ^VIX, ^TNX, ^IRX, HYG, BTC-EUR, ETFs
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  Supabase Edge Function: yahoo-finance-tactical              │
│  - Fetch precios históricos (2y daily)                       │
│  - Fetch fundamentales (PER, EPS, earningsYield)             │
│  - Cache 5 minutos                                           │
│  - Retorna: closes[], volumes[], currentPrice, fundamentals  │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  src/lib/marketData.ts                                       │
│  - Procesa históricos de Yahoo                               │
│  - Calcula indicadores: RSI, Z-Score, Volatilidad            │
│  - Calcula matriz covarianza                                 │
│  - Construye CEWS history (5 años semanal)                   │
│  - Calcula expected returns (James-Stein shrinkage)          │
│  - Retorna: MarketData completo                              │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  Dashboards (React)                                          │
│  - InstitutionalDashboard.tsx                                │
│  - TacticalDashboard.tsx                                     │
│  - EliteDashboard.tsx                                        │
└──────────────────────────────────────────────────────────────┘

┌──────────────────┐
│ IBKR Gateway     │ ← Tiempo real, posiciones, órdenes
│ (Docker :5000)   │   Account: U25387834
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│  src/core/tactical/ibkrConnector.ts                          │
│  - IBKRClient singleton                                      │
│  - Métodos: getPositions(), getMarketData(), placeOrder()    │
│  - Conids conocidos: BTC-EUR, IS3Q.DE, VVSM.DE, etc.         │
└──────────────────────────────────────────────────────────────┘
```

---

## Inicio del Sistema

### 1. Iniciar IBKR Gateway (Docker)

```bash
cd C:\Users\marti\Desktop\PAPA\portfolio-navigator

# Iniciar gateway
docker-compose up -d ibkr-gateway

# Verificar estado
docker ps | grep olympus-ibkr

# Ver logs
docker logs -f olympus-ibkr-gateway
```

### 2. Autenticar IBKR (primera vez)

1. Abrir: `http://localhost:5000`
2. Login con credenciales IBKR (Account: U25387834)
3. Completar 2FA
4. Sesión válida ~24h

### 3. Iniciar desarrollo frontend

```bash
npm install
npm run dev
```

---

## Verificación de Conexión

### IBKR Gateway

```bash
# Estado de autenticación
curl http://localhost:5000/v1/api/iserver/auth/status

# Cuentas disponibles
curl http://localhost:5000/v1/api/portfolio/accounts

# Posiciones (reemplaza con tu account ID)
curl http://localhost:5000/v1/api/portfolio/U25387834/positions/0
```

### Supabase Edge Functions

```bash
# Testear yahoo-finance-tactical
curl -X POST "https://yrirandgftnuvdzatwgc.supabase.co/functions/v1/yahoo-finance-tactical" \
  -H "apikey: <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["BTC-EUR", "VVSM.DE", "URNU.DE"]}'
```

---

## Market Data Interface

```typescript
interface MarketData {
  // Precios actuales
  prices: Record<string, number>;
  
  // Macro
  vix: number;
  tnx: number;   // 10y yield
  irx: number;   // 13w T-bill
  
  // BTC
  btcZScore: number;
  btcRsi: number;
  btcRsiWeekly: number;
  btcVolRealized: number;
  
  // S&P 500
  sp500Rsi: number;
  sp500Momentum12m: number;
  sp500Momentum3m: number;
  per: number;           // Shiller CAPE
  
  // Liquidez
  liquidityScore: number;
  m2Growth: number;
  
  // Credit
  creditSpread: number;
  moveIndex: number;     // Volatilidad bonos
  
  // Commodities
  wtiOil: number;        // Brent crude
  
  // Matrices para optimización
  expectedReturns: number[];
  realizedVols: number[];
  covMatrix: number[][];
  
  // Histórico CEWS
  cewsHistory: CEWSDataPoint[];
}
```

---

## Activos Soportados

### Core Portfolio (ASSETS)
| Ticker | Nombre |
|--------|--------|
| BTC-EUR | Bitcoin |
| VVSM.DE | VanEck Semiconductor |
| IS3Q.DE | iShares MSCI World Quality |
| URNU.DE | Global X Uranium |
| EMXC.DE | iShares EM ex-China |
| PPFB.DE | iShares Physical Gold |
| XNAS.DE | iShares NASDAQ 100 |

### Macro Indicators
| Ticker | Descripción |
|--------|-------------|
| ^VIX | CBOE Volatility Index |
| ^TNX | 10-Year Treasury Yield |
| ^IRX | 13-Week T-Bill |
| HYG | iShares High Yield Bond |
| ^GSPC | S&P 500 |
| DX-Y.NYB | US Dollar Index |
| BZ=F | Brent Crude Oil |
| ^MOVE | CBOE MOVE Index |

### IBKR Conids Conocidos
```typescript
KNOWN_CONIDS = {
  'BTC-EUR':  13977784,
  'IS3Q.DE':  107373649,
  'VVSM.DE':  354262162,
  'URNU.DE':  478170349,
  'EMXC.DE':  107373578,
  'PPFB.DE':  35271851,
  'XNAS.DE':  185844684,
}
```

---

## Troubleshooting

### IBKR no conecta
1. Verificar Docker: `docker ps | grep olympus-ibkr`
2. Verificar logs: `docker logs olympus-ibkr-gateway`
3. Re-autenticar: abrir `http://localhost:5000` en browser

### Supabase no responde
1. Verificar URL en `.env`: `VITE_SUPABASE_URL`
2. Verificar API key: `VITE_SUPABASE_ANON_KEY`
3. Testear función: `supabase functions serve --env-file .env`

### Market Data incompleto
1. Revisar logs de Edge Function en Supabase Dashboard
2. Verificar tickers en `src/lib/constants.ts`
3. Check Yahoo Finance: `https://finance.yahoo.com/quote/{TICKER}`

---

## Referencias

- [IBKR API Docs](https://interactivebrokers.github.io/cpwebapi/)
- [Supabase Docs](https://supabase.com/docs)
- [Yahoo Finance API](https://github.com/ranaroussi/yfinance)
