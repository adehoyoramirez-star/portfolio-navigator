import { useState } from 'react';
import InstitutionalDashboard from './dashboard/InstitutionalDashboard';
import TacticalDashboard from './dashboard/TacticalDashboard';

type View = 'olympus' | 'tactical';

export default function App() {
  const [view, setView] = useState<View>('olympus');
  return (
    <div style={{ minHeight: '100vh', background: '#0f172a' }}>
      <nav style={{
        background: '#1e293b',
        borderBottom: '1px solid #334155',
        padding: '0.6rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        position: 'sticky',
        top: 0,
        zIndex: 100
      }}>
        <span style={{ fontWeight: 800, fontSize: '0.9rem', color: '#f59e0b', marginRight: '1rem' }}>
          HENDE FUND
        </span>
        <button
          onClick={() => setView('olympus')}
          style={{
            padding: '0.4rem 1rem',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 700,
            background: view === 'olympus' ? '#1d4ed8' : 'transparent',
            color: view === 'olympus' ? '#fff' : '#64748b'
          }}>
          Olympus Engine
        </button>
        <button
          onClick={() => setView('tactical')}
          style={{
            padding: '0.4rem 1rem',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 700,
            background: view === 'tactical' ? '#1d4ed8' : 'transparent',
            color: view === 'tactical' ? '#fff' : '#64748b'
          }}>
          Motor Tactico
        </button>
      </nav>

      {view === 'olympus'  && <InstitutionalDashboard />}
      {view === 'tactical' && <TacticalDashboard />}
    </div>
  );
}