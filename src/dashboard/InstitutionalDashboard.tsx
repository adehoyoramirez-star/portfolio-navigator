import React, { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { calculateERP } from "@/core/macro/erp";
import { liquidityScore } from "@/core/macro/liquidity";
import { generateExecutiveSummary } from "@/core/summary/executive";
import { generateDecision, DecisionInput, DecisionOutput } from "@/core/decision/engine";
import { portfolio as initialPortfolio } from "@/data/portfolio";
import { getMacroData, getCurrentPrices } from "@/lib/yahooFinance";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";

// Importación dinámica para evitar errores en build de Vercel
const GaugeChart = lazy(() => import("react-gauge-chart"));

// Tipos
interface Asset {
  ticker: string;
  name: string;
  weight: number;
  currentWeight: number;
  price: number;
  shares: number;
  avgPrice: number;
  volatility: number;
  expectedReturn: number;
  sector: string;
  history: number[];
  zScore?: number;
  rsi?: number;
}

interface Portfolio {
  totalValue: number;
  cashReserve: number;
  monthlyInjection: number;
  targetGoal: number;
  regime: "ATTACK" | "NEUTRAL" | "RISK_OFF";
  riskFreeRate: number;
  expectedVolatility: number;
  assets: Asset[];
}

// Formateadores
const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value);
};

const formatPercent = (value: number): string => {
  return new Intl.NumberFormat("es-ES", { style: "percent", minimumFractionDigits: 1 }).format(value);
};

// Colores para el donut
const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

// --- Función de simulación Monte Carlo ---
function runMonteCarloSimulation(
  initialCapital: number,
  monthlyContribution: number,
  expectedReturn: number,
  volatility: number,
  years: number,
  target: number,
  simulations: number = 5000
): { probability: number; histogramData: { range: string; count: number }[] } {
  const monthlyReturn = expectedReturn / 12;
  const monthlyVol = volatility / Math.sqrt(12);
  const months = years * 12;

  const finalValues: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let value = initialCapital;
    for (let m = 0; m < months; m++) {
      value += monthlyContribution;
      const r = monthlyReturn + monthlyVol * randomNormal();
      value = value * Math.exp(r);
    }
    finalValues.push(value);
  }

  const successes = finalValues.filter(v => v >= target).length;
  const probability = successes / simulations;

  const min = Math.min(...finalValues);
  const max = Math.max(...finalValues);
  const binWidth = (max - min) / 10;
  const bins = Array(10).fill(0);
  finalValues.forEach(v => {
    const index = Math.min(9, Math.floor((v - min) / binWidth));
    bins[index]++;
  });

  const histogramData = bins.map((count, i) => ({
    range: `${formatCurrency(min + i * binWidth)} - ${formatCurrency(min + (i + 1) * binWidth)}`,
    count
  }));

  return { probability, histogramData };
}

function randomNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

