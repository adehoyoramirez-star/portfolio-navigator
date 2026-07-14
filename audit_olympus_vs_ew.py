import math, statistics as st, random, csv, json

random.seed(42)

# ============================================================
# 1. LOAD ENGINE RETURNS (Olympus backtest)
# ============================================================
with open('engine_returns.json', 'r') as f:
    eng = json.load(f)

eng_rets = [r for r in eng['engineReturns'] if abs(r) < 0.99 and math.isfinite(r)]
eng_dates = eng['dates'][:len(eng_rets)]

print(f"Olympus engine: {len(eng_rets)} returns, {eng_dates[0]} -> {eng_dates[-1]}")

# ============================================================
# 2. LOAD CSV + COMPUTE EW RETURNS
# ============================================================
assets = ['BTC-EUR','EMXC.DE','0P00000WLG.F','PPFB.DE','URNU.DE','VVSM.DE']
closes = {a: [] for a in assets}
csv_dates = []

with open('historical_data_daily_augmented.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        try:
            vals = {a: float(row[a]) for a in assets}
            if all(vals[a] > 0 for a in assets):
                for a in assets:
                    closes[a].append(vals[a])
                csv_dates.append(row.get('Date', ''))
        except:
            pass

n = len(closes['BTC-EUR'])
ew_rets_full = []
for i in range(1, n):
    er = sum(closes[a][i] / closes[a][i-1] - 1 for a in assets) / len(assets)
    ew_rets_full.append(er)
ew_dates_full = csv_dates[1:]

print(f"EW proxy: {len(ew_rets_full)} returns, {ew_dates_full[0]} -> {ew_dates_full[-1]}")

# ============================================================
# 3. ALIGN DATES between engine and EW
# ============================================================
ew_date_to_idx = {d: i for i, d in enumerate(ew_dates_full)}
eng_date_to_idx = {d: i for i, d in enumerate(eng_dates)}

common_dates = sorted(set(ew_date_to_idx.keys()) & set(eng_date_to_idx.keys()))

ew_aligned = []
eng_aligned = []
aligned_dates = []
for d in common_dates:
    ew_aligned.append(ew_rets_full[ew_date_to_idx[d]])
    eng_aligned.append(eng_rets[eng_date_to_idx[d]])
    aligned_dates.append(d)

nr = len(ew_aligned)
print(f"Aligned returns: {nr}, {aligned_dates[0]} -> {aligned_dates[-1]}")

# ============================================================
# 4. HELPER FUNCTIONS
# ============================================================
def sharpe(r, rf=0.04):
    if len(r) < 20: return 0
    m = sum(r) / len(r)
    v = sum((x - m) ** 2 for x in r) / len(r)
    s = math.sqrt(max(1e-16, v))
    return (m * 252 - rf) / (s * math.sqrt(252))

def cagr(r):
    tr = 1.0
    for x in r:
        tr *= (1 + x)
    y = len(r) / 252
    return max(-1, tr ** (1 / y) - 1) if y > 0 and tr > 0 else -1

def maxdd(r):
    peak, val, dd = 1, 1, 0
    for x in r:
        val *= (1 + x)
        if val > peak:
            peak = val
        dd = max(dd, (peak - val) / peak)
    return -dd

def calmar(r, rf=0.04):
    c = cagr(r)
    dd = maxdd(r)
    return c / abs(dd) if dd < 0 else 0

def sortino_r(r, rf=0.04):
    target = rf / 252
    d = [min(0, x - target) for x in r]
    if len(d) < 2:
        return 0
    m = sum(d) / len(d)
    v = sum((x - m) ** 2 for x in d) / len(d)
    s = math.sqrt(max(1e-16, v)) * math.sqrt(252)
    ann_excess = (sum(r) / len(r) * 252) - rf
    return ann_excess / s if s > 0 else 0

def omega_r(r, thr=0.0):
    g = sum(x for x in r if x > thr)
    l = sum(abs(x) for x in r if x < thr)
    return g / l if l > 0 else float('inf')

def ulcer(r):
    peak, val, dd2 = 1, 1, 0
    for x in r:
        val *= (1 + x)
        if val > peak:
            peak = val
        dd = (peak - val) / peak
        dd2 += dd * dd
    return math.sqrt(dd2 / len(r)) if len(r) > 0 else 0

def vol(r):
    m = sum(r) / len(r)
    v = sum((x - m) ** 2 for x in r) / len(r)
    return math.sqrt(max(1e-16, v * 252))

def rolling_sharpe(r, w=756):
    return [sharpe(r[i - w:i]) for i in range(w, len(r))]

def dd_series(r):
    peak, val = 1, 1
    dds = []
    for x in r:
        val *= (1 + x)
        if val > peak:
            peak = val
        dds.append((peak - val) / peak)
    return dds

# ============================================================
# 5. BASELINE COMPARISON
# ============================================================
print()
print("=" * 75)
print("  BASELINE COMPARISON -- OLYMPUS vs EQUAL-WEIGHT")
print("=" * 75)
print(f"  {'Metric':<20} {'Olympus':>12} {'EW Proxy':>12} {'Delta':>12} {'% Improv':>12}")
print("  " + "-" * 68)

def fmt_pct(v):
    return f"{v*100:>11.2f}%"

def fmt_num(v, d=3):
    return f"{v:>12.{d}f}"

results = {}
for name, ov, ev in [
    ("Sharpe", sharpe(eng_aligned), sharpe(ew_aligned)),
    ("Sortino", sortino_r(eng_aligned), sortino_r(ew_aligned)),
    ("CAGR", cagr(eng_aligned), cagr(ew_aligned)),
    ("MaxDD", maxdd(eng_aligned), maxdd(ew_aligned)),
    ("Calmar", calmar(eng_aligned), calmar(ew_aligned)),
    ("Volatility", vol(eng_aligned), vol(ew_aligned)),
    ("Omega (0%)", omega_r(eng_aligned), omega_r(ew_aligned)),
    ("Ulcer Index", ulcer(eng_aligned), ulcer(ew_aligned)),
]:
    if name in ("MaxDD", "Volatility", "Ulcer Index"):
        delta = ev - ov  # positive means EW worse (higher drawdown/vol)
        pct_imp = (delta / abs(ev)) * 100 if abs(ev) > 1e-10 else 0
    else:
        delta = ov - ev  # positive means Olympus better
        pct_imp = (delta / abs(ev)) * 100 if abs(ev) > 1e-10 else 0

    sign = "+" if delta > 0 else ""

    if name in ("CAGR", "MaxDD", "Volatility"):
        print(f"  {name:<20} {fmt_pct(ov)} {fmt_pct(ev)} {sign}{fmt_pct(delta)} {fmt_pct(pct_imp)}")
    elif name == "Omega (0%)":
        print(f"  {name:<20} {ov:>12.3f} {ev:>12.3f} {sign}{delta:>11.3f} {pct_imp:>11.1f}%")
    elif name == "Ulcer Index":
        print(f"  {name:<20} {ov:>12.6f} {ev:>12.6f} {sign}{delta:>11.6f} {pct_imp:>11.1f}%")
    else:
        print(f"  {name:<20} {ov:>12.3f} {ev:>12.3f} {sign}{delta:>11.3f} {pct_imp:>11.1f}%")

    results[name] = {"olympus": ov, "ew": ev, "delta": delta, "pct_imp": pct_imp}

# ============================================================
# 6. WFO 8 WINDOWS -- OLYMPUS vs EW (SIDE BY SIDE)
# ============================================================
def run_wfo(r, nw=8, tr=0.65):
    ws = len(r) // (nw + 1)
    res = []
    for w in range(nw):
        s = w * ws
        split = s + int(ws * tr)
        e = min(s + ws, len(r))
        if e <= split or split - s < 50 or e - split < 50:
            continue
        is_r = r[s:split]
        oos_r = r[split:e]
        res.append({
            'win': w + 1,
            'is_sharpe': sharpe(is_r),
            'oos_sharpe': sharpe(oos_r),
            'is_cagr': cagr(is_r),
            'oos_cagr': cagr(oos_r),
            'is_len': len(is_r),
            'oos_len': len(oos_r),
            'start_idx': s,
            'split_idx': split,
            'end_idx': e,
        })
    return res

eng_wfo = run_wfo(eng_aligned)
ew_wfo = run_wfo(ew_aligned)

print()
print("=" * 100)
print("  WFO 8 WINDOWS: OLYMPUS vs EQUAL-WEIGHT")
print("=" * 100)
header = f"  {'Win':>4} {'Dates':<25} {'Oly IS':>8} {'Oly OOS':>9} {'EW IS':>8} {'EW OOS':>9} {'Oly Deg%':>9} {'EW Deg%':>9}"
print(header)
print("  " + "-" * 89)

olymp_wfo_is = []
olymp_wfo_oos = []
ew_wfo_is = []
ew_wfo_oos = []

for i in range(min(len(eng_wfo), len(ew_wfo))):
    e = eng_wfo[i]
    w = ew_wfo[i]

    sdate = aligned_dates[e['start_idx']][:10] if e['start_idx'] < len(aligned_dates) else "?"
    edate = aligned_dates[e['end_idx']-1][:10] if e['end_idx']-1 < len(aligned_dates) else "?"

    o_deg = abs((e['is_sharpe'] - e['oos_sharpe']) / max(0.01, abs(e['is_sharpe']))) * 100
    w_deg = abs((w['is_sharpe'] - w['oos_sharpe']) / max(0.01, abs(w['is_sharpe']))) * 100

    date_str = f"{sdate}->{edate}"
    flag = ""
    if "2018" in date_str:
        flag = " *** 2018"
    elif "2020" in date_str:
        flag = " *** 2020"
    elif "2022" in date_str:
        flag = " *** 2022"

    print(f"  {e['win']:>4} {date_str:<25} {e['is_sharpe']:>8.3f} {e['oos_sharpe']:>9.3f} {w['is_sharpe']:>8.3f} {w['oos_sharpe']:>9.3f} {o_deg:>8.1f}% {w_deg:>8.1f}%{flag}")

    olymp_wfo_is.append(e['is_sharpe'])
    olymp_wfo_oos.append(e['oos_sharpe'])
    ew_wfo_is.append(w['is_sharpe'])
    ew_wfo_oos.append(w['oos_sharpe'])

print("  " + "-" * 89)
print(f"  {'MEAN':>4} {'':<25} {st.mean(olymp_wfo_is):>8.3f} {st.mean(olymp_wfo_oos):>9.3f} {st.mean(ew_wfo_is):>8.3f} {st.mean(ew_wfo_oos):>9.3f}")

o_avg_deg = abs((st.mean(olymp_wfo_is) - st.mean(olymp_wfo_oos)) / max(0.01, abs(st.mean(olymp_wfo_is)))) * 100
ew_avg_deg = abs((st.mean(ew_wfo_is) - st.mean(ew_wfo_oos)) / max(0.01, abs(st.mean(ew_wfo_is)))) * 100
print(f"  {'DEGR':>4} {'':<25} {'':>8} {o_avg_deg:>8.1f}% {'':>8} {ew_avg_deg:>8.1f}%")

olymp_wins = sum(1 for i in range(len(olymp_wfo_is)) if olymp_wfo_oos[i] > olymp_wfo_is[i])
ew_wins = sum(1 for i in range(len(ew_wfo_is)) if ew_wfo_oos[i] > ew_wfo_is[i])
print(f"  OOS better than IS: Olympus {olymp_wins}/{len(olymp_wfo_is)}, EW {ew_wins}/{len(ew_wfo_is)}")

# ============================================================
# 7. ROLLING SHARPE 36m -- OLYMPUS vs EW
# ============================================================
rs_olymp = rolling_sharpe(eng_aligned, 756)
rs_ew = rolling_sharpe(ew_aligned, 756)
rs_dates_olymp = aligned_dates[756:756+len(rs_olymp)]
rs_dates_ew = aligned_dates[756:756+len(rs_ew)]

print()
print("=" * 75)
print("  ROLLING SHARPE 36m -- OLYMPUS vs EQUAL-WEIGHT")
print("=" * 75)
print(f"  {'Metric':<25} {'Olympus':>12} {'EW Proxy':>12} {'Diff':>12}")
print("  " + "-" * 61)
print(f"  {'Mean':<25} {st.mean(rs_olymp):>12.3f} {st.mean(rs_ew):>12.3f} {st.mean(rs_olymp)-st.mean(rs_ew):>+12.3f}")
print(f"  {'Median':<25} {st.median(rs_olymp):>12.3f} {st.median(rs_ew):>12.3f} {st.median(rs_olymp)-st.median(rs_ew):>+12.3f}")
print(f"  {'Std Dev':<25} {st.stdev(rs_olymp):>12.3f} {st.stdev(rs_ew):>12.3f} {st.stdev(rs_olymp)-st.stdev(rs_ew):>+12.3f}")
print(f"  {'Min':<25} {min(rs_olymp):>12.3f} {min(rs_ew):>12.3f} {min(rs_olymp)-min(rs_ew):>+12.3f}")
print(f"  {'Max':<25} {max(rs_olymp):>12.3f} {max(rs_ew):>12.3f} {max(rs_olymp)-max(rs_ew):>+12.3f}")
pct_pos_o = sum(1 for x in rs_olymp if x > 0)/len(rs_olymp)*100
pct_pos_e = sum(1 for x in rs_ew if x > 0)/len(rs_ew)*100
print(f"  {'% > 0':<25} {pct_pos_o:>11.1f}% {pct_pos_e:>11.1f}% {pct_pos_o-pct_pos_e:>+11.1f}%")
pct_1_o = sum(1 for x in rs_olymp if x > 1.0)/len(rs_olymp)*100
pct_1_e = sum(1 for x in rs_ew if x > 1.0)/len(rs_ew)*100
print(f"  {'% > 1.0':<25} {pct_1_o:>11.1f}% {pct_1_e:>11.1f}% {pct_1_o-pct_1_e:>+11.1f}%")

neg_olymp = [(rs_dates_olymp[i], rs_olymp[i]) for i in range(len(rs_olymp)) if rs_olymp[i] < 0]
neg_ew = [(rs_dates_ew[i], rs_ew[i]) for i in range(len(rs_ew)) if rs_ew[i] < 0]
print(f"\n  Negative Rolling Sharpe windows:")
print(f"  Olympus ({len(neg_olymp)}): {', '.join([d[:10] + '(' + f'{v:.2f}' + ')' for d, v in neg_olymp[:8]])}" + ("..." if len(neg_olymp)>8 else ""))
print(f"  EW      ({len(neg_ew)}): {', '.join([d[:10] + '(' + f'{v:.2f}' + ')' for d, v in neg_ew[:8]])}" + ("..." if len(neg_ew)>8 else ""))

# ============================================================
# 8. STRESS TEST -- 2018, 2020, 2022
# ============================================================
print()
print("=" * 75)
print("  STRESS TEST -- CRITICAL WINDOWS: 2018, 2020, 2022")
print("=" * 75)

stress_periods = [
    ("2018 Bear (BTC -73%)", "2018-01-01", "2018-12-31"),
    ("2020 COVID Crash", "2020-02-15", "2020-03-31"),
    ("2020 Recovery", "2020-04-01", "2020-12-31"),
    ("2022 Rate Hikes", "2022-01-01", "2022-12-31"),
    ("2022 Q1-Q2 Crash", "2022-01-01", "2022-06-30"),
]

for label, start, end in stress_periods:
    idxs = [i for i, d in enumerate(aligned_dates) if start <= d <= end]
    if len(idxs) < 10:
        print(f"\n  {label}: INSUFFICIENT DATA ({len(idxs)} days)")
        continue

    o_stress = [eng_aligned[i] for i in idxs]
    e_stress = [ew_aligned[i] for i in idxs]

    o_sh = sharpe(o_stress)
    e_sh = sharpe(e_stress)
    o_cg = cagr(o_stress)
    e_cg = cagr(e_stress)
    o_dd = maxdd(o_stress)
    e_dd = maxdd(e_stress)
    o_vol = vol(o_stress)
    e_vol = vol(e_stress)
    o_sort = sortino_r(o_stress)
    e_sort = sortino_r(e_stress)

    print(f"\n  {label} ({len(idxs)} days):")
    print(f"    {'':<15} {'Sharpe':>8} {'Sortino':>8} {'CAGR':>10} {'MaxDD':>10} {'Vol':>10}")
    print(f"    {'Olympus':<15} {o_sh:>8.3f} {o_sort:>8.3f} {fmt_pct(o_cg)} {fmt_pct(o_dd)} {fmt_pct(o_vol)}")
    print(f"    {'EW Proxy':<15} {e_sh:>8.3f} {e_sort:>8.3f} {fmt_pct(e_cg)} {fmt_pct(e_dd)} {fmt_pct(e_vol)}")

    # Who performed better?
    dd_improve = abs(e_dd) - abs(o_dd)  # positive means Olympus had less drawdown
    if o_sh > e_sh and dd_improve > 0:
        print(f"    => Olympus DOMINATES: +{o_sh-e_sh:.3f} Sharpe, {dd_improve*100:.1f}pp less drawdown")
    elif o_sh > e_sh:
        print(f"    => Olympus higher Sharpe: +{o_sh-e_sh:.3f} but similar drawdown")
    elif dd_improve > 0.02:
        print(f"    => Olympus better drawdown protection: {dd_improve*100:.1f}pp, but lower Sharpe")
    elif e_sh > o_sh:
        print(f"    => EW higher Sharpe: +{e_sh-o_sh:.3f} (Olympus underperforms in this regime)")
    else:
        print(f"    => Similar performance")

# ============================================================
# 9. PBO -- Bailey & Lopez de Prado (on OLYMPUS engine)
# ============================================================
print()
print("=" * 75)
print("  PBO -- Bailey & Lopez de Prado (Olympus Engine)")
print("=" * 75)

M_BOOT = 1000
N_CFG = 20
N_TRAIN = int(nr * 0.5)
pbo_count = 0

for trial in range(M_BOOT):
    idx = list(range(nr))
    random.shuffle(idx)
    is_idx = idx[:N_TRAIN]
    oos_idx = idx[N_TRAIN:]
    is_rets = [eng_aligned[i] for i in is_idx]
    oos_rets = [eng_aligned[i] for i in oos_idx]

    is_sharpes, oos_sharpes = [], []
    for c in range(N_CFG):
        ss = int(len(is_rets) * 0.7)
        is_sharpes.append(sharpe(random.choices(is_rets, k=ss)))
        oos_sharpes.append(sharpe(random.choices(oos_rets, k=ss)))

    best_idx = max(range(N_CFG), key=lambda i: is_sharpes[i])
    median_oos = sorted(oos_sharpes)[N_CFG // 2]
    if oos_sharpes[best_idx] < median_oos:
        pbo_count += 1

pbo_val = pbo_count / M_BOOT
# Bootstrap CI for PBO
pbo_bs = []
for _ in range(200):
    bs_count = sum(1 for _ in range(M_BOOT) if random.random() < pbo_val)
    pbo_bs.append(bs_count / M_BOOT)
pbo_bs.sort()
ci_lo = pbo_bs[5]
ci_hi = pbo_bs[194]

print(f"  PBO: {pbo_val*100:.1f}%")
print(f"  95% CI: [{ci_lo*100:.1f}%, {ci_hi*100:.1f}%]")
print(f"  N configs: {N_CFG}, M bootstraps: {M_BOOT}")

if pbo_val > 0.35:
    print(f"  Interpretation: HIGH overfitting risk (>35%)")
elif pbo_val > 0.20:
    print(f"  Interpretation: MODERATE overfitting risk (20-35%)")
else:
    print(f"  Interpretation: LOW overfitting risk (<20%)")

# ============================================================
# 10. DIEBOLD-MARIANO TEST
# ============================================================
print()
print("=" * 75)
print("  DIEBOLD-MARIANO TEST -- Olympus vs EW (statistical significance)")
print("=" * 75)

# Compare squared errors (MSE loss)
loss_diff = [eng_aligned[i]**2 - ew_aligned[i]**2 for i in range(nr)]
d_mean = sum(loss_diff) / len(loss_diff)

# Newey-West long-run variance (h=4 for daily data)
h = 4
autocov = [0.0] * (h + 1)
for lag in range(h + 1):
    cov_sum = 0
    for t in range(lag, len(loss_diff)):
        cov_sum += (loss_diff[t] - d_mean) * (loss_diff[t - lag] - d_mean)
    autocov[lag] = cov_sum / len(loss_diff)

lr_var = autocov[0]
for lag in range(1, h + 1):
    weight = 1 - lag / (h + 1)
    lr_var += 2 * weight * autocov[lag]

dm_stat = d_mean / math.sqrt(max(1e-16, lr_var / len(loss_diff)))

# p-value (two-sided normal approximation)
def norm_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))

