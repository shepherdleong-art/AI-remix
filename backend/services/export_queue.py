"""
串行导出队列（D10：串行后台队列 + 全部完成通知；O5 命名规则）。

设计要点：
- **全局唯一串行 worker**：FIFO，一次只渲染一条（D10：不做并行导出，收益低且卡预览）；
- worker 由路由层在事件循环内首次 enqueue 时拉起；任务空转即退出，下次 enqueue 重启；
- 渲染逻辑与队列解耦：``render_fn(job) -> output_path`` 由路由层注入
  （生产 = 复用 composite 端点；测试 = 假渲染桩），队列本身不 import 渲染栈；
- 暂停/取消：pause 后 worker 空转等待；cancel 对待命任务直接生效，
  对渲染中任务打标记（ffmpeg 子进程不便强杀，渲染完成后丢弃产物）；
- 断线容忍：已完成任务不重复渲染（调用方 enqueue 前过滤；
  批次 clips 里的 output_path/status 由路由层持久化）。

命名（O5）：``批次名_序号_标题变体.mp4``，序号 = 入队顺序（全局递增），
标题经文件名安全清洗；输出目录 ``backend/data/output/<批次名_日期>/``。
"""
from __future__ import annotations

import os
import re
import asyncio
import logging
import threading
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# 文件名安全清洗（O5：Windows 禁字符剔除 + 空白转下划线）
_ILLEGAL_PAT = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def filename_safe(text: str, max_len: int = 40) -> str:
    clean = _ILLEGAL_PAT.sub("", text or "").strip()
    clean = re.sub(r"\s+", "_", clean)
    return (clean or "untitled")[:max_len]


