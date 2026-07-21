# 问题排查执行文档：封面预览拉伸 + 音轨故障

> **文档用途**：给接手 AI 的完整执行蓝本。自包含，读完即可开工。
> **日期**：2026-07-13
> **项目**：`short-video-mashup-tool`（D:\AI混剪工具测试\short-video-mashup-tool\）

---

## 0. 背景

上一轮封面/字幕优化（最终执行计划见 `docs/final-execution-plan-2026-07-13.md`）已完成 8 项修复并全量回归（86/87 passed）。但用户报告了 **3 个问题**：

| # | 问题 | 状态 |
|---|------|------|
| 1 | **步骤3预览 9:16 封面画面拉伸** | 🔍 待排查 |
| 2 | **导出封面标题被截断** | ✅ 已修复（ExportConfirm measureCover 补 CSS 降级链） |
| 3 | **成片音轨出现"类似日文"故障** | 🔍 待排查（用户说之前出现过并修复过，但历史无记录） |

---

## 1. 已修复项（不要重复修）

上一个 Agent 的改动（已落盘，后端已加载，测试通过）：

| 改动 | 文件 | 影响 |
|------|------|------|
| C3 .ttc 字体预览 | `TimelineEditor.tsx` L540 | 跳过 .ttc @font-face + CSS 降级链 |
| C3 连带修复 | `ExportConfirm.tsx` L189 | measureCover fontFamily 补降级链 |
| C4 换行 | `video_service.py` | **已回退**（转义链不可靠） |
| C5 抹空格 | `video_service.py` L674 | `\s` 从 re.sub 移除 |
| C6 项目历史 | `ProjectHistory.tsx` | 补 24 个 cover* 字段 |
| C7 跳段字幕 | `video_service.py` L183/L304 | valid_segments 收集+传递 |

**关键不变量**：这些改动已经在后端/前端加载生效，不要回退。

---

## 2. 问题 1：9:16 封面预览画面拉伸

### 现象
步骤3 封面编辑器里，切换到 9:16 时背景画面拉伸变形；3:4 正常。

### 排查方向

**A. 确认是否为之前就有的行为**

预览渲染代码在 `TimelineEditor.tsx` L647-666：
```tsx
<img src={frameUrl} style={{
    objectFit: 'fill',  // 故意设的，注释说为了 WYSIWYG
    transform: `translate(${offX}px, ${offY}px) scale(${zoom})`,
}} />
```

`objectFit: 'fill'` 是之前特意设的——上一次修复封面偏右时（BugFix: software-bugfix-cover-position，见 `memory/2026-07-10.md` L47），发现 `contain` 会 letterbox 导致预览与导出不一致，改为 `fill` 做 1:1 拉伸（镜像后端的 stretch+crop 逻辑）。

**验证方法**：
1. 临时改 `objectFit: 'fill'` → `objectFit: 'contain'`，刷新前端看 9:16 是否恢复正常
2. 如果 `contain` 下正常——说明问题出在封面视频源本身的宽高比 ≠ 9:16，`fill` 强制拉伸导致变形
3. 检查 `frameUrl` 的实际尺寸（curl 下载或用浏览器 DevTools 看网络请求返回的图片分辨率）

**B. 如果确认是代码问题**

排查 `render_cover` 输出的封面帧 PNG 尺寸是否正确：
- `ai_editing.py` L345：`cw = 1080 if cover_aspect == "9:16" else 1440`
- 预期 9:16 帧 = 1080×1920

如果后端输出帧尺寸正确（1080×1920），前端的 180×320 预览框是等比缩小的（1080/6=180, 1920/6=320），`fill` 不应该变形。那问题就是 **frameUrl 指向的图片本身尺寸不对**。

---

## 3. 问题 3：音轨"类似日文"故障

### 现象
导出成片后，音频听起来像加速/变调的日语。

### 排查方向

**A. 先排除变量——不挂封面导出测试**

让用户挂封面/不挂封面各导一次，对比音频：
- 不挂封面正常 + 挂封面故障 → 问题在 `ai_editing.py` 的封面 concat 音频链路
- 两种都故障 → 问题在 `composite_clip` 的音频混合或 TTS 输出

**B. 封面 concat 音频链路（最可能）**

代码在 `ai_editing.py` L369-393：
```python
audio_info = _probe_audio_stream(output_path)  # 探测主视频音频参数
a_sr = audio_info.get("sample_rate", 44100)
a_cl = audio_info.get("channel_layout", "stereo")
# anullsrc 生成静音，concat(n=2:v=1:a=1) 拼接
f"anullsrc=channel_layout={a_cl}:sample_rate={a_sr},atrim=0:{cover_dur},asetpts=PTS-STARTPTS[a0];"
f"[1:a]aresample={a_sr},aformat=channel_layouts={a_cl}[a1];"
f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
```

