@echo off
setlocal enabledelayedexpansion
set "SCRIPT_DIR=C:\Users\marti\Desktop\PAPA\portfolio-navigator\Heatmap Regression"
cd /d "%SCRIPT_DIR%"
title OLYMPUS XTB - Daily Run

echo.
echo ========================================
echo   OLYMPUS XTB EDITION - Daily Execution
echo   Model v5.0 + Screener v2.3
echo ========================================
echo.

echo [1/3] Limpiando cache antigua...
if exist ".screener_cache.pkl" del ".screener_cache.pkl" >nul 2>&1
if exist "heatmap_cache.pkl" del "heatmap_cache.pkl" >nul 2>&1
echo    OK Cache limpia
echo.

echo [2/3] Ejecutando modelo cuantitativo (N_FOLDS=5, modo swing)...
echo    Esto tarda ~5-10 minutos
echo.
python -X utf8 OLYMPUS_HEATMAP_REGRESSION_v5.py --mode swing
if errorlevel 1 (
    echo.
    echo   ERROR: El modelo fallo. Revisa la consola.
    pause
    exit /b 1
)
echo    OK Modelo completado
echo.

echo [3/3] Ejecutando screener de senales...
python -X utf8 olympus_screener.py
if errorlevel 1 (
    echo.
    echo   ERROR: El screener fallo. Revisa la consola.
    pause
    exit /b 1
)
echo    OK Screener completado
echo.

echo OK Todo listo. Abriendo dashboard...
start "" "oportunidades.html"
echo.
echo ========================================
echo   Proceso completado con exito.
echo   Si hay senales, aparecen en el dashboard.
echo   Si no hay senales, 100%% en IBCZ/IS3Q.
echo ========================================
echo.

timeout /t 5 /nobreak >nul
