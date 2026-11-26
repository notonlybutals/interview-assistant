#!/usr/bin/env python3
"""Unified launcher for the interview assistant."""

import argparse
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Optional

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(ROOT, "backend")
FRONTEND_DIR = os.path.join(ROOT, "frontend")
FRONTEND_DIST = os.path.join(FRONTEND_DIR, "dist")
DESKTOP_DIR = os.path.join(ROOT, "desktop")

REQUIREMENTS = os.path.join(BACKEND_DIR, "requirements.txt")
HIDE_CONSOLE_ENV = "IA_HIDE_CONSOLE"


# ---------------------------------------------------------------------------
# Console helpers
# ---------------------------------------------------------------------------

def _set_utf8_console():
    """Windows: switch active code page to UTF-8 so Unicode chars render."""
    if platform.system() != "Windows":
        return
    try:
        subprocess.run(["chcp", "65001"], capture_output=True, shell=True)
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass


STARTUP_LOG = os.path.join(ROOT, "log", "startup-console.log")


def _app_ready(port: int, timeout: float = 1.5) -> bool:
    """只要端口上有 HTTP 响应就算服务已起（401/404 也算，鉴权无关）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/options", timeout=timeout):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def _tail_file(path: str, lines_n: int = 20, max_chars: int = 2400) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except OSError:
        return ""
    lines = content.splitlines()
    return "\n".join(lines[-lines_n:])[-max_chars:]


def _hide_own_console() -> None:
    if platform.system() != "Windows":
        return
    try:
        import ctypes

        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)
    except Exception:
        pass


def _hidden_process_kwargs() -> dict:
    if platform.system() != "Windows":
        return {}
    if os.environ.get(HIDE_CONSOLE_ENV, "").strip().lower() not in ("1", "true", "yes"):
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}


def _electron_no_sandbox_requested() -> bool:
    """IA_ELECTRON_NO_SANDBOX=1 时给 Electron 加 --no-sandbox（兼容沙箱崩溃的 Windows 机器）。"""
    return os.environ.get("IA_ELECTRON_NO_SANDBOX", "").strip().lower() in ("1", "true", "yes", "on")


# Chromium 沙箱初始化失败时 Windows 以 STATUS_BREAKPOINT(0x80000003) 退出，
# Python 里可能是无符号 2147483651，也可能是负数 -2147483645。
_ELECTRON_SANDBOX_CRASH_CODES = (2147483651, -2147483645)


def _electron_command(npx: Optional[str]) -> list[str]:
    """优先直接运行 electron 可执行文件，找不到时再退回 npx。

    直接跑 `node_modules/electron/dist/electron.exe` 可以绕开 npx 的参数解析，
    启动也更快；某些机器上 `npx electron --no-sandbox .` 里的参数不一定能透传。
    """
    is_win = platform.system() == "Windows"
    if is_win:
        exe = os.path.join(DESKTOP_DIR, "node_modules", "electron", "dist", "electron.exe")
        if os.path.isfile(exe):
            return [exe]
    bin_name = "electron.cmd" if is_win else "electron"
    bin_path = os.path.join(DESKTOP_DIR, "node_modules", ".bin", bin_name)
    if os.path.isfile(bin_path):
        return [bin_path]
    return [npx or "npx", "electron"]


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _print_access_info(port: int):
    """Print access URLs for both local and LAN."""
    ip = get_local_ip()
    print(f"  本机访问:   http://localhost:{port}")
    print(f"  局域网访问: http://{ip}:{port}")
    print()
    print(f"  手机扫码:   打开上方页面 → 右上角设置 → 底部二维码")
    print(f"  (手机和电脑需在同一 WiFi 下，音频在电脑端采集)")
    print()


# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------

def _pip_install(packages: list[str]):
    """Install packages using the *current* Python interpreter."""
    print(f"[...] 正在安装: {' '.join(packages)}")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", *packages]
    )
    return r.returncode == 0


def ensure_python_deps():
    """Make sure all backend Python dependencies are importable.

    Strategy:
    1. Try importing key packages. If they all work, do nothing.
    2. If any is missing, run: pip install -r backend/requirements.txt
       using *sys.executable* (same Python that is running this script).
    3. After installing, re-check; exit with helpful message if still missing.
    """
    probe_packages = ["fastapi", "uvicorn", "openai", "numpy", "sounddevice"]
    missing = []
    for pkg in probe_packages:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)

    if not missing:
        return  # all good

    print(f"[WARN] 缺少 Python 依赖: {', '.join(missing)}")
    print(f"[...] 尝试自动安装 backend/requirements.txt ...")
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", REQUIREMENTS, "--quiet"]
    )
    if r.returncode != 0:
        _print_dep_help()
        sys.exit(1)

    # Re-check
    still_missing = []
    for pkg in probe_packages:
        try:
            __import__(pkg.replace("-", "_"))
        except ImportError:
            still_missing.append(pkg)
    if still_missing:
        print(f"\n[ERROR] 安装后仍缺少: {', '.join(still_missing)}")
        _print_dep_help()
        sys.exit(1)

    print("[OK] 依赖安装完成")


def _print_dep_help():
    print()
    print("  请手动安装后端依赖：")
    print(f"    {sys.executable} -m pip install -r backend/requirements.txt")
    print()
    print("  如果你在使用虚拟环境，请先激活它：")
    if platform.system() == "Windows":
        print("    venv\\Scripts\\activate       # CMD")
        print("    venv\\Scripts\\Activate.ps1   # PowerShell")
    else:
        print("    source venv/bin/activate")
    print()
    print("  也可以用 conda：")
    print("    conda activate <your-env>")


def _find_npx() -> Optional[str]:
    """Return path to npx, or None if not found."""
    return shutil.which("npx") or shutil.which("npx.cmd")


def _find_npm() -> Optional[str]:
    return shutil.which("npm") or shutil.which("npm.cmd")


def _print_node_help():
    system = platform.system()
    print()
    print("[ERROR] 未找到 Node.js / npm，桌面模式和前端构建需要 Node.js 18+。")
    print()
    if system == "Windows":
        print("  安装方法（选一种）：")
        print("  1. 官网下载安装包: https://nodejs.org （推荐 LTS 版）")
        print("  2. winget: winget install OpenJS.NodeJS.LTS")
        print("  3. 用 nvm-windows 管理多版本: https://github.com/coreybutler/nvm-windows")
    elif system == "Darwin":
        print("  安装方法（选一种）：")
        print("  1. Homebrew: brew install node")
        print("  2. 官网下载: https://nodejs.org")
        print("  3. nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash")
        print("         nvm install --lts")
    else:
        print("  安装方法（选一种）：")
        print("  1. 包管理器: sudo apt install nodejs npm  / sudo dnf install nodejs")
        print("  2. nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash")
        print("          nvm install --lts")
    print()
    print("  安装后重新打开终端再运行本脚本。")
    print()
    print("  如果只想用网络模式（浏览器访问），可以先跳过桌面模式：")
    print("    python start.py --mode network")


# ---------------------------------------------------------------------------
# Frontend build
# ---------------------------------------------------------------------------

def build_frontend(force: bool = False):
    if not force and os.path.isdir(FRONTEND_DIST):
        print("[OK] 前端已构建，跳过 (用 --rebuild 强制重新构建)")
        return True

    npm = _find_npm()
    if npm is None:
        _print_node_help()
        return False

    if force and os.path.isdir(FRONTEND_DIST):
        print("[...] 清除旧构建产物...")
        shutil.rmtree(FRONTEND_DIST, ignore_errors=True)

    print("[...] 构建前端...")
    if not os.path.isdir(os.path.join(FRONTEND_DIR, "node_modules")):
        print("  安装前端 npm 依赖...")
        r = subprocess.run([npm, "install"], cwd=FRONTEND_DIR, **_hidden_process_kwargs())
        if r.returncode != 0:
            print("[ERROR] npm install 失败")
            return False
    r = subprocess.run([npm, "run", "build"], cwd=FRONTEND_DIR, **_hidden_process_kwargs())
    if r.returncode != 0:
        print("[ERROR] 前端构建失败")
        return False
    print("[OK] 前端构建完成")
    return True


def ensure_electron():
    """Make sure desktop/node_modules/electron exists."""
    if os.path.isdir(os.path.join(DESKTOP_DIR, "node_modules", "electron")):
        return True

    npm = _find_npm()
    if npm is None:
        _print_node_help()
        return False

    print("[...] 安装 Electron 依赖...")
    r = subprocess.run([npm, "install"], cwd=DESKTOP_DIR, **_hidden_process_kwargs())
    return r.returncode == 0


# ---------------------------------------------------------------------------
# Port management
# ---------------------------------------------------------------------------

def _port_in_use(port: int, timeout: float = 0.3) -> bool:
    """端口上是否已有进程在监听（只连本机回环，不触发业务请求）。"""
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def kill_port(port: int) -> bool:
    """Kill any process occupying the given port.

    Returns True when the port is free afterwards. 如果占用进程权限比当前进程高
    （例如上一次用管理员权限启动后残留的后台进程），taskkill 会失败；调用方必须
    检查返回值并给出明确错误，而不是继续启动后「什么都没发生」。
    """
    system = platform.system()
    killed = False
    try:
        if system == "Windows":
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True, text=True, encoding="utf-8", errors="replace"
            )
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    pid = parts[-1]
                    subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
                    print(f"[OK] 已终止占用端口 {port} 的进程 (PID {pid})")
                    killed = True
        else:
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True, text=True
            )
            for pid in result.stdout.strip().split():
                if pid:
                    subprocess.run(["kill", "-9", pid], capture_output=True)
                    print(f"[OK] 已终止占用端口 {port} 的进程 (PID {pid})")
                    killed = True
    except Exception as e:
        print(f"[WARN] 清理端口 {port} 时出错: {e}")
    if killed:
        time.sleep(0.5)
    return not _port_in_use(port)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

def start_server(host: str, port: int):
    kill_port(port)

    # Add backend to sys.path so all relative imports work correctly
    if BACKEND_DIR not in sys.path:
        sys.path.insert(0, BACKEND_DIR)
    os.chdir(BACKEND_DIR)

    # Try direct import first (fastest, works when deps are in current env)
    try:
        import uvicorn
        _access_log = os.environ.get("IA_ACCESS_LOG", "1").strip().lower() not in ("0", "false", "no")
        uvicorn.run(
            "main:app",
            host=host,
            port=port,
            log_level="info",
            reload=False,
            access_log=_access_log,
        )
        return
    except ImportError:
        pass

    # Fallback: subprocess using sys.executable (handles venv / conda / pyenv)
    print("[INFO] uvicorn 不在当前 Python 路径，尝试通过 subprocess 启动...")
    uv_args = [
        sys.executable, "-m", "uvicorn",
        "main:app",
        "--host", host,
        "--port", str(port),
        "--log-level", "info",
    ]
    if os.environ.get("IA_ACCESS_LOG", "1").strip().lower() in ("0", "false", "no"):
        uv_args.append("--no-access-log")
    r = subprocess.run(uv_args, cwd=BACKEND_DIR, **_hidden_process_kwargs())
    sys.exit(r.returncode)


# ---------------------------------------------------------------------------
# Run modes
# ---------------------------------------------------------------------------

def run_desktop_mode(port: int):
    """Desktop mode: Electron window with content protection and global hotkeys."""
    npx = _find_npx()
    if npx is None:
        _print_node_help()
        sys.exit(1)

    if not ensure_electron():
        print("[ERROR] Electron 安装失败，请检查网络后重试。")
        print("  手动安装: cd desktop && npm install")
        print()
        print("  或者直接用无 Electron 模式启动:")
        print(f"    python start.py --mode network")
        sys.exit(1)

    # Pre-clean the port BEFORE Electron launches (Electron spawns
    # start.py --mode network internally, but if a zombie process holds
    # the port, it would fail deep inside that chain with a confusing error).
    if not kill_port(port):
        print()
        print(f"[ERROR] 端口 {port} 仍被占用，启动已中止（占用进程可能比当前程序权限更高）。")
        print("  常见原因：上一次用管理员权限启动后残留的后台进程，或其它程序占用了该端口。")
        print("  处理：在任务管理器结束残留的 InterviewAssistant / python 进程，或重启电脑后再试。")
        sys.exit(1)

    # Windows: 如果当前进程还有控制台窗口，以无窗口模式重启自己并监控
    # 就绪：启动成功→隐藏本窗口；失败→保留窗口并展示启动日志，方便排错。
    if platform.system() == "Windows" and os.environ.get(HIDE_CONSOLE_ENV) != "1":
        print("  Electron 桌面模式")
        print("  - 屏幕共享隐身: 已开启")
        print("  - 全局快捷键: Ctrl+B 显示/隐藏")
        print("  - 系统托盘: 右键切换置顶、隐身等")
        print()
        _print_access_info(port)
        print()
        print("  正在启动桌面应用（完成后本窗口自动隐藏；若报错会保留并显示日志）...")

        env = {**os.environ, HIDE_CONSOLE_ENV: "1"}
        try:
            os.makedirs(os.path.dirname(STARTUP_LOG), exist_ok=True)
            logf = open(STARTUP_LOG, "ab")
        except OSError:
            logf = subprocess.DEVNULL
        proc = subprocess.Popen(
            [sys.executable] + sys.argv,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=logf,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
            cwd=os.getcwd(),
        )
        if hasattr(logf, "close"):
            logf.close()

        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            if _app_ready(port):
                # 隐藏后驻留：python 退出会让 cmd 把窗口画回来
                print("[OK] 启动完成，窗口已隐藏（关闭应用后本窗口恢复）。")
                _hide_own_console()
                try:
                    proc.wait()
                except KeyboardInterrupt:
                    pass
                sys.exit(0)
            time.sleep(0.5)

        rc = proc.poll()
        if rc is not None and rc == 0:
            sys.exit(0)  # 用户主动关闭了刚起的应用
        print()
        print("[ERROR] 桌面应用启动失败，最近输出：")
        print("-" * 56)
        tail = _tail_file(STARTUP_LOG)
        print(tail or "(无输出)")
        print("-" * 56)
        print(f"  完整日志: {STARTUP_LOG}")
        try:
            input("  按回车关闭窗口...")
        except EOFError:
            time.sleep(5)
        sys.exit(1)

    # 到这里说明已经是无窗口模式了（或者不是 Windows）
    env = {**os.environ, "PORT": str(port), HIDE_CONSOLE_ENV: "1"}
    command = _electron_command(npx)
    # 少数 Windows 机器（安全软件注入 / 系统策略）会让 Chromium 沙箱初始化即崩溃：
    # 进程以 0x80000003（STATUS_BREAKPOINT）退出且没有任何输出。设置
    # IA_ELECTRON_NO_SANDBOX=1 可跳过 Chromium 沙箱（仅本机应用，内容全部本地加载）。
    no_sandbox = _electron_no_sandbox_requested()

    def _spawn(use_no_sandbox: bool):
        args = [*command]
        if use_no_sandbox:
            args.append("--no-sandbox")
        args.append(".")
        return subprocess.run(args, cwd=DESKTOP_DIR, env=env, **_hidden_process_kwargs())

    proc = _spawn(no_sandbox)
    if proc.returncode in _ELECTRON_SANDBOX_CRASH_CODES and not no_sandbox:
        # 沙箱初始化失败自动降级重试一次：本应用只加载本地前端和本机后端，风险可控。
        print("[WARN] Electron 沙箱初始化失败（STATUS_BREAKPOINT），改用 --no-sandbox 重试…", flush=True)
        proc = _spawn(True)
    sys.exit(proc.returncode)


def run_network_mode(port: int):
    """Network mode: LAN accessible via browser (no Electron needed)."""
    os.environ.setdefault("IA_AUTH_ENABLE", "1")
    print("  纯浏览器模式（无 Electron）")
    print()
    _print_access_info(port)

    start_server("0.0.0.0", port)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    # Switch console to UTF-8 immediately on Windows (before any print)
    _set_utf8_console()
    # 从 Electron 宿主（DSH/Codex 等）继承时 ELECTRON_RUN_AS_NODE=1 会让 electron.exe
    # 以纯 Node 运行、require('electron') 直接崩。启动器自己清掉，避免依赖外部 bat。
    os.environ.pop("ELECTRON_RUN_AS_NODE", None)

    parser = argparse.ArgumentParser(description="面试助手启动器")
    parser.add_argument("--mode", choices=["desktop", "network"], default="desktop",
                        help="运行模式: desktop (Electron 桌面窗口) 或 network (局域网浏览器访问)")
    parser.add_argument("--port", type=int, default=18080, help="服务端口 (默认 18080)")
    parser.add_argument("--no-build", action="store_true", help="跳过前端构建")
    parser.add_argument("--rebuild", action="store_true", help="强制重新构建前端（即使 dist 已存在）")
    parser.add_argument("--skip-dep-check", action="store_true",
                        help="跳过 Python 依赖检查（已确认环境正确时可加速启动）")
    args = parser.parse_args()

    print("=" * 50)
    print("  面试学习助手")
    print("=" * 50)
    print()

    # Python 版本检查
    if sys.version_info < (3, 10):
        print(f"[ERROR] 需要 Python 3.10+，当前版本: {sys.version}")
        print("  请升级 Python: https://www.python.org/downloads/")
        sys.exit(1)

    print(f"  Python: {sys.version.split()[0]}  ({sys.executable})")
    print(f"  平台: {platform.system()} {platform.machine()}")
    print()

    # FunASR / ModelScope 默认把模型缓存到 ~/.cache/modelscope；少数 Windows 机器上
    # 该目录不可写（安全软件/系统策略，报 WinError 5），导致模型下载/加载失败。
    # 未显式配置时退回到项目内的缓存目录（可用 MODELSCOPE_CACHE 覆盖）。
    if not os.environ.get("MODELSCOPE_CACHE", "").strip():
        fallback_cache = os.path.join(ROOT, ".modelscope-cache")
        try:
            os.makedirs(fallback_cache, exist_ok=True)
            os.environ["MODELSCOPE_CACHE"] = fallback_cache
        except OSError:
            pass

    # Ensure Python deps (auto-install if missing)
    if not args.skip_dep_check:
        ensure_python_deps()

    if not args.no_build:
        if not build_frontend(force=args.rebuild):
            print()
            print("  前端构建失败，可以用 --no-build 跳过（需先手动构建）：")
            print(f"    cd frontend && npm install && npm run build && cd ..")
            print(f"    python start.py --no-build")
            sys.exit(1)

    mode_label = "Electron 桌面窗口" if args.mode == "desktop" else "局域网浏览器"
    print(f"  模式: {mode_label}  端口: {args.port}")
    print("=" * 50)
    print()

    if args.mode == "desktop":
        run_desktop_mode(args.port)
    else:
        run_network_mode(args.port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  已停止。")
        sys.exit(0)
