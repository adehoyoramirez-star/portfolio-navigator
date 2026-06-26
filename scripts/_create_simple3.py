import io, os, sys
os.environ['PYTHONIOENCODING'] = 'utf-8'

DASHBOARD = 'src/dashboard/InstitutionalDashboard.tsx'
NL = chr(10)

stress_content = '''// ===============================================
// COMPONENTE: StressTestSection.tsx
// Extraido de InstitutionalDashboard.tsx
// ===============================================

import type { StressResult } from "@/core/risk/stressTest";

interface StressTestSectionProps {
  stressResults: StressResult[];
  cardStyle: React.CSSProperties;
}

const StressTestSection: React.FC<StressTestSectionProps> = ({ stressResults, cardStyle }) => {
  if (stressResults.length === 0) return null;

  return (
    <div style={cardStyle}>
      <h2>Stress Testing - Escenarios Historicos</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.75rem" }}>
        {stressResults.map((s: StressResult) => (
          <div key={s.scenarioId} style={{
            backgroundColor: s.portfolioReturn < -0.30 ? "#450a0a" : s.portfolioReturn < -0.15 ? "#422006" : "#111827",
            border: `1px solid ${s.portfolioReturn < -0.30 ? "#ef4444" : s.portfolioReturn < -0.15 ? "#f59e0b" : "#374151"}`,
            borderRadius: 8, padding: "0.75rem",
          }}>
            <p style={{ fontWeight: "bold", fontSize: "0.82rem", marginBottom: "0.4rem", color: "#f9fafb" }}>{s.scenarioName}</p>
            <div style={{ fontSize: "2rem", fontWeight: "bold", color: s.portfolioReturn < -0.20 ? "#fca5a5" : s.portfolioReturn < -0.10 ? "#fde68a" : "#10b981" }}>
              {(s.portfolioReturn * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>
              {Math.abs(s.portfolioDrawdown).toFixed(0)} {s.portfolioDrawdown < 0 ? "perdida" : "ganancia"} . {s.recoveryEstimateMonths}m recuperacion
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StressTestSection;
'''

bench_content = '''// ===============================================
// COMPONENTE: BenchmarkSection.tsx
// Extraido de InstitutionalDashboard.tsx
// ===============================================

interface BenchmarkSectionProps {
  benchmarkStatus: {
    dataPoints: number;
    underperformanceAlert: boolean;
    engineCagr3m: number;
    benchmarkCagr3m: number;
    outperformance: number;
    engineSharpe3m: number;
    benchmarkSharpe3m: number;
    message: string;
    lastUpdated: string;
  } | null;
  cardStyle: React.CSSProperties;
  getBenchmarkComposition: () => Array<{ ticker: string; weight: number }>;
}

const BenchmarkSection: React.FC<BenchmarkSectionProps> = ({
  benchmarkStatus,
  cardStyle,
  getBenchmarkComposition,
}) => {
  if (!benchmarkStatus || benchmarkStatus.dataPoints < 2) return null;

  return (
    <div style={{
      ...cardStyle,
      border: benchmarkStatus.underperformanceAlert ? '2px solid #ef4444' : '1px solid #374151',
      background: benchmarkStatus.underperformanceAlert ? 'linear-gradient(135deg, #1c0a0a 0%, #111827 100%)' : '#111827',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.82rem', color: '#e2e8f0' }}>Benchmark 60/40</h4>
        <span style={{ fontSize: '0.62rem', color: '#64748b' }}>
          {benchmarkStatus.dataPoints} snapshots . {new Date(benchmarkStatus.lastUpdated).toLocaleDateString('es-ES')}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.5rem' }}>
        <div><div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Engine CAGR (3m)</div><div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.engineCagr3m > 0 ? '#10b981' : '#ef4444' }}>{(benchmarkStatus.engineCagr3m * 100).toFixed(2)}%</div></div>
        <div><div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Benchmark CAGR (3m)</div><div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.benchmarkCagr3m > 0 ? '#10b981' : '#ef4444' }}>{(benchmarkStatus.benchmarkCagr3m * 100).toFixed(2)}%</div></div>
        <div><div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Outperformance</div><div style={{ fontSize: '0.95rem', fontWeight: 'bold', color: benchmarkStatus.outperformance > 0 ? '#10b981' : benchmarkStatus.underperformanceAlert ? '#ef4444' : '#f59e0b' }}>{(benchmarkStatus.outperformance * 100).toFixed(2)}%</div></div>
        <div><div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Engine Sharpe (3m)</div><div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: benchmarkStatus.engineSharpe3m > 1 ? '#10b981' : benchmarkStatus.engineSharpe3m > 0.5 ? '#f59e0b' : '#ef4444' }}>{benchmarkStatus.engineSharpe3m.toFixed(2)}</div></div>
        <div><div style={{ fontSize: '0.62rem', color: '#6b7280' }}>Benchmark Sharpe (3m)</div><div style={{ fontSize: '0.8rem', fontWeight: 'bold', color: benchmarkStatus.benchmarkSharpe3m > 1 ? '#10b981' : benchmarkStatus.benchmarkSharpe3m > 0.5 ? '#f59e0b' : '#ef4444' }}>{benchmarkStatus.benchmarkSharpe3m.toFixed(2)}</div></div>
      </div>
      <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: benchmarkStatus.underperformanceAlert ? '#fca5a5' : '#94a3b8', padding: '0.35rem 0.5rem', background: benchmarkStatus.underperformanceAlert ? '#1c0a0a' : '#1e293b', borderRadius: '4px' }}>
        {benchmarkStatus.underperformanceAlert ? 'ALERT ' : ''}{benchmarkStatus.message}
      </div>
      <details style={{ marginTop: '0.4rem' }}>
        <summary style={{ fontSize: '0.65rem', color: '#6b7280', cursor: 'pointer' }}>Composicion del benchmark 60/40</summary>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
          {getBenchmarkComposition().map(c => (
            <span key={c.ticker} style={{ fontSize: '0.62rem', background: '#1e293b', padding: '2px 6px', borderRadius: '3px', color: '#94a3b8' }}>
              {c.ticker} {(c.weight * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      </details>
    </div>
  );
};

export default BenchmarkSection;
'''

