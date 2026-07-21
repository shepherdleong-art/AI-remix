"""
素材级分析结果缓存（D4 + O4 快哈希）。

设计要点：
- 快哈希 ``fast_file_hash``：文件大小 + 首 1MB + 尾 1MB 内容做 md5，
  不全量读盘（O4 决策：100MB 级文件也是毫秒级），同文件永不重复分析（D4）。
- 存储布局（见 PHASE3 规划 §4.4）：``backend/data/analysis_cache/``
  - 每个 hash 一个 JSON 文件 ``<hash>.json`` —— 完整分析结果 payload；
  - 一个 ``index.json`` —— 元数据索引（命中次数、最后命中时间、素材时长等），
    加载进内存 dict，查询 O(1)。
- 线程安全：单 ``threading.RLock`` 保护索引读写；落盘用「临时文件 + os.replace」
  原子替换（与 scene_cache.py 同款模式）。
- 缓存永久保留、不随批次删除（D4 / §4.4）；素材内容变化 → 哈希变化 → 自动换 key。
"""
from __future__ import annotations

import os
import json
import hashlib
import logging
import threading
from datetime import datetime
from pathlib import Path

try:
    from config import BASE_DIR
except ModuleNotFoundError:
    # 允许 `python services/analysis_cache.py` 直接运行自测（生产由 backend/ 启动，无此分支）
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from config import BASE_DIR

logger = logging.getLogger(__name__)

# ─── 常量 ──────────────────────────────────────────────────

# 快哈希采样窗口：首/尾各读 1MB
_SAMPLE_BYTES: int = 1 * 1024 * 1024

# 缓存根目录：backend/data/analysis_cache/（不随批次删除，跨项目复用）
CACHE_DIR: Path = BASE_DIR / "data" / "analysis_cache"

# 元数据索引文件名（命中次数 / 最后命中时间 / 素材时长等）
_INDEX_NAME: str = "index.json"


# ─── 快哈希（O4）──────────────────────────────────────────

def fast_file_hash(path: str) -> str:
    """计算文件快哈希：``md5(文件大小 + 首1MB + 尾1MB)``。

    不全量读盘：无论文件多大，只读最多 2MB，100MB 文件也是毫秒级（O4）。
    文件小于等于 2MB 时实际等于全量哈希（首块已覆盖整个文件）。

    Args:
        path: 素材文件绝对路径。

    Returns:
        32 位 md5 十六进制字符串。

    Raises:
        FileNotFoundError: 文件不存在。
    """
    if not os.path.exists(path):
        raise FileNotFoundError(f"素材文件不存在: {path}")

    size = os.path.getsize(path)
    h = hashlib.md5()
    # 把文件大小混入哈希：采样相同但大小不同的文件不会撞 key
    h.update(str(size).encode("utf-8"))

    with open(path, "rb") as f:
        # 首 1MB
        head = f.read(_SAMPLE_BYTES)
        h.update(head)
        # 尾 1MB（文件大于 1MB 时才需要 seek；小文件首块即全部内容）
        if size > _SAMPLE_BYTES:
            f.seek(max(0, size - _SAMPLE_BYTES))
            h.update(f.read(_SAMPLE_BYTES))

    return h.hexdigest()


# ─── 缓存存取 ─────────────────────────────────────────────

