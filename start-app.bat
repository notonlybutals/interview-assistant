@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0" || exit /b 1

rem Reliable ASCII-named launcher (desktop shortcut target).
if not exist "log" mkdir "log"
>> "log\launch.log" echo [%date% %time%] start-app: start

set "ELECTRON_RUN_AS_NODE="
set "IA_ELECTRON_NO_SANDBOX=1"

if not exist ".venv\Scripts\python.exe" (
    echo Missing .venv\Scripts\python.exe - install dependencies first.
    >> "log\launch.log" echo [%date% %time%] start-app: missing venv python
    pause
    popd
    exit /b 1
)
set "PATH=%CD%\.venv\Scripts;%PATH%"
".venv\Scripts\python.exe" start.py %*
set "result=%errorlevel%"
>> "log\launch.log" echo [%date% %time%] start-app: python exit=%result%
if not "%result%"=="0" pause
popd
exit /b %result%
