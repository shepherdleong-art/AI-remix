"""
Video processing service.

- Scene detection & frame extraction using ffmpeg
- Compositing (video + audio → final output)
"""
import os
import math
import logging
import subprocess
import tempfile
import hashlib
import shutil
import threading
from pathlib import Path
from typing import Optional

from config import (
    FFMPEG_EXECUTABLE,
    FFPROBE_EXECUTABLE,
    TEMP_DIR,
    AI_SCENE_THRESHOLD,
    AI_MIN_SCENE_DURATION,
)

logger = logging.getLogger(__name__)


# L1 (④ CPU 优化)：抽帧并发硬上限 = CPU 核数 - 2（至少 1）。
# 分析 API 并发可高达 10（网络等待型），但本地 ffmpeg 抽帧是 CPU 密集——
# 用全局信号量把「同时抽帧的 ffmpeg 进程数」封顶到 核数-2，给 UI 与系统留 2 核缓冲，
# 避免 ② 把 API 并发调高后 10 个 ffmpeg 齐跑把 CPU 占满（与 ② 同根冲突的解法之一）。
_FRAME_EXTRACT_SEM = threading.Semaphore(max(1, (os.cpu_count() or 2) - 2))


def _ffmpeg() -> str:
    return FFMPEG_EXECUTABLE if os.path.exists(FFMPEG_EXECUTABLE) else "ffmpeg"


def _ffprobe() -> str:
    return FFPROBE_EXECUTABLE if os.path.exists(FFPROBE_EXECUTABLE) else "ffprobe"


