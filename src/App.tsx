import { useState } from 'react';
import InstitutionalDashboard from './dashboard/InstitutionalDashboard';
import TacticalDashboard from './dashboard/TacticalDashboard';

type View = 'olympus' | 'tactical';

export default function App() {
  const [view, setView] = useState<View>('olympus');
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <nav className="app-nav">
        <span className="app-nav-brand">
          HENDE FUND
        </span>
        <button
          onClick={() => setView('olympus')}
          className={`app-nav-btn ${view === 'olympus' ? 'app-nav-btn--active' : 'app-nav-btn--inactive'}`}>
          Olympus Engine
        </button>
        <button
          onClick={() => setView('tactical')}
          className={`app-nav-btn ${view === 'tactical' ? 'app-nav-btn--active' : 'app-nav-btn--inactive'}`}>
          Motor Tactico
        </button>
      </nav>

      <div className="animate-fade-in">
        {view === 'olympus'  && <InstitutionalDashboard />}
        {view === 'tactical' && <TacticalDashboard />}
      </div>
    </div>
  );
}