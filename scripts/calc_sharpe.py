import csv, math
values = []
drawdowns = []
regimes = []
with open('backtest_result_simple.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        values.append(float(row['Valor']))
        drawdowns.append(float(row['Drawdown']))
        regimes.append(row['Regimen'])

daily_rets = []
for i in range(1, len(values)):
    if values[i-1] > 0:
        r = values[i] / values[i-1] - 1
        daily_rets.append(r)

n = len(daily_rets)
years = n / 252
initial = values[0]
final = values[-1]
total_return = final / initial - 1
cagr = (final / initial) ** (1 / years) - 1

mean_ret = sum(daily_rets) / n
variance = sum((r - mean_ret) ** 2 for r in daily_rets) / (n - 1)
vol = math.sqrt(variance) * math.sqrt(252)

rf_daily = 0.04 / 252
excess = [r - rf_daily for r in daily_rets]
ex_mean = sum(excess) / n
ex_std = math.sqrt(sum((e - ex_mean) ** 2 for e in excess) / (n - 1)) * math.sqrt(252)
sharpe = (ex_mean * 252) / ex_std if ex_std > 0 else 0

max_dd = min(drawdowns)
calmar = cagr / abs(max_dd) if max_dd < 0 else 0
wins = sum(1 for r in daily_rets if r > 0)
win_rate = wins / n
best_day = max(daily_rets)
worst_day = min(daily_rets)

from collections import Counter
rc = Counter(regimes)

print('PERIODO: {} dias = {:.1f} anos'.format(n, years))
print('Valor inicial: {:.2f} EUR'.format(initial))
print('Valor final:   {:.2f} EUR'.format(final))
print('Retorno total: {:.1f}0ormat(total_return*100))
print()
print('CAGR:           {:.2f}0ormat(cagr*100))
print('Volatilidad:    {:.2f}0ormat(vol*100))
print('Sharpe Ratio:   {:.3f}'.format(sharpe))
print('Calmar Ratio:   {:.3f}'.format(calmar))
print('Max Drawdown:   {:.1f}0ormat(max_dd*100))
print('Win Rate:       {:.1f}0ormat(win_rate*100))
print('Mejor dia:      {:.2f}0ormat(best_day*100))
print('Peor dia:       {:.2f}0ormat(worst_day*100))
print()
print('Distribucion regimenes:')
for regime, count in sorted(rc.items()):
    print('  {}: {} dias ({:.1f}