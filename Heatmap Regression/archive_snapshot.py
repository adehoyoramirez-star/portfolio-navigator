#!/usr/bin/env python3
"""ARCHIVE_SNAPSHOT v1.0 — Olympus

Guarda una copia fechada de predictions.csv / ibkr_orders.csv / portfolio_q5.csv
en history/YYYY-MM-DD/ para que prediction_check_5d.py pueda comparar las
predicciones de hace N dias contra los precios reales de hoy.

Se ejecuta automaticamente desde inicio_dia.bat, justo despues de generar
las predicciones del dia.

Uso: python archive_snapshot.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
HISTORY_DIR = os.path.join(BASE, 'history')

# Archivos a archivar (los que existan; los que falten se omiten sin error)
FILES_TO_ARCHIVE = [
    'predictions.csv',
    'ibkr_orders.csv',
    'portfolio_q5.csv',
    'factor_ic_report.csv',
]


def main():
    today = datetime.now().strftime('%Y-%m-%d')
    dest = os.path.join(HISTORY_DIR, today)
    os.makedirs(dest, exist_ok=True)

    n_ok = 0
    for fname in FILES_TO_ARCHIVE:
        src = os.path.join(BASE, fname)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dest, fname))
            print(f'  [OK] {fname}')
            n_ok += 1
        else:
            print(f'  [omitido] {fname} (no existe)')

    if n_ok == 0:
        print('AVISO: no se archivo ningun fichero. Ejecuta primero '
              'OLYMPUS_HEATMAP_REGRESSION_v9_2.py')
        sys.exit(1)

    print(f'Snapshot guardado en history/{today}/ ({n_ok} ficheros)')


if __name__ == '__main__':
    main()
