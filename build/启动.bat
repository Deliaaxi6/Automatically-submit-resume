@echo off
setlocal
rem ===== Resume Auto-Apply Tool - One-click launcher =====
rem Usage: place this file at the package root, double-click to run.
cd /d "%~dp0"

echo.
echo   ========================================
echo      Resume Auto-Apply Tool
echo   ========================================
echo.

rem 1) locate Chrome (needed by boss.mjs / zhaopin.mjs)
set "CHROME_PATH="
set "C1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "C2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
set "C3=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%C1%" set "CHROME_PATH=%C1%"
if not defined CHROME_PATH if exist "%C2%" set "CHROME_PATH=%C2%"
if not defined CHROME_PATH if exist "%C3%" set "CHROME_PATH=%C3%"
if defined CHROME_PATH (
  echo   [OK] Chrome found: %CHROME_PATH%
) else (
  echo   [WARN] Chrome not found. Install Google Chrome or set CHROME_PATH.
)

rem 2) locate node.exe (portable copy in package root, else system node)
set "NODE_EXE="
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE (
  echo   [ERROR] node.exe missing. Put node.exe next to this file or install Node.js.
  pause
  exit /b 1
)
echo   [OK] Node: %NODE_EXE%

rem 3) if service already running, just open the browser
netstat -ano | findstr ":3456 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo   [INFO] Service already running. Opening browser...
  start "" "http://127.0.0.1:3456"
  exit /b 0
)

rem 4) start web-ui exe from package root
echo   [START] Starting service at http://127.0.0.1:3456 ...
start "ResumeAutoApply" "%~dp0resume-web-ui.exe"

rem 5) wait until port is listening, then open browser
set /a tries=0
:waitloop
set /a tries+=1
if %tries% gtr 30 (
  echo   [ERROR] Service start timeout. See logs folder.
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3456 " | findstr "LISTENING" >nul
if errorlevel 1 goto waitloop

echo   [OK] Service ready. Opening browser...
start "" "http://127.0.0.1:3456"
echo.
echo   Running. Closing browser does not stop the service.
echo   To stop: end the resume-web-ui.exe process.
echo.
pause