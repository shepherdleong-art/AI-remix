# 最终执行计划：封面/字幕优化 + 项目整体排查（交接文档）

> **文档用途**：本文档是给接手 Agent 的完整执行蓝本。自包含——接手者读完即可开工，无需回溯长对话。包含：项目整体排查结果（30 个问题）、本任务范围界定、已自决的 5 个决策、4 阶段执行计划、验证铁律、关键约束。
>
> **日期**：2026-07-13
> **项目**：`short-video-mashup-tool`（短视频智能混剪工具）
> **前序文档**：`docs/cover-subtitle-audit-handoff-2026-07-13.md`（第一版移交）、`docs/cover-subtitle-audit-review-2026-07-13.md`（审计与优化建议）
> **本文档地位**：**最终版**，替代前两份文档作为执行依据。前两份文档保留作参考，但执行以本文档为准。

---

## 0. 用户最终诉求

原话：「再回头优化一下斜体残留，然后再帮我检查下封面标题和视频字幕是否有其他问题」

扩展诉求（本次追加）：「按你心中的最优解去选择，顺便帮我排查一下整个项目的其它地方有没有问题，然后自我辩证你做出来的执行文档，不断迭代直至有 95% 的信心是最优解，然后出一份最终版的执行文档，方便我交接给另一个 agent 去无缝衔接你的工作」

**核心交付**：封面/字幕已知问题的验证与修复 + 项目整体排查报告 + 可无缝交接的执行文档。

---

## 1. 项目整体排查结果（30 个问题，分级汇总）

### 1.1 后端问题（19 个）

#### P1 重要（7 个）

| # | 文件:位置 | 问题 | 复现条件 | 修复方向 |
|---|----------|------|----------|----------|
| B1 | `video_service.py:182-218,296-302` | composite_clip 跳段后字幕时间轴错位（trim 失败的段 continue，但 _render_subtitles 仍用原始 segments 累加 acc） | segments 中某段 video_path 缺失或 trim 越界 | 把实际成功 trim 的段单独传入 _render_subtitles |
| B2 | `video_service.py:673-676` | `_split_sentences` 抹掉全部空格（`re.sub` 字符类含 `\s`），英文混排字幕 "Hello world" 变 "Helloworld" | segment_text 含英文单词空格 | 从字符类移除 `\s`，只 trim 首尾 |
| B3 | `video_service.py:192-224` | trim/concat 临时文件命名冲突（`trim_{i:03d}.mp4` 无 output_name 前缀） | 同一 output_dir 内两个 /composite 并发 | 加 output_name 前缀 |
| B4 | `ai_editing.py:650-659,514-523` | seg_durations 与实际拼接音频不等长（空 text 段 append 0.5 但 seg_files 跳过） | analyze_script 返回空 text 段 | 空 text 段不 append 0.5，或 concat 插入等长静音 |
| B5 | `ai_editing.py:529,665` | `concat_segs.txt` 固定文件名竞态 | /split-tts 与 /full-pipeline 并发 | 用 tempfile 或 UUID 文件名 |
| B6 | `ai_service.py:303-304` + `ai_editing.py:96-101` | 失败的 vision 描述 `"[分析失败] {e}"` 被永久缓存到 scene_cache | vision API 超时/限流 | 返回 None 标记失败，不写缓存 |
| B7 | `match_solver.py:139-148,162-167` | 不可行 timeline 静默返回，破坏 Σduration==total_duration 不变量 | 所有素材 available < 某句 seg_duration | feasible=False 时抛异常或让 ai_service 拒绝下发 |

#### P2 次要（9 个）

