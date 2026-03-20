// api/fred.js
// FIXES aplicados:
//   SEC-02: CORS allowlist — ya no wildcard
//   SEC-03: Rate limiting en memoria (60 req/min por IP)
//   SEC-04: Allowlist explícita de series FRED permitidas

// ── CORS ─────────────────────────────────────────────────────────────────────
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
const rateLimitMap = new Map();
const RATE_LIMIT = 60;
const WINDOW_MS  = 60_000;

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

// ── SERIES ALLOWLIST ──────────────────────────────────────────────────────────
// Allowlist explícita — previene SSRF: ninguna serie fuera de esta lista
// puede usarse para hacer peticiones a la API de FRED a través de este proxy.
const FRED_SERIES_ALLOWLIST = new Set([
  'M2SL',       // M2 Money Supply USA
  'WALCL',      // Fed Balance Sheet (Total Assets)
  'ECBASSETSW', // ECB Balance Sheet
  'CAPE',       // Shiller CAPE (PER ajustado ciclo)
  'DGS10',      // US 10-Year Treasury Yield
  'DGS2',       // US 2-Year Treasury Yield
  'T10Y2Y',     // 10Y-2Y Yield Spread
  'BAMLH0A0HYM2', // HY Credit Spread (OAS)
  'DEXUSEU',    // USD/EUR Exchange Rate
]);

export default async function handler(req, res) {
  setCORSHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limit
  if (!checkRateLimit(req, res)) return;

  const { series_id = 'M2SL' } = req.query;
  const API_KEY = process.env.FRED_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: 'FRED_API_KEY no configurada' });
  }

  // Validar series_id contra allowlist — previene SSRF
  const cleanSeriesId = String(series_id).trim().toUpperCase();
  if (!FRED_SERIES_ALLOWLIST.has(cleanSeriesId)) {
    return res.status(400).json({
      error: `Serie FRED no permitida: ${cleanSeriesId}`,
      allowed: [...FRED_SERIES_ALLOWLIST],
    });
  }

  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${cleanSeriesId}&api_key=${API_KEY}&file_type=json&sort_order=desc&limit=2`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
      }
      const data = await response.json();
      return res.status(200).json(data);
    } catch (error) {
      attempts++;
      console.error(`Intento ${attempts} falló para FRED ${cleanSeriesId}:`, error.message);
      if (attempts === maxAttempts) {
        return res.status(500).json({ error: error.message });
      }
      await new Promise(resolve => setTimeout(resolve, 200 * attempts));
    }
  }
}