#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
节拍检测回退验证（design-match-audio-first.md §T7 的 D 项 / T2）。

D1. 含静音的合成音频（3s 正弦 + 1s 静音 + 3s 正弦，共 7s）→
    BeatDetector.detect 返回 beats 且 count>0，fallback=False，切点落在静音区。
D2. 无静音的合成音频（连续 7s 正弦）→
    BeatDetector.detect 返回 fallback=True 且返回均匀切点、不报错（count>0）。

全程真实 ffmpeg（silencedetect 是 ffmpeg 内置滤镜），不 monkeypatch subprocess。

运行（managed Python，从项目根目录）：
    C:/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pytest backend/tests/test_beat_detect.py -q
"""
import os
import sys
import subprocess
import tempfile

os.environ.setdefault(
    "FFMPEG_PATH", r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
)
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.video_service import _ffmpeg  # noqa: E402
from services.beat_detect import BeatDetector  # noqa: E402

FF = _ffmpeg()


def _gen_audio(path, dur):
    r = subprocess.run(
        [FF, "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
         "-c:a", "libmp3lame", "-q:a", "2", "-y", path],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"生成音频失败: {r.stderr[-200:]}"


def _gen_silent_mid_audio(path, tone=3.0, silence=1.0):
    """3s 正弦 + 1s 静音 + 3s 正弦 → 中间有静音段。"""
    p_t0 = path + ".t0.mp3"
    p_s = path + ".sil.mp3"
    p_t1 = path + ".t1.mp3"
    _gen_audio(p_t0, tone)
    rs = subprocess.run(
        [FF, "-f", "lavfi", "-i",
         f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={silence}",
         "-c:a", "libmp3lame", "-q:a", "2", "-y", p_s],
        capture_output=True, text=True, timeout=60,
    )
    assert rs.returncode == 0, rs.stderr[-200:]
    _gen_audio(p_t1, tone)
    rc = subprocess.run(
        [FF, "-i", p_t0, "-i", p_s, "-i", p_t1,
         "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1[a]",
         "-map", "[a]", "-c:a", "libmp3lame", "-q:a", "2", "-y", path],
        capture_output=True, text=True, timeout=60,
    )
    assert rc.returncode == 0, rc.stderr[-200:]
    for p in (p_t0, p_s, p_t1):
        try:
            os.unlink(p)
        except OSError:
            pass


def test_beat_detect_with_silence_finds_cuts():
    """D1：含静音音频 → 检测到切点（fallback=False），切点落在静音区。"""
    tmp = tempfile.mkdtemp(prefix="beat_sil_")
    try:
        aud = os.path.join(tmp, "with_silence.mp3")
        _gen_silent_mid_audio(aud, tone=3.0, silence=1.0)  # 7s, 静音区 ~3-4s
        res = BeatDetector().detect(aud)

        assert res["fallback"] is False, f"应检测到静音, fallback={res['fallback']}"
        assert res["count"] > 0, f"beats 应为空, count={res['count']}"
        assert all("time" in b for b in res["beats"]), "beats 缺 time 字段"
        times = [b["time"] for b in res["beats"]]
        # 至少一个切点落在静音中心附近（3s 与 4s 之间）
        assert any(2.5 < t < 4.5 for t in times), f"切点未落在静音区: {times}"
        print(f"[BEAT-D1] count={res['count']}, fallback={res['fallback']}, times={times}")
    finally:
        import shutil
        try:
            shutil.rmtree(tmp)
        except OSError:
            pass


def test_beat_detect_no_silence_uniform_fallback():
    """D2：无静音连续正弦 → fallback=True 且返回均匀切点，不报错。"""
    tmp = tempfile.mkdtemp(prefix="beat_nosil_")
    try:
        aud = os.path.join(tmp, "no_silence.mp3")
        _gen_audio(aud, 7.0)  # 连续 7s 正弦，无静音
        res = BeatDetector().detect(aud)

        assert res["fallback"] is True, f"应回退均匀切点, fallback={res['fallback']}"
        assert res["count"] > 0, f"均匀切点应为空, count={res['count']}"
        # 均匀切点：总时长 7s，分为 8 段 → 内部 7 个切点
        times = [b["time"] for b in res["beats"]]
        assert len(times) == 7, f"均匀切点数量应为 7, 实际 {len(times)}"
        # 切点应大致等距（~1s 间隔），且都在 (0,7) 内
        assert all(0.0 < t < 7.0 for t in times), f"切点越界: {times}"
        print(f"[BEAT-D2] count={res['count']}, fallback={res['fallback']}, times={times}")
    finally:
        import shutil
        try:
            shutil.rmtree(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
