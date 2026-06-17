with open('src/dashboard/InstitutionalDashboard.tsx','r',encoding='utf-8') as f:
    c = f.read()

old = '<p style={{ fontSize: "0.6rem", color: "#6b7280", margin: "0.15rem 0 0" }}>Típico: 0.08–0.15</p>\n            </div>'

checkbox_block = '''<p style={{ fontSize: "0.6rem", color: "#6b7280", margin: "0.15rem 0 0" }}>Típico: 0.08–0.15</p>
            </div>
            
            <div style={{ marginTop: "0.6rem", padding: "0.4rem 0.6rem", background: enableJumps ? "#1c0a0a" : "#071c10", borderRadius: "6px", border: `1px solid $''' + '''{enableJumps ? "#ef4444" : "#10b981"}` }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.68rem", color: "#d1d5db", fontWeight: 600 }}>
                <input type="checkbox" checked={enableJumps} onChange={(e) => setEnableJumps(e.target.checked)}
                  style={{ width: "14px", height: "14px", accentColor: "#10b981", cursor: "pointer" }} />
                {enableJumps ? "🔴 Jump Diffusion (Stress Test)" : "🟢 GBM Puro (Proyección de crecimiento)"}
              </label>
              <p style={{ fontSize: "0.55rem", color: "#6b7280", margin: "0.15rem 0 0" }}>
                {enableJumps 
                  ? "Incluye crashes aleatorios — muestra riesgo de cola, no crecimiento esperado."
                  : "Sin saltos — muestra el crecimiento real compuesto al μ anual declarado."}
              </p>
            </div>'''

c = c.replace(old, checkbox_block)
open('src/dashboard/InstitutionalDashboard.tsx','w',encoding='utf-8').write(c)
print('FIX 2 done')