**排查步骤**：
1. 在 L369 后加日志打印 `a_sr` 和 `a_cl` 的实际值
2. 确认 `_probe_audio_stream`（`video_service.py` L733-776）是否正确读取了音频流参数
3. 看输出日志中的 sample_rate——如果是 24000Hz 等非标准值，可能是 TTS 服务的输出采样率不标准
4. `anullsrc` 和 `aresample` 使用了探测到的采样率，如果探测结果是错的，anullsrc 生成的静音段采样率不对，concat 后会破坏音频流的采样率一致性

**C. composite_clip 音频混合（第二可能）**

代码在 `composite_clip` L276-287：
```python
"-c:a", "aac",
"-b:a", "128k",
"-t", str(audio_dur),
```

**排查步骤**：
1. 用 `ffprobe` 检查 TTS 输出的音频文件采样率：`ffmpeg -i <tts_audio> 2>&1 | grep Audio`
2. 同样检查 composite_clip 输出的 `mixed_video` 采样率
3. 如果不一致，在 `-c:a aac` 后加 `-ar 44100` 强制统一采样率

**D. 为什么"又出现"**

历史日志中唯一的音频相关修复是"封面 concat 后音轨提前 0.5s"（`memory/2026-07-09.md` L53-58）和"导出视频结尾静止"（tpad 兜底）。都没有涉及音质/变速问题。**这个问题可能是在某个没有记录到本地文件的对话中修复的**。

建议接手者做一次完整的音频链路排查：TTS 输出 → composite_clip 混合 → 封面 concat → 最终输出，每步用 ffprobe 检查采样率。

---

## 4. 项目环境

| 项 | 值 |
|----|----|
| 项目根 | `D:\AI混剪工具测试\short-video-mashup-tool\` |
| 后端端口 | 18000（当前运行中，进程由主线程持久启动） |
| 前端端口 | 5173（Vite，host=localhost→IPv6，勿用 127.0.0.1） |
| Python | `C:\Users\11833\.workbuddy\binaries\python\versions\3.13.12\python.exe` |
| ffmpeg | `D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe`（N-125048） |
| 运行命令 | 后端: `cd "/d/AI混剪工具测试/short-video-mashup-tool/backend" && python main.py` |
| 字体 | 默认 `C:/Windows/Fonts/msyh.ttc`（.ttc 集合，浏览器不支持 @font-face） |

### 启动后端

```bash
cd "/d/AI混剪工具测试/short-video-mashup-tool/backend"
"/c/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe" main.py
```

⚠️ 后端无 `--reload`，改 `.py` 后必须重启。
⚠️ Git Bash 用 Unix 路径：`/d/AI混剪工具测试/...`，不要 `cd /d "D:\..."`。
⚠️ 后端必须由主线程直接启动（subagent 起的进程会被环境清理）。

### 启动前端

```bash
cd "/d/AI混剪工具测试/short-video-mashup-tool"
"/c/Users/11833/.workbuddy/binaries/node/versions/22.22.2/node.exe" ./node_modules/vite/bin/vite.js --config vite.config.ts
```

访问 `http://localhost:5173/`（非 127.0.0.1）。

---

## 5. 关键代码位置速查

| 用途 | 文件:行号 |
|------|----------|
| 封面预览渲染 | `TimelineEditor.tsx` L642-666 |
| 预览框尺寸 | `TimelineEditor.tsx` L600-601（pW=180/240, pH=320） |
| 封面帧生成 | `ai_editing.py` L343-349（cw/ch 计算） |
| 封面 concat + 音频 | `ai_editing.py` L369-415（anullsrc + concat filter） |
| composite_clip 音频混合 | `video_service.py` L243-291 |
| _probe_audio_stream | `video_service.py` L733-776 |
| _render_subtitles | `video_service.py` L324-430 |
| ExportConfirm payload | `ExportConfirm.tsx` L186-210（measureCover + B+ fit） |
| 字体预处理 | `TimelineEditor.tsx` L533-582（CoverEditor font loading） |

---

## 6. 交付物预期

1. **问题 1 排查报告**：确认是代码 bug 还是 WYSIWYG 取舍，给出修复方案或告知用户"之前就如此"
2. **问题 3 排查报告**：定位音轨故障的根因（采样率/封面concat/composite_clip），给出修复方案
3. 修复后全量回归 `pytest backend/tests/ --ignore=_archive`（当前基线 86/87 passed）

**不 commit**（用户未要求）。

---

## 7. 已知边界（接手者注意）

- `test_a_italic_delta_retest[1080-1920-282-35]` 会 FAIL（delta=-3.493%）——这是已知边界，B+ 缩字后 delta<2%，不修
- `test_cover_render.py` 已归档到 `backend/tests/_archive/`
- 系统字体 `msyh.ttc` 浏览器不支持 @font-face，前端已做 CSS 降级处理
- 斜体用 `shear=shx=0.28` 合成（ffmpeg drawtext 无 `fontstyle`），补偿公式在 overlay-x