# Write files
io.open('src/dashboard/StressTestSection.tsx', 'w', encoding='utf-8').write(stress_content)
print(f'OK StressTestSection: {len(stress_content)} chars')
io.open('src/dashboard/BenchmarkSection.tsx', 'w', encoding='utf-8').write(bench_content)
print(f'OK BenchmarkSection: {len(bench_content)} chars')

# Replace in dashboard
s = io.open(DASHBOARD, 'r', encoding='utf-8').read()
lines = s.split(NL)

old_stress = NL.join(lines[3566:3593])
new_stress = '      <StressTestSection stressResults={stressResults} cardStyle={styles.card} />'
if old_stress in s:
    s = s.replace(old_stress, new_stress, 1)
    print('OK StressTest replacement')
else:
    print('ERR StressTest block not found')
    sys.exit(1)

old_bench = NL.join(lines[3505:3567])
new_bench = '      <BenchmarkSection benchmarkStatus={benchmarkStatus} cardStyle={styles.card} getBenchmarkComposition={getBenchmarkComposition} />'
if old_bench in s:
    s = s.replace(old_bench, new_bench, 1)
    print('OK Benchmark replacement')
else:
    print('ERR Benchmark block not found')
    sys.exit(1)

io.open(DASHBOARD, 'w', encoding='utf-8').write(s)

# Add imports
s2 = io.open(DASHBOARD, 'r', encoding='utf-8').read()
lines2 = s2.split(NL)
new_imports = [
    'import StressTestSection from "@/dashboard/StressTestSection";',
    'import BenchmarkSection from "@/dashboard/BenchmarkSection";',
]

# Insert after AlertsSection import
inserted = False
new_lines = []
for line in lines2:
    new_lines.append(line)
    if 'import AlertsSection' in line and not inserted:
        for imp in new_imports:
            new_lines.append(imp)
        inserted = True

if inserted:
    s2 = NL.join(new_lines)
    io.open(DASHBOARD, 'w', encoding='utf-8').write(s2)
    print('OK Imports added')
else:
    print('WARN imports not added')

new_count = len(io.open(DASHBOARD, 'r', encoding='utf-8').read().split(NL))
print(
