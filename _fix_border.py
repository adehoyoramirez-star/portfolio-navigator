with open('src/dashboard/InstitutionalDashboard.tsx','r',encoding='utf-8') as f:
    c = f.read()

# Fix the broken border property (${...} was stripped by bash heredoc)
old = 'borderRadius: "6px", border:  }}>'
new = 'borderRadius: "6px", border: `1px solid ${enableJumps ? "#ef4444" : "#10b981"}` }}>'
c = c.replace(old, new)

# Check if there's a duplicate partial block before the real one
# The first script created a partial block (lines 2367-2369 are orphaned text)
# Look for and remove the orphaned trailing text from first attempt
old2 = '            </div>\n            \n            <div style={{ marginTop: "0.6rem"'
count = c.count(old2)
print(f'Found {count} occurrences of checkbox block start')

open('src/dashboard/InstitutionalDashboard.tsx','w',encoding='utf-8').write(c)
print('Border fix applied')
