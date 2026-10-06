@echo off
title Instagram Comments Automation
color 0A
echo.
echo   ============================================
echo     Instagram Comments Automation
echo   ============================================
echo.
echo   [1/3] Checking for updates from GitHub...
call node updater.js

echo   [2/3] Clearing port 4610...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4610 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo   [3/3] Starting dashboard...
echo   Keep this window open while you use it.
echo.
node server.js
echo.
echo   The app has stopped.
pause
