@echo off
cd /d "%~dp0"
if /I "%~1"=="--no-browser" goto start_server
start "RH Local Renders" http://127.0.0.1:5500/
:start_server
node server.cjs
