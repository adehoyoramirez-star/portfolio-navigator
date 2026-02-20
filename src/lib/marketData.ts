import { supabase } from '@/integrations/supabase/client';
import { ASSETS, MarketData } from './portfolio';

interface YahooChartResult {
  ticker: string;
  currentPrice: number;
  timestamps: number[];
  closes: number[];
}

interface YahooResponse {
  data: Record<string, YahooChartResult>;
  errors: string[];
}

function cleanCloses(closes: number[]): number[] {
  // Remove nulls/NaN and forward-fill
  const clean: number[] = [];
  let last = 0;
  for (const c of closes) {
    if (c != null && isFinite(c)) {
      last = c;
    }
    clean.push(last);
  }
  return clean;
}

function dailyReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      r.push(closes[i] / closes[i - 1] - 1);
    }
  }
  return r;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function covarianceMatrix(returnsSeries: number[][]): number[][] {
  const n = returnsSeries.length;
  // Find minimum length
  const minLen = Math.min(...returnsSeries.map(r => r.length));
  // Trim all to same length (from the end, most recent)
  const trimmed = returnsSeries.map(r => r.slice(r.length - minLen));
  const means = trimmed.map(mean);

  const cov: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let k = 0; k < minLen; k++) {
        s += (trimmed[i][k] - means[i]) * (trimmed[j][k] - means[j]);
      }
      const c = s / (minLen - 1);
      cov[i][j] = c * 252; // annualize
      cov[j][i] = c * 252;
    }
  }
  return cov;
}

export async function fetchRealMarketData(): Promise<{ marketData: MarketData; fetchErrors: string[] }> {
  const { data: response, error } = await supabase.functions.invoke<YahooResponse>('yahoo-finance');

  if (error || !response) {
    throw new Error(`Failed to fetch market data: ${error?.message || 'No response'}`);
  }

  const { data: yfData, errors: fetchErrors } = response;

  // Extract current prices for assets
  const prices: Record<string, number> = {};
  for (const asset of ASSETS) {
    const d = yfData[asset.ticker];
    prices[asset.ticker] = d?.currentPrice ?? 0;
  }

  // VIX data
  const vixData = yfData['^VIX'];
  const vixPrice = vixData?.currentPrice ?? 18;
  const vixCloses = vixData ? cleanCloses(vixData.closes) : [];
  const vixP80 = vixCloses.length > 50 ? percentile(vixCloses, 80) : 28;
  const vixP20 = vixCloses.length > 50 ? percentile(vixCloses, 20) : 14;

  // TNX and IRX
  const tnxPrice = yfData['^TNX']?.currentPrice ?? 4.25;
  const irxPrice = yfData['^IRX']?.currentPrice ?? 3.80;

  // BTC Z-score (200-day)
  const btcData = yfData['BTC-EUR'];
  let btcZScore = 0;
  if (btcData) {
    const btcCloses = cleanCloses(btcData.closes);
    const last200 = btcCloses.slice(-200);
    if (last200.length >= 200) {
      const m = mean(last200);
      const s = std(last200);
      btcZScore = s > 0 ? (btcData.currentPrice - m) / s : 0;
    }
  }

  // Expected returns and covariance from historical data
  const assetReturns: number[][] = ASSETS.map(a => {
    const d = yfData[a.ticker];
    if (!d) return [];
    return dailyReturns(cleanCloses(d.closes));
  });

  const expectedReturns = assetReturns.map(r => {
    if (r.length < 20) return 0.05;
    return mean(r) * 252; // annualize
  });

  const covMatrix = assetReturns.some(r => r.length < 20)
    ? fallbackCovMatrix()
    : covarianceMatrix(assetReturns);

  return {
    marketData: {
      prices,
      vix: vixPrice,
      tnx: tnxPrice,
      irx: irxPrice,
      btcZScore,
      vixPercentile80: vixP80,
      vixPercentile20: vixP20,
      expectedReturns,
      covMatrix,
    },
    fetchErrors,
  };
}

// Fallback if historical data is incomplete
function fallbackCovMatrix(): number[][] {
  const VOLS = [0.60, 0.18, 0.22, 0.15, 0.35, 0.25, 0.16];
  const CORR = [
    [1.00, 0.15, 0.20, 0.05, 0.10, 0.30, 0.10],
    [0.15, 1.00, 0.75, 0.10, 0.15, 0.40, 0.25],
    [0.20, 0.75, 1.00, 0.10, 0.15, 0.45, 0.20],
    [0.05, 0.10, 0.10, 1.00, 0.05, 0.05, 0.15],
    [0.10, 0.15, 0.15, 0.05, 1.00, 0.20, 0.10],
    [0.30, 0.40, 0.45, 0.05, 0.20, 1.00, 0.15],
    [0.10, 0.25, 0.20, 0.15, 0.10, 0.15, 1.00],
  ];
  return CORR.map((row, i) => row.map((c, j) => c * VOLS[i] * VOLS[j]));
}
