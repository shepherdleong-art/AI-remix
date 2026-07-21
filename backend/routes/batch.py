"""
批量模式 API 路由（D3/D12/O1/O2，挂 ``/api/batch`` 前缀）。

骨架说明：
- 所有批次数据读写走 ``services.batch_service``（内存对象 + 原子落盘），路由只做
  参数校验与调度；
- 分析/预修为耗时操作 → 后台 asyncio 任务执行，进度快照存内存字典，
  前端轮询 ``GET .../analyze/status`` / ``GET .../prescan/status`` 获取（简单可靠，
  比 SSE 更适合 Electron 本地场景；后续要换 SSE 也只动路由层）；
- 上传文件本身复用现有 ``/api/materials/upload`` 通道（落 TEMP_DIR/uploads），
  这里的 ``materials/add`` 只做"批次登记"（快哈希 + 去重 + 相对路径编码）。
"""
from __future__ import annotations

import os
import sys
import asyncio
import logging
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse

try:
    from services.batch_service import batch_service, resolve_path, STAGES, BASE_DIR, CLIP_STATUSES
except ModuleNotFoundError:
    # 允许 `python routes/batch.py` 直接运行自测（生产由 backend/ 启动，无此分支）
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from services.batch_service import batch_service, resolve_path, STAGES, BASE_DIR, CLIP_STATUSES
from services.concurrent_analyzer import (
    analyze_materials_concurrently,
    create_control,
    get_control,
    clear_control,
)
from services.material_prescan import suggest_usable_range
from services.export_queue import export_queue, filename_safe

logger = logging.getLogger(__name__)

# 导出产物根目录：backend/data/output/<批次名_日期>/（D10/O5；测试可替换）
_OUTPUT_ROOT: Path = Path(BASE_DIR) / "data" / "output"

router = APIRouter(prefix="/api/batch", tags=["batch"])


def _ok(data=None, msg="success"):
    return {"code": 0, "message": msg, "data": data}


def _err(code: int, msg: str):
    return {"code": code, "message": msg, "data": None}


# 批次相关错误码（40x 系列，与 config.ErrorCode 风格一致、互不冲突）
_ERR_NOT_FOUND = 40401       # 批次不存在
_ERR_BAD_REQUEST = 40402     # 参数缺失/非法
_ERR_TASK_RUNNING = 40403    # 同类任务已在运行中


# ─── 后台任务进度快照（内存字典，轮询暴露）──────────────────

def _new_progress(total: int) -> dict:
    return {
        "running": True,
        "done": 0,
        "total": total,
        "current": "",
        "last_status": "",
        "finished_at": None,
        "error": None,
        "state": "idle",   # idle | running | paused | stopping（暂停/停止控制用）
    }


# {batch_id: {"analyze": progress, "prescan": progress}}
_PROGRESS: dict[str, dict[str, dict]] = {}

# 后台任务强引用集（防止 fire-and-forget 任务被 GC 提前回收）
_BG_TASKS: set = set()


def _spawn(coro):
    """派生后台 asyncio 任务（生产：uvicorn 事件循环内 create_task）。

    独立成函数是为方便测试替换：TestClient 会在请求结束时取消请求作用域内
    create_task 的子任务，自测需换成「独立线程 + 独立事件循环」的派生方式。
    """
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


def _get_progress(batch_id: str, kind: str) -> dict:
    p = _PROGRESS.get(batch_id, {}).get(kind)
    return p or {"running": False, "done": 0, "total": 0, "current": "",
                 "last_status": "", "finished_at": None, "error": None, "state": "idle"}


# ─── 批次 CRUD ─────────────────────────────────────────────

@router.post("/create")
async def create_batch(req: dict):
    """创建批次。入参：name，可选 settings（并入 global_settings）。"""
    name = (req.get("name") or "").strip()
    if not name:
        return _err(_ERR_BAD_REQUEST, "缺少 name 参数")
    batch = batch_service.create_batch(name, req.get("settings") or None)
    return _ok(batch)


@router.get("/list")
async def list_batches():
    """历史列表摘要（updated_at 倒序）。"""
    return _ok(batch_service.list_batches())


@router.delete("/delete")
async def delete_batches(req: dict):
    """勾选删除。body: {"ids": [...]}。只删批次目录，绝不动原始素材。"""
    ids = req.get("ids") or []
    if not ids:
        return _err(_ERR_BAD_REQUEST, "缺少 ids 参数")
    return _ok(batch_service.delete_batches(ids))


# ─── 素材登记 / 分析 / 预修 ─────────────────────────────────

@router.post("/{batch_id}/materials/add")
async def add_materials(batch_id: str, req: dict):
    """批次素材登记：接收已上传/本地直选的路径列表，算快哈希、查缓存、去重登记。"""
    if batch_service.get_batch(batch_id) is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    paths = req.get("paths") or []
    if not paths:
        return _err(_ERR_BAD_REQUEST, "缺少 paths 参数")
    try:
        result = batch_service.add_materials(batch_id, paths)
    except KeyError as e:
        return _err(_ERR_NOT_FOUND, str(e))
    return _ok(result, f"登记 {len(result['added'])} 条，跳过 {len(result['skipped'])} 条")


@router.post("/{batch_id}/materials/update")
async def update_material(batch_id: str, req: dict):
    """更新单条素材（预修台手工确认可用区间等）。入参：file_hash + 可选字段。"""
    file_hash = req.get("file_hash") or ""
    if not file_hash:
        return _err(_ERR_BAD_REQUEST, "缺少 file_hash 参数")
    patch = {}
    for k in ("usable_in", "usable_out", "prescan_status", "analysis_status"):
        if k in req:
            patch[k] = req[k]
    # 手工改了可用区间即视为已确认（O1 一键确认/微调都走这里）
    if ("usable_in" in patch or "usable_out" in patch) and "prescan_status" not in patch:
        patch["prescan_status"] = "confirmed"
    m = batch_service.update_material(batch_id, file_hash, **patch)
    if m is None:
        return _err(_ERR_NOT_FOUND, "批次或素材不存在")
    return _ok(m)


@router.post("/{batch_id}/analyze")
async def analyze_batch(batch_id: str, req: dict):
    """批次全量并发分析（D3）：后台任务，进度走 GET analyze/status。

    入参：api_key（必填）、model（可选）、max_workers（可选，默认 5 / 环境变量）、
    file_hashes（可选，只分析指定哈希的素材；缺省=全部 pending/failed）。
    分析过程受 pause/resume/stop 控制（软暂停/软放弃，零卡死风险）。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    api_key = req.get("api_key") or ""
    if not api_key:
        return _err(_ERR_BAD_REQUEST, "缺少 api_key 参数")

    if _get_progress(batch_id, "analyze")["running"]:
        return _err(_ERR_TASK_RUNNING, "该批次已有分析任务在运行")

    # 绝对路径 → 素材条目 映射（O6：经 resolve_path 还原）
    targets = {}
    for m in batch["materials"]:
        if m.get("missing") or m.get("analysis_status") not in ("pending", "failed"):
            continue
        abs_p = resolve_path(batch, m["rel_path"])
        if os.path.exists(abs_p):
            targets[abs_p] = m
    # 勾选过滤：只分析指定 file_hash 的素材（前端「开始分析」透传勾选集合）
    req_hashes = req.get("file_hashes")
    if isinstance(req_hashes, list) and req_hashes:
        want = set(req_hashes)
        targets = {p: m for p, m in targets.items() if m["file_hash"] in want}
    if not targets:
        return _ok({"total": 0}, "没有待分析的素材")

    for m in targets.values():
        batch_service.update_material(batch_id, m["file_hash"], analysis_status="analyzing")

    progress = _new_progress(len(targets))
    progress["state"] = "running"
    _PROGRESS.setdefault(batch_id, {})["analyze"] = progress
    model = req.get("model") or ""
    max_workers = req.get("max_workers")
    control = create_control(batch_id)

    async def _run() -> None:
        def _cb(done, total, current_path, status):
            # asyncio 单线程内回调，直接更新快照字典即可
            progress.update({"done": done, "total": total,
                             "current": current_path, "last_status": status})

        try:
            out = await analyze_materials_concurrently(
                list(targets.keys()), api_key, model,
                progress_cb=_cb, max_workers=max_workers, control=control,
            )
            # 回填素材状态与时长
            for abs_p, payload in out["results"].items():
                m = targets[abs_p]
                batch_service.update_material(
                    batch_id, m["file_hash"],
                    analysis_status="done",
                    duration=payload.get("duration") or 0.0,
                )
            for abs_p, err in out["failed"].items():
                m = targets[abs_p]
                batch_service.update_material(
                    batch_id, m["file_hash"],
                    analysis_status="failed", analysis_error=str(err)[:200],
                )
            # 停止：被放弃的素材回退 pending（可重跑），不保留进度
            for abs_p in out.get("stopped", []):
                m = targets.get(abs_p)
                if m:
                    batch_service.update_material(batch_id, m["file_hash"], analysis_status="pending")
            # 阶段机：仅「全部完成（无停止）」才自动从 upload 推进到 prescan
            cur = batch_service.get_batch(batch_id)
            stopped = bool(out.get("stopped"))
            if cur and not stopped and cur["stage"] == "upload":
                batch_service.touch_stage(batch_id, "prescan")
            progress["error"] = None if not out["failed"] else f"{len(out['failed'])} 条分析失败"
        except Exception as e:
            logger.exception(f"[BATCH] 批次分析任务异常: {batch_id}: {e}")
            progress["error"] = str(e)[:300]
        finally:
            progress["running"] = False
            progress["state"] = "idle"
            progress["finished_at"] = datetime.now().isoformat(timespec="seconds")
            clear_control(batch_id)  # 防泄漏：跨批次/重跑时状态错乱

    _spawn(_run())
    return _ok({"total": len(targets)}, f"已启动 {len(targets)} 条素材的并发分析")


@router.get("/{batch_id}/analyze/status")
async def analyze_status(batch_id: str):
    """分析进度快照（轮询用）。"""
    return _ok(_get_progress(batch_id, "analyze"))


@router.post("/{batch_id}/analyze/pause")
async def analyze_pause(batch_id: str):
    """软暂停：停止派发新任务，进行中跑完；排队任务让出槽并轻量轮询等待恢复（不占并发许可）。"""
    if batch_service.get_batch(batch_id) is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    prog = _get_progress(batch_id, "analyze")
    ctl = get_control(batch_id)
    if ctl is None or not prog["running"]:
        return _err(_ERR_BAD_REQUEST, "当前没有正在运行的分析任务")
    ctl.pause()
    prog["state"] = "paused"
    return _ok({"state": "paused"}, "已暂停（进行中的任务将跑完后停止派发）")


@router.post("/{batch_id}/analyze/resume")
async def analyze_resume(batch_id: str):
    """继续：从暂停处恢复派发新任务。"""
    if batch_service.get_batch(batch_id) is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    prog = _get_progress(batch_id, "analyze")
    ctl = get_control(batch_id)
    if ctl is None or not prog["running"]:
        return _err(_ERR_BAD_REQUEST, "当前没有正在运行的分析任务")
    ctl.resume()
    prog["state"] = "running"
    return _ok({"state": "running"}, "已继续")


@router.post("/{batch_id}/analyze/stop")
async def analyze_stop(batch_id: str):
    """软放弃：进行中跑完，剩余回退 pending（不保留进度，可重跑）；不强制掐断请求。"""
    if batch_service.get_batch(batch_id) is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    prog = _get_progress(batch_id, "analyze")
    ctl = get_control(batch_id)
    if ctl is None or not prog["running"]:
        return _err(_ERR_BAD_REQUEST, "当前没有正在运行的分析任务")
    ctl.stop()  # 唤醒等待中的暂停任务，使其检测到 stopped 后退出
    prog["state"] = "stopping"
    return _ok({"state": "stopping"}, "已停止（进行中任务跑完后，剩余标回待分析）")


@router.post("/{batch_id}/prescan")
async def prescan_batch(batch_id: str, req: dict):
    """素材预修辅助（O1）：对每条素材跑黑帧/静音检测，建议可用区间。

    后台任务，进度走 GET prescan/status。用户已手工确认（confirmed）的素材不覆盖。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    if _get_progress(batch_id, "prescan")["running"]:
        return _err(_ERR_TASK_RUNNING, "该批次已有预修任务在运行")

    targets = {}
    for m in batch["materials"]:
        if m.get("missing") or m.get("prescan_status") == "confirmed":
            continue
        abs_p = resolve_path(batch, m["rel_path"])
        if os.path.exists(abs_p):
            targets[abs_p] = m
    if not targets:
        return _ok({"total": 0}, "没有待预修的素材")

    progress = _new_progress(len(targets))
    _PROGRESS.setdefault(batch_id, {})["prescan"] = progress

    async def _run() -> None:
        done = 0
        try:
            for abs_p, m in targets.items():
                progress["current"] = abs_p
                try:
                    # ffmpeg 检测是同步阻塞子进程，扔到线程里跑避免卡事件循环
                    info = await asyncio.to_thread(suggest_usable_range, abs_p)
                    batch_service.update_material(
                        batch_id, m["file_hash"],
                        usable_in=info["suggested_in"],
                        usable_out=info["suggested_out"],
                        duration=float(m.get("duration") or 0.0) or info["duration"],
                        prescan_status="done",
                    )
                    progress["last_status"] = "done"
                except Exception as e:
                    logger.warning(f"[BATCH] 预修失败（单条不影响整体）: {abs_p}: {e}")
                    batch_service.update_material(
                        batch_id, m["file_hash"], prescan_status="failed",
                    )
                    progress["last_status"] = "failed"
                done += 1
                progress["done"] = done
        except Exception as e:
            logger.exception(f"[BATCH] 批次预修任务异常: {batch_id}: {e}")
            progress["error"] = str(e)[:300]
        finally:
            progress["running"] = False
            progress["finished_at"] = datetime.now().isoformat(timespec="seconds")

    _spawn(_run())
    return _ok({"total": len(targets)}, f"已启动 {len(targets)} 条素材的预修检测")


