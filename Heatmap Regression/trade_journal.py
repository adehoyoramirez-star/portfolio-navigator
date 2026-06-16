#!/usr/bin/env python3
"""TRADE JOURNAL v1.0 - Hende Fund - Nivel 1: Ciclo de Aprendizaje"""

import argparse, os, sys, pickle
from datetime import datetime
import pandas as pd
import numpy as np

BASE = os.path.dirname(os.path.abspath(__file__))
JOURNAL_FILE = os.path.join(BASE, 'trade_journal.csv')
ORDERS_FILE  = os.path.join(BASE, 'ibkr_orders.csv')
CACHE_FILE   = os.path.join(BASE, 'heatmap_cache.pkl')

COLUMNS = [
    'entry_date', 'ticker', 'sector', 'action', 'entry_price',
    'stop_loss', 'take_profit', 'rr_ratio',
    'shares', 'size_eur', 'risk_eur',
    'score', 'confidence', 'z_score',
    'exit_date', 'exit_price', 'exit_reason',
    'pnl_eur', 'pnl_pct', 'r_multiple', 'status'
]


def load_journal():
    """Carga el trade journal, lo crea vacio si no existe."""
    if os.path.exists(JOURNAL_FILE):
        df = pd.read_csv(JOURNAL_FILE)
        for col in COLUMNS:
            if col not in df.columns:
                df[col] = '' if col in ('exit_date', 'exit_reason') else 0.0
        return df
    else:
        return pd.DataFrame(columns=COLUMNS)


def save_journal(df):
    df.to_csv(JOURNAL_FILE, index=False)
    print(f'   [SAVED] Trade journal: {len(df)} trades')


def cmd_init():
    if not os.path.exists(ORDERS_FILE):
        print(f'[ERROR] No existe {ORDERS_FILE}. Ejecuta el modelo primero.')
        sys.exit(1)
    orders = pd.read_csv(ORDERS_FILE)
    buys = orders[(orders['action'] == 'BUY') & (orders['viable'] == True)].copy()
    if len(buys) == 0:
        print('[INFO] No hay ordenes BUY viables en ibkr_orders.csv')
        return
    journal = load_journal()
    added = 0
    for _, row in buys.iterrows():
        ticker = row['ticker']
        entry  = row['entry_price']
        existing = journal[(journal['ticker'] == ticker) &
                           (journal['entry_price'].round(4) == round(entry, 4)) &
                           (journal['status'] == 'OPEN')]
        if len(existing) > 0:
            continue
        new_trade = {
            'entry_date': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'ticker': ticker,
            'sector': row.get('sector', 'Other'),
            'action': 'BUY',
            'entry_price': round(entry, 4),
            'stop_loss': round(row['stop_loss'], 4),
            'take_profit': round(row['take_profit'], 4),
            'rr_ratio': row.get('rr_ratio', 2.0),
            'shares': round(row['shares'], 6),
            'size_eur': round(row['size_eur'], 2),
            'risk_eur': round(row['risk_eur'], 2),
            'score': row['score'],
            'confidence': row['confidence'],
            'z_score': row['z_score'],
            'exit_date': '', 'exit_price': 0.0, 'exit_reason': '',
            'pnl_eur': 0.0, 'pnl_pct': 0.0, 'r_multiple': 0.0,
            'status': 'OPEN',
        }
        journal = pd.concat([journal, pd.DataFrame([new_trade])], ignore_index=True)
        added += 1
    save_journal(journal)
    print(f'   [INIT] {added} trades nuevos anadidos')
    print(f'   Total: {len(journal)} trades ({len(journal[journal["status"]=="OPEN"])} abiertos)')


