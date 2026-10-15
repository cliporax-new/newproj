@echo off
title Instagram Comments Automation
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   [!] Node.js not found. Auto-downloading and installing Node.js...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi', '$env:TEMP\node-installer.msi')"
    echo   Installing Node.js silently - please wait 30 seconds...
    msiexec /i "%TEMP%\node-installer.msi" /quiet /norestart
    del /f /q "%TEMP%\node-installer.msi" >nul 2>&1
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    echo   Node.js installed successfully!
    echo.
)

echo.
echo   ============================================
echo     Instagram Comments Automation
echo   ============================================
echo.
echo   [1/3] Clearing stale processes and ports (4610, 4620)...
if exist ".git\index.lock" del /f /q ".git\index.lock" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4610 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :4620 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo   [2/3] Checking for updates and syncing accounts from GitHub...
call node updater.js

echo   [3/3] Checking Playwright browser...
where npx >nul 2>&1
if %errorlevel% equ 0 (
    if not exist "%LOCALAPPDATA%\ms-playwright\chromium*" (
        echo   Installing Chromium browser for Playwright - first run only...
        call npx playwright install chromium
    )
)

echo.
echo   Starting dashboard & SMM engine...
echo   Keep this window open while you use it.
echo.
node server.js
echo.
echo   The app has stopped.
pause
