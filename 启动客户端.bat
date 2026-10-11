@echo off
setlocal
cd /d "%~dp0"

set "PYW=%~dp0.venv\Scripts\pythonw.exe"
if exist "%PYW%" goto run

if defined BILI_PYTHON (
  if exist "%BILI_PYTHON%" (
    set "PYW=%BILI_PYTHON%"
    goto run
  )
)

for %%I in (pythonw.exe) do if not "%%~$PATH:I"=="" (
  set "PYW=%%~$PATH:I"
  goto run
)

echo.
echo  [!] Python runtime not found.
echo      Install Python 3.9+ , or double-click install.bat to build the .venv
echo.
pause
exit /b 1

:run
start "" "%PYW%" "%~dp0client.py" %*
