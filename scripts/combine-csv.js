// combine-csv.cjs
const fs = require('fs');
const path = require('path');

const MAIN_CSV = 'historical_data_daily.csv';
const NEW_CSV = 'IS3R_data.csv';
const OUTPUT_CSV = 'historical_data_daily_with_IS3R.csv';

// Leer CSV principal
const mainContent = fs.readFileSync(MAIN_CSV, 'utf8');
const mainLines = mainContent.trim().split('\n');
const mainHeaders = mainLines[0].split(',');

// Leer CSV de IS3R
const is3rContent = fs.readFileSync(NEW_CSV, 'utf8');
const is3rLines = is3rContent.trim().split('\n');
const is3rMap = new Map();

for (let i = 1; i < is3rLines.length; i++) {
  const line = is3rLines[i];
  if (!line) continue;
  const [date, price] = line.split(',');
  if (date && price) {
    const p = parseFloat(price);
    if (!isNaN(p)) is3rMap.set(date.trim(), p);
  }
}
console.log(`Cargados ${is3rMap.size} precios de IS3R.DE`);

const newHeaders = [...mainHeaders, 'IS3R.DE'];
const outputLines = [newHeaders.join(',')];
let lastPrice = null;
let missing = 0;

for (let i = 1; i < mainLines.length; i++) {
  const line = mainLines[i].trim();
  if (!line) continue;
  const parts = line.split(',');
  if (parts.length < mainHeaders.length) continue;
  const date = parts[0];
  let price = is3rMap.get(date);
  if (price === undefined) {
    price = lastPrice !== null ? lastPrice : '';
    missing++;
  } else {
    lastPrice = price;
  }
  const newRow = [...parts, price !== '' ? price : ''];
  outputLines.push(newRow.join(','));
}

fs.writeFileSync(OUTPUT_CSV, outputLines.join('\n'));
console.log(`Combinado guardado en ${OUTPUT_CSV} (faltan ${missing} fechas, rellenadas con forward fill)`);