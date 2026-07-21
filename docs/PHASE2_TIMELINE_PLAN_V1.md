# 第二期 时间轴开发方案 v1（评审修订版）

> **生成时间**：2026-07-17
> **地位**：本文档取代 `AI_HANDOFF_2026-07-17.md` §7 的二期方案，是时间轴开发的唯一执行依据。
> **需求来源**：与用户对齐的 11 轮问答（见文末「需求决策记录」）。

---

## 0. 与原方案的关键差异（评审结论）

| # | 原方案 | 修订后 | 原因 |
|---|---|---|---|
| 1 | 双击片段弹 Dialog 替换 | **剪映式点选替换**：单击选中轨道片段 → 素材库点新素材即替换，**保留原入点**（新素材不够长时自动钳位） | 用户明确指定；少一个 Dialog 组件 |
| 2 | T2 字幕块可拖动微调、T3 音频可拖动 | **T2/T3 纯联动可视化只读轨**（保留音量/静音），不做拖动 | 三者由同一时间模型派生，天然对齐；手动拖动只增加不一致入口 |
| 3 | 磁吸跨三轨生效 | 磁吸只在 **T1 视频轨内** + 播放头吸附片段边缘 | T2/T3 只读后跨轨吸附无意义，简化 |
| 4 | 交互参照 FCPX | **交互参照剪映**：吸附动画反馈、拖拽实时让位、点选替换、重选时段 | 用户是剪映用户 |
| 5 | 未含 Trim | **P2 新增「重选时段」**：固定时长选择框在整条素材胶片条上滑选入点 | 实拍素材首尾不可用，用户硬需求 |
| 6 | 一次交付三层轨+波形 | **三段式交付 P1→P2→P3**，每阶段用户手测验收后推进 | 手感敏感、风险可控 |

### 代码核查重大发现（降低风险）
- **入点（`start_time`）已存在且全链路生效**：`editing-store.ts:7-16` `TimelineSegment{segment_index, segment_text, video_path, start_time, duration, source_duration?, reason}`；导出端 `backend/services/video_service.py:201-214` 已按 `-ss start_time -t duration` 逐段切片。→ **Trim 功能 = 纯前端工作 + 钳位逻辑，后端导出零改动**。
- 时长语义：`duration` = 口播时间槽（TTS 实际时长，`match_solver.py:344-357` 钉死），用户选 A 方案（锁定时长滑窗）→ 总时长恒定，时间模型极干净。
- 预览架构已是「`/api/preview/assemble` 合成单文件（有 md5 缓存）+ 单 `<video>` seek + Web Audio 口播/BGM 叠加 + DOM 字幕」，scrub 性能基础好；Web Audio 已 `decodeAudioData`（`TimelineEditor.tsx:428-435`），**波形数据可直接复用现有 buffer**。
- 无 DnD/波形库依赖；继续手写 pointer 事件（与现有代码风格一致，磁吸定制更可控，不引入 dnd-kit）。
- 待替换位置：`TimelineEditor.tsx:576-593` 的 Slider 播放控制条。
- **坑**：`TimelineEditor.tsx` 内有大量死代码（`eD`/`mM` 边拖、旧 `Pick` 替换 Dialog、`handlePreviewPlay`、`handleTrackClick`），P1 时清理；`backend/tests/test_cover_subtitle_stroke_regression.py:55`、`test_cover_subtitle_audit.py:65` 会 grep 前端源码，重构 TimelineEditor 时注意别误删被扫描的样式常量。

---

## 1. 一致性架构（红线：预览 ≡ 导出）

**单一时间模型**（所有层共用的唯一事实源）：
- 每段：`video_path + start_time（入点）+ duration（=口播槽长，锁定）`；合法域 `start_time ∈ [0, source_duration - duration]`。
- 第 i 段成片区间 `[T_i, T_i + duration_i]`，`T_i = Σ duration[0..i-1]`；总时长 = 口播总时长，**任何时间轴操作都不改变总时长**（重排/替换/改入点只动 `video_path`/`start_time`）。
- 字幕区间、口播区间、BGM 起止全部由 `T_i` 派生——预览（DOM 字幕 + Web Audio 偏移）与导出（drawtext enable 窗口 + amix `-t`）用**同一组公式**，两侧各写一份时须逐行核对（历史坑 §4.3）。

