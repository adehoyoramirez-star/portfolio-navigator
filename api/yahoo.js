// api/yahoo.js
// FIXES aplicados:
//   SEC-02: CORS allowlist — ya no wildcard
//   SEC-03: Rate limiting en memoria (60 req/min por IP)
//   SEC-04: Validación de ticker con regex antes de construir URL

// ── CORS ─────────────────────────────────────────────────────────────────────
// Solo permitir peticiones desde dominios propios
const ALLOWED_ORIGINS = [
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  process.env.FRONTEND_URL ?? null,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

function setCORSHeaders(req, res) {
  const origin = req.headers.origin ?? '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Map en memoria: key = IP, value = { count, windowStart }
// Límite: 60 peticiones por minuto por IP
const rateLimitMap = new Map();
const RATE_LIMIT = 60;
const WINDOW_MS  = 60_000; // 1 minuto

function checkRateLimit(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    ?? req.socket?.remoteAddress
    ?? 'unknown';

  const now    = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now - record.windowStart > WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
    res.setHeader('X-RateLimit-Remaining', RATE_LIMIT - 1);
    return true;
  }

  record.count++;
  const remaining = Math.max(0, RATE_LIMIT - record.count);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
  res.setHeader('X-RateLimit-Remaining', remaining);

  if (record.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - record.windowStart)) / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({ error: 'Rate limit exceeded. Try again later.', retryAfter });
    return false;
  }

  return true;
}

// ── INPUT VALIDATION ──────────────────────────────────────────────────────────
// Allowlist de caracteres válidos para un ticker bursátil
// Soporta: AAPL, BTC-EUR, ^VIX (%5EVIX), ZPRR.DE, BZ=F
const TICKER_RE = /^[A-Z0-9.\^%=\-]{1,20}$/i;
const VALID_RANGES    = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const VALID_INTERVALS = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','5d','1wk','1mo','3mo']);

export default async function handler(req, res) {
  setCORSHeaders(req, res);

  // Pre-flight CORS
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Solo GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit
  if (!checkRateLimit(req, res)) return;

  const { ticker, range = '1d', interval = '1d' } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Falta el parámetro ticker' });
  }

  // Validar ticker — prevenir SSRF y path traversal
  const rawTicker = String(ticker);
  if (!TICKER_RE.test(rawTicker)) {
    return res.status(400).json({ error: 'Ticker inválido. Solo se aceptan caracteres alfanuméricos, ., ^, -, =' });
  }
  if (!VALID_RANGES.has(String(range))) {
    return res.status(400).json({ error: `Range inválido. Valores permitidos: ${[...VALID_RANGES].join(', ')}` });
  }
  if (!VALID_INTERVALS.has(String(interval))) {
    return res.status(400).json({ error: `Interval inválido. Valores permitidos: ${[...VALID_INTERVALS].join(', ')}` });
  }

  // Yahoo requiere que los tickers con ^ no estén codificados doblemente
  const cleanTicker = rawTicker.replace(/%5E/gi, '^');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanTicker)}?range=${range}&interval=${interval}`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Vercel Proxy)' }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
      }

      const data = await response.json();
      return res.status(200).json(data);
    } catch (error) {
      attempts++;
      console.error(`Intento ${attempts} falló para ${cleanTicker}:`, error.message);
      if (attempts === maxAttempts) {
        return res.status(500).json({
          error: `No se pudo obtener datos de ${cleanTicker} tras ${maxAttempts} intentos`,
          details: error.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200 * attempts));
    }
  }
}