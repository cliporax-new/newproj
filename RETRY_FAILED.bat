@echo off
title Retry Failed Comments (Last 3 Hours)
color 0E
cd /d "%~dp0"
echo.
echo ============================================================
echo   Retrying Failed Comments & SMM Orders (Last 3 Hours)...
echo ============================================================
echo.
node retry-failed.js
echo.
echo ============================================================
echo   Check Live Dashboard: http://localhost:4610
echo ============================================================
echo.
pause
