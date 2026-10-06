@echo off
title Instagram Comments Automation - Full RDP Setup
color 0B
cd /d "%~dp0"
echo.
echo ============================================================
echo   Instagram Comments Automation - 1-Click RDP Setup
echo ============================================================
echo.

echo [1/5] Setting TimeZone to India Standard Time (UTC+05:30)...
tzutil /s "India Standard Time" >nul 2>&1
echo       Done.

echo [2/5] Opening Windows Firewall for SMM API Port 4620...
netsh advfirewall firewall delete rule name="SMM API 4620" >nul 2>&1
netsh advfirewall firewall add rule name="SMM API 4620" dir=in action=allow protocol=TCP localport=4620 >nul 2>&1
echo       Done.

echo [3/5] Checking Node.js installation...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo       Node.js not found. Downloading Node.js LTS installer...
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi', '%TEMP%\node-installer.msi')"
    echo       Installing Node.js silently (please wait 30 seconds)...
    msiexec /i "%TEMP%\node-installer.msi" /quiet /norestart
    del /f /q "%TEMP%\node-installer.msi" >nul 2>&1
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    echo       Node.js installed successfully.
) else (
    echo       Node.js is already installed.
)

echo [4/5] Installing Playwright and dependencies...
call npm install
call npx playwright install chromium

echo.
echo [5/5] Setup Complete! Starting automation server...
echo ============================================================
echo.
call START.bat
