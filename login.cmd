@echo off
rem ============================================================
rem  NJFU Course Grabber - Login Launcher
rem
rem  IMPORTANT: keep this file pure ASCII.
rem  cmd.exe parses .cmd files using the system ANSI codepage (GBK on
rem  Chinese Windows), so UTF-8 Chinese text here gets mangled into
rem  bogus commands. All Chinese messages are printed by Node instead
rem  (Node uses the UTF-16 console API on Windows, so it renders fine).
rem ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found in PATH.
  echo         Install it from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

node src\cli.js login
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo [INFO] Exit code: %EXITCODE%
  echo [INFO] Copy the full output above and send it back for diagnosis.
)
echo [INFO] Press any key to close this window.
pause >nul
