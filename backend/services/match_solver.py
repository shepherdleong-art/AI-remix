"""
约束感知求解器：音频优先混合匹配（Audio-First Match）核心。

纯标准库实现，**零第三方依赖**（不引入 numpy/scipy）。求解器在语义匹配优先的
前提下，用**全局最优分配（带权最小费用流）**最大化减少素材重复率。

设计要点（见 docs/design-match-audio-first.md）：
1. 时长唯一基准为 ``seg_durations``，由构造保证 ``Σduration == Σseg_durations``。
2. 硬约束：① 分配素材 ``available >= duration[i]``；② ``start + duration <= source_duration``。
3. **全局最优去重**：建模为最小费用流，成本 = ``-语义分 + λ×该视频已用次数``
   （视频节点用「副本边」实现递增加价：第 1 次 0、第 2 次 +λ、第 3 次 +2λ…），
   一次性求出整条时间线全局最优。素材足够时零重复；不足时最少重复且公平轮转。
4. **语义地板（保证语义）**：单段语义分低于
   ``max(绝对地板, 红线, 最佳分×(1-相对窗口))`` 的素材被打重罚（_BIG），
   仅在无任何可接受候选时才勉强使用（并标记 backoff），绝不为主动去重牺牲语义。
5. Hook-first：开场段（segment_index==0）在语义可接受集合内优先选钩子分高的素材
   （偏好但不强压，集合外/无合格高分自动回退）。
6. 某句在长度 + 语义地板双重约束下无候选 → 放宽取长度可行内最高分；若连长度都
   无可行候选 → 标记 ``feasible=False`` 并记入 ``backoff_segments``。
"""
from __future__ import annotations

import heapq
import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# 低于语义地板的素材代价：有限大（保证流仍可行），远高于任何语义/重复权衡，
# 使地板外素材只在「无其他可选」时被勉强使用，且仍优先选地板内最高分者。
_BIG = 1_000.0
# 初始势（Johnson 修正）：保证所有约化边权非负（seg→scene 的 -eff 可能为负）。
_POT_INIT = 2.0


@dataclass
class SceneCandidate:
    """求解器使用的单个素材候选（由 scenes 派生）。"""

    scene_index: int
    video_path: str
    start: float
    end: float
    available: float  # = end - start，硬约束①用
    video_id: str  # 覆盖惩罚聚合键（源视频路径，同一素材多次出现算同一视频）

    @property
    def source_duration(self) -> float:
        """用于边界硬校验②的可选终点（scene.end）。"""
        return self.end


# ──────────────────────────────────────────────────────────
# 最小费用最大流（Successive Shortest Path + 势（Johnson））
# 纯标准库实现，节点数/边数在「几十段 × 上百素材」规模下 trivial。
# ──────────────────────────────────────────────────────────
class _MinCostFlow:
    def __init__(self, n: int) -> None:
        self.n = n
        self.graph: list[list["_MCEdge"]] = [[] for _ in range(n)]
        self.pot: list[float] = [0.0] * n

    def add_edge(self, fr: int, to: int, cap: int, cost: float) -> None:
        forward = _MCEdge(to, cap, cost, len(self.graph[to]))
        backward = _MCEdge(fr, 0, -cost, len(self.graph[fr]))
        self.graph[fr].append(forward)
        self.graph[to].append(backward)

    def flow(self, s: int, t: int, maxf: int) -> tuple[int, float]:
        """返回 (实际流量, 总费用)。使用带势 Dijkstra。"""
        n = self.n
        pot = self.pot
        prevv = [0] * n
        preve = [0] * n
        res_flow = 0
        res_cost = 0.0
        INF = float("inf")
        while res_flow < maxf:
            dist = [INF] * n
            dist[s] = 0.0
            pq: list[tuple[float, int]] = [(0.0, s)]
            while pq:
                d, u = heapq.heappop(pq)
                if d > dist[u]:
                    continue
                for ei, e in enumerate(self.graph[u]):
                    if e.cap > 0:
                        nd = d + e.cost + pot[u] - pot[e.to]
                        if nd < dist[e.to] - 1e-12:
                            dist[e.to] = nd
                            prevv[e.to] = u
                            preve[e.to] = ei
                            heapq.heappush(pq, (nd, e.to))
            if dist[t] == INF:
                break
            # 用本次约化最短路更新势，维持后续约化边权非负
            for v in range(n):
                if dist[v] < INF:
                    pot[v] += dist[v]
            # 本次增广流量
            f = maxf - res_flow
            v = t
            while v != s:
                e = self.graph[prevv[v]][preve[v]]
                f = min(f, e.cap)
                v = prevv[v]
            if f <= 0:
                break
            # 累加本次真实代价（用原始 cost，不含势）
            v = t
            path_cost = 0.0
            while v != s:
                e = self.graph[prevv[v]][preve[v]]
                path_cost += e.cost
                e.cap -= f
                self.graph[v][e.rev].cap += f
                v = prevv[v]
            res_flow += f
            res_cost += f * path_cost
        return res_flow, res_cost


