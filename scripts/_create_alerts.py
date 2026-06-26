import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'

content = r'''// ===============================================
// COMPONENTE: AlertsSection.tsx
// Extraido de InstitutionalDashboard.tsx - NIVEL 4: Alertas activas
// ===============================================

import type { RegimeAlert } from "@/core/alerts/regimeAlerts";

interface AlertsSectionProps {
  activeAlerts: RegimeAlert[];
  dismissedAlerts: Set<string>;
  onDismissAlert: (alertId: string) => void;
  cardStyle: React.CSSProperties;
}

const AlertsSection: React.FC<AlertsSectionProps> = ({
  activeAlerts,
  dismissedAlerts,
  onDismissAlert,
  cardStyle,
}) => {
  const visibleAlerts = activeAlerts.filter((a) => !dismissedAlerts.has(a.id));
  if (visibleAlerts.length === 0) return null;

  return (
    <>
      {/* NIVEL 4: Alertas activas */}
      <div style={cardStyle}>
        <h2>Alertas del Motor</h2>
        {visibleAlerts.map((alert) => (
          <div
            key={alert.id}
            style={{
              backgroundColor:
                alert.severity === "CRITICAL"
                  ? "#7f1d1d"
                  : alert.severity === "WARNING"
                    ? "#78350f"
                    : "#1e3a5f",
              border: `1px solid ${
                alert.severity === "CRITICAL"
                  ? "#ef4444"
                  : alert.severity === "WARNING"
                    ? "#f59e0b"
                    : "#3b82f6"
              }`,
              borderRadius: 6,
              padding: "0.75rem 1rem",
              marginBottom: "0.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <div>
                <p style={{ fontWeight: "bold", marginBottom: "0.25rem" }}>
                  {alert.title}
                </p>
                <p
                  style={{
                    color: "#d1d5db",
                    fontSize: "0.85rem",
                    marginBottom: "0.25rem",
                  }}
                >
                  {alert.message}
                </p>
                <p style={{ color: "#10b981", fontSize: "0.8rem" }}>
                  {alert.action}
                </p>
                <p style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                  {new Date(alert.timestamp).toLocaleString("es-ES")}
                </p>
              </div>
              {alert.dismissible && (
                <button
                  onClick={() => onDismissAlert(alert.id)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9ca3af",
                    cursor: "pointer",
                    fontSize: "1.2rem",
                  }}
                >
                  X
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
};

export default AlertsSection;
'''

path = 'src/dashboard/AlertsSection.tsx'
io.open(path, 'w', encoding='utf-8').write(content)
print(f'Created {path} ({len(content)} chars)')
