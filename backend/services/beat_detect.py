"""
节拍检测：封装 ffmpeg ``silencedetect``，返回口播气口（静音段中心）作为推荐切点。

- 若音频中存在静音段，返回每段静音的中心时间（秒）及噪声水平作为 score。
- 若音频无静音（或检测失败），回退到均匀切点（fallback=True）。
- 零新依赖：silencedetect 是 ffmpeg 内置滤镜；ffmpeg 路径复用 video_service._ffmpeg。
- Windows 路径经 ``p.replace("\\","/").replace(":","\\:")`` 转义。
"""
from __future__ import annotations

import os
import re
import logging
import subprocess

from services.video_service import _ffmpeg, get_audio_duration

logger = logging.getLogger(__name__)

# silencedetect 默认参数
_NOISE = -35.0  # 静音判定阈值(dB)
_MIN_SILENCE = 0.20  # 最小静音时长(s)


class BeatDetector:
    """用 ffmpeg silencedetect 检测口播气口，返回推荐切点。"""

    def detect(
        self,
        audio_path: str,
        noise_threshold: float = _NOISE,
        min_silence: float = _MIN_SILENCE,
    ) -> dict:
        """检测音频中的静音气口。

        Returns:
            {
                "beats": [{"time": float, "score": float}, ...],
                "count": int,
                "fallback": bool,
            }
        """
        if not audio_path or not os.path.exists(audio_path):
            logger.warning(f"[BEAT] audio not found: {audio_path}")
            return {"beats": [], "count": 0, "fallback": True}

        try:
            silence = self._silencedetect(audio_path, noise_threshold, min_silence)
            if silence:
                return {"beats": silence, "count": len(silence), "fallback": False}
            logger.info("[BEAT] no silence detected, use uniform fallback")
        except Exception as e:  # pragma: no cover - 防御性兜底
            logger.warning(f"[BEAT] silencedetect failed ({e}), fallback to uniform")

        total = self._safe_duration(audio_path)
        uniform = self._uniform_fallback(total)
        return {"beats": uniform, "count": len(uniform), "fallback": True}

    def _silencedetect(self, audio_path: str, noise: float, min_silence: float) -> list[dict]:
        """调用 ffmpeg silencedetect 并解析出静音段中心。"""
        # 注意：路径转义（p.replace("\\","/").replace(":","\\:")）只用于
        # drawtext 的 fontfile/textfile 这类 *filter 内部字符串*，**不能**用于
        # ``-i`` 输入参数。video_service.py 全程对 ``-i`` 使用原始路径；
        # Windows 下转义后的 ``C\:/...`` 会让 ffmpeg 报 "Invalid argument" 打不开。
        cmd = [
            _ffmpeg(), "-i", audio_path,
            "-af", f"silencedetect=noise={noise}dB:d={min_silence}",
            "-f", "null", "-",
        ]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except subprocess.SubprocessError as e:
            raise RuntimeError(f"ffmpeg silencedetect error: {e}") from e

        starts: list[float] = []
        ends: list[tuple[float, float, float | None]] = []
        for line in res.stderr.splitlines():
            if "silence_start:" in line:
                try:
                    t = float(line.split("silence_start:")[1].strip().split()[0])
                    starts.append(t)
                except (ValueError, IndexError):
                    pass
            elif "silence_end:" in line:
                try:
                    seg = line.split("silence_end:")[1]
                    end_t = float(seg.strip().split()[0])
                    dur = 0.0
                    nl: float | None = None
                    dm = re.search(r"silence_duration:\s*([\d.]+)", line)
                    if dm:
                        dur = float(dm.group(1))
                    nm = re.search(r"noise_level:\s*([-\d.]+)", line)
                    if nm:
                        nl = float(nm.group(1))
                    ends.append((end_t, dur, nl))
                except (ValueError, IndexError):
                    pass

        beats: list[dict] = []
        paired = min(len(starts), len(ends))
        for k in range(paired):
            s = starts[k]
            e, dur, nl = ends[k]
            mid = (s + e) / 2.0
            beats.append({"time": round(mid, 3), "score": nl if nl is not None else -noise})
        # 开头静音（只有 silence_end 没有对应 silence_start）也视为气口
        if len(ends) > len(starts):
            for k in range(len(starts), len(ends)):
                e, dur, nl = ends[k]
                mid = e - dur / 2.0 if dur > 0 else e
                beats.append({"time": round(mid, 3), "score": nl if nl is not None else -noise})
        beats.sort(key=lambda b: b["time"])
        return beats

    def _uniform_fallback(self, total: float) -> list[dict]:
        """无静音时的均匀切点：把总时长分为 8 段，取内部 7 个切点。"""
        if total <= 0:
            return []
        n = 8
        return [{"time": round(total * i / n, 3), "score": 0.0} for i in range(1, n)]

    def _safe_duration(self, audio_path: str) -> float:
        try:
            return get_audio_duration(audio_path)
        except Exception:  # pragma: no cover
            return 0.0