@router.get("/{batch_id}/prescan/status")
async def prescan_status(batch_id: str):
    """预修进度快照（轮询用）。"""
    return _ok(_get_progress(batch_id, "prescan"))


# ─── 脚本 / 全局设置 ────────────────────────────────────────

@router.post("/{batch_id}/scripts")
async def set_scripts(batch_id: str, req: dict):
    """批量设置脚本数组：[{id?, text, copies?, status?}]，自动补 id/默认值。"""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    scripts = req.get("scripts")
    if not isinstance(scripts, list):
        return _err(_ERR_BAD_REQUEST, "scripts 必须是数组")
    normalized = []
    for i, s in enumerate(scripts):
        text = (s.get("text") or "").strip()
        if not text:
            return _err(_ERR_BAD_REQUEST, f"第 {i + 1} 条脚本缺少 text")
        normalized.append({
            "id": s.get("id") or f"s{i + 1}",
            "text": text,
            "copies": max(1, int(s.get("copies") or 1)),  # 裂变数（D1），默认 1
            "status": s.get("status") or "ready",
        })
    batch_service.set_field(batch_id, "scripts", normalized)
    # 阶段机：脚本录入后推进到 scripts（仍在 upload/prescan 阶段才自动推）
    cur = batch_service.get_batch(batch_id)
    if cur and cur["stage"] in ("upload", "prescan"):
        batch_service.touch_stage(batch_id, "scripts")
    return _ok({"count": len(normalized)}, f"已保存 {len(normalized)} 条脚本")


@router.post("/{batch_id}/settings")
async def set_settings(batch_id: str, req: dict):
    """全局设置（D7 音色/语速/字幕样式统一设一次；D13 BGM 池）。合并写。"""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    settings = {k: v for k, v in req.items() if k in (
        "voice", "speed", "tts_provider", "subtitle_style",
        "bgm_pool", "target_duration", "segments_per_clip",
    )}
    if not settings:
        return _err(_ERR_BAD_REQUEST, "没有可识别的设置字段")
    batch_service.set_field(batch_id, "global_settings", settings)
    return _ok(batch_service.get_batch(batch_id)["global_settings"])


# ─── O2 可行性预估 ─────────────────────────────────────────

@router.get("/{batch_id}/estimate")
async def estimate(batch_id: str):
    """建议最大不重复成片数（启发式 + 已分配则附实际重复率统计）。"""
    est = batch_service.estimate_capacity(batch_id)
    if est is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    return _ok(est)


# ─── 批次分配（S3 联合分配求解器）──────────────────────────

def _collect_batch_materials(batch: dict) -> tuple[list[dict], list[str]]:
    """从批次素材 + analysis_cache 组装分配器输入。

    Returns:
        (materials, problems): materials 为可分配素材（含窗口内场景与描述），
        problems 为被剔除素材的原因说明（未分析/缺失/无有效窗口）。
    """
    from services.analysis_cache import analysis_cache
    materials, problems = [], []
    for m in batch.get("materials", []):
        if m.get("missing"):
            problems.append(f"{m['filename']}: 文件缺失")
            continue
        payload = analysis_cache.get_cached_analysis(m["file_hash"], count_hit=False)
        if not payload:
            problems.append(f"{m['filename']}: 未完成分析")
            continue
        scenes = []
        descs = payload.get("descriptions") or []
        for si, sc in enumerate(payload.get("scenes") or []):
            scenes.append({
                "start": sc["start"], "end": sc["end"],
                "duration": sc.get("duration", sc["end"] - sc["start"]),
                "description": descs[si] if si < len(descs) else "",
            })
        materials.append({
            "file_hash": m["file_hash"],
            "rel_path": m["rel_path"],
            "filename": m["filename"],
            "duration": m.get("duration") or payload.get("duration") or 0.0,
            "usable_in": m.get("usable_in") or 0.0,
            "usable_out": m.get("usable_out") or 0.0,
            "scenes": scenes,
        })
    return materials, problems


def _clips_to_batch_cards(allocated: list[dict], report: dict) -> list[dict]:
    """把分配器输出转成批次 clips 卡片结构（D5/D6：待确认 + 标黄 flags）。"""
    # 超阈值片对 → 每片卡片的 similarity_flags
    flags: dict[str, list] = {}
    for p in report.get("jaccard_pairs_over_threshold", []):
        flags.setdefault(p["clip_a"], []).append(
            {"other_clip": p["clip_b"], "similarity": p["similarity"]})
        flags.setdefault(p["clip_b"], []).append(
            {"other_clip": p["clip_a"], "similarity": p["similarity"]})
    cards = []
    for c in allocated:
        cards.append({
            "id": c["clip_id"],
            "script_id": c.get("script_id", ""),
            "status": "待确认",
            "segments": [{
                "video_rel_path": s["video_rel_path"],
                "file_hash": s["file_hash"],
                "scene_index": s["scene_index"],
                "in": s["in"], "out": s["out"], "duration": s["duration"],
                "score": s["score"],
            } for s in c["segments"]],
            "trim_overrides": None,
            "subtitle_overrides": None,
            "cover": None,          # D8 封面差异化（S4 实现）
            "bgm_name": None,       # D13 BGM 轮替（导出阶段实现）
            "output_path": None,
            "similarity_flags": flags.get(c["clip_id"], []),
            "feasible": c.get("feasible", True),
            "backoff_segments": c.get("backoff_segments", []),
            "total_duration": c.get("total_duration"),
        })
    return cards


