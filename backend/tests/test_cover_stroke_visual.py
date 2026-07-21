#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Real-ffmpeg quantitative regression test for the cover-stroke visual fix.

GOAL
----
Independently verify that the EXPORTED visible stroke width (ffmpeg drawtext
`borderw`, which is drawn fully OUTSIDE the glyph and is therefore 100% visible)
matches the STEP-3 PREVIEW visible OUTER stroke.

Why ratios, not pixels:
  * Step-3 preview uses CSS `-webkit-text-stroke: {w}px` with
    `paint-order: stroke fill`. CSS stroke is CENTERED on the glyph outline and
    `paint-order: stroke fill` paints the fill ON TOP of the inner half of the
    stroke, so only ~w/2 of the stroke shows OUTSIDE the glyph.
    Preview font size = 48px (320px box). Preview visible-outer / font-size
    = (w/2) / 48 = w/96.
  * Export uses ffmpeg `drawtext borderw`. borderw is drawn entirely outside the
    glyph -> the whole borderw is visible. Export font size = 48 * COVER_SCALE(6)
    = 288px. Export visible / font-size = borderw / 288.
  * Before the fix the front-end sent `borderw = w * COVER_SCALE(6)` -> 6w/288
    = w/48 (≈ 2x the preview). After the fix it sends `borderw = w*6*0.5 = 3w`
    -> 3w/288 = w/96, exactly the preview ratio. So the fix is mathematically
    "new ratio == preview ratio == half of old ratio".

This test does NOT just trust the arithmetic: it renders the actual glyph with
the REAL ffmpeg binary, scans the glyph's central row on a transparent canvas,
and measures the visible stroke thickness in pixels, then divides by font size.

MEASUREMENT METHOD (difference method — robust to swallowed thin strokes)
------------------------------------------------------------------------
  * A single CJK char ("测") is rendered with the REAL ffmpeg drawtext on a
    solid GREEN canvas (0,255,0), fill=white, stroke=black. Green is used
    because the `color` lavfi source does not emit a usable alpha channel, and
    green is unambiguously distinct from both white fill and black stroke. Text
    is passed via `textfile` (UTF-8) to avoid command-line encoding issues.
  * For each case we render TWICE: once with the target borderw, once with
    borderw=0 (no-border reference). On a band of rows around the canvas centre
    we measure the horizontal ink SPAN (rightmost - leftmost non-green pixel).
    Because ffmpeg draws borderw pixels symmetrically OUTSIDE the glyph, the
    span grows by exactly 2*borderw, so:
        visible_stroke_px = (span_with_border - span_without_border) / 2
  * ratio = visible_stroke_px / font_size.
  This is robust even though "测" has thin internal strokes that a thick border
  fully swallows: swallowed or not, the ink extent still grows by 2*borderw.

EXPECTED (within ±15% tolerance, glyph "测" is asymmetric):
  new (w=2): fs=288, borderw=6  -> ratio ~ 6/288  = 0.0208  (== preview w/96)
  old (w=2): fs=288, borderw=12 -> ratio ~ 12/288 = 0.0417  (~2x new)
  new (w=4): fs=288, borderw=12 -> ratio ~ 12/288 = 0.0417  (== preview w/96 *2)
  old (w=4): fs=288, borderw=24 -> ratio ~ 24/288 = 0.0833  (~2x new)

Run:
    python backend/tests/test_cover_stroke_visual.py
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

from PIL import Image
import numpy as np

VALIDATED_FFMPEG = r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
FONT = r"C:/Users/11833/AppData/Local/Microsoft/Windows/Fonts/FZShuiYJW_Zhong.TTF"

if os.path.exists(VALIDATED_FFMPEG):
    FFMPEG = VALIDATED_FFMPEG
else:
    from backend.services.video_service import _ffmpeg
    FFMPEG = _ffmpeg()

CHAR = "测"          # asymmetric CJK glyph, exercises left/right edges
COVER_SCALE = 6
PREVIEW_FS = 48      # raw preview font size in the 320px box
EXPORT_FS = PREVIEW_FS * COVER_SCALE   # = 288 (export font size)
TOL = 0.15           # ±15% tolerance as agreed with the team lead

# Windows path escaping for ffmpeg filter strings.
def esc(p: str) -> str:
    return p.replace("\\", "/").replace(":", "\\:")


# ---- minimal test harness (no pytest dependency) ----
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, cond, detail))
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" -- {detail}" if detail else ""))


