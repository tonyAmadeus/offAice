@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
set "AIROOM_INSTALLED=%USERPROFILE%\AIROOM"
if not exist "%AIROOM_INSTALLED%\AIROOM.exe" (
  echo AIROOM desktop installation was not found. Please install AIROOM first.
  exit /b 1
)
if not defined AIROOM_DATA_DIR set "AIROOM_DATA_DIR=%USERPROFILE%\.airoom\data"
set "TEMP=%AIROOM_INSTALLED%\launch-temp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
start "" /d "%AIROOM_INSTALLED%" "%AIROOM_INSTALLED%\AIROOM.exe"
exit /b 0
