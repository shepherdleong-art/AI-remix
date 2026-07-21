#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
INDEPENDENT reproduction by QA (Edward) — does NOT import the engineer's
`_build_cover_filter_complex`. We reconstruct the fixed `-filter_complex`
graph from scratch so the verification does not depend on their code.

Goals:
  1. (FIXED/logic) Build the corrected graph: transparent `color` source +
     `drawtext` (NO fontstyle) + `shear=shx=0.28:fillcolor=0x00000000` +
     `overlay` back onto frame. Run real ffmpeg, then PIL-assert:
        italic ON  -> white_text > 0  AND  black_block == 0
  2. (COUNTER-EXAMPLE) Re-introduce the OLD bug: add `fontstyle=italic` to
     drawtext. Confirm ffmpeg STILL FAILS ("Option not found" / no output),
     locking the root cause as eliminated (re-introducing it breaks again).
  3. (NON-ITALIC) Same graph with shx=0 -> white_text > 0, no black block.

Run:
    python backend/tests/test_qa_independent_repro.py
"""
import os
import sys
import subprocess
import tempfile

FFMPEG = r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
FONT = r"C:/Users/11833/AppData/Local/Microsoft/Windows/Fonts/FZShuiYJW_Zhong.TTF"
TEXT = "今日要闻速递"

# ffmpeg filter escaping: backslash -> slash, colon -> escaped colon
def esc_font(p: str) -> str:
    return p.replace("\\", "/").replace(":", "\\:")

# text escaping (mirrors video_service.render_cover rules)
def esc_text(t: str) -> str:
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def make_bg(path, color=(255, 0, 0), size=(320, 320)):
    from PIL import Image
    Image.new("RGB", size, color).save(path)


def count_pixels(png):
    from PIL import Image
    if not os.path.exists(png):
        return None, None  # signal "no output produced"
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


def build_fixed_graph(fontfile, safe, w, h, shx, borderw=0, fontcolor="white",
                      s_color="black"):
    """Reconstructed FIXED graph (independent of engineer code)."""
    return (
        "[0:v]format=rgba[base];"
        f"color=c=black@0:s={w}x{h}:r=25,format=rgba,"
        f"drawtext=text='{safe}':fontfile='{fontfile}':"
        f"fontsize=64:fontcolor={fontcolor}:"
        f"bordercolor={s_color}:borderw={borderw}:"
        f"x=w*50/100-text_w/2:y=h*50/100-th/2,"
        f"shear=shx={shx}:fillcolor=0x00000000[layer0];"
        "[base][layer0]overlay=x=0:y=0:shortest=1[out]"
    )


def build_old_bug_graph(fontfile, safe, w, h):
    """Re-introduces the OLD bug: drawtext with `fontstyle=italic`."""
    return (
        "[0:v]format=rgba[base];"
        f"color=c=black@0:s={w}x{h}:r=25,format=rgba,"
        f"drawtext=text='{safe}':fontfile='{fontfile}':"
        f"fontsize=64:fontcolor=white:"
        f"fontstyle=italic:"
        f"bordercolor=black:borderw=0:"
        f"x=w*50/100-text_w/2:y=h*50/100-th/2,"
        f"shear=shx=0.28:fillcolor=0x00000000[layer0];"
        "[base][layer0]overlay=x=0:y=0:shortest=1[out]"
    )


def run_ffmpeg(bg, fc, out):
    cmd = [FFMPEG, "-i", bg, "-filter_complex", fc,
           "-map", "[out]", "-frames:v", "1", "-y", out]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return res


RESULTS = []
def check(name, cond, detail=""):
    RESULTS.append((name, cond, detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))


def main():
    if not os.path.exists(FFMPEG):
        print(f"FFMPEG not found: {FFMPEG}"); sys.exit(2)
    if not os.path.exists(FONT):
        print(f"FONT not found: {FONT}"); sys.exit(2)

    print(f"FFMPEG: {FFMPEG}\nFONT: {FONT}\nTEXT: {TEXT}\n")

    fontfile = esc_font(FONT)
    safe = esc_text(TEXT)
    W = H = 320

    # ---- (1) FIXED logic: italic ON via shear ----
    print("=== [1] FIXED logic: italic via shear=shx=0.28 (no fontstyle) ===")
    bg = tempfile.mktemp(suffix=".png")
    out = tempfile.mktemp(suffix=".png")
    make_bg(bg, color=(255, 0, 0), size=(W, H))
    fc = build_fixed_graph(fontfile, safe, W, H, shx=0.28)
    check("fixed graph: contains NO 'fontstyle'", "fontstyle" not in fc, fc)
    check("fixed graph: contains shear=shx=0.28", "shear=shx=0.28" in fc)
    check("fixed graph: contains transparent fillcolor", "fillcolor=0x00000000" in fc)
    res = run_ffmpeg(bg, fc, out)
    check("fixed: ffmpeg returncode == 0", res.returncode == 0,
          f"rc={res.returncode}; stderr tail={res.stderr[-300:]}")
    white, black = count_pixels(out)
    print(f"    white_text={white}  black_block={black}")
    check("fixed(italic ON): text visible (white_text>0)", white is not None and white > 0, f"white={white}")
    check("fixed(italic ON): NO black block (black_block==0)", black == 0, f"black={black}")
    for p in (bg, out):
        try: os.unlink(p)
        except OSError: pass

    # ---- (2) COUNTER-EXAMPLE: old bug fontstyle=italic ----
    print("\n=== [2] COUNTER-EXAMPLE: OLD bug fontstyle=italic (must FAIL) ===")
    bg = tempfile.mktemp(suffix=".png")
    out = tempfile.mktemp(suffix=".png")
    make_bg(bg, color=(255, 0, 0), size=(W, H))
    fc_bug = build_old_bug_graph(fontfile, safe, W, H)
    check("old-bug graph: DOES contain 'fontstyle=italic'", "fontstyle=italic" in fc_bug)
    res_bug = run_ffmpeg(bg, fc_bug, out)
    failed = res_bug.returncode != 0
    no_output = not os.path.exists(out) or os.path.getsize(out) == 0
    opt_not_found = "Option not found" in res_bug.stderr or "fontstyle" in res_bug.stderr
    print(f"    rc={res_bug.returncode}  output_exists={os.path.exists(out)}  "
          f"opt_not_found={opt_not_found}")
    print(f"    stderr tail: {res_bug.stderr[-300:]}")
    check("old-bug: ffmpeg FAILS (returncode != 0)", failed, f"rc={res_bug.returncode}")
    check("old-bug: NO usable output produced", no_output or opt_not_found,
          f"exists={os.path.exists(out)}")
    check("old-bug: failure is the fontstyle 'Option not found'",
          opt_not_found, res_bug.stderr[-200:])
    for p in (bg, out):
        try: os.unlink(p)
        except OSError: pass

    # ---- (3) NON-ITALIC: shx=0 ----
    print("\n=== [3] NON-ITALIC: shx=0 (normal text) ===")
    bg = tempfile.mktemp(suffix=".png")
    out = tempfile.mktemp(suffix=".png")
    make_bg(bg, color=(255, 0, 0), size=(W, H))
    fc_n = build_fixed_graph(fontfile, safe, W, H, shx=0)
    check("non-italic graph: shear=shx=0", "shear=shx=0" in fc_n)
    res_n = run_ffmpeg(bg, fc_n, out)
    white_n, black_n = count_pixels(out)
    print(f"    white_text={white_n}  black_block={black_n}")
    check("non-italic: text visible (white_text>0)", white_n is not None and white_n > 0, f"white={white_n}")
    check("non-italic: NO black block", black_n == 0, f"black={black_n}")
    for p in (bg, out):
        try: os.unlink(p)
        except OSError: pass

    passed = sum(1 for _, c, _ in RESULTS if c)
    total = len(RESULTS)
    print(f"\n=== QA INDEPENDENT REPRO SUMMARY: {passed}/{total} checks passed ===")
    if passed != total:
        sys.exit(1)
    print("ALL QA INDEPENDENT CHECKS PASSED")


if __name__ == "__main__":
    main()
