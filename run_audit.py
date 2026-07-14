import math, statistics as st, random

# Parse CSV
with open('historical_data_daily_augmented.csv', 'r') as f:
    lines = [l.strip() for l in f if l.strip()]

headers = lines[0].split(',')
col_map = {h.strip(): i for i, h in enumerate(headers)}
assets = ['BTC-EUR','EMXC.DE','0P00000WLG.F','PPFB.DE','URNU.DE','VVSM.DE']

rows = []
for line in lines[1:]:
    parts = line.split(',')
    if len(parts) < len(headers):
        continue
    try:
        row = {a: float(parts[col_map[a]]) for a in assets}
        rows.append(row)
    except (ValueError, KeyError, IndexError):
        continue

clean = [r for r in rows if all(r[a] > 0 for a in assets)]
n = len(clean)
rets = []
btc_r = []
for i in range(1, n):
    er = sum(clean[i][a] / clean[i-1][a] - 1 for a in assets) / len(assets)
    rets.append(er)
    btc_r.append(clean[i]['BTC-EUR'] / clean[i-1]['BTC-EUR'] - 1)

nr = len(rets)

# Helpers
def sharpe(r, rf=0.04):
    m = sum(r)/len(r)
    v = sum((x-m)**2 for x in r)/len(r)
    s = math.sqrt(max(1e-10, v))
    return (m*252 - rf) / (s*math.sqrt(252))

def cagr(r):
    tr = 1.0
    for x in r: tr *= (1+x)
    y = len(r)/252
    return max(-1, tr**(1/y) - 1) if y > 0 and tr > 0 else -1

def maxdd(r):
    peak, val, dd = 1, 1, 0
    for x in r:
        val *= (1+x)
        if val > peak: peak = val
        dd = max(dd, (peak-val)/peak)
    return -dd

def sortino_r(r, rf=0.04):
    d = [(x - rf/252) for x in r if x < rf/252]
    if len(d) < 2: return 0
    m = sum(d)/len(d)
    v = sum((x-m)**2 for x in d)/len(d)
    s = math.sqrt(max(1e-10, v)) * math.sqrt(252)
    ann = (sum(r)/len(r)*252) - rf
    return ann / s if s > 0 else 0

def omega_r(r, thr=0.0):
    g = sum(x for x in r if x > thr)
    l = sum(abs(x) for x in r if x < thr)
    return g / l if l > 0 else float('inf')

def ulcer(r):
    peak, val, dd2 = 1, 1, 0
    for x in r:
        val *= (1+x)
        if val > peak: peak = val
        dd = (peak-val)/peak
        dd2 += dd*dd
    return math.sqrt(dd2/len(r)) if len(r) > 0 else 0

def info_ratio(r, bm):
    n = min(len(r), len(bm))
    ex = [r[i] - bm[i] for i in range(n)]
    m = sum(ex)/len(ex)
    v = sum((x-m)**2 for x in ex)/len(ex)
    te = math.sqrt(max(1e-10, v)) * math.sqrt(252)
    return (m*252) / te if te > 0 else 0

def rolling_sharpe_window(r, w=756):
    return [sharpe(r[i-w:i]) for i in range(w, len(r)) if i-w >= 0]

# Metrics
print("="*60)
print("  BASELINE METRICS (Equal-Weight)")
print("="*60)
print(f"  Sharpe:          {sharpe(rets):.3f}")
print(f"  Sortino:         {sortino_r(rets):.3f}")
print(f"  CAGR:            {cagr(rets)*100:.2f}%")
print(f"  MaxDD:           {maxdd(rets)*100:.1f}%")
print(f"  Omega (0%):      {omega_r(rets):.2f}")
print(f"  Ulcer Index:     {ulcer(rets):.4f}")
print(f"  Info Ratio:      {info_ratio(rets, btc_r):.3f}")
print(f"  Volatility:      {math.sqrt(sum((x-sum(rets)/len(rets))**2 for x in rets)/len(rets)*252)*100:.1f}%")

# WFO
def run_wfo(r, nw=8, tr=0.65):
    ws = len(r) // (nw + 1)
    res = []
    for w in range(nw):
        s = w * ws
        split = s + int(ws * tr)
        e = s + ws
        if e > len(r): break
        is_r = r[s:split]
        oos_r = r[split:e]
        if len(oos_r) < 20: continue
        res.append((w+1, sharpe(is_r), sharpe(oos_r), cagr(is_r)*100, cagr(oos_r)*100, len(is_r), len(oos_r)))
    return res

