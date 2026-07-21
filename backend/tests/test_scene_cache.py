#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
场景缓存真实命中验证（design-match-audio-first.md §T7 的 C 项 / T3）。

对同一合成片段连续调用两次 ``_analyze_single_video``（analyze-video 的真实逻辑）：
- 第一次：未命中缓存 → 调用 vision（用 monkeypatch 替换 analyze_frames_batch 以断言调用，
  但合成的 clips/scenes 必须真实存在，检测走真实 ffmpeg）。
- 第二次：应命中 scene_cache，不再发起 vision 调用。

断言：
1. analyze_frames_batch 仅被调用 1 次（第二次命中缓存，未发起 vision）。
2. 缓存索引文件 {TEMP_DIR}/ai_scene_cache.json 确有写入。
3. 两次返回的 descriptions 一致（来自缓存）。

注意：本测试允许 monkeypatch analyze_frames_batch（这是测"缓存是否避免 vision 调用"的标准手法），
但底层 detect_scenes / extract_scene_frames 都是真实 ffmpeg 执行，合成的 clip 真实存在。

运行（managed Python，从项目根目录）：
    C:/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pytest backend/tests/test_scene_cache.py -q
"""
import os
import sys
import json
import asyncio
import subprocess
import tempfile

os.environ.setdefault(
    "FFMPEG_PATH", r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
)
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.video_service import _ffmpeg  # noqa: E402
from services.scene_cache import scene_cache  # noqa: E402
import routes.ai_editing as aie  # noqa: E402

FF = _ffmpeg()


def _gen_clip(path, dur=5):
    spec = f"testsrc=size=360x640:rate=30:duration={dur}"
    r = subprocess.run(
        [FF, "-f", "lavfi", "-i", spec, "-c:v", "libx264",
         "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", path],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"生成片段失败: {r.stderr[-200:]}"


def test_scene_cache_hit_on_second_call(monkeypatch):
    """对同一片段第二次 analyze 应命中缓存，不再调用 vision。"""
    # 清空缓存索引，保证第一次是 miss
    cache_path = scene_cache.cache_path
    if os.path.exists(cache_path):
        os.unlink(cache_path)

    tmp = tempfile.mkdtemp(prefix="cache_test_")
    try:
        clip = os.path.join(tmp, "material.mp4")
        _gen_clip(clip, dur=5)

        calls = {"n": 0}

        async def _fake_analyze(frames, ctxs, api_key):
            calls["n"] += 1
            # 返回与帧数等长的假描述（不发起真实 vision API）
            return [f"cached_desc_{i}" for i in range(len(frames))]

        # monkeypatch 替换 vision 调用，用于断言"是否被再次调用"
        monkeypatch.setattr(aie, "analyze_frames_batch", _fake_analyze)

        # 第一次：应 miss 缓存 → 调用 vision 1 次
        r1 = asyncio.run(aie._analyze_single_video(clip, ""))
        # 第二次：应 hit 缓存 → 不再调用 vision
        r2 = asyncio.run(aie._analyze_single_video(clip, ""))

        # 1) vision 仅被调用 1 次
        assert calls["n"] == 1, f"vision 调用次数应为 1, 实际 {calls['n']}"

        # 2) 缓存索引文件确有写入
        assert os.path.exists(cache_path), f"缓存文件未生成: {cache_path}"
        with open(cache_path, "r", encoding="utf-8") as f:
            idx = json.load(f)
        assert len(idx) >= 1, "缓存索引为空"

        # 3) 两次 descriptions 一致（第二次来自缓存）
        scenes1, desc1, _ = r1
        scenes2, desc2, _ = r2
        assert len(desc1) == len(desc2) > 0
        assert desc1 == desc2, "两次返回的 descriptions 应一致（缓存命中）"
        assert desc1[0] == "cached_desc_0"

        print(f"[CACHE] vision 调用次数={calls['n']} (期望 1); "
              f"缓存条目数={len(idx)}; 二次描述一致={desc1 == desc2}")
    finally:
        if os.path.exists(cache_path):
            try:
                os.unlink(cache_path)
            except OSError:
                pass
        import shutil
        try:
            shutil.rmtree(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
