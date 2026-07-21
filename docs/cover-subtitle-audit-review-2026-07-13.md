# 移交文档审计与优化执行计划

> **文档用途**：对 `cover-subtitle-audit-handoff-2026-07-13.md` 的逐项核对、自我辩证、潜在风险识别，以及一份重写后的执行计划。供 Alan 决策是否照此推进。
>
> **审计人**：Senior Developer（独立复核，未参与原文档撰写）
> **日期**：2026-07-13
> **审计范围**：原文档准确性 + 技术论证严密性 + 测试覆盖盲区 + 执行策略合理性

---

## 一、原文档准确性核对（与代码逐项对照）

### 1.1 严重过时：测试文件已存在但被列为"待新增"

原文档 §4 Task D 写道：

> 为核心回归（A 斜体 delta + C 中至少 2-3 个高风险项）**补充/新增 pytest** 到 `backend/tests/`（可新增 `test_cover_subtitle_audit.py` 或并入既有）

**实际情况**：`backend/tests/test_cover_subtitle_audit.py` **已存在**（共 507 行），且覆盖度远超原文档预期：

| 测试项 | 原文档预期 | 实际状态 |
|--------|-----------|----------|
| A 斜体 delta 独立复测 | 待新增 | `test_a_italic_delta_retest`（12 个参数化组合，含原失败案例 1440×1920 size282 tpx35 "细节见真章"） |
| B+ 缩字后长标题不溢出 + delta<2% | 未提及 | `test_a_defended_bplus_long_title_passes`（**这一项原文档完全没要求，是测试作者自己加的补强**） |
| 代码审查（drawtext x 纯居中、shear 在 overlay、字段透传、前端缩放公式） | 待新增 | `test_b_drawtext_x_pure_centered_and_shear_on_overlay` |
| C1 9:16↔3:4 百分比映射 | Task B 第 4 项 | `test_c1_aspect_percentage_mapping` |
| C2 zoom 与标题叠加独立 | Task B 第 6 项 | `test_c2_zoom_independent_of_title_overlay` |
| C3 颜色字段生效 | Task B 第 5 项 | `test_c3_cover_color_fields_effective` |
| C4 描边随 aspect 恒定 | 未明确 | `test_c4_cover_border_independent_of_aspect` |
| C5 emoji 渲染不 crash | Task B 第 1 项 | `test_c5_emoji_render_no_crash` |
| C6 主+副同时超长独立 fit | Task B 第 3 项 | `test_c6_dual_long_title_independent_fit` |
| C7 字幕多句拆分 | Task C 第 1 项 | `test_c7_subtitle_sentence_split` |
| C8 字幕位置映射 | Task C 第 2 项 | `test_c8_subtitle_position_mapping` |
| C9 字幕描边跨分辨率 1:1 | Task C 第 3 项 | `test_c9_subtitle_border_resolution_consistency` |
| C10 字幕颜色字段生效 | Task C 第 4 项 | `test_c10_subtitle_color_fields_effective` |

**结论**：原文档 Task B/C 的工作其实**已落地为可执行测试**，但作者在写移交文档时未回头核实测试目录现状，导致接手者会重复劳动。

### 1.2 测试目录残留：5 个旧文件未在文档中说明

`backend/tests/` 下还有以下文件，原文档完全未提及：

| 文件 | 用途 | 当前状态建议 |
|------|------|-------------|
| `test_cover_italic.py` | 早期 italic 修复独立复现（不依赖工程师代码，自建 filter graph） | **保留**——历史价值高，是验证"fontstyle 不可用"根因的铁证 |
| `test_cover_render.py` | Bug 2/3 的 monkeypatch 字符串测试 | **建议归档或删除**——只查命令行字符串，曾被原文档 §5 第 5 条明确警告"曾因此漏掉 Option not found"，已被真实 ffmpeg 测试取代 |
| `test_cover_stroke_visual.py` | 描边视觉定量回归（borderw 实测像素） | **保留**——Bug2 修复的核心证据 |
| `qa_independent_repro.py` / `test_qa_independent_repro.py` | end-freeze 复现 + italic 独立复现（QA Edward 写的） | **保留**——独立复现脚本，与工程师代码解耦 |
| `test_cover_autofit_regression.py` | B+ 防裁切端到端回归（17/17） | **保留**——B+ 硬约束的核心保障 |

