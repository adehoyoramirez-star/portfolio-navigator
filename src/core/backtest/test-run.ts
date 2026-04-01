// --- ARCHIVO: src/core/backtest/test-run.ts ---
import { runBacktest } from "./backtestEngine.ts";

const generatePanicHistory = () => {
  const data: number[] = [];
  let price = 100;
  
  // 1. 50 días de subida constante (EXPANSIÓN)
  for (let i = 0; i < 50; i++) {
    price *= 1.005; 
    data.push(price);
  }
  
  // 2. 50 días de VOLATILIDAD EXTREMA (CRISIS)
  // Metemos saltos bruscos para engañar al "VIX Local" de tu código
  for (let i = 0; i < 50; i++) {
    const pánico = i % 2 === 0 ? 0.92 : 1.05; // Un día cae 8%, otro rebota 5%
    price *= pánico;
    data.push(price);
  }
  return data;
};

const history = generatePanicHistory();

const mockHistory: Record<string, number[]> = {
  'IS3Q.DE': history, 
  'BTC-EUR': history,
  'EMXC.DE': history,
  'PPFB.DE': history,
  'URNU.DE': history,
  'VVSM.DE': history,
  'ZPRR.DE': history,
};

const input = {
  closesHistory: mockHistory,
  macro: { vix: 18, creditSpread: 0.5 },
  lookbackDays: 10,   // Ventana corta para que reaccione rápido al pánico
  rebalanceDays: 1,  
  initialCapital: 10000,
  transactionCostBps: 15
};

console.log("🚀 Iniciando Test de Pánico Extremo...");

try {
  const results = runBacktest(input);
  console.log("\n--- AUDITORÍA DE REGÍMENES ---");
  
  const { EXPANSION, CRISIS, CONTRACTION } = results.regimeConditional;

  console.log(`📈 EXPANSIÓN -> Días: ${EXPANSION.totalDays} | MaxDD: ${(EXPANSION.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`🟠 CONTRACCIÓN -> Días: ${CONTRACTION.totalDays} | MaxDD: ${(CONTRACTION.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`📉 CRISIS     -> Días: ${CRISIS.totalDays}    | MaxDD: ${(CRISIS.maxDrawdown * 100).toFixed(2)}%`);

  if (CRISIS.totalDays > 0 || CONTRACTION.totalDays > 0) {
    console.log("\n✅ ¡LO LOGRAMOS! El motor ya diferencia entre paz y caos.");
  } else {
    console.log("\n⚠️ Sigue en expansión. Tu motor es muy exigente con el concepto de 'Crisis'.");
  }

} catch (error) {
  console.error("❌ Error:", error);
}
