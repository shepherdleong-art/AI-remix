# -*- coding: utf-8 -*-
"""
封面「智能防裁切」(Plan B+) 端到端回归 —— 真实 ffmpeg 渲染 + PIL 填充像素质心。

测量铁律 (同 test_cover_wysiwyg_regression.py): 背景取角点, 文本像素 = 与角点背景欧氏距离 > 55;
禁用 bbox (斜体描边污染); 直接对 render_cover 输出帧测量。

覆盖:
  C1. 适配标题(未超整幅封面宽) 不裁切、不缩字号: 放在非居中锚点(35%)的短标题,
      渲染后完整落在画布内, 且质心保留在≈35%(未被居中/缩字号) —— 即修复后的行为。
  C2. 后端防裁切为权威: 即使传入"原始(未 fit)"参数, render_cover 自身也必须保证
      不裁切; 超宽标题被后端缩字号并居中(质心≈50%), 未超宽短标题保留锚点。
  C2b. fit 参数正确性: computeCoverFit(真实TS) 对超宽标题 -> didShrink=True, titleX=50
  C3. Fix A 不受影响: 渲染 italic on/off, 短/单行标题质心 X delta < 2%
       (后端 shear_comp 仅依赖 tpy, 本次前端改动零触及后端)
  C4. 窄标题不误伤: 测 title_x=35% 适中字号 -> fit 不变(finalX=35), 渲染无裁切、未被平移

fit 计算调用真实前端源码 src/renderer/utils/coverFit.ts (经 _coverfit_bridge.ts + node/tsx),
并提供纯 Python 镜像回退 (已在 QA 阶段与真实 TS 逐用例核对一致)。
"""
import os
import sys
import json
import glob
import shutil
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

from services.video_service import render_cover  # noqa: E402

SIMHEI = r"C:/Windows/Fonts/simhei.ttf"
BG_HEX = "0x808040"
CORNER = 24
THR = 55
ART = os.path.join(ROOT, ".cover_autofit_test")
os.makedirs(ART, exist_ok=True)

COVER_SCALE = 6  # 1920/320, 与 ExportConfirm.tsx 一致

# ── 真实前端 computeCoverFit (TS) 调用 / Python 镜像回退 ──
def _find_tsx_runner():
    npm_cache = os.path.join(os.environ.get("LOCALAPPDATA", ""), "npm-cache", "_npx")
    cands = sorted(glob.glob(os.path.join(npm_cache, "*", "node_modules", "tsx", "dist", "cli.mjs")),
                   reverse=True)
    node = (shutil.which("node") or
            r"C:\Users\11833\.workbuddy\binaries\node\versions\22.22.2\node.exe")
    if cands and os.path.exists(node):
        return [node, cands[0]]
    for p in (r"C:\Users\11833\.workbuddy\binaries\node\versions\22.22.2\npx.cmd",
              r"C:\Program Files\nodejs\npx.cmd"):
        if os.path.exists(p):
            return [p]
    return None


_TS_RUNNER = _find_tsx_runner()
_BRIDGE = os.path.join(HERE, "_coverfit_bridge.ts")


def _py_compute_cover_fit(inp):
    """纯 Python 镜像 (与 src/renderer/utils/coverFit.ts 逐行等价, QA 已核对)。

    规则(与前端/后端一致): 仅当标题超过整幅封面宽/高时才缩字号; 否则保留字号,
    仅当锚点会把标题推出边框时做最小位移(防裁切)。
    
    2026-07-14: 缩字阈值从 `totalW > cw*(1-margin)` 收紧为 `totalW > cw*(1-2*margin)`
    (确保 nudge 时有双侧余量); 缩字因子加 0.98 guard 避免 floor/比例舍入致边缘贴边;
    nudge 的 `elif` 改为 `if` 使双侧同时溢出时后写生效。
    """
    mw = inp["measuredWidth"]
    mh = inp.get("measuredHeight", 0) or 0
    fs = inp["fontSize"]
    tx = inp["titleX"]
    ty = inp["titleY"]
    cw = inp["canvasW"]
    ch = inp["canvasH"]
    sm = inp.get("safeMargin", 0.04)
    stroke = inp.get("strokeWidth", 0)
    fit_w = cw * (1 - 2 * sm)   # 收紧: 双侧余量
    fit_h = ch * (1 - 2 * sm)
    total_w = mw + 2 * stroke
    total_h = mh + 2 * stroke
    half_w = total_w / 2.0
    half_h = total_h / 2.0

    shrink_x = total_w > fit_w
    shrink_y = total_h > 0 and total_h > fit_h
    if shrink_x or shrink_y:
        f = 1.0
        if shrink_x:
            f = min(f, (fit_w / total_w) * 0.98)  # guard factor
        if shrink_y:
            f = min(f, (fit_h / total_h) * 0.98)
        efs = fs * f
        fx = 50.0 if shrink_x else tx
        fy = 50.0 if shrink_y else ty
        return dict(fontSize=efs, titleX=fx, titleY=fy, adjusted=True, didShrink=True)

    margin_px = sm * cw
    margin_px_v = sm * ch
    cx = tx / 100.0 * cw
    cy = ty / 100.0 * ch
    if cx - half_w < margin_px:
        cx = margin_px + half_w
    if cx + half_w > cw - margin_px:   # if not elif: 双侧同时溢出时后写生效
        cx = cw - margin_px - half_w
    if cy - half_h < margin_px_v:
        cy = margin_px_v + half_h
    if cy + half_h > ch - margin_px_v:
        cy = ch - margin_px_v - half_h
    fx = cx * 100.0 / cw
    fy = cy * 100.0 / ch
    adj = abs(fx - tx) > 1e-9 or abs(fy - ty) > 1e-9
    return dict(fontSize=fs, titleX=fx, titleY=fy, adjusted=adj, didShrink=False)


