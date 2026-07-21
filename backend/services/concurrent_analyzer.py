"""
批量素材并发分析调度器（D3 + D4）。

工作流（对每条素材）：
1. ``analysis_cache.fast_file_hash`` 快哈希（O4）→ 查素材级缓存，命中直接返回
   （标注 ``cached: true``，帧文件若被系统清理则用缓存 scenes 本地重新抽帧，零 API 成本）；
2. 未命中 → 在动态限流槽内调用**现有**单视频分析 ``routes.ai_editing._analyze_single_video``
   （直接复用，不复制其逻辑），成功后写入素材级缓存；
3. 单条失败不影响整体，结果按 ``{"results": {...}, "failed": {...}}`` 返回。

429 自动降速（D3）：
- 现有链路 ``ai_service._analyze_frame_with_semaphore`` 会把 vision 失败吞成
  ``"[分析失败] ..."`` 描述串（429 也在其中，且 ``_retry_with_backoff`` 只捕 httpx 异常，
  RuntimeError 形式的 429 不会被内层重试）——因此本调度器在**外层**识别两类 429 信号：
  a) 抛出的异常文本含 429/rate-limit；b) 返回描述串含 ``[分析失败]`` + 429 标记。
- 识别到 429：该素材指数退避重试（最多 3 次：2s/4s/8s），同时全局并发许可
  动态减半（下限 1），持续 60 秒后自动恢复基准值。

说明：现有分析链路是 async（``analyze_frames_batch`` 走 asyncio），
故并发模型采用 asyncio + 动态许可（条件变量实现），而非线程池。
"""
from __future__ import annotations

import os
import re
import asyncio
import logging
from pathlib import Path

try:
    from config import TEMP_DIR
except ModuleNotFoundError:
    # 允许 `python services/concurrent_analyzer.py` 直接运行自测（生产由 backend/ 启动，无此分支）
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from config import TEMP_DIR

from services.analysis_cache import fast_file_hash, analysis_cache
from services.video_service import extract_scene_frames

logger = logging.getLogger(__name__)

# ─── 常量 ──────────────────────────────────────────────────

# 默认并发数：读环境变量 MASHUP_ANALYSIS_CONCURRENT，无则默认 5（D3）。
# 注意：config.ANALYSIS_MAX_CONCURRENT 默认 3 是单条工作流的旧值，批量调度按 D3 独立取值。
_DEFAULT_MAX_WORKERS: int = int(os.environ.get("MASHUP_ANALYSIS_CONCURRENT", "5"))

# 429 重试次数与退避基数（2s/4s/8s，D3）
_MAX_RATE_RETRIES: int = 3
_BACKOFF_BASE_SEC: float = 2.0

# 429 降速窗口：许可减半持续 60 秒后恢复（D3）
_THROTTLE_WINDOW_SEC: float = 60.0

# F4 单条分析硬超时（秒）：任一素材的视觉分析（含 ffmpeg 抽帧 + 重试）若超过此值，
# 标记为失败并释放 limiter 槽，避免单条卡死（如视觉 API 挂起）拖垮整条队列。
# 配合 _DynamicLimiter 的并发上限，此超时保证队列最终一定会向前推进，不会无限阻塞。
_SINGLE_ITEM_TIMEOUT_SEC: float = 120.0

# F10 批量场景检测提速（仅作用于批量调度，单条精细工作流不受影响）：
# - _BATCH_SCENE_SKIP_NONKEYFRAMES：仅解码关键帧做场景检测（约 5-10x 提速，
#   场景边界变粗但更对齐编码帧）。
# - _BATCH_SCENE_LOWRES：H.264 降分辨率解码（1/2→1, 1/4→2, 1/8→3）；仅 H.264 生效
#   （HEVC 解码器不支持 lowres，detect_scenes 内部会按 codec_name 判断跳过）。
# 经 _default_analyze 注入 _analyze_single_video；单条路径直连 _analyze_single_video
# 走默认参数（False/0），行为完全不变。可用环境变量 MASHUP_SCENE_LOWRES 覆盖降分辨率档位。
_BATCH_SCENE_SKIP_NONKEYFRAMES: bool = True
_BATCH_SCENE_LOWRES: int = int(os.environ.get("MASHUP_SCENE_LOWRES", "2"))

