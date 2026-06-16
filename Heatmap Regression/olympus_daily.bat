@echo off
setlocal enabledelayedexpansion
set "SCRIPT_DIR=C:\Users\marti\Desktop\PAPA\portfolio-navigator\Heatmap Regression"
cd /d "%SCRIPT_DIR%"
title OLYMPUS v7.0 - Daily Run

echo.
echo ========================================
echo   OLYMPUS v7.0 - Ejecucion Diaria
echo   Modelo v7.0 + Screener
echo ========================================
echo.

echo [1/4] Limpiando cache antigua...
if exist ".screener_cache.pkl" del ".screener_cache.pkl" >nul 2>&1
if exist "heatmap_cache.pkl" del "heatmap_cache.pkl" >nul 2>&1
echo    OK Cache limpia
echo.

echo [2/4] Ejecutando modelo cuantitativo v7 (modo swing, 700 EUR)...
echo    Esto tarda ~5-10 minutos
echo.
python -X utf8 OLYMPUS_HEATMAP_REGRESSION_v7.py --mode swing --capital 700
if errorlevel 1 (
    echo.
    echo   ERROR: El modelo v7 fallo. Revisa la consola.
    pause
    exit /b 1
)
echo    OK Modelo v7 completado
echo.

echo [3/4] Ejecutando screener de senales...
python -X utf8 olympus_screener.py
if errorlevel 1 (
    echo.
    echo   ERROR: El screener fallo. Revisa la consola.
    pause
    exit /b 1
)
echo    OK Screener completado
echo.

echo [4/4] Generando dashboard...
python -X utf8 generar_dashboard.py --capital 700 --open
echo    OK Dashboard abierto
echo.

echo ========================================
echo   Proceso completado con exito.
echo   Archivos generados:
echo     - heatmap_dashboard.html
echo     - predictions.csv
echo     - portfolio_q5.csv
echo     - ibkr_orders.csv
echo ========================================
echo.

timeout /t 5 /nobreak >nul