def show_summary(journal):
    closed = journal[journal['status'] == 'CLOSED'].copy()
    if len(closed) == 0:
        return
    closed['is_win'] = closed['pnl_eur'] > 0
    total = len(closed)
    wins  = int(closed['is_win'].sum())
    losses = total - wins
    wr = wins / total * 100 if total > 0 else 0
    total_pnl = closed['pnl_eur'].sum()
    avg_win   = closed[closed['is_win']]['pnl_eur'].mean() if wins > 0 else 0
    avg_loss  = closed[~closed['is_win']]['pnl_eur'].mean() if losses > 0 else 0
    win_sum   = closed[closed['is_win']]['pnl_eur'].sum()
    loss_sum  = abs(closed[~closed['is_win']]['pnl_eur'].sum()) if losses > 0 else 0.01
    pf = win_sum / loss_sum
    avg_r = closed['r_multiple'].mean()
    print(f'\n{"="*60}')
    print(f'  TRADE JOURNAL - Performance Acumulada')
    print(f'{"="*60}')
    print(f'  Trades cerrados:  {total}')
    print(f'  Win Rate:         {wr:.1f}% ({wins}W / {losses}L)')
    print(f'  Profit Factor:    {pf:.2f}')
    print(f'  P&L Total:        EUR {total_pnl:+.2f}')
    print(f'  Avg Win:          EUR {avg_win:+.2f}')
    print(f'  Avg Loss:         EUR {avg_loss:+.2f}')
    print(f'  Avg R (realized): {avg_r:+.3f}R')
    print(f'\n  {"-"*60}')
    print(f'  Performance por Confianza')
    print(f'  {"-"*60}')
    print(f'  {"Confianza":<10} {"Trades":>8} {"Win Rate":>10} {"P&L Total":>12} {"Avg R":>8} {"Pf Factor":>10}')
    print(f'  {"-"*60}')
    for conf in ['HIGH', 'MED', 'LOW']:
        sub = closed[closed['confidence'] == conf]
        if len(sub) == 0:
            continue
        n = len(sub)
        w = int(sub['is_win'].sum())
        wr_c = w / n * 100
        pnl_c = sub['pnl_eur'].sum()
        ar_c = sub['r_multiple'].mean()
        wp = sub[sub['is_win']]['pnl_eur'].sum()
        lp = abs(sub[~sub['is_win']]['pnl_eur'].sum()) if (n - w) > 0 else 0.01
        pf_c = wp / lp
        star = 'STAR' if wr_c >= 65 and pf_c >= 2.0 else 'GOOD' if wr_c >= 55 else 'WARN' if wr_c >= 45 else 'BAD'
        print(f'  [{star}] {conf:<5} {n:>8} {wr_c:>9.1f}% EUR{pnl_c:>+11.2f} {ar_c:>+8.3f}R {pf_c:>10.2f}')
    open_n = len(journal[journal['status'] == 'OPEN'])
    if open_n > 0:
        print(f'\n  {open_n} trades abiertos - usa --update para P&L no realizado')
    print(f'{"="*60}\n')