**建议**：执行计划里加一项"清理 `test_cover_render.py`（确认无引用后归档到 `tests/_archive/`）"，避免接手者被旧字符串测试误导。

### 1.3 笔误：size282(=48×6) 算术错误

原文档 §4 Task A 第 1 步：

> 复现原 bug 场景：3:4(1440×1920) 渲染「细节见真章」size=282(48×6)

**问题**：48×6 = 288，不是 282。

对照测试 `test_cover_subtitle_audit.py` L226：
```python
(1440, 1920, 282, 35, "细节见真章"),   # 原 +2.107% 复现
```
这里 size=282 是**导出字号**（fontsize 直接传给 ffmpeg drawtext），不是预览字号 ×COVER_SCALE。若 282 是预览字号×6，预览字号 = 47，但 store 默认 coverTitleSize=48，导出应为 288。

**结论**：282 这个数字的来源存疑。可能是早期某次实验的实测值，或 coverTitleSize=47 的实验残留。建议接手者：
- 用 size=288（48×6，对应默认 store 值）重跑，确认 delta<2%
- 用 size=282 重跑，确认原文档承诺的修复生效
- 两个值都通过才算稳健

### 1.4 字体 fallback 路径不一致（文档未提及的隐患）

**路由层** `ai_editing.py` L315：
```python
"font_path": cover.get("font_path", subtitle_style.get("font_path", "C:/Windows/Fonts/msyh.ttc") if subtitle_style else "C:/Windows/Fonts/msyh.ttc"),
```
fallback 到 **msyh.ttc**（TrueType Collection，多字体集合）。

**render_cover 内部** `video_service.py` L540-547：
```python
for c in [r"C:/Windows/Fonts/simhei.ttf", r"C:/Windows/Fonts/msyh.ttf"]:
    if os.path.exists(c):
        fontfile = c.replace(":", "\\:")
```
fallback 到 **simhei.ttf 或 msyh.ttf**（注意是 .ttf 不是 .ttc）。

**两层 fallback 路径不一致**：
- 正常情况（前端传 cover.font_path=msyh.ttc）：路由层透传 msyh.ttc → render_cover 用 msyh.ttc ✓
- 异常情况（前端 cover.font_path 为空）：路由层填 msyh.ttc → render_cover 收到 msyh.ttc → 但若 msyh.ttc 不存在，render_cover 内部 fallback 到 simhei.ttf
- 测试环境用 SIMHEI = `C:/Windows/Fonts/simhei.ttf` 直接传 font_path，绕过路由层 fallback

**风险**：
1. ffmpeg drawtext 对 .ttc 的支持取决于编译选项，可能只取集合中第一个字体（YaHei Regular），忽略 Bold/Italic 变体——但本项目 italic 用 shear 合成，不依赖字体变体，影响有限
2. 若用户字体被卸载（如精简版 Windows），前端预览 fallback 到浏览器默认字体，导出 fallback 到 simhei.ttf，**预览与导出字体不一致** → WYSIWYG 破裂

**建议**：执行计划加一项"统一字体 fallback 链"，让路由层与 render_cover 用同一序列：`[用户 font_path, msyh.ttc, msyh.ttf, simhei.ttf]`。

---

## 二、技术论证辩证：哪些假设需要进一步验证

### 2.1 ⚠️ "ffmpeg 与浏览器同字体度量偏差一致"——未严格验证

原文档 §5 第 1 条核心论证：
> 位置统一 = 导出 == 预览，不是导出 == 正中央。ffmpeg 与浏览器同字体度量偏差方向/量级一致 → 双端一致即 WYSIWYG。

