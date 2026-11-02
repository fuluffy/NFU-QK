@echo off
rem ---------------------------------------------------------------------------
rem  NFU-QK launcher.  Keep this file pure ASCII.
rem  Mixing Chinese text with `chcp 65001` in a .cmd file breaks cmd's line
rem  parser on some Windows builds (it mis-slices multibyte characters).
rem  All Chinese guidance is printed by Node instead.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"
title NFU-QK

where node >nul 2>nul
if errorlevel 1 goto nonode

node src/cli.js ui %*

echo.
echo   Stopped.  Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo.
echo   [!] Node.js is required but was not found on this computer.
echo.
echo   1. Open  https://nodejs.org/
echo   2. Download the "LTS" version and install it (click Next all the way)
echo   3. Close this window, then double-click this file again
echo.
pause
exit /b 1
