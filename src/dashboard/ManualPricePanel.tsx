// ===============================================
// ARCHIVO: src/dashboard/ManualPricePanel.tsx
// OVERRIDE MANUAL DE PRECIOS — panel ligero para fijar precios
// a mano cuando Yahoo falla (ej. URNU.DE por rate-limiting).
// ===============================================

import React, { useState } from "react";
import { loadManualPrices, saveManualPrice, resetManualPrice, type ManualPriceEntry } from "@/lib/manualPrices";
import { ASSET_REGISTRY } from "@/lib/assetRegistry";

interface ManualPricePanelProps {
  onSaved?: () => void;
  currentPrices?: Record<string, number>;
}

const ManualPricePanel: React.FC<ManualPricePanelProps> = ({ onSaved, currentPrices }) => {
  const [entries, setEntries] = useState<Record<string, ManualPriceEntry>>(() => loadManualPrices());
  const [msg, setMsg] = useState<string | null>(null);

  const handleSet = (ticker: string, price: number) => {
    if (price > 0) {
      saveManualPrice(ticker, price, "manual override");
      setEntries(loadManualPrices());
      setMsg(`Precio manual ${ticker} = ${price.toFixed(2)} € — guardado`);
    }
    if (onSaved) onSaved();
    setTimeout(() => setMsg(null), 3000);
  };

  const handleClear = (ticker: string) => {
    resetManualPrice(ticker);
    setEntries(loadManualPrices());
    setMsg(`Override ${ticker} eliminado — vuelve a Yahoo`);
    if (onSaved) onSaved();
    setTimeout(() => setMsg(null), 3000);
  };

  const inp: React.CSSProperties = {
    backgroundColor: "#1f2937", border: "1px solid #374151", color: "white",
    padding: "4px 8px", borderRadius: "4px", width: "90px", fontSize: "0.8rem",
  };
  const lbl: React.CSSProperties = { color: "#9ca3af", fontSize: "0.72rem", minWidth: "110px" };

  return (
    <div style={{ backgroundColor: "#161b22", padding: "14px 20px", borderRadius: "10px", marginBottom: "12px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "8px" }}>
        <span style={{ fontSize: "0.88rem", color: "#e2e8f0", fontWeight: 600 }}>
          💾 Precios manuales (override Yahoo)
          {Object.keys(entries).length > 0 && (
            <span style={{ fontSize: "0.65rem", marginLeft: "8px", color: "#fbbf24", background: "#3b2f0e", padding: "1px 7px", borderRadius: "3px", border: "1px solid #fbbf2440" }}>
              {Object.keys(entries).length} activo(s) con override
            </span>
          )}
        </span>
        {msg && <span style={{ fontSize: "0.72rem", color: "#10b981" }}>{msg}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {ASSET_REGISTRY.map((a) => {
          const override = entries[a.ticker];
          const fallback = override?.price ?? currentPrices?.[a.ticker];
          return (
            <div key={a.ticker} style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span style={lbl}>{a.ticker} <span style={{ fontSize: "0.62rem", color: "#64748b" }}>({a.name})</span></span>
              <input
                type="number"
                step="0.01"
                defaultValue={override?.price ?? (currentPrices?.[a.ticker] ?? "")}
                key={a.ticker + (override?.price ?? "")}
                placeholder={fallback ? `${fallback.toFixed(2)} (Yahoo)` : "precio"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = Number((e.target as HTMLInputElement).value);
                    if (v > 0) handleSet(a.ticker, v);
                  }
                }}
                style={inp}
              />
              <button
                onClick={(e) => {
                  const input = (e.target as HTMLButtonElement).previousElementSibling as HTMLInputElement;
                  const v = Number(input.value);
                  if (v > 0) handleSet(a.ticker, v);
                }}
                style={{ background: "#2563eb", color: "white", border: "none", borderRadius: "4px", padding: "3px 10px", cursor: "pointer", fontSize: "0.72rem", fontWeight: 600 }}
              >
                Fijar
              </button>
              {override && (
                <button
                  onClick={() => handleClear(a.ticker)}
                  style={{ background: "#374151", color: "#fca5a5", border: "1px solid #4b5563", borderRadius: "4px", padding: "3px 8px", cursor: "pointer", fontSize: "0.68rem" }}
                >
                  ✕ quitar
                </button>
              )}
              {override && (
                <span style={{ fontSize: "0.68rem", color: "#fbbf24" }}>✓ override {override.price.toFixed(2)} €</span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: "8px", fontSize: "0.62rem", color: "#4b5563" }}>
        El precio manual tiene prioridad sobre Yahoo en el motor. Vacío = usar Yahoo. Enter o «Fijar» para guardar.
      </div>
    </div>
  );
};

export default ManualPricePanel;
