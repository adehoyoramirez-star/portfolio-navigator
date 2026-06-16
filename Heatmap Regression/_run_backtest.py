import pickle,json,os,time,warnings
import pandas as pd,numpy as np
warnings.filterwarnings('ignore')

print('Loading 5Y cache...')
with open('backtest_5y_cache.pkl', 'rb') as f:
    data = pickle.load(f)
closes = data['closes']
highs = data['highs']
lows = data['lows']
dates = closes.index
n_days = len(dates)
print(f'Data: {dates[0].strftime("%d/%m/%Y")} -> {dates[-1].strftime("%d/%m/%Y")} ({n_days}d, {len(closes.columns)} tickers)')

REBALANCE_DAYS = 5  # [v9-MEJORA] Semanal (5d) en vez de mensual (21d)
TOP_N = 10

# Accept MIN_HISTORY from CLI for stability testing
import sys as _sys
if len(_sys.argv) > 1:
    MIN_HISTORY = int(_sys.argv[1])
else:
    MIN_HISTORY = 252
INITIAL_CAPITAL = 10000.0

# [v9-MEJORA] Filtro SPY > MA200: solo operar en mercado alcista
USE_MA200_FILTER = len(_sys.argv) <= 1 or '--no-mafilter' not in _sys.argv
SPY_MA200_PERIOD = 200

# [FIX-COSTES] Costes de transacción realistas
# IBKR Pro: 8bps comisión + 5bps half-spread + 5bps slippage = 18bps por lado
COMMISSION_BPS = 8
SPREAD_BPS = 5
SLIPPAGE_BPS = 5
COST_PER_SIDE_BPS = COMMISSION_BPS + SPREAD_BPS + SLIPPAGE_BPS  # 18bps
COST_PER_TRADE_PCT = COST_PER_SIDE_BPS / 10000  # 0.0018 = 0.18% por trade

# [v9-SLTP-SEMANAL] SL/TP calibrados para rebalanceo semanal (5d)
# Con 5 dias de holding, 1.5 ATR ya es un movimiento significativo
# TP1: 60% a +1.5 ATR, TP2: 40% a +2.5 ATR
SL_ATR_MULT = 1.5
TP1_ATR_MULT = 1.5
TP2_ATR_MULT = 2.5
TP1_SCALE = 0.6
TP2_SCALE = 0.4

def compute_composite_v9_momentum(closes, idx):
    """[v9-MEJORA] Solo 5 factores de momentum con cross-sectional ranking.
    v9 demostro que RSI, ATR, reversal, MA dist, volratio tienen IC ~0.
    Los unicos factores con senal real: mom42, mom63, mom126, rs63, ram63."""
    window = closes.iloc[:idx]
    if len(window) < MIN_HISTORY: return None
    log_ret = np.log1p(window.pct_change().fillna(0))
    ret = window.pct_change().fillna(0)
    
    # 5 momentum factors (v9 evidence-based)
    mom42 = np.expm1(log_ret.rolling(42).sum()).iloc[-1]
    mom63 = np.expm1(log_ret.rolling(63).sum()).iloc[-1]
    mom126 = np.expm1(log_ret.rolling(126).sum()).iloc[-1]
    bm = mom63.median() if len(mom63.dropna()) > 0 else 0
    rs63 = mom63 - bm  # Relative strength vs universe median
    v63 = ret.rolling(63).std().replace(0, np.nan).iloc[-1]
    ram63 = mom63 / v63.fillna(1)  # Risk-adjusted momentum
    
    factors = {'mom42': mom42, 'mom63': mom63, 'mom126': mom126,
               'rs63': rs63, 'ram63': ram63}
    ranked = {name: f.rank(pct=True) * 100 if len(f.dropna()) >= 10 else pd.Series(50.0, index=f.index) for name, f in factors.items()}
    return pd.DataFrame(ranked).mean(axis=1)

# Mantener la funcion original para compatibilidad con modo baseline
# [FIX] Ahora siempre usa v9 momentum. Si se necesita la version original, usar git checkout.
USE_V9_MOMENTUM = True
compute_composite = compute_composite_v9_momentum

reb_dates = list(range(MIN_HISTORY, n_days, REBALANCE_DAYS))
print(f'Rebalances: {len(reb_dates)}')

equity_ew = [INITIAL_CAPITAL]
equity_sltp = [INITIAL_CAPITAL]
all_trades = []
t0 = time.time()