class ExportQueue:
    """全局唯一串行导出队列（线程安全的状态读写 + asyncio worker）。"""

    def __init__(self) -> None:
        self._jobs: list[dict] = []       # FIFO；元素见 _make_job
        # RLock：retry() 等方法持锁时还会调 _ensure_worker（需可重入）
        self._lock = threading.RLock()
        self._paused = False
        self._worker: asyncio.Task | None = None
        self._seq = 0                     # 全局递增序号（O5 文件名序号 = 入队顺序）
        # 渲染函数由路由层注入：async (job) -> output_path；None 时任务直接失败
        self.render_fn = None
        # worker 拉起器（生产 asyncio.create_task；测试可替换为独立线程事件循环）
        self.spawner = asyncio.create_task

    # ── 任务构造 ───────────────────────────────────────────

    def _make_job(self, batch_id: str, clip_id: str, title: str, extra: dict | None = None) -> dict:
        self._seq += 1
        job = {
            "batch_id": batch_id,
            "clip_id": clip_id,
            "seq": self._seq,
            "title": title,
            "status": "pending",   # pending / rendering / done / failed / cancelled
            "progress": 0.0,
            "error": None,
            "output_path": None,
        }
        # 额外业务字段（如 width/height）原样带进 job，render_fn 可取用
        if extra:
            job.update({k: v for k, v in extra.items() if k not in job})
        return job

    # ── 公共 API ───────────────────────────────────────────

    def enqueue(self, batch_id: str, clips: list[dict]) -> dict:
        """入队若干成片。clips: [{"clip_id", "title"}]。

        已在队列（pending/rendering）的同 clip_id 任务会跳过，返回 skipped 列表。
        """
        added, skipped = [], []
        with self._lock:
            active = {j["clip_id"] for j in self._jobs if j["status"] in ("pending", "rendering")}
            for c in clips:
                cid = c["clip_id"]
                if cid in active:
                    skipped.append(cid)
                    continue
                extra = {k: v for k, v in c.items() if k not in ("clip_id", "title")}
                job = self._make_job(batch_id, cid, c.get("title", ""), extra)
                self._jobs.append(job)
                added.append(job)
                active.add(cid)
        if added:
            self._ensure_worker()
        return {"enqueued": len(added), "skipped": skipped}

    def pause(self, flag: bool) -> None:
        """暂停/恢复（渲染中的任务跑完当前条后停）。"""
        with self._lock:
            self._paused = bool(flag)
        if not flag:
            self._ensure_worker()

    def cancel(self, clip_id: str) -> bool:
        """取消：待命直接取消；渲染中打标记（完成后丢弃产物，见 _worker）。"""
        with self._lock:
            for j in self._jobs:
                if j["clip_id"] != clip_id:
                    continue
                if j["status"] == "pending":
                    j["status"] = "cancelled"
                    return True
                if j["status"] == "rendering":
                    j["status"] = "cancelling"   # worker 完成后识别并丢弃
                    return True
            return False

    def retry(self, clip_id: str) -> bool:
        """失败/已取消的任务重新入队（置于队尾）。"""
        with self._lock:
            for j in self._jobs:
                if j["clip_id"] == clip_id and j["status"] in ("failed", "cancelled"):
                    j["status"] = "pending"
                    j["progress"] = 0.0
                    j["error"] = None
                    self._ensure_worker()
                    return True
            return False

    def status(self) -> dict:
        """状态快照（前端轮询；all_done=True 时弹通知，D10）。"""
        with self._lock:
            jobs = [dict(j) for j in self._jobs]
        active = [j for j in jobs if j["status"] in ("pending", "rendering", "cancelling")]
        return {
            "jobs": jobs,
            "paused": self._paused,
            "running": bool(active),
            "done_count": sum(1 for j in jobs if j["status"] == "done"),
            "failed_count": sum(1 for j in jobs if j["status"] == "failed"),
            "total": len(jobs),
            # 有任务且无活动任务 = 全部结束（完成/失败/取消都算终态）
            "all_done": bool(jobs) and not active,
        }

    def clear_finished(self) -> int:
        """清掉终态任务记录（保持快照精简）；返回清除数。"""
        with self._lock:
            before = len(self._jobs)
            self._jobs = [j for j in self._jobs if j["status"] in ("pending", "rendering", "cancelling")]
            return before - len(self._jobs)

    # ── worker ─────────────────────────────────────────────

    def _ensure_worker(self) -> None:
        """worker 不在运行且队列有待命任务时拉起。"""
        try:
            if self._worker is not None and not self._worker.done():
                return
            with self._lock:
                has_pending = any(j["status"] == "pending" for j in self._jobs)
            if has_pending or self._paused:
                self._worker = self.spawner(self._run())
        except RuntimeError:
            # 无运行中事件循环（不应出现在路由上下文；防御）
            logger.warning("[EXPORT] 无事件循环，worker 未启动")

    def _next_job(self) -> dict | None:
        with self._lock:
            if self._paused:
                return None
            for j in self._jobs:
                if j["status"] == "pending":
                    j["status"] = "rendering"
                    return j
            return None

    async def _run(self) -> None:
        """串行主循环：一次一条，全部跑完即退出（下次 enqueue 重启）。"""
        while True:
            if self._paused:
                await asyncio.sleep(0.5)
                continue
            job = self._next_job()
            if job is None:
                # 无待命任务：若处于暂停则等待，否则退出
                if self._paused:
                    await asyncio.sleep(0.5)
                    continue
                return
            logger.info(f"[EXPORT] 开始导出 {job['clip_id']} (seq={job['seq']})")
            try:
                if self.render_fn is None:
                    raise RuntimeError("render_fn 未注入")
                out = await self.render_fn(job)
                if job["status"] == "cancelling":
                    # 渲染中被取消：丢弃产物，不计完成
                    try:
                        if out and os.path.exists(out):
                            os.unlink(out)
                    except OSError:
                        pass
                    job["status"] = "cancelled"
                    job["error"] = "已取消（渲染中取消，产物已丢弃）"
                else:
                    job["status"] = "done"
                    job["progress"] = 1.0
                    job["output_path"] = out
                    logger.info(f"[EXPORT] 完成 {job['clip_id']} -> {out}")
            except Exception as e:
                job["status"] = "failed" if job["status"] != "cancelling" else "cancelled"
                job["error"] = str(e)[:300]
                logger.warning(f"[EXPORT] 失败 {job['clip_id']}: {e}")


