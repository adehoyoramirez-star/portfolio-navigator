// run-backtest-tactical.ts
// Backtest walk-forward del motor tactico Olympus (COMPLETO)
// No requiere Supabase -- solo datos CSV historicos
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
  exitDay:      number;
  exitPrice:    number;
  pnl:          number;
  pnlPct:       number;
  daysHeld:     number;
  exitReason:   string;
}

interface DayRow {
  date: string;
  asset: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BacktestRegimeState {
  regime: 'BULL' | 'BEAR' | 'SIDEWAYS' | 'HIGH_VOL';
  vixLevel: number;
}

// Activos representativos para el backtest
const ASSETS = ['IS3Q.DE', 'EUNL.DE', 'LYX0Q.DE', 'BTC-USD', 'ETH-USD', 'PPFB.PA', 'EMXC', 'VVSM.DE', 'XNAS.DE', 'GLD', 'IEF', 'TLT', 'HYG', 'LQD', 'EEM', 'VWO', 'VNQ', 'GSG', 'DBC', 'XLF', 'XLE', 'XLK', 'XLV'];

function detectBacktestRegime(closes: list[float], vix: float): dict {
  if not closes or len(closes) < 50:
    return {'regime': 'BULL', 'vixLevel': 15}
