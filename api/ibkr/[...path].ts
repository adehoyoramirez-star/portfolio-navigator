// api/ibkr/[...path].ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

// La URL de tu túnel ngrok debe estar en las variables de entorno de Vercel
const GATEWAY_URL = process.env.IBKR_GATEWAY_URL;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verificar que la URL del gateway esté configurada
  if (!GATEWAY_URL) {
    console.error('IBKR_GATEWAY_URL no está definida en las variables de entorno');
    return res.status(500).json({ error: 'IBKR_GATEWAY_URL missing in environment' });
  }

  // Reconstruir el path original (todo lo que venga después de /api/ibkr/)
  const path = (req.query.path as string[]) || [];
  const apiPath = path.join('/');

  // Construir URL completa hacia el túnel ngrok
  const url = `${GATEWAY_URL}/v1/api/${apiPath}`;

  // Pasar los query parameters (excepto "path")
  const params = new URLSearchParams();
  Object.entries(req.query).forEach(([key, value]) => {
    if (key !== 'path') {
      params.append(key, String(value));
    }
  });
  const fullUrl = params.toString() ? `${url}?${params.toString()}` : url;

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        // IBKR requiere este header para evitar advertencias de ngrok
        'ngrok-skip-browser-warning': 'true',
        // Pasar cookies de sesión si las hay
        ...(req.headers.cookie && { Cookie: req.headers.cookie }),
      },
    };

    // Incluir body solo para métodos que lo permiten
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(fullUrl, fetchOptions);

    // Reenviar cookies de vuelta al cliente (importante para mantener la sesión)
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      res.setHeader('Set-Cookie', setCookie);
    }

    // Obtener respuesta como texto
    const text = await response.text();

    // Intentar parsear como JSON, si falla devolver texto plano
    res.status(response.status);
    try {
      res.json(JSON.parse(text));
    } catch {
      res.send(text);
    }
  } catch (err: any) {
    console.error('Error en proxy IBKR:', err);
    res.status(502).json({
      error: 'IBKR gateway unreachable',
      detail: err.message,
    });
  }
}