@router.post("/{batch_id}/allocate")
async def allocate(batch_id: str, req: dict):
    """批次联合分配（S3）。

    入参：clips: [{script_id, seg_durations: [...], segment_texts?: [...]}]
    （每片 TTS 槽长需调用方先跑 split-tts 获得）；可选 jaccard_threshold。
    **clips 缺省时自动从批次脚本的 TTS 结果构建**（scripts × copies，S4 串联：
    /tts 跑完后无需再手工传槽长）。
    分配器是 CPU 计算（秒级），放线程执行避免阻塞事件循环。
    分配完成后自动做 BGM 批次轮替（D13）。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    clip_specs = req.get("clips")
    if not clip_specs:
        # 自动构建：脚本 × copies，槽长取自 scripts[i].tts（需先跑 /tts）
        clip_specs = []
        for s in batch.get("scripts", []):
            tts = s.get("tts") or {}
            if tts.get("status") != "done":
                continue
            texts = [seg.get("text", "") for seg in tts.get("segments") or []]
            for _ in range(max(1, int(s.get("copies") or 1))):
                clip_specs.append({
                    "script_id": s["id"],
                    "seg_durations": tts["seg_durations"],
                    "segment_texts": texts,
                })
        if not clip_specs:
            return _err(_ERR_BAD_REQUEST,
                        "缺少 clips 参数，且批次脚本均未完成 TTS（先调 /tts 生成槽长）")

    materials, problems = _collect_batch_materials(batch)
    if not materials:
        return _err(_ERR_BAD_REQUEST,
                    "没有可分配的素材（需先完成分析）。" + "; ".join(problems[:3]))

    allocator_input = []
    for i, cs in enumerate(clip_specs):
        seg_durs = cs.get("seg_durations") or []
        if not seg_durs:
            return _err(_ERR_BAD_REQUEST, f"第 {i + 1} 片缺少 seg_durations")
        allocator_input.append({
            "clip_id": cs.get("clip_id") or f"c{i + 1}",
            "script_id": cs.get("script_id") or "",
            "seg_durations": [float(d) for d in seg_durs],
            "segment_texts": cs.get("segment_texts") or [],
        })

    from services.batch_allocator import allocate_batch, DEFAULT_JACCARD_THRESHOLD
    jth = float(req.get("jaccard_threshold") or DEFAULT_JACCARD_THRESHOLD)
    try:
        out = await asyncio.to_thread(allocate_batch, materials, allocator_input,
                                      None, jth)
    except Exception as e:
        logger.exception(f"[BATCH] 分配失败: {batch_id}: {e}")
        return _err(50001, f"分配失败: {e}")

    cards = _clips_to_batch_cards(out["clips"], out["report"])
    batch_service.set_field(batch_id, "clips", cards)
    batch_service.set_field(batch_id, "allocation_report", out["report"])
    # 分配完成 → 进入审改阶段（D5 卡片队列扫片）
    batch_service.touch_stage(batch_id, "review")
    # BGM 批次轮替（D13）：分配完成即自动分配不重复曲目
    bgm_summary = _assign_bgm(batch_id)

    rep = out["report"]
    return _ok({
        "clips": len(cards),
        "materials_used": rep["materials_used"],
        "materials_total": rep["materials_total"],
        "usage_variance": rep["usage_variance"],
        "repeats_count": len(rep["repeats"]),
        "jaccard_pairs_over_threshold": len(rep["jaccard_pairs_over_threshold"]),
        "forced_overlap_count": rep["forced_overlap_count"],
        "violations": rep["violations"],
        "skipped_materials": problems,
        "bgm": bgm_summary,
    }, f"已生成 {len(cards)} 条成片的分配方案")


@router.get("/{batch_id}/allocation-report")
async def allocation_report(batch_id: str):
    """完整分配报告（使用率分布/重复明细/相似度矩阵/BGM 占位）。"""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    rep = batch.get("allocation_report")
    if not rep:
        return _err(_ERR_BAD_REQUEST, "该批次尚未运行分配")
    return _ok(rep)


@router.post("/{batch_id}/clips/{clip_id}/reallocate")
async def reallocate(batch_id: str, clip_id: str, req: dict):
    """O3 单条重分配：改脚本后只重跑该片，其他片不动。

    入参：seg_durations（新槽长，必填）、segment_texts（可选）。
    素材使用计数由 build_report 按"其他片旧占用 + 本片新方案"整体重算。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    seg_durs = req.get("seg_durations") or []
    if not seg_durs:
        return _err(_ERR_BAD_REQUEST, "缺少 seg_durations 参数")

    clips = batch.get("clips", [])
    target = next((c for c in clips if c.get("id") == clip_id), None)
    if target is None:
        return _err(_ERR_NOT_FOUND, f"成片不存在: {clip_id}")

    materials, problems = _collect_batch_materials(batch)
    if not materials:
        return _err(_ERR_BAD_REQUEST, "没有可分配的素材。" + "; ".join(problems[:3]))

    from services.batch_allocator import reallocate_clip, build_report
    others = [c for c in clips if c.get("id") != clip_id]
    # 其他片的 segments 携带 file_hash/scene_index，供占用重建
    other_alloc = [{"clip_id": c["id"], "segments": c.get("segments", [])} for c in others]
    clip_spec = {
        "clip_id": clip_id,
        "script_id": target.get("script_id", ""),
        "seg_durations": [float(d) for d in seg_durs],
        "segment_texts": req.get("segment_texts") or [],
    }
    try:
        new_clip = await asyncio.to_thread(reallocate_clip, materials, clip_spec, other_alloc)
    except Exception as e:
        logger.exception(f"[BATCH] 单条重分配失败: {batch_id}/{clip_id}: {e}")
        return _err(50001, f"单条重分配失败: {e}")

    # 更新该片卡片 + 整体重建报告（usage/Jaccard 按最新 clips 重算）
    target["segments"] = [{
        "video_rel_path": s["video_rel_path"],
        "file_hash": s["file_hash"],
        "scene_index": s["scene_index"],
        "in": s["in"], "out": s["out"], "duration": s["duration"],
        "score": s["score"],
    } for s in new_clip["segments"]]
    target["status"] = "待确认"
    target["feasible"] = new_clip.get("feasible", True)
    target["backoff_segments"] = new_clip.get("backoff_segments", [])
    target["total_duration"] = new_clip.get("total_duration")

    alloc_for_report = [{"clip_id": c["id"], "segments": c.get("segments", [])} for c in clips]
    old_params = (batch.get("allocation_report") or {}).get("params", {})
    threshold = (batch.get("allocation_report") or {}).get("jaccard_threshold", 0.5)
    report = build_report(alloc_for_report, materials, threshold, old_params)
    report["violations"] = []
    # 重算标黄 flags
    for c in clips:
        c["similarity_flags"] = []
    for p in report["jaccard_pairs_over_threshold"]:
        for cid, oid in ((p["clip_a"], p["clip_b"]), (p["clip_b"], p["clip_a"])):
            card = next((c for c in clips if c["id"] == cid), None)
            if card is not None:
                card["similarity_flags"].append({"other_clip": oid, "similarity": p["similarity"]})

    batch_service.set_field(batch_id, "clips", clips)
    batch_service.set_field(batch_id, "allocation_report", report)
    return _ok({
        "clip_id": clip_id,
        "segments": target["segments"],
        "usage_variance": report["usage_variance"],
        "repeats_count": len(report["repeats"]),
        "jaccard_pairs_over_threshold": len(report["jaccard_pairs_over_threshold"]),
    }, f"成片 {clip_id} 已重分配，其他 {len(others)} 片未动")


# ─── S4-1. 批量 TTS 预生成（D7：全局音色/语速注入）─────────

