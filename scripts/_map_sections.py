import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'
s = io.open('src/dashboard/InstitutionalDashboard.tsx', 'r', encoding='utf-8').read()
lines = s.split('\n')
print(f'Total lines: {len(lines)}')

# Find all section markers (after AlertsSection extraction)
markers = []
for i, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith('{/*') and len(stripped) > 10:
        markers.append((i+1, stripped[:130]))

print('\nSection markers after AlertsSection extraction:')
for ln, txt in markers:
    clean = ''.join(c if ord(c)<128 else '?' for c in txt)
    print(f'  L{ln}: {clean}')
