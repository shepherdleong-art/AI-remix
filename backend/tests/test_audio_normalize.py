"""
回归测试：TTS 音频规范化边界层 (normalize_audio)

不依赖任何 TTS API key。直接用 ffmpeg 造「WAV  payload 存成 .mp3 扩展名 + 24000Hz」
的非法输入（即后端此前真实存在的 bug），验证 normalize_audio 能把它规范为：
  - 44100 Hz 单声道 真·MP3（修正 WAV 穿 .mp3 马甲）
  - 时长基本保真（修正非标准采样率导致的播放怪声隐患）

运行：pytest backend/tests/test_audio_normalize.py -v
"""
import os
import re
import sys
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # backend/

# 让 normalize_audio 能找到 ffmpeg（与现有测试一致的定位方式）
if not os.environ.get("FFMPEG_PATH"):
    _cand = r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
    if os.path.exists(_cand):
        os.environ["FFMPEG_PATH"] = _cand
FFMPEG = os.environ.get("FFMPEG_PATH") or "ffmpeg"

from services.ai_service import normalize_audio  # noqa: E402


def _probe(path):
    r = subprocess.run([FFMPEG, "-i", path], capture_output=True, text=True, timeout=30)
    sr = ch = dur = None
    for line in r.stderr.splitlines():
        if "Audio:" in line:
            m = re.search(r"(\d+)\s*Hz", line)
            if m:
                sr = int(m.group(1))
            cm = re.search(r"Hz,\s*(\w+)", line)
            if cm:
                ch = cm.group(1)
        if "Duration:" in line:
            t = line.split("Duration:")[1].split(",")[0].strip()
            p = t.split(":"); dur = float(p[0]) * 3600 + float(p[1]) * 60 + float(p[2])
    return sr, ch, dur


def _make_wav_payload_in_mp3(path, sr=24000, dur=2.0):
    """写一个 WAV 编码内容，但文件名用 .mp3（复刻后端把 Qwen WAV 存成 .mp3 的 bug）。"""
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={sr}:duration={dur}",
         "-ac", "1", path],
        capture_output=True, text=True, timeout=30, check=True,
    )


def test_normalize_fixes_wav_in_mp3_mislabel(tmp_path):
    """WAV 穿 .mp3 马甲 + 24000Hz → 规范为 44100Hz 单声道 真·MP3。"""
    src = str(tmp_path / "tts_bug.mp3")  # 扩展名 .mp3，但内容是 WAV
    _make_wav_payload_in_mp3(src, sr=24000, dur=2.0)

    normalize_audio(src)

    sr, ch, dur = _probe(src)
    assert sr == 44100, f"期望 44100Hz，实际 {sr}"
    assert ch == "mono", f"期望 mono，实际 {ch}"
    assert abs(dur - 2.0) < 0.15, f"时长漂移过大: {dur}"
    r = subprocess.run([FFMPEG, "-i", src], capture_output=True, text=True, timeout=30)
    assert "Audio: mp3" in r.stderr, "输出应为 mp3 编码，而非原始 WAV"


def test_normalize_idempotent_on_44100(tmp_path):
    """输入已是 44100Hz 时仍输出 44100Hz 单声道 MP3，不引入异常。"""
    src = str(tmp_path / "tts_ok.mp3")
    _make_wav_payload_in_mp3(src, sr=44100, dur=1.5)

    normalize_audio(src)

    sr, ch, dur = _probe(src)
    assert sr == 44100, f"期望 44100Hz，实际 {sr}"
    assert ch == "mono", f"期望 mono，实际 {ch}"
    assert abs(dur - 1.5) < 0.15, f"时长漂移过大: {dur}"


def test_normalize_returns_original_on_failure(tmp_path):
    """输入文件不存在时，normalize_audio 不应抛异常，应原样返回路径。"""
    missing = str(tmp_path / "does_not_exist.mp3")
    result = normalize_audio(missing)
    assert result == missing