const InstitutionalDashboard: React.FC = () => {
  // Estado de la cartera
  const [portfolio, setPortfolio] = useState<Portfolio>(initialPortfolio);
  const [cashReserve, setCashReserve] = useState(portfolio.cashReserve);
  const [monthlyInjection, setMonthlyInjection] = useState(portfolio.monthlyInjection);
  const [years, setYears] = useState(10);
  const [buyPercentage, setBuyPercentage] = useState(50);

  // Estado para datos macro (con valores por defecto)
  const [vix, setVix] = useState(19);
  const [rsi, setRsi] = useState(55);
  const [momentum, setMomentum] = useState(0.2);
  const [erpValue, setErpValue] = useState(0.025); // 2.5%
  const [liquidity, setLiquidity] = useState(0.5);
  const [regimeScore, setRegimeScore] = useState(0.5);
  const [erpSignal, setErpSignal] = useState<"RISK_ON" | "RISK_OFF">("RISK_ON");

  // Cargar datos reales al montar el componente
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Obtener datos macro (VIX, TNX, IRX, GSPC)
        const macro = await getMacroData();
        setVix(macro.vix);

        // Calcular ERP con datos reales (ejemplo: usando PER implícito del S&P 500)
        // En un caso real, obtendrías el PER de una API. Aquí simulamos con el valor de GSPC
        const per = 22; // Podrías obtenerlo de otra fuente
        const earningsYield = 1 / per;
        const riskFree = macro.tnx / 100; // TNX ya viene en %
        const erp = earningsYield - riskFree;
        setErpValue(erp);
        setErpSignal(erp > 0.03 ? "RISK_ON" : "RISK_OFF");

        // Calcular liquidez (simplificado)
        const liq = liquidityScore({
          m2Growth: 5.2, // Podrías obtenerlo de otra API
          vix: macro.vix,
          yieldCurveSpread: macro.tnx - macro.irx
        });
        setLiquidity(liq);
        setRegimeScore(liq); // Por simplicidad

        // Obtener precios actuales de los activos
        const prices = await getCurrentPrices();
        setPortfolio(prev => ({
          ...prev,
          assets: prev.assets.map(asset => ({
            ...asset,
            price: prices[asset.ticker] || asset.price
          }))
        }));

      } catch (error) {
        console.error("Error fetching market data:", error);
      }
    };

    fetchData();
  }, []);

  // Decisión del motor macro
  const decision: DecisionOutput = generateDecision({
    erp: erpValue,
    liquidity,
    regimeScore,
    vix,
    rsi,
    momentum
  });

  // Monte Carlo
  const totalPortfolioValue = portfolio.assets.reduce(
    (sum, asset) => sum + asset.price * asset.shares,
    0
  );

  const { probability, histogramData } = useMemo(() => {
    return runMonteCarloSimulation(
      totalPortfolioValue,
      monthlyInjection,
      0.08,
      0.15,
      years,
      portfolio.targetGoal,
      5000
    );
  }, [totalPortfolioValue, monthlyInjection, years, portfolio.targetGoal]);

  const executive = generateExecutiveSummary();

  useEffect(() => {
    setPortfolio(prev => ({ ...prev, cashReserve, monthlyInjection }));
  }, [cashReserve, monthlyInjection]);

  const updateAsset = (ticker: string, field: keyof Asset, value: number) => {
    setPortfolio(prev => ({
      ...prev,
      assets: prev.assets.map(asset =>
        asset.ticker === ticker ? { ...asset, [field]: value } : asset
      )
    }));
  };

  const pieData = portfolio.assets.map(asset => ({
    name: asset.name,
    value: asset.price * asset.shares
  }));

  // Sugerencia de compra (solo si BUY)
  const purchaseSuggestions = useMemo(() => {
    if (decision.action !== "BUY") return [];

    const availableCash = (cashReserve * (buyPercentage / 100)) + monthlyInjection;
    if (availableCash <= 0) return [];

    const assetsWithDeficit = portfolio.assets.map(asset => {
      const currentValue = asset.price * asset.shares;
      const targetValue = totalPortfolioValue * (asset.weight / 100);
      const deficit = targetValue - currentValue;
      return { ...asset, deficit };
    }).filter(a => a.deficit > 0);

    const sorted = [...assetsWithDeficit].sort((a, b) => b.deficit - a.deficit);

    let remainingCash = availableCash;
    const suggestions: { ticker: string; name: string; price: number; sharesToBuy: number; cost: number }[] = [];

    for (const asset of sorted) {
      if (remainingCash <= 0) break;

      let maxSharesByDeficit = asset.deficit / asset.price;
      let maxSharesByCash = remainingCash / asset.price;

      let sharesToBuy: number;
      if (asset.ticker === "BTC-EUR") {
        sharesToBuy = Math.min(maxSharesByDeficit, maxSharesByCash);
        sharesToBuy = Math.floor(sharesToBuy * 10000) / 10000;
      } else {
        sharesToBuy = Math.floor(Math.min(maxSharesByDeficit, maxSharesByCash));
      }

      if (sharesToBuy <= 0) continue;

      const cost = sharesToBuy * asset.price;
      if (cost <= remainingCash) {
        suggestions.push({
          ticker: asset.ticker,
          name: asset.name,
          price: asset.price,
          sharesToBuy,
          cost
        });
        remainingCash -= cost;
      }
    }

    return suggestions;
  }, [decision.action, cashReserve, monthlyInjection, buyPercentage, portfolio.assets, totalPortfolioValue]);

  const totalSuggestedCost = purchaseSuggestions.reduce((sum, s) => sum + s.cost, 0);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard (Hedge Fund)</h1>

      {/* Velocímetros (6 indicadores) */}
      <div style={{ ...styles.card, display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: "20px" }}>
        <Suspense fallback={<div style={{ height: 120, background: "#1f2937", width: 250 }}>Cargando...</div>}>
          {/* ERP */}
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>ERP</h4>
            <GaugeChart
              id="gauge-erp"
              nrOfLevels={20}
              percent={erpValue * 20}
              textColor="#fff"
              formatTextValue={() => `${(erpValue * 100).toFixed(1)}%`}
              colors={["#ef4444", "#f59e0b", "#10b981"]}
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
          {/* Liquidez */}
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>Liquidez</h4>
            <GaugeChart
              id="gauge-liquidity"
              nrOfLevels={20}
              percent={liquidity}
              textColor="#fff"
              formatTextValue={() => (liquidity * 100).toFixed(0) + "%"}
              colors={["#ef4444", "#f59e0b", "#10b981"]}
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
          {/* Régimen */}
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>Régimen</h4>
            <GaugeChart
              id="gauge-regime"
              nrOfLevels={20}
              percent={regimeScore}
              textColor="#fff"
              formatTextValue={() => (regimeScore * 100).toFixed(0) + "%"}
              colors={["#ef4444", "#f59e0b", "#10b981"]}
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
          {/* VIX */}
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>VIX</h4>
            <GaugeChart
              id="gauge-vix"
              nrOfLevels={20}
              percent={Math.min(1, vix / 40)} // VIX 40 = 100%
              textColor="#fff"
              formatTextValue={() => vix.toFixed(1)}
              colors={["#10b981", "#f59e0b", "#ef4444"]} // Invertido: bajo es bueno
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
          {/* RSI */}
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>RSI</h4>
            <GaugeChart
              id="gauge-rsi"
              nrOfLevels={20}
              percent={rsi / 100}
              textColor="#fff"
              formatTextValue={() => rsi.toFixed(0)}
              colors={["#ef4444", "#f59e0b", "#ef4444"]} // Extremos rojos, centro verde
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
          {/* Momentum */}
          <div style={{ width: "160px", textAlign: "center" }}>
            <h4>Momentum</h4>
            <GaugeChart
              id="gauge-momentum"
              nrOfLevels={20}
              percent={(momentum + 1) / 2}
              textColor="#fff"
              formatTextValue={() => momentum.toFixed(2)}
              colors={["#ef4444", "#f59e0b", "#10b981"]}
              arcWidth={0.3}
              cornerRadius={3}
            />
          </div>
        </Suspense>
      </div>

      {/* Inputs manuales para VIX, RSI, Momentum */}
      <div style={{ ...styles.card, display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div>
          <label style={styles.label}>VIX (manual)</label>
          <input type="number" value={vix} onChange={(e) => setVix(Number(e.target.value))} style={styles.smallInput} step="0.1" />
        </div>
        <div>
          <label style={styles.label}>RSI (manual)</label>
          <input type="number" value={rsi} onChange={(e) => setRsi(Number(e.target.value))} style={styles.smallInput} step="1" min="0" max="100" />
        </div>
        <div>
          <label style={styles.label}>Momentum (manual)</label>
          <input type="number" value={momentum} onChange={(e) => setMomentum(Number(e.target.value))} style={styles.smallInput} step="0.1" min="-1" max="1" />
        </div>
        <div>
          <p><strong>ERP:</strong> {(erpValue * 100).toFixed(2)}%</p>
          <p><strong>Liquidez:</strong> {(liquidity * 100).toFixed(0)}%</p>
        </div>
      </div>

      {/* Decisión macro con factores */}
      <div style={styles.card}>
        <h2>Decisión del motor macro (Hedge Fund)</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "2rem", flexWrap: "wrap" }}>
          <div>
            <p style={{
              fontSize: "3rem", fontWeight: "bold", margin: 0,
              color: decision.action === "BUY" ? "#10b981" : decision.action === "TRIM" ? "#ef4444" : "#f59e0b"
            }}>
              {decision.action === "BUY" ? "COMPRAR" : decision.action === "TRIM" ? "RECORTAR" : "MANTENER"}
            </p>
            <p><strong>Convicción:</strong> {decision.conviction.toFixed(0)}%</p>
          </div>
          <div style={{ maxWidth: "500px" }}>
            <p style={{ fontSize: "1rem", color: "#9ca3af" }}>{decision.explanation}</p>
          </div>
        </div>
        <div style={{ marginTop: "1rem", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "10px" }}>
          <div><strong>ERP:</strong> {(decision.factors.erp * 100).toFixed(0)}% favorable</div>
          <div><strong>Liquidez:</strong> {(decision.factors.liquidity * 100).toFixed(0)}%</div>
          <div><strong>Régimen:</strong> {(decision.factors.regime * 100).toFixed(0)}%</div>
          <div><strong>VIX:</strong> {(decision.factors.vix * 100).toFixed(0)}% favorable</div>
          <div><strong>RSI:</strong> {(decision.factors.rsi * 100).toFixed(0)}% favorable</div>
          <div><strong>Momentum:</strong> {(decision.factors.momentum * 100).toFixed(0)}% favorable</div>
        </div>
      </div>

      {/* Métricas macro */}
      <div style={styles.macroRow}>
        <div style={styles.card}>
          <h2>Prima de riesgo (ERP)</h2>
          <p><strong>Valor:</strong> {(erpValue * 100).toFixed(2)}%</p>
          <p><strong>Señal:</strong> <span style={{ color: erpSignal === "RISK_ON" ? "limegreen" : "red" }}>{erpSignal === "RISK_ON" ? "RIESGO ACTIVADO" : "RIESGO DESACTIVADO"}</span></p>
        </div>
        <div style={styles.card}>
          <h2>Monte Carlo</h2>
          <p><strong>Probabilidad de alcanzar objetivo:</strong> {(probability * 100).toFixed(1)}%</p>
          <div style={{ marginTop: "10px" }}>
            <label style={styles.label}>Años de simulación:</label>
            <input type="number" value={years} onChange={(e) => setYears(Number(e.target.value))} style={styles.smallInput} min="1" max="30" />
          </div>
        </div>
        <div style={styles.card}>
          <h2>Resumen ejecutivo</h2>
          <p><strong>Liquidez:</strong> {executive.liquidityScore}</p>
          <p><strong>Régimen:</strong> {executive.macroRegime}</p>
        </div>
      </div>

      {/* Histograma Monte Carlo */}
      <div style={styles.card}>
        <h2>Distribución de valores finales (Monte Carlo)</h2>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={histogramData} barSize={30}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="range" tick={{ fontSize: 10, fill: "#9ca3af" }} interval={0} angle={-45} textAnchor="end" height={80} />
            <YAxis tick={{ fill: "#9ca3af" }} />
            <Tooltip formatter={(value: number) => value} labelFormatter={() => ""} />
            <Bar dataKey="count" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Caja y aportaciones */}
      <div style={{ ...styles.card, display: "flex", gap: "2rem", alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <label style={styles.label}>Caja de reserva (€)</label>
          <input type="number" value={cashReserve} onChange={(e) => setCashReserve(Number(e.target.value))} style={styles.input} />
        </div>
        <div>
          <label style={styles.label}>Aportación mensual (€)</label>
          <input type="number" value={monthlyInjection} onChange={(e) => setMonthlyInjection(Number(e.target.value))} style={styles.input} />
        </div>
        <div>
          <label style={styles.label}>% de caja para compras</label>
          <input type="number" value={buyPercentage} onChange={(e) => setBuyPercentage(Number(e.target.value))} style={styles.smallInput} min="0" max="100" step="5" /> %
        </div>
        <div>
          <p><strong>Valor total cartera:</strong> {formatCurrency(totalPortfolioValue)}</p>
          <p><strong>Objetivo:</strong> {formatCurrency(portfolio.targetGoal)}</p>
        </div>
      </div>

      {/* Sugerencia de compra (solo si BUY) */}
      {decision.action === "BUY" && (
        <div style={styles.card}>
          <h2>📈 Sugerencia de compra (basada en motor macro)</h2>
          {purchaseSuggestions.length > 0 ? (
            <>
              <p>Dinero disponible: {formatCurrency((cashReserve * buyPercentage / 100) + monthlyInjection)} (usando {buyPercentage}% de la caja más aportación mensual)</p>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th>Activo</th>
                    <th>Precio</th>
                    <th>Acciones a comprar</th>
                    <th>Coste</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseSuggestions.map(s => (
                    <tr key={s.ticker}>
                      <td>{s.name}</td>
                      <td>{formatCurrency(s.price)}</td>
                      <td>{s.sharesToBuy}</td>
                      <td>{formatCurrency(s.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} style={{ textAlign: "right", fontWeight: "bold" }}>Total:</td>
                    <td>{formatCurrency(totalSuggestedCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          ) : (
            <p>No hay suficientes fondos o ningún activo necesita compra.</p>
          )}
        </div>
      )}

      {/* Donut y tabla de activos */}
      <div style={{ ...styles.card, display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "250px" }}>
          <h2>Distribución actual</h2>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                dataKey="value"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              >
                {pieData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div style={{ flex: 2, overflowX: "auto" }}>
          <h2>Activos (precios actuales editables)</h2>
          <table style={styles.table}>
            <thead>
              <tr>
                <th>Activo</th>
                <th>Precio actual (€)</th>
                <th>Particip.</th>
                <th>Valor (€)</th>
                <th>Precio compra</th>
                <th>Ganancia/pérdida</th>
                <th>Peso obj.</th>
                <th>Peso act.</th>
                <th>Déficit (€)</th>
                <th>Recom. macro</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.assets.map(asset => {
                const valor = asset.price * asset.shares;
                const pesoActual = (valor / totalPortfolioValue) * 100;
                const targetValue = totalPortfolioValue * (asset.weight / 100);
                const deficit = targetValue - valor;
                const ganancia = (asset.price - asset.avgPrice) * asset.shares;
                const gananciaPorcentaje = ((asset.price - asset.avgPrice) / asset.avgPrice) * 100;
                return (
                  <tr key={asset.ticker}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{asset.name}</div>
                      <div style={styles.ticker}>{asset.ticker}</div>
                    </td>
                    <td>
                      <input
                        type="number"
                        value={asset.price}
                        onChange={(e) => updateAsset(asset.ticker, "price", Number(e.target.value))}
                        style={styles.smallInput}
                        step="0.01"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={asset.shares}
                        onChange={(e) => updateAsset(asset.ticker, "shares", Number(e.target.value))}
                        style={styles.smallInput}
                        step="0.0001"
                      />
                    </td>
                    <td>{formatCurrency(valor)}</td>
                    <td>{formatCurrency(asset.avgPrice)}</td>
                    <td style={{ color: ganancia >= 0 ? "#10b981" : "#ef4444" }}>
                      {formatCurrency(ganancia)} ({gananciaPorcentaje.toFixed(1)}%)
                    </td>
                    <td>{asset.weight}%</td>
                    <td>{pesoActual.toFixed(1)}%</td>
                    <td style={{ color: deficit > 0 ? "#f59e0b" : "#6b7280" }}>
                      {deficit > 0 ? formatCurrency(deficit) : "-"}
                    </td>
                    <td>
                      <span style={{
                        color: decision.action === "BUY" ? "#10b981" : decision.action === "TRIM" ? "#ef4444" : "#f59e0b",
                        fontWeight: "bold"
                      }}>
                        {decision.action === "BUY" ? "COMPRAR" : decision.action === "TRIM" ? "RECORTAR" : "MANTENER"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: { padding: "40px", fontFamily: "Inter, sans-serif", backgroundColor: "#0e1117", minHeight: "100vh", color: "white" },
  title: { marginBottom: "40px" },
  macroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "20px", marginBottom: "20px" },
  card: { backgroundColor: "#161b22", padding: "24px", borderRadius: "12px", marginBottom: "24px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)" },
  label: { display: "block", marginBottom: "8px", color: "#9ca3af", fontSize: "0.9rem" },
  input: { backgroundColor: "#1f2937", border: "1px solid #374151", color: "white", padding: "8px 12px", borderRadius: "6px", width: "150px" },
  smallInput: { backgroundColor: "#1f2937", border: "1px solid #374151", color: "white", padding: "4px 6px", borderRadius: "4px", width: "80px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "14px" },
  ticker: { fontSize: "12px", color: "#6b7280" }
};

export default InstitutionalDashboard;