def cmd_close(args):
    journal = load_journal()
    ticker = args.ticker.upper()
    open_trades = journal[(journal['ticker'] == ticker) &
                          (journal['status'] == 'OPEN')]
    if len(open_trades) == 0:
        print(f'[ERROR] No hay trades abiertos para {ticker}')
        avail = journal[journal['status'] == 'OPEN']['ticker'].unique()
        if len(avail) > 0:
            print(f'   Abiertos: {", ".join(avail)}')
        sys.exit(1)
    idx = open_trades.index[-1]
    row = journal.loc[idx]
    entry  = row['entry_price']
    sl     = row['stop_loss']
    tp     = row['take_profit']
    shares = row['shares']
    conf   = row['confidence']
    exit_p = args.exit
    reason = args.reason if args.reason else 'Manual'
    pnl_eur = (exit_p - entry) * shares
    pnl_pct = (exit_p - entry) / entry * 100 if entry > 0 else 0
    initial_risk = entry - sl
    r_mult = (exit_p - entry) / initial_risk if initial_risk > 0 else (exit_p - entry) / entry * 10
    auto = ''
    if exit_p <= sl * 1.005 and not args.reason:
        reason = 'SL hit'
        auto = ' [SL]'
    elif exit_p >= tp * 0.995 and not args.reason:
        reason = 'TP hit'
        auto = ' [TP]'
    journal.at[idx, 'exit_date']   = datetime.now().strftime('%Y-%m-%d %H:%M')
    journal.at[idx, 'exit_price']  = round(exit_p, 4)
    journal.at[idx, 'exit_reason'] = reason
    journal.at[idx, 'pnl_eur']     = round(pnl_eur, 2)
    journal.at[idx, 'pnl_pct']     = round(pnl_pct, 2)
    journal.at[idx, 'r_multiple']  = round(r_mult, 3)
    journal.at[idx, 'status']      = 'CLOSED'
    save_journal(journal)
    emoji = 'WIN' if pnl_eur >= 0 else 'LOSS'
    print(f'\n[{emoji}] Trade {ticker} CERRADO')
    print(f'   Entry: ${entry:.2f} -> Exit: ${exit_p:.2f}')
    print(f'   SL: ${sl:.2f} | TP: ${tp:.2f}')
    print(f'   P&L: EUR {pnl_eur:+.2f} ({pnl_pct:+.2f}%)')
    print(f'   R-multiplo: {r_mult:+.3f}R{auto}')
    print(f'   Confianza: {conf} | Razon: {reason}')
    show_summary(journal)


def cmd_update():
    journal = load_journal()
    open_trades = journal[journal['status'] == 'OPEN']
    if len(open_trades) == 0:
        print('[INFO] No hay trades abiertos')
        return
    closes = None
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'rb') as f:
                cache = pickle.load(f)
                closes = cache.get('closes') if isinstance(cache, dict) else cache['closes']
        except Exception:
            pass
    if closes is None:
        print('[WARN] No se pudo cargar cache de precios')
        return
    last_date = closes.index[-1].strftime('%d/%m/%Y')
    print(f'\n  POSICIONES ABIERTAS - P&L no realizado (precios al {last_date})\n')
    print(f'  {"Ticker":<8} {"Entry":>10} {"Actual":>10} {"SL":>10} {"TP":>10} {"P&L %":>8} {"R":>6} {"Conf":<6}')
    print(f'  {"-"*80}')
    total = 0
    for _, row in open_trades.iterrows():
        t = row['ticker']
        entry = row['entry_price']
        sl = row['stop_loss']
        tp = row['take_profit']
        if t not in closes.columns:
            continue
        cur = closes[t].iloc[-1]
        pnl_pct = (cur - entry) / entry * 100
        init_r = entry - sl
        r_unr = (cur - entry) / init_r if init_r > 0 else 0
        total += (cur - entry) * row['shares']
        near_sl = '!!SL' if cur <= sl * 1.02 else ''
        near_tp = '!!TP' if cur >= tp * 0.98 else ''
        flag = near_sl or near_tp or '  '
        emoji = '+' if pnl_pct >= 0 else '-'
        print(f'  {t:<8} {entry:>10.2f} {cur:>10.2f} {sl:>10.2f} {tp:>10.2f} '
              f'[{emoji}]{pnl_pct:>+7.2f}% {r_unr:>+6.2f}R {row["confidence"]:<6} {flag}')
    print(f'  {"-"*80}')
    print(f'  P&L no realizado total: EUR {total:+.2f}\n')


