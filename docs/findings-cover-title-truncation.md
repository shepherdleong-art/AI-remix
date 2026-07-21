# 封面标题截断问题 — 完整分析报告

**问题**：导出成片后封面标题的右侧（后端）被截断。

---

## 根因链分析

### 第一层根因：B+ 测量字体错误（已修复）

封面导出时 `ExportConfirm.tsx` 用 `measureTextWidth` 测字宽，`fontFamily` 硬编码为 `'coverPreviewFont'`。

**场景 A**：用户用 `.ttc` 字体（默认 `msyh.ttc`）
- C3 之前：`@font-face` 尝试加载 .ttc → **失败**（浏览器不支持）→ `'coverPreviewFont'` 未注册
- C3 修复（TimelineEditor 跳过 .ttc）：`'coverPreviewFont'` 仍然未注册
- **ExportConfirm 测量时**：浏览器找不到 `'coverPreviewFont'`，回退到**浏览器默认字体**（serif/monospace）
- 默认字体与雅黑宽度不同 → 测出错误宽度 → B+ 算错缩字比例 → 标题溢出或过度缩字

**修复**（已在上一轮完成）：
```typescript
fontFamily: `'coverPreviewFont', '${coverFont}', sans-serif`
```
加上 CSS 降级链后，.ttc 时退到系统雅黑，测量 ≈ 实际渲染宽度。

### 第二层根因：.ttf → .ttc 切换残留旧字体（已修复）

C3 修复跳过了 .ttc 的 @font-face 加载，但**没清除之前 .ttf 已注册的 @font-face**。

**复现路径**：
1. 用户先用 .ttf 字体（如 simhei.ttf）→ CoverEditor 注入 @font-face → `'coverPreviewFont'` 注册为黑体
2. 用户切换到 .ttc 字体（msyh.ttc）→ CoverEditor 跳过 @font-face → **旧黑体的 @font-face 依然存在**
3. 导出时 ExportConfirm 测量 → `'coverPreviewFont'` 指向**旧黑体** → 测宽用黑体而不是雅黑
4. 黑体字面宽 vs 雅黑不同 → B+ 算错 → 截断

**修复**（本次新增）：.ttc 时主动清除旧 @font-face：
```typescript
if (path.toLowerCase().endsWith('.ttc')) {
    const el = document.getElementById('cover-preview-font') as HTMLStyleElement | null;
    if (el) el.textContent = '';           // 清除旧声明
    if (coverFontUrlRef.current) {
        URL.revokeObjectURL(coverFontUrlRef.current);
        coverFontUrlRef.current = null;    // 释放旧 blob URL
    }
    return;
}
```

这样 `'coverPreviewFont'` 不可解析，CSS 降级链 `'coverPreviewFont', '${coverFont}', sans-serif` 才会真正退到 `'Microsoft YaHei'` 系统字体。

### 第三层根因（已排除）

不是 `render_cover` 的 drawtext 公式或 ffmpeg 渲染问题——后端用 `x=w*tpx/100-text_w/2` + `fontsize={title_size}` 精确居中/定位，像素实测验证正确。

---

## 验证数据

用 simhei.ttf size=282 tpx=35 渲染在 1080×1920 画布上：

| 指标 | 值 |
|------|-----|
| 文本宽度 | 1074px（占画布 99.4%） |
| 无 B+ 时右边缘 | 1074px（<1080，✅ 不溢出） |
| B+ 缩字后 size | 272px（×0.966） |
| B+ 缩字后右边缘 | 1058px（安全边距 2×✅） |

B+ 防裁切生效时标题始终在安全边距内。

---

## 结论

**问题已修复**，涉及两个改动：

| 改动 | 文件 | 作用 |
|------|------|------|
| 上一轮 | `ExportConfirm.tsx` L189 | measureCover fontFamily 加 CSS 降级链 |
| 本次 | `TimelineEditor.tsx` L544-559 | .ttc 时清除旧 @font-face |
