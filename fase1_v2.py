import json, csv, math, statistics as st

# Load Olympus returns
eng = json.load(open('engine_returns.json'))
oly_r = [r for r in eng['engineReturns'] if abs(r) < 0.99 and math.isfinite(r)]
print(f"Olympus: {len(oly_r)} returns")

# Load BTC returns using csv.reader (avoids DictReader issues)
closes = []
with open('historical_data_daily_augmented.csv', 'r') as f:
    reader = csv.reader(f)
    headers = next(reader)
    bi = headers.index('BTC-EUR')
    for row in reader:
        try:
            v = float(row[bi])
            if v > 0:
                closes.append(v)
        except:
            pass

btc_all = [(closes[i] / closes[i-1] - 1) for i in range(1, len(closes))]
print(f"BTC: {len(closes)} closes, {len(btc_all)} returns")

# Index-based alignment: Olympus starts at CSV index 253 (252 lookback + 1)
# BTC return index 252 = return from csv[252] to csv[253]
btc_r = btc_all[252:252+len(oly_r)]
print(f"Aligned: {len(oly_r)} olympus, {len(btc_r)} btc")

# Verify first few returns
print(f"Oly[0..2]: {[f'{r*100:.3f}%' for r in oly_r[:3]]}")
print(f"BTC[0..2]: {[f'{r*100:.3f}%' for r in btc_r[:3]]}")

if len(btc_r) != len(oly_r):
    print(f"ERROR: length mismatch, truncating")
    nr = min(len(btc_r), len(oly_r))
    btc_r = btc_r[:nr]
    oly_r = oly_r[:nr]
else:
    nr = len(oly_r)

# Helper functions
def sharpe(r, rf=0.04):
    if len(r) < 20: return 0
    m = sum(r) / len(r)
    v = sum((x - m) ** 2 for x in r) / len(r)
    s = math.sqrt(max(1e-16, v))
    return (m * 252 - rf) / (s * math.sqrt(252))

def cagr(r):
    tr = 1.0
    for x in r: tr *= (1 + x)
    y = len(r) / 252
    if y <= 0 or tr <= 0: return -1
    return tr ** (1 / y) - 1

def maxdd(r):
    peak, val, dd = 1, 1, 0
    for x in r:
        val *= (1 + x)
        if val > peak: peak = val
        dd = max(dd, (peak - val) / peak)
    return -dd

def sortino_r(r, rf=0.04):
    target = rf / 252
    d = [min(0, x - target) for x in r]
    if len(d) < 2: return 0
    m = sum(d) / len(d)
    v = sum((x - m) ** 2 for x in d) / len(d)
    s = math.sqrt(max(1e-16, v)) * math.sqrt(252)
    ann = (sum(r) / len(r) * 252) - rf
    return ann / s if s > 0 else 0

def vol(r):
    m = sum(r) / len(r)
    v = sum((x - m) ** 2 for x in r) / len(r)
    return math.sqrt(max(1e-16, v * 252))

def calmar_r(r):
    c = cagr(r)
    d = maxdd(r)
    return c / abs(d) if d < 0 else 0

def ulcer_idx(r):
    peak, val, dd2 = 1, 1, 0
    for x in r:
        val *= (1 + x)
        if val > peak: peak = val
        dd = (peak - val) / peak
        dd2 += dd * dd
    return math.sqrt(dd2 / len(r)) if len(r) > 0 else 0

def omega_r(r, thr=0.0):
    g = sum(x for x in r if x > thr)
    l = sum(abs(x) for x in r if x < thr)
    return g / l if l > 0 else float('inf')

def cvar_95(r):
    s = sorted(r)
    cutoff = max(1, int(len(s) * 0.05))
    tail = s[:cutoff]
    return sum(tail) / len(tail) if tail else 0

# Compute composite for all ratios
ratios = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50]
print()
print("=" * 120)
print("  FASE 1: COMPOSITE OPTIMIZATION -- Olympus Core + BTC Satellite")
print("=" * 120)
print()
print(f"{'Ratio':>8} {'CAGR':>8} {'Sharpe':>8} {'Sortino':>8} {'Calmar':>8} {'MaxDD':>8} {'Vol':>8} {'Omega':>7} {'CVaR95':>8}")
print("-" * 89)

best_sharpe = None
best_calmar = None
best_sortino = None
best_omega = None

