@echo off
title Push Updates to GitHub
color 0B
cd /d "%~dp0"
echo.
echo ============================================================
echo   Pushing Latest Updates to GitHub Repo...
echo ============================================================
echo.
git add .
set /p msg="Enter update description (or press Enter for default): "
if "%msg%"=="" set msg=Update latest features and fixes
git commit -m "%msg%"
git push origin main
echo.
echo ============================================================
echo   SUCCESS! Updates pushed to GitHub!
echo   All connected RDPs will now auto-update on startup!
echo ============================================================
pause
