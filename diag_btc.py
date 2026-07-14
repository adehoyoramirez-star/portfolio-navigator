import csv

closes = []
with open('historical_data_daily_augmented.csv', 'r') as f:
    reader = csv.reader(f)
    headers = next(reader)
    bi = headers.index('BTC-EUR')
    for i, row in enumerate(reader):
        try:
            v = float(row[bi])
            if v > 0:
                closes.append(v)
        except:
            pass

print(f"Total closes: {len(closes)}")
print(f"First 5 closes: {closes[:5]}")
print(f"Last 3 closes: {closes[-3:]}")

btc_r = [(closes[i] / closes[i-1] - 1) for i in range(1, len(closes))]
print(f"Total returns: {len(btc_r)}")
print(f"First 5 returns: {[f'{r*100:.3f}%' for r in btc_r[:5]]}")
print(f"Returns around idx 252: {[f'{r*100:.3f}%' for r in btc_r[250:255]]}")
print(f"Last 5 returns: {[f'{r*100:.3f}%' for r in btc_r[-5:]]}")

# Check alignment: Olympus starts at index 253
oly_start = 253
print(f"\nOlympus would start at btc_r[{oly_start}] = {btc_r[oly_start]*100:.3f}%")
print(f"btc_r[252] = {btc_r[252]*100:.3f}%")
print(f"btc_r[253] = {btc_r[253]*100:.3f}%")

# Compute stats for btc_r slice
import math
btc_slice = btc_r[252:252+3863]
m = sum(btc_slice) / len(btc_slice)
v = sum((x - m) ** 2 for x in btc_slice) / len(btc_slice)
s = math.sqrt(max(1e-16, v))
sh = (m * 252 - 0.04) / (s * math.sqrt(252))
print(f"\nBTC slice [252:252+3863]:")
print(f"  mean daily: {m*100:.4f}%")
print(f"  vol annual: {math.sqrt(v*252)*100:.2f}%")
print(f"  Sharpe: {sh:.3f}")

# What does 5% of a BTC return look like?
print(f"\n0.05 * btc_r[252] = {0.05 * btc_r[252]*100:.4f}%")
print(f"0.05 * btc_r[253] = {0.05 * btc_r[253]*100:.4f}%")
