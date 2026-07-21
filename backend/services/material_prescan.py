"""
素材预修辅助（O1）：自动建议可用区间 [suggested_in, suggested_out]。

实拍素材常见"头尾不可用"（开机黑场、按录制键前后的静默），本模块用 ffmpeg
`blackdetect`（黑帧）+ `silencedetect`（静音）扫描全片，给出建议：
- 头部黑帧/静音段的结束点 → ``suggested_in``；
- 尾部黑帧/静音段的开始点 → ``suggested_out``；
- 检测失败时回退 ``{"suggested_in": 0, "suggested_out": duration}``（全片可用）。

ffmpeg 可执行文件统一走 ``services.video_service._ffmpeg()``（与全项目一致）。
纯标准库实现，零新依赖。
"""
from __future__ import annotations

import os
import re
import logging
import subprocess
from pathlib import Path

try:
    from services.video_service import _ffmpeg
except ModuleNotFoundError:
    # 允许 `python services/material_prescan.py` 直接运行自测（生产由 backend/ 启动，无此分支）
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from services.video_service import _ffmpeg

logger = logging.getLogger(__name__)

# ─── 检测参数 ──────────────────────────────────────────────

# 黑帧判定：像素亮度阈值 0.10、最短黑场 0.1s（blackdetect 官方常用值）
_BLACK_PIX_TH: float = 0.10
_BLACK_MIN_DUR: float = 0.1

# 静音判定：噪声门限 -35dB、最短静音 0.5s（低于 0.5s 的停顿不算"头尾静默段"）
_SILENCE_NOISE_DB: int = -35
_SILENCE_MIN_DUR: float = 0.5

# 头/尾贴边容差：区间起点距 0（或终点距 duration）在该范围内才算"头部/尾部段"
_EDGE_TOL_SEC: float = 0.2

# 单条素材检测超时（黑帧/静音各一次全片解码，给足余量）
_DETECT_TIMEOUT_SEC: int = 300

# blackdetect 输出行：[blackdetect @ 0x...] black_start:0 black_end:2 black_duration:2
_BLACK_PAT = re.compile(
    r"black_start:\s*(?P<start>[\d.]+)\s+black_end:\s*(?P<end>[\d.]+)\s+black_duration:\s*(?P<dur>[\d.]+)"
)
# silencedetect 输出行：silence_start: 1.23 / silence_end: 2.34 | silence_duration: 1.11
_SILENCE_START_PAT = re.compile(r"silence_start:\s*(?P<start>[\d.]+)")
_SILENCE_END_PAT = re.compile(r"silence_end:\s*(?P<end>[\d.]+)\s*\|\s*silence_duration:\s*(?P<dur>[\d.]+)")


# ─── 内部：ffmpeg 探测 ────────────────────────────────────

def _probe_duration(video_path: str) -> float:
    """用 ffmpeg 读视频时长（与 video_service.detect_scenes 同款解析方式）。"""
    cmd = [_ffmpeg(), "-i", video_path, "-f", "null", "-"]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"时长探测失败: {video_path}\nstderr: {result.stderr[:300]}"
        )
    for line in result.stderr.split("\n"):
        if "Duration:" in line:
            time_str = line.split("Duration:")[1].split(",")[0].strip()
            parts = time_str.split(":")
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    raise RuntimeError(f"无法解析视频时长: {video_path}")


def _run_detect(video_path: str, filter_arg: str, stream: str) -> str:
    """跑一次 ffmpeg 检测滤镜，返回 stderr 文本（检测结果都打在 stderr）。

    Args:
        filter_arg: 滤镜表达式（blackdetect / silencedetect）。
        stream:     "v" 只留视频流（-an）；"a" 只留音频流（-vn）。
    """
    cmd = [_ffmpeg(), "-i", video_path]
    if stream == "v":
        cmd += ["-vf", filter_arg, "-an"]
    else:
        cmd += ["-af", filter_arg, "-vn"]
    cmd += ["-f", "null", "-"]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=_DETECT_TIMEOUT_SEC,
    )
    return result.stderr or ""