# 429 / 限流信号识别（兼容 "429" / "Too Many Requests" / "rate limit" 等写法）
_RATE_LIMIT_PAT = re.compile(r"429|too many requests|rate.?limit", re.IGNORECASE)

# 现有链路对单帧失败的描述串前缀（见 ai_service._analyze_frame_with_semaphore）
_FAILURE_PREFIX = "[分析失败]"


# ─── 分析控制对象（软暂停 / 停止，零卡死风险）───────────────
# 设计：_work 在「拿 limiter 槽之前」检查 control —— 已暂停则让出槽并轻量轮询
# （排队中的任务不占并发许可），进行中的任务自然跑完；停止则直接退出并把该组路径
# 记入 stopped_paths，由路由回退为 pending。
# 注意：刻意不依赖 asyncio.Event（Event 绑定到创建它的事件循环，若控制对象与后台
# 任务不在同一事件循环——如路由自测把后台任务跑在独立线程——await 会 RuntimeError）。
# 改用纯布尔 + asyncio.sleep 轮询，跨循环安全且对播放器式暂停/继续无感（~50ms 延迟）。

class _Control:
    def __init__(self) -> None:
        self.paused = False
        self.stopped = False
        self.stopped_paths: list[str] = []

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def stop(self) -> None:
        self.stopped = True


# {batch_id: _Control} —— 路由层按批次存取，供 pause/resume/stop 端点共享同一实例
_CONTROLS: dict[str, "_Control"] = {}


def create_control(batch_id: str) -> "_Control":
    ctl = _Control()
    _CONTROLS[batch_id] = ctl
    return ctl


def get_control(batch_id: str) -> "_Control | None":
    return _CONTROLS.get(batch_id)


def clear_control(batch_id: str) -> None:
    _CONTROLS.pop(batch_id, None)


# ─── 429 信号识别 ─────────────────────────────────────────

def _looks_rate_limited(text: str) -> bool:
    """文本中是否含 429 / rate-limit 信号。"""
    return bool(_RATE_LIMIT_PAT.search(text or ""))


def _is_failure_marker(desc) -> bool:
    """描述串是否是现有链路的失败标记（``[分析失败] ...``）。"""
    return isinstance(desc, str) and desc.startswith(_FAILURE_PREFIX)


def _first_rate_limit_marker(descriptions: list) -> str | None:
    """在描述串列表中找第一条由 429 导致的失败标记，找不到返回 None。"""
    for d in descriptions or []:
        if _is_failure_marker(d) and _looks_rate_limited(d):
            return d
    return None


# ─── 动态并发许可 ─────────────────────────────────────────

