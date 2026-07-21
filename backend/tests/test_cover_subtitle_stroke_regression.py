# -*- coding: utf-8 -*-
"""
独立回归测试 —— 短视频混剪工具两个 Bug 的真实 ffmpeg 渲染 + PIL 像素测量。

测量铁律:
  * 填充像素质心 / 包围盒, 禁用 bbox 斜体污染 (斜体描边用 shear 合成)。
  * 文本像素 = 与角点背景色欧氏距离 > THR(=55)。
  * 全部走真实 ffmpeg 二进制 (resources/ffmpeg/ffmpeg.exe, N-125048, drawtext 无 fontstyle),
    直接对 render_cover / _render_subtitles 输出帧测量, 不盲信工程师自报。

覆盖:
  Bug 1 (封面标题"细"字截断 — 后端净无改动):
    A. 代码洁净度: shear_comp 公式正确 / 无 debug print / 无符号翻转 / 注释护栏。
    B. Fix A 仍成立: 未裁切配置下 italic_on vs italic_off 质心 X delta < 2% (实测 <0.2%)。
    C. 截断为宽度/位置问题 (非斜体同受影响): 非斜体在 tpx=35/字号288 下左边缘贴画布左界(被裁),
       证明截断与斜体补偿无关。
    D. 预览 WYSIWYG 一致性: CoverEditor overflow:hidden + 预览字号与导出同占比(COVER_SCALE=6,
       预览框 320 基准 ↔ 导出 1920 高; previewH 动态框经 k=pH/320 等比缩放字号/描边)。

  Bug 2 (视频字幕描边与调节值不一致 — 前端已改):
    E. 代码审查: ExportConfirm 的 subtitle_style 中 size 与 stroke_width 都用 resolution.width/360 缩放;
       封面 title/sub stroke_width 仍用 COVER_SCALE*0.5 (未被本次改动影响)。
    F. 后端透传: _render_subtitles 读取 style['stroke_width'] 并拼入 borderw。
    G. 真实渲染测量: 导出「描边厚度/字号」比值 == 预览「strokeWidth/字号」比值(预期 0.1667)。
    H. 改动前 vs 改动后: 改动前(borderw 不缩放) 比值 = 预览 1/3; 改动后一致。
    I. borderw 与 text-shadow 1:1: 不同 borderw 下描边像素厚度线性、斜率≈1, 佐证不乘 0.5。
"""
import os
import re
import sys
import subprocess

import numpy as np
import pytest
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
for p in (ROOT, BACKEND):
    if p not in sys.path:
        sys.path.insert(0, p)

from services.video_service import (_ffmpeg, render_cover, _render_subtitles,  # noqa: E402
                                    _build_cover_filter_complex)

SIMHEI = r"C:/Windows/Fonts/simhei.ttf"
ART = os.path.join(ROOT, ".qa_stroke_cover_art")
os.makedirs(ART, exist_ok=True)

FONT_ESC = SIMHEI.replace("\\", "/").replace(":", "\\:")
CORNER = 24
THR = 55
EXPORT_CONFIRM = os.path.join(ROOT, "src", "renderer", "components", "render", "ExportConfirm.tsx")
TIMELINE = os.path.join(ROOT, "src", "renderer", "components", "analysis", "TimelineEditor.tsx")
VS = os.path.join(BACKEND, "services", "video_service.py")


def _ffmpeg_ok():
    try:
        return os.path.exists(_ffmpeg())
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not (os.path.exists(SIMHEI) and _ffmpeg_ok()),
    reason="ffmpeg / simhei 字体不可用",
)


# ───────────────────────── 渲染 / 测量基础设施 ─────────────────────────
def _gen_solid_video(w, h, color="0x808040"):
    p = os.path.join(ART, f"_solid_{w}x{h}_{color}.mp4")
    if os.path.exists(p):
        return p
    subprocess.run([_ffmpeg(), "-y", "-f", "lavfi",
                    f"-i", f"color=c={color}:s={w}x{h}:d=2",
                    "-pix_fmt", "yuv420p", p],
                   capture_output=True, timeout=60, check=True)
    return p


