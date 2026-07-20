@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未找到 Node.js，无法运行停止脚本。
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

"%NODE_EXE%" scripts\stop_dmr.js
if errorlevel 1 (
  echo.
  echo 停止失败，请查看上方错误信息。
  pause
  exit /b 1
)

timeout /t 2 /nobreak >nul
endlocal