for core_pct in ratios:
    oly_w = core_pct / 100
    btc_w = (100 - core_pct) / 100
    comp = [oly_w * oly_r[i] + btc_w * btc_r[i] for i in range(nr)]
    
    s = sharpe(comp)
    c = cagr(comp)
    so = sortino_r(comp)
    ca = calmar_r(comp)
    d = maxdd(comp)
    v = vol(comp)
    om = omega_r(comp)
    cv = cvar_95(comp)
    
    label = f"{core_pct}/{100-core_pct}"
    print(f"{label:>8} {c*100:>7.2f}% {s:>8.3f} {so:>8.3f} {ca:>8.3f} {d*100:>7.2f}% {v*100:>7.2f}% {om:>7.3f} {cv*100:>7.2f}%")
    
    if best_sharpe is None or s > best_sharpe[1]:
        best_sharpe = (label, s, c, d, v)
    if best_calmar is None or ca > best_calmar[1]:
        best_calmar = (label, ca, c, d, v)
    if best_sortino is None or so > best_sortino[1]:
        best_sortino = (label, so, c, d, v)
    if best_omega is None or om > best_omega[1]:
        best_omega = (label, om, c, d, v)

print()
print("=" * 80)
print("  OPTIMAL POINTS")
print("=" * 80)
print(f"  MAX SHARPE:    {best_sharpe[0]}  Sharpe={best_sharpe[1]:.3f}  CAGR={best_sharpe[2]*100:.2f}%  MaxDD={best_sharpe[3]*100:.1f}%")
print(f"  MAX CALMAR:    {best_calmar[0]}  Calmar={best_calmar[1]:.3f}  CAGR={best_calmar[2]*100:.2f}%  MaxDD={best_calmar[3]*100:.1f}%")
print(f"  MAX SORTINO:   {best_sortino[0]}  Sortino={best_sortino[1]:.3f}")
print(f"  MAX OMEGA:     {best_omega[0]}  Omega={best_omega[1]:.3f}")

# Utility optimization for various gamma
def utility(r, gamma):
    m = sum(r) / len(r)
    vr = sum((x - m) ** 2 for x in r) / len(r)
    return (m * 252) - (gamma / 2) * (vr * 252)

print()
for gamma in [2, 4, 6, 8]:
    best_u_ratio = None
    best_u_val = -1e100
    for core_pct in ratios:
        oly_w = core_pct / 100
        btc_w = (100 - core_pct) / 100
        comp = [oly_w * oly_r[i] + btc_w * btc_r[i] for i in range(nr)]
        u = utility(comp, gamma)
        if u > best_u_val:
            best_u_val = u
            best_u_ratio = f"{core_pct}/{100-core_pct}"
    print(f"  MAX U(gamma={gamma}):  {best_u_ratio}  U={best_u_val:.4f}")

# Kelly optimal
print()
best_geo = -1
best_f = 0
for f in [i/100 for i in range(0, 101)]:
    comp = [(1-f) * oly_r[i] + f * btc_r[i] for i in range(nr)]
    geo = 1.0
    for x in comp: geo *= (1 + x)
    geo = geo ** (252 / len(comp)) - 1 if geo > 0 else -1
    if geo > best_geo:
        best_geo = geo
        best_f = f
print(f"  KELLY OPTIMAL: {100-best_f*100:.0f}/{best_f*100:.0f}  GeoMean={best_geo*100:.2f}%")

# Current 70/30 comparison
print()
print("=" * 80)
print("  COMPARISON: 70/30 (current) vs OPTIMAL")
print("=" * 80)

comp_70_30 = [0.70 * oly_r[i] + 0.30 * btc_r[i] for i in range(nr)]
c70_sh = sharpe(comp_70_30)
c70_cg = cagr(comp_70_30)
c70_dd = maxdd(comp_70_30)
c70_ca = calmar_r(comp_70_30)

print(f"  70/30:  Sharpe={c70_sh:.3f}  CAGR={c70_cg*100:.2f}%  MaxDD={c70_dd*100:.1f}%  Calmar={c70_ca:.3f}")
print(f"  Best:   Sharpe={best_sharpe[1]:.3f} ({best_sharpe[0]})  Calmar={best_calmar[1]:.3f} ({best_calmar[0]})")

if best_sharpe[0] == '70/30':
    print("  => 70/30 IS optimal for Sharpe. No change needed.")
else:
    print(f"  => 70/30 is NOT optimal. Consider {best_sharpe[0]} for max Sharpe.")

print()
print("=" * 80)
print("  DONE")
print("=" * 80)
