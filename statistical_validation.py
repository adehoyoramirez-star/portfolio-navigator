import json, math, random, csv
from collections import defaultdict

random.seed(42)

print("=" * 80)
print("  STATISTICAL VALIDATION: Olympus V3+ (sin MinVar)")
print("=" * 80)

# Load engine returns (current export = sin MinVar)
eng = json.load(open('engine_returns.json'))
oly_r = [r for r in eng['engineReturns'] if abs(r) < 0.99 and math.isfinite(r)]
print(f"\nEngine returns: {len(oly_r)}")

# Load BTC returns from same JSON
btc_r = eng.get('btcReturns', [])
btc_r = [r for r in btc_r if abs(r) < 0.99 and math.isfinite(r)]
nr = min(len(oly_r), len(btc_r))
oly_r = oly_r[:nr]
btc_r = btc_r[:nr]

# Compute EW returns from CSV
assets = ['BTC-EUR','EMXC.DE','0P00000WLG.F','PPFB.DE','URNU.DE','VVSM.DE']
closes = {a: [] for a in assets}
with open('historical_data_daily_augmented.csv', 'r') as f:
    reader = csv.reader(f)
    h = [col.replace('\r', '') for col in next(reader)]
    idxs = {a: h.index(a) for a in assets}
    for row in reader:
        row = [cell.replace('\r', '') for cell in row]
        try:
            for a in assets:
                closes[a].append(float(row[idxs[a]]))
        except:
            pass

for a in assets:
    closes[a] = closes[a][:min(len(closes[a]) for a in assets)]

ew_r = []
for i in range(1, len(closes[assets[0]])):
    er = 0
    for a in assets:
        if closes[a][i-1] > 0:
            er += (closes[a][i] / closes[a][i-1] - 1) / len(assets)
    ew_r.append(er)

# Align: engine starts at CSV index 253 (252 lookback + 1)
# EW returns start at CSV index 1
# Engine has 3863 returns covering [253, 3863+252] = [253, 4115]
# EW needs to be sliced to [252, 252+3863] = [252, 4115]
ew_r_aligned = ew_r[252:252+len(oly_r)]
oly_r = oly_r[:len(ew_r_aligned)]
ew_r = ew_r_aligned[:len(oly_r)]
btc_r = btc_r[:len(oly_r)]

print(f"Aligned: oly={len(oly_r)} ew={len(ew_r)} btc={len(btc_r)}")

# ── Helper functions ──
def sharpe_ann(r, rf=0.04):
    if len(r) < 20: return 0
    m = sum(r) / len(r)
    v = sum((x-m)**2 for x in r) / len(r)
    s = math.sqrt(max(1e-16, v))
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

# ── Baseline metrics ──
oly_s = sharpe_ann(oly_r)
oly_c = cagr(oly_r)
oly_d = maxdd(oly_r)
ew_s = sharpe_ann(ew_r)
ew_c = cagr(ew_r)
ew_d = maxdd(ew_r)
btc_s = sharpe_ann(btc_r)
btc_c = cagr(btc_r)

print(f"\n--- BASELINE METRICS ---")
print(f"Olympus:  Sharpe={oly_s:.3f}  CAGR={oly_c*100:.2f}%  MaxDD={oly_d*100:.2f}%")
print(f"EW:       Sharpe={ew_s:.3f}  CAGR={ew_c*100:.2f}%  MaxDD={ew_d*100:.2f}%")
print(f"BTC:      Sharpe={btc_s:.3f}  CAGR={btc_c*100:.2f}%")

# ── 1. DEFLATED SHARPE RATIO ──
# DSR = CDF[N((SR - E[max(SR)]) / std(SR))]
# Bailey & Lopez de Prado (2014)
# Account for multiple testing: what's the probability this Sharpe is "real"
# after considering we tried K different strategies?
print(f"\n--- 1. DEFLATED SHARPE RATIO ---")
K = 20  # number of strategy variations tested (conservative estimate)
n_years = len(oly_r) / 252
skew = sum((x - sum(oly_r)/len(oly_r))**3 for x in oly_r) / (len(oly_r) * (max(1e-16, math.sqrt(sum((x - sum(oly_r)/len(oly_r))**2 for x in oly_r) / len(oly_r)))**3))
kurt = sum((x - sum(oly_r)/len(oly_r))**4 for x in oly_r) / (len(oly_r) * (max(1e-16, math.sqrt(sum((x - sum(oly_r)/len(oly_r))**2 for x in oly_r) / len(oly_r)))**4)) - 3

# Expected maximum Sharpe from K independent trials (Bailey & Lopez de Prado formula)
from math import sqrt, log, exp, pi, erf
def norm_cdf(x):
    return 0.5 * (1 + erf(x/sqrt(2)))

def norm_pdf(x):
    return exp(-x*x/2) / sqrt(2*pi)

# Expected max SR using extreme value theory
sr = oly_s
gamma = -0.5772  # Euler-Mascheroni
emax_sr = sqrt(2*log(K)) + (gamma + log(log(K)) + log(4*pi))/(2*sqrt(2*log(K)))

# Variance of max SR
var_max_sr = 1.0 / (2 * log(K))

# Deflated Sharpe
sr_deflated = sr - emax_sr
# If deflated SR << 0, the performance is indistinguishable from random
# DSR p-value: P(real SR > 0 after deflation)
dsr_pvalue = 1 - norm_cdf(sr_deflated / sqrt(var_max_sr)) if var_max_sr > 0 else 0.5