class _MCEdge:
    __slots__ = ("to", "cap", "cost", "rev")

    def __init__(self, to: int, cap: int, cost: float, rev: int) -> None:
        self.to = to
        self.cap = cap
        self.cost = cost
        self.rev = rev


class MatchSolver:
    """约束感知求解器：全局最优分配（最小费用流）。"""

    def __init__(
        self,
        red_line: float = 0.35,
        coverage_penalty: float = 0.15,
        candidate_window: float = 0.10,
        min_segment_duration: float = 0.2,
        hook_weight: float = 0.2,
        semantic_floor_abs: float = 0.3,
        semantic_floor_rel: float = 0.15,
    ) -> None:
        self.red_line = float(red_line)
        # coverage_penalty 即去重强度 λ（重复一次惩罚的「语义分当量」）
        self.coverage_penalty = float(coverage_penalty)
        self.candidate_window = float(candidate_window)
        self.min_segment_duration = float(min_segment_duration)
        self.hook_weight = float(hook_weight)
        self.semantic_floor_abs = float(semantic_floor_abs)
        self.semantic_floor_rel = float(semantic_floor_rel)
        # 求解结果（供 debug 与测试读取）
        self.assignment: dict[int, int] = {}
        self.usage_count: dict[str, int] = {}
        self.feasible: bool = True
        self.backoff_segments: list[int] = []

    # ──────────────────────────────────────────────────────────
    # 主入口
    # ──────────────────────────────────────────────────────────
    def solve(
        self,
        seg_durations: list[float],
        scenes: list[dict],
        score_matrix: list[list[float]],
        beat_points: Optional[list[float]] = None,
        segment_texts: Optional[list[str]] = None,
        hook_scores: Optional[list[float]] = None,
    ) -> list[dict]:
        """求解并返回 timeline（每项含完整 Assignment 字段）。

        Args:
            seg_durations: 每句真实时长（来自 split-tts）。
            scenes: 素材场景列表，每项含 video_path/start/end/duration。
            score_matrix: 语义分矩阵 [n][m]，取值 0-1。
            beat_points: 可选，推荐切点（秒），用于节拍吸附。
            segment_texts: 可选，每句口播文本，写入 timeline.segment_text。
            hook_scores: 可选，长度 m，每素材「钩子吸引力」0-1。仅开场段生效。

        Returns:
            timeline: list[dict]，每个元素含
            segment_index/video_path/start_time/duration/source_duration/
            used_scene_index/reason/snapped_beat/segment_text。
        """
        n = len(seg_durations)
        m = len(scenes)

        if n == 0:
            self.assignment = {}
            self.usage_count = {}
            self.feasible = True
            self.backoff_segments = []
            return []
        if m == 0:
            self.assignment = {i: 0 for i in range(n)}
            self.usage_count = {}
            self.feasible = False
            self.backoff_segments = list(range(n))
            return [
                {
                    "segment_index": i,
                    "video_path": "",
                    "start_time": 0.0,
                    "duration": round(float(seg_durations[i]), 3),
                    "source_duration": 0.0,
                    "used_scene_index": 0,
                    "reason": "无可用素材",
                    "snapped_beat": None,
                    "segment_text": segment_texts[i] if segment_texts and i < len(segment_texts) else "",
                }
                for i in range(n)
            ]

        # 1) 构造候选 + 视频索引
        candidates = self._build_candidates(scenes)
        video_index: dict[str, int] = {}
        for c in candidates:
            if c.video_id not in video_index:
                video_index[c.video_id] = len(video_index)
        V = len(video_index)

        # 2) 规整矩阵 + 钩子分
        score_matrix = self._normalize_matrix(score_matrix, n, m)
        hook = [
            float(hook_scores[j]) if (hook_scores and j < len(hook_scores)) else 0.0
            for j in range(m)
        ]
        has_hook = any(hook) > 0

        # 3) 有效分（开场段叠加钩子偏置）
        eff: list[list[float]] = []
        for i in range(n):
            opening = (i == 0) and has_hook
            row = score_matrix[i] if i < len(score_matrix) else [0.0] * m
            if opening:
                eff.append([row[j] + self.hook_weight * hook[j] for j in range(m)])
            else:
                eff.append(list(row))

        # 4) 长度可行性 + 每句语义地板
        eps = 1e-6
        length_feasible: list[list[bool]] = []
        floor_i: list[float] = []
        for i in range(n):
            dur = float(seg_durations[i])
            lf = [False] * m
            best_eff = 0.0
            for j in range(m):
                c = candidates[j]
                ok = c.available >= dur - eps and c.start + dur <= c.end + eps
                lf[j] = ok
                if ok and eff[i][j] > best_eff:
                    best_eff = eff[i][j]
            length_feasible.append(lf)
            # 语义地板：绝对地板 / 红线 / 相对窗口，取最大
            rel_floor = best_eff * (1.0 - self.semantic_floor_rel) if best_eff > 0 else 0.0
            floor_i.append(max(self.semantic_floor_abs, self.red_line, rel_floor))

        # 5) 建图：最小费用流
        S = 0
        seg_base = 1
        scene_base = seg_base + n
        video_base = scene_base + m
        T = video_base + V
        N = T + 1
        mcf = _MinCostFlow(N)
        mcf.pot = [0.0] * N
        mcf.pot[S] = _POT_INIT
        for i in range(n):
            mcf.pot[seg_base + i] = _POT_INIT

        for i in range(n):
            mcf.add_edge(S, seg_base + i, 1, 0.0)
            for j in range(m):
                if not length_feasible[i][j]:
                    continue
                # 地板内：成本 = -有效分（越语义越好）；地板外：重罚但仍可选最高分者
                if eff[i][j] >= floor_i[i] - eps:
                    cost = -eff[i][j]
                else:
                    cost = _BIG - eff[i][j]
                mcf.add_edge(seg_base + i, scene_base + j, 1, cost)

        for j in range(m):
            v = video_index[candidates[j].video_id]
            mcf.add_edge(scene_base + j, video_base + v, 1, 0.0)
        # 视频 → T：副本边递增加价（第 k 次使用成本 λ*(k-1)）。
        # 副本数取 n（段数上限即可）；每视频实际可用次数由其 scene 节点容量
        # （= 该视频素材数）自然限制，不会超过素材数。
        for v in range(V):
            for k in range(1, n + 1):
                mcf.add_edge(video_base + v, T, 1, self.coverage_penalty * (k - 1))

        sent, _ = mcf.flow(S, T, n)

        # 6) 提取分配
        assignment: dict[int, int] = {}
        usage_count: dict[str, int] = {}
        feasible = True
        backoff: list[int] = []

        for i in range(n):
            u = seg_base + i
            chosen = -1
            for e in mcf.graph[u]:
                # 流量已发出的边 cap==0，且目标为 scene 节点
                if e.cap == 0 and scene_base <= e.to < scene_base + m:
                    chosen = e.to - scene_base
                    break
            if chosen < 0:
                # 无长度可行候选 → 局部回退：取「有效分 − λ×已用次数」最高的素材
                # （忽略长度，但仍尽量摊开重复，避免全堆在同一素材）。
                best_j = max(
                    range(m),
                    key=lambda jj: eff[i][jj] - self.coverage_penalty * usage_count.get(candidates[jj].video_id, 0),
                )
                chosen = best_j
                feasible = False
                if i not in backoff:
                    backoff.append(i)
            c = candidates[chosen]
            vid = c.video_id
            usage_count[vid] = usage_count.get(vid, 0) + 1
            # 选中的素材低于语义地板 → 标记为放宽（保证语义的兜底）
            if eff[i][chosen] < floor_i[i] - eps:
                if i not in backoff:
                    backoff.append(i)
            assignment[i] = chosen

        # 7) 节拍吸附（仅移动切点，Σduration 不变）
        durations = [float(d) for d in seg_durations]
        snapped: dict[int, float] = {}
        if beat_points:
            durations, snapped = self._snap_beats(durations, assignment, candidates, beat_points)

        # 8) 组装 timeline（按原始段序）
        timeline = []
        for i in range(n):
            j = assignment.get(i, 0)
            c = candidates[j]
            d = durations[i]
            if c.start + d > c.end + 1e-6:
                d = max(self.min_segment_duration, c.end - c.start)
                feasible = False
                if i not in backoff:
                    backoff.append(i)
            below_floor = eff[i][j] < floor_i[i] - eps
            reason = self._build_reason(i, c, score_matrix, usage_count, j, below_floor)
            timeline.append({
                "segment_index": i,
                "video_path": c.video_path,
                "start_time": round(float(c.start), 3),
                "duration": round(float(d), 3),
                "source_duration": round(float(c.end), 3),
                "used_scene_index": j,
                "reason": reason,
                "snapped_beat": round(float(snapped[i]), 3) if i in snapped else None,
                "segment_text": (segment_texts[i] if segment_texts and i < len(segment_texts) else ""),
            })

        # 9) 不变量校验
        inv_feasible, inv_assignment, inv_usage = self._validate_invariants(timeline, seg_durations)
        self.assignment = inv_assignment
        self.usage_count = inv_usage
        self.feasible = feasible and inv_feasible
        self.backoff_segments = backoff
        return timeline

    # ──────────────────────────────────────────────────────────
    # 内部：候选构造 / 吸附 / 校验
    # ──────────────────────────────────────────────────────────
    def _build_candidates(self, scenes: list[dict]) -> list[SceneCandidate]:
        candidates: list[SceneCandidate] = []
        for j, sc in enumerate(scenes):
            start = float(sc.get("start", 0.0))
            end = float(sc.get("end", sc.get("duration", start + 5.0)))
            available = float(sc.get("duration", end - start))
            if available <= 0:
                available = max(0.0, end - start)
            video_path = sc.get("video_path", "")
            candidates.append(SceneCandidate(
                scene_index=j,
                video_path=video_path,
                start=start,
                end=end,
                available=available,
                video_id=video_path,
            ))
        return candidates

    def _snap_beats(self, durations, assignment, candidates, beat_points):
        """节拍吸附：把相邻段的切点等量反向移动，使其靠近最近气口。

        仅当偏移 ≤ 0.2s 且两段在新时长下仍满足各自素材边界时生效。
        关键：第 i 段 +Δ、第 i+1 段 -Δ，Σduration 不变。
        """
        snapped: dict[int, float] = {}
        if not beat_points:
            return durations, snapped
        n = len(durations)
        beats = sorted(beat_points)
        used_cuts: set[int] = set()

        for b in beats:
            cuts = []
            acc = 0.0
            for i in range(n):
                acc += durations[i]
                cuts.append(acc)
            best_i = min(range(n), key=lambda i: abs(cuts[i] - b))
            delta = b - cuts[best_i]
            if abs(delta) > 0.2 + 1e-9:
                continue
            if best_i in used_cuts:
                continue
            if best_i + 1 >= n:
                continue
            i0, i1 = best_i, best_i + 1
            new_d0 = durations[i0] + delta
            new_d1 = durations[i1] - delta
            c0 = candidates[assignment[i0]]
            c1 = candidates[assignment[i1]]
            if new_d0 < self.min_segment_duration or new_d1 < self.min_segment_duration:
                continue
            if new_d0 > c0.available + 1e-6 or c0.start + new_d0 > c0.end + 1e-6:
                continue
            if new_d1 > c1.available + 1e-6 or c1.start + new_d1 > c1.end + 1e-6:
                continue
            durations[i0] = new_d0
            durations[i1] = new_d1
            snapped[i0] = float(b)
            used_cuts.add(best_i)
        return durations, snapped

    def _validate_invariants(self, timeline, seg_durations):
        """断言不变量并返回 (feasible, assignment, usage_count)。"""
        total = sum(float(d) for d in seg_durations)
        computed = sum(float(t["duration"]) for t in timeline)
        feasible = abs(computed - total) < 1e-3  # 由 duration=seg_durations 构造保证
        for t in timeline:
            if float(t["start_time"]) + float(t["duration"]) > float(t["source_duration"]) + 1e-3:
                feasible = False
        assignment = {int(t["segment_index"]): int(t["used_scene_index"]) for t in timeline}
        usage_count: dict[str, int] = {}
        for t in timeline:
            vp = t["video_path"]
            usage_count[vp] = usage_count.get(vp, 0) + 1
        return feasible, assignment, usage_count

    def _build_reason(self, i, c, score_matrix, usage_count, pick, below_floor) -> str:
        row = score_matrix[i] if i < len(score_matrix) else []
        score = float(row[pick]) if pick < len(row) else 0.0
        best = max(row) if row else 0.0
        used = usage_count.get(c.video_id, 0)
        if below_floor:
            tag = "语义降级(兜底)"
        elif best - score > self.candidate_window + 1e-9:
            tag = "覆盖优先"
        else:
            tag = "语义首选"
        first = "首次使用" if used <= 1 else f"第{used}次使用"
        return f"score={score:.2f} {tag}({first})"

    @staticmethod
    def _normalize_matrix(matrix, n, m) -> list[list[float]]:
        """把任意形状的输入规整为 n×m 浮点矩阵（缺失补 0）。"""
        out: list[list[float]] = []
        for i in range(n):
            row = matrix[i] if i < len(matrix) else []
            new_row: list[float] = []
            for j in range(m):
                v = row[j] if j < len(row) else 0.0
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    v = 0.0
                new_row.append(max(0.0, min(1.0, v)))
            out.append(new_row)
        return out
