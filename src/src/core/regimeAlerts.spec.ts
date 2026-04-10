// --- ARCHIVO: src/core/regimeAlerts.spec.ts ---
import { describe, it, expect } from 'vitest';
// Corregimos la ruta apuntando a la carpeta alerts
import { generateAlerts, AlertInput } from './alerts/regimeAlerts'; 

describe('Auditoría de Alertas de Régimen', () => {
  it('Debe generar alerta de MEJORA cuando pasamos de CRISIS a CONTRACTION', () => {
    
    const input: AlertInput = {
      previousRegime: "CRISIS",
      currentRegime: "CONTRACTION",
      regimePenalty: 0.8,
      confidence: "HIGH",
      tailRiskActive: false,
      tailRiskReason: "",
      vix: 22,
      portfolioDrawdown: -15,
      volTargetMultiplier: 1.0
    };

    const alerts = generateAlerts(input);

    // Verificamos que se generó al menos una alerta
    expect(alerts.length).toBeGreaterThan(0);
    
    // Buscamos el título exacto que definiste en tu lógica
    const hasImprovement = alerts.some(a => a.title.includes("Régimen mejorado"));
    
    expect(hasImprovement).toBe(true);
    console.log("✅ TEST PASADO: El centinela detecta la mejora del mercado.");
  });
});