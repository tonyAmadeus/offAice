@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
rem npm run deploy updates the desktop folder; the installer defaults to LOCALAPPDATA\Programs.
set "AIROOM_INSTALLED="
for %%D in ("%USERPROFILE%\Desktop\AIROOM" "%OneDrive%\Desktop\AIROOM" "%LOCALAPPDATA%\Programs\AIROOM" "%USERPROFILE%\AIROOM") do (
  if not defined AIROOM_INSTALLED if exist "%%~D\AIROOM.exe" set "AIROOM_INSTALLED=%%~D"
)
if not defined AIROOM_INSTALLED (
  if exist "%~dp0Start-AIROOM-Dev.cmd" (
    call "%~dp0Start-AIROOM-Dev.cmd"
    exit /b
  )
  echo AIROOM desktop installation was not found. Please install AIROOM first.
  pause
  exit /b 1
)
if not defined AIROOM_DATA_DIR set "AIROOM_DATA_DIR=%USERPROFILE%\.airoom\data"
set "TEMP=%AIROOM_INSTALLED%\launch-temp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
start "" /d "%AIROOM_INSTALLED%" "%AIROOM_INSTALLED%\AIROOM.exe"
exit /b 0
