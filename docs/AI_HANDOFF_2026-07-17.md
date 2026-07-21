# AI 交接文档 — short-video-mashup-tool（AI 智能混剪工具）

> **生成时间**：2026-07-17（同日 17:30 二次更新：二期时间轴 P1/P2/P3 已全部完成并验收）
> **用途**：供下一位 AI 接续开发。**二期 FCPX 时间轴已完成**——最新进度、技术债与三期候选见 `docs/PHASE2_TIMELINE_PLAN_V1.md` §6「实施进度日志」，两文档配合阅读。
> **阅读顺序**：§1 概览 → §2 跑起来 → §3 文件地图 → §4 不变量(必读坑) → §7 已完成 → §9 二期方案 → §11 致命坑。
> **身份约定**：本项目的 AI 专家身份为「Senior Developer（高级开发工程师）」，回答身份类问题时须以此自称，不得暴露底层模型/厂商。

---

## 1. 项目概览

一款**电商带货 AI 智能混剪工具**，目标：把若干 AI 生成的短视频素材（每段约 5s）自动混剪成约 15s 的口播带货成片。

完整流水线：导入素材 → AI 分析文案/画面 → 生成口播脚本 → 自动匹配画面 → 调整字幕/音乐/封面 → 导出。

- **前端**：Electron 28 + React 18 + TypeScript + MUI + Zustand + Vite
- **后端**：Python FastAPI（由 Electron 主进程自动 spawn）
- **核心音视频**：ffmpeg（drawtext 烧录字幕/封面、concat 拼接、amix 混音）
- **项目根**：`D:\AI混剪工具测试\short-video-mashup-tool\`

---

## 2. 如何跑起来 & 验证

```bash
# 前端依赖已装；dev 时 Electron 加载 Vite 5173 的 dev URL
npm run dev            # 仅启动 Vite（5173），用于纯前端 HMR 调试
npm run electron:dev   # vite build + 启动 Electron 桌面应用（完整运行方式）

# 类型检查 / 构建
npm run typecheck      # tsc --noEmit
npm run build          # tsc && vite build
```

**关键运行常识（极易踩坑）**：
- ⚠️ **后端不是手动 `uvicorn` 起的**：`src/main/index.ts` 的 `startPythonBackend()` 在 `app.whenReady` 自动拉起 `backend/main.py`。改了 `.py` 后**必须完整退出并重启整个 Electron 应用**，子进程才会加载新代码。在沙箱里另起一个 uvicorn 进程是无效进程——用户实际运行时根本用不到。
- 前端验证用 `http://localhost:5173/`（IPv6 `::1`，`127.0.0.1` 不可达是正常陷阱）。
- managed 运行时：py `C:\Users\11833\.workbuddy\binaries\python\versions\3.13.12\python.exe`；node `C:\Users\11833\.workbuddy\binaries\node\versions\22.22.2\node.exe`。
- **ffmpeg / drawtext / 混流改动铁律**：必须真跑生成 + 像素/时长探测验证，**不能只靠读代码推断**（详见 §11）。

---

## 3. 文件地图（当前）