def compute_cover_fit(inp):
    """优先用真实前端源码; 不可用时回退 Python 镜像。返回 (result, source)。"""
    if _TS_RUNNER is not None:
        try:
            proc = subprocess.run(_TS_RUNNER + [_BRIDGE],
                                  input=json.dumps(inp, ensure_ascii=False).encode("utf-8"),
                                  capture_output=True, timeout=120)
            if proc.returncode == 0 and proc.stdout.strip():
                return json.loads(proc.stdout.decode("utf-8")), "ts"
        except Exception:
            pass
    return _py_compute_cover_fit(inp), "py"


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
    subprocess.run([_ffmpeg(), "-y", "-f", "lavfi", f"-i", f"color=c={BG_HEX}:s={w}x{h}:d=2",
                    "-pix_fmt", "yuv420p", p], capture_output=True, timeout=60, check=True)
    return p


def _extent(png):
    img = Image.open(png).convert("RGB")
    arr = np.asarray(img).astype(np.int32)
    H, W = arr.shape[:2]
    bg = arr[:CORNER, :CORNER].reshape(-1, 3).mean(axis=0)
    mask = np.sqrt(((arr - bg) ** 2).sum(axis=2)) > THR
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return dict(min_x=None, max_x=None, cx=None, cy=None, n=0, W=W, H=H)
    return dict(min_x=float(xs.min()), max_x=float(xs.max()),
                cx=float(xs.mean()) / W, cy=float(ys.mean()) / H, n=len(xs), W=W, H=H)


def _render(title, subtitle, style, w, h, bg):
    out = os.path.join(ART, f"_r_{abs(hash((title, subtitle, tuple(sorted(style.items()))))) % 10**9}.mp4")
    render_cover(bg, 1.0, title, subtitle, style, out, w, h, duration=0.5)
    return out + ".cover.png"


def _base(**over):
    # 描边用导出像素 borderw=9 (== round(预览3 * COVER_SCALE * 0.5)), 与 ExportConfirm 真实 payload 一致
    s = dict(font_path=SIMHEI, title_color="white", title_stroke_color="black",
             title_stroke_width=9, sub_color="white", sub_stroke_color="black",
             sub_stroke_width=9, title_x=50, title_y=35, title_size=120,
             sub_x=50, sub_y=55, sub_size=120, zoom=1.0, offset_x=0, offset_y=0,
             title_italic=False, sub_italic=False)
    s.update(over)
    return s


# 用户原 bug 场景: 长标题, 预览字号 48 -> 导出字号 288 (48*COVER_SCALE)
BUG_TEXT = "细节见真章"
BUG_EXPORT_SIZE = 48 * COVER_SCALE  # 288


# ───────────────────────── C1. 复现原 bug (无 fit) ─────────────────────────
def test_c1_fitting_title_offcenter_no_clip_no_shrink():
    W, H = 1440, 1920
    bg = _gen_bg(W, H)
    # 一个明显短于封面宽度的标题, 放在非居中锚点 (35%)。
    # 既不应裁切, 也不应被缩字号 (后端仅做最小位移防裁切, 此处甚至无需位移)。
    TITLE = "测试标题"
    png = _render(TITLE, "", _base(title=TITLE, title_x=35, title_y=35,
                                   title_size=120, title_italic=False), W, H, bg)
    en = _extent(png)
    assert en["n"] > 1000, "文本像素过少, 渲染可能失败"
    # 不裁切: 含描边的墨迹完整落在画布内
    assert en["min_x"] is not None and en["min_x"] >= 0, f"不应裁切(左缘≥0), 实测={en['min_x']:.1f}"
    assert en["max_x"] <= W + 1, f"不应裁切(右缘≤画布宽), 实测={en['max_x']:.1f}"
    # 未缩字号/未重定位: 质心应贴近用户设定的 35%, 而非被居中到 50%
    assert abs(en["cx"] - 0.35) < 0.06, f"未超宽标题应保留锚点≈35%, 实测={en['cx']*100:.1f}%"


