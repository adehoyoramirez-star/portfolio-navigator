# GEMINI.md — Instrucciones específicas para Gemini en Antigravity
# =====================================================================
# Antigravity carga este archivo cuando el modelo activo es Gemini.
# Complementa AGENTS.md con instrucciones específicas de Gemini.
# =====================================================================

## CONTEXTO DEL PROYECTO

Portfolio Navigator institucional con motor cuantitativo OlympusV3.
Stack: React 18 + TypeScript + Vite + Supabase + Tailwind.
Datos 100% reales: Yahoo Finance, FRED, Alternative.me, CoinGecko.

## TU ROL COMO AGENTE GEMINI

Cuando ejecutes misiones en este proyecto:

1. **SIEMPRE** lee el AUDIT_REPORT.md antes de modificar lógica del motor
2. **NUNCA** cambies la matemática de Black-Litterman sin revisar blackLitterman.ts
3. Los datos de mercado vienen de Yahoo Finance — no los simules
4. Cualquier nueva Edge Function debe seguir el patrón de crypto-signals/index.ts

## AUTOMATIZACIÓN — MISIONES DISPONIBLES

### Misión: Cron Job de datos cada 15 minutos
```
"Crea un Supabase cron job que llame a yahoo-finance cada 15 minutos
 y guarde los precios en la tabla market_cache con TTL de 20 minutos"
```

### Misión: Alertas automáticas de régimen
```
"Detecta cambios de régimen comparando el último resultado del motor
 con el guardado en localStorage y dispara telegram-alerts automáticamente"
```

### Misión: PWA con notificaciones push
```
"Convierte la app en PWA con service worker y notificaciones push
 para las alertas de cisne negro y cambio de régimen"
```

### Misión: Dashboard mobile optimizado
```
"Crea una vista responsive para mobile con los KPIs críticos:
 régimen, AUM, VIX, BTC RSI y el score DCA del día"
```

## LIMITACIONES IMPORTANTES

- NO modifiques el motor OlympusV3 sin tests completos
- NO uses datos sintéticos en producción
- NO llames APIs de pago sin verificar que la key está configurada
- El James-Stein shrinkage φ=0.65 NO se cambia sin justificación estadística

## COSTE CERO — STACK GRATUITO COMPLETO

Todo lo que uses en este proyecto es gratis:
- Gemini 3 Flash: 1M tokens/mes gratis en AI Studio
- Supabase free: 500k Edge Functions + 500MB DB
- Yahoo Finance: API no oficial, sin key, sin coste
- FRED: CSV público, sin key
- Alternative.me: sin key
- CoinGecko tier free: 50 req/min
- Telegram Bot: gratis con BotFather
- Vercel/Netlify hosting: gratis tier hobby
