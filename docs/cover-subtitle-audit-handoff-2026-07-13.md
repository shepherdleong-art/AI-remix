# 封面标题与视频字幕：斜体残留优化 + 全面排查 — 执行移交文档

> **文档用途**：本文档是给「接手 AI / 另一个执行者」的完整蓝本。包含用户最终诉求、项目环境、历史已完成的修复（避免重复劳动或踩坑破坏）、当前代码真实状态（已核实）、待执行的任务清单、验证铁律、关键约束与决策教训、已知边界。接手者读完应可直接开工，无需回溯长对话。
>
> **日期**：2026-07-13
> **项目**：`short-video-mashup-tool`（短视频智能混剪工具）
> **状态**：后端改动已落盘（工程师路径 B），QA 验证轮次因超时失败待重跑；全面排查尚未执行。

---

## 0. 用户最终诉求（拆解）

原话：「再回头优化一下斜体残留，然后再帮我检查下封面标题和视频字幕是否有其他问题」

拆为 4 个可执行任务：

| 任务 | 内容 | 优先级 |
|------|------|--------|
| **Task A** | 验证「斜体残留修复（路径 B）」在长标题+大字号下确实生效（italic/non-italic 质心 delta < 2%） | 高（最快、最关键） |
| **Task B** | 全面排查封面标题其他潜在问题（多字体/emoji/多行/极端值/比例切换/颜色/背景叠加等） | 中 |
| **Task C** | 全面排查视频字幕其他潜在问题（多行换行/位置/分辨率缩放/颜色/混排/emoji/与封面描边逻辑差异等） | 中 |
| **Task D** | 全量回归 + 输出《整体排查报告》+ 智能路由判定 | 收尾 |

---

## 1. 项目与环境