wfo_r = run_wfo(rets)
iss = [x[1] for x in wfo_r]
ooss = [x[2] for x in wfo_r]
degs = [abs((x[1]-x[2])/max(0.01,abs(x[1])))*100 for x in wfo_r]
is_rk = sorted(range(len(iss)), key=lambda i: iss[i])
oos_rk = sorted(range(len(ooss)), key=lambda i: ooss[i])
rnk = sum((is_rk[i]-oos_rk[i])**2 for i in range(len(iss)))
sp = 1 - 6*rnk/(len(iss)*(len(iss)**2-1)) if len(iss) > 1 else 0

print("\n" + "="*60)
print("  1. ROLLING WFO (8 windows)")
print("="*60)
print(f"Avg degradation: {sum(degs)/len(degs):.1f}%")
print(f"IS Sharpe:  mean={st.mean(iss):.3f}")
print(f"OOS Sharpe: mean={st.mean(ooss):.3f}")
print(f"Spearman (IS vs OOS rank): {sp:.3f}")

# PBO
M_BOOT = 500
N_CFG = 8
N_TRAIN = int(nr * 0.5)
pbo_count = 0
random.seed(42)
for trial in range(M_BOOT):
    idx = list(range(nr))
    random.shuffle(idx)
    is_idx = idx[:N_TRAIN]
    oos_idx = idx[N_TRAIN:]
    is_rets = [rets[i] for i in is_idx]
    oos_rets = [rets[i] for i in oos_idx]
    is_sharpes, oos_sharpes = [], []
    for c in range(N_CFG):
        ss = int(len(is_rets) * 0.7)
        is_sharpes.append(sharpe([is_rets[random.randint(0, len(is_rets)-1)] for _ in range(ss)]))
        oos_sharpes.append(sharpe([oos_rets[random.randint(0, len(oos_rets)-1)] for _ in range(ss)]))
    best_idx = max(range(N_CFG), key=lambda i: is_sharpes[i])
    if oos_sharpes[best_idx] < sorted(oos_sharpes)[N_CFG // 2]:
        pbo_count += 1
pbo_val = pbo_count / M_BOOT
print("\n" + "="*60)
print("  2. PBO (B&LdP)")
print("="*60)
print(f"PBO: {pbo_val*100:.1f}%")

# Alpha Attribution
non_btc = [a for a in assets if a != 'BTC-EUR']
non_btc_rets = []
for i in range(1, n):
    er = sum(clean[i][a] / clean[i-1][a] - 1 for a in non_btc) / len(non_btc)
    non_btc_rets.append(er)
ew_cagr = cagr(rets)
non_btc_cagr = cagr(non_btc_rets)
btc_attrib = (ew_cagr - non_btc_cagr) * 6
print("\n" + "="*60)
print("  3. ALPHA ATTRIBUTION")
print("="*60)
print(f"BTC contribution: {btc_attrib/ew_cagr*100:.0f}% of total")

# Rebalance
def simulate_rebalance(rets, freq_days):
    sampled = []
    for i in range(0, len(rets), freq_days):
        if i + freq_days < len(rets):
            block = rets[i:i+freq_days]
            cum = 1.0
            for r in block: cum *= (1+r)
            sampled.append(cum - 1)
    return sampled

results = []
for freq in range(10, 36, 2):
    sampled = simulate_rebalance(rets, freq)
    if len(sampled) < 20: continue
    ann_m = sum(sampled)/len(sampled) * (252/freq)
    ann_v = sum((x-ann_m*(freq/252))**2 for x in sampled)/len(sampled) * (252/freq)
    ann_s = math.sqrt(max(1e-10, ann_v))
    results.append((freq, (ann_m - 0.04) / ann_s if ann_s > 0 else 0))

sharpes_only = [x[1] for x in results]
sharpe_pct_range = (max(sharpes_only)-min(sharpes_only))/max(0.01, abs(st.mean(sharpes_only))) * 100
print("\n" + "="*60)
print("  4. REBALANCE CURVE")
print("="*60)
print(f"Sharpe span: {sharpe_pct_range:.0f}%")

# Rolling Sharpe
rs = rolling_sharpe_window(rets, 756)
print("\n" + "="*60)
print("  5. ROLLING SHARPE (36m)")
print("="*60)
print(f"Mean: {st.mean(rs):.3f}, % > 0: {sum(1 for x in rs if x > 0)/len(rs)*100:.0f}%")

