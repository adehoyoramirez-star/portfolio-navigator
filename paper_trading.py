#!/usr/bin/env python3
"""paper_trading.py — Olympus V5 Paper Trading Tracker

Usage:
  python paper_trading.py snapshot
  python paper_trading.py trade --ticker X --action BUY --shares N --price P
  python paper_trading.py weekly
  python paper_trading.py benchmark
  python paper_trading.py report --month YYYY-MM
  python paper_trading.py status
"""

import csv, sys
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).parent
JOURNAL = BASE / "paper_trading_journal.csv"
BENCHMARK = BASE / "benchmark_tracker.csv"
REPORTS = BASE / "reports"

INITIAL_POSITIONS = {
    "BTC-EUR": {"shares": 0.031285, "price": 88010.99},
    "EMXC.DE": {"shares": 31, "price": 28.93},
    "0P00000WLG.F": {"shares": 26, "price": 67.53},
    "PPFB.DE": {"shares": 4, "price": 69.39},
    "URNU.DE": {"shares": 13, "price": 26.48},
    "VVSM.DE": {"shares": 2, "price": 52.01},
}
INITIAL_CASH = 6700.0
INITIAL_DATE = "2026-07-01"

def initial_total():
    equity = sum(p["shares"] * p["price"] for p in INITIAL_POSITIONS.values())
    return equity + INITIAL_CASH