for ri, reb_idx in enumerate(reb_dates):
    if ri == len(reb_dates) - 1: break
    next_idx = reb_dates[ri + 1]
    comp = compute_composite(closes, reb_idx)
    period_ret_ew = 0
    period_ret_sltp = 0
    
    # [v9-MEJORA] Filtro SPY > MA200: si SPY esta debajo de MA200, no operar
    if USE_MA200_FILTER and 'SPY' in closes.columns:
        spy_window = closes['SPY'].iloc[max(0, reb_idx-SPY_MA200_PERIOD):reb_idx+1]
        if len(spy_window) >= SPY_MA200_PERIOD:
            spy_ma200_val = spy_window.rolling(SPY_MA200_PERIOD).mean().iloc[-1]
            spy_current = spy_window.iloc[-1]
            if pd.notna(spy_ma200_val) and spy_current < spy_ma200_val:
                # Bear market: skip this rebalance, stay in cash
                equity_ew.append(equity_ew[-1])
                equity_sltp.append(equity_sltp[-1])
                continue
    
    if comp is not None and len(comp.dropna()) >= TOP_N:
        valid = [t for t in comp.dropna().nlargest(TOP_N).index if t in closes.columns and t != 'SPY']
        if valid:
            entries = {t: closes[t].iloc[reb_idx] for t in valid}
            atrs = {}
            for t in valid:
                if t in highs.columns:
                    h = highs[t].iloc[:reb_idx].values[-21:]
                    l = lows[t].iloc[:reb_idx].values[-21:]
                    c = closes[t].iloc[:reb_idx].values[-21:]
                    if len(h) > 14:
                        pc = np.roll(c, 1); pc[0] = c[0]
                        tr = np.maximum(h-l, np.maximum(np.abs(h-pc), np.abs(l-pc)))
                        atrs[t] = np.mean(tr[-14:])
                    else:
                        atrs[t] = entries[t] * 0.02
                else:
                    atrs[t] = entries[t] * 0.02
            w = 1.0 / len(valid)
            # [v9-SLTP-SEMANAL] SL=1.5 ATR, TP1=1.5, TP2=2.5 (calibrado para 5d)
            sls = {t: entries[t] - SL_ATR_MULT * atrs[t] for t in valid}
            tp1s = {t: entries[t] + TP1_ATR_MULT * atrs[t] for t in valid}
            tp2s = {t: entries[t] + TP2_ATR_MULT * atrs[t] for t in valid}
            exited = set()
            tp1_hit = set()
            remaining_w = {t: w for t in valid}
            for day_i in range(reb_idx, next_idx):
                for t in valid:
                    if t in closes.columns:
                        prev = closes[t].iloc[day_i-1] if day_i > reb_idx else entries[t]
                        ret = (closes[t].iloc[day_i] - prev) / prev if prev > 0 else 0
                        period_ret_ew += w * ret
                for t in valid:
                    if t in exited: continue
                    rw = remaining_w.get(t, 0)
                    if t in highs.columns and t in lows.columns:
                        dl = lows[t].iloc[day_i]
                        dh = highs[t].iloc[day_i]
                    else:
                        dl = dh = closes[t].iloc[day_i]
                    if dl <= sls.get(t, 0):
                        if t in tp1_hit:
                            ret = TP1_SCALE*(tp1s[t]-entries[t])/entries[t] + TP2_SCALE*(sls[t]-entries[t])/entries[t]
                        else:
                            ret = (sls[t] - entries[t]) / entries[t]
                        # [FIX-COSTES] Deducir coste de transacción
                        ret -= COST_PER_TRADE_PCT
                        period_ret_sltp += rw * ret
                        exited.add(t)
                        all_trades.append({'t': t, 'ret': ret, 'reason': 'SL'})
                    elif t in tp1_hit and dh >= tp2s.get(t, 999999):
                        ret = TP1_SCALE*(tp1s[t]-entries[t])/entries[t] + TP2_SCALE*(tp2s[t]-entries[t])/entries[t]
                        ret -= COST_PER_TRADE_PCT
                        period_ret_sltp += rw * ret
                        exited.add(t)
                        all_trades.append({'t': t, 'ret': ret, 'reason': 'TP2'})
                    elif t not in tp1_hit and dh >= tp1s.get(t, 999999):
                        tp1_hit.add(t)
                        remaining_w[t] = w * (1 - TP1_SCALE)
                        ret_tp1 = (tp1s[t]-entries[t])/entries[t] - COST_PER_TRADE_PCT * TP1_SCALE
                        period_ret_sltp += rw * TP1_SCALE * ret_tp1
                        all_trades.append({'t': t, 'ret': ret_tp1, 'reason': 'TP1'})
                    else:
                        prev = closes[t].iloc[day_i-1] if day_i > reb_idx else entries[t]
                        ret = (closes[t].iloc[day_i] - prev) / prev if prev > 0 else 0
                        period_ret_sltp += rw * ret
            for t in valid:
                if t not in exited:
                    if t in tp1_hit:
                        ret = TP1_SCALE*(tp1s[t]-entries[t])/entries[t] + TP2_SCALE*(closes[t].iloc[next_idx-1]-entries[t])/entries[t]
                    else:
                        ret = (closes[t].iloc[next_idx-1] - entries[t]) / entries[t]
                    ret -= COST_PER_TRADE_PCT  # [FIX-COSTES]
                    period_ret_sltp += remaining_w.get(t, w) * ret
                    all_trades.append({'t': t, 'ret': ret, 'reason': 'EOD'})
    # [FIX-COSTES] Deducir costes también en EW (1 trade = TOP_N * 18bps al mes)
    period_cost_ew = COST_PER_TRADE_PCT * TOP_N / REBALANCE_DAYS  # amortizado diario
    equity_ew.append(equity_ew[-1] * max(0.7, 1 + period_ret_ew - period_cost_ew))
    equity_sltp.append(equity_sltp[-1] * max(0.7, 1 + period_ret_sltp))
    if ri % 10 == 0:
        elapsed = time.time() - t0
        eta = elapsed / (ri+1) * (len(reb_dates)-ri-1) if ri > 0 else 0
        pct = (ri+1) / len(reb_dates) * 100
        print(f'  [{ri+1}/{len(reb_dates)-1}] {pct:.0f}% | {dates[reb_idx].strftime("%m/%Y")} | EW=EUR{equity_ew[-1]:.0f} | SLTP=EUR{equity_sltp[-1]:.0f}')

