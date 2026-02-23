export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { ticker, module = 'summaryDetail' } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Falta el parámetro ticker' });
  }

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${module}`;

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
      console.error(`Intento ${attempts} falló para ${ticker}:`, error.message);
      if (attempts === maxAttempts) {
        return res.status(500).json({
          error: `No se pudo obtener datos de ${ticker} tras ${maxAttempts} intentos`,
          details: error.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200 * attempts));
    }
  }
}