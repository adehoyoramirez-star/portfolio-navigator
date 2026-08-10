#!/usr/bin/env python3
"""Add tactical daily layer to bottom detectors."""
import sys

TARGET = "src/core/risk/cycleTopDetector.ts"
with open(TARGET, "r", encoding="utf-8") as f:
    content = f.read()

changes = 0

# Generic function: find fn_name, find zone line within it, insert tactical code
# Then fix destructuring if needed

tacticals = [
    # [fn_name, old_destr, new_destr, ticker, label, rsi_thresholds_py, z_thresholds_py]
    ["detectUraniumBottom",
     "const { uraniumSpotPrice, uraniumLTPrice } = inputs;",
     "const { uraniumSpotPrice, uraniumLTPrice, priceHistories, regime } = inputs;",
     "URNU.DE", "Uranio",
     "[[20, 15], [30, 10], [40, 5]]",
     "[[-2.5, 15], [-2.0, 10], [-1.5, 5]]"],
    ["detectSemisBottom",
     "const { siaSalesYoY, soxRsiWeekly } = inputs;",
     "const { siaSalesYoY, soxRsiWeekly, priceHistories, regime } = inputs;",
     "VVSM.DE", "Semis",
     "[[20, 15], [30, 10], [40, 5]]",
     "[[-2.5, 15], [-2.0, 10], [-1.5, 5]]"],
    ["detectGoldBottom",
     "const { bondYield10y, inflationBreakeven, brentOil } = inputs;",
     "const { bondYield10y, inflationBreakeven, brentOil, priceHistories, regime } = inputs;",
     "PPFB.DE", "Oro",
     "[[15, 15], [25, 10], [35, 5]]",
     "[[-3.0, 15], [-2.5, 10], [-2.0, 5]]"],
    ["detectWLGBottom",
     "const { wlgRsiWeekly, wlgPERatio, wlgCAPE } = inputs;",
     "const { wlgRsiWeekly, wlgPERatio, wlgCAPE, priceHistories, regime } = inputs;",
     "0P00000WLG.F", "WLG",
     "[[25, 10], [35, 5]]",
     "[[-2.5, 10], [-2.0, 5]]"],
    ["detectEMXCBottom",
     "const { emxcRsiWeekly, emxcPERatio, dxy } = inputs;",
     "const { emxcRsiWeekly, emxcPERatio, dxy, priceHistories, regime } = inputs;",
     "EMXC.DE", "EMXC",
     "[[20, 12], [30, 8], [40, 4]]",
     "[[-2.5, 12], [-2.0, 8], [-1.5, 4]]"],
]

for (fn_name, old_destr, new_destr, ticker, label, rsi_thr, z_thr) in tacticals:
    # Step 1: Fix destructuring
    destr_fixed = False
    if old_destr in content:
        content = content.replace(old_destr, new_destr)
        destr_fixed = True
        changes += 1
        print(f"[OK] {fn_name}: destructuring")
    elif new_destr in content:
        destr_fixed = True
        print(f"[SKIP] {fn_name}: destructuring already correct")
    else:
        print(f"[MISS] {fn_name}: destructuring pattern NOT FOUND")
        idx = content.find("function " + fn_name)
        if idx >= 0:
            snippet = content[idx:idx+350].replace('\n', '|')
            print(f"  Context: ...{snippet[:250]}...")
        continue

    # Step 2: Insert tactical call before scoreToZone
    fn_start = content.find("function " + fn_name)
    if fn_start < 0:
        print(f"  [ERR] Cannot find {fn_name}")
        continue

    next_fn = content.find("function detect", fn_start + 50)
    if next_fn < 0:
        next_fn = content.find("export function detectCycleBottoms", fn_start + 50)
    if next_fn < 0:
        next_fn = len(content)

    zone_line = "const zone = scoreToZone(score);\n"
    zone_pos = content.find(zone_line, fn_start, next_fn)
    if zone_pos < 0:
        print(f"  [MISS] scoreToZone not found in {fn_name}")
        continue

    var_prefix = label.lower()[:4]
    tactical_code = f"""  // - Capa Tactica Diaria ({label}) -
  const t_{var_prefix} = applyTacticalDaily(
    score, priceHistories?.["{ticker}"], regime, "{label}",
    {rsi_thr},
    {z_thr}
  );
  score = t_{var_prefix}.score;
  reasons.push(...t_{var_prefix}.reasons);

"""

    content = content[:zone_pos] + tactical_code + content[zone_pos:]
    changes += 1
    print(f"[OK] {fn_name}: tactical layer inserted")

# Write back
if changes >= 6:
    with open(TARGET, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"\n[DONE] {changes} changes -> {TARGET}")
else:
    print(f"\n[WARN] Only {changes} changes. Not writing.")
    sys.exit(1)
