// ===============================================
// ARCHIVO: src/dashboard/FredManualPanel.tsx
// FIX-AUDIT-R9 UI: Panel de inputs manuales FRED.
// Lee/escribe directamente en localStorage via fredManualInputs.ts.
// ===============================================

import React, { useState } from "react";
import { loadFredManual, saveFredManual, isFredDataFresh, getFredDefaults, clearManualOverride, hasServerOverride } from "@/lib/fredManualInputs";

interface FredManualPanelProps {
  onSaved?: () => void;
}

const FredManualPanel: React.FC<FredManualPanelProps> = ({ onSaved }) => {
  const initial = loadFredManual();
  const [m2, setM2] = useState(initial.m2GrowthYoY);
  const [cape, setCAPE] = useState(initial.cape);
  const [credit, setCredit] = useState(initial.creditSpread);
  const [be, setBE] = useState(initial.inflationBreakeven5y);
  // LIQ-AUTO (Ago-2026): WALCL + ECBASSETSW para Liquidez Global automática
  const [fedBS, setFedBS] = useState<number | undefined>(initial.fedBalanceSheet);
  const [ecbBS, setEcbBS] = useState<number | undefined>(initial.ecbBalanceSheet);
  const [lastUpdated, setLastUpdated] = useState(initial.lastUpdated);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const fresh = isFredDataFresh(7);
  const ageDays = Math.round((Date.now() - new Date(lastUpdated).getTime()) / (24 * 3600 * 1000));
  const isOverride = loadFredManual().manuallyOverridden === true;
  const serverAvailable = hasServerOverride();

  const handleSave = () => {
    const updated = saveFredManual({
      m2GrowthYoY: m2, cape, creditSpread: credit, inflationBreakeven5y: be,
      fedBalanceSheet: fedBS, ecbBalanceSheet: ecbBS,
    });
    setLastUpdated(updated.lastUpdated);
    setSaveMsg("Guardado - refrescando...");
    if (onSaved) onSaved();
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const handleReset = () => {
    const defaults = getFredDefaults();
    setM2(defaults.m2GrowthYoY);
    setCAPE(defaults.cape);
    setCredit(defaults.creditSpread);
    setBE(defaults.inflationBreakeven5y);
    setFedBS(undefined);
    setEcbBS(undefined);
    saveFredManual(defaults);
    setLastUpdated(new Date().toISOString());
    setSaveMsg("Restaurado a defaults");
    setTimeout(() => setSaveMsg(null), 2000);
  };

  const handleSyncToServer = () => {
    const synced = clearManualOverride();
    if (synced) {
      setM2(synced.m2GrowthYoY);
      setCAPE(synced.cape);
      setCredit(synced.creditSpread);
      setBE(synced.inflationBreakeven5y);
      setFedBS(synced.fedBalanceSheet);
      setEcbBS(synced.ecbBalanceSheet);
      setLastUpdated(synced.lastUpdated);
      setSaveMsg("Sync a servidor — override desactivado");
      if (onSaved) onSaved();
    } else {
      setSaveMsg("No hay datos de servidor disponibles");
    }
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const inp: React.CSSProperties = { backgroundColor: "#1f2937", border: "1px solid #374151", color: "white", padding: "5px 8px", borderRadius: "4px", width: "100%", fontSize: "0.85rem", boxSizing: "border-box" };
  const lbl: React.CSSProperties = { display: "block", marginBottom: "4px", color: "#9ca3af", fontSize: "0.72rem" };

  return (
    <div style={{ backgroundColor: "#161b22", padding: "20px 24px", borderRadius: "12px", marginBottom: "16px", boxShadow: "0 4px 12px rgba(0,0,0,0.4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0", fontWeight: 600 }}>
          FRED Manual Inputs
          <span style={{ fontSize: "0.68rem", fontWeight: 400, marginLeft: "10px", color: fresh ? "#10b981" : "#f59e0b" }}>
            {fresh ? "🟢 <7d" : "🟠 ~" + ageDays + "d"}
          </span>
          {isOverride && (
            <span style={{
              fontSize: "0.65rem", fontWeight: 600, marginLeft: "8px",
              color: "#fbbf24", background: "#3b2f0e", padding: "1px 7px", borderRadius: "3px",
              border: "1px solid #fbbf2440"
            }}>
              ⚠️ OVERRIDE ACTIVO
            </span>
          )}
        </h3>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {saveMsg && <span style={{ fontSize: "0.72rem", color: saveMsg.startsWith("Guardado") || saveMsg.startsWith("Sync") ? "#10b981" : "#f59e0b" }}>{saveMsg}</span>}
          {serverAvailable && (
            <button onClick={handleSyncToServer} title="Usar datos del servidor FRED (descarta override manual)"
              style={{ background: "#1a3a2a", color: "#10b981", border: "1px solid #10b98140", borderRadius: "5px", padding: "4px 10px", cursor: "pointer", fontSize: "0.7rem", fontWeight: 500 }}>
              Sync to Server
            </button>
          )}
          <button onClick={handleReset} title="Restaurar defaults" style={{ background: "#374151", color: "#9ca3af", border: "1px solid #4b5563", borderRadius: "5px", padding: "4px 10px", cursor: "pointer", fontSize: "0.7rem" }}>Reset</button>
          <button onClick={handleSave} style={{ background: "#2563eb", color: "white", border: "none", borderRadius: "5px", padding: "4px 14px", cursor: "pointer", fontSize: "0.75rem", fontWeight: 600 }}>Guardar</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem" }}>
        <div><label style={lbl}>M2 Growth YoY% <span style={{fontSize:"0.6rem",color:"#64748b"}}>M2SL</span></label><input type="number" value={m2} onChange={e => setM2(Number(e.target.value))} style={inp} step="0.1" /></div>
        <div><label style={lbl}>Shiller CAPE <span style={{fontSize:"0.6rem",color:"#64748b"}}>multpl.com</span></label><input type="number" value={cape} onChange={e => setCAPE(Number(e.target.value))} style={inp} step="0.1" /></div>
        <div><label style={lbl}>Credit Spread HY% <span style={{fontSize:"0.6rem",color:"#64748b"}}>BAMLH0A0HYM2</span></label><input type="number" value={credit} onChange={e => setCredit(Number(e.target.value))} style={inp} step="0.1" /></div>
        <div><label style={lbl}>Breakeven 5y% <span style={{fontSize:"0.6rem",color:"#64748b"}}>T5YIFR</span></label><input type="number" value={be} onChange={e => setBE(Number(e.target.value))} style={inp} step="0.01" /></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "0.75rem", marginTop: "0.75rem" }}>
        <div><label style={lbl}>Fed Balance Sheet (bill. $) <span style={{fontSize:"0.6rem",color:"#64748b"}}>WALCL</span></label><input type="number" value={fedBS ?? ''} onChange={e => { const v = e.target.value; setFedBS(v === '' ? undefined : Number(v)); }} style={inp} step="0.01" placeholder="ej: 6.80" /></div>
        <div><label style={lbl}>ECB Balance Sheet (bill. €) <span style={{fontSize:"0.6rem",color:"#64748b"}}>ECBASSETSW</span></label><input type="number" value={ecbBS ?? ''} onChange={e => { const v = e.target.value; setEcbBS(v === '' ? undefined : Number(v)); }} style={inp} step="0.01" placeholder="ej: 4.00" /></div>
      </div>
      <div style={{ marginTop: "8px", fontSize: "0.62rem", color: "#4b5563", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Fuentes: M2SL · Shiller CAPE · BAMLH0A0HYM2 · T5YIFR · WALCL · ECBASSETSW · Actualizado: {new Date(lastUpdated).toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}</span>
        <span style={{ color: isOverride ? "#fbbf24" : "#10b981", fontWeight: 600 }}>
          {isOverride ? "Usando: MANUAL (override)" : "Usando: FRED Server"}
        </span>
      </div>
    </div>
  );
};

export default FredManualPanel;
