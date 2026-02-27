import React, { useState, useEffect } from "react";
import { calculateERP } from "@/core/macro/erp";
import { liquidityScore } from "@/core/macro/liquidity";
import { runMonteCarlo } from "@/core/simulation/montecarlo";
import { generateExecutiveSummary } from "@/core/summary/executive";
import { generateDecision } from "@/core/decision/engine"; // <-- Importamos el motor
import { portfolio as initialPortfolio } from "@/data/portfolio";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, RadialBarChart, RadialBar } from "recharts";

// ... (resto de tipos y funciones auxiliares)

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value);
};

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

// Componente para un velocímetro individual
const Gauge: React.FC<{ value: number; label: string; unit?: string; color?: string }> = ({ 
  value, label, unit = "", color = "#3b82f6" 
}) => {
  const data = [{ name: label, value: value * 100 }]; // Escalamos a 0-100 para el gráfico
  return (
    <div style={{ textAlign: "center" }}>
      <h4 style={{ marginBottom: 8, color: "#9ca3af" }}>{label}</h4>
      <ResponsiveContainer width="100%" height={120}>
        <RadialBarChart 
          cx="50%" 
          cy="50%" 
          innerRadius="60%" 
          outerRadius="100%" 
          barSize={20} 
          data={data} 
          startAngle={180} 
          endAngle={0}
        >
          <RadialBar
            background
            dataKey="value"
            fill={color}
          />
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: "1.2rem", fontWeight: "bold", fill: "white" }}
          >
            {value.toFixed(2)}{unit}
          </text>
        </RadialBarChart>
      </ResponsiveContainer>
    </div>
  );
};

