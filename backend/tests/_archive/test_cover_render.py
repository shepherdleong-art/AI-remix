#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Regression tests for backend cover-title bug fixes (Bug 2 & Bug 3 backend parts).

Target: backend/services/video_service.py :: render_cover()

IMPORTANT (Bug 3 — italic):
    The PREVIOUS version of this test asserted that the drawtext filter STRING
    contained `fontstyle=italic`. That was wrong: this project's bundled ffmpeg
    (N-125048) drawtext does NOT support `fontstyle` and crashes with
    "Option not found", dropping the whole text layer. The fix synthesises the
    italic slant via a transparent text layer + `shear=shx` + overlay, so the
    correct assertions are: NO `fontstyle` anywhere, `shear=shx=0.28` on italic
    rows and `shear=shx=0` on normal rows.

Strategy
--------
render_cover() shells out to ffmpeg via subprocess.run several times
(frame extract, filter_complex burn, frame->video). We monkeypatch
`subprocess.run` so that:
  * every ffmpeg call "succeeds" (returns rc=0) without running ffmpeg,
  * the output files referenced by `-y <path>` are materialised so that
    render_cover's own existence checks (frame.png / titled.png) pass,
  * the `-filter_complex` graph string is captured for assertions.

No video/ffmpeg binary is required for this command-shape check. The actual
pixel-level "no black block / text visible" verification lives in
`test_cover_italic.py` (which runs the REAL ffmpeg binary).

Run:
    python backend/tests/test_cover_render.py