def cmd_stats():
    journal = load_journal()
    closed = journal[journal['status'] == 'CLOSED'].copy()
    if len(closed) == 0:
        print('[INFO] No hay trades cerrados todavia.')
        print('  python trade_journal.py --close TICKER --exit PRECIO --reason "TP hit"')
        return
    closed['is_win'] = closed['pnl_eur'] > 0
    print(f'\n{"="*70}')
    print(f'  ESTADISTICAS POR CONFIANZA - Analisis de Calidad de Senal')
    print(f'{"="*70}\n')
    conf_stats = []
    for conf in ['HIGH', 'MED', 'LOW']:
        sub = closed[closed['confidence'] == conf]
        if len(sub) == 0:
            print(f'  {conf}: Sin trades cerrados\n')
            continue
        n = len(sub)
        w = int(sub['is_win'].sum())
        l = n - w
        wr = w / n * 100
        pnl_t = sub['pnl_eur'].sum()
        avg_w = sub[sub['is_win']]['pnl_eur'].mean() if w > 0 else 0
        avg_l = sub[~sub['is_win']]['pnl_eur'].mean() if l > 0 else 0
        wp = sub[sub['is_win']]['pnl_eur'].sum()
        lp = abs(sub[~sub['is_win']]['pnl_eur'].sum()) if l > 0 else 0.01
        pf = wp / lp
        avg_r = sub['r_multiple'].mean()
        max_r = sub['r_multiple'].max()
        min_r = sub['r_multiple'].min()
        other = closed[closed['confidence'] != conf]
        other_avg_r = other['r_multiple'].mean() if len(other) > 0 else 0
        edge = avg_r - other_avg_r
        conf_stats.append({'conf': conf, 'n': n, 'wr': wr, 'avg_r': avg_r, 'pf': pf})
        print(f'  {"-"*66}')
        print(f'  CONFIANZA: {conf}')
        print(f'  {"-"*66}')
        print(f'  Trades:           {n} ({w}W / {l}L)')
        print(f'  Win Rate:         {wr:.1f}%')
        print(f'  Profit Factor:    {pf:.2f}')
        print(f'  P&L Total:        EUR {pnl_t:+.2f}')
        print(f'  Avg Win:          EUR {avg_w:+.2f}')
        print(f'  Avg Loss:         EUR {avg_l:+.2f}')
        print(f'  Avg R-multiplo:   {avg_r:+.3f}R')
        print(f'  Max R:            {max_r:+.3f}R')
        print(f'  Min R:            {min_r:+.3f}R')
        print(f'  Edge vs otras:    {edge:+.3f}R ', end='')
        if edge > 0.3:
            print('[OK] Confianza DISCRIMINA')
        elif edge > 0:
            print('[WARN] Diferenciacion debil')
        else:
            print('[BAD] Confianza NO discrimina - revisar z-score thresholds')
        print()
        print(f'  Trades individuales:')
        for _, t in sub.iterrows():
            emoji = '+' if t['pnl_eur'] > 0 else '-'
            print(f'    [{emoji}] {t["ticker"]:<6}  Entry=${t["entry_price"]:.2f}  '
                  f'Exit=${t["exit_price"]:.2f}  P&L=EUR{t["pnl_eur"]:+.2f}  '
                  f'R={t["r_multiple"]:+.2f}R  [{t["exit_reason"]}]')
        print()
    if len(conf_stats) >= 2:
        print(f'  {"-"*66}')
        print(f'  ANALISIS DE CALIBRACION')
        print(f'  {"-"*66}')
        wr_vals = [cs['wr'] for cs in conf_stats]
        r_vals  = [cs['avg_r'] for cs in conf_stats]
        mono_wr = all(wr_vals[i] >= wr_vals[i+1] for i in range(len(wr_vals)-1))
        mono_r  = all(r_vals[i] >= r_vals[i+1] for i in range(len(r_vals)-1))
        if mono_wr and mono_r:
            print(f'  [OK] CALIBRACION PERFECTA: Win Rate y Avg R decrecen con confianza')
            print(f'       El modelo SABE cuando tiene edge.')
        elif mono_wr:
            print(f'  [WARN] CALIBRACION PARCIAL: Win Rate monotono pero Avg R no')
        elif mono_r:
            print(f'  [WARN] CALIBRACION PARCIAL: Avg R monotono pero Win Rate no')
        else:
            print(f'  [BAD] MALA CALIBRACION: Ni Win Rate ni Avg R son monotonos')
            print(f'        Los thresholds de z-score necesitan ajuste.')
    print(f'{"="*70}\n')


