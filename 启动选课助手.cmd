@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 南林选课助手

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没有找到 Node.js
  echo.
  echo   这个工具需要 Node.js 才能运行，请先安装：
  echo   https://nodejs.org/   ^(选 LTS 版本，一路下一步即可^)
  echo.
  echo   装完关掉这个窗口，重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动选课助手，稍等几秒…
echo   浏览器会自动打开；如果没有，请看下面打印的地址。
echo.

node src/cli.js ui

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
