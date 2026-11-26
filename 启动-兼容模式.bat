@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0" || exit /b 1

rem 兼容模式启动：
rem   1) 清掉 ELECTRON_RUN_AS_NODE（从 Electron 宿主/DSH 环境继承时会以纯 Node 运行而崩溃）
rem   2) IA_ELECTRON_NO_SANDBOX=1 -> start.py 给 Electron 传 --no-sandbox
rem       （部分 Windows 机器上安全软件/系统策略会让 Chromium 沙箱初始化即 STATUS_BREAKPOINT，
rem        现象是双击后只弹一个"桌面应用启动失败"、日志里没有任何 Electron 输出）

set "ELECTRON_RUN_AS_NODE="
set "IA_ELECTRON_NO_SANDBOX=1"

if not exist ".venv\Scripts\python.exe" (
    echo 找不到项目的 .venv\Scripts\python.exe，请先安装项目依赖。
    pause
    popd
    exit /b 1
)
set "PATH=%CD%\.venv\Scripts;%PATH%"
".venv\Scripts\python.exe" start.py %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
popd
exit /b %result%
