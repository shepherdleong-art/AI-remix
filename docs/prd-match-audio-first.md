# 增量 PRD：音频优先混合匹配（Audio-First Match）

> 文档定位：**增量 PRD（仅描述本次变更，不重复既有功能）**。
> 适用项目：`short-video-mashup-tool`（短视频智能混剪工具，电商带货 15 秒短视频）。
> 技术栈：Electron 28 + React(TS) 前端 + Python FastAPI 后端。
> 涉及核心文件：`backend/routes/ai_editing.py`、`backend/services/ai_service.py`、`backend/services/video_service.py`。
> 版本范围：本次为 **V1 音频优先重构**；Hook-first 偏见、定格 Ken Burns 缓推**明确延后**（已记入项目工作日志，不在本 PRD 范围）。

---

## 0. 问题背景（已查证根因，作为本次重构出发点）

以下根因由主理人读代码确认，直接作为问题背景，不再质疑：

1. **素材用不尽**：`analyze_script()` 的 prompt 要求"拆分为 3-5 个语义片段"（见 `ai_service.py` L347），`match_scenes_to_segments` 让 AI 给每个片段挑**一个**最匹配场景（`best_scene` 单数，1:1 匹配，见 `ai_service.py` L507）。7 个素材（约 35s）最多只用 3-5 个，其余闲置。
2. **结尾冻结/素材不够**：匹配阶段在 TTS 之前，时长用的是 AI 猜的 `duration_hint`（`ai_service.py` L515 `seg.get("duration_hint", 3.0)`），而非真实口播时长。视频总长 = 各段猜值之和，几乎不可能等于真实音频时长；一旦小于真实音频，合成按 `-t audio_dur` 强制对齐 → 视频比音频短 → 结尾冻结（此前修过的 bug 真因之一）。
3. **边界不校验**：`ai_service.py` L520 `start_offset = sc.get("start", 0.0)` 不校验 `start + dur ≤ 素材真实长度`，溢出被 ffmpeg 截断 → 该段实际更短。

**已确定的解决方向**：音频优先混合匹配 — TTS 先跑 → 拿到每句真实时长与总时长 D → 仍做语义匹配挑片（语义匹配保留为"首选标准"）→ 时长钉死为真实口播值 + 边界硬校验（`start + dur ≤ 素材可用长度`）。

---

## 1. 产品目标

**一句话**：把"先匹配后配音"改为"先配音后匹配"，以真实口播时长为唯一时长基准，用约束求解器在硬边界下做素材最优分配，从构造上消除结尾冻结、并最大化素材利用率。

---

## 2. 用户故事

1. **作为剪辑师**，我希望导入的 7 个素材都能被合理使用而不是闲置，这样每条素材的采买/拍摄成本都摊薄到成片里。
2. **作为电商运营**，我希望成片结尾不再出现画面冻结或拉长，口播声音和画面切换严格对齐，观感更专业、完播率更高。
3. **作为重度使用者**，我希望反复调整素材/文案时，重复跑 vision 分析不额外花钱、不拖慢等待。

---

## 3. 需求池（P0 / P1 / P2）

> 每条均含：**是什么 / 为什么 / 验收口径**。优先级定义：P0=必须做（治本，V1 必交付）；P1=建议做（提质/省钱）；P2=锦上添花（可观测性）。

### P0

#### P0-1 约束感知分配（治本，必做）— 对应方案 A

- **是什么**：将语义匹配从"每片段挑 1 个 best_scene"改为"LLM 批量产出『每句话 × 每个素材』的语义相关分矩阵（API 成本不变）"，随后交由一个本地求解器（greedy 或匈牙利算法）在硬约束下做最优分配。硬约束：
  - 每句话分配到的素材「可用长度 ≥ 该句真实口播时长」；
  - 所有句分配时长之和**严格等于**总口播时长 D；
  - 每段 `start + dur ≤ 该素材真实可用长度`（边界硬校验）。
- **为什么**：真实口播时长在匹配前已由 TTS 拿到，时长不再靠 AI 猜测；求解器在约束下分配，从构造上消除"视频比音频短导致的结尾冻结"，并保证每段不越界。
- **验收口径**：
  - 给定 7 个素材(35s) + 口播(15s)，输出的 timeline 各段 `duration` 之和等于 `split-tts` 返回的 `total_duration`，误差 ≤ 1 帧（≈0.04s）；
  - 每段满足 `start_time + duration ≤ 素材可用长度`；
  - 最终合成视频时长 == 音频时长（无冻结、无黑场、无拉伸）；
  - LLM 调用次数不高于现有方案（相关分矩阵为单/少量批量调用）。

#### P0-2 素材覆盖最大化（治本，必做）— 对应方案 C

