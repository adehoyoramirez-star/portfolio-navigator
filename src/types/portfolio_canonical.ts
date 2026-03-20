// ===============================================
// ARCHIVO CANÓNICO: src/core/types/portfolio.ts
// ===============================================
// FIX ARCH-02 (S2-5): Consolida los dos archivos portfolio.ts duplicados:
//   - src/data/portfolio.ts       → tenía "Gold Mining" y "Small Cap US"
//   - src/core/data/portfolio.ts  → tenía "Gold (ETC)" y "US REITs"
//
// DECISIÓN: el TICKER es el identificador primario en toda la codebase.
// El campo `name` es solo para UI — nunca usar para matching de lógica.
//
// Nombres definitivos elegidos: los del src/core/data/portfolio.ts
// (más precisos: "Gold (ETC)" es correcto para PPFB.DE que es un ETC físico,
//  "US REITs" es correcto para ZPRR.DE que replica el índice FTSE NAREIT)
//
// MIGRACIÓN: reemplazar todos los imports de:
//   import { ... } from "@/data/portfolio"       → "@/core/types/portfolio"
//   import { ... } from "@/core/data/portfolio"  → "@/core/types/portfolio"
// ===============================================

// ── INTERFACES ────────────────────────────────────────────────────────────────

export interface Asset {
  ticker: string;         // Identificador primario — NUNCA usar `name` para matching
  name: string;           // Solo para UI — puede cambiar sin afectar lógica
  weight: number;         // Peso objetivo (%)
  currentWeight: number;  // Peso actual en portfolio real (%)
  price: number;          // Precio actual en EUR
  shares: number;         // Número de participaciones/unidades
  avgPrice: number;       // Precio medio de compra en EUR
  volatility: number;     // Volatilidad anualizada (%)
  expectedReturn: number; // Retorno esperado anualizado (%)
  sector: string;         // Sector para risk budgeting
  history: number[];      // Historial de precios de cierre (para indicadores)
  zScore?: number;        // Z-score calculado (opcional — se actualiza con datos reales)
  rsi?: number;           // RSI calculado (opcional — se actualiza con datos reales)
}

export interface Portfolio {
  totalValue: number;
  cashReserve: number;
  monthlyInjection: number;
  targetGoal: number;
  regime: "ATTACK" | "NEUTRAL" | "RISK_OFF";
  riskFreeRate: number;
  expectedVolatility: number;
  assets: Asset[];
}

// ── HELPER: generador de historial mock ──────────────────────────────────────
// Solo se usa como fallback cuando no hay datos reales de Yahoo Finance.
// Con datos reales, el historial se reemplaza por closesHistory de marketData.
const generateMockHistory = (basePrice: number): number[] =>
  Array.from({ length: 30 }, (_, index) => {
    const randomShock = (Math.random() - 0.5) * 0.02;
    const trend = index * 0.001;
    return basePrice * (1 + trend + randomShock);
  });

// ── PORTFOLIO INICIAL ────────────────────────────────────────────────────────
// Valores por defecto — se sobreescriben con datos reales de Supabase + Yahoo Finance.
// El ticker es la fuente de verdad: PPFB.DE = Gold ETC físico, ZPRR.DE = US REITs.
export const portfolio: Portfolio = {
  totalValue: 5685,
  cashReserve: 150.00,
  monthlyInjection: 400.0,
  targetGoal: 150000,
  regime: "ATTACK",
  riskFreeRate: 4.0,
  expectedVolatility: 24.2,

  assets: [
    {
      ticker: "BTC-EUR",
      name: "Bitcoin",
      weight: 23.9,
      currentWeight: 9.2,
      shares: 0.033994,
      avgPrice: 85386.00,
      price: 55134.37,
      volatility: 60,
      expectedReturn: 15,   // AUDIT-FIX: era 45% (bull run) → 15% (prior LP Damodaran 2024)
      sector: "Crypto",
      zScore: -2.08,
      rsi: 40.51,
      history: generateMockHistory(55134),
    },
    {
      ticker: "VVSM.DE",
      name: "Semiconductors",
      weight: 12.5,
      currentWeight: 9.1,
      shares: 2,
      avgPrice: 52.01,
      price: 62.60,
      volatility: 35,
      expectedReturn: 14,   // AUDIT-FIX: era 18% → 14% (ciclo AI, valoración alta)
      sector: "Technology",
      history: generateMockHistory(62.60),
    },
    {
      ticker: "IS3Q.DE",
      name: "MSCI World Momentum",
      weight: 20.0,
      currentWeight: 26.6,
      shares: 26,
      avgPrice: 67.53,
      price: 70.62,
      volatility: 18,
      expectedReturn: 11,   // AUDIT-FIX: era 12% → 11% (prima momentum ~3% sobre mercado)
      sector: "Equity",
      history: generateMockHistory(70.62),
    },
    {
      ticker: "URNU.DE",
      name: "Uranium",
      weight: 15.0,
      currentWeight: 15.5,
      shares: 15,
      avgPrice: 26.53,
      price: 28.15,
      volatility: 40,
      expectedReturn: 10,   // AUDIT-FIX: era 25% → 10% (uranio, demanda nuclear pero ilíquido)
      sector: "Energy",
      history: generateMockHistory(28.15),
    },
    {
      ticker: "EMXC.DE",
      name: "Emerging Markets",
      weight: 10.0,
      currentWeight: 10.0,
      shares: 31,
      avgPrice: 28.93,
      price: 35.56,
      volatility: 22,
      expectedReturn: 10,
      sector: "Emerging",
      history: generateMockHistory(35.56),
    },
    {
      ticker: "PPFB.DE",
      // FIX ARCH-02: nombre canónico "Gold (ETC)" — es un ETC físico, no mineras
      // src/data/portfolio.ts tenía "Gold Mining" — INCORRECTO para PPFB.DE
      name: "Gold (ETC)",
      weight: 10.0,
      currentWeight: 5.0,
      shares: 4,
      avgPrice: 69.39,
      price: 72.10,
      volatility: 30,
      expectedReturn: 6,    // AUDIT-FIX: era 15% → 6% (retorno real histórico oro ~2-4%)
      sector: "Commodities",
      history: generateMockHistory(72.10),
    },
    {
      ticker: "ZPRR.DE",
      // FIX ARCH-02: nombre canónico "US REITs" — replica FTSE NAREIT
      // src/data/portfolio.ts tenía "Small Cap US" — INCORRECTO para ZPRR.DE
      name: "US REITs",
      weight: 8.6,
      currentWeight: 10.6,
      shares: 6,
      avgPrice: 61.67,
      price: 65.40,
      volatility: 25,
      expectedReturn: 9,    // AUDIT-FIX: era 11% → 9% (ajustado tipos altos)
      sector: "Real Estate",
      history: generateMockHistory(65.40),
    },
  ],
};

// ── RE-EXPORTS para compatibilidad durante migración ─────────────────────────
// Permite que imports antiguos sigan funcionando mientras se migran uno a uno.
// Una vez migrados todos los archivos, eliminar estos re-exports.
export default portfolio;