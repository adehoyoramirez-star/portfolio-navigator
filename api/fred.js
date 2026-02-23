// api/fred.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { series_id = 'M2SL' } = req.query;
  const API_KEY = process.env.FRED_API_KEY; // La clave se leerá de las variables de entorno

  if (!API_KEY) {
    return res.status(500).json({ error: 'FRED_API_KEY no configurada' });
  }

  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series_id}&api_key=${API_KEY}&file_type=json&sort_order=desc&limit=2`;

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
      console.error(`Intento ${attempts} falló para FRED:`, error.message);
      if (attempts === maxAttempts) {
        return res.status(500).json({
          error: `No se pudo obtener datos de FRED tras ${maxAttempts} intentos`,
          details: error.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200 * attempts));
    }
  }
}// api/fred.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { series_id = 'M2SL' } = req.query;
  const API_KEY = process.env.FRED_API_KEY; // La clave se leerá de las variables de entorno

  if (!API_KEY) {
    return res.status(500).json({ error: 'FRED_API_KEY no configurada' });
  }

  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series_id}&api_key=${API_KEY}&file_type=json&sort_order=desc&limit=2`;

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
      console.error(`Intento ${attempts} falló para FRED:`, error.message);
      if (attempts === maxAttempts) {
        return res.status(500).json({
          error: `No se pudo obtener datos de FRED tras ${maxAttempts} intentos`,
          details: error.message
        });
      }
      await new Promise(resolve => setTimeout(resolve, 200 * attempts));
    }
  }
}