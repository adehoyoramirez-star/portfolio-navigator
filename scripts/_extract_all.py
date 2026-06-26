import io, os, sys
os.environ['PYTHONIOENCODING'] = 'utf-8'

DASHBOARD = 'src/dashboard/InstitutionalDashboard.tsx'
s = io.open(DASHBOARD, 'r', encoding='utf-8').read()
lines = s.split('\n')
print(f'Dashboard: {len(lines)} lines')

# Copy each section to a temp file for analysis
sections = {
    'MonteCarlo': (2956, 3064),
    'Benchmark': (3506, 3567),
    'StressTest': (3567, 3593),
    'BTCCycle': (3684, 3809),
    'Rebalance': (3856, 3971),
    'SmartDCA': (4040, len(lines)),
}

for name, (start, end) in sections.items():
    block = '\n'.join(lines[start-1:end])
    outpath = f'scripts/_section_{name}.txt'
    io.open(outpath, 'w', encoding='utf-8').write(block)
    print(f'{name}: L{start}-L{end} = {len(block)} chars -> {outpath}')

print('\nDone! All sections extracted.')
