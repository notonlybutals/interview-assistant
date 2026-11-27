@echo off
setlocal
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Please run this script as Administrator.
  pause
  exit /b 1
)
set "SRC=%~dp0..\desktop\node_modules\electron\dist"
set "DST=%SystemDrive%\InterviewAssistantDev\electron-runtime"
if not exist "%~dp0..\desktop\node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run: cd desktop ^&^& npm install
  pause
  exit /b 1
)
robocopy "%SRC%" "%DST%" /E /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (
  echo Copy failed.
  pause
  exit /b 1
)
echo Dev Electron runtime prepared: %DST%
pause