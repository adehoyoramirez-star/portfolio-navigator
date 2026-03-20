// api/yahoo-quote.js
// FIXES aplicados:
//   SEC-02: CORS allowlist — ya no wildcard
//   SEC-03: Rate limiting en memoria (60 req/min por IP)
//   SEC-04: Validación de ticker con regex antes de construir URL

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

// ── INPUT VALIDATION ──────────────────────────────────────────────────────────
const TICKER_RE = /^[A-Z0-9.\^%=\-]{1,20}$/i;
// Módulos de quoteSummary permitidos (allowlist explícita)
const VALID_MODULES = new Set([
  'summaryDetail', 'defaultKeyStatistics', 'financialData', 'price',
  'calendarEvents', 'earnings', 'balanceSheetHistory', 'cashflowStatementHistory',
  'incomeStatementHistory', 'recommendationTrend', 'assetProfile',
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

  const { ticker, module: mod = 'summaryDetail' } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Falta el parámetro ticker' });
  }

  // Validar ticker
  const rawTicker = String(ticker);
  if (!TICKER_RE.test(rawTicker)) {
    return res.status(400).json({ error: 'Ticker inválido. Solo se aceptan caracteres alfanuméricos, ., ^, -, =' });
  }

  // Validar módulo — previene inyección de módulos arbitrarios
  const rawMod = String(mod);
  if (!VALID_MODULES.has(rawMod)) {
    return res.status(400).json({
      error: `Módulo no permitido: ${rawMod}`,
      allowed: [...VALID_MODULES],
    });
  }

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(rawTicker)}?modules=${rawMod}`;

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
      console.error(`Intento ${attempts} falló para ${rawTicker}:`, error.message);
      if (attempts === maxAttempts) {
        return res.status(500).json({
          error: `No se pudo obtener datos de ${rawTicker} tras ${maxAttempts} intentos`,
          details: error.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200 * attempts));
    }
  }
}