class AnalysisCache:
    """素材级分析结果缓存：hash → payload JSON，附元数据索引。"""

    def __init__(self, cache_dir: str | Path | None = None) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir else CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._index_path = self.cache_dir / _INDEX_NAME
        self._index: dict | None = None  # 懒加载进内存，查询 O(1)
        self._lock = threading.RLock()

    # ── 公共 API ───────────────────────────────────────────

    def has_cached(self, file_hash: str) -> bool:
        """是否存在缓存条目（只读判断，不累加命中数）。供批次登记等"仅探测"场景用。"""
        with self._lock:
            idx = self._load()
            if file_hash not in idx:
                return False
            return os.path.exists(self._payload_path(file_hash))

    def get_cached_analysis(self, file_hash: str, count_hit: bool = True) -> dict | None:
        """按哈希查询缓存。命中返回 payload dict，未命中返回 None。

        命中时顺带更新元数据（命中次数 +1、最后命中时间），持久化到 index.json；
        传 ``count_hit=False`` 则只读不记命中（供可行性预估等内部查询用）。
        """
        with self._lock:
            idx = self._load()
            meta = idx.get(file_hash)
            if meta is None:
                return None

            payload_file = self._payload_path(file_hash)
            if not os.path.exists(payload_file):
                # 索引在但 payload 文件丢失（手动删过）→ 清掉索引，视为未命中
                logger.warning(f"[ANALYSIS_CACHE] payload 缺失，剔除索引: {file_hash}")
                idx.pop(file_hash, None)
                self._save_index(idx)
                return None

            try:
                with open(payload_file, "r", encoding="utf-8") as f:
                    payload = json.load(f)
            except Exception as e:
                logger.warning(f"[ANALYSIS_CACHE] payload 读取失败 ({e}): {file_hash}")
                return None

            # 更新命中元数据（count_hit=False 时纯只读）
            if count_hit:
                meta["hits"] = int(meta.get("hits", 0)) + 1
                meta["last_hit"] = datetime.now().isoformat(timespec="seconds")
                self._save_index(idx)
            return payload

    def save_analysis(self, file_hash: str, payload: dict, meta: dict | None = None) -> None:
        """写入缓存：payload 落盘 ``<hash>.json``，元数据并入 index.json。

        Args:
            file_hash: ``fast_file_hash`` 的结果。
            payload:   完整分析结果（scenes / descriptions / frames 等，需可 JSON 序列化）。
            meta:      可选附加元数据（如 duration、source_path），合并进索引条目。
        """
        with self._lock:
            # 1) payload 原子落盘
            payload_file = self._payload_path(file_hash)
            tmp = str(payload_file) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp, payload_file)

            # 2) 更新索引（保留历史命中数）
            idx = self._load()
            old = idx.get(file_hash, {})
            entry = {
                "hits": int(old.get("hits", 0)),
                "last_hit": old.get("last_hit"),
                "saved_at": datetime.now().isoformat(timespec="seconds"),
            }
            if meta:
                entry.update(meta)
            idx[file_hash] = entry
            self._save_index(idx)

    def stats(self) -> dict:
        """缓存统计：``{"entries": 条目数, "total_hits": 总命中数}``。"""
        with self._lock:
            idx = self._load()
            return {
                "entries": len(idx),
                "total_hits": sum(int(m.get("hits", 0)) for m in idx.values()),
            }

    # ── 内部：路径 / 索引读写 ──────────────────────────────

    def _payload_path(self, file_hash: str) -> Path:
        # hash 是 md5 十六进制，天然是安全文件名
        return self.cache_dir / f"{file_hash}.json"

    def _load(self) -> dict:
        if self._index is None:
            if os.path.exists(self._index_path):
                try:
                    with open(self._index_path, "r", encoding="utf-8") as f:
                        self._index = json.load(f)
                except Exception as e:  # 索引损坏则重建（payload 文件仍在，可重新登记）
                    logger.warning(f"[ANALYSIS_CACHE] index 加载失败 ({e})，重置索引")
                    self._index = {}
            else:
                self._index = {}
        return self._index

    def _save_index(self, idx: dict) -> None:
        tmp = str(self._index_path) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self._index_path)


# 模块级单例（全进程共享一份索引，与 scene_cache 的模式一致）
analysis_cache = AnalysisCache()