| 项 | 值 |
|----|----|
| 仓库根 | `D:\AI混剪工具测试\short-video-mashup-tool\` |
| 技术栈 | Electron 28 + React(TS) 前端 + Python FastAPI 后端 |
| 后端代码 | `backend/services/video_service.py`（封面 `render_cover` + `_build_cover_filter_complex`；字幕 `render_subtitles`/`composite_clip`） |
| 后端路由 | `backend/routes/ai_editing.py`（`/composite`、`/match-scenes-v2`、`concat_filter` 等） |
| 前端封面预览 | `src/renderer/components/analysis/TimelineEditor.tsx` 的 `CoverEditor`（约 456–744 行） |
| 前端导出 | `src/renderer/components/render/ExportConfirm.tsx`（约 170–265 行） |
| 前端防裁切工具 | `src/renderer/utils/coverFit.ts` |
| 前端状态 | `src/renderer/store/editing-store.ts`（封面字段 `coverTitleX/Y/Size/StrokeWidth/Italic`、`coverSubX/Y/Size/StrokeWidth/Italic`、`coverAspect`、`coverZoom` 等） |
| 托管 Python | `C:\Users\11833\.workbuddy\binaries\python\versions\3.13.12\python.exe`（PIL 11.0.0 / numpy 2.1.3） |
| ffmpeg | `resources/ffmpeg/ffmpeg.exe`（N-125048，drawtext **无 `fontstyle` 选项**，斜体靠 `shear=shx=0.28` 合成） |
| 测试目录 | `backend/tests/`（`test_cover_wysiwyg_regression.py` 9/9、`test_cover_subtitle_stroke_regression.py`、`test_cover_autofit_regression.py` 8/8） |
| 测量铁律 | **PIL 填充像素质心**（角点采背景、与背景欧氏距离 > 55 判文本像素），**禁用 bbox**（斜体描边污染）；直接对 `render_cover`/`render_subtitles` 输出帧测量，**禁带黑边播放器截图** |

**关键不变量（封面渲染）**：
- 封面渲染高度恒为 1920，宽度随比例：9:16 → 1080，3:4 → 1440。
- 前端预览字号 `coverTitleSize` ↔ 导出字号 = `× COVER_SCALE(=6)`。预览框高 320 ↔ 导出 1920，9:16 预览宽 180 ↔ 导出 1080，3:4 预览宽 240 ↔ 导出 1440。
- 封面字体预览走 `coverPreviewFont`（@font-face 注入 blob URL），绕开跨域 CORS。
- ffmpeg Windows 路径反斜杠转义：`p.replace('\\','/').replace(':','\\:')`。

---

## 2. 历史已完成的修复（重要：别重做，也别破坏）

### 2.1 Fix A — 斜体 shear 位移补偿（已验证，勿破坏）
- **根因**：ffmpeg drawtext 无 `fontstyle`，斜体改用 `shear=shx=0.28` 合成（几何上绕画布中心 y=H/2 倾斜），导致导出斜体整块相对「几何居中位置」漂移（画面上半右移、下半左移）。预览用浏览器真斜体（`fontStyle:'italic'`）几何居中，两边对不上 → WYSIWYG 不统一。
- **修复**：`shear_comp = shx * (h * tpy / 100 - h / 2)` 补偿位移，使导出斜体视觉中心 == 预览真斜体。
- **状态**：独立复测三行 delta 均 < 0.2%，已验证。

### 2.2 Bug2 — 视频字幕描边与调节值不一致（已修复）
- **根因**：`ExportConfirm.tsx` 旧写法 `stroke_width: subtitleStrokeWidth` 未缩放，而字号已随分辨率放大，导致导出描边相对字形仅预览的 1/3。
- **修复**：`stroke_width: Math.round(subtitleStrokeWidth * resolution.width / 360)`（与字号同因子）。**不乘 0.5**（字幕预览用 4 方向 text-shadow，整圈外侧描边，与 ffmpeg `borderw` 语义 1:1；0.5 仅用于封面 `-webkit-text-stroke` 居中描边）。
- **状态**：PIL 实测「描边/字号」比值 == 预览，已验证。

### 2.3 B+ — 封面 WYSIWYG + 智能防裁切（已交付，前端，硬约束不可动）
- **改动**：新增 `coverFit.ts`（`measureTextWidth` 隐藏 DOM span 测宽 + 纯函数 `computeCoverFit` 平移优先/缩字号兜底/纵向 clamp/4% 安全边距）；`TimelineEditor.tsx` 预览 `maxWidth:88%→100%` + 主副标题用 fit 最终值 + 越界显示 MUI Chip「已平移适配/已缩放适配」；`ExportConfirm.tsx` 导出前 `await document.fonts.ready` 兜底 + 主副标题跑 `computeCoverFit` 用最终字号/位置进 payload（**描边不动**）。
- **状态**：17/17 真渲染回归通过。

### 2.4 路径 B — 斜体残留修复（当前最新改动，工程师已落盘，待 QA 验证）
- **背景残留**：QA 实测长标题「细节见真章」@size282(=48×6) 时 italic/non-italic 质心 delta = **+2.107%**（超 2% 门限）；non-italic 墨迹质心相对 tpx=50% 漂 +2.39%（ffmpeg 按 `text_w` 居中，CJK 长串字形质心有像素级偏移随字号放大）。
- **工程师方案尝试**：先加 `K*text_w` 偏差项想把 non-italic bias 归零，但这会吃掉 B+ 的 2% 安全边距（C2 断言失败）。
- **团队主理人决策（Path B）**：位置统一 = 导出==预览，不是导出==正中央。ffmpeg 与浏览器同字体度量偏差方向/量级一致 → non-italic bias 双端一致即已 WYSIWYG，强制归零反而破坏统一 + 挤占边距。**故只修 delta（斜体 vs 非斜体），不动 bias**。
- **最终落地的改动**：把 `shear_comp` 从 drawtext-x **移到 overlay-x**（纯平移，不挤压字形，避免宽标题被左缘裁切致质心畸变）。drawtext x 回归纯居中 `w*tpx/100-text_w/2`，删除 `COVER_TEXT_W_BIAS_K` 常量。
- **状态**：工程师自测 8/8 + 9/9 全绿，IS_PASS YES。**但 QA 独立验证轮次因环境超时失败（499 canceled），尚未得到独立确认**。

---

## 3. 当前代码真实状态（已核实，2026-07-13）

### 3.1 `backend/services/video_service.py` — `_build_cover_filter_complex`（L461–498）
```python
W, H = w, h
chain = ["[0:v]format=rgba[base]"]
last = "base"
for idx, (safe, tpx, tpy, fs, fc_, s_color, s_width, shx) in enumerate(segments):
    layer = f"layer{idx}"
    out_label = "out" if idx == len(segments) - 1 else f"base{idx + 1}"
    # shear_comp is the horizontal pre-compensation for the synthetic-italic
    # shear drift. Applied via OVERLAY x offset (NOT drawtext x) so the text
    # layer is sheared in place then slid back as a single translation.
    # Net effect: exported italic centroid == exported non-italic centroid.
    # For non-italic rows shx=0 -> shear_comp=0 -> overlay x=0 (no-op).
    shear_comp = shx * (h * tpy / 100 - h / 2)        # L478
    x_expr = f"w*{tpx}/100-text_w/2"                  # L489 纯居中，无偏差项
    chain.append(
        f"color=c=black@0:s={W}x{H}:r=25,format=rgba,"
        f"drawtext=text='{safe}':fontfile='{fontfile}':"
        f"fontsize={fs}:fontcolor={fc_}:"
        f"bordercolor={s_color}:borderw={s_width}:"
        f"x={x_expr}:y=h*{tpy}/100-th/2,"
        f"shear=shx={shx}:fillcolor=0x00000000[{layer}]"
    )
    chain.append(f"[{last}][{layer}]overlay=x={shear_comp:+.4f}:y=0:shortest=1[{out_label}]")  # L498
    last = out_label
