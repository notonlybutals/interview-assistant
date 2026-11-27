@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "IA_ELECTRON_NO_SANDBOX=1"
set "DEV_RUNTIME=%SystemDrive%\InterviewAssistantDev\electron-runtime\electron.exe"
if not exist "%DEV_RUNTIME%" (
  echo [ERROR] Dev Electron runtime not found: %DEV_RUNTIME%
  echo Run scripts\prepare-dev-runtime.bat as Administrator once, then retry.
  pause
  exit /b 1
)
set "PATH=%~dp0.venv\Scripts;%PATH%"
pushd "%~dp0desktop"
start "" "%DEV_RUNTIME%" --no-sandbox .
set "result=%errorlevel%"
popd
exit /b %result%