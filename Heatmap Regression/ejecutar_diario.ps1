# ejecutar_diario.ps1
# Olympus Pipeline - Ejecucion Diaria
# Click derecho → "Ejecutar con PowerShell"
$env:FRED_API_KEY = "91da635eb0dc54c0d1728b90e9f89254"
$env:NEWSAPI_KEY = "0a1b34a6156c4cf9bea73313527e00a0"

$ErrorActionPreference = "Continue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  🚀 OLYMPUS PIPELINE - Ejecucion Diaria" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

cd $dir

Write-Host "[PASO 1/3] Modelo cuantitativo (tarda ~3-5 min)..." -ForegroundColor Yellow
Write-Host ""
python -X utf8 OLYMPUS_HEATMAP_REGRESSION_v7.py --mode swing --capital 700
Write-Host ""

Write-Host "[PASO 2/3] Screener Pine (tarda ~2-3 min)..." -ForegroundColor Yellow
Write-Host ""
python -X utf8 olympus_screener.py
Write-Host ""

Write-Host "[PASO 3/3] Dashboard..." -ForegroundColor Yellow
Write-Host ""
python -X utf8 generar_dashboard.py --capital 700 --open
Write-Host ""

Write-Host "============================================" -ForegroundColor Green
Write-Host "  ✅ Pipeline completado" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

Read-Host "Presiona Enter para salir"
