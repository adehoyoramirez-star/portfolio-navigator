#!/bin/bash
export FRED_API_KEY="91da635eb0dc54c0d1728b90e9f89254"
export NEWSAPI_KEY="0a1b34a6156c4cf9bea73313527e00a0"
# ejecutar_diario.sh - Olympus Pipeline (Git Bash)

cd "$(dirname "$0")"

echo "============================================"
echo "  🚀 OLYMPUS PIPELINE - Ejecucion Diaria"
echo "============================================"
echo ""

echo "[PASO 1/3] Modelo cuantitativo (tarda ~3-5 min)..."
echo ""
python -X utf8 OLYMPUS_HEATMAP_REGRESSION_v7.py --mode swing --capital 700 
echo ""

echo "[PASO 2/3] Screener Pine (tarda ~2-3 min)..."
echo ""
python -X utf8 olympus_screener.py
echo ""

echo "[PASO 3/3] Dashboard..."
echo ""
python -X utf8 generar_dashboard.py --capital 700  --open
echo ""

echo "============================================"
echo "  ✅ Pipeline completado"
echo "============================================"
echo ""
read -p "Presiona Enter para salir..."
