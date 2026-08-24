@echo off
cd /d "%~dp0"
start "RH Local Renders" http://127.0.0.1:5500/
node server.cjs
