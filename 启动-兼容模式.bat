@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0" || exit /b 1

rem Compatibility launcher:
rem   1) clear ELECTRON_RUN_AS_NODE (inherited from Electron-based hosts)
rem   2) IA_ELECTRON_NO_SANDBOX=1 -> start.py passes --no-sandbox to Electron
rem      (some Windows machines crash on Chromium sandbox init: STATUS_BREAKPOINT)
rem   3) append to log\launch.log so "double click did nothing" is diagnosable

if not exist "log" mkdir "log"
>> "log\launch.log" echo [%date% %time%] compat launcher: start

set "ELECTRON_RUN_AS_NODE="
set "IA_ELECTRON_NO_SANDBOX=1"

if not exist ".venv\Scripts\python.exe" (
    echo Missing .venv\Scripts\python.exe - install dependencies first.
    >> "log\launch.log" echo [%date% %time%] compat launcher: missing venv python
    pause
    popd
    exit /b 1
)
set "PATH=%CD%\.venv\Scripts;%PATH%"
".venv\Scripts\python.exe" start.py %*
set "result=%errorlevel%"
>> "log\launch.log" echo [%date% %time%] compat launcher: python exit=%result%
if not "%result%"=="0" pause
popd
exit /b %result%
