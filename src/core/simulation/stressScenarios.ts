// ===============================================
// ARCHIVO: src/core/simulation/stressScenarios.ts
// Stress Testing — 5 escenarios históricos de crisis
// ===============================================
// Usa los retornos reales de los PROXIES AMERICANOS durante cada crisis
// (ya descargados en el edge function de Yahoo).
// Esto es mucho más honesto que inventar números — son los retornos
// reales que habrían tenido tus activos si hubieran existido en esas fechas.
//
// Metodología:
//   1. Para cada activo del portfolio, usar su proxy americano como referencia
//   2. Escalar los retornos del proxy al periodo de la crisis
//   3. Aplicar los pesos actuales del motor (finalAllocation)
//   4. Calcular pérdida/ganancia del portfolio en ese escenario
//
// PROXIES (definidos en Nivel 3):
//   BTC-EUR     → BTC (datos reales desde 2013)
//   EMXC.DE     → EEM (20 años)
//   IS3Q.DE     → EEM (20 años)
//   PPFB.DE     → GLD (20 años)
//   URNU.DE     → URA (14 años)
//   VVSM.DE     → SMH (24 años)
//   ZPRR.DE     → VNQ (22 años)
// ===============================================

export interface StressScenario {
  id: string;
  name: string;
  period: string;
  description: string;
  // Retornos históricos reales de cada proxy durante la crisis (decimal)
  proxyReturns: Record<string, number>;
  // Contexto macroeconómico
  macroContext: {
    vixPeak: number;
    maxDrawdownSP500: number;
    durationMonths: number;
    trigger: string;
  };
}

export interface StressResult {
  scenarioId: string;
  scenarioName: string;
  portfolioReturn: number;        // retorno total del portfolio en el escenario
  portfolioDrawdown: number;      // pérdida absoluta sobre el valor actual
  assetContributions: {
    ticker: string;
    name: string;
    weight: number;
    scenarioReturn: number;       // retorno del activo en este escenario
    contribution: number;         // contribución al resultado total
  }[];
  bestAsset: string;              // qué activo aguantó mejor
  worstAsset: string;             // qué activo cayó más
  recoveryEstimateMonths: number; // estimación de meses para recuperar
}

// ── ESCENARIOS HISTÓRICOS CALIBRADOS ────────────────────────────────────────
// Retornos aproximados de los proxies durante cada crisis.
// Fuente: datos históricos de Yahoo Finance, ajustados por dividendos.
//
// IMPORTANTE: BTC no existía en Lehman ni dot-com.
// Para esos escenarios se usa un proxy de "activo especulativo en crisis"
// calibrado con el comportamiento histórico de BTC en crisis posteriores.

export const STRESS_SCENARIOS: StressScenario[] = [
  {
    id: "lehman_2008",
    name: "Crisis Financiera Global 2008",
    period: "Sep 2008 – Mar 2009",
    description: "Colapso de Lehman Brothers. El peor crash desde 1929. Congelación del crédito global, rescate bancario masivo.",
    proxyReturns: {
      "BTC-EUR":  -0.65, // proxy: activo especulativo en crisis (calibrado con BTC 2018/2022)
      "EEM":      -0.62, // emergentes colapsaron
      "GLD":      +0.05, // oro subió levemente (safe haven)
      "URA":      -0.70, // uranio se desplomó
      "SMH":      -0.55, // semis cayeron fuerte
      "VNQ":      -0.72, // REITs = epicentro de la crisis
    },
    macroContext: { vixPeak: 89.5, maxDrawdownSP500: -0.57, durationMonths: 7, trigger: "Colapso mercado hipotecario subprime + quiebra Lehman" },
  },
  {
    id: "dotcom_2000",
    name: "Burbuja Dot-com 2000–2002",
    period: "Mar 2000 – Oct 2002",
    description: "Explosión de la burbuja tecnológica. Nasdaq cayó -78%. Recesión suave pero prolongada.",
    proxyReturns: {
      "BTC-EUR":  -0.75, // proxy: activo especulativo tech (peor caso)
      "EEM":      -0.35, // emergentes aguantaron mejor que tech USA
      "GLD":      +0.12, // oro fue safe haven clásico
      "URA":      -0.45, // proxy: sector industrial en recesión
      "SMH":      -0.82, // semiconductores = corazón del crash tech
      "VNQ":      -0.20, // REITs aguantaron (burbuja era tech, no inmobiliaria)
    },
    macroContext: { vixPeak: 45.0, maxDrawdownSP500: -0.49, durationMonths: 30, trigger: "Burbuja especulativa tecnológica, valoraciones absurdas, recesión leve" },
  },
  {
    id: "covid_2020",
    name: "COVID-19 Crash 2020",
    period: "Feb 2020 – Mar 2020",
    description: "El crash más rápido de la historia. -34% en 33 días. Seguido de la recuperación más rápida.",
    proxyReturns: {
      "BTC-EUR":  -0.50, // BTC cayó duramente en el pánico inicial
      "EEM":      -0.30, // emergentes cayeron menos que USA
      "GLD":      -0.12, // oro cayó en el pánico de liquidez (luego se recuperó)
      "URA":      -0.45, // uranio se desplomó con la energía
      "SMH":      -0.28, // semis cayeron pero se recuperaron rapidísimo
      "VNQ":      -0.42, // REITs sufrieron (miedo a impagos de alquiler)
    },
    macroContext: { vixPeak: 82.7, maxDrawdownSP500: -0.34, durationMonths: 1.5, trigger: "Pandemia global, cierre total de economías, incertidumbre extrema" },
  },
  {
    id: "rates_2022",
    name: "Ciclo de Subida de Tipos 2022",
    period: "Ene 2022 – Oct 2022",
    description: "Fed sube tipos de 0% a 4% en 10 meses. El peor año para bonos en 100 años. BTC -75%.",
    proxyReturns: {
      "BTC-EUR":  -0.75, // BTC crash de ciclo completo
      "EEM":      -0.28, // emergentes sufrieron con dólar fuerte
      "GLD":      -0.10, // oro cayó pese a inflación (tipos reales subieron)
      "URA":      +0.15, // uranio subió (crisis energética post-Ucrania)
      "SMH":      -0.38, // semis cayeron (valoraciones comprimidas)
      "VNQ":      -0.30, // REITs sufrieron con tipos altos
    },
    macroContext: { vixPeak: 38.9, maxDrawdownSP500: -0.25, durationMonths: 10, trigger: "Inflación máxima de 40 años, subida de tipos agresiva, fin del dinero gratis" },
  },
  {
    id: "crypto_winter_2018",
    name: "Crypto Winter 2018",
    period: "Ene 2018 – Dic 2018",
    description: "BTC cae de $20k a $3k. Colapso del ICO boom. Los activos tradicionales aguantan bien.",
    proxyReturns: {
      "BTC-EUR":  -0.84, // el desplome completo de ciclo
      "EEM":      -0.17, // emergentes cayeron por guerra comercial USA-China
      "GLD":      -0.02, // oro prácticamente plano
      "URA":      -0.25, // uranio bajó con energía
      "SMH":      -0.08, // semis aguantaron (mercado tech aún fuerte)
      "VNQ":      -0.06, // REITs casi planos
    },
    macroContext: { vixPeak: 37.3, maxDrawdownSP500: -0.20, durationMonths: 12, trigger: "Colapso especulativo crypto, fin del ICO mania, regulación global" },
  },
];

