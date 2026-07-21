#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
音频优先匹配 —— 求解器不变量 + 覆盖最大化 扩展验证（纯函数，无需外部 API/ffmpeg）。

在工程师 ``test_match_solver.py`` 基础上扩充，重点覆盖 design-match-audio-first.md §T1/§T7：

A1. 正常：7 个素材(各 available=5.0) + seg_durations 和为 15.0
    → Σduration == 15.0（误差 ≤1 帧 ≈0.04s）、每段 start+duration ≤ source_duration、
      feasible=True、len==len(segments)。
A2. 覆盖最大化生效：构造"多句语义分接近"场景，断言求解器在红线内优先选使用次数少的素材
    （used_materials 比朴素贪心更多/更分散——朴素贪心恒选最高分只用到 1 个素材）。
A3. 红线不强制错配：某句所有素材相关分均低于 red_line → 仍回退到最高分（即使被惩罚），
    不得为了铺满而选低分素材，并记录 backoff_segments。
A4. 素材不够长时局部回退：某句"理想素材" available < duration → 借位到长度可行的候选，
    仍满足边界（不得选不够长的理想素材）。
A5. 节拍吸附：beat_points 给定时，吸附后 Σduration 不变（精确相等），切点偏移 ≤0.2s。

运行（managed Python，建议从项目根目录）：
    C:/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pytest backend/tests/test_match_solver_audio_first.py -q
