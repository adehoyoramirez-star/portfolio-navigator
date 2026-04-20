# Interactive Brokers — Configuración para Portfolio Navigator

## Account ID: `U25387834`

---

## ⚠️ Importante: Estado del IBKR Gateway

Las imágenes Docker públicas de IBKR Client Portal (`ghcr.io/extrange/ibkr-cpapi`) **no están disponibles** o son privadas. 

### Soluciones Disponibles

Tienes **2 opciones** para conectar con IBKR:

---

## Opción A: IBKR TWS/Gateway Nativo (RECOMENDADA)

Esta es la opción más fiable y soportada oficialmente.

### Paso 1: Descargar IBKR Gateway

1. Ve a: https://www.interactivebrokers.com/en/trading/ibgateway.php
2. Descarga **IBKR Gateway** para Windows
3. Instala el programa

### Paso 2: Configurar API

1. Inicia IBKR Gateway desde el menú de inicio
2. Loguéate con tus credenciales (Account: U25387834)
3. Ve a: **File → Global Configuration → API → Settings**

### Paso 3: Habilitar Conexión Socket

Marca estas opciones:

```
✓ Enable ActiveX and Socket EClients
✓ Allow connections from localhost only
Socket port: 4001 (producción) o 4002 (paper trading)
```

### Paso 4: Actualizar el conector

Edita `src/core/tactical/ibkrConnector.ts`:

```typescript
export const DEFAULT_IBKR_CONFIG: IBKRConfig = {
  gatewayUrl: 'http://localhost:4001',  // Puerto de TWS/Gateway
  accountId:  'U25387834',
  enabled:    true,
};
```

### Paso 5: Verificar conexión

```bash
# En PowerShell
Test-NetConnection -ComputerName localhost -Port 4001

# Deberías ver: TcpTestSucceeded : True
```

---

## Opción B: Client Portal Gateway (Docker)

Esta opción requiere que el gateway HTTP esté disponible.

### Estado Actual

- Imagen original (`ghcr.io/extrange/ibkr-cpapi`) ❌ No disponible
- Imagen alternativa (`ghcr.io/chasenlabs/clientportal`) ❌ No disponible
- Imagen comunitaria (`ghcr.io/ib-gateway/ib-gateway`) ⚠️ Verificar disponibilidad

### Alternativas Docker

Si quieres usar Docker, prueba estas imágenes:

```yaml
# docker-compose.yml
services:
  ibkr-gateway:
    image: totkeks/ibkr-clientportalgateway:latest
    # O
    image: ghcr.io/rbjorklin/ibkr-client-portal:latest
    ports:
      - "5000:5000"
```

**Nota:** Estas imágenes pueden requerir autenticación adicional.

---

## Comparación: TWS Socket API vs Client Portal API

| Característica | TWS Socket API | Client Portal API |
|----------------|----------------|-------------------|
| Puerto | 4001/4002 | 5000 |
| Protocolo | Socket binario | HTTP REST |
| Autenticación | Login en TWS | Browser + cookie |
| Sesión | Mientras TWS abierto | ~24 horas |
| Complejidad | Media | Baja |
| Recomendado | ✅ Sí | ⚠️ Solo con Docker |

---

## Verificación de Conexión

### Para TWS Socket API (puerto 4001)

```bash
# PowerShell
Test-NetConnection localhost -Port 4001

# Debería mostrar:
# TcpTestSucceeded : True
```

### Para Client Portal API (puerto 5000)

```bash
# Browser
http://localhost:5000/v1/api/iserver/auth/status

# curl
curl http://localhost:5000/v1/api/iserver/auth/status
```

---

## Configuración en .env

```bash
# IBKR TWS/Gateway (Opción A - Recomendada)
IBKR_ACCOUNT_ID="U25387834"
IBKR_GATEWAY_URL="http://localhost:4001"
IBKR_ENABLED=true

# IBKR Client Portal (Opción B - Docker)
# IBKR_GATEWAY_URL="http://localhost:5000"
```

---

## Troubleshooting

### Error: "Connection refused"

1. Verifica que IBKR Gateway esté ejecutándose
2. Confirma el puerto (4001 vs 5000)
3. Check firewall de Windows

### Error: "Authentication failed"

1. Verifica credenciales en IBKR Gateway
2. Account ID correcto: U25387834
3. Re-autentica si la sesión expiró

### Error: "Access denied"

1. En IBKR Gateway: Settings → API → Settings
2. Asegúrate de marcar "Enable ActiveX and Socket EClients"
3. Verifica "Allow connections from localhost only"

---

## Enlaces Útiles

- [IBKR API Documentation](https://interactivebrokers.github.io/cpwebapi/)
- [IBKR Socket API](https://interactivebrokers.github.io/tws-api/)
- [Descargar IBKR Gateway](https://www.interactivebrokers.com/en/trading/ibgateway.php)
- [IBC (IB Controller)](https://github.com/IbcAlpha/IBC)

---

## Resumen

**Recomendación:** Usa IBKR TWS/Gateway nativo en Windows (Opción A).

1. ✅ Más estable y soportado oficialmente
2. ✅ No requiere Docker
3. ✅ Sesión persistente mientras TWS esté abierto
4. ✅ Documentación completa de IBKR

**Solo usa Docker** si necesitas automatización completa sin interfaz gráfica.