@router.post("/{batch_id}/tts")
async def batch_tts(batch_id: str, req: dict):
    """对批次全部脚本跑 split-tts（复用现有端点内部函数，不复制逻辑）。

    同一脚本的 copies 裂变片共享一份 TTS 产物（文案相同音频必然相同，只生成一次）。
    严格串行执行（TTS 走 API，避免触发限流）；单脚本失败不阻塞其他脚本。
    入参：api_key（必填，TTS 服务商的 key）、model（可选）、force（可选，true 强制重跑已完成的）、
    analysis_api_key（可选，语义分段 LLM 的 key —— doubao 用户分析与 TTS 是两套凭证，
    缺省回退 api_key，qwen 用户一把钥匙场景行为不变）。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    api_key = req.get("api_key") or ""
    if not api_key:
        return _err(_ERR_BAD_REQUEST, "缺少 api_key 参数")
    # 语义分段走 LLM（qwen 系），TTS 可能走 doubao —— 两套凭证时分开传
    analysis_key = req.get("analysis_api_key") or api_key
    scripts = batch.get("scripts", [])
    if not scripts:
        return _err(_ERR_BAD_REQUEST, "批次尚未录入脚本")
    if _get_progress(batch_id, "tts")["running"]:
        return _err(_ERR_TASK_RUNNING, "该批次已有 TTS 任务在运行")

    force = bool(req.get("force"))
    targets = [s for s in scripts
               if force or (s.get("tts") or {}).get("status") != "done"]
    if not targets:
        return _ok({"total": 0}, "全部脚本已有 TTS 产物（force=true 可强制重跑）")

    progress = _new_progress(len(targets))
    _PROGRESS.setdefault(batch_id, {})["tts"] = progress
    model = req.get("model") or ""

    async def _run() -> None:
        done = 0
        # 延迟导入：避免模块加载时引入完整路由栈/AI 服务
        from services.ai_service import analyze_script
        from routes.ai_editing import split_tts_endpoint
        try:
            for s in targets:
                progress["current"] = s["id"]
                gs = (batch_service.get_batch(batch_id) or {}).get("global_settings", {})
                try:
                    text = s.get("text", "")
                    # 脚本报文 → 语义分段（无缓存分段时调 LLM analyze_script）
                    segments = s.get("segments")
                    if not segments:
                        segments = await analyze_script(text, analysis_key, model)
                    # 复用现有 split-tts 端点（全局音色/语速/provider 从批次设置注入，D7）
                    resp = await split_tts_endpoint({
                        "segments": segments,
                        "voice": gs.get("voice") or "Cherry",
                        "api_key": api_key,
                        "speed": float(gs.get("speed") or 1.0),
                        "provider": gs.get("tts_provider") or "qwen",
                    })
                    if resp.get("code") == 0:
                        s["tts"] = {**resp["data"], "segments": segments, "status": "done"}
                        s["status"] = "tts_done"
                        progress["last_status"] = "done"
                    else:
                        s["tts"] = {"status": "failed", "error": resp.get("message", "")[:200]}
                        progress["last_status"] = "failed"
                except Exception as e:
                    logger.warning(f"[BATCH] 脚本 {s['id']} TTS 失败（不阻塞其他脚本）: {e}")
                    s["tts"] = {"status": "failed", "error": str(e)[:200]}
                    progress["last_status"] = "failed"
                # 每个脚本完成即落盘（断点容忍：中途失败已完成的脚本不重跑）
                cur = batch_service.get_batch(batch_id)
                if cur:
                    batch_service.set_field(batch_id, "scripts", cur["scripts"])
                done += 1
                progress["done"] = done
            # O3 级联：若批次已有成片（重跑 TTS），相关片标"待重新分配"
            cur = batch_service.get_batch(batch_id)
            if cur and cur.get("clips"):
                changed = False
                done_script_ids = {s["id"] for s in targets if (s.get("tts") or {}).get("status") == "done"}
                for c in cur["clips"]:
                    if c.get("script_id") in done_script_ids:
                        c["status"] = "待重新分配"
                        changed = True
                if changed:
                    batch_service.set_field(batch_id, "clips", cur["clips"])
            # 阶段机：TTS 完成 → 进入分配阶段
            if cur and cur["stage"] == "scripts":
                batch_service.touch_stage(batch_id, "allocation")
        except Exception as e:
            logger.exception(f"[BATCH] TTS 任务异常: {batch_id}: {e}")
            progress["error"] = str(e)[:300]
        finally:
            progress["running"] = False
            progress["finished_at"] = datetime.now().isoformat(timespec="seconds")

    _spawn(_run())
    return _ok({"total": len(targets)}, f"已启动 {len(targets)} 个脚本的 TTS 预生成")


@router.get("/{batch_id}/tts/status")
async def tts_status(batch_id: str):
    """TTS 进度快照（轮询用）。"""
    return _ok(_get_progress(batch_id, "tts"))


# ─── S4-2. BGM 批次轮替（D13：批次内不重复 + 单条可换）──────

def _bgm_pool(batch: dict) -> list[dict]:
    """解析批次 BGM 池：global_settings.bgm_pool = "all"（全库）| 曲目名数组。"""
    from services.music_service import list_music
    all_tracks = list_music()
    pool = (batch.get("global_settings") or {}).get("bgm_pool", "all")
    if pool == "all" or not pool:
        return all_tracks
    names = set(pool if isinstance(pool, list) else [pool])
    return [t for t in all_tracks if t["name"] in names]


def _assign_bgm(batch_id: str) -> dict:
    """批次内不重复轮替分配 BGM；成片数 > 曲目数时从头轮替并记录撞曲明细。"""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return {"assigned": 0, "collisions": [], "tracks": 0}
    clips = batch.get("clips", [])
    tracks = _bgm_pool(batch)
    if not clips or not tracks:
        return {"assigned": 0, "collisions": [], "tracks": len(tracks)}

    used: dict[str, list] = {}
    for i, clip in enumerate(clips):
        name = tracks[i % len(tracks)]["name"]
        clip["bgm_name"] = name
        used.setdefault(name, []).append(clip["id"])
    collisions = [{"bgm_name": n, "clip_ids": ids} for n, ids in used.items() if len(ids) > 1]

    batch_service.set_field(batch_id, "clips", clips)
    # 报告同步（分配报告的 bgm 分配表）
    rep = batch.get("allocation_report") or {}
    rep["bgm_assignments"] = [
        {"clip_id": c["id"], "bgm_name": c["bgm_name"],
         "reused": any(c["id"] in col["clip_ids"] for col in collisions)}
        for c in clips
    ]
    batch_service.set_field(batch_id, "allocation_report", rep)
    return {"assigned": len(clips), "collisions": collisions, "tracks": len(tracks)}


@router.post("/{batch_id}/bgm/assign")
async def bgm_assign(batch_id: str, req: dict):
    """BGM 批次轮替分配（D13）。allocate 已自动调用，此端点供手动重分配。"""
    if batch_service.get_batch(batch_id) is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    return _ok(_assign_bgm(batch_id))


@router.post("/{batch_id}/clips/{clip_id}/bgm")
async def set_clip_bgm(batch_id: str, clip_id: str, req: dict):
    """单条成片更换 BGM（D13 保留人工换歌入口）。撞曲返回警告但不拦截。"""
    from services.music_service import resolve_music_path
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    name = (req.get("bgm_name") or "").strip()
    if not name:
        return _err(_ERR_BAD_REQUEST, "缺少 bgm_name 参数")
    if resolve_music_path(name) is None:
        return _err(_ERR_BAD_REQUEST, f"曲目不存在: {name}")
    clip = next((c for c in batch.get("clips", []) if c.get("id") == clip_id), None)
    if clip is None:
        return _err(_ERR_NOT_FOUND, f"成片不存在: {clip_id}")
    clip["bgm_name"] = name
    batch_service.set_field(batch_id, "clips", batch["clips"])
    # 撞曲检查：其他片是否也用了同一曲目
    others = [c["id"] for c in batch["clips"] if c.get("bgm_name") == name and c["id"] != clip_id]
    warning = f"注意：该曲目与成片 {', '.join(others)} 撞曲" if others else None
    return _ok({"clip_id": clip_id, "bgm_name": name, "collision_with": others, "warning": warning})


# ─── S4-3. 封面自动差异化（D8）─────────────────────────────

@router.post("/{batch_id}/covers/assign")
async def covers_assign(batch_id: str, req: dict):
    """封面自动差异化：帧不重复 + 标题变体 + 模板轮替。user_modified 不覆盖。"""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    if not batch.get("clips"):
        return _err(_ERR_BAD_REQUEST, "批次尚未分配成片")
    from services.cover_differ import assign_covers
    covers = assign_covers(batch)
    for clip in batch["clips"]:
        if clip["id"] in covers:
            clip["cover"] = covers[clip["id"]]
    batch_service.set_field(batch_id, "clips", batch["clips"])
    return _ok({"assigned": len(covers),
                "skipped_user_modified": len(batch["clips"]) - len(covers)},
               f"已分配 {len(covers)} 条封面")


@router.post("/{batch_id}/clips/{clip_id}/cover")
async def set_clip_cover(batch_id: str, clip_id: str, req: dict):
    """单条封面修改（手改后 user_modified=True，重跑 assign 不覆盖）。"""
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    clip = next((c for c in batch.get("clips", []) if c.get("id") == clip_id), None)
    if clip is None:
        return _err(_ERR_NOT_FOUND, f"成片不存在: {clip_id}")
    cover = dict(clip.get("cover") or {})
    for k in ("video_rel_path", "file_hash", "time", "title", "subtitle", "template",
              "title_color", "sub_color", "title_y", "sub_y"):
        if k in req:
            cover[k] = req[k]
    cover["user_modified"] = True
    clip["cover"] = cover
    batch_service.set_field(batch_id, "clips", batch["clips"])
    return _ok({"clip_id": clip_id, "cover": cover})


# ─── S4-4. 串行导出队列（D10/O5）───────────────────────────

def _update_clip(batch_id: str, clip_id: str, **patch) -> None:
    """按 clip_id 更新批次成片字段并落盘。"""
    batch = batch_service.get_batch(batch_id)
    if not batch:
        return
    for c in batch.get("clips", []):
        if c.get("id") == clip_id:
            c.update(patch)
            break
    batch_service.set_field(batch_id, "clips", batch["clips"])


async def _render_export_job(job: dict) -> str:
    """单条成片渲染（注入 export_queue.render_fn）。

    复用现有 composite 端点内部函数（封面/BGM/字幕全套逻辑不复制）；
    composite 内部是同步 ffmpeg 阻塞调用，放独立线程 + 独立事件循环执行，
    避免卡住主事件循环。产物按 O5 命名归档到 data/output/<批次名_日期>/。
    """
    batch_id, clip_id = job["batch_id"], job["clip_id"]
    batch = batch_service.get_batch(batch_id) or batch_service.load_batch(batch_id)
    if batch is None:
        raise RuntimeError(f"批次不存在: {batch_id}")
    clip = next((c for c in batch.get("clips", []) if c.get("id") == clip_id), None)
    if clip is None:
        raise RuntimeError(f"成片不存在: {clip_id}")
    if not clip.get("segments"):
        raise RuntimeError("成片尚未分配片段")

    _update_clip(batch_id, clip_id, status="导出中")
    try:
        script = next((s for s in batch.get("scripts", []) if s.get("id") == clip.get("script_id")), {})
        tts = script.get("tts") or {}
        texts = [seg.get("text", "") for seg in tts.get("segments") or []]
        gs = batch.get("global_settings", {})
        # 字幕覆盖（审改抽屉的逐段字幕校对，subtitle_overrides: {"0": {text?, x?, y?}}）
        sub_overrides = clip.get("subtitle_overrides") or {}
        # 全局字幕位置（D7：subtitle_style.y 百分比；composite 的位置走逐段 subtitle_x/y）
        style_y = (gs.get("subtitle_style") or {}).get("y")

        def _seg_override(i: int) -> dict:
            ov = sub_overrides.get(str(i))
            return ov if isinstance(ov, dict) else {}

        # 映射为 composite 端点的 timeline 结构（O6：rel_path 经 resolve_path 还原）
        segments = []
        for i, s in enumerate(clip["segments"]):
            ov = _seg_override(i)
            seg = {
                "video_path": resolve_path(batch, s["video_rel_path"]),
                "start_time": s["in"],
                "duration": s["duration"],
                "segment_text": ov.get("text") or (texts[i] if i < len(texts) else ""),
            }
            # 位置优先级：单段覆盖(x,y 成对) > 全局 y（x 取 50 居中）
            if ov.get("x") is not None and ov.get("y") is not None:
                seg["subtitle_x"], seg["subtitle_y"] = ov["x"], ov["y"]
            elif style_y is not None:
                seg["subtitle_x"], seg["subtitle_y"] = 50, style_y
            segments.append(seg)
        cover_req = None
        cv = clip.get("cover")
        if cv and cv.get("video_rel_path"):
            cover_req = {**cv, "video_path": resolve_path(batch, cv["video_rel_path"])}
        req = {
            "segments": segments,
            "script": script.get("text", "") or " ",   # 端点要求非空；音频已存在不会重生成
            "audio_path": tts.get("audio_path", ""),
            "output_name": f"batch_{batch_id}_{clip_id}",
            "width": int(job.get("width") or 1080),
            "height": int(job.get("height") or 1920),
            "subtitle_style": gs.get("subtitle_style") or None,
            "bgm_name": clip.get("bgm_name") or "",
            "cover": cover_req,
        }
        from routes.ai_editing import composite_endpoint
        resp = await asyncio.to_thread(lambda: asyncio.run(composite_endpoint(req)))
        if resp.get("code") != 0:
            raise RuntimeError(resp.get("message", "composite 渲染失败"))
        src = resp["data"]["output_path"]

        # O5 命名：批次名_序号_标题变体.mp4；归档到 data/output/<批次名_日期>/
        date_str = datetime.now().strftime("%Y%m%d")
        out_dir = _OUTPUT_ROOT / f"{filename_safe(batch['name'])}_{date_str}"
        out_dir.mkdir(parents=True, exist_ok=True)
        title = (cv or {}).get("title") or job.get("title") or clip_id
        fname = f"{filename_safe(batch['name'])}_{job['seq']:02d}_{filename_safe(title)}.mp4"
        dst = out_dir / fname
        shutil.move(src, dst)

        # 回写：output_path 存相对 BASE_DIR 的路径（O6 可移植）
        rel_out = os.path.relpath(str(dst), str(BASE_DIR))
        _update_clip(batch_id, clip_id, status="已完成", output_path=rel_out)
        return str(dst)
    except Exception as e:
        _update_clip(batch_id, clip_id, status="失败")
        raise e


# 渲染函数注入导出队列（模块加载即完成接线）
export_queue.render_fn = _render_export_job


@router.post("/{batch_id}/export")
async def export_batch(batch_id: str, req: dict):
    """批量导出（D10 串行队列）。

    入参：clip_ids（数组）或 "confirmed"（全部已确认成片）；可选 width/height。
    断线容忍：已完成且产物文件存在的成片自动跳过不重跑。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    sel = req.get("clip_ids")
    clips = batch.get("clips", [])
    if sel == "confirmed":
        targets = [c for c in clips if c.get("status") == "已确认"]
    elif isinstance(sel, list):
        ids = set(sel)
        targets = [c for c in clips if c.get("id") in ids]
    else:
        return _err(_ERR_BAD_REQUEST, '缺少 clip_ids 参数（数组或 "confirmed"）')
    if not targets:
        return _err(_ERR_BAD_REQUEST, "没有可导出的成片")

    # 断线容忍：已完成且产物还在的跳过
    todo, skipped_done = [], []
    for c in targets:
        out = c.get("output_path")
        if c.get("status") == "已完成" and out:
            abs_out = out if os.path.isabs(out) else str(Path(BASE_DIR) / out)
            if os.path.exists(abs_out):
                skipped_done.append(c["id"])
                continue
        todo.append(c)

    entries = [{
        "clip_id": c["id"],
        "title": ((c.get("cover") or {}).get("title") or c["id"]),
        "width": req.get("width"), "height": req.get("height"),
    } for c in todo]
    result = export_queue.enqueue(batch_id, entries)
    # 同步批次 export_queue 字段（持久化摘要，断点可见）
    batch_service.set_field(batch_id, "export_queue", {
        "enqueued_at": datetime.now().isoformat(timespec="seconds"),
        "clip_ids": [c["id"] for c in todo],
        "skipped_done": skipped_done,
    })
    return _ok({**result, "skipped_done": skipped_done},
               f"已入队 {result['enqueued']} 条（跳过已完成 {len(skipped_done)} 条）")


