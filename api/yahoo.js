// api/yahoo.js
export default async function handler(req, res) {
  // Permitir CORS para todas las peticiones
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { ticker, range = '1d', interval = '1d' } = req.query;

  if (!ticker) {
    return res.status(400).json({ error: 'Falta el parámetro ticker' });
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Yahoo API respondió con estado ${response.status}`);
    }
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Error en proxy:', error);
    res.status(500).json({ error: error.message });
  }
}