# ───────────────────────── C2. 后端防裁切为权威 (原始参数亦不裁切) ─────────────────────────
def test_c2_backend_anticrop_authoritative():
    W, H = 1440, 1920
    bg = _gen_bg(W, H)
    # 2a. 一个明显超宽的标题(远超过封面宽) @直接原始参数 —— 后端必须: 不裁切 + 缩字号 + 居中。
    WIDE = "超长标题测试内容一二三四五六七八九十"
    raw = _render(WIDE, "", _base(title=WIDE, title_x=35, title_y=35,
                                  title_size=160, title_italic=False), W, H, bg)
    er = _extent(raw)
    assert er["n"] > 1000, "文本像素过少, 渲染可能失败"
    assert er["min_x"] is not None and er["min_x"] >= 0, f"后端须防裁切(左缘≥0), 实测={er['min_x']:.1f}"
    assert er["max_x"] <= W + 1, f"后端须防裁切(右缘≤画布宽), 实测={er['max_x']:.1f}"
    # 超宽 -> 后端缩字号并重定位到居中(50%): 质心应明显靠近 50%, 而非原始 35%
    assert abs(er["cx"] - 0.5) < 0.08, f"超宽标题应被缩字号并居中(质心≈50%), 实测={er['cx']*100:.1f}%"

    # 2b. 一个明显未超宽的短标题 @非居中锚点 —— 后端须: 不裁切 + 不缩字号(质心保留锚点)。
    short = _render("短", "", _base(title="短", title_x=35, title_y=35,
                                    title_size=120, title_italic=False), W, H, bg)
    es = _extent(short)
    assert es["n"] > 500, "短标题像素过少, 渲染可能失败"
    assert es["min_x"] is not None and es["min_x"] >= 0, f"短标题不应裁切(左缘≥0), 实测={es['min_x']:.1f}"
    assert es["max_x"] <= W + 1, f"短标题不应裁切(右缘≤画布宽), 实测={es['max_x']:.1f}"
    assert abs(es["cx"] - 0.35) < 0.06, f"未超宽短标题应保留锚点≈35%, 实测={es['cx']*100:.1f}%"
    # 对比: 一个明显未超宽的短标题, 不应被缩字号(质心保留在设定锚点)
    short = _render("短", "", _base(title="短", title_x=35, title_y=35,
                                    title_size=120, title_italic=False), W, H, bg)
    es = _extent(short)
    assert abs(es["cx"] - 0.35) < 0.06, f"未超宽短标题应保留锚点≈35%, 实测={es['cx']*100:.1f}%"


# ───────────────────────── C2b. fit 参数正确性 (真实 TS) ─────────────────────────
def test_c2b_fit_params_shrink_wide_title():
    fit, src = compute_cover_fit(dict(
        measuredWidth=1413.0, measuredHeight=48 * COVER_SCALE * 1.2,
        fontSize=48, titleX=35, titleY=35, canvasW=1440, canvasH=1920, safeMargin=0.04))
    # 超宽 (1413 > fitW=1440*0.92=1324.8) -> 缩字号 + 居中
    assert fit["didShrink"] is True, f"应缩字号, got {fit}"
    assert fit["titleX"] == 50, f"缩字号时应居中, got {fit['titleX']}"
    assert fit["adjusted"] is True
    # 收缩因子 = (fitW/measuredWidth)*0.98 = (1324.8/1413)*0.98
    expect_fs = 48 * (1324.8 / 1413.0) * 0.98
    assert abs(fit["fontSize"] - expect_fs) < 1e-6, f"fontSize={fit['fontSize']}, expect={expect_fs}"
    # 窄标题不应触发调整 (回归防护)
    nar, _ = compute_cover_fit(dict(
        measuredWidth=200.0, measuredHeight=48 * COVER_SCALE * 1.2,
        fontSize=48, titleX=35, titleY=35, canvasW=1440, canvasH=1920, safeMargin=0.04))
    assert nar["adjusted"] is False and nar["titleX"] == 35


