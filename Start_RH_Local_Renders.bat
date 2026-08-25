@echo off
cd /d "%~dp0"
if /I "%~1"=="--no-browser" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\start-local-service.ps1"
  exit /b %errorlevel%
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Launch_RH_Local_Renders.ps1"
