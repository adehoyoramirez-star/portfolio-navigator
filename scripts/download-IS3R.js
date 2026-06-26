const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');
const path = require('path');

async function download() {
  const result = await yahooFinance.historical('IS3R.DE', {
    period1: '2015-01-01',
    interval: '1d'
  });
  const lines = ['Date,IS3R.DE'];
  for (const row of result) {
    lines.push(`${row.date.toISOString().split('T')[0]},${row.close}`);
  }
  fs.writeFileSync('IS3R_data.csv', lines.join('\n'));
  console.log('Descargado');
}
download();