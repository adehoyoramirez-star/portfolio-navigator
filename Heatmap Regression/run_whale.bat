@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ================================================================
echo   OLYMPUS WHALE DETECTOR - Ejecucion Diaria
echo ================================================================
echo.

echo [1/2] Ejecutando Factor Lab (Olympus v9.2)...
python OLYMPUS_HEATMAP_REGRESSION_v9_2.py
if %errorlevel% neq 0 (
    echo ERROR: El Factor Lab fallo. Revisa el log.
    pause
    exit /b 1
)
echo   OK - predictions.csv generado
echo.

echo [2/2] Backtest Whale sobre Q5 del Factor Lab...
python whale_backtest.py --from predictions.csv
echo.
echo   Resultados guardados en:
echo     whale_backtest_results.csv
echo     whale_backtest_trades.csv
echo.

echo ================================================================
echo   EJECUCION COMPLETADA
echo ================================================================
echo.
echo Abriendo resultados...
start whale_backtest_results.csv
echo.
pause
