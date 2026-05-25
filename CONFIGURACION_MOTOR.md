# OLYMPUS CAPITAL — Motor de Market Data

## Configuración Completada ✅

### 1. Supabase
- **Proyecto**: `yrirandgftnuvdzatwgc`
- **URL**: `https://yrirandgftnuvdzatwgc.supabase.co`
- **Edge Functions**: `yahoo-finance`, `yahoo-finance-tactical`

**Archivos clave:**
- `src/integrations/supabase/client.ts` - Cliente Supabase
- `src/lib/marketData.ts` - Fetch de market data
- `supabase/functions/yahoo-finance-tactical/index.ts` - Edge Function

### 2. Docker (opcional)
- **Servicio**: Redis cache
- **Puerto**: 6379
- **Supabase local**: Puerto 54322

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
```

---

## Inicio del Desarrollo

```bash
npm install
npm run dev
```

---

## Verificación de Conexión

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
  prices: Record<string, number>;
  vix: number;
  tnx: number;   // 10y yield
  irx: number;   // 13w T-bill
  btcZScore: number;
  btcRsi: number;
  btcRsiWeekly: number;
  btcVolRealized: number;
  sp500Rsi: number;
  sp500Momentum12m: number;
  sp500Momentum3m: number;
  per: number;           // Shiller CAPE
  liquidityScore: number;
  m2Growth: number;
  creditSpread: number;
  moveIndex: number;
  wtiOil: number;
  expectedReturns: number[];
  realizedVols: number[];
  covMatrix: number[][];
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

---

## Troubleshooting

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

- [Supabase Docs](https://supabase.com/docs)
- [Yahoo Finance API](https://github.com/ranaroussi/yfinance)