return ";".join(chain)
```
**关键确认**：无 `COVER_TEXT_W_BIAS_K` 常量；drawtext x 无尾部带符号数字；shear 补偿在 overlay-x；`render_cover` 接收 `title_x/title_y/sub_x/sub_y/title_size/sub_size`（约 L512-523）字段透传未变。

### 3.2 `src/renderer/components/render/ExportConfirm.tsx`（L193–256 关键段）
- `titleFit`/`subFit` 均调 `computeCoverFit`，`safeMargin: 0.04`，canvas = 导出分辨率（3:4=1440×1920 / 9:16=1080×1920），测字宽用 `coverTitleSize * COVER_SCALE`。
- payload 透传：`title_x/y = titleFit.titleX/titleY`、`title_size = round((titleFit.fontSize) * COVER_SCALE)`（副标题同理，`sub_*`）。
- **字幕描边**：`stroke_width: Math.round(subtitleStrokeWidth * resolution.width / 360)`（随字号缩放，**不乘 0.5**）。
- **封面描边**：`title_stroke_width: Math.round(coverTitleStrokeWidth * COVER_SCALE * 0.5)`（**乘 0.5** 补偿）。

### 3.3 `src/renderer/utils/coverFit.ts`（已核实完整）
- `measureText(text, opts)`：隐藏 DOM `<span>`（`position:absolute;visibility:hidden;white-space:nowrap;maxWidth:none` + 同 font-family/size/weight/style）`getBoundingClientRect()` 取真实字宽。非 DOM 环境有 fallback（length×fontSize×0.6）。
- `computeCoverFit(input)`：**纯函数**。
  - 横向：`halfW = measuredWidth/2`；`availHalf = min(左可用, 右可用)`；`halfW > availHalf` 时先尝试平移 `finalX = clamp(titleX, minX, maxX)`（保字号）；若 `halfW > safeW/2`（即使居中仍超）→ `effectiveFontSize = fontSize * max(maxShrink, safeW/measuredWidth)`、`finalX=50`、`didShrink=true`。
  - 纵向：同理 clamp `finalY`，极端高兜底缩字号。
  - 无溢出：`adjusted=false` 原值返回。
- `fitTitleLine(text, style, opts)`：组合 measure+compute（预览侧用）。

---

## 4. 待执行任务清单（接手者按下表执行）

### Task A — 验证「路径 B 斜体 delta 修复」生效（高优先）
**目标**：独立确认长标题 + 大字号下 italic/non-italic 质心 delta < 2%，且短标题不回归。
**方法（真 ffmpeg + PIL 填充像素质心）**：
1. 复现原 bug 场景：3:4(1440×1920) 渲染「细节见真章」size=282(48×6)、title_x=35、非 italic → 质心 delta 应已从原 +2.107% 归零（预期 < 2%）。
2. 构造 grid：size{120,200,282} × tpx{35,50} × length{单字"测"/中"测试标题"/长"细节见真章"} × 比例{3:4,9:16}，每行渲染 italic on/off 两版，量 centroid X 算 delta = on − off。
3. 验收：所有组合 delta < 2%。确认 Y 质心、画布尺寸精确无影响。
4. 代码审查：drawtext x 为纯居中（无偏差项、无尾部带符号数）；shear 补偿确在 overlay-x；`COVER_TEXT_W_BIAS_K` 全仓 grep 无残留；后端字段透传未变。
5. 全量回归：`pytest backend/tests/test_cover_wysiwyg_regression.py backend/tests/test_cover_subtitle_stroke_regression.py backend/tests/test_cover_autofit_regression.py` 报告通过率。
**交付**：A 的 delta 数值表 + 代码审查结论 + 通过率。
**路由**：源码 Bug → Engineer；测试 Bug → 自修；通过 → NoOne。

### Task B — 封面标题全面排查（中优先）
**逐项给「结论 + 证据 + 建议」**（代码审查 + 真实渲染测量；浏览器侧仅审查标注）：
1. **多字体**：中/英/数字/混合/emoji 渲染与居中（尤其 emoji 在 ffmpeg drawtext 是否渲染、是否 fallback 豆腐块）。
2. **极端值**：最小/最大字号、最大描边宽度下是否溢出/异常。
3. **主+副同时超长**：各自 `computeCoverFit` 是否独立正确（读 ExportConfirm 两处 fit 调用 + TimelineEditor 两处 overlay）。
4. **比例切换**：9:16 ↔ 3:4 切换时 title_x/y 百分比映射、防裁切是否仍生效（canvas 传参检查）。
5. **颜色字段**：标题颜色、描边颜色（`title_color`/`title_stroke_color` 等）是否真正生效（读 `render_cover` 取色逻辑）。
6. **背景叠加独立性**：背景图 zoom/offset 与标题 overlay 是否独立（标题不应受 zoom 影响）。
**交付**：新发现的问题 + 严重度。

### Task C — 视频字幕全面排查（中优先）
**逐项给「结论 + 证据 + 建议」**：
1. **多行字幕**：长文本自动换行 vs 预览对照（ffmpeg drawtext `wrap`/`textfile` 逻辑，与前端预览是否一致）。
2. **字幕位置**：上/中/下字段映射是否正确。
3. **分辨率缩放一致性**：720p/1080p/1440p/3:4/9:16 下字号与描边（borderw）随字号 1:1 无回归（复用 Bug2 验证方法）。
4. **字幕颜色/背景框**：颜色、背景框字段是否生效。
5. **混排/特殊字符/emoji**：中英文混排、特殊字符、emoji 在字幕中渲染（ffmpeg drawtext 字体是否含 emoji 字形）。
6. **与封面描边逻辑差异**：一处 ×0.5（封面 -webkit-text-stroke）、一处 ×1（字幕 text-shadow），确认两处都正确、无串味（读 ExportConfirm L226-256 + 后端 borderw 透传）。
**交付**：新发现的问题 + 严重度。

### Task D — 全量回归 + 报告（收尾）
1. 为核心回归（A 斜体 delta + C 中至少 2-3 个高风险项：emoji 渲染、多行字幕换行、不同分辨率描边一致性）**补充/新增 pytest** 到 `backend/tests/`（可新增 `test_cover_subtitle_audit.py` 或并入既有），用真实 ffmpeg+PIL 断言关键不变量。
2. 运行全量 `pytest backend/tests/`（至少 cover + subtitle stroke + autofit），报告通过率。
3. 输出《整体回归 & 排查报告》：每项「结论 + 证据 + 建议」；列出**新发现问题**及严重度。
4. **智能路由判定**：源码 Bug → Engineer；测试 Bug → 自修；通过/仅已知残留/新发非阻断 → NoOne。
5. 临时渲染产物放 `.cover_audit_test/`，结束清理（保留 pytest 文件）。
6. **不要 commit**（除非用户明确要求）。

---

## 5. 关键约束与决策原则（踩坑教训，务必遵守）

1. **位置统一 = 导出 == 预览，不是导出 == 正中央**。ffmpeg 与浏览器同字体度量偏差方向/量级一致 → 双端一致即 WYSIWYG。强制把导出墨迹质心拉回 tpx% 正中央反而破坏统一 + 挤占 B+ 边距。**Path B 决策：不动 non-italic bias**。
2. **前端 B+ 防裁切是硬约束，不可动**（任务明确要求）。任何后端改动不得影响 B+ 的 2% 安全边距逻辑。
3. **后端最小改动原则**：优先只改 drawtext/overlay 表达式，不动字段名/透传/letterbox。
4. **QA 轮次拆分**：上一轮「全面排查」因范围过大导致 35min 超时失败（499 canceled）。建议**拆成 A（验证）/ B（封面排查）/ C（字幕排查）三个独立 Agent 轮次**串行执行，避免单次超时。
5. **测量铁律**：必须用 PIL 填充像素质心，禁用 bbox；必须对 `render_cover` 输出帧直接测量，禁带黑边播放器截图（曾因此得出 −12% 假数据）。
6. **环境坑**：
   - 本机 Bash 是 **Git Bash**，`cd /d "D:\..."` 会报 `cd: too many arguments` 导致启动链失败。必须用 Unix 路径：`cd "/d/AI混剪工具测试/short-video-mashup-tool/backend" && "/c/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe" main.py`。
   - 后端若无 `--reload`，改 `.py` 必须重启后端进程才生效；前端（Vite）HMR 通常自动热更，但组件状态改动建议硬刷 `http://localhost:5173/`（勿用 127.0.0.1，Vite 默认 host=localhost→IPv6(::1)）。
   - ffmpeg 路径反斜杠转义：`p.replace('\\','/').replace(':','\\:')`。

