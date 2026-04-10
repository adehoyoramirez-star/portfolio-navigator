// download-IS3R.cjs
const fs = require('fs');
const https = require('https');

// Yahoo Finance CSV endpoint for IS3R.DE (5 years)
const url = 'https://query1.finance.yahoo.com/v7/finance/download/IS3R.DE?period1=1451606400&period2=1767225600&interval=1d&events=history';

async function download() {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        fs.writeFileSync('IS3R_data.csv', data);
        console.log('Descargado IS3R_data.csv');
        resolve();
      });
    }).on('error', reject);
  });
}

download().catch(console.error);