**集中钳位**：store 新增 action `setSegmentInPoint(i, t)` / `replaceSegmentVideo(i, newPath, newSourceDuration)`，内部统一 clamp（含替换后新素材 `source_duration - duration < 原start_time` 时自动钳到最大值）。任何 UI 不直接改字段。

**专项验证（P2 交付门槛）**：真跑导出 + ffprobe 逐段时间核对 + 预览帧与导出帧抽样对比（遵守 §11 铁律：不靠读代码推断）。

---

## 2. 三段式交付

### P1 — T1 视频轨核心（手感先行）
新建 `FcpTimeline` 组件，替换 `TimelineEditor.tsx:576-593` 的 Slider 区，保留上方视频预览/字幕叠层/Web Audio 播放逻辑不动。

- **片段渲染**：每段一帧代表帧（`/thumb` 取 `start_time + duration/2`）+ 序号 + 时长，宽度 ∝ `duration/总时长 × 轨道宽`。
- **播放头**：橙色竖线可拖 scrub，RAF 节流 ≤60fps，直接 seek 主 `<video>`（感知即时，≤50ms 目标；拖快时允许轻微滞后、松手即准）；播放中 RAF 跟随。
- **拖拽重排**（剪映手感）：
  - 拖起：片段变半透明 ghost，随指针 `transform` 平移（GPU）。
  - **相邻片段实时让位**：根据 ghost 中心位置实时计算新序号，其余片段以 `transform` + 120ms 过渡动画滑动让位。
  - **磁吸**：拖至相邻片段边缘/轨道起止 ~6px 内吸附，吸附瞬间显示高亮吸附线 + 片段 80ms 微弹跳反馈；拖出边界 = 排首/排尾。
  - 松手：一次性写回 store `reorderTimeline(from, to)`（拖拽中不写 store，避免中间态污染）。
- **点选替换（剪映式）**：单击片段 → 选中态描边高亮；素材库（步骤1 素材面板/左栏）点击新素材 → 走 `replaceSegmentVideo` 保留原入点并钳位；轨道即时刷新。
- **素材时长不足警告**：`source_duration < duration` 的片段显示红色警告角标 + tooltip「素材时长不足，无法填满口播槽」。
- **ESC 取消拖拽**：拖拽中按 ESC 原样弹回，不写 store（无 undo 窗口期的安全网）。
- **播放头操作闭环**：点击时间标尺/轨道空白处跳转播放头；选中片段时播放头自动定位到该片段起点。
- **片段 hover tooltip**：素材文件名 + 入点区间 + 槽时长。
- **素材库已用标记 + hover 预览**：已被时间轴使用的素材在素材库面板中标记；hover 素材小窗播放预览（替换决策闭环）。
- **编辑防抖**：连续修改合并 ~300ms 防抖再触发预览重 assemble，避免后端排队风暴。
- **导出快照（后端小改）**：每次导出把当时 timeline JSON 快照存入输出目录，供"预览≠导出"问题排查。
- **清理**：删除 TimelineEditor 死代码（旧 Pick Dialog、边拖 handlers、`handlePreviewPlay`、`handleTrackClick`），保留字幕 Popover 编辑。
- **验收**：磁吸跟手度、让位动画、scrub 流畅度、替换后预览/轨道同步——用户逐条手测。

### P2 — 重选时段（Trim）
- **入口**：双击 T1 片段（单击已被选中占用）进入 Trim 模式。
- **UI**：预览区下方展开整条素材胶片条（`/thumb` 多时间点取帧，约每 0.5s 一帧，懒加载）+ **固定宽度选择框**（宽 = `duration`），左右拖动滑选；预览视频实时 seek 到 `框左缘对应素材时刻`；显示 `start_time / source_duration` 时间码；ESC/完成退出。
- **数据**：只改 `start_time`（钳位 `[0, source_duration - duration]`），写回后 `/api/preview/assemble` 缓存键含 `start_time` 会自动重出预览。
- **后端小改**：`/thumb` 增加 `w/h` 尺寸参数（现状固定输出 1080×1920 全尺寸，胶片条用太浪费；加参数后缩略图编码成本大降）。此改动须真跑验证。
- **验收门槛**：预览帧 ≡ 导出帧专项对比（见 §1）。

