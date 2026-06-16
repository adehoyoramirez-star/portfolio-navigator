import os
with open('trade_journal.py','w',encoding='utf-8') as f:
    f.write(open('_journal_content.txt','r',encoding='utf-8').read())
print('Done')
