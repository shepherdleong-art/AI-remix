"""
Minimal reproduction test for cover concat fix.

Tests:
  1. OLD filter (direct concat with mismatched inputs) → should FAIL
  2. NEW filter (scale+format+setsar then concat) → should SUCCEED

Generates:
  - cover.png  : 1440x1920 RGB PNG (simulates cover frame, rgb24)
  - main.mp4   : 1080x1920 yuv420p 2s video with AAC audio (simulates main video)
"""
import os
import sys
import subprocess
import tempfile

# Use the same ffmpeg resolver as the project
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from services.video_service import _ffmpeg

FFMPEG = _ffmpeg()
TMP = tempfile.mkdtemp(prefix="concat_test_")

COVER_PNG = os.path.join(TMP, "cover.png")
MAIN_MP4 = os.path.join(TMP, "main.mp4")
OLD_OUT = os.path.join(TMP, "old_concat.mp4")
NEW_OUT = os.path.join(TMP, "new_concat.mp4")

TARGET_W, TARGET_H = 1080, 1920
COVER_W, COVER_H = 1440, 1920  # intentionally different from target


def run(cmd, label, timeout=60):
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        print(f"  [{label}] FAILED (rc={r.returncode})")
        print(f"  stderr tail: {r.stderr.decode(errors='replace')[-400:]}")
    else:
        print(f"  [{label}] OK")
    return r


def gen_cover_png():
    """Generate a 1440x1920 solid-color PNG (rgb24, like render_cover output)."""
    r = run([
        FFMPEG, "-f", "lavfi", "-i",
        f"color=c=blue:s={COVER_W}x{COVER_H}:d=0.04",
        "-frames:v", "1",
        "-y", COVER_PNG,
    ], "gen_cover_png")
    assert os.path.exists(COVER_PNG) and os.path.getsize(COVER_PNG) > 0, "cover PNG not created"
    print(f"  cover.png: {COVER_W}x{COVER_H}, size={os.path.getsize(COVER_PNG)} bytes")


def gen_main_video():
    """Generate a 1080x1920 yuv420p 2s video with AAC audio."""
    r = run([
        FFMPEG,
        "-f", "lavfi", "-i", f"color=c=green:s={TARGET_W}x{TARGET_H}:r=30:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-y", MAIN_MP4,
    ], "gen_main_video")
    assert os.path.exists(MAIN_MP4) and os.path.getsize(MAIN_MP4) > 0, "main video not created"
    print(f"  main.mp4: {TARGET_W}x{TARGET_H}, size={os.path.getsize(MAIN_MP4)} bytes")


def test_old_filter():
    """OLD: direct concat without normalizing — should FAIL due to mismatch."""
    print("\n=== TEST 1: OLD filter (direct concat) ===")
    cover_dur = 0.5
    r = run([
        FFMPEG,
        "-loop", "1", "-t", str(cover_dur), "-i", COVER_PNG,
        "-i", MAIN_MP4,
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1[outv]",
        "-map", "[outv]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac",
        "-y", OLD_OUT,
    ], "old_concat")

    if r.returncode == 0 and os.path.exists(OLD_OUT) and os.path.getsize(OLD_OUT) > 0:
        # Even if rc=0, check if output actually has video frames
        probe = subprocess.run(
            [FFMPEG, "-i", OLD_OUT], capture_output=True, timeout=10,
        )
        info = probe.stderr.decode(errors='replace')
        if "frame=    0" in info or "no packets" in info.lower():
            print("  RESULT: OLD filter produced EMPTY output (frame=0) — BUG REPRODUCED")
            return False
        print("  RESULT: OLD filter succeeded (unexpected — inputs may have been compatible)")
        return True
    else:
        print("  RESULT: OLD filter FAILED — BUG REPRODUCED")
        return False


def test_new_filter():
    """NEW: scale+format+setsar then concat — should SUCCEED."""
    print("\n=== TEST 2: NEW filter (scale+format+setsar+concat) ===")
    cover_dur = 0.5
    concat_filter = (
        f"[0:v]scale={TARGET_W}:{TARGET_H},format=yuv420p,setsar=1[v0];"
        f"[1:v]scale={TARGET_W}:{TARGET_H},format=yuv420p,setsar=1[v1];"
        f"[v0][v1]concat=n=2:v=1[outv]"
    )
    r = run([
        FFMPEG,
        "-loop", "1", "-t", str(cover_dur), "-i", COVER_PNG,
        "-i", MAIN_MP4,
        "-filter_complex", concat_filter,
        "-map", "[outv]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-y", NEW_OUT,
    ], "new_concat")

    if r.returncode != 0:
        print("  RESULT: NEW filter FAILED — FIX NOT WORKING")
        return False

    if not os.path.exists(NEW_OUT) or os.path.getsize(NEW_OUT) == 0:
        print("  RESULT: NEW filter output is empty — FIX NOT WORKING")
        return False

    # Verify output has a video stream with frames
    probe = subprocess.run(
        [FFMPEG, "-i", NEW_OUT], capture_output=True, timeout=10,
    )
    info = probe.stderr.decode(errors='replace')
    print(f"  output size: {os.path.getsize(NEW_OUT)} bytes")
    print(f"  probe info tail:\n{info[-300:]}")

    # Check for video stream
    has_video = "Video:" in info
    has_audio = "Audio:" in info
    print(f"  has_video={has_video}, has_audio={has_audio}")

    if has_video and os.path.getsize(NEW_OUT) > 0:
        print("  RESULT: NEW filter SUCCEEDED — FIX WORKS")
        return True
    else:
        print("  RESULT: NEW filter output missing video stream — FIX NOT WORKING")
        return False


if __name__ == "__main__":
    print(f"ffmpeg: {FFMPEG}")
    print(f"temp dir: {TMP}")

    print("\n--- Generating test inputs ---")
    gen_cover_png()
    gen_main_video()

    old_ok = test_old_filter()
    new_ok = test_new_filter()

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  OLD filter (direct concat):   {'FAIL (expected)' if not old_ok else 'PASS (unexpected)'}")
    print(f"  NEW filter (normalized concat): {'PASS (expected)' if new_ok else 'FAIL (unexpected)'}")

    if new_ok:
        print("\n  VERDICT: Fix is working correctly.")
        sys.exit(0)
    else:
        print("\n  VERDICT: Fix is NOT working.")
        sys.exit(1)