**辩证**：
- 浏览器渲染 CJK 在 Windows 上走 GDI/DirectWrite，子像素定位
- ffmpeg drawtext 走 FreeType + HarfBuzz（若编译），整像素定位
- 二者的 advance width 通常一致（都遵循字体表的 hmtx），但**实际像素位置可能差 1-2px**
- 在 1080/1440 宽画布上，1-2px = 0.07%-0.19%，远小于 2% 阈值
- 所以"双端基本一致"在像素级成立，但**严格 1:1 不成立**

**风险量级**：可接受（<0.2%），用户视觉感知阈值通常 1%+，实际可用。

**建议**：执行计划加一个"双端度量一致性实测"项——用同一个长标题，分别在前端用 `measureTextWidth` 测一次、在后端用 ffmpeg `text_w`（drawtext 的 text_w 变量）测一次，对比二者差值是否 <0.5%。这能定量回答"双端一致"是否成立。

### 2.2 ⚠️ "non-italic bias +2.39% 故意保留"与现有测试断言矛盾

原文档 §6 第 1 条：
> 长标题@大字号下 non-italic 质心相对 tpx% 漂 ~+2.39%，按 Path B 决策故意保留

**辩证**：但 `test_cover_wysiwyg_regression.py` L147-155 的 `test_b1_non_italic_text_w_offset` 断言：
```python
assert abs(cx - 0.5) < 0.02, f"'{text}': centroid X={cx*100:.3f}% 偏离 0.5 超过 2%"
```
即 **<2%**。若实测 +2.39%，**这个测试会失败**。

**三种可能**：
1. 文档的 +2.39% 数据来自早期版本（Path B 修复前），现已不成立 → 测试通过
2. 测试从未真正跑过，或被 skip → 需立即跑一次确认
3. +2.39% 是特定字号（282）下的值，测试用 size=200 未触发 → 需补 size=282 的 non-italic bias 测试

**建议**：执行计划第一步必须跑 `pytest backend/tests/test_cover_wysiwyg_regression.py -v`，确认 9/9 通过；若 `test_b1` 失败，原文档的"故意保留"论证就站不住，需要重新评估 Path B。

### 2.3 ✅ shear 补偿公式经检验正确

原文档核心修复 `shear_comp = shx * (h * tpy / 100 - h / 2)`。

**辩证**：ffmpeg shear 滤镜官方公式是 `x' = x + shx * (y - H/2)`（绕画布中心），不是绕原点。代码注释 L470 写对了。当前公式：
- italic 字体中心 y_c = h*tpy/100
- shear 在 y_c 处的漂移 = shx * (y_c - h/2) = shx * (h*tpy/100 - h/2)
- overlay 补偿 = shear_comp = shx * (h*tpy/100 - h/2)
- 净漂移 = 0 ✓

公式正确，**无需改动**。

### 2.4 ⚠️ B+ 缩字后 delta<2% ≠ 用户原始字号下 delta<2%

`test_a_defended_bplus_long_title_passes` 验证：B+ 缩字后 9:16 tpx=35 长标题 delta<2%。

**辩证**：
- 若用户字号 282 在 9:16 偏心锚点下溢出，B+ 会缩到 ~XX，再验证 delta<2%
- 但**用户感知到的"斜体修复有效"是在变小后的字号上**，不是用户原始字号
- 如果用户调小锚点居中（tpx=50），B+ 不缩字，此时 delta 是否仍 <2%？需补测

**建议**：执行计划加一项"用户原始字号下的 delta 矩阵"——不经过 B+ 缩字，直接用 size{120,200,282,336} × tpx{35,50} × 长标题 渲染 italic on/off，验证 delta。若 size=282 tpx=35 失败，说明"斜体修复"只在 B+ 缩字后成立，应在报告中明确这一边界。

### 2.5 ⚠️ 字幕长句自动换行 bug 未被列入待修

`_render_subtitles` L399-406 的 drawtext 用 `x=w*sx/100-text_w/2`，**没有换行逻辑**。

