"""
WHALE DETECTOR v5.2 — Python Backtest Engine
=============================================
Replica exacta del OLYMPUS_Whale_Detector_v5_2_BACKTEST.pine
para backtesting multi-ticker automatizado.

Uso:
    python whale_backtest.py [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                             [--capital 10000] [--commission 0.1]
                             [--from predictions.csv] [--all]

    --from FILE    Lee tickers desde un CSV (ej. predictions.csv del Factor Lab)
                   Por defecto solo backtestea los Q5 (score >= 80)
    --all          Con --from, backtestea TODOS los tickers del CSV, no solo Q5

Salida:
    - Tabla de resultados en consola
    - whale_backtest_results.csv con metricas por ticker
    - whale_backtest_trades.csv con todas las operaciones individuales
"""
import sys, time, warnings, os
import numpy as np
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

# ============================================================================
# CONFIGURACION POR DEFECTO (identica al Pine Script optimizado)
# ============================================================================
CONFIG = {
    "date_start": "2020-01-01",
    "date_end":   "2025-12-31",
    "use_date_filter": True,
    "swing_lookback": 5,
    "bos_min_body": 0.3,
    "ob_lookback": 10,
    "ob_volume_min": 0.9,
    "vol_ma_len": 20,
    "vol_displ_min": 1.0,
    "vol_retrace_max": 0.8,
    "htf_ema_fast": 10,
    "htf_ema_slow": 30,
    "sl_buffer": 0.15,
    "trail_act": 3.5,
    "rr_min": 2.0,
    "use_htf_filter":    False,
    "use_vol_retrace":   False,
    "use_trend_filter":  False,
    "use_vol_ob":        True,
    "use_vol_bos":       True,
    "capital":       10000.0,
    "commission_pct": 0.1,
    "slippage_pct":   0.05,
    "qty_pct":        10.0,
}

# ============================================================================
# UNIVERSO DE TEST — Fusion completa: ETFs clasicos + Sectoriales + Acciones
# ============================================================================
UNIVERSE = {
    "Benchmark": [
        "SPY", "QQQ", "IWM", "DIA", "MDY",
    ],
    "Sectores SPDR": [
        "XLK", "XLF", "XLV", "XLY", "XLI", "XLC", "XLE", "XLP",
        "XLRE", "XLB", "XLU",
    ],
    "Internacional": [
        "EEM", "EFA", "EWJ", "FXI", "EWZ", "INDA", "IEUR", "VGK",
    ],
    "Commodities/Bonos": [
        "GLD", "SLV", "USO", "DBC", "TLT", "AGG", "LQD", "HYG",
    ],
    "Crypto": [
        "IBIT", "FBTC", "BITO", "GBTC",
    ],
    "Tech & AI": [
        "BOTZ", "CIBR", "CLOU", "SMH", "XSD", "DCLD", "IOTWF",
        "SOCL", "VPN",
    ],
    "Semiconductores": [
        "SMH", "XSD",
    ],
    "EV & Transporte": [
        "DRIV", "EVX", "IYT",
    ],
    "Energia & Clean": [
        "TAN", "ICLN", "NLR", "VDE", "PWND",
    ],
    "Healthcare & Biotech": [
        "IBB", "XLV", "GNOM", "VHT", "IXJ",
    ],
    "Fintech": [
        "FINX", "GFIN", "BKCH",
    ],
    "Real Estate": [
        "VNQ", "XLRE",
    ],
    "Materiales & Mineria": [
        "GDX", "COPX", "REMX", "DBMM", "SLV",
    ],
    "Consumo": [
        "VCR", "VDC", "EBIZ", "HERO",
    ],
    "Aero & Defensa": [
        "PPA",
    ],
    "Otros": [
        "CALF", "BIT", "CORE", "EUSA", "PRIVX", "RAREQ", "IXP", "VZ",
    ],
    "Acciones": [
        "NVDA", "MSFT", "AAPL", "AMZN", "META",
        "GOOGL", "TSLA", "AMD", "AVGO", "MU",
    ],
}