- **是什么**：在相关分矩阵上叠加「使用次数惩罚」：当不同素材的语义相关分差距不大时，优先选择使用次数少/未使用的素材，把 7 个素材尽量铺开。须设「语义相关分阈值红线」——低于红线的素材即使为了铺满也不得强制匹配（避免为铺满而错配）。
- **为什么**：直接治理"素材没用尽"。在语义质量可控的前提下，提升素材利用率。
- **验收口径**：
  - 在语义相关分差距 ≤ 设定阈值的候选里，分配结果优先命中未使用/少使用素材；
  - 若所有素材相关分均低于红线，则该句回退到"最高相关分素材"（仍受边界硬校验约束），不因覆盖最大化而错配；
  - 同批素材总量远大于口播时长时，最终被使用的素材数量 ≥ 既有方案的素材数量，且等于或趋近"在红线约束下能铺开的最大值"。

#### P0-3 TTS 前置到匹配之前（流程改造，必做）

- **是什么**：调整流水线顺序，在「匹配」步骤之前先执行 TTS（复用既有 `/split-tts` 端点），把每句真实 `seg_durations` 与 `total_duration` 注入匹配环节；`/composite` 改为复用已生成的音频（经 `existing_audio_path` 传入），不再重新生成 TTS。
- **为什么**：现有顺序里 TTS 在 `/composite` 才生成，而新方案要求匹配前已有真实每句时长，否则无法做约束分配。
- **验收口径**：
  - 新的端到端编排顺序为：分析文案 → 分析视频 → **分句 TTS（得真实时长）** → 匹配 → 合成（传已有音频）；
  - 匹配环节的输入**必须**包含真实 `seg_durations`，不得再依赖 `duration_hint` 作为时长基准；
  - `/composite` 在收到 `existing_audio_path` 时不调用 TTS（`text_to_speech`），直接复用该音频完成合成。

### P1

#### P1-1 节拍切点（提质，建议做）— 对应方案 B

- **是什么**：TTS 先跑后音频已在手，用 `ffmpeg silencedetect` 免费检测口播气口（静音段），把画面切点吸附到自然停顿点（±0.2s 容差）。纯本地 ffmpeg，零额外 API 成本。
- **为什么**：在"时长钉死真实口播值"的基础上，让切换点落在人声停顿处，观感更顺。
- **验收口径**：
  - 切点时间相对最近检测到的静音中心偏移 ≤ 0.2s；
  - 切点吸附不改变各段时长之和（仍严格 = D），仅移动切点位置；
  - 无 ffmpeg 调用失败（silent detect 参数健壮，音频无静音时回退到均匀切点）。

#### P1-2 场景描述缓存（省钱，建议做）

- **是什么**：vision 分析最贵，按「视频路径 + 修改时间(mtime) + 帧序号 + prompt」哈希缓存场景描述；同批素材重跑（如仅改文案、未换素材）免费命中缓存。
- **为什么**：vision 是成本与耗时大头，素材不变时无需重复分析。
- **验收口径**：
  - 同一素材（路径+mtime 不变）二次 `/analyze-video` 命中缓存，不发起 vision API 调用；
  - 素材被修改（mtime 变化）或帧/参数变化后缓存失效，重新分析；
  - 缓存命中时返回结果与首次一致（可比对 description 文本）。

### P2

#### P2-1 可观测性 / 日志（锦上添花）

- **是什么**：匹配与合成环节输出「最终时间轴 + 每片来源 + 每段时长与来源素材关系 + 覆盖统计（用了几个素材/总素材数）」，便于排查。
- **为什么**：新分配逻辑较旧 1:1 匹配更复杂，需可审计的时间轴追踪。
- **验收口径**：
  - `/match-scenes-v2` 返回中附带 `debug` 字段：每段的 `source_video`、`start_time`、`duration`、命中线/惩罚说明、整体 `used_materials / total_materials`；
  - `/composite` 日志打印"输入总时长 vs 音频时长"的一致性校验结果。

---

## 4. 关键流程与接口影响

### 4.1 新步骤顺序（音频优先）

```
① POST /analyze-script      → segments [{index, text, keywords, duration_hint}]   （既有，不变）
② POST /analyze-video       → scenes [{description, video_path, start, end, duration}]  （既有；P1 加缓存）
③ POST /split-tts           → { audio_path, total_duration(D), seg_durations[] }   （既有端点，提前到匹配前）
   [P1] POST /detect-beats   → { beats:[{time, score}] }                            （新增，可选）
④ POST /match-scenes-v2     → timeline [{segment_index, video_path, start_time, duration(真实), ...}]  （新增）
⑤ POST /composite           → final.mp4  （既有；传 existing_audio_path，不再生成 TTS）
```

> 注意：`/split-tts` 现有实现已返回 `seg_durations` 与 `total_duration`（`ai_editing.py` L549-553），本次**直接复用**，无需新增 TTS 端点，仅调整其在流程中的调用时机。

### 4.2 需要新增 / 调整的端点与编排

