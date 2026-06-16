#!/usr/bin/env python3
"""
CIERRE DE TRADE — Para uso manual

Uso: python cierre_trade.py --ticker AAPL --exit 155.50 --notas "SL hit"

Cierra un trade abierto en el paper tracker y registra P&L.
"""
import argparse, sys, os
from datetime import datetime
import pandas as pd

BASE = os.path.dirname(os.path.abspath(__file__))
TRACKER_FILE = os.path.join(BASE, 'paper_tracker.csv')

def main():
    parser = argparse.ArgumentParser(description='Cerrar un trade del paper tracker')
    parser.add_argument('--ticker', required=True, help='Ticker a cerrar')
    parser.add_argument('--exit', type=float, required=True, help='Precio de salida')
    parser.add_argument('--notas', default='Cerrado manualmente', help='Notas del cierre')
    args = parser.parse_args()
    
    if not os.path.exists(TRACKER_FILE):
        print(f'ERROR: No existe {TRACKER_FILE}')
        print('Ejecuta primero paper_trading.py para inicializar')
        sys.exit(1)
    
    df = pd.read_csv(TRACKER_FILE)
    open_trades = df[(df['ticker'] == args.ticker) & (df['status'] == 'OPEN')]
    
    if len(open_trades) == 0:
        print(f'No hay trades abiertos para {args.ticker}')
        # Show what's available
        available = df[df['status'] == 'OPEN']['ticker'].unique()
        if len(available) > 0:
            print(f'Abiertos: {list(available)}')
        sys.exit(1)
    
    # Cerrar el primer trade abierto encontrado
    idx = open_trades.index[0]
    entry = df.at[idx, 'entry']
    shares = df.at[idx, 'shares']
    pnl_eur = (args.exit - entry) * shares
    pnl_pct = (args.exit - entry) / entry * 100

    df.at[idx, 'exit_price'] = args.exit
    df.at[idx, 'exit_date'] = datetime.now().strftime('%Y-%m-%d %H:%M')
    df.at[idx, 'pnl_eur'] = round(pnl_eur, 2)
    df.at[idx, 'pnl_pct'] = round(pnl_pct, 2)
    df.at[idx, 'status'] = 'CLOSED'
    df.at[idx, 'notes'] = args.notas
    
    df.to_csv(TRACKER_FILE, index=False)
    
    emoji = '🟢' if pnl_eur >= 0 else '🔴'
    print(f'{emoji} Trade {args.ticker} CERRADO')
    print(f'   Entry: {entry:.2f} -> Exit: {args.exit:.2f}')
    print(f'   Shares: {shares:.4f}')
    print(f'   P&L: {pnl_eur:+.2f}EUR ({pnl_pct:+.2f}%)')
    print(f'   Notas: {args.notas}')
    print(f'\nActualiza el reporte: python paper_trading.py')

if __name__ == '__main__':
    main()
