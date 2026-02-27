import React from "react"
import { calculateERP } from "@/core/macro/erp"
import { runMonteCarlo } from "@/core/simulation/montecarlo"
import { generateExecutiveSummary } from "@/core/summary/executive"
import { portfolio } from "@/data/portfolio"  // <-- Importamos la cartera

// Función auxiliar para formatear moneda (puedes moverla a un utils si quieres)
const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
};

const InstitutionalDashboard: React.FC = () => {
  // === MACRO INPUTS (mock institucional) ===
  const earningsYield = 0.065
  const riskFreeRate = 0.04

  const erpResult = calculateERP(earningsYield, riskFreeRate)

  // === MONTECARLO SIMULATION (simplificada) ===
  const monteCarlo = runMonteCarlo(0.08, 0.15)

  // === EXECUTIVE SUMMARY ===
  const executive = generateExecutiveSummary()

  // Calcular valor total de la cartera
  const totalPortfolioValue = portfolio.assets.reduce(
    (sum, asset) => sum + asset.price * asset.shares,
    0
  );

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Institutional Portfolio Dashboard</h1>

      {/* ERP SECTION */}
      <div style={styles.card}>
        <h2>Equity Risk Premium</h2>
        <p><strong>ERP:</strong> {(erpResult.equityRiskPremium * 100).toFixed(2)}%</p>
        <p>
          <strong>Signal:</strong>{" "}
          <span style={{ color: erpResult.signal === "RISK_ON" ? "limegreen" : "red" }}>
            {erpResult.signal}
          </span>
        </p>
      </div>

      {/* MONTECARLO SECTION */}
      <div style={styles.card}>
        <h2>Monte Carlo Simulation</h2>
        <p>
          <strong>Expected Return:</strong> {(monteCarlo.expectedReturn * 100).toFixed(2)}%
        </p>
        <p>
          <strong>Volatility:</strong> {(monteCarlo.volatility * 100).toFixed(2)}%
        </p>
      </div>

      {/* EXECUTIVE SUMMARY */}
      <div style={styles.card}>
        <h2>Executive Summary</h2>
        <p><strong>Liquidity Score:</strong> {executive.liquidityScore}</p>
        <p><strong>Macro Regime:</strong> {executive.macroRegime}</p>
      </div>

      {/* ===== NUEVA SECCIÓN: MI CARTERA ===== */}
      <div style={styles.card}>
        <h2>Mi Cartera</h2>
        <p style={{ marginBottom: '16px', color: '#9ca3af' }}>
          Valor total: {formatCurrency(totalPortfolioValue)} | 
          Aportación mensual: {formatCurrency(portfolio.monthlyInjection)} | 
          Objetivo: {formatCurrency(portfolio.targetGoal)}
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2d3748' }}>
                <th style={{ textAlign: 'left', padding: '8px 4px' }}>Activo</th>
                <th style={{ textAlign: 'left', padding: '8px 4px' }}>Precio</th>
                <th style={{ textAlign: 'left', padding: '8px 4px' }}>Particip.</th>
                <th style={{ textAlign: 'left', padding: '8px 4px' }}>Valor</th>
                <th style={{ textAlign: 'left', padding: '8px 4px' }}>Peso obj.</th>
                <th style={{ textAlign: 'left', padding: '8px 4px' }}>Peso act.</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.assets.map(asset => {
                const valor = asset.price * asset.shares;
                const pesoActual = (valor / totalPortfolioValue) * 100;
                return (
                  <tr key={asset.ticker} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ padding: '8px 4px' }}>
                      <div style={{ fontWeight: 500 }}>{asset.name}</div>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>{asset.ticker}</div>
                    </td>
                    <td style={{ padding: '8px 4px' }}>{formatCurrency(asset.price)}</td>
                    <td style={{ padding: '8px 4px' }}>{asset.shares.toFixed(4)}</td>
                    <td style={{ padding: '8px 4px' }}>{formatCurrency(valor)}</td>
                    <td style={{ padding: '8px 4px' }}>{asset.weight}%</td>
                    <td style={{ padding: '8px 4px' }}>{pesoActual.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// Estilos (los mismos que ya tenías, sin cambios)
const styles: { [key: string]: React.CSSProperties } = {
  container: {
    padding: "40px",
    fontFamily: "Inter, sans-serif",
    backgroundColor: "#0e1117",
    minHeight: "100vh",
    color: "white"
  },
  title: {
    marginBottom: "40px"
  },
  card: {
    backgroundColor: "#161b22",
    padding: "24px",
    borderRadius: "12px",
    marginBottom: "24px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)"
  }
}

export default InstitutionalDashboard