# 性能优化：借鉴 CoverDrive 的实时语音 Agent 设计

> 背景：面试辅助的痛点有两个——①面试官语音转写不够准（同音词、术语、断句切半句）；②面试官说完之后，到候选人看到答案的第一句，体感要 6~8 秒。
> 参考项目：[IcecreamAgent/CoverDrive](https://github.com/IcecreamAgent/CoverDrive)（车险续保的 AI 电话客服 Agent，端到端连续对话、插话打断、低延迟）。

## 先纠正一个预期：CoverDrive 的"快和准"主要来自模型，不是工程

CoverDrive 默认链路是 **Seeduplex 端到端实时语音模型**（`backend/voice_agent/config.py`：`voice_provider="seeduplex"`），一个 WebSocket 会话里同时完成"听 → 理解 → 回复 → 出声"：

- 它**没有独立的 ASR 服务**，ASR 文本是模型会话内部产生的事件（`conversation.item.input_audio_transcription.*`）；
- 服务端**不跑本地 VAD、不做本地端点检测**，端点由上游自动判定（`realtime.py` 只做奇偶/长度校验后原样转发）；
- 因此不存在"等 ASR final → 再调 LLM"这条串行链路，首字自然快。

这部分**不可直接移植**：换供应商、自建工具调用协议、24kHz 音频输出、无可解释中间态，代价远大于收益。CoverDrive 里真正可借鉴的是它 cascade / legacy 链路里的**工程件**——那才对应我们的架构（ASR → 问题识别 → LLM 文本答案）。

## 我们实际借鉴了什么

| # | 改动 | 借鉴来源 | 解决的问题 | 预期收益 |
| --- | --- | --- | --- | --- |
| 1 | **自动答题判定与显示合并解耦**：每个 ASR 片段到货立即参与问句判定，显示区仍按合并间隔合并 | CoverDrive 把"partial 只进 UI、final 才进业务"的分层思想；端点判定不等展示合并 | 原来问句判定被 `assist_transcription_merge_gap_sec`（默认 2.0s）的**显示**合并窗口拖延 | 说完 → 确认问句缩短 ≈1.5~2s |
| 2 | **候选/确认窗口收紧且全部可配**：`assist_asr_fast_confirm_sec` 1.15→0.45、`assist_asr_late_constraint_grace_sec` 1.2→0.35、`confirm` 0.45→0.3、组最长等待 1.2→0.8 | CoverDrive 端点融合状态机的分级判定（`endpointing.py`：语义 complete 600ms / definite 1000ms / neutral 1400ms） | 这两个 1.15s / 1.2s 原来是 `asr_state.py` 里的 **getattr 硬编码**，写进 config.json 也会被忽略，UI 没有入口 | 再省 ≈1.5s；且用户可自行调参 |
| 3 | **首字优先上屏**：LLM 流第一个清洗后的 chunk 立即广播（不再攒 5 个）；流式清洗尾巴 64→24 字符，首次上屏等一个句末/换行边界 | CoverDrive `response.output_text.delta` 到达即发，零批次缓冲 | 首字可见额外等了 5 个 token + 64 字符（中文 ≈40 token，1~2s） | 首字可见提前 ≈1~2s |
| 4 | **自适应噪声底 VAD**：门限 = max(`silence_threshold`, 噪声底×10^(margin/20))，开口后门限×0.65；噪声底只跟踪"不够响"的帧、开口期间冻结 | CoverDrive Silero/WebRTC 端点的双门限 + 自适应噪声底（`endpointing.py:131-140`、`app/vad.py:101-125`） | 固定 0.01 在会议室/风扇/键盘声下要么误切、要么把轻声句尾吃成静音（日志里"擦除"被切成"除"） | 断句更稳，减少半句截断 |
| 5 | **中文热词修复**：`build_tech_hotwords` 不再只保留含 ASCII 字母的词；FunASR 热词预算 400→600 字符 | CoverDrive 的领域词/对话上下文偏置（`app/asr.py` `AsrContextHistory`） | 原来「高并发 / 缓存穿透 / 消息队列 / 分布式事务 / 主从复制」这类最需要纠正的**中文**技术词全被过滤掉 | FunASR 术语识别直接受益 |
| 6 | **ASR 对话上下文注入**：最近 4 段已确认转写（≤600 字）喂给下一段识别——豆包走 `corpus.context`（`dialog_ctx` JSON 字符串）、通用 ASR 走 `prompt` 字段、Whisper 拼进 `initial_prompt`、FunASR 抽技术词追加热词 | CoverDrive `corpus.context` 对话上下文注入 | 同一个术语这场面试里一会儿对一会儿错（同音词前后不一致） | 连续对话的术语一致性提升 |
| 7 | **问句判定精度**：裸「说 / 讲 / 聊」不再算问句信号（必须"一下/下/叠词"），「实现/设计/优化/排查/处理」等陈述词移出强信号，新增祈使式出题（"设计一个…"） | CoverDrive `semantics.py` 的整句锚定规则（避免"对对，但是…"误判） | 日志里"然后我就跟他说"被当成问题自动作答；"我们实现了…"也会触发 | 减少答非所问/误答题 |
| 8 | **延迟账本**：`ASR_QUESTION lag_ms=`、`ANSWER_START enqueue_to_start_ms=`、`ANSWER_DONE first_token/total` | CoverDrive 遗留链路的延迟分解日志（`app/main.py:386-400`） | 之前只能靠猜是哪一段慢 | 每一段耗时都能量化，方便继续压 |

## 延迟账本（按真实日志估算）

改前（`log/interview.log` 实测：说完 → 首 token ≈5.7~6.2s，首字上屏 ≈6.7~8.2s）：

```
VAD 静音 1.0s → ASR 0.05~0.2s → 显示合并 1.2~2.0s → 问句确认 1.15s
→ 派发宽限 1.2s → LLM 首 token 0.6~1.2s → 首字上屏（5 chunk + 64 字尾缓冲）1~2s
```

改后（默认配置，预计）：

```
VAD 静音 1.0s → ASR 0.05~0.2s → 问句确认 0.3~0.45s → 派发宽限 0.35s
→ LLM 首 token 0.6~1.2s → 首字上屏（立即）≈0.1s
```

即**说完 → 首 token 约 2.2~2.7s、首字上屏约 2.3~2.8s**，比原来快 ≈3~5s。ASR 计算本身只占 0.05~0.2s，之前 75% 的时间都耗在固定编排等待上。

> 以上是代码常量 + 日志推算，不是真机实测。真实效果请用一场模拟面试复测（见下）。
> `silence_duration`（默认 1.2s）没有继续下调：它是准确率和延迟的平衡点，调太低会把一句话从中间切开。想更快可自行降到 0.8~1.0 并观察是否出现断句。

## 怎么验证 / 怎么调参

1. **跑测试**（无需音频硬件）：
   ```bash
   cd backend
   python -m pytest tests -q --ignore=tests/test_realistic_interview.py
   ```
   新增回归在 `tests/test_asr_latency_optimizations.py`。

2. **真机复测**：开一场模拟面试（系统音频或虚拟声卡），结束后看 `log/interview.log`：
   - `INTERVIEWER_ASR_SEGMENT queue_delay_ms=… stt=…ms`：音频排队 + ASR 计算耗时；
   - `ASR_QUESTION … lag_ms=…`：第一段识别落地 → 确认问句；
   - `ANSWER_START … enqueue_to_start_ms=…`：确认问句 → 开始生成；
   - `ANSWER_DONE first_token=…ms total=…ms`：LLM 首 token / 全文。

3. **可调参数**（`backend/config.json`，也可在设置中心改能暴露的那几项）：

   | 字段 | 默认 | 说明 |
   | --- | --- | --- |
   | `assist_asr_confirm_window_sec` | 0.3 | 最后一条追问后静默多久确认提交 |
   | `assist_asr_fast_confirm_sec` | 0.45 | 命中强问句信号后的快速确认窗口 |
   | `assist_asr_group_max_wait_sec` | 0.8 | 一个问句组从第一段起最长等待 |
   | `assist_asr_late_constraint_grace_sec` | 0.35 | 确认后等"迟到约束尾词"合并再派发 |
   | `assist_transcription_merge_gap_sec` | 0.9 | 显示区合并间隔（不影响答题判定） |
   | `assist_vad_adaptive` / `assist_vad_noise_margin_db` | true / 6.0 | 自适应噪声底 VAD 开关与门限抬升 dB |
   | `assist_asr_context_chars` | 600 | ASR 上下文注入字数，0=关闭 |
   | `silence_duration` | 1.2 | 断句静音秒数（准确率 ↔ 延迟的主要旋钮） |

   追求极限延迟：`silence_duration` 0.8 + `confirm` 0.2 + `grace` 0.2。
   追求稳定/嘈杂环境：`silence_duration` 1.5 + `noise_margin_db` 9 + `vad_adaptive` true。

## 没有做 / 不建议做的

- **换 Seeduplex 这类端到端语音模型**：等于换掉整条语音链路的供应商和协议，且面试辅助需要"可读的逐字文本答案"，与语音对话场景不同，不划算。
- **Silero VAD（ONNX）替换能量 VAD**：CoverDrive 的 legacy 链路用 Silero + 迟滞状态机，效果更好，但要引入 onnxruntime 依赖（安装包 +40MB）并为 96ms 帧/ LSTM 状态做适配；本轮先用"自适应能量门限"拿到大部分收益。可作为下一步。
- **豆包流式 partial**：CoverDrive 的"边说边出字"体验来自模型自带的 delta 事件。我们项目里的豆包引擎目前是"整段连发、只读最后一包"，中间结果被丢弃。改造成常驻流式会话是下一步收益最大的事（需要改动引擎接口 + 生命周期/重连），本轮未做。
- **LLM 首 token 对冲/多模型竞速**：SiliconFlow 上 DeepSeek V4-Flash 实测首 token 0.6~1.2s（长尾有 4s+），加对冲能压 p95，但会产生双倍 token 成本与"双答案"风险，建议先看延迟账本再决定。

## 改动文件

- `backend/api/assist/asr_state.py`：判定/显示解耦、确认窗口、延迟账本 meta
- `backend/api/assist/answer_worker.py`：首字立即上屏、`enqueue_to_start_ms` 日志
- `backend/api/assist/pipeline.py`：VAD 参数接线、ASR 上下文构造
- `backend/services/audio.py`：自适应噪声底 VAD
- `backend/services/stt/text_utils.py`：中文热词、上下文词提取、问句判定精度
- `backend/services/stt/engines.py`：四个引擎的 `context` 入参（豆包 corpus.context / 通用 prompt / Whisper initial_prompt / FunASR 热词）
- `backend/services/stt/factory.py`：`transcribe_with_fallback(..., context=)` + 旧签名兼容
- `backend/services/llm/prompts.py`：流式清洗首字优先
- `backend/core/config.py`、`backend/api/common/config_payload.py`、`backend/config.example.json`：新配置项与低延迟默认值
- `backend/tests/test_asr_latency_optimizations.py`：新增回归测试
