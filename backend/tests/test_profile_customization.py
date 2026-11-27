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
        interview_mode="tech",
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


def test_general_interview_mode_uses_behavioral_style(monkeypatch):
    prompt = _prompt(
        monkeypatch,
        _cfg(interview_mode="general", position="酒店管培生", language="无"),
    )

    assert "「酒店管培生」岗位" in prompt
    assert "STAR" in prompt
    # 非技术岗不应该再出现技术八股/代码规则
    assert "代码规则" not in prompt
    assert "技术面试" not in prompt
    assert "日常主要使用" not in prompt


def test_general_interview_mode_works_for_manual_text(monkeypatch):
    prompt = _prompt(
        monkeypatch,
        _cfg(interview_mode="general", position="运营专员", language="无"),
        mode="manual_text",
    )
    assert "运营专员" in prompt
    assert "手动文本" in prompt
    assert "STAR" in prompt


def test_soft_tail_ba_counts_as_question_when_second_person_present():
    from services.stt import text_utils

    # "你知道我们这个岗位是需要轮岗的吧"：真实面试里会被漏判（历史日志中 7 问只答 4）
    kind, _ = text_utils.classify_asr_question_candidate(
        "你知道我们这个岗位是需要轮岗的吧", 2
    )
    assert kind == "promote"


def test_soft_tail_ba_does_not_promote_non_question_statement():
    from services.stt import text_utils

    kind, _ = text_utils.classify_asr_question_candidate("那我们开始吧", 2)
    assert kind != "promote"


def test_tech_mode_keeps_code_rules(monkeypatch):
    prompt = _prompt(monkeypatch, _cfg(interview_mode="tech", language="Java"))
    assert "代码规则" in prompt
    assert "非技术岗" not in prompt


def test_general_interview_mode_includes_target_company_when_set(monkeypatch):
    fake_cfg = _cfg(
        position="质量管理 / 质检工程师（QC/QA）",
        language="无",
        interview_mode="general",
        target_company="华测检测",
    )
    prompt = _prompt(monkeypatch, fake_cfg)
    assert "华测检测" in prompt
    assert "质量管理" in prompt
    assert "核心价值观" in prompt


def test_general_interview_mode_keeps_language_with_target_company(monkeypatch):
    fake_cfg = _cfg(
        position="环境工程 / EHS工程师",
        language="英文",
        interview_mode="general",
        target_company="某食品集团",
    )
    prompt = _prompt(monkeypatch, fake_cfg)
    assert "某食品集团" in prompt
    assert "工作语言：英文" in prompt


def test_relaxed_question_detection_accepts_long_statement():
    from services.stt import text_utils

    statement = ["我们这个岗位需要在不同门店轮岗"]
    # 严格模式保持旧行为（陈述句不触发），放宽模式宁多答不漏答。
    assert text_utils.is_viable_asr_question_group(statement, 2) is False
    assert text_utils.is_viable_asr_question_group(statement, 2, relaxed=True) is True


def test_config_interview_mode_defaults_and_validation():
    from core.config import AppConfig

    assert AppConfig().interview_mode == "tech"
    assert AppConfig(interview_mode="GENERAL").interview_mode == "general"
    assert AppConfig(interview_mode="weird").interview_mode == "tech"

