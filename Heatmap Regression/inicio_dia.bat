@echo off
setlocal
cd /d "%~dp0"
call olympus_config.bat

echo ============================================================
echo   OLYMPUS - INICIO DEL DIA
echo   Capital: %CAPITAL_EUR% EUR
echo ============================================================
echo.

echo [1/3] Generando predicciones del modelo (factor lab v9.2)...
echo ------------------------------------------------------------
python OLYMPUS_HEATMAP_REGRESSION_v9_2.py --capital %CAPITAL_EUR%
if errorlevel 1 goto error

echo.
echo [2/3] Archivando snapshot de hoy (para verificar en 5 dias)...
echo ------------------------------------------------------------
python archive_snapshot.py
if errorlevel 1 goto error

echo.
echo [3/3] Generando informe de senales (operativa manual)...
echo ------------------------------------------------------------
python senal_diaria.py --capital %CAPITAL_EUR%
if errorlevel 1 goto error

echo.
echo ============================================================
echo   LISTO. Abriendo informes...
echo ============================================================
start "" "heatmap_dashboard.html"
start "" "senal_diaria.html"

echo.
echo Recuerda: las ordenes son MANUALES. Revisa senal_diaria.html,
echo introduce ENTRY / SL / TP exactamente como se indica.
echo.
pause
exit /b 0

:error
echo.
echo ============================================================
echo   ERROR: algo fallo arriba. No se genero el informe completo.
echo   Revisa el mensaje de error antes de operar con estas senales.
echo ============================================================
pause
exit /b 1
