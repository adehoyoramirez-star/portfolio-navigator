@echo off
REM ============================================================
REM   OLYMPUS - Configuracion compartida
REM   Edita estos valores segun tu cuenta y entorno.
REM   Lo llaman inicio_dia.bat y cierre_dia.bat automaticamente.
REM ============================================================

REM Capital total en EUR para el sizing de las senales de hoy
set CAPITAL_EUR=700

REM Dias de trading hacia atras que verifica prediction_check_5d.py
REM (debe coincidir con HORIZON del modelo, default 5)
set CHECK_DAYS=5

REM Fuerza a Python/consola a usar UTF-8 - evita UnicodeEncodeError
REM con los emojis/acentos que imprimen los scripts en Windows
set PYTHONIOENCODING=utf-8
chcp 65001 >nul
