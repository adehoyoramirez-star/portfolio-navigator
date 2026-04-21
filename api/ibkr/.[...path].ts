// ============================================================
// api/ibkr/[...path].ts
// Proxy server-side para IBKR Client Portal Gateway
// Coloca este archivo en la raíz del proyecto en: api/ibkr/[...path].ts
//
// Variables de entorno necesarias en Vercel:
//   IBKR_GATEWAY_URL = https://abc123.ngrok-free.app
//   IBKR_COOKIE      = (opcional) cookie de sesión del gateway
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

// En local usa localhost, en Vercel usa la variable de entorno
const GATEWAY = process.env.IBKR_GATEWAY_URL ?? 'https://localhost:5000';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Construir path desde el catch-all
  const pathParts = Array.isArray(req.query.path) ? req.query.path : [req.query.path ?? ''];
  const apiPath   = pathParts.join('/');
  const url       = `${GATEWAY}/v1/api/${apiPath}`;

  // Reenviar query params si los hay (excepto 'path' que es interno)
  const params = { ...req.query };
  delete params.path;
  const qs = new URLSearchParams(params as Record<string, string>).toString();
  const fullUrl = qs ? `${url}?${qs}` : url;

  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const upstream = await fetch(fullUrl, {
      method:  req.method ?? 'GET',
      headers: {
        'Content-Type':               'application/json',
        // ✅ Salta la página de advertencia de ngrok (CLAVE)
        'ngrok-skip-browser-warning': 'true',
        'User-Agent':                 'IBKR-Proxy/1.0',
        // Cookie de sesión del gateway
        ...(process.env.IBKR_COOKIE   ? { Cookie: process.env.IBKR_COOKIE }   : {}),
        ...(req.headers.cookie         ? { Cookie: req.headers.cookie }         : {}),
      },
      body: req.method !== 'GET' && req.method !== 'HEAD'
        ? JSON.stringify(req.body)
        : undefined,
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    const text        = await upstream.text();

    // Detectar si ngrok devolvió HTML en lugar de JSON (página de advertencia)
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      res.status(502).json({
        error:  'ngrok devolvió HTML en lugar de JSON',
        detail: 'La página de advertencia de ngrok no fue saltada correctamente.',
        hint:   'Asegúrate de que el header ngrok-skip-browser-warning está llegando al tunnel.',
      });
      return;
    }

    if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        res.status(upstream.status).json(JSON.parse(text));
      } catch {
        res.status(upstream.status).send(text);
      }
    } else {
      res.status(upstream.status).send(text);
    }
  } catch (e: any) {
    res.status(502).json({
      error:   'IBKR Gateway no accesible',
      detail:  e?.message ?? 'Unknown error',
      gateway: GATEWAY,
      hint:    'Verifica que ngrok esté corriendo y IBKR_GATEWAY_URL esté configurado en Vercel',
    });
  }
}