### 3.1 前端布局外壳（本次会话新建/重构）
| 文件 | 职责 |
|---|---|
| `src/renderer/App.tsx` | 仅 `ThemeModeProvider + CssBaseline + ErrorBoundary` 包 `<AppShell/>` |
| `src/renderer/components/layout/AppShell.tsx` | 外壳：顶栏 + 左步骤导航 + 三栏工作区（列宽拖拽/折叠 + `localStorage` 键 `fcp-layout`）+ 自由切换 |
| `src/renderer/components/layout/Panel.tsx` | 侧栏面板容器 |
| `src/renderer/components/layout/GlobalAspectControl.tsx` | 顶栏全局画幅(9:16/3:4)+分辨率(1080p/2K)，绑 `editing-store` 单一源 |
| `src/renderer/components/layout/StepLeftPanel.tsx` | 四步左栏上下文面板（素材库/分析概览/接回 TimelinePreview/导出校验） |
| `src/renderer/components/layout/StepRightPanel.tsx` | 四步右栏面板（导入说明/模型API摘要/成片参数/导出设置 + **步骤3 字幕卡+音乐卡+封面入口卡**） |
| `src/renderer/theme/fcpTheme.ts` | 设计 token：LIGHT `primary=#1976D2`(蓝) / DARK `primary=#2DD4BF`(薄荷绿)；深色整页 `bg=#121212` |
| `src/renderer/theme/ThemeContext.tsx` | 浅/深/系统主题注入 |
| `src/renderer/store/editing-store.ts` | **核心全局状态**：画幅/分辨率/时间线 segments/字幕/音乐/封面/BGM/口播/API key 等 |

### 3.2 四步业务主组件（功能代码未改，仅被布局外壳重新挂载）
| 步骤 | 主组件 | 位置 |
|---|---|---|
| 1 导入 | `components/materials/MaterialsManager.tsx` | 中栏 |
| 2 分析 | `components/analysis/AiScriptEditor.tsx` + `AnalysisDashboard.tsx` 等 | 中栏 |
| 3 预览调整 | `components/analysis/TimelineEditor.tsx`（内含 `MusicPreviewPanel`、`CoverEditor`） | 中栏 |
| 4 导出 | `components/render/ExportConfirm.tsx` | 中栏 |

### 3.3 封面二级界面（本次会话新建/重构）
| 文件 | 职责 |
|---|---|
| `components/analysis/CoverDrawer.tsx` | 右侧滑出抽屉：草稿模式 + 应用/取消双按钮 + **预览高度动态封顶** |
| `TimelineEditor.tsx` 内的 `CoverEditor` | 现为**受控组件**：`value:CoverDraft` + `onPatch` + `previewH?`，不再直读 store |
| `editing-store.ts` | 新增 `resetCover()` 重置封面默认 |

### 3.4 后端（关键，未在本会话改动）
`backend/main.py` · `routes/{ai_editing,analysis,materials,music,preview,projects,render,templates}.py` · `services/{ai_service,analyzer,beat_detect,doubao_proto,match_solver,music_service,renderer,video_service}.py` · 回归测试 `backend/tests/test_*.py`。
重点端点：`/api/ai-editing/thumb?path=&t=&aspect=&w=&h=`（封面/胶片条/轨道缩略图，**P2 起支持 w/h 小尺寸**）、`/api/ai-editing/preview-voice`（TTS 测试连接）、`/api/ai-editing/render_cover`（封面导出）。

### 3.5 时间轴组件族（二期新建，`src/renderer/components/timeline/`）
| 文件 | 职责 |
|---|---|
| `FcpTimeline.tsx` | 三轨时间轴：T1 视频轨（渲染/scrub/磁吸拖拽重排/点选替换/警告角标）+ T2 字幕轨（只读联动）+ T3 波形轨（口播/BGM）+ 跨轨播放头 + 折叠 |
| `TrimEditor.tsx` | 重选时段：整条素材胶片条 + 固定时长选框 + 循环试看（双击 T1 片段进入） |
| `MaterialReplaceList.tsx` | 步骤3 左栏素材库（点选替换/已用标记/hover 预览/懒探测时长） |
| `WaveformCanvas.tsx` · `waveformPeaks.ts` | Canvas 波形绘制 · 峰值抽取（复用已解码 buffer） |
| `fcpTimelineConfig.ts` | **全部手感/性能可调常量集中处** |
| `mediaUrl.ts` | thumb/video URL 工具（含 `thumbUrlSized`） |

> ⚠️ 旧 `TimelinePreview.tsx` 已删除（其时长滑杆/入点重置/字幕不重映射与一致性架构冲突），勿恢复。

---