p_val = 2 * (1 - norm_cdf(abs(dm_stat)))

print(f"  DM Statistic: {dm_stat:.4f}")
print(f"  p-value (two-sided): {p_val:.4f}")
print(f"  Mean squared loss diff (Olympus - EW): {d_mean*10000:.6f} bps^2")

if p_val < 0.01:
    print(f"  *** SIGNIFICANT at 1% level -- Olympus is statistically different from EW")
elif p_val < 0.05:
    print(f"  ** SIGNIFICANT at 5% level")
elif p_val < 0.10:
    print(f"  * SIGNIFICANT at 10% level")
else:
    print(f"  NOT significant -- cannot reject that Olympus = EW")

# Bootstrap test on mean return difference
print()
print("  Bootstrap test on mean daily return difference:")
ret_diff = [eng_aligned[i] - ew_aligned[i] for i in range(nr)]
obs_mean = sum(ret_diff) / len(ret_diff)
obs_annual = obs_mean * 252
print(f"  Observed mean daily difference: {obs_mean*100:.4f}% ({obs_annual*100:.2f}% annualized)")

n_bs = 10000
bs_means = []
for _ in range(n_bs):
    sample = random.choices(ret_diff, k=len(ret_diff))
    bs_means.append(sum(sample) / len(sample))
