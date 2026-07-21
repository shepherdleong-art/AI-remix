"""
Minimal repro test for the cover-concat audio sync bug.

Proves:
  - OLD command (``-map 1:a``): audio starts at output t=0 -> the first 0.5s
    (cover segment) already contains the loud beep -> audio is 0.5s EARLY.
  - NEW command (anullsrc + ``concat=n=2:v=1:a=1`` + ``-map [outa]``): the first
    0.5s is silent, sound only starts at 0.5s -> audio ALIGNED with video.

Run:  cd backend && python test_audio_sync.py
"""
import os
import re
import sys
import subprocess
import tempfile

# Make the backend package importable when run from the backend/ directory.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import FFMPEG_EXECUTABLE  # noqa: E402
from services.video_service import _probe_audio_stream  # noqa: E402

FF = FFMPEG_EXECUTABLE if os.path.exists(FFMPEG_EXECUTABLE) else "ffmpeg"

W, H = 1080, 1920
COVER_DUR = 0.5

tmp = tempfile.mkdtemp(prefix="audiosync_")
cover_png = os.path.join(tmp, "cover.png")
main_mp4 = os.path.join(tmp, "main.mp4")
old_final = os.path.join(tmp, "old_final.mp4")
new_final = os.path.join(tmp, "new_final.mp4")


def run(cmd, timeout=60):
    return subprocess.run(cmd, capture_output=True, timeout=timeout)


def max_volume(path, start, dur):
    """Return max_volume (dB) of the audio in [start, start+dur], or None."""
    r = run([FF, "-ss", str(start), "-t", str(dur), "-i", path,
             "-af", "volumedetect", "-f", "null", "-"], timeout=30)
    stderr = r.stderr.decode(errors="replace")
    m = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", stderr)
    return float(m.group(1)) if m else None


def duration_of(path):
    r = run([FF, "-i", path], timeout=15)
    for line in r.stderr.decode(errors="replace").splitlines():
        if "Duration:" in line:
            ts = line.split("Duration:")[1].split(",")[0].strip()
            h, m, s = ts.split(":")
            return float(h) * 3600 + float(m) * 60 + float(s)
    return -1.0


# ── 1. Build a cover PNG (solid red, 1080x1920) ──────────────────────────
run([FF, "-f", "lavfi", "-i", f"color=c=red:s={W}x{H}:d=1",
     "-vframes", "1", "-y", cover_png])
assert os.path.exists(cover_png), "cover PNG not created"
print(f"[setup] cover PNG: {os.path.getsize(cover_png)} bytes")

# ── 2. Build main video: 3s blue + 1 kHz beep (aac) ──────────────────────
r = run([FF,
         "-f", "lavfi", "-i", f"color=c=blue:s={W}x{H}:r=30:d=3",
         "-f", "lavfi", "-i", "sine=frequency=1000:duration=3:sample_rate=44100",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k",
         "-shortest", "-y", main_mp4])
assert r.returncode == 0, f"main video failed: {r.stderr.decode()[-400:]}"
print(f"[setup] main video: {os.path.getsize(main_mp4)} bytes, dur={duration_of(main_mp4):.2f}s")

info = _probe_audio_stream(main_mp4)
print(f"[probe] main audio info: {info}")
assert info is not None, "main video should have an audio stream"

# ── 3. OLD (buggy) command: video concat + map 1:a ───────────────────────
old_filter = (
    f"[0:v]scale={W}:{H},format=yuv420p,setsar=1[v0];"
    f"[1:v]scale={W}:{H},format=yuv420p,setsar=1[v1];"
    f"[v0][v1]concat=n=2:v=1[outv]"
)
r = run([FF,
         "-loop", "1", "-t", str(COVER_DUR), "-i", cover_png,
         "-i", main_mp4,
         "-filter_complex", old_filter,
         "-map", "[outv]", "-map", "1:a",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
         "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-y", old_final])
assert r.returncode == 0, f"OLD concat failed: {r.stderr.decode()[-600:]}"
print(f"[old ] final: dur={duration_of(old_final):.2f}s (expect 3.5s)")

# ── 4. NEW (fixed) command: anullsrc + concat a=1 + map [outa] ───────────
a_sr = info.get("sample_rate", 44100)
a_cl = info.get("channel_layout", "stereo")
if a_cl not in ("mono", "stereo"):
    a_cl = "stereo"
new_filter = (
    f"[0:v]scale={W}:{H},format=yuv420p,setsar=1[v0];"
    f"[1:v]scale={W}:{H},format=yuv420p,setsar=1[v1];"
    f"anullsrc=channel_layout={a_cl}:sample_rate={a_sr},"
    f"atrim=0:{COVER_DUR},asetpts=PTS-STARTPTS[a0];"
    f"[1:a]aresample={a_sr},aformat=channel_layouts={a_cl}[a1];"
    f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
)
r = run([FF,
         "-loop", "1", "-t", str(COVER_DUR), "-i", cover_png,
         "-i", main_mp4,
         "-filter_complex", new_filter,
         "-map", "[outv]", "-map", "[outa]",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
         "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-y", new_final])
assert r.returncode == 0, f"NEW concat failed: {r.stderr.decode()[-600:]}"
print(f"[new ] final: dur={duration_of(new_final):.2f}s (expect 3.5s)")

# ── 5. Measure audio levels ──────────────────────────────────────────────
old_early = max_volume(old_final, 0.0, COVER_DUR)
new_silent = max_volume(new_final, 0.0, COVER_DUR)
new_signal = max_volume(new_final, COVER_DUR, 0.5)

print()
print(f"[old ] 0.0-0.5s max_volume = {old_early} dB   -> expect loud (~0 dB): audio EARLY")
print(f"[new ] 0.0-0.5s max_volume = {new_silent} dB  -> expect ~-91 dB: SILENT")
print(f"[new ] 0.5-1.0s max_volume = {new_signal} dB  -> expect loud (~0 dB): ALIGNED")

SILENCE_THRESH = -60.0   # below -60 dB => silent
SIGNAL_THRESH = -20.0    # above -20 dB => signal present

old_bug = old_early is not None and old_early > SIGNAL_THRESH
new_sil_ok = new_silent is not None and new_silent < SILENCE_THRESH
new_sig_ok = new_signal is not None and new_signal > SIGNAL_THRESH

print()
print(f"OLD reproduces bug (sound in 0-0.5s): {'YES' if old_bug else 'NO'}")
print(f"NEW 0-0.5s silent:                    {'YES' if new_sil_ok else 'NO'}")
print(f"NEW 0.5s+ has sound:                  {'YES' if new_sig_ok else 'NO'}")

passed = old_bug and new_sil_ok and new_sig_ok
print()
print(f"RESULT: {'PASS' if passed else 'FAIL'}")
sys.exit(0 if passed else 1)
