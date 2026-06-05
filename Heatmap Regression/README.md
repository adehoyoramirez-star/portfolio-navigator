# OLYMPUS Heatmap Regression v5.0

Motor cuantitativo cross-sectional para prediccion de retornos relativos entre activos del S&P 500 + ETFs.

## Arquitectura

v5.py (motor principal)
  +-- yfinance -> precios y volumen (504 dias)
  +-- FRED API -> 8 factores macro (requiere API key)
  +-- FINRA API -> short volume ratio por ticker
  +-- SEC EDGAR API -> insider trading signal
  +-- VADER + NewsAPI -> news sentiment
  +-- LightGBM -> 3-fold walk-forward regression

## Requisitos

pip install yfinance pandas numpy scikit-learn lightgbm scipy requests beautifulsoup4 lxml
pip install vaderSentiment

## Ejecucion

FRED_API_KEY=tu_clave python -X utf8 OLYMPUS_HEATMAP_REGRESSION_v5.py

## Outputs

- heatmap_dashboard.html: Dashboard interactivo
- predictions.csv: Scores 0-100 y quintiles
- correlations.csv: Matriz de correlaciones LW
- portfolio_q5.csv: Pesos HRP del portfolio Q5

## Modulos de Datos

| Modulo | Fuente | Costo |
|--------|--------|-------|
| fred_data.py | FRED | /usr/bin/bash |
| finra_data.py | FINRA API | /usr/bin/bash |
| insider_data.py | SEC data.sec.gov | /usr/bin/bash |
| sentiment_data.py | VADER + NewsAPI | /usr/bin/bash |

## Notas

- IC ~ 0 esperado: sin senal cross-sectional significativa en 2026
- FINRA API devuelve solo el ultimo dia
- INSIDER usa API oficial SEC con rate limiting 10 req/s