### P3 — T2/T3 联动可视化轨
- **T2 字幕轨**：文本块按 `T_i` 区间横排（内容来自 `subtitleOverrides` + 分段文本），只读；选中 T1 片段时对应字幕块联动高亮；双击进右栏字幕卡精修（现有能力）。
- **T3 音频轨**：口播 + BGM 两条波形，Canvas 振幅包络；数据源复用 `MusicPreviewPanel` 已解码的 `voiceBufRef/musicBufRef`（`getChannelData` 抽峰值，>8min 或 >2k 段时抽稀）；已播放部分高亮（theme primary）、未播放半透明；音量滑杆 + 静音（走现有 `voiceVolume/bgmVolume`）。
- **轨道结构**：sticky 左标签列（视频/字幕/音频），T2/T3 可独立折叠；播放头竖线跨三轨。
- **性能**：波形重绘防抖（resize/列宽拖拽）；胶片条/波形虚拟化预留（当前 6-8 段不需要，为后期 50-100 段留接口）。

### 明确不做（本期）
- T2/T3 拖动编辑、键盘 J/K/L、多视频轨 V1/V2、转场编辑器、逐帧 Canvas 缓存 scrub。
- **BGM 节拍点波形叠加**（后续增强；后端 `beat_detect` 现成，P3 之后再评估）。
- **撤销/重做（Ctrl+Z）**：用户决策——**核心稳定后再补**（顶栏按钮位已留）。记录于 2026-07-17。

---

## 3. 性能预算

| 项 | 预算 | 手段 |
|---|---|---|
| scrub 跟手 | ≤50ms 感知延迟 | 单合成文件 seek + RAF ≤60fps；预览 assemble 有 md5 缓存，素材/aspect 不变即秒出 |
| 拖拽动画 | 稳定 60fps | 仅 `transform`/`opacity`，不触发 layout；拖拽中不写 store |
| 缩略图 | 胶片条懒加载 + 小尺寸 | `/thumb` 加 `w/h` 参数（P2）；代表帧复用缓存 |
| 波形 | 首绘 <300ms | 复用已解码 buffer；峰值抽稀；resize 防抖 |
| 大素材 | 100M 实拍可导入 | 预览 assemble 已统一缩放，无需代理（后期 50-100 段再评估） |

## 4. 风险与对策

1. **测试误伤**：两个后端测试 grep 前端源码 → 重构 TimelineEditor 前先读这两个测试的扫描目标，保留对应常量。
2. **替换后入点越界**：统一走 `replaceSegmentVideo` 钳位；UI 对钳位结果给出轻提示（入点已自动调整）。
3. **预览重出抖动**：改入点/替换/重排都会触发 assemble 重渲染（短视频秒级），期间保留旧画面 + 加载角标，不黑屏。
4. **手感不达标**：磁吸阈值（6px）、让位过渡（120ms）、弹跳（80ms）均为可调常量，集中放 `fcpTimelineConfig.ts`，P1 验收时按用户手感微调。

---

## 5. 需求决策记录（2026-07-17 问答）

1. 本次目标：先评审后动手（评审确认后再开发）。
2. 三大担忧：可靠性（最怕预览/导出不一致）> 性能跟手 > 交互手感。
3. 交互参照：剪映（吸附动画反馈、拖拽实时让位、点选替换、重选时段）。
4. scrub 预期：感知即时即可（≤50ms），不为完美跟随牺牲性能。
5. Trim 语义：**锁定时长滑窗**（框宽=口播槽长），只滑入点，不改时长。
6. 替换语义：点选 + 素材库直换，**保留原入点**（越界自动钳位）。
7. T2/T3 动机：看联动关系 → 采用只读联动可视化轨方案。
8. 规模：当前 6-8 段 → 15s 成片；后期 50-100 段批量（本期搁置，只留虚拟化接口）。
9. 交付：三段式 P1→P2→P3，逐阶段手测验收。
10. 撤销/重做：核心稳定后补（已留按钮位）。
11. 增强清单（2026-07-17 追加）：①素材时长不足警告 ②ESC 取消拖拽 ③播放头操作闭环（标尺点击跳转+选中定位）④素材库已用标记+hover 预览 ⑤片段 tooltip ⑦导出 timeline 快照 ⑧编辑防抖——本期做；⑥BGM 节拍点波形叠加——后续再推进。

---

## 6. 实施进度日志