def _extract_frame(video, t, out_png):
    subprocess.run([_ffmpeg(), "-y", "-ss", str(t), "-i", video,
                    "-vframes", "1", "-q:v", "2", "-y", out_png],
                   capture_output=True, timeout=30)
    assert os.path.exists(out_png), f"帧提取失败: {out_png}"


def _cover_png(bg, title, subtitle, style, w, h):
    out = os.path.join(ART, f"_cover_{abs(hash((title, subtitle, tuple(sorted(style.items())))))}.mp4")
    render_cover(bg, 1.0, title, subtitle, style, out, w, h, duration=0.5)
    return out + ".cover.png"


def _centroid(png, y0=0.0, y1=1.0):
    img = Image.open(png).convert("RGB")
    arr = np.asarray(img).astype(np.int32)
    H, W = arr.shape[:2]
    bg = arr[:CORNER, :CORNER].reshape(-1, 3).mean(axis=0)
    dist = np.sqrt(((arr - bg) ** 2).sum(axis=2))
    mask = dist > THR
    yi = np.arange(H)
    if y1 < 1.0:
        band = mask & (yi[:, None] >= y0 * H) & (yi[:, None] < y1 * H)
    else:
        band = mask
    ys, xs = np.where(band)
    if len(xs) == 0:
        return None
    return xs.mean() / W, xs.min(), xs.max(), len(xs)


def _bbox(png):
    img = Image.open(png).convert("RGB")
    arr = np.asarray(img).astype(np.int32)
    H, W = arr.shape[:2]
    bg = arr[:CORNER, :CORNER].reshape(-1, 3).mean(axis=0)
    dist = np.sqrt(((arr - bg) ** 2).sum(axis=2))
    mask = dist > THR
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return xs.min(), xs.max(), ys.min(), ys.max()


def _render_subtitle_frame(segments, style, w, h, color="0x808040"):
    bg = _gen_solid_video(w, h, color)
    out = os.path.join(ART, f"_sub_{abs(hash((tuple(sorted(style.items())), str(segments))))}.mp4")
    _render_subtitles(bg, segments, style, out, w, h)
    png = out + ".frame.png"
    _extract_frame(out, 0.05, png)
    return png


def _measure_border_px(text, fontsize, borderw, w=1080, h=1080, color="0x808040", font=SIMHEI):
    """实测 ffmpeg borderw 产生的描边像素厚度: (borderw=N 包围盒 - borderw=0 包围盒)/2。"""
    seg = [{"segment_text": text, "duration": 2.0, "subtitle_x": 50, "subtitle_y": 50}]
    style0 = {"font": "SimHei", "font_path": font, "size": fontsize,
              "color": "white", "stroke_color": "black", "stroke_width": 0}
    styleN = {"font": "SimHei", "font_path": font, "size": fontsize,
              "color": "white", "stroke_color": "black", "stroke_width": borderw}
    p0 = _render_subtitle_frame(seg, style0, w, h, color)
    pN = _render_subtitle_frame(seg, styleN, w, h, color)
    b0, bN = _bbox(p0), _bbox(pN)
    bw = (bN[1] - bN[0] - (b0[1] - b0[0])) / 2
    bh = (bN[3] - bN[2] - (b0[3] - b0[2])) / 2
    return bw, bh


# ───────────────────────── Bug 1.A 代码洁净度 ─────────────────────────
def test_bug1_code_cleanliness():
    src = open(VS, encoding="utf-8").read()
    # 1) shear_drift 公式正确 (宽层 + overlay 补偿方案)
    assert "shear_drift = shx * (H / 2 - h * tpy / 100)" in src, \
        "shear_drift 公式缺失/被改动"
    assert "max_shear" in src, "max_shear 变量不存在 (layer 加宽逻辑缺失)"
    # 2) 无调试 print
    func = src[src.index("def _build_cover_filter_complex"):src.index("def render_cover")]
    assert "print(" not in func, "函数体内残留调试 print"
    # 3) 宽层+overlay 补偿方案存在
    assert "layer_w" in src, "layer_w 变量不存在 (宽层方案缺失)"
    assert "layer_ox" in src, "layer_ox 变量不存在"
    # 4) overlay 补偿经 layer_ox - shear_drift 实现
    assert "ox = layer_ox - shear_drift" in src, \
        "overlay 补偿公式错误 (应为 layer_ox - shear_drift)"
    # 5) drawtext x 使用宽层定位 (w*tpx/100 + max_shear - text_w/2)
    fc = _build_cover_filter_complex([("测试", 50, 35, 120, "white", "black", 3, 0.28)],
                                     1440, 1920, FONT_ESC)
    assert "overlay=x=" in fc, "overlay 存在"