bs_means.sort()

bs_lo = bs_means[250]
bs_hi = bs_means[9749]
print(f"  Bootstrap 95% CI: [{bs_lo*100:.4f}%, {bs_hi*100:.4f}%] daily")
print(f"  Bootstrap 95% CI: [{bs_lo*252*100:.2f}%, {bs_hi*252*100:.2f}%] annualized")

if bs_lo <= 0 <= bs_hi:
    print(f"  => 0 IS in the CI -- difference NOT statistically significant at 5%")
else:
    direction = "Olympus OUTPERFORMS EW" if obs_mean > 0 else "EW OUTPERFORMS Olympus"
    print(f"  => 0 is NOT in CI -- {direction} (significant at 5%)")

# ============================================================
# 11. FINAL VERDICT
# ============================================================
print()
print("=" * 75)
print("  FINAL VERDICT")
print("=" * 75)

verdicts = []

# DM test
if p_val < 0.05:
    verdicts.append(("DM Test", "PASS", f"Significant difference (p={p_val:.4f})"))
else:
    verdicts.append(("DM Test", "FAIL", f"NOT significant (p={p_val:.4f})"))

# Sharpe delta
sh_diff = results['Sharpe']['delta']
verdicts.append(("Sharpe", "PASS" if sh_diff > 0.05 else "WARN" if sh_diff > 0 else "FAIL", f"Olympus {sh_diff:+.3f} vs EW"))