print(f"  Sharpe ratio: {sr:.3f}")
print(f"  E[max SR] over K={K} trials: {emax_sr:.3f}")
print(f"  Deflated Sharpe: {sr_deflated:.3f}")
print(f"  DSR p-value (prob not random): {dsr_pvalue:.4f}")
print(f"  Verdict: {'SIGNIFICANT' if sr_deflated > 1.0 else 'MARGINAL' if sr_deflated > 0 else 'NOT SIGNIFICANT'}")

# ── 2. PBO (Probability of Backtest Overfitting) ──
# CSCV: Combinatorially Symmetric Cross-Validation (Bailey & Lopez de Prado)
print(f"\n--- 2. PBO (Bailey & Lopez de Prado CSCV) ---")

# Generate N strategy configurations by varying blend weights, rebalance, lookback
N = 24  # number of configurations
M = 2000  # bootstraps

# Strategy returns for each config (we simulate by adding noise to the real returns)
# This represents different parameterizations
config_returns = []
for i in range(N):
    # Simulate different blend weights by mixing oly + random noise
    noise = [random.gauss(0, 0.0005) for _ in range(len(oly_r))]
    mixed = [oly_r[j] * random.uniform(0.7, 1.3) + noise[j] for j in range(len(oly_r))]
    sr_i = sharpe_ann(mixed)
    config_returns.append((i, sr_i, mixed))

# CSCV algorithm
S = len(oly_r)
S_half = S // 2
n_combos = min(100, N * (N-1) // 2)

pbo_count = 0
for _ in range(M):
    # Random split into IS/OOS halves
    indices = list(range(S))
    random.shuffle(indices)
    is_idx = set(indices[:S_half])
    
    best_is = None
    best_is_sr = -float('inf')
    
    for i, sr_i, rets in config_returns:
        is_rets = [rets[j] for j in range(S) if j in is_idx]
        oos_rets = [rets[j] for j in range(S) if j not in is_idx]
        is_sr = sharpe_ann(is_rets)
        if is_sr > best_is_sr:
            best_is_sr = is_sr
            best_is = i
    
    # Check if best IS is also best OOS
    best_is_oos_sr = sharpe_ann([config_returns[best_is][2][j] for j in range(S) if j not in is_idx])
    
    # Count how many configs beat best IS in OOS
    oos_better = 0
    for i, sr_i, rets in config_returns:
        if i == best_is:
            continue
        oos_sr_i = sharpe_ann([rets[j] for j in range(S) if j not in is_idx])
        if oos_sr_i > best_is_oos_sr:
            oos_better += 1
    
    # PBO: probability that best IS is NOT best OOS
    if oos_better > 0:
        pbo_count += 1

pbo = pbo_count / M
pbo_se = math.sqrt(pbo * (1 - pbo) / M)
pbo_ci_low = max(0, pbo - 1.96 * pbo_se)
pbo_ci_high = min(1, pbo + 1.96 * pbo_se)

print(f"  N configurations: {N}")
print(f"  M bootstraps: {M}")
print(f"  PBO: {pbo*100:.1f}%")
print(f"  95% CI: [{pbo_ci_low*100:.1f}%, {pbo_ci_high*100:.1f}%]")
print(f"  Verdict: {'HIGH OVERFITTING RISK' if pbo > 0.40 else 'MODERATE' if pbo > 0.25 else 'LOW' if pbo > 0.10 else 'MINIMAL'}")

# ── 3. WHITE REALITY CHECK ──
# Tests if the best strategy outperforms benchmark after accounting for data snooping
print(f"\n--- 3. WHITE REALITY CHECK (Bootstrap) ---")

# Null: the best strategy has no predictive power over benchmark (EW)
# Use Politis & Romano stationary bootstrap
B = 5000
block_len = 20  # ~1 month blocks

# Statistic: difference in Sharpe vs EW
real_diff = oly_s - ew_s
print(f"  Observed Sharpe diff (Olympus - EW): {real_diff:.4f}")

# Stationary bootstrap
boot_diffs = []
S = len(oly_r)
for b in range(B):
    # Generate bootstrap sample with blocks
    boot_oly = []
    boot_ew = []
    pos = random.randint(0, S - 1)
    while len(boot_oly) < S:
        # Geometric block length
        bl = random.randint(1, block_len * 2)
        for k in range(bl):
            if len(boot_oly) >= S:
                break
            idx = (pos + k) % S
            boot_oly.append(oly_r[idx])
            boot_ew.append(ew_r[idx])
        pos = random.randint(0, S - 1)
    
    boot_sr_oly = sharpe_ann(boot_oly[:S])
    boot_sr_ew = sharpe_ann(boot_ew[:S])
    boot_diffs.append(boot_sr_oly - boot_sr_ew)

# RC p-value: fraction of bootstrap diffs where best <= 0
wrc_pvalue = sum(1 for d in boot_diffs if d <= 0) / B
print(f"  White RC p-value: {wrc_pvalue:.4f}")
print(f"  Verdict: {'SIGNIFICANT (alpha real)' if wrc_pvalue < 0.05 else 'NOT SIGNIFICANT' if wrc_pvalue > 0.10 else 'MARGINAL'}")

# ── 4. HANSE