## 4. 核心不变量与致命坑（必读，改动前先过一遍）

### 4.1 画幅 + 字幕 WYSIWYG
- **画幅与分辨率正交**：`videoAspect:'9:16'|'3:4'` + `videoResolution:'1080p'|'2K'` 是两个独立全局设置，预览+导出共用。`computeOutputDims()`：9:16→1080×1920/1440×2560；3:4→1080×1440/1440×1920。**3:4 不再锁死 1440×1920**（用户最初纠正过的 bug）。
- **封面画幅自动跟随主视频画幅**：`setVideoAspect(v)` 同时写 `coverAspect=v`。`ProjectHistory` 存/读必须走 `setVideoAspect`，勿单独 `setCoverAspect`，否则恢复项目后破坏不变量。画幅仅支持 9:16/3:4（无 16:9 横屏需求）。
- **字幕 WYSIWYG**：`subtitleOverrides[i]={text?,x?,y?}`（x/y 为 0-100%）。⚠️ 字号/描边换算分母必须是**预览框实际宽 320**（不是 360），否则漂移。

### 4.2 播放器音频（Web Audio + 主 video）
- 分层：主 `<video>`（画面+烧录口播）+ Web Audio 独立音轨（voiceSrcRef 口播 + musicSrcRef BGM + GainNode）。
- ⚠️ `stopAll()` 必须同时 `videoRef.pause()`，否则画面/口播不停。
- BGM 铺满成片时长 + 仅尾 2s 淡出、不循环。gain 包络时间基准须用 `ctx.currentTime+offset`。

### 4.3 ffmpeg 巨坑（已修，勿回退）
- **`afade=t=out` 在 `atrim` 之后必须显式 `st`**：`afade=t=out:st={max(0,video_dur-2):.3f}:d=2`。不带 `st` 会因时长元数据不传播导致 BGM 放 1s 后淡出归零（"播几秒就消失"真因）。
- 后端 BGM 混流已去掉 `-shortest`，改 `-t {video_dur}` 显式锁时长（否则音乐被最短流截断）。
- **诊断方法论**：测"BGM 是否完整"绝不用 `volumedetect` 测**混合轨平均值**（人声掩盖 BGM 淡出）；正确做法：把 BGM 用导出 filter 单独隔离渲染成 wav，再逐秒 `astats` 测峰值。

### 4.4 主题/深色模式
- ⚠️ **禁止硬编码 `#1976d2` 等具体色值**做强调/按钮/选中/焦点色。一律用 `theme.palette.primary.main` / `color="primary"` / `background.paper` 或 CSS 变量 `--fcp-*`（已按 `[data-fcp-theme='dark']` 双模式覆盖为薄荷绿）。
- ⚠️ **`theme` 变量不跨组件透传**：子组件（如 `MusicPreviewPanel`、`CoverEditor`）用 `theme.palette.*` 必须各自 `useTheme()`，否则 tsc 报未定义。

### 4.5 布局外壳不变量
- **左导航已取消锁定**：四步随时可点自由切换，仅用 `visited:Set<number>` 显示绿色勾，不阻断点击。之前的 `canEnter`/`locked`/`LockIcon` 逻辑已删除，勿恢复。
- **侧栏面板只读**：`StepLeft/RightPanel` 只从 store 派生展示数据；加可编辑控件须走现有 store setter，勿重复步骤内状态。
- **`CoverEditor` 现在必须传 `value/onPatch`**，任何调用点都走草稿模式（抽屉"取消"靠重新快照保证不污染全局 store）。

---

## 5. 已完成工作清单（本次会话，按时间）

