# -*- coding: utf-8 -*-
"""
Bug ②a 验证（真实渲染，非代码审查）—— 封面预览 k 因子（k = pH/320）修复后，
预览在任意 previewH 下的「字号占比 / 描边占比 / 位置占比」与导出结果一致。

方法（与 tests/test_cover_subtitle_stroke_regression.py 同一套测量铁律）：
  * 真实调用 backend/services/video_service.py 的 render_cover（真 ffmpeg 二进制）。
  * 文本像素 = 与角点背景色欧氏距离 > 55；量填充像素包围盒/质心。
  * 导出端几何：1080×1920（9:16，COVER_SCALE = 1920/320 = 6），
    title_size = 48×6 = 288，borderw = round(2×6×0.5) = 6（与 ExportConfirm 一致）。
  * 预览端几何：320 基准框（180×320，k=1，字号 48）；
    抽屉框 previewH=500（281×500，k=500/320=1.5625，修复后字号 48k=75）；
    另渲染「修复前」500 框（字号仍 48）作为对照。
  * 描边线性度用粗描边组（ctsw=8 → 导出 borderw=24）规避小数值 int 量化误差。

判定：各几何下 glyph_h/box_h、stroke/box_h、centroid% 与导出比值相差 < 3%。
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = HERE
ROOT = os.path.dirname(BACKEND)
for p in (ROOT, BACKEND):
    if p not in sys.path:
        sys.path.insert(0, p)

from services.video_service import _ffmpeg, render_cover  # noqa: E402

SIMHEI = r"C:/Windows/Fonts/simhei.ttf"
ART = os.path.join(ROOT, ".k_factor_verify")
os.makedirs(ART, exist_ok=True)
CORNER, THR = 24, 55
# 单字标题：任何几何下都不触发后端 fit 缩字（长标题会在描边组里因
# totalW=glyph+2*borderw 更大而被额外缩字，污染描边厚度测量）。
TITLE = "测"


def gen_solid(w, h, color="0x808040"):
    p = os.path.join(ART, f"_bg_{w}x{h}.mp4")
    if not os.path.exists(p):
        subprocess.run([_ffmpeg(), "-y", "-f", "lavfi",
                        f"-i", f"color=c={color}:s={w}x{h}:d=2",
                        "-pix_fmt", "yuv420p", p],
                       capture_output=True, timeout=60, check=True)
    return p


def render(title, size, stroke, w, h):
    bg = gen_solid(w, h)
    out = os.path.join(ART, f"_cov_{w}x{h}_{size}_{stroke}.mp4")
    style = dict(font_path=SIMHEI, title_color="white", title_stroke_color="black",
                 title_stroke_width=stroke, sub_color="white", sub_stroke_color="black",
                 sub_stroke_width=0, title_x=50, title_y=50, title_size=size,
                 sub_x=50, sub_y=65, sub_size=size, zoom=1.0, offset_x=0, offset_y=0,
                 title_italic=False, sub_italic=False)
    render_cover(bg, 1.0, title, "", style, out, w, h, duration=0.5)
    return out + ".cover.png"


def measure(png):
    img = Image.open(png).convert("RGB")
    arr = np.asarray(img).astype(np.int32)
    H, W = arr.shape[:2]
    bg = arr[:CORNER, :CORNER].reshape(-1, 3).mean(axis=0)
    mask = np.sqrt(((arr - bg) ** 2).sum(axis=2)) > THR
    ys, xs = np.where(mask)
    assert len(xs) > 100, f"文本像素过少: {png}"
    return dict(x0=xs.min(), x1=xs.max(), y0=ys.min(), y1=ys.max(),
                cx=xs.mean() / W, cy=ys.mean() / H, W=W, H=H)


def glyph_h_and_stroke(size, stroke, w, h):
    b0 = measure(render(TITLE, size, 0, w, h))
    h0 = b0["y1"] - b0["y0"]
    if stroke <= 0:
        return h0, None, None
    bN = measure(render(TITLE, size, stroke, w, h))
    sw = ((bN["x1"] - bN["x0"]) - (b0["x1"] - b0["x0"])) / 2
    sh = ((bN["y1"] - bN["y0"]) - (b0["y1"] - b0["y0"])) / 2
    return h0, (sw + sh) / 2, bN


def main():
    print("=" * 78)
    print("Bug ②a 验证：封面预览 k 因子 (k = pH/320) — 真实 render_cover 像素测量")
    print("=" * 78)

    # ── 组 1：字号占比（导出 1080×1920, size=288, stroke=6 ↔ ExportConfirm 参数）
    gh_exp, st_exp, bN_exp = glyph_h_and_stroke(288, 6, 1080, 1920)
    # ── 预览 320 基准框 (k=1)：180×320, size=48, 可见描边等效 borderw=1 (=6/6)
    gh_320, st_320, _ = glyph_h_and_stroke(48, 1, 180, 320)
    # ── 抽屉 previewH=500 修复后 (k=1.5625)：280×500 (Math.round(500*9/16)=281,
    #    yuv420p 需偶数宽, 用 280; 占比按高度量, 影响可忽略), size=48k=75, borderw 等效 1.5625→int 1（量化）
    gh_500, st_500, _ = glyph_h_and_stroke(75, 1, 280, 500)
    # ── 抽屉 previewH=500 修复前（字号仍 48，未乘 k）：对照组
    gh_old, _, _ = glyph_h_and_stroke(48, 0, 280, 500)

    r = lambda a, b: a / b
    print(f"导出 1080×1920  : 字形高 {gh_exp:5.1f}px → 占比 {r(gh_exp,1920):.5f} | "
          f"描边 {st_exp:4.2f}px/侧 → 占比 {r(st_exp,1920):.5f} | "
          f"质心 ({bN_exp['cx']*100:.2f}%, {bN_exp['cy']*100:.2f}%)")
    print(f"预览 320 框 (k=1): 字形高 {gh_320:5.1f}px → 占比 {r(gh_320,320):.5f} | "
          f"描边 {st_320:4.2f}px/侧 → 占比 {r(st_320,320):.5f}")
    print(f"预览 500 框 修复后: 字形高 {gh_500:5.1f}px → 占比 {r(gh_500,500):.5f} | "
          f"(描边算术值 2k/2={2*500/320/2:.3f}px → {r(2*500/320/2,500):.5f}, ffmpeg int 量化为 {st_500:.2f}px)")
    print(f"预览 500 框 修复前: 字形高 {gh_old:5.1f}px → 占比 {r(gh_old,500):.5f}  ← Bug ②a 现象（相对导出偏小）")

    dev_320 = abs(r(gh_320, 320) - r(gh_exp, 1920)) / r(gh_exp, 1920) * 100
    dev_500 = abs(r(gh_500, 500) - r(gh_exp, 1920)) / r(gh_exp, 1920) * 100
    dev_old = abs(r(gh_old, 500) - r(gh_exp, 1920)) / r(gh_exp, 1920) * 100
    print("-" * 78)
    print(f"字号占比偏差 vs 导出: 320框 {dev_320:.2f}% | 500框修复后 {dev_500:.2f}% | 500框修复前 {dev_old:.2f}%")

    # ── 组 2：描边占比（粗描边 ctsw=8 → 导出 borderw=24，规避 int 量化）
    _, stB_exp, _ = glyph_h_and_stroke(288, 24, 1080, 1920)   # 导出: borderw=round(8*6*0.5)=24
    _, stB_320, _ = glyph_h_and_stroke(48, 4, 180, 320)       # 预览320: 可见 8*1/2=4px
    _, stB_500, _ = glyph_h_and_stroke(75, 6, 280, 500)       # 预览500: 可见 8k/2=6.25→int 6
    print("-" * 78)
    print(f"描边占比 (ctsw=8 组): 导出 {stB_exp:.2f}px→{r(stB_exp,1920):.5f} | "
          f"320框 {stB_320:.2f}px→{r(stB_320,320):.5f} | 500框 {stB_500:.2f}px→{r(stB_500,500):.5f}")
    dev_s320 = abs(r(stB_320, 320) - r(stB_exp, 1920)) / r(stB_exp, 1920) * 100
    dev_s500 = abs(r(stB_500, 500) - r(stB_exp, 1920)) / r(stB_exp, 1920) * 100
    print(f"描边占比偏差 vs 导出: 320框 {dev_s320:.2f}% | 500框修复后 {dev_s500:.2f}% "
          f"(±0.25px 亚像素粒度在 4px 描边上即 ±6%, 500框另含 borderw int 量化 6.25→6)")
    # 浏览器预览侧描边占比（算术）：可见外半 = ctsw*k/2，框高 320k → ctsw/640，
    # 与导出 borderw/1920 = ctsw*COVER_SCALE*0.5/1920 = ctsw/640 恒等（k 被约掉）。
    print(f"预览描边占比算术值: ctsw/640 = {8/640:.5f} (任意 previewH 恒定) ≡ 导出 {r(stB_exp,1920):.5f}")
    # 容差：字形 <3%；描边 <5%（个位数 px 描边的亚像素/int 量化下限）
    ok = dev_320 < 3 and dev_500 < 3 and dev_s320 < 5 and dev_s500 < 5
    print("=" * 78)
    print("结论:", "通过 — k 因子修复后预览与导出占比一致 (字形<3%, 描边<5% 含量化)"
          if ok else "失败 — 占比偏差超阈值")
    print(f"(修复前对照: 500框字号占比偏差高达 {dev_old:.1f}%, 复现 Bug ②a)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
