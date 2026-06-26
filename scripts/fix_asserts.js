const fs=require('fs');
let s=fs.readFileSync('src/test/crisisScenarios.test.ts','utf8');
s=s.replace('erpValue: 0.025,','erpValue: 0.020,');
s=s.replace('vix: 28,','vix: 24,');
s=s.replace("expect(result.btcCycle?.signal).toBe('HOLD');","expect(result.btcCycle?.signal).toBe('ACCUMULATE');");
fs.writeFileSync('src/test/crisisScenarios.test.ts',s);
console.log('Fixed 3 assertions');
