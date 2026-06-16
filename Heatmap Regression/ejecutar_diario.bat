@echo off
setlocal enabledelayedexpansion
set "SCRIPT_DIR=C:\Users\marti\Desktop\PAPA\portfolio-navigator\Heatmap Regression"
cd /d "%SCRIPT_DIR%"

REM -- API Keys para datos alternativos --
set "FRED_API_KEY=91da635eb0dc54c0d1728b90e9f89254"
set "NEWSAPI_KEY=0a1b34a6156c4cf9bea73313527e00a0"

title OLYMPUS v7.0 - Daily Pipeline

echo.
echo ========================================
echo   OLYMPUS v7.0 - Ejecucion Diaria
echo ========================================
echo.

echo   FRED_API_KEY: %FRED_API_KEY:~0,8%...
echo   NEWSAPI_KEY:  %NEWSAPI_KEY:~0,8%...
echo.
echo [1/3] Modelo cuantitativo (tarda ~3-5 min)...
echo.
python -X utf8 OLYMPUS_HEATMAP_REGRESSION_v7.py --mode swing --capital 700 
echo.

echo [2/3] Screener Pine (tarda ~2-3 min)...
echo.
python -X utf8 olympus_screener.py
echo.

echo [3/3] Dashboard...
echo.
python -X utf8 generar_dashboard.py --capital 700  --open
echo.

echo ========================================
echo   Pipeline completado
echo ========================================
echo.
pause
