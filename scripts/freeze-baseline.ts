// ============================================================
// scripts/freeze-baseline.ts
// FASE 0 — Congela el baseline del motor (runBacktest) a un JSON.
// Ejecutar: npx tsx scripts/freeze-baseline.ts
// ============================================================
import fs from "fs";
import path from "path";
import { runBacktest } from "../src/core/backtest/backtestEngine";
import { snapshotFromBacktest } from "../src/core/validation/baseline";
import { ASSETS } from "../src/lib/constants";

const csvPath = path.join(process.cwd(), "historical_data_daily_augmented.csv");
const csvContent = fs.readFileSync(csvPath, "utf8");
const lines = csvContent.split("\n");
const headers = lines[0].split(",");

const closesHistory: Record<string, number[]> = {};
for (const a of ASSETS) closesHistory[a] = [];
const vixArr: number[] = [], tnxArr: number[] = [], irxArr: number[] = [], hygArr: number[] = [], lqdArr: number[] = [];
const moveArr: number[] = [], dxyArr: number[] = [], btcVolArr: number[] = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  const parts = line.split(",");
  if (parts.length < headers.length) continue;
  for (const ticker of ASSETS) {
    const idx = headers.indexOf(ticker);
    if (idx !== -1) closesHistory[ticker].push(parseFloat(parts[idx]) || 0);
  }
  const vi = headers.indexOf("^VIX");   if (vi !== -1) vixArr.push(parseFloat(parts[vi]) || 0);
  const ti = headers.indexOf("^TNX");   if (ti !== -1) tnxArr.push(parseFloat(parts[ti]) || 0);
  const ii = headers.indexOf("^IRX");   if (ii !== -1) irxArr.push(parseFloat(parts[ii]) || 0);
  const hi = headers.indexOf("HYG");    if (hi !== -1) hygArr.push(parseFloat(parts[hi]) || 0);
  const li = headers.indexOf("LQD");    if (li !== -1) lqdArr.push(parseFloat(parts[li]) || 0);
  const mi = headers.indexOf("^MOVE");  if (mi !== -1) moveArr.push(parseFloat(parts[mi]) || 95);
  const di = headers.indexOf("DX-Y.NYB"); if (di !== -1) dxyArr.push(parseFloat(parts[di]) || 103);
  const bi = headers.indexOf("BTC_VOL"); if (bi !== -1) btcVolArr.push(parseFloat(parts[bi]) || 30);
}

const minLen = Math.min(...ASSETS.map(t => closesHistory[t].length), vixArr.length, tnxArr.length, irxArr.length, moveArr.length, dxyArr.length, btcVolArr.length);
for (const t of ASSETS) closesHistory[t] = closesHistory[t].slice(0, minLen);
const vix = vixArr.slice(0, minLen), tnx = tnxArr.slice(0, minLen), irx = irxArr.slice(0, minLen);
const hyg = hygArr.slice(0, minLen), lqd = lqdArr.slice(0, minLen);
const move = moveArr.slice(0, minLen), dxy = dxyArr.slice(0, minLen), btcVol = btcVolArr.slice(0, minLen);

const yieldSpread = tnx.map((v, i) => v - irx[i]);
const creditSpread = hyg.map((v, i) => {
  if (v > 0 && lqd[i] > 0) {
    const hygYield = 0.045 + (1 - v / 100) * 0.03;
    const lqdYield = 0.035 + (1 - lqd[i] / 100) * 0.02;
    return Math.max(1.0, Math.min(9.0, (hygYield - lqdYield) * 100));
  }
  return 2.5 + vix[i] / 20;
});
const dxyTrend: number[] = [];
for (let i = 0; i < minLen; i++) {
  if (i < 20) { dxyTrend.push(0); continue; }
  const prev = dxy[i - 20], curr = dxy[i];
  dxyTrend.push(prev > 0 ? ((curr - prev) / prev) * 100 : 0);
}

const label = process.argv[2] ?? "baseline v5.x (post-auditoría forense)";
const output = runBacktest({
  closesHistory,
  macroHistory: { vix, yieldSpread, creditSpread, move, dxyTrend, btcVol },
  lookbackDays: 252,
  rebalanceDays: 21,
  initialCapital: 10_000,
  transactionCostBps: 15,
});
const snapshot = snapshotFromBacktest(output, label);
fs.writeFileSync("validation_baseline.json", JSON.stringify(snapshot, null, 2), "utf8");
console.log("[freeze-baseline] baseline congelado en validation_baseline.json");
console.log(`  label=${label}`);
console.log(`  returnsSignature=${snapshot.returnsSignature}`);
console.log(`  CAGR=${(snapshot.metrics.cagr * 100).toFixed(2)}% Sharpe=${snapshot.metrics.sharpe.toFixed(3)} MaxDD=${(snapshot.metrics.maxDrawdown * 100).toFixed(1)}% PF=${snapshot.metrics.profitFactor.toFixed(2)}`);
