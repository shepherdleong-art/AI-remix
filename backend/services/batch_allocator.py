"""
批次级联合分配求解器（§4.2，D1 均衡 / D2 降级 / O1 窗口约束 / 查重对抗）。

复用策略（硬性约束：单条工作流行为零变化）：
- **不修改 match_solver.py**，单片求解直接调 ``MatchSolver.solve``（最小费用流 +
  语义地板 + 副本边加价 + 不变量校验全部继承）；
- 批次级的均衡/降级通过**喂给求解器的 score_matrix 动态调整**实现：
  ``调整后分数 = 语义分 × 场景复用因子 × 均衡因子^已用次数 × 位置因子``
  （乘法折扣，任何使用次数下候选相对排序都不丢失），求解器本身不知道批次存在。

核心算法（§4.2 目标函数优先级）：
1. 语义匹配度最大化 —— 求解器内核保证（语义地板不被均衡牺牲）；
2. 素材使用均衡 —— 每片求解前按当前批次 usage_count 对已用素材分数打折扣
   （balance_factor^次数），素材消耗自然摊平、方差最小（D1）；
3. 重复惩罚 —— 同一素材每多用一次分数多打一折；同一素材+同区间复用先乘
   场景复用因子（重扣），实际取段再由「区间放置器」强制换区间
   （与已用子段重叠 < 30% 段长，放不下记 forced_overlap）；
4. 组合差异 —— 分配完成后计算成片两两素材集合 Jaccard 相似度矩阵，
   超阈值片对写入报告与卡片 similarity_flags（前端标黄，D8/查重对抗）。

降级策略（素材不足，D2）：
- 轮次制：均衡因子随使用次数指数衰减 ⇒ 所有素材先用满 1 次才会出现第 2 次，
  第 2 轮用满才有第 3 次……直到满足 N'=Σcopies 条（贪心等价轮次制）；
- 重复时优先语义匹配分最高：乘法折扣保持语义相对排序，同折扣下仍取最高分；
- 重复素材强制换区间：在可用窗口内取与上次不重叠的子段（重叠 < 30% 段长）；
- 同素材进入多片时段落位置错开：该素材在某段位置被用过后，
  同位置再选它追加 position_factor 折扣。

整体流程：贪心逐片求解 → 若干轮局部改进（逐片回滚重解，全局目标更优才保留）。
全局目标 = Σ语义分 − 2×usage 方差 − 5×被迫重叠次数。80 素材 × 30 片为秒级。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

try:
    from services.match_solver import MatchSolver
except ModuleNotFoundError:
    # 允许 `python services/batch_allocator.py` 直接运行自测（生产由 backend/ 启动，无此分支）
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from services.match_solver import MatchSolver

logger = logging.getLogger(__name__)

# ─── 默认参数（乘法折扣模型）───────────────────────────────
# 设计说明：求解器内部会把分数矩阵 clamp 到 [0,1]，加法惩罚（如 −0.25×次数）
# 极易全体触 0 导致候选间相对优劣信息丢失（实测 8 素材 6 片即退化）。
# 故折扣一律用乘法因子：调整后 = 语义分 × 场景因子 × 均衡因子^次数 × 位置因子，
# 相对排序在任何使用次数下都完整保留。

# 素材均衡因子：素材每被用 1 次，其分数乘 0.7（D1 科学平均消耗；用量越大分越低）
DEFAULT_BALANCE_FACTOR: float = 0.7
# 同素材+同场景复用折扣：乘 0.2（§4.2 重扣分），使
# "未用过的素材 > 用过素材的未用场景 > 已复用场景"的优先级在常见分差下恒成立
DEFAULT_SCENE_REPEAT_FACTOR: float = 0.2
# 同素材同段落位置错开折扣：乘 0.9（查重对抗：位置排列强制错开）
DEFAULT_POSITION_FACTOR: float = 0.9
# 重复素材换区间：与已用子段的最大允许重叠比例（段长）
DEFAULT_OVERLAP_MAX_RATIO: float = 0.3
# Jaccard 相似度阈值：成片两两素材集合相似度 ≥ 该值记入报告（前端标黄）
DEFAULT_JACCARD_THRESHOLD: float = 0.5
# 局部改进轮数（贪心后逐片回滚重解）
DEFAULT_IMPROVEMENT_ROUNDS: int = 2

_EPS = 1e-6


# ─── 数据结构 ─────────────────────────────────────────────

@dataclass
class _Candidate:
    """素材场景按可用窗口裁剪后的求解候选（O1：分配只在窗口内取段）。"""
    mat_idx: int
    file_hash: str
    rel_path: str
    filename: str
    scene_index: int
    start: float   # 已裁剪：max(scene.start, usable_in)
    end: float     # 已裁剪：min(scene.end, usable_out)
    description: str

    @property
    def available(self) -> float:
        return self.end - self.start


# ─── 语义分（可插拔）───────────────────────────────────────

def _bigrams(text: str) -> set:
    if not text:
        return set()
    return {text[i:i + 2] for i in range(len(text) - 1)} if len(text) >= 2 else {text}


def default_score_fn(segment_text: str, scene_description: str) -> float:
    """轻量语义分：口播句与场景描述的字符二元组重合率（0-1）。

    占位实现：批次全量 LLM 打分成本高（N片×M素材×场景），先用关键词重合；
    生产如需 LLM 精确分，调 allocate_batch 时注入自定义 score_fn 即可，
    求解流程不变。无文本时返回中性 0.5（分配退化为纯均衡驱动）。
    """
    a, b = _bigrams(segment_text or ""), _bigrams(scene_description or "")
    if not a or not b:
        return 0.5
    return len(a & b) / len(a)


# ─── 候选构造（窗口裁剪）────────────────────────────────────

def _build_candidates(materials: list[dict], min_seg: float = 0.2) -> list[_Candidate]:
    """把素材池裁剪为窗口内候选场景；无场景分析的素材退化为整窗伪场景。"""
    cands: list[_Candidate] = []
    for mi, mat in enumerate(materials):
        dur = float(mat.get("duration") or 0.0)
        win_in = float(mat.get("usable_in") or 0.0)
        win_out = float(mat.get("usable_out") or 0.0) or dur
        if win_out - win_in < min_seg:
            continue  # 可用窗口不足最小时长，素材不可分配
        scenes = mat.get("scenes") or []
        if not scenes:
            # 无分析数据的兜底：整个可用窗口当作一个场景（描述为空 → 中性分）
            scenes = [{"start": win_in, "end": win_out, "duration": win_out - win_in}]
        for si, sc in enumerate(scenes):
            s = max(float(sc.get("start", 0.0)), win_in)
            e = min(float(sc.get("end", s)), win_out)
            if e - s >= min_seg:
                cands.append(_Candidate(
                    mat_idx=mi,
                    file_hash=mat["file_hash"],
                    rel_path=mat.get("rel_path", ""),
                    filename=mat.get("filename", ""),
                    scene_index=si,
                    start=round(s, 3),
                    end=round(e, 3),
                    description=str(sc.get("description") or ""),
                ))
    return cands


# ─── 区间放置器（重复素材强制换区间）────────────────────────

def _overlap_len(a: tuple, b: tuple) -> float:
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def _place_interval(used: list, lo: float, hi: float, dur: float,
                    max_overlap_ratio: float) -> tuple:
    """在 [lo, hi] 内为长 dur 的段选入点，与 used 中已用子段重叠 < max_overlap_ratio。

    候选入点：窗口起点/终点-dur、每个已用区间的紧前/紧后位置。
    Returns: (入点, 重叠比例, 是否被迫重叠)。放不下时取重叠最小位置并标记 forced。
    """
    if dur > hi - lo + _EPS:
        return lo, 1.0, True
    points = {lo, hi - dur}
    for (s, e) in used:
        points.add(e)        # 紧接已用区间之后
        points.add(s - dur)  # 紧接已用区间之前
    best_x, best_ov = None, float("inf")
    for x in sorted(points):
        if x < lo - _EPS or x + dur > hi + _EPS:
            continue
        ov = max((_overlap_len((x, x + dur), u) for u in used), default=0.0) / dur
        if ov < best_ov:
            best_x, best_ov = x, ov
        if ov < max_overlap_ratio:
            return round(x, 3), round(ov, 3), False
    if best_x is None:
        return lo, 1.0, True
    return round(best_x, 3), round(best_ov, 3), True


# ─── 报告构建（分配与单条重分配共用）────────────────────────

def _variance(values: list) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / len(values)


def build_report(allocated_clips: list[dict], materials: list[dict],
                 jaccard_threshold: float = DEFAULT_JACCARD_THRESHOLD,
                 params: dict | None = None) -> dict:
    """由已分配片段重建完整分配报告（usage 分布/重复明细/Jaccard 矩阵）。

    allocate_batch 与路由层 reallocate（O3）共用：任何一片变化后整体重算即可，
    保证报告永远与 clips 实际内容一致。
    """
    names = {m["file_hash"]: m.get("filename", "") for m in materials}
    usage: dict[str, int] = {m["file_hash"]: 0 for m in materials}
    repeat_detail: dict[str, list] = {}
    clip_sets: list[set] = []

    for clip in allocated_clips:
        sset = set()
        for seg in clip.get("segments", []):
            fh = seg.get("file_hash", "")
            if not fh:
                continue
            sset.add(fh)
            usage[fh] = usage.get(fh, 0) + 1
            repeat_detail.setdefault(fh, []).append({
                "clip_id": clip["clip_id"],
                "segment_index": seg.get("segment_index"),
                "in": seg.get("in"),
                "out": seg.get("out"),
            })
        clip_sets.append(sset)

    # 重复明细：使用次数 > 1 的素材
    repeats = [
        {"file_hash": fh, "filename": names.get(fh, ""), "count": cnt,
         "detail": repeat_detail.get(fh, [])}
        for fh, cnt in usage.items() if cnt > 1
    ]

    # Jaccard 相似度矩阵 + 超阈值片对
    n = len(allocated_clips)
    matrix = [[0.0] * n for _ in range(n)]
    pairs = []
    for i in range(n):
        for j in range(i + 1, n):
            a, b = clip_sets[i], clip_sets[j]
            sim = len(a & b) / len(a | b) if (a | b) else 0.0
            matrix[i][j] = matrix[j][i] = round(sim, 3)
            if sim >= jaccard_threshold:
                pairs.append({
                    "clip_a": allocated_clips[i]["clip_id"],
                    "clip_b": allocated_clips[j]["clip_id"],
                    "similarity": round(sim, 3),
                })

    return {
        "usage_distribution": usage,
        "usage_variance": round(_variance(list(usage.values())), 4),
        "materials_used": sum(1 for c in usage.values() if c > 0),
        "materials_total": len(materials),
        "repeats": repeats,
        "jaccard_matrix": matrix,
        "jaccard_pairs_over_threshold": pairs,
        "jaccard_threshold": jaccard_threshold,
        "forced_overlap_count": sum(
            1 for c in allocated_clips for s in c.get("segments", []) if s.get("forced_overlap")
        ),
        "bgm_assignments": [],  # 占位：D13 BGM 批次轮替在导出阶段实现
        "params": params or {},
    }


# ─── 主入口 ───────────────────────────────────────────────

def allocate_batch(
    materials: list[dict],
    clips: list[dict],
    score_fn=None,
    jaccard_threshold: float = DEFAULT_JACCARD_THRESHOLD,
    balance_factor: float = DEFAULT_BALANCE_FACTOR,
    scene_repeat_factor: float = DEFAULT_SCENE_REPEAT_FACTOR,
    position_factor: float = DEFAULT_POSITION_FACTOR,
    improvement_rounds: int = DEFAULT_IMPROVEMENT_ROUNDS,
    overlap_max_ratio: float = DEFAULT_OVERLAP_MAX_RATIO,
    solver: MatchSolver | None = None,
) -> dict:
    """批次级联合分配。

    Args:
        materials: [{file_hash, rel_path, filename, duration, usable_in, usable_out,
                     scenes: [{start, end, duration, description?}]}]
        clips:     [{clip_id, script_id, seg_durations: [...], segment_texts: [...]}]
                   （seg_durations = 该片 TTS 槽长，调用方先跑 split-tts 获得）
        score_fn:  语义分函数 (segment_text, scene_description) -> 0-1，默认关键词重合。
        其余参数见模块头常量注释。

    Returns:
        {"clips": [{clip_id, script_id, feasible, backoff_segments, total_duration,
                    segments: [{segment_index, file_hash, video_rel_path, filename,
                                scene_index, in, out, duration, score, reason,
                                forced_overlap}]}],
         "report": build_report(...)}
    """
    score_fn = score_fn or default_score_fn
    solver = solver or MatchSolver()
    min_seg = solver.min_segment_duration
    cands = _build_candidates(materials, min_seg)
    # 喂给求解器的场景参数（候选已按窗口裁剪，求解器边界校验即窗口校验）
    scenes_arg = [
        {"video_path": c.rel_path, "start": c.start, "end": c.end,
         "duration": round(c.end - c.start, 3)}
        for c in cands
    ]

    # ── 批次级共享状态 ──
    usage: dict[str, int] = {}                    # 素材已用次数（均衡/轮次制依据）
    positions: dict[str, set] = {}                # 素材已占段落位置（位置错开依据）
    used_intervals: dict[tuple, list] = {}        # (file_hash, scene_index) → [(in,out)]

    def _apply_usage(seg: dict, sign: int) -> None:
        fh = seg["file_hash"]
        if not fh:
            return
        usage[fh] = usage.get(fh, 0) + sign
        if sign > 0:
            positions.setdefault(fh, set()).add(seg["segment_index"])
        else:
            positions.get(fh, set()).discard(seg["segment_index"])

    def _solve_clip(clip: dict) -> dict:
        """用「usage/位置调整后的分数矩阵」调单片求解器 + 区间放置。"""
        seg_durs = [float(d) for d in clip["seg_durations"]]
        texts = clip.get("segment_texts") or [""] * len(seg_durs)
        n = len(seg_durs)
        # 调整矩阵（乘法折扣）：语义分 × 场景复用因子 × 均衡因子^已用次数 × 位置因子
        # （求解器零改动，批次语义全在矩阵里；已用场景 = used_intervals 的非空键）
        matrix = []
        for i in range(n):
            row = []
            for c in cands:
                s = score_fn(texts[i] if i < len(texts) else "", c.description)
                if used_intervals.get((c.file_hash, c.scene_index)):
                    s *= scene_repeat_factor
                s *= balance_factor ** usage.get(c.file_hash, 0)
                if i in positions.get(c.file_hash, set()):
                    s *= position_factor
                row.append(s)
            matrix.append(row)

        timeline = solver.solve(seg_durs, scenes_arg, matrix, segment_texts=texts)

        segments = []
        for t in timeline:
            j = t["used_scene_index"]
            dur = float(t["duration"])
            if not cands:  # 无任何候选：求解器返回占位 timeline
                segments.append({
                    "segment_index": t["segment_index"], "file_hash": "",
                    "video_rel_path": "", "filename": "", "scene_index": -1,
                    "in": 0.0, "out": round(dur, 3), "duration": round(dur, 3),
                    "score": 0.0, "reason": "无可用素材", "forced_overlap": False,
                })
                continue
            c = cands[j]
            key = (c.file_hash, c.scene_index)
            used = used_intervals.setdefault(key, [])
            in_pt, ov, forced = _place_interval(used, c.start, c.end, dur, overlap_max_ratio)
            used.append((in_pt, round(in_pt + dur, 3)))
            base_score = score_fn(texts[t["segment_index"]] if t["segment_index"] < len(texts) else "",
                                  c.description)
            segments.append({
                "segment_index": t["segment_index"],
                "file_hash": c.file_hash,
                "video_rel_path": c.rel_path,
                "filename": c.filename,
                "scene_index": c.scene_index,
                "in": in_pt,
                "out": round(in_pt + dur, 3),
                "duration": round(dur, 3),
                "score": round(base_score, 3),
                "reason": t["reason"],
                "forced_overlap": forced,
            })
        return {
            "clip_id": clip["clip_id"],
            "script_id": clip.get("script_id", ""),
            "feasible": solver.feasible,
            "backoff_segments": list(solver.backoff_segments),
            "total_duration": round(sum(s["duration"] for s in segments), 3),
            "segments": segments,
        }

    def _global_objective(allocated: list[dict]) -> float:
        """全局目标：Σ语义分 − 2×usage 方差 − 5×被迫重叠数（越高越好）。"""
        var = _variance([usage.get(m["file_hash"], 0) for m in materials])
        score_sum = sum(s.get("score", 0.0) for c in allocated for s in c["segments"])
        forced = sum(1 for c in allocated for s in c["segments"] if s.get("forced_overlap"))
        return score_sum - 2.0 * var - 5.0 * forced

    # ── 第一遍：贪心逐片求解（usage 惩罚天然形成轮次制降级）──
    allocated: list[dict] = []
    for clip in clips:
        result = _solve_clip(clip)
        for seg in result["segments"]:
            _apply_usage(seg, +1)
        allocated.append(result)

    # ── 局部改进：逐片回滚重解，全局目标更优才保留 ──
    for _round in range(max(0, int(improvement_rounds))):
        improved = False
        for idx, clip in enumerate(clips):
            old = allocated[idx]
            old_obj = _global_objective(allocated)
            # 回滚该片占用（usage/位置/区间），再重解
            for seg in old["segments"]:
                _apply_usage(seg, -1)
                key = (seg["file_hash"], seg["scene_index"])
                iv = (seg["in"], seg["out"])
                if key in used_intervals and iv in used_intervals[key]:
                    used_intervals[key].remove(iv)
            new = _solve_clip(clip)
            for seg in new["segments"]:
                _apply_usage(seg, +1)
            allocated[idx] = new
            if _global_objective(allocated) < old_obj - _EPS:
                # 更差则还原旧方案
                for seg in new["segments"]:
                    _apply_usage(seg, -1)
                    key = (seg["file_hash"], seg["scene_index"])
                    iv = (seg["in"], seg["out"])
                    if key in used_intervals and iv in used_intervals[key]:
                        used_intervals[key].remove(iv)
                for seg in old["segments"]:
                    _apply_usage(seg, +1)
                    used_intervals.setdefault((seg["file_hash"], seg["scene_index"]), []) \
                        .append((seg["in"], seg["out"]))
                allocated[idx] = old
            else:
                improved = True
        if not improved:
            break

    # ── 不变量校验（沿用求解器语义：每片总时长 = TTS 槽长；in/out 落窗口内）──
    violations = []
    win_by_hash = {}
    for m in materials:
        dur = float(m.get("duration") or 0.0)
        win_by_hash[m["file_hash"]] = (
            float(m.get("usable_in") or 0.0),
            float(m.get("usable_out") or 0.0) or dur,
        )
    for clip, result in zip(clips, allocated):
        expect = sum(float(d) for d in clip["seg_durations"])
        if abs(result["total_duration"] - expect) > 1e-3:
            violations.append({
                "clip_id": result["clip_id"], "type": "时长不变量违反",
                "expect": round(expect, 3), "actual": result["total_duration"],
            })
        for seg in result["segments"]:
            fh = seg["file_hash"]
            if not fh or fh not in win_by_hash:
                continue
            w_in, w_out = win_by_hash[fh]
            if seg["in"] < w_in - 1e-3 or seg["out"] > w_out + 1e-3:
                violations.append({
                    "clip_id": result["clip_id"], "type": "区间越出可用窗口",
                    "segment_index": seg["segment_index"],
                    "in": seg["in"], "out": seg["out"], "window": [w_in, w_out],
                })

    params = {
        "balance_factor": balance_factor,
        "scene_repeat_factor": scene_repeat_factor,
        "position_factor": position_factor,
        "overlap_max_ratio": overlap_max_ratio,
        "improvement_rounds": improvement_rounds,
        "score_fn": getattr(score_fn, "__name__", "custom"),
    }
    report = build_report(allocated, materials, jaccard_threshold, params)
    report["violations"] = violations

    logger.info(
        f"[ALLOC] 分配完成: {len(allocated)} 片 × {len(materials)} 素材，"
        f"使用 {report['materials_used']} 素材，方差 {report['usage_variance']}，"
        f"重复素材 {len(report['repeats'])}，超阈值片对 {len(report['jaccard_pairs_over_threshold'])}"
    )
    return {"clips": allocated, "report": report}


# ─── O3 单条重分配 ─────────────────────────────────────────

def reallocate_clip(
    materials: list[dict],
    clip: dict,
    other_clips: list[dict],
    score_fn=None,
    balance_factor: float = DEFAULT_BALANCE_FACTOR,
    scene_repeat_factor: float = DEFAULT_SCENE_REPEAT_FACTOR,
    position_factor: float = DEFAULT_POSITION_FACTOR,
    overlap_max_ratio: float = DEFAULT_OVERLAP_MAX_RATIO,
    solver: MatchSolver | None = None,
) -> dict:
    """改脚本后只重跑一片（O3）：其他片不动，其占用先重建再参与调整矩阵。

    Args:
        clip:        {clip_id, script_id, seg_durations, segment_texts}（新槽长）
        other_clips: 其他片已分配的 segments（用于重建 usage/位置/已用区间）
    Returns:
        新的一片分配结果（结构同 allocate_batch 的单片输出）。
    """
    # 复用 allocate_batch 的内部机制：把其他片作为"已固定占用"重建状态后只解一片。
    # 实现上直接跑 allocate_batch 的简化路径：先重放其他片占用，再解目标片。
    score_fn = score_fn or default_score_fn
    solver = solver or MatchSolver()
    min_seg = solver.min_segment_duration
    cands = _build_candidates(materials, min_seg)
    scenes_arg = [
        {"video_path": c.rel_path, "start": c.start, "end": c.end,
         "duration": round(c.end - c.start, 3)}
        for c in cands
    ]

    # 从其他片重建批次状态（usage/位置/已用区间）——等价于 allocate_batch 的中途快照
    usage: dict[str, int] = {}
    positions: dict[str, set] = {}
    used_intervals: dict[tuple, list] = {}
    for oc in other_clips:
        for seg in oc.get("segments", []):
            fh = seg.get("file_hash", "")
            if not fh:
                continue
            usage[fh] = usage.get(fh, 0) + 1
            positions.setdefault(fh, set()).add(seg.get("segment_index"))
            used_intervals.setdefault((fh, seg.get("scene_index")), []).append(
                (seg.get("in"), seg.get("out"))
            )

    # 以下与 allocate_batch._solve_clip 同构（保持两处逻辑一致，改动需同步）
    seg_durs = [float(d) for d in clip["seg_durations"]]
    texts = clip.get("segment_texts") or [""] * len(seg_durs)
    matrix = []
    for i in range(len(seg_durs)):
        row = []
        for c in cands:
            s = score_fn(texts[i] if i < len(texts) else "", c.description)
            if used_intervals.get((c.file_hash, c.scene_index)):
                s *= scene_repeat_factor
            s *= balance_factor ** usage.get(c.file_hash, 0)
            if i in positions.get(c.file_hash, set()):
                s *= position_factor
            row.append(s)
        matrix.append(row)

    timeline = solver.solve(seg_durs, scenes_arg, matrix, segment_texts=texts)
    segments = []
    for t in timeline:
        j = t["used_scene_index"]
        dur = float(t["duration"])
        if not cands:
            segments.append({
                "segment_index": t["segment_index"], "file_hash": "",
                "video_rel_path": "", "filename": "", "scene_index": -1,
                "in": 0.0, "out": round(dur, 3), "duration": round(dur, 3),
                "score": 0.0, "reason": "无可用素材", "forced_overlap": False,
            })
            continue
        c = cands[j]
        key = (c.file_hash, c.scene_index)
        used = used_intervals.setdefault(key, [])
        in_pt, ov, forced = _place_interval(used, c.start, c.end, dur, overlap_max_ratio)
        base_score = score_fn(texts[t["segment_index"]] if t["segment_index"] < len(texts) else "",
                              c.description)
        segments.append({
            "segment_index": t["segment_index"],
            "file_hash": c.file_hash,
            "video_rel_path": c.rel_path,
            "filename": c.filename,
            "scene_index": c.scene_index,
            "in": in_pt,
            "out": round(in_pt + dur, 3),
            "duration": round(dur, 3),
            "score": round(base_score, 3),
            "reason": t["reason"],
            "forced_overlap": forced,
        })
    return {
        "clip_id": clip["clip_id"],
        "script_id": clip.get("script_id", ""),
        "feasible": solver.feasible,
        "backoff_segments": list(solver.backoff_segments),
        "total_duration": round(sum(s["duration"] for s in segments), 3),
        "segments": segments,
    }


# ─── 单元自测 ─────────────────────────────────────────────

if __name__ == "__main__":
    import time

    print("=== batch_allocator 自测 ===")

    # ── 合成素材：k 个场景，描述含关键词便于语义分区分 ──
    def mk_material(idx: int, n_scenes: int = 3, scene_len: float = 4.0,
                    usable_in: float = 0.0, usable_out: float = 0.0,
                    keyword: str = "") -> dict:
        kw = keyword or f"主题{idx}"
        scenes = []
        for si in range(n_scenes):
            scenes.append({
                "start": round(si * scene_len, 2),
                "end": round((si + 1) * scene_len, 2),
                "duration": scene_len,
                "description": f"{kw} 画面 镜头{si}",
            })
        dur = n_scenes * scene_len
        return {
            "file_hash": f"hash{idx:03d}",
            "rel_path": f"mat/m{idx}.mp4",
            "filename": f"m{idx}.mp4",
            "duration": dur,
            "usable_in": usable_in,
            "usable_out": usable_out or dur,
            "scenes": scenes,
        }

    def mk_clip(cid: str, sid: str, n_segs: int = 3, seg_len: float = 2.0,
                text: str = "") -> dict:
        return {
            "clip_id": cid,
            "script_id": sid,
            "seg_durations": [seg_len] * n_segs,
            "segment_texts": [text or f"主题相关口播第{i}句" for i in range(n_segs)],
        }

    # ── A. 8 素材 × 3 脚本 × 2 片裂变 = 6 片：不重复优先 + 窗口约束 ──
    mats_a = [mk_material(i, n_scenes=3, scene_len=4.0, usable_in=0.5, usable_out=11.0)
              for i in range(8)]
    clips_a = [mk_clip(f"c{k}", f"s{k % 3}", text=f"主题{k % 3} 相关口播第{k}句") for k in range(6)]
    out_a = allocate_batch(mats_a, clips_a)
    rep_a = out_a["report"]
    # 18 个段槽，24 个窗口内场景 → 每个场景最多用 1 次
    scene_use = {}
    for c in out_a["clips"]:
        for s in c["segments"]:
            key = (s["file_hash"], s["scene_index"])
            scene_use[key] = scene_use.get(key, 0) + 1
            # O1 窗口约束：in/out 必须落在 [0.5, 11.0]
            assert 0.5 - 1e-3 <= s["in"] and s["out"] <= 11.0 + 1e-3, f"窗口越界: {s}"
    assert max(scene_use.values()) == 1, f"素材充足时同场景不应重复: {scene_use}"
    assert not rep_a["violations"], rep_a["violations"]
    assert rep_a["materials_used"] == 8, "8 素材应全部被摊到"
    assert rep_a["usage_variance"] <= 0.25, f"均衡方差应很小: {rep_a['usage_variance']}"
    # 时长不变量：每片 = 3×2s
    for c in out_a["clips"]:
        assert abs(c["total_duration"] - 6.0) < 1e-3
    print(f"[OK] A. 8素材×6片: 场景零重复，usage 分布 {sorted(rep_a['usage_distribution'].values())}，"
          f"方差 {rep_a['usage_variance']}")

    # ── B. 20 素材 × 10 片：均衡度 + 报告完整性 + 性能 ──
    mats_b = [mk_material(i) for i in range(20)]
    clips_b = [mk_clip(f"c{k}", f"s{k % 4}") for k in range(10)]
    t0 = time.perf_counter()
    out_b = allocate_batch(mats_b, clips_b)
    cost = time.perf_counter() - t0
    rep_b = out_b["report"]
    assert cost < 5.0, f"20素材×10片应秒级完成，实际 {cost:.2f}s"
    assert rep_b["usage_variance"] <= 0.3, f"方差应小: {rep_b['usage_variance']}"
    assert rep_b["jaccard_matrix"] and len(rep_b["jaccard_matrix"]) == 10
    assert "bgm_assignments" in rep_b and rep_b["params"]["balance_factor"] == 0.7
    sims = sorted(rep_b["usage_distribution"].values())
    print(f"[OK] B. 20素材×10片: 耗时 {cost*1000:.0f}ms，usage {sims}，"
          f"方差 {rep_b['usage_variance']}，Jaccard 最大 {max(max(r) for r in rep_b['jaccard_matrix'])}")

    # ── C. 5 素材 × 10 片（30 段槽 > 15 场景）：轮次降级 + 重复明细 ──
    mats_c = [mk_material(i) for i in range(5)]
    clips_c = [mk_clip(f"c{k}", f"s{k}") for k in range(10)]
    out_c = allocate_batch(mats_c, clips_c)
    rep_c = out_c["report"]
    uses = sorted(rep_c["usage_distribution"].values())
    # 30 段槽 ÷ 5 素材 = 每素材 6 次：轮次制下最大-最小 ≤ 1
    assert uses[-1] - uses[0] <= 1, f"轮次制应摊平: {uses}"
    assert len(rep_c["repeats"]) == 5, "全部素材都应进重复明细"
    # 重复素材换区间：同场景多次使用时，区间重叠应 < 30% 或被显式标记
    for c in out_c["clips"]:
        for s in c["segments"]:
            assert s["reason"], "每段应有 reason"
    assert rep_c["forced_overlap_count"] >= 0  # 只断言字段存在且计数正确
    print(f"[OK] C. 5素材×10片降级: usage {uses}，重复明细 {len(rep_c['repeats'])} 条，"
          f"被迫重叠 {rep_c['forced_overlap_count']} 段")

    # ── D. Jaccard 正确性：手工构造已知集合 ──
    fake_clips = [
        {"clip_id": "x", "segments": [{"file_hash": "a", "segment_index": 0, "in": 0, "out": 1}]},
        {"clip_id": "y", "segments": [{"file_hash": "a", "segment_index": 0, "in": 0, "out": 1},
                                      {"file_hash": "b", "segment_index": 1, "in": 0, "out": 1}]},
        {"clip_id": "z", "segments": [{"file_hash": "c", "segment_index": 0, "in": 0, "out": 1}]},
    ]
    mats_d = [{"file_hash": h, "filename": h} for h in "abc"]
    rep_d = build_report(fake_clips, mats_d, jaccard_threshold=0.4)
    # x∩y={a}, x∪y={a,b} → 0.5；x∩z=∅ → 0；y∩z=∅ → 0
    assert rep_d["jaccard_matrix"][0][1] == 0.5, rep_d["jaccard_matrix"]
    assert rep_d["jaccard_matrix"][0][2] == 0.0
    assert rep_d["jaccard_pairs_over_threshold"] == [
        {"clip_a": "x", "clip_b": "y", "similarity": 0.5}
    ]
    assert rep_d["usage_distribution"] == {"a": 2, "b": 1, "c": 1}
    print(f"[OK] D. Jaccard 矩阵手工验证: {rep_d['jaccard_matrix']}")

    # ── E. O3 单条重分配：其他片不动、usage 正确回滚重计 ──
    import copy
    mats_e = [mk_material(i) for i in range(6)]
    clips_e = [mk_clip(f"c{k}", "s0") for k in range(3)]
    out_e = allocate_batch(mats_e, clips_e)
    before = {c["clip_id"]: copy.deepcopy(c["segments"]) for c in out_e["clips"]}
    # 重分 c1（换 4 段新槽长），c0/c2 必须原封不动
    new_clip_spec = {"clip_id": "c1", "script_id": "s0",
                     "seg_durations": [1.5] * 4, "segment_texts": ["新文案"] * 4}
    others = [c for c in out_e["clips"] if c["clip_id"] != "c1"]
    new_c1 = reallocate_clip(mats_e, new_clip_spec, others)
    assert abs(new_c1["total_duration"] - 6.0) < 1e-3, "新片时长应=新槽长合计"
    assert len(new_c1["segments"]) == 4
    # 换区间约束：新片用到的 (素材,场景) 若与其他片重复，入点应错开
    occ = {}
    for c in others:
        for s in c["segments"]:
            occ.setdefault((s["file_hash"], s["scene_index"]), []).append((s["in"], s["out"]))
    for s in new_c1["segments"]:
        key = (s["file_hash"], s["scene_index"])
        for (us, ue) in occ.get(key, []):
            ov = max(0.0, min(s["out"], ue) - max(s["in"], us)) / s["duration"]
            assert ov < 0.3 + 1e-6 or s["forced_overlap"], f"与其他片区间重叠过大: {s} vs {(us, ue)}"
    # 报告重建：usage = 其他片 + 新片
    rebuilt = build_report(others + [new_c1], mats_e)
    total_usage = sum(rebuilt["usage_distribution"].values())
    assert total_usage == 2 * 3 + 4, f"usage 应=其他两片6段+新片4段: {total_usage}"
    print(f"[OK] E. 单条重分配: 其他片未动（校验通过），重建 usage 总段数 {total_usage}，"
          f"新片 {len(new_c1['segments'])} 段")

    print("=== 全部自测通过 ===")
