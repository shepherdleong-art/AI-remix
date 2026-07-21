# 阶段 1 报告：C1 斜体 delta 验证 + C3 .ttc 修复 + C5 _split_sentences 修复

**时间**：2026-07-13
**状态**：✅ 通过（46/47 passed, 1 known boundary）

## C1 — 斜体 delta 验证

### 原有测试
34/35 passed（同阶段 0 基线）
- `test_a_italic_delta_retest[1080-1920-282-35]` → FAILED delta=-3.493%（已知边界，见下）

### 新增：test_a_user_raw_size_delta_matrix（10/10 ✅）
量化了"不经 B+ 缩字"的原始字号 delta 矩阵：

| 场景 | delta | non-italic bias | B+ 是否缩字 | 结论 |
|------|-------|----------------|------------|------|
| 1440, size120, tpx35 | +0.067% | +0.96% | No | OK |
| 1440, size200, tpx35 | +0.082% | +1.71% | No | OK |
| 1440, size282, tpx35 | +0.398% | +10.58% | No | OK |
| 1440, size336, tpx35 | +0.090% | +16.39% | No | OK |
| 1080, size120, tpx35 | +0.089% | +1.27% | No | OK |
| 1080, size200, tpx35 | +0.415% | +8.46% | No | OK |
| **1080, size282, tpx35** | **-3.493%** | +19.14% | **Yes** | 已知边界 |
| **1080, size336, tpx35** | **-4.647%** | +18.95% | **Yes** | 已知边界 |
| 1440, size282, tpx50 | -0.042% | +2.39% | Yes | 已知边界 |
| 1080, size282, tpx50 | -0.216% | +2.35% | Yes | 已知边界 |

**核心结论**：B+ 不缩字的场景下 delta 全在 2% 内；B+ 缩字的场景下 delta 可能超 2%，但 B+ 缩字后用户实际字号变小，delta 恢复 <2%（test_a_defended_bplus_long_title_passes ✅）。斜体修复在用户实际使用场景下有效。

## C3 — .ttc 字体预览修复

**改动**：`TimelineEditor.tsx`
1. CoverEditor 字体加载 useEffect 中增加 `.ttc` 跳过逻辑（L539-543）
2. 4 处 `fontFamily: COVER_PREVIEW_FONT_FAMILY` 改为 CSS 降级链 `fontFamily: "'coverPreviewFont', '{coverFont}', sans-serif"`

**验证**：pytest 无法验证前端 CSS 效果，代码审查确认：
- `.ttc` 跳过逻辑与字幕侧 `loadFontFace` (L103) 一致
- CSS 降级链写法正确，'.ttc' 时 'coverPreviewFont' 未注册，浏览器自动降级到 `coverFont`（如 'Microsoft YaHei' 系统字体）→ sans-serif
- blob URL revoke 逻辑未受影响（.ttc 提前 return 不创建 blob）

## C5 — _split_sentences 抹空格修复

**改动**：`video_service.py` L674
- `re.sub(r'[\u201c\u201d\u2018\u2019\u300c\u300d\s]+', '', text)` → `re.sub(r'[\u201c\u201d\u2018\u2019\u300c\u300d]+', '', text.strip())`
- 从字符类移除 `\s`，改为只 trim 首尾

**测试**：4/4 ✅ `backend/tests/test_video_service.py`
- `test_split_sentences_preserves_spaces` → "Hello world." 保留空格
- `test_split_sentences_chinese` → 中文切分正常
- `test_split_sentences_mixed` → 中英混排保留空格
- `test_split_sentences_quotes_removed` → 引号清理正常

## 路由判定

✅ **继续阶段 2** — 1 个已知边界（已量化），其余全绿。
