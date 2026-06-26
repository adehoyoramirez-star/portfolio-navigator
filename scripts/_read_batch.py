import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'
s = io.open('src/dashboard/InstitutionalDashboard.tsx', 'r', encoding='utf-8').read()
lines = s.split('\n')

# Show sections content
sections = [
    ('MonteCarlo', 2956, 3064),
    ('Benchmark', 3506, 3567),
    ('StressTest', 3567, 3593),
    ('BTCCycle', 3684, 3809),
    ('Rebalance', 3856, 3971),
    ('SmartDCA', 4040, min(4120, len(lines))),
]

for name, start, end in sections:
    print(f'\n===== {name} (L{start}-L{end}) =====')
    for i in range(max(0, start-1), min(end, len(lines))):
        clean = ''.join(c if ord(c)<128 else '?' for c in lines[i][:160])
        print(f'L{i+1}: {clean}')
