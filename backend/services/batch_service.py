"""
批次生命周期服务（D12 批次持久化 + O6 相对路径）。

存储模型（PHASE3 规划 §4.4）：
- 批次 = ``backend/data/batches/<batch_id>/batch.json`` 一条记录；
  视频文件只存路径引用、不复制（D11）；分析结果独立存于 analysis_cache（不随批次删除）。
- 删除批次只删 ``batches/<id>/`` 目录（batch.json 与中间产物），**绝不动原始素材文件**。

相对路径基准（O6，换机/换盘不炸）：
- 经现有上传通道进入的素材落在 ``TEMP_DIR/uploads/`` → rel_path 记为
  ``"$TEMP/<相对TEMP_DIR路径>"``（令牌在加载时按当前机器 TEMP_DIR 解析，换机仍有效）；
- Electron 本地直选素材（不入库，D11）→ 批次维护 ``path_base``（批次内所有
  本地素材的公共父目录），rel_path 存相对该基准的路径；跨盘无公共根时
  退化为绝对路径（resolve 时 ``os.path.isabs`` 直通，功能不受影响）。
- ``resolve_path()`` 是唯一的还原入口，下游一律经它取绝对路径。

线程安全：单 RLock 保护内存对象；每次写操作原子落盘（tmp + os.replace，
与 scene_cache / analysis_cache 同款模式）并自动刷新 ``updated_at``。
"""
from __future__ import annotations

import os
import json
import math
import shutil
import logging
import threading
from datetime import datetime
from pathlib import Path

try:
    from config import BASE_DIR, TEMP_DIR
except ModuleNotFoundError:
    # 允许 `python services/batch_service.py` 直接运行自测（生产由 backend/ 启动，无此分支）
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from config import BASE_DIR, TEMP_DIR

from services.analysis_cache import fast_file_hash, analysis_cache

logger = logging.getLogger(__name__)

# ─── 常量 ──────────────────────────────────────────────────

# 批次根目录（可环境变量覆盖，便于测试/便携部署）
BATCHES_ROOT: Path = Path(os.environ.get("MASHUP_BATCHES_DIR", str(BASE_DIR / "data" / "batches")))

# TEMP 令牌前缀：rel_path 以 "$TEMP/" 开头表示相对 TEMP_DIR（换机可解析，O6）
TEMP_TOKEN: str = "$TEMP/"

# 批次阶段机（D-流程：上传分析→预修→脚本→分配→审改→导出）
STAGES: tuple = ("upload", "prescan", "scripts", "allocation", "review", "export")

# 成片卡片状态（阶段 4 卡片队列用）
CLIP_STATUSES: tuple = ("待生成", "生成中", "待确认", "待重新分配", "已确认", "导出中", "已完成", "失败")

# 全局设置默认值（D7：音色/语速/字幕样式全局统一设一次；D13：BGM 池默认全库轮替）
DEFAULT_GLOBAL_SETTINGS: dict = {
    "voice": "",
    "speed": 1.0,
    "tts_provider": "qwen",
    "subtitle_style": {},
    "bgm_pool": "all",
    "target_duration": 30.0,  # 每条成片目标时长（秒），estimate 的输入之一
}

# O2 预估：素材无分析数据时的平均场景时长假设（秒）
_DEFAULT_AVG_SCENE_LEN: float = 3.0


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _gen_batch_id() -> str:
    """批次 ID：时间戳 + 短随机（可读且碰撞可忽略）。"""
    import uuid
    return datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:4]


def _new_batch(name: str, settings: dict | None = None) -> dict:
    now = _now()
    return {
        "id": _gen_batch_id(),
        "name": name or "未命名批次",
        "created_at": now,
        "updated_at": now,
        "stage": "upload",
        "materials": [],
        "scripts": [],
        "global_settings": {**DEFAULT_GLOBAL_SETTINGS, **(settings or {})},
        "clips": [],
        "allocation_report": None,
        "export_queue": [],
        # 本地素材公共基准目录（O6；TEMP 素材不走此字段，用 $TEMP 令牌）
        "path_base": "",
    }


# ─── 路径编码/解析（O6）────────────────────────────────────