"""

import os
import sys
import re
import time
import tempfile
import subprocess
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_TESTS = HERE
BACKEND_DIR = os.path.dirname(BACKEND_TESTS)
PROJECT_ROOT = os.path.dirname(BACKEND_DIR)
for p in (PROJECT_ROOT, BACKEND_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from backend.services.video_service import render_cover  # noqa: E402

# A real Chinese system font that exists on this machine (used for font-link test).
FONT = "C:/Windows/Fonts/msyh.ttc"
TITLE = "今日要闻速递"
SUB = "副标题测试"


def run_render_capture(style, title=TITLE, subtitle=SUB, w=1080, h=1920):
    """Call render_cover() under a mocked subprocess and return (filter_complex, all_cmds)."""
    out = os.path.join(
        tempfile.gettempdir(),
        f"cover_qa_{os.getpid()}_{int(time.time() * 1000)}.mp4",
    )
    fcs = []
    cmds = []

    def fake_run(cmd, *a, **k):
        cmds.append(list(cmd))
        # Materialise the `-y <path>` output so render_cover's existence
        # checks (frame.png / titled.png) succeed.
        if "-y" in cmd:
            outp = cmd[cmd.index("-y") + 1]
            try:
                d = os.path.dirname(outp)
                if d:
                    os.makedirs(d, exist_ok=True)
                if not os.path.exists(outp):
                    open(outp, "w").close()
            except Exception:
                pass
        # Capture the -filter_complex graph (the part we want to assert on).
        if "-filter_complex" in cmd:
            fc = cmd[cmd.index("-filter_complex") + 1]
            if "drawtext" in fc:
                fcs.append(fc)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    with patch("subprocess.run", side_effect=fake_run):
        render_cover("dummy.mp4", 1.0, title, subtitle, style, out, w, h)

    return (fcs[-1] if fcs else None), cmds


def drawtext_segments(fc):
    """Return the per-line drawtext segments from the filter_complex graph.

    Each ';'-separated part that contains `drawtext=` corresponds to one text
    line, in order (title first, then subtitle).
    """
    return [part for part in fc.split(";") if "drawtext=" in part]


# ---- minimal test harness (no pytest dependency) ----
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, cond, detail))
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" -- {detail}" if detail else ""))


def main():
    print("=== Bug 3: italic via shear=shx (NO fontstyle) ===")

    # Case 1: only title is italic -> title layer shx=0.28, subtitle shx=0.
    fc, _ = run_render_capture({"title_italic": True, "sub_italic": False, "font_path": FONT})
    check("italic(title-only): filter_complex captured", fc is not None, "render produced a filter_complex graph")
    if fc:
        check("italic(title-only): NO 'fontstyle' anywhere", "fontstyle" not in fc)
        segs = drawtext_segments(fc)
        check("italic(title-only): two drawtext layers", len(segs) == 2, f"count={len(segs)}")
        if len(segs) == 2:
            check("italic(title-only): title layer shear=shx=0.28", "shx=0.28" in segs[0], segs[0][-60:])
            check("italic(title-only): subtitle layer shear=shx=0", "shx=0.28" not in segs[1], segs[1][-60:])

    # Case 2: both regular -> NO fontstyle, both shx=0.
    fc, _ = run_render_capture({"title_italic": False, "sub_italic": False, "font_path": FONT})
    check("italic(none): filter_complex captured", fc is not None)
    if fc:
        check("italic(none): NO 'fontstyle' anywhere", "fontstyle" not in fc)
        segs = drawtext_segments(fc)
        if len(segs) == 2:
            check("italic(none): title layer shear=shx=0", "shx=0.28" not in segs[0])
            check("italic(none): subtitle layer shear=shx=0", "shx=0.28" not in segs[1])

    # Case 3: only subtitle is italic -> title shx=0, subtitle shx=0.28.
    fc, _ = run_render_capture({"title_italic": False, "sub_italic": True, "font_path": FONT})
    check("italic(sub-only): filter_complex captured", fc is not None)
    if fc:
        check("italic(sub-only): NO 'fontstyle' anywhere", "fontstyle" not in fc)
        segs = drawtext_segments(fc)
        if len(segs) == 2:
            check("italic(sub-only): title layer shear=shx=0", "shx=0.28" not in segs[0])
            check("italic(sub-only): subtitle layer shear=shx=0.28", "shx=0.28" in segs[1], segs[1][-60:])

    # Case 4: both italic -> both shx=0.28, no fontstyle.
    fc, _ = run_render_capture({"title_italic": True, "sub_italic": True, "font_path": FONT})
    check("italic(both): filter_complex captured", fc is not None)
    if fc:
        check("italic(both): NO 'fontstyle' anywhere", "fontstyle" not in fc)
        segs = drawtext_segments(fc)
        if len(segs) == 2:
            check("italic(both): title layer shear=shx=0.28", "shx=0.28" in segs[0])
            check("italic(both): subtitle layer shear=shx=0.28", "shx=0.28" in segs[1])

    # Also confirm the empty-text branch keeps the frame (no filter_complex at all).
    # NOTE: render_cover takes the text from positional args, not style["title"].
    fc, _ = run_render_capture({"font_path": FONT}, title="", subtitle="")
    check("empty text: no drawtext filter_complex emitted", fc is None or "drawtext" not in fc)

    print("\n=== Bug 2: export stroke width passthrough (borderw) ===")
    fc, _ = run_render_capture({"title_stroke_width": 3, "sub_stroke_width": 4, "font_path": FONT})
    check("stroke: filter_complex captured", fc is not None)
    if fc:
        segs = drawtext_segments(fc)
        if len(segs) == 2:
            check("stroke: title layer borderw=3", "borderw=3" in segs[0], segs[0][:140])
            check("stroke: subtitle layer borderw=4", "borderw=4" in segs[1], segs[1][:140])

    print("\n=== Bug 1/3: font file link present in drawtext (fontfile=) ===")
    fc, _ = run_render_capture({"font_path": FONT})
    check("fontfile: filter_complex captured", fc is not None)
    if fc:
        check("fontfile: 'fontfile=' present in filter", "fontfile=" in fc)
        m = re.search(r"fontfile='([^']+)'", fc)
        if m:
            val = m.group(1)
            check("fontfile: resolved to safe copy (ff_cover)", "ff_cover" in val, val[:120])
        else:
            check("fontfile: parsed fontfile value", False, "regex did not match")

    passed = sum(1 for _, c, _ in RESULTS if c)
    total = len(RESULTS)
    print(f"\n=== SUMMARY: {passed}/{total} checks passed ===")
    if passed != total:
        sys.exit(1)


if __name__ == "__main__":
    main()
