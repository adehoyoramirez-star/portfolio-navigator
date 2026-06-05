#!/usr/bin/env python3
"""
Regenera public/tactical_universe_symbols.json desde src/core/tactical/tacticalUniverse.ts

Uso: python regenerate_tactical_symbols.py
Ejecutar cada vez que se añadan/eliminen activos del universo táctico.
"""
import re, json, os

CWD = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(CWD, ".."))
ts_path = os.path.join(PROJECT, "src", "core", "tactical", "tacticalUniverse.ts")

if not os.path.exists(ts_path):
    print(f"❌ No encontrado: {ts_path}")
    exit(1)

with open(ts_path, "r", encoding="utf-8") as f:
    content = f.read()

primary = re.findall(r"yahooSymbol\s*:\s*['\"]([^'\"]+)['\"]", content)
fallback = re.findall(r"fallbackYahooSymbol\s*:\s*['\"]([^'\"]+)['\"]", content)

all_s = list(set(primary + fallback))
all_s.sort()

# Filtrar solo los que NO están ya en SP500 o CURATED del modelo Python
# para no duplicar descargas
us_bench = {
    'SPY','QQQ','IWM','DIA','MDY','XLK','XLF','XLV','XLY','XLI','XLC','XLE','XLP','XLRE','XLB','XLU',
    'EEM','EFA','EWJ','FXI','EWZ','INDA','IEUR','VGK','GLD','SLV','USO','DBC',
    'TLT','AGG','LQD','HYG','BITO','THD','VNM','EPHE','IBIT','FBTC','^VIX',
}
new_syms = [s for s in all_s if s not in us_bench and not s.startswith('^')]

result = {
    "generatedAt": __import__('datetime').datetime.now().isoformat(),
    "totalSymbols": len(new_syms),
    "yahooSymbols": new_syms
}

out = os.path.join(PROJECT, "public", "tactical_universe_symbols.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)

print(f"✅ {len(new_syms)} simbolos tacticos guardados")
print(f"   Archivo: {out}")