# 便捷函数：直接挂在模块上，调用方无需关心单例
get_cached_analysis = analysis_cache.get_cached_analysis
save_analysis = analysis_cache.save_analysis
stats = analysis_cache.stats


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    import tempfile

    print("=== analysis_cache 自测 ===")
    tmp_dir = tempfile.mkdtemp(prefix="ac_test_")

    # ── 1. 快哈希稳定性 ──
    # 1a) 小文件（<1MB，首块即全量）
    small = os.path.join(tmp_dir, "small.bin")
    with open(small, "wb") as f:
        f.write(b"hello-mashup" * 1000)
    h1 = fast_file_hash(small)
    h2 = fast_file_hash(small)
    assert h1 == h2, "同一文件两次哈希必须一致"
    print(f"[OK] 小文件哈希稳定: {h1[:12]}...")

    # 1b) 大文件（>2MB，验证首尾采样路径），并验证耗时毫秒级
    big = os.path.join(tmp_dir, "big.bin")
    with open(big, "wb") as f:
        f.write(os.urandom(_SAMPLE_BYTES))       # 首 1MB
        f.write(b"\x00" * (3 * _SAMPLE_BYTES))   # 中段 3MB（不参与采样）
        f.write(os.urandom(_SAMPLE_BYTES))       # 尾 1MB
    import time as _t
    t0 = _t.perf_counter()
    hb1 = fast_file_hash(big)
    cost_ms = (_t.perf_counter() - t0) * 1000
    assert hb1 == fast_file_hash(big), "大文件两次哈希必须一致"
    assert cost_ms < 500, f"快哈希应毫秒级完成，实际 {cost_ms:.1f}ms"
    print(f"[OK] 5MB 文件哈希稳定，耗时 {cost_ms:.1f}ms")

    # 1c) 大小不同 → 哈希不同；尾部改动 → 哈希不同（采样能感知）
    big2 = os.path.join(tmp_dir, "big2.bin")
    with open(big, "rb") as fsrc, open(big2, "wb") as fdst:
        fdst.write(fsrc.read())
    with open(big2, "r+b") as f:
        f.seek(-1, os.SEEK_END)
        f.write(b"X")  # 改尾字节
    assert fast_file_hash(big) != fast_file_hash(big2), "尾部改动必须改变哈希"
    print("[OK] 尾部改动 → 哈希变化")

    # ── 2. 缓存存取（用独立临时目录，不污染真实缓存） ──
    cache = AnalysisCache(os.path.join(tmp_dir, "cache"))
    fake_hash = "a" * 32
    assert cache.get_cached_analysis(fake_hash) is None, "空缓存必须未命中"

    payload = {
        "scenes": [{"index": 0, "start": 0.0, "end": 3.2, "duration": 3.2}],
        "descriptions": ["一段测试画面"],
        "frames": ["scene_000.jpg"],
    }
    cache.save_analysis(fake_hash, payload, meta={"duration": 3.2, "source_path": small})
    got = cache.get_cached_analysis(fake_hash)
    assert got == payload, "存取往返必须一致"
    print("[OK] 存取往返一致（payload 文件 + index.json）")

    # ── 3. 命中计数与 stats ──
    cache.get_cached_analysis(fake_hash)
    cache.get_cached_analysis(fake_hash)
    s = cache.stats()
    assert s["entries"] == 1 and s["total_hits"] == 3, f"stats 异常: {s}"
    idx = json.loads(open(cache._index_path, encoding="utf-8").read())
    assert idx[fake_hash]["hits"] == 3 and idx[fake_hash]["duration"] == 3.2
    print(f"[OK] 命中计数正确: {s}")

    # ── 4. payload 文件丢失 → 索引自愈 ──
    os.remove(str(cache._payload_path(fake_hash)))
    assert cache.get_cached_analysis(fake_hash) is None, "payload 丢失应视为未命中"
    assert cache.stats()["entries"] == 0, "索引应自愈剔除"
    print("[OK] payload 缺失 → 未命中 + 索引自愈")

    print("=== 全部自测通过 ===")
