import json, csv, math

with open('engine_returns.json', 'r') as f:
    eng = json.load(f)

fd = eng['forensicDates']
fa = eng['forensicAllocations']
fr = eng['forensicRegimes']
fdd = eng['forensicDrawdowns']
frf = eng.get('forensicRebalanceFlags', [])
vix_levels = eng.get('vixLevels', [])

assets = ['BTC-EUR','EMXC.DE','0P00000WLG.F','PPFB.DE','URNU.DE','VVSM.DE']

print(f"Forensic data: {len(fd)} records, {len(fd[0]) if fd else 0}")
print(f"Allocation snapshots: {len(fa[assets[0]]) if assets[0] in fa else 0}")
print()

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

ew_rets = []
for i in range(1, len(closes['BTC-EUR'])):
    er = sum(closes[a][i] / closes[a][i-1] - 1 for a in assets) / len(assets)
    ew_rets.append(er)

crises = [
    {'name': '2018 BEAR (BTC -73%)', 'start': '2018-01-01', 'end': '2018-12-31'},
    {'name': '2020 COVID CRASH', 'start': '2020-02-19', 'end': '2020-03-23'},
    {'name': '2022 RATE HIKES', 'start': '2022-01-01', 'end': '2022-12-31'},
]

all_results = []

for crisis in crises:
    name = crisis['name']
    start = crisis['start']
    end = crisis['end']

    idxs = [i for i, d in enumerate(fd) if start <= d <= end]
    if len(idxs) < 5:
        print(f"{name}: INSUFFICIENT DATA")
        continue

    first_i = idxs[0]
    last_i = idxs[-1]
    mid_i = idxs[len(idxs)//2]

    vix_during = [vix_levels[i] for i in idxs if i < len(vix_levels)]
    vix_max = max(vix_during) if vix_during else 0
    vix_avg = sum(vix_during)/len(vix_during) if vix_during else 0

    regime_sequence = []
    current_regime = None
    for i in idxs:
        r = fr[i] if i < len(fr) else '?'
        if r != current_regime:
            regime_sequence.append((fd[i][:10], r))
            current_regime = r

    rebalance_dates = []
    for i in idxs:
        if i < len(frf) and frf[i]:
            rebalance_dates.append(fd[i][:10])

    def get_alloc(idx):
        if idx >= len(fa[assets[0]]):
            return {}
        return {a: fa[a][idx] * 100 for a in assets}

    alloc_start = get_alloc(first_i)
    alloc_mid = get_alloc(mid_i)
    alloc_end = get_alloc(last_i)

    total_turnover = 0
    turnover_events = []
    prev_i = first_i
    for i in idxs:
        if i < len(frf) and frf[i] and i > first_i:
            turn = 0
            for a in assets:
                if prev_i < len(fa[a]) and i < len(fa[a]):
                    turn += abs(fa[a][i] - fa[a][prev_i])
            total_turnover += turn
            if turn > 0.01:
                turnover_events.append((fd[i][:10], turn * 100))
            prev_i = i

    oly_dd_start = fdd[first_i] if first_i < len(fdd) else 0
    oly_dd_end = fdd[last_i] if last_i < len(fdd) else 0
    oly_dd_peak = max([fdd[i] for i in idxs if i < len(fdd)], default=0)

    ew_cum = 1.0
    ew_peak = 1.0
    ew_max_dd = 0
    for i in range(len(ew_rets)):
        d = csv_dates[i+1] if i+1 < len(csv_dates) else ""
        if d < start:
            continue
        if d > end:
            break
        ew_cum *= (1 + ew_rets[i])
        if ew_cum > ew_peak:
            ew_peak = ew_cum
        dd = (ew_peak - ew_cum) / ew_peak
        if dd > ew_max_dd:
            ew_max_dd = dd

    regime_counts = {}
    for i in idxs:
        r = fr[i] if i < len(fr) else '?'
        regime_counts[r] = regime_counts.get(r, 0) + 1
    dominant = max(regime_counts, key=regime_counts.get)
    pct_dominant = regime_counts[dominant] / len(idxs) * 100

    biggest_shift = ('', 0)
    for a in assets:
        shift = abs(alloc_end.get(a, 0) - alloc_start.get(a, 0))
        if shift > biggest_shift[1]:
            biggest_shift = (a, shift)

    print(f"\n{'='*80}")
    print(f"  FORENSIC: {name}")
    print(f"{'='*80}")
    print(f"  Period: {start} -> {end} ({len(idxs)} days)")
    print(f"  VIX: avg {vix_avg:.1f}, max {vix_max:.1f}")
    print()

    print(f"  [REGIME DETECTION]")
    print(f"  {'Date':<12} {'Regime':<15}")
    print(f"  {'-'*27}")
    for dt, reg in regime_sequence:
        print(f"  {dt:<12} {reg:<15}")
    print()

    print(f"  [ALLOCATIONS]")
    print(f"  {'Asset':<15} {'START':>8} {'MID':>8} {'END':>8} {'Change':>10}")
    print(f"  {'-'*49}")
    for a in assets:
        s_val = alloc_start.get(a, 0)
        m_val = alloc_mid.get(a, 0)
        e_val = alloc_end.get(a, 0)
        change = e_val - s_val
        print(f"  {a:<15} {s_val:>7.1f}% {m_val:>7.1f}% {e_val:>7.1f}% {change:>+9.1f}%")
    print()

    print(f"  [EXECUTED ORDERS]")
    print(f"  Rebalance days in crisis: {len(rebalance_dates)}")
    if rebalance_dates:
        print(f"  Dates: {', '.join(rebalance_dates[:8])}" + ("..." if len(rebalance_dates) > 8 else ""))
    print(f"  Turnover events: {len(turnover_events)}")
    for dt, turn in turnover_events:
        print(f"    {dt}: {turn:.1f}% turnover")
    print(f"  Total turnover in crisis: {total_turnover*100:.1f}%")
    print()

    print(f"  [DRAWDOWN]")
    print(f"  {'Metric':<30} {'Olympus':>12} {'EW Proxy':>12} {'Protection':>12}")
    print(f"  {'-'*66}")
    print(f"  {'Max Drawdown':<30} {oly_dd_peak*100:>11.1f}% {ew_max_dd*100:>11.1f}% {(ew_max_dd-oly_dd_peak)*100:>+11.1f}pp")
    protection = (ew_max_dd - oly_dd_peak) * 100
    print()

    print(f"  [SUMMARY]")
    print(f"  Dominant regime: {dominant} ({pct_dominant:.0f}% of days)")
    print(f"  Biggest allocation shift: {biggest_shift[0]} ({biggest_shift[1]:.1f}pp)")
    print(f"  DD protection vs EW: {protection:+.1f}pp")
    if oly_dd_peak < ew_max_dd:
        print(f"  => Olympus REDUCED drawdown by {protection:.1f}pp")
    else:
        print(f"  => Olympus did NOT reduce drawdown")

    all_results.append((name, oly_dd_peak, ew_max_dd, protection, dominant, alloc_start, regime_sequence, turnover_events))

print(f"\n{'='*80}")
print(f"  FINAL CRISIS COMPARISON TABLE")
print(f"{'='*80}")
print()
print(f"  {'Crisis':<22} {'Oly MaxDD':>12} {'EW MaxDD':>12} {'Protection':>14} {'Dominant Regime':>18}")
print(f"  {'-'*78}")
for name, oly_dd, ew_dd, prot, dom, allocs, regs, turns in all_results:
    print(f"  {name:<22} {oly_dd*100:>11.1f}% {ew_dd*100:>11.1f}% {prot:>+13.1f}pp {dom:<18}")

print()
for name, oly_dd, ew_dd, prot, dom, allocs, regs, turns in all_results:
    print(f"  --- {name} ---")
    print(f"  Allocations at crisis start:")
    for a in assets:
        print(f"    {a:<15} {allocs.get(a, 0):>6.1f}%")
    print(f"  Regime changes: {[f'{d}({r})' for d, r in regs]}")
    print(f"  Turnover events: {[(d, f'{t:.1f}%') for d, t in turns]}")
    print()

print("=" * 80)
print("  DONE")
print("=" * 80)
