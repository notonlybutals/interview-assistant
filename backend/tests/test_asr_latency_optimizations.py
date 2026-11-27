"""回归测试：借鉴 CoverDrive 的 ASR 准确率 / 首答延迟优化。

覆盖：
- 自适应噪声底 VAD 门限（`services.audio.VADBuffer`）
- FunASR/Whisper 中文热词 + 上下文词注入（`services.stt.text_utils`）
- 问句判定精度（裸「说 / 讲」不再把陈述句误判成问题）
- ASR 自动答题判定与显示合并解耦（`api.assist.asr_state`）
- 豆包 `corpus.context` 对话上下文注入
- 低延迟相关配置默认值可被 `AppConfig` 读取/夹取
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from api.assist.asr_state import AssistAsrStateMachine  # noqa: E402
from core.config import AppConfig  # noqa: E402
from core.session import reset_session  # noqa: E402
from services.audio import VADBuffer  # noqa: E402
from services.stt import engines, text_utils  # noqa: E402


class _Logger:
    def __init__(self):
        self.lines: list[tuple] = []

    def info(self, *args, **kwargs):
        self.lines.append(args)


def _cfg(**overrides):
    base = dict(
        auto_detect=True,
        transcription_min_sig_chars=2,
        assist_asr_confirm_window_sec=0.3,
        assist_asr_fast_confirm_sec=0.45,
        assist_asr_group_max_wait_sec=0.8,
        assist_asr_late_constraint_grace_sec=0.35,
        assist_transcription_merge_gap_sec=0.9,
        assist_transcription_merge_max_sec=12.0,
        assist_asr_context_chars=600,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _new_state(submitted: list, clock=lambda: 5.0, turn_ids=None):
    ids = iter(turn_ids or [1])

    return AssistAsrStateMachine(
        broadcast=lambda _data: None,
        submit_answer_task=lambda task: submitted.append(task) or True,
        begin_asr_turn=lambda: next(ids),
        record_asr_turn=lambda _now: None,
        is_high_churn_submission=lambda _cfg, _now: False,
        logger=_Logger(),
        clock=clock,
    )


def _feed_noise(vad: VADBuffer, level: float = 0.008, frames: int = 20, samples: int = 160) -> None:
    for _ in range(frames):
        vad.feed(np.full(samples, level, dtype=np.float32))


# ---------------------------------------------------------------------------
# VAD：自适应噪声底门限
# ---------------------------------------------------------------------------

def test_adaptive_vad_raises_gate_above_fixed_floor_in_noisy_room():
    vad = VADBuffer(
        sample_rate=16000,
        silence_threshold=0.01,
        silence_duration=0.05,
        min_speech_duration=0.001,
        adaptive_threshold=True,
        noise_margin_db=6.0,
    )
    _feed_noise(vad)
    floor = vad.noise_floor()
    assert floor is not None and floor > 0.005
    assert vad.current_threshold() > 0.01
    # 0.012 高于固定门限 0.01，但低于自适应门限（≈0.016）：不应被当成人声
    for _ in range(5):
        assert vad.feed(np.full(160, 0.012, dtype=np.float32)) is None


def test_adaptive_vad_hysteresis_keeps_quiet_speech_tail_while_speaking():
    vad = VADBuffer(
        sample_rate=16000,
        silence_threshold=0.01,
        silence_duration=0.05,
        min_speech_duration=0.001,
        adaptive_threshold=True,
        noise_margin_db=6.0,
    )
    _feed_noise(vad)
    assert vad.feed(np.full(160, 0.2, dtype=np.float32)) is None
    # 轻声尾音 0.011：低于基准门限但高于「开口后」门限，仍算语音，不触发断句
    for _ in range(12):
        assert vad.feed(np.full(160, 0.011, dtype=np.float32)) is None


def test_adaptive_vad_disabled_keeps_fixed_threshold():
    vad = VADBuffer(sample_rate=16000, silence_threshold=0.01, adaptive_threshold=False)
    assert vad.current_threshold() == 0.01
    _feed_noise(vad, level=0.005)
    assert vad.noise_floor() is None
    assert vad.current_threshold() == 0.01


# ---------------------------------------------------------------------------
# 热词 / 上下文偏置
# ---------------------------------------------------------------------------

def test_tech_hotwords_include_chinese_terms():
    words = text_utils.build_tech_hotwords("后端开发", "Python", limit=900)
    assert "主从复制" in words
    assert "缓存穿透" in words
    assert "Redis" in words


def test_tech_hotwords_keep_custom_words_first():
    words = text_utils.build_tech_hotwords(
        "前端开发",
        "JavaScript",
        limit=900,
        custom={"通用": "飞书 云原生", "前端开发": "微前端"},
    )
    assert words[:3] == ["飞书", "云原生", "微前端"]


def test_context_hotwords_extract_terms_from_recent_transcript():
    words = text_utils.build_context_hotwords(
        "上一题聊了 Redis 主从复制和分布式事务，RAG 怎么优化", limit=12
    )
    assert "Redis" in words
    assert "RAG" in words
    assert "主从复制" in words


def test_build_asr_context_text_keeps_oldest_first_and_newest_tail():
    text = text_utils.build_asr_context_text(["早先的话", "中间的话", "最近的话"], max_chars=200)
    assert text.index("早先") < text.index("中间") < text.index("最近")
    clipped = text_utils.build_asr_context_text(["旧" * 300, "新" * 300], max_chars=100)
    assert len(clipped) <= 100
    assert clipped.endswith("新")


# ---------------------------------------------------------------------------
# 问句判定精度
# ---------------------------------------------------------------------------

def test_question_cue_ignores_bare_say_in_statement():
    kind, _ = text_utils.classify_asr_question_candidate("然后我就跟他说", 2)
    assert kind == "ignore"


def test_question_cue_ignores_implementation_statement():
    kind, _ = text_utils.classify_asr_question_candidate("我们实现了这个功能", 2)
    assert kind != "promote"


def test_question_cue_keeps_real_interview_questions():
    for text in (
        "解释一下AOP的原理",
        "讲讲 Redis 持久化",
        "请设计一个秒杀系统",
        "Kafka 如何保证顺序",
        "死锁呢",
        "举个例子",
    ):
        kind, _ = text_utils.classify_asr_question_candidate(text, 2)
        assert kind == "promote", text


# ---------------------------------------------------------------------------
# 判定与显示合并解耦
# ---------------------------------------------------------------------------

def test_fragment_detection_runs_immediately_even_when_display_merge_enabled():
    submitted: list = []
    state = _new_state(submitted)
    session = reset_session()
    session.capture_is_loopback = False
    cfg = _cfg(assist_transcription_merge_gap_sec=2.0)

    state.append_transcription_fragment(cfg, session, "请讲一下 Redis 持久化", 1.0)

    # 判定立即发生，不用等 2s 的显示合并窗口
    assert state.pending_group is not None
    assert state.pending_group.utterances == ["请讲一下 Redis 持久化"]
    # 显示合并仍在缓冲（2s gap 未到）
    assert state.merge_parts == ["请讲一下 Redis 持久化"]
    assert submitted == []

    state.try_flush_question_group(cfg, session, 1.5)
    assert len(submitted) == 1
    assert "Redis 持久化" in submitted[0][0]


def test_display_merge_flush_does_not_duplicate_question_submission():
    submitted: list = []
    state = _new_state(submitted)
    session = reset_session()
    session.capture_is_loopback = False
    cfg = _cfg(assist_transcription_merge_gap_sec=2.0)

    state.append_transcription_fragment(cfg, session, "请讲一下 Redis 持久化", 1.0)
    state.try_flush_question_group(cfg, session, 1.5)
    assert len(submitted) == 1

    # 显示合并到点只更新转写区，不应再触发一次答题判定
    state.flush_merge_buffer_now(cfg, session)
    assert len(submitted) == 1
    assert session.transcription_history == ["请讲一下 Redis 持久化"]


def test_question_meta_carries_latency_ledger_fields():
    submitted: list = []
    state = _new_state(submitted, clock=lambda: 3.0)
    session = reset_session()
    session.capture_is_loopback = False
    cfg = _cfg(assist_transcription_merge_gap_sec=0.0)

    state.handle_auto_detect_asr_text(cfg, session, "Kafka 如何保证顺序", "conversation_mic", 2.0)
    state.try_flush_question_group(cfg, session, 3.0)

    assert len(submitted) == 1
    meta = submitted[0][4]
    assert meta["asr_group_first_mono"] == 2.0
    assert meta["asr_flush_mono"] == 3.0
    # 派发宽限 = 确认时刻 + late constraint grace（默认 0.35s）
    assert meta["dispatch_after_mono"] == 3.35


# ---------------------------------------------------------------------------
# 豆包 ASR 上下文注入
# ---------------------------------------------------------------------------

def _decode_full_request(frame: bytes) -> dict:
    # header(4) + sequence(4) + payload_size(4) + gzip payload
    size = int.from_bytes(frame[8:12], "big")
    payload = gzip.decompress(frame[12 : 12 + size])
    return json.loads(payload.decode("utf-8"))


def test_doubao_full_request_injects_dialog_context():
    frame = engines._build_ws_frame_full_request(
        "app", "", context="上一题聊了 Redis 主从复制"
    )
    req = _decode_full_request(frame)
    corpus = req["request"]["corpus"]
    ctx = json.loads(corpus["context"])
    assert ctx["context_type"] == "dialog_ctx"
    assert "Redis" in ctx["context_data"][0]["text"]


def test_doubao_full_request_keeps_boosting_table_and_context_together():
    frame = engines._build_ws_frame_full_request(
        "app", "boost-123", context="分布式事务怎么做"
    )
    req = _decode_full_request(frame)
    corpus = req["request"]["corpus"]
    assert corpus["boosting_table_id"] == "boost-123"
    assert "分布式事务" in json.loads(corpus["context"])["context_data"][0]["text"]


# ---------------------------------------------------------------------------
# 引擎调用兼容层：context 透传 + 旧四参签名回退
# ---------------------------------------------------------------------------

def test_engine_transcribe_passes_context_to_new_signature():
    from services.stt import factory

    seen = {}

    class NewEngine:
        def transcribe(self, audio, sample_rate=16000, position="", language="", context=""):
            seen["context"] = context
            return "ok"

    assert (
        factory._engine_transcribe(
            NewEngine(), np.zeros(10, dtype=np.float32), 16000, "后端开发", "Python", "Redis 主从"
        )
        == "ok"
    )
    assert seen["context"] == "Redis 主从"


def test_engine_transcribe_falls_back_for_old_four_arg_signature():
    from services.stt import factory

    class OldEngine:
        def transcribe(self, audio, sample_rate=16000, position="", language=""):
            return f"{position}/{language}"

    assert (
        factory._engine_transcribe(
            OldEngine(), np.zeros(10, dtype=np.float32), 16000, "后端开发", "Python", "ctx"
        )
        == "后端开发/Python"
    )


# ---------------------------------------------------------------------------
# 配置默认值
# ---------------------------------------------------------------------------

def test_config_defaults_are_low_latency_and_configurable():
    cfg = AppConfig()
    assert cfg.assist_asr_confirm_window_sec == 0.3
    assert cfg.assist_asr_fast_confirm_sec == 0.45
    assert cfg.assist_asr_group_max_wait_sec == 0.8
    assert cfg.assist_asr_late_constraint_grace_sec == 0.35
    assert cfg.assist_transcription_merge_gap_sec == 0.9
    assert cfg.assist_vad_adaptive is True
    assert cfg.assist_vad_noise_margin_db == 6.0
    assert cfg.assist_asr_context_chars == 600


def test_config_clamps_out_of_range_latency_values():
    cfg = AppConfig(
        assist_asr_fast_confirm_sec=99,
        assist_asr_late_constraint_grace_sec=-1,
        assist_asr_context_chars=99999,
        assist_vad_noise_margin_db=999,
    )
    assert cfg.assist_asr_fast_confirm_sec == 2.0
    assert cfg.assist_asr_late_constraint_grace_sec == 0.0
    assert cfg.assist_asr_context_chars == 2000
    assert cfg.assist_vad_noise_margin_db == 30.0
