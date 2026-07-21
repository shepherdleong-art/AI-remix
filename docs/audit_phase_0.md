# 阶段 0 报告：环境就绪与基线确认

**时间**：2026-07-13 17:23
**状态**：通过（1 个已知边界，不阻断）

## 环境确认

| 组件 | 状态 |
|------|------|
| ffmpeg | ✅ N-125048-gcd199a7d69-20260615 |
| simhei.ttf | ✅ `C:/Windows/Fonts/simhei.ttf` |
| msyh.ttc | ✅ `C:/Windows/Fonts/msyh.ttc` |
| msyhbd.ttc | ✅ `C:/Windows/Fonts/msyhbd.ttc` |
| msyhl.ttc | ✅ `C:/Windows/Fonts/msyhl.ttc` |
| Python 3.13.12 | ✅ |
| 后端 18000 | ✅ 正常响应 `/api/ai-editing/fonts` |

## 基线测试结果

```
test_cover_wysiwyg_regression.py ......... 9/9 PASSED
test_cover_subtitle_stroke_regression.py ........... 12/12 PASSED
test_cover_autofit_regression.py ........ 8/8 PASSED
test_cover_subtitle_audit.py ..................F.......... 24/25 PASSED
────────────────────────────────────────────────
总计: 53/54 PASSED, 1 FAILED
```

## 失败详情

| 测试 | 结果 | deltaX | 场景 |
|------|------|--------|------|
| `test_a_italic_delta_retest[1080-1920-282-35-细节见真章]` | ❌ FAILED | **-3.493%** | 9:16, size=282, tpx=35, 长标题 |

关键值：cy_off=34.91%（近设定 tpy=35），cy_on=35.01%（Y 质心稳定）。

## Path B 论证确认

| 断言 | 结果 | 证据 |
|------|------|------|
| test_b1 non-italic bias < 2% | ✅ PASSED | cx 在 0.5±0.02 内 |
| test_b2 title_size 透传 | ✅ PASSED | fontsize 120→240 文本高 ≈2x |
| test_b4 副标题 Y 定位 | ✅ PASSED | cy≈0.55±0.003 |
| test_b5 画布尺寸 | ✅ PASSED | 9:16=1080×1920, 3:4=1440×1920 |

**结论**：Path B 论证成立——non-italic bias 在可接受范围，text_w 度量偏差 <2%。

## 唯一失败的分析

| 维度 | 说明 |
|------|------|
| 失败场景 | 9:16(1080×1920), size=282, tpx=35（偏心锚点）, "细节见真章" |
| 根因 | 9:16 画布窄（1080px），大字号 + 长标题 + 偏心锚点 → 斜体 shear 漂移量超出 overlay-x 补偿能力（补偿量基于 tpx，与画布宽无关） |
| 实际影响 | **B+ 防裁切会在导出前缩字**（text_w > 1080×0.96），缩字后 delta<2%（test_a_defended_bplus_long_title_passes ✅） |
| 阶段 1 计划 | 补测 `test_a_user_raw_size_delta_matrix` 系统化边界 |

## 路由判定

✅ **继续阶段 1**——test_b1 通过，Path B 成立。1 个 italic delta 失败是已知边界（B+ 缩字后有效），阶段 1 会量化。