# MaxDD protection
dd_diff = results['MaxDD']['delta']
verdicts.append(("MaxDD Protection", "PASS" if dd_diff > 0 else "FAIL", f"Olympus saves {dd_diff*100:.1f}pp drawdown"))

# Sortino
so_diff = results['Sortino']['delta']
verdicts.append(("Sortino", "PASS" if so_diff > 0.1 else "WARN" if so_diff > 0 else "FAIL", f"Olympus {so_diff:+.3f}"))

# PBO
if pbo_val < 0.20:
    verdicts.append(("PBO", "PASS", f"{pbo_val*100:.1f}% -- low overfitting"))
elif pbo_val < 0.35:
    verdicts.append(("PBO", "WARN", f"{pbo_val*100:.1f}% -- moderate"))
else:
    verdicts.append(("PBO", "FAIL", f"{pbo_val*100:.1f}% -- HIGH overfitting"))

# Rolling Sharpe stability
rs_std_diff = st.stdev(rs_ew) - st.stdev(rs_olymp)
verdicts.append(("Rolling Sharpe Stability", "PASS" if rs_std_diff > 0 else "WARN", f"Olympus std {st.stdev(rs_olymp):.3f} vs EW {st.stdev(rs_ew):.3f}"))

# Bootstrap significance
if bs_lo <= 0 <= bs_hi:
    verdicts.append(("Bootstrap Mean Diff", "FAIL", "Not significant (0 in CI)"))
else:
    direction = "Olympus wins" if obs_mean > 0 else "EW wins"
    verdicts.append(("Bootstrap Mean Diff", "PASS" if obs_mean > 0 else "FAIL", f"Significant: {direction}"))

for test, grade, note in verdicts:
    symbol = {"PASS": "[OK]", "WARN": "[??]", "FAIL": "[XX]"}[grade]
    print(f"  {symbol} {test:<30} {note}")

pass_count = sum(1 for _, g, _ in verdicts if g == "PASS")
warn_count = sum(1 for _, g, _ in verdicts if g == "WARN")
fail_count = sum(1 for _, g, _ in verdicts if g == "FAIL")
print(f"\n  RESULTS: {pass_count} PASS | {warn_count} WARN | {fail_count} FAIL out of {len(verdicts)} tests")

print()
print("=" * 75)
print("  DONE")
print("=" * 75)