| 阶段 | 内容 | 关键文件 |
|---|---|---|
| A 深色统一 | 步骤2/3 个别按钮仍硬编码蓝 `#1976d2` → 全部改 `theme.palette.primary.main`；删除 `AnalysisProgress` 死代码 `SUB_STEP_COLOR_MAP` | AnalysisDashboard/AnalysisProgress/TimelineEditor/TemplateCard/TemplateTimeline + fcpTheme.ts |
| B 布局外壳 Phase 1 | 顶栏+左导航+三栏；列宽拖拽/折叠+`localStorage` 持久化；接回孤儿组件 `TimelinePreview` | AppShell/Panel/GlobalAspectControl/StepLeftPanel/StepRightPanel/App.tsx |
| C API Key 搬迁 | 画面分析 + 语音 TTS 的 Key 填写区从步骤2 主区迁到右栏参数面板（新增 store `analysisKeyError/ttsKeyError`） | StepRightPanel + AiScriptEditor + editing-store |
| D 步骤2 精简 | 删「AI 口播剪辑」大标题；流程文字移入口播文案卡片右上角 | AiScriptEditor |
| E 步骤3 深度拆分 | 字幕/音乐/封面三卡从中心区抽到右栏（封面卡后续升级为抽屉入口） | StepRightPanel + TimelineEditor |
| F 封面二级界面 | 封面编辑改为「右栏入口卡片 + 右侧滑出抽屉」；`CoverEditor` 改受控；草稿+应用/取消；3 项增强（hover 重置、安全区虚线、应用后绿环高亮） | CoverDrawer + TimelineEditor + editing-store(resetCover) + StepRightPanel |
| G 预览高度封顶 | 抽屉内封面预览框从写死 640 改为按 body 可视高度动态封顶（resize 监听） | CoverDrawer |

> 所有改动均通过 `tsc --noEmit` 零错误 + `vite build` 通过，纯前端 HMR 热更，后端未动。

---

## 6. 当前架构状态（在哪改什么）

- **顶栏**：全局画幅/分辨率（单一源）+ 主题切换。
- **左导航**：四步自由切换（无门禁）。
- **步骤3 右栏** = `SubtitleStyleCard` + `MusicControlCard` + `CoverEntryCard`（缩略图 + 状态副文 + hover 重置）。点击封面卡片 → `CoverDrawer` 滑出。
- **步骤3 中栏底部**：仍是 `MusicPreviewPanel` 的简单播放控制条（Slider 进度条）——**这是第二期 FCPX 时间轴要替换的位置**。
- **`TimelinePreview.tsx`**：孤儿组件（步骤3 左栏接回了它的文字列表，但原拖拽/替换逻辑仍废弃，待第二期 `FcpTimeline` 完全替代）。

---

## 7. 第二期 FCPX 时间轴 —— ✅ 已完成并验收（2026-07-17）

> **本节方案已在 `docs/PHASE2_TIMELINE_PLAN_V1.md` 指导下全部落地**：P1 视频轨（磁吸拖拽/点选替换/scrub）、P2 重选时段 Trim（固定时长选框+大预览实时跟随）、P3 三轨联动可视化（字幕轨+波形轨）。实际交付细节、验收记录与技术债见该文档 §6 实施进度日志。以下 §7.1-7.6 为历史方案存档，仅作背景参考。

> 用户核心诉求：参照 FCPX 做时间轴——**轨道磁吸、拖动播放头随时预览任意位置无卡顿、可拖拽重排片段、双击弹出胶片条替换素材**，且**第一版即带多层叠轨 + 波形可视化**。

### 7.1 已落定决策
| # | 项 | 结论 |
|---|---|---|
| 1 | 位置 | 仅步骤3 底部常驻，替代原播放控制条 |
| 2 | 轨道视觉 | 每片段一帧代表帧（`/thumb` 端点取中间时间点）+ 宽度 ∝ `duration/totalDuration × trackWidth` |
| 3 | Scrub | 拖动播放头实时 `video.currentTime = t` seek 主预览（短视频接近即时） |
| 4 | 磁吸 | 吸附相邻片段边缘 + 轨道起止点，阈值 ~5px |
| 5 | 双击替换 | 居中 Dialog 全素材池胶片条横排，点击即替换当前片段 |
| 6 | 关系 | 完全替代 `TimelinePreview`（废弃）；替代 `MusicPreviewPanel` 内 Slider 进度条 |
| 8 | 多层叠轨+波形 | **纳入第二期（第一版即做）**：主视频轨 / 字幕轨 / 音频轨 三层，音频轨叠加波形 |