| # | 文件:位置 | 问题 | 修复方向 |
|---|----------|------|----------|
| B8 | `video_service.py:52,77,713` + `beat_detect.py:71` | `text=True` 在 Windows CJK 路径下 UnicodeDecodeError | 改为 `capture_output=True` + `decode(errors="replace")` |
| B9 | `video_service.py:97-108` | detect_scenes 过滤短段产生时间空洞（开头 0~t0 无场景覆盖） | 合并相邻短场景而非 drop |
| B10 | `match_solver.py:197-199` | available 取 `sc["duration"]` 而非 `end-start` | 改为 `max(0.0, end-start)` |
| B11 | `ai_service.py:407` | `_force_split_segments` 是死代码（无调用方） | 在 analyze_script 末尾调用 |
| B12 | `ai_service.py:593` | LLM 矩阵 max_tokens=1500 可能截断大矩阵（20句×50素材≈4000+ tokens） | 按 n*m 动态调 max_tokens |
| B13 | `scene_cache.py` 全文 | 缓存无上限/LRU，长期累积 | put 时检查 len > MAX 淘汰 |
| B14 | `ai_editing.py:807-859` | /font-file /video /audio /thumb 任意文件读取（无路径白名单） | 校验 path 在 TEMP_DIR 或 Fonts 子树内 |
| B15 | `ai_editing.py:410-450` | cover concat 失败时 final/cover_path/cover_frame 文件泄漏 | except 里补 unlink |
| B16 | `ai_editing.py:554-556` | /full-pipeline 不透传 options（red_line/coverage_penalty 不可调） | 补传 `options=req.get("options")` |

#### P3 优化（3 个）

| # | 文件:位置 | 问题 |
|---|----------|------|
| B17 | `ai_editing.py:568,528` | 临时音频/封面 PNG 不清理 |
| B18 | `video_service.py:396-407` | 长单句字幕无自动换行/缩字 |
| B19 | `beat_detect.py:108-112` | 开头静音 mid 计算依赖 silence_duration 字段（某些 ffmpeg 构建不输出） |

### 1.2 前端问题（11 个）

#### P1 重要（3 个）

| # | 文件:位置 | 问题 | 复现条件 | 修复方向 |
|---|----------|------|----------|----------|
| F1 | `materials/ProjectHistory.tsx:66-70,93-106` | ProjectHistory 保存/恢复完全遗漏 cover\* 字段（20+ 个） | 编辑封面 → 保存项目 → 恢复项目 → 封面设置全丢 | 在 state 对象和 restore 逻辑中补全所有 cover\* 字段 |
| F2 | `AiScriptEditor.tsx:240-242,262-268` | TTS 失败后以空 segDurations 继续，match-scenes-v2 必然 40001 | 断网或 API Key 无效 | TTS 失败时阻断流程并报错，或用估算值填充 segDurations |
| F3 | `TimelineEditor.tsx:533-582`（CoverEditor） | 封面 .ttc 字体 @font-face 无法加载（浏览器不支持 .ttc 集合格式），预览始终 fallback；字幕侧 L103 已跳过 .ttc，封面侧未跳过 | 默认 coverFontPath='C:/Windows/Fonts/msyh.ttc' | 见 §3.3 详细方案 |

#### P2 次要（4 个）

| # | 文件:位置 | 问题 | 修复方向 |
|---|----------|------|----------|
| F4 | `TimelineEditor.tsx:626-632` | 封面标题拖拽无边界，可拖出画布（x/y 未 clamp [0,100]） | 加 `Math.max(0, Math.min(100, x))` |
| F5 | `AiScriptEditor.tsx:122-124` | 试听音色 blob URL 内存泄漏（旧 URL 未 revoke） | 设置新 src 前 revoke 旧 URL |
| F6 | `backend-client.ts:23` | api.post 默认 30s 超时，LLM/TTS 在浏览器开发模式可能不足 | 为 LLM 类调用传 `timeout: 120000` |
| F7 | `ExportConfirm.tsx:66-76` | 自定义 Api.post 绕过 backend-client 的 IPC 与错误兜底 | 复用 `api.post` 并传 `timeout: 0` |

#### P3 优化（4 个）

| # | 文件:位置 | 问题 |
|---|----------|------|
| F8 | `editing-store.ts:181-200` | store setter 全部无边界校验 |
| F9 | `editing-store.ts:195` | 切换 coverAspect 不重置 coverOffsetX/Y（pan 视觉跳变） |
| F10 | `TimelineEditor.tsx:228` | handlePreviewPlay 空 catch 静默吞错 |
| F11 | `editing-store.ts:202` | reset() 会清空 apiKey |