**辩证**：
- 若用户一句字幕很长（如 30 字），text_w > 画布宽，标题会**溢出画布左右边缘**
- 原文档 Task C 第 1 项"长文本自动换行 vs 预览对照"只说"对照"，没说要修
- 但前端预览（若用 CSS `white-space: pre-wrap` 或 `word-break`）可能自动换行，导出不换行 → **WYSIWYG 破裂**

**建议**：执行计划加一项"字幕长句换行排查"：
1. 查前端字幕预览组件的 CSS white-space 设置
2. 若前端会换行、后端不换行 → 这是真实 bug，需修（用 ffmpeg drawtext 的 `textfile` + 手动插入换行符，或后端按画布宽自动插入 `\n`）
3. 若前端也不换行 → 至少在 UI 提示用户"单句建议不超过 N 字"

---

## 三、B+ 算法与渲染逻辑的潜在优化点

### 3.1 B+ 硬编码常数应参数化

`ExportConfirm.tsx` L195-209：
```typescript
measureCover(coverTitle, coverTitleSize, coverTitleItalic, 800)   // weight=800 硬编码
measuredHeight: coverTitleSize * COVER_SCALE * 1.2                 // 行高 1.2 硬编码
measureCover(coverSubtitle, coverSubSize, coverSubItalic, 600)    // weight=600 硬编码
```

**问题**：
- 若未来支持自定义字重（如 700），测量结果与实际渲染不符
- 中文字体行高通常 1.3-1.5（不是 1.2），英文 1.2——硬编码 1.2 可能误判垂直溢出

**建议**：作为低优先级优化（不阻断当前任务），把 weight 和行高比提到 store 字段或常量配置。

### 3.2 B+ 多行标题测量不准

`coverFit.ts` L79 `whiteSpace = 'nowrap'` 假设单行测量。

**问题**：若用户在标题输入框按回车输入多行（如 "限时\n特惠"），`measureTextWidth` 只测第一行的水平宽度，**实际渲染会换行**，B+ 算的缩字比例就错了。

**建议**：
1. 查前端 CoverEditor 是否允许换行（textarea vs input）
2. 若允许，B+ 应按行分别测量，取最大宽度作为缩字依据
3. 若不允许，应在 UI 限制（input 不可换行）

### 3.3 B+ 强制 finalX=50 / finalY=50 可能违反用户意图

`coverFit.ts` L190, L215：缩字时强制 `finalX = 50` / `finalY = 50`。

**问题**：用户可能故意把标题放在 tpx=35（偏左），B+ 缩字后强制挪到中心，**违反用户意图**。

**辩证**：
- 缩字是为了"装得下"，若装得下且居中 → finalX=50 合理
- 但若用户偏心是有意的（如配合右侧图片），强制居中会破坏构图

**建议**：低优先级，作为"已知行为"在报告中说明，不强制修。

### 3.4 subprocess.run 未指定 encoding（潜在乱码）

`video_service.py` L424：
```python
result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
```
Windows 中文系统下 `text=True` 默认用 locale 编码（GBK），若 ffmpeg stderr 含中文路径会乱码。

**影响**：不影响功能（rc!=0 时 shutil.copy2 兜底），但调试日志可能乱码，排查问题时误导。

**建议**：低优先级，改为 `subprocess.run(..., encoding='utf-8', errors='replace')`。

---

## 四、测试覆盖盲区

### 4.1 前端 DOM 测量无法在 pytest 环境验证

原文档 §6 第 3 条已承认：
> 浏览器侧 DOM 测量（measureTextWidth / 预览 Chip）本环境无法运行时验证，只能代码审查。

**辩证**：但本项目是 Electron，**完全可以在 Electron 主进程里跑 headless 测量**：
- 用 `electron --headless` 启动一个隐藏窗口
- 加载 coverFit.ts，调用 measureTextWidth
- 把结果写到 JSON 文件，pytest 读取后断言

**建议**：作为"可选增强"项，若用户重视前端验证可投入；否则保持现状，报告中明确标注"前端 DOM 测量未实测"。

### 4.2 emoji 豆腐块未断言

`test_c5_emoji_render_no_crash` 只断言"不 crash + 有文本像素"，没验证 emoji 是否变豆腐块。

