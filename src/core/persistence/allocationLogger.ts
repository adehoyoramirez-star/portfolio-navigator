// ===============================================
// ARCHIVO: src/core/persistence/allocationLogger.ts
// SPRINT 6: Logging de Allocations + Performance Attribution
// ===============================================

const STORAGE_KEY = "olympus_allocation_history";
const MAX_RECORDS = 500;

export interface AllocationDetail {
  name: string;
  ticker?: string;
  finalAllocation: number;
  momentumScore: number;
  valueScore: number;
  qualityScore: number;
  lowVolScore: number;
  expectedReturn: number;
  kellyFraction: number;
}

export interface AllocationRecord {
  timestamp: string;
  regime: string;
  totalInvested: number;
  totalPortfolioValue: number;
  portfolioDrawdown: number;
  allocations: AllocationDetail[];
  regimePenalty: number;
  coreSignalScore: number;
  volTargetMultiplier: number;
  tailRiskOverlay: number;
  tailRiskActive: boolean;
  tailRiskReason: string;
  metaConfidence: string;
  killSwitchLevel: number;
  engineVersion: string;
  factorWeights: { momentum: number; value: number; quality: number; lowVol: number };
  attribution: AttributionBreakdown;
}

export interface AttributionBreakdown {
  regimeContribution: number;
  factorContribution: number;
  volPenalty: number;
  tailPenalty: number;
  modelQuality: number;
  summary: string;
}

export interface HistoricalPerformance {
  totalRecords: number;
  firstDate: string | null;
  lastDate: string | null;
  avgInvested: number;
  avgVolTarget: number;
  avgTailOverlay: number;
  regimeDistribution: Record<string, number>;
  factorAverage: { momentum: number; value: number; quality: number; lowVol: number };
  recentHistory: AllocationRecord[];
  allocationTrends: { name: string; currentAllocation: number; avgAllocation30d: number; trend: "up" | "down" | "stable"; }[];
}

