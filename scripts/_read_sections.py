import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'
s = io.open('src/dashboard/InstitutionalDashboard.tsx', 'r', encoding='utf-8').read()
lines = s.split('\n')

# Find section boundaries using markers
markers = {
    'BTC Cycle': 3707,
    'Monte Carlo': 2955,
    'Stress Test': 3590,
    'Benchmark': 3529,
    'Rebalance': 3879,
    'Smart DCA': 4141,
}

# Find where each section ends by looking for the next section marker
sorted_starts = sorted([(v, k) for k, v in markers.items()])

for i, (start_ln, name) in enumerate(sorted_starts):
    start_idx = start_ln - 1  # 0-indexed
    # Find end: next section start or end of file
    if i + 1 < len(sorted_starts):
        end_idx = sorted_starts[i+1][0] - 1
    else:
        end_idx = len(lines)
    
    # But sections may overlap or be nested. Let's show 5 lines before and 5 after the marker
    print(f'\n===== {name} (line {start_ln}) =====')
    # Show lines around the marker
    for j in range(max(0, start_idx-2), min(len(lines), start_idx+3)):
        clean = ''.join(c if ord(c)<128 else '?' for c in lines[j][:150])
        print(f'  L{j+1}: {clean}')
