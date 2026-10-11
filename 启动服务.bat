@echo off
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if exist "%PY%" goto run

for %%I in (python.exe) do if not "%%~$PATH:I"=="" (
  set "PY=%%~$PATH:I"
  goto run
)

echo [!] Python not found. Install Python 3.9+ first.
pause
exit /b 1

:run
"%PY%" "%~dp0server.py" %*
if not %errorlevel%==0 pause
