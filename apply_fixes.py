import re

f = r"src\dashboard\TacticalDashboard.tsx"

with open(f, 'r', encoding='utf-8') as fh:
    c = fh.read()

# Fix 1: estados locales (ya aplicado, verificar)
if 'sharesP' not in c:
    c = c.replace(
        'const [exitP, setExitP] = useState(pos.currentPrice.toFixed(2));',
        '''const [exitP,   setExitP]   = useState(pos.currentPrice.toFixed(2));
    const [currP,   setCurrP]   = useState(pos.currentPrice.toFixed(2));
    const [entryP,  setEntryP]  = useState(pos.entryPrice.toFixed(2));
    const [sharesP, setSharesP] = useState(String(pos.shares));'''
    )
    print("Fix 1 aplicado")
else:
    print("Fix 1 ya estaba")

# Fix 2: celda Entrada editable
old2 = '''          {/* Entrada */}
          <td style={S.td}>
            <div>€{pos.entryPrice.toFixed(2)}</div>
            <div style={{ fontSize:'0.65rem', color:'#64748b' }}>{pos.shares} uds</div>
            <div style={{ fontSize:'0.6rem', color:'#475569' }}>€{pos.totalInvested.toFixed(0)} inv.</div>
          </td>'''
new2 = '''          {/* Entrada — editable */}
          <td style={S.td}>
            <input type="number" step="0.01" value={entryP}
              onChange={e => setEntryP(e.target.value)}
              onBlur={() => {
                const v = parseFloat(entryP);
                if (v > 0) setState(prev => ({
                  ...prev,
                  openPositions: prev.openPositions.map(p =>
                    p.id === pos.id ? {
                      ...p, entryPrice: v,
                      totalInvested: v * p.shares,
                      capitalRisked: (v - p.stopLoss) * p.shares,
                      unrealizedPnL: (p.currentPrice - v) * p.shares,
                      unrealizedPnLPct: (p.currentPrice / v - 1) * 100,
                    } : p)
                }));
              }}
              style={{ ...S.input, width:72, marginBottom:2 }} />
            <input type="number" step="1" min="0.000001" value={sharesP}
              onChange={e => setSharesP(e.target.value)}
              onBlur={() => {
                const v = parseFloat(sharesP);
                if (v > 0) setState(prev => ({
                  ...prev,
                  openPositions: prev.openPositions.map(p =>
                    p.id === pos.id ? {
                      ...p, shares: v,
                      totalInvested: p.entryPrice * v,
                      capitalRisked: (p.entryPrice - p.stopLoss) * v,
                      unrealizedPnL: (p.currentPrice - p.entryPrice) * v,
                      unrealizedPnLPct: (p.currentPrice / p.entryPrice - 1) * 100,
                    } : p)
                }));
              }}
              style={{ ...S.input, width:72, marginBottom:2 }} />
            <div style={{ fontSize:'0.6rem', color:'#475569' }}>€{pos.totalInvested.toFixed(0)} inv.</div>
          </td>'''
if old2 in c:
    c = c.replace(old2, new2, 1)
    print("Fix 2 aplicado: entrada+acciones editables")
else:
    print("Fix 2 no encontrado - puede que ya este aplicado")

# Fix 3: precio actual editable
old3 = '''          {/* Precio actual + días para verde */}
          <td style={S.td}>
            <div style={{ fontWeight:700, color: inGreen ? '#22c55e' : '#f8fafc' }}>
              €{pos.currentPrice.toFixed(2)}
            </div>
            <div style={{ fontSize:'0.65rem', color: inGreen ? '#22c55e' : '#f59e0b' }}>
              {dtbLabel}
            </div>
          </td>'''
new3 = '''          {/* Precio actual — editable */}
          <td style={S.td}>
            <input type="number" step="0.01" value={currP}
              onChange={e => setCurrP(e.target.value)}
              onBlur={() => {
                const v = parseFloat(currP);
                if (v > 0) {
                  setState(prev => ({
                    ...prev,
                    openPositions: prev.openPositions.map(p =>
                      p.id === pos.id ? {
                        ...p, currentPrice: v,
                        unrealizedPnL: (v - p.entryPrice) * p.shares,
                        unrealizedPnLPct: (v / p.entryPrice - 1) * 100,
                      } : p)
                  }));
                  setExitP(v.toFixed(2));
                }
              }}
              style={{ ...S.input, width:72, marginBottom:2,
                color: parseFloat(currP) >= pos.entryPrice ? '#22c55e' : '#f8fafc',
                fontWeight: 700 }} />
            <div style={{ fontSize:'0.65rem', color: inGreen ? '#22c55e' : '#f59e0b' }}>
              {dtbLabel}
            </div>
          </td>'''
