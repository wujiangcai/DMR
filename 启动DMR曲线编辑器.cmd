@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 未找到 Node.js，请使用完整便携包，或安装 Node.js 18 及更高版本。
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

rem 由启动器先拉起本地服务并等待健康检查通过，再打开浏览器。
rem 这样可以避免浏览器打开过早，以及重复双击造成端口冲突。
"%NODE_EXE%" scripts\start_dmr.js
if errorlevel 1 (
  echo.
  echo DMR 曲线编辑器启动失败，详细日志位于 .runtime 目录。
  pause
  exit /b 1
)

endlocal