def _parse_black_intervals(stderr_text: str) -> list[dict]:
    """解析 blackdetect 输出 → [{start, end, duration}, ...]。"""
    intervals = []
    for m in _BLACK_PAT.finditer(stderr_text):
        intervals.append({
            "start": round(float(m.group("start")), 2),
            "end": round(float(m.group("end")), 2),
            "duration": round(float(m.group("dur")), 2),
        })
    return intervals


def _parse_silence_intervals(stderr_text: str) -> list[dict]:
    """解析 silencedetect 输出 → [{start, end, duration}, ...]（start/end 成行配对）。"""
    starts = [float(m.group("start")) for m in _SILENCE_START_PAT.finditer(stderr_text)]
    ends = [
        (float(m.group("end")), float(m.group("dur")))
        for m in _SILENCE_END_PAT.finditer(stderr_text)
    ]
    intervals = []
    for i, (end, dur) in enumerate(ends):
        # 优先用成对出现的 silence_start；末尾静音未闭合时 start 也可能缺失配对
        start = starts[i] if i < len(starts) else max(0.0, end - dur)
        intervals.append({
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": round(dur, 2),
        })
    return intervals


# ─── 主入口 ───────────────────────────────────────────────

def suggest_usable_range(video_path: str) -> dict:
    """分析视频头尾的黑帧/静音段，建议可用区间。

    Args:
        video_path: 素材绝对路径。

    Returns:
        {
            "suggested_in": float,      # 建议入点（头部黑帧/静音段结束点，无则 0）
            "suggested_out": float,     # 建议出点（尾部黑帧/静音段开始点，无则 duration）
            "duration": float,          # 全片时长（秒）
            "black_intervals": [...],   # 全部黑帧段 {start, end, duration}
            "silence_intervals": [...], # 全部静音段 {start, end, duration}
        }
        任一检测失败时对应 intervals 为空并回退全片可用；时长探测失败抛 RuntimeError。
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"素材文件不存在: {video_path}")

    duration = _probe_duration(video_path)

    # 黑帧检测（失败不致命，记日志后按无黑帧处理）
    black_intervals: list[dict] = []
    try:
        black_out = _run_detect(
            video_path,
            f"blackdetect=d={_BLACK_MIN_DUR}:pix_th={_BLACK_PIX_TH}",
            "v",
        )
        black_intervals = _parse_black_intervals(black_out)
    except Exception as e:
        logger.warning(f"[PRESCAN] 黑帧检测失败（按无黑帧回退）: {video_path}: {e}")

    # 静音检测（无音频流的素材 ffmpeg 会报错，同样按无静音回退）
    silence_intervals: list[dict] = []
    try:
        silence_out = _run_detect(
            video_path,
            f"silencedetect=noise={_SILENCE_NOISE_DB}dB:d={_SILENCE_MIN_DUR}",
            "a",
        )
        silence_intervals = _parse_silence_intervals(silence_out)
    except Exception as e:
        logger.warning(f"[PRESCAN] 静音检测失败（按无静音回退）: {video_path}: {e}")

    # ── 头部：起点贴着 0 的黑帧/静音段，其结束点作为建议入点（取更保守的较大值）──
    suggested_in = 0.0
    for iv in black_intervals + silence_intervals:
        if iv["start"] <= _EDGE_TOL_SEC and iv["end"] > suggested_in:
            suggested_in = iv["end"]

    # ── 尾部：终点贴着 duration 的黑帧/静音段，其开始点作为建议出点（取更保守的较小值）──
    suggested_out = duration
    for iv in black_intervals + silence_intervals:
        if iv["end"] >= duration - _EDGE_TOL_SEC and iv["start"] < suggested_out:
            suggested_out = iv["start"]

    # ── 防御：头尾段重叠/全片皆黑时保证 in < out，留至少 0.1s 可用窗 ──
    if suggested_in >= suggested_out:
        logger.warning(
            f"[PRESCAN] 头尾建议区间交叉（in={suggested_in:.2f} out={suggested_out:.2f}），"
            f"回退全片可用: {video_path}"
        )
        suggested_in, suggested_out = 0.0, duration

    return {
        "suggested_in": round(suggested_in, 2),
        "suggested_out": round(suggested_out, 2),
        "duration": round(duration, 2),
        "black_intervals": black_intervals,
        "silence_intervals": silence_intervals,
    }


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    import tempfile

    print("=== material_prescan 自测 ===")
    tmp_dir = tempfile.mkdtemp(prefix="mp_test_")

    # ── 1. 合成标定视频：2s 黑场+静音 → 3s 彩条+440Hz 音 → 2s 黑场+静音 ──
    sample = os.path.join(tmp_dir, "calibrated.mp4")
    cmd = [
        _ffmpeg(), "-y",
        "-f", "lavfi", "-i", "color=black:size=320x240:duration=2:rate=10",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:duration=3:rate=10",
        "-f", "lavfi", "-i", "color=black:size=320x240:duration=2:rate=10",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=3",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
        "-filter_complex",
        "[0:v][3:a][1:v][4:a][2:v][5:a]concat=n=3:v=1:a=1[v][a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        sample,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0 and os.path.exists(sample), f"合成标定视频失败: {r.stderr[-500:]}"

    info = suggest_usable_range(sample)
    print(f"  标定视频检测结果: in={info['suggested_in']} out={info['suggested_out']} "
          f"dur={info['duration']} black={info['black_intervals']} silence={info['silence_intervals']}")
    assert abs(info["duration"] - 7.0) < 0.5, f"时长应≈7s，实际 {info['duration']}"
    # 头部 2s 黑场+静音 → 建议入点应≈2（容差 ±0.6，编码/滤镜时间戳有轻微漂移）
    assert 1.4 <= info["suggested_in"] <= 2.6, f"建议入点应≈2s，实际 {info['suggested_in']}"
    # 尾部 2s 黑场+静音 → 建议出点应≈5
    assert 4.4 <= info["suggested_out"] <= 5.6, f"建议出点应≈5s，实际 {info['suggested_out']}"
    assert len(info["black_intervals"]) >= 2, "应检出头尾两段黑场"
    assert len(info["silence_intervals"]) >= 2, "应检出头尾两段静音"
    print("[OK] 头尾黑场+静音 → 建议区间 [≈2s, ≈5s]")

    # ── 2. 无头尾废片的正常视频：全程彩条+声音 → 回退全片可用 ──
    normal = os.path.join(tmp_dir, "normal.mp4")
    cmd = [
        _ffmpeg(), "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:duration=3:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:d=3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        normal,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, f"合成正常视频失败: {r.stderr[-500:]}"
    info2 = suggest_usable_range(normal)
    assert info2["suggested_in"] == 0.0, f"正常视频入点应为 0，实际 {info2['suggested_in']}"
    assert abs(info2["suggested_out"] - info2["duration"]) < 0.01, "正常视频出点应为 duration"
    print(f"[OK] 无头尾废片 → 回退全片可用 [0, {info2['suggested_out']}]")

    # ── 3. 无音频流视频：静音检测应静默回退，黑帧检测仍生效 ──
    muted = os.path.join(tmp_dir, "muted.mp4")
    cmd = [
        _ffmpeg(), "-y",
        "-f", "lavfi", "-i", "color=black:size=320x240:duration=2:rate=10",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:duration=3:rate=10",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]",
        "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        muted,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert r.returncode == 0, f"合成无音频视频失败: {r.stderr[-500:]}"
    info3 = suggest_usable_range(muted)
    assert 1.4 <= info3["suggested_in"] <= 2.6, f"无音频视频黑帧入点应≈2s，实际 {info3['suggested_in']}"
    assert info3["silence_intervals"] == [], "无音频流不应产出静音段"
    print(f"[OK] 无音频流 → 静音检测回退，黑帧建议仍生效 (in={info3['suggested_in']})")

    # ── 4. 不存在的文件 → FileNotFoundError ──
    try:
        suggest_usable_range(os.path.join(tmp_dir, "nope.mp4"))
        raise AssertionError("不存在的文件应抛 FileNotFoundError")
    except FileNotFoundError:
        print("[OK] 缺失文件 → FileNotFoundError")

    print("=== 全部自测通过 ===")