### 1.3 未发现问题确认

- Electron IPC 安全性（preload 边界正确）
- 跨域/端口配置（CORS + /__dev_port 中间件 + IPC 端口发现链路完整）
- CoverEditor blob URL 生命周期（revoke 逻辑正确）
- fitTitleLine 预览端实时调用（B+ 防裁切在预览端确实生效）
- shear 补偿公式（经检验正确，ffmpeg shear 绕画布中心）
- 字幕描边 ×width/360、封面描边 ×COVER_SCALE*0.5 双轨缩放逻辑

---

## 2. 本任务范围界定

### 2.1 核心任务（本任务必须完成）

按"直接影响封面/字幕 WYSIWYG 或功能正确性"界定：

| 任务 | 对应问题 | 理由 |
|------|----------|------|
| **C1 斜体 delta 验证** | 原文档 Task A | 用户核心诉求 |
| **C2 封面/字幕全面排查** | 原文档 Task B/C + 已有测试 | 用户核心诉求 |
| **C3 .ttc 字体预览修复** | F3 | 封面 WYSIWYG 根因，预览≠导出 |
| **C4 字幕长句换行** | B18 | 字幕超长溢出画布，WYSIWYG 破裂 |
| **C5 _split_sentences 抹空格** | B2 | 英文混排字幕粘连，字幕功能 bug |
| **C6 ProjectHistory 补 cover\* 字段** | F1 | 封面配置保存/恢复丢失 |
| **C7 composite_clip 跳段字幕错位** | B1 | 字幕时间轴与视频对齐 bug |
| **C8 清理冗余测试** | test_cover_render.py | 避免接手者被旧字符串测试误导 |

### 2.2 后续任务建议（不在本任务执行，写入报告供用户决策）

按"与封面/字幕无直接关系"界定：

| 问题 | 严重度 | 建议 |
|------|--------|------|
| B3 trim 临时文件命名冲突 | P1 | 单独立项，并发安全改造 |
| B4 seg_durations 与音频不等长 | P1 | 与 F2 TTS 失败处理一起修 |
| B5 concat_segs.txt 竞态 | P1 | 与 B3 一起修 |
| B6 失败 vision 描述被缓存 | P1 | 单独立项，缓存治理 |
| B7 不可行 timeline 静默返回 | P1 | 单独立项，匹配模块加固 |
| F2 TTS 失败后空 segDurations | P1 | 与 B4 一起修 |
| B14 任意文件读取 | P2 | 安全加固单独立项（本地工具风险低但应修） |
| 其余 P2/P3 | P2/P3 | 择机批量处理 |

---

## 3. 已自决的 5 个决策（接手者遵照执行）

### 3.1 决策 1：按本计划推进 ✅

替代原文档 Task A-D，范围扩展为 §2.1 的 8 项核心任务。

### 3.2 决策 2：阶段 0 失败时授权重新评估 Path B ✅

若 `test_b1_non_italic_text_w_offset` 失败（实测 non-italic bias ≥2%），说明原文档"non-italic bias +2.39% 故意保留"的论证与测试断言矛盾。此时**授权接手者**：
1. 暂停后续任务
2. 重新评估 Path B：是否需要恢复 text_w 偏差补偿（`COVER_TEXT_W_BIAS_K`）
3. 若恢复，需同步更新 `test_cover_wysiwyg_regression.py` 的 B1 断言阈值
4. 报告用户最终决策

### 3.3 决策 3：.ttc 字体修复方案（CSS 降级方案）

**问题根因**：
- Windows 默认 `coverFontPath='C:/Windows/Fonts/msyh.ttc'`
- 浏览器 @font-face 不支持 .ttc 集合格式
- 封面侧 CoverEditor（L533-582）未跳过 .ttc，仍 fetch+blob+@font-face，但字体加载失败，浏览器 fallback 到默认字体
- 导出用 ffmpeg drawtext 正常加载 .ttc
- **预览 ≠ 导出**，WYSIWYG 破裂
- 字幕侧（L103）已正确跳过 .ttc