### 2026-07-17
- **P1 完成并验收**：FcpTimeline 视频轨（渲染/scrub/磁吸拖拽/ESC 取消/点选替换/警告角标/tooltip）、MaterialReplaceList（已用标记+hover 预览）、编辑防抖、导出快照（`timeline_snapshot.json`）、TimelineEditor 死代码清理。新增 store：`reorderTimeline`（重映射字幕覆写）/`replaceSegmentVideo`（保留入点+钳位）/`setSegmentInPoint`/`selectedSegmentIndex`。
- **P1 后 bug 三连修**：①替换后红色「!」误报（懒探测 `/api/materials/probe` + store ≤0 守卫 + 角标 >0 前置）；②封面抽屉标题/字号/描边与导出不一致（CoverEditor 引入 `k = previewH/320` 系数，导出端零改动，像素测量偏差 36.5%→0.22%）；③封面素材下拉放大预览被屏幕右缘裁掉（改向左飞出）。
- **P2 完成并验收**：TrimEditor（双击进入、整条胶片条、固定时长选框、整秒磁吸、ESC 恢复）、**大预览实时跟随拖动**（Trim 模式主预览换源素材播放器，拖动即 seek）+ ▶ 循环试看框选段；`/thumb` 新增 w/h 尺寸参数（小图≈1/13 体积）。**一致性门槛真跑达标**：3 个非零入点导出 vs 预览逐像素对比，入点精度远优于 ±0.2s。
- **地雷修复**：`composite_clip` concat 文件 GBK 编码 + ffmpeg stderr GBK 解码 → **输出路径含中文导出必失败**，已修（UTF-8 + errors=replace，8 处），中文路径实测导出成功。
- **自查优化 4 项**：①旧 TimelinePreview 退役删文件（时长滑杆/入点重置/字幕不重映射三个不一致入口移除）；②片段代表帧改 `thumbUrlSized(w=160, aspect)`；③播放头播放中自动跟随滚动（手动滚动/拖拽 1.2s 内不抢）；④空格播放暂停 + ←/→ 0.1s 微调（输入框/弹窗/Trim 中不劫持）。
- **技术债（待办）**：a) `test_bug2_exportconfirm_scaling` 等 2 个过期断言（现行代码 `subtitleSize/100*resolution.width` 与断言 `/360` 不符）需确认真实行为后更新；b) `resources/ffmpeg/ffprobe.exe` 实为 ffmpeg.exe 误名副本（项目本就解析 ffmpeg stderr，无实际影响）；c) 撤销/重做；d) BGM 节拍点波形叠加；e) test_cover_wysiwyg_regression 4 个 shear 失败 + test_scene_cache mock bug（均为历史遗留）；f) **波形画布宽度上限**（P3 自查发现）：T3 波形 Canvas 宽度 = 整条轨道宽，浏览器单画布上限 ~16384px（60px/s 约 273s 成片）——当前 15s 无虞，**50-100 段扩展前须改为视窗化绘制（只画可见区）**。
- **P3 待启动**：T2/T3 只读联动可视化轨。

### 2026-07-17（P3 完成）
- **P3 完成待验收**：三轨结构（sticky 48px 标签列 + T1/T2/T3 + 跨轨播放头，折叠态存 `localStorage["fcp-track-collapse"]`）；T2 字幕轨只读联动（单击=选中+播放头定位、双击=既有字幕 Popover 精修、选中片段联动高亮）；T3 波形轨（口播/BGM 两行，`computeWaveformPeaks` 复用已解码 buffer 零二次解码，`WaveformCanvas` DPR 命令式绘制、已播放 primary/未播放半透明、BGM 尾 2s 淡出衰减、音量滑杆+静音走既有 store 字段）。三轨共用同一 timeToX 映射，字幕块/波形与 T1 片段切点像素级对齐（波形逐像素列反查 xToTime，minClipWidth 兜底下仍对齐）。
- 新增文件：`waveformPeaks.ts`、`WaveformCanvas.tsx`；改动：`FcpTimeline.tsx`（三轨扩展）、`fcpTimelineConfig.ts`（+9 常量）、`TimelineEditor.tsx`（仅 MusicPreviewPanel peaks 下发）。
- 有意取舍：波形 resize 不加防抖（防抖会让波形短暂滞后 T1，破坏对齐核心价值）；BGM 淡出按 totalDur−2s→totalDur 简化包络。