### 7.2 功能清单
- **轨道本体**：水平渲染所有片段（缩略图+序号+时长），播放头橙色竖线可拖动 scrub（RAF 节流 ≤60fps）。
- **拖拽排序**：任意片段左右拖 reorder，半透明 ghost + 相邻让位，边缘吸附微动画，拖出边界=排首/排尾。
- **双击替换**：居中 Dialog「素材选择胶片条」，hover 放大×1.5，点击替换，ESC/遮罩关闭。
- **多层叠轨**：
  - T1 主视频轨：合成片段序列。
  - T2 字幕轨：文本块按时间码横排（来自 `subtitleOverrides`），可拖动微调时刻，双击进右栏字幕卡精修。
  - T3 音频轨：BGM + 口播两段波形，可独立拖动/调音量/静音。
  - 轨道可独立折叠（sticky 左标签列：视频/字幕/音频）。
  - **磁吸跨轨道生效**（FCPX 式全局吸附），保证口播/BGM 与画面切换点对齐。
- **波形可视化**：音频 clip 内 Canvas 绘制振幅包络；数据源**前端 `decodeAudioData`**（短视频无需后端），备用后端 `/waveform` 端点（ffmpeg `showwavespic`→峰值 JSON）；已播放部分高亮（theme primary），未播放半透明。

### 7.3 建议组件结构（新建 `FcpTimeline` 组件）
```
FcpTimeline
├── TimelineHeader（时间标尺 + 全局吸附开关 + 轨道折叠态）
├── TrackStack
│   ├── TrackLabel（sticky 左标签列，可折叠）
│   ├── VideoTrack      → ClipBlock[]（缩略图+序号+时长，拖拽+磁吸+双击替换）
│   ├── SubtitleTrack   → SubtitleBlock[]（文本块按时间码，拖动微调，双击精修）
│   ├── AudioTrack      → AudioClipBlock[]（BGM/口播，内嵌 WaveformCanvas）
│   └── Playhead（绝对定位竖线，跨三轨，同步 video.currentTime）
├── ClipReplaceDialog（双击弹出，Portal 渲染）→ MaterialFilmstrip[]
└── hooks: useDragReorder / useScrub / useAutoPlayhead / useWaveform / useTrackCollapse
```

### 7.4 数据源与复用
- segments：`editing-store` 的 `timeline`
- 字幕：`subtitleOverrides`
- 音频：BGM（`bgmName`/`bgmVolume`/`musicList`）+ 口播（`voiceVolume`）
- 缩略图：复用 `/thumb` 端点
- 波形：前端 `decodeAudioData`（BGM/口播音频 URL 从 store 取得）

### 7.5 本期不做（后续增强）
- 逐帧 Canvas 缓存 scrub（当前 video.seek 够用）
- 键盘 J/K/L 快捷键（可顺手加，非阻塞）
- 多视频轨分轨混合（单主视频轨拼接，暂不需 V1/V2）
- 转场编辑器（步骤3 左栏已留 [预留] 位，独立交付）

### 7.6 性能要求
- scrub 用 RAF 节流 ≤60fps；拖拽用 `transform` GPU 加速；波形 Canvas 防抖重绘（resize/列宽拖拽时）；>20 条素材时 Dialog 内虚拟化；>8 条音频时波形峰值数组抽稀。

---

## 8. 响应式与收尾待办

