"""start.py 桌面模式启动监控：成功隐藏窗口 / 失败保留窗口并展示日志。"""

import importlib.util
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
START = ROOT / "start.py"


def load_start():
    spec = importlib.util.spec_from_file_location("start_launcher", START)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _patch_common(monkeypatch, tmp_path, *, ready, poll_results):
    start = load_start()
    log_path = tmp_path / "startup-console.log"
    monkeypatch.setattr(start, "STARTUP_LOG", str(log_path))
    monkeypatch.setattr(start.platform, "system", lambda: "Windows")
    monkeypatch.setattr(start, "_app_ready", lambda port, timeout=1.5: ready())
    popen_calls = []

    class FakeProc:
        def __init__(self):
            self._polls = iter(poll_results)
            self.waited = False

        def poll(self):
            try:
                return next(self._polls)
            except StopIteration:
                return None

        def wait(self, timeout=None):
            self.waited = True
            return 0

    procs = []

    def _popen(*a, **k):
        proc = FakeProc()
        if "env" in k:
            # 只记录 respawn 的 Popen（kill_port 的 netstat/taskkill 没有 env kwarg）
            popen_calls.append(k)
            procs.append(proc)
        return proc

    monkeypatch.setattr(start.subprocess, "Popen", _popen)
    monkeypatch.setattr(start.time, "sleep", lambda *_a: None)
    hide_calls = []
    monkeypatch.setattr(start, "_hide_own_console", lambda: hide_calls.append(True))
    return start, popen_calls, hide_calls, log_path, procs


def test_desktop_run_hides_console_when_ready(monkeypatch, tmp_path):
    start, popen_calls, hide_calls, log_path, procs = _patch_common(
        monkeypatch, tmp_path, ready=lambda: True, poll_results=[None],
    )
    monkeypatch.setattr(start.os, "environ", {**os.environ})

    with pytest.raises(SystemExit) as ei:
        start.run_desktop_mode(18080)
    assert ei.value.code == 0
    assert hide_calls == [True]
    # 隐藏后驻留：等子进程（应用）退出才结束
    assert procs and procs[0].waited is True
    # 子进程带隐藏标志启动且输出进日志文件
    kwargs = popen_calls[0]
    assert kwargs["env"][start.HIDE_CONSOLE_ENV] == "1"
    assert kwargs["creationflags"] == start.subprocess.CREATE_NO_WINDOW
    assert kwargs["stdout"] != start.subprocess.DEVNULL


def test_desktop_run_keeps_console_and_shows_log_on_failure(monkeypatch, tmp_path, capsys):
    start, _popen_calls, hide_calls, log_path, _procs = _patch_common(
        monkeypatch, tmp_path, ready=lambda: False, poll_results=[1],
    )
    log_path.write_text("[ERROR] npm install 失败\n", encoding="utf-8")
    monkeypatch.setattr(start.os, "environ", {**os.environ})
    monkeypatch.setattr("builtins.input", lambda *_a: "")

    with pytest.raises(SystemExit) as ei:
        start.run_desktop_mode(18080)
    assert ei.value.code == 1
    assert hide_calls == []  # 失败不隐藏，用户要看日志
    out = capsys.readouterr().out
    assert "启动失败" in out
    assert "npm install 失败" in out


def test_app_ready_accepts_any_http_response(monkeypatch):
    import urllib.error

    start = load_start()

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(start.urllib.request, "urlopen", lambda *a, **k: _Resp())
    assert start._app_ready(18080) is True

    def _raise_http_error(*a, **k):
        raise urllib.error.HTTPError("u", 401, "unauthorized", None, None)

    monkeypatch.setattr(start.urllib.request, "urlopen", _raise_http_error)
    assert start._app_ready(18080) is True

    monkeypatch.setattr(start.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError("refused")))
    assert start._app_ready(18080) is False


def test_electron_no_sandbox_flag_from_env(monkeypatch):
    start = load_start()
    monkeypatch.setattr(start.os, "environ", {})
    assert start._electron_no_sandbox_requested() is False
    monkeypatch.setattr(start.os, "environ", {"IA_ELECTRON_NO_SANDBOX": "1"})
    assert start._electron_no_sandbox_requested() is True


def test_electron_command_prefers_bundled_exe(monkeypatch, tmp_path):
    start = load_start()
    exe = tmp_path / "node_modules" / "electron" / "dist" / "electron.exe"
    exe.parent.mkdir(parents=True)
    exe.write_text("")
    monkeypatch.setattr(start, "DESKTOP_DIR", str(tmp_path))
    monkeypatch.setattr(start.platform, "system", lambda: "Windows")
    assert start._electron_command("npx") == [str(exe)]


def test_desktop_run_retries_with_no_sandbox_on_sandbox_crash(monkeypatch, tmp_path):
    start = load_start()
    monkeypatch.setattr(start.platform, "system", lambda: "Windows")
    monkeypatch.setattr(start, "HIDE_CONSOLE_ENV", "IA_HIDE_CONSOLE")
    monkeypatch.setattr(start.os, "environ", {"IA_HIDE_CONSOLE": "1"})
    monkeypatch.setattr(start, "DESKTOP_DIR", str(tmp_path))
    monkeypatch.setattr(start, "ensure_electron", lambda: True)
    monkeypatch.setattr(start, "kill_port", lambda _port: None)
    monkeypatch.setattr(start, "_find_npx", lambda: "npx")
    monkeypatch.setattr(start, "_electron_command", lambda _npx: ["electron"])
    calls = []

    class _Result:
        def __init__(self, rc):
            self.returncode = rc

    def _fake_run(args, **_kwargs):
        calls.append(list(args))
        # 第一次模拟 Chromium 沙箱初始化失败（STATUS_BREAKPOINT），重试后成功
        return _Result(2147483651) if len(calls) == 1 else _Result(0)

    monkeypatch.setattr(start.subprocess, "run", _fake_run)

    with pytest.raises(SystemExit) as ei:
        start.run_desktop_mode(18080)
    assert ei.value.code == 0
    assert len(calls) == 2
    assert "--no-sandbox" not in calls[0]
    assert "--no-sandbox" in calls[1]
    assert calls[1][-1] == "."