const InstitutionalDashboard: React.FC = () => {
  // === Estado de la cartera (editable) ===
  const [portfolio, setPortfolio] = useState(initialPortfolio);
  const [cashReserve, setCashReserve] = useState(portfolio.cashReserve);
  const [monthlyInjection, setMonthlyInjection] = useState(portfolio.monthlyInjection);

  // === Datos macro (mock, pero podrían venir de API) ===
  const earningsYield = 0.065;
  const riskFreeRate = 0.04;
  const erpResult = calculateERP(earningsYield, riskFreeRate); // Devuelve { equityRiskPremium, signal }
  const erpValue = erpResult.equityRiskPremium; // en tanto por uno

  // === Liquidity score ===
  const liquidity = liquidityScore({
    m2Growth: 5.2,
    vix: 19,
    yieldCurveSpread: 0.4
  }); // Devuelve un número entre 0 y 1

  // === Régimen score (podría ser el mismo liquidity o calculado aparte) ===
  // Por simplicidad, usamos liquidity como regimeScore
  const regimeScore = liquidity;

  // === Llamada al motor de decisiones ===
  const decision = generateDecision({
    erp: erpValue,
    liquidity,
    regimeScore
  });

  // === Monte Carlo ===
  const monteCarlo = runMonteCarlo(0.08, 0.15);

  // === Executive summary ===
  const executive = generateExecutiveSummary();

  // === Calcular valor total de la cartera ===
  const totalPortfolioValue = portfolio.assets.reduce(
    (sum, asset) => sum + asset.price * asset.shares,
    0
  );

  // === Actualizar cartera si cambian caja o aportación ===
  useEffect(() => {
    setPortfolio(prev => ({ ...prev, cashReserve, monthlyInjection }));
  }, [cashReserve, monthlyInjection]);

  // === Función para editar activos ===
  const updateAsset = (ticker: string, field: keyof typeof portfolio.assets[0], value: number) => {
    setPortfolio(prev => ({
      ...prev,
      assets: prev.assets.map(asset =>
        asset.ticker === ticker ? { ...asset, [field]: value } : asset
      )
    }));
  };

  // === Datos para el donut ===
  const pieData = portfolio.assets.map(asset => ({
    name: asset.name,
    value: asset.price * asset.shares
  }));

  // === Recomendación por activo (basada en pesos) - opcional ===
  const getWeightRecommendation = (asset: Asset) => {
    const currentValue = asset.price * asset.shares;
    const currentWeight = (currentValue / totalPortfolioValue) * 100;
    const diff = asset.weight - currentWeight;
    if (diff > 5) return { action: "COMPRAR", color: "#10b981" };
    if (diff < -5) return { action: "VENDER", color: "#ef4444" };
    return { action: "MANTENER", color: "#f59e0b" };
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard</h1>

      {/* === FILA DE VELOCÍMETROS === */}
      <div style={{ ...styles.card, display: "flex", justifyContent: "space-around", gap: "1rem" }}>
        <Gauge value={erpValue} label="ERP" unit="%" color="#10b981" />
        <Gauge value={liquidity} label="Liquidez" color="#3b82f6" />
        <Gauge value={regimeScore} label="Régimen" color="#f59e0b" />
      </div>

      {/* === TARJETA DE DECISIÓN MACRO === */}
      <div style={styles.card}>
        <h2>Decisión de asignación macro</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "2rem", flexWrap: "wrap" }}>
          <div>
            <p style={{ fontSize: "2rem", fontWeight: "bold", color: 
              decision.action === "BUY" ? "#10b981" : decision.action === "TRIM" ? "#ef4444" : "#f59e0b" 
            }}>
              {decision.action}
            </p>
            <p><strong>Convicción:</strong> {decision.conviction.toFixed(0)}%</p>
          </div>
          <div style={{ maxWidth: "400px" }}>
            <p style={{ fontStyle: "italic", color: "#9ca3af" }}>{decision.explanation}</p>
          </div>
        </div>
      </div>

      {/* === FILA DE MÉTRICAS MACRO (ERP, Monte Carlo, Resumen) === */}
      <div style={styles.macroRow}>
        <div style={styles.card}>
          <h2>Equity Risk Premium</h2>
          <p><strong>ERP:</strong> {(erpValue * 100).toFixed(2)}%</p>
          <p><strong>Signal:</strong> <span style={{ color: erpResult.signal === "RISK_ON" ? "limegreen" : "red" }}>{erpResult.signal}</span></p>
        </div>
        <div style={styles.card}>
          <h2>Monte Carlo</h2>
          <p><strong>Rentabilidad esperada:</strong> {(monteCarlo.expectedReturn * 100).toFixed(2)}%</p>
          <p><strong>Volatilidad:</strong> {(monteCarlo.volatility * 100).toFixed(2)}%</p>
        </div>
        <div style={styles.card}>
          <h2>Resumen ejecutivo</h2>
          <p><strong>Liquidez:</strong> {executive.liquidityScore}</p>
          <p><strong>Régimen:</strong> {executive.macroRegime}</p>
        </div>
      </div>

      {/* === FILA DE CAJA Y APORTACIONES (editable) === */}
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
          <p><strong>Valor total cartera:</strong> {formatCurrency(totalPortfolioValue)}</p>
          <p><strong>Objetivo:</strong> {formatCurrency(portfolio.targetGoal)}</p>
        </div>
      </div>

      {/* === GRÁFICO DONUT Y TABLA DE ACTIVOS === */}
      <div style={{ ...styles.card, display: "flex", gap: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "250px" }}>
          <h2>Distribución</h2>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} fill="#8884d8" paddingAngle={2} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                {pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div style={{ flex: 2, overflowX: "auto" }}>
          <h2>Activos</h2>
          <table style={styles.table}>
            <thead>
              <tr><th>Activo</th><th>Precio (€)</th><th>Particip.</th><th>Valor (€)</th><th>Peso obj.</th><th>Peso act.</th><th>Recom.</th></tr>
            </thead>
            <tbody>
              {portfolio.assets.map(asset => {
                const valor = asset.price * asset.shares;
                const pesoActual = (valor / totalPortfolioValue) * 100;
                const rec = getWeightRecommendation(asset);
                return (
                  <tr key={asset.ticker}>
                    <td><div style={{ fontWeight: 500 }}>{asset.name}</div><div style={styles.ticker}>{asset.ticker}</div></td>
                    <td><input type="number" value={asset.price} onChange={(e) => updateAsset(asset.ticker, "price", Number(e.target.value))} style={styles.smallInput} step="0.01" /></td>
                    <td><input type="number" value={asset.shares} onChange={(e) => updateAsset(asset.ticker, "shares", Number(e.target.value))} style={styles.smallInput} step="0.0001" /></td>
                    <td>{formatCurrency(valor)}</td>
                    <td>{asset.weight}%</td>
                    <td>{pesoActual.toFixed(1)}%</td>
                    <td><span style={{ color: rec.color, fontWeight: "bold" }}>{rec.action}</span></td>
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