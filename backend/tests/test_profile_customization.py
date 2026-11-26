"""岗位 / 语言自定义：非技术岗（如「酒店管培生」）与「语言不限（无）」的 prompt 行为。"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.llm import prompts  # noqa: E402


def _cfg(**overrides):
    base = dict(
        position="酒店管培生",
        language="无",
        resume_text=None,
        screen_capture_region="left_half",
        kb_prompt_excerpt_chars=300,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _prompt(monkeypatch, cfg, mode="asr_realtime", **kwargs):
    monkeypatch.setattr(prompts, "get_config", lambda: cfg)
    return prompts.build_system_prompt(mode=mode, **kwargs)


def test_custom_position_flows_into_prompt_without_tech_assumption(monkeypatch):
    prompt = _prompt(monkeypatch, _cfg())

    assert "酒店管培生" in prompt
    # 旧模板固定写「正在参加技术面试的 {position} 候选人」，非技术岗会跑偏
    assert "技术面试" not in prompt


def test_unlimited_language_omits_language_clause(monkeypatch):
    prompt = _prompt(monkeypatch, _cfg(language="无"))

    assert "日常主要使用" not in prompt
    assert "日常主要使用 无" not in prompt
    assert "```无" not in prompt


def test_none_language_variants_are_treated_as_unlimited(monkeypatch):
    for value in ("无", "不限", "none", "N/A", "-", "  "):
        prompt = _prompt(monkeypatch, _cfg(language=value))
        assert "日常主要使用" not in prompt, value


def test_real_language_still_appears_in_prompt(monkeypatch):
    prompt = _prompt(monkeypatch, _cfg(language="Java"))

    assert "「酒店管培生」岗位" in prompt
    assert "日常主要使用 Java" in prompt


def test_manual_and_screen_modes_handle_custom_profile(monkeypatch):
    for mode in ("manual_text", "server_screen"):
        prompt = _prompt(monkeypatch, _cfg(position="管培生", language="无"), mode=mode)
        assert "管培生" in prompt
        assert "日常主要使用" not in prompt
