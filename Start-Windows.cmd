@echo off
cd /d "%~dp0"
set "CODEX_LINK_OPEN_BROWSER=1"
node src/main.mjs
if errorlevel 1 pause