function loadRecords(): AllocationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecords(records: AllocationRecord[]): void {
  try {
    const trimmed = records.slice(0, MAX_RECORDS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {}
}

function computeAttribution(input: {
  regimePenalty: number;
  coreSignalScore: number;
  volTargetMultiplier: number;
  tailRiskOverlay: number;
  tailRiskActive: boolean;
  metaConfidence: string;
  factorWeights: { momentum: number; value: number; quality: number; lowVol: number };
}): AttributionBreakdown {
  const regimeContribution = Math.min(1, Math.max(0, input.regimePenalty));
  const fw = input.factorWeights;
  const volPenalty = Math.min(1, Math.max(0, input.volTargetMultiplier));
  const tailPenalty = input.tailRiskActive ? Math.min(1, Math.max(0.3, input.tailRiskOverlay)) : 1.0;
  const modelQuality = input.metaConfidence === "HIGH" ? 1.0 : input.metaConfidence === "MEDIUM" ? 0.75 : 0.50;

  const parts: string[] = [];
  if (regimeContribution < 0.6) parts.push("regimen restrictivo (penalty x" + regimeContribution.toFixed(2) + ")");
  else parts.push("regimen benigno (penalty x" + regimeContribution.toFixed(2) + ")");
  if (volPenalty < 0.8) parts.push("vol target reduciendo (x" + volPenalty.toFixed(2) + ")");
  if (tailPenalty < 0.9) parts.push("tail risk activo (x" + tailPenalty.toFixed(2) + ")");
  const factorAvg = (fw.momentum + fw.value + fw.quality + fw.lowVol) / 4;
  var factorDesc = "debiles";
  if (factorAvg > 0.6) factorDesc = "fuertes";
  else if (factorAvg > 0.4) factorDesc = "moderados";
  parts.push("factores " + factorDesc + " (media=" + (factorAvg * 100).toFixed(0) + "%)");

  return {
    regimeContribution: Math.min(1, Math.max(0, regimeContribution)),
    factorContribution: Math.min(1, Math.max(0, (fw.momentum + fw.value + fw.quality + fw.lowVol) / 4)),
    volPenalty, tailPenalty, modelQuality,
    summary: parts.join(" - ")
  };
}

export function recordAllocation(input: {
  regime: string;
  totalInvested: number;
  totalPortfolioValue: number;
  portfolioDrawdown: number;
  allocations: { name: string; ticker?: string; finalAllocation: number; momentumScore: number; valueScore: number; qualityScore: number; lowVolScore: number; expectedReturn: number; kellyFraction: number; }[];
  regimePenalty: number;
  coreSignalScore: number;
  volTargetMultiplier: number;
  tailRiskOverlay: number;
  tailRiskActive: boolean;
  tailRiskReason: string;
  metaConfidence: string;
  killSwitchLevel: number;
  engineVersion: string;
  factorWeights?: { momentum: number; value: number; quality: number; lowVol: number };
}): AllocationRecord {
  const records = loadRecords();
  const defaultWeights = { momentum: 0.25, value: 0.25, quality: 0.25, lowVol: 0.25 };
  const fw = input.factorWeights || defaultWeights;
  const attribution = computeAttribution({
    regimePenalty: input.regimePenalty,
    coreSignalScore: input.coreSignalScore,
    volTargetMultiplier: input.volTargetMultiplier,
    tailRiskOverlay: input.tailRiskOverlay,
    tailRiskActive: input.tailRiskActive,
    metaConfidence: input.metaConfidence,
    factorWeights: fw,
  });
  const record: AllocationRecord = {
    timestamp: new Date().toISOString(),
    regime: input.regime,
    totalInvested: input.totalInvested,
    totalPortfolioValue: input.totalPortfolioValue,
    portfolioDrawdown: input.portfolioDrawdown,
    allocations: input.allocations.map(function(a) { return { name: a.name, ticker: a.ticker, finalAllocation: a.finalAllocation, momentumScore: a.momentumScore, valueScore: a.valueScore, qualityScore: a.qualityScore, lowVolScore: a.lowVolScore, expectedReturn: a.expectedReturn, kellyFraction: a.kellyFraction }; }),
    regimePenalty: input.regimePenalty,
    coreSignalScore: input.coreSignalScore,
    volTargetMultiplier: input.volTargetMultiplier,
    tailRiskOverlay: input.tailRiskOverlay,
    tailRiskActive: input.tailRiskActive,
    tailRiskReason: input.tailRiskReason,
    metaConfidence: input.metaConfidence,
    killSwitchLevel: input.killSwitchLevel,
    engineVersion: input.engineVersion,
    factorWeights: fw,
    attribution: attribution,
  };
  saveRecords([record].concat(records).slice(0, MAX_RECORDS));
  return record;
}

export function getHistoricalPerformance(limit?: number): HistoricalPerformance {
  if (limit === undefined) limit = 30;
  const records = loadRecords();
  if (records.length === 0) {
    return { totalRecords: 0, firstDate: null, lastDate: null, avgInvested: 0, avgVolTarget: 0, avgTailOverlay: 0, regimeDistribution: {}, factorAverage: { momentum: 0, value: 0, quality: 0, lowVol: 0 }, recentHistory: [], allocationTrends: [] };
  }
  const totalRecords = records.length;
  const firstDate = records[records.length - 1].timestamp || null;
  const lastDate = records[0].timestamp || null;
  var sumInv = 0, sumVol = 0, sumTail = 0;
  var sumMom = 0, sumVal = 0, sumQual = 0, sumLow = 0;
  var regimeDist: Record<string, number> = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    sumInv += r.totalInvested;
    sumVol += r.volTargetMultiplier;
    sumTail += r.tailRiskOverlay;
    sumMom += r.factorWeights.momentum;
    sumVal += r.factorWeights.value;
    sumQual += r.factorWeights.quality;
    sumLow += r.factorWeights.lowVol;
    regimeDist[r.regime] = (regimeDist[r.regime] || 0) + 1;
  }
  return {
    totalRecords: totalRecords,
    firstDate: firstDate,
    lastDate: lastDate,
    avgInvested: sumInv / totalRecords,
    avgVolTarget: sumVol / totalRecords,
    avgTailOverlay: sumTail / totalRecords,
    regimeDistribution: regimeDist,
    factorAverage: { momentum: sumMom / totalRecords, value: sumVal / totalRecords, quality: sumQual / totalRecords, lowVol: sumLow / totalRecords },
    recentHistory: records.slice(0, limit),
    allocationTrends: buildAllocationTrends(records),
  };
}

function buildAllocationTrends(records: AllocationRecord[]): { name: string; currentAllocation: number; avgAllocation30d: number; trend: "up" | "down" | "stable"; }[] {
  if (records.length < 2) return [];
  var latest = records[0];
  var window = Math.min(30, records.length);
  var sums: Record<string, { total: number; count: number }> = {};
  for (var i = 0; i < window; i++) {
    for (var j = 0; j < records[i].allocations.length; j++) {
      var alloc = records[i].allocations[j];
      if (!sums[alloc.name]) sums[alloc.name] = { total: 0, count: 0 };
      sums[alloc.name].total += alloc.finalAllocation;
      sums[alloc.name].count += 1;
    }
  }
  var result: { name: string; currentAllocation: number; avgAllocation30d: number; trend: "up" | "down" | "stable"; }[] = [];
  for (var j = 0; j < latest.allocations.length; j++) {
    var alloc = latest.allocations[j];
    var s = sums[alloc.name];
    var avg = s ? s.total / s.count : 0;
    var diff = alloc.finalAllocation - avg;
    var trend: "up" | "down" | "stable" = "stable";
    if (diff > 0.02) trend = "up";
    else if (diff < -0.02) trend = "down";
    result.push({ name: alloc.name, currentAllocation: alloc.finalAllocation, avgAllocation30d: avg, trend: trend });
  }
  return result;
}

export function getAllocationHistory(limit?: number): AllocationRecord[] {
  var records = loadRecords();
  return limit ? records.slice(0, limit) : records;
}

export function clearAllocationHistory(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

export function getAllocationCount(): number {
  return loadRecords().length;
}
