#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Regression test for the cover-title ITALIC bug fix.

ROOT CAUSE (verified by the team lead with the real ffmpeg binary):
    This project's bundled ffmpeg (N-125048, 2026-06-15) drawtext filter does
    NOT support the `fontstyle` option. Passing `fontstyle=italic` makes the
    whole drawtext filter fail to initialise ("Option not found"), so the
    entire title/subtitle layer is dropped -> cover exports but the text is
    invisible.

FIX:
    Italic is synthesised WITHOUT `fontstyle`. Each text line is rendered on
    an independent transparent `color` source, drawn with `drawtext` (no
    fontstyle), horizontally sheared with `shear=shx=0.28` (non-italic uses
    shx=0), and overlaid back onto the frame. `shear`'s `fillcolor=0x00000000`
    keeps the sheared-away regions transparent so no black block appears.

WHY THIS TEST IS REAL:
    Unlike the previous (broken) test that only monkeypatched subprocess and
    asserted the command STRING contained `fontstyle=italic`, this test runs
    the ACTUAL ffmpeg binary via subprocess and inspects the produced PNG with
    PIL. It asserts the text is visible (white_text > 0) AND that no black
    block was introduced (black_block == 0). This is exactly the failure mode
    the old test missed.

Run:
    python backend/tests/test_cover_italic.py