def detect_scenes(
    video_path: str,
    threshold: float | None = None,
    min_duration: float | None = None,
    skip_nonkeyframes: bool = False,
    lowres: int = 0,
) -> list[dict]:
    """
    Detect scene changes in a video using ffmpeg's scene detection filter.

    Args:
        video_path: 视频路径
        threshold: 场景切换阈值（0-100），None 用 AI_SCENE_THRESHOLD
        min_duration: 最短场景时长（秒），None 用 AI_MIN_SCENE_DURATION
        skip_nonkeyframes: F10 批量提速——仅解码关键帧(I 帧)做场景检测，
            约 5-10x 提速；场景粒度变粗但更对齐编码帧。默认 False（单条精细工作流）。
        lowres: F10 批量提速——H.264 降分辨率解码（1/2→1, 1/4→2, 1/8→3）。
            仅 codec_name=="h264" 时生效（HEVC 解码器不支持 lowres）。默认 0（不降分辨率）。

    注意：单条精细工作流调用时走默认参数（skip_nonkeyframes=False, lowres=0），
    行为与改动前完全一致；批量提速标志仅由 concurrent_analyzer._default_analyze 注入。

    Returns list of scenes: [{start, end, duration}, ...]
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    if threshold is None:
        threshold = AI_SCENE_THRESHOLD
    if min_duration is None:
        min_duration = AI_MIN_SCENE_DURATION

    # 1) 优先用 ffprobe 快速取时长（不解码视频流），对大文件/高码率/慢盘更稳。
    #    ffprobe 失败再回退到 ffmpeg 全解码，保证兼容性。
    total_duration = 0.0
    ffprobe_ok = os.path.exists(FFPROBE_EXECUTABLE)
    if ffprobe_ok:
        dur_cmd = [
            _ffprobe(),
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ]
        try:
            dur_result = subprocess.run(
                dur_cmd, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120,
            )
            if dur_result.returncode == 0 and dur_result.stdout.strip():
                total_duration = float(dur_result.stdout.strip().splitlines()[0].strip())
        except (ValueError, subprocess.TimeoutExpired, OSError) as e:
            logger.warning(f"ffprobe duration failed for {video_path}: {e}; falling back to ffmpeg")
            total_duration = 0.0

    # 2) ffprobe 不可用或没拿到时长，回退 ffmpeg 全解码（可靠性兜底）。
    if total_duration <= 0:
        dur_cmd = [
            _ffmpeg(), "-i", video_path, "-f", "null", "-"
        ]
        dur_result = subprocess.run(
            dur_cmd, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=120,
        )
        if dur_result.returncode != 0:
            raise RuntimeError(
                f"Failed to probe video duration: {video_path}\n"
                f"stderr: {dur_result.stderr[:300]}"
            )
        duration_line = dur_result.stderr
        for line in duration_line.split("\n"):
            if "Duration:" in line:
                # Format: Duration: 00:00:05.23, start: ...
                time_str = line.split("Duration:")[1].split(",")[0].strip()
                parts = time_str.split(":")
                total_duration = float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
                break

    if total_duration <= 0:
        raise RuntimeError(f"Could not determine video duration: {video_path}")

    # 探测视频编码（用于决定是否启用 -lowres 降分辨率解码；仅 H.264 支持 lowres）。
    # 廉价元数据读取（仅读容器头部），失败不影响主流程（codec_name 留空 → 不启用 lowres）。
    codec_name = ""
    if os.path.exists(FFPROBE_EXECUTABLE):
        try:
            codec_result = subprocess.run(
                [_ffprobe(), "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=codec_name",
                 "-of", "default=noprint_wrappers=1:nokey=1", video_path],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=30,
            )
            if codec_result.returncode == 0 and codec_result.stdout.strip():
                codec_name = codec_result.stdout.strip().splitlines()[0].strip()
        except (subprocess.TimeoutExpired, OSError):
            codec_name = ""

    # F10 批量场景检测提速（单条走默认参数，此处不生效）：
    # - skip_nonkeyframes=True → 仅解码关键帧（-skip_frame nokey），约 5-10x 提速，
    #   场景边界变粗但更对齐编码帧，切割更干净。
    # - lowres>0 且仅 H.264 → 降分辨率解码（解码器级，远快于缩放滤镜），约 2-4x。
    # 两个标志都是「输入选项」，必须放在 -i 之前。
    cmd: list[str] = [_ffmpeg()]
    if skip_nonkeyframes:
        cmd += ["-skip_frame", "nokey"]
    if lowres and codec_name == "h264":
        cmd += ["-lowres", str(lowres)]
    cmd += [
        "-i", video_path,
        "-vf", f"select='gt(scene,{threshold/100})',metadata=print:file=-",
        "-f", "null", "-"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if result.returncode != 0:
        raise RuntimeError(
            f"Scene detection failed for: {video_path}\n"
            f"stderr: {result.stderr[:300]}"
        )

    # Parse scene change timestamps.
    # 注意：bundled ffmpeg 的 `metadata=print:file=-` 输出到 **stdout**（非 stderr），
    # 旧代码只扫 result.stderr 导致场景时间戳永远解析不到（整段视频被当成 1 个场景）。
    # 改为同时扫描 stdout + stderr，兼容两种 ffmpeg 构建行为（正确性修复，单条/批量同受益）。
    scene_text = result.stdout + "\n" + result.stderr
    scene_times = [0.0]
    for line in scene_text.split("\n"):
        if "pts_time:" in line:
            try:
                t = float(line.split("pts_time:")[1].strip().split()[0])
                if t > 0.1:  # Ignore changes at very start
                    scene_times.append(round(t, 2))
            except (ValueError, IndexError):
                pass

    scene_times.append(round(total_duration, 2))

    # Merge short scenes
    scenes = []
    for i in range(len(scene_times) - 1):
        start = scene_times[i]
        end = scene_times[i + 1]
        if end - start >= min_duration:
            scenes.append({
                "index": len(scenes),
                "start": start,
                "end": end,
                "duration": round(end - start, 2),
                # 钩子标记（手动）：默认非钩子；未来 UI 可置 True，
                # 匹配时开场段优先选用（见 match_solver 的 hook 偏好）。
                "isHook": False,
            })

    return scenes


def extract_frame(video_path: str, time_sec: float, output_path: str) -> str:
    """
    Extract a single frame from a video at the given timestamp.

    Returns the output_path.
    """
    cmd = [
        _ffmpeg(),
        "-ss", str(time_sec),
        "-i", video_path,
        "-vframes", "1",
        "-q:v", "3",
        "-threads", "1",  # L1 (④)：单 ffmpeg 抽帧只占一核，避免占满多核
        "-y",
        output_path,
    ]
    _FRAME_EXTRACT_SEM.acquire()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    finally:
        _FRAME_EXTRACT_SEM.release()
    if result.returncode != 0:
        raise RuntimeError(f"Frame extraction failed: {result.stderr[:200]}")
    return output_path


def extract_scene_frames(
    video_path: str,
    scenes: list[dict],
    output_dir: str,
) -> list[str]:
    """
    Extract one representative frame from each detected scene.

    Returns list of paths to extracted frame images.
    """
    os.makedirs(output_dir, exist_ok=True)
    frame_paths = []

    for scene in scenes:
        # Take frame at 30% into the scene
        mid_time = scene["start"] + scene["duration"] * 0.3
        out_path = os.path.join(output_dir, f"scene_{scene['index']:03d}.jpg")
        extract_frame(video_path, mid_time, out_path)
        frame_paths.append(out_path)

    return frame_paths


def composite_clip(
    segments: list[dict],
    audio_path: str,
    output_path: str,
    target_width: int = 1080,
    target_height: int = 1920,
    subtitle_style: dict | None = None,
) -> str:
    """
    Composite video segments trimmed from original videos with narration audio.

    Args:
        segments: [{video_path, start_time, duration, segment_text}, ...]
        audio_path: Path to the TTS-generated narration audio.
        output_path: Where to save the final MP4.
        target_width: Output width (default 1080 for portrait).
        target_height: Output height (default 1920 for portrait 9:16).

    Returns:
        Path to the output file.
    """
    if not segments:
        raise ValueError("No segments to composite")

    # Trim each segment from its source video, then concat
    trimmed_files = []
    valid_segments = []  # segments that were actually trimmed successfully
    for i, seg in enumerate(segments):
        video_path = seg.get("video_path", "")
        start_time = seg.get("start_time", 0.0)
        duration = seg.get("duration", 3.0)

        if not os.path.exists(video_path):
            logger.warning(f"Video not found for segment {i}: {video_path}")
            continue

        trimmed = os.path.join(
            os.path.dirname(output_path), f"trim_{i:03d}.mp4"
        )
        # Trim + scale to target resolution
        result = subprocess.run([
            _ffmpeg(),
            "-i", video_path,
            "-ss", str(start_time),
            "-t", str(duration),
            "-vf", f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase,"
                   f"crop={target_width}:{target_height},setsar=1",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-an",
            "-y", trimmed,
        ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)

        if result.returncode != 0:
            logger.warning(f"Trim failed for segment {i}: {result.stderr[:200]}")
            continue

        trimmed_files.append(trimmed)
        valid_segments.append(seg)  # this segment was successfully trimmed

    if not trimmed_files:
        raise RuntimeError("No valid video segments after trimming")

    # Create concat file (UTF-8: ffmpeg concat demuxer parses as UTF-8;
    # Windows default GBK breaks Chinese output paths)
    concat_file = os.path.join(os.path.dirname(output_path), "concat.txt")
    with open(concat_file, "w", encoding="utf-8") as f:
        for tf in trimmed_files:
            # ffmpeg concat demuxer treats backslashes as escapes; normalize
            f.write(f"file '{tf.replace(chr(92), '/')}'\n")

    # Concatenate trimmed segments
    temp_video = output_path + ".novoice.mp4"
    result = subprocess.run([
        _ffmpeg(),
        "-f", "concat",
        "-safe", "0",
        "-i", concat_file,
        "-c:v", "libx264",
        "-crf", "23",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-y", temp_video,
    ], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)

    if result.returncode != 0:
        raise RuntimeError(f"Concat failed: {result.stderr[:300]}")

    # Mix with audio
    mixed_video = output_path + ".mixed.mp4"
    audio_dur = get_audio_duration(audio_path) if (os.path.exists(audio_path) and os.path.getsize(audio_path) > 0) else 0
    
    if audio_dur > 0:
        # Log actual durations for debugging
        actual_video_dur = get_audio_duration(temp_video)
        logger.info(f"[COMPOSITE] Audio: {audio_dur:.1f}s, Video: {actual_video_dur:.1f}s (requested: {sum(seg.get('duration',0) for seg in segments):.1f}s)")

        # When the concatenated main video is SHORTER than the narration audio
        # (happens when one or more segments trimmed past the end of their source
        # clip, so the trim came out shorter than requested), the old command
        # below forced ``-t audio_dur``. The video stream would already be
        # exhausted, so ffmpeg froze the last frame to fill the gap -- this is the
        # reported "end-of-video freeze" bug. Fix: pad the video's last frame up
        # to the audio length first, so ``-t audio_dur`` no longer overruns an
        # exhausted stream. When the video is already long enough we keep the
        # original behaviour (no padding, ``-t`` simply trims the excess).
        vf: list[str] = []
        if actual_video_dur < audio_dur - 0.1:
            pad = audio_dur - actual_video_dur
            vf.append(f"tpad=stop_mode=add:stop_duration={pad:.3f}")
            logger.warning(
                f"[COMPOSITE] video {actual_video_dur:.1f}s < audio {audio_dur:.1f}s, "
                f"padding last frame by {pad:.1f}s to avoid end-freeze"
            )

        audio_mix_cmd = [_ffmpeg(), "-i", temp_video, "-i", audio_path]
        if vf:
            # NOTE: ``-vf`` must be placed AFTER all ``-i`` inputs (as an output
            # option); putting it between the two inputs makes this ffmpeg build
            # reject the command ("input option to an output file").
            audio_mix_cmd += ["-vf", ",".join(vf)]
        audio_mix_cmd += [
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-t", str(audio_dur),
            "-y", mixed_video,
        ]
        result = subprocess.run(
            audio_mix_cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(f"Audio mix failed: {result.stderr[:300]}")
    else:
        os.rename(temp_video, mixed_video)

    # Auto-subtitle: always render if segments have text
    has_text = any(s.get("segment_text", "").strip() for s in segments)
    logger.info(f"[COMPOSITE_CLIP] has_text={has_text}, n_segs={len(segments)}, style={bool(subtitle_style)}")
    if has_text:
        for i, s in enumerate(segments):
            logger.info(f"[COMPOSITE_CLIP] seg[{i}] text='{(s.get('segment_text') or '')[:60]}' dur={s.get('duration')}")
    if not subtitle_style:
        subtitle_style = {}  # use defaults
    if has_text:
        _render_subtitles(mixed_video, valid_segments, subtitle_style, output_path, target_width, target_height)
        try: os.unlink(mixed_video)
        except OSError: pass
    else:
        logger.warning("[COMPOSITE_CLIP] NO segment_text found — skipping subtitles!")
        os.rename(mixed_video, output_path)

    # Cleanup
    for tf in trimmed_files:
        try: os.unlink(tf)
        except OSError: pass
    try: os.unlink(temp_video)
    except OSError: pass
    try: os.unlink(concat_file)
    except OSError: pass

    return output_path


def _render_subtitles(
    video_path: str,
    segments: list[dict],
    style: dict,
    output_path: str,
    w: int,
    h: int,
) -> None:
    """Burn subtitles using ffmpeg drawtext filter (reliable fontfile approach)."""
    font_name = style.get("font", "Microsoft YaHei")
    font_path = style.get("font_path", "")
    font_size = int(style.get("size", 24))
    font_color = style.get("color", "white")
    stroke_color = style.get("stroke_color", "black")
    stroke_width = int(style.get("stroke_width", 2))

    # Resolve font file path
    logger.info(f"[DRAWTEXT] Requested font: name={font_name}, path={font_path}")
    if font_path and os.path.exists(font_path):
        fontfile = font_path.replace("\\", "/").replace(":", "\\:")
        logger.info(f"[DRAWTEXT] Using fontfile={font_path}")
    else:
        for c in [r"C:/Windows/Fonts/simhei.ttf", r"C:/Windows/Fonts/msyh.ttf",
                   r"C:/Windows/Fonts/simsun.ttc"]:
            if os.path.exists(c):
                fontfile = c.replace(":", "\\:")
                font_name = os.path.splitext(os.path.basename(c))[0]
                logger.info(f"[DRAWTEXT] Fallback to font: {c}")
                break
        else:
            fontfile = r"C\:/Windows/Fonts/simhei.ttf"
            logger.warning(f"[DRAWTEXT] No font found, using fallback: {fontfile}")
    
    # Verify font file actually exists
    check_path = fontfile.replace("\\:", ":").replace("\\\\:", ":").replace("\\/", "/")
    if not os.path.exists(check_path):
        logger.warning(f"[DRAWTEXT] Font file NOT FOUND at resolved path: {check_path} (original: {fontfile})")
    else:
        logger.info(f"[DRAWTEXT] Font file verified at: {check_path}")
    # Copy font to temp ASCII-safe path (FFmpeg sometimes fails with CJK paths)
    try:
        real_path = fontfile.replace("\\:", ":").replace("\\/", "/")
        ext = os.path.splitext(real_path)[1] or ".ttf"
        hash_id = hashlib.md5(real_path.encode()).hexdigest()[:8]
        safe_copy = os.path.join(tempfile.gettempdir(), f"ff_sub_{hash_id}{ext}")
        if not os.path.exists(safe_copy):
            shutil.copy2(real_path, safe_copy)
        fontfile = safe_copy.replace("\\", "/").replace(":", "\\:")
        logger.info(f"[DRAWTEXT] Copied font to safe path: {safe_copy}")
    except Exception as e:
        logger.warning(f"[DRAWTEXT] Font copy failed (using original path): {e}")

    # Build drawtext filter chain — one per sentence within each segment
    acc = 0.0
    drawtext_parts = []
    for seg in segments:
        text = (seg.get("segment_text") or "").strip()
        dur = seg.get("duration", 2.0)
        if not text:
            acc += dur
            continue
        parts = _split_sentences(text)
        if not parts:
            acc += dur
            continue
        # Position: use per-segment override (percentages) or default center-bottom
        sx = seg.get("subtitle_x")
        sy = seg.get("subtitle_y")
        if sx is not None and sy is not None:
            x_pos = f"w*{float(sx)/100}-text_w/2"
            y_pos = f"h*{float(sy)/100}-th/2"
        else:
            x_pos = "(w-text_w)/2"
            y_pos = "h-th-60"
        total_chars = sum(len(p) for p in parts) or 1
        for part in parts:
            part_dur = dur * len(part) / total_chars
            safe = part.replace("\\", "\\\\\\\\").replace(":", "\\\\:").replace("'", "\\\\'")
            drawtext_parts.append(
                f"drawtext=text='{safe}':"
                f"fontfile='{fontfile}':"
                f"fontsize={font_size}:fontcolor={font_color}:"
                f"bordercolor={stroke_color}:borderw={stroke_width}:"
                f"x={x_pos}:y={y_pos}:"
                f"enable='between(t,{acc},{acc + part_dur})'"
            )
            acc += part_dur

    if not drawtext_parts:
        shutil.copy2(video_path, output_path)
        return

    filter_chain = ",".join(drawtext_parts)
    logger.info(f"DRAWTEXT: {len(drawtext_parts)} parts, font={font_name}, file={fontfile}")
    logger.info(f"DRAWTEXT filter (first 200): {filter_chain[:200]}")

    cmd = [
        _ffmpeg(),
        "-i", video_path,
        "-vf", filter_chain,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "copy", "-y", output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if result.returncode != 0:
        logger.warning(f"DRAWTEXT FAILED! rc={result.returncode}")
        logger.warning(f"STDERR: {result.stderr[-400:]}")
        shutil.copy2(video_path, output_path)
    else:
        logger.info(f"DRAWTEXT OK! {os.path.getsize(output_path)} bytes")

def _build_cover_filter_complex(
    segments: list,
    w: int,
    h: int,
    fontfile: str,
) -> str:
    """Build the ``-filter_complex`` graph that burns each text line onto the cover.

    Each ``segment`` is a tuple:
        (safe_text, pos_x_pct, pos_y_pct, font_size, font_color,
         stroke_color, stroke_width, shear_x)

    where ``safe_text`` is already ffmpeg-escaped and ``shear_x`` is the value
    passed to the ``shear`` filter's ``shx`` option (``0.28`` for an italic
    row, ``0`` for a normal row).

    The graph creates one independent transparent ``color`` source per line,
    draws the text with ``drawtext`` (deliberately WITHOUT ``fontstyle`` — this
    FFmpeg build rejects that option with "Option not found"), shears it
    horizontally with ``shear`` to synthesise the italic slant, then overlays
    it back onto the frame. ``shear``'s ``fillcolor=0x00000000`` keeps the
    sheared-away regions transparent so no black block is introduced.
    """
    W, H = w, h

    # The text layer must be wide enough that the shear never pushes text
    # outside the layer bounds, which would cause invisible clipping and skew
    # the measured centroid.  The maximum horizontal shear displacement for
    # any pixel in this frame is |shx| * H/2  (reached at y=0 and y=H).
    # We budget twice that as a safety margin on each side so the text,
    # which may already start near x=0 or x=W, has room to shift.
    max_shear = int(abs(0.28) * (H / 2)) + 2   # ~268 px, plus small guard
    layer_w = W + 2 * max_shear
    # The layer is centred on the canvas by shifting the overlay LEFT so
    # that the middle of the extra-wide layer aligns with the canvas centre.
    layer_ox = -max_shear

    chain = ["[0:v]format=rgba[base]"]
    last = "base"
    for idx, (safe, tpx, tpy, fs, fc_, s_color, s_width, shx) in enumerate(segments):
        layer = f"layer{idx}"
        out_label = "out" if idx == len(segments) - 1 else f"base{idx + 1}"

        # Shear compensation via overlay x.  ffmpeg `shear=shx` empirically
        # transforms  x' = x + shx*(H/2 - y), so the centroid at y=h*tpy/100
        # shifts RIGHT by  shear_drift = shx*(H/2 - h*tpy/100).  We cancel
        # that by shifting the overlaid layer LEFT by the same amount (the
        # overlay x is relative to the layer's own origin, which is at
        # canvas x = layer_ox).
        shear_drift = shx * (H / 2 - h * tpy / 100)
        # drawtext x: centre the text on canvas tpx% within the extra-wide
        # layer.  The layer is overlaid at canvas x = layer_ox (= -max_shear).
        # Text centre in canvas:  w * tpx/100.
        # Text centre in layer:   w*tpx/100 - layer_ox = w*tpx/100 + max_shear.
        # drawtext x = centre - text_w/2.
        x_expr = f"{w}*{tpx}/100+{max_shear}-text_w/2"
        chain.append(
            f"color=c=black@0:s={layer_w}x{H}:r=25,format=rgba,"
            f"drawtext=text='{safe}':fontfile='{fontfile}':"
            f"fontsize={fs}:fontcolor={fc_}:"
            f"bordercolor={s_color}:borderw={s_width}:"
            f"x={x_expr}:y=h*{tpy}/100-th/2,"
            f"shear=shx={shx}:fillcolor=0x00000000[{layer}]"
        )
        # Overlay: position the wider layer centred on the canvas, then
        # shift LEFT by shear_drift to cancel the italic rightward drift.
        ox = layer_ox - shear_drift
        chain.append(f"[{last}][{layer}]overlay=x={ox:+.4f}:y=0:shortest=1[{out_label}]")
        last = out_label
    return ";".join(chain)


# ---------------------------------------------------------------------------
# Cover title anti-crop: measure the REAL rendered width with the exact font
# file ffmpeg will use (Pillow/FreeType), then auto-shrink the font size so the
# single-line title fits inside the cover frame at its anchor — never clipping.
#
# Why this lives on the BACKEND (not the frontend): the frontend preview fits
# using the browser's DOM metrics, which diverge from ffmpeg's actual glyph
# width — especially because ffmpeg's `borderw` (stroke) adds `borderw` px on
# each side while the DOM <span> measurement has no stroke. That divergence is
# exactly what caused "the title didn't fill the width yet got clipped on
# export". Measuring here with the same font file ffmpeg draws makes the export
# authoritative and guarantees no clip. (The frontend preview still fits with
# its own DOM estimate so it also stays inside the frame.)
# ---------------------------------------------------------------------------
try:
    from PIL import ImageFont  # type: ignore
    _HAS_PIL = True
except Exception:
    _HAS_PIL = False


def _measure_text(text: str, fontfile: str, fontsize: int, stroke_width: int = 0):
    """Return (width, height) in px of `text` rendered with the real font file.

    Includes a safety allowance for ffmpeg drawtext `borderw` (= stroke_width),
    which paints `stroke_width` px on BOTH sides of every glyph and therefore
    widens the line. Returns None if measurement is impossible (Pillow missing
    or font unreadable) so the caller can fall back to "no shrink".
    """
    if not _HAS_PIL or not fontfile or not os.path.exists(fontfile):
        return None
    try:
        # TrueType Collection (e.g. msyh.ttc): face 0 is the regular style,
        # which is what ffmpeg draws — so we measure the same face.
        font = ImageFont.truetype(fontfile, int(round(fontsize)), index=0)
        bbox = font.getbbox(text)
        if not bbox:
            return None
        w = (bbox[2] - bbox[0]) + 2 * max(0, int(stroke_width))
        h = (bbox[3] - bbox[1]) + 2 * max(0, int(stroke_width))
        return (float(w), float(h))
    except Exception as e:
        logger.warning(f"[COVER_FIT] text measurement failed: {e}")
        return None


def _fit_cover_text(
    text: str,
    fontfile: str,
    fontsize: int,
    stroke_width: int,
    x_pct: float,
    y_pct: float,
    w: int,
    h: int,
    margin: float = 0.01,
) -> tuple:
    """Return (font_size, x_pct, y_pct) so a single-line `text` fits inside the
    cover frame at its anchor WITHOUT ever clipping.

    Product rule (per user clarification 2026-07):
      * Available width/height = the WHOLE cover frame (w, h), NOT the half-space
        from the anchor. So a title SHORTER than the cover width is kept at its
        full size — it is never shrunk just because it is placed off-centre.
      * The font only SHRINKS when the title genuinely exceeds the cover width (or
        height). In that case it shrinks until it fits the full frame and is
        re-centred (that axis -> 50%) so the single line is fully visible (no wrap).
      * When the title fits the frame but its anchor would still push part of it
        past an edge, the anchor is nudged minimally (kept as close to the user's
        placement as possible) so it never clips.
    """
    if not text or not text.strip():
        return fontsize, x_pct, y_pct
    m = _measure_text(text, fontfile, fontsize, stroke_width)
    if m is None or (m[0] <= 0 and m[1] <= 0):
        return fontsize, x_pct, y_pct
    mw, mh = m
    avail_w = w * (1.0 - margin)
    avail_h = h * (1.0 - margin)
    half_w = mw / 2.0
    half_h = mh / 2.0

    # Shrink factor — triggered when the title exceeds the available width
    # MINUS both margins. We need room on BOTH sides to nudge without clipping,
    # because the nudge must keep each edge ≥ margin_px from the canvas border.
    # The old check (half_w > avail_w/2 <=> mw > w*(1-margin)) was too loose:
    # when mw is between w*(1-2*margin) and w*(1-margin), the nudge `elif`
    # can only correct one edge at a time, so the opposite edge stays clipped,
    # distorting the centroid. Using the tighter bound guarantees there is
    # always enough room for a safe nudge on BOTH axes.
    fit_w = w * (1.0 - 2.0 * margin)
    fit_h = h * (1.0 - 2.0 * margin)
    shrink_x = mw > fit_w
    shrink_y = mh > fit_h
    if shrink_x or shrink_y:
        f = 1.0
        if shrink_x:
            # 0.98 guard eats the floor()+proportional-to-actual rounding gap
            f = min(f, fit_w / mw * 0.98)
        if shrink_y:
            f = min(f, fit_h / mh * 0.98)
        new_size = max(int(math.floor(fontsize * f)), 6)
        nx = 50.0 if shrink_x else x_pct
        ny = 50.0 if shrink_y else y_pct
        return new_size, nx, ny

    # Fits the frame: keep the font size, nudge the anchor just enough to stay
    # inside (only when an edge would otherwise be clipped).  Use `if` (not
    # `elif`) for left+right / top+bottom so that when both edges overflow the
    # second correction still runs (the last write wins, at least keeping the
    # text anchored to the nearer edge instead of silently clipping it).
    cx = w * x_pct / 100.0
    cy = h * y_pct / 100.0
    margin_px = margin * w
    margin_px_v = margin * h
    if cx - half_w < margin_px:
        cx = margin_px + half_w
    if cx + half_w > w - margin_px:
        cx = w - margin_px - half_w
    if cy - half_h < margin_px_v:
        cy = margin_px_v + half_h
    if cy + half_h > h - margin_px_v:
        cy = h - margin_px_v - half_h
    return fontsize, cx * 100.0 / w, cy * 100.0 / h


def render_cover(
    video_path: str,
    cover_time: float,
    title: str,
    subtitle: str,
    style: dict,
    output_path: str,
    w: int = 1080,
    h: int = 1920,
    duration: float = 0.5,
) -> str:
    """Extract a frame, burn title/subtitle via drawtext, create a short clip."""
    font_path = style.get("font_path", "")
    font_name = style.get("font", "Microsoft YaHei")
    title_size = int(style.get("title_size", 48))
    sub_size = int(style.get("sub_size", 24))
    title_color = style.get("title_color", "white")
    sub_color = style.get("sub_color", "#cccccc")
    title_stroke_color = style.get("title_stroke_color", "black")
    title_stroke_width = int(style.get("title_stroke_width", 2))
    sub_stroke_color = style.get("sub_stroke_color", "black")
    sub_stroke_width = int(style.get("sub_stroke_width", 2))
    title_x = float(style.get("title_x", 50))
    title_y = float(style.get("title_y", 35))
    sub_x = float(style.get("sub_x", 50))
    sub_y = float(style.get("sub_y", 55))
    title_italic = bool(style.get("title_italic", False))
    sub_italic = bool(style.get("sub_italic", False))
    cover_zoom = float(style.get("zoom", 1.0))
    cover_ox = int(style.get("offset_x", 0))
    cover_oy = int(style.get("offset_y", 0))

    logger.info(f"[RENDER_COVER] Font: name={font_name}, path={font_path}")
    if font_path and os.path.exists(font_path):
        fontfile = font_path.replace("\\", "/").replace(":", "\\:")
        logger.info(f"[RENDER_COVER] Using fontfile={font_path}")
    else:
        for c in [r"C:/Windows/Fonts/simhei.ttf", r"C:/Windows/Fonts/msyh.ttf"]:
            if os.path.exists(c):
                fontfile = c.replace(":", "\\:")
                logger.info(f"[RENDER_COVER] Fallback to font: {c}")
                break
        else:
            fontfile = r"C\:/Windows/Fonts/simhei.ttf"
            logger.warning(f"[RENDER_COVER] No font found, using fallback: {fontfile}")
    # Copy font to temp ASCII-safe path (FFmpeg sometimes fails with CJK paths)
    try:
        real_path = fontfile.replace("\\:", ":").replace("\\/", "/")
        ext = os.path.splitext(real_path)[1] or ".ttf"
        hash_id = hashlib.md5(real_path.encode()).hexdigest()[:8]
        safe_copy = os.path.join(tempfile.gettempdir(), f"ff_cover_{hash_id}{ext}")
        if not os.path.exists(safe_copy):
            shutil.copy2(real_path, safe_copy)
        fontfile = safe_copy.replace("\\", "/").replace(":", "\\:")
        logger.info(f"[RENDER_COVER] Copied font to safe path: {safe_copy}")
    except Exception as e:
        logger.warning(f"[RENDER_COVER] Font copy failed (using original path): {e}")

    # Extract frame with zoom + pan.
    # The frame transform MUST mirror the step-3 preview 1:1:
    #   preview : source -> objectFit:'fill' (stretch to the box) -> CSS
    #             scale(zoom) about center -> translate(offX, offY). The box has
    #             overflow:hidden, so a non-zero pan slides the content and clips
    #             it, revealing black at the trailing edge.
    #   export  : a source point at normalized (fx, fy) must land at
    #             out_x = w*(0.5 + zoom*(fx-0.5)) + offX_export_px,  where
    #             offX_export_px = -cover_ox (cover_ox = -offX*COVER_SCALE, see
    #             ExportConfirm). That is exactly crop origin
    #             crop_ox = (scaled_w - w)/2 + cover_ox.
    # CRITICAL (WYSIWYG bugfix): do NOT clamp the crop origin to 0. At zoom==1 the
    # scaled frame equals the output size, so a non-zero pan has no overscan to
    # crop from — the old `max(0, ...)` silently dropped the pan, so the exported
    # cover showed the UNPANNED background while the preview showed the panned one
    # (the title, anchored to the box, then sat over different content). Instead
    # we pad the scaled frame into a generous black margin canvas and crop at the
    # (possibly negative) origin, reproducing the preview's slide-and-clip with
    # black edges exactly. This is backward-compatible with every previously
    # working case (zoom>1 crop, zoom<1 pad) and additionally honors pan at zoom=1.
    frame = output_path + ".cover.png"
    scaled_w = int(round(w * cover_zoom))
    scaled_h = int(round(h * cover_zoom))
    crop_ox = int((scaled_w - w) / 2 + cover_ox)
    crop_oy = int((scaled_h - h) / 2 + cover_oy)
    # Generous margin so even large pans stay inside the padded canvas. The
    # preview box is only ~180/240px wide, so offX_export_px (= offX*COVER_SCALE)
    # is bounded by ~1080-1440px; this margin is far larger than that.
    M = scaled_w + scaled_h + w + h
    padded_w = scaled_w + 2 * M
    padded_h = scaled_h + 2 * M
    crop_x = M + crop_ox
    crop_y = M + crop_oy
    vf = (f"scale={scaled_w}:{scaled_h}:flags=lanczos,"
          f"pad={padded_w}:{padded_h}:{M}:{M}:black,"
          f"crop={w}:{h}:{crop_x}:{crop_y}")
    logger.info(f"[RENDER_COVER] zoom={cover_zoom}, crop origin=({crop_ox},{crop_oy}), "
                f"padded crop window=({crop_x},{crop_y})")
    subprocess.run([
        _ffmpeg(), "-ss", str(cover_time), "-i", video_path,
        "-vframes", "1", "-q:v", "2",
        "-vf", vf,
        "-y", frame,
    ], capture_output=True, timeout=30)

    if not os.path.exists(frame):
        raise RuntimeError("Failed to extract cover frame")

        # Build drawtext chain for title + subtitle (with separate stroke params + italic)
    # NOTE: This FFmpeg build's drawtext does NOT support `fontstyle`
    # (error: "Option not found" -> whole filter init fails -> text blank).
    # Italic is synthesised via a separate transparent text layer + `shear`
    # skew (shx) + overlay, fully avoiding the unsupported fontstyle option.
    logger.info(f"[RENDER_COVER] title='{title}' title_x={title_x} title_size={title_size} "
                f"w={w} h={h} font={font_name} zoom={cover_zoom}")

    # WYSIWYG anti-crop: re-fit with the REAL font metrics (this exact font
    # file is what ffmpeg draws). This is authoritative — it guarantees a title
    # never clips at the cover edge, and only shrinks the font when the title
    # genuinely exceeds the available frame width/height at its anchor.
    # `fontfile` is currently the escaped temp path; undo the escaping so PIL
    # can open it.
    measure_font = fontfile.replace("\\:", ":").replace("\\/", "/")
    title_size, title_x, title_y = _fit_cover_text(
        title, measure_font, title_size, title_stroke_width, title_x, title_y, w, h)
    sub_size, sub_x, sub_y = _fit_cover_text(
        subtitle, measure_font, sub_size, sub_stroke_width, sub_x, sub_y, w, h)
    logger.info(f"[RENDER_COVER] anti-crop fitted -> title_size={title_size}, title_xy=({title_x:.1f},{title_y:.1f}), sub_size={sub_size}, sub_xy=({sub_x:.1f},{sub_y:.1f})")

    text_lines = [
        (title, title_x, title_y, title_size, title_color,
         title_stroke_color, title_stroke_width, title_italic),
        (subtitle, sub_x, sub_y, sub_size, sub_color,
         sub_stroke_color, sub_stroke_width, sub_italic),
    ]

    segments = []
    for txt, tpx, tpy, fs, fc_, s_color, s_width, is_italic in text_lines:
        if not txt.strip():
            continue
        # Keep the existing ffmpeg escaping rules intact (working for CJK text).
        safe = txt.replace("\\", "\\\\\\\\").replace(":", "\\\\:").replace("'", "\\\\'")
        # Synthetic slant: positive shx shears horizontally (~16deg at 0.28).
        # Non-italic rows use shx=0 so the text is left completely un-sheared.
        shx = 0.28 if is_italic else 0
        segments.append((safe, tpx, tpy, fs, fc_, s_color, s_width, shx))

    if not segments:
        # No title/subtitle to burn — keep the extracted frame as-is.
        pass
    else:
        # A zero-input `color` source is required for the transparent text
        # layer, so we must use -filter_complex (simple -vf cannot host a
        # 0-input source filter). The graph is built by the helper below.
        fc = _build_cover_filter_complex(segments, w, h, fontfile)
        tmp = output_path + ".titled.png"
        subprocess.run([
            _ffmpeg(), "-i", frame,
            "-filter_complex", fc,
            "-map", "[out]",
            "-frames:v", "1",
            "-y", tmp,
        ], capture_output=True, timeout=30)
        if os.path.exists(tmp):
            os.replace(tmp, frame)
        try:
            os.unlink(tmp)
        except OSError:
            pass

    # Convert frame to 0.5s video (video only, no audio — audio merged at concat step)
    subprocess.run([
        _ffmpeg(), "-loop", "1", "-i", frame,
        "-c:v", "libx264", "-t", str(duration),
        "-pix_fmt", "yuv420p", "-r", "30",
        "-vf", f"scale={w}:{h}",
        "-y", output_path,
    ], capture_output=True, timeout=30)

    # NOTE: Do NOT delete the frame PNG here. Callers (e.g. ai_editing.py) reuse
    # "<output_path>.cover.png" directly as the concat input (avoids MP4 issues),
    # so it must survive until the caller is done with it. The caller is
    # responsible for cleaning up both the MP4 (output_path) and the frame PNG.
    return output_path


def _split_sentences(text: str) -> list[str]:
    """Split Chinese/English text into individual sentences at punctuation."""
    import re
    # Remove curly/Chinese quotes but PRESERVE regular spaces (needed for
    # English / mixed-language subtitles, e.g. "Hello world").
    text = re.sub(r'[\u201c\u201d\u2018\u2019\u300c\u300d]+', '', text.strip())
    parts = re.split(r'(?<=[，,。！？；：.!?;:])', text)
    return [p.strip() for p in parts if p.strip()]


def _fmt_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _bgr(hex_color: str) -> str:
    """Convert #RRGGBB to BGR hex (ffmpeg ASS format)."""
    c = hex_color.lstrip("#")
    if len(c) == 6:
        return f"{c[4:6]}{c[2:4]}{c[0:2]}"
    return c