if old3 in c:
    c = c.replace(old3, new3, 1)
    print("Fix 3 aplicado: precio actual editable")
else:
    print("Fix 3 no encontrado - puede que ya este aplicado")

# Fix 4: botones TP1 y TP2 separados
old4 = '''            <div style={{ display:'flex', gap:4, alignItems:'center', marginBottom:4 }}>
              <input style={{ ...S.input, width:72 }} type="number" value={exitP}
                onChange={e => setExitP(e.target.value)} step="0.01" />
              <button style={{ ...S.btn, ...S.btnG, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_TP')}>TP</button>
              <button style={{ ...S.btn, ...S.btnR, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_SL')}>SL</button>
              <button style={{ ...S.btn, ...S.btnGr, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_MANUAL')}>M</button>
            </div>'''
new4 = '''            <div style={{ display:'flex', gap:4, alignItems:'center', marginBottom:4, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:68 }} type="number" value={exitP}
                onChange={e => setExitP(e.target.value)} step="0.01" />
              <button style={{ ...S.btn, ...S.btnG, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => { setExitP(pos.takeProfit1.toFixed(2)); handleClose(pos.id, pos.takeProfit1, 'CLOSED_TP'); }}
                title={`Cerrar en TP1 €${pos.takeProfit1.toFixed(2)}`}>TP1</button>
              <button style={{ ...S.btn, background:'#14532d', color:'#86efac', border:'1px solid #22c55e', padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => { setExitP(pos.takeProfit2.toFixed(2)); handleClose(pos.id, pos.takeProfit2, 'CLOSED_TP'); }}
                title={`Cerrar en TP2 €${pos.takeProfit2.toFixed(2)}`}>TP2</button>
              <button style={{ ...S.btn, ...S.btnR, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_SL')}>SL</button>
              <button style={{ ...S.btn, ...S.btnGr, padding:'4px 5px', fontSize:'0.65rem' }}
                onClick={() => handleClose(pos.id, parseFloat(exitP), 'CLOSED_MANUAL')}>M</button>
            </div>'''
if old4 in c:
    c = c.replace(old4, new4, 1)
    print("Fix 4 aplicado: botones TP1 y TP2")
else:
    print("Fix 4 no encontrado - puede que ya este aplicado")

# Fix 5: boton reabrir en posiciones cerradas
old5 = '''                          {pos.status === 'CLOSED_TP' ? '✅ TP' : pos.status === 'CLOSED_SL' ? '🛑 SL' : pos.status === 'CLOSED_TIME' ? '⏰ Tiempo' : '📤 Manual'}
                        </span>
                      </td>
                    </tr>
                  ))}\n                </tbody>'''
new5 = '''                          {pos.status === 'CLOSED_TP' ? '✅ TP' : pos.status === 'CLOSED_SL' ? '🛑 SL' : pos.status === 'CLOSED_TIME' ? '⏰ Tiempo' : '📤 Manual'}
                        </span>
                      </td>
                      <td style={S.td}>
                        <button
                          style={{ ...S.btn, background:'#1e3a5f', color:'#93c5fd', border:'1px solid #3b82f6', padding:'3px 7px', fontSize:'0.62rem' }}
                          title="Reabrir posicion cerrada por error"
                          onClick={() => setState(prev => {
                            const pos2 = prev.closedPositions.find(p => p.id === pos.id);
                            if (!pos2) return prev;
                            const reopened = { ...pos2, status: 'OPEN' as const, exitDate: null, exitPrice: null, exitReason: null, realizedPnL: null, realizedPnLPct: null };
                            return {
                              ...prev,
                              openPositions: [...prev.openPositions, reopened],
                              closedPositions: prev.closedPositions.filter(p => p.id !== pos.id),
                            };
                          })}>
                          Reabrir
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>'''
if old5 in c:
    c = c.replace(old5, new5, 1)
    print("Fix 5 aplicado: boton Reabrir")
else:
    print("Fix 5 no encontrado - puede que ya este aplicado")

# Fix 6: reset preserva posiciones
old6 = '''                const fresh = initTacticalState(state.config);
                setState({ ...fresh, openPositions: buildDemoPositions() });'''
new6 = '''                const fresh = initTacticalState(state.config);
                setState({ ...fresh, openPositions: state.openPositions });'''
if old6 in c:
    c = c.replace(old6, new6, 1)
    print("Fix 6 aplicado: reset preserva posiciones")
else:
    print("Fix 6 no encontrado - puede que ya este aplicado")

with open(f, 'w', encoding='utf-8') as fh:
    fh.write(c)

print("\nVerificacion final:")
print("onBlur count:", c.count('onBlur'))
print("BAYN count:", c.count('BAYN'))
print("TP1 button:", 'TP1</button>' in c)
print("Reabrir:", 'Reabrir' in c)
