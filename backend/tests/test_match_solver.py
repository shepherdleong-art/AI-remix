#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
match_solver.py 单元测试（纯函数，可直接 import 跑，也可用 pytest 收集）。

覆盖 4 个核心场景（见 docs/design-match-audio-first.md §T1）：
1. 正常分配：Σduration == Σseg_durations 且每段 start+duration ≤ source_duration。
2. 素材不够长：某句无长度可行候选 → 局部回退，feasible=False 且记入 backoff_segments。
3. 低于红线：所有候选均低于 red_line 时，取最高分候选，绝不强制错配到低分候选。
4. 节拍吸附：仅移动切点，Σduration 不变，且相邻段仍满足素材边界。

运行（managed Python）：
    C:/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pytest backend/tests/test_match_solver.py -q
或直接：
    python backend/tests/test_match_solver.py
"""
import os
import sys

# 让 config / services 可被 import（backend 目录加入 sys.path）
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.match_solver import MatchSolver  # noqa: E402


def _scenes(n, available=5.0, start=0.0, video_paths=None):
    """构造 n 个候选场景，每个可用长度 available。"""
    scenes = []
    for j in range(n):
        vp = (video_paths[j] if video_paths else f"D:/m/{j}.mp4")
        scenes.append({
            "video_path": vp,
            "start": float(start),
            "end": float(start + available),
            "duration": float(available),
        })
    return scenes


def test_normal_assignment_sum_and_bounds():
    """场景1：正常分配满足不变量 Σ==D 且不越界。"""
    seg_durations = [3.0, 2.0, 4.0]
    total = sum(seg_durations)
    scenes = _scenes(4, available=5.0)
    # 构造一个明显区分的语义分矩阵，确保分配确定性
    score = [
        [0.9, 0.2, 0.3, 0.1],
        [0.1, 0.8, 0.2, 0.3],
        [0.2, 0.1, 0.85, 0.4],
    ]
    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 长度一致
    assert len(timeline) == len(seg_durations)
    # Σduration == Σseg_durations
    computed = sum(t["duration"] for t in timeline)
    assert abs(computed - total) < 1e-6, f"Σduration={computed} != D={total}"
    # 每段不越界：start + duration <= source_duration
    for t in timeline:
        assert t["start_time"] + t["duration"] <= t["source_duration"] + 1e-6
    # 求解器报告可行
    assert solver.feasible is True
    # 每段都分配到了一个合法候选
    for t in timeline:
        assert 0 <= t["used_scene_index"] < len(scenes)


def test_local_backoff_when_material_too_short():
    """场景2：某句素材不够长 → 局部回退，feasible=False，记入 backoff_segments。"""
    # 第 0 句长达 10s，但所有候选最多 5s → 无长度可行候选
    seg_durations = [10.0, 2.0, 3.0]
    scenes = _scenes(3, available=5.0)
    score = [
        [0.9, 0.2, 0.1],
        [0.1, 0.8, 0.2],
        [0.2, 0.1, 0.85],
    ]
    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 仍返回完整 timeline（不崩）
    assert len(timeline) == 3
    # 该句被标记为局部回退
    assert 0 in solver.backoff_segments
    # 整体不可行（长度无法满足）
    assert solver.feasible is False
    # Σ 在时间轴上仍等于 D（求解器内部用真实时长构造，钳制在 timeline 中体现）
    # 注：timeline 中越界段被钳制，故 Σ(timeline) 可能 < D，这是不可行的体现
    assert any(t["segment_index"] == 0 for t in timeline)


def test_below_red_line_no_forced_mismatch():
    """场景3：所有候选低于红线 → 取最高分候选，绝不强制错配到低分候选。"""
    seg_durations = [2.0]
    scenes = _scenes(3, available=5.0)
    # 全部低于红线 0.35
    score = [[0.10, 0.20, 0.05]]
    solver = MatchSolver(red_line=0.35)
    timeline = solver.solve(seg_durations, scenes, score)

    assert len(timeline) == 1
    # 必须命中最高分候选（index=1, score=0.20），而非低分 0.05
    assert timeline[0]["used_scene_index"] == 1
    assert timeline[0]["duration"] == 2.0
    # 该句因整体低于红线被放宽（relaxed）-> 记入 backoff
    assert 0 in solver.backoff_segments
    # 长度可行，故时长层面仍可行（红线城市不强制错配，但无法避免低分）
    # feasible 反映长度可行（True），backoff 反映红线放宽
    assert solver.feasible is True


def test_beat_snap_preserves_total_duration():
    """场景4：节拍吸附仅移动切点，Σduration 不变，且相邻段满足边界。"""
    seg_durations = [3.0, 3.0, 3.0]
    total = sum(seg_durations)
    scenes = _scenes(3, available=5.0)
    score = [
        [0.9, 0.2, 0.1],
        [0.1, 0.9, 0.2],
        [0.2, 0.1, 0.9],
    ]
    # 切点原本在 3.0 / 6.0 / 9.0；给一个靠近 3.0 的节拍 3.1（偏移 0.1 ≤ 0.2）
    beat_points = [3.1]
    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score, beat_points=beat_points)

    computed = sum(t["duration"] for t in timeline)
    assert abs(computed - total) < 1e-6, f"节拍吸附后 Σduration={computed} != D={total}"
    # 每段不越界
    for t in timeline:
        assert t["start_time"] + t["duration"] <= t["source_duration"] + 1e-6
    # 至少有一个切点被吸附（snapped_beat 非空）
    snapped = [t for t in timeline if t.get("snapped_beat") is not None]
    assert len(snapped) >= 1
    assert solver.feasible is True


def test_beat_snap_no_beat_points_keeps_durations():
    """补充：无 beat_points 时，每段 duration 严格等于 seg_durations。"""
    seg_durations = [2.5, 1.5, 3.5]
    scenes = _scenes(3, available=5.0)
    score = [
        [0.9, 0.2, 0.1],
        [0.1, 0.9, 0.2],
        [0.2, 0.1, 0.9],
    ]
    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score, beat_points=None)
    for i, t in enumerate(timeline):
        assert abs(t["duration"] - seg_durations[i]) < 1e-6


if __name__ == "__main__":
    # 无 pytest 时也可直接运行
    tests = [
        test_normal_assignment_sum_and_bounds,
        test_local_backoff_when_material_too_short,
        test_below_red_line_no_forced_mismatch,
        test_beat_snap_preserves_total_duration,
        test_beat_snap_no_beat_points_keeps_durations,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"[PASS] {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"[FAIL] {fn.__name__}: {e}")
    if failed:
        print(f"\n{failed} 个测试失败")
        sys.exit(1)
    print("\n全部 match_solver 测试通过")