"""

import os
import sys
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_TESTS = HERE
BACKEND_DIR = os.path.dirname(BACKEND_TESTS)
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
for p in (PROJECT_ROOT, BACKEND_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

# Prefer the exact ffmpeg binary the team lead validated against; fall back to
# whatever the app resolves (still a real binary, so the test stays valid).
from backend.services.video_service import _build_cover_filter_complex, render_cover, _ffmpeg  # noqa: E402

VALIDATED_FFMPEG = r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"


def ffmpeg_bin() -> str:
    if os.path.exists(VALIDATED_FFMPEG):
        return VALIDATED_FFMPEG
    return _ffmpeg()


FFMPEG = ffmpeg_bin()

# A real Chinese system font used in the user's scenario.
FONT = r"C:/Users/11833/AppData/Local/Microsoft/Windows/Fonts/FZShuiYJW_Zhong.TTF"

# Text escaping must match video_service.render_cover exactly.
def escape_text(t: str) -> str:
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def escape_font(p: str) -> str:
    return p.replace("\\", "/").replace(":", "\\:")


# ---- minimal test harness (no pytest dependency) ----
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, cond, detail))
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" -- {detail}" if detail else ""))


def make_bg(path, color=(255, 0, 0), size=(300, 300)):
    from PIL import Image
    Image.new("RGB", size, color).save(path)


def count_pixels(png):
    from PIL import Image
    img = Image.open(png).convert("RGB")
    px = img.load()
    w, h = img.size
    white = 0
    black = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r > 200 and g > 200 and b > 200:
                white += 1
            elif r < 40 and g < 40 and b < 40:
                black += 1
    return white, black


def run_filter_complex(bg, fc, out):
    cmd = [FFMPEG, "-i", bg, "-filter_complex", fc,
           "-map", "[out]", "-frames:v", "1", "-y", out]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        print("FFMPEG STDERR:\n", res.stderr[-1500:])
        raise RuntimeError(f"ffmpeg failed rc={res.returncode}")


def test_italic_no_black_block():
    print("\n=== Test A: italic ON -> visible text, NO black block ===")
    bg = tempfile.mktemp(suffix=".png")
    out = tempfile.mktemp(suffix=".png")
    make_bg(bg, color=(255, 0, 0), size=(300, 300))

    fontfile = escape_font(FONT)
    safe = escape_text("今日要闻速递")
    # borderw=0 so any black pixel would be a shear bug, not an intended stroke.
    segments = [(safe, 50, 50, 60, "white", "black", 0, 0.28)]
    fc = _build_cover_filter_complex(segments, 300, 300, fontfile)

    check("filter_complex: no 'fontstyle' anywhere", "fontstyle" not in fc, fc)
    check("filter_complex: contains shear=shx=0.28", "shear=shx=0.28" in fc, fc)
    check("filter_complex: contains transparent fillcolor", "fillcolor=0x00000000" in fc)

    run_filter_complex(bg, fc, out)
    check("output PNG created", os.path.exists(out))
    white, black = count_pixels(out)
    print(f"    white_text={white}  black_block={black}")
    check("italic: text visible (white_text>0)", white > 0, f"white={white}")
    check("italic: NO black block (black_block==0)", black == 0, f"black={black}")

    for p in (bg, out):
        try:
            os.unlink(p)
        except OSError:
            pass


def test_non_italic_visible():
    print("\n=== Test B: italic OFF -> normal text visible ===")
    bg = tempfile.mktemp(suffix=".png")
    out = tempfile.mktemp(suffix=".png")
    make_bg(bg, color=(255, 0, 0), size=(300, 300))

    fontfile = escape_font(FONT)
    safe = escape_text("今日要闻速递")
    segments = [(safe, 50, 50, 60, "white", "black", 0, 0)]
    fc = _build_cover_filter_complex(segments, 300, 300, fontfile)

    check("filter_complex: non-italic uses shx=0", "shear=shx=0" in fc, fc)

    run_filter_complex(bg, fc, out)
    check("output PNG created", os.path.exists(out))
    white, black = count_pixels(out)
    print(f"    white_text={white}  black_block={black}")
    check("non-italic: text visible (white_text>0)", white > 0, f"white={white}")
    check("non-italic: NO black block (black_block==0)", black == 0, f"black={black}")

    for p in (bg, out):
        try:
            os.unlink(p)
        except OSError:
            pass


def test_render_cover_end_to_end():
    print("\n=== Test C: render_cover() end-to-end (real ffmpeg, real video) ===")
    import backend.services.video_service as vs
    # Force the validated binary so we exercise the exact build the bug was in.
    vs._ffmpeg = lambda: FFMPEG

    vid = tempfile.mktemp(suffix=".mp4")
    # Generate a tiny solid-color video so render_cover can extract a frame.
    subprocess.run(
        [FFMPEG, "-f", "lavfi", "-i", "color=c=blue:s=300x300:r=25:d=1",
         "-pix_fmt", "yuv420p", "-y", vid],
        check=True, capture_output=True, text=True, timeout=120,
    )

    out = tempfile.mktemp(suffix=".mp4")
    style = {
        "font_path": FONT,
        "title": "今日要闻速递",
        "title_size": 60,
        "title_color": "white",
        "title_stroke_color": "black",
        "title_stroke_width": 2,
        "title_italic": True,
        "subtitle": "实时快讯",
        "sub_italic": True,
        "sub_stroke_width": 2,
    }
    render_cover(vid, 0.0, style["title"], style.get("subtitle", ""),
                 style, out, w=300, h=300, duration=0.5)

    frame = out + ".cover.png"
    check("cover frame PNG created by render_cover", os.path.exists(frame))
    white, black = count_pixels(frame)
    print(f"    white_text={white}  black_block={black}")
    check("render_cover(italic): text visible (white_text>0)", white > 0, f"white={white}")
    # Black here is only the thin 2px stroke outline, never a filled block.
    check("render_cover(italic): NO giant black block (black_block < 10% area)",
          black < 0.1 * 300 * 300, f"black={black}")

    for p in (vid, out, frame):
        try:
            os.unlink(p)
        except OSError:
            pass


def main():
    if not os.path.exists(FFMPEG):
        print(f"FFMPEG binary not found: {FFMPEG}")
        sys.exit(2)
    if not os.path.exists(FONT):
        print(f"Test font not found: {FONT}")
        sys.exit(2)

    print(f"Using ffmpeg: {FFMPEG}")
    test_italic_no_black_block()
    test_non_italic_visible()
    test_render_cover_end_to_end()

    passed = sum(1 for _, c, _ in RESULTS if c)
    total = len(RESULTS)
    print(f"\n=== SUMMARY: {passed}/{total} checks passed ===")
    if passed != total:
        sys.exit(1)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
