#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
音频优先匹配 —— 真实 ffmpeg 端到端验证（关键，必须真跑）。

按 design-match-audio-first.md §T7 的 B 项：

1. 用 ffmpeg 造 7 个 5 秒合成测试片段（hue 着色区分，每段 testsrc 动画 → 可辨帧）。
2. 对 7 个片段跑 detect_scenes 得到 scenes（每段约 5s）。
3. 自行构造 seg_durations（7 段合计 15.0s，模拟 TTS 输出；不真调 TTS API），
   直接调用 match_scenes_audio_first(segments, seg_durations, scenes, beat_points=None)
   得到 timeline。断言不变量（同 A1）。
4. 用 ffmpeg 造一段时长 == 15.0s 的合成音频（正弦），调用
   composite_clip(timeline, audio_path, out, 1080, 1920, None) 真实合成。
5. 检测输出视频：
   ① get_audio_duration 确认输出视频时长 == 15.0s（误差 ≤0.1s）；
   ② 结尾无冻结：采样输出视频末尾连续帧（13.0/14.0/14.5/14.8s），
      证明末尾不是同一帧死定格（末段为动画内容，冻结则全部相同）。
6. 对照实验（control）：构造"2s 素材 + 4s 音频"的溢出段，调用 composite_clip，
   证明本测试的检测方法能抓到结尾冻结（输出 4s 且末段死定格），
   从而证明上面的"无冻结"判定是真实有效的，而非检测手段失效。

全程真实调用 ffmpeg（含 composite_clip 内部 _ffmpeg），不使用 monkeypatch 伪造命令行。

运行（managed Python，从项目根目录）：
    C:/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pytest backend/tests/test_match_audio_first_e2e.py -q
