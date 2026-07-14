import json, math

eng = json.load(open('engine_returns.json'))
oly_r = [r for r in eng['engineReturns'] if abs(r) < 0.99 and math.isfinite(r)]
btc_r = eng.get('btcReturns', [])
btc_r = [r for r in btc_r if abs(r) < 0.99 and math.isfinite(r)]

nr = min(len(oly_r), len(btc_r))
oly_r = oly_r[:nr]
btc_r = btc_r[:nr]
print(f"Aligned: {nr} olympus, {len(btc_r)} btc")
print(f"Oly[0..2]: {[f'{r*100:.3f}%' for r in oly_r[:3]]}")
print(f"BTC[0..2]: {[f'{r*100:.3f}%' for r in btc_r[:3]]}")

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

print()
print("=" * 100)
print("  FASE 1: COMPOSITE OPTIMIZATION")
print("=" * 100)
print()
print(f"{'Ratio':>8} {'CAGR':>9} {'Sharpe':>8} {'Sortino':>8} {'Calmar':>8} {'MaxDD':>9} {'Vol':>9}")
print("-" * 68)

best_sh = None
best_ca = None

for core_pct in [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50]:
    oly_w = core_pct / 100
    btc_w = (100 - core_pct) / 100
    comp = [oly_w * oly_r[i] + btc_w * btc_r[i] for i in range(nr)]
    s = sharpe(comp)
    c = cagr(comp)
    so = sortino_r(comp)
    ca = calmar_r(comp)
    d = maxdd(comp)
    v = vol(comp)
    label = f"{core_pct}/{100-core_pct}"
    print(f"{label:>8} {c*100:>8.2f}% {s:>8.3f} {so:>8.3f} {ca:>8.3f} {d*100:>8.2f}% {v*100:>8.2f}%")
    if best_sh is None or s > best_sh[1]:
        best_sh = (label, s, c, d)
    if best_ca is None or ca > best_ca[1]:
        best_ca = (label, ca, c, d)

print()
print("=" * 80)
print("  OPTIMAL")
print("=" * 80)
print(f"  Max Sharpe:  {best_sh[0]}  Sharpe={best_sh[1]:.3f}  CAGR={best_sh[2]*100:.2f}%  MaxDD={best_sh[3]*100:.1f}%")
print(f"  Max Calmar:  {best_ca[0]}  Calmar={best_ca[1]:.3f}  CAGR={best_ca[2]*100:.2f}%  MaxDD={best_ca[3]*100:.1f}%")

# Utility
print()
for gamma in [2, 4, 6, 8]:
    best_u = ('', -1e100)
    for core_pct in [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50]:
        oly_w = core_pct / 100
        comp = [oly_w * oly_r[i] + (1-oly_w) * btc_r[i] for i in range(nr)]
        m = sum(comp) / len(comp)
        vr = sum((x - m) ** 2 for x in comp) / len(comp)
        u = (m * 252) - (gamma / 2) * (vr * 252)
        if u > best_u[1]:
            best_u = (f"{core_pct}/{100-core_pct}", u)
    print(f"  Max U(gamma={gamma}): {best_u[0]}  U={best_u[1]:.4f}")

# Kelly
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
print(f"  Kelly: {100-best_f*100:.0f}/{best_f*100:.0f}  GeoMean={best_geo*100:.2f}%")

# Current 70/30 vs optimal
comp_70 = [0.70 * oly_r[i] + 0.30 * btc_r[i] for i in range(nr)]
c70_sh = sharpe(comp_70)
c70_cg = cagr(comp_70)
c70_dd = maxdd(comp_70)
print()
print(f"70/30: Sharpe={c70_sh:.3f} CAGR={c70_cg*100:.2f}% MaxDD={c70_dd*100:.1f}%")
print(f"Best:  Sharpe={best_sh[1]:.3f} ({best_sh[0]})")
if best_sh[0] == '70/30':
    print("=> 70/30 IS optimal for Sharpe.")
else:
    print(f"=> 70/30 is NOT optimal. Best Sharpe at {best_sh[0]}.")
print()
print("DONE")