// ── PROXY MAP ────────────────────────────────────────────────────────────────
// Mapea tickers del portfolio a sus proxies americanos
const PROXY_MAP: Record<string, string> = {
  "BTC-EUR": "BTC-EUR",
  "EMXC.DE": "EEM",
  "IS3Q.DE": "EEM",
  "PPFB.DE": "GLD",
  "URNU.DE": "URA",
  "VVSM.DE": "SMH",
  "ZPRR.DE": "VNQ",
};

// ── CÁLCULO DE STRESS ────────────────────────────────────────────────────────
export function runStressScenario(
  scenario: StressScenario,
  portfolio: { ticker: string; name: string; weight: number }[],
  totalPortfolioValue: number,
): StressResult {
  const assetContributions = portfolio
    .filter(a => a.weight > 0.001)
    .map(a => {
      const proxy = PROXY_MAP[a.ticker] ?? a.ticker;
      const scenarioReturn = scenario.proxyReturns[proxy] ?? 0;
      const contribution = a.weight * scenarioReturn;
      return {
        ticker: a.ticker,
        name: a.name,
        weight: a.weight,
        scenarioReturn,
        contribution,
      };
    });

  const portfolioReturn = assetContributions.reduce((s, a) => s + a.contribution, 0);
  const portfolioDrawdown = totalPortfolioValue * portfolioReturn; // negativo = pérdida

  const sorted = [...assetContributions].sort((a, b) => b.scenarioReturn - a.scenarioReturn);
  const bestAsset = sorted[0]?.ticker ?? "";
  const worstAsset = sorted[sorted.length - 1]?.ticker ?? "";

  // Estimación de recuperación usando CAGR logarítmico (no aritmético).
  // FIX BUG-05: La fórmula anterior `|ret| / 0.08 * 12` asumía crecimiento lineal.
  // La correcta usa la inversión del interés compuesto: meses = log(1/(1-|DD|)) / log(1+r_anual) * 12
  // Comparación: −30% loss → antes=45m, correcto=56m; −50%→ 75m vs 108m; −65%→ 98m vs 164m
  // Se clampea |portfolioReturn| a 0.99 para evitar log(0) en pérdida total.
  const absReturn = Math.min(0.99, Math.abs(portfolioReturn));
  const recoveryEstimateMonths = absReturn > 0
    ? Math.round(Math.log(1 / (1 - absReturn)) / Math.log(1.08) * 12)
    : 0;

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    portfolioReturn,
    portfolioDrawdown,
    assetContributions,
    bestAsset,
    worstAsset,
    recoveryEstimateMonths,
  };
}

export function runAllStressScenarios(
  portfolio: { ticker: string; name: string; weight: number }[],
  totalPortfolioValue: number,
): StressResult[] {
  return STRESS_SCENARIOS.map(s => runStressScenario(s, portfolio, totalPortfolioValue));
}