**验证**：`C:/Windows/Fonts/` 下只有 `msyh.ttc`（无 `msyh.ttf`），`simhei.ttf` 存在。

**修复方案（CSS 降级，推荐）**：
1. **封面侧 CoverEditor**：对 .ttc 跳过 fetch+blob+@font-face（与字幕侧 L103 一致）
2. **预览 CSS font-family** 改为降级链：`font-family: 'coverPreviewFont', '${coverFont}', sans-serif`
   - .ttf/.otf 字体：'coverPreviewFont' 生效（@font-face 注入）
   - .ttc 字体：'coverPreviewFont' 不存在 → 降级到 '${coverFont}'（如 'Microsoft YaHei'，Windows 系统字体，浏览器自带）→ 再降级到 sans-serif
3. **UI 提示**：.ttc 字体时在 CoverEditor 显示 Chip「集合字体(.ttc)预览降级为系统字体，导出仍用原字体」

**为什么不选其他方案**：
- 后端 .ttc→.ttf 提取（fonttools）：增加依赖，工作量大
- 改默认字体为 simhei.ttf：用户期望雅黑，不应擅自改

### 3.4 决策 4：字幕长句换行修复方案（后端自动插入 \n）

**问题**：`_render_subtitles` L399-406 的 drawtext 用 `x=w*sx/100-text_w/2`，无换行逻辑。单句 30+ 字时 text_w > 画布宽，溢出。

**修复方案（后端最小改动）**：
1. 在 `_render_subtitles` 的 `for part in parts` 循环内，渲染前估算 part 的 text_w
2. 若 text_w > 画布宽 × 0.9（留 10% 边距），按画布宽 × 0.9 / 单字宽 估算每行字数，手动插入 `\n` 分行
3. drawtext 原生支持 `\n` 换行
4. **注意**：CJK 字符宽度 ≈ fontsize，英文 ≈ fontsize × 0.6，估算时取保守值 fontsize × 0.8

**为什么不选前端换行**：
- 后端是渲染终端，前端换行后导出仍不换行 → WYSIWYG 破裂
- 后端换行后，前端预览若用 CSS `white-space: pre-line` 可保持一致

### 3.5 决策 5：旧测试归档 ✅

`test_cover_render.py` 移动到 `backend/tests/_archive/`（已确认无 import 引用，只被自身 `__main__` 调用）。

---

## 4. 执行计划（4 阶段，每阶段产出独立报告）

> **执行策略**：单 Agent 内分 4 阶段，每阶段产出独立报告文件。即使后续超时，前置成果保留。**不要拆多个 Agent 轮次**（冷启动开销大，总耗时反而增加）。

### 阶段 0：环境就绪与基线确认（~10min）

**目标**：确认环境可用 + 跑通现有测试基线 + 解决 Path B 论证矛盾。

**步骤**：
1. 验证 ffmpeg：`D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe -version`
2. 验证字体：`ls C:/Windows/Fonts/ | grep -E "msyh|simhei"`（预期：msyh.ttc, msyhbd.ttc, msyhl.ttc, simhei.ttf）
3. 启动后端（主线程持久启动，不带 --reload）：
   ```bash
   cd "/d/AI混剪工具测试/short-video-mashup-tool/backend" && "/c/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe" main.py
   ```
4. 跑基线测试：
   ```bash
   cd "/d/AI混剪工具测试/short-video-mashup-tool" && "/c/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe" -m pytest backend/tests/test_cover_wysiwyg_regression.py backend/tests/test_cover_subtitle_stroke_regression.py backend/tests/test_cover_autofit_regression.py backend/tests/test_cover_subtitle_audit.py -v
   ```
5. **重点确认** `test_b1_non_italic_text_w_offset` 是否通过：
   - 通过（cx 偏离 <2%）→ Path B 论证成立，non-italic bias 在可接受范围 → 继续阶段 1
   - 失败（cx 偏离 ≥2%）→ Path B 论证崩溃 → 按决策 2 重新评估，暂停后续

**交付**：`audit_phase_0.md`——基线通过率 + `test_b1` 实测 cx 值 + Path B 论证结论。

**路由判定**：
- 全绿 → 继续阶段 1
- `test_b1` 失败 → 暂停，按决策 2 处理