"""
import os
import sys
import asyncio
import hashlib
import subprocess
import tempfile

# 让 config / services 可被 import；必须在 import backend 模块前设置 ffmpeg 路径
os.environ.setdefault(
    "FFMPEG_PATH", r"D:\AI混剪工具测试\ffmpeg-master-latest-win64-gpl\bin\ffmpeg.exe"
)
_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.video_service import (  # noqa: E402
    _ffmpeg,
    detect_scenes,
    composite_clip,
    get_audio_duration,
)
from services.ai_service import match_scenes_audio_first  # noqa: E402

FF = _ffmpeg()


def _gen_clip(path, dur=5, hue=0):
    """造一段 moving 测试片段（testsrc 动画 + hue 着色区分）。"""
    spec = f"testsrc=size=360x640:rate=30:duration={dur},hue=h={hue}"
    r = subprocess.run(
        [FF, "-f", "lavfi", "-i", spec, "-c:v", "libx264",
         "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", path],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"生成片段失败: {r.stderr[-200:]}"


def _gen_audio(path, dur):
    """造一段时长 dur 秒的合成正弦音频（mp3 / libmp3lame）。"""
    r = subprocess.run(
        [FF, "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
         "-c:a", "libmp3lame", "-q:a", "2", "-y", path],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"生成音频失败: {r.stderr[-200:]}"


def _frame_sig(path, t):
    """取 t 秒处原始帧的 MD5（空输出表示越界，视为独特值）。"""
    rr = subprocess.run(
        [FF, "-i", path, "-ss", str(t), "-vframes", "1",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, timeout=60,
    )
    if not rr.stdout:
        return f"EMPTY@{t}"
    return hashlib.md5(rr.stdout).hexdigest()


def test_audio_first_e2e_duration_equals_audio_and_no_end_freeze():
    """B：音频优先匹配 + 真实合成 → 输出时长==音频且结尾无冻结。"""
    tmp = tempfile.mkdtemp(prefix="e2e_audio_first_")
    try:
        # 1) 造 7 个 5s 片段（hue 区分）
        clips = []
        for i in range(7):
            p = os.path.join(tmp, f"mat_{i}.mp4")
            _gen_clip(p, dur=5, hue=i * 40)
            clips.append(p)

        # 2) detect_scenes 得到 scenes（每段约 5s）
        scenes = []
        for p in clips:
            sc = detect_scenes(p)
            assert len(sc) == 1, f"期望单场景, 实际: {sc}"
            sc[0]["video_path"] = p
            scenes.append(sc[0])
        assert all(abs(s["duration"] - 5.0) < 0.1 for s in scenes)

        # 3) 构造 seg_durations（7 段合计 15.0s），调用匹配
        seg_durations = [2.5, 2.0, 2.0, 2.0, 2.0, 2.0, 2.5]
        assert abs(sum(seg_durations) - 15.0) < 1e-9
        segments = [{"text": f"句{i}", "index": i} for i in range(7)]

        # 不传 api_key → LLM 打分失败，自动回退均匀矩阵（覆盖驱动力），验证纯求解器路径
        res = asyncio.run(
            match_scenes_audio_first(segments, seg_durations, scenes, api_key="")
        )
        timeline = res["timeline"]
        dbg = res["debug"]

        # 不变量（同 A1）
        assert len(timeline) == 7, f"len(timeline)={len(timeline)}"
        computed = sum(float(t["duration"]) for t in timeline)
        assert abs(computed - 15.0) < 0.04, f"Σduration={computed}"
        for t in timeline:
            assert t["start_time"] + t["duration"] <= t["source_duration"] + 1e-6, t
        assert dbg["feasible"] is True
        # 覆盖：7 个素材全部被使用
        assert dbg["used_materials"] == 7, f"used_materials={dbg['used_materials']}"

        # 4) 造 15.0s 音频 + 真实合成（faithful v2 调用，timeline 含 segment_text）
        aud = os.path.join(tmp, "narration.mp3")
        _gen_audio(aud, 15.0)
        audio_dur = get_audio_duration(aud)
        out = os.path.join(tmp, "final.mp4")
        composite_clip(timeline, aud, out, 1080, 1920, None)
        assert os.path.exists(out), "合成输出未生成"

        # 5)① 输出时长 == 音频时长（无冻结/黑场/拉伸）
        out_dur = get_audio_duration(out)
        assert abs(out_dur - 15.0) < 0.1, f"输出时长 {out_dur} != 15.0"
        assert abs(out_dur - audio_dur) < 0.1, f"输出 {out_dur} != 音频 {audio_dur}"

        # 5)② 结尾无冻结：末段（≈12.5-15.0s）动画内容，采样连续帧应不全相同
        tail_sigs = [_frame_sig(out, t) for t in (13.0, 14.0, 14.5, 14.8)]
        frozen = len(set(tail_sigs)) == 1
        assert not frozen, f"输出视频结尾冻结! 帧哈希: {tail_sigs}"

        print(f"[E2E] 输出时长={out_dur:.3f}s == 音频 {audio_dur:.3f}s; "
              f"Σtimeline={computed:.3f}s; used_materials={dbg['used_materials']}/7; "
              f"尾部帧哈希不全相同(无冻结): {tail_sigs}")
    finally:
        _rmtree(tmp)


def test_overflow_control_reproduces_end_freeze():
    """B-对照：2s 素材 + 4s 音频 → 输出 4s 且末段死定格（证明检测手段有效）。"""
    tmp = tempfile.mkdtemp(prefix="e2e_control_")
    try:
        clip = os.path.join(tmp, "short.mp4")
        _gen_clip(clip, dur=2)  # 仅 2s 素材
        aud = os.path.join(tmp, "long.mp3")
        _gen_audio(aud, 4)  # 4s 音频

        # 段时长 4.0s 超过素材 2s → trim 只能出 ~2s → 视频 < 音频 → 触发 tpad 冻结
        segs = [{"video_path": clip, "start_time": 0.0, "duration": 4.0}]
        out = os.path.join(tmp, "frozen.mp4")
        composite_clip(segs, aud, out, 1080, 1920, None)
        assert os.path.exists(out)
        out_dur = get_audio_duration(out)
        assert abs(out_dur - 4.0) < 0.1, f"对照输出时长 {out_dur} != 4.0"

        # 冻结特征：末段为素材最后一帧克隆 → frame@3.0 == frame@2.0（冻结），
        # 而 frame@1.0 != frame@2.0（冻结前画面在动）
        f_10 = _frame_sig(out, 1.0)
        f_20 = _frame_sig(out, 2.0)
        f_30 = _frame_sig(out, 3.0)
        assert f_10 != f_20, "对照预期：冻结前画面应运动"
        assert f_30 == f_20, "对照预期：结尾应为死定格（frame@3.0==frame@2.0）"
        print(f"[CONTROL] 对照成功复现结尾冻结: f@1.0!=f@2.0({f_10 != f_20}), "
              f"f@3.0==f@2.0({f_30 == f_20})")
    finally:
        _rmtree(tmp)


def _rmtree(path):
    import shutil
    try:
        shutil.rmtree(path)
    except OSError:
        pass


if __name__ == "__main__":
    test_audio_first_e2e_duration_equals_audio_and_no_end_freeze()
    test_overflow_control_reproduces_end_freeze()
    print("\nE2E 验证通过")
