import { useState } from 'react';
import InstitutionalDashboard from './dashboard/InstitutionalDashboard';
import TacticalDashboard from './dashboard/TacticalDashboard';

type View = 'olympus' | 'tactical';

export default function App() {
  const [view, setView] = useState<View>('olympus');
  return (
    <div style={{ minHeight: '100vh', background: '#0f172a' }}>
      <nav style={{ background:'#1e293b', borderBottom:'1px solid #334155', padding:'0.6rem 1.5rem', display:'flex', alignItems:'center', gap:'0.5rem', position:'sticky', top:0, zIndex:100 }}>
        <span style={{ fontWeight:800, fontSize:'0.9rem', color:'#f59e0b', marginRight:'1rem' }}>HENDE FUND</span>
        {([
          { id:'olympus' as View,  label:'🏛 Olympus Engine' },
          { id:'tactical' as View, label:'⚡ Motor Táctico'  },
        ]).map(item => (
          <button key={item.id} onClick={() => setView(item.id)}
            style={{ padding:'0.4rem 1rem', borderRadius:6, border:'none', cursor:'pointer', fontSize:'0.8rem', fontWeight:700,
              background: view === item.id ? '#1d4ed8' : 'transparent',
              color:      view === item.id ? '#fff'    : '#64748b' }}>
            {item.label}
          </button>
        ))}
      </nav>
      {view === 'olympus'  && <InstitutionalDashboard />}
      {view === 'tactical' && <TacticalDashboard />}
    </div>
  );
}
