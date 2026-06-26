import io, os
os.environ['PYTHONIOENCODING'] = 'utf-8'

path = 'src/dashboard/InstitutionalDashboard.tsx'
s = io.open(path, 'r', encoding='utf-8').read()
lines = s.split('\n')

# The Alerts section is lines 3326-3355 (0-indexed 3325-3354)
old_block = '\n'.join(lines[3325:3355])

new_block = '''      <AlertsSection
        activeAlerts={activeAlerts}
        dismissedAlerts={dismissedAlerts}
        onDismissAlert={(id) => setDismissedAlerts(prev => new Set([...prev, id]))}
        cardStyle={styles.card}
      />'''

if old_block in s:
    s = s.replace(old_block, new_block, 1)
    print('Replacement OK')
else:
    print('ERROR: old block not found!')
    print('First 150 chars of old block:', repr(old_block[:150]))
    import sys; sys.exit(1)

# Add import after the RegimeAlert import
import_marker = 'import { generateAlerts, RegimeAlert } from "@/core/alerts/regimeAlerts";'
new_import = '\nimport AlertsSection from "@/dashboard/AlertsSection";'
if import_marker in s:
    s = s.replace(import_marker, import_marker + new_import, 1)
    print('Import added')
else:
    print('WARNING: import marker not found')

io.open(path, 'w', encoding='utf-8').write(s)
print(f'File saved: {len(s)} chars, {len(s.split(chr(10)))} lines')
