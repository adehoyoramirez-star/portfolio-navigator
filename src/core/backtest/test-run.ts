// ===============================================
// ARCHIVO: src/core/backtest/test-run.ts
// TEST TRIMESTRAL - ESTRATEGIA DE BAJA ROTACIÓN
// ===============================================
import { runBacktest } from "./backtestEngine";

const generateHistory = () => {
  const data: number[] = [];
  let price = 100;
  for (let i = 0; i < 50; i++) { price *= 1.005; data.push(price); } // Calma
  for (let i = 0; i < 50; i++) { price *= (i % 2 === 0 ? 0.92 : 1.05); data.push(price); } // Huracán
  for (let i = 0; i < 40; i++) { price *= 1.02; data.push(price); } // Recuperación
  return data;
};

const history = generateHistory();
const mockHistory: Record<string, number[]> = {
  'IS3Q.DE': history, 'BTC-EUR': history, 'EMXC.DE': history,
  'PPFB.DE': history, 'URNU.DE': history, 'VVSM.DE': history, 'XNAS.DE': history,
};

const input = {
  closesHistory: mockHistory,
  macroHistory: {
    vix: Array(500).fill(18),
    yieldSpread: Array(500).fill(1.5),
    creditSpread: Array(500).fill(0.5),
  },
  lookbackDays: 20,
  rebalanceDays: 63,  // <--- REBALANCEO CADA 3 MESES
  initialCapital: 10000,
  transactionCostBps: 15
};

console.log("🚀 Iniciando Simulación Trimestral Predator...");

try {
  const result = runBacktest(input);
  const m = result.metrics;

  console.log("\n" + "=".repeat(50));
  console.log("📊 RESULTADOS FINALES (REBALANCEO CADA 3 MESES)");
  console.log("=".repeat(50));
  console.log(`💰 Capital Final:    €${m.finalValue.toLocaleString('es-ES', {minimumFractionDigits: 2})}`);
  console.log(`📉 Max Drawdown:     ${(m.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`💸 Costes Transac:   €${result.totalTransactionCosts.toFixed(2)}`); // Debería ser mucho menor
  console.log(`📋 Rebalanceos:      ${result.rebalanceCount}`);
  console.log("-".repeat(50));

  if (result.totalTransactionCosts < 1000) {
    console.log("✅ EFICIENCIA: Has ahorrado miles en comisiones.");
  }

} catch (e) {
  console.error("❌ Error:", e);
}