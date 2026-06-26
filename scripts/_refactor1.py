import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'

# Read dashboard
s = io.open('src/dashboard/InstitutionalDashboard.tsx', 'r', encoding='utf-8').read()
lines = s.split('\n')
print(f'Total lines: {len(lines)}')

# Show line 3326 context
for i in range(3324, 3330):
    print(f'{i+1}: {lines[i][:120]}')