class _DynamicLimiter:
    """动态并发许可（asyncio 条件变量实现）。

    正常时许可数 = max_workers；任一任务检测到 429 调 ``throttle()``：
    许可立即减半（下限 1），``throttle_window`` 秒后自动恢复基准值；
    窗口内再次 429 会继续减半并顺延恢复时间。
    （asyncio 单线程事件循环，属性读写天然无线程竞争，故不需要线程锁。）
    """

    def __init__(self, initial: int, throttle_window: float = _THROTTLE_WINDOW_SEC) -> None:
        self._base = max(1, int(initial))
        self._limit = self._base
        self._inflight = 0
        self._window = float(throttle_window)
        self._cond = asyncio.Condition()
        self._restore_handle: asyncio.TimerHandle | None = None

    @property
    def current_limit(self) -> int:
        """当前生效的并发许可数（观测/调试用）。"""
        return self._limit

    async def acquire(self) -> None:
        async with self._cond:
            while self._inflight >= self._limit:
                await self._cond.wait()
            self._inflight += 1

    async def release(self) -> None:
        async with self._cond:
            self._inflight = max(0, self._inflight - 1)
            self._cond.notify()

    def slot(self):
        """异步上下文管理器：``async with limiter.slot(): ...``。"""
        limiter = self

        class _Slot:
            async def __aenter__(self):
                await limiter.acquire()

            async def __aexit__(self, *exc):
                await limiter.release()
                return False

        return _Slot()

    def throttle(self) -> None:
        """429 触发：许可减半（下限 1），并重置恢复计时。"""
        new_limit = max(1, self._limit // 2)
        logger.warning(
            f"[CONCURRENT] 检测到上游限流(429)，并发许可 {self._limit} → {new_limit}，"
            f"{self._window:.0f}s 后恢复"
        )
        self._limit = new_limit
        loop = asyncio.get_running_loop()
        if self._restore_handle is not None:
            self._restore_handle.cancel()
        self._restore_handle = loop.call_later(self._window, self._restore)

    def _restore(self) -> None:
        """窗口结束：恢复基准许可并唤醒等待中的任务。"""
        self._restore_handle = None
        self._limit = self._base
        logger.info(f"[CONCURRENT] 限流窗口结束，并发许可恢复为 {self._base}")

        async def _notify() -> None:
            async with self._cond:
                self._cond.notify_all()

        asyncio.ensure_future(_notify())


# ─── 默认分析函数（复用现有单视频分析链路，不重写）─────────

async def _default_analyze(video_path: str, api_key: str, model: str):
    """延迟导入现有单视频分析入口（避免模块加载时引入 FastAPI 路由栈）。

    F10：仅批量路径在此注入场景检测提速标志；单条精细工作流不经此函数，
    故不受任何提速参数影响（隔离保证见 批量分析_最优迭代方案.md）。
    """
    from routes.ai_editing import _analyze_single_video
    return await _analyze_single_video(
        video_path, api_key, model,
        skip_nonkeyframes=_BATCH_SCENE_SKIP_NONKEYFRAMES,
        lowres=_BATCH_SCENE_LOWRES,
    )


# ─── 内部：缓存命中的帧文件自愈 ────────────────────────────

async def _ensure_frames(video_path: str, payload: dict) -> list:
    """缓存命中时校验帧文件仍在；被清理则用缓存 scenes 本地重新抽帧（零 API 成本）。

    抽帧目录约定与 ``routes.ai_editing._analyze_single_video`` 完全一致
    （``TEMP_DIR/ai_frames/<basename>``），保证下游消费方式不变。
    """
    frames = payload.get("frames") or []
    if frames and all(os.path.exists(f) for f in frames):
        return frames
    scenes = payload.get("scenes") or []
    if not scenes:
        return frames
    try:
        frame_dir = os.path.join(str(TEMP_DIR), "ai_frames", os.path.basename(video_path))
        new_frames = await asyncio.to_thread(extract_scene_frames, video_path, scenes, frame_dir)
        logger.info(f"[CONCURRENT] 缓存帧已失效，已重新抽帧: {video_path}")
        return new_frames
    except Exception as e:
        logger.warning(f"[CONCURRENT] 缓存帧重建失败（沿用旧路径）: {video_path}: {e}")
        return frames


# ─── 内部：带 429 退避重试的单素材分析 ─────────────────────

async def _analyze_with_retry(
    video_path: str,
    file_hash: str,
    analyze_fn,
    api_key: str,
    model: str,
    limiter: _DynamicLimiter,
    max_rate_retries: int = _MAX_RATE_RETRIES,
    backoff_base: float = _BACKOFF_BASE_SEC,
) -> dict:
    """分析单条素材（调用方已持有 limiter 槽），429 时退避重试并触发全局降速。

    Returns:
        结果 payload（含 scenes/descriptions/frames/file_hash/duration/cached）。
        含非 429 局部帧失败时带 ``_partial: True``（不写入永久缓存）。
    """
    scenes: list = []
    descriptions: list = []
    frames: list = []

    for attempt in range(max_rate_retries + 1):
        try:
            scenes, descriptions, frames = await analyze_fn(video_path, api_key, model)
        except Exception as e:
            # a) 异常文本带 429 → 降速 + 退避重试；否则直接抛出记入 failed
            if _looks_rate_limited(str(e)):
                limiter.throttle()
                if attempt < max_rate_retries:
                    delay = backoff_base * (2 ** attempt)
                    logger.warning(f"[CONCURRENT] {video_path} 429 重试 {attempt + 1}/{max_rate_retries}，{delay:.0f}s 后重试")
                    await asyncio.sleep(delay)
                    continue
            raise

        # b) 429 被现有链路吞进描述串 → 扫描识别，同样降速 + 退避重试
        rl_marker = _first_rate_limit_marker(descriptions)
        if rl_marker is None:
            break  # 成功（可能有非 429 的局部帧失败，按部分成功处理）
        limiter.throttle()
        if attempt < max_rate_retries:
            delay = backoff_base * (2 ** attempt)
            logger.warning(f"[CONCURRENT] {video_path} 描述串检出 429，重试 {attempt + 1}/{max_rate_retries}，{delay:.0f}s 后重试")
            await asyncio.sleep(delay)
            continue
        raise RuntimeError(f"分析持续被上游限流(429)，重试 {max_rate_retries} 次仍失败: {rl_marker[:120]}")

    duration = round(scenes[-1]["end"], 2) if scenes else 0.0
    partial = any(_is_failure_marker(d) for d in descriptions)
    payload = {
        "scenes": scenes,
        "descriptions": descriptions,
        "frames": frames,
        "file_hash": file_hash,
        "duration": duration,
        "cached": False,
    }
    if partial:
        # 带失败标记的结果不写入永久缓存（D4），避免坏结果被永久锁死
        payload["_partial"] = True
    elif scenes:
        await asyncio.to_thread(
            analysis_cache.save_analysis,
            file_hash,
            payload,
            {"duration": duration, "source_path": video_path},
        )
    return payload


# ─── 主入口 ───────────────────────────────────────────────

async def analyze_materials_concurrently(
    video_paths: list[str],
    api_key: str,
    model: str = "",
    progress_cb=None,
    max_workers: int | None = None,
    _analyze_fn=None,
    _throttle_window: float = _THROTTLE_WINDOW_SEC,
    _backoff_base: float = _BACKOFF_BASE_SEC,
    control: "_Control | None" = None,
    per_item_timeout: float | None = None,
) -> dict:
    """批量并发分析素材（D3 调度 + D4 哈希缓存）。

    Args:
        video_paths: 素材绝对路径列表（允许重复；同哈希只分析一次，O4）。
        api_key:     AI 服务 key（透传给现有分析链路）。
        model:       vision 模型名（空则用现有默认）。
        progress_cb: 每完成一条回调 ``progress_cb(done, total, current_path, status)``，
                     status ∈ {"cached", "analyzed", "partial", "failed"}。
        max_workers: 并发数；None 时读环境变量 MASHUP_ANALYSIS_CONCURRENT，无则默认 5。
        _analyze_fn: 测试注入用（默认复用 routes.ai_editing._analyze_single_video）。
        _throttle_window / _backoff_base: 测试调小时间常量用，生产保持默认。
        control:    _Control 控制对象（软暂停/停止）；None 时无控制（生产由路由层传入）。

    Returns:
        {"results": {path: payload}, "failed": {path: error_str}, "stopped": [path, ...]}
        stopped 为被停止（软放弃）而跳过分析的素材路径列表（路由据此回退 pending）。
    """
    paths = [str(p) for p in video_paths]
    total = len(paths)
    results: dict[str, dict] = {}
    failed: dict[str, str] = {}
    done = 0
    item_timeout = per_item_timeout if per_item_timeout and per_item_timeout > 0 else _SINGLE_ITEM_TIMEOUT_SEC

    def _report(path: str, status: str) -> None:
        nonlocal done
        done += 1
        if progress_cb is not None:
            try:
                progress_cb(done, total, path, status)
            except Exception as e:  # 回调异常绝不能打断分析主流程
                logger.warning(f"[CONCURRENT] progress_cb 异常（已忽略）: {e}")

    workers = max_workers if max_workers else _DEFAULT_MAX_WORKERS
    workers = max(1, int(workers))
    analyze_fn = _analyze_fn or _default_analyze
    limiter = _DynamicLimiter(workers, _throttle_window)

    # ── 1) 全部素材快哈希（并发 to_thread，避免慢盘阻塞事件循环）──
    hash_list = await asyncio.gather(
        *(asyncio.to_thread(fast_file_hash, p) for p in paths),
        return_exceptions=True,
    )

    # ── 2) 查缓存；未命中按哈希分组（同哈希只分析一次）──
    by_hash: dict[str, list[str]] = {}
    for p, h in zip(paths, hash_list):
        if isinstance(h, Exception):
            failed[p] = f"快哈希失败: {h}"
            _report(p, "failed")
            continue
        cached = await asyncio.to_thread(analysis_cache.get_cached_analysis, h)
        if cached is not None:
            payload = dict(cached)
            payload["cached"] = True
            payload["file_hash"] = h
            payload.pop("_partial", None)  # 旧版本若误存 partial 标记则剔除
            payload["frames"] = await _ensure_frames(p, payload)
            results[p] = payload
            _report(p, "cached")
        else:
            by_hash.setdefault(h, []).append(p)

    # ── 3) 并发分析所有未命中哈希 ──
    async def _work(file_hash: str, group_paths: list[str]) -> None:
        primary = group_paths[0]  # 同哈希文件内容相同，用第一条做实际分析
        # 循环：拿槽 → 检查控制（停止即退出；暂停则让出槽并轻量轮询等待恢复）→ 分析
        # 关键：控制检查放在「拿到槽之后」，确保 gather 提前排队的任务也能被暂停/停止
        # （若放在拿槽前，排队任务早已进入 limiter 等待，永远不会再走到检查点）。
        while True:
            await limiter.acquire()
            if control is not None and control.stopped:
                await limiter.release()
                control.stopped_paths.extend(group_paths)
                return
            if control is not None and control.paused:
                await limiter.release()
                # 跨事件循环安全：纯布尔 + 轻量轮询，不用 asyncio.Event
                while control.paused and not control.stopped:
                    await asyncio.sleep(0.05)
                if control.stopped:
                    control.stopped_paths.extend(group_paths)
                    return
                continue  # 恢复后重新拿槽
            # 已持槽且未被暂停/停止 → 真正分析（限流槽由本协程持有，覆盖整段分析+重试）
            try:
                payload = await asyncio.wait_for(
                    _analyze_with_retry(
                        primary, file_hash, analyze_fn, api_key, model, limiter,
                        backoff_base=_backoff_base,
                    ),
                    timeout=item_timeout,
                )
            except asyncio.TimeoutError:
                # F4：单条超时 → 释放槽位并标失败，不连累其他素材（孤儿 to_thread 抽帧会在后台自行结束）
                await limiter.release()
                err = f"单条分析超时（>{item_timeout:.0f}s），已跳过"
                logger.warning(f"[CONCURRENT] 分析超时: {primary}: {err}")
                for p in group_paths:
                    failed[p] = err
                    _report(p, "failed")
                return
            except Exception as e:
                await limiter.release()
                err = str(e)
                logger.warning(f"[CONCURRENT] 分析失败: {primary}: {err}")
                for p in group_paths:
                    failed[p] = err
                    _report(p, "failed")
                return
            await limiter.release()
            partial = bool(payload.pop("_partial", False))
            status = "partial" if partial else "analyzed"
            for p in group_paths:
                results[p] = dict(payload)
                _report(p, status)
            return

    await asyncio.gather(*(_work(h, g) for h, g in by_hash.items()))

    logger.info(
        f"[CONCURRENT] 批量分析完成: 共 {total} 条，"
        f"成功 {len(results)}（缓存 {sum(1 for r in results.values() if r.get('cached'))}），"
        f"失败 {len(failed)}，停止 {len(control.stopped_paths) if control else 0}，"
        f"许可 {limiter.current_limit}/{workers}"
    )
    return {
        "results": results,
        "failed": failed,
        "stopped": list(control.stopped_paths) if control else [],
    }


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    import tempfile
    import time

    print("=== concurrent_analyzer 自测 ===")
    tmp_dir = tempfile.mkdtemp(prefix="ca_test_")

    # 造 4 个内容不同的假素材 + 1 个与 a 完全相同的副本（验证 O4 同哈希去重）
    def _mk(name: str, content: bytes) -> str:
        p = os.path.join(tmp_dir, name)
        with open(p, "wb") as f:
            f.write(content)
        return p

    pa = _mk("a.mp4", os.urandom(64 * 1024))
    pb = _mk("b.mp4", os.urandom(64 * 1024))
    prl = _mk("rl.mp4", os.urandom(64 * 1024))
    pbad = _mk("bad.mp4", os.urandom(64 * 1024))
    pa2 = _mk("a_copy.mp4", open(pa, "rb").read())  # 与 a 同内容

    # ── 假分析函数：rl 前 2 次返回 429 失败描述串，bad 抛非 429 异常 ──
    calls: dict[str, int] = {}

    async def fake_analyze(path: str, api_key: str, model: str = ""):
        calls[path] = calls.get(path, 0) + 1
        await asyncio.sleep(0.01)  # 模拟 IO
        if os.path.basename(path) == "bad.mp4":
            raise ValueError("场景检测失败(模拟普通错误)")
        if os.path.basename(path) == "rl.mp4" and calls[path] <= 2:
            # 模拟现有链路把 429 吞进描述串的形态（与 ai_service 一致）
            return (
                [{"index": 0, "start": 0.0, "end": 2.0, "duration": 2.0}],
                ["[分析失败] Vision API call failed after retries: Vision API error (429): Too Many Requests"],
                [],
            )
        return (
            [{"index": 0, "start": 0.0, "end": 2.0, "duration": 2.0}],
            [f"画面描述-{os.path.basename(path)}"],
            [],
        )

    events: list = []

    def cb(done, total, path, status):
        events.append((done, total, os.path.basename(path), status))

    # 用独立临时缓存目录，不污染真实缓存。
    # 注意：本文件以 `python services/concurrent_analyzer.py` 运行时模块名是 __main__，
    # 上面的业务函数引用的是 __main__ 的全局命名空间 —— 必须 patch globals()，
    # 若 `import services.concurrent_analyzer` 再 patch 会生成第二个模块实例而失效。
    from services.analysis_cache import AnalysisCache
    test_cache = AnalysisCache(os.path.join(tmp_dir, "cache"))
    orig_cache = globals()["analysis_cache"]
    globals()["analysis_cache"] = test_cache
    try:
        # ── 第一轮：混合场景 ──
        t0 = time.perf_counter()
        out = asyncio.run(analyze_materials_concurrently(
            [pa, pb, prl, pbad, pa2], "fake-key",
            progress_cb=cb,
            max_workers=3,
            _analyze_fn=fake_analyze,
            _throttle_window=0.2,
            _backoff_base=0.01,  # 测试提速，生产默认 2s/4s/8s
        ))
        cost = time.perf_counter() - t0
        res, failed = out["results"], out["failed"]

        assert pa in res and pb in res and prl in res and pa2 in res, f"结果缺失: {list(res)}"
        assert pbad in failed and "模拟普通错误" in failed[pbad], "bad 应失败且错误透传"
        assert calls[pa] == 1 and calls[pb] == 1, "正常素材只分析一次"
        assert calls[prl] == 3, f"rl 应重试到第 3 次成功，实际 {calls[prl]} 次"
        assert calls.get(pa2, 0) == 0, "同哈希副本不应触发分析（O4 去重）"
        assert res[pa2]["descriptions"] == res[pa]["descriptions"], "副本复用同一份结果"
        assert res[pa]["cached"] is False and res[prl]["cached"] is False
        assert res[pa]["duration"] == 2.0
        assert len(events) == 5 and events[-1][0] == 5 and events[-1][1] == 5, "进度回调计数错误"
        statuses = {e[3] for e in events}
        assert statuses == {"analyzed", "failed"}, f"状态异常: {statuses}"
        s = test_cache.stats()
        assert s["entries"] == 3, f"应缓存 a/b/rl 三条，实际 {s}"
        print(f"[OK] 第一轮: 4 成功(1条429重试2次后成功) + 1 失败 + 同哈希去重，耗时 {cost:.2f}s")

        # ── 第二轮：全部命中缓存，零分析调用 ──
        calls.clear()
        events.clear()
        out2 = asyncio.run(analyze_materials_concurrently(
            [pa, pb, prl, pa2], "fake-key",
            progress_cb=cb, max_workers=3,
            _analyze_fn=fake_analyze, _throttle_window=0.2, _backoff_base=0.01,
        ))
        assert not calls, f"第二轮不应有任何分析调用: {calls}"
        assert len(out2["results"]) == 4 and not out2["failed"]
        assert all(r["cached"] is True for r in out2["results"].values()), "第二轮必须 cached: true"
        assert {e[3] for e in events} == {"cached"}
        s2 = test_cache.stats()
        assert s2["total_hits"] == 4, f"第二轮应 4 次命中，实际 {s2}"
        print(f"[OK] 第二轮: 4/4 缓存命中，零分析调用，stats={s2}")

        # ── 429 耗尽重试 → 记入 failed ──
        async def always_429(path, api_key, model=""):
            return (
                [{"index": 0, "start": 0.0, "end": 1.0, "duration": 1.0}],
                ["[分析失败] Vision API error (429): rate limit exceeded"],
                [],
            )
        prl2 = _mk("rl2.mp4", os.urandom(64 * 1024))
        out3 = asyncio.run(analyze_materials_concurrently(
            [prl2], "k", _analyze_fn=always_429,
            _throttle_window=0.2, _backoff_base=0.01,
        ))
        assert prl2 in out3["failed"] and "429" in out3["failed"][prl2], "持续429应进 failed"
        print(f"[OK] 持续 429 → 重试耗尽后入 failed: {out3['failed'][prl2][:60]}...")

        # ── 动态许可：throttle 减半 + 窗口后恢复 ──
        async def _limiter_test():
            lim = _DynamicLimiter(2, throttle_window=0.2)
            await lim.acquire()
            await lim.acquire()
            assert lim.current_limit == 2
            lim.throttle()
            assert lim.current_limit == 1, "429 后许可应减半"
            await lim.release()  # inflight 1，仍占满减半后的许可
            try:
                await asyncio.wait_for(lim.acquire(), timeout=0.05)
                raise AssertionError("减半后第 2 个并发应被阻塞")
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(0.25)  # 等恢复窗口
            assert lim.current_limit == 2, "窗口后许可应恢复基准"
            await lim.acquire()  # 恢复后可继续获取
            await lim.release()
            await lim.release()
        asyncio.run(_limiter_test())
        print("[OK] 动态许可: 429 减半 → 阻塞超额并发 → 窗口后自动恢复")

        # ── 控制：软暂停 / 继续 / 停止 ──
        # 注意：asyncio.Event 绑定事件循环，control 必须在「与分析同一事件循环」内创建，
        # 故这里用 asyncio.create_task 在 _control_test 自己的循环里启动分析（而非子线程另起 loop）。
        async def _control_test():
            slow_calls: dict[str, int] = {}

            async def slow_analyze(path, api_key, model=""):
                slow_calls[path] = slow_calls.get(path, 0) + 1
                await asyncio.sleep(0.05)
                return (
                    [{"index": 0, "start": 0.0, "end": 1.0, "duration": 1.0}],
                    [f"描述-{os.path.basename(path)}"],
                    [],
                )

            paths_c = [os.path.join(tmp_dir, f"ctl_{i}.mp4") for i in range(12)]
            for p in paths_c:
                open(p, "wb").write(os.urandom(16 * 1024))

            # 暂停 / 继续
            ctl = create_control("ctl_pause")
            task = asyncio.create_task(analyze_materials_concurrently(
                paths_c, "k", control=ctl, max_workers=3,
                _analyze_fn=slow_analyze, _backoff_base=0.01,
            ))
            await asyncio.sleep(0.12)  # 让 3 路 in-flight 跑着，其余排队
            ctl.pause()
            await asyncio.sleep(0.15)
            assert len(ctl.stopped_paths) == 0, "暂停不应停止任何任务"
            ctl.resume()
            out_p = await task
            assert len(ctl.stopped_paths) == 0, "继续后不应有停止任务"
            assert len(out_p["results"]) == 12, f"继续后 12 条应全部完成，实际 {len(out_p['results'])}"
            print("[OK] 软暂停/继续: 暂停时排队等待、进行中跑完，继续后全部完成")
            clear_control("ctl_pause")

            # 停止（用全新文件，避免被上一轮缓存命中导致无任务可停）
            paths_c2 = [os.path.join(tmp_dir, f"ctl2_{i}.mp4") for i in range(12)]
            for p in paths_c2:
                open(p, "wb").write(os.urandom(16 * 1024))
            ctl2 = create_control("ctl_stop")
            task2 = asyncio.create_task(analyze_materials_concurrently(
                paths_c2, "k", control=ctl2, max_workers=3,
                _analyze_fn=slow_analyze, _backoff_base=0.01,
            ))
            await asyncio.sleep(0.12)
            ctl2.pause()
            await asyncio.sleep(0.15)
            ctl2.stop()  # 唤醒等待中的暂停任务
            out_s = await task2
            assert len(ctl2.stopped_paths) > 0, "停止应收集被停的任务"
            assert len(out_s["stopped"]) == len(ctl2.stopped_paths), "返回 stopped 应与 control 一致"
            print(f"[OK] 停止: {len(ctl2.stopped_paths)} 条被停止（回退待分析），进行中已完成")
            clear_control("ctl_stop")

        asyncio.run(_control_test())

        # ── F4 单条硬超时：卡死素材应被跳过，其余正常完成且槽位释放 ──
        async def _timeout_test():
            fast_paths = [os.path.join(tmp_dir, f"to_fast_{i}.mp4") for i in range(6)]
            stuck_path = os.path.join(tmp_dir, "to_stuck.mp4")
            for p in fast_paths + [stuck_path]:
                open(p, "wb").write(os.urandom(16 * 1024))

            async def to_analyze(path, api_key, model=""):
                await asyncio.sleep(0.02)  # 正常快
                if os.path.basename(path) == "to_stuck.mp4":
                    await asyncio.sleep(5.0)  # 模拟视觉 API 挂起 / 抽帧卡死
                return (
                    [{"index": 0, "start": 0.0, "end": 1.0, "duration": 1.0}],
                    [f"描述-{os.path.basename(path)}"],
                    [],
                )

            # 单条超时设很小(0.1s)，让 stuck 必被掐断；并发=2 确保 stuck 占住一槽时另一槽仍可用
            out_t = await analyze_materials_concurrently(
                fast_paths + [stuck_path], "k", max_workers=2,
                _analyze_fn=to_analyze, _backoff_base=0.01,
                per_item_timeout=0.1,
            )
            assert stuck_path in out_t["failed"], "卡死素材应进入 failed"
            assert "超时" in out_t["failed"][stuck_path], f"失败原因应含超时: {out_t['failed'][stuck_path]}"
            assert len(out_t["results"]) == len(fast_paths), "其余 6 条应正常完成"
            print(f"[OK] F4 单条超时: 卡死 1 条被跳过，其余 {len(out_t['results'])} 条正常完成，槽位已释放")
        asyncio.run(_timeout_test())
    finally:
        globals()["analysis_cache"] = orig_cache

    print("=== 全部自测通过 ===")
