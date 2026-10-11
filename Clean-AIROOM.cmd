@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请使用配置好项目开发环境的终端运行。
  pause
  exit /b 1
)
pushd "%~dp0"
node "%~dp0scripts\cleanup-project.mjs" %*
set "cleanupExit=%errorlevel%"
popd
if "%~1"=="" (
  echo.
  echo 默认只预览。如需实际清理，在项目终端运行：Clean-AIROOM.cmd --apply
  pause
)
exit /b %cleanupExit%
