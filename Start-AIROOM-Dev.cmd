@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 26 and try again.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Development dependencies are missing. Run npm ci in this folder first.
  pause
  exit /b 1
)
echo Building and starting the AIROOM development version...
node scripts\dev.mjs
if errorlevel 1 (
  echo AIROOM could not start. See the error above.
  pause
  exit /b 1
)
