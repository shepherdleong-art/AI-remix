"""
场景描述缓存：按 ``md5(video_path + mtime + frame_index + prompt)`` 查/写。

- 落盘 JSON 索引：``{TEMP_DIR}/ai_scene_cache.json``（与 generate-tts 的 md5 落盘风格一致）。
- key 内含素材 ``mtime`` → 素材被修改（mtime 变化）即 key 变化、自动失效；
  frame_index / prompt 变化同理。
- 线程安全：写入使用文件锁 + 原子替换（临时文件 os.replace）。
- 纯标准库实现，零新依赖。
"""
from __future__ import annotations

import os
import json
import hashlib
import threading
import logging

from config import TEMP_DIR

logger = logging.getLogger(__name__)


class SceneCache:
    """场景描述缓存（md5 落盘 JSON 索引）。"""

    def __init__(self, cache_path: str | None = None) -> None:
        self.cache_path = cache_path or os.path.join(str(TEMP_DIR), "ai_scene_cache.json")
        self._index: dict | None = None
        self._lock = threading.Lock()

    # ────────────────────────────────────────────────────────
    # 公共 API
    # ────────────────────────────────────────────────────────
    def get(
        self,
        video_path: str,
        mtime: float,
        frame_index: int,
        prompt: str,
    ) -> str | None:
        """命中返回缓存描述，未命中返回 None。"""
        idx = self._load()
        key = self._key(video_path, mtime, frame_index, prompt)
        return idx.get(key)

    def put(
        self,
        video_path: str,
        mtime: float,
        frame_index: int,
        prompt: str,
        desc: str,
    ) -> None:
        """写入缓存（原子替换）。"""
        with self._lock:
            idx = self._load()
            key = self._key(video_path, mtime, frame_index, prompt)
            idx[key] = desc
            self._save(idx)

    # ────────────────────────────────────────────────────────
    # 内部：key / 读写
    # ────────────────────────────────────────────────────────
    def _key(self, video_path: str, mtime: float, frame_index: int, prompt: str) -> str:
        raw = f"{video_path}|{float(mtime):.3f}|{int(frame_index)}|{prompt}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def _load(self) -> dict:
        if self._index is None:
            if os.path.exists(self.cache_path):
                try:
                    with open(self.cache_path, "r", encoding="utf-8") as f:
                        self._index = json.load(f)
                except Exception as e:  # pragma: no cover - 索引损坏则重建
                    logger.warning(f"[SCENE_CACHE] load failed ({e}), reset index")
                    self._index = {}
            else:
                self._index = {}
        return self._index

    def _save(self, idx: dict) -> None:
        tmp = self.cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.cache_path)


# 模块级单例（与 ai_editing.py 共享同一索引文件）
scene_cache = SceneCache()
