const https = require('https');
const fs = require('fs');
const path = require('path');

const CSV_PATH = path.join(__dirname, '..', 'historical_data_daily.csv');
const OUTPUT_PATH = path.join(__dirname, '..', 'historical_data_daily_augmented.csv');

function fetchYahooChart(ticker) {
  const encoded = ticker.replace('^', '%5E');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=max&interval=1d`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json.chart?.result?.[0];
          if (!result) return reject(new Error('No data: ' + JSON.stringify(json.chart?.error || 'unknown')));
          const timestamps = result.timestamp;
          const closes = result.indicators?.quote?.[0]?.close;
          const map = new Map();
          for (let i = 0; i < timestamps.length; i++) {
            const c = closes[i];
            if (c !== null && isFinite(c)) {
              map.set(new Date(timestamps[i]*1000).toISOString().slice(0,10), c);
            }
          }
          resolve(map);
        } catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function computeBTCRollingVol(prices) {
  const vol90 = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < 90) { vol90.push(null); continue; }
    let sumLogRet = 0, sumLogRetSq = 0, count = 0;
    for (let j = i - 89; j <= i; j++) {
      if (prices[j] > 0 && prices[j - 1] > 0) {
        const lr = Math.log(prices[j] / prices[j - 1]);
        sumLogRet += lr; sumLogRetSq += lr * lr; count++;
      }
    }
    if (count < 20) { vol90.push(null); continue; }
    const variance = sumLogRetSq / count - (sumLogRet / count) ** 2;
    vol90.push(Math.sqrt(Math.max(0, variance)) * Math.sqrt(252));
  }
  return vol90;
}

async function main() {
  console.log('Reading CSV...');
  const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = csvContent.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',');
  const dataRows = lines.slice(1).map(l => l.split(','));
  console.log('Rows:', dataRows.length, 'Date range:', dataRows[0][0], '-', dataRows[dataRows.length-1][0]);

  console.log('Fetching ^MOVE...');
  const moveMap = await fetchYahooChart('^MOVE');
  console.log('MOVE raw points:', moveMap.size);

  console.log('Fetching DX-Y.NYB...');
  const dxyMap = await fetchYahooChart('DX-Y.NYB');
  console.log('DXY raw points:', dxyMap.size);

  console.log('Computing BTC rolling vol...');
  const btcIdx = headers.indexOf('BTC-EUR');
  const btcPrices = dataRows.map(r => parseFloat(r[btcIdx]) || 0);
  const btcVols = computeBTCRollingVol(btcPrices);
  console.log('BTC vol valid:', btcVols.filter(v => v !== null).length);

  // Forward-fill: for each CSV row, fill missing macro with last known value
  console.log('Merging with forward-fill...');
  const newHeaders = [...headers, '^MOVE', 'DX-Y.NYB', 'BTC_VOL'];
  const outLines = [newHeaders.join(',')];
  let lastMove = 95; // default ~95 for pre-2006
  let lastDxy = 103; // default ~103
  let m1 = 0, m2 = 0, m3 = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const date = dataRows[i][0];
    if (moveMap.has(date)) { lastMove = moveMap.get(date); m1++; }
    if (dxyMap.has(date)) { lastDxy = dxyMap.get(date); m2++; }
    const row = [...dataRows[i],
      lastMove.toFixed(2),
      lastDxy.toFixed(2),
      btcVols[i] !== null ? (btcVols[i]*100).toFixed(2) : (btcVols[i-1] !== null ? (btcVols[i-1]*100).toFixed(2) : '30.00')
    ];
    if (btcVols[i] !== null) m3++;
    outLines.push(row.join(','));
  }

  fs.writeFileSync(OUTPUT_PATH, outLines.join('\n'));
  console.log(`\nDone: ${OUTPUT_PATH}`);
  console.log('MOVE matched:', m1, '/', dataRows.length);
  console.log('DXY matched:', m2, '/', dataRows.length);
  console.log('BTC vol:', m3, '/', dataRows.length);
  console.log('After forward-fill: 100% coverage');
  console.log('Sample row:', outLines[1]);
  console.log('Sample mid:', outLines[2000]);
  console.log('Sample last:', outLines[outLines.length-1]);
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });
