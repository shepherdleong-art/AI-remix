# -*- coding: utf-8 -*-
"""
P2 重选时段（Trim）一致性门槛 —— 预览 ≡ 导出 入点精度专项验证（一次性脚本，非 pytest）。

铁律（AI_HANDOFF §11）：不靠读代码推断，必须真跑 + ffprobe/帧对比。

流程：
  1. lavfi 生成 2 条 testsrc2 源素材（540×960@30fps，8s，内容可区分：src2 加 hue 旋转）。
  2. 以非零入点构造 3 段时间线（1.5s / 2.0s / 3.5s，各 2.0s 槽长）。
  3. 【导出端】真调 services.video_service.composite_clip()（生产导出代码路径）。
  4. 【预览端】真调 routes.preview.api_assemble_preview()（/api/preview/assemble 的路由处理函数，
     asyncio 直跑，执行的是同一份生产代码，非复刻）。
  5. 对每段：在成片时间轴 T_i+0.05s 处抽帧，与源素材 s_i+0.05s 处参考帧做逐像素
     mean-abs-diff；同时计算 ±0.2s / ±1.0s 处对照帧 diff。
     判据：d(0) < d(±0.2) 且 d(0) < 0.5×d(±1.0) → 入点精度在 ±0.2s 容差内。
  6. 预览帧 vs 导出帧同位置直接 diff（两条代码路径殊途同归的量化证据）。
  7. ffprobe 校验两条成片时长 = 6.0s。
"""
import asyncio
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))   # backend/
BACKEND = HERE
ROOT = os.path.dirname(BACKEND)
for p in (BACKEND,):
    if p not in sys.path:
        sys.path.insert(0, p)

from config import FFMPEG_EXECUTABLE  # noqa: E402
from services.video_service import composite_clip  # noqa: E402
from routes.preview import api_assemble_preview, AssembleRequest  # noqa: E402

ART = os.path.join(ROOT, ".p2_trim_gate")
os.makedirs(ART, exist_ok=True)
# composite_clip 的中间 concat.txt 以系统默认编码（GBK）写入，工作区路径含中文时
# ffmpeg concat demuxer 按 UTF-8 解析会失败（本次实测发现并记录为存量缺陷，
# 不在 P2 范围内修复）。因此导出产物放到 ASCII 临时目录；素材/抽帧仍放 ART
# （命令行 -i/-y 参数走 Unicode API，中文路径无问题）。
ASCII_OUT = os.path.join(os.environ.get("TEMP", "/tmp"), "p2_trim_gate")
os.makedirs(ASCII_OUT, exist_ok=True)
W, H, FPS = 540, 960, 30

# 非零入点时间线：seg0=src1@1.5s, seg1=src2@2.0s, seg2=src1@3.5s，各 2.0s
SEG_DEFS = [
    ("src1", 1.5, 2.0),
    ("src2", 2.0, 2.0),
    ("src1", 3.5, 2.0),
]


def run(cmd, timeout=120):
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"cmd failed: {cmd[:3]}...\n{r.stderr[-400:]}")
    return r


def make_sources():
    srcs = {}
    # src1: 原生 testsrc2（含烧录秒表 + 运动彩条，逐帧可区分）
    p1 = os.path.join(ART, "src1.mp4")
    if not os.path.exists(p1):
        run([FFMPEG_EXECUTABLE, "-y", "-f", "lavfi",
             "-i", f"testsrc2=size={W}x{H}:rate={FPS}:duration=8",
             "-pix_fmt", "yuv420p", p1])
    srcs["src1"] = p1
    # src2: testsrc2 + hue 旋转 90°，与 src1 内容明显不同
    p2 = os.path.join(ART, "src2.mp4")
    if not os.path.exists(p2):
        run([FFMPEG_EXECUTABLE, "-y", "-f", "lavfi",
             "-i", f"testsrc2=size={W}x{H}:rate={FPS}:duration=8,hue=h=90",
             "-pix_fmt", "yuv420p", p2])
    srcs["src2"] = p2
    return srcs


def probe_duration(path):
    """解析 ffmpeg -i stderr 的 Duration（项目内置 ffprobe.exe 实为 ffmpeg 副本，
    全项目统一用此方式探测时长，与 video_service.get_audio_duration 同法）。"""
    import re
    r = subprocess.run([FFMPEG_EXECUTABLE, "-i", path, "-f", "null", "-"],
                       capture_output=True, text=True, timeout=30)
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
    if not m:
        raise RuntimeError(f"无法解析时长: {path}")
    hh, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return hh * 3600 + mm * 60 + ss


def extract_frame(video, t, out_png, with_scale=False):
    cmd = [FFMPEG_EXECUTABLE, "-y", "-ss", f"{t:.3f}", "-i", video, "-vframes", "1"]
    if with_scale:
        # 与生产管线相同的几何处理，保证参考帧与成片帧几何一致
        cmd += ["-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1"]
    cmd += ["-q:v", "2", out_png]
    run(cmd, timeout=30)
    return out_png


def mad(png_a, png_b):
    a = np.asarray(Image.open(png_a).convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(png_b).convert("RGB"), dtype=np.int16)
    assert a.shape == b.shape, f"shape mismatch {a.shape} vs {b.shape}"
    return float(np.abs(a - b).mean())


def main():
    srcs = make_sources()
    segments = [
        {"video_path": srcs[name], "start_time": st, "duration": dur, "segment_text": ""}
        for name, st, dur in SEG_DEFS
    ]
    total = sum(d for _, _, d in SEG_DEFS)

    # ── 3. 导出端：真跑 composite_clip（audio 为空 → 跳过混流；无字幕 → 直出） ──
    export_path = os.path.join(ASCII_OUT, "export.mp4")
    for stale in (export_path, export_path + ".mixed.mp4", export_path + ".novoice.mp4"):
        if os.path.exists(stale):
            os.unlink(stale)  # Windows 上 os.rename 不允许目标已存在（WinError 183）
    composite_clip(segments, "", export_path, target_width=W, target_height=H)
    export_dur = probe_duration(export_path)
    print(f"[export] composite_clip 真跑完成: {export_path}  时长={export_dur:.3f}s (期望≈{total:.1f}s)")

    # ── 4. 预览端：真跑 /api/preview/assemble 路由处理函数 ──
    resp = asyncio.run(api_assemble_preview(AssembleRequest(
        timeline=[{"video_path": s["video_path"], "start_time": s["start_time"], "duration": s["duration"]} for s in segments],
        width=W, height=H,
    )))
    preview_path = resp["data"]["path"]
    preview_dur = probe_duration(preview_path)
    print(f"[preview] api_assemble_preview 真跑完成: {preview_path}  时长={preview_dur:.3f}s cached={resp['data'].get('cached')}")

    # ── 5/6. 逐段入点精度 + 预览≡导出 ──
    print("\n──── 入点精度（mean abs pixel diff, 0-255；越小越接近）────")
    offsets = (-1.0, -0.2, 0.0, 0.2, 1.0)
    all_pass = True
    cum = 0.0
    for i, (name, st, dur) in enumerate(SEG_DEFS):
        src = srcs[name]
        t_out = cum + 0.05          # 成片时间轴上本段起点 + 0.05s（段内安全区）
        t_src = st + 0.05           # 期望对应的源素材时刻
        cum += dur

        f_exp = extract_frame(export_path, t_out, os.path.join(ART, f"exp_{i}.png"))
        f_prv = extract_frame(preview_path, t_out, os.path.join(ART, f"prv_{i}.png"))
        refs = {}
        for off in offsets:
            tt = max(0.0, t_src + off)
            refs[off] = extract_frame(src, tt, os.path.join(ART, f"ref_{i}_{off:+.1f}.png"), with_scale=True)

        d_exp = {off: mad(f_exp, refs[off]) for off in offsets}
        d_prv = {off: mad(f_prv, refs[off]) for off in offsets}
        d_x = mad(f_exp, f_prv)

        ok_exp = d_exp[0.0] < d_exp[-0.2] and d_exp[0.0] < d_exp[0.2] and d_exp[0.0] < 0.5 * min(d_exp[-1.0], d_exp[1.0])
        ok_prv = d_prv[0.0] < d_prv[-0.2] and d_prv[0.0] < d_prv[0.2] and d_prv[0.0] < 0.5 * min(d_prv[-1.0], d_prv[1.0])
        all_pass &= ok_exp and ok_prv

        print(f"  seg{i} {name} 入点={st:.1f}s 槽长={dur:.1f}s 成片抽帧@{t_out:.2f}s:")
        print(f"    导出 vs 源:  d(0)={d_exp[0.0]:6.2f}  d(-0.2)={d_exp[-0.2]:6.2f}  d(+0.2)={d_exp[0.2]:6.2f}  d(±1.0)={d_exp[-1.0]:6.2f}/{d_exp[1.0]:6.2f}  → {'OK' if ok_exp else 'FAIL'}")
        print(f"    预览 vs 源:  d(0)={d_prv[0.0]:6.2f}  d(-0.2)={d_prv[-0.2]:6.2f}  d(+0.2)={d_prv[0.2]:6.2f}  d(±1.0)={d_prv[-1.0]:6.2f}/{d_prv[1.0]:6.2f}  → {'OK' if ok_prv else 'FAIL'}")
        print(f"    预览 vs 导出（同位置直比）: d={d_x:6.2f}")

    # ── 7. 时长一致性 ──
    dur_ok = abs(export_dur - total) < 0.2 and abs(preview_dur - total) < 0.2
    all_pass &= dur_ok
    print(f"\n  时长: 导出={export_dur:.3f}s 预览={preview_dur:.3f}s 期望≈{total:.1f}s → {'OK' if dur_ok else 'FAIL'}")

    print(f"\n结论: {'预览 ≡ 导出，入点精度均在 ±0.2s 容差内 —— 门槛通过' if all_pass else '存在不一致 —— 门槛未过'}")
    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
