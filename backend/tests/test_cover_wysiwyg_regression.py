# -*- coding: utf-8 -*-
"""
封面标题「预览 vs 导出」位置统一性 —— 整体回归 (真实 ffmpeg 渲染 + PIL 填充像素质心)。

测量铁律: 用填充像素质心 (filled-pixel centroid), 禁止 bbox。
  cx = sum(x)/N / W,  cy = sum(y)/N / H  (相对画布百分比)
背景用均匀中灰, 文本=非透明白字+黑描边; 文本像素 = 与角点背景色欧氏距离 > thr。

覆盖:
  A.  本次 Fix A: shear 位移补偿 (italic_on vs italic_off 的 centroid X delta < 2%)
  B1. 非斜体 tpx=50 的 text_w 偏移 (断言 |cx-0.5| < 2%, 已知字体 side-bearing 残留)
  B2. 后端 title_size 透传 (fontsize 120 vs 240 -> 文本高 ~2x, 证明未被截断/重算)
  B4. 非斜体副标题 Y 定位精度 (|cy-0.55| < 0.3%)
  B5. 画布尺寸精确性 (9:16=1080x1920, 3:4=1440x1920)
  过滤字符串: non-italic 逐字节 == w*tpx/100-text_w/2; italic 追加正确补偿量

非斜体路径行为零变化、Y 质心不受 shear 影响 等不变量也一并断言。
"""
import os
import re
import sys

import numpy as np
import pytest
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
for p in (ROOT, BACKEND):
    if p not in sys.path:
        sys.path.insert(0, p)

from services.video_service import render_cover, _build_cover_filter_complex  # noqa: E402

SIMHEI = r"C:/Windows/Fonts/simhei.ttf"
ART = os.path.join(ROOT, ".cover_wysiwyg_test", "pytest_artifacts")
os.makedirs(ART, exist_ok=True)

FONT_ESC = SIMHEI.replace("\\", "/").replace(":", "\\:")

# 中灰背景(既非亮白也非暗黑), 经 yuv 往返后仍是中调
BG_HEX = "0x808040"
CORNER = 24
THR = 55


def _ffmpeg_ok():
    try:
        from services.video_service import _ffmpeg
        return os.path.exists(_ffmpeg())
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not (os.path.exists(SIMHEI) and _ffmpeg_ok()),
    reason="ffmpeg / simhei 字体不可用",
)


def _gen_bg(w, h):
    p = os.path.join(ART, f"_bg_{w}x{h}.mp4")
    if os.path.exists(p):
        return p
    from services.video_service import _ffmpeg
    cmd = [_ffmpeg(), "-y", "-f", "lavfi", f"-i", f"color=c={BG_HEX}:s={w}x{h}:d=2",
           "-pix_fmt", "yuv420p", p]
    import subprocess
    subprocess.run(cmd, capture_output=True, timeout=60, check=True)
    return p


def _filled_centroid(png):
    img = Image.open(png).convert("RGB")
    arr = np.asarray(img).astype(np.int32)
    H, W = arr.shape[:2]
    bg = arr[:CORNER, :CORNER].reshape(-1, 3).mean(axis=0)
    dist = np.sqrt(((arr - bg) ** 2).sum(axis=2))
    mask = dist > THR
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None, None, 0
    return float(xs.mean()) / W, float(ys.mean()) / H, len(xs)


def _render(title, subtitle, style, w, h, bg):
    out = os.path.join(ART, f"_r_{abs(hash((title, subtitle, tuple(sorted(style.items()))))) % 10**9}.mp4")
    render_cover(bg, 1.0, title, subtitle, style, out, w, h, duration=0.5)
    return out + ".cover.png"


def _base(**over):
    s = dict(font_path=SIMHEI, title_color="white", title_stroke_color="black",
             title_stroke_width=3, sub_color="white", sub_stroke_color="black",
             sub_stroke_width=3, title_x=50, title_y=35, title_size=120,
             sub_x=50, sub_y=55, sub_size=120, zoom=1.0, offset_x=0, offset_y=0,
             title_italic=False, sub_italic=False)
    s.update(over)
    return s


# ───────────────────────── A. Fix A: shear 位移补偿 ─────────────────────────
@pytest.mark.parametrize("label,tpy,text", [
    ("主标题", 35, "今日热点速览"),
    ("副标题", 55, "精彩内容推荐"),
    ("测", 35, "测"),
])
def test_fix_a_shear_compensation(label, tpy, text):
    bg = _gen_bg(1440, 1920)
    off_png = _render(text, "", _base(title=text, title_y=tpy, title_italic=False), 1440, 1920, bg)
    on_png = _render(text, "", _base(title=text, title_y=tpy, title_italic=True), 1440, 1920, bg)
    cx_off, cy_off, n_off = _filled_centroid(off_png)
    cx_on, cy_on, n_on = _filled_centroid(on_png)
    assert n_off > 100 and n_on > 100, "文本像素过少, 渲染可能失败"
    delta = (cx_on - cx_off) * 100
    # 验收: |italic_on_x - italic_off_x| < 2%
    assert abs(delta) < 2.0, f"{label}: shear 补偿后 centroid X delta={delta:+.3f}% 超过 2%"
    # Y 质心不受 shear 影响, 应≈设定 tpy
    assert abs(cy_on - tpy / 100) < 0.005, f"{label}: Y 质心 {cy_on*100:.3f}% 偏离设定 {tpy}%"
    # 非 italic 路径: x 表达式为纯居中 w*tpx/100-text_w/2, 不含任何偏差补偿项/尾部带符号数字
    # (Path B: 不修正 text_w 度量偏差, 导出与预览保持同一 text_w 居中位置, 即 WYSIWYG)
    fc = _build_cover_filter_complex([(text, 50, tpy, 120, "white", "black", 3, 0.0)], 1440, 1920, FONT_ESC)
    assert re.search(r"x=w\*50/100-text_w/2(?![\+\-])", fc) is not None


