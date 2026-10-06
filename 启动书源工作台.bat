@echo off
chcp 65001 >nul
title 书源工作台
cd /d "%~dp0"
echo ============================================
echo   书源工作台 - Legado 书源管理与自动生成
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在启动本地服务，浏览器会自动打开...
echo 关闭本窗口即可退出程序。
echo.
node "app\src\server\index.js" %*
if errorlevel 1 (
  echo.
  echo 服务异常退出，请把上面的错误信息反馈。
  pause
)