# 模块级单例（全局唯一串行队列）
export_queue = ExportQueue()


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    import tempfile
    import time
    import threading as _th

    print("=== export_queue 自测 ===")
    tmp_dir = tempfile.mkdtemp(prefix="eq_test_")

    # 假渲染：写个小文件当产物，记录调用顺序
    render_order: list[str] = []

    async def fake_render(job: dict) -> str:
        await asyncio.sleep(0.05)
        render_order.append(job["clip_id"])
        # 模拟 c2 渲染失败
        if job["clip_id"] == "c2":
            raise RuntimeError("模拟渲染失败")
        out = os.path.join(tmp_dir, f"out_{job['clip_id']}.mp4")
        with open(out, "wb") as f:
            f.write(b"fake")
        return out

    q = ExportQueue()
    q.render_fn = fake_render
    # 测试环境无常驻事件循环：worker 用独立线程 + 独立事件循环；
    # 句柄的 done() 反映线程真实存活（retry 后需能重启 worker）
    def thread_spawner(coro):
        t = _th.Thread(target=lambda: asyncio.run(coro), daemon=True)
        t.start()

        class _Handle:
            def done(self):
                return not t.is_alive()
        return _Handle()

    q.spawner = thread_spawner

    # 等待队列清空的辅助
    def wait_all_done(timeout=10.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            st = q.status()
            if st["all_done"]:
                return st
            time.sleep(0.05)
        raise AssertionError(f"超时未完成: {q.status()}")

    # ── 1. FIFO 顺序 + 失败不阻塞 + all_done ──
    q.enqueue("b1", [{"clip_id": "c1", "title": "标题一"},
                     {"clip_id": "c2", "title": "标题二"},
                     {"clip_id": "c3", "title": "标题三"}])
    st = wait_all_done()
    assert render_order == ["c1", "c2", "c3"], f"应严格 FIFO: {render_order}"
    assert st["done_count"] == 2 and st["failed_count"] == 1 and st["all_done"]
    by_id = {j["clip_id"]: j for j in st["jobs"]}
    assert by_id["c1"]["progress"] == 1.0 and by_id["c1"]["output_path"]
    assert "模拟渲染失败" in by_id["c2"]["error"]
    print(f"[OK] FIFO 顺序 {render_order}，2 完成 1 失败，all_done=True")

    # ── 2. 失败重试（改为成功后）──
    async def ok_render(job):
        await asyncio.sleep(0.02)
        out = os.path.join(tmp_dir, f"out_{job['clip_id']}_retry.mp4")
        with open(out, "wb") as f:
            f.write(b"fake2")
        return out
    q.render_fn = ok_render
    assert q.retry("c2") is True
    st = wait_all_done()
    assert {j["clip_id"]: j["status"] for j in st["jobs"]}["c2"] == "done"
    print("[OK] 失败任务 retry 后完成")

    # ── 3. 暂停：enqueue 后立刻 pause，任务不应开始 ──
    q2 = ExportQueue()
    q2.render_fn = ok_render
    started: list[str] = []
    async def slow_render(job):
        started.append(job["clip_id"])
        await asyncio.sleep(0.05)
        return os.path.join(tmp_dir, f"out_{job['clip_id']}.mp4")
    q2.render_fn = slow_render
    q2.spawner = thread_spawner
    q2.pause(True)
    q2.enqueue("b2", [{"clip_id": "x1", "title": "t"}])
    time.sleep(0.2)
    assert started == [] and q2.status()["paused"], "暂停时不应启动任务"
    q2.pause(False)
    t0 = time.time()
    while time.time() - t0 < 5 and not q2.status()["all_done"]:
        time.sleep(0.05)
    assert started == ["x1"], "恢复后应继续"
    print("[OK] pause 暂停 → 恢复后继续")

    # ── 4. 取消待命任务 + 重复入队去重 ──
    q3 = ExportQueue()
    q3.render_fn = slow_render
    q3.spawner = thread_spawner
    q3.pause(True)
    q3.enqueue("b3", [{"clip_id": "y1", "title": "t"}, {"clip_id": "y2", "title": "t"}])
    dup = q3.enqueue("b3", [{"clip_id": "y1", "title": "t"}])
    assert dup["enqueued"] == 0 and dup["skipped"] == ["y1"], "重复入队应跳过"
    assert q3.cancel("y2") is True
    q3.pause(False)
    t0 = time.time()
    while time.time() - t0 < 5 and not q3.status()["all_done"]:
        time.sleep(0.05)
    st3 = q3.status()
    m = {j["clip_id"]: j["status"] for j in st3["jobs"]}
    assert m == {"y1": "done", "y2": "cancelled"}, m
    print(f"[OK] 待命取消 + 入队去重: {m}")

    # ── 5. 文件名清洗 ──
    assert filename_safe('批 次/A:B*C?"<>| 名称') == "批_次ABC_名称"
    assert filename_safe("") == "untitled"
    print("[OK] O5 文件名安全清洗")

    print("=== 全部自测通过 ===")
