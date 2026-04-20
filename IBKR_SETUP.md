# Interactive Brokers — Configuración IBKR Client Portal

## Account ID
- **Account**: `U25387834`

## Arquitectura

```
┌─────────────────────┐     HTTP REST      ┌──────────────────────┐
│   Portfolio         │ ──────────────────►│  IBKR Client Portal  │
│   Navigator         │                    │  Gateway             │
│   (React/TS)        │ ◄───────────────── │  (Docker :5000)     │
└─────────────────────┘     JSON Response  └──────────────────────┘
                                           │
                                           │ TLS
                                           ▼
                                   ┌──────────────────────┐
                                   │  Interactive Brokers │
                                   │  Trader Workstation  │
                                   └──────────────────────┘
```

## Inicio Rápido

### 1. Iniciar IBKR Gateway con Docker

```bash
cd C:\Users\marti\Desktop\PAPA\portfolio-navigator

# Iniciar el gateway
docker-compose up -d ibkr-gateway

# Ver logs
docker logs -f olympus-ibkr-gateway
```

### 2. Autenticación (primera vez)

1. Abrir browser: `http://localhost:5000`
2. Login con credenciales de IBKR
3. Completar 2FA si está habilitado
4. La sesión dura ~24 horas

### 3. Verificar conexión

```bash
# Check estado de autenticación
curl http://localhost:5000/v1/api/iserver/auth/status

# Ver cuentas disponibles
curl http://localhost:5000/v1/api/portfolio/accounts
```

### 4. Comandos útiles

```bash
# Ver estado
docker ps | grep olympus-ibkr

# Reiniciar gateway
docker-compose restart ibkr-gateway

# Ver logs en tiempo real
docker logs -f olympus-ibkr-gateway

# Detener
docker-compose down ibkr-gateway
```

## API Endpoints

| Endpoint | Descripción |
|----------|-------------|
| `GET /v1/api/iserver/auth/status` | Estado de autenticación |
| `POST /v1/api/tickle` | Mantener sesión activa |
| `GET /v1/api/portfolio/accounts` | Listar cuentas |
| `GET /v1/api/portfolio/{accountId}/summary` | Resumen de cuenta |
| `GET /v1/api/portfolio/{accountId}/positions` | Posiciones abiertas |
| `GET /v1/api/iserver/marketdata/snapshot` | Precios en tiempo real |
| `POST /v1/api/iserver/account/{accountId}/orders` | Colocar orden |
| `DELETE /v1/api/iserver/account/{accountId}/order/{orderId}` | Cancelar orden |

## Documentación Oficial

- [IBKR Client Portal API](https://interactivebrokers.github.io/cpwebapi/)
- [OpenAPI Spec](https://github.com/InteractiveBrokers/cpwebapi-spec)

## Troubleshooting

### Error: "Not authenticated"
- Necesitas autenticarte vía browser primero
- La sesión expira después de ~24h

### Error: "Gateway not running"
```bash
docker-compose up -d ibkr-gateway
docker logs olympus-ibkr-gateway
```

### Error: "Account not found"
- Verifica que el account ID sea `U25387834`
- Confirma en `curl http://localhost:5000/v1/api/portfolio/accounts`

## Integración con la App

El conector IBKR está en:
```
src/core/tactical/ibkrConnector.ts
```

Configuración actual:
```typescript
DEFAULT_IBKR_CONFIG = {
  gatewayUrl: 'http://localhost:5000',
  accountId:  'U25387834',
  enabled:    true,
}
```

## Market Data Flow

1. **Yahoo Finance** → Precios históricos y fundamentales (vía Supabase Edge Function)
2. **IBKR Gateway** → Precios en tiempo real, posiciones, órdenes (vía Docker local)
3. **Supabase** → Persistencia de datos y funciones serverless