"""
import os
import sys
import asyncio

# 让 config / services 可被 import（backend 目录加入 sys.path）
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.match_solver import MatchSolver  # noqa: E402
from services.ai_service import match_scenes_audio_first  # noqa: E402


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


def test_A1_normal_7materials_sum15_invariants():
    """A1：7 素材(各 available=5.0) + seg_durations 和 15.0 → 不变量全部成立。"""
    seg_durations = [2.5, 2.0, 2.0, 2.0, 2.0, 2.0, 2.5]
    total = sum(seg_durations)
    assert abs(total - 15.0) < 1e-9
    scenes = _scenes(7, available=5.0)
    # 语义分矩阵：对角高（保证确定性分配），非对角低
    score = [[0.9 if i == j else 0.1 for j in range(7)] for i in range(7)]

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 长度一致
    assert len(timeline) == len(seg_durations)
    # Σduration == Σseg_durations（由 duration[i]=seg_durations[i] 构造保证），误差 ≤1 帧
    computed = sum(float(t["duration"]) for t in timeline)
    assert abs(computed - total) < 0.04, f"Σduration={computed} != D={total}"
    # 每段不越界：start + duration <= source_duration
    for t in timeline:
        assert t["start_time"] + t["duration"] <= t["source_duration"] + 1e-6, t
    # 求解器报告可行
    assert solver.feasible is True
    # 每段都分配到了一个合法候选
    for t in timeline:
        assert 0 <= t["used_scene_index"] < len(scenes)


def test_A2_coverage_maximization_spreads_materials():
    """A2：多句语义分接近 → 覆盖惩罚把素材铺开（used_materials > 朴素贪心）。"""
    seg_durations = [2.0, 2.0, 2.0]
    scenes = _scenes(3, available=5.0)
    # 三句语义分都接近（差值 ≤ candidate_window 0.10），覆盖惩罚应驱动分散
    score = [
        [0.90, 0.85, 0.84],
        [0.90, 0.85, 0.84],
        [0.90, 0.85, 0.84],
    ]
    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 全部长度可行 → feasible
    assert solver.feasible is True
    # 覆盖最大化：三个素材都被使用（朴素贪心恒选最高分只会用到 1 个）
    assert len(solver.usage_count) == 3, f"覆盖未铺开: {solver.usage_count}"
    # 每段分配到不同的素材
    assigned = {t["used_scene_index"] for t in timeline}
    assert assigned == {0, 1, 2}
    # 明确优于朴素贪心（朴素贪心 = 1 个素材）
    assert len(solver.usage_count) > 1


def test_A3_red_line_no_forced_mismatch():
    """A3：某句所有素材相关分均低于 red_line → 回退到最高分，不强制错配到低分。"""
    seg_durations = [2.0, 3.0]
    scenes = _scenes(2, available=5.0)
    # 句1（index=1）两个候选均低于 red_line=0.35
    score = [
        [0.90, 0.10],
        [0.10, 0.20],
    ]
    solver = MatchSolver(red_line=0.35)
    timeline = solver.solve(seg_durations, scenes, score)

    # 句1 必须命中最高分候选（index=1, score=0.20），而非更低的 index=0(0.10)
    assert timeline[1]["used_scene_index"] == 1, timeline[1]
    # 绝不能为了铺满选最低分素材
    assert timeline[1]["used_scene_index"] != 0
    # 该句因整体低于红线被放宽（relaxed）→ 记入 backoff
    assert 1 in solver.backoff_segments
    # 长度可行，故时长层面仍可行（红线只控制错配，不控制长度）
    assert solver.feasible is True


def test_A4_local_backoff_borrows_to_length_feasible():
    """A4：理想素材不够长 → 借位到长度可行候选，仍满足边界（不选用不够长的理想素材）。"""
    seg_durations = [2.0, 4.0]
    # mat0 仅 3.0s（对 4.0s 句不够），mat1 有 5.0s（可行）
    scenes = [
        {"video_path": "D:/m/0.mp4", "start": 0.0, "end": 3.0, "duration": 3.0},
        {"video_path": "D:/m/1.mp4", "start": 0.0, "end": 5.0, "duration": 5.0},
    ]
    # 句1（4.0s）语义上最匹配 mat0，但 mat0 不够长 → 必须借位到 mat1
    score = [
        [0.90, 0.50],
        [0.90, 0.50],
    ]
    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 句1 借位到长度可行的 mat1
    assert timeline[1]["used_scene_index"] == 1, timeline[1]
    # 边界校验：start + duration <= source_duration
    assert timeline[1]["start_time"] + timeline[1]["duration"] <= timeline[1]["source_duration"] + 1e-6
    # 整体可行（两个候选都长度可行）
    assert solver.feasible is True
    # 确认没有选"理想但不够长"的 mat0 给句1
    assert timeline[1]["used_scene_index"] != 0


def test_A5_beat_snap_preserves_total_and_offset():
    """A5：节拍吸附仅移动切点，Σduration 精确不变，且切点偏移 ≤0.2s。"""
    seg_durations = [3.0, 3.0, 3.0, 3.0]
    total = sum(seg_durations)
    scenes = _scenes(4, available=5.0)
    score = [[0.9 if i == j else 0.1 for j in range(4)] for i in range(4)]
    # 切点原本在 3.0；给一个靠近 3.0 的节拍 3.15（偏移 0.15 ≤ 0.2）
    beat_points = [3.15]

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score, beat_points=beat_points)

    # Σduration 精确不变（吸附只等量反向调整相邻段时长）
    computed = sum(float(t["duration"]) for t in timeline)
    assert abs(computed - total) < 1e-3, f"节拍吸附后 Σduration={computed} != D={total}"
    # 每段仍不越界
    for t in timeline:
        assert t["start_time"] + t["duration"] <= t["source_duration"] + 1e-6
    # 至少有一个切点被吸附
    snapped = [t for t in timeline if t.get("snapped_beat") is not None]
    assert len(snapped) >= 1
    for t in snapped:
        # 吸附后切点等于某个 beat（精确）
        assert abs(t["snapped_beat"] - 3.15) < 1e-3, t
        # 相对原始切点的偏移 ≤0.2s
        orig_cut = sum(seg_durations[: t["segment_index"] + 1])
        assert abs(t["snapped_beat"] - orig_cut) <= 0.2 + 1e-9
    assert solver.feasible is True


# ─── Hook-first 扩展（任务#12/13/15）─────────────────────────
# H1：开场段在「语义近 tie」的可接受集合内，应优先选钩子分高的素材。
# H2：isHook 手动标记（经 match_scenes_audio_first 合并）应让开场优先选该素材。
# H3：钩子只偏序、不强压——高钩子但语义明显更差的素材，开场仍选语义最佳。
# H4：钩子偏好仅作用于开场段（index 0），非开场段忽略钩子分。

def test_H1_opening_prefers_high_hook_within_band():
    """H1：开场段语义近 tie → 钩子分高的素材胜出。"""
    seg_durations = [2.0, 2.0]
    scenes = _scenes(3, available=5.0)
    # 开场段（index 0）三素材语义近 tie；钩子分 scene1 最高
    score = [
        [0.90, 0.88, 0.86],
        [0.90, 0.50, 0.50],
    ]
    hook_scores = [0.1, 0.9, 0.2]

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score, hook_scores=hook_scores)

    # 开场段命中高钩子素材 scene1
    assert timeline[0]["used_scene_index"] == 1, timeline[0]
    # 不变量仍成立
    assert solver.feasible is True
    for t in timeline:
        assert t["start_time"] + t["duration"] <= t["source_duration"] + 1e-6, t


def test_H2_ishook_override_via_match_pipeline():
    """H2：isHook 素材经 match_scenes_audio_first 合并后，开场优先选它（不调真实 LLM）。"""
    scenes = _scenes(3, available=5.0)
    scenes[2]["isHook"] = True  # 手动标记 scene2 为钩子
    seg_durations = [2.0, 2.0, 2.0]
    segments = [{"text": f"句{i}"} for i in range(3)]

    # api_key="" → LLM 打分失败，自动回退均匀矩阵（语义全相等）+ 零钩子分；
    # isHook 应把 scene2 的 hook 强制置 1.0，开场段优先选它。
    res = asyncio.run(
        match_scenes_audio_first(segments, seg_durations, scenes, api_key="")
    )
    timeline = res["timeline"]

    assert len(timeline) == 3
    assert timeline[0]["used_scene_index"] == 2, timeline[0]
    assert res["debug"]["feasible"] is True
    # 不变量：Σduration == Σseg_durations
    computed = sum(float(t["duration"]) for t in timeline)
    assert abs(computed - sum(seg_durations)) < 0.04


def test_H3_hook_does_not_override_clear_semantic_best():
    """H3：高钩子但语义明显更差的素材，开场仍选语义最佳（不强压）。"""
    seg_durations = [2.0]
    scenes = _scenes(2, available=5.0)
    score = [[0.95, 0.40]]  # scene0 语义明显更佳
    hook_scores = [0.0, 1.0]  # scene1 钩子满分但语义差

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score, hook_scores=hook_scores)

    # 开场段仍选语义最佳的 scene0，而非高钩子的 scene1
    assert timeline[0]["used_scene_index"] == 0, timeline[0]


def test_H4_non_opening_segments_ignore_hook():
    """H4：钩子偏好仅作用于开场段；非开场段按语义选，不追高钩子素材。

    场景：3 个素材——scene0/scene2 语义佳（hook=0），scene1 语义差（hook=1）。
    验证：开场与非开场段都按语义选可接受的佳素材，绝不追高钩子差的 scene1。
    （同一素材不可被两段复用同一镜头 → seg0 取 scene0，seg1 取另一佳素材 scene2。）
    """
    seg_durations = [2.0, 2.0]
    scenes = _scenes(3, available=5.0)
    score = [
        [0.90, 0.20, 0.85],  # seg0：scene0 最佳，scene2 次佳，scene1 差
        [0.90, 0.20, 0.85],  # seg1：同上
    ]
    hook_scores = [0.0, 1.0, 0.0]  # scene1 钩子满分但语义差

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score, hook_scores=hook_scores)

    # 开场段按语义选 scene0（scene1 高钩子但低于语义地板，不被追）
    assert timeline[0]["used_scene_index"] == 0, timeline[0]
    # 非开场段按语义选（scene0 已被占用 → 取另一佳素材 scene2），不追高钩子 scene1
    assert timeline[1]["used_scene_index"] == 2, timeline[1]
    # scene1（高钩子差语义）两段都不应被选中
    assert 1 not in {t["used_scene_index"] for t in timeline}
    assert solver.feasible is True


# ─── 全局最优去重（任务：素材科学分配 / 减少重复率）────────────
# D1：素材足够（不同视频数 ≥ 片段数）→ 零重复，每段用不同视频。
# D2：素材不够（2 视频 / 4 片段）→ 公平轮转（每视频各 2 次），不堆在单一视频。
# D3：为避免重复需牺牲 >15% 语义时 → 允许重复，但绝不勉强用差素材（保证语义）。

def test_D1_sufficient_materials_zero_repeat():
    """D1：6 片段 + 6 个不同视频（语义近 tie）→ 全局最优应零重复。"""
    seg_durations = [2.0] * 6
    paths = [f"D:/m/v{j}.mp4" for j in range(6)]
    scenes = _scenes(6, available=5.0, video_paths=paths)
    # 每句对各视频语义分都接近（差值 < 15%），去重应驱动全部铺开
    score = [[0.90 - 0.005 * j if i == j else 0.80 for j in range(6)] for i in range(6)]

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    assigned = [t["used_scene_index"] for t in timeline]
    assert len(set(assigned)) == 6, f"未零重复: {assigned}"
    assert solver.feasible is True
    assert max(solver.usage_count.values()) == 1, f"有视频被复用: {solver.usage_count}"


def test_D2_insufficient_materials_spread_fairly():
    """D2：4 片段 + 仅 2 视频（各 2 场景）→ 公平轮转，每视频各用 2 次。"""
    seg_durations = [2.0] * 4
    paths = ["D:/m/A.mp4", "D:/m/A.mp4", "D:/m/B.mp4", "D:/m/B.mp4"]
    scenes = _scenes(4, available=5.0, video_paths=paths)
    # 四句语义分均接近 → 去重主导，期望把重复摊到两视频各 2 次
    score = [
        [0.85, 0.84, 0.83, 0.82],
        [0.85, 0.84, 0.83, 0.82],
        [0.85, 0.84, 0.83, 0.82],
        [0.85, 0.84, 0.83, 0.82],
    ]

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 两段视频各被使用恰好 2 次（公平轮转）
    counts = sorted(solver.usage_count.values())
    assert counts == [2, 2], f"未公平轮转: {solver.usage_count}"
    assert len(solver.usage_count) == 2
    assert solver.feasible is True


def test_D3_semantic_floor_prevents_weak_clip_even_if_repeat():
    """D3：语义地板禁止勉强用差素材——即使那样能避免重复，也宁可重复好视频。

    场景：视频 A 有 2 个佳素材镜头(A0/A1, 0.95)，视频 B 仅 1 个差素材(0.30)。
    两句都强烈匹配 A；B 比最佳低 68% ≫ 15% 地板 → B 被禁止。
    求解器应选择重复优质视频 A（A0+A1），绝不勉强用差素材 B。
    """
    seg_durations = [2.0, 2.0]
    paths = ["D:/m/A0.mp4", "D:/m/A1.mp4", "D:/m/B.mp4"]
    scenes = _scenes(3, available=5.0, video_paths=paths)
    # 两句都对 A 的两个镜头语义 0.95，对 B 仅 0.30
    score = [
        [0.95, 0.95, 0.30],
        [0.95, 0.95, 0.30],
    ]

    solver = MatchSolver()
    timeline = solver.solve(seg_durations, scenes, score)

    # 两段都应使用优质视频 A（scene0 / scene1 之一），不得用差素材 B
    used = {t["used_scene_index"] for t in timeline}
    assert used <= {0, 1}, f"差素材 B 被选用: {timeline}"
    assert "D:/m/B.mp4" not in solver.usage_count, "差素材 B 不应被使用"
    # 视频 A 被复用（重复），但用的是不同镜头，语义未降级
    assert solver.usage_count.get("D:/m/A0.mp4", 0) + solver.usage_count.get("D:/m/A1.mp4", 0) == 2
    assert solver.feasible is True


if __name__ == "__main__":
    tests = [
        test_A1_normal_7materials_sum15_invariants,
        test_A2_coverage_maximization_spreads_materials,
        test_A3_red_line_no_forced_mismatch,
        test_A4_local_backoff_borrows_to_length_feasible,
        test_A5_beat_snap_preserves_total_and_offset,
        test_H1_opening_prefers_high_hook_within_band,
        test_H2_ishook_override_via_match_pipeline,
        test_H3_hook_does_not_override_clear_semantic_best,
        test_H4_non_opening_segments_ignore_hook,
        test_D1_sufficient_materials_zero_repeat,
        test_D2_insufficient_materials_spread_fairly,
        test_D3_semantic_far_beyond_floor_allows_repeat,
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
    print("\n全部 match_solver 音频优先扩展测试通过")