def _queue_snapshot(batch_id: str) -> dict:
    """导出队列快照（只保留本批次的任务）。"""
    st = export_queue.status()
    st["jobs"] = [j for j in st["jobs"] if j["batch_id"] == batch_id]
    st["total"] = len(st["jobs"])
    st["done_count"] = sum(1 for j in st["jobs"] if j["status"] == "done")
    st["failed_count"] = sum(1 for j in st["jobs"] if j["status"] == "failed")
    return st


@router.get("/{batch_id}/export/status")
async def export_status(batch_id: str):
    """导出队列快照（前端轮询；all_done=true 时弹通知，D10）。"""
    return _ok(_queue_snapshot(batch_id))


@router.post("/{batch_id}/export/pause")
async def export_pause(batch_id: str, req: dict):
    """暂停/恢复导出队列（全局唯一队列，暂停影响所有批次任务）。"""
    export_queue.pause(bool(req.get("paused", True)))
    return _ok(_queue_snapshot(batch_id), "已暂停" if req.get("paused", True) else "已恢复")


@router.post("/{batch_id}/export/cancel/{clip_id}")
async def export_cancel(batch_id: str, clip_id: str):
    """取消单条导出（待命直接取消；渲染中打标记，完成后丢弃产物）。"""
    if export_queue.cancel(clip_id):
        _update_clip(batch_id, clip_id, status="待确认")
        return _ok(_queue_snapshot(batch_id), f"已取消 {clip_id}")
    return _err(_ERR_NOT_FOUND, f"没有可取消的任务: {clip_id}")


@router.post("/{batch_id}/export/retry/{clip_id}")
async def export_retry(batch_id: str, clip_id: str):
    """失败/已取消任务重新入队。"""
    if export_queue.retry(clip_id):
        _update_clip(batch_id, clip_id, status="导出中")
        return _ok(_queue_snapshot(batch_id), f"已重新入队 {clip_id}")
    return _err(_ERR_NOT_FOUND, f"没有可重试的任务: {clip_id}")


@router.post("/{batch_id}/export/open-output")
async def export_open_output(batch_id: str):
    """在系统文件管理器中打开本批次的输出目录（D10 导出面板「打开文件夹」）。

    目录命名 data/output/<批次名_日期>/；同一批次可能跨天产生多个目录，
    打开最近修改的一个。仅服务端本机生效（Electron 本地场景）。
    """
    batch = batch_service.get_batch(batch_id) or batch_service.load_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    prefix = f"{filename_safe(batch['name'])}_"
    candidates = []
    if _OUTPUT_ROOT.is_dir():
        candidates = [d for d in _OUTPUT_ROOT.iterdir()
                      if d.is_dir() and d.name.startswith(prefix)]
    if not candidates:
        return _err(_ERR_NOT_FOUND, "输出目录不存在（尚未有导出产物）")
    target = max(candidates, key=lambda d: d.stat().st_mtime)
    try:
        if os.name == "nt":
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            import subprocess as _sp
            _sp.Popen(["open", str(target)])
        else:
            import subprocess as _sp
            _sp.Popen(["xdg-open", str(target)])
    except Exception as e:
        return _err(50001, f"打开目录失败: {e}")
    return _ok({"dir": str(target)}, f"已打开 {target.name}")


# ─── S5. 素材媒体服务 / 成片字段更新（前端批量界面配套，纯增量）───

_MEDIA_CHUNK = 512 * 1024


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    """解析单段 HTTP Range（bytes=start-end / bytes=start- / bytes=-suffix）。"""
    try:
        units, rng = header.split("=", 1)
        if units.strip().lower() != "bytes":
            return None
        first = rng.split(",", 1)[0].strip()          # 只支持单段
        start_s, _, end_s = first.partition("-")
        if start_s == "":                              # suffix: bytes=-500
            length = int(end_s)
            if length <= 0:
                return None
            return (max(0, size - length), size - 1)
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
        if start > end or start >= size:
            return None
        return (start, min(end, size - 1))
    except Exception:
        return None


def _file_stream(path: str, start: int, end: int):
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            data = f.read(min(_MEDIA_CHUNK, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


@router.get("/{batch_id}/materials/{file_hash}/media")
async def batch_material_media(
    batch_id: str, file_hash: str, request: Request,
    kind: str = "video", t: float = 1.0, w: int | None = None,
):
    """批次素材媒体服务（预修台 scrub / 上传列表缩略图用）。

    - kind=video（默认）：按批次 rel_path 还原后流式返回，支持 HTTP Range
      （206 分段），video 元素任意拖动不卡；
    - kind=thumb：302 复用现有 /api/ai-editing/thumb（服务端帧缓存），
      避免在批量路由里重复实现抽帧逻辑。
    前端只需 file_hash，无需关心 $TEMP / path_base 相对路径还原（O6）。
    """
    batch = batch_service.get_batch(batch_id) or batch_service.load_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"批次不存在: {batch_id}")
    m = next((x for x in batch.get("materials", []) if x.get("file_hash") == file_hash), None)
    if m is None:
        raise HTTPException(status_code=404, detail=f"素材不存在: {file_hash}")
    abs_p = resolve_path(batch, m["rel_path"])
    if not os.path.exists(abs_p):
        raise HTTPException(status_code=404, detail="素材文件缺失")

    if kind == "thumb":
        from urllib.parse import quote
        q = f"path={quote(abs_p)}&t={t}"
        if w is not None:
            q += f"&w={int(w)}"
        return RedirectResponse(f"/api/ai-editing/thumb?{q}")

    size = os.path.getsize(abs_p)
    range_header = request.headers.get("range")
    if range_header:
        parsed = _parse_range(range_header, size)
        if parsed is None:
            return StreamingResponse(
                iter([b""]), status_code=416,
                headers={"Content-Range": f"bytes */{size}"},
            )
        start, end = parsed
        return StreamingResponse(
            _file_stream(abs_p, start, end), status_code=206,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
                "Content-Type": "video/mp4",
            },
        )
    return FileResponse(abs_p, media_type="video/mp4", headers={"Accept-Ranges": "bytes"})