---

## 6. 已知残留与边界（非阻断，交接时告知用户）

1. **non-italic text_w 度量偏差**：长标题@大字号下 non-italic 质心相对 tpx% 漂 ~+2.39%，按 Path B 决策**故意保留**（双端一致即 WYSIWYG，动了反而坏）。短/单行标题稳定 < 2%。
2. **斜体 delta**：路径 B 后应全字号/比例 < 2%（待 Task A 独立确认）。
3. **浏览器侧 DOM 测量**（measureTextWidth / 预览 Chip）本环境无法运行时验证，只能代码审查 + 用 ffmpeg 等价驱动算法验证导出侧正确性 —— 报告中须明确这一边界。
4. 临时验证脚本/产物若残留于项目根（如 `qa_*.py`、`*.ts`、`_coverfit_bridge.ts`、`.cover_*_test/`），均为可重生临时文件，清理时不影响交付与测试。

---

## 7. 交付物预期

- 新增/修改 `backend/tests/` 下 pytest 文件（至少 Task A 验证 + Task C 高风险项）。
- 《整体回归 & 排查报告》（含 A/B/C 逐项结论 + 新发现问题 + 路由判定）。
- 不 commit（用户未要求）。
- 可选：若用户后续要求，可整理全系列改动（Fix A + Bug2 + B+ + 路径 B）交付报告落盘至 `deliverables/software-company/`。
