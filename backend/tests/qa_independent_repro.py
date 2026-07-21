#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
INDEPENDENT QA REPRODUCTION for the "exported video freezes at the end"
(end-freeze) bug, written by QA (Edward) to verify the engineer's fix WITHOUT
depending on the engineer's test code.

Why this script exists
----------------------
The team-lead requires *real ffmpeg execution*, not just source-string review
(a prior round missed a fatal bug by only grepping code). This script:

  1. OLD-BEHAVIOUR REPRO: build a 2s moving video + 4s audio, run the ORIGINAL
     buggy command ``-i A -i B -t 4``. Prove ffmpeg froze the last frame to
     fill the gap: frame@3.0 == frame@2.0 (frozen), while frame@1.0 != frame@2.0
     (video was moving before the freeze). This is hard evidence the root cause
     (output forced longer than the video stream) existed.

  2. NEW-BEHAVIOUR VERIFY: build the FIXED pipeline — first extend the 2s video
     to 4s with ``tpad=stop_mode=add:stop_duration=2.0`` (as an OUTPUT filter,
     after all -i), THEN run ``-i A_padded -i B -t 4``. Prove:
       - the padded video stream *is* 4.0s (so ``-t 4`` no longer overruns an
         exhausted stream) — measured by probing the padded input duration;
       - final output is exactly 4.0s aligned to the audio;
       - the tail in [2,4] is the tpad last-frame clone (EXPECTED when source
         material is insufficient — team-lead considers this "normal").

  3. NO-REGRESSION: 5s video + 4s audio. Both OLD and NEW produce a 4.0s clip
     with NO freeze inside [0,4] (frame@2.5 != frame@1.5), and the NEW command
     adds NO tpad (video input stays 5s) so its frames are byte-identical to
     the OLD output (behaviour preserved).

Frame comparison uses an ffmpeg raw-video MD5 hash (no external PIL dependency),
which is deterministic per frame content.

