const fs=require('fs');
let s=fs.readFileSync('src/dashboard/InstitutionalDashboard.tsx','utf8');
s=s.replace('setAiIntelligence(output);','setAiIntelligence({ai:output.ai??null,fetchedAt:output.fetchedAt??new Date().toISOString(),cacheHit:output.cacheHit??false});');
s=s.replace("ai: { regimeNarrative: '', macroValidation: '', btcCycleSummary: '', ...errResult },","ai: { regimeNarrative: '', macroValidation: '', btcCycleSummary: '', marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null, elliottAnalysis: '', rebalanceAdvice: '', contradictionAnalysis: '', ...errResult },");
fs.writeFileSync('src/dashboard/InstitutionalDashboard.tsx',s);console.log('done')