- 窄屏（<1100px）左导航收为图标轨，三栏纵向堆叠单栏滚动（断点 >1400 / 1100–1400 / <1100）。
- 列宽持久化仅存数值与折叠态，不存临时拖拽中间态。
- **匹配润色**（已延后）：Hook-first 偏见、定格 Ken Burns 缓推——可提醒用户。
- 转场编辑器（步骤3 左栏 [预留] 位）、顶栏撤销/Ctrl+Z（已留按钮位未实现）。

---

## 9. 致命坑清单（DO NOT）

1. ❌ 改 `.py` 后只重启沙箱 uvicorn——必须重启整个 Electron 应用。
2. ❌ 用 `127.0.0.1` 验证 Vite——用 `http://localhost:5173/`（IPv6）。
3. ❌ ffmpeg 改动只靠读代码判断——必须真跑 + ffprobe 验证。
4. ❌ 封面字段单独 `setCoverAspect`——必须走 `setVideoAspect`。
5. ❌ 硬编码 `#1976d2` 等色值——用主题 token。
6. ❌ 子组件用 `theme` 不 `useTheme()`——tsc 必报。
7. ❌ 恢复左导航锁定（`canEnter`/`locked`）——用户已要求自由切换。
8. ❌ 把 `CoverEditor` 当非受控组件直接用——必须传 `value/onPatch`。
9. ❌ 测 BGM 完整性用混合轨平均值——隔离渲染 wav 后逐秒 astats 峰值。
10. ❌ 字幕字号/描边换算分母用 360——必须用 320。
11. ❌ 重排时间轴只写 `setTimeline` 不重映射 `subtitleOverrides`——必须走 `reorderTimeline`（字幕覆写按片段跟随）。
12. ❌ 替换素材重置 `start_time` 或写入 `source_duration<=0`——必须走 `replaceSegmentVideo`（保留入点+钳位+守卫）。
13. ❌ 后端写文本文件/读子进程输出用系统默认编码——Windows GBK 会让中文路径崩溃，必须 `encoding="utf-8", errors="replace"`。
14. ❌ 恢复旧 `TimelinePreview` 列表编辑（时长滑杆乱改槽长）——槽长=口播时长是不可变 invariant，时长只能由重跑分析改变。
15. ❌ CoverEditor 预览字号/描边不乘 `k = previewH/320`——动态预览高度下 WYSIWYG 必破。

---

## 10. 给下一位 AI 的接手建议

1. **先跑 `npm run electron:dev` 亲眼看一下当前界面**（三轨时间轴、Trim 重选时段、封面抽屉），建立肌肉记忆。
2. **三期候选方向**（按用户优先级排序）：①撤销/重做（顶栏已留按钮位，走 store 快照栈，别用粗粒度全量）；②转场编辑器（步骤3 左栏 [预留] 位）；③过期测试断言修复（`test_bug2_exportconfirm_scaling` 等 2 个，先确认真实行为再改测试）；④50-100 段批量工作流（先解决波形画布视窗化 + 胶片条虚拟化，见技术债 f）。
3. **每完成一个交互即手测**：磁吸是否跟手、scrub 是否卡顿——用户对"是否好用"极其敏感，会逐条挑刺。手感常量集中在 `fcpTimelineConfig.ts`，别散落硬编码。
4. **改动前自查**（用户强习惯）：覆盖所有边界/副作用/关联文件（改了预览没改导出端、改了后端没改测试），完成后自查是否需要重启前后端。
5. **一致性红线**：预览 ≡ 导出是最高优先级。任何影响时间模型/渲染的改动，必须真跑导出 + 像素/时长探测验证（参见 `_p2_trim_consistency_gate.py` 的验证方法论）。

---

*附：历史详细方案见 `docs/` 内 `overview-layout-plan-v2.1.md`（v2.2 含 FCPX 规格）、`overview-phase1-shell.md`、`overview-darkmode-unify.md`；项目级不变量见 `.workbuddy/memory/MEMORY.md`。本文件为该系列的最新汇总。*