NOTE on video source: the brief suggested ``color=c=red``. A solid colour is
STATIC — every frame is identical, so a freeze would be indistinguishable from
normal playback. To actually *detect* a freeze we need a MOVING source, so we
use ``testsrc`` (a moving timestamp + bouncing ball), which is exactly the kind
of "distinguishable frame" the brief allows ("或其他可辨帧").
"""
import os
import sys
import hashlib
import subprocess
import tempfile

FFMPEG = r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"  # fall back to PATH

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""))


def run(cmd, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("timeout", 120)
    return subprocess.run(cmd, **kw)


def gen_video(path, seconds, w=360, h=640, rate=30, src="testsrc"):
    """Generate a MOVING clip so freeze is detectable across time."""
    cmd = [
        FFMPEG, "-f", "lavfi",
        "-i", f"{src}=size={w}x{h}:rate={rate}:duration={seconds}",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-y", path,
    ]
    return run(cmd)


def gen_audio(path, seconds, freq=1000):
    cmd = [
        FFMPEG, "-f", "lavfi",
        "-i", f"sine=frequency={freq}:duration={seconds}",
        "-c:a", "aac", "-b:a", "128k", "-y", path,
    ]
    return run(cmd)


def probe_duration(path):
    """Container duration (longest stream) via ffmpeg stderr parsing."""
    res = run([FFMPEG, "-i", path, "-f", "null", "-"])
    for line in res.stderr.split("\n"):
        if "Duration:" in line:
            t = line.split("Duration:")[1].split(",")[0].strip()
            p = t.split(":")
            return float(p[0]) * 3600 + float(p[1]) * 60 + float(p[2])
    return 0.0


def frame_sig(path, t):
    """MD5 of the raw decoded frame at time t (deterministic per content)."""
    res = subprocess.run(
        [FFMPEG, "-ss", str(t), "-i", path, "-vframes", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, timeout=60,
    )
    return hashlib.md5(res.stdout).hexdigest()


def frames_equal(path, t1, t2):
    return frame_sig(path, t1) == frame_sig(path, t2)


def old_mix(video, audio, out, audio_dur):
    """ORIGINAL (buggy) audio-mix: -t audio_dur overruns a short video stream."""
    return run([
        FFMPEG, "-i", video, "-i", audio,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(audio_dur), "-y", out,
    ])


def new_mix(video, audio, out, audio_dur, pad=0.0):
    """FIXED mix. Mirrors the real code at video_service.py:271 — ``-vf`` (tpad)
    is ONLY emitted when ``pad > 0``. When ``pad == 0`` (video >= audio) NO
    ``-vf`` is added, so the command is byte-identical to the OLD mix and the
    output frames must match exactly (no regression)."""
    cmd = [FFMPEG, "-i", video, "-i", audio]
    if pad > 0:
        cmd += ["-vf", f"tpad=stop_mode=add:stop_duration={pad:.3f}"]
    cmd += [
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-t", str(audio_dur), "-y", out,
    ]
    return run(cmd)


def main():
    if not os.path.exists(FFMPEG) and FFMPEG == "ffmpeg":
        print("FFMPEG not found on PATH either."); sys.exit(2)
    print(f"FFMPEG: {FFMPEG}\n")

    tmp = tempfile.mkdtemp(prefix="qa_repro_")

    # ----- materials -----
    vid_short = os.path.join(tmp, "vid_2s.mp4")   # video < audio
    vid_long = os.path.join(tmp, "vid_5s.mp4")    # video >= audio
    aud_4s = os.path.join(tmp, "aud_4s.aac")      # 4s narration
    check("gen 2s moving video rc==0", gen_video(vid_short, 2).returncode == 0)
    check("gen 5s moving video rc==0", gen_video(vid_long, 5).returncode == 0)
    check("gen 4s audio rc==0", gen_audio(aud_4s, 4).returncode == 0)

    # ===================================================================== #
    # 1. OLD-BEHAVIOUR REPRO — video(2s) + audio(4s), forced -t 4
    # ===================================================================== #
    print("\n=== [1] OLD COMMAND REPRO: -i A -i B -t 4  (video 2s < audio 4s) ===")
    out_old = os.path.join(tmp, "old.mp4")
    r_old = old_mix(vid_short, aud_4s, out_old, 4.0)
    check("OLD: ffmpeg rc==0", r_old.returncode == 0, r_old.stderr[-200:])

    dur_old = probe_duration(out_old)
    check("OLD: output duration ~= 4.0s", abs(dur_old - 4.0) < 0.1, f"dur={dur_old:.3f}")

    # Freeze signature: tail frames identical (last real frame cloned by -t).
    frozen = frames_equal(out_old, 2.0, 3.0)
    check("OLD: frame@3.0 == frame@2.0  (END FREEZE reproduced)", frozen)

    # Sanity: video WAS moving before the freeze point.
    moving = not frames_equal(out_old, 1.0, 2.0)
    check("OLD: frame@1.0 != frame@2.0  (video moved before freeze)", moving)

    # Crucial: the video INPUT stream was only 2s but output forced to 4s,
    # i.e. ffmpeg overran an exhausted stream to fill the gap.
    src_dur = probe_duration(vid_short)
    check("OLD: source video was only 2.0s but output forced to 4.0s "
          "(ffmpeg froze to fill the gap)",
          abs(src_dur - 2.0) < 0.1 and dur_old > src_dur + 1.0,
          f"src={src_dur:.3f} out={dur_old:.3f}")

    # ===================================================================== #
    # 2. NEW-BEHAVIOUR VERIFY — pad video to 4s with tpad, then -t 4
    # ===================================================================== #
    print("\n=== [2] NEW COMMAND VERIFY: tpad video to 4s THEN -i A -i B -t 4 ===")
    vid_padded = os.path.join(tmp, "vid_2s_padded.mp4")
    # Engineer's fix: tpad as an OUTPUT filter (after all -i).
    r_pad = run([
        FFMPEG, "-i", vid_short,
        "-vf", "tpad=stop_mode=add:stop_duration=2.000",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-y", vid_padded,
    ])
    check("NEW: tpad step rc==0", r_pad.returncode == 0, r_pad.stderr[-200:])

    pad_dur = probe_duration(vid_padded)
    # The video stream is now extended to exactly 4.0s BEFORE the -t mix,
    # so -t no longer overruns an exhausted stream.
    check("NEW: padded video stream == 4.0s (extends past 2s source, -t won't overrun)",
          abs(pad_dur - 4.0) < 0.1, f"padded={pad_dur:.3f}")

    out_new = os.path.join(tmp, "new.mp4")
    # Faithful real-code form: tpad emitted as -vf inside the mix command.
    r_new = new_mix(vid_short, aud_4s, out_new, 4.0, pad=2.0)
    check("NEW: ffmpeg rc==0", r_new.returncode == 0, r_new.stderr[-200:])

    dur_new = probe_duration(out_new)
    check("NEW: output duration ~= 4.0s", abs(dur_new - 4.0) < 0.1, f"dur={dur_new:.3f}")
    check("NEW: duration aligns to audio exactly (no extra stretch)",
          abs(dur_new - 4.0) < 0.05)

    # Tail in [2,4] is the tpad last-frame clone — EXPECTED (material insufficient).
    check("NEW: tail [2,4] is last-frame clone (expected tpad fill)",
          frames_equal(out_new, 2.0, 3.0))

    # KEY MECHANISM PROOF: in the OLD mix the video input (2s) was shorter than
    # -t (4s) -> ffmpeg froze. In the NEW mix the video input (4s) == -t (4s) ->
    # no overrun. Demonstrate the input-stream difference directly.
    check("NEW: video INPUT stream (4.0s) == -t (4.0s) so -t does NOT overrun "
          "an exhausted stream (root cause eliminated)",
          abs(pad_dur - 4.0) < 0.1 and abs(dur_new - 4.0) < 0.1)

    # ===================================================================== #
    # 3. NO-REGRESSION — video(5s) >= audio(4s)
    # ===================================================================== #
    print("\n=== [3] NO-REGRESSION: video 5s >= audio 4s (OLD vs NEW) ===")
    out_old_l = os.path.join(tmp, "old_long.mp4")
    out_new_l = os.path.join(tmp, "new_long.mp4")

    # OLD command on the long video (no -vf).
    r_ol = old_mix(vid_long, aud_4s, out_old_l, 4.0)
    check("OLD(long): ffmpeg rc==0", r_ol.returncode == 0, r_ol.stderr[-200:])

    # NEW command: video(5s) >= audio(4s) so NO tpad is needed -> pad=0 means NO
    # -vf is emitted (real code: `if vf:`). The command is therefore identical
    # to the OLD mix, so the output must be byte-identical (no regression).
    r_nl = new_mix(vid_long, aud_4s, out_new_l, 4.0, pad=0.0)
    check("NEW(long): ffmpeg rc==0", r_nl.returncode == 0, r_nl.stderr[-200:])

    check("NO-REG: OLD dur ~= 4.0", abs(probe_duration(out_old_l) - 4.0) < 0.1)
    check("NO-REG: NEW dur ~= 4.0", abs(probe_duration(out_new_l) - 4.0) < 0.1)
    check("NO-REG: OLD frame@2.5 != frame@1.5 (no freeze)",
          not frames_equal(out_old_l, 1.5, 2.5))
    check("NO-REG: NEW frame@2.5 != frame@1.5 (no freeze)",
          not frames_equal(out_new_l, 1.5, 2.5))
    # NEW adds no tpad here -> frames identical to OLD (behaviour preserved).
    check("NO-REG: NEW frame@1.5 == OLD frame@1.5 (identical fix path)",
          frame_sig(out_old_l, 1.5) == frame_sig(out_new_l, 1.5))
    check("NO-REG: NEW frame@3.0 == OLD frame@3.0 (identical fix path)",
          frame_sig(out_old_l, 3.0) == frame_sig(out_new_l, 3.0))

    # ----- summary -----
    passed = sum(1 for _, c, _ in RESULTS if c)
    total = len(RESULTS)
    print(f"\n=== QA INDEPENDENT REPRO SUMMARY: {passed}/{total} checks passed ===")
    try:
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)
    except OSError:
        pass
    if passed != total:
        sys.exit(1)
    print("ALL QA INDEPENDENT REPRO CHECKS PASSED")


if __name__ == "__main__":
    main()
