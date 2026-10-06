@echo off
chcp 65001 >nul
title 书源工作台
setlocal
set "ROOT=%~dp0"
set "APPDIR=%ROOT%app"
set "ELECTRON=%APPDIR%\node_modules\electron\dist\electron.exe"

echo ============================================
echo   书源工作台 - Legado 书源管理与自动生成
echo ============================================
echo.

rem 清掉可能存在的“以 Node 方式运行 Electron”环境变量，否则窗口起不来
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_DISABLE_SECURITY_WARNINGS=1"

if not exist "%ELECTRON%" goto browser

echo [1/2] 启动桌面客户端窗口...
cd /d "%APPDIR%"
"%ELECTRON%" . %*
if errorlevel 1 (
  echo.
  echo [!] 桌面窗口启动失败，改用浏览器模式（功能完全一样）。
  echo.
  goto browser
)
goto end

:browser
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  goto end
)
echo [2/2] 以浏览器模式启动本地服务...
echo 浏览器会自动打开 http://127.0.0.1:8317/ ，关闭本窗口即退出。
echo.
cd /d "%ROOT%"
node "app\src\server\index.js" %*
if errorlevel 1 (
  echo.
  echo 服务异常退出，请把上面的错误信息反馈。
  pause
)

:end
endlocal