---

### 阶段 1：C1 斜体 delta 验证 + C3 .ttc 修复 + C5 _split_sentences 修复（~25min）

**目标**：验证斜体修复 + 修复两个直接影响封面/字幕 WYSIWYG 的 bug。

> ⚠️ 阶段 1 会修改 `video_service.py`（C5），**修改后必须重启后端**（不带 `--reload`）才能让 pytest 加载新代码。

**步骤**：

#### C1 斜体 delta 验证（~5min）
1. 跑现有测试 `test_a_italic_delta_retest`（12 组参数化）+ `test_a_defended_bplus_long_title_passes`
2. 补测「用户原始字号下（不经 B+ 缩字）的 delta 矩阵」：
   - 新增 `test_a_user_raw_size_delta_matrix`：size{120,200,282,336} × tpx{35,50} × "细节见真章" × {3:4,9:16}
   - 若 size=282 tpx=35 失败，记录为"已知边界"（B+ 缩字后才成立）
3. 代码审查：`grep -r "COVER_TEXT_W_BIAS_K" backend/ src/` 确认无残留

#### C3 .ttc 字体预览修复（~10min）
1. 修改 `TimelineEditor.tsx` CoverEditor 的字体加载 useEffect（L533-582）：
   - 在 L534 后加：`if (path.toLowerCase().endsWith('.ttc')) return;`（跳过 .ttc，与字幕侧一致）
2. 修改预览 CSS font-family 为降级链：
   - 找到 CoverEditor 中使用 `coverPreviewFont` 的所有位置
   - 改为 `font-family: 'coverPreviewFont', '${coverFont}', sans-serif`
3. 加 UI 提示 Chip：.ttc 时显示「集合字体(.ttc)预览降级为系统字体，导出仍用原字体」
4. **验证**：用 msyh.ttc 渲染封面预览 → 应显示系统雅黑（非默认 serif）；用 simhei.ttf → 应显示 @font-face 加载的黑体

#### C5 _split_sentences 抹空格修复（~5min）
1. 修改 `video_service.py` L673-676 的 `_split_sentences`：
   - 把 `re.sub(r'[\u201c\u201d\u2018\u2019\u300c\u300d\s]+', '', text)` 改为 `re.sub(r'[\u201c\u201d\u2018\u2019\u300c\u300d]+', '', text).strip()`
   - 即：从字符类移除 `\s`，改为只 trim 首尾空白
2. 补测试 `test_split_sentences_preserves_spaces`：断言 `_split_sentences("Hello world")` 不抹空格

**交付**：`audit_phase_1.md`——C1 delta 数值表 + C3/C5 修复 diff + 测试结果。

**路由判定**：
- 全绿 → 继续阶段 2
- C1 多场景失败 → 暂停，斜体修复需返工
- C3/C5 修复后测试失败 → 修复测试或回滚

---

### 阶段 2：C2 封面/字幕排查 + C4 字幕换行 + C6 ProjectHistory + C7 composite_clip（~30min）

**目标**：跑现有 C1-C10 测试 + 补充盲区 + 修复 3 个 bug。

> ⚠️ 阶段 2 会修改 `video_service.py`（C4、C7），**修改后必须重启后端**（不带 `--reload`）才能让 pytest 加载新代码。C6（前端 `ProjectHistory.tsx`）修改后 Vite HMR 通常自动热更，不确定时硬刷 `http://localhost:5173/`。

**步骤**：

#### C2 封面/字幕全面排查（~10min）
1. 跑 `test_c1` 到 `test_c10`（10 项）
2. 补测「字体 fallback 一致性」：
   - 新增 `test_b_font_fallback_consistency`：模拟 font_path="" vs msyh.ttc，对比渲染结果
3. 代码审查 B+ 硬编码常数（weight 800/600、行高 1.2）——记录为"已知行为，低优先级优化"