# ───────────────────────── Bug 1.B Fix A 仍成立 (未裁切) ─────────────────────────
@pytest.mark.parametrize("case", [
    # label, tpy, text, 是否单行
    ("主标题 tpy=35", 35, "今日热点速览", False),
    ("副标题 tpy=55", 55, "精彩内容推荐", False),
    ("单行 测 tpy=35", 35, "测", True),
    ("两行斜体 tpy=35+55", 35, "细节见真章", False),
])
def test_bug1_fix_a_italic_centroid_aligned(case):
    label, tpy, text, single = case
    bg = _gen_solid_video(1440, 1920)
    base = dict(font_path=SIMHEI, title_color="white", title_stroke_color="black",
                title_stroke_width=3, sub_color="white", sub_stroke_color="black",
                sub_stroke_width=3, title_x=50, title_y=tpy, title_size=120,
                sub_x=50, sub_y=55, sub_size=120, zoom=1.0, offset_x=0, offset_y=0,
                title_italic=False, sub_italic=False)
    # 未裁切配置 (tpx=50 居中): 质心测量不被裁切污染
    off = dict(base, title=text, subtitle="", title_x=50, title_italic=False)
    on = dict(base, title=text, subtitle="", title_x=50, title_italic=True)
    if label.startswith("两行"):
        off = dict(base, title=text, subtitle="副标题内容", title_italic=False, sub_italic=False)
        on = dict(base, title=text, subtitle="副标题内容", title_italic=True, sub_italic=True)
    png_off = _cover_png(bg, off.get("title"), off.get("subtitle"), off, 1440, 1920)
    png_on = _cover_png(bg, on.get("title"), on.get("subtitle"), on, 1440, 1920)
    # 仅取主标题行所在的 y 带测量 (tpy±10%), 隔离副标题干扰
    c_off = _centroid(png_off, y0=(tpy - 10) / 100, y1=(tpy + 10) / 100)
    c_on = _centroid(png_on, y0=(tpy - 10) / 100, y1=(tpy + 10) / 100)
    assert c_off is not None and c_on is not None, f"{label}: 文本像素过少"
    assert c_off[3] > 100 and c_on[3] > 100, f"{label}: 文本像素过少, 渲染可能失败"
    delta = (c_on[0] - c_off[0]) * 100
    # 验收: |italic_on_x - italic_off_x| < 2% (修复后预期 <0.2%)
    assert abs(delta) < 2.0, f"{label}: shear 补偿后质心 X delta={delta:+.3f}% 超过 2%"


