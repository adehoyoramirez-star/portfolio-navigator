// run-backtest-tactical.ts
// Backtest walk-forward del motor tactico Olympus
// No requiere Supabase — solo datos CSV historicos
// Ejecutar: npx tsx run-backtest-tactical.ts

import fs from 'fs';
import path from 'path';

import { calcIndicators, generateSignals, calcTotalScore, calcStopLoss, calcTakeProfits, calcDynamicMaxDays } from './src/core/tactical/tacticalSignals.ts';
import type { OpportunityType, TechnicalIndicators } from './src/core/tactical/types.ts';

const CONFIG = {
  initialCapital:       10_000,
  riskPerTradePct:      0.01,
  maxCapitalPerTrade:   0.30,
  maxOpenPositions:     4,
  minScore:             38,
  minRiskReward:        1.3,
  trailingStop:         true,
};

interface BacktestPosition {
  ticker:       string;
  assetType:    string;
  entryDay:     number;
  entryPrice:   number;
  shares:       number;
  invested:     number;
  stopLoss:     number;
  takeProfit1:  number;
  takeProfit2:  number;
  atr:          number;
  maxDays:      number;
  signalType:   OpportunityType;
  score:        number;
  status:       'OPEN' | 'CLOSED_TP' | 'CLOSED_SL' | 'CLOSED_TIME';
  exitDay?:     number;
  exitPrice?:   number;
  pnl?:         number;
  pnlPct?:      number;
}

const CSV_PATH = path.join(process.cwd(), 'historical_data_daily.csv');
const csvRaw = fs.readFileSync(CSV_PATH, 'utf8');
const lines = csvRaw.split('
').filter(l => l.trim());
const headers = lines[0].split(',');

const ASSETS = ['BTC-EUR', 'EMXC.DE', 'IS3Q.DE', 'PPFB.DE', 'URNU.DE', 'VVSM.DE', 'XNAS.DE'];
const VIX_COL = '^VIX';

const TICKER_TYPES: Record<string, string> = {
  'BTC-EUR': 'CRYPTO', 'EMXC.DE': 'ETF', 'IS3Q.DE': 'ETF',
  'PPFB.DE': 'ETC',    'URNU.DE': 'ETF', 'VVSM.DE': 'ETF',
  'XNAS.DE': 'ETF',
};

interface BacktestDay {
  day:      number;
  date:     string;
  prices:   Record<string, number>;
  vix:      number;
}

const days: BacktestDay[] = [];
const priceHistory: Record<string, number[]> = {};
for (const a of ASSETS) priceHistory[a] = [];

for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split(',');
  if (parts.length < headers.length) continue;
  const date = parts[0];
  const vix = parseFloat(parts[headers.indexOf(VIX_COL)]) || 20;
  const prices: Record<string, number> = {};
  let validCount = 0;
  for (const a of ASSETS) {
    const idx = headers.indexOf(a);
    if (idx === -1) continue;
    const val = parseFloat(parts[idx]);
    if (isNaN(val) || val <= 0) continue;
    prices[a] = val;
    priceHistory[a].push(val);
    validCount++;
  }
  if (validCount === ASSETS.length) {
    days.push({ day: days.length, date, prices, vix });
  }
}

console.log('Datos cargados: ' + days.length + ' dias (' + days[0]?.date + ' -> ' + days[days.length - 1]?.date + ')');
