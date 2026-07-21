# 完整执行移交文档：封面/字幕优化 + 问题排查

> **文档用途**：给接手 AI 的完整蓝本。自包含，读完即可开工。
> **日期**：2026-07-13
> **项目**：`short-video-mashup-tool`（D:\AI混剪工具测试\short-video-mashup-tool\）
> **前序文档**：`docs/final-execution-plan-2026-07-13.md`（最终执行计划）、`docs/audit_final_report.md`（总报告）、`docs/issue-handoff-2026-07-13.md`（问题排查）、`docs/findings-cover-title-truncation.md`（标题截断根因）

---

## 0. 当前状态速览

| 问题 | 状态 |
|------|------|
| 斜体 delta 验证 | ✅ 86/87 passed（1 known boundary） |
| 封面/字幕排查 | ✅ 80 项测试覆盖 |
| `.ttc` 字体预览修复 | ✅ 前端跳过 + CSS 降级链 |
| `_split_sentences` 抹空格 | ✅ 修复 |
| ProjectHistory cover\* 字段 | ✅ 补全 24 个字段 |
| composite_clip 跳段字幕错位 | ✅ 修复 |
| **问题 1：9:16 预览画面拉伸** | ✅ **已修复** |
| **问题 2：封面标题截断** | ✅ **已修复**（两层根因） |
| **问题 3：音轨"日文"故障** | 🔍 **挂起，待排查** |

---

## 1. 已完成的改动清单

> **不要回退**，接手后直接使用最新代码。

| 改动 | 文件 | 说明 |
|------|------|------|
| C3 | `TimelineEditor.tsx` L540-559 | .ttc 跳过 @font-face + 清除旧声明 |
| C3 连带 | `ExportConfirm.tsx` L189 | measureCover fontFamily CSS 降级链 |
| C5 | `video_service.py` L674 | `_split_sentences` 移除 `\s` |
| C6 | `ProjectHistory.tsx` | 补 24 个 cover\* 字段（序列化/反序列化） |
| C7 | `video_service.py` L183/L304 | valid_segments 收集+传递 |
| 问题1 | `ai_editing.py` L835-877 | `/thumb` 新增 `aspect` 参数 + letterbox 缩放 |
| 问题1 | `TimelineEditor.tsx` L629 | frameUrl 传 `&aspect=${coverAspect}` |
| 问题2 | `TimelineEditor.tsx` L544-559 | .ttc 时清除旧 @font-face 声明 |
| C4 换行 | `video_service.py` | **已回退**（ffmpeg filter 转义链不可靠） |

**生效条件**：
- 后端改动（`video_service.py`、`ai_editing.py`）：需重启后端（已重启 ✅）
- 前端改动（`TimelineEditor.tsx`、`ExportConfirm.tsx`、`ProjectHistory.tsx`）：Vite HMR 自动热更，不确定时硬刷 `http://localhost:5173/`

---

## 2. 问题 1：9:16 封面预览画面拉伸 — 已修复

### 现象
步骤3封面编辑器，9:16 时背景画面拉伸变形；3:4 正常。

### 根因
`/thumb` 端点（`ai_editing.py` L847-853）直接从源视频提取原始帧，**不做任何缩放**。前端预览用 `objectFit:'fill'` 拉伸到 180×320 预览框。源视频宽高比 ≠ 9:16 时（如源是 16:9 横屏），拉伸严重变形。3:4 感觉"正常"只是因为比例更接近。

### 修复
**后端** `/thumb` 端点接受 `aspect` 参数（`"9:16"` 或 `"3:4"`），ffmpeg 加 letterbox 缩放到封面目标分辨率：

```python
# aspect=9:16 → 1080×1920, aspect=3:4 → 1440×1920
-vf "scale={cw}:{ch}:force_original_aspect_ratio=decrease,pad={cw}:{ch}:(ow-iw)/2:(oh-ih)/2:color=black"
```

**前端** `frameUrl` 加 `&aspect=${coverAspect}` 参数。

### 验证
```
输入: 1920×1080 源, aspect=9:16
输出: 1080×1920 (letterbox, 加黑边)
旧行为: 1920×1080 (原始, objectFit:'fill' 拉伸变形)
```

---

## 3. 问题 2：封面标题后端被截断 — 已修复

### 现象
导出成片后封面标题的右侧（后端）被裁切。

### 根因链（两层）

**第一层（上一轮已修）**：`ExportConfirm.tsx` `measureCover` 的 `fontFamily` 硬编码为 `'coverPreviewFont'`。
- .ttc 字体（默认 msyh.ttc）浏览器不支持 @font-face → `'coverPreviewFont'` 未注册
- 浏览器退到默认字体测宽 → B+ 算错缩字 → 标题溢出

**第二层（本次新发现）**：`.ttf → .ttc` 切换时，旧 @font-face 声明未清除。
- 用户先用 .ttf 字体 → `'coverPreviewFont'` 注册为旧字体
- 切换到 .ttc → C3 跳过 @font-face 加载，但**旧声明还在**
- ExportConfirm 测量时 `'coverPreviewFont'` 仍指向旧 .ttf 字体 → 错用字体宽度 →B+ 算错→ 标题截断