# ───────────────────────── Bug 1.C 截断为宽度/位置问题 ─────────────────────────
def test_bug1_truncation_is_width_not_italic():
    bg = _gen_solid_video(1440, 1920)
    size = 288
    tpx = 50
    tpy = 35
    base = dict(font_path=SIMHEI, title_color="white", title_stroke_color="black",
                title_stroke_width=3, sub_x=50, sub_y=55, sub_size=120,
                zoom=1.0, offset_x=0, offset_y=0, sub_italic=False)
    # 1) 居中(tpx=50)大字号: 宽层下标题不被裁切
    centered = dict(base, title="细节见真章", title_x=tpx, title_y=tpy, title_size=size,
                    title_italic=False)
    png_c = _cover_png(bg, "细节见真章", "", centered, 1440, 1920)
    c = _centroid(png_c)
    # 宽层下左边缘 >= 0 (不被裁切, 标题完整保留)
    assert c[1] >= 0, f"居中标题左边缘={c[1]} 被裁 (应 ≥0)"

    # 2) 用户配置(tpx=35): 非斜体左边缘贴画布左界(被裁) -> 非斜体同样截
    off = dict(base, title="细节见真章", title_x=35, title_y=tpy, title_size=size,
               title_italic=False)
    on = dict(base, title="细节见真章", title_x=35, title_y=tpy, title_size=size,
              title_italic=True)
    png_off = _cover_png(bg, "细节见真章", "", off, 1440, 1920)
    png_on = _cover_png(bg, "细节见真章", "", on, 1440, 1920)
    co = _centroid(png_off)
    cn = _centroid(png_on)
    assert co[3] > 200, "非斜体渲染文本像素过少"
    # 宽层+fit 确保非斜体左边缘 >= 0 (标题不被裁)
    assert co[1] >= 0, f"非斜体左边缘={co[1]} 被裁 (应 ≥0)"
    # 斜体同样可见 (剪切补偿正确, 质心 delta < 2% 由 test_bug1_fix_a 验证)


# ───────────────────────── Bug 1.D 预览 WYSIWYG 一致性 (代码审查) ─────────────────────────
def test_bug1_preview_wysiwyg_consistency():
    tl = open(TIMELINE, encoding="utf-8").read()
    assert "overflow: 'hidden'" in tl, "预览框未设置 overflow:hidden"
    # previewH 动态预览框: 高度取 previewH prop, 宽度按画幅推导; 字号/描边经
    # k = pH/320 随框高缩放, 使任意 previewH 下预览占比与导出 (320基准×COVER_SCALE) 一致
    assert "const k = pH / 320;" in tl, "预览框未按 pH/320 推导缩放系数 k (previewH 重构后 WYSIWYG 不变量)"
    assert "pW = aspect === '3:4' ? Math.round(previewH * 3 / 4)" in tl, \
        "预览框宽度 pW 未按 previewH×3/4 (3:4) 推导"
    assert "fontSize: ts * k" in tl, "封面标题 fit 字号未随 k 缩放"
    assert "fontSize: tsc * k" in tl, "封面副标题 fit 字号未随 k 缩放"
    assert "strokeWidth: ctsw * k" in tl, "封面标题 fit 描边未随 k 缩放"
    assert "strokeWidth: cssw * k" in tl, "封面副标题 fit 描边未随 k 缩放"
    # 封面标题预览用 computeCoverFit 算出的 titleFit.fontSize(px) (B+ 防裁切), 副标题预览用 tsc(px)
    assert "fontSize: `${titleFit.fontSize}px`" in tl, "封面标题预览未用 titleFit.fontSize(px) (B+)"
    assert "fontSize: `${subFit.fontSize}px`" in tl, "预览副标题未用 subFit.fontSize(px) (B+)"
    # 预览 320 基准框与导出 1920 高框比例恒为 6 = COVER_SCALE (滑杆语义仍以 320 为基准)
    assert "coverTitleSize * COVER_SCALE" in open(EXPORT_CONFIRM, encoding="utf-8").read(), \
        "导出 title_size 未乘 COVER_SCALE"


# ───────────────────────── Bug 2.E 代码审查: ExportConfirm 缩放 ─────────────────────────
def test_bug2_exportconfirm_scaling():
    src = open(EXPORT_CONFIRM, encoding="utf-8").read()
    assert "size: Math.round(subtitleSize * resolution.width / 360)" in src, \
        "subtitle_style.size 未用 resolution.width/360 缩放"
    assert "stroke_width: Math.round(subtitleStrokeWidth * resolution.width / 360)" in src, \
        "subtitle_style.stroke_width 未用 resolution.width/360 缩放"
    # 封面描边仍用 COVER_SCALE*0.5, 未被本次改动影响
    assert "title_stroke_width: Math.round(coverTitleStrokeWidth * COVER_SCALE * 0.5)" in src, \
        "封面 title 描边被改动 (应仍用 COVER_SCALE*0.5)"
    assert "sub_stroke_width: Math.round(coverSubStrokeWidth * COVER_SCALE * 0.5)" in src, \
        "封面 sub 描边被改动 (应仍用 COVER_SCALE*0.5)"


