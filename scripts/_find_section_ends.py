import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'
s = io.open('src/dashboard/InstitutionalDashboard.tsx', 'r', encoding='utf-8').read()
lines = s.split('\n')

# Find the NEXT major {/* comment after each section
sections_to_show = ['Monte Carlo', 'Benchmark', 'Stress Test', 'BTC Cycle', 'Rebalance', 'Smart DCA']

# Find all {/* comment line numbers
comment_lines = []
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith('{/*') and len(stripped) > 10:
        comment_lines.append((i+1, stripped[:120]))

print('All major JSX comment markers:')
for ln, txt in comment_lines:
    clean = ''.join(c if ord(c)<128 else '?' for c in txt)
    print(f'  L{ln}: {clean}')