**建议**：补一个视觉对照——渲染 "🔥" 单字符，对比"热点速递"的质心位置，若 emoji 区域像素分布异常（如纯黑白方块），说明变豆腐。但这个判断有难度，可作为人工抽查项。

### 4.3 字幕长句换行未测试（见 §2.5）

### 4.4 渲染颜色 YUV 失真未测试

drawtext 用 RGB，但输出 yuv420p，红色（255,0,0）会下采样为（240,90,90）左右，可能影响颜色字段的视觉一致性。

**建议**：低优先级，C3/C10 已断言"字芯红、边框绿"，若通过说明 YUV 失真在可接受范围。

---

## 五、执行策略问题

### 5.1 拆 3 个 Agent 轮次不优化

原文档 §5 第 4 条：
> 上一轮「全面排查」因范围过大导致 35min 超时失败。建议拆成 A/B/C 三个独立 Agent 轮次串行执行。

**辩证**：
- 每个 Agent 轮次有冷启动开销（5-10min 读上下文 + 探索代码）
- 拆 3 轮总耗时反而增加（3×15min > 1×35min）
- 且轮次间上下文丢失，接手者可能重复探索

**更优策略**：单 Agent 内分阶段，每阶段产出独立报告文件（如 `audit_phase_A.md`），即使后续超时也保留前置成果。具体见下方执行计划。

### 5.2 临时产物清单缺失

原文档未列出当前已有的临时产物，接手者不知道哪些要清理。

**实测现状**（待确认）：
- `.cover_audit_test/`：test_cover_subtitle_audit.py 的产物目录
- `.cover_wysiwyg_test/pytest_artifacts/`：test_cover_wysiwyg_regression.py 的产物目录
- 可能还有 `_coverfit_bridge.ts`（test_cover_autofit_regression.py L17 提到）

**建议**：执行计划最后一步明确清理这些目录（保留测试文件本身）。

---

## 六、优化后的执行计划

> **核心调整**：承认测试已存在，把"执行测试 + 补充盲区 + 验证假设 + 清理冗余"作为主任务；单 Agent 内分 4 阶段，每阶段产出独立报告。

### 阶段 0：环境就绪与基线确认（必做，~5min）

**目标**：确认环境可用 + 跑通现有测试基线。

**步骤**：
1. 验证 ffmpeg 可用：`D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe -version`
2. 验证字体可用：`C:/Windows/Fonts/simhei.ttf` 存在
3. 启动后端（不带 --reload）：`cd "/d/AI混剪工具测试/short-video-mashup-tool/backend" && "/c/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe" main.py`
4. 跑基线测试：`pytest backend/tests/test_cover_wysiwyg_regression.py backend/tests/test_cover_subtitle_stroke_regression.py backend/tests/test_cover_autofit_regression.py backend/tests/test_cover_subtitle_audit.py -v`
5. **重点确认** `test_b1_non_italic_text_w_offset` 是否通过（解决 §2.2 矛盾）

**交付**：基线通过率 + `test_b1` 实测 cx 值（用于判断 Path B 论证是否成立）。

**路由判定**：
- 若全绿 → 继续阶段 1
- 若 `test_b1` 失败 → 暂停，重新评估 Path B（可能需要恢复 text_w 偏差补偿）

---

### 阶段 1：Task A 斜体 delta 验证 + 假设验证（~15min）

**目标**：独立确认斜体 delta 修复在多场景下成立 + 验证 §2 的几个假设。

**步骤**：
1. **跑现有测试** `test_a_italic_delta_retest`（12 组参数化）+ `test_a_defended_bplus_long_title_passes`
2. **补测 §2.4**：用户原始字号下（不经 B+ 缩字）的 delta 矩阵
   - 新增测试 `test_a_user_raw_size_delta_matrix`：
   - size{120, 200, 282, 336} × tpx{35, 50} × 长标题"细节见真章" × 比例{3:4, 9:16}
   - 渲染 italic on/off，断言 delta < 2%
   - 若 size=282 tpx=35 失败，记录为"已知边界"（B+ 缩字后才成立）