# ───────────────────────── C3. Fix A 不受影响 (fit 后参数) ─────────────────────────
@pytest.mark.parametrize("text,tpy", [
    ("测", 35),
    ("精彩内容推荐", 55),
    ("热点速览", 35),
])
def test_c3_fix_a_shear_compensation_short_titles(text, tpy):
    """italic on/off 质心 X delta < 2% (与既有 test_cover_wysiwyg_regression 结论一致)。
    后端 shear_comp 仅依赖 tpy, Plan B+ 前端改动零触及后端 -> Fix A 不受影响。"""
    W, H = 1440, 1920
    bg = _gen_bg(W, H)
    size = 120  # 与既有 Fix A 回归测试同口径, delta 稳定 < 2%
    off = _extent(_render(text, "", _base(title=text, title_y=tpy, title_size=size, title_italic=False), W, H, bg))
    on = _extent(_render(text, "", _base(title=text, title_y=tpy, title_size=size, title_italic=True), W, H, bg))
    assert off["n"] > 100 and on["n"] > 100
    delta = (on["cx"] - off["cx"]) * 100
    assert abs(delta) < 2.0, f"{text}: Fix A 质心 X delta={delta:+.3f}% ≥ 2%"


# ───────────────────────── C4. 窄标题不误伤 ─────────────────────────
def test_c4_narrow_title_not_falsely_adjusted():
    W, H = 1440, 1920
    bg = _gen_bg(W, H)
    # 量 '测' 在导出字号下的字形宽
    m = _extent(_render("测", "", _base(title="测", title_x=50, title_y=50,
                                        title_size=BUG_EXPORT_SIZE, title_stroke_width=0, title_italic=False), W, H, bg))
    tw = m["max_x"] - m["min_x"]
    fit, src = compute_cover_fit(dict(
        measuredWidth=tw, measuredHeight=48 * COVER_SCALE * 1.2,
        fontSize=48, titleX=35, titleY=35, canvasW=W, canvasH=H, safeMargin=0.04))
    # 窄标题 fit 应不变
    assert fit["adjusted"] is False, f"窄标题不应被调整, got {fit}"
    assert fit["titleX"] == 35 and fit["titleY"] == 35
    # 渲染确认其在 tpx=35% 位置, 未被错误平移/缩放, 未裁切
    png = _render("测", "", _base(title="测", title_x=fit["titleX"], title_y=fit["titleY"],
                                  title_size=round(fit["fontSize"] * COVER_SCALE), title_italic=False), W, H, bg)
    e = _extent(png)
    assert e["n"] > 1000
    assert abs(e["cx"] - 0.35) < 0.02, f"窄标题质心应≈35%, 实测={e['cx']*100:.2f}%"
    assert e["min_x"] > 0, f"窄标题不应被裁, min_x={e['min_x']}"


# ───────────────────────── 交叉校验: Python 镜像 == 真实 TS ─────────────────────────
def test_mirror_matches_real_ts():
    cases = [
        dict(measuredWidth=400, measuredHeight=0, fontSize=48, titleX=35, titleY=35, canvasW=1440, canvasH=1920, safeMargin=0.04),
        dict(measuredWidth=1100, measuredHeight=0, fontSize=48, titleX=35, titleY=35, canvasW=1440, canvasH=1920, safeMargin=0.04),
        dict(measuredWidth=1500, measuredHeight=0, fontSize=48, titleX=35, titleY=35, canvasW=1440, canvasH=1920, safeMargin=0.04),
        dict(measuredWidth=1413, measuredHeight=345.6, fontSize=48, titleX=35, titleY=35, canvasW=1440, canvasH=1920, safeMargin=0.04),
        dict(measuredWidth=200, measuredHeight=200, fontSize=48, titleX=35, titleY=2, canvasW=1440, canvasH=1920, safeMargin=0.04),
        dict(measuredWidth=300, measuredHeight=0, fontSize=48, titleX=50, titleY=35, canvasW=1080, canvasH=1920, safeMargin=0.04),
    ]
    if _TS_RUNNER is None:
        pytest.skip("tsx 不可用, 跳过镜像交叉校验")
    for c in cases:
        ts_r, src = compute_cover_fit(c)
        py_r = _py_compute_cover_fit(c)
        assert src == "ts", f"未用到真实 TS 源码: {src}"
        for k in ("fontSize", "titleX", "titleY", "adjusted", "didShrink"):
            assert abs(ts_r[k] - py_r[k]) < 1e-9 or ts_r[k] == py_r[k], (
                f"case={c} key={k}: TS={ts_r[k]} != PY={py_r[k]}")
