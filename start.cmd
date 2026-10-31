@echo off
rem AIdeation starten (Windows). Doppelklick genügt; "start.cmd --setup" öffnet den Einrichtungs-Assistenten erneut.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 pause