@router.post("/{batch_id}/clips/{clip_id}/update")
async def update_clip_fields(batch_id: str, clip_id: str, req: dict):
    """单条成片字段更新（审改抽屉用：Trim/段落替换/字幕覆盖/状态确认）。

    白名单字段：status / segments / trim_overrides / subtitle_overrides。
    - status 必须是 CLIP_STATUSES 之一（确认成片走 status="已确认"）；
    - segments 为整组替换：逐段需含 video_rel_path/in/out/duration，
      缺省字段按原段补齐，数值强转；更新后重算 total_duration；
    - BGM / 封面修改走专用端点（clips/{id}/bgm、clips/{id}/cover），不在此合并。
    """
    batch = batch_service.get_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    clip = next((c for c in batch.get("clips", []) if c.get("id") == clip_id), None)
    if clip is None:
        return _err(_ERR_NOT_FOUND, f"成片不存在: {clip_id}")

    changed = False
    if "status" in req:
        st = req["status"]
        if st not in CLIP_STATUSES:
            return _err(_ERR_BAD_REQUEST, f"非法状态: {st}（可选 {CLIP_STATUSES}）")
        clip["status"] = st
        changed = True
    if "segments" in req:
        segs = req["segments"]
        if not isinstance(segs, list) or not segs:
            return _err(_ERR_BAD_REQUEST, "segments 必须是非空数组")
        old = clip.get("segments") or []
        norm = []
        for i, s in enumerate(segs):
            base = dict(old[i]) if i < len(old) else {}
            try:
                base.update({
                    "video_rel_path": s.get("video_rel_path", base.get("video_rel_path", "")),
                    "file_hash": s.get("file_hash", base.get("file_hash", "")),
                    "scene_index": int(s.get("scene_index", base.get("scene_index", 0))),
                    "in": float(s["in"] if "in" in s else base.get("in", 0.0)),
                    "out": float(s["out"] if "out" in s else base.get("out", 0.0)),
                    "duration": float(s.get("duration", base.get("duration", 0.0))),
                    "score": float(s.get("score", base.get("score", 0.0)) or 0.0),
                })
            except (TypeError, ValueError):
                return _err(_ERR_BAD_REQUEST, f"第 {i + 1} 段数值非法")
            if not base["video_rel_path"]:
                return _err(_ERR_BAD_REQUEST, f"第 {i + 1} 段缺少 video_rel_path")
            if base["out"] <= base["in"]:
                return _err(_ERR_BAD_REQUEST, f"第 {i + 1} 段出点必须大于入点")
            norm.append(base)
        clip["segments"] = norm
        clip["total_duration"] = round(sum(s["duration"] for s in norm), 3)
        changed = True
    for k in ("trim_overrides", "subtitle_overrides"):
        if k in req:
            clip[k] = req[k]
            changed = True
    if not changed:
        return _err(_ERR_BAD_REQUEST, "没有可识别的更新字段")
    batch_service.set_field(batch_id, "clips", batch["clips"])
    return _ok(clip)


# ─── 批次详情（放最后，避免吞掉上面的具名路由）───────────────

@router.get("/{batch_id}")
async def get_batch(batch_id: str):
    """批次全量详情（断点恢复：磁盘重读 + 素材缺失误标）。"""
    batch = batch_service.load_batch(batch_id)
    if batch is None:
        return _err(_ERR_NOT_FOUND, f"批次不存在: {batch_id}")
    return _ok(batch)


# ─── 路由层自测（TestClient，无需启动 uvicorn）───────────────

