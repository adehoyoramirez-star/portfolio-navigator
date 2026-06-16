@echo off
setlocal
cd /d "%~dp0"
call olympus_config.bat

echo ============================================================
echo   OLYMPUS - CIERRE DEL DIA
echo   Verificando predicciones de hace %CHECK_DAYS% dias de trading
echo ============================================================
echo.

echo [1/1] Comparando predicciones vs precios reales...
echo ------------------------------------------------------------
python prediction_check_5d.py --days %CHECK_DAYS%
if errorlevel 1 goto error

echo.
echo ============================================================
echo   LISTO. Abriendo informe de precision...
echo ============================================================
start "" "prediction_check_5d.html"

echo.
echo Si el IC realizado lleva varios dias por debajo del IC predicho,
echo revisa el modelo antes de seguir operando con el mismo capital.
echo.
pause
exit /b 0

:error
echo.
echo ============================================================
echo   ERROR o sin historico suficiente todavia.
echo   Necesitas al menos %CHECK_DAYS% dias ejecutando inicio_dia.bat
echo   para que este informe tenga datos que comparar.
echo ============================================================
pause
exit /b 1