def get_audio_duration(audio_path: str) -> float:
    """
    Get duration of an audio file in seconds using ffmpeg.

    Args:
        audio_path: Path to MP3/WAV/etc. audio file.

    Returns:
        Duration in seconds as float.

    Raises:
        FileNotFoundError: If audio file doesn't exist.
        RuntimeError: If duration can't be determined.
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio not found: {audio_path}")

    cmd = [_ffmpeg(), "-i", audio_path, "-f", "null", "-"]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to probe audio duration: {audio_path}\n"
            f"stderr: {result.stderr[:300]}"
        )

    for line in result.stderr.split("\n"):
        if "Duration:" in line:
            time_str = line.split("Duration:")[1].split(",")[0].strip()
            parts = time_str.split(":")
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])

    raise RuntimeError(f"Could not determine audio duration: {audio_path}")


def _probe_audio_stream(video_path: str) -> dict | None:
    """
    Probe the first audio stream of a media file.

    Parses the stderr of ``ffmpeg -i <file>`` (no ffprobe dependency) to find
    the audio stream's sample rate and channel layout.

    Args:
        video_path: Path to the media file to probe.

    Returns:
        A dict ``{"sample_rate": int, "channel_layout": str}`` when an audio
        stream is present, otherwise ``None``. Sensible defaults (44100 Hz /
        stereo) are filled in when a field cannot be parsed.
    """
    import re

    if not os.path.exists(video_path):
        return None
    try:
        r = subprocess.run(
            [_ffmpeg(), "-i", video_path],
            capture_output=True, timeout=15,
        )
        stderr = r.stderr.decode(errors="replace")
    except Exception:
        return None

    for line in stderr.splitlines():
        if "Audio:" not in line:
            continue
        info: dict = {}
        sr_match = re.search(r"(\d+)\s*Hz", line)
        if sr_match:
            info["sample_rate"] = int(sr_match.group(1))
        # Channel layout follows "Hz," — e.g. "44100 Hz, stereo, fltp" or
        # "24000 Hz, mono, fltp" or "48000 Hz, 5.1, fltp".
        cl_match = re.search(r"Hz,\s*([\w.]+)", line)
        if cl_match:
            info["channel_layout"] = cl_match.group(1)
        info.setdefault("sample_rate", 44100)
        info.setdefault("channel_layout", "stereo")
        return info
    return None
