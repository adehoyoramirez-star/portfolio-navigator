// ===============================================
// ARCHIVO: src/core/macro/liquidityCycle.ts
// ===============================================
// ANTES: recibía fedBalance/ecbBalance/bojBalance pero los IGNORABA
//   const fedGrowth = 0.02;  // ← hardcoded, nunca cambiaba
//   const ecbGrowth = 0.01;  // ← hardcoded, nunca cambiaba
// → El régimen de liquidez era SIEMPRE el mismo → señal inútil
//
// AHORA: dos constructores honestos
//   globalLiquiditySignal() → usa datos reales si tienes balances anteriores
//   fromManualInputs()      → usa los inputs del dashboard directamente
//
// Para el dashboard actual, usa fromManualInputs() con liquidityGrowth y dxy.
// Cuando tengas datos de Fed/ECB/BoJ de una API, migra a globalLiquiditySignal().
// ===============================================

export type LiquidityRegime = "EXPANSION" | "NEUTRAL" | "CONTRACTION";

export interface LiquidityOutput {
  liquidityGrowth: number;          // % crecimiento ponderado
  dxyTrend: number;                 // tendencia del dólar como ratio
  regime: LiquidityRegime;
  dataQuality: "REAL" | "MANUAL";  // transparencia sobre la fuente
}

// ==================== CONSTRUCTOR A: DATOS REALES ====================

export interface LiquidityRealInput {
  // Balances actuales de bancos centrales
  fedBalance: number;     // billones USD (ej: 7.2)
  ecbBalance: number;     // billones EUR (ej: 6.8)
  bojBalance: number;     // trillones JPY (ej: 730)
  dxy: number;            // Dollar index actual (ej: 103)

  // Balances del período anterior (para calcular crecimiento real)
  // Sin estos valores, no se puede calcular el crecimiento real
  prevFedBalance: number;
  prevEcbBalance: number;
  prevBojBalance: number;
  prevDxy?: number;       // opcional: si no hay, usa distancia a 100
}

/**
 * Calcula régimen de liquidez global usando datos reales de bancos centrales.
 *
 * Ponderaciones por participación en reservas globales (FMI 2023):
 *   Fed: 50%, ECB: 30%, BoJ: 20%
 *
 * Usar cuando tengas datos históricos de balances (ej: desde FRED API).
 */
export function globalLiquiditySignal(input: LiquidityRealInput): LiquidityOutput {
  // Crecimiento real de cada banco central
  const fedGrowth = input.prevFedBalance > 0
    ? (input.fedBalance - input.prevFedBalance) / input.prevFedBalance
    : 0;

  const ecbGrowth = input.prevEcbBalance > 0
    ? (input.ecbBalance - input.prevEcbBalance) / input.prevEcbBalance
    : 0;

  const bojGrowth = input.prevBojBalance > 0
    ? (input.bojBalance - input.prevBojBalance) / input.prevBojBalance
    : 0;

  // Liquidez global ponderada (en %)
  const liquidityGrowth = (fedGrowth * 0.5 + ecbGrowth * 0.3 + bojGrowth * 0.2) * 100;

  // Tendencia del dólar
  const dxyTrend = input.prevDxy && input.prevDxy > 0
    ? (input.dxy - input.prevDxy) / input.prevDxy
    : (input.dxy - 100) / 100;

  return {
    liquidityGrowth,
    dxyTrend,
    regime: resolveRegime(liquidityGrowth, dxyTrend),
    dataQuality: "REAL",
  };
}

// ==================== CONSTRUCTOR B: INPUTS MANUALES (USO ACTUAL) ====================

export interface LiquidityManualInput {
  liquidityGrowth: number; // % crecimiento — input manual del dashboard
  dxy: number;             // Dollar index — input manual del dashboard
  prevDxy?: number;        // DXY anterior para calcular tendencia real (opcional)
}

/**
 * Calcula régimen de liquidez desde los inputs manuales del dashboard.
 * Más honesto que usar valores hardcodeados — los inputs son reales aunque
 * vengan del usuario y no de una API.
 *
 * Uso en InstitutionalDashboard.tsx:
 *   import { fromManualInputs } from "@/core/macro/liquidityCycle";
 *
 *   const liquidityOutput = useMemo(() =>
 *     fromManualInputs({ liquidityGrowth, dxy }),
 *     [liquidityGrowth, dxy]
 *   );
 *   // Reemplaza el useMemo de liquidityRegime actual
 */
export function fromManualInputs(input: LiquidityManualInput): LiquidityOutput {
  const dxyTrend = input.prevDxy && input.prevDxy > 0
    ? (input.dxy - input.prevDxy) / input.prevDxy
    : (input.dxy - 100) / 100;

  return {
    liquidityGrowth: input.liquidityGrowth,
    dxyTrend,
    regime: resolveRegime(input.liquidityGrowth, dxyTrend),
    dataQuality: "MANUAL",
  };
}

// ==================== LÓGICA DE RÉGIMEN (compartida) ====================

function resolveRegime(liquidityGrowth: number, dxyTrend: number): LiquidityRegime {
  // Expansión: liquidez creciendo Y dólar débil (favorable para activos de riesgo)
  if (liquidityGrowth > 2.5 && dxyTrend < -0.01) return "EXPANSION";
  // Contracción: liquidez cayendo O dólar muy fuerte
  if (liquidityGrowth < 0 || dxyTrend > 0.02) return "CONTRACTION";
  return "NEUTRAL";
}