def render_glyph_char(font_size, borderw):
    """Render CHAR on a solid GREEN canvas with the real ffmpeg drawtext.

    Green (0,255,0) is chosen because it is unambiguously distinct from the
    white fill and black stroke, so the stroke's outer edge can be detected by
    simple colour testing (no dependency on an alpha channel, which the `color`
    source does not emit reliably).

    Returns the path to a one-frame PNG.
    """
    W = H = 700  # canvas; char ~288px + up to 24px stroke each side, centered
    tmpdir = tempfile.gettempdir()
    tf_path = os.path.join(tmpdir, f"stroke_txt_{os.getpid()}_{font_size}_{borderw}.txt")
    with open(tf_path, "w", encoding="utf-8") as f:
        f.write(CHAR)
    out_path = os.path.join(tmpdir, f"stroke_out_{os.getpid()}_{font_size}_{borderw}.png")

    fc = (
        f"drawtext=textfile='{esc(tf_path)}':fontfile='{esc(FONT)}':"
        f"fontsize={font_size}:fontcolor=white:bordercolor=black:borderw={borderw}:"
        f"x=(w-text_w)/2:y=(h-text_h)/2"
    )
    cmd = [
        FFMPEG, "-f", "lavfi", f"-i", f"color=c=0x00FF00:s={W}x{H}",
        "-vf", fc, "-frames:v", "1", "-y", out_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        print("FFMPEG STDERR:\n", res.stderr[-1500:])
        raise RuntimeError(f"ffmpeg failed rc={res.returncode}")
    return out_path


def measure_span_median(png_path):
    """Return the median horizontal ink SPAN (right_text - left_text) over a band
    of rows around the canvas centre.

    The glyph is centred at H//2 in every render (same x/y placement), so the
    span at a given row grows by exactly 2*borderw when a border is added. We
    use the *median* over a +/-50px band so a single noisy/hollow row cannot
    skew the result. Returns None if no ink is found.
    """
    img = Image.open(png_path).convert("RGB")
    arr = np.asarray(img).astype(int)
    H, W, _ = arr.shape
    r = arr[:, :, 0]
    g = arr[:, :, 1]
    b = arr[:, :, 2]

    # Background is pure green; ink is white fill OR black stroke. Define a
    # continuous "ink-ness" that is ~0 for the green background and >0 for any
    # ink, so edges can be found with sub-pixel interpolation (removes the
    # integer-rounding bias of a binary mask on the anti-aliased fringe). The
    # exact threshold is irrelevant to the DIFFERENCE method because it is
    # applied identically to both renders (with and without border).
    inkness = np.maximum(r, b) + np.maximum(0, 180 - g)

    cy = H // 2
    spans = []
    for y in range(cy - 50, cy + 51):
        if 0 <= y < H:
            s = _row_span_subpixel(inkness[y], THRESH)
            if s is not None:
                spans.append(s)
    if not spans:
        return None
    return float(np.median(spans))


# Ink/bg boundary used for sub-pixel edge interpolation. Midway between the
# background ink-ness (0) and the faintest ink (a black stroke -> max(r,b)=0,
# 180-g=180 -> 180). The value is constant across renders so it cancels in the
# difference.
THRESH = 90


def _row_span_subpixel(ink_row, thresh):
    """Sub-pixel horizontal ink span on a single row of the ink-ness signal.

    The ink edge is the position where `ink_row` crosses `thresh`, linearly
    interpolated between the adjacent background and ink samples. Returns None
    if the row has no ink (or only a single isolated pixel).
    """
    W = ink_row.shape[0]
    ink = np.where(ink_row >= thresh)[0]
    if ink.size < 2:
        return None
    left = int(ink[0])
    right = int(ink[-1])
    if left == right:
        return None
    # Left edge: interpolate `thresh` between column left-1 (bg) and left (ink).
    if left > 0 and ink_row[left - 1] < thresh:
        f = (thresh - ink_row[left - 1]) / float(ink_row[left] - ink_row[left - 1])
        left_edge = (left - 1) + f
    else:
        left_edge = float(left)
    # Right edge: interpolate `thresh` between column right (ink) and right+1 (bg).
    if right + 1 < W and ink_row[right + 1] < thresh:
        f = (ink_row[right] - thresh) / float(ink_row[right] - ink_row[right + 1])
        right_edge = right + f
    else:
        right_edge = float(right)
    if right_edge <= left_edge:
        return None
    return right_edge - left_edge


def approx(a, b, tol=TOL):
    if b == 0:
        return False
    return abs(a - b) / abs(b) <= tol


def run_case(label, w, use_fix):
    """Render with borderw = w*COVER_SCALE*(0.5 if use_fix else 1) and, as a
    reference, with borderw=0. Measure the visible stroke as half the difference
    in horizontal ink span (border is added on BOTH sides), then divide by the
    export font size to get the visible-stroke / font-size ratio.
    """
    borderw = int(round(w * COVER_SCALE * (0.5 if use_fix else 1.0)))
    png_with = render_glyph_char(EXPORT_FS, borderw)
    png_ref = render_glyph_char(EXPORT_FS, 0)  # no-border reference
    try:
        span_with = measure_span_median(png_with)
        span_ref = measure_span_median(png_ref)
    finally:
        for p in (png_with, png_ref):
            try:
                os.unlink(p)
            except OSError:
                pass

    if span_with is None or span_ref is None:
        print(f"    {label}: UNMEASURABLE (no glyph detected)")
        return None, borderw

    stroke_px = (span_with - span_ref) / 2.0   # border added on both sides
    ratio = stroke_px / EXPORT_FS
    expected = borderw / EXPORT_FS
    print(f"    {label}: borderw={borderw}  measured_stroke={stroke_px:.2f}px  "
          f"ratio={ratio:.5f}  expected(borderw/fs)={expected:.5f}  "
          f"diff={100*(ratio-expected)/expected:+.1f}%")
    return ratio, borderw


def main():
    if not os.path.exists(FFMPEG):
        print(f"FFMPEG binary not found: {FFMPEG}")
        sys.exit(2)
    if not os.path.exists(FONT):
        print(f"Test font not found: {FONT}")
        sys.exit(2)

    print(f"Using ffmpeg: {FFMPEG}")
    print(f"EXPORT_FS={EXPORT_FS}  COVER_SCALE={COVER_SCALE}  CHAR='{CHAR}'  TOL=±{int(TOL*100)}%")
    print(f"Preview visible-outer / font-size = w/96  (w=2 -> 0.0208, w=4 -> 0.0417)\n")

    print("=== Render & measure (real ffmpeg) ===")
    new2, bw_new2 = run_case("NEW  w=2 (fix applied)", 2, True)
    old2, bw_old2 = run_case("OLD  w=2 (pre-fix)",     2, False)
    new4, bw_new4 = run_case("NEW  w=4 (fix applied)", 4, True)
    old4, bw_old4 = run_case("OLD  w=4 (pre-fix)",     4, False)

    preview2 = 2 / 96.0   # = 0.0208
    preview4 = 4 / 96.0   # = 0.0417

    print("\n=== Assertions ===")
    # A. new w=2 ratio matches the step-3 preview visible ratio (≈0.0208)
    if new2 is not None:
        check("NEW w=2 ratio ≈ preview visible ratio (0.0208)",
              approx(new2, preview2),
              f"new2={new2:.5f} preview={preview2:.5f}")
    else:
        check("NEW w=2 ratio ≈ preview visible ratio (0.0208)", False, "unmeasurable")

    # B. new w=2 ≈ half of old w=2 (fix halves the visible stroke)
    if new2 is not None and old2 is not None:
        check("NEW w=2 ratio ≈ half of OLD w=2 ratio",
              approx(new2 * 2.0, old2),
              f"2*new2={new2*2:.5f} old2={old2:.5f}")
    else:
        check("NEW w=2 ratio ≈ half of OLD w=2 ratio", False, "unmeasurable")

    # C. new w=4 ratio matches the preview visible ratio for w=4 (≈0.0417)
    if new4 is not None:
        check("NEW w=4 ratio ≈ preview visible ratio (0.0417)",
              approx(new4, preview4),
              f"new4={new4:.5f} preview={preview4:.5f}")
    else:
        check("NEW w=4 ratio ≈ preview visible ratio (0.0417)", False, "unmeasurable")

    # D. new w=4 ≈ half of old w=4
    if new4 is not None and old4 is not None:
        check("NEW w=4 ratio ≈ half of OLD w=4 ratio",
              approx(new4 * 2.0, old4),
              f"2*new4={new4*2:.5f} old4={old4:.5f}")
    else:
        check("NEW w=4 ratio ≈ half of OLD w=4 ratio", False, "unmeasurable")

    # E. sanity: borderw is actually drawn (ratio ≈ borderw/fs, not ~0)
    for label, r, bw in (("NEW w=2", new2, bw_new2), ("OLD w=2", old2, bw_old2),
                         ("NEW w=4", new4, bw_new4), ("OLD w=4", old4, bw_old4)):
        if r is None:
            check(f"stroke drawn for {label}", False, "unmeasurable")
        else:
            check(f"stroke drawn for {label} (ratio≈borderw/fs)",
                  approx(r, bw / EXPORT_FS),
                  f"measured={r:.5f} borderw/fs={bw/EXPORT_FS:.5f}")

    print("\n=== Summary table ===")
    print(f"  {'case':<22}{'borderw':>8}{'measured':>12}{'preview':>10}{'note'}")
    rows = [
        ("NEW w=2", new2, bw_new2, preview2, "should == preview"),
        ("OLD w=2", old2, bw_old2, None,    "~2x new"),
        ("NEW w=4", new4, bw_new4, preview4, "should == preview"),
        ("OLD w=4", old4, bw_old4, None,    "~2x new"),
    ]
    for name, r, bw, pv, note in rows:
        mp = f"{r:.5f}" if r is not None else "  n/a "
        pvs = f"{pv:.5f}" if pv is not None else "    -  "
        print(f"  {name:<22}{bw:>8}{mp:>12}{pvs:>10}   {note}")

    passed = sum(1 for _, c, _ in RESULTS if c)
    total = len(RESULTS)
    print(f"\n=== SUMMARY: {passed}/{total} checks passed ===")
    if passed != total:
        sys.exit(1)
    print("ALL CHECKS PASSED — export visible stroke matches step-3 preview")


if __name__ == "__main__":
    main()