elapsed = time.time() - t0
print(f'\nCompleted in {elapsed:.0f}s')

def calc_m(eq):
    eq = np.array(eq)
    rets = np.diff(eq) / eq[:-1]
    total = (eq[-1]/eq[0]-1)*100
    # [v9-FIX-CAGR] CAGR usa dias naturales (252) / dias del backtest, no periodos fijos
    cagr = (eq[-1]/eq[0])**(252/(n_days-MIN_HISTORY))-1
    # [v9-FIX-VOL] eq tiene 1 valor por rebalance (~5d). Annualizar con sqrt(52) si semanal
    periods_per_year = 252 / REBALANCE_DAYS  # ~52 para 5d, ~12 para 21d
    vol = np.std(rets)*np.sqrt(periods_per_year)
    sharpe = (np.mean(rets)*periods_per_year-0.02)/(vol+1e-10)
    cummax = np.maximum.accumulate(eq)
    max_dd = np.min((eq-cummax)/cummax)*100
    winrate = np.mean(rets>0)*100
    var95 = np.percentile(rets, 5)*100
    return {'total_ret': round(total,1), 'cagr': round(cagr*100,1), 'vol': round(vol*100,1),
            'sharpe': round(sharpe,2), 'max_dd': round(max_dd,1), 'winrate': round(winrate,1),
            'var95': round(var95,2), 'final': round(eq[-1],0)}

m_ew = calc_m(equity_ew)
m_sltp = calc_m(equity_sltp)

# [FIX-SPY] Buscar SPY o fallback al primer ticker >= MIN_HISTORY con nombre parecido a benchmark
if 'SPY' in closes.columns:
    spy_close = closes['SPY']
elif '^GSPC' in closes.columns:
    spy_close = closes['^GSPC']
else:
    # Fallback: buscar cualquier ticker que empiece con S (probable SPY o similar)
    spy_candidates = [c for c in closes.columns if c.startswith('S') and len(closes[c].dropna()) >= MIN_HISTORY]
    spy_close = closes[spy_candidates[0]] if spy_candidates else closes.iloc[:,0]
    if spy_candidates:
        print(f'   ⚠️ SPY no encontrado en cache, usando {spy_candidates[0]} como benchmark')
    else:
        print(f'   ⚠️ SPY no encontrado en cache, usando {closes.columns[0]} como benchmark')
