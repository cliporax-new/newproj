@echo off
title Instagram Comments Automation - Setup
color 0B
echo.
echo   ============================================
echo     Instagram Comments Automation - Setup
echo   ============================================
echo.
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo   [X] Node.js is not installed.
  echo       Install the LTS version from https://nodejs.org
  pause
  exit /b 1
)

echo   [1/2] Installing Playwright...
call npm install >install-log.txt 2>&1
if %errorlevel% neq 0 (
  echo   [X] npm install failed. See install-log.txt
  pause
  exit /b 1
)

echo   [2/2] Installing Chromium...
call npx playwright install chromium >>install-log.txt 2>&1
if %errorlevel% neq 0 (
  echo   [X] Chromium install failed. See install-log.txt
  pause
  exit /b 1
)

echo.
echo   Setup complete. Use START.bat from now on.
pause
