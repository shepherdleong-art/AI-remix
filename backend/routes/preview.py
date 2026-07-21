"""
Preview assemble endpoint — fast ffmpeg concatenation of timeline segments
into a single preview video for the step-3 playback panel.
"""

import asyncio
import os
import hashlib
import logging
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.video_service import _ffmpeg
from config import TEMP_DIR

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/preview", tags=["preview"])

# 分段裁剪并行度：预览渲染同时阻塞事件循环会拖慢整个后端，
# 3 路并行兼顾速度与机器响应（实测足够，再大收益递减且易卡 UI）。
_TRIM_WORKERS = 3

# 按 cache_id 串行化同一预览的拼装：预加热与步骤3挂载会同时发起相同请求，
# 无锁时两个进程写同一批碎片/拼合文件互相踩踏（A 完成并清理碎片后 B 必然 500）。
_ASSEMBLE_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _assemble_lock(cache_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _ASSEMBLE_LOCKS.setdefault(cache_id, threading.Lock())


class AssembleRequest(BaseModel):
    timeline: list[dict]  # [{video_path, start_time, duration}, ...]
    width: int = 1080
    height: int = 1920


def _trim_segment(cache_id: str, i: int, seg: dict, width: int, height: int, out_dir) -> str | None:
    """裁剪单个片段为统一参数的预览碎片（供 concat -c copy 直接拼接）。"""
    vp = seg.get("video_path", "")
    if not vp or not os.path.exists(vp):
        return None
    start = float(seg.get("start_time", 0))
    dur = float(seg.get("duration", 3))
    trim_path = str(out_dir / f"_trim_{cache_id}_{i:03d}.mp4")
    r = subprocess.run([
        _ffmpeg(), "-ss", str(start), "-t", str(dur),
        "-i", vp,
        "-vf", f"scale={width}:{height}:force_original_aspect_ratio=increase,"
               f"crop={width}:{height},setsar=1",
        "-r", "30",  # 统一帧率，保证 concat -c copy 可拼接
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-an",
        "-y", trim_path,
    ], capture_output=True, timeout=60)
    if r.returncode != 0:
        logger.warning(f"Preview trim failed seg {i}: {r.stderr[-200:]}")
        return None
    return trim_path


def _assemble_sync(cache_id: str, timeline: list[dict], width: int, height: int, out_path, out_dir) -> None:
    """同步执行：并行裁剪 + 拼接（优先免转码 copy，失败回退重编码）。

    输出先写临时文件再原子替换到 out_path，避免并发的 /video 读取拿到半截文件。
    调用方必须已持有 _assemble_lock(cache_id)。
    """
    with ThreadPoolExecutor(max_workers=_TRIM_WORKERS) as pool:
        results = list(pool.map(
            lambda t: _trim_segment(cache_id, t[0], t[1], width, height, out_dir),
            enumerate(timeline),
        ))
    trimmed = [p for p in results if p]
    if not trimmed:
        raise HTTPException(500, "All segment trims failed")

    concat_file = str(out_dir / f"_cl_{cache_id}.txt")
    with open(concat_file, "w") as f:
        f.write("".join(f"file '{t}'\n" for t in trimmed))

    tmp_out = out_dir / f"_building_{cache_id}.mp4"
    # 优先 -c:v copy（所有碎片参数已统一，秒级完成）；失败则回退重编码兜底
    r = subprocess.run([
        _ffmpeg(), "-f", "concat", "-safe", "0", "-i", concat_file,
        "-c:v", "copy", "-an",
        "-y", str(tmp_out),
    ], capture_output=True, timeout=120)
    if r.returncode != 0 or not tmp_out.exists():
        logger.warning(f"Preview concat copy failed, fallback to re-encode: {r.stderr[-200:]}")
        r = subprocess.run([
            _ffmpeg(), "-f", "concat", "-safe", "0", "-i", concat_file,
            "-c:v", "libx264", "-crf", "28", "-an",
            "-y", str(tmp_out),
        ], capture_output=True, timeout=120)
        if r.returncode != 0 or not tmp_out.exists():
            logger.error(f"Preview concat failed: {r.stderr[-400:]}")
            raise HTTPException(500, f"Preview concat failed: {r.stderr[-200:]}")

    os.replace(tmp_out, out_path)

    for t in trimmed:
        try:
            os.unlink(t)
        except OSError:
            pass


@router.post("/assemble")
async def api_assemble_preview(req: AssembleRequest):
    """Concatenate timeline segments into a single preview mp4 (video only).

    Uses cache: a hash of the timeline determines the output filename so
    identical timelines reuse the same preview file.
    """
    if not req.timeline:
        raise HTTPException(400, "No timeline segments provided")

    # Build a cache key from the timeline (include width/height so switching
    # aspect ratio / resolution invalidates the cached preview).
    key_str = "|".join(
        f"{s.get('video_path','')}:{s.get('start_time',0):.3f}:{s.get('duration',0):.3f}"
        for s in req.timeline
    ) + f"|{req.width}x{req.height}"
    cache_id = hashlib.md5(key_str.encode()).hexdigest()[:12]
    out_dir = TEMP_DIR / "previews"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"prev_{cache_id}.mp4"

    if out_path.exists():
        # Already cached
        return {"code": 0, "data": {"path": str(out_path), "cached": True}, "message": "ok"}

    def _assemble_locked() -> bool:
        lock = _assemble_lock(cache_id)
        with lock:
            # 拿到锁后再查一次：并发同 key 请求中，后者直接吃前者缓存
            if out_path.exists():
                return True
            _assemble_sync(cache_id, req.timeline, req.width, req.height, out_path, out_dir)
            return False

    # 阻塞型 ffmpeg 工作放入线程，避免卡住后端事件循环（音频/缩略图等请求会被拖慢）
    cached = await asyncio.to_thread(_assemble_locked)

    return {"code": 0, "data": {"path": str(out_path), "cached": cached}, "message": "ok"}