spy_start = spy_close.dropna().iloc[MIN_HISTORY]
spy_end = spy_close.dropna().iloc[-1]
spy_ret = (spy_end/spy_start-1)*100
# [FIX-CAGR] n_days es diario, MIN_HISTORY=252 es inicio. CAGR correcto con 252.
spy_cagr = (spy_end/spy_start)**(252/(n_days-MIN_HISTORY))-1
spy_final = INITIAL_CAPITAL * spy_end / spy_start

trades_df = pd.DataFrame(all_trades)
tp = trades_df[trades_df['reason'].isin(['TP1','TP2'])]
sl = trades_df[trades_df['reason']=='SL']
eod = trades_df[trades_df['reason']=='EOD']

print()
print('='*70)
print('  BACKTEST 5Y RESULTS')
print(f'  {dates[MIN_HISTORY].strftime("%d/%m/%Y")} -> {dates[-1].strftime("%d/%m/%Y")}')
print('='*70)
print()
print(f'  Q5 Equal-Weight (Weekly Rebalance, Top-10, No SL/TP):')
print(f'    Retorno: {m_ew["total_ret"]:+.1f}% | CAGR: {m_ew["cagr"]:.1f}%')
print(f'    Sharpe: {m_ew["sharpe"]:.2f} | MaxDD: {m_ew["max_dd"]:.1f}% | Vol: {m_ew["vol"]:.1f}%')
print(f'    Equity Final: EUR {m_ew["final"]:.0f}')
print()
print(f'  Q5 SL/TP (SL=1.5, TP1=1.5 60%/TP2=2.5 40%, Weekly, Top-10):')
print(f'    Retorno: {m_sltp["total_ret"]:+.1f}% | CAGR: {m_sltp["cagr"]:.1f}%')
print(f'    Sharpe: {m_sltp["sharpe"]:.2f} | MaxDD: {m_sltp["max_dd"]:.1f}% | Vol: {m_sltp["vol"]:.1f}%')
print(f'    VaR 95%: {m_sltp["var95"]:.2f}% | Win Rate: {m_sltp["winrate"]:.1f}%')
print(f'    Equity Final: EUR {m_sltp["final"]:.0f}')
print()
print(f'  SPY Buy & Hold:')
print(f'    Retorno: {spy_ret:+.1f}% | CAGR: {spy_cagr*100:.1f}%')
print(f'    Equity Final: EUR {spy_final:.0f}')
print()
print(f'  Alpha vs SPY:')
print(f'    Q5 EW:    {m_ew["total_ret"]-spy_ret:+.1f}%')
print(f'    Q5 SL/TP: {m_sltp["total_ret"]-spy_ret:+.1f}%')
print()
print(f'  Trade Stats ({len(trades_df)} total):')
if len(tp)>0: print(f'    TP: {len(tp)} ({len(tp)/len(trades_df)*100:.0f}%) | Avg ret: {tp["ret"].mean()*100:+.1f}%')
else: print('    TP: 0')
if len(sl)>0: print(f'    SL: {len(sl)} ({len(sl)/len(trades_df)*100:.0f}%) | Avg ret: {sl["ret"].mean()*100:+.1f}%')
else: print('    SL: 0')
if len(eod)>0: print(f'    EOD: {len(eod)} ({len(eod)/len(trades_df)*100:.0f}%) | Avg ret: {eod["ret"].mean()*100:+.1f}%')
else: print('    EOD: 0')
print('='*70)

results = {
    'm_ew': m_ew, 'm_sltp': m_sltp,
    'spy_ret': round(spy_ret,1), 'spy_cagr': round(spy_cagr*100,1),
    'spy_final': round(spy_final,0),
    'trades': {'total': len(trades_df), 'tp': len(tp), 'sl': len(sl), 'eod': len(eod)},
    'equity_ew': [round(e,2) for e in equity_ew],
    'equity_sltp': [round(e,2) for e in equity_sltp],
    'dates': [dates[i].strftime('%Y-%m-%d') for i in reb_dates],
}
with open('backtest_5y_results.json', 'w') as f:
    json.dump(results, f)
print('Results saved to backtest_5y_results.json')