| 端点 | 动作 | 说明 |
|---|---|---|
| `/match-scenes-v2`（**新增**） | 新增 | 音频优先匹配入口。入参：`segments` + `seg_durations`（来自 split-tts）+ `scenes`（来自 analyze-video）+ `api_key` + 可选 `beat_points`（来自 detect-beats）。内部：① LLM 产出相关分矩阵；② 本地求解器（A）做约束分配 + 覆盖最大化（C）+ 边界硬校验；③ 可选按节拍切点（B）吸附。返回 `timeline` + `debug`（P2）。 |
| `/match-scenes`（既有） | 兼容保留 / 暂不改 | 旧 1:1 匹配逻辑保留，供回退与 A/B 对比。是否下线见"待确认问题"。 |
| `/detect-beats`（**新增，P1**） | 新增 | 入参 `audio_path`（来自 split-tts）；用 `ffmpeg silencedetect` 返回静音气口时间列表。供 match-scenes-v2 吸附切点。 |
| `/composite`（既有） | 小改 | 已支持 `existing_audio_path`（L154）；需确保编排层在 V1 流程中**始终**传入 split-tts 的 `audio_path`，避免重复生成 TTS。 |
| `/analyze-video`（既有） | P1 加缓存 | 在 `analyze_frames_batch` 前按 `md5(video_path + mtime + frame_index + prompt)` 查缓存，命中则跳过 vision 调用。 |
| `/full-pipeline`（既有） | 调整编排 | 原 Step3 匹配、Step4 TTS 的顺序需改为"TTS 先 → 匹配后"；内部同样走 v2 分配逻辑。（注：当前 full-pipeline 内部调用 `match_scenes_to_segments` 时参数传参存在既有 bug，本次重构一并理顺。） |

### 4.3 前端编排影响

- **步骤顺序/UI**：前端"AI 混剪"向导当前顺序为 分析文案 → 分析视频 → 匹配 → 合成。需把"生成配音/分句 TTS"这一步**显式前置**到"匹配"之前（可复用既有"配音"能力）。若 UI 有步骤文案（如"③ AI匹配画面"），建议同步提示"已基于真实口播时长智能匹配"。
- **状态流转**：匹配环节的输入需要从 split-tts 结果里取 `seg_durations`/`total_duration`；合成环节需要把 split-tts 的 `audio_path` 透传给 `/composite`。
- **可降级**：若用户选择"快速模式"仍可用旧 `/match-scenes`，但默认走 v2。

### 4.4 数据契约要点（供架构师参考，非实现代码）

- `split-tts` 输出：`audio_path`（拼接后完整音频）、`total_duration`（= Σ seg_durations）、`seg_durations`（按 segments 顺序的每句真实秒数）。
- `match-scenes-v2` 入参：除既有 `segments`、`scenes` 外，新增 `seg_durations`（List[float]，长度 = segments 数）、可选 `beat_points`（List[float]）。
- `match-scenes-v2` 输出 `timeline` 每项：`segment_index`、`video_path`、`start_time`、`duration`（= 该句真实口播时长，非 duration_hint）、`source_duration`（素材真实可用长度）、`used_scene_index`、可选 `snapped_beat`（B 命中）。
- **关键不变量**：`Σ timeline[i].duration == split-tts.total_duration`，且对每段 `start_time + duration ≤ source_duration`。

---

## 5. 待确认问题（需用户 / 架构师拍板）

1. **语义相关分阈值红线取多少？**（P0-2 红线）建议初值如 0.35（0-1 标度）或相对最大值 60%，需结合实测样例标定，避免错配或过度保守。
2. **覆盖最大化惩罚系数 / 候选窗口**：语义分"差距不大"的判定阈值（如差 ≤ 0.1 视为可替换）与惩罚权重，需架构师给出初版参数，后续用样例调。
3. **是否保留旧 `/match-scenes` 兼容？** 建议保留为"快速模式/回退"，但默认走 v2；是否择期下线需确认。
4. **`analyze-script` 的粒度要不要放宽？** 当前强制"3-5 段"，而求解器在更细粒度（如每句 / 5-8 段）下有更多分配单元、覆盖率更高。是否把 prompt 改为"按语义自然断句，5-8 段"需确认（仍属语义匹配，不违背"语义匹配为首选标准"）。
5. **求解器选型**：greedy 是否足够，还是需用匈牙利/最小费用流以保证全局最优？建议先 greedy + 局部回退，复杂场景再升级；请架构师评估。
6. **前端步骤 UI 是否改文案？** 是否要把"匹配"步骤提示为"基于真实口播时长智能匹配"，以及是否在 UI 展示"已使用 N/7 个素材"的覆盖反馈（P2 可视化）。
7. **缓存介质**：场景描述缓存落本地文件还是 SQLite？需与现有 TTS 缓存（按 md5 落盘，见 `generate-tts`）保持一致风格。
8. **`/full-pipeline` 既有传参 bug**：是否在此次重构中一并修复（理顺为 v2 编排），还是仅新增端点、pipeline 暂不动？

---

## 附：V1 范围外（已延后，仅记录）

- Hook-first 偏见（首 1-3s 用最抓眼素材）。
- 定格时 Ken Burns 缓推（长片定格避免显死）。
- 上述两项用户感兴趣但同意 V1 先不做，已记入项目工作日志待后续提醒。