def load_journal():
    if not JOURNAL.exists():
        return []
    with open(JOURNAL, "r", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def load_benchmark():
    if not BENCHMARK.exists():
        return []
    with open(BENCHMARK, "r", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def cmd_snapshot():
    today = datetime.now().strftime("%Y-%m-%d")
    rows = load_journal()
    positions = dict(INITIAL_POSITIONS)
    cash = INITIAL_CASH
    for row in rows:
        if row["action"] in ("BUY", "SELL"):
            ticker = row["ticker"]
            shares = float(row["shares"])
            price = float(row["price"])
            value = float(row["value"])
            if row["action"] == "BUY":
                if ticker in positions:
                    positions[ticker]["shares"] += shares
                else:
                    positions[ticker] = {"shares": shares, "price": price}
                cash -= value
            else:
                if ticker in positions:
                    positions[ticker]["shares"] -= shares
                cash += value
    equity = sum(pos["shares"] * pos["price"] for t, pos in positions.items() if pos["shares"] > 0)
    total = equity + cash
    with open(JOURNAL, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([today, "SNAPSHOT", "", "", "", f"{equity:.2f}", f"{cash:.2f}", f"{total:.2f}", "", ""])
    print(f"Snap {today}: Equity={equity:,.0f} Cash={cash:,.0f} Total={total:,.0f}")

def cmd_trade():
    args = {}
    i = 2
    while i < len(sys.argv):
        if sys.argv[i].startswith("--"):
            key = sys.argv[i][2:]
            val = sys.argv[i+1] if i+1 < len(sys.argv) else ""
            args[key] = val
            i += 2
        else:
            i += 1
    ticker = args.get("ticker", "")
    action = args.get("action", "").upper()
    shares = float(args.get("shares", 0))
    price = float(args.get("price", 0))
    if not ticker or action not in ("BUY", "SELL") or shares <= 0 or price <= 0:
        print("Usage: python paper_trading.py trade --ticker BTC-EUR --action BUY --shares 0.001 --price 87500")
        sys.exit(1)
    value = shares * price
    today = datetime.now().strftime("%Y-%m-%d")
    with open(JOURNAL, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([today, action, ticker, f"{shares:.6f}", f"{price:.2f}", f"{value:.2f}", "", "", "", ""])
    print(f"Trade: {action} {shares} {ticker} @ {price:.2f} = {value:.2f}")

def cmd_weekly():
    bm = load_benchmark()
    jn = load_journal()
    if not bm:
        print("No benchmark data. Run: python paper_trading.py benchmark")
        return
    print("=" * 60)
    print("WEEKLY REPORT — Olympus V5 Paper Trading")
    print("=" * 60)
    last = bm[-1]
    initial = initial_total()
    pt_value = float(last["portfolio_total_value"])
    ew_value = float(last["ew_total_value"])
    pt_ret = (pt_value / initial - 1) * 100
    ew_ret = (ew_value / initial - 1) * 100
    print(f"\nPortfolio: {pt_value:,.0f} ({pt_ret:+.1f}%)")
    print(f"Benchmark EW: {ew_value:,.0f} ({ew_ret:+.1f}%)")
    print(f"Difference: {pt_ret - ew_ret:+.1f}pp")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    trades = [r for r in jn if r["action"] in ("BUY", "SELL") and r["date"] >= week_ago]
    print(f"Trades this week: {len(trades)}")

def cmd_benchmark():
    today = datetime.now().strftime("%Y-%m-%d")
    jn = load_journal()
    pt_value = initial_total()
    for row in jn:
        if row["action"] == "SNAPSHOT" and row["total_value"]:
            pt_value = float(row["total_value"])
    initial = initial_total()
    ew_weight = 1.0 / len(INITIAL_POSITIONS)
    ew_value = sum((initial * ew_weight / pos["price"]) * pos["price"] for pos in INITIAL_POSITIONS.values())
    with open(BENCHMARK, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([today, f"{ew_value:.2f}", f"{pt_value:.2f}", "0", "0", "0", "0", ""])
    print(f"Benchmark: EW={ew_value:,.0f} PT={pt_value:,.0f}")

def cmd_report():
    month = datetime.now().strftime("%Y-%m")
    for i, arg in enumerate(sys.argv):
        if arg == "--month" and i+1 < len(sys.argv):
            month = sys.argv[i+1]
    jn = load_journal()
    if not jn:
        print("No journal data")
        return
    month_rows = [r for r in jn if r["date"].startswith(month)]
    if not month_rows:
        print(f"No data for {month}")
        return
    initial = initial_total()
    snaps = [r for r in month_rows if r["action"] == "SNAPSHOT"]
    trades = [r for r in month_rows if r["action"] in ("BUY", "SELL")]
    last_total = float(snaps[-1]["total_value"]) if snaps else initial
    month_return = (last_total / initial - 1) * 100
    REPORTS.mkdir(exist_ok=True)
    rp = REPORTS / f"{month}.md"
    with open(rp, "w", encoding="utf-8") as f:
        f.write(f"# Paper Trading Report — {month}\n\n")
        f.write(f"**Initial capital:** {initial:,.0f}\n")
        f.write(f"**Final capital:** {last_total:,.0f}\n")
        f.write(f"**Return:** {month_return:+.2f}%\n\n")
        f.write(f"**Snapshots:** {len(snaps)}\n")
        f.write(f"**Trades:** {len(trades)}\n\n")
        if trades:
            f.write("| Date | Action | Ticker | Shares | Price | Value |\n")
            f.write("|------|--------|--------|--------|-------|-------|\n")
            for t in trades:
                f.write(f"| {t['date']} | {t['action']} | {t['ticker']} | {t['shares']} | {t['price']} | {t['value']} |\n")
    print(f"Report: {rp}")
    print(f"Return {month}: {month_return:+.2f}% | Snaps: {len(snaps)} | Trades: {len(trades)}")

def cmd_status():
    jn = load_journal()
    bm = load_benchmark()
    print("=" * 50)
    print("PAPER TRADING STATUS — Olympus V5")
    print("=" * 50)
    initial = initial_total()
    print(f"\nInitial capital: {initial:,.0f}")
    snaps = [r for r in jn if r["action"] == "SNAPSHOT"]
    if snaps:
        last = snaps[-1]
        current = float(last["total_value"])
        ret = (current / initial - 1) * 100
        print(f"Current capital: {current:,.0f} ({ret:+.2f}%)")
        print(f"Snapshots: {len(snaps)} days")
    else:
        print("No snapshots yet. Run: python paper_trading.py snapshot")
    trades = [r for r in jn if r["action"] in ("BUY", "SELL")]
    print(f"Trades: {len(trades)}")
    if bm:
        print(f"Benchmarks: {len(bm)} weekly")
    start = datetime.strptime(INITIAL_DATE, "%Y-%m-%d")
    days = (datetime.now() - start).days
    print(f"Days of paper trading: {days}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Commands: snapshot | trade | weekly | benchmark | report | status")
    else:
        cmd = sys.argv[1]
        {"snapshot": cmd_snapshot, "trade": cmd_trade, "weekly": cmd_weekly,
         "benchmark": cmd_benchmark, "report": cmd_report, "status": cmd_status}.get(
            cmd, lambda: print(f"Unknown: {cmd}"))()