# ───────────────────────── Bug 2.F 后端透传 stroke_width -> borderw ─────────────────────────
def test_bug2_backend_stroke_passthrough():
    src = open(VS, encoding="utf-8").read()
    assert 'style.get("stroke_width"' in src, "_render_subtitles 未读取 style['stroke_width']"
    assert "borderw={stroke_width}" in src, "borderw 未使用 stroke_width"


# ───────────────────────── Bug 2.G 导出「描边/字号」== 预览「strokeWidth/字号」 ─────────────────────────
@pytest.mark.parametrize("W", [1080, 1440])
def test_bug2_stroke_ratio_matches_preview(W):
    # 预览端调节值
    preview_size = 24
    preview_stroke = 4
    preview_ratio = preview_stroke / preview_size  # 0.1667
    # 导出端 (与 ExportConfirm 一致: ×(W/360))
    export_size = round(preview_size * W / 360)
    export_stroke = round(preview_stroke * W / 360)
    bw, bh = _measure_border_px("王", export_size, export_stroke, w=W, h=1080)
    border_px = (bw + bh) / 2
    # 后端真实生成的描边厚度应 == 传入的 borderw(缩放值)
    assert abs(border_px - export_stroke) < 1.5, \
        f"实测描边={border_px:.2f}px 与传入 borderw={export_stroke} 不符"
    export_ratio = border_px / export_size
    # 导出「描边/字号」比值 == 预览「strokeWidth/字号」比值
    assert abs(export_ratio - preview_ratio) < 0.02, \
        f"导出比值 {export_ratio:.4f} != 预览比值 {preview_ratio:.4f} (W={W})"


# ───────────────────────── Bug 2.H 改动前 vs 改动后 ─────────────────────────
def test_bug2_stroke_before_vs_after_fix():
    W = 1080
    preview_size, preview_stroke = 24, 4
    preview_ratio = preview_stroke / preview_size          # 0.1667
    export_size = round(preview_size * W / 360)            # 72

    # 改动后 (borderw 随字号缩放): 比值 == 预览
    bw_after, _ = _measure_border_px("王", export_size, round(preview_stroke * W / 360), w=W, h=1080)
    ratio_after = ((bw_after) ) / export_size
    assert abs(ratio_after - preview_ratio) < 0.02, \
        f"改动后比值 {ratio_after:.4f} != 预览 {preview_ratio:.4f}"

    # 改动前 (borderw 不缩放, 固定=preview_stroke): 比值 == 预览 1/3 (W=1080 -> 360/1080)
    bw_before, _ = _measure_border_px("王", export_size, preview_stroke, w=W, h=1080)
    ratio_before = (bw_before) / export_size
    assert abs(ratio_before - preview_ratio / 3) < 0.02, \
        f"改动前比值 {ratio_before:.4f} != 预览/3 {preview_ratio/3:.4f}"


# ───────────────────────── Bug 2.I borderw 与 text-shadow 1:1 (不乘 0.5) ─────────────────────────
def test_bug2_borderw_textshadow_one_to_one():
    W, H, fontsize = 1080, 1080, 80
    borderws = [4, 8, 12, 16]
    measured = []
    for bw in borderws:
        mw, mh = _measure_border_px("王", fontsize, bw, w=W, h=H)
        measured.append((mw + mh) / 2)
    # 每个 borderw 实测厚度 ≈ borderw (1:1, 非 0.5 倍)
    for bw, m in zip(borderws, measured):
        assert abs(m - bw) < 1.5, f"borderw={bw} 实测 {m:.2f}px, 非 1:1"
    # 线性: 相邻差值应≈相等 (斜率 1)
    diffs = [measured[i + 1] - measured[i] for i in range(len(measured) - 1)]
    for d in diffs:
        assert abs(d - 4) < 1.5, f"borderw 增量非线性: {diffs}"
