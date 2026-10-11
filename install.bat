@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   BiliHistory - install runtime
echo ============================================
echo.

set "BASE="
where python >nul 2>nul
if %errorlevel%==0 set "BASE=python"
if not defined BASE (
  where py >nul 2>nul
  if %errorlevel%==0 set "BASE=py -3"
)
if not defined BASE (
  echo [!] Python not found. Install Python 3.9+ first:
  echo     https://www.python.org/downloads/
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/3] creating virtual env .venv ...
  %BASE% -m venv .venv
) else (
  echo [1/3] .venv already exists
)

echo [2/3] upgrading pip ...
".venv\Scripts\python.exe" -m pip install -q --upgrade pip

echo [3/3] installing pywebview + pillow ...
".venv\Scripts\python.exe" -m pip install -q pywebview pillow

echo.
echo Done. Double-click  启动客户端.bat  to run the desktop client.
echo.
pause
