// EliteDashboard — wrapper limpio sin Panel de Control
// AUDIT-FIX: Eliminado el bloque hf-header/hf-kpis/hf-grid que duplicaba
// información ya disponible en InstitutionalDashboard y no aportaba valor analítico.
// La capa institucional completa (OlympusV3 + AI + Crypto + On-Chain) se carga directamente.

import InstitutionalDashboard from "@/dashboard/InstitutionalDashboard";

export default function EliteDashboard() {
  return <InstitutionalDashboard />;
}