def rma(series: pd.Series, length: int) -> pd.Series:
    """Wilder's RMA (ta.rma en Pine Script)"""
    alpha = 1.0 / length
    rma_vals = np.full(len(series), np.nan)
    rma_vals[length - 1] = series.iloc[:length].mean()
    for i in range(length, len(series)):
        rma_vals[i] = alpha * series.iloc[i] + (1 - alpha) * rma_vals[i - 1]
    return pd.Series(rma_vals, index=series.index)


def atr_wilder(df: pd.DataFrame, length: int = 14) -> pd.Series:
    """ATR Wilder's smoothing (ta.atr)"""
    prev_close = df["Close"].shift(1)
    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - prev_close).abs(),
        (df["Low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return rma(tr, length)


def ema(series: pd.Series, length: int) -> pd.Series:
    return series.ewm(span=length, adjust=False).mean()


def build_weekly_ema(df_daily, ema_fast, ema_slow):
    """HTF Weekly EMAs shifted 1 bar, ffill to daily"""
    weekly = df_daily["Close"].resample("W-FRI").ohlc()
    wclose = weekly["close"]
    w_fast = ema(wclose, ema_fast).shift(1)
    w_slow = ema(wclose, ema_slow).shift(1)
    return (
        w_fast.reindex(df_daily.index, method="ffill"),
        w_slow.reindex(df_daily.index, method="ffill"),
    )


def run_whale_backtest(ticker, cfg, verbose=True):
    """Backtest completo Whale Detector v5.2 para un ticker."""

    # 1. Descarga
    start_dt = (datetime.strptime(cfg["date_start"], "%Y-%m-%d")
                - timedelta(days=365))
    end_dt = datetime.strptime(cfg["date_end"], "%Y-%m-%d") + timedelta(days=1)

    try:
        data = yf.download(ticker, start=start_dt, end=end_dt,
                           progress=False, auto_adjust=True)
        if data.empty or len(data) < 252:
            if verbose:
                print(f"  {ticker}: datos insuficientes — saltando")
            return None
    except Exception as e:
        if verbose:
            print(f"  {ticker}: error — {e}")
        return None

    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.droplevel(1)

    df = data.copy()
    df.columns = [c.capitalize() for c in df.columns]
    if not {"Open", "High", "Low", "Close", "Volume"}.issubset(df.columns):
        if verbose:
            print(f"  {ticker}: faltan columnas OHLCV")
        return None

    # 2. Precalculos
    n = len(df)
    df["ATR"] = atr_wilder(df, 14)
    df["VolMA"] = df["Volume"].rolling(cfg["vol_ma_len"]).mean()
    df["Body"] = (df["Close"] - df["Open"]).abs()
    df["EMA50"] = ema(df["Close"], 50)
    df["EMA200"] = ema(df["Close"], 200)
    df["TrendBull"] = df["EMA50"] > df["EMA200"]
    htf_f, htf_s = build_weekly_ema(df, cfg["htf_ema_fast"], cfg["htf_ema_slow"])
    df["HTF_EMA_F"] = htf_f
    df["HTF_EMA_S"] = htf_s
    df["HTF_Bull"] = df["HTF_EMA_F"] > df["HTF_EMA_S"]

    if cfg["use_date_filter"]:
        date_mask = np.asarray((df.index >= cfg["date_start"]) & (df.index <= cfg["date_end"]))
    else:
        date_mask = np.ones(n, dtype=bool)

    # 3. Estado SMC
    swing_highs = []
    swing_lows = []
    has_active_ob = False
    active_ob_top = 0.0
    active_ob_bottom = 0.0
    snap_ob_bottom = 0.0

    in_position = False
    entry_price = 0.0
    entry_date = None
    sl_price = 0.0
    tp_price = 0.0
    entry_bar = -1
    highest_since_entry = 0.0
    trail_sl = 0.0

    # Diagnosticos
    dx = {k: 0 for k in [
        "bos_total", "bos_vol_blk", "ob_found", "ob_vol_blk",
        "ob_touch", "block_htf", "block_vol", "block_trend", "block_bull"
    ]}

    trades = []
    equity = cfg["capital"]
    eq_curve = [cfg["capital"]]

    # Senal de la barra anterior (para entrada en barra siguiente)
    prev_entry_signal = False

    # 4. Bucle principal
    min_idx = max(cfg["swing_lookback"] * 2, cfg["ob_lookback"], 252)
    for idx in range(min_idx, n):
        bar = df.iloc[idx]
        atr_val = bar["ATR"]
        if np.isnan(atr_val) or atr_val <= 0:
            atr_val = bar["Close"] * 0.02
        vol_ma_val = bar["VolMA"]
        if np.isnan(vol_ma_val) or vol_ma_val <= 0:
            vol_ma_val = max(bar["Volume"], 1e6)
        in_window = bool(date_mask[idx]) if cfg["use_date_filter"] else True

        sw_lb = cfg["swing_lookback"]
        swing_idx = idx - sw_lb
        if swing_idx >= sw_lb and swing_idx < n - sw_lb:
            sh = df.iloc[swing_idx]["High"]
            ok = True
            for j in range(1, sw_lb + 1):
                if df.iloc[swing_idx + j]["High"] >= sh or df.iloc[swing_idx - j]["High"] >= sh:
                    ok = False; break
            if ok:
                swing_highs.insert(0, sh)
                if len(swing_highs) > 10: swing_highs.pop()

            slv = df.iloc[swing_idx]["Low"]
            ok = True
            for j in range(1, sw_lb + 1):
                if df.iloc[swing_idx + j]["Low"] <= slv or df.iloc[swing_idx - j]["Low"] <= slv:
                    ok = False; break
            if ok:
                swing_lows.insert(0, slv)
                if len(swing_lows) > 10: swing_lows.pop()

        # BOS
        bos_bull_signal = False
        if len(swing_highs) > 0 and bar["Close"] > bar["Open"]:
            bos_candle = (
                bar["Close"] > swing_highs[0]
                and bar["Body"] > atr_val * cfg["bos_min_body"]
            )
            if bos_candle: dx["bos_total"] += 1
            bos_vol_ok = (not cfg["use_vol_bos"]
                          or bar["Volume"] > vol_ma_val * cfg["vol_displ_min"])
            if bos_candle and not bos_vol_ok: dx["bos_vol_blk"] += 1
            bos_bull_signal = bos_candle and bos_vol_ok

        # OB detection
        if bos_bull_signal and idx >= cfg["ob_lookback"]:
            found = False
            for i in range(1, cfg["ob_lookback"] + 1):
                if found: break
                lb = df.iloc[idx - i]
                if lb["Close"] < lb["Open"]:
                    ob_vol_ok = True
                    if cfg["use_vol_ob"]:
                        lvm = lb["VolMA"]
                        if np.isnan(lvm) or lvm <= 0:
                            lvm = max(lb["Volume"], 1e6)
                        ob_vol_ok = lb["Volume"] >= lvm * cfg["ob_volume_min"]
                    if ob_vol_ok:
                        has_active_ob = True
                        active_ob_top = max(lb["Open"], lb["Close"])
                        active_ob_bottom = min(lb["Open"], lb["Close"])
                        found = True
                        dx["ob_found"] += 1
                    else:
                        dx["ob_vol_blk"] += 1

        # OB invalidation
        if has_active_ob and bar["Close"] < active_ob_bottom - atr_val * 0.1:
            has_active_ob = False

        # Filtros
        f_htf = True
        if cfg["use_htf_filter"]:
            f_htf = bool(bar["HTF_Bull"]) if not pd.isna(bar["HTF_Bull"]) else True
        f_vol = True
        if cfg["use_vol_retrace"]:
            f_vol = bar["Volume"] < vol_ma_val * cfg["vol_retrace_max"]
        f_trend = True
        if cfg["use_trend_filter"]:
            f_trend = bool(bar["TrendBull"]) if not pd.isna(bar["TrendBull"]) else True
        f_bull = bar["Close"] > bar["Open"]

        # Entry signal
        entry_signal = False
        if has_active_ob:
            price_in = (bar["Low"] <= active_ob_top
                        and bar["Low"] >= active_ob_bottom - atr_val * cfg["sl_buffer"])
            prev_lo = df.iloc[idx - 1]["Low"] if idx >= 1 else bar["Low"]
            mitigated = ((prev_lo > active_ob_top and bar["Low"] <= active_ob_top)
                         or (bar["Low"] <= active_ob_top and bar["Close"] > bar["Open"]))
            touches = price_in or mitigated
            if touches:
                dx["ob_touch"] += 1
                if not f_htf: dx["block_htf"] += 1
                if not f_vol: dx["block_vol"] += 1
                if not f_trend: dx["block_trend"] += 1
                if not f_bull: dx["block_bull"] += 1
            entry_signal = touches and f_htf and f_vol and f_trend and f_bull

        if entry_signal and not in_position:
            snap_ob_bottom = active_ob_bottom

        # Trade entry — senal de la barra ANTERIOR (replica entry_long_raw[1])
        # NOTA: La entrada procede aunque el OB se invalide entre senal y entrada
        #       (mismo comportamiento que Pine Script con stored signal)
        if prev_entry_signal and not in_position and in_window:
            sl_dist = bar["Open"] - (snap_ob_bottom - atr_val * cfg["sl_buffer"])
            if sl_dist > 0:
                in_position = True
                entry_price = bar["Open"]
                entry_date = bar.name
                sl_price = snap_ob_bottom - atr_val * cfg["sl_buffer"]
                tp_price = bar["Open"] + sl_dist * cfg["rr_min"]
                entry_bar = idx
                highest_since_entry = bar["Open"]
                trail_sl = bar["Open"] - atr_val * cfg["trail_act"]

        # Trade management
        if in_position:
            if bar["High"] > highest_since_entry:
                highest_since_entry = bar["High"]
                trail_sl = highest_since_entry - atr_val * cfg["trail_act"]
            eff_sl = max(sl_price, trail_sl)
            exit_reason = None
            exit_price = 0.0
            if idx > entry_bar and bar["Close"] < snap_ob_bottom:
                exit_reason = "OB_Inv"
                exit_price = bar["Close"]
            elif bar["Low"] <= eff_sl:
                exit_reason = "SL"
                exit_price = eff_sl
            elif bar["High"] >= tp_price:
                exit_reason = "TP"
                exit_price = tp_price
            elif idx == n - 1:
                exit_reason = "EOD"
                exit_price = bar["Close"]

            if exit_reason is not None:
                cost = cfg["commission_pct"] / 100 + cfg["slippage_pct"] / 100
                net_ret = (exit_price - entry_price) / entry_price - cost
                pnl = cfg["capital"] * (cfg["qty_pct"] / 100) * net_ret
                equity += pnl
                trades.append({
                    "ticker": ticker, "entry_date": entry_date,
                    "exit_date": bar.name, "entry_price": round(entry_price, 2),
                    "exit_price": round(exit_price, 2),
                    "return_pct": round(net_ret * 100, 2),
                    "pnl_eur": round(pnl, 2), "reason": exit_reason,
                })
                in_position = False
                entry_price = sl_price = tp_price = 0.0
                entry_bar = -1
                highest_since_entry = trail_sl = 0.0

        # Guardar senal para la siguiente iteracion
        prev_entry_signal = entry_signal

        eq_curve.append(equity)

    # 5. Metricas
    if len(trades) == 0:
        return {
            "ticker": ticker, "trades": 0, "wins": 0, "losses": 0,
            "win_rate": 0.0, "profit_factor": 0.0, "net_pnl": 0.0,
            "return_pct": 0.0, "max_dd_pct": 0.0,
            **{f"dx_{k}": v for k, v in dx.items()},
            "trades_list": [],
        }

    tdf = pd.DataFrame(trades)
    wins = tdf[tdf["pnl_eur"] > 0]
    losses = tdf[tdf["pnl_eur"] <= 0]
    gp = wins["pnl_eur"].sum() if len(wins) > 0 else 0
    gl = abs(losses["pnl_eur"].sum()) if len(losses) > 0 else 0
    wr = len(wins) / len(tdf) * 100
    pf = gp / gl if gl > 0 else (999.0 if gp > 0 else 0.0)
    net_pnl = equity - cfg["capital"]
    ret_pct = (equity / cfg["capital"] - 1) * 100
    eq_arr = np.array(eq_curve)
    cmax = np.maximum.accumulate(eq_arr)
    max_dd = np.min((eq_arr - cmax) / cmax) * 100 if len(eq_arr) > 1 else 0.0

    return {
        "ticker": ticker, "trades": len(tdf), "wins": len(wins),
        "losses": len(losses), "win_rate": round(wr, 1),
        "profit_factor": round(pf, 2), "net_pnl": round(net_pnl, 2),
        "return_pct": round(ret_pct, 1), "max_dd_pct": round(max_dd, 1),
        **{f"dx_{k}": v for k, v in dx.items()},
        "trades_list": trades,
    }


def load_tickers_from_csv(filepath, q5_only=True):
    """Lee tickers desde un CSV (formato predictions.csv: ticker,score,quintile,...).
    Si q5_only=True, solo devuelve los Q5 (score >= 80)."""
    # Resolver ruta relativa al directorio del script
    if not os.path.isabs(filepath):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        filepath = os.path.join(script_dir, filepath)
    if not os.path.exists(filepath):
        print(f"  ERROR: No se encuentra {filepath}")
        return None
    try:
        df = pd.read_csv(filepath)
        if "ticker" not in df.columns:
            print(f"  ERROR: {filepath} no tiene columna 'ticker'")
            return None
        tickers = df["ticker"].dropna().unique().tolist()
        if q5_only and "score" in df.columns:
            q5 = df[df["score"] >= 80]["ticker"].dropna().unique().tolist()
            print(f"  Leyendo {filepath}: {len(tickers)} tickers -> {len(q5)} Q5 (score>=80)")
            return q5
        elif q5_only and "quintile" in df.columns:
            q5 = df[df["quintile"] == 5]["ticker"].dropna().unique().tolist()
            print(f"  Leyendo {filepath}: {len(tickers)} tickers -> {len(q5)} Q5")
            return q5
        else:
            print(f"  Leyendo {filepath}: {len(tickers)} tickers (todos)")
            return tickers
    except Exception as e:
        print(f"  ERROR leyendo {filepath}: {e}")
        return None


def main():
    print("=" * 80)
    print("  [WHALE] DETECTOR v5.2 -- Python Backtest Engine")
    print("=" * 80)

    cfg = CONFIG.copy()
    for i, arg in enumerate(sys.argv):
        if arg == "--start" and i + 1 < len(sys.argv):
            cfg["date_start"] = sys.argv[i + 1]
        elif arg == "--end" and i + 1 < len(sys.argv):
            cfg["date_end"] = sys.argv[i + 1]
        elif arg == "--capital" and i + 1 < len(sys.argv):
            cfg["capital"] = float(sys.argv[i + 1])
        elif arg == "--commission" and i + 1 < len(sys.argv):
            cfg["commission_pct"] = float(sys.argv[i + 1])

    print(f"\n  {cfg['date_start']} -> {cfg['date_end']} | "
          f"Capital: {cfg['capital']:,.0f}EUR | Com: {cfg['commission_pct']}bps")
    filt_status = " ".join([
        f"HTF={'ON' if cfg['use_htf_filter'] else 'OFF'}",
        f"VRet={'ON' if cfg['use_vol_retrace'] else 'OFF'}",
        f"Trend={'ON' if cfg['use_trend_filter'] else 'OFF'}",
        f"VOB={'ON' if cfg['use_vol_ob'] else 'OFF'}",
        f"VBOS={'ON' if cfg['use_vol_bos'] else 'OFF'}",
    ])
    print(f"  Filtros: {filt_status}")

    # --- Cargar tickers: desde archivo o universo fijo ---
    from_file = None
    use_all = False
    for i, arg in enumerate(sys.argv):
        if arg == "--from" and i + 1 < len(sys.argv):
            from_file = sys.argv[i + 1]
        elif arg == "--all":
            use_all = True

    if from_file:
        tickers = load_tickers_from_csv(from_file, q5_only=not use_all)
        if tickers is None:
            return
        print(f"  Modo: {'Q5' if not use_all else 'TODOS'} desde {from_file}\n")
    else:
        # Universo fijo (88 tickers)
        tickers = []
        seen = set()
        for tks in UNIVERSE.values():
            for t in tks:
                if t not in seen:
                    tickers.append(t)
                    seen.add(t)
        print(f"  Modo: Universo fijo ({len(tickers)} tickers)\n")

    results, all_trades = [], []
    t0 = time.time()

    for i, ticker in enumerate(tickers):
        result = run_whale_backtest(ticker, cfg, verbose=False)
        if result is not None:
            results.append(result)
            all_trades.extend(result["trades_list"])
            s = ("OK" if result["profit_factor"] >= 1.0
                 else "!!" if result["trades"] > 0 else "--")
            print(f"  [{i+1:2d}/{len(tickers)}] {ticker:6s}: "
                  f"{result['trades']:3d} trades | WR {result['win_rate']:4.1f}% | "
                  f"PF {result['profit_factor']:.2f} | "
                  f"Net {result['net_pnl']:+.0f}EUR | DD {result['max_dd_pct']:.1f}%  {s}")
        else:
            print(f"  [{i+1:2d}/{len(tickers)}] {ticker:6s}: sin datos")

    elapsed = time.time() - t0

    if not results:
        print("\n  No results.")
        return

    rdf = pd.DataFrame(results)
    rdf = rdf.sort_values("profit_factor", ascending=False)

    print("\n" + "=" * 80)
    print(f"  [RESULTS] {cfg['date_start']} -> {cfg['date_end']} | "
          f"{elapsed:.0f}s | {len(all_trades)} total trades")
    print("=" * 80 + "\n")

    disp = rdf[["ticker", "trades", "win_rate", "profit_factor",
                "net_pnl", "return_pct", "max_dd_pct"]].copy()
    disp.columns = ["Ticker", "Tr", "WR%", "PF", "Net EUR", "Ret%", "MaxDD%"]
    print(disp.to_string(index=False))

    print("\n" + "-" * 80)
    # Solo mostrar categorias si usamos universo fijo
    if not from_file:
        for cat, tks in UNIVERSE.items():
            cr = rdf[rdf["ticker"].isin(tks)]
            if len(cr) == 0: continue
            tot = cr["trades"].sum()
            apf = cr["profit_factor"].mean()
            awr = cr["win_rate"].mean()
            anet = cr["net_pnl"].sum()
            profit = (cr["profit_factor"] >= 1.0).sum()
            active = (cr["trades"] > 0).sum()
            print(f"  {cat:8s}: {active}/{len(cr)} con trades | {tot:3d} trades | "
                  f"WR {awr:.1f}% | PF {apf:.2f} | Net {anet:+.0f}EUR | {profit} rentables")

    print("\n" + "-" * 80 + "\n  [TOP 5] Profit Factor")
    for _, row in rdf[rdf["trades"] > 0].head(5).iterrows():
        print(f"  {row['ticker']:6s}: {int(row['trades']):3d} trades | "
              f"WR {row['win_rate']:.1f}% | PF {row['profit_factor']:.2f} | "
              f"Net {row['net_pnl']:+.0f}EUR | DD {row['max_dd_pct']:.1f}%")

    out_dir = os.path.dirname(os.path.abspath(__file__)) if "__file__" in dir() else "."
    rcsv = os.path.join(out_dir, "whale_backtest_results.csv")
    tcsv = os.path.join(out_dir, "whale_backtest_trades.csv")
    rdf.to_csv(rcsv, index=False, float_format="%.2f")
    print(f"\n  [FILE] Results: {rcsv}")
    if all_trades:
        pd.DataFrame(all_trades).sort_values(["ticker", "entry_date"]).to_csv(
            tcsv, index=False, float_format="%.2f")
        print(f"  [FILE] Trades:  {tcsv}")
    print("\n  [DONE]\n")


if __name__ == "__main__":
    main()