def cmd_history():
    journal = load_journal()
    closed = journal[journal['status'] == 'CLOSED']
    if len(closed) == 0:
        print('[INFO] No hay trades cerrados.')
        return
    print(f'\n  Historial de Trades Cerrados ({len(closed)})\n')
    print(f'  {"Fecha":<18} {"Ticker":<8} {"Entry":>9} {"Exit":>9} {"P&L EUR":>9} {"R":>6} {"Conf":<6} {"Razon"}')
    print(f'  {"-"*95}')
    for _, t in closed.sort_values('exit_date').iterrows():
        emoji = '+' if t['pnl_eur'] > 0 else '-'
        print(f'  {str(t["exit_date"]):<18} {t["ticker"]:<8} '
              f'${t["entry_price"]:>8.2f} ${t["exit_price"]:>8.2f} '
              f'[{emoji}]EUR{t["pnl_eur"]:>+8.2f} {t["r_multiple"]:>+6.2f}R '
              f'{t["confidence"]:<6} {t["exit_reason"]}')
    print()


def cmd_default():
    journal = load_journal()
    open_trades = journal[journal['status'] == 'OPEN']
    print(f'\n{"="*60}')
    print(f'  TRADE JOURNAL - Hende Fund v1.0')
    print(f'{"="*60}')
    if len(open_trades) > 0:
        print(f'\n  POSICIONES ABIERTAS ({len(open_trades)})\n')
        print(f'  {"Ticker":<8} {"Entry":>10} {"SL":>10} {"TP":>10} {"Size EUR":>9} {"Score":>6} {"Conf":<6} {"z":>5} {"Sector":<10}')
        print(f'  {"-"*85}')
        for _, row in open_trades.iterrows():
            print(f'  {row["ticker"]:<8} {row["entry_price"]:>10.2f} {row["stop_loss"]:>10.2f} '
                  f'{row["take_profit"]:>10.2f} EUR{row["size_eur"]:>8.2f} '
                  f'{row["score"]:>6.0f} {row["confidence"]:<6} {row["z_score"]:>5.1f} {row["sector"]:<10}')
        print(f'\n  Usa --update para ver P&L no realizado')
        print(f'  Usa --close TICKER --exit PRECIO --reason "TP hit" para cerrar')
    else:
        print(f'\n  Sin posiciones abiertas')
        print(f'  Usa --init para anadir ordenes de ibkr_orders.csv')
    show_summary(journal)


def main():
    parser = argparse.ArgumentParser(description='TRADE JOURNAL v1.0')
    parser.add_argument('--init', action='store_true', help='Inicializar desde ibkr_orders.csv')
    parser.add_argument('--close', type=str, metavar='TICKER', help='Cerrar trade')
    parser.add_argument('--exit', type=float, help='Precio de salida (con --close)')
    parser.add_argument('--reason', type=str, default='', help='Razon: TP hit, SL hit, Manual')
    parser.add_argument('--stats', action='store_true', help='Estadisticas por confianza')
    parser.add_argument('--update', action='store_true', help='P&L no realizado')
    parser.add_argument('--history', action='store_true', help='Historial completo')
    args = parser.parse_args()
    if args.init:
        cmd_init()
    elif args.close:
        if not args.exit:
            print('[ERROR] --exit PRECIO es obligatorio con --close')
            sys.exit(1)
        cmd_close(args)
    elif args.stats:
        cmd_stats()
    elif args.update:
        cmd_update()
    elif args.history:
        cmd_history()
    else:
        cmd_default()


if __name__ == '__main__':
    main()