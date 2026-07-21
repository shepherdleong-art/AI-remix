# 封面标题位置统一性 — Fix A + 整体回归

## TL;DR
修复 ffmpeg 斜体合成（shear）引入的几何位移，使导出斜体视觉中心对齐预览真斜体；并独立复测之前所有提过的问题，确认均已解决或无害。

## 根因
ffmpeg `drawtext` 无 `fontstyle`，斜体靠 `shear=shx=0.28` 合成，绕画布中心（y=H/2）倾斜 → 文字块按垂直位置水平漂移（上半右移、下半左移）。预览用浏览器真斜体（`fontStyle:'italic'`）几何居中 → 两者不一致，即"位置不统一"。

## 修复
`backend/services/video_service.py` 的 `_build_cover_filter_complex`：对 italic 行在 x 表达式追加 `shear_comp = shx*(h*tpy/100 - h/2)` 补偿（`x=w*tpx/100-text_w/2 - shear_comp`）；非 italic 行 shx=0，x 逐字节不变。Y 表达式、letterbox、其它文件均未动。

## 验证（真实 ffmpeg 渲染 + PIL 填充像素质心，禁用 bbox）

| 行 | tpy | 修复后 delta(on−off) |
|----|-----|----------------------|
| 主标题 | 35 | −0.026% |
| 副标题 | 55 | +0.019% |
| 单行「测」 | 35 | +0.034% |

最大 `|delta| = 0.034% ≪ 2%` ✅（比工程师自报更优）；画布精确 1440×1920（3:4），Y 质心、非斜体路径均不受影响。

## 整体排查结论（QA 独立复测）

| 之前提到的问题 | 结论 |
|----------------|------|
| 斜体 shear 位移 | ✅ 已修（Fix A） |
| text_w 整体左偏 5.5% | ⚠️ 测量假象：真实 <1% 且导出/预览同字体一致 → 不修（option B 不值得做） |
| 字幕比调整的小（字号缩放） | ✅ 已解决（COVER_SCALE=6 透传未被本次改动影响） |
| 3:4 vs 9:16 混合 / letterbox | ✅ 无害 no-op（比例一致时 iw==ow，pad 偏移 0） |
| Y 定位精度 | ✅ 误差 <0.1% |
| 画布精确 3:4 / 9:16 | ✅ 无拉伸 |

## 测试
- 新增 `backend/tests/test_cover_wysiwyg_regression.py`：9/9（真实 ffmpeg + PIL 测量）
- 关联封面测试合计：12/12；italic 用例 13/13；**通过率 100%**
- 智能路由：**NoOne**（无需回修）

## 生效须知
- 改动在后端 `video_service.py` → 后端若未带 `--reload`，**必须重启后端**加载新代码；前端未改，无需刷新。
- 已知残留：simhei 字体 side-bearing 致非斜体标题 centroid X 偏离 0.5 约 +0.3%~+0.8%（同向右偏），导出与预览一致，无可见失配，建议不修。