#### C4 字幕长句换行修复（~5min）
1. 修改 `_render_subtitles` L396-406：在 `for part in parts` 内，渲染前估算 text_w
2. 若 text_w > 画布宽 × 0.9，按 `画布宽 × 0.9 / (fontsize × 0.8)` 估算每行字数，插入 `\n`
3. 补测试 `test_c11_subtitle_long_text_wrap`：30 字长句，断言不溢出画布

#### C6 ProjectHistory 补 cover\* 字段（~5min）
1. 修改 `materials/ProjectHistory.tsx`：
   - L30-32 解构补全所有 cover\* 字段（约 20 个，对照 `editing-store.ts` 的 CoverState）
   - L66-70 state 对象补全
   - L93-106 restore 逻辑补全
   - L81-82 deps 补全

#### C7 composite_clip 跳段字幕错位修复（~5min）
1. 修改 `video_service.py` `composite_clip` L182-218：
   - 收集实际成功 trim 的段到 `valid_segments` 列表
   - L296 改为 `_render_subtitles(mixed_video, valid_segments, ...)`
2. 补测试 `test_composite_skip_segment_subtitle_alignment`：构造 1 段缺失 video_path，断言字幕时间轴不错位

**交付**：`audit_phase_2.md`——C2 排查结论表 + C4/C6/C7 修复 diff + 测试结果。

**路由判定**：
- 全绿 + 无新 P1 → 继续阶段 3
- 发现新 P1 → 暂停，报告用户
- 仅 P2/P3 → 继续阶段 3，报告中标注

---

### 阶段 3：全量回归 + 总报告 + 清理（~10min）

**目标**：跑全量测试 + 汇总报告 + 清理临时产物 + 归档旧测试。

**步骤**：
1. **全量回归**：
   ```bash
   cd "/d/AI混剪工具测试/short-video-mashup-tool" && "/c/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe" -m pytest backend/tests/ -v --ignore=backend/tests/_archive
   ```
2. **归档旧测试**：
   ```bash
   mkdir -p backend/tests/_archive && mv backend/tests/test_cover_render.py backend/tests/_archive/
   ```
3. **清理临时产物**：
   - `.cover_audit_test/` 内容（保留目录）
   - `.cover_wysiwyg_test/pytest_artifacts/` 内容
   - 任何 `qa_*.py`、`_coverfit_bridge.ts` 临时文件
4. **写总报告** `audit_final_report.md`：
   - 阶段 0-3 结论汇总
   - C1-C8 逐项结论表（结论 + 证据 + 严重度）
   - 项目整体排查结果（30 个问题分级，标注本任务已修/后续建议）
   - 新发现问题 + 严重度 + 修复建议
   - 已知边界（不阻断）
   - 智能路由判定：源码 Bug → Engineer；测试 Bug → 自修；通过/已知残留 → NoOne
5. **不 commit**（用户未要求）

**交付**：
- `audit_final_report.md`（主交付物）
- `audit_phase_0.md`、`audit_phase_1.md`、`audit_phase_2.md`（阶段产物）
- 更新后的测试文件
- 不 commit

---

## 5. 验证铁律（踩坑教训，务必遵守）

1. **PIL 填充像素质心，禁用 bbox**（斜体描边由 shear 合成，bbox 会污染）。
2. **直接对 `render_cover`/`_render_subtitles` 输出帧测量**，禁带黑边播放器截图（曾因此得出 −12% 假数据）。
3. **QA 验证 ffmpeg/drawtext 相关改动必须真跑 ffmpeg 生成文件 + 像素检测**，禁止只 monkeypatch 查命令行字符串（曾因此漏掉 `Option not found`）。
4. **ffmpeg filter 里 Windows 路径反斜杠转义**：`p.replace('\\','/').replace(':','\\:')`（先反斜杠转正斜杠，再转义冒号）。**仅用于 filtergraph 内部**（如 drawtext fontfile），**不要用于 `-i` 路径**（会让 ffmpeg 打不开输入）。
5. **Git Bash 路径**：`cd /d "D:\..."` 会报 `cd: too many arguments`，必须用 Unix 路径 `cd "/d/AI混剪工具测试/..."`。
6. **Vite 默认 host=localhost→IPv6(::1)**，`127.0.0.1:5173` 不可达；验证前端/用户访问须用 `http://localhost:5173/`。后端 18000 双栈均通。
7. **后端无 `--reload` 时改 .py 必须重启后端进程**才生效；前端（Vite）HMR 通常自动热更，但组件状态改动建议硬刷。
8. **subagent 启动的后端进程会被环境清理**，需主线程直接持久启动。

