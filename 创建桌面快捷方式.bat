@echo off
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  for %%I in (python.exe) do if not "%%~$PATH:I"=="" set "PY=%%~$PATH:I"
)

"%PY%" "%~dp0client.py" --install-shortcut
echo.
pause