def encode_path(abs_path: str, path_base: str = "") -> str:
    """绝对路径 → 批次相对路径。TEMP 内用 $TEMP 令牌，否则相对 path_base。"""
    abs_path = os.path.normpath(abs_path)
    temp_root = os.path.normpath(str(TEMP_DIR))
    try:
        common = os.path.commonpath([abs_path, temp_root])
    except ValueError:
        common = ""
    if common == temp_root:
        return TEMP_TOKEN + os.path.relpath(abs_path, temp_root).replace("\\", "/")
    if path_base:
        try:
            return os.path.relpath(abs_path, path_base).replace("\\", "/")
        except ValueError:
            pass  # 跨盘：退化为绝对路径
    return abs_path


def resolve_path(batch: dict, rel_path: str) -> str:
    """批次相对路径 → 当前机器绝对路径（唯一还原入口）。"""
    if rel_path.startswith(TEMP_TOKEN):
        return str(Path(TEMP_DIR) / rel_path[len(TEMP_TOKEN):])
    if os.path.isabs(rel_path):
        return rel_path
    return os.path.normpath(os.path.join(batch.get("path_base") or "", rel_path))


# ─── 批次服务 ─────────────────────────────────────────────

class BatchService:
    """批次 CRUD + 原子持久化 + 断点恢复。"""

    def __init__(self, root: str | Path | None = None) -> None:
        self.root = Path(root) if root else BATCHES_ROOT
        self.root.mkdir(parents=True, exist_ok=True)
        self._batches: dict[str, dict] = {}  # id → 内存批次对象
        self._lock = threading.RLock()
        self._scan()

    # ── 内部：落盘 / 扫描 ──────────────────────────────────

    def _batch_dir(self, batch_id: str) -> Path:
        return self.root / batch_id

    def _batch_file(self, batch_id: str) -> Path:
        return self._batch_dir(batch_id) / "batch.json"

    def _save(self, batch: dict) -> None:
        """原子落盘单个批次（tmp + os.replace）。调用前须已更新 updated_at。"""
        d = self._batch_dir(batch["id"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "batch.json.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(batch, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self._batch_file(batch["id"]))

    def _scan(self) -> None:
        """启动时扫描批次根目录，全部载入内存（批次 JSON 量小，全量驻留可接受）。"""
        if not self.root.is_dir():
            return
        for child in sorted(self.root.iterdir()):
            bf = child / "batch.json"
            if not child.is_dir() or not bf.exists():
                continue
            try:
                with open(bf, "r", encoding="utf-8") as f:
                    batch = json.load(f)
                self._batches[batch["id"]] = self._normalize(batch)
            except Exception as e:
                logger.warning(f"[BATCH] 批次载入失败（跳过）: {bf}: {e}")

    @staticmethod
    def _normalize(batch: dict) -> dict:
        """断点恢复时容忍旧版/缺字段：以新模板兜底合并。"""
        tpl = _new_batch(batch.get("name", ""))
        tpl.update({k: v for k, v in batch.items() if k in tpl})
        tpl["global_settings"] = {**DEFAULT_GLOBAL_SETTINGS, **batch.get("global_settings", {})}
        # F5 自恢复：崩溃/强退后后台任务内存态丢失，素材可能永久卡在 analyzing，
        # 而 analyze 只重跑 pending/failed —— 导致这些素材再也不会被分析。
        # 启动时统一把 analyzing 重置为 pending，使其可被下一轮分析拾取。
        for m in tpl.get("materials", []):
            if m.get("analysis_status") == "analyzing":
                m["analysis_status"] = "pending"
                m["analysis_error"] = None
        return tpl

    # ── CRUD ───────────────────────────────────────────────

    def create_batch(self, name: str, settings: dict | None = None) -> dict:
        with self._lock:
            batch = _new_batch(name, settings)
            self._batches[batch["id"]] = batch
            self._save(batch)
            logger.info(f"[BATCH] 创建批次 {batch['id']} ({batch['name']})")
            return batch

    def get_batch(self, batch_id: str) -> dict | None:
        """取批次（内存优先）。不触发磁盘重读；需要刷新用 load_batch。"""
        with self._lock:
            return self._batches.get(batch_id)

    def load_batch(self, batch_id: str) -> dict | None:
        """断点恢复：从磁盘全量重载；素材文件缺失时标记 missing=True 而不崩。"""
        with self._lock:
            bf = self._batch_file(batch_id)
            if not bf.exists():
                return None
            with open(bf, "r", encoding="utf-8") as f:
                batch = self._normalize(json.load(f))
            for m in batch.get("materials", []):
                m["missing"] = not os.path.exists(resolve_path(batch, m["rel_path"]))
                if m["missing"]:
                    logger.warning(f"[BATCH] 素材缺失: {m['rel_path']} (批次 {batch_id})")
            self._batches[batch_id] = batch
            return batch

    def list_batches(self) -> list[dict]:
        """历史列表摘要，按 updated_at 倒序。"""
        with self._lock:
            out = []
            for b in self._batches.values():
                clips = b.get("clips", [])
                out.append({
                    "id": b["id"],
                    "name": b["name"],
                    "stage": b["stage"],
                    "materials_count": len(b.get("materials", [])),
                    "clips_total": len(clips),
                    "clips_done": sum(1 for c in clips if c.get("status") == "已完成"),
                    "updated_at": b["updated_at"],
                })
            out.sort(key=lambda x: x["updated_at"], reverse=True)
            return out

    def delete_batches(self, ids: list[str]) -> dict:
        """勾选删除：只删 batches/<id>/ 目录（batch.json 与中间产物）。

        素材文件只存路径引用（D11），此处绝不触碰原始素材（§4.4）。
        """
        deleted, not_found = [], []
        with self._lock:
            for bid in ids:
                if bid not in self._batches and not self._batch_file(bid).exists():
                    not_found.append(bid)
                    continue
                self._batches.pop(bid, None)
                shutil.rmtree(self._batch_dir(bid), ignore_errors=True)
                deleted.append(bid)
                logger.info(f"[BATCH] 删除批次 {bid}（原始素材文件不动）")
        return {"deleted": deleted, "not_found": not_found}

    # ── 写操作（统一：改内存 → 刷新 updated_at → 原子落盘）──

    def touch_stage(self, batch_id: str, stage: str) -> dict | None:
        """推进/回退阶段机。stage 必须是 STAGES 之一。"""
        if stage not in STAGES:
            raise ValueError(f"非法阶段: {stage}（可选 {STAGES}）")
        with self._lock:
            batch = self._batches.get(batch_id)
            if batch is None:
                return None
            batch["stage"] = stage
            batch["updated_at"] = _now()
            self._save(batch)
            return batch

    def set_field(self, batch_id: str, key: str, value) -> dict | None:
        """通用字段写（scripts / global_settings / clips / allocation_report / export_queue）。

        global_settings 为合并写（保留未提交的键）；其余整体替换。
        """
        allowed = {"scripts", "global_settings", "clips", "allocation_report", "export_queue", "name"}
        if key not in allowed:
            raise ValueError(f"不允许直接写的字段: {key}")
        with self._lock:
            batch = self._batches.get(batch_id)
            if batch is None:
                return None
            if key == "global_settings":
                batch["global_settings"] = {**batch.get("global_settings", {}), **(value or {})}
            else:
                batch[key] = value
            batch["updated_at"] = _now()
            self._save(batch)
            return batch

    # ── 素材登记 ───────────────────────────────────────────

    def add_materials(self, batch_id: str, paths: list[str]) -> dict:
        """登记素材（O4 快哈希去重：同哈希不占素材池名额）。

        Returns:
            {"added": [material...], "skipped": [{"path", "reason"}...]}
        """
        added, skipped = [], []
        with self._lock:
            batch = self._batches.get(batch_id)
            if batch is None:
                raise KeyError(f"批次不存在: {batch_id}")
            # 记录已存在素材的当前分析状态，用于区分「已分析跳过」与「重复未分析」
            existing_status = {m["file_hash"]: m.get("analysis_status") for m in batch["materials"]}

            for p in paths:
                abs_p = os.path.normpath(str(p))
                if not os.path.exists(abs_p):
                    skipped.append({"path": str(p), "reason": "文件不存在"})
                    continue
                try:
                    h = fast_file_hash(abs_p)
                except Exception as e:
                    skipped.append({"path": str(p), "reason": f"快哈希失败: {e}"})
                    continue
                if h in existing_status:
                    # F3：按状态给出不同提示，避免「同文件已在批次中」让人误以为分析失败
                    if existing_status[h] in ("done", "cached"):
                        reason = "已分析，跳过（哈希去重）"
                    else:
                        reason = "同文件已在批次中（尚未分析，哈希去重）"
                    skipped.append({"path": str(p), "reason": reason})
                    continue

                # 本地素材（非 TEMP）需维护批次公共基准目录后重编码
                rel = encode_path(abs_p, batch.get("path_base", ""))
                if not rel.startswith(TEMP_TOKEN) and not rel.startswith("$"):
                    if os.path.isabs(rel):
                        self._rebase_local_materials(batch, os.path.dirname(abs_p))
                        rel = encode_path(abs_p, batch["path_base"])

                # 缓存命中：状态标 cached，并顺手回填时长（否则 estimate 会把 0 秒素材跳过，
                # 全缓存命中时建议片数退化为 0）
                cached = analysis_cache.get_cached_analysis(h, count_hit=False)
                material = {
                    "file_hash": h,
                    "filename": os.path.basename(abs_p),
                    "rel_path": rel,
                    "size": os.path.getsize(abs_p),
                    "duration": float((cached or {}).get("duration") or 0.0),  # 分析/预修后回填
                    "usable_in": 0.0,      # 预修建议/确认入点
                    "usable_out": 0.0,     # 预修建议/确认出点（0 = 未设置，取 duration）
                    "analysis_status": "cached" if cached else "pending",
                    "prescan_status": "pending",  # pending / done / confirmed / failed
                    "missing": False,
                }
                batch["materials"].append(material)
                existing_status[h] = material["analysis_status"]
                added.append(material)

            if added:
                batch["updated_at"] = _now()
                self._save(batch)
        return {"added": added, "skipped": skipped}

    def _rebase_local_materials(self, batch: dict, new_dir: str) -> None:
        """把新的本地素材目录并入批次公共基准，并按新基准重编码已有 rel_path。"""
        try:
            if batch.get("path_base"):
                batch["path_base"] = os.path.commonpath([batch["path_base"], new_dir])
            else:
                batch["path_base"] = new_dir
        except ValueError:
            # 跨盘无公共根：保持原基准，该素材将退化为绝对路径存储
            return
        for m in batch["materials"]:
            if m["rel_path"].startswith(TEMP_TOKEN):
                continue
            abs_old = resolve_path(batch, m["rel_path"]) if not os.path.isabs(m["rel_path"]) else m["rel_path"]
            m["rel_path"] = encode_path(abs_old, batch["path_base"])

    def update_material(self, batch_id: str, file_hash: str, **patch) -> dict | None:
        """按哈希更新素材条目（白名单字段）。返回更新后的素材。"""
        allowed = {"duration", "usable_in", "usable_out", "analysis_status",
                   "prescan_status", "missing", "analysis_error"}
        with self._lock:
            batch = self._batches.get(batch_id)
            if batch is None:
                return None
            for m in batch["materials"]:
                if m["file_hash"] == file_hash:
                    for k, v in patch.items():
                        if k in allowed:
                            m[k] = v
                    batch["updated_at"] = _now()
                    self._save(batch)
                    return m
            return None

    # ── O2 可行性预估（简化版）─────────────────────────────

    def estimate_capacity(self, batch_id: str) -> dict | None:
        """估算建议最大不重复成片数：Σ可用窗口段数 ÷ 每条成片段数。

        简化启发式（注释说明：S3 批次求解器接入后替换为精确版）：
        - 可用窗口 = (usable_out 或 duration) - usable_in；
        - 可用段数：有分析数据时按落在窗口内的场景数计，无分析按 窗口÷平均场景长 估；
        - 每条成片段数 = ceil(target_duration ÷ 平均场景长)，可被
          global_settings["segments_per_clip"] 显式覆盖。
        """
        with self._lock:
            batch = self._batches.get(batch_id)
            if batch is None:
                return None
            gs = batch.get("global_settings", {})
            target = float(gs.get("target_duration") or 30.0)

            total_window = 0.0
            total_segments = 0
            scene_lens: list[float] = []
            ready = 0
            for m in batch.get("materials", []):
                if m.get("missing"):
                    continue
                dur = float(m.get("duration") or 0.0)
                if dur <= 0:
                    continue
                ready += 1
                win_in = float(m.get("usable_in") or 0.0)
                win_out = float(m.get("usable_out") or 0.0) or dur
                window = max(0.0, win_out - win_in)
                total_window += window

                payload = analysis_cache.get_cached_analysis(m["file_hash"], count_hit=False)
                scenes = (payload or {}).get("scenes") or []
                if scenes:
                    # 场景与可用窗口有交集即计入；同时累计场景时长样本
                    n = 0
                    for s in scenes:
                        scene_lens.append(float(s.get("duration") or 0.0))
                        if float(s["end"]) > win_in and float(s["start"]) < win_out:
                            n += 1
                    total_segments += n
                else:
                    total_segments += max(1, int(window / _DEFAULT_AVG_SCENE_LEN))

            avg_scene = (sum(scene_lens) / len(scene_lens)) if scene_lens else _DEFAULT_AVG_SCENE_LEN
            if avg_scene <= 0:
                avg_scene = _DEFAULT_AVG_SCENE_LEN
            segments_per_clip = int(gs.get("segments_per_clip") or max(1, math.ceil(target / avg_scene)))
            suggested = total_segments // segments_per_clip if segments_per_clip else 0

            return {
                "suggested_max_clips": int(suggested),
                "materials_ready": ready,
                "total_usable_seconds": round(total_window, 1),
                "assumptions": {
                    "avg_scene_len": round(avg_scene, 2),
                    "segments_per_clip": segments_per_clip,
                    "note": "简化估算：S3 批次分配求解器接入后替换为精确预跑版（O2）",
                },
                # 已分配过则附带实际分配统计（真实重复率/相似度，替代启发式预估）
                "post_allocation": self._post_allocation_stats(batch),
            }

    @staticmethod
    def _post_allocation_stats(batch: dict) -> dict | None:
        """若批次已跑过分配，返回实际分配统计；否则 None。"""
        rep = batch.get("allocation_report")
        if not rep:
            return None
        return {
            "clips": len(batch.get("clips", [])),
            "materials_used": rep.get("materials_used"),
            "usage_variance": rep.get("usage_variance"),
            "repeats_count": len(rep.get("repeats", [])),
            "jaccard_over_threshold_pairs": len(rep.get("jaccard_pairs_over_threshold", [])),
            "forced_overlap_count": rep.get("forced_overlap_count"),
        }


# 模块级单例
batch_service = BatchService()


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    import tempfile
    import time

    print("=== batch_service 自测 ===")
    tmp_dir = tempfile.mkdtemp(prefix="bs_test_")

    # 独立批次根 + 独立分析缓存，不污染真实数据
    svc = BatchService(os.path.join(tmp_dir, "batches"))
    from services.analysis_cache import AnalysisCache
    orig_cache = globals()["analysis_cache"]
    globals()["analysis_cache"] = AnalysisCache(os.path.join(tmp_dir, "acache"))
    try:
        # ── 1. 创建批次 ──
        b = svc.create_batch("测试批次A", {"voice": "zh_female_xiaohe_uranus_bigtts", "speed": 1.1})
        bid = b["id"]
        assert b["stage"] == "upload" and b["global_settings"]["speed"] == 1.1
        assert (Path(svc.root) / bid / "batch.json").exists(), "batch.json 应已落盘"
        print(f"[OK] 创建批次: {bid}")

        # ── 2. 登记素材：1 个 TEMP 上传 + 1 个本地直选 + 1 个同内容副本（去重）──
        up_dir = Path(TEMP_DIR) / "uploads"
        up_dir.mkdir(parents=True, exist_ok=True)
        f_up = up_dir / "_bs_test_up.mp4"
        f_up.write_bytes(os.urandom(32 * 1024))
        local_dir = Path(tmp_dir) / "footage"
        local_dir.mkdir()
        f_local = local_dir / "clip01.mp4"
        f_local.write_bytes(os.urandom(32 * 1024))
        f_dup = local_dir / "clip01_copy.mp4"
        f_dup.write_bytes(f_up.read_bytes())  # 与上传件同内容

        res = svc.add_materials(bid, [str(f_up), str(f_local), str(f_dup), str(local_dir / "nope.mp4")])
        assert len(res["added"]) == 2 and len(res["skipped"]) == 2, res
        m_up, m_local = res["added"]
        assert m_up["rel_path"].startswith(TEMP_TOKEN), f"TEMP 素材应走令牌: {m_up['rel_path']}"
        assert not os.path.isabs(m_local["rel_path"]), f"本地素材应相对化: {m_local['rel_path']}"
        assert "去重" in res["skipped"][0]["reason"]
        print(f"[OK] 登记 2 条素材（TEMP 令牌 + 本地相对路径），同哈希去重生效: "
              f"{m_up['rel_path']} / {m_local['rel_path']}")

        # ── 3. 相对路径解析往返 + 缺失误标容忍 ──
        b2 = svc.get_batch(bid)
        assert os.path.exists(resolve_path(b2, m_up["rel_path"]))
        assert os.path.exists(resolve_path(b2, m_local["rel_path"]))
        f_local.unlink()  # 删掉本地素材模拟换机/误删
        b3 = svc.load_batch(bid)
        miss = {m["filename"]: m["missing"] for m in b3["materials"]}
        assert miss["clip01.mp4"] is True and miss["_bs_test_up.mp4"] is False, miss
        print(f"[OK] 路径解析往返 + 断点恢复缺失误标: {miss}")

        # ── 4. 脚本 / 设置 / 阶段机 ──
        svc.set_field(bid, "scripts", [
            {"id": "s1", "text": "第一段口播文案", "copies": 2, "status": "ready"},
            {"id": "s2", "text": "第二段口播文案", "copies": 1, "status": "ready"},
        ])
        svc.set_field(bid, "global_settings", {"speed": 1.2})  # 合并写
        b4 = svc.get_batch(bid)
        assert len(b4["scripts"]) == 2 and b4["scripts"][0]["copies"] == 2
        assert b4["global_settings"]["speed"] == 1.2 and b4["global_settings"]["voice"], "合并写应保留旧键"
        svc.touch_stage(bid, "prescan")
        assert svc.get_batch(bid)["stage"] == "prescan"
        try:
            svc.touch_stage(bid, "bogus")
            raise AssertionError("非法阶段应抛错")
        except ValueError:
            pass
        print("[OK] 脚本/设置（合并写）/阶段机校验")

        # ── 5. estimate（无分析数据 → 默认场景长启发式）──
        f_local.write_bytes(os.urandom(32 * 1024))  # 恢复素材并重载，清除 missing 标记
        svc.load_batch(bid)
        b4 = svc.get_batch(bid)
        for m in b4["materials"]:
            svc.update_material(bid, m["file_hash"], duration=12.0, usable_in=1.0, usable_out=11.0)
        est = svc.estimate_capacity(bid)
        # 2 素材 × 10s 窗口 ÷ 3s/段 ≈ 6 段；target 30s ÷ 3s = 10 段/片 → 0 片（如预期反映素材不足）
        assert est["materials_ready"] == 2 and est["total_usable_seconds"] == 20.0
        assert est["suggested_max_clips"] == (6 // 10), est
        print(f"[OK] O2 预估: {est['suggested_max_clips']} 片（假设 {est['assumptions']}）")

        # ── 6. updated_at 自动刷新 + list 排序 ──
        old_updated = svc.get_batch(bid)["updated_at"]
        time.sleep(1.1)
        b5 = svc.create_batch("测试批次B")
        lst = svc.list_batches()
        assert lst[0]["id"] == b5["id"], "最新更新的批次应排最前"
        assert svc.get_batch(bid)["updated_at"] >= old_updated
        assert {x["id"] for x in lst} == {bid, b5["id"]}
        print(f"[OK] list 摘要按 updated_at 倒序: {[x['name'] for x in lst]}")

        # ── 7. 删除批次：只删目录，不动原始素材 ──
        up_bytes_before = f_up.read_bytes()
        out = svc.delete_batches([bid, "ghost_id"])
        assert out["deleted"] == [bid] and out["not_found"] == ["ghost_id"]
        assert not (Path(svc.root) / bid).exists(), "批次目录应已删除"
        assert f_up.read_bytes() == up_bytes_before, "原始素材文件绝不能被动"
        assert svc.get_batch(bid) is None
        print("[OK] 勾选删除：只删 batch.json 目录，原始素材完好")

        f_up.unlink()  # 清理测试上传件
    finally:
        globals()["analysis_cache"] = orig_cache

    print("=== 全部自测通过 ===")