def test_fix_a_compensation_formula():
    """shear 补偿经 overlay x 偏移施加: overlay=x = shear_comp = shx*(h*tpy/100 - h/2)。
    (Path B: drawtext x 为纯居中 w*tpx/100-text_w/2, 不含 text_w 度量偏差补偿项;
    shear 补偿此前在 drawtext x, 现改到 overlay 以避免把宽标题推出左画布边缘导致裁切。)
    """
    tpy = 35
    expected = 0.28 * (1920 * tpy / 100 - 1920 / 2)  # = -80.64
    # italic 行: overlay x 应≈ shear_comp; drawtext x 应为纯居中 (无偏差项/无尾部带符号数字)
    fc_on = _build_cover_filter_complex([("测试", 50, tpy, 120, "white", "black", 3, 0.28)], 1440, 1920, FONT_ESC)
    m_ov = re.search(r"overlay=x=([+-][0-9.]+)", fc_on)
    assert m_ov is not None, "italic overlay 未施加 shear 补偿量"
    assert abs(float(m_ov.group(1)) - expected) < 1e-6, f"overlay 补偿量应为 {expected}, 实际 {m_ov.group(1)}"
    assert re.search(r"x=w\*50/100-text_w/2(?![\+\-])", fc_on) is not None
    # non-italic 行: overlay x≈0, drawtext x 同为纯居中
    fc_off = _build_cover_filter_complex([("测试", 50, tpy, 120, "white", "black", 3, 0.0)], 1440, 1920, FONT_ESC)
    m_ov0 = re.search(r"overlay=x=([+-][0-9.]+)", fc_off)
    assert m_ov0 is not None and abs(float(m_ov0.group(1))) < 1e-6, f"non-italic overlay x 应为 0, 实际 {m_ov0.group(1) if m_ov0 else None}"


# ───────────────────────── B1. 非斜体 text_w 偏移 ─────────────────────────
def test_b1_non_italic_text_w_offset():
    """非斜体 tpx=50: 导出 centroid X 应≈0.5; 已知仅字体 side-bearing 残留 (<2%), 非 5.5% 左偏。"""
    bg = _gen_bg(1440, 1920)
    for text in ("测", "测试标题"):
        png = _render(text, "", _base(title=text, title_y=50, title_size=200, title_italic=False), 1440, 1920, bg)
        cx, cy, n = _filled_centroid(png)
        assert n > 100
        # 断言无整体性左偏(>2%); 实测残差<1% 为字体 side-bearing, 已知残留
        assert abs(cx - 0.5) < 0.02, f"'{text}': centroid X={cx*100:.3f}% 偏离 0.5 超过 2% (疑似左偏回归)"


# ───────────────────────── B2. 后端 title_size 透传 ─────────────────────────
def test_b2_title_size_passthrough():
    """后端应直接透传前端算好的 title_size, 不被截断/重算。
    渲染 fontsize=120 与 240, 文本可见高应 ~2x (证明尺寸被如实使用, 对应前端 ×COVER_SCALE)。"""
    bg = _gen_bg(1440, 1920)

    def text_height(size):
        png = _render("标题尺寸", "", _base(title="标题尺寸", title_y=50, title_size=size), 1440, 1920, bg)
        img = Image.open(png).convert("RGB")
        arr = np.asarray(img).astype(np.int32)
        bgc = arr[:CORNER, :CORNER].reshape(-1, 3).mean(axis=0)
        mask = np.sqrt(((arr - bgc) ** 2).sum(2)) > THR
        ys, _ = np.where(mask)
        return ys.max() - ys.min() + 1

    h120 = text_height(120)
    h240 = text_height(240)
    assert h120 > 20 and h240 > 20
    ratio = h240 / h120
    assert 1.7 < ratio < 2.3, f"fontsize 120->240 文本高比={ratio:.3f}, 期望≈2 (title_size 未被正确透传)"


# ───────────────────────── B4. 非斜体副标题 Y 定位精度 ─────────────────────────
def test_b4_subtitle_y_precision():
    bg = _gen_bg(1440, 1920)
    png = _render("", "副标题内容定位", _base(title="", subtitle="副标题内容定位",
                                             sub_y=55, sub_size=120, sub_italic=False, sub_x=50), 1440, 1920, bg)
    cx, cy, n = _filled_centroid(png)
    assert n > 100
    assert abs(cy - 0.55) < 0.003, f"副标题 Y centroid={cy*100:.3f}% 误差 {(cy-0.55)*100:+.3f}% 超 0.3%"


# ───────────────────────── B5/B3. 画布尺寸精确性 ─────────────────────────
@pytest.mark.parametrize("w,h,ratio", [(1080, 1920, 0.5625), (1440, 1920, 0.75)])
def test_b5_canvas_dimensions(w, h, ratio):
    bg = _gen_bg(w, h)
    png = _render("尺寸", "", _base(title="尺寸", title_y=50), w, h, bg)
    im = Image.open(png)
    ow, oh = im.size
    assert (ow, oh) == (w, h), f"渲染帧 {ow}x{oh} != 期望 {w}x{h}"
    assert abs(ow / oh - ratio) < 1e-6, f"比例 {ow/oh:.4f} != {ratio}"