3. **补测 §2.1**：双端度量一致性（可选，若实施成本高可降级为代码审查）
   - 用 ffmpeg drawtext 的 `textinfo` 或 `text_w` 变量导出文本宽
   - 对比前端 `measureTextWidth`（Electron 内运行）的结果
   - 断言差值 < 0.5%
4. **代码审查**：确认 `COVER_TEXT_W_BIAS_K` 全仓无残留（`grep -r "COVER_TEXT_W_BIAS_K" backend/ src/`）

**交付**：
- A 阶段报告 `audit_phase_A.md`：delta 数值表 + 假设验证结论 + 已知边界
- 若新增了测试，更新 `test_cover_subtitle_audit.py`

**路由判定**：
- 全绿 → 继续阶段 2
- size=282 tpx=35 失败但 B+ 缩字后通过 → 标记"已知边界"，继续阶段 2
- 多场景失败 → 暂停，斜体修复需返工

---

### 阶段 2：Task B 封面 + Task C 字幕全面排查（~20min）

**目标**：跑现有 C1-C10 测试 + 补充 §2.5、§3 的盲区。

**步骤**：
1. **跑现有测试** `test_c1` 到 `test_c10`（10 项）
2. **补测 §2.5 字幕长句换行**：
   - 新增测试 `test_c11_subtitle_long_text_overflow`：
   - 渲染 30 字长句字幕，w=1080，fontsize=72
   - 用 PIL bbox 测文本左右边缘
   - 若右边缘 > 1080 → **真实 bug**，报告标记为 P1
3. **补测 §1.4 字体 fallback 一致性**：
   - 新增测试 `test_b_font_fallback_consistency`：
   - 模拟 font_path="" （空），渲染封面
   - 对比 font_path=msyh.ttc 的渲染结果
   - 若质心位置差异 > 2% → fallback 路径不一致，标记 P2
4. **代码审查 §3.1, §3.2, §3.3**：
   - B+ 硬编码常数（weight 800/600、行高 1.2）
   - 多行标题测量（前端 CoverEditor 是否允许换行）
   - 强制 finalX=50 的视觉影响
   - 写入报告作为"已知行为/低优先级优化"

**交付**：
- B/C 阶段报告 `audit_phase_B_C.md`：每项「结论 + 证据 + 严重度」
- 若发现 P1 bug，单独标记并给出修复建议
- 新增的测试合并到 `test_cover_subtitle_audit.py`

**路由判定**：
- 全绿 + 无 P1 → 继续阶段 3
- 发现 P1 → 暂停，报告用户决定是否修
- 仅 P2/P3 → 继续阶段 3，报告中标注

---

### 阶段 3：全量回归 + 总报告 + 清理（~10min）

**目标**：跑全量测试 + 汇总报告 + 清理临时产物。

**步骤**：
1. **全量回归**：`pytest backend/tests/ -v --ignore=backend/tests/test_cover_render.py`（忽略待归档的旧字符串测试）
2. **清理临时产物**：
   - `.cover_audit_test/` 内容（保留目录，pytest 会重建）
   - `.cover_wysiwyg_test/pytest_artifacts/` 内容
   - 任何 `qa_*.py`、`_coverfit_bridge.ts` 临时文件
3. **归档旧测试**：`test_cover_render.py` 移动到 `backend/tests/_archive/`（确认无 import 引用后）
4. **写总报告** `audit_final_report.md`：
   - 阶段 0-3 结论汇总
   - A/B/C 逐项结论表
   - 新发现问题 + 严重度 + 修复建议
   - 已知边界（不阻断）
   - 智能路由判定：源码 Bug → Engineer；测试 Bug → 自修；通过/已知残留 → NoOne

**交付**：
- `audit_final_report.md`（主交付物）
- `audit_phase_A.md`、`audit_phase_B_C.md`（阶段产物）
- 更新后的 `test_cover_subtitle_audit.py`
- 不 commit（用户未要求）

---

## 七、风险评估与建议

