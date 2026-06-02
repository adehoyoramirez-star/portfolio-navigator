import re

with open('src/dashboard/InstitutionalDashboard.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

changes = []

# 1. Remove ollamaModel from type
content = content.replace('    ollamaModel?: string;
', '')
changes.append('Removed ollamaModel from type')

# 2. Remove ollamaModel state
content = content.replace("  const [ollamaModel, setOllamaModel] = useState<string>('llama3.1:8b');
", '')
changes.append('Removed ollamaModel state')

# 3. Remove aiCacheRef + callOllama + detectOllamaModel (everything between aiCacheRef and refreshAIIntelligence)
marker1 = '  const aiCacheRef = React.useRef<{ hash: string; result: any; expiresAt: number } | null>(null);'
marker2 = '  const refreshAIIntelligence = async () => {'
idx1 = content.find(marker1)
idx2 = content.find(marker2)
if idx1 >= 0 and idx2 > idx1:
    content = content[:idx1] + content[idx2:]
    changes.append('Removed aiCacheRef + callOllama + detectOllamaModel')

# 4. Replace old refreshAIIntelligence with new version that calls Edge Function
old_start = content.find('const refreshAIIntelligence = async () => {')
if old_start >= 0:
    brace_count = 0
    found_first_brace = False
    end = old_start
    for i in range(old_start, len(content)):
        if content[i] == '{':
            brace_count += 1
            found_first_brace = True
        elif content[i] == '}':
            brace_count -= 1
            if found_first_brace and brace_count == 0:
                end = i + 1
                break
    if end < len(content) and content[end] == ';':
        end += 1
    while end < len(content) and content[end] in '
 	':
        end += 1
    
    new_func = '''  const refreshAIIntelligence = async () => {
    if (!engineResult) return;
    setAiLoading(true);
    try {
      const contradictions: string[] = [];
      if (dxy > 103 && wtiOil > 90) contradictions.push('DXY alto + Brent alto (senales opuestas)');
      if (vix > 28 && rsi > 65) contradictions.push('VIX panico + RSI sobrecompra (incoherente)');
      if (creditSpread > 4.5 && manualPER > 26) contradictions.push('Credit spread elevado + PER caro');

      const totalPortfolioVal = portfolio.assets.reduce((s, a) => s + a.price * a.shares, 0);
      const ts = new Date().toISOString();

      const ctxBody = {
        regime: engineResult.regime,
        regimePenalty: engineResult.masterRegime.regimePenalty ?? 1,
        probCrisis: (engineResult.masterRegime as any).crisisProb ?? 0,
        vix, move: moveIndex, bond10y: manualBond10y, bond2y, creditSpread, m2Growth, dxy,
        brent: wtiOil, btcPrice: portfolio.assets.find(a => a.ticker === 'BTC-EUR')?.price ?? 0,
        btcRsi: btcRsiWeekly ?? 50, btcDominance, mvrv: mvrvRatio ?? 0,
        fearGreed: fearGreedIndex?.value ?? 50, fearGreedLabel: fearGreedIndex?.label ?? 'N/D',
        totalValue: totalPortfolioVal, portfolioVol: portfolioVol ?? 0.18, drawdown: portfolioDrawdown ?? 0,
        muEffective: Math.min(0.15, expectedReturn),
        contradictions,
      };

      const { data, error } = await supabase.functions.invoke('ai-intelligence', { body: ctxBody });

      if (error || !data) {
        throw new Error(typeof error === 'string' ? error : 'Edge Function returned no data');
      }

      const output = {
        gemini: data.gemini ?? null,
        claude: data.claude ?? null,
        grok: data.grok ?? null,
        fetchedAt: ts,
        cacheHit: data.cacheHit ?? false,
      };

      setAiIntelligence(output);

      if (data.grok?.blackSwanAlert && data.grok?.blackSwanReason && !data.grok?.error) {
        supabase.functions.invoke('telegram-alerts', {
          body: {
            type: 'black_swan',
            blackSwanReason: data.grok.blackSwanReason,
            currentRegime: engineResult.regime,
            vix,
          },
        }).catch(() => {});
      }

    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      const ts = new Date().toISOString();
      const errResult = {
        error: errMsg.slice(0, 300),
        model: 'gemini', cachedAt: ts,
      };
      setAiIntelligence({
        gemini: { regimeNarrative: '', macroValidation: '', btcCycleSummary: '', ...errResult },
        claude: { elliottAnalysis: '', rebalanceAdvice: '', contradictionAnalysis: '', ...errResult },
        grok: { marketSentiment: '', topNarratives: [], blackSwanAlert: false, blackSwanReason: null, ...errResult },
        fetchedAt: ts, cacheHit: false,
      });
    } finally {
      setAiLoading(false);
    }
  };'''
    
    content = content[:old_start] + new_func + content[end:]
    changes.append('Rewrote refreshAIIntelligence to use Edge Function')

# 5. Update UI strings
content = content.replace('Ollama Local', 'Gemini Flash')
content = content.replace('ollamaModel ?? ollamaModel', 'gemini?.model ?? 'Gemini Flash'')
changes.append('Updated UI strings')

with open('src/dashboard/InstitutionalDashboard.tsx', 'w', encoding='utf-8', newline='') as f:
    f.write(content)

print('Changes:', ', '.join(changes))
print('Lines:', content.count('
'))