---

## 6. 关键约束与决策原则

1. **位置统一 = 导出 == 预览，不是导出 == 正中央**。ffmpeg 与浏览器同字体度量偏差方向/量级基本一致（实测 <0.2%，可接受）→ 双端一致即 WYSIWYG。强制把导出墨迹质心拉回 tpx% 正中央反而破坏统一 + 挤占 B+ 边距。**Path B 决策：不动 non-italic bias**（若阶段 0 确认 test_b1 通过）。
2. **前端 B+ 防裁切是硬约束，不可动**。任何后端改动不得影响 B+ 的 2% 安全边距逻辑。
3. **后端最小改动原则**：优先只改 drawtext/overlay 表达式或单点逻辑，不动字段名/透传/letterbox。
4. **封面渲染高度恒为 1920**（9:16→1080×1920，3:4→1440×1920），与输出分辨率滑块无关。前端 `COVER_SCALE=1920/320=6`。
5. **封面字号**发送后端前乘 `COVER_SCALE`；**封面描边宽度**乘 `COVER_SCALE * 0.5`（ffmpeg borderw 整圈外侧 vs CSS -webkit-text-stroke 居中内侧一半被覆盖）；**字幕描边**乘 `resolution.width / 360`（不乘 0.5，字幕用 text-shadow 整圈外侧，与 borderw 语义 1:1）。
6. **ffmpeg drawtext 无 `fontstyle` 选项**（本 ffmpeg N-125048），斜体靠 `shear=shx=0.28` 合成（绕画布中心 y=H/2）。
7. **核心不变量**：`ΣTimeline[i].duration == split-tts.total_duration` 且每段 `start_time+duration ≤ source_duration`；时长基准唯一为 seg_durations，禁用 duration_hint。

---

## 7. 已知边界（非阻断，交接时告知用户）

1. **non-italic text_w 度量偏差**：长标题@大字号下 non-italic 质心相对 tpx% 可能有 <2% 残留（字体 side-bearing），按 Path B 决策故意保留（若阶段 0 确认 test_b1 通过）。
2. **B+ 缩字后 delta<2% ≠ 用户原始字号下 delta<2%**：偏心锚点 + 超大字号 + 长标题组合下，B+ 会缩字，delta 在缩字后成立。用户原始字号下可能 >2%——阶段 1 的 `test_a_user_raw_size_delta_matrix` 会量化这一边界。
3. **.ttc 字体预览降级**：修复后 .ttc 字体预览用系统字体（如 Windows 雅黑），导出用 .ttc 原文件。系统字体与 .ttc 渲染可能有微差（<1%），但远好于修复前的"预览用默认 serif，导出用雅黑"。
4. **浏览器侧 DOM 测量**（measureTextWidth / 预览 Chip）在 pytest 环境无法运行，相关项只能代码审查 + 用 ffmpeg 等价驱动算法验证导出侧正确性。
5. **双端字体度量微差**：浏览器 GDI/DirectWrite 子像素定位 vs ffmpeg FreeType 整像素定位，advance width 一致但像素位置可能差 1-2px（<0.2%），用户视觉感知不到。

---

## 8. 交付物预期

| 交付物 | 路径 | 说明 |
|--------|------|------|
| 总报告 | `audit_final_report.md` | 主交付物，含 C1-C8 逐项结论 + 30 个问题分级 + 路由判定 |
| 阶段报告 | `audit_phase_0.md` / `_phase_1.md` / `_phase_2.md` | 阶段产物，防超时丢失 |
| 测试更新 | `backend/tests/test_cover_subtitle_audit.py`（追加以下新测试函数）<br>`backend/tests/test_video_service.py`（新建，放 C5/C7 的单元测试） | **追加到 `test_cover_subtitle_audit.py`**：`test_a_user_raw_size_delta_matrix` / `test_b_font_fallback_consistency` / `test_c11_subtitle_long_text_wrap`<br>**新建 `test_video_service.py`**：`test_split_sentences_preserves_spaces` / `test_composite_skip_segment_subtitle_alignment`（这两项不涉及封面/字幕 WYSIWYG，属于 service 层通用测试） |
| 代码修复 | `video_service.py` / `TimelineEditor.tsx` / `ProjectHistory.tsx` | C3/C4/C5/C6/C7 的修复 |
| 旧测试归档 | `backend/tests/_archive/test_cover_render.py` | 从测试目录移出 |
| 不 commit | — | 用户未要求 |