### 7.1 高风险项（可能阻断）

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `test_b1` 失败（§2.2） | Path B 论证崩溃，斜体修复决策需重做 | 阶段 0 优先跑，失败立即暂停 |
| 字幕长句溢出（§2.5） | 真实 bug，影响所有长字幕用户 | 阶段 2 补测，发现即标记 P1 |
| 字体 fallback 不一致（§1.4） | WYSIWYG 在异常路径下破裂 | 阶段 2 补测，发现即标记 P2 |

### 7.2 中风险项（已知边界，不阻断）

| 风险 | 影响 | 处理方式 |
|------|------|----------|
| 双端字体度量微差（§2.1） | 0.2% 量级，用户感知不到 | 报告中说明，不修 |
| B+ 缩字后 delta<2%（§2.4） | 用户原始字号下可能 >2% | 报告中标注边界 |
| B+ 硬编码常数（§3.1） | 未来扩展字重时不准 | 低优先级优化 |
| B+ 多行测量不准（§3.2） | 多行标题缩字比例错 | 取决于前端是否允许换行 |

### 7.3 低风险项（可忽略）

- subprocess.run encoding（§3.4）：调试日志可能乱码，不影响功能
- 渲染颜色 YUV 失真（§4.4）：C3/C10 已隐式覆盖
- emoji 豆腐块（§4.2）：平台限制，无法根治

### 7.4 整体建议

1. **先跑阶段 0**——5min 内决定是否继续。若 `test_b1` 失败，整个 Path B 决策需重新评估，后续工作无意义。
2. **阶段 1 优先于阶段 2**——A 是最关键的修复验证，B/C 是排查，A 失败则 B/C 无意义。
3. **每阶段产出独立报告**——即使后续超时，前置成果保留。
4. **不要拆 Agent 轮次**——单 Agent 内分阶段更高效。
5. **新发现的 P1 bug 不在本任务修复**——只报告，由用户决定是否单独立项。

---

## 八、与原文档的差异对照表

| 维度 | 原文档 | 本计划 | 理由 |
|------|--------|--------|------|
| Task D 测试新增 | "可新增 test_cover_subtitle_audit.py" | 测试已存在，改为"补充盲区测试" | 原文档过时 |
| 旧测试文件 | 未提及 | 明确归档 test_cover_render.py | 避免接手者被误导 |
| size=282 来源 | "48×6"（算术错） | 用 282 和 288 双值验证 | 算术修正 + 稳健性 |
| 字体 fallback | 未提及 | 新增一致性测试 | 发现的隐患 |
| 字幕换行 | "对照预览" | 新增溢出测试 | 真实未修 bug |
| 双端度量一致性 | 假设成立 | 可选实测验证 | 论证严密化 |
| non-italic bias +2.39% | "故意保留" | 阶段 0 优先确认 test_b1 通过 | 与测试断言矛盾 |
| 执行策略 | 拆 3 个 Agent 轮次 | 单 Agent 4 阶段 | 减少冷启动开销 |
| 阶段产物 | 单一总报告 | 每阶段独立报告 | 超时保护 |
| 临时产物清理 | 提及但未列清单 | 明确列出 .cover_audit_test/ 等 | 接手者清晰 |

---

## 九、决策点（需 Alan 确认）

1. **是否同意按本计划推进？**（替代原文档 Task A-D）
2. **阶段 0 失败时的处理**：若 `test_b1` 失败，是否授权我重新评估 Path B 决策（可能恢复 text_w 偏差补偿）？
3. **字幕长句换行 bug（若发现）**：是否在本任务修复，还是单独立项？
4. **前端 DOM 测量验证（§4.1）**：是否值得投入做 Electron headless 测量？还是保持代码审查？
5. **旧测试归档**：是否同意把 `test_cover_render.py` 移到 `_archive/`？

---

**审计结论**：原文档技术论证大体准确，但严重过时（测试已存在却列为待新增），且对"双端度量一致"和"non-italic bias +2.39%"两个关键假设未严格验证。优化后的执行计划聚焦于"验证假设 + 补充盲区 + 清理冗余"，而非重复劳动。
