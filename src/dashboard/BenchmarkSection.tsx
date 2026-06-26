interface Props {
  benchmarkStatus: { dataPoints: number; underperformanceAlert: boolean; engineCagr3m: number; benchmarkCagr3m: number; outperformance: number; engineSharpe3m: number; benchmarkSharpe3m: number; message: string; lastUpdated: string; } | null;
  cardStyle: React.CSSProperties;
  getBenchmarkComposition: () => Array<{ ticker: string; weight: number }>;
}

const BenchmarkSection: React.FC<Props> = ({ benchmarkStatus, cardStyle, getBenchmarkComposition }) => {
  if (!benchmarkStatus || benchmarkStatus.dataPoints < 2) return null;
  return (
      {/* SPRINT-3: Benchmark 60/40 vs Engine */}{/* SPRINT-3: Benchmark 60/40 vs Engine */}
      {benchmarkStatus && benchmarkStatus.dataPoints >= 2 && (
        <div style={{
          ...styles.card,
          border: benchmarkStatus.underperformanceAlert
            ? '2px solid #ef4444'
            : '1px solid #374151',
          background: benchmarkStatus.underperformanceAlert
            ? 'linear-gradient(135deg, #1c0a0a 0%, #111827 100%)'
            : '#111827',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <h4 style={{ margin: 0, fontSize: '0.82rem', color: '#e2e8f0' }}>
              📊 Benchmark 60/40
            </h4>
            <span style={{ fontSize: '0.62rem', color: '#64748b' }}>
              {benchmarkStatus.dataPoints} snapshots · {new Date(benchmarkStatus.lastUpdated).toLocaleDateString('es-ES')}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem' }}>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Engine CAGR (3m)</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.engineCagr3m > 0 ? '#10b981' : '#ef4444' }}>{(benchmarkStatus.engineCagr3m * 100).toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Benchmark CAGR (3m)</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.benchmarkCagr3m > 0 ? '#10b981' : '#ef4444' }}>{(benchmarkStatus.benchmarkCagr3m * 100).toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Outperformance</div>
              <div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.outperformance > 0 ? '#10b981' : benchmarkStatus.underperformanceAlert ? '#ef4444' : '#f59e0b' }}>{(benchmarkStatus.outperformance * 100).toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Engine Sharpe (3m)</div>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: benchmarkStatus.engineSharpe3m > 1 ? '#10b981' : benchmarkStatus.engineSharpe3m > 0.5 ? '#f59e0b' : '#ef4444' }}>{benchmarkStatus.engineSharpe3m.toFixed(2)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Benchmark Sharpe (3m)</div>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: benchmarkStatus.benchmarkSharpe3m > 1 ? '#10b981' : benchmarkStatus.benchmarkSharpe3m > 0.5 ? '#f59e0b' : '#ef4444' }}>{benchmarkStatus.benchmarkSharpe3m.toFixed(2)}</div>
            </div>
          </div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: benchmarkStatus.underperformanceAlert ? '#fca5a5' : '#94a3b8', padding: '0.35rem 0.5rem', background: benchmarkStatus.underperformanceAlert ? '#1c0a0a' : '#1e293b', borderRadius: '4px' }}>
            {benchmarkStatus.underperformanceAlert && '🔴 '}
            {benchmarkStatus.message}
          </div>
          <details style={{ marginTop: '0.4rem' }}>
            <summary style={{ fontSize: '0.65rem', color: '#6b7280', cursor: 'pointer' }}>Composición del benchmark 60/40</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
              {(() => {
                const comp = getBenchmarkComposition();
                return comp.map(c => (
                  <span key={c.ticker} style={{ fontSize: '0.62rem', background: '#1e293b', padding: '2px 6px', borderRadius: '3px', color: '#94a3b8' }}>
                    {c.ticker} {(c.weight * 100).toFixed(0)}%
                  </span>
                ));
              })()}
            </div>
          </details>
        </div>
      )}

      {/* Stress Scenarios */}  );
};

export default BenchmarkSection;