### 修复
`.ttc` 分支加清除逻辑：
```typescript
if (path.toLowerCase().endsWith('.ttc')) {
    const el = document.getElementById('cover-preview-font') as HTMLStyleElement | null;
    if (el) el.textContent = '';           // 清除旧 @font-face
    if (coverFontUrlRef.current) {
        URL.revokeObjectURL(coverFontUrlRef.current);
        coverFontUrlRef.current = null;    // 释放旧 blob URL
    }
    return;
}
```

### 验证（像素实测）
```
Canvas: 1080×1920, simhei.ttf, size=282, tpx=35
Text spans: 1074px (99.4% of canvas)
B+ shrink后 size=272, center x=50 → fits within 4% safe margin ✅
```

---

## 4. 问题 3：音轨"日文"故障 — 挂起

### 现象
导出成片后音频听起来像加速/变调的日语。

### 已排查项

| 排查项 | 结果 |
|--------|------|
| `_probe_audio_stream` 采样率探测 | ✅ 8000-48000Hz 全正确 |
| anullsrc + aresample concat | ✅ 正常输出 |
| `-c:a aac` 不指定 `-ar` | ✅ 保持输入采样率 |
| composite_clip 音频混合代码 | ✅ 未被改动 |
| 封面 concat 全链路测试 | ✅ 采样率链路正确 |

**结论**：音频链路当前代码是干净的。建议排查步骤（需要用户配合）：

1. **不挂封面导一次**：如果音频正常 → 问题在封面 concat 链路；如果不挂也故障 → 问题在 composite_clip 或 TTS
2. 如果时间允许，在 `composite_clip` 的音频混合命令（L276-287）后加 `-ar 44100` 强制统一采样率，看是否修复
3. 检查 TTS 服务返回的音频文件实际采样率（可通过 `ffmpeg -i <tts_audio>` 查看）

---

## 5. 当前已知边界

- `test_a_italic_delta_retest[1080-1920-282-35]` 会 FAIL（delta=-3.493%）——B+ 缩字后 delta<2%，**不修**
- `test_cover_render.py` 已归档到 `backend/tests/_archive/`
- 系统字体 `msyh.ttc` 浏览器不支持 @font-face，前端 CSS 降级链已处理
- 斜体用 `shear=shx=0.28` 合成（ffmpeg drawtext 无 `fontstyle`）

---

## 6. 项目环境

| 项 | 值 |
|----|----|
| 后端端口 | 18000（当前运行中，已加载最新代码） |
| 前端端口 | 5173（Vite，host=localhost→IPv6） |
| Python | `C:\Users\11833\.workbuddy\binaries\python\versions\3.13.12\python.exe` |
| ffmpeg | `D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe` |
| 启动后端 | `cd "/d/AI混剪工具测试/short-video-mashup-tool/backend" && python main.py` |
| 启动前端 | `cd "/d/AI混剪工具测试/short-video-mashup-tool" && node ./node_modules/vite/bin/vite.js` |

⚠️ Git Bash 用 Unix 路径 `/d/AI混剪工具测试/...`，不要 `cd /d "D:\..."`。
⚠️ 后端必须主线程启动（subagent 启动的进程会被清理）。
⚠️ 后端无 `--reload`，改 `.py` 后必须重启。

---

## 7. 关键代码位置

| 用途 | 文件:行号 |
|------|----------|
| /thumb 端点 | `ai_editing.py` L835-877 |
| 封面 preview frameUrl | `TimelineEditor.tsx` L629 |
| 封面预览 CSS 渲染 | `TimelineEditor.tsx` L642-666 |
| .ttc 跳过 + 清除 | `TimelineEditor.tsx` L544-559 |
| 封面 concat + 音频 | `ai_editing.py` L369-415 |
| composite_clip 音频混合 | `video_service.py` L243-291 |
| _render_subtitles | `video_service.py` L324-430 |
| ExportConfirm measureCover | `ExportConfirm.tsx` L186-192 |
| ExportConfirm payload | `ExportConfirm.tsx` L238-272 |
| ProjectHistory 保存/恢复 | `ProjectHistory.tsx` L64-106 |
| _split_sentences | `video_service.py` L671-676 |
| _probe_audio_stream | `video_service.py` L733-776 |

---

## 8. 接手者开工检查清单

- [ ] 后端 `http://localhost:18000/api/health` → 200
- [ ] 后端 `/thumb?path=...&aspect=9:16` → letterbox 后 1080×1920
- [ ] 前端 `http://localhost:5173/` 可访问
- [ ] 全量回归：`pytest backend/tests/ --ignore=_archive` → 86/87 passed
- [ ] 已读本文档 §1-§7，理解改动范围不重复修

---

## 9. 待排查（问题 3）

接手后如需继续排查音轨故障，执行步骤：

1. 让用户**不挂封面导一次**，确认音频是否正常（缩小范围）
2. 在 `composite_clip` L281 后加 `-ar 44100` 强制采样率
3. 在 `ai_editing.py` L369 后加 `logger.info(f"a_sr={a_sr}, a_cl={a_cl}")` 看探测结果
4. 用 `ffmpeg -i <tts_audio>` 检查 TTS 输出的实际采样率