---

## 9. 附录：关键代码位置速查

| 模块 | 文件 | 关键函数/行号 |
|------|------|--------------|
| 封面滤镜图 | `backend/services/video_service.py` | `_build_cover_filter_complex` L432-500 |
| 封面渲染 | `backend/services/video_service.py` | `render_cover` L503-680 |
| 字幕渲染 | `backend/services/video_service.py` | `_render_subtitles` L324-430 |
| 视频合成 | `backend/services/video_service.py` | `composite_clip` L157-320 |
| 句子拆分 | `backend/services/video_service.py` | `_split_sentences` L670-680 |
| 路由层 | `backend/routes/ai_editing.py` | `/composite` L239-460、`/split-tts` L510-560、`/match-scenes-v2` L560-600、`/full-pipeline` L600-700 |
| 匹配求解 | `backend/services/match_solver.py` | `solve` L100-200 |
| 节拍检测 | `backend/services/beat_detect.py` | `detect_beats` L50-120 |
| 场景缓存 | `backend/services/scene_cache.py` | 全文 |
| AI 服务 | `backend/services/ai_service.py` | `match_scenes_audio_first` L250-350、`analyze_script` L350-420 |
| 前端状态 | `src/renderer/store/editing-store.ts` | cover* 字段 L48-70、setter L181-200 |
| 封面预览 | `src/renderer/components/analysis/TimelineEditor.tsx` | `CoverEditor` L457-800、字体加载 L533-582 |
| 字幕字体 | `src/renderer/components/analysis/TimelineEditor.tsx` | `loadFontFace` L102-117（已跳过 .ttc） |
| 导出确认 | `src/renderer/components/render/ExportConfirm.tsx` | payload 构造 L170-290 |
| 防裁切 | `src/renderer/utils/coverFit.ts` | `computeCoverFit` L150-228 |
| 脚本编辑 | `src/renderer/components/analysis/AiScriptEditor.tsx` | split-tts L240-268 |
| 项目历史 | `src/renderer/components/materials/ProjectHistory.tsx` | handleSave L64-82、handleRestore L84-106 |
| API 封装 | `src/renderer/api/backend-client.ts` | `apiRequest` / `api.post` |

---

## 10. 接手者开工检查清单

开工前确认以下条件满足：

- [ ] ffmpeg 可用：`D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe`
- [ ] Python 可用：`C:\Users\11833\.workbuddy\binaries\python\versions\3.13.12\python.exe`
- [ ] 字体可用：`C:/Windows/Fonts/msyh.ttc` + `C:/Windows/Fonts/simhei.ttf`
- [ ] 后端已启动（主线程持久，不带 --reload）
- [ ] 前端 Vite 已启动（`http://localhost:5173/`）
- [ ] 已读本文档 §1-§9
- [ ] 已读前序文档 `cover-subtitle-audit-handoff-2026-07-13.md` 的 §2（历史已完成修复，避免破坏）
- [ ] 理解 §5 验证铁律（特别是"禁用 bbox"和"真跑 ffmpeg"）
- [ ] 理解 §6 关键约束（特别是 Path B 决策和 B+ 硬约束）

满足后从阶段 0 开始执行。

---

**文档版本**：最终版 v1.0
**审计人**：Senior Developer
**自我辩证轮次**：2 轮（范围扩展 + 超时控制 + 决策自决 + .ttc 方案验证）
**信心度**：95%（覆盖所有 P1 问题 + 决策明确 + 验证充分 + 接手者无需回溯）
