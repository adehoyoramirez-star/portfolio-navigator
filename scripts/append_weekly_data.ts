// Append weekly data to historical_data_daily_augmented.csv
// Fetches current prices from Yahoo Finance v8 API and appends a new row.
// Run weekly (Friday after market close): npx tsx scripts/append_weekly_data.ts
// The engine (v1.0.0) has NEVER seen data past 2026-04-09 — any appended
// rows are genuinely out-of-sample for paper trading validation.

import fs from 'fs';
import path from 'path';

const CSV_PATH = path.join(process.cwd(), 'historical_data_daily_augmented.csv');

// Tickers in CSV column order (after Date)
const TICKERS = [
  'BTC-EUR', 'EMXC.DE', '0P00000WLG.F', 'PPFB.DE',
  'URNU.DE', 'VVSM.DE', 'XNAS.DE',
  '^VIX', '^TNX', '^IRX', 'HYG', 'LQD', '^MOVE', 'DX-Y.NYB',
];

// Yahoo Finance v8 chart API
async function fetchYahooClose(ticker: string): Promise<number | null> {
  const encoded = encodeURIComponent(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (PaperTrading/1.0)' },
    });
    if (!res.ok) {
      console.warn(`  ${ticker}: HTTP ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) {
      console.warn(`  ${ticker}: no chart data`);
      return null;
    }
    const closes = result.indicators?.quote?.[0]?.close;
    if (!closes || closes.length === 0) {
      console.warn(`  ${ticker}: no close prices`);
      return null;
    }
    // Get last non-null close
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] !== null && closes[i] !== undefined) return closes[i];
    }
    return null;
  } catch (e: any) {
    console.warn(`  ${ticker}: ${e.message}`);
    return null;
  }
}

// Compute BTC_VOL from recent BTC closes in CSV
function computeBtcVol(): number {
  try {
    const content = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = content.trim().split('\n');
    const header = lines[0].split(',');
    const btcIdx = header.indexOf('BTC-EUR');
    if (btcIdx < 0) return 50; // fallback

    // Last 30 rows
    const recent = lines.slice(-31);
    const closes: number[] = [];
    for (const line of recent) {
      const parts = line.split(',');
      const v = parseFloat(parts[btcIdx]);
      if (v > 0) closes.push(v);
    }
    if (closes.length < 20) return 50;

    // Daily returns
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      rets.push(closes[i] / closes[i-1] - 1);
    }
    const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
    const variance = rets.reduce((s,r)=>s+(r-mean)**2,0)/(rets.length - 1);  // sample variance (n-1)
    return Math.sqrt(variance * 365) * 100; // annualized, in %
  } catch {
    return 50;
  }
}

async function main() {
  console.log('OLYMPUS V3+ — Append Weekly Data');
  console.log('='.repeat(50));

  // Check CSV exists
  if (!fs.existsSync(CSV_PATH)) {
    console.error('ERROR: CSV not found at ' + CSV_PATH);
    process.exit(1);
  }

  // Optional --date YYYY-MM-DD to backfill a specific trading day (e.g. missed Friday)
  const dateArgIdx = process.argv.indexOf('--date');
  const overrideDate = dateArgIdx !== -1 && process.argv[dateArgIdx + 1] ? process.argv[dateArgIdx + 1] : null;

  // Weekend guard: markets closed Sat/Sun (skip when explicitly backfilling a date)
  if (!overrideDate) {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log('Weekend — markets closed. Run on Friday (after close) or Monday, or pass --date YYYY-MM-DD to backfill.');
      process.exit(0);
    }
  }

  // Read last row for fallback prices and date check
  const content = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = content.trim().split('\n');
  const lastLine = lines[lines.length-1];
  const lastDate = lastLine.split(',')[0];
  console.log('Last date in CSV: ' + lastDate);
  // Extract previous prices for carry-forward on API failure
  const lastPrices = lastLine.split(',').slice(1, 1 + TICKERS.length).map(Number);

  // Target date in YYYY-MM-DD (today by default, or --date override for backfill)
  const today = overrideDate || new Date().toISOString().split('T')[0];

  // Don't append if today already exists
  if (lastDate === today) {
    console.log('Today (' + today + ') already in CSV. Skipping.');
    process.exit(0);
  }

  console.log('Fetching prices for ' + today + '...');

  // Fetch all tickers
  const prices: (number | null)[] = [];
  for (let i = 0; i < TICKERS.length; i++) {
    const ticker = TICKERS[i];
    process.stdout.write(`  [${i+1}/${TICKERS.length}] ${ticker}... `);
    const price = await fetchYahooClose(ticker);
    if (price !== null) {
      console.log(price.toFixed(2));
    } else {
      console.log('FAILED');
    }
    prices.push(price);
    // Small delay to avoid rate limiting
    if (i < TICKERS.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  // Compute BTC_VOL
  const btcVol = computeBtcVol();
  console.log(`  BTC_VOL (computed): ${btcVol.toFixed(1)}%`);

  // Check if any prices failed — carry forward last known price instead of 0.00
  const failed = TICKERS.filter((_, i) => prices[i] === null);
  if (failed.length > 0) {
    console.log('\n⚠️  WARNING: Could not fetch prices for: ' + failed.join(', '));
    if (failed.length > 3) {
      console.log('Too many failures (' + failed.length + '/' + TICKERS.length + '). Aborting.');
      process.exit(1);
    }
    console.log('Carrying forward last known prices for failed tickers (not 0.00).');
  }

  // Build new row: use fetched price, or carry forward last known price (never 0.00)
  const priceValues = prices.map((p, i) => {
    if (p !== null) return p.toFixed(2);
    const fallback = lastPrices[i];
    return (fallback && fallback > 0 ? fallback : 1.0).toFixed(2);
  });
  const newRow = [today, ...priceValues, btcVol.toFixed(2)];

  // Append to CSV
  const newLine = newRow.join(',');
  fs.appendFileSync(CSV_PATH, '\n' + newLine);

  console.log('\n✅ Row appended to CSV:');
  console.log(newLine);
  console.log('\nCSV now has ' + (lines.length + 1) + ' rows.');
  console.log('\nNext step: run paper trading with fresh data:');
  console.log('  npx tsx scripts/paper_trading.ts');
  console.log('  npx tsx scripts/monitor_v2.ts');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