if __name__ == "__main__":
    import tempfile
    import time
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    print("=== routes/batch 自测 ===")
    tmp_dir = tempfile.mkdtemp(prefix="br_test_")

    # 独立批次根 + 独立分析缓存，不污染真实数据
    from services.batch_service import BatchService
    from services.analysis_cache import AnalysisCache
    orig_svc = globals()["batch_service"]
    globals()["batch_service"] = BatchService(os.path.join(tmp_dir, "batches"))
    import services.batch_service as bs_mod
    import services.concurrent_analyzer as ca_mod
    import services.analysis_cache as ac_mod
    orig_cache = bs_mod.analysis_cache
    test_cache = AnalysisCache(os.path.join(tmp_dir, "acache"))
    bs_mod.analysis_cache = test_cache      # 登记/预估查询走这里
    orig_ca_cache = ca_mod.analysis_cache
    ca_mod.analysis_cache = test_cache      # 分析调度读写走这里（漏改会写进真实缓存）
    orig_ac_cache = ac_mod.analysis_cache
    ac_mod.analysis_cache = test_cache      # 分配取素材分析走这里（函数内 from-import）

    # TestClient 会在请求结束时取消请求作用域内 create_task 的子任务（CancelledError），
    # 故自测把 _spawn 换成「独立线程 + 独立事件循环」，与生产 uvicorn 行为等价
    import threading as _th
    orig_spawn = globals()["_spawn"]

    def _thread_spawn(coro):
        t = _th.Thread(target=lambda: asyncio.run(coro), daemon=True)
        t.start()
        return t
    globals()["_spawn"] = _thread_spawn

    # 假分析函数：免 API key、免真实视频（patch 到 concurrent_analyzer 的默认分析入口）
    orig_analyze = ca_mod._default_analyze

    async def fake_analyze(path: str, api_key: str, model: str = ""):
        await asyncio.sleep(0.01)
        return (
            [{"index": 0, "start": 0.0, "end": 4.0, "duration": 4.0}],
            [f"假分析-{os.path.basename(path)}"],
            [],
        )
    ca_mod._default_analyze = fake_analyze

    # ── S4 测试桩：TTS / 曲库 / 合成 / 导出队列（真实函数一律不触网、不跑 ffmpeg）──
    import services.ai_service as ai_mod
    import services.music_service as mu_mod
    import routes.ai_editing as ae_mod
    from services.export_queue import export_queue as _eq

    orig_analyze_script = ai_mod.analyze_script
    orig_list_music = mu_mod.list_music
    orig_resolve_music = mu_mod.resolve_music_path
    orig_split_tts = ae_mod.split_tts_endpoint
    orig_composite = ae_mod.composite_endpoint
    orig_out_root = globals()["_OUTPUT_ROOT"]
    orig_eq_spawner = _eq.spawner

    async def fake_analyze_script(text, api_key="", model=""):
        return [{"index": 0, "text": text + "上"}, {"index": 1, "text": text + "下"}]
    ai_mod.analyze_script = fake_analyze_script

    # 假曲库只有 2 首：3 片轮替必然撞 1 组（用来验证撞曲明细）
    fake_tracks = [
        {"name": "轻快A.mp3", "path": os.path.join(tmp_dir, "轻快A.mp3"), "duration_sec": 30.0},
        {"name": "舒缓B.mp3", "path": os.path.join(tmp_dir, "舒缓B.mp3"), "duration_sec": 30.0},
    ]
    mu_mod.list_music = lambda: [dict(t) for t in fake_tracks]
    mu_mod.resolve_music_path = lambda name: next(
        (t["path"] for t in fake_tracks if t["name"] == name), None)

    # 假 split-tts：产物是真实文件（断点检查要看它在不在）；
    # 「文案二」首次调用返回失败 —— 验证单脚本失败不阻塞 + 二次调用只补跑它
    split_fail_count = {"n": 0}

    async def fake_split_tts(req):
        joined = "".join(s.get("text", "") for s in req.get("segments") or [])
        if "文案二" in joined:
            split_fail_count["n"] += 1
            if split_fail_count["n"] == 1:
                return {"code": 50001, "message": "模拟TTS失败", "data": None}
        audio = os.path.join(tmp_dir, f"fake_tts_{abs(hash(joined)) % 100000}.mp3")
        with open(audio, "wb") as f:
            f.write(b"fake-audio")
        return {"code": 0, "message": "success", "data": {
            "audio_path": audio, "total_duration": 3.0, "seg_durations": [1.5, 1.5]}}

    ae_mod.split_tts_endpoint = fake_split_tts

    # 假合成：产物是真实临时文件（_render_export_job 会 shutil.move 归档走它）
    composite_calls: list[str] = []

    async def fake_composite(req):
        composite_calls.append(req.get("output_name", ""))
        src = os.path.join(tmp_dir, f"fake_comp_{len(composite_calls)}.mp4")
        with open(src, "wb") as f:
            f.write(b"fake-video")
        return {"code": 0, "message": "success", "data": {"output_path": src}}

    ae_mod.composite_endpoint = fake_composite

    # 导出产物根：必须和 BASE_DIR 同盘（_render_export_job 里 os.path.relpath 跨盘会炸），
    # 放 backend/data 下的独立测试目录，finally 里整体 rmtree，不碰真实 output
    test_out_root = Path(BASE_DIR) / "data" / f"_test_out_s4_{os.getpid()}"
    globals()["_OUTPUT_ROOT"] = test_out_root

    # 导出队列 worker 派生器换线程版（与 _spawn 同理：TestClient 会取消请求作用域任务）；
    # 句柄 done() 反映线程真实存活（retry 后需能重启 worker）
    def _eq_thread_spawner(coro):
        t = _th.Thread(target=lambda: asyncio.run(coro), daemon=True)
        t.start()

        class _Handle:
            def done(self):
                return not t.is_alive()
        return _Handle()
    _eq.spawner = _eq_thread_spawner

    try:
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)

        # ── 1. 创建 + list ──
        r = client.post("/api/batch/create", json={"name": "路由测试批次", "settings": {"speed": 1.2}})
        assert r.status_code == 200 and r.json()["code"] == 0, r.text
        bid = r.json()["data"]["id"]
        r = client.get("/api/batch/list")
        assert any(x["id"] == bid for x in r.json()["data"])
        print(f"[OK] create + list: {bid}")

        # ── 2. 登记 2 条假素材 ──
        f1 = os.path.join(tmp_dir, "m1.mp4")
        f2 = os.path.join(tmp_dir, "m2.mp4")
        open(f1, "wb").write(os.urandom(16 * 1024))
        open(f2, "wb").write(os.urandom(16 * 1024))
        r = client.post(f"/api/batch/{bid}/materials/add", json={"paths": [f1, f2, f1]})
        d = r.json()["data"]
        assert len(d["added"]) == 2 and len(d["skipped"]) == 1, d  # 第三个是同路径重复
        hashes = [m["file_hash"] for m in d["added"]]
        print(f"[OK] materials/add: 2 条登记，重复路径去重")

        # ── 3. 分析（假分析函数）→ 轮询状态 → 素材标 done ──
        r = client.post(f"/api/batch/{bid}/analyze", json={"api_key": "fake"})
        assert r.json()["data"]["total"] == 2, r.text
        for _ in range(100):
            time.sleep(0.05)
            st = client.get(f"/api/batch/{bid}/analyze/status").json()["data"]
            if not st["running"]:
                break
        assert st["done"] == 2 and st["finished_at"], st
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert all(m["analysis_status"] == "done" and m["duration"] == 4.0 for m in b["materials"])
        assert b["stage"] == "prescan", "分析完成应自动推进到 prescan"
        print(f"[OK] analyze: 进度 {st['done']}/{st['total']}，素材回填 done，阶段推进 prescan")

        # ── 3b. 分析控制端点：暂停 / 继续 / 停止（状态机 + 软放弃）──
        # 用慢速假分析（sleep 0.1）保证有「进行中/排队」窗口可暂停。
        # 隔离到独立批次 ctrlId，避免往主批次 bid 注入素材而污染后续断言。
        async def slow_fake(path, api_key, model=""):
            await asyncio.sleep(0.1)
            return (
                [{"index": 0, "start": 0.0, "end": 1.0, "duration": 1.0}],
                [f"假分析-{os.path.basename(path)}"],
                [],
            )
        ca_mod._default_analyze = slow_fake
        ctrlId: str | None = None
        try:
            r = client.post("/api/batch/create", json={"name": "控制测试批次"})
            assert r.status_code == 200 and r.json()["code"] == 0, r.text
            ctrlId = r.json()["data"]["id"]

            # 20 条用于 暂停→继续 窗口
            many = [os.path.join(tmp_dir, f"many_{i}.mp4") for i in range(20)]
            for p in many:
                open(p, "wb").write(os.urandom(16 * 1024))
            r = client.post(f"/api/batch/{ctrlId}/materials/add", json={"paths": many})
            assert r.json()["code"] == 0
            r = client.post(f"/api/batch/{ctrlId}/analyze", json={"api_key": "fake", "max_workers": 5})
            assert r.json()["code"] == 0
            time.sleep(0.06)
            st = client.get(f"/api/batch/{ctrlId}/analyze/status").json()["data"]
            assert st["running"] and st["state"] == "running", st
            r = client.post(f"/api/batch/{ctrlId}/analyze/pause", json={})
            assert r.json()["code"] == 0 and r.json()["data"]["state"] == "paused"
            st = client.get(f"/api/batch/{ctrlId}/analyze/status").json()["data"]
            assert st["state"] == "paused"
            r = client.post(f"/api/batch/{ctrlId}/analyze/resume", json={})
            assert r.json()["data"]["state"] == "running"
            for _ in range(100):
                time.sleep(0.05)
                st = client.get(f"/api/batch/{ctrlId}/analyze/status").json()["data"]
                if not st["running"]:
                    break
            assert st["done"] == 20, st
            print(f"[OK] 分析控制: 暂停→继续→完成，状态机正常，done={st['done']}")

            # 停止：再登 10 条，start→pause→stop，剩余应回退 pending
            few = [os.path.join(tmp_dir, f"few_{i}.mp4") for i in range(10)]
            for p in few:
                open(p, "wb").write(os.urandom(16 * 1024))
            client.post(f"/api/batch/{ctrlId}/materials/add", json={"paths": few})
            r = client.post(f"/api/batch/{ctrlId}/analyze", json={"api_key": "fake", "max_workers": 5})
            assert r.json()["code"] == 0
            time.sleep(0.06)
            r = client.post(f"/api/batch/{ctrlId}/analyze/pause", json={})
            assert r.json()["data"]["state"] == "paused"
            time.sleep(0.06)
            r = client.post(f"/api/batch/{ctrlId}/analyze/stop", json={})
            assert r.json()["data"]["state"] == "stopping"
            for _ in range(100):
                time.sleep(0.05)
                st = client.get(f"/api/batch/{ctrlId}/analyze/status").json()["data"]
                if not st["running"]:
                    break
            b = client.get(f"/api/batch/{ctrlId}").json()["data"]
            pending_after = sum(1 for m in b["materials"] if m["analysis_status"] == "pending")
            assert pending_after > 0, "停止后应仍有 pending（剩余回退）"
            print(f"[OK] 分析控制/停止: 剩余 {pending_after} 条回退 pending，可重跑")
        finally:
            ca_mod._default_analyze = orig_analyze  # 还原，避免污染后续测试
            if ctrlId is not None:
                client.request("DELETE", "/api/batch/delete", json={"ids": [ctrlId]})

        # ── 4. 预修（假视频 ffmpeg 必失败 → 优雅标 failed，不崩）──
        r = client.post(f"/api/batch/{bid}/prescan", json={})
        assert r.json()["data"]["total"] == 2
        for _ in range(200):
            time.sleep(0.05)
            st = client.get(f"/api/batch/{bid}/prescan/status").json()["data"]
            if not st["running"]:
                break
        assert st["done"] == 2, st
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert all(m["prescan_status"] == "failed" for m in b["materials"])
        # 手工确认一条（模拟预修台一键确认）
        r = client.post(f"/api/batch/{bid}/materials/update",
                        json={"file_hash": hashes[0], "usable_in": 0.5, "usable_out": 3.5})
        assert r.json()["data"]["prescan_status"] == "confirmed"
        print("[OK] prescan: 失败优雅降级 + 手工确认区间 → confirmed")

        # ── 5. 脚本 / 设置 / estimate ──
        r = client.post(f"/api/batch/{bid}/scripts", json={"scripts": [
            {"text": "文案一", "copies": 2}, {"text": "文案二"},
        ]})
        assert r.json()["data"]["count"] == 2
        r = client.post(f"/api/batch/{bid}/settings", json={"voice": "v1", "target_duration": 4.0})
        assert r.json()["data"]["voice"] == "v1"
        est = client.get(f"/api/batch/{bid}/estimate").json()["data"]
        # 两条素材 duration=4.0；一条确认窗口 [0.5,3.5]=3s，另一条全窗 4s；
        # 分析场景各 1 段（均落窗内）→ 共 2 段；target 4s ÷ 场景 4s = 1 段/片 → 建议 2 片
        assert est["suggested_max_clips"] == 2, est
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert b["stage"] == "scripts" and len(b["scripts"]) == 2 and b["scripts"][0]["copies"] == 2
        print(f"[OK] scripts/settings/estimate: 建议 {est['suggested_max_clips']} 片，阶段 {b['stage']}")

        # ── 6. 分配（S3）：2 素材 × 3 片，重度降级场景 ──
        import copy
        r = client.post(f"/api/batch/{bid}/allocate", json={"clips": [
            {"script_id": "s1", "seg_durations": [1.5, 1.5], "segment_texts": ["文案一上", "文案一下"]},
            {"script_id": "s1", "seg_durations": [1.5, 1.5], "segment_texts": ["文案一上", "文案一下"]},
            {"script_id": "s2", "seg_durations": [1.5, 1.5], "segment_texts": ["文案二上", "文案二下"]},
        ]})
        d = r.json()
        assert d["code"] == 0 and d["data"]["clips"] == 3, d
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert b["stage"] == "review" and len(b["clips"]) == 3
        assert all(c["status"] == "待确认" for c in b["clips"])
        # 窗口约束：素材0 确认窗口 [0.5,3.5]，素材1 [0,4]
        for c in b["clips"]:
            for s in c["segments"]:
                assert s["in"] >= -1e-3 and s["out"] <= 4.0 + 1e-3
        rep = client.get(f"/api/batch/{bid}/allocation-report").json()["data"]
        assert sum(rep["usage_distribution"].values()) == 6, rep["usage_distribution"]
        assert len(rep["repeats"]) >= 1, "2 素材供 6 段必然产生重复明细"
        assert len(rep["jaccard_matrix"]) == 3
        print(f"[OK] allocate: 3 片已生成，usage={rep['usage_distribution']}，"
              f"重复 {len(rep['repeats'])} 条，阶段 review")

        # ── 7. O3 单条重分配：其他片不动、usage 重算 ──
        before = {c["id"]: copy.deepcopy(c["segments"]) for c in b["clips"]}
        r = client.post(f"/api/batch/{bid}/clips/c2/reallocate",
                        json={"seg_durations": [1.0, 1.0, 1.0], "segment_texts": ["新二上", "新二中", "新二下"]})
        d = r.json()
        assert d["code"] == 0, d
        b2 = client.get(f"/api/batch/{bid}").json()["data"]
        after = {c["id"]: c["segments"] for c in b2["clips"]}
        assert after["c1"] == before["c1"] and after["c3"] == before["c3"], "其他片绝不能变"
        assert len(after["c2"]) == 3 and abs(sum(s["duration"] for s in after["c2"]) - 3.0) < 1e-3
        rep2 = client.get(f"/api/batch/{bid}/allocation-report").json()["data"]
        assert sum(rep2["usage_distribution"].values()) == 7, "usage 应=旧两片4段+新片3段"
        est2 = client.get(f"/api/batch/{bid}/estimate").json()["data"]
        assert est2["post_allocation"] and est2["post_allocation"]["clips"] == 3
        print(f"[OK] reallocate: 其他两片未动，c2 重分 3 段，usage 总段数 7，estimate 附实际统计")

        # ── 8. 分配错误分支 ──
        assert client.post(f"/api/batch/{bid}/allocate", json={"clips": []}).json()["code"] == 40402
        assert client.post(f"/api/batch/{bid}/clips/ghost/reallocate",
                           json={"seg_durations": [1.0]}).json()["code"] == 40401
        print("[OK] 分配错误分支: 缺参 40402 / 成片不存在 40401")

        # ── 9. TTS 预生成（S4-1）：单脚本失败不阻塞、copies 共享产物、O3 级联 ──
        assert client.post(f"/api/batch/{bid}/tts", json={}).json()["code"] == 40402
        r = client.post(f"/api/batch/{bid}/tts", json={"api_key": "fake"})
        assert r.json()["data"]["total"] == 2, r.text
        for _ in range(200):
            time.sleep(0.05)
            st = client.get(f"/api/batch/{bid}/tts/status").json()["data"]
            if not st["running"]:
                break
        assert st["done"] == 2 and st["finished_at"], st
        b = client.get(f"/api/batch/{bid}").json()["data"]
        s1_tts, s2_tts = b["scripts"][0]["tts"], b["scripts"][1]["tts"]
        assert s1_tts["status"] == "done" and s1_tts["seg_durations"] == [1.5, 1.5], s1_tts
        assert os.path.exists(s1_tts["audio_path"]), "TTS 产物文件应真实存在"
        assert s2_tts["status"] == "failed" and "模拟TTS失败" in s2_tts["error"], s2_tts
        # O3 级联：s1 完成 → 用 s1 的 c1/c2 标「待重新分配」；s2 失败 → c3 不动
        st_by_id = {c["id"]: c["status"] for c in b["clips"]}
        assert st_by_id == {"c1": "待重新分配", "c2": "待重新分配", "c3": "待确认"}, st_by_id
        # 二次 TTS（无 force）：只补跑失败的 s2
        r = client.post(f"/api/batch/{bid}/tts", json={"api_key": "fake"})
        assert r.json()["data"]["total"] == 1, r.text
        for _ in range(200):
            time.sleep(0.05)
            st = client.get(f"/api/batch/{bid}/tts/status").json()["data"]
            if not st["running"]:
                break
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert b["scripts"][1]["tts"]["status"] == "done"
        print("[OK] tts: 2 脚本串行，s2 首次失败不阻塞 s1，二次补跑完成；级联标「待重新分配」")

        # ── 10. allocate 缺省 clips：自动从 TTS 构建 + BGM 自动轮替（S4-2 联动）──
        r = client.post(f"/api/batch/{bid}/allocate", json={})
        d = r.json()
        assert d["code"] == 0 and d["data"]["clips"] == 3, d
        bgm = d["data"]["bgm"]
        assert bgm["assigned"] == 3 and bgm["tracks"] == 2 and len(bgm["collisions"]) == 1, bgm
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert [c.get("bgm_name") for c in b["clips"]] == ["轻快A.mp3", "舒缓B.mp3", "轻快A.mp3"]
        assert all(c["status"] == "待确认" for c in b["clips"]), "重新分配后全部回到待确认"
        print(f"[OK] allocate 自动构建: 3 片（s1×2+s2×1），BGM {bgm['tracks']} 曲轮替，撞曲 1 组")

        # ── 11. BGM 单条换曲（撞曲警告不拦截）+ 手动重轮替 ──
        r = client.post(f"/api/batch/{bid}/clips/c3/bgm", json={"bgm_name": "舒缓B.mp3"})
        d = r.json()["data"]
        assert d["collision_with"] == ["c2"] and d["warning"], d
        assert client.post(f"/api/batch/{bid}/clips/c3/bgm",
                           json={"bgm_name": "不存在.mp3"}).json()["code"] == 40402
        r = client.post(f"/api/batch/{bid}/bgm/assign", json={})
        assert r.json()["data"]["assigned"] == 3
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert b["clips"][2]["bgm_name"] == "轻快A.mp3", "重轮替应恢复 c3 曲目"
        print("[OK] bgm: 单条换曲撞曲警告 + 非法曲目 40402 + 手动重轮替")

        # ── 12. 封面差异化（S4-3）：裂变标题变体 + user_modified 不覆盖 ──
        r = client.post(f"/api/batch/{bid}/covers/assign", json={})
        assert r.json()["data"] == {"assigned": 3, "skipped_user_modified": 0}, r.json()
        b = client.get(f"/api/batch/{bid}").json()["data"]
        titles = {c["id"]: c["cover"]["title"] for c in b["clips"]}
        assert titles == {"c1": "文案一·其一", "c2": "文案一·其二", "c3": "文案二"}, titles
        tpls = [c["cover"]["template"] for c in b["clips"]]
        assert tpls == ["top_yellow", "center_white", "bottom_cyan"], tpls
        r = client.post(f"/api/batch/{bid}/clips/c3/cover", json={"title": "手工封面"})
        assert r.json()["data"]["cover"]["user_modified"] is True
        r = client.post(f"/api/batch/{bid}/covers/assign", json={})
        assert r.json()["data"] == {"assigned": 2, "skipped_user_modified": 1}
        b = client.get(f"/api/batch/{bid}").json()["data"]
        c3_cover = next(c["cover"] for c in b["clips"] if c["id"] == "c3")
        assert c3_cover["title"] == "手工封面" and c3_cover["user_modified"]
        print(f"[OK] covers: 裂变标题「{titles['c1']}」「{titles['c2']}」，模板轮替，手改不覆盖")

        # ── 13. 导出队列（S4-4）：FIFO + O5 命名 + 产物归档 + 断线跳过 ──
        r = client.post(f"/api/batch/{bid}/export", json={"clip_ids": ["c1", "c2", "c3"]})
        d = r.json()
        assert d["code"] == 0 and d["data"]["enqueued"] == 3 and d["data"]["skipped_done"] == [], d
        for _ in range(400):
            time.sleep(0.05)
            st = client.get(f"/api/batch/{bid}/export/status").json()["data"]
            if st["all_done"]:
                break
        assert st["done_count"] == 3 and st["failed_count"] == 0, st
        # FIFO：composite 调用顺序即入队顺序（output_name 尾号是 clip_id）
        assert [n.rsplit("_", 1)[-1] for n in composite_calls] == ["c1", "c2", "c3"], composite_calls
        b = client.get(f"/api/batch/{bid}").json()["data"]
        out_dir = test_out_root / f"路由测试批次_{datetime.now().strftime('%Y%m%d')}"
        for i, c in enumerate(b["clips"], 1):
            assert c["status"] == "已完成" and c["output_path"], c
            fname = os.path.basename(c["output_path"])
            assert fname.startswith(f"路由测试批次_{i:02d}_") and fname.endswith(".mp4"), fname
            assert os.path.exists(out_dir / fname), f"产物应归档到 {out_dir}"
        assert len(list(out_dir.glob("*.mp4"))) == 3
        # 断线容忍：已完成且产物还在 → 整批跳过不重跑
        r = client.post(f"/api/batch/{bid}/export", json={"clip_ids": ["c1", "c2", "c3"]})
        d = r.json()["data"]
        assert d["enqueued"] == 0 and sorted(d["skipped_done"]) == ["c1", "c2", "c3"], d
        print(f"[OK] export: FIFO 3 片，O5 命名 路由测试批次_01..03_标题.mp4，重导全跳过")

        # ── 14. 导出 暂停/取消/重试 ──
        # 先把 c1 状态改回「待确认」（重分配是唯一会重置成片状态的正规入口）
        r = client.post(f"/api/batch/{bid}/clips/c1/reallocate",
                        json={"seg_durations": [1.5, 1.5], "segment_texts": ["文案一上", "文案一下"]})
        assert r.json()["code"] == 0, r.text
        client.post(f"/api/batch/{bid}/export/pause", json={"paused": True})
        r = client.post(f"/api/batch/{bid}/export", json={"clip_ids": ["c1"]})
        assert r.json()["data"]["enqueued"] == 1
        time.sleep(0.3)
        st = client.get(f"/api/batch/{bid}/export/status").json()["data"]
        assert st["paused"] and any(
            j["clip_id"] == "c1" and j["status"] == "pending" for j in st["jobs"]), st
        r = client.post(f"/api/batch/{bid}/export/cancel/c1")
        assert r.json()["code"] == 0
        b = client.get(f"/api/batch/{bid}").json()["data"]
        assert next(c for c in b["clips"] if c["id"] == "c1")["status"] == "待确认"
        r = client.post(f"/api/batch/{bid}/export/retry/c1")
        assert r.json()["code"] == 0, r.text
        client.post(f"/api/batch/{bid}/export/pause", json={"paused": False})
        for _ in range(400):
            time.sleep(0.05)
            st = client.get(f"/api/batch/{bid}/export/status").json()["data"]
            if st["all_done"]:
                break
        b = client.get(f"/api/batch/{bid}").json()["data"]
        c1 = next(c for c in b["clips"] if c["id"] == "c1")
        assert c1["status"] == "已完成", c1
        assert os.path.basename(c1["output_path"]).startswith("路由测试批次_04_"), c1["output_path"]
        print("[OK] export 暂停/取消/重试: 暂停期不入渲，取消回「待确认」，重试完成（序号 04）")

        # ── 15. 断点恢复 + 删除 ──
        assert client.get(f"/api/batch/{bid}").json()["code"] == 0
        r = client.request("DELETE", "/api/batch/delete", json={"ids": [bid]})
        assert r.json()["data"]["deleted"] == [bid]
        assert client.get(f"/api/batch/{bid}").json()["code"] == 40401
        assert os.path.exists(f1), "删除批次绝不动原始素材"
        print("[OK] delete: 批次删除、素材文件完好、详情返回 40401")

        # ── 16. 错误分支 ──
        assert client.post("/api/batch/create", json={"name": ""}).json()["code"] == 40402
        assert client.post(f"/api/batch/{bid}/analyze", json={"api_key": "x"}).json()["code"] == 40401
        print("[OK] 错误分支: 缺参 40402 / 批次不存在 40401")
    finally:
        globals()["batch_service"] = orig_svc
        globals()["_spawn"] = orig_spawn
        bs_mod.analysis_cache = orig_cache
        ca_mod.analysis_cache = orig_ca_cache
        ac_mod.analysis_cache = orig_ac_cache
        ca_mod._default_analyze = orig_analyze
        # S4 桩还原 + 导出队列/产物目录清理（单例不能带测试残留）
        ai_mod.analyze_script = orig_analyze_script
        mu_mod.list_music = orig_list_music
        mu_mod.resolve_music_path = orig_resolve_music
        ae_mod.split_tts_endpoint = orig_split_tts
        ae_mod.composite_endpoint = orig_composite
        globals()["_OUTPUT_ROOT"] = orig_out_root
        _eq.pause(False)
        _eq.spawner = orig_eq_spawner
        with _eq._lock:
            _eq._jobs.clear()
        shutil.rmtree(test_out_root, ignore_errors=True)

    print("=== 全部自